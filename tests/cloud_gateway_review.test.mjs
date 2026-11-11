import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {Readable} from 'node:stream';
import test from 'node:test';
import {createGateway} from '../cloud/gateway/core.mjs';

// Review tests exercise the REAL createGateway. Only storage, time and the remote
// worker are test doubles. No Blob service, TLS/DNS, FHE, proof, or deployment is
// exercised. In particular, atomic create below is an ASSUMED storage contract,
// not evidence that a real provider implements it. TTL is explicitly simulated.
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const DAY = 86400000;
const START = 1794474000000;
const JOB = '1'.repeat(32);
const OTHER_JOB = '2'.repeat(32);
const TOKEN = 'a'.repeat(43);
const OTHER_TOKEN = 'b'.repeat(43);
const ORIGIN = 'https://review-ui.invalid';
const canonical = value => JSON.stringify(value, (_key, item) =>
  item && typeof item === 'object' && !Array.isArray(item)
    ? Object.fromEntries(Object.keys(item).sort().map(key => [key, item[key]])) : item);
const clone = value => structuredClone(value);
const prefix = (owner = 'alice', jobId = JOB) => `veil-v1/${owner}/${jobId}/`;
const deferred = () => {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return {promise, resolve};
};

class MemoryStoreDouble {
  constructor(now) {
    this.now = now;
    this.entries = new Map();
    this.calls = [];
    this.onCreate = undefined;
    this.failRemove = false;
  }
  lookup(path) {
    const item = this.entries.get(path);
    if (item && item.expiresAt <= this.now()) this.entries.delete(path);
    return this.entries.get(path);
  }
  async read(path) {
    this.calls.push({op: 'read', path});
    return clone(this.lookup(path)?.value ?? null);
  }
  async create(path, value) {
    this.calls.push({op: 'create', path, value: clone(value)});
    // Yield before, but NEVER between the create-if-absent check and write.
    await Promise.resolve();
    const created = !this.lookup(path);
    if (created) this.entries.set(path, {value: clone(value), expiresAt: this.now() + 7 * DAY});
    this.onCreate?.(path, created);
    return created;
  }
  async sign(path, operation, options) {
    this.calls.push({op: 'sign', path, operation, options: clone(options)});
    return `https://review-blob.invalid/${path}?op=${operation}`;
  }
  async remove(paths) {
    this.calls.push({op: 'remove', paths: [...paths]});
    if (this.failRemove) throw new Error('synthetic cleanup failure');
    for (const path of paths) this.entries.delete(path);
  }
  // Seed bytes to verify cleanup without pretending to implement signed uploads.
  seedInputs(metadata, owner = 'alice') {
    for (const file of metadata.files) this.entries.set(prefix(owner, metadata.jobId) + file.name,
      {value: Buffer.from('synthetic encrypted input'), expiresAt: this.now() + DAY});
  }
}

function fixture(jobId = JOB, variant = 'original') {
  const manifest = {
    protocolVersion: 1, profileId: 'clean-4-records-v1', attemptId: jobId,
    serverSha256: hash('synthetic-server'), clientSpecsSha256: hash('synthetic-specs'),
    inputSha256: hash(`ciphertext-${variant}`), evaluationKeysSha256: hash(`keys-${variant}`),
  };
  const manifestBytes = Buffer.from(canonical(manifest));
  const requestManifestSha256 = hash(manifestBytes);
  return {jobId, requestManifestSha256, files: [
    {name: 'request.json', size: manifestBytes.length, sha256: requestManifestSha256},
    {name: 'request.bin', size: 32, sha256: manifest.inputSha256},
    {name: 'evaluation.keys', size: 64, sha256: manifest.evaluationKeysSha256},
  ]};
}

function workerOutput(metadata = fixture()) {
  // Synthetic transport fixture, not actual ciphertext or engine evidence.
  const output = Buffer.from('synthetic ciphertext output');
  const receipt = JSON.parse(canonical({
    requestManifestSha256: metadata.requestManifestSha256,
    outputSha256: hash(output),
    request: {attemptId: metadata.jobId},
    metrics: {evaluate_seconds: 0, server_load_seconds: 0},
  }));
  const receiptBytes = Buffer.from(canonical(receipt));
  return {receipt, receiptBase64: receiptBytes.toString('base64'),
    outputBase64: output.toString('base64'), receiptSha256: hash(receiptBytes), outputSha256: hash(output)};
}

