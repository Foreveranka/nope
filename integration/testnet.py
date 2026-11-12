#!/usr/bin/env python3
"""Genuine FHE -> existing NEAR TESTNET registry -> local synthetic MPC v2.

The coordinator knows every synthetic bid; the MPC parties share this host.
The registry verifies bindings/authorization, not MPC correctness or FHE proofs.
No payment adapter is invoked. Never use customer inputs or real money here.

Exports: run(), run_async(), TestnetCalls, wait_for_close, validate_ready.
Run: .venv/bin/python -m integration.testnet --driver-ready
The flag records the caller's explicit confirmation that the driver/accounts
are ready; importing this module or requesting --help performs no network IO.
"""
import argparse
import asyncio
import copy
import fcntl
import hashlib
import json
import math
import os
from pathlib import Path
import re
import secrets
import time

from integration.driver import DriverError, SandboxDriver as JsonLinesTransport
from integration.run import canonical, save, sha
from integration.selection_guard import SelectionGuard
from sdk import BindingError, build_receipt_claim
from sdk.registry import verify_registry_job

ROOT = Path(__file__).resolve().parents[1]
DRIVER = ROOT / "contracts/registry/deploy/procurement-driver.mjs"
NETWORK = "testnet"
RPC = "https://test.rpc.fastnear.com"
DOMAIN_HASH = hashlib.sha256(b"veil/registry/network/v1:near:testnet").digest()
COMMANDS = frozenset(("now", "create_job", "bid", "close", "begin_execution",
                      "submit_receipt", "decide", "view"))
MUTATIONS = COMMANDS - {"now", "view"}
KNOWN_REJECTIONS = frozenset(("UNKNOWN_ACTOR", "PROVIDER_ONLY", "BUYER_ONLY",
    "REGISTRY_CALL_REJECTED", "TRANSACTION_EXECUTION_FAILED", "TRANSACTION_RECEIPT_FAILED"))
CHAIN_REJECTIONS = frozenset(("TRANSACTION_EXECUTION_FAILED", "TRANSACTION_RECEIPT_FAILED"))
LIMITS = [
    "Centralized synthetic budget/prices; coordinator knows every fixture witness",
    "Local MPC and FHE processes share one host/UID; testnet accounts share one administrator",
    "Buyer authorizes winner; registry does not verify the MPC argmin",
    "Client plaintext reference verification is not public execution proof",
    "Final views are trusted RPC observations, not light-client proofs",
    "Payments not executed; no escrow adapter is invoked",
    "Local evidence hash chain is not independent timestamp evidence",
    "Driver rejection responses do not expose failed-transaction hashes",
]


def _account(value):
    return (type(value) is str and 2 <= len(value) <= 64 and value.endswith(".testnet")
            and re.fullmatch(r"[a-z0-9]+(?:[._-][a-z0-9]+)*", value) is not None)


def _u64(value):
    if (type(value) is not str or not re.fullmatch(r"0|[1-9][0-9]{0,19}", value)
            or int(value) >= 1 << 64):
        raise DriverError("Expected canonical U64 chain timestamp/identity")
    return int(value)


def _chain_hash(value):
    # NEAR transaction/block hashes are base58-encoded 32-byte values.
    alphabet = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz"
    if type(value) is not str or not 32 <= len(value) <= 44:
        return False
    number = 0
    for char in value:
        if char not in alphabet:
            return False
        number = number * 58 + alphabet.index(char)
    size = (number.bit_length() + 7) // 8
    return len(value) - len(value.lstrip("1")) + size == 32


