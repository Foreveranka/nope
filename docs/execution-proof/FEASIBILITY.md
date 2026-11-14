# Historical execution-trace feasibility checkpoint

**Superseded implementation choice:** the shipped candidate uses the typed result relation in IMPLEMENTATION.md and PROTOCOL.md, not this unbuilt RISC Zero execution-trace proposal. Keep this historical investigation separate from actual evidence.

14 November 2026. Research/checkpoint only: no prover installed, receipt generated,
architecture changed, or escrow modified. Only this file is owned by this task.

## Decision and executable first target

**Choose native RISC Zero 3.1.0, Apple Silicon/Metal, proving the existing encrypted
evaluation relation.** Start with one actual v3 garbled request: one numeric row,
column C1, recipe `fill(7)`. Existing JS compilation measured **24 gates** and an
estimated **5,892-byte v3 request**. This is an AES-GCM evaluation proof, not a
plaintext reference calculation or a hash-only receipt.

Use the public JS compiler as an independently checked topology generator; do not
port the entire recipe compiler into the guest first. The guest evaluates supplied
topology bytes and commits their digest; the verifier regenerates those exact
bytes from the approved public plan and compares digests. Host assertions alone
are insufficient. This is the preferred implementation following MAIN's topology
hint proposal.

**GO for a bounded small-proof experiment, not a claim that all supported jobs fit.**
Installation and proving have not been measured here. Proposed trial limits:
at most **3 GiB additional disk**, leave **3 GiB free**, one build/proof at a time,
initial segment limit `2^18` cycles, and a **10-minute first-proof wall-time cap**.
These are engineering stop conditions, not vendor performance guarantees. If the
minimum components/build cannot meet the disk cap, stop and report component sizes;
do not download a full source checkout, Docker images, CUDA or Groth16 parameters.
No large downloads were made in this task.

## What was verified locally

- Machine: Apple M2, arm64, 17,179,869,184 bytes RAM = **16 GiB**. Free disk was
  about **6.0 GiB** initially and **6.4 GiB** at the last read.
- `web/plan-core.mjs`: normalization, aggregate gate/request bounds, canonical
  request/output hashing and program hashing.
- `web/plan-client.mjs`: fresh per-column preparation, local-only decoders and
  mapped result verification. `api/plan-gc.mjs` delegates each column to the actual
  evaluator in `api/recipe-gc.mjs`.
- `web/recipe-core.mjs` and `web/recipe-client.mjs`: gate topology, KDF/AAD bytes,
  AES-GCM table layout and typed value encoding.
- Existing `docs/verification/csv-browser-proof.json` explicitly says
  `executionProof:false`; it is a manifest/anchor, not a zkVM receipt. The scoped
  file search and SDK/integration documentation did not identify an existing
  RISC Zero/SP1 prover implementation to reuse. This is not a whole-repo audit.

Read-only JS compile/estimate measurements, **not zkVM benchmarks**:

| Recipe, one row | Evaluated gates | v2 request bytes |
| --- | ---: | ---: |
| number: fill 7 | 24 | 5,500 |
| number: fill 7, clamp 10..80 | 86 | 22,037 |
| text: lowercase | 624 | 130,011 |
| text: trim, lowercase, redact digits | 2,012 | 560,719 |

Each evaluated gate derives a key with SHA-256 and **authenticates/decrypts an
AES-256-GCM entry**. The current AAD/context is 118 bytes. KDF inputs are 135,
151 or 167 bytes for arity 1/2/3: three SHA-256 compression blocks each. An entry
contains IV12 + ciphertext16 + tag16. Standard GCM for this shape involves three
AES block encryptions and ten GHASH block steps, before implementation overhead.
Thus the 24-gate target includes 24 real AEAD checks, not merely hashing 24 values.
The 10,000-gate product cap is roughly 417 times its gate work; this is not a
wall-time extrapolation or a commitment to prove a maximum-sized request locally.

## Exact encrypted-evaluation relation

Prover inputs contain only the already authorized encrypted task:

1. Canonical v3 request bytes `R`, produced by `canonicalPlanRequest`.
2. An ordered topology bundle `T`: for each plan column, the exact canonical
   `compileRecipe(recipe).canonicalProgram` bytes, including its recipe/circuit.
   Define and pin a length-delimited/versioned bundle encoding before coding.
3. Public job context: profile, network/domain, contract/job identity and delivery
   version. No claim that the prover authenticates this context by itself.

