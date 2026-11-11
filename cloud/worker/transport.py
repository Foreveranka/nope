"""Strict request schema and direct, DNS-pinned HTTPS downloads (stdlib only)."""
import hashlib
import http.client
import ipaddress
import json
import os
import re
import socket
import ssl
import time
from urllib.parse import urlsplit

BODY_LIMIT = 32 * 1024
FILE_LIMITS = {"request.bin": 2 * 1024 * 1024,
               "evaluation.keys": 512 * 1024 * 1024,
               "request.json": 8192, "binding.json": 8192}
DIGEST = re.compile(r"[0-9a-f]{64}\Z")
HOST = re.compile(r"(?=.{1,253}\Z)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+"
                  r"[a-z](?:[a-z0-9-]{0,61}[a-z0-9])?\Z")


class InvalidRequest(Exception):
    pass


class DownloadError(Exception):
    pass


def unique_object(pairs):
    result = {}
    for key, value in pairs:
        if key in result:
            raise InvalidRequest()
        result[key] = value
    return result


def decode_json(data):
    try:
        return json.loads(data.decode("utf-8"), object_pairs_hook=unique_object,
                          parse_constant=lambda _: (_ for _ in ()).throw(InvalidRequest()))
    except (ValueError, UnicodeError, RecursionError):
        raise InvalidRequest() from None


def valid_host(host):
    # Require a DNS hostname, not wildcard, IP literal, port, URL, trailing dot or IDN.
    return isinstance(host, str) and bool(HOST.fullmatch(host))


def validate_url(url, host):
    if (not valid_host(host) or not isinstance(url, str) or len(url) > 8192
            or not url.isascii() or any(ord(c) <= 32 or ord(c) == 127 for c in url)
            or "\\" in url or "#" in url):
        raise InvalidRequest()
    try:
        parsed = urlsplit(url)
        if (parsed.scheme != "https" or parsed.hostname != host
                or parsed.username is not None or parsed.password is not None
                or parsed.port not in (None, 443)
                or parsed.netloc not in (host, host + ":443")
                or not parsed.path.startswith("/")):
            raise InvalidRequest()
    except ValueError:
        raise InvalidRequest() from None
    return parsed


def validate_payload(data, host):
    if len(data) > BODY_LIMIT:
        raise InvalidRequest()
    payload = decode_json(data)
    if (not isinstance(payload, dict) or set(payload) != {"files", "requestManifestSha256"}
            or not isinstance(payload["requestManifestSha256"], str)
            or not DIGEST.fullmatch(payload["requestManifestSha256"])
            or not isinstance(payload["files"], list) or len(payload["files"]) not in (3, 4)):
        raise InvalidRequest()
    names = set()
    for file in payload["files"]:
        if (not isinstance(file, dict) or set(file) != {"name", "url", "sha256", "size"}
                or not isinstance(file["name"], str) or file["name"] not in FILE_LIMITS
                or file["name"] in names or type(file["size"]) is not int
                or not 0 < file["size"] <= FILE_LIMITS[file["name"]]
                or not isinstance(file["sha256"], str) or not DIGEST.fullmatch(file["sha256"])):
            raise InvalidRequest()
        validate_url(file["url"], host)
        names.add(file["name"])
        if file["name"] == "request.json" and file["sha256"] != payload["requestManifestSha256"]:
            raise InvalidRequest()
    if not {"request.bin", "evaluation.keys", "request.json"} <= names:
        raise InvalidRequest()
    return payload


def remaining(deadline):
    value = deadline - time.monotonic()
    if value <= 0:
        raise TimeoutError()
    return min(value, 20.0)


def public_addresses(host):
    addresses = socket.getaddrinfo(host, 443, type=socket.SOCK_STREAM)
    if not addresses:
        raise DownloadError()
    for family, _, _, _, address in addresses:
        ip = ipaddress.ip_address(address[0])
        if (family not in (socket.AF_INET, socket.AF_INET6) or not ip.is_global
                or ip.is_multicast or ip.is_unspecified or ip.is_reserved
                or getattr(ip, "ipv4_mapped", None) is not None):
            raise DownloadError()
    return addresses


class PinnedHTTPSConnection(http.client.HTTPSConnection):
    """Never resolve twice: connect to checked IP, retaining hostname TLS/SNI checks.

    http.client does not use proxy environment variables or follow redirects.
    The outer job subprocess deadline also bounds blocking DNS and TLS operations.
    """
    def __init__(self, host, deadline):
        super().__init__(host, port=443, timeout=remaining(deadline),
                         context=ssl.create_default_context())
        self.deadline = deadline

    def connect(self):
        for family, kind, proto, _, address in public_addresses(self.host):
            sock = socket.socket(family, kind, proto)
            try:
                sock.settimeout(remaining(self.deadline))
                sock.connect(address)
                self.sock = self._context.wrap_socket(sock, server_hostname=self.host)
                return
            except Exception:
                sock.close()
        raise DownloadError()


def download(file, root, host, deadline, connection_factory=PinnedHTTPSConnection):
    parsed = validate_url(file["url"], host)
    connection = connection_factory(host, deadline)
    try:
        target = parsed.path + (("?" + parsed.query) if parsed.query else "")
        connection.request("GET", target, headers={"Accept-Encoding": "identity",
                                                   "Connection": "close"})
        response = connection.getresponse()
        # No redirect, partial response, content decoding, or ambiguous framing.
        if response.status != 200:
            raise DownloadError()
        lengths = response.headers.get_all("Content-Length", [])
        encodings = response.headers.get_all("Content-Encoding", [])
        transfers = response.headers.get_all("Transfer-Encoding", [])
        if (len(lengths) > 1 or len(encodings) > 1 or len(transfers) > 1
                or (encodings and encodings[0].lower() != "identity")
                or (transfers and transfers[0].lower() != "chunked")
                or (lengths and transfers)):
            raise DownloadError()
        if lengths and (not re.fullmatch(r"[0-9]+", lengths[0])
                        or int(lengths[0]) != file["size"]):
            raise DownloadError()
        size = 0
        digest = hashlib.sha256()
        flags = os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW
        with os.fdopen(os.open(root / file["name"], flags, 0o600), "wb") as output:
            while True:
                if connection.sock is not None:
                    connection.sock.settimeout(remaining(deadline))
                remaining(deadline)
                # read1 prevents an unbounded drip-fed read; process deadline is final cap.
                block = response.read1(min(65536, file["size"] - size + 1))
                if not block:
                    break
                size += len(block)
                if size > file["size"] or size > FILE_LIMITS[file["name"]]:
                    raise DownloadError()
                digest.update(block)
                output.write(block)
        if size != file["size"] or digest.hexdigest() != file["sha256"]:
            raise DownloadError()
    except Exception:
        # Presigned URLs and native exceptions never escape into an HTTP body/log.
        raise DownloadError() from None
    finally:
        connection.close()
