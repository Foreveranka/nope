# Typed result-correctness proof — implementation

14 November 2026. Real numeric/text proofs implemented and independently verified;
browser UI/CSP and application integration remain MAIN-owned.
RISC Zero is frozen. Only `proof-runtime/**` and this file are owned here.

Verified backend: Noir 1.0.0 + Barretenberg UltraHonk 6.0.0 WASM. Official
browser/runtime pattern: https://docs.aztec.network/developers/docs/tutorials/contract_tutorials/note_hash_proof
and https://noir-lang.org/docs/guides/building_a_web_app .

## Frozen runtime API and root encoding

BN254 scalar field. Labels are canonical 16-byte base64 decoded as an unsigned
**big-endian u128**, so the label's last permutation bit is the integer's low bit.
Digests/salts are 32-byte lowercase hex split into `[high128,low128]`; no field
reduction. All returned field strings are canonical unsigned decimal.

`poseidon2Hash4([a,b,c,d])`: Barretenberg/Noir standard Poseidon2 hash of four
BN254 fields (not just its permutation). `fold(domain, fields)` starts with
H4(domain,1,fields.length,0), then processes triples in order using
H4(acc,a,b,c), zero-padding only the final triple. Original length is committed.

Row root header: `[typeCode,column,row,preContextHigh,preContextLow,stepCount,
opcode0..3,param00..param32]`. Codes: type 1 number / 2 text; opcodes 1 fill,
2 clamp, 3 trim, 4 lowercase, 5 uppercase, 6 redactDigits; 0 is padding only.
Each operation has three u8 parameters: fill `[value,0,0]`, clamp `[min,max,0]`,
text `[0,0,0]`; all unused operation slots and parameters are zero.

Domain integers: 101 input pairs, 102 output pairs, 103 input selection,
104 output selection, 105 final statement. Pair roots fold header, two private
salt limbs, and ordered `L0,L1` fields for every input/output position. Selected
roots fold header and actual selected labels. Input includes constants 0,1.
Final statement folds header, final-context limbs and all four roots.

Pre-context SHA-256 is derived by the v4 adapter from the acyclic base GC hash and
approved job/plan/program/nonce/index information, before pair commitments.
Final-context SHA-256 binds the authenticated manifest/outer task, award, exact
delivery version and ciphertext-output hash. Pair roots do not depend on it.
Neither context is accepted merely from the proof package: the verifier derives
both from the expected real job/transcripts. No current v3 hash is redefined.

`proof-runtime/sdk.mjs` exports:

```js
await commitRow({type,preContext,column,row,recipe,inputPairs,outputPairs,
                 inputSalt,outputSalt}) // -> {inputPairRoot,outputPairRoot}
await selectedRoot({role,type,preContext,column,row,recipe,labels}) // decimal Field
await makeStatement({type,preContext,finalContext,column,row,recipe,
                     inputPairRoot,outputPairRoot,inputLabels,outputLabels})
// -> public statement with independently derived selected roots/statement root
await proveRow({statement,witness}) // -> versioned real-proof envelope, no witness
await verifyRow({statement,proof})  // expected statement supplied independently
```

Witness: ordered input/output label pairs, independent role salts and Boolean
selections. Numeric input count10/output8; text input130/output128. Prover helper
can derive selections from actual labels and the retained pairs. Circuit itself
must constrain all selections, pair range/distinctness, constants and semantics.
No plaintext/pair witness is sent to a hosted prover or worker receiving LLM input.

Public ABI order (28 fields): pre-context limbs, final-context limbs, column,
row, stepCount, 4 opcodes, 12 parameters, inputPairRoot, outputPairRoot,
inputSelectedRoot, outputSelectedRoot, statementRoot. Type is pinned by the
approved numeric/text circuit artifact/key. Exact circuit key is never prover-chosen.

This proves delivered-result semantics relative to authenticated prior mappings.
It does not prove provider execution, original-file provenance or honest garbling.
No code integration/acceptance/payment should claim proof verification until the
real verifier checks every row of every selected plan column.

## Implemented and measured — 14 November 2026

The real implementation uses pinned Noir compiler/runtime **1.0.0** and official
`@aztec-foundation/bb.js` **6.0.0**, explicit WASM, one thread, UltraHonk
`verifierTarget: 'noir-recursive'` with zero knowledge enabled. No native service,
paid prover, RISC Zero installation or circuit-specific private setup is used.
The universal public SRS still carries its ceremony/discrete-log trust assumptions;
this is not a transparent proof system.

Both circuits compile and actual synthetic GC request/delivery labels prove:

| Circuit | Gates / dyadic | Actual proving | Verification | Proof / approved VK |
|---|---:|---:|---:|---:|
| Number, ordered fill/clamp | 13,593 / 16,384 | 1,088 ms | 21 ms | 14,656 / 3,680 bytes |
| Text, trim/lower/upper/redact | 73,138 / 131,072 | 2,996 ms | 23 ms | 14,656 / 3,680 bytes |

