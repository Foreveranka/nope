import io
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import Mock, patch

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))
from mpc import run_local


class CleanupRegressionTests(unittest.TestCase):
    def setUp(self):
        staging = run_local.ROOT / "runtime"
        staging.mkdir(exist_ok=True)
        self.temporary = tempfile.TemporaryDirectory(dir=staging)
        self.addCleanup(self.temporary.cleanup)
        self.session = Path(self.temporary.name)

    def key(self, relative):
        path = self.session / relative
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text("synthetic lifecycle-test marker, not a key")

    def assert_clean(self):
        self.assertFalse(list(self.session.rglob("*.key")))
        self.assertFalse(list(self.session.glob("*/Player-Data")))
        self.assertFalse((self.session / "certificates").exists())

    def test_transient_signal_permission_error_still_reaps_and_erases(self):
        self.key("C0/Player-Data/partial.key")
        self.key("certificates/partial.key")
        child = Mock(pid=999999)
        child.wait.side_effect = [subprocess.TimeoutExpired("owned fixture", .2), -6]
        child.terminate.side_effect = PermissionError("injected transient signal failure")
        log = io.StringIO()
        run_local.cleanup([child], [log], self.session)
        self.assert_clean()
        self.assertTrue(log.closed)
        child.terminate.assert_called_once()
        child.kill.assert_not_called()

    def test_certificate_setup_failure_erases_generation_and_moved_keys(self):
        def fail(*args, **kwargs):
            self.key("certificates/partial.key")
            self.key("C0/Player-Data/partial.key")
            raise OSError("injected certificate setup failure")
        with patch.object(run_local, "run_logged", side_effect=fail):
            with self.assertRaisesRegex(OSError, "injected certificate setup failure"):
                run_local.certificates(self.session)
        self.assert_clean()

    def test_unreaped_child_is_error_but_keys_are_still_erased(self):
        self.key("P0/Player-Data/partial.key")
        child = Mock(pid=999999)
        child.wait.side_effect = subprocess.TimeoutExpired("owned fixture", 5)
        child.terminate.side_effect = PermissionError("injected")
        child.kill.side_effect = PermissionError("injected")
        with self.assertRaisesRegex(RuntimeError, "could not reap owned child"):
            run_local.cleanup([child], [], self.session)
        self.assert_clean()
        child.terminate.assert_called_once()
        child.kill.assert_called_once()


if __name__ == "__main__":
    unittest.main()