function harness({grants, env: envOverrides, fetcher} = {}) {
  const clock = {value: START};
  const grant = (owner, token, jobIds = [JOB]) => ({
    owner, tokenHash: hash(token), jobIds, issuedAt: START, expiresAt: START + DAY,
  });
  const env = {
    VEIL_PUBLIC_ORIGIN: ORIGIN,
    VEIL_WORKER_URL: 'https://explicitly-authorized-worker.invalid/base',
    VEIL_WORKER_TOKEN: 'synthetic-worker-token',
    VEIL_ACCESS_GRANTS: JSON.stringify(grants ?? [grant('alice', TOKEN), grant('bob', OTHER_TOKEN)]),
    ...envOverrides,
  };
  const store = new MemoryStoreDouble(() => clock.value);
  const fetchCalls = [];
  const remote = async (url, init) => {
    fetchCalls.push({url: String(url), init});
    return fetcher ? fetcher(url, init) : Response.json(workerOutput());
  };
  const newGateway = () => createGateway({store, env, fetcher: remote, now: () => clock.value});
  const handle = newGateway();
  async function call(path, {method = 'GET', token = TOKEN, body, rawBody, origin, headers = {}, gateway = handle} = {}) {
    const init = {method, headers: {authorization: `Bearer ${token}`, ...headers}};
    if (origin !== undefined) init.headers.origin = origin;
    if (method === 'POST') {
      init.headers['content-type'] ??= 'application/json';
      init.body = rawBody ?? JSON.stringify(body ?? {});
      if (init.body instanceof ReadableStream) init.duplex = 'half';
    }
    const response = await gateway(new Request(`https://review-gateway.invalid/api/cloud${path}`, init));
    return {status: response.status, body: await response.json(), headers: response.headers};
  }
  const register = (body = fixture(), options = {}) => call('/jobs', {method: 'POST', body, ...options});
  const evaluate = (options = {}) => call(`/jobs/${JOB}/evaluate`, {method: 'POST', ...options});
  return {clock, grant, env, store, fetchCalls, newGateway, call, register, evaluate};
}

test('tenant namespace isolates the same allowed job ID, result, claim, failure and signed URLs', async () => {
  const h = harness();
  assert.equal((await h.register()).status, 201);
  assert.equal((await h.evaluate()).status, 200);
  const untouched = h.store.calls.length;
  for (const suffix of ['', '/result', '/evaluate']) {
    const result = await h.call(`/jobs/${JOB}${suffix}`, {
      token: OTHER_TOKEN, method: suffix === '/evaluate' ? 'POST' : 'GET',
    });
    assert.equal(result.status, 404);
  }
  assert.ok(h.store.calls.slice(untouched).every(call => call.path?.startsWith(prefix('bob'))));
  const bob = await h.register(fixture(JOB, 'bob'), {token: OTHER_TOKEN});
  assert.equal(bob.status, 201);
  assert.ok(bob.body.uploads.every(file => file.url.includes('/veil-v1/bob/')));
  assert.equal((await h.call(`/jobs/${JOB}`, {token: OTHER_TOKEN})).body.status, 'AWAITING_UPLOAD');
  assert.equal((await h.call(`/jobs/${JOB}`)).body.status, 'COMPLETED');
  assert.equal(h.fetchCalls.length, 1);
});

for (const [name, token] of [['forged bearer', 'c'.repeat(43)], ['token hash used as bearer', hash(TOKEN)], ['short bearer', 'short']]) {
  test(`rejects ${name} before storage or worker access`, async () => {
    const h = harness();
    assert.equal((await h.register(fixture(), {token})).status, 401);
    assert.equal(h.store.calls.length, 0);
    assert.equal(h.fetchCalls.length, 0);
  });
}

