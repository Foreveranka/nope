"""In-memory numeric-column jobs over the fixed four-record FHE profile.

The owning loopback HTTP server handles transport/access control. This module
never parses filenames, persists plaintext, logs failures, or anchors evidence.
Injected pipelines are test-only, including when exercising explicit remote mode.
"""

import copy
import importlib
import math
import re
import threading
import time
import uuid
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timezone
from pathlib import Path


MAX_ACTIVE = 2
MAX_JOBS = 16
STAGES = {
    "QUEUED": "Waiting for the column worker.",
    "ENCRYPTING": "Encrypting a four-record batch locally.",
    "EVALUATING": "Evaluating encrypted batch records.",
    "VERIFYING": "Verifying the batch locally.",
    "COMPLETED": "All column batches passed local verification.",
    "FAILED": "Column processing failed.",
}
HASH_KEYS = frozenset({
    "serverSha256", "clientSpecsSha256", "inputSha256",
    "evaluationKeysSha256", "requestManifestSha256", "outputSha256",
    "receiptSha256",
})
# Never copy arbitrary pipeline metadata (which could contain plaintext).
TIMING_KEYS = frozenset({
    "queue_seconds", "keygen_seconds", "encrypt_seconds",
    "evaluation_keys_serialize_seconds", "worker_seconds", "decrypt_seconds",
    "total_seconds", "server_load_seconds", "evaluate_seconds",
})


class CsvJobsError(ValueError):
    """Fixed, HTTP-compatible error without input or engine exception details."""

    def __init__(self, status, message):
        self.status = status
        self.message = message
        super().__init__(message)


