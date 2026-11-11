"""Durable local outbox. Ambiguous effects are reconciled, never blindly retried."""
import hashlib
import json
import sqlite3
from dataclasses import asdict, replace
from .interface import Action, Command, Observation, State
from .model import (Conflict, PaymentError, Unsupported, TARGET, binding_hash,
                    canonical, command_dict, delivery as valid_delivery, digest,
                    guard, identifier, load_command, load_observation, observation_dict)
from .storage import Database

SCHEMA = """
CREATE TABLE IF NOT EXISTS payment_assignments (
 assignment_id TEXT PRIMARY KEY, binding_json TEXT NOT NULL,
 context_hash TEXT NOT NULL, attempt_id TEXT NOT NULL, job_id TEXT NOT NULL UNIQUE,
 bid_id TEXT NOT NULL UNIQUE, state TEXT NOT NULL, snapshot_json TEXT NOT NULL,
 pending_operation TEXT, verification_json TEXT,
 UNIQUE(context_hash, attempt_id)
);
CREATE TABLE IF NOT EXISTS payment_operations (
 operation_id TEXT PRIMARY KEY, assignment_id TEXT NOT NULL,
 request_json TEXT NOT NULL, command_json TEXT NOT NULL, status TEXT NOT NULL,
 response_json TEXT, error_code TEXT,
 FOREIGN KEY(assignment_id) REFERENCES payment_assignments(assignment_id)
);
CREATE TABLE IF NOT EXISTS payment_events (
 event_id INTEGER PRIMARY KEY AUTOINCREMENT, operation_id TEXT NOT NULL,
 kind TEXT NOT NULL, digest TEXT NOT NULL,
 at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
"""


