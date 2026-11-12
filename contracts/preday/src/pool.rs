use near_sdk::{near, require};

use crate::params::{bps, Params, BPS, USDC};

/// Smallest LP deposit.
pub const MIN_DEPOSIT: u128 = USDC;
/// Shares minted to no one by the first deposit of a share epoch. They keep
/// the share supply from ever being small enough to manipulate its price.
pub const LOCKED_SHARES: u128 = USDC;
/// A loss that leaves shares worth less than 1/1000 of what they were
/// minted at retires them.
const WIPEOUT_RATIO: u128 = 1000;

/// LP pool accounting. Tracked internally, never derived from the token
/// balance: `assets` is the LP claim (liquid funds plus funds lent out),
/// `reserve` sits outside of it and absorbs losses first.
#[near(serializers = [borsh])]
#[derive(Default, Debug, PartialEq)]
pub struct Pool {
    pub assets: u128,
    pub lent: u128,
    /// Part of `lent` that went to workers who were at level 0.
    pub lent_to_newcomers: u128,
    pub reserve: u128,
    pub total_shares: u128,
    pub advanced: u128,
    pub repaid: u128,
    pub fees: u128,
    pub written_off: u128,
    pub recovered: u128,
    pub advances_count: u32,
    /// Generation of the share supply. Shares of earlier epochs were wiped
    /// out by a loss and carry no claim.
    pub epoch: u32,
}

/// An LP position within one share epoch.
#[near(serializers = [borsh])]
#[derive(Clone, Default, Debug, PartialEq)]
pub struct Position {
    pub shares: u128,
    /// When the shares become withdrawable.
    pub unlocks_at: u64,
}

/// Where the principal of an advance came from.
#[near(serializers = [borsh])]
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Origin {
    pub epoch: u32,
    /// Counted in `lent_to_newcomers`.
    pub newcomer: bool,
}

/// How a written-off principal was absorbed.
#[derive(Default, Debug, PartialEq)]
pub struct Loss {
    pub from_reserve: u128,
    pub from_assets: u128,
}

/// Written-off debt that is still collected from the worker's income.
#[near(serializers = [borsh])]
#[derive(Clone, Debug, PartialEq)]
pub struct Recovery {
    pub owed: u128,
    /// What LP assets absorbed and have not got back yet.
    pub to_assets: u128,
    /// Share epoch that took the loss.
    pub epoch: u32,
}

impl Pool {
    pub fn liquid(&self) -> u128 {
        self.assets - self.lent
    }

