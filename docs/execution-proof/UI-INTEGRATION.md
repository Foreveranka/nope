# Result-proof UI integration proposal

14 November 2026. Proposal only; no UI, SDK, API, circuit, acceptance rule or contract is implemented by this document. Main owns integration after Nash's actual proof runtime and Avicenna's v4 protocol/API are available. Status names below are presentation concepts, not a frozen wire schema or proposed endpoints.

## Decision and current boundary

The selected route is an independent **result-correctness SNARK** over a new v4 request with authenticated, pre-execution commitments to ordered input/output label mappings. It is not an AES evaluator execution-trace proof. [RELATION-REVIEW.md](RELATION-REVIEW.md) specifies the intended relation and assumptions; the earlier AES-first choice in [FEASIBILITY.md](FEASIBILITY.md) is historical research, not the current implementation decision.

At this checkpoint, the inspected workspace core still uses local reference checking and finalized delivery recording; the new proof verifier adapter is not yet wired into its routes/acceptance. Existing v3 payment/chain-observer evidence is not result-proof evidence.

The published [PROTOCOL.md](PROTOCOL.md) now defines profile `nope-csv-proof-plan-gc-v4`, wrapper `{profile, task: v3Request, proofManifest}`, and the whole-envelope hash covering the precommitment before funding/execution. The manifest is `{version:1, scheme, context, rows}`; `context.policyHash` pins the approved actual relation/artifact/VK/SRS policy. Its presence is not evidence of successful proof generation or acceptance enforcement; see [IMPLEMENTATION.md](IMPLEMENTATION.md) for runtime progress.

Use the actual `finalProofContext` / `makeProofStatements` helpers with main-derived `{jobId,version,contractId,bindingHash,provider,amountYocto}`. These helpers validate bindings but do not authenticate arbitrary caller-supplied award data. Main must derive the binding from authenticated state, independently derive every expected row statement, and require actual `verifyRow({statement,proof})` success for every row. `decodeProofPlan` returns decoded values only, never a proof-verification result. Only `prepareProofPlan(...).request` is network-safe; its `decoder` and `witness` remain buyer-local.

Use the existing cards, badges, terminal typography and before/after tables. Add one compact verification card beside the buyer's delivery results; no redesign, combined “all verified” badge or proof label on a payment transaction link.

## Proposed Turkish labels

Keep three separate rows:

| Row | Labels and meaning |
| --- | --- |
| Yerel sonuç kontrolü | `Eşleşti` / `Eşleşmedi` / `Bu cihazda doğrulanamıyor`. Only the actual local decoder/reference check changes this row. |
| Bağımsız sonuç kanıtı | The proof states below. “Independent” means real cryptographic verification using public evidence and pinned verification policy, without trusting the prover's witness or success flag; it does not identify an independent company/operator. |
| Testnet ödeme | Preserve current funding, recording, release, refund and finalized-payment states. Escrow receipt verification never changes the proof row. |

| Proof situation | Label | Acceptance for proof-required v4 |
| --- | --- | --- |
| Runtime/verifier unavailable or plan unsupported | `Sonuç kanıtı bu ortamda desteklenmiyor` | Blocked; no pretending that work is queued. |
| Supported, no real proof yet | `Sonuç kanıtı henüz oluşturulmadı` | Blocked. |
| Actual prover running | `Sonuç kanıtı oluşturuluyor` | Blocked; show only measured runtime progress. |
| Proof exists; verification has not started | `Kanıt hazır · bağımsız doğrulama gerekli` | Blocked; generating/parsing a proof is insufficient. |
| Actual independent verifier running | `Kanıt bağımsız olarak doğrulanıyor` | Blocked until its result and bindings are checked. |
| Actual verifier succeeded for this exact delivery | `Bağımsız sonuç kanıtı doğrulandı` | Proof gate satisfied; other gates still apply. |
| Verification rejected the proof or bindings | `Kanıt bu teslim için geçersiz` | Blocked. |
| Another job/version/output/policy is selected | `Kanıt güncel teslimle eşleşmiyor` | Blocked; discard the cached success. |
| Cancelled, timed out or verification unavailable | `Kanıt doğrulaması tamamlanamadı` | Blocked; no success inferred from elapsed time. |
| Legacy v3 job | `Bu iş sürümünde sonuç kanıtı yok` | Preserve its existing acceptance policy; show its local-reference boundary. |

Short explanation under the proof row:

