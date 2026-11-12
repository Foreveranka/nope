/**
 * paillier-sum4-v1: unaudited additive-encryption demo, NOT FHE/cleaning.
 * Native BigInt arithmetic is not constant-time. Primes are probable primes
 * (32 independent random Miller–Rabin rounds), not certified primes.
 * Only n and operations leave the closure; no secret export or persistence.
 */
const PRIME_BITS = 1024;
const ROUNDS = 32;
const MAX_VALUE = 1000000;
const pause = () => new Promise(resolve => setTimeout(resolve, 0));

function gcd(a, b) {
  while (b) [a, b] = [b, a % b];
  return a;
}
function modPow(base, exponent, modulus) {
  let result = 1n;
  for (base %= modulus; exponent; exponent >>= 1n) {
    if (exponent & 1n) result = result * base % modulus;
    base = base * base % modulus;
  }
  return result;
}
function inverse(a, modulus) {
  let [r, next, t, u] = [modulus, a, 0n, 1n];
  while (next) {
    const q = r / next;
    [r, next] = [next, r - q * next];
    [t, u] = [u, t - q * u];
  }
  if (r !== 1n) throw new Error('Invalid Paillier key.');
  return (t % modulus + modulus) % modulus;
}
// Uniform [0, limit): mask excess bits and reject, never reduce random bytes modulo limit.
function randomBelow(limit) {
  if (limit <= 0n) throw new RangeError('Invalid random bound.');
  const bits = limit.toString(2).length;
  const bytes = new Uint8Array(Math.ceil(bits / 8));
  const mask = 255 >>> (bytes.length * 8 - bits);
  for (;;) {
    globalThis.crypto.getRandomValues(bytes);
    bytes[0] &= mask;
    let value = 0n;
    for (const byte of bytes) value = (value << 8n) | BigInt(byte);
    bytes.fill(0);
    if (value < limit) return value;
  }
}
const SMALL_PRIMES = [3n, 5n, 7n, 11n, 13n, 17n, 19n, 23n, 29n, 31n,
  37n, 41n, 43n, 47n, 53n, 59n, 61n, 67n, 71n, 73n, 79n, 83n, 89n, 97n];
async function probablePrime(candidate) {
  if (candidate < 2n) return false;
  if (candidate === 2n) return true;
  if (!(candidate & 1n)) return false;
  for (const p of SMALL_PRIMES) {
    if (candidate === p) return true;
    if (candidate % p === 0n) return false;
  }
  let d = candidate - 1n, s = 0;
  while (!(d & 1n)) { d >>= 1n; s++; }
  for (let round = 0; round < ROUNDS; round++) {
    // Every round yields, including early composite rejection rounds.
    await pause();
    const a = 2n + randomBelow(candidate - 3n);
    let x = modPow(a, d, candidate);
    if (x === 1n || x === candidate - 1n) continue;
    let passed = false;
    for (let j = 1; j < s; j++) {
      x = x * x % candidate;
      if (x === candidate - 1n) { passed = true; break; }
      if (x === 1n) return false;
    }
    if (!passed) return false;
  }
  return true;
}
async function generatePrime() {
  const highBit = 1n << BigInt(PRIME_BITS - 1);
  for (let attempts = 0; ; attempts++) {
    if (attempts % 16 === 0) await pause();
    const candidate = highBit | randomBelow(highBit) | 1n;
    if (await probablePrime(candidate)) return candidate;
  }
}
// Private factory: tests inject tiny keys through an isolated source instrument,
// never via createSession arguments or a production export.
function sessionFromPrimes(p, q) {
  const n = p * q, square = n * n;
  const lambda = (p - 1n) / gcd(p - 1n, q - 1n) * (q - 1n);
  const mu = inverse(lambda, n); // g = n+1 gives L(g^lambda mod n²) = lambda mod n.
  return Object.freeze({
    n: n.toString(),
    encrypt(value) {
      if (!Number.isSafeInteger(value) || value < 0 || value > MAX_VALUE || BigInt(value) >= n) {
        throw new RangeError('Value must be a safe integer from 0 through 1000000.');
      }
      let r;
      do { r = 1n + randomBelow(n - 1n); } while (gcd(r, n) !== 1n);
      // (n+1)^m = 1 + nm mod n². A fresh coprime randomizer is sampled per call.
      return ((1n + n * BigInt(value)) * modPow(r, n, square) % square).toString();
    },
    decrypt(cipher) {
      if (typeof cipher === 'string' && /^[1-9][0-9]*$/.test(cipher) && cipher.length <= square.toString().length) {
        cipher = BigInt(cipher);
      }
      if (typeof cipher !== 'bigint' || cipher < 1n || cipher >= square || gcd(cipher, n) !== 1n) {
        throw new RangeError('Invalid Paillier ciphertext.');
      }
      const powered = modPow(cipher, lambda, square);
      if ((powered - 1n) % n !== 0n) throw new RangeError('Invalid Paillier ciphertext.');
      const value = (powered - 1n) / n * mu % n;
      if (value > 4n * BigInt(MAX_VALUE)) throw new RangeError('Result outside four-record profile.');
      return Number(value);
    },
  });
}

/** Generate a fresh 2048-bit public modulus. Keep the returned session in browser memory. */
export async function createSession() {
  if (!globalThis.crypto?.getRandomValues) throw new Error('WebCrypto is required.');
  let p = await generatePrime();
  for (;;) {
    const q = await generatePrime();
    if (p === q || (p * q).toString(2).length !== 2048) continue;
    if (gcd((p - 1n) * (q - 1n), p * q) !== 1n) { p = await generatePrime(); continue; }
    return sessionFromPrimes(p, q);
  }
}
