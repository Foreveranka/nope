"""Executable LOCAL SYNTHETIC bridge; centralized inputs, no independent servers.

Runs the existing native harness unchanged. Its normal ignored build/runtime
outputs remain in mpc/; no mpc source/config/transport is modified. stdout emits
public app bindings and explicitly SYNTHETIC native outputs for test evidence.
It never emits salts, signing keys or customer witnesses.
"""
import argparse
import json
import secrets
import time

from mpc.sample_v2 import synthetic_intent, synthetic_closed_job
from mpc.v2 import prepare_synthetic
from mpc.run_v2 import run_prepared


def run(port=19400, timeout=600):
    now = int(time.time() * 1000)
    intent = synthetic_intent(bid_deadline_ns=str((now - 1000) * 1000000),
                              result_deadline_ns=str((now + 3600000) * 1000000))
    prepared = prepare_synthetic(intent, budget=100, prices=[90, 80, 95])
    job_id = secrets.token_hex(16)
    closed = synthetic_closed_job(prepared)
    result = run_prepared(prepared, closed, port=port, timeout=timeout)
    # Existing runtime already checks all native/client exits and private outputs
    # against the synthetic reference. Never substitute an oracle if it fails.
    if result["status"] != "VERIFIED_LOCAL_MPC" or result["codecVersion"] != 2:
        raise RuntimeError("native v2 selection did not complete")
    job = dict(id=job_id, title="Synthetic operator integration", profile="clean-4-records-v1",
               buyer=intent["buyer"], roster=intent["roster"],
               bidDeadlineNs=intent["bidDeadlineNs"], resultDeadlineNs=intent["resultDeadlineNs"],
               status="CLOSED", revision=5, createdAt=now-2000, updatedAt=now,
               ledger="app", blockchainBinding="pending", intent=intent,
               contextHash=prepared.context_hash, budgetCommitment=prepared.commitments[0],
               bids=[dict(provider=p, slot=i+1, commitment=prepared.commitments[i+1])
                     for i, p in enumerate(intent["roster"])],
               closedAt=now, selection=None, deliveries=[], decision=None)
    return dict(schema="veil-local-mpc-selection-v1", job=job,
                selectedProvider=result["selectedExecutor"],
                runtime=dict(status=result["status"], manifestHash=result["manifestHash"],
                             runtimeIdentity=result["runtimeIdentity"],
                             runtimeSeconds=result["runtimeSeconds"],
                             registryMetadata="fabricated-local-fixture",
                             privateInputs="centralized-synthetic-only",
                             independentOperators=False, chainFinalityVerified=False,
                             executionProof=False,
                             syntheticNativeResult={k: v for k, v in result.items() if k != "session"}))


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--port", type=int, default=19400)
    parser.add_argument("--timeout", type=int, default=600)
    args = parser.parse_args()
    print(json.dumps(run(args.port, args.timeout), sort_keys=True))


if __name__ == "__main__":
    main()
