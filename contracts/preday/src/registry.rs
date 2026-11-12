use near_sdk::json_types::Base58CryptoHash;
use near_sdk::serde_json::json;
use near_sdk::{env, is_promise_success, near, require, AccountId, Gas, NearToken, Promise};

use crate::worker::Worker;
use crate::{events, ext_usdc, Preday, PredayExt, CALLBACK_GAS};

/// Exact deposit `register` requires. Covers USDC storage for the named
/// account and the owner, the named account's own balance, and this
/// contract's storage for the worker: its record, indexes and a full
/// activity log come to at most 3027 bytes (0.03027 NEAR).
pub const REGISTER_DEPOSIT: NearToken = NearToken::from_millinear(35);
/// Balance the named account starts with. It only spends 1 yocto per sweep.
const ACCOUNT_FUNDING: NearToken = NearToken::from_millinear(1);
const USDC_STORAGE_DEPOSIT: NearToken = NearToken::from_micronear(1250);

const DAY_MS: u64 = 24 * 60 * 60 * 1000;

const ACCOUNT_INIT_GAS: Gas = Gas::from_tgas(5);
const STORAGE_DEPOSIT_GAS: Gas = Gas::from_tgas(8);
const ON_REGISTERED_GAS: Gas =
    Gas::from_tgas(2 * STORAGE_DEPOSIT_GAS.as_tgas() + CALLBACK_GAS.as_tgas());

#[near]
impl Preday {
    /// Claims `handle` for the caller and creates the keyless named account
    /// `<handle>.<this contract>` on the shared global code.
    #[payable]
    pub fn register(&mut self, handle: String) -> Promise {
        require!(
            env::attached_deposit() == REGISTER_DEPOSIT,
            "attach exactly the register deposit"
        );
        require!(is_valid_handle(&handle), "invalid handle");
        let account = Self::named_account(&handle)
            .unwrap_or_else(|| env::panic_str("handle is too long for this contract"));
        let owner = env::predecessor_account_id();
        require!(
            !self.handles.contains_key(&owner),
            "account already has a handle"
        );
        require!(!self.workers.contains_key(&handle), "handle is taken");

        self.handles.insert(owner.clone(), handle.clone());
        self.workers
            .insert(handle.clone(), Worker::new(owner.clone()));

        Promise::new(account)
            .create_account()
            .transfer(ACCOUNT_FUNDING)
            .use_global_contract(self.account_code)
            .function_call(
                "new",
                self.usdc.as_bytes().to_vec(),
                NearToken::ZERO,
                ACCOUNT_INIT_GAS,
            )
            .then(
                Self::ext(env::current_account_id())
                    .with_static_gas(ON_REGISTERED_GAS)
                    .on_registered(handle, owner),
            )
    }

    #[private]
    pub fn on_registered(&mut self, handle: String, owner: AccountId) -> bool {
        if !is_promise_success() {
            if let Some(person) = self
                .workers
                .remove(&handle)
                .and_then(|worker| worker.person)
            {
                self.persons.remove(&person);
            }
            self.handles.remove(&owner);
            Promise::new(owner).transfer(REGISTER_DEPOSIT).detach();
            return false;
        }
        let account = Self::named_account(&handle).unwrap_or_else(|| env::abort());
        for account_id in [&account, &owner] {
            ext_usdc::ext(self.usdc.clone())
                .with_attached_deposit(USDC_STORAGE_DEPOSIT)
                .with_static_gas(STORAGE_DEPOSIT_GAS)
                .storage_deposit(Some(account_id.clone()), Some(true))
                .detach();
        }
        events::emit(
            "register",
            json!({ "handle": handle, "owner": owner, "account": account }),
        );
        true
    }

    /// Binds a person to a handle. A person code can back a single handle,
    /// so a code whose handle was banned can never be verified again.
    pub fn set_verified(&mut self, handle: String, person_code: Base58CryptoHash) {
        require!(
            env::predecessor_account_id() == self.verifier,
            "only the verifier can verify"
        );
        let person = person_code.into();
        if let Some(bound) = self.persons.get(&person) {
            let banned = self.workers.get(bound).is_some_and(|worker| worker.banned);
            env::panic_str(if banned {
                "person is banned"
            } else {
                "person already has a handle"
            });
        }
        let day = env::block_timestamp_ms() / DAY_MS;
        let verified_today = if self.verifications.0 == day {
            self.verifications.1
        } else {
            0
        };
        require!(
            verified_today < self.params.max_verifications_per_day,
            "daily verification limit reached"
        );
        let worker = self.worker_mut(&handle);
        require!(worker.person.is_none(), "handle is already verified");

        worker.person = Some(person);
        self.verifications = (day, verified_today + 1);
        self.persons.insert(person, handle.clone());
        events::emit("verified", json!({ "handle": handle }));
    }
}

/// 2-32 characters of `[a-z0-9-]` that neither start nor end with a hyphen.
pub fn is_valid_handle(handle: &str) -> bool {
    (2..=32).contains(&handle.len())
        && handle
            .bytes()
            .all(|byte| matches!(byte, b'a'..=b'z' | b'0'..=b'9' | b'-'))
        && !handle.starts_with('-')
        && !handle.ends_with('-')
}

#[cfg(test)]
mod tests {
    use super::is_valid_handle;

    #[test]
    fn accepts_well_formed_handles() {
        for handle in [
            "an",
            "anna",
            "anna-b",
            "a1",
            "007",
            "a-b-c",
            &"a".repeat(32),
        ] {
            assert!(is_valid_handle(handle), "{handle}");
        }
    }

    #[test]
    fn rejects_malformed_handles() {
        for handle in [
            "",
            "a",
            "-anna",
            "anna-",
            "Anna",
            "an na",
            "anna.b",
            "anna_b",
            "ann\u{e4}",
            &"a".repeat(33),
        ] {
            assert!(!is_valid_handle(handle), "{handle}");
        }
    }
}
