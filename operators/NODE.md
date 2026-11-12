# Operator control package and selection bridge

Implemented 12 November 2026 under `operators/` only. No source/config/transport
changes in `mpc/`, no deployment, paid resources, production key generation,
wallet/chain operations or commits. Running the existing MPC harness creates its
normal ignored build/session outputs in `mpc/`; it removes transient private keys
and preprocessing as before. Other workers' files are untouched.

## What runs, and where it stops

| Component | Implemented behavior | What it does not establish |
| --- | --- | --- |
| Existing plan validator | Exact v1/v2 public plan and artifact/certificate declarations, independently pinned canonical digest | Running hosts, authenticated chain state, deployment approval |
| `node.py` + `control.py` | Actual OpenSSL Ed25519 admission signatures, expiring pinned roster, local file/TLS preflight, SQLite replay/epoch/clock journal, health daemon | Remote MPC execution, independent administration, execution proof |
| `selection-verifier.mjs` | Actual Ed25519 3/3 signed operator selection reports, exact frozen application job binding | Whether operators told the truth about hidden selection or ran approved code |
| `selection-cli.mjs` | Per-operator local approval with exclusive durable reservation and receipt export file | Automatic winner observation or public signing API |
| `blob-evidence.mjs` | Content-addressed immutable private evidence storage using the already installed Blob client | MPC hosting, new servers, independent operators or a registry transaction |
| `local-integration.mjs` | Real existing native three-party/four-client MPC, ephemeral same-administration committee, verifier and actual procurement HTTP handler | Deployed HTTP ledger, testnet MPC, independent servers |

The two receipt domains are deliberately different. An admission says an
operator admitted a pinned plan. It contains **no selected provider**. The
procurement bridge rejects admission receipts. A selection report is an explicit
operator statement that a provider was selected, not a mathematical execution
proof or attestation. The current circuit gives the winner to private clients;
operators do not automatically learn it. Before a real operator signs, a reviewed
result-disclosure/observation policy is needed. Three signatures do not supply
that policy, verify hidden bid openings, or prove the cheapest provider won.

## Executable local MPC integration

From the repository root, using the already bootstrapped native runtime:

```sh
PYTHONDONTWRITEBYTECODE=1 python3 -m unittest discover -s operators/tests -v
node --test operators/tests/*.test.mjs
node operators/local-integration.mjs --port 19400
```

The last command executes `operators.local_mpc` → existing `mpc.run_v2.run_prepared`
→ existing malicious SPDZ2k runtime and its TLS private-input clients. It never
falls back to a Python oracle or fake preprocessing. The harness requires all
native/client successful exits and checks actual private outputs against the
synthetic reference. The local script signs only after this returns successfully.
All four inputs are known by that one synthetic harness; independent client
custody is **not** provided. Three local processes are not three independent
operators. No containers or tunnels are started.

The integration then reconstructs the synthetic application's pre-deadline
admission lifecycle through the real `createProcurement` Request/Response handler
with an injected clock and in-memory immutable storage. It freezes those exact
commitments, verifies the real local result's signed report, and sends the
operator selection POST. Output includes the resulting `SELECTED` revision.
This validates callable integration, not a deployed storage/finality claim.

`evidence/local-integration.json` records the completed run, complete frozen app
job, committee public keys, signed report, its hash, exact verifier result,
actual synthetic buyer/provider output arrays and native runtime identities.
The output arrays expose **synthetic fixture amounts** deliberately; never send
customer outputs through this harness. Salts and private keys are excluded.
The test committee's private keys exist in memory only and are discarded. Its
five-minute report/committee expires; this artifact is historical evidence,
not a reusable live authorization. **Do not upload/configure this committee as
production trust.** Re-run to exercise test mode with fresh ephemeral keys.

## Procurement integration: exact contract

```ts
type SelectionVerifier = {
  verify(input: {job: FrozenProcurementJob; evidenceHash: string}): Promise<{
    provider: string;
    contextHash: string;
    evidenceHash: string;
    closedRevision: number;
    commitments: [string, string, string, string]; // budget, slots 1, 2, 3
  }>;
};
```

`createSelectionVerifier({committee, expectedCommitteeHash, loadEvidence, now?,
allowLocalSynthetic?})` returns this object plus read-only `.assurance` metadata.
The `.verify` result has exactly the five fields above, as required by the
current `procurement/core.mjs`. Throws on invalid/unavailable evidence.

