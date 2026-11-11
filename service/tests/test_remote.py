"""Scoped HTTP protocol doubles. No real network or cryptographic success claim."""
import base64
import copy
import io
import http.client
import json
import os
import ssl
import tempfile
import threading
import time
import types
import unittest
from pathlib import Path
from unittest.mock import patch
from urllib.parse import parse_qs, urlencode, urlsplit

from engine.portable.pins import ARTIFACT_PINS
from engine.protocol import canonical_json, sha256
from service.remote import DEFAULT_CLOUD_URL, MAX_REPLY, RemoteClient, RemoteError, _url
from service.server import JobState, RequestError, create_server
from service.tests.test_server import PRIVATE, RECORDS, fake_pipeline

TOKEN = 'T' * 43
JOB = 'a' * 32
BUSY = 'b' * 32
BLOB = 'https://vercel.com/api/blob/'


def signed_put(name, size, job_id=JOB, *, minimal=False):
    # Real provider endpoint/parameter shape; credentials are synthetic dummies.
    query = {'pathname': 'veil-v1/test-owner/' + job_id + '/' + name,
             'vercel-blob-maximum-size-in-bytes': str(size),
             'vercel-blob-delegation': 'TEST-ONLY-DELEGATION',
             'vercel-blob-signature': 'TEST-ONLY-SIGNATURE'}
    if not minimal:
        query.update({'vercel-blob-allowed-content-types': ('application/json' if name in ('request.json', 'binding.json') else 'application/octet-stream'),
                      'vercel-blob-allow-overwrite': 'false',
                      'vercel-blob-add-random-suffix': 'false',
                      'vercel-blob-ttl-days': '1'})
    return BLOB + '?' + urlencode(query)


def fixtures(v2=False):
    # These opaque strings are synthetic protocol bytes, not encryption.
    files = {'request.bin': b'TEST-ONLY-opaque-request',
             'evaluation.keys': b'TEST-ONLY-opaque-evaluation-key' * 5000}
    manifest = {'protocolVersion': 2 if v2 else 1, 'profileId': 'clean-4-records-v1',
                'attemptId': 'c' * 32, 'serverSha256': ARTIFACT_PINS['server.zip'],
                'clientSpecsSha256': ARTIFACT_PINS['client-specs.json'],
                'inputSha256': sha256(files['request.bin']),
                'evaluationKeysSha256': sha256(files['evaluation.keys'])}
    if v2:
        files['binding.json'] = canonical_json({'job_id': '7', 'attempt': '1',
            'job_binding_hash': '1' * 64, 'attempt_binding_hash': '2' * 64, 'bidset_root': '3' * 64})
        manifest['externalBindingSha256'] = sha256(files['binding.json'])
    files['request.json'] = canonical_json(manifest)
    output = b'TEST-ONLY-opaque-response'
    receipt = {'request': manifest, 'requestManifestSha256': sha256(files['request.json']),
               'outputSha256': sha256(output), 'metrics': {'server_load_seconds': 0.1, 'evaluate_seconds': 0.2}}
    # Deliberately NON-canonical wire bytes; must survive unchanged.
    receipt_bytes = json.dumps(receipt, indent=2).encode() + b'\n'
    result = {'receipt': receipt, 'receiptBase64': base64.b64encode(receipt_bytes).decode(),
              'receiptSha256': sha256(receipt_bytes), 'outputBase64': base64.b64encode(output).decode(),
              'outputSha256': sha256(output)}
    return files, result, {'response.bin': output, 'receipt.json': receipt_bytes}


class Response:
    def __init__(self, status=200, value=None, raw=None, encoding='identity'):
        self.status, self.encoding = status, encoding
        self.stream = io.BytesIO(json.dumps(value).encode() if raw is None else raw)

    def read1(self, size):
        return self.stream.read(size)

    def getheader(self, key, default=None):
        return self.encoding if key == 'Content-Encoding' else default


