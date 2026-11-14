# Browser proof relation review: committed GC labels and typed result correctness

**Implementation update:** the relation below is implemented in proof-runtime and the v4 wrapper. See IMPLEMENTATION.md and INTEGRATION.md for current tests and integration; the following source observations describe the earlier design checkpoint. This review alone remains neither a security audit nor execution-origin evidence.

Date: 2026-11-14. Scope: a proposed browser PLONK-style proof, inspected against the current GC implementation. This is a relation specification and attack review, **not an implemented proof, benchmark, security audit, or proof of the existing production run**. No dependencies were installed, and no chain calls were made for this review. The escrow relay remains frozen.

## Decision

**Yes, conditionally:** an authenticated pre-execution commitment to **ordered, indexed, distinct 0/1 label pairs**, combined with constrained bit selection and the exact approved typed function, can support a genuine zero-knowledge proof that the delivered labels represent `F(x)` for the input represented by the actual request. This is stronger than comparing transcript hashes. Knowledge soundness and zero knowledge must come from an actual, correctly implemented proof system with approved parameters and verifier key.

**No, the short description alone is insufficient.** It leaves essential constraints, serialization and commitment authentication unspecified. In particular, a commitment to an unordered pair/set permits a false output to be reinterpreted by swapping its semantic bit mapping. A root claimed by the prover rather than recomputed from the published request/delivery also permits a proof about a different input/output.

The defensible claim is:

> The exact delivered encoded result has the approved typed semantics relative to the exact input-label selection and the client's previously committed bit mappings, under the honest-client encoding/garbling assumption.

It does **not** prove that the selected provider ran the evaluator, that AES garbling was honestly constructed, that the committed input came from a particular original CSV, that the planner interpreted natural language correctly, or that the LLM generated the plan. A client owning all pairs can compute `F(x)` locally, select its output labels and prove the same result without evaluator work. That does not invalidate a result-correctness claim; it rules out a provider-work/execution-trace claim.

## Source facts that constrain this design

- [recipe-client.mjs](../../web/recipe-client.mjs), `prepareRecipe`: fresh 16-byte label pairs per row/wire; pair index is the semantic bit. Input bytes expand **least-significant bit first**, followed by constant bits `0,1`. Request inputs contain one selected label per input wire. Only **output pairs** survive in the returned decoder; input pairs are currently discarded. A post-execution prover cannot recover the proposed input-pair witness from the current saved decoder.
- [recipe-core.mjs](../../web/recipe-core.mjs), `compileRecipe`, `encodeRecipeValues`, `referenceApply`: numeric inputs have 8 data bits plus two constants; text has 128 data bits plus two constants. Outputs use dedicated COPY wires. Numeric missing value is 255. Text consists of 16 ASCII bytes, each tagged with a presence high bit; absent padding is zero. Recipes have 1–4 ordered operations.
- [plan-core.mjs](../../web/plan-core.mjs), `canonicalPlanRequest`, `hashPlanProgram`, `canonicalPlanOutput`: plan/task/output **column order matters**. There are up to four selected column aliases. Program hashing includes the normalized plan and compiled per-column circuits; request hashing includes the encrypted tables and selected labels.
- [workspace/gc.mjs](../../workspace/gc.mjs) and [workspace/core.mjs](../../workspace/core.mjs): `job.taskHash` currently means the canonical **encrypted GC request** hash. `plan.taskHash` means the public planner-task description hash; these are different objects and must not be conflated. Delivery version, output hash and program hash are explicit. Current validators have no proof-commitment manifest, and the current acceptance path does not verify a SNARK.

These are implementation observations, not evidence that a proposed circuit already enforces the same rules.

## Threat model and precise meaning of soundness

Separate three roles even if two run in the same browser:

1. **Committer/garbler at setup:** assumed honest when choosing and encoding the original input, producing the GC request/decoder, assigning each label pair's 0/1 order, and committing those exact pairs before execution. No witness material leaves the browser.
2. **Prover after setup:** may attempt to prove an incorrect delivered result using any witness, including all unused labels it knows. Soundness must hold against this role after the commitment is fixed. An honest-setup assumption does not excuse an unconstrained proof witness.
3. **Verifier:** obtains the exact public ciphertext transcript, approved plan/program information, expected job/context and authenticated precommitment. It checks these itself, then invokes a pinned proof verifier. It never receives labels' alternative pairs, bit mappings, input bits or salts.

