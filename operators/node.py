"""Host-local operator control service. Remote MPC launch is deliberately blocked."""

import argparse
import hashlib
import json
from http.server import BaseHTTPRequestHandler, HTTPServer
from pathlib import Path
import sqlite3
import sys
import time

from .control import (
    ARTIFACTS, Crypto, Journal, admission, context, file_digest, private_file,
    validate_roster, verify_quorum, verify_receipt,
)
from .validate_manifest import (
    ManifestError, _int, _object, _require, canonical, load_manifest,
)


def load_config(path):
    config = load_manifest(path)
    _object(config, ("schema", "party", "plan", "plan_sha256", "roster", "roster_sha256",
                     "openssl", "signing_key", "tls_directory", "state_directory",
                     "artifacts"), "node config")
    _require(config["schema"] == "veil-operator-node-v1", "node config: unsupported schema")
    _int(config["party"], 0, 2, "node config party")
    for key in ("plan", "roster", "openssl", "signing_key", "tls_directory", "state_directory"):
        _require(type(config[key]) is str and Path(config[key]).is_absolute(),
                 "node config: absolute paths required")
    _object(config["artifacts"], ARTIFACTS, "node artifacts")
    for path in config["artifacts"].values():
        _require(type(path) is str and Path(path).is_absolute(), "artifact: absolute path required")
    return config


class Node:
    def __init__(self, config):
        # Own immutable public copies. No secrets are read from the plan or roster.
        self.config = json.loads(canonical(config))
        self.plan = load_manifest(config["plan"])
        self.roster = load_manifest(config["roster"])
        self.crypto = Crypto(config["openssl"])
        self.journal = Journal(config["state_directory"])
        self.checked_at = None

    def validate(self, now):
        c = self.config
        validate_roster(self.roster, c["roster_sha256"], self.plan, c["plan_sha256"], now)

    def preflight(self, now):
        self.checked_at = None
        self.validate(now)
        c, party = self.config, self.config["party"]
        public = self.crypto.public(c["signing_key"])
        _require(public == self.roster["members"][party]["receipt_public_key"],
                 "identity: local signing key differs from roster")
        for key in ARTIFACTS:
            _require(file_digest(c["artifacts"][key]) == self.plan["build"][key],
                     "artifact: approved digest mismatch")
        self._tls_preflight()
        self.journal.check(self.roster["epoch"], c["roster_sha256"], now)
        self.checked_at = now
        return self.status(now)

    def _tls_preflight(self):
        c = self.config
        directory = Path(c["tls_directory"])
        own_name = "P%d" % c["party"]
        root = directory / "trust.pem"
        der = self.crypto.run("x509", "-in", root, "-outform", "DER")
        _require(hashlib.sha256(der).hexdigest() == self.plan["trust_anchor_sha256"],
                 "TLS: root pin mismatch")
        pins = [op["certificate_sha256"] for op in self.plan["operators"]]
        identities = list(zip(("P0", "P1", "P2"), pins)) + list(zip(
            ("C0", "C1", "C2", "C3"), self.roster["client_certificate_sha256"]))
        for name, pin in identities:
            cert = directory / (name + ".pem")
            der = self.crypto.run("x509", "-in", cert, "-outform", "DER")
            _require(hashlib.sha256(der).hexdigest() == pin, "TLS: leaf pin mismatch")
            constraints = self.crypto.run("x509", "-in", cert, "-noout", "-ext", "basicConstraints")
            _require(b"CA:FALSE" in constraints, "TLS: leaf must not be a CA")
            # Verify both native TLS roles, normal chain/time/hostname checks and
            # exclusively the pinned trust file. Offline: no OCSP/CRL retrieval.
            for purpose in ("sslserver", "sslclient"):
                self.crypto.run("verify", "-CAfile", root, "-no-CApath", "-no-CAstore",
                                "-purpose", purpose, "-verify_hostname", name, cert)
        own_key = directory / (own_name + ".key")
        private_file(own_key)
        _require({p.name for p in directory.glob("*.key")} == {own_key.name},
                 "TLS: foreign private keys present")
        key_public = self.crypto.run("pkey", "-in", own_key, "-pubout", "-outform", "DER")
        pem_public = self.crypto.run("x509", "-in", directory / (own_name + ".pem"),
                                     "-pubkey", "-noout")
        cert_public = self.crypto.run("pkey", "-pubin", "-outform", "DER", data=pem_public)
        _require(key_public == cert_public, "TLS: local private key differs from leaf")

    def status(self, now):
        active = True
        try:
            self.validate(now)
        except (ManifestError, OSError, ValueError):
            active = False
        return {
            "alive": True, "control_preflight_passed": self.checked_at is not None and active,
            "artifacts_checked_at": self.checked_at, "roster_active": active,
            "mpc_ready": False, "deployment_allowed": False,
            "independent_operation_verified": False, "execution_proof": False,
            "blocker": "mpc-transport-loopback-only",
        }

    def admit(self, now):
        self.preflight(now)  # Never sign based only on a cached health snapshot.
        c = self.config
        payload = admission(self.plan, c["plan_sha256"], self.roster,
                            c["roster_sha256"], c["party"], now)

        def sign(value):
            signature = self.crypto.sign(c["signing_key"], value)
            # Wrong/replaced keys must not create a completed journal entry.
            verify_receipt({"payload": value, "signature": signature}, self.plan,
                           c["plan_sha256"], self.roster, c["roster_sha256"], now, self.crypto)
            return signature

        return self.journal.issue(payload, sign)

    def export(self):
        c = self.config
        binding = context(self.plan, c["plan_sha256"], self.roster, c["roster_sha256"])
        return self.journal.export(binding["job_binding_hash"], binding["selection_round"], c["party"])


