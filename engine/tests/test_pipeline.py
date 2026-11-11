import copy
import contextlib
import json
import os
import subprocess
import sys
import tempfile
import unittest
import uuid
import zipfile
from pathlib import Path
from unittest import mock

from engine.pipeline import (_ephemeral_evaluation_keys, _evaluate_subprocess,
                             _new_job_dir, decode_output, encode_bits, reference_result,
                             run_job, validate_records)
from engine.protocol import (ARTIFACT_PINS, ENGINE_DIR, PROFILE_ID, approved_artifacts,
                             canonical_json, sha256, validate_manifest, verify_receipt)
from engine.worker import evaluate


def fixture():
    return [{"id": 10, "value": 255}, {"id": 20, "value": 42},
            {"id": 10, "value": 150}, {"id": 30, "value": 100}]


def request_manifest():
    return {"protocolVersion": 1, "profileId": PROFILE_ID, "attemptId": uuid.uuid4().hex,
            "serverSha256": ARTIFACT_PINS["server.zip"],
            "clientSpecsSha256": ARTIFACT_PINS["client-specs.json"],
            "evaluationKeysSha256": sha256(b"public evaluation key test bytes"),
            "inputSha256": sha256(b"encrypted input test bytes")}


class RecordTests(unittest.TestCase):
    def test_invalid_inputs_fail_before_runtime_or_disk(self):
        invalid = [None, {}, (), [], fixture()[:3], fixture() + fixture()[:1]]
        for key in ("id", "value"):
            for value in (-1, 256, True, False, 1.5, "12", None):
                records = fixture()
                records[0][key] = value
                invalid.append(records)
        for record in ({"id": 1}, {"id": 1, "value": 2, "extra": 3}, [], None):
            records = fixture()
            records[0] = record
            invalid.append(records)
        with tempfile.TemporaryDirectory() as temp, mock.patch("engine.pipeline.require_runtime") as runtime:
            root = Path(temp) / "unused"
            for records in invalid:
                with self.subTest(case=type(records).__name__), self.assertRaises(ValueError):
                    run_job(records, root)
            self.assertFalse(root.exists())
            runtime.assert_not_called()

    def test_snapshot_and_input_unchanged(self):
        source = fixture()
        snapshot = validate_records(source)
        snapshot[0]["value"] = 7
        self.assertEqual(source, fixture())

    def test_reference_flags_all_later_occurrences_and_boundaries(self):
        records = [{"id": 255, "value": value} for value in (0, 100, 101, 255)]
        result = reference_result(records)
        self.assertEqual([r["value"] for r in result], [0, 100, 100, 0])
        self.assertEqual([r["duplicate"] for r in result], [False, True, True, True])
        self.assertEqual(len(result), 4)  # Flags duplicates; never silently removes rows.

    def test_exact_archived_bit_layout(self):
        records = [{"id": v, "value": 255 - v} for v in (1, 2, 4, 128)]
        bits = encode_bits(records)
        self.assertEqual(len(bits), 64)
        self.assertEqual(bits[:8], [1, 0, 0, 0, 0, 0, 0, 0])
        self.assertEqual(bits[24:32], [0, 0, 0, 0, 0, 0, 0, 1])
        self.assertEqual(bits[32:40], [0, 1, 1, 1, 1, 1, 1, 1])

    def test_output_layout(self):
        bits = [0, 0, 1, 0] + [(v >> k) & 1 for v in (0, 42, 100, 100) for k in range(8)]
        self.assertEqual(decode_output(fixture(), bits), reference_result(fixture()))

    def test_malformed_decrypted_shape_and_bits(self):
        for bits in ([0] * 35, [0] * 37, [2] * 36):
            with self.assertRaises(ValueError):
                decode_output(fixture(), bits)

    def test_stage_precedes_runtime_import(self):
        stages = []
        with mock.patch("engine.pipeline.require_runtime", side_effect=RuntimeError("unavailable")):
            with self.assertRaises(RuntimeError):
                run_job(fixture(), "unused", lambda stage, message: stages.append(stage))
        self.assertEqual(stages, ["ENCRYPTING"])


