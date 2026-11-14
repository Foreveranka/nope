# Proof-plan v4 protocol

2026-11-14. Main's v4 envelope/API and Nash's root/witness API are coordinated. Actual prover/circuit implementation and measurement belong to `proof-runtime/`; this wrapper does not claim proof success before the real verifier runs. v3 remains unchanged. Claim: **typed result correctness relative to authenticated precommitted client mappings**, not AES execution provenance, original-CSV provenance or LLM provenance.

## Fixed modules and function names

`web/proof-plan-core.mjs`:

- `PROFILE = 'nope-csv-proof-plan-gc-v4'`
- `validateProofPlanRequest(request)` — synchronous strict public schema/shape validation. Cryptographic equality checks run in the async binding/hash helpers below.
- `canonicalProofPlanRequest(request)` — synchronous canonical public JSON, with strict schema/shape validation.
- `hashProofPlanRequest(request)` — async; verifies base/context hashes, every derived row context and every actual selected-input root, then hashes the **whole** outer request.
- `hashProofPlanProgram(plan)` — async; domain-separated proof-program identity from the normalized approved plan's actual v3 program hash and the fixed proof scheme/version, not a job-specific root.
- Additional public helpers: manifest canonicalization/hash, expected row descriptors, explicit creation-context checks, async binding checks and v4 result wrapping/validation. No root calculation uses a SHA substitute for Poseidon2.

`web/proof-plan-client.mjs`:

- `prepareProofPlan(valuesByColumn, plan, {jobId, buyerCommitment?, contractId?})` — async; returns `{request, decoder, witness}`. **Only `request` is public/network-safe.** `decoder` and `witness` stay buyer-local/in authenticated encrypted local storage.
- `decodeProofPlan(result, decoder)` — async; verifies outer bindings then uses the unchanged strict v3/v2 decoders for actual label membership/decoding.

The limited new `prepareRecipeProof` export captures private input/output pairs while sharing the existing garbling implementation. Existing `prepareRecipe` still returns exactly `{request,decoder}`; its strict decoder schema does not gain fields.

## Exact public request

```json
{
  "profile": "nope-csv-proof-plan-gc-v4",
  "task": "<exact existing v3 encrypted plan request object>",
  "proofManifest": {
    "version": 1,
    "scheme": "nope-result-noir-poseidon2-v1",
    "context": {
      "domain": "NOPE:PROOF-PLAN:V4",
      "network": "testnet",
      "jobId": "<32 lowercase hex>",
      "buyerCommitment": null,
      "contractId": null,
      "policyHash": "<approved immutable relation/artifact/VK/SRS/settings policy SHA-256>",
      "baseRequestSha256": "<canonical inner v3 request SHA-256>",
      "planSha256": "<normalized actual plan SHA-256>",
      "baseProgramSha256": "<actual compiled v3 plan program SHA-256>",
      "programSha256": "<v4 proof-program SHA-256>",
      "nonce": "<inner v3 plan nonce: 32 lowercase hex>",
      "rowCount": 1
    },
    "rows": [
      {
        "column": "C1",
        "row": 0,
        "type": "number",
        "preContext": "<64 lowercase hex>",
        "inputPairRoot": "<canonical decimal BN254 Fr>",
        "outputPairRoot": "<canonical decimal BN254 Fr>",
        "inputSelectedRoot": "<canonical decimal BN254 Fr>"
      }
    ]
  }
}
```

The placeholder `task` is an object with the current exact v3 shape, not a string on the wire. Context `buyerCommitment` is null or 64 lowercase hex; `contractId` is null or a named `.testnet` account. Optional preparation values normalize to explicit nulls, never missing keys. Main must compare `context.jobId` to the actual authenticated job creation ID **before creation**, and compare nonnull optional buyer/contract commitments to actual values. A null means this optional setup binding was not supplied; it does not authorize a different final job/award context.

