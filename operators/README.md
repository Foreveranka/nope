# Offline operator deployment gate

This directory validates a **public plan for future separate hosts**. It does
not deploy or launch anything. Current MPC transport is loopback-only. A valid
plan always returns `deployment_allowed: false`; administrative independence
cannot be proved from names, addresses, labels or certificate hashes.

Changes here own only `operators/`. MPC implementation and transport remain
owned by the parallel MPC worker. No node, wallet, token, account, dependency
installation or chain transaction is needed for these checks. Python 3.9+
standard library is sufficient, together with the repository's pure `mpc.v2`
codec for v2 selection plans.

## Run locally

From the repository root:

```sh
PYTHONDONTWRITEBYTECODE=1 python3 -m unittest discover -s operators/tests -v
PYTHONDONTWRITEBYTECODE=1 python3 -m operators.validate_manifest \
  operators/examples/synthetic-v2-plan.json \
  --expected-sha256 15f4148b6a7642ce069d5908e660fd66bd65125cc1d7205a2340c8137a2ad50f
```

The second command deliberately exits **3**: the synthetic plan passes, but
deployment is blocked. Exit **2** means invalid/unreadable input or an incorrect
trusted digest. Missing/incorrect CLI arguments also exit 2. `--structure-only`
explicitly makes a valid structural check exit **0**, with
`deployment_allowed: false` still in its JSON output. Never use that option as a
deployment authorization. Failure output does not echo file paths or supplied
fields. The library raises `ManifestError` for diagnostic detail without
including arbitrary field values.

The checked-in `.canonical.sha256` files are **synthetic example pins**, not
approvals. Their hostnames, identities, commitments, registry snapshots and
artifact pins do not identify a live deployment. To review a new real plan,
obtain its approved canonical digest independently through an authenticated
review channel; a digest delivered beside an untrusted plan provides no trust.
Do not compute and automatically accept a new digest from every incoming plan.

Canonical plan hash = SHA-256 of sorted-key, compact ASCII JSON with escaped
Unicode and no NaN. It is not the SHA-256 of the pretty-printed file. An offline
reviewer can calculate it using `operators.validate_manifest.digest` after
reviewing the complete declaration. All execution, operator and build fields
are pinned by this outer hash. No signatures or approval authority are invented.

## Explicit execution modes

The envelope schema is `veil-operator-plan-v1`; this is the operator envelope
version, **not** the MPC protocol version. `execution_mode` is mandatory. There
is no version guessing or fallback.

| Mode | `execution` | `execution_sha256` | Meaning |
| --- | --- | --- | --- |
| `v2-selection` | Exact `mpc.v2` closed-job selection manifest | `mpc.v2.manifest_digest(execution)` | Current noncircular precommit/selection metadata path |
| `v1-compatibility` | `{descriptor, commitments}` from MPC v1 | SHA-256 of canonical execution JSON | Legacy local fixture compatibility; does not resolve circular registry commitments |

Use `synthetic-v2-plan.json` as the primary example. For legacy compatibility,
`synthetic-plan.json` has canonical pin
`4c87cd48b5658b7cefdb45fed1b73c70899a45d53a3fe2f57c3b4c60fba95cc2`.

V2 validation calls **both** `mpc.v2.validate_manifest` and
`mpc.v2.manifest_digest`. The latter uses the selection domain tag; plain
SHA-256 of canonical JSON is not interchangeable. The upstream codec checks
intent, precommit context, sorted roster, all commitments, actual registry
Borsh bindings, complete bidset and the preselection `Closed` job. Its strict
closed-job schema accepts the original shape or the pair
`selected_executor: null`, `attempt_binding_version: null`; half-pairs or
nonnull preselection values fail. This gate delegates those rules rather than
maintaining a second implementation. The outer `build.source_sha256` must also
match v2's `mpcBuild.circuitSourceHash` and intent program hash.

A locally self-consistent snapshot is **not** authenticated NEAR state or proof
of finality. V2 selection is before execution attempts; it does not turn a
selection round into an executed attempt, result receipt, winner assignment or
payment. Source availability, source compilation and real runtime verification
remain different claims. See the active MPC worker's verification evidence.

## Envelope requirements

Unknown or missing fields fail at every envelope/build/operator level, including
private-key or claimed `deployed` fields. JSON must be UTF-8 and at most 64 KiB;
duplicate keys, nonfinite numbers, oversized and excessively nested input fail.

- Exactly three ordered entries, `party` integer 0, 1, 2; booleans are rejected.
  Each has `identity`, `administrative_domain`, `host`, `peer_port`, `client_port`
  and `certificate_sha256`, with no extra fields.
- Identity/admin labels are canonical lowercase ASCII slugs and must each be
  unique. Hosts must be distinct canonical IP literals or lowercase fully
  qualified DNS names. Loopback, wildcard, link-local, multicast, scoped IPv6,
  mapped IPv6, ambiguous numeric hosts, URI/userinfo/path/port syntax and local
  hostname aliases fail. Separate ports cannot disguise a shared declared host.
  Private VPN addresses are permitted; DNS is never resolved. Different names
  may resolve to the same machine or UID; this cannot be detected offline.
- Peer and external-client ports are distinct per operator, integers 1–65535.
  The same port numbers on separate hosts are allowed. These describe raw
  MP-SPDZ TLS endpoints, not HTTPS URLs or an implemented remote launcher.
