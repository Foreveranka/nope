"""Strict ExternalIO ring client, loopback by default; approved remote opt-in.

Unlike upstream's example Python client, requires TLS peer verification, fixed
active triple frames, bounded complete reads, and a post-CHECK finish marker.
Secrets enter on stdin, never argv. Remote mode accepts an immutable server-owned
network profile and independent approval pin, not browser-provided hosts. Native
remote listeners and independent-host execution remain unimplemented/unverified.
"""
import argparse
import hashlib
import json
import math
import os
import re
import socket
import ssl
import stat
import struct
import sys
import time
from pathlib import Path

if not __package__:
    sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from mpc.auction import MAX_AMOUNT, digest, integer, validate_manifest

MASK = (1 << 128) - 1


def _remaining(deadline, expires_at=None):
    remaining = deadline - time.monotonic()
    if expires_at is not None:
        remaining = min(remaining, expires_at - time.time())
    if remaining <= 0:
        raise TimeoutError("MPC client deadline or network profile expired")
    return remaining


def _connection_deadline(timeout, expires_at=None):
    # Freeze the initial wall-clock lifetime into a monotonic limit too, so a
    # later backward clock correction cannot extend an approved profile's life.
    budget = timeout if expires_at is None else min(timeout, expires_at-time.time())
    return time.monotonic() + budget


class _DeadlineSocket:
    """Enforce one remote operation deadline across partial frames, not per read."""
    def __init__(self, sock, deadline, expires_at):
        self.sock, self.deadline, self.expires_at = sock, deadline, expires_at

    def recv(self, size):
        self.sock.settimeout(_remaining(self.deadline, self.expires_at))
        result = self.sock.recv(size)
        _remaining(self.deadline, self.expires_at)
        return result

    def sendall(self, value):
        self.sock.settimeout(_remaining(self.deadline, self.expires_at))
        self.sock.sendall(value)
        _remaining(self.deadline, self.expires_at)

    def close(self):
        self.sock.close()


def _connect_ipv4(address, port, timeout):
    """Literal AF_INET only: no DNS or endpoint discovery in remote mode."""
    raw = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    try:
        raw.settimeout(timeout)
        raw.connect((address, port))
        return raw
    except BaseException:
        raw.close()
        raise


def _pinned_certificate(path, expected_sha256):
    with path.open("rb") as stream:
        pem = stream.read(65537)
    if len(pem) > 65536:
        raise ValueError("MPC certificate exceeds size limit")
    text = pem.decode("ascii").strip()
    if (not text.startswith("-----BEGIN CERTIFICATE-----") or
            not text.endswith("-----END CERTIFICATE-----") or
            text.count("-----BEGIN CERTIFICATE-----") != 1 or
            text.count("-----END CERTIFICATE-----") != 1):
        raise ValueError("one public MPC certificate required")
    der = ssl.PEM_cert_to_DER_cert(text)
    if hashlib.sha256(der).hexdigest() != expected_sha256:
        raise ValueError("MPC local certificate differs from approved network profile")
    return der


def _remote_material(directory, identity, profile):
    if not directory.is_absolute() or directory.is_symlink() or not directory.is_dir():
        raise ValueError("absolute configured MPC certificate directory required")
    key = directory / (identity + ".key")
    info = key.lstat()
    if (not stat.S_ISREG(info.st_mode) or info.st_uid != os.geteuid() or info.st_mode & 0o077):
        raise ValueError("MPC own private key requires safe ownership and permissions")
    if {p.name for p in directory.glob("*.key")} != {key.name}:
        raise ValueError("MPC client directory contains foreign private keys")
    root = _pinned_certificate(directory / "trust.pem", profile["trust_anchor_sha256"])
    parties = [_pinned_certificate(directory / (p["tls_name"] + ".pem"), p["certificate_sha256"])
               for p in profile["parties"]]
    for client in profile["clients"]:
        _pinned_certificate(directory / (client["tls_name"] + ".pem"), client["certificate_sha256"])
    return root, parties


def read_exact(sock, n):
    chunks = bytearray()
    while len(chunks) < n:
        part = sock.recv(n - len(chunks))
        if not part:
            raise EOFError("truncated external I/O frame")
        chunks.extend(part)
    return bytes(chunks)


def receive(sock, expected=None):
    size, = struct.unpack("<I", read_exact(sock, 4))
    if size > 65536 or (expected is not None and size != expected):
        raise ValueError("unexpected external I/O frame length")
    return read_exact(sock, size)


def send(sock, payload):
    if len(payload) > 65536:
        raise ValueError("external I/O frame too large")
    sock.sendall(struct.pack("<I", len(payload)) + payload)


def active_triples(sockets, n):
    triples = [[0, 0, 0] for _ in range(n)]
    for sock in sockets:
        frame = receive(sock, 3 * n * 16)
        for j in range(n):
            for k in range(3):
                start = (3 * j + k) * 16
                triples[j][k] = (triples[j][k] + int.from_bytes(
                    frame[start:start + 16], "little")) & MASK
    for a, b, c in triples:
        if a * b & MASK != c:
            raise ValueError("external active triple check failed")
    return triples


