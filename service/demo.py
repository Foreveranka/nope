"""One-at-a-time fixed synthetic integration, no user-supplied execution inputs."""
import copy
import json
import secrets
import threading
from concurrent.futures import ThreadPoolExecutor


RESULT_FIELDS = {"completed", "elapsed_seconds", "checks", "rejected_registry_actions",
                 "payment_mode", "real_fhe", "real_mpc", "actual_near_sandbox",
                 "independent_operators", "real_payment", "execution_proof"}


class DemoBusy(ValueError):
    pass


class DemoRuns:
    def __init__(self, runtime, enabled=True, runner=None):
        self.runtime, self.enabled, self.runner = runtime, enabled, runner
        self.lock = threading.RLock()
        self.pool = ThreadPoolExecutor(max_workers=1, thread_name_prefix="synthetic-demo")
        self.current = None
        self.path = None
        self.closed = False

    def snapshot(self):
        with self.lock:
            result = copy.deepcopy(self.current)
            if result is not None and self.path is not None:
                journal = self.path / "events.jsonl"
                if journal.is_file() and not journal.is_symlink():
                    # Ignore an incomplete final append; never expose raw log/errors.
                    with journal.open("rb") as stream:
                        raw = stream.read(16384)
                    events = []
                    for line in raw.splitlines(keepends=True):
                        if not line.endswith(b"\n"):
                            continue
                        try:
                            row = json.loads(line)
                            events.append({"stage": row["stage"], "elapsed_seconds": row["elapsed_seconds"]})
                        except (ValueError, KeyError):
                            continue
                    result["events"] = events
            return result

    def start(self):
        with self.lock:
            if not self.enabled or self.closed:
                raise DemoBusy("Synthetic integration is unavailable in this service mode")
            if self.current and self.current["status"] == "running":
                raise DemoBusy("A synthetic integration is already running")
            identity = secrets.token_hex(12)
            self.path = self.runtime / ("demo-" + identity)
            self.current = {"id": identity, "status": "running", "events": []}
            self.pool.submit(self._run, identity, self.path)
            return self.snapshot()

    def _run(self, identity, path):
        try:
            if self.runner is None:
                from integration.run import run
                result = run(path)
            else:
                result = self.runner(path)
            if result.get("completed") is not True:
                raise ValueError("Incomplete integration")
            safe = {k: result[k] for k in RESULT_FIELDS if k in result}
            with self.lock:
                self.current.update(status="completed", result=safe)
        except Exception:
            with self.lock:
                self.current.update(status="failed", error="Yerel demo tamamlanamadı. Bağımlılıklar ve yerel test kayıtları kontrol edilmeli; otomatik yeniden deneme yapılmadı.")

    def close(self):
        with self.lock:
            self.closed = True
        self.pool.shutdown(wait=True)
