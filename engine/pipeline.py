"""Client-owned, fixed four-record FHE pipeline; plaintext and SK stay in memory."""
import contextlib
import fcntl
import json
import os
import subprocess
import sys
import tempfile
import threading
import time
import uuid
from pathlib import Path
from types import MappingProxyType

from .protocol import (ARTIFACT_PINS, ENGINE_DIR, PROFILE_ID,
                       approved_artifacts, canonical_json, read_regular,
                       require_runtime, sha256, validate_external_binding,
                       verify_external_binding, verify_receipt, write_new)

_JOB_LOCK = threading.Lock()


def validate_records(records):
    if not isinstance(records, list) or len(records) != 4:
        raise ValueError("Exactly four records are required")
    clean = []
    for record in records:
        if not isinstance(record, dict) or set(record) != {"id", "value"}:
            raise ValueError("Each record requires only id and value")
        if any(type(record[key]) is not int or not 0 <= record[key] <= 255
               for key in ("id", "value")):
            raise ValueError("id and value must be integers from 0 through 255")
        clean.append({"id": record["id"], "value": record["value"]})
    return clean


def reference_result(records):
    records = validate_records(records)
    seen = set()
    result = []
    for record in records:
        identifier, value = record["id"], record["value"]
        result.append({"id": identifier, "value": 0 if value == 255 else min(value, 100),
                       "duplicate": identifier in seen})
        seen.add(identifier)
    return result


def encode_bits(records):
    """64 bits: ids[0:4], values[0:4], each unsigned byte LSB first."""
    fields = [record["id"] for record in records] + [record["value"] for record in records]
    return [(field >> bit) & 1 for field in fields for bit in range(8)]


def decode_output(records, bits):
    bits = list(bits)
    if len(bits) != 36 or any(bit not in (0, 1) for bit in bits):
        raise ValueError("Invalid decrypted circuit output")
    return [{"id": records[i]["id"], "duplicate": bool(bits[i]),
             "value": sum(int(bits[4 + i * 8 + k]) << k for k in range(8))}
            for i in range(4)]


@contextlib.contextmanager
def _serialized_worker():
    # Both threads and separate local service processes share this lock.
    with _JOB_LOCK:
        lock_dir = ENGINE_DIR / "runtime"
        lock_dir.mkdir(mode=0o700, exist_ok=True)
        descriptor = os.open(str(lock_dir / "fhe.lock"), os.O_CREAT | os.O_RDWR | os.O_NOFOLLOW, 0o600)
        try:
            fcntl.flock(descriptor, fcntl.LOCK_EX)
            yield
        finally:
            fcntl.flock(descriptor, fcntl.LOCK_UN)
            os.close(descriptor)


def _new_job_dir(job_dir):
    root = Path(job_dir).absolute()
    if root.is_symlink():
        raise ValueError("Job directory must not be a symlink")
    root.mkdir(mode=0o700, parents=True, exist_ok=True)
    if not root.is_dir() or any(root.iterdir()):
        raise ValueError("Job directory must be empty and dedicated to this attempt")
    root.chmod(0o700)
    return root


def _evaluate_subprocess(root):
    python = os.environ.get("VEIL_FHE_PYTHON", sys.executable)
    if not Path(python).is_file():
        raise RuntimeError("VEIL_FHE_PYTHON must identify a Concrete 2.11 interpreter")
    # An exec'd interpreter, not a forked Python worker carrying the client heap.
    # No inherited application environment, plaintext arguments or secret-key files.
    command = [python, "-I", "-B"]
    # -I ignores PYTHONPYCACHEPREFIX. Preserve the parent's existing cache location
    # explicitly for reads, while -B forbids writes (notably on Desktop/iCloud).
    if sys.pycache_prefix is not None:
        command.extend(["-X", "pycache_prefix=" + sys.pycache_prefix])
    command.extend([str(ENGINE_DIR / "worker.py"), str(root)])
    with tempfile.TemporaryDirectory(prefix="worker-", dir=str(root)) as temporary:
        env = {"PATH": "/usr/bin:/bin", "TMPDIR": temporary, "OMP_NUM_THREADS": "1"}
        try:
            completed = subprocess.run(command,
                                       cwd=str(root), env=env, stdin=subprocess.DEVNULL,
                                       stdout=subprocess.DEVNULL, stderr=subprocess.PIPE,
                                       timeout=600, check=False)
        except subprocess.TimeoutExpired:
            raise RuntimeError("FHE evaluator exceeded the 600 second deadline") from None
    if completed.returncode:
        raise RuntimeError("FHE evaluator failed (exit code %s)" % completed.returncode)


