use near_sdk::json_types::{Base58CryptoHash, U128};
use near_sdk::serde_json::{json, to_value};
use near_sdk::test_utils::VMContextBuilder;
use near_sdk::{
    test_vm_config, testing_env, AccountId, NearToken, PromiseResult, RuntimeFeesConfig,
};

use crate::params::tests::{defaults, DAY_MS, USDC};
use crate::registry::REGISTER_DEPOSIT;
use crate::worker::Ineligible;
use crate::{Params, Preday};

const PREDAY: &str = "preday.near";
const TOKEN: &str = "usdc.near";
const VERIFIER: &str = "verifier.near";
const OWNER: &str = "owner.near";
const ANNA: &str = "anna-wallet.near";
const BORIS: &str = "boris-wallet.near";
const LP: &str = "lp.near";

const DELAY_MS: u64 = 2 * DAY_MS;
const MATURE: u64 = 30 * DAY_MS;
const PAYCHECK: u128 = 100 * USDC;

fn id(account: &str) -> AccountId {
    account.parse().unwrap()
}

fn context(predecessor: &str, now_ms: u64) -> VMContextBuilder {
    let mut builder = VMContextBuilder::new();
    builder
        .current_account_id(id(PREDAY))
        .predecessor_account_id(id(predecessor))
        .block_timestamp(now_ms * 1_000_000);
    builder
}

fn at(predecessor: &str, now_ms: u64) {
    testing_env!(context(predecessor, now_ms).build());
}

/// Enters a callback of the contract with the given outcome of the awaited promise.
fn in_callback(now_ms: u64, success: bool) {
    let result = if success {
        PromiseResult::Successful(Vec::new())
    } else {
        PromiseResult::Failed
    };
    testing_env!(
        context(PREDAY, now_ms).build(),
        test_vm_config(),
        RuntimeFeesConfig::test(),
        Default::default(),
        vec![result],
    );
}

fn contract() -> Preday {
    at(OWNER, 0);
    Preday::new(
        id(TOKEN),
        id(VERIFIER),
        Base58CryptoHash::from([9; 32]),
        defaults(),
        DELAY_MS,
    )
}

fn register(contract: &mut Preday, owner: &str, handle: &str) {
    testing_env!(context(owner, 0).attached_deposit(REGISTER_DEPOSIT).build());
    contract.register(handle.to_string()).detach();
    in_callback(0, true);
    assert!(contract.on_registered(handle.to_string(), id(owner)));
}

fn verify(contract: &mut Preday, handle: &str, person: u8) {
    at(VERIFIER, 0);
    contract.set_verified(handle.to_string(), Base58CryptoHash::from([person; 32]));
}

fn transfer(contract: &mut Preday, sender: &str, amount: u128, msg: &str, now_ms: u64) {
    at(TOKEN, now_ms);
    assert_eq!(
        contract.ft_on_transfer(id(sender), U128(amount), msg.to_string()),
        U128(0)
    );
}

fn income(contract: &mut Preday, handle: &str, amount: u128, now_ms: u64) {
    let sender = format!("{handle}.{PREDAY}");
    transfer(
        contract,
        &sender,
        amount,
        &json!({ "income": handle }).to_string(),
        now_ms,
    );
}

