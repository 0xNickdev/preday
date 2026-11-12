use near_sdk::{near, require};

use crate::params::{bps, BPS};

/// LP pool accounting. Tracked internally, never derived from the token
/// balance: `assets` is the LP claim (liquid funds plus funds lent out),
/// `reserve` sits outside of it and absorbs losses first.
#[near(serializers = [borsh])]
#[derive(Default, Debug, PartialEq)]
pub struct Pool {
    pub assets: u128,
    pub lent: u128,
    pub reserve: u128,
    pub total_shares: u128,
    pub advanced: u128,
    pub repaid: u128,
    pub fees: u128,
    pub written_off: u128,
    pub advances_count: u32,
}

impl Pool {
    pub fn liquid(&self) -> u128 {
        self.assets - self.lent
    }

    /// Adds LP funds and returns the shares minted for them.
    pub fn deposit(&mut self, amount: u128) -> u128 {
        let shares = if self.total_shares == 0 {
            amount
        } else {
            require!(self.assets > 0, "pool shares have no backing");
            amount * self.total_shares / self.assets
        };
        require!(shares > 0, "deposit is too small");
        self.assets += amount;
        self.total_shares += shares;
        shares
    }

    /// Burns shares and returns the liquid funds released for them.
    pub fn withdraw(&mut self, shares: u128) -> u128 {
        require!(
            shares > 0 && shares <= self.total_shares,
            "invalid share amount"
        );
        let amount = shares * self.assets / self.total_shares;
        require!(amount > 0, "withdrawal is too small");
        require!(amount <= self.liquid(), "not enough liquid funds");
        self.assets -= amount;
        self.total_shares -= shares;
        amount
    }

    /// Reverts a withdrawal whose payout did not go through.
    pub fn undo_withdraw(&mut self, shares: u128, amount: u128) {
        self.assets += amount;
        self.total_shares += shares;
    }

    pub fn lend(&mut self, amount: u128, max_utilization_bps: u32) {
        require!(amount <= self.liquid(), "not enough liquidity");
        require!(
            (self.lent + amount) * BPS <= self.assets * u128::from(max_utilization_bps),
            "utilization cap reached"
        );
        self.lent += amount;
        self.advanced += amount;
        self.advances_count += 1;
    }

    /// Reverts an advance whose payout did not go through.
    pub fn undo_lend(&mut self, amount: u128) {
        self.lent -= amount;
        self.advanced -= amount;
        self.advances_count -= 1;
    }

    /// Books a repayment. The fee is split between the reserve and the LPs.
    pub fn collect(&mut self, principal: u128, fee: u128, reserve_bps: u32) {
        let to_reserve = bps(fee, reserve_bps);
        self.lent -= principal;
        self.repaid += principal;
        self.reserve += to_reserve;
        self.assets += fee - to_reserve;
        self.fees += fee;
    }

