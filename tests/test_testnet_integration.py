"""Offline adversarial unit tests, NOT a successful testnet/FHE/MPC integration.

No driver process or signer starts in these tests. The genuine end-to-end check
is the explicit integration.testnet CLI and its final on-chain evidence.
"""
import asyncio
import copy
import json
from pathlib import Path
import tempfile
import time
import unittest
from unittest.mock import patch

from integration import testnet
from integration.driver import DriverError
from mpc import v2
from mpc.sample_v2 import synthetic_closed_job


def ready():
    buyer = "unit-owner.testnet"
    return {"event": "ready", "network": "testnet", "local_only": False,
            "contract_id": buyer, "network_domain_hash": list(testnet.DOMAIN_HASH),
            "identities": {"buyer": buyer, "executor": buyer,
                           **{"bidder%d" % n: "p%d.%s" % (n + 1, buyer) for n in range(3)}}}


def closed_job():
    r = ready()
    i = v2.build_intent(network_domain_hash=r["network_domain_hash"],
        registry_account=r["contract_id"], buyer=r["identities"]["buyer"],
        roster=sorted(r["identities"][k] for k in ("bidder0", "bidder1", "bidder2")),
        qualified=[True] * 3, fixed_fee=0, bid_deadline_ns="100", result_deadline_ns="200",
        registry_executor=r["identities"]["executor"], **{k: "42" * 32 for k in (
            "spec_hash", "circuit_hash", "key_hash", "input_hash", "output_policy_hash")})
    return synthetic_closed_job(v2.prepare_synthetic(i))


class ProtocolTransport:
    """Only offline scripted protocol replies; never represents a chain."""
    def __init__(self, replies):
        self.replies = iter(replies)
        self.sent = []
        self.failed = False
        self.timeout = 120

    def request(self, packet):
        self.sent.append(packet)
        reply = next(self.replies)
        if isinstance(reply, Exception):
            raise reply
        return copy.deepcopy(reply)


class ReadinessTests(unittest.TestCase):
    def test_domain_matches_pinned_node_policy(self):
        self.assertEqual(testnet.DOMAIN_HASH.hex(),
            "b913ada2cc6f5e0f14bc58b1515dc858d28730f9fbccc078dc74ef98df6ffb9d")

    def test_reject_mainnet_sandbox_wrong_domain_and_ambiguous_flags(self):
        for field, value in (("network", "mainnet"), ("network", "sandbox"),
                             ("local_only", True), ("local_only", 0),
                             ("event", "fatal"), ("network_domain_hash", [0] * 32),
                             ("network_domain_hash", testnet.DOMAIN_HASH.hex()),
                             ("contract_id", "unit-owner.near")):
            r = ready()
            r[field] = value
            with self.subTest(field=field, value=value), self.assertRaises(DriverError):
                testnet.validate_ready(r)
        r = ready()
        r["network_domain_hash"][0] = True
        with self.assertRaises(DriverError):
            testnet.validate_ready(r)

    def test_reject_duplicate_unknown_mainnet_or_substituted_participants(self):
        for key, value in (("bidder1", "p1.unit-owner.testnet"), ("buyer", "other.testnet"),
                           ("executor", "p1.unit-owner.testnet"), ("bidder0", "p1.unit-owner.near"),
                           ("bidder0", "unrelated.testnet"), ("bidder0", "unit-owner.testnet")):
            r = ready()
            r["identities"][key] = value
            with self.subTest(key=key, value=value), self.assertRaises(DriverError):
                testnet.validate_ready(r)

    def test_cli_requires_readiness_before_driver_can_spawn(self):
        with patch.object(testnet, "JsonLinesTransport") as transport:
            with self.assertRaisesRegex(RuntimeError, "ready"):
                testnet.run(driver_ready=False)
            transport.assert_not_called()

    def test_near_hash_rejects_arbitrary_or_invalid_length_base58(self):
        self.assertTrue(testnet._chain_hash("1" * 32))
        for value in (None, "a" * 64, "0" * 44, "1" * 44, "2" * 32):
            self.assertFalse(testnet._chain_hash(value), repr(value))

    def test_native_result_public_export_excludes_witness_and_session(self):
        result = {"output": {"buyer": [1, 2, 80, 80], "providers": [[0], [1], [0]]},
                  "amounts": [100, 90, 80, 95], "salts": ["secret"], "witness": "secret",
                  "session": "/temporary/private", "independentOperators": True,
                  "runtimeIdentity": {"upstream": "pinned", "secret": "must-not-export"}}
        exported = testnet.public_mpc_result(result)
        for key in ("amounts", "salts", "witness", "session"):
            self.assertNotIn(key, exported)
        self.assertNotIn("secret", json.dumps(exported))
        self.assertFalse(exported["independentOperators"])
        self.assertFalse(exported["private_witness_persisted"])
        self.assertTrue(exported["synthetic_only"])

    def test_public_journal_hash_chain_and_exclusive_creation(self):
        with tempfile.TemporaryDirectory() as tmp:
            out = Path(tmp)
            journal = testnet.Evidence(out)
            try:
                with patch("builtins.print"):
                    journal.add("started", {"payments_executed": False})
                    journal.add("stopped")
            finally:
                journal.close()
            rows = [json.loads(line) for line in (out / "events.jsonl").read_text().splitlines()]
            self.assertEqual(rows[1]["previous_sha256"], rows[0]["event_sha256"])
            for row in rows:
                digest = row.pop("event_sha256")
                self.assertEqual(digest, testnet.sha(testnet.canonical(row)))
            self.assertEqual((out / "events.jsonl").stat().st_mode & 0o777, 0o600)
            with self.assertRaises(FileExistsError):
                testnet.Evidence(out)


