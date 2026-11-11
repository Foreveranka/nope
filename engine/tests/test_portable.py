"""Portable circuit semantics, allowlist, remote lifecycle and actual FHE proof."""
import contextlib
import io
import json
import os
import random
import tempfile
import types
import unittest
import zipfile
from pathlib import Path
from unittest import mock

from engine.pipeline import (prepare_job, prepare_remote_job, reference_result,
                             encode_bits, decode_output, _evaluate_subprocess)
from engine.portable import clean4
from engine.portable.build import deterministic_zip
from engine.portable.pins import ARTIFACT_PINS, SOURCE_SHA256
from engine.portable.runtime import inspect_bundle, load_server
from engine.protocol import (ENGINE_DIR, approved_artifacts, canonical_json,
                             sha256, verify_artifact_bytes)
from engine.tests.test_pipeline import fixture
from engine.tests.test_staged import binding, session_double


def synthetic_response(payload):
    output = b"unit-only-ciphertext-placeholder"
    receipt = {"request": json.loads(payload["request.json"]),
               "requestManifestSha256": sha256(payload["request.json"]),
               "outputSha256": sha256(output),
               "metrics": {"server_load_seconds": 0.1, "evaluate_seconds": 0.2}}
    return {"response.bin": output, "receipt.json": canonical_json(receipt)}


class PortableArtifactTests(unittest.TestCase):
    def test_source_and_build_manifest_are_pinned(self):
        self.assertEqual(sha256(Path(clean4.__file__).read_bytes()), SOURCE_SHA256)
        root = ENGINE_DIR / "artifacts/portable-clean4-v1"
        manifest = json.loads((root / "BUILD.json").read_bytes())
        self.assertEqual(manifest["sourceSha256"], SOURCE_SHA256)
        self.assertEqual(manifest["artifacts"], ARTIFACT_PINS)
        for name, pin in json.loads((root / "SHA256.json").read_bytes()).items():
            self.assertEqual(sha256((root / name).read_bytes()), pin)

    def test_portable_is_deterministic_zip_without_object_deserialization(self):
        blobs = approved_artifacts(artifact_set="portable-v1")
        members = inspect_bundle(blobs)
        self.assertEqual(deterministic_zip(members), blobs["server.zip"])
        self.assertEqual(deterministic_zip(dict(reversed(list(members.items())))), blobs["server.zip"])
        self.assertNotIn(b"jsonpickle", blobs["server.zip"])
        with zipfile.ZipFile(io.BytesIO(blobs["server.zip"])) as archive:
            self.assertTrue(all(i.date_time == (1980, 1, 1, 0, 0, 0) for i in archive.infolist()))

    def test_downloads_cannot_choose_artifact_pins_or_carry_extras(self):
        blobs = approved_artifacts(artifact_set="portable-v1")
        self.assertEqual(verify_artifact_bytes(blobs), blobs)
        invalid = [dict(blobs, **{"server.zip": b"untrusted"}),
                   dict(blobs, **{"client-specs.json": b"untrusted"}),
                   dict(blobs, extra=b"ignored?"), {},
                   approved_artifacts()]
        for candidate in invalid:
            with self.assertRaises(ValueError), mock.patch("engine.portable.runtime.require_runtime") as runtime:
                load_server(candidate)
            runtime.assert_not_called()
        with self.assertRaises(ValueError), mock.patch("engine.pipeline.require_runtime") as runtime:
            prepare_remote_job(fixture(), "unused", artifacts={"server.zip": b"untrusted"})
        runtime.assert_not_called()

    def test_plain_circuit_matches_reference_all_values_and_duplicate_layouts(self):
        # Plain execution verifies the extracted Boolean formula, not FHE.
        module = types.SimpleNamespace(fhe=types.SimpleNamespace(array=lambda values: values))
        with mock.patch.dict("sys.modules", {"concrete": module}):
            rng = random.Random(42)
            for value in range(256):
                records = [{"id": i, "value": value} for i in (0, 0, 255, 0)]
                actual = decode_output(records, clean4.clean(encode_bits(records)))
                self.assertEqual(actual, reference_result(records))
            for _ in range(128):
                records = [{"id": rng.randrange(4), "value": rng.randrange(256)} for _ in range(4)]
                self.assertEqual(decode_output(records, clean4.clean(encode_bits(records))),
                                 reference_result(records))


