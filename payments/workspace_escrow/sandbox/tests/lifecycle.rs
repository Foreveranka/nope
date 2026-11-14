//! Actual local Wasm VM only. Synthetic sandbox accounts/keys never leave this
//! process. No public network provisioning, signing, deployment or proof claim.
use anyhow::Result;
use near_workspaces::types::{AccessKey, Gas, KeyType, NearToken, SecretKey};
use serde_json::{Value, json};

fn terms(job: &str, provider: &str, now: u64) -> Value {
    json!({"job_id":job,"buyer_commitment":"11".repeat(32),"provider":provider,
        "amount":"1000000000000000000000","input_hash":"22".repeat(32),
        "program_hash":"33".repeat(32),"plan_hash":"00".repeat(32),
        "execution_deadline_ns":(now+3_600_000_000_000).to_string(),
        "review_deadline_ns":(now+7_200_000_000_000).to_string()})
}

#[tokio::test]
async fn actual_local_wasm_scoped_key_transfer_callback_failure_and_timeout_refund() -> Result<()> {
    let worker = near_workspaces::sandbox().await?;
    let parent = worker
        .create_tla(
            "testnet".parse()?,
            SecretKey::from_seed(KeyType::ED25519, "local-workspace-escrow-only"),
        )
        .await?
        .into_result()?;
    let escrow_account = parent
        .create_subaccount("workspace-escrow")
        .initial_balance(NearToken::from_near(4))
        .transact()
        .await?
        .into_result()?;
    let provider = parent
        .create_subaccount("provider")
        .initial_balance(NearToken::from_near(1))
        .transact()
        .await?
        .into_result()?;
    let wasm = std::fs::read(concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/../../testnet_escrow/target/wasm32-unknown-unknown/release/nope_workspace_escrow.wasm"
    ))?;
    let contract = escrow_account.deploy(&wasm).await?.into_result()?;
    assert!(
        provider
            .call(contract.id(), "new")
            .args_json(json!({}))
            .transact()
            .await?
            .is_failure()
    );
    contract
        .call("new")
        .args_json(json!({}))
        .transact()
        .await?
        .into_result()?;
    assert!(
        contract
            .call("new")
            .args_json(json!({}))
            .transact()
            .await?
            .is_failure(),
        "constructor cannot reset an initialized pool"
    );

    // Actual function-call-only self key with finite allowance, not a full key.
    let scoped_key = SecretKey::from_seed(KeyType::ED25519, "local-scoped-workspace-key-only");
    escrow_account
        .batch(escrow_account.id())
        .add_key(
            scoped_key.public_key(),
            AccessKey::function_call_access(
                escrow_account.id(),
                &["fund", "record_delivery", "accept_and_release", "refund"],
                Some(NearToken::from_millinear(200)),
            ),
        )
        .transact()
        .await?
        .into_result()?;
    let mut online = escrow_account.clone();
    online.set_secret_key(scoped_key);
    println!("LOCAL_VM gas_price={:?}", worker.gas_price().await?);
    let now = worker.view_block().await?.timestamp();
    let job = "01".repeat(16);
    let t = terms(&job, provider.id().as_str(), now);
    assert!(
        provider
            .call(contract.id(), "fund")
            .args_json(json!({"terms":t}))
            .transact()
            .await?
            .is_failure()
    );
    // A nonpayable wrapper rejects a deposit even from offline self full key.
    assert!(
        contract
            .call("fund")
            .args_json(json!({"terms":t}))
            .deposit(NearToken::from_yoctonear(1))
            .transact()
            .await?
            .is_failure()
    );
    let held: Value = online
        .call(contract.id(), "fund")
        .args_json(json!({"terms":t}))
        .gas(Gas::from_tgas(30))
        .transact()
        .await?
        .into_result()?
        .json()?;
    assert_eq!(held["state"], "Held");
    let binding = held["binding_hash"].as_str().unwrap();
    let repeated: Value = online
        .call(contract.id(), "fund")
        .args_json(json!({"terms":t}))
        .transact()
        .await?
        .into_result()?
        .json()?;
    assert_eq!(held, repeated);
    let mut changed = t.clone();
    changed["amount"] = json!("2");
    assert!(
        online
            .call(contract.id(), "fund")
            .args_json(json!({"terms":changed}))
            .transact()
            .await?
            .is_failure()
    );
    let args =
        json!({"job_id":job,"binding_hash":binding,"version":1,"output_hash":"44".repeat(32)});
    online
        .call(contract.id(), "record_delivery")
        .args_json(args.clone())
        .transact()
        .await?
        .into_result()?;
    let mut second = args.clone();
    second["version"] = json!(2);
    second["output_hash"] = json!("55".repeat(32));
    online
        .call(contract.id(), "record_delivery")
        .args_json(second.clone())
        .transact()
        .await?
        .into_result()?;
    // MAIN's proposed 0.05 allowance must be checked against the prepaid-gas
    // envelope, not just actual burned gas. It is too small for a 100 Tgas call
    // under this cached runtime. This negative case uses only a local key.
    let small_key = SecretKey::from_seed(KeyType::ED25519, "local-small-allowance-only");
    escrow_account
        .batch(escrow_account.id())
        .add_key(
            small_key.public_key(),
            AccessKey::function_call_access(
                escrow_account.id(),
                &["fund", "record_delivery", "accept_and_release", "refund"],
                Some(NearToken::from_millinear(50)),
            ),
        )
        .transact()
        .await?
        .into_result()?;
    let mut small_online = escrow_account.clone();
    small_online.set_secret_key(small_key);
    let small_result = small_online
        .call(contract.id(), "accept_and_release")
        .args_json(second.clone())
        .gas(Gas::from_tgas(100))
        .transact()
        .await;
    let error =
        small_result.expect_err("0.05 allowance cannot authorize the 100 Tgas prepaid envelope");
    assert!(
        format!("{error:?}").contains("NotEnoughAllowance"),
        "{error:?}"
    );
    let unchanged: Value = contract
        .view("get_hold")
        .args_json(json!({"job_id":job}))
        .await?
        .json()?;
    assert_eq!(unchanged["state"], "Delivered");
    println!("LOCAL_VM expected 0.05 allowance rejection: {error:?}");
    assert!(
        online
            .call(contract.id(), "accept_and_release")
            .args_json(args.clone())
            .gas(Gas::from_tgas(100))
            .transact()
            .await?
            .is_failure()
    );
    let before = provider.view_account().await?.balance.as_yoctonear();
    let paid = online
        .call(contract.id(), "accept_and_release")
        .args_json(second.clone())
        .gas(Gas::from_tgas(100))
        .transact()
        .await?
        .into_result()?;
    assert!(paid.receipt_failures().is_empty(), "{paid:?}");
    assert!(paid.json::<bool>()?);
    assert_eq!(
        provider.view_account().await?.balance.as_yoctonear() - before,
        10u128.pow(21)
    );
    let paid_hold: Value = contract
        .view("get_hold")
        .args_json(json!({"job_id":job}))
        .await?
        .json()?;
    assert_eq!(paid_hold["state"], "Paid");
    assert_eq!(paid_hold["nonce"], "1");
    assert!(
        online
            .call(contract.id(), "accept_and_release")
            .args_json(second.clone())
            .gas(Gas::from_tgas(100))
            .transact()
            .await?
            .is_failure()
    );
    assert_eq!(
        provider.view_account().await?.balance.as_yoctonear() - before,
        10u128.pow(21)
    );
    // Callback is not in scoped key's method list, even though predecessor would be self.
    let prohibited = online
        .call(contract.id(), "on_transfer")
        .args_json(json!({"job_id":job,"binding_hash":binding,"nonce":"1"}))
        .transact()
        .await;
    assert!(prohibited.is_err() || prohibited.is_ok_and(|r| r.is_failure()));

    // A valid nonexistent named receiver fails its Transfer receipt; only the
    // real failure callback restores Delivered and records the failed nonce.
    let missing = "02".repeat(16);
    let now = worker.view_block().await?.timestamp();
    let missing_terms = terms(&missing, "absent-workspace.testnet", now);
    let hold: Value = online
        .call(contract.id(), "fund")
        .args_json(json!({"terms":missing_terms}))
        .transact()
        .await?
        .into_result()?
        .json()?;
    let args = json!({"job_id":missing,"binding_hash":hold["binding_hash"],"version":1,"output_hash":"66".repeat(32)});
    online
        .call(contract.id(), "record_delivery")
        .args_json(args.clone())
        .transact()
        .await?
        .into_result()?;
    let failed = online
        .call(contract.id(), "accept_and_release")
        .args_json(args.clone())
        .gas(Gas::from_tgas(100))
        .transact()
        .await?;
    assert!(!failed.json::<bool>()?);
    let after: Value = contract
        .view("get_hold")
        .args_json(json!({"job_id":missing}))
        .await?
        .json()?;
    assert_eq!(after["state"], "Delivered");
    assert_eq!(after["last_transfer_failure_nonce"], "1");

    let refund_job = "03".repeat(16);
    let now = worker.view_block().await?.timestamp();
    let mut short = terms(&refund_job, provider.id().as_str(), now);
    short["execution_deadline_ns"] = json!((now + 10_000_000_000).to_string());
    short["review_deadline_ns"] = json!((now + 20_000_000_000).to_string());
    let hold: Value = online
        .call(contract.id(), "fund")
        .args_json(json!({"terms":short}))
        .transact()
        .await?
        .into_result()?
        .json()?;
    let refund = json!({"job_id":refund_job,"binding_hash":hold["binding_hash"]});
    assert!(
        online
            .call(contract.id(), "refund")
            .args_json(refund.clone())
            .transact()
            .await?
            .is_failure()
    );
    worker.fast_forward(100).await?;
    let before = provider.view_account().await?.balance.as_yoctonear();
    let refunded: Value = online
        .call(contract.id(), "refund")
        .args_json(refund)
        .transact()
        .await?
        .into_result()?
        .json()?;
    assert_eq!(refunded["state"], "Refunded");
    assert_eq!(
        provider.view_account().await?.balance.as_yoctonear(),
        before,
        "internal refund sends no provider funds"
    );
    let config: Value = contract.view("get_config").await?.json()?;
    assert_eq!(config["spent"], 10u128.pow(21).to_string());
    assert_eq!(config["held"], 10u128.pow(21).to_string());
    assert_eq!(config["pending"], "0");
    assert_eq!(
        config["available"],
        (5 * 10u128.pow(22) - 2 * 10u128.pow(21)).to_string()
    );
    println!(
        "LOCAL_VM_ONLY actual workspace escrow Wasm; FunctionCall-only self key; measured native payout; no replay; real failed Transfer callback; deadline internal refund. No public-chain proof."
    );
    Ok(())
}