No CSV, filenames, headers, samples, plaintext values, output-pair decoder,
unused label pairs, buyer keys or wallet keys enter the prover. The prover does
see active wire labels and derived ephemeral gate keys, as the evaluator already
does; these are not plaintext value mappings.

Guest steps:

1. Bound bytes, columns, rows, wire indices, gate count and all arrays. Parse the
   request and topology defensively. Reject unsupported profiles/opcodes and
   malformed base64/nonces. P0 rejects every shape except its explicitly supported
   one-row numeric case; never silently drops columns or operations.
2. Compute `SHA256(R)` inside the guest. The independent verifier compares it to
   the hash of the actual approved canonical request, not a host-provided digest.
3. Compute `SHA256(T)` inside the guest. Evaluate the same parsed bytes that were
   hashed. Validate topological wire dependencies and widths before indexing.
4. For each column, compute the SHA-256 of its supplied canonical program bytes,
   check the nested v2 `programSha256`, and use this computed digest in the KDF/AAD.
5. For each row/gate, select the table entry using the last-bit permutation of
   its ordered active input labels. Reproduce `recipeGateContext`: UTF-8
   `nope-csv-recipe-gc-v2/garble/` + program hex + `/`, nonce16, row u32BE and gate
   u32BE. Derive the key from context + arity byte + ordered labels.
6. Actually authenticate/decrypt the selected AES-256-GCM entry, with context as
   AAD and a 128-bit tag. Abort on failure; require a 16-byte output label. A
   supplied plaintext label or an unconstrained host crypto hint is not enough.
7. Collect the compiled output wires, serialize canonical v3 output labels in
   plan order, and compute their SHA-256 inside the guest.
8. Commit a versioned journal containing context, profile, request SHA, topology
   SHA, plan/program identifiers, nonce/row count and output SHA. Keep encodings
   explicit; a display string supplied by the host is not a proven computation.

Independent verifier composition:

```text
verify real receipt against pinned guest IMAGE_ID and corrected verifier version
derive expected public plan/context from the actual approved job/delivery
T_expected := topology bundle built by pinned JS compileRecipe(public plan)
check journal.topology_sha == SHA256(T_expected)
recompute hashPlan(plan), hashPlanProgram(plan), canonical request/output hashes
check request declarations and every journal/context digest against those values
accept only the exact delivery version/output; fail closed on any mismatch
```

This avoids a guest compiler port without trusting an arbitrary topology: the
proof establishes AES evaluation of T, and the verifier checks T = the approved
recipe's compiled topology. Merely comparing a host-asserted `programSha256` would
not establish that equality. JS/Rust serialization must be byte-exact; generic
Rust JSON maps may reorder keys. Hash the canonical request bytes directly;
use a fixed output renderer and canonical base64. Do not change v1/v2/v3 wire
encodings to simplify proving.

Proposed code split for the next authorized implementation: shared guest-safe
request/topology parser + AES-GCM evaluator; RISC Zero guest; local host using the
prebuilt prover; standalone verifier; JS differential/tamper harness. These files
have not been created. Existing escrow stays frozen.

## Real-receipt acceptance tests

1. Use actual `preparePlan` garbling of a synthetic one-row input; guest outputs
   must match `evaluatePlanRequest` byte-for-byte. The proof must contain real
   cryptographic seals, not a dev-mode execution transcript.
2. Verify the saved receipt in a separate process with only pinned verification
   code/IMAGE_ID, expected public context and ciphertext delivery. No decoder or
   original plaintext is needed. Compare all public bindings, not just seal validity.
3. Reject altered seal, journal, IMAGE_ID, job/version, plan, topology, labels,
   nonce, row/column order and output digest. Corrupting a selected GCM tag must
   fail guest evaluation; changing an unused entry must change request binding.
4. Reject fake/dev receipts even if environment variables request dev mode.
   RISC Zero's `disable-dev-mode` feature plus an explicit non-dev verifier context
   and rejection of `InnerReceipt::Fake` are required. Use full image/journal/exit
   verification, not only a lower-level integrity check.
5. Record toolchain/guest source hashes, IMAGE_ID, receipt hash/size, cycles,
   segment count, wall time, max RSS and disk growth. These measurements are
   **unknown today**. No successful real proof is claimed by this feasibility file.

## Current primary-source choice and costs

