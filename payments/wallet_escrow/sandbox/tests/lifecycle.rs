//! Actual local NEAR sandbox, compiled Wasm, independent buyer/provider keys.
//! No public-chain deployment or real money in this test.
use anyhow::Result;
use ed25519_dalek::{Signer,SigningKey};
fn key()->SigningKey{SigningKey::from_bytes(&[7;32])}
fn hex(b:&[u8])->String{b.iter().map(|x|format!("{x:02x}")).collect()}
fn admitted(c:&Contract,t:&Value)->Value{
 let names=["job_id","buyer_commitment","buyer_account","provider","amount","input_hash","program_hash","plan_hash","execution_deadline_ns","review_deadline_ns"];
 let mut tuple=vec!["NOPE:WALLET-ESCROW:V2:testnet".to_string(),c.id().to_string()];for n in names{tuple.push(t[n].as_str().unwrap().to_string());}
 use sha2::{Digest,Sha256};let binding=hex(&Sha256::digest(serde_json::to_vec(&tuple).unwrap()));
 let sig=hex(&key().sign(format!("NOPE:WALLET-ADMISSION:V1\0{binding}").as_bytes()).to_bytes());json!({"terms":t,"admission_signature":sig})
}
use near_workspaces::{Contract,types::{Gas,KeyType,NearToken,SecretKey}};
use serde_json::{Value,json};
const STORAGE:u128=40960000000000000000000;
const AMOUNT:u128=100_000_000_000_000_000_000_000; //0.1 test token in local VM
fn terms(buyer:&str,provider:&str,job:&str,now:u64,short:bool)->Value{
 json!({"job_id":job,"buyer_commitment":"11".repeat(32),"buyer_account":buyer,"provider":provider,"amount":AMOUNT.to_string(),"input_hash":"22".repeat(32),"program_hash":"33".repeat(32),"plan_hash":"44".repeat(32),"execution_deadline_ns":(now+if short{10_000_000_000}else{3_600_000_000_000}).to_string(),"review_deadline_ns":(now+if short{20_000_000_000}else{7_200_000_000_000}).to_string()})
}
async fn hold(c:&Contract,buyer:&str,job:&str)->Result<Value>{Ok(c.view("get_hold").args_json(json!({"buyer_account":buyer,"job_id":job})).await?.json()?)}
#[tokio::test(flavor="multi_thread",worker_threads=2)]
async fn keyless_wallet_deposits_namespace_payout_refund_and_real_failure_callbacks()->Result<()>{
 let worker=near_workspaces::sandbox().await?;
 let parent=worker.create_tla("testnet".parse()?,SecretKey::from_seed(KeyType::ED25519,"wallet-escrow-local-only")).await?.into_result()?;
 let escrow=parent.create_subaccount("wallet-escrow").initial_balance(NearToken::from_near(6)).transact().await?.into_result()?;
 let buyer=parent.create_subaccount("buyer").initial_balance(NearToken::from_near(2)).transact().await?.into_result()?;
 let other=parent.create_subaccount("other").initial_balance(NearToken::from_near(2)).transact().await?.into_result()?;
 let provider=parent.create_subaccount("provider").initial_balance(NearToken::from_near(2)).transact().await?.into_result()?;
 let wasm=std::fs::read(concat!(env!("CARGO_MANIFEST_DIR"),"/../../testnet_escrow/target/wasm32-unknown-unknown/release/nope_wallet_escrow.wasm"))?;
 let c=escrow.deploy(&wasm).await?.into_result()?;
 c.call("new").args_json(json!({"admission_public_key":hex(key().verifying_key().as_bytes())})).transact().await?.into_result()?;
 assert!(buyer.call(c.id(),"new").args_json(json!({})).transact().await?.is_failure());
 // Lock code before any customer funds: actual DeleteKey, not a mock flag.
 escrow.batch(escrow.id()).delete_key(escrow.secret_key().public_key()).transact().await?.into_result()?;
 assert!(c.view_access_keys().await?.is_empty());
 let config:Value=c.view("get_config").await?.json()?;assert_eq!(config["total_deposited"],"0");assert_eq!(config["liabilities"],"0");
 let now=worker.view_block().await?.timestamp();let job="01".repeat(16);
 let t=terms(buyer.id().as_str(),provider.id().as_str(),&job,now,false);
 assert!(other.call(c.id(),"fund").args_json(admitted(&c,&t)).deposit(NearToken::from_yoctonear(AMOUNT+STORAGE)).transact().await?.is_failure());
 assert!(buyer.call(c.id(),"fund").args_json(admitted(&c,&t)).deposit(NearToken::from_yoctonear(AMOUNT+STORAGE-1)).transact().await?.is_failure());
 // Unadmitted callers cannot consume a namespace, even with their own deposit.
 assert!(other.call(c.id(),"fund").args_json(json!({"terms":terms(other.id().as_str(),provider.id().as_str(),&job,now,false),"admission_signature":"00".repeat(64)})).deposit(NearToken::from_yoctonear(AMOUNT+STORAGE)).transact().await?.is_failure());
 // Explicit application admission may authorize another namespace.
 let attack=terms(other.id().as_str(),provider.id().as_str(),&job,now,false);
 other.call(c.id(),"fund").args_json(admitted(&c,&attack)).deposit(NearToken::from_yoctonear(AMOUNT+STORAGE)).transact().await?.into_result()?;
 buyer.call(c.id(),"fund").args_json(admitted(&c,&t)).deposit(NearToken::from_yoctonear(AMOUNT+STORAGE)).transact().await?.into_result()?;
 let a=hold(&c,other.id().as_str(),&job).await?;assert_eq!(a["storage_deposit_yocto"],STORAGE.to_string());let b=hold(&c,buyer.id().as_str(),&job).await?;assert_ne!(a["binding_hash"],b["binding_hash"]);
 assert!(buyer.call(c.id(),"fund").args_json(admitted(&c,&t)).deposit(NearToken::from_yoctonear(AMOUNT+STORAGE)).transact().await?.is_failure());
 let args=json!({"buyer_account":buyer.id(),"job_id":job,"version":1,"output_hash":"55".repeat(32)});
 assert!(other.call(c.id(),"record_delivery").args_json(args.clone()).transact().await?.is_failure());
 provider.call(c.id(),"record_delivery").args_json(args.clone()).transact().await?.into_result()?;
 let mut latest=args.clone();latest["version"]=json!(2);latest["output_hash"]=json!("66".repeat(32));
 buyer.call(c.id(),"record_delivery").args_json(latest.clone()).transact().await?.into_result()?;
 assert!(provider.call(c.id(),"accept_and_release").args_json(latest.clone()).gas(Gas::from_tgas(150)).transact().await?.is_failure());
 assert!(buyer.call(c.id(),"accept_and_release").args_json(args.clone()).gas(Gas::from_tgas(150)).transact().await?.is_failure());
 // Provider has paid no gas since 'before' except record_delivery; measure
 // fresh balance immediately before buyer-triggered native payout.
 let before=provider.view_account().await?.balance.as_yoctonear();
 let paid=buyer.call(c.id(),"accept_and_release").args_json(latest.clone()).gas(Gas::from_tgas(150)).transact().await?.into_result()?;
 assert!(paid.receipt_failures().is_empty());assert!(paid.json::<bool>()?);
 assert_eq!(provider.view_account().await?.balance.as_yoctonear()-before,AMOUNT);
 assert_eq!(hold(&c,buyer.id().as_str(),&job).await?["state"],"Paid");
 assert_eq!(hold(&c,other.id().as_str(),&job).await?["state"],"Held");
 assert!(buyer.call(c.id(),"accept_and_release").args_json(latest.clone()).gas(Gas::from_tgas(150)).transact().await?.is_failure());
 assert_eq!(provider.view_account().await?.balance.as_yoctonear()-before,AMOUNT);
 assert!(other.call(c.id(),"on_transfer").args_json(json!({"buyer_account":buyer.id(),"job_id":job,"nonce":"1","action":"payout"})).transact().await?.is_failure());

 // Real failed Transfer to a nonexistent provider: callback must restore.
 let missing="02".repeat(16);let now=worker.view_block().await?.timestamp();
 let t=terms(buyer.id().as_str(),"absent-wallet-provider.testnet",&missing,now,false);
 buyer.call(c.id(),"fund").args_json(admitted(&c,&t)).deposit(NearToken::from_yoctonear(AMOUNT+STORAGE)).transact().await?.into_result()?;
 let args=json!({"buyer_account":buyer.id(),"job_id":missing,"version":1,"output_hash":"77".repeat(32)});
 buyer.call(c.id(),"record_delivery").args_json(args.clone()).transact().await?.into_result()?;
 let failed=buyer.call(c.id(),"accept_and_release").args_json(args).gas(Gas::from_tgas(150)).transact().await?;
 assert!(!failed.json::<bool>()?);let h=hold(&c,buyer.id().as_str(),&missing).await?;assert_eq!(h["state"],"Delivered");assert_eq!(h["last_transfer_failure_nonce"],"1");

 // Actual refund to the immutable buyer. The attacker cannot select recipient.
 let refund="03".repeat(16);let now=worker.view_block().await?.timestamp();
 let t=terms(buyer.id().as_str(),provider.id().as_str(),&refund,now,true);
 buyer.call(c.id(),"fund").args_json(admitted(&c,&t)).deposit(NearToken::from_yoctonear(AMOUNT+STORAGE)).transact().await?.into_result()?;
 let args=json!({"buyer_account":buyer.id(),"job_id":refund});
 assert!(buyer.call(c.id(),"refund").args_json(args.clone()).gas(Gas::from_tgas(150)).transact().await?.is_failure());
 worker.fast_forward(100).await?;
 assert!(other.call(c.id(),"refund").args_json(args.clone()).gas(Gas::from_tgas(150)).transact().await?.is_failure());
 let buyer_before=buyer.view_account().await?.balance.as_yoctonear();let provider_before=provider.view_account().await?.balance.as_yoctonear();
 let returned=buyer.call(c.id(),"refund").args_json(args.clone()).gas(Gas::from_tgas(150)).transact().await?.into_result()?;
 assert!(returned.json::<bool>()?);assert!(returned.receipt_failures().is_empty());
 assert!(buyer.view_account().await?.balance.as_yoctonear()>buyer_before+AMOUNT/2,"buyer receives actual refund, less its transaction gas");
 assert_eq!(provider.view_account().await?.balance.as_yoctonear(),provider_before);
 assert_eq!(hold(&c,buyer.id().as_str(),&refund).await?["state"],"Refunded");
 assert!(buyer.call(c.id(),"refund").args_json(args).gas(Gas::from_tgas(150)).transact().await?.is_failure());

 // A closing buyer account forces actual refund failure, not mocked result.
 let closing=parent.create_subaccount("closing").initial_balance(NearToken::from_near(2)).transact().await?.into_result()?;
 let helper=std::fs::read(concat!(env!("CARGO_MANIFEST_DIR"),"/../../testnet_escrow/target/wasm32-unknown-unknown/release/wallet_refund_race_fixture.wasm"))?;
 let closing_contract=closing.deploy(&helper).await?.into_result()?;closing_contract.call("new").args_json(json!({})).transact().await?.into_result()?;
 let now=worker.view_block().await?.timestamp();let close_job="04".repeat(16);let t=terms(closing.id().as_str(),provider.id().as_str(),&close_job,now,true);
 closing_contract.call("fund_job").args_json(json!({"escrow":c.id(),"terms":t,"admission_signature":admitted(&c,&t)["admission_signature"]})).gas(Gas::from_tgas(100)).transact().await?.into_result()?;
 worker.fast_forward(100).await?;
 let failed=closing_contract.call("refund_and_delete").args_json(json!({"escrow":c.id(),"job_id":close_job,"beneficiary":parent.id()})).gas(Gas::from_tgas(250)).transact().await?;
 assert!(!failed.json::<bool>()?);
 let h=hold(&c,closing.id().as_str(),&close_job).await?;assert_eq!(h["state"],"Held");assert_eq!(h["last_transfer_failure_nonce"],"1");
 // Recreate the same buyer account, then retry with nonce2, never nonce1.
 let restored=parent.create_subaccount("closing").initial_balance(NearToken::from_near(1)).transact().await?.into_result()?;
 let retry=restored.call(c.id(),"refund").args_json(json!({"buyer_account":restored.id(),"job_id":close_job})).gas(Gas::from_tgas(150)).transact().await?.into_result()?;
 assert!(retry.json::<bool>()?);let h=hold(&c,restored.id().as_str(),&close_job).await?;assert_eq!(h["state"],"Refunded");assert_eq!(h["nonce"],"2");
 let cfg:Value=c.view("get_config").await?.json()?;
 assert_eq!(cfg["hold_count"],"5");assert_eq!(cfg["storage_deposits"],(5*STORAGE).to_string());assert_eq!(cfg["storage_deposit_refundable"],false);
 let retained=cfg["storage_deposits"].as_str().unwrap().parse::<u128>()?;
 assert!(c.view_account().await?.balance.as_yoctonear()>=retained+2*AMOUNT,"all permanent storage charges and payment liabilities remain after transfers");
 assert_eq!(cfg["total_deposited"],(5*AMOUNT).to_string());assert_eq!(cfg["total_paid"],AMOUNT.to_string());assert_eq!(cfg["total_refunded"],(2*AMOUNT).to_string());assert_eq!(cfg["liabilities"],(2*AMOUNT).to_string());assert_eq!(cfg["pending_outgoing"],"0");
 assert!(c.view_access_keys().await?.is_empty());
 println!("LOCAL_SANDBOX actual keyless Wasm: exact wallet funding, namespace preemption defense, strict delivery, buyer-only payout, actual native provider credit, buyer refund, failed payout AND failed refund callbacks, nonce2 retry, cross-job liabilities preserved; no public-chain claim.");
 println!("FINAL_CONFIG {cfg}");Ok(())
}
