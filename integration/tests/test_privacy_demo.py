"""Offline control tests. Injected fixtures never establish real FHE/MPC/payment."""
import copy
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch

from integration import privacy_demo as demo

HASHES = ["1" * 31 + c for c in "ABCDEFGHJK"]


def summary():
    owner = demo.OWNER
    claim = {"job_id": "9", "attempt": "1", "context_hash": [1]*32,
             "job_binding_hash": [2]*32, "attempt_binding_hash": [3]*32, "output_hash": [4]*32}
    job = {"job_id": "9", "buyer": owner, "state": "Accepted", "attempt": "1",
           "selected_executor": "p2." + owner, "attempt_binding_version": 2,
           "config": {"context_hash": [1]*32}, "job_binding_hash": [2]*32,
           "attempt_binding_hash": [3]*32,
           "receipts": [{"status": "BuyerAccepted", "receipt_hash": [5]*32, "claim": claim}]}
    return {"completed": True, "synthetic_only": True, "real_fhe": True, "real_mpc": True,
        "actual_near_testnet": True, "network": "testnet", "contract_account": owner,
        "independent_operators": False, "execution_proof": False, "job_id": "9",
        "selected_executor": "p2." + owner, "accepted_job": job,
        "artifactHashes": {"outputSha256": "04"*32, "privateKey": "secret"},
        "checks": [{"name": "Node testnet driver exited cleanly", "pass": True, "stderr": "secret"}],
        "transactions": [{"command": "create_job", "hash": HASHES[0], "finality": "FINAL", "privateKey": "secret"}],
        "verified_synthetic_records": [{"id": n, "value": n+1, "duplicate": False} for n in range(4)],
        "privateKey": "secret"}


def handoff(binding):
    value = {key: getattr(binding, key) for key in ("registry_id", "registry_code_hash", "job_id", "buyer_id",
        "provider_id", "context_hash", "job_binding_hash", "attempt", "attempt_binding_hash", "receipt_hash", "output_hash")}
    value.update(network="testnet", escrow_id=demo.ESCROW, escrow_code_hash=demo.ESCROW_CODE,
        amount_yocto=str(demo.AMOUNT), finality="FINAL", state="Paid", fixed_demonstration_price=True,
        mpc_winning_price_proven=False, payout_amount_public=True, fund_hash=HASHES[1], release_hash=HASHES[2])
    return value


class PrivacyDemoTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.path = self.root / "runtime/privacy-demo-offline"
        self.proofs = self.root / "payments/testnet_escrow/verification"
        self.proofs.mkdir(parents=True)
        self.original = {}
        for name in demo.PAYMENT_FILES:
            self.original[name] = ("old job 3 proof " + name + "\n").encode()
            (self.proofs/name).write_bytes(self.original[name])
        for target, replacement in (("ROOT", self.root),):
            p = patch.object(demo, target, replacement); p.start(); self.addCleanup(p.stop)
        p = patch.dict(os.environ, {"NOPE_ENABLE_PRIVACY_DEMO": "1"}); p.start(); self.addCleanup(p.stop)
        p = patch("sdk.registry.verify_registry_job", return_value=True); p.start(); self.addCleanup(p.stop)

    def fake_integration(self, path):
        self.assertFalse(path.exists(), "existing testnet runner requires fresh output")
        path.mkdir()
        (path/"events.jsonl").write_text(json.dumps({"stage": "driver_stopped", "public": {"exit_code": 0}})+"\n")
        return summary()

    def verified(self, tx, binding):
        return {"state": "verified_nope_testnet_escrow_payout", "transaction_hash": tx,
                "amount_yocto": str(binding.amount_yocto), "privateKey": "secret"}

    def fake_payment(self, command, timeout):
        self.assertEqual(command[-3:], ["pay", "9", "--owner-lock-free"])
        self.assertEqual(timeout, 300)
        value = handoff(demo._binding(summary()))
        (self.proofs/"testnet-payout.json").write_text(json.dumps(value))

    def execute(self, on_event=None):
        with patch.object(demo, "_integration", side_effect=self.fake_integration), \
             patch.object(demo, "_preflight"), patch.object(demo, "_bounded", side_effect=self.fake_payment), \
             patch.object(demo.NearTestnetEscrowClient, "verify_release", side_effect=self.verified):
            return demo.run(self.path, on_event=on_event)

    def test_success_projection_events_and_exact_previous_proofs_restored(self):
        events = []
        value = self.execute(lambda stage, elapsed: events.append(stage))
        self.assertTrue(value["completed"])
        self.assertEqual(value["payment"]["amountYocto"], "1000000000000000000000")
        self.assertFalse(value["payment"]["mpcPriceProven"])
        self.assertEqual(value["transactions"][-1]["command"], "release")
        self.assertEqual(value["verified_synthetic_records"], summary()["verified_synthetic_records"])
        self.assertNotIn("secret", json.dumps(value))
        self.assertNotIn("privateKey", json.dumps(value))
        self.assertEqual(events, ["payment_started", "payment_verified", "completed"])
        self.assertEqual(len((self.path/"privacy-events.jsonl").read_text().splitlines()), 3)
        for name, raw in self.original.items():
            self.assertEqual((self.proofs/name).read_bytes(), raw)
            self.assertEqual((self.path/"payment-evidence-before"/name).read_bytes(), raw)
        self.assertTrue((self.path/"payment-verified.json").exists())

    def test_opt_in_and_bad_paths_do_not_invoke_runner(self):
        with patch.object(demo, "_integration") as runner:
            with patch.dict(os.environ, {"NOPE_ENABLE_PRIVACY_DEMO": "0"}):
                with self.assertRaisesRegex(demo.PrivacyDemoError, "OPT_IN"):
                    demo.run(self.path)
            for path in (self.root/"outside", self.path/"nested"):
                with self.assertRaisesRegex(demo.PrivacyDemoError, "DIRECT_CHILD"):
                    demo.run(path)
            runner.assert_not_called()

    def test_started_marker_survives_failure_without_output_and_blocks_restart(self):
        with patch.object(demo, "_integration", side_effect=RuntimeError("private secret")) as runner:
            for attempt in range(2):
                with self.assertRaises(demo.PrivacyDemoError) as error:
                    demo.run(self.path)
                self.assertNotIn("secret", str(error.exception))
            self.assertEqual(runner.call_count, 1)
        self.assertFalse(self.path.exists())
        self.assertTrue(self.path.with_suffix(".started.json").exists())

    def test_existing_output_never_resubmitted(self):
        self.execute()
        with patch.object(demo, "_integration") as runner:
            with self.assertRaises(demo.PrivacyDemoError): demo.run(self.path)
            runner.assert_not_called()

    def test_owner_lock_or_missing_driver_stop_prevents_payment(self):
        for lock_present in (False, True):
            with self.subTest(lock_present=lock_present):
                path = self.root/"runtime"/("privacy-demo-lock"+str(lock_present))
                def integration(p):
                    result = self.fake_integration(p)
                    if lock_present:
                        lock = self.root/"contracts/registry/deploy/runtime/near-testnet/operation.lock"
                        lock.parent.mkdir(parents=True); lock.write_text("")
                    else:
                        (p/"events.jsonl").write_text('{"stage":"accepted"}\n')
                    return result
                with patch.object(demo, "_integration", side_effect=integration), patch.object(demo, "_pay") as pay:
                    with self.assertRaises(demo.PrivacyDemoError): demo.run(path)
                    pay.assert_not_called()

    def test_binding_rejects_other_job_provider_claim_or_ciphertext(self):
        variants = []
        value = summary(); value["job_id"] = "10"; variants.append(value)
        value = summary(); value["selected_executor"] = "evil.testnet"; variants.append(value)
        value = summary(); value["artifactHashes"]["outputSha256"] = "ff"*32; variants.append(value)
        value = summary(); value["accepted_job"]["receipts"][-1]["claim"]["context_hash"] = [8]*32; variants.append(value)
        value = summary(); value["real_mpc"] = 1; variants.append(value)
        value = summary(); value["synthetic_only"] = False; variants.append(value)
        for value in variants:
            with self.subTest(value=value), self.assertRaises((ValueError, demo.PrivacyDemoError)):
                demo._binding(value)

    def test_handoff_exact_binding_fixed_amount_and_real_hash_controls(self):
        binding = demo._binding(summary())
        for key, change in (("job_id", "3"), ("provider_id", "p1."+demo.OWNER),
                            ("amount_yocto", "1"), ("output_hash", "ee"*32),
                            ("attempt", "2"), ("escrow_code_hash", HASHES[0]),
                            ("network", "mainnet"), ("release_hash", "not-a-hash"),
                            ("mpc_winning_price_proven", True)):
            value = handoff(binding); value[key] = change
            with self.subTest(key=key), self.assertRaises((ValueError, demo.PrivacyDemoError)):
                demo._validate_handoff(value, binding)

    def test_uncertain_client_still_restores_proofs_and_never_verifies(self):
        self.path.parent.mkdir(); self.path.mkdir()
        def failed(command, timeout):
            self.fake_payment(command, timeout)
            raise RuntimeError("secret transaction unknown")
        with patch.object(demo, "_bounded", side_effect=failed), \
             patch.object(demo.NearTestnetEscrowClient, "verify_release") as verify:
            with self.assertRaises(RuntimeError): demo._pay(self.path, demo._binding(summary()))
            verify.assert_not_called()
        self.assertTrue((self.path/"payment-handoff.json").exists())
        for name, raw in self.original.items(): self.assertEqual((self.proofs/name).read_bytes(), raw)

    def test_observer_failure_never_marks_complete_or_retries(self):
        with patch.object(demo, "_integration", side_effect=self.fake_integration), \
             patch.object(demo, "_preflight"), patch.object(demo, "_bounded", side_effect=self.fake_payment) as send, \
             patch.object(demo.NearTestnetEscrowClient, "verify_release", side_effect=RuntimeError("secret")):
            with self.assertRaises(demo.PrivacyDemoError): demo.run(self.path)
            self.assertEqual(send.call_count, 1)
        self.assertFalse((self.path/"privacy-result.json").exists())
        self.assertNotIn("secret", (self.path/"privacy-failure.json").read_text())

    def test_preflight_existing_hold_refuses_new_payment(self):
        with patch.object(demo, "accepted_registry"), \
             patch.object(demo.NearTestnetEscrowClient, "inspect", return_value={"hold": {"state": "Paid"}}):
            with self.assertRaisesRegex(demo.PrivacyDemoError, "EXISTING_PAYMENT"):
                demo._preflight(demo._binding(summary()))

    def test_callback_failure_does_not_trigger_financial_retry(self):
        def disconnected(*args): raise RuntimeError("disconnected UI")
        self.assertTrue(self.execute(disconnected)["completed"])

    def test_records_not_fabricated_and_strictly_shaped(self):
        value = summary(); del value["verified_synthetic_records"]
        self.assertIsNone(demo._records(value))
        value = summary(); value["verified_synthetic_records"][0]["privateKey"] = "secret"
        with self.assertRaises(demo.PrivacyDemoError): demo._records(value)

    def test_absent_previous_handoff_is_restored_to_absence(self):
        for name in demo.PAYMENT_FILES: (self.proofs/name).unlink()
        self.execute()
        for name in demo.PAYMENT_FILES: self.assertFalse((self.proofs/name).exists())

    def test_child_timeout_is_bounded_and_not_retried(self):
        before = __import__("time").monotonic()
        with self.assertRaises(subprocess.TimeoutExpired):
            demo._bounded([sys.executable, "-c", "import time;time.sleep(30)"], .05)
        self.assertLess(__import__("time").monotonic()-before, 3)

    def test_symlink_output_and_evidence_refused(self):
        self.path.parent.mkdir()
        self.path.symlink_to(self.root/"not-created")
        with self.assertRaises(demo.PrivacyDemoError): demo.run(self.path)
        self.path.unlink()
        original = self.proofs/demo.PAYMENT_FILES[0]; original.unlink(); original.symlink_to(self.root/"missing")
        self.path.mkdir()
        with self.assertRaises(OSError):
            with demo._preserve_payment_files(self.path): self.fail("unsafe evidence accepted")


if __name__ == "__main__":
    unittest.main()
