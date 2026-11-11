"""Small chronological evidence log with an explicit non-proof boundary."""
import hashlib
import json
import os
import time


STAGES = ("prepared", "registered", "bids_closed", "mpc_completed",
          "executor_selected", "payment_held_fixture", "execution_bound",
          "evaluated", "client_verified", "reported", "accepted",
          "payment_released_fixture")


class Journal:
    def __init__(self, path):
        self.path = path
        self.events = []
        self.started = time.monotonic()
        self.fd = os.open(path, os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o600)

    def add(self, stage, hashes=None):
        if len(self.events) >= len(STAGES) or stage != STAGES[len(self.events)]:
            raise ValueError("Out-of-order integration stage")
        hashes = hashes or {}
        if type(hashes) is not dict or any(
            type(k) is not str or not k.endswith("_sha256") or
            type(v) is not str or len(v) != 64 or
            any(c not in "0123456789abcdef" for c in v)
            for k, v in hashes.items()):
            raise ValueError("Evidence journal only accepts named SHA-256 digests")
        event = {"sequence": len(self.events), "stage": stage,
                 "elapsed_seconds": time.monotonic() - self.started,
                 "hashes": dict(hashes), "previous_sha256":
                 self.events[-1]["event_sha256"] if self.events else "0" * 64}
        event["event_sha256"] = hashlib.sha256(json.dumps(
            event, sort_keys=True, separators=(",", ":")).encode()).hexdigest()
        blob = (json.dumps(event, sort_keys=True) + "\n").encode()
        while blob:
            blob = blob[os.write(self.fd, blob):]
        os.fsync(self.fd)
        self.events.append(event)
        return event

    def close(self):
        if self.fd is not None:
            os.close(self.fd)
            self.fd = None

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        self.close()