class PaymentAdapter:
    """No transport is constructed here. This build authorizes local fixture only.

    verifier is an explicitly trusted local integration. Its success cannot force
    Market to pay and is not a cryptographic proof of correct computation.
    """
    def __init__(self, db_path, rail, verifier=None):
        self.db = Database(db_path, SCHEMA)
        self.rail = rail
        self.verifier = verifier
        self.mode = getattr(rail, "mode", "unavailable")

    def capabilities(self):
        return {"mode": self.mode, "simulation": self.mode == "local_fixture_simulation",
                "live_payments": False, "blockchain_escrow": False,
                "cryptographic_settlement_proof": False,
                "local_validator_forces_remote_payment": False}

    def _local_only(self):
        if self.mode != "local_fixture_simulation":
            raise Unsupported("live payment dispatch disabled; see payments/LIVE-GAPS.md")

    def register(self, binding):
        self._local_only()
        binding_hash(binding)
        encoded = canonical(asdict(binding))
        snapshot = Observation(binding, State.NEW, 0, None, "local:registered", self.mode)
        with self.db.transaction() as db:
            prior = db.execute("SELECT * FROM payment_assignments WHERE assignment_id=?", (binding.assignment_id,)).fetchone()
            if prior:
                self._bound(prior, binding)
                return self._state(prior)
            try:
                db.execute("INSERT INTO payment_assignments VALUES (?,?,?,?,?,?,?,?,?,?)",
                           (binding.assignment_id, encoded, binding.context_hash,
                            binding.attempt_id, binding.job_id, binding.bid_id,
                            State.NEW.value, canonical(asdict(snapshot)), None, None))
            except sqlite3.IntegrityError as exc:
                raise Conflict("context/attempt, job or bid already bound") from exc
        return snapshot

    @staticmethod
    def _bound(row, binding):
        if row is None or row["binding_json"] != canonical(asdict(binding)):
            raise Conflict("unknown or mismatched immutable payment binding")

    @staticmethod
    def _state(row):
        value = load_observation(json.loads(row["snapshot_json"]))
        if row["pending_operation"]:
            return replace(value, state=State.UNKNOWN, operation_id=row["pending_operation"], evidence_id="local:unresolved")
        return value

    def state(self, binding):
        binding_hash(binding)
        with self.db.connect() as db:
            row = db.execute("SELECT * FROM payment_assignments WHERE assignment_id=?", (binding.assignment_id,)).fetchone()
            self._bound(row, binding)
            return self._state(row)

    def refresh(self, binding):
        """Adopt newer fixture state, but never resolve an unknown write by inference."""
        self._local_only()
        binding_hash(binding)
        with self.db.transaction() as db:
            row = db.execute("SELECT * FROM payment_assignments WHERE assignment_id=?", (binding.assignment_id,)).fetchone()
            self._bound(row, binding)
            current = self._state(row)
            if row["pending_operation"]:
                return current
            latest = self._check_observation(self.rail.inspect(binding), binding)
            self._progression(current, latest)
            db.execute("UPDATE payment_assignments SET state=?,snapshot_json=? WHERE assignment_id=?",
                       (latest.state.value, canonical(asdict(latest)), binding.assignment_id))
            return latest

    @staticmethod
    def _progression(before, after):
        reachable = {
            State.NEW: set(State) - {State.UNKNOWN},
            State.AWARDED: {State.AWARDED, State.HELD, State.SUBMITTED, State.ACCEPTED, State.RELEASED, State.REFUNDED, State.DISPUTED},
            State.HELD: {State.HELD, State.SUBMITTED, State.ACCEPTED, State.RELEASED, State.REFUNDED, State.DISPUTED},
            State.SUBMITTED: {State.SUBMITTED, State.ACCEPTED, State.RELEASED, State.DISPUTED},
            State.ACCEPTED: {State.ACCEPTED, State.RELEASED},
            State.RELEASED: {State.RELEASED}, State.REFUNDED: {State.REFUNDED},
            State.DISPUTED: {State.DISPUTED},
        }
        if after.revision < before.revision or after.state not in reachable[before.state]:
            raise Conflict("stale or impossible rail state progression")
        if after.revision == before.revision and (after.state, after.delivery) != (before.state, before.delivery):
            raise Conflict("conflicting observations at same revision")
        if before.delivery and after.delivery and after.delivery.version < before.delivery.version:
            raise Conflict("delivery version regressed")
        if before.delivery and after.delivery and after.delivery.version == before.delivery.version and after.delivery != before.delivery:
            raise Conflict("artifact changed without new delivery version")

    def _check_observation(self, value, binding):
        observation_dict(value)
        if value.binding != binding or value.authority != self.mode or value.state == State.UNKNOWN:
            raise Conflict("rail observation has wrong binding, authority or unknown state")
        if value.state in (State.SUBMITTED, State.ACCEPTED, State.RELEASED, State.DISPUTED):
            valid_delivery(value.delivery)
        return value

    @staticmethod
    def _checked_verification(row, current, action, proposed):
        if action not in (Action.ACCEPT, Action.RELEASE):
            return
        if row["verification_json"] is None:
            raise Conflict("matching artifact must be verified locally first")
        verified = json.loads(row["verification_json"])
        if verified["delivery"] != asdict(proposed):
            raise Conflict("verification belongs to a different artifact/version")
        if action == Action.ACCEPT and verified["revision"] != current.revision:
            raise Conflict("verification is stale")
        if action == Action.RELEASE and verified["revision"] + 1 != current.revision:
            raise Conflict("acceptance revision does not follow verified delivery")

    def verify_artifact(self, binding, delivery, artifact, receipt):
        self._local_only()
        binding_hash(binding)
        valid_delivery(delivery)
        if self.verifier is None:
            raise Unsupported("inject a trusted artifact verifier; no default success policy")
        if type(artifact) is not bytes or type(receipt) is not bytes:
            raise PaymentError("artifact and receipt must be immutable bytes")
        if hashlib.sha256(artifact).hexdigest() != delivery.artifact_sha256 or hashlib.sha256(receipt).hexdigest() != delivery.receipt_sha256:
            raise Conflict("artifact/receipt bytes do not match bound SHA-256 digests")
        before = self.state(binding)
        if before.state != State.SUBMITTED or before.delivery != delivery:
            raise Conflict("only the current submitted delivery may be verified")
        remote = self._check_observation(self.rail.inspect(binding), binding)
        if remote.state != State.SUBMITTED or remote.delivery != delivery or remote.revision != before.revision:
            raise Conflict("delivery changed or disputed before verification")
        if self.verifier.verify(binding, delivery, artifact, receipt) is not True:
            raise Conflict("artifact policy verification failed")
        verification = {"binding_hash": binding_hash(binding), "delivery": asdict(delivery),
                        "revision": before.revision, "trust": "injected_local_verifier"}
        with self.db.transaction() as db:
            row = db.execute("SELECT * FROM payment_assignments WHERE assignment_id=?", (binding.assignment_id,)).fetchone()
            self._bound(row, binding)
            if self._state(row) != before:
                raise Conflict("local state changed during verification")
            db.execute("UPDATE payment_assignments SET verification_json=? WHERE assignment_id=?",
                       (canonical(verification), binding.assignment_id))
        return {"verified": True, "receipt_hash": digest(verification),
                "simulation": True, "remote_payment_guarantee": False}

    def perform(self, operation_id, action, binding, delivery=None):
        self._local_only()
        identifier(operation_id)
        binding_hash(binding)
        # Validate before encoding or comparing idempotency keys.
        command_dict(Command(operation_id, action, binding, delivery))
        request = {"operation_id": operation_id, "action": action,
                   "binding": asdict(binding), "delivery": asdict(delivery) if delivery is not None else None}
        request_json = canonical(request)
        with self.db.transaction() as db:
            existing = db.execute("SELECT * FROM payment_operations WHERE operation_id=?", (operation_id,)).fetchone()
            if existing:
                if existing["request_json"] != request_json:
                    raise Conflict("operation_id reused for different context/action/price/version")
                if existing["status"] == "confirmed":
                    return load_observation(json.loads(existing["response_json"]))
                row = db.execute("SELECT * FROM payment_assignments WHERE assignment_id=?", (binding.assignment_id,)).fetchone()
                return self._state(row)  # never re-dispatch an unresolved operation
            row = db.execute("SELECT * FROM payment_assignments WHERE assignment_id=?", (binding.assignment_id,)).fetchone()
            self._bound(row, binding)
            if row["pending_operation"]:
                raise Conflict("unresolved operation blocks new operation IDs; reconcile first")
            current = self._state(row)
            guard(action, current.state, current.delivery, delivery)
            self._checked_verification(row, current, action, delivery)
            # Reads are hints unless a rail provides CAS. Fixture.execute compares
            # expected_revision atomically; the live Market equivalent is unknown.
            remote = self._check_observation(self.rail.inspect(binding), binding)
            if (remote.state, remote.revision, remote.delivery) != (current.state, current.revision, current.delivery):
                raise Conflict("stale/disputed rail state; do not send mutation")
            command = Command(operation_id, action, binding, delivery, current.revision)
            db.execute("INSERT INTO payment_operations VALUES (?,?,?,?,?,?,?)",
                       (operation_id, binding.assignment_id, request_json,
                        canonical(command_dict(command)), "sent", None, None))
            db.execute("UPDATE payment_assignments SET state=?,pending_operation=? WHERE assignment_id=?",
                       (State.UNKNOWN.value, operation_id, binding.assignment_id))
            db.execute("INSERT INTO payment_events(operation_id,kind,digest) VALUES (?,?,?)",
                       (operation_id, "dispatch_prepared", digest(command_dict(command))))
        try:
            result = self.rail.execute(command)
            return self._finish(command, result, result)
        except Exception as exc:
            return self._unknown(command, type(exc).__name__)
        # BaseException (hard crash/interrupt) intentionally leaves durable 'sent'.

    def _unknown(self, command, code):
        with self.db.transaction() as db:
            # A concurrent reconciler may already have confirmed the operation.
            db.execute("UPDATE payment_operations SET status='unknown',error_code=? WHERE operation_id=? AND status!='confirmed'",
                       (code, command.operation_id))
            operation = db.execute("SELECT * FROM payment_operations WHERE operation_id=?", (command.operation_id,)).fetchone()
            if operation["status"] == "confirmed":
                return load_observation(json.loads(operation["response_json"]))
            row = db.execute("SELECT * FROM payment_assignments WHERE assignment_id=?", (command.binding.assignment_id,)).fetchone()
            return self._state(row)

    def _finish(self, command, result, latest):
        self._check_observation(result, command.binding)
        self._check_observation(latest, command.binding)
        if (result.operation_id != command.operation_id or result.state != TARGET[command.action]
                or result.revision != command.expected_revision + 1):
            raise Conflict("response is not the exact operation outcome")
        if command.action in (Action.AWARD, Action.HOLD, Action.REFUND) and result.delivery is not None:
            raise Conflict("unexpected delivery in financial response")
        if command.action in (Action.SUBMIT, Action.ACCEPT, Action.RELEASE, Action.DISPUTE) and result.delivery != command.delivery:
            raise Conflict("response substituted delivery/version")
        self._progression(result, latest)
        if latest.revision < result.revision or (latest.revision == result.revision and latest != result):
            raise Conflict("stale or conflicting reconciliation observation")
        with self.db.transaction() as db:
            operation = db.execute("SELECT * FROM payment_operations WHERE operation_id=?", (command.operation_id,)).fetchone()
            if operation["status"] == "confirmed":
                return load_observation(json.loads(operation["response_json"]))
            row = db.execute("SELECT * FROM payment_assignments WHERE assignment_id=?", (command.binding.assignment_id,)).fetchone()
            if row["pending_operation"] != command.operation_id:
                raise Conflict("outbox ownership conflict")
            db.execute("UPDATE payment_operations SET status='confirmed',response_json=?,error_code=NULL WHERE operation_id=?",
                       (canonical(asdict(result)), command.operation_id))
            db.execute("UPDATE payment_assignments SET state=?,snapshot_json=?,pending_operation=NULL WHERE assignment_id=?",
                       (latest.state.value, canonical(asdict(latest)), command.binding.assignment_id))
            db.execute("INSERT INTO payment_events(operation_id,kind,digest) VALUES (?,?,?)",
                       (command.operation_id, "confirmed", digest(asdict(result))))
        return result

    def reconcile(self, operation_id):
        self._local_only()
        identifier(operation_id)
        with self.db.connect() as db:
            row = db.execute("SELECT * FROM payment_operations WHERE operation_id=?", (operation_id,)).fetchone()
            if row is None:
                raise Conflict("unknown operation_id")
            if row["status"] == "confirmed":
                return load_observation(json.loads(row["response_json"]))
            command = load_command(json.loads(row["command_json"]))
        try:
            result = self.rail.lookup(command)
            if result is None:
                # Even absence plus elapsed time cannot prove no financial effect.
                return self._unknown(command, "NO_AUTHORITATIVE_OPERATION_OUTCOME")
            latest = self.rail.inspect(command.binding)
            return self._finish(command, result, latest)
        except Exception as exc:
            return self._unknown(command, type(exc).__name__)
