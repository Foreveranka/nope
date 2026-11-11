# Persistent sandbox bridge and selected execution — 2026-11-11

Current artifact: **229,547 bytes**, SHA-256
`431e1bbfcf89c5f305e668c265b66d1cd70246a3546d59b48c578009be71c553`.
The [artifact record](verification/artifact.json) now describes this build; the
legacy evidence retained below refers to its own earlier artifact digest.

Only `contracts/registry/` changed. No parent SDK/service, external accounts,
deployment, credentials or real funds were used. Synthetic sandbox identities,
commitments and output hashes were used for the bridge tests. The bridge is a
persistent real local Wasm transaction transport, not an FHE/MPC implementation.

Implemented `begin_selected_attempt`: buyer only, after closure, matching frozen
root, selected executor must have a received roster bid. Selection and start are
atomic and immutable across the job's retries. JobConfig and its hash are unchanged.
Version 2 attempts bind the selected account in their hash. Version 1 behavior and
the original golden fixture remain unchanged. A structured selection event explicitly
marks `mpc_proof_verified:false`. Result submission routes exclusively to the selected
executor in version 2. New fields change stored Job Borsh layout: fresh local state
only; no migration of existing deployed state is implemented.

Actual passing checks for the current build:

- **20 unit tests + 1 compiled-Wasm test**, 0 failures: [log](verification/selection-unit-wasm.log).
  Includes selection before close, authorization via predecessor rather than signer,
  outsider/uncommitted selection, wrong root, immutable selection/mode across retries,
  selected result routing, stale attempts, attached money rejection, independent v2
  hashing and preservation of configuration/job hash. All earlier registry tests pass.
- **75 Python subprocess JSONL requests to the Rust driver and actual sandbox Wasm**:
  [log](verification/driver-e2e.log), [public synthetic evidence](verification/driver-e2e.json).
  Exercises two jobs, bid closure using actual block fast-forward, unauthorized selection,
  missing-bid selection, wrong root, wrong/stale receipt, cross-job replay, configured
  executor denied in selected mode, rejection/retry/acceptance, malformed-JSON recovery,
  and stdout protocol integrity. EOF returned exit code 0; the actual near-sandbox child
  PID was checked to have exited. No FHE/MPC computation is claimed by this test.
- Independent Python recomputation of the actual job, bidset, v2 attempt and both receipt
  hashes; malformed field/version pairs rejected: [record](verification/driver-independent-hashes.json).
- Rust formatting (contract and sandbox) passes. Contract Clippy with warnings denied passes:
  [log](verification/selection-clippy.log). Legacy Python-generated example is byte-identical.
- Sandbox/driver Clippy with warnings denied also passes:
  [log](verification/driver-clippy.log). The legacy actual-Wasm lifecycle regression
  passes on this artifact in 27.27 seconds: [log](verification/selection-legacy-sandbox.log).
- Final driver readiness metadata smoke passes: [record](verification/driver-ready-smoke.json),
  [log](verification/driver-ready-smoke.log). `ready.wasm_sha256` hashes the exact buffer
  read at startup and passed to deployment. The smoke replaced a temporary source copy
  after deployment, checked the emitted hash against the original bytes, called `now`,
  then observed clean EOF exit. The shared build output was not modified by this smoke.
  The 75-request lifecycle predates this metadata-only extension; final driver digest
  is recorded in the smoke evidence. No full FHE/MPC integration rerun was needed for it.

Exact executable path, build commands, ready message, transport response shape and
command arguments: [sandbox/PROTOCOL.md](sandbox/PROTOCOL.md). The parent owns SDK
adaptation; no parent files were edited. Keep stdin open across external FHE/MPC
stages, use the returned actual attempt when binding FHE, and never automatically
retry after a transport timeout.

---

## Historical legacy artifact verification (retained)

The following section records the prior v1-only artifact and its historical runs;
its hashes, counts and output sizes are not the current artifact metadata.

# Actual local verification — 2026-11-11

Only `contracts/registry/` was edited. No external deployment, account access,
real transfers or private inputs. All SDK/compiler/package downloads and build
artifacts are local/ignored. Cargo runs one compilation job to share this 16 GB host
with the other workers. No global shell/profile/toolchain defaults changed.

## Artifact

- Package: `veil-registry 0.1.0`; exact SDK `5.30.1`, locked dependencies.
- Compiler: `rustc 1.98.0 (88d9e12ae 2026-08-18)`; SDK MSRV is 1.95.
- Target: `wasm32-unknown-unknown`, release, `RUSTFLAGS='--cfg near'`.
- Path: `target/wasm32-unknown-unknown/release/veil_registry.wasm`.
- Size: **203,548 bytes**.
- SHA-256: **`1eecc921d159419afdf34a956feb3dccbefbbe7b80e5aad6e9a8f4160ddaf7f9`**.
- Machine-readable metadata: [`verification/artifact.json`](verification/artifact.json).
- Actual build output: [`verification/wasm-build.log`](verification/wasm-build.log).

