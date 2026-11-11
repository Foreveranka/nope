use anyhow::Result;
use near_workspaces::types::NearToken;
use serde_json::{Value, json};
use sha2::{Digest, Sha256};

fn string(bytes: &mut Vec<u8>, s: &str) {
    bytes.extend((s.len() as u32).to_le_bytes());
    bytes.extend(s.as_bytes());
}
fn hash_bytes(v: &Value) -> Vec<u8> {
    v.as_array()
        .unwrap()
        .iter()
        .map(|v| v.as_u64().unwrap() as u8)
        .collect()
}
fn root_of(job: &Value) -> Vec<u8> {
    let mut bytes = vec![];
    string(&mut bytes, "veil/bidset/v1");
    bytes.extend(hash_bytes(&job["job_binding_hash"]));
    let bids = job["bids"].as_array().unwrap();
    bytes.extend((bids.len() as u32).to_le_bytes());
    for bid in bids {
        string(&mut bytes, bid["bidder"].as_str().unwrap());
        if bid["commitment"].is_null() {
            bytes.push(0)
        } else {
            bytes.push(1);
            bytes.extend(hash_bytes(&bid["commitment"]));
        }
    }
    Sha256::digest(bytes).to_vec()
}

async fn wait_until(
    worker: &near_workspaces::Worker<near_workspaces::network::Sandbox>,
    deadline: u64,
) -> Result<()> {
    // Observe actual VM time instead of jumping across consensus epochs.
    tokio::time::timeout(std::time::Duration::from_secs(120), async {
        while worker.view_block().await?.timestamp() < deadline {
            tokio::time::sleep(std::time::Duration::from_millis(250)).await;
        }
        Ok::<(), anyhow::Error>(())
    })
    .await??;
    Ok(())
}

