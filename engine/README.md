# Fixed-profile Concrete engine

`from engine.pipeline import prepare_job, run_job`

`run_job(records, job_dir, on_stage=None)` returns `records`, `verified`, `metrics`,
and `artifactHashes` as defined in `docs/BUILD-CONTRACT.md`. Call from a companion
worker thread. Its input is exactly four dictionaries containing only `id` and
`value`, both Python integers 0–255 (booleans rejected). Results preserve order and
IDs, flag every later occurrence of an ID, map value 255 to 0, and clamp other
values above 100 to 100. Duplicates are flagged, not removed.

Callbacks receive `(stage, message)` for `ENCRYPTING`, `EVALUATING`, `VERIFYING`.
Encryption status starts before the potentially slow Concrete import. Exceptions
fail the job; there is no simulated/plaintext fallback. Callback exceptions also
propagate. A thread lock plus a shared advisory file lock serializes jobs, including
fresh key generation, across cooperating local service processes using this engine.
The evaluator has a 600-second subprocess deadline. Timing metrics are measured;
`queue_seconds` is separate from `total_seconds` (which includes library import).
An explicitly configured parent bytecode-cache prefix is forwarded with Python's
`-X pycache_prefix` so isolated startup can read existing dependency bytecode.
`-B` prevents writes to those caches or the read-only research virtualenv.

## Staged integration API (request protocol v2)

```python
from engine.pipeline import prepare_job

with prepare_job(records, job_dir, on_stage=on_stage) as prepared:
    # Actual fresh keys + encryption have finished; evaluator has NOT run.
    # Mapping proxies are immutable snapshots. These four hashes never change.
    hashes = prepared.artifact_hashes
    local_attempt_id = prepared.manifest["attemptId"]
    # Register the hashes, obtain/authenticate the chosen registry attempt, then:
    prepared.bind_external({
        "job_id": "42",                    # canonical decimal U64 string
        "attempt": "1",                    # canonical positive U64 string
        "job_binding_hash": job_hash_hex,   # lowercase 64-hex SHA-256
        "attempt_binding_hash": attempt_hash_hex,
        "bidset_root": bidset_root_hex,
    })
    # Final request bytes/hash are now sealed, before evaluation.
    request_bytes = prepared.manifest_bytes
    request_sha = prepared.artifact_hashes["requestManifestSha256"]
    worker_metadata = prepared.evaluate()   # no client decrypt yet
    result = prepared.finalize()            # same result/metrics shape as run_job
```

`prepare_job(records, job_dir, on_stage=None) -> PreparedJob` generates the real
Concrete keyset and encrypted input immediately, retaining the client/SK only in
this live session. `manifest`, `manifest_bytes`, `artifact_hashes`, `state` and
`external_binding` are public read-only properties. The initial manifest contains
v1's fixed core fields, but is not written or evaluated: it supplies circuit/spec,
key/input hashes and the fresh local attempt ID for registration. There is no
`requestManifestSha256` yet in `artifact_hashes`. `bind_external()` snapshots its
argument and seals a **new** immutable v2 manifest once; existing public snapshots
remain unchanged. No ciphertext/key/circuit/local-attempt hash changes on binding.
The final sealed manifest/hash stays unchanged through evaluation/finalization.

The exact `binding.json` object has the five snake_case fields shown above,
no extras. Registry hashes are hex strings, not NEAR byte arrays: convert an
already validated registry hash with `bytes(hash_array).hex()`. The caller must
authenticate the registry snapshot and validate registry hash derivations/policy;
the engine validates its shape and retains its exact bytes, without independently
querying NEAR or proving that the supplied context is authoritative.

`binding.json` is canonical compact sorted-key JSON. `request.json` contains the
original seven fields with `protocolVersion: 2`, plus `externalBindingSha256`, the
SHA-256 of those exact canonical external bytes. The worker validates the external
file before loading Concrete and echoes the **entire** request and its exact hash
in `receipt.json`, alongside output ciphertext hash and measured worker timings.
Finalization checks the original session request, binding and public artifacts,
then checks the exact evaluated receipt/output snapshots before decrypting and
comparing against the reference. Edits, substitutions, missing files and symlinks
fail; a response from a different request/attempt/context is rejected. A rewritten
receipt is not authenticated: these are hash bindings of reported context, **not
proof that the evaluator executed that context or an execution proof**. An
authenticated execution claim remains the registry executor's responsibility.

`evaluate()` returns a recursively immutable mapping with exactly `receipt`,
`receiptSha256`, `outputSha256`, `output_bytes`, `requestManifestSha256`. `receipt`
has the unchanged worker-receipt schema; ciphertext is in `job_dir/response.bin`.
No plaintext is returned by evaluation. `finalize()` returns the old
`{records, verified, metrics, artifactHashes}` object; its metrics schema is
unchanged, with `artifactHashes.externalBindingSha256` added only for v2.
Pass the **original bytes** of request/receipt/binding files to the SDK adapter,
not JSON reconstructed from mapping proxies.

