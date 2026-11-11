"""Versioned precommit/selection codec. Pure local metadata checks, NOT finality.

Only synthetic fixtures may use PreparedSynthetic: it centralizes every secret.
No attempt is fabricated before selection. Registry v1 hashes use actual Borsh.
"""
import hashlib
import json
import re
import secrets
import struct
from dataclasses import dataclass, field
from pathlib import Path

from .auction import MAX_AMOUNT, UPSTREAM, canonical, integer

VERSION = 2
PROFILE = "sealed-cheapest-3-spdz2k-v2"
INTENT_DOMAIN = b"VEIL-INTENT-v2\x00"
COMMITMENT_DOMAIN = b"VEIL-MPC-v2\x00"
MANIFEST_DOMAIN = b"VEIL-SELECTION-v2\x00"
SOURCE = Path(__file__).resolve().parent / "programs/sealed_procurement_v2.mpc"
HASH_FIELDS = ("specHash", "circuitHash", "keyHash", "outputPolicyHash", "inputHash")
CONFIG_HASHES = ("spec_hash", "circuit_hash", "key_hash", "output_policy_hash",
                 "context_hash", "input_hash", "budget_commitment")
CONFIG_FIELDS = set(CONFIG_HASHES) | {"bid_deadline_ns", "result_deadline_ns", "authorized_bidders", "executor"}
JOB_FIELDS = {"job_id", "buyer", "config", "job_binding_hash", "bids", "state", "bidset_root",
              "closed_at_ns", "attempt", "attempt_binding_hash", "receipts"}
INTENT_FIELDS = {"version", "profile", "networkDomainHash", "registryAccount", "buyer", "roster",
                 "qualified", "fixedFee", "bidDeadlineNs", "resultDeadlineNs", "registryExecutor",
                 "intentNonce", "selectionRound", "mpcProgramHash", "upstream"} | set(HASH_FIELDS)


def schema(value, fields, name):
    if type(value) is not dict or set(value) != fields:
        raise ValueError(name + " schema")


def hex32(value):
    if type(value) is not str or not re.fullmatch("[0-9a-f]{64}", value):
        raise ValueError("canonical lowercase hash32 required")
    return bytes.fromhex(value)


def registry_hash(value):
    if type(value) is not list or len(value) != 32 or any(type(x) is not int or not 0 <= x <= 255 for x in value):
        raise ValueError("registry hash32 byte array required")
    return bytes(value)


def hash_arg(value):
    return (hex32(value) if type(value) is str else registry_hash(value)).hex()


def account(value):
    if type(value) is not str or not 2 <= len(value) <= 64 or not re.fullmatch(r"[a-z0-9]+(?:[._-][a-z0-9]+)*", value):
        raise ValueError("canonical account required")
    return value


def u64(value):
    if type(value) is not str or not re.fullmatch(r"0|[1-9][0-9]{0,19}", value) or int(value) >= 1 << 64:
        raise ValueError("canonical U64 string required")
    return int(value)


def text_field(value):
    raw = value.encode("ascii")
    return struct.pack(">I", len(raw)) + raw


def program_hash():
    return hashlib.sha256(SOURCE.read_bytes()).hexdigest()


def validate_intent(intent):
    schema(intent, INTENT_FIELDS, "v2 intent")
    if type(intent["version"]) is not int or intent["version"] != VERSION or intent["profile"] != PROFILE or intent["upstream"] != UPSTREAM:
        raise ValueError("unsupported intent version/profile/build")
    for key in HASH_FIELDS + ("networkDomainHash", "intentNonce", "selectionRound", "mpcProgramHash"):
        if hex32(intent[key]) == bytes(32):
            raise ValueError("zero intent hash/nonce")
    for key in ("registryAccount", "buyer", "registryExecutor"):
        account(intent[key])
    roster = intent["roster"]
    if type(roster) is not list or len(roster) != 3:
        raise ValueError("three roster accounts required")
    for a in roster:
        account(a)
    if roster != sorted(set(roster)) or intent["buyer"] in roster:
        raise ValueError("canonical unique sorted roster, distinct buyer required")
    flags = intent["qualified"]
    if type(flags) is not list or len(flags) != 3 or any(type(x) is not bool for x in flags):
        raise ValueError("three qualification booleans required")
    integer(intent["fixedFee"], 0, MAX_AMOUNT, "fixed fee")
    begin, end = u64(intent["bidDeadlineNs"]), u64(intent["resultDeadlineNs"])
    if not begin < end or end - begin >= 30 * 24 * 60 * 60 * 10**9:
        raise ValueError("invalid intent deadlines")
    return intent


