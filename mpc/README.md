# Sealed procurement MPC — local native prototype

This directory is separate from the single-key FHE application. It implements
exactly **three bid slots** and **three MP-SPDZ malicious SPDZ2k computing
parties**, plus four external clients (buyer C0 and bidders C1–C3). There is no
auction decryption key. Live OT preprocessing, authenticated shares, comparisons,
SHA-256 input checks and private external outputs execute in MP-SPDZ, not in the
Python reference oracle.

**Use synthetic inputs only.** `run_local.py` is a test harness that knows all
fixture inputs and launches every process under the same macOS user. This is
not an independent-operator deployment or a service API for real sealed bids.
See [VERIFICATION.md](VERIFICATION.md) and `evidence/` for actual completed checks
and remaining gates; source compilation alone is not runtime verification.

## V2 orchestration (separate from v1 below)

See [V2.md](V2.md) for the implemented immutable precommit intent → Closed job
selection manifest → actual local MPC API. Import `mpc.run_v2.run_prepared` for
synthetic orchestration; `mpc.sample_v2` is an importable preparation/run example.
Selection binds the closed job hash, full bidset and precommitted selection round;
it does not fabricate an execution attempt before the winner. The v1 descriptor
and commitment semantics described below are retained unchanged.

## Run

From the repository root, on the supplied Apple Silicon host:

```sh
python3 mpc/bootstrap.py --jobs 2
python3 -m unittest discover -s mpc/tests -v
python3 mpc/verify_tls.py
python3 mpc/run_local.py --case cheapest
python3 mpc/verify_runtime.py --cases tie no-award exact-budget unqualified max wrong-commitment
```

`verify_runtime.py` with no `--cases` runs every fixture, including zero budget,
all unqualified and malformed accepted inputs. It never falls back to an oracle,
emulator, another protocol, fake offline material or insecure build. Each run
gets fresh identities, a new attempt and live preprocessing; it deletes private
keys and party data on completion/abort. Public manifests and protocol/compiler
logs remain in ignored `runtime/`. The synthetic reference comparison runs only
after all parties and clients complete successfully.

The bootstrap uses existing `/opt/homebrew/opt/gmp` and `openssl@3` read-only;
Boost 1.86.0, libsodium 1.0.20 and CMake 3.31.10 are installed locally. Build
parallelism is at most two; the large SPDZ2k translation units use `make -j1`.
No `brew install`, Docker, global pip install, credentials or deployment.
Release archives are checked against the pinned SHA-256 values in `bootstrap.py`.
The dependency footprint gate is 2 GB, with Boost release sources removed after
installation. No sample or generated private key is tracked.

## Fixed semantics

Prices are integer microunits, **1 ≤ price ≤ 10¹²**. Secret budget is **0 ≤ budget
≤ 10¹²**. Public fixed buyer fee is **0 ≤ fee ≤ 10¹²**, equal for every bidder.
Eligibility is public roster qualification AND `price + fee <= budget`.
Choose the lowest eligible price; ties choose the lowest slot (C1 before C2
before C3). The winner receives its own price (first-price procurement). No
currency conversion, floats, percentage fee, funds custody or real payment.
This does not prove that funds exist or that a supplier meets commercial quality.

Every fixed slot supplies an input. A missing slot causes timeout/abort; malformed
accepted input aborts the entire computation. No omitted-slot padding or
deadline admission protocol is implemented. Unqualified bidders still have
their input validity and commitment checked. A normal price above budget yields
NO_AWARD if no other qualified price fits; it is not malformed input.

Buyer output is `[awarded, winnerClientId, price, pricePlusFee]`, with winner ID
1–3, and `[0,0,0,0]` for NO_AWARD. Each bidder gets `[win, ownPriceIfWin]`; a
loser receives `[0,0]`, including when nobody wins. Operators receive no public
winner, price, budget or reason-specific ineligibility output. One public
validity bit is deliberately opened to implement generic global input abort.
Upstream private-output/conversion routines also open masked random values.

