# Multi-field v5 extension (14 Nov 2026)
The current app additionally supports versioned `nope-record-proof-gc-v5` tasks: `web/record-core.mjs` / `record-client.mjs` implement bounded multi-input u32 garbled rules; `record-plan.mjs` validates public tasks and buyer-local CSV mapping; `record-proof-core.mjs` / `record-proof-client.mjs` and `proof-runtime/record-*` implement the separate genuine Noir proof policy. `web/proof-protocol.mjs` / `proof-client.mjs` dispatch exact versions without changing historical v4 artifacts. Reviewed invoice/cash-flow templates are deterministic, not neural inference. General encrypted LLM/PDF semantics remain unsupported. Never publish a private decoder, witness, label-pair alternatives or selected clear values. Run record engine/proof/API tests when changing this path. See `docs/RECORD-RULES.md` and README limits.

# NOPE repository context

Use `AGENTS.md` for current project instructions and `README.md` for the supported workflow, source-to-test review map, privacy/proof boundaries and setup commands.

The current application is `/workspace`; the older Concrete FHE/MPC prototypes and Python receipt adapter under `sdk/` are separate experiments. The current result proof is Noir/UltraHonk verification in the browser/API, not an on-chain SNARK verifier or proof of original CSV provenance/provider execution. The payment contract is NEAR testnet only.

Offline JavaScript regression tests and the allowlisted build do not need a project storage token, wallet key, private CSV or a live transaction. For live public verification use the completed-job verifier linked in README. Full self-hosting requires a separately configured private Blob store. Check the declared scope of each test and recorded receipt rather than treating fixture-based tests as live network evidence.

Never commit runtime, secret keys, customer plaintext or proof witnesses. Preserve historical source/evidence files. Current changes should maintain exact origin, nonce, role, delivery-version, result-proof and exact-amount payment checks.
