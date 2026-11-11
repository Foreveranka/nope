"""Customer-side encrypted transport. Network tests use doubles, not FHE claims.

No cookies, proxies, redirects, POST retries, browser credentials or secret logs.
Only ciphertext, evaluation keys and their manifests leave this process.
"""
import base64
import hashlib
import http.client
import io
import json
import os
import re
import ssl
import threading
import time
from collections.abc import Mapping
from pathlib import Path
from urllib.parse import parse_qsl, urlsplit

DEFAULT_CLOUD_URL = "https://veil-procurement.vercel.app"
LIMITS = {"request.json": 8192, "request.bin": 2097152,
          "evaluation.keys": 536870912, "binding.json": 8192}
CONTENT_TYPES = {"request.json": "application/json", "binding.json": "application/json",
                 "request.bin": "application/octet-stream", "evaluation.keys": "application/octet-stream"}
ID = re.compile(r"[0-9a-f]{32}\Z")
HEX = re.compile(r"[0-9a-f]{64}\Z")
MAX_REPLY = 4 * 1024 * 1024
# @vercel/blob 2.9 builds single-object presigned PUTs on this exact control
# plane route (buildPresignedPutUrl), not on its private object GET host.
PUT_REQUIRED_QUERY = {"pathname", "vercel-blob-maximum-size-in-bytes",
                      "vercel-blob-delegation", "vercel-blob-signature"}
PUT_OPTIONAL_QUERY = {"vercel-blob-allowed-content-types", "vercel-blob-allow-overwrite",
                      "vercel-blob-add-random-suffix", "vercel-blob-ttl-days",
                      "vercel-blob-valid-until"}


class RemoteError(Exception):
    def __init__(self):
        super().__init__("Remote encrypted evaluation failed or its outcome is unknown; do not resubmit this job.")


def _hash(data):
    return hashlib.sha256(data).hexdigest()


def _unique(pairs):
    result = {}
    for key, value in pairs:
        if key in result:
            raise RemoteError()
        result[key] = value
    return result


def _json(data):
    return json.loads(data.decode("utf-8"), object_pairs_hook=_unique,
                      parse_constant=lambda _: (_ for _ in ()).throw(RemoteError()))


def _url(value, *, blob=False, base=False):
    if (not isinstance(value, str) or not value.isascii() or len(value) > 16384
            or any(ord(c) <= 32 or ord(c) == 127 for c in value)
            or "\\" in value or "#" in value):
        raise RemoteError()
    parsed = urlsplit(value)
    host = parsed.hostname or ""
    if (parsed.scheme != "https" or parsed.username is not None or parsed.password is not None
            or parsed.port not in (None, 443)
            or not re.fullmatch(r"(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,63}", host)
            or parsed.netloc not in (host, host + ":443")):
        raise RemoteError()
    if blob:
        if host != "vercel.com" or parsed.path != "/api/blob/":
            raise RemoteError()
        query = _put_query(parsed)
        if (not re.fullmatch(r"[1-9][0-9]{0,8}", query["vercel-blob-maximum-size-in-bytes"])
                or int(query["vercel-blob-maximum-size-in-bytes"]) > LIMITS["evaluation.keys"]
                or not re.fullmatch(r"veil-v1/[a-z0-9-]{1,48}/[0-9a-f]{32}/(?:request\.json|request\.bin|evaluation\.keys|binding\.json)", query["pathname"])):
            raise RemoteError()
        content_type = CONTENT_TYPES[query["pathname"].rsplit("/", 1)[-1]]
        if query.get("vercel-blob-allowed-content-types", content_type) != content_type:
            raise RemoteError()
        for key in ("vercel-blob-allow-overwrite", "vercel-blob-add-random-suffix"):
            if query.get(key, "false") != "false":
                raise RemoteError()
        if "vercel-blob-ttl-days" in query and query["vercel-blob-ttl-days"] != "1":
            raise RemoteError()
        if "vercel-blob-valid-until" in query and not re.fullmatch(r"[1-9][0-9]{0,15}", query["vercel-blob-valid-until"]):
            raise RemoteError()
    if base and (parsed.path not in ("", "/") or parsed.query):
        raise RemoteError()
    return parsed


