"""Strict, dependency-free offline checks for a future three-host MPC plan.

No sockets, subprocesses, certificate issuance, accounts, or transport changes.
Python 3.9+. All hashes pin declarations, not proof of a running deployment.
"""

import argparse
import hashlib
import ipaddress
import json
from pathlib import Path
import re
import sys


PROFILE = "sealed-cheapest-3-spdz2k-v1"
UPSTREAM = "cd4d517a8a37b266d7233ae412717ca181cec6bf"
MAX_BYTES = 65536
MAX_AMOUNT = 10**12
BLOCKERS = (
    "Current MPC transport binds listeners to loopback only; separate-host transport is unsupported.",
    "Administrative independence cannot be proved by this offline manifest.",
    "Certificate ownership, actual artifacts, reachability and registry provenance are unverified.",
)


class ManifestError(ValueError):
    """Invalid declaration; messages deliberately omit supplied field values."""


def _require(condition, message):
    if not condition:
        raise ManifestError(message)


def _object(value, keys, path):
    _require(type(value) is dict and set(value) == set(keys), path + ": exact schema required")


def _int(value, low, high, path):
    _require(type(value) is int and low <= value <= high, path + ": integer out of range")


def _hash(value, path):
    _require(type(value) is str and re.fullmatch(r"[0-9a-f]{64}", value) is not None
             and value != "0" * 64, path + ": nonzero lowercase SHA-256 required")


def _identity(value, path):
    _require(type(value) is str and re.fullmatch(r"[a-z][a-z0-9-]{0,62}", value) is not None,
             path + ": canonical lowercase identity required")


def _host(value):
    _require(type(value) is str and 0 < len(value) <= 253, "operator.host: invalid host")
    try:
        addr = ipaddress.ip_address(value)
    except ValueError:
        # No ambiguous numeric IPv4 forms, userinfo, ports, URI schemes, IDNA,
        # trailing dot, localhost aliases, zone identifiers, or local mDNS names.
        labels = value.split(".")
        _require(len(labels) >= 2 and not labels[-1].isdigit()
                 and all(re.fullmatch(r"[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?", x)
                         is not None for x in labels)
                 and not any(x.startswith("xn--") for x in labels)
                 and not any(value == x or value.endswith("." + x)
                             for x in ("localhost", "local", "localdomain")),
                 "operator.host: canonical nonlocal DNS name required")
    else:
        _require(str(addr) == value and "%" not in value and not (
            addr.is_loopback or addr.is_unspecified or addr.is_multicast
            or addr.is_link_local or addr.is_reserved
            or (isinstance(addr, ipaddress.IPv4Address) and addr.packed[0] == 0)
            or (isinstance(addr, ipaddress.IPv6Address) and addr.ipv4_mapped is not None)),
            "operator.host: canonical unicast nonloopback address required")
    return value


def canonical(value):
    """Same JSON encoding as MPC v1, not the proposed registry v2 codec."""
    try:
        return json.dumps(value, sort_keys=True, separators=(",", ":"),
                          ensure_ascii=True, allow_nan=False).encode("ascii")
    except (TypeError, ValueError, RecursionError):
        raise ManifestError("manifest: not canonical JSON data") from None


def digest(value):
    return hashlib.sha256(canonical(value)).hexdigest()


def _pairs(pairs):
    result = {}
    for key, value in pairs:
        _require(key not in result, "JSON: duplicate object key")
        result[key] = value
    return result


def _nonfinite(_value):
    raise ManifestError("JSON: nonfinite number")


def parse_manifest(raw):
    """Strict UTF-8 JSON, with bounded bytes and duplicate-key detection."""
    _require(type(raw) is bytes and len(raw) <= MAX_BYTES, "manifest: maximum 65536 bytes")
    try:
        return json.loads(raw.decode("utf-8"), object_pairs_hook=_pairs,
                          parse_constant=_nonfinite)
    except (UnicodeError, ValueError, RecursionError):
        raise ManifestError("manifest: invalid UTF-8 JSON, duplicate key or nonfinite number") from None


def load_manifest(path):
    # Read at most MAX_BYTES+1 even when given an oversized local file.
    with Path(path).open("rb") as stream:
        return parse_manifest(stream.read(MAX_BYTES + 1))


