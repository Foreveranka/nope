"""LOCAL SIMULATION ONLY. This ledger is not a Market hold or an escrow."""
import json
import sqlite3
from dataclasses import asdict
from .interface import Action, Observation, State
from .model import (Conflict, TARGET, binding_hash, canonical, command_dict,
                    digest, guard, load_delivery, load_observation)
from .storage import Database

SCHEMA = """
CREATE TABLE IF NOT EXISTS fixture_assignments (
 assignment_id TEXT PRIMARY KEY, binding_json TEXT NOT NULL,
 job_id TEXT NOT NULL, attempt_id TEXT NOT NULL,
 state TEXT NOT NULL, revision INTEGER NOT NULL, delivery_json TEXT,
 evidence_id TEXT NOT NULL, operation_id TEXT,
 UNIQUE(job_id, attempt_id)
);
CREATE TABLE IF NOT EXISTS fixture_operations (
 operation_id TEXT PRIMARY KEY, request_json TEXT NOT NULL, response_json TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS fixture_movements (
 assignment_id TEXT NOT NULL, kind TEXT NOT NULL, micros INTEGER NOT NULL,
 operation_id TEXT NOT NULL UNIQUE, PRIMARY KEY(assignment_id, kind)
);
"""


class LocalFixtureRail:
    mode = "local_fixture_simulation"

    def __init__(self, db_path):
        self.db = Database(db_path, SCHEMA)

    def register(self, binding):
        binding_hash(binding)
        encoded = canonical(asdict(binding))
        with self.db.transaction() as db:
            existing = db.execute("SELECT * FROM fixture_assignments WHERE assignment_id=?", (binding.assignment_id,)).fetchone()
            if existing:
                if existing["binding_json"] != encoded:
                    raise Conflict("fixture assignment binding is immutable")
                return
            try:
                db.execute("INSERT INTO fixture_assignments VALUES (?,?,?,?,?,?,?,?,?)",
                           (binding.assignment_id, encoded, binding.job_id, binding.attempt_id,
                            State.NEW.value, 0, None, "fixture:registered", None))
            except sqlite3.IntegrityError as exc:
                # Avoid leaking SQL/user input through adapter error reporting.
                raise Conflict("fixture job/attempt already bound") from exc

    def _observation(self, row, binding):
        if row is None or row["binding_json"] != canonical(asdict(binding)):
            raise Conflict("fixture binding missing or mismatched")
        return Observation(binding, State(row["state"]), row["revision"],
                           load_delivery(json.loads(row["delivery_json"])) if row["delivery_json"] else None,
                           row["evidence_id"], self.mode, row["operation_id"])

    def inspect(self, binding):
        binding_hash(binding)
        with self.db.connect() as db:
            return self._observation(db.execute("SELECT * FROM fixture_assignments WHERE assignment_id=?", (binding.assignment_id,)).fetchone(), binding)

    def lookup(self, command):
        request = canonical(command_dict(command))
        with self.db.connect() as db:
            row = db.execute("SELECT * FROM fixture_operations WHERE operation_id=?", (command.operation_id,)).fetchone()
            if row is None:
                return None
            if request != row["request_json"]:
                raise Conflict("fixture operation key reused for another command")
            return load_observation(json.loads(row["response_json"]))

    def execute(self, command):
        request = canonical(command_dict(command))
        with self.db.transaction() as db:
            prior = db.execute("SELECT * FROM fixture_operations WHERE operation_id=?", (command.operation_id,)).fetchone()
            if prior:
                if prior["request_json"] != request:
                    raise Conflict("fixture operation key reused")
                return load_observation(json.loads(prior["response_json"]))
            row = db.execute("SELECT * FROM fixture_assignments WHERE assignment_id=?", (command.binding.assignment_id,)).fetchone()
            current = self._observation(row, command.binding)
            if current.revision != command.expected_revision:
                raise Conflict("fixture atomic revision conflict")
            guard(command.action, current.state, current.delivery, command.delivery)
            next_delivery = command.delivery if command.action == Action.SUBMIT else current.delivery
            result = Observation(command.binding, TARGET[command.action], current.revision + 1,
                                 next_delivery, "fixture:" + digest(command_dict(command)),
                                 self.mode, command.operation_id)
            if command.action in (Action.HOLD, Action.RELEASE, Action.REFUND):
                # Split/ruling/fees/real settlement deliberately not simulated.
                if command.action in (Action.RELEASE, Action.REFUND):
                    if db.execute("SELECT 1 FROM fixture_movements WHERE assignment_id=? AND kind IN ('release','refund')", (command.binding.assignment_id,)).fetchone():
                        raise Conflict("fixture funds already finalized")
                db.execute("INSERT INTO fixture_movements VALUES (?,?,?,?)",
                           (command.binding.assignment_id, command.action.value,
                            command.binding.price.micros, command.operation_id))
            db.execute("UPDATE fixture_assignments SET state=?,revision=?,delivery_json=?,evidence_id=?,operation_id=? WHERE assignment_id=?",
                       (result.state.value, result.revision,
                        canonical(asdict(next_delivery)) if next_delivery else None,
                        result.evidence_id, result.operation_id, command.binding.assignment_id))
            db.execute("INSERT INTO fixture_operations VALUES (?,?,?)",
                       (command.operation_id, request, canonical(asdict(result))))
            return result

    def movement_count(self, binding, kind):
        binding_hash(binding)
        with self.db.connect() as db:
            return db.execute("SELECT count(*) FROM fixture_movements WHERE assignment_id=? AND kind=?", (binding.assignment_id, kind)).fetchone()[0]
