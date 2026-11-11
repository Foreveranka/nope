# Cloud gateway and customer companion operations

## Status and supported work

As of 12 November 2026, **one actual cloud FHE run, smoke03, passed** using synthetic
inputs and the real Linux Vercel worker03 configured with 2 GB memory. The run
completed direct encrypted uploads, remote native evaluation, result/receipt
retrieval, local decryption and local reference/receipt checks. Linux container03
also passed its earlier public-circuit compile/load build preflight.
A **second run from the extracted customer ZIP passed in 40.129 s**, using its
local HTTP companion and the existing installed Python/Concrete environment.
This verifies the packaged code, not installation on a fresh machine. Matching
public cleanup evidence for smoke03 confirms
removal of this run's three uploaded input/key objects while retaining its result.
A release also needs a separate READY/source-commit/download-hash check; a prior
live pilot result does not verify alignment with a later source commit.
See [DEPLOYMENT.md](DEPLOYMENT.md) for deployment topology.

### Verified pilot evidence

The sanitized [cloud-fhe-live.json](verification/cloud-fhe-live.json) records
`status: PASS`, `syntheticOnly: true`, `real_fhe: true`, `localReferenceMatched: true`,
the request/output/receipt hashes and the tested gateway/worker deployment IDs.
Its recorded verification time is `2026-11-11T22:24:44.219115+00:00`
(12 November in Istanbul).
The run originated in the explicitly supplied sanitized
`runtime/cloud-smoke-03/result.json`; runtime remains private and excluded from
publication. Use the public evidence copy for review.

| Measurement | Smoke03 result |
| --- | --- |
| Total end-to-end time | 37.714 s |
| Native evaluation | 6.300 s |
| Server load | 3.092 s |
| Evaluation-key bytes | 221,406,120 |
| Encrypted input bytes | 787,192 |
| Encrypted output bytes | 442,904 |

These are measurements from one successful synthetic pilot, not latency or memory
guarantees. The 2 GB value describes worker configuration, not measured peak usage.
The run reports `realPayments: false`, `independentMpcOperators: false` and
`executionProof: false`.

Two earlier integration blockers were corrected before this successful run:
explicit rewriting fixed nested job routes that native catch-all routing had
returned as 404; filename-specific Blob MIME signing/upload handling fixed JSON
manifest uploads. The actual cloud upload path is not a metadata-only simulation.

The fixed profile is `clean-4-records-v1`: exactly four records with integer `id`
and `value` in 0–255. It flags later duplicate IDs, maps sentinel value 255 to zero
and caps other values above 100 at 100. It keeps four records; it does not remove
duplicates or provide arbitrary CSV processing. Local evaluation remains the
default; the customer must explicitly select remote encrypted evaluation.

There are no live payments or funds custody in this flow. It does not execute an
independent MPC auction or establish independent operators, provider-wide secure erasure,
attestation or a cryptographic proof of correct computation. Client verification
means receipt/artifact binding plus local decryption and a plaintext reference
check. A configured endpoint is not a verified computation.

## Configuration by component

Set private values through the relevant process/deployment secret configuration,
not source files, image layers, public frontend variables or browser storage.
The names below come from the implementation; no private environment or runtime
secret files were read to prepare this document.

### Frontend project's Node gateway

| Variable | Meaning |
| --- | --- |
| `BLOB_READ_WRITE_TOKEN` | Private Blob store credential; gateway only |
| `VEIL_ACCESS_GRANTS` | JSON array of grant objects containing `owner`, `tokenHash`, `jobIds`, `issuedAt`, `expiresAt`; contains hashes, not raw customer tokens |
| `VEIL_PUBLIC_ORIGIN` | Exact hosted origin, such as `https://veil-procurement.vercel.app`, without a trailing slash |
| `VEIL_WORKER_URL` | Explicitly authorized worker HTTPS origin; gateway calls `/evaluate` at that origin, ignoring any base path |
| `VEIL_WORKER_TOKEN` | Shared gateway-to-worker bearer secret; same value at both components |

Worker URLs must use HTTPS, port 443/default, no userinfo, query or fragment.
Gateway dispatch rejects redirects. The worker destination is operator-configured,
not supplied by a customer. Present Origin headers must exactly match
`VEIL_PUBLIC_ORIGIN`; origin-less companion requests use explicit bearer auth.
There is no cookie authentication or permissive CORS.

Routing is `/api/cloud/:route*` rewritten to `/api/gateway?route=:route*`, handled
by [api/gateway.mjs](../api/gateway.mjs). Keep the explicit rewrite and function
configuration together. The adapter rejects missing, repeated or invalid `route`
parameters at `/api/gateway`, and retains direct `/api/cloud/…` handling for tests.
It catches body-stream/adapter errors with a generic 503 when the response can
still be written, guarding `headersSent`, `writableEnded` and `destroyed`.

