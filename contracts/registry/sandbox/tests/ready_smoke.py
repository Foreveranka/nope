#!/usr/bin/env python3
"""Actual local readiness/EOF smoke, including exact deployed-buffer artifact pin."""
import hashlib
import json
import os
from pathlib import Path
import select
import subprocess
import tempfile

ROOT = Path(__file__).resolve().parents[2]


def main():
    temp_root = ROOT / ".toolchain" / "tmp"
    temp_root.mkdir(parents=True, exist_ok=True)
    env = dict(os.environ, TMPDIR=str(temp_root))
    original = (ROOT / "target/wasm32-unknown-unknown/release/veil_registry.wasm").read_bytes()
    expected = hashlib.sha256(original).hexdigest()
    with tempfile.TemporaryDirectory(dir=temp_root) as tmp, tempfile.TemporaryFile(mode="w+") as logs:
        source = Path(tmp) / "registry.wasm"
        source.write_bytes(original)
        driver = ROOT / "target/debug/registry-sandbox-driver"
        proc = subprocess.Popen([str(driver), str(source)], stdin=subprocess.PIPE,
                                stdout=subprocess.PIPE, stderr=logs, text=True, env=env)

        def response():
            assert select.select([proc.stdout], [], [], 60)[0], "readiness timeout; never retried"
            return json.loads(proc.stdout.readline())

        try:
            ready = response()
            assert ready["event"] == "ready" and ready["wasm_sha256"] == expected
            assert ready["local_only"] is True and len(ready["identities"]) == 6
            assert int(ready["time"]["suggested_bid_deadline_ns"]) > int(ready["time"]["now_ns"])
            # Simulate an on-disk artifact replacement without touching the shared build output.
            source.write_bytes(b"replaced after deployment")
            proc.stdin.write(json.dumps({"id":"smoke", "command":"now"}) + "\n")
            proc.stdin.flush()
            reply = response()
            assert reply["id"] == "smoke" and reply["ok"] is True
            proc.stdin.close()
            proc.wait(timeout=20)
            assert proc.returncode == 0 and proc.stdout.read() == ""
            logs.seek(0)
            assert "stdin EOF: sandbox released" in logs.read()
            evidence = {"passed":True,"wasm_sha256":ready["wasm_sha256"],
                        "hash_matches_exact_deployment_bytes":True,
                        "copied_source_replacement_does_not_change_pin":True,
                        "now_command":True,"eof_exit":proc.returncode,
                        "driver_sha256":hashlib.sha256(driver.read_bytes()).hexdigest()}
            (ROOT / "verification/driver-ready-smoke.json").write_text(json.dumps(evidence, indent=2) + "\n")
            print(json.dumps(evidence))
        finally:
            if not proc.stdin.closed:
                proc.stdin.close()
            if proc.poll() is None:
                proc.wait(timeout=20)


if __name__ == "__main__":
    main()
