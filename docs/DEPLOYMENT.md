# GitHub, Vercel and the customer companion

Repository: [Foreveranka/veil-procurement](https://github.com/Foreveranka/veil-procurement) (private).
Frontend/gateway project: `veil-procurement`, scope `omermetehanizal-9130s-projects`.
Public entry: [veil-procurement.vercel.app](https://veil-procurement.vercel.app).

## Current status — 12 November 2026

The application now has a Node cloud gateway and a separate encrypted-only Linux
worker container, alongside the customer-owned Python companion. The previous
static-only description no longer describes the implemented cloud path. Native
FHE evaluation belongs to the worker container, not the Node gateway function.

**One actual cloud FHE run, smoke03, passed**: direct encrypted Blob uploads, evaluation on the
real Linux Vercel worker03 configured with 2 GB memory, result/receipt retrieval,
and local decryption/reference verification completed for synthetic inputs.
The sanitized [cloud FHE evidence](verification/cloud-fhe-live.json) records
`PASS`, `real_fhe: true`, `localReferenceMatched: true` and artifact/receipt hashes.
Total time was **37.714 s**, native evaluation **6.300 s**, server load **3.092 s**,
with **221,406,120 evaluation-key bytes**. This is a genuine verified pilot run,
not a load/reliability benchmark, payment test or execution proof.
The matching [cleanup evidence](verification/cloud-storage-cleanup.json) confirms
the result remains stored and `request.json`, `request.bin` and `evaluation.keys`
were removed. A **second run from the extracted customer ZIP also passed**
through its local HTTP companion and the real cloud evaluator in **40.129 s**.
The ZIP CRC and 27 file hashes matched. See [packaged-client-cloud.json](verification/packaged-client-cloud.json).
This reused the existing installed Concrete Python environment; it is not a fresh-machine installer test.

Linux container03 had first passed the portable-circuit compile/load preflight.
The completed round trip additionally exercised the explicit nested-route
rewrite after native catch-all requests had returned 404. A second fix aligned
Blob signing and companion uploads with filename-specific MIME types: JSON
manifests use `application/json`, ciphertext/key files `application/octet-stream`.
See [CLOUD-OPERATIONS.md](CLOUD-OPERATIONS.md) for the measured run and constraints.

Release verification must check READY, Git source commit and the served companion
ZIP hash after pushing main. The run evidence identifies the CLI deployments
actually exercised; it is not by itself proof of a later Git deployment.

## Deployment components

| Component | What runs there | Publication boundary |
| --- | --- | --- |
| Frontend and Node gateway | Landing `/`, companion instructions `/app`, recorded local evidence `/demo`, `/api/cloud/*` authorization and dispatch | Static assets plus `api/gateway.mjs`; no customer plaintext or decryption keys |
| Separate Linux worker container | `python -m cloud.worker.server`; downloads encrypted artifacts and evaluates the pinned portable circuit | Allowlisted worker/engine sources, public server/spec artifacts and pinned dependencies |
| Customer computer | Python companion, local UI, key generation, encryption, decryption and verification | Loopback `127.0.0.1`; customer invitation and secret key stay here |

`/api/jobs` and `/api/demo` remain companion endpoints, not hosted equivalents.
The hosted gateway uses the distinct `/api/cloud/*` namespace. `/demo` and
`demo-evidence.json` describe a recorded synthetic **local** run, not live cloud
execution. The root URL remains the introductory landing page.

The frontend project's [vercel.json](../vercel.json) uses `npm ci`,
`node scripts/build-web.mjs` and output directory `dist`. The build copies
allowlisted web assets and sanitized local evidence and creates `veil-client.zip`
through `scripts/package-client.py`. The companion package contains reviewed
source and public circuit/spec files, not customer invitations, runtime jobs or
decryption keys. [`.vercelignore`](../.vercelignore) controls deployment inputs;
the Node API is packaged separately from static `dist`.

### Cloud API routing

The deployed function is [api/gateway.mjs](../api/gateway.mjs), with a configured
300-second maximum duration. The explicit rewrite is:

```text
/api/cloud/:route*  ->  /api/gateway?route=:route*
```

The adapter requires exactly one valid `route` parameter, reconstructs the
`/api/cloud/…` path and invokes `createGateway`. Direct `/api/cloud/…` paths remain
accepted by the adapter for local/direct tests. The old
`api/cloud/[...path].mjs` deployment entry has been replaced. A health request
alone does not validate nested routes such as `/api/cloud/jobs/<id>/result`.

## Configuration and release procedure

[CLOUD-OPERATIONS.md](CLOUD-OPERATIONS.md) describes the separate gateway, worker
and companion environment variables, private invitations, direct encrypted Blob
uploads, six-day grant maximum, one-shot claims and retention behavior. Configure
those components independently; never give a customer the worker token or Blob
read/write token. Payments are not live, and independent MPC operators or
cryptographic execution proofs are not established by this deployment.

The Vercel GitHub integration follows `main` for the frontend/gateway production
deployment; other branches follow project settings. For an authorized release,
run relevant checks and `npm run build`, review the scoped source/package diff,
then use the agreed Git release process. Verify READY and the expected commit SHA.
A local edit does not deploy. The separately staged worker container has its own
deployment context and configuration; a frontend push does not by itself update
that worker. This documentation update performs no commit or deployment.

Never commit `.env*`, `.vercel`, `runtime`, invitations, wallet/private keys,
dependencies or native build directories. Never publish process environment dumps,
presigned URLs, customer records or raw runtime logs. New local evidence must pass
`scripts/archive-integration.py <runtime-run>` before inclusion; its consistency
checks are not a public execution proof. Keep cloud evidence separate from the
existing recorded local evidence.

Historical first Git-triggered frontend deployment: READY, `source=git`, commit
`3b1c038a3e463805debb86288e17a39b136a8d8f`. Evidence:
[verification/deployment-first.json](verification/deployment-first.json).
This historical record does not verify the current cloud worker or round trip.
