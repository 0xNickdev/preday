use near_sdk::json_types::U128;
use near_sdk::{near, require};

pub const BPS: u128 = 10_000;
const MAX_LADDER_STEPS: usize = 16;

#[near(serializers = [borsh, json])]
#[derive(Clone, Debug, PartialEq)]
pub struct Params {
    /// Payments required before the first advance.
    pub min_payments: u32,
    /// Time required between the first payment and an advance.
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
}

impl Params {
    pub fn assert_valid(&self) {
        require!(self.min_payments > 0, "min_payments must be positive");
        for bps in [
            self.base_share_bps,
            self.fee_bps,
            self.reserve_bps,
            self.max_utilization_bps,
        ] {
            require!(u128::from(bps) <= BPS, "bps values cannot exceed 10000");
        }
        require!(
            (1..=MAX_LADDER_STEPS).contains(&self.ladder.len()),
            "ladder must have 1 to 16 steps"
        );
        require!(self.ladder[0].0 > 0, "ladder steps must be positive");
        require!(
            self.ladder.windows(2).all(|pair| pair[0].0 < pair[1].0),
            "ladder must be strictly ascending"
        );
        require!(self.late_after_ms > 0, "late_after_ms must be positive");
        require!(
            self.write_off_after_ms >= self.late_after_ms,
            "write_off_after_ms cannot be shorter than late_after_ms"
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

    pub const USDC: u128 = 1_000_000;
    pub const DAY_MS: u64 = 24 * 60 * 60 * 1000;

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
        }
    }

    #[test]
    fn defaults_are_valid() {
        defaults().assert_valid();
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
    #[should_panic(expected = "bps values cannot exceed 10000")]
    fn rejects_bps_above_one() {
        Params {
            fee_bps: 10_001,
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

    #[test]
    #[should_panic(expected = "write_off_after_ms cannot be shorter than late_after_ms")]
    fn rejects_write_off_before_late() {
        Params {
            write_off_after_ms: DAY_MS,
            ..defaults()
        }
        .assert_valid();
    }
}
