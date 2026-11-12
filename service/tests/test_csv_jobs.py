"""Column-manager unit tests plus an opt-in genuine native two-batch smoke."""

import contextlib
import copy
import io
import json
import os
import tempfile
import threading
import time
import types
import unittest
import uuid
from pathlib import Path
from unittest.mock import Mock, patch

from service.csv_jobs import CsvJobs, CsvJobsError, HASH_KEYS


PRIVATE = "TEST-ONLY-private-input-and-exception"
HASHES = {key: format(index + 1, '064x') for index, key in enumerate(sorted(HASH_KEYS))}


def fake_pipeline(records, job_dir, on_stage=None):
    """TEST ONLY: no cryptography or network; never use as native evidence."""
    if on_stage:
        for stage in ("ENCRYPTING", "EVALUATING", "VERIFYING"):
            on_stage(stage, PRIVATE)
    return {"verified": True,
            "records": [{"id": r["id"], "value": 0 if r["value"] == 255 else min(r["value"], 100),
                         "duplicate": True} for r in records],
            "artifactHashes": dict(HASHES, plaintextSha256="f" * 64, filename=PRIVATE),
            "metrics": {"evaluate_seconds": 0.25, "private": PRIVATE}}


def wait_job(manager, job_id, timeout=5):
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        snapshot = manager.snapshot(job_id)
        if snapshot["status"] in ("COMPLETED", "FAILED"):
            return snapshot
        time.sleep(0.005)
    raise AssertionError("Column job did not finish before the test deadline")


class CsvJobsTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = (Path(self.temp.name) / "runtime").resolve()

    def manager(self, pipeline=fake_pipeline, remote_client=None):
        manager = CsvJobs(self.root, pipeline, remote_client)
        self.addCleanup(manager.close)
        return manager

    def test_batches_padding_order_evidence_and_no_persistence(self):
        calls = []
        def pipeline(records, job_dir, on_stage=None):
            calls.append((copy.deepcopy(records), job_dir))
            return fake_pipeline(records, job_dir, on_stage)
        manager = self.manager(pipeline)
        original = [255, 101, 100, 0, 42]
        queued = manager.start(original)
        self.assertEqual(queued["status"], "QUEUED")
        result = wait_job(manager, queued["id"])
        self.assertEqual(result["status"], "COMPLETED")
        self.assertEqual(result["values"], [0, 100, 100, 0, 42])
        self.assertEqual(original, [255, 101, 100, 0, 42])
        self.assertEqual(len(calls), 2)
        self.assertEqual(calls[1][0], [{"id": i, "value": v} for i, v in enumerate([42, 0, 0, 0])])
        for records, path in calls:
            self.assertEqual([r["id"] for r in records], [0, 1, 2, 3])
            self.assertEqual(path.parent, self.root / queued["id"])
            self.assertEqual(uuid.UUID(path.name).hex, path.name)
            self.assertEqual(path.stat().st_mode & 0o777, 0o700)
        self.assertEqual(len({path for _, path in calls}), 2)
        self.assertFalse(any(path.is_file() for path in self.root.rglob("*")))
        self.assertEqual(result["evidence"], {
            "schema": "nope-csv-evidence-v1", "profile": "clean-column-batch4-v1",
            "rowCount": 5, "verified": True, "realFhe": False,
            "batches": [{"index": index, "artifactHashes": HASHES} for index in range(2)]})
        self.assertEqual(result["metrics"]["timings"], {"evaluate_seconds": 0.5})
        serialized = json.dumps(result)
        for forbidden in (PRIVATE, "duplicate", "plaintextSha256", "filename"):
            self.assertNotIn(forbidden, serialized)
        result["values"][0] = 99
        result["events"].clear()
        result["evidence"]["batches"][0]["artifactHashes"].clear()
        fresh = manager.snapshot(queued["id"])
        self.assertEqual(fresh["values"][0], 0)
        self.assertTrue(fresh["events"])
        self.assertEqual(fresh["evidence"]["batches"][0]["artifactHashes"], HASHES)

    def test_input_bounds_types_modes_and_missing_ids(self):
        manager = self.manager()
        for values in ([], [0] * 33, (1,), "1", None, [True], [False], [1.0], ["1"], [-1], [256], [{}]):
            with self.subTest(values=values), self.assertRaises(CsvJobsError) as error:
                manager.start(values)
            self.assertEqual(error.exception.status, 400)
        for mode in (None, [], {}, True, "REMOTE", "automatic"):
            with self.subTest(mode=mode), self.assertRaises(CsvJobsError) as error:
                manager.start([1], mode)
            self.assertEqual(error.exception.status, 400)
        with self.assertRaises(CsvJobsError) as error:
            manager.start([1], "remote")
        self.assertEqual(error.exception.status, 503)
        for job_id in ("missing", [], None):
            with self.assertRaises(CsvJobsError) as error:
                manager.snapshot(job_id)
            self.assertEqual(error.exception.status, 404)
        self.assertFalse(self.root.exists())
        for values in ([255], list(range(32))):
            result = wait_job(manager, manager.start(values)["id"])
            self.assertEqual(result["values"], [0 if v == 255 else min(v, 100) for v in values])

    def test_processing_hides_partial_values_and_copies_input(self):
        entered, release = threading.Event(), threading.Event()
        calls = []
        def pipeline(records, job_dir, on_stage=None):
            calls.append(copy.deepcopy(records))
            if len(calls) == 2:
                on_stage("ENCRYPTING", PRIVATE)
                entered.set()
                if not release.wait(5):
                    raise RuntimeError(PRIVATE)
            return fake_pipeline(records, job_dir, on_stage)
        manager = self.manager(pipeline)
        self.addCleanup(release.set)
        values = [255, 101, 100, 0, 42]
        job_id = manager.start(values)["id"]
        values[:] = [17]
        self.assertTrue(entered.wait(3))
        processing = manager.snapshot(job_id)
        self.assertEqual(processing["status"], "ENCRYPTING")
        for key in ("values", "evidence", "metrics"):
            self.assertNotIn(key, processing)
        self.assertNotIn(PRIVATE, json.dumps(processing))
        release.set()
        self.assertEqual(wait_job(manager, job_id)["values"], [0, 100, 100, 0, 42])

    def test_single_worker_active_limit_shutdown_drains_and_rejects(self):
        entered, release = threading.Event(), threading.Event()
        calls = []
        def pipeline(records, job_dir, on_stage=None):
            calls.append(threading.get_ident())
            entered.set()
            if not release.wait(5):
                raise RuntimeError(PRIVATE)
            return fake_pipeline(records, job_dir, on_stage)
        manager = self.manager(pipeline)
        self.addCleanup(release.set)
        first = manager.start([1])["id"]
        self.assertTrue(entered.wait(3))
        second = manager.start([2])["id"]
        with self.assertRaises(CsvJobsError) as error:
            manager.start([3])
        self.assertEqual(error.exception.status, 429)
        self.assertEqual(manager.snapshot(second)["status"], "QUEUED")
        closer = threading.Thread(target=manager.close)
        closer.start()
        self.addCleanup(lambda: (release.set(), closer.join(5)))
        deadline = time.monotonic() + 2
        while not manager.closed and time.monotonic() < deadline:
            time.sleep(0.001)
        self.assertTrue(closer.is_alive())
        with self.assertRaises(CsvJobsError) as error:
            manager.start([3])
        self.assertEqual(error.exception.status, 503)
        release.set()
        closer.join(5)
        self.assertFalse(closer.is_alive())
        self.assertEqual(manager.active, 0)
        self.assertEqual(manager.snapshot(first)["status"], "COMPLETED")
        self.assertEqual(manager.snapshot(second)["status"], "COMPLETED")
        self.assertEqual(len(set(calls)), 1)

    def test_session_limit_includes_finished_jobs_and_no_eviction(self):
        manager = self.manager()
        ids = []
        for _ in range(16):
            ids.append(manager.start([42])["id"])
            self.assertEqual(wait_job(manager, ids[-1])["status"], "COMPLETED")
        with self.assertRaises(CsvJobsError) as error:
            manager.start([42])
        self.assertEqual(error.exception.status, 429)
        self.assertEqual(manager.snapshot(ids[0])["values"], [42])

    def test_submit_failure_rolls_back_capacity(self):
        manager = self.manager()
        with patch.object(manager.executor, "submit", side_effect=RuntimeError(PRIVATE)):
            with self.assertRaises(CsvJobsError) as error:
                manager.start([42])
        self.assertNotIn(PRIVATE, str(error.exception))
        self.assertEqual(manager.active, 0)
        self.assertEqual(manager.jobs, {})
        self.assertEqual(wait_job(manager, manager.start([42])["id"])["status"], "COMPLETED")

    def test_invalid_or_unverified_result_never_exposes_partial_results(self):
        def change_verified(output):
            output["verified"] = 1
        def unverified(output):
            output["verified"] = False
        def short(output):
            output["records"].pop()
        def boolean(output):
            output["records"][0]["value"] = True
        def range_error(output):
            output["records"][0]["value"] = 101
        def wrong_value(output):
            output["records"][0]["value"] = 99
        def wrong_id(output):
            output["records"][0]["id"] = 3
        def bad_hash(output):
            output["artifactHashes"]["inputSha256"] = PRIVATE
        def wrong_records(output):
            output["records"] = None
        for mutate in (change_verified, unverified, short, boolean, range_error, wrong_value,
                       wrong_id, bad_hash, wrong_records):
            with self.subTest(case=mutate.__name__):
                calls = []
                def pipeline(records, job_dir, on_stage=None):
                    output = fake_pipeline(records, job_dir, on_stage)
                    calls.append(1)
                    if len(calls) == 2:
                        mutate(output)
                    return output
                manager = self.manager(pipeline)
                job_id = manager.start([42] * 5)["id"]
                failed = wait_job(manager, job_id)
                self.assertEqual(failed["status"], "FAILED")
                for key in ("values", "evidence", "metrics"):
                    self.assertNotIn(key, failed)
                self.assertNotIn(PRIVATE, json.dumps(failed))
                manager.close()

    def test_exception_stage_and_metadata_never_logged_or_reflected(self):
        def pipeline(records, job_dir, on_stage=None):
            on_stage("ENCRYPTING", PRIVATE)
            for stage in ("COMPLETED", "FAILED", PRIVATE, None, []):
                on_stage(stage, PRIVATE)
            raise RuntimeError(PRIVATE)
        manager = self.manager(pipeline)
        stdout, stderr = io.StringIO(), io.StringIO()
        with contextlib.redirect_stdout(stdout), contextlib.redirect_stderr(stderr):
            failed = wait_job(manager, manager.start([42])["id"])
        self.assertEqual(failed["status"], "FAILED")
        self.assertEqual(failed["error"], "Column processing failed.")
        self.assertNotIn(PRIVATE, json.dumps(failed) + stdout.getvalue() + stderr.getvalue())
        self.assertFalse(any(p.is_file() for p in self.root.rglob("*")))

    def test_native_selection_local_default_and_explicit_remote_adapter(self):
        remote = types.SimpleNamespace(evaluate=Mock(return_value={"response.bin": b"ciphertext"}))
        local = Mock(side_effect=fake_pipeline)
        prepare_calls = []
        class Prepared:
            def __init__(self, records, job_dir, on_stage):
                self.records, self.job_dir, self.callback = records, job_dir, on_stage
                self.evaluated = False
            def __enter__(self):
                return self
            def __exit__(self, *args):
                pass
            def evaluate_remote(self, evaluate):
                evaluate({"request.bin": b"TEST-ONLY-encrypted"})
                self.evaluated = True
            def finalize(self):
                if not self.evaluated:
                    raise AssertionError("Remote evaluation must precede finalize")
                return fake_pipeline(self.records, self.job_dir, self.callback)
        def prepare(records, job_dir, on_stage=None):
            prepare_calls.append(job_dir)
            return Prepared(records, job_dir, on_stage)
        engine = types.SimpleNamespace(run_job=local, prepare_remote_job=prepare)
        manager = self.manager(None, remote)
        with patch("service.csv_jobs.importlib.import_module", return_value=engine) as imported:
            result = wait_job(manager, manager.start([42])["id"])
            local.assert_called_once()
            remote.evaluate.assert_not_called()
            self.assertTrue(result["evidence"]["realFhe"])
            result = wait_job(manager, manager.start([255, 101, 42, 0, 7], "remote")["id"])
            self.assertEqual(result["values"], [0, 100, 42, 0, 7])
            self.assertEqual(remote.evaluate.call_count, 2)
            self.assertEqual(len(prepare_calls), 2)
            self.assertEqual(imported.call_count, 2)
            local.assert_called_once()
        # Above is API selection testing with a patched module, not real FHE evidence.

    def test_native_evidence_requires_all_known_batch_hashes(self):
        def incomplete(records, job_dir, on_stage=None):
            output = fake_pipeline(records, job_dir, on_stage)
            del output["artifactHashes"]["receiptSha256"]
            return output
        manager = self.manager(None)
        engine = types.SimpleNamespace(run_job=incomplete)
        with patch("service.csv_jobs.importlib.import_module", return_value=engine):
            result = wait_job(manager, manager.start([42])["id"])
        self.assertEqual(result["status"], "FAILED")
        self.assertNotIn("evidence", result)
        self.assertNotIn("values", result)

    def test_injected_remote_pipeline_stays_test_only(self):
        remote = types.SimpleNamespace(evaluate=Mock())
        manager = self.manager(remote_client=remote)
        with patch("service.csv_jobs.importlib.import_module", side_effect=AssertionError("No native import")):
            result = wait_job(manager, manager.start([42], "remote")["id"])
        self.assertFalse(result["evidence"]["realFhe"])
        remote.evaluate.assert_not_called()