The arithmetic circuit decomposes each amount over the **full 64-bit ring**
before constructing its low 40 bits and checking all upper bits and range.
Only then does it compare bounded amounts. `price+fee <= 2*10¹² < 2⁴¹`, so
signed comparisons with the circuit's 42-bit integer setting do not overflow.
Negative and excessive uint64 representatives are invalid. The client codec
rejects booleans, floats, negative values and integers beyond the profile range
before ring conversion. Ring elements are modulo 2⁶⁴: the circuit cannot
distinguish an external mathematical integer `p+2⁶⁴` from its residue `p`.
An eventual signed-offer adapter must use this canonical uint64 codec, not sign
an arbitrary integer and silently reduce it.

### Measured local cost

First successful, pre-transport-patch `cheapest` execution on this M2 host, three operators and four
clients on loopback, with real live preprocessing and all four SHA-256 input
checks (budget plus three prices):

| Measurement | Observed |
| --- | ---: |
| SPDZ2k ring / MAC-security parameter | 64 / 64 bits |
| Statistical security setting | 40 bits |
| VM time, including preprocessing | 6.09568 s |
| Harness runtime phase, including startup/client I/O/exits | 8.45522 s |
| Source compilation | 9.85701 s |
| Party 0 bytes sent, as reported by MP-SPDZ | 587.142 MB |
| All-party bytes sent, as reported by MP-SPDZ | 1758.4 MB |
| Party 0 communication rounds, as reported by MP-SPDZ | approximately 58,765 |

These are a single synthetic local run, not a WAN latency, throughput or
independent-operator benchmark. The runtime phase excludes source compilation
and certificate generation. This small three-price circuit incurs substantial
SHA-256/conversion/preprocessing traffic; an eight-second loopback result must
not be interpreted as practical WAN feasibility. No protocol optimization has
been applied to hide these costs. See `evidence/runtime-results.json` for the
individual test runs and `VERIFICATION.md` for completed negative tests.

## Commitment and context codec

Canonical JSON is ASCII, sorted keys, compact separators, no NaN. Descriptor
schema is exactly:

```json
{
  "profile": "sealed-cheapest-3-spdz2k-v1",
  "upstream": "cd4d517a8a37b266d7233ae412717ca181cec6bf",
  "job": "<64 lowercase hex characters>",
  "attempt": "<64 lowercase hex characters>",
  "qualified": [true, true, true],
  "fixedFee": 0
}
```

**Future registry adapter contract:** `job` MUST be the registry's
`job_binding_hash` (binding network/contract, roster order and qualification,
approved circuit/build, key epoch if any and output policy), and `attempt` MUST
be its `attempt_binding_hash` (including the frozen complete input manifest).
Merely putting an arbitrary ID in those fields is insufficient. The local
harness uses explicitly synthetic hashes. It does **not** retrieve/verify NEAR
state, finalized snapshots, registry hash compatibility, participant signatures,
roster identity or output receipts. In particular, no current NEAR-binding gate
has been passed. An adapter must resolve the registry's actual codec and
commitment/freeze ordering without a circular attempt/manifest hash definition.

Let `D = SHA256(canonical(descriptor))`. For client ID `i` (0 is budget, 1–3 are
prices), the **implemented** versioned commitment is:

```text
C_i = SHA256(b"VEIL-MPC-v1\x00" || D || uint8(i) || uint64_be(amount_i) || salt32_i)
manifest = {"descriptor": descriptor, "commitments": [C_0,C_1,C_2,C_3]}
M = SHA256(canonical(manifest))
```

Client IDs separate budget/slot domains. The 32-byte random salt stays private.
The circuit recomputes SHA-256 from the same secret amount it uses in the
auction, plus its private salt; all four comparisons must succeed. This is
**not** a host-side hash of an unverified private amount. Public descriptor and
commitments are specialized into the compiled circuit. Every client sends its
ID and all eight 32-bit words of `M` to every operator, and each compares these
to the compiled constants. Private amount/salt inputs have fixed length.
This binds this local execution to one public manifest; it does not authenticate
the manifest's chain provenance or enforce a durable one-attempt policy.

## Pinned upstream and real APIs

