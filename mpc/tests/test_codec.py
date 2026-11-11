import io
import socket
import struct
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))
from mpc.auction import (DOMAIN, MAX_AMOUNT, PROFILE, UPSTREAM, canonical,
                     commitment, digest, reference, validate_descriptor, validate_manifest)
from mpc.sealed_client import active_triples, read_exact, receive


def descriptor():
    return {"profile": PROFILE, "upstream": UPSTREAM, "job": "11" * 32,
            "attempt": "22" * 32, "qualified": [True, True, True], "fixedFee": 8}


class CodecTests(unittest.TestCase):
    def test_commitment_codec_independent_hashlib(self):
        import hashlib
        d = descriptor()
        salt = bytes(range(32))
        expected = hashlib.sha256(DOMAIN + hashlib.sha256(canonical(d)).digest() +
                                  b"\x02" + (80).to_bytes(8, "big") + salt).hexdigest()
        self.assertEqual(commitment(d, 2, 80, salt), expected)

    def test_context_and_private_value_are_bound(self):
        d, salt = descriptor(), bytes(range(32))
        old = commitment(d, 1, 80, salt)
        mutations = [(dict(d, job="33" * 32), 1, 80, salt),
                     (dict(d, attempt="33" * 32), 1, 80, salt),
                     (dict(d, qualified=[False, True, True]), 1, 80, salt),
                     (dict(d, fixedFee=9), 1, 80, salt),
                     (d, 2, 80, salt), (d, 1, 81, salt),
                     (d, 1, 80, b"x" * 32)]
        for args in mutations:
            with self.subTest(args=args[:3]):
                self.assertNotEqual(old, commitment(*args))

    def test_amount_codec_rejects_coercion_overflow_negative(self):
        for bad in (-1, 0, MAX_AMOUNT + 1, (1 << 64) + 80, True, 80.0, "80"):
            with self.subTest(bad=bad), self.assertRaises(ValueError):
                commitment(descriptor(), 1, bad, b"x" * 32)
        self.assertEqual(len(commitment(descriptor(), 0, 0, b"x" * 32)), 64)

    def test_descriptor_is_strict(self):
        for d in (dict(descriptor(), job="arbitrary registry id"),
                  dict(descriptor(), attempt="AB" * 32),
                  dict(descriptor(), qualified=[1, 1, 1]),
                  dict(descriptor(), extra="ignored?")):
            with self.assertRaises(ValueError):
                validate_descriptor(d)
        m = {"descriptor": descriptor(), "commitments": ["aa" * 32] * 4}
        self.assertIs(validate_manifest(m), m)
        m["commitments"][0] = " aa" * 32
        with self.assertRaises(ValueError):
            validate_manifest(m)

    def test_reference_edges(self):
        self.assertEqual(reference(100, [90, 80, 95])["buyer"], [1, 2, 80, 80])
        self.assertEqual(reference(100, [80, 80, 80])["buyer"], [1, 1, 80, 80])
        self.assertEqual(reference(88, [90, 80, 95], fixed_fee=8)["buyer"], [1, 2, 80, 88])
        self.assertEqual(reference(87, [90, 80, 95], fixed_fee=8)["buyer"], [0, 0, 0, 0])
        self.assertEqual(reference(100, [1, 80, 95], [False, True, True])["buyer"], [1, 2, 80, 80])
        self.assertEqual(reference(MAX_AMOUNT, [MAX_AMOUNT] * 3)["buyer"], [1, 1, MAX_AMOUNT, MAX_AMOUNT])
        self.assertEqual(reference(0, [1, 2, 3])["providers"], [[0, 0]] * 3)


class FragmentedSocket:
    def __init__(self, data):
        self.data = io.BytesIO(data)

    def recv(self, n):
        return self.data.read(min(n, 2))


def packet(data):
    return struct.pack("<I", len(data)) + data


class WireTests(unittest.TestCase):
    def test_fragmented_length_and_payload(self):
        self.assertEqual(receive(FragmentedSocket(packet(b"abc")), 3), b"abc")

    def test_truncation_fails_instead_of_hanging(self):
        with self.assertRaises(EOFError):
            receive(FragmentedSocket(struct.pack("<I", 8) + b"x"), 8)

    def test_large_or_passive_frame_rejected(self):
        with self.assertRaises(ValueError):
            receive(FragmentedSocket(struct.pack("<I", 65537)))
        with self.assertRaises(ValueError):
            active_triples([FragmentedSocket(packet(b"\0" * 16))], 1)

    def test_active_output_authentication_rejects_corrupt_share(self):
        def triple(a, b, c):
            return b"".join(x.to_bytes(16, "little") for x in (a, b, c))
        good = [FragmentedSocket(packet(triple(2, 3, 6))),
                FragmentedSocket(packet(triple(0, 0, 0))),
                FragmentedSocket(packet(triple(0, 0, 0)))]
        self.assertEqual(active_triples(good, 1), [[2, 3, 6]])
        bad = [FragmentedSocket(packet(triple(2, 3, 7))),
               FragmentedSocket(packet(triple(0, 0, 0))),
               FragmentedSocket(packet(triple(0, 0, 0)))]
        with self.assertRaises(ValueError):
            active_triples(bad, 1)


if __name__ == "__main__":
    unittest.main()
