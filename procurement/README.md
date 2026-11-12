# Procurement HTTP contract (v1, frontend alignment)

Import `createProcurement` from `procurement/core.mjs` and `blobProcurementStore` from
`procurement/blob.mjs`. `createProcurement({store,env,now,selectionVerifier})` returns
an async `(Request) => Response`. Main owns mounting/routing; this module does not
modify the existing gateway. Only Node builtins are used by the domain. Blob uses
the existing installed `@vercel/blob` package.

All routes start `/api/procurement`. JSON responses have `Cache-Control: no-store`.
Errors: `{error: string, code: string}`. No cookie auth or CORS. Bearer invitations
are held in browser memory only, never localStorage/sessionStorage/cookies/URLs.
`NOPE_PROCUREMENT_GRANTS` is a JSON array of exact
`{tokenHash: lowercaseSHA256, principal: canonicalNearAccount, role: 'buyer'|'provider'|'operator', expiresAt: unixMilliseconds}`.
An invitation token is 43–128 base64url characters; only its hash is configured.
`NOPE_PROCUREMENT_ORIGIN` optionally permits one exact HTTPS origin. Without it,
browser Origin must equal the request URL origin. Foreign origins are rejected.

All POSTs require `Content-Type: application/json` and `Idempotency-Key` (16–80
ASCII letters/digits/underscore/hyphen). Reuse exactly the same key and body on
network uncertainty. Reuse within the same job and principal/role for another payload/action is 409. Mutations after
creation carry `expectedRevision` (integer, optimistic concurrency).

- `GET /health`: public, accurate capabilities, no identities or jobs.
- `GET /session`: `{principal,role,expiresAt,profile:'clean-4-records-v1',ledger:'app',blockchainBinding:'pending',capabilities:{...},availableProviders?:string[]}`. Buyer sessions alone include sorted unique active provider principals in `availableProviders`; no hashes or provider expiry metadata.
- `POST /jobs` (buyer): exact `{jobId,title,profile,roster,bidDeadlineNs,resultDeadlineNs}`.
  `jobId` is client-generated 32 lowercase hex; safe public `title` is 1–100 ASCII
  letters/digits/spaces/`.,()_-`; profile exactly `clean-4-records-v1`; roster is
  exactly THREE unique sorted canonical account principals with active provider
  grants, excluding buyer. Both deadlines are canonical decimal U64 nanosecond
  strings, bid deadline in future, result later and within 30 days of bid.
  Returns 201 `{job}` with `status:'DRAFT'`, revision 0. Drafts are visible only to
  their buyer (operators have no blanket job read access).
- `GET /jobs?limit=20&cursor=...`: `{jobs:[Job],nextCursor:string|null}`; limit 1–20.
  Own participant index only. Empty pages can occur for unpublished drafts.
- `GET /jobs/{jobId}`: `{job}` only buyer or published job's roster member.
- `POST /jobs/{jobId}/publish` (buyer): exact
  `{expectedRevision,intent,budgetCommitment}`. `intent` is the EXACT validated
  `mpc/v2.py` v2 intent schema (below), matching buyer, roster and deadlines of the
  draft. Context is computed with its ordered binary codec, never JSON hashing.
  Budget commitment is nonzero lowercase SHA256 using existing v2 slot 0 codec.
  Returns `{job}` with `status:'PUBLISHED'`; no registry transaction is implied.
- `POST /jobs/{jobId}/bids` (invited provider, before bid deadline): exact
  `{expectedRevision,commitment}`. One immutable nonzero SHA256 commitment per
  provider; slot is roster index + 1. Never send price, salt, budget or customer data.
- `POST /jobs/{jobId}/close` (buyer, at/after bid deadline, before result deadline):
  exact `{expectedRevision}`. Freezes ALL three slots including missing nulls.
  Status `CLOSED`; missing bids cannot proceed to selection.
- `POST /jobs/{jobId}/selection` (operator only): exact
  `{expectedRevision,evidenceHash}`. Hash references externally supplied evidence;
  HTTP never accepts arbitrary verifier claims. Returns 503
  `SELECTION_UNAVAILABLE` unless a server-configured adapter validates actual
  signed committee evidence bound to this frozen job/context/roster/commitments.
  No lowest-hash winner or fake MPC. Buyer/providers are 403. Validated result
  returns `{job}` with status `SELECTED` and selected provider.
- `POST /jobs/{jobId}/deliveries` (selected provider only, before result deadline):
  exact `{expectedRevision,version,outputHash,receiptHash}`. Version starts at 1,
  increments by 1. Hashes refer to encrypted output and receipt, not plaintext.
  Returns `{job}`, `status:'DELIVERED'`. Delivery supersedes earlier versions.
- `POST /jobs/{jobId}/decision` (buyer only): exact
  `{expectedRevision,version,outputHash,receiptHash,decision:'accept'|'reject'}`.
  Must match latest delivery exactly, including revision/hashes. Returns `{job}`,
  `status:'ACCEPTED'|'REJECTED'`. Rejected delivery permits a new delivery version
  before deadline. Acceptance terminal, never claims payment or verified execution.

Job fields: `{id,title,profile,buyer,roster,bidDeadlineNs,resultDeadlineNs,status,
revision,createdAt,updatedAt,ledger:'app',blockchainBinding:'pending',
intent:null|Intent,contextHash:null|string,budgetCommitment:null|string,
bids:[{provider,slot,commitment:null|string}],closedAt:null|number,
selection:null|{provider,evidenceHash},deliveries:[{version,outputHash,receiptHash,submittedAt}],
decision:null|{version,outputHash,receiptHash,decision,decidedAt}}`.
No budget, prices, salts, CSV, plaintext files, arbitrary text notes, private keys,
transactions or payment execution are accepted or stored. Bids remain hashes;
commitment admission cannot prove a secret opening is valid.

