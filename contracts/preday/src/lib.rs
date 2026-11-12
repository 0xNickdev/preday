//! Preday - paycheck advances for people paid in crypto.
//!
//! A worker claims a handle and gets a keyless named account
//! `<handle>.<this contract>`. USDC paid to that account is swept here as
//! income, repays any open advance and is forwarded to the worker's wallet.
//! Enough income history unlocks small advances from an LP pool.

mod events;
mod lending;
mod params;
mod pool;
mod registry;
mod views;
mod worker;

#[cfg(test)]
mod tests;

use near_sdk::json_types::{Base58CryptoHash, U128};
use near_sdk::store::LookupMap;
use near_sdk::{
    env, ext_contract, near, require, AccountId, BorshStorageKey, CryptoHash, Gas, NearToken,
    PanicOnDefault, Promise,
};

pub use params::Params;
use pool::Pool;
use worker::{Payment, Worker};

const FT_TRANSFER_GAS: Gas = Gas::from_tgas(10);
const CALLBACK_GAS: Gas = Gas::from_tgas(8);
const ONE_YOCTO: NearToken = NearToken::from_yoctonear(1);

#[ext_contract(ext_usdc)]
pub trait Usdc {
    fn ft_transfer(&mut self, receiver_id: AccountId, amount: U128, memo: Option<String>);
    fn storage_deposit(&mut self, account_id: Option<AccountId>, registration_only: Option<bool>);
}

#[near]
#[derive(BorshStorageKey)]
enum StorageKey {
    Workers,
    Handles,
    Payments,
    Shares,
    Persons,
}

#[near(serializers = [borsh, json])]
#[derive(Clone, Debug, PartialEq)]
pub struct PendingParams {
    pub params: Params,
    pub apply_at: u64,
}

#[near(contract_state)]
#[derive(PanicOnDefault)]
pub struct Preday {
    owner: AccountId,
    usdc: AccountId,
    verifier: AccountId,
    /// Code hash of the global contract every named account runs.
    account_code: CryptoHash,
    params: Params,
    pending_params: Option<PendingParams>,
    params_delay_ms: u64,
    pool: Pool,
    workers: LookupMap<String, Worker>,
    /// Owner wallet -> handle.
    handles: LookupMap<AccountId, String>,
    /// (handle, index) -> payment.
    payments: LookupMap<(String, u32), Payment>,
    shares: LookupMap<AccountId, u128>,
    /// Person code -> handle. A code is bound to its first handle for good.
    persons: LookupMap<CryptoHash, String>,
}

#[near]
impl Preday {
    /// The caller becomes the owner, whose only power is proposing params.
    #[init]
    pub fn new(
        usdc: AccountId,
        verifier: AccountId,
        account_code: Base58CryptoHash,
        params: Params,
        params_delay_ms: u64,
    ) -> Self {
        params.assert_valid();
        Self {
            owner: env::predecessor_account_id(),
            usdc,
            verifier,
            account_code: account_code.into(),
            params,
            pending_params: None,
            params_delay_ms,
            pool: Pool::default(),
            workers: LookupMap::new(StorageKey::Workers),
            handles: LookupMap::new(StorageKey::Handles),
            payments: LookupMap::new(StorageKey::Payments),
            shares: LookupMap::new(StorageKey::Shares),
            persons: LookupMap::new(StorageKey::Persons),
        }
    }

    /// Schedules new params, replacing any earlier proposal.
    pub fn propose_params(&mut self, params: Params) {
        require!(
            env::predecessor_account_id() == self.owner,
            "only the owner can propose params"
        );
        params.assert_valid();
        let apply_at = env::block_timestamp_ms() + self.params_delay_ms;
        self.pending_params = Some(PendingParams { params, apply_at });
    }

    /// Activates the proposed params once the delay has passed. Callable by anyone.
    pub fn apply_params(&mut self) {
        let pending = self
            .pending_params
            .take()
            .unwrap_or_else(|| env::panic_str("no pending params"));
        require!(
            env::block_timestamp_ms() >= pending.apply_at,
            "params are still timelocked"
        );
        self.params = pending.params;
    }
}

impl Preday {
    fn named_account(handle: &str) -> Option<AccountId> {
        format!("{handle}.{}", env::current_account_id())
            .parse()
            .ok()
    }

    fn worker_mut(&mut self, handle: &str) -> &mut Worker {
        self.workers
            .get_mut(handle)
            .unwrap_or_else(|| env::panic_str("unknown handle"))
    }

    fn transfer_usdc(&self, receiver_id: AccountId, amount: u128) -> Promise {
        ext_usdc::ext(self.usdc.clone())
            .with_attached_deposit(ONE_YOCTO)
            .with_static_gas(FT_TRANSFER_GAS)
            .ft_transfer(receiver_id, U128(amount), None)
    }
}
