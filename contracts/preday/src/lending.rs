use near_sdk::json_types::U128;
use near_sdk::serde_json::{self, json};
use near_sdk::{env, is_promise_success, near, require, AccountId, Promise};

use crate::worker::{Advance, Payment};
use crate::{events, Preday, PredayExt, CALLBACK_GAS};

/// `msg` accepted by `ft_on_transfer`.
#[near(serializers = [json])]
#[serde(rename_all = "snake_case")]
enum TransferMsg {
    /// `{"income":"<handle>"}` - a named account sweeping its balance.
    Income(String),
    /// `{"deposit":true}` - an LP funding the pool.
    Deposit(bool),
}

#[near]
impl Preday {
    /// NEP-141 receiver. Keeps the full amount or panics, which makes the
    /// token refund the sender.
    pub fn ft_on_transfer(&mut self, sender_id: AccountId, amount: U128, msg: String) -> U128 {
        require!(
            env::predecessor_account_id() == self.usdc,
            "only usdc is accepted"
        );
        require!(amount.0 > 0, "amount must be positive");
        match serde_json::from_str(&msg) {
            Ok(TransferMsg::Income(handle)) => self.receive_income(sender_id, handle, amount.0),
            Ok(TransferMsg::Deposit(true)) => self.receive_deposit(sender_id, amount.0),
            _ => env::panic_str("unsupported msg"),
        }
        U128(0)
    }

    /// Borrows `amount` against the caller's income history.
    pub fn request_advance(&mut self, amount: U128) -> Promise {
        let owner = env::predecessor_account_id();
        let handle = self.handle_of(&owner);
        let now = env::block_timestamp_ms();
        let worker = self
            .workers
            .get_mut(&handle)
            .unwrap_or_else(|| env::abort());
        let limit = worker.limit(&self.params, now);
        if let Some(reason) = limit.reason {
            env::panic_str(&format!("not eligible: {}", reason.as_str()));
        }
        require!(amount.0 > 0, "amount must be positive");
        require!(amount.0 <= limit.limit.0, "amount exceeds the limit");

        let fee = self.params.fee(amount.0);
        self.pool.lend(amount.0, self.params.max_utilization_bps);
        worker.advance = Some(Advance::open(amount.0, fee, now));

        self.transfer_usdc(owner, amount.0).then(
            Self::ext(env::current_account_id())
                .with_static_gas(CALLBACK_GAS)
                .on_advance_sent(handle, amount, now),
        )
    }

    #[private]
    pub fn on_advance_sent(&mut self, handle: String, amount: U128, opened_at: u64) -> bool {
        let worker = self
            .workers
            .get_mut(&handle)
            .unwrap_or_else(|| env::abort());
        if is_promise_success() {
            let fee = worker.advance.as_ref().map_or(0, |advance| advance.fee);
            events::emit(
                "advance",
                json!({ "handle": handle, "amount": amount, "fee": U128(fee) }),
            );
            return true;
        }
        match &worker.advance {
            Some(advance) if advance.opened_at == opened_at && advance.repaid == 0 => {
                worker.advance = None;
                self.pool.undo_lend(amount.0);
            }
            // Income already repaid part of it, so the advance stands and the
            // undelivered principal waits for `claim`.
            _ => worker.pending += amount.0,
        }
        false
    }

    /// Burns LP shares for their value in liquid pool funds.
    pub fn withdraw(&mut self, shares: U128) -> Promise {
        let account_id = env::predecessor_account_id();
        let held = self.shares_of(&account_id);
        require!(shares.0 <= held, "not enough shares");
        let amount = self.pool.withdraw(shares.0);
        self.set_shares(&account_id, held - shares.0);

        self.transfer_usdc(account_id.clone(), amount).then(
            Self::ext(env::current_account_id())
                .with_static_gas(CALLBACK_GAS)
                .on_withdraw_sent(account_id, shares, U128(amount)),
        )
    }

    #[private]
    pub fn on_withdraw_sent(&mut self, account_id: AccountId, shares: U128, amount: U128) -> bool {
        if is_promise_success() {
            events::emit(
                "withdraw",
                json!({ "account_id": account_id, "amount": amount, "shares": shares }),
            );
            return true;
        }
        self.pool.undo_withdraw(shares.0, amount.0);
        self.set_shares(&account_id, self.shares_of(&account_id) + shares.0);
        false
    }

    /// Pays out the caller's `pending` balance left by a failed payout.
    pub fn claim(&mut self) -> Promise {
        let owner = env::predecessor_account_id();
        let handle = self.handle_of(&owner);
        let worker = self
            .workers
            .get_mut(&handle)
            .unwrap_or_else(|| env::abort());
        let amount = std::mem::take(&mut worker.pending);
        require!(amount > 0, "nothing to claim");
        self.pay_out(handle, owner, amount)
    }

