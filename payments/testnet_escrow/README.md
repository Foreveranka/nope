# NOPE native test-NEAR escrow

Separate from NEAR Market. Source implements actual custody and native Transfer
promises. The external-testnet deployment and fixed-price payout for accepted
registry job 3 are now verified; see `verification/testnet-payout-verified.json`
and `testnet-reconciliation.json` for actual evidence, distinct from test doubles. See
[the decision](../../docs/TESTNET-PAYMENT-DECISION.md) for prerequisites and limits.

## Build and check

Requires the repository's already installed scoped Rust 1.98 toolchain/cache.
The wrapper reuses that cache but puts all new build outputs in this directory's
ignored `target/`. It does not change the registry contract or its artifacts.

```sh
sh payments/testnet_escrow/cargo-local.sh test --offline --locked
sh payments/testnet_escrow/cargo-local.sh fmt --check
sh payments/testnet_escrow/cargo-local.sh clippy --offline --locked --all-targets -- -D warnings
RUSTFLAGS='--cfg near' sh payments/testnet_escrow/cargo-local.sh build --offline --locked --release --target wasm32-unknown-unknown
python3 -m unittest discover -s payments/tests -v
node --test payments/testnet_escrow/client.test.mjs
```

Wasm: `payments/testnet_escrow/target/wasm32-unknown-unknown/release/nope_testnet_escrow.wasm`.
The lockfile pins SDK 5.30.1. To use a different host, run equivalent Cargo commands
from this directory with the pinned compatible toolchain and `--cfg near` for Wasm.

Actual local VM integration test (synthetic local accounts, not public testnet):

```sh
mkdir -p payments/testnet_escrow/.toolchain/tmp
TMPDIR="$PWD/payments/testnet_escrow/.toolchain/tmp" sh payments/testnet_escrow/cargo-local.sh test --offline --locked --manifest-path sandbox/Cargo.toml -- --nocapture
```

It deploys the existing registry Wasm and this escrow Wasm on a local NEAR sandbox,
uses distinct buyer/provider accounts, exercises premature release rejection,
real registry bid/report/accept, a measured provider transfer, duplicate-release
rejection and cooperative refund. No live Market mocks replace the registry/escrow
in that test. The second refund hold uses authored terms without a registry job;
funding deliberately does not query registry state. Only release depends on it.

## Caller integration

Python 3.9+ standard library, no external SDK needed for read-only transport:

```python
from payments.near_testnet import NearTestnetRPC, TestnetPaymentBinding
from payments.near_testnet_escrow import (
    EscrowConfig, NearTestnetEscrowClient, fund_intent,
)

rpc = NearTestnetRPC()  # https://test.rpc.fastnear.com, pinned testnet-only origins
# Values below must come from the caller's reviewed deployment/registry evidence.
config = EscrowConfig(escrow_id, escrow_code_hash, registry_id, registry_code_hash)
client = NearTestnetEscrowClient(config, rpc)
fund = fund_intent(config, job_id, buyer_id, provider_id, amount_yocto,
                   context_hash, job_binding_hash)
# fund is a real FunctionCall action with exact deposit, NOT a sent transaction.
# Caller SDK decodes args base64, uses integer gas and yoctoNEAR deposit, persists
# its signed tx hash before broadcast, sends ONCE on testnet, and waits for FINAL.
# Following real execution and exact registry acceptance:
payment = TestnetPaymentBinding(
    registry_id, registry_code_hash, job_id, buyer_id, provider_id, amount_yocto,
    context_hash, job_binding_hash, attempt, attempt_binding_hash,
    registry_receipt_hash, ciphertext_output_hash,
)
release = client.release_intent(payment)
# Same caller signing/journal/broadcast discipline; release is not a payment yet.
evidence = client.verify_release(actual_release_tx_hash, payment)
assert evidence['state'] == 'verified_nope_testnet_escrow_payout'
assert evidence['market_settlement'] is False
```

`verify_release` requests `EXPERIMENTAL_tx_status` with `FINAL` for actual receipt
bodies (official compatible alias of current `tx_status`), not an invented service.
RPC errors, pruned history and unsupported shapes are unresolved evidence, not a
reason to pay again. Transport never sends financial operations. The deployed
contract's `fund`, `release`, `approve_refund`, and `refund` are real payable/state
methods for the caller to invoke; no blanket live-operation disable exists there.

Contract JSON hashes are byte[32]; U64 IDs/attempts and U128 amounts are decimal
strings. Funding requires amount + `20000000000000000000000` yoctoNEAR (0.02 test
NEAR), retained for storage. Every other method requires zero deposit. Use 150 Tgas
for release/refund as the Python intents do. Current amount maximum is one test
NEAR and capacity ten permanently retained job records. No fixture is live evidence.

This pilot requires `terms.buyer == registry` and direct funding from that account.
The registry must be self-owned (`owner == registry`), as checked by the signer.
This prevents an outsider from reserving an actual job ID with their own buyer.
The sandbox test uses the registry account as buyer and a distinct provider.

## Authorized external testnet adapter

`client.mjs` imports near-api-js from the existing registry `node_modules`, reads
the existing parent key only through its `storage.loadIdentity`, and uses its
exclusive `withLock`. No parent secret is copied or printed. The escrow child's
new key and hash-only journals live in ignored `payments/testnet_escrow/runtime/`.
The signer strictly permits the dedicated child creation (3 test NEAR maximum),
reviewed Wasm + self initialization, and bounded owner fund/release calls. It
requires current registry code/owner/domain pins, sufficient child storage, and
one spendable test NEAR left at the parent after its own storage and gas reserve.

Do not run mutations until main explicitly signals that chain integration released
the owner lock. After that signal, the concrete paths are:

```sh
node payments/testnet_escrow/client.mjs plan
node payments/testnet_escrow/client.mjs deploy --owner-lock-free
# Replace JOB_ID with the actual accepted integration job ID, not a fixture ID.
node payments/testnet_escrow/client.mjs pay JOB_ID --owner-lock-free
python3 payments/testnet_escrow/verify_payout.py
```

`pay` uses a fixed 0.001 test NEAR demonstration payment plus 0.02 test NEAR retained
storage funding. **It does not reveal or prove equality to the private MPC winning
bid.** The payout amount and escrow terms are public. It verifies the actual
registry-selected provider, accepted receipt and Paid callback state, then exports
the public handoff to `verification/testnet-payout.json`. The independent Python
observer reads actual `FINAL` transaction/receipt bodies and writes
`testnet-payout-verified.json` only after all checks pass. Until then the handoff
explicitly says `observer_verification_required: true`.

That flag is a signer-stage requirement, not final payout status: the completed
job-3 run additionally has successful `testnet-payout-verified.json`, raw actual
fund/release RPC receipts, finalized Paid views and zero-send restart evidence.
The contract address and child-key path for main's wallet ledger are in
`verification/testnet-escrow-account.json`; no private key is present there.

Every signed hash is fsynced before broadcast. A lost response, restart, apparent
Paid state or elapsed time never authorizes a replacement transaction. The same
journal/hash is read with `tx` on repeat. Existing owner lock contention is an error,
not a reason to delete the lock. No authenticated Market call or mainnet is used.

The explicit RPC selection is `https://test.rpc.fastnear.com`, listed in the
[official NEAR provider table](https://docs.near.org/api/rpc/providers). Main
observed synchronized `testnet` status and the actual job at HTTP 200 there after
the original NEAR endpoint returned 429. There is no automatic fallback on a signed
send; changing nodes means querying the same already-journaled transaction hash.