test('cookies cannot substitute for an explicit bearer grant', async () => {
  const h = harness();
  const r = await h.call('/session', {headers: {authorization: '', cookie: `token=${TOKEN}`}});
  assert.equal(r.status, 401);
});

test('grant expires exactly at its expiry, including result access', async () => {
  const h = harness();
  await h.register();
  await h.evaluate();
  h.clock.value = START + DAY;
  const before = h.store.calls.length;
  for (const path of ['/session', `/jobs/${JOB}`, `/jobs/${JOB}/result`]) {
    assert.equal((await h.call(path)).status, 401);
  }
  assert.equal((await h.evaluate()).status, 401);
  assert.equal(h.store.calls.length, before);
});

test('24-hour grant cannot replay after seven-day job/claim metadata TTL', async () => {
  const h = harness();
  assert.equal((await h.register()).status, 201);
  assert.equal((await h.evaluate()).status, 200);
  h.clock.value += 7 * DAY + 1;
  assert.equal(await h.store.read(prefix() + 'job.json'), null);
  assert.equal(await h.store.read(prefix() + 'claim.json'), null);
  assert.equal((await h.register()).status, 401);
  assert.equal((await h.evaluate()).status, 401);
  assert.equal(h.fetchCalls.length, 1);
});

test('overlong grant must not allow a second evaluation after seven-day metadata expiry', async () => {
  const grants = [{owner: 'alice', tokenHash: hash(TOKEN), jobIds: [JOB], issuedAt: START, expiresAt: START + 8 * DAY}];
  const h = harness({grants});
  const initial = await h.register();
  if ([401, 503].includes(initial.status)) {
    // Enforcing the grant lifetime at authentication is the preferred prevention.
    assert.equal(h.store.calls.length, 0);
    assert.equal(h.fetchCalls.length, 0);
    return;
  }
  assert.equal(initial.status, 201);
  assert.equal((await h.evaluate()).status, 200);
  h.clock.value += 7 * DAY + 1;
  assert.equal(await h.store.read(prefix() + 'claim.json'), null);
  const replayRegistration = await h.register();
  const replay = await h.evaluate();
  assert.equal(h.fetchCalls.length, 1,
    `durable quota reset: registration=${replayRegistration.status}, evaluation=${replay.status}`);
  assert.ok([401, 409, 503].includes(replay.status));
});

test('job ID allowlist is a quota on create, read, result and evaluate', async () => {
  const h = harness();
  assert.equal((await h.register(fixture(OTHER_JOB))).status, 404);
  for (const suffix of ['', '/result', '/evaluate']) {
    assert.equal((await h.call(`/jobs/${OTHER_JOB}${suffix}`, {
      method: suffix === '/evaluate' ? 'POST' : 'GET',
    })).status, 404);
  }
  assert.equal(h.store.calls.length, 0);
  assert.equal(h.fetchCalls.length, 0);
});

test('empty job quota grants session access but cannot create a job', async () => {
  const h = harness({grants: [{owner: 'alice', tokenHash: hash(TOKEN), jobIds: [],
    issuedAt: START, expiresAt: START + DAY}]});
  assert.equal((await h.call('/session')).status, 200);
  assert.equal((await h.register()).status, 404);
  assert.equal(h.store.calls.length, 0);
});

test('missing/future issuance, inverted expiry and greater-than-seven-day grants fail closed', async () => {
  for (const patch of [{issuedAt: undefined}, {issuedAt: START + 60000},
    {expiresAt: START}, {expiresAt: START + 7 * DAY + 1}]) {
    const h = harness({grants: [{owner: 'alice', tokenHash: hash(TOKEN), jobIds: [JOB],
      issuedAt: START, expiresAt: START + DAY, ...patch}]});
    assert.equal((await h.register()).status, 503);
    assert.equal(h.store.calls.length, 0);
    assert.equal(h.fetchCalls.length, 0);
  }
});

test('invalid owner traversal and grants with more than 50 job slots fail closed', async () => {
  for (const patch of [{owner: '../bob'}, {jobIds: Array.from({length: 51}, (_, i) => i.toString(16).padStart(32, '0'))}]) {
    const grants = [{owner: 'alice', tokenHash: hash(TOKEN), jobIds: [JOB], issuedAt: START, expiresAt: START + DAY, ...patch}];
    const h = harness({grants});
    assert.equal((await h.register()).status, 503);
    assert.equal(h.store.calls.length, 0);
  }
});

