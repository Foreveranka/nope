# Encrypted HTTP evaluator

This is the encrypted-only worker for the tenant-authenticated Node gateway in
`cloud/gateway/`. It does not hold customer plaintext, client instances or secret
keys. The gateway uses hashed bearer invitations and an owner/job-ID allowlist for
authorization, plus durable private Blob create-if-absent metadata and evaluation
claims. It issues presigned URLs after authorization. This worker trusts the
gateway's shared bearer secret and the presigned file scope, restricted to the
exact configured Blob hostname; it does not independently authenticate tenants.

## API

`GET /health` returns only `{version,configured}`. `configured` means the worker
token and exact blob hostname are present and valid; it is not an FHE readiness
or remote evaluation test. There is no public expensive test endpoint.

`POST /evaluate` requires `Authorization: Bearer <VEIL_WORKER_TOKEN>` and JSON,
with one Content-Length and no Transfer-Encoding. The body is capped at 32 KiB:

```json
{
  "files": [
    {"name":"request.bin","size":1,"sha256":"<64 lowercase hex>","url":"<presigned HTTPS URL>"},
    {"name":"evaluation.keys","size":1,"sha256":"<64 lowercase hex>","url":"<presigned HTTPS URL>"},
    {"name":"request.json","size":1,"sha256":"<64 lowercase hex>","url":"<presigned HTTPS URL>"}
  ],
  "requestManifestSha256":"<SHA-256 of original request.json bytes>"
}
```

The three mandatory filenames above are accepted, optionally with `binding.json`
for protocol v2. No other files, duplicate names, duplicate JSON keys or extra
properties are accepted. Limits are 2 MiB for request.bin, 512 MiB for
evaluation.keys and 8 KiB each for request.json/binding.json. The manifest digest
must match its descriptor. The engine independently validates the manifest,
circuit/spec pins, encrypted input/evaluation-key hashes and v2 external binding.

The response is:

```json
{
  "receipt": {"requestManifestSha256":"...","request":{},"outputSha256":"...","metrics":{}},
  "receiptBase64":"<original receipt.json bytes>",
  "outputBase64":"<response.bin ciphertext>",
  "receiptSha256":"<SHA-256 of original receipt.json bytes>",
  "outputSha256":"<SHA-256 of response.bin>"
}
```

The gateway/client must hash and parse the decoded original receipt bytes and
check the parsed value against `receipt`. Do not hash a JavaScript reserialization:
floating-point encodings can differ from Python canonical JSON. The worker calls
`engine.protocol.verify_receipt` and checks Python canonical bytes before returning
anything. Outputs are bounded at 512 KiB and receipts at 16 KiB, fitting the
gateway's bounded response reader.

Authentication fails closed when configuration is absent. Busy evaluation returns
503 immediately; health stays responsive. All request/job errors are generic JSON;
they never include URLs, credentials, native exception messages or input data.

## Network and process limits

- `VEIL_BLOB_HOST` is one exact lowercase DNS hostname. For this deployment it is
  `te8dxe3fezmhyqku.private.blob.vercel-storage.com`; no suffix/wildcard allowlist.
- Downloads require HTTPS, port 443, no userinfo, fragments, control characters,
  backslashes or IP-literal hosts. No proxy environment variables are used.
- All DNS answers must be public addresses. The connection uses the checked IP
  directly while retaining certificate/hostname verification and TLS SNI for the
  configured hostname, avoiding a second DNS lookup. Redirects are rejected.
- Download bytes are streamed, measured and SHA-256 checked; identity encoding is
  requested, unexpected encoding/framing and mismatching Content-Length fail.
- There is one evaluation slot per process, at most 32 HTTP handler threads, a
  32 KiB body limit and an absolute 10-second body-read budget.
- The entire download/import/compile/evaluation runs in a disposable subprocess
  with a 220-second wall deadline (configurable downward), CPU/file/descriptor/core
  limits and Linux RLIMIT_AS (8 GiB by default). This virtual-address limit is not
  an RSS limit and does not replace the platform's 2 GiB resident memory limit.