Rows flatten in **the actual plan step order**, then ascending row index `0..rowCount-1`. Every selected column and row appears exactly once, with exact type. All row roots are canonical unsigned decimal strings strictly below BN254 Fr modulus `21888242871839275222246405745257275088548364400416034343698204186575808495617`. No alternate base, leading zeros, signs or modulus reduction.

The outer request has exactly `profile`, `task`, `proofManifest`. The manifest/context/row objects also reject unknown keys. No decoder, salt, alternative label pair, input/output bits, CSV/name/header or caller verification boolean appears in public data.

## Acyclic hash and row-context definitions

1. Before randomness, validate all typed values, every approved recipe and aggregate GC/transport budget, including the added manifest overhead.
2. Generate the normal v3 request and private witness. Compute `H_GC = hashPlanRequest(task)`, `planSha256 = hashPlan(task.plan)`, `baseProgramSha256 = hashPlanProgram(task.plan)`.
3. `programSha256 = SHA256(JSON.stringify({profile:PROFILE, scheme:SCHEME, version:1, policyHash, baseProgramSha256}))`, in that key order. Compute it before pair roots. It binds the actual immutable proof policy plus the actual base program. `policyHash` comes from the runtime's no-WASM `policy.mjs` metadata, never from the caller; the wrapper rehashes the recursively key-sorted policy JSON and compares the published hash. The policy pins numeric/text compiled circuit and VK hashes, SRS identities, Noir/BB versions, verifier target and root encoding.
4. Fill context in the exact field order shown above. For each row derive:

```js
preContext = SHA256(JSON.stringify({
  domain: 'NOPE:PROOF-PLAN:V4/row',
  context,                 // exact canonical public context above
  columnIndex,             // zero-based index in actual plan.steps
  column,                  // actual alias, e.g. C9
  row,                     // zero-based row index
  type,                    // 'number' or 'text'
  recipe,                  // exact normalized actual v2 recipe
  nonce,                   // actual per-column GC nonce
  inputCount,              // 10 number, 130 text, INCLUDING constants
  outputBits               // 8 number, 128 text
}))
```

5. Use the real runtime to compute pair roots with independent fresh private 256-bit salts, and input-selected roots from **actual request row.inputs**, not a claimed root. Include all rows in the manifest.
6. Canonical v4 JSON is `JSON.stringify({profile:PROFILE, task:JSON.parse(canonicalPlanRequest(task)), proofManifest:canonicalManifestObject})`. Hash the entire envelope. This is the new `job.taskHash`/escrow opaque `input_hash`, fixed before funding/execution. `context.baseRequestSha256` remains the separate inner GC hash.

No pair root depends on the future outer v4 task hash. The outer hash depends on those roots, so there is no commitment/hash cycle. A manifest appended to an already executed v3 job does not create a proof-required v4 job.

## Nash runtime: exact agreed root/witness API

Chosen implementation candidate: Noir 1.0.0 plus Barretenberg UltraHonk 6.0.0 WASM. This is a **Poseidon2** relation, not original Poseidon. Exact circuit/key artifact identities and successful actual proof measurements are provided by Nash's runtime, never chosen by the proof submitter.

- 16-byte canonical base64 labels decode to unsigned **big-endian u128**. A label's low bit is its last byte's permutation bit; that bit is not automatically its semantic 0/1 position.
- 32-byte lowercase hex contexts/salts split into `[high128,low128]`; no field reduction.
- `H4` is standard BB/Noir **Poseidon2 hash of four BN254 fields**, not a bare permutation.
- `fold(domain, fields)`: start `acc=H4(domain,1,fields.length,0)`; process ordered triples as `acc=H4(acc,a,b,c)`; zero-pad only the last triple. Original length is committed.
- Header: `[typeCode,columnNumber,row,preContextHi,preContextLo,stepCount,ops[4],params[4][3]]`. Types 1 number / 2 text; column number 1..16. Op codes: 1 fill `[value,0,0]`, 2 clamp `[min,max,0]`, 3 trim, 4 lowercase, 5 uppercase, 6 redactDigits (all text parameters zero). Unused op slots/parameters are zero.
- Domains: 101 input pairs; 102 output pairs; 103 input selection; 104 output selection; 105 final statement. Pair roots fold header, two salt limbs and ordered `L0,L1` for each wire. Selected roots fold header and every actual selected label. Input includes selected constants 0 and 1.
- Numeric pairs/labels: input10/output8. Text: input130/output128. Pair positions preserve semantic zero/one order. Runtime constraints enforce Boolean selections, canonical labels, opposite permutation bits, constants and exact typed semantics.

