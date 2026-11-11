import hashlib
import json
import unittest

from sdk import BindingError
from sdk.tests import test_receipt as legacy


def encoded(v):
    return json.dumps(v, sort_keys=True, separators=(",", ":")).encode()


class StagedBindingTests(unittest.TestCase):
    build = legacy.ReceiptTests.build
    rebind_json = legacy.ReceiptTests.rebind_json

    def setUp(self):
        legacy.ReceiptTests.setUp(self)
        self.binding = {"job_id": self.job["job_id"], "attempt": self.job["attempt"]}
        self.binding.update({k: bytes(self.job[k]).hex() for k in
                             ("job_binding_hash", "attempt_binding_hash", "bidset_root")})
        self.rebind_external()

    def rebind_external(self):
        blob = encoded(self.binding)
        digest = hashlib.sha256(blob).hexdigest()
        request = json.loads(self.kwargs["request_manifest"])
        request.update(protocolVersion=2, externalBindingSha256=digest)
        self.result["artifactHashes"]["externalBindingSha256"] = digest
        self.kwargs["external_binding"] = blob
        self.rebind_json(request=request)

    def test_staged_context_accepted(self):
        self.assertEqual(self.build()["job_id"], self.job["job_id"])

    def test_no_binding_bytes_rejected(self):
        del self.kwargs["external_binding"]
        with self.assertRaises(BindingError):
            self.build()

    def test_self_consistent_wrong_job_rejected(self):
        self.binding["job_id"] = "2"
        self.rebind_external()
        with self.assertRaisesRegex(BindingError, "identity"):
            self.build()

    def test_self_consistent_wrong_attempt_rejected(self):
        self.binding["attempt_binding_hash"] = "f" * 64
        self.rebind_external()
        with self.assertRaisesRegex(BindingError, "hash"):
            self.build()

    def test_changed_binding_bytes_rejected(self):
        self.kwargs["external_binding"] += b" "
        with self.assertRaises(BindingError):
            self.build()