class ArtifactTests(unittest.TestCase):
    def test_pinned_archive_and_embedded_spec(self):
        blobs = approved_artifacts()
        with zipfile.ZipFile(ENGINE_DIR / "artifacts/server.zip") as archive:
            self.assertEqual(archive.read("client.specs.json"), blobs["client-specs.json"])
            self.assertEqual(archive.read("is_simulated"), b"0")
            self.assertFalse(any("pickle" in name for name in archive.namelist()))

    def test_artifact_hash_cannot_be_overridden_by_disk_manifest(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            for name, blob in approved_artifacts().items():
                (root / name).write_bytes(blob + b"tampered")
            (root / "SHA256.json").write_text(json.dumps({name: "0" * 64 for name in ARTIFACT_PINS}))
            with self.assertRaises(ValueError):
                approved_artifacts(root)

    def test_artifact_symlink_rejected(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            (root / "server.zip").symlink_to(ENGINE_DIR / "artifacts/server.zip")
            with self.assertRaises(OSError):
                approved_artifacts(root)

    def test_job_directory_does_not_overwrite_or_follow_symlinks(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            (root / "keep").write_bytes(b"unchanged")
            with self.assertRaises(ValueError):
                _new_job_dir(root)
            link = root / "link"
            link.symlink_to(root, target_is_directory=True)
            with self.assertRaises(ValueError):
                _new_job_dir(link)
            self.assertEqual((root / "keep").read_bytes(), b"unchanged")


class BindingTests(unittest.TestCase):
    def setUp(self):
        self.manifest = request_manifest()
        self.manifest_bytes = canonical_json(self.manifest)
        self.output = b"encrypted output test bytes"
        self.receipt = {"request": copy.deepcopy(self.manifest),
                        "requestManifestSha256": sha256(self.manifest_bytes),
                        "outputSha256": sha256(self.output),
                        "metrics": {"server_load_seconds": 0.1, "evaluate_seconds": 0.2}}

    def test_valid_receipt(self):
        self.assertEqual(verify_receipt(self.manifest, self.manifest_bytes, self.receipt, self.output),
                         self.receipt["metrics"])

    def test_swapped_request_attempt_keys_circuit_or_input_rejected(self):
        for key in self.manifest:
            receipt = copy.deepcopy(self.receipt)
            receipt["request"][key] = "different"
            with self.subTest(field=key), self.assertRaises(ValueError):
                verify_receipt(self.manifest, self.manifest_bytes, receipt, self.output)

    def test_output_and_manifest_tampering(self):
        with self.assertRaises(ValueError):
            verify_receipt(self.manifest, self.manifest_bytes, self.receipt, b"substitution")
        with self.assertRaises(ValueError):
            verify_receipt(self.manifest, self.manifest_bytes + b" ", self.receipt, self.output)

    def test_bad_manifest_types_or_extra_fields(self):
        for update in ({"profileId": "other"}, {"protocolVersion": True}, {"attemptId": "../escape"},
                       {"inputSha256": "garbage"}, {"path": "untrusted.zip"}):
            manifest = dict(self.manifest, **update)
            with self.assertRaises(ValueError):
                validate_manifest(manifest)

    def test_invalid_metrics_rejected(self):
        for value in (-1, float("nan"), float("inf"), True, "123"):
            receipt = copy.deepcopy(self.receipt)
            receipt["metrics"]["evaluate_seconds"] = value
            with self.assertRaises(ValueError):
                verify_receipt(self.manifest, self.manifest_bytes, receipt, self.output)

    def test_worker_rejects_input_substitution_before_loading_runtime(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            for name, blob in approved_artifacts().items():
                (root / name).write_bytes(blob)
            (root / "request.json").write_bytes(self.manifest_bytes)
            (root / "request.bin").write_bytes(b"substituted")
            with self.assertRaisesRegex(ValueError, "input hash"):
                evaluate(root)
            self.assertFalse((root / "response.bin").exists())

    def test_worker_rejects_evaluation_key_substitution(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            for name, blob in approved_artifacts().items():
                (root / name).write_bytes(blob)
            (root / "request.json").write_bytes(self.manifest_bytes)
            (root / "request.bin").write_bytes(b"encrypted input test bytes")
            (root / "evaluation.keys").write_bytes(b"substituted")
            with self.assertRaisesRegex(ValueError, "key hash"):
                evaluate(root)


class ProcessAndRetentionTests(unittest.TestCase):
    def test_evaluation_key_removed_on_success_and_failure(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            with _ephemeral_evaluation_keys(root, b"evaluation material"):
                self.assertEqual((root / "evaluation.keys").read_bytes(), b"evaluation material")
                self.assertEqual((root / "evaluation.keys").stat().st_mode & 0o777, 0o600)
            self.assertFalse((root / "evaluation.keys").exists())
            with self.assertRaisesRegex(RuntimeError, "worker failed"):
                with _ephemeral_evaluation_keys(root, b"evaluation material"):
                    raise RuntimeError("worker failed")
            self.assertFalse((root / "evaluation.keys").exists())

    def test_existing_evalkey_not_removed_or_overwritten(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            (root / "evaluation.keys").write_bytes(b"keep")
            with self.assertRaises(FileExistsError):
                with _ephemeral_evaluation_keys(root, b"new"):
                    self.fail("should not run")
            self.assertEqual((root / "evaluation.keys").read_bytes(), b"keep")

    def test_subprocess_uses_current_interpreter_and_minimal_environment(self):
        with tempfile.TemporaryDirectory() as temp, mock.patch.dict(os.environ, {"APPLICATION_SECRET": "not inherited"}):
            root = Path(temp)
            with mock.patch("engine.pipeline.subprocess.run", return_value=subprocess.CompletedProcess([], 0)) as run:
                with mock.patch.dict(os.environ, {}, clear=True):
                    _evaluate_subprocess(root)
            args, kwargs = run.call_args
            self.assertEqual(args[0][:3], [sys.executable, "-I", "-B"])
            self.assertEqual(set(kwargs["env"]), {"PATH", "TMPDIR", "OMP_NUM_THREADS"})
            self.assertEqual(kwargs["stdin"], subprocess.DEVNULL)
            self.assertEqual(list(root.iterdir()), [])

    def test_worker_timeout_becomes_sanitized_error_and_cleans_temp(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            with mock.patch("engine.pipeline.subprocess.run", side_effect=subprocess.TimeoutExpired("worker", 600)):
                with self.assertRaisesRegex(RuntimeError, "600 second"):
                    _evaluate_subprocess(root)
            self.assertEqual(list(root.iterdir()), [])


@unittest.skipUnless(os.environ.get("VEIL_RUN_FHE_SMOKE") == "1", "enable genuine FHE smoke explicitly")
class RealFheSmoke(unittest.TestCase):
    def test_fresh_keys_real_subprocess_and_client_reference(self):
        runtime = ENGINE_DIR / "runtime"
        runtime.mkdir(exist_ok=True)
        with tempfile.TemporaryDirectory(prefix="test-real-", dir=str(runtime)) as temp:
            root = Path(temp)
            stages = []
            from concrete import fhe
            # The real run must work without any secret-key save/serialization API.
            with contextlib.ExitStack() as stack:
                for method in ("serialize", "serialize_to_file", "save"):
                    stack.enter_context(mock.patch.object(
                        fhe.Keys, method, side_effect=AssertionError("secret key persistence forbidden")))
                result = run_job(fixture(), root, lambda name, message: stages.append(name))
            self.assertEqual(stages, ["ENCRYPTING", "EVALUATING", "VERIFYING"])
            self.assertEqual(result["records"], reference_result(fixture()))
            self.assertIs(result["verified"], True)
            self.assertIs(result["metrics"]["real_fhe"], True)
            self.assertIs(result["metrics"]["evaluation_keys_retained"], False)
            self.assertGreater(result["metrics"]["evaluate_seconds"], 0)
            self.assertEqual({p.name for p in root.iterdir()},
                             {"server.zip", "client-specs.json", "request.bin", "request.json", "response.bin", "receipt.json"})
            for name in ("request.json", "receipt.json"):
                text = (root / name).read_text()
                self.assertNotIn('"records"', text)
                self.assertNotIn('"value"', text)
            self.assertEqual(result["artifactHashes"]["outputSha256"], sha256((root / "response.bin").read_bytes()))
            print("REAL_FHE_SMOKE " + json.dumps({"verified": True, "metrics": result["metrics"]}), flush=True)


if __name__ == "__main__":
    unittest.main()