def connect(identity, port, certificate_dir, timeout, *, network_profile=None,
            expected_network_profile_sha256=None, selection_manifest=None, allow_remote_network=False):
    """Connect to the original local endpoints or an explicitly approved profile.

    Remote configuration belongs to a local CLI/server adapter. No HTTP host/port
    fields, environment discovery or implicit profile acceptance are provided.
    """
    if type(identity) is not str or re.fullmatch(r"C[0-3]", identity) is None:
        raise ValueError("fixed C0-C3 client identity required")
    if type(timeout) not in (int, float) or not math.isfinite(timeout) or not 0 < timeout <= 3600:
        raise ValueError("bounded positive MPC client timeout required")
    integer(port, 1024, 65532, "port")
    certificate_dir = Path(certificate_dir)
    remote = (network_profile is not None or expected_network_profile_sha256 is not None
              or allow_remote_network is not False)
    profile = None
    if remote:
        from mpc.network_profile import validate_client_profile
        checked = validate_client_profile(network_profile, expected_network_profile_sha256, selection_manifest,
                                          identity=identity, port=port, allow_remote=allow_remote_network)
        profile = checked.as_dict()
        root_der, expected_parties = _remote_material(certificate_dir, identity, profile)
    else:
        expected_parties = None
    ctx = ssl.SSLContext(ssl.PROTOCOL_TLS_CLIENT)
    ctx.minimum_version = ssl.TLSVersion.TLSv1_2
    ctx.check_hostname = True
    ctx.verify_mode = ssl.CERT_REQUIRED
    ctx.load_cert_chain(str(certificate_dir / (identity + ".pem")),
                        str(certificate_dir / (identity + ".key")))
    # Each expected certificate is additionally pinned below.
    if remote:
        # Trust the approved in-memory CA snapshot, not default OS stores.
        ctx.load_verify_locations(cadata=ssl.DER_cert_to_PEM_cert(root_der))
    else:
        ctx.load_verify_locations(cafile=str(certificate_dir / "trust.pem"))
    sockets = []
    expires_at = profile["expires_at"] if remote else None
    deadline = _connection_deadline(timeout, expires_at)
    try:
        for party in range(3):
            raw = sock = None
            try:
                while True:
                    remaining = _remaining(deadline, expires_at)
                    try:
                        if remote:
                            endpoint = profile["parties"][party]
                            raw = _connect_ipv4(endpoint["address"], endpoint["client_port"], min(2, remaining))
                        else:
                            raw = socket.create_connection(("127.0.0.1", port+party), timeout=min(2, remaining))
                        break
                    except (ConnectionRefusedError, TimeoutError):
                        time.sleep(min(0.1, _remaining(deadline, expires_at)))
                raw.settimeout(_remaining(deadline, expires_at))
                send(raw, identity[1:].encode("ascii"))
                sock = ctx.wrap_socket(raw, server_hostname="P%d" % party)
                expected = (expected_parties[party] if remote else
                            ssl.PEM_cert_to_DER_cert((certificate_dir / ("P%d.pem" % party)).read_text()))
                if sock.getpeercert(binary_form=True) != expected:
                    raise ValueError("MPC party certificate mismatch")
                _remaining(deadline, expires_at)
                sockets.append(_DeadlineSocket(sock, deadline, expires_at) if remote else sock)
                sock = None  # Ownership transferred to sockets.
            finally:
                if sock is not None:
                    sock.close()
                if raw is not None:
                    raw.close()  # wrap_socket detaches the original on success.
        specs = []
        for s in sockets:
            if not remote:
                s.settimeout(_remaining(deadline))
            specs.append(receive(s, 12))
        if any(s != specs[0] for s in specs) or struct.unpack("<iii", specs[0]) != (ord("R"), 128, 64):
            raise ValueError("expected identical SPDZ2k 64+64 domain")
        if not remote:
            for s in sockets:
                s.settimeout(timeout)  # Existing local per-operation I/O behavior.
        return sockets
    except BaseException:
        for sock in sockets:
            sock.close()
        raise