    /// Adds LP funds and returns the shares credited to the depositor.
    pub fn deposit(&mut self, amount: u128) -> u128 {
        require!(amount >= MIN_DEPOSIT, "deposit is below the minimum");
        let (minted, credited) = if self.total_shares == 0 {
            require!(
                amount > LOCKED_SHARES,
                "first deposit must exceed the locked minimum"
            );
            (amount, amount - LOCKED_SHARES)
        } else {
            let shares = amount * self.total_shares / self.assets;
            require!(shares > 0, "deposit is too small");
            (shares, shares)
        };
        self.assets += amount;
        self.total_shares += minted;
        credited
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

    /// Reverts a withdrawal whose payout did not go through. Funds of an
    /// epoch retired in the meantime stay in the reserve.
    pub fn undo_withdraw(&mut self, shares: u128, amount: u128, epoch: u32) -> bool {
        if epoch != self.epoch {
            self.reserve += amount;
            return false;
        }
        self.assets += amount;
        self.total_shares += shares;
        true
    }

    pub fn lend(&mut self, amount: u128, newcomer: bool, params: &Params) -> Origin {
        require!(amount <= self.liquid(), "not enough liquidity");
        require!(
            (self.lent + amount) * BPS <= self.assets * u128::from(params.max_utilization_bps),
            "utilization cap reached"
        );
        if newcomer {
            require!(
                (self.lent_to_newcomers + amount) * BPS
                    <= self.assets * u128::from(params.newcomer_exposure_bps),
                "newcomer limit reached"
            );
            self.lent_to_newcomers += amount;
        }
        self.lent += amount;
        self.advanced += amount;
        self.advances_count += 1;
        Origin {
            epoch: self.epoch,
            newcomer,
        }
    }

    /// Reverts an advance whose payout did not go through.
    pub fn undo_lend(&mut self, amount: u128, origin: Origin) {
        self.advanced -= amount;
        self.advances_count -= 1;
        self.take_back(amount, origin);
    }

    /// Books a repayment. The fee is split between the reserve and the LPs.
    pub fn collect(&mut self, principal: u128, fee: u128, reserve_bps: u32, origin: Origin) {
        self.repaid += principal;
        self.fees += fee;
        if self.take_back(principal, origin) {
            let to_reserve = bps(fee, reserve_bps);
            self.reserve += to_reserve;
            self.assets += fee - to_reserve;
        } else {
            self.reserve += fee;
        }
    }

    /// Absorbs lost principal, reserve first. A loss that leaves the shares
    /// with next to nothing behind them retires the share epoch. Principal
    /// lent by an epoch that is already retired was lost with it.
    pub fn write_off(&mut self, principal: u128, origin: Origin) -> Loss {
        self.written_off += principal;
        if origin.epoch != self.epoch {
            return Loss::default();
        }
        let from_reserve = principal.min(self.reserve);
        let from_assets = principal - from_reserve;
        self.reserve -= from_reserve;
        self.assets -= from_assets;
        self.lent -= principal;
        if origin.newcomer {
            self.lent_to_newcomers -= principal;
        }
        if self.total_shares > 0 && self.assets * WIPEOUT_RATIO < self.total_shares {
            self.retire_epoch();
        }
        Loss {
            from_reserve,
            from_assets,
        }
    }

    /// Takes up to the owed amount out of `income` and returns it the way
    /// the loss went, in reverse: LP assets of the epoch that took the loss
    /// first, then the reserve. Returns what was taken.
    pub fn recover(&mut self, income: u128, recovery: &mut Recovery) -> u128 {
        let taken = income.min(recovery.owed);
        let to_assets = if recovery.epoch == self.epoch {
            taken.min(recovery.to_assets)
        } else {
            0
        };
        recovery.owed -= taken;
        recovery.to_assets -= to_assets;
        self.assets += to_assets;
        self.reserve += taken - to_assets;
        self.recovered += taken;
        taken
    }

    /// Returns lent principal to where it came from. Money owed to a
    /// retired epoch has no LPs left to go to and joins the reserve.
    /// Returns whether the origin epoch is still the current one.
    fn take_back(&mut self, principal: u128, origin: Origin) -> bool {
        if origin.epoch != self.epoch {
            self.reserve += principal;
            return false;
        }
        self.lent -= principal;
        if origin.newcomer {
            self.lent_to_newcomers -= principal;
        }
        true
    }

    /// Wipes the share supply. Whatever liquid funds the old shares still
    /// had move to the reserve, and their outstanding loans leave the books.
    fn retire_epoch(&mut self) {
        self.reserve += self.liquid();
        self.assets = 0;
        self.lent = 0;
        self.lent_to_newcomers = 0;
        self.total_shares = 0;
        self.epoch += 1;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const SEASONED: Origin = Origin {
        epoch: 0,
        newcomer: false,
    };

    fn params() -> Params {
        crate::params::tests::defaults()
    }

    /// Pool with `amount` of assets and as many shares, 1 USDC of them locked.
    fn funded(amount: u128) -> Pool {
        let mut pool = Pool::default();
        pool.deposit(amount);
        pool
    }

    #[test]
    fn first_deposit_locks_a_minimum_of_shares() {
        let mut pool = Pool::default();
        assert_eq!(pool.deposit(1000 * USDC), 999 * USDC);
        assert_eq!(pool.assets, 1000 * USDC);
        assert_eq!(pool.total_shares, 1000 * USDC);
    }

    #[test]
    #[should_panic(expected = "first deposit must exceed the locked minimum")]
    fn first_deposit_must_leave_shares_for_the_depositor() {
        Pool::default().deposit(USDC);
    }

    #[test]
    #[should_panic(expected = "deposit is below the minimum")]
    fn deposit_rejects_less_than_the_minimum() {
        funded(1000 * USDC).deposit(USDC - 1);
    }

    #[test]
    fn locked_shares_keep_the_price_from_being_inflated() {
        let mut pool = Pool::default();
        let attacker = pool.deposit(USDC + 1);
        assert_eq!(attacker, 1);
        assert_eq!(pool.withdraw(attacker), 1);
        assert_eq!((pool.assets, pool.total_shares), (USDC, USDC));

        pool.lend(800_000, false, &params());
        pool.collect(800_000, 5 * USDC, 0, SEASONED);
        assert_eq!(pool.deposit(12 * USDC), 2 * USDC);
        assert_eq!(pool.deposit(USDC), 166_666);
    }

    #[test]
    fn later_deposits_mint_at_share_price() {
        let mut pool = funded(1000 * USDC);
        pool.lend(100 * USDC, false, &params());
        pool.collect(100 * USDC, 100 * USDC, 0, SEASONED);
        assert_eq!(pool.assets, 1100 * USDC);
        assert_eq!(pool.deposit(110 * USDC), 100 * USDC);
        assert_eq!(pool.total_shares, 1100 * USDC);
    }

    #[test]
    fn withdraw_pays_share_price_including_fees() {
        let mut pool = funded(1000 * USDC);
        pool.lend(100 * USDC, false, &params());
        pool.collect(100 * USDC, 5 * USDC, 2000, SEASONED);
        assert_eq!(pool.reserve, USDC);
        assert_eq!(pool.assets, 1004 * USDC);
        assert_eq!(pool.withdraw(500 * USDC), 502 * USDC);
        assert_eq!(pool.withdraw(499 * USDC), 500_996_000);
        assert_eq!(pool.assets, 1_004_000);
        assert_eq!(pool.total_shares, LOCKED_SHARES);
        assert_eq!(pool.reserve, USDC);
    }

    #[test]
    #[should_panic(expected = "not enough liquid funds")]
    fn withdraw_is_limited_to_liquid_funds() {
        let mut pool = funded(1000 * USDC);
        pool.lend(800 * USDC, false, &params());
        pool.withdraw(201 * USDC);
    }

    #[test]
    fn undo_withdraw_restores_the_pool() {
        let mut pool = funded(1000 * USDC);
        let before = (pool.assets, pool.total_shares);
        let amount = pool.withdraw(400 * USDC);
        assert!(pool.undo_withdraw(400 * USDC, amount, 0));
        assert_eq!((pool.assets, pool.total_shares), before);
    }

    #[test]
    #[should_panic(expected = "invalid share amount")]
    fn withdraw_rejects_zero_shares() {
        funded(2 * USDC).withdraw(0);
    }

    #[test]
    fn lend_tracks_counters() {
        let mut pool = funded(1000 * USDC);
        pool.lend(100 * USDC, false, &params());
        pool.lend(50 * USDC, false, &params());
        assert_eq!(pool.lent, 150 * USDC);
        assert_eq!(pool.advanced, 150 * USDC);
        assert_eq!(pool.advances_count, 2);
        assert_eq!(pool.liquid(), 850 * USDC);
        pool.undo_lend(50 * USDC, SEASONED);
        assert_eq!(pool.lent, 100 * USDC);
        assert_eq!(pool.advanced, 100 * USDC);
        assert_eq!(pool.advances_count, 1);
    }

    #[test]
    fn lend_allows_exactly_the_utilization_cap() {
        let mut pool = funded(1000 * USDC);
        pool.lend(800 * USDC, false, &params());
        assert_eq!(pool.lent, 800 * USDC);
    }

    #[test]
    #[should_panic(expected = "utilization cap reached")]
    fn lend_rejects_above_the_utilization_cap() {
        let mut pool = funded(1000 * USDC);
        pool.lend(800 * USDC + 1, false, &params());
    }

    #[test]
    #[should_panic(expected = "not enough liquidity")]
    fn lend_rejects_more_than_liquid() {
        let mut pool = funded(100 * USDC);
        pool.lend(101 * USDC, false, &params());
    }

    #[test]
    fn collect_splits_fee_between_reserve_and_lps() {
        let mut pool = funded(1000 * USDC);
        pool.lend(100 * USDC, false, &params());
        pool.collect(40 * USDC, 0, 2000, SEASONED);
        assert_eq!(
            (pool.lent, pool.repaid, pool.fees),
            (60 * USDC, 40 * USDC, 0)
        );
        pool.collect(60 * USDC, 5 * USDC, 2000, SEASONED);
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
        pool.lend(100 * USDC, false, &params());
        assert_eq!(
            pool.write_off(100 * USDC, SEASONED),
            Loss {
                from_reserve: 30 * USDC,
                from_assets: 70 * USDC
            }
        );
        assert_eq!(pool.reserve, 0);
        assert_eq!(pool.assets, 930 * USDC);
        assert_eq!(pool.lent, 0);
        assert_eq!(pool.written_off, 100 * USDC);
        assert_eq!(pool.epoch, 0);
    }

    #[test]
    fn write_off_fully_covered_by_reserve_keeps_lp_assets() {
        let mut pool = funded(1000 * USDC);
        pool.reserve = 150 * USDC;
        pool.lend(100 * USDC, false, &params());
        assert_eq!(
            pool.write_off(100 * USDC, SEASONED),
            Loss {
                from_reserve: 100 * USDC,
                from_assets: 0
            }
        );
        assert_eq!(pool.reserve, 50 * USDC);
        assert_eq!(pool.assets, 1000 * USDC);
        assert_eq!(pool.liquid(), 1000 * USDC);
    }

    #[test]
    fn total_loss_opens_a_new_share_epoch() {
        let mut pool = funded(100 * USDC);
        pool.lend(80 * USDC, false, &params());
        pool.withdraw(20 * USDC);
        assert_eq!(pool.write_off(80 * USDC, SEASONED).from_assets, 80 * USDC);
        assert_eq!((pool.assets, pool.lent, pool.total_shares), (0, 0, 0));
        assert_eq!(pool.epoch, 1);

        assert_eq!(pool.deposit(500 * USDC), 499 * USDC);
        assert_eq!((pool.assets, pool.total_shares), (500 * USDC, 500 * USDC));
    }

    #[test]
    fn near_total_loss_also_retires_the_epoch() {
        let mut pool = funded(100 * USDC);
        pool.lend(80 * USDC, false, &params());
        pool.withdraw(19_950_000);
        pool.write_off(80 * USDC, SEASONED);
        assert_eq!((pool.assets, pool.lent, pool.total_shares), (0, 0, 0));
        assert_eq!(pool.reserve, 50_000);
        assert_eq!(pool.epoch, 1);
        assert_eq!(pool.deposit(10 * USDC), 9 * USDC);
    }

    #[test]
    fn loss_just_above_the_wipeout_ratio_keeps_the_epoch() {
        let mut pool = funded(100 * USDC);
        pool.lend(80 * USDC, false, &params());
        pool.withdraw(19_900_000);
        pool.write_off(80 * USDC, SEASONED);
        assert_eq!(pool.epoch, 0);
        assert_eq!((pool.assets, pool.total_shares), (100_000, 80_100_000));
    }

    /// A 2000 USDC pool wiped out by one large loss while a 1 USDC loan
    /// is still outstanding. Returns the pool and the surviving loan.
    fn wiped_with_a_loan_outstanding() -> (Pool, Origin) {
        let lenient = Params {
            max_utilization_bps: 9000,
            ..params()
        };
        let mut pool = funded(2000 * USDC);
        let alive = pool.lend(USDC, true, &lenient);
        let lost = pool.lend(1799 * USDC, false, &lenient);
        pool.withdraw(199_500_000);
        pool.write_off(1799 * USDC, lost);
        assert_eq!(pool.epoch, 1);
        assert_eq!((pool.assets, pool.lent, pool.lent_to_newcomers), (0, 0, 0));
        assert_eq!(pool.reserve, 500_000);
        (pool, alive)
    }

    #[test]
    fn loans_of_a_retired_epoch_are_repaid_to_the_reserve() {
        let (mut pool, alive) = wiped_with_a_loan_outstanding();
        pool.deposit(100 * USDC);
        pool.collect(USDC, USDC, 2000, alive);
        assert_eq!(pool.reserve, 2_500_000);
        assert_eq!((pool.assets, pool.lent), (100 * USDC, 0));
        assert_eq!((pool.repaid, pool.fees), (USDC, USDC));
    }

    #[test]
    fn losses_of_a_retired_epoch_do_not_touch_the_new_one() {
        let (mut pool, alive) = wiped_with_a_loan_outstanding();
        pool.deposit(100 * USDC);
        assert_eq!(pool.write_off(USDC, alive), Loss::default());
        assert_eq!((pool.assets, pool.reserve), (100 * USDC, 500_000));
        assert_eq!(pool.written_off, 1800 * USDC);
        assert_eq!(pool.epoch, 1);
    }

    #[test]
    fn undone_loan_of_a_retired_epoch_goes_to_the_reserve() {
        let (mut pool, alive) = wiped_with_a_loan_outstanding();
        pool.undo_lend(USDC, alive);
        assert_eq!(pool.reserve, 1_500_000);
        assert_eq!((pool.advanced, pool.advances_count), (1799 * USDC, 1));
    }

    #[test]
    fn undone_withdrawal_of_a_retired_epoch_goes_to_the_reserve() {
        let (mut pool, _) = wiped_with_a_loan_outstanding();
        assert!(!pool.undo_withdraw(5 * USDC, 5 * USDC, 0));
        assert_eq!(pool.reserve, 5_500_000);
        assert_eq!((pool.assets, pool.total_shares), (0, 0));
    }

    #[test]
    fn newcomer_exposure_is_capped_and_tracked() {
        let mut pool = funded(1000 * USDC);
        let first = pool.lend(60 * USDC, true, &params());
        let second = pool.lend(40 * USDC, true, &params());
        assert_eq!(pool.lent_to_newcomers, 100 * USDC);
        pool.lend(300 * USDC, false, &params());
        assert_eq!(pool.lent_to_newcomers, 100 * USDC);

        pool.collect(25 * USDC, 0, 2000, first);
        assert_eq!(pool.lent_to_newcomers, 75 * USDC);
        pool.undo_lend(40 * USDC, second);
        assert_eq!(pool.lent_to_newcomers, 35 * USDC);
        pool.write_off(35 * USDC, first);
        assert_eq!(pool.lent_to_newcomers, 0);
        assert_eq!(pool.lent, 300 * USDC);
    }

    #[test]
    #[should_panic(expected = "newcomer limit reached")]
    fn newcomer_exposure_cannot_exceed_its_share_of_assets() {
        let mut pool = funded(1000 * USDC);
        pool.lend(100 * USDC, true, &params());
        pool.lend(1, true, &params());
    }

    #[test]
    fn recovery_refills_assets_before_the_reserve() {
        let mut pool = funded(1000 * USDC);
        pool.reserve = 10 * USDC;
        let origin = pool.lend(100 * USDC, false, &params());
        let loss = pool.write_off(100 * USDC, origin);
        assert_eq!(pool.assets, 910 * USDC);
        let mut recovery = Recovery {
            owed: 105 * USDC,
            to_assets: loss.from_assets,
            epoch: origin.epoch,
        };

        assert_eq!(pool.recover(50 * USDC, &mut recovery), 50 * USDC);
        assert_eq!((pool.assets, pool.reserve), (960 * USDC, 0));
        assert_eq!(pool.recover(1, &mut recovery), 1);
        assert_eq!(pool.recover(1000 * USDC, &mut recovery), 55 * USDC - 1);
        assert_eq!((pool.assets, pool.reserve), (1000 * USDC, 15 * USDC));
        assert_eq!(pool.recovered, 105 * USDC);
        assert_eq!((recovery.owed, recovery.to_assets), (0, 0));
        assert_eq!(pool.recover(USDC, &mut recovery), 0);
    }

    #[test]
    fn recovery_for_a_retired_epoch_goes_to_the_reserve() {
        let (mut pool, _) = wiped_with_a_loan_outstanding();
        pool.deposit(100 * USDC);
        let mut recovery = Recovery {
            owed: 1800 * USDC,
            to_assets: 1799 * USDC,
            epoch: 0,
        };
        assert_eq!(pool.recover(300 * USDC, &mut recovery), 300 * USDC);
        assert_eq!((pool.assets, pool.reserve), (100 * USDC, 300_500_000));
        assert_eq!(recovery.owed, 1500 * USDC);
    }
}
