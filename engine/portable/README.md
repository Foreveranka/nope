# Portable clean4, Concrete 2.11.0

Use **CPython 3.11, Linux x86-64, glibc >= 2.28, CPU**, with
`concrete-python==2.11.0`, `numpy==1.26.4`, `scipy==1.13.1`, and
`torch==2.8.0+cpu`. The Concrete CPython 3.11 manylinux wheel exists on PyPI;
its SHA-256 is pinned in `requirements-linux-cp311.lock`. All 15 runtime wheels,
including transitive dependencies, are version/hash locked. The PyTorch URL is
explicitly the official CPU wheel, avoiding CUDA dependencies. Deployment owns
pinning its Python patch/base image digest and OS libraries; this lock does not
freeze the container OS. No dependency/global configuration was changed locally.

```sh
python3.11 -m pip install -r engine/portable/requirements-linux-cp311.lock
python3.11 -m engine.portable.build /tmp/clean4-candidate --check-approved
```

The build destination must be empty. `clean4.py` is the complete isolated compiler
source: it imports no research experiment and performs no top-level compilation,
I/O or key generation. The Boolean circuit and bit layout are extracted from the
archived `provenance/run_experiment.py.txt`; the unrelated auction is excluded.
Two fixed all-zero/all-one uint1 vectors establish every input bit's full range.
There is no random inputset or key-generation seed. Options request 128-bit
security, global error <= 1e-8, CPU execution, chunked strategies and no unsafe
features, insecure key cache or simulation. Concrete 2.11 defaults supply the
remaining configuration. The original macOS native ZIP/pins/API are unchanged.

## Approved public artifacts

`engine/artifacts/portable-clean4-v1/` contains:

- `server.zip`: deterministic ZIP_STORED MLIR, fixed options, specs and simulation
  marker; SHA-256 `898b318b83ccdfaa3fde53265fcee1ac2e14c6b32b739e80a75d508eb8f154d5`.
- `client-specs.json`: SHA-256
  `87b1dd33c9db661f215962b975df389c3f4f7b2fb6123fb7721ac985766475f3`, identical
  to the legacy client specs.
- `BUILD.json`: source identity, per-member hashes, compiler/NumPy versions,
  deterministic inputset, options and reported error probability.
- `SHA256.json`: the three public file identities; it cannot override source pins.

`pins.py` pins the two accepted artifacts and `clean4.py` source identity
`b535c7f4c9f92d272b325ffc315a08fb910d38918e93cefe01943a97de9a35a9`.
`BUILD-SOURCE-SHA256.json` identifies the additional build/runtime/lock files.
`--check-approved` fails if a rebuild differs from those reviewed source/artifact
pins. It never updates pins or replaces approved files. Two independent local
builds produced byte-identical ZIP, specs, BUILD and hash manifest; host observations
are deliberately stored separately in each candidate's `build-host.json`.
Reproducibility here means the portable source/MLIR bundle, not byte-identical
CPU-specific native shared libraries. Linux rebuild identity still requires its
own measured test; local evidence is macOS ARM64 Python 3.9.6/Concrete 2.11.0.

The supported `server.save(..., via_mlir=True)` API exports MLIR. We use that
public API at build time and repack only reviewed members with fixed ZIP metadata.
The raw Concrete MLIR ZIP is not distributed: its configuration uses jsonpickle.

## Worker integration

```python
from engine.protocol import approved_artifacts
from engine.portable.runtime import load_server
from engine.worker import evaluate

artifacts = approved_artifacts(artifact_set="portable-v1")
server = load_server(artifacts)   # cold native compilation once per warm process
evaluate(job_dir, server=server)  # sequential jobs only, bounded by the transport
```

`evaluate(job_dir)` also works and cold-loads the manifest-selected artifact set.
The job directory contains approved `server.zip`/`client-specs.json` copies and
three public/encrypted request files: `request.json`, `request.bin`,
`evaluation.keys`; bound v2 adds `binding.json`. Output is exactly
`response.bin` and `receipt.json`. A deployment must accept only the fixed
portable artifact pair; it must not let remote callers choose native ZIPs/MLIR.
The engine retains legacy macOS acceptance for local compatibility, so a public
worker must additionally enforce `manifest_artifact_set(manifest) == 'portable-v1'`.
The transport owns authentication, size/time/resource limits, HTTPS and storage.
Warm-server tags/spec checks bind cooperating trusted host code; they are not
attestation against an operator who can alter that code. Worker timings measure
per-request load/validation, so warm `server_load_seconds` excludes cold startup.

