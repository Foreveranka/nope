# Workspace prefunded testnet escrow

Separate from `payments/testnet_escrow` and the old registry. This contract trusts
the backend's authenticated buyer decisions. It does **not** prove computation,
guest identity, buyer signatures, or equality to a private winning bid. No public
testnet deployment/signing is performed by this package's build/tests.

## Frozen JSON interface for MAIN and relay

All methods accept zero attached deposit. All mutations, including `new`, require
`predecessor_account_id == current_account_id`. Current account must end `.testnet`.
Keep the full-access key local. Online FunctionCall key: receiver is this contract,
allowed methods **only** `fund,record_delivery,accept_and_release,refund`, finite
gas allowance. Never include `new` or `on_transfer` in its allowed methods.

```json
{"method":"new","args":{}}
```

```json
{"method":"fund","args":{"terms":{
  "job_id":"0123456789abcdef0123456789abcdef",
  "buyer_commitment":"1111111111111111111111111111111111111111111111111111111111111111",
  "provider":"provider.testnet",
  "amount":"1000000000000000000000",
  "input_hash":"2222222222222222222222222222222222222222222222222222222222222222",
  "program_hash":"3333333333333333333333333333333333333333333333333333333333333333",
  "plan_hash":"0000000000000000000000000000000000000000000000000000000000000000",
  "execution_deadline_ns":"1794700000000000000",
  "review_deadline_ns":"1794786400000000000"
}}}
```

`provider` permits a valid named `.testnet` account or 64 lowercase hex implicit
account, and may not equal this contract. All hashes are lowercase hex strings,
not byte arrays; job IDs have 32 characters, commitments/hashes 64. Zero hashes
are allowed, including legacy `plan_hash`. Amount is U128 decimal string; deadlines
are U64 decimal strings. `0 < amount <= 10000000000000000000000` (0.01 testNEAR).
New holds require `now < execution < review <= now + 30 days`. MAIN's award +24h
and +48h deadlines fit. Retries must reuse these exact stable terms.

Hold result of `fund`, `record_delivery`, `refund`, and `get_hold`:

```json
{
  "terms":{"job_id":"...","buyer_commitment":"...","provider":"provider.testnet","amount":"1000000000000000000000","input_hash":"...","program_hash":"...","plan_hash":"...","execution_deadline_ns":"...","review_deadline_ns":"..."},
  "binding_hash":"64-lowercase-hex",
  "state":"Held",
  "nonce":"0",
  "delivery":null,
  "last_transfer_failure_nonce":null
}
```

State: `Held | Delivered | PayoutPending | Paid | Refunded`. Delivery, when present:
`{"version":1,"output_hash":"64-lowercase-hex"}`. Nonce and failure nonce are U64
decimal strings; version is a JSON u32 number. `get_hold({"job_id":"32hex"})`
returns this Hold or `null`. Invalid job ID syntax fails instead of returning null.

Binding: SHA256 of UTF-8 `JSON.stringify` of this **all-string array**, no spaces:

```text
["NOPE:WORKSPACE-ESCROW:V1:testnet",current_account_id,job_id,buyer_commitment,
 provider,amount,input_hash,program_hash,plan_hash,execution_deadline_ns,review_deadline_ns]
```

```json
{"method":"record_delivery","args":{"job_id":"32hex","binding_hash":"64hex","version":1,"output_hash":"64hex"}}
```

Only Held/Delivered, through execution deadline inclusive. Starts at version 1;
subsequent versions must be exactly latest+1. Exact same latest version/hash is
idempotent; an old/replaced version or same-version different hash fails.

```json
{"method":"accept_and_release","args":{"job_id":"32hex","binding_hash":"64hex","version":1,"output_hash":"64hex"}}
```

Only Delivered, matching latest delivery, through review deadline inclusive.
Attach at least **100 Tgas** (recommend 150); callback has 20 Tgas. Sets
`PayoutPending` and increments nonce before the native transfer. Returns a Promise
resolving to callback boolean, **never** an immediate Paid Hold. Reconcile finalized
native-transfer receipt and `get_hold`; outer transaction success alone is not
payment evidence. Pending/paid replay fails. Definitively failed transfer returns
to Delivered and sets `last_transfer_failure_nonce` to that attempt's nonce.
Malformed/oversize successful result, lost callback, and unknown pending outcome
remain Pending, with no retry/refund path. There is no timeout-based payment.

