"""Adversarial offline gate tests using public synthetic declarations only."""

from contextlib import redirect_stdout
from copy import deepcopy
import hashlib
import io
import json
from pathlib import Path
import socket
import subprocess
import tempfile
import unittest
from unittest.mock import patch

from operators.validate_manifest import (
    BLOCKERS, MAX_BYTES, ManifestError, canonical, digest, load_manifest, main,
    parse_manifest, validate_manifest,
)


EXAMPLES = Path(__file__).resolve().parents[1] / "examples"
FIXTURE = EXAMPLES / "synthetic-plan.json"
PIN = (EXAMPLES / "synthetic-plan.canonical.sha256").read_text().strip()


class ManifestTests(unittest.TestCase):
    def setUp(self):
        self.plan = load_manifest(FIXTURE)

    def rejected(self, change):
        plan = deepcopy(self.plan)
        change(plan)
        # Even a newly trusted digest must not bypass structural requirements.
        with self.assertRaises(ManifestError):
            validate_manifest(plan, digest(plan))

    def test_valid_plan_is_pinned_but_always_blocked(self):
        before = deepcopy(self.plan)
        report = validate_manifest(self.plan, PIN)
        self.assertEqual(self.plan, before)
        self.assertTrue(report["manifest_valid"])
        self.assertEqual(report["manifest_sha256"], PIN)
        for field in ("deployment_allowed", "administrative_independence_proven",
                      "network_checked", "artifacts_verified"):
            self.assertIs(report[field], False)
        self.assertEqual(report["blockers"], list(BLOCKERS))

    def test_canonical_digest_ignores_whitespace_and_key_order(self):
        reordered = dict(reversed(list(self.plan.items())))
        parsed = parse_manifest(json.dumps(reordered, indent=4).encode())
        self.assertEqual(digest(parsed), PIN)
        self.assertEqual(canonical({"z": True, "a": 1}), b'{"a":1,"z":true}')
        self.assertEqual(digest({"z": True, "a": 1}),
                         hashlib.sha256(b'{"a":1,"z":true}').hexdigest())

    def test_digest_is_required_and_canonical(self):
        for value in (None, True, 1, "", "0" * 64, PIN.upper(), "sha256:" + PIN, "g" * 64):
            with self.subTest(value=value), self.assertRaises(ManifestError):
                validate_manifest(self.plan, value)
        with self.assertRaisesRegex(ManifestError, "trusted digest mismatch"):
            validate_manifest(self.plan, "f" * 64)

    def test_coherent_context_substitution_still_fails_external_pin(self):
        for key in ("job", "attempt", "fixedFee", "qualified"):
            with self.subTest(field=key):
                plan = deepcopy(self.plan)
                plan["execution"]["descriptor"][key] = {
                    "job": "a" * 64, "attempt": "b" * 64,
                    "fixedFee": 7, "qualified": [False, True, True],
                }[key]
                plan["execution_sha256"] = digest(plan["execution"])
                with self.assertRaisesRegex(ManifestError, "trusted digest mismatch"):
                    validate_manifest(plan, PIN)

    def test_build_endpoint_and_certificate_substitution_fail_external_pin(self):
        changes = (
            lambda p: p["build"].update(binary_sha256="a" * 64),
            lambda p: p["operators"][0].update(certificate_sha256="b" * 64),
            lambda p: p["operators"][0].update(host="other.operator.example"),
            lambda p: p["operators"][0].update(client_port=16001),
            lambda p: p.update(trust_anchor_sha256="c" * 64),
        )
        for change in changes:
            with self.subTest(change=change):
                plan = deepcopy(self.plan)
                change(plan)
                with self.assertRaisesRegex(ManifestError, "trusted digest mismatch"):
                    validate_manifest(plan, PIN)

    def test_exact_schemas_reject_unknown_and_missing_fields(self):
        paths = ((), ("execution",), ("execution", "descriptor"), ("build",), ("operators", 0))
        for path in paths:
            for add in (True, False):
                with self.subTest(path=path, add=add):
                    def change(p):
                        obj = p
                        for key in path:
                            obj = obj[key]
                        if add:
                            obj["private_key"] = "DO-NOT-LOG-THIS"
                        else:
                            obj.pop(next(iter(obj)))
                    self.rejected(change)

    def test_unsupported_versions_and_profiles(self):
        for path, value in ((('schema',), "veil-operator-plan-v2"),
                            (('execution', 'descriptor', 'profile'), "arbitrary-program"),
                            (('execution', 'descriptor', 'upstream'), "a" * 40),
                            (('build', 'upstream'), "a" * 40)):
            with self.subTest(path=path):
                def change(p):
                    obj = p
                    for key in path[:-1]:
                        obj = obj[key]
                    obj[path[-1]] = value
                    p["execution_sha256"] = digest(p["execution"])
                self.rejected(change)

    def test_execution_digest_mismatch_and_commitment_order(self):
        self.rejected(lambda p: p.update(execution_sha256="a" * 64))
        self.rejected(lambda p: p["execution"]["commitments"].reverse())
        self.rejected(lambda p: p["execution"]["commitments"].pop())
        def duplicate(p):
            p["execution"]["commitments"][1] = p["execution"]["commitments"][0]
            p["execution_sha256"] = digest(p["execution"])
        self.rejected(duplicate)

    def test_three_ordered_parties_only(self):
        changes = (
            lambda p: p["operators"].pop(),
            lambda p: p["operators"].append(deepcopy(p["operators"][0])),
            lambda p: p["operators"].reverse(),
            lambda p: p["operators"][1].update(party=0),
            lambda p: p["operators"][0].update(party=False),
        )
        for change in changes:
            self.rejected(change)

    def test_duplicate_operator_identities_admins_hosts_and_certificates(self):
        for key in ("identity", "administrative_domain", "host", "certificate_sha256"):
            with self.subTest(field=key):
                self.rejected(lambda p: p["operators"][1].update({key: p["operators"][0][key]}))
        self.rejected(lambda p: p["operators"][0].update(certificate_sha256=p["trust_anchor_sha256"]))

    def test_identity_aliases_rejected(self):
        for key in ("identity", "administrative_domain"):
            for value in ("UPPER", " space", "trailing ", "a/b", "é", "", 0, "a" * 64):
                with self.subTest(field=key, value=value):
                    self.rejected(lambda p: p["operators"][0].update({key: value}))

    def test_endpoint_ambiguities_and_local_addresses_rejected(self):
        hosts = ("127.0.0.1", "127.2.3.4", "::1", "0.0.0.0", "0.0.0.1", "::", "224.0.0.1",
                 "169.254.1.2", "fe80::1", "::ffff:127.0.0.1", "localhost",
                 "a.localhost", "a.local", "a.localdomain", "127.1", "2130706433",
                 "0x7f000001", "0177.0.0.1", "127.000.0.1", "P0.example",
                 "p0.example.", "https://p0.example", "user@p0.example", "p0.example:443",
                 "p0.example/path", "p0.example?query", "[2001:db8::1]", "fe80::1%en0",
                 "xn--x.example", "a..example", "-a.example", "a-.example", "a.123")
        for value in hosts:
            with self.subTest(host=value):
                self.rejected(lambda p: p["operators"][0].update(host=value))

    def test_private_network_and_ipv6_plans_can_be_declared_without_dialing(self):
        for hosts in (("10.20.0.1", "10.20.0.2", "10.20.0.3"),
                      ("fd12:3456::1", "fd12:3456::2", "fd12:3456::3")):
            plan = deepcopy(self.plan)
            for op, host in zip(plan["operators"], hosts):
                op["host"] = host
            self.assertTrue(validate_manifest(plan, digest(plan))["manifest_valid"])

    def test_ports_are_integers_with_no_local_collision(self):
        for key in ("peer_port", "client_port"):
            for value in (False, True, 0, -1, 65536, 15000.0, "15000", None):
                with self.subTest(field=key, value=value):
                    self.rejected(lambda p: p["operators"][0].update({key: value}))
        self.rejected(lambda p: p["operators"][0].update(client_port=p["operators"][0]["peer_port"]))
        plan = deepcopy(self.plan)
        plan["operators"][0].update(peer_port=1, client_port=65535)
        self.assertTrue(validate_manifest(plan, digest(plan))["manifest_valid"])

    def test_hashes_are_strict_not_just_length_checked(self):
        for value in ("0" * 64, "A" * 64, "g" * 64, "a" * 63, "a" * 65,
                      " " + "a" * 63, None, [], 7):
            for key in ("binary_sha256", "source_sha256", "transport_patch_sha256",
                        "build_recipe_sha256", "bytecode_sha256", "schedule_sha256"):
                with self.subTest(value=value, field=key):
                    self.rejected(lambda p: p["build"].update({key: value}))
            self.rejected(lambda p: p["operators"][0].update(certificate_sha256=value))
            self.rejected(lambda p: p.update(trust_anchor_sha256=value))
            for key in ("job", "attempt"):
                def change(p):
                    p["execution"]["descriptor"][key] = value
                    p["execution_sha256"] = digest(p["execution"])
                self.rejected(change)

    def test_qualification_and_fee_boundaries(self):
        for value in ([1, 1, 1], [True], [True] * 4, "true", None):
            self.rejected(lambda p: p["execution"]["descriptor"].update(qualified=value))
        for value in (True, False, -1, 10**12 + 1, 1.0, "1"):
            self.rejected(lambda p: p["execution"]["descriptor"].update(fixedFee=value))
        for fee in (0, 10**12):
            plan = deepcopy(self.plan)
            plan["execution"]["descriptor"].update(fixedFee=fee, qualified=[False] * 3)
            plan["execution_sha256"] = digest(plan["execution"])
            self.assertTrue(validate_manifest(plan, digest(plan))["manifest_valid"])

    def test_wrong_container_types_fail_cleanly(self):
        for value in (None, [], True, 0, "manifest"):
            with self.subTest(value=value), self.assertRaises(ManifestError):
                validate_manifest(value, PIN)
        for key in ("execution", "build", "operators"):
            for value in (None, True, "bad", 0):
                self.rejected(lambda p: p.update({key: value}))

    def test_json_duplicates_nonfinite_encoding_size_and_depth(self):
        for raw in (b'{"schema":1,"schema":2}', b'{"nested":{"x":1,"x":2}}',
                    b'{"x":NaN}', b'{"x":Infinity}', b'{"x":-Infinity}',
                    b'\xff', b'\xef\xbb\xbf{}', b'{} trailing', b'',
                    b' ' * (MAX_BYTES + 1), b'[' * 2000 + b']' * 2000):
            with self.subTest(raw=raw[:30]), self.assertRaises(ManifestError):
                parse_manifest(raw)

    def test_validation_has_no_network_or_subprocess_effects(self):
        with patch.object(socket, "socket", side_effect=AssertionError("network forbidden")), \
                patch.object(socket, "getaddrinfo", side_effect=AssertionError("DNS forbidden")), \
                patch.object(subprocess, "Popen", side_effect=AssertionError("launch forbidden")):
            self.assertTrue(validate_manifest(load_manifest(FIXTURE), PIN)["manifest_valid"])

    def test_cli_default_blocks_and_structure_only_is_explicit(self):
        for options, expected in (([], 3), (["--structure-only"], 0)):
            output = io.StringIO()
            with redirect_stdout(output):
                code = main([str(FIXTURE), "--expected-sha256", PIN] + options)
            self.assertEqual(code, expected)
            result = json.loads(output.getvalue())
            self.assertTrue(result["manifest_valid"])
            self.assertIs(result["deployment_allowed"], False)

    def test_cli_failures_are_nonzero_and_never_echo_input(self):
        bad = deepcopy(self.plan)
        bad["secret-key-DO-NOT-LOG"] = "SECRET-DO-NOT-LOG"
        with tempfile.TemporaryDirectory(dir=Path(__file__).parent) as temp:
            path = Path(temp) / "private-filename-DO-NOT-LOG.json"
            path.write_text(json.dumps(bad))
            for candidate, pin in ((path, PIN), (FIXTURE, "f" * 64),
                                   (Path(temp) / "missing", PIN)):
                output = io.StringIO()
                with redirect_stdout(output):
                    code = main([str(candidate), "--expected-sha256", pin])
                self.assertEqual(code, 2)
                self.assertNotIn("DO-NOT-LOG", output.getvalue())
                self.assertNotIn(str(temp), output.getvalue())
                self.assertIs(json.loads(output.getvalue())["deployment_allowed"], False)


if __name__ == "__main__":
    unittest.main()
