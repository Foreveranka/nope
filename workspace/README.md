# Guest workspace backend

Assigned implementation only: `workspace/**`, `api/workspace.mjs`. No deployment,
environment modification, wallet keys, signing, transfer broadcast or new service.

## Integration

```js
import {createWorkspaceHandler} from '../api/workspace.mjs';
const handler = createWorkspaceHandler({env: process.env});
```

Default export uses private Vercel Blob with the existing `BLOB_READ_WRITE_TOKEN`.
`NOPE_WORKSPACE_ORIGIN` is the exact allowed origin, default
`https://veil-procurement.vercel.app`. For local preview explicitly configure an
`http://localhost:PORT` or `http://127.0.0.1:PORT` origin on the server. There is no
forwarded-host authorization and no client-selected RPC endpoint. POST requires
an exact Origin. Authenticated GET may omit Origin, as native same-origin browser
GET requests do, but a supplied foreign Origin or cross-site fetch is rejected.

Adapter accepts direct `/api/workspace/jobs/ID` paths or
`/api/workspace?route=jobs/ID`. Main owns rewrites. A Web Request core is exported
as `createWorkspace({store,env,now,verifyPayment})` for integration/tests; injected
memory stores and RPC fixtures are explicitly test-only, never production fallback.

Every response is JSON, no-store; errors are `{error,code}` with no secret details.
Only GET and POST; max 1 MiB request, bounded raw/parsed/streaming bodies, duplicate
JSON keys rejected. All routes except session creation require a 32-byte bearer.
Only its SHA-256 hash is persisted. The client quota cookie is random, HttpOnly,
SameSite=Strict, Secure in HTTPS, hashed in Blob; no IP addresses are collected.

## REST contract

- `POST /session {role,displayName,paymentAccount?}` → 201 `{token,session}`;
  role buyer/provider, name 1–40 chars, optional account `.testnet` or lowercase
  64-hex implicit address. Session `{id,role,displayName,paymentAccount}`.
- `GET /session` → `{session}`.
- `GET /jobs[?cursor=...]` → `{jobs,nextCursor}`; buyer own jobs, providers published
  summaries; up to 20 indexed entries per page. Advance nextCursor even for empty
  buyer pages. No offers in summaries.
- `POST /jobs {jobId,title,description,deadlineISO,profile,rowCount,task,buyerPublicKey}`
  → 201 `{job}`. Client-chosen jobId is 32 lowercase hex; persist local decoder
  **before** publishing. Exact same buyer + canonical JSON retries return 200
  existing job, including after later state changes. Conflicting creation returns
  409. Title 1–100, description 0–1000; UTC ISO deadline in next 30 days. Profile
  `nope-csv-gc-v1`, 1–32 rows, exact existing GC request schema; public RSA-2048
  OAEP-SHA256 JWK only. No filenames, headers, budgets, decoder or unknown fields.
- `GET /jobs/:id` → `{job}`.
- `POST /jobs/:id/offers {envelope:{wrappedKey,iv,ciphertext},commitment}` → `{job}`;
  provider only, payout account required. Canonical base64 RSA key 256 bytes, IV12,
  GCM ciphertext >=17 bytes; entire envelope <=8 KiB. One immutable offer/provider;
  intake before deadline, at most64/job. Offer
  `{id,providerId,providerName,paymentAccount,envelope,commitment,createdAt}`.
  Commitment SHA256 of exact `JSON.stringify([jobId,providerId,amountYocto,salt])`.
- `POST /jobs/:id/close {}` → `{job}`; owning buyer may close early.
- `POST /jobs/:id/award {offerId,amountYocto,salt}` → `{job}`; owning buyer, CLOSED.
  Salt exactly64 lowercase hex (32 bytes). Amount canonical positive integer string
  1e18 through100e24 yocto, test NEAR only. Exact commitment verified; only winner's
  amount becomes public through this explicit buyer action. Salt is not persisted.
- `GET /jobs/:id/task` → `{task}`; owning buyer or awarded selected provider only.
- `POST /jobs/:id/execute {}` → `{job}`; selected provider only. In-process adapts
  actual `api/csv-gc.mjs`, no decoder, fake results or alternate circuit. Repeats
  return existing delivery. A buyer-requested revision reexecutes the same task
  and increments delivery version (maximum20 decisions).
- `POST /jobs/:id/decision {decision:'accept'|'revise',version,outputSha256}` → `{job}`;
  owning buyer, exactly latest delivery version/hash. Accept → ACCEPTED/payment DUE;
  revise → REVISION. No automatic buyer acceptance.
- `POST /jobs/:id/payment/verify {transactionHash,buyerAccount}` → `{job}`;
  owning buyer only after acceptance. Read-only fixed FastNear testnet RPC, FINAL
  success, all receipt success, exactly one Transfer of exact award amount to exact
  selected account, matching transaction hash and signer. Fetches transaction and
  receipt blocks and checks timestamps >=job creation. Global immutable transaction
  claim prevents reuse across jobs. Failures/pending never produce PAID.

Job public fields: `id,buyerId,buyerName,title,description,deadlineISO,status,profile,
rowCount,createdAt,updatedAt,buyerPublicKey,offerCount,selectedOffer,delivery,payment,
revision,events`. `events` are actual committed operations only:
`{stage,status,at,actorId}`. Competing provider actorId redacted to null in public
views. Older pre-events records read as empty event lists; no synthetic history or
migration. Public selectedOffer `{offerId,providerId,paymentAccount,amountYocto}`.
Delivery `{outputs,inputSha256,outputSha256,programSha256,version,deliveredAt}` only
buyer/selected provider; unrelated providers get null. No CSV plaintext on server.
Owning buyer sees `offers` only after CLOSED; provider sees only `ownOffer` in
job detail. No history endpoint. Losing plaintext prices never reach the server.

## Durability and limits

Private `nope-workspace-v1/` Blob namespace. Separate task record, token-hash session
record, discoverability index, sequential immutable job revisions with preceding
record hashes. `allowOverwrite:false` reserves each version atomically, following
the existing procurement store pattern. Occupied/uncertain writes are read back;
unknown outcomes fail closed. Concurrent edits may return409; retrieve current job
before retry. Quota slots reserve at most5 created jobs and20 offer operations per
client, shared across role sessions, at most10 sessions per client and50 global
sessions per UTC day. Clearing cookies creates a new client; global daily cap still
bounds public session creation. Immutable failed reservations can conservatively
consume quota. Maximum256 job revisions and bounded events. Listing/history uses
sequential reads, suitable for this limited pilot; no performance claim.

Payments are labeled `DIRECT_TESTNET_TRANSFER`, **not escrow**. A transfer has no
job memo or cryptographic job binding: the buyer associates an eligible observed
transfer with one job, protected by a global application-ledger claim. No custody,
private wallet, signing, automatic spending or mainnet. Test RPC fixtures do not
establish that an actual payment occurred. GC transcript hashes are not execution
proofs; evaluator and garbler retain the existing prototype trust model.

## Verification

`node --test workspace/workspace.test.mjs` exercises roles/isolation, native GET
Origin behavior, schema/envelope/body bounds, real GC decode, actual browser-vault
RSA/AES compatibility, exact delivery decisions, job replay/concurrency/unknown
writes, private immutable Blob options, daily/session/job/offer quotas and
read-only synthetic RPC negative/success/reuse cases. Test stores are explicitly
synthetic; no live service writes or funds sent by these tests.
