#!/usr/bin/env python3
"""Local SYNTHETIC integration harness, not a procurement coordinator.

Knows the fixture inputs and launches all operators/clients under one UID.
Never connect this harness to real bids. Result accepted only after all seven
processes exit successfully and each client verifies its private output.
"""
import argparse
import hashlib
import json
import os
import secrets
import selectors
import shutil
import subprocess
import sys
import time
from pathlib import Path

if not __package__:
    sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from mpc.auction import (PROFILE, UPSTREAM, MAX_AMOUNT, canonical, commitment, integer,
                     digest, reference, validate_manifest)

ROOT = Path(__file__).resolve().parent
VENDOR = ROOT / "vendor/MP-SPDZ"
OPENSSL = Path("/opt/homebrew/opt/openssl@3/bin/openssl")
CASES = {
    "cheapest": (100, [90, 80, 95], [True, True, True], 0),
    "tie": (100, [80, 80, 90], [True, True, True], 0),
    "no-award": (50, [90, 80, 95], [True, True, True], 0),
    "exact-budget": (88, [90, 80, 95], [True, True, True], 8),
    "unqualified": (100, [1, 80, 95], [False, True, True], 0),
    "all-unqualified": (MAX_AMOUNT, [1, 2, 3], [False, False, False], 0),
    "max": (MAX_AMOUNT, [MAX_AMOUNT, MAX_AMOUNT, MAX_AMOUNT], [True, True, True], 0),
    "zero-budget": (0, [1, 2, 3], [True, True, True], 0),
    "wrong-commitment": (100, [90, 80, 95], [True, True, True], 0),
    "negative-ring-input": (100, [90, 80, 95], [True, True, True], 0),
    "overflow-ring-input": (100, [90, 80, 95], [True, True, True], 0),
}