test('same job and encrypted descriptors are idempotent across gateway instances', async () => {
  const h = harness();
  const first = await h.register();
  const reordered = fixture();
  reordered.files.reverse();
  assert.equal(first.status, 201);
  const second = await h.register(reordered, {gateway: h.newGateway()});
  assert.equal(second.status, 201);
  assert.deepEqual(second.body, first.body);
});

test('JSON descriptor property order must not change request identity', async () => {
  const h = harness();
  assert.equal((await h.register()).status, 201);
  const body = fixture();
  body.files = body.files.map(({name, size, sha256}) => ({sha256, size, name}));
  assert.equal((await h.register(body, {gateway: h.newGateway()})).status, 201);
});

test('rebinding a job to a different request, size or ciphertext hash is rejected', async () => {
  for (const mutate of [
    body => Object.assign(body, fixture(JOB, 'different')),
    body => { body.files[1].size++; },
    body => { body.files[1].sha256 = hash('different'); },
  ]) {
    const h = harness();
    assert.equal((await h.register()).status, 201);
    const body = fixture();
    mutate(body);
    const before = h.store.calls.filter(call => call.op === 'sign').length;
    assert.equal((await h.register(body, {gateway: h.newGateway()})).status, 409);
    assert.equal(h.store.calls.filter(call => call.op === 'sign').length, before);
  }
});

test('concurrent conflicting registrations bind exactly one encrypted request', async () => {
  const h = harness();
  const responses = await Promise.all([
    h.register(fixture(), {gateway: h.newGateway()}),
    h.register(fixture(JOB, 'different'), {gateway: h.newGateway()}),
  ]);
  assert.deepEqual(responses.map(r => r.status).sort(), [201, 409]);
  const bound = await h.store.read(prefix() + 'job.json');
  const winner = responses.find(r => r.status === 201);
  assert.equal(bound.requestManifestSha256, winner.body.uploads.find(f => f.name === 'request.json').sha256);
});

test('16 concurrent claims across gateway instances dispatch exactly once', {timeout: 5000}, async () => {
  const release = deferred();
  const workerEntered = deferred();
  const allClaims = deferred();
  let claims = 0;
  const h = harness({fetcher: async () => {
    workerEntered.resolve();
    await release.promise;
    return Response.json(workerOutput());
  }});
  await h.register();
  h.store.onCreate = path => { if (path.endsWith('/claim.json') && ++claims === 16) allClaims.resolve(); };
  const requests = Array.from({length: 16}, () => h.evaluate({gateway: h.newGateway()}));
  await Promise.all([allClaims.promise, workerEntered.promise]);
  assert.equal(h.fetchCalls.length, 1);
  release.resolve();
  const responses = await Promise.all(requests);
  assert.equal(responses.filter(r => r.status === 200).length, 1);
  assert.equal(responses.filter(r => r.status === 409).length, 15);
  assert.equal((await h.evaluate({gateway: h.newGateway()})).status, 200);
  assert.equal((await h.register()).status, 409);
  assert.equal(h.fetchCalls.length, 1);
});

test('valid worker response is stored exactly, retrieved, and inputs are removed', async () => {
  const h = harness();
  const metadata = fixture();
  await h.register(metadata);
  h.store.seedInputs(metadata);
  assert.equal((await h.evaluate()).status, 200);
  assert.deepEqual((await h.call(`/jobs/${JOB}/result`)).body, workerOutput());
  assert.equal((await h.call(`/jobs/${JOB}`)).body.status, 'COMPLETED');
  for (const f of metadata.files) assert.equal(await h.store.read(prefix() + f.name), null);
  assert.ok(await h.store.read(prefix() + 'claim.json'));
  assert.equal(await h.store.read(prefix() + 'failure.json'), null);
});

