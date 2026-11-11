//! Persistent local-only JSONL transport. No RPC URL, key or external account inputs.
use anyhow::{Context, Result, bail, ensure};
use near_workspaces::{Account, Contract, Worker, network::Sandbox};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::{
    collections::BTreeMap,
    io::{BufRead, Write},
    path::PathBuf,
};

struct Driver {
    worker: Worker<Sandbox>,
    contract: Contract,
    accounts: BTreeMap<String, Account>,
    wasm_sha256: String,
}

fn field<'a>(v: &'a Value, key: &str) -> Result<&'a Value> {
    v.get(key).with_context(|| format!("missing {key}"))
}
fn text<'a>(v: &'a Value, key: &str) -> Result<&'a str> {
    field(v, key)?
        .as_str()
        .with_context(|| format!("{key} must be a string"))
}
fn u64_string(v: &Value, key: &str) -> Result<u64> {
    Ok(text(v, key)?.parse()?)
}

impl Driver {
    async fn new() -> Result<Self> {
        let wasm_path = std::env::args_os()
            .nth(1)
            .map(PathBuf::from)
            .unwrap_or_else(|| {
                PathBuf::from(concat!(
                    env!("CARGO_MANIFEST_DIR"),
                    "/../target/wasm32-unknown-unknown/release/veil_registry.wasm"
                ))
            });
        let wasm = std::fs::read(wasm_path).context("read registry Wasm; build it first")?;
        let wasm_sha256 = format!("{:x}", Sha256::digest(&wasm));
        let worker = near_workspaces::sandbox().await?;
        let contract = worker.dev_deploy(&wasm).await?;
        let mut accounts = BTreeMap::new();
        for name in [
            "buyer", "bidder0", "bidder1", "bidder2", "executor", "hostile",
        ] {
            accounts.insert(name.to_string(), worker.dev_create_account().await?);
        }
        contract
            .call("new")
            .args_json(json!({"owner":accounts["buyer"].id(),
            "network_domain_hash":vec![42u8;32]}))
            .transact()
            .await?
            .into_result()?;
        Ok(Self {
            worker,
            contract,
            accounts,
            wasm_sha256,
        })
    }

    fn account(&self, name: &str) -> Result<&Account> {
        self.accounts
            .get(name)
            .or_else(|| self.accounts.values().find(|a| a.id().as_str() == name))
            .context("unknown local account alias or ID")
    }

    async fn time(&self) -> Result<Value> {
        let block = self.worker.view_block().await?;
        let now = block.timestamp();
        Ok(
            json!({"now_ns":now.to_string(),"block_height":block.height(),
            "suggested_bid_deadline_ns":(now+120_000_000_000u64).to_string(),
            "suggested_result_deadline_ns":(now+86_400_000_000_000u64).to_string()}),
        )
    }

    async fn job(&self, id: &Value) -> Result<Value> {
        let job: Value = self
            .contract
            .view("get_job")
            .args_json(json!({"job_id":id}))
            .await?
            .json()?;
        ensure!(!job.is_null(), "unknown job");
        Ok(job)
    }

    async fn call(&self, actor: &str, method: &str, args: Value) -> Result<Value> {
        let result = self
            .account(actor)?
            .call(self.contract.id(), method)
            .args_json(args)
            .max_gas()
            .transact()
            .await?
            .into_result()?;
        for log in result.logs() {
            eprintln!("contract: {log}");
        }
        // NEAR void calls return empty bytes, not JSON null.
        if result.raw_bytes()?.is_empty() {
            Ok(Value::Null)
        } else {
            Ok(result.json()?)
        }
    }

    async fn close_time(&self, job: &Value) -> Result<()> {
        let deadline = u64_string(&job["config"], "bid_deadline_ns")?;
        // Small jumps avoid the consensus epoch stall seen with a single huge jump.
        tokio::time::timeout(std::time::Duration::from_secs(90), async {
            for _ in 0..256 {
                let now = self.worker.view_block().await?.timestamp();
                if now >= deadline {
                    return Ok(());
                }
                let blocks = ((deadline - now) / 1_000_000_000 + 1).min(20);
                self.worker.fast_forward(blocks).await?;
            }
            bail!("deadline too far away; close advances at most 5120 blocks")
        })
        .await
        .context("fast-forward timeout; outcome unknown, inspect view; do not retry blindly")?
    }