def validate_ready(ready):
    """Fail before sending commands unless the pinned existing testnet is ready."""
    if (type(ready) is not dict or ready.get("event") != "ready"
            or ready.get("network") != NETWORK or ready.get("local_only") is not False):
        raise DriverError("Actual testnet ready event required; sandbox/mainnet refused")
    domain = ready.get("network_domain_hash")
    if (type(domain) is not list or len(domain) != 32
            or any(type(n) is not int or not 0 <= n <= 255 for n in domain)
            or bytes(domain) != DOMAIN_HASH):
        raise DriverError("Pinned testnet network domain mismatch")
    ids = ready.get("identities")
    if (type(ids) is not dict or set(ids) != {"buyer", "executor", "bidder0", "bidder1", "bidder2"}
            or not all(_account(v) for v in ids.values()) or not _account(ready.get("contract_id"))):
        raise DriverError("Explicit testnet account identities required")
    buyer = ids["buyer"]
    roster = [ids[k] for k in ("bidder0", "bidder1", "bidder2")]
    if (buyer != ready["contract_id"] or ids["executor"] != buyer or len(set(roster)) != 3
            or buyer in roster or set(roster) != {"p%d.%s" % (n, buyer) for n in (1, 2, 3)}):
        raise DriverError("Existing owner and dedicated participant roster mismatch")
    return ready


class TestnetCalls:
    """Existing Calls JSONL envelopes with strict failure poisoning and evidence.

    Transport is shared with the local harness, but its child is the Node testnet
    driver. No sandbox binary, fake clock, wallet loader or signing exists here.
    Only close/notReady may repeat; unknown outcomes prohibit further commands.
    """
    MAX_REQUESTS = 64

    def __init__(self, driver, ready, *, record=None):
        self.ready = validate_ready(ready)
        self.driver = driver
        self.sequence = 0
        self.failed = False
        self.rejections = []
        self.transactions = []
        self.views = []
        self.record = record or (lambda stage, payload: None)

    def _poison(self, message):
        self.failed = True
        self.driver.failed = True
        raise DriverError(message + "; outcome UNKNOWN, no automatic retry")

    async def call(self, command, *, reject=False, timeout=None, **kwargs):
        if self.failed or self.driver.failed:
            raise DriverError("Testnet driver outcome UNKNOWN; no further commands or mutation retry")
        if command not in COMMANDS or self.sequence >= self.MAX_REQUESTS:
            raise DriverError("Testnet command/request bound exceeded")
        self.sequence += 1
        packet = dict(id=self.sequence, command=command, **kwargs)
        started = time.monotonic()
        old_timeout = self.driver.timeout
        if timeout is not None:
            if not math.isfinite(timeout) or timeout <= 0:
                raise DriverError("Positive bounded request timeout required")
            self.driver.timeout = min(old_timeout, timeout)
        try:
            response = await asyncio.to_thread(self.driver.request, packet)
        except BaseException:
            self.failed = True
            self.driver.failed = True
            raise
        finally:
            self.driver.timeout = old_timeout
        if (type(response) is not dict or type(response.get("id")) is not int
                or response["id"] != self.sequence or type(response.get("ok")) is not bool):
            self._poison("Testnet response identity/schema mismatch")
        if not response["ok"]:
            error = response.get("error")
            if not reject or error not in KNOWN_REJECTIONS:
                # Machine codes only: never copy raw exceptions, RPC detail,
                # child stderr, command payloads or signer material to evidence.
                code = (error if type(error) is str and re.fullmatch(r"[A-Z][A-Z0-9_]{0,95}", error)
                        else "UNSAFE_OR_MISSING_DRIVER_ERROR")
                self.record("command_failed", {"command": command, "sequence": self.sequence,
                    "error_code": code, "elapsed_seconds": time.monotonic() - started,
                    "outcome": "unknown; no automatic retry"})
                self._poison("Testnet action failed: " + command + ": " + code)
            rejection = {"command": command, "actor": kwargs.get("actor"), "error": error,
                         "scope": "onchain_final_execution" if error in CHAIN_REJECTIONS else "driver_preflight",
                         "layer": "contract" if error in CHAIN_REJECTIONS else "driver",
                         "transaction_hash_available": False,
                         "elapsed_seconds": time.monotonic() - started}
            self.rejections.append(rejection)
            self.record("rejected_" + command, rejection)
            return response
        result = response.get("result")
        if type(result) is not dict:
            self._poison("Testnet result must be an object")
        if reject:
            self._poison("Forbidden registry action unexpectedly succeeded: " + command)
        if command == "close" and "notReady" in result:
            wait = result.get("waitSeconds")
            if (set(result) != {"notReady", "waitSeconds"} or result["notReady"] is not True
                    or type(wait) not in (int, float) or not math.isfinite(wait) or not 0 < wait <= 20):
                self._poison("Invalid non-mutating close wait response")
            self.record("close_not_ready", {"wait_seconds": wait,
                                           "elapsed_seconds": time.monotonic() - started})
            return result
        if command == "now":
            try:
                now = _u64(result["timestamp_ns"])
                bid = _u64(result["suggested_bid_deadline_ns"])
                end = _u64(result["suggested_result_deadline_ns"])
                if bid - now != 180 * 10**9 or end - now != 1200 * 10**9:
                    raise DriverError("Unexpected chain deadline offsets")
            except (KeyError, DriverError):
                self._poison("Invalid testnet clock/deadlines")
            self.record("chain_clock", {k: result[k] for k in (
                "timestamp_ns", "suggested_bid_deadline_ns", "suggested_result_deadline_ns")})
            return result
        job = result.get("job")
        if (type(job) is not dict or not _chain_hash(result.get("block_hash"))
                or (command != "create_job" and job.get("job_id") != kwargs.get("job_id"))
                or job.get("buyer") != self.ready["identities"]["buyer"]):
            self._poison("Missing/mismatched finalized registry view")
        try:
            verify_registry_job(job, contract_account=self.ready["contract_id"],
                                network_domain_hash=self.ready["network_domain_hash"])
        except (ValueError, KeyError, TypeError):
            self._poison("Registry view hash binding validation failed")
        public = {"sequence": self.sequence, "command": command, "job": job,
                  "block_hash": result["block_hash"], "finality": "final",
                  "elapsed_seconds": time.monotonic() - started}
        if command in MUTATIONS:
            tx = result.get("transaction")
            if (type(tx) is not dict or set(tx) != {"hash", "signer", "receiver", "finality"}
                    or not _chain_hash(tx["hash"]) or tx["finality"] != "FINAL"
                    or tx["receiver"] != self.ready["contract_id"]
                    or tx["signer"] != kwargs.get("actor", self.ready["identities"]["buyer"])
                    or any(t["hash"] == tx["hash"] for t in self.transactions)):
                self._poison("Missing/mismatched final transaction evidence")
            transaction = dict(tx, command=command, sequence=self.sequence,
                               view_block_hash=result["block_hash"])
            self.transactions.append(transaction)
            public["transaction"] = transaction
        self.views.append(public)
        self.record(command, public)
        return result


