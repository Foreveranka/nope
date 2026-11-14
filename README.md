<img src="web/nope-logo.svg" width="64" height="64" alt="NOPE logo">

# NOPE — Network of Private Execution

Hire an agent to transform a CSV without sending its private rows to the planning model or exposing them to the service provider. NOPE combines sealed price bids, encrypted execution, independently verifiable result proofs and customer-funded escrow on NEAR.

**NEAR Hackathon 2026 · Privacy & Private AI · Working testnet prototype**

[Open NOPE](https://veil-procurement.vercel.app) · [Enter the application](https://veil-procurement.vercel.app/workspace) · [User documentation / Türkçe dahil 5 dil](https://veil-procurement.vercel.app/docs) · [Verify a completed job](https://veil-procurement.vercel.app/verify?id=10b21c73ed75bfd8c47418524932d2bf)

## What you can try

A customer describes a bounded cleaning task using anonymous column names, approves a locally generated plan, and receives bids encrypted to their browser. The customer selects a provider and signs an exact-amount escrow deposit from their own wallet. The provider initiates computation on the encrypted task. The customer checks the output, produces a result proof and explicitly accepts the delivery before signing payment release.

This repository's current application is `/workspace`. The older Concrete FHE/MPC and sponsor-funded demonstrations remain separate historical experiments; they are not the implementation of the current browser flow.

## Judge walkthrough

### 1. Independently verify an existing result — no wallet or installation

Open [this completed job](https://veil-procurement.vercel.app/verify?id=10b21c73ed75bfd8c47418524932d2bf). The page fetches public encrypted evidence, checks the pinned contract and finalized chain state, then verifies the actual Noir/UltraHonk result proof in your browser. Wait for the explicit success message and `escrowState: Paid` in the details.

No customer session, CSV, decoder or private mapping is needed. This is a real completed testnet job, not a simulated payment. It uses synthetic one-row data and an explicitly authored plan; that particular HTTP test does not claim to demonstrate neural planning.

### 2. Try the customer/provider application

Use a current desktop Chromium browser, two different funded NEAR **testnet** accounts, and separate browser profiles for the customer and provider. The shipped wallet selector currently supports **Intear Wallet**. End users do not install a Python companion or a browser extension for NOPE itself.

1. Open the workspace, choose Customer, and connect your testnet wallet. Sign the account-verification message. Never enter a wallet private key into NOPE.
2. Create a job and select a synthetic CSV, for example:

   ```csv
   record,score,note
   A,,keep
   B,200,preserve
   C,42,unchanged
   ```

3. Set `score` / `C2` to Number and leave the other columns unselected. Use the public goal: `Fill C2 blanks with 7 and clamp C2 to 0..100.` The local planner should propose supported operations; review them rather than assuming the model interpreted your goal correctly. For that approved plan, the local preview is `7, 100, 42`, while the other fields remain unchanged.
4. Approve the plan and preview, then encrypt and publish. The optional budget is a private local note, not an enforced spending limit; review the selected price before signing. Do not include confidential data in the public title, description or goal.
5. In the provider profile, choose Provider, connect a different testnet wallet, open the job and submit an encrypted price bid. For this walkthrough use **0.001 testNEAR**. Other providers cannot decrypt it.
6. The customer closes bidding, decrypts the bids locally and selects a provider. The selected provider and price now become public. Approve the exact deposit in the customer wallet; execution stays blocked until funding is finalized.
7. The selected provider opens Delivery, initiates the encrypted calculation and signs delivery recording for its exact version and output hash.
8. The customer reviews the in-app before/after result, generates the proof, waits for verification and explicitly accepts that delivery. Then the customer signs payment release. Wait for the finalized provider transfer; a wallet's send response alone is not payment evidence.

The first planner use downloads approximately **412.5 MB** of pinned public model files and caches them in the browser. Inference runs locally with Qwen3-0.6B through Transformers.js/ONNX Runtime. Proof generation and verification also load public WASM/SRS assets and can take time. Loading, unsupported operations and failed verification do not silently switch to plaintext processing.

**Verification boundary:** genuine test-wallet signatures, funding, encrypted execution, proof verification and payout passed through the deployed HTTP API. Live Chrome independently verified the public proof and chain binding, and the real wallet selector/cancel path was checked. Signing inside the external Intear wallet popup has not yet passed an interactive end-to-end browser acceptance test. Do not equate that remaining check with the completed API/chain tests.

## How the system works

| Component | Responsibility | Relevant implementation |
| --- | --- | --- |
| Customer browser and encrypted vault | CSV parsing, private mappings, bid keys, encryption, local preview/decryption and proof witness | [Browser workspace](web/workspace.js), [vault](web/workspace-vault.mjs) |
| Local planning model | Converts a public goal and anonymous typed columns into an allowlisted plan; receives no private rows | [Planner worker](web/agent-model-worker.mjs), [pinned model](planner-runtime/model-pack.json) |
| Marketplace API and private storage | Wallet-verified sessions, sealed bids, immutable job revisions, exact signing intents and read-only chain observation | [Backend documentation](workspace/README.md), [API](api/workspace.mjs) |
| Encrypted evaluator | Evaluates one-use garbled circuits using selected wire labels; returns output labels without the decoder | [Execution dispatch](workspace/gc.mjs), [GC protocol](web/gc-core.mjs) |
| Result proof | Noir/UltraHonk proofs of typed transformations under precommitted buyer mappings; independent browser/server verification | [Proof runtime](proof-runtime/README.md), [public verifier](web/public-proof.mjs) |
| NEAR escrow | Holds the exact customer deposit per job, binds terms/delivery, and transfers to the selected provider or refunds the original buyer | [Contract and protocol](payments/wallet_escrow/README.md) |

The provider currently triggers the server-side evaluator; this is not an independent provider-node network. Sealed bidding uses browser encryption and customer selection, not a distributed MPC auction. No arbitrary agent-supplied executable code is accepted.

## What stays private, and what is public

| Data | Visibility in the implemented flow |
| --- | --- |
| Original CSV, filename, original column names and untouched fields | Customer device; not sent to the planning model or marketplace API |
| Public goal, title, description, anonymous column types and approved plan | Public job metadata; the customer must not put secrets here |
| Bid price before selection | Encrypted for the customer; the customer opens bids after closing intake; the server enforces that release order |
| Losing bids | Not decrypted by competing providers; the customer can read them |
| Selected provider, selected price, wallet accounts, deadlines and transaction hashes | Public when committed/funded on NEAR |
| Task labels, encrypted tables, commitments and result-proof records | Available to authorized execution roles; public verification exposes the bounded encrypted evidence/proof |
| Wallet signing key | Remains with the wallet; NOPE receives signatures and public account information |

Sealed bids do not cryptographically force the customer to choose the lowest price. Browser encryption does not hide data from the customer's own browser, a compromised client, or malicious code delivered by a compromised frontend. The customer initially sees and encrypts the plaintext; the evaluator and planner receive different restricted inputs.

## Customer-funded NEAR escrow

- Network: **NEAR testnet**.
- Immutable shared contract: **`nope-wallet-44384e2f.testnet`**.
- Pinned code hash: **`6qzVqhNyk7KKvjzC6g8iPtJmHffTgb6YBh8Fp9xerXHy`**.
- Contract access keys were removed and the FINAL empty key list was independently checked. There is no application admin withdrawal/upgrade method.
- The shared contract keeps an independent liability for each `(buyer account, job ID)`. Customer deposits do not finance other jobs. Its separately bootstrapped storage/gas reserve is not a sponsor payment pool.
- The buyer signs `fund`; the provider or buyer can record exact delivery metadata; only the original buyer signs `accept_and_release` or an eligible `refund`.
- Execution is allowed for 24 hours from award; the review/refund boundary is 48 hours from award. Acceptance/release must be within the review window; refund is available strictly after it, subject to final contract state. Refund is a wallet action, not an automatic timer payment.
- The immutable contract accepts at most **1 testNEAR per job** and retains at most **50 jobs permanently**. The application result-proof adapter accepts the same exact **1 yoctoNEAR–1 testNEAR** selected-price range. Prices remain canonical decimal strings committed into the final proof context; real endpoint proofs cover both boundaries and reject a changed price. Native fees are additional; the user reviews them in the wallet. A larger deployment requires a new reviewed contract address.
- Unknown submission outcomes are observed without automatic signing or rebroadcast. Transfers use nonce/action-bound callbacks; failed transfers restore liabilities and other jobs remain protected.
- Legacy direct-transfer and sponsor jobs are historical read-only records in the current application.

No mainnet deployment, real-money payment support or automatic dispute arbitration is claimed. The contract records the commitments and delivery and enforces payment authorization; it **does not execute the SNARK verifier on-chain**.

## Exactly what the proof establishes

For supported typed transformations, a result SNARK verifies that the delivered labels represent the approved transformation's result relative to the buyer's precommitted mappings. The private witness stays on the customer device. Browser and API independently verify the current proof; the public verifier additionally checks the pinned contract and finalized chain binding through a trusted RPC.

This does **not** prove original CSV provenance, honest initial garbling/mapping, the provider's physical execution trace, AES execution provenance, the LLM's understanding of the customer's intent, or an independent operator quorum. The frontend, API authorization and RPC remain trust boundaries. Cryptographic result correctness is separate from customer acceptance and the native payment receipt.

## Supported work and resource limits

- Numbers: missing-value fill and clamp; blank or integer `0..254`, with `255` reserved for missing values.
- Text: trim, lowercase/uppercase and digit masking for printable ASCII, at most **16 bytes per cell**.
- At most **4 selected columns**, **32 numeric rows**, **8 rows when text is processed**, and **40 processed cells**; circuit/request-size limits also apply.
- Unselected columns are preserved locally. Rows are not silently truncated.
- Arbitrary document understanding, translation, summarization, sorting, deduplication and general-purpose encrypted LLM inference are not implemented.
- The small local model can misunderstand a goal. Human plan/preview approval is part of the workflow, not a correctness theorem.

## Reproduce the checks and build

Prerequisites: **Node.js 22.22.2 or newer** (recorded local verification used 25.6.0), npm, and Python 3.9+ for packaging the historical companion download during the web build. Rust/native FHE/MPC tooling is not required to run the current JavaScript regression suite or web build.

```sh
git clone https://github.com/Foreveranka/veil-procurement.git
cd veil-procurement
npm ci
npm ci --prefix planner-runtime --ignore-scripts
npm ci --prefix proof-runtime --ignore-scripts
npm ci --prefix wallet-runtime --ignore-scripts
npm run check:locales
npm test
npm run build
```

The recorded root suite passed **486 tests, zero failures and zero skips** on 14 November 2026. It includes genuine local cryptography and explicitly synthetic transport/RPC fixtures; it does not broadcast transactions. The build packages the wallet/planner/proof runtimes and generates `dist/`; it neither deploys nor downloads the planner's model weights.

Additional proof checks:

```sh
node proof-runtime/prepare-crs.mjs
npm run test:proof
```

The first command verifies the checked-in public SRS bytes/hashes offline. The second packages and exercises the proof runtime; its tests are separate from the root 486-test record.

### Rebuild the escrow contract separately

For the Rust contract, use the **Rust 1.98.0** toolchain used by the recorded build (the crate declares a 1.95 minimum). From the repository root:

```sh
rustup toolchain install 1.98.0 --profile minimal
rustup target add wasm32-unknown-unknown --toolchain 1.98.0
cargo +1.98.0 test --locked --lib --manifest-path payments/wallet_escrow/Cargo.toml
cargo +1.98.0 build --locked --release --target wasm32-unknown-unknown --manifest-path payments/wallet_escrow/Cargo.toml
```

These commands run contract unit tests/builds, not deployment or wallet operations. They may fetch the locked Rust dependencies. The contract README also records the exact cached local sandbox procedure used for its evidence; that machine-specific cache is not included in a fresh clone. The checked-in deployed WASM and its source/hash manifest are the release reference; a different compiler build is not automatically a reviewed or bit-identical deployment.

### Run your own full application

The hosted demo is the quickest review path. To self-host the complete application, use a Vercel-compatible Node environment and **your own private Vercel Blob store**. Set `BLOB_READ_WRITE_TOKEN` only in the server environment and `NOPE_WORKSPACE_ORIGIN` to the exact origin visitors use. Project keys, invitations and existing Blob credentials are not included in the repository.

For local development, after installing Vercel CLI (58.7.1 was used for the recorded checks) and supplying your own private Blob credential in ignored local environment configuration:

```sh
NOPE_WORKSPACE_ORIGIN=http://127.0.0.1:3000 vercel dev --local --listen 127.0.0.1:3000
```

Open `http://127.0.0.1:3000`. A plain static file server cannot provide `/api/workspace` or wallet authentication. The server/browser contract pins must match; builds and payment observation fail closed on mismatches. Neither wallet private keys nor customer plaintext belong in server configuration.

The reviewed live deployment is immutable and capacity-limited. See the contract protocol and provisioning scripts before deploying a separate testnet instance; deployment is an explicit action, never part of `npm test` or `npm run build`. The provisioning and wallet-HTTP QA scripts can create test accounts or sign testnet transactions when explicitly invoked. Do not treat them as read-only smoke commands or run them against a real wallet by copying someone else's recovery files.

## Evidence: implemented, tested and still limited

| Check | Evidence | Meaning |
| --- | --- | --- |
| Root regression | [Release checks](docs/verification/wallet-release-checks.json) | 486 passing cases; genuine crypto and synthetic adapters are identified separately |
| Real deployed HTTP lifecycle | [Production run](docs/verification/wallet-funded-http-production.json) | Genuine test-wallet NEP-413, sealed bid, exact buyer deposit, encrypted execution, actual result proof, explicit acceptance and provider payout |
| Independent public result verification | [Open the verifier](https://veil-procurement.vercel.app/verify?id=10b21c73ed75bfd8c47418524932d2bf) | Passed in live Chrome and a separate unauthenticated Node process without the buyer witness |
| Actual native payout and refund | [Financial checks](payments/wallet_escrow/verification/live-financial-checks.json) | Exact public-testnet provider payment and original-buyer refund; direct contract tests, not computation proofs |
| Locked deployment | [Independent code/key check](docs/verification/wallet-escrow-independent-deploy.json) | Finalized code, source-WASM hash and empty access-key list |
| Contract execution/failure cases | [Contract evidence](payments/wallet_escrow/README.md#actual-validation-and-deployment) | 13 contract unit tests and a real local WASM sandbox; local sandbox is not public-chain evidence |
| Wallet UI | [Wallet runtime](wallet-runtime/README.md) | Real SDK/opaque-bridge loading and live picker/cancel checked; external wallet popup signing remains unverified end to end |

Full chain transaction hashes and proof-scope qualifications are in the [wallet-funded verification report](docs/verification/wallet-funded-flow.md). No screenshot, mocked receipt, hash-only transcript or successful outer transaction is labelled a computation proof or final payout by itself.

## Languages

The product, job creation, bidding, delivery, payment screens and documentation support **Turkish, English, German, Spanish and French**. The initial language uses the country header provided by Vercel: TR → Turkish, DE → German, ES → Spanish, FR → French, otherwise English. A manual selection is remembered; customer values are not sent to a translation service. [Localization details](docs/LOCALIZATION.md).

## Repository map and prior work

- `web/`: current frontend, planner/proof clients and public verifier.
- `workspace/`, `api/workspace.mjs`: current application API, authentication, private storage and chain observation.
- `payments/wallet_escrow/`: current Rust escrow contract, protocol, frozen WASM and financial evidence.
- `wallet-runtime/`, `planner-runtime/`, `proof-runtime/`: pinned browser/runtime integration and checks.
- `docs/verification/wallet-*`: current wallet-funded integration evidence.
- `engine/`, `mpc/`, `cloud/`, `service/`, `contracts/registry/`, `payments/testnet_escrow/` and older routes: earlier FHE, MPC, cloud and payment experiments. Their evidence remains scoped to those historical runs; they are not independent production operators or the current customer-funded contract.

Earlier project/component names such as Veil and the existing GitHub/Vercel URLs remain for compatibility. [Archived prototype notes](docs/archive/LEGACY-PROTOTYPES.md) preserve the previous README's historical material. The current architecture is the six-component flow above; the shipped browser evaluator uses garbled circuits, not Concrete FHE or a distributed MPC auction.

Libraries, templates, AI assistance, model weights, fonts and upstream wallet code are attributed in [third-party notices](THIRD_PARTY_NOTICES.md). AI coding/planning assistance does not replace the stated tests or prove untested features. This repository contains both the historical prototypes and the current work; this README separates their scope instead of counting old evidence as current validation.

## License

Original NOPE code and documentation are licensed under the [MIT License](LICENSE). Third-party dependencies, model weights, fonts and vendored upstream code retain their own licenses/terms; the project license does not relicense them. See [third-party notices](THIRD_PARTY_NOTICES.md).

Private keys, seeds, local vaults, `.env*`, invitations, recovery journals and `runtime/` are excluded from Git and the allowlisted deployment. Source updates on `main` trigger the existing Vercel deployment; changing the repository's GitHub visibility and submitting a hackathon entry are separate actions.
