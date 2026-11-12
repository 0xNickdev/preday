use near_sdk::json_types::U128;
use near_sdk::{near, AccountId, CryptoHash};

use crate::params::{bps, Params};
use crate::pool::{Origin, Recovery};

const RECENT_PAYMENTS: usize = 3;

#[near(serializers = [borsh])]
pub struct Worker {
    pub owner: AccountId,
    /// Identity hash set by the verifier.
    pub person: Option<CryptoHash>,
    pub banned: bool,
    /// Index into the advance ladder.
    pub level: u8,
    /// Recorded payments, i.e. income of at least `min_payment`.
    pub payments_count: u32,
    pub first_payment_at: Option<u64>,
    /// Amounts of the most recent recorded payments, oldest first.
    pub recent: Vec<u128>,
    /// All income, recorded or not.
    pub total_received: u128,
    /// Payouts that could not be delivered and wait for `claim`.
    pub pending: u128,
    /// Activity entries ever written for this worker.
    pub activity_count: u32,
    pub advance: Option<Advance>,
    /// Debt left by a written-off advance.
    pub recovery: Option<Recovery>,
}

#[near(serializers = [borsh])]
#[derive(Clone, Debug, PartialEq)]
pub struct Advance {
    pub id: u64,
    pub principal: u128,
    pub fee: u128,
    /// Total repaid so far, principal first.
    pub repaid: u128,
    /// Limit the worker had when the advance was opened.
    pub limit: u128,
    pub opened_at: u64,
    /// Opened or last repaid by a recorded payment, whichever is later.
    pub touched_at: u64,
    /// Terms in force when the advance was opened. Later param changes do
    /// not apply to it.
    pub late_after_ms: u64,
    pub write_off_after_ms: u64,
    pub late: bool,
    pub origin: Origin,
}

#[near(serializers = [json])]
#[derive(Clone, Copy, Debug, PartialEq)]
#[serde(rename_all = "snake_case")]
pub enum Ineligible {
    NotVerified,
    Banned,
    AdvanceOpen,
    FewPayments,
    ShortHistory,
}

impl Ineligible {
    pub fn as_str(&self) -> &'static str {
        match self {
            Self::NotVerified => "not_verified",
            Self::Banned => "banned",
            Self::AdvanceOpen => "advance_open",
            Self::FewPayments => "few_payments",
            Self::ShortHistory => "short_history",
        }
    }
}

#[near(serializers = [json])]
#[derive(Debug, PartialEq)]
pub struct Limit {
    pub eligible: bool,
    pub limit: U128,
    pub base: U128,
    pub reason: Option<Ineligible>,
}

impl Worker {
    pub fn new(owner: AccountId) -> Self {
        Self {
            owner,
            person: None,
            banned: false,
            level: 0,
            payments_count: 0,
            first_payment_at: None,
            recent: Vec::with_capacity(RECENT_PAYMENTS),
            total_received: 0,
            pending: 0,
            activity_count: 0,
            advance: None,
            recovery: None,
        }
    }

    pub fn record_payment(&mut self, amount: u128, now: u64) {
        self.payments_count += 1;
        self.first_payment_at.get_or_insert(now);
        if self.recent.len() == RECENT_PAYMENTS {
            self.recent.remove(0);
        }
        self.recent.push(amount);
    }

    /// Median of the recent payments, the lower one when there are two.
    pub fn base(&self) -> u128 {
        let mut sorted = self.recent.clone();
        sorted.sort_unstable();
        sorted
            .get(sorted.len().saturating_sub(1) / 2)
            .copied()
            .unwrap_or(0)
    }

    pub fn limit(&self, params: &Params, now: u64) -> Limit {
        let base = self.base();
        let limit = bps(base, params.base_share_bps).min(params.step(self.level));
        let has_history = self
            .first_payment_at
            .is_some_and(|first| now.saturating_sub(first) >= params.min_history_ms);
        let reason = if self.person.is_none() {
            Some(Ineligible::NotVerified)
        } else if self.banned {
            Some(Ineligible::Banned)
        } else if self.advance.is_some() {
            Some(Ineligible::AdvanceOpen)
        } else if self.payments_count < params.min_payments {
            Some(Ineligible::FewPayments)
        } else if !has_history {
            Some(Ineligible::ShortHistory)
        } else {
            None
        };
        Limit {
            eligible: reason.is_none(),
            limit: U128(limit),
            base: U128(base),
            reason,
        }
    }
}