These are measured local Node WASM timings, not browser or general throughput
promises. Numeric fixture is missing255 → fill254 → clamp2..19 →19. Text fixture
includes spaces, mixed case, a digit and an actual NUL. Labels come from
`prepareRecipeProof` and **the existing AES-GCM evaluator**, not a mocked planner
or a plaintext reference substituted for a proof. The result-correctness relation
itself constrains typed semantics against committed label mappings; it does not
constrain AES-GCM execution or prove which machine computed the delivery.

Combined initial measured run: 5.14 s, maximum RSS **696,451,072 bytes**,
maximum observed Barretenberg WASM allocation **252,837,888 bytes**. The runtime
caps WASM at 2 GiB (not a total-process memory cap). It retains one backend for all
rows, serializes calls and reuses SRS/programs. `profile()` reports actual current
WASM bytes and Node memory metrics; browser JS heap metrics are nullable.
`dispose()` clears caches, destroys the backend and drops the WASM reference.
For prompt deterministic reclamation in browsers, terminate the outer worker via
its `dispose()`; garbage collection timing is controlled by the browser. Repeated
proofs may grow a retained backend's high-water allocation; there is no backend
created per row.

### Frozen runtime API

`proof-runtime/sdk.mjs` exports the five async APIs above, plus
`createProofRuntime()`, `dispose()`, `getRuntimeDescriptor()`, `publicInputs()` and
public field/encoding helpers. `createProofRuntime()` returns the same five
methods plus `profile()` and async `dispose()`. Top-level convenience functions
share one serialized singleton; top-level `dispose()` releases it.

`makeStatement` returns `{type,preContext,finalContext,column,row,recipe,
inputPairRoot,outputPairRoot,inputSelectedRoot,outputSelectedRoot,statementRoot,
inputLabels,outputLabels,publicInputs}`. The witness passed to `proveRow` is
exactly `{inputPairs,outputPairs,inputSalt,outputSalt}`. The SDK derives bits from
the **actual selected labels** against ordered pairs; callers do not assert bits.
The circuit constrains those bits, constant inputs, all pair u128 ranges,
opposite permutation bits/distinctness, context u128 limbs, u8 parameters,
canonical prefix ASCII presence/padding, operation ordering and all five roots.
Present NUL is byte128; absent padding is byte0. Trim removes ASCII spaces only.

`proveRow` returns exactly:

```js
{
  version:1, scheme:'nope-result-noir-poseidon2-v1', type:'number' /* or text */,
  circuitSha256, verificationKeySha256,
  proof: '<canonical base64 actual UltraHonk proof>',
  publicInputs: ['<canonical decimal field>', /* exactly28 */]
}
```

`verifyRow({statement,proof})` recomputes expected roots/public inputs, enforces
that exact envelope and approved type/circuit/VK identities, and invokes the
independent UltraHonk verifier using the approved local VK bytes. A proof cannot
supply a verification key or select a different circuit. It returns false on
malformed/tampered input. Verification never requires the private witness.
Two fresh subprocesses independently verified the synthetic number/text proofs
from public-only fixtures.

`checkWitness({statement,witness})` is a local constraint-test hook. Witness
execution alone is not proof generation or proof verification and must never set
an application verified/payment state.

### Policy and artifact identity

`proof-runtime/policy.mjs` imports no SDK/WASM and exports deep-frozen
`proofPolicy`, `policyHash`, and alias `proofPolicyHash`. Its SHA-256 is over
recursively key-sorted canonical JSON. Current policy hash:
`9bf341e80ca4ddb5ecd4fa6c731f9743dfd32ffe9622771ded172533b2d4fa40`.
It binds both compiled artifact/VK hashes, SRS identities, versions, root encoding,
relation version and ZK verification target. The v4 adapter binds this actual
policy hash into its approved program/context. A scheme label alone is insufficient.
The runtime also rejects policy/artifact disagreement and hashes artifact/VK/SRS
bytes before use.

- Number circuit SHA256: `621238b1b0c3677ae111cbb4b2cd22bbdc2d9f3a32c8db44c820fee961d1b7e6`.
- Number VK SHA256: `516d848ddeb80503f2a7fe4fd9f5dbce205fd10ab20f8051a086af05688e2f19`.
- Text circuit SHA256: `da5989f1fc84dbcc3dd386a49bcc58aa960a3e654dc3ec5ff1a0e54f2c6e79c9`.
- Text VK SHA256: `8a7addb2df6638e10e1ce5985c3038d7303da3e739e1af34612d02fc12711a1f`.

The machine-readable identities are `artifacts/approved-manifest.json` and
`approved.mjs`. `compile.mjs` compiles sources only. Explicit development scripts
`approve-artifacts.mjs` and `policy-build.mjs` regenerate approval metadata; they
are **not deployment build steps**. A changed circuit/VK/policy requires review
and a newly approved job; production must never autoapprove a submitted key.

### Same-origin browser package

```sh
npm ci --prefix proof-runtime --ignore-scripts
node proof-runtime/package-browser.mjs
```

