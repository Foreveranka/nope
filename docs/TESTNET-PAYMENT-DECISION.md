# NOPE testnet payment decision — 12 November 2026

**Decision: use a distinct NOPE native-test-NEAR escrow for the testnet route.
NEAR Market sandbox support is unverified; do not route test funds into Market.
The bounded external-testnet escrow/payment lifecycle is now verified for job 3.
This is a fixed test-price demonstration, not Market settlement or proof of the
private MPC price.**

## Actual external-testnet result

After main explicitly confirmed the integration driver stopped and the owner lock
was free, this payment worker used the existing shared lock and explicit FastNEAR
testnet endpoint. No mainnet, paid service or Market financial call was used.

- Created `escrow.veil-reg-e138f5c88250f821.testnet` with exactly 3 test NEAR;
  creation transaction `8dnyW6ou6vAoqbAxwCiYXS8pAVvHGgPBrXjgYTdAhAVW`.
- Deployed reviewed Wasm SHA-256
  `1f0a6a4566cf6b963ea2d29ad9dda4cca6d51e04172508ca3ccb67ad8b096819`,
  code hash `36ArHnTqzmnL25wym4Hp5gLPAfp2yuShqKXAXYAUdo5A`, and self-initialized
  against the existing registry. Deploy transaction
  `2SvYgRniGrtfDpzjuwoex9dZBYkPeDqvyNmYSDAe6GE3`.
- Independently read current Accepted job **3**, attempt **1**, selected executor
  **`p2.veil-reg-e138f5c88250f821.testnet`**, and matched the completed integration
  result's job, context, attempt, accepted receipt and ciphertext output hashes.
- Funded 0.001 test NEAR price plus 0.02 retained storage topup, transaction
  `FAXoE6SZ4tiPnXsMhZYTdQ4JJvFuDF1jAvFUcwxD9ejq`.
- Released the exact accepted receipt, transaction
  `CSEhBWNyGKdcJD6xNmWJV7QYyXGrMc2uf3Ar4Gw6Dx7F`.
  The real Python observer verified `FINAL`, the complete successful outcome tree,
  and actual escrow-to-provider native Transfer receipt
  `4bZwU6DgSZwa1bMZuetb6Gd8VCGJDs8zqzyERU8Sz5Lt` for exactly
  `1000000000000000000000` yoctoNEAR. It also read exact finalized `Paid` terms and
  both deployed code pins. The release response has ten receipt outcomes.
- A new-process restart reconciled the original fund/release hashes with `tx` and
  `FINAL`, with `send_tx` explicitly blocked. It made zero broadcast attempts,
  observed the same hashes and Paid state, and left the provider balance unchanged.
  No second payout or replacement transaction was sent.

Durable **actual RPC** evidence, not authored protocol fixtures:
[deployment](../payments/testnet_escrow/verification/testnet-deployment.json),
[binding preflight](../payments/testnet_escrow/verification/testnet-payment-preflight.json),
[fund receipts](../payments/testnet_escrow/verification/testnet-fund-receipts.json),
[release receipts](../payments/testnet_escrow/verification/testnet-release-receipts.json),
[Python verification](../payments/testnet_escrow/verification/testnet-payout-verified.json),
[restart reconciliation](../payments/testnet_escrow/verification/testnet-reconciliation.json),
[final account/hold views](../payments/testnet_escrow/verification/testnet-final-views.json).
Receipt captures identify source/method/params and canonical response SHA-256.

The account and local child-key **path only** are recorded in
[the public ledger handoff](../payments/testnet_escrow/verification/testnet-escrow-account.json).
This is an escrow contract, not a competition prize wallet or user payout address.
Main owns the persistent wallet-ledger update; this worker did not edit outside
`payments/` and this decision document. No private key was printed/copied into
public evidence. The separately generated child key remains in ignored runtime.

## Official evidence and limits

Public documentation reviewed today, without login or account/API-token use:

