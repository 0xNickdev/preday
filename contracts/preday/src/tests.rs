use near_sdk::json_types::{Base58CryptoHash, U128};
use near_sdk::serde_json::{json, to_value};
use near_sdk::test_utils::VMContextBuilder;
use near_sdk::{
    test_vm_config, testing_env, AccountId, NearToken, PromiseResult, RuntimeFeesConfig,
};

use crate::params::tests::{defaults, DAY_MS};
use crate::params::USDC;
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
const WEEK: u64 = 7 * DAY_MS;
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

fn contract_with(params: Params) -> Preday {
    at(OWNER, 0);
    Preday::new(
        id(TOKEN),
        id(VERIFIER),
        Base58CryptoHash::from([9; 32]),
        params,
        DELAY_MS,
    )
}

fn contract() -> Preday {
    contract_with(defaults())
}

fn register(contract: &mut Preday, owner: &str, handle: &str) {
    testing_env!(context(owner, 0).attached_deposit(REGISTER_DEPOSIT).build());
    contract.register(handle.to_string()).detach();
    in_callback(0, true);
    assert!(contract.on_registered(handle.to_string(), id(owner)));
}

fn verify(contract: &mut Preday, handle: &str, person: u8) {
    verify_at(contract, handle, person, 0);
}

fn verify_at(contract: &mut Preday, handle: &str, person: u8, now_ms: u64) {
    at(VERIFIER, now_ms);
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

fn deposit_at(contract: &mut Preday, lp: &str, amount: u128, now_ms: u64) {
    transfer(contract, lp, amount, r#"{"deposit":true}"#, now_ms);
}

fn deposit(contract: &mut Preday, lp: &str, amount: u128) {
    deposit_at(contract, lp, amount, 0);
}

/// Opens an advance at `now_ms` and repays it in full a week later.
fn cycle(contract: &mut Preday, amount: u128, now_ms: u64) {
    advance(contract, ANNA, "anna", amount, now_ms);
    income(contract, "anna", PAYCHECK, now_ms + WEEK);
}

fn expire(contract: &mut Preday, handle: &str, now_ms: u64) {
    at(BORIS, now_ms);
    contract.write_off(handle.to_string());
}

/// Requests an advance and returns its id, leaving the payout unresolved.
fn request(contract: &mut Preday, owner: &str, handle: &str, amount: u128, now_ms: u64) -> u64 {
    at(owner, now_ms);
    contract.request_advance(U128(amount)).detach();
    worker(contract, handle).advance.unwrap().id
}

/// Resolves the payout of advance `id`.
fn settle(
    contract: &mut Preday,
    handle: &str,
    id: u64,
    amount: u128,
    now_ms: u64,
    ok: bool,
) -> bool {
    in_callback(now_ms, ok);
    let fee = U128(contract.get_params().fee(amount));
    contract.on_advance_sent(handle.to_string(), id, U128(amount), fee)
}

fn advance(contract: &mut Preday, owner: &str, handle: &str, amount: u128, now_ms: u64) {
    let id = request(contract, owner, handle, amount, now_ms);
    assert!(settle(contract, handle, id, amount, now_ms, true));
}

fn activity(
    contract: &Preday,
    handle: &str,
    from: u32,
    limit: u32,
) -> Vec<(String, u128, u128, u64)> {
    to_value(contract.get_activity(handle.to_string(), from, limit))
        .unwrap()
        .as_array()
        .unwrap()
        .iter()
        .map(|entry| {
            let number = |field: &str| entry[field].as_str().unwrap().parse().unwrap();
            (
                entry["kind"].as_str().unwrap().to_string(),
                number("amount"),
                number("fee"),
                entry["at"].as_u64().unwrap(),
            )
        })
        .collect()
}

fn pool(contract: &Preday) -> near_sdk::serde_json::Value {
    to_value(contract.get_pool()).unwrap()
}

/// Registers and verifies a worker with three paychecks at time zero.
fn onboard(contract: &mut Preday, owner: &str, handle: &str, person: u8) {
    register(contract, owner, handle);
    verify(contract, handle, person);
    for _ in 0..3 {
        income(contract, handle, PAYCHECK, 0);
    }
}

/// Anna: registered, verified, three paychecks at time zero. The pool holds
/// 1000 USDC from LP, whose 999 USDC of shares unlocked long before `MATURE`.
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
            "register_deposit": "35000000000000000000000",
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
#[should_panic(expected = "params_delay_ms cannot be shorter than 60000")]
fn new_requires_a_real_timelock() {
    at(OWNER, 0);
    Preday::new(
        id(TOKEN),
        id(VERIFIER),
        Base58CryptoHash::from([9; 32]),
        defaults(),
        59_999,
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
            "activity_count": 0,
            "recovery": "0",
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
        .attached_deposit(NearToken::from_millinear(34))
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
fn income_is_recorded_in_the_activity_log() {
    let mut contract = contract();
    register(&mut contract, ANNA, "anna");
    income(&mut contract, "anna", 10 * USDC, 1000);
    income(&mut contract, "anna", 20 * USDC, 2000);
    income(&mut contract, "anna", 30 * USDC, 3000);

    let anna = worker(&contract, "anna");
    assert_eq!(anna.payments_count, 3);
    assert_eq!(anna.activity_count, 3);
    assert_eq!(anna.first_payment_at, Some(1000));
    assert_eq!(anna.total_received, U128(60 * USDC));
    assert_eq!(
        to_value(contract.get_activity("anna".to_string(), 0, 2)).unwrap(),
        json!([
            { "kind": "payment", "amount": "10000000", "fee": "0", "at": 1000 },
            { "kind": "payment", "amount": "20000000", "fee": "0", "at": 2000 },
        ])
    );
    assert_eq!(
        activity(&contract, "anna", 2, 20),
        vec![("payment".to_string(), 30 * USDC, 0, 3000)]
    );
    assert!(activity(&contract, "anna", 3, 20).is_empty());
    assert!(activity(&contract, "ghost", 0, 20).is_empty());
    assert_eq!(pool(&contract)["assets"], "0");
}

#[test]
fn income_below_the_minimum_payment_is_forwarded_but_not_recorded() {
    let mut contract = funded();
    at(ANNA, MATURE);
    let before = contract.get_limit("anna".to_string());

    income(&mut contract, "anna", 1, MATURE);
    income(&mut contract, "anna", 10 * USDC - 1, MATURE);

    let anna = worker(&contract, "anna");
    assert_eq!(anna.payments_count, 3);
    assert_eq!(anna.activity_count, 3);
    assert_eq!(anna.first_payment_at, Some(0));
    assert_eq!(anna.total_received, U128(3 * PAYCHECK + 10 * USDC));
    at(ANNA, MATURE);
    assert_eq!(contract.get_limit("anna".to_string()), before);
    assert_eq!(before.limit, U128(25 * USDC));
}

#[test]
fn dust_before_the_first_payment_does_not_start_the_history() {
    let mut contract = contract();
    register(&mut contract, ANNA, "anna");
    income(&mut contract, "anna", USDC, 500);
    let anna = worker(&contract, "anna");
    assert_eq!(anna.first_payment_at, None);
    assert_eq!(anna.payments_count, 0);
    income(&mut contract, "anna", 10 * USDC, 900);
    assert_eq!(worker(&contract, "anna").first_payment_at, Some(900));
}

#[test]
fn activity_log_keeps_the_latest_twenty_entries() {
    let mut contract = contract();
    register(&mut contract, ANNA, "anna");
    for index in 0..47u64 {
        income(
            &mut contract,
            "anna",
            (10 + u128::from(index)) * USDC,
            index,
        );
    }
    assert_eq!(worker(&contract, "anna").activity_count, 47);

    let latest = activity(&contract, "anna", 0, 20);
    assert_eq!(latest.len(), 20);
    let times: Vec<u64> = latest.iter().map(|entry| entry.3).collect();
    assert_eq!(times, (27..47).collect::<Vec<u64>>());
    assert_eq!(latest[0].1, 37 * USDC);

    assert_eq!(activity(&contract, "anna", 26, 20), latest);
    assert_eq!(activity(&contract, "anna", 27, u32::MAX), latest);
    let tail: Vec<u64> = activity(&contract, "anna", 44, 20)
        .iter()
        .map(|entry| entry.3)
        .collect();
    assert_eq!(tail, vec![44, 45, 46]);
    let page: Vec<u64> = activity(&contract, "anna", 30, 5)
        .iter()
        .map(|entry| entry.3)
        .collect();
    assert_eq!(page, vec![30, 31, 32, 33, 34]);
    assert!(activity(&contract, "anna", 47, 20).is_empty());
    assert!(activity(&contract, "anna", 30, 0).is_empty());
}

#[test]
fn activity_log_tells_the_story_of_an_advance() {
    let mut contract = funded();
    advance(&mut contract, ANNA, "anna", 25 * USDC, MATURE);
    income(&mut contract, "anna", 10 * USDC, MATURE + DAY_MS);
    income(&mut contract, "anna", USDC, MATURE + 2 * DAY_MS);
    income(&mut contract, "anna", PAYCHECK, MATURE + WEEK);

    let story: Vec<(String, u128, u128, u64)> = activity(&contract, "anna", 3, 20);
    let entry = |kind: &str, amount, fee, at| (kind.to_string(), amount, fee, at);
    assert_eq!(
        story,
        vec![
            entry("advance", 25 * USDC, 1_250_000, MATURE),
            entry("payment", 10 * USDC, 0, MATURE + DAY_MS),
            entry("repayment", 10 * USDC, 0, MATURE + DAY_MS),
            entry("payment", PAYCHECK, 0, MATURE + WEEK),
            entry("repayment", 14 * USDC, 1_250_000, MATURE + WEEK),
            entry("closed", 25 * USDC, 1_250_000, MATURE + WEEK),
        ]
    );
    assert_eq!(worker(&contract, "anna").activity_count, 9);

    advance(&mut contract, ANNA, "anna", 30 * USDC, MATURE + WEEK);
    at(BORIS, MATURE + WEEK + 45 * DAY_MS);
    contract.mark_late("anna".to_string());
    at(BORIS, MATURE + WEEK + 90 * DAY_MS);
    contract.write_off("anna".to_string());
    assert_eq!(
        activity(&contract, "anna", 9, 20),
        vec![
            entry("advance", 30 * USDC, 1_500_000, MATURE + WEEK),
            entry("late", 0, 0, MATURE + WEEK + 45 * DAY_MS),
            entry("written_off", 30 * USDC, 0, MATURE + WEEK + 90 * DAY_MS),
        ]
    );
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
#[should_panic(expected = "amount is below the minimum advance")]
fn advance_cannot_be_smaller_than_the_minimum() {
    let mut contract = funded();
    at(ANNA, MATURE);
    contract.request_advance(U128(USDC - 1)).detach();
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
            "id": 1,
            "principal": "25000000",
            "fee": "1250000",
            "repaid": "0",
            "opened_at": MATURE,
            "touched_at": MATURE,
            "late": false,
        })
    );
    assert_eq!(
        pool(&contract),
        json!({
            "assets": "1000000000",
            "lent": "25000000",
            "lent_to_newcomers": "25000000",
            "reserve": "0",
            "total_shares": "1000000000",
            "advanced": "25000000",
            "repaid": "0",
            "fees": "0",
            "written_off": "0",
            "recovered": "0",
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
fn every_advance_gets_its_own_id() {
    let mut contract = funded();
    let first = request(&mut contract, ANNA, "anna", 25 * USDC, MATURE);
    assert!(!settle(
        &mut contract,
        "anna",
        first,
        25 * USDC,
        MATURE,
        false
    ));
    let second = request(&mut contract, ANNA, "anna", 25 * USDC, MATURE);
    assert!(settle(
        &mut contract,
        "anna",
        second,
        25 * USDC,
        MATURE,
        true
    ));
    income(&mut contract, "anna", PAYCHECK, MATURE);
    let third = request(&mut contract, ANNA, "anna", 25 * USDC, MATURE);
    assert_eq!((first, second, third), (1, 2, 3));
}

#[test]
fn failed_advance_payout_rolls_everything_back() {
    let mut contract = funded();
    let id = request(&mut contract, ANNA, "anna", 25 * USDC, MATURE);
    assert!(!settle(&mut contract, "anna", id, 25 * USDC, MATURE, false));

    let anna = worker(&contract, "anna");
    assert!(anna.advance.is_none());
    assert_eq!(anna.pending, U128(0));
    assert_eq!(anna.activity_count, 3);
    let pool = pool(&contract);
    assert_eq!(pool["lent"], "0");
    assert_eq!(pool["lent_to_newcomers"], "0");
    assert_eq!(pool["advanced"], "0");
    assert_eq!(pool["advances_count"], 0);
    at(ANNA, MATURE);
    assert!(contract.get_limit("anna".to_string()).eligible);
}

#[test]
fn failed_advance_payout_after_a_repayment_becomes_claimable() {
    let mut contract = funded();
    let id = request(&mut contract, ANNA, "anna", 25 * USDC, MATURE);
    income(&mut contract, "anna", 10 * USDC, MATURE);
    assert!(!settle(&mut contract, "anna", id, 25 * USDC, MATURE, false));

    let anna = worker(&contract, "anna");
    assert_eq!(anna.advance.unwrap().repaid, U128(10 * USDC));
    assert_eq!(anna.pending, U128(25 * USDC));
    assert_eq!(pool(&contract)["lent"], "15000000");
}

#[test]
fn failed_payout_of_a_closed_advance_cannot_cancel_the_next_one() {
    let mut contract = funded();
    let first = request(&mut contract, ANNA, "anna", USDC, MATURE);
    income(&mut contract, "anna", PAYCHECK, MATURE);
    assert!(worker(&contract, "anna").advance.is_none());
    let second = request(&mut contract, ANNA, "anna", 25 * USDC, MATURE);

    assert!(!settle(
        &mut contract,
        "anna",
        first,
        USDC,
        MATURE + 1,
        false
    ));
    let anna = worker(&contract, "anna");
    assert_eq!(anna.advance.as_ref().unwrap().id, second);
    assert_eq!(anna.pending, U128(USDC));
    assert_eq!(pool(&contract)["lent"], "25000000");

    assert!(settle(
        &mut contract,
        "anna",
        second,
        25 * USDC,
        MATURE + 1,
        true
    ));
    let anna = worker(&contract, "anna");
    let open = anna.advance.unwrap();
    assert_eq!((open.principal, open.repaid), (U128(25 * USDC), U128(0)));
    assert_eq!(anna.pending, U128(USDC));
    assert_eq!(pool(&contract)["lent"], "25000000");
}

#[test]
fn two_failed_payouts_in_one_block_leave_no_free_money() {
    let mut contract = funded();
    let first = request(&mut contract, ANNA, "anna", USDC, MATURE);
    income(&mut contract, "anna", PAYCHECK, MATURE);
    let second = request(&mut contract, ANNA, "anna", 25 * USDC, MATURE);

    assert!(!settle(
        &mut contract,
        "anna",
        first,
        USDC,
        MATURE + 1,
        false
    ));
    assert!(!settle(
        &mut contract,
        "anna",
        second,
        25 * USDC,
        MATURE + 1,
        false
    ));

    let anna = worker(&contract, "anna");
    assert!(anna.advance.is_none());
    assert_eq!(
        anna.pending,
        U128(USDC),
        "only the principal already repaid is owed back"
    );
    let pool = pool(&contract);
    assert_eq!(pool["lent"], "0");
    assert_eq!(pool["advanced"], "1000000");
    assert_eq!(pool["repaid"], "1000000");
    assert_eq!(pool["advances_count"], 1);
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
    let partial = pool(&contract);
    assert_eq!(partial["lent"], "15000000");
    assert_eq!(partial["repaid"], "10000000");
    assert_eq!(partial["fees"], "0");
    assert_eq!(partial["assets"], "1000000000");

    income(&mut contract, "anna", PAYCHECK, MATURE + WEEK);
    let anna = worker(&contract, "anna");
    assert!(anna.advance.is_none());
    assert_eq!(anna.level, 1);
    assert_eq!(anna.payments_count, 5);
    assert_eq!(
        pool(&contract),
        json!({
            "assets": "1001000000",
            "lent": "0",
            "lent_to_newcomers": "0",
            "reserve": "250000",
            "total_shares": "1000000000",
            "advanced": "25000000",
            "repaid": "25000000",
            "fees": "1250000",
            "written_off": "0",
            "recovered": "0",
            "advances_count": 1,
        })
    );
}

#[test]
fn dust_income_still_repays_an_advance() {
    let mut contract = funded();
    advance(&mut contract, ANNA, "anna", 25 * USDC, MATURE);
    income(&mut contract, "anna", 9 * USDC, MATURE + DAY_MS);

    let anna = worker(&contract, "anna");
    let open = anna.advance.unwrap();
    assert_eq!(open.repaid, U128(9 * USDC));
    assert_eq!(open.touched_at, MATURE);
    assert_eq!(anna.payments_count, 3);
    assert_eq!(anna.activity_count, 4);
    assert_eq!(pool(&contract)["lent"], "16000000");
}

#[test]
fn level_grows_with_each_seasoned_advance_up_to_the_top() {
    let mut contract = funded();
    for round in 0..6u64 {
        let now = MATURE + round * 8 * DAY_MS;
        at(ANNA, now);
        let limit = contract.get_limit("anna".to_string()).limit.0;
        cycle(&mut contract, limit, now);
    }
    assert_eq!(worker(&contract, "anna").level, 4);
}

#[test]
fn repayment_before_the_seasoning_period_earns_no_level() {
    let mut contract = funded();
    advance(&mut contract, ANNA, "anna", 25 * USDC, MATURE);
    income(&mut contract, "anna", PAYCHECK, MATURE + WEEK - 1);
    let anna = worker(&contract, "anna");
    assert!(anna.advance.is_none());
    assert_eq!(anna.level, 0);
}

#[test]
fn advance_under_half_the_limit_earns_no_level() {
    let mut contract = funded();
    cycle(&mut contract, 12_499_999, MATURE);
    assert_eq!(worker(&contract, "anna").level, 0);
    cycle(&mut contract, 12_500_000, MATURE + WEEK);
    assert_eq!(worker(&contract, "anna").level, 1);
}

#[test]
fn ladder_cannot_be_climbed_with_instant_minimum_advances() {
    let mut contract = funded();
    for _ in 0..4 {
        advance(&mut contract, ANNA, "anna", USDC, MATURE);
        income(&mut contract, "anna", 1334 * USDC, MATURE);
    }
    assert_eq!(worker(&contract, "anna").level, 0);
    at(ANNA, MATURE);
    assert_eq!(
        contract.get_limit("anna".to_string()).limit,
        U128(25 * USDC)
    );
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
    cycle(&mut contract, 25 * USDC, MATURE);
    assert_eq!(worker(&contract, "anna").level, 1);

    let opened = MATURE + WEEK;
    advance(&mut contract, ANNA, "anna", 30 * USDC, opened);
    income(&mut contract, "anna", 10 * USDC, opened + DAY_MS);
    at(BORIS, opened + 46 * DAY_MS);
    contract.mark_late("anna".to_string());
    let anna = worker(&contract, "anna");
    assert!(anna.advance.unwrap().late);
    assert_eq!(anna.level, 0);

    income(&mut contract, "anna", PAYCHECK, opened + 50 * DAY_MS);
    let anna = worker(&contract, "anna");
    assert!(anna.advance.is_none());
    assert_eq!(anna.level, 0);
    assert!(!anna.banned);
}

#[test]
#[should_panic(expected = "advance is not late yet")]
fn mark_late_counts_from_the_last_recorded_repayment() {
    let mut contract = funded();
    advance(&mut contract, ANNA, "anna", 25 * USDC, MATURE);
    income(&mut contract, "anna", 10 * USDC, MATURE + DAY_MS);
    at(BORIS, MATURE + 45 * DAY_MS);
    contract.mark_late("anna".to_string());
}

#[test]
fn dust_cannot_keep_an_advance_from_going_late() {
    let mut contract = funded();
    advance(&mut contract, ANNA, "anna", 25 * USDC, MATURE);
    for day in [10, 20, 30, 44] {
        income(&mut contract, "anna", 1, MATURE + day * DAY_MS);
        income(&mut contract, "anna", USDC, MATURE + day * DAY_MS);
    }
    let open = worker(&contract, "anna").advance.unwrap();
    assert_eq!(open.touched_at, MATURE);
    assert_eq!(open.repaid, U128(4 * (USDC + 1)));

    at(BORIS, MATURE + 45 * DAY_MS);
    contract.mark_late("anna".to_string());
    assert!(worker(&contract, "anna").advance.unwrap().late);
}

#[test]
fn dust_cannot_keep_an_advance_from_being_written_off() {
    let mut contract = funded();
    advance(&mut contract, ANNA, "anna", 25 * USDC, MATURE);
    income(&mut contract, "anna", 1, MATURE + 44 * DAY_MS);
    income(&mut contract, "anna", 1, MATURE + 89 * DAY_MS);

    expire(&mut contract, "anna", MATURE + 90 * DAY_MS);
    assert!(worker(&contract, "anna").banned);
    assert_eq!(pool(&contract)["written_off"], "24999998");
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
    cycle(&mut contract, 25 * USDC, MATURE);
    let opened = MATURE + WEEK;
    advance(&mut contract, ANNA, "anna", 30 * USDC, opened);
    income(&mut contract, "anna", 10 * USDC, opened + DAY_MS);

    expire(&mut contract, "anna", opened + 91 * DAY_MS);

    let anna = worker(&contract, "anna");
    assert!(anna.advance.is_none());
    assert!(anna.banned);
    assert_eq!(anna.level, 0);
    assert_eq!(
        pool(&contract),
        json!({
            "assets": "981250000",
            "lent": "0",
            "lent_to_newcomers": "0",
            "reserve": "0",
            "total_shares": "1000000000",
            "advanced": "55000000",
            "repaid": "35000000",
            "fees": "1250000",
            "written_off": "20000000",
            "recovered": "0",
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
fn write_off_counts_from_the_last_recorded_repayment() {
    let mut contract = funded();
    advance(&mut contract, ANNA, "anna", 25 * USDC, MATURE);
    income(&mut contract, "anna", 10 * USDC, MATURE + DAY_MS);
    expire(&mut contract, "anna", MATURE + 90 * DAY_MS);
}

#[test]
#[should_panic(expected = "not eligible: banned")]
fn banned_workers_get_no_advance() {
    let mut contract = funded();
    advance(&mut contract, ANNA, "anna", 25 * USDC, MATURE);
    expire(&mut contract, "anna", MATURE + 90 * DAY_MS);
    at(ANNA, MATURE + 91 * DAY_MS);
    contract.request_advance(U128(USDC)).detach();
}

#[test]
#[should_panic(expected = "person is banned")]
fn banned_person_cannot_verify_another_handle() {
    let mut contract = funded();
    advance(&mut contract, ANNA, "anna", 25 * USDC, MATURE);
    expire(&mut contract, "anna", MATURE + 90 * DAY_MS);
    register(&mut contract, BORIS, "boris");
    verify(&mut contract, "boris", 1);
}

#[test]
fn deposits_mint_shares_at_the_share_price() {
    let mut contract = funded();
    assert_eq!(contract.get_shares(id(LP)), U128(999 * USDC));
    cycle(&mut contract, 25 * USDC, MATURE);

    deposit(&mut contract, BORIS, 1001 * USDC);
    assert_eq!(contract.get_shares(id(BORIS)), U128(1000 * USDC));
    deposit(&mut contract, BORIS, 1001 * USDC);
    assert_eq!(contract.get_shares(id(BORIS)), U128(2000 * USDC));
    assert_eq!(contract.get_shares(id(ANNA)), U128(0));
}

#[test]
#[should_panic(expected = "deposit is below the minimum")]
fn deposits_have_a_minimum() {
    let mut contract = funded();
    deposit(&mut contract, BORIS, USDC - 1);
}

#[test]
#[should_panic(expected = "first deposit must exceed the locked minimum")]
fn first_deposit_must_exceed_the_locked_shares() {
    let mut contract = contract();
    deposit(&mut contract, LP, USDC);
}

#[test]
fn lp_view_shows_the_position_and_its_lock() {
    let mut contract = funded();
    assert_eq!(
        to_value(contract.get_lp(id(LP))).unwrap(),
        json!({ "shares": "999000000", "unlocks_at": WEEK })
    );
    assert_eq!(
        to_value(contract.get_lp(id(BORIS))).unwrap(),
        json!({ "shares": "0", "unlocks_at": 0 })
    );

    deposit_at(&mut contract, LP, 10 * USDC, MATURE);
    assert_eq!(
        to_value(contract.get_lp(id(LP))).unwrap(),
        json!({ "shares": "1009000000", "unlocks_at": MATURE + WEEK })
    );
}

#[test]
fn withdraw_burns_shares_for_assets() {
    let mut contract = funded();
    cycle(&mut contract, 25 * USDC, MATURE);
    let now = MATURE + WEEK;

    at(LP, now);
    contract.withdraw(U128(400 * USDC)).detach();
    assert_eq!(contract.get_shares(id(LP)), U128(599 * USDC));
    let after = pool(&contract);
    assert_eq!(after["assets"], "600600000");
    assert_eq!(after["total_shares"], "600000000");

    in_callback(now, false);
    assert!(!contract.on_withdraw_sent(id(LP), 0, U128(400 * USDC), U128(400_400_000)));
    assert_eq!(contract.get_shares(id(LP)), U128(999 * USDC));
    let restored = pool(&contract);
    assert_eq!(restored["assets"], "1001000000");
    assert_eq!(restored["total_shares"], "1000000000");

    at(LP, now);
    contract.withdraw(U128(999 * USDC)).detach();
    in_callback(now, true);
    assert!(contract.on_withdraw_sent(id(LP), 0, U128(999 * USDC), U128(999_999_000)));
    assert_eq!(contract.get_shares(id(LP)), U128(0));
    let drained = pool(&contract);
    assert_eq!(drained["assets"], "1001000");
    assert_eq!(drained["total_shares"], "1000000");
    assert_eq!(drained["reserve"], "250000");
}

#[test]
#[should_panic(expected = "not enough shares")]
fn withdraw_is_limited_to_own_shares() {
    let mut contract = funded();
    deposit(&mut contract, BORIS, 10 * USDC);
    at(BORIS, WEEK);
    contract.withdraw(U128(10 * USDC + 1)).detach();
}

#[test]
#[should_panic(expected = "not enough liquid funds")]
fn withdraw_cannot_touch_lent_funds() {
    let mut contract = funded();
    advance(&mut contract, ANNA, "anna", 25 * USDC, MATURE);
    at(LP, MATURE);
    contract.withdraw(U128(999 * USDC)).detach();
}

#[test]
#[should_panic(expected = "shares are still locked")]
fn deposit_made_to_capture_a_fee_cannot_leave_right_away() {
    let mut contract = funded();
    advance(&mut contract, ANNA, "anna", 25 * USDC, MATURE);
    deposit_at(&mut contract, BORIS, 99_000 * USDC, MATURE);
    income(&mut contract, "anna", PAYCHECK, MATURE + DAY_MS);
    at(BORIS, MATURE + DAY_MS);
    let shares = contract.get_shares(id(BORIS));
    contract.withdraw(shares).detach();
}

#[test]
fn shares_unlock_after_the_withdraw_delay() {
    let mut contract = funded();
    deposit_at(&mut contract, BORIS, 100 * USDC, MATURE);
    at(BORIS, MATURE + WEEK);
    contract.withdraw(U128(100 * USDC)).detach();
    assert_eq!(contract.get_shares(id(BORIS)), U128(0));
}

#[test]
#[should_panic(expected = "shares are still locked")]
fn a_new_deposit_locks_the_whole_position_again() {
    let mut contract = funded();
    deposit_at(&mut contract, LP, 10 * USDC, MATURE);
    at(LP, MATURE + WEEK - 1);
    contract.withdraw(U128(USDC)).detach();
}

/// One newcomer advance of 25 USDC against a 62.5 USDC pool whose LP then
/// takes `withdrawn` of the liquid rest out.
fn lone_advance(withdrawn: u128) -> Preday {
    let mut contract = contract_with(Params {
        newcomer_exposure_bps: 5000,
        ..defaults()
    });
    onboard(&mut contract, ANNA, "anna", 1);
    deposit(&mut contract, LP, 62_500_000);
    advance(&mut contract, ANNA, "anna", 25 * USDC, MATURE);
    at(LP, MATURE);
    contract.withdraw(U128(withdrawn)).detach();
    contract
}

/// The LP leaves nothing but the advance in the pool and the advance is
/// never repaid: the pool is wiped out.
fn wiped_out() -> Preday {
    lone_advance(37_500_000)
}

#[test]
fn total_loss_retires_old_shares_and_keeps_deposits_open() {
    let mut contract = wiped_out();
    assert_eq!(contract.get_shares(id(LP)), U128(24 * USDC));
    expire(&mut contract, "anna", MATURE + 90 * DAY_MS);
    let empty = pool(&contract);
    assert_eq!(empty["assets"], "0");
    assert_eq!(empty["total_shares"], "0");
    assert_eq!(contract.get_shares(id(LP)), U128(0));

    deposit_at(&mut contract, BORIS, 1000 * USDC, MATURE + 90 * DAY_MS);
    assert_eq!(contract.get_shares(id(BORIS)), U128(999 * USDC));
    assert_eq!(contract.get_shares(id(LP)), U128(0));
    let fresh = pool(&contract);
    assert_eq!(fresh["assets"], "1000000000");
    assert_eq!(fresh["total_shares"], "1000000000");

    at(BORIS, MATURE + 97 * DAY_MS);
    contract.withdraw(U128(999 * USDC)).detach();
    assert_eq!(pool(&contract)["assets"], "1000000");
}

#[test]
#[should_panic(expected = "not enough shares")]
fn retired_shares_cannot_be_withdrawn() {
    let mut contract = wiped_out();
    expire(&mut contract, "anna", MATURE + 90 * DAY_MS);
    deposit_at(&mut contract, BORIS, 1000 * USDC, MATURE + 90 * DAY_MS);
    at(LP, MATURE + 97 * DAY_MS);
    contract.withdraw(U128(24 * USDC)).detach();
}

#[test]
fn failed_withdrawal_from_a_retired_epoch_goes_to_the_reserve() {
    let mut contract = wiped_out();
    expire(&mut contract, "anna", MATURE + 90 * DAY_MS);
    in_callback(MATURE + 90 * DAY_MS, false);
    assert!(!contract.on_withdraw_sent(id(LP), 0, U128(6_250_000), U128(6_250_000)));
    let after = pool(&contract);
    assert_eq!(after["reserve"], "6250000");
    assert_eq!(after["assets"], "0");
    assert_eq!(after["total_shares"], "0");
    assert_eq!(contract.get_shares(id(LP)), U128(0));
}

#[test]
fn near_total_loss_retires_the_shares_too() {
    let mut contract = lone_advance(37_490_000);
    assert_eq!(pool(&contract)["assets"], "25010000");
    expire(&mut contract, "anna", MATURE + 90 * DAY_MS);

    let emptied = pool(&contract);
    assert_eq!(emptied["assets"], "0");
    assert_eq!(emptied["total_shares"], "0");
    assert_eq!(emptied["reserve"], "10000");
    assert_eq!(contract.get_shares(id(LP)), U128(0));

    deposit_at(&mut contract, BORIS, 1000 * USDC, MATURE + 90 * DAY_MS);
    assert_eq!(contract.get_shares(id(BORIS)), U128(999 * USDC));
    assert_eq!(pool(&contract)["total_shares"], "1000000000");
}

#[test]
fn written_off_debt_is_recovered_from_later_income() {
    let mut contract = funded();
    advance(&mut contract, ANNA, "anna", 25 * USDC, MATURE);
    let lost_at = MATURE + 90 * DAY_MS;
    expire(&mut contract, "anna", lost_at);
    assert_eq!(worker(&contract, "anna").recovery, U128(26_250_000));
    let lost = pool(&contract);
    assert_eq!(lost["assets"], "975000000");
    assert_eq!(lost["lent_to_newcomers"], "0");

    income(&mut contract, "anna", 10 * USDC, lost_at + 1);
    assert_eq!(worker(&contract, "anna").recovery, U128(16_250_000));
    assert_eq!(pool(&contract)["assets"], "985000000");

    income(&mut contract, "anna", 1, lost_at + 2);
    assert_eq!(worker(&contract, "anna").recovery, U128(16_249_999));
    assert_eq!(pool(&contract)["assets"], "985000001");

    income(&mut contract, "anna", PAYCHECK, lost_at + 3);
    let anna = worker(&contract, "anna");
    assert_eq!(anna.recovery, U128(0));
    assert!(anna.banned);
    let healed = pool(&contract);
    assert_eq!(healed["assets"], "1000000000");
    assert_eq!(healed["reserve"], "1250000");
    assert_eq!(healed["recovered"], "26250000");
    assert_eq!(healed["written_off"], "25000000");

    let entry = |kind: &str, amount, at| (kind.to_string(), amount, 0, at);
    assert_eq!(
        activity(&contract, "anna", 4, 20),
        vec![
            entry("written_off", 25 * USDC, lost_at),
            entry("payment", 10 * USDC, lost_at + 1),
            entry("recovered", 10 * USDC, lost_at + 1),
            entry("recovered", 1, lost_at + 2),
            entry("payment", PAYCHECK, lost_at + 3),
            entry("recovered", 16_249_999, lost_at + 3),
        ]
    );

    income(&mut contract, "anna", PAYCHECK, lost_at + 4);
    assert_eq!(pool(&contract)["recovered"], "26250000");
    assert_eq!(worker(&contract, "anna").activity_count, 11);
    at(ANNA, lost_at + 4);
    assert_eq!(
        contract.get_limit("anna".to_string()).reason,
        Some(Ineligible::Banned)
    );
}

#[test]
fn recovery_repays_lp_assets_before_the_reserve() {
    let mut contract = funded();
    cycle(&mut contract, 25 * USDC, MATURE);
    let opened = MATURE + WEEK;
    advance(&mut contract, ANNA, "anna", 30 * USDC, opened);
    expire(&mut contract, "anna", opened + 90 * DAY_MS);
    let lost = pool(&contract);
    assert_eq!(lost["assets"], "971250000");
    assert_eq!(lost["reserve"], "0");
    assert_eq!(worker(&contract, "anna").recovery, U128(31_500_000));

    income(&mut contract, "anna", 20 * USDC, opened + 91 * DAY_MS);
    let partial = pool(&contract);
    assert_eq!(partial["assets"], "991250000");
    assert_eq!(partial["reserve"], "0");

    income(&mut contract, "anna", PAYCHECK, opened + 92 * DAY_MS);
    let healed = pool(&contract);
    assert_eq!(healed["assets"], "1001000000");
    assert_eq!(healed["reserve"], "1750000");
    assert_eq!(healed["recovered"], "31500000");
    assert_eq!(worker(&contract, "anna").recovery, U128(0));
}

#[test]
fn recovery_for_a_retired_epoch_goes_to_the_reserve() {
    let mut contract = wiped_out();
    let lost_at = MATURE + 90 * DAY_MS;
    expire(&mut contract, "anna", lost_at);
    deposit_at(&mut contract, BORIS, 1000 * USDC, lost_at);

    income(&mut contract, "anna", 10 * USDC, lost_at + 1);
    income(&mut contract, "anna", PAYCHECK, lost_at + 2);
    let after = pool(&contract);
    assert_eq!(after["assets"], "1000000000");
    assert_eq!(after["reserve"], "26250000");
    assert_eq!(after["recovered"], "26250000");
    assert_eq!(worker(&contract, "anna").recovery, U128(0));
}

#[test]
#[should_panic(expected = "newcomer limit reached")]
fn newcomer_exposure_is_capped() {
    let mut contract = contract();
    onboard(&mut contract, ANNA, "anna", 1);
    onboard(&mut contract, BORIS, "boris", 2);
    deposit(&mut contract, LP, 250 * USDC);
    advance(&mut contract, ANNA, "anna", 25 * USDC, MATURE);
    at(BORIS, MATURE);
    contract.request_advance(U128(USDC)).detach();
}

#[test]
fn newcomer_exposure_frees_up_and_spares_proven_workers() {
    let mut contract = contract();
    onboard(&mut contract, ANNA, "anna", 1);
    onboard(&mut contract, BORIS, "boris", 2);
    deposit(&mut contract, LP, 250 * USDC);
    advance(&mut contract, ANNA, "anna", 25 * USDC, MATURE);
    assert_eq!(pool(&contract)["lent_to_newcomers"], "25000000");

    income(&mut contract, "anna", 10 * USDC, MATURE + DAY_MS);
    assert_eq!(pool(&contract)["lent_to_newcomers"], "15000000");
    advance(&mut contract, BORIS, "boris", 10 * USDC, MATURE + DAY_MS);
    assert_eq!(pool(&contract)["lent_to_newcomers"], "25000000");

    income(&mut contract, "anna", PAYCHECK, MATURE + WEEK);
    assert_eq!(worker(&contract, "anna").level, 1);
    assert_eq!(pool(&contract)["lent_to_newcomers"], "10000000");

    advance(&mut contract, ANNA, "anna", 30 * USDC, MATURE + WEEK);
    let after = pool(&contract);
    assert_eq!(after["lent_to_newcomers"], "10000000");
    assert_eq!(after["lent"], "40000000");
}

#[test]
#[should_panic(expected = "daily verification limit reached")]
fn verifications_are_limited_per_day() {
    let mut contract = contract_with(Params {
        max_verifications_per_day: 2,
        ..defaults()
    });
    register(&mut contract, ANNA, "anna");
    register(&mut contract, BORIS, "boris");
    register(&mut contract, LP, "lena");
    verify_at(&mut contract, "anna", 1, 3 * DAY_MS);
    verify_at(&mut contract, "boris", 2, 4 * DAY_MS - 1);
    verify_at(&mut contract, "lena", 3, 4 * DAY_MS - 1);
}

#[test]
fn verification_limit_resets_on_the_next_day() {
    let mut contract = contract_with(Params {
        max_verifications_per_day: 2,
        ..defaults()
    });
    register(&mut contract, ANNA, "anna");
    register(&mut contract, BORIS, "boris");
    register(&mut contract, LP, "lena");
    verify_at(&mut contract, "anna", 1, 3 * DAY_MS);
    verify_at(&mut contract, "boris", 2, 4 * DAY_MS - 1);
    verify_at(&mut contract, "lena", 3, 4 * DAY_MS);
    assert!(worker(&contract, "lena").verified);
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
#[should_panic(expected = "reserve_bps cannot exceed 5000")]
fn proposed_params_are_validated() {
    let mut contract = contract();
    at(OWNER, 0);
    contract.propose_params(Params {
        reserve_bps: 5001,
        ..defaults()
    });
}

#[test]
#[should_panic(expected = "min_fee cannot exceed 5 USDC")]
fn owner_cannot_propose_a_confiscatory_fee() {
    let mut contract = funded();
    advance(&mut contract, ANNA, "anna", 25 * USDC, MATURE);
    at(OWNER, MATURE);
    contract.propose_params(Params {
        late_after_ms: 1,
        write_off_after_ms: 1,
        min_fee: U128(u128::MAX / 2),
        ..defaults()
    });
}

#[test]
#[should_panic(expected = "write_off_after_ms must be longer than late_after_ms")]
fn owner_cannot_propose_an_instant_write_off() {
    let mut contract = contract();
    at(OWNER, 0);
    contract.propose_params(Params {
        late_after_ms: 1,
        write_off_after_ms: 1,
        ..defaults()
    });
}

#[test]
#[should_panic(expected = "advance cannot be written off yet")]
fn new_params_do_not_shorten_the_terms_of_open_advances() {
    let mut contract = funded();
    advance(&mut contract, ANNA, "anna", 25 * USDC, MATURE);
    at(OWNER, MATURE);
    contract.propose_params(Params {
        late_after_ms: 1,
        write_off_after_ms: 2,
        ..defaults()
    });
    at(BORIS, MATURE + DELAY_MS);
    contract.apply_params();
    assert_eq!(contract.get_params().write_off_after_ms, 2);
    contract.write_off("anna".to_string());
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
            "min_payment": "10000000",
            "seasoning_ms": 604_800_000u64,
            "withdraw_delay_ms": 604_800_000u64,
            "max_verifications_per_day": 50,
            "newcomer_exposure_bps": 1000,
        })
    );
}
