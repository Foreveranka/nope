# NEAR Agent Market payment boundary

The real official-schema integration is now in `market.py`, `market_mcp.py`,
`market_writes.py`, `http.py` and `openapi.py`. It implements scoped authenticated
reads, durable preparation, nonfinancial draft recovery and gated financial wire
calls. **No live financial mutation was performed or authorized by this run.**
See [LIVE-SETUP.md](LIVE-SETUP.md) for separated-role configuration and
[LIVE-GAPS.md](LIVE-GAPS.md) for exact unresolved platform guarantees and public
read results. Production settlement/atomic acceptance is not claimed complete.

The documentation below describes the original, unchanged fixture integration.
It does not describe the new transport as a simulation.

**Implemented local prototype, not a production payment integration.** Python 3.9+
standard library only. In this original fixture API, only `LocalFixtureRail` executes mutations. Its funds,
assignments, evidence IDs and ledger are **local simulation**, not NEAR escrow,
Market holds, bank balances, settlement proofs or actual money.

The public interface is [interface.py](interface.py). The existing integration
API is implemented unchanged:

```python
from payments.adapter import PaymentAdapter
from payments.fixture import LocalFixtureRail
from payments.interface import Action, Binding, Delivery, Money, State

# Verifier is a trusted client integration with this exact method:
# verify(binding, delivery, artifact_bytes, receipt_bytes) -> bool
rail = LocalFixtureRail("/your/local/runtime/payment-fixture.sqlite3")
rail.register(binding)   # Binding with Money(80_000_000) means exactly 80 USDC
payment = PaymentAdapter("/your/local/runtime/payment-outbox.sqlite3", rail, Verifier())
payment.register(binding)
payment.perform("award", Action.AWARD, binding)
held = payment.perform("hold", Action.HOLD, binding)
assert held.state == State.HELD
payment.perform("submit", Action.SUBMIT, binding, delivery)
payment.verify_artifact(binding, delivery, artifact_bytes, receipt_bytes)
payment.perform("accept", Action.ACCEPT, binding, delivery)
released = payment.perform("release", Action.RELEASE, binding, delivery)
assert payment.perform("release", Action.RELEASE, binding, delivery) == released
```

`perform` returns an `Observation`. A repeated **confirmed** operation with the
same ID and identical arguments returns the original operation outcome, even if
the assignment has subsequently progressed. Use `state(binding)` for the current
local snapshot, and `refresh(binding)` for a fresh fixture read. Changes to any
argument under the same operation ID are conflicts. Job and attempt IDs accept
opaque ASCII strings, not just Market UUIDs, so the local registry integration
can use its own string IDs. These are internal models, not Market wire objects.

`Money.micros` must be a positive integer up to 2^63-1. Currency is exactly USDC,
scale 6. `parse_usdc("80.000000000000")` returns `Money(80_000_000)` without float,
rounding or exponent notation. Nonzero digits beyond six decimals are rejected.
This boundary does not implement the customer's aggregate multi-job budget or
claim a local authorization reserve is a remote financial hold.

## Durable state and recovery

Normal simulation sequence:

```text
new -> awarded -> held -> submitted -> accepted -> released
                    |         |
                    v         v
                 refunded  disputed
```

`submit` can replace a submitted delivery with exactly its next version. `refund`
is allowed only while held and before submission. Disputed assignments stay
blocked: this build has no pretend dispute ruling, partial refund or split payout.
The separate fixture `hold`, `accept` and `release` actions are deliberately **not**
assumed to be separate live Market operations.

Both stores use file-backed SQLite, WAL, `synchronous=FULL`, uniqueness constraints
and short `BEGIN IMMEDIATE` transactions. Before dispatch the adapter persists the
exact immutable command and marks the assignment `unknown`. Other operation IDs
cannot bypass that lock. A hard crash leaves the persisted `sent` operation just
as unresolved as a timeout. Only exact-operation reconciliation can clear it:

```python
outcome = payment.perform(op_id, Action.RELEASE, binding, delivery)
if outcome.state == State.UNKNOWN:
    outcome = payment.reconcile(op_id)  # reads only; never repeats execute
```

