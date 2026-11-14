# Wallet-funded workspace backend

New jobs use `WALLET_TESTNET_ESCROW` on **NEAR testnet**, with wallet ownership,
sealed offers, encrypted typed execution and v4 result-correctness proofs. The
buyer funds the selected amount from their own wallet; the backend prepares
immutable transaction intents and observes the chain. It does not sign or
broadcast wallet transactions. Legacy sponsor/direct-transfer jobs are historical
**read-only** records while the wallet policy is active.

## Deployment and trust boundary

The shared public policy in [wallet-config.mjs](wallet-config.mjs) must match
[the browser pin](../web/wallet-pins.mjs) exactly:

```js
{
 network:'testnet',
 contractId:'nope-wallet-44384e2f.testnet',
 codeHash:'6qzVqhNyk7KKvjzC6g8iPtJmHffTgb6YBh8Fp9xerXHy',
 domain:'NOPE:WALLET-ESCROW:V1:testnet',
 requireKeyless:true
}
```

The observer checks code hash, empty contract access-key list and hold at the
same FINAL block. The keyless contract has no upgrade/admin withdrawal method.
Its separately funded storage/gas balance does not fund customer payments.
Holds are indexed by `(buyer_account, job_id)`, limited to **1 testNEAR per hold**
and **50 permanent holds** across the deployment; paid/refunded entries still
consume capacity. The v4 proof-binding adapter accepts the same selected-price range, **1 yoctoNEAR
through 1 testNEAR** (1 through 10^24 yoctoNEAR), as an exact canonical decimal
string committed into the final proof context. See [contract source](../payments/wallet_escrow/src/lib.rs).

The application verifies SNARKs before accepting/releasing a v4 delivery. The
contract itself checks wallet authority, immutable terms and latest delivery,
not SNARKs. An independently submitted buyer wallet transaction can bypass the
application decision gate; on-chain `Paid` alone is not a computation proof.
Result proofs establish typed correctness relative to the buyer's precommitted
ordered label mappings. They do not establish original CSV provenance, honest
garbling, AES execution provenance, provider execution origin or correct LLM
intent. The public verifier uses RPC-backed chain checks, not a light client.

## HTTP and authentication

[api/workspace.mjs](../api/workspace.mjs) exports
`createWorkspaceHandler({env,store?,handle?})`; production uses private Vercel Blob
with `BLOB_READ_WRITE_TOKEN`. `NOPE_WORKSPACE_ORIGIN` is an exact origin, default
`https://veil-procurement.vercel.app`. Local origins must be explicitly configured.
There is no forwarded-host authorization, caller-selected RPC or in-memory
production fallback. The Web Request core is `createWorkspace(...)` in
[core.mjs](core.mjs); injected stores/RPC are test seams.

Hosted requests use `/api/workspace?route=jobs/ID/...`; paths below are logical
routes. Direct `/api/workspace/jobs/ID/...` is also supported by the adapter.
Responses are JSON with `Cache-Control:no-store`; errors are `{error,code}`.
POST requires matching Origin and application/json. Authenticated GET may omit
Origin; a supplied foreign Origin or cross-site fetch is rejected. Bodies reject
duplicate JSON keys and are capped at 1 MiB, with a 3 MiB task-creation allowance.

Create a buyer/provider session, then authenticate its wallet:

| Route | Request | Response / boundary |
| --- | --- | --- |
| `POST /session` | `{role,displayName,paymentAccount?}` | `{token,session,proof,wallet}`; role buyer/provider |
| `GET /session` | Bearer token | `{session,proof,wallet}` capabilities |
| `GET /wallet` | Bearer token | `{wallet:null\|linkedWallet}` |
| `POST /wallet/challenge` | `{accountId}` | `{challenge}`; five-minute NEP-413 challenge |
| `POST /wallet/verify` | `{challengeId,accountId,publicKey,signature}` | `{wallet,session}` after cryptographic and FINAL key checks |

All routes except session creation and public proof evidence require the session
bearer. Only the token hash is persisted. Wallet challenges bind account, role,
session, origin, nonce, timestamps and callback URL `/settings`; the exact signed
message/nonce/recipient/callback must be preserved. Public keys are ed25519
base58; signatures are canonical base64 of 64 bytes. A current FINAL FullAccess
key must verify the signature. Nonces are one-use, and a session cannot switch
accounts after linking. Provider payout account is derived from the linked wallet.
Role/account identities are stable across fresh verified sessions, allowing the
original buyer to recover escrow access without their old browser session. This
does not recover the local CSV, decoder or proof witness.

## Job and payment API

New jobs require profile `nope-csv-proof-plan-gc-v4` and a linked testnet wallet.
Save the encrypted local vault records before publication. Only public brief,
anonymous schema/plan, encrypted task and commitments are sent; original CSV,
headers, private label pairs, salts and decoder remain local. Offers contain
RSA-OAEP/AES-GCM encrypted quotes; only the selected price/provider become public.

