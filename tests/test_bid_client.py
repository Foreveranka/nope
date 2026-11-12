"""Provider lifecycle tests with labelled PLAN/TRANSPORT DOUBLES, no real MPC.

Fixtures fabricate registry/app snapshots only in this test file. Injected
verifiers do not establish authentication; injected runners do not encrypt or
run an MPC. The default import test patches sealed_client.run explicitly.
"""
import copy
import hashlib
import inspect
import json
import pickle
import tempfile
import threading
import time
import unittest
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from unittest.mock import patch

from engine.protocol import artifact_pins, canonical_json
from mpc import v2
from mpc.auction import MAX_AMOUNT, UPSTREAM
from service.bid_client import BidClient, BidClientError
from service.procurement_client import ProcurementConfig


def digest(text):
    return hashlib.sha256(("BID-TEST-DOUBLE-ONLY:" + text).encode()).hexdigest()


def config():
    return ProcurementConfig("registry.testnet", digest("network"), "executor.testnet",
                             digest("policy"), v2.program_hash(), UPSTREAM)


def published_job(pins, identity="a" * 32):
    now = time.time_ns()
    hashes = artifact_pins(pins.artifact_set)
    roster = ["alpha.testnet", "beta.testnet", "gamma.testnet"]
    intent = v2.build_intent(network_domain_hash=pins.network_domain_hash,
        registry_account=pins.registry_account, buyer="buyer.testnet", roster=roster,
        qualified=[True, False, True], fixed_fee=7,
        bid_deadline_ns=str(now + 10**10), result_deadline_ns=str(now + 60 * 10**9),
        spec_hash=hashes["client-specs.json"], circuit_hash=hashes["server.zip"],
        key_hash=digest("evaluation-key"), input_hash=digest("encrypted-input"),
        output_policy_hash=pins.output_policy_hash, registry_executor=pins.registry_executor)
    return {"id": identity, "title": "Synthetic provider test", "profile": "clean-4-records-v1",
        "buyer": intent["buyer"], "roster": roster, "bidDeadlineNs": intent["bidDeadlineNs"],
        "resultDeadlineNs": intent["resultDeadlineNs"], "status": "PUBLISHED", "revision": 1,
        "createdAt": now // 10**6, "updatedAt": now // 10**6, "ledger": "app",
        "blockchainBinding": "pending", "intent": intent, "contextHash": v2.precommit_context(intent),
        "budgetCommitment": digest("budget-commitment"), "bids": [
            {"provider": account, "slot": slot, "commitment": None}
            for slot, account in enumerate(roster, 1)], "closedAt": None, "selection": None,
        "deliveries": [], "decision": None}


def make_plan(expected, _evidence):
    """Explicit fabricated authenticated-plan DOUBLE, never production code."""
    closed = copy.deepcopy(expected["job"])
    closed["status"] = "CLOSED"
    closed["revision"] = 5
    closed["closedAt"] = int(closed["bidDeadlineNs"]) // 10**6 + 1
    closed["updatedAt"] = closed["closedAt"]
    for bid in closed["bids"]:
        if bid["provider"] == expected["provider"]:
            bid["commitment"] = expected["commitment"]
        elif bid["commitment"] is None:
            bid["commitment"] = digest("bid" + str(bid["slot"]))
    return plan_from_closed(closed)


def plan_from_closed(closed, registry_id="7"):
    intent = closed["intent"]
    commitments = [closed["budgetCommitment"]] + [bid["commitment"] for bid in closed["bids"]]
    # This helper supplies NO private synthetic witness to the public codec.
    public = v2.PreparedSynthetic(canonical_json(intent), tuple(commitments), (), ())
    registry = {"job_id": registry_id, "buyer": closed["buyer"], "config": v2.registry_config(public),
        "bids": [{"bidder": bid["provider"], "commitment": list(v2.hex32(bid["commitment"]))}
                 for bid in closed["bids"]], "state": "Closed", "closed_at_ns": intent["bidDeadlineNs"],
        "attempt": "0", "attempt_binding_hash": None, "receipts": [],
        "selected_executor": None, "attempt_binding_version": None}
    registry["job_binding_hash"] = list(v2.hex32(v2.registry_job_hash(intent, registry)))
    registry["bidset_root"] = list(v2.hex32(v2.registry_bidset_root(registry)))
    manifest = v2.build_selection_manifest(public, registry)
    return {"job": closed, "manifest": manifest, "manifestHash": v2.manifest_digest(manifest)}


