# Persistent LOCAL sandbox bridge

Run from any directory (the cargo wrapper changes its own working directory):

```sh
/Users/mete/near-private-procurement/contracts/registry/scripts/cargo-local.sh build --locked --manifest-path /Users/mete/near-private-procurement/contracts/registry/sandbox/Cargo.toml --bin registry-sandbox-driver
/Users/mete/near-private-procurement/contracts/registry/target/debug/registry-sandbox-driver
```

First build the contract Wasm after any contract change:

```sh
RUSTFLAGS='--cfg near' /Users/mete/near-private-procurement/contracts/registry/scripts/cargo-local.sh build --locked --release --target wasm32-unknown-unknown
```

Executable accepts an optional first argument giving a local Wasm path. It accepts
no RPC URL, account keys or external-chain configuration. Startup creates a fresh
disposable sandbox, deploys Wasm, initializes the registry and creates six accounts.
All balances/identities are synthetic. Stdout is JSONL only, flushed after each line;
diagnostics go to stderr. Keep stdin open across prepareFHE/MPC/FHE stages. EOF
releases account/worker references, terminates the sandbox and removes temporary
state. Do not use kill -9 as normal cleanup. Requests are sequential, with no retries
or idempotency cache: `id` only correlates responses. On a transport timeout the
parent must treat a transaction outcome as unknown and inspect state, not retry.

Startup emits exactly one ready line (no request required):

```json
{"event":"ready","protocol":"veil-registry-sandbox/v1","local_only":true,"contract_id":"...","wasm_sha256":"64 lowercase hex digits","network_domain_hash":[42],"identities":{"buyer":"...","bidder0":"...","bidder1":"...","bidder2":"...","executor":"...","hostile":"..."},"time":{"now_ns":"...","block_height":123,"suggested_bid_deadline_ns":"...","suggested_result_deadline_ns":"..."}}
```

The actual domain has **32 bytes of 42**, abbreviated above. Suggested bid deadline
is now +120 seconds; suggested result deadline is now +24 hours. They are suggestions,
never inserted or substituted in `config`. Use `now` immediately before creation
if preparation takes time. A shorter synthetic bid window can be used. Actual
deadlines must leave enough time for all transactions and later FHE computation.
`wasm_sha256` hashes the exact byte buffer read at startup and passed to deployment,
not a later reread of the on-disk build output. Pin it in parent-run evidence so a
parallel rebuild cannot change the identity of the already-deployed artifact.

Every request is one object with `id` (any JSON correlation value) and `command`.
Success: `{id,ok:true,result:...}`. Failure: `{id,ok:false,error:string}`. Malformed
JSON gets `id:null`; failure does not stop the process. A chain failure is rolled
back. A transport failure may have unknown outcome; a batched workflow is not atomic.
`actor` accepts one of the six aliases or its exact emitted account ID. All account
IDs **inside contract arguments** must be actual IDs, never aliases. The aliases
`bidder0..2` are not canonical tie slots; sort actual account IDs as `job.bids` does.

| command | Additional request fields | result |
|---|---|---|
| `now` | none | Same `time` object shape as ready |
| `create_job` | `config`: full unchanged JobConfig; optional `actor` default buyer | `{job}` |
| `bid` | `job_id`, `actor` required, `expected_job_binding_hash`, `commitment` | `{value:null,job}` |
| `close` | `job_id`; optional actor default buyer | `{value:bidset_root,job}` |
| `begin_execution` | `job_id`, `expected_bidset_root`, optional `selected_executor` actual ID; optional actor default buyer | `{value:attempt_binding_hash,job}` |
| `submit_receipt` | `job_id`, `actor` required, full SDK-built `claim` | `{value:receipt_hash,job}` |
| `decide` | `job_id`, `expected_receipt_hash`, `accept`: boolean; optional actor default buyer | `{value:null,job}` |
| `view` | `job_id` | `{job}` |

IDs, attempts and timestamps are decimal U64 **strings**. Hashes are arrays of 32
bytes. `close` advances sandbox blocks in jumps of at most 20, observes the actual
block timestamp until the bid deadline, then calls `close_bids`. It does not patch
contract state or fabricate a root. Advance is bounded to 256 jumps/90 seconds.
Use sensible local deadlines (e.g. 120 seconds); a far future deadline fails rather
than fast forwarding unboundedly. `close` may move time even if the eventual call
fails. Result deadlines continue to apply normally.

Ordering: prepareFHE -> create job -> submit all bid commitments -> close -> run
real MPC using the returned closed job/canonical slots -> buyer-selected start ->
bind FHE to the returned actual attempt -> evaluate -> submit SDK-built receipt ->
explicit buyer decision. Do not synthesize successful MPC/FHE evidence in the
bridge. It only transports local contract calls.

## Exact selection extension for SDK integration

JobConfig, job binding, bidset binding and ReceiptClaim are unchanged. New Job fields:

```
selected_executor: AccountId | null
attempt_binding_version: 1 | 2 | null
```

New jobs before execution: both null. Legacy `begin_attempt` jobs: executor null,
version 1. `begin_selected_attempt({job_id,expected_bidset_root,selected_executor})`:
executor nonnull, version 2. The driver maps `begin_execution` with a selection to
this method; omission calls legacy `begin_attempt`.

Both start methods are buyer-only and require Closed or Rejected, matching full
root, an unexpired result window and fewer than 16 attempts. Selected executor
must be a roster account with a received commitment. Selection and start are
atomic. Once any attempt starts, the mode and selected account are immutable for
the entire job, including retries. Config.executor remains the original committed
legacy executor; it does **not** retain reporting authority in selected mode.
`report_result` authorizes `selected_executor` when present, otherwise Config.executor.

v1 = SHA256(Borsh `(String("veil/attempt/v1"), job_binding_hash:[u8;32],
bidset_root:[u8;32], attempt:u64)`)

v2 = SHA256(Borsh `(String("veil/attempt/v2"), job_binding_hash:[u8;32],
bidset_root:[u8;32], attempt:u64, selected_executor:AccountId)`)

Borsh strings/AccountId = u32 LE byte length + UTF-8; u64 = LE. The field order
above is exact. Receipt v1 includes the resulting attempt hash unchanged and
therefore transitively binds the v2 selection. This is a buyer-authorized claim,
not an on-chain verified MPC proof. Old fixture JSON without either new field is
legacy-only. This is a fresh-local-state schema change; no deployed Borsh storage
migration is supplied or claimed.

Run the actual Python-to-Rust-to-Wasm test:

```sh
python3 /Users/mete/near-private-procurement/contracts/registry/sandbox/tests/driver_e2e.py
```

For the focused deployed-byte hash/ready/EOF check:

```sh
python3 /Users/mete/near-private-procurement/contracts/registry/sandbox/tests/ready_smoke.py
```