const invalidReplies = [
  ['different request manifest', output => { output.receipt.requestManifestSha256 = hash('other request'); reseal(output); }],
  ['tampered output bytes', output => { output.outputBase64 = Buffer.from('other output').toString('base64'); }],
  ['forged receipt digest', output => { output.receiptSha256 = hash('not this receipt'); }],
  ['receipt claiming another output', output => { output.receipt.outputSha256 = hash('other output'); reseal(output); }],
  ['receipt object differing from receipt bytes', output => { output.receipt.metrics.evaluate_seconds = 999; }],
  ['extra worker field', output => { output.debug = 'not allowed'; }],
  ['missing receipt bytes', output => { delete output.receiptBase64; }],
  ['invalid output base64 alphabet', output => { output.outputBase64 = '**'; }],
];
function reseal(output) {
  // Keep the object order equal to the exact bytes, as the current wire contract requires.
  output.receipt = JSON.parse(canonical(output.receipt));
  const bytes = Buffer.from(canonical(output.receipt));
  output.receiptBase64 = bytes.toString('base64');
  output.receiptSha256 = hash(bytes);
}
for (const [name, mutate] of invalidReplies) {
  test(`worker binding rejects ${name} and retains the one-shot claim`, async () => {
    const reply = workerOutput();
    mutate(reply);
    const h = harness({fetcher: async () => Response.json(reply)});
    await h.register();
    assert.equal((await h.evaluate()).status, 502);
    assert.equal(await h.store.read(prefix() + 'result.json'), null);
    assert.equal((await h.call(`/jobs/${JOB}`)).body.status, 'FAILED_OR_UNKNOWN');
    assert.equal((await h.evaluate({gateway: h.newGateway()})).status, 409);
    assert.equal(h.fetchCalls.length, 1);
  });
}

for (const [name, fetcher] of [
  ['unknown network outcome', async () => { throw new Error('SECRET: signed-url-token'); }],
  ['worker HTTP rejection', async () => new Response('SECRET: worker detail', {status: 500})],
  ['malformed worker JSON', async () => new Response('{bad json')],
  ['redirect response', async () => new Response(null, {status: 302, headers: {location: 'https://127.0.0.1/'}})],
]) {
  test(`${name}: sanitized failure, no replay, metadata retained, encrypted inputs removed`, async () => {
    const h = harness({fetcher});
    await h.register();
    h.store.seedInputs(fixture());
    const result = await h.evaluate();
    assert.equal(result.status, 502);
    assert.doesNotMatch(JSON.stringify(result.body), /SECRET|signed-url-token|127\.0\.0\.1/);
    assert.ok(await h.store.read(prefix() + 'job.json'));
    assert.ok(await h.store.read(prefix() + 'claim.json'));
    assert.deepEqual(await h.store.read(prefix() + 'failure.json'), {failedAt: START, status: 'FAILED_OR_UNKNOWN'});
    for (const file of fixture().files) assert.equal(await h.store.read(prefix() + file.name), null);
    assert.equal((await h.call(`/jobs/${JOB}/result`)).status, 409);
    assert.equal((await h.evaluate({gateway: h.newGateway()})).status, 409);
    assert.equal((await h.register()).status, 409);
    assert.equal(h.fetchCalls.length, 1);
  });
}

test('failure to persist the unknown-outcome marker still cannot release the claim', async () => {
  const h = harness({fetcher: async () => { throw new Error('synthetic dispatch uncertainty'); }});
  await h.register();
  h.store.seedInputs(fixture());
  const create = h.store.create.bind(h.store);
  h.store.create = async (path, value) => {
    if (path.endsWith('/failure.json')) throw new Error('SECRET storage failure');
    return create(path, value);
  };
  const result = await h.evaluate();
  assert.equal(result.status, 503);
  assert.deepEqual(result.body, {error: 'Service temporarily unavailable.'});
  assert.equal((await h.call(`/jobs/${JOB}`)).body.status, 'RUNNING_OR_UNKNOWN');
  assert.equal((await h.evaluate({gateway: h.newGateway()})).status, 409);
  assert.equal(h.fetchCalls.length, 1);
  for (const file of fixture().files) assert.equal(await h.store.read(prefix() + file.name), null);
});

