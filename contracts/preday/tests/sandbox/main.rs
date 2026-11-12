mod env;

use anyhow::Result;
use env::{
    Env, HEAVY_GAS, LATE_AFTER_MS, MIN_HISTORY_MS, ONE_YOCTO, PARAMS_DELAY_MS, REGISTER_DEPOSIT,
    SEASONING_MS, USDC, USDC_STORAGE_DEPOSIT, WITHDRAW_DELAY_MS, WRITE_OFF_AFTER_MS,
};
use near_workspaces::result::ExecutionFinalResult;
use near_workspaces::types::NearToken;
use near_workspaces::ContractState;
use serde_json::json;

/// Asserts that some receipt of the transaction failed with `message`.
fn assert_failed_with(result: &ExecutionFinalResult, message: &str) {
    let failures = format!("{:?}", result.failures());
    assert!(
        failures.contains(message),
        "expected `{message}` in {failures}"
    );
}

fn assert_all_succeeded(result: &ExecutionFinalResult) {
    assert!(
        result.is_success() && result.failures().is_empty(),
        "{result:?}"
    );
}

async fn activity_kinds(env: &Env, handle: &str) -> Result<Vec<String>> {
    let entries = env
        .view(
            "get_activity",
            json!({ "handle": handle, "from": 0, "limit": 20 }),
        )
        .await?;
    Ok(entries
        .as_array()
        .unwrap()
        .iter()
        .map(|entry| entry["kind"].as_str().unwrap().to_string())
        .collect())
}

fn burnt(result: &ExecutionFinalResult) -> NearToken {
    result
        .outcomes()
        .iter()
        .fold(NearToken::ZERO, |total, outcome| {
            total.saturating_add(outcome.tokens_burnt)
        })
}

#[tokio::test]
async fn register_creates_keyless_account_on_global_code() -> Result<()> {
    let env = Env::new().await?;
    let anna = env.user().await?;

    let result = env.register(&anna, "anna").await?;
    assert_all_succeeded(&result);

    let named = env.named("anna");
    let details = env.worker.view_account(&named).await?;
    let ContractState::GlobalHash(code_hash) = details.contract_state else {
        panic!(
            "named account is not on global code: {:?}",
            details.contract_state
        );
    };
    assert_eq!(code_hash.to_string(), env.account_code);
    assert!(env.worker.view_access_keys(&named).await?.is_empty());

    for account_id in [&named, anna.id()] {
        let storage: serde_json::Value = env
            .usdc
            .view("storage_balance_of")
            .args_json(json!({ "account_id": account_id }))
            .await?
            .json()?;
        assert!(!storage.is_null(), "{account_id} has no usdc storage");
    }
    assert_eq!(
        env.view("get_handle", json!({ "account_id": anna.id() }))
            .await?,
        "anna"
    );
    assert_eq!(env.get_worker("anna").await?["owner"], anna.id().as_str());

    println!("global code publish cost: {}", env.publish_cost);
    println!(
        "named account: balance {}, storage {} bytes",
        details.balance, details.storage_usage
    );
    println!(
        "register: gas {}, burnt {}",
        result.total_gas_burnt,
        burnt(&result)
    );
    Ok(())
}

#[tokio::test]
async fn register_rejects_bad_requests() -> Result<()> {
    let env = Env::new().await?;
    let anna = env.worker_with_handle("anna").await?;
    let boris = env.user().await?;

    assert_failed_with(&env.register(&boris, "anna").await?, "handle is taken");
    assert_failed_with(
        &env.register(&anna, "anna2").await?,
        "account already has a handle",
    );
    assert_failed_with(&env.register(&boris, "-boris").await?, "invalid handle");
    let underpaid = boris
        .call(env.preday.id(), "register")
        .args_json(json!({ "handle": "boris" }))
        .deposit(REGISTER_DEPOSIT.saturating_sub(ONE_YOCTO))
        .gas(HEAVY_GAS)
        .transact()
        .await?;
    assert_failed_with(&underpaid, "attach exactly the register deposit");

    let init_again = boris
        .call(&env.named("anna"), "new")
        .args(boris.id().as_bytes().to_vec())
        .transact()
        .await?;
    assert_failed_with(&init_again, "only the parent can initialize");
    assert!(env.get_worker("boris").await?.is_null());
    Ok(())
}

