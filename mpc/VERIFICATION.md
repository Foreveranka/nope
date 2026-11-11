# Actual verification — 11 November 2026

Outcome: implemented and verified **locally**, including the TLS identity fix.
All changes, dependencies and test output remain within `mpc/`.

## V2 precommit/Closed-selection extension

The v1 codec/circuit remains separate. The new versioned intent has no registry
job/attempt/root or commitment dependency. Its commitments use the binary intent
SHA-256. Selection binds the actual re-encoded Closed job, complete bidset, and
precommitted selection-round nonce, before any execution attempt exists. The
orchestrator callable is `mpc.run_v2.run_prepared`; see [V2.md](V2.md).

Current codec source/circuit checks:

- `python3 -m unittest discover -s mpc/tests -v`: **24/24 passed**, including all
  previous v1/wire/cleanup checks. V2 adds independent binary intent/commitment
  vectors, independent registry Borsh comparison, mutations of every intent and
  config binding, missing/reordered/extra bid rejection, preselection state and
  new paired executor/version null-field checks, strict version dispatch, and
  duplicate/nonfinite public JSON rejection. Log: `evidence/v2-unit-tests.log`.
- `python3 -m mpc.verify_v2`: **4/4 actual malicious SPDZ2k cases passed**. Good
  inputs produced buyer `[1,2,80,80]` and providers `[[0,0],[1,80],[0,0]]`. Changed
  private bid and changed private budget (unaltered public commitments) caused
  `invalid sealed input` in every party log. Client C3 supplying a different
  otherwise valid Closed manifest caused `manifest context mismatch` in every
  party log. No generic timeout, build failure or TLS failure counted as proof
  of rejection. Every case removed private fixture keys and party data. Logs and
  identities: `evidence/v2-runtime-results.json`, `evidence/v2-runtime-run.log`.
- Final client-loader smoke `python3 -m mpc.sample_v2 --run`: passed again with
  buyer `[1,2,80,80]`, unchanged circuit identity and all transient keys removed;
  `evidence/v2-final-client-smoke.log`.
- `python3 -m mpc.run_local --case cheapest`: actual **v1 baseline passed** after
  factoring the common launcher; `evidence/v2-v1-regression.log`.
- `python3 -m mpc.verify_tls`: all **five actual native-class TLS cases passed**
  again, including the trusted-CA C0 forgery precondition and exact-leaf rejection;
  `evidence/v2-tls-regression.log`, refreshed `evidence/tls-results.json`.

V2 circuit source SHA-256:
`2366fe6cd6a01c7d7eacc37053b05109b1ed9363e17cf889941281decdd8760d`.
The successful regression compiled in **11.5486 s** and ran in **13.5617 s** on
this concurrently used host. Its native VM reported **12.2591 s**, **1758.4 MB**
global data and approximately **58,765** party-0 communication rounds. These
are local synthetic measurements, not WAN estimates. First v2 smoke compilation
and runtime were 10.1816/6.8237 s; the difference is not a performance guarantee.

Registry re-encoding checks match the independent reference encoder. These v2
regressions use **fabricated registry metadata**, not a native sandbox or a live
chain. The parent orchestrator owns actual sandbox integration. This module
returns `registryCodecBindingVerified:true` but preserves
`chainFinalityVerified:false`, `durableSelectionReplayGuard:false`, and
`independentOperators:false`. No funds, external accounts or deployment.

The remaining sections preserve earlier v1 measurements and their stated bounds.

## Build and arithmetic

Pinned upstream: `cd4d517a8a37b266d7233ae412717ca181cec6bf`. Actual compiler,
ExternalIO, SPDZ2k, SHA-256, TLS and MAC-check APIs inspected. Final circuit SHA:
`b5c0ea99ab200cee2c6653d683786b4a6f810880126ae165db425b46746089f0`.

`python3 mpc/bootstrap.py --jobs 2` completed the ARM64 native build, including
the leaf-pinning rebuild. SoftSpokenOT/libOTe and real live malicious
preprocessing; ring/MAC-security **64/64**, statistical security **40**. No
`INSECURE`, KOS override, fake offline data, semi-honest or unencrypted mode.
Existing GMP/OpenSSL read only; Boost/libsodium/CMake installed locally.
libsodium upstream tests: **80/80** passed. At most two compile jobs, one for
heavy runtime units. Targeted dependency warning exceptions retain warnings;
cryptographic checks were not weakened. Dependencies approximately **1.21 GB**.

Build/toolchain/dependency identities: `evidence/native-build.json`. Final:

| Artifact | SHA-256 |
| --- | --- |
| spdz2k-party.x | `a99f6a0a96d9fb6b500703dc14e797fa2286270a861d2bc9dd5d86b5200719e1` |
| libSPDZ.so | `dc6cb490c62dfc8f28bf75d7a87d58af124508917ba3192a431945d1566e1cbd` |
| CONFIG.mine | `7b613261537214e2ad34af8096dc666b254dfb83a9316d2e973653735a48d406` |
| transport patch | `b78b781aba98dc632c4af1618e8631cc9684b701bc7c0d7b762e909b3d508f6c` |

The launcher checks all four, including the loaded shared library. Future run
records include binary, library, config and patch hashes.

