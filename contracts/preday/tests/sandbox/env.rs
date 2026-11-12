use anyhow::{ensure, Context, Result};
use near_jsonrpc_client::{methods, JsonRpcClient};
use near_primitives::action::{Action, DeployGlobalContractAction, GlobalContractDeployMode};
use near_primitives::transaction::SignedTransaction;
use near_primitives::views::FinalExecutionStatus;
use near_workspaces::cargo_near_build::{self, camino::Utf8PathBuf, BuildOpts};
use near_workspaces::network::Sandbox;
use near_workspaces::result::ExecutionFinalResult;
use near_workspaces::types::{Gas, NearToken};
use near_workspaces::{Account, AccountId, Contract, Worker};
use serde_json::{json, Value};
use tokio::sync::OnceCell;

pub const USDC: u128 = 1_000_000;
pub const REGISTER_DEPOSIT: NearToken = NearToken::from_millinear(35);
pub const USDC_STORAGE_DEPOSIT: NearToken = NearToken::from_micronear(1250);
pub const ONE_YOCTO: NearToken = NearToken::from_yoctonear(1);
/// Gas a client should attach to `register` and `sweep`.
pub const HEAVY_GAS: Gas = Gas::from_tgas(100);
/// Gas a client should attach to every other call.
pub const CALL_GAS: Gas = Gas::from_tgas(50);

/// Lower bound of the timestamp step between fast-forwarded sandbox blocks.
const BLOCK_MS: u64 = 250;

struct Wasms {
    preday: Vec<u8>,
    account: Vec<u8>,
    usdc: Vec<u8>,
    verifier: Vec<u8>,
}

static WASMS: OnceCell<Wasms> = OnceCell::const_new();

fn build(krate: &str, no_abi: bool) -> Result<Vec<u8>> {
    let manifest = format!("{}/../{krate}/Cargo.toml", env!("CARGO_MANIFEST_DIR"));
    let artifact = cargo_near_build::build_with_cli(BuildOpts {
        no_locked: true,
        no_abi,
        manifest_path: Some(Utf8PathBuf::from(manifest)),
        ..Default::default()
    })
    .map_err(|error| anyhow::anyhow!("building {krate}: {error:?}"))?;
    Ok(std::fs::read(artifact)?)
}

async fn wasms() -> Result<&'static Wasms> {
    WASMS
        .get_or_try_init(|| async {
            tokio::task::spawn_blocking(|| {
                Ok(Wasms {
                    preday: build("preday", false)?,
                    account: build("preday-account", true)?,
                    usdc: build("test-usdc", false)?,
                    verifier: build("test-verifier", false)?,
                })
            })
            .await?
        })
        .await
}

pub const MIN_HISTORY_MS: u64 = 2 * 60 * 1000;
pub const LATE_AFTER_MS: u64 = 5 * 60 * 1000;
pub const WRITE_OFF_AFTER_MS: u64 = 15 * 60 * 1000;
pub const SEASONING_MS: u64 = 60 * 1000;
pub const WITHDRAW_DELAY_MS: u64 = 10 * 60 * 1000;
pub const PARAMS_DELAY_MS: u64 = 5 * 60 * 1000;

/// Params with the production ratios and durations short enough to
/// fast-forward through, yet far longer than a test takes in real time.
pub fn fast_params() -> Value {
    json!({
        "min_payments": 3,
        "min_history_ms": MIN_HISTORY_MS,
        "base_share_bps": 3000,
        "ladder": ["25000000", "50000000", "100000000", "200000000", "400000000"],
        "fee_bps": 500,
        "min_fee": "1000000",
        "late_after_ms": LATE_AFTER_MS,
        "write_off_after_ms": WRITE_OFF_AFTER_MS,
        "reserve_bps": 2000,
        "max_utilization_bps": 8000,
        "min_payment": "10000000",
        "seasoning_ms": SEASONING_MS,
        "withdraw_delay_ms": WITHDRAW_DELAY_MS,
        "max_verifications_per_day": 1000,
        "newcomer_exposure_bps": 5000,
    })
}

pub struct Env {
    pub worker: Worker<Sandbox>,
    pub owner: Account,
    pub usdc: Contract,
    pub preday: Contract,
    pub verifier: Contract,
    pub account_code: String,
    pub publish_cost: NearToken,
}

impl Env {
    pub async fn new() -> Result<Self> {
        Self::with_params(fast_params(), PARAMS_DELAY_MS).await
    }