States are `PREPARED -> BOUND -> EVALUATING -> EVALUATED -> FINALIZING -> FINALIZED`.
Evaluation without binding, finalization before evaluation, rebinding and repeated
evaluation/finalization raise `RuntimeError`. Wrong-state calls do not advance the
session; tamper, operation or callback failures set `FAILED` and close resources.
Malformed bindings raise `ValueError` and close the session. `close()` is
idempotent; early close/context exit sets `CLOSED`. On success, finalize releases
resources immediately and preserves `FINALIZED`. Pickling the session is rejected.
No session restore API, SK serialization, arbitrary artifact unpickling or
plaintext result file exists. Session cleanup releases references, not a verified
zeroization of Python/native memory.

A live prepared session owns the single-worker thread/process advisory lock from
key generation until finalize/close. Keep registry work inside that session and
close it promptly; do not start/wait for another engine preparation before closing
the current session. A second caller intentionally waits for this memory-heavy
slot. The engine does not hold registry/account/network credentials.

The compatibility `run_job(records, job_dir, on_stage=None)` composes the same
prepare/evaluate/finalize implementation with a private v1 mode that needs no
external binding. Its result, metrics, seven artifact-hash keys, callback order
and six retained files remain unchanged. Use staged v2 when registry context must
be sealed before encrypted evaluation.

## Runtime and provenance

Run the **client service** with the existing research Python 3.9 virtualenv:

```sh
'/Users/mete/Desktop/NEAR-Hackathon-2026-Arastirma/Gizli-Is-Pazari-Fizibilite/Sifresini-Acmadan-Hesaplama/Deney/.venv/bin/python' -B -X pycache_prefix=/Users/mete/Library/Caches/com.apple.python -m unittest discover -s engine/tests -v
```

No install/recompile is needed. The evaluator uses `sys.executable` by default;
optional `VEIL_FHE_PYTHON` selects another compatible evaluator interpreter.
This override does not move plaintext/client key operations to that interpreter:
the service itself must have `concrete-python==2.11.0` and NumPy installed.
The archived compiled binary is macOS/platform specific; another platform needs
an independently built and reviewed artifact and a deliberate pin update.
The separately reviewed [portable clean4 build](portable/README.md) now supplies
that opt-in path. Existing macOS pins/defaults and `run_job` remain unchanged.

`VEIL_FHE_ARTIFACT_DIR` optionally selects a directory containing the same two
approved files. `engine/artifacts` is the default, so runtime does not depend on
the research directory. SHA-256 pins are in `protocol.py`; disk `SHA256.json`
documents the pins and cannot override them. Only `server.zip` (about 101 KiB) and
`client-specs.json` (about 3.6 KiB) were copied from research
`Sifresini-Acmadan-Hesaplama/Deney/outputs/clean-4-records`.
Research source/artifacts remain read-only. Byte-exact source archives and their SHA-256 identities are included under `provenance/` for review; they are not executed by this engine. The historical `run_experiment.py` defines:

- Input: 64 bits, four 8-bit IDs followed by four 8-bit values, LSB first per byte.
- Output: four duplicate bits followed by four 8-bit cleaned values, LSB first.
- Output IDs are preserved from the client's input, not returned by this circuit.

## Process boundary and retention

Each session constructs a new client and fresh entropy-backed keyset with no keyset
cache. The secret key and all input/decrypted records stay in client memory.
The evaluator is a fresh exec with isolated Python imports, a minimal environment,
closed stdin, and no plaintext arguments. It receives only public compiled
artifacts, the public evaluation key, ciphertext and non-secret metadata.
It never constructs a client, deserializes a secret key, or decrypts.
Both processes verify the hardcoded artifact allowlist before native loading.
The pinned ZIP contains compiled libraries/specs, not a user pickle/MLIR config.

`job_dir` must be absent or empty; it is made private (0700); files are 0600.
After legacy v1 success it contains exactly:

- `server.zip`, `client-specs.json`: approved public artifact copies.
- `request.bin`, `response.bin`: encrypted input/output.
- `request.json`, `receipt.json`: attempt ID, fixed profile, circuit/spec/key/input
  digests, output digest and measured evaluator timings, with no record values.

Staged v2 additionally retains `binding.json`, containing public registry context.
The roughly 221 MB per-job `evaluation.keys` exists while preparation is live and
is deleted immediately after evaluation (or on any early close/failure). The
client/SK remains in memory until finalize/close. Worker temporary extracted public libraries are also removed.
**The evaluation-key hash records which key was used; it does not mean that key is
archived or that evaluation can be rerun from the retained files.** There is no
secret-key serialization or plaintext result/log file. Failures may leave partial
encrypted/public audit files; retry with a new empty directory. Abrupt process
termination cannot execute `finally`; operators may delete abandoned encrypted
runtime directories. The engine never deletes research files.

