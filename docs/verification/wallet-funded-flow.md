# Wallet-funded escrow verification

The current application uses one shared **NEAR testnet** escrow contract,
`nope-wallet-44384e2f.testnet`. Its immutable code hash is
`6qzVqhNyk7KKvjzC6g8iPtJmHffTgb6YBh8Fp9xerXHy`; the FINAL access-key list
was independently checked empty. Customer payment liabilities are indexed by
`(buyer account, job ID)`. An unrelated customer cannot preempt that namespace,
withdraw its money, or substitute the payout address. A separately bootstrapped
storage/gas reserve is not a sponsor source for customer payments.

## Implemented flow

1. Customer and provider each connect a testnet wallet and sign a short-lived,
   one-use NEP-413 challenge bound to account, role, session, origin and callback.
   The API verifies the signature against a current FINAL FullAccess public key.
   The wallet's private key is never sent to NOPE.
2. The customer prepares the typed v4 encrypted task locally. Providers submit
   encrypted offers. The customer closes bidding, decrypts offers locally and
   selects the provider and amount. Final amount and recipient are public when
   funded; unselected offer amounts and CSV plaintext remain private.
3. The customer approves **their own wallet transaction** with the exact selected
   amount attached to `fund`. Input, program, plan, recipient, deadlines and buyer
   namespace are bound together. There is no server signer or new-job sponsor
   fallback. A wallet return alone does not count as finalized funding.
4. The application permits execution only after observing matching FINAL funded
   state. The selected provider executes the encrypted task and signs
   `record_delivery` for the exact output hash and delivery version. The contract
   also permits the buyer to recover recording without changing payment terms.
5. The customer checks the result locally and generates the actual typed-result
   SNARK. Browser and server verify it. Acceptance is explicit and binds the
   latest version/hash. The customer then signs `accept_and_release`.
6. The escrow transfers exactly that job's deposit to its selected provider.
   Finalized connected transfer/callback receipts are checked separately from
   the initial transaction. A lost response triggers observation, not automatic
   signing or rebroadcast.
7. After the review deadline, the original buyer can sign `refund`. An eligible
   refund returns to that buyer. Pending native transfers cannot be duplicated.
   Definitive transfer failure restores the liability; solvency checks still
   protect all other jobs.

## Evidence and boundaries

- `wallet-escrow-independent-deploy.json`: actual testnet deployment code,
  source-Wasm hash, same-block FINAL empty-key/config inspection.
- `wallet-funded-http-local.json`: actual isolated HTTP application lifecycle,
  genuine test-wallet NEP-413 signatures, encrypted offer, wallet funding,
  encrypted execution, delivery recording, real SNARK, explicit acceptance and
  provider payout. Synthetic one-row data and an authored plan were used;
  this is not a neural-planning or browser-popup signing test.
- `wallet-funded-http-production.json`: the same synthetic encrypted lifecycle
  completed through the deployed production HTTP API and real private Blob
  transport. Job `10b21c73ed75bfd8c47418524932d2bf` reached `PAID`.
  Funding `C6WTEy1oqwBozSStj8rvH5yhUhGPz1RDGYYr1JLuoDNQ`, recording
  `8oARvSGNRHthrqSdtwudTXPJT3TZPSYrh4mfh9rCwmer`, and payout
  `E3eT5ZHop3je6uMei6aoLTD7JdQJbNzUmnfrUHdHU1B1` were separately verified
  on NEAR testnet. An unauthenticated independent process verified the public
  SNARK and chain binding. This used generated test wallets, not a user's wallet.
  The same public job also passed actual Chrome browser verification: the UI
  showed the independently verified SNARK and FINAL `Paid` chain binding without
  loading the customer's CSV or private mapping. This is distinct from the
  uncompleted third-party wallet popup signing check.
- The first live smoke test caught the missing private-Blob wallet namespace.
  It was corrected with five narrowly bounded paths; the local HTTP harness now
  uses the real production adapter over a filesystem transport. A permanent
  HTTP/Blob regression covers authentication, all wallet namespaces and expired
  intent retirement. No funds were sent during the failed session attempt.
- Live Chrome also caught nonprimitive translated labels at the wallet SDK
  boundary. Labels are now explicitly serialized to strings; a strict runtime
  label-guard regression reproduces the original failure and passes the fix.
- `../../payments/wallet_escrow/verification/live-financial-checks.json`:
  actual public testnet exact provider payout and original-buyer refund. These
  direct financial tests do not themselves attest a computation proof.
- Contract SDK unit tests and a real local Wasm sandbox additionally cover
  failed native transfers/callbacks, concurrency, retries, namespace attacks and
  isolated liabilities. Local sandbox evidence is not public testnet evidence.
- Five-language UI state tests use explicitly synthetic adapters; they do not
  replace actual signing or public-chain tests. The bundled opaque wallet bridge
  was initialized in Chrome with the real SDK, without connecting or signing a
  user's wallet. Actual interactive third-party wallet popup signing remains a
  separate uncompleted acceptance check.

The bounded immutable contract accepts at most **1 testNEAR per job** and retains
at most **50 jobs permanently**. The current application proof-binding adapter separately requires a selected price of **0.000001–0.01 testNEAR**; the completed proof-backed workflow uses this narrower range, despite the contract accepting larger holds. It has no upgrade/admin withdrawal method and
does not verify SNARKs on-chain. The application proof gate and an independent
public verifier validate the typed result relative to precommitted buyer
mappings; they do not prove original CSV provenance or AES execution provenance.
Customer acceptance governs payout; automatic dispute arbitration is not
implemented. This is a testnet pilot, not a mainnet security certification.

Legacy sponsor/direct-transfer jobs are historical read-only records when this
wallet deployment is active. Their old transactions are not reclassified as
customer-wallet funding.
