# CSV evidence testnet commitment

Pinned `near-sdk = 5.30.1`, Rust 1.98.0; only the existing testnet owner is authorized. This stores an immutable manifest SHA-256, fixed profile, row/batch counts, owner, and first NEAR block timestamp. It does not execute CSV/FHE, verify privacy, verify a proof, or establish that claimed metadata describes the committed file.

The keyless child account is created, funded with exactly **0.3 test NEAR**, deployed and initialized atomically. No account access keys are added: deployed code is immutable. There is no upgrade, removal, transfer, key-management, or manifest-update method. The existing registry code/state is not changed. Owner pays transaction gas separately; preflight preserves at least 1 test NEAR after owner storage, allocation and 0.05 gas allowance. Code storage plus 2048 bytes of account/state reserve must fit the allocation before any signing.

## Main integration

From project root:

```sh
node contracts/csv-evidence/cli.mjs anchor HASH ROWS BATCHES
```

Exactly three arguments; HASH is 64 lowercase hex characters. Hash **the exact raw manifest file bytes** with SHA-256 at the trusted caller, without parsing/reserializing. CLI accepts no file paths, CSV values, arbitrary metadata objects, keys or plaintext. The `anchor(pathJSON)` interface is intentionally deferred until main supplies strict allowlisted manifest schemas; no arbitrary JSON-file input exists. Counts must satisfy `1 <= ROWS <= 32`, `1 <= BATCHES <= 8`, and `BATCHES == ceil(ROWS / 4)`.

stdout is one public JSON object with `network`, `contractId`, `manifestSha256`, `transactionHash`, `codeHash`, contract fields and independent observer block information. Errors use stderr and exit 1. `transactionHash` is null if the record already exists but no local journal is available. Exact duplicates return the original timestamp and journal transaction hash when available, without broadcasting; differing metadata for the same hash is rejected.

View ABI:

```json
{"method_name":"get_manifest","args":{"manifest_hash":"64-lowercase-hex"}}
```

Returns null or `{manifest_hash,profile,row_count,batch_count,recorded_at,owner}`. `recorded_at` is a decimal nanosecond string. `record_manifest` accepts exactly those first four input fields, profile `nope-csv-evidence-v1`; `new` accepts exactly `{owner}`. The contract's bounded JSON parser rejects unknown/duplicate fields, escapes, nested values, noninteger counts, missing fields and trailing input. Contract stores packed opaque commitments only.

## Safety and reconciliation

Existing registry `near-api-js` is loaded via relative `createRequire`; no npm installation. Only the existing 0600 ignored owner identity is read, never copied, logged or returned. Ignored local runtime contains 0600 fsynced transaction journals and an exclusive operation lock. No new wallet key is generated. Root's `runtime/` ignore covers nested runtime too; local `.gitignore` also covers runtime, target, deploy/node_modules and node_modules.

**Main confirmed no other signer activity for initial deployment.** All future users of the shared owner must serialize signing with this CLI; its lock serializes CSV commands, not unrelated signers. Do not run another owner signer concurrently. No code imports enable CSV service integration automatically; main controls `NOPE_ENABLE_CSV_ANCHOR=1` and its read-only public endpoint.

Each exact transaction is signed once and journaled before broadcast. Any timeout/unknown response must be reconciled by querying the journaled transaction hash. Repeating the same CLI request only queries that hash; it never signs/rebroadcasts again. Failed/expired journals intentionally require manual inspection, not deletion and blind retry. Existing child accounts are not overwritten. No gas/fund topups or mainnet operations exist.

## Build and verify

```sh
node contracts/csv-evidence/build.mjs
contracts/csv-evidence/cargo-local.sh test --locked --offline
node --test contracts/csv-evidence/cli.test.mjs
node contracts/csv-evidence/cli.mjs plan
node contracts/csv-evidence/cli.mjs deploy
python3 contracts/csv-evidence/verify.py HASH ROWS BATCHES
```

Public source/wasm hashes are in `evidence/build.json`; actual deployment is in `evidence/deployment.json`. Build uses existing scoped Rust libraries; ignored Wasm stays under target. The independent Python verifier uses plain HTTP JSON-RPC, never loads keys, checks deployed code hash, keylessness, exact manifest and final block. CLI sends through FastNEAR and verifies through official NEAR testnet RPC. Main should anchor its actual synthetic integration manifest after deployment; no stand-in manifest is anchored by this worker.