The client checks the receipt's exact request/attempt and manifest hash, checks
the ciphertext output hash, decrypts, and compares every output with a local
plaintext reference. `verified: true` means this client comparison passed.
`verification_method: client_plaintext_reference` and
`verification_is_cryptographic_proof: false` are explicit metrics. A hash receipt
is not a signature, attestation, or proof of correct computation. The client
already knows the input. Separate same-UID processes do not provide host isolation
against a malicious machine owner. This engine does not implement a private
multi-owner auction, payments, generic CSV transforms, or browser-native FHE.

## Verification

The standard-library unit suite covers invalid schema/ranges, archived bit layout,
duplicate/sentinel/clamp boundaries, artifact and symlink rejection, ciphertext/key
substitution, attempt/circuit/manifest/output binding, invalid evaluator metrics,
isolated subprocess configuration/timeouts, and evaluation-key cleanup on success
and failure. It does not need Concrete for these tests.

To run the genuine synthetic FHE smoke with the same interpreter, set
`VEIL_RUN_FHE_SMOKE=1` and select
`engine.tests.test_pipeline.RealFheSmoke` and
`engine.tests.test_staged.RealStagedFhe` (or run the whole suite). This generates
fresh keys, uses the real subprocess evaluator, decrypts and verifies the result,
and asserts the retained file allowlist and evaluation-key deletion. Its output
prints only verification status and measured metrics, never record contents.

Verified locally on 2026-11-11 using the existing research venv, with no installs:
all 23 tests passed in 9.832 s with `VEIL_RUN_FHE_SMOKE=1`. Genuine synthetic job:
8.263 s total, 0.708 s fresh key generation, 6.769 s worker wall time including
4.794 s encrypted evaluation, 0.002 s decryption. Ciphertext input/output were
787,192 / 442,904 bytes. The 221,406,120-byte evaluation key was removed.
The real test blocked `fhe.Keys.save`, `serialize`, and `serialize_to_file` while
the pipeline ran, and verified the final six-file audit allowlist.

An earlier diagnostic attempt was intentionally stopped during dependency import:
isolated Python had discarded the parent's cache prefix and was reading Desktop
dependency sources slowly. That attempt did not finish FHE evaluation and is not
counted as a passing smoke. Forwarding the existing cache prefix fixed startup.

## Staged verification evidence (2026-11-11)

`evidence/staged-fhe/all-engine-tests.log` records all 37 engine tests passing,
including both genuine legacy and staged FHE tests, in 20.275 seconds. Staged
synthetic run: 9.316 s total, 0.734 s fresh key generation, 4.963 s actual encrypted
evaluation, 0.005 s decryption; request/output 787,192 / 442,904 bytes. The
221,406,120-byte evaluation key was deleted; client references were released.
`fhe.Keys.save`, `serialize`, and `serialize_to_file` were blocked during the
actual tests. No secret key or decrypted result was saved. The staged test checked
that preparation stopped before evaluation and required explicit context binding.

Two additional key-deletion/reappearance tamper tests were then added.
`follow-up-unit-tests.log` records all 37 current unit tests passing (39 tests
discovered, the two already-passed real smoke tests intentionally skipped). For
that unit-only follow-up the serialization context was replaced with a no-op to
avoid contending with main's concurrently running integration; all subprocess
evaluation in those lifecycle unit tests uses explicitly labeled doubles.

`evidence/staged-fhe/{request,receipt,binding}.json` are the **original** public
manifest bytes from that real execution; `evidence.json` contains measured
metrics/hashes/cleanup observations only. The registry context there is synthetic,
not a claim of having exercised a registry sandbox. Engine worker execution is a
local subprocess test, not a NEAR or security sandbox. Parent integration owns any
actual registry-sandbox evidence. Unit tests with explicit lifecycle doubles are
not counted as FHE evidence. The evidence does not establish production security,
remote host isolation, independent parties or a cryptographic execution proof.

To regenerate evidence, prefix the full test command with
`VEIL_RUN_FHE_SMOKE=1 VEIL_FHE_EVIDENCE_DIR=/Users/mete/near-private-procurement/engine/evidence/staged-fhe`.
The Python 3.9 installation reports `/Users/mete/Library/Caches/com.apple.python`
as its effective `sys.pycache_prefix` even with the environment variable unset.
Use the explicit `-X pycache_prefix` in the command above for repeatability; `-B`
keeps both client and evaluator from writing dependency bytecode.
