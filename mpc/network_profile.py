"""Offline, explicitly opted-in remote MPC network profile and launch rendering.

No socket/DNS access, subprocesses, file writes, or changes to existing transport.
Native commands describe a REQUIRED future native interface, not a launcher.
The strict client implements profile opt-in; the current loopback native runtime
still cannot execute this profile.
"""

import argparse
from dataclasses import dataclass
import hashlib
import ipaddress
import json
from pathlib import Path
import re
import sys
import time


SCHEMA = "veil-mpc-network-profile-v1"
TRANSPORT = "remote-mtls-ipv4-v1"
UPSTREAM = "cd4d517a8a37b266d7233ae412717ca181cec6bf"
CLIENT_PORT_BASE = 17400
PEER_PORT_BASE = 17500
MAX_BYTES = 65536
MAX_LIFETIME = 86400
PROFILE_PATH = "/etc/veil-mpc/network-profile.json"
PEERS_PATH = "/etc/veil-mpc/peers.txt"
SELECTION_PATH = "/etc/veil-mpc/selection.json"
PARTY_WORKDIR = "/var/lib/veil-mpc/job"
NATIVE_BINARY = "/opt/veil-mpc/spdz2k-party.x"
_HASH = re.compile(r"[0-9a-f]{64}")
_METADATA = {ipaddress.IPv4Address("100.100.100.200"),
             ipaddress.IPv4Address("168.63.129.16")}


class NetworkProfileError(ValueError):
    """Rejected public configuration; diagnostics never include supplied values."""


def _require(ok, message):
    if not ok:
        raise NetworkProfileError(message)


def _object(value, fields, path):
    _require(type(value) is dict and set(value) == set(fields), path + ": exact schema required")


def _integer(value, low, high, path):
    _require(type(value) is int and low <= value <= high, path + ": invalid integer")


def _hash(value, path):
    _require(type(value) is str and _HASH.fullmatch(value) is not None and value != "0"*64,
             path + ": nonzero lowercase SHA-256 required")


def canonical(value):
    try:
        return json.dumps(value, ensure_ascii=True, sort_keys=True, separators=(",", ":"),
                          allow_nan=False).encode("ascii")
    except (TypeError, ValueError, RecursionError):
        raise NetworkProfileError("profile: invalid canonical JSON") from None


def profile_digest(value):
    """Review helper, NOT permission to trust a digest from incoming HTTP data."""
    return hashlib.sha256(canonical(value)).hexdigest()


def _pairs(pairs):
    result = {}
    for key, value in pairs:
        _require(key not in result, "JSON: duplicate key")
        result[key] = value
    return result


def _nonfinite(_value):
    raise NetworkProfileError("JSON: nonfinite value")


def _tree(value, depth=0):
    _require(depth <= 16, "JSON: nesting exceeds limit")
    if type(value) is dict:
        for item in value.values():
            _tree(item, depth+1)
    elif type(value) is list:
        for item in value:
            _tree(item, depth+1)
    else:
        _require(value is None or type(value) in (str, int, bool), "JSON: unsupported scalar")


def parse_profile(raw):
    _require(type(raw) is bytes and 0 < len(raw) <= MAX_BYTES, "JSON: bounded bytes required")
    try:
        value = json.loads(raw.decode("utf-8"), object_pairs_hook=_pairs, parse_constant=_nonfinite)
        _tree(value)
        return value
    except (UnicodeError, ValueError, RecursionError):
        raise NetworkProfileError("JSON: invalid, duplicate, nonfinite or excessively nested input") from None


def load_profile(path):
    with Path(path).open("rb") as stream:
        return parse_profile(stream.read(MAX_BYTES+1))


def _address(value):
    _require(type(value) is str, "endpoint: IPv4 literal required")
    try:
        address = ipaddress.IPv4Address(value)
    except ipaddress.AddressValueError:
        raise NetworkProfileError("endpoint: canonical IPv4 literal required") from None
    _require(str(address) == value and not (
        address.is_loopback or address.is_link_local or address.is_multicast
        or address.is_unspecified or address.is_reserved or address.packed[0] == 0
        or address in _METADATA), "endpoint: disallowed address")
    return value


@dataclass(frozen=True)
class ValidatedProfile:
    """An immutable public snapshot, not authorization to start native processes."""
    canonical_profile: bytes
    profile_sha256: str
    selection_manifest_sha256: str

    def as_dict(self):
        return json.loads(self.canonical_profile)