The server, never the request/evidence, configures this public committee:

```ts
type Committee = {
  schema: 'veil-selection-committee-v1';
  epoch: number;                // positive safe integer
  notBeforeMs: number; expiresAtMs: number; // half-open validity, <= 7 days
  operation: 'operator-reported' | 'local-synthetic';
  members: [Member, Member, Member];
};
type Member = {id: string; publicKey: string}; // slug, raw Ed25519 public key hex32
```

`expectedCommitteeHash` is an independently approved SHA256 of canonical public
committee JSON. No key supplied by a report is accepted. Distinct configured
keys/labels are still not evidence of administrative independence. Committee
rotation/revocation is an authenticated server-config operation; no automated
registry membership or online PKI protocol is invented.

`selectionPayload(job, provider, committee, approvedHash, issuedAtMs)` constructs
the exact statement. It binds schema/kind, committee hash/epoch/operation,
**application jobId**, **closedRevision**, **binary-codec contextHash**, intent
selectionRound, buyer, sorted bidder roster, **all four frozen commitments**,
**selectedProvider**, issue/expiry times. The verifier independently validates
the v2 intent/context, complete fixed slots, qualifications, deadline and CLOSED
state. It does not substitute the registry's numeric job ID for the app's hex ID.
The context includes the v2 network/contract/program/nonce configuration.

Each signature is Ed25519 over
`UTF8('VEIL-OPERATOR-SELECTION-v1\0') || canonical(payload)`.
An evidence object is exact `{payload, signatures:[{operatorId,signature}, ...]}`;
all three distinct configured IDs/keys must verify. Signature encoding is 128
lowercase hex characters. The receipt expires after at most five minutes and
no later than the committee/job deadline. Its `evidenceHash` is SHA256 of the
**canonical JSON bytes** of the complete evidence object, including signatures.
Stored bytes must already be canonical; duplicates/extra fields/noncanonical
serialization fail. Bounded at 16 KiB. No arbitrary URLs or claimed proofs.

`loadEvidence(hash)` returns immutable `Buffer | Uint8Array` bytes from
server-owned storage. Verification is stateless; **the HTTP core's immutable
revision/CAS and CLOSED → SELECTED transition enforce consumption**. A new-key
replay after selection fails; a retry with the same idempotency key/body returns
the original response. Do not call this standalone verifier and describe it as
a durable one-use queue.

### Existing private Vercel Blob path

Main may mount the following using its existing deployment configuration:

```js
import {createBlobSelectionVerifier} from './operators/blob-evidence.mjs';
const selectionVerifier = createBlobSelectionVerifier({
  committee: reviewedPublicCommittee,
  expectedCommitteeHash: independentlyApprovedCommitteeHash,
  // Default false. Set true only in an explicitly isolated synthetic test mode.
  allowLocalSynthetic: false,
});
const handle = createProcurement({store, env, selectionVerifier});
```

No extra API key is introduced. This adapter uses the existing server-side
`BLOB_READ_WRITE_TOKEN` without printing it. Reports use fixed private paths
`nope-operator-evidence-v1/<evidenceHash>.json`, no overwrite/random suffix and
uncached reads. `blobSelectionEvidence().publish(report)` is a callable
operator-controlled ingestion function; verify the assembled report against the
frozen job before calling it. No HTTP upload or key-management endpoint is added.
Local-synthetic committee reports are rejected by default. Vercel can store and
verify reports; it cannot run the continuous native peer processes here. No Blob
write/deployment/production trust update was performed by this work.

### Per-operator local signing

Provision each operator's own Ed25519 private key outside Git; no production
keys are generated here. Use mode 0600 and an owner-only 0700 state directory.
Prepare the public payload with `selectionPayload` and approve it at each node:

```sh
node operators/selection-cli.mjs sign \
  --job /etc/veil-operator/frozen-app-job.json \
  --payload /etc/veil-operator/selection-payload.json \
  --committee /etc/veil-operator/committee.json \
  --committee-sha256 "$APPROVED_COMMITTEE_HASH" \
  --operator-id operator-a \
  --key /etc/veil-operator/private/selection.key \
  --state-directory /var/lib/veil-operator/selection
```

CLI compares the payload with the exact frozen job before signing. The signing
API is an operator approval primitive: it cannot discover the true winner from
commitments. Assemble the three returned signatures with the unchanged payload,
serialize with `evidenceBytes`, then verify/store. `selection-cli.mjs verify`
takes `--job`, `--report`, `--committee`, `--committee-sha256`; local test mode
requires explicit `--allow-local-synthetic` for both commands.

