# Public release security notes — 14 November 2026

This is a project-maintainer review of the current application and selected legacy boundaries, not an exhaustive third-party certification. The original source snapshot was `79b95b9`; remediation follows that snapshot. Historical cryptographic evidence keeps its original identifiers and hashes.

## Addressed paths

| Original path | Enforcement now | Regression / evidence |
| --- | --- | --- |
| Any account could directly spend the contract’s permanent 50-slot capacity | Constructor-pinned Ed25519 admission binds exact terms; independently keyed `LookupMap` records have no global 50-job cap and prepay 4096 bytes of retained storage. The buyer signs price plus the disclosed non-refundable charge; admission cannot withdraw. | [Contract tests](../payments/wallet_escrow/src/tests.rs), [sandbox and live checks](../payments/wallet_escrow/README.md) |
| Anonymous sessions could consume all 50 global daily admissions | No irreversible global anonymous admission counter. Business quotas bind verified wallet identity across cookies/sessions. | [Availability regression](../workspace/availability-regression.test.mjs), [workspace regression](../workspace/workspace.test.mjs) |
| A selected provider could consume customer revisions with new-block refreshes | Observation-only block hashes do not append revisions. The last 32 revisions are customer-only. An expired record reuses its immutable first retirement marker; nested block observations cannot churn revisions either. | [260 real observer-path refreshes](../workspace/wallet-core.test.mjs), [reserve test](../workspace/availability-regression.test.mjs) |

An additional intermittent authentication error used separate clock reads for issue and expiry timestamps. One sampled time now sets the exact five-minute lifetime; an advancing-clock NEP-413 regression failed before and passes after the correction. Expiry/signature checks remain strict.

## Migration and financial boundary

The current contract is `nope-wallet-5144c7d4.testnet`. [Reviewed deployment evidence](../payments/wallet_escrow/verification/storage-v2/deployment-public.json) binds source/WASM/code hash and FINAL empty access-key list. Before the first cutover, [the prior contract inventory](../payments/wallet_escrow/verification/admission-v1/legacy-before-cutover.json) found six terminal holds, zero liabilities and no pending transfers. Retired jobs are readable; new mutation targets use the current policy. [C775’s six proofs and Paid binding](../payments/wallet_escrow/verification/admission-v1/historical-c775.json) remain verifiable through a pinned historical policy.

The intermediate admission-only contract was also retired with three terminal holds and zero liabilities/pending transfers: [second cutover inventory](../payments/wallet_escrow/verification/storage-v2/legacy-before-cutover.json). The V2 scale test exercised 4,001 distinct buyers in the unit VM; its largest measured record used 796 of4096 reserved bytes. This is separate from the recorded actual testnet transactions.

## Checks and limits

[Release checks](verification/public-release-checks.json) distinguish root regression/build/localization checks from actual testnet transactions. Native payout/refund and a local HTTP→real testnet→result proof→Paid lifecycle have separate evidence. A local HTTP test is not a hosted-browser test.

The selected high-confidence secret-pattern pass covered48 commits/1116 reachable blobs; suspicious long Ed25519 strings were public transaction signatures. A separate comparison of seven known new private-key values against849 tracked/unignored files found no match. Private runtime/key material is ignored, restricted locally, and absent from the allowlisted deployment. These methods do not prove every possible secret is absent.

All four production npm dependency audits returned zero known advisories at checking time; this is advisory coverage, not a source-code security guarantee.

Residual boundaries are explicit: five jobs per verified wallet, prepaid retained storage, no absolute Sybil protection, operational network rate/cost controls still needed, trusted browser/API/RPC, honest initial garbling/mappings, bounded numeric/ASCII operations, and no contract-side SNARK verifier. The admission service can admit jobs, not accept customer results or withdraw their deposits. No mainnet/real-money readiness is claimed.