Private callback shape (not an online-key method):
`on_transfer({"job_id":"32hex","binding_hash":"64hex","nonce":"1"})`.
Requires self predecessor, one promise result, exact Pending state/binding/nonce.
Only an empty successful native-transfer result moves allocation to `spent`/Paid.

```json
{"method":"refund","args":{"job_id":"32hex","binding_hash":"64hex"}}
```

Only strictly **after** review deadline, Held/Delivered. Terminal Refunded returns
the allocation internally to sponsor availability; no transfer to the visitor.
Pending and Paid can never refund. Existing hold terms cannot be replaced or
re-funded: identical `fund` returns existing Hold without allocating again,
including terminal holds; changed terms fail.

`get_config({})`:

```json
{
  "domain":"NOPE:WORKSPACE-ESCROW:V1:testnet",
  "network":"testnet",
  "contract_id":"escrow.testnet",
  "max_holds":50,
  "max_hold_amount":"10000000000000000000000",
  "total_pool":"50000000000000000000000",
  "available":"50000000000000000000000",
  "held":"0","spent":"0","pending":"0","hold_count":0,
  "gas_reserve":"100000000000000000000000",
  "storage_headroom_bytes":65536,
  "min_release_gas_tgas":100,
  "callback_gas_tgas":20
}
```

Pool accounting: `available + held + spent == total_pool`, pending is included in
held. Capacity is 50 permanently retained holds, including refunded/paid records.
Topups never inflate `total_pool`. No withdrawal, reset, migration, setters,
automatic refill, arbitrary function-call, or administrator rescue method exists.

## Balance safeguards and build

Initialize only after separately funding the account. `new`, new `fund`, and
release check actual liquid account balance against storage staking at current
storage usage **plus 64 KiB headroom**, **0.1 testNEAR gas reserve**, and unspent
0.05 logical pool. Already scheduled pending payouts are excluded from the latter
balance requirement, while remaining held until callback. Pre-fund generously
enough for deployed code/storage too; no deposit-bearing methods accept topups.
An external native transfer can replenish operational gas, never logical budget.
This is a balance floor, not a gas-price oracle; the finite key allowance and
offline operator monitoring remain necessary. No automatic gas purchase exists.

The wrapper uses the existing registry SDK/toolchain cache (SDK 5.30.1) and, with
MAIN's authorization, shares `payments/testnet_escrow/target` to reuse compiled
dependencies. It never cleans or overwrites the older contract's named artifacts.
No new paid dependencies.

```sh
sh payments/workspace_escrow/cargo-local.sh test --offline --locked
sh payments/workspace_escrow/cargo-local.sh fmt --check
sh payments/workspace_escrow/cargo-local.sh clippy --offline --locked --all-targets -- -D warnings
RUSTFLAGS='--cfg near' sh payments/workspace_escrow/cargo-local.sh build --offline --locked --release --target wasm32-unknown-unknown
mkdir -p payments/workspace_escrow/.toolchain/tmp
TMPDIR="$PWD/payments/workspace_escrow/.toolchain/tmp" sh payments/workspace_escrow/cargo-local.sh test --offline --locked --manifest-path sandbox/Cargo.toml -- --nocapture
```

For cache-only sandbox execution on the verified host, prefix the last command
with `NEAR_SANDBOX_BIN_PATH="$PWD/payments/testnet_escrow/target/debug/build/near-sandbox-799e5657ea686f2e/out/.near/near-sandbox-2.14.0/near-sandbox"`.
This reuses the existing binary instead of downloading another copy. Use explicit
gas limits: this cached near-workspaces SDK's `max_gas()` requests **1,000 Tgas**,
which exceeds the test's finite access-key allowance. The VM test uses explicit
30 Tgas for first funding and 100 Tgas for release, with 0.2 testNEAR key allowance.

