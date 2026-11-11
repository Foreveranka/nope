import hashlib
import json
import sqlite3
import subprocess
import sys
import tempfile
import threading
import unittest
from concurrent.futures import ThreadPoolExecutor
from dataclasses import replace
from pathlib import Path

from payments.adapter import PaymentAdapter
from payments.fixture import LocalFixtureRail
from payments.interface import Action, Command, Delivery, Money, Observation, State
from payments.model import Conflict, PaymentError, Unsupported, MAX_MICROS, parse_usdc
from payments.mcp import BlockedLiveRail
from payments.tests.support import ARTIFACT, SyntheticVerifier, make_binding, package


class LostResponseRail:
    mode = "local_fixture_simulation"

    def __init__(self, rail, action, effect=True, crash=False):
        self.rail, self.action, self.effect, self.crash = rail, action, effect, crash
        self.calls = 0

    def execute(self, command):
        self.calls += 1
        if command.action == self.action:
            if self.effect:
                self.rail.execute(command)
            if self.crash:
                raise KeyboardInterrupt("simulated crash after dispatch")
            raise TimeoutError("synthetic lost response")
        return self.rail.execute(command)

    def inspect(self, binding):
        return self.rail.inspect(binding)

    def lookup(self, command):
        return self.rail.lookup(command)


class PaymentTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name)
        self.rail = LocalFixtureRail(self.root / "rail.sqlite3")
        self.adapter = PaymentAdapter(self.root / "outbox.sqlite3", self.rail, SyntheticVerifier())
        self.binding = make_binding()
        self.delivery, self.artifact, self.receipt = package(self.binding)
        self.rail.register(self.binding)
        self.adapter.register(self.binding)

    def step(self, action, delivery=None, key=None):
        result = self.adapter.perform(key or action.value, action, self.binding, delivery)
        self.assertNotEqual(result.state, State.UNKNOWN)
        return result

    def held(self):
        self.step(Action.AWARD)
        self.step(Action.HOLD)

    def submitted(self):
        self.held()
        self.step(Action.SUBMIT, self.delivery)

    def verified(self):
        self.submitted()
        self.adapter.verify_artifact(self.binding, self.delivery, self.artifact, self.receipt)

    def accepted(self):
        self.verified()
        self.step(Action.ACCEPT, self.delivery)

    def test_exact_workflow_and_release_idempotence_after_restart(self):
        self.accepted()
        result = self.step(Action.RELEASE, self.delivery)
        self.adapter = PaymentAdapter(self.root / "outbox.sqlite3", self.rail, SyntheticVerifier())
        for _ in range(5):
            self.assertEqual(self.step(Action.RELEASE, self.delivery), result)
        self.assertEqual(self.rail.movement_count(self.binding, "release"), 1)
        self.assertEqual(self.adapter.state(self.binding).state, State.RELEASED)
        self.assertTrue(self.adapter.capabilities()["simulation"])
        self.assertFalse(self.adapter.capabilities()["live_payments"])

    def test_exact_micro_integer_parser(self):
        self.assertEqual(parse_usdc("80.000000000000"), Money(80000000))
        self.assertEqual(parse_usdc("0.000001").micros, 1)
        self.assertEqual(parse_usdc("9223372036854.775807").micros, MAX_MICROS)
        for value in [80.0, 80, True, "1e2", "-1", "+1", "NaN", " 1", "01", "1.", ".1", "0", "0.0000001", "9223372036854.775808"]:
            with self.subTest(value=value), self.assertRaises(PaymentError):
                parse_usdc(value)
        for money in [Money(1.0), Money(True), Money(-1), Money(1, "USD", 2)]:
            with self.subTest(money=money), self.assertRaises(PaymentError):
                self.adapter.register(replace(self.binding, price=money))

    def test_no_live_dispatch_even_with_transport(self):
        adapter = PaymentAdapter(self.root / "live.sqlite3", BlockedLiveRail())
        with self.assertRaises(Unsupported):
            adapter.register(self.binding)
        with self.assertRaises(Unsupported):
            BlockedLiveRail().execute(Command("award", Action.AWARD, self.binding))

    def test_wrong_binding_fields_and_idempotency_payload_conflict(self):
        self.step(Action.AWARD)
        replacements = {"context_hash": "d" * 64, "attempt_id": "attempt-2", "job_id": "other-job",
                        "bid_id": "other-bid", "assignment_id": "other-assignment", "worker_id": "other-worker",
                        "terms_hash": "e" * 64, "selection_hash": "f" * 64, "price": Money(80000001)}
        for field, value in replacements.items():
            with self.subTest(field=field), self.assertRaises(Conflict):
                self.adapter.perform("hold-wrong", Action.HOLD, replace(self.binding, **{field: value}))
        with self.assertRaises(Conflict):
            self.adapter.perform("award", Action.HOLD, self.binding)
        with self.assertRaises(Conflict):
            self.adapter.register(replace(self.binding, price=Money(1)))
        with self.assertRaises(Conflict):
            self.adapter.register(replace(self.binding, assignment_id="another-assignment"))

    def test_lost_response_each_mutation_reconciles_without_redispatch(self):
        for action in Action:
            if action in (Action.REFUND, Action.DISPUTE):
                continue
            with self.subTest(action=action):
                # Independent durable files for each scenario.
                rail = LocalFixtureRail(self.root / (action.value + "-rail.db"))
                wrapped = LostResponseRail(rail, action)
                adapter = PaymentAdapter(self.root / (action.value + "-adapter.db"), wrapped, SyntheticVerifier())
                rail.register(self.binding)
                adapter.register(self.binding)
                for prior in [Action.AWARD, Action.HOLD, Action.SUBMIT, Action.ACCEPT, Action.RELEASE]:
                    if prior == Action.ACCEPT:
                        adapter.verify_artifact(self.binding, self.delivery, self.artifact, self.receipt)
                    arg = self.delivery if prior in (Action.SUBMIT, Action.ACCEPT, Action.RELEASE) else None
                    outcome = adapter.perform(prior.value, prior, self.binding, arg)
                    if prior == action:
                        self.assertEqual(outcome.state, State.UNKNOWN)
                        count = wrapped.calls
                        for _ in range(3):
                            self.assertEqual(adapter.perform(prior.value, prior, self.binding, arg).state, State.UNKNOWN)
                        self.assertEqual(wrapped.calls, count)
                        with self.assertRaises(Conflict):
                            adapter.perform("new-op-id", prior, self.binding, arg)
                        adapter = PaymentAdapter(self.root / (action.value + "-adapter.db"), wrapped, SyntheticVerifier())
                        recovered = adapter.reconcile(prior.value)
                        self.assertNotEqual(recovered.state, State.UNKNOWN)
                        self.assertEqual(wrapped.calls, count)
                        break
                self.assertLessEqual(rail.movement_count(self.binding, "release"), 1)

    def test_timeout_without_effect_is_not_refund_or_retry_authority(self):
        self.held()
        wrapped = LostResponseRail(self.rail, Action.REFUND, effect=False)
        self.adapter.rail = wrapped
        outcome = self.adapter.perform("refund-lost", Action.REFUND, self.binding)
        self.assertEqual(outcome.state, State.UNKNOWN)
        for _ in range(3):
            self.assertEqual(self.adapter.reconcile("refund-lost").state, State.UNKNOWN)
        self.assertEqual(self.rail.inspect(self.binding).state, State.HELD)
        self.assertEqual(self.rail.movement_count(self.binding, "refund"), 0)
        self.assertEqual(wrapped.calls, 1)
        with self.assertRaises(Conflict):
            self.adapter.perform("new-refund", Action.REFUND, self.binding)

    def test_confirmed_refund_lost_response_and_terminal_no_release(self):
        self.held()
        self.adapter.rail = LostResponseRail(self.rail, Action.REFUND)
        self.assertEqual(self.adapter.perform("refund", Action.REFUND, self.binding).state, State.UNKNOWN)
        self.assertEqual(self.adapter.reconcile("refund").state, State.REFUNDED)
        self.assertEqual(self.rail.movement_count(self.binding, "refund"), 1)
        with self.assertRaises(Conflict):
            self.adapter.perform("release", Action.RELEASE, self.binding, self.delivery)

    def test_process_crash_leaves_recoverable_sent_operation(self):
        self.accepted()
        self.adapter.rail = LostResponseRail(self.rail, Action.RELEASE, crash=True)
        with self.assertRaises(KeyboardInterrupt):
            self.adapter.perform("release", Action.RELEASE, self.binding, self.delivery)
        self.adapter = PaymentAdapter(self.root / "outbox.sqlite3", self.rail, SyntheticVerifier())
        self.assertEqual(self.adapter.state(self.binding).state, State.UNKNOWN)
        self.assertEqual(self.adapter.perform("release", Action.RELEASE, self.binding, self.delivery).state, State.UNKNOWN)
        self.assertEqual(self.adapter.reconcile("release").state, State.RELEASED)
        self.assertEqual(self.rail.movement_count(self.binding, "release"), 1)

    def test_acceptance_requires_exact_verified_bytes_and_policy(self):
        self.submitted()
        with self.assertRaises(Conflict):
            self.step(Action.ACCEPT, self.delivery)
        for artifact, receipt in [(b"wrong", self.receipt), (self.artifact, b"wrong")]:
            with self.assertRaises(Conflict):
                self.adapter.verify_artifact(self.binding, self.delivery, artifact, receipt)
        self.adapter.verifier = None
        with self.assertRaises(Unsupported):
            self.adapter.verify_artifact(self.binding, self.delivery, self.artifact, self.receipt)
        class FalsePolicy:
            def verify(self, *args):
                return False
        self.adapter.verifier = FalsePolicy()
        with self.assertRaises(Conflict):
            self.adapter.verify_artifact(self.binding, self.delivery, self.artifact, self.receipt)
        self.assertEqual(self.rail.movement_count(self.binding, "release"), 0)

    def test_real_hmac_detects_forgery_even_if_receipt_hash_matches(self):
        self.held()
        envelope = json.loads(self.receipt)
        envelope["body"]["binding_hash"] = "0" * 64
        forged = json.dumps(envelope).encode()
        wrong = replace(self.delivery, receipt_sha256=hashlib.sha256(forged).hexdigest())
        self.step(Action.SUBMIT, wrong)
        with self.assertRaises(Conflict):
            self.adapter.verify_artifact(self.binding, wrong, self.artifact, forged)

    def test_stale_version_cannot_accept_or_release(self):
        self.verified()
        next_delivery, artifact, receipt = package(self.binding, 2)
        self.step(Action.SUBMIT, next_delivery, "submit-v2")
        for version in (self.delivery, next_delivery):
            with self.assertRaises(Conflict):
                self.adapter.perform("accept-stale", Action.ACCEPT, self.binding, version)
        self.adapter.verify_artifact(self.binding, next_delivery, artifact, receipt)
        self.step(Action.ACCEPT, next_delivery)
        with self.assertRaises(Conflict):
            self.adapter.perform("release-wrong-version", Action.RELEASE, self.binding, self.delivery)
        self.step(Action.RELEASE, next_delivery)

    def test_disputed_and_remote_stale_result_never_release(self):
        self.verified()
        self.step(Action.DISPUTE, self.delivery)
        for action in (Action.ACCEPT, Action.RELEASE):
            with self.assertRaises(Conflict):
                self.adapter.perform(action.value, action, self.binding, self.delivery)
        self.assertEqual(self.rail.movement_count(self.binding, "release"), 0)

    def test_remote_dispute_blocks_verified_acceptance(self):
        self.verified()
        current = self.rail.inspect(self.binding)
        self.rail.execute(Command("remote-dispute", Action.DISPUTE, self.binding, self.delivery, current.revision))
        with self.assertRaises(Conflict):
            self.adapter.perform("accept", Action.ACCEPT, self.binding, self.delivery)
        self.assertEqual(self.rail.movement_count(self.binding, "release"), 0)

    def test_remote_resubmission_blocks_old_verification(self):
        self.verified()
        current = self.rail.inspect(self.binding)
        newer, _, _ = package(self.binding, 2)
        self.rail.execute(Command("remote-submit", Action.SUBMIT, self.binding, newer, current.revision))
        with self.assertRaises(Conflict):
            self.adapter.perform("accept", Action.ACCEPT, self.binding, self.delivery)

    def test_atomic_revision_check_closes_simulated_read_write_race(self):
        self.verified()
        original = self.rail.execute
        def raced(command):
            current = self.rail.inspect(command.binding)
            original(Command("racing-dispute", Action.DISPUTE, command.binding, self.delivery, current.revision))
            return original(command)
        self.rail.execute = raced
        self.assertEqual(self.adapter.perform("accept", Action.ACCEPT, self.binding, self.delivery).state, State.UNKNOWN)
        self.assertEqual(self.rail.inspect(self.binding).state, State.DISPUTED)
        self.assertEqual(self.rail.movement_count(self.binding, "release"), 0)

    def test_wrong_response_is_unknown_and_never_confirms_payment(self):
        self.accepted()
        original = self.rail.execute
        def malformed(command):
            result = original(command)
            return replace(result, binding=replace(self.binding, context_hash="e" * 64))
        self.rail.execute = malformed
        self.assertEqual(self.adapter.perform("release", Action.RELEASE, self.binding, self.delivery).state, State.UNKNOWN)
        self.assertEqual(self.adapter.reconcile("release").state, State.RELEASED)
        self.assertEqual(self.rail.movement_count(self.binding, "release"), 1)

    def test_concurrent_same_release_only_one_movement(self):
        self.accepted()
        barrier = threading.Barrier(8)
        def release(_):
            barrier.wait()
            adapter = PaymentAdapter(self.root / "outbox.sqlite3", self.rail, SyntheticVerifier())
            return adapter.perform("release", Action.RELEASE, self.binding, self.delivery)
        with ThreadPoolExecutor(max_workers=8) as pool:
            results = list(pool.map(release, range(8)))
        self.assertTrue(all(r.state in (State.UNKNOWN, State.RELEASED) for r in results))
        self.assertEqual(self.adapter.reconcile("release").state, State.RELEASED)
        self.assertEqual(self.rail.movement_count(self.binding, "release"), 1)

    def test_concurrent_different_release_ids_cannot_double_spend(self):
        self.accepted()
        def release(index):
            try:
                return self.adapter.perform("release-" + str(index), Action.RELEASE, self.binding, self.delivery)
            except Conflict:
                return None
        with ThreadPoolExecutor(max_workers=8) as pool:
            list(pool.map(release, range(8)))
        self.assertEqual(self.rail.movement_count(self.binding, "release"), 1)

    def test_out_of_order_reconciliation_keeps_latest_dispute(self):
        self.held()
        self.adapter.rail = LostResponseRail(self.rail, Action.SUBMIT)
        self.adapter.perform("submit", Action.SUBMIT, self.binding, self.delivery)
        current = self.rail.inspect(self.binding)
        self.rail.execute(Command("remote-dispute", Action.DISPUTE, self.binding, self.delivery, current.revision))
        self.assertEqual(self.adapter.reconcile("submit").state, State.SUBMITTED)
        self.assertEqual(self.adapter.state(self.binding).state, State.DISPUTED)
        with self.assertRaises(Conflict):
            self.adapter.perform("accept", Action.ACCEPT, self.binding, self.delivery)

    def test_no_plaintext_or_receipt_bytes_persisted(self):
        self.verified()
        for path in (self.root / "rail.sqlite3", self.root / "outbox.sqlite3"):
            db = sqlite3.connect(str(path))
            try:
                dump = "\n".join(db.iterdump())
            finally:
                db.close()
            self.assertNotIn(self.artifact.decode(), dump)
            self.assertNotIn(self.receipt.decode(), dump)

    def test_actual_child_process_exit_after_release_before_outbox_commit(self):
        self.accepted()
        script = """
import os, sys
from pathlib import Path
from payments.adapter import PaymentAdapter
from payments.fixture import LocalFixtureRail
from payments.interface import Action
from payments.synthetic import SyntheticVerifier, make_binding, package
root = Path(sys.argv[1])
rail = LocalFixtureRail(root / 'rail.sqlite3')
original = rail.execute
def crash(command):
    original(command)
    os._exit(73)
rail.execute = crash
adapter = PaymentAdapter(root / 'outbox.sqlite3', rail, SyntheticVerifier())
binding = make_binding()
delivery, _, _ = package(binding)
adapter.perform('release-child', Action.RELEASE, binding, delivery)
"""
        child = subprocess.run([sys.executable, "-c", script, str(self.root)],
                               cwd=str(Path(__file__).resolve().parents[2]), capture_output=True, timeout=20)
        self.assertEqual(child.returncode, 73, child.stderr.decode())
        self.assertEqual(self.adapter.state(self.binding).state, State.UNKNOWN)
        self.assertEqual(self.adapter.reconcile("release-child").state, State.RELEASED)
        self.assertEqual(self.rail.movement_count(self.binding, "release"), 1)

    def test_actual_processes_share_durable_release_lock(self):
        self.accepted()
        script = """
import sys
from pathlib import Path
from payments.adapter import PaymentAdapter
from payments.fixture import LocalFixtureRail
from payments.interface import Action
from payments.synthetic import SyntheticVerifier, make_binding, package
root = Path(sys.argv[1])
rail = LocalFixtureRail(root / 'rail.sqlite3')
adapter = PaymentAdapter(root / 'outbox.sqlite3', rail, SyntheticVerifier())
binding = make_binding()
delivery, _, _ = package(binding)
result = adapter.perform('release-processes', Action.RELEASE, binding, delivery)
print(result.state.value)
"""
        processes = [subprocess.Popen([sys.executable, "-c", script, str(self.root)],
                                      cwd=str(Path(__file__).resolve().parents[2]),
                                      stdout=subprocess.PIPE, stderr=subprocess.PIPE) for _ in range(4)]
        try:
            for process in processes:
                output, error = process.communicate(timeout=20)
                self.assertEqual(process.returncode, 0, error.decode())
                self.assertIn(output.strip(), (b"unknown", b"released"))
        finally:
            for process in processes:
                if process.poll() is None:
                    process.kill()
                    process.wait()
        self.assertEqual(self.adapter.reconcile("release-processes").state, State.RELEASED)
        self.assertEqual(self.rail.movement_count(self.binding, "release"), 1)

    def test_refresh_adopts_dispute_but_never_unblocks_unknown(self):
        self.verified()
        current = self.rail.inspect(self.binding)
        self.rail.execute(Command("remote-dispute", Action.DISPUTE, self.binding, self.delivery, current.revision))
        self.assertEqual(self.adapter.refresh(self.binding).state, State.DISPUTED)
        with self.assertRaises(Conflict):
            self.adapter.perform("accept", Action.ACCEPT, self.binding, self.delivery)

    def test_refresh_does_not_infer_absent_operation_failed(self):
        self.held()
        self.adapter.rail = LostResponseRail(self.rail, Action.REFUND, effect=False)
        self.adapter.perform("refund", Action.REFUND, self.binding)
        self.assertEqual(self.adapter.refresh(self.binding).state, State.UNKNOWN)
        self.assertEqual(self.rail.inspect(self.binding).state, State.HELD)

    def test_refresh_rejects_reordered_and_contradictory_observations(self):
        self.accepted()
        original = self.rail.inspect
        stale = replace(original(self.binding), state=State.SUBMITTED, revision=3)
        self.rail.inspect = lambda binding: stale
        with self.assertRaises(Conflict):
            self.adapter.refresh(self.binding)
        conflicting = replace(stale, revision=4)
        self.rail.inspect = lambda binding: conflicting
        with self.assertRaises(Conflict):
            self.adapter.refresh(self.binding)

    def test_late_timeout_preserves_concurrently_reconciled_operation_outcome(self):
        self.held()
        original = self.rail.execute
        adapter = self.adapter
        def late_timeout(command):
            result = original(command)
            if command.action == Action.SUBMIT:
                adapter.reconcile(command.operation_id)
                adapter.verify_artifact(self.binding, self.delivery, self.artifact, self.receipt)
                adapter.perform("concurrent-accept", Action.ACCEPT, self.binding, self.delivery)
                raise TimeoutError("late timeout after another caller reconciled submit")
            return result
        self.rail.execute = late_timeout
        result = self.adapter.perform("submit", Action.SUBMIT, self.binding, self.delivery)
        self.assertEqual(result.state, State.SUBMITTED)
        self.assertEqual(self.adapter.state(self.binding).state, State.ACCEPTED)
        self.assertEqual(self.adapter.perform("submit", Action.SUBMIT, self.binding, self.delivery), result)

    def test_invalid_versions_and_missing_delivery_rejected(self):
        self.held()
        for version in (True, 1.0, 0, -1, 2):
            with self.subTest(version=version), self.assertRaises(PaymentError):
                self.adapter.perform("submit", Action.SUBMIT, self.binding, replace(self.delivery, version=version))
        with self.assertRaises(PaymentError):
            self.adapter.perform("submit", Action.SUBMIT, self.binding)


if __name__ == "__main__":
    unittest.main()
