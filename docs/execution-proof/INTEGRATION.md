# NOPE v4 result-proof integration

14 November 2026. Buyer-local public-brief planning, encrypted typed execution, customer-wallet-funded NEAR testnet escrow and independent result-SNARK verification are connected in the source. Actual browser/deployment evidence is recorded separately; source implementation is not deployment evidence.

## Customer and provider flow

The buyer chooses a CSV locally, selects anonymous column aliases/types and writes a public goal. A pinned local browser LLM receives only that goal and anonymous schema. It proposes an ordered typed plan. Before/after values remain buyer-local and require explicit approval; the LLM is not an infallible semantic validator.

For a new v4 job, the browser creates fresh GC labels and commits to ordered private input/output mappings before publication. Only the encrypted task, public plan, selected-label commitments and binding metadata leave the buyer. The private decoder, alternative label pairs, salts and original CSV are held by the encrypted local vault. The v4 client does not silently downgrade when preparation fails.

Providers submit hybrid RSA/AES-encrypted offers. The buyer opens them after closure and selects a provider. Selection publishes the provider and selected price. Both roles first verify their testnet account with a NEP-413 wallet signature. The customer signs the exact deposit into `nope-wallet-44384e2f.testnet`; the server creates bounded intents and observes FINAL state without signing. The contract tracks independent liabilities by buyer account and job ID. Other bid contents remain encrypted. Wallet private keys stay in the wallets.

Once funding is FINAL, the selected provider can trigger real deterministic GC evaluation. The provider signs recording of the exact delivery version/hash on NEAR; buyer recording is also supported by the contract for recovery. The buyer decodes and compares the actual result locally, then produces a real Noir/UltraHonk proof per processed cell in a dedicated local worker. All ordered cells are required. The browser independently verifies the bundle before submitting it. The server derives the expected statement from its stored request and exact current delivery and independently verifies every proof again.

Acceptance and release reject missing, stale, partial, altered or context-mismatched proofs. The stored proof is reverified at both gates, rather than trusting a cached VERIFIED flag. A revision invalidates prior proof metadata. The customer explicitly signs release after application proof verification and acceptance. A successful exact native transfer and nonce-bound callback are required before PAID. After the review deadline the original customer can sign a refund to their own account, never to a sponsor pool. Silence never accepts delivery, signs release or initiates a refund.

## Public verification

`/verify?id=<jobId>` obtains the public ciphertext transcript and proof without a buyer session or witness. It independently checks the requested job ID, fixed testnet contract/code hash, same finalized block, empty contract access-key list, buyer/job namespace and exact escrow terms and current delivery through the configured public RPC. It then reconstructs all expected proof signals and runs the pinned actual SNARK verifier locally. A server-reported success flag is insufficient. This is RPC-backed verification, not a light client. Payment receipts are a distinct check.

## Exact proof boundary

The proof establishes that delivered labels encode the approved typed function of the selected input labels under the client's precommitted ordered mappings, assuming honest client setup and the proof/commitment/SRS assumptions. It does not establish original-file provenance, honest garbling, LLM intent correctness, provider execution origin, an AES execution trace, independent operators or on-chain SNARK verification. The current contract authenticates the commitment and delivery; the browser/server run SNARK verification. The backend authorizes application decisions and validates chain state, but it has no signing/relay authority for new wallet jobs. Customer acceptance is still a trust boundary; the contract does not cryptographically adjudicate the result. These boundaries must remain visible.

## Supported scope and resources

Numeric fill/clamp uses byte-domain values and a missing sentinel; text supports ordered trim/case/digit-redaction over at most16 tagged ASCII bytes. At most4 selected columns,32 numeric rows,8 text rows,40 processed-cell proofs, the existing10k gate cap and encrypted-request bounds. The proof bundle is capped below1MiB to leave room for its immutable Blob envelope. Other columns are preserved locally. Unicode text transformation, unbounded CSV cleaning and arbitrary semantic AI are unsupported rather than disclosed to a normal AI API.

The browser requires no installer, hosted prover, paid API or third-party runtime code. Same-origin hash-checked WASM, circuits, verification keys and public universal SRS are packaged by a14-file allowlist. Private runtime/state files and generated witness fixtures are excluded. The existing self/wasm CSP is preserved; only the fixed testnet RPC is an added connection destination.

## Validation

The root suite passed409 tests, including an actual mixed numeric/text SNARK workspace test with explicitly mocked storage/payment fixtures. It checks proof gates and revision/replay rejection; it is not real-chain evidence. Three focused independent-public-verifier tests pass with explicit RPC fixtures. SDK tests additionally exercise actual independent-process proof verification and constraint failures. Read the actual browser and testnet evidence JSON files for checks that truly ran outside fixtures.

## Current wallet-funded deployment checks

[Current evidence](../verification/wallet-funded-http-production.json) records actual production HTTP job `10b21c73ed75bfd8c47418524932d2bf`: generated test-wallet NEP-413 signatures, sealed bid, exact buyer funding, encrypted execution, one actual result proof, explicit acceptance and native provider payout. A separate unauthenticated process and live Chrome independently verified its public proof and FINAL Paid binding. This run used a deliberately authored plan; it is not a neural-planning or external wallet-popup signing test. The real Chrome wallet picker/cancel was checked separately; signing inside Intear remains unverified end to end.

The contract caps an individual hold at 1 testNEAR and 50 permanently retained jobs. The current proof-binding adapter separately accepts selected prices from 10^18 through 10^22 yoctoNEAR (0.000001–0.01 testNEAR). The complete application proof workflow must stay in that narrower range. See [wallet-funded integration](../verification/wallet-funded-flow.md) and [contract protocol](../../payments/wallet_escrow/README.md).

## Historical sponsor-funded deployment checks

Commit361389c deployed READY as dpl_5a9gwq19U1WnL6dFwaQF87UrSk9e. Actual production HTTP job558a4098ab50abba0501d4cd32760cd3 completed sealed offer, FINAL hold, real GC evaluation, local decode, six actual SNARKs, server verification, acceptance and FINAL native payout. The proposal was reused from a prior actual model run; this HTTP test did not perform browser inference. An actual production Chrome public verifier independently checked all six SNARKs and real RPC bindings without buyer witness. The separate Python observer checked the completed native transfer/callback and Paid state. These are real checks, not RPC/payment fixtures. See the production JSON records; the source-identical documentation follow-up does not require spending more test tokens.
