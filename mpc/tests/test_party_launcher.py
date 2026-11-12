"""Administrative launcher controls. Mocked process tests are not MPC evidence.

One public circuit compilation and ephemeral synthetic PKI prepare artifact
checks. Actual native computation is separately exercised by verify_party_launcher.
"""
from copy import deepcopy
from concurrent.futures import ThreadPoolExecutor
import json
from pathlib import Path
import shutil
import sqlite3
import subprocess
import tempfile
import time
import unittest
from unittest.mock import patch

from mpc import network_profile as net
from mpc import party_launcher as launcher
from mpc.tests.verify_party_launcher import prepare
from mpc.run_local import cleanup, VENDOR


class LauncherTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.session,cls.prepared,cls.manifest,cls.profile,cls.configs = prepare()

    @classmethod
    def tearDownClass(cls):
        cleanup([],[],cls.session)

    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(dir=self.session)
        self.root = Path(self.temp.name)
        self.state = self.root/"state"
        self.state.mkdir(mode=0o700)
        launcher.Reservations(self.state,initialize=True)
        self.config = deepcopy(self.configs[0])
        self.config["state_directory"] = str(self.state)

    def tearDown(self):
        self.temp.cleanup()

    def preflight(self, config=None, **kwargs):
        value = self.config if config is None else config
        options = dict(allow_remote=True,allow_loopback_test=True)
        options.update(kwargs)
        return launcher.preflight(value,net.profile_digest(value),**options)

    def test_real_artifact_and_tls_preflight_selects_only_one_party(self):
        result = self.preflight()
        self.assertEqual(result["config"]["party"],0)
        self.assertEqual(result["addresses"],["127.0.0.1"]*3)
        self.assertEqual(result["mode"],"same-administration-loopback-functional-test")
        self.assertGreaterEqual(len(result["tapes"]),1)

    def test_all_approval_and_opt_in_boundaries_fail_before_process_creation(self):
        with patch.object(launcher.subprocess,"Popen",side_effect=AssertionError("process forbidden")):
            for options in (dict(allow_remote=False),dict(allow_loopback_test=False),dict(allow_loopback_test=1)):
                with self.assertRaises(ValueError):
                    self.preflight(**options)
            with self.assertRaises(ValueError):
                launcher.preflight(self.config,"a"*64,allow_remote=True,allow_loopback_test=True)
            bad = dict(self.config,extra_args=["-u"])
            with self.assertRaises(ValueError):
                self.preflight(bad)

    def test_remote_profile_has_no_loopback_override_without_separate_test_config(self):
        value = dict(self.config,loopback_test=None,loopback_test_sha256=None)
        result = self.preflight(value,allow_loopback_test=False)
        self.assertEqual(result["addresses"],["10.80.0.11","10.80.0.12","10.80.0.13"])
        self.assertEqual(result["mode"],"approved-explicit-bind")

    def test_changed_runtime_bytecode_schedule_stamp_or_ca_rejected(self):
        for artifact in ("binary","shared_library","schedule","bytecode_manifest","patch","recipe"):
            value = deepcopy(self.config)
            file = self.root/(artifact+".tampered")
            file.write_bytes(Path(value["artifacts"][artifact]).read_bytes()+b"tamper")
            value["artifacts"][artifact] = str(file)
            with self.subTest(artifact=artifact),self.assertRaises(ValueError):
                self.preflight(value)
        value = deepcopy(self.config)
        value["build_stamp_sha256"] = "a"*64
        with self.assertRaises(ValueError):
            self.preflight(value)
        tls = self.root/"tls"
        shutil.copytree(self.config["tls_directory"],tls)
        shutil.copyfile(tls/"P1.pem",tls/"P0.pem")
        value = dict(self.config,tls_directory=str(tls))
        with self.assertRaises(ValueError):
            self.preflight(value)

    def test_missing_state_or_foreign_private_key_fails_closed(self):
        (self.state/"party.sqlite").unlink()
        with self.assertRaises(OSError):
            self.preflight()
        launcher.Reservations(self.state,initialize=True)
        tls = self.root/"tls"
        shutil.copytree(self.config["tls_directory"],tls)
        shutil.copyfile(self.session/"P1/Player-Data/P1.key",tls/"P1.key")
        with self.assertRaises(ValueError):
            self.preflight(dict(self.config,tls_directory=str(tls)))

    def test_reservation_race_replay_and_same_epoch_new_job(self):
        now = int(time.time())
        def reserve():
            try:
                launcher.Reservations(self.state).reserve(self.profile,self.config["profile_sha256"],0,now)
                return True
            except ValueError:
                return False
        with ThreadPoolExecutor(max_workers=2) as pool:
            self.assertEqual(sorted(pool.map(lambda _:reserve(),range(2))),[False,True])
        another = dict(self.profile,job_binding_hash="a"*64,selection_round="b"*64)
        launcher.Reservations(self.state).reserve(another,"c"*64,0,now)
        changed = deepcopy(another)
        changed["parties"][0]["certificate_sha256"] = "d"*64
        changed["job_binding_hash"] = "e"*64
        with self.assertRaisesRegex(ValueError,"substitution"):
            launcher.Reservations(self.state).reserve(changed,"f"*64,0,now)

    def test_epoch_and_clock_rollback_are_persistent(self):
        now = int(time.time())
        profile = dict(self.profile,epoch=2)
        journal = launcher.Reservations(self.state)
        journal.reserve(profile,self.config["profile_sha256"],0,now)
        with self.assertRaisesRegex(ValueError,"rollback"):
            launcher.Reservations(self.state).reserve(self.profile,self.config["profile_sha256"],1,now)
        with self.assertRaisesRegex(ValueError,"clock rollback"):
            launcher.Reservations(self.state).reserve(dict(profile,epoch=3),self.config["profile_sha256"],1,now-1)

    def test_spawn_failure_burns_round_and_removes_transient_material(self):
        with patch.object(launcher,"_spawn_native",side_effect=OSError("synthetic spawn outage")) as spawn:
            with self.assertRaises(OSError):
                launcher.launch(self.config,net.profile_digest(self.config),allow_remote=True,allow_loopback_test=True)
            self.assertEqual(spawn.call_count,1)
        self.assertFalse(list(self.state.rglob("*.key")))
        self.assertFalse(list(self.state.rglob("Player-Data")))
        with patch.object(launcher,"_spawn_native",side_effect=AssertionError("must not retry")):
            with self.assertRaisesRegex(ValueError,"replay"):
                launcher.launch(self.config,net.profile_digest(self.config),allow_remote=True,allow_loopback_test=True)

    def test_timeout_kills_process_group_and_removes_keys_and_preprocessing(self):
        process = unittest.mock.Mock()
        process.pid = 424242
        process.poll.return_value = None
        process.wait.side_effect = [subprocess.TimeoutExpired("synthetic",1),subprocess.TimeoutExpired("synthetic",5),-9]
        with patch.object(launcher,"_spawn_native",return_value=process),patch.object(launcher.os,"killpg") as kill:
            with self.assertRaises(subprocess.TimeoutExpired):
                launcher.launch(self.config,net.profile_digest(self.config),allow_remote=True,allow_loopback_test=True)
            self.assertEqual(kill.call_count,2)
        self.assertFalse(list(self.state.rglob("*.key")))
        self.assertFalse(list(self.state.rglob("Player-Data")))

    def test_actual_native_rejects_incomplete_bind_configuration_before_listening(self):
        env = {"PATH":"/usr/bin:/bin","DYLD_LIBRARY_PATH":str(VENDOR),"LD_LIBRARY_PATH":str(VENDOR)}
        base = [str(VENDOR/"spdz2k-party.x"),"-N","3","-p","0","-pn","17500","-ip",str(self.root/"missing-peers")]
        program = self.profile["program"]["name"]
        for args in (["--veil-enable-bind"],
                     ["--veil-bind-ipv4","127.0.0.1","--veil-network-profile-sha256","a"*64],
                     ["--veil-enable-bind","--veil-bind-ipv4","0.0.0.0","--veil-network-profile-sha256","a"*64],
                     ["--veil-enable-bind","--veil-bind-ipv4","169.254.169.254","--veil-network-profile-sha256","a"*64]):
            result = subprocess.run(base+args+[program],cwd=VENDOR,env=env,capture_output=True,text=True,timeout=10)
            self.assertNotEqual(result.returncode,0)
            self.assertIn("explicit bind",result.stderr)
            self.assertNotIn("Additional argument has to be integer",result.stderr)


if __name__ == "__main__":
    unittest.main()
