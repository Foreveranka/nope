# NOPE agent-first build status

14 November 2026. User explicitly requested continuing until a real agent can plan and execute without seeing private company data, then testnet escrow and cryptographic proof. Do not stop at a recipe editor or relabel a keyword parser as an LLM.

## Ordered work

1. Implemented and actual-browser verified for the supported tool set: real local browser LLM sees approved public job brief and anonymous column aliases/types only. A strict typed validator binds its plan to that task. No CSV, row sample, original header, filename, private budget, keys or decoder is provided to the model.
2. Implemented and actual-browser verified: bounded multi-column encrypted plan execution, before/after and buyer/provider workflow. V1/v2 remain compatible; total compute/transport bounds enforced before encryption.
3. Passed: 307 Node tests, scoped UI progress tests, static build, actual native generation, encrypted HTTP, and actual Chrome two-role flow including reload/decode/accept. See browser-verification.json, storage-verification.json and http-local-verification.json. Published private GitHub main and Vercel production at c831613 (READY). Production model JS, manifest and correct-MIME WASM return HTTP 200; a real native model proposal also passed actual production encrypted HTTP evaluation and local full-CSV verification. The browser-model inference test itself ran on localhost, not production. Native evidence includes four exact supported plans, two explicit unsupported refusals and two malformed unsupported replies rejected entirely; a supported paraphrase also failed closed. This is not a general language-quality guarantee. A separate candidate experiment is evaluating robustness without changing this release.
4. In progress after the first verified workflow: connect actual native testnet escrow. The repository already has a separately tested/deployed restricted escrow under payments/testnet_escrow; the current workspace still uses direct transfers. These are not equivalent.
5. Pending after escrow: independent cryptographic correctness proof with precisely stated private/public inputs and task binding. Client reference checks, hashes, model assertions and transaction IDs are not this proof.

## Current contracts

- `web/agent-plan.mjs`: publicTask, publicTaskHash, acceptAgentProposal, privatePlanInputs, applyAgentOutput. Task {version:1,goal,columns:[{id:'C2',type:'text'}]}. LLM proposal {steps:[{column:'C2',recipe:{type:'text',steps:[{op:'trim'}]}}]}. The client attaches version/taskHash; full envelopes must match.
- `web/plan-core.mjs`, `web/plan-client.mjs`, `api/plan-gc.mjs`: encrypted v3 bundle, deterministic typed recipes, fresh labels/nonces, only encrypted tasks leave the buyer.
- `web/agent-model-worker.mjs`: actual local LLM, public task only. No paid API or fake fallback. Any unsupported/invalid plan fails closed before job publication.

## Boundaries

This is a real agent with bounded confidential tools, not arbitrary semantic inference on encrypted documents. Unsupported operations must be reported rather than silently mapped to a different task. The trusted buyer browser necessarily reads its own file to encrypt/decrypt it. The planner/model and provider/evaluator do not get that plaintext. Preserve selected logo 19 and Gemini visual design; reuse existing form styles. Mainnet, paid services and private customer/credential uploads are not authorized. Research/source notes stay read-only; only own task downloads may be cleaned up.
