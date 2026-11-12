"""Synthetic ephemeral identities only. Real OpenSSL signatures and TLS checks."""
from copy import deepcopy
from contextlib import redirect_stdout
import hashlib
import http.client
import io
import json
from pathlib import Path
import shutil
import tempfile
import threading
import time
import unittest

from operators.control import (
    ARTIFACTS, Crypto, Journal, admission, digest, verify_quorum, verify_receipt,
)
from operators.node import Node, health_server, main
from operators.validate_manifest import ManifestError, canonical, load_manifest

ROOT = Path(__file__).resolve().parents[2]


class NodeTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.temp = tempfile.TemporaryDirectory(prefix="veil-node-test-")
        cls.root = Path(cls.temp.name)
        cls.crypto = Crypto(shutil.which("openssl"))
        cls.keys = []
        for i in range(3):
            key = cls.root / ("signer%d.key" % i)
            cls.crypto.run("genpkey", "-algorithm", "ED25519", "-out", key)
            key.chmod(0o600)
            cls.keys.append(key)
        cls.plan = load_manifest(ROOT / "operators/examples/synthetic-v2-plan.json")
        cls.artifacts = {}
        for name in ARTIFACTS:
            path = cls.root / name
            if name == "source_sha256":
                content = (ROOT / "mpc/programs/sealed_procurement_v2.mpc").read_bytes()
            else:
                content = ("synthetic artifact " + name).encode()
            path.write_bytes(content)
            cls.plan["build"][name] = hashlib.sha256(content).hexdigest()
            cls.artifacts[name] = str(path)
        cls.tls = cls.root / "tls"
        cls.tls.mkdir(mode=0o700)
        root_key = cls.root / "root.key"
        root_cert = cls.tls / "trust.pem"
        cls.crypto.run("req", "-x509", "-newkey", "ed25519", "-nodes", "-days", "1",
                       "-keyout", root_key, "-out", root_cert, "-subj", "/CN=TestRoot",
                       "-addext", "basicConstraints=critical,CA:TRUE",
                       "-addext", "keyUsage=critical,keyCertSign,cRLSign")
        def cert_hash(path):
            return hashlib.sha256(cls.crypto.run("x509", "-in", path, "-outform", "DER")).hexdigest()
        cls.plan["trust_anchor_sha256"] = cert_hash(root_cert)
        client_pins = []
        for i, name in enumerate(("P0", "P1", "P2", "C0", "C1", "C2", "C3")):
            key = cls.tls / "P0.key" if name == "P0" else cls.root / (name + ".key")
            cert = cls.tls / (name + ".pem")
            csr = cls.root / (name + ".csr")
            ext = cls.root / "extensions"
            ext.write_text("basicConstraints=critical,CA:FALSE\nkeyUsage=critical,digitalSignature\n"
                           "extendedKeyUsage=serverAuth,clientAuth\nsubjectAltName=DNS:" + name + "\n")
            cls.crypto.run("req", "-new", "-newkey", "ed25519", "-nodes", "-keyout", key,
                           "-out", csr, "-subj", "/CN=" + name)
            key.chmod(0o600)
            cls.crypto.run("x509", "-req", "-in", csr, "-CA", root_cert, "-CAkey", root_key,
                           "-set_serial", str(i + 2), "-days", "1", "-extfile", ext, "-out", cert)
            pin = cert_hash(cert)
            if name.startswith("P"):
                cls.plan["operators"][i]["certificate_sha256"] = pin
            else:
                client_pins.append(pin)
        cls.plan_pin = digest(cls.plan)
        cls.now = int(time.time())
        cls.roster = dict(schema="veil-operator-roster-v1", plan_sha256=cls.plan_pin,
                          epoch=1, not_before=cls.now-100, expires_at=cls.now+1000,
                          members=[dict(party=i, identity=cls.plan["operators"][i]["identity"],
                                        receipt_public_key=cls.crypto.public(cls.keys[i])) for i in range(3)],
                          client_certificate_sha256=client_pins)
        cls.roster_pin = digest(cls.roster)
        (cls.root / "plan.json").write_bytes(canonical(cls.plan))
        (cls.root / "roster.json").write_bytes(canonical(cls.roster))

    @classmethod
    def tearDownClass(cls):
        cls.temp.cleanup()

    def setUp(self):
        self.state_temp = tempfile.TemporaryDirectory(dir=self.root)
        self.state = Path(self.state_temp.name)
        self.journal = Journal(self.state, initialize=True)
        self.config = dict(schema="veil-operator-node-v1", party=0,
                           plan=str(self.root / "plan.json"), plan_sha256=self.plan_pin,
                           roster=str(self.root / "roster.json"), roster_sha256=self.roster_pin,
                           openssl=self.crypto.executable, signing_key=str(self.keys[0]),
                           tls_directory=str(self.tls), state_directory=str(self.state), artifacts=self.artifacts)

    def tearDown(self):
        self.state_temp.cleanup()

    def payload(self, party=0):
        return admission(self.plan, self.plan_pin, self.roster, self.roster_pin, party, self.now)

    def receipt(self, party=0):
        payload = self.payload(party)
        return {"payload": payload, "signature": self.crypto.sign(self.keys[party], payload)}

    def verify(self, receipt, now=None):
        return verify_receipt(receipt, self.plan, self.plan_pin, self.roster, self.roster_pin,
                              self.now if now is None else now, self.crypto)

    def test_real_signature_roundtrip_and_tamper_foreign_job_wrong_signer(self):
        receipt = self.receipt()
        self.assertEqual(self.verify(receipt), receipt["payload"])
        for field, value in (("job_binding_hash", "a"*64), ("selection_round", "b"*64),
                             ("kind", "execution-proven"), ("signer", "foreign-operator"),
                             ("party", True), ("epoch", True)):
            forged = deepcopy(receipt)
            forged["payload"][field] = value
            # Even a real member's new signature cannot authorize another context.
            forged["signature"] = self.crypto.sign(self.keys[0], forged["payload"])
            with self.subTest(field=field), self.assertRaises(ManifestError):
                self.verify(forged)
        receipt["signature"] = self.crypto.sign(self.keys[1], receipt["payload"])
        with self.assertRaises(ManifestError):
            self.verify(receipt)

    def test_expired_receipt_roster_and_future_issue(self):
        with self.assertRaises(ManifestError):
            self.verify(self.receipt(), now=self.now+300)
        for now in (self.now-1, self.roster["expires_at"], self.roster["not_before"]-1):
            with self.assertRaises(ManifestError):
                self.verify(self.receipt(), now=now)

    def test_quorum_requires_three_distinct_configured_signers(self):
        receipts = [self.receipt(i) for i in range(3)]
        binding = verify_quorum(receipts, self.plan, self.plan_pin, self.roster, self.roster_pin, self.now, self.crypto)
        for invalid in (receipts[:2], [receipts[0]]*3):
            with self.assertRaises(ManifestError):
                verify_quorum(invalid, self.plan, self.plan_pin, self.roster, self.roster_pin, self.now, self.crypto)
        self.journal.consume(binding, self.now)
        with self.assertRaisesRegex(ManifestError, "replay"):
            Journal(self.state).consume(binding, self.now)

    def test_durable_issue_replay_and_export(self):
        payload = self.payload()
        receipt = self.journal.issue(payload, lambda p: self.crypto.sign(self.keys[0], p))
        self.verify(receipt)
        reopened = Journal(self.state)
        self.assertEqual(reopened.export(payload["job_binding_hash"], payload["selection_round"], 0), receipt)
        with self.assertRaisesRegex(ManifestError, "replay"):
            reopened.issue(payload, lambda p: self.fail("must not sign twice"))

    def test_crashed_signature_is_burned(self):
        def fail(_payload):
            raise RuntimeError("simulated signing outage")
        with self.assertRaises(RuntimeError):
            self.journal.issue(self.payload(), fail)
        with self.assertRaisesRegex(ManifestError, "replay"):
            Journal(self.state).issue(self.payload(), fail)

    def test_roster_and_clock_rollback_are_durable(self):
        self.journal.check(2, "a"*64, self.now)
        for epoch, pin, now in ((1,"b"*64,self.now), (2,"b"*64,self.now), (3,"c"*64,self.now-1)):
            with self.assertRaises(ManifestError):
                Journal(self.state).check(epoch, pin, now)

    def test_missing_journal_symlink_and_broad_mode_fail_closed(self):
        self.journal.path.unlink()
        with self.assertRaises(OSError):
            Journal(self.state)
        self.journal.path.symlink_to(self.root / "plan.json")
        with self.assertRaises(ManifestError):
            Journal(self.state)
        self.journal.path.unlink()
        self.state.chmod(0o755)
        with self.assertRaises(ManifestError):
            Journal(self.state, initialize=True)

    def test_real_preflight_admit_and_health_truth(self):
        node = Node(self.config)
        status = node.preflight(self.now)
        self.assertTrue(status["control_preflight_passed"])
        self.assertFalse(status["mpc_ready"])
        self.assertFalse(status["deployment_allowed"])
        self.verify(node.admit(self.now))
        self.assertFalse(node.status(self.roster["expires_at"])["control_preflight_passed"])

    def test_real_cli_check_admit_and_export(self):
        config = self.state / "node.json"
        config.write_bytes(canonical(self.config))
        outputs = []
        for command, expected_code in (("check", 3), ("admit", 0), ("export", 0)):
            stream = io.StringIO()
            with redirect_stdout(stream):
                code = main([command, "--config", str(config)])
            self.assertEqual(code, expected_code)
            outputs.append(json.loads(stream.getvalue()))
        self.assertFalse(outputs[0]["mpc_ready"])
        self.assertEqual(outputs[1], outputs[2])
        verify_receipt(outputs[1], self.plan, self.plan_pin, self.roster, self.roster_pin,
                       int(time.time()), self.crypto)

    def test_wrong_artifact_signing_key_and_tls_pin_rejected(self):
        for change in (lambda c: c["artifacts"].update(binary_sha256=str(self.root / "plan.json")),
                       lambda c: c.update(signing_key=str(self.keys[1]))):
            config = deepcopy(self.config)
            change(config)
            with self.assertRaises(ManifestError):
                Node(config).preflight(self.now)
        node = Node(self.config)
        node.plan["operators"][1]["certificate_sha256"] = "a"*64
        with self.assertRaisesRegex(ManifestError, "leaf pin"):
            node._tls_preflight()

    def test_health_is_loopback_read_only_and_never_mpc_ready(self):
        node = Node(self.config)
        node.preflight(int(time.time()))
        server = health_server(node, 0)
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        try:
            for path, status in (("/healthz",200), ("/readyz",503), ("/statusz",200), ("/admit",404)):
                conn = http.client.HTTPConnection("127.0.0.1", server.server_port, timeout=3)
                conn.request("GET", path)
                response = conn.getresponse()
                self.assertEqual(response.status, status)
                self.assertNotIn(b".key", response.read())
                conn.close()
            conn = http.client.HTTPConnection("127.0.0.1", server.server_port, timeout=3)
            conn.request("POST", "/admit", body=b"{}")
            self.assertEqual(conn.getresponse().status, 405)
            conn.close()
        finally:
            server.shutdown()
            server.server_close()
            thread.join(timeout=3)


if __name__ == "__main__":
    unittest.main()