| Route | Body / behavior |
| --- | --- |
| `GET /jobs`, `GET /jobs/:id` | Paginated summaries/detail; buyer owns by wallet, provider sees own offer |
| `POST /jobs` | `{jobId,title,description,deadlineISO,profile,rowCount,task,buyerPublicKey,publicTask}`; exact creation retries are idempotent |
| `POST /jobs/:id/offers` | `{envelope:{wrappedKey,iv,ciphertext},commitment}`; one offer per provider wallet |
| `POST /jobs/:id/close` | `{}`; owning buyer closes bidding |
| `POST /jobs/:id/award` | `{offerId,amountYocto,salt}`; verifies quote commitment and publishes selected terms |
| `GET /jobs/:id/task` | Owning buyer or selected provider only |
| `POST /jobs/:id/execute` | `{}`; selected provider, FINAL funding, before execution deadline; real GC evaluation |
| `POST /jobs/:id/proof` | `{version,outputSha256,bundle}`; buyer, exact latest delivery, all actual proofs verified |
| `POST /jobs/:id/decision` | `{decision:'accept'\|'revise',version,outputSha256}`; recorded latest delivery required; accept additionally requires current proof |
| `POST /jobs/:id/payment/prepare` | `{action:'fund'\|'record'\|'release'\|'refund'}` → `{job,intent}`; intent may be null when no new signature is allowed |
| `POST /jobs/:id/payment/confirm` | `{action,transactionHash}` → `{job}` after read-only observation; hash is not finality by itself |
| `POST /jobs/:id/payment/refresh` | `{}` → `{job}`; observation only, never signs/rebroadcasts |
| `GET /jobs/:id/proof/evidence` | Public, no bearer; current ciphertext transcript, binding, delivery and verified proof bundle |

Quote commitment is SHA-256 of `JSON.stringify([jobId,providerId,amountYocto,salt])`.
The wallet award API accepts decimal strings from **1 yoctoNEAR through 1 testNEAR** (the proof workflow has the narrower range above); salt is
64 lowercase hex. Execution/review deadlines are fixed at award time +24/+48 hours.
The quote-intake `deadlineISO` is separate. Accept produces `ACCEPTED` with payment
`RELEASE_READY`; it does not spend funds. Revision invalidates prior proof metadata.

Intent actions contain exactly one FunctionCall at 150 Tgas, pinned receiver,
exact signer, method, JSON args and deposit. Preserve `JSON.stringify(args)` bytes
and key order through the wallet. `fund({terms})` attaches exactly `terms.amount`;
record/release/refund attach zero. Buyer funds/releases/refunds; provider normally
records, with exact-buyer recording permitted for recovery. Terms include ordered
job ID, buyer commitment/account, provider, amount, input/program/plan hashes and
string U64 deadlines. The binding hashes the all-string tuple beginning with
domain and contract ID; see [wallet-escrow.mjs](wallet-escrow.mjs).

## State, receipts and recovery

Job states: `OPEN → CLOSED → AWARDED → DELIVERED → ACCEPTED → PAID`, with
`REVISION` looping to execution and eligible expiry ending in `REFUNDED`.
Payment states include `NOT_FUNDED`, `FUNDING_PENDING`, `HELD`, `RECORD_PENDING`,
`RELEASE_READY`, `PAYOUT_PENDING`, `REFUND_PENDING`, `PAID`, `REFUNDED`, `ERROR`
and `UNKNOWN`. These differ from operation statuses `PREPARED`, `PENDING`,
`UNKNOWN`, `FINAL`, `ERROR` and `EXPIRED`.

A wallet result never authorizes local PAID. Confirmation checks the exact
transaction bytes, FINAL connected receipt tree, native recipient/amount and
nonce-bound private callback. `stateVerified` and `receiptVerified` are separate:
a lost hash can reconcile matching FINAL state without inventing a receipt/hash.
A pending native transfer is never treated as paid or permission to resend.

After review expiry the original buyer signs `refund`; money returns to that
buyer's wallet, not a sponsor pool. Silence never accepts or pays a delivery.
Only an unresolved **record** operation can be retired once the same pinned FINAL
block is past the review deadline and the hold has no pending transfer. Its
immutable retirement marker prevents late record confirmation from replacing the
new refund. Unknown fund/release/refund operations retain their stricter guards.

## Storage, bounds and checks

Private Blob uses immutable `nope-workspace-v1/` task, session, index, revision,
proof and wallet records. Wallet records cover sessions, challenges, one-use
claims, intents/retirement markers and transaction claims. Writes use
`allowOverwrite:false`; races may return 409 and require reading current state.
Quotas are 5 jobs/20 offer operations/10 sessions per client and 50 global sessions
per UTC day; at most 64 offers/job and 256 job revisions. The random quota cookie
is HttpOnly/SameSite=Strict; no IP addresses are collected.

Typed execution supports up to 4 selected columns, 32 numeric or 8 text rows,
16 tagged ASCII bytes/text cell, 10,000 total gates and 40 processed-cell proofs.
The proof bundle limit is 1 MiB minus 1 KiB. These are bounded pilot limits.

Recorded 14 November 2026 validation: **486 root tests passed**, including
**19 wallet-client tests**; [release checks](../docs/verification/wallet-release-checks.json)
record counts and scope. `npm test` runs the root suite. Fixtures are not chain
evidence; no test/build rerun is implied by this documentation update.

Actual production Node signing through HTTP/private Blob completed synthetic
one-row job `10b21c73ed75bfd8c47418524932d2bf`: test-wallet NEP-413 authentication,
funding, encrypted execution, delivery recording, real SNARK, buyer acceptance and
FINAL payout. See [production evidence](../docs/verification/wallet-funded-http-production.json)
and [verification guide](../docs/verification/wallet-funded-flow.md).
Live Chrome separately passed wallet picker/cancel and opaque transport checks,
plus the [independent public SNARK/chain verifier](https://veil-procurement.vercel.app/verify?id=10b21c73ed75bfd8c47418524932d2bf).
These checks do **not** establish third-party wallet popup login/signing; that
interactive acceptance check remains uncompleted. Historical sponsor evidence is
not reclassified as wallet-funded evidence.