## Local client / caller-owned transport

```python
from engine.pipeline import prepare_remote_job

# Optional downloaded_artifacts is exactly server.zip/client-specs.json -> bytes.
# Pinned digest checks run before native specs parsing or key generation.
with prepare_remote_job(records, job_dir, artifacts=downloaded_artifacts) as job:
    metadata = job.evaluate_remote(transport)
    result = job.finalize()  # SK/plaintext stay here; reference check is mandatory
```

Omit `artifacts` to use the bundled approved pair. Downloading a deployment's
public files does not approve a new circuit: hardcoded pins remain authoritative.
For authenticated registry context use
`prepare_job(..., artifact_set='portable-v1')`, then `bind_external(context)` and
`evaluate_remote(transport)`. Plain v1 needs no invented registry binding.

`transport(payload)` receives an immutable mapping of **five** v1 or **six** v2
filenames to original bytes: the two public artifacts plus the three/four request
files. No path, record list, client object or SK is supplied. A deployment with
preinstalled artifacts uploads only the three/four per-job files. The callback
returns exactly `{'response.bin': ciphertext_bytes, 'receipt.json': receipt_bytes}`.
For a JSON HTTP response, decode `outputBase64` and **receiptBase64**; never
reconstruct the receipt from parsed JSON (float formatting changes its hash).
Callback/network deadlines are the caller's responsibility. The engine performs
no network calls, signing or payments. Callback code itself is trusted local code
and must not retain payloads or capture the enclosing live client session.

Before transport, the engine checks exact artifact/key/input/context/request
snapshots; before decrypting it checks the sealed request, receipt/output hashes,
and retained files again. Errors fail closed and release the client and session
evaluation-key file. Success deletes that file before finalization. A remote
operator or transport may retain received evaluation keys/ciphertexts; local
cleanup does not establish remote deletion. The key hash is not a secret-key hash.

## Deserialization and limits

`load_server` verifies pinned bytes first, requires the exact four ZIP members,
reads without extraction, and uses `Server.create` with the source-fixed
`Configuration`. It never calls `jsonpickle.loads`, Python pickle or the generic
MLIR `Server.load`. Pinned `ClientSpecs.deserialize` uses JSON/native ProgramInfo;
its TFHE-rs descriptors must be passed through to reproduce exact specs. Omitting
those descriptors caused the initial smoke failure and was corrected without
changing the artifact. Post-compilation specs must match the pinned bytes exactly.

Ciphertext/evaluation-key deserialization still uses Concrete's native parsers.
Size/hash checks and fixed artifacts do not prove those parsers memory-safe or
make malicious ciphertext safe. Host isolation, native-parser hardening and
resource enforcement remain deployment responsibilities. Hash receipts are not
authenticated execution proofs; a malicious evaluator can fabricate timings or a
receipt. Final `verified` means local decryption matched the known plaintext
reference. No production-security, independent-party or remote-deletion claim.

`engine/evidence/portable-fhe/all-engine-tests.log` records **47/47 passing tests**,
including genuine legacy, bound legacy and portable v1/v2 subprocess FHE runs
(39.126 s). `warm-follow-up.log` adds actual portable cold subprocess execution
and warm v2 server reuse with `jsonpickle.loads` and `Server.load` blocked.
Original public request/receipt/binding bytes and metrics are retained there;
no SK, plaintext result, evaluation keys or ciphertext blobs are archived as evidence.
Follow-up cold load: 2.955 s, encrypted evaluation 4.529 s; warm evaluation 4.577 s.
Input/output were 787,192/442,904 bytes, evaluation keys 221,406,120 bytes.
Local results do not establish Linux performance, peak memory or the 2 GB/300 s
hosting limits. Main owns the real Linux container/deployment test.

```sh
VEIL_RUN_FHE_SMOKE=1 VEIL_PORTABLE_EVIDENCE_DIR="$PWD/engine/evidence/portable-fhe" \
  .venv/bin/python -B -m unittest discover -s engine/tests -v
```
