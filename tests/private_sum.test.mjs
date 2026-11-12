import test from 'node:test';
import assert from 'node:assert/strict';
import {Readable} from 'node:stream';
import handler from '../api/private-sum.mjs';
import {createSession} from '../web/private-sum.mjs';

const host = 'demo.example:8771';
// Boundary validation needs a 2048-bit odd integer, not a secret test key.
const modulus = (1n << 2047n) + 1n;
const payload = () => ({n: String(modulus), ciphertexts: ['1', '2', '4', '5']});
async function call(body = payload(), options = {}) {
  const text = typeof body === 'string' ? body : JSON.stringify(body);
  const req = Readable.from(options.chunks || [Buffer.from(text)]);
  Object.assign(req, {method: options.method || 'POST', headers: {
    host, origin: `http://${host}`, 'content-type': 'application/json', ...options.headers,
  }});
  if (options.parsed) req.body = body;
  const res = {headers: {}, setHeader(k, v) {this.headers[k.toLowerCase()] = v;},
    end(value) {this.body = JSON.parse(String(value));}};
  await handler(req, res);
  return res;
}

test('stateless endpoint multiplies exactly four group elements and returns fixed profile', async () => {
  for (const parsed of [false, true]) {
    const res = await call(payload(), {parsed});
    assert.equal(res.statusCode, 200);
    assert.deepEqual(res.body, {ciphertext: '40', profile: 'paillier-sum4-v1'});
    assert.equal(res.headers['cache-control'], 'no-store');
    assert.equal(res.headers['access-control-allow-origin'], undefined);
  }
});

test('API rejects unknown fields, plaintext/keys, nonstrings and record counts', async () => {
  for (const body of [null, [], {}, {...payload(), plaintext: 42}, {...payload(), lambda: '1'},
    {...payload(), n: modulus}, {...payload(), n: '01'},
    {...payload(), ciphertexts: [1, '2', '4', '5']},
    {...payload(), ciphertexts: ['1', '2', '4']},
    {...payload(), ciphertexts: ['1', '2', '4', '5', '7']}]) {
    // BigInt is intentionally represented as a number here to test JSON type validation.
    if (typeof body?.n === 'bigint') body.n = 2048;
    assert.equal((await call(body)).statusCode, 400);
  }
});

test('API rejects wrong modulus sizes and out-of-group ciphertexts', async () => {
  for (const n of [17n, 1n << 2048n, 1n << 2047n]) {
    assert.equal((await call({...payload(), n: String(n)})).statusCode, 400);
  }
  for (const cipher of ['0', '-1', '01', '1e3', String(modulus), String(modulus * modulus), '9'.repeat(1235)]) {
    assert.equal((await call({...payload(), ciphertexts: ['1', '1', '1', cipher]})).statusCode, 400);
  }
});

test('API enforces POST, JSON and exact Origin host/port; forwarded host cannot authorize', async () => {
  for (const method of ['GET', 'PUT', 'DELETE', 'OPTIONS']) {
    const res = await call(payload(), {method});
    assert.equal(res.statusCode, 405); assert.equal(res.headers.allow, 'POST');
  }
  for (const origin of [undefined, 'null', 'http://demo.example', 'http://demo.example:8772',
    'http://demo.example:8771.evil.invalid', `http://${host}/path`, `http://user@${host}`, 'https://evil.invalid']) {
    assert.equal((await call(payload(), {headers: {origin, 'x-forwarded-host': 'evil.invalid'}})).statusCode, 403);
  }
  assert.equal((await call(payload(), {headers: {'sec-fetch-site': 'cross-site'}})).statusCode, 403);
  assert.equal((await call(payload(), {headers: {'content-type': 'text/plain'}})).statusCode, 415);
  assert.equal((await call(payload(), {headers: {'x-forwarded-host': 'evil.invalid'}})).statusCode, 200);
});

test('API bounds raw, chunked, parsed and declared bodies to 8KB and rejects malformed JSON', async () => {
  assert.equal((await call('x'.repeat(8193))).statusCode, 413);
  assert.equal((await call('', {chunks: [Buffer.alloc(4096), Buffer.alloc(4097)]})).statusCode, 413);
  assert.equal((await call({padding: 'x'.repeat(8192)}, {parsed: true})).statusCode, 413);
  assert.equal((await call(payload(), {headers: {'content-length': '8193'}})).statusCode, 413);
  assert.equal((await call(payload(), {headers: {'content-length': '-1'}})).statusCode, 400);
  assert.equal((await call('{broken')).statusCode, 400);
  const exact = JSON.stringify(payload()).padEnd(8192, ' ');
  assert.equal((await call(exact)).statusCode, 200);
});

test('actual 2048-bit keygen yields and encrypted HTTP sum decrypts correctly', {timeout: 120000}, async t => {
  let ticks = 0;
  const timer = setInterval(() => ticks++, 1);
  const started = performance.now();
  let session;
  try {session = await createSession();} finally {clearInterval(timer);}
  const keygenMs = performance.now() - started;
  assert.equal(BigInt(session.n).toString(2).length, 2048);
  assert.ok(ticks > 0, 'keygen must yield the event loop');
  const ciphertexts = [0, 1000000, 42, 7].map(value => session.encrypt(value));
  const res = await call({n: session.n, ciphertexts});
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.profile, 'paillier-sum4-v1');
  assert.equal(session.decrypt(BigInt(res.body.ciphertext)), 1000049);
  t.diagnostic(`2048-bit keygen ${Math.round(keygenMs)}ms; full round trip ${Math.round(performance.now() - started)}ms; ${ticks} event-loop ticks`);
});
