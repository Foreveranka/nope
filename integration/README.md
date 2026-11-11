# Local procurement integration

This test connects real Concrete FHE, three local malicious-secure MP-SPDZ
processes, and a real disposable NEAR sandbox. Payment uses a durable SQLite
**simulation**, not NEAR Agent Market settlement or funds custody. All inputs are
synthetic and known to this harness. It is not a public-service coordinator.

## Run

From `/Users/mete/near-private-procurement`:

```sh
./scripts/run-integration.sh
```

Requires the existing Concrete 2.11 Python environment and pinned built MP-SPDZ
runtime. `VEIL_PYTHON` can select that interpreter. `VEIL_PYCACHE` selects an
existing read-only bytecode cache; the local Apple cache avoids slow iCloud
dependency reads. Nothing installs itself or changes the global Python setup.

Build the current registry Wasm/driver if needed:

```sh
RUSTFLAGS='--cfg near' ./contracts/registry/scripts/cargo-local.sh build --locked --target wasm32-unknown-unknown --release
./contracts/registry/scripts/cargo-local.sh build --locked --manifest-path sandbox/Cargo.toml --bin registry-sandbox-driver
```

The driver accepts no external RPC URL, keys or account credentials; it creates
only disposable local funded test identities. `--output` must name a new directory
and defaults to a unique directory under ignored `runtime/`. MPC port base 17400
is reserved for this test; do not run two integrations simultaneously.

## Actual ordering enforced by the harness

1. Generate the client key in memory and encrypt four synthetic numeric records.
2. Form a versioned precommit intent before budget/bid commitments; register the
   exact circuit, key, encrypted-input, policy and precommit hashes on NEAR.
3. Submit all three bids from their local sandbox accounts and close the full set.
4. Validate the registry config, job hash and full bidset; reserve a durable local
   one-shot selection admission record; execute genuine MPC against that manifest.
5. The buyer explicitly authorizes the returned roster winner on the registry.
   The contract binds this executor into a v2 attempt hash. This is buyer-authorized
   routing, **not an on-chain proof of MPC correctness**.
6. Hold the fixture amount, then bind the FHE request to the actual job/attempt.
7. Run the separate ciphertext evaluator, then client-side decrypt/reference check.
8. Build the bound result claim and send it from the selected sandbox account.
9. Reject unauthorized/replayed reports and unauthorized acceptance. Accept the
   exact receipt as buyer, then release the fixture amount once, even across retry.

`result.json` records flags, public bindings, measured checks and limits. The
`events.jsonl` hash chain establishes local ordering only; it is not a third-party
timestamp or proof against an administrator rewriting all local files. The two
payment databases contain synthetic prices and identities. Never use real bids
or customer data with this harness.

## Failure behavior and boundaries

The JSON-lines transport never blindly retries a timed-out mutation. Selection
admission survives a restart as IN_FLIGHT_OR_UNKNOWN and blocks a second query;
this is only a local guard, not yet independent per-operator consensus. The FHE
secret key is not serialized; interruption loses the session and requires a new
explicit job. Evaluation keys are deleted on cleanup. Child processes are owned
and shut down on context exit. Payment calls remain fixture-only: runtime MCP
schema discovery does not establish live acceptance, settlement or refund.

No external deployment, real transfer, independent hosting, execution-proof
verifier, or automatic private-evidence dispute resolver is delivered by this
test. The regular `/app` page remains the standalone FHE UI; this CLI exercises
the combined procurement flow.
