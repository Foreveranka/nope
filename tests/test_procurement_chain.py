"""Offline bridge tests. All registry/transaction evidence and signers are DOUBLES.

No RPC, native signer, broadcast, private wallet read or actual chain success.
The temporary owner tree contains a dummy key file whose contents are not read.
"""
import base64
import copy
import json
import os
import sqlite3
import sys
import tempfile
import threading
import time
import unittest
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

from engine.protocol import artifact_pins, canonical_json, sha256
from mpc import v2
from mpc.auction import UPSTREAM
from service import procurement_chain as chain
from service.procurement_client import ProcurementConfig, ProcurementClientError


def digest(label):
    return sha256(("EXPLICIT-CHAIN-TEST-DOUBLE:" + label).encode())


def chain_digest(label):
    return chain._base58(bytes.fromhex(digest(label)))


def fixture(config, identity="a" * 32):
    now = time.time_ns()
    pins = artifact_pins(config.artifact_set)
    intent = v2.build_intent(network_domain_hash=config.network_domain_hash,
        registry_account=config.registry_account, buyer=config.registry_account,
        roster=["alpha.testnet", "beta.testnet", "gamma.testnet"], qualified=[True] * 3,
        fixed_fee=0, bid_deadline_ns=str(now + 300 * 10**9), result_deadline_ns=str(now + 1200 * 10**9),
        spec_hash=pins["client-specs.json"], circuit_hash=pins["server.zip"],
        key_hash=digest("evaluation-key"), input_hash=digest("encrypted-input"),
        output_policy_hash=config.output_policy_hash, registry_executor=config.registry_executor)
    job = {"id": identity, "title": "Public synthetic publication", "profile": "clean-4-records-v1",
        "buyer": config.registry_account, "roster": intent["roster"], "bidDeadlineNs": intent["bidDeadlineNs"],
        "resultDeadlineNs": intent["resultDeadlineNs"], "status": "PUBLISHED", "revision": 1,
        "createdAt": now // 10**6, "updatedAt": now // 10**6, "ledger": "app", "blockchainBinding": "pending",
        "intent": intent, "contextHash": v2.precommit_context(intent), "budgetCommitment": digest("budget-commitment"),
        "bids": [{"provider": provider, "slot": n, "commitment": None} for n, provider in enumerate(intent["roster"], 1)],
        "closedAt": None, "selection": None, "deliveries": [], "decision": None}
    expected = {"id": "b" * 32, "draftId": job["id"], "intent": copy.deepcopy(intent),
                "contextHash": job["contextHash"], "budgetCommitment": job["budgetCommitment"]}
    return job, expected


def evidence(job, pins):
    """Fabricated full FINAL receipt tree for testing strict structural checks only."""
    registry = {"job_id": "7", "buyer": pins["owner"], "config": chain._config(job),
        "state": "Open", "attempt": "0", "bidset_root": None, "closed_at_ns": None,
        "attempt_binding_hash": None, "selected_executor": None, "attempt_binding_version": None,
        "receipts": [], "bids": [{"bidder": provider, "commitment": None} for provider in job["roster"]]}
    registry["job_binding_hash"] = list(v2.hex32(v2.registry_job_hash(job["intent"], registry)))
    tx_hash, receipt_hash = chain_digest("tx-" + job["id"]), chain_digest("receipt-" + job["id"])
    blocks = [chain_digest("block" + str(n)) for n in range(3)]
    success = {"SuccessValue": base64.b64encode(canonical_json(registry)).decode()}
    transaction = {"final_execution_status": "FINAL", "status": success,
        "transaction": {"hash": tx_hash, "signer_id": pins["owner"], "receiver_id": pins["owner"],
            "public_key": pins["publicKey"], "actions": [{"FunctionCall": {"method_name": "create_job",
                "args": base64.b64encode(canonical_json({"config": registry["config"]})).decode(),
                "gas": 50_000_000_000_000, "deposit": "0"}}]},
        "transaction_outcome": {"id": tx_hash, "block_hash": blocks[0], "outcome": {
            "executor_id": pins["owner"], "receipt_ids": [receipt_hash], "status": {"SuccessReceiptId": receipt_hash}}},
        "receipts_outcome": [{"id": receipt_hash, "block_hash": blocks[1], "outcome": {
            "executor_id": pins["owner"], "receipt_ids": [], "status": success}}]}
    def view(value):
        return {"value": value, "block_hash": blocks[2], "block_height": 12}
    return {"kind": "FINAL_EVIDENCE", "network": "testnet", "rpc": chain._RPC,
        "registryAccount": pins["owner"], "publicKey": pins["publicKey"], "codeHash": pins["codeHash"],
        "journalTransactionHash": tx_hash, "transaction": transaction,
        "status": {"chain_id": "testnet", "sync_info": {"syncing": False}},
        "account": {"code_hash": pins["codeHash"], "block_hash": blocks[2], "block_height": 12},
        "owner": view(pins["owner"]), "domain": view(list(v2.hex32(chain._DOMAIN))), "view": view(registry),
        "blocks": [{"header": {"hash": block, "height": n + 10}} for n, block in enumerate(blocks)]}


