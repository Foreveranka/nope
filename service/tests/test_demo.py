import json
import tempfile
import threading
import time
import unittest
from pathlib import Path
from service.demo import DemoRuns, DemoBusy
from service.tests import test_server as helpers


class DemoEndpointTests(unittest.TestCase):
    setUp = helpers.ServerTests.setUp
    close_server = helpers.ServerTests.close_server
    request = helpers.ServerTests.request

    def test_empty_and_csrf(self):
        status, _, raw = self.request("/api/demo")
        self.assertEqual(status, 200)
        self.assertIsNone(json.loads(raw)["run"])
        self.assertEqual(self.request("/api/demo", "POST", {}, {"Content-Type": "application/json"})[0], 403)
        self.assertEqual(self.request("/api/demo", "POST", {"records": []}, self.headers)[0], 400)
        self.assertEqual(self.request("/api/demo", "POST", {}, self.headers)[0], 409)  # injected pipeline cannot launch real demo

    def test_wrong_origin_read_blocked(self):
        self.assertEqual(self.request("/api/demo", headers={"Origin": "https://evil.invalid"})[0], 403)


class DemoStateTests(unittest.TestCase):
    def test_single_running_and_sanitized_result(self):
        entered, finish = threading.Event(), threading.Event()
        def runner(path):
            entered.set()
            finish.wait(2)
            return {"completed": True, "real_payment": False, "secret": "should-not-leak"}
        with tempfile.TemporaryDirectory() as tmp:
            runs = DemoRuns(Path(tmp), runner=runner)
            try:
                self.assertEqual(runs.start()["status"], "running")
                self.assertTrue(entered.wait(1))
                with self.assertRaises(DemoBusy):
                    runs.start()
                finish.set()
                runs.close()
                result = runs.snapshot()
                self.assertEqual(result["status"], "completed")
                self.assertNotIn("secret", result["result"])
            finally:
                finish.set()
                runs.close()

    def test_error_not_reflected(self):
        def runner(path):
            raise ValueError("do-not-show-private-error")
        with tempfile.TemporaryDirectory() as tmp:
            runs = DemoRuns(Path(tmp), runner=runner)
            runs.start()
            runs.close()
            snapshot = runs.snapshot()
            self.assertEqual(snapshot["status"], "failed")
            self.assertNotIn("do-not-show", json.dumps(snapshot))
