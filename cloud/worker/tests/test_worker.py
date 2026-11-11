"""Synthetic transport tests. No real presigned URLs, customer input or FHE keys."""
import base64
from contextlib import contextmanager, redirect_stderr
from email.message import Message
import hashlib
import http.client
import io
import json
import os
from pathlib import Path
import socket
import stat
import tempfile
import threading
import time
import unittest
from unittest.mock import patch

from cloud.worker import job, server, transport
from engine.protocol import ARTIFACT_PINS, canonical_json, sha256, write_new

HOST = "te8dxe3fezmhyqku.private.blob.vercel-storage.com"
CONFIG = server.Config("synthetic-test-secret", HOST)


def fixture():
    blobs = {"request.bin": b"synthetic-ciphertext", "evaluation.keys": b"synthetic-evaluation-keys"}
    manifest = {"protocolVersion": 1, "profileId": "clean-4-records-v1", "attemptId": "a" * 32,
                "serverSha256": ARTIFACT_PINS["server.zip"],
                "clientSpecsSha256": ARTIFACT_PINS["client-specs.json"],
                "inputSha256": sha256(blobs["request.bin"]),
                "evaluationKeysSha256": sha256(blobs["evaluation.keys"])}
    blobs["request.json"] = canonical_json(manifest)
    payload = {"files": [{"name": name, "size": len(value), "sha256": sha256(value),
                           "url": "https://" + HOST + "/" + name + "?signature=synthetic"}
                          for name, value in blobs.items()],
               "requestManifestSha256": sha256(blobs["request.json"])}
    return payload, blobs, manifest


def successful_evaluator(root, payload, config):
    _, blobs, manifest = fixture()
    for name, data in blobs.items():
        write_new(root / name, data)
    output = b"synthetic-encrypted-output"
    write_new(root / "response.bin", output)
    receipt = {"request": manifest, "requestManifestSha256": payload["requestManifestSha256"],
               "outputSha256": sha256(output),
               "metrics": {"server_load_seconds": 1e-7, "evaluate_seconds": 0.125}}
    write_new(root / "receipt.json", canonical_json(receipt))


@contextmanager
def running(app):
    httpd = server.Server(("127.0.0.1", 0), app)
    thread = threading.Thread(target=httpd.serve_forever, kwargs={"poll_interval": 0.01}, daemon=True)
    thread.start()
    try:
        yield httpd.server_address
    finally:
        httpd.shutdown()
        httpd.server_close()
        thread.join(timeout=2)


def request(address, data=None, headers=None, path="/evaluate", method="POST"):
    conn = http.client.HTTPConnection(*address, timeout=4)
    try:
        conn.request(method, path, body=data, headers=headers or {})
        response = conn.getresponse()
        return response.status, json.loads(response.read())
    finally:
        conn.close()


HEADERS = {"Authorization": "Bearer " + CONFIG.token, "Content-Type": "application/json"}


