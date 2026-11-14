# Typed result proof — runtime handoff complete

Ownership held: `proof-runtime/**` and `docs/execution-proof/IMPLEMENTATION.md`.
No escrow, root scripts, web adapters or deployment files edited here. No install
of RISC Zero/native proving server. No commit/deploy. No active proof/build work.

## Verified implementation
- Pinned Noir1.0.0 + official BB6.0.0 WASM, UltraHonk ZK `noir-recursive`.
- Actual GC evaluator numeric/text labels produce real14,656B proofs, independently
  verified against approved3,680B VKs (fresh public-only subprocesses also pass).
- Number13,593gates/dyadic16,384; text73,138/dyadic131,072.
- Initial actual measurements: numeric1,088ms prove/21ms verify;
  text2,996ms prove/23ms verify; combined5.14s peakRSS696,451,072B;
  observedWASM252,837,888B. Repeat:1,075ms/2,857ms proving.
- Nine runtime test groups PASS including rawNoir invalidboolean/u128/op/parameter,
  selectedlabel/roots/parameters/context attacks, proofbits/VK, exactconstants,
  orderednumericmissing/clamp, textASCII/NUL/padding, mapping/salt, lifecycle.

## Browser and server packaging
- `node package-browser.mjs`: PASS. `dist/asset-manifest.json` contains14
  allowlistedfiles50,583,475B; includesWASM/circuits/approvedVK/publicSRS.
- Same-origin externalworker; explicitdirectWASM threads1; reusablebackend,
  serializedcalls, profile()+dispose(), no per-rowbackend.
- NoCDN/blob/unsafe-eval; noCSPedit. Officialmsgpackr no-eval distribution;
  SDKremoteCRS/childworkerpaths disabled, allassetbytes SHAchecked.
- Actualbrowser-targetbundleHTTPNodeharness proves+verifiesnumber/text in
  1,085ms/2,842ms;10sameoriginrequests. This is NOT browserCUA/CSP evidence.
- MAIN owns actualbrowser/CSP/Vercel integration. Nodefunctionmustinclude3
  trackedpublicfiles underproof-runtime/assets/ (36MiB+128B). These3files staged;
  frozenSHAunchanged; APPROVED+policy pathsupdated. Noignoredcachedependency.
- prepare-crs.mjs nowofflinevalidationonly; browsercopies sameassets/. Package
  cleans generateddist first, preventing stale.cachefiles inallowlist.
- Packagingtargettests3/3PASS, actualNodebothproofsverified withcache/network
  readsforbidden. Policychanged9bf341... beforepublication; circuits/VKsunchanged.

## Frozen interop
- sdk.mjs: commitRow/selectedRoot/makeStatement/proveRow/verifyRow,
  createProofRuntime(),dispose(),getRuntimeDescriptor(),publicInputs().
- witnessexact{inputPairs,outputPairs,inputSalt,outputSalt}; bitsderivedfromactual
  selectedlabels. Fieldrootscanonicaldecimal,labels16Bbase64,salts/contexts64hex.
- policy.mjs has NO SDK/WASM imports; exportsdeepfrozenproofPolicy,
  policyHash/proofPolicyHash9bf341e80ca4ddb5ecd4fa6c731f9743dfd32ffe9622771ded172533b2d4fa40.
- Avicenna notified API/policy/browserpackaging/sourceassetrequirements.

## Evidence
- evidence/node-tests.txt (9/9), final-npm-test.log (freshactualproofs+8/8 prior
  addedrawconstraintgroup), node-measurements.json,node-measure.log.
- evidence/browser-bundle-harness.json,browser-package.log.
- evidence/source-manifest.json; artifacts/approved-manifest.json.
- FullAPI/trustlimits: ../docs/execution-proof/IMPLEMENTATION.md and README.md.

Dependencies229MiB/cache52MiB/browserpackage48MiB; disk5.6GiBfree (>3GiBfloor),
wellunder2GiB addedbudget. No customerplaintext/secrets used or transmitted.
This proves resultcorrectness relative to prior honestauthenticatedlabelmapping;
it does NOT prove executionorigin, honestgarbling, originalfile or independentoperators.

## Deployment path fix finalized
- Three public.datfiles staged under assets/, same frozenSRSbytes37748864total.
- Policy9bf341e80ca4ddb5ecd4fa6c731f9743dfd32ffe9622771ded172533b2d4fa40
  frozen; mainmustrecreateoldpolicyjobs. Numeric/textcircuits+VKs unchanged.
- evidence/assets-tests.txt3/3: bothactualNodeproofs verifywithcache/network
  forbidden. package-browser final14files50583475B; no stale.cacheentries.
- FunctionincludeFiles proof-runtime/assets/*.dat remainsMAINowned.