```js
await commitRow({
  type, preContext, column, row, recipe,
  inputPairs, outputPairs, inputSalt, outputSalt
}); // {inputPairRoot, outputPairRoot}

await selectedRoot({
  role: 'input' /* or 'output' */, type, preContext, column, row, recipe, labels
}); // canonical decimal Field

await makeStatement({
  type, preContext, finalContext, column, row, recipe,
  inputPairRoot, outputPairRoot, inputLabels, outputLabels
}); // public statement; independently derived selected roots + statementRoot

await proveRow({statement, witness}); // actual versioned proof envelope, NO witness
await verifyRow({statement, proof});  // expected statement independently supplied
```

Runtime `type` is `'number'|'text'`, `column` is numeric 1..16, `row` is numeric zero-based, `recipe` is the current normalized typed recipe, labels/pairs are canonical base64 strings, and salts/context are 64 lowercase hex. Witness is `{inputPairs,outputPairs,inputSalt,outputSalt}`; SDK derives selected bits from actual selected labels. It must not accept arbitrary client Boolean claims without circuit constraints.

The ABI has 28 fields: pre-context limbs2, final-context limbs2, column, row, stepCount, opcodes4, parameters12, inputPairRoot, outputPairRoot, inputSelectedRoot, outputSelectedRoot, statementRoot. Type is pinned by the approved numeric/text circuit/key. No partial-plan proof coverage is allowed.

## Private preparation state

`prepareRecipeProof` returns `{request,decoder,witness}`. Its witness has ordered row arrays `inputPairs`, `outputPairs` and the input Boolean rows (including 0/1). Only `request` is sent to evaluation; the existing strict decoder remains exactly its old shape.

`prepareProofPlan` returns:

- `request`: the public envelope above, safe for task publication;
- `decoder`: a new strict private wrapper `{profile,request,taskDecoder}`, with `taskDecoder` in the unchanged v3 decoder format;
- `witness`: a separate client-local object containing version/job/base-request identity and ordered row witnesses `{column,row,inputPairs,outputPairs,inputSalt,outputSalt}`.

Neither private object may be passed to ordinary task/proof submission endpoints, LLM tools, hosted provers or public evidence export. If reload support is required, encrypt them locally using the existing authenticated decoder-vault model with explicit new v4 schema support; do not silently widen the old decoder parser.

## Exact evaluation result and decoder binding

The actual existing evaluator evaluates **only** `request.task`. Main can use `wrapProofPlanResult(request, baseResult)` to validate/rebind its genuine output. No proof is fabricated during evaluation.

```json
{
  "profile": "nope-csv-proof-plan-gc-v4",
  "nonce": "<inner task nonce>",
  "rowCount": 1,
  "outputs": "<actual v3 output-label arrays>",
  "inputSha256": "<entire canonical v4 request SHA-256>",
  "outputSha256": "<canonical actual output-label arrays SHA-256>",
  "programSha256": "<v4 proof-program SHA-256>"
}
```

`outputs` is an array, not a string on the wire. The result has exactly these seven fields. The output hash retains the canonical output-label-array meaning; request/program domains differ from v3. `decodeProofPlan` checks those outer bindings before translating to the independently checked base v3 result and invoking the unchanged v3/v2 decoder. A v3 result alone is never accepted as v4.

## Final proof submission policy (main owns endpoint/integration)

The pre-execution manifest is revision-independent. Main's proof endpoint accepts exact delivery `version`, `outputSha256` and the real SNARK bundle. It retrieves the stored v4 task and latest delivery, recomputes all contexts and selected roots from actual ciphertexts, and invokes the real runtime verifier with server-derived expected public inputs. It rejects caller verifier booleans, arbitrary keys, missing/extra rows and stale contexts.

