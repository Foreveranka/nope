"""Lifecycle/codec/privacy tests using an explicit injected ENGINE TEST DOUBLE.

No test in this file claims real FHE, authenticated network state or MPC. The
registry verifier below fabricates deterministic metadata ONLY in these tests.
Production engine wiring is checked separately with a patched import, not crypto.
"""
import copy
import json
import pickle
import tempfile
import threading
import time
import unittest
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from unittest.mock import patch

from engine.protocol import artifact_pins, canonical_json, sha256
from mpc import v2
from mpc.auction import UPSTREAM
from sdk.receipt import _attempt_hash
from service.procurement_client import ProcurementClient, ProcurementConfig, ProcurementClientError


def digest(label):
    return sha256(("EXPLICIT-TEST-ONLY:" + label).encode())


def draft():
    now = time.time_ns()
    roster = ["alpha.testnet", "beta.testnet", "gamma.testnet"]
    return {"id": "a" * 32, "title": "Synthetic four records", "profile": "clean-4-records-v1",
            "buyer": "buyer.testnet", "roster": roster, "bidDeadlineNs": str(now + 10**10),
            "resultDeadlineNs": str(now + 60 * 10**9), "status": "DRAFT", "revision": 0,
            "createdAt": now // 10**6, "updatedAt": now // 10**6, "ledger": "app",
            "blockchainBinding": "pending", "intent": None, "contextHash": None,
            "budgetCommitment": None, "bids": [{"provider": provider, "slot": slot, "commitment": None}
                for slot, provider in enumerate(roster, 1)], "closedAt": None, "selection": None,
            "deliveries": [], "decision": None}


def test_config():
    # Explicit trusted TEST configuration, with real source/program artifact pins.
    return ProcurementConfig("registry.testnet", digest("network"), "executor.testnet",
                             digest("policy"), v2.program_hash(), UPSTREAM)


class EngineDouble:
    """Thread-affine opaque-byte double. Never encryption or an execution proof."""
    def __init__(self):
        self.calls = []
        self.instances = []
        self.fail = None
        self.started = threading.Event()
        self.release = threading.Event()
        self.release.set()
        self.bad_pin = False

    def prepare(self, records, path, *, artifact_set):
        owner = self
        owner.calls.append(("prepare", threading.get_ident()))
        owner.started.set()
        if not owner.release.wait(3):
            raise RuntimeError("test barrier not released")
        if owner.fail == "prepare":
            raise RuntimeError("PRIVATE-MARKER-DO-NOT-EXPOSE")
        path.mkdir(parents=True, mode=0o700)
        (path / "request.bin").write_bytes(b"EXPLICIT-TEST-DOUBLE-CIPHERTEXT")

        class PreparedDouble:
            def __init__(self):
                self.thread = threading.get_ident()
                self.records = records
                self.secret_key = "EXPLICIT-TEST-DOUBLE-SECRET"
                self.closed = False
                self.binding = None
                pins = artifact_pins(artifact_set)
                self.artifact_hashes = {"serverSha256": digest("wrong-server") if owner.bad_pin else pins["server.zip"],
                    "clientSpecsSha256": pins["client-specs.json"], "inputSha256": digest("input"),
                    "evaluationKeysSha256": digest("evaluation-key")}

            def record(self, operation):
                owner.calls.append((operation, threading.get_ident()))
                if self.thread != threading.get_ident():
                    raise AssertionError("PreparedJob crossed worker threads")
                if owner.fail == operation:
                    raise RuntimeError("PRIVATE-MARKER-DO-NOT-EXPOSE")

            def bind_external(self, binding):
                self.record("bind")
                self.binding = copy.deepcopy(binding)

            def evaluate(self):
                self.record("evaluate")
                return {"outputSha256": digest("output"), "receiptSha256": digest("receipt"),
                        "requestManifestSha256": digest("manifest"),
                        "receipt": {"untrusted": "DO-NOT-EXPOSE-RECEIPT"}}

            def evaluate_remote(self, evaluator):
                self.record("evaluate_remote")
                evaluator({"request.bin": b"EXPLICIT-TEST-DOUBLE-CIPHERTEXT"})
                return self.evaluate()

            def finalize(self):
                self.record("finalize")
                if owner.fail == "expire-during-finalize":
                    owner.expire()
                return {"records": [{"id": 7, "value": 0, "duplicate": False}],
                        "verified": True, "metrics": {"real_fhe": False, "test_double": True},
                        "artifactHashes": dict(self.artifact_hashes)}

            def close(self):
                self.record("close")
                self.records = self.secret_key = None
                self.closed = True

        prepared = PreparedDouble()
        owner.instances.append(prepared)
        return prepared


def executing_job(expected, _evidence):
    """FABRICATED verifier output for tests; never installed by production code."""
    intent = expected["intent"]
    commitments = (expected["budgetCommitment"],) + tuple(digest("bid" + str(n)) for n in range(3))
    public_only = v2.PreparedSynthetic(canonical_json(intent), commitments, (), ())
    job = {"job_id": "7", "buyer": intent["buyer"], "config": v2.registry_config(public_only),
           "bids": [{"bidder": account, "commitment": list(v2.hex32(commitments[n]))}
                    for n, account in enumerate(intent["roster"], 1)],
           "state": "Executing", "closed_at_ns": intent["bidDeadlineNs"], "attempt": "1",
           "receipts": [], "selected_executor": intent["roster"][0], "attempt_binding_version": 2}
    return rehash_job(intent, job)


