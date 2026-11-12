"""Operator admission identities and receipts. Never an MPC execution proof.

Python standard library + an explicitly selected OpenSSL 3+ executable. Signing
keys are provisioned by the operator; this module never creates production keys.
"""

import hashlib
from contextlib import contextmanager
import os
from pathlib import Path
import re
import sqlite3
import stat
import subprocess
import tempfile
from urllib.parse import quote

from .validate_manifest import (
    ManifestError, _hash, _int, _object, _require, canonical, digest,
    parse_manifest, validate_manifest,
)

DOMAIN = b"VEIL-OPERATOR-ADMISSION-v1\x00"
SPKI = bytes.fromhex("302a300506032b6570032100")  # RFC 8410 Ed25519 SPKI
TTL = 300
ARTIFACTS = ("source_sha256", "transport_patch_sha256", "build_recipe_sha256",
             "binary_sha256", "bytecode_sha256", "schedule_sha256")


def private_file(path):
    """Require a regular owner-only file; parent directories are operator trust."""
    info = Path(path).lstat()
    _require(stat.S_ISREG(info.st_mode) and info.st_uid == os.geteuid()
             and info.st_mode & 0o077 == 0, "private file: unsafe ownership or mode")


class Crypto:
    def __init__(self, executable):
        _require(Path(executable).is_absolute(), "openssl: absolute executable required")
        self.executable = str(executable)
        version = self.run("version").decode("ascii")
        match = re.match(r"OpenSSL (\d+)\.", version)
        _require(match is not None and int(match[1]) >= 3, "openssl: version 3+ required")

    def run(self, *args, data=None):
        try:
            return subprocess.run(
                [self.executable, *map(str, args)], input=data, stdout=subprocess.PIPE,
                stderr=subprocess.DEVNULL, check=True, timeout=15,
                env={"PATH": "/usr/bin:/bin", "OPENSSL_CONF": "/dev/null"},
            ).stdout
        except (OSError, subprocess.SubprocessError):
            raise ManifestError("openssl: operation rejected") from None

    def public(self, key):
        private_file(key)
        der = self.run("pkey", "-in", key, "-pubout", "-outform", "DER")
        _require(len(der) == len(SPKI) + 32 and der.startswith(SPKI),
                 "identity: Ed25519 signing key required")
        return der[len(SPKI):].hex()

    def sign(self, key, payload):
        private_file(key)
        # Ed25519 is one-shot; use a bounded regular message file, not a pipe.
        # Only public metadata is written to this temporary directory.
        with tempfile.TemporaryDirectory(prefix="veil-receipt-") as temp:
            message = Path(temp) / "message"
            message.write_bytes(DOMAIN + canonical(payload))
            signature = self.run("pkeyutl", "-sign", "-rawin", "-inkey", key,
                                 "-in", message)
        _require(len(signature) == 64, "identity: invalid signature size")
        return signature.hex()

    def verify(self, public, payload, signature):
        _hash(public, "receipt public key")
        _require(type(signature) is str and re.fullmatch(r"[0-9a-f]{128}", signature)
                 is not None, "receipt: invalid signature encoding")
        with tempfile.TemporaryDirectory(prefix="veil-verify-") as temp:
            root = Path(temp)
            (root / "public.der").write_bytes(SPKI + bytes.fromhex(public))
            (root / "message").write_bytes(DOMAIN + canonical(payload))
            (root / "signature").write_bytes(bytes.fromhex(signature))
            self.run("pkeyutl", "-verify", "-rawin", "-pubin", "-keyform", "DER",
                     "-inkey", root / "public.der", "-in", root / "message",
                     "-sigfile", root / "signature")


