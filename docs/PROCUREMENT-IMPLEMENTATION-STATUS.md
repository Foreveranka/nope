# NOPE procurement implementation — active 12 November 2026

User authorized completing buyer/provider workflow, private bids, operator layer, delivery/acceptance and external dependencies on TESTNET. No mainnet or real-money operations, paid services or human outreach is authorized by this technical integration request.

Order: (1) authenticated durable jobs and role-separated UI, (2) sealed bid admission/close, (3) independently operated selection integration, (4) encrypted delivery/exact-version acceptance, (5) testnet settlement and end-to-end verification, (6) report.

Workers: procurement domain/API in procurement/; operator software in operators/; external testnet payment work in payments/. Main owns UI/routes/deployment/integration/review. Pilot invitation identity must be described as such, not wallet login. App ledger is not on-chain finality. Selection cannot silently use fake MPC or centrally readable bids. Existing crypto components will be integrated only with verified context bindings.

Completed before this phase: real four-record local and cloud FHE, local three-process MPC and testnet registry. Not a complete live marketplace. Exact current results will be appended as tests complete.

## Main integration checkpoint (12 Nov, active — not final)
- Added `/market` role-separated invitation UI and `/api/procurement/*` Vercel adapter. Node adapter health/origin/body tests pass. Actual CUA browser test on explicit local ephemeral-memory harness caught and fixed a checkbox collection bug; buyer creates a draft; invited provider cannot see unpublished draft or buyer form. This is NOT a cloud storage test.
- `web/sealed.mjs`: exact Python v2 commitment vectors; 3 tests. Existing npm suite 78 passes.
- `service/procurement_proxy.py`: hard-pinned HTTPS public-metadata transport; private fields denied before network, no redirects/general proxy. 4 negative tests; 33 existing companion/remote tests pass.
- `service/procurement_mount.py`: local-only fixed-synthetic FHE prepare, public publish payload, 30-minute in-memory key lifecycle. Uses public pinned testnet registry and explicit client-reference output policy. Budget only reaches local client; 3 mount tests. Current registry is single-owner, so preparation enforces that testnet buyer.
- REAL Concrete FHE preparation completed in 3.879s (synthetic draft, no chain/network/MPC/payment), `docs/verification/procurement-real-prepare.json`. In-memory client was closed after test; encrypted artifacts remain under ignored runtime. This does not establish end-to-end selection/delivery.
- Client ZIP includes the new public dependencies and successfully imports/configures independently after extraction. No runtime/private key files included.
- `contracts/registry/deploy/procurement.mjs`: exact prepared published-job → current owner-only testnet registry adapter, persistent one-shot transaction journal inherited. 3 context/identity/domain tests pass. NOT broadcast yet.
- Backend worker's current 34 tests pass (including main adapter tests), while operator/payment/staged-client workers still completing integration and verification.
- No commit/push/deployment of this active batch yet. Previous deployed website remains unchanged. Need real cloud persistence/invitation test, private bidder client flow, selected execution binding, final testnet settlement, independent review and deployment before completion report.

## Additional verified work — active, not a completion declaration
- Actual private Vercel Blob persistence: create, new-handler read, exact retry and changed-payload replay rejection passed (`docs/verification/procurement-real-blob.json`). This is actual storage, not deployed HTTP testing yet.
- Three distinct named NEAR testnet provider accounts were created with 0.1 test NEAR each; finalized account/access-key reads passed. Public evidence: `docs/verification/testnet-participants.json`; private keys remain ignored, permission-restricted files. All accounts are administered by this one project, not independent parties.
- Production invitation hashes and configured origin were installed in the existing Vercel project. Actual invitation tokens remain local ignored files; no token is included in the build.
- Provider bid preparation now uses the local companion; only commitments are sent to the app ledger. Authenticated session recovery is being added for lost responses. Live private-input execution remains fail-closed until a trusted operator plan/transport is configured.
- Latest checked: 124 Node application tests, 16 testnet adapter tests, 94 Python payment tests, 55 main Python tests. The bidder/mount suite also passed independently. These overlapping suites are not an additive distinct-test count.
- Companion archive imports independently after extraction, including the actual sealed-client module. Remote operator runtime and authenticated input-plan configuration are not bundled or fabricated.
- Actual testnet lifecycle integration is running separately from the web app ledger. It uses centrally managed synthetic witnesses and locally running native MPC; no claim of independent distributed privacy.
- Review caught escrow job-ID preemption by an unrelated funder; payment worker is restricting the pilot to the current fixed registry buyer and rebuilding before deployment. No escrow was deployed before this review.

### Actual external dependency failure and resolution
First external lifecycle created registry job 2 and finalized all three provider
bids, but stopped before closing with HTTP 429 from `rpc.testnet.near.org`.
No close transaction journal exists; a read through FastNear independently showed
job 2 still Open with all three commitments. Its in-memory synthetic key/openings
were released on failure; do not claim this run completed or reuse it as a paid
job. Failure evidence is retained under ignored runtime.

NEAR's official provider list (https://docs.near.org/api/rpc/providers) lists the
free testnet endpoint `https://test.rpc.fastnear.com`. Its status returned chain_id
`testnet`, and actual finalized get_job succeeded. The registry adapter now uses
that exact reviewed default and continues to allow the prior reviewed testnet
endpoint. No arbitrary URL or mainnet fallback; signed writes are never blindly
replayed through another provider. A new synthetic lifecycle will validate this
external provider end to end.