Missing remote operation evidence, elapsed time, an unchanged state, a failed
request, an approval link, a cancelled row or a local abort **do not prove refund**
or authorize retry. If dispatch never happened and no authoritative outcome can
be found, the operation intentionally remains unknown. There is no unsafe
"abandon and retry" escape hatch. Operational resolution is required.

The fixture atomically compares the expected revision, and writes one terminal
movement per assignment. A preflight read plus this fixture CAS blocks stale or
disputed acceptance. `reconcile` records the exact original outcome while adopting
a newer authoritative fixture snapshot, so late responses cannot erase disputes.
`refresh` never clears an unknown write by inference. These are local durable
invariants, **not distributed exactly-once guarantees for Market**.

## Artifact acceptance boundary

A delivery binds its positive integer version, SHA-256 artifact digest and SHA-256
receipt digest. The immutable assignment binds context, attempt, job, bid, supplier,
terms, selection and exact price. `verify_artifact` requires matching immutable
bytes, the current submitted version and an injected verifier that returns exactly
`True`. It persists only hashes and revision metadata, not artifact/receipt bytes.
A new version invalidates old verification. Acceptance and release require the
matching stored verification, fresh state and fixture CAS.

The injected verifier is trusted local policy: it must actually validate the
application's output, receipt/context, retrieval and any decryption requirements.
There is no default "verified" policy. The module does not independently execute
FHE, prove correctness, verify a TEE, authenticate a supplier or prevent a local
owner from editing SQLite/calling the fixture directly. No hash or buyer-side
validity check forces a remote platform to pay.

## MCP boundary and live status

[MCPBoundary](mcp.py) accepts an injected `AuthenticatedMCPTransport`. The caller
owns authentication/refresh and principal selection; authentication is a **transport
assertion**, not independently verified OAuth. No token is accepted or persisted
by these APIs, and this package constructs no HTTP client or network endpoint.

`discover()` follows bounded `tools/list` pagination and records server version,
protocol version, principal hash, capture time and input/output schema fingerprints.
No discovery is performed against an actual account in this build. Callers must
review schemas and provide `reviewed_pins={tool_name: fingerprint}`; discovery alone
does not grant trust. Rediscovery rejects identity/schema drift. Schema snapshots
are cached until rediscovery; they are not assertions of continuous server state.

`plan_tool` validates exact discovered input and returns local planning data only.
`read_tool` is limited to an explicit list of documented read tools, checks the
reviewed schema pin and validates `structuredContent` against the output schema.
`isError`, unknown enums, text-only results, missing output schemas and approval
links do not become payment confirmations. There is no guessed JSON/text parser.
The schema engine supports a documented subset visible in `schema.py`; unsupported
keywords, formats, recursive/remote refs and malformed schemas block the tool
instead of silently weakening validation. It is not a full JSON Schema engine.

`BlockedLiveRail` and `PaymentAdapter` both reject live writes. There is no live
"enabled" switch. Local fixture success cannot enable it. Verified future wire
mappings, financial evidence, spending authorization and race/idempotency controls
require separate work listed in [LIVE-GAPS.md](LIVE-GAPS.md).

## Run locally

From the repository root:

```sh
python3 -m unittest discover -s payments/tests -v
python3 -m payments.demo
python3 -m payments.verify  # JSON evidence, including source hashes
```

The demo uses temporary SQLite files and a clearly synthetic artifact. It performs
real SHA-256 and HMAC-SHA256 with a public synthetic test key; it does **not** run
FHE, a NEAR sandbox, a live MCP session or actual financial settlement. Its saved
example is [fixtures/synthetic-lifecycle.json](fixtures/synthetic-lifecycle.json).
Application integration may supply actual locally verified FHE ciphertext and
receipt bytes via the same interface; no such end-to-end integration is claimed
from these payment-only tests.

Tests cover lost responses for state-changing actions, genuine subprocess exit
between rail commit and local confirmation, restart, concurrent threads/processes,
key/payload conflicts, wrong context/price, stale versions, dispute races, forged
HMAC receipts, schema errors/drift and no double fixture release. The operational
assumption is a trusted local machine and intact SQLite/filesystem; this is not a
security audit, privacy proof or multi-host production durability assessment.

The saved payment-only run is [fixtures/verification.json](fixtures/verification.json).
It records the actual interpreter, test outcomes and source SHA-256 hashes.