Signing creates an exclusive `.reserved` file, fsyncs it and its directory,
then signs and writes/fsyncs a `.receipt` file. The key includes app job ID,
selection round and operator ID, so a conflicting provider or new epoch cannot
silently produce a second statement in the same intact directory. To recover
delivery read the completed `.receipt`; never delete reservations to retry.
The library-only `signReport` is used with ephemeral in-memory keys by tests;
persistent operators must use `signReportOnce`/CLI. Deleting/restoring the
directory or using another one defeats this local guard; no anti-rollback
hardware, shared signer consensus or administrator resistance is claimed.

## Host-local admission daemon

Requires Python 3.9+ standard library, repository `mpc.v2`, an explicitly selected
OpenSSL 3+ executable, an existing approved v2 plan and matching signing roster.
No global pip/npm installation or dependency download is performed. The checked
runtime used Python 3.9 and Node 25.6; the optional Blob adapter uses the existing
installed `@vercel/blob`. The supplied systemd unit is for Linux and has not been
installed/tested on this macOS host.

Start with `examples/node-config.template.json`. Its placeholder approval pins
deliberately cannot authorize operation. A public roster has exactly:

```text
schema: "veil-operator-roster-v1"
plan_sha256: independently-approved-plan-pin
epoch: positive integer
not_before, expires_at: Unix seconds, half-open validity, at most seven days
members: [{party:0,identity:<plan P0>,receipt_public_key:<raw Ed25519 hex32>},
          {party:1,...}, {party:2,...}]
client_certificate_sha256: [C0 DER pin, C1 DER pin, C2 DER pin, C3 DER pin]
```

Pin its canonical SHA256 independently. The roster binds the existing plan's
P0/P1/P2 identities and TLS pins; it additionally pins all four client leaves and
distinct receipt signing keys. Receipt keys are separate from TLS keys. This is
a reviewed local trust file, not automatic NEAR wallet ownership verification.

Each node needs `trust.pem`, all seven **public** P0–P2/C0–C3 leaves and only its
own `P<party>.key` in the TLS directory. Preflight verifies root/leaf DER pins,
normal chain/hostname/time checks for both TLS roles, CA:FALSE leaf constraints,
and that its private TLS key matches its leaf. Other conventional `*.key` files
there fail. No revocation/OCSP fetch or independent issuance audit occurs.
Preflight hashes the six declared local source/patch/recipe/binary/bytecode/
schedule files, then checks the signing key matches the roster. It does not
attest loaded libraries, prove a recipe built that binary, or launch it.

Initialize an existing mode-0700 directory exactly once, then run:

```sh
PYTHONDONTWRITEBYTECODE=1 python3 -m operators.node init-state \
  --state-directory /var/lib/veil-operator
PYTHONDONTWRITEBYTECODE=1 python3 -m operators.node check \
  --config /etc/veil-operator/node.json
PYTHONDONTWRITEBYTECODE=1 python3 -m operators.node serve \
  --config /etc/veil-operator/node.json --health-port 9080
```

`check` returns **3** after successful preflight because distributed execution
is blocked; invalid configuration returns **2**. `serve` starts only after
preflight. `/healthz` returns liveness 200, `/readyz` always returns 503 for remote
MPC, `/statusz` reports the last preflight timestamp and current roster validity.
These endpoints bind only `127.0.0.1`; Host checks are enforced. There is no
network signing/admission API. Artifact checks are a startup snapshot, not
continuous file monitoring; `admit` repeats them before every signature.
Configuration/roster changes require a restart. The systemd unit runs this
**control service**, not a remote MPC daemon. Initialize state before enabling it.

`node admit --config ...` produces a domain-separated `plan-admitted` receipt;
`node export --config ...` recovers its completed receipt. Payload binds the
plan/execution/roster digests, epoch, registry job-binding hash, selection round,
party/signer and five-minute lifetime. SQLite reserves job+round+party before
signing and persists the completed envelope afterward; signing failure burns
the reservation. `node verify` verifies/consumes a JSON list of three admission
receipts using `--plan`, `--plan-sha256`, `--roster`, `--roster-sha256`, `--openssl`,
`--state-directory`, `--receipts`. It does not accept selection reports.
Missing state is an error. Epoch/same-epoch roster substitution and backward
clock steps fail. Restore/replacement of the DB can defeat these local guards;
reconciliation against independent durable state is still required.

