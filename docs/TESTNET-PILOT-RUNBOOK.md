# NOPE — actual pilot interfaces

This document describes implemented interfaces, not a claim that independent
operator infrastructure or a general-purpose marketplace is deployed.

## Customer and provider entry

- Hosted landing: `/`; role-separated application: `/market`; existing encrypted
  evaluation client onboarding: `/app`; recorded testnet evidence: `/testnet`.
- Access is by expiring, role-scoped invitation, not a NEAR wallet signature login.
  Private invitation files live under ignored `runtime/procurement-invitations/`.
  Never upload that directory, include tokens in URLs, or commit it.
- A buyer selects three invited providers and deadlines and creates a draft.
  The hosted API stores public job metadata in private Vercel Blob. An unpublished
  draft is visible only to its buyer. After publication, the invited providers
  can see the job and commitment hashes, never the price/budget openings.
- The downloaded Python companion runs on loopback with exact-origin and CSRF
  checks. In its `/market`, the buyer prepares the fixed four-record synthetic
  encrypted input and budget commitment. Its secret key remains in RAM.
- Providers prepare their prices in their own companion. A fresh random opening
  stays in local RAM; only the 32-byte commitment reaches the cloud. Public local
  session recovery handles a lost HTTP response without changing the opening.
  Closing the companion loses the opening; this is not recoverable key custody.
- Closing the bidding period freezes the three submitted commitments. It does
  not fabricate a winner. Private input execution requires an authenticated,
  server-configured operator plan, transport and certificates. Without those,
  execution refuses rather than transmitting prices to a central selector.

## Actual chain integration

`integration/testnet.py` and
`contracts/registry/deploy/procurement-driver.mjs` run a **separate synthetic
integration** on the real NEAR testnet. This does not automatically bind an app
ledger draft to the blockchain. The driver uses three distinct provider accounts
under one administrator, journals each signed transaction before broadcasting,
waits for FINAL, and checks registry state bindings.

The integration prepares actual FHE ciphertext before registering commitments,
submits provider commitments, waits for actual chain deadlines, runs actual local
three-party MPC, records the selected executor, evaluates ciphertext, performs
local decryption/reference verification, submits the exact ciphertext receipt,
and accepts that receipt. It never treats the operator signatures as a computation
proof. Synthetic prices/budget are centrally known test fixtures in this run.

## Payment boundary

The dedicated native-test-NEAR escrow is separate from NEAR Market. Official
Market documentation did not establish a usable sandbox; production USDC/credits
are not used as test tokens. See `TESTNET-PAYMENT-DECISION.md` for the current
build/deployment/verification status and public transaction evidence.

Funding, registry acceptance and payout are separate chain actions. A verified
payout requires a finalized native Transfer receipt with exact provider/amount,
not just a success flag. Escrow verifies receipt binding and buyer acceptance;
it does not prove that its public payment amount equals a hidden MPC winning bid.
A small fixed synthetic test payment demonstrates the rail only. All payment
amounts are public, and the escrow's upgrade authority is trusted.

## Not solved by a URL or API token

Independent MPC operation requires separately administered persistent native
processes, authenticated peer and external-client transports, per-party keys,
state isolation and recovery testing. Three accounts or three processes on this
computer do not provide that independence. The remote network profile and node
package record concrete endpoints and certificate pins, not a claim that hosts
have been provisioned. Ordinary Vercel HTTP routes store metadata and dispatch
FHE work; they are not persistent native MPC peer listeners.

The current data profile is four byte-valued id/value records, not arbitrary CSV.
The buyer's reference check is not a third-party-verifiable execution proof.
No customer plaintext, wallet secrets or invitation tokens enter deployment bundles.