#[tokio::test]
async fn sweep_records_income_and_forwards_it() -> Result<()> {
    let env = Env::new().await?;
    let anna = env.worker_with_handle("anna").await?;

    env.mint(&env.named("anna"), 120 * USDC).await?;
    assert_eq!(env.balance(&env.named("anna")).await?, 120 * USDC);
    let sweep = env.sweep("anna").await?;
    assert_all_succeeded(&sweep);
    println!(
        "sweep: gas {}, burnt {}",
        sweep.total_gas_burnt,
        burnt(&sweep)
    );
    assert_eq!(sweep.json::<String>()?, (120 * USDC).to_string());

    assert_eq!(env.balance(&env.named("anna")).await?, 0);
    assert_eq!(env.balance(anna.id()).await?, 120 * USDC);
    assert_eq!(env.balance(env.preday.id()).await?, 0);

    let worker = env.get_worker("anna").await?;
    assert_eq!(worker["payments_count"], 1);
    assert_eq!(worker["total_received"], "120000000");
    assert_eq!(worker["pending"], "0");
    assert_eq!(worker["activity_count"], 1);
    assert_eq!(
        env.view(
            "get_activity",
            json!({ "handle": "anna", "from": 0, "limit": 20 })
        )
        .await?,
        json!([{
            "kind": "payment",
            "amount": "120000000",
            "fee": "0",
            "at": worker["first_payment_at"],
        }])
    );

    env.mint(&env.named("anna"), 9 * USDC).await?;
    assert_all_succeeded(&env.sweep("anna").await?);
    assert_eq!(env.balance(anna.id()).await?, 129 * USDC);
    let worker = env.get_worker("anna").await?;
    assert_eq!(worker["payments_count"], 1);
    assert_eq!(worker["activity_count"], 1);
    assert_eq!(worker["total_received"], "129000000");

    let empty = env.sweep("anna").await?;
    assert_all_succeeded(&empty);
    assert_eq!(empty.json::<String>()?, "0");
    assert_eq!(env.get_worker("anna").await?["payments_count"], 1);
    Ok(())
}