async def wait_for_close(calls, job_id, *, timeout=240, max_polls=24):
    """Await actual time in <=20s slices, bounded by monotonic deadline and count.

    A notReady response is explicitly pre-transaction. No failed/timed-out
    mutation is retried; each request is bounded by the remaining wait budget.
    """
    if (type(timeout) not in (int, float) or not math.isfinite(timeout) or not 0 < timeout <= 600
            or type(max_polls) is not int or not 1 <= max_polls <= 32):
        raise ValueError("Bounded positive close timeout/poll count required")
    deadline = time.monotonic() + timeout
    for _ in range(max_polls):
        remaining = deadline - time.monotonic()
        if remaining <= 0:
            break
        result = await calls.call("close", job_id=job_id, timeout=remaining)
        if result.get("notReady") is not True:
            return result
        wait = result.get("waitSeconds")
        if type(wait) not in (int, float) or not math.isfinite(wait) or not 0 < wait <= 20:
            raise DriverError("Invalid close wait interval; no retry")
        remaining = deadline - time.monotonic()
        if wait >= remaining:
            break
        await asyncio.sleep(wait)
    raise DriverError("Actual testnet bid deadline was not reached within close polling bounds")


class Evidence:
    """Public local progress, durable before moving on; never raw child output."""
    def __init__(self, directory):
        self.started = time.monotonic()
        self.events = []
        self.fd = os.open(directory / "events.jsonl", os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)

    def add(self, stage, payload=None):
        event = {"sequence": len(self.events), "stage": stage,
                 "elapsed_seconds": time.monotonic() - self.started,
                 "observed_at_unix_ns": str(time.time_ns()), "public": payload or {},
                 "previous_sha256": self.events[-1]["event_sha256"] if self.events else "0" * 64}
        event["event_sha256"] = sha(canonical(event))
        data = canonical(event) + b"\n"
        while data:
            data = data[os.write(self.fd, data):]
        os.fsync(self.fd)
        self.events.append(event)
        print(json.dumps({"stage": stage, "elapsed_seconds": round(event["elapsed_seconds"], 3)}), flush=True)

    def close(self):
        os.close(self.fd)