def build_intent(*, network_domain_hash, registry_account, buyer, roster, qualified, fixed_fee,
                 bid_deadline_ns, result_deadline_ns, spec_hash, circuit_hash, key_hash,
                 input_hash, output_policy_hash, registry_executor, intent_nonce=None, selection_round=None):
    """Create public v2 intent BEFORE commitments or registry create_job.

    Hashes accept lowercase hex or registry byte arrays. U64s are strings.
    Optional nonce arguments are for reproducible synthetic vectors only.
    """
    intent = dict(version=VERSION, profile=PROFILE, networkDomainHash=hash_arg(network_domain_hash),
                  registryAccount=registry_account, buyer=buyer, roster=list(roster), qualified=list(qualified),
                  fixedFee=fixed_fee, bidDeadlineNs=bid_deadline_ns, resultDeadlineNs=result_deadline_ns,
                  specHash=hash_arg(spec_hash), circuitHash=hash_arg(circuit_hash), keyHash=hash_arg(key_hash),
                  inputHash=hash_arg(input_hash), outputPolicyHash=hash_arg(output_policy_hash),
                  registryExecutor=registry_executor, intentNonce=secrets.token_hex(32) if intent_nonce is None else intent_nonce,
                  selectionRound=secrets.token_hex(32) if selection_round is None else selection_round, mpcProgramHash=program_hash(), upstream=UPSTREAM)
    return validate_intent(intent)


def encode_intent(intent):
    """Exact ordered binary codec: BE lengths/U64s; raw hash32; bool=00/01.

    Field order is defined here, never dict order. Every field is encoded once.
    """
    i = validate_intent(intent)
    return (INTENT_DOMAIN + bytes([VERSION]) + text_field(i["profile"]) + hex32(i["networkDomainHash"])
            + text_field(i["registryAccount"]) + text_field(i["buyer"])
            + b"\x03" + b"".join(text_field(a) for a in i["roster"])
            + bytes(i["qualified"]) + struct.pack(">QQQ", i["fixedFee"], u64(i["bidDeadlineNs"]), u64(i["resultDeadlineNs"]))
            + b"".join(hex32(i[k]) for k in HASH_FIELDS) + text_field(i["registryExecutor"])
            + hex32(i["intentNonce"]) + hex32(i["selectionRound"]) + hex32(i["mpcProgramHash"]) + text_field(i["upstream"]))


def precommit_context(intent):
    return hashlib.sha256(encode_intent(intent)).hexdigest()


def commitment(context_hash, client_id, amount, salt):
    context = hex32(context_hash)
    integer(client_id, 0, 3, "client id")
    integer(amount, 0 if client_id == 0 else 1, MAX_AMOUNT)
    if type(salt) is not bytes or len(salt) != 32:
        raise ValueError("salt32 required")
    return hashlib.sha256(COMMITMENT_DOMAIN + context + bytes([client_id]) + amount.to_bytes(8, "big") + salt).hexdigest()


@dataclass(frozen=True)
class PreparedSynthetic:
    # Immutable public intent + private witness. repr never prints secrets.
    intent_json: bytes
    commitments: tuple
    amounts: tuple = field(repr=False)
    salts: tuple = field(repr=False)

    @property
    def intent(self):
        return json.loads(self.intent_json)

    @property
    def intent_bytes(self):
        return encode_intent(self.intent)

    @property
    def context_hash(self):
        return precommit_context(self.intent)


def prepare_synthetic(intent, *, budget=100, prices=(90, 80, 95)):
    """Centralized synthetic witness, NEVER a real coordinator API."""
    validate_intent(intent)
    if len(prices) != 3:
        raise ValueError("three prices required")
    amounts, salts = (budget,) + tuple(prices), tuple(secrets.token_bytes(32) for _ in range(4))
    context = precommit_context(intent)
    cs = tuple(commitment(context, n, a, s) for n, (a, s) in enumerate(zip(amounts, salts)))
    return PreparedSynthetic(canonical(intent), cs, amounts, salts)


def registry_config(prepared):
    i = prepared.intent
    validate_intent(i)
    return {"spec_hash": list(hex32(i["specHash"])), "circuit_hash": list(hex32(i["circuitHash"])),
            "key_hash": list(hex32(i["keyHash"])), "output_policy_hash": list(hex32(i["outputPolicyHash"])),
            "context_hash": list(hex32(prepared.context_hash)), "input_hash": list(hex32(i["inputHash"])),
            "budget_commitment": list(hex32(prepared.commitments[0])), "bid_deadline_ns": i["bidDeadlineNs"],
            "result_deadline_ns": i["resultDeadlineNs"], "authorized_bidders": i["roster"], "executor": i["registryExecutor"]}


# Independent strict registry Borsh v1 encoder. No sdk dependency or mutation.
def borsh_string(value):
    raw = value.encode("ascii")
    return struct.pack("<I", len(raw)) + raw


def registry_job_hash(intent, job):
    c = job["config"]
    schema(c, CONFIG_FIELDS, "registry config")
    encoded = (borsh_string("veil/job/v1") + borsh_string(intent["registryAccount"])
               + hex32(intent["networkDomainHash"]) + struct.pack("<Q", u64(job["job_id"])) + borsh_string(account(job["buyer"])))
    encoded += b"".join(registry_hash(c[k]) for k in CONFIG_HASHES)
    encoded += struct.pack("<QQ", u64(c["bid_deadline_ns"]), u64(c["result_deadline_ns"]))
    encoded += struct.pack("<I", len(c["authorized_bidders"])) + b"".join(borsh_string(account(a)) for a in c["authorized_bidders"])
    return hashlib.sha256(encoded + borsh_string(account(c["executor"]))).hexdigest()


