# Configurable encrypted work, v2

## Supported first workflow

A buyer commissions normalization of a selected supplier/customer CSV column. The job's public recipe can combine 1–4 approved operations. Numeric data supports configurable missing replacement and lower/upper clipping, preserving missing values when fill is not selected. Text supports ASCII-space trim, ASCII case conversion and digit replacement. Unselected UTF-8 fields, row order and CSV quoting are preserved.

This is a deterministic confidential-execution capability that a service agent can invoke. It is not a general LLM, autonomous procurement planner or arbitrary executable-code service. It does not infer missing addresses or perform semantic entity matching. The source-based product rationale and remaining scope are in PRODUCT-BOUNDARY.md.

## Limits and disclosure

- Numeric: at most 32 byte-valued rows (255 denotes missing); 0–254 replacement and clipping limits.
- CSV text: at most 8 rows / 16 printable ASCII bytes per cell. Non-ASCII selected cells are rejected, never truncated. Other columns remain UTF-8.
- Actual acceptance also depends on total <=10,000 gates and request <3 MiB. Complex recipes can support fewer rows than the headline limit.
- Recipe parameters, type, row count, topology, network address and timing are public. Do not put private policy/budget information in public recipe parameters. The separate buyer budget remains local.
- Ciphertext task storage alone has a 3 MiB bound; ledger/session/other records retain the 1 MiB limit.
- Honest browser/garbler and semi-honest evaluator assumptions remain. This is an unaudited prototype, not a malicious-party secure protocol or zero-knowledge execution proof.

## Actual data flow

Browser parses CSV locally → compiles public recipe to deterministic circuit → fresh per-wire labels/garbled tables → only request to evaluator or private task store → selected provider triggers evaluation → encoded output → buyer's encrypted local decoder → transcript binding and per-wire checks → local reference comparison and before/after → exact version/hash acceptance. Existing sealed-to-buyer offers and direct testnet receipt flow remain; escrow was not added.

`GET /api/recipe-gc` exposes the public operation catalogue. `POST /api/recipe-gc` evaluates encoded tasks. Workspace job/execute endpoints dispatch v1/v2 through an allowlisted protocol adapter. Existing v1 tasks and decoders remain supported. No new external AI service or key was added.

## Verification

277 Node tests passed, including exhaustive numeric compilation/evaluation, text alphabet and trim boundaries, malformed/oversized/cross-origin rejection, parameter/nonce/program/output tampering, v1 compatibility, encrypted local decoder reload, selected-provider access and exact-version acceptance. The new Blob adapter size test uses the actual adapter, preserving metadata bounds.

Actual HTTP tests produced `acme**` and `beta*` from synthetic private text in a 1,121,165-byte encoded request; a configurable numeric example produced `[12,10,20,180,180]`. A real Chrome standalone flow processed a three-row supplier column with encrypted remote evaluation, returning `acme`, `beta**`, `gamma*`, with other fields preserved. Browser workspace testing uses real private Vercel Blob, not a fake local store; raw task storage's original 1 MiB mismatch was found and fixed during this flow. The same pending job was safely retried, the provider submitted an encrypted bid, the buyer selected it, the provider executed actual GC, and the buyer reloaded IndexedDB, decoded and accepted delivery. See browser-verification.json. No payment was executed in this v2 test.

The independent code reviewer reported no remaining concrete bug and 42,920 deterministic cases over 420 recipes. This is a bounded code review, not independent cryptographic certification. No mainnet payment, escrow or general private-LLM capability is claimed.