def public_mpc_result(result):
    """Allowlist native result metadata; never persist PreparedSynthetic/witness."""
    keys = ("case", "status", "output", "compileSeconds", "runtimeSeconds", "manifestHash",
            "codecVersion", "program", "circuitSourceHash", "upstream", "runtimeIdentity",
            "transportGeneration", "nearBindingVerified", "precommitContext", "selectionRound",
            "jobBindingHash", "bidsetRoot", "selectedExecutor", "registryCodecBindingVerified",
            "chainFinalityVerified", "durableSelectionReplayGuard")
    public = {k: copy.deepcopy(result[k]) for k in keys if k in result}
    public.update(independentOperators=False, synthetic_only=True,
                  scope="local_centralized_synthetic_mpc_v2", private_witness_persisted=False)
    # Runtime identity is pinned native build metadata, not an unbounded log.
    public["runtimeIdentity"] = {k: public.get("runtimeIdentity", {}).get(k) for k in (
        "upstream", "binarySha256", "sharedLibrarySha256", "configSha256", "transportPatchSha256")}
    public["output"] = {k: public.get("output", {})[k] for k in ("buyer", "providers")}
    return public


def run(output_dir=None, *, driver_ready=False, mpc_port=17400):
    """Synchronous CLI/library entry; explicit readiness confirmation required."""
    return asyncio.run(run_async(output_dir, driver_ready=driver_ready, mpc_port=mpc_port))


async def run_async(output_dir=None, *, driver_ready=False, mpc_port=17400):
    if driver_ready is not True:
        raise RuntimeError("Confirm driver/accounts ready before starting testnet integration")
    if type(mpc_port) is not int or not 1024 <= mpc_port <= 65432:
        raise ValueError("MPC port must be in 1024..65432")
    output_dir = (ROOT / "runtime" / ("testnet-integration-" + secrets.token_hex(8))
                  if output_dir is None else Path(output_dir).absolute())
    # Keep outputs under the ignored runtime, never alongside source/deploy assets.
    runtime = ROOT / "runtime"
    runtime.mkdir(mode=0o700, exist_ok=True)
    if output_dir.parent.resolve() != runtime.resolve() or output_dir.exists() or output_dir.is_symlink():
        raise ValueError("Output must be a new direct child of the repository runtime directory")
    lock = os.open(runtime / "integration.lock", os.O_CREAT | os.O_RDWR | os.O_NOFOLLOW, 0o600)
    try:
        try:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            raise RuntimeError("Another integration owns the native MPC/FHE runtime") from None
        output_dir.mkdir(mode=0o700, exist_ok=False)
        output_dir.chmod(0o700)
        evidence = Evidence(output_dir)
        try:
            return await _run(output_dir, evidence, mpc_port=mpc_port)
        except BaseException as exc:
            # Do not serialize native exceptions, signer errors, witnesses or stderr.
            evidence.add("failed_or_interrupted", {"exception_type": type(exc).__name__,
                "outcome": "incomplete; inspect public journal and driver once-journals; no automatic retry"})
            save(output_dir / "failure.json", {"completed": False, "network": NETWORK,
                "payments_executed": False, "automatic_retry": False, "limits": LIMITS,
                "exception_type": type(exc).__name__, "elapsed_seconds": time.monotonic() - evidence.started,
                "journal_last_hash": evidence.events[-1]["event_sha256"]})
            raise
        finally:
            evidence.close()
    finally:
        os.close(lock)


