# Wallet-funded testnet escrow V2

## Current storage-prepaid deployment — 14 November 2026

Active contract: `nope-wallet-5144c7d4.testnet`; code hash
`349qhEttcFqG3ezvPHBCoFCyM8X1ZpXzYotgfqFXgN13`.
Domain: `NOPE:WALLET-ESCROW:V2:testnet`.
Deployment and key removal were confirmed at the same FINAL block
`2XTWmjrXaitsZNpriTdJzboH7yc5F2KFhSSrh8vKMx2i`, before any customer funding.
Public source/build/deployment records are under `verification/storage-v2/`.

Every `fund({terms,admission_signature})` attaches **exactly** the selected
`terms.amount` **plus** a fixed reservation of 4096 bytes multiplied by
`env::storage_byte_cost()`. At the pinned testnet storage cost this is
`40960000000000000000000` yoctoNEAR, or **0.04096 testNEAR**. The policy field is
`storageDepositYocto`. The maximum selected price remains 1 testNEAR, so maximum
attached funding is **1.04096 testNEAR**, before network fees. Underpayment,
price-only funding and overpayment all fail; failed transactions do not create a hold.

The storage reservation is **nonrefundable**, retained for the permanent record.
It is not payment credit, not a provider fee and not included in the refundable
or releasable liability. Payout/refund transfers **only** the immutable selected
price. There is no administrative withdrawal, price top-up, upgrade or allocation
method. The constructor still pins the existing Ed25519 admission key, but
admission is no longer the sole defense against resource exhaustion.

`near_sdk::store::LookupMap` stores each buyer/job key independently; the global
Borsh state has constant size. There is **no global hold capacity limit** and no
shared finite admission allocator. The `U64` `hold_count` is informational only.
Each new hold fully prepays its maximum later state. The maximum Borsh hold is
654 bytes, its prefixed Borsh key 102 bytes, and NEAR's per-record runtime overhead
40 bytes: **796 bytes total**, independently measured against the VM storage
delta. This covers maximum 64-byte accounts, 32-character job ID, fixed hashes,
U128 price, U64 deadlines/nonce, maximum delivery and failure/pending states.
The 4096-byte reservation leaves room above that upper bound; future holds cannot
consume earlier buyers' storage or payment liabilities. Solvency separately
reserves base code/state headroom, all per-hold reservations and the gas buffer.

Terms and their ordered binding tuple are unchanged; the new V2 domain and
immutable new code/address separate the storage-funded protocol from V1. The
hold adds `storage_deposit_yocto`. `get_config` exposes `storage_bytes_per_hold`,
`storage_deposit_yocto`, `storage_deposits`, `storage_deposit_refundable:false`,
and string `hold_count`. `total_deposited`, `liabilities`, `total_paid` and
`total_refunded` still count selected prices only. The browser, server intents
and independent public verifier pin the storage charge and distinguish total
funding from price.

The server admission key was reused from ignored mode0600
`runtime/admission-v1/admission-key.json`; no secret was added to frontend or
source, and no server credential change was necessary. New isolated contract,
buyer and provider keys are under ignored mode0600 `runtime/storage-v2/`.
`provision.mjs` requires source/Wasm checks and passing package unit/sandbox
logs before deployment and removes every contract access key before deposits.
Only free testnet faucet accounts and synthetic transactions are used.

## Cutover and verification

A fresh same-FINAL-block read-only inventory of `nope-wallet-66e1273c.testnet`
confirmed exactly three terminal holds, zero liabilities and no pending
transfers before V2 deployment; see `verification/storage-v2/legacy-before-cutover.json`.
Historical verifier policies retain **both** `nope-wallet-44384e2f.testnet` and
`nope-wallet-66e1273c.testnet`. Historical bindings and C775 evidence are not
rewritten. Retired jobs remain read-only through the application.

