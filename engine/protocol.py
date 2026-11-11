"""Non-secret wire format and immutable artifact allowlist (Python 3.9)."""
import hashlib
import importlib.metadata
import json
import math
import os
import re
from pathlib import Path

PROFILE_ID = "clean-4-records-v1"
CONCRETE_VERSION = "2.11.0"
ARTIFACT_PINS = {
    "server.zip": "73ef85b53a58273d543cdbfd21a5ef97408db22ef11fc303ee215a0be0ba7d7e",
    "client-specs.json": "87b1dd33c9db661f215962b975df389c3f4f7b2fb6123fb7721ac985766475f3",
}
ENGINE_DIR = Path(__file__).resolve().parent
MANIFEST_KEYS = {"protocolVersion", "profileId", "attemptId", "serverSha256",
                 "clientSpecsSha256", "evaluationKeysSha256", "inputSha256"}
EXTERNAL_BINDING_KEYS = {"job_id", "attempt", "job_binding_hash",
                         "attempt_binding_hash", "bidset_root"}


def sha256(data):
    return hashlib.sha256(data).hexdigest()


def canonical_json(value):
    return json.dumps(value, sort_keys=True, separators=(",", ":"), allow_nan=False).encode("utf-8")


def read_regular(path, maximum):
    """Reject symlinks and oversized files before reading cryptographic blobs."""
    import stat
    with os.fdopen(os.open(str(path), os.O_RDONLY | os.O_NOFOLLOW), "rb") as stream:
        info = os.fstat(stream.fileno())
        if not stat.S_ISREG(info.st_mode) or info.st_size > maximum:
            raise ValueError("Invalid artifact file or size")
        data = stream.read(maximum + 1)
    if len(data) > maximum:
        raise ValueError("Artifact exceeds size limit")
    return data


def write_new(path, data):
    with os.fdopen(os.open(str(path), os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW,
                           0o600), "wb") as stream:
        stream.write(data)


def artifact_pins(artifact_set="macos-v1"):
    if artifact_set == "macos-v1":
        return ARTIFACT_PINS
    if artifact_set == "portable-v1":
        from engine.portable.pins import ARTIFACT_PINS as portable_pins
        return portable_pins
    raise ValueError("Unknown approved artifact set")


def manifest_artifact_set(manifest):
    for kind in ("macos-v1", "portable-v1"):
        pins = artifact_pins(kind)
        if (manifest["serverSha256"] == pins["server.zip"] and
                manifest["clientSpecsSha256"] == pins["client-specs.json"]):
            return kind
    raise ValueError("Request circuit is not allowlisted")


def approved_artifacts(directory=None, *, artifact_set="macos-v1"):
    pins = artifact_pins(artifact_set)
    default = ENGINE_DIR / "artifacts"
    if artifact_set == "portable-v1":
        from engine.portable.pins import DIRECTORY
        default = default / DIRECTORY
    root = Path(directory) if directory is not None else Path(
        os.environ.get("VEIL_FHE_ARTIFACT_DIR", str(default)))
    blobs = {}
    for name, pin in pins.items():
        blob = read_regular(root / name, 2 * 1024 * 1024)
        if sha256(blob) != pin:
            raise ValueError("Unapproved FHE artifact: " + name)
        blobs[name] = blob
    return blobs


def verify_artifact_bytes(artifacts, *, artifact_set="portable-v1"):
    """Snapshot downloaded public artifacts; deployment cannot choose new pins."""
    from collections.abc import Mapping
    pins = artifact_pins(artifact_set)
    if not isinstance(artifacts, Mapping) or set(artifacts) != set(pins):
        raise ValueError("Expected exactly the two approved public artifacts")
    result = {}
    for name, pin in pins.items():
        blob = artifacts[name]
        if type(blob) is not bytes or len(blob) > 2 * 1024 * 1024 or sha256(blob) != pin:
            raise ValueError("Unapproved FHE artifact: " + name)
        result[name] = blob
    return result


def require_runtime():
    try:
        version = importlib.metadata.version("concrete-python")
    except importlib.metadata.PackageNotFoundError:
        raise RuntimeError("Run the client service with a Concrete 2.11 interpreter (existing research .venv)") from None
    if version != CONCRETE_VERSION:
        raise RuntimeError("This artifact requires concrete-python " + CONCRETE_VERSION)


def validate_manifest(manifest):
    if not isinstance(manifest, dict):
        raise ValueError("Invalid encrypted request manifest")
    version = manifest.get("protocolVersion")
    if type(version) is not int or version not in (1, 2):
        raise ValueError("Unsupported request version")
    expected = MANIFEST_KEYS | ({"externalBindingSha256"} if version == 2 else set())
    if set(manifest) != expected:
        raise ValueError("Invalid encrypted request manifest")
    if manifest["profileId"] != PROFILE_ID:
        raise ValueError("Unsupported FHE profile")
    if not isinstance(manifest["attemptId"], str) or not re.fullmatch("[0-9a-f]{32}", manifest["attemptId"]):
        raise ValueError("Invalid attempt identity")
    for key in expected - {"protocolVersion", "profileId", "attemptId"}:
        if not isinstance(manifest[key], str) or not re.fullmatch("[0-9a-f]{64}", manifest[key]):
            raise ValueError("Invalid artifact digest")
    manifest_artifact_set(manifest)


def validate_external_binding(binding):
    """Validate caller-supplied public registry context, not its authenticity."""
    if not isinstance(binding, dict) or set(binding) != EXTERNAL_BINDING_KEYS:
        raise ValueError("Invalid external registry binding")
    for key in ("job_id", "attempt"):
        value = binding[key]
        if (not isinstance(value, str) or not re.fullmatch("0|[1-9][0-9]{0,19}", value)
                or int(value) > 2**64 - 1 or (key == "attempt" and int(value) == 0)):
            raise ValueError("Registry job_id/attempt must be canonical U64 strings")
    for key in EXTERNAL_BINDING_KEYS - {"job_id", "attempt"}:
        value = binding[key]
        if not isinstance(value, str) or not re.fullmatch("[0-9a-f]{64}", value):
            raise ValueError("Registry binding digest must be lowercase SHA-256 hex")


def verify_external_binding(manifest, binding_bytes):
    if manifest["protocolVersion"] != 2:
        raise ValueError("External registry binding requires request v2")
    if sha256(binding_bytes) != manifest["externalBindingSha256"]:
        raise ValueError("External registry binding hash mismatch")
    binding = json.loads(binding_bytes)
    validate_external_binding(binding)
    if canonical_json(binding) != binding_bytes:
        raise ValueError("External registry binding must be canonical JSON")
    return binding


def verify_receipt(manifest, manifest_bytes, receipt, output):
    """Bind the response to this attempt, exact ciphertext/keyset, circuit and output."""
    validate_manifest(manifest)
    if not isinstance(receipt, dict) or set(receipt) != {"request", "requestManifestSha256", "outputSha256", "metrics"}:
        raise ValueError("Invalid evaluator receipt")
    if receipt["request"] != manifest or receipt["requestManifestSha256"] != sha256(manifest_bytes):
        raise ValueError("Evaluator response belongs to another request")
    if receipt["outputSha256"] != sha256(output):
        raise ValueError("Evaluator output hash mismatch")
    metrics = receipt["metrics"]
    if not isinstance(metrics, dict) or set(metrics) != {"server_load_seconds", "evaluate_seconds"}:
        raise ValueError("Invalid evaluator metrics")
    for value in metrics.values():
        if type(value) not in (int, float) or not math.isfinite(value) or value < 0:
            raise ValueError("Invalid evaluator timing")
    return metrics