def _now():
    return datetime.now(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")


def _batch_result(output, expected):
    if type(output) is not dict or output.get("verified") is not True:
        raise ValueError("Invalid batch result")
    records = output.get("records")
    if type(records) is not list or len(records) != 4:
        raise ValueError("Invalid batch result")
    values = []
    for index, record in enumerate(records):
        if (type(record) is not dict or type(record.get("value")) is not int
                or not 0 <= record["value"] <= 100
                or type(record.get("id")) is not int or record["id"] != index):
            raise ValueError("Invalid batch result")
        value = record["value"]
        if value != (0 if expected[index] == 255 else min(expected[index], 100)):
            raise ValueError("Invalid batch result")
        values.append(value)
    # Duplicate flags concern four synthetic IDs only; never expose a global claim.
    hashes = output.get("artifactHashes", {})
    if type(hashes) is not dict:
        raise ValueError("Invalid batch hashes")
    safe_hashes = {}
    for key in HASH_KEYS:
        if key in hashes:
            digest = hashes[key]
            if type(digest) is not str or re.fullmatch(r"[0-9a-fA-F]{64}", digest) is None:
                raise ValueError("Invalid batch hashes")
            safe_hashes[key] = digest
    metrics = output.get("metrics", {})
    if type(metrics) is not dict:
        raise ValueError("Invalid batch metrics")
    timings = {}
    for key in TIMING_KEYS:
        value = metrics.get(key)
        if type(value) in (int, float) and value >= 0 and math.isfinite(value):
            timings[key] = value
    return values, safe_hashes, timings


class CsvJobs:
    """Bounded, serial FHE jobs; all input/output values stay in process memory."""

    def __init__(self, runtime_dir, pipeline=None, remote_client=None):
        self.runtime_dir = Path(runtime_dir).resolve()
        self.pipeline = pipeline
        self.remote_client = remote_client
        self.lock = threading.RLock()
        self.jobs = {}
        self.active = 0
        self.closed = False
        self.executor = ThreadPoolExecutor(max_workers=1, thread_name_prefix="csv-fhe")

    def start(self, values, mode="local"):
        if (type(values) is not list or not 1 <= len(values) <= 32
                or any(type(value) is not int or not 0 <= value <= 255 for value in values)):
            raise CsvJobsError(400, "Expected 1 to 32 integers from 0 to 255.")
        if type(mode) is not str or mode not in ("local", "remote"):
            raise CsvJobsError(400, "Unknown evaluation mode.")
        with self.lock:
            if self.closed:
                raise CsvJobsError(503, "Column worker is shutting down.")
            if mode == "remote" and self.remote_client is None:
                raise CsvJobsError(503, "Remote evaluation is not configured.")
            if self.active >= MAX_ACTIVE:
                raise CsvJobsError(429, "Column job queue is full.")
            if len(self.jobs) >= MAX_JOBS:
                raise CsvJobsError(429, "Column session job limit reached.")
            job_id = uuid.uuid4().hex
            job = {"id": job_id, "status": "QUEUED", "events": []}
            self.jobs[job_id] = job
            self._event(job_id, "QUEUED")
            self.active += 1
            owned_values = values.copy()
            try:
                self.executor.submit(self._run, job_id, owned_values, mode)
            except Exception:
                owned_values.clear()
                self.active -= 1
                del self.jobs[job_id]
                raise CsvJobsError(503, "Column worker is unavailable.") from None
            return copy.deepcopy(job)

    def snapshot(self, job_id):
        with self.lock:
            if type(job_id) is not str or job_id not in self.jobs:
                raise CsvJobsError(404, "Column job not found.")
            return copy.deepcopy(self.jobs[job_id])

    def _event(self, job_id, stage, index=None):
        job = self.jobs[job_id]
        job["status"] = stage
        event = {"stage": stage, "at": _now(), "message": STAGES[stage]}
        if index is not None:
            event["batchIndex"] = index
        job["events"].append(event)

    def _stage(self, job_id, index, stage, message=None):
        # Only bounded, monotonic stage names; discard arbitrary engine messages.
        order = ("ENCRYPTING", "EVALUATING", "VERIFYING")
        if type(stage) is not str or stage not in order:
            return
        with self.lock:
            job = self.jobs[job_id]
            if job["status"] in ("FAILED", "COMPLETED"):
                return
            previous = job["events"][-1]
            if previous.get("batchIndex") == index and previous["stage"] in order:
                if order.index(stage) <= order.index(previous["stage"]):
                    return
            self._event(job_id, stage, index)

    def _run(self, job_id, values, mode):
        cleaned, batches, timings = [], [], {}
        records, padded = [], []
        started = time.monotonic()
        try:
            pipeline = self.pipeline
            engine = None
            if pipeline is None:
                engine = importlib.import_module("engine.pipeline")
                pipeline = engine.run_job
            root = self.runtime_dir / job_id
            self.runtime_dir.mkdir(mode=0o700, parents=True, exist_ok=True)
            root.mkdir(mode=0o700)
            for index, offset in enumerate(range(0, len(values), 4)):
                count = min(4, len(values) - offset)
                padded = values[offset:offset + count] + [0] * (4 - count)
                records = [{"id": slot, "value": value} for slot, value in enumerate(padded)]
                batch_dir = root / uuid.uuid4().hex
                batch_dir.mkdir(mode=0o700)
                callback = lambda stage, message=None, i=index: self._stage(job_id, i, stage)
                if mode == "remote" and engine is not None:
                    with engine.prepare_remote_job(records, batch_dir, on_stage=callback) as prepared:
                        prepared.evaluate_remote(self.remote_client.evaluate)
                        output = prepared.finalize()
                else:
                    output = pipeline(records, batch_dir, on_stage=callback)
                batch_values, hashes, measured = _batch_result(output, padded)
                if engine is not None and set(hashes) != HASH_KEYS:
                    raise ValueError("Incomplete native evidence")
                cleaned.extend(batch_values[:count])
                batches.append({"index": index, "artifactHashes": hashes})
                for key, value in measured.items():
                    timings[key] = timings.get(key, 0) + value
                records.clear()
                padded.clear()
                del output, batch_values
            evidence = {"schema": "nope-csv-evidence-v1", "profile": "clean-column-batch4-v1",
                        "batches": batches, "rowCount": len(values), "verified": True,
                        "realFhe": self.pipeline is None}
            with self.lock:
                self.jobs[job_id].update(values=cleaned.copy(), evidence=evidence,
                    metrics={"batchCount": len(batches), "rowCount": len(values),
                             "elapsedSeconds": time.monotonic() - started,
                             "realFhe": self.pipeline is None, "timings": timings})
                self._event(job_id, "COMPLETED")
        except Exception:
            # Never retain/log an exception, traceback, partial values or metadata.
            with self.lock:
                self.jobs[job_id]["error"] = STAGES["FAILED"]
                self._event(job_id, "FAILED")
        finally:
            values.clear()
            records.clear()
            padded.clear()
            cleaned.clear()
            with self.lock:
                self.active -= 1

    def close(self):
        with self.lock:
            self.closed = True
        self.executor.shutdown(wait=True)