### Encrypted-only worker container

| Variable | Meaning/default |
| --- | --- |
| `VEIL_WORKER_TOKEN` | Same shared bearer secret as the gateway; never a customer invitation |
| `VEIL_BLOB_HOST` | Exact private Blob **GET** hostname for this store, e.g. `<store>.private.blob.vercel-storage.com`; hostname only, no wildcard or URL |
| `PORT` | HTTP listener port, default `8080` |
| `VEIL_WORKER_TIMEOUT_SECONDS` | Whole child job deadline, default/max `220`; accepted range 1–220 |
| `VEIL_WORKER_MEMORY_MB` | Linux child virtual-address limit, default `8192`; accepted range 1024–65536; not a resident-memory reservation |

The hosting ingress must provide the HTTPS endpoint used by the gateway. The
worker itself listens on `0.0.0.0:$PORT` with stdlib HTTP behind that ingress.
Configure hosting memory/process limits separately from the child's RLIMIT_AS.
Smoke03 completed on the 2 GB worker configuration; neither the build preflight
nor that single run provides a capacity or peak-memory guarantee for other work.

Downloads accept only the exact configured Blob hostname, verified HTTPS and
public DNS answers, then connect to checked addresses while preserving hostname
verification/SNI. They reject redirects, proxies, private/mixed DNS results and
mismatched sizes/hashes/framing. The worker has one evaluation slot per process;
busy evaluation returns 503 rather than queuing. See the source in
[transport.py](../cloud/worker/transport.py) and [server.py](../cloud/worker/server.py).

### Customer-owned companion

| Variable | Meaning/default |
| --- | --- |
| `VEIL_CUSTOMER_TOKEN` | Raw customer invitation; read only by the local companion |
| `VEIL_CLOUD_URL` | Gateway HTTPS base origin, default `https://veil-procurement.vercel.app` |
| `VEIL_PYTHON` | Optional Python executable for `install-client.sh`, default `python3` |

Without `VEIL_CUSTOMER_TOKEN`, `RemoteClient.from_env` returns no remote client.
For an alternate gateway origin, start `python -m service.server` with
`VEIL_CLOUD_URL` and the token supplied privately in its environment. The packaged
`scripts/client-launch.py` deliberately sets the production gateway URL itself;
it does not preserve an alternate `VEIL_CLOUD_URL` environment value.

The companion binds exactly to `127.0.0.1`, default port 8765. The browser edits
records and displays results at the companion's local `/app`; local mutations
require its Origin and CSRF token. The hosted `/app` supplies installation
instructions and does not accept the invitation or plaintext dataset.

## Create and distribute an invitation

From the repository root, choose a new owner label and number of job slots:

```sh
node scripts/create-cloud-invitation.mjs pilot-01 2
```

The script creates `runtime/cloud-access/pilot-01.json` exclusively: it refuses to
overwrite an existing file, uses file mode 0600 and creates the containing
directory with mode 0700. It stores `{token, grant}` and prints only a confirmation,
not the bearer. The token is generated from 32 random bytes. The script accepts
1–10 slots (default 2), creates random 32-hex-character job IDs and a **24-hour**
grant. Owners must match `[a-z0-9-]{1,48}`; different tenant owners get separate
Blob namespaces. Grants with the same owner refer to the same tenant namespace.

Load only each file's **grant object** into the gateway's `VEIL_ACCESS_GRANTS`
JSON array through private operator configuration. Do not paste the outer
`{token,grant}` object or the raw token into gateway grants. Deliver the raw
invitation privately to its intended customer, never in a URL, issue, chat log,
shell command argument, public evidence file or hosted form. Gateway configuration
supports at most 100 grants and 50 allowed job IDs per grant.

Timestamps are integer Unix milliseconds. Gateway validation requires `issuedAt`
and `expiresAt`, expiry after issuance, issuance no more than 30 seconds in the
future and a lifetime of **at most six days**. Expiry is enforced on session,
upload authorization, job status, evaluation and result retrieval. Seven-day JSON
retention exceeds the maximum accepted grant lifetime. Keep that relationship;
when issuing a replacement grant use fresh job IDs instead of resurrecting old
slots after their claims expire.

To revoke access, remove the grant from active gateway configuration and apply
that configuration to running deployments. Already issued signed Blob URLs have
their own short validity; changing the grant does not revoke those capabilities
immediately. Keep durable claims intact and rotate a leaked shared worker/Blob
credential at its own component rather than distributing it as an invitation.

## Start the customer companion

Download and unpack `/veil-client.zip` from the hosted app. The reviewed package
contains source, public circuit/spec artifacts and a `FILES-SHA256.json` inventory.
The installer targets Python 3.9–3.12 on macOS or Linux; the Linux worker/runtime
path uses x86_64. Run inside the unpacked `veil-client` directory:

```sh
sh install-client.sh
.venv/bin/python scripts/client-launch.py
```

Enter the invitation at the hidden terminal prompt. The launcher opens the local
UI and holds the token in its process environment. Optional flags are
`--no-browser`, `--port 8765` and `--invitation-file /private/path/invitation.json`;
an invitation file must contain a `token` field and remain private. Do not paste
credentials into the hosted website or add them to the downloaded package.

In the local app select **remote encrypted evaluation** explicitly and submit four
synthetic records for the verified pilot profile. Keep the companion running
through retrieval and local verification. Plaintext, results and the decryption
key are held in local process memory; closing/crashing that process loses the
key and is not a supported resumable-decryption workflow. `configured` becomes
`available` only after that companion session completes a real remote job and
local verification. Local evaluation is a separate mode, not an automatic remote
failure fallback.

## Implemented encrypted upload and evaluation flow

1. The companion generates fresh keys locally, encrypts the four records with the
   pinned `portable-v1` profile and validates its artifact/manifest hashes.
2. It authenticates `GET /api/cloud/session`, selects an unused allowed job ID and
   durably records its fingerprint in `runtime/remote-used-jobs.jsonl` **before**
   a mutation. A file lock, flush and fsync protect this local consumption fence.
3. It posts descriptors to `POST /api/cloud/jobs`: `jobId`, a file list of
   `{name,size,sha256}` and the exact `requestManifestSha256`. The gateway binds
   metadata under `veil-v1/<owner>/<jobId>/` and returns per-file presigned PUTs.
4. After validating the entire upload plan, the companion streams the actual
   encrypted file bytes directly to **`https://vercel.com/api/blob/`** using the
   SDK-generated signed query unchanged. It sends filename-specific Content-Type
   and exact Content-Length, sending no customer bearer to Blob. This PUT control
   endpoint differs from the store's private object GET hostname. Ciphertext and
   evaluation-key payloads do not pass through the Node gateway or browser.
5. `POST /api/cloud/jobs/<id>/evaluate` with `{}` creates an atomic, durable
   `claim.json`, signs short-lived private GETs and dispatches one `/evaluate`
   request to the configured worker with the separate worker bearer.
6. The worker downloads, checks and evaluates the encrypted files in a disposable
   subprocess using its deployed pinned public circuit. It returns exactly
   `receipt`, `receiptBase64`, `receiptSha256`, `outputBase64`, `outputSha256`.
7. The gateway bounds/validates the reply, checks the original decoded receipt
   SHA and JSON equality, request-manifest binding, receipt output hash and
   ciphertext hash, then stores `result.json`. The companion retrieves
   `GET /api/cloud/jobs/<id>/result`, validates exact bytes and manifest/receipt
   binding, decrypts locally and performs its reference check. It preserves the
   original receipt bytes rather than hashing a reserialization.

Required uploaded files are `request.json` (8 KiB max), `request.bin` (2 MiB) and
`evaluation.keys` (512 MiB); protocol v2 additionally carries `binding.json`
(8 KiB). Public `server.zip` and `client-specs.json` stay in the deployed worker
and companion packages, not per-job uploads. A binding file is public registry
context, not evidence of a chain transaction or a proof.

| Uploaded filename | Signed allowed type and PUT Content-Type |
| --- | --- |
| `request.json`, `binding.json` | `application/json` |
| `request.bin`, `evaluation.keys` | `application/octet-stream` |

`blobStore.sign` chooses MIME by the `.json` suffix, and `RemoteClient` validates
the signed allowed type and sends the matching header by filename. Do not force
every upload to `application/octet-stream`: Blob's JSON MIME inference exposed
that mismatch in earlier attempts. Use the corresponding updated gateway and
companion together; rebuilding the download package belongs to final release.

The gateway request-body cap is 16 KiB and worker JSON descriptor cap is 32 KiB;
these are not encrypted-file upload limits. Upload URLs expire within 15 minutes,
worker-read URLs within five minutes, both capped by invitation expiry. Signed
PUTs disable overwrite/random suffixes and bound size/content type. Treat their
full URLs as private capabilities; never log or reconstruct their signed queries.

## One-shot outcomes and recovery

| Gateway status | Meaning and operator action |
| --- | --- |
| `AWAITING_UPLOAD` | Metadata exists and no claim/result/failure is recorded; not proof all files were uploaded |
| `RUNNING_OR_UNKNOWN` | Claim exists; work may still run or its outcome may be unavailable; inspect status without replaying |
| `FAILED_OR_UNKNOWN` | A failure marker exists; the worker may have received or performed work; do not retry this slot |
| `COMPLETED` | Gateway stored an encrypted result; customer decryption/reference verification remains a separate step |