Upstream is pinned to
[`cd4d517a8a37b266d7233ae412717ca181cec6bf`](https://github.com/data61/MP-SPDZ/tree/cd4d517a8a37b266d7233ae412717ca181cec6bf).
The source was inspected directly:

- `Compiler/types.py`: `sint.receive_from_client` sends authenticated random
  triples, then reads masked public inputs; `sint.reveal_to_clients` privately
  sends authenticated output triples when `program.active` is true.
- `ExternalIO/client.py`, `ExternalIO/domains.py`: ring specification, element
  encoding and active triple verification. Our strict client uses that wire
  format but requires active frames and fixes partial-read/EOF handling.
- `Compiler/circuit.py`: `sha256(sbitvec)` with the pinned Bristol SHA-256
  compression circuit; arithmetic/binary conversion uses `-X` daBits.
- `Compiler/instructions.py`, `Processor/Processor.hpp`: `check()` explicitly
  invokes protocol, MAC and broadcast checks. It runs before output and again
  after the output helper's multiplications, before completion markers.
- `Machines/spdz2k-party.cpp`: `Spdz2kShare<64,64>`, selected using the 64-bit
  schedule and `-SP 64`. Comparison statistical setting is 40 bits.
- `OT/OTExtension.cpp` refuses built-in KOS with secure builds; we keep that
  check enabled and use malicious SoftSpokenOT/libOTe instead. No `INSECURE`,
  compiler `-I`, VM file preprocessing flag, `-u`, `Fake-Offline.x` or
  semi-honest mode is used.

`patches/local-transport.patch` is the only tracked upstream modification: bind
listeners to IPv4 loopback, require peer certificates, and compare canonical
DER bytes against the exact expected `SSL_DIR/<peer>.pem` leaf while retaining
normal chain and hostname verification. This shared native class covers both
TLS roles, external `C<claimedId>` clients and inter-party `P<id>` channels.
Our Python wrapper also pins the expected `P0/P1/P2` certificates. Thus arrival
order is only a fixed-size connection schedule, **not identity authentication**.
The unmodified upstream example Python client does not set required server
certificate verification, so it is not used. There is no external PKI or
on-chain wallet-to-TLS identity mapping in this prototype.

Each session uses a unique offline fixture CA. Its seven identity leaves have
SANs, `CA:FALSE`, digital-signature/key-encipherment usage and client/server EKUs.
Only the public root is in client `trust.pem`; parties get the public root,
expected public leaves and only their own leaf key. The CA private key stays in
the generation directory and is deleted before party launch. This synthetic
local PKI supports the host's LibreSSL 2.8.3 without disabling verification or
using partial-chain workarounds. Direct non-CA leaf trust passed OpenSSL 3 and
the native-class control, but failed this old LibreSSL client. Only public
diagnostic certificates/hashes remain.

Five actual native-class TLS cases pass: correct certificate accepted; wrong
slot, absent certificate, untrusted same-name certificate and forged C1 rejected.
The forgery fixture intentionally trusts CA-capable C0, proves its forged C1
passes chain/hostname verification, then observes native exact-leaf rejection.
This tests pinning independently of `CA:FALSE`. The 11 final-circuit arithmetic
cases remain labeled pre-transport-patch; valid-baseline and wrong-commitment
tests also pass under the rebuilt transport binary. See `VERIFICATION.md`.

## Security and integration gates

SPDZ2k's intended dishonest-majority model requires at least one honest operator
and provides security with abort. Three local processes under one UID do not
meet that organizational assumption. A shared administrator can inspect all
clients, keys and memory. No process isolation, WAN, independent certificate
issuance, backup separation or operator-rotation test has been performed.

An honest wrapper requires active output checks, the post-check completion
marker from all parties and all successful process exits. A malicious recipient
may learn a result before disconnecting. This is not fairness, guaranteed output
delivery, recoverable settlement, remote attestation or a public execution proof.
There is no 3/3 signed result receipt, output commitment, durable replay guard,
admission receipt, registry adapter or payment integration. Corrupt operator
triple/MAC share injection, selective abort, replay/rollback and full side-channel
tests remain separate gates unless explicitly recorded in `VERIFICATION.md`.

For eventual CLI integration, the reusable files are the public codec in
`auction.py`, circuit in `programs/sealed_procurement.mpc` and private client in
`sealed_client.py`. The harness and oracle must stay out of a real coordinator.
Each actual participant must own its own client input process and keys and
connect to all independent operators. Compile/freeze the same approved public
manifest at every operator and verify artifact identities before any real input.
No native VM arguments or bytecode uploads should be accepted from an HTTP user.
