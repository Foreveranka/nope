"""Bounded HTTPS, injected bearer, no redirects/cookies/retries or secret logging."""
import json
import math
import time
import urllib.error
import urllib.request
from dataclasses import dataclass, field
from urllib.parse import urlsplit
from .model import PaymentError, Unsupported, canonical

ORIGIN = 'https://market.near.ai'


class TransportError(PaymentError):
    def __init__(self, code, status=None):
        self.code, self.status = code, status
        super().__init__(code + (':' + str(status) if status is not None else ''))


@dataclass(frozen=True)
class Credential:
    role: str
    principal: str
    token: str = field(repr=False, compare=False)


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


def strict_json(raw):
    def unique(pairs):
        result = {}
        for key, value in pairs:
            if key in result:
                raise ValueError('duplicate JSON key')
            result[key] = value
        return result
    return json.loads(raw, object_pairs_hook=unique,
                      parse_constant=lambda _: (_ for _ in ()).throw(ValueError()))


def sse_response(raw, request_id):
    """Read only complete SSE events; correlate exactly one JSON-RPC response.

    Notifications/keepalives are ignored; malformed JSON, unrelated response IDs,
    duplicate terminal messages and arbitrary prose never become tool results.
    No event ID is reused as an idempotency key or Last-Event-ID retry token.
    """
    normalized = raw.replace(b'\r\n', b'\n')
    frames = normalized.split(b'\n\n')[:-1]
    result = None
    for frame in frames:
        event, data = '', []
        for line in frame.decode('utf-8').split('\n'):
            if not line or line.startswith(':'):
                continue
            key, _, value = line.partition(':')
            value = value[1:] if value.startswith(' ') else value
            if key == 'event':
                event = value
            elif key == 'data':
                data.append(value)
        if not data:
            continue
        if event not in ('', 'message'):
            raise TransportError('unsupported_sse_event')
        value = strict_json('\n'.join(data))
        if not isinstance(value, dict) or value.get('jsonrpc') != '2.0':
            raise TransportError('invalid_sse_jsonrpc')
        if 'id' not in value and isinstance(value.get('method'), str):
            continue
        if value.get('id') != request_id or result is not None:
            raise TransportError('sse_response_correlation_failure')
        result = value
    return result


class HTTPS:
    def __init__(self, credential_provider=None, timeout=10, max_bytes=4*1024*1024):
        if type(timeout) not in (int, float) or not math.isfinite(timeout) or not 0 < timeout <= 60:
            raise PaymentError('timeout must be 0..60 seconds')
        if type(max_bytes) is not int or not 0 < max_bytes <= 8*1024*1024:
            raise PaymentError('invalid response size limit')
        self.provider, self.timeout, self.max_bytes = credential_provider, timeout, max_bytes
        self.opener = urllib.request.build_opener(NoRedirect())

    def credential(self, role, principal):
        try:
            credential = self.provider() if self.provider else None
        except Exception:
            raise TransportError('credential_unavailable') from None
        if (not isinstance(credential, Credential) or credential.role != role or credential.principal != principal
                or not isinstance(credential.token, str) or not 1 <= len(credential.token) <= 8192
                or any(ord(c) <= 32 or ord(c) >= 127 for c in credential.token)):
            raise TransportError('credential_scope_mismatch')
        return credential

    def json(self, method, target, body=None, role=None, principal=None, headers=None):
        # Fixed deployment; reject absolute URLs, traversal, fragments and encoded CR/LF.
        parsed = urlsplit(target)
        if (parsed.scheme or parsed.netloc or not target.startswith('/') or target.startswith('//')
                or parsed.fragment or any(c in target for c in ('\r', '\n', '\\'))
                or any(part == '..' for part in parsed.path.split('/'))):
            raise Unsupported('only pinned Market relative paths are permitted')
        request_headers = {'Accept': 'application/json, text/event-stream' if target in ('/mcp', '/mcp/pro') else 'application/json', 'User-Agent': 'veil-payments-read-prepare/1'}
        for name, value in (headers or {}).items():
            if name not in ('MCP-Protocol-Version', 'Mcp-Session-Id') or not isinstance(value, str) or any(ord(c) < 32 or ord(c) >= 127 for c in value):
                raise PaymentError('invalid protocol header')
            request_headers[name] = value
        if role is not None:
            request_headers['Authorization'] = 'Bearer ' + self.credential(role, principal).token
        data = None if body is None else canonical(body).encode('utf-8')
        if data is not None and len(data) > 1024*1024:
            raise PaymentError('request body too large')
        if data is not None:
            request_headers['Content-Type'] = 'application/json'
        request = urllib.request.Request(ORIGIN + target, data=data, headers=request_headers, method=method)
        try:
            deadline = time.monotonic() + self.timeout
            with self.opener.open(request, timeout=self.timeout) as response:
                chunks, size = [], 0
                content_type = response.headers.get_content_type()
                safe_headers = {k: response.headers[k] for k in ('Mcp-Session-Id',) if k in response.headers}
                streaming = content_type == 'text/event-stream' and target in ('/mcp', '/mcp/pro')
                if streaming and (not isinstance(body, dict) or 'id' not in body):
                    raise TransportError('sse_request_id_required')
                while True:
                    if time.monotonic() >= deadline:
                        raise TransportError('timeout')
                    chunk = response.read1(min(65536, self.max_bytes + 1 - size))
                    if not chunk:
                        break
                    size += len(chunk)
                    if size > self.max_bytes:
                        raise TransportError('response_too_large')
                    chunks.append(chunk)
                    if streaming:
                        value = sse_response(b''.join(chunks), body['id'])
                        if value is not None:
                            return response.status, value, safe_headers
                raw = b''.join(chunks)
                if response.status == 202 and not raw:
                    return response.status, None, {}
                if content_type != 'application/json':
                    raise TransportError('json_or_complete_sse_response_required')
                value = strict_json(raw)
                return response.status, value, safe_headers
        except urllib.error.HTTPError as exc:
            # Never read/log a server error body, URL, cookies, headers or token.
            status = exc.code
            exc.close()
            raise TransportError('http_error', status) from None
        except TransportError:
            raise
        except Exception:
            raise TransportError('transport_or_json_failure') from None
