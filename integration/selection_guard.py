"""Local durable one-shot selection admission, not distributed consensus.

Reserve before releasing any private witness. Unknown outcomes stay reserved;
crash recovery must not silently rerun the privacy-sensitive selection oracle.
The operator deployment must enforce equivalent admission independently.
"""
import os
import re
import sqlite3


class SelectionGuard:
    def __init__(self, path):
        self.path = path
        fd = os.open(path, os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o600) if not path.exists() else None
        if fd is not None:
            os.close(fd)
        with self.connect() as db:
            db.execute("CREATE TABLE IF NOT EXISTS selections (job_hash TEXT PRIMARY KEY, bidset_hash TEXT NOT NULL, manifest_hash TEXT NOT NULL, state TEXT NOT NULL)")

    def connect(self):
        db = sqlite3.connect(str(self.path), timeout=5)
        db.execute("PRAGMA synchronous=FULL")
        return db

    def reserve(self, job_hash, bidset_hash, manifest_hash):
        for value in (job_hash, bidset_hash, manifest_hash):
            if type(value) is not str or re.fullmatch("[0-9a-f]{64}", value) is None:
                raise ValueError("Expected SHA-256 identity")
        with self.connect() as db:
            try:
                db.execute("INSERT INTO selections VALUES (?,?,?,?)", (job_hash, bidset_hash, manifest_hash, "IN_FLIGHT_OR_UNKNOWN"))
            except sqlite3.IntegrityError:
                raise ValueError("Selection already reserved/completed; no automatic rerun") from None

    def complete(self, job_hash, manifest_hash):
        with self.connect() as db:
            result = db.execute("UPDATE selections SET state='COMPLETED' WHERE job_hash=? AND manifest_hash=? AND state='IN_FLIGHT_OR_UNKNOWN'", (job_hash, manifest_hash))
            if result.rowcount != 1:
                raise ValueError("Unknown or already completed selection")
