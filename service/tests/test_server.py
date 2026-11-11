"""HTTP/service unit tests with TEST-ONLY fake pipelines, never real FHE e2e."""

import contextlib
import copy
import http.client
import importlib
import io
import json
import socket
import tempfile
import threading
import time
import types
import unittest
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from unittest.mock import patch

from service.server import MAX_BODY, MAX_JOBS, ROOT, create_server


RECORDS = [{"id": 10, "value": 255}, {"id": 20, "value": 42},
           {"id": 10, "value": 150}, {"id": 30, "value": 100}]
EXPECTED = [{"id": 10, "value": 0, "duplicate": False},
            {"id": 20, "value": 42, "duplicate": False},
            {"id": 10, "value": 100, "duplicate": True},
            {"id": 30, "value": 100, "duplicate": False}]
PRIVATE = "TEST-ONLY-plaintext-secret-key-do-not-expose"


def fake_pipeline(records, job_dir, on_stage=None):
    """TEST ONLY: cleartext fixture, no encryption and no persisted artifacts."""
    if on_stage:
        for stage in ("ENCRYPTING", "EVALUATING", "VERIFYING"):
            on_stage(stage, PRIVATE)
    return {"records": copy.deepcopy(EXPECTED), "verified": True,
            "metrics": {"testOnlySeconds": 0.001}, "artifactHashes": {"testOnly": "a" * 64}}


class ServerTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="veil-service-test-")
        self.base = Path(self.temp.name)
        self.server = create_server(port=0, runtime_dir=self.base / "runtime", pipeline=fake_pipeline)
        self.server.web_dir = self.base / "web"
        self.server.web_dir.mkdir()
        for name in ("index.html", "app.html", "app.js", "input.mjs", "styles.css"):
            (self.server.web_dir / name).write_text("<html>Test-only static fixture</html>")
        self.thread = threading.Thread(target=self.server.serve_forever, kwargs={"poll_interval": 0.01}, daemon=True)
        self.thread.start()
        self.headers = {"Origin": self.server.origin, "X-CSRF-Token": self.server.state.csrf_token,
                        "Content-Type": "application/json"}
        self.addCleanup(self.temp.cleanup)
        self.addCleanup(self.close_server)

    def close_server(self):
        self.server.shutdown()
        self.server.server_close()
        self.thread.join(timeout=2)

    def request(self, path, method="GET", payload=None, headers=None, raw=None):
        if raw is None and payload is not None:
            raw = json.dumps(payload).encode()
        connection = http.client.HTTPConnection(*self.server.server_address, timeout=5)
        try:
            connection.request(method, path, body=raw, headers=headers or {})
            response = connection.getresponse()
            return response.status, dict(response.getheaders()), response.read()
        finally:
            connection.close()

    def submit(self, title="Synthetic test", records=None):
        return self.request("/api/jobs", "POST", {"title": title, "records": RECORDS if records is None else records}, self.headers)

    def wait_job(self, job_id):
        deadline = time.monotonic() + 5
        while time.monotonic() < deadline:
            status, _, body = self.request("/api/jobs/" + job_id)
            self.assertEqual(status, 200)
            job = json.loads(body)["job"]
            if job["status"] in ("COMPLETED", "FAILED"):
                # The final queue-slot release occurs just after the result update.
                with self.server.state.lock:
                    if self.server.state.active == 0:
                        return job
            time.sleep(0.005)
        self.fail("Test-only pipeline did not finish")

    def raw_request(self, lines, body=b""):
        with socket.create_connection(self.server.server_address, timeout=5) as connection:
            connection.sendall(("\r\n".join(lines) + "\r\n\r\n").encode("ascii") + body)
            response = http.client.HTTPResponse(connection)
            response.begin()
            return response.status, dict(response.getheaders()), response.read()

    def test_landing_app_static_allowlist_and_security_headers(self):
        for path, content_type in (("/", "text/html"), ("/app", "text/html"),
                                   ("/app.js", "text/javascript"), ("/input.mjs", "text/javascript"),
                                   ("/styles.css", "text/css")):
            with self.subTest(path=path):
                status, headers, _ = self.request(path)
                self.assertEqual(status, 200)
                self.assertTrue(headers["Content-Type"].startswith(content_type))
                self.assertIn("script-src 'self'", headers["Content-Security-Policy"])
                self.assertNotIn("unsafe-inline", headers["Content-Security-Policy"])
                self.assertEqual(headers["X-Content-Type-Options"], "nosniff")
                self.assertEqual(headers["X-Frame-Options"], "DENY")
                self.assertEqual(headers["Cache-Control"], "no-store")
                self.assertNotIn("Access-Control-Allow-Origin", headers)
        for path in ("/../AGENTS.md", "/%2e%2e/AGENTS.md", "/.git/config", "/runtime/",
                     "/service/server.py", "/web/app.html", "/uploads/evil.js", "/evil.js", "/index.html",
                     "/other.mjs", "/web/input.mjs"):
            self.assertEqual(self.request(path)[0], 404, path)
        (self.server.web_dir / "app.js").unlink()
        (self.server.web_dir / "app.js").symlink_to(ROOT / "AGENTS.md")
        self.assertEqual(self.request("/app.js")[0], 404)

    def test_health_capabilities_no_origin_and_injected_pipeline_label(self):
        self.assertEqual(json.loads(self.request("/health")[2]), {"ok": True})
        status, headers, body = self.request("/api/capabilities", headers={"Sec-Fetch-Site": "same-origin"})
        caps = json.loads(body)
        self.assertEqual(status, 200)
        self.assertEqual(headers["Cache-Control"], "no-store")
        self.assertEqual(caps["profile"], {"id": "clean-4-records-v1", "recordCount": 4})
        self.assertGreaterEqual(len(caps["csrfToken"]), 32)
        statuses = {cap["id"]: cap["status"] for cap in caps["capabilities"]}
        self.assertEqual(statuses, {"fhe": "test-only", "mpc": "pending", "near": "pending", "payments": "disabled"})
        self.assertEqual(self.request("/api/jobs")[0], 200)
        self.assertEqual(self.request("/", headers={"Sec-Fetch-Site": "none"})[0], 200)

    def test_foreign_origin_and_cross_site_reads_do_not_leak_token(self):
        for path in ("/api/capabilities", "/api/jobs", "/health", "/"):
            for headers in ({"Origin": "https://attacker.invalid"}, {"Origin": "null"},
                            {"Origin": self.server.origin + "/"}, {"Sec-Fetch-Site": "cross-site"},
                            {"Sec-Fetch-Site": "same-site"}):
                with self.subTest(path=path, headers=headers):
                    status, response_headers, body = self.request(path, headers=headers)
                    self.assertEqual(status, 403)
                    self.assertNotIn(self.server.state.csrf_token.encode(), body)
                    self.assertNotIn("Access-Control-Allow-Origin", response_headers)

    def test_host_is_exact_selected_port_and_duplicate_headers_rejected(self):
        port = self.server.server_port
        for host in ("localhost:" + str(port), "127.0.0.1", "127.0.0.1:8765" if port != 8765 else "127.0.0.1:8766",
                     "attacker.invalid", "127.0.0.1.:" + str(port), "127.0.0.1:0"):
            self.assertEqual(self.request("/api/capabilities", headers={"Host": host})[0], 403)
        self.assertEqual(self.request("/api/capabilities", headers={"Host": self.server.expected_host})[0], 200)
        self.assertEqual(self.raw_request(["GET /health HTTP/1.0"])[0], 403)
        for name, value in (("Host", self.server.expected_host), ("Origin", self.server.origin),
                            ("Sec-Fetch-Site", "same-origin")):
            lines = ["GET /api/capabilities HTTP/1.1"]
            if name != "Host":
                lines.append("Host: " + self.server.expected_host)
            lines.extend([name + ": " + value, name + ": " + value])
            status, _, body = self.raw_request(lines)
            self.assertEqual(status, 400)
            self.assertNotIn(self.server.state.csrf_token.encode(), body)

    def test_cross_site_document_entry_only_no_api_assets_or_iframe_exception(self):
        navigation = {"Sec-Fetch-Site": "cross-site", "Sec-Fetch-Mode": "navigate",
                      "Sec-Fetch-Dest": "document"}
        for method in ("GET", "HEAD"):
            for path in ("/", "/app"):
                self.assertEqual(self.request(path, method, headers=navigation)[0], 200)
        for path in ("/api/capabilities", "/api/jobs", "/health", "/styles.css", "/app.js", "/input.mjs"):
            status, _, body = self.request(path, headers=navigation)
            self.assertEqual(status, 403)
            self.assertNotIn(self.server.state.csrf_token.encode(), body)
        for changes in ({"Sec-Fetch-Dest": "iframe"}, {"Sec-Fetch-Dest": "embed"},
                        {"Sec-Fetch-Mode": "cors"}, {"Origin": "https://attacker.invalid"},
                        {"Origin": "null"}, {"Host": "attacker.invalid"}):
            headers = dict(navigation)
            headers.update(changes)
            for path in ("/", "/app"):
                self.assertEqual(self.request(path, headers=headers)[0], 403)
        self.assertEqual(self.request("/", headers={**navigation, "Sec-Fetch-Site": "same-site"})[0], 200)
        self.assertEqual(self.request("/api/jobs", "POST", {"title": "Test", "records": RECORDS},
                                      {**self.headers, **navigation})[0], 403)

    def test_mutations_require_both_exact_origin_and_csrf(self):
        payload = {"title": "Test", "records": RECORDS}
        for changes in ({"Origin": None}, {"Origin": "null"}, {"Origin": "https://attacker.invalid"},
                        {"X-CSRF-Token": None}, {"X-CSRF-Token": "bad"}, {"Sec-Fetch-Site": "cross-site"}):
            headers = dict(self.headers)
            for key, value in changes.items():
                if value is None:
                    headers.pop(key, None)
                else:
                    headers[key] = value
            self.assertEqual(self.request("/api/jobs", "POST", payload, headers)[0], 403)
        self.assertEqual(self.request("/api/jobs", "OPTIONS", headers={"Origin": "https://attacker.invalid"})[0], 403)
        self.assertEqual(self.request("/api/jobs", "OPTIONS", headers=self.headers)[0], 405)
        self.assertEqual(self.server.state.active, 0)

    def test_strict_payload_validation(self):
        invalid = [None, [], {}, {"title": "Test", "records": RECORDS, "extra": 1},
                   {"title": "", "records": RECORDS}, {"title": " " * 2, "records": RECORDS},
                   {"title": "x" * 121, "records": RECORDS}, {"title": True, "records": RECORDS},
                   {"title": "line\nbreak", "records": RECORDS}, {"title": "\ud800", "records": RECORDS},
                   {"title": "Test", "records": RECORDS[:3]}, {"title": "Test", "records": RECORDS + RECORDS[:1]}]
        for bad in (True, False, "1", 1.0, -1, 256, None, [], {}):
            for key in ("id", "value"):
                records = copy.deepcopy(RECORDS)
                records[0][key] = bad
                invalid.append({"title": "Test", "records": records})
        for row in ({"id": 1}, {"id": 1, "value": 1, "extra": 1}, []):
            invalid.append({"title": "Test", "records": [row] + RECORDS[1:]})
        for payload in invalid:
            with self.subTest(payload=payload):
                self.assertEqual(self.request("/api/jobs", "POST", payload, self.headers,
                                              raw=b"null" if payload is None else None)[0], 400)
        self.assertEqual(self.server.state.list_jobs(), [])

    def test_json_and_body_framing_limits(self):
        for body in (b"{", b"\xff", b'{"title":"x","title":"y","records":[]}',
                     b'{"title":"x","records":[NaN]}', b"[" * 2000):
            self.assertEqual(self.request("/api/jobs", "POST", headers=self.headers, raw=body)[0], 400)
        self.assertEqual(self.request("/api/jobs", "POST", headers=self.headers, raw=b" " * (MAX_BODY + 1))[0], 413)
        payload = json.dumps({"title": "Boundary", "records": RECORDS}).encode()
        accepted = self.request("/api/jobs", "POST", headers=self.headers, raw=payload + b" " * (MAX_BODY - len(payload)))
        self.assertEqual(accepted[0], 201)
        self.wait_job(json.loads(accepted[2])["job"]["id"])
        for changes, expected in (({"Content-Type": "text/plain"}, 415),
                                  ({"Content-Type": "application/json; charset=latin1"}, 415),
                                  ({"Content-Encoding": "gzip"}, 400), ({"Transfer-Encoding": "chunked"}, 400),
                                  ({"Content-Length": "-1"}, 400), ({"Content-Length": "1,1"}, 400)):
            headers = dict(self.headers)
            headers.update(changes)
            self.assertEqual(self.request("/api/jobs", "POST", headers=headers, raw=b"{}")[0], expected)
        base = ["POST /api/jobs HTTP/1.1", "Host: " + self.server.expected_host,
                "Origin: " + self.server.origin, "X-CSRF-Token: " + self.server.state.csrf_token,
                "Content-Type: application/json"]
        self.assertEqual(self.raw_request(base)[0], 411)
        for name, value in (("Content-Length", "2"), ("X-CSRF-Token", self.server.state.csrf_token),
                            ("Content-Type", "application/json")):
            lines = base + ["Content-Length: 2", name + ": " + value]
            self.assertEqual(self.raw_request(lines, b"{}")[0], 400)

    def test_async_lifecycle_output_copies_and_no_plaintext_files(self):
        self.assertEqual(self.server.state.executor._max_workers, 1)
        status, _, body = self.submit(title="Sensitive synthetic title")
        self.assertEqual(status, 201)
        initial = json.loads(body)["job"]
        self.assertEqual(initial["status"], "QUEUED")
        self.assertNotIn("records", initial)
        job = self.wait_job(initial["id"])
        self.assertEqual(job["status"], "COMPLETED")
        self.assertEqual(job["result"], {"records": EXPECTED, "verified": True})
        self.assertEqual([event["stage"] for event in job["events"]],
                         ["QUEUED", "ENCRYPTING", "EVALUATING", "VERIFYING", "COMPLETED"])
        self.assertNotIn(PRIVATE, json.dumps(job))
        self.assertNotIn("records", {key: value for key, value in self.server.state.jobs[initial["id"]].items() if key != "result"})
        self.assertEqual(list((self.base / "runtime").rglob("*")), [self.base / "runtime" / initial["id"]])
        self.assertEqual(json.loads(self.request("/api/jobs")[2])["jobs"][0]["id"], initial["id"])
        job["result"]["records"][0]["id"] = 99
        snapshot = self.server.state.get_job(initial["id"])
        snapshot["result"]["records"][0]["id"] = 98
        self.assertEqual(self.server.state.get_job(initial["id"])["result"]["records"], EXPECTED)
        self.assertEqual(self.request("/api/jobs/" + "0" * 32)[0], 404)
        self.assertEqual(self.request("/api/jobs/not-an-id")[0], 404)
        self.assertEqual(self.request("/api/jobs/" + initial["id"], headers={"Origin": "https://attacker.invalid"})[0], 403)

    def test_worker_exceptions_false_and_malformed_results_never_complete_or_leak(self):
        def raising(*args, **kwargs):
            raise RuntimeError(PRIVATE)

        outputs = [None, {}, {**fake_pipeline(None, None), "verified": False},
                   {**fake_pipeline(None, None), "verified": 1},
                   {**fake_pipeline(None, None), "records": []},
                   {**fake_pipeline(None, None), "metrics": {"x": float("nan")}},
                   {**fake_pipeline(None, None), "artifactHashes": {"bad": PRIVATE}}]
        pipelines = [raising] + [(lambda *args, output=output, **kwargs: output) for output in outputs]
        captured_out = io.StringIO()
        captured_err = io.StringIO()
        with contextlib.redirect_stdout(captured_out), contextlib.redirect_stderr(captured_err):
            for pipeline in pipelines:
                self.server.state.pipeline = pipeline
                status, _, body = self.submit()
                self.assertEqual(status, 201)
                job = self.wait_job(json.loads(body)["job"]["id"])
                self.assertEqual(job["status"], "FAILED")
                self.assertIn("error", job)
                self.assertNotIn("result", job)
                self.assertNotIn(PRIVATE, json.dumps(job))
        self.assertNotIn(PRIVATE, captured_out.getvalue() + captured_err.getvalue())
        self.assertEqual(self.server.state.active, 0)

    def test_atomic_active_queue_limit_and_serial_worker(self):
        gate = threading.Event()
        started = threading.Event()
        calls = []

        def blocking(records, job_dir, on_stage=None):
            calls.append(threading.get_ident())
            started.set()
            if not gate.wait(5):
                raise RuntimeError("Test gate timeout")
            return fake_pipeline(records, job_dir, on_stage)

        self.server.state.pipeline = blocking
        self.addCleanup(gate.set)
        with ThreadPoolExecutor(max_workers=12) as requests:
            results = list(requests.map(lambda _: self.submit(), range(12)))
        self.assertTrue(started.wait(1))
        accepted = [json.loads(body)["job"]["id"] for status, _, body in results if status == 201]
        self.assertEqual(len(accepted), 8)
        self.assertEqual(sum(status == 429 for status, _, _ in results), 4)
        self.assertEqual(self.server.state.active, 8)
        self.assertEqual(len(calls), 1)
        for status, headers, body in results:
            if status == 429:
                self.assertEqual(headers["Retry-After"], "2")
                self.assertIn("queue is full", json.loads(body)["error"])
        gate.set()
        self.wait_job(accepted[-1])
        self.assertEqual(len(calls), 8)
        self.assertEqual(len(set(calls)), 1)
        self.assertEqual(len(self.server.state.list_jobs()), 8)
        self.assertEqual(self.submit()[0], 201)

    def test_session_history_limit_is_64_and_never_evicts(self):
        first_id = None
        for index in range(MAX_JOBS):
            status, _, body = self.submit(title="Synthetic " + str(index))
            self.assertEqual(status, 201)
            job_id = json.loads(body)["job"]["id"]
            first_id = first_id or job_id
            self.wait_job(job_id)
        status, _, body = self.submit()
        self.assertEqual(status, 429)
        self.assertIn("restart", json.loads(body)["error"])
        self.assertEqual(len(self.server.state.list_jobs()), 64)
        self.assertEqual(self.request("/api/jobs/" + first_id)[0], 200)

    def test_engine_import_is_lazy_and_in_worker_thread_test_only_patch(self):
        self.server.state.pipeline = None
        observed = []
        real_import = importlib.import_module

        def patched_import(name, *args, **kwargs):
            if name == "engine.pipeline":
                observed.append(threading.current_thread().name)
                return types.SimpleNamespace(run_job=fake_pipeline)  # TEST ONLY; not genuine FHE.
            return real_import(name, *args, **kwargs)

        with patch("service.server.importlib.import_module", side_effect=patched_import):
            caps = json.loads(self.request("/api/capabilities")[2])
            self.assertEqual(caps["capabilities"][0]["status"], "pending")
            self.assertEqual(observed, [])
            status, _, body = self.submit()
            self.assertEqual(status, 201)
            self.assertEqual(self.wait_job(json.loads(body)["job"]["id"])["status"], "COMPLETED")
        self.assertEqual(len(observed), 1)
        self.assertTrue(observed[0].startswith("local-fhe"))

    def test_factory_rejects_non_loopback_hosts_and_invalid_ports(self):
        for host in ("0.0.0.0", "localhost", "::1", "127.0.0.2"):
            with self.assertRaises(ValueError):
                create_server(host=host, port=0)
        for port in (True, -1, 65536, "8765"):
            with self.assertRaises(ValueError):
                create_server(port=port)


if __name__ == "__main__":
    unittest.main()