Intent exact fields (all required):
`{version:2,profile:'sealed-cheapest-3-spdz2k-v2',networkDomainHash,registryAccount,
buyer,roster,qualified:[boolean,boolean,boolean],fixedFee:number,bidDeadlineNs,
resultDeadlineNs,specHash,circuitHash,keyHash,outputPolicyHash,inputHash,
registryExecutor,intentNonce,selectionRound,mpcProgramHash,upstream}`.
Hash fields are nonzero lowercase 64 hex. `fixedFee` is integer invoice MICRO-UNITS
0..10^12, matching Python MAX_AMOUNT; buyer budget/bid micro-units NEVER enter
HTTP. Registry account/executor/buyer/roster use canonical NEAR account spelling.
Program hash and upstream must match repository `mpc/programs/sealed_procurement_v2.mpc`
and `mpc/auction.py`. Intent hashing uses `VEIL-INTENT-v2\0` and exact Python
ordered BE codec. Secret commitments use
`SHA256('VEIL-MPC-v2\0' || context32 || slot_u8 || amount_u64BE || salt32)`.
No arbitrary buyer can invoke registry owner-only `create_job`: app publishing is
explicitly pending binding, never advertised as on-chain publication.

Storage uses private immutable creates, no TTL and no overwrites/deletes. Per-job
revision files implement CAS on the next revision pathname; each stores a complete
bounded snapshot and request fingerprint/idempotency metadata. Participant index
entries are reserved before first revision; readers authorize canonical job data,
so crash-orphaned index rows do not grant access. At most 64 revisions per job (0–63). The final slot is reserved for a buyer decision; new deliveries at revision 62 are rejected so an existing delivery can still be accepted/rejected.
A conflict is 409 `REVISION_CONFLICT`; retry after GET with a new idempotency key.
A confirmed write whose response was lost replays the original revision (same
status/body), even after later revisions. An unresolvable storage outcome returns
503 `STORAGE_UNKNOWN`: GET/retry the SAME key/body; never infer failure/success.

## Actual selection adapter

The implemented `operators/selection-verifier.mjs` exports
`createSelectionVerifier({committee,expectedCommitteeHash,loadEvidence,now,allowLocalSynthetic})`.
Inject its return value as `selectionVerifier` into `createProcurement`. The API
calls `await selectionVerifier.verify({job,evidenceHash})` with an independent
snapshot of the exact CLOSED revision. It requires EXACT
`{provider,contextHash,evidenceHash,closedRevision,commitments}` back; commitments
are `[budgetCommitment,...three frozen bid commitments]`. The core rechecks all
bindings, qualified provider membership, deadline, invitation expiry and CAS.
The adapter must only validate, never execute a selection or payment side effect;
same-key concurrent requests may independently validate before the durable fence.

The actual operator module verifies 3/3 configured Ed25519 signatures, a pinned
committee hash/epoch, report expiry and all frozen intent/job bindings.
`loadEvidence(hash)` returns canonical immutable JSON **bytes**, at most 16 KiB,
from server-owned storage. The HTTP caller supplies a hash only, never a URL,
trust anchor, committee, signing key or report object. No evidence ingress,
committee configuration, signing keys or external operator service is provisioned
by this module. Main owns wiring its server-owned evidence source. Unconfigured
HTTP adapter remains fail closed. Local synthetic evidence requires explicit
adapter opt-in; signatures alone are operator reports, not an MPC execution proof
or evidence of independent operation.

## Store interface and capability response

`store.read(path)` -> JSON record or null; errors propagate as unknown.
`store.create(path,value)` -> true when immutable create succeeds, false if the
pathname is occupied; thrown errors can have unknown outcomes and are read back.
`store.list({prefix,limit,cursor?})` -> `{pathnames:string[],cursor:string|null}`.
No overwrites, deletions, signed uploads or plaintext transport exist here.
Production uses the private Blob adapter. CAS correctness relies on Blob's
create-if-absent semantics and private store availability, not process-local locks.
No TTL is set: record retention is durable until separately administered.

Health/session capabilities are exactly
`{durableAppLedger:true,sealedCommitments:true,selectionAdapterConfigured:boolean,
blockchainBinding:false,encryptedExecution:false,independentOperators:false,payments:false}`.
They describe this API's implemented functions, not a successful storage probe or
an independently operating external committee. No secret/environment values appear
in health. No execution, chain publication or payments are performed by this API.

Validation: `node --test tests/procurement*.test.mjs operators/tests/selection-verifier.test.mjs`.
Domain tests cover live role/object auth, deadlines/expiry, frozen slots, bounded
pagination/revisions, duplicate-key rejection, restart replay, concurrent CAS,
unknown write outcomes, exact latest delivery acceptance and rejection/resubmission.
Codec tests compare intent bytes, context and four commitment boundary vectors
against **the existing Python implementation**, and pin the actual circuit bytes.
Blob tests check private create-only options, constrained prefixes, bounds and
uncertain outcomes with a mocked SDK. Operator-owned tests exercise actual Ed25519
verification through the real HTTP core. No live Blob writes were made by these
tests; deployment, real external operation and payment execution are not tested.