Final context must additionally bind the exact outer task/manifest, plan/program identity, job/award binding, actual positive delivery version and canonical output hash. The deterministic helpers below use expected binding fields supplied by main from authenticated job state, never from the proof bundle. Runtime domain105 incorporates that final context and all four roots without modifying the already anchored precommitments.

Verified proof state belongs to one exact delivery. New revisions invalidate prior proof status. Proof failure must not prevent the buyer from requesting a correction after the current delivery is finalized on-chain. Existing local-reference and exact finalized-record gates remain independent. No on-chain SNARK verification is claimed.

See [RELATION-REVIEW.md](RELATION-REVIEW.md) for the soundness argument and concrete mapping attacks; [IMPLEMENTATION.md](IMPLEMENTATION.md) for Nash's live runtime progress/actual-proof evidence.


## Frozen final-context / verifier adapter API

```js
const binding = {
  jobId,         // actual 32-hex authenticated job.id
  version,       // actual delivery.version, positive u32
  contractId,    // actual sponsored-testnet contract account
  bindingHash,   // actual immutable escrow bindingHash
  provider,      // actual selectedOffer.paymentAccount
  amountYocto    // actual selected public price, exact decimal string
};
await finalProofContext(request, delivery, binding); // 64-hex SHA-256
await makeProofStatements(request, delivery, binding);
// -> {finalContext, rows:[{column:'C1',row:0,statement:runtimePublicStatement}, ...]}
```

Both functions validate the entire v4 request's cryptographic bindings and the actual delivery's outer input/program/output hashes and dimensions. `delivery` may be the seven-field evaluation result or that exact result plus actual `version`/`deliveredAt`; any present version must match `binding.version`. Metadata is never inferred from a SNARK bundle. Supplied setup contract/job context must match the final binding. An amount is an exact decimal string in the existing sponsored pilot range; provider must be a testnet named/implicit account and differ from contract.

The digest is SHA-256 of `JSON.stringify` in this exact key order:

```js
{
  domain: 'NOPE:PROOF-PLAN:V4/delivery',
  version: 1,                 // protocol version, not delivery revision
  network: 'testnet',
  jobId,
  requestSha256,              // entire canonical outer v4 request
  baseRequestSha256,
  programSha256,              // v4 proof-program identity
  planSha256,
  manifestSha256,             // canonical public manifest
  deliveryVersion: binding.version,
  outputSha256,              // recomputed from actual encoded output arrays
  contractId,
  escrowBindingHash: binding.bindingHash,
  selectedProvider: binding.provider,
  amountYocto: binding.amountYocto
}
```

`makeProofStatements` derives each input/output selected root from the actual corresponding label arrays through Nash's SDK, then checks the recomputed input root against the precommitted manifest. It emits exactly one statement per manifest row in the same plan-column/row order. Main must require exactly the same bundle coverage and invoke `verifyRow({statement:expectedRow.statement,proof:submittedRow.proof})` for each row. A proof package's claimed public-signal list is not the expected statement.

These helpers do not fetch chain state: main's authenticated job binding and the external reviewer's independent `get_hold` comparison are the authentication boundary for contract/provider/price/escrow binding. The current helper must never be described as authenticating arbitrary caller-supplied award metadata by itself.


### Actual approved policy metadata

`proof-runtime/policy.mjs` exports deeply frozen `proofPolicy` and canonical `policyHash` (also `proofPolicyHash`). Current hash: `9bf341e80ca4ddb5ecd4fa6c731f9743dfd32ffe9622771ded172533b2d4fa40`. This is generated from actual compiled numeric/text circuit/VK and SRS identities, not a placeholder. `context.policyHash` must equal the imported approved value. Program hashing additionally verifies `SHA256(JSON.stringify(proofPolicy, recursivelySortedObjectKeys)) == policyHash`. Runtime asset verification must continue enforcing those same approved circuit/VK/SRS bytes. A new actual relation policy changes the v4 program hash, row contexts, outer request hash and accepted proof statements.

