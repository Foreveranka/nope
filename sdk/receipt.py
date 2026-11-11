"""Construct an executor-report claim without network, signing or execution.

All inputs must come from caller-trusted sources. Equality checks do not
authenticate those sources or prove FHE was performed for a NEAR attempt.
"""
import copy
import hashlib
import json
import math
import re
import struct

PROFILE = "clean-4-records-v1"
SERVER_SHA = "73ef85b53a58273d543cdbfd21a5ef97408db22ef11fc303ee215a0be0ba7d7e"
CLIENT_SPEC_SHA = "87b1dd33c9db661f215962b975df389c3f4f7b2fb6123fb7721ac985766475f3"
CONFIG_HASHES = ("spec_hash", "circuit_hash", "key_hash", "output_policy_hash",
                 "context_hash", "input_hash", "budget_commitment")
CLAIM_HASHES = ("job_binding_hash", "attempt_binding_hash", "bidset_root") + CONFIG_HASHES + ("output_hash",)
CONFIG_FIELDS = set(CONFIG_HASHES) | {"bid_deadline_ns", "result_deadline_ns", "authorized_bidders", "executor"}
JOB_FIELDS = {"job_id", "buyer", "config", "job_binding_hash", "bids", "state", "bidset_root",
              "closed_at_ns", "attempt", "attempt_binding_hash", "receipts"}
REQUEST_FIELDS = {"protocolVersion", "profileId", "attemptId", "serverSha256", "clientSpecsSha256",
                  "evaluationKeysSha256", "inputSha256"}
ARTIFACT_FIELDS = {"serverSha256", "clientSpecsSha256", "evaluationKeysSha256", "inputSha256",
                   "outputSha256", "requestManifestSha256", "receiptSha256"}
TIME_METRICS = {"queue_seconds", "keygen_seconds", "encrypt_seconds", "evaluation_keys_serialize_seconds",
                "worker_seconds", "evaluate_seconds", "server_load_seconds", "decrypt_seconds", "total_seconds"}
SIZE_METRICS = {"input_bytes", "evaluation_key_bytes", "output_bytes"}
CORE_METRICS = {"real_fhe", "profile_id", "concrete_python", "verification_method",
                "verification_is_cryptographic_proof"}


class BindingError(ValueError):
    """Input shape, supported policy, or binding check failed. No claim was built."""


def _shape(value, required, label, optional=frozenset()):
    if type(value) is not dict or not required <= value.keys() or value.keys() - required - optional:
        raise BindingError("Invalid or unknown fields in " + label)


def _hash(value, label):
    if type(value) is not list or len(value) != 32 or any(type(v) is not int or not 0 <= v <= 255 for v in value):
        raise BindingError(label + " must contain exactly 32 byte integers")
    if not any(value):
        raise BindingError(label + " must not be all zero")
    return bytes(value)


def _hex(value, label, length=64):
    if type(value) is not str or not re.fullmatch("[0-9a-f]{%d}" % length, value):
        raise BindingError("Invalid lowercase hex digest/identity in " + label)
    return value


def _u64(value, label, minimum=0, maximum=(1 << 64) - 1):
    if type(value) is not str or not re.fullmatch(r"0|[1-9][0-9]{0,19}", value):
        raise BindingError(label + " must be a canonical U64 decimal string")
    number = int(value)
    if not minimum <= number <= maximum:
        raise BindingError("Out of range U64 in " + label)
    return number


def _account(value, label):
    if type(value) is not str or not 2 <= len(value) <= 64 or not re.fullmatch(r"[a-z0-9]+(?:[._-][a-z0-9]+)*", value):
        raise BindingError("Invalid account ID in " + label)


def _string(value):
    blob = value.encode("utf-8")
    return struct.pack("<I", len(blob)) + blob


def _digest(blob):
    return hashlib.sha256(blob).hexdigest()


def _attempt_hash(job, attempt):
    if job.get("attempt_binding_version") == 2:
        return hashlib.sha256(_string("veil/attempt/v2") + bytes(job["job_binding_hash"])
                              + bytes(job["bidset_root"]) + struct.pack("<Q", attempt)
                              + _string(job["selected_executor"])).digest()
    return hashlib.sha256(_string("veil/attempt/v1") + bytes(job["job_binding_hash"])
                          + bytes(job["bidset_root"]) + struct.pack("<Q", attempt)).digest()


def _claim_hash(claim):
    return hashlib.sha256(_string("veil/receipt/v1") + struct.pack("<Q", int(claim["job_id"]))
                          + struct.pack("<Q", int(claim["attempt"]))
                          + b"".join(bytes(claim[key]) for key in CLAIM_HASHES)).digest()