test('worker-read signing failure fences the job even though no worker was dispatched', async () => {
  const h = harness();
  await h.register();
  h.store.seedInputs(fixture());
  h.store.sign = async () => { throw new Error('SECRET signing failure'); };
  const response = await h.evaluate();
  assert.equal(response.status, 502);
  assert.doesNotMatch(JSON.stringify(response.body), /SECRET/);
  assert.ok(await h.store.read(prefix() + 'claim.json'));
  assert.ok(await h.store.read(prefix() + 'failure.json'));
  assert.equal((await h.evaluate({gateway: h.newGateway()})).status, 409);
  assert.equal(h.fetchCalls.length, 0);
  for (const file of fixture().files) assert.equal(await h.store.read(prefix() + file.name), null);
});

test('result persistence failure cannot report completion or dispatch again', async () => {
  const h = harness();
  await h.register();
  const create = h.store.create.bind(h.store);
  h.store.create = async (path, value) => {
    if (path.endsWith('/result.json')) throw new Error('SECRET persistence failure');
    return create(path, value);
  };
  assert.equal((await h.evaluate()).status, 502);
  assert.equal((await h.call(`/jobs/${JOB}`)).body.status, 'FAILED_OR_UNKNOWN');
  assert.equal((await h.call(`/jobs/${JOB}/result`)).status, 409);
  assert.equal((await h.evaluate({gateway: h.newGateway()})).status, 409);
  assert.equal(h.fetchCalls.length, 1);
});

test('cleanup failure keeps failure and claim; input TTL remains a simulated backup', async () => {
  const h = harness({fetcher: async () => { throw new Error('synthetic timeout'); }});
  await h.register();
  h.store.seedInputs(fixture());
  h.store.failRemove = true;
  assert.equal((await h.evaluate()).status, 502);
  assert.ok(await h.store.read(prefix() + 'claim.json'));
  assert.ok(await h.store.read(prefix() + 'failure.json'));
  assert.ok(await h.store.read(prefix() + 'request.bin'));
  h.clock.value += DAY;
  assert.equal(await h.store.read(prefix() + 'request.bin'), null);
  assert.ok(await h.store.read(prefix() + 'claim.json'));
  assert.equal(h.fetchCalls.length, 1);
});

for (const url of ['http://worker.invalid', 'https://user:pass@worker.invalid',
  'https://worker.invalid?next=internal', 'https://worker.invalid/#fragment',
  'https://worker.invalid:444', 'file:///etc/passwd', 'not a URL']) {
  test(`worker destination restriction rejects ${url}`, async () => {
    const h = harness({env: {VEIL_WORKER_URL: url}});
    await h.register();
    assert.equal((await h.evaluate()).status, 503);
    assert.equal(h.fetchCalls.length, 0);
    assert.equal(await h.store.read(prefix() + 'claim.json'), null);
  });
}

test('caller cannot supply a worker destination or download URL; dispatch uses explicit configuration', async () => {
  const h = harness();
  const descriptorURL = fixture();
  descriptorURL.files[0].url = 'https://169.254.169.254/latest/meta-data/';
  assert.equal((await h.register(descriptorURL)).status, 400);
  assert.equal((await h.register({...fixture(), workerUrl: 'https://127.0.0.1/'})).status, 400);
  await h.register();
  assert.equal((await h.evaluate({body: {url: 'https://127.0.0.1/'}})).status, 400);
  assert.equal(h.fetchCalls.length, 0);
  assert.equal((await h.evaluate()).status, 200);
  const [{url, init}] = h.fetchCalls;
  assert.equal(url, 'https://explicitly-authorized-worker.invalid/evaluate');
  assert.equal(init.redirect, 'error');
  assert.equal(init.headers.Authorization, 'Bearer synthetic-worker-token');
  assert.ok(init.signal instanceof AbortSignal);
  const payload = JSON.parse(init.body);
  assert.deepEqual(Object.keys(payload).sort(), ['files', 'requestManifestSha256']);
  assert.ok(payload.files.every(file => file.url.startsWith('https://review-blob.invalid/veil-v1/alice/')));
});

