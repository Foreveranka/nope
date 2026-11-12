//! Real local NEAR VM execution with synthetic jobs. No external testnet access.
use anyhow::Result;
use near_workspaces::types::{KeyType, NearToken, SecretKey};
use serde_json::{Value, json};

#[tokio::test]
async fn real_registry_and_escrow_wasm_hold_accept_pay_and_refund() -> Result<()> {
    let worker = near_workspaces::sandbox().await?;
    // Local sandbox namespace only: not accounts on the public testnet.
    let parent = worker
        .create_tla(
            "testnet".parse()?,
            SecretKey::from_seed(KeyType::ED25519, "local-nope-testnet-parent"),
        )
        .await?
        .into_result()?;
    let buyer = parent
        .create_subaccount("registry")
        .initial_balance(NearToken::from_near(10))
        .transact()
        .await?
        .into_result()?;
    let provider = parent
        .create_subaccount("provider")
        .initial_balance(NearToken::from_near(10))
        .transact()
        .await?
        .into_result()?;
    let registry_account = buyer.clone(); // self-owned registry is the pilot buyer
    let escrow_account = parent
        .create_subaccount("escrow")
        .initial_balance(NearToken::from_near(10))
        .transact()
        .await?
        .into_result()?;
    let registry = registry_account
        .deploy(&std::fs::read(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/../../../contracts/registry/target/wasm32-unknown-unknown/release/veil_registry.wasm"
        ))?)
        .await?
        .into_result()?;
    let escrow = escrow_account
        .deploy(&std::fs::read(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/../target/wasm32-unknown-unknown/release/nope_testnet_escrow.wasm"
        ))?)
        .await?
        .into_result()?;
    registry
        .call("new")
        .args_json(json!({"owner":buyer.id(),"network_domain_hash":vec![42;32]}))
        .transact()
        .await?
        .into_result()?;
    escrow
        .call("new")
        .args_json(json!({"registry":registry.id()}))
        .transact()
        .await?
        .into_result()?;
    let now = worker.view_block().await?.timestamp();
    let config = json!({"spec_hash":vec![1;32],"circuit_hash":vec![2;32],"key_hash":vec![3;32],
        "output_policy_hash":vec![4;32],"context_hash":vec![5;32],"input_hash":vec![6;32],"budget_commitment":vec![7;32],
        "bid_deadline_ns":(now+15_000_000_000).to_string(),"result_deadline_ns":(now+3_600_000_000_000).to_string(),
        "authorized_bidders":[provider.id()],"executor":provider.id()});
    let job: Value = buyer
        .call(registry.id(), "create_job")
        .args_json(json!({"config":config}))
        .transact()
        .await?
        .into_result()?
        .json()?;
    let amount = 10u128.pow(21);
    let topup = 2 * 10u128.pow(22);
    let terms = json!({"job_id":job["job_id"],"buyer":buyer.id(),"provider":provider.id(),"amount":amount.to_string(),
        "context_hash":job["config"]["context_hash"],"job_binding_hash":job["job_binding_hash"]});
    let mut attack = terms.clone();
    attack["buyer"] = json!(provider.id());
    assert!(
        provider
            .call(escrow.id(), "fund")
            .args_json(json!({"terms":attack}))
            .deposit(NearToken::from_yoctonear(amount + topup))
            .transact()
            .await?
            .is_failure()
    );
    let absent: Value = escrow
        .view("get_hold")
        .args_json(json!({"job_id":"1"}))
        .await?
        .json()?;
    assert!(
        absent.is_null(),
        "outsider cannot reserve the real registry job ID"
    );
    buyer
        .call(escrow.id(), "fund")
        .args_json(json!({"terms":terms}))
        .deposit(NearToken::from_yoctonear(amount + topup))
        .transact()
        .await?
        .into_result()?;
    let held: Value = escrow
        .view("get_hold")
        .args_json(json!({"job_id":"1"}))
        .await?
        .json()?;
    assert_eq!(held["state"], "Held");
    let dummy = json!({"attempt":"1","attempt_binding_hash":vec![3;32],"receipt_hash":vec![4;32],"output_hash":vec![10;32]});
    let premature = buyer
        .call(escrow.id(), "release")
        .args_json(json!({"job_id":"1","acceptance":dummy}))
        .max_gas()
        .transact()
        .await?
        .into_result()?;
    assert!(!premature.json::<bool>()?);
    provider.call(registry.id(),"submit_bid").args_json(json!({"job_id":"1","expected_job_binding_hash":job["job_binding_hash"],"commitment":vec![9;32]})).transact().await?.into_result()?;
    worker.fast_forward(100).await?;
    let root: Value = buyer
        .call(registry.id(), "close_bids")
        .args_json(json!({"job_id":"1"}))
        .transact()
        .await?
        .into_result()?
        .json()?;
    buyer
        .call(registry.id(), "begin_attempt")
        .args_json(json!({"job_id":"1","expected_bidset_root":root}))
        .transact()
        .await?
        .into_result()?;
    let executing: Value = registry
        .view("get_job")
        .args_json(json!({"job_id":"1"}))
        .await?
        .json()?;
    let claim = json!({"job_id":"1","attempt":executing["attempt"],"job_binding_hash":executing["job_binding_hash"],
        "attempt_binding_hash":executing["attempt_binding_hash"],"bidset_root":executing["bidset_root"],
        "spec_hash":executing["config"]["spec_hash"],"circuit_hash":executing["config"]["circuit_hash"],
        "key_hash":executing["config"]["key_hash"],"output_policy_hash":executing["config"]["output_policy_hash"],
        "context_hash":executing["config"]["context_hash"],"input_hash":executing["config"]["input_hash"],
        "budget_commitment":executing["config"]["budget_commitment"],"output_hash":vec![10;32]});
    let receipt: Value = provider
        .call(registry.id(), "report_result")
        .args_json(json!({"claim":claim}))
        .transact()
        .await?
        .into_result()?
        .json()?;
    buyer
        .call(registry.id(), "decide_result")
        .args_json(json!({"job_id":"1","expected_receipt_hash":receipt,"accept":true}))
        .transact()
        .await?
        .into_result()?;
    let acceptance = json!({"attempt":"1","attempt_binding_hash":executing["attempt_binding_hash"],"receipt_hash":receipt,"output_hash":vec![10;32]});
    let before = provider.view_account().await?.balance.as_yoctonear();
    let paid = buyer
        .call(escrow.id(), "release")
        .args_json(json!({"job_id":"1","acceptance":acceptance}))
        .max_gas()
        .transact()
        .await?
        .into_result()?;
    assert!(paid.receipt_failures().is_empty(), "{paid:?}");
    assert!(paid.json::<bool>()?);
    assert_eq!(
        provider.view_account().await?.balance.as_yoctonear() - before,
        amount
    );
    let hold: Value = escrow
        .view("get_hold")
        .args_json(json!({"job_id":"1"}))
        .await?
        .json()?;
    assert_eq!(hold["state"], "Paid");
    assert!(
        buyer
            .call(escrow.id(), "release")
            .args_json(json!({"job_id":"1","acceptance":acceptance}))
            .max_gas()
            .transact()
            .await?
            .is_failure()
    );
    assert_eq!(
        provider.view_account().await?.balance.as_yoctonear() - before,
        amount
    );
    // A second, separately funded job exercises cooperative refund.
    let mut terms2 = terms.clone();
    terms2["job_id"] = json!("2");
    buyer
        .call(escrow.id(), "fund")
        .args_json(json!({"terms":terms2}))
        .deposit(NearToken::from_yoctonear(amount + topup))
        .transact()
        .await?
        .into_result()?;
    assert!(
        buyer
            .call(escrow.id(), "refund")
            .args_json(json!({"job_id":"2"}))
            .max_gas()
            .transact()
            .await?
            .is_failure()
    );
    provider
        .call(escrow.id(), "approve_refund")
        .args_json(json!({"job_id":"2"}))
        .transact()
        .await?
        .into_result()?;
    assert!(
        buyer
            .call(escrow.id(), "refund")
            .args_json(json!({"job_id":"2"}))
            .max_gas()
            .transact()
            .await?
            .into_result()?
            .json::<bool>()?
    );
    let hold: Value = escrow
        .view("get_hold")
        .args_json(json!({"job_id":"2"}))
        .await?
        .json()?;
    assert_eq!(hold["state"], "Refunded");
    println!(
        "LOCAL_SANDBOX_ONLY actual registry+escrow Wasm, separate buyer/provider, transfer delta={amount}, hold/pay/no-replay/cooperative-refund; no public-testnet settlement"
    );
    Ok(())
}