def _job(job, expected_attempt):
    _shape(job, JOB_FIELDS, "registry Job", {"selected_executor", "attempt_binding_version"})
    if ("selected_executor" in job) != ("attempt_binding_version" in job):
        raise BindingError("Incomplete executor binding metadata")
    if "attempt_binding_version" in job:
        version = job["attempt_binding_version"]
        if type(version) is not int or version not in (1, 2):
            raise BindingError("Unsupported attempt binding version")
        if version == 1 and job["selected_executor"] is not None:
            raise BindingError("Legacy attempt cannot select another executor")
        if version == 2:
            _account(job["selected_executor"], "selected_executor")
    if type(job["state"]) is not str or job["state"] != "Executing":
        raise BindingError("Registry job must be in Executing state")
    _u64(job["job_id"], "job_id", minimum=1)
    attempt = _u64(job["attempt"], "attempt", minimum=1, maximum=16)
    _u64(expected_attempt, "expected_registry_attempt", minimum=1, maximum=16)
    if job["attempt"] != expected_attempt:
        raise BindingError("Chosen registry attempt is not current")
    _account(job["buyer"], "buyer")
    config = job["config"]
    _shape(config, CONFIG_FIELDS, "JobConfig")
    for field in CONFIG_HASHES:
        _hash(config[field], field)
    _account(config["executor"], "executor")
    bid_deadline = _u64(config["bid_deadline_ns"], "bid_deadline_ns")
    result_deadline = _u64(config["result_deadline_ns"], "result_deadline_ns")
    closed = _u64(job["closed_at_ns"], "closed_at_ns")
    if not bid_deadline <= closed < result_deadline or result_deadline - bid_deadline >= 30 * 24 * 60 * 60 * 10**9:
        raise BindingError("Invalid closed job deadline configuration")
    roster = config["authorized_bidders"]
    if type(roster) is not list or not 1 <= len(roster) <= 10:
        raise BindingError("Invalid bidder roster")
    for account in roster:
        _account(account, "authorized_bidders")
    if roster != sorted(set(roster)):
        raise BindingError("Bidder roster must be sorted and unique")
    for field in ("job_binding_hash", "bidset_root", "attempt_binding_hash"):
        _hash(job[field], field)
    bids = job["bids"]
    if type(bids) is not list or len(bids) != len(roster):
        raise BindingError("Complete canonical bidset required")
    encoded = _string("veil/bidset/v1") + bytes(job["job_binding_hash"]) + struct.pack("<I", len(bids))
    commitments = set()
    for account, entry in zip(roster, bids):
        _shape(entry, {"bidder", "commitment"}, "BidEntry")
        if entry["bidder"] != account:
            raise BindingError("Bidset order differs from immutable roster")
        encoded += _string(account)
        if entry["commitment"] is None:
            encoded += b"\x00"
        else:
            commitment = _hash(entry["commitment"], "bid commitment")
            if commitment in commitments:
                raise BindingError("Duplicate bid commitment")
            commitments.add(commitment)
            encoded += b"\x01" + commitment
    if not commitments:
        raise BindingError("Executing job requires at least one committed bid")
    if job.get("attempt_binding_version") == 2 and not any(
            bid["bidder"] == job["selected_executor"] and bid["commitment"] is not None
            for bid in bids):
        raise BindingError("Selected executor must have a committed roster bid")
    if hashlib.sha256(encoded).digest() != bytes(job["bidset_root"]):
        raise BindingError("Full bidset root mismatch")
    if _attempt_hash(job, attempt) != bytes(job["attempt_binding_hash"]):
        raise BindingError("Registry attempt binding mismatch")
    history = job["receipts"]
    if type(history) is not list or len(history) != attempt - 1:
        raise BindingError("Invalid prior attempt history")
    for number, record in enumerate(history, 1):
        _shape(record, {"claim", "receipt_hash", "reported_at_ns", "status", "decided_at_ns"}, "ReceiptRecord")
        if record["status"] != "BuyerRejected":
            raise BindingError("Executing retry requires rejected prior attempts")
        claim = record["claim"]
        _shape(claim, set(CLAIM_HASHES) | {"job_id", "attempt"}, "historical ReceiptClaim")
        for field in CLAIM_HASHES:
            _hash(claim[field], "historical " + field)
        if claim["job_id"] != job["job_id"] or claim["attempt"] != str(number):
            raise BindingError("Historical claim job/attempt mismatch")
        for field in CONFIG_HASHES + ("job_binding_hash", "bidset_root"):
            expected = config[field] if field in CONFIG_HASHES else job[field]
            if claim[field] != expected:
                raise BindingError("Historical claim configuration mismatch")
        if bytes(claim["attempt_binding_hash"]) != _attempt_hash(job, number):
            raise BindingError("Historical attempt binding mismatch")
        if _hash(record["receipt_hash"], "historical receipt hash") != _claim_hash(claim):
            raise BindingError("Historical receipt digest mismatch")
        reported = _u64(record["reported_at_ns"], "reported_at_ns")
        decided = _u64(record["decided_at_ns"], "decided_at_ns")
        if not closed <= reported < result_deadline or decided < reported:
            raise BindingError("Invalid historical receipt timestamps")