def hash_file(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def runtime_identity():
    stamp = json.loads((ROOT / ".local/build-stamp.json").read_text())
    return {k: stamp[k] for k in ("upstream", "binarySha256", "sharedLibrarySha256",
                                 "configSha256", "transportPatchSha256")}


def run_logged(command, cwd, log, env=None, timeout=600):
    with log.open("ab") as out:
        subprocess.run([str(x) for x in command], cwd=cwd, stdout=out,
                       stderr=subprocess.STDOUT, check=True, timeout=timeout, env=env)


def _create_certificates(session):
    """Each process directory contains ONLY its own private identity key."""
    generation = session / "certificates"
    generation.mkdir(mode=0o700)
    # Ignore global openssl.cnf, which can default req -x509 to CA:TRUE.
    config = generation / "openssl.cnf"
    config.write_text("[req]\ndistinguished_name=dn\nprompt=no\n[dn]\nCN=unused\n")
    root_cert, root_key = generation / "FixtureRoot.pem", generation / "FixtureRoot.key"
    run_logged([OPENSSL, "req", "-newkey", "rsa:2048", "-nodes", "-x509", "-config", config,
                "-sha256", "-days", "1", "-subj", "/CN=VeilFixture-" + secrets.token_hex(12),
                "-addext", "basicConstraints=critical,CA:TRUE",
                "-addext", "keyUsage=critical,keyCertSign,cRLSign",
                "-addext", "subjectKeyIdentifier=hash", "-out", root_cert, "-keyout", root_key],
               session, session / "certificates.log", timeout=30)
    root_key.chmod(0o600)
    identities = ["P%d" % i for i in range(3)] + ["C%d" % i for i in range(4)]
    for serial, identity in enumerate(identities, 1):
        run_logged([OPENSSL, "req", "-newkey", "rsa:2048", "-nodes", "-new",
                    "-config", config, "-sha256", "-subj", "/CN=" + identity,
                    "-out", generation / (identity + ".csr"),
                    "-keyout", generation / (identity + ".key")],
                   session, session / "certificates.log", timeout=30)
        extensions = generation / (identity + ".cnf")
        extensions.write_text("[leaf]\nbasicConstraints=critical,CA:FALSE\n"
                              "keyUsage=critical,digitalSignature,keyEncipherment\n"
                              "extendedKeyUsage=serverAuth,clientAuth\nsubjectKeyIdentifier=hash\n"
                              "authorityKeyIdentifier=keyid,issuer\nsubjectAltName=DNS:" + identity + "\n")
        run_logged([OPENSSL, "x509", "-req", "-in", generation / (identity + ".csr"),
                    "-CA", root_cert, "-CAkey", root_key, "-set_serial", str(serial),
                    "-sha256", "-days", "1", "-extfile", extensions, "-extensions", "leaf",
                    "-out", generation / (identity + ".pem")], session, session / "certificates.log", timeout=30)
        (generation / (identity + ".key")).chmod(0o600)
    for identity in identities:
        directory = session / identity / "Player-Data"
        directory.mkdir(parents=True, mode=0o700)
        for peer in identities:
            shutil.copyfile(generation / (peer + ".pem"), directory / (peer + ".pem"))
        shutil.copyfile(root_cert, directory / "FixtureRoot.pem")
        shutil.move(str(generation / (identity + ".key")), str(directory / (identity + ".key")))
        (directory / "trust.pem").write_bytes(root_cert.read_bytes())
        run_logged([OPENSSL, "rehash", directory], session,
                   session / "certificates.log", timeout=30)
    shutil.rmtree(generation)  # includes the only CA private key, before launch


def certificates(session):
    try:
        _create_certificates(session)
    except BaseException:
        cleanup([], [], session)
        raise


def wait_line(process, timeout):
    selector = selectors.DefaultSelector()
    selector.register(process.stdout, selectors.EVENT_READ)
    try:
        if not selector.select(timeout):
            raise TimeoutError("client connection timed out")
        return process.stdout.readline().strip()
    finally:
        selector.close()


def cleanup(processes, logs, session):
    """Reap only Popen-owned children; always remove transient fixture keys."""
    unreaped = []
    try:
        for p in processes:
            try:
                p.wait(timeout=0.2)  # allow an already-aborting VM to exit
                continue
            except subprocess.TimeoutExpired:
                pass
            try:
                p.terminate()
            except (PermissionError, ProcessLookupError):
                # macOS can briefly deny signals while a crashed process exits.
                pass
            try:
                p.wait(timeout=5)
                continue
            except subprocess.TimeoutExpired:
                pass
            try:
                p.kill()
            except (PermissionError, ProcessLookupError):
                pass
            try:
                p.wait(timeout=5)
            except subprocess.TimeoutExpired:
                unreaped.append(p.pid)
    finally:
        for log in logs:
            log.close()
        for directory in session.glob("*/Player-Data"):
            shutil.rmtree(directory)
        if (session / "certificates").exists():
            shutil.rmtree(session / "certificates")
    if unreaped:
        raise RuntimeError("cleanup could not reap owned child processes: " + str(unreaped))


def run_case(case, timeout=600, port=15400):
    budget, prices, qualified, fee = CASES[case]
    # Explicitly retain v1 commitment and descriptor semantics.
    descriptor = {"profile": PROFILE, "upstream": UPSTREAM,
                  # Synthetic hashes. Future adapter MUST use registry binding hashes.
                  "job": digest({"syntheticJob": case}),
                  "attempt": digest({"syntheticAttempt": case + "-" + secrets.token_hex(6)}),
                  "qualified": qualified, "fixedFee": fee}
    salts = [secrets.token_bytes(32) for _ in range(4)]
    amounts = [budget] + prices
    manifest = {"descriptor": descriptor, "commitments": [
        commitment(descriptor, i, a, s) for i, (a, s) in enumerate(zip(amounts, salts))]}
    if case == "wrong-commitment":
        manifest["commitments"][2] = "00" * 32
    validate_manifest(manifest)
    return execute_fixture(manifest, amounts, salts, case=case, timeout=timeout, port=port)


def execute_fixture(manifest, amounts, salts, *, case, timeout=600, port=15400, codec_version=1,
                    test_client_manifests=None):
    """Centralized local SYNTHETIC runtime; all inputs known to this harness."""
    integer(codec_version, 1, 2, "codec version")
    integer(port, 1024, 65432, "port")
    integer(timeout, 1, 3600, "timeout")
    if codec_version == 2:
        from mpc.v2 import validate_manifest as validate_v2, manifest_digest, program_hash
        validate_v2(manifest)
        if manifest["mpcBuild"]["circuitSourceHash"] != program_hash():
            raise ValueError("unapproved v2 circuit")
        public_digest = manifest_digest(manifest)
        descriptor = manifest["intent"]
        source = ROOT / "programs/sealed_procurement_v2.mpc"
    elif codec_version == 1:
        validate_manifest(manifest)
        public_digest = digest(manifest)
        descriptor = manifest["descriptor"]
        source = ROOT / "programs/sealed_procurement.mpc"
    else:
        raise ValueError("unsupported codec version")
    budget, prices = amounts[0], list(amounts[1:])
    qualified, fee = descriptor["qualified"], descriptor["fixedFee"]
    if not (VENDOR / "spdz2k-party.x").is_file():
        raise RuntimeError("native runtime absent: run mpc/bootstrap.py first")
    if subprocess.check_output(["git", "rev-parse", "HEAD"], cwd=VENDOR, text=True).strip() != UPSTREAM:
        raise RuntimeError("incorrect upstream pin")
    config = (VENDOR / "CONFIG.mine").read_text()
    if "INSECURE" in config or "USE_KOS = 0" not in config:
        raise RuntimeError("unsupported native build configuration")
    stamp_path = ROOT / ".local/build-stamp.json"
    if not stamp_path.exists():
        raise RuntimeError("verified native build stamp absent: run mpc/bootstrap.py")
    stamp = json.loads(stamp_path.read_text())
    if (stamp["upstream"] != UPSTREAM or stamp["insecureFlags"] is not False or
            stamp["binarySha256"] != hash_file(VENDOR / "spdz2k-party.x") or
            stamp["sharedLibrarySha256"] != hash_file(VENDOR / "libSPDZ.so") or
            stamp["configSha256"] != hash_file(VENDOR / "CONFIG.mine") or
            stamp["transportPatchSha256"] != hash_file(ROOT / "patches/local-transport.patch")):
        raise RuntimeError("native build identity mismatch")
    runtime = ROOT / "runtime"
    runtime.mkdir(exist_ok=True, mode=0o700)
    session = runtime / (case + "-" + secrets.token_hex(6))
    session.mkdir(mode=0o700)
    manifest_path = session / "manifest.json"
    manifest_path.write_bytes(canonical(manifest))
    name = "sealed_v%d_" % codec_version + public_digest[:16]
    start = time.monotonic()
    run_logged([sys.executable, "compile.py", "-R", "64", "-X", "-o", name,
                source, manifest_path, str(port)], VENDOR, session / "compiler.log", timeout=timeout)
    # Upstream -o PREFIX prefixes its argument-derived name; it doesn't replace it.
    schedules = list((VENDOR / "Programs/Schedules").glob(name + "-*.sch"))
    if len(schedules) != 1:
        raise RuntimeError("ambiguous compiled schedule")
    name = schedules[0].stem
    compile_seconds = time.monotonic() - start
    processes, logs = [], []
    try:
        certificates(session)
        start = time.monotonic()
        native_env = dict(os.environ, DYLD_LIBRARY_PATH=str(VENDOR))
        for i in range(3):
            cwd = session / ("P%d" % i)
            (cwd / "Programs").symlink_to(VENDOR / "Programs", target_is_directory=True)
            log = (session / ("party%d.log" % i)).open("wb")
            logs.append(log)
            # No -F/-f, -u, -I, INSECURE, Fake-Offline, or semi-honest option.
            command = [VENDOR / "spdz2k-party.x", "-N", "3", "-p", str(i),
                       "-h", "127.0.0.1", "-pn", str(port + 100),
                       "-SP", "64", "-S", "40", "-b", "1024", "-OF", ".", name]
            processes.append(subprocess.Popen([str(x) for x in command], cwd=cwd,
                                               stdout=log, stderr=subprocess.STDOUT,
                                               env=native_env,
                                               start_new_session=True))
        clients = []
        for i in range(4):
            error = (session / ("client%d.log" % i)).open("wb")
            logs.append(error)
            client_manifest_path = manifest_path
            if test_client_manifests and i in test_client_manifests:
                client_manifest_path = session / ("test-client%d-manifest.json" % i)
                client_manifest_path.write_bytes(canonical(test_client_manifests[i]))
            p = subprocess.Popen([sys.executable, ROOT / "sealed_client.py", "--codec-version", str(codec_version),
                                  "--manifest", client_manifest_path,
                                  "--client-id", str(i), "--port", str(port), "--cert-dir",
                                  session / ("C%d" % i) / "Player-Data"],
                                 stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=error,
                                 text=True, start_new_session=True)
            processes.append(p)
            clients.append(p)
            data = {"amount": amounts[i], "salt": salts[i].hex()}
            if i == 2 and case in ("negative-ring-input", "overflow-ring-input"):
                data["testOnlyOverride"] = {"rawAmount": -1 if case.startswith("negative") else (1 << 40) + 80}
            p.stdin.write(json.dumps(data))
            p.stdin.close()
            if wait_line(p, min(timeout, 60)) != "CONNECTED":
                raise RuntimeError("client failed during authenticated connection")
        outputs = []
        deadline = time.monotonic() + timeout
        for i, p in enumerate(clients):
            line = wait_line(p, max(0.1, deadline - time.monotonic()))
            if not line:
                raise RuntimeError("private output rejected or computation aborted")
            value = json.loads(line)
            if value["clientId"] != i:
                raise RuntimeError("wrong output recipient")
            outputs.append(value["output"])
        for p in processes:
            if p.wait(timeout=max(0.1, deadline - time.monotonic())) != 0:
                raise RuntimeError("MPC process did not exit successfully")
        expected = reference(budget, prices, qualified, fee)
        actual = {"buyer": outputs[0], "providers": outputs[1:]}
        if actual != expected:
            raise AssertionError("MPC output differs from synthetic reference")
        return {"case": case, "status": "VERIFIED_LOCAL_MPC", "output": actual,
                "compileSeconds": compile_seconds, "runtimeSeconds": time.monotonic() - start,
                "manifestHash": public_digest, "codecVersion": codec_version, "program": name,
                "circuitSourceHash": hash_file(source), "session": str(session),
                "upstream": UPSTREAM, "independentOperators": False,
                "runtimeIdentity": runtime_identity(), "transportGeneration": "peer-leaf-pin-v1",
                "nearBindingVerified": False}
    finally:
        # Synthetic inputs stay in process memory. Ephemeral identity keys and
        # any live-preprocessing remnants are removed even on abort.
        cleanup(processes, logs, session)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--case", choices=CASES, default="cheapest")
    parser.add_argument("--timeout", type=int, default=600)
    parser.add_argument("--port", type=int, default=15400)
    args = parser.parse_args()
    try:
        result = run_case(args.case, args.timeout, args.port)
        print(json.dumps(result, indent=2))
    except Exception as exc:
        print(json.dumps({"case": args.case, "status": "FAILED_OR_ABORTED",
                          "errorType": type(exc).__name__, "error": str(exc)}))
        raise SystemExit(1)


if __name__ == "__main__":
    main()
