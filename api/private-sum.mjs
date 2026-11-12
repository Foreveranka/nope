/** Stateless Paillier additive sum demo; no FHE, key handling, storage or request logging.
 * Validates group elements, not encrypted value ranges or honest key generation.
 * This unaudited demo provides no proof of execution and is not constant-time.
 */
const MAX_BODY = 8192;
const PROFILE = 'paillier-sum4-v1';
function fail(status, message) { throw Object.assign(new Error(message), {status}); }
function gcd(a, b) { while (b) [a, b] = [b, a % b]; return a; }
function decimal(value, digits) {
  if (typeof value !== 'string' || value.length > digits || !/^[1-9][0-9]*$/.test(value)) {
    fail(400, 'Expected a canonical positive decimal string.');
  }
  return BigInt(value);
}
function aggregate(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body) ||
      Object.keys(body).length !== 2 || !Object.hasOwn(body, 'n') || !Object.hasOwn(body, 'ciphertexts')) {
    fail(400, 'Only n and ciphertexts are accepted.');
  }
  const n = decimal(body.n, 617);
  if (n.toString(2).length !== 2048 || !(n & 1n)) fail(400, 'Expected an odd 2048-bit modulus.');
  if (!Array.isArray(body.ciphertexts) || body.ciphertexts.length !== 4) fail(400, 'Exactly four ciphertexts are required.');
  const square = n * n;
  let result = 1n;
  for (const raw of body.ciphertexts) {
    const cipher = decimal(raw, 1234);
    if (cipher < 1n || cipher >= square || gcd(cipher, n) !== 1n) fail(400, 'Ciphertext outside the Paillier group.');
    result = result * cipher % square;
  }
  return {ciphertext: result.toString(), profile: PROFILE};
}
function validateOrigin(req) {
  const host = req.headers?.host;
  const origin = req.headers?.origin;
  if (typeof host !== 'string' || typeof origin !== 'string') fail(403, 'Same-host Origin required.');
  try {
    const parsed = new URL(origin);
    // Exact host including port; forwarded headers never authorize a request.
    if (!['https:', 'http:'].includes(parsed.protocol) || parsed.origin !== origin || parsed.host !== host ||
        req.headers['sec-fetch-site'] === 'cross-site') fail(403, 'Same-host Origin required.');
  } catch { fail(403, 'Same-host Origin required.'); }
}
async function readBody(req) {
  const length = req.headers?.['content-length'];
  if (length !== undefined && (typeof length !== 'string' || !/^[0-9]+$/.test(length))) fail(400, 'Invalid body length.');
  if (length !== undefined && Number(length) > MAX_BODY) fail(413, 'Body exceeds 8KB.');
  let bytes;
  // Vercel may supply an already-parsed body; also support bounded raw Node streams.
  if (req.body !== undefined) {
    bytes = Buffer.isBuffer(req.body) ? req.body : Buffer.from(typeof req.body === 'string' ? req.body : JSON.stringify(req.body));
    if (bytes.length > MAX_BODY) fail(413, 'Body exceeds 8KB.');
  } else {
    const chunks = [];
    let size = 0;
    for await (const chunk of req) {
      const part = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      size += part.length;
      if (size > MAX_BODY) fail(413, 'Body exceeds 8KB.');
      chunks.push(part);
    }
    bytes = Buffer.concat(chunks);
  }
  try { return JSON.parse(bytes.toString('utf8')); }
  catch { fail(400, 'Invalid JSON body.'); }
}
export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  try {
    if (req.method !== 'POST') {
      res.setHeader('Allow', 'POST');
      fail(405, 'POST required.');
    }
    validateOrigin(req);
    if (!/^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(req.headers?.['content-type'] || '')) fail(415, 'JSON content type required.');
    const result = aggregate(await readBody(req));
    res.statusCode = 200;
    res.end(JSON.stringify(result));
  } catch (error) {
    res.statusCode = error.status || 400;
    res.end(JSON.stringify({error: error.status ? error.message : 'Invalid request.'}));
  }
}
