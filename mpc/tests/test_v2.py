"""Adversarial public-codec tests. These do NOT substitute for real MPC tests."""
import copy
import dataclasses
import hashlib
import importlib.util
import json
import sys
import unittest
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))
from mpc import auction, v2
from mpc.sample_v2 import synthetic_intent, synthetic_closed_job
from mpc.sealed_client import run as client_run
from mpc.run_v2 import run_prepared

ROOT = Path(__file__).resolve().parents[2]


def fixture():
    intent = synthetic_intent(intent_nonce="06" * 32, selection_round="07" * 32)
    prepared = v2.prepare_synthetic(intent)
    job = synthetic_closed_job(prepared)
    return prepared, job, v2.build_selection_manifest(prepared, job)


class V2CodecTests(unittest.TestCase):
    def test_independent_binary_intent_vector(self):
        i = synthetic_intent(intent_nonce="06" * 32, selection_round="07" * 32)
        i["mpcProgramHash"] = "08" * 32  # vector independent of source updates
        def string(s):
            b = s.encode("ascii")
            return len(b).to_bytes(4, "big") + b
        wire = b"VEIL-INTENT-v2\0\2" + string("sealed-cheapest-3-spdz2k-v2") + bytes.fromhex("42" * 32)
        wire += string("registry.test.near") + string("buyer.near") + b"\3"
        wire += string("alpha.near") + string("beta.near") + string("gamma.near") + b"\1\1\1"
        wire += (0).to_bytes(8, "big") + (100).to_bytes(8, "big") + (200).to_bytes(8, "big")
        wire += bytes([1])*32 + bytes([2])*32 + bytes([3])*32 + bytes([5])*32 + bytes([4])*32
        wire += string("executor.near") + bytes([6])*32 + bytes([7])*32 + bytes([8])*32
        wire += string("cd4d517a8a37b266d7233ae412717ca181cec6bf")
        self.assertEqual(v2.encode_intent(i), wire)
        self.assertEqual(v2.precommit_context(i), hashlib.sha256(wire).hexdigest())
        # Fixed known-answer vector catches simultaneous encoder/helper drift.
        self.assertEqual(hashlib.sha256(wire).hexdigest(), "78512ffe685fbb807821e351c01cb6c88dedc0fe25443b157ad2fcf7034ab9c6")

    def test_independent_commitment_and_v1_separation(self):
        context, salt = "11"*32, bytes(range(32))
        wire = b"VEIL-MPC-v2\0" + bytes.fromhex(context) + b"\2" + (80).to_bytes(8, "big") + salt
        self.assertEqual(v2.commitment(context, 2, 80, salt), hashlib.sha256(wire).hexdigest())
        self.assertNotEqual(hashlib.sha256(wire).hexdigest(), hashlib.sha256(b"VEIL-MPC-v1\0" + wire[len(b"VEIL-MPC-v2\0"):]).hexdigest())
        p, j, m = fixture()
        with self.assertRaises(ValueError):
            auction.validate_manifest(m)
        with self.assertRaises(ValueError):
            v2.validate_manifest({"descriptor": {}, "commitments": list(p.commitments)})

    def test_every_intent_field_binds_precommit(self):
        i = synthetic_intent(intent_nonce="06"*32, selection_round="07"*32)
        original = v2.precommit_context(i)
        for key in v2.HASH_FIELDS + ("networkDomainHash", "intentNonce", "selectionRound", "mpcProgramHash"):
            changed = dict(i, **{key: "09"*32})
            self.assertNotEqual(original, v2.precommit_context(changed), key)
        mutations = {"registryAccount": "registry2.near", "buyer": "buyer2.near", "registryExecutor": "other.near",
                     "roster": ["alpha.near", "beta.near", "zeta.near"], "qualified": [True, False, True],
                     "fixedFee": 1, "bidDeadlineNs": "101", "resultDeadlineNs": "201"}
        for key, value in mutations.items():
            self.assertNotEqual(original, v2.precommit_context(dict(i, **{key: value})), key)
        for key, value in (("version", 1), ("version", True), ("profile", auction.PROFILE), ("upstream", "0"*40)):
            with self.assertRaises(ValueError):
                v2.precommit_context(dict(i, **{key: value}))

    def test_commitment_strict_range_and_salt_slot_binding(self):
        c, salt = "11"*32, b"s"*32
        for amount in (-1, 0, 10**12+1, 2**64+80, True, 80.0, "80"):
            with self.subTest(amount=amount), self.assertRaises(ValueError):
                v2.commitment(c, 1, amount, salt)
        self.assertEqual(len(v2.commitment(c, 0, 0, salt)), 64)
        first = v2.commitment(c, 1, 80, salt)
        for args in ((c, 2, 80, salt), (c, 1, 81, salt), (c, 1, 80, b"t"*32), ("22"*32, 1, 80, salt)):
            self.assertNotEqual(first, v2.commitment(*args))
        for args in ((c, True, 80, salt), (c.upper().replace("1", "A"), 1, 80, salt), (c, 1, 80, bytearray(salt)), (c, 1, 80, b"a")):
            with self.assertRaises(ValueError):
                v2.commitment(*args)

    def test_strict_intent_rejects_unknowns_types_order_and_deadlines(self):
        i = synthetic_intent()
        bads = [dict(i, extra=1), dict(i, job="11"*32), dict(i, attempt="22"*32),
                dict(i, roster=list(reversed(i["roster"]))), dict(i, qualified=[1, True, True]),
                dict(i, roster=["alpha.near"]*3), dict(i, fixedFee=True), dict(i, intentNonce="00"*32),
                dict(i, registryAccount="INVALID.near"), dict(i, bidDeadlineNs=100),
                dict(i, bidDeadlineNs="0100"), dict(i, resultDeadlineNs="18446744073709551616"),
                dict(i, resultDeadlineNs="100"), dict(i, bidDeadlineNs="+100")]
        for bad in bads:
            with self.subTest(keys=bad.keys()), self.assertRaises(ValueError):
                v2.validate_intent(bad)

    def test_prepare_is_immutable_and_does_not_embed_circular_bindings(self):
        p, j, m = fixture()
        original = p.context_hash
        x = p.intent
        x["fixedFee"] = 10
        self.assertEqual(p.context_hash, original)
        with self.assertRaises(dataclasses.FrozenInstanceError):
            p.commitments = ()
        self.assertNotIn("amounts", repr(p))
        self.assertNotIn("salts", repr(p))
        self.assertNotIn("job_binding_hash", p.intent)
        self.assertNotIn("commitments", p.intent)
        # Real job ID is determined only AFTER preparation; either ID binds the
        # same precommit but a different, re-encoded Closed selection manifest.
        other = synthetic_closed_job(p, job_id="2")
        m2 = v2.build_selection_manifest(p, other)
        self.assertEqual(m["precommitContext"], m2["precommitContext"])
        self.assertNotEqual(v2.manifest_digest(m), v2.manifest_digest(m2))
        j["config"]["context_hash"][0] ^= 1
        self.assertEqual(v2.validate_manifest(m), m)  # snapshot was copied

    def test_independent_registry_borsh_encoder(self):
        p, j, _ = fixture()
        spec = importlib.util.spec_from_file_location("registry_reference", ROOT / "contracts/registry/scripts/hash_schema.py")
        reference = importlib.util.module_from_spec(spec)
        old = sys.dont_write_bytecode
        try:
            sys.dont_write_bytecode = True
            spec.loader.exec_module(reference)
        finally:
            sys.dont_write_bytecode = old
        self.assertEqual(j["job_binding_hash"], reference.job_hash(p.intent["registryAccount"], list(bytes.fromhex(p.intent["networkDomainHash"])), j))
        self.assertEqual(j["bidset_root"], reference.bidset_root(j))

    def test_registry_config_mutations_fail_even_rehashed(self):
        p, j, _ = fixture()
        for key in v2.CONFIG_HASHES + ("bid_deadline_ns", "result_deadline_ns", "authorized_bidders", "executor"):
            bad = copy.deepcopy(j)
            if key in v2.CONFIG_HASHES:
                bad["config"][key][0] ^= 1
            elif key in ("bid_deadline_ns", "result_deadline_ns"):
                bad["config"][key] = str(int(bad["config"][key])+1)
            elif key == "executor":
                bad["config"][key] = "another.near"
            else:
                bad["config"][key] = ["alpha.near", "beta.near", "zeta.near"]
            bad["job_binding_hash"] = list(bytes.fromhex(v2.registry_job_hash(p.intent, bad)))
            bad["bidset_root"] = list(bytes.fromhex(v2.registry_bidset_root(bad)))
            with self.subTest(key=key), self.assertRaises(ValueError):
                v2.build_selection_manifest(p, bad)

    def test_registry_missing_reordered_extra_fake_root_and_early_attempt_fail(self):
        p, j, _ = fixture()
        mutations = []
        for key, value in (("state", "Open"), ("state", "Executing"), ("attempt", "1"),
                           ("attempt_binding_hash", [1]*32), ("job_binding_hash", [9]*32),
                           ("bidset_root", [9]*32), ("closed_at_ns", "99"), ("closed_at_ns", "200"),
                           ("selected_executor", "beta.near"), ("attempt_binding_version", 2),
                           ("bids", j["bids"][:2]), ("bids", list(reversed(j["bids"]))),
                           ("bids", j["bids"] + j["bids"][:1])):
            mutations.append(dict(j, **{key: value}))
        bad = copy.deepcopy(j); bad["bids"][1]["commitment"] = None; mutations.append(bad)
        bad = copy.deepcopy(j); bad["bids"][1]["commitment"][0] ^= 1; mutations.append(bad)
        bad = copy.deepcopy(j); bad["config"]["budget_commitment"][0] = True; mutations.append(bad)
        bad = copy.deepcopy(j); del bad["selected_executor"]; mutations.append(bad)
        mutations.append(dict(j, unknown="silently ignored?"))
        for bad in mutations:
            with self.subTest(keys=bad.keys()), self.assertRaises(ValueError):
                v2.build_selection_manifest(p, bad)
        # Original v1 job-output shape and paired new nulls both supported.
        legacy = copy.deepcopy(j)
        del legacy["selected_executor"]; del legacy["attempt_binding_version"]
        v2.build_selection_manifest(p, legacy)

    def test_manifest_mutations_fail_and_public_digest_covers_full_closed_snapshot(self):
        _, _, m = fixture()
        for key, value in (("version", 1), ("version", True), ("kind", "execution-attempt"),
                           ("precommitContext", "11"*32), ("selectionRound", "22"*32),
                           ("mpcBuild", {"upstream": v2.UPSTREAM, "circuitSourceHash": "33"*32}),
                           ("commitments", m["commitments"][:3])):
            with self.subTest(key=key), self.assertRaises(ValueError):
                v2.validate_manifest(dict(m, **{key: value}))
        with self.assertRaises(ValueError):
            v2.validate_manifest(dict(m, attemptBindingHash="11"*32))
        changed = copy.deepcopy(m)
        changed["closedJob"]["closed_at_ns"] = "101"
        v2.validate_manifest(changed)
        self.assertNotEqual(v2.manifest_digest(m), v2.manifest_digest(changed))

    def test_public_json_rejects_duplicate_keys_and_nonfinite_numbers(self):
        _, _, m = fixture()
        encoded = json.dumps(m)
        self.assertEqual(v2.load_manifest(encoded), m)
        for bad in (encoded.replace('"version": 2', '"version": 1, "version": 2'),
                    encoded.replace('"fixedFee": 0', '"fixedFee": NaN'),
                    encoded.replace('"fixedFee": 0', '"fixedFee": Infinity')):
            with self.assertRaises(ValueError):
                v2.load_manifest(bad)
        for key in ("intent_nonce", "selection_round"):
            with self.assertRaises(ValueError):
                synthetic_intent(**{key: ""})

    def test_client_version_and_expected_public_digest_checked_before_network(self):
        p, j, m = fixture()
        with patch("mpc.sealed_client.connect") as connect:
            for kw in ({}, {"codec_version": 3}, {"codec_version": True},
                       {"codec_version": 2, "expected_manifest_hash": "00"*32}):
                with self.assertRaises(ValueError):
                    client_run(m, 0, 16400, Path("unused"), p.amounts[0], p.salts[0], **kw)
            connect.assert_not_called()
        with patch("mpc.run_v2.execute_fixture") as execute:
            with self.assertRaises(ValueError):
                run_prepared(p, dict(j, state="Executing"))
            execute.assert_not_called()


if __name__ == "__main__":
    unittest.main()