- `verification/storage-v2-unit-tests.log`: 18 unit tests, including 4,001
  independently paying buyers with constant serialized global state, 128 buyers
  reaching terminal refund and a subsequent new successful fund, maximum storage
  sizing, exact deposits, callback failures, cross-job solvency and authorization.
- `verification/storage-v2-sandbox-tests.log`: actual keyless compiled-Wasm
  lifecycle with native price-only payout/refund, retained storage charges,
  real failed payout/refund callbacks and safe nonce retry.
- `verification/storage-v2-js-tests.log`: wallet, server, Blob and public-verifier
  regressions, including minimum/maximum price-plus-storage deposits and rejection
  of missing, altered or noncanonical storage charges.
- `check-live.mjs`: explicit synthetic public-testnet payout/refund checks; not
  part of npm test or build. Public results live in `verification/storage-v2/`.

The protocol schema describes V2. The following original deployment material is
historical V1 evidence and its old exact-price-only ABI/capacity are not active.

## Original interface and historical deployment evidence

The original account and receipt evidence below refers to the retired deployment;
it is preserved as historical evidence. For new funding, include the admission
signature described above and use the current pinned contract.


See `protocol.schema.json` for exact public methods, terms, namespace, binding
tuple and limits. This is new code, separate from the sponsor escrow.

Domain: `NOPE:WALLET-ESCROW:V1:testnet`. Storage keys are the pair
`(buyer_account, job_id)`; all job methods include both values. Funding requires
the predecessor to be the terms' buyer wallet and attaches exactly `terms.amount`.
A second funding attempt for the same pair always rejects, even with identical
terms. An attacker can fund only their own namespace and cannot preempt a public
job ID belonging to a different buyer. Integrators must pin the intended buyer in
the application's immutable payment metadata, not infer it from the first fund.

Binding hash: SHA-256 over a compact UTF-8 JSON array of strings in this order:
`[DOMAIN, contractId, job_id, buyer_commitment, buyer_account, provider, amount,
input_hash, program_hash, plan_hash, execution_deadline_ns, review_deadline_ns]`.
Amounts and nanosecond timestamps use canonical decimal strings.

The selected provider or buyer may record delivery. Buyer recording allows
recovery if a provider fails to submit public delivery metadata; it cannot alter
the recipient or amount and cannot authorize another buyer's payment. Only the
immutable buyer may accept the exact latest delivery or request a late refund.
Refunds transfer the immutable amount to the immutable buyer, never to a caller-
selected account or sponsor pool. Each job has at most one pending transfer with
a nonce/action-bound private callback. Other jobs have independent liabilities.

Customer deposits are payment liabilities, not funds for storage or gas. The
contract must have a separately prefunded storage/gas buffer before accepting
customers. Solvency checks preserve every other job's balance. No withdrawal,
admin upgrade method, sponsor allocation or automatic arbitration is provided.
The bounded pilot retains at most 50 jobs permanently; capacity exhaustion rejects
new deposits rather than accepting unbacked state. This is not Sybil-resistant
admission control. Changing code or expanding permanent capacity requires a new
address once the contract is locked. Contract code does not verify SNARKs.

Private testnet keys and transaction journals belong only under ignored
`runtime/` with restrictive permissions. Only public receipts, addresses, code
hashes and test logs may be published. Deployment lock evidence must show a FINAL
empty key list before customer funding; otherwise deployment-key trust remains.

## Implemented interface

| Method | Arguments | Attached deposit | Result |
| --- | --- | --- | --- |
| `fund` | `{terms,admission_signature}` | Exactly `terms.amount` | `Hold` |
| `record_delivery` | `{buyer_account,job_id,version,output_hash}` | 0 | `Hold` |
| `accept_and_release` | Same delivery arguments | 0 | Promise to callback JSON boolean |
| `refund` | `{buyer_account,job_id}` | 0 | Promise to callback JSON boolean |
| `get_hold` | `{buyer_account,job_id}` | 0, view | `Hold` or `null` |
| `get_config` | `{}` | 0, view | Public limits and liability counters |