def validate_manifest(manifest, expected_sha256):
    """Validate a declaration against an independently obtained canonical digest.

    The caller supplies trust in the digest out of band. Distinct declarations
    are not evidence that different humans control hosts, keys or organizations.
    Never mutate input, read artifact paths, resolve DNS, or launch processes.
    """
    _hash(expected_sha256, "expected_sha256")
    _object(manifest, ("schema", "execution_mode", "execution", "execution_sha256", "build",
                       "trust_anchor_sha256", "operators"), "manifest")
    _require(manifest["schema"] == "veil-operator-plan-v1", "manifest: unsupported schema")
    mode = manifest["execution_mode"]
    _require(mode in ("v1-compatibility", "v2-selection"), "manifest: explicit execution mode required")
    execution = manifest["execution"]
    if mode == "v2-selection":
        try:
            # Lazy import: one authoritative strict codec, no copied v2 rules,
            # no source hash reads, synthetic preparation, or execution here.
            from mpc import v2
            v2.validate_manifest(execution)
            execution_hash = v2.manifest_digest(execution)
            source_hash = execution["mpcBuild"]["circuitSourceHash"]
        except (ValueError, TypeError, KeyError, AttributeError, OverflowError, ImportError):
            raise ManifestError("execution: invalid or unavailable v2 selection codec") from None
    else:
        execution_hash = _validate_v1_execution(execution)
        source_hash = None
    _hash(manifest["execution_sha256"], "execution_sha256")
    _require(execution_hash == manifest["execution_sha256"], "execution_sha256: mismatch")

    build = manifest["build"]
    build_hashes = ("source_sha256", "transport_patch_sha256", "build_recipe_sha256",
                    "binary_sha256", "bytecode_sha256", "schedule_sha256")
    _object(build, ("upstream",) + build_hashes, "build")
    _require(build["upstream"] == UPSTREAM, "build: unsupported upstream")
    for key in build_hashes:
        _hash(build[key], "build." + key)
    if source_hash is not None:
        _require(build["source_sha256"] == source_hash, "build: v2 circuit source mismatch")
    _hash(manifest["trust_anchor_sha256"], "trust_anchor_sha256")

    _validate_operators(manifest)
    actual = digest(manifest)
    _require(actual == expected_sha256, "manifest: trusted digest mismatch")
    return {
        "manifest_valid": True,
        "manifest_sha256": actual,
        "execution_mode": mode,
        "execution_sha256": manifest["execution_sha256"],
        "deployment_allowed": False,
        "administrative_independence_proven": False,
        "network_checked": False,
        "artifacts_verified": False,
        "registry_finality_verified": False,
        "blockers": list(BLOCKERS),
    }


def _validate_v1_execution(execution):
    """Legacy local context only; no claim of noncircular registry binding."""
    _object(execution, ("descriptor", "commitments"), "execution")
    desc = execution["descriptor"]
    _object(desc, ("profile", "upstream", "job", "attempt", "qualified", "fixedFee"),
            "execution.descriptor")
    _require(desc["profile"] == PROFILE and desc["upstream"] == UPSTREAM,
             "execution.descriptor: unsupported profile/upstream")
    for key in ("job", "attempt"):
        _hash(desc[key], "execution.descriptor." + key)
    _require(type(desc["qualified"]) is list and len(desc["qualified"]) == 3
             and all(type(x) is bool for x in desc["qualified"]),
             "execution.descriptor.qualified: three booleans required")
    _int(desc["fixedFee"], 0, MAX_AMOUNT, "execution.descriptor.fixedFee")
    commitments = execution["commitments"]
    _require(type(commitments) is list and len(commitments) == 4,
             "execution.commitments: buyer plus three ordered bidder commitments required")
    for entry in commitments:
        _hash(entry, "execution.commitments")
    _require(len(set(commitments)) == 4, "execution.commitments: duplicate commitment")
    return digest(execution)


def _validate_operators(manifest):
    operators = manifest["operators"]
    _require(type(operators) is list and len(operators) == 3, "operators: exactly three required")
    identities, admins, hosts, certs = set(), set(), set(), {manifest["trust_anchor_sha256"]}
    for party, op in enumerate(operators):
        _object(op, ("party", "identity", "administrative_domain", "host", "peer_port",
                     "client_port", "certificate_sha256"), "operator")
        _int(op["party"], 0, 2, "operator.party")
        _require(op["party"] == party, "operators: ordered P0/P1/P2 required")
        for key, seen in (("identity", identities), ("administrative_domain", admins)):
            _identity(op[key], "operator." + key)
            _require(op[key] not in seen, "operators: duplicate " + key)
            seen.add(op[key])
        host = _host(op["host"])
        _require(host not in hosts, "operators: separate declared hosts required")
        hosts.add(host)
        for key in ("peer_port", "client_port"):
            _int(op[key], 1, 65535, "operator." + key)
        _require(op["peer_port"] != op["client_port"], "operator: endpoint port collision")
        cert = op["certificate_sha256"]
        _hash(cert, "operator.certificate_sha256")
        _require(cert not in certs, "operators: leaf pins must differ from each other and the CA")
        certs.add(cert)


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("manifest", help="local public JSON plan (maximum 64 KiB)")
    parser.add_argument("--expected-sha256", required=True,
                        help="trusted SHA-256 of canonical plan, obtained independently")
    parser.add_argument("--structure-only", action="store_true",
                        help="exit 0 for a valid plan; still never authorize deployment")
    args = parser.parse_args(argv)
    try:
        report = validate_manifest(load_manifest(args.manifest), args.expected_sha256)
    except (ManifestError, OSError):
        # Do not echo filenames, unknown fields, arbitrary input values or secrets.
        print(json.dumps({"manifest_valid": False, "deployment_allowed": False,
                          "error": "Invalid manifest, trusted digest mismatch, or unreadable file."}))
        return 2
    print(json.dumps(report, sort_keys=True))
    return 0 if args.structure_only else 3


if __name__ == "__main__":
    sys.exit(main())
