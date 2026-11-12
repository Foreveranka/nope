# NOPE integration ownership and ZeroFi review — 12 November 2026

This is an implementation decision note, not a completed integration claim.

## Ownership
- Job/draft listing, authorized bidder roster, bid commitment submission, selection request, encrypted delivery registration and buyer acceptance endpoints are OUR application code. No third-party API key is intrinsically needed to implement these. Existing compute API is not a procurement API.
- Need authenticated buyer/provider identities, nonce/replay protection, persistent transactional job storage, authorized state transitions and idempotency. Wallet sign-in needs signature ownership verification and a session; NEAR RPC is used for finalized chain reads/writes, not as a substitute for application authorization.
- Compute has already been tested through the local Concrete client and Vercel evaluator. Plaintext and secret key stay in local memory; the four-record fixed profile is not arbitrary file processing.
- Private bid selection requires an actually independently operated MPC deployment with authenticated parties, reviewed corruption threshold, timeout and recovery policy. Existing local three-process run does not provide that independence. HTTP endpoints can run on Vercel; continuous native peer processes need suitable persistent hosts.
- Real NEAR Market settlement is external: authenticated principal/tool discovery, exact delivery/version acceptance semantics, reconciliation and auto-accept rules remain gates in payments/LIVE-GAPS.md. Internal job/bid endpoints must not wait for these or fake payment.

## ZeroFi evidence checked now
Sources: https://zerofi.io/about and https://github.com/Zerofi-io/znode . Reviewed about page and repository README/listing; NOT full implementation/security audit, NOT a running node. Correction after expanded search: a prior 11 November review exists at operators/ZEROFI-ARCHITECTURE.md, including a pinned whitepaper revision. The initial narrow search missed operators/. That prior review is architectural, not a code audit or deployed node network.
Official descriptions discuss bonded operators, threshold custody, certified ledger state and cluster membership/key resharing. Public node repository describes a Monero/Ethereum Sepolia bridge with an always-on Linux node and a local Monero daemon. These are project claims, not independently validated security properties.

## Applicability decision
Adapt the operator identity/roster, authenticated peer communication, durable operation journal, signed job-scoped receipts and recovery concepts. Use existing NEAR registry for job commitments/state instead of starting a separate blockchain or importing Monero bridge custody.
A quorum certificate proves agreement by the stated signers under its trust assumptions, not mathematical correctness of arbitrary FHE computation. Keep distinct: confidentiality (FHE/MPC), authorization/ordering (registry and signatures), execution correctness (local reference check today; independently verifiable proof/attestation is a separate unimplemented route). Slashing only for objectively verifiable offenses such as conflicting signed receipts, never unproven claims of incorrect secret computation.
NOPE needs its own node package and NEAR adapter. Running ZeroFi's bridge binary would not supply procurement, FHE verification or private bid selection. No native-code reuse/licensing/security conclusion beyond the README has been verified.