**RISC Zero:** fresh GitHub release API and crates.io checks returned **3.1.0**,
released 10 November 2026, commit
`22c5fb90522cb4d9427d4af6c05e747d20be2b7f`. A cached `/latest` page initially showed
3.0.6; do not use it. The 3.1.0 release fixes soundness/zero-knowledge defects affecting
older receipt formats and requires corrected prover/verifier circuits and regenerated
receipts. Pin matching `risc0-zkvm`, `cargo-risczero` and `r0vm` 3.1.0; its listed
`risc0-build` version is 3.0.7, not necessarily the SDK version.
[Release and upgrade requirements](https://github.com/risc0/risc0/releases/tag/v3.1.0).

Native arm64 macOS installation and Apple Metal proving are documented; Metal is
enabled by default on Apple Silicon. CPU proving also exists. The local-proving
docs advise smaller segments when available memory is below 10 GB. Groth16
shrink-wrapping is unsupported on Apple Silicon, so do **not** require it for the
first independent proof. Use a real composite STARK receipt first; optionally
measure succinct recursion later. Neither needs a Groth16 ceremony.
[Installation](https://dev.risczero.com/api/zkvm/install),
[local proving](https://dev.risczero.com/api/generating-proofs/local-proving),
[receipt kinds](https://docs.rs/risc0-zkvm/3.1.0/risc0_zkvm/enum.ReceiptKind.html).

Published archive metadata: arm64 `cargo-risczero` 3.1.0 = **51,568,850 bytes**;
latest listed custom Rust `r0.1.97.0` archive = **442,966,921 bytes**. The installer
source makes r0vm a component of the cargo-risczero distribution. These roughly
0.5 GB compressed assets are **not total install size**. Extracted toolchains,
Cargo dependencies, host/guest targets and trace files remain unmeasured. Range
requests to inspect gzip footers were refused, so no extracted-size claim is made.
Use prebuilt components and a client-only host with defaults/Bonsai disabled to
avoid compiling the whole native prover. No C++/CUDA/Groth16 download for this trial.
[Release asset metadata](https://api.github.com/repos/risc0/risc0/releases/tags/v3.1.0),
[Rust asset metadata](https://api.github.com/repos/risc0/rust/releases/tags/r0.1.97.0),
[installer components](https://github.com/risc0/risc0/blob/v3.1.0/rzup/src/components.rs).

RISC Zero recommends at least 16 GB RAM. First-use GPU kernel compilation can
take minutes. Its public M2 performance PDF is **April 2023**, not a 3.1.0 AES-GCM
benchmark: e.g. 256k cycles used 1.87 GB/3.39 s, and 2M cycles used 15 GB/21.21 s.
Those numbers cannot establish this guest's runtime. Use small sequential segments
and measure before increasing workload; do not run browser LLM inference concurrently.
No defensible current wall-time estimate exists before guest cycles are measured.
[Quickstart/RAM guidance](https://dev.risczero.com/api/zkvm/quickstart),
[historical datasheet](https://dev.risczero.com/datasheet.pdf).

SHA-256 acceleration has an official patched `sha2` path; AES-GCM is not listed
as a matching precompile. Plan for portable Rust AES-256/GHASH work in the guest,
not host WebCrypto or native AES instructions. RustCrypto `aes-gcm` 0.11.1 is a
current pure-Rust candidate, but guest compilation/parity is not tested. Keep RNG
features off: gate keys come from the request/KDF, not prover-created mappings.
[Precompiles](https://dev.risczero.com/api/zkvm/precompiles),
[AES-GCM implementation](https://docs.rs/aes-gcm/0.11.1/aes_gcm/).

**SP1 6.10.0:** a real CPU proof of the same evaluator is possible in principle.
Current docs list core/compressed minimums of 16+ CPU cores, 16+ GB RAM and 10+ GB
disk; current free disk is below that minimum. GPU acceleration requires Linux
x86_64/NVIDIA CUDA, not this Mac's Metal. Core/compressed STARKs are not currently
zero knowledge; Groth16/PLONK wrapping adds resource/setup requirements. This is
not the first choice on this 16 GiB/6.4 GiB machine, and no prover-network service
is authorized. EVM verifier costs are not NEAR gas estimates.
[Release](https://github.com/succinctlabs/sp1/releases/tag/v6.10.0),
[hardware](https://docs.succinct.xyz/docs/sp1/getting-started/hardware-requirements),
[security model](https://docs.succinct.xyz/docs/sp1/security/security-model).

## Browser PLONK alternative: valid but narrower statement

MAIN's committed-label proposal can be a genuine independent **result-correctness
proof**, not an unbound plaintext SNARK, provided these links are enforced:

```text
C_pairs = Poseidon(version/domain, shape, private random salt,
                   ordered input-wire (L0,L1) pairs,
                   ordered dedicated output-wire (L0,L1) pairs)
R_in  = Poseidon(domain_in,  shape, actual request's ordered active input labels)
R_out = Poseidon(domain_out, shape, actual delivery's ordered active output labels)

prove knowledge of the committed pairs/salt and bits x,y such that:
  each actual input label = committed input pair[x_bit]
  each actual output label = committed output pair[y_bit]
  y = exact typed recipe semantics(x)
```

The independent verifier must recompute R_in/R_out from the **actual published
request/delivery**, recompute their existing SHA-256 context, and compare exact
job/plan/program/version and public recipe parameters. A free public SHA field in
the circuit is not a connection to those transcripts. Use fixed domains, lengths,
column/row/wire order and 128-bit label packing/range checks; do not reduce an
unbounded byte string modulo the SNARK field. Require boolean indices, distinct
labels within each pair, fixed zero/one input-wire semantics and exact text presence
bits/padding, missing sentinel 255, clamp/fill order and ASCII-only transformations.
All recipe parameters must be constrained or hardcoded by the pinned circuit key.

C_pairs must be authenticated **before delivery is known**. A salted root created
afterward lets a client choose a convenient output mapping. Existing v3 schemas
have no such precommit field, and preparation keeps output pairs but discards input
pairs. This alternative requires explicitly authorized preparation/vault and
immutable precommit integration; timestamp claims in mutable metadata are not
independent evidence of precommit timing. Salt/pair witnesses stay client-local.

It does not prove AES-GCM evaluation, garbling honesty, original-file provenance,
execution origin or that a worker ran at all. A client knowing the pairs can
construct correct output labels itself. This is still a meaningful mathematical
result statement relative to the previously fixed mapping, but it is not the
preferred literal encrypted-execution proof.

Resource comparison: avoiding AES/GHASH substantially reduces the relation, but
Poseidon hashing/range-checking all label pairs is not free. Even one text cell
has 130 input + 128 output pairs = 516 private labels. A numeric cell has 18 pairs
= 36 private labels. A blanket 200k-constraint claim for every multi-column batch
is unsupported. Measure compiled R1CS **and converted PLONK gate/domain size**.
Power 18 means a 262,144-point SRS domain; it is not automatically sufficient for
200k arbitrary source constraints. snarkjs supports browser PLONK and a universal
Powers-of-Tau ceremony, but this remains a trusted-SRS assumption; pin and verify
the transcript and circuit key. Exact PTAU18 size was not verified: the asset HEAD
request was denied. Browser RSS/time and proving-key size are also unknown.
Registry metadata checked: snarkjs 0.7.6, circomlib 2.0.5, circomlibjs 0.1.7.
[snarkjs browser/setup documentation](https://github.com/iden3/snarkjs),
[PLONK domain calculation](https://github.com/iden3/snarkjs/blob/master/src/plonk_setup.js),
[Poseidon circuit](https://github.com/iden3/circomlib/blob/master/circuits/poseidon.circom).

## Integration and exact trust limits

- A pinned-image receipt proves the encrypted evaluator relation, not the host's
  physical identity, the HTTP server's execution history, or model provenance.
- Original-file encoding, honest garbling, decoder secrecy, semantic approval and
  correct compiler remain distinct obligations. A valid proof of a maliciously
  garbled circuit does not establish the intended plaintext transformation.
- An independent verifier must obtain expected job/delivery bindings separately;
  a valid receipt for an attacker-chosen job is not authorization for this job.
- Composite receipts reveal execution-length information; succinct recursion can
  hide that. The prover sees its witness. Neither route requires customer plaintext.
  [Security model](https://dev.risczero.com/api/security-model).
- Harden proof verification against fake receipts and pin corrected image/control
  parameters. [Dev-mode behavior](https://dev.risczero.com/api/generating-proofs/dev-mode),
  [receipt verification source](https://github.com/risc0/risc0/blob/v3.1.0/risc0/zkvm/src/receipt.rs).
- First integration milestone should be receipt + output + a standalone independent
  verifier. Browser WASM verification of **3.1.0** needs its own compilation and
  tamper/parity test; an old browser demo is not evidence it works today. Do not
  claim a local prover HTTP relay is integrated until the application can actually
  verify its receipt, rather than trust a returned `verified:true` flag.
- Frozen escrow does not verify any of these proofs. This task does not modify
  settlement rules or make payment proof-enforced. No paid network, customer-secret
  upload, toolchain install, implementation or proving benchmark happened here.
