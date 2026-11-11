"""One authorized synthetic FHE job through the real hosted gateway.

Consumes one invitation allocation, without automatic mutation retries. Does not
write plaintext/secret keys or print bearer tokens and signed object URLs.
"""
import argparse
import json
import sys
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
from engine.pipeline import prepare_remote_job, reference_result
from service.remote import RemoteClient


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--invitation", required=True, type=Path)
    parser.add_argument("--run", required=True, type=Path)
    parser.add_argument("--url", default="https://veil-procurement.vercel.app")
    args = parser.parse_args()
    run = args.run.resolve()
    run.relative_to(ROOT / "runtime")
    run.mkdir(mode=0o700, parents=True, exist_ok=False)
    invitation = json.loads(args.invitation.read_text())
    client = RemoteClient(args.url, invitation["token"], run / "transport")
    records = [{"id": 10, "value": 255}, {"id": 20, "value": 42},
               {"id": 10, "value": 150}, {"id": 30, "value": 100}]
    stages = []
    started = time.monotonic()

    def stage(name, _message):
        stages.append({"stage": name, "elapsedSeconds": round(time.monotonic() - started, 3)})
        print(json.dumps(stages[-1]), flush=True)

    try:
        with prepare_remote_job(records, run / "encrypted-job", on_stage=stage) as job:
            job.evaluate_remote(client.evaluate)
            result = job.finalize()
        if not result["verified"] or result["records"] != reference_result(records):
            raise RuntimeError("Independent expected result mismatch")
        evidence = {"status": "PASS", "syntheticOnly": True, "gateway": args.url,
                    "stages": stages, "metrics": result["metrics"],
                    "artifactHashes": result["artifactHashes"],
                    "localReferenceMatched": True, "realPayments": False,
                    "independentMpcOperators": False, "executionProof": False}
    except Exception as exc:
        # Exception type only: nested provider/network text may contain signed URLs.
        evidence = {"status": "FAIL", "failureClass": type(exc).__name__, "stages": stages,
                    "elapsedSeconds": round(time.monotonic() - started, 3)}
    (run / "result.json").write_text(json.dumps(evidence, indent=2) + "\n")
    print(json.dumps(evidence, indent=2), flush=True)
    return 0 if evidence["status"] == "PASS" else 1


if __name__ == "__main__":
    sys.exit(main())