fn deposit(contract: &mut Preday, lp: &str, amount: u128) {
    transfer(contract, lp, amount, r#"{"deposit":true}"#, 0);
}

fn advance(contract: &mut Preday, owner: &str, handle: &str, amount: u128, now_ms: u64) {
    at(owner, now_ms);
    contract.request_advance(U128(amount)).detach();
    in_callback(now_ms, true);
    assert!(contract.on_advance_sent(handle.to_string(), U128(amount), now_ms));
}

/// Anna: registered, verified, three paychecks at time zero, pool of 1000 USDC.
fn funded() -> Preday {
    let mut contract = contract();
    register(&mut contract, ANNA, "anna");
    verify(&mut contract, "anna", 1);
    for _ in 0..3 {
        income(&mut contract, "anna", PAYCHECK, 0);
    }
    deposit(&mut contract, LP, 1000 * USDC);
    contract
}

fn worker(contract: &Preday, handle: &str) -> crate::views::WorkerView {
    contract.get_worker(handle.to_string()).unwrap()
}

#[test]
fn new_makes_the_caller_owner() {
    let contract = contract();
    assert_eq!(
        to_value(contract.get_config()).unwrap(),
        json!({
            "usdc": TOKEN,
            "verifier": VERIFIER,
            "owner": OWNER,
            "register_deposit": "20000000000000000000000",
            "params_delay_ms": DELAY_MS,
        })
    );
    assert_eq!(contract.get_params(), defaults());
    assert_eq!(contract.get_pending_params(), None);
}

#[test]
#[should_panic(expected = "ladder must have 1 to 16 steps")]
fn new_validates_params() {
    at(OWNER, 0);
    let params = Params {
        ladder: vec![],
        ..defaults()
    };
    Preday::new(
        id(TOKEN),
        id(VERIFIER),
        Base58CryptoHash::from([9; 32]),
        params,
        0,
    );
}

#[test]
fn register_claims_a_handle() {
    let mut contract = contract();
    register(&mut contract, ANNA, "anna");
    assert_eq!(contract.get_handle(id(ANNA)), Some("anna".to_string()));
    assert_eq!(contract.get_handle(id(BORIS)), None);
    assert!(contract.get_worker("boris".to_string()).is_none());
    assert_eq!(
        to_value(contract.get_worker("anna".to_string())).unwrap(),
        json!({
            "handle": "anna",
            "owner": ANNA,
            "verified": false,
            "banned": false,
            "level": 0,
            "payments_count": 0,
            "first_payment_at": null,
            "total_received": "0",
            "pending": "0",
            "advance": null,
        })
    );
}

#[test]
fn failed_account_creation_releases_the_handle() {
    let mut contract = contract();
    testing_env!(context(ANNA, 0).attached_deposit(REGISTER_DEPOSIT).build());
    contract.register("anna".to_string()).detach();
    in_callback(0, false);
    assert!(!contract.on_registered("anna".to_string(), id(ANNA)));
    assert!(contract.get_worker("anna".to_string()).is_none());
    assert_eq!(contract.get_handle(id(ANNA)), None);
    register(&mut contract, BORIS, "anna");
}

#[test]
#[should_panic(expected = "attach exactly the register deposit")]
fn register_requires_the_deposit() {
    let mut contract = contract();
    testing_env!(context(ANNA, 0)
        .attached_deposit(NearToken::from_millinear(19))
        .build());
    contract.register("anna".to_string()).detach();
}

#[test]
#[should_panic(expected = "invalid handle")]
fn register_rejects_bad_handles() {
    let mut contract = contract();
    testing_env!(context(ANNA, 0).attached_deposit(REGISTER_DEPOSIT).build());
    contract.register("Anna".to_string()).detach();
}

#[test]
#[should_panic(expected = "handle is taken")]
fn register_rejects_taken_handles() {
    let mut contract = contract();
    register(&mut contract, ANNA, "anna");
    register(&mut contract, BORIS, "anna");
}

#[test]
#[should_panic(expected = "account already has a handle")]
fn register_allows_one_handle_per_account() {
    let mut contract = contract();
    register(&mut contract, ANNA, "anna");
    register(&mut contract, ANNA, "anna2");
}

#[test]
#[should_panic(expected = "only usdc is accepted")]
fn transfers_from_other_tokens_are_rejected() {
    let mut contract = funded();
    at("fake-usdc.near", 0);
    contract.ft_on_transfer(id(LP), U128(USDC), r#"{"deposit":true}"#.to_string());
}

#[test]
#[should_panic(expected = "unsupported msg")]
fn transfers_with_unknown_msg_are_rejected() {
    let mut contract = funded();
    transfer(&mut contract, LP, USDC, "hello", 0);
}

#[test]
#[should_panic(expected = "unsupported msg")]
fn transfers_with_empty_msg_are_rejected() {
    let mut contract = funded();
    transfer(&mut contract, LP, USDC, "", 0);
}

#[test]
#[should_panic(expected = "unsupported msg")]
fn deposit_false_is_rejected() {
    let mut contract = funded();
    transfer(&mut contract, LP, USDC, r#"{"deposit":false}"#, 0);
}

#[test]
#[should_panic(expected = "amount must be positive")]
fn zero_transfers_are_rejected() {
    let mut contract = funded();
    transfer(&mut contract, LP, 0, r#"{"deposit":true}"#, 0);
}

#[test]
#[should_panic(expected = "income must come from the handle's own account")]
fn income_from_another_sender_is_rejected() {
    let mut contract = funded();
    transfer(&mut contract, BORIS, PAYCHECK, r#"{"income":"anna"}"#, 0);
}

#[test]
#[should_panic(expected = "unknown handle")]
fn income_for_an_unknown_handle_is_rejected() {
    let mut contract = funded();
    income(&mut contract, "ghost", PAYCHECK, 0);
}

#[test]
fn income_is_recorded_per_payment() {
    let mut contract = contract();
    register(&mut contract, ANNA, "anna");
    income(&mut contract, "anna", 10 * USDC, 1000);
    income(&mut contract, "anna", 20 * USDC, 2000);
    income(&mut contract, "anna", 30 * USDC, 3000);
    income(&mut contract, "anna", 40 * USDC, 4000);

    let anna = worker(&contract, "anna");
    assert_eq!(anna.payments_count, 4);
    assert_eq!(anna.first_payment_at, Some(1000));
    assert_eq!(anna.total_received, U128(100 * USDC));

    let page = |from, limit| to_value(contract.get_payments("anna".to_string(), from, limit));
    assert_eq!(
        page(0, 2).unwrap(),
        json!([{ "amount": "10000000", "at": 1000 }, { "amount": "20000000", "at": 2000 }])
    );
    assert_eq!(
        page(2, 10).unwrap(),
        json!([{ "amount": "30000000", "at": 3000 }, { "amount": "40000000", "at": 4000 }])
    );
    assert_eq!(page(4, 10).unwrap(), json!([]));
    assert_eq!(page(1, u32::MAX).unwrap().as_array().unwrap().len(), 3);
    assert!(contract.get_payments("ghost".to_string(), 0, 10).is_empty());
    assert_eq!(to_value(contract.get_pool()).unwrap()["assets"], "0");
}

#[test]
fn limit_view_follows_the_worker() {
    let mut contract = contract();
    register(&mut contract, ANNA, "anna");
    income(&mut contract, "anna", PAYCHECK, 0);
    at(ANNA, 0);
    assert_eq!(
        to_value(contract.get_limit("anna".to_string())).unwrap(),
        json!({ "eligible": false, "limit": "25000000", "base": "100000000", "reason": "not_verified" })
    );

    verify(&mut contract, "anna", 1);
    income(&mut contract, "anna", PAYCHECK, 0);
    income(&mut contract, "anna", PAYCHECK, 0);
    at(ANNA, MATURE - 1);
    assert_eq!(
        contract.get_limit("anna".to_string()).reason,
        Some(Ineligible::ShortHistory)
    );
    at(ANNA, MATURE);
    assert_eq!(
        to_value(contract.get_limit("anna".to_string())).unwrap(),
        json!({ "eligible": true, "limit": "25000000", "base": "100000000", "reason": null })
    );
}

#[test]
#[should_panic(expected = "only the verifier can verify")]
fn only_the_verifier_can_verify() {
    let mut contract = funded();
    at(OWNER, 0);
    contract.set_verified("anna".to_string(), Base58CryptoHash::from([2; 32]));
}

#[test]
#[should_panic(expected = "unknown handle")]
fn verifying_an_unknown_handle_fails() {
    let mut contract = funded();
    verify(&mut contract, "ghost", 2);
}

#[test]
#[should_panic(expected = "handle is already verified")]
fn a_handle_is_verified_once() {
    let mut contract = funded();
    verify(&mut contract, "anna", 2);
}

#[test]
#[should_panic(expected = "person already has a handle")]
fn a_person_backs_one_handle() {
    let mut contract = funded();
    register(&mut contract, BORIS, "boris");
    verify(&mut contract, "boris", 1);
}

#[test]
#[should_panic(expected = "account has no handle")]
fn advance_requires_a_handle() {
    let mut contract = funded();
    at(BORIS, MATURE);
    contract.request_advance(U128(USDC)).detach();
}

#[test]
#[should_panic(expected = "not eligible: not_verified")]
fn advance_requires_verification() {
    let mut contract = contract();
    register(&mut contract, ANNA, "anna");
    at(ANNA, MATURE);
    contract.request_advance(U128(USDC)).detach();
}

#[test]
#[should_panic(expected = "not eligible: few_payments")]
fn advance_requires_enough_payments() {
    let mut contract = contract();
    register(&mut contract, ANNA, "anna");
    verify(&mut contract, "anna", 1);
    income(&mut contract, "anna", PAYCHECK, 0);
    at(ANNA, MATURE);
    contract.request_advance(U128(USDC)).detach();
}

#[test]
#[should_panic(expected = "not eligible: short_history")]
fn advance_requires_enough_history() {
    let mut contract = funded();
    at(ANNA, MATURE - 1);
    contract.request_advance(U128(USDC)).detach();
}

#[test]
#[should_panic(expected = "amount exceeds the limit")]
fn advance_cannot_exceed_the_limit() {
    let mut contract = funded();
    at(ANNA, MATURE);
    contract.request_advance(U128(25 * USDC + 1)).detach();
}

#[test]
#[should_panic(expected = "amount must be positive")]
fn advance_cannot_be_zero() {
    let mut contract = funded();
    at(ANNA, MATURE);
    contract.request_advance(U128(0)).detach();
}

#[test]
#[should_panic(expected = "not enough liquidity")]
fn advance_needs_pool_liquidity() {
    let mut contract = contract();
    register(&mut contract, ANNA, "anna");
    verify(&mut contract, "anna", 1);
    for _ in 0..3 {
        income(&mut contract, "anna", PAYCHECK, 0);
    }
    deposit(&mut contract, LP, 20 * USDC);
    at(ANNA, MATURE);
    contract.request_advance(U128(25 * USDC)).detach();
}

#[test]
#[should_panic(expected = "utilization cap reached")]
fn advance_respects_the_utilization_cap() {
    let mut contract = contract();
    register(&mut contract, ANNA, "anna");
    verify(&mut contract, "anna", 1);
    for _ in 0..3 {
        income(&mut contract, "anna", PAYCHECK, 0);
    }
    deposit(&mut contract, LP, 30 * USDC);
    at(ANNA, MATURE);
    contract.request_advance(U128(25 * USDC)).detach();
}

#[test]
fn advance_is_recorded_with_its_fee() {
    let mut contract = funded();
    advance(&mut contract, ANNA, "anna", 25 * USDC, MATURE);

    assert_eq!(
        to_value(worker(&contract, "anna").advance).unwrap(),
        json!({
            "principal": "25000000",
            "fee": "1250000",
            "repaid": "0",
            "opened_at": MATURE,
            "touched_at": MATURE,
            "late": false,
        })
    );
    assert_eq!(
        to_value(contract.get_pool()).unwrap(),
        json!({
            "assets": "1000000000",
            "lent": "25000000",
            "reserve": "0",
            "total_shares": "1000000000",
            "advanced": "25000000",
            "repaid": "0",
            "fees": "0",
            "written_off": "0",
            "advances_count": 1,
        })
    );
    at(ANNA, MATURE);
    assert_eq!(
        contract.get_limit("anna".to_string()).reason,
        Some(Ineligible::AdvanceOpen)
    );
}

#[test]
fn small_advance_pays_the_minimum_fee() {
    let mut contract = funded();
    advance(&mut contract, ANNA, "anna", 5 * USDC, MATURE);
    assert_eq!(worker(&contract, "anna").advance.unwrap().fee, U128(USDC));
}

#[test]
#[should_panic(expected = "not eligible: advance_open")]
fn one_advance_at_a_time() {
    let mut contract = funded();
    advance(&mut contract, ANNA, "anna", 10 * USDC, MATURE);
    at(ANNA, MATURE);
    contract.request_advance(U128(10 * USDC)).detach();
}

#[test]
fn failed_advance_payout_rolls_everything_back() {
    let mut contract = funded();
    at(ANNA, MATURE);
    contract.request_advance(U128(25 * USDC)).detach();
    in_callback(MATURE, false);
    assert!(!contract.on_advance_sent("anna".to_string(), U128(25 * USDC), MATURE));

    let anna = worker(&contract, "anna");
    assert!(anna.advance.is_none());
    assert_eq!(anna.pending, U128(0));
    let pool = to_value(contract.get_pool()).unwrap();
    assert_eq!(pool["lent"], "0");
    assert_eq!(pool["advanced"], "0");
    assert_eq!(pool["advances_count"], 0);
    at(ANNA, MATURE);
    assert!(contract.get_limit("anna".to_string()).eligible);
}

#[test]
fn failed_advance_payout_after_a_repayment_becomes_claimable() {
    let mut contract = funded();
    at(ANNA, MATURE);
    contract.request_advance(U128(25 * USDC)).detach();
    income(&mut contract, "anna", 10 * USDC, MATURE);
    in_callback(MATURE, false);
    assert!(!contract.on_advance_sent("anna".to_string(), U128(25 * USDC), MATURE));

    let anna = worker(&contract, "anna");
    assert_eq!(anna.advance.unwrap().repaid, U128(10 * USDC));
    assert_eq!(anna.pending, U128(25 * USDC));
    assert_eq!(to_value(contract.get_pool()).unwrap()["lent"], "15000000");
}

#[test]
fn income_repays_principal_first_then_fee() {
    let mut contract = funded();
    advance(&mut contract, ANNA, "anna", 25 * USDC, MATURE);

    income(&mut contract, "anna", 10 * USDC, MATURE + 1000);
    let open = worker(&contract, "anna").advance.unwrap();
    assert_eq!(open.repaid, U128(10 * USDC));
    assert_eq!(open.touched_at, MATURE + 1000);
    assert_eq!(open.opened_at, MATURE);
    let pool = to_value(contract.get_pool()).unwrap();
    assert_eq!(pool["lent"], "15000000");
    assert_eq!(pool["repaid"], "10000000");
    assert_eq!(pool["fees"], "0");
    assert_eq!(pool["assets"], "1000000000");

    income(&mut contract, "anna", PAYCHECK, MATURE + 2000);
    let anna = worker(&contract, "anna");
    assert!(anna.advance.is_none());
    assert_eq!(anna.level, 1);
    assert_eq!(anna.payments_count, 5);
    assert_eq!(
        to_value(contract.get_pool()).unwrap(),
        json!({
            "assets": "1001000000",
            "lent": "0",
            "reserve": "250000",
            "total_shares": "1000000000",
            "advanced": "25000000",
            "repaid": "25000000",
            "fees": "1250000",
            "written_off": "0",
            "advances_count": 1,
        })
    );
}

#[test]
fn level_grows_with_each_repaid_advance_up_to_the_top() {
    let mut contract = funded();
    for round in 0..6u64 {
        let now = MATURE + round * DAY_MS;
        advance(&mut contract, ANNA, "anna", 10 * USDC, now);
        income(&mut contract, "anna", PAYCHECK, now + 1);
    }
    assert_eq!(worker(&contract, "anna").level, 4);
}

#[test]
fn failed_payout_is_credited_and_claimable() {
    let mut contract = funded();
    in_callback(0, false);
    assert!(!contract.on_payout("anna".to_string(), U128(40 * USDC)));
    assert_eq!(worker(&contract, "anna").pending, U128(40 * USDC));

    at(ANNA, 0);
    contract.claim().detach();
    assert_eq!(worker(&contract, "anna").pending, U128(0));
    in_callback(0, true);
    assert!(contract.on_payout("anna".to_string(), U128(40 * USDC)));
    assert_eq!(worker(&contract, "anna").pending, U128(0));
}

#[test]
#[should_panic(expected = "nothing to claim")]
fn claim_needs_a_pending_balance() {
    let mut contract = funded();
    at(ANNA, 0);
    contract.claim().detach();
}

#[test]
fn mark_late_flags_the_advance_and_resets_the_level() {
    let mut contract = funded();
    advance(&mut contract, ANNA, "anna", 10 * USDC, MATURE);
    income(&mut contract, "anna", PAYCHECK, MATURE);
    assert_eq!(worker(&contract, "anna").level, 1);

    advance(&mut contract, ANNA, "anna", 30 * USDC, MATURE);
    income(&mut contract, "anna", 5 * USDC, MATURE + DAY_MS);
    at(BORIS, MATURE + 46 * DAY_MS);
    contract.mark_late("anna".to_string());
    let anna = worker(&contract, "anna");
    assert!(anna.advance.unwrap().late);
    assert_eq!(anna.level, 0);

    income(&mut contract, "anna", PAYCHECK, MATURE + 50 * DAY_MS);
    let anna = worker(&contract, "anna");
    assert!(anna.advance.is_none());
    assert_eq!(anna.level, 0);
    assert!(!anna.banned);
}

#[test]
#[should_panic(expected = "advance is not late yet")]
fn mark_late_counts_from_the_last_repayment() {
    let mut contract = funded();
    advance(&mut contract, ANNA, "anna", 25 * USDC, MATURE);
    income(&mut contract, "anna", 5 * USDC, MATURE + DAY_MS);
    at(BORIS, MATURE + 45 * DAY_MS);
    contract.mark_late("anna".to_string());
}

#[test]
#[should_panic(expected = "advance is already late")]
fn mark_late_works_once() {
    let mut contract = funded();
    advance(&mut contract, ANNA, "anna", 25 * USDC, MATURE);
    at(BORIS, MATURE + 45 * DAY_MS);
    contract.mark_late("anna".to_string());
    contract.mark_late("anna".to_string());
}

#[test]
#[should_panic(expected = "no open advance")]
fn mark_late_needs_an_open_advance() {
    let mut contract = funded();
    at(BORIS, MATURE + 45 * DAY_MS);
    contract.mark_late("anna".to_string());
}

#[test]
fn write_off_takes_the_reserve_before_lp_assets() {
    let mut contract = funded();
    advance(&mut contract, ANNA, "anna", 25 * USDC, MATURE);
    income(&mut contract, "anna", PAYCHECK, MATURE);
    advance(&mut contract, ANNA, "anna", 30 * USDC, MATURE);
    income(&mut contract, "anna", 10 * USDC, MATURE + DAY_MS);

    at(BORIS, MATURE + 91 * DAY_MS);
    contract.write_off("anna".to_string());

    let anna = worker(&contract, "anna");
    assert!(anna.advance.is_none());
    assert!(anna.banned);
    assert_eq!(anna.level, 0);
    assert_eq!(
        to_value(contract.get_pool()).unwrap(),
        json!({
            "assets": "981250000",
            "lent": "0",
            "reserve": "0",
            "total_shares": "1000000000",
            "advanced": "55000000",
            "repaid": "35000000",
            "fees": "1250000",
            "written_off": "20000000",
            "advances_count": 2,
        })
    );
    assert_eq!(
        contract.get_limit("anna".to_string()).reason,
        Some(Ineligible::Banned)
    );
}

#[test]
#[should_panic(expected = "advance cannot be written off yet")]
fn write_off_counts_from_the_last_repayment() {
    let mut contract = funded();
    advance(&mut contract, ANNA, "anna", 25 * USDC, MATURE);
    income(&mut contract, "anna", 5 * USDC, MATURE + DAY_MS);
    at(BORIS, MATURE + 90 * DAY_MS);
    contract.write_off("anna".to_string());
}

#[test]
#[should_panic(expected = "not eligible: banned")]
fn banned_workers_get_no_advance() {
    let mut contract = funded();
    advance(&mut contract, ANNA, "anna", 25 * USDC, MATURE);
    at(BORIS, MATURE + 90 * DAY_MS);
    contract.write_off("anna".to_string());
    at(ANNA, MATURE + 91 * DAY_MS);
    contract.request_advance(U128(USDC)).detach();
}

#[test]
#[should_panic(expected = "person is banned")]
fn banned_person_cannot_verify_another_handle() {
    let mut contract = funded();
    advance(&mut contract, ANNA, "anna", 25 * USDC, MATURE);
    at(BORIS, MATURE + 90 * DAY_MS);
    contract.write_off("anna".to_string());
    register(&mut contract, BORIS, "boris");
    verify(&mut contract, "boris", 1);
}

#[test]
fn deposits_mint_shares_at_the_share_price() {
    let mut contract = funded();
    advance(&mut contract, ANNA, "anna", 25 * USDC, MATURE);
    income(&mut contract, "anna", PAYCHECK, MATURE);
    assert_eq!(contract.get_shares(id(LP)), U128(1000 * USDC));

    deposit(&mut contract, BORIS, 1001 * USDC);
    assert_eq!(contract.get_shares(id(BORIS)), U128(1000 * USDC));
    deposit(&mut contract, BORIS, 1001 * USDC);
    assert_eq!(contract.get_shares(id(BORIS)), U128(2000 * USDC));
    assert_eq!(contract.get_shares(id(ANNA)), U128(0));
}

#[test]
fn withdraw_burns_shares_for_assets() {
    let mut contract = funded();
    advance(&mut contract, ANNA, "anna", 25 * USDC, MATURE);
    income(&mut contract, "anna", PAYCHECK, MATURE);

    at(LP, MATURE);
    contract.withdraw(U128(400 * USDC)).detach();
    assert_eq!(contract.get_shares(id(LP)), U128(600 * USDC));
    let pool = to_value(contract.get_pool()).unwrap();
    assert_eq!(pool["assets"], "600600000");
    assert_eq!(pool["total_shares"], "600000000");

    in_callback(MATURE, false);
    assert!(!contract.on_withdraw_sent(id(LP), U128(400 * USDC), U128(400_400_000)));
    assert_eq!(contract.get_shares(id(LP)), U128(1000 * USDC));
    let pool = to_value(contract.get_pool()).unwrap();
    assert_eq!(pool["assets"], "1001000000");
    assert_eq!(pool["total_shares"], "1000000000");

    at(LP, MATURE);
    contract.withdraw(U128(1000 * USDC)).detach();
    assert_eq!(contract.get_shares(id(LP)), U128(0));
    let pool = to_value(contract.get_pool()).unwrap();
    assert_eq!(pool["assets"], "0");
    assert_eq!(pool["reserve"], "250000");
}

#[test]
#[should_panic(expected = "not enough shares")]
fn withdraw_is_limited_to_own_shares() {
    let mut contract = funded();
    deposit(&mut contract, BORIS, 10 * USDC);
    at(BORIS, 0);
    contract.withdraw(U128(11 * USDC)).detach();
}

#[test]
#[should_panic(expected = "not enough liquid funds")]
fn withdraw_cannot_touch_lent_funds() {
    let mut contract = funded();
    advance(&mut contract, ANNA, "anna", 25 * USDC, MATURE);
    at(LP, MATURE);
    contract.withdraw(U128(1000 * USDC)).detach();
}

#[test]
fn params_change_after_the_timelock() {
    let mut contract = contract();
    let proposed = Params {
        fee_bps: 300,
        ..defaults()
    };

    at(OWNER, 1000);
    contract.propose_params(proposed.clone());
    assert_eq!(
        to_value(contract.get_pending_params()).unwrap(),
        json!({ "params": to_value(&proposed).unwrap(), "apply_at": 1000 + DELAY_MS })
    );
    assert_eq!(contract.get_params(), defaults());

    at(BORIS, 1000 + DELAY_MS);
    contract.apply_params();
    assert_eq!(contract.get_params(), proposed);
    assert_eq!(contract.get_pending_params(), None);
}

#[test]
#[should_panic(expected = "params are still timelocked")]
fn params_cannot_be_applied_early() {
    let mut contract = contract();
    at(OWNER, 1000);
    contract.propose_params(Params {
        fee_bps: 300,
        ..defaults()
    });
    at(OWNER, 999 + DELAY_MS);
    contract.apply_params();
}

#[test]
#[should_panic(expected = "only the owner can propose params")]
fn only_the_owner_proposes_params() {
    let mut contract = contract();
    at(BORIS, 0);
    contract.propose_params(defaults());
}

#[test]
#[should_panic(expected = "bps values cannot exceed 10000")]
fn proposed_params_are_validated() {
    let mut contract = contract();
    at(OWNER, 0);
    contract.propose_params(Params {
        reserve_bps: 10_001,
        ..defaults()
    });
}

#[test]
#[should_panic(expected = "no pending params")]
fn apply_needs_a_proposal() {
    let mut contract = contract();
    at(BORIS, DELAY_MS);
    contract.apply_params();
}

#[test]
fn params_serialize_to_the_documented_shape() {
    assert_eq!(
        to_value(defaults()).unwrap(),
        json!({
            "min_payments": 3,
            "min_history_ms": 2_592_000_000u64,
            "base_share_bps": 3000,
            "ladder": ["25000000", "50000000", "100000000", "200000000", "400000000"],
            "fee_bps": 500,
            "min_fee": "1000000",
            "late_after_ms": 3_888_000_000u64,
            "write_off_after_ms": 7_776_000_000u64,
            "reserve_bps": 2000,
            "max_utilization_bps": 8000,
        })
    );
}