    #[private]
    pub fn on_payout(&mut self, handle: String, amount: U128) -> bool {
        if is_promise_success() {
            return true;
        }
        self.worker_mut(&handle).pending += amount.0;
        false
    }

    /// Flags an advance with no repayment for `late_after_ms`. Callable by anyone.
    pub fn mark_late(&mut self, handle: String) {
        let now = env::block_timestamp_ms();
        let late_after_ms = self.params.late_after_ms;
        let worker = self.worker_mut(&handle);
        let advance = worker
            .advance
            .as_mut()
            .unwrap_or_else(|| env::panic_str("no open advance"));
        require!(!advance.late, "advance is already late");
        require!(
            advance.idle_ms(now) >= late_after_ms,
            "advance is not late yet"
        );
        advance.late = true;
        worker.level = 0;
        events::emit("late", json!({ "handle": handle }));
    }

    /// Closes an advance with no repayment for `write_off_after_ms`, books
    /// the loss and bans the worker. Callable by anyone.
    pub fn write_off(&mut self, handle: String) {
        let now = env::block_timestamp_ms();
        let write_off_after_ms = self.params.write_off_after_ms;
        let worker = self
            .workers
            .get_mut(&handle)
            .unwrap_or_else(|| env::panic_str("unknown handle"));
        let advance = worker
            .advance
            .take()
            .unwrap_or_else(|| env::panic_str("no open advance"));
        require!(
            advance.idle_ms(now) >= write_off_after_ms,
            "advance cannot be written off yet"
        );
        worker.banned = true;
        worker.level = 0;
        let principal = advance.principal_left();
        let from_reserve = self.pool.write_off(principal);
        events::emit(
            "write_off",
            json!({
                "handle": handle,
                "principal": U128(principal),
                "from_reserve": U128(from_reserve),
            }),
        );
    }
}

impl Preday {
    fn receive_income(&mut self, sender_id: AccountId, handle: String, amount: u128) {
        require!(
            Self::named_account(&handle).is_some_and(|account| account == sender_id),
            "income must come from the handle's own account"
        );
        let now = env::block_timestamp_ms();
        let worker = self
            .workers
            .get_mut(&handle)
            .unwrap_or_else(|| env::panic_str("unknown handle"));
        self.payments.insert(
            (handle.clone(), worker.payments_count),
            Payment { amount, at: now },
        );
        worker.record_payment(amount, now);
        events::emit(
            "income",
            json!({ "handle": handle, "amount": U128(amount) }),
        );

        let mut payout = amount;
        if let Some(advance) = worker.advance.as_mut() {
            let (principal, fee) = advance.repay(amount, now);
            let closed = advance.owed() == 0;
            let on_time = !advance.late;
            self.pool.collect(principal, fee, self.params.reserve_bps);
            payout -= principal + fee;
            if closed {
                worker.advance = None;
                if on_time {
                    worker.level = (worker.level + 1).min(self.params.top_level());
                }
            }
            events::emit(
                "repay",
                json!({
                    "handle": handle,
                    "principal": U128(principal),
                    "fee": U128(fee),
                    "closed": closed,
                }),
            );
        }
        if payout > 0 {
            let owner = worker.owner.clone();
            self.pay_out(handle, owner, payout).detach();
        }
    }

    fn receive_deposit(&mut self, account_id: AccountId, amount: u128) {
        let shares = self.pool.deposit(amount);
        self.set_shares(&account_id, self.shares_of(&account_id) + shares);
        events::emit(
            "deposit",
            json!({ "account_id": account_id, "amount": U128(amount), "shares": U128(shares) }),
        );
    }

    /// Sends USDC to a worker, crediting `pending` if the transfer fails.
    fn pay_out(&self, handle: String, owner: AccountId, amount: u128) -> Promise {
        self.transfer_usdc(owner, amount).then(
            Self::ext(env::current_account_id())
                .with_static_gas(CALLBACK_GAS)
                .on_payout(handle, U128(amount)),
        )
    }

    fn handle_of(&self, owner: &AccountId) -> String {
        self.handles
            .get(owner)
            .cloned()
            .unwrap_or_else(|| env::panic_str("account has no handle"))
    }

    pub(crate) fn shares_of(&self, account_id: &AccountId) -> u128 {
        self.shares.get(account_id).copied().unwrap_or(0)
    }

    fn set_shares(&mut self, account_id: &AccountId, shares: u128) {
        if shares == 0 {
            self.shares.remove(account_id);
        } else {
            self.shares.insert(account_id.clone(), shares);
        }
    }
}