class SchemaTests(unittest.TestCase):
    def test_exact_schema_and_limits(self):
        payload, _, _ = fixture()
        self.assertEqual(transport.validate_payload(json.dumps(payload).encode(), HOST), payload)
        cases = []
        def change(fn):
            value = json.loads(json.dumps(payload))
            fn(value)
            cases.append(value)
        change(lambda p: p.update(unexpected=True))
        change(lambda p: p["files"][0].update(size=True))
        change(lambda p: p["files"][0].update(name="../server.zip"))
        change(lambda p: p["files"][0].update(name="server.zip"))
        change(lambda p: p["files"][0].update(sha256="A" * 64))
        change(lambda p: p["files"][0].update(size=2 * 1024 * 1024 + 1))
        change(lambda p: p["files"][1].update(size=512 * 1024 * 1024 + 1))
        change(lambda p: p["files"][2].update(size=8193))
        change(lambda p: p["files"][2].update(sha256="0" * 64))
        change(lambda p: p["files"].append(p["files"][0]))
        change(lambda p: p["files"].pop())
        for value in cases:
            with self.subTest(value=value), self.assertRaises(transport.InvalidRequest):
                transport.validate_payload(json.dumps(value).encode(), HOST)
        for raw in (b"{" , b"\xff", b'{"files":[],"files":[]}', b"[NaN]", b"[" * 2000,
                    b" " * (transport.BODY_LIMIT + 1)):
            with self.assertRaises(transport.InvalidRequest):
                transport.validate_payload(raw, HOST)

    def test_three_or_four_only(self):
        payload, _, _ = fixture()
        payload["files"].append({"name": "binding.json", "size": 1, "sha256": "a" * 64,
                                  "url": "https://" + HOST + "/binding.json"})
        transport.validate_payload(json.dumps(payload).encode(), HOST)

    def test_urls(self):
        transport.validate_url("https://" + HOST + ":443/path?signature=synthetic", HOST)
        for url in ("http://" + HOST + "/path", "https://evil.example/", "https://" + HOST + ".evil.example/",
                    "https://" + HOST + ":444/", "https://user@" + HOST + "/",
                    "https://" + HOST + "@127.0.0.1/", "https://127.0.0.1/", "https://[::1]/",
                    "https://" + HOST + "/#fragment", "https://" + HOST + "/#", "https://" + HOST + "/\r\nX: y",
                    "https://" + HOST + "\\@evil.example/", "https://" + HOST + ".:/",
                    "https://" + HOST + "/é", "https://" + HOST + ":/", "//" + HOST + "/"):
            with self.subTest(url=url), self.assertRaises(transport.InvalidRequest):
                transport.validate_url(url, HOST)
        for host in ("localhost", "*.example.com", "127.0.0.1", "https://blob.example", HOST + "."):
            self.assertFalse(transport.valid_host(host))

    def test_dns_rejects_private_and_mixed_answers(self):
        for ip in ("127.0.0.1", "10.0.0.2", "169.254.169.254", "192.168.1.1", "0.0.0.0",
                   "100.64.0.1", "224.0.0.1", "::1", "fc00::1", "fe80::1", "::ffff:8.8.8.8"):
            family = socket.AF_INET6 if ":" in ip else socket.AF_INET
            answers = [(socket.AF_INET, socket.SOCK_STREAM, 6, "", ("8.8.8.8", 443)),
                       (family, socket.SOCK_STREAM, 6, "", (ip, 443))]
            with self.subTest(ip=ip), patch.object(socket, "getaddrinfo", return_value=answers):
                with self.assertRaises(transport.DownloadError):
                    transport.public_addresses(HOST)

    def test_connection_uses_checked_ip_once_and_hostname_tls(self):
        answers = [(socket.AF_INET, socket.SOCK_STREAM, 6, "", ("8.8.8.8", 443))]
        with patch.object(socket, "getaddrinfo", return_value=answers) as resolver, \
                patch.object(socket, "socket") as socket_type:
            connection = transport.PinnedHTTPSConnection(HOST, time.monotonic() + 3)
            with patch.object(connection._context, "wrap_socket") as tls:
                connection.connect()
                resolver.assert_called_once_with(HOST, 443, type=socket.SOCK_STREAM)
                socket_type.return_value.connect.assert_called_once_with(("8.8.8.8", 443))
                tls.assert_called_once_with(socket_type.return_value, server_hostname=HOST)
            connection.close()


class FakeResponse:
    def __init__(self, data, status=200, headers=()):
        self.status = status
        self.headers = Message()
        for name, value in headers:
            self.headers[name] = value
        self.data = io.BytesIO(data)

    def read1(self, size):
        return self.data.read(size)


class FakeConnection:
    sock = None

    def __init__(self, response):
        self.response = response
        self.closed = False
        self.calls = []

    def request(self, *args, **kwargs):
        self.calls.append((args, kwargs))

    def getresponse(self):
        return self.response

    def close(self):
        self.closed = True


