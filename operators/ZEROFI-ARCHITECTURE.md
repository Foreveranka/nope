# ZeroFi architecture: custody is a separate problem from private computation

Read-only review, 2026-11-11. No software was installed or executed, no account
accessed, and no wallet, stake or token created. Public documentation was read;
this is not a source-code audit or a live-network verification.

ZeroFi describes a Monero/Ethereum bridge: bonded nodes share wallet authority
and authorize mint/burn-backed transfers. Its about page describes clusters of
20–50 members and threshold-held keys. Those are the project's architectural
claims, not independently demonstrated security guarantees.
[Official about page](https://zerofi.io/about)

The published whitepaper describes Shamir sharing and signing from the FROST
family (§5.1). It explicitly acknowledges a colluding signing threshold could
spend custody or authorize an unbacked batch, and that slashing does not prove
Monero facts (§8.2). Thus absence of a single administrator key still leaves
threshold-collusion and liveness assumptions.
[Official whitepaper, pinned revision](https://github.com/Zerofi-io/znode/blob/c753c563195bec26c91a92f48057a9a5857b5700/docs/whitepaper.md)

**Threshold signing** authorizes a transaction under a shared key. Our
**malicious SPDZ2k computation** operates on secret-shared amounts, validates
commitments, compares eligibility and returns private auction outputs; it is
not a custody wallet or threshold transaction signer. Sharing secrets is common
to both ideas, but their protocols, thresholds, leakage, abort conditions and
security guarantees are not interchangeable. This comparison follows from
ZeroFi's documented signing role and our local
[MPC implementation](../mpc/README.md); it does not establish that either system
verifies the other's results.

The `znode` README explicitly calls this a **testnet bridge to Ethereum
Sepolia**, despite the broader Ethereum framing on the website. It requires
one Monero daemon per node, a bonded funded node key and server provisioning;
its join procedure installs services and submits staking transactions. Its
Monero daemon follows the Monero main chain, so “testnet bridge” must not be
read as “all assets are test coins.” The visible repository supplies release
instructions, documentation and licenses; that is not evidence of a reviewed
full implementation or production deployment.
[Official node repository](https://github.com/Zerofi-io/znode),
[README at inspected revision](https://github.com/Zerofi-io/znode/blob/c753c563195bec26c91a92f48057a9a5857b5700/README.md)

**Implication for this project:** the NEAR registry and off-chain FHE/MPC compute
layer need independent compute operators, authenticated participants, pinned
builds and a correct registry lifecycle. They do not require an owned Monero
bridge or `monerod`. Monero custody only becomes a separate requirement if a
future product explicitly accepts and settles XMR. Adding it now would introduce
custody, cross-chain finality, liquidity and operational obligations without
solving SPDZ correctness, operator independence or NEAR execution binding.
This is an architectural inference, not an assertion about ZeroFi integration
support. See [our deployment prerequisites](README.md) and
[remaining integration sequence](../docs/NEXT-INTEGRATION.md).

Inspected repository HEAD resolved through the public GitHub API to
`c753c563195bec26c91a92f48057a9a5857b5700` (committer timestamp
2026-10-13T19:30:05Z). Website claims and public code availability can change.
No explorer, reserves, contract immutability, threshold implementation or
performance claims were independently verified in this review.