The only build dependency added for packaging is exact `esbuild@0.25.12`.
Its installed optional platform binary works with ignored install scripts.
Packaging verifies approved inputs and writes `proof-runtime/dist/` with
`asset-manifest.json`: 14 exact path/byte/SHA256 entries, total **50,583,475 bytes**
at the measured build. MAIN copies only those files plus the asset manifest to
the matching same-origin `proof-runtime/` URL. The manifest is an allowlist,
not proof-supplied metadata. It includes compiled circuits, approved VKs,
three public SRS files, ACVM/ABI WASM, single/shared-memory BB WASM and two bundles.
Public SRS is about36MiB; no witness, fixture, Node package, compiler WASM, cache
journal, source secret or runtime directory belongs in that copy.

`prepare-crs.mjs` now validates **tracked public source assets offline** under
`proof-runtime/assets/`. Exact files: `bn254_g1.dat` (33,554,432B),
`bn254_g2.dat` (128B), `grumpkin_g1_v2.flat.dat` (4,194,304B). Their previously
approved hashes are unchanged. The old ignored cache is no longer a runtime or
packaging input. Missing or modified assets fail; there is no download fallback.
Node deployment must explicitly include `proof-runtime/assets/*.dat` in the
function filesystem. Browser packaging copies those same bytes to `dist/assets/`.
The source asset path change is included in the new policy hash above; previously
prepared v4 requests must be recreated against this policy before publication.
No circuit or verification-key bytes changed.

Targeted deployment tests pass3/3, including actual independent Node verification
of both proofs with cache reads and network access forbidden. See
`proof-runtime/evidence/assets-tests.txt`. Packaging removes its generated output
before rebuilding, so obsolete `.cache/crs/` files cannot enter its14-file allowlist.

The bundle exports the same real APIs from `proof-sdk.js`. Preferred browser use:

```js
import {createWorkerProofRuntime} from '/proof-runtime/proof-sdk.js';
const proof = createWorkerProofRuntime();
try {
  const roots = await proof.commitRow(rowSetup);
  // Reuse proof for all rows; no private witness crosses the network.
  const receipt = await proof.proveRow({statement,witness});
  const ok = await proof.verifyRow({statement,proof:receipt});
} finally { await proof.dispose(); }
```

The external module worker is `proof-worker.js`, created from a same-origin URL.
Inside it BB uses **explicit `BackendType.Wasm`, threads1**, a documented installed
SDK path that avoids its worker factory. SDK child-worker factories are disabled
in the bundle; shared-memory hosts still use only one thread. Remote CRS loader
paths are disabled. The official `msgpackr/index-no-eval` distribution avoids its
dynamic object-reader optimization. Browser WASM, circuits, keys and SRS are
integrity checked; redirects and foreign asset origins are rejected.

Required existing CSP remains `script-src 'self' 'wasm-unsafe-eval'`,
`worker-src 'self'`, `connect-src 'self'`. No `unsafe-eval`, Blob worker or CDN was
added. Packaging rejects eval/new-Function/blob/remote-code patterns. No CSP
source files were changed. Browser console/runtime enforcement remains MAIN's
CUA check; this worker does not claim that test completed.

`test-browser-package.mjs` executed the actual bundled browser SDK and its WASM
through a local HTTP-only Node harness, proving/verifying both types in1,085 and
2,842ms respectively with exactly10 same-origin requests. It substitutes the
module base URL because Node does not import HTTP modules. It validates the
browser-target code/assets, **not browser CSP enforcement, UI wiring or Vercel**.

### Reproducible evidence and remaining integration

```sh
npm --prefix proof-runtime test
npm --prefix proof-runtime run package:browser
npm --prefix proof-runtime run test:browser-package
```

`npm test` generates fresh actual GC-label proofs, then runs nine groups covering
independent-process verification, proof/VK tampering, root/label/context/parameter
replay (even when the attacker rewrites claimed public inputs), ordered numeric
sentinel/clamp semantics, text NUL/space/full-width cases, noncanonical padding,
constant wires, changed mappings/salts, policy identity and backend disposal.
See `proof-runtime/evidence/node-tests.txt`, `node-measurements.json`,
`node-measure.log`, `browser-bundle-harness.json`, `browser-package.log`.
Private witness fixtures are synthetic and ignored under `runtime/`; no customer
input has been used or uploaded. Test helpers and generated private fixture files
are excluded from the deployment asset manifest.

Measured current dependencies229MiB + tracked public SRS36MiB + browser assets49MiB
(plus an unused old public cache52MiB at measurement time, removed after final validation),
well under the2GiB added-footprint cap. Local disk remained approximately5.6GiB
free, above the3GiB floor. Whole plan cost scales per row: the current circuit
proves one typed cell and its ordered recipe, with no aggregation. Only measured
single-cell costs are asserted. The outer verifier must require complete ordered
row/column coverage and authenticated precommit/final contexts. MAIN/Avicenna own
that integration, latest-delivery invalidation, UI/browser CUA and deployment.
No execution-origin, honest-garbling, original-file, independent-operator or
on-chain SNARK-verification claim is made by these tests.