class ProtocolTests(unittest.IsolatedAsyncioTestCase):
    async def test_envelope_identity_type_and_shape_poison_transport(self):
        for response in ([], {"id": 2, "ok": True}, {"id": True, "ok": True},
                         {"id": 1, "ok": 1}, {"id": 1, "ok": True, "result": []}):
            transport = ProtocolTransport([response])
            calls = testnet.TestnetCalls(transport, ready())
            with self.subTest(response=response), self.assertRaises(DriverError):
                await calls.call("now")
            with self.assertRaisesRegex(DriverError, "no further"):
                await calls.call("now")
            self.assertEqual(len(transport.sent), 1)

    async def test_unknown_failures_never_count_as_negative_pass_or_retry(self):
        for error in ("RPC_ERROR", "RPC_HTTP_500", "TESTNET_COMMAND_FAILED_OR_UNKNOWN",
                      "TRANSACTION_NOT_FINAL_NO_RESUBMIT", None):
            transport = ProtocolTransport([{"id": 1, "ok": False, "error": error}])
            calls = testnet.TestnetCalls(transport, ready())
            with self.subTest(error=error), self.assertRaisesRegex(DriverError, "UNKNOWN"):
                await calls.call("submit_receipt", reject=True)
            self.assertEqual(calls.rejections, [])
            with self.assertRaises(DriverError):
                await calls.call("submit_receipt", reject=True)
            self.assertEqual(len(transport.sent), 1)

    async def test_delivered_mutation_timeout_never_retries(self):
        transport = ProtocolTransport([DriverError("timeout; outcome UNKNOWN")])
        calls = testnet.TestnetCalls(transport, ready())
        with self.assertRaisesRegex(DriverError, "UNKNOWN"):
            await calls.call("create_job", config={})
        with self.assertRaises(DriverError):
            await calls.call("create_job", config={})
        self.assertEqual(len(transport.sent), 1)

    async def test_known_preflight_rejection_has_explicit_scope(self):
        transport = ProtocolTransport([{"id": 1, "ok": False, "error": "UNKNOWN_ACTOR"}])
        calls = testnet.TestnetCalls(transport, ready())
        await calls.call("begin_execution", actor="hostile", reject=True)
        self.assertEqual(calls.rejections[0]["scope"], "driver_preflight")
        self.assertEqual(calls.rejections[0]["layer"], "driver")
        self.assertFalse(calls.rejections[0]["transaction_hash_available"])
        self.assertEqual(calls.transactions, [])

    async def test_strict_safe_failure_code_is_durable_before_poison(self):
        for message, expected in (("RPC_HTTP_429", "RPC_HTTP_429"),
                                  ("private_key=secret", "UNSAFE_OR_MISSING_DRIVER_ERROR"),
                                  ("A" * 200, "UNSAFE_OR_MISSING_DRIVER_ERROR")):
            recorded = []
            transport = ProtocolTransport([{"id": 1, "ok": False, "error": message}])
            calls = testnet.TestnetCalls(transport, ready(), record=lambda s, p: recorded.append((s, p)))
            with self.subTest(message=message), self.assertRaisesRegex(DriverError, expected):
                await calls.call("close", job_id="2")
            self.assertTrue(transport.failed)
            self.assertEqual(recorded[0][0], "command_failed")
            self.assertEqual(recorded[0][1]["error_code"], expected)
            self.assertNotIn("secret", json.dumps(recorded))
            self.assertEqual(calls.rejections, [])

    async def test_policy_rejections_are_not_claimed_as_contract_negatives(self):
        for code, layer in (("BUYER_ONLY", "driver"),
                            ("TRANSACTION_EXECUTION_FAILED", "contract")):
            transport = ProtocolTransport([{"id": 1, "ok": False, "error": code}])
            calls = testnet.TestnetCalls(transport, ready())
            await calls.call("decide", reject=True)
            self.assertEqual(calls.rejections[0]["layer"], layer)

    async def test_clock_requires_actual_nanosecond_u64s_and_driver_offsets(self):
        good = {"timestamp_ns": "100", "suggested_bid_deadline_ns": "180000000100",
                "suggested_result_deadline_ns": "1200000000100"}
        for field, value in (("timestamp_ns", 100), ("timestamp_ns", "0100"),
                             ("suggested_bid_deadline_ns", "101"),
                             ("suggested_result_deadline_ns", "18446744073709551616")):
            bad = dict(good, **{field: value})
            calls = testnet.TestnetCalls(ProtocolTransport([{"id": 1, "ok": True, "result": bad}]), ready())
            with self.subTest(field=field), self.assertRaises(DriverError):
                await calls.call("now")

    async def test_close_rejects_ambiguous_notready_or_invalid_wait(self):
        for result in ({"notReady": False, "waitSeconds": 1}, {"notReady": 1, "waitSeconds": 1},
                       {"notReady": True, "waitSeconds": True}, {"notReady": True, "waitSeconds": 21},
                       {"notReady": True, "waitSeconds": float("nan")},
                       {"notReady": True, "waitSeconds": 1, "transaction": {}}):
            calls = testnet.TestnetCalls(ProtocolTransport([{"id": 1, "ok": True, "result": result}]), ready())
            with self.subTest(result=result), self.assertRaises(DriverError):
                await calls.call("close", job_id="1")

    async def test_close_nonready_wait_is_async_and_poll_count_bounded(self):
        transport = ProtocolTransport([{"id": n, "ok": True,
            "result": {"notReady": True, "waitSeconds": .01}} for n in (1, 2)])
        calls = testnet.TestnetCalls(transport, ready())
        heartbeats = []
        async def heartbeat():
            await asyncio.sleep(.005)
            heartbeats.append(True)
        beat = asyncio.create_task(heartbeat())
        started = time.monotonic()
        with self.assertRaisesRegex(DriverError, "polling bounds"):
            await testnet.wait_for_close(calls, "1", timeout=.5, max_polls=2)
        await beat
        self.assertTrue(heartbeats)
        self.assertGreaterEqual(time.monotonic() - started, .02)
        self.assertEqual([x["id"] for x in transport.sent], [1, 2])
        self.assertEqual(calls.transactions, [])

    async def test_close_monotonic_budget_prevents_an_extra_mutation(self):
        transport = ProtocolTransport([{"id": 1, "ok": True,
            "result": {"notReady": True, "waitSeconds": 1}}])
        calls = testnet.TestnetCalls(transport, ready())
        with self.assertRaises(DriverError):
            await testnet.wait_for_close(calls, "1", timeout=.01)
        self.assertEqual(len(transport.sent), 1)
        self.assertEqual(transport.timeout, 120)

    async def test_close_unknown_outcome_stops_immediately(self):
        transport = ProtocolTransport([{"id": 1, "ok": False, "error": "RPC_ERROR"}])
        calls = testnet.TestnetCalls(transport, ready())
        with self.assertRaisesRegex(DriverError, "UNKNOWN"):
            await testnet.wait_for_close(calls, "1")
        self.assertEqual(len(transport.sent), 1)

    async def test_mutation_needs_final_tx_and_bound_view(self):
        job = closed_job()
        base = {"job": job, "block_hash": "1" * 32,
                "transaction": {"hash": "1" * 32, "signer": ready()["contract_id"],
                                "receiver": ready()["contract_id"], "finality": "FINAL"}}
        bads = []
        for key, value in (("hash", "not-a-hash"), ("finality", "EXECUTED_OPTIMISTIC"),
                           ("receiver", "other.testnet"), ("signer", "other.testnet")):
            bad = copy.deepcopy(base)
            bad["transaction"][key] = value
            bads.append(bad)
        bad = copy.deepcopy(base); del bad["transaction"]; bads.append(bad)
        bad = copy.deepcopy(base); bad["job"]["job_binding_hash"][0] ^= 1; bads.append(bad)
        bad = copy.deepcopy(base); bad["job"]["buyer"] = "other.testnet"; bads.append(bad)
        bad = copy.deepcopy(base); bad["block_hash"] = "garbage"; bads.append(bad)
        for result in bads:
            calls = testnet.TestnetCalls(ProtocolTransport([{"id": 1, "ok": True, "result": result}]), ready())
            with self.subTest(result=result), self.assertRaises(DriverError):
                await calls.call("close", job_id=job["job_id"])
            self.assertEqual(calls.transactions, [])

    async def test_only_public_final_transaction_fields_are_recorded(self):
        job = closed_job()
        result = {"job": job, "block_hash": "1" * 32, "private_key": "must-not-export",
                  "transaction": {"hash": "1" * 32, "signer": ready()["contract_id"],
                                  "receiver": ready()["contract_id"], "finality": "FINAL"}}
        recorded = []
        calls = testnet.TestnetCalls(ProtocolTransport([{"id": 1, "ok": True, "result": result}]),
                                    ready(), record=lambda s, v: recorded.append((s, v)))
        await calls.call("close", job_id=job["job_id"])
        self.assertNotIn("private_key", json.dumps(recorded))
        self.assertEqual(calls.transactions[0]["finality"], "FINAL")


if __name__ == "__main__":
    unittest.main()