Wasm: `payments/testnet_escrow/target/wasm32-unknown-unknown/release/nope_workspace_escrow.wasm`.
Unit tests use the SDK mock host. The separate sandbox test runs real local Wasm
with synthetic local accounts, not public testnet evidence. Provisioning and
deployment scripts belong to MAIN outside this package.

## Verified local build, 14 November 2026

- 14 SDK unit tests passed. Covers malformed fields/deadlines, all-mutator
  predecessor/deposit checks, pool/capacity limits, exact immutable funding
  replay, delivery versions, callbacks/nonces, failures and internal refunds.
- One **actual local sandbox VM** lifecycle passed (10.87 seconds after cached
  compilation): deployed the real Wasm to synthetic local accounts with exactly
  4 testNEAR initial funding, used a finite 0.2 testNEAR FunctionCall-only key,
  observed the exact 0.001 testNEAR provider balance increase, rejected duplicate
  payout and forbidden callback invocation, observed a real failed native
  Transfer return Delivered, and refunded a timed-out hold without paying anyone.
  A second `new()` was rejected; minimum 100 Tgas release/20 Tgas callback passed.
- Root package `clippy --all-targets -- -D warnings`, both format checks, and
  release Wasm build passed. SDK host mocks are not the actual VM evidence above.
- Artifact size: **202,524 bytes**.
- Artifact SHA-256:
  `77c4886d5db5d03782c9c4721222fba80a00f557d3e97819c86205fa295a6610`.
- NEAR code hash (base58 of artifact SHA-256):
  `94XLBcytUKaL19QBzQqKFKsDvNZipcn5yvEUFEuumsPm`.
- `src/lib.rs` SHA-256:
  `9af743e3417210ac0207b012f76325c89062c955b5682158edc94b44495a531e`.

These are local build/test results, not a public-chain deployment, buyer signature,
or computation proof. MAIN owns subsequent reviewed provisioning and relay.

## VM profile limits and revised 2.9 testNEAR pilot

The frozen contract and Wasm above were also exercised with MAIN's revised 2.9
testNEAR allocation. Constructor, funding and delivery recording passed. The
following failures describe this local VM profile, not a determination that the
actual network cannot support MAIN's bounded pilot:

1. With a 0.05 testNEAR FunctionCall allowance, the local VM rejected the required
   100 Tgas release before contract execution (`NotEnoughAllowance`). The required
   allowance envelope was `100919450817521200000000` yoctoNEAR, versus
   `49078464346739500000000` remaining after earlier operations. The normal
   lifecycle test now explicitly checks rejection of a separate local 0.05 key.
2. Retrying the 2.9 allocation with the previously working 0.2 key allowance got
   through transaction authorization but failed the contract's actual-balance
   safeguard on release. Passing a static `(code bytes + 65536) * storage price`
   provisioning minimum did not establish release-time solvency in that VM.

MAIN reports a current actual-RPC gas price of `100000000` on 14 November 2026.
The VM's `gas_price` query also printed `100000000`, despite the larger observed
transaction-allowance envelope above. That discrepancy was not isolated; this VM
profile has not been calibrated to the live fee checks. No further genesis edits
or VM reruns were made for that purpose. The failures demonstrate guard behavior;
they do not establish actual-network unavailability.

The passing lifecycle uses the local 4 testNEAR / 0.2 allowance fixture. MAIN's
2.9 / 0.05 pilot must independently reject signing unless actual account balance,
storage staking, remaining key allowance, current gas price and the bounded
150 Tgas transaction plus applicable overhead can cover the operation, while
preserving the contract's existing solvency guards. Static storage arithmetic or
these local tests alone do not establish that preflight. Avicenna owns its dynamic
implementation; this package does not weaken any guard or sign the pilot.

No frozen contract logic or Wasm changed. No public-chain wallet funds were queried
or moved by these tests. Selected outputs from the already completed commands are
saved in `verification/local-test-output.log`; this is a captured-output handoff,
not a new run, a raw sandbox node log, or public RPC/chain evidence.