> Bu kanıt, teslim edilen etiketlerin önceden sabitlenen eşleme altında onaylı işlemin doğru sonucunu temsil ettiğini doğrular. Sağlayıcının hesabı çalıştırdığını, AES yürütme izini, özgün dosyanın kaynağını veya AI planının hedefinizi doğru yorumladığını kanıtlamaz. Başlangıç eşlemesinin dürüst hazırlanması varsayılır.

Payment explanation:

> Testnet sözleşmesi fonu ve teslim özetini kaydeder; mevcut sözleşme SNARK doğrulamaz.

## Immutable policy and independent verification

- Read proof requirements from validated immutable v4 policy, not a checkbox, query parameter, local flag or payment status. Missing/inconsistent policy blocks acceptance; malformed v4 is never treated as legacy.
- Authenticate/freeze the mapping manifest before execution. Later roots or mutable timestamps cannot replace it. Existing v3 jobs cannot acquire a retrospective commitment.
- Derive expected public signals and selected-label roots from the actual approved request/latest delivery. Verify the real proof with pinned relation, semantics, parameters and key; never trust a prover-selected key or unchecked signal array.
- Match job/network/contract/award, manifest/mapping roots, encrypted-request hash, public-task/plan/program identifiers, ordered shape/nonces, delivery version and output hash. Public-task and encrypted-request hashes are distinct. Cover every column/operation.
- Retain the proof digest, verifier/key/relation identities and verified bindings with acceptance. Witnesses remain buyer-local: no decoder, alternative pairs, salts, input bits, CSV or private keys enter proof uploads/exports.

A returned `verified:true`, successful process, matching hashes or chain receipt alone cannot establish proof verification.

Exact field names, artifact formats, operation names and verifier entry points must come from the implemented v4 SDK/API. Do not implement guessed calls from this proposal.

## Acceptance and recovery

For a proof-required v4 job, enable `Doğrulanan teslimi kabul et` only when **all** are true:

1. Authenticated buyer owns the job, status is DELIVERED, and the immutable v4 proof policy/precommitment is valid.
2. The existing local decoder/reference check succeeds for the full current dataset and approved plan. Proof success does not bypass that check or supply missing local keys.
3. Sponsored escrow is finalized HELD with `verified:true`, and recorded delivery version/hash exactly match the current delivery. Preserve review-deadline and uncertain-operation guards.
4. The real independent verifier has succeeded for the exact current proof, request, manifest, program, delivery and pinned policy described above.

Suggested disabled-button explanation:

> Kabul için yerel sonuç kontrolü, son teslimin kesinleşmiş zincir kaydı ve bu teslimin bağımsız sonuç kanıtı gerekir.

The backend must enforce the same proof requirement before recording acceptance; hiding/enabling a browser button is not enforcement. Persist acceptance against the verified proof digest and delivery binding. Release consumes that exact accepted decision and must not become an alternate proof-bypass route. Do not claim the frozen escrow contract verifies the SNARK or enforces this application-level proof policy on chain.

Keep `Düzeltme iste` available after the current delivery's finalized record even if its proof fails, is absent or is unsupported; do not require proving a bad result correct before rejecting it. Keep sequential record/version rules. Existing expired, unspent-hold refund recovery remains separate; proof failure never authorizes silence payment or a pending-transfer refund.

New delivery/version/output, changed approved context, manifest or verifier policy immediately invalidates proof success and disables acceptance. Ignore late worker results for an obsolete context. On reload, independently revalidate the saved proof against fresh expected bindings; do not restore a green badge from a cached boolean. An unavailable verifier shows an incomplete state and blocks proof-required acceptance.

No automatic downgrade or partial-plan fallback. If the real SDK cannot prove the selected plan/browser workload, block publishing that proof-required v4 job with an actionable explanation. A separate legacy job is an explicit new job with its own identity and approval; the v4 job's requirement never changes in place.

## Integration readiness

Before wiring buttons or claiming availability, require: actual supported-profile proof generation; independent verification using only public evidence and pinned policy; authenticated precommitment binding; wrong-proof/root/key/plan/job/version/output and partial-coverage rejection tests; actual v4 acceptance API enforcement; reload/cancellation/stale-worker tests; and preserved v3 local-reference/escrow regressions.

Only then add real `Sonuç kanıtını oluştur` / `Kanıtı bağımsız doğrula` actions if those distinct operations exist in the SDK. Do not show fake progress, a download link without a real artifact, or an on-chain-proof badge. Record real browser proving/verification evidence separately from earlier encrypted-execution/payment evidence.
