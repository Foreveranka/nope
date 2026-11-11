#!/usr/bin/env python3
"""Public-metadata-only reference encoder; SHA-256 of explicit Borsh v1/v2 schemas.

Import these functions or pipe {operation, ...} JSON to this script. Does not reveal,
execute, attest, contact a network, or write secret material. Python >= 3.9, stdlib.
"""
import hashlib
import json
import re
import struct
import sys

FIELDS = ("spec_hash", "circuit_hash", "key_hash", "output_policy_hash",
          "context_hash", "input_hash", "budget_commitment")
CLAIM_FIELDS = ("job_binding_hash", "attempt_binding_hash", "bidset_root") + FIELDS + ("output_hash",)


def string(value):
    encoded = value.encode("utf-8")
    return struct.pack("<I", len(encoded)) + encoded


def u64(value):
    return struct.pack("<Q", int(value))


def hash32(value):
    if not isinstance(value, list) or len(value) != 32 or any(type(v) is not int or not 0 <= v <= 255 for v in value):
        raise ValueError("hash must be exactly 32 byte integers")
    return bytes(value)


def digest(encoded):
    return list(hashlib.sha256(encoded).digest())


def job_hash(contract_account, network_domain_hash, job):
    config = job["config"]
    roster = config["authorized_bidders"]
    if roster != sorted(set(roster)) or not 1 <= len(roster) <= 10:
        raise ValueError("job view must contain canonical unique roster of 1..10")
    encoded = string("veil/job/v1") + string(contract_account) + hash32(network_domain_hash)
    encoded += u64(job["job_id"]) + string(job["buyer"])
    encoded += b"".join(hash32(config[f]) for f in FIELDS)
    encoded += u64(config["bid_deadline_ns"]) + u64(config["result_deadline_ns"])
    encoded += struct.pack("<I", len(roster)) + b"".join(string(a) for a in roster)
    return digest(encoded + string(config["executor"]))


def bidset_root(job):
    bids = job["bids"]
    if [b["bidder"] for b in bids] != job["config"]["authorized_bidders"]:
        raise ValueError("full canonical roster required, including absent commitments")
    encoded = string("veil/bidset/v1") + hash32(job["job_binding_hash"]) + struct.pack("<I", len(bids))
    for entry in bids:
        encoded += string(entry["bidder"])
        encoded += b"\x00" if entry["commitment"] is None else b"\x01" + hash32(entry["commitment"])
    return digest(encoded)


def attempt_hash(job):
    selected = job.get("selected_executor")
    version = job.get("attempt_binding_version")
    has_selection = "selected_executor" in job
    has_version = "attempt_binding_version" in job
    if has_selection != has_version:
        raise ValueError("selection fields must be paired")
    if type(version) is int and version == 2 and isinstance(selected, str) and selected:
        tag, tail = "veil/attempt/v2", string(selected)
    elif selected is None and (not has_version or type(version) is int and version == 1):
        tag, tail = "veil/attempt/v1", b""
    else:
        raise ValueError("invalid executed-job binding version/selection")
    return digest(string(tag) + hash32(job["job_binding_hash"])
                  + hash32(job["bidset_root"]) + u64(job["attempt"]) + tail)


def receipt_hash(claim):
    return digest(string("veil/receipt/v1") + u64(claim["job_id"]) + u64(claim["attempt"])
                  + b"".join(hash32(claim[f]) for f in CLAIM_FIELDS))


def bid_commitment(job_binding_hash, bidder, payload_hash, salt):
    return digest(string("veil/bid/v1") + hash32(job_binding_hash) + string(bidder)
                  + hash32(payload_hash) + hash32(salt))


def example():
    config = {f: [i] * 32 for i, f in enumerate(FIELDS, 1)}
    config.update(bid_deadline_ns="100", result_deadline_ns="200",
                  authorized_bidders=["alpha.near", "zulu.near"], executor="executor.near")
    job = {"job_id": "1", "buyer": "buyer.near", "config": config,
           "bids": [{"bidder": "alpha.near", "commitment": None},
                    {"bidder": "zulu.near", "commitment": [9] * 32}], "attempt": "1"}
    job["job_binding_hash"] = job_hash("registry.test.near", [42] * 32, job)
    job["bidset_root"] = bidset_root(job)
    job["attempt_binding_hash"] = attempt_hash(job)
    claim = {f: config[f] for f in FIELDS}
    claim.update({f: job[f] for f in ("job_id", "attempt", "job_binding_hash", "attempt_binding_hash", "bidset_root")})
    claim["output_hash"] = [10] * 32
    receipt = receipt_hash(claim)
    return {"notice": "Synthetic mock-time vector, NOT live submission timestamps. Set real future deadlines before use. Opaque bid [9]*32 is a fixture, not proof of a valid preimage.",
            "contract_account": "registry.test.near", "network_domain_hash": [42] * 32,
            "job": job,
            "calls": [
                {"method": "new", "predecessor": "registry.test.near", "args": {"owner": "buyer.near", "network_domain_hash": [42] * 32}},
                {"method": "create_job", "predecessor": "buyer.near", "args": {"config": config}},
                {"method": "submit_bid", "predecessor": "zulu.near", "args": {"job_id": "1", "expected_job_binding_hash": job["job_binding_hash"], "commitment": [9] * 32}},
                {"method": "close_bids", "predecessor": "anyone.near", "args": {"job_id": "1"}},
                {"method": "begin_attempt", "predecessor": "buyer.near", "args": {"job_id": "1", "expected_bidset_root": job["bidset_root"]}},
                {"method": "report_result", "predecessor": "executor.near", "args": {"claim": claim}},
                {"method": "decide_result", "predecessor": "buyer.near", "args": {"job_id": "1", "expected_receipt_hash": receipt, "accept": True}}],
            "receipt_hash": receipt}


if __name__ == "__main__":
    if sys.argv[1:] == ["--example"]:
        result = example()
    else:
        request = json.load(sys.stdin)
        operation = request.pop("operation")
        operations = {"job_hash": job_hash, "bidset_root": bidset_root, "attempt_hash": attempt_hash,
                      "receipt_hash": receipt_hash, "bid_commitment": bid_commitment}
        result = operations[operation](**request)
    output = json.dumps(result, indent=2)
    # Keep fixed 32-byte arrays readable in the integration fixture.
    output = re.sub(r"\[\n(?: +\d+,\n)* +\d+\n *\]", lambda m: json.dumps(json.loads(m[0])), output)
    print(output)