def registry_bidset_root(job):
    encoded = borsh_string("veil/bidset/v1") + registry_hash(job["job_binding_hash"]) + struct.pack("<I", len(job["bids"]))
    for b in job["bids"]:
        schema(b, {"bidder", "commitment"}, "bid entry")
        encoded += borsh_string(account(b["bidder"]))
        encoded += b"\x00" if b["commitment"] is None else b"\x01" + registry_hash(b["commitment"])
    return hashlib.sha256(encoded).hexdigest()


def validate_closed_job(intent, commitments, job):
    validate_intent(intent)
    if type(job) is not dict or set(job) not in (JOB_FIELDS, JOB_FIELDS | {"selected_executor", "attempt_binding_version"}):
        raise ValueError("closed job schema")
    if "selected_executor" in job and (job["selected_executor"] is not None or job["attempt_binding_version"] is not None):
        raise ValueError("preselection executor/version must be null")
    if job["state"] != "Closed" or job["attempt"] != "0" or job["attempt_binding_hash"] is not None or job["receipts"] != []:
        raise ValueError("selection requires Closed job before any execution attempt")
    if type(commitments) is not list or len(commitments) != 4:
        raise ValueError("four commitments required")
    for c in commitments:
        if hex32(c) == bytes(32):
            raise ValueError("zero commitment")
    if len(set(commitments[1:])) != 3:
        raise ValueError("duplicate bid commitments")
    expected = registry_config(PreparedSynthetic(canonical(intent), tuple(commitments), (), ()))
    schema(job["config"], CONFIG_FIELDS, "registry config")
    # Validate byte types before equality: Python bool == int must not bypass codec.
    for key in CONFIG_HASHES:
        registry_hash(job["config"][key])
    if job["config"] != expected or job["buyer"] != intent["buyer"]:
        raise ValueError("registry configuration differs from precommit intent/budget")
    closed = u64(job["closed_at_ns"])
    if not u64(intent["bidDeadlineNs"]) <= closed < u64(intent["resultDeadlineNs"]):
        raise ValueError("invalid closure time")
    if registry_job_hash(intent, job) != registry_hash(job["job_binding_hash"]).hex():
        raise ValueError("registry job binding mismatch")
    bids = job["bids"]
    if type(bids) is not list or len(bids) != 3:
        raise ValueError("all three bid slots required; missing slot aborts")
    for n, b in enumerate(bids):
        schema(b, {"bidder", "commitment"}, "bid entry")
        if b["bidder"] != intent["roster"][n] or registry_hash(b["commitment"]).hex() != commitments[n + 1]:
            raise ValueError("commitment roster mismatch")
    if registry_bidset_root(job) != registry_hash(job["bidset_root"]).hex():
        raise ValueError("complete bidset root mismatch")
    return job


def validate_manifest(manifest):
    schema(manifest, {"version", "kind", "intent", "precommitContext", "commitments", "closedJob", "selectionRound", "mpcBuild"}, "v2 selection manifest")
    if type(manifest["version"]) is not int or manifest["version"] != VERSION or manifest["kind"] != "closed-job-selection":
        raise ValueError("unsupported selection manifest version/kind")
    i = validate_intent(manifest["intent"])
    if manifest["precommitContext"] != precommit_context(i) or manifest["selectionRound"] != i["selectionRound"]:
        raise ValueError("precommit context/selection round mismatch")
    schema(manifest["mpcBuild"], {"upstream", "circuitSourceHash"}, "mpc build")
    if manifest["mpcBuild"] != {"upstream": UPSTREAM, "circuitSourceHash": i["mpcProgramHash"]}:
        raise ValueError("intent/build mismatch")
    validate_closed_job(i, manifest["commitments"], manifest["closedJob"])
    return manifest


def build_selection_manifest(prepared, closed_job):
    # Deep-copy registry snapshot; subsequent caller mutations cannot change it.
    m = {"version": VERSION, "kind": "closed-job-selection", "intent": prepared.intent,
         "precommitContext": prepared.context_hash, "commitments": list(prepared.commitments),
         "closedJob": json.loads(canonical(closed_job)), "selectionRound": prepared.intent["selectionRound"],
         "mpcBuild": {"upstream": UPSTREAM, "circuitSourceHash": prepared.intent["mpcProgramHash"]}}
    return validate_manifest(m)


def manifest_digest(manifest):
    validate_manifest(manifest)
    return hashlib.sha256(MANIFEST_DOMAIN + canonical(manifest)).hexdigest()


def load_manifest(encoded):
    """Read untrusted public v2 JSON without duplicate keys or NaN coercions."""
    def pairs(items):
        result = {}
        for key, value in items:
            if key in result:
                raise ValueError("duplicate public JSON key")
            result[key] = value
        return result

    def constant(_):
        raise ValueError("nonfinite public JSON number")

    return validate_manifest(json.loads(encoded, object_pairs_hook=pairs, parse_constant=constant))
