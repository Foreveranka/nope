"""Real loopback HTTP boundary tests with explicit synthetic mount/upstream doubles.

No FHE, signing, external HTTP, Blob, wallet, or secret persistence. Existing
mount/client unit tests own role/ownership logic; these tests ensure the new HTTP
routes cannot bypass framing, Origin/CSRF or invitation-header boundaries.
"""
import copy
import http.client
import json
import tempfile
import threading
import unittest
from email.message import Message
from pathlib import Path

from service.bid_client import BidClientError
from service.procurement_proxy import ORIGIN, ProcurementProxy
from service.server import create_server

JOB_ID = "ab" * 16
SESSION_ID = "cd" * 16
AUTH = "Bearer " + "p" * 43
KEY = "synthetic-http-request-0001"
COMMITMENT = "a1" * 32
EVIDENCE = "b2" * 32
PRIVATE_MARKER = "TEST-ONLY-private-input-must-not-leave-loopback"
PRIVATE_ACTIONS = {
    "prepare": {"jobId": JOB_ID, "budget": 123456},
    "snapshot": {},
    "publish-payload": {"sessionId": SESSION_ID, "expectedRevision": 0},
    "close": {"sessionId": SESSION_ID},
    "bid-prepare": {"jobId": JOB_ID, "price": 987654},
    "bid-snapshot": {"sessionId": SESSION_ID},
    "bid-close": {"sessionId": SESSION_ID},
    "bid-input": {"sessionId": SESSION_ID, "evidenceHash": EVIDENCE},
}


def never_pipeline(*args, **kwargs):
    raise AssertionError("Boundary tests must never start an FHE job")


class FakeMount:
    """Synthetic auth-checking dispatch recorder, not production ownership logic."""
    def __init__(self):
        self.calls = []

    def request(self, action, body, authorization):
        self.calls.append((action, copy.deepcopy(body), authorization))
        if authorization != AUTH:
            raise BidClientError("PROVIDER_REQUIRED")
        return {"id": SESSION_ID, "jobId": JOB_ID, "state": "PREPARED",
                "provider": "provider.testnet", "commitment": COMMITMENT}

    def close(self):
        pass


class FakeProxy:
    """Synthetic public dispatch recorder. It never opens a connection."""
    def __init__(self):
        self.calls = []

    def request(self, method, target, authorization, payload=None, idempotency_key=None):
        self.calls.append((method, target, authorization, copy.deepcopy(payload), idempotency_key))
        if authorization != AUTH:
            return 401, {"error": "Invitation required", "code": "INVITATION_REQUIRED"}
        return 200, {"job": {"id": JOB_ID, "status": "PUBLISHED"}}


class RecordingOpener:
    """In-memory urllib response; validates no request through a real socket."""
    def __init__(self):
        self.calls = []

    def open(self, request, timeout):
        self.calls.append((request.full_url, request.get_method(),
                           dict(request.header_items()), request.data))
        return FakeUpstreamResponse(request.full_url)


class FakeUpstreamResponse:
    status = 200

    def __init__(self, url):
        self.url = url
        self.headers = Message()
        self.headers["Content-Type"] = "application/json"

    def geturl(self):
        return self.url

    def read(self, size):
        return b'{"job":{"id":"' + JOB_ID.encode("ascii") + b'","status":"PUBLISHED"}}'

    def __enter__(self):
        return self

    def __exit__(self, *args):
        pass


class ProcurementHTTPTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="procurement-http-test-")
        self.addCleanup(self.temp.cleanup)
        # A supplied pipeline disables demos; an explicit inert remote avoids
        # reading cloud transport configuration from the developer environment.
        self.server = create_server(port=0, runtime_dir=Path(self.temp.name) / "runtime",
                                    pipeline=never_pipeline, remote_client=object())
        self.mount = FakeMount()
        self.proxy = FakeProxy()
        self.server.procurement_mount = self.mount
        self.server.procurement_proxy = self.proxy
        self.thread = threading.Thread(target=self.server.serve_forever,
                                       kwargs={"poll_interval": 0.01}, daemon=True)
        self.thread.start()
        self.addCleanup(self.close_server)
        self.headers = {"Origin": self.server.origin,
                        "X-CSRF-Token": self.server.state.csrf_token,
                        "Content-Type": "application/json", "Authorization": AUTH}

    def close_server(self):
        self.server.shutdown()
        self.server.server_close()
        self.thread.join(timeout=2)
        self.assertFalse(self.thread.is_alive())

    def request(self, path, method="POST", payload=None, headers=None, raw=None, duplicate=None):
        body = raw if raw is not None else json.dumps(payload if payload is not None else {}).encode("utf-8")
        selected = dict(self.headers if headers is None else headers)
        connection = http.client.HTTPConnection(*self.server.server_address, timeout=3)
        try:
            if duplicate is not None:
                # Low-level headers preserve repetition that a dict cannot express.
                connection.putrequest(method, path, skip_host=True, skip_accept_encoding=True)
                selected.setdefault("Host", self.server.expected_host)
                selected.setdefault("Content-Length", str(len(body)))
                for name, value in selected.items():
                    connection.putheader(name, value)
                connection.putheader(*duplicate)
                connection.endheaders(body)
            else:
                connection.request(method, path, body=body, headers=selected)
            reply = connection.getresponse()
            return reply.status, {k.lower(): v for k, v in reply.getheaders()}, reply.read()
        finally:
            connection.close()

    def private(self, action, **kwargs):
        kwargs.setdefault("payload", PRIVATE_ACTIONS[action])
        return self.request("/api/private-procurement/" + action, **kwargs)

    def assert_no_dispatch(self):
        self.assertEqual(self.mount.calls, [])
        self.assertEqual(self.proxy.calls, [])

    def assert_guard_response(self, result, expected):
        status, headers, raw = result
        self.assertEqual(status, expected, raw)
        self.assertEqual(headers["cache-control"], "no-store")
        self.assertNotIn("access-control-allow-origin", headers)
        self.assertNotIn(AUTH.encode(), raw)
        self.assertNotIn(self.server.state.csrf_token.encode(), raw)
        self.assertNotIn(PRIVATE_MARKER.encode(), raw)
        self.assertIn("error", json.loads(raw))

    def test_private_routes_require_exact_origin_before_any_dispatch(self):
        for action in PRIVATE_ACTIONS:
            for origin in (None, "null", "https://attacker.invalid", self.server.origin + "/"):
                with self.subTest(action=action, origin=origin):
                    headers = dict(self.headers)
                    if origin is None:
                        headers.pop("Origin")
                    else:
                        headers["Origin"] = origin
                    self.assert_guard_response(self.private(action, headers=headers), 403)
                    self.assert_no_dispatch()

    def test_private_routes_require_csrf_even_with_a_valid_invitation(self):
        for action in PRIVATE_ACTIONS:
            for csrf in (None, "wrong-token"):
                with self.subTest(action=action, csrf=csrf):
                    headers = dict(self.headers)
                    if csrf is None:
                        headers.pop("X-CSRF-Token")
                    else:
                        headers["X-CSRF-Token"] = csrf
                    self.assert_guard_response(self.private(action, headers=headers), 403)
                    self.assert_no_dispatch()

    def test_duplicate_security_and_framing_headers_never_reach_private_mount(self):
        for name, value in (("Host", self.server.expected_host), ("Origin", self.server.origin),
                            ("X-CSRF-Token", self.server.state.csrf_token), ("Authorization", AUTH),
                            ("Content-Type", "application/json"),
                            ("Content-Length", str(len(json.dumps(PRIVATE_ACTIONS["bid-prepare"]).encode())))):
            with self.subTest(header=name):
                self.assert_guard_response(self.private("bid-prepare", duplicate=(name, value)), 400)
                self.assert_no_dispatch()

    def test_private_routes_enforce_host_and_fetch_site_before_dispatch(self):
        for changes in ({"Host": "attacker.invalid"}, {"Host": "localhost:" + str(self.server.server_port)},
                        {"Sec-Fetch-Site": "cross-site"}, {"Sec-Fetch-Site": "same-site"}):
            with self.subTest(changes=changes):
                self.assert_guard_response(self.private("bid-input", headers={**self.headers, **changes}), 403)
                self.assert_no_dispatch()

    def test_private_dispatch_passes_exact_invitation_and_public_control_payload(self):
        for action in ("bid-snapshot", "bid-close", "bid-input", "publish-payload"):
            with self.subTest(action=action):
                status, headers, raw = self.private(action)
                self.assertEqual(status, 200, raw)
                self.assertEqual(self.mount.calls[-1], (action, PRIVATE_ACTIONS[action], AUTH))
                self.assertEqual(headers["cache-control"], "no-store")
        self.assertEqual(self.proxy.calls, [])

    def test_invitation_failures_are_not_replaced_by_cookie_or_csrf_identity(self):
        for authorization in (None, "Bearer " + "q" * 43):
            with self.subTest(authorization=authorization):
                headers = {**self.headers, "Cookie": "invitation=" + AUTH[7:]}
                if authorization is None:
                    headers.pop("Authorization")
                else:
                    headers["Authorization"] = authorization
                status, _, raw = self.private("bid-input", headers=headers)
                self.assertEqual(status, 409)
                self.assertEqual(json.loads(raw), {"error": "PROVIDER_REQUIRED", "code": "PROVIDER_REQUIRED"})
                self.assertEqual(self.mount.calls[-1][2], authorization)
                self.assertEqual(self.proxy.calls, [])

    def test_price_body_reaches_private_mount_without_becoming_public_metadata(self):
        status, _, raw = self.private("bid-prepare")
        self.assertEqual(status, 200, raw)
        self.assertEqual(self.mount.calls, [("bid-prepare", PRIVATE_ACTIONS["bid-prepare"], AUTH)])
        self.assertEqual(self.proxy.calls, [])
        self.assertNotIn(str(PRIVATE_ACTIONS["bid-prepare"]["price"]).encode(), raw)
        self.assertNotIn(b'"price"', raw)

    def test_private_get_and_cross_site_preflight_cannot_dispatch(self):
        for action in ("bid-snapshot", "bid-input"):
            for method in ("GET", "HEAD", "OPTIONS"):
                with self.subTest(action=action, method=method):
                    status, headers, raw = self.private(action, method=method,
                                                       headers={**self.headers, "Origin": "https://attacker.invalid"})
                    self.assertEqual(status, 403)
                    self.assertNotIn("access-control-allow-origin", headers)
                    self.assertNotIn(AUTH.encode(), raw)
                    self.assert_no_dispatch()
        for method in ("GET", "HEAD"):
            self.assertEqual(self.private("bid-snapshot", method=method)[0], 404)
            self.assert_no_dispatch()

    def test_ambiguous_private_json_is_rejected_before_dispatch(self):
        for raw in (b'{"jobId":"first","jobId":"second","price":1}',
                    b'{"sessionId":"x","evidenceHash":NaN}', b"{", b"\xff"):
            with self.subTest(raw=raw):
                self.assert_guard_response(self.private("bid-prepare", raw=raw), 400)
                self.assert_no_dispatch()

    def test_public_bid_dispatch_preserves_commitment_identity_and_idempotency(self):
        path = "/api/procurement/jobs/" + JOB_ID + "/bids"
        body = {"expectedRevision": 1, "commitment": COMMITMENT}
        status, _, raw = self.request(path, payload=body, headers={**self.headers, "Idempotency-Key": KEY})
        self.assertEqual(status, 200, raw)
        self.assertEqual(self.proxy.calls, [("POST", path, AUTH, body, KEY)])
        self.assertEqual(self.mount.calls, [])

    def test_duplicate_public_auth_or_idempotency_never_dispatches_transport(self):
        path = "/api/procurement/jobs/" + JOB_ID + "/bids"
        for name, value in (("Authorization", AUTH), ("Idempotency-Key", KEY)):
            with self.subTest(header=name):
                self.assert_guard_response(self.request(path, payload={"expectedRevision": 1, "commitment": COMMITMENT},
                                                       headers={**self.headers, "Idempotency-Key": KEY},
                                                       duplicate=(name, value)), 400)
                self.assert_no_dispatch()

    def test_private_fields_in_public_posts_are_rejected_before_upstream_open(self):
        opener = RecordingOpener()
        self.server.procurement_proxy = ProcurementProxy(opener)
        cases = [("bids", {"expectedRevision": 1, "commitment": COMMITMENT, "price": 987654}),
                 ("publish", {"expectedRevision": 0, "intent": {"salt": PRIVATE_MARKER}, "budgetCommitment": COMMITMENT}),
                 ("publish", {"expectedRevision": 0, "intent": {"nested": [{"records": PRIVATE_MARKER}]}, "budgetCommitment": COMMITMENT})]
        for action, payload in cases:
            with self.subTest(action=action, payload=payload):
                path = "/api/procurement/jobs/" + JOB_ID + "/" + action
                status, headers, raw = self.request(path, payload=payload,
                                                    headers={**self.headers, "Idempotency-Key": KEY})
                self.assertEqual(status, 503, raw)
                self.assertEqual(json.loads(raw)["code"], "LOCAL_PROXY_REJECTED")
                self.assertEqual(headers["cache-control"], "no-store")
                self.assertNotIn(PRIVATE_MARKER.encode(), raw)
                self.assertEqual(opener.calls, [])
                self.assertEqual(self.mount.calls, [])

    def test_valid_public_transport_never_forwards_local_csrf_or_cookie(self):
        opener = RecordingOpener()
        self.server.procurement_proxy = ProcurementProxy(opener)
        path = "/api/procurement/jobs/" + JOB_ID + "/bids"
        payload = {"expectedRevision": 1, "commitment": COMMITMENT}
        status, _, raw = self.request(path, payload=payload,
                                     headers={**self.headers, "Idempotency-Key": KEY, "Cookie": "local-only=marker"})
        self.assertEqual(status, 200, raw)
        self.assertEqual(len(opener.calls), 1)
        url, method, headers, body = opener.calls[0]
        self.assertEqual(url, ORIGIN + path)
        self.assertEqual(method, "POST")
        self.assertEqual(json.loads(body), payload)
        forwarded = {key.lower(): value for key, value in headers.items()}
        self.assertEqual(forwarded["authorization"], AUTH)
        self.assertEqual(forwarded["idempotency-key"], KEY)
        for header in ("cookie", "x-csrf-token", "origin"):
            self.assertNotIn(header, forwarded)
        self.assertNotIn(self.server.state.csrf_token.encode(), body)
        self.assertEqual(self.mount.calls, [])

    def test_public_reads_reject_foreign_origin_and_do_not_treat_cookie_as_invitation(self):
        for changes in ({"Origin": "https://attacker.invalid"}, {"Sec-Fetch-Site": "cross-site"}):
            self.assert_guard_response(self.request("/api/procurement/session", method="GET",
                                                   headers={**self.headers, **changes}), 403)
            self.assert_no_dispatch()
        headers = {**self.headers, "Cookie": "invitation=" + AUTH[7:]}
        headers.pop("Authorization")
        status, _, raw = self.request("/api/procurement/session", method="GET", headers=headers)
        self.assertEqual(status, 401, raw)
        self.assertEqual(self.proxy.calls, [("GET", "/api/procurement/session", None, None, None)])
        self.assertEqual(self.mount.calls, [])


if __name__ == "__main__":
    unittest.main()