test('upload and worker-read capabilities are scoped and expire by grant or operation limit', async () => {
  const h = harness();
  const grants = JSON.parse(h.env.VEIL_ACCESS_GRANTS);
  grants[0].expiresAt = START + 60000;
  h.env.VEIL_ACCESS_GRANTS = JSON.stringify(grants);
  await h.register();
  await h.evaluate();
  const signs = h.store.calls.filter(call => call.op === 'sign');
  assert.equal(signs.length, 6);
  for (const sign of signs) {
    assert.ok(sign.path.startsWith(prefix()));
    assert.equal(sign.options.expiresAt, START + 60000);
    if (sign.operation === 'put') assert.equal(sign.options.size, fixture().files.find(f => prefix() + f.name === sign.path).size);
  }
});

test('longer-lived grant still limits upload capabilities to 15 minutes and reads to five', async () => {
  const h = harness();
  await h.register();
  await h.evaluate();
  for (const call of h.store.calls.filter(call => call.op === 'sign')) {
    assert.equal(call.options.expiresAt, START + (call.operation === 'put' ? 900000 : 300000));
  }
});

for (const name of ['constructor', 'toString', '__proto__']) {
  test(`file allowlist rejects inherited property ${name} and its oversized descriptor`, async () => {
    const h = harness();
    const body = fixture();
    body.files.push({name, size: 536870913, sha256: hash('unsupported file')});
    assert.equal((await h.register(body)).status, 400);
    assert.equal(h.store.calls.length, 0);
  });
}

test('rejects path traversal, duplicate files, missing keys, extra fields and excessive file sizes', async () => {
  for (const mutate of [
    body => { body.files.push({name: '../job.json', size: 1, sha256: hash('x')}); },
    body => { body.files.push(clone(body.files[0])); },
    body => { body.files[2] = {name: 'binding.json', size: 1, sha256: hash('x')}; },
    body => { body.files[0].debug = true; },
    body => { body.files[0].size = 8193; },
    body => { body.files[1].size = 2097153; },
    body => { body.files[2].size = 536870913; },
    body => { body.files[0].sha256 = hash('mismatched manifest'); },
  ]) {
    const h = harness();
    const body = fixture();
    mutate(body);
    assert.equal((await h.register(body)).status, 400);
    assert.equal(h.store.calls.length, 0);
  }
});

function oversizedStream(size) {
  let sent = false;
  let cancelled = false;
  return {stream: new ReadableStream({
    pull(controller) {
      if (!sent) { sent = true; controller.enqueue(new Uint8Array(size).fill(32)); }
      // Deliberately never close: the bound must cancel instead of reading EOF.
    },
    cancel() { cancelled = true; },
  }), wasCancelled: () => cancelled};
}

test('oversized streamed caller body cancels without Content-Length and before persistence', async () => {
  const h = harness();
  const body = oversizedStream(16385);
  assert.equal((await h.register(undefined, {rawBody: body.stream})).status, 413);
  assert.ok(body.wasCancelled());
  assert.equal(h.store.calls.length, 0);
});

test('body bound counts UTF-8 bytes, not string characters', async () => {
  const h = harness();
  const rawBody = JSON.stringify({padding: 'é'.repeat(8200)});
  assert.ok(rawBody.length < 16384);
  assert.ok(Buffer.byteLength(rawBody) > 16384);
  assert.equal((await h.register(undefined, {rawBody})).status, 413);
});

test('oversized worker response cancels stream and preserves failure fencing', async () => {
  const body = oversizedStream(1500001);
  const h = harness({fetcher: async () => new Response(body.stream)});
  await h.register();
  assert.equal((await h.evaluate()).status, 502);
  assert.ok(body.wasCancelled());
  assert.equal((await h.evaluate()).status, 409);
  assert.equal(h.fetchCalls.length, 1);
});

test('JSON media type and malformed JSON rejected before storage', async () => {
  const h = harness();
  assert.equal((await h.register(undefined, {headers: {'content-type': 'text/plain'}})).status, 415);
  assert.equal((await h.register(undefined, {rawBody: '{malformed'})).status, 400);
  assert.equal(h.store.calls.length, 0);
});