async def _run(output_dir, evidence, *, mpc_port):
    # Optional native dependencies are deliberately lazy: help/unit checks work offline.
    from engine.pipeline import prepare_job
    from mpc.v2 import (build_intent, prepare_synthetic, registry_config,
                        build_selection_manifest, manifest_digest)
    from mpc.run_v2 import run_prepared

    checks = []

    def check(name, condition):
        if not condition:
            raise AssertionError(name)
        checks.append({"name": name, "pass": True})

    evidence.add("starting", {"network": NETWORK, "rpc": RPC, "payments_executed": False,
                              "synthetic_only": True})
    # The Node driver exclusively owns the global signer lock for its lifetime.
    with JsonLinesTransport(["node", str(DRIVER)], ROOT, output_dir / "driver-stderr.log",
                            timeout=120) as driver:
        ready = validate_ready(await asyncio.to_thread(driver.receive))
        calls = TestnetCalls(driver, ready, record=evidence.add)
        identities = ready["identities"]
        roster = sorted(identities[k] for k in ("bidder0", "bidder1", "bidder2"))
        evidence.add("driver_ready", {"network": NETWORK, "contract_id": ready["contract_id"],
            "network_domain_hash": ready["network_domain_hash"], "identities": identities,
            "independent_administrators": False})
        policy = {"profile_id": "clean-4-records-v1", "requires_execution_proof": False,
                  "verification_method": "client_plaintext_reference"}
        spec_hash = sha(canonical({"profile": policy["profile_id"], "records": 4, "version": 1}))
        policy_hash = sha(canonical(policy))
        policy.update(spec_hash=list(bytes.fromhex(spec_hash)), output_policy_hash=list(bytes.fromhex(policy_hash)))
        records = [{"id": 7, "value": 255}, {"id": 2, "value": 144},
                   {"id": 7, "value": 42}, {"id": 3, "value": 5}]
        # macos-v1 is intentional: current SDK pins this exact approved artifact.
        evidence.add("fhe_prepare_started", {"artifact_set": "macos-v1"})
        with prepare_job(records, output_dir / "fhe") as prepared:
            hashes = dict(prepared.artifact_hashes)
            evidence.add("prepared", {"input_sha256": hashes["inputSha256"]})
            now = await calls.call("now")
            intent = build_intent(network_domain_hash=ready["network_domain_hash"],
                registry_account=ready["contract_id"], buyer=identities["buyer"], roster=roster,
                qualified=[True] * 3, fixed_fee=0,
                bid_deadline_ns=now["suggested_bid_deadline_ns"],
                result_deadline_ns=now["suggested_result_deadline_ns"],
                spec_hash=spec_hash, circuit_hash=hashes["serverSha256"],
                key_hash=hashes["evaluationKeysSha256"], input_hash=hashes["inputSha256"],
                output_policy_hash=policy_hash, registry_executor=identities["executor"])
            auction = prepare_synthetic(intent, budget=100_000_000,
                                        prices=(90_000_000, 80_000_000, 95_000_000))
            config = registry_config(auction)
            verify_args = dict(contract_account=ready["contract_id"],
                               network_domain_hash=ready["network_domain_hash"], expected_config=config)
            registered = await calls.call("create_job", config=config)
            job = registered["job"]
            jid = job["job_id"]
            check("precommitted intent registered on actual testnet", verify_registry_job(job, **verify_args))
            check("FHE response absent before selection", not (output_dir / "fhe/response.bin").exists())
            for slot, actor in enumerate(roster):
                bid = await calls.call("bid", actor=actor, job_id=jid,
                    expected_job_binding_hash=job["job_binding_hash"],
                    commitment=list(bytes.fromhex(auction.commitments[slot + 1])))
                check("exact testnet bid slot %d" % (slot + 1),
                      bid["job"]["bids"][slot]["commitment"] == list(bytes.fromhex(auction.commitments[slot + 1])))
            closed = (await wait_for_close(calls, jid))["job"]
            check("closed full roster/config binding", verify_registry_job(closed, **verify_args))
            manifest = build_selection_manifest(auction, closed)
            save(output_dir / "selection-manifest.json", manifest)
            guard = SelectionGuard(output_dir / "selection-admission.sqlite")
            job_hash = bytes(closed["job_binding_hash"]).hex()
            selection_hash = manifest_digest(manifest)
            guard.reserve(job_hash, bytes(closed["bidset_root"]).hex(), selection_hash)
            evidence.add("mpc_started", {"selection_sha256": selection_hash,
                "scope": "centralized_synthetic_local_three_party_mpc"})
            native_result = await asyncio.to_thread(run_prepared, auction, closed, timeout=600, port=mpc_port)
            mpc_result = public_mpc_result(native_result)
            guard.complete(job_hash, selection_hash)
            save(output_dir / "mpc-result.json", mpc_result)
            found, slot, price, total = mpc_result["output"]["buyer"]
            check("genuine MPC selected expected synthetic winner",
                  [found, slot, price, total] == [1, 2, 80_000_000, 80_000_000]
                  and mpc_result.get("status") == "VERIFIED_LOCAL_MPC" and mpc_result.get("codecVersion") == 2)
            winner = roster[slot - 1]
            check("native MPC selection matches public binding",
                  mpc_result.get("selectedExecutor") == winner and mpc_result.get("jobBindingHash") == job_hash
                  and mpc_result.get("bidsetRoot") == bytes(closed["bidset_root"]).hex())
            evidence.add("mpc_completed", {"selection_sha256": selection_hash, "selected_executor": winner})
            await calls.call("begin_execution", actor="hostile", job_id=jid,
                expected_bidset_root=closed["bidset_root"], selected_executor=winner, reject=True)
            executing = (await calls.call("begin_execution", job_id=jid,
                expected_bidset_root=closed["bidset_root"], selected_executor=winner))["job"]
            check("selected executor is actual MPC slot", executing["selected_executor"] == winner
                  and executing["attempt_binding_version"] == 2 and executing["state"] == "Executing")
            check("immutable job across selection", verify_registry_job(executing, **verify_args))
            binding = {k: executing[k] for k in ("job_id", "attempt")}
            binding.update({k: bytes(executing[k]).hex() for k in (
                "job_binding_hash", "attempt_binding_hash", "bidset_root")})
            prepared.bind_external(binding)
            evidence.add("execution_bound", {"binding_sha256": prepared.artifact_hashes["externalBindingSha256"]})
            evidence.add("fhe_evaluation_started", {"payments_executed": False})
            await asyncio.to_thread(prepared.evaluate)
            evidence.add("evaluated")
            result = prepared.finalize()
            check("genuine FHE client reference verification", result["verified"] is True
                  and result["metrics"]["real_fhe"] is True)
            evidence.add("client_verified", {"output_sha256": result["artifactHashes"]["outputSha256"]})
            request = (output_dir / "fhe/request.json").read_bytes()
            kwargs = dict(request_manifest=request, evaluator_receipt=(output_dir / "fhe/receipt.json").read_bytes(),
                expected_registry_attempt=executing["attempt"], expected_engine_attempt_id=json.loads(request)["attemptId"],
                policy=policy, external_binding=(output_dir / "fhe/binding.json").read_bytes())
            claim = build_receipt_claim(executing, result, **kwargs)
            substituted = copy.deepcopy(executing)
            substituted["attempt_binding_hash"][0] ^= 1
            try:
                build_receipt_claim(substituted, result, **kwargs)
            except BindingError:
                check("SDK rejects substituted attempt", True)
            else:
                raise AssertionError("SDK accepted substituted attempt")
            evidence.add("sdk_claim_built", {"claim_sha256": sha(canonical(claim))})
            # Exact owner account is a real signer; the string 'executor' is not.
            await calls.call("submit_receipt", actor=identities["buyer"], job_id=jid, claim=claim, reject=True)
            reported = (await calls.call("submit_receipt", actor=winner, job_id=jid, claim=claim))["job"]
            await calls.call("submit_receipt", actor=winner, job_id=jid, claim=claim, reject=True)
            receipt_hash = reported["receipts"][-1]["receipt_hash"]
            await calls.call("decide", actor=roster[0], job_id=jid,
                             expected_receipt_hash=receipt_hash, accept=True, reject=True)
            accepted = (await calls.call("decide", job_id=jid,
                expected_receipt_hash=receipt_hash, accept=True))["job"]
            final = await calls.call("view", job_id=jid)
            check("final registry accepted exact ciphertext receipt", final["job"] == accepted
                  and accepted["state"] == "Accepted" and accepted["receipts"][-1]["claim"] == claim
                  and accepted["receipts"][-1]["status"] == "BuyerAccepted")
            check("immutable config survives acceptance", verify_registry_job(accepted, **verify_args))
            check("evaluation key cleaned", not (output_dir / "fhe/evaluation.keys").exists())
            evidence.add("accepted", {"job_id": jid, "block_hash": final["block_hash"],
                "successful_transactions": len(calls.transactions), "payments_executed": False})
            summary = {"completed": True, "network": NETWORK, "rpc": RPC,
                "external_chain": True, "actual_near_testnet": True, "actual_near_sandbox": False,
                "synthetic_only": True, "real_fhe": True, "real_mpc": True,
                "independent_operators": False, "independent_administrators": False,
                "execution_proof": False, "mpc_winner_verified_by_contract": False,
                "payment_mode": "not_executed", "payments_executed": False, "real_payment": False,
                "precommitted_workflow": True, "private_witness_persisted": False,
                "contract_account": ready["contract_id"], "network_domain_hash": ready["network_domain_hash"],
                "job_id": jid, "selected_executor": winner, "checks": checks,
                "transactions": calls.transactions, "final_views": calls.views,
                "rejected_registry_actions": calls.rejections,
                "closed_job": closed, "executing_job": executing, "accepted_job": accepted,
                "artifactHashes": result["artifactHashes"], "fhe_metrics": result["metrics"],
                "stage_elapsed_seconds": [{"stage": e["stage"], "elapsed_seconds": e["elapsed_seconds"]}
                                          for e in evidence.events],
                "elapsed_seconds": time.monotonic() - evidence.started,
                "journal_last_hash": evidence.events[-1]["event_sha256"], "limits": LIMITS}
    # A completed artifact is published only after both client and driver have
    # exited successfully, so consumers can coordinate the owner's signer lock.
    check("Node testnet driver exited cleanly", driver.process.returncode == 0)
    evidence.add("driver_stopped", {"exit_code": driver.process.returncode})
    summary.update(elapsed_seconds=time.monotonic() - evidence.started,
        journal_last_hash=evidence.events[-1]["event_sha256"],
        stage_elapsed_seconds=[{"stage": e["stage"], "elapsed_seconds": e["elapsed_seconds"]}
                               for e in evidence.events])
    save(output_dir / "result.json", summary)
    return summary


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", type=Path, help="New direct child of the ignored repository runtime directory")
    parser.add_argument("--driver-ready", action="store_true", help="Confirm main has readied the driver and provider accounts")
    parser.add_argument("--mpc-port", type=int, default=17400)
    args = parser.parse_args()
    if not args.driver_ready:
        parser.error("--driver-ready is required after explicit driver/accounts readiness confirmation")
    output = args.output or ROOT / "runtime" / ("testnet-integration-" + secrets.token_hex(8))
    result = run(output, driver_ready=args.driver_ready, mpc_port=args.mpc_port)
    print(json.dumps({"completed": result["completed"], "network": NETWORK, "job_id": result["job_id"],
                      "evidence": str(output.absolute() / "result.json"), "transactions": result["transactions"],
                      "payment_mode": result["payment_mode"]}), flush=True)


if __name__ == "__main__":
    main()
