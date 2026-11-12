import test from 'node:test';
import assert from 'node:assert/strict';
import { createWorkspace, createPayload, decisionAllowed, routeOf, TOKEN_KEY, PROFILE, testnetAccount } from './workspace.js';
import { createGarbledJob } from './gc-client.mjs';
import { hashRequest, hashOutput, hashProgram } from './gc-core.mjs';
import { executeTask } from '../workspace/gc.mjs';

const id = 'a'.repeat(32), session = { id: 'buyer-identity', role: 'buyer', displayName: 'Test buyer', paymentAccount: null };
const provider = { id: 'provider-identity', role: 'provider', displayName: 'Test provider', paymentAccount: 'p2.veil-reg-e138f5c88250f821.testnet' };
const baseJob = { id, buyerId: session.id, title: '<img src=x onerror=alert(1)>', description: 'Test cleanup', status: 'OPEN', rowCount: 2, profile: PROFILE, deadlineISO: new Date(Date.now() + 3600000).toISOString(), offers: [], events: [] };
class Element {
  constructor(tag) { this.tagName = tag.toUpperCase(); this.children = []; this.listeners = {}; this.dataset = {}; this.attributes = {}; this.value = ''; this.disabled = false; this.files = []; }
  set textContent(v) { this.text = String(v); this.children = []; }
  get textContent() { return (this.text || '') + this.children.map(x => x.textContent).join(' '); }
  append(...nodes) { for (const node of nodes) { if (node.parentElement) node.parentElement.children = node.parentElement.children.filter(x => x !== node); node.parentElement = this; this.children.push(node); if (this.tagName === 'SELECT' && this.children.length === 1) this.value = node.value; } }
  replaceChildren(...nodes) { this.children.forEach(n => n.parentElement = null); this.children = []; this.text = ''; this.append(...nodes); }
  addEventListener(name, fn) { (this.listeners[name] ||= []).push(fn); }
  setAttribute(k, v) { this.attributes[k] = v; }
  removeAttribute(k) { delete this.attributes[k]; }
  reportValidity() { return true; }
  async fire(type, event = {}) { for (const fn of this.listeners[type] || []) await fn({ preventDefault() {}, button: 0, ...event }); }
}
function descendants(node) { return [node, ...node.children.flatMap(descendants)]; }
async function settle(app) { for (let i = 0; i < 10000 && app.state.busy; i++) await new Promise(resolve => setTimeout(resolve, 1)); assert.equal(app.state.busy, false, 'UI action settled'); }
function harness({ path = '/customer', identity = session, job = baseJob, local = null, decoded, fetchHook, failVault = false, token = 'scoped-token' } = {}) {
  const elements = new Map(['workspace-root', 'workspace-nav', 'workspace-identity', 'workspace-message', 'workspace-logout', 'workspace-heading', 'workspace-subtitle'].map(k => [k, new Element('div')]));
  const events = {}, calls = [], order = [], records = new Map(), decoders = new Set(); if (local) records.set(id, local);
  const storageMap = new Map(token ? [[TOKEN_KEY, token]] : []);
  const storage = { getItem: k => storageMap.get(k), setItem: (k, v) => storageMap.set(k, v), removeItem: k => storageMap.delete(k) };
  const win = { location: new URL('http://localhost' + path), sessionStorage: storage, addEventListener: (k, fn) => events[k] = fn, navigator: { clipboard: { writeText: async () => {} } }, URL, setTimeout,
    history: { pushState: (_, __, href) => win.location = new URL(href, win.location), replaceState: (_, __, href) => win.location = new URL(href, win.location) } };
  const doc = { getElementById: k => elements.get(k), createElement: tag => new Element(tag), addEventListener: (k, fn) => events['doc-' + k] = fn,
    querySelectorAll: () => [...descendants(elements.get('workspace-root')).filter(n => ['BUTTON', 'INPUT', 'SELECT', 'TEXTAREA'].includes(n.tagName)), elements.get('workspace-logout')] };
  const vault = { buyerPublicKey: async () => ({ kty: 'RSA', n: 'public-only' }), saveJob: async (k, v) => { if (failVault) throw Error('IDB unavailable'); order.push('local:' + k); records.set(k, structuredClone(v)); }, loadJob: async k => records.get(k) || null,
    saveDecoder: async k => { if (failVault) throw Error('no decoder'); order.push('decoder:' + k); decoders.add(k); }, decodeDelivery: async () => { if (!decoded) throw Error('missing decoder'); return decoded; }, decryptQuote: async () => { throw Error('missing buyer key'); }, encryptQuote: async () => ({ wrappedKey: 'opaque', iv: 'opaque', ciphertext: 'opaque' }) };
  const app = createWorkspace({ document: doc, window: win, storage, vaultFactory: () => vault, fetch: async (wireUrl, options) => {
    const parsed = new URL(wireUrl, 'http://localhost');
    assert.equal(parsed.pathname, '/api/workspace'); assert.equal(parsed.searchParams.getAll('route').length, 1);
    const route = parsed.searchParams.get('route'); parsed.searchParams.delete('route');
    const url = '/api/workspace/' + route + (parsed.search ? parsed.search : '');
    calls.push({ url, wireUrl, options, body: options.body ? JSON.parse(options.body) : undefined }); order.push('network:' + options.method + ':' + url);
    const call = calls.at(-1); const result = fetchHook && await fetchHook(call); if (result) return result;
    let body = url.endsWith('/session') ? { session: identity } : url === '/api/workspace/jobs' && options.method === 'GET' ? { jobs: [job] } : { job };
    if (url === '/api/workspace/jobs' && options.method === 'POST') body = { job: { ...job, id: call.body.jobId } };
    return { ok: true, status: 200, json: async () => body };
  } });
  const all = () => descendants(elements.get('workspace-root'));
  return { app, elements, win, doc, records, decoders, calls, order, events, storageMap, all,
    get: name => all().find(e => e.name === name), text: () => elements.get('workspace-root').textContent,
    click: async text => { const b = all().find(e => e.tagName === 'BUTTON' && e.textContent === text); assert.ok(b, text); await b.fire('click'); await settle(app); },
    submit: async () => { const form = all().find(e => e.tagName === 'FORM'); assert.ok(form); await form.fire('submit'); await settle(app); },
    upload: async () => { const csv = 'private-header,value\nsecret-A,154\nsecret-B,\n'; const f = all().find(e => e.type === 'file'); f.files = [{ size: csv.length, arrayBuffer: async () => new TextEncoder().encode(csv).buffer }]; await f.fire('change'); await settle(app); }
  };
}
test('routes are exact and same-origin; query strings do not become authorization', () => {
  for (const path of ['/workspace', '/customer', '/provider', '/jobs/new', '/jobs', '/job', '/offer', '/delivery', '/payments', '/activity', '/settings']) assert.equal(routeOf(path).path, path);
  assert.equal(routeOf('https://attacker.invalid/job?id=x'), null);
  assert.equal(routeOf('/jobs/fake'), null);
  assert.deepEqual(routeOf('/job?id=' + id + '&token=evil'), { path: '/job', id });
});
test('publish payload allowlists fields and excludes CSV, header, filename, budget and decoder', () => {
  const task = { profile: PROFILE, rowCount: 2, rows: ['ciphertext'] };
  const payload = createPayload({ jobId: id, title: 'Cleanup', description: '', deadlineISO: '2026-12-01T00:00:00Z', task, buyerPublicKey: { kty: 'RSA' }, values: [154, 255], headers: ['private'], filename: 'secret.csv', hiddenBudget: '5', decoder: 'secret' });
  assert.deepEqual(Object.keys(payload).sort(), ['buyerPublicKey', 'deadlineISO', 'description', 'jobId', 'profile', 'rowCount', 'task', 'title']);
  assert.equal(JSON.stringify(payload).includes('secret'), false);
  assert.throws(() => createPayload({ jobId: 'wrong', task }));
});
test('decision gate binds owner, delivered status, locally correct result, version and output hash', () => {
  const job = { ...baseJob, status: 'DELIVERED', delivery: { version: 2, outputSha256: 'b'.repeat(64) } };
  const verified = { correct: true, ...job.delivery };
  assert.equal(decisionAllowed(job, verified, session), true);
  for (const value of [null, { ...verified, correct: false }, { ...verified, version: 1 }, { ...verified, outputSha256: 'c'.repeat(64) }]) assert.equal(decisionAllowed(job, value, session), false);
  assert.equal(decisionAllowed(job, verified, provider), false);
  assert.equal(decisionAllowed({ ...job, buyerId: 'someone-else' }, verified, session), false);
  assert.equal(decisionAllowed({ ...job, status: 'ACCEPTED' }, verified, session), false);
});
test('testnet account validation permits explicit testnet and implicit hex only', () => {
  assert.equal(testnetAccount(provider.paymentAccount), true); assert.equal(testnetAccount('b'.repeat(64)), true);
  for (const a of ['person.near', 'person', 'https://testnet.testnet', 'bad..testnet', '.testnet']) assert.equal(testnetAccount(a), false);
});
test('refresh restores API-authenticated role and uses app-scoped token only in header', async () => {
  const h = harness(); await h.app.start();
  assert.equal(h.app.state.session.role, 'buyer'); assert.equal(h.calls[0].url, '/api/workspace/session');
  assert.equal(h.calls[0].options.headers.Authorization, 'Bearer scoped-token');
  assert.ok(h.calls.every(c => !c.url.includes('scoped-token'))); assert.equal(h.storageMap.get(TOKEN_KEY), 'scoped-token');
  assert.ok(h.text().includes('<img src=x onerror=alert(1)>')); assert.equal(h.all().some(e => e.tagName === 'IMG'), false);
});
test('route guards prevent provider publishing and SPA navigation keeps authenticated identity', async () => {
  const h = harness({ path: '/jobs/new', identity: provider }); await h.app.start();
  assert.match(h.text(), /mevcut oturum rol/); assert.equal(h.get('csv'), undefined);
  await h.app.navigate('/provider'); assert.equal(h.win.location.pathname, '/provider'); assert.equal(h.app.state.session.id, provider.id);
  assert.equal(h.calls.filter(c => c.url.endsWith('/session')).length, 1);
});
test('CSV publish durably saves local source and decoder before network; no plaintext metadata leaves', async () => {
  const h = harness({ path: '/jobs/new' }); await h.app.start(); await h.upload();
  h.get('title').value = 'Synthetic cleanup'; h.get('description').value = 'Fixed test profile'; h.get('hiddenBudget').value = '5';
  const submit = h.all().find(e => e.type === 'submit'); assert.equal(submit.disabled, false, 'upload unlocks publish');
  await h.submit(); const post = h.calls.find(c => c.url === '/api/workspace/jobs' && c.options.method === 'POST'); assert.ok(post);
  const jobId = post.body.jobId; assert.match(jobId, /^[a-f0-9]{32}$/);
  assert.ok(h.order.indexOf('local:' + jobId) < h.order.indexOf('network:POST:/api/workspace/jobs'));
  assert.ok(h.order.indexOf('decoder:' + jobId) < h.order.indexOf('network:POST:/api/workspace/jobs'));
  const serialized = JSON.stringify(post.body); for (const secret of ['private-header', 'secret-A', 'secret-B', 'hiddenBudget', 'filename', 'decoder']) assert.equal(serialized.includes(secret), false, secret);
  assert.equal(h.records.get(jobId).hiddenBudget, '5'); assert.equal(h.records.get(jobId).pending, false);
  assert.equal(h.win.location.pathname, '/job'); assert.ok(h.all().filter(e => e.tagName === 'BUTTON').every(e => !e.disabled), 'rendered actions recover after mutation');
});
test('unavailable local vault prevents publication', async () => {
  const h = harness({ path: '/jobs/new', failVault: true }); await h.app.start(); await h.upload(); h.get('title').value = 'Test'; h.get('description').value = '';
  await h.submit(); assert.equal(h.calls.some(c => c.options.method === 'POST'), false);
});
test('uncertain publish retains exact identity and retry sends identical ciphertext/body', async () => {
  let failed = false;
  const h = harness({ path: '/jobs/new', fetchHook: async c => { if (!failed && c.options.method === 'POST') { failed = true; throw Error('connection lost'); } } });
  await h.app.start(); await h.upload(); h.get('title').value = 'Test'; await h.submit();
  const first = h.calls.find(c => c.options.method === 'POST'); assert.ok(first); assert.equal(h.app.state.uncertain, true);
  await h.click('Aynı kimlik ve içerikle güvenli tekrar dene');
  const posts = h.calls.filter(c => c.options.method === 'POST'); assert.equal(posts.length, 2); assert.deepEqual(posts[1].body, first.body); assert.equal(h.app.state.uncertain, false);
});
test('missing local decoder never offers accept and does not send a decision', async () => {
  const job = { ...baseJob, status: 'DELIVERED', delivery: { version: 1, outputs: [], outputSha256: 'b'.repeat(64) } };
  const h = harness({ path: '/delivery?id=' + id, job }); await h.app.start();
  assert.match(h.text(), /orijinal CSV veya çözme anahtarı yok/); assert.equal(h.all().some(e => e.textContent === 'Doğrulanan teslimi kabul et'), false);
  assert.equal(h.calls.some(c => c.url.endsWith('/decision')), false);
});
test('real garbled output is shown in-page and only matching delivery can be accepted', async () => {
  const gc = await createGarbledJob([154, 255]); const result = await executeTask(gc.request);
  const job = { ...baseJob, status: 'DELIVERED', delivery: { ...result, version: 1 } };
  const local = { values: [154, 255], dataset: { headers: ['v'], rows: [['154'], ['']], delimiter: ',' }, column: 0, payload: { task: gc.request } };
  const h = harness({ path: '/delivery?id=' + id, job, local, decoded: gc.decode(result.outputs) }); await h.app.start();
  assert.match(h.text(), /Yerel kontrol başarılı/); assert.match(h.text(), /ÖNCE/); assert.match(h.text(), /SONRA/);
  await h.click('Doğrulanan teslimi kabul et'); const call = h.calls.find(c => c.url.endsWith('/decision'));
  assert.deepEqual(call.body, { decision: 'accept', version: 1, outputSha256: result.outputSha256 });
  const mismatch = harness({ path: '/delivery?id=' + id, job: { ...job, delivery: { ...job.delivery, inputSha256: 'f'.repeat(64) } }, local, decoded: [100, 0] }); await mismatch.app.start();
  assert.match(mismatch.text(), /Yerel kontrol başarısız/); assert.equal(mismatch.all().some(e => e.textContent === 'Doğrulanan teslimi kabul et'), false);
  assert.equal(await hashRequest(gc.request), result.inputSha256); assert.equal(await hashOutput(result.outputs), result.outputSha256); assert.equal(await hashProgram(), result.programSha256);
});
test('payment verification posts exact account/hash and never marks paid for pending response', async () => {
  const job = { ...baseJob, status: 'ACCEPTED', payment: { status: 'DUE' }, selectedOffer: { providerId: provider.id, paymentAccount: provider.paymentAccount, amountYocto: '1000000000000000000000' } };
  const h = harness({ path: '/payments?id=' + id, job }); await h.app.start();
  h.get('buyerAccount').value = 'buyer.testnet'; h.get('transactionHash').value = 'A'.repeat(43); await h.submit();
  const post = h.calls.find(c => c.url.endsWith('/payment/verify')); assert.deepEqual(post.body, { buyerAccount: 'buyer.testnet', transactionHash: 'A'.repeat(43) });
  assert.match(h.elements.get('workspace-message').textContent, /henüz doğrulanmadı/); assert.equal(h.text().includes('PAID —'), false); assert.match(h.text(), /0.001 testNEAR/);
});
test('double click during mutation sends only one close request', async () => {
  let release; const pending = new Promise(resolve => release = resolve);
  const h = harness({ path: '/job?id=' + id, fetchHook: async c => { if (c.url.endsWith('/close')) { await pending; return { ok: true, json: async () => ({ job: { ...baseJob, status: 'CLOSED' } }) }; } } }); await h.app.start();
  const b = h.all().find(e => e.textContent === 'Teklifleri şimdi kapat'); const firstClick = b.fire('click'); await b.fire('click'); release(); await firstClick; await settle(h.app);
  assert.equal(h.calls.filter(c => c.url.endsWith('/close')).length, 1);
});
test('logout drops only app session token and never deletes vault contents', async () => {
  const h = harness({ local: { values: [42] } }); await h.app.start(); h.storageMap.set('another-app', 'keep');
  await h.elements.get('workspace-logout').fire('click'); await settle(h.app);
  assert.equal(h.storageMap.has(TOKEN_KEY), false); assert.equal(h.storageMap.get('another-app'), 'keep'); assert.deepEqual(h.records.get(id), { values: [42] }); assert.equal(h.win.location.pathname, '/workspace');
});
test('definitive rejected publication clears pending pointer while retaining CSV and decoder record', async () => {
  const h = harness({ path: '/jobs/new', fetchHook: async c => c.options.method === 'POST' ? { ok: false, status: 400, json: async () => ({ error: 'invalid', code: 'INVALID_DEADLINE' }) } : null });
  await h.app.start(); await h.upload(); h.get('title').value = 'Test'; await h.submit();
  const post = h.calls.find(c => c.options.method === 'POST'); assert.ok(post);
  assert.equal(h.app.state.uncertain, false); assert.equal(h.records.get('__pending_publish__').jobId, null);
  assert.deepEqual(h.records.get(post.body.jobId).values, [154, 255]); assert.ok(h.order.includes('decoder:' + post.body.jobId));
  assert.match(h.elements.get('workspace-message').textContent, /sunucu tarafından reddedildi/);
});
test('unsupported CSV columns are visibly labelled and disabled while valid column is selected', async () => {
  const h = harness({ path: '/jobs/new' }); await h.app.start(); await h.upload();
  const column = h.get('column'); assert.equal(column.children[0].disabled, true); assert.match(column.children[0].textContent, /desteklenmeyen sütun/);
  assert.equal(column.children[1].disabled, false); assert.equal(column.value, '1');
});
test('transient session failure retains token and offers retry without a new identity form', async () => {
  const h = harness({ fetchHook: async c => c.url.endsWith('/session') ? { ok: false, status: 503 } : null }); await h.app.start();
  assert.equal(h.storageMap.get(TOKEN_KEY), 'scoped-token'); assert.equal(h.all().some(e => e.tagName === 'FORM'), false); assert.match(h.text(), /Oturumu yeniden doğrula/);
});
test('pagination advances through returned cursors and hides action when complete', async () => {
  const h = harness({ fetchHook: async c => {
    if (c.url === '/api/workspace/jobs') return { ok: true, json: async () => ({ jobs: [baseJob], nextCursor: 'page2' }) };
    if (c.url.includes('cursor=')) return { ok: true, json: async () => ({ jobs: [], ...(c.url.endsWith('page2') ? { nextCursor: 'page3' } : {}) }) };
  } }); await h.app.start(); await h.click('Daha fazla iş'); await h.click('Daha fazla iş');
  assert.deepEqual(h.calls.filter(c => c.url.includes('cursor=')).map(c => c.url), ['/api/workspace/jobs?cursor=page2', '/api/workspace/jobs?cursor=page3']);
  assert.equal(h.all().find(e => e.textContent === 'Daha fazla iş').hidden, true);
});
test('provider offer sends only encrypted envelope and commitment; plaintext quote remains in local vault', async () => {
  const h = harness({ path: '/offer?id=' + id, identity: provider }); await h.app.start();
  h.get('amount').value = '0.001'; h.get('deliveryHours').value = '2'; h.get('note').value = 'private delivery note'; await h.submit();
  const post = h.calls.find(c => c.url.endsWith('/offers')); assert.ok(post);
  assert.deepEqual(Object.keys(post.body).sort(), ['commitment', 'envelope']); assert.match(post.body.commitment, /^[a-f0-9]{64}$/);
  assert.equal(JSON.stringify(post.body).includes('private delivery note'), false);
  const quote = h.records.get(id).ownQuote; assert.equal(quote.amountYocto, '1000000000000000000000'); assert.equal(quote.deliveryHours, 2); assert.equal(quote.note, 'private delivery note');
  assert.match(quote.salt, /^[a-f0-9]{64}$/); assert.equal(quote.providerId, provider.id);
});
test('lost publish then expired retry retains old attempt; explicit separate draft publishes new ID and dashboard can reconcile old ID', async () => {
  let attempts = 0, oldId;
  const h = harness({ path: '/jobs/new', fetchHook: async c => {
    if (c.url === '/api/workspace/jobs' && c.options.method === 'POST') {
      attempts++;
      if (attempts === 1) { oldId = c.body.jobId; throw Error('lost publish reply'); }
      if (attempts === 2) return { ok: false, status: 400, json: async () => ({ code: 'INVALID_DEADLINE' }) };
    }
    if (oldId && c.url === '/api/workspace/jobs/' + oldId && c.options.method === 'GET') return { ok: true, json: async () => ({ job: { ...baseJob, id: oldId } }) };
  } });
  await h.app.start(); await h.upload(); h.get('title').value = 'Old uncertain attempt'; await h.submit();
  const original = structuredClone(h.records.get(oldId));
  await h.click('Aynı kimlik ve içerikle güvenli tekrar dene');
  assert.equal(h.app.state.uncertain, true); assert.deepEqual(h.records.get('__pending_publish__').unresolvedJobIds, [oldId]);
  assert.match(h.elements.get('workspace-message').textContent, /Eski girişim doğrulanamadı/);
  await h.click('Eski girişimi koru ve ayrı yeni taslak aç');
  assert.equal(h.app.state.newDraftAllowed, false, 'warning acknowledgement is required'); assert.equal(attempts, 2);
  h.get('newDraftConsent').checked = true; await h.click('Eski girişimi koru ve ayrı yeni taslak aç');
  assert.equal(h.app.state.newDraftAllowed, true); assert.equal(attempts, 2, 'opening a draft never republishes');
  assert.equal(h.get('title').value, '', 'new draft starts empty');
  await h.upload(); h.get('title').value = 'Explicitly separate work'; await h.submit();
  const posts = h.calls.filter(c => c.url === '/api/workspace/jobs' && c.options.method === 'POST');
  assert.equal(posts.length, 3); assert.deepEqual(posts[1].body, posts[0].body, 'old retry is identical');
  assert.notEqual(posts[2].body.jobId, oldId); assert.equal(posts[2].body.title, 'Explicitly separate work');
  assert.deepEqual(h.records.get(oldId), original, 'old source and original payload stay untouched'); assert.equal(h.decoders.has(oldId), true);
  assert.deepEqual(h.records.get('__pending_publish__').unresolvedJobIds, [oldId], 'new success removes only its own pending ID');
  await h.app.navigate('/customer'); assert.match(h.text(), /Doğrulanmamış yayımlamalar/); assert.ok(h.text().includes(oldId));
  await h.click('Aynı işin durumunu kontrol et');
  assert.equal(attempts, 3, 'dashboard lookup is GET only'); assert.equal(h.win.location.search, '?id=' + oldId);
  assert.deepEqual(h.records.get('__pending_publish__').unresolvedJobIds, []); assert.equal(h.records.get(oldId).pending, false); assert.equal(h.decoders.has(oldId), true);
});
test('legacy pending pointer survives refresh, 404 lookup and explicit new uncertain attempt without losing either ID', async () => {
  const h = harness({ path: '/customer', fetchHook: async c => {
    if (c.url === '/api/workspace/jobs/' + id) return { ok: false, status: 404 };
    if (c.options.method === 'POST') throw Error('new attempt also loses reply');
  } });
  const old = { values: [154, 255], payload: { jobId: id, title: 'Legacy uncertain', deadlineISO: '2020-01-01T00:00:00.000Z' }, pending: true };
  h.records.set(id, structuredClone(old)); h.records.set('__pending_publish__', { jobId: id }); h.decoders.add(id);
  await h.app.start(); assert.ok(h.text().includes(id)); assert.match(h.text(), /Eski teklif son zamanı geçti/);
  await h.click('Aynı işin durumunu kontrol et'); assert.equal(h.records.get('__pending_publish__').jobId, id); assert.equal(h.app.state.uncertain, true);
  h.get('newDraftConsent').checked = true; await h.click('Eski girişimi koru ve ayrı yeni taslak aç');
  await h.upload(); h.get('title').value = 'Second uncertain'; await h.submit();
  const post = h.calls.find(c => c.options.method === 'POST');
  assert.notEqual(post.body.jobId, id); assert.deepEqual(h.records.get('__pending_publish__').unresolvedJobIds, [id, post.body.jobId]);
  assert.deepEqual(h.records.get(id), old); assert.ok(h.decoders.has(id)); assert.ok(h.decoders.has(post.body.jobId));
  await h.app.navigate('/customer'); assert.ok(h.text().includes(id)); assert.ok(h.text().includes(post.body.jobId));
  assert.equal(h.all().filter(e => e.tagName === 'BUTTON' && e.textContent === 'Aynı işin durumunu kontrol et').length, 2);
  h.app.state.newDraftAllowed = false; await h.app.render();
  assert.ok(h.text().includes(id)); assert.ok(h.text().includes(post.body.jobId)); assert.equal(h.calls.filter(c => c.options.method === 'POST').length, 1);
});
test('dashboard retains local pending lookup controls when server job list is unavailable', async () => {
  const h = harness({ fetchHook: async c => c.url === '/api/workspace/jobs' ? { ok: false, status: 503 } : null });
  h.records.set('__pending_publish__', { jobId: id, unresolvedJobIds: [id] }); h.records.set(id, { pending: true, payload: { jobId: id, title: 'Unresolved' } });
  await h.app.start(); assert.ok(h.text().includes(id)); assert.match(h.text(), /Doğrulanmamış yayımlamalar/);
  assert.ok(h.all().some(e => e.tagName === 'BUTTON' && e.textContent === 'Aynı işin durumunu kontrol et'));
  assert.equal(h.calls.some(c => c.options.method === 'POST'), false); assert.deepEqual(h.records.get('__pending_publish__').unresolvedJobIds, [id]);
});
