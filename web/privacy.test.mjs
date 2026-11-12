import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { mountPrivacy, canStart, completionVerified, formatYocto, isLocalOrigin, recordedRun, transactionURL, validateRun } from './privacy.js';

const html = fs.readFileSync(new URL('./privacy.html', import.meta.url), 'utf8');
const HASH = 'AC3k2wAdm5ADwhT7vniXCH8XDAN6fkNd8pSdN6omU5Tz';
const PAYMENT_HASH = 'CSEhBWNyGKdcJD6xNmWJV7QYyXGrMc2uf3Ar4Gw6Dx7F';
const clone = value => structuredClone(value);
function completed() {
  return { id: 'synthetic-run', status: 'completed', events: [{ stage: 'payment_verified', elapsed_seconds: 37.25 }], result: {
    completed: true, synthetic_only: true, network: 'testnet', job_id: '3', selected_executor: 'p2.example.testnet',
    real_fhe: true, real_mpc: true, independent_operators: false, execution_proof: false,
    payment: { verified: true, amountYocto: '1000000000000000000000', transactionHash: PAYMENT_HASH, mpcPriceProven: false },
    checks: [{ name: 'Actual fixture reference', pass: true }], transactions: [{ command: 'create_job', hash: HASH }],
    verified_synthetic_records: [{ id: 7, value: 0, duplicate: false }, { id: 2, value: 100, duplicate: false }, { id: 7, value: 42, duplicate: true }, { id: 3, value: 5, duplicate: false }],
  } };
}