class RemoteLifecycleTests(unittest.TestCase):
    def test_remote_v2_only_sends_public_encrypted_snapshot_and_keeps_original_receipt(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            with session_double(root, artifact_set="portable-v1") as (job, client, local_worker):
                job.bind_external(binding())
                snapshots = []
                def transport(payload):
                    self.assertEqual(set(payload), {"server.zip", "client-specs.json", "request.bin",
                                     "evaluation.keys", "request.json", "binding.json"})
                    self.assertTrue(all(type(v) is bytes for v in payload.values()))
                    with self.assertRaises(TypeError):
                        payload["secret"] = b"forbidden"
                    response = synthetic_response(payload)
                    # Whitespace is deliberately retained as exact evidence.
                    response["receipt.json"] += b"\n"
                    snapshots.append(response["receipt.json"])
                    return response
                metadata = job.evaluate_remote(transport)
                local_worker.assert_not_called()
                client.decrypt.assert_not_called()
                self.assertFalse((root / "evaluation.keys").exists())
                self.assertEqual((root / "receipt.json").read_bytes(), snapshots[0])
                result = job.finalize()
                self.assertEqual(metadata["receiptSha256"], sha256(snapshots[0]))
                self.assertTrue(result["verified"])

    def test_remote_wrong_states_and_macos_fail_before_transport(self):
        with tempfile.TemporaryDirectory() as temp:
            with session_double(Path(temp)) as (job, client, local_worker):
                transport = mock.Mock()
                with self.assertRaises(RuntimeError):
                    job.evaluate_remote(transport)
                job.bind_external(binding())
                with self.assertRaisesRegex(ValueError, "portable"):
                    job.evaluate_remote(transport)
                transport.assert_not_called()
                self.assertEqual(job.state, "BOUND")

    def test_bad_remote_responses_fail_closed_before_decrypt_and_delete_evalkeys(self):
        def response_for(case, payload):
            response = synthetic_response(payload)
            if case == "exception":
                raise RuntimeError("transport failed")
            if case == "ciphertext":
                response["response.bin"] = b"substituted"
            if case == "request":
                receipt = json.loads(response["receipt.json"])
                receipt["request"]["attemptId"] = "00" * 16
                response["receipt.json"] = canonical_json(receipt)
            if case == "extra":
                response["plaintext"] = b"unexpected"
            if case == "type":
                response["receipt.json"] = json.loads(response["receipt.json"])
            if case == "size":
                response["response.bin"] = b"x" * (2 * 1024 * 1024 + 1)
            return response
        for case in ("exception", "ciphertext", "request", "extra", "type", "size"):
            with self.subTest(case=case), tempfile.TemporaryDirectory() as temp:
                root = Path(temp)
                with session_double(root, artifact_set="portable-v1") as (job, client, worker):
                    job.bind_external(binding())
                    with self.assertRaises((ValueError, RuntimeError)):
                        job.evaluate_remote(lambda payload: response_for(case, payload))
                    self.assertEqual(job.state, "FAILED")
                    self.assertIsNone(job._client)
                    self.assertFalse((root / "evaluation.keys").exists())
                    client.decrypt.assert_not_called()
                    worker.assert_not_called()


@unittest.skipUnless(os.environ.get("VEIL_RUN_FHE_SMOKE") == "1", "enable genuine FHE smoke explicitly")
class RealPortableFhe(unittest.TestCase):
    def test_real_portable_load_run_v1_and_bound_v2(self):
        from concrete import fhe
        evidence = []
        runtime = ENGINE_DIR / "runtime"
        runtime.mkdir(exist_ok=True)
        with contextlib.ExitStack() as stack:
            for method in ("serialize", "serialize_to_file", "save"):
                stack.enter_context(mock.patch.object(fhe.Keys, method,
                    side_effect=AssertionError("secret key persistence forbidden")))
            # Local test transport carries the real encrypted bytes to fresh worker
            # subprocesses. No network or remote Linux claim is made by this test.
            for version in (1, 2):
                with tempfile.TemporaryDirectory(prefix="portable-client-", dir=str(runtime)) as temp:
                    root = Path(temp)
                    records = fixture() if version == 1 else [
                        {"id": 255, "value": value} for value in (0, 100, 101, 255)]
                    downloaded = approved_artifacts(artifact_set="portable-v1")
                    prepared = (prepare_remote_job(records, root, artifacts=downloaded) if version == 1
                                else prepare_job(records, root, artifact_set="portable-v1"))
                    with prepared as job:
                        if version == 2:
                            job.bind_external(binding())
                            # Exercise warm loading/reuse with generic object
                            # deserialization forbidden, using the pinned specs.
                            with mock.patch("jsonpickle.loads", side_effect=AssertionError("forbidden")), \
                                    mock.patch.object(fhe.Server, "load", side_effect=AssertionError("forbidden")):
                                warm = load_server(downloaded)
                        def transport(payload):
                            self.assertEqual(len(payload), 5 if version == 1 else 6)
                            with tempfile.TemporaryDirectory(prefix="portable-worker-", dir=str(runtime)) as work:
                                remote = Path(work)
                                for name, blob in payload.items():
                                    (remote / name).write_bytes(blob)
                                if version == 1:
                                    _evaluate_subprocess(remote)
                                else:
                                    from engine.worker import evaluate
                                    with mock.patch("jsonpickle.loads", side_effect=AssertionError("forbidden")), \
                                            mock.patch.object(fhe.Server, "load", side_effect=AssertionError("forbidden")):
                                        evaluate(remote, server=warm)
                                return {name: (remote / name).read_bytes() for name in
                                        ("response.bin", "receipt.json")}
                        metadata = job.evaluate_remote(transport)
                        result = job.finalize()
                    self.assertEqual(result["records"], reference_result(records))
                    self.assertTrue(result["verified"])
                    self.assertFalse((root / "evaluation.keys").exists())
                    self.assertGreater(result["metrics"]["evaluate_seconds"], 0)
                    self.assertEqual(metadata["receiptSha256"], result["artifactHashes"]["receiptSha256"])
                    item = {"protocolVersion": version, "metrics": result["metrics"],
                            "artifactHashes": result["artifactHashes"], "verified": True,
                            "secret_key_serialization_blocked": True,
                            "evaluation_keys_deleted": True,
                            "client_references_released": job._client is None,
                            "execution": ("macOS actual FHE, portable MLIR load in separate subprocess"
                                          if version == 1 else "macOS actual FHE, warm server reuse in test process"),
                            "generic_object_deserialization_blocked": version == 2}
                    evidence.append(item)
                    destination = os.environ.get("VEIL_PORTABLE_EVIDENCE_DIR")
                    if destination:
                        target = Path(destination).resolve()
                        if ENGINE_DIR not in target.parents:
                            raise ValueError("Evidence must remain inside engine/")
                        target.mkdir(parents=True, exist_ok=True)
                        for name in ("request.json", "receipt.json", "binding.json"):
                            if (root / name).exists():
                                (target / ("v%d-" % version + name)).write_bytes((root / name).read_bytes())
                        (target / "evidence.json").write_bytes(canonical_json(evidence))
        print("REAL_PORTABLE_FHE " + json.dumps(evidence), flush=True)


if __name__ == "__main__":
    unittest.main()
