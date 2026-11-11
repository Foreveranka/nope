"""Actual v2 malicious SPDZ2k regressions; no oracle-only/passive fallback."""
import argparse
import copy
import json
import time
from pathlib import Path

from .run_local import ROOT, execute_fixture, hash_file, runtime_identity
from .run_v2 import run_prepared
from .sample_v2 import synthetic_closed_job, synthetic_intent
from .v2 import prepare_synthetic, build_selection_manifest, manifest_digest

CASES = ("good", "bad-bid-commitment", "bad-budget-commitment", "client-manifest-disagreement")


def run_case(case, port=16400, timeout=600):
    prepared = prepare_synthetic(synthetic_intent())
    job = synthetic_closed_job(prepared)
    manifest = build_selection_manifest(prepared, job)
    if case == "good":
        result = run_prepared(prepared, job, timeout=timeout, port=port)
        session = Path(result["session"])
        if list(session.rglob("*.key")) or list(session.glob("*/Player-Data")):
            raise AssertionError("successful session retained keys")
        result["fixtureKeysRemoved"] = True
        return result
    if case not in CASES:
        raise ValueError("unknown real v2 case")
    session_pattern = "v2-" + case + "-*"
    before = set((ROOT / "runtime").glob(session_pattern))
    amounts = list(prepared.amounts)
    expected_reason = "invalid sealed input"
    client_manifests = None
    if case == "bad-bid-commitment":
        # Change the submitted private bid, NOT the registry/manifest commitment.
        # A host-side precheck would not count as a cryptographic rejection.
        amounts[2] += 1
    elif case == "bad-budget-commitment":
        amounts[0] += 1
    else:
        # Different valid snapshot; unchanged commitments; all three operators
        # MUST reject a disagreeing public manifest digest from client C3.
        other = copy.deepcopy(manifest)
        other["closedJob"]["closed_at_ns"] = "101"
        assert manifest_digest(other) != manifest_digest(manifest)
        client_manifests = {3: other}
        expected_reason = "manifest context mismatch"
    try:
        execute_fixture(manifest, amounts, prepared.salts, case="v2-" + case,
                        timeout=timeout, port=port, codec_version=2,
                        test_client_manifests=client_manifests)
    except RuntimeError as exc:
        if str(exc) not in ("private output rejected or computation aborted", "client failed during authenticated connection"):
            raise
        sessions = set((ROOT / "runtime").glob(session_pattern)) - before
        if len(sessions) != 1:
            raise AssertionError("ambiguous abort session") from exc
        session = sessions.pop()
        logs = [(session / ("party%d.log" % i)).read_text(errors="replace") for i in range(3)]
        if not all(expected_reason in log for log in logs):
            raise AssertionError("not all actual parties rejected for expected reason") from exc
        if list(session.rglob("*.key")) or list(session.glob("*/Player-Data")):
            raise AssertionError("aborted session retained keys") from exc
        return {"case": case, "status": "VERIFIED_MPC_ABORT", "reason": expected_reason,
                "allThreePartiesRejected": True, "fixtureKeysRemoved": True, "session": str(session),
                "manifestHash": manifest_digest(manifest), "runtimeIdentity": runtime_identity(),
                "codecVersion": 2, "circuitSourceHash": hash_file(ROOT / "programs/sealed_procurement_v2.mpc"),
                "independentOperators": False, "chainFinalityVerified": False}
    raise AssertionError("malformed fixture was accepted")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--cases", nargs="+", choices=CASES, default=CASES)
    parser.add_argument("--port", type=int, default=16400)
    parser.add_argument("--timeout", type=int, default=600)
    args = parser.parse_args()
    results = []
    for case in args.cases:
        print("Running genuine v2 SPDZ2k: " + case, flush=True)
        result = run_case(case, args.port, args.timeout)
        results.append(result)
        print(json.dumps(result), flush=True)
        (ROOT / "evidence/v2-runtime-results.json").write_text(json.dumps({
            "generatedAtUnix": time.time(), "syntheticLocalProcessesOnly": True,
            "syntheticRegistryMetadata": True, "chainFinalityVerified": False, "results": results}, indent=2) + "\n")


if __name__ == "__main__":
    main()