def validate_profile(profile, expected_sha256, selection_manifest, *, allow_remote=False, now=None):
    """Validate against an OUT-OF-BAND approval pin and exact closed v2 job.

    Only literal IPv4 is supported. The fixed port layout is not HTTP input.
    A public/private address declaration is not a reachability or ownership check.
    Caller must separately enforce durable epoch/round replay and artifact/PKI
    checks. No trusted configuration is discovered from the profile itself.
    """
    _require(allow_remote is True, "remote network: explicit local opt-in required")
    _hash(expected_sha256, "trusted profile digest")
    # Snapshot before validation; renderers cannot use a mutable caller object.
    profile = parse_profile(canonical(profile))
    _object(profile, ("schema", "transport", "upstream", "epoch", "not_before", "expires_at",
                      "selection_manifest_sha256", "registry_job_id", "job_binding_hash",
                      "selection_round", "trust_anchor_sha256", "parties", "clients", "program"), "profile")
    _require(profile["schema"] == SCHEMA and profile["transport"] == TRANSPORT,
             "profile: unsupported schema or transport")
    _require(profile["upstream"] == UPSTREAM, "profile: unsupported upstream")
    for field in ("epoch", "not_before", "expires_at"):
        _integer(profile[field], 1, 2**63-1, "profile." + field)
    if now is None:
        now = int(time.time())
    _integer(now, 1, 2**63-1, "clock")
    _require(profile["not_before"] <= now < profile["expires_at"] and
             0 < profile["expires_at"]-profile["not_before"] <= MAX_LIFETIME,
             "profile: inactive, expired or excessive lifetime")
    for field in ("selection_manifest_sha256", "job_binding_hash", "selection_round", "trust_anchor_sha256"):
        _hash(profile[field], "profile." + field)

    # Existing authoritative codec; never reinterpret a v1 descriptor as v2.
    try:
        from mpc import v2
        selection = v2.load_manifest(canonical(selection_manifest))
        v2.validate_manifest(selection)
        selection_hash = v2.manifest_digest(selection)
    except (ValueError, TypeError, KeyError, AttributeError, OverflowError, ImportError):
        raise NetworkProfileError("selection: invalid v2 closed-job manifest") from None
    job, intent = selection["closedJob"], selection["intent"]
    _require(profile["selection_manifest_sha256"] == selection_hash and
             type(profile["registry_job_id"]) is str and profile["registry_job_id"] == job["job_id"] and
             profile["job_binding_hash"] == bytes(job["job_binding_hash"]).hex() and
             profile["selection_round"] == selection["selectionRound"], "profile: foreign selection context")
    _require(int(job["closed_at_ns"]) <= now*10**9 and
             profile["expires_at"]*10**9 <= int(intent["resultDeadlineNs"]),
             "profile: outside closed-job execution window")

    parties = profile["parties"]
    _require(type(parties) is list and len(parties) == 3, "profile: exactly three parties required")
    addresses, certificates = set(), {profile["trust_anchor_sha256"]}
    for party, entry in enumerate(parties):
        _object(entry, ("party", "address", "peer_port", "client_port", "tls_name", "certificate_sha256"), "party")
        _integer(entry["party"], 0, 2, "party number")
        _require(entry["party"] == party and entry["tls_name"] == "P%d" % party,
                 "party: ordered TLS identities required")
        address = _address(entry["address"])
        _require(address not in addresses, "party: duplicate address")
        addresses.add(address)
        for key, base in (("peer_port", PEER_PORT_BASE), ("client_port", CLIENT_PORT_BASE)):
            _integer(entry[key], 1, 65535, "party port")
            _require(entry[key] == base+party, "party: fixed port layout required")
        pin = entry["certificate_sha256"]
        _hash(pin, "party certificate")
        _require(pin not in certificates, "profile: duplicate certificate pin")
        certificates.add(pin)
    clients = profile["clients"]
    _require(type(clients) is list and len(clients) == 4, "profile: exactly four clients required")
    for client, entry in enumerate(clients):
        _object(entry, ("client", "tls_name", "certificate_sha256"), "client")
        _integer(entry["client"], 0, 3, "client number")
        _require(entry["client"] == client and entry["tls_name"] == "C%d" % client,
                 "client: ordered TLS identities required")
        pin = entry["certificate_sha256"]
        _hash(pin, "client certificate")
        _require(pin not in certificates, "profile: duplicate certificate pin")
        certificates.add(pin)
    program = profile["program"]
    build_fields = ("source_sha256", "transport_patch_sha256", "build_recipe_sha256",
                    "binary_sha256", "bytecode_sha256", "schedule_sha256")
    _object(program, ("name",)+build_fields, "program")
    name = program["name"]
    _require(type(name) is str and len(name) <= 240 and
             re.fullmatch(r"sealed_v2_" + selection_hash[:16] + r"(?:-[A-Za-z0-9_.-]+)?", name) is not None,
             "program: context-prefixed safe basename required")
    for key in build_fields:
        _hash(program[key], "program." + key)
    _require(program["source_sha256"] == selection["mpcBuild"]["circuitSourceHash"],
             "program: v2 source declaration mismatch")
    actual = profile_digest(profile)
    _require(actual == expected_sha256, "profile: trusted digest mismatch")
    return ValidatedProfile(canonical(profile), actual, selection_hash)