    async fn command(&self, req: &Value) -> Result<Value> {
        let command = text(req, "command")?;
        if command == "now" {
            return self.time().await;
        }
        let actor = req
            .get("actor")
            .map(|v| v.as_str().context("actor must be string"))
            .transpose()?;
        if command == "create_job" {
            let config = field(req, "config")?.clone();
            let job = self
                .call(
                    actor.unwrap_or("buyer"),
                    "create_job",
                    json!({"config":config}),
                )
                .await?;
            return Ok(json!({"job":job}));
        }
        let id = field(req, "job_id")?;
        ensure!(id.as_str().is_some(), "job_id must be decimal U64 string");
        if command == "view" {
            return Ok(json!({"job":self.job(id).await?}));
        }
        let (actor, method, args) = match command {
            "bid" => (
                actor.context("bid requires actor")?,
                "submit_bid",
                json!({"job_id":id,
                "expected_job_binding_hash":field(req,"expected_job_binding_hash")?,
                "commitment":field(req,"commitment")?}),
            ),
            "close" => {
                self.close_time(&self.job(id).await?).await?;
                (actor.unwrap_or("buyer"), "close_bids", json!({"job_id":id}))
            }
            "begin_execution" => {
                if let Some(selected) = req.get("selected_executor") {
                    (
                        actor.unwrap_or("buyer"),
                        "begin_selected_attempt",
                        json!({"job_id":id,
                        "expected_bidset_root":field(req,"expected_bidset_root")?, "selected_executor":selected}),
                    )
                } else {
                    (
                        actor.unwrap_or("buyer"),
                        "begin_attempt",
                        json!({"job_id":id,
                        "expected_bidset_root":field(req,"expected_bidset_root")?}),
                    )
                }
            }
            "submit_receipt" => {
                let claim = field(req, "claim")?;
                ensure!(
                    claim.get("job_id") == Some(id),
                    "claim job_id differs from command job_id"
                );
                (
                    actor.context("submit_receipt requires explicit executor actor")?,
                    "report_result",
                    json!({"claim":claim}),
                )
            }
            "decide" => (
                actor.unwrap_or("buyer"),
                "decide_result",
                json!({"job_id":id,
                "expected_receipt_hash":field(req,"expected_receipt_hash")?, "accept":field(req,"accept")?}),
            ),
            _ => bail!("unknown command: {command}"),
        };
        let value = self.call(actor, method, args).await?;
        Ok(json!({"value":value,"job":self.job(id).await?}))
    }
}

fn emit(v: &Value) -> Result<()> {
    let mut stdout = std::io::stdout().lock();
    serde_json::to_writer(&mut stdout, v)?;
    writeln!(stdout)?;
    stdout.flush()?;
    Ok(())
}

#[tokio::main]
async fn main() -> Result<()> {
    eprintln!("starting disposable local NEAR sandbox");
    let driver = Driver::new().await?;
    let identities: BTreeMap<_, _> = driver.accounts.iter().map(|(k, a)| (k, a.id())).collect();
    emit(
        &json!({"event":"ready","protocol":"veil-registry-sandbox/v1","local_only":true,
        "contract_id":driver.contract.id(),"wasm_sha256":driver.wasm_sha256,"network_domain_hash":vec![42u8;32],
        "identities":identities,"time":driver.time().await?}),
    )?;
    // Blocking stdin is deliberate: one command at a time, worker lives across FHE/MPC pauses.
    // No automatic retries: an interrupted mutation can have an unknown outcome.
    for line in std::io::stdin().lock().lines() {
        let line = line?;
        let request: Value = match serde_json::from_str(&line) {
            Ok(v) => v,
            Err(e) => {
                emit(&json!({"id":null,"ok":false,"error":e.to_string()}))?;
                continue;
            }
        };
        let id = request.get("id").cloned().unwrap_or(Value::Null);
        let response = match driver.command(&request).await {
            Ok(result) => json!({"id":id,"ok":true,"result":result}),
            Err(e) => json!({"id":id,"ok":false,"error":format!("{e:#}")}),
        };
        emit(&response)?;
    }
    // Drop all account/contract worker clones before runtime shutdown; kills sandbox and removes temp state.
    drop(driver);
    eprintln!("stdin EOF: sandbox released");
    Ok(())
}
