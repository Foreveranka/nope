#!/usr/bin/env python3
"""Actual local MPC + NEAR sandbox + FHE; payment is explicitly a fixture.

Run only with synthetic data. All roles share this host and coordinator knows
fixture witnesses. This is an integration test, never a production deployment.
"""
import argparse
import copy
import fcntl
import hashlib
import json
import os
import secrets
import sys
import time
from pathlib import Path

from integration.driver import SandboxDriver, DriverError
from integration.journal import Journal
from integration.selection_guard import SelectionGuard
from sdk import BindingError, build_receipt_claim
from sdk.registry import verify_registry_job

ROOT = Path(__file__).resolve().parents[1]


def sha(blob):
    return hashlib.sha256(blob).hexdigest()


def canonical(value):
    return json.dumps(value, sort_keys=True, separators=(",", ":"), allow_nan=False).encode()


class Calls:
    def __init__(self, driver):
        self.driver = driver
        self.sequence = 0
        self.rejections = []

    def call(self, command, *, reject=False, **kwargs):
        self.sequence += 1
        response = self.driver.request(dict(id=self.sequence, command=command, **kwargs))
        if response.get("id") != self.sequence or type(response.get("ok")) is not bool:
            raise DriverError("Sandbox response identity mismatch")
        if reject:
            if response["ok"]:
                raise AssertionError("Forbidden registry action unexpectedly succeeded: " + command)
            self.rejections.append({"command": command, "actor": kwargs.get("actor"), "rejected": True})
            return response
        if not response["ok"]:
            raise DriverError("Sandbox action failed: " + command + ": " + response.get("error", "unknown"))
        return response["result"]


def save(path, value):
    with path.open("x") as out:
        json.dump(value, out, indent=2, allow_nan=False)
        out.write("\n")
    path.chmod(0o600)


