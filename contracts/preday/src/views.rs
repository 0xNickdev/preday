use near_sdk::json_types::U128;
use near_sdk::{env, near, AccountId};

use crate::activity::{Entry, Kind};
use crate::registry::REGISTER_DEPOSIT;
use crate::worker::{Advance, Limit, Worker};
use crate::{Params, PendingParams, Preday, PredayExt};

#[near(serializers = [json])]
pub struct WorkerView {
    pub handle: String,
    pub owner: AccountId,
    pub verified: bool,
    pub banned: bool,
    pub level: u8,
    pub payments_count: u32,
    pub first_payment_at: Option<u64>,
    pub total_received: U128,
    pub pending: U128,
    pub activity_count: u32,
    /// Written-off debt still collected from income.
    pub recovery: U128,
    pub advance: Option<AdvanceView>,
}

#[near(serializers = [json])]
pub struct AdvanceView {
    pub id: u64,
    pub principal: U128,
    pub fee: U128,
    pub repaid: U128,
    pub opened_at: u64,
    pub touched_at: u64,
    pub late: bool,
}

#[near(serializers = [json])]
pub struct ActivityView {
    pub kind: Kind,
    pub amount: U128,
    pub fee: U128,
    pub at: u64,
}

#[near(serializers = [json])]
pub struct LpView {
    pub shares: U128,
    /// When the shares become withdrawable.
    pub unlocks_at: u64,
}

#[near(serializers = [json])]
pub struct PoolView {
    pub assets: U128,
    pub lent: U128,
    pub lent_to_newcomers: U128,
    pub reserve: U128,
    pub total_shares: U128,
    pub advanced: U128,
    pub repaid: U128,
    pub fees: U128,
    pub written_off: U128,
    pub recovered: U128,
    pub advances_count: u32,
}

#[near(serializers = [json])]
pub struct ConfigView {
    pub usdc: AccountId,
    pub verifier: AccountId,
    pub owner: AccountId,
    /// yoctoNEAR to attach to `register`.
    pub register_deposit: U128,
    pub params_delay_ms: u64,
}

impl From<&Advance> for AdvanceView {
    fn from(advance: &Advance) -> Self {
        Self {
            id: advance.id,
            principal: U128(advance.principal),
            fee: U128(advance.fee),
            repaid: U128(advance.repaid),
            opened_at: advance.opened_at,
            touched_at: advance.touched_at,
            late: advance.late,
        }
    }
}

impl From<&Entry> for ActivityView {
    fn from(entry: &Entry) -> Self {
        Self {
            kind: entry.kind,
            amount: U128(entry.amount),
            fee: U128(entry.fee),
            at: entry.at,
        }
    }
}

impl WorkerView {
    fn new(handle: String, worker: &Worker) -> Self {
        Self {
            handle,
            owner: worker.owner.clone(),
            verified: worker.person.is_some(),
            banned: worker.banned,
            level: worker.level,
            payments_count: worker.payments_count,
            first_payment_at: worker.first_payment_at,
            total_received: U128(worker.total_received),
            pending: U128(worker.pending),
            activity_count: worker.activity_count,
            recovery: U128(worker.recovery.as_ref().map_or(0, |recovery| recovery.owed)),
            advance: worker.advance.as_ref().map(Into::into),
        }
    }
}

#[near]
impl Preday {
    pub fn get_worker(&self, handle: String) -> Option<WorkerView> {
        let worker = self.workers.get(&handle)?;
        Some(WorkerView::new(handle, worker))
    }

    pub fn get_handle(&self, account_id: AccountId) -> Option<String> {
        self.handles.get(&account_id).cloned()
    }

    pub fn get_limit(&self, handle: String) -> Limit {
        self.workers
            .get(&handle)
            .unwrap_or_else(|| env::panic_str("unknown handle"))
            .limit(&self.params, env::block_timestamp_ms())
    }

    /// Up to 20 activity entries starting at sequence `from`, oldest first.
    /// Only the latest 20 entries are kept; older ones are skipped.
    pub fn get_activity(&self, handle: String, from: u32, limit: u32) -> Vec<ActivityView> {
        let count = self
            .workers
            .get(&handle)
            .map_or(0, |worker| worker.activity_count);
        self.activity
            .page(&handle, count, from, limit)
            .into_iter()
            .map(Into::into)
            .collect()
    }

    pub fn get_pool(&self) -> PoolView {
        let pool = &self.pool;
        PoolView {
            assets: U128(pool.assets),
            lent: U128(pool.lent),
            lent_to_newcomers: U128(pool.lent_to_newcomers),
            reserve: U128(pool.reserve),
            total_shares: U128(pool.total_shares),
            advanced: U128(pool.advanced),
            repaid: U128(pool.repaid),
            fees: U128(pool.fees),
            written_off: U128(pool.written_off),
            recovered: U128(pool.recovered),
            advances_count: pool.advances_count,
        }
    }

    /// Shares of the current share epoch.
    pub fn get_shares(&self, account_id: AccountId) -> U128 {
        self.get_lp(account_id).shares
    }

    pub fn get_lp(&self, account_id: AccountId) -> LpView {
        let position = self
            .positions
            .get(&(self.pool.epoch, account_id))
            .cloned()
            .unwrap_or_default();
        LpView {
            shares: U128(position.shares),
            unlocks_at: position.unlocks_at,
        }
    }

    pub fn get_params(&self) -> Params {
        self.params.clone()
    }

    pub fn get_pending_params(&self) -> Option<PendingParams> {
        self.pending_params.clone()
    }

    pub fn get_config(&self) -> ConfigView {
        ConfigView {
            usdc: self.usdc.clone(),
            verifier: self.verifier.clone(),
            owner: self.owner.clone(),
            register_deposit: U128(REGISTER_DEPOSIT.as_yoctonear()),
            params_delay_ms: self.params_delay_ms,
        }
    }
}
