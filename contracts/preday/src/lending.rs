use near_sdk::json_types::U128;
use near_sdk::serde_json::{self, json};
use near_sdk::{env, is_promise_success, near, require, AccountId, Promise};

use crate::activity::{Entry, Kind};
use crate::params::USDC;
use crate::pool::{Position, Recovery};
use crate::worker::Advance;
use crate::{events, Preday, PredayExt, CALLBACK_GAS};

/// Smallest advance.
const MIN_ADVANCE: u128 = USDC;

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
        require!(
            amount.0 >= MIN_ADVANCE,
            "amount is below the minimum advance"
        );
        require!(amount.0 <= limit.limit.0, "amount exceeds the limit");

        let origin = self.pool.lend(amount.0, worker.level == 0, &self.params);
        let advance = Advance::open(
            self.next_advance_id,
            amount.0,
            limit.limit.0,
            origin,
            &self.params,
            now,
        );
        self.next_advance_id += 1;
        let (id, fee) = (advance.id, U128(advance.fee));
        worker.advance = Some(advance);

        self.transfer_usdc(owner, amount.0).then(
            Self::ext(env::current_account_id())
                .with_static_gas(CALLBACK_GAS)
                .on_advance_sent(handle, id, amount, fee),
        )
    }

    #[private]
    pub fn on_advance_sent(&mut self, handle: String, id: u64, amount: U128, fee: U128) -> bool {
        let delivered = is_promise_success();
        let worker = self
            .workers
            .get_mut(&handle)
            .unwrap_or_else(|| env::abort());
        if !delivered {
            if let Some(open) = worker
                .advance
                .take_if(|open| open.id == id && open.repaid == 0)
            {
                self.pool.undo_lend(amount.0, open.origin);
                return false;
            }
            // Income already went towards this advance, so it stands and
            // the undelivered principal waits for `claim`.
            worker.pending += amount.0;
        }
        self.activity.push(
            &handle,
            &mut worker.activity_count,
            Entry {
                kind: Kind::Advance,
                amount: amount.0,
                fee: fee.0,
                at: env::block_timestamp_ms(),
            },
        );
        events::emit(
            "advance",
            json!({ "handle": handle, "id": id, "amount": amount, "fee": fee }),
        );
        delivered
    }

    /// Burns LP shares for their value in liquid pool funds.
    pub fn withdraw(&mut self, shares: U128) -> Promise {
        let account_id = env::predecessor_account_id();
        let epoch = self.pool.epoch;
        let key = (epoch, account_id.clone());
        let position = self.positions.get(&key).cloned().unwrap_or_default();
        require!(shares.0 <= position.shares, "not enough shares");
        require!(
            env::block_timestamp_ms() >= position.unlocks_at,
            "shares are still locked"
        );
        let amount = self.pool.withdraw(shares.0);
        if position.shares == shares.0 {
            self.positions.remove(&key);
        } else {
            self.positions.insert(
                key,
                Position {
                    shares: position.shares - shares.0,
                    ..position
                },
            );
        }

        self.transfer_usdc(account_id.clone(), amount).then(
            Self::ext(env::current_account_id())
                .with_static_gas(CALLBACK_GAS)
                .on_withdraw_sent(account_id, epoch, shares, U128(amount)),
        )
    }

    #[private]
    pub fn on_withdraw_sent(
        &mut self,
        account_id: AccountId,
        epoch: u32,
        shares: U128,
        amount: U128,
    ) -> bool {
        if is_promise_success() {
            events::emit(
                "withdraw",
                json!({ "account_id": account_id, "amount": amount, "shares": shares }),
            );
            return true;
        }
        if self.pool.undo_withdraw(shares.0, amount.0, epoch) {
            self.positions
                .entry((epoch, account_id))
                .or_default()
                .shares += shares.0;
        }
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

    /// Flags an advance left without a recorded repayment for its late
    /// period. Callable by anyone.
    pub fn mark_late(&mut self, handle: String) {
        let now = env::block_timestamp_ms();
        let worker = self
            .workers
            .get_mut(&handle)
            .unwrap_or_else(|| env::panic_str("unknown handle"));
        let advance = worker
            .advance
            .as_mut()
            .unwrap_or_else(|| env::panic_str("no open advance"));
        require!(!advance.late, "advance is already late");
        require!(
            advance.idle_ms(now) >= advance.late_after_ms,
            "advance is not late yet"
        );
        advance.late = true;
        worker.level = 0;
        self.activity.push(
            &handle,
            &mut worker.activity_count,
            Entry {
                kind: Kind::Late,
                amount: 0,
                fee: 0,
                at: now,
            },
        );
        events::emit("late", json!({ "handle": handle }));
    }

    /// Closes an advance left without a recorded repayment for its
    /// write-off period, books the loss and bans the worker. Callable by anyone.
    pub fn write_off(&mut self, handle: String) {
        let now = env::block_timestamp_ms();
        let worker = self
            .workers
            .get_mut(&handle)
            .unwrap_or_else(|| env::panic_str("unknown handle"));
        let advance = worker
            .advance
            .take()
            .unwrap_or_else(|| env::panic_str("no open advance"));
        require!(
            advance.idle_ms(now) >= advance.write_off_after_ms,
            "advance cannot be written off yet"
        );
        worker.banned = true;
        worker.level = 0;
        let principal = advance.principal_left();
        let loss = self.pool.write_off(principal, advance.origin);
        worker.recovery = Some(Recovery {
            owed: advance.owed(),
            to_assets: loss.from_assets,
            epoch: advance.origin.epoch,
        });
        self.activity.push(
            &handle,
            &mut worker.activity_count,
            Entry {
                kind: Kind::WrittenOff,
                amount: principal,
                fee: 0,
                at: now,
            },
        );
        events::emit(
            "write_off",
            json!({
                "handle": handle,
                "principal": U128(principal),
                "from_reserve": U128(loss.from_reserve),
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
        let recorded = amount >= self.params.min_payment.0;
        let worker = self
            .workers
            .get_mut(&handle)
            .unwrap_or_else(|| env::panic_str("unknown handle"));
        worker.total_received += amount;
        if recorded {
            worker.record_payment(amount, now);
            self.activity.push(
                &handle,
                &mut worker.activity_count,
                Entry {
                    kind: Kind::Payment,
                    amount,
                    fee: 0,
                    at: now,
                },
            );
        }
        events::emit(
            "income",
            json!({ "handle": handle, "amount": U128(amount), "recorded": recorded }),
        );

        let mut payout = amount;
        if let Some(mut advance) = worker.advance.take() {
            let (principal, fee) = advance.repay(amount);
            self.pool
                .collect(principal, fee, self.params.reserve_bps, advance.origin);
            payout -= principal + fee;
            // Only recorded payments count as activity, so dust can neither
            // postpone lateness nor flood the log.
            if recorded {
                advance.touched_at = now;
                self.activity.push(
                    &handle,
                    &mut worker.activity_count,
                    Entry {
                        kind: Kind::Repayment,
                        amount: principal,
                        fee,
                        at: now,
                    },
                );
            }
            let closed = advance.owed() == 0;
            if closed {
                if advance.earns_level(self.params.seasoning_ms, now) {
                    worker.level = (worker.level + 1).min(self.params.top_level());
                }
                self.activity.push(
                    &handle,
                    &mut worker.activity_count,
                    Entry {
                        kind: Kind::Closed,
                        amount: advance.principal,
                        fee: advance.fee,
                        at: now,
                    },
                );
            } else {
                worker.advance = Some(advance);
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
        if let Some(mut recovery) = worker.recovery.take() {
            let taken = self.pool.recover(payout, &mut recovery);
            payout -= taken;
            if recovery.owed > 0 {
                worker.recovery = Some(recovery);
            }
            self.activity.push(
                &handle,
                &mut worker.activity_count,
                Entry {
                    kind: Kind::Recovered,
                    amount: taken,
                    fee: 0,
                    at: now,
                },
            );
            events::emit(
                "recovered",
                json!({ "handle": handle, "amount": U128(taken) }),
            );
        }
        if payout > 0 {
            let owner = worker.owner.clone();
            self.pay_out(handle, owner, payout).detach();
        }
    }

    fn receive_deposit(&mut self, account_id: AccountId, amount: u128) {
        let shares = self.pool.deposit(amount);
        let position = self
            .positions
            .entry((self.pool.epoch, account_id.clone()))
            .or_default();
        position.shares += shares;
        position.unlocks_at = env::block_timestamp_ms() + self.params.withdraw_delay_ms;
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
}
