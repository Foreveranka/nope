"""Fixed-origin transport for PUBLIC procurement metadata from the local client.

Never transport records, prices, budget openings or keys. No generic HTTP proxy.
"""
import json
import re
import urllib.error
import urllib.request
from urllib.parse import urlsplit, parse_qs

ORIGIN = 'https://veil-procurement.vercel.app'
BODY_FIELDS = {
    'jobs': {'jobId', 'title', 'profile', 'roster', 'bidDeadlineNs', 'resultDeadlineNs'},
    'publish': {'expectedRevision', 'intent', 'budgetCommitment'},
    'bids': {'expectedRevision', 'commitment'},
    'close': {'expectedRevision'},
    'selection': {'expectedRevision', 'evidenceHash'},
    'deliveries': {'expectedRevision', 'version', 'outputHash', 'receiptHash'},
    'decision': {'expectedRevision', 'version', 'outputHash', 'receiptHash', 'decision'},
}
FORBIDDEN = {'records', 'plaintext', 'budget', 'price', 'salt', 'privateKey', 'secretKey', 'witness'}
class ProxyError(Exception):
    pass
class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *args, **kwargs):
        raise ProxyError('Procurement redirects are forbidden')

def public_only(value):
    if isinstance(value, dict):
        if FORBIDDEN.intersection(value):
            raise ProxyError('Private input cannot enter the procurement transport')
        for item in value.values(): public_only(item)
    elif isinstance(value, list):
        for item in value: public_only(item)

class ProcurementProxy:
    def __init__(self, opener=None):
        self.opener = opener or urllib.request.build_opener(urllib.request.ProxyHandler({}), NoRedirect())

    def request(self, method, target, authorization, payload=None, idempotency_key=None):
        parsed = urlsplit(target)
        if parsed.scheme or parsed.netloc or parsed.fragment or not re.fullmatch(
                r'/api/procurement/(?:health|session|jobs(?:/[0-9a-f]{32}(?:/(?:publish|bids|close|selection|deliveries|decision))?)?)', parsed.path):
            raise ProxyError('Unsupported procurement route')
        if method not in ('GET', 'POST'): raise ProxyError('Unsupported method')
        if not isinstance(authorization, str) or not re.fullmatch(r'Bearer [A-Za-z0-9_-]{43,128}', authorization):
            raise ProxyError('Invitation required')
        query = parse_qs(parsed.query, keep_blank_values=True)
        if parsed.query and (method != 'GET' or parsed.path != '/api/procurement/jobs' or set(query) - {'limit', 'cursor'} or any(len(v) != 1 for v in query.values()) or len(parsed.query) > 4096):
            raise ProxyError('Unsupported query')
        headers = {'Authorization': authorization, 'Accept': 'application/json'}
        body = None
        if method == 'POST':
            action = parsed.path.rsplit('/', 1)[-1]
            if type(payload) is not dict or action not in BODY_FIELDS or set(payload) != BODY_FIELDS[action]:
                raise ProxyError('Unexpected public request fields')
            public_only(payload)
            if not isinstance(idempotency_key, str) or not re.fullmatch(r'[A-Za-z0-9_-]{16,80}', idempotency_key):
                raise ProxyError('Idempotency key required')
            body = json.dumps(payload, allow_nan=False).encode()
            if len(body) > 16384: raise ProxyError('Public request too large')
            headers.update({'Content-Type': 'application/json', 'Idempotency-Key': idempotency_key})
        elif payload is not None:
            raise ProxyError('GET body forbidden')
        request = urllib.request.Request(ORIGIN + target, data=body, method=method, headers=headers)
        try:
            try:
                response = self.opener.open(request, timeout=15)
            except urllib.error.HTTPError as error:
                response = error
            with response:
                if response.geturl().split('/api/', 1)[0] != ORIGIN or response.headers.get_content_type() != 'application/json':
                    raise ProxyError('Unexpected upstream response')
                raw = response.read(1048577)
                if len(raw) > 1048576: raise ProxyError('Upstream response too large')
                data = json.loads(raw)
                if not isinstance(data, dict): raise ProxyError('Invalid upstream object')
                return response.status, data
        except (OSError, ValueError, urllib.error.URLError):
            raise ProxyError('Procurement transport unavailable; retry the same request key') from None
