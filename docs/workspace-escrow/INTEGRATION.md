# Workspace testnet escrow integration — actual testnet lifecycle verified

A new separately bounded contract is required; the old U64 registry escrow is not silently reused for 32-hex workspace jobs. Actual agent workflow passed before this stage began. This is a testnet sponsor pilot: visitors do not deposit real money, the contract's prepaid finite test-token pool sponsors demonstrations.

Current account: nope-work-da4cbb1e.testnet, separately created through the official free testnet faucet; the parent registry wallet is untouched. Deployment requires at least 4 testNEAR of confirmed account funding; the logical reward pool remains capped at 0.05. Online signing uses a new FunctionCall-only key (initial gas allowance 0.2 testNEAR) on this new contract account: only fund, record_delivery, accept_and_release, refund; zero attached deposit. The full-access deployment key remains local and never enters Vercel. Pool maximum 0.05 testNEAR; per-hold maximum 0.01; 50 permanently retained holds. No automatic replenishment. Final native-transfer callback, not outer success, establishes payment. Refund returns the held logical allocation to the sponsor contract pool after a fixed deadline. Backend authenticated buyer decisions remain trusted; no independent cryptographic computation proof is claimed by escrow.

## Workspace API contract

Existing POST /api/workspace?route=jobs/JOB_ID/... uses normal session auth and Origin checks. New actions have exact empty JSON bodies:

- payment/fund — buyer, awarded job. Reserve exact selected public amount against immutable terms. Returns `{job}` with payment pending or verified HELD.
- payment/record — selected provider or buyer, delivered job. Bind exact latest delivery version/output hash on-chain; asynchronous, same operation reconciles safely.
- payment/release — buyer, ACCEPTED job. Release only exact recorded accepted delivery, same signed transaction reused after lost response.
- payment/refund — buyer, eligible fixed deadline. Terminal contract refund allocation, no second transfer.
- payment/refresh — buyer or selected provider, read/reconcile existing signed operations; never creates a replacement transaction. Returns `{job}`.

New jobs when escrow is configured have `payment.kind=SPONSORED_TESTNET_ESCROW`; old direct-transfer jobs retain their own kind/flow. Payment statuses: NOT_FUNDED, FUNDING_PENDING, HELD, RECORD_PENDING, RELEASE_READY, PAYOUT_PENDING, PAID, REFUND_PENDING, REFUNDED, ERROR, UNKNOWN. Execution requires finalized HELD (or previously recorded revision state). Finalized delivery recording is required before buyer acceptance; provider runs record after actual execution. Buyer acceptance itself remains reference-gated and exact-version/hash bound. Release follows acceptance with a separate recoverable action. Only finalized on-chain Paid sets job status PAID. Pending/unknown blocks duplicated sends/refunds.

`payment` exposes only public metadata: kind, network=testnet, status, contractId, bindingHash, fundTransactionHash?, recordTransactionHash?, releaseTransactionHash?, refundTransactionHash?, executionDeadlineNs?, reviewDeadlineNs?, recordedVersion?, recordedOutputHash?, operation?, code?. No key or signed bytes.

No claim that front-end authorization is decentralized. The backend can authorize visitor decisions; contract upgrade authority and RPC are trusted. Independent correctness proof is a separate next stage.

## Gas-profile verification boundary

The real local VM lifecycle passed with 4 testNEAR initial balance and 0.2 finite key allowance. Smaller 2.9/0.05 and 2.9/0.2 local profiles failed allowance or actual-balance guards; these failures were preserved. The deployment now uses a separate faucet account with at least the passing 4/0.2 funding profile. Dynamic live gas/balance/allowance checks remain mandatory; static storage arithmetic is not sufficient. No solvency guard was weakened.

## Actual external-chain verification, 14 November 2026

380 Node tests passed after targeted UI/recovery fixes; web build and diff whitespace checks passed. Real local HTTP buyer/provider workflow used the configured private Blob relay and public testnet contract (not fixtures): sealed offer, client-side decryption, award, finalized hold, encrypted evaluation, exact delivery recording, local result check, buyer acceptance, finalized payout. Job `4581fd36104a2232f1c9f96f8aff76a8`. A separate Python standard-library observer used public inputs only and verified the bound hold, connected FINAL receipt tree, exact 0.001 testNEAR native Transfer and successful nonce-bound callback. Release transaction `J77syejz7636hj4UtjSBbg7t6MFj2nLZFnxvvNySqZx2`. This is payment evidence, not an independent computation proof. Production/browser verification remains a separate step.

Actual Chrome also completed fresh job `42526fa21053373dbcda664d9e272810`, from new local neural planning through separate-provider offer, public disclosure approval, on-chain funding, encrypted execution, recorded delivery, buyer IndexedDB reload/decode and finalized payment. See `browser-verification.json`. No browser screenshots were sent. Signed-but-unbroadcast recovery now requires a validated server `operation.resumeAction` hint and explicit same-operation action; a broadcast marker never permits resending. Expired accepted-but-unpaid allocations expose the contract refund path; sponsored offer limits are shown before quote submission.