`Hold` contains `terms`, `binding_hash`, `state`, `nonce`, `delivery`,
`last_transfer_failure_nonce`, and `pending`. Nonces are decimal strings.
Delivery is null or `{version,output_hash}`. Pending is null or
`{action:"payout"|"refund",previous_state:"Held"|"Delivered"}`. States are
`Held`, `Delivered`, `PayoutPending`, `RefundPending`, `Paid`, and `Refunded`.
The private callback arguments are `{buyer_account,job_id,nonce,action}`.

Callback `true` means definitive native transfer success. `false` can mean a
definitive failure (prior state restored) or uncertain result (still pending).
Always reconcile FINAL connected receipts and the current hold. Never infer
payment from a successful outer transaction or automatically re-sign after an
unknown response. `send_tx` may omit full receipt bodies: use the same transaction
hash with `EXPERIMENTAL_tx_status`, not another transfer.

## Accounting, deadlines and liveness

- `total_deposited = liabilities + total_paid + total_refunded`.
- Pending payouts AND pending refunds remain liabilities until success;
  `pending_outgoing <= liabilities`.
- Solvency reserves actual storage cost plus 131072 bytes of headroom,
  0.1 testNEAR of operational buffer, and `liabilities - pending_outgoing`.
  The latter excludes money already scheduled out by NEAR, not other jobs' money.
- Funding is 1 yoctoNEAR through 1 testNEAR per job; at most 50 permanently
  retained namespaces/jobs. Review horizon is at most 30 days from funding.
- Funding: `now < execution_deadline < review_deadline`; recording allowed
  through execution deadline; acceptance through review deadline; refunds only
  strictly after review deadline. Each transfer entry requires at least100Tgas;
  callback receives20Tgas. Clients may attach150Tgas.
- After a definitive failed native transfer, its protocol refund receipt may
  arrive after our callback. Logical liability is restored immediately; new
  spending remains subject to actual-balance solvency. Unknown transfer outcomes
  remain pending and never authorize a duplicate transfer.
- There is no admin rescue of a lost buyer wallet key, failed callback or
  exhausted permanent capacity. Silence never pays, refunds or adjudicates a job.
  The safe response to a future code defect is a new version/address, not an
  upgrade of the locked contract. No generic trustless-application claim follows:
  the UI, session/offer/proof integration and RPC still have separate boundaries.

## Historical validation and original deployment

`verification/unit-tests.log`:13 SDK-host unit tests passed. They exercise exact
deposits, namespaces, hashes, limits, authorization, strict versions, deadlines,
gas/storage guard, terminal replay, uncertainty, nonce exhaustion, and failure
restoration for both payout and refund.

`verification/sandbox-tests.log`: one actual local NEAR2.14.0 Wasm lifecycle
passed in19.32s, after compiling only cached dependency versions. The contract
key was actually deleted before deposits. It measured exact native provider
credit, a real buyer refund, a real failed payout and a real failed refund. The
refund fixture deletes its own buyer account while its authorized refund is in
flight; the failed Transfer restores the liability, and a recreated buyer retries
with nonce2. Other jobs' liabilities remain intact. This is local VM evidence,
not public-chain evidence. The fixture is never deployed publicly.

Actual new public testnet deployment:

- Contract: `nope-wallet-44384e2f.testnet`.
- Domain: `NOPE:WALLET-ESCROW:V1:testnet`.
- Code hash: `6qzVqhNyk7KKvjzC6g8iPtJmHffTgb6YBh8Fp9xerXHy`.
- Wasm221852 bytes, SHA256
  `56d753677633d264a92acf3278e1708bc627b0b86a979b662011119c04c9dbe8`.
- Deployment transaction:
  `BdsBnCPbxBHw7jBiSA7kgnt4ZNcQWb7pzL8H62BUim59`.
