#!/usr/bin/env python3
"""Independently inspect local integration artifacts before exporting public evidence."""
import hashlib
import json
import sqlite3
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
from sdk.registry import verify_registry_job
from sdk.receipt import _attempt_hash, _claim_hash
from mpc.v2 import manifest_digest
from integration.journal import STAGES


def sha(blob):
    return hashlib.sha256(blob).hexdigest()


def archive(directory):
    directory = directory.resolve()
    if ROOT / "runtime" not in directory.parents:
        raise ValueError("Only this project's runtime evidence is accepted")
    result = json.loads((directory / "result.json").read_bytes())
    if not result["completed"] or result["real_payment"] or result["external_chain"]:
        raise ValueError("Unexpected integration evidence mode")
    checks = []
    def check(name, okay):
        if not okay:
            raise AssertionError(name)
        checks.append(name)
    events = [json.loads(l) for l in (directory / "events.jsonl").read_bytes().splitlines()]
    previous = "0" * 64
    check("all stages recorded", [e["stage"] for e in events] == list(STAGES))
    for n, event in enumerate(events):
        payload = {k:v for k,v in event.items() if k != "event_sha256"}
        check("journal stage %d" % n, event["sequence"] == n and event["previous_sha256"] == previous
              and sha(json.dumps(payload, sort_keys=True, separators=(",", ":")).encode()) == event["event_sha256"])
        previous = event["event_sha256"]
    check("journal tail bound", previous == result["journal_last_hash"])
    for label in ("closed_job", "executing_job", "accepted_job"):
        check(label + " hash", verify_registry_job(result[label], contract_account=result["contract_account"], network_domain_hash=result["network_domain_hash"]))
    executing, accepted = result["executing_job"], result["accepted_job"]
    check("selected attempt hash", _attempt_hash(executing, int(executing["attempt"])) == bytes(executing["attempt_binding_hash"]))
    claim = accepted["receipts"][-1]["claim"]
    check("receipt hash", _claim_hash(claim) == bytes(accepted["receipts"][-1]["receipt_hash"]))
    files = {"serverSha256":"server.zip", "clientSpecsSha256":"client-specs.json", "inputSha256":"request.bin",
             "outputSha256":"response.bin", "requestManifestSha256":"request.json", "receiptSha256":"receipt.json", "externalBindingSha256":"binding.json"}
    for key, filename in files.items():
        check(filename + " hash", sha((directory / "fhe" / filename).read_bytes()) == result["artifactHashes"][key])
    check("evaluation key deleted", not (directory / "fhe/evaluation.keys").exists())
    mpc = json.loads((directory / "mpc-result.json").read_bytes())
    manifest = json.loads((directory / "selection-manifest.json").read_bytes())
    check("MPC manifest hash", manifest_digest(manifest) == mpc["manifestHash"])
    check("MPC selected executor matches chain", mpc["selectedExecutor"] == executing["selected_executor"] == accepted["selected_executor"])
    check("MPC transient keys deleted", not list(Path(mpc["session"]).glob("*/Player-Data/*.key")))
    with sqlite3.connect("file:" + str(directory / "payment-fixture.sqlite") + "?mode=ro", uri=True) as db:
        movements = db.execute("SELECT kind, micros FROM fixture_movements ORDER BY kind").fetchall()
    check("fixture hold/release exact once", movements == [("hold", 80_000_000), ("release", 80_000_000)])
    with sqlite3.connect("file:" + str(directory / "selection-admission.sqlite") + "?mode=ro", uri=True) as db:
        rows = db.execute("SELECT state FROM selections").fetchall()
    check("durable selection complete once", rows == [("COMPLETED",)])
    result["public_events"] = [{k:e[k] for k in ("stage", "elapsed_seconds")} for e in events]
    target = ROOT / "docs/verification"
    target.mkdir(exist_ok=True)
    (target / "e2e-local-result.json").write_text(json.dumps(result, indent=2) + "\n")
    report = {"source": str(directory.relative_to(ROOT)), "checks": checks, "passed": len(checks),
              "result_source_sha256": sha((directory / "result.json").read_bytes()),
              "limits": "Artifact recomputation, not independent real-world parties or execution proof. Payment is simulation."}
    (target / "e2e-artifact-audit.json").write_text(json.dumps(report, indent=2) + "\n")
    print(json.dumps({"checks_passed": len(checks), "export": str(target / "e2e-local-result.json")}))


if __name__ == "__main__":
    archive(Path(sys.argv[1]))