    pub async fn with_params(params: Value, params_delay_ms: u64) -> Result<Self> {
        let wasms = wasms().await?;
        let worker = near_workspaces::sandbox().await?;
        let root = worker.root_account()?;
        let subaccount = |name: &'static str| {
            let root = root.clone();
            async move {
                root.create_subaccount(name)
                    .initial_balance(NearToken::from_near(50))
                    .transact()
                    .await?
                    .into_result()
                    .map_err(anyhow::Error::from)
            }
        };

        let publisher = subaccount("publisher").await?;
        let before = publisher.view_account().await?.balance;
        let account_code = publish_global(&worker, &publisher, &wasms.account).await?;
        let publish_cost = before.saturating_sub(publisher.view_account().await?.balance);

        let owner = subaccount("owner").await?;
        let usdc = subaccount("usdc")
            .await?
            .deploy(&wasms.usdc)
            .await?
            .into_result()?;
        let verifier = subaccount("verifier")
            .await?
            .deploy(&wasms.verifier)
            .await?
            .into_result()?;
        let preday = subaccount("preday")
            .await?
            .deploy(&wasms.preday)
            .await?
            .into_result()?;

        usdc.call("new").transact().await?.into_result()?;
        owner
            .call(usdc.id(), "storage_deposit")
            .args_json(json!({ "account_id": preday.id(), "registration_only": true }))
            .deposit(USDC_STORAGE_DEPOSIT)
            .transact()
            .await?
            .into_result()?;
        verifier
            .call("new")
            .args_json(json!({ "preday": preday.id() }))
            .transact()
            .await?
            .into_result()?;
        owner
            .call(preday.id(), "new")
            .args_json(json!({
                "usdc": usdc.id(),
                "verifier": verifier.id(),
                "account_code": account_code,
                "params": params,
                "params_delay_ms": params_delay_ms,
            }))
            .transact()
            .await?
            .into_result()?;