def validate_roster(roster, roster_pin, plan, plan_pin, now):
    validate_manifest(plan, plan_pin)
    _require(plan["execution_mode"] == "v2-selection", "node: v2 selection only")
    _hash(roster_pin, "roster pin")
    _object(roster, ("schema", "plan_sha256", "epoch", "not_before", "expires_at",
                     "members", "client_certificate_sha256"), "roster")
    _require(roster["schema"] == "veil-operator-roster-v1", "roster: unsupported schema")
    _require(roster["plan_sha256"] == plan_pin and digest(roster) == roster_pin,
             "roster: trusted binding mismatch")
    for key in ("epoch", "not_before", "expires_at"):
        _int(roster[key], 1, 2**63 - 1, "roster." + key)
    _int(now, 1, 2**63 - 1, "clock")
    _require(roster["not_before"] <= now < roster["expires_at"],
             "roster: inactive or expired")
    _require(roster["expires_at"] - roster["not_before"] <= 7 * 86400,
             "roster: validity exceeds seven days")
    _require(type(roster["members"]) is list and len(roster["members"]) == 3,
             "roster: three members required")
    seen = set()
    for i, member in enumerate(roster["members"]):
        _object(member, ("party", "identity", "receipt_public_key"), "roster member")
        _int(member["party"], 0, 2, "roster party")
        _require(member["party"] == i and member["identity"] == plan["operators"][i]["identity"],
                 "roster: party identity mismatch")
        public = member["receipt_public_key"]
        _hash(public, "roster public key")
        _require(public not in seen, "roster: duplicate signing key")
        seen.add(public)
    clients = roster["client_certificate_sha256"]
    _require(type(clients) is list and len(clients) == 4, "roster: four client pins required")
    certs = {plan["trust_anchor_sha256"]} | {
        op["certificate_sha256"] for op in plan["operators"]}
    for pin in clients:
        _hash(pin, "client certificate pin")
        _require(pin not in certs, "roster: duplicate certificate pin")
        certs.add(pin)


def context(plan, plan_pin, roster, roster_pin):
    execution = plan["execution"]
    return dict(plan_sha256=plan_pin, roster_sha256=roster_pin, epoch=roster["epoch"],
                execution_sha256=plan["execution_sha256"],
                job_binding_hash=bytes(execution["closedJob"]["job_binding_hash"]).hex(),
                selection_round=execution["selectionRound"])


def admission(plan, plan_pin, roster, roster_pin, party, now):
    validate_roster(roster, roster_pin, plan, plan_pin, now)
    _int(party, 0, 2, "party")
    return dict(context(plan, plan_pin, roster, roster_pin),
                schema="veil-operator-receipt-v1", kind="plan-admitted",
                party=party, signer=roster["members"][party]["identity"],
                issued_at=now, expires_at=min(now + TTL, roster["expires_at"]))


def verify_receipt(receipt, plan, plan_pin, roster, roster_pin, now, crypto):
    validate_roster(roster, roster_pin, plan, plan_pin, now)
    _object(receipt, ("payload", "signature"), "receipt")
    payload = receipt["payload"]
    _object(payload, tuple(context(plan, plan_pin, roster, roster_pin)) + (
        "schema", "kind", "party", "signer", "issued_at", "expires_at"), "receipt payload")
    _int(payload["party"], 0, 2, "receipt party")
    _int(payload["epoch"], 1, 2**63 - 1, "receipt epoch")
    _int(payload["issued_at"], 1, 2**63 - 1, "receipt issued_at")
    _int(payload["expires_at"], 1, 2**63 - 1, "receipt expires_at")
    expected = admission(plan, plan_pin, roster, roster_pin, payload["party"], payload["issued_at"])
    _require(payload == expected, "receipt: foreign context, identity or claims")
    _require(payload["issued_at"] <= now < payload["expires_at"], "receipt: inactive or expired")
    crypto.verify(roster["members"][payload["party"]]["receipt_public_key"],
                  payload, receipt["signature"])
    return payload


def verify_quorum(receipts, plan, plan_pin, roster, roster_pin, now, crypto):
    _require(type(receipts) is list and len(receipts) == 3, "quorum: exactly three receipts required")
    parties = [verify_receipt(r, plan, plan_pin, roster, roster_pin, now, crypto)["party"]
               for r in receipts]
    _require(sorted(parties) == [0, 1, 2], "quorum: three distinct parties required")
    return context(plan, plan_pin, roster, roster_pin)


