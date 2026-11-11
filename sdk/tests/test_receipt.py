import copy
import hashlib
import importlib.util
import json
import socket
import subprocess
import unittest
from pathlib import Path
from unittest import mock

from sdk import BindingError, build_receipt_claim
from sdk.receipt import _claim_hash

ROOT = Path(__file__).resolve().parents[2]
FIXTURES = ROOT / "sdk/fixtures"
REFERENCE_PATH = ROOT / "contracts/registry/scripts/hash_schema.py"
reference_spec = importlib.util.spec_from_file_location("registry_hash_reference", REFERENCE_PATH)
reference = importlib.util.module_from_spec(reference_spec)
reference_spec.loader.exec_module(reference)


def canonical(value):
    return json.dumps(value, sort_keys=True, separators=(",", ":"), allow_nan=False).encode()


class ReceiptTests(unittest.TestCase):
    def setUp(self):
        self.evidence = json.loads((ROOT / "docs/verification/http-fhe-check.json").read_bytes())
        self.lifecycle = json.loads((ROOT / "contracts/registry/examples/lifecycle.json").read_bytes())
        self.request = (FIXTURES / "request.json").read_bytes()
        self.receipt = (FIXTURES / "receipt.json").read_bytes()
        self.job = copy.deepcopy(self.lifecycle["job"])
        # Explicit derived offline fixture, not a fetched or submitted on-chain job.
        self.job.update(state="Executing", closed_at_ns="100", receipts=[])
        hashes = self.evidence["artifactHashes"]
        for source, target in (("serverSha256", "circuit_hash"), ("evaluationKeysSha256", "key_hash"),
                               ("inputSha256", "input_hash")):
            self.job["config"][target] = list(bytes.fromhex(hashes[source]))
        self.job["job_binding_hash"] = reference.job_hash(self.lifecycle["contract_account"],
                                                        self.lifecycle["network_domain_hash"], self.job)
        self.job["bidset_root"] = reference.bidset_root(self.job)
        self.job["attempt_binding_hash"] = reference.attempt_hash(self.job)
        verified_check = next(c for c in self.evidence["checks"] if c["name"] == "reference verification flag true")
        self.result = {"verified": self.evidence["completed"] is True and verified_check["pass"] is True,
                       "metrics": copy.deepcopy(self.evidence["metrics"]),
                       "artifactHashes": copy.deepcopy(hashes)}
        self.policy = {"profile_id": "clean-4-records-v1", "requires_execution_proof": False,
                       "verification_method": "client_plaintext_reference",
                       "spec_hash": self.job["config"]["spec_hash"].copy(),
                       "output_policy_hash": self.job["config"]["output_policy_hash"].copy()}
        self.kwargs = {"request_manifest": self.request, "evaluator_receipt": self.receipt,
                       "expected_registry_attempt": "1", "expected_engine_attempt_id": json.loads(self.request)["attemptId"],
                       "policy": self.policy}

    def build(self):
        return build_receipt_claim(self.job, self.result, **self.kwargs)

    def rebind_json(self, request=None, receipt=None):
        receipt = json.loads(self.kwargs["evaluator_receipt"]) if receipt is None else receipt
        if request is not None:
            self.kwargs["request_manifest"] = canonical(request)
            digest = hashlib.sha256(self.kwargs["request_manifest"]).hexdigest()
            self.result["artifactHashes"]["requestManifestSha256"] = digest
            receipt["request"] = copy.deepcopy(request)
            receipt["requestManifestSha256"] = digest
        self.kwargs["evaluator_receipt"] = canonical(receipt)
        self.result["artifactHashes"]["receiptSha256"] = hashlib.sha256(self.kwargs["evaluator_receipt"]).hexdigest()

    def test_actual_http_evidence_metadata_hashes(self):
        self.assertTrue(self.evidence["completed"])
        self.assertTrue(all(c["pass"] for c in self.evidence["checks"]))
        self.assertTrue(self.result["metrics"]["real_fhe"])
        self.assertEqual(hashlib.sha256(self.request).hexdigest(), self.result["artifactHashes"]["requestManifestSha256"])
        self.assertEqual(hashlib.sha256(self.receipt).hexdigest(), self.result["artifactHashes"]["receiptSha256"])

    def test_registry_lifecycle_receipt_hash_vector(self):
        claim = next(call["args"]["claim"] for call in self.lifecycle["calls"] if call["method"] == "report_result")
        self.assertEqual(list(_claim_hash(claim)), self.lifecycle["receipt_hash"])
        self.assertEqual(_claim_hash(claim).hex(), "dd357485ab05554fe289c7aca1a6725255be5a91dd42be15eccf4748ef652292")

    def test_saved_sandbox_accepted_state_rejected(self):
        sandbox = json.loads((ROOT / "contracts/registry/verification/sandbox-fhe-binding.json").read_bytes())
        self.assertIs(sandbox["external_chain"], False)
        self.assertIs(sandbox["execution_proof_verified"], False)
        self.assertIs(sandbox["precommitted_workflow"], False)
        self.assertEqual(sandbox["source_public_artifact_hashes"], self.result["artifactHashes"])
        self.assertEqual(sandbox["source_evidence_sha256"],
                         hashlib.sha256((ROOT / "docs/verification/http-fhe-check.json").read_bytes()).hexdigest())
        with self.assertRaisesRegex(BindingError, "Executing"):
            build_receipt_claim(sandbox["accepted_job"], self.result, **self.kwargs)

    def test_offline_pre_report_reconstruction_matches_saved_sandbox_claim(self):
        sandbox = json.loads((ROOT / "contracts/registry/verification/sandbox-fhe-binding.json").read_bytes())
        # This reconstruction is a test vector, NOT a current authenticated state.
        self.job = copy.deepcopy(sandbox["accepted_job"])
        expected = copy.deepcopy(self.job["receipts"][0]["claim"])
        self.job.update(state="Executing", receipts=[])
        self.policy["spec_hash"] = self.job["config"]["spec_hash"].copy()
        self.policy["output_policy_hash"] = self.job["config"]["output_policy_hash"].copy()
        claim = self.build()
        self.assertEqual(claim, expected)
        self.assertEqual(list(_claim_hash(claim)), sandbox["registry_receipt_hash"])
        self.assertEqual(reference.receipt_hash(claim), sandbox["registry_receipt_hash"])

    def test_claim_matches_registry_interface_and_exact_engine_ciphertext_digest(self):
        expected = copy.deepcopy(next(call["args"]["claim"] for call in self.lifecycle["calls"] if call["method"] == "report_result"))
        for field in ("job_binding_hash", "attempt_binding_hash", "bidset_root"):
            expected[field] = self.job[field].copy()
        expected.update(copy.deepcopy({field: self.job["config"][field] for field in reference.FIELDS}))
        expected["output_hash"] = list(bytes.fromhex(self.result["artifactHashes"]["outputSha256"]))
        claim = self.build()
        self.assertEqual(claim, expected)
        self.assertEqual(json.loads(json.dumps(claim)), claim)
        self.assertEqual(reference.receipt_hash(claim), reference.receipt_hash(expected))
        self.assertNotIn("records", claim)
        self.assertNotIn("attemptId", claim)

    def test_inputs_immutable_and_return_has_no_aliases(self):
        original = copy.deepcopy((self.job, self.result, self.kwargs))
        claim = self.build()
        claim["spec_hash"][0] ^= 1
        claim["job_binding_hash"][0] ^= 1
        self.assertEqual((self.job, self.result, self.kwargs), original)

    def test_no_records_access_network_process_or_file_io(self):
        class UntouchableRecords:
            def __deepcopy__(self, memo):
                raise AssertionError("plaintext copied")
            def __iter__(self):
                raise AssertionError("plaintext inspected")
        self.result["records"] = UntouchableRecords()
        with mock.patch.object(socket, "socket", side_effect=AssertionError("network")), \
             mock.patch.object(subprocess, "Popen", side_effect=AssertionError("subprocess")), \
             mock.patch("builtins.open", side_effect=AssertionError("file IO")):
            self.build()

    def test_opaque_registry_fixture_is_not_silently_rewritten(self):
        original = copy.deepcopy(self.lifecycle["job"])
        original.update(state="Executing", closed_at_ns="100", receipts=[])
        with self.assertRaisesRegex(BindingError, "circuit_hash"):
            build_receipt_claim(original, self.result, **self.kwargs)
        self.assertEqual(original["config"]["circuit_hash"], [2] * 32)

    def test_current_registry_attempt_is_chosen_separately_from_local_hex_id(self):
        self.assertNotEqual(self.kwargs["expected_engine_attempt_id"], self.job["attempt"])
        self.build()
        self.kwargs["expected_registry_attempt"] = "2"
        with self.assertRaisesRegex(BindingError, "not current"):
            self.build()

    def test_local_attempt_mismatch_and_wrong_identity_types(self):
        for value in ("0" * 32, "1", 1, True, None):
            self.kwargs["expected_engine_attempt_id"] = value
            with self.subTest(value=value), self.assertRaises(BindingError):
                self.build()

    def test_states_fail_closed(self):
        for state in ("Open", "Closed", "Reported", "Accepted", "Rejected", "Expired", "Unknown", "EXECUTING", None, {}):
            self.job["state"] = state
            with self.subTest(state=state), self.assertRaises(BindingError):
                self.build()

    def test_circuit_key_and_input_must_equal_registry(self):
        for key in ("circuit_hash", "key_hash", "input_hash"):
            saved = self.job["config"][key].copy()
            self.job["config"][key][0] ^= 1
            with self.subTest(field=key), self.assertRaisesRegex(BindingError, key):
                self.build()
            self.job["config"][key] = saved

    def test_proof_required_unknown_policy_and_policy_hashes_fail_closed(self):
        for value in (True, None, 0, "false"):
            self.policy["requires_execution_proof"] = value
            with self.assertRaisesRegex(BindingError, "Proof-required"):
                self.build()
        self.policy["requires_execution_proof"] = False
        for field in ("spec_hash", "output_policy_hash"):
            self.policy[field][0] ^= 1
            with self.assertRaisesRegex(BindingError, field):
                self.build()
            self.policy[field][0] ^= 1
        for field in ("profile_id", "verification_method"):
            saved = self.policy[field]
            self.policy[field] = "unknown"
            with self.assertRaises(BindingError):
                self.build()
            self.policy[field] = saved

    def test_u64_types_ranges_and_canonical_encoding(self):
        for value in (1, True, "01", "+1", "-1", "1.0", "1e0", "", "18446744073709551616", "0"):
            self.job["job_id"] = value
            with self.subTest(value=value), self.assertRaises(BindingError):
                self.build()

    def test_hash_arrays_reject_bool_float_short_hex_and_all_zero(self):
        for value in ([True] * 32, [1.0] * 32, [256] * 32, [-1] * 32, [1] * 31, "01" * 32, [0] * 32):
            self.job["config"]["context_hash"] = value
            with self.subTest(value=str(type(value))), self.assertRaises(BindingError):
                self.build()

    def test_output_all_zero_rejected_but_zero_bytes_and_leading_zero_allowed(self):
        original_hash = self.result["artifactHashes"]["outputSha256"]
        receipt = json.loads(self.receipt)
        for digest, valid in (("0" * 64, False), ("00" + "11" * 31, True), ("10" + "00" * 31, True)):
            self.result["artifactHashes"]["outputSha256"] = digest
            receipt["outputSha256"] = digest
            self.rebind_json(receipt=receipt)
            if valid:
                self.assertEqual(bytes(self.build()["output_hash"]).hex(), digest)
            else:
                with self.assertRaisesRegex(BindingError, "all zero"):
                    self.build()
        self.assertNotEqual(original_hash, "0" * 64)

    def test_unknown_keys_rejected_in_all_security_envelopes(self):
        values = [self.job, self.job["config"], self.job["bids"][0], self.result,
                  self.result["metrics"], self.result["artifactHashes"], self.policy]
        for value in values:
            value["future_security_setting"] = False
            with self.assertRaisesRegex(BindingError, "unknown fields"):
                self.build()
            del value["future_security_setting"]
        request = json.loads(self.request)
        request["future_security_setting"] = False
        self.rebind_json(request=request)
        with self.assertRaisesRegex(BindingError, "unknown fields"):
            self.build()

    def test_verification_flags_and_runtime_metadata_not_truthy_coerced(self):
        for value in (False, 1, "true", None):
            self.result["verified"] = value
            with self.assertRaises(BindingError):
                self.build()
        self.result["verified"] = True
        for key, value in (("real_fhe", 1), ("profile_id", "unknown"), ("concrete_python", "future"),
                           ("verification_method", "proof"), ("verification_is_cryptographic_proof", True)):
            original = self.result["metrics"][key]
            self.result["metrics"][key] = value
            with self.assertRaises(BindingError):
                self.build()
            self.result["metrics"][key] = original

    def test_json_duplicates_invalid_numbers_types_and_size(self):
        for value in (self.request.decode(), {}, b"{}", b"null", b"{", b"\xff", b"{" + b" " * 16384 + b"}",
                      b'{"protocolVersion":1,"protocolVersion":1}', b'{"protocolVersion":NaN}'):
            self.kwargs["request_manifest"] = value
            with self.subTest(kind=type(value).__name__), self.assertRaises(BindingError):
                self.build()

    def test_exact_raw_manifest_and_receipt_hashes_checked(self):
        for field in ("request_manifest", "evaluator_receipt"):
            original = self.kwargs[field]
            self.kwargs[field] = original + b" "
            with self.assertRaisesRegex(BindingError, "digest mismatch"):
                self.build()
            self.kwargs[field] = original

    def test_request_receipt_and_result_hash_substitution(self):
        for field in ("serverSha256", "clientSpecsSha256", "evaluationKeysSha256", "inputSha256", "outputSha256"):
            original = self.result["artifactHashes"][field]
            self.result["artifactHashes"][field] = "ab" * 32
            with self.subTest(field=field), self.assertRaises(BindingError):
                self.build()
            self.result["artifactHashes"][field] = original
        receipt = json.loads(self.receipt)
        receipt["request"]["attemptId"] = "0" * 32
        self.rebind_json(receipt=receipt)
        with self.assertRaisesRegex(BindingError, "receipt request mismatch"):
            self.build()

    def test_profile_and_pinned_circuit_spec_cannot_be_substituted(self):
        for key in ("profileId", "serverSha256", "clientSpecsSha256", "protocolVersion"):
            request = json.loads(self.request)
            request[key] = True if key == "protocolVersion" else "unknown"
            self.rebind_json(request=request)
            with self.subTest(field=key), self.assertRaises(BindingError):
                self.build()

    def test_registry_full_bidset_and_attempt_binding_required(self):
        for field in ("bidset_root", "attempt_binding_hash", "job_binding_hash"):
            self.job[field][0] ^= 1
            with self.assertRaises(BindingError):
                self.build()
            self.job[field][0] ^= 1
        self.job["bids"].pop(0)
        with self.assertRaises(BindingError):
            self.build()

    def test_config_accounts_deadlines_and_roster(self):
        for field, value in (("executor", "UPPER.near"), ("authorized_bidders", ["zulu.near", "alpha.near"]),
                             ("authorized_bidders", ["alpha.near", "alpha.near"]), ("bid_deadline_ns", "200"),
                             ("result_deadline_ns", "100")):
            original = self.job["config"][field]
            self.job["config"][field] = value
            with self.assertRaises(BindingError):
                self.build()
            self.job["config"][field] = original

    def test_valid_retry_history_and_stale_expected_attempt(self):
        old_claim = self.build()
        self.job["receipts"] = [{"claim": old_claim, "receipt_hash": reference.receipt_hash(old_claim),
                                  "reported_at_ns": "101", "status": "BuyerRejected", "decided_at_ns": "102"}]
        self.job["attempt"] = "2"
        self.job["attempt_binding_hash"] = reference.attempt_hash(self.job)
        with self.assertRaisesRegex(BindingError, "not current"):
            self.build()
        self.kwargs["expected_registry_attempt"] = "2"
        self.assertEqual(self.build()["attempt"], "2")
        # Same FHE evidence can be claimed for a new context: no proof is asserted.
        self.assertEqual(json.loads(self.request)["attemptId"], self.kwargs["expected_engine_attempt_id"])
        self.job["receipts"][0]["status"] = "BuyerAccepted"
        with self.assertRaises(BindingError):
            self.build()

    def test_metrics_malformed_or_receipt_inconsistent(self):
        for value in (True, -1, float("nan"), float("inf"), 10**1000):
            self.result["metrics"]["evaluate_seconds"] = value
            with self.assertRaises(BindingError):
                self.build()
        self.result["metrics"]["evaluate_seconds"] = 999
        with self.assertRaisesRegex(BindingError, "timing differs"):
            self.build()


if __name__ == "__main__":
    unittest.main()