`python3 mpc/verify_runtime.py` passed **11 final-circuit cases before the
transport-only rebuild**: eight output matches (cheapest, tie, no-award,
exact-budget/fixed-fee, unqualified cheapest, all unqualified, maximum, zero
budget), and three global rejections (wrong commitment, negative/excessive input
mutations). All buyer/provider outputs were compared; successful results require
three genuine party and four client exits. Rejections require `invalid sealed
input` in all three party logs and key removal. Negative/excessive mutations
also break the original commitment; these are combined rejection tests, not
isolated malicious range-proof tests. Public-false selection was fixed to retain
`sint` type; every excluded slot still gets full input/commitment validation.

Preserved pre-transport evidence: `evidence/pre-transport-runtime-results.json`,
`pre-transport-native-build.json`, `runtime-run-final.log`. Earlier source-hash
results are preserved but do not verify the final circuit. The 11 cases are not
claimed as testing the newer native transport binary.

After the transport rebuild/offline-CA fixture fix:

```sh
python3 mpc/verify_runtime.py --cases cheapest wrong-commitment --timeout 600
```

**Both passed** under the final binary: buyer `[1,2,80,80]`, providers
`[[0,0],[1,80],[0,0]]`; wrong commitment rejected on all three parties, keys
removed. Baseline runtime phase **7.05528 s**, compile **10.16512 s**. See
`runtime-run-post-transport.log` and the `peer-leaf-pin-v1` records in
`runtime-results.json`. No further broad arithmetic testing was performed.

## TLS finding: fixed and exercised

Broken boundary: globally configured `CA:TRUE` participant certificates plus
chain/hostname-only checks allowed C0 to certify a forged C1 identity. The
narrow shared fix in `Networking/ssl_sockets.h` requires normal chain/hostname
success AND exact canonical DER equality to `SSL_DIR/<expected-peer>.pem`, plus
a mandatory client certificate. Both native TLS roles use this class; callers
include external clients and both CryptoPlayer directions. Numeric P/C IDs form
peer filenames. Intermediate-chain checks remain required; depth-zero leaves
must match. A separate source review pass checked those callers and both branch
outcomes; no independent review-agent tool was available.

Fixtures now issue seven `CA:FALSE` leaves with SAN/KU/EKU from a unique offline
session CA; only its public root is trusted by clients. The CA key is removed
before party launch. LibreSSL 2.8.3 rejected direct non-CA leaf trust, while
OpenSSL 3/native control accepted the exact same loaded/trusted server DER.
`tls-direct-leaf-diagnosis.json` retains that evidence and public certificates;
CLI shutdown exit 1 is not treated as authentication success by itself: the
native server returned 0 and delivered `ACCEPTED`. No verification disabling or
partial-chain workaround was used.

`python3 mpc/verify_tls.py`: **5/5 passed against the actual patched MP-SPDZ
ssl_socket class**, not a duplicate Python certificate verifier:

| Case | Actual native result |
| --- | --- |
| Correct C1 certificate | Accepted, exit 0 |
| C0 certificate claiming C1 | Rejected, exit 1 |
| Absent client certificate | Rejected, exit 1 |
| Untrusted same-name C1 | Rejected, exit 1 |
| Forged C1 signed by trusted CA-capable C0 | Rejected, exit 1 |

The last attack fixture deliberately restores C0 `CA:TRUE`, proves
`openssl verify -CAfile C0.pem -verify_hostname C1 fake.pem` returns **0/OK**, then
observes native rejection. Thus CA:FALSE alone did not make the pin test pass.
Legitimate behavior remains intact in both the accepted native control and the
full post-patch three-party auction. Every TLS fixture key was removed. Sessions,
precondition and native hashes are in `evidence/tls-results.json`.

## Cleanup, failures and costs

`python3 -m unittest discover -s mpc/tests -v`: **12/12 passed**. Three targeted
cleanup regressions prove transient signal `PermissionError` still reaps/removes
keys, certificate setup failure removes generation/moved keys, and an unreaped
owned child raises while key deletion still runs. Cleanup uses only Popen-owned
children with bounded waits/terminate/kill. Generation is cleanup-protected.

`runtime-run-initial.log` preserves the first wrong-commitment cleanup error;
its fixture keys were explicitly removed, then the corrected test passed.
`runtime-run-selected-first.log` preserves the old unqualified compiler failure.
Failed attempts are not counted as passed tests. Public diagnosis certificates
contain no private keys. `evidence/cleanup-audit.json` records residual checks.

First pre-transport successful run: VM **6.09568 s including preprocessing**,
runtime phase **8.45522 s**, compile **9.85701 s**, party-0 sent **587.142 MB**,
global sent **1758.4 MB**, about **58,765 party-0 communication rounds**. Only
three prices plus budget, with four SHA-256 checks; settings 64/64 and statistical
40. Compiler resources: 186,659 bit triples, 1,346 integer triples, 4,717 daBits.
This substantial local overhead does **not** establish WAN feasibility. No
protocol optimization was applied during verification.

Still unsupported/unverified: independent operators/PKI, malicious operator
triple/MAC injection, selective abort/fairness, durable replay/admission/rollback,
3/3 signed receipts/output commitments, live NEAR registry identity/snapshot
provenance/finality, funds/settlement, WAN performance and full side-channel/core-dump
analysis. The v1 descriptor/commitment versus registry budget/root dependency
remains a v1 integration limitation; the separate v2 codec resolves that circular
ordering for local synthetic selection without proving chain provenance or
authorizing repeated runs. No deployment, real payment or private customer input.