Assume the selected commitment hash is collision resistant for the specified encoding, the proof system satisfies its required soundness/zero-knowledge assumptions, and setup/verifier-key requirements are satisfied. These are explicit assumptions, **not properties established by this review**. A digest stored beside attacker-editable data is not an authenticated precommitment.

## One sound public statement

Use a new, versioned proof protocol. Do not silently change what existing `taskHash` or `outputSha256` means.

Let `T` be the canonical base GC request, including all selected input labels and encrypted tables. Let `D` be the normalized approved typed plan and deterministic compiled program. Let `O_v` be the exact ciphertext output-label arrays for delivery version `v`.

The verifier's expected public data must determine:

- protocol/relation version, commitment hash parameters/encoding version, proof-system and approved verifier-key identifier;
- network, escrow contract, 32-hex job ID, buyer commitment and, for the final delivery statement, selected-provider/award binding;
- `H_GC = SHA256(canonical(T))`, approved public-task hash, plan hash, program hash, and compiler/semantics version;
- profile, outer and per-column nonces, ordered column aliases/types, row counts, exact bit widths and the deterministic input/output wire-index lists;
- authenticated input-pair root `C_in` and output-pair root `C_out`, fixed before execution;
- input-selected-label root `S_in`, recomputed from **T itself**;
- output-selected-label root `S_out`, recomputed from **O_v itself**;
- exact delivery version, canonical output hash and award/escrow binding used by acceptance/payment.

All field encodings must be injective: 128-bit labels as range-constrained 128-bit limbs in a field that can hold them; 256-bit digests/salts as two range-constrained 128-bit limbs (or another explicitly injective byte encoding). Never cast arbitrary 256-bit values into one field element by reducing modulo the field prime. Length-prefix byte strings and lists. Specify endianness once.

### Avoid a commitment/hash cycle

Do not define `C_in = H(taskHash, pairs)` while also defining `taskHash = H(requestIncluding(C_in))`.

An acyclic option is:

1. Finish base request `T`, compute `H_GC` using the existing canonical GC encoding.
2. Build pre-execution context `J0` from job ID, buyer commitment, network/contract, profile, `H_GC`, plan/program/compiler identifiers, dimensions, aliases and nonces. It excludes roots that have not yet been computed and future delivery values.
3. Compute `C_in` and `C_out` from `J0`, the ordered pairs and private salts. Produce a public precommitment manifest `M` containing `J0`, both roots and relation/encoding identifiers.
4. Authenticate/freeze `M` before the evaluator can execute. A new versioned task envelope may hash `{baseRequest:T, proofManifest:M}` into a new outer task hash. The existing escrow contract can store an opaque hash, but the application must deliberately implement and verify this new envelope/profile. Existing jobs keep their existing hash meaning.
5. Once awarded/delivered, the final proof statement also binds the outer task/manifest hash, award binding, `v`, `S_out` and canonical output hash. Do not retrofit a future award/delivery hash into an already committed pair-root context.

Alternatively, a separate authenticated append-only pre-execution manifest can bind `M` to the existing GC task hash. That retains the manifest issuer/order mechanism as a trust dependency. **The current escrow terms do not contain pair roots or a proof-manifest hash.** Attaching an unanchored manifest after delivery cannot establish a prior commitment. An independent on-chain precommitment claim requires a real authenticated commitment path; an ordinary backend timestamp alone does not supply that claim.

### Root definitions

For each role, flatten coordinates in an explicit order: `(planStepIndex, columnAlias, rowIndex, inputOrOutputWireIndex)`. Include counts, types, dimensions and role-domain tags in the encoding. Reject missing, extra or reordered entries.

A pair leaf commits to `(role, coordinate, L0, L1)` **in that order**. A selected-label leaf commits to `(role, coordinate, Lselected)`. Fold leaves with a fully specified Poseidon construction: field, parameters, domain separators, length/padding rule and tree shape must be identical in browser, circuit and verifier. A flat length-delimited sponge or indexed Merkle tree can work; an unspecified `Poseidon(array)` is not yet a protocol.