def health_server(node, port):
    """Read-only, loopback-only health. No network admission or signing endpoint."""
    _int(port, 0, 65535, "health port")

    class Handler(BaseHTTPRequestHandler):
        def setup(self):
            super().setup()
            self.connection.settimeout(3)

        def do_GET(self):
            if self.headers.get("Host") != "127.0.0.1:%d" % self.server.server_port:
                self.reply(403, {"error": "invalid host"})
            elif self.path == "/healthz":
                self.reply(200, {"alive": True})
            elif self.path in ("/readyz", "/statusz"):
                self.reply(503 if self.path == "/readyz" else 200, node.status(int(time.time())))
            else:
                self.reply(404, {"error": "not found"})

        def do_POST(self):
            self.reply(405, {"error": "read only"})

        def reply(self, code, value):
            body = canonical(value)
            self.send_response(code)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(body)))
            self.send_header("Cache-Control", "no-store")
            self.end_headers()
            self.wfile.write(body)

        def log_message(self, *_args):
            pass  # No user-controlled URL/header text in logs.

    return HTTPServer(("127.0.0.1", port), Handler)


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    commands = parser.add_subparsers(dest="command", required=True)
    initialize = commands.add_parser("init-state", help="explicit one-time journal initialization")
    initialize.add_argument("--state-directory", required=True)
    for name in ("check", "admit", "export", "serve"):
        command = commands.add_parser(name)
        command.add_argument("--config", required=True)
        if name == "serve":
            command.add_argument("--health-port", type=int, default=9080)
    verify = commands.add_parser("verify", help="verify and consume a 3/3 admission bundle once")
    for name in ("plan", "plan-sha256", "roster", "roster-sha256", "openssl", "state-directory", "receipts"):
        verify.add_argument("--" + name, required=True)
    args = parser.parse_args(argv)
    try:
        now = int(time.time())
        if args.command == "init-state":
            Journal(args.state_directory, initialize=True)
            result, code = {"journal_initialized": True}, 0
        elif args.command == "verify":
            binding = verify_quorum(load_manifest(args.receipts), load_manifest(args.plan), args.plan_sha256,
                                    load_manifest(args.roster), args.roster_sha256, now, Crypto(args.openssl))
            Journal(args.state_directory).consume(binding, now)
            result, code = dict(binding, admission_quorum_verified=True, execution_proof=False,
                                deployment_allowed=False), 0
        else:
            node = Node(load_config(args.config))
            if args.command == "admit":
                result, code = node.admit(now), 0
            elif args.command == "export":
                result, code = node.export(), 0
            else:
                result, code = node.preflight(now), 3
                if args.command == "serve":
                    server = health_server(node, args.health_port)
                    print(json.dumps(result, sort_keys=True), flush=True)
                    try:
                        server.serve_forever(poll_interval=0.5)
                    finally:
                        server.server_close()
        print(json.dumps(result, sort_keys=True))
        return code
    except (ManifestError, OSError, ValueError, sqlite3.Error):
        # Never echo paths, key bytes, supplied fields, OpenSSL stderr or receipts.
        print(json.dumps({"error": "Operator validation or journal operation rejected.",
                          "deployment_allowed": False}), file=sys.stderr)
        return 2
    except KeyboardInterrupt:
        return 0


if __name__ == "__main__":
    sys.exit(main())
