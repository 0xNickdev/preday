use near_sdk::json_types::U128;
use near_sdk::{near, require};

pub const USDC: u128 = 1_000_000;
pub const BPS: u128 = 10_000;
const DAY_MS: u64 = 24 * 60 * 60 * 1000;

/// Shortest timelock a deployment can be created with.
pub const MIN_PARAMS_DELAY_MS: u64 = 60_000;

// Ceilings no proposal can exceed. They bound what the owner can do to
// borrowers and LPs through params.
const MAX_LADDER_STEPS: usize = 16;
const MAX_LADDER_STEP: u128 = 1_000 * USDC;
const MAX_BASE_SHARE_BPS: u32 = 5000;
const MAX_FEE_BPS: u32 = 1000;
const MAX_MIN_FEE: u128 = 5 * USDC;
const MAX_RESERVE_BPS: u32 = 5000;
const MAX_UTILIZATION_BPS: u32 = 9000;
const MAX_MIN_PAYMENT: u128 = 100 * USDC;
const MAX_WITHDRAW_DELAY_MS: u64 = 30 * DAY_MS;

#[near(serializers = [borsh, json])]
#[derive(Clone, Debug, PartialEq)]
pub struct Params {
    /// Recorded payments required before the first advance.
    pub min_payments: u32,
    /// Time required between the first recorded payment and an advance.
    pub min_history_ms: u64,
    /// Share of the base income an advance may reach.
    pub base_share_bps: u32,
    /// Advance cap per level, ascending.
    pub ladder: Vec<U128>,
    pub fee_bps: u32,
    pub min_fee: U128,
    /// Inactivity after which an open advance can be marked late.
    pub late_after_ms: u64,
    /// Inactivity after which an open advance can be written off.
    pub write_off_after_ms: u64,
    /// Share of each collected fee that goes to the reserve.
    pub reserve_bps: u32,
    /// Highest lent / assets ratio a new advance may produce.
    pub max_utilization_bps: u32,
    /// Smallest income that counts as a payment. Anything below is still
    /// applied and forwarded, but leaves no trace in the history.
    pub min_payment: U128,
    /// How long an advance must stay open for its repayment to earn a level.
    pub seasoning_ms: u64,
    /// How long LP shares stay locked after the holder's latest deposit.
    pub withdraw_delay_ms: u64,
}

impl Params {
    pub fn assert_valid(&self) {
        require!(self.min_payments > 0, "min_payments must be positive");
        require!(
            self.base_share_bps <= MAX_BASE_SHARE_BPS,
            "base_share_bps cannot exceed 5000"
        );
        require!(
            (1..=MAX_LADDER_STEPS).contains(&self.ladder.len()),
            "ladder must have 1 to 16 steps"
        );
        require!(self.ladder[0].0 > 0, "ladder steps must be positive");
        require!(
            self.ladder.windows(2).all(|pair| pair[0].0 < pair[1].0),
            "ladder must be strictly ascending"
        );
        require!(
            self.ladder[self.ladder.len() - 1].0 <= MAX_LADDER_STEP,
            "ladder steps cannot exceed 1000 USDC"
        );
        require!(self.fee_bps <= MAX_FEE_BPS, "fee_bps cannot exceed 1000");
        require!(
            self.min_fee.0 <= MAX_MIN_FEE,
            "min_fee cannot exceed 5 USDC"
        );
        require!(self.late_after_ms > 0, "late_after_ms must be positive");
        require!(
            self.write_off_after_ms > self.late_after_ms,
            "write_off_after_ms must be longer than late_after_ms"
        );
        require!(
            self.reserve_bps <= MAX_RESERVE_BPS,
            "reserve_bps cannot exceed 5000"
        );
        require!(
            self.max_utilization_bps <= MAX_UTILIZATION_BPS,
            "max_utilization_bps cannot exceed 9000"
        );
        require!(
            self.min_payment.0 <= MAX_MIN_PAYMENT,
            "min_payment cannot exceed 100 USDC"
        );
        require!(
            self.withdraw_delay_ms <= MAX_WITHDRAW_DELAY_MS,
            "withdraw_delay_ms cannot exceed 30 days"
        );
    }

    pub fn top_level(&self) -> u8 {
        (self.ladder.len() - 1) as u8
    }

    /// Ladder cap for a level. Levels above the top step use the top step.
    pub fn step(&self, level: u8) -> u128 {
        self.ladder[usize::from(level.min(self.top_level()))].0
    }

    pub fn fee(&self, amount: u128) -> u128 {
        bps(amount, self.fee_bps).max(self.min_fee.0)
    }
}

pub fn bps(amount: u128, bps: u32) -> u128 {
    amount * u128::from(bps) / BPS
}

#[cfg(test)]
pub mod tests {
    use super::*;

    pub const DAY_MS: u64 = super::DAY_MS;

    pub fn defaults() -> Params {
        Params {
            min_payments: 3,
            min_history_ms: 30 * DAY_MS,
            base_share_bps: 3000,
            ladder: [25, 50, 100, 200, 400]
                .map(|step| U128(step * USDC))
                .to_vec(),
            fee_bps: 500,
            min_fee: U128(USDC),
            late_after_ms: 45 * DAY_MS,
            write_off_after_ms: 90 * DAY_MS,
            reserve_bps: 2000,
            max_utilization_bps: 8000,
            min_payment: U128(10 * USDC),
            seasoning_ms: 7 * DAY_MS,
            withdraw_delay_ms: 7 * DAY_MS,
        }
    }