class RunnerDouble:
    """Captures local arguments for tests, never opens sockets or persists them."""
    def __init__(self):
        self.calls = []

    def __call__(self, manifest, client_id, port, certificates, amount, salt, **kwargs):
        self.calls.append({"manifest": copy.deepcopy(manifest), "client_id": client_id,
            "port": port, "certificates": certificates, "amount": amount, "salt": salt,
            **kwargs})
        return [1, amount]


class BidTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name).resolve()
        self.config = config()
        self.job = published_job(self.config)
        self.provider = self.job["roster"][0]
        self.price = 987654321098
        self.runner = RunnerDouble()
        self.client = self.make_client()

    def make_client(self, **kwargs):
        options = {"plan_verifier": make_plan, "runner": self.runner,
                   "port": 19400, "certificate_dir": self.root}
        options.update(kwargs)
        client = BidClient(self.config, **options)
        self.addCleanup(client.close)
        return client

    def prepare(self, client=None, job=None, provider=None, price=None):
        return (client or self.client).prepare(self.job if job is None else job,
            self.provider if provider is None else provider, price=self.price if price is None else price)

    def run_input(self, session, client=None):
        with patch("service.bid_client.time.time_ns", return_value=int(self.job["bidDeadlineNs"]) + 2 * 10**6):
            return (client or self.client).run_private_input(session["id"], evidence_hash=digest("evidence"))

    def assert_error(self, code, operation):
        with self.assertRaises(BidClientError) as raised:
            operation()
        self.assertEqual(raised.exception.code, code)
        self.assertEqual(str(raised.exception), code)

    def test_exact_public_snapshot_and_independent_slot_commitment_codec(self):
        with patch("service.bid_client.secrets.token_bytes", wraps=__import__("secrets").token_bytes) as rng:
            session = self.prepare()
        self.assertIn(unittest.mock.call(32), rng.call_args_list)
        self.assertEqual(set(session), {"id", "jobId", "provider", "slot", "contextHash", "commitment", "state", "expiresAt"})
        self.assertEqual(session["slot"], 1)
        self.assertEqual(session["state"], "PREPARED")
        secret = self.client._sessions[session["id"]]
        expected = hashlib.sha256(b"VEIL-MPC-v2\0" + bytes.fromhex(self.job["contextHash"]) +
            b"\x01" + self.price.to_bytes(8, "big") + secret.salt).hexdigest()
        self.assertEqual(session["commitment"], expected)
        self.assertEqual(secret.price, self.price)
        self.assertEqual(len(secret.salt), 32)
        self.assertGreater(session["expiresAt"], int(time.time() * 1000))
        self.assertEqual(self.runner.calls, [])

    def test_lookup_recovers_lost_prepare_response_without_resetting_opening(self):
        expected = self.prepare()
        private = self.client._sessions[expected["id"]]
        opening = (private.price, private.salt, private.deadline, private.timer)
        # The mount/browser lost the response/session id; recover using only its
        # authenticated public job id and provider, without running prepare again.
        with patch("service.bid_client.secrets.token_bytes", side_effect=AssertionError("no new salt")):
            recovered = self.client.lookup(self.job["id"], self.provider)
            self.assertEqual(recovered, expected)
            self.assertEqual(set(recovered), set(expected))
            self.assert_error("BID_ALREADY_PREPARED", self.prepare)
            self.assertEqual((private.price, private.salt, private.deadline, private.timer), opening)
            self.assertEqual(self.client.lookup(self.job["id"], self.provider), expected)
        recovered["commitment"] = digest("caller-mutated")
        recovered["slot"] = 3
        self.assertEqual(self.client.lookup(self.job["id"], self.provider), expected)
        wire = canonical_json(self.client.lookup(self.job["id"], self.provider))
        self.assertNotIn(str(self.price).encode(), wire)
        self.assertNotIn(opening[1].hex().encode(), wire)
        self.assertNotIn(b'"price"', wire)
        self.assertNotIn(b'"salt"', wire)
        self.assertEqual(self.runner.calls, [])

    def test_lookup_isolates_provider_and_job(self):
        first = self.prepare()
        second = self.prepare(provider=self.job["roster"][1])
        self.assertEqual(self.client.lookup(self.job["id"], self.provider), first)
        self.assertEqual(self.client.lookup(self.job["id"], self.job["roster"][1]), second)
        self.assertNotEqual(first["commitment"], second["commitment"])
        self.assertIsNone(self.client.lookup(self.job["id"], self.job["roster"][2]))
        self.assertIsNone(self.client.lookup(self.job["id"], "outside.testnet"))
        self.assertIsNone(self.client.lookup("b" * 32, self.provider))
        self.assertEqual(len(self.client._sessions), 2)

    def test_lookup_enforces_expiry_without_timer_and_does_not_resurrect(self):
        prepared = self.prepare()
        private = self.client._sessions[prepared["id"]]
        private.timer.cancel()  # Model a delayed timer: lookup must enforce TTL.
        deadline = private.deadline
        with patch("service.bid_client.time.monotonic", return_value=deadline):
            self.assertIsNone(self.client.lookup(self.job["id"], self.provider))
            self.assertEqual(self.client.snapshot(prepared["id"])["state"], "EXPIRED")
        self.assertIsNone(private.price)
        self.assertIsNone(private.salt)
        self.assertEqual(private.deadline, deadline)
        # Even if the clock appears earlier afterwards, the session stays ended.
        self.assertIsNone(self.client.lookup(self.job["id"], self.provider))
        self.assertEqual(len(self.client._sessions), 1)

    def test_lookup_excludes_closed_failed_and_completed_sessions(self):
        prepared = self.prepare()
        self.client.close_session(prepared["id"])
        self.assertIsNone(self.client.lookup(self.job["id"], self.provider))
        self.assertIsNone(self.client._sessions[prepared["id"]].salt)
        # An explicitly new prepare may coexist with the terminal snapshot; only
        # that new live session is found. lookup itself never creates it.
        current = self.prepare()
        self.assertEqual(self.client.lookup(self.job["id"], self.provider), current)
        self.assertNotEqual(current["id"], prepared["id"])
        self.run_input(current)
        self.assertIsNone(self.client.lookup(self.job["id"], self.provider))
        client = self.make_client(plan_verifier=lambda *_: {"verified": True})
        failed = self.prepare(client)
        self.assert_error("PRIVATE_INPUT_FAILED", lambda: self.run_input(failed, client))
        self.assertIsNone(client.lookup(self.job["id"], self.provider))

    def test_lookup_validates_identifiers_and_stays_closed_after_shutdown(self):
        self.prepare()
        for job_id, provider in ((True, self.provider), ("A" * 32, self.provider),
                                 ("a" * 31, self.provider), (self.job["id"], True),
                                 (self.job["id"], "ALPHA.testnet")):
            self.assert_error("INVALID_LOOKUP", lambda: self.client.lookup(job_id, provider))
        self.client.close()
        self.assert_error("CLIENT_CLOSED", lambda: self.client.lookup(self.job["id"], self.provider))

    def test_slots_and_fresh_salts_include_unqualified_provider_without_relabeling(self):
        sessions = [self.prepare(provider=provider) for provider in self.job["roster"]]
        self.assertEqual([s["slot"] for s in sessions], [1, 2, 3])
        salts = [self.client._sessions[s["id"]].salt for s in sessions]
        self.assertEqual(len(set(salts)), 3)
        self.assertEqual(len({s["commitment"] for s in sessions}), 3)
        # An ineligible slot still supplies its committed input; circuit decides eligibility.
        self.assertEqual(self.run_input(sessions[1])["state"], "INPUT_COMPLETE")

    def test_no_secret_repr_serialization_verifier_or_public_output_leak_and_no_disk_writes(self):
        seen = []
        def verifier(expected, evidence):
            seen.append(copy.deepcopy(expected))
            return make_plan(expected, evidence)
        client = self.make_client(plan_verifier=verifier)
        with patch("socket.create_connection", side_effect=AssertionError("network forbidden")):
            session = self.prepare(client)
            secret = client._sessions[session["id"]]
            salt = secret.salt
            for value in (client, secret):
                with self.assertRaises(TypeError):
                    pickle.dumps(value)
            representations = repr(client) + repr(client._sessions)
            result = self.run_input(session, client)
        wire = canonical_json({"prepared": session, "result": result, "verifier": seen})
        for marker in (str(self.price), salt.hex(), repr(salt)):
            self.assertNotIn(marker, representations)
            self.assertNotIn(marker.encode(), wire)
        for key in (b'"price"', b'"salt"', b'"amount"', b'"output"', b'"won"', b'"payout"'):
            self.assertNotIn(key, wire)
        self.assertEqual(list(self.root.iterdir()), [])
        self.assertIsNone(secret.price)
        self.assertIsNone(secret.salt)

    def test_detached_job_inputs_and_returned_snapshots(self):
        session = self.prepare()
        saved = self.client.snapshot(session["id"])
        self.job["intent"]["qualified"][0] = False
        self.job["roster"][0] = "attacker.testnet"
        session["commitment"] = digest("modified")
        returned = self.client.snapshot(session["id"])
        self.assertEqual(returned, saved)
        returned["slot"] = 3
        result = self.run_input(saved)
        self.assertEqual(result["state"], "INPUT_COMPLETE")
        self.assertEqual(self.runner.calls[0]["manifest"]["intent"]["roster"][0], self.provider)

    def test_strict_default_runner_v2_arguments_with_explicit_import_patch(self):
        client = self.make_client(runner=None)
        session = self.prepare(client)
        # Explicit DOUBLE patch of real default import; never real MPC/network.
        with patch("mpc.sealed_client.run", return_value=[1, self.price]) as actual_import:
            result = self.run_input(session, client)
        args, kwargs = actual_import.call_args
        actual_import.assert_called_once()
        self.assertEqual(args[1:5], (1, 19400, self.root, self.price))
        self.assertEqual(len(args[5]), 32)
        self.assertEqual(kwargs["codec_version"], 2)
        self.assertEqual(kwargs["expected_manifest_hash"], v2.manifest_digest(args[0]))
        self.assertEqual(set(kwargs), {"timeout", "codec_version", "expected_manifest_hash"})
        self.assertGreater(kwargs["timeout"], 0)
        self.assertLessEqual(kwargs["timeout"], 60)
        self.assertEqual(result["manifestHash"], kwargs["expected_manifest_hash"])
        self.assert_error("INVALID_STATE", lambda: self.run_input(session, client))

    def test_price_and_public_job_validation_before_rng_or_runner(self):
        changes = [{"price": 2}, {"salt": "private"}, {"status": "DRAFT"}, {"revision": True},
            {"revision": 64}, {"buyer": "other.testnet"}, {"profile": "unsupported"},
            {"roster": list(reversed(self.job["roster"]))}, {"contextHash": digest("wrong-context")},
            {"budgetCommitment": "00" * 32}, {"bidDeadlineNs": "01"}, {"closedAt": 1},
            {"selection": {"provider": self.provider}}, {"title": "<script>"}]
        with patch("service.bid_client.secrets.token_bytes") as rng:
            for altered in changes:
                with self.subTest(altered=altered):
                    self.assert_error("INVALID_BID_PREPARATION", lambda: self.prepare(job=dict(self.job, **altered)))
            for price in (0, -1, MAX_AMOUNT + 1, True, 3.0, "3", None):
                self.assert_error("INVALID_BID_PREPARATION", lambda: self.client.prepare(self.job, self.provider, price=price))
            for provider in ("buyer.testnet", "outside.testnet", "ALPHA.testnet", True):
                self.assert_error("INVALID_BID_PREPARATION", lambda: self.prepare(provider=provider))
            rng.assert_not_called()
        self.assertEqual(self.runner.calls, [])

    def test_program_artifact_and_config_pins_rechecked_at_prepare(self):
        for key in ("registryAccount", "networkDomainHash", "registryExecutor", "outputPolicyHash",
                    "mpcProgramHash", "specHash", "circuitHash", "upstream"):
            with self.subTest(key=key):
                job = copy.deepcopy(self.job)
                job["intent"][key] = "other.testnet" if key in ("registryAccount", "registryExecutor") else digest("tampered")
                if key != "upstream":
                    job["contextHash"] = v2.precommit_context(job["intent"])
                self.assert_error("INVALID_BID_PREPARATION", lambda: self.prepare(job=job))

    def test_published_bid_slots_known_commitments_and_deadline(self):
        for change in ("bool-slot", "provider", "missing", "own-existing", "duplicate", "bad-hash"):
            with self.subTest(change=change):
                job = copy.deepcopy(self.job)
                if change == "bool-slot":
                    job["bids"][0]["slot"] = True
                elif change == "provider":
                    job["bids"][0]["provider"] = job["roster"][1]
                elif change == "missing":
                    job["bids"].pop()
                elif change == "own-existing":
                    job["bids"][0]["commitment"] = digest("already-published")
                elif change == "duplicate":
                    job["bids"][1]["commitment"] = job["bids"][2]["commitment"] = digest("same")
                else:
                    job["bids"][1]["commitment"] = "AA" * 32
                self.assert_error("INVALID_BID_PREPARATION", lambda: self.prepare(job=job))
        with patch("service.bid_client.time.time_ns", return_value=int(self.job["bidDeadlineNs"])):
            self.assert_error("INVALID_BID_PREPARATION", self.prepare)

    def test_missing_verifier_transport_and_input_window_fail_before_transmission(self):
        for options in ({"plan_verifier": None}, {"port": None, "certificate_dir": None}):
            client = self.make_client(**options)
            session = self.prepare(client)
            self.assert_error("PRIVATE_INPUT_UNAVAILABLE", lambda: self.run_input(session, client))
            self.assertIsNotNone(client._sessions[session["id"]].salt)
        session = self.prepare()
        self.assert_error("INPUT_WINDOW_CLOSED", lambda: self.client.run_private_input(session["id"], evidence_hash=digest("evidence")))
        with patch("service.bid_client.time.time_ns", return_value=int(self.job["resultDeadlineNs"])):
            self.assert_error("INPUT_WINDOW_CLOSED", lambda: self.client.run_private_input(session["id"], evidence_hash=digest("evidence")))
        self.assertEqual(self.runner.calls, [])

    def test_no_request_transport_manifest_or_verification_assertion_overrides(self):
        session = self.prepare()
        for key in ("manifest", "host", "certificate_dir", "port", "runner", "verified", "unsafe_test_override"):
            with self.subTest(key=key), self.assertRaises(TypeError):
                self.client.run_private_input(session["id"], evidence_hash=digest("evidence"), **{key: "attacker"})
        for evidence in ("00" * 32, "AA" * 32, "https://attacker.example", {"verified": True}, True):
            self.assert_error("INVALID_EVIDENCE_HASH", lambda: self.client.run_private_input(session["id"], evidence_hash=evidence))
        self.assertNotIn("host", inspect.signature(BidClient).parameters)
        for result in ({"verified": True}, {"manifest": {}, "manifestHash": digest("fake")},
                       {"job": {}, "manifest": {}, "manifestHash": digest("fake"), "port": 12345}):
            client = self.make_client(plan_verifier=lambda *_: result)
            value = self.prepare(client)
            self.assert_error("PRIVATE_INPUT_FAILED", lambda: self.run_input(value, client))
        self.assertEqual(self.runner.calls, [])

    def test_all_four_commitments_exact_against_frozen_app_job(self):
        for slot in range(4):
            with self.subTest(slot=slot):
                def verifier(expected, evidence):
                    plan = make_plan(expected, evidence)
                    altered = copy.deepcopy(plan["job"])
                    if slot == 0:
                        altered["budgetCommitment"] = digest("replaced-budget")
                    else:
                        altered["bids"][slot - 1]["commitment"] = digest("replaced-bid")
                    # Self-consistent replacement registry bindings and digest
                    # still must not override the frozen app job's commitments.
                    replacement = plan_from_closed(altered)
                    plan["manifest"], plan["manifestHash"] = replacement["manifest"], replacement["manifestHash"]
                    return plan
                client = self.make_client(plan_verifier=verifier)
                session = self.prepare(client)
                self.assert_error("PRIVATE_INPUT_FAILED", lambda: self.run_input(session, client))
        self.assertEqual(self.runner.calls, [])

    def test_own_bid_and_previously_known_other_bid_cannot_change_even_with_consistent_plan(self):
        for slot in (1, 2):
            with self.subTest(slot=slot):
                job = copy.deepcopy(self.job)
                job["bids"][1]["commitment"] = digest("known-other")
                def verifier(expected, evidence):
                    plan = make_plan(expected, evidence)
                    plan["job"]["bids"][slot - 1]["commitment"] = digest("replacement")
                    return plan_from_closed(plan["job"])
                client = self.make_client(plan_verifier=verifier)
                session = self.prepare(client, job)
                self.assert_error("PRIVATE_INPUT_FAILED", lambda: self.run_input(session, client))
        self.assertEqual(self.runner.calls, [])

    def test_closed_app_identity_intent_and_revision_mismatch(self):
        for kind in ("id", "intent", "revision", "closedAt", "missing-bid", "budget", "round"):
            with self.subTest(kind=kind):
                def verifier(expected, evidence):
                    plan = make_plan(expected, evidence)
                    closed = plan["job"]
                    if kind == "id":
                        closed["id"] = "b" * 32
                    elif kind == "intent":
                        closed["intent"]["qualified"][0] = False
                        closed["contextHash"] = v2.precommit_context(closed["intent"])
                        return plan_from_closed(closed)
                    elif kind == "revision":
                        closed["revision"] = expected["job"]["revision"]
                    elif kind == "closedAt":
                        closed["closedAt"] = 0
                    elif kind == "missing-bid":
                        closed["bids"][1]["commitment"] = None
                    elif kind == "budget":
                        closed["budgetCommitment"] = digest("new-budget")
                        return plan_from_closed(closed)
                    else:
                        plan["manifest"]["selectionRound"] = digest("other-round")
                    return plan
                client = self.make_client(plan_verifier=verifier)
                session = self.prepare(client)
                self.assert_error("PRIVATE_INPUT_FAILED", lambda: self.run_input(session, client))
        self.assertEqual(self.runner.calls, [])

    def test_registry_job_binding_bidset_context_and_manifest_digest_mismatch(self):
        for kind in ("job-binding", "bidset-root", "context", "manifestHash", "zero-job-id", "attempt", "duplicate-bid"):
            with self.subTest(kind=kind):
                def verifier(expected, evidence):
                    plan = make_plan(expected, evidence)
                    manifest = plan["manifest"]
                    registry = manifest["closedJob"]
                    if kind == "job-binding":
                        registry["job_binding_hash"] = list(v2.hex32(digest("wrong-job")))
                    elif kind == "bidset-root":
                        registry["bidset_root"] = list(v2.hex32(digest("wrong-bidset")))
                    elif kind == "context":
                        registry["config"]["context_hash"] = list(v2.hex32(digest("wrong-context")))
                    elif kind == "manifestHash":
                        plan["manifestHash"] = digest("wrong-digest")
                    elif kind == "zero-job-id":
                        return plan_from_closed(plan["job"], registry_id="0")
                    elif kind == "attempt":
                        registry["attempt"] = "1"
                    else:
                        manifest["commitments"][2] = manifest["commitments"][3]
                    return plan
                client = self.make_client(plan_verifier=verifier)
                session = self.prepare(client)
                self.assert_error("PRIVATE_INPUT_FAILED", lambda: self.run_input(session, client))
        self.assertEqual(self.runner.calls, [])

    def test_corrupted_local_opening_never_sent(self):
        session = self.prepare()
        self.client._sessions[session["id"]].price += 1
        self.assert_error("PRIVATE_INPUT_FAILED", lambda: self.run_input(session))
        self.assertEqual(self.runner.calls, [])

    def test_no_retries_on_verifier_or_runner_failure_and_no_private_error_reflection(self):
        marker = "PRIVATE-PRICE-SALT-DO-NOT-EXPOSE"
        def failing(*args, **kwargs):
            raise RuntimeError(marker)
        for options in ({"plan_verifier": failing}, {"runner": failing}):
            client = self.make_client(**options)
            session = self.prepare(client)
            self.assert_error("PRIVATE_INPUT_FAILED", lambda: self.run_input(session, client))
            self.assert_error("INVALID_STATE", lambda: self.run_input(session, client))
            snapshot = client.snapshot(session["id"])
            self.assertEqual(snapshot["state"], "FAILED")
            self.assertNotIn(marker, json.dumps(snapshot))
            self.assertIsNone(client._sessions[session["id"]].salt)
            self.assertIsNone(client._sessions[session["id"]].price)

    def test_invalid_private_outputs_are_discarded_and_fail_closed(self):
        for output in ([True, self.price], [1, self.price - 1], [0, self.price], [2, 0],
                       {"price": self.price}, [1], [0, False]):
            with self.subTest(output=output):
                client = self.make_client(runner=lambda *args, **kwargs: output)
                session = self.prepare(client)
                self.assert_error("PRIVATE_INPUT_FAILED", lambda: self.run_input(session, client))
                self.assertNotIn("output", client.snapshot(session["id"]))
        client = self.make_client(runner=lambda *args, **kwargs: [0, 0])
        self.assertEqual(self.run_input(self.prepare(client), client)["state"], "INPUT_COMPLETE")

    def test_bounded_admission_duplicate_openings_terminal_eviction_and_close(self):
        client = self.make_client(max_sessions=1)
        session = self.prepare(client)
        self.assert_error("BID_ALREADY_PREPARED", lambda: self.prepare(client))
        other = published_job(self.config, "b" * 32)
        self.assert_error("SESSION_LIMIT", lambda: self.prepare(client, other))
        self.assertEqual(client.close_session(session["id"])["state"], "CLOSED")
        self.assertEqual(client.close_session(session["id"])["state"], "CLOSED")
        replacement = self.prepare(client, other)
        self.assertEqual(len(client._sessions), 1)
        self.assert_error("UNKNOWN_SESSION", lambda: client.snapshot(session["id"]))
        client.close()
        client.close()
        self.assertEqual(client.snapshot(replacement["id"])["state"], "CLOSED")
        self.assertIsNone(client._sessions[replacement["id"]].salt)
        self.assert_error("CLIENT_CLOSED", lambda: self.prepare(client))

    def test_ttl_expires_without_polling_and_releases_opening(self):
        client = self.make_client(timeout_seconds=0.03)
        session = self.prepare(client)
        secret = client._sessions[session["id"]]
        until = time.monotonic() + 1
        while secret.salt is not None and time.monotonic() < until:
            time.sleep(0.005)
        self.assertIsNone(secret.salt)
        self.assertIsNone(secret.price)
        self.assertEqual(client.snapshot(session["id"])["state"], "EXPIRED")
        self.assert_error("INVALID_STATE", lambda: self.run_input(session, client))

    def test_close_while_verifier_waits_prevents_any_secret_transmission(self):
        started, release = threading.Event(), threading.Event()
        def verifier(expected, evidence):
            started.set()
            if not release.wait(2):
                raise RuntimeError("test barrier unreleased")
            return make_plan(expected, evidence)
        client = self.make_client(plan_verifier=verifier)
        session = self.prepare(client)
        with ThreadPoolExecutor(max_workers=1) as callers:
            result = callers.submit(self.run_input, session, client)
            self.assertTrue(started.wait(1))
            try:
                self.assertEqual(client.close_session(session["id"])["state"], "CLOSED")
            finally:
                release.set()
            self.assert_error("PRIVATE_INPUT_FAILED", lambda: result.result(2))
        self.assertEqual(self.runner.calls, [])
        self.assertEqual(client.snapshot(session["id"])["state"], "CLOSED")

    def test_expiry_during_runner_blocks_replay_and_new_admission_until_runner_drains(self):
        started, release = threading.Event(), threading.Event()
        def runner(*args, **kwargs):
            started.set()
            if not release.wait(2):
                raise RuntimeError("test barrier unreleased")
            return [1, args[4]]
        client = self.make_client(timeout_seconds=0.06, max_sessions=1, runner=runner)
        session = self.prepare(client)
        with ThreadPoolExecutor(max_workers=1) as callers:
            result = callers.submit(self.run_input, session, client)
            self.assertTrue(started.wait(1))
            until = time.monotonic() + 1
            while client._sessions[session["id"]].public["state"] != "EXPIRED" and time.monotonic() < until:
                time.sleep(0.005)
            try:
                self.assertEqual(client.snapshot(session["id"])["state"], "EXPIRED")
                self.assert_error("INVALID_STATE", lambda: self.run_input(session, client))
                other = published_job(self.config, "b" * 32)
                self.assert_error("SESSION_LIMIT", lambda: self.prepare(client, other))
            finally:
                release.set()
            self.assert_error("PRIVATE_INPUT_FAILED", lambda: result.result(2))
        self.assertFalse(client._sessions[session["id"]].running)

    def test_three_provider_clients_can_enter_together_and_each_session_is_single_attempt(self):
        barrier = threading.Barrier(3)
        started = threading.Event()
        seen = []
        def runner(*args, **kwargs):
            seen.append(args[1])
            started.set()
            barrier.wait(2)
            return [0, 0]
        client = self.make_client(runner=runner)
        sessions = [self.prepare(client, provider=provider) for provider in self.job["roster"]]
        with patch("service.bid_client.time.time_ns", return_value=int(self.job["bidDeadlineNs"]) + 2 * 10**6):
            with ThreadPoolExecutor(max_workers=3) as callers:
                futures = [callers.submit(client.run_private_input, session["id"], evidence_hash=digest("evidence"))
                           for session in sessions]
                self.assertTrue(started.wait(1))
                results = [future.result(3) for future in futures]
        self.assertEqual(sorted(seen), [1, 2, 3])
        self.assertTrue(all(result["state"] == "INPUT_COMPLETE" for result in results))
        for session in sessions:
            self.assert_error("INVALID_STATE", lambda: self.run_input(session, client))

    def test_concurrent_prepare_only_one_opening_per_provider_job(self):
        barrier = threading.Barrier(2)
        def prepare():
            barrier.wait(1)
            try:
                return self.prepare()
            except BidClientError as error:
                return error.code
        with ThreadPoolExecutor(max_workers=2) as callers:
            results = list(callers.map(lambda _: prepare(), range(2)))
        self.assertEqual(sum(type(result) is dict for result in results), 1)
        self.assertIn("BID_ALREADY_PREPARED", results)
        self.assertEqual(len(self.client._sessions), 1)

    def test_reentrant_verifier_cannot_dispatch_or_shutdown_worker(self):
        def verifier(expected, evidence):
            self.assert_error("REENTRANT_CALL", lambda: client.run_private_input(session["id"], evidence_hash=evidence))
            self.assert_error("REENTRANT_CALL", client.close)
            return make_plan(expected, evidence)
        client = self.make_client(plan_verifier=verifier)
        session = self.prepare(client)
        self.assertEqual(self.run_input(session, client)["state"], "INPUT_COMPLETE")

    def test_configuration_validation_rejects_unbounded_or_arbitrary_transport(self):
        for options in ({"timeout_seconds": 1801}, {"timeout_seconds": float("nan")},
                {"timeout_seconds": True}, {"max_sessions": 17}, {"max_sessions": True},
                {"input_timeout_seconds": 601}, {"port": 80}, {"port": True},
                {"certificate_dir": "relative/path"}, {"certificate_dir": None}, {"plan_verifier": True}):
            with self.subTest(options=options), self.assertRaises((ValueError, TypeError)):
                self.make_client(**options)
        with self.assertRaises(ValueError):
            BidClient(None)
        symlink = self.root / "symlink"
        symlink.symlink_to(self.root, target_is_directory=True)
        with self.assertRaises(ValueError):
            self.make_client(certificate_dir=symlink)


if __name__ == "__main__":
    unittest.main()
