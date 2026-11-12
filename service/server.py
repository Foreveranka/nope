"""Local HTTP companion. Run from the repository: python -m service.server."""

import argparse
import copy
import importlib
import json
import math
import os
import re
import secrets
import socket
import threading
import uuid
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import urlsplit
from .demo import DemoRuns, DemoBusy
from .privacy_demo import PrivacyDemoRuns
from .csv_jobs import CsvJobs, CsvJobsError
from .csv_evidence import CsvEvidence
from .remote import RemoteClient
from .procurement_proxy import ProcurementProxy, ProxyError


ROOT = Path(__file__).resolve().parent.parent
MAX_BODY = 64 * 1024
MAX_ACTIVE = 8  # Running + waiting, not eight plus the running job.
MAX_JOBS = 64  # No eviction: a local restart explicitly clears the whole session.
MAX_TITLE = 120
STAGES = {
    "QUEUED": "Waiting for the local FHE worker.",
    "ENCRYPTING": "Preparing keys and encrypting in the local client companion.",
    "EVALUATING": "Evaluating encrypted records in the separate evaluator.",
    "VERIFYING": "Decrypting and checking the output in the local client companion.",
    "COMPLETED": "Local client verification succeeded.",
    "FAILED": "The local FHE job failed.",
}
ORDER = {stage: index for index, stage in enumerate(STAGES)}
STATIC = {
    "/gc-verify-worker.mjs": ("gc-verify-worker.mjs", "text/javascript; charset=utf-8"),
    "/csv-local": ("csv-local.html", "text/html; charset=utf-8"),
    "/csv-browser.js": ("csv-browser.js", "text/javascript; charset=utf-8"),
    "/csv-gc-worker.mjs": ("csv-gc-worker.mjs", "text/javascript; charset=utf-8"),
    "/gc-core.mjs": ("gc-core.mjs", "text/javascript; charset=utf-8"),
    "/gc-client.mjs": ("gc-client.mjs", "text/javascript; charset=utf-8"),
    "/verify": ("verify.html", "text/html; charset=utf-8"),
    "/verify.js": ("verify.js", "text/javascript; charset=utf-8"),
    "/try.css": ("try.css", "text/css; charset=utf-8"),
    "/csv": ("csv-local.html", "text/html; charset=utf-8"),
    "/csv.js": ("csv.js", "text/javascript; charset=utf-8"),
    "/csv.css": ("csv.css", "text/css; charset=utf-8"),
    "/csv-input.mjs": ("csv-input.mjs", "text/javascript; charset=utf-8"),
    "/privacy": ("privacy.html", "text/html; charset=utf-8"),
    "/privacy.js": ("privacy.js", "text/javascript; charset=utf-8"),
    "/privacy.css": ("privacy.css", "text/css; charset=utf-8"),
    "/market": ("market.html", "text/html; charset=utf-8"),
    "/market.js": ("market.js", "text/javascript; charset=utf-8"),
    "/market.css": ("market.css", "text/css; charset=utf-8"),
    "/sealed.mjs": ("sealed.mjs", "text/javascript; charset=utf-8"),
    "/": ("index.html", "text/html; charset=utf-8"),
    "/app": ("app.html", "text/html; charset=utf-8"),
    "/demo": ("demo.html", "text/html; charset=utf-8"),
    "/demo.js": ("demo.js", "text/javascript; charset=utf-8"),
    "/deployment.mjs": ("deployment.mjs", "text/javascript; charset=utf-8"),
    "/landing.js": ("landing.js", "text/javascript; charset=utf-8"),
    "/styles.css": ("styles.css", "text/css; charset=utf-8"),
    "/app.js": ("app.js", "text/javascript; charset=utf-8"),
    "/input.mjs": ("input.mjs", "text/javascript; charset=utf-8"),
}
CSP = (
    "default-src 'none'; script-src 'self'; style-src 'self'; "
    "img-src 'self'; font-src 'self'; connect-src 'self'; "
    "base-uri 'none'; object-src 'none'; frame-ancestors 'none'; form-action 'self'; worker-src 'self'"
)
JOB_PATH = re.compile(r"/api/jobs/([0-9a-f]{32})\Z")