@contextlib.contextmanager
def _ephemeral_evaluation_keys(root, data):
    path = root / "evaluation.keys"
    descriptor = os.open(str(path), os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
    try:
        with os.fdopen(descriptor, "wb") as stream:
            stream.write(data)
        yield
    finally:
        path.unlink(missing_ok=True)  # Also clean up safely after key deletion tampering.


def _immutable(value):
    if isinstance(value, dict):
        return MappingProxyType({key: _immutable(item) for key, item in value.items()})
    if isinstance(value, list):
        return tuple(_immutable(item) for item in value)
    return value


class PreparedJob:
    """Live client session. Use prepare_job() and a with block; never serialize.

    Public manifest/hash mappings are immutable snapshots. bind_external() seals a
    v2 manifest once, before evaluate(). The four ciphertext/circuit/key hashes and
    local attempt ID never change. No secret-key save/serialization is performed.
    """

    def __init__(self, records, job_dir, on_stage=None, *, _require_binding=True):
        self._records = validate_records(records)
        if on_stage is not None and not callable(on_stage):
            raise ValueError("on_stage must be callable")
        self._guard = threading.RLock()
        self._state = "PREPARING"
        self._entered = False
        self._client = None
        self._fhe = None
        self._on_stage = on_stage
        self._require_binding = _require_binding
        self._resources = contextlib.ExitStack()
        self._binding_bytes = None
        self._root = None
        submitted = time.perf_counter()
        try:
            self._resources.enter_context(_serialized_worker())
            self._started = time.perf_counter()
            self._metrics = {"queue_seconds": self._started - submitted, "real_fhe": True,
                             "profile_id": PROFILE_ID, "concrete_python": "2.11.0",
                             "verification_method": "client_plaintext_reference",
                             "verification_is_cryptographic_proof": False}
            self._stage("ENCRYPTING", "Generating fresh in-memory client keys and encrypting four records")
            artifacts = approved_artifacts()
            require_runtime()
            from concrete import fhe
            import numpy as np
            self._fhe = fhe
            self._root = _new_job_dir(job_dir)
            self._client = fhe.Client(fhe.ClientSpecs.deserialize(artifacts["client-specs.json"]),
                                      keyset_cache_directory=None)
            now = time.perf_counter()
            self._client.keys.generate()
            self._metrics["keygen_seconds"] = time.perf_counter() - now
            now = time.perf_counter()
            request = self._client.encrypt(np.array(encode_bits(self._records), dtype=np.int64)).serialize()
            self._metrics["encrypt_seconds"] = time.perf_counter() - now
            now = time.perf_counter()
            evaluation_keys = self._client.evaluation_keys.serialize()
            self._metrics["evaluation_keys_serialize_seconds"] = time.perf_counter() - now
            self._manifest = {"protocolVersion": 1, "profileId": PROFILE_ID, "attemptId": uuid.uuid4().hex,
                              "serverSha256": ARTIFACT_PINS["server.zip"],
                              "clientSpecsSha256": ARTIFACT_PINS["client-specs.json"],
                              "inputSha256": sha256(request), "evaluationKeysSha256": sha256(evaluation_keys)}
            for name, blob in artifacts.items():
                write_new(self._root / name, blob)
            write_new(self._root / "request.bin", request)
            self._key_resource = contextlib.ExitStack()
            self._resources.callback(self._key_resource.close)
            self._key_resource.enter_context(_ephemeral_evaluation_keys(self._root, evaluation_keys))
            self._metrics.update({"input_bytes": len(request), "evaluation_key_bytes": len(evaluation_keys)})
            # Staged request.json is written exactly once, when external context is
            # sealed. The legacy wrapper seals v1 immediately for compatibility.
            self._manifest_bytes = canonical_json(self._manifest)
            if not _require_binding:
                write_new(self._root / "request.json", self._manifest_bytes)
            self._state = "PREPARED"
        except BaseException:
            self._fail()
            raise

    def _stage(self, name, message):
        if self._on_stage is not None:
            self._on_stage(name, message)

    def __reduce_ex__(self, protocol):
        raise TypeError("Live PreparedJob sessions cannot be serialized")

    @property
    def state(self):
        return self._state

    @property
    def manifest(self):
        return _immutable(self._manifest)

    @property
    def manifest_bytes(self):
        return self._manifest_bytes

    @property
    def artifact_hashes(self):
        keys = ("serverSha256", "clientSpecsSha256", "inputSha256", "evaluationKeysSha256")
        hashes = {key: self._manifest[key] for key in keys}
        # A staged request hash is only final after bind_external().
        if self._binding_bytes is not None or not self._require_binding:
            hashes["requestManifestSha256"] = sha256(self._manifest_bytes)
        if self._binding_bytes is not None:
            hashes["externalBindingSha256"] = self._manifest["externalBindingSha256"]
        return _immutable(hashes)

    @property
    def external_binding(self):
        return None if self._binding_bytes is None else _immutable(json.loads(self._binding_bytes))

    def _expect(self, *states):
        if self._state not in states:
            raise RuntimeError("PreparedJob state %s; expected %s" % (self._state, "/".join(states)))

    def __enter__(self):
        with self._guard:
            self._expect("PREPARED", "BOUND", "EVALUATED")
            if self._entered:
                raise RuntimeError("PreparedJob context cannot be entered repeatedly")
            self._entered = True
            return self

    def __exit__(self, exc_type, exc, traceback):
        self.close()
        return False

    def close(self):
        """Drop client/SK/plaintext references and delete this session's eval keys.

        This is release of Python/native references, not guaranteed memory zeroing.
        Public/encrypted audit artifacts remain. close() is idempotent.
        """
        with self._guard:
            if self._state not in ("FINALIZED", "FAILED", "CLOSED"):
                self._state = "CLOSED"
            self._client = None
            self._fhe = None
            self._records = None
            self._on_stage = None
            self._resources.close()

    def _fail(self):
        self._state = "FAILED"
        self.close()

    def bind_external(self, binding):
        """Seal exact registry job/attempt/bidset context once; no authentication.

        Exact keys: job_id/attempt (canonical U64 decimal strings), plus
        job_binding_hash/attempt_binding_hash/bidset_root (lowercase 64-hex).
        The caller authenticates the registry snapshot independently.
        """
        with self._guard:
            self._expect("PREPARED")
            if not self._require_binding:
                raise RuntimeError("Legacy v1 session cannot bind external context")
            try:
                validate_external_binding(binding)
                binding_bytes = canonical_json(binding)  # Snapshot caller's mutable dict.
                manifest = dict(self._manifest, protocolVersion=2,
                                externalBindingSha256=sha256(binding_bytes))
                manifest_bytes = canonical_json(manifest)
                self._check_prepared_files(require_manifest=False)
                write_new(self._root / "binding.json", binding_bytes)
                write_new(self._root / "request.json", manifest_bytes)
                self._binding_bytes = binding_bytes
                self._manifest = manifest
                self._manifest_bytes = manifest_bytes
                self._state = "BOUND"
                return self.manifest
            except BaseException:
                self._fail()
                raise

    def _check_prepared_files(self, *, require_manifest=True, require_keys=True):
        approved_artifacts(self._root)
        request = read_regular(self._root / "request.bin", 2 * 1024 * 1024)
        if sha256(request) != self._manifest["inputSha256"]:
            raise ValueError("Prepared encrypted input hash mismatch")
        if require_keys:
            keys = read_regular(self._root / "evaluation.keys", 512 * 1024 * 1024)
            if sha256(keys) != self._manifest["evaluationKeysSha256"]:
                raise ValueError("Prepared evaluation key hash mismatch")
        elif os.path.lexists(self._root / "evaluation.keys"):
            raise ValueError("Evaluation key artifact reappeared after evaluation")
        if require_manifest:
            if read_regular(self._root / "request.json", 8192) != self._manifest_bytes:
                raise ValueError("Prepared request manifest changed")
        if self._binding_bytes is not None:
            binding_bytes = read_regular(self._root / "binding.json", 8192)
            if binding_bytes != self._binding_bytes:
                raise ValueError("Prepared external registry binding changed")
            verify_external_binding(self._manifest, binding_bytes)

    def evaluate(self):
        """Run ciphertext-only subprocess once; return immutable public metadata.

        Returns receipt, receiptSha256, outputSha256, requestManifestSha256,
        output_bytes. receipt is recursively immutable; no plaintext is returned.
        """
        with self._guard:
            self._expect("BOUND" if self._require_binding else "PREPARED")
            self._state = "EVALUATING"
            try:
                self._check_prepared_files()
                self._stage("EVALUATING", "Separate evaluator is computing on encrypted records")
                now = time.perf_counter()
                try:
                    _evaluate_subprocess(self._root)
                finally:
                    self._key_resource.close()
                self._metrics["worker_seconds"] = time.perf_counter() - now
                output, receipt_bytes, receipt = self._read_response()
                self._response_hash = sha256(output)
                self._receipt_hash = sha256(receipt_bytes)
                self._state = "EVALUATED"
                return _immutable({"receipt": receipt, "receiptSha256": self._receipt_hash,
                                   "outputSha256": self._response_hash, "output_bytes": len(output),
                                   "requestManifestSha256": sha256(self._manifest_bytes)})
            except BaseException:
                self._fail()
                raise

    def _read_response(self):
        output = read_regular(self._root / "response.bin", 2 * 1024 * 1024)
        receipt_bytes = read_regular(self._root / "receipt.json", 16384)
        receipt = json.loads(receipt_bytes)
        self._metrics.update(verify_receipt(self._manifest, self._manifest_bytes, receipt, output))
        return output, receipt_bytes, receipt

    def finalize(self):
        """Revalidate sealed context/response, decrypt and reference-check once."""
        with self._guard:
            self._expect("EVALUATED")
            self._state = "FINALIZING"
            try:
                self._stage("VERIFYING", "Client is decrypting and comparing with its plaintext reference")
                self._check_prepared_files(require_keys=False)
                output, receipt_bytes, receipt = self._read_response()
                if sha256(output) != self._response_hash or sha256(receipt_bytes) != self._receipt_hash:
                    raise ValueError("Evaluated response changed before finalize")
                now = time.perf_counter()
                result = decode_output(self._records, self._client.decrypt(self._fhe.Value.deserialize(output)))
                self._metrics["decrypt_seconds"] = time.perf_counter() - now
                if result != reference_result(self._records):
                    raise RuntimeError("Client reference verification failed")
                self._metrics["evaluation_keys_retained"] = False
                self._metrics["output_bytes"] = len(output)
                self._metrics["total_seconds"] = time.perf_counter() - self._started
                hashes = dict(self.artifact_hashes, outputSha256=self._response_hash,
                              receiptSha256=self._receipt_hash)
                self._state = "FINALIZED"
                self.close()
                return {"records": result, "verified": True, "metrics": dict(self._metrics),
                        "artifactHashes": hashes}
            except BaseException:
                self._fail()
                raise


def prepare_job(records, job_dir, on_stage=None):
    """Generate fresh in-memory client SK, encrypt, expose immutable public hashes.

    Use with prepare_job(...) as prepared, then bind_external(...), evaluate(),
    finalize(). A live session owns the serialized worker slot until finalization
    or close; it must not be persisted/reloaded. No evaluator has run on return.
    """
    return PreparedJob(records, job_dir, on_stage)


def run_job(records, job_dir, on_stage=None):
    """Backward-compatible v1 wrapper, composed from the same actual FHE stages."""
    with PreparedJob(records, job_dir, on_stage, _require_binding=False) as prepared:
        prepared.evaluate()
        return prepared.finalize()