Read status through `GET /api/cloud/jobs/<id>` with the customer's valid bearer.
Identical registration can be repeated before a claim; changed descriptors get
409. Once claimed, new upload registration and a second dispatch are blocked.
An evaluation request with an existing result returns completion without
dispatching again. This API does not expose a claim-reset or retry operation.

The worker deadline is at most 220 seconds, gateway fetch timeout 240 seconds,
configured Node function duration 300 seconds and companion transport budget
480 seconds. Worker busy/rejection, lost responses, timeouts, invalid replies or
storage errors can consume a slot. The companion neither retries mutation POSTs
nor automatically switches to local execution; it retains its used-ID ledger
across restarts. Even a slot reserved locally before failed registration is not
automatically reused.

Do not delete `claim.json`, erase the local used-ID ledger or resubmit the same
allocation to clear uncertainty. First inspect available status/results and safe
diagnostics. If an operator and customer explicitly choose a new attempt, issue
fresh job IDs and treat it as new work, without claiming the earlier work never
ran. A dead companion cannot recover its in-memory secret key by downloading the
encrypted result again.

## Cleanup and retention

| Location/data | Current behavior |
| --- | --- |
| Private Blob `job.json`, `claim.json`, `failure.json`, `result.json` | Seven-day TTL set on creation; encrypted result and public metadata remain available subject to the grant's earlier expiry |
| Private Blob uploaded inputs/evaluation keys/binding | One-day upload TTL; gateway attempts deletion in `finally` after claimed evaluation succeeds, fails or becomes uncertain |
| Worker job files | Private temporary directory (0700), files 0600; parent kills/waits for child process group before directory cleanup on normal error/success/timeout paths |
| Companion | Plaintext/title/result/secret-key state in memory; encrypted artifacts/public metadata may remain under ignored `runtime`; engine releases its temporary evaluation-key file; used-ID ledger persists |

Input deletion is best effort; deletion errors do not clear a claim. Uploads that
are never evaluated rely on their one-day TTL, and process termination may prevent
`finally` cleanup. Claims and result metadata are deliberately not deleted with
inputs. These TTL settings and cleanup paths do not establish immediate erasure
or provider/host-wide deletion guarantees. Never publish runtime files as support
evidence; use separately reviewed, sanitized evidence.

The current [storage-cleanup evidence](verification/cloud-storage-cleanup.json)
records `resultStored: true`, the matching smoke03 receipt digest and
`request.jsonRemoved: true`, `request.binRemoved: true`,
`evaluation.keysRemoved: true`. Input/key object removal is verified for this
successful run. Cleanup remains best effort for other outcomes, with one-day TTL
as fallback; this object-removal check does not establish provider-wide secure erasure.

## Worker staging and readiness checks

Use a fresh staging directory under ignored `runtime/`:

```sh
python3 scripts/package-cloud-worker.py runtime/cloud-worker-context-01
docker build --platform linux/amd64 \
  -f runtime/cloud-worker-context-01/Dockerfile.vercel \
  -t veil-worker:review runtime/cloud-worker-context-01
```

The packager rejects an existing destination and copies only allowlisted worker,
engine/portable sources, pinned public server/spec artifacts and requirements. It
writes `Dockerfile.vercel`, container-framework `vercel.json` and a SHA-256 build
inventory. It does not package customer runtime inputs, invitations or secret
keys. Deploy that isolated context separately from the frontend; supply worker
secrets at runtime, not during image build.

The Dockerfile targets Linux amd64, Python 3.11/Concrete 2.11.0, CPU Torch and a
non-root UID. `binutils` supplies the native linker and `ca-certificates` supports
verified HTTPS. The build preflight compiles/loads the approved portable circuit
and checks its exact client specs; it does not generate customer keys or evaluate
a customer job. Main reports container03 passed this preflight.

For release verification, distinguish gateway `/api/cloud/health` (presence of
worker configuration), worker `/health` (token/hostname configuration), nested
route smoke checks, private Blob access/signing checks and an actual synthetic
cloud job. Neither health endpoint runs an FHE test. Unit/transport tests use
explicit doubles and do not substitute for a cloud round trip. Smoke03 now records
the actual successful round trip in the public evidence linked above. For the
final Git release, verify the final deployment's READY state and source
commit, package the matching companion and keep that release check distinct from
the already completed live smoke. Any follow-up run should preserve the same
upload/evaluation/retrieval/local-verification checks while omitting credentials,
signed URLs and plaintext from published evidence.

Implementation references: [core.mjs](../cloud/gateway/core.mjs),
[blob.mjs](../cloud/gateway/blob.mjs), [remote.py](../service/remote.py),
[server.py](../service/server.py), [worker job.py](../cloud/worker/job.py),
[worker Dockerfile](../cloud/worker/Dockerfile),
[invitation script](../scripts/create-cloud-invitation.mjs),
[worker packager](../scripts/package-cloud-worker.py) and
[companion packager](../scripts/package-client.py).
