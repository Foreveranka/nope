"""Bounded encrypted-only worker HTTP server. Run: python -m cloud.worker.server."""
import base64
from dataclasses import dataclass
import hashlib
import hmac
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
import os
from pathlib import Path
import re
import signal
import subprocess
import sys
import tempfile
import threading
import time

from .transport import BODY_LIMIT, InvalidRequest, decode_json, valid_host, validate_payload

VERSION = "0.1.0"
MAX_OUTPUT = 512 * 1024
MAX_RECEIPT = 16384
MAX_JOB_SECONDS = 220


@dataclass(frozen=True)
class Config:
    token: str = ""
    blob_host: str = ""
    timeout: int = MAX_JOB_SECONDS
    memory_mb: int = 8192

    @classmethod
    def from_env(cls):
        # Malformed configuration fails closed at startup, never echoed.
        timeout = int(os.environ.get("VEIL_WORKER_TIMEOUT_SECONDS", str(MAX_JOB_SECONDS)))
        memory = int(os.environ.get("VEIL_WORKER_MEMORY_MB", "8192"))
        if not 1 <= timeout <= MAX_JOB_SECONDS or not 1024 <= memory <= 65536:
            raise ValueError("Invalid worker configuration")
        return cls(os.environ.get("VEIL_WORKER_TOKEN", ""),
                   os.environ.get("VEIL_BLOB_HOST", ""), timeout, memory)

    @property
    def configured(self):
        return bool(self.token and self.token.isascii()
                    and all(33 <= ord(c) <= 126 for c in self.token)
                    and len(self.token) <= 1024 and valid_host(self.blob_host))


class WorkerError(Exception):
    def __init__(self, status, message):
        self.status, self.message = status, message


class SubprocessEvaluator:
    """Process-group deadline covers DNS/download/MLIR/native computation together."""
    def __init__(self, child_script=None):
        self.child_script = child_script or Path(__file__).with_name("job.py")

    def __call__(self, root, payload, config):
        env = {"PATH": "/usr/local/bin:/usr/bin:/bin", "HOME": str(root),
               "TMPDIR": str(root), "OMP_NUM_THREADS": "1", "RAYON_NUM_THREADS": "1",
               "OPENBLAS_NUM_THREADS": "1", "MKL_NUM_THREADS": "1"}
        command = [sys.executable, "-I", str(self.child_script),
                   str(root), config.blob_host, str(config.timeout), str(config.memory_mb)]
        with subprocess.Popen(command, stdin=subprocess.PIPE, stdout=subprocess.DEVNULL,
                              stderr=subprocess.DEVNULL, cwd=root, env=env,
                              start_new_session=True, close_fds=True) as child:
            try:
                child.communicate(json.dumps(payload, separators=(",", ":")).encode(),
                                  timeout=config.timeout)
                if child.returncode:
                    stage = {10: "schema", 11: "download", 12: "profile", 13: "runtime_import",
                             14: "native_evaluation", 15: "process_setup"}.get(child.returncode, "native_exit")
                    print("Worker job failed stage=" + stage, file=sys.stderr, flush=True)
                    raise WorkerError(502, "Encrypted evaluation failed.")
            except subprocess.TimeoutExpired:
                print("Worker job failed stage=deadline", file=sys.stderr, flush=True)
                raise WorkerError(504, "Encrypted evaluation timed out.") from None
            finally:
                # Also kill any descendants after a normal exit before temp cleanup.
                try:
                    os.killpg(child.pid, signal.SIGKILL)
                except ProcessLookupError:
                    pass
                child.wait()


def read_regular(path, maximum):
    from engine.protocol import read_regular as read
    return read(path, maximum)


def collect_result(root, payload):
    from engine.protocol import canonical_json, verify_receipt
    receipt_bytes = read_regular(root / "receipt.json", MAX_RECEIPT)
    output = read_regular(root / "response.bin", MAX_OUTPUT)
    manifest_bytes = read_regular(root / "request.json", 8192)
    if hashlib.sha256(manifest_bytes).hexdigest() != payload["requestManifestSha256"]:
        raise ValueError("Invalid request digest")
    receipt, manifest = decode_json(receipt_bytes), decode_json(manifest_bytes)
    verify_receipt(manifest, manifest_bytes, receipt, output)
    if receipt_bytes != canonical_json(receipt):
        raise ValueError("Noncanonical receipt")
    return {"receipt": receipt,
            "receiptBase64": base64.b64encode(receipt_bytes).decode("ascii"),
            "outputBase64": base64.b64encode(output).decode("ascii"),
            "receiptSha256": hashlib.sha256(receipt_bytes).hexdigest(),
            "outputSha256": hashlib.sha256(output).hexdigest()}