#[tokio::test]
async fn actual_wasm_authorization_freeze_report_accept_and_deposit_rejection() -> Result<()> {
    let worker = near_workspaces::sandbox().await?;
    let wasm = std::fs::read(concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/../target/wasm32-unknown-unknown/release/veil_registry.wasm"
    ))?;
    let contract = worker.dev_deploy(&wasm).await?;
    let buyer = worker.dev_create_account().await?;
    let bidder = worker.dev_create_account().await?;
    let executor = worker.dev_create_account().await?;
    let hostile = worker.dev_create_account().await?;
    let init = json!({"owner":buyer.id(),"network_domain_hash":vec![42u8;32]});
    assert!(
        hostile
            .call(contract.id(), "new")
            .args_json(init.clone())
            .transact()
            .await?
            .is_failure()
    );
    contract
        .call("new")
        .args_json(init.clone())
        .transact()
        .await?
        .into_result()?;
    assert!(
        contract
            .call("new")
            .args_json(init)
            .transact()
            .await?
            .is_failure()
    );
    let now = worker.view_block().await?.timestamp();
    let config = json!({"spec_hash":vec![1u8;32],"circuit_hash":vec![2u8;32],"key_hash":vec![3u8;32],
        "output_policy_hash":vec![4u8;32],"context_hash":vec![5u8;32],"input_hash":vec![6u8;32],"budget_commitment":vec![7u8;32],
        "bid_deadline_ns":(now+20_000_000_000).to_string(),"result_deadline_ns":(now+86_400_000_000_000).to_string(),
        "authorized_bidders":[bidder.id()],"executor":executor.id()});
    assert!(
        hostile
            .call(contract.id(), "create_job")
            .args_json(json!({"config":config}))
            .transact()
            .await?
            .is_failure()
    );
    assert!(
        buyer
            .call(contract.id(), "create_job")
            .args_json(json!({"config":config}))
            .deposit(NearToken::from_yoctonear(1))
            .transact()
            .await?
            .is_failure()
    );
    let job: Value = buyer
        .call(contract.id(), "create_job")
        .args_json(json!({"config":config}))
        .transact()
        .await?
        .into_result()?
        .json()?;
    let id = job["job_id"].clone();
    let id_args = json!({"job_id":id});
    assert!(
        buyer
            .call(contract.id(), "close_bids")
            .args_json(id_args.clone())
            .transact()
            .await?
            .is_failure()
    );
    let bid = json!({"job_id":id,"expected_job_binding_hash":job["job_binding_hash"],"commitment":vec![9u8;32]});
    assert!(
        hostile
            .call(contract.id(), "submit_bid")
            .args_json(bid.clone())
            .transact()
            .await?
            .is_failure()
    );
    bidder
        .call(contract.id(), "submit_bid")
        .args_json(bid.clone())
        .transact()
        .await?
        .into_result()?;
    assert!(
        bidder
            .call(contract.id(), "submit_bid")
            .args_json(bid.clone())
            .transact()
            .await?
            .is_failure()
    );
    wait_until(&worker, now + 20_000_000_000).await?;
    hostile
        .call(contract.id(), "close_bids")
        .args_json(id_args.clone())
        .transact()
        .await?
        .into_result()?;
    let closed: Value = contract
        .view("get_job")
        .args_json(id_args.clone())
        .await?
        .json()?;
    assert_eq!(root_of(&closed), hash_bytes(&closed["bidset_root"]));
    assert!(
        bidder
            .call(contract.id(), "submit_bid")
            .args_json(bid)
            .transact()
            .await?
            .is_failure()
    );
    let attempt = json!({"job_id":id,"expected_bidset_root":closed["bidset_root"]});
    assert!(
        executor
            .call(contract.id(), "begin_attempt")
            .args_json(attempt.clone())
            .transact()
            .await?
            .is_failure()
    );
    buyer
        .call(contract.id(), "begin_attempt")
        .args_json(attempt)
        .transact()
        .await?
        .into_result()?;
    let executing: Value = contract
        .view("get_job")
        .args_json(id_args.clone())
        .await?
        .json()?;
    let mut claim = config.clone();
    claim.as_object_mut().unwrap().retain(|k, _| {
        !matches!(
            k.as_str(),
            "authorized_bidders" | "executor" | "bid_deadline_ns" | "result_deadline_ns"
        )
    });
    for key in [
        "job_id",
        "attempt",
        "job_binding_hash",
        "attempt_binding_hash",
        "bidset_root",
    ] {
        claim[key] = executing[key].clone();
    }
    claim["output_hash"] = json!(vec![10u8; 32]);
    assert!(
        buyer
            .call(contract.id(), "report_result")
            .args_json(json!({"claim":claim}))
            .transact()
            .await?
            .is_failure()
    );
    let mut wrong = claim.clone();
    wrong["bidset_root"] = json!(vec![99u8; 32]);
    assert!(
        executor
            .call(contract.id(), "report_result")
            .args_json(json!({"claim":wrong}))
            .transact()
            .await?
            .is_failure()
    );
    let receipt: Value = executor
        .call(contract.id(), "report_result")
        .args_json(json!({"claim":claim}))
        .transact()
        .await?
        .into_result()?
        .json()?;
    assert!(
        executor
            .call(contract.id(), "report_result")
            .args_json(json!({"claim":claim}))
            .transact()
            .await?
            .is_failure()
    );
    let decision = json!({"job_id":id,"expected_receipt_hash":receipt,"accept":true});
    assert!(
        executor
            .call(contract.id(), "decide_result")
            .args_json(decision.clone())
            .transact()
            .await?
            .is_failure()
    );
    buyer
        .call(contract.id(), "decide_result")
        .args_json(decision)
        .transact()
        .await?
        .into_result()?;
    let accepted: Value = contract.view("get_job").args_json(id_args).await?.json()?;
    assert_eq!(accepted["state"], "Accepted");
    assert_eq!(accepted["receipts"][0]["status"], "BuyerAccepted");
    println!(
        "actual Wasm lifecycle passed; full root independently recomputed; no external network/account"
    );
    Ok(())
}

fn from_hex(value: &Value) -> Vec<u8> {
    let s = value.as_str().expect("public hash string");
    assert_eq!(s.len(), 64);
    (0..64)
        .step_by(2)
        .map(|i| u8::from_str_radix(&s[i..i + 2], 16).unwrap())
        .collect()
}

