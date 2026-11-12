# NOPE customer and provider needs / page map

User requested real role-separated pages, bids, delivery and payments. Root remains introductory; `/workspace` is the entry to the application. Existing `/csv` remains a quick direct encrypted-compute tool, rather than pretending to be the complete marketplace.

| User need | Page | Required behavior |
|---|---|---|
| Choose a role and establish session | /workspace | Buyer/provider guest test workspace; real identity/session isolation; no fake jobs |
| See own requests and next actions | /customer | Real own jobs, stage and next step, empty/error/loading states |
| Publish a private data task | /jobs/new | Clear public brief, locally parsed CSV, supported rule/preview, encrypted task upload, locally retained decoder and original CSV |
| Find work without seeing customer data | /jobs | Open job metadata; no customer CSV, budget or all-provider quote visibility |
| Submit confidential quote | /offer?id= | Price/duration/note encrypted for buyer; commitment binds selected winning amount later |
| Track a job and compare offers | /job?id= | Owner controls close and award; buyer sees quote plaintext only after decrypting locally; provider sees own offer |
| Run awarded encrypted work and deliver | /delivery?id= | Selected provider alone gets garbled task, actual evaluation returns encoded output; buyer views result in table, optional export |
| Accept exact delivery or request revision | /delivery?id= | Exact delivery version/output hash; no acceptance when local result verification failed or key missing |
| Understand and settle payment | /payments?id= | Testnet-only direct transfer instructions, receiver and amount, real transaction verification; no escrow/real-money claim |
| Review history | /activity | Real job lifecycle records and timestamps |
| Understand device-local credentials | /settings | Guest identity and local vault boundaries; no wallet private key collection |

## Privacy / identity

Public brief is user-approved metadata; no private file names/headers/unselected columns. Numeric task uses existing GC profile, not arbitrary AI. Output decoder and original CSV are encrypted locally using a nonextractable device key in IndexedDB. Buyer quote private key stays browser-local. New tab sessions are role-scoped; losing local vault data means decryption recovery cannot be fabricated.

Bids are hybrid-encrypted to buyer and hidden until intake closes. This is sealed-to-buyer manual procurement, not a proof of MPC auction selection. The winning amount is disclosed only when buyer selects the committed quote and consents to public testnet payment metadata. Other providers cannot read competing prices or encrypted task before selection.

Payments are direct testnet NEAR transfers verified against actual successful chain transfer receipts, signer, selected recipient/amount, timestamp and anti-reuse. They are NOT escrow, a mainnet payment system, or automatic dispute arbitration. A paid label requires a verified receipt. App ledger state and testnet transaction finality remain distinct facts.

## Acceptance tests

Two real isolated browser sessions: buyer publishes one encrypted CSV task; provider finds it and submits encrypted quote; buyer closes intake, decrypts/chooses quote; selected provider actually evaluates ciphertext; buyer decodes/compares result directly in app and accepts exact version; payment page shows due, never paid until actual verified testnet receipt. Negative tests cover unauthorized task/quote access, stale version acceptance, quote commitment mismatch and false/reused transfer claims.

## Main browser persistence verification

A synthetic local WebCrypto/IndexedDB smoke test actually stored an encrypted CSV, RSA buyer key, nonextractable AES key and sealed GC decoder, reloaded the real browser page, loaded the same key material and decoded the genuine evaluated output[0,100,42,5]. The exact public RSA key survived reload. The test namespace was explicitly cleared afterwards. Unit tests with a memory adapter remain distinct from this actual browser check.

## Completed end-to-end verification (12 Nov 2026)

Two isolated real browser sessions completed publish → encrypted quote → close → locally decrypt quote → award → genuine GC execution → buyer-local before/after result → exact version acceptance → actual 0.001 testNEAR direct transfer → read-only receipt verification → PAID. The local preview used the real private Blob adapter, not memory fixtures. The original CSV and decoder survived reload. Public synthetic result and transaction hash are recorded in `verification/workspace-browser-result.json`; no session token or private key is included. Hosted deployment routing/onboarding is checked separately.