Use a fresh private 256-bit salt for each pair-root role, or one fresh salt with unambiguous role-separated derivations. If a Merkle construction is used, domain-separate leaves, internal nodes and the salted root envelope. The salt's presence is not a proof of binding or hiding; those remain cryptographic assumptions of the actual construction. Selected labels are already visible in ciphertext transcripts; their roots can be publicly recomputed without revealing the salt or pair alternatives.

## Witness and constraints: what must actually be proved

Private witness: every committed input/output pair, salts, encoded input/output bits and any intermediate arithmetic/Boolean witnesses needed by the approved typed program. Retain these buyer-locally; a hosted prover receiving them would receive the decoding information and input semantics.

For **every** indexed input and output wire:

```text
L0, L1 are canonical 128-bit labels
L0 != L1
b * (b - 1) = 0
Lselected = L0 + b * (L1 - L0)
```

If labels use multiple limbs, enforce the same Boolean selector for every limb. Recompute both ordered pair roots and both selected-label roots from these constrained values. Require equality with the verifier-derived public roots. Roots must not be unconstrained public signals or assigned only in witness-generation JavaScript.

Current GC pairs have opposite low permutation bits. Enforcing that property also guarantees per-pair distinctness and matches the implementation; **do not equate the permutation bit to the semantic bit**. Semantic bit zero is pair position zero, whose low permutation bit is randomized.

For each row, constrain the two selected constant-wire bits to exactly `0` and `1`. Include their selected labels and pairs in the input roots if those roots describe the full request input array. Do not silently discard those final two inputs.

Reassemble bytes as `sum(bit[k] * 2^k, k=0..7)`, LSB first. Prove the exact typed function for all rows and columns, in public plan order, and connect its output bits to **the same** output-selection witnesses used for `S_out`.

Two sound implementation choices are:

- A circuit compiled for an approved fixed public plan/program, with verifier key pinned to that relation and plan/program identifiers.
- A bounded interpreter circuit whose public opcode/parameter/wire arrays are reconstructed by the verifier from the approved plan. Constrain all opcode choices, indices, bounds, active lengths and padding. A program hash carried as an unused public input does not select a program.

A circuit-specific verifier key is not supplied freely by the prover. Neither a prover-chosen key nor a prover-chosen unconstrained program is an acceptable verification policy.

### Exact typed semantics

**Number:** input/output bytes have 8 Boolean bits. `255` is missing. `fill(c)` replaces only 255; `c` is 0..254. `clamp(lo,hi)` leaves 255 unchanged and otherwise clamps to inclusive `lo..hi`, with `0 <= lo <= hi <= 254`. Evaluate steps sequentially on each step's current value. For missing input, `fill(0); clamp(10,100)` produces 10, while `clamp(10,100); fill(0)` produces 0. Comparisons must use bounded integers, not unconstrained field comparisons.

**Text:** each of the 16 bytes has seven ASCII bits plus a presence bit. Presence is a prefix of ones then zeros; absent bytes are exactly zero. A present NUL is encoded as 128 and is **different from absent padding 0**. `trim` removes only ASCII space 0x20 at the ends; it does not trim tabs or internal spaces. Case changes affect only ASCII A–Z/a–z. Digit redaction maps ASCII 0–9 to `*`. Preserve the exact tagged-byte representation after each operation, including all-space input and embedded NUL. Prove output padding/canonicality as well as input canonicality.

A proof of a hand-written approximation that treats 255 as a normal clamp input, trims arbitrary Unicode whitespace, drops embedded NUL, truncates text or reorders recipe steps would prove a different function from this application.

## Concrete attack cases the final circuit/verifier must reject