class DriverDouble:
    def __init__(self, pins):
        self.pins, self.calls = pins, []
        self.fail_publish = False
        self.no_journal = False
        self.mutate = lambda value: value

    def publish(self, job):
        self.calls.append(("publish", copy.deepcopy(job)))
        if self.fail_publish:
            raise RuntimeError("PRIVATE-ERROR-MARKER")
        return self.mutate(evidence(job, self.pins))

    def reconcile(self, job):
        self.calls.append(("reconcile", copy.deepcopy(job)))
        return {"kind": "NO_JOURNAL"} if self.no_journal else self.mutate(evidence(job, self.pins))


class ChainTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name).resolve()
        self.repo = self.root / "owner-repo"
        deploy = self.repo / "contracts/registry/deploy"
        public_key = "ed25519:" + chain_digest("public-key")
        owner = "veil-reg-" + sha256(public_key.encode())[:16] + ".testnet"
        code = chain_digest("wasm")
        self.pins = {"owner": owner, "publicKey": public_key, "codeHash": code, "networkDomainHash": chain._DOMAIN}
        files = {"evidence/identity.json": {"network": "testnet", "account_id": owner, "public_key": public_key},
            "evidence/deployment.json": {"network": "testnet", "account_id": owner, "code_hash": code},
            "artifact-lock.json": {"sha256": digest("wasm")}, "node_modules/near-api-js/package.json": {}}
        for name, value in files.items():
            path = deploy / name
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_bytes(canonical_json(value))
        for name in ("procurement.mjs", "policy.mjs", "transport.mjs", "storage.mjs", "registry.mjs"):
            (deploy / name).write_text("// EXPLICIT OFFLINE TEST TREE, NOT A SIGNER\n")
        self.key = deploy / "runtime/near-testnet/identity.json"
        self.key.parent.mkdir(parents=True)
        self.key.write_text("EXPLICIT-TEST-ONLY-NOT-A-PRIVATE-KEY")
        self.key.chmod(0o600)
        self.config = ProcurementConfig(owner, chain._DOMAIN, owner, digest("policy"), v2.program_hash(), UPSTREAM)
        self.job, self.expected = fixture(self.config)
        self.driver = DriverDouble(self.pins)
        self.bridge = self.make_bridge()
        blocked = patch("subprocess.run", side_effect=AssertionError("real process forbidden in unit tests"))
        blocked.start()
        self.addCleanup(blocked.stop)
        sockets = patch("socket.create_connection", side_effect=AssertionError("network forbidden in unit tests"))
        sockets.start()
        self.addCleanup(sockets.stop)

    def make_bridge(self, directory="journal", driver=None):
        return chain.ProcurementChainBridge(self.root / directory, self.config, relay_root=self.repo,
            node_executable=sys.executable, test_driver=self.driver if driver is None else driver)

    def assert_error(self, code, fn):
        with self.assertRaises(ProcurementClientError) as raised:
            fn()
        self.assertEqual(raised.exception.code, code)
        self.assertEqual(str(raised.exception), code)

    def test_disabled_environment_does_not_touch_paths_process_or_journal(self):
        with patch.dict(os.environ, {}, clear=True), patch.object(chain, "_pins") as pins:
            self.assertIsNone(chain.from_env(self.root / "not-created", self.config))
            pins.assert_not_called()
            self.assertFalse((self.root / "not-created").exists())
        with patch.dict(os.environ, {"NOPE_ENABLE_TESTNET_RELAY": "1"}, clear=True):
            self.assert_error("CHAIN_RELAY_ROOT_REQUIRED", lambda: chain.from_env(self.root, self.config))

    def test_explicit_config_and_owner_metadata_rejected_without_private_contents(self):
        with patch.dict(os.environ, {"NOPE_ENABLE_TESTNET_RELAY": "1", "NOPE_TESTNET_RELAY_ROOT": str(self.repo),
                                   "NOPE_TESTNET_NODE": sys.executable}, clear=True):
            with patch.object(chain, "read_regular", wraps=chain.read_regular) as reads:
                bridge = chain.from_env(self.root / "runtime", self.config)
            self.assertTrue(bridge.capabilities()["enabled"])
            self.assertFalse(any(Path(call.args[0]) == self.key for call in reads.call_args_list))
        self.key.chmod(0o644)
        self.assert_error("CHAIN_RELAY_CONFIGURATION_INVALID", lambda: self.make_bridge("bad"))

    def test_exact_prepared_context_and_final_binding_only_once(self):
        result = self.bridge.publish(self.job, self.expected)
        self.assertEqual(result["state"], "BOUND")
        self.assertEqual(result["finalExecutionStatus"], "FINAL")
        self.assertEqual(result["scope"], "testnet-registry-publication-only")
        self.assertEqual(result["registryJobId"], "7")
        self.assertEqual(result["applicationJobId"], self.job["id"])
        self.assertEqual(result["localSessionId"], self.expected["id"])
        self.assertEqual(result["evidenceMode"], "test-double")
        self.assertFalse(result["selectionExecuted"])
        self.assertFalse(result["paymentExecuted"])
        self.assertFalse(result["retryAllowed"])
        self.assertEqual(self.bridge.status(self.job["id"]), result)
        self.assertEqual(self.bridge.publish(self.job, self.expected), result)
        self.assertEqual([name for name, _ in self.driver.calls], ["publish"])
        self.assertEqual(set(self.driver.calls[0][1]), {"id", "status", "buyer", "roster", "bidDeadlineNs",
            "resultDeadlineNs", "intent", "contextHash", "budgetCommitment"})

    def test_session_context_owner_unknown_keys_rejected_before_journal_or_driver(self):
        edits = [lambda j,e: e.update(id="../wallet"), lambda j,e: e.update(draftId="f" * 32),
            lambda j,e: e.update(budgetCommitment=digest("different")), lambda j,e: e.update(contextHash=digest("different")),
            lambda j,e: e.update(price=5), lambda j,e: e.update(privateInput={"price": 5}),
            lambda j,e: e["intent"].update(fixedFee=1), lambda j,e: j.update(buyer="other.testnet"),
            lambda j,e: j.update(status="DRAFT"), lambda j,e: j.update(budget=123),
            lambda j,e: j.update(roster=list(reversed(j["roster"])))]
        for edit in edits:
            j,e = copy.deepcopy(self.job), copy.deepcopy(self.expected)
            edit(j,e)
            self.assert_error("CHAIN_PUBLICATION_MISMATCH", lambda: self.bridge.publish(j,e))
        self.assertEqual(self.driver.calls, [])
        self.assert_error("CHAIN_JOB_UNKNOWN", lambda: self.bridge.status(self.job["id"]))

    def test_restart_reconciliation_after_lost_submit_reply_is_read_only(self):
        self.driver.fail_publish = True
        self.assert_error("CHAIN_OUTCOME_UNKNOWN", lambda: self.bridge.publish(self.job, self.expected))
        restarted = self.make_bridge()
        result = restarted.status(self.job["id"])
        self.assertEqual(result["state"], "BOUND")
        self.assertEqual([name for name,_ in self.driver.calls], ["publish", "reconcile"])
        self.assertNotIn("PRIVATE-ERROR", json.dumps(result))
        self.assertEqual(restarted.publish(self.job, self.expected), result)
        self.assertEqual(len(self.driver.calls), 2)

    def test_no_node_journal_or_unknown_finality_never_authorizes_resubmission(self):
        self.driver.fail_publish = self.driver.no_journal = True
        self.assert_error("CHAIN_OUTCOME_UNKNOWN", lambda: self.bridge.publish(self.job, self.expected))
        restarted = self.make_bridge()
        result = restarted.status(self.job["id"])
        self.assertEqual(result["state"], "UNKNOWN")
        self.assertNotIn("finalExecutionStatus", result)
        self.assertNotIn("transactionHash", result)
        self.assert_error("CHAIN_OUTCOME_UNKNOWN", lambda: restarted.publish(self.job, self.expected))
        self.assertEqual([name for name,_ in self.driver.calls], ["publish", "reconcile", "reconcile"])

    def test_concurrent_process_instances_claim_once_before_dispatch(self):
        started, release = threading.Event(), threading.Event()
        driver = self.driver
        def publish(job):
            driver.calls.append(("publish", copy.deepcopy(job)))
            # The durable row must exist before a signer can be dispatched.
            with self.bridge._db.connect() as db:
                self.assertEqual(db.execute("SELECT state FROM procurement_publications").fetchone()[0], "SUBMITTING")
            started.set()
            if not release.wait(2):
                raise AssertionError("test barrier not released")
            return evidence(job, self.pins)
        driver.publish = publish
        driver.no_journal = True
        other = self.make_bridge()
        with ThreadPoolExecutor(max_workers=1) as pool:
            first = pool.submit(self.bridge.publish, self.job, self.expected)
            self.assertTrue(started.wait(1))
            try:
                self.assert_error("CHAIN_OUTCOME_UNKNOWN", lambda: other.publish(self.job, self.expected))
            finally:
                release.set()
            self.assertEqual(first.result(2)["state"], "BOUND")
        self.assertEqual([name for name,_ in driver.calls].count("publish"), 1)

    def test_same_app_different_session_or_context_and_duplicate_context_are_conflicts(self):
        self.bridge.publish(self.job, self.expected)
        self.assert_error("CHAIN_PUBLICATION_CONFLICT", lambda: self.bridge.publish(
            self.job, dict(self.expected, id="c" * 32)))
        changed, expected = copy.deepcopy(self.job), copy.deepcopy(self.expected)
        changed["intent"]["intentNonce"] = digest("new-nonce")
        changed["contextHash"] = v2.precommit_context(changed["intent"])
        expected.update(intent=changed["intent"], contextHash=changed["contextHash"])
        self.assert_error("CHAIN_PUBLICATION_CONFLICT", lambda: self.bridge.publish(changed, expected))
        duplicate = dict(self.job, id="d" * 32)
        self.assert_error("CHAIN_PUBLICATION_CONFLICT", lambda: self.bridge.publish(duplicate,
            dict(self.expected, id="c" * 32, draftId=duplicate["id"])))
        self.assertEqual(len(self.driver.calls), 1)

    def test_nonfinal_wrong_actions_signer_and_incomplete_receipt_tree_rejected(self):
        mutations = {
            "not-final": lambda e: e["transaction"].update(final_execution_status="EXECUTED_OPTIMISTIC"),
            "signer": lambda e: e["transaction"]["transaction"].update(signer_id="other.testnet"),
            "receiver": lambda e: e["transaction"]["transaction"].update(receiver_id="other.testnet"),
            "txhash": lambda e: e["transaction"]["transaction"].update(hash=chain_digest("other-tx")),
            "public-key": lambda e: e["transaction"]["transaction"].update(public_key="ed25519:wrong"),
            "hidden-transfer": lambda e: e["transaction"]["transaction"]["actions"].append({"Transfer": {"deposit": "1"}}),
            "deposit": lambda e: e["transaction"]["transaction"]["actions"][0]["FunctionCall"].update(deposit="1"),
            "method": lambda e: e["transaction"]["transaction"]["actions"][0]["FunctionCall"].update(method_name="begin_attempt"),
            "args": lambda e: e["transaction"]["transaction"]["actions"][0]["FunctionCall"].update(args=base64.b64encode(b'{}').decode()),
            "missing-receipts": lambda e: e["transaction"].update(receipts_outcome=[]),
            "failed-receipt": lambda e: e["transaction"]["receipts_outcome"][0]["outcome"].update(status={"Failure": {}}),
            "wrong-return": lambda e: e["transaction"]["receipts_outcome"][0]["outcome"].update(status={"SuccessValue": ""}),
            "duplicate-receipt": lambda e: e["transaction"]["receipts_outcome"].append(copy.deepcopy(e["transaction"]["receipts_outcome"][0])),
            "missing-link": lambda e: e["transaction"]["transaction_outcome"]["outcome"]["receipt_ids"].append(chain_digest("missing")),
            "cycle": lambda e: e["transaction"]["receipts_outcome"][0]["outcome"]["receipt_ids"].append(e["journalTransactionHash"]),
        }
        for index, (name, mutate) in enumerate(mutations.items()):
            with self.subTest(name=name):
                driver = DriverDouble(self.pins)
                def changed(value):
                    mutate(value)
                    return value
                driver.mutate = changed
                bridge = self.make_bridge("invalid-tx-" + str(index), driver)
                self.assert_error("CHAIN_OUTCOME_UNKNOWN", lambda: bridge.publish(self.job, self.expected))
                result = bridge.status(self.job["id"])
                self.assertEqual(result["state"], "UNKNOWN")
                self.assertNotIn("finalExecutionStatus", result)

    def test_mixed_block_unreviewed_code_domain_registry_and_rpc_mismatch_rejected(self):
        mutations = {
            "rpc": lambda e: e.update(rpc="https://rpc.mainnet.near.org"),
            "network": lambda e: e.update(network="mainnet"),
            "sync": lambda e: e["status"]["sync_info"].update(syncing=True),
            "code": lambda e: e["account"].update(code_hash=chain_digest("unapproved-code")),
            "owner": lambda e: e["owner"].update(value="other.testnet"),
            "domain": lambda e: e["domain"].update(value=[1] * 32),
            "view-block": lambda e: e["view"].update(block_hash=chain_digest("foreign-block")),
            "view-height": lambda e: e["view"].update(block_height=11),
            "bool-height": lambda e: e["account"].update(block_height=True),
            "config": lambda e: e["view"]["value"]["config"].update(input_hash=[1] * 32),
            "job-id": lambda e: e["view"]["value"].update(job_id="8"),
            "job-binding": lambda e: e["view"]["value"].update(job_binding_hash=[1] * 32),
            "future-outcome": lambda e: e["blocks"][0]["header"].update(height=13),
            "missing-block": lambda e: e["blocks"].pop(),
        }
        for index, (name, mutate) in enumerate(mutations.items()):
            with self.subTest(name=name):
                driver = DriverDouble(self.pins)
                def changed(value):
                    mutate(value)
                    return value
                driver.mutate = changed
                bridge = self.make_bridge("invalid-view-" + str(index), driver)
                self.assert_error("CHAIN_OUTCOME_UNKNOWN", lambda: bridge.publish(self.job, self.expected))

    def test_public_journal_contains_no_keys_prices_raw_errors_or_rpc_logs(self):
        marker = "DO-NOT-PERSIST-RAW-RPC-LOGS"
        def logged(value):
            value["transaction"]["receipts_outcome"][0]["outcome"]["logs"] = [marker]
            return value
        self.driver.mutate = logged
        result = self.bridge.publish(self.job, self.expected)
        self.assertNotIn(marker, json.dumps(result))
        for path in (self.root / "journal").iterdir():
            self.assertEqual(path.stat().st_mode & 0o777, 0o600)
            data = path.read_bytes()
            for forbidden in (marker.encode(), b"EXPLICIT-TEST-ONLY-NOT-A-PRIVATE-KEY", b'"privateInput"', b'"salt"', b'"budget"', b'"price"'):
                self.assertNotIn(forbidden, data)
        with self.bridge._db.connect() as db:
            row = db.execute("SELECT * FROM procurement_publications").fetchone()
            self.assertEqual(row["session_id"], self.expected["id"])
            self.assertEqual(row["state"], "BOUND")

    def test_default_wrapper_uses_fixed_stdin_program_cwd_and_sanitized_environment(self):
        bridge = chain.ProcurementChainBridge(self.root / "default-wrapper", self.config,
            relay_root=self.repo, node_executable=sys.executable)
        expected_reply = evidence(chain._projection(self.job), self.pins)
        with patch.dict(os.environ, {"NODE_OPTIONS": "UNTRUSTED", "PRIVATE_TOKEN": "MUST-NOT-INHERIT"}), \
             patch("subprocess.run", return_value=SimpleNamespace(returncode=0, stdout=canonical_json(expected_reply))) as child:
            bridge.publish(self.job, self.expected)
        args, kwargs = child.call_args
        self.assertEqual(args[0], [sys.executable, "--input-type=module", "-e", chain._NODE])
        self.assertEqual(json.loads(kwargs["input"]), {"command": "publish", "job": chain._projection(self.job)})
        self.assertEqual(kwargs["cwd"], str(self.repo / "contracts/registry/deploy"))
        self.assertEqual(kwargs["env"], {"PATH": os.defpath, "NODE_NO_WARNINGS": "1"})
        self.assertEqual(kwargs["timeout"], 180)

    def test_expired_deadlines_and_unknown_identifiers_never_dispatch(self):
        with patch("service.procurement_chain.time.time_ns", return_value=int(self.job["bidDeadlineNs"])):
            self.assert_error("CHAIN_PUBLICATION_EXPIRED", lambda: self.bridge.publish(self.job, self.expected))
        self.assert_error("CHAIN_JOB_UNKNOWN", lambda: self.bridge.status(self.job["id"]))
        for identity in ("../identity.json", True, "A" * 32):
            self.assert_error("INVALID_CHAIN_JOB_ID", lambda: self.bridge.status(identity))
        self.assertEqual(self.driver.calls, [])

    def test_journal_fault_is_sanitized_and_prevents_dispatch(self):
        with patch.object(self.bridge._db, "transaction", side_effect=RuntimeError("PRIVATE-DATABASE-DETAIL")):
            self.assert_error("CHAIN_JOURNAL_UNAVAILABLE", lambda: self.bridge.publish(self.job, self.expected))
        self.assertEqual(self.driver.calls, [])

    def test_unsafe_journal_symlink_and_request_corruption_fail_closed(self):
        self.bridge.publish(self.job, self.expected)
        with self.bridge._db.transaction() as db:
            db.execute("UPDATE procurement_publications SET request_hash=?", (digest("wrong"),))
        self.assert_error("CHAIN_JOURNAL_REQUEST_MISMATCH", lambda: self.bridge.status(self.job["id"]))
        (self.root / "symlink-journal").symlink_to(self.root / "journal", target_is_directory=True)
        self.assert_error("CHAIN_RELAY_CONFIGURATION_INVALID", lambda: self.make_bridge("symlink-journal"))


if __name__ == "__main__":
    unittest.main()