class DownloadTests(unittest.TestCase):
    def test_streaming_hash_modes_and_no_redirect(self):
        payload, blobs, _ = fixture()
        file = payload["files"][0]
        data = blobs[file["name"]]
        cases = [(200, data, (), True), (200, data, (("Content-Length", str(len(data))),), True),
                 (200, data, (("Transfer-Encoding", "chunked"),), True),
                 (302, data, (("Location", "https://127.0.0.1/secret"),), False),
                 (307, data, (), False), (404, data, (), False), (206, data, (), False),
                 (200, data + b"extra", (), False), (200, data[:-1], (), False),
                 (200, b"z" * len(data), (), False),
                 (200, data, (("Content-Length", "999"),), False),
                 (200, data, (("Content-Encoding", "gzip"),), False),
                 (200, data, (("Content-Length", str(len(data))), ("Transfer-Encoding", "chunked")), False),
                 (200, data, (("Content-Length", str(len(data))), ("Content-Length", str(len(data)))), False)]
        for status, content, headers, valid in cases:
            with self.subTest(status=status, headers=headers, content=content), tempfile.TemporaryDirectory() as tmp:
                connection = FakeConnection(FakeResponse(content, status, headers))
                kwargs = {"connection_factory": lambda *_: connection}
                if valid:
                    transport.download(file, Path(tmp), HOST, time.monotonic() + 2, **kwargs)
                    self.assertEqual((Path(tmp) / file["name"]).read_bytes(), data)
                    self.assertEqual(stat.S_IMODE((Path(tmp) / file["name"]).stat().st_mode), 0o600)
                else:
                    with self.assertRaises(transport.DownloadError):
                        transport.download(file, Path(tmp), HOST, time.monotonic() + 2, **kwargs)
                self.assertTrue(connection.closed)
                self.assertEqual(len(connection.calls), 1)

    def test_symlink_and_timeout_rejected(self):
        payload, blobs, _ = fixture()
        file = payload["files"][0]
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            destination = root / "protected"
            destination.write_bytes(b"unchanged")
            (root / file["name"]).symlink_to(destination)
            connection = FakeConnection(FakeResponse(blobs[file["name"]]))
            with self.assertRaises(transport.DownloadError):
                transport.download(file, root, HOST, time.monotonic() + 2,
                                   connection_factory=lambda *_: connection)
            self.assertEqual(destination.read_bytes(), b"unchanged")
        with tempfile.TemporaryDirectory() as tmp, self.assertRaises(transport.DownloadError):
            transport.download(file, Path(tmp), HOST, time.monotonic() - 1,
                               connection_factory=lambda *_: FakeConnection(FakeResponse(b"")))


