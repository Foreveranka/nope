# Live Market integration remains blocked

No actual account calls, OAuth session, `initialize`, `tools/list`, payment,
credential handling, deployment or external mutation were performed. Transport
and tool schemas in the unit tests are explicitly synthetic. `BlockedLiveRail`
never calls a transport, even if one is injected.

Read-only research on 2026-11-11:

- Read the prior local plan `03-MARKET-VE-NEAR-ADAPTOR.md` fully in sections, and
  repository `AGENTS.md` / `docs/BUILD-CONTRACT.md`.
- Anonymous GET of [official OpenAPI](https://market.near.ai/openapi.json):
  213,087 bytes, SHA-256
  `2c7b2496e05f56aece8b13f8a825845a54b8cae9689efd4f3acf79ea28e32cd3`,
  `info.version=2.0.0`, byte hash matches prior research. This is OpenAPI, **not**
  authenticated MCP `tools/list` input/output schemas.
- Read [official payments/disputes docs](https://docs.market.near.ai/concepts/payments-and-disputes).
  It describes assignment holds, payout/fee/refund ledger kinds and automatic
  acceptance. These descriptions are not tested live financial evidence.
- The MCP/pro and buyer AI-guide pages returned access errors/HTTP 403 in the
  attempted fresh reads. Their previously recorded tool names remain research
  references; no current schemas or behavior were inferred from those failures.

Required evidence before a separately authorized live implementation:

| Gap | Actionable closure | Current behavior |
| --- | --- | --- |
| Identity and negotiated schemas | Capture reviewed server/protocol/principal and paginated exact `tools/list`; pin input/output hashes per principal. Verify audience/roles separately. | Injected interface and local schema tests only. |
| Private supplier onboarding | Verify private create, one slot, terms/currency/acceptance configuration, and first selected supplier participation using separate authorized roles. | No create/join endpoint guessed; no public fallback. |
| Exact award and funds | Match native bid, job, worker, assignment, terms and micro-USDC price; confirm an authoritative assignment-linked financial hold. Establish full pagination/status semantics and idempotency/recovery. | Local `held` means fixture movement only. |
| Financial evidence mapping | Verify confirmed ledger statuses, assignment references, direction, gross payout/fee/refund totals and split semantics. Documented ledger kind names alone are insufficient. | No financial projector implemented from unknown wire data. |
| Version-safe acceptance | Verify server-side expected version/hash CAS or equivalent enforceable constraint. A pre/post read does not close a malicious resubmission race. | Atomic revision CAS exists only in the fixture. |
| Acceptance releases money | Determine actual MCP/pro atomic financial behavior and `/mcp` approval flow from exact schemas. Never map the fixture's separate release into a fabricated remote endpoint. | Local plan only; write dispatcher absent. |
| Refund and disputes | Verify dispute-opening interface, accepted private evidence, deposit authorization, deadlines, ruling, partial/split totals and actual financial recovery. | `disputed` blocks automatic release; local timeout is not refund evidence. |
| Unknown outcomes | Verify exact-operation lookup/correlation and durable outbox reconciliation for award/submit/accept/refund. JSON-RPC IDs are not assumed idempotency keys. | Missing outcomes remain `unknown`, new IDs cannot bypass. |
| Auto-accept and delivery | Obtain authoritative auto-accept time, actual buyer retrieval/decryption checks and an intervention channel before it expires. | A local pause does not stop a Market clock. |
| Overall authority | Bind total customer authorization, fees, gas, retry and dispute reserves atomically across concurrent jobs. | Exact fixture price only; no aggregate budget or live spending authority. |

No custom blockchain escrow or fund-holding contract is added. Registry hashes
and local validator results are not remote settlement instructions or proof.
The platform's financial authority, buyer output validation and registry evidence
remain distinct trust boundaries.