def _json_bytes(blob, label):
    if type(blob) is not bytes or not 0 < len(blob) <= 16384:
        raise BindingError(label + " must be original JSON bytes, at most 16 KiB")

    def unique(pairs):
        result = {}
        for key, value in pairs:
            if key in result:
                raise BindingError("Duplicate JSON field in " + label)
            result[key] = value
        return result

    def invalid_constant(value):
        raise BindingError("Invalid JSON number in " + label)

    try:
        return json.loads(blob.decode("utf-8"), object_pairs_hook=unique, parse_constant=invalid_constant)
    except (UnicodeError, json.JSONDecodeError, RecursionError):
        raise BindingError("Invalid JSON in " + label) from None


def _request(request):
    version = request.get("protocolVersion") if type(request) is dict else None
    fields = REQUEST_FIELDS | ({"externalBindingSha256"} if version == 2 else set())
    _shape(request, fields, "engine request")
    if type(version) is not int or version not in (1, 2):
        raise BindingError("Unsupported engine protocol")
    if request["profileId"] != PROFILE:
        raise BindingError("Unknown engine profile")
    _hex(request["attemptId"], "local engine attempt", 32)
    for field in fields - {"protocolVersion", "profileId", "attemptId"}:
        _hex(request[field], field)
    if request["serverSha256"] != SERVER_SHA or request["clientSpecsSha256"] != CLIENT_SPEC_SHA:
        raise BindingError("Unsupported profile circuit or client spec")


def _timing(value):
    try:
        valid = type(value) in (int, float) and math.isfinite(value) and value >= 0
    except OverflowError:
        valid = False
    if not valid:
        raise BindingError("Invalid engine timing")


