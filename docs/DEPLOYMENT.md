# Current application deployment

Updated 14 November 2026. Start at the [current README](../README.md). The browser marketplace uses customer-wallet escrow; the [12 November FHE/cloud deployment](archive/DEPLOYMENT-2026-11-12.md) is historical material for a separate prototype.

## Components

| Route/component | Current responsibility |
| --- | --- |
| `/` | Introductory NOPE landing page; links into the application |
| `/workspace` and role/job/payment routes | Customer/provider marketplace, local planning/encryption/vault, explicit wallet actions |
| `/docs` | Integrated five-language usage and system documentation |
| `/verify?id=JOB_ID` | Unauthenticated public encrypted-evidence, result-proof and FINAL contract-binding verification |
| `/api/workspace?route=...` | Node API: wallet authentication, private storage, sealed bids, encrypted evaluation, proof verification and read-only chain observation |
| `/api/locale` | Maps the trusted hosting country header to a default language; no IP database or external geolocation service |
| `/agent-model/`, `/proof-runtime/`, `/wallet-runtime/` | Allowlisted same-origin public JS/WASM/configuration assets |
| NEAR `nope-wallet-44384e2f.testnet` | Shared immutable customer-funded escrow with per-buyer/job liabilities |

The selected provider triggers the current garbled-circuit evaluator in the Node application. An independent native worker, Python companion, MPC operator cluster or user-supplied executable is not required for this browser flow. Older cloud/companion endpoints and recorded demo routes have their own historical scope.

## Server configuration

- `BLOB_READ_WRITE_TOKEN`: server-only credential for the deployment's **private** Vercel Blob store.
- `NOPE_WORKSPACE_ORIGIN`: exact HTTPS application origin, or explicitly configured loopback HTTP origin for development. The default is `https://nope-workspace.vercel.app`.
- `NOPE_WORKSPACE_COMPAT_ORIGINS`: optional comma-separated additional exact origins. When the canonical origin is the source default, compatibility defaults to `https://veil-procurement.vercel.app`; a different explicit canonical origin has no compatibility default. An explicitly empty value disables compatibility. No wildcard, preview-host or forwarded-host authorization.
- The reviewed public contract/network/code pins are committed in `workspace/wallet-config.mjs` and `web/wallet-pins.mjs`; the build requires byte parity. They contain no signing key. A different deployment requires a reviewed matching pin update.

New wallet jobs do not use a server wallet signer or a sponsor payment reserve. The server constructs bounded intents and observes the chain. Users authorize signatures and native testnet transfers in their wallets. Never put customer CSV plaintext, a wallet private key, seed, decoder, proof witness or a customer wallet store into environment configuration or Blob.

The private Blob adapter accepts only its bounded immutable application namespaces, including the exact wallet session/challenge/claim/intent/transaction paths. Wallet records retain the 1 MiB bound; the 3 MiB task allowance does not apply to them. The production-path regression is `workspace/wallet-blob.test.mjs`.

## Canonical URL and compatibility rollout

The canonical application URL is `https://nope-workspace.vercel.app`. Keep `https://veil-procurement.vercel.app` attached to the same project and serving the application without a forced redirect: browser sessions, IndexedDB vaults, CSV decoders and proof witnesses cannot transfer between origins. New sessions bind to their creation origin; historical production sessions lacking an origin field remain old-origin sessions. Existing wallet links retain their original origin and records are not rewritten. A fresh verified wallet session at the new URL can recover wallet-owned jobs, but not local CSV/decoder/witness data.

For an explicit production configuration, set these server environment names only after release agreement:

```text
NOPE_WORKSPACE_ORIGIN=https://nope-workspace.vercel.app
NOPE_WORKSPACE_COMPAT_ORIGINS=https://veil-procurement.vercel.app
```

If neither variable is set, the source defaults already allow exactly these two URLs. An existing `NOPE_WORKSPACE_ORIGIN` set to the old URL overrides the new default; update it as above or explicitly add the new origin to `NOPE_WORKSPACE_COMPAT_ORIGINS` during a staged rollout. `NOPE_PROCUREMENT_ORIGIN` and `VEIL_PUBLIC_ORIGIN` belong to older endpoints and do not configure this workspace; this change does not require altering them. `BLOB_READ_WRITE_TOKEN` continues to use the same private store and needs no rotation or value change for this alias addition.

