"""Synthetic test data and real stdlib SHA-256/HMAC computation, not attestation."""
import hashlib
import hmac
import json
from payments.interface import Binding, Delivery, Money
from payments.model import binding_hash, canonical

SYNTHETIC_KEY = b"public-synthetic-test-key-not-a-real-credential"
ARTIFACT = b"synthetic encrypted-output placeholder; NOT actual FHE ciphertext"


def make_binding():
    return Binding("a" * 64, "attempt-1", "synthetic-job-1", "synthetic-bid-1",
                   "synthetic-assignment-1", "synthetic-worker-1", "b" * 64,
                   "c" * 64, Money(80000000))


def package(binding, version=1, artifact=ARTIFACT):
    body = {"binding_hash": binding_hash(binding), "version": version,
            "artifact_sha256": hashlib.sha256(artifact).hexdigest(),
            "policy": "synthetic-copy-v1", "verified": True}
    envelope = {"body": body, "mac": hmac.new(SYNTHETIC_KEY, canonical(body).encode(), hashlib.sha256).hexdigest()}
    receipt = canonical(envelope).encode()
    return Delivery(version, body["artifact_sha256"], hashlib.sha256(receipt).hexdigest()), artifact, receipt


class SyntheticVerifier:
    """Local trusted test policy; this HMAC is NOT a NEAR/TEE proof."""
    def verify(self, binding, delivery, artifact, receipt):
        envelope = json.loads(receipt)
        body = envelope["body"]
        expected = hmac.new(SYNTHETIC_KEY, canonical(body).encode(), hashlib.sha256).hexdigest()
        return (hmac.compare_digest(envelope["mac"], expected)
                and body == {"binding_hash": binding_hash(binding), "version": delivery.version,
                             "artifact_sha256": delivery.artifact_sha256,
                             "policy": "synthetic-copy-v1", "verified": True}
                and artifact == ARTIFACT)