// Deliberately no HTML parser: executable markup sinks fail immediately. This
// exercises the production renderer and controls, rather than a copy of them.
class Node {
  constructor(tag = 'div') { this.tagName = tag.toUpperCase(); this.children = []; this.dataset = {}; this.listeners = {}; this.hidden = false; this.disabled = false; this.checked = false; this.className = ''; this.ownText = ''; }
  set textContent(value) { this.ownText = String(value); this.children = []; }
  get textContent() { return this.ownText + this.children.map(c => c.textContent).join(''); }
  set innerHTML(_) { throw new Error('Unsafe HTML sink used'); }
  insertAdjacentHTML() { throw new Error('Unsafe HTML sink used'); }
  append(...nodes) { this.children.push(...nodes); }
  replaceChildren(...nodes) { this.ownText = ''; this.children = [...nodes]; }
  addEventListener(name, fn) { this.listeners[name] = fn; }
}
function harness(origin = 'http://127.0.0.1:8765') {
  const nodes = new Map([...html.matchAll(/id="(privacy-[^"]+)"/g)].map(m => [m[1], new Node()]));
  const calls = [], replies = [], timers = new Map(); let sequence = 0;
  const doc = { getElementById: id => { assert.ok(nodes.has(id), `Unknown HTML id ${id}`); return nodes.get(id); }, createElement: tag => new Node(tag) };
  const app = mountPrivacy({ document: doc, origin,
    fetch: async (url, options) => {
      calls.push({ url, options });
      assert.equal(options.credentials, 'same-origin'); assert.equal(options.redirect, 'error');
      assert.match(url, /^\/(api\/(privacy-demo|capabilities)|privacy-evidence\.json)$/);
      assert.ok(replies.length, `Unexpected fetch: ${url}`);
      const next = replies.shift();
      if (typeof next === 'function') return next(url, options);
      if (next instanceof Error) throw next;
      return { ok: next.status >= 200 && next.status < 300, status: next.status, json: async () => clone(next.data) };
    }, setTimer: fn => { const id = ++sequence; timers.set(id, fn); return id; }, clearTimer: id => timers.delete(id),
  });
  const $ = id => nodes.get(`privacy-${id}`);
  const queue = (data, status = 200) => replies.push({ data, status });
  const ready = async () => { queue({ enabled: true, run: null }); queue({ csrfToken: 'csrf-from-capabilities' }); await app.refresh(); };
  return { app, $, queue, ready, replies, calls, timers, nodes };
}
function descendants(node) { return [node, ...node.children.flatMap(descendants)]; }

test('loopback and explorer URL boundaries reject untrusted origins and transaction markup', () => {
  for (const value of ['http://127.0.0.1:8000', 'https://localhost:443', 'http://[::1]:8765']) assert.equal(isLocalOrigin(value), true);
  for (const value of ['http://localhost.evil.test', 'https://example.test', 'file:///privacy', 'http://127.0.0.2', 'http://user@localhost']) assert.equal(isLocalOrigin(value), false);
  assert.equal(transactionURL(HASH, 'testnet'), `https://testnet.nearblocks.io/txns/${HASH}`);
  for (const hash of ['javascript:alert(1)', '<img src=x onerror=alert(1)>', '0'.repeat(44), 'z'.repeat(44), undefined]) assert.equal(transactionURL(hash, 'testnet'), null);
  assert.equal(transactionURL(HASH, 'mainnet'), null);
  assert.equal(formatYocto('1000000000000000000000'), '0,001 test NEAR (1000000000000000000000 yoctoNEAR)');
  assert.equal(formatYocto('1'), '0,000000000000000000000001 test NEAR (1 yoctoNEAR)');
  assert.equal(formatYocto(1e21), 'Tutar bildirilmedi');
});

test('completion requires genuine testnet, synthetic-only, fixed verified payment and successful checks', () => {
  const good = completed(); assert.equal(completionVerified(good), true);
  for (const [field, value] of [['completed', false], ['synthetic_only', false], ['network', 'mainnet'], ['real_fhe', false], ['real_mpc', false], ['independent_operators', true], ['execution_proof', true], ['checks', []], ['transactions', []]]) {
    const run = clone(good); run.result[field] = value; assert.equal(completionVerified(run), false, field);
  }
  for (const [field, value] of [['verified', false], ['amountYocto', '80000000'], ['transactionHash', 'bad'], ['mpcPriceProven', true]]) {
    const run = clone(good); run.result.payment[field] = value; assert.equal(completionVerified(run), false, field);
  }
  const run = completed(); run.result.checks.push({ pass: 'true' }); assert.equal(completionVerified(run), false);
});

test('API first, CSRF from capabilities, explicit consent and exactly one empty-body POST', async () => {
  const h = harness(); await h.ready();
  assert.deepEqual(h.calls.map(c => c.url), ['/api/privacy-demo', '/api/capabilities']);
  assert.equal(h.$('start').disabled, true); await h.app.start(); assert.equal(h.calls.length, 2);
  h.$('consent').checked = true; h.app.render(); assert.equal(h.$('start').disabled, false);
  h.queue({ enabled: true, run: { id: 'one', status: 'running', events: [{ stage: 'fhe_prepare_started', elapsed_seconds: 0 }] } }, 201);
  await Promise.all([h.app.start(), h.app.start()]);
  const mutations = h.calls.filter(c => c.options.method === 'POST'); assert.equal(mutations.length, 1);
  assert.equal(mutations[0].url, '/api/privacy-demo'); assert.equal(mutations[0].options.body, '{}');
  assert.equal(mutations[0].options.headers['X-CSRF-Token'], 'csrf-from-capabilities');
  assert.equal(h.$('consent').checked, false); assert.equal(h.$('consent-field').disabled, true);
  assert.match(h.$('events').textContent, /FHE girdisi şifreleniyor/); assert.match(h.$('time').textContent, /0 sn/);
  assert.equal(h.timers.size, 1);
  h.queue({ enabled: true, run: completed() }); h.queue({ csrfToken: 'fresh-csrf' }); await h.app.refresh();
  assert.equal(h.$('status').textContent, 'Tamamlandı · testnet'); assert.equal(h.$('start').disabled, true);
  assert.equal(h.timers.size, 0); assert.equal(h.$('consent-field').disabled, true);
  h.$('consent').checked = true; await h.app.start(); assert.equal(h.calls.filter(c => c.options.method === 'POST').length, 1);
  assert.match(h.$('check-count').textContent, /1\/1 geçti/);
  const links = descendants(h.$('transactions')).filter(n => n.tagName === 'A');
  assert.equal(links.length, 2); for (const a of links) { assert.match(a.href, /^https:\/\/testnet\.nearblocks\.io\/txns\//); assert.equal(a.rel, 'noopener noreferrer'); }
});

test('hosted 404 loads explicitly labelled recorded evidence, never capabilities or mutation', async () => {
  const h = harness('https://public.example'); h.queue({}, 404); h.queue({ run: completed() }); await h.app.refresh();
  assert.deepEqual(h.calls.map(c => c.url), ['/api/privacy-demo', '/privacy-evidence.json']);
  assert.equal(h.app.state.mode, 'replay'); assert.equal(h.$('replay').hidden, false);
  assert.equal(h.$('status').textContent, 'Kayıtlı çalışma tamamlandı'); assert.equal(h.$('setup').hidden, false);
  h.$('consent').checked = true; await h.app.start(); assert.equal(h.calls.length, 2); assert.equal(h.timers.size, 0);
});

test('server errors, offline state and malformed API never turn into recorded success', async () => {
  for (const response of [{ status: 500, data: {} }, { status: 403, data: {} }, new Error('offline'), { status: 200, data: {} }]) {
    const h = harness('https://public.example'); h.replies.push(response); await h.app.refresh();
    assert.equal(h.calls.length, 1); assert.equal(h.app.state.fresh, false); assert.equal(h.$('start').disabled, true);
    assert.equal(h.$('status').textContent, 'Durum doğrulanamıyor'); assert.equal(h.$('replay').hidden, true);
  }
  const h = harness(); h.queue({}, 404); await h.app.refresh(); assert.equal(h.calls.length, 1); assert.equal(h.app.state.mode, 'unavailable');
});

test('missing or invalid evidence never claims completion or invents a run', async () => {
  for (const reply of [{ status: 404, data: {} }, { status: 200, data: { completed: 'true' } }, { status: 200, data: { run: { id: 'old', status: 'running', events: [] } } }]) {
    const h = harness('https://public.example'); h.queue({}, 404); h.replies.push(reply); await h.app.refresh();
    assert.equal(h.app.state.run, null); assert.equal(h.app.state.fresh, false); assert.equal(h.$('status').textContent, 'Durum doğrulanamıyor');
  }
});

test('disabled API, unavailable CSRF and public enabled API all block execution', async () => {
  const disabled = harness(); disabled.queue({ enabled: false, run: null }); await disabled.app.refresh();
  assert.equal(disabled.calls.length, 1); assert.equal(disabled.$('start').disabled, true); assert.equal(disabled.$('setup').hidden, false);
  const csrf = harness(); csrf.queue({ enabled: true, run: null }); csrf.queue({ csrfToken: '' }); await csrf.app.refresh();
  assert.equal(csrf.$('start').disabled, true); assert.equal(csrf.app.state.fresh, false);
  const remote = harness('https://public.example'); remote.queue({ enabled: true, run: null }); await remote.app.refresh();
  assert.equal(remote.calls.length, 1); assert.equal(remote.$('start').disabled, true); assert.equal(remote.app.state.fresh, false);
});

test('lost POST reply is reconciled by GET and never retried, including an empty snapshot', async () => {
  const h = harness(); await h.ready(); h.$('consent').checked = true; h.replies.push(new Error('connection lost')); await h.app.start();
  assert.equal(h.app.state.uncertain, true); assert.equal(h.$('start').disabled, true);
  h.queue({ enabled: true, run: null }); h.queue({ csrfToken: 'token' }); await h.app.refresh();
  assert.equal(h.app.state.uncertain, true); assert.equal(h.$('start').disabled, true); assert.equal(h.timers.size, 1);
  h.$('consent').checked = true; await h.app.start(); assert.equal(h.calls.filter(c => c.options.method === 'POST').length, 1);
  h.queue({ enabled: true, run: { id: 'recovered', status: 'failed', events: [], error: 'Güvenli hata' } }); h.queue({ csrfToken: 'token' }); await h.app.refresh();
  assert.equal(h.$('status').textContent, 'Başarısız'); assert.equal(h.$('consent-field').disabled, true); assert.equal(h.timers.size, 0);
});

test('all terminal runs remain read only, and interrupted runs are never complete', async () => {
  for (const status of ['completed', 'failed', 'interrupted']) {
    const h = harness(); const run = completed(); run.status = status;
    h.queue({ enabled: true, run }); h.queue({ csrfToken: 'token' }); await h.app.refresh();
    h.$('consent').checked = true; h.app.render(); assert.equal(h.$('start').disabled, true); await h.app.start(); assert.equal(h.calls.length, 2);
    assert.equal(canStart(h.app.state, true, true), false);
    if (status !== 'completed') assert.notEqual(h.$('status').dataset.tone, 'success');
  }
});

test('plaintext remains hidden by default; output comes only from returned verified records', async () => {
  const h = harness(); await h.ready();
  assert.doesNotMatch(h.$('records').textContent, /255|144|42/); assert.doesNotMatch(h.$('bids').textContent, /90\.000\.000|80\.000\.000/);
  h.$('reveal').checked = true; h.app.render(); assert.match(h.$('records').textContent, /255/); assert.equal(h.$('output').textContent, '');
  const run = completed(); run.result.verified_synthetic_records[0].value = 17;
  h.queue({ enabled: true, run }); h.queue({ csrfToken: 'token' }); await h.app.refresh();
  assert.equal(h.$('output').children[0].children[2].children[0].children[1].textContent, '17');
  h.$('reveal').checked = false; h.app.render(); assert.equal(h.$('output').textContent, '');
  delete run.result.verified_synthetic_records;
  h.queue({ enabled: true, run }); h.queue({ csrfToken: 'token' }); await h.app.refresh();
  h.$('reveal').checked = true; h.app.render(); assert.equal(h.$('output').textContent, '');
});

test('API strings are rendered as text and hostile transaction URLs never become links', async () => {
  const payload = '<img src=x onerror="globalThis.pwned=true">';
  const h = harness(); const run = completed(); run.id = payload; run.events[0].stage = payload;
  run.result.selected_executor = payload; run.result.checks[0].name = payload;
  run.result.transactions = [{ label: payload, hash: 'javascript:alert(1)' }]; run.result.payment.transactionHash = payload;
  h.queue({ enabled: true, run }); h.queue({ csrfToken: 'token' }); await h.app.refresh();
  assert.match(h.$('run-id').textContent, /<img/); assert.match(h.$('events').textContent, /<img/); assert.match(h.$('facts').textContent, /<img/);
  assert.match(h.$('checks').textContent, /<img/); assert.equal(descendants(h.$('transactions')).filter(n => n.tagName === 'A').length, 0);
  assert.equal(h.$('status').textContent, 'Tamamlanma doğrulanamadı'); assert.equal(globalThis.pwned, undefined);
  h.queue({ enabled: true, run: { id: 'failure', status: 'failed', events: [], error: payload } }); h.queue({ csrfToken: 'token' }); await h.app.refresh();
  assert.equal(h.$('message').textContent, payload);
});

test('a stale completed response loses success status and is identified as last-known information', async () => {
  const h = harness(); h.queue({ enabled: true, run: completed() }); h.queue({ csrfToken: 'token' }); await h.app.refresh();
  assert.equal(h.$('status').dataset.tone, 'success'); h.queue({}, 500); await h.app.refresh();
  assert.equal(h.$('status').textContent, 'Durum doğrulanamıyor'); assert.notEqual(h.$('status').dataset.tone, 'success');
  assert.match(h.$('run-id').textContent, /son bilinen durum/); assert.match(h.$('result-note').textContent, /Güncel durum doğrulanamadı/);
});

test('run schema rejects invalid measurements; recorded direct and envelope results stay labelled by caller', () => {
  assert.equal(validateRun(null), null); assert.equal(recordedRun({ run: completed() }).status, 'completed');
  assert.equal(recordedRun(completed().result).result.network, 'testnet');
  assert.throws(() => validateRun({ id: 'x', status: 'complete', events: [] }));
  for (const elapsed_seconds of [-1, Infinity, NaN, '1']) assert.throws(() => validateRun({ id: 'x', status: 'running', events: [{ stage: 'prepared', elapsed_seconds }] }));
});

test('page disposal prevents late requests from restoring controls or scheduling polls', async () => {
  const h = harness(); let resolve;
  h.replies.push(() => new Promise(r => { resolve = r; }));
  const pending = h.app.refresh(); h.app.dispose();
  resolve({ ok: true, status: 200, json: async () => ({ enabled: true, run: null }) }); await pending;
  assert.equal(h.app.state.fresh, false); assert.equal(h.calls.length, 1); assert.equal(h.timers.size, 0);
});

test('HTML keeps synthetic reveal opt-in, verified package path and owner-only launch guidance', () => {
  assert.match(html, /id="privacy-reveal" type="checkbox" aria-controls=/);
  assert.doesNotMatch(html, /id="privacy-reveal"[^>]*checked/);
  assert.match(html, /href="\/nope-client\.zip"/); assert.doesNotMatch(html, /\/downloads\/nope-client/);
  assert.match(html, /\.venv\/bin\/python scripts\/privacy-demo-launch\.py/);
  assert.match(html, /Bu ZIP tam gizlilik demosunu çalıştırmaz/);
  assert.match(html, /href="https:\/\/veil-procurement\.vercel\.app\/testnet" target="_blank" rel="noopener noreferrer"/);
});
