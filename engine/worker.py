"""Ciphertext-only evaluator. No client instance, secret-key API, or plaintext input.

Separate fresh process under the same UID; this is not an OS security boundary.
Only the two compiled artifacts with source-pinned digests may be loaded.
"""
import json
import sys
import tempfile
import time
from pathlib import Path

# The parent invokes this file with -I (isolated import/environment handling).
sys.path.insert(0, str(Path(__file__).resolve().parent))
from protocol import (approved_artifacts, canonical_json, read_regular,
                      require_runtime, sha256, validate_manifest,
                      verify_external_binding, write_new)


def evaluate(job_dir):
    root = Path(job_dir)
    manifest_bytes = read_regular(root / "request.json", 8192)
    manifest = json.loads(manifest_bytes)
    validate_manifest(manifest)
    if manifest["protocolVersion"] == 2:
        verify_external_binding(manifest, read_regular(root / "binding.json", 8192))
    artifacts = approved_artifacts(root)
    request = read_regular(root / "request.bin", 2 * 1024 * 1024)
    if sha256(request) != manifest["inputSha256"]:
        raise ValueError("Encrypted input hash mismatch")
    keys = read_regular(root / "evaluation.keys", 512 * 1024 * 1024)
    if sha256(keys) != manifest["evaluationKeysSha256"]:
        raise ValueError("Evaluation key hash mismatch")
    require_runtime()
    from concrete import fhe

    # Load the very bytes checked above, never an unchecked path or user pickle.
    with tempfile.TemporaryDirectory(prefix="approved-server-") as temporary:
        server_path = Path(temporary) / "server.zip"
        write_new(server_path, artifacts["server.zip"])
        started = time.perf_counter()
        server = fhe.Server.load(server_path)
        load_seconds = time.perf_counter() - started
        if server.is_simulated:
            raise ValueError("Simulated evaluation is forbidden")
        value = fhe.Value.deserialize(request)
        evaluation_keys = fhe.EvaluationKeys.deserialize(keys)
        del keys
        started = time.perf_counter()
        output = server.run(value, evaluation_keys=evaluation_keys).serialize()
        evaluate_seconds = time.perf_counter() - started
    write_new(root / "response.bin", output)
    receipt = {"request": manifest, "requestManifestSha256": sha256(manifest_bytes),
               "outputSha256": sha256(output),
               "metrics": {"server_load_seconds": load_seconds, "evaluate_seconds": evaluate_seconds}}
    write_new(root / "receipt.json", canonical_json(receipt))


if __name__ == "__main__":
    if len(sys.argv) != 2:
        sys.exit("usage: worker.py JOB_DIRECTORY")
    try:
        evaluate(sys.argv[1])
    except Exception as exc:
        # Never print blobs or serialize exception locals to a log.
        sys.exit("Encrypted evaluation failed: " + type(exc).__name__)