## Actual proof generation / independent bundle verification helpers

```js
// Client-only: request and delivery are public; witness stays in the buyer worker.
const bundle = await proveProofPlan({request, delivery, binding, witness, onProgress});

// Public verifier / server: no private witness and no caller proof boolean.
const verified = await verifyProofPlanBundle({request, delivery, binding, bundle, onProgress});
```

Bundle is **exactly**:

```json
{
  "version": 1,
  "scheme": "nope-result-noir-poseidon2-v1",
  "finalContext": "<expected 64-hex final context>",
  "rows": [
    {"column": "C2", "row": 0, "proof": "<actual runtime proof envelope object>"}
  ]
}
```

The runtime proof value is an object, not a string. It has exactly `version`, `scheme`, `type`, `circuitSha256`, `verificationKeySha256`, `proof` (canonical base64 proof bytes) and `publicInputs` (28 canonical decimal fields). Its artifact/key identities must match the approved immutable policy; main's verifier never accepts a supplied verifier key. A proof is generated and returned only by the actual runtime. No hash, caller boolean, stub proof or plaintext fallback fills this field.

`proveProofPlan` validates/snapshots every private row witness, derives expected public statements from actual ciphertexts and expected binding, recommits retained ordered pairs/salts to the already anchored roots, then invokes the actual SDK prover for every row. Private witness fields never appear in the returned bundle.

`verifyProofPlanBundle` returns `true` only after every exact expected row passes the SDK verifier. Malformed, incomplete, reordered, stale or invalid bundles return `false`; invalid expected request/delivery/binding or unavailable runtime raises an error rather than inventing success. Both helpers call `onProgress({completed,total})` **after actual row completion only**. There are no fake initial ticks, predicted percentages or timer-driven proof status. A verifier may report the just-completed failed row before returning false.

All rows are ordered exactly as the immutable manifest. Maximum proof coverage is **40 total row/column coordinates**, with the independent GC gate/transport limits still enforced. `MAX_PROOF_BUNDLE_BYTES` is **1 MiB minus 1024 bytes** (1,047,552 bytes), reserving submit-envelope overhead under main's 1 MiB API/Blob cap. `estimateProofPlan` rejects a larger plan before cryptography/garbling/funding, and computes a conservative bundle byte bound using the actual approved proof byte sizes, 77-digit decimal public signals, full headers and actual row coordinates. Every row remains mandatory. Four numeric columns at 32 rows are rejected, not partially proved; 32 text row/column coordinates fit this proof-count limit but must also fit the existing GC gate/transport limits. Evidence may contain the public encrypted task, actual delivery, bundle and opaque expected context; never private offers/session/name/key/pairs/salts.

The dedicated proof worker is separate from the model worker. Local decoder+witness storage requires the explicit new private v4 wrapper, encrypted by the existing buyer vault. A prepared v4 request's buyer/contract context is required to equal the authenticated session buyer commitment and configured contract at main's new publication gate; optional helper preparation defaults do not weaken that backend policy.


### UI preflight limits

`PROOF_PLAN_LIMITS` exports `{maxRowProofs:40,maxProofBundleBytes:1047552,proofBytes:{number:14656,text:14656}}` from actual approved runtime metadata. `estimateProofPlan(plan,rowCount,options)` returns the existing GC estimate plus `rowProofCount`, `maxRowProofs`, `estimatedProofBundleBytes` and `maxProofBundleBytes`. It must succeed before preparation/publication. The canonical public bundle validator enforces the same count/byte caps. These are honest protocol limits, not a guarantee of browser proving latency/memory for every allowed plan.


Deployment note: approved SRS bytes are ordinary public source assets at `proof-runtime/assets/*.dat`, not ignored runtime-cache files. Main packages/includes these assets explicitly. Moving these paths changed the approved policy identity to the current hash above; regenerate any unpublished v4 preparation created under the earlier policy. There is no runtime CDN/download fallback.