The official Rust distribution and tagged SDK sources are linked in README.md.
The fresh macOS toolchain's Wasm linker initially could not find its packaged LLVM
dylib; the scoped wrapper's `DYLD_FALLBACK_LIBRARY_PATH` fixes that without modifying
system libraries. This is a compiled local artifact, not production/deployment approval.

## Passing checks

**18 Rust unit tests**, 0 failures, 0 ignored:

- Self-only initialization, nonzero configured domain; signer/predecessor forwarding attacks.
- Buyer-only creation; unique canonical roster of at most ten; increasing, bounded deadlines.
- Bidder authorization, wrong job binding, duplicate/replaced/copied commitments, zero hashes.
- Buyer/stranger early close rejected; exact deadline late bid rejected; immutable closed set.
- Independently encoded SHA-256/Borsh job hash and full bidset hash; omitted, reordered,
  substituted, or differently contextualized entries change the root.
- Attempt state, full root, nonempty set, authorization, 16-attempt bound and append-only history.
- Executor-only reports; all receipt context fields checked; same-attempt, cross-attempt and
  cross-job replay rejected; explicit buyer decision and exact current receipt hash required.
- Exact result deadline, expiry, terminal state and late executor messages; on-time reports
  stay buyer-decidable after deadline; prior rejected receipts survive expiry.
- Every mutation rejects attached deposits and failed calls preserve stored job state.
- Storage flush/Borsh round trip, JSON string U64 encoding, and Python-generated fixture
  match for job/bidset/attempt/receipt hashes.

**1 compiled Wasm validation test**, passing: validates the module with `wasmparser`,
checks all 11 registry entrypoints and confirms no `promise_*` imports (no outgoing
cross-contract/payment actions).

`cargo fmt --check` passes. `cargo clippy --locked --all-targets -- -D warnings`
passes. Logs: [`unit-and-wasm-tests.log`](verification/unit-and-wasm-tests.log),
[`clippy.log`](verification/clippy.log).

## Actual Wasm VM / sandbox checks

`near-workspaces = 0.24.0`, `near-sandbox 2.14.0`, local loopback node; temporary
test identities and synthetic balances only. **2 tests passed**, 0 failed, 0 ignored,
in **51.35 seconds**. Raw output: [`sandbox-tests.log`](verification/sandbox-tests.log).
After adding the contract account/domain to the public evidence record, the focused
FHE binding test passed again in **24.20 seconds**; no broad test rerun was needed.
Its output is [`fhe-binding-test.log`](verification/fhe-binding-test.log).

1. Actual Wasm deploy + initialization, hostile initialization/reinitialization,
   hostile creation/bid/attempt/report/accept calls, attached deposit rejection,
   early closing, bid replacement and late insertion, independent full-root
   recomputation, wrong-root report, report replay, and explicit buyer acceptance.
2. An additional opt-in test bound the existing HTTP/FHE run's public spec, circuit,
   evaluation-key, request-context, encrypted-input and encrypted-output hashes to
   a fresh sandbox job and executor claim, followed by buyer acceptance.

The second test's public metadata is in
[`sandbox-fhe-binding.json`](verification/sandbox-fhe-binding.json). It records the
source evidence digest, Wasm digest, domain, contract account, full accepted public
job and receipt. The source run is `docs/verification/http-fhe-check.json`; original
data, plaintext outputs and keys are not copied into the registry target.
All four hashes from that actual accepted sandbox job were then independently
recomputed with the Python encoder, and its Wasm digest matched the final artifact:
[`independent-fhe-binding-check.json`](verification/independent-fhe-binding-check.json).

This is **post-hoc binding**, not a workflow that committed before the FHE run.
`precommitted_workflow`, `execution_proof_verified`, `attestation`, and `external_chain`
are all false in the evidence. Policy and no-money budget values are synthetic demo
domains. No implication that the contract verifies FHE/MPC correctness follows from
successful registry acceptance.

Sandbox fast-forward originally caused a consensus-epoch stall in the optional test;
the final test follows observed block timestamps with a bounded timeout and no epoch
jumps. Exact-nanosecond boundary tests use NEAR's mocked unit runtime; sandbox tests
cover real Wasm calls before and after deadlines, not control over exact block times.

## Integration handoff

[`README.md`](README.md) defines every method and state transition, deadline/expiry
policy, the canonical account-order tie slots, configured-network limitation and hash
schema. [`examples/lifecycle.json`](examples/lifecycle.json) supplies complete concrete
JSON arguments/expected hashes; its timestamps are intentionally mock values.
[`scripts/hash_schema.py`](scripts/hash_schema.py) independently recomputes the four
registry digests from public metadata. Integration must preserve Borsh order, U64
little-endian encoding and length prefixes, regardless of JSON property ordering.

No changes were made to the parent HTTP service, SDK adapter, UI, FHE or MPC targets.