#[tokio::test]
#[ignore = "explicit public evidence path required; post-hoc demo binding only"]
async fn posthoc_public_fhe_hashes_bind_to_accepted_receipt() -> Result<()> {
    let path = std::env::var("REGISTRY_FHE_EVIDENCE")?;
    let source = std::fs::read(&path)?;
    let evidence: Value = serde_json::from_slice(&source)?;
    assert_eq!(evidence["completed"], true);
    let hashes = &evidence["artifactHashes"];
    let worker = near_workspaces::sandbox().await?;
    let wasm = std::fs::read(concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/../target/wasm32-unknown-unknown/release/veil_registry.wasm"
    ))?;
    let contract = worker.dev_deploy(&wasm).await?;
    let buyer = worker.dev_create_account().await?;
    let bidder = worker.dev_create_account().await?;
    let executor = worker.dev_create_account().await?;
    contract
        .call("new")
        .args_json(json!({"owner":buyer.id(),"network_domain_hash":vec![42u8;32]}))
        .transact()
        .await?
        .into_result()?;
    let now = worker.view_block().await?.timestamp();
    let config = json!({"spec_hash":from_hex(&hashes["clientSpecsSha256"]),"circuit_hash":from_hex(&hashes["serverSha256"]),
        "key_hash":from_hex(&hashes["evaluationKeysSha256"]),"input_hash":from_hex(&hashes["inputSha256"]),
        "context_hash":from_hex(&hashes["requestManifestSha256"]),
        "output_policy_hash":Sha256::digest(b"veil/output-policy/clean-4-records-v1").to_vec(),
        "budget_commitment":Sha256::digest(b"veil/demo/no-money-budget/v1").to_vec(),
        "bid_deadline_ns":(now+20_000_000_000).to_string(),"result_deadline_ns":(now+86_400_000_000_000).to_string(),
        "authorized_bidders":[bidder.id()],"executor":executor.id()});
    let job: Value = buyer
        .call(contract.id(), "create_job")
        .args_json(json!({"config":config}))
        .transact()
        .await?
        .into_result()?
        .json()?;
    let id = job["job_id"].clone();
    let id_args = json!({"job_id":id});
    bidder.call(contract.id(),"submit_bid").args_json(json!({"job_id":id,"expected_job_binding_hash":job["job_binding_hash"],"commitment":vec![9u8;32]})).transact().await?.into_result()?;
    wait_until(&worker, now + 20_000_000_000).await?;
    let root: Value = buyer
        .call(contract.id(), "close_bids")
        .args_json(id_args.clone())
        .transact()
        .await?
        .into_result()?
        .json()?;
    let closed: Value = contract
        .view("get_job")
        .args_json(id_args.clone())
        .await?
        .json()?;
    assert_eq!(root_of(&closed), hash_bytes(&root));
    buyer
        .call(contract.id(), "begin_attempt")
        .args_json(json!({"job_id":id,"expected_bidset_root":root}))
        .transact()
        .await?
        .into_result()?;
    let executing: Value = contract
        .view("get_job")
        .args_json(id_args.clone())
        .await?
        .json()?;
    let mut claim = config.clone();
    claim.as_object_mut().unwrap().retain(|k, _| {
        !matches!(
            k.as_str(),
            "authorized_bidders" | "executor" | "bid_deadline_ns" | "result_deadline_ns"
        )
    });
    for key in [
        "job_id",
        "attempt",
        "job_binding_hash",
        "attempt_binding_hash",
        "bidset_root",
    ] {
        claim[key] = executing[key].clone();
    }
    claim["output_hash"] = json!(from_hex(&hashes["outputSha256"]));
    let receipt: Value = executor
        .call(contract.id(), "report_result")
        .args_json(json!({"claim":claim}))
        .transact()
        .await?
        .into_result()?
        .json()?;
    buyer
        .call(contract.id(), "decide_result")
        .args_json(json!({"job_id":id,"expected_receipt_hash":receipt,"accept":true}))
        .transact()
        .await?
        .into_result()?;
    let accepted: Value = contract.view("get_job").args_json(id_args).await?.json()?;
    assert_eq!(accepted["state"], "Accepted");
    assert_eq!(
        accepted["receipts"][0]["claim"]["output_hash"],
        json!(from_hex(&hashes["outputSha256"]))
    );
    let record = json!({"scope":"post-hoc public FHE artifact hashes bound to local sandbox registry claim and buyer acceptance",
        "contract_account":contract.id(),"network_domain_hash":vec![42u8;32],
        "precommitted_workflow":false,"execution_proof_verified":false,"attestation":false,"external_chain":false,
        "source_evidence_sha256":format!("{:x}",Sha256::digest(&source)),"wasm_sha256":format!("{:x}",Sha256::digest(&wasm)),
        "source_public_artifact_hashes":hashes,"registry_receipt_hash":receipt,"accepted_job":accepted});
    let out = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../verification/sandbox-fhe-binding.json");
    std::fs::create_dir_all(out.parent().unwrap())?;
    std::fs::write(out, serde_json::to_string_pretty(&record)?)?;
    println!(
        "post-hoc public FHE hash binding accepted in local Wasm VM; not attestation or pre-committed secure workflow"
    );
    Ok(())
}