- [Market MCP endpoints](https://docs.market.near.ai/mcp/pro): `/mcp` returns
  approval links; `/mcp/pro` can hold/release the account's actual balance. Neither
  is identified as a testnet endpoint.
- [Wallets and billing](https://docs.market.near.ai/buyers/wallets-and-billing):
  balances are USD, USDC and granted spend-only credits. Credits are not a testnet
  currency or evidence of a sandbox; they can fund real hires.
- [Payments and disputes](https://docs.market.near.ai/concepts/payments-and-disputes):
  assignment holds, acceptance/automatic acceptance, payouts and disputes are
  platform financial operations, rather than the registry's native test-NEAR rail.
- [FAQ](https://docs.market.near.ai/faq) and
  [builder FAQ](https://docs.market.near.ai/builders/faq): actual account, confirmed
  email, agent token and payout prerequisites; no documented sandbox onboarding.
- Anonymous GET of [official OpenAPI](https://market.near.ai/openapi.json) returned
  213,087 bytes, SHA-256
  `2c7b2496e05f56aece8b13f8a825845a54b8cae9689efd4f3acf79ea28e32cd3`, matching
  the existing `payments/official/openapi.json`. There is no `servers` declaration
  and zero occurrences of `testnet` or `sandbox`. This is limited negative evidence,
  not proof that a private/internal environment cannot exist.

No publicly documented Market sandbox is available to configure from this
evidence. It remains unavailable **for this integration** until official sandbox
URL, network/test-asset, account access, schemas and financial semantics exist.
Do not guess `sandbox.market...`, reinterpret production credits, or claim support
confirmed anything. Nobody was contacted. The documentation host returned HTTP
403 to direct Python GET; its named pages were read using the web tool. No whole
documentation-site crawl is claimed.

NEAR itself has an actual separate testnet:
[official RPC providers](https://docs.near.org/api/rpc/providers) list public testnet
endpoints; [transaction RPC](https://docs.near.org/api/rpc/transactions) documents
`tx`, `EXPERIMENTAL_tx_status`/`tx_status`, receipt bodies and `wait_until: FINAL`.
`EXECUTED_OPTIMISTIC`, `INCLUDED_FINAL`, a transaction hash, or an outer successful
call alone is insufficient payment evidence. [Contract queries](https://docs.near.org/api/rpc/contracts)
support finalized account/code and pinned-block view reads.

## Concrete implementation

`payments/testnet_escrow/src/lib.rs` is a separate, compilable NEAR contract, not a
Market emulator or a simulated balance ledger. All on-chain amounts are native
test NEAR, in integer yoctoNEAR. No USDC conversion or hypothetical token address.

1. Deploy to a dedicated named `.testnet` account and self-call `new(registry)`.
   The registry account is fixed permanently in this escrow state.
2. Buyer calls `fund(terms)` with the exact price plus 0.02 test NEAR of retained
   storage funding. A job can be funded once; ten jobs maximum, price at most
   one test NEAR. Buyer/provider must be distinct named testnet accounts. **This
   pilot fixes buyer == configured registry account**, matching the pinned registry's
   owner == registry deployment. Both predecessor and `terms.buyer` must match
   that account before a job ID is reserved. Outsiders cannot preempt job IDs by
   funding their own claimed buyer. Multi-buyer registries are unsupported.
3. Provider reports to the existing registry; buyer accepts its exact receipt
   through the registry's existing `decide_result` method.
4. Buyer calls escrow `release(job_id, acceptance)` with at least 100 Tgas. Escrow
   calls the configured registry's real `get_job`, then its private callback
   checks current `Accepted` / `BuyerAccepted`, exact job/buyer/executor, context,
   attempt, job/attempt/receipt hashes and ciphertext output hash. Version 1 and
   selected-executor version 2 are supported; unknown versions fail closed.
5. Only a match schedules a native Transfer to the provider. State is
   `PayoutPending` before dispatch and `Paid` only after its successful native
   transfer callback. A pending or paid payout cannot be repeated. A proven failed
   transfer resets to `Held`; a lost/unknown callback stays pending without retry.
6. A cooperative refund uses provider `approve_refund` then buyer `refund`, with
   the same pending/confirmed-transfer discipline. No automatic timeout, unilateral
   buyer refund, paid dispute, fee collection, administrative withdrawal or split.

`payments/near_testnet_escrow.py` supplies real FunctionCall intents for funding,
release and cooperative refunds, and a real read-only RPC verification path.
`verify_release` demands the exact finalized release transaction, complete connected
successful outcome tree, actual escrow-to-provider native Transfer receipt with
exact amount, and an exact finalized `Paid` hold. Missing receipt bodies, callbacks,
changed code, amounts, hashes, provider or acceptance all fail closed. A boolean
success response or a `Paid` string alone is not sufficient.

`payments/near_testnet.py` supplies the pinned public HTTPS JSON-RPC transport and
a separate optional direct-transfer observer with durable transaction reservation.
The direct-transfer observer has **no escrow**; it must not be presented as this
custody route. Both are separate from the older USDC `PaymentAdapter` and its
explicit local fixture. They are library integration paths, not service/UI wiring.

## Access and remaining integration prerequisites

- Existing public registry evidence identifies
  `veil-reg-e138f5c88250f821.testnet`, but its saved smoke job is `Open`, uses one
  account for all roles and explicitly reports `payment_executed: false`. Those
  files are prior-run evidence, not a fresh account check in this task.
- Supply an actual named provider testnet account and a dedicated escrow account,
  funded with **free test tokens only**, plus the registry owner/buyer authority.
  Main now reports actual provisioned providers
  `p1/p2/p3.veil-reg-e138f5c88250f821.testnet`; that is separate from the earlier
  one-account smoke evidence. The old deployment signer only permits
  deploy/new/create_job. The new `payments/testnet_escrow/client.mjs` supplies the
  separately reviewed testnet-only funding/release signing policy, imports the
  existing SDK, reads the parent identity through `storage.loadIdentity` without
  printing or copying its secret, and reuses its exclusive `withLock`.
- Deploy the new escrow Wasm, initialize it, and read its `registry`, `storage_topup`
  and deployed code hash through finalized queries. Pin the actual escrow AND
  registry code hashes in `EscrowConfig`; never use test-double hashes as pins.
- The payments-owned signer requires main's explicit owner-lock-free signal before
  entering the shared owner lock. It journals/fsyncs every signed hash before
  broadcast and only queries that same hash after uncertainty. The dedicated
  child is `escrow.veil-reg-e138f5c88250f821.testnet`, with its own local key.
  Creation is capped at **3 test NEAR**, after main clarified that 0.5 was only an
  implementation estimate. Preflight checks current RPC storage price, code plus
  8 KiB reserve, and retention of at least 1 spendable parent test NEAR after its
  own storage and a 0.05 gas allowance. The reviewed Wasm is 219,847 bytes; at the
  observed `10^19` yocto/byte the code-plus-reserve need is 2.28039 test NEAR.
  The original NEAR endpoint preflight was rate limited (429).
  Main then verified HTTP 200 testnet status/job reads at the official listed
  `https://test.rpc.fastnear.com`; both payment clients now select it explicitly.
  Signed sends never automatically fail over or re-broadcast on another endpoint.
  Persist
  the signed transaction hash before dispatch and reconcile that same hash after
  uncertainty. The escrow observer does not own a sending outbox. Do not give an
  unrestricted signer to an agent or use a newly signed transaction as a retry.
- Call the existing registry's bid/attempt/report/accept lifecycle, then fund and
  release through the new escrow as above. Funding can precede execution; it must
  precede release. Independently verify the local ciphertext artifact and its hash
  before the buyer accepts. No cryptographic correctness proof is inferred.
- Integrate the caller, durable transaction journal, capability/status reporting
  and receipt verifier in service/UI code under their owners. None of those files
  was changed by this payment worker.

Free testnet account creation/funding is supported by the
[official NEAR CLI faucet implementation](https://github.com/near/near-cli-rs/blob/main/src/commands/account/create_account/sponsor_by_faucet_service/mod.rs)
and prior registry faucet evidence; current quota/access still needs to succeed.
The initial feasibility review made no external financial mutation. The later,
explicitly authorized testnet run above created/deployed the escrow and completed
fund/release. Public documentation/account reads are anonymous; local identity
validation and testnet signing are not Market authentication. No new paid service
was used. Service/UI owners must wire and label this bounded rail themselves;
the payment worker does not declare the entire procurement product complete.

## Trust and completion boundary

The configured registry and its upgrade authority are trusted. Escrow queries an
on-chain account; it cannot use an RPC code-hash read to enforce that account's
historical code. Off-chain pins catch currently observed drift, not a malicious
upgrade-and-restore between calls. Escrow deployment full-access keys can replace
escrow code too; no key removal or independent custody is claimed. Naming checks
are defense in depth; the external signer must enforce actual network `testnet`.

Registry acceptance and payment are separate transactions. The escrow callback
checks the registry view and records exact acceptance before paying, but does not
make registry decision/payment atomic or prove FHE/MPC computation. All custody
terms/amounts and binding hashes are public. Refund needs provider cooperation;
missing callbacks can leave a pending payment locked for manual investigation.
Storage topups remain in the escrow after payment/refund.

The executed integration payout is a **fixed 0.001 test NEAR demonstration price**.
It is not the private MPC winning bid and does not prove price equality, eligibility
or correct private auction computation. Paying the selected executor establishes
only that the publicly stated fixed test price reached that provider under the
bound registry receipt. Amount, buyer/provider and all escrow terms are public.

Checks and reproducible commands are in `payments/testnet_escrow/README.md`.
The fixed-buyer security regression failed before the patch and passed afterward,
along with the legitimate self-owned-registry buyer lifecycle in the real sandbox.
Offline protocol doubles and local sandbox execution must be labelled as such.
Those bounded public-testnet completion conditions are now recorded above. Keep
Market settlement, MPC price-equality proof, independent operators and product-wide
completion separate. Cooperative refund was exercised in the real local sandbox;
it was not invoked against this externally paid job.