impl Advance {
    pub fn open(
        id: u64,
        principal: u128,
        limit: u128,
        origin: Origin,
        params: &Params,
        now: u64,
    ) -> Self {
        Self {
            id,
            principal,
            fee: params.fee(principal),
            repaid: 0,
            limit,
            opened_at: now,
            touched_at: now,
            late_after_ms: params.late_after_ms,
            write_off_after_ms: params.write_off_after_ms,
            late: false,
            origin,
        }
    }

    pub fn owed(&self) -> u128 {
        self.principal + self.fee - self.repaid
    }

    pub fn principal_left(&self) -> u128 {
        self.principal.saturating_sub(self.repaid)
    }

    pub fn idle_ms(&self, now: u64) -> u64 {
        now.saturating_sub(self.touched_at)
    }

    /// Applies up to `amount`, principal first, and returns the
    /// (principal, fee) parts actually taken.
    pub fn repay(&mut self, amount: u128) -> (u128, u128) {
        let principal = amount.min(self.principal_left());
        let fee = (amount - principal).min(self.owed() - self.principal_left());
        self.repaid += principal + fee;
        (principal, fee)
    }

    /// Whether repaying this advance at `now` moves the worker up the
    /// ladder: it must be on time, have been open for the seasoning period
    /// and have used at least half of the limit available at the time.
    pub fn earns_level(&self, seasoning_ms: u64, now: u64) -> bool {
        !self.late
            && now.saturating_sub(self.opened_at) >= seasoning_ms
            && self.principal * 2 >= self.limit
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::params::tests::{defaults, DAY_MS};
    use crate::params::USDC;

    fn worker(payments: &[u128]) -> Worker {
        let mut worker = Worker::new("anna.near".parse().unwrap());
        worker.person = Some([7; 32]);
        for amount in payments {
            worker.record_payment(*amount, 0);
        }
        worker
    }

    fn advance(principal: u128, limit: u128, now: u64) -> Advance {
        Advance::open(
            1,
            principal,
            limit,
            Origin {
                epoch: 0,
                newcomer: true,
            },
            &defaults(),
            now,
        )
    }

    const MATURE: u64 = 30 * DAY_MS;
    const WEEK: u64 = 7 * DAY_MS;

    #[test]
    fn base_is_the_median_of_the_last_three() {
        assert_eq!(worker(&[]).base(), 0);
        assert_eq!(worker(&[50]).base(), 50);
        assert_eq!(worker(&[90, 50]).base(), 50);
        assert_eq!(worker(&[300, 100, 200]).base(), 200);
        assert_eq!(worker(&[1, 1, 300, 100, 200]).base(), 200);
        assert_eq!(worker(&[500, 10, 10, 900]).base(), 10);
    }

    #[test]
    fn record_payment_keeps_aggregates() {
        let mut worker = worker(&[]);
        worker.record_payment(100, 5);
        worker.record_payment(200, 9);
        worker.record_payment(300, 12);
        worker.record_payment(400, 20);
        assert_eq!(worker.payments_count, 4);
        assert_eq!(worker.first_payment_at, Some(5));
        assert_eq!(worker.recent, vec![200, 300, 400]);
    }

    #[test]
    fn limit_is_a_share_of_base_capped_by_the_ladder() {
        let params = defaults();
        let small = worker(&[50 * USDC, 60 * USDC, 70 * USDC]).limit(&params, MATURE);
        assert_eq!(
            small,
            Limit {
                eligible: true,
                limit: U128(18 * USDC),
                base: U128(60 * USDC),
                reason: None
            }
        );

        let mut large = worker(&[2000 * USDC, 2000 * USDC, 2000 * USDC]);
        assert_eq!(large.limit(&params, MATURE).limit, U128(25 * USDC));
        large.level = 2;
        assert_eq!(large.limit(&params, MATURE).limit, U128(100 * USDC));
        large.level = 4;
        assert_eq!(large.limit(&params, MATURE).limit, U128(400 * USDC));
        large.level = 200;
        assert_eq!(large.limit(&params, MATURE).limit, U128(400 * USDC));
    }

    #[test]
    fn limit_reports_why_a_worker_is_not_eligible() {
        let params = defaults();
        let reason = |worker: &Worker, now| worker.limit(&params, now).reason;

        let mut subject = worker(&[100 * USDC, 100 * USDC]);
        subject.person = None;
        assert_eq!(reason(&subject, MATURE), Some(Ineligible::NotVerified));

        subject.person = Some([1; 32]);
        assert_eq!(reason(&subject, MATURE), Some(Ineligible::FewPayments));

        subject.record_payment(100 * USDC, DAY_MS);
        assert_eq!(reason(&subject, MATURE - 1), Some(Ineligible::ShortHistory));
        assert_eq!(reason(&subject, MATURE), None);

        subject.advance = Some(advance(USDC, USDC, MATURE));
        assert_eq!(reason(&subject, MATURE), Some(Ineligible::AdvanceOpen));

        subject.banned = true;
        assert_eq!(reason(&subject, MATURE), Some(Ineligible::Banned));
    }

    #[test]
    fn limit_and_base_are_computed_when_not_eligible() {
        let limit = worker(&[100 * USDC]).limit(&defaults(), 0);
        assert!(!limit.eligible);
        assert_eq!(limit.base, U128(100 * USDC));
        assert_eq!(limit.limit, U128(25 * USDC));
    }

    #[test]
    fn reasons_serialize_as_snake_case() {
        let json = near_sdk::serde_json::to_string(&[
            Ineligible::NotVerified,
            Ineligible::Banned,
            Ineligible::AdvanceOpen,
            Ineligible::FewPayments,
            Ineligible::ShortHistory,
        ])
        .unwrap();
        assert_eq!(
            json,
            r#"["not_verified","banned","advance_open","few_payments","short_history"]"#
        );
    }

    #[test]
    fn open_fixes_fee_and_terms() {
        let opened = advance(25 * USDC, 30 * USDC, 10);
        assert_eq!(opened.fee, 1_250_000);
        assert_eq!(opened.limit, 30 * USDC);
        assert_eq!((opened.opened_at, opened.touched_at), (10, 10));
        assert_eq!(opened.late_after_ms, 45 * DAY_MS);
        assert_eq!(opened.write_off_after_ms, 90 * DAY_MS);
        assert!(!opened.late);
    }

    #[test]
    fn repay_takes_principal_before_fee() {
        let mut advance = advance(100 * USDC, 100 * USDC, 10);
        assert_eq!(advance.fee, 5 * USDC);
        assert_eq!(advance.repay(40 * USDC), (40 * USDC, 0));
        assert_eq!(advance.owed(), 65 * USDC);
        assert_eq!(advance.principal_left(), 60 * USDC);

        assert_eq!(advance.repay(62 * USDC), (60 * USDC, 2 * USDC));
        assert_eq!(advance.owed(), 3 * USDC);
        assert_eq!(advance.principal_left(), 0);

        assert_eq!(advance.repay(50 * USDC), (0, 3 * USDC));
        assert_eq!(advance.owed(), 0);
        assert_eq!(advance.repaid, 105 * USDC);
        assert_eq!(advance.touched_at, 10);
    }

    #[test]
    fn repay_in_full_takes_only_what_is_owed() {
        let mut advance = advance(100 * USDC, 100 * USDC, 0);
        assert_eq!(advance.repay(1000 * USDC), (100 * USDC, 5 * USDC));
        assert_eq!(advance.owed(), 0);
    }

    #[test]
    fn idle_time_counts_from_last_activity() {
        let mut advance = advance(100 * USDC, 100 * USDC, 1000);
        assert_eq!(advance.idle_ms(4000), 3000);
        advance.touched_at = 3500;
        assert_eq!(advance.idle_ms(4000), 500);
        assert_eq!(advance.idle_ms(100), 0);
    }

    #[test]
    fn level_is_earned_by_seasoned_advances_of_real_size() {
        let full = advance(25 * USDC, 25 * USDC, MATURE);
        assert!(full.earns_level(WEEK, MATURE + WEEK));
        assert!(!full.earns_level(WEEK, MATURE + WEEK - 1));

        let half = advance(12_500_000, 25 * USDC, MATURE);
        assert!(half.earns_level(WEEK, MATURE + WEEK));
        let under_half = advance(12_499_999, 25 * USDC, MATURE);
        assert!(!under_half.earns_level(WEEK, MATURE + WEEK));

        let mut late = advance(25 * USDC, 25 * USDC, MATURE);
        late.late = true;
        assert!(!late.earns_level(WEEK, MATURE + 60 * DAY_MS));
    }
}