- Leaf certificate SHA-256 pins are distinct and differ from the public CA pin.
  Pins are **SHA-256 of canonical DER certificate bytes**, not PEM text, SPKI
  or CA-only hostname trust. Hash strings must be nonzero lowercase 64-hex.
  No certificate files are opened here; validity, SAN/EKU/chain constraints and
  possession of distinct private keys are not verified. Reissued certificates
  can have different fingerprints while reusing a key.
- `build` requires pinned `upstream` plus `source_sha256`,
  `transport_patch_sha256`, `build_recipe_sha256`, `binary_sha256`,
  `bytecode_sha256`, `schedule_sha256`. Upstream must equal
  `cd4d517a8a37b266d7233ae412717ca181cec6bf`. The source pin identifies the MPC
  circuit file; the recipe pin must identify the approved dependency versions,
  patches, flags and security parameters. Agree on a deterministic bundle
  format if an artifact spans several files. These are reviewed declarations:
  this validator does **not** hash local artifacts, inspect a binary or attest
  what a remote operator runs.
- V1 descriptor fixes `sealed-cheapest-3-spdz2k-v1`, upstream, nonzero job/attempt
  hashes, three real booleans, integer fee 0–10¹² and four ordered distinct
  commitment hashes. These hashes may be synthetic; schema validation does not
  give them registry provenance. Do not relabel v1 as the v2 commitment codec.

## Prerequisites before any future distributed deployment

1. Have three genuinely independent operator administrators, separate hosts,
   credentials, cloud/OS control planes and backups; identify correlated control
   and collusion risks. The intended SPDZ2k model needs at least one honest
   operator and permits abort. Three processes, containers, UIDs or labels on
   a host under one administrator do not establish that assumption. The current
   same-UID harness knows every synthetic input and can inspect keys/memory.
2. Separately implement and review remote transport **after the MPC worker's
   active work**. The current patch binds native listeners to IPv4 loopback;
   this directory does not remove it, create a tunnel or bypass it. Verify
   mutual TLS chain/hostname checks and exact expected leaf identity on both
   inter-party and external-client connections, including wrong-slot, missing,
   rogue-CA and trusted-CA forged-leaf rejection across separate hosts.
3. Each real buyer/bidder must own its private client process and send inputs
   to all three operators. Provision the public root and all expected P0–P2 and
   C0–C3 leaves, but give each principal **only its own private key**. Establish
   authenticated wallet/account-to-TLS identity mapping out of band. A shared
   online CA or provisioning service with every private key can defeat the
   assumed separation. CA issuance control, revocation, expiry and rotation must
   be reviewed; leaf pinning remains necessary even with a valid CA chain.
4. Keep amounts, salts, shares, preprocessing, private keys and backups outside
   manifests, repository and public logs. Use least privilege and independent
   secret stores; define memory, crash, deletion and backup policy. Never run
   the centralized synthetic harness as a real sealed-bid coordinator. A hash
   is neither encryption nor proof of key ownership.
5. Each participant must authenticate finalized registry state and independently
   approve the same v2 intent/selection/build pins before inputs. Verify actual
   artifacts and secure compile flags; forbid insecure/fake preprocessing and
   arbitrary uploaded bytecode/VM flags. Add durable replay/rollback guards,
   deadlines, missing-slot abort and membership/certificate-rotation policy.
   This offline tool checks none of those operational facts.
6. Measure real WAN cost and abort behavior. The documented earlier local
   three-price run reported about **58,765 rounds** and **1,758.4 MB total**
   party traffic, with about eight seconds local runtime. These are prior
   loopback measurements, not new measurements or WAN estimates. Latency over
   many dependent rounds, preprocessing, bandwidth and sequential SHA/conversion
   work can dominate; do not multiply one RTT into an asserted benchmark.
7. Verify MAC/protocol completion, participant outputs, selective abort and
   recovery end to end on independent hosts. MPC with abort does not guarantee
   fairness, delivery, attestation, a public computation proof or settlement.
   Registry executor selection, receipts, buyer acceptance, disputes, timeout,
   refunds and payments remain separate integration gates. Passing this file
   validator cannot close them.

These prerequisites are documentation for future work, not operations performed
by the validator. Default exit 3 remains unconditional until a separately
reviewed implementation provides real evidence for distributed readiness.

## Evidence and scope

Tests cover trusted-pin substitution, strict parsing and types, duplicate
operator/host/cert declarations, context/profile/build mismatch, v2 delegation,
paired-null closed-job fields, Borsh/bidset tampering and explicit v1/v2
separation, plus assertions that no sockets, DNS lookup or process launch occur.
Only synthetic public metadata is used. These tests do not execute MP-SPDZ.

Verification on 2026-11-11: all **30 tests passed**. All operator Python files
compiled in memory. Real module CLI invocations for both fixtures returned 3
by default and 0 only with `--structure-only`, always reporting deployment
blocked. Fixture execution digests also matched `mpc.auction.digest` for v1 and
`mpc.v2.manifest_digest` for v2. This is offline tool verification only.

Repository sources read for this work: [privacy contract](../docs/PRIVACY.md),
[MPC implementation and local measurements](../mpc/README.md),
[integration sequence](../docs/NEXT-INTEGRATION.md),
[build ownership contract](../docs/BUILD-CONTRACT.md), and
[active v2 codec](../mpc/v2.py).
See [ZeroFi architecture review](ZEROFI-ARCHITECTURE.md) for the separate
threshold-custody comparison.
