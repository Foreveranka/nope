# Public no-install CSV processing

The active public `/csv` workflow uses single-use garbled circuits (`nope-csv-gc-v1`), not Concrete FHE or the earlier additive-sum example. The older Python FHE workflow is retained separately in the companion `/csv-local` route. Nothing silently uploads plaintext to a hosted Python client.

## Exact flow and privacy boundary

The browser parses a <=64KiB CSV, 1–32 rows/<=16 columns, selects a column containing empty or canonical integers0..254. Only this column is encoded (empty255), other cells and filename remain browser-side. An isolated Web Worker creates fresh random128-bit wire-label pairs, with random opposite permutation bits and no global delta. Every fixed Boolean gate has an ordinary full garbled table, AES-256-GCM with a fresh random96-bit IV. Keys derive from SHA-256 over protocol domain, row/gate indices, random128-bit job nonce and ordered input labels. No XOR key-combination, free-XOR, half-gates or label recycling. All inputs belong to the browser, so no evaluator input transfer/OT is part of this protocol.

`POST /api/csv-gc` contains only profile/nonce/rowCount/encoded input labels/garbled tables. It never contains CSV/name/column name/plain values/output decoder. Server reconstructs fixed68-gate topology per row and authenticates/decrypts exactly one table entry per gate. It returns encoded output labels and canonical input/output/program SHA-256 hashes. Browser checks context/hash binding, label membership, decodes locally and compares with local rule before producing a CSV. The server cannot interpret output labels without the retained mapping under the prototype assumptions. Table topology, row count, timing and IP are visible.

The fixed function is empty255→0, else min(value,100). No arbitrary LLM execution, free-text CSV processing, duplicate detection or general-purpose private agent claim. Malformed/non-numeric columns are disabled, first supported numeric column selected automatically. No client installation, invitation or wallet is required for this workflow.

## Threat model and evidence

Assume an honest browser/garbler and authenticated application delivery, secure WebCrypto/CSPRNG, and privacy against the evaluator under standard garbling/PRF-style assumptions. This custom implementation has not undergone a formal proof or external cryptographic audit. The site operator could deliver malicious JS; compromised browser/OS can see plaintext before encoding. Topology validation cannot verify encrypted truth-table semantics; honest client garbling is required. Corrupt active ciphertext/tag, wrong context and invalid output membership fail closed; this is not a general malicious-secure two-party-computation claim.

Downloadable evidence includes canonical public manifest plus the exact evaluator-view transcript (encoded input, encrypted tables and output labels), NEVER decoder pairs. `/verify` recalculates hashes and reruns the garbled transcript in a separate browser Worker. Matching replay checks that this transcript gives the reported encoded output; it does not certify hidden table semantics, original plaintext, non-observation or time/provenance. An explicit NEAR testnet manifest anchor adds integrity/time/account attribution only. Ordinary public calls are not automatically signed by the project's wallet, and missing chain records are reported as missing.

Basis: Bellare, Hoang, Rogaway, *Foundations of Garbled Circuits*, CCS2012, https://doi.org/10.1145/2382196.2382279 ; authors' paper collection https://web.cs.ucdavis.edu/~rogaway/papers/gc.html . These references describe the underlying notion; they are not audits or endorsements of this implementation.

## Verification

Separate read-only engineering review found no concrete blocking crypto flaw under the stated assumptions: fresh labels, ordered derivation, nonce/row/gate separation, no decoder transmission, all256byte inputs, active corruption and cross-job rejection. Formal proof, side channels and malicious code delivery are outside that review. Actual Node HTTP and browser Worker calls execute the cryptographic gates; no plaintext fallback or precomputed output is used. The browser's reference computation is an additional result check.

Actual local-browser file selection auto-selected `score` and disabled text columns. Four values processed through real HTTP, decoded/exported in0.12s (local machine only; not a performance guarantee). Downloaded evidence replay matched in the browser. Live production checks follow deployment.

Build70349ca deployed READY on production. Public `/csv` no longer requests a loopback client, invitation, local installation or evaluation-mode selection. CSV file parsing/encoding/export is in the browser. Public endpoint is stateless and uses only fixed shared topology. Root landing was updated to identify garbled circuits rather than imply this workflow uses Concrete.

Production browser verification: selected a real4-row,3-column synthetic CSV on https://veil-procurement.vercel.app/csv, auto-selectedscore, sent one real public GC request and completed in1.42s (device/network-specific). Downloaded CSV independently parsed: nonselected cells/quoted comma/order preserved, scores0/100/42/5. Downloaded evaluator-view transcript independently replayed through Node evaluator; canonical program/input/output hashes matched. Actual manifest was anchored on NEAR testnet in tx CofBRG3gQeHoUgHJ1JZhKyHD8rZgXLouHfBgzjfTj5qp . Sourcepublicbundle: docs/verification/csv-browser-proof.json, served at /csv-proof.json. This example is explicitly a prior recorded run; future visitor jobs are not automatically anchored or claimed private/proven by this transaction.
