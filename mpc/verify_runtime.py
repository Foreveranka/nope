#!/usr/bin/env python3
"""Expensive real three-party tests. No simulated or Fake-Offline fallback."""
import argparse
import json
import sys
import time
from pathlib import Path

if not __package__:
    sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from mpc.run_local import CASES, ROOT, run_case, hash_file, runtime_identity


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--cases", nargs="+", choices=list(CASES), default=list(CASES))
    parser.add_argument("--timeout", type=int, default=600)
    args = parser.parse_args()
    evidence = ROOT / "evidence/runtime-results.json"
    # Preserve completed cases/sessions when adding selected new cases.
    results = json.loads(evidence.read_text())["results"] if evidence.exists() else []
    for case in args.cases:
        print("Running actual SPDZ2k: " + case, flush=True)
        before = set((ROOT / "runtime").glob(case + "-*")) if (ROOT / "runtime").exists() else set()
        expected_abort = case in ("wrong-commitment", "negative-ring-input", "overflow-ring-input")
        try:
            result = run_case(case, args.timeout)
            if expected_abort:
                raise AssertionError("malformed sealed input was accepted")
        except RuntimeError as exc:
            new = set((ROOT / "runtime").glob(case + "-*")) - before
            if (not expected_abort or len(new) != 1 or
                    str(exc) != "private output rejected or computation aborted"):
                raise
            session = new.pop()
            logs = [(session / ("party%d.log" % i)).read_text(errors="replace") for i in range(3)]
            # A timeout, build failure, transport error or missing runtime is NOT
            # a successful cryptographic rejection test.
            if not all("invalid sealed input" in text for text in logs):
                raise AssertionError("expected sealed-input rejection on all parties") from exc
            if list(session.rglob("*.key")) or list(session.glob("*/Player-Data")):
                raise AssertionError("aborted session retained fixture keys or party state") from exc
            result = {"case": case, "status": "VERIFIED_MPC_ABORT",
                      "session": str(session), "reason": "invalid sealed input",
                      "allThreePartiesRejected": True, "fixtureKeysRemoved": True,
                      "runtimeIdentity": runtime_identity(), "transportGeneration": "peer-leaf-pin-v1",
                      "circuitSourceHash": hash_file(ROOT / "programs/sealed_procurement.mpc")}
        results.append(result)
        print(json.dumps(result), flush=True)
        (ROOT / "evidence/runtime-results.json").write_text(json.dumps(
            {"generatedAtUnix": time.time(), "results": results,
             "syntheticLocalProcessesOnly": True, "nearBindingVerified": False}, indent=2) + "\n")


if __name__ == "__main__":
    main()
