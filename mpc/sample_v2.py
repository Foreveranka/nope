"""Importable synthetic prepare/close/run example. No registry transaction.

Use `python3 -m mpc.sample_v2` for public preparation only; add --run for actual
local MPC. A real local-sandbox orchestrator replaces synthetic_closed_job with
its post-close job view; no begin_attempt call may precede run_selection.
"""
import argparse
import json

from .v2 import (build_intent, prepare_synthetic, registry_config,
                 registry_job_hash, registry_bidset_root, build_selection_manifest, manifest_digest)
from .run_v2 import run_selection


def synthetic_intent(**overrides):
    args = dict(network_domain_hash="42" * 32, registry_account="registry.test.near", buyer="buyer.near",
                roster=["alpha.near", "beta.near", "gamma.near"], qualified=[True, True, True], fixed_fee=0,
                bid_deadline_ns="100", result_deadline_ns="200", registry_executor="executor.near",
                spec_hash="01" * 32, circuit_hash="02" * 32, key_hash="03" * 32,
                input_hash="04" * 32, output_policy_hash="05" * 32)
    args.update(overrides)
    return build_intent(**args)


def synthetic_closed_job(prepared, job_id="1"):
    """Explicitly fabricated local metadata; NOT a sandbox/finality result."""
    job = dict(job_id=job_id, buyer=prepared.intent["buyer"], config=registry_config(prepared),
               state="Closed", bids=[{"bidder": a, "commitment": list(bytes.fromhex(c))}
               for a, c in zip(prepared.intent["roster"], prepared.commitments[1:])],
               closed_at_ns=prepared.intent["bidDeadlineNs"], attempt="0", attempt_binding_hash=None,
               receipts=[], selected_executor=None, attempt_binding_version=None)
    job["job_binding_hash"] = list(bytes.fromhex(registry_job_hash(prepared.intent, job)))
    job["bidset_root"] = list(bytes.fromhex(registry_bidset_root(job)))
    return job


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--run", action="store_true")
    parser.add_argument("--port", type=int, default=16400)
    args = parser.parse_args()
    prepared = prepare_synthetic(synthetic_intent(), budget=100, prices=[90, 80, 95])
    closed = synthetic_closed_job(prepared)
    manifest = build_selection_manifest(prepared, closed)
    print(json.dumps({"syntheticRegistryMetadata": True, "precommitContext": prepared.context_hash,
                      "commitments": prepared.commitments, "registryConfig": registry_config(prepared),
                      "selectionManifestHash": manifest_digest(manifest)}, indent=2), flush=True)
    if args.run:
        print(json.dumps(run_selection(prepared, closed, port=args.port), indent=2), flush=True)


if __name__ == "__main__":
    main()
