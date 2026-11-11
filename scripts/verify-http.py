"""Real HTTP/FHE integration check. Synthetic input only; no secrets in report."""
import argparse
import json
import time
import urllib.error
import urllib.request
from pathlib import Path


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--base', default='http://127.0.0.1:8765')
    parser.add_argument('--report', default='runtime/http-fhe-check.json')
    parser.add_argument('--timeout', type=float, default=600)
    args = parser.parse_args()
    checks = []

    def request(path, method='GET', payload=None, headers=None):
        data = None if payload is None else json.dumps(payload).encode()
        h = {'Content-Type': 'application/json'} if data else {}
        h.update(headers or {})
        req = urllib.request.Request(args.base + path, data=data, method=method, headers=h)
        try:
            with urllib.request.urlopen(req, timeout=15) as res:
                return res.status, res.read(), res.headers
        except urllib.error.HTTPError as err:
            return err.code, err.read(), err.headers

    def check(name, condition):
        checks.append({'name': name, 'pass': bool(condition)})
        if not condition:
            raise AssertionError(name)

    report = {'scope': 'synthetic real HTTP -> Concrete ciphertext evaluation -> client verification',
              'checks': checks, 'production_security_audit': False}
    started = time.monotonic()
    try:
        status, body, headers = request('/')
        check('landing served', status == 200 and b'<html' in body.lower())
        check('CSP set', bool(headers.get('Content-Security-Policy')))
        status, body, _ = request('/app')
        check('application served', status == 200 and b'<html' in body.lower())
        status, body, headers = request('/api/capabilities')
        caps = json.loads(body)
        check('capabilities + CSRF', status == 200 and bool(caps.get('csrfToken')))
        check('sensitive data not cached', 'no-store' in headers.get('Cache-Control', ''))
        token = caps['csrfToken']
        good_headers = {'X-CSRF-Token': token, 'Origin': args.base}
        fixture = {'title': 'Sentetik uçtan uca doğrulama', 'records': [
            {'id': 10, 'value': 255}, {'id': 20, 'value': 42},
            {'id': 10, 'value': 150}, {'id': 30, 'value': 100}]}
        status, _, _ = request('/api/jobs', 'POST', fixture)
        check('mutation without CSRF rejected', status in (400, 403))
        status, _, _ = request('/api/jobs', 'POST', fixture,
                                {'X-CSRF-Token': token, 'Origin': 'https://attacker.invalid'})
        check('foreign origin rejected', status == 403)
        status, _, _ = request('/api/capabilities', headers={'Host': 'attacker.invalid'})
        check('DNS rebinding host rejected', status in (400, 403, 421))
        invalid = {'title': 'Invalid', 'records': [{'id': True, 'value': 0}] * 4}
        status, _, _ = request('/api/jobs', 'POST', invalid, good_headers)
        check('boolean integer confusion rejected', status in (400, 422))
        status, _, _ = request('/api/jobs', 'POST', {'title': 'x', 'records': fixture['records'][:3]}, good_headers)
        check('wrong record count rejected', status in (400, 422))
        for path in ['/../AGENTS.md', '/.git/config', '/runtime/', '/service/server.py']:
            status, _, _ = request(path)
            check('private path denied: ' + path, status in (400, 403, 404))
        status, body, _ = request('/api/jobs', 'POST', fixture, good_headers)
        check('real job accepted', status == 201)
        job_id = json.loads(body)['job']['id']
        deadline = time.monotonic() + args.timeout
        while time.monotonic() < deadline:
            status, body, _ = request('/api/jobs/' + job_id)
            check_status = status == 200
            if not check_status:
                raise AssertionError('job polling failed')
            job = json.loads(body)['job']
            if job['status'] in ('COMPLETED', 'FAILED'):
                break
            time.sleep(2)
        else:
            raise TimeoutError('Real FHE job exceeded bounded timeout')
        check('real FHE completed', job['status'] == 'COMPLETED')
        result = job['result']
        expected = [{'id': 10, 'value': 0, 'duplicate': False},
                    {'id': 20, 'value': 42, 'duplicate': False},
                    {'id': 10, 'value': 100, 'duplicate': True},
                    {'id': 30, 'value': 100, 'duplicate': False}]
        check('client output exactly matches independent reference', result['records'] == expected)
        check('reference verification flag true', result['verified'] is True)
        stages = {event['stage'] for event in job['events']}
        check('real lifecycle stage events', {'ENCRYPTING', 'EVALUATING', 'VERIFYING'} <= stages)
        check('encrypted artifact binding recorded', bool(job.get('artifactHashes')))
        report.update({'jobId': job_id, 'metrics': job.get('metrics'),
                       'artifactHashes': job.get('artifactHashes'), 'completed': True})
    finally:
        report['elapsedSeconds'] = round(time.monotonic() - started, 3)
        dest = Path(args.report)
        dest.parent.mkdir(parents=True, exist_ok=True)
        dest.write_text(json.dumps(report, ensure_ascii=False, indent=2) + '\n')
        print(json.dumps(report, ensure_ascii=False, indent=2))


if __name__ == '__main__':
    main()