| Missing condition | Attack and result | Required rejection |
| --- | --- | --- |
| Ordered pair semantics | One-bit identity: committed input pair `(a0,a1)`, selected `a0`; real output pair `(z0,z1)`, bad delivery `z1`. If a root hashes the **sorted set** `{z0,z1}`, open it as `(z1,z0)` and claim output bit 0. Identity holds inside the proof while the original decoder reads 1. No collision is needed. | Commit `L0,L1` positions and constrain selection from those positions. |
| Pair commitment fixed before delivery | After seeing any bad delivered label, choose a new pair containing it in the bit position needed by `F(x)`, then publish that new root. A 256-bit salt does not prevent this. | Verifier compares roots to the authenticated prior manifest, not the proof package's preferred roots. |
| Actual selected-root recomputation | Prove a valid result for private input 0, attach the actual request hash for input 1 as a decorative public field, but supply the prover's own `S_in`. | Derive `S_in` from exact request labels and `S_out` from exact delivered labels; compare all expected context fields. |
| Boolean selectors | With small field-embedded labels `(10,20)`, selected label 15 satisfies the linear selector equation at `b=1/2`, but belongs to neither pair position. Checking only the aggregate byte range is also insufficient: selectors `b0=2,b1=-1` yield byte `b0+2*b1=0`. | Booleanity on every selector and exact integer encoding. These illustrate malformed witnesses, not an assertion that an honest request generates such labels. |
| Indexed ordered rows/columns | Identity on two rows `[1,2]` with delivered row order `[2,1]` passes a multiset/sorted selected-label commitment. A valid column can also be duplicated to cover an omitted column. | Bind roles, dimensions, unique aliases and every row/wire coordinate; prove every active slot. |
| Actual plan/program selection | Intended clamp maximum is 100; prover chooses a 200-maximum circuit and proves input 150 -> output 150, while displaying the intended program hash. | Pinned plan-specific verifier key or constrained public interpreter program derived from the actual plan. |
| Constant-wire values | A prover selects both constant inputs as 0, changing comparisons/constants despite presenting the approved program. | Force the final two input bits to 0 and 1 and bind their actual request labels. |
| Distinct pairs | If `L0 == L1`, either bit can explain the same selected label, and the semantic interpretation is not unique. | Pair inequality or the implementation's opposite-permutation-bit constraint. |
| Canonical field encoding | Distinct 256-bit byte strings that differ by the field modulus collapse under reduction; a digest/salt/account encoding can acquire two interpretations. | Range-constrained limbs, canonical field elements and length-delimited byte serialization. |
| Version/context authentication | Replay an old version's valid proof after a revision, or relabel it for another provider/job/plan. | Expected job/award/nonce/manifest context and latest exact `v`/output hash; bind context into constrained statement/commitment calculations. |
| Typed padding/missing rules | Treat absent text and present NUL identically, or clamp missing 255 to 100. A proof can then pass the wrong reference function. | Exact byte, presence, sentinel, order and range constraints above. |
| Verifier policy | Supply an arbitrary verifier key for a trivial satisfiable circuit. | Allowlist the actual relation/key/parameters and expected public-input ordering. |

The order-swap attack remains relevant even when initial garbling was honest: an adversarial later prover can know both pairs and exploit an unordered commitment. Conversely, if the initial client itself commits invented mappings unrelated to its decoder/GC, the proof may still be sound **relative to those invented mappings**. Honest mapping/garbling at setup is the stated assumption, not something this relation proves.

## Why the complete relation is meaningful

Fix an authenticated pre-execution manifest and the actual public transcripts. Suppose verification accepts, under the proof system's soundness assumption. The proof constraints then have a satisfying witness.

1. Binding of the ordered, injectively encoded pair commitments fixes the 0/1 mapping at each coordinate, except with the assumed hash-binding failure probability.
2. Distinct pair labels plus Boolean selection fix a unique semantic bit for each actual selected label. The verifier's independent selected-root calculations prevent choosing a different transcript, except with the assumed commitment collision failure.
3. The bounded typed-program constraints force the output bytes to equal the approved `F` of those input bytes, for every active row/column.
4. Output selection and the externally checked delivery/version/context bind those exact output bits to the actual delivered labels for this job.

Consequently the delivered labels encode `F(x)` under the precommitted mappings. This argument needs **no assertion that a hash proves execution**. It uses an actual sound proof of selection, commitment openings and function evaluation. It also shows exactly where honest client setup is needed to identify `x` with the original CSV and the committed mappings with the actual garbler/decoder meanings.

## Verifier flow without revealing plaintext

The public evidence bundle can contain ciphertexts, metadata/manifest authentication, roots, proof and key identifier. Literal ciphertexts plus a proof **without an expected authenticated manifest/context and approved verifier key** are insufficient.