class Network:
    """http.client-compatible double capturing exact requests/chunk boundaries."""
    def __init__(self, result, *, ids=None, statuses=None):
        self.result, self.ids = result, ids or [JOB]
        self.statuses = statuses or {}
        self.calls, self.connections = [], []
        self.mutate_plan = lambda value: value
        self.evaluate_failure = None
        self.result_status = 200
        self.redirect_blob = False

    def connect(self, host, **kwargs):
        network = self
        class Connection:
            sock = None
            def __init__(self):
                self.host, self.kwargs = host, kwargs
                self.headers, self.blocks, self.body = {}, [], None
                self.closed = False
            def request(self, method, path, body=None, headers=None):
                self.method, self.path, self.body, self.headers = method, path, body, headers or {}
            def putrequest(self, method, path):
                self.method, self.path = method, path
            def putheader(self, name, value):
                self.headers[name] = value
            def endheaders(self):
                pass
            def send(self, block):
                self.blocks.append(bytes(block))
            def getresponse(self):
                network.calls.append(self)
                if self.method == 'PUT':
                    return Response(307 if network.redirect_blob else 201)
                if self.path.endswith('/session'):
                    return Response(value={'jobIds': network.ids})
                if self.path == '/api/cloud/jobs':
                    payload = json.loads(self.body)
                    reply = {'jobId': payload['jobId'], 'uploads': [dict(f, url=signed_put(f['name'], f['size'], payload['jobId'])) for f in payload['files']]}
                    return Response(201, network.mutate_plan(reply))
                if self.path.endswith('/evaluate'):
                    if network.evaluate_failure:
                        raise network.evaluate_failure
                    return Response(value={'jobId': self.path.split('/')[-2], 'status': 'COMPLETED'})
                if self.path.endswith('/result'):
                    return Response(network.result_status, network.result)
                return Response(network.statuses.get(self.path.split('/')[-1], 404), {'status': 'RUNNING_OR_UNKNOWN'})
            def close(self):
                self.closed = True
        conn = Connection()
        self.connections.append(conn)
        return conn


class RemoteTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.files, self.result, self.expected = fixtures()
        self.network = Network(self.result)
        self.client = RemoteClient(DEFAULT_CLOUD_URL, TOKEN, self.root, connection_factory=self.network.connect)

    def test_exact_receipt_bytes_upload_hashes_streaming_tls_and_no_blob_token(self):
        self.assertEqual(self.client.evaluate(self.files), self.expected)
        puts = [c for c in self.network.calls if c.method == 'PUT']
        self.assertEqual(len(puts), 3)
        for conn in self.network.calls:
            self.assertTrue(conn.closed)
            self.assertEqual(conn.kwargs['context'].verify_mode, ssl.CERT_REQUIRED)
            self.assertTrue(conn.kwargs['context'].check_hostname)
            self.assertGreater(conn.kwargs['timeout'], 0)
            self.assertLessEqual(conn.kwargs['timeout'], 260)
            if conn.method == 'PUT':
                name = parse_qs(urlsplit(conn.path).query)['pathname'][0].split('/')[-1]
                self.assertEqual(conn.host, 'vercel.com')
                self.assertEqual(urlsplit(conn.path).path, '/api/blob/')
                self.assertEqual(b''.join(conn.blocks), self.files[name])
                self.assertTrue(all(len(block) <= 65536 for block in conn.blocks))
                self.assertEqual('https://' + conn.host + conn.path, signed_put(name, len(self.files[name])))
                self.assertEqual(conn.headers['Content-Type'], 'application/json' if name == 'request.json' else 'application/octet-stream')
                self.assertEqual(int(conn.headers['Content-Length']), len(self.files[name]))
                self.assertNotIn('Authorization', conn.headers)
                self.assertNotIn(TOKEN, str(conn.headers))
            else:
                self.assertEqual(conn.headers['Authorization'], 'Bearer ' + TOKEN)
        created = next(json.loads(c.body) for c in self.network.calls if c.path == '/api/cloud/jobs')
        self.assertEqual(created['requestManifestSha256'], sha256(self.files['request.json']))
        self.assertEqual({f['name'] for f in created['files']}, set(self.files))
        for desc in created['files']:
            self.assertEqual(desc['sha256'], sha256(self.files[desc['name']]))
        wire = b''.join(c.body or b'' for c in self.network.calls) + b''.join(b''.join(c.blocks) for c in puts)
        self.assertNotIn(PRIVATE.encode(), wire)
        self.assertTrue(b'"records":' not in wire)

    def test_engine_five_file_callback_never_uploads_server_or_specs(self):
        from engine.protocol import approved_artifacts
        files = dict(self.files, **approved_artifacts(artifact_set='portable-v1'))
        self.assertEqual(self.client.evaluate(files), self.expected)
        created = next(json.loads(c.body) for c in self.network.calls if c.path == '/api/cloud/jobs')
        self.assertEqual({f['name'] for f in created['files']}, set(self.files))

    def test_v2_binding_is_fourth_file(self):
        self.files, self.network.result, expected = fixtures(True)
        self.assertEqual(self.client.evaluate(self.files), expected)
        puts = [c for c in self.network.calls if c.method == 'PUT']
        self.assertEqual(len(puts), 4)
        for conn in puts:
            name = parse_qs(urlsplit(conn.path).query)['pathname'][0].split('/')[-1]
            expected_type = 'application/json' if name in ('request.json', 'binding.json') else 'application/octet-stream'
            self.assertEqual(conn.headers['Content-Type'], expected_type)
            self.assertEqual(parse_qs(urlsplit(conn.path).query)['vercel-blob-allowed-content-types'], [expected_type])

    def test_signed_content_type_matches_exact_allowlisted_filename(self):
        for name in ('request.json', 'binding.json', 'request.bin', 'evaluation.keys'):
            with self.subTest(name=name):
                expected = 'application/json' if name in ('request.json', 'binding.json') else 'application/octet-stream'
                signed = signed_put(name, 24)
                self.assertEqual(_url(signed, blob=True).path, '/api/blob/')
                query = parse_qs(urlsplit(signed).query)
                query['vercel-blob-allowed-content-types'] = ['application/octet-stream' if expected == 'application/json' else 'application/json']
                wrong = BLOB + '?' + urlencode({key: values[0] for key, values in query.items()})
                with self.assertRaises(RemoteError):
                    _url(wrong, blob=True)
        def wrong_json_type(plan):
            item = next(item for item in plan['uploads'] if item['name'] == 'request.json')
            item['url'] = item['url'].replace('application%2Fjson', 'application%2Foctet-stream')
            return plan
        self.network.mutate_plan = wrong_json_type
        with self.assertRaises(RemoteError):
            self.client.evaluate(self.files)
        self.assertFalse(any(conn.method == 'PUT' for conn in self.network.calls))

    def test_unknown_or_modified_inputs_fail_before_network(self):
        from engine.protocol import ARTIFACT_PINS as MAC_PINS
        cases = []
        for name in ('secret.key', 'records.json', 'anything.txt'):
            cases.append(dict(self.files, **{name: PRIVATE.encode()}))
        cases.append(dict(self.files, **{'request.bin': b'changed'}))
        cases.append(dict(self.files, **{'evaluation.keys': b'changed'}))
        cases.append({k: v for k, v in self.files.items() if k != 'request.json'})
        manifest = json.loads(self.files['request.json'])
        manifest['serverSha256'] = MAC_PINS['server.zip']
        cases.append(dict(self.files, **{'request.json': canonical_json(manifest)}))
        manifest['serverSha256'] = '0' * 64
        cases.append(dict(self.files, **{'request.json': canonical_json(manifest)}))
        for files in cases:
            with self.subTest(names=list(files)):
                with self.assertRaises(RemoteError):
                    self.client.evaluate(files)
        self.assertEqual(self.network.calls, [])

    def test_busy_ids_skipped_only_404_is_unused(self):
        self.network.ids = [BUSY, JOB]
        self.network.statuses[BUSY] = 200
        self.client.evaluate(self.files)
        creation = next(json.loads(c.body) for c in self.network.calls if c.path == '/api/cloud/jobs')
        self.assertEqual(creation['jobId'], JOB)
        self.assertFalse(any(c.method == 'POST' and BUSY in c.path for c in self.network.calls))

    def test_persistent_consumption_survives_new_client_and_unknown_post(self):
        self.network.evaluate_failure = TimeoutError(BLOB + TOKEN)
        with self.assertRaises(RemoteError) as caught:
            self.client.evaluate(self.files)
        self.assertNotIn(TOKEN, str(caught.exception))
        self.assertNotIn(BLOB, str(caught.exception))
        second = RemoteClient(DEFAULT_CLOUD_URL, TOKEN, self.root, connection_factory=self.network.connect)
        with self.assertRaises(RemoteError):
            second.evaluate(self.files)
        self.assertEqual(sum(c.method == 'POST' and c.path.endswith('/evaluate') for c in self.network.calls), 1)
        self.assertEqual(sum(c.method == 'POST' and c.path == '/api/cloud/jobs' for c in self.network.calls), 1)
        ledger = self.root / 'remote-used-jobs.jsonl'
        self.assertEqual(ledger.stat().st_mode & 0o777, 0o600)
        self.assertNotIn(TOKEN, ledger.read_text())
        self.assertNotIn(JOB, ledger.read_text())

    def test_409_502_and_timeouts_never_retry_mutations(self):
        for error in (409, 502, TimeoutError('PRIVATE URL ' + BLOB)):
            with self.subTest(error=type(error).__name__), tempfile.TemporaryDirectory() as root:
                network = Network(self.result)
                original = network.connect
                def connect(*args, **kwargs):
                    conn = original(*args, **kwargs)
                    respond = conn.getresponse
                    def getresponse():
                        if conn.path.endswith('/evaluate'):
                            network.calls.append(conn)
                            if isinstance(error, Exception):
                                raise error
                            return Response(error, {'error': BLOB + TOKEN})
                        return respond()
                    conn.getresponse = getresponse
                    return conn
                client = RemoteClient(DEFAULT_CLOUD_URL, TOKEN, root, connection_factory=connect)
                with self.assertRaises(RemoteError):
                    client.evaluate(self.files)
                self.assertEqual(sum(c.path.endswith('/evaluate') for c in network.calls), 1)
                self.assertFalse(any(c.path.endswith('/result') for c in network.calls))

    def test_entire_upload_plan_validated_before_put(self):
        def duplicate(plan):
            plan['uploads'][-1] = plan['uploads'][0]
            return plan
        def invalid_last(plan):
            plan['uploads'][-1]['url'] = 'https://attacker.invalid/path?' + TOKEN
            return plan
        def wrong_size(plan):
            plan['uploads'][-1]['size'] += 1
            return plan
        for mutation in (duplicate, invalid_last, wrong_size):
            with tempfile.TemporaryDirectory() as root:
                network = Network(self.result)
                network.mutate_plan = mutation
                client = RemoteClient(DEFAULT_CLOUD_URL, TOKEN, root, connection_factory=network.connect)
                with self.assertRaises(RemoteError):
                    client.evaluate(self.files)
                self.assertFalse(any(c.method == 'PUT' for c in network.calls))

    def test_result_corruption_and_cross_request_binding_rejected(self):
        def corrupt_receipt(result):
            result['receiptBase64'] = base64.b64encode(b'bad').decode()
        def different_object(result):
            result['receipt']['metrics']['evaluate_seconds'] = 3
        def cross_request(result):
            result['receipt']['request']['inputSha256'] = 'f' * 64
            data = canonical_json(result['receipt'])
            result['receiptBase64'], result['receiptSha256'] = base64.b64encode(data).decode(), sha256(data)
        def corrupt_output(result):
            result['outputBase64'] = base64.b64encode(b'bad').decode()
        def invalid_base64(result):
            result['outputBase64'] = 'not*base64'
        def bool_version(result):
            result['receipt']['request']['protocolVersion'] = True
            data = canonical_json(result['receipt'])
            result['receiptBase64'], result['receiptSha256'] = base64.b64encode(data).decode(), sha256(data)
        for mutation in (corrupt_receipt, different_object, cross_request, corrupt_output, invalid_base64, bool_version):
            with self.subTest(mutation=mutation.__name__), tempfile.TemporaryDirectory() as root:
                result = copy.deepcopy(self.result)
                mutation(result)
                network = Network(result)
                client = RemoteClient(DEFAULT_CLOUD_URL, TOKEN, root, connection_factory=network.connect)
                with self.assertRaises(RemoteError):
                    client.evaluate(self.files)

    def test_blob_redirect_not_followed_or_leaked(self):
        self.network.redirect_blob = True
        with self.assertRaises(RemoteError) as caught:
            self.client.evaluate(self.files)
        self.assertNotIn(BLOB, str(caught.exception))
        self.assertEqual(sum(c.method == 'PUT' for c in self.network.calls), 1)
        self.assertFalse(any(c.path.endswith('/evaluate') for c in self.network.calls))

    def test_url_configuration_tls_and_token_validation(self):
        urls = ['http://example.com', 'https://user:pass@example.com', 'https://example.com:444',
                'https://example.com/x', 'https://example.com?token=x', 'https://example.com/#x',
                'https://127.0.0.1', 'https://example.com\\@attacker.invalid', 'https://example.com\n']
        for url in urls:
            with self.subTest(url=url), self.assertRaises(RemoteError):
                RemoteClient(url, TOKEN, self.root)
        for token in ('short', TOKEN + '\n', TOKEN + ' ', ''):
            with self.assertRaises(RemoteError):
                RemoteClient(DEFAULT_CLOUD_URL, token, self.root)
        with patch.dict(os.environ, {}, clear=True):
            self.assertIsNone(RemoteClient.from_env(self.root))
        with patch.dict(os.environ, {'VEIL_CUSTOMER_TOKEN': TOKEN}, clear=True):
            self.assertIsNotNone(RemoteClient.from_env(self.root))

    def test_official_put_route_only_query_shape_and_negative_suffixes(self):
        minimal = signed_put('request.bin', 24, minimal=True)
        self.assertEqual(_url(minimal, blob=True).path, '/api/blob/')
        full = signed_put('request.bin', 24)
        self.assertEqual(_url(full, blob=True).hostname, 'vercel.com')
        query = urlsplit(full).query
        for route in ('/api/blob', '/api/blob/extra', '/api/blob/mpu', '/api/blob//',
                      '/api/blob/../secrets', '/api/blob/%2e%2e/', '/api/%62lob/',
                      '/api/blob/%2f', '//api/blob/', '/api/blob.evil/', '/api/other/'):
            with self.subTest(route=route), self.assertRaises(RemoteError):
                _url('https://vercel.com' + route + '?' + query, blob=True)
        for origin in ('https://vercel.com.attacker.invalid', 'https://attacker.vercel.com',
                       'https://vercel.com:444', 'http://vercel.com',
                       'https://unit.private.blob.vercel-storage.com'):
            with self.subTest(origin=origin), self.assertRaises(RemoteError):
                _url(origin + '/api/blob/?' + query, blob=True)
        for bad in (full + '&redirect=https%3A%2F%2Fattacker.invalid',
                    full + '&vercel-blob-signature=duplicate', full + '&pathname=duplicate',
                    full.replace('vercel-blob-signature=', 'unknown='),
                    full.replace('TEST-ONLY-SIGNATURE', ''), full + '&extra=%ZZ',
                    full.replace('overwrite=false', 'overwrite=true'),
                    full.replace('ttl-days=1', 'ttl-days=2')):
            with self.assertRaises((RemoteError, ValueError)):
                _url(bad, blob=True)
        # Even the exact control-plane URL cannot be used for GET/POST uploads.
        for method in ('GET', 'POST', 'DELETE'):
            with self.assertRaises(RemoteError):
                self.client._request(method, full, time.monotonic() + 2,
                                     upload=io.BytesIO(b'x' * 24), size=24)
        self.assertEqual(self.network.calls, [])

    def test_signed_path_and_size_must_match_plan_before_any_upload(self):
        def wrong_job(plan):
            item = plan['uploads'][-1]
            item['url'] = signed_put(item['name'], item['size'], BUSY)
            return plan
        def wrong_name(plan):
            item = plan['uploads'][-1]
            item['url'] = signed_put('binding.json', item['size'])
            return plan
        def wrong_limit(plan):
            item = plan['uploads'][-1]
            item['url'] = signed_put(item['name'], item['size'] + 1)
            return plan
        for mutation in (wrong_job, wrong_name, wrong_limit):
            with self.subTest(mutation=mutation.__name__), tempfile.TemporaryDirectory() as root:
                network = Network(self.result)
                network.mutate_plan = mutation
                client = RemoteClient(DEFAULT_CLOUD_URL, TOKEN, root, connection_factory=network.connect)
                with self.assertRaises(RemoteError):
                    client.evaluate(self.files)
                self.assertFalse(any(c.method == 'PUT' for c in network.calls))

    def test_bounded_json_no_redirects_gzip_or_expired_deadline(self):
        for response in (Response(302, {'error': TOKEN}), Response(raw=b'{' + b' ' * MAX_REPLY),
                         Response(raw=b'{"jobIds":[],"jobIds":[]}'), Response(raw=b'NaN'),
                         Response(value={}, encoding='gzip')):
            with self.subTest(status=response.status):
                with patch.object(self.network, 'connect', wraps=self.network.connect):
                    connection = self.network.connect('veil-procurement.vercel.app')
                    connection.getresponse = lambda: response
                    self.client._connect = lambda *a, **kw: connection
                    with self.assertRaises(RemoteError):
                        self.client._api('GET', 'session', time.monotonic() + 2)
        with self.assertRaises(RemoteError):
            self.client._api('GET', 'session', time.monotonic() - 1)


class RemoteServiceTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)

    def wait(self, state, job_id):
        deadline = time.monotonic() + 2
        while time.monotonic() < deadline:
            with state.lock:
                if state.active == 0:
                    return state.get_job(job_id)
            time.sleep(.005)
        self.fail('Scoped test worker did not finish')

    def test_remote_calls_actual_staged_api_and_keeps_local_default(self):
        calls = []
        transport = types.SimpleNamespace(evaluate=lambda files: {})
        class Prepared:
            def __enter__(self):
                return self
            def __exit__(self, *args):
                calls.append('close')
            def evaluate_remote(self, callback):
                calls.append(('remote', callback))
            def finalize(self):
                calls.append('finalize')
                return fake_pipeline(None, None)
        def prepare(records, job_dir, on_stage=None):
            calls.append(('prepare', copy.deepcopy(records)))
            for stage in ('ENCRYPTING', 'EVALUATING', 'VERIFYING'):
                on_stage(stage, PRIVATE)
            return Prepared()
        state = JobState(self.root, fake_pipeline, transport)
        self.addCleanup(state.close)
        with patch('service.server.importlib.import_module', return_value=types.SimpleNamespace(prepare_remote_job=prepare)):
            job = state.submit('TEST ONLY', RECORDS, 'remote')
            result = self.wait(state, job['id'])
        self.assertEqual(result['status'], 'COMPLETED')
        self.assertEqual(result['evaluation'], 'remote')
        self.assertIn(('remote', transport.evaluate), calls)
        self.assertIn('finalize', calls)
        self.assertNotIn(PRIVATE, json.dumps(result))
        caps = state.capabilities()
        self.assertEqual(caps['evaluationModes']['remote']['status'], 'test-only')
        self.assertFalse(state.remote_job_verified)
        self.assertFalse(state.real_job_verified)
        local = state.submit('DEFAULT TEST', RECORDS)
        self.assertEqual(self.wait(state, local['id'])['evaluation'], 'local')

    def test_remote_failure_never_exposes_exception_or_marks_success(self):
        state = JobState(self.root, remote_client=object())
        self.addCleanup(state.close)
        with patch('service.server.importlib.import_module', side_effect=RuntimeError(TOKEN + BLOB + PRIVATE)):
            job = state.submit('TEST', RECORDS, 'remote')
            result = self.wait(state, job['id'])
        self.assertEqual(result['status'], 'FAILED')
        self.assertNotIn(TOKEN, json.dumps(result))
        self.assertNotIn(BLOB, json.dumps(result))
        self.assertNotIn(PRIVATE, json.dumps(result))
        self.assertFalse(state.remote_job_verified)
        self.assertFalse(state.real_job_verified)
        self.assertEqual(state.capabilities()['evaluationModes']['remote']['status'], 'configured')

    def test_remote_http_preserves_csrf_origin_and_no_browser_credentials(self):
        server = create_server(port=0, runtime_dir=self.root, pipeline=fake_pipeline,
                               remote_client=object())
        thread = threading.Thread(target=server.serve_forever, kwargs={'poll_interval': .01}, daemon=True)
        thread.start()
        def request(method, path, payload=None, headers=None):
            conn = http.client.HTTPConnection(*server.server_address, timeout=2)
            try:
                body = None if payload is None else json.dumps(payload).encode()
                conn.request(method, path, body=body, headers=headers or {})
                reply = conn.getresponse()
                return reply.status, json.loads(reply.read())
            finally:
                conn.close()
        try:
            payload = {'title': 'TEST ONLY', 'records': RECORDS, 'evaluation': 'remote'}
            headers = {'Origin': server.origin, 'Content-Type': 'application/json',
                       'X-CSRF-Token': server.state.csrf_token}
            for changes in ({'Origin': 'https://attacker.invalid'}, {'X-CSRF-Token': 'bad'}):
                self.assertEqual(request('POST', '/api/jobs', payload, {**headers, **changes})[0], 403)
            for evaluation in (True, [], 'anything', None):
                self.assertEqual(request('POST', '/api/jobs', {**payload, 'evaluation': evaluation}, headers)[0], 400)
            self.assertEqual(server.state.list_jobs(), [])
            self.assertEqual(request('POST', '/api/demo', {}, headers)[0], 409)
            status, caps = request('GET', '/api/capabilities')
            self.assertEqual(status, 200)
            self.assertEqual(caps['evaluationModes']['remote']['status'], 'test-only')
            self.assertNotIn(TOKEN, json.dumps(caps))
            with patch('service.server.importlib.import_module', side_effect=RuntimeError(PRIVATE)):
                status, reply = request('POST', '/api/jobs', payload, headers)
                self.assertEqual(status, 201)
                self.assertEqual(self.wait(server.state, reply['job']['id'])['status'], 'FAILED')
        finally:
            server.shutdown()
            server.server_close()
            thread.join(timeout=2)

    def test_unconfigured_remote_rejected_and_configured_demo_disabled(self):
        state = JobState(self.root, fake_pipeline)
        self.addCleanup(state.close)
        with self.assertRaises(RequestError) as caught:
            state.submit('TEST', RECORDS, 'remote')
        self.assertEqual(caught.exception.status, 503)
        server = create_server(port=0, runtime_dir=self.root, remote_client=object())
        try:
            self.assertFalse(server.demo.enabled)
            from service.demo import DemoBusy
            with self.assertRaises(DemoBusy):
                server.demo.start()
            caps = json.dumps(server.state.capabilities())
            self.assertNotIn(TOKEN, caps)
            self.assertEqual(server.state.capabilities()['evaluationModes']['default'], 'local')
        finally:
            server.server_close()