#[tokio::test]
async fn advance_is_repaid_from_income_and_grows_the_pool() -> Result<()> {
    let env = Env::new().await?;
    let lp = env.lp_with_deposit(1000 * USDC).await?;
    assert_eq!(
        env.view("get_shares", json!({ "account_id": lp.id() }))
            .await?,
        "999000000"
    );

    let anna = env.worker_with_handle("anna").await?;
    for _ in 0..3 {
        env.pay("anna", 100 * USDC).await?.into_result()?;
    }
    assert_eq!(env.balance(anna.id()).await?, 300 * USDC);
    let limit = env.view("get_limit", json!({ "handle": "anna" })).await?;
    assert_eq!(limit["reason"], "not_verified");

    assert_all_succeeded(&env.verify(&anna, "anna").await?);
    let limit = env.view("get_limit", json!({ "handle": "anna" })).await?;
    assert_eq!(limit["reason"], "short_history");
    env.advance_time(MIN_HISTORY_MS).await?;
    assert_eq!(
        env.view("get_limit", json!({ "handle": "anna" })).await?,
        json!({ "eligible": true, "limit": "25000000", "base": "100000000", "reason": null })
    );

    let advance = env.request_advance(&anna, 25 * USDC).await?;
    assert_all_succeeded(&advance);
    println!(
        "request_advance: gas {}, burnt {}",
        advance.total_gas_burnt,
        burnt(&advance)
    );
    assert_eq!(env.balance(anna.id()).await?, 325 * USDC);
    let open = env.get_worker("anna").await?["advance"].clone();
    assert_eq!(open["id"], 1);
    assert_eq!(open["principal"], "25000000");
    assert_eq!(open["fee"], "1250000");
    assert_eq!(open["repaid"], "0");
    assert_eq!(open["late"], false);
    assert_eq!(env.get_pool().await?["lent"], "25000000");

    env.pay("anna", 10 * USDC).await?.into_result()?;
    assert_eq!(env.balance(anna.id()).await?, 325 * USDC);
    let open = env.get_worker("anna").await?["advance"].clone();
    assert_eq!(open["repaid"], "10000000");
    assert!(open["touched_at"].as_u64() > open["opened_at"].as_u64());
    assert_eq!(env.get_pool().await?["lent"], "15000000");

    env.advance_time(SEASONING_MS).await?;
    let repay = env.pay("anna", 100 * USDC).await?;
    println!(
        "sweep with repayment: gas {}, burnt {}",
        repay.total_gas_burnt,
        burnt(&repay)
    );
    assert_eq!(env.balance(anna.id()).await?, 325 * USDC + 83_750_000);
    let worker = env.get_worker("anna").await?;
    assert!(worker["advance"].is_null());
    assert_eq!(worker["level"], 1);
    assert_eq!(worker["payments_count"], 5);
    assert_eq!(
        env.get_pool().await?,
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
    assert_eq!(
        env.view("get_limit", json!({ "handle": "anna" })).await?["limit"],
        "30000000"
    );

    let late_lp = env.lp_with_deposit(1001 * USDC).await?;
    assert_eq!(
        env.view("get_shares", json!({ "account_id": late_lp.id() }))
            .await?,
        "1000000000"
    );

    let position = env
        .view("get_lp", json!({ "account_id": late_lp.id() }))
        .await?;
    assert_eq!(position["shares"], "1000000000");
    assert!(position["unlocks_at"].as_u64().unwrap() > env.now_ms().await?);
    let early = env
        .call(
            &late_lp,
            "withdraw",
            json!({ "shares": (1000 * USDC).to_string() }),
        )
        .await?;
    assert_failed_with(&early, "shares are still locked");
    assert_eq!(
        activity_kinds(&env, "anna").await?,
        [
            "payment",
            "payment",
            "payment",
            "advance",
            "payment",
            "repayment",
            "payment",
            "repayment",
            "closed"
        ]
    );

    env.advance_time(WITHDRAW_DELAY_MS).await?;
    let withdraw = env
        .call(
            &lp,
            "withdraw",
            json!({ "shares": (999 * USDC).to_string() }),
        )
        .await?;
    assert_all_succeeded(&withdraw);
    println!(
        "withdraw: gas {}, burnt {}",
        withdraw.total_gas_burnt,
        burnt(&withdraw)
    );
    assert_eq!(env.balance(lp.id()).await?, 999_999_000);
    assert_eq!(
        env.view("get_shares", json!({ "account_id": lp.id() }))
            .await?,
        "0"
    );
    assert_eq!(env.balance(env.preday.id()).await?, 1_002_251_000);
    Ok(())
}

#[tokio::test]
async fn advance_requests_are_checked() -> Result<()> {
    let env = Env::new().await?;
    let anna = env.worker_with_handle("anna").await?;
    for _ in 0..3 {
        env.pay("anna", 100 * USDC).await?.into_result()?;
    }
    env.advance_time(MIN_HISTORY_MS).await?;

    assert_failed_with(
        &env.request_advance(&anna, USDC).await?,
        "not eligible: not_verified",
    );
    assert_all_succeeded(&env.verify(&anna, "anna").await?);
    assert_failed_with(
        &env.verify(&anna, "anna").await?,
        "person already has a handle",
    );

    let stranger = env.user().await?;
    assert_failed_with(
        &env.request_advance(&stranger, USDC).await?,
        "account has no handle",
    );
    assert_failed_with(
        &env.request_advance(&anna, USDC).await?,
        "not enough liquidity",
    );

    env.lp_with_deposit(30 * USDC).await?;
    assert_failed_with(
        &env.request_advance(&anna, 25 * USDC).await?,
        "utilization cap reached",
    );
    assert_failed_with(
        &env.request_advance(&anna, 25 * USDC + 1).await?,
        "amount exceeds the limit",
    );
    assert_failed_with(
        &env.request_advance(&anna, USDC - 1).await?,
        "amount is below the minimum advance",
    );

    assert_all_succeeded(&env.request_advance(&anna, 24 * USDC).await?);
    assert_failed_with(
        &env.request_advance(&anna, USDC).await?,
        "not eligible: advance_open",
    );

    let direct = env
        .call(
            &anna,
            "set_verified",
            json!({ "handle": "anna", "person_code": env.account_code }),
        )
        .await?;
    assert_failed_with(&direct, "only the verifier can verify");
    let pool = env.get_pool().await?;
    assert_eq!(pool["lent"], "24000000");
    assert_eq!(pool["advances_count"], 1);
    Ok(())
}

#[tokio::test]
async fn unsupported_transfers_are_refunded() -> Result<()> {
    let env = Env::new().await?;
    env.worker_with_handle("anna").await?;
    let sender = env.user().await?;
    env.mint(sender.id(), 50 * USDC).await?;

    let cases = [
        (
            r#"{"income":"anna"}"#,
            "income must come from the handle's own account",
        ),
        (
            r#"{"income":"ghost"}"#,
            "income must come from the handle's own account",
        ),
        ("gm", "unsupported msg"),
        ("", "unsupported msg"),
        (r#"{"deposit":false}"#, "unsupported msg"),
    ];
    for (msg, error) in cases {
        let result = env.transfer_call(&sender, 50 * USDC, msg).await?;
        assert_failed_with(&result, error);
        assert_eq!(
            result.json::<String>()?,
            "0",
            "nothing should be used for {msg}"
        );
        assert_eq!(env.balance(sender.id()).await?, 50 * USDC);
    }
    assert_eq!(env.balance(env.preday.id()).await?, 0);
    assert_eq!(env.get_worker("anna").await?["payments_count"], 0);
    assert_eq!(env.get_pool().await?["assets"], "0");

    let dust = env
        .transfer_call(&sender, USDC - 1, r#"{"deposit":true}"#)
        .await?;
    assert_failed_with(&dust, "deposit is below the minimum");
    assert_eq!(env.balance(sender.id()).await?, 50 * USDC);

    let deposit = env
        .transfer_call(&sender, 50 * USDC, r#"{"deposit":true}"#)
        .await?;
    assert_all_succeeded(&deposit);
    println!(
        "deposit: gas {}, burnt {}",
        deposit.total_gas_burnt,
        burnt(&deposit)
    );
    assert_eq!(deposit.json::<String>()?, (50 * USDC).to_string());
    assert_eq!(env.get_pool().await?["assets"], "50000000");
    Ok(())
}

#[tokio::test]
async fn stale_advance_goes_late_and_is_written_off() -> Result<()> {
    let env = Env::new().await?;
    env.lp_with_deposit(1000 * USDC).await?;
    let anna = env.eligible_worker("anna", 100 * USDC).await?;
    let boris = env.user().await?;

    assert_all_succeeded(&env.request_advance(&anna, 25 * USDC).await?);
    env.advance_time(SEASONING_MS).await?;
    env.pay("anna", 100 * USDC).await?.into_result()?;
    assert_eq!(env.get_worker("anna").await?["level"], 1);
    assert_eq!(env.get_pool().await?["reserve"], "250000");

    assert_all_succeeded(&env.request_advance(&anna, 30 * USDC).await?);
    env.pay("anna", 10 * USDC).await?.into_result()?;
    let handle = json!({ "handle": "anna" });
    assert_failed_with(
        &env.call(&boris, "mark_late", handle.clone()).await?,
        "not late yet",
    );
    assert_failed_with(
        &env.call(&boris, "write_off", handle.clone()).await?,
        "cannot be written off yet",
    );

    env.advance_time(LATE_AFTER_MS).await?;
    env.pay("anna", USDC).await?.into_result()?;
    assert_all_succeeded(&env.call(&boris, "mark_late", handle.clone()).await?);
    let worker = env.get_worker("anna").await?;
    assert_eq!(worker["advance"]["late"], true);
    assert_eq!(worker["level"], 0);
    assert_failed_with(
        &env.call(&boris, "write_off", handle.clone()).await?,
        "cannot be written off yet",
    );

    env.advance_time(WRITE_OFF_AFTER_MS - LATE_AFTER_MS).await?;
    assert_all_succeeded(&env.call(&boris, "write_off", handle.clone()).await?);
    let worker = env.get_worker("anna").await?;
    assert!(worker["advance"].is_null());
    assert_eq!(worker["banned"], true);
    assert_eq!(
        env.get_pool().await?,
        json!({
            "assets": "982250000",
            "lent": "0",
            "reserve": "0",
            "total_shares": "1000000000",
            "advanced": "55000000",
            "repaid": "36000000",
            "fees": "1250000",
            "written_off": "19000000",
            "advances_count": 2,
        })
    );
    assert_eq!(env.view("get_limit", handle).await?["reason"], "banned");
    assert_failed_with(
        &env.request_advance(&anna, USDC).await?,
        "not eligible: banned",
    );

    let before = env.balance(anna.id()).await?;
    env.pay("anna", 50 * USDC).await?.into_result()?;
    assert_eq!(env.balance(anna.id()).await?, before + 50 * USDC);
    Ok(())
}

#[tokio::test]
async fn undeliverable_payouts_wait_for_claim() -> Result<()> {
    let env = Env::new().await?;
    let anna = env.worker_with_handle("anna").await?;

    anna.call(env.usdc.id(), "storage_unregister")
        .args_json(json!({ "force": true }))
        .deposit(ONE_YOCTO)
        .transact()
        .await?
        .into_result()?;

    env.mint(&env.named("anna"), 70 * USDC).await?;
    let sweep = env.sweep("anna").await?;
    assert!(sweep.is_success(), "{sweep:?}");
    assert_failed_with(&sweep, "is not registered");
    let worker = env.get_worker("anna").await?;
    assert_eq!(worker["payments_count"], 1);
    assert_eq!(worker["pending"], "70000000");
    assert_eq!(env.balance(env.preday.id()).await?, 70 * USDC);

    let claim = env.call(&anna, "claim", json!({})).await?;
    assert_failed_with(&claim, "is not registered");
    assert_eq!(env.get_worker("anna").await?["pending"], "70000000");

    anna.call(env.usdc.id(), "storage_deposit")
        .args_json(json!({}))
        .deposit(USDC_STORAGE_DEPOSIT)
        .transact()
        .await?
        .into_result()?;
    assert_all_succeeded(&env.call(&anna, "claim", json!({})).await?);
    assert_eq!(env.get_worker("anna").await?["pending"], "0");
    assert_eq!(env.balance(anna.id()).await?, 70 * USDC);
    assert_failed_with(
        &env.call(&anna, "claim", json!({})).await?,
        "nothing to claim",
    );
    Ok(())
}

#[tokio::test]
async fn params_are_timelocked() -> Result<()> {
    let mut proposed = env::fast_params();
    proposed["fee_bps"] = json!(300);
    let env = Env::new().await?;
    let stranger = env.user().await?;
    let args = json!({ "params": proposed });

    assert_failed_with(
        &env.call(&stranger, "propose_params", args.clone()).await?,
        "only the owner can propose params",
    );
    assert_all_succeeded(&env.call(&env.owner, "propose_params", args).await?);
    let pending = env.view("get_pending_params", json!({})).await?;
    assert_eq!(pending["params"], proposed);
    assert_failed_with(
        &env.call(&stranger, "apply_params", json!({})).await?,
        "params are still timelocked",
    );
    assert_eq!(env.view("get_params", json!({})).await?, env::fast_params());

    env.advance_time(PARAMS_DELAY_MS).await?;
    assert_all_succeeded(&env.call(&stranger, "apply_params", json!({})).await?);
    assert_eq!(env.view("get_params", json!({})).await?, proposed);
    assert!(env.view("get_pending_params", json!({})).await?.is_null());
    assert_eq!(
        env.view("get_config", json!({})).await?,
        json!({
            "usdc": env.usdc.id(),
            "verifier": env.verifier.id(),
            "owner": env.owner.id(),
            "register_deposit": "35000000000000000000000",
            "params_delay_ms": PARAMS_DELAY_MS,
        })
    );
    Ok(())
}

#[tokio::test]
async fn failed_advance_payout_is_rolled_back() -> Result<()> {
    let env = Env::new().await?;
    env.lp_with_deposit(1000 * USDC).await?;
    let anna = env.eligible_worker("anna", 100 * USDC).await?;
    anna.call(env.usdc.id(), "storage_unregister")
        .args_json(json!({ "force": true }))
        .deposit(ONE_YOCTO)
        .transact()
        .await?
        .into_result()?;

    let advance = env.request_advance(&anna, 25 * USDC).await?;
    assert_failed_with(&advance, "is not registered");
    assert!(!advance.json::<bool>()?);

    let worker = env.get_worker("anna").await?;
    assert!(worker["advance"].is_null());
    assert_eq!(worker["pending"], "0");
    assert_eq!(worker["activity_count"], 3);
    let pool = env.get_pool().await?;
    assert_eq!(pool["lent"], "0");
    assert_eq!(pool["advances_count"], 0);
    assert_eq!(env.balance(env.preday.id()).await?, 1000 * USDC);
    assert_eq!(
        env.view("get_limit", json!({ "handle": "anna" })).await?["eligible"],
        true
    );
    Ok(())
}

/// Storage staking price on NEAR, in yoctoNEAR per byte.
const STORAGE_PRICE_PER_BYTE: u128 = 10_000_000_000_000_000_000;

#[tokio::test]
async fn register_deposit_covers_the_storage_of_a_worker() -> Result<()> {
    let env = Env::new().await?;
    env.lp_with_deposit(1000 * USDC).await?;
    let handle = "h".repeat(32);
    let owner = env.user_named(&"o".repeat(64 - ".test.near".len())).await?;
    assert_eq!(owner.id().len(), 64);
    let storage_before = env.preday.view_account().await?.storage_usage;

    env.register(&owner, &handle).await?.into_result()?;
    for _ in 0..20 {
        env.pay(&handle, 100 * USDC).await?.into_result()?;
    }
    assert_all_succeeded(&env.verify(&owner, &handle).await?);
    env.advance_time(MIN_HISTORY_MS).await?;
    assert_all_succeeded(&env.request_advance(&owner, 25 * USDC).await?);
    assert_eq!(env.get_worker(&handle).await?["activity_count"], 21);

    let used = env.preday.view_account().await?.storage_usage - storage_before;
    let kept = REGISTER_DEPOSIT.as_yoctonear()
        - NearToken::from_millinear(1).as_yoctonear()
        - 2 * USDC_STORAGE_DEPOSIT.as_yoctonear();
    println!("worker with a full activity log: {used} bytes");
    assert!(
        u128::from(used) * STORAGE_PRICE_PER_BYTE <= kept,
        "{used} bytes are not covered by the {kept} yoctoNEAR kept from the register deposit"
    );
    Ok(())
}
