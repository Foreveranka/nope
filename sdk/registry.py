"""Validate locally trusted registry views against their public hash bindings.

This is not a light client: caller must supply authenticated/finalized views and
the trusted contract/network identities. Hash equality alone cannot do that.
"""
import hashlib
import struct

from .receipt import BindingError, CONFIG_FIELDS, CONFIG_HASHES, _account, _hash, _shape, _string, _u64


def verify_registry_job(job, *, contract_account, network_domain_hash, expected_config=None):
    _account(contract_account, "contract account")
    domain = _hash(network_domain_hash, "network domain")
    if type(job) is not dict or "config" not in job:
        raise BindingError("Missing registry job")
    config = job["config"]
    _shape(config, CONFIG_FIELDS, "job config")
    if expected_config is not None and config != expected_config:
        raise BindingError("Registry config differs from precommitted intent")
    jid = _u64(job["job_id"], "job id", minimum=1)
    _account(job["buyer"], "buyer")
    for key in CONFIG_HASHES:
        _hash(config[key], key)
    for key in ("bid_deadline_ns", "result_deadline_ns"):
        _u64(config[key], key)
    roster = config["authorized_bidders"]
    if type(roster) is not list or not 1 <= len(roster) <= 10:
        raise BindingError("Invalid roster")
    for account in roster:
        _account(account, "bidder")
    if roster != sorted(set(roster)):
        raise BindingError("Noncanonical roster")
    _account(config["executor"], "executor")
    encoded = (_string("veil/job/v1") + _string(contract_account) + domain +
               struct.pack("<Q", jid) + _string(job["buyer"]) +
               b"".join(bytes(config[k]) for k in CONFIG_HASHES) +
               struct.pack("<QQ", int(config["bid_deadline_ns"]), int(config["result_deadline_ns"])) +
               struct.pack("<I", len(roster)) + b"".join(_string(a) for a in roster) +
               _string(config["executor"]))
    if hashlib.sha256(encoded).digest() != _hash(job["job_binding_hash"], "job binding"):
        raise BindingError("Registry job binding mismatch")
    bids = job["bids"]
    if type(bids) is not list or len(bids) != len(roster):
        raise BindingError("Incomplete bidset")
    encoded = _string("veil/bidset/v1") + bytes(job["job_binding_hash"]) + struct.pack("<I", len(bids))
    for account, entry in zip(roster, bids):
        _shape(entry, {"bidder", "commitment"}, "bid entry")
        if entry["bidder"] != account:
            raise BindingError("Reordered bidset")
        commitment = entry["commitment"]
        encoded += _string(account) + (b"\x00" if commitment is None else
                                       b"\x01" + _hash(commitment, "bid commitment"))
    if job["state"] == "Open":
        if job["bidset_root"] is not None:
            raise BindingError("Open job cannot have frozen bids")
    elif job["bidset_root"] is not None:
        if hashlib.sha256(encoded).digest() != _hash(job["bidset_root"], "bidset root"):
            raise BindingError("Full bidset root mismatch")
    elif job["state"] != "Expired":
        raise BindingError("Missing frozen bidset")
    return True
