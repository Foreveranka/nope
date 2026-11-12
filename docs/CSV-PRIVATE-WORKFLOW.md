# CSV private workflow — 12 November 2026

CSV UI `/csv` reads UTF-8 CSV locally, accepts comma/semicolon quoting, 1–32 rows and <=16 columns/64KiB. User selects one integer column, values0..254 or empty (encoded255). All other cells and filename stay in browser; empty->0, >100->100, row order preserved, duplicate removal unsupported. Formula-like cells are rejected explicitly. Local HTTP receives only selected values and evaluation mode. Secret keys, plaintext and results remain customer-client memory, not application logs or persisted jobs. Concrete encrypts batches of4 with padding, evaluates in a separate process or configured remote HTTPS worker, locally decrypts and reference-checks. The browser independently compares final values before exporting CSV. No arbitrary LLM/code execution on encrypted files is claimed.

## Installation

Download `/nope-client.zip`, extract it and run `sh Start-NOPE.command` (or install then `.venv/bin/python scripts/client-launch.py`). Python3.9–3.12, macOS/Linux are required. It opens `/csv` at127.0.0.1. Local mode needs no invitation. Remote mode requires a scoped compute invitation via `--cloud` or `--invitation-file`; no credential is bundled in the download. Hosted page can preview CSV but does not send plaintext to a hosted server. No cloud auto-fallback.

## Evidence layers

1. Genuine engine result hashes bind encrypted input, approved circuit/client-spec, public evaluation key, encrypted output and receipt per batch. No plaintext hash/filename is included. Evaluation keys are temporary; secret keys are not serialized.
2. A canonical JSON manifest is hashed as exact UTF-8 bytes. This manifest is downloadable with `privacyProof:false`. The user can recompute SHA-256; ciphertext possession is required to check a ciphertext's digest independently.
3. An explicitly configured owner client can record that digest and counts in a separate append-only NEAR testnet contract. Ordinary downloaded clients contain no project signer and cannot trigger project-wallet spending. `/verify` recomputes the manifest digest and reads the pinned contract/code via finalized RPC.
4. A hash anchor is integrity/time/account attribution. It does NOT prove execution, absence of observation, correct client software, key custody, or independently administered operators. FHE confidentiality relies on cryptographic assumptions and the actual client/evaluator boundary. A malicious site/client/OS can exfiltrate plaintext before encryption; an unaudited prototype cannot assert protection against that.

The existing proof contract is separate from registry/escrow, so an anchor does not imply an auction, acceptance or payment occurred. No real-money action is part of this CSV workflow.

## Actual verification

Main ran 5 numeric values through two genuine native encrypted batches: verified output[0,100,42,5,100],70.8523seconds. Separate actual browser selected a four-row three-column CSV, parsed a quoted comma, selected `score`, executed genuine FHE and enabled CSV download. A key-order-sensitive frontend evidence comparison was caught during development; fixed structural comparison is covered by regression test. Final bundle/anchor/browser checks are recorded below after completion.

Final main checks: 166 Node tests, 30 targeted Python tests (one opt-in native test skipped in default suite), separate actual two-batch native FHE, actual remote FHE192.8436s. Native key generation/decryption stay in customer process; remote transport accepts only encrypted artifacts and fixed public manifests. Actual browser-exported CSV was read independently: nonselected cells including quoted comma preserved; score empty/144/42/5 became0/100/42/5. Companion ZIP CRC passed and extracted package imports with owner anchor disabled. Contract:14Rust+3CLI tests, deployed Wasm byte-identical via independent RPC,0accesskeys. Remote CSV manifest transaction: 5Fxw6RJBz9aTSo8BXqTYwgn6v3gBH6w1Wzm5B9KztSXU

The remote grant used for verification is local/private and is not bundled. Public users can install/use local evaluator without a grant; a remote compute invitation remains necessary for the hosted evaluator. Owner-managed anchoring is opt-in and absent from ordinary customer ZIP. Do not imply every visitor has project-wallet signing access or automatic on-chain recording.

Final browser run additionally completed evidence download and clicked the actual owner-only testnet anchor button. Downloaded CSV independently parsed with Python; downloaded proof JSON digest was independently compared with finalized contract state through the new public API handler:4rows,1batch,block277361512. Remote proof example is published at `/csv-proof.json`; `/verify` can verify either bundle. Neither frontend claims that anchoring proves non-observation or general execution correctness.
