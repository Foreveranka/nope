# Official Market connection status — 12 November 2026 (Istanbul)

**Real transports and scoped read/preparation are implemented. Financial connection
is not certified complete. No authenticated account calls or live financial
mutations were performed in this implementation run.** No registration, wallet
creation, deposit, spend, dispute bond, trade or live `/mcp/pro` call was made.

## Evidence actually checked

Anonymous GET fetched the complete [official OpenAPI](https://market.near.ai/openapi.json)
(213,087 bytes, version 2.0.0, SHA-256
`2c7b2496e05f56aece8b13f8a825845a54b8cae9689efd4f3acf79ea28e32cd3`).
This equals the earlier snapshot; it was freshly fetched, not merely reused.
The exact file and acquisition records are in `official/`.

The implemented HTTPS/REST client successfully validated real anonymous responses:

- `GET /healthz`: `{"status":"ok","version":"0.1.0"}`.
- `GET /v1/platform/config`: matches `PlatformConfigResponse`.
- `GET /v1/agents?limit=1`: matches `BrowseAgentsResponse`.

See `fixtures/official-readonly-check.json` for timestamps and response digests.
Only the health payload was saved. These public checks establish connectivity and
schema compatibility, not account access or financial correctness.

[Official buyer guide](https://market.near.ai/skill/mcp-buyer/SKILL.md), version
0.45.0, and [worker API reference](https://market.near.ai/skill/reference/agent-api.md)
were fetched and saved. Anonymous OAuth resource metadata advertises resource
`https://market.near.ai/mcp`, scope `mcp`, and header bearers. This is not a
read-only spending scope. No OAuth registration/authorization/token endpoint was called.

[Official endpoint comparison](https://docs.market.near.ai/mcp/pro) explicitly says:

| Operation | `/mcp` | `/mcp/pro` |
| --- | --- | --- |
| Hire | `prepare_job` saves a draft; approval is on the website | `create_job` holds price in the call |
| Award | `award_bid` returns a job-page link | `award_bid` holds bid amount in the call |
| Accept | `accept_result` returns a job-page link | `accept_result` accepts and releases payment in the call |

Therefore an approval link never means a hold, acceptance or payment happened.

## Concrete implementation

- `openapi.py`: pinned full official REST contract, local-ref resolution, request
  parameters/bodies and response validation; numeric OpenAPI formats normalized
  with bounds. Unknown assertions remain unsupported, not silently ignored.
- `http.py`: fixed official HTTPS origin, injected role/principal-bound bearer,
  no cookies, redirects or automatic retry; bounded JSON and correlated SSE,
  socket timeout and a deadline checked between reads; redacted errors.
- `market.py`: buyer `/v1/me` identity check, worker identity checks, explicit
  resource allowlists, bounded actual-row offset pagination, native job/bid/
  assignment/version/ledger reads and durable hash-only plans.
- `market_mcp.py`: real initialize/session/protocol negotiation, paginated
  `tools/list`, reviewed schema pins, schema-validated reads/plans and optional
  nonfinancial `prepare_job` dispatch/recovery. Endpoint cannot drift to another host.
- `market_writes.py`: actual `/mcp/pro` award/accept dispatch behind explicit
  authorization, role/binding, atomic shared budget, fresh official preflight and
  reviewed discovered-schema gates. No stock write authorization or enabled
  capability is supplied. Native award needs job/bid, not invented hash arguments.
  Acceptance additionally needs current local artifact verification and an actual
  advertised, reviewed server atomic version/hash comparison.

These are independent of the unchanged local `PaymentAdapter`/`LocalFixtureRail`.
No root, service, registry, gateway or deployment wiring was changed.

## Exact live blockers

| Boundary | Current official evidence / missing guarantee | Result |
| --- | --- | --- |
| Authenticated schemas/identity | OpenAPI has **no** `securitySchemes`. It does not define MCP tool schemas. No authorized principal/token was injected and no authenticated `tools/list` captured. | Auth transport is implemented. Actual account permissions, structured outputs and current tool schemas are unverified. Review principal-specific schemas/pins before use. |
| Buyer award/accept REST | `paths` has job/bid/version reads and worker submit, but **no** buyer award/accept or separate hold/release route. | No invented REST mutations. Buyer calls use real negotiated MCP tools only. |
| Exact-version acceptance | Buyer guide documents `accept_result {job_id, assignment_id?}`. It does **not** document expected version/hash arguments. `/mcp/pro` docs say this call releases payment. `JobAssignment` and `DeliverableVersionView` expose read hashes/versions; those reads are not an atomic compare constraint. | The **documented** contract cannot enforce the current acceptance trust terms. No pre/post-read substitute. Exact authenticated discovery is still needed to determine whether any additional enforceable guard exists; absence in unobserved tools is not claimed as proven. Current accept remains blocked. |
| Assignment-linked funding | `JobAssignment.escrowAmount`/`escrowToken` show assignment terms. `LedgerEntryResponse` exposes `status`, `kind`, `jobId`, free-string `referenceKind`/`referenceId`, direction, currency, provider ref and idempotency root. It does not define the assignment reference-kind values or full split-funding projection. | Candidate rows are returned; `confirmed_hold` stays false. No inference from job ID, memo or nominal escrow amount. |
| Financial UNKNOWN | No reviewed award/accept client idempotency parameter or exact-operation lookup is established. Ledger idempotency roots may have multiple retry rows and are platform-side, not a promised caller key. | Single-attempt durable outbox, per-assignment/action locks and retained shared budget. Missing response, accepted/current state, empty page or elapsed time cannot authorize resend. Read-only reconciliation never invents a lookup route or clears an unresolved financial lock. |
| Nonfinancial draft recovery | Standard `/mcp` buyer guide explicitly documents `prepare_job.client_request_id` replay returning the same draft, eventually its externally approved job. Exact actual input/output schemas still require discovery. | Optional real draft call is implemented. Same-key/same-payload recovery is supported only here. It never approves or spends; replay results are not settlement evidence. |
| Automatic release | `Job.acceptanceWindowDays`, assignment frozen window, worker `autoAcceptAt`, and official [payments docs](https://docs.market.near.ai/concepts/payments-and-disputes) document automatic acceptance after 3–7 days. Accept may queue a USDC payout; accepted status alone is not confirmed settlement. | Local verification pause does not stop the platform clock. Terms permitting only explicit buyer acceptance are incompatible with this documented automatic path unless the platform offers a separately verified control. No timer cancellation endpoint is fabricated. |
| Private onboarding / output policy | Reads can check private/single-slot/USDC/native bid identities. No public fallback is allowed. Local context/selection/receipt hashes are not automatically server-enforced terms. | Creation/onboarding/privacy and delivery-policy enforcement are not claimed complete. Worker API token does not authorize buying. |
| Refund/dispute/splits | Dispute requires a paid deposit; split and refunded statuses need full financial evidence. | Not dispatched in this scope. Cancelled status is not refunded-money proof. |

## Testing limits

`official-rest-sanitized.json` contains **authored, non-secret values conforming to
real official REST schemas**, not captured customer transactions. Public health is
an actual captured response. `test_market_mcp.py` uses clearly named protocol mocks;
its atomic-accept capability is **hypothetical**, not a discovered platform feature.
The existing fake fixture remains intact and is still labelled simulation.

Tests exercise real request construction/parser/schema code with offline HTTP
responses, schema drift, identity/price/version mismatch, private scope, timeout,
restart, no-retry UNKNOWN handling, shared-budget concurrency and default missing-CAS
failure. They do not establish live settlement, multi-host financial safety or
independently operated escrow. Local SQLite is trusted and shared across callers.