def run(manifest, client_id, port, certificate_dir, amount, salt, timeout=600,
        unsafe_test_override=None, codec_version=1, expected_manifest_hash=None, *,
        network_profile=None, expected_network_profile_sha256=None, allow_remote_network=False):
    """Original local API plus keyword-only server-configured remote transport.

    Remote callers first use mpc.network_profile.validate_profile with an approved
    out-of-band pin, then pass that immutable instance as network_profile, the
    same expected_network_profile_sha256 and allow_remote_network=True. Require
    codec_version=2, expected_manifest_hash and fixed port 17400. No native
    runtime, provider/wallet identity, chain finality or independence is proven
    by a successful TLS connection. Existing private-input wire checks remain.
    """
    # Explicit version dispatch: v1 never accepts or silently interprets v2.
    if type(codec_version) is not int or codec_version not in (1, 2):
        raise ValueError("unsupported commitment codec")
    if codec_version == 2:
        from mpc.v2 import validate_manifest as validate_v2, manifest_digest, program_hash
        validate_v2(manifest)
        if manifest["mpcBuild"]["circuitSourceHash"] != program_hash():
            raise ValueError("unapproved v2 circuit")
        public_digest = manifest_digest(manifest)
    else:
        validate_manifest(manifest)
        public_digest = digest(manifest)
    if expected_manifest_hash is not None and public_digest != expected_manifest_hash:
        raise ValueError("manifest differs from expected public digest")
    integer(client_id, 0, 3, "client id")
    integer(port, 1024, 65532, "port")
    integer(amount, 0 if client_id == 0 else 1, MAX_AMOUNT)
    if len(salt) != 32:
        raise ValueError("salt32 required")
    remote = (network_profile is not None or expected_network_profile_sha256 is not None
              or allow_remote_network is not False)
    if remote:
        if codec_version != 2 or expected_manifest_hash is None or unsafe_test_override is not None:
            raise ValueError("remote input requires pinned v2 manifest without test overrides")
        from mpc.network_profile import validate_client_profile
        network_profile = validate_client_profile(network_profile, expected_network_profile_sha256, manifest,
                                                  identity="C%d" % client_id, port=port,
                                                  allow_remote=allow_remote_network)
    values = [amount] + [int.from_bytes(salt[i:i+8], "big") for i in range(0, 32, 8)]
    # Test-only fault injection bypasses the public amount codec deliberately.
    if unsafe_test_override is not None:
        if set(unsafe_test_override) != {"rawAmount"} or type(unsafe_test_override["rawAmount"]) is not int:
            raise ValueError("test override schema")
        values[0] = unsafe_test_override["rawAmount"]
    if remote:
        sockets = connect("C%d" % client_id, port, certificate_dir, timeout,
                          network_profile=network_profile,
                          expected_network_profile_sha256=expected_network_profile_sha256,
                          selection_manifest=manifest, allow_remote_network=allow_remote_network)
    else:
        sockets = connect("C%d" % client_id, port, certificate_dir, timeout)
    try:
        h = bytes.fromhex(public_digest)
        hello = [client_id] + [int.from_bytes(h[i:i+4], "big") for i in range(0, 32, 4)]
        for sock in sockets:
            send(sock, struct.pack("<9q", *hello))
        print("CONNECTED", flush=True)
        triples = active_triples(sockets, 5)
        payload = b"".join(((value + triple[0]) & MASK).to_bytes(16, "little")
                           for value, triple in zip(values, triples))
        for sock in sockets:
            send(sock, payload)
        result = [triple[0] & ((1 << 64) - 1) for triple in
                  active_triples(sockets, 4 if client_id == 0 else 2)]
        for sock in sockets:
            if struct.unpack("<q", receive(sock, 8)) != (1,):
                raise ValueError("missing post-MAC-check completion marker")
        return result
    finally:
        for sock in sockets:
            sock.close()


def main():
    p = argparse.ArgumentParser()
    p.add_argument("--codec-version", type=int, choices=(1, 2), default=1)
    p.add_argument("--expected-manifest-hash")
    p.add_argument("--manifest", type=Path, required=True)
    p.add_argument("--client-id", type=int, required=True)
    p.add_argument("--port", type=int, required=True)
    p.add_argument("--cert-dir", type=Path, required=True)
    p.add_argument("--network-profile", type=Path)
    p.add_argument("--network-profile-sha256")
    p.add_argument("--allow-remote-network", action="store_true")
    args = p.parse_args()
    try:
        if args.codec_version == 2:
            from mpc.v2 import load_manifest
            manifest = load_manifest(args.manifest.read_bytes())
        else:
            manifest = json.loads(args.manifest.read_text())
        profile = None
        if args.network_profile is not None or args.network_profile_sha256 is not None or args.allow_remote_network:
            if args.codec_version != 2 or args.expected_manifest_hash is None or args.network_profile is None:
                raise ValueError("complete server-owned remote configuration required")
            from mpc.network_profile import load_profile, validate_profile
            profile = validate_profile(load_profile(args.network_profile), args.network_profile_sha256,
                                       manifest, allow_remote=args.allow_remote_network)
        secret = json.load(sys.stdin)
        result = run(manifest, args.client_id, args.port,
                     args.cert_dir, secret["amount"], bytes.fromhex(secret["salt"]),
                     unsafe_test_override=secret.get("testOnlyOverride"), codec_version=args.codec_version,
                     expected_manifest_hash=args.expected_manifest_hash, network_profile=profile,
                     expected_network_profile_sha256=args.network_profile_sha256,
                     allow_remote_network=args.allow_remote_network)
        print(json.dumps({"clientId": args.client_id, "output": result}), flush=True)
    except Exception as exc:
        # Avoid printing received data or secrets even on malformed client input.
        print("sealed client failed: " + type(exc).__name__, file=sys.stderr)
        raise SystemExit(1)


if __name__ == "__main__":
    main()
