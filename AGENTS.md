# NOPE — current application map

The current application is the browser-based `/workspace` flow, not the original local Python prototype. Canonical hosted origin: `https://nope-workspace.vercel.app`. The prior origin stays available for pre-existing browser vaults; local CSVs, decoders and witnesses do not transfer between origins.

Start with `README.md` for the supported workflow, proof statement, limitations and reproducible commands. Current implementation:
- `web/workspace.js`, `web/agent-plan.mjs`, `web/workspace-vault.mjs`: local CSV, anonymous-schema planning, bounded plan approval, encryption/decryption and private witness.
- `api/workspace.mjs`, `workspace/core.mjs`, `workspace/wallet-auth.mjs`: exact-origin API, wallet-authenticated buyer/provider roles, sealed bids and revision/state guards.
- `web/proof-plan-core.mjs`, `web/proof-plan-client.mjs`, `web/public-proof.mjs`, `proof-runtime/`: precommitted typed result correctness, independent browser/server verification and public proof verification.
- `payments/wallet_escrow/`, `workspace/wallet-escrow.mjs`: exact-amount buyer-funded **testnet** escrow, latest-delivery binding, explicit acceptance/release and deadline refund.

The result proof is not proof of CSV provenance, honest initial garbling, AES execution provenance, independent operators or natural-language intent. The contract does not verify SNARKs. Provider execution currently triggers the server evaluator; arbitrary provider code and a turnkey autonomous-agent marketplace SDK are not shipped. Keep code, documentation and claims consistent with these boundaries.

Run relevant existing tests and `npm run check:locales`; use `npm test` for broad application regression checks and `npm run build` for the allowlisted deployment build. Contract tests are separate; see README. Tests using RPC fixtures are not live-chain evidence. Historical FHE/MPC experiments, sponsor-funded escrow and `docs/BUILD-CONTRACT.md` describe earlier separate paths; consult them only for those paths. Preserve historical evidence without silently rewriting recorded origins, hashes or outcomes.

Never commit runtime files, secrets, private keys, real customer data or private proof witnesses. No mainnet/real-money operations or additional paid services. Use synthetic data for checks. Keep exact-origin/nonce/role/callback and proof/revision/payment checks intact. Do not bypass a failing check or label simulated evidence as real.

# Private procurement prototype
Current authorization (12 Nov 2026): user explicitly requested live preparation, private GitHub and automatic Vercel deployment, encrypted remote computation and testnet integration. This supersedes the older local-only deployment restrictions below and in BUILD-CONTRACT.md. Use the existing private Vercel projects and synthetic tests. No mainnet/real-money transactions, additional paid services, customer plaintext/secret-key uploads, or claims of independent operators/execution proofs. Keep runtime, environment values, invitation tokens and wallet keys out of Git and deployment bundles.

Read docs/BUILD-CONTRACT.md. Edit only assigned paths; other workers are active. Never revert unrelated edits. No secrets, real money or private customer inputs. The user explicitly authorized this project's private GitHub repository and Vercel static frontend deployment with Git auto-deploy. Keep native services local and never publish runtime or key material. Other external access needs task authorization. Use synthetic fixtures. Preserve existing research files read-only. Mark simulated or unsupported capabilities honestly. Source and test outputs must distinguish cryptographic computation from local trust and payment fixtures.

Deployment preference: Vercel follows GitHub main. For completed, authorized project updates, run relevant checks, commit the scoped changes and push main so the website updates automatically. Never push unrelated edits or secrets; honor later branch/release instructions.
