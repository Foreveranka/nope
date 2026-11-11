# Configure separate Market roles

This is a library integration, not gateway/service wiring. Python 3.9+ standard
library only. Keep every runtime DB outside tracked source and use owner-only
runtime-directory permissions. No credentials belong in JSON, SQLite, fixtures,
arguments printed by a CLI, source control or logs.

## Buyer REST and worker REST

Supply existing credentials through caller-owned providers. A provider can refresh
an existing token; it must preserve the same role and principal. This package does
not create accounts, register OAuth clients, mint tokens, open consent pages or
fund wallets. Do not assume an MCP OAuth bearer works on REST: `/v1/me` must
actually accept it and identify the configured account.

```python
from payments.http import Credential
from payments.market import Scope, MarketREST, NearMarketAdapter
from payments.interface import Action

# UUID strings and binding are application-owned, verified identifiers.
# secret_store is your existing injected secret manager; never print its results.
buyer = MarketREST(
    Scope('buyer', buyer_account_id, (binding.job_id,), (binding.assignment_id,)),
    lambda: Credential('buyer', buyer_account_id, secret_store.buyer_rest_token()),
    timeout=10,
)
worker = MarketREST(
    Scope('worker', binding.worker_id, (binding.job_id,), (binding.assignment_id,)),
    lambda: Credential('worker', binding.worker_id, secret_store.worker_aat_token()),
    timeout=10,
)
market = NearMarketAdapter(runtime_dir / 'market-plans.sqlite3', buyer, worker)
plan = market.prepare('stable-award-plan-1', Action.AWARD, binding)
assert plan['dispatch_allowed'] is False  # local plan, real scoped reads
```

The worker's `aat_` token pins exactly one agent, not its owner/buyer. Do not share
it with the buyer process or use it to award/accept. The buyer's configured account
is verified via `/v1/me` before authenticated REST reads. Worker assignment and bid
responses must match the pinned agent. Resource allowlists are additional local
restrictions; they **do not attenuate a bearer at the server**. Assignment polling
can read the worker's other assignments before local selection; use a dedicated
worker identity if that visibility is inappropriate. Bounded pagination is not a
transactional snapshot; a missing row never proves no movement.

`GET /v1/wallet/balance` is deliberately not used: its OpenAPI description mentions
`ensure_wallet_and_balance`. Public checks and this run do not touch authenticated
wallet endpoints. Ledger reads inspect an existing account only.

## Buyer MCP read/prepare

Use a third, caller-managed identity for buyer MCP. OAuth consent must already be
complete as the buyer account, not as an agent. The advertised OAuth scope is `mcp`,
not a remotely enforced read-only or budget-limited scope.

```python
from payments.market_mcp import MarketMCPTransport, MarketMCP

transport = MarketMCPTransport(
    lambda: Credential('buyer_mcp', buyer_account_id, secret_store.buyer_oauth_token()),
    buyer_account_id,
    endpoint='/mcp',
    timeout=10,
)
transport.initialize()
mcp = MarketMCP(
    transport,
    reviewed_pins=reviewed_principal_specific_tool_schema_hashes,
    job_ids=(binding.job_id,),
    assignment_ids=(binding.assignment_id,),
    identity_resolver=reviewed_whoami_account_id_extractor,
)
manifest = mcp.discover()
# Review actual tools/list input/output schemas and identity before pinning.
# Do not automatically trust manifest hashes or reuse test mock fingerprints.
status = mcp.read_tool('marketplace__get_job_status', {'job_id': binding.job_id})
```

Protocol currently negotiates `2025-03-26`; another returned version fails closed.
JSON and bounded SSE JSON-RPC responses are supported, including notifications
before the correlated response. No reconnect, token refresh, retry or event-ID
idempotency is assumed. HTTP timeout is a socket timeout with deadline checks
between reads, not a hard preemptive bound on DNS or every underlying OS call.

If schemas or `structuredContent` are absent, that tool is blocked; REST reads
remain available where the official OpenAPI describes them. No REST schema is
substituted for an MCP tool. `plan_tool` validates actual discovered schemas for
`prepare_job`, `award_bid`, `accept_result` without sending them.

For a real **nonfinancial** standard-endpoint draft, call `prepare_hire(db_path,
operation_id, arguments)`. The original `client_request_id` must equal the operation
ID and `token` must explicitly be `USDC`. It verifies schema-pinned `whoami` with
your reviewed identity extractor, persists hash-only intent before dispatch and
never follows the approval URL. Repeating an observed operation reads local state;
UNKNOWN may be recovered with `reconcile=True` and the exact original arguments.
For a crash left in `sent`, first ensure the original process stopped, then use
`recover_crashed_draft`. This same-key replay relies only on the official draft
contract and must not be generalized to award/accept. Replayed externally approved
jobs are observations, not this adapter's spending authorization or proof of funds.

## Financial transport (implemented, not authorized to run in this task)

`FinancialWriteAdapter` contains actual schema-validated wire calls on `/mcp/pro`.
Do not run them under the current no-funds instruction. Offline tests inject an
HTTP protocol mock; they never reach a real financial endpoint.

A future explicitly authorized caller must supply:

1. A separately configured `/mcp/pro` buyer transport, negotiated identity and
   reviewed exact tool schemas, including output schema.
2. `WriteAuthorization(approved=True, principal=..., scope_id=..., budget_micros=...,
   binding_hash=..., actions=(...))`. Every concurrent job under the same authority
   must share the **same persistent DB and scope ID**. A separate scope/DB is a
   separate budget authority; the library cannot stop a trusted caller from
   granting extra authority elsewhere.
3. Official REST preflight (`NearMarketAdapter`) checking private one-slot paid
   USDC job, native bid and exact price/worker; no public/currency fallback.
4. `ReviewedWriteCapability` tied to the actual discovered fingerprint and official
   enforcement evidence. Native award maps job/bid only; no unsupported CAS or
   idempotency parameter is added. Accept must map actual required version/hash
   guards, with reviewed **atomic enforcement**, plus current artifact/receipt
   verification by the trusted client. A property name or boolean assertion alone
   cannot satisfy the schema gate. No stock atomic-accept capability is supplied.

A schema-valid successful response is `observed`, never `held`, `released` or
`settlement_confirmed`. A transport/validation failure stays UNKNOWN. Budget
reservations and assignment/action locks persist across restart; same-ID replay
never sends again, and a new ID cannot repeat an attempted action. No financial
retry or budget refund is inferred from missing responses. `reconcile` can hash
read-only exact-operation evidence but does not fabricate a financial projector.

HOLD is part of remote award; RELEASE is part of remote acceptance/auto-accept.
Calling either as a separate financial action is rejected. Local fixture
accept-then-release is simulation and must not trigger a second remote release.
Current automatic release and missing atomic acceptance are detailed in
[LIVE-GAPS.md](LIVE-GAPS.md); connection completion is explicitly **not claimed**.

## Validate

```sh
python3 -m unittest discover -s payments/tests -v
```

`fixtures/official-readonly-check.json` records the performed anonymous network
checks. Tests require no tokens and perform no external financial calls.