class HTTPTests(unittest.TestCase):
    def test_health_and_auth_fail_closed(self):
        for config in (CONFIG, server.Config("", HOST), server.Config(CONFIG.token, "")):
            app = server.Application(config, successful_evaluator)
            with running(app) as address:
                status, value = request(address, path="/health", method="GET")
                self.assertEqual(status, 200)
                self.assertEqual(set(value), {"version", "configured"})
                for headers in ({}, {**HEADERS, "Authorization": "Bearer wrong"}):
                    self.assertEqual(request(address, b"{}", headers)[0], 401)
                if not config.configured:
                    self.assertEqual(request(address, b"{}", HEADERS)[0], 401)
                self.assertEqual(request(address, path="/test", method="GET")[0], 404)

    def test_success_preserves_receipt_bytes_and_cleanup(self):
        payload, _, _ = fixture()
        observed = []
        def evaluate(root, body, config):
            observed.append(root)
            self.assertEqual(stat.S_IMODE(root.stat().st_mode), 0o700)
            successful_evaluator(root, body, config)
        with tempfile.TemporaryDirectory() as tmp:
            app = server.Application(CONFIG, evaluate, tmp)
            with running(app) as address:
                status, value = request(address, json.dumps(payload), HEADERS)
            self.assertEqual(status, 200)
            self.assertEqual(set(value), {"receipt", "receiptBase64", "outputBase64", "receiptSha256", "outputSha256"})
            receipt_bytes = base64.b64decode(value["receiptBase64"], validate=True)
            self.assertEqual(sha256(receipt_bytes), value["receiptSha256"])
            self.assertEqual(json.loads(receipt_bytes), value["receipt"])
            self.assertEqual(sha256(base64.b64decode(value["outputBase64"])), value["outputSha256"])
            self.assertEqual(list(Path(tmp).iterdir()), [])
            self.assertFalse(observed[0].exists())

    def test_bad_payload_and_framing(self):
        app = server.Application(CONFIG, successful_evaluator)
        with running(app) as address:
            self.assertEqual(request(address, "{", HEADERS)[0], 400)
            self.assertEqual(request(address, "x" * (transport.BODY_LIMIT + 1), HEADERS)[0], 413)
            self.assertEqual(request(address, "{}", {**HEADERS, "Content-Type": "text/plain"})[0], 415)
            self.assertEqual(request(address, "{}", {**HEADERS, "Transfer-Encoding": "chunked"})[0], 400)
            self.assertEqual(request(address, "{}", {**HEADERS, "Expect": "100-continue"})[0], 417)
            for raw_header in ("Content-Length: 2\r\nContent-Length: 2", "Content-Length: -1"):
                with socket.create_connection(address, timeout=2) as sock:
                    sock.sendall(("POST /evaluate HTTP/1.1\r\nHost: local\r\nAuthorization: Bearer " + CONFIG.token
                                  + "\r\nContent-Type: application/json\r\n" + raw_header + "\r\n\r\n{}").encode())
                    self.assertIn(b" 400 ", sock.recv(4096))

    def test_failure_cleanup_and_generic_errors(self):
        payload, _, _ = fixture()
        secret = "https://secret.example/?token=must-not-appear"
        def broken(root, body, config):
            write_new(root / "partial.keys", b"synthetic")
            raise RuntimeError(secret)
        with tempfile.TemporaryDirectory() as tmp:
            app = server.Application(CONFIG, broken, tmp)
            with running(app) as address:
                status, value = request(address, json.dumps(payload), HEADERS)
            self.assertEqual(status, 502)
            self.assertNotIn(secret, json.dumps(value))
            self.assertEqual(list(Path(tmp).iterdir()), [])
            self.assertFalse(app.slot.locked())

    def test_concurrent_eval_busy_but_health_responsive(self):
        payload, _, _ = fixture()
        entered, release = threading.Event(), threading.Event()
        def slow(root, body, config):
            entered.set()
            release.wait(timeout=3)
            successful_evaluator(root, body, config)
        app = server.Application(CONFIG, slow)
        result = []
        with running(app) as address:
            thread = threading.Thread(target=lambda: result.append(request(address, json.dumps(payload), HEADERS)))
            thread.start()
            try:
                self.assertTrue(entered.wait(timeout=2))
                started = time.monotonic()
                self.assertEqual(request(address, json.dumps(payload), HEADERS)[0], 503)
                self.assertLess(time.monotonic() - started, 0.5)
                self.assertEqual(request(address, path="/health", method="GET")[0], 200)
            finally:
                release.set()
                thread.join(timeout=3)
        self.assertEqual(result[0][0], 200)


class ProcessTests(unittest.TestCase):
    def test_real_subprocess_timeout_kill_cleanup_and_fixed_diagnostic(self):
        payload, _, _ = fixture()
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            script = root / "slow.py"
            script.write_text("import time; time.sleep(10)")
            work = root / "jobs"
            work.mkdir()
            config = server.Config(CONFIG.token, HOST, timeout=1)
            app = server.Application(config, server.SubprocessEvaluator(script), work)
            log = io.StringIO()
            started = time.monotonic()
            with redirect_stderr(log), self.assertRaises(server.WorkerError) as error:
                app.evaluate(json.dumps(payload).encode())
            self.assertEqual(error.exception.status, 504)
            self.assertLess(time.monotonic() - started, 3)
            self.assertEqual(list(work.iterdir()), [])
            self.assertEqual(log.getvalue(), "Worker job failed stage=deadline\n")

    def test_native_exit_codes_are_coarse_and_env_has_no_token(self):
        payload, _, _ = fixture()
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            script = root / "check.py"
            script.write_text("import os,sys; assert 'VEIL_WORKER_TOKEN' not in os.environ; sys.exit(13)")
            log = io.StringIO()
            with redirect_stderr(log), self.assertRaises(server.WorkerError) as error:
                server.SubprocessEvaluator(script)(root, payload, CONFIG)
            self.assertEqual(error.exception.status, 502)
            self.assertEqual(log.getvalue(), "Worker job failed stage=runtime_import\n")

    def test_timeout_configuration_cannot_exceed_gateway_budget(self):
        with patch.dict(os.environ, {"VEIL_WORKER_TIMEOUT_SECONDS": "221"}):
            with self.assertRaises(ValueError):
                server.Config.from_env()


if __name__ == "__main__":
    unittest.main()