@unittest.skipUnless(os.environ.get("VEIL_RUN_FHE_SMOKE") == "1", "enable genuine native two-batch smoke explicitly")
class NativeCsvJobsTests(unittest.TestCase):
    def test_real_two_batches_ciphertext_artifacts_and_exact_evidence(self):
        from concrete import fhe
        from engine.protocol import sha256
        with tempfile.TemporaryDirectory(prefix="csv-native-") as temporary:
            manager = CsvJobs(temporary)
            try:
                with contextlib.ExitStack() as stack:
                    for method in ("serialize", "serialize_to_file", "save"):
                        stack.enter_context(patch.object(fhe.Keys, method,
                            side_effect=AssertionError("Secret key persistence forbidden")))
                    queued = manager.start([255, 101, 100, 0, 42])
                    result = wait_job(manager, queued["id"], timeout=1200)
                self.assertEqual(result["status"], "COMPLETED")
                self.assertEqual(result["values"], [0, 100, 100, 0, 42])
                self.assertTrue(result["evidence"]["realFhe"])
                self.assertEqual(result["metrics"]["batchCount"], 2)
                root = Path(temporary) / queued["id"]
                directories = list(root.iterdir())
                self.assertEqual(len(directories), 2)
                artifact_names = {"server.zip", "client-specs.json", "request.bin", "request.json",
                                  "response.bin", "receipt.json"}
                by_request_hash = {}
                for directory in directories:
                    self.assertEqual({p.name for p in directory.iterdir()}, artifact_names)
                    by_request_hash[sha256((directory / "request.json").read_bytes())] = directory
                for batch in result["evidence"]["batches"]:
                    hashes = batch["artifactHashes"]
                    self.assertEqual(set(hashes), HASH_KEYS)
                    directory = by_request_hash[hashes["requestManifestSha256"]]
                    for name, key in (("server.zip", "serverSha256"), ("client-specs.json", "clientSpecsSha256"),
                                      ("request.bin", "inputSha256"), ("response.bin", "outputSha256"),
                                      ("receipt.json", "receiptSha256")):
                        self.assertEqual(sha256((directory / name).read_bytes()), hashes[key])
                    manifest = json.loads((directory / "request.json").read_bytes())
                    self.assertEqual(manifest["evaluationKeysSha256"], hashes["evaluationKeysSha256"])
                    for name in ("request.json", "receipt.json"):
                        text = (directory / name).read_text()
                        self.assertNotIn('"records"', text)
                        self.assertNotIn('"value"', text)
                print("REAL_CSV_FHE_TWO_BATCH " + json.dumps({"evidence": result["evidence"],
                                                            "metrics": result["metrics"]}), flush=True)
            finally:
                manager.close()


if __name__ == "__main__":
    unittest.main()
