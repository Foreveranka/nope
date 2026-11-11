#!/usr/bin/env python3
"""Exercise the actual patched MP-SPDZ ssl_socket class, not a Python verifier.

TLS boundary test only. The malicious-CA fixture is intentionally CA:TRUE to
prove exact-leaf enforcement independently of the normal CA:FALSE fixture fix.
"""
import json
import sys
import os
import secrets
import shutil
import socket
import ssl
import subprocess
from pathlib import Path

if not __package__:
    sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from mpc.run_local import (ROOT, VENDOR, OPENSSL, certificates, cleanup, hash_file,
                       run_logged, runtime_identity, wait_line)
from mpc.sealed_client import read_exact


def issue_client(session, mode):
    original = session / "C1/Player-Data"
    if mode in ("correct-cert", "absent-cert"):
        return original, None
    attacker = session / "Attacker/Player-Data"
    attacker.mkdir(parents=True, mode=0o700)
    work = session / "certificates"
    work.mkdir(mode=0o700)
    config = work / "openssl.cnf"
    config.write_text("[req]\ndistinguished_name=dn\nprompt=no\n[dn]\nCN=unused\n"
                      "[leaf]\nbasicConstraints=critical,CA:FALSE\n"
                      "keyUsage=critical,digitalSignature,keyEncipherment\n"
                      "extendedKeyUsage=clientAuth\nsubjectAltName=DNS:C1\n")
    log = session / "attack-setup.log"
    if mode == "wrong-slot":
        for suffix in ("pem", "key"):
            shutil.copyfile(session / ("C0/Player-Data/C0." + suffix), attacker / ("C1." + suffix))
        return attacker, None
    if mode == "untrusted-same-name":
        run_logged([OPENSSL, "req", "-new", "-x509", "-newkey", "rsa:2048", "-nodes",
                    "-config", config, "-subj", "/CN=C1", "-days", "1", "-sha256",
                    "-addext", "basicConstraints=critical,CA:FALSE", "-addext", "subjectAltName=DNS:C1",
                    "-keyout", attacker / "C1.key", "-out", attacker / "C1.pem"], session, log)
        return attacker, None
    assert mode == "forged-C1-signed-by-trusted-CA-C0"
    issuer = session / "C0/Player-Data"
    # Deliberately reproduce the legacy root-trust condition ONLY in this test.
    run_logged([OPENSSL, "req", "-new", "-x509", "-key", issuer / "C0.key", "-config", config,
                "-subj", "/CN=C0", "-days", "1", "-sha256", "-out", issuer / "C0.pem",
                "-addext", "basicConstraints=critical,CA:TRUE",
                "-addext", "keyUsage=critical,keyCertSign,cRLSign,digitalSignature"], session, log)
    public_issuer = (issuer / "C0.pem").read_bytes()
    server_trust = session / "P0/Player-Data"
    (server_trust / "C0.pem").write_bytes(public_issuer)
    run_logged([OPENSSL, "rehash", server_trust], session, log)
    run_logged([OPENSSL, "req", "-new", "-newkey", "rsa:2048", "-nodes", "-config", config,
                "-subj", "/CN=C1", "-keyout", attacker / "C1.key", "-out", work / "fake.csr"], session, log)
    run_logged([OPENSSL, "x509", "-req", "-in", work / "fake.csr", "-CA", issuer / "C0.pem",
                "-CAkey", issuer / "C0.key", "-set_serial", "4242", "-days", "1", "-sha256",
                "-extfile", config, "-extensions", "leaf", "-out", attacker / "C1.pem"], session, log)
    proof = subprocess.run([str(OPENSSL), "verify", "-CAfile", str(issuer / "C0.pem"),
                            "-verify_hostname", "C1", str(attacker / "C1.pem")],
                           capture_output=True, text=True, timeout=20)
    if proof.returncode != 0:
        raise AssertionError("forgery precondition failed: chain+hostname must accept")
    if (attacker / "C1.pem").read_bytes() == (original / "C1.pem").read_bytes():
        raise AssertionError("forged leaf must differ from the authorized leaf")
    return attacker, {"chainAndHostnameAccepted": True, "verifyExitCode": 0,
                      "verifyStdout": proof.stdout.strip()}


