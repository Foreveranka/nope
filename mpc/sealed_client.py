"""Strict, loopback-only implementation of the pinned ExternalIO ring wire API.

Unlike upstream's example Python client, requires TLS peer verification, fixed
active triple frames, bounded complete reads, and a post-CHECK finish marker.
Secrets enter on stdin, never argv. Only for the local synthetic test harness.
"""
import argparse
import json
import socket
import ssl
import struct
import sys
import time
from pathlib import Path

if not __package__:
    sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from mpc.auction import MAX_AMOUNT, digest, integer, validate_manifest

MASK = (1 << 128) - 1


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


def connect(identity, port, certificate_dir, timeout):
    ctx = ssl.SSLContext(ssl.PROTOCOL_TLS_CLIENT)
    ctx.minimum_version = ssl.TLSVersion.TLSv1_2
    ctx.check_hostname = True
    ctx.verify_mode = ssl.CERT_REQUIRED
    ctx.load_cert_chain(str(certificate_dir / (identity + ".pem")),
                        str(certificate_dir / (identity + ".key")))
    # Each expected certificate is additionally pinned below.
    ctx.load_verify_locations(cafile=str(certificate_dir / "trust.pem"))
    sockets = []
    deadline = time.monotonic() + timeout
    try:
        for party in range(3):
            while True:
                try:
                    raw = socket.create_connection(("127.0.0.1", port + party), timeout=2)
                    break
                except (ConnectionRefusedError, TimeoutError):
                    if time.monotonic() >= deadline:
                        raise TimeoutError("MPC party connection timeout") from None
                    time.sleep(0.1)
            raw.settimeout(timeout)
            send(raw, identity[1:].encode("ascii"))
            sock = ctx.wrap_socket(raw, server_hostname="P%d" % party)
            expected = ssl.PEM_cert_to_DER_cert((certificate_dir / ("P%d.pem" % party)).read_text())
            if sock.getpeercert(binary_form=True) != expected:
                raise ValueError("MPC party certificate mismatch")
            sockets.append(sock)
        specs = [receive(s, 12) for s in sockets]
        if any(s != specs[0] for s in specs) or struct.unpack("<iii", specs[0]) != (ord("R"), 128, 64):
            raise ValueError("expected identical SPDZ2k 64+64 domain")
        return sockets
    except BaseException:
        for sock in sockets:
            sock.close()
        raise


def run(manifest, client_id, port, certificate_dir, amount, salt, timeout=600,
        unsafe_test_override=None, codec_version=1, expected_manifest_hash=None):
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
    values = [amount] + [int.from_bytes(salt[i:i+8], "big") for i in range(0, 32, 8)]
    # Test-only fault injection bypasses the public amount codec deliberately.
    if unsafe_test_override is not None:
        if set(unsafe_test_override) != {"rawAmount"} or type(unsafe_test_override["rawAmount"]) is not int:
            raise ValueError("test override schema")
        values[0] = unsafe_test_override["rawAmount"]
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
    args = p.parse_args()
    try:
        secret = json.load(sys.stdin)
        if args.codec_version == 2:
            from mpc.v2 import load_manifest
            manifest = load_manifest(args.manifest.read_bytes())
        else:
            manifest = json.loads(args.manifest.read_text())
        result = run(manifest, args.client_id, args.port,
                     args.cert_dir, secret["amount"], bytes.fromhex(secret["salt"]),
                     unsafe_test_override=secret.get("testOnlyOverride"), codec_version=args.codec_version,
                     expected_manifest_hash=args.expected_manifest_hash)
        print(json.dumps({"clientId": args.client_id, "output": result}), flush=True)
    except Exception as exc:
        # Avoid printing received data or secrets even on malformed client input.
        print("sealed client failed: " + type(exc).__name__, file=sys.stderr)
        raise SystemExit(1)


if __name__ == "__main__":
    main()
