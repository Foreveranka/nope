"""Session safety tests use explicit doubles; RealStagedFhe uses actual Concrete."""
import contextlib
import json
import os
import pickle
import tempfile
import types
import unittest
from pathlib import Path
from unittest import mock

from engine.pipeline import prepare_job, reference_result
from engine.protocol import (ENGINE_DIR, canonical_json, read_regular, sha256,
                             validate_external_binding, validate_manifest,
                             verify_external_binding)
from engine.tests.test_pipeline import fixture, request_manifest
from engine.worker import evaluate as worker_evaluate


def binding():
    # Synthetic public registry-context fixture, not a real registry snapshot.
    return {"job_id": "42", "attempt": "1", "job_binding_hash": "11" * 32,
            "attempt_binding_hash": "22" * 32, "bidset_root": "33" * 32}


def output_bits():
    result = reference_result(fixture())
    return [int(row["duplicate"]) for row in result] + [
        (row["value"] >> bit) & 1 for row in result for bit in range(8)]


def unit_evaluator(root):
    """Explicit lifecycle test double, never evidence of FHE computation."""
    manifest_bytes = (root / "request.json").read_bytes()
    output = b"unit-test-only output ciphertext placeholder"
    receipt = {"request": json.loads(manifest_bytes),
               "requestManifestSha256": sha256(manifest_bytes),
               "outputSha256": sha256(output),
               "metrics": {"server_load_seconds": 0.1, "evaluate_seconds": 0.2}}
    (root / "response.bin").write_bytes(output)
    (root / "receipt.json").write_bytes(canonical_json(receipt))


@contextlib.contextmanager
def session_double(root, **kwargs):
    client = mock.Mock()
    client.encrypt.return_value.serialize.return_value = b"unit-test-only encrypted input placeholder"
    client.evaluation_keys.serialize.return_value = b"unit-test-only public evaluation key placeholder"
    client.decrypt.return_value = output_bits()
    fhe = types.SimpleNamespace(Client=mock.Mock(return_value=client),
                                ClientSpecs=types.SimpleNamespace(deserialize=lambda x: x),
                                Value=types.SimpleNamespace(deserialize=lambda x: x))
    numpy = types.SimpleNamespace(array=lambda data, dtype: data, int64=int)
    with mock.patch.dict("sys.modules", {"concrete": types.SimpleNamespace(fhe=fhe), "numpy": numpy}), \
            mock.patch("engine.pipeline.require_runtime"), \
            mock.patch("engine.pipeline._evaluate_subprocess", side_effect=unit_evaluator) as worker:
        with prepare_job(fixture(), root, **kwargs) as prepared:
            yield prepared, client, worker