class Application:
    def __init__(self, config, evaluator=None, temp_parent=None):
        self.config = config
        self.evaluator = evaluator or SubprocessEvaluator()
        self.temp_parent = temp_parent
        self.slot = threading.Lock()

    def authorize(self, headers):
        values = headers.get_all("Authorization", [])
        if (not self.config.configured or len(values) != 1
                or not hmac.compare_digest(values[0].encode("utf-8"),
                                           ("Bearer " + self.config.token).encode("utf-8"))):
            raise WorkerError(401, "Unauthorized.")

    def evaluate(self, data):
        payload = validate_payload(data, self.config.blob_host)
        # TemporaryDirectory uses mkdtemp 0700; every file uses explicit 0600.
        with tempfile.TemporaryDirectory(prefix="veil-job-", dir=self.temp_parent) as temporary:
            root = Path(temporary)
            os.chmod(root, 0o700)
            self.evaluator(root, payload, self.config)
            return collect_result(root, payload)


class Handler(BaseHTTPRequestHandler):
    server_version = "VeilWorker/" + VERSION
    sys_version = ""
    protocol_version = "HTTP/1.1"

    def setup(self):
        super().setup()
        self.connection.settimeout(10)

    def log_message(self, *_):
        # Base logs can include attacker-controlled paths or presigned URLs.
        pass

    def send_error(self, code, message=None, explain=None):
        self.reply(code, {"error": "Invalid HTTP request."})

    def reply(self, status, value):
        self.close_connection = True
        data = json.dumps(value, separators=(",", ":"), allow_nan=False).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(data)))
        self.send_header("Cache-Control", "no-store")
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("Connection", "close")
        self.end_headers()
        self.wfile.write(data)

    def handle_expect_100(self):
        # No 100-continue body upload before authentication/capacity checks.
        self.reply(417, {"error": "Expectation not supported."})
        return False

    def do_GET(self):
        if self.path != "/health":
            return self.reply(404, {"error": "Not found."})
        self.reply(200, {"version": VERSION, "configured": self.server.app.config.configured})

    def do_POST(self):
        if self.path != "/evaluate":
            return self.reply(404, {"error": "Not found."})
        app = self.server.app
        acquired = False
        try:
            app.authorize(self.headers)
            acquired = app.slot.acquire(blocking=False)
            if not acquired:
                raise WorkerError(503, "Worker busy.")
            if self.headers.get_all("Transfer-Encoding", []):
                raise WorkerError(400, "Invalid request framing.")
            lengths = self.headers.get_all("Content-Length", [])
            if len(lengths) != 1 or not re.fullmatch(r"[0-9]{1,8}", lengths[0]):
                raise WorkerError(400, "Content-Length required.")
            size = int(lengths[0])
            if size > BODY_LIMIT:
                raise WorkerError(413, "Payload too large.")
            types = self.headers.get_all("Content-Type", [])
            if len(types) != 1 or types[0].lower() not in ("application/json", "application/json; charset=utf-8"):
                raise WorkerError(415, "JSON required.")
            deadline = time.monotonic() + 10
            chunks, total = [], 0
            while total < size:
                left = deadline - time.monotonic()
                if left <= 0:
                    raise TimeoutError()
                self.connection.settimeout(left)
                chunk = self.rfile.read1(size - total)
                if not chunk:
                    raise InvalidRequest()
                total += len(chunk)
                chunks.append(chunk)
            data = b"".join(chunks)
            if len(data) != size:
                raise InvalidRequest()
            result = app.evaluate(data)
            self.reply(200, result)
        except WorkerError as exc:
            self.reply(exc.status, {"error": exc.message})
        except InvalidRequest:
            self.reply(400, {"error": "Invalid encrypted request."})
        except (TimeoutError, OSError):
            self.reply(502, {"error": "Encrypted evaluation failed."})
        except Exception:
            self.reply(502, {"error": "Encrypted evaluation failed."})
        finally:
            if acquired:
                app.slot.release()


class Server(ThreadingHTTPServer):
    daemon_threads = True
    request_queue_size = 16

    def __init__(self, address, app):
        self.app = app
        self.handlers = threading.BoundedSemaphore(32)
        super().__init__(address, Handler)

    def process_request(self, request, client_address):
        if not self.handlers.acquire(blocking=False):
            self.shutdown_request(request)
            return
        try:
            super().process_request(request, client_address)
        except BaseException:
            self.handlers.release()
            raise

    def process_request_thread(self, request, client_address):
        try:
            super().process_request_thread(request, client_address)
        finally:
            self.handlers.release()

    def handle_error(self, *_):
        # No tracebacks, tokens, URLs, input, native output or local paths in logs.
        pass


def main():
    os.umask(0o077)
    try:
        config = Config.from_env()
        port = int(os.environ.get("PORT", "8080"))
        if not 1 <= port <= 65535:
            raise ValueError()
        Server(("0.0.0.0", port), Application(config)).serve_forever()
    except Exception:
        sys.exit("Worker startup failed.")


if __name__ == "__main__":
    main()