def run(output_dir):
    lock_root = ROOT / "runtime"
    lock_root.mkdir(mode=0o700, exist_ok=True)
    descriptor = os.open(lock_root / "integration.lock", os.O_CREAT | os.O_RDWR | os.O_NOFOLLOW, 0o600)
    try:
        try:
            fcntl.flock(descriptor, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            raise RuntimeError("Another local integration is already running") from None
        return _run(output_dir)
    finally:
        os.close(descriptor)


def _run(output_dir):
    # Imports here so CLI help works even when optional native dependencies are absent.
    from engine.pipeline import prepare_job
    from mpc.v2 import build_intent, prepare_synthetic, registry_config, build_selection_manifest, manifest_digest
    from mpc.run_v2 import run_prepared
    from payments.interface import Binding, Money, Delivery, Action, State
    from payments.fixture import LocalFixtureRail
    from payments.adapter import PaymentAdapter

    output_dir.mkdir(parents=True, exist_ok=False, mode=0o700)
    start = time.monotonic()
    records = [{"id": 7, "value": 255}, {"id": 2, "value": 144},
               {"id": 7, "value": 42}, {"id": 3, "value": 5}]
    command = [str(ROOT / "contracts/registry/target/debug/registry-sandbox-driver")]
    checks = []
    def check(name, condition):
        if not condition:
            raise AssertionError(name)
        checks.append({"name": name, "pass": True})
    def progress(stage):
        print(stage, flush=True)

    with Journal(output_dir / "events.jsonl") as journal, SandboxDriver(
            command, ROOT, output_dir / "sandbox-stderr.log") as driver:
        ready = driver.receive()
        check("local-only disposable sandbox", ready.get("event") == "ready" and ready.get("local_only") is True)
        calls = Calls(driver)
        identities = ready["identities"]
        roster = sorted(identities[k] for k in ("bidder0", "bidder1", "bidder2"))
        policy = {"profile_id": "clean-4-records-v1", "requires_execution_proof": False,
                  "verification_method": "client_plaintext_reference"}
        spec_hash = sha(canonical({"profile": policy["profile_id"], "records": 4, "version": 1}))
        policy_hash = sha(canonical(policy))
        policy.update(spec_hash=list(bytes.fromhex(spec_hash)), output_policy_hash=list(bytes.fromhex(policy_hash)))
        progress("Preparing genuine FHE input before chain registration")
        with prepare_job(records, output_dir / "fhe") as prepared:
            hashes = dict(prepared.artifact_hashes)
            journal.add("prepared", {"input_sha256": hashes["inputSha256"]})
            now = calls.call("now")
            intent = build_intent(network_domain_hash=ready["network_domain_hash"],
                registry_account=ready["contract_id"], buyer=identities["buyer"], roster=roster,
                qualified=[True] * 3, fixed_fee=0,
                bid_deadline_ns=now["suggested_bid_deadline_ns"], result_deadline_ns=now["suggested_result_deadline_ns"],
                spec_hash=spec_hash, circuit_hash=hashes["serverSha256"], key_hash=hashes["evaluationKeysSha256"],
                input_hash=hashes["inputSha256"], output_policy_hash=policy_hash,
                registry_executor=identities["executor"])
            # Values are synthetic USDC micro-units. Never real client inputs.
            auction = prepare_synthetic(intent, budget=100_000_000, prices=(90_000_000, 80_000_000, 95_000_000))
            config = registry_config(auction)
            job = calls.call("create_job", config=config)["job"]
            verify_args = dict(contract_account=ready["contract_id"], network_domain_hash=ready["network_domain_hash"], expected_config=config)
            check("registered config matches precommit intent", verify_registry_job(job, **verify_args))
            check("no FHE response exists at registration", not (output_dir / "fhe/response.bin").exists())
            jid = job["job_id"]
            journal.add("registered", {"job_sha256": bytes(job["job_binding_hash"]).hex()})
            for slot, actor in enumerate(roster):
                calls.call("bid", actor=actor, job_id=jid, expected_job_binding_hash=job["job_binding_hash"],
                           commitment=list(bytes.fromhex(auction.commitments[slot + 1])))
            closed = calls.call("close", job_id=jid)["job"]
            check("closed full roster/hash matches intent", verify_registry_job(closed, **verify_args))
            journal.add("bids_closed", {"bidset_sha256": bytes(closed["bidset_root"]).hex()})
            manifest = build_selection_manifest(auction, closed)
            save(output_dir / "selection-manifest.json", manifest)
            guard = SelectionGuard(output_dir / "selection-admission.sqlite")
            guard.reserve(bytes(closed["job_binding_hash"]).hex(), bytes(closed["bidset_root"]).hex(), manifest_digest(manifest))
            progress("Running actual three-party malicious-secure MPC")
            mpc_result = run_prepared(auction, closed, timeout=600, port=17400)
            guard.complete(bytes(closed["job_binding_hash"]).hex(), manifest_digest(manifest))
            save(output_dir / "mpc-result.json", mpc_result)
            found, slot, price, total = mpc_result["output"]["buyer"]
            check("real MPC selected expected synthetic winner", [found, slot, price, total] == [1, 2, 80_000_000, 80_000_000])
            winner = roster[slot - 1]
            journal.add("mpc_completed", {"selection_sha256": manifest_digest(manifest)})
            calls.call("begin_execution", actor="hostile", job_id=jid, expected_bidset_root=closed["bidset_root"], selected_executor=winner, reject=True)
            executing = calls.call("begin_execution", job_id=jid, expected_bidset_root=closed["bidset_root"], selected_executor=winner)["job"]
            check("selected executor is actual MPC slot", executing["selected_executor"] == winner)
            check("job immutable across selection", verify_registry_job(executing, **verify_args))
            journal.add("executor_selected", {"attempt_sha256": bytes(executing["attempt_binding_hash"]).hex()})

            # A trusted client verifier below binds acceptance to this exact checked result.
            verification = {"result": None, "output": None, "receipt": None}
            class Verifier:
                def verify(self, bound, delivery, artifact, receipt):
                    return (bound == payment_binding and verification["result"] is not None
                            and verification["result"]["verified"] is True
                            and artifact == verification["output"] and receipt == verification["receipt"])
            payment_binding = Binding(context_hash=auction.context_hash, attempt_id=executing["attempt"],
                job_id=jid, bid_id="synthetic-slot-%d" % slot, assignment_id="fixture-assignment-" + secrets.token_hex(8),
                worker_id=winner, terms_hash=policy_hash, selection_hash=manifest_digest(manifest), price=Money(price))
            rail = LocalFixtureRail(output_dir / "payment-fixture.sqlite")
            rail.register(payment_binding)
            payment = PaymentAdapter(output_dir / "payment-outbox.sqlite", rail, Verifier())
            payment.register(payment_binding)
            payment.perform("award", Action.AWARD, payment_binding)
            held = payment.perform("hold", Action.HOLD, payment_binding)
            check("fixture funds held before evaluation", held.state == State.HELD)
            journal.add("payment_held_fixture")
            binding = {k: executing[k] for k in ("job_id", "attempt")}
            binding.update({k: bytes(executing[k]).hex() for k in ("job_binding_hash", "attempt_binding_hash", "bidset_root")})
            prepared.bind_external(binding)
            journal.add("execution_bound", {"binding_sha256": prepared.artifact_hashes["externalBindingSha256"]})
            progress("Evaluating ciphertext only after registry and fixture hold")
            prepared.evaluate()
            journal.add("evaluated")
            result = prepared.finalize()
            check("genuine FHE reference verification", result["verified"] is True and result["metrics"]["real_fhe"] is True)
            journal.add("client_verified", {"output_sha256": result["artifactHashes"]["outputSha256"]})
            request_bytes = (output_dir / "fhe/request.json").read_bytes()
            receipt_bytes = (output_dir / "fhe/receipt.json").read_bytes()
            kwargs = dict(request_manifest=request_bytes, evaluator_receipt=receipt_bytes,
                expected_registry_attempt=executing["attempt"], expected_engine_attempt_id=json.loads(request_bytes)["attemptId"],
                policy=policy, external_binding=(output_dir / "fhe/binding.json").read_bytes())
            claim = build_receipt_claim(executing, result, **kwargs)
            bad = copy.deepcopy(executing)
            bad["attempt_binding_hash"][0] ^= 1
            try:
                build_receipt_claim(bad, result, **kwargs)
            except BindingError:
                check("SDK rejects substituted attempt", True)
            else:
                raise AssertionError("SDK accepted substituted attempt")
            calls.call("submit_receipt", actor="executor", job_id=jid, claim=claim, reject=True)
            reported = calls.call("submit_receipt", actor=winner, job_id=jid, claim=claim)["job"]
            journal.add("reported")
            calls.call("submit_receipt", actor=winner, job_id=jid, claim=claim, reject=True)
            verification.update(result=result, output=(output_dir / "fhe/response.bin").read_bytes(), receipt=receipt_bytes)
            delivery = Delivery(1, sha(verification["output"]), sha(receipt_bytes))
            payment.perform("submit", Action.SUBMIT, payment_binding, delivery)
            payment.verify_artifact(payment_binding, delivery, verification["output"], receipt_bytes)
            receipt_hash = reported["receipts"][-1]["receipt_hash"]
            calls.call("decide", actor="hostile", job_id=jid, expected_receipt_hash=receipt_hash, accept=True, reject=True)
            accepted = calls.call("decide", job_id=jid, expected_receipt_hash=receipt_hash, accept=True)["job"]
            check("registry accepted exact ciphertext receipt", accepted["state"] == "Accepted" and accepted["receipts"][-1]["claim"] == claim)
            journal.add("accepted")
            payment.perform("accept", Action.ACCEPT, payment_binding, delivery)
            released = payment.perform("release", Action.RELEASE, payment_binding, delivery)
            again = payment.perform("release", Action.RELEASE, payment_binding, delivery)
            check("fixture release once across idempotent retry", released.state == State.RELEASED and again == released and rail.movement_count(payment_binding, "release") == 1)
            journal.add("payment_released_fixture")
            check("evaluation key cleaned", not (output_dir / "fhe/evaluation.keys").exists())
            evidence = {"completed": True, "synthetic_only": True, "external_chain": False,
                "real_fhe": True, "real_mpc": True, "actual_near_sandbox": True,
                "independent_operators": False, "payment_mode": "local_fixture_simulation", "real_payment": False,
                "execution_proof": False, "mpc_winner_verified_by_contract": False,
                "precommitted_workflow": True, "elapsed_seconds": time.monotonic() - start,
                "checks": checks, "rejected_registry_actions": calls.rejections,
                "deployed_wasm_sha256": ready["wasm_sha256"],
                "contract_account": ready["contract_id"], "network_domain_hash": ready["network_domain_hash"],
                "closed_job": closed, "executing_job": executing, "accepted_job": accepted,
                "artifactHashes": result["artifactHashes"], "fhe_metrics": result["metrics"],
                "journal_last_hash": journal.events[-1]["event_sha256"], "payment_state": released.state.value,
                "limits": ["One host/UID; synthetic coordinator knows all fixture bids",
                    "Buyer authorizes selected executor; contract does not prove MPC argmin",
                    "Client reference verification is not public execution proof",
                    "No live Market payment or dispute integration", "Local journal hash chain is not independent timestamp evidence"]}
            save(output_dir / "result.json", evidence)
            progress("Completed real local crypto/chain flow; payment fixture only")
            return evidence


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", type=Path, default=ROOT / "runtime" / ("integration-" + secrets.token_hex(6)))
    args = parser.parse_args()
    result = run(args.output.absolute())
    print(json.dumps({"completed": result["completed"], "evidence": str(args.output.absolute() / "result.json")}))


if __name__ == "__main__":
    main()
