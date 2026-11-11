import json
import os
import signal
import subprocess
import sys
import tempfile
import time
import unittest
from pathlib import Path
from unittest.mock import patch

from integration.driver import SandboxDriver, DriverError
from integration.journal import Journal, STAGES


class FastCleanupDriver(SandboxDriver):
    EOF_TIMEOUT = .15
    TERMINATE_TIMEOUT = .15
    KILL_TIMEOUT = 1
    READER_TIMEOUT = .5


def process_running(pid):
    result = subprocess.run(["ps", "-p", str(pid), "-o", "stat="],
                            capture_output=True, text=True, timeout=2)
    # An orphan zombie has exited and holds no pipe; init may reap it later.
    return bool(result.stdout.strip()) and not result.stdout.strip().startswith("Z")


class TransportTests(unittest.TestCase):
    def test_roundtrip_owned_child_shutdown(self):
        with tempfile.TemporaryDirectory() as tmp:
            code = 'import sys,json; print(json.dumps({"ready":True}),flush=True);\nfor l in sys.stdin: print(l.strip(),flush=True)'
            with SandboxDriver([sys.executable, "-u", "-c", code], tmp,
                               Path(tmp) / "stderr.log", timeout=2) as d:
                self.assertEqual(d.receive(), {"ready": True})
                self.assertEqual(d.request({"op": "view"}), {"op": "view"})
            self.assertIsNotNone(d.process.returncode)
            self.assertFalse(d.reader.is_alive())

    def test_forced_timeout_kills_owned_tree_and_never_retries(self):
        # Both processes ignore TERM. The grandchild deliberately inherits stdout,
        # reproducing the pipe that previously deadlocked TextIO.close().
        child = ('import json,os,signal,time; signal.signal(signal.SIGTERM,signal.SIG_IGN); '
                 'print(json.dumps({"child":os.getpid(),"group":os.getpgrp()}),flush=True); time.sleep(6)')
        parent = ('import signal,subprocess,sys,time; signal.signal(signal.SIGTERM,signal.SIG_IGN); '
                  'subprocess.Popen([sys.executable,"-u","-c",%r]); '
                  'sys.stdin.readline(); time.sleep(6)') % child
        with tempfile.TemporaryDirectory() as tmp:
            # A separately owned process must survive all cleanup signals.
            unrelated = subprocess.Popen([sys.executable, "-c", "import time; time.sleep(120)"],
                                         start_new_session=True)
            d = FastCleanupDriver([sys.executable, "-u", "-c", parent], tmp,
                                  Path(tmp) / "stderr.log", timeout=2)
            try:
                with d:
                    ready = d.receive()
                    self.assertEqual(ready["group"], d.process.pid)
                    self.assertNotEqual(ready["group"], os.getpgrp())
                    d.timeout = .05
                    with self.assertRaisesRegex(DriverError, "UNKNOWN"):
                        d.request({"op": "award"})
                    with self.assertRaisesRegex(DriverError, "no mutation retry"):
                        d.request({"op": "award"})
                    cleanup_started = time.monotonic()
                self.assertLess(time.monotonic() - cleanup_started, 4)
                self.assertIsNotNone(d.process.returncode)
                self.assertFalse(d.reader.is_alive())
                self.assertTrue(d.process.stdout.closed)
                self.assertFalse(process_running(ready["child"]))
                self.assertIsNone(unrelated.poll())
            finally:
                if d.process is not None:
                    d._signal_group(signal.SIGKILL)
                unrelated.terminate()
                unrelated.wait(timeout=3)

    def test_exited_leader_does_not_leave_child_holding_stdout(self):
        child = ('import json,os,signal,time; signal.signal(signal.SIGTERM,signal.SIG_IGN); '
                 'print(json.dumps({"child":os.getpid()}),flush=True); time.sleep(6)')
        parent = 'import subprocess,sys; subprocess.Popen([sys.executable,"-u","-c",%r])' % child
        with tempfile.TemporaryDirectory() as tmp:
            d = FastCleanupDriver([sys.executable, "-u", "-c", parent], tmp,
                                  Path(tmp) / "stderr.log", timeout=2)
            try:
                with d:
                    ready = d.receive()
                    self.assertEqual(d.process.wait(timeout=2), 0)
                    cleanup_started = time.monotonic()
                self.assertLess(time.monotonic() - cleanup_started, 4)
                self.assertFalse(d.reader.is_alive())
                self.assertTrue(d.process.stdout.closed)
                self.assertFalse(process_running(ready["child"]))
            finally:
                if d.process is not None:
                    d._signal_group(signal.SIGKILL)

    @unittest.skipUnless(os.environ.get("VEIL_TEST_ACTUAL_SANDBOX") == "1",
                         "opt-in disposable real sandbox; no live browser instance is used")
    def test_actual_sandbox_sigstop_cleanup(self):
        root = Path(__file__).resolve().parents[2]
        binary = root / "contracts/registry/target/debug/registry-sandbox-driver"
        if not binary.is_file():
            self.skipTest("build registry-sandbox-driver first")
        class ActualCleanupDriver(FastCleanupDriver):
            TERMINATE_TIMEOUT = 1
            KILL_TIMEOUT = 2
            READER_TIMEOUT = 2
        with tempfile.TemporaryDirectory(prefix="veil-isolated-cleanup-") as tmp:
            with patch.dict(os.environ, {"TMPDIR": tmp}):
                d = ActualCleanupDriver([str(binary)], root, Path(tmp) / "stderr.log", timeout=60)
                try:
                    with d:
                        self.assertEqual(d.receive()["event"], "ready")
                        rows = subprocess.check_output(["ps", "-axo", "pid=,ppid=,comm="],
                                                       text=True).splitlines()
                        children = [int(parts[0]) for row in rows
                                    if len(parts := row.split(None, 2)) == 3
                                    and int(parts[1]) == d.process.pid and "near-sandbox" in parts[2]]
                        self.assertTrue(children, "expected this driver's real sandbox child")
                        self.assertEqual(os.getpgid(d.process.pid), d.process.pid)
                        self.assertTrue(all(os.getpgid(pid) == d.process.pid for pid in children))
                        os.kill(d.process.pid, signal.SIGSTOP)
                        cleanup_started = time.monotonic()
                    self.assertLess(time.monotonic() - cleanup_started, 8)
                    self.assertIsNotNone(d.process.returncode)
                    self.assertFalse(d.reader.is_alive())
                    self.assertTrue(d.process.stdout.closed)
                    self.assertTrue(all(not process_running(pid) for pid in children))
                finally:
                    if d.process is not None:
                        d._signal_group(signal.SIGKILL)

    def test_timeout_blocks_mutation_retries(self):
        with tempfile.TemporaryDirectory() as tmp:
            code = 'import sys,time; sys.stdin.readline(); time.sleep(.5)'
            with SandboxDriver([sys.executable, "-u", "-c", code], tmp,
                               Path(tmp) / "stderr.log", timeout=.05) as d:
                with self.assertRaisesRegex(DriverError, "UNKNOWN"):
                    d.request({"op": "award"})
                with self.assertRaisesRegex(DriverError, "no mutation retry"):
                    d.request({"op": "award"})

    def test_bad_response_rejected(self):
        with tempfile.TemporaryDirectory() as tmp:
            with SandboxDriver([sys.executable, "-c", 'print("not-json")'], tmp,
                               Path(tmp) / "stderr.log", timeout=2) as d:
                with self.assertRaisesRegex(DriverError, "Invalid"):
                    d.receive()

    def test_journal_order_and_no_plaintext(self):
        with tempfile.TemporaryDirectory() as tmp:
            p = Path(tmp) / "journal.jsonl"
            with Journal(p) as j:
                with self.assertRaises(ValueError):
                    j.add("registered")
                with self.assertRaises(ValueError):
                    j.add("prepared", {"budget": 100})
                for stage in STAGES:
                    j.add(stage, {"manifest_sha256": "a" * 64})
                with self.assertRaises(ValueError):
                    j.add("prepared")
            rows = [json.loads(line) for line in p.read_text().splitlines()]
            self.assertEqual(len(rows), len(STAGES))
            self.assertEqual(rows[1]["previous_sha256"], rows[0]["event_sha256"])
            with self.assertRaises(FileExistsError):
                Journal(p)


if __name__ == "__main__":
    unittest.main()