- The parent kills the process group before releasing the slot or deleting job
  files, including on timeout/failure. Job directories use 0700 and files 0600.
  Worker token/presigned URLs are absent from child argv/environment; URLs are
  sent only over stdin. Child stdout/stderr is discarded.
- Failed child exit codes produce only a fixed parent diagnostic stage: schema,
  download, profile, runtime_import, native_evaluation, process_setup, native_exit
  or deadline. No arbitrary exception text is logged.

These bounds do not constitute an OS sandbox or proof of correct computation.
Use the hosting platform's memory/process/network controls as well. The gateway's
240-second timeout leaves a small response/cleanup margin above the job deadline.

## Container and engine integration

Build context is the repository root (main owns root context/deployment setup):

```sh
docker build --platform linux/amd64 -f cloud/worker/Dockerfile -t veil-worker .
```

The Dockerfile uses Python 3.11 on Debian bookworm, a non-root UID, explicit source
copies and pinned dependencies. It first installs `torch==2.8.0+cpu` without
dependencies from the [official CPU wheel index](https://download.pytorch.org/whl/cpu/torch/),
then installs the pinned requirement set and runs `pip check`. The
[Concrete 2.11 release metadata](https://pypi.org/pypi/concrete-python/2.11.0/json)
confirms Python >=3.9, a CPython 3.11 manylinux_2_28 x86_64 wheel, and runtime
dependencies importlib-resources, jsonpickle, networkx, NumPy<2, SciPy, Torch and
z3-solver==4.13.0. There is no Linux arm64 wheel in that release.

Linux requires the GNU linker (`ld`, provided by Debian `binutils`) and
`ca-certificates` for verified HTTPS downloads. Concrete's bundled LLVM does not
replace the system linker: Linux build02 reached `Server.create` artifact emission
and failed with `ld: not found`. Build03 includes these packages. Its Linux preflight and an actual encrypted
round trip on Vercel passed; see `docs/verification/cloud-fhe-live.json`.

After source copy and switching to the non-root user, the build performs a real
Linux public-circuit compile/load via `load_server` and verifies exact client
specs. It neither generates keys nor evaluates customer inputs.

Required environment: `VEIL_WORKER_TOKEN`, `VEIL_BLOB_HOST`.
Optional: `PORT` (8080), `VEIL_WORKER_TIMEOUT_SECONDS` (1..220),
`VEIL_WORKER_MEMORY_MB` (1024..65536; default 8192).
Do not bake secrets into image layers or public deployment configuration.

The child uses `approved_artifacts(artifact_set='portable-v1')` from deployed code,
copies only its pinned server/spec bytes into the private job and calls
`engine.worker.evaluate(root)`. The portable server is loaded using the engine's
pinned MLIR path rather than user-supplied configuration/jsonpickle. The deployed
portable server pin is
`898b318b83ccdfaa3fde53265fcee1ac2e14c6b32b739e80a75d508eb8f154d5`;
client specs pin is
`87b1dd33c9db661f215962b975df389c3f4f7b2fb6123fb7721ac985766475f3`.
There is no transport fallback to a client/local plaintext implementation.

## Verification

```sh
PYTHONDONTWRITEBYTECODE=1 python3 -m unittest discover -s cloud/worker/tests -v
```

15 synthetic tests pass locally: strict payload/URL/auth/framing validation,
private/mixed DNS rejection and pinned TLS addressing, redirects, streaming
size/hash/header failures, symlink defense, temp modes/cleanup, generic failures,
exact receipt bytes, busy concurrency/health, real subprocess timeout/process-group
termination, safe stage diagnostics and child secret-environment isolation.

HTTP tests inject an evaluator; they are transport tests, not genuine FHE proof.
The real engine adapter is implemented. Linux container build/preflight and a
genuine remote encrypted round trip under the platform's 2 GiB memory budget must
be verified by main's hosting work. This worker task performs no deployment or
commit and edits only `cloud/worker/`.