def build_receipt_claim(registry_job, engine_result, *, request_manifest, evaluator_receipt,
                        expected_registry_attempt, expected_engine_attempt_id, policy,
                        external_binding=None):
    """Build JSON-compatible ReceiptClaim, never submit/sign/pay or authenticate.

    policy is caller-trusted metadata with exactly profile_id, spec_hash,
    output_policy_hash, verification_method, requires_execution_proof. Hashes are
    registry 32-byte integer lists. This is an explicit approved policy lookup,
    not a decoder/preimage proof of the opaque on-chain policy hash.

    engine_result needs verified, metrics and artifactHashes; optional records
    are ignored and never hashed, copied to the claim, or logged. Pass original
    request/receipt bytes, not reconstructed JSON. See README for trust limits.
    """
    _shape(engine_result, {"verified", "metrics", "artifactHashes"}, "engine result", {"records"})
    # Do not even access the optional plaintext records. Snapshot public metadata.
    public_result = {key: engine_result[key] for key in ("verified", "metrics", "artifactHashes")}
    job, result, policy = copy.deepcopy((registry_job, public_result, policy))
    _job(job, expected_registry_attempt)
    _shape(policy, {"profile_id", "spec_hash", "output_policy_hash", "verification_method",
                    "requires_execution_proof"}, "approved policy")
    if policy["profile_id"] != PROFILE or policy["verification_method"] != "client_plaintext_reference":
        raise BindingError("Unknown profile or verification policy")
    if policy["requires_execution_proof"] is not False:
        raise BindingError("Proof-required or unknown policy is unsupported")
    for field in ("spec_hash", "output_policy_hash"):
        _hash(policy[field], "approved " + field)
        if policy[field] != job["config"][field]:
            raise BindingError("Approved policy does not match registry " + field)
    _hex(expected_engine_attempt_id, "expected_engine_attempt_id", 32)
    _shape(result, {"verified", "metrics", "artifactHashes"}, "engine result", {"records"})
    if result["verified"] is not True:
        raise BindingError("Engine client reference verification is required")
    metrics = result["metrics"]
    _shape(metrics, CORE_METRICS, "engine metrics", TIME_METRICS | SIZE_METRICS | {"evaluation_keys_retained"})
    if (metrics["real_fhe"] is not True or metrics["profile_id"] != PROFILE or
            metrics["concrete_python"] != "2.11.0" or metrics["verification_method"] != "client_plaintext_reference" or
            metrics["verification_is_cryptographic_proof"] is not False):
        raise BindingError("Unsupported or misleading engine verification metadata")
    for key in metrics.keys() & TIME_METRICS:
        _timing(metrics[key])
    for key in metrics.keys() & SIZE_METRICS:
        if type(metrics[key]) is not int or metrics[key] <= 0:
            raise BindingError("Invalid engine artifact size")
    if "evaluation_keys_retained" in metrics and type(metrics["evaluation_keys_retained"]) is not bool:
        raise BindingError("Invalid evaluation-key retention metadata")
    hashes = result["artifactHashes"]
    request = _json_bytes(request_manifest, "request_manifest")
    _request(request)
    extra_hashes = {"externalBindingSha256"} if request["protocolVersion"] == 2 else set()
    _shape(hashes, ARTIFACT_FIELDS | extra_hashes, "engine artifact hashes")
    for key in ARTIFACT_FIELDS | extra_hashes:
        _hex(hashes[key], key)
    if request["protocolVersion"] == 2:
        binding = _json_bytes(external_binding, "external_binding")
        _shape(binding, {"job_id", "attempt", "job_binding_hash", "attempt_binding_hash", "bidset_root"},
               "external binding")
        if _digest(external_binding) != request["externalBindingSha256"] or hashes["externalBindingSha256"] != request["externalBindingSha256"]:
            raise BindingError("External binding digest mismatch")
        if external_binding != json.dumps(binding, sort_keys=True, separators=(",", ":"), allow_nan=False).encode("utf-8"):
            raise BindingError("Noncanonical external binding")
        for field in ("job_id", "attempt"):
            if binding[field] != job[field]:
                raise BindingError("External binding registry identity mismatch")
        for field in ("job_binding_hash", "attempt_binding_hash", "bidset_root"):
            if binding[field] != bytes(job[field]).hex():
                raise BindingError("External binding registry hash mismatch")
    elif external_binding is not None:
        raise BindingError("Legacy engine request cannot claim external binding")
    receipt = _json_bytes(evaluator_receipt, "evaluator_receipt")
    _shape(receipt, {"request", "requestManifestSha256", "outputSha256", "metrics"}, "evaluator receipt")
    _request(receipt["request"])
    _hex(receipt["requestManifestSha256"], "receipt manifest digest")
    _hex(receipt["outputSha256"], "receipt output digest")
    _shape(receipt["metrics"], {"evaluate_seconds", "server_load_seconds"}, "evaluator metrics")
    for key, value in receipt["metrics"].items():
        _timing(value)
        if key not in metrics or value != metrics[key]:
            raise BindingError("Evaluator timing differs from verified engine metadata")
    if request["attemptId"] != expected_engine_attempt_id:
        raise BindingError("Chosen local engine attempt mismatch")
    if receipt["request"] != request:
        raise BindingError("Evaluator receipt request mismatch")
    if _digest(request_manifest) != hashes["requestManifestSha256"] or receipt["requestManifestSha256"] != hashes["requestManifestSha256"]:
        raise BindingError("Engine request manifest digest mismatch")
    if _digest(evaluator_receipt) != hashes["receiptSha256"]:
        raise BindingError("Evaluator receipt digest mismatch")
    for key in ("serverSha256", "clientSpecsSha256", "evaluationKeysSha256", "inputSha256"):
        if hashes[key] != request[key]:
            raise BindingError("Engine request/result artifact mismatch: " + key)
    if receipt["outputSha256"] != hashes["outputSha256"]:
        raise BindingError("Encrypted output digest mismatch")
    for source, target in (("serverSha256", "circuit_hash"), ("evaluationKeysSha256", "key_hash"),
                           ("inputSha256", "input_hash")):
        if bytes.fromhex(hashes[source]) != bytes(job["config"][target]):
            raise BindingError("Registry/engine mismatch: " + target)
    claim = {key: copy.deepcopy(job[key]) for key in ("job_id", "attempt", "job_binding_hash", "attempt_binding_hash", "bidset_root")}
    claim.update({key: list(job["config"][key]) for key in CONFIG_HASHES})
    # Only the encrypted output digest is used. Never hash decrypted records.
    claim["output_hash"] = list(bytes.fromhex(hashes["outputSha256"]))
    _hash(claim["output_hash"], "output_hash")
    return claim