OpenSSL command semantics were checked against the official
[Ed25519 pkeyutl documentation](https://docs.openssl.org/3.0/man1/openssl-pkeyutl/)
and [certificate verification options](https://docs.openssl.org/3.0/man1/openssl-verify/).

## Exact external server gap and smallest safe next change

There are **no independently provisioned operator servers**. This work has not
run externally or on testnet. Existing private Blob support only moves public
evidence. Three containers on one administrator's machine still share that
administrator's trust boundary. Three containers with separate network namespaces
cannot reach the patched native loopback listeners. No port forwarding, shared
container networking, tunneling or reverse proxy is used to bypass this guard.

Before real distributed inputs, provide three persistent hosts under separately
reviewed administration/control planes, each with its own service identity,
keys, secret/preprocessing state, backups and incident operator. A starting
**unbenchmarked capacity planning allowance** is 4 vCPU, 8 GiB RAM and 20 GiB
disk per Linux native host plus compiler/build capacity; actual capacity must be
measured. Secure disk, controlled crash/core dumps, independent clock sync,
firewalls, authenticated PKI provisioning and monitoring are also needed. No
Monero daemon, bridge stake, custody wallet or paid service is required here.
WAN traffic/latency remains unmeasured and may be prohibitive for this circuit.

The smallest safe MPC-owned change is an **explicit opt-in remote transport
profile**, defaulting to the current loopback-only behavior, plus a reviewed
single-party launcher. It must:

1. Bind each P listener to its explicitly approved interface and use an exact
   P0/P1/P2 address/port table, retaining required peer certificates and exact
   DER leaf checks in both native TLS roles. Keep TLS names P0/P1/P2 independent
   of endpoint IPs. No arbitrary VM/bytecode/flags from HTTP.
2. Extend the strict external client to consume approved P endpoints, preserving
   chain/hostname/leaf checks. Each buyer/bidder owns its own amount/salt process
   and key and distributes its private inputs to all three parties. This requires
   changes to `mpc.sealed_client.connect`, which currently hard-codes loopback.
3. Launch only one approved native party per operator after local artifact/key
   checks, isolate preprocessing/keys per job, enforce deadlines, abort/cleanup
   and durable round reservations. Verify successful exits and post-check
   completion behavior, not just an HTTP receipt or a log word.
4. Test across three network namespaces/hosts: actual good MPC execution, wrong
   slot/CA/leaf, missing client, foreign manifest/job, malformed opening, replay,
   expiry, selective abort and cleanup. A same-administrator functional test may
   come first, explicitly labeled as such. Then test true independent custody
   and WAN abort behavior before asserting independent operation.
5. Authenticate finalized registry snapshots and settle the app-job → registry
   job mapping, rotate/revoke identities, and implement the winner disclosure
   policy before treating committee reports as operational selection evidence.

Those are MPC transport/protocol lifecycle changes outside this task's ownership;
no remote runtime success or production readiness is fabricated in their place.

## Completed verification

- `evidence/python-tests.log`: **41 passed**, including actual OpenSSL signatures,
  full certificate/artifact preflight, CLI check/admit/export, loopback HTTP health,
  durable issuance/consumption replay rejection, crash-burned reservations,
  foreign jobs/rounds, wrong signers, roster expiry/epoch and clock rollback.
- `evidence/node-tests.log`: **14 passed**, including exact frozen job/context/
  commitments/provider binding, configured three-signer quorum, foreign signer,
  expiry during storage I/O, durable conflicting-signature rejection, explicit
  synthetic opt-in, bounded private Blob client controls and actual procurement
  HTTP acceptance/idempotent retry/new-key replay rejection. Blob tests use an
  injected client; this worker performed no live Blob operation.
- Latest `evidence/local-integration.json`: actual native v2 runtime **8.4403 s**;
  buyer `[1,2,80,80]`, providers `[[0,0],[1,80],[0,0]]`, provider `beta.near`;
  actual procurement handler returned `SELECTED` revision **6** in its explicit
  synthetic in-memory lifecycle. Compile/runtime identities and the complete
  actual synthetic native result are in that file.
- All eight operator Python sources compiled in memory; tracked operator diff
  whitespace checks passed. The Linux systemd unit was supplied but not installed
  or executed. No independent-host, external MPC or testnet claim is made.