- Remove-all-keys transaction:
  `7wWFjASTnegidrjxBm72CQ8y4NGHkevPXqSDp99JkxgR`.
- Same FINAL block277616505 (`5xFC4ghcvQmt1BRimtzfNetEykZqCSTuqoUWsdcHimqK`)
  confirmed the pinned code hash and **keys `[]`**. Initialization had zero
  customer deposits/liabilities. No customer funding happened before the lock.
- `verification/deployment-public.json` and `build-public.json` retain public
  code/source pins; `nope_wallet_escrow.wasm` preserves the actual binary.

The official free faucet created only the new contract/buyer/provider testnet
accounts. Its10 testNEAR contract bootstrap balance is separate from payment
accounting: initialization credited zero payment liabilities. All old sponsor and
registry contracts/accounts were left untouched.

Both separate real test-wallet financial checks passed. See
`verification/live-financial-checks.json` and the retained public RPC responses:

- Payout job `3aed48cad4efd951285b825066bc9bdd`, transaction
  `C4nrgJTgqsivLicrAMhyeSF4m1UY7GCMaG7L8V3ECiVH`: one exact0.001 testNEAR
  native Transfer to `nope-provider-44384e2f.testnet`; hold Paid.
- Refund job `f61665a1d4da5a44cdf4ec0c2c8a44bc`, transaction
  `6avvfDYttR5MTCRZgykU8bCSv1g2FLpJf6AhF48hyWVP`: one exact0.001 testNEAR
  native Transfer to immutable buyer `nope-buyer-44384e2f.testnet`; hold Refunded.
  The test used a60-second review deadline, not a production-length wait.
- Both native transfers have connected FINAL receipt graphs, exact amount and
  recipient, and successful nonce1/action-bound `on_transfer` callbacks.
- Final observed config: deposited0.003 testNEAR = paid0.002 + refunded0.001;
  liabilities0 and pending_outgoing0. This aggregate includes the integration
  worker's separate successful HTTP job in addition to our two direct checks.
- A read-only historical query at the exact deployment FINAL block confirms
  code, keys[] and zero initial deposits: `keyless-final-observer.json`.

These direct checks establish financial custody behavior, not a computation
proof. The separate application/SNARK HTTP integration is owned and reported by
its own worker. No direct test mutates that worker's job.

The public account ledger is `verification/accounts-public.json`. Actual key
values and signed-intent journals stay only in ignored `runtime/` files with
0600 permissions. The private personal competition-wallet ledger records public
addresses and file/JSON-field references only. Never deploy or commit runtime.

## Reproduce within the existing cache

```sh
sh payments/wallet_escrow/cargo-local.sh test --offline --locked --lib
sh payments/wallet_escrow/cargo-local.sh build --offline --locked --release --target wasm32-unknown-unknown
sh payments/wallet_escrow/cargo-local.sh build --offline --locked --release --target wasm32-unknown-unknown --manifest-path sandbox/refund-race/Cargo.toml
NEAR_SANDBOX_BIN_PATH="$PWD/payments/testnet_escrow/target/debug/build/near-sandbox-799e5657ea686f2e/out/.near/near-sandbox-2.14.0/near-sandbox" TMPDIR="$PWD/payments/wallet_escrow/runtime/tmp" sh payments/wallet_escrow/cargo-local.sh test --offline --locked --manifest-path sandbox/Cargo.toml -- --nocapture
```

The cached target is shared to avoid duplicate heavy builds. Never clean the
shared target or overwrite an old contract binary; this crate's Wasm has its own
name. The sandbox lock differs from the prior cached sandbox only in root test
crate name. No new dependency versions or model downloads were required.

Primary references: [NEAR actions/storage balance](https://docs.near.org/smart-contracts/anatomy/actions),
[private callbacks](https://docs.near.org/smart-contracts/security/cross-contract-calls/callbacks).
