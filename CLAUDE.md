# NOPE repository context

Use `AGENTS.md` for current project instructions and `README.md` for the supported workflow, source-to-test review map, privacy/proof boundaries and setup commands.

The current application is `/workspace`; the older Concrete FHE/MPC prototypes and Python receipt adapter under `sdk/` are separate experiments. The current result proof is Noir/UltraHonk verification in the browser/API, not an on-chain SNARK verifier or proof of original CSV provenance/provider execution. The payment contract is NEAR testnet only.

Offline JavaScript regression tests and the allowlisted build do not need a project storage token, wallet key, private CSV or a live transaction. For live public verification use the completed-job verifier linked in README. Full self-hosting requires a separately configured private Blob store. Check the declared scope of each test and recorded receipt rather than treating fixture-based tests as live network evidence.

Never commit runtime, secret keys, customer plaintext or proof witnesses. Preserve historical source/evidence files. Current changes should maintain exact origin, nonce, role, delivery-version, result-proof and exact-amount payment checks.