def compile_server():
    executable = ROOT / ".local/tls-peer-server"
    prefix = ROOT / ".local/prefix"
    run_logged(["/usr/bin/clang++", "-std=c++20", "-O1", "-g0", "-pthread", "-Wall", "-Wextra", "-Werror",
                "-Wno-error=deprecated-literal-operator", "-Wno-error=unused-parameter",
                "-Wno-error=deprecated-declarations", "-DNO_AVX_OT", "-DUSE_GF2N_LONG",
                "-march=armv8.2-a+crypto", "-I" + str(VENDOR), "-I" + str(VENDOR / "deps"),
                "-I" + str(VENDOR / "local/include"), "-I" + str(prefix / "include"),
                "-I/opt/homebrew/opt/gmp/include", "-I/opt/homebrew/opt/openssl@3/include",
                ROOT / "tests/tls_peer_server.cpp", VENDOR / "libSPDZ.so",
                "-L/opt/homebrew/opt/gmp/lib", "-L/opt/homebrew/opt/openssl@3/lib", "-L" + str(prefix / "lib"),
                "-lgmpxx", "-lgmp", "-lssl", "-lcrypto", "-lsodium", "-lboost_filesystem", "-lboost_iostreams",
                "-o", executable], ROOT, ROOT / ".local/logs/tls-peer-server-build.log")
    return executable


def test_case(executable, mode, port):
    session = ROOT / "runtime" / ("tls-" + mode + "-" + secrets.token_hex(5))
    session.mkdir(mode=0o700)
    processes, logs, peers = [], [], []
    try:
        certificates(session)
        # Check real production-style fixture certificate extensions.
        parsed = subprocess.check_output([str(OPENSSL), "x509", "-in", str(session / "C0/Player-Data/C0.pem"),
                                          "-noout", "-text"], text=True)
        if "CA:FALSE" not in parsed or "Certificate Sign" in parsed:
            raise AssertionError("normal fixture must not be a CA")
        client_dir, precondition = issue_client(session, mode)
        log = (session / "server.log").open("wb")
        logs.append(log)
        server = subprocess.Popen([str(executable), str(port)], cwd=session / "P0",
                                  stdout=subprocess.PIPE, stderr=log, text=True,
                                  env=dict(os.environ, DYLD_LIBRARY_PATH=str(VENDOR)))
        processes.append(server)
        if wait_line(server, 20) != "READY":
            raise AssertionError("native TLS class test failed to start")
        ctx = ssl.SSLContext(ssl.PROTOCOL_TLS_CLIENT)
        ctx.minimum_version = ssl.TLSVersion.TLSv1_2
        ctx.load_verify_locations(cafile=str(session / "C1/Player-Data/trust.pem"))
        if mode != "absent-cert":
            ctx.load_cert_chain(str(client_dir / "C1.pem"), str(client_dir / "C1.key"))
        accepted = False
        rejection = None
        try:
            raw = socket.create_connection(("127.0.0.1", port), timeout=10)
            peers.append(raw)
            secure = ctx.wrap_socket(raw, server_hostname="P0")
            peers.append(secure)
            accepted = read_exact(secure, 8) == b"ACCEPTED"
        except (ssl.SSLError, EOFError, ConnectionError) as error:
            rejection = str(error)
        code = server.wait(timeout=20)
        expected = mode == "correct-cert"
        if accepted != expected or (code != 0 if expected else code not in (1, 3)):
            raise AssertionError("unexpected native TLS acceptance/exit code for " + mode +
                                 ": accepted=" + str(accepted) + ", code=" + str(code) + ", error=" + str(rejection))
        log.flush()
        if not expected and "handshake with C1 failed" not in (session / "server.log").read_text():
            raise AssertionError("missing actual native TLS rejection evidence")
        result = {"case": mode, "accepted": accepted, "nativeExitCode": code,
                  "session": str(session), "normalFixtureCAFalse": True,
                  "forgeryPrecondition": precondition, "runtimeIdentity": runtime_identity()}
    finally:
        for peer in peers:
            peer.close()
        public = session / "diagnostic-public"
        public.mkdir(exist_ok=True)
        for who in ("P0", "C1"):
            for cert in (session / who / "Player-Data").glob("*.pem"):
                shutil.copyfile(cert, public / (who + "-" + cert.name))
        cleanup(processes, logs, session)
    if list(session.rglob("*.key")) or list(session.glob("*/Player-Data")):
        raise AssertionError("TLS test fixture keys not erased")
    result["fixtureKeysRemoved"] = True
    return result


def main():
    executable = compile_server()
    modes = ["correct-cert", "wrong-slot", "absent-cert", "untrusted-same-name",
             "forged-C1-signed-by-trusted-CA-C0"]
    results = []
    for i, mode in enumerate(modes):
        result = test_case(executable, mode, 16600 + i)
        results.append(result)
        print(json.dumps(result), flush=True)
    (ROOT / "evidence/tls-results.json").write_text(json.dumps({
        "actualNativeClass": "MP-SPDZ Networking/ssl_sockets.h ssl_socket",
        "headerSha256": hash_file(VENDOR / "Networking/ssl_sockets.h"),
        "testExecutableSha256": hash_file(executable), "results": results}, indent=2) + "\n")


if __name__ == "__main__":
    main()
