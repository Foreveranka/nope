"""Offline adversarial profile tests. No native build, launch, sockets or TLS run."""

from contextlib import redirect_stdout
from copy import deepcopy
from dataclasses import FrozenInstanceError
import hashlib
import io
import json
from pathlib import Path
import socket
import subprocess
import tempfile
import unittest
from unittest.mock import patch

from mpc import network_profile as net, v2
from mpc.sample_v2 import synthetic_closed_job, synthetic_intent


NOW = 1800000000


def sha(label):
    return hashlib.sha256(("synthetic-network-test:" + label).encode()).hexdigest()


def fixture():
    prepared = v2.prepare_synthetic(synthetic_intent(
        bid_deadline_ns=str((NOW-10)*10**9), result_deadline_ns=str((NOW+4000)*10**9)))
    selection = v2.build_selection_manifest(prepared, synthetic_closed_job(prepared))
    selection_hash = v2.manifest_digest(selection)
    profile = dict(schema=net.SCHEMA, transport=net.TRANSPORT, upstream=net.UPSTREAM,
                   epoch=1, not_before=NOW-1, expires_at=NOW+1000,
                   selection_manifest_sha256=selection_hash,
                   registry_job_id=selection["closedJob"]["job_id"],
                   job_binding_hash=bytes(selection["closedJob"]["job_binding_hash"]).hex(),
                   selection_round=selection["selectionRound"], trust_anchor_sha256=sha("root"),
                   parties=[dict(party=i, address="10.80.0.%d" % (11+i), peer_port=17500+i,
                                 client_port=17400+i, tls_name="P%d" % i,
                                 certificate_sha256=sha("P%d" % i)) for i in range(3)],
                   clients=[dict(client=i, tls_name="C%d" % i, certificate_sha256=sha("C%d" % i))
                            for i in range(4)],
                   program=dict(name="sealed_v2_"+selection_hash[:16], source_sha256=v2.program_hash(),
                                transport_patch_sha256=sha("patch"), build_recipe_sha256=sha("recipe"),
                                binary_sha256=sha("binary"), bytecode_sha256=sha("bytecode"),
                                schedule_sha256=sha("schedule")))
    return profile, selection


