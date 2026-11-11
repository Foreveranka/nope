# Veil NEAR registry (local prototype)

This Rust contract records immutable public job metadata, opaque bid commitments,
a deterministic full bidset, executor-reported result receipts, and explicit buyer
decisions. It does not execute FHE/MPC, validate commitment openings, verify an
execution proof, attest to hardware, determine an MPC winner, or make payments. A dishonest
authorized executor can report an arbitrary output hash; only the buyer can accept
that claim. Do not treat acceptance as cryptographic correctness.

All work in this target is local. No external chain/account, wallet credentials,
real funds, or customer records are used. Sandbox identities/balances are disposable
test fixtures. The deployment account's full-access keys can replace contract code;
upgrade governance and a production security audit are outside this prototype.

## Build and test

Pinned `near-sdk = "=5.30.1"`, with `Cargo.lock`. Official release source confirms
SDK MSRV 1.95 and minimum protocol version 85:

- [SDK release manifest](https://github.com/near/near-sdk-rs/blob/near-sdk-v5.30.1/near-sdk/Cargo.toml)
- [SDK workspace MSRV/version](https://github.com/near/near-sdk-rs/blob/near-sdk-v5.30.1/Cargo.toml)
- [SDK contract/init/nonpayable documentation](https://github.com/near/near-sdk-rs/blob/near-sdk-v5.30.1/README.md)
- [Official build tool documentation](https://github.com/near/cargo-near)
- [Rust 1.98.0 distribution manifest](https://static.rust-lang.org/dist/channel-rust-1.98.0.toml)

Verified from official sources on 2026-11-11. Actual tested compiler is Rust 1.98.0,
commit `88d9e12ae178fab0fb5cc050a94da85685d449ea` (2026-08-18), official distribution
dated 2026-08-20. This is a working installed release, not an inferred SDK version.
Compilation uses `--cfg near`, required by this SDK's current on-chain host path.
This is a local release Wasm build, not a Docker reproducible-build claim.

From `contracts/registry` on this arm64 macOS host:

```sh
./scripts/bootstrap.sh
RUSTFLAGS='--cfg near' ./scripts/cargo-local.sh build --locked --release --target wasm32-unknown-unknown
./scripts/cargo-local.sh fmt --check
./scripts/cargo-local.sh test --locked
./scripts/cargo-local.sh clippy --locked --all-targets -- -D warnings
mkdir -p .toolchain/tmp
TMPDIR="$PWD/.toolchain/tmp" ./scripts/cargo-local.sh test --locked --manifest-path sandbox/Cargo.toml -- --nocapture
```

Bootstrap uses the host's existing `rustup` executable but puts Rust/Cargo downloads
in ignored `.toolchain/`, changes no profile/global toolchain default, and installs
the Wasm target, rustfmt, and clippy there. Wrapper sets **one Cargo build job** and
uses the ignored local `target/`. It also supplies the scoped LLVM dylib fallback
path needed by the macOS 1.98 `rust-lld` distribution. Sandbox has a separate locked
manifest to keep its dependencies out of the contract package.

Output: `target/wasm32-unknown-unknown/release/veil_registry.wasm`.
`VERIFICATION.md` records actual checks and the artifact digest.

## Authority and interface

JSON uses byte arrays of exactly 32 integers for all hashes, decimal **strings** for
`U64` IDs/timestamps/attempts, and account ID strings. Timestamps are Unix nanoseconds.
All methods are nonpayable; explicit mutation guards also reject any attached
deposit. Failed chain calls roll back/refund attached deposits under NEAR semantics.
There are no promises, outgoing transfers, custody balances, fee claims, or withdrawals.
Unsolicited protocol-level native transfers cannot be blocked by contract code and
are not supported as a funding workflow. Storage/gas in sandbox uses synthetic funds;
the registry does not implement storage charging or production storage economics.

Every authorization compares `predecessor_account_id`, never the transaction signer.
Initialization is self-call-only and must be atomic with deployment. `#[init]` rejects
reinitialization. Registry owner is the immutable buyer for all jobs; no owner transfer,
metadata amendment, bidder replacement, deadline extension, bid deletion/replacement,
manual root setter, or automatic receipt acceptance exists.

| Method | JSON arguments | Caller / behavior |
| --- | --- | --- |
| `new` | `{owner, network_domain_hash}` | Contract self-call only; configured domain nonzero |
| `owner` / `network_domain_hash` | `{}` | Views |
| `get_job` | `{job_id}` | View, full job or null |
| `create_job` | `{config}` | Buyer; returns full new Job |
| `submit_bid` | `{job_id, expected_job_binding_hash, commitment}` | Fixed roster bidder, one nonzero commitment |
| `close_bids` | `{job_id}` | Anyone, at/after bid deadline; returns computed root |
| `begin_attempt` | `{job_id, expected_bidset_root}` | Buyer; returns new attempt binding |
| `begin_selected_attempt` | `{job_id, expected_bidset_root, selected_executor}` | Buyer; atomically authorizes a committed roster executor and starts v2 attempt |
| `report_result` | `{claim}` | Authorized executor; returns receipt hash |
| `decide_result` | `{job_id, expected_receipt_hash, accept}` | Buyer; exact current receipt only |
| `expire_job` | `{job_id}` | Anyone, at/after result deadline, eligible unfinished states |

The persistent Python-callable local sandbox executable and exact JSONL protocol
are in [`sandbox/PROTOCOL.md`](sandbox/PROTOCOL.md). It keeps one sandbox alive across
FHE preparation, bid closure, MPC, selected execution and buyer decision; EOF cleans
up the sandbox. It transports claims and does not run or prove FHE/MPC itself.

Selected execution leaves JobConfig and its v1 job hash unchanged. New Job fields
are `selected_executor: AccountId|null` and `attempt_binding_version: 1|2|null`.
Both are null before the first attempt. Selection requires a received commitment,
and the chosen account/mode are fixed for the entire job after any attempt starts,
including retries. Legacy attempts use Config.executor and version 1. Selected
attempts use the selected account exclusively and version 2; the old configured
executor cannot submit results. Selection emits `buyer_authorized_executor` with
`mpc_proof_verified:false`; this is an explicit buyer authorization, not a winner
proof. See the protocol for the exact versioned schema. Fresh local state only:
no deployed Borsh storage migration is implemented.

`JobConfig`: `spec_hash, circuit_hash, key_hash, output_policy_hash, context_hash,
input_hash, budget_commitment, bid_deadline_ns, result_deadline_ns,
authorized_bidders, executor`, in that exact serialization order. All hashes must
be nonzero. Context is application-selected public session/policy context; input
hash should identify the encrypted request, not plaintext. Budget is a hiding,
salted commitment chosen off chain, not an amount. No plaintext price/budget field
exists. Commitment values/openings are not validated by this registry.

Roster is **1..10 distinct accounts, sorted lexicographically by account ID** at job
creation. All entries, including missing commitments, keep those immutable slots.
For eventual MPC integration, lowest-slot tie breaking must use this canonical
account ordering, never transaction arrival order or submitted roster order. The
three-bidder MPC profile must additionally require exactly its three expected slots;
the registry itself permits up to ten. Non-omission means every successfully recorded
on-chain commitment is included, not that an off-chain submission was delivered.

Identical raw commitments within a job are rejected to prevent copying another slot's
commitment. Raw digest equality across different jobs is not proof of an opening;
use the contextual off-chain commitment recipe below.

## State and deadlines

```text
Open --close_bids--> Closed --begin_attempt--> Executing --report_result--> Reported
                                                                          |
                                          Rejected <--buyer rejects--------+
                                              |                           |
                                      begin_attempt                  buyer accepts
                                              |                           |
                                          Executing                    Accepted
```

At creation: `now < bid_deadline < result_deadline <= now + 30 days`. Deadlines
cannot change. Bid submission requires `now < bid_deadline`; close requires
`now >= bid_deadline` and accepts no entries/root from the caller. An empty set can
close but cannot execute. Attempt start/report require `now < result_deadline`.
Only one active attempt exists. Attempts start at 1, increment on explicit buyer
retry after rejection, and are capped at 16. Every report is retained with its buyer
decision and timestamps; no receipt can be overwritten or reused for another attempt.

At `now >= result_deadline`, anyone can expire Open/Closed/Executing/Rejected jobs.
Expired and Accepted are terminal. Permissionless expiry preserves all prior receipts.
**Reported is deliberately excluded from expiry:** a report submitted on time remains
available for the buyer's explicit accept/reject decision indefinitely. A late rejection
can then be expired; it cannot start a late retry. There are no callbacks or timeout
autoacceptance. Late executor messages are rejected whether or not expiry was triggered.

## Hash schemas (independently recomputable)

All hashes use SHA-256 over **Borsh**, never JSON serialization. Strings are UTF-8 with
little-endian u32 byte lengths. Vec has a little-endian u32 element count; u64 values
are 8 little-endian bytes; fixed `[u8;32]` is 32 raw bytes without a length; `Option<Hash>`
is byte `0` for None or byte `1` plus the hash for Some. Structs concatenate fields in
the order given. Tags below are Borsh **Strings**, including their length prefix.

```text
job_binding_hash = SHA256(Borsh(
  "veil/job/v1", current_contract_account, configured_network_domain_hash,
  job_id:u64, buyer:AccountId, config:JobConfig))

bidset_root = SHA256(Borsh(
  "veil/bidset/v1", job_binding_hash,
  Vec<BidEntry { bidder:AccountId, commitment:Option<Hash> }>))

attempt_binding_hash = SHA256(Borsh(
  "veil/attempt/v1", job_binding_hash, bidset_root, attempt:u64))

selected_attempt_binding_hash = SHA256(Borsh(
  "veil/attempt/v2", job_binding_hash, bidset_root, attempt:u64, selected_executor:AccountId))

receipt_hash = SHA256(Borsh("veil/receipt/v1", claim:ReceiptClaim))

ReceiptClaim exact order:
  job_id:u64, attempt:u64, job_binding_hash, attempt_binding_hash, bidset_root,
  spec_hash, circuit_hash, key_hash, output_policy_hash, context_hash, input_hash,
  budget_commitment, output_hash

Recommended off-chain bid commitment (opening is NEVER submitted here):
  SHA256(Borsh("veil/bid/v1", job_binding_hash, bidder:AccountId,
               encrypted_bid_payload_hash:Hash, random_salt:[u8;32]))
```

The root is a complete canonical vector digest, **not a Merkle tree or an MPC proof**.
Every claim field except the output is checked against stored job/attempt data.
The nonzero output hash is an executor claim; the contract cannot prevent a dishonest
executor from copying output bytes and producing a fresh, correctly contextualized
claim. It prevents replay of a previous receipt/context, not lies about computation.

Network domain is immutable, initialized by the deployer: NEAR's host API supplies
contract identity but no network ID. It must differ across networks, and the deployment
must use an appropriate unique domain. The contract cannot verify that configuration.

[`scripts/hash_schema.py`](scripts/hash_schema.py) is a stdlib-only independent Python
encoder for job, full bidset, attempt, receipt and off-chain bid hashes. Example:

```sh
python3 scripts/hash_schema.py --example
# Or pipe {"operation":"bidset_root","job":<full get_job response>} on stdin.
```

[`examples/lifecycle.json`](examples/lifecycle.json) contains concrete full JSON args,
callers, public job data and all expected hashes. Its 100/200 ns deadlines are mocked
test values, not current submission times. Rust tests execute the same fixture and
compare all four digests against this independently generated vector. Parent code
should fetch returned bindings/root and include them exactly in the subsequent calls.

## Optional public FHE evidence binding

```sh
REGISTRY_FHE_EVIDENCE="$PWD/../../docs/verification/http-fhe-check.json" \
TMPDIR="$PWD/.toolchain/tmp" ./scripts/cargo-local.sh test --locked \
  --manifest-path sandbox/Cargo.toml -- --include-ignored --nocapture --test-threads=1
```

The additional opt-in sandbox test reads only the completed run's public hash metadata:
`clientSpecsSha256 -> spec_hash`, `serverSha256 -> circuit_hash`,
`evaluationKeysSha256 -> key_hash`, `inputSha256 -> input_hash`,
`requestManifestSha256 -> context_hash`, `outputSha256 -> claimed output_hash`.
Policy and no-money budget use explicit synthetic demo domain hashes; they are not
claims that the original HTTP run precommitted to an auction policy or private budget.
It writes public accepted registry metadata under `verification/` when successful.
This is **post-hoc local demo binding**, not a precommitted secure workflow, FHE
execution proof, attestation, external deployment, or payment test. It neither loads
plaintext records nor decrypts or re-executes the job. The original FHE verification
remains the client's reference comparison, as the source evidence says.