class StagedLifecycleTests(unittest.TestCase):
    def test_prepare_exposes_immutable_bindings_without_evaluation(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            stages = []
            with session_double(root, on_stage=lambda stage, msg: stages.append(stage)) as (job, client, worker):
                self.assertEqual(job.state, "PREPARED")
                worker.assert_not_called()
                client.decrypt.assert_not_called()
                self.assertFalse((root / "request.json").exists())
                self.assertEqual(stages, ["ENCRYPTING"])
                initial = job.manifest
                hashes = job.artifact_hashes
                self.assertEqual(hashes["inputSha256"], sha256((root / "request.bin").read_bytes()))
                self.assertNotIn("requestManifestSha256", hashes)
                with self.assertRaises(TypeError):
                    initial["attemptId"] = "altered"
                with self.assertRaises(TypeError):
                    hashes["inputSha256"] = "altered"
                with self.assertRaisesRegex(TypeError, "cannot be serialized"):
                    pickle.dumps(job)
                ctx = binding()
                job.bind_external(ctx)
                ctx["job_id"] = "43"
                self.assertEqual(job.external_binding["job_id"], "42")
                self.assertEqual(initial["protocolVersion"], 1)
                self.assertEqual(job.manifest["protocolVersion"], 2)
                self.assertEqual(initial["attemptId"], job.manifest["attemptId"])
                for key, value in hashes.items():
                    self.assertEqual(job.artifact_hashes[key], value)
                self.assertEqual(read_regular(root / "request.json", 8192), job.manifest_bytes)
                self.assertEqual(job.manifest["externalBindingSha256"], sha256(canonical_json(binding())))
                worker.assert_not_called()
            self.assertIsNone(job._client)
            self.assertIsNone(job._records)
            self.assertFalse((root / "evaluation.keys").exists())

    def test_correct_states_and_finalize_shape(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            with session_double(root) as (job, client, worker):
                for method in (job.evaluate, job.finalize):
                    with self.assertRaises(RuntimeError):
                        method()
                job.bind_external(binding())
                with self.assertRaises(RuntimeError):
                    job.bind_external(binding())
                with self.assertRaises(RuntimeError):
                    job.finalize()
                metadata = job.evaluate()
                self.assertEqual(job.state, "EVALUATED")
                client.decrypt.assert_not_called()
                self.assertFalse((root / "evaluation.keys").exists())
                worker.assert_called_once()
                with self.assertRaises(TypeError):
                    metadata["receipt"]["request"]["attemptId"] = "altered"
                with self.assertRaises(RuntimeError):
                    job.evaluate()
                result = job.finalize()
                self.assertEqual(result["records"], reference_result(fixture()))
                self.assertEqual(set(result), {"records", "verified", "metrics", "artifactHashes"})
                self.assertEqual(result["artifactHashes"]["externalBindingSha256"], job.manifest["externalBindingSha256"])
                self.assertFalse(result["metrics"]["verification_is_cryptographic_proof"])
                self.assertEqual(job.state, "FINALIZED")
                self.assertIsNone(job._client)
                self.assertIsNone(job._records)
                with self.assertRaises(RuntimeError):
                    job.finalize()
                with self.assertRaises(RuntimeError):
                    job.evaluate()
            self.assertEqual(job.state, "FINALIZED")

    def test_exit_and_explicit_close_without_evaluation(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            with session_double(root) as (job, client, worker):
                job.close()
                job.close()
                self.assertEqual(job.state, "CLOSED")
                self.assertIsNone(job._client)
                with self.assertRaises(RuntimeError):
                    job.bind_external(binding())
                with self.assertRaises(RuntimeError):
                    job.evaluate()
            worker.assert_not_called()
            self.assertFalse((root / "evaluation.keys").exists())

    def test_abandon_evaluated_session_and_exception_release_keys_and_lock(self):
        for evaluated in (False, True):
            with self.subTest(evaluated=evaluated), tempfile.TemporaryDirectory() as temp:
                root = Path(temp)
                with self.assertRaisesRegex(RuntimeError, "caller failure"):
                    with session_double(root) as (job, client, worker):
                        if evaluated:
                            job.bind_external(binding())
                            job.evaluate()
                        raise RuntimeError("caller failure")
                self.assertEqual(job.state, "CLOSED")
                self.assertIsNone(job._client)
                self.assertFalse((root / "evaluation.keys").exists())

    def test_prepare_failure_cleans_keys_and_allows_next_session(self):
        # Failure writing a sealed v1 manifest occurs after eval-key creation.
        from engine import pipeline
        original = pipeline.write_new
        def fail(path, data):
            if path.name == "request.json":
                raise RuntimeError("synthetic write failure")
            original(path, data)
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            with self.assertRaisesRegex(RuntimeError, "synthetic write failure"):
                with mock.patch("engine.pipeline.write_new", side_effect=fail):
                    with session_double(root) as (job, client, worker):
                        job.bind_external(binding())
            self.assertFalse((root / "evaluation.keys").exists())

    def test_every_prepared_file_revalidated_before_evaluation(self):
        for name in ("server.zip", "client-specs.json", "request.bin", "request.json", "evaluation.keys", "binding.json"):
            with self.subTest(name=name), tempfile.TemporaryDirectory() as temp:
                root = Path(temp)
                with session_double(root) as (job, client, worker):
                    job.bind_external(binding())
                    (root / name).write_bytes(b"substituted")
                    with self.assertRaises(ValueError):
                        job.evaluate()
                    worker.assert_not_called()
                    client.decrypt.assert_not_called()
                    self.assertEqual(job.state, "FAILED")
                    self.assertIsNone(job._client)
                    self.assertFalse((root / "evaluation.keys").exists())

    def test_files_revalidated_before_finalize_and_no_decrypt_on_tamper(self):
        for name in ("server.zip", "client-specs.json", "request.bin", "request.json", "binding.json", "response.bin", "receipt.json"):
            with self.subTest(name=name), tempfile.TemporaryDirectory() as temp:
                root = Path(temp)
                with session_double(root) as (job, client, worker):
                    job.bind_external(binding())
                    job.evaluate()
                    (root / name).write_bytes(b"substituted")
                    with self.assertRaises(ValueError):
                        job.finalize()
                    client.decrypt.assert_not_called()
                    self.assertIsNone(job._client)
                    self.assertEqual(job.state, "FAILED")

    def test_consistent_output_and_receipt_substitution_after_evaluate_rejected(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            with session_double(root) as (job, client, worker):
                job.bind_external(binding())
                job.evaluate()
                output = b"substituted ciphertext and internally consistent receipt"
                receipt = json.loads((root / "receipt.json").read_bytes())
                receipt["outputSha256"] = sha256(output)
                (root / "response.bin").write_bytes(output)
                (root / "receipt.json").write_bytes(canonical_json(receipt))
                with self.assertRaisesRegex(ValueError, "changed before finalize"):
                    job.finalize()
                client.decrypt.assert_not_called()

    def test_reappearing_evaluation_key_rejected_at_finalize(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            with session_double(root) as (job, client, worker):
                job.bind_external(binding())
                job.evaluate()
                (root / "evaluation.keys").write_bytes(b"injected artifact")
                with self.assertRaisesRegex(ValueError, "reappeared"):
                    job.finalize()
                client.decrypt.assert_not_called()
                self.assertEqual(job.state, "FAILED")

    def test_deleted_evaluation_key_does_not_mask_failure_or_leak_session(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            with session_double(root) as (job, client, worker):
                job.bind_external(binding())
                (root / "evaluation.keys").unlink()
                with self.assertRaises(FileNotFoundError):
                    job.evaluate()
                self.assertIsNone(job._client)
                self.assertEqual(job.state, "FAILED")
                worker.assert_not_called()

    def test_evaluator_failure_or_callback_error_closes_session(self):
        for callback_failure in (False, True):
            with self.subTest(callback=callback_failure), tempfile.TemporaryDirectory() as temp:
                root = Path(temp)
                def callback(stage, message):
                    if callback_failure and stage == "EVALUATING":
                        raise RuntimeError("callback failed")
                with session_double(root, on_stage=callback) as (job, client, worker):
                    job.bind_external(binding())
                    if not callback_failure:
                        worker.side_effect = RuntimeError("worker failed")
                    with self.assertRaises(RuntimeError):
                        job.evaluate()
                    self.assertEqual(job.state, "FAILED")
                    self.assertIsNone(job._client)
                    self.assertFalse((root / "evaluation.keys").exists())

    def test_reference_failure_never_returns_success(self):
        with tempfile.TemporaryDirectory() as temp:
            with session_double(Path(temp)) as (job, client, worker):
                job.bind_external(binding())
                job.evaluate()
                client.decrypt.return_value = [0] * 36
                with self.assertRaisesRegex(RuntimeError, "reference verification failed"):
                    job.finalize()
                self.assertEqual(job.state, "FAILED")
                self.assertIsNone(job._client)


class ExternalContextTests(unittest.TestCase):
    def test_exact_external_schema_u64_and_digest_validation(self):
        validate_external_binding(binding())
        for key in binding():
            for bad in (None, True, 1, [], {}, "", "UPPER", "../escape"):
                ctx = dict(binding(), **{key: bad})
                with self.subTest(key=key, bad=bad), self.assertRaises(ValueError):
                    validate_external_binding(ctx)
        for update in ({"job_id": "01"}, {"attempt": "0"}, {"attempt": "18446744073709551616"},
                       {"job_id": "1" * 10000}, {"extra": "field"}):
            with self.assertRaises(ValueError):
                validate_external_binding(dict(binding(), **update))

    def test_v2_requires_binding_hash_and_v1_cannot_smuggle_it(self):
        manifest = dict(request_manifest(), protocolVersion=2, externalBindingSha256=sha256(canonical_json(binding())))
        validate_manifest(manifest)
        verify_external_binding(manifest, canonical_json(binding()))
        for update in ({"protocolVersion": 1}, {"externalBindingSha256": "invalid"}, {"protocolVersion": True}):
            with self.assertRaises(ValueError):
                validate_manifest(dict(manifest, **update))
        del manifest["externalBindingSha256"]
        with self.assertRaises(ValueError):
            validate_manifest(manifest)

    def test_worker_rejects_each_external_context_substitution_before_runtime(self):
        original = canonical_json(binding())
        manifest = dict(request_manifest(), protocolVersion=2, externalBindingSha256=sha256(original))
        for key in binding():
            with self.subTest(field=key), tempfile.TemporaryDirectory() as temp:
                root = Path(temp)
                altered = dict(binding(), **{key: "2" if key in ("job_id", "attempt") else "44" * 32})
                (root / "request.json").write_bytes(canonical_json(manifest))
                (root / "binding.json").write_bytes(canonical_json(altered))
                with mock.patch("engine.worker.require_runtime") as runtime:
                    with self.assertRaisesRegex(ValueError, "binding hash mismatch"):
                        worker_evaluate(root)
                    runtime.assert_not_called()


@unittest.skipUnless(os.environ.get("VEIL_RUN_FHE_SMOKE") == "1", "enable genuine FHE smoke explicitly")
class RealStagedFhe(unittest.TestCase):
    def test_real_prepare_bind_evaluate_finalize(self):
        runtime = ENGINE_DIR / "runtime"
        runtime.mkdir(exist_ok=True)
        with tempfile.TemporaryDirectory(prefix="test-staged-real-", dir=str(runtime)) as temp:
            root = Path(temp)
            from concrete import fhe
            stages = []
            with contextlib.ExitStack() as stack:
                for method in ("serialize", "serialize_to_file", "save"):
                    stack.enter_context(mock.patch.object(
                        fhe.Keys, method, side_effect=AssertionError("secret key persistence forbidden")))
                with prepare_job(fixture(), root, lambda name, msg: stages.append(name)) as job:
                    self.assertEqual(job.state, "PREPARED")
                    self.assertEqual(stages, ["ENCRYPTING"])
                    self.assertFalse((root / "response.bin").exists())
                    self.assertEqual(job.artifact_hashes["inputSha256"], sha256((root / "request.bin").read_bytes()))
                    self.assertEqual(job.artifact_hashes["evaluationKeysSha256"], sha256((root / "evaluation.keys").read_bytes()))
                    with self.assertRaises(RuntimeError):
                        job.evaluate()  # Registry context is mandatory in staged mode.
                    with self.assertRaises(RuntimeError):
                        job.finalize()
                    job.bind_external(binding())
                    immutable_manifest = job.manifest
                    metadata = job.evaluate()
                    self.assertEqual(job.state, "EVALUATED")
                    self.assertIsNotNone(job._client)
                    self.assertFalse((root / "evaluation.keys").exists())
                    result = job.finalize()
                    self.assertEqual(dict(immutable_manifest), dict(job.manifest))
                    self.assertIsNone(job._client)
                    self.assertIsNone(job._records)
            self.assertEqual(stages, ["ENCRYPTING", "EVALUATING", "VERIFYING"])
            self.assertEqual(result["records"], reference_result(fixture()))
            self.assertIs(result["verified"], True)
            self.assertGreater(result["metrics"]["evaluate_seconds"], 0)
            self.assertEqual(metadata["outputSha256"], result["artifactHashes"]["outputSha256"])
            self.assertEqual({p.name for p in root.iterdir()}, {"server.zip", "client-specs.json", "request.bin",
                              "request.json", "binding.json", "response.bin", "receipt.json"})
            evidence = {"schema": "veil-staged-fhe-evidence-v1", "synthetic_registry_context": True,
                        "execution_proof": False, "verified": result["verified"],
                        "metrics": result["metrics"], "artifactHashes": result["artifactHashes"],
                        "stages": stages, "secret_key_serialization_apis_blocked": True,
                        "client_references_released": job._client is None and job._records is None,
                        "evaluation_keys_deleted": not (root / "evaluation.keys").exists()}
            evidence_dir = os.environ.get("VEIL_FHE_EVIDENCE_DIR")
            if evidence_dir:
                target = Path(evidence_dir).resolve()
                if ENGINE_DIR not in target.parents:
                    raise ValueError("Engine smoke evidence must remain under engine/")
                target.mkdir(mode=0o700, parents=True, exist_ok=True)
                for name in ("request.json", "receipt.json", "binding.json"):
                    (target / name).write_bytes((root / name).read_bytes())
                (target / "evidence.json").write_bytes(canonical_json(evidence))
            print("REAL_STAGED_FHE_SMOKE " + json.dumps(evidence), flush=True)


if __name__ == "__main__":
    unittest.main()