class NetworkProfileTests(unittest.TestCase):
    def setUp(self):
        self.profile, self.selection = fixture()
        self.pin = net.profile_digest(self.profile)

    def validate(self, profile=None, **kwargs):
        return net.validate_profile(self.profile if profile is None else profile, self.pin,
                                    self.selection, allow_remote=True, now=NOW, **kwargs)

    def reject_even_if_reviewed(self, change):
        value = deepcopy(self.profile)
        change(value)
        with self.assertRaises(net.NetworkProfileError):
            net.validate_profile(value, net.profile_digest(value), self.selection, allow_remote=True, now=NOW)

    def test_opt_in_is_required_and_never_truthy_coerced(self):
        for option in (False, None, 1, "true", [], {}):
            with self.subTest(option=option), self.assertRaises(net.NetworkProfileError):
                net.validate_profile(self.profile, self.pin, self.selection, allow_remote=option, now=NOW)
        with self.assertRaises(net.NetworkProfileError):
            net.validate_profile(self.profile, self.pin, self.selection, now=NOW)

    def test_valid_profile_is_immutable_public_snapshot_not_execution_permission(self):
        original = deepcopy(self.profile)
        checked = self.validate()
        self.assertEqual(checked.profile_sha256, self.pin)
        self.assertEqual(checked.as_dict(), original)
        self.profile["parties"][0]["address"] = "10.90.0.1"
        copied = checked.as_dict()
        copied["parties"][1]["address"] = "10.90.0.2"
        self.assertEqual(checked.as_dict(), original)
        with self.assertRaises(FrozenInstanceError):
            checked.profile_sha256 = sha("substitute")

    def test_client_boundary_requires_immutable_profile_and_revalidates_pin_role_and_port(self):
        checked = self.validate()
        kwargs = dict(identity="C0",port=17400,allow_remote=True,now=NOW)
        self.assertEqual(net.validate_client_profile(checked,self.pin,self.selection,**kwargs),checked)
        for change in (dict(identity="C4"),dict(identity="P0"),dict(port=19400),dict(port=True),
                       dict(allow_remote=False),dict(now=NOW+1000)):
            with self.assertRaises(net.NetworkProfileError):
                net.validate_client_profile(checked,self.pin,self.selection,**dict(kwargs,**change))
        with self.assertRaises(net.NetworkProfileError):
            net.validate_client_profile(self.profile,self.pin,self.selection,**kwargs)
        forged = net.ValidatedProfile(checked.canonical_profile,sha("wrong metadata"),checked.selection_manifest_sha256)
        with self.assertRaises(net.NetworkProfileError):
            net.validate_client_profile(forged,self.pin,self.selection,**kwargs)

    def test_digest_is_canonical_and_requires_external_trust(self):
        self.assertEqual(net.profile_digest(dict(reversed(list(self.profile.items())))), self.pin)
        for pin in (None, True, self.pin.upper(), "0"*64, "a"*63, sha("unapproved")):
            with self.subTest(pin=pin), self.assertRaises(net.NetworkProfileError):
                net.validate_profile(self.profile, pin, self.selection, allow_remote=True, now=NOW)
        for change in (lambda p: p["parties"][0].update(address="10.90.0.1"),
                       lambda p: p["parties"][0].update(certificate_sha256=sha("substitute")),
                       lambda p: p["program"].update(binary_sha256=sha("other-binary")),
                       lambda p: p.update(epoch=2)):
            value = deepcopy(self.profile)
            change(value)
            with self.assertRaisesRegex(net.NetworkProfileError, "trusted digest"):
                self.validate(value)

    def test_unknown_missing_or_secret_fields_fail_at_each_level(self):
        for path in ((), ("parties", 0), ("clients", 0), ("program",)):
            for add in (False, True):
                def change(p):
                    obj = p
                    for key in path:
                        obj = obj[key]
                    if add:
                        obj["private_key"] = "MUST-NOT-ECHO"
                    else:
                        obj.pop(next(iter(obj)))
                with self.subTest(path=path, add=add):
                    self.reject_even_if_reviewed(change)

    def test_explicit_transport_version_and_upstream_only(self):
        for key, value in (("schema", "veil-mpc-network-profile-v2"), ("transport", "loopback"),
                           ("transport", "https"), ("transport", None), ("upstream", "a"*40)):
            self.reject_even_if_reviewed(lambda p: p.update({key: value}))

    def test_ipv4_only_no_dns_aliases_metadata_wildcards_or_uri(self):
        bad = ("127.0.0.1", "127.20.0.1", "0.0.0.0", "0.1.2.3", "169.254.169.254",
               "169.254.1.2", "224.0.0.1", "255.255.255.255", "240.0.0.1",
               "100.100.100.200", "168.63.129.16", "::1", "::ffff:10.80.0.11", "fd00::1",
               "10.80.0.011", "010.80.0.11", "127.1", "2130706433", "0x7f000001",
               "p0.example", "localhost", "a.local", "10.80.0.11:17500", "user@10.80.0.11",
               "https://10.80.0.11", "10.80.0.11/path", " 10.80.0.11", "10.80.0.11\n",
               None, 168427531, ["10.80.0.11"])
        for address in bad:
            with self.subTest(address=address):
                self.reject_even_if_reviewed(lambda p: p["parties"][0].update(address=address))

    def test_reviewed_vpn_and_global_literal_addresses_can_be_declared_without_dialing(self):
        for address in ("10.20.30.40", "192.168.45.67", "100.90.1.2", "8.8.8.8"):
            value = deepcopy(self.profile)
            value["parties"][0]["address"] = address
            checked = net.validate_profile(value, net.profile_digest(value), self.selection, allow_remote=True, now=NOW)
            self.assertEqual(checked.as_dict()["parties"][0]["address"], address)

    def test_exactly_three_ordered_parties_and_four_ordered_clients(self):
        for key in ("parties", "clients"):
            for change in (lambda p: p[key].pop(), lambda p: p[key].reverse(),
                           lambda p: p[key].append(deepcopy(p[key][0])), lambda p: p.update({key: None})):
                self.reject_even_if_reviewed(change)
        self.reject_even_if_reviewed(lambda p: p["parties"][0].update(party=True))
        self.reject_even_if_reviewed(lambda p: p["clients"][0].update(client=False))

    def test_duplicate_hosts_and_leaf_or_ca_pins_fail(self):
        self.reject_even_if_reviewed(lambda p: p["parties"][1].update(address=p["parties"][0]["address"]))
        self.reject_even_if_reviewed(lambda p: p["parties"][1].update(certificate_sha256=p["parties"][0]["certificate_sha256"]))
        self.reject_even_if_reviewed(lambda p: p["clients"][0].update(certificate_sha256=p["trust_anchor_sha256"]))
        self.reject_even_if_reviewed(lambda p: p["clients"][1].update(certificate_sha256=p["parties"][0]["certificate_sha256"]))
        self.reject_even_if_reviewed(lambda p: p["clients"][1].update(certificate_sha256=p["clients"][0]["certificate_sha256"]))

    def test_fixed_ports_no_arbitrary_override_or_bool_string_coercion(self):
        for field in ("peer_port", "client_port"):
            for port in (False, True, 0, 22, 443, 65536, "17500", 17500.0, None, 17501):
                self.reject_even_if_reviewed(lambda p: p["parties"][0].update({field: port}))
        self.reject_even_if_reviewed(lambda p: p.update(peer_port_base=22000))

    def test_tls_names_stay_roles_not_ip_hostnames_or_other_slots(self):
        for key, name in (("parties", "P1"), ("parties", "10.80.0.11"), ("parties", "p0.example"),
                          ("clients", "C1"), ("clients", "P0")):
            self.reject_even_if_reviewed(lambda p: p[key][0].update(tls_name=name))

    def test_all_hashes_are_nonzero_lowercase_hex(self):
        for bad in ("0"*64, "A"*64, "g"*64, "a"*63, None, 3, True):
            self.reject_even_if_reviewed(lambda p: p.update(trust_anchor_sha256=bad))
            self.reject_even_if_reviewed(lambda p: p["parties"][0].update(certificate_sha256=bad))
            self.reject_even_if_reviewed(lambda p: p["clients"][0].update(certificate_sha256=bad))
            self.reject_even_if_reviewed(lambda p: p["program"].update(binary_sha256=bad))

    def test_inactive_expired_and_excess_lifetime_epoch_types_fail(self):
        for key, value in (("not_before", NOW+1), ("expires_at", NOW), ("expires_at", NOW+86400),
                           ("epoch", 0), ("epoch", True), ("epoch", "1"), ("not_before", 1.0)):
            self.reject_even_if_reviewed(lambda p: p.update({key: value}))
        for clock in (True, 0, 1.0, "1800000000", NOW-2, NOW+1000):
            with self.subTest(clock=clock), self.assertRaises(net.NetworkProfileError):
                net.validate_profile(self.profile, self.pin, self.selection, allow_remote=True, now=clock)

    def test_profile_must_fit_result_deadline_and_not_precede_closed_job(self):
        self.reject_even_if_reviewed(lambda p: p.update(expires_at=NOW+4001))
        future = deepcopy(self.selection)
        future["closedJob"]["closed_at_ns"] = str((NOW+1)*10**9)
        v2.validate_manifest(future)
        profile = deepcopy(self.profile)
        pin = v2.manifest_digest(future)
        profile["selection_manifest_sha256"] = pin
        profile["program"]["name"] = "sealed_v2_"+pin[:16]
        with self.assertRaisesRegex(net.NetworkProfileError, "execution window"):
            net.validate_profile(profile, net.profile_digest(profile), future, allow_remote=True, now=NOW)

    def test_foreign_job_round_id_or_plain_json_selection_hash_fails(self):
        for key, value in (("registry_job_id", "2"), ("registry_job_id", 1), ("job_binding_hash", sha("other job")),
                           ("selection_round", sha("other round")), ("selection_manifest_sha256", net.profile_digest(self.selection))):
            self.reject_even_if_reviewed(lambda p: p.update({key: value}))
        foreign = deepcopy(self.selection)
        foreign["closedJob"]["closed_at_ns"] = str((NOW-5)*10**9)
        v2.validate_manifest(foreign)
        with self.assertRaises(net.NetworkProfileError):
            net.validate_profile(self.profile, self.pin, foreign, allow_remote=True, now=NOW)

    def test_authoritative_codec_rejects_missing_commitment_or_early_attempt(self):
        for change in (lambda s: s["closedJob"]["bids"][1].update(commitment=None),
                       lambda s: s["closedJob"].update(attempt="1"),
                       lambda s: s.update(kind="execution-attempt")):
            selection = deepcopy(self.selection)
            change(selection)
            with self.assertRaises(net.NetworkProfileError):
                net.validate_profile(self.profile, self.pin, selection, allow_remote=True, now=NOW)

    def test_no_v1_fallback_or_codec_bypass(self):
        for selection in (None, {}, {"descriptor": {}, "commitments": []}):
            with self.assertRaises(net.NetworkProfileError):
                net.validate_profile(self.profile, self.pin, selection, allow_remote=True, now=NOW)
        with patch.object(v2, "validate_manifest", side_effect=ValueError("MUST-NOT-ECHO")):
            with self.assertRaisesRegex(net.NetworkProfileError, "invalid v2"):
                self.validate()

    def test_program_must_be_selection_prefixed_safe_basename_and_pinned_source(self):
        for name in ("-u", "../program", "/tmp/prog", "prog; curl evil", "$(command)",
                     "sealed_v2_"+sha("wrong")[:16], "sealed_v2_"+self.pin[:16]+"/path"):
            self.reject_even_if_reviewed(lambda p: p["program"].update(name=name))
        self.reject_even_if_reviewed(lambda p: p["program"].update(source_sha256=sha("wrong-source")))
        self.reject_even_if_reviewed(lambda p: p["program"].update(extra_flags=["-u"]))

    def test_renderer_has_exact_address_file_safe_argv_and_truthful_gate(self):
        for party in range(3):
            rendered = net.render_profile(self.profile, self.pin, self.selection, party=party, allow_remote=True, now=NOW)
            self.assertEqual(rendered["peers_text"], "10.80.0.11:17500\n10.80.0.12:17501\n10.80.0.13:17502\n")
            self.assertEqual(rendered["bind_address"], "10.80.0.%d" % (party+11))
            self.assertEqual(rendered["bind_ports"], [17500+party, 17400+party])
            self.assertEqual(rendered["tls_identity"], "P%d" % party)
            argv = rendered["pending_native_argv"]
            self.assertEqual(argv[argv.index("-p")+1], str(party))
            self.assertEqual(argv[argv.index("-ip")+1], net.PEERS_PATH)
            self.assertIn("--allow-remote-network", argv)
            self.assertEqual(len(rendered["pending_client_argv"]), 4)
            self.assertNotIn("-u", argv)
            self.assertNotIn("-F", argv)
            self.assertTrue(rendered["execution_blocked"])
            for key in ("launch_supported", "deployment_allowed", "commands_executable_now", "artifacts_verified",
                        "network_checked", "tls_material_verified", "registry_finality_verified", "independent_operators_verified"):
                self.assertIs(rendered[key], False)
            self.assertEqual([e["tls_name"] for e in rendered["client_endpoints"]], ["P0", "P1", "P2"])
            self.assertTrue(rendered["client_transport_implemented"])
            self.assertFalse(rendered["native_transport_implemented"])
            self.assertFalse(rendered["client_independent_host_verified"])
            self.assertEqual(rendered["client_argv"],rendered["pending_client_argv"])
        for party in (True, -1, 3, "0"):
            with self.assertRaises(net.NetworkProfileError):
                net.render_profile(self.profile, self.pin, self.selection, party=party, allow_remote=True, now=NOW)

    def test_json_size_duplicate_nonfinite_depth_and_bad_container_rejected(self):
        for raw in (b'{"x":1,"x":2}', b'{"x":NaN}', b'{"x":1e999}', b'{"x":1.0}', b'\xff',
                    b'\xef\xbb\xbf{}', b'{}trailing', b'', b' '*65537, b'['*18+b']'*18):
            with self.assertRaises(net.NetworkProfileError):
                net.parse_profile(raw)
        for value in (None, [], True, "profile"):
            with self.assertRaises(net.NetworkProfileError):
                self.validate(value if value is not None else {})
        with tempfile.TemporaryDirectory() as temp:
            path = Path(temp)/"huge"
            path.write_bytes(b' '*65537)
            with self.assertRaises(net.NetworkProfileError):
                net.load_profile(path)

    def test_validator_renderer_perform_no_dns_socket_process_or_file_io(self):
        with patch.object(socket, "socket", side_effect=AssertionError("socket forbidden")), \
                patch.object(socket, "getaddrinfo", side_effect=AssertionError("DNS forbidden")), \
                patch.object(subprocess, "Popen", side_effect=AssertionError("process forbidden")), \
                patch("builtins.open", side_effect=AssertionError("file I/O forbidden")), \
                patch.object(Path, "open", side_effect=AssertionError("path I/O forbidden")):
            self.assertEqual(self.validate().profile_sha256, self.pin)
            self.assertTrue(net.render_profile(self.profile, self.pin, self.selection, party=0,
                                               allow_remote=True, now=NOW)["execution_blocked"])

    def test_cli_requires_opt_in_and_valid_rendering_still_exits_three(self):
        with tempfile.TemporaryDirectory() as temp:
            path, selection = Path(temp)/"profile.json", Path(temp)/"selection.json"
            path.write_bytes(net.canonical(self.profile))
            selection.write_bytes(net.canonical(self.selection))
            args = ["--profile", str(path), "--expected-sha256", self.pin,
                    "--selection-manifest", str(selection), "--party", "0"]
            for options, code in (([], 2), (["--allow-remote-network"], 3)):
                out = io.StringIO()
                with redirect_stdout(out), patch.object(net.time, "time", return_value=NOW):
                    self.assertEqual(net.main(args+options), code)
                result = json.loads(out.getvalue())
                self.assertTrue(result["execution_blocked"])
                self.assertFalse(result["deployment_allowed"])
                if code == 2:
                    self.assertNotIn(str(path), out.getvalue())
                    self.assertNotIn(self.pin, out.getvalue())


if __name__ == "__main__":
    unittest.main()
