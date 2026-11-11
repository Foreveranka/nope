"""Short SQLite transactions; separate connections support multiple local processes."""
import sqlite3
from contextlib import contextmanager


class Database:
    def __init__(self, path, schema):
        self.path = str(path)
        if self.path == ":memory:":
            raise ValueError("a durable file path is required")
        with self.connect() as db:
            db.executescript(schema)

    @contextmanager
    def connect(self):
        db = sqlite3.connect(self.path, timeout=10, isolation_level=None)
        db.row_factory = sqlite3.Row
        try:
            db.execute("PRAGMA foreign_keys=ON")
            db.execute("PRAGMA journal_mode=WAL")
            db.execute("PRAGMA synchronous=FULL")
            yield db
        finally:
            db.close()

    @contextmanager
    def transaction(self):
        with self.connect() as db:
            db.execute("BEGIN IMMEDIATE")
            try:
                yield db
                db.commit()
            except BaseException:
                db.rollback()
                raise