def validate_client_profile(profile, expected_sha256, selection_manifest, *, identity, port,
                            allow_remote=False, now=None):
    """Revalidate an immutable SERVER-configured profile at the client boundary.

    Raw dictionaries/host lists are deliberately not a client transport API.
    Explicit opt-in plus an independently configured approval pin remain required,
    even for a previously validated instance; validity can expire between calls.
    """
    _require(type(profile) is ValidatedProfile, "client: validated server-owned profile required")
    _require(type(identity) is str and re.fullmatch(r"C[0-3]", identity) is not None,
             "client: fixed C0-C3 identity required")
    _integer(port, CLIENT_PORT_BASE, CLIENT_PORT_BASE, "client port base")
    checked = validate_profile(profile.as_dict(), expected_sha256, selection_manifest,
                               allow_remote=allow_remote, now=now)
    _require(profile.profile_sha256 == checked.profile_sha256 and
             profile.selection_manifest_sha256 == checked.selection_manifest_sha256,
             "client: validated snapshot metadata mismatch")
    return checked


def render_profile(profile, expected_sha256, selection_manifest, *, party, allow_remote=False, now=None):
    """Return deterministic addresses + argv; deliberately never execute/write.

    The strict client implements the profile flags. The native binary does NOT.
    Native argv remains a launch specification, never a supported command today.
    Do not strip these flags to bypass the existing loopback restriction.
    """
    checked = validate_profile(profile, expected_sha256, selection_manifest,
                               allow_remote=allow_remote, now=now)
    _integer(party, 0, 2, "render party")
    data = checked.as_dict()
    own = data["parties"][party]
    remote_options = ["--allow-remote-network", "--network-profile", PROFILE_PATH,
                      "--network-profile-sha256", checked.profile_sha256]
    native = [NATIVE_BINARY, "-N", "3", "-p", str(party), "-ip", PEERS_PATH,
              "-pn", str(PEER_PORT_BASE), "-SP", "64", "-S", "40", "-b", "1024",
              "-OF", "."] + remote_options + [data["program"]["name"]]
    clients = []
    for client in range(4):
        clients.append([
            "/usr/bin/python3", "-m", "mpc.sealed_client", "--codec-version", "2",
            "--manifest", SELECTION_PATH, "--expected-manifest-hash", checked.selection_manifest_sha256,
            "--client-id", str(client), "--port", str(CLIENT_PORT_BASE),
            "--cert-dir", "/etc/veil-mpc/clients/C%d/Player-Data" % client,
        ] + remote_options)
    return {
        "profile_valid": True, "profile_sha256": checked.profile_sha256,
        "selection_manifest_sha256": checked.selection_manifest_sha256,
        "registry_job_id": data["registry_job_id"], "job_binding_hash": data["job_binding_hash"],
        "selection_round": data["selection_round"], "epoch": data["epoch"],
        "execution_blocked": True, "launch_supported": False, "deployment_allowed": False,
        "commands_executable_now": False, "independent_operators_verified": False,
        "client_transport_implemented": True, "native_transport_implemented": False,
        "client_independent_host_verified": False,
        "tls_material_verified": False, "artifacts_verified": False,
        "registry_finality_verified": False, "network_checked": False,
        "required_transport": TRANSPORT, "party": party,
        "bind_address": own["address"], "bind_ports": [own["peer_port"], own["client_port"]],
        "tls_identity": own["tls_name"],
        "tls_leaf_sha256": own["certificate_sha256"],
        "peers_path": PEERS_PATH,
        "peers_text": "".join("%s:%d\n" % (p["address"], p["peer_port"]) for p in data["parties"]),
        "client_endpoints": [dict(address=p["address"], port=p["client_port"],
                                  tls_name=p["tls_name"], certificate_sha256=p["certificate_sha256"])
                             for p in data["parties"]],
        "party_working_directory": PARTY_WORKDIR, "pending_native_argv": native,
        "pending_client_argv": clients, "client_argv": clients,
        "blockers": [
            "Native listeners are still loopback-only; remote profile flags are unimplemented.",
            "Native peer setup still makes loopback self-connections.",
            "Opt-in remote clients require approved TLS endpoints; no independent-host run is verified.",
            "Per-party launch, real TLS/artifact checks and independent custody remain unverified.",
        ],
    }


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--profile", required=True)
    parser.add_argument("--expected-sha256", required=True)
    parser.add_argument("--selection-manifest", required=True)
    parser.add_argument("--party", type=int, choices=(0, 1, 2), required=True)
    parser.add_argument("--allow-remote-network", action="store_true")
    args = parser.parse_args(argv)
    try:
        result = render_profile(load_profile(args.profile), args.expected_sha256,
                                load_profile(args.selection_manifest), party=args.party,
                                allow_remote=args.allow_remote_network)
    except (NetworkProfileError, OSError):
        print(json.dumps({"profile_valid": False, "execution_blocked": True,
                          "deployment_allowed": False, "error": "Network profile rejected."}))
        return 2
    print(json.dumps(result, sort_keys=True))
    return 3  # Valid rendering is never permission to execute an unsupported transport.


if __name__ == "__main__":
    sys.exit(main())