    /// Absorbs lost principal, reserve first. Returns the part the reserve covered.
    pub fn write_off(&mut self, principal: u128) -> u128 {
        let from_reserve = principal.min(self.reserve);
        self.reserve -= from_reserve;
        self.assets -= principal - from_reserve;
        self.lent -= principal;
        self.written_off += principal;
        from_reserve
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::params::tests::USDC;

    fn funded(amount: u128) -> Pool {
        let mut pool = Pool::default();
        pool.deposit(amount);
        pool
    }

    #[test]
    fn first_deposit_mints_one_to_one() {
        let mut pool = Pool::default();
        assert_eq!(pool.deposit(1000 * USDC), 1000 * USDC);
        assert_eq!(pool.assets, 1000 * USDC);
        assert_eq!(pool.total_shares, 1000 * USDC);
    }

    #[test]
    fn later_deposits_mint_at_share_price() {
        let mut pool = funded(1000 * USDC);
        pool.lend(100 * USDC, 8000);
        pool.collect(100 * USDC, 100 * USDC, 0);
        assert_eq!(pool.assets, 1100 * USDC);
        assert_eq!(pool.deposit(110 * USDC), 100 * USDC);
        assert_eq!(pool.total_shares, 1100 * USDC);
    }

    #[test]
    fn withdraw_pays_share_price_including_fees() {
        let mut pool = funded(1000 * USDC);
        pool.lend(100 * USDC, 8000);
        pool.collect(100 * USDC, 5 * USDC, 2000);
        assert_eq!(pool.reserve, USDC);
        assert_eq!(pool.assets, 1004 * USDC);
        assert_eq!(pool.withdraw(500 * USDC), 502 * USDC);
        assert_eq!(pool.withdraw(500 * USDC), 502 * USDC);
        assert_eq!(pool.assets, 0);
        assert_eq!(pool.total_shares, 0);
        assert_eq!(pool.reserve, USDC);
    }

    #[test]
    #[should_panic(expected = "not enough liquid funds")]
    fn withdraw_is_limited_to_liquid_funds() {
        let mut pool = funded(1000 * USDC);
        pool.lend(800 * USDC, 8000);
        pool.withdraw(201 * USDC);
    }

    #[test]
    fn undo_withdraw_restores_the_pool() {
        let mut pool = funded(1000 * USDC);
        let before = (pool.assets, pool.total_shares);
        let amount = pool.withdraw(400 * USDC);
        pool.undo_withdraw(400 * USDC, amount);
        assert_eq!((pool.assets, pool.total_shares), before);
    }

    #[test]
    #[should_panic(expected = "invalid share amount")]
    fn withdraw_rejects_zero_shares() {
        funded(USDC).withdraw(0);
    }

    #[test]
    #[should_panic(expected = "deposit is too small")]
    fn deposit_rejects_dust_that_mints_nothing() {
        let mut pool = funded(10);
        pool.lend(8, 8000);
        pool.collect(8, 100, 0);
        pool.deposit(1);
    }

    #[test]
    fn lend_tracks_counters() {
        let mut pool = funded(1000 * USDC);
        pool.lend(100 * USDC, 8000);
        pool.lend(50 * USDC, 8000);
        assert_eq!(pool.lent, 150 * USDC);
        assert_eq!(pool.advanced, 150 * USDC);
        assert_eq!(pool.advances_count, 2);
        assert_eq!(pool.liquid(), 850 * USDC);
        pool.undo_lend(50 * USDC);
        assert_eq!(pool.lent, 100 * USDC);
        assert_eq!(pool.advanced, 100 * USDC);
        assert_eq!(pool.advances_count, 1);
    }

    #[test]
    fn lend_allows_exactly_the_utilization_cap() {
        let mut pool = funded(1000 * USDC);
        pool.lend(800 * USDC, 8000);
        assert_eq!(pool.lent, 800 * USDC);
    }

    #[test]
    #[should_panic(expected = "utilization cap reached")]
    fn lend_rejects_above_the_utilization_cap() {
        let mut pool = funded(1000 * USDC);
        pool.lend(800 * USDC + 1, 8000);
    }

    #[test]
    #[should_panic(expected = "not enough liquidity")]
    fn lend_rejects_more_than_liquid() {
        let mut pool = funded(100 * USDC);
        pool.lend(101 * USDC, 10_000);
    }

    #[test]
    fn collect_splits_fee_between_reserve_and_lps() {
        let mut pool = funded(1000 * USDC);
        pool.lend(100 * USDC, 8000);
        pool.collect(40 * USDC, 0, 2000);
        assert_eq!(
            (pool.lent, pool.repaid, pool.fees),
            (60 * USDC, 40 * USDC, 0)
        );
        pool.collect(60 * USDC, 5 * USDC, 2000);
        assert_eq!(pool.lent, 0);
        assert_eq!(pool.repaid, 100 * USDC);
        assert_eq!(pool.fees, 5 * USDC);
        assert_eq!(pool.reserve, USDC);
        assert_eq!(pool.assets, 1004 * USDC);
    }

    #[test]
    fn write_off_uses_reserve_before_lp_assets() {
        let mut pool = funded(1000 * USDC);
        pool.reserve = 30 * USDC;
        pool.lend(100 * USDC, 8000);
        assert_eq!(pool.write_off(100 * USDC), 30 * USDC);
        assert_eq!(pool.reserve, 0);
        assert_eq!(pool.assets, 930 * USDC);
        assert_eq!(pool.lent, 0);
        assert_eq!(pool.written_off, 100 * USDC);
    }

    #[test]
    fn write_off_fully_covered_by_reserve_keeps_lp_assets() {
        let mut pool = funded(1000 * USDC);
        pool.reserve = 150 * USDC;
        pool.lend(100 * USDC, 8000);
        assert_eq!(pool.write_off(100 * USDC), 100 * USDC);
        assert_eq!(pool.reserve, 50 * USDC);
        assert_eq!(pool.assets, 1000 * USDC);
        assert_eq!(pool.liquid(), 1000 * USDC);
    }
}
