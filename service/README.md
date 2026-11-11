# Local client companion

Python 3.9 stdlib HTTP service for the fixed `clean-4-records-v1` profile.
From the repository root:

```sh
python3 -m service.server --port 8765
python3 -m unittest discover -s service/tests -v
```

Production execution needs the existing Concrete-capable interpreter selected by
the main project's launcher. No dependencies are installed by this component.
The service imports `engine.pipeline.run_job` inside its one executor worker;
it does not implement, simulate, or substitute FHE. Real FHE end-to-end checks
belong to the main integration scripts. Every fake pipeline in `service/tests/`
is explicitly test-only.

`create_server(host='127.0.0.1', port=8765, runtime_dir=None, pipeline=None)`
returns a bound `ThreadingHTTPServer`. `.state` exposes process-local state;
`.origin` and `.expected_host` reflect the actual bound port, including `port=0`.
Call `.serve_forever()` to run, `.shutdown()` from a separate thread to stop the
serve loop, and `.server_close()` to drain the bounded FHE queue and release the
socket. `pipeline` is a trusted injected test callable matching the engine
interface; it cannot be selected through HTTP. `--runtime-dir` overrides the
default repository `runtime/` path.

## HTTP contract and browser entry

- `GET /health`: `{ok:true}`.
- `GET /api/capabilities`: profile, capability details, session CSRF token.
- `GET /api/jobs`, `GET /api/jobs/:id`: process-local job history/detail.
- `POST /api/jobs`: JSON `{title,records}`; responds `201 {job}` immediately,
  with `QUEUED` followed by actual engine callbacks and a terminal status.
- Public static allowlist: `/` → `web/index.html`, `/app` → `web/app.html`,
  `/styles.css`, `/app.js`, `/input.mjs`. No uploads, arbitrary paths, runtime files,
  symlinks, directory listings, or user-supplied executable artifacts are served.

Every request must use the exact `Host: 127.0.0.1:<bound-port>`.
Foreign or `null` Origin headers are always rejected, including on reads.
GET/HEAD without Origin are allowed, as ordinary same-origin browser requests
often omit it. `Sec-Fetch-Site: cross-site` and `same-site` are rejected except
for GET/HEAD navigation to `/` or `/app` with both `Sec-Fetch-Mode: navigate`
and `Sec-Fetch-Dest: document`. This permits entry from another website or
extension, while denying cross-site API access, iframe navigation, and asset
requests. Page assets load subsequently from the same origin.

**Mutations, including CLI POST requests, require BOTH**
`Origin: http://127.0.0.1:<bound-port>` and
`X-CSRF-Token: <csrfToken from capabilities>`. A token without Origin is rejected.
There are no permissive CORS headers. Responses use `Cache-Control: no-store`,
a self-only CSP without inline scripts/styles, `nosniff`, frame denial, and
same-origin resource policy. These are browser boundary controls, not isolation
from other processes running with the same local user privileges.

Requests require UTF-8 `application/json`, a single valid Content-Length, no
transfer/content encoding, and at most 65,536 bytes. Titles contain 1–120
characters with no control characters. Records are exactly four objects with
only `id` and `value`; both are integers 0–255. Booleans, floats, duplicate JSON
keys, non-finite numbers, and unknown fields are rejected.

## State, limits, errors, capabilities

One worker runs at a time. Running plus queued work is capped at eight; excess
requests receive 429. History is capped at 64 total jobs per session, with no
eviction of active or completed jobs. The 65th submission receives a clear 429
asking the user to restart to clear history. A restart clears titles, inputs,
results, and history from the service session; it does not delete ciphertext
artifacts. Closing the server waits for already accepted jobs to finish.

The service writes no metadata, titles, plaintext records, decrypted results,
or secret keys to disk. It creates a private job directory and gives the engine
only the four input records, that directory, and a stage callback. The trusted
engine is responsible for writing only public/encrypted artifacts and cleaning
its large temporary evaluation keys. Inputs live only in queued/running task
memory; results live in bounded session memory. No request logs, raw exception
text, or tracebacks are emitted. Stage messages are fixed; engine callback text
is not exposed. Invalid output or `verified:false` produces FAILED, never
COMPLETED. Only validated result/metrics/hash fields enter the API.

The FHE capability is `pending` until a real engine job verifies successfully,
then `available` for this session. An injected callable is always `test-only`.
MPC and NEAR integrations remain `pending` irrespective of other component
files or their individual tests; these components can be connected after
integration and verification. Payments are `disabled`. No production security,
browser-native FHE, remote attestation, or independently operated MPC claim is
made by this service.
