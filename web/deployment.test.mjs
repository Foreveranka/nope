import test from 'node:test';
import assert from 'node:assert/strict';
import { summaryPath, loadDeployment, checkCounts, recordedRun } from './deployment.mjs';

test('hosted summary path only permits same-origin asset paths', () => {
  assert.equal(summaryPath('/demo-evidence.json'), '/demo-evidence.json');
  for (const value of ['https://other.test/data', '//other.test/data', '/\\other.test', '/a/../secret', '/%2e%2e/data', '/data?remote=x', undefined]) assert.throws(() => summaryPath(value));
});
test('checks count only strict actual pass/fail booleans; absent data is unknown', () => {
  assert.deepEqual(checkCounts([{ pass: true }, { pass: false }, { pass: 'true' }, null]), { total: 4, passed: 1, failed: 1, unknown: 2 });
  assert.equal(checkCounts(undefined), null);
  assert.deepEqual(checkCounts([]), { total: 0, passed: 0, failed: 0, unknown: 0 });
});
test('recorded evidence supports direct sanitized result and run envelope', () => {
  const summary = { completed: true, checks: [{ name: 'actual check', pass: true }], real_fhe: true };
  const recorded = recordedRun(summary);
  assert.equal(recorded.result, summary);
  assert.equal(recorded.status, 'completed');
  assert.deepEqual(recorded.events, []);
  assert.equal(recordedRun({ run: recorded }), recorded);
  assert.equal(recordedRun({ completed: false }).status, 'failed');
  assert.throws(() => recordedRun({ completed: 'true' }));
});
test('deployment detection makes no companion API calls and chooses local only on 404', async () => {
  const original = globalThis.fetch;
  const urls = [];
  try {
    globalThis.fetch = async url => { urls.push(url); return { status: 404 }; };
    assert.deepEqual(await loadDeployment(), { mode: 'local' });
    globalThis.fetch = async url => { urls.push(url); return { status: 200, ok: true, json: async () => ({ mode: 'hosted-evidence', summaryUrl: '/demo-evidence.json' }) }; };
    assert.deepEqual(await loadDeployment(), { mode: 'hosted-evidence', summaryUrl: '/demo-evidence.json' });
    globalThis.fetch = async () => ({ status: 500, ok: false });
    await assert.rejects(loadDeployment());
    globalThis.fetch = async () => ({ status: 200, ok: true, json: async () => ({ mode: 'unknown' }) });
    await assert.rejects(loadDeployment());
    assert.deepEqual(urls, ['/deployment.json', '/deployment.json']);
  } finally { globalThis.fetch = original; }
});