        Ok(Self {
            worker,
            owner,
            usdc,
            preday,
            verifier,
            account_code,
            publish_cost,
        })
    }

    pub async fn user(&self) -> Result<Account> {
        Ok(self.worker.dev_create_account().await?)
    }

    /// Creates `<name>.<root>`, for tests that need a specific id length.
    pub async fn user_named(&self, name: &str) -> Result<Account> {
        Ok(self
            .worker
            .root_account()?
            .create_subaccount(name)
            .initial_balance(NearToken::from_near(10))
            .transact()
            .await?
            .into_result()?)
    }

    pub fn named(&self, handle: &str) -> AccountId {
        format!("{handle}.{}", self.preday.id()).parse().unwrap()
    }

    pub async fn register(&self, user: &Account, handle: &str) -> Result<ExecutionFinalResult> {
        Ok(user
            .call(self.preday.id(), "register")
            .args_json(json!({ "handle": handle }))
            .deposit(REGISTER_DEPOSIT)
            .gas(HEAVY_GAS)
            .transact()
            .await?)
    }

    /// Creates a user with a registered handle.
    pub async fn worker_with_handle(&self, handle: &str) -> Result<Account> {
        let user = self.user().await?;
        self.register(&user, handle).await?.into_result()?;
        Ok(user)
    }

    pub async fn verify(&self, user: &Account, handle: &str) -> Result<ExecutionFinalResult> {
        Ok(user
            .call(self.verifier.id(), "verify")
            .args_json(json!({ "handle": handle }))
            .gas(CALL_GAS)
            .transact()
            .await?)
    }

    pub async fn mint(&self, account_id: &AccountId, amount: u128) -> Result<()> {
        self.usdc
            .call("mint")
            .args_json(json!({ "account_id": account_id, "amount": amount.to_string() }))
            .transact()
            .await?
            .into_result()?;
        Ok(())
    }

    pub async fn sweep(&self, handle: &str) -> Result<ExecutionFinalResult> {
        Ok(self
            .owner
            .call(&self.named(handle), "sweep")
            .gas(HEAVY_GAS)
            .transact()
            .await?)
    }

    /// A client payment: USDC lands on the named account and gets swept.
    pub async fn pay(&self, handle: &str, amount: u128) -> Result<ExecutionFinalResult> {
        self.mint(&self.named(handle), amount).await?;
        let result = self.sweep(handle).await?;
        ensure!(result.is_success(), "sweep failed: {result:?}");
        ensure!(
            result.receipt_failures().is_empty(),
            "sweep receipt failed: {result:?}"
        );
        Ok(result)
    }

    pub async fn transfer_call(
        &self,
        sender: &Account,
        amount: u128,
        msg: &str,
    ) -> Result<ExecutionFinalResult> {
        Ok(sender
            .call(self.usdc.id(), "ft_transfer_call")
            .args_json(json!({
                "receiver_id": self.preday.id(),
                "amount": amount.to_string(),
                "msg": msg,
            }))
            .deposit(ONE_YOCTO)
            .gas(CALL_GAS)
            .transact()
            .await?)
    }

    /// Creates an LP holding `amount` USDC and deposits all of it.
    pub async fn lp_with_deposit(&self, amount: u128) -> Result<Account> {
        let lp = self.user().await?;
        self.mint(lp.id(), amount).await?;
        self.transfer_call(&lp, amount, r#"{"deposit":true}"#)
            .await?
            .into_result()?;
        Ok(lp)
    }

    pub async fn request_advance(
        &self,
        user: &Account,
        amount: u128,
    ) -> Result<ExecutionFinalResult> {
        Ok(user
            .call(self.preday.id(), "request_advance")
            .args_json(json!({ "amount": amount.to_string() }))
            .gas(CALL_GAS)
            .transact()
            .await?)
    }

    pub async fn call(
        &self,
        caller: &Account,
        method: &str,
        args: Value,
    ) -> Result<ExecutionFinalResult> {
        Ok(caller
            .call(self.preday.id(), method)
            .args_json(args)
            .gas(CALL_GAS)
            .transact()
            .await?)
    }

    pub async fn view(&self, method: &str, args: Value) -> Result<Value> {
        Ok(self.preday.view(method).args_json(args).await?.json()?)
    }

    pub async fn get_worker(&self, handle: &str) -> Result<Value> {
        self.view("get_worker", json!({ "handle": handle })).await
    }

    pub async fn get_pool(&self) -> Result<Value> {
        self.view("get_pool", json!({})).await
    }

    pub async fn balance(&self, account_id: &AccountId) -> Result<u128> {
        let balance: String = self
            .usdc
            .view("ft_balance_of")
            .args_json(json!({ "account_id": account_id }))
            .await?
            .json()?;
        Ok(balance.parse()?)
    }

    pub async fn now_ms(&self) -> Result<u64> {
        Ok(self.worker.view_block().await?.timestamp() / 1_000_000)
    }

    /// Moves the chain clock forward by at least `ms`.
    pub async fn advance_time(&self, ms: u64) -> Result<()> {
        let target = self.now_ms().await? + ms;
        self.worker.fast_forward(ms.div_ceil(BLOCK_MS)).await?;
        while self.now_ms().await? < target {
            self.worker.fast_forward(1).await?;
        }
        Ok(())
    }

    /// Three payments, enough history and a verified identity.
    pub async fn eligible_worker(&self, handle: &str, payment: u128) -> Result<Account> {
        let user = self.worker_with_handle(handle).await?;
        for _ in 0..3 {
            self.pay(handle, payment).await?.into_result()?;
        }
        self.verify(&user, handle).await?.into_result()?;
        self.advance_time(MIN_HISTORY_MS).await?;
        Ok(user)
    }
}

/// Publishes `code` as a global contract addressed by its hash and returns
/// that hash in base58.
async fn publish_global(
    worker: &Worker<Sandbox>,
    publisher: &Account,
    code: &[u8],
) -> Result<String> {
    let secret_key: near_crypto::SecretKey = publisher.secret_key().to_string().parse()?;
    let signer = near_crypto::InMemorySigner::from_secret_key(publisher.id().clone(), secret_key);
    let access_key = publisher
        .view_access_key(&publisher.secret_key().public_key())
        .await?;
    let block_hash = near_primitives::hash::CryptoHash(worker.view_block().await?.hash().0);
    let transaction = SignedTransaction::from_actions(
        access_key.nonce + 1,
        publisher.id().clone(),
        publisher.id().clone(),
        &signer,
        vec![Action::DeployGlobalContract(DeployGlobalContractAction {
            code: code.into(),
            deploy_mode: GlobalContractDeployMode::CodeHash,
        })],
        block_hash,
    );
    let outcome = JsonRpcClient::connect(worker.rpc_addr())
        .call(methods::broadcast_tx_commit::RpcBroadcastTxCommitRequest {
            signed_transaction: transaction,
        })
        .await
        .context("publishing the global contract")?;
    ensure!(
        matches!(outcome.status, FinalExecutionStatus::SuccessValue(_)),
        "global contract deployment failed: {:?}",
        outcome.status
    );
    Ok(near_primitives::hash::hash(code).to_string())
}
