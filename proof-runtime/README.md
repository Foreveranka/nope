# Typed result-correctness proof runtime

Real Noir1.0/Barretenberg6 UltraHonk WASM proofs for existing numeric fill/clamp
and16-byte tagged-ASCII trim/case/redact recipes. One persistent serialized backend,
threads1, exact approved circuit/VK/SRS hashes. No hosted prover.

```sh
npm ci --prefix proof-runtime --ignore-scripts
node proof-runtime/prepare-crs.mjs # offline check of tracked public material
npm --prefix proof-runtime test
npm --prefix proof-runtime run package:browser
npm --prefix proof-runtime run test:browser-package
```

From the repository root. Test fixtures use actual local AES-GCM GC evaluation
and synthetic values only. The browser bundle harness runs in Node with HTTP;
it is not a real browser/CSP test. MAIN owns that test and deployment.

Public metadata: `policy.mjs` (no WASM imports). Main SDK: `sdk.mjs`.
Browser entry: `dist/proof-sdk.js`; external worker: `dist/proof-worker.js`.
Copy only `dist/asset-manifest.json` and its14 allowlisted files, preserving paths.
No install scripts, CDN runtime or Blob worker is required. Existing CSP suffices:
script self/wasm-unsafe-eval, worker self, connect self.

Node verification loads the three tracked public SRS files under `assets/`.
Include `proof-runtime/assets/{bn254_g1.dat,bn254_g2.dat,grumpkin_g1_v2.flat.dat}`
in the Vercel function filesystem. Their frozen hashes and total36MiB+128B are
listed in `assets/README.md`. Browser packaging copies the same bytes under
`dist/assets/`. Both paths are independent of `.cache/`; missing or altered source
assets fail offline validation. There is no runtime or build download fallback.

Use `createProofRuntime()` once, reuse its async root/prove/verify methods for all
rows, inspect`profile()` and finally await`dispose()`. Top-level helpers share one
singleton, released by top-level`dispose()`. Preferred browser factory
`createWorkerProofRuntime()` from the bundled entry uses one external module
worker and terminates it on disposal. Never send witness pairs/salts to a server.

Read `../docs/execution-proof/IMPLEMENTATION.md` for exact ABI, measured costs,
API/envelope, approved hashes and trust limits. This proves result semantics
relative to authenticated prepublished mappings. It does not prove honest
garbling, original-file provenance, provider execution or computation origin.