class Journal:
    """Crash-conservative single-use admission and consuming-verifier journal.

    A committed reservation is burned even if signing crashes. Export a completed
    receipt to recover delivery; never silently sign again. No rollback resistance
    against an administrator restoring/deleting this database is claimed.
    """
    def __init__(self, directory, *, initialize=False):
        directory = Path(directory)
        info = directory.lstat()
        _require(stat.S_ISDIR(info.st_mode) and info.st_uid == os.geteuid()
                 and info.st_mode & 0o077 == 0, "journal: owner-only directory required")
        self.path = directory / "operator.sqlite"
        if initialize:
            fd = os.open(self.path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
            os.close(fd)
        private_file(self.path)  # Missing state is an error, never a fresh replay window.
        with self.connect() as db:
            if initialize:
                db.executescript("""
                    CREATE TABLE meta (id INTEGER PRIMARY KEY CHECK(id=1),
                        epoch INTEGER NOT NULL, roster TEXT NOT NULL, clock INTEGER NOT NULL);
                    INSERT INTO meta VALUES (1, 0, '', 0);
                    CREATE TABLE issued (job TEXT, round TEXT, party INTEGER,
                        payload BLOB NOT NULL, receipt BLOB,
                        PRIMARY KEY(job, round, party));
                    CREATE TABLE consumed (job TEXT, round TEXT, context BLOB NOT NULL,
                        PRIMARY KEY(job, round));
                    PRAGMA user_version=1;
                """)
            _require(db.execute("PRAGMA user_version").fetchone()[0] == 1,
                     "journal: unsupported schema")

    @contextmanager
    def connect(self):
        private_file(self.path)
        db = sqlite3.connect("file:" + quote(str(self.path.absolute())) + "?mode=rw", uri=True,
                             timeout=5, isolation_level=None)
        try:
            db.execute("PRAGMA synchronous=FULL")
            db.execute("PRAGMA busy_timeout=5000")
            with db:
                yield db
        finally:
            db.close()

    @staticmethod
    def _advance(db, epoch, roster, now):
        row = db.execute("SELECT epoch, roster, clock FROM meta WHERE id=1").fetchone()
        _require(row is not None, "journal: missing replay metadata")
        old_epoch, old_roster, clock = row
        _require(now >= clock, "journal: clock rollback")
        _require(epoch > old_epoch or (epoch == old_epoch and roster == old_roster),
                 "journal: roster rollback or same-epoch substitution")
        db.execute("UPDATE meta SET epoch=?, roster=?, clock=? WHERE id=1", (epoch, roster, now))

    def check(self, epoch, roster, now):
        with self.connect() as db:
            _require(db.execute("PRAGMA quick_check").fetchone()[0] == "ok", "journal: integrity failure")
            db.execute("BEGIN IMMEDIATE")
            self._advance(db, epoch, roster, now)
            db.commit()

    def issue(self, payload, signer):
        key = (payload["job_binding_hash"], payload["selection_round"], payload["party"])
        with self.connect() as db:
            db.execute("BEGIN IMMEDIATE")
            self._advance(db, payload["epoch"], payload["roster_sha256"], payload["issued_at"])
            try:
                db.execute("INSERT INTO issued VALUES (?, ?, ?, ?, NULL)", (*key, canonical(payload)))
            except sqlite3.IntegrityError:
                raise ManifestError("journal: admission replay rejected") from None
            db.commit()  # Reserve BEFORE handing metadata to the signing key.
        receipt = {"payload": payload, "signature": signer(payload)}
        with self.connect() as db:
            db.execute("BEGIN IMMEDIATE")
            db.execute("UPDATE issued SET receipt=? WHERE job=? AND round=? AND party=?",
                       (canonical(receipt), *key))
            db.commit()
        return receipt

    def export(self, binding, round_id, party):
        with self.connect() as db:
            row = db.execute("SELECT receipt FROM issued WHERE job=? AND round=? AND party=?",
                             (binding, round_id, party)).fetchone()
        _require(row is not None and row[0] is not None, "journal: no completed receipt")
        return parse_manifest(row[0])

    def consume(self, binding, now):
        with self.connect() as db:
            db.execute("BEGIN IMMEDIATE")
            self._advance(db, binding["epoch"], binding["roster_sha256"], now)
            try:
                db.execute("INSERT INTO consumed VALUES (?, ?, ?)", (
                    binding["job_binding_hash"], binding["selection_round"], canonical(binding)))
            except sqlite3.IntegrityError:
                raise ManifestError("journal: quorum replay rejected") from None
            db.commit()


def file_digest(path):
    info = Path(path).lstat()
    _require(stat.S_ISREG(info.st_mode), "artifact: regular file required")
    hasher = hashlib.sha256()
    with Path(path).open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            hasher.update(chunk)
    return hasher.hexdigest()
