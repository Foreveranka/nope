#!/usr/bin/env python3
"""Real Python -> persistent Rust JSONL -> local sandbox Wasm, synthetic hashes only."""
import hashlib
import json
import os
from pathlib import Path
import select
import struct
import subprocess
import sys
import tempfile
import time

ROOT = Path(__file__).resolve().parents[2]


def frame(s):
    b = s.encode()
    return struct.pack("<I", len(b)) + b


def attempt_hash(job):
    b = frame("veil/attempt/v2") + bytes(job["job_binding_hash"])
    b += bytes(job["bidset_root"]) + struct.pack("<Q", int(job["attempt"]))
    return list(hashlib.sha256(b + frame(job["selected_executor"])).digest())


def claim(job):
    result = {k: job["config"][k] for k in (
        "spec_hash", "circuit_hash", "key_hash", "output_policy_hash", "context_hash",
        "input_hash", "budget_commitment")}
    result.update({k: job[k] for k in (
        "job_id", "attempt", "job_binding_hash", "attempt_binding_hash", "bidset_root")})
    result["output_hash"] = [18] * 32
    return result


def main():
    # Scope near-sandbox downloads/temp paths to owned ignored paths as well.
    env = os.environ.copy()
    temp_root = ROOT / ".toolchain" / "tmp"
    temp_root.mkdir(parents=True, exist_ok=True)
    env["TMPDIR"] = str(temp_root)
    driver = ROOT / "target" / "debug" / "registry-sandbox-driver"
    with tempfile.TemporaryFile(mode="w+") as logs:
        proc = subprocess.Popen([str(driver)], stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                                stderr=logs, text=True, bufsize=1, env=env)
        sequence = 0

        def read_line():
            if not select.select([proc.stdout], [], [], 120)[0]:
                raise TimeoutError("driver response timeout: never retried")
            line = proc.stdout.readline()
            assert line, "driver exited unexpectedly"
            return json.loads(line)

        def request(command, ok=True, **kwargs):
            nonlocal sequence
            sequence += 1
            proc.stdin.write(json.dumps(dict(id=sequence, command=command, **kwargs)) + "\n")
            proc.stdin.flush()
            reply = read_line()
            assert reply["id"] == sequence, reply
            assert reply["ok"] is ok, reply
            return reply.get("result", reply)

        def unchanged(job_id, command, **kwargs):
            before = request("view", job_id=job_id)["job"]
            request(command, ok=False, job_id=job_id, **kwargs)
            assert request("view", job_id=job_id)["job"] == before

        try:
            ready = read_line()
            assert ready["event"] == "ready" and ready["local_only"] is True
            assert len(ready["wasm_sha256"]) == 64
            ids = ready["identities"]
            now = request("now")
            config = {k: [i] * 32 for i, k in enumerate((
                "spec_hash", "circuit_hash", "key_hash", "output_policy_hash", "context_hash",
                "input_hash", "budget_commitment"), 1)}
            config.update(bid_deadline_ns=now["suggested_bid_deadline_ns"],
                          result_deadline_ns=now["suggested_result_deadline_ns"],
                          authorized_bidders=[ids[f"bidder{i}"] for i in range(3)],
                          executor=ids["executor"])
            j = request("create_job", config=config)["job"]
            other = request("create_job", config=config)["job"]
            job_id = j["job_id"]
            original_binding = j["job_binding_hash"]
            original_config = j["config"]
            unchanged(job_id, "begin_execution", selected_executor=ids["bidder0"],
                      expected_bidset_root=[9] * 32)
            for job in (j, other):
                for i in range(2):
                    request("bid", job_id=job["job_id"], actor=f"bidder{i}",
                            expected_job_binding_hash=job["job_binding_hash"], commitment=[9+i] * 32)
            closed = request("close", job_id=job_id)["job"]
            assert closed["state"] == "Closed"
            assert int(request("now")["now_ns"]) >= int(config["bid_deadline_ns"])
            root = closed["bidset_root"]
            for actor, selected in (("hostile", "bidder0"), ("bidder0", "bidder0"),
                                    ("buyer", "hostile"), ("buyer", "bidder2")):
                unchanged(job_id, "begin_execution", actor=actor, selected_executor=ids[selected],
                          expected_bidset_root=root)
            unchanged(job_id, "begin_execution", selected_executor=ids["bidder0"],
                      expected_bidset_root=[99] * 32)
            executing = request("begin_execution", job_id=job_id,
                                selected_executor=ids["bidder0"], expected_bidset_root=root)["job"]
            assert executing["attempt_binding_version"] == 2
            assert executing["selected_executor"] == ids["bidder0"]
            assert executing["job_binding_hash"] == original_binding
            assert executing["config"] == original_config
            assert executing["attempt_binding_hash"] == attempt_hash(executing)
            unchanged(job_id, "begin_execution", selected_executor=ids["bidder1"],
                      expected_bidset_root=root)
            c = claim(executing)
            for actor in ("executor", "buyer", "bidder1", "hostile"):
                unchanged(job_id, "submit_receipt", actor=actor, claim=c)
            wrong = dict(c, attempt_binding_hash=[90] * 32)
            unchanged(job_id, "submit_receipt", actor="bidder0", claim=wrong)
            receipt = request("submit_receipt", job_id=job_id, actor="bidder0", claim=c)["value"]
            unchanged(job_id, "submit_receipt", actor="bidder0", claim=c)
            unchanged(job_id, "decide", actor="bidder0", expected_receipt_hash=receipt, accept=True)
            request("decide", job_id=job_id, expected_receipt_hash=receipt, accept=False)
            unchanged(job_id, "begin_execution", selected_executor=ids["bidder1"],
                      expected_bidset_root=root)
            unchanged(job_id, "begin_execution", expected_bidset_root=root)
            retry = request("begin_execution", job_id=job_id, selected_executor=ids["bidder0"],
                            expected_bidset_root=root)["job"]
            assert retry["attempt"] == "2" and retry["attempt_binding_hash"] == attempt_hash(retry)
            unchanged(job_id, "submit_receipt", actor="bidder0", claim=c)
            # Other-job routing fails even when attacker changes claim.job_id to the live target.
            other = request("close", job_id=other["job_id"])["job"]
            other = request("begin_execution", job_id=other["job_id"],
                            selected_executor=ids["bidder0"],
                            expected_bidset_root=other["bidset_root"])["job"]
            unchanged(other["job_id"], "submit_receipt", actor="bidder0",
                      claim=dict(c, job_id=other["job_id"]))
            final_receipt = request("submit_receipt", job_id=job_id,
                                    actor="bidder0", claim=claim(retry))["value"]
            unchanged(job_id, "decide", expected_receipt_hash=receipt, accept=True)
            accepted = request("decide", job_id=job_id,
                               expected_receipt_hash=final_receipt, accept=True)["job"]
            assert accepted["state"] == "Accepted"
            assert [r["status"] for r in accepted["receipts"]] == ["BuyerRejected", "BuyerAccepted"]
            assert accepted["config"] == original_config and accepted["job_binding_hash"] == original_binding
            # Protocol error recovery keeps the same live sandbox usable.
            proc.stdin.write("{bad json\n")
            proc.stdin.flush()
            assert read_line()["ok"] is False
            assert request("view", job_id=job_id)["job"] == accepted
            process_rows = subprocess.check_output(
                ["ps", "-axo", "pid=,ppid=,comm="], text=True).splitlines()
            sandbox_pids = [int(row.split(None, 2)[0]) for row in process_rows
                            if len(row.split(None, 2)) == 3
                            and int(row.split(None, 2)[1]) == proc.pid
                            and "near-sandbox" in row.split(None, 2)[2]]
            assert sandbox_pids, "expected an actual child sandbox process"
            proc.stdin.close()
            proc.wait(timeout=20)
            assert proc.returncode == 0
            assert proc.stdout.read() == "", "nonprotocol stdout"
            logs.seek(0)
            diagnostics = logs.read()
            assert "stdin EOF: sandbox released" in diagnostics
            assert '"event":"buyer_authorized_executor"' in diagnostics
            assert '"mpc_proof_verified":false' in diagnostics
            for sandbox_pid in sandbox_pids:
                for _ in range(40):
                    try:
                        os.kill(sandbox_pid, 0)
                    except ProcessLookupError:
                        break
                    time.sleep(0.05)
                else:
                    raise AssertionError("sandbox child still exists after EOF cleanup")
            summary = {"passed":True,"scope":"actual Python JSONL -> Rust -> sandbox Wasm",
                "requests":sequence,"independent_v2_hash":True,"selection_immutable":True,
                "config_and_job_hash_preserved":True,"unauthorized_selection_rejected":True,
                "replay_and_result_routing_rejected":True,"eof_exit":proc.returncode,
                "sandbox_child_exit_verified":True,
                "fhe_or_mpc_computation_in_this_test":False}
            evidence = dict(summary, accepted_job=accepted, contract_id=ready["contract_id"],
                            network_domain_hash=ready["network_domain_hash"],
                            wasm_sha256=ready["wasm_sha256"],
                            driver_sha256=hashlib.sha256(driver.read_bytes()).hexdigest())
            (ROOT / "verification" / "driver-e2e.json").write_text(json.dumps(evidence, indent=2) + "\n")
            print(json.dumps(summary))
        except BaseException:
            if proc.stdin and not proc.stdin.closed:
                proc.stdin.close()
            try:
                proc.wait(timeout=20)
            except subprocess.TimeoutExpired:
                proc.terminate()
                proc.wait(timeout=10)
            logs.seek(0)
            print(logs.read(), file=sys.stderr)
            raise


if __name__ == "__main__":
    main()
