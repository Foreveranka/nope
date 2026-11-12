# Native explicit-bind single-party launcher

Implemented and tested locally, 12 November 2026. No external host, public
listener, testnet transaction, deployed operator API or independent administrator
was created. Three provider accounts and three computing-party processes are
different identity layers. This package does not infer independence from either.

## Administrative entry point

```sh
PYTHONDONTWRITEBYTECODE=1 python3 -m mpc.party_launcher init-state \
  --state-directory /var/lib/veil-mpc
PYTHONDONTWRITEBYTECODE=1 python3 -m mpc.party_launcher check \
  --config /etc/veil-mpc/party.json --config-sha256 "$APPROVED_PARTY_CONFIG_HASH" \
  --allow-remote-network
PYTHONDONTWRITEBYTECODE=1 python3 -m mpc.party_launcher run \
  --config /etc/veil-mpc/party.json --config-sha256 "$APPROVED_PARTY_CONFIG_HASH" \
  --allow-remote-network
```

`check` performs read-only preflight. `run` starts **only the configured party**;
there is no job polling, discovery, public HTTP API or browser-supplied host list.
The caller obtains profile/config/build approval pins independently through its
operator administration channel. Computing and automatically accepting a pin
from a request is not authorization. All local paths are absolute and included
in the approved config digest. State must be an existing owned mode-0700
directory, initialized explicitly once. Missing/replaced state is not recreated.

The config schema is exact `veil-party-launch-v1` with these fields:

```text
party: integer 0..2
profile, profile_sha256: path and approved canonical network-profile digest
selection_manifest, selection_manifest_sha256: path and exact v2 digest
build_stamp, build_stamp_sha256: approved native build record and raw-file digest
artifacts: {binary, shared_library, config, recipe, source, patch,
            schedule, bytecode_manifest, bytecode_directory}  # absolute paths
tls_directory, state_directory, openssl: absolute local paths
timeout_seconds: integer 1..900
loopback_test: null                  # production config
loopback_test_sha256: null           # production config
```

No arbitrary arguments, commands, executable uploads, environment values or
private inputs are accepted. `binary` must have the approved profile/stamp hash;
its copied filename is fixed. The pinned runtime generation is
`explicit-bind-leaf-pin-v2`, using secure live preprocessing, SPDZ2k 64/64,
statistical parameter 40, three parties and fixed peer/client bases 17500/17400.
No `INSECURE`, insecure compile flag, file preprocessing or unencrypted option
is enabled. Root/profile pins are certificate DER SHA256, not PEM/SPKI hashes.

Each native party gets public CA/P0–P2/C0–C3 certificates and **only its own P key**.
Preflight verifies DER pins, CA:FALSE leaves, chain, validity, both TLS purposes,
role names and own-key match. Each buyer/provider must separately own its C key
and strict input process. The launcher receives no price, budget or salt.
Provisioned own keys stay in the operator's source key directory; only transient
copies and native preprocessing are erased on exit/abort. Client/wallet ownership
and authenticated finalized chain snapshots remain separate approval duties.

## Artifact and replay handling

Preflight hashes actual binary, shared library, secure config, circuit source,
transport patch, build recipe and schedule. The bytecode pin covers a canonical
JSON bundle manifest:

```json
{"files":[{"name":"<approved-program>-0.bc","sha256":"<raw-file-hash>"}],"schema":"veil-mpc-bytecode-bundle-v1"}
```

The real circuit has several tapes; list **every** one, sorted by name. Every
tape's file digest and the schedule's exact tape set are checked. Basenames are
bounded, safe and prefixed with the approved selection-specific program name.
The schedule must retain the fixed 64-bit ring and port-17400 compile arguments.
An approved bytecode declaration is not independently verifiable compilation or
remote attestation.

SQLite FULL-sync state atomically reserves `(job_binding_hash, selection_round,
party)` **before spawning**, tracks the highest roster epoch and clock, and
rejects same-epoch identity substitutions. Different jobs with the same unchanged
roster may use the same epoch. A failed spawn, timeout or abort burns the round;
there is no automatic retry/reset. Backup rollback/deletion by an administrator
can defeat a local journal; no hardware anti-rollback guarantee is claimed.

Each run gets a private random directory, copied/rehashed native executable and
library, copied schedule/tapes, own-key-only Player-Data and a generated strict
peer file. On timeout/interruption the launcher terminates/kills its own native
process group and removes Player-Data and runtime copies. It retains the public
log, schedule and reservation status. Same-UID administrators can inspect memory;
directory separation is not independent administration or a sandbox.

A successful process exit plus the circuit's completion marker produces only
`status: local-party-completed`, pinned identities and log hash, with
`whole_mpc_verified:false`, `execution_proof:false` and
`independent_operators:false`. A coordinator still needs all party exits and all
strict clients' authenticated outputs. This does not automatically produce a
winner receipt, registry acceptance, settlement or payment.

## Actual native implementation

The native patch retains the exact-leaf TLS hunk unchanged. Scoped
`Networking/VeilBind.h` declarations avoid changing broad player/socket class
layouts. The implementation touches ServerSocket, Player, ExternalClients,
NetworkOptions and OnlineOptions. Early OnlineOptions registration/configuration
is necessary because SPDZ2k bypasses the generic NetworkOptions startup path.

