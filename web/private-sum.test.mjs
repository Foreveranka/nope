import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import * as production from './private-sum.mjs';

// Isolated instrumentation injects public toy primes without exposing a test-key
// or private-key export in the actual browser module.
const source = await readFile(new URL('./private-sum.mjs', import.meta.url), 'utf8');
const instrumented = source.replaceAll('globalThis.crypto', 'testCrypto');
const toy = await import('data:text/javascript;base64,' + Buffer.from(
  'let testCrypto = globalThis.crypto;\n' + instrumented +
  '\nexport {sessionFromPrimes, randomBelow, probablePrime};\n' +
  'export function setCrypto(c) { testCrypto = c; }',
).toString('base64'));
const p = 10007n, q = 10009n;
const pow = (a, e, n) => {let r = 1n; for (; e; e >>= 1n, a = a * a % n) if (e & 1n) r = r * a % n; return r;};

test('production exports only createSession; session exposes no secret key', () => {
  assert.deepEqual(Object.keys(production), ['createSession']);
  const session = toy.sessionFromPrimes(p, q);
  assert.deepEqual(Object.keys(session).sort(), ['decrypt', 'encrypt', 'n']);
  assert.equal(Object.isFrozen(session), true);
  assert.equal(JSON.stringify(session), JSON.stringify({n: String(p * q)}));
});

test('injected small keys recover independent g=n+1 vectors and four-record additive sum', () => {
  const session = toy.sessionFromPrimes(p, q), n = BigInt(session.n), square = n * n;
  const values = [0, 1000000, 42, 7];
  let aggregate = 1n;
  for (const value of values) {
    const independent = pow(n + 1n, BigInt(value), square) * pow(2n, n, square) % square;
    assert.equal(session.decrypt(independent), value);
    const cipher = session.encrypt(value);
    assert.equal(typeof cipher, 'string');
    assert.equal(session.decrypt(BigInt(cipher)), value);
    aggregate = aggregate * BigInt(cipher) % square;
  }
  assert.equal(session.decrypt(aggregate), 1000049);
  assert.equal(session.decrypt(session.encrypt(125)), 125);
});

test('fresh randomizers hide equal values; input and ciphertext bounds reject', () => {
  const session = toy.sessionFromPrimes(p, q), n = BigInt(session.n);
  assert.notEqual(session.encrypt(42), session.encrypt(42));
  for (const v of [-1, 1000001, 1.5, NaN, Infinity, '42', 42n, null, Number.MAX_SAFE_INTEGER + 1]) {
    assert.throws(() => session.encrypt(v), RangeError);
  }
  for (const c of [0n, -1n, n, n * n, 42, '01', '-1', '1e3', '9'.repeat(2000)]) {
    assert.throws(() => session.decrypt(c), RangeError);
  }
});

test('RNG rejection excludes biased samples and noncoprime encryption randomizers', () => {
  let queue = [15n, 9n], calls = 0;
  toy.setCrypto({getRandomValues(bytes) {
    calls++;
    let value = queue.shift();
    assert.notEqual(value, undefined);
    bytes.fill(0);
    for (let i = bytes.length - 1; i >= 0; i--) {bytes[i] = Number(value & 255n); value >>= 8n;}
    return bytes;
  }});
  try {
    assert.equal(toy.randomBelow(10n), 9n);
    assert.equal(calls, 2);
    queue = [p - 1n, 1n]; calls = 0; // r=p rejected, r=2 accepted.
    const session = toy.sessionFromPrimes(p, q), n = BigInt(session.n), square = n * n;
    assert.equal(BigInt(session.encrypt(42)), (1n + n * 42n) * pow(2n, n, square) % square);
    assert.equal(calls, 2);
  } finally { toy.setCrypto(globalThis.crypto); }
});

test('Miller–Rabin performs 32 sampled rounds and rejects composites', async () => {
  let samples = 0;
  toy.setCrypto({getRandomValues(bytes) {samples++; bytes.fill(0); return bytes;}});
  try {
    assert.equal(await toy.probablePrime(101n), true);
    assert.equal(samples, 32);
    assert.equal(await toy.probablePrime(10403n), false); // 101 * 103
    assert.equal(await toy.probablePrime(1n), false);
  } finally { toy.setCrypto(globalThis.crypto); }
});