An allowlisted origin must still match the request URL and supplied Origin header. NEP-413 message origin, recipient and `/settings` callback all use the request's own origin; a signature, challenge or bearer session from one URL is rejected at the other. After deployment, smoke each URL separately: create a synthetic session, request `/wallet/challenge` for a synthetic testnet account, and check all three origin fields plus the callback. Replay the token on the other URL to confirm `SESSION_ORIGIN_MISMATCH`. No signature, funding or payout is needed for that smoke check. Source changes do not alter hosted env, domains or deployment by themselves.

## Build and release

The existing private GitHub repository `Foreveranka/veil-procurement` is connected to the Vercel project `veil-procurement`. A push to `main` triggers the production build. GitHub repository visibility is independent of deployment; pushing source does not make the repository public.

Install the pinned runtime dependencies and build from the repository root:

```sh
npm ci
npm ci --prefix planner-runtime --ignore-scripts
npm ci --prefix proof-runtime --ignore-scripts
npm ci --prefix wallet-runtime --ignore-scripts
npm run check:locales
npm test
npm run build
```

The install/build commands in `vercel.json` follow this sequence. `scripts/build-web.mjs` creates `dist/` from explicit allowlists. It verifies and packages public planner, proof and wallet assets, validates the SRS/pins/manifests and packages the historical companion download for existing links. The model weights are fetched by the browser on first use, not bundled into the deployment. APIs are packaged separately from static `dist/`; `/api/workspace` includes the approved proof runtime material in its function filesystem and has a 60-second configured maximum duration.

No deployment, account creation, wallet signing or contract upgrade occurs as a side effect of the build or root tests. Dedicated provisioning and live-wallet QA scripts are separate explicit testnet actions; they are not general setup commands for a fresh reviewer.

For local hosting, install Vercel CLI and supply **your own** private Blob credential in ignored local environment configuration, then:

```sh
NOPE_WORKSPACE_ORIGIN=http://127.0.0.1:3000 vercel dev --local --listen 127.0.0.1:3000
```

A static file server is insufficient for API/authentication. Read [wallet backend documentation](../workspace/README.md) before exposing a different origin. Do not pull or publish another deployment's environment as a substitute for provisioning your own store.

## Wallet isolation and headers

`vercel.json` keeps application scripts/styles on the same origin. Wallet code is bundled from pinned packages; no runtime wallet manifest/executor CDN is consulted. The wallet transport frame is sandboxed without `allow-same-origin`. Only the static bridge HTML receives the same-origin embedding exception; normal product pages retain their anti-framing policy. Opaque-frame module imports receive CORS only for the public `/wallet-runtime/` assets, not API credentials or private data.

See [wallet runtime](../wallet-runtime/README.md) for the reviewed SDK patches and exact assets. Header exceptions, source hashes and actual browser loading are separate checks from external wallet signing.

## Release verification

After a source release, verify the expected Git commit and Vercel READY state, served static-asset hashes, the bridge headers and API behavior. Source edits or a build log alone are not proof of deployment. End-to-end financial/proof checks are recorded separately:

- [Wallet-funded integration report](verification/wallet-funded-flow.md).
- [Actual production HTTP test](verification/wallet-funded-http-production.json): generated test-wallet signatures, real testnet funding, encrypted execution, SNARK, acceptance and payout.
- [Direct public testnet payout/refund](../payments/wallet_escrow/verification/live-financial-checks.json).
- [Public verifier](https://veil-procurement.vercel.app/verify?id=10b21c73ed75bfd8c47418524932d2bf): also passed real Chrome independent proof/chain verification.
- [Release checks](verification/wallet-release-checks.json): 486 root tests; mocked transports and actual chain/browser evidence are distinguished.

The real wallet selector and cancellation were checked in live Chrome. Interactive account/transaction signing inside the external Intear popup remains unverified end to end. Do not describe Node-signed integration tests as a successful external browser-wallet login.

Keep `.env*`, `.vercel`, `runtime/`, invitations, account keys, dependency directories, native targets and recovery journals out of Git and deployment bundles. Historical sanitized evidence is preserved; raw local runtime files and customer inputs are not publication assets. The immutable contract is testnet-only and limited to 1 testNEAR per job and 50 permanently retained jobs; the proof adapter accepts the same exact 1 yoctoNEAR–1 testNEAR selected-price range; it is not a mainnet readiness claim.