    #[test]
    fn defaults_are_valid() {
        defaults().assert_valid();
    }

    #[test]
    fn ceilings_themselves_are_valid() {
        Params {
            base_share_bps: 5000,
            ladder: vec![U128(1000 * USDC)],
            fee_bps: 1000,
            min_fee: U128(5 * USDC),
            late_after_ms: 1,
            write_off_after_ms: 2,
            reserve_bps: 5000,
            max_utilization_bps: 9000,
            min_payment: U128(100 * USDC),
            withdraw_delay_ms: 30 * DAY_MS,
            ..defaults()
        }
        .assert_valid();
    }

    #[test]
    fn fee_is_proportional_with_a_floor() {
        let params = defaults();
        assert_eq!(params.fee(10 * USDC), USDC);
        assert_eq!(params.fee(20 * USDC), USDC);
        assert_eq!(params.fee(25 * USDC), 1_250_000);
        assert_eq!(params.fee(400 * USDC), 20 * USDC);
    }

    #[test]
    fn step_is_capped_at_the_top_of_the_ladder() {
        let params = defaults();
        assert_eq!(params.top_level(), 4);
        assert_eq!(params.step(0), 25 * USDC);
        assert_eq!(params.step(4), 400 * USDC);
        assert_eq!(params.step(9), 400 * USDC);
    }

    #[test]
    #[should_panic(expected = "base_share_bps cannot exceed 5000")]
    fn rejects_base_share_above_the_ceiling() {
        Params {
            base_share_bps: 5001,
            ..defaults()
        }
        .assert_valid();
    }

    #[test]
    #[should_panic(expected = "ladder steps cannot exceed 1000 USDC")]
    fn rejects_ladder_above_the_ceiling() {
        Params {
            ladder: vec![U128(25 * USDC), U128(1000 * USDC + 1)],
            ..defaults()
        }
        .assert_valid();
    }

    #[test]
    #[should_panic(expected = "fee_bps cannot exceed 1000")]
    fn rejects_fee_above_the_ceiling() {
        Params {
            fee_bps: 1001,
            ..defaults()
        }
        .assert_valid();
    }

    #[test]
    #[should_panic(expected = "min_fee cannot exceed 5 USDC")]
    fn rejects_min_fee_above_the_ceiling() {
        Params {
            min_fee: U128(5 * USDC + 1),
            ..defaults()
        }
        .assert_valid();
    }

    #[test]
    #[should_panic(expected = "reserve_bps cannot exceed 5000")]
    fn rejects_reserve_share_above_the_ceiling() {
        Params {
            reserve_bps: 5001,
            ..defaults()
        }
        .assert_valid();
    }

    #[test]
    #[should_panic(expected = "max_utilization_bps cannot exceed 9000")]
    fn rejects_utilization_above_the_ceiling() {
        Params {
            max_utilization_bps: 9001,
            ..defaults()
        }
        .assert_valid();
    }

    #[test]
    #[should_panic(expected = "min_payment cannot exceed 100 USDC")]
    fn rejects_min_payment_above_the_ceiling() {
        Params {
            min_payment: U128(100 * USDC + 1),
            ..defaults()
        }
        .assert_valid();
    }

    #[test]
    #[should_panic(expected = "withdraw_delay_ms cannot exceed 30 days")]
    fn rejects_withdraw_delay_above_the_ceiling() {
        Params {
            withdraw_delay_ms: 30 * DAY_MS + 1,
            ..defaults()
        }
        .assert_valid();
    }

    #[test]
    #[should_panic(expected = "late_after_ms must be positive")]
    fn rejects_zero_late_period() {
        Params {
            late_after_ms: 0,
            ..defaults()
        }
        .assert_valid();
    }

    #[test]
    #[should_panic(expected = "write_off_after_ms must be longer than late_after_ms")]
    fn rejects_write_off_not_after_late() {
        Params {
            late_after_ms: DAY_MS,
            write_off_after_ms: DAY_MS,
            ..defaults()
        }
        .assert_valid();
    }

    #[test]
    #[should_panic(expected = "ladder must have 1 to 16 steps")]
    fn rejects_empty_ladder() {
        Params {
            ladder: vec![],
            ..defaults()
        }
        .assert_valid();
    }

    #[test]
    #[should_panic(expected = "ladder must be strictly ascending")]
    fn rejects_unsorted_ladder() {
        Params {
            ladder: vec![U128(50), U128(50)],
            ..defaults()
        }
        .assert_valid();
    }

    #[test]
    #[should_panic(expected = "ladder steps must be positive")]
    fn rejects_zero_step() {
        Params {
            ladder: vec![U128(0), U128(50)],
            ..defaults()
        }
        .assert_valid();
    }

    #[test]
    #[should_panic(expected = "min_payments must be positive")]
    fn rejects_zero_min_payments() {
        Params {
            min_payments: 0,
            ..defaults()
        }
        .assert_valid();
    }
}
