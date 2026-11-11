"""The operator gate delegates selection semantics to the active MPC v2 codec."""

from contextlib import redirect_stdout
from copy import deepcopy
import io
import json
from pathlib import Path
import socket
import unittest
from unittest.mock import patch

from mpc import v2
from operators.validate_manifest import ManifestError, digest, load_manifest, main, validate_manifest


EXAMPLES = Path(__file__).resolve().parents[1] / "examples"
FIXTURE = EXAMPLES / "synthetic-v2-plan.json"
PIN = (EXAMPLES / "synthetic-v2-plan.canonical.sha256").read_text().strip()


class SelectionTests(unittest.TestCase):
    def setUp(self):
        self.plan = load_manifest(FIXTURE)

    def rejected(self, change):
        plan = deepcopy(self.plan)
        change(plan)
        with self.assertRaises(ManifestError):
            validate_manifest(plan, digest(plan))

    def test_v2_uses_authoritative_validation_and_domain_tagged_digest(self):
        with patch.object(v2, "validate_manifest", wraps=v2.validate_manifest) as validate, \
                patch.object(v2, "manifest_digest", wraps=v2.manifest_digest) as hash_manifest:
            report = validate_manifest(self.plan, PIN)
        validate.assert_called_with(self.plan["execution"])
        hash_manifest.assert_called_once_with(self.plan["execution"])
        self.assertEqual(report["execution_mode"], "v2-selection")
        self.assertTrue(report["manifest_valid"])
        self.assertIs(report["deployment_allowed"], False)
        self.assertIs(report["registry_finality_verified"], False)
        self.assertNotEqual(digest(self.plan["execution"]), report["execution_sha256"])

    def test_no_implicit_mode_or_cross_version_fallback(self):
        for mode in (None, "v1", "v2", "v1-compatibility", [], {}):
            with self.subTest(mode=mode):
                self.rejected(lambda p: p.update(execution_mode=mode))
        self.rejected(lambda p: p.pop("execution_mode"))
        legacy = load_manifest(EXAMPLES / "synthetic-plan.json")
        legacy["execution_mode"] = "v2-selection"
        with self.assertRaises(ManifestError):
            validate_manifest(legacy, digest(legacy))

    def test_v2_build_source_must_equal_intent_and_execution_build(self):
        self.rejected(lambda p: p["build"].update(source_sha256="a" * 64))
        self.rejected(lambda p: p["execution"]["mpcBuild"].update(circuitSourceHash="a" * 64))
        self.rejected(lambda p: p["execution"]["intent"].update(mpcProgramHash="a" * 64))

    def test_plain_json_execution_hash_is_not_the_v2_digest(self):
        self.rejected(lambda p: p.update(execution_sha256=digest(p["execution"])))

    def test_invalid_selection_context_roster_bidset_and_registry_hashes(self):
        changes = (
            lambda e: e.update(precommitContext="a" * 64),
            lambda e: e.update(selectionRound="a" * 64),
            lambda e: e["closedJob"].update(state="Open"),
            lambda e: e["closedJob"].update(attempt="1"),
            lambda e: e["closedJob"].update(attempt_binding_hash=[1] * 32),
            lambda e: e["closedJob"].update(bidset_root=[1] * 32),
            lambda e: e["closedJob"].update(job_binding_hash=[1] * 32),
            lambda e: e["closedJob"]["bids"].pop(),
            lambda e: e["closedJob"]["bids"].reverse(),
            lambda e: e["closedJob"]["bids"][0].update(commitment=None),
            lambda e: e["closedJob"]["config"].update(context_hash=[True] * 32),
            lambda e: e["closedJob"]["config"].update(executor="substitute.testnet"),
        )
        for change in changes:
            with self.subTest(change=change):
                self.rejected(lambda p: change(p["execution"]))

    def test_paired_null_selection_fields_and_legacy_closed_shape(self):
        job = self.plan["execution"]["closedJob"]
        self.assertIsNone(job["selected_executor"])
        self.assertIsNone(job["attempt_binding_version"])
        validate_manifest(self.plan, PIN)
        legacy_shape = deepcopy(self.plan)
        legacy_job = legacy_shape["execution"]["closedJob"]
        legacy_job.pop("selected_executor")
        legacy_job.pop("attempt_binding_version")
        legacy_shape["execution_sha256"] = v2.manifest_digest(legacy_shape["execution"])
        self.assertTrue(validate_manifest(legacy_shape, digest(legacy_shape))["manifest_valid"])
        for key in ("selected_executor", "attempt_binding_version"):
            with self.subTest(field=key):
                self.rejected(lambda p: p["execution"]["closedJob"].pop(key))
                self.rejected(lambda p: p["execution"]["closedJob"].update({key: "unexpected"}))

    def test_upstream_rejection_never_falls_back_to_legacy_checks(self):
        with patch.object(v2, "validate_manifest", side_effect=ValueError("DO-NOT-LOG")):
            with self.assertRaisesRegex(ManifestError, "invalid or unavailable v2"):
                validate_manifest(self.plan, PIN)

    def test_v2_performs_no_dns_or_socket_access(self):
        with patch.object(socket, "socket", side_effect=AssertionError("network forbidden")), \
                patch.object(socket, "getaddrinfo", side_effect=AssertionError("DNS forbidden")):
            self.assertTrue(validate_manifest(load_manifest(FIXTURE), PIN)["manifest_valid"])

    def test_v2_cli_is_always_a_deployment_gate(self):
        for options, code in (([], 3), (["--structure-only"], 0)):
            out = io.StringIO()
            with redirect_stdout(out):
                actual = main([str(FIXTURE), "--expected-sha256", PIN] + options)
            self.assertEqual(actual, code)
            self.assertIs(json.loads(out.getvalue())["deployment_allowed"], False)


if __name__ == "__main__":
    unittest.main()