The native flags are `--veil-enable-bind`, `--veil-bind-ipv4` and
`--veil-network-profile-sha256`. All three are mandatory together. Native checks
canonical unicast IPv4, three exact peer-file entries, own-address agreement and
fixed ports before listening. Listener construction and self-connect both use the
explicit IP. Without flags, the address remains `127.0.0.1`. No wildcard bind or
environment-only activation is added. The native pin argument is a configuration
marker; **the launcher** verifies the full approved profile/config/artifacts.
Direct native invocation is not a substitute for launcher authorization checks.

The earlier `network_profile` renderer's hypothetical direct-native profile flags
are not the supported native interface. Use `party_launcher` above. Existing
strict-client profile flags are implemented; its default local API and bid-client
call signature remain compatible.

The native-only bootstrap path rebuilds with `make -j1 spdz2k-party.x` from the
existing dependency setup. It refuses staged vendor changes, compares tracked
worktree contents/modes with HEAD (including changes hidden by index flags), and
requires the exact reviewed transport patch. Staged Makefile `-DINSECURE`
injection was reproduced against the former index-relative comparison and now
fails before `make`; isolated regression tests require no native build. Secure
build metadata is refreshed only after a successful build. This protects this
source-validation boundary; it is not an attestation against a malicious host.

## Functional test and evidence

```sh
PYTHONDONTWRITEBYTECODE=1 python3 -m unittest discover -s mpc/tests -v
PYTHONDONTWRITEBYTECODE=1 python3 -m mpc.tests.verify_party_launcher
```

The manual verifier compiles real selection-specific v2 bytecode, starts three
launcher processes and four strict private-input client processes, requires all
exits/checks, compares actual synthetic outputs, checks explicit-bind log markers,
tests durable replay rejection and verifies transient-key/preprocessing cleanup.
All witnesses are centralized **synthetic fixtures**; no real bidders use this
test harness. A local-only test dial adapter maps declared profile addresses to
the approved loopback test addresses. There is no production loopback override in
the sealed client and no tunnel, OS alias, public listener or namespace creation.

An additional separately hashed `veil-loopback-functional-test-v1` file binds
the profile digest, three addresses chosen only from 127.0.0.1/.2/.3, and an
expiry. Both the config and `--allow-loopback-functional-test` must approve it.
Production profiles continue rejecting loopback. This Mac cannot bind .2/.3
(errno 49); the actual run therefore exercised three processes/ports on .1 and
records the requested three-interface test as **unavailable**, not passed. On a
host where all three probes succeed, the same verifier uses all three interfaces.

Evidence under `mpc/evidence/`:

- `pre-explicit-bind-native-identity.json`: before binary/library/config/patch
  hashes, complete prior stamp and prior public evidence hashes; ignored rollback
  copies are under `.local/pre-explicit-bind`.
- `explicit-bind-build.log`, `native-build.json`: final secure native build and
  patched-source identities. Binary and library are separately pinned: a shared
  library change need not change the executable's bytes.
- `explicit-bind-functional.json/.log`: actual native launcher run, output arrays,
  per-party logs/identities, replay result and interface limitations.
- `explicit-bind-local-v1-regression.json`: real default loopback v1 regression.
- `pre-explicit-bind-tls-results.json`, `tls-results.json` and
  `explicit-bind-tls-regression.log`: preserved old TLS evidence and current
  actual native-class positive/wrong-slot/absent/rogue-CA/forged-leaf checks.
- `explicit-bind-unit-tests.log`: codec, cleanup, launcher and provenance tests.

Earlier local evidence retains its original hashes and meaning. No old local
result is relabeled as external, independently operated or publicly proven.

## Final bounded verification

- **42 MPC tests passed**, including 10 launcher tests and 8 bootstrap provenance
  tests. Staged `-DINSECURE` injection and hidden tracked changes fail before
  `make`; the stamp-writing boundary rechecks source state too. Clean HEAD and
  the reviewed unstaged transport patch remain supported.
- The final fresh native launcher run completed in **7.8535 s**, with actual
  synthetic outputs `[[1,2,80,80],[0,0],[1,80],[0,0]]`. All three local party
  processes and four strict clients succeeded; durable replay was rejected.
- Default-loopback native v1 regression passed. All **5 actual native TLS cases**
  passed, including rejection of wrong slot, absent certificate, rogue CA and a
  forged trusted-CA leaf. No key files remain in the synthetic bind-test trees.
- The patch applies to pristine upstream files and reverses against the current
  reviewed vendor changes; whitespace checks passed with context prefixes intact.
- `explicit-bind-final-verification.json` records exact current hashes, complete
  changed-path inventory, before/after identity evidence and the interface/WAN
  limits. The executable hash remained unchanged; the separately pinned shared
  library contains the native changes.

The requested three-interface run is **unavailable on this host**, not passed:
.2/.3 could not bind and no aliases were created. Only three processes on .1 with
distinct ports were exercised. WAN, separate-host operation, independent key
custody/administration, authenticated live-job/profile binding and production
operation remain unverified. No additional native experiments follow this report.