def rehash_job(intent, job):
    job["job_binding_hash"] = list(v2.hex32(v2.registry_job_hash(intent, job)))
    job["bidset_root"] = list(v2.hex32(v2.registry_bidset_root(job)))
    job["attempt_binding_hash"] = list(_attempt_hash(job, int(job["attempt"])))
    return job


def budget_plan(expected, evidence):
    """FABRICATED closed plan DOUBLE; does not authenticate a network or committee."""
    intent = expected["intent"]
    registry = executing_job(expected, evidence)
    registry.update(state="Closed", attempt="0", attempt_binding_hash=None,
                    selected_executor=None, attempt_binding_version=None)
    commitments = [expected["budgetCommitment"]] + [
        v2.registry_hash(bid["commitment"]).hex() for bid in registry["bids"]]
    public = v2.PreparedSynthetic(canonical_json(intent), tuple(commitments), (), ())
    manifest = v2.build_selection_manifest(public, registry)
    closed = copy.deepcopy(expected["draft"])
    closed.update(status="CLOSED", revision=5, intent=copy.deepcopy(intent),
        contextHash=expected["contextHash"], budgetCommitment=expected["budgetCommitment"],
        bids=[{"provider": provider, "slot": slot, "commitment": commitments[slot]}
              for slot, provider in enumerate(intent["roster"], 1)],
        closedAt=int(intent["bidDeadlineNs"]) // 10**6 + 1,
        updatedAt=int(intent["bidDeadlineNs"]) // 10**6 + 1)
    return {"job": closed, "manifest": manifest, "manifestHash": v2.manifest_digest(manifest)}


def replace_budget_plan(plan, *, registry_id="7"):
    """Rebuild self-consistent TEST metadata after changing a frozen app snapshot."""
    closed = plan["job"]
    intent = closed["intent"]
    commitments = [closed["budgetCommitment"]] + [bid["commitment"] for bid in closed["bids"]]
    public = v2.PreparedSynthetic(canonical_json(intent), tuple(commitments), (), ())
    registry = copy.deepcopy(plan["manifest"]["closedJob"])
    registry.update(job_id=registry_id, buyer=closed["buyer"], config=v2.registry_config(public),
        bids=[{"bidder": bid["provider"], "commitment": list(v2.hex32(bid["commitment"]))}
              for bid in closed["bids"]])
    registry["job_binding_hash"] = list(v2.hex32(v2.registry_job_hash(intent, registry)))
    registry["bidset_root"] = list(v2.hex32(v2.registry_bidset_root(registry)))
    manifest = v2.build_selection_manifest(public, registry)
    return {"job": closed, "manifest": manifest, "manifestHash": v2.manifest_digest(manifest)}


class ClientTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.engine = EngineDouble()
        self.config = test_config()
        self.draft = draft()
        self.required = {"qualified": [True, False, True], "fixedFee": 3}
        self.budget = 876543210987
        self.client = self.make_client()

    def make_client(self, **kwargs):
        options = dict(test_prepare_job=self.engine.prepare, binding_verifier=executing_job)
        options.update(kwargs)
        client = ProcurementClient(self.root, self.config, **options)
        self.addCleanup(client.close)
        return client

    def prepare(self, client=None):
        return (client or self.client).prepare(self.draft, self.required, budget=self.budget)

    def evaluate(self, session, client=None):
        with patch("service.procurement_client.time.time_ns", return_value=int(self.draft["bidDeadlineNs"]) + 1):
            return (client or self.client).evaluate(session["id"], evidence_hash=digest("evidence"))

    def make_input_client(self, **kwargs):
        options = {"plan_verifier": budget_plan, "port": 19400, "certificate_dir": self.root,
                   "runner": lambda *args, **kwargs: [1, 1, 90, 93]}
        options.update(kwargs)
        return self.make_client(**options)

    def input(self, session, client):
        with patch("service.procurement_client.time.time_ns", return_value=int(self.draft["bidDeadlineNs"]) + 2 * 10**6):
            return client.run_private_input(session["id"], evidence_hash=digest("input-evidence"))

    def assert_error(self, code, operation):
        with self.assertRaises(ProcurementClientError) as error:
            operation()
        self.assertEqual(error.exception.code, code)
        self.assertEqual(str(error.exception), code)

    def test_exact_publish_context_and_private_slot_zero_commitment(self):
        session = self.prepare()
        self.assertEqual(session["state"], "PREPARED")
        self.assertEqual(session["engineMode"], "test-double")
        payload = self.client.publish_payload(session["id"], expected_revision=0)
        self.assertEqual(set(payload), {"expectedRevision", "intent", "budgetCommitment"})
        self.assertEqual(payload["intent"]["mpcProgramHash"], v2.program_hash())
        v2.validate_intent(payload["intent"])
        self.assertEqual(session["contextHash"], v2.precommit_context(payload["intent"]))
        self.assertEqual(payload["budgetCommitment"], v2.commitment(session["contextHash"], 0,
                         self.budget, self.client._private["salt"]))
        self.assertEqual(payload["intent"]["specHash"], session["artifactHashes"]["clientSpecsSha256"])
        self.assertEqual(payload["intent"]["inputHash"], session["artifactHashes"]["inputSha256"])
        self.assertEqual(payload, self.client.publish_payload(session["id"], expected_revision=0))
        self.assertEqual([name for name, _ in self.engine.calls], ["prepare"])

    def test_detached_inputs_and_public_snapshots(self):
        session = self.prepare()
        saved = self.client.publish_payload(session["id"], expected_revision=0)
        self.draft["roster"][0] = "attacker.testnet"
        self.required["qualified"][0] = False
        session["intent"]["roster"][0] = "attacker.testnet"
        session["artifactHashes"].clear()
        self.assertEqual(saved, self.client.publish_payload(session["id"], expected_revision=0))

    def test_full_stages_share_one_noncaller_thread_and_release(self):
        session = self.prepare()
        evaluated = self.evaluate(session)
        self.assertEqual(evaluated["state"], "EVALUATED")
        self.assertEqual(set(evaluated["evaluationHashes"]),
                         {"outputSha256", "receiptSha256", "requestManifestSha256"})
        self.assertNotIn("receipt", evaluated)
        result = self.client.finalize(session["id"])
        self.assertTrue(result["verified"])
        self.assertFalse(result["metrics"]["real_fhe"])
        self.assertEqual(self.client.snapshot()["state"], "FINALIZED")
        self.assertIsNone(self.client._private)
        self.assertTrue(self.engine.instances[0].closed)
        self.assertIsNone(self.engine.instances[0].secret_key)
        threads = {thread for _, thread in self.engine.calls}
        self.assertEqual(len(threads), 1)
        self.assertNotIn(threading.get_ident(), threads)
        self.assertEqual([name for name, _ in self.engine.calls],
                         ["prepare", "bind", "evaluate", "finalize", "close"])
        self.assert_error("INVALID_STATE", lambda: self.client.finalize(session["id"]))
        self.assertEqual(self.prepare()["state"], "PREPARED")

    def test_budget_salt_records_and_raw_errors_never_public_or_persisted(self):
        seen = []
        def verifier(expected, evidence):
            seen.append(copy.deepcopy(expected))
            return executing_job(expected, evidence)
        client = self.make_client(binding_verifier=verifier)
        session = self.prepare(client)
        salt_hex = client._private["salt"].hex()
        self.evaluate(session, client)
        data = canonical_json({"snapshot": client.snapshot(), "verifier": seen})
        for private in (str(self.budget).encode(), salt_hex.encode(), b'"records"', b'"budget"',
                        b'"salt"', b"EXPLICIT-TEST-DOUBLE-SECRET", b"DO-NOT-EXPOSE-RECEIPT"):
            self.assertNotIn(private, data)
            for path in self.root.rglob("*"):
                if path.is_file():
                    self.assertNotIn(private, path.read_bytes())
        with self.assertRaises(TypeError):
            pickle.dumps(client)
        client.close_session(session["id"])
        self.assertIsNone(client._private)

    def test_one_session_and_concurrent_prepare_bounded(self):
        self.engine.release.clear()
        with ThreadPoolExecutor(max_workers=2) as callers:
            first = callers.submit(self.prepare)
            self.assertTrue(self.engine.started.wait(1))
            try:
                self.assert_error("SESSION_BUSY", self.prepare)
                self.assertEqual(len(self.engine.calls), 1)
            finally:
                self.engine.release.set()
            session = first.result(2)
        self.assert_error("SESSION_BUSY", self.prepare)
        self.client.close_session(session["id"])
        self.client.close_session(session["id"])
        replacement = self.prepare()
        self.assertNotEqual(session["id"], replacement["id"])
        self.assert_error("UNKNOWN_SESSION", lambda: self.client.publish_payload(session["id"], expected_revision=0))

    def test_idle_expiry_closes_on_owner_thread_without_polling(self):
        client = self.make_client(timeout_seconds=0.04)
        self.prepare(client)
        until = time.monotonic() + 2
        while time.monotonic() < until and not self.engine.instances[0].closed:
            time.sleep(0.005)
        self.assertTrue(self.engine.instances[0].closed)
        self.assertEqual(client.snapshot()["state"], "EXPIRED")
        self.assertIsNone(client._private)
        self.assertEqual(len({thread for _, thread in self.engine.calls}), 1)

    def test_expiry_during_finalize_preserves_terminal_expired_state(self):
        session = self.prepare()
        self.evaluate(session)
        self.engine.fail = "expire-during-finalize"
        self.engine.expire = lambda: self.client._expire(session["id"])
        self.assert_error("LOCAL_OPERATION_FAILED", lambda: self.client.finalize(session["id"]))
        self.client.close_session(session["id"])
        self.assertEqual(self.client.snapshot()["state"], "EXPIRED")
        self.assertTrue(self.engine.instances[0].closed)
        self.assertIsNone(self.client._private)

    def test_expiry_during_prepare_denies_new_admission_and_cleans_late_keys(self):
        self.engine.release.clear()
        client = self.make_client(timeout_seconds=0.04)
        with ThreadPoolExecutor(max_workers=1) as callers:
            first = callers.submit(self.prepare, client)
            self.assertTrue(self.engine.started.wait(1))
            time.sleep(0.08)
            self.assertEqual(client.snapshot()["state"], "EXPIRED")
            try:
                self.assert_error("SESSION_BUSY", lambda: self.prepare(client))
            finally:
                self.engine.release.set()
            self.assert_error("LOCAL_OPERATION_FAILED", lambda: first.result(2))
        client.close_session(client.snapshot()["id"])
        self.assertTrue(self.engine.instances[0].closed)
        self.assertIsNone(client._private)

    def test_close_during_verifier_prevents_binding_and_evaluation(self):
        started, release = threading.Event(), threading.Event()
        def verifier(expected, evidence):
            started.set()
            if not release.wait(2):
                raise AssertionError("test barrier not released")
            return executing_job(expected, evidence)
        client = self.make_client(binding_verifier=verifier)
        session = self.prepare(client)
        with ThreadPoolExecutor(max_workers=2) as callers:
            evaluation = callers.submit(self.evaluate, session, client)
            self.assertTrue(started.wait(1))
            closing = callers.submit(client.close_session, session["id"])
            until = time.monotonic() + 1
            while client.snapshot()["state"] != "CLOSED" and time.monotonic() < until:
                time.sleep(0.005)
            self.assert_error("SESSION_BUSY", lambda: client.prepare(draft(), self.required, budget=self.budget))
            release.set()
            self.assert_error("LOCAL_OPERATION_FAILED", lambda: evaluation.result(2))
            closing.result(2)
        self.assertEqual([name for name, _ in self.engine.calls], ["prepare", "close"])

    def test_missing_verifier_never_calls_engine_evaluate(self):
        client = self.make_client(binding_verifier=None)
        session = self.prepare(client)
        self.assert_error("BINDING_UNAVAILABLE", lambda: client.evaluate(session["id"], evidence_hash=digest("x")))
        self.assertEqual([name for name, _ in self.engine.calls], ["prepare"])

    def test_arbitrary_assertion_is_not_authenticated_registry_job(self):
        client = self.make_client(binding_verifier=lambda *_: {"verified": True, "job_id": "7"})
        session = self.prepare(client)
        self.assert_error("LOCAL_OPERATION_FAILED", lambda: self.evaluate(session, client))
        self.assertTrue(self.engine.instances[0].closed)
        self.assertNotIn("bind", [name for name, _ in self.engine.calls])

    def test_self_consistent_registry_config_and_buyer_mismatches_rejected(self):
        for field in ("input_hash", "key_hash", "circuit_hash", "spec_hash", "output_policy_hash",
                      "context_hash", "budget_commitment", "executor", "buyer"):
            with self.subTest(field=field):
                def verifier(expected, evidence):
                    job = executing_job(expected, evidence)
                    if field == "buyer":
                        job["buyer"] = "other.testnet"
                    elif field == "executor":
                        job["config"][field] = "other.testnet"
                    else:
                        job["config"][field] = list(v2.hex32(digest("tampered")))
                    return rehash_job(expected["intent"], job)
                client = self.make_client(binding_verifier=verifier)
                session = self.prepare(client)
                self.assert_error("LOCAL_OPERATION_FAILED", lambda: self.evaluate(session, client))
                self.assertTrue(self.engine.instances[-1].closed)

    def test_invalid_selected_attempts_and_incomplete_bids_rejected(self):
        for kind in ("attempt", "root", "missing-bid", "selected-executor", "unqualified", "legacy", "closed"):
            with self.subTest(kind=kind):
                def verifier(expected, evidence):
                    job = executing_job(expected, evidence)
                    if kind == "attempt":
                        job["attempt_binding_hash"] = list(v2.hex32(digest("wrong-attempt")))
                    elif kind == "root":
                        job["bidset_root"] = list(v2.hex32(digest("wrong-root")))
                    elif kind == "missing-bid":
                        job["bids"][0]["commitment"] = None
                        rehash_job(expected["intent"], job)
                    elif kind == "selected-executor":
                        job["selected_executor"] = "outside.testnet"
                        rehash_job(expected["intent"], job)
                    elif kind == "unqualified":
                        job["selected_executor"] = expected["intent"]["roster"][1]
                        rehash_job(expected["intent"], job)
                    elif kind == "legacy":
                        job["attempt_binding_version"] = 1
                        job["selected_executor"] = None
                        rehash_job(expected["intent"], job)
                    else:
                        job["state"] = "Closed"
                    return job
                client = self.make_client(binding_verifier=verifier)
                session = self.prepare(client)
                self.assert_error("LOCAL_OPERATION_FAILED", lambda: self.evaluate(session, client))
                self.assertIsNone(self.engine.instances[-1].binding)

    def test_failures_release_resources_and_redact_adapter_errors(self):
        for stage in ("prepare", "bind", "evaluate", "finalize"):
            with self.subTest(stage=stage):
                self.engine.fail = stage
                client = self.make_client()
                def attempt():
                    session = self.prepare(client)
                    self.evaluate(session, client)
                    client.finalize(session["id"])
                self.assert_error("LOCAL_OPERATION_FAILED", attempt)
                self.assertEqual(client.snapshot()["state"], "FAILED")
                self.assertNotIn("PRIVATE-MARKER", json.dumps(client.snapshot()))
                self.assertIsNone(client._private)
                self.assertFalse(client._active)
        self.engine.fail = None

    def test_invalid_public_draft_and_required_params_fail_before_keygen(self):
        cases = [({"records": []}, None), ({"budget": 99}, None), ({"revision": True}, None),
                 ({"status": "PUBLISHED"}, None), ({"intent": {}}, None), ({"buyer": "UPPER.testnet"}, None),
                 ({"bidDeadlineNs": "01"}, None), ({"resultDeadlineNs": "18446744073709551616"}, None),
                 ({"bidDeadlineNs": "1"}, None), ({"roster": ["beta.testnet", "alpha.testnet", "gamma.testnet"]}, None),
                 ({}, {"qualified": [1, True, True], "fixedFee": 0}),
                 ({}, {"qualified": [True] * 3, "fixedFee": True}),
                 ({}, {"qualified": [True] * 3, "fixedFee": 0, "networkDomainHash": digest("injection")})]
        for changes, required in cases:
            with self.subTest(changes=changes, required=required):
                value = dict(self.draft, **changes)
                self.assert_error("INVALID_PREPARATION", lambda: self.client.prepare(
                    value, self.required if required is None else required, budget=self.budget))
        for budget in (True, -1, MAX_TEST_AMOUNT, "100", 1.0):
            self.assert_error("INVALID_PREPARATION", lambda: self.client.prepare(self.draft, self.required, budget=budget))
        self.assertEqual(self.engine.calls, [])

    def test_wrong_engine_pin_and_unknown_program_config_fail_closed(self):
        self.engine.bad_pin = True
        self.assert_error("LOCAL_OPERATION_FAILED", self.prepare)
        self.assertTrue(self.engine.instances[0].closed)
        config = dict(vars(self.config))
        for key, value in (("mpc_program_hash", digest("wrong-program")), ("upstream", "fake-build"),
                           ("network_domain_hash", "00" * 32), ("artifact_set", "untrusted")):
            with self.subTest(key=key), self.assertRaises(ValueError):
                ProcurementConfig(**dict(config, **{key: value}))

    def test_program_changed_during_native_preparation_fails_closed(self):
        with patch("service.procurement_client.v2.program_hash",
                   side_effect=[self.config.mpc_program_hash, digest("changed-during-keygen")]):
            self.assert_error("LOCAL_OPERATION_FAILED", self.prepare)
        self.assertTrue(self.engine.instances[0].closed)
        self.assertIsNone(self.client._private)

    def test_canonical_deployment_helper_and_mount_config(self):
        config = ProcurementConfig.from_testnet_deployment(
            registry_executor=self.config.registry_executor, output_policy_hash=self.config.output_policy_hash)
        source = Path(__file__).resolve().parents[1]
        evidence = json.loads((source / "contracts/registry/deploy/evidence/deployment.json").read_bytes())
        self.assertEqual(config.registry_account, evidence["account_id"])
        self.assertEqual(config.network_domain_hash, evidence["network_domain_hash_hex"])
        self.assertEqual(config.mpc_program_hash, v2.program_hash())
        # Only the two owned files are required by this suite; the main worker's
        # optional mount files are inspected when present, never generated here.
        mount_config = source / "service/procurement-config.json"
        if mount_config.is_file():
            self.assertEqual(ProcurementConfig(**json.loads(mount_config.read_bytes())).mpc_program_hash,
                             v2.program_hash())

    def test_revision_evidence_state_and_shutdown_validation(self):
        session = self.prepare()
        for revision in (True, -1, 1, "0"):
            self.assert_error("REVISION_MISMATCH", lambda: self.client.publish_payload(session["id"], expected_revision=revision))
        for evidence in ("00" * 32, "A" * 64, "not-a-hash", True):
            self.assert_error("INVALID_EVIDENCE_HASH", lambda: self.client.evaluate(session["id"], evidence_hash=evidence))
        self.assert_error("INVALID_STATE", lambda: self.client.finalize(session["id"]))
        self.evaluate(session)
        self.assert_error("INVALID_STATE", lambda: self.evaluate(session))
        self.client.close()
        self.client.close()
        self.assertTrue(self.engine.instances[0].closed)
        self.assert_error("CLIENT_CLOSED", self.prepare)

    def test_reentrant_adapter_cannot_deadlock_worker(self):
        def verifier(expected, evidence):
            self.assert_error("REENTRANT_CALL", lambda: client.publish_payload(session["id"], expected_revision=0))
            return executing_job(expected, evidence)
        client = self.make_client(binding_verifier=verifier)
        session = self.prepare(client)
        self.assertEqual(self.evaluate(session, client)["state"], "EVALUATED")

    def test_remote_transport_only_after_binding_and_production_import_wiring(self):
        sent = []
        client = self.make_client(evaluator=lambda files: sent.append(copy.deepcopy(files)))
        session = self.prepare(client)
        self.evaluate(session, client)
        self.assertEqual(sent, [{"request.bin": b"EXPLICIT-TEST-DOUBLE-CIPHERTEXT"}])
        self.assertIsNotNone(self.engine.instances[-1].binding)
        # Explicit import patch: verifies production uses prepare_job, not real crypto.
        self.client.close()
        real_path_client = self.make_client(test_prepare_job=None)
        with patch("engine.pipeline.prepare_job", side_effect=self.engine.prepare) as engine_import:
            session = self.prepare(real_path_client)
            engine_import.assert_called_once()
            self.assertEqual(session["engineMode"], "real-fhe")

    def test_budget_input_success_preserves_fhe_affinity_and_evaluate_finalize_gates(self):
        calls, verifier_threads = [], []
        def verifier(expected, evidence):
            verifier_threads.append(threading.get_ident())
            return budget_plan(expected, evidence)
        def runner(*args, **kwargs):
            calls.append((args, kwargs, threading.get_ident()))
            return [1, 1, 90, 93]
        client = self.make_input_client(plan_verifier=verifier, runner=runner)
        session = self.prepare(client)
        salt = client._private["salt"]
        result = self.input(session, client)
        self.assertEqual(result["state"], "PREPARED")
        self.assertEqual(result["privateInput"], {"state": "INPUT_COMPLETE",
            "manifestHash": calls[0][1]["expected_manifest_hash"], "found": True,
            "selectedSlot": 1, "selectedProvider": self.draft["roster"][0], "price": 90, "total": 93})
        args, kwargs, runner_thread = calls[0]
        self.assertEqual(args[1:], (0, 19400, self.root.resolve(), self.budget, salt))
        self.assertEqual(kwargs["codec_version"], 2)
        self.assertEqual(kwargs["expected_manifest_hash"], v2.manifest_digest(args[0]))
        self.assertTrue(0 < kwargs["timeout"] <= 60)
        self.assertIsNone(client._private["budget"])
        self.assertIsNone(client._private["salt"])
        self.assertFalse(self.engine.instances[-1].closed)
        self.assertTrue(client._timer.is_alive())
        self.assert_error("INVALID_STATE", lambda: self.input(session, client))
        self.assertFalse(self.engine.instances[-1].closed)
        result["privateInput"]["price"] = 999
        self.assertEqual(client.snapshot()["privateInput"]["price"], 90)
        self.assertEqual(self.evaluate(session, client)["state"], "EVALUATED")
        self.assertTrue(client.finalize(session["id"])["verified"])
        self.assertEqual({thread for _, thread in self.engine.calls}, {runner_thread})
        self.assertEqual(verifier_threads, [runner_thread])

    def test_budget_input_default_strict_client_wiring_is_patched_not_real_mpc(self):
        client = self.make_input_client(runner=None)
        session = self.prepare(client)
        with patch("mpc.sealed_client.run", return_value=[1, 1, 90, 93]) as actual_import:
            result = self.input(session, client)
        actual_import.assert_called_once()
        args, kwargs = actual_import.call_args
        self.assertEqual(args[1], 0)
        self.assertEqual(kwargs["codec_version"], 2)
        self.assertEqual(kwargs["expected_manifest_hash"], v2.manifest_digest(args[0]))
        self.assertEqual(set(kwargs), {"timeout", "codec_version", "expected_manifest_hash"})
        self.assertEqual(result["privateInput"]["selectedSlot"], 1)

    def test_budget_input_nofound_and_zero_budget_stay_local_and_do_not_close_fhe(self):
        client = self.make_input_client(runner=lambda *args, **kwargs: [0, 0, 0, 0])
        session = client.prepare(self.draft, self.required, budget=0)
        result = self.input(session, client)
        self.assertFalse(result["privateInput"]["found"])
        self.assertEqual(result["privateInput"]["selectedSlot"], 0)
        self.assertIsNone(result["privateInput"]["selectedProvider"])
        self.assertEqual(result["privateInput"]["price"], 0)
        self.assertEqual(result["state"], "PREPARED")
        self.assertFalse(self.engine.instances[-1].closed)

    def test_budget_input_privacy_and_no_network_disk_or_argv_secret_transport(self):
        seen = []
        def verifier(expected, evidence):
            seen.append(copy.deepcopy(expected))
            return budget_plan(expected, evidence)
        client = self.make_input_client(plan_verifier=verifier)
        session = self.prepare(client)
        salt_hex = client._private["salt"].hex()
        with patch("socket.create_connection", side_effect=AssertionError("network forbidden")), \
             patch("subprocess.run", side_effect=AssertionError("argv forbidden")):
            result = self.input(session, client)
        wire = canonical_json({"verifier": seen, "result": result})
        for secret in (str(self.budget).encode(), salt_hex.encode(), b'"budget"', b'"salt"'):
            self.assertNotIn(secret, wire)
            for path in self.root.rglob("*"):
                if path.is_file():
                    self.assertNotIn(secret, path.read_bytes())
        # The exact publication payload stays restricted to public intent/hash
        # metadata even after the local snapshot contains buyer output prices.
        with patch("service.procurement_client.time.time_ns", return_value=int(self.draft["bidDeadlineNs"]) - 1):
            payload = client.publish_payload(session["id"], expected_revision=0)
        self.assertEqual(set(payload), {"expectedRevision", "intent", "budgetCommitment"})
        self.assertNotIn("privateInput", payload)

    def test_budget_input_unconfigured_or_early_calls_do_not_burn_opening(self):
        for options in ({"plan_verifier": None}, {"port": None, "certificate_dir": None}):
            client = self.make_input_client(**options)
            session = self.prepare(client)
            self.assert_error("PRIVATE_INPUT_UNAVAILABLE", lambda: self.input(session, client))
            self.assertEqual(client._private["budget"], self.budget)
            self.assertIsNotNone(client._private["salt"])
            self.assertFalse(self.engine.instances[-1].closed)
        client = self.make_input_client()
        session = self.prepare(client)
        self.assert_error("INPUT_WINDOW_CLOSED", lambda: client.run_private_input(session["id"], evidence_hash=digest("evidence")))
        with patch("service.procurement_client.time.time_ns", return_value=int(self.draft["resultDeadlineNs"])):
            self.assert_error("INPUT_WINDOW_CLOSED", lambda: client.run_private_input(session["id"], evidence_hash=digest("evidence")))
        self.assertIsNotNone(client._private["salt"])
        self.assertNotIn("privateInput", client.snapshot())

    def test_budget_input_rejects_http_plan_transport_or_verified_overrides(self):
        client = self.make_input_client()
        session = self.prepare(client)
        for evidence in ("00" * 32, "AA" * 32, {"verified": True}, "https://untrusted.example"):
            self.assert_error("INVALID_EVIDENCE_HASH", lambda: client.run_private_input(session["id"], evidence_hash=evidence))
        for key in ("host", "port", "certificate_dir", "manifest", "runner", "verified", "unsafe_test_override"):
            with self.subTest(key=key), self.assertRaises(TypeError):
                client.run_private_input(session["id"], evidence_hash=digest("evidence"), **{key: "untrusted"})
        self.assertIsNotNone(client._private["salt"])
        self.assertFalse(self.engine.instances[-1].closed)

    def test_budget_input_frozen_draft_identity_intent_and_build_mismatches(self):
        for kind in ("id", "title", "buyer", "roster", "deadline", "createdAt", "revision",
                     "closedAt", "contextHash", "intent", "budget", "program"):
            with self.subTest(kind=kind):
                def verifier(expected, evidence):
                    plan = budget_plan(expected, evidence)
                    job = plan["job"]
                    if kind == "id":
                        job["id"] = "b" * 32
                    elif kind == "title":
                        job["title"] = "Another draft"
                    elif kind == "buyer":
                        job["buyer"] = "other.testnet"
                    elif kind == "roster":
                        job["roster"] = list(reversed(job["roster"]))
                    elif kind == "deadline":
                        job["resultDeadlineNs"] = str(int(job["resultDeadlineNs"]) + 1)
                    elif kind == "createdAt":
                        job["createdAt"] += 1
                    elif kind == "revision":
                        job["revision"] = True
                    elif kind == "closedAt":
                        job["closedAt"] = 0
                    elif kind == "contextHash":
                        job["contextHash"] = digest("wrong-context")
                    elif kind == "intent":
                        job["intent"]["qualified"][1] = True
                        job["contextHash"] = v2.precommit_context(job["intent"])
                        return replace_budget_plan(plan)
                    elif kind == "budget":
                        job["budgetCommitment"] = digest("wrong-budget")
                        return replace_budget_plan(plan)
                    else:
                        job["intent"]["mpcProgramHash"] = digest("unapproved-program")
                        job["contextHash"] = v2.precommit_context(job["intent"])
                        return replace_budget_plan(plan)
                    return plan
                client = self.make_input_client(plan_verifier=verifier)
                session = self.prepare(client)
                self.assert_error("PRIVATE_INPUT_FAILED", lambda: self.input(session, client))
                self.assertIsNone(client._private)
                self.assertTrue(self.engine.instances[-1].closed)

    def test_budget_input_all_four_commitments_bound_to_frozen_app_and_registry(self):
        for slot in range(4):
            with self.subTest(slot=slot):
                def verifier(expected, evidence):
                    plan = budget_plan(expected, evidence)
                    replacement = copy.deepcopy(plan)
                    if slot == 0:
                        replacement["job"]["budgetCommitment"] = digest("replaced-budget")
                    else:
                        replacement["job"]["bids"][slot - 1]["commitment"] = digest("replaced-provider")
                    replacement = replace_budget_plan(replacement)
                    # Replace every registry hash/digest consistently, but not
                    # the authenticated frozen app snapshot used for comparison.
                    plan["manifest"], plan["manifestHash"] = replacement["manifest"], replacement["manifestHash"]
                    return plan
                client = self.make_input_client(plan_verifier=verifier)
                session = self.prepare(client)
                self.assert_error("PRIVATE_INPUT_FAILED", lambda: self.input(session, client))

    def test_budget_input_invalid_registry_bindings_slots_plan_and_digest(self):
        for kind in ("assertion", "extra-host", "job-hash", "bidset", "digest", "missing-bid",
                     "bool-slot", "registry-config", "attempt", "zero-job-id"):
            with self.subTest(kind=kind):
                def verifier(expected, evidence):
                    plan = budget_plan(expected, evidence)
                    registry = plan["manifest"]["closedJob"]
                    if kind == "assertion":
                        return {"verified": True}
                    if kind == "extra-host":
                        plan["host"] = "untrusted.example"
                    elif kind == "job-hash":
                        registry["job_binding_hash"] = list(v2.hex32(digest("wrong-job")))
                    elif kind == "bidset":
                        registry["bidset_root"] = list(v2.hex32(digest("wrong-bidset")))
                    elif kind == "digest":
                        plan["manifestHash"] = digest("wrong-manifest")
                    elif kind == "missing-bid":
                        plan["job"]["bids"][1]["commitment"] = None
                    elif kind == "bool-slot":
                        plan["job"]["bids"][0]["slot"] = True
                    elif kind == "registry-config":
                        registry["config"]["input_hash"] = list(v2.hex32(digest("wrong-input")))
                    elif kind == "attempt":
                        registry["attempt"] = "1"
                    elif kind == "zero-job-id":
                        return replace_budget_plan(plan, registry_id="0")
                    return plan
                client = self.make_input_client(plan_verifier=verifier)
                session = self.prepare(client)
                self.assert_error("PRIVATE_INPUT_FAILED", lambda: self.input(session, client))

    def test_budget_input_bad_output_and_corrupted_opening_fail_closed(self):
        for output in ([True, 1, 90, 93], [1, 2, 90, 93], [1, 4, 90, 93], [2, 1, 90, 93],
                       [1, 1, 0, 3], [1, 1, 90, 94], [1, 1, self.budget, self.budget + 3],
                       [0, 1, 0, 0], [1, 1, 90], {"price": 90}):
            with self.subTest(output=output):
                client = self.make_input_client(runner=lambda *args, **kwargs: output)
                session = self.prepare(client)
                self.assert_error("PRIVATE_INPUT_FAILED", lambda: self.input(session, client))
                self.assertEqual(client.snapshot()["privateInput"], {"state": "FAILED"})
                self.assertIsNone(client._private)
        called = []
        client = self.make_input_client(runner=lambda *args, **kwargs: called.append(args))
        session = self.prepare(client)
        client._private["budget"] += 1
        self.assert_error("PRIVATE_INPUT_FAILED", lambda: self.input(session, client))
        self.assertEqual(called, [])

    def test_budget_input_ambiguous_runner_failure_burns_once_and_redacts_errors(self):
        called = []
        def runner(*args, **kwargs):
            called.append(True)
            raise RuntimeError("PRIVATE-BUDGET-AND-SALT-DO-NOT-EXPOSE")
        client = self.make_input_client(runner=runner)
        session = self.prepare(client)
        self.assert_error("PRIVATE_INPUT_FAILED", lambda: self.input(session, client))
        self.assert_error("INVALID_STATE", lambda: self.input(session, client))
        self.assertEqual(called, [True])
        self.assertEqual(client.snapshot()["state"], "FAILED")
        self.assertNotIn("PRIVATE-BUDGET", json.dumps(client.snapshot()))
        self.assertIsNone(client._private)
        self.assertTrue(self.engine.instances[-1].closed)

    def test_budget_input_late_output_fails_even_when_adapter_ignores_its_timeout(self):
        def runner(*args, **kwargs):
            clock.return_value = int(self.draft["resultDeadlineNs"])
            return [1, 1, 90, 93]
        client = self.make_input_client(runner=runner)
        session = self.prepare(client)
        with patch("service.procurement_client.time.time_ns",
                   return_value=int(self.draft["bidDeadlineNs"]) + 2 * 10**6) as clock:
            self.assert_error("PRIVATE_INPUT_FAILED", lambda: client.run_private_input(
                session["id"], evidence_hash=digest("input-evidence")))
        self.assertIsNone(client._private)
        self.assertEqual(client.snapshot()["privateInput"], {"state": "FAILED"})

    def test_budget_input_expiry_during_plan_prevents_secret_transmission(self):
        started, release = threading.Event(), threading.Event()
        sent = []
        def verifier(expected, evidence):
            started.set()
            if not release.wait(2):
                raise AssertionError("test barrier not released")
            return budget_plan(expected, evidence)
        client = self.make_input_client(plan_verifier=verifier, runner=lambda *args, **kwargs: sent.append(args))
        session = self.prepare(client)
        with ThreadPoolExecutor(max_workers=1) as callers:
            result = callers.submit(self.input, session, client)
            self.assertTrue(started.wait(1))
            try:
                client._expire(session["id"])
                self.assertEqual(client.snapshot()["state"], "EXPIRED")
            finally:
                release.set()
            self.assert_error("PRIVATE_INPUT_FAILED", lambda: result.result(2))
        client.close_session(session["id"])
        self.assertEqual(sent, [])
        self.assertIsNone(client._private)
        self.assertEqual(len({thread for _, thread in self.engine.calls}), 1)

    def test_budget_input_close_during_runner_does_not_resurrect_fhe_or_accept_replay(self):
        started, release = threading.Event(), threading.Event()
        def runner(*args, **kwargs):
            started.set()
            if not release.wait(2):
                raise AssertionError("test barrier not released")
            return [1, 1, 90, 93]
        client = self.make_input_client(runner=runner)
        session = self.prepare(client)
        with ThreadPoolExecutor(max_workers=2) as callers:
            result = callers.submit(self.input, session, client)
            self.assertTrue(started.wait(1))
            try:
                self.assert_error("SESSION_BUSY", lambda: self.input(session, client))
                closing = callers.submit(client.close_session, session["id"])
                until = time.monotonic() + 1
                while client.snapshot()["state"] != "CLOSED" and time.monotonic() < until:
                    time.sleep(0.005)
                self.assertEqual(client.snapshot()["state"], "CLOSED")
            finally:
                release.set()
            self.assert_error("PRIVATE_INPUT_FAILED", lambda: result.result(2))
            closing.result(2)
        self.assertIsNone(client._private)
        self.assertEqual(client.snapshot()["state"], "CLOSED")
        self.assertEqual(len({thread for _, thread in self.engine.calls}), 1)

    def test_budget_input_timeout_bound_and_reentrant_adapter_validation(self):
        def runner(*args, **kwargs):
            self.assertTrue(0 < kwargs["timeout"] <= 0.5)
            self.assert_error("REENTRANT_CALL", lambda: self.input(session, client))
            return [1, 1, 90, 93]
        client = self.make_input_client(input_timeout_seconds=0.5, runner=runner)
        session = self.prepare(client)
        self.assertEqual(self.input(session, client)["privateInput"]["state"], "INPUT_COMPLETE")
        for options in ({"input_timeout_seconds": 601}, {"input_timeout_seconds": True},
                        {"input_timeout_seconds": float("nan")}, {"runner": True},
                        {"port": 80}, {"port": True}, {"port": None}, {"certificate_dir": None},
                        {"certificate_dir": "relative/path"}):
            with self.subTest(options=options), self.assertRaises((ValueError, TypeError)):
                self.make_input_client(**options)


MAX_TEST_AMOUNT = 10**12 + 1

if __name__ == "__main__":
    unittest.main()
