"""Isolated synthetic Git fixtures; never stage/edit/build the real vendor tree."""
from pathlib import Path
import subprocess
import tempfile
import unittest
from unittest.mock import patch

from mpc import bootstrap


class TransportProvenanceTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="veil-vendor-provenance-test-")
        self.repo = Path(self.temp.name)
        self.git("init","-q")
        (self.repo/"Networking").mkdir()
        (self.repo/"Networking/ServerSocket.cpp").write_text("loopback default\n")
        (self.repo/"Makefile").write_text("CFLAGS += -O1\n")
        self.git("add",".")
        self.git("-c","user.name=Synthetic fixture","-c","user.email=fixture@example.invalid",
                 "commit","-qm","synthetic upstream baseline")

    def tearDown(self):
        self.temp.cleanup()

    def git(self,*args):
        return subprocess.check_output(["git",*args],cwd=self.repo,stderr=subprocess.DEVNULL)

    def diff(self):
        with patch.object(bootstrap,"VENDOR",self.repo):
            return bootstrap.transport_diff()

    def test_clean_head_and_unstaged_reviewable_transport_delta_remain_supported(self):
        self.assertEqual(self.diff(),"")
        (self.repo/"Networking/ServerSocket.cpp").write_text("explicit approved loopback default\n")
        self.assertIn("+explicit approved loopback default",self.diff())

    def test_staged_makefile_insecure_injection_hidden_from_legacy_diff_is_rejected(self):
        (self.repo/"Makefile").write_text("CFLAGS += -DINSECURE\n")
        self.git("add","Makefile")
        self.assertEqual(self.git("diff","--name-only"),b"") # Original bypass precondition.
        with self.assertRaisesRegex(RuntimeError,"staged"):
            self.diff()

    def test_staged_then_restored_worktree_is_still_rejected(self):
        original = (self.repo/"Makefile").read_bytes()
        (self.repo/"Makefile").write_text("CFLAGS += -DINSECURE\n")
        self.git("add","Makefile")
        (self.repo/"Makefile").write_bytes(original)
        self.assertEqual(self.git("diff","HEAD","--name-only"),b"")
        with self.assertRaisesRegex(RuntimeError,"staged"):
            self.diff()

    def test_build_stamp_cannot_certify_staged_vendor_inputs(self):
        (self.repo/"Makefile").write_text("CFLAGS += -DINSECURE\n")
        self.git("add","Makefile")
        with patch.object(bootstrap,"VENDOR",self.repo):
            with self.assertRaisesRegex(RuntimeError,"staged"):
                bootstrap.record_native_build({},mode="synthetic test must not write stamp")

    def test_even_staged_allowlisted_transport_change_is_rejected(self):
        (self.repo/"Networking/ServerSocket.cpp").write_text("changed transport\n")
        self.git("add","Networking/ServerSocket.cpp")
        with self.assertRaisesRegex(RuntimeError,"staged"):
            self.diff()

    def test_unstaged_unreviewed_makefile_change_is_rejected(self):
        (self.repo/"Makefile").write_text("CFLAGS += -DINSECURE\n")
        with self.assertRaises(RuntimeError):
            self.diff()

    def test_native_only_entry_point_never_reaches_make_with_staged_insecure_input(self):
        import json
        (self.repo/"Makefile").write_text("CFLAGS += -DINSECURE\n")
        self.git("add","Makefile")
        local = self.repo/"local-test"
        local.mkdir()
        (local/"build-stamp.json").write_text(json.dumps({"insecureFlags":False,"livePreprocessing":True}))
        (self.repo/"CONFIG.mine").write_text(bootstrap.native_config())
        with patch.object(bootstrap,"VENDOR",self.repo),patch.object(bootstrap,"LOCAL",local), \
                patch.object(bootstrap.platform,"system",return_value="Darwin"), \
                patch.object(bootstrap.platform,"machine",return_value="arm64"), \
                patch.object(bootstrap,"output",return_value=bootstrap.UPSTREAM), \
                patch.object(bootstrap.sys,"argv",["bootstrap","--native-only"]), \
                patch.object(bootstrap,"run",side_effect=AssertionError("must not build")) as build:
            with self.assertRaisesRegex(RuntimeError,"staged"):
                bootstrap.main()
            build.assert_not_called()

    def test_assume_unchanged_and_skip_worktree_cannot_hide_tracked_build_inputs(self):
        for flag in ("--assume-unchanged","--skip-worktree"):
            self.git("update-index",flag,"Makefile")
            (self.repo/"Makefile").write_text("CFLAGS += -DINSECURE\n")
            self.assertEqual(self.git("diff","HEAD","--name-only"),b"")
            with self.subTest(flag=flag),self.assertRaises(RuntimeError):
                self.diff()
            self.git("update-index","--no-assume-unchanged","--no-skip-worktree","Makefile")
            (self.repo/"Makefile").write_text("CFLAGS += -O1\n")


if __name__ == "__main__":
    unittest.main()