def _put_query(parsed):
    # Validate only; never reconstruct/normalize the signed request target.
    if re.search(r"%(?![0-9a-fA-F]{2})", parsed.query):
        raise RemoteError()
    pairs = parse_qsl(parsed.query, keep_blank_values=True, strict_parsing=True,
                      max_num_fields=len(PUT_REQUIRED_QUERY | PUT_OPTIONAL_QUERY),
                      encoding="utf-8", errors="strict")
    query = dict(pairs)
    if (len(query) != len(pairs) or not PUT_REQUIRED_QUERY <= set(query)
            or set(query) - (PUT_REQUIRED_QUERY | PUT_OPTIONAL_QUERY)
            or any(not value or any(ord(c) < 32 or ord(c) == 127 for c in value)
                   for value in query.values())):
        raise RemoteError()
    return query


class RemoteClient:
    """One-shot gateway client; supplied connection factory is test-only."""

    def __init__(self, url, token, runtime_dir, *, connection_factory=None):
        try:
            _url(url, base=True)
            if not isinstance(token, str) or not re.fullmatch(r"[A-Za-z0-9_-]{43,128}", token):
                raise RemoteError()
        except Exception:
            raise RemoteError() from None
        self._url = url.rstrip("/")
        self._token = token
        self._runtime = Path(runtime_dir)
        self._connect = connection_factory or http.client.HTTPSConnection
        self._lock = threading.Lock()
        self._used = set()

    @classmethod
    def from_env(cls, runtime_dir):
        token = os.environ.get("VEIL_CUSTOMER_TOKEN", "")
        if not token:
            return None
        return cls(os.environ.get("VEIL_CLOUD_URL", DEFAULT_CLOUD_URL), token, runtime_dir)

    def _request(self, method, target, deadline, *, payload=None, upload=None, size=None):
        """Direct verified HTTPS. Response bodies/errors and URLs never escape."""
        connection = None
        try:
            parsed = _url(target, blob=upload is not None)
            if upload is not None and (method != "PUT" or
                    int(_put_query(parsed)["vercel-blob-maximum-size-in-bytes"]) != size):
                raise RemoteError()
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                raise RemoteError()
            connection = self._connect(parsed.hostname, port=443, timeout=min(260, remaining),
                                       context=ssl.create_default_context())
            headers = {"Accept-Encoding": "identity", "Connection": "close"}
            if upload is None:
                if parsed.netloc != _url(self._url).netloc:
                    raise RemoteError()
                headers["Authorization"] = "Bearer " + self._token
                if payload is not None:
                    payload = json.dumps(payload, separators=(",", ":")).encode("utf-8")
                    headers["Content-Type"] = "application/json"
            else:
                filename = _put_query(parsed)["pathname"].rsplit("/", 1)[-1]
                headers.update({"Content-Type": CONTENT_TYPES[filename], "Content-Length": str(size)})
            path = (parsed.path or "/") + (("?" + parsed.query) if parsed.query else "")
            if upload is None:
                connection.request(method, path, body=payload, headers=headers)
            else:
                connection.putrequest(method, path)
                for key, value in headers.items():
                    connection.putheader(key, value)
                connection.endheaders()
                sent = 0
                while True:
                    block = upload.read(65536)
                    if not block:
                        break
                    sent += len(block)
                    if sent > size or time.monotonic() >= deadline:
                        raise RemoteError()
                    if connection.sock is not None:
                        connection.sock.settimeout(min(30, deadline - time.monotonic()))
                    connection.send(block)
                if sent != size:
                    raise RemoteError()
            response = connection.getresponse()
            # All redirects and non-success bodies are discarded without reflection.
            if response.status == 404 and method == "GET" and upload is None:
                return 404, None
            if not 200 <= response.status < 300:
                raise RemoteError()
            if upload is not None:
                return response.status, None
            if response.getheader("Content-Encoding", "identity").lower() != "identity":
                raise RemoteError()
            data = bytearray()
            while True:
                remaining = deadline - time.monotonic()
                if remaining <= 0:
                    raise RemoteError()
                if connection.sock is not None:
                    connection.sock.settimeout(min(30, remaining))
                block = response.read1(min(65536, MAX_REPLY + 1 - len(data)))
                if not block:
                    break
                data.extend(block)
                if len(data) > MAX_REPLY:
                    raise RemoteError()
            return response.status, _json(bytes(data))
        except Exception:
            raise RemoteError() from None
        finally:
            if connection is not None:
                connection.close()

    def _api(self, method, path, deadline, payload=None):
        return self._request(method, self._url + "/api/cloud/" + path, deadline, payload=payload)

    def _reserve(self, deadline):
        # Persist only public ID fingerprints, BEFORE any mutation. A timeout or
        # restart cannot cause this companion to reuse an uncertain allocation.
        with self._lock:
            _, session = self._api("GET", "session", deadline)
            ids = session.get("jobIds") if isinstance(session, dict) else None
            if (not isinstance(ids, list) or not 0 < len(ids) <= 50
                    or any(not isinstance(i, str) or not ID.fullmatch(i) for i in ids)
                    or len(set(ids)) != len(ids)):
                raise RemoteError()
            self._runtime.mkdir(mode=0o700, parents=True, exist_ok=True)
            path = self._runtime / "remote-used-jobs.jsonl"
            descriptor = os.open(path, os.O_RDWR | os.O_APPEND | os.O_CREAT | os.O_NOFOLLOW, 0o600)
            with os.fdopen(descriptor, "r+", encoding="ascii") as ledger:
                # Multiple local companion processes share the same consumption fence.
                import fcntl
                fcntl.flock(ledger, fcntl.LOCK_EX)
                ledger.seek(0)
                self._used.update(line.strip() for line in ledger)
                for job_id in ids:
                    fingerprint = _hash((self._url + "/" + job_id).encode("ascii"))
                    if fingerprint in self._used:
                        continue
                    status, _ = self._api("GET", "jobs/" + job_id, deadline)
                    if status != 404:
                        continue
                    self._used.add(fingerprint)
                    ledger.seek(0, os.SEEK_END)
                    ledger.write(fingerprint + "\n")
                    ledger.flush()
                    os.fsync(ledger.fileno())
                    return job_id
        raise RemoteError()

    def evaluate(self, files):
        """Engine callback: immutable public file bytes -> exact response file bytes."""
        try:
            return self._evaluate(files)
        except Exception:
            raise RemoteError() from None

    def _evaluate(self, files):
        if not isinstance(files, Mapping):
            raise RemoteError()
        names = set(files)
        per_job = names - {"server.zip", "client-specs.json"}
        if per_job not in (set(LIMITS) - {"binding.json"}, set(LIMITS)):
            raise RemoteError()
        if names - per_job not in (set(), {"server.zip", "client-specs.json"}):
            raise RemoteError()
        for name in per_job:
            if type(files[name]) is not bytes or not 0 < len(files[name]) <= LIMITS[name]:
                raise RemoteError()
        manifest_bytes = files["request.json"]
        manifest = _json(manifest_bytes)
        # Validates the actual engine's pinned circuit/spec profile before network I/O.
        from engine.protocol import (canonical_json, manifest_artifact_set, validate_manifest,
                                     verify_external_binding, verify_receipt)
        validate_manifest(manifest)
        if manifest_artifact_set(manifest) != "portable-v1":
            raise RemoteError()
        if manifest["protocolVersion"] != (2 if "binding.json" in per_job else 1):
            raise RemoteError()
        if (_hash(files["request.bin"]) != manifest["inputSha256"]
                or _hash(files["evaluation.keys"]) != manifest["evaluationKeysSha256"]):
            raise RemoteError()
        if "binding.json" in per_job:
            verify_external_binding(manifest, files["binding.json"])
        for name, key in (("server.zip", "serverSha256"), ("client-specs.json", "clientSpecsSha256")):
            if name in files and (type(files[name]) is not bytes or _hash(files[name]) != manifest[key]):
                raise RemoteError()
        descriptors = [{"name": name, "size": len(files[name]), "sha256": _hash(files[name])}
                       for name in sorted(per_job)]
        deadline = time.monotonic() + 480
        job_id = self._reserve(deadline)
        _, created = self._api("POST", "jobs", deadline,
                               {"jobId": job_id, "files": descriptors, "requestManifestSha256": _hash(manifest_bytes)})
        if not isinstance(created, dict) or created.get("jobId") != job_id:
            raise RemoteError()
        uploads = created.get("uploads")
        if not isinstance(uploads, list) or len(uploads) != len(descriptors):
            raise RemoteError()
        by_name = {descriptor["name"]: descriptor for descriptor in descriptors}
        seen = set()
        # Validate the ENTIRE upload plan before sending any encrypted artifact.
        for upload in uploads:
            if not isinstance(upload, dict) or set(upload) != {"name", "size", "sha256", "url"}:
                raise RemoteError()
            name = upload["name"]
            if (not isinstance(name, str) or name not in by_name or name in seen
                    or type(upload["size"]) is not int
                    or {k: upload[k] for k in ("name", "size", "sha256")} != by_name[name]):
                raise RemoteError()
            parsed = _url(upload["url"], blob=True)
            query = _put_query(parsed)
            if (not query["pathname"].endswith("/" + job_id + "/" + name)
                    or int(query["vercel-blob-maximum-size-in-bytes"]) != upload["size"]):
                raise RemoteError()
            seen.add(name)
        for upload in uploads:
            with io.BytesIO(files[upload["name"]]) as stream:
                self._request("PUT", upload["url"], deadline, upload=stream, size=upload["size"])
        _, evaluated = self._api("POST", "jobs/" + job_id + "/evaluate", deadline, {})
        if (not isinstance(evaluated, dict) or evaluated.get("status") != "COMPLETED"
                or evaluated.get("jobId") != job_id):
            raise RemoteError()
        _, result = self._api("GET", "jobs/" + job_id + "/result", deadline)
        if not isinstance(result, dict) or set(result) != {"receipt", "receiptBase64", "receiptSha256", "outputBase64", "outputSha256"}:
            raise RemoteError()
        decoded = {}
        for prefix, limit in (("receipt", 16384), ("output", LIMITS["request.bin"])):
            encoded, digest = result[prefix + "Base64"], result[prefix + "Sha256"]
            if (not isinstance(encoded, str) or len(encoded) > 4 * ((limit + 2) // 3)
                    or not isinstance(digest, str) or not HEX.fullmatch(digest)):
                raise RemoteError()
            data = base64.b64decode(encoded, validate=True)
            if not 0 < len(data) <= limit or _hash(data) != digest:
                raise RemoteError()
            decoded[prefix] = data
        receipt = _json(decoded["receipt"])
        if (canonical_json(receipt) != canonical_json(result["receipt"])
                or not isinstance(receipt, dict)
                or canonical_json(receipt.get("request")) != canonical_json(manifest)):
            raise RemoteError()
        verify_receipt(manifest, manifest_bytes, receipt, decoded["output"])
        # NEVER reserialize receipt: whitespace/order are part of its pinned hash.
        return {"response.bin": decoded["output"], "receipt.json": decoded["receipt"]}