1. Authenticate the expected job and prior manifest; select an approved relation/key. Validate all versions and reject unsupported plans.
2. Parse and canonicalize the exact GC request and latest delivery using the application formats. Recompute full ciphertext request/output hashes and normalized plan/program identifiers. Compare to immutable job/payment bindings.
3. Extract every selected input/output label in the specified coordinate order; derive `S_in`/`S_out` itself. Reject missing/extra/misordered rows, aliases, wires, nonces or widths.
4. Assemble public inputs itself from those expected values; do not pass through a prover-supplied public-signal array unchecked.
5. Verify the actual zero-knowledge proof and expose the narrow semantic-result claim above. Record proof digest/key/relation identifiers with the exact delivery before acceptance/payment can use proof status.

Public SHA-256/ciphertext canonicalization can run outside the SNARK because the verifier has those public bytes. The equality between the actual selected labels and the proof's constrained selected roots must still be checked. This does not require placing all multi-megabyte AES-GCM tables and SHA-256 computations inside a Poseidon/typed-semantics circuit. It also does **not** prove those tables implement the approved program; that is the deliberate honest-garbler boundary.

## Feasibility and main's choice

**A bounded browser result proof is a plausible engineering candidate, not currently demonstrated.** The existing root package contains no implemented PLONK circuit/prover/verifier for this relation. This review supplies no proving-time, memory or setup benchmark. Tool/library selection, approved parameters, an actual proof and independent verification remain gates before claiming feasibility.

The strongest reason to explore this route is that a semantic-result circuit can prove the compact typed computation and label selections without replaying AES-GCM/SHA-256 for every garbled gate inside a proof VM. That is a structural comparison, not a measured speed comparison to Nash's separate RISC0 investigation.

Witness retention is a concrete required change: preserve input-pair arrays and encoded input bits at preparation time, as well as the existing output pairs, in browser memory or authenticated encrypted local storage. New decoder schemas must never serialize this witness into the task sent to a provider or ordinary hosted prover. Historical tasks with discarded input pairs cannot gain this relation retroactively by inventing a new commitment.

Illustrative **dimension upper bounds, not simultaneous worst-case benchmarks**:

- Four numeric rows, one column: `4*(10 input + 8 output) = 72` committed pairs, 144 16-byte labels = 2,304 label bytes, plus salts, bit witnesses and proof-system overhead.
- Four numeric columns at 32 rows: at most 2,304 input/output pairs, 73,728 pair-label bytes.
- Four text columns at 8 rows: at most 8,256 input/output pairs, 264,192 pair-label bytes. The independent 10,000-GC-gate/request-size limits can rule out particular recipes before this dimensional ceiling.

Poseidon operations, Boolean/range/typed constraints and proving-key memory still need to be measured. The witness byte count is not a proving-memory estimate. Start with an explicitly approved bounded plan, prove **all** its selected columns/operations, and disclose any narrower supported scope; do not prove only the numeric column of a mixed plan while marking the whole job verified.

**Choice rule:** use this route if the intended claim is transferable correctness of the delivered result under existing honest-client setup trust, and a real in-browser proof plus independent verification passes the mutation suite below. If the required claim is that the evaluator executed the exact ciphertext/AES program, this relation is insufficient; require an actual execution-trace relation such as the independently evaluated VM route. Neither route automatically proves original-CSV provenance or honest garbling.

### Minimum evidence before calling the route implemented

- A real proof generated locally in the browser, with relation source, field/hash/encoding parameters and pinned verifier key/proving artifact identities recorded.
- Independent verification against the actual public request/delivery and authenticated precommitment; no witness or decoder sent to the reviewer.
- Rejection evidence for pair polarity swaps, reordered rows/columns, wrong roots, altered selected labels, wrong program/plan/key, missing constants, bad selectors, noncanonical encodings, invalid text padding and stale delivery/job context.
- A proof generated after delivery that opens the **same** committed pair roots from before execution. Demonstrate rejection of newly chosen roots.
- Full supported typed semantics checked against current compiler/reference vectors: missing 255, clamp boundaries, operation-order examples, empty/all-space/embedded-NUL text and ASCII case/digit boundaries.
- Browser timing/memory/artifact sizes measured on the exact claimed profile; distinguish successful proving from circuit compilation or mere proof parsing.
- Existing job acceptance/payment remains unproven by a SNARK until it actually enforces the exact proof relation/version/key and delivery binding. Do not replace that gate with a hash or a UI boolean.