def _now():
    return datetime.now(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")


class RequestError(Exception):
    def __init__(self, status, message):
        self.status = status
        self.message = message


def _unique_object(pairs):
    obj = {}
    for key, value in pairs:
        if key in obj:
            raise ValueError("Duplicate JSON field")
        obj[key] = value
    return obj


def _invalid_constant(value):
    raise ValueError("Non-finite JSON number")


def _validate_payload(payload):
    if not isinstance(payload, dict) or set(payload) != {"title", "records"}:
        raise RequestError(400, "Expected only title and records.")
    title = payload["title"]
    if not isinstance(title, str) or not 1 <= len(title.strip()) <= MAX_TITLE:
        raise RequestError(400, "Title must contain 1 to 120 characters.")
    if len(title) > MAX_TITLE or any(ord(c) < 32 or 127 <= ord(c) < 160 for c in title):
        raise RequestError(400, "Title is too long or contains control characters.")
    try:
        title.encode("utf-8")
    except UnicodeError:
        raise RequestError(400, "Title must be valid Unicode.") from None
    records = payload["records"]
    if not isinstance(records, list) or len(records) != 4:
        raise RequestError(400, "Exactly four records are required.")
    for record in records:
        if not isinstance(record, dict) or set(record) != {"id", "value"}:
            raise RequestError(400, "Each record must contain only id and value.")
        if any(type(record[key]) is not int or not 0 <= record[key] <= 255 for key in ("id", "value")):
            raise RequestError(400, "Record id and value must be integers from 0 to 255; booleans are invalid.")
    return title.strip(), records


def _safe_metadata(value):
    """Accept bounded JSON metadata only; never stringify arbitrary engine objects."""
    def validate(item, depth=0):
        if depth > 6:
            raise ValueError("Metadata nesting")
        if item is None or type(item) in (bool, int, str):
            return
        if type(item) is float and math.isfinite(item):
            return
        if type(item) is list:
            for child in item:
                validate(child, depth + 1)
            return
        if type(item) is dict and all(type(key) is str for key in item):
            for child in item.values():
                validate(child, depth + 1)
            return
        raise ValueError("Invalid metadata")

    if type(value) is not dict:
        raise ValueError("Expected metadata object")
    validate(value)
    if len(json.dumps(value, allow_nan=False).encode("utf-8")) > 16384:
        raise ValueError("Metadata too large")
    return copy.deepcopy(value)


def _validated_result(output):
    if type(output) is not dict or type(output.get("verified")) is not bool:
        raise ValueError("Invalid engine result")
    records = output.get("records")
    if type(records) is not list or len(records) != 4:
        raise ValueError("Invalid engine records")
    for record in records:
        if type(record) is not dict or set(record) != {"id", "value", "duplicate"}:
            raise ValueError("Invalid engine record")
        if type(record["duplicate"]) is not bool:
            raise ValueError("Invalid duplicate flag")
        if any(type(record[k]) is not int or not 0 <= record[k] <= 255 for k in ("id", "value")):
            raise ValueError("Invalid engine number")
    hashes = _safe_metadata(output.get("artifactHashes", {}))
    if any(type(v) is not str or re.fullmatch(r"[0-9a-fA-F]{64}", v) is None for v in hashes.values()):
        raise ValueError("Invalid artifact hash")
    return {
        "result": {"records": copy.deepcopy(records), "verified": output["verified"]},
        "metrics": _safe_metadata(output.get("metrics", {})),
        "artifactHashes": hashes,
    }


class JobState:
    """Process-local state. No input, title, result, exception, or SK is written to disk."""

    def __init__(self, runtime_dir, pipeline=None, remote_client=None):
        self.runtime_dir = Path(runtime_dir).resolve()
        self.pipeline = pipeline
        self.remote_client = remote_client
        self.remote_job_verified = False
        self.csrf_token = secrets.token_urlsafe(32)
        self.lock = threading.RLock()
        self.jobs = {}
        self.active = 0
        self.closed = False
        self.real_job_verified = False
        self.executor = ThreadPoolExecutor(max_workers=1, thread_name_prefix="local-fhe")

    def capabilities(self):
        with self.lock:
            status = "test-only" if self.pipeline is not None else (
                "available" if self.real_job_verified else "pending"
            )
        return {
            "version": "0.1.0",
            "profile": {"id": "clean-4-records-v1", "recordCount": 4},
            "csrfToken": self.csrf_token,
            "evaluationModes": {
                "default": "local", "local": {"status": status},
                "remote": {"status": ("test-only" if self.pipeline is not None else
                                      "available" if self.remote_job_verified else "configured")
                           if self.remote_client is not None else "disabled",
                           "detail": "Optional remote encrypted evaluation; plaintext, secret keys and final "
                                     "decryption stay in this local companion. Configuration is not a successful "
                                     "remote FHE test. No payments or MPC bidding are enabled."},
            },
            "capabilities": [
                {"id": "fhe", "label": "Local FHE companion", "status": status,
                 "detail": "Concrete Python via engine.pipeline.run_job, not browser-native FHE. "
                           "Runtime readiness requires a verified real job. Plaintext and secret keys "
                           "belong to this local client; same-UID processes are not isolated."
                           if self.pipeline is None else "Injected test pipeline; no real FHE claim."},
                {"id": "mpc", "label": "MPC integration", "status": "pending",
                 "detail": "Separate MPC component can be connected after integration and verification; "
                           "this service does not execute an MPC auction."},
                {"id": "near", "label": "NEAR registry integration", "status": "pending",
                 "detail": "Registry integration is pending; local FHE jobs do not submit NEAR transactions."},
                {"id": "payments", "label": "Payments", "status": "disabled",
                 "detail": "No live payments, funds custody, or payment execution."},
            ],
        }

    def list_jobs(self):
        with self.lock:
            return copy.deepcopy(list(reversed(list(self.jobs.values()))))

    def get_job(self, job_id):
        with self.lock:
            if job_id not in self.jobs:
                raise RequestError(404, "Job not found.")
            return copy.deepcopy(self.jobs[job_id])

    def submit(self, title, records, evaluation="local"):
        with self.lock:
            if evaluation not in ("local", "remote"):
                raise RequestError(400, "Unknown evaluation mode.")
            if evaluation == "remote" and self.remote_client is None:
                raise RequestError(503, "Remote encrypted evaluation is not configured in the local companion.")
            if self.closed:
                raise RequestError(503, "Local worker is shutting down.")
            if self.active >= MAX_ACTIVE:
                raise RequestError(429, "Local job queue is full; wait for a job to finish.")
            if len(self.jobs) >= MAX_JOBS:
                raise RequestError(429, "Session job limit (64) reached; restart the companion to clear local history.")
            job_id = uuid.uuid4().hex
            now = _now()
            job = {"id": job_id, "title": title, "evaluation": evaluation, "status": "QUEUED", "createdAt": now,
                   "updatedAt": now, "events": [{"stage": "QUEUED", "at": now, "message": STAGES["QUEUED"]}]}
            self.jobs[job_id] = job
            self.active += 1
            try:
                self.executor.submit(self._run, job_id, copy.deepcopy(records), evaluation)
            except RuntimeError:
                self.active -= 1
                del self.jobs[job_id]
                raise RequestError(503, "Local worker is unavailable.") from None
            return copy.deepcopy(job)

    def _stage(self, job_id, stage, message=None):
        # Pipeline messages can contain plaintext or exceptions. Use fixed safe text.
        if stage not in ("ENCRYPTING", "EVALUATING", "VERIFYING"):
            return
        with self.lock:
            if ORDER[stage] > ORDER[self.jobs[job_id]["status"]]:
                self._event(job_id, stage)

    def _event(self, job_id, stage):
        job = self.jobs[job_id]
        job["status"] = stage
        job["updatedAt"] = _now()
        message = STAGES[stage]
        if job.get("evaluation") == "remote":
            message = {
                "EVALUATING": "Remote evaluator is computing on encrypted records only.",
                "COMPLETED": "Remote encrypted evaluation completed; local client verification succeeded.",
                "FAILED": "Remote encrypted evaluation failed or its outcome is unknown; no automatic resubmission.",
            }.get(stage, message)
        job["events"].append({"stage": stage, "at": job["updatedAt"], "message": message})

    def _run(self, job_id, records, evaluation="local"):
        try:
            # Import in the sole worker thread; HTTP startup never imports Concrete.
            pipeline = self.pipeline
            if evaluation == "remote":
                engine = importlib.import_module("engine.pipeline")
                def pipeline(records, job_dir, on_stage=None):
                    with engine.prepare_remote_job(records, job_dir, on_stage=on_stage) as prepared:
                        prepared.evaluate_remote(self.remote_client.evaluate)
                        return prepared.finalize()
            elif pipeline is None:
                pipeline = importlib.import_module("engine.pipeline").run_job
            job_dir = self.runtime_dir / job_id
            self.runtime_dir.mkdir(mode=0o700, parents=True, exist_ok=True)
            job_dir.mkdir(mode=0o700)
            output = pipeline(records, job_dir, on_stage=lambda stage, message=None: self._stage(job_id, stage, message))
            validated = _validated_result(output)
            with self.lock:
                if not validated["result"]["verified"]:
                    self.jobs[job_id]["error"] = "Local client verification failed."
                    self._event(job_id, "FAILED")
                else:
                    self.jobs[job_id].update(validated)
                    self._event(job_id, "COMPLETED")
                    if self.pipeline is None:
                        if evaluation == "remote":
                            self.remote_job_verified = True
                        else:
                            self.real_job_verified = True
        except Exception:
            # Never store/log str(exc), traceback, input records, or key material.
            with self.lock:
                self.jobs[job_id]["error"] = (
                    "Remote encrypted evaluation failed or its outcome is unknown; no automatic resubmission."
                    if evaluation == "remote" else
                    "Local FHE job failed; check the local engine configuration and retry.")
                self._event(job_id, "FAILED")
        finally:
            records.clear()
            with self.lock:
                self.active -= 1

    def close(self):
        with self.lock:
            self.closed = True
        # Drain the bounded queue. No work is silently canceled midway through FHE.
        self.executor.shutdown(wait=True)


class CompanionServer(ThreadingHTTPServer):
    daemon_threads = True

    def __init__(self, address, state):
        self.state = state
        self.csv_jobs = CsvJobs(state.runtime_dir, pipeline=state.pipeline, remote_client=state.remote_client)
        self.csv_evidence = CsvEvidence(self.csv_jobs, enabled=os.environ.get("NOPE_ENABLE_CSV_ANCHOR")=="1" and state.pipeline is None)
        self.procurement_proxy = ProcurementProxy()
        self.procurement_mount = None
        self.procurement_lock = threading.Lock()
        super().__init__(address, CompanionHandler)
        self.demo = DemoRuns(state.runtime_dir, enabled=state.pipeline is None and state.remote_client is None)
        self.privacy_demo = PrivacyDemoRuns(state.runtime_dir, enabled=(os.environ.get("NOPE_ENABLE_PRIVACY_DEMO") == "1" and state.pipeline is None and state.remote_client is None))
        self.expected_host = "127.0.0.1:{}".format(self.server_address[1])
        self.origin = "http://" + self.expected_host
        self.web_dir = ROOT / "web"

    def get_request(self):
        connection, address = super().get_request()
        connection.settimeout(10)
        return connection, address

    def server_close(self):
        super().server_close()
        self.demo.close()
        self.privacy_demo.close()
        self.csv_jobs.close()
        if self.procurement_mount is not None:
            self.procurement_mount.close()
        self.state.close()

    def handle_error(self, request, client_address):
        # The default traceback logger may include sensitive exception details.
        pass


class CompanionHandler(BaseHTTPRequestHandler):
    server_version = "VeilLocal/0.1"
    sys_version = ""

    def log_message(self, format, *args):
        # Request targets can contain user data. No access logs.
        pass

    def _header(self, name):
        values = self.headers.get_all(name, [])
        if len(values) > 1:
            raise RequestError(400, "Duplicate security or framing header.")
        return values[0] if values else None

    def _check_origin(self, path, mutation=False):
        if self._header("Host") != self.server.expected_host:
            raise RequestError(403, "Host is not the local companion address.")
        origin = self._header("Origin")
        if origin is not None and origin != self.server.origin:
            raise RequestError(403, "Cross-origin requests are forbidden.")
        site = self._header("Sec-Fetch-Site")
        if site is not None and site not in ("same-origin", "none"):
            # A browser/extension can enter the public site from another origin.
            # Permit only HTML document navigation, never iframe/embed, assets,
            # sensitive API reads, or requests carrying a foreign Origin.
            public_navigation = (
                self.command in ("GET", "HEAD") and path in ("/", "/csv", "/csv-local", "/app", "/demo", "/privacy", "/market")
                and site in ("cross-site", "same-site")
                and self._header("Sec-Fetch-Mode") == "navigate"
                and self._header("Sec-Fetch-Dest") == "document"
            )
            if not public_navigation:
                raise RequestError(403, "Cross-origin requests are forbidden.")
        if mutation:
            if origin != self.server.origin:
                raise RequestError(403, "Mutations require the exact local Origin.")
            token = self._header("X-CSRF-Token")
            if token is None or not secrets.compare_digest(token.encode("utf-8"), self.server.state.csrf_token.encode("ascii")):
                raise RequestError(403, "A valid CSRF token is required.")

    def _path(self):
        if len(self.path) > 2048:
            raise RequestError(414, "Request target too long.")
        if not self.path.startswith("/") or self.path.startswith("//") or "#" in self.path:
            raise RequestError(400, "Invalid request target.")
        return urlsplit(self.path).path

    def _send(self, status, body, content_type="application/json; charset=utf-8"):
        self.close_connection = True
        self.send_response(status)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.send_header("Content-Security-Policy", CSP)
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("X-Frame-Options", "DENY")
        self.send_header("Cross-Origin-Resource-Policy", "same-origin")
        self.send_header("Cross-Origin-Opener-Policy", "same-origin")
        self.send_header("Referrer-Policy", "no-referrer")
        self.send_header("Connection", "close")
        if status == 429:
            self.send_header("Retry-After", "2")
        self.end_headers()
        if self.command != "HEAD":
            self.wfile.write(body)

    def _json(self, status, payload):
        self._send(status, json.dumps(payload, ensure_ascii=True, allow_nan=False).encode("utf-8"))

    def send_error(self, code, message=None, explain=None):
        # Also replace BaseHTTPRequestHandler's reflective HTML parser errors.
        self._json(code, {"error": "HTTP request rejected."})

    def handle_expect_100(self):
        self._json(417, {"error": "Expect is not supported."})
        return False

    def _body(self):
        if self._header("Transfer-Encoding") is not None or self._header("Content-Encoding") is not None:
            raise RequestError(400, "Encoded request bodies are not supported.")
        length = self._header("Content-Length")
        if length is None:
            raise RequestError(411, "Content-Length is required.")
        if re.fullmatch(r"[0-9]{1,10}", length) is None:
            raise RequestError(400, "Invalid Content-Length.")
        size = int(length)
        if size > MAX_BODY:
            raise RequestError(413, "Request body exceeds 64 KiB.")
        content_type = self._header("Content-Type") or ""
        if re.fullmatch(r'application/json(?:\s*;\s*charset=(?:utf-8|"utf-8"))?', content_type, re.IGNORECASE) is None:
            raise RequestError(415, "Content-Type must be application/json with UTF-8 encoding.")
        body = self.rfile.read(size)
        if len(body) != size:
            raise RequestError(400, "Incomplete request body.")
        try:
            return json.loads(body.decode("utf-8"), object_pairs_hook=_unique_object, parse_constant=_invalid_constant)
        except (ValueError, UnicodeError, RecursionError):
            raise RequestError(400, "Invalid JSON body.") from None

    def _dispatch(self):
        try:
            path = self._path()
            self._check_origin(path, mutation=self.command not in ("GET", "HEAD"))
            if self._header("Expect") is not None:
                raise RequestError(417, "Expect is not supported.")
            if path == "/api/csv-evidence" and self.command == "GET":
                from urllib.parse import parse_qs
                from urllib.request import urlopen
                query=parse_qs(urlsplit(self.path).query, keep_blank_values=True)
                if set(query)!={"hash"} or len(query["hash"])!=1 or not re.fullmatch(r"[0-9a-f]{64}",query["hash"][0]):
                    raise RequestError(400,"One SHA-256 hash required.")
                try:
                    with urlopen("https://veil-procurement.vercel.app/api/csv-evidence?hash="+query["hash"][0],timeout=20) as response:
                        raw=response.read(16385)
                    if len(raw)>16384:raise ValueError()
                    self._json(200,json.loads(raw))
                except Exception:
                    raise RequestError(503,"Testnet verification unavailable.")
                return
            if path == "/api/csv/jobs" and self.command == "POST":
                payload = self._body()
                if type(payload) is not dict or set(payload) != {"values", "mode"}:
                    raise RequestError(400, "Expected only values and mode.")
                try:
                    self._json(201, self.server.csv_jobs.start(payload["values"], payload["mode"]))
                except CsvJobsError as exc:
                    raise RequestError(exc.status, exc.message)
                except ValueError:
                    raise RequestError(400, "Invalid CSV column or unavailable evaluation mode.")
                except RuntimeError:
                    raise RequestError(409, "CSV worker is busy or session capacity reached.")
                return
            proof_match = re.fullmatch(r"/api/csv/jobs/([0-9a-f]{32})/(evidence|anchor)", path)
            if proof_match:
                job_id, action = proof_match.groups()
                try:
                    if action == "evidence" and self.command == "GET":
                        self._json(200, self.server.csv_evidence.bundle(job_id))
                    elif action == "anchor" and self.command == "POST":
                        if self._body() != {}: raise RequestError(400, "Anchor accepts no user fields.")
                        self._json(200, self.server.csv_evidence.anchor(job_id))
                    else: raise RequestError(405, "Method not allowed.")
                except PermissionError:
                    raise RequestError(403, "Testnet anchoring is not enabled in this client.")
                except (ValueError, CsvJobsError):
                    raise RequestError(409, "Verified ciphertext evidence is not available.")
                return
            if path.startswith("/api/csv/jobs/") and self.command == "GET":
                job_id = path.rsplit("/", 1)[-1]
                if not re.fullmatch(r"[0-9a-f]{32}", job_id):
                    raise RequestError(404, "CSV job not found.")
                try:
                    self._json(200, self.server.csv_jobs.snapshot(job_id))
                except (KeyError, CsvJobsError):
                    raise RequestError(404, "CSV job not found.")
                return
            if path.startswith("/api/private-procurement/") and self.command == "POST":
                from .procurement_mount import ProcurementMount
                from .procurement_client import ProcurementClientError
                from .bid_client import BidClientError
                try:
                    with self.server.procurement_lock:
                        if self.server.procurement_mount is None:
                            self.server.procurement_mount = ProcurementMount(self.server.state.runtime_dir, self.server.procurement_proxy)
                    data = self.server.procurement_mount.request(path.rsplit("/", 1)[-1], self._body(), self._header("Authorization"))
                    self._json(200, data)
                except (ProcurementClientError, BidClientError) as exc:
                    self._json(409, {"error": exc.code, "code": exc.code})
                return
            if path.startswith("/api/procurement/") and self.command in ("GET", "POST"):
                try:
                    status, data = self.server.procurement_proxy.request(
                        self.command, self.path, self._header("Authorization"),
                        self._body() if self.command == "POST" else None,
                        self._header("Idempotency-Key"))
                    self._json(status, data)
                except ProxyError:
                    self._json(503, {"error": "Procurement transport unavailable or request rejected.", "code": "LOCAL_PROXY_REJECTED"})
                return
            if self.command in ("GET", "HEAD"):
                if path == "/health":
                    self._json(200, {"ok": True})
                elif path == "/api/capabilities":
                    self._json(200, dict(self.server.state.capabilities(), csvAnchorEnabled=self.server.csv_evidence.enabled))
                elif path == "/api/jobs":
                    self._json(200, {"jobs": self.server.state.list_jobs()})
                elif path == "/api/privacy-demo":
                    self._json(200, self.server.privacy_demo.snapshot())
                elif path == "/api/demo":
                    self._json(200, {"run": self.server.demo.snapshot()})
                elif JOB_PATH.fullmatch(path):
                    self._json(200, {"job": self.server.state.get_job(JOB_PATH.fullmatch(path).group(1))})
                elif path in STATIC:
                    filename, content_type = STATIC[path]
                    file = self.server.web_dir / filename
                    if file.is_symlink() or not file.is_file() or file.resolve().parent != self.server.web_dir.resolve():
                        raise RequestError(404, "Static file not found.")
                    self._send(200, file.read_bytes(), content_type)
                else:
                    raise RequestError(404, "Not found.")
            elif self.command == "POST" and path == "/api/privacy-demo":
                if self._body() != {}:
                    raise RequestError(400, "Demo accepts only fixed synthetic inputs.")
                try:
                    self._json(201, self.server.privacy_demo.start())
                except DemoBusy as exc:
                    raise RequestError(409, str(exc))
            elif self.command == "POST" and path == "/api/demo":
                if self._body() != {}:
                    raise RequestError(400, "Demo accepts only an empty object; inputs are synthetic and fixed.")
                try:
                    self._json(201, {"run": self.server.demo.start()})
                except DemoBusy as exc:
                    raise RequestError(409, str(exc))
            elif self.command == "POST" and path == "/api/jobs":
                payload = self._body()
                evaluation = "local"
                if isinstance(payload, dict) and "evaluation" in payload:
                    evaluation = payload.pop("evaluation")
                    if not isinstance(evaluation, str) or evaluation not in ("local", "remote"):
                        raise RequestError(400, "Unknown evaluation mode.")
                title, records = _validate_payload(payload)
                self._json(201, {"job": self.server.state.submit(title, records, evaluation)})
            elif self.command == "POST":
                raise RequestError(404, "Not found.")
            else:
                raise RequestError(405, "Method not allowed.")
        except RequestError as exc:
            self._json(exc.status, {"error": exc.message})
        except (BrokenPipeError, ConnectionResetError):
            pass
        except (TimeoutError, socket.timeout):
            self._json(408, {"error": "Request timed out."})
        except Exception:
            self._json(500, {"error": "Local request failed."})

    do_GET = _dispatch
    do_HEAD = _dispatch
    do_POST = _dispatch
    do_PUT = _dispatch
    do_PATCH = _dispatch
    do_DELETE = _dispatch
    do_OPTIONS = _dispatch
    do_TRACE = _dispatch
    do_CONNECT = _dispatch


def create_server(host="127.0.0.1", port=8765, runtime_dir=None, pipeline=None, remote_client=None):
    """Return a bound server with .state and .origin; port=0 selects a test port.

    pipeline, when supplied, is a trusted test callable matching run_job. Production
    imports engine.pipeline.run_job inside its sole worker thread.
    """
    if host != "127.0.0.1":
        raise ValueError("The local companion must bind to 127.0.0.1 exactly.")
    if type(port) is not int or not 0 <= port <= 65535:
        raise ValueError("Port must be an integer from 0 to 65535.")
    if pipeline is not None and not callable(pipeline):
        raise TypeError("pipeline must be callable")
    runtime_dir = ROOT / "runtime" if runtime_dir is None else runtime_dir
    if remote_client is None:
        remote_client = RemoteClient.from_env(runtime_dir)
    state = JobState(runtime_dir, pipeline, remote_client)
    try:
        return CompanionServer((host, port), state)
    except Exception:
        state.close()
        raise


def main():
    parser = argparse.ArgumentParser(description="Loopback-only NOPE local client companion")
    parser.add_argument("--port", type=int, default=8765)
    parser.add_argument("--runtime-dir", type=Path, default=ROOT / "runtime")
    args = parser.parse_args()
    server = create_server(port=args.port, runtime_dir=args.runtime_dir)
    print("NOPE local client companion: {} (mainnet disabled)".format(server.origin), flush=True)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()


if __name__ == "__main__":
    main()
