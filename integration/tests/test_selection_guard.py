import tempfile
import unittest
from pathlib import Path
from integration.selection_guard import SelectionGuard


class SelectionGuardTests(unittest.TestCase):
    def test_restart_keeps_unknown_and_blocks_new_manifest(self):
        with tempfile.TemporaryDirectory() as tmp:
            p = Path(tmp) / "guard.sqlite"
            SelectionGuard(p).reserve("1" * 64, "2" * 64, "3" * 64)
            restarted = SelectionGuard(p)
            for manifest in ("3" * 64, "4" * 64):
                with self.assertRaises(ValueError):
                    restarted.reserve("1" * 64, "2" * 64, manifest)
            with self.assertRaises(ValueError):
                restarted.complete("1" * 64, "4" * 64)
            restarted.complete("1" * 64, "3" * 64)
            with self.assertRaises(ValueError):
                restarted.complete("1" * 64, "3" * 64)