for (const origin of ['https://foreign.invalid', `${ORIGIN}.evil.invalid`, 'null', 'http://review-ui.invalid']) {
  test(`denies origin ${origin} before authentication/storage, including health`, async () => {
    const h = harness();
    assert.equal((await h.register(undefined, {origin})).status, 403);
    assert.equal((await h.call('/health', {origin})).status, 403);
    assert.equal(h.store.calls.length, 0);
  });
}

test('same-origin and origin-less companion requests work without CORS opt-in', async () => {
  const h = harness();
  for (const origin of [ORIGIN, undefined]) {
    const response = await h.call('/session', {origin});
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('cache-control'), 'no-store');
    assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
    assert.equal(response.headers.get('access-control-allow-origin'), null);
  }
});

test('unexpected storage exception is sanitized and does not dispatch', async () => {
  const h = harness();
  h.store.read = async () => { throw new Error('SECRET: private-blob-token'); };
  const response = await h.register();
  assert.equal(response.status, 503);
  assert.deepEqual(response.body, {error: 'Service temporarily unavailable.'});
  assert.equal(h.fetchCalls.length, 0);
});

// Actual API adapter tests avoid authenticated storage routes. Importing Blob is
// real; no Blob operation or external network request is needed here.
async function adapterRequest({body = [], headers = {}, url = '/api/cloud/health', method = 'GET'} = {}) {
  const {default: handler} = await import('../api/gateway.mjs');
  const request = Readable.from(body);
  Object.assign(request, {method, url, headers});
  const response = {
    statusCode: 200, headers: {}, bytes: null,
    setHeader(name, value) { this.headers[name.toLowerCase()] = value; },
    end(bytes) { this.bytes = Buffer.from(bytes ?? ''); },
  };
  await handler(request, response);
  return {...response, body: JSON.parse(response.bytes.toString('utf8'))};
}

test('actual Node API adapter serves health and forwards no-store response headers', async () => {
  const result = await adapterRequest();
  assert.equal(result.statusCode, 200);
  assert.equal(result.body.paymentsEnabled, false);
  assert.equal(result.headers['cache-control'], 'no-store');
  assert.equal(result.headers['x-content-type-options'], 'nosniff');
});

test('Vercel rewrite reaches nested job routes through the fixed gateway function', async () => {
  const health = await adapterRequest({url:'/api/gateway?route=health'});
  assert.equal(health.statusCode, 200);
  const job = await adapterRequest({url:'/api/gateway?route=jobs/0123456789abcdef0123456789abcdef/result'});
  assert.equal(job.statusCode, 401);
});

test('gateway rewrite rejects duplicate and traversal route parameters', async () => {
  for (const url of ['/api/gateway?route=health&route=session','/api/gateway?route=../health']) {
    const response = await adapterRequest({url});
    assert.equal(response.statusCode,400);
  }
});

test('actual Node API adapter limits aggregate streamed bytes before gateway authentication', async () => {
  const result = await adapterRequest({method: 'POST', url: '/api/cloud/jobs',
    body: [Buffer.alloc(8192), Buffer.alloc(8192), Buffer.from('x')],
    headers: {'content-type': 'application/json', 'content-length': '2'},
  });
  assert.equal(result.statusCode, 413);
  assert.deepEqual(result.body, {error: 'Payload too large.'});
});

test('actual Node API adapter sanitizes an aborted incoming body instead of leaking a rejected handler', async () => {
  async function* interruptedBody() {
    yield Buffer.from('{"jobId":');
    const error = new Error('SECRET: synthetic upstream stream detail');
    error.code = 'ECONNRESET';
    throw error;
  }
  const response = await adapterRequest({method: 'POST', url: '/api/cloud/jobs',
    body: interruptedBody(), headers: {'content-type': 'application/json'},
  });
  assert.equal(response.statusCode, 503);
  assert.deepEqual(response.body, {error: 'Service temporarily unavailable.'});
  assert.equal(response.headers['cache-control'], 'no-store');
  assert.equal(response.headers['x-content-type-options'], 'nosniff');
});
