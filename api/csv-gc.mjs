/** Stateless fixed-circuit evaluator. Receives labels/tables only; no output bit mapping.
 * This unaudited garbled-circuit demo is not a proof of honest client garbling or execution.
 */
import {createDecipheriv} from 'node:crypto';
import {
  PROFILE, ENTRY_BYTES, buildCircuit, validateRequest, deriveGateKey, gateContext,
  fromBase64, toBase64, hashRequest, hashOutput, hashProgram,
} from '../web/gc-core.mjs';

const MAX_BODY = 1024 * 1024;
const invalid = status => { throw Object.assign(new Error('Invalid request.'), {status}); };

function validateOrigin(req) {
  const {host, origin} = req.headers || {};
  if (typeof host !== 'string' || typeof origin !== 'string') invalid(403);
  try {
    const url = new URL(origin);
    if (!['http:', 'https:'].includes(url.protocol) || url.origin !== origin || url.host !== host ||
        req.headers['sec-fetch-site'] === 'cross-site') invalid(403);
  } catch { invalid(403); }
}

// Bound an already-parsed Vercel body before JSON.stringify creates another copy.
// Only ordinary JSON data is accepted: no accessors, prototypes, cycles or toJSON hooks.
function boundedJson(value) {
  let budget = MAX_BODY;
  const seen = new WeakSet();
  function consume(n) { budget -= n; if (budget < 0) invalid(413); }
  function string(s) {
    if (s.length > MAX_BODY) invalid(413);
    consume(2);
    for (let i = 0; i < s.length; i++) {
      const c = s.charCodeAt(i);
      if (c === 34 || c === 92 || [8, 9, 10, 12, 13].includes(c)) consume(2);
      else if (c < 32) consume(6);
      else if (c < 128) consume(1);
      else if (c < 2048) consume(2);
      else if (c >= 0xd800 && c <= 0xdbff && i + 1 < s.length &&
               s.charCodeAt(i + 1) >= 0xdc00 && s.charCodeAt(i + 1) <= 0xdfff) { consume(4); i++; }
      else consume(c >= 0xd800 && c <= 0xdfff ? 6 : 3);
    }
  }
  function visit(v, depth) {
    if (depth > 16) invalid(400);
    if (v === null) { consume(4); return; }
    if (typeof v === 'string') { string(v); return; }
    if (typeof v === 'boolean') { consume(v ? 4 : 5); return; }
    if (typeof v === 'number' && Number.isFinite(v)) { consume(String(v).length); return; }
    if (typeof v !== 'object') invalid(400);
    if (seen.has(v)) invalid(400);
    seen.add(v);
    const array = Array.isArray(v);
    if (Object.getPrototypeOf(v) !== (array ? Array.prototype : Object.prototype) &&
        !(Object.getPrototypeOf(v) === null && !array)) invalid(400);
    const keys = Reflect.ownKeys(v);
    if (keys.length > MAX_BODY / 2) invalid(413);
    consume(2);
    let count = 0;
    for (const key of keys) {
      if (array && key === 'length') continue;
      if (typeof key !== 'string') invalid(400);
      if (array && (String(count) !== key || count >= v.length)) invalid(400);
      const descriptor = Object.getOwnPropertyDescriptor(v, key);
      if (!descriptor.enumerable || !Object.hasOwn(descriptor, 'value')) invalid(400);
      if (count++) consume(1);
      if (!array) { string(key); consume(1); }
      visit(descriptor.value, depth + 1);
    }
    if (array && count !== v.length) invalid(400);
    seen.delete(v);
  }
  visit(value, 0);
  return Buffer.from(JSON.stringify(value));
}

async function readBody(req) {
  const length = req.headers?.['content-length'];
  if (length !== undefined && (typeof length !== 'string' || !/^(0|[1-9][0-9]*)$/.test(length))) invalid(400);
  if (length !== undefined && (!Number.isSafeInteger(Number(length)) || Number(length) > MAX_BODY)) invalid(413);
  if (req.headers?.['content-encoding'] !== undefined && req.headers['content-encoding'] !== 'identity') invalid(415);
  let bytes;
  if (req.body !== undefined) {
    if (Buffer.isBuffer(req.body)) bytes = req.body;
    else if (typeof req.body === 'string') {
      if (Buffer.byteLength(req.body) > MAX_BODY) invalid(413);
      bytes = Buffer.from(req.body);
    } else bytes = boundedJson(req.body);
    if (bytes.length > MAX_BODY) invalid(413);
  } else {
    const chunks = [];
    let size = 0;
    for await (const chunk of req) {
      if (typeof chunk !== 'string' && !Buffer.isBuffer(chunk) && !(chunk instanceof Uint8Array)) invalid(400);
      const part = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      size += part.length;
      if (size > MAX_BODY) invalid(413);
      chunks.push(part);
    }
    bytes = Buffer.concat(chunks, size);
  }
  // A parsed object has no original byte representation to compare with Content-Length.
  if (length !== undefined && (req.body === undefined || typeof req.body === 'string' || Buffer.isBuffer(req.body)) &&
      Number(length) !== bytes.length) invalid(400);
  try { return JSON.parse(new TextDecoder('utf-8', {fatal: true}).decode(bytes)); }
  catch { invalid(400); }
}

async function evaluate(request) {
  validateRequest(request);
  const circuit = buildCircuit();
  const outputs = [];
  for (let rowIndex = 0; rowIndex < request.rowCount; rowIndex++) {
    const row = request.rows[rowIndex];
    const wires = row.inputs.map(label => fromBase64(label));
    for (let gateIndex = 0; gateIndex < circuit.gates.length; gateIndex++) {
      const gate = circuit.gates[gateIndex];
      const a = wires[gate.a];
      const b = gate.op === 'NOT' ? undefined : wires[gate.b];
      const select = b ? 2 * (a[15] & 1) + (b[15] & 1) : a[15] & 1;
      const entry = fromBase64(row.tables[gateIndex][select], ENTRY_BYTES);
      const key = await deriveGateKey(request.nonce, rowIndex, gateIndex, a, b);
      const decipher = createDecipheriv('aes-256-gcm', key, entry.subarray(0, 12));
      decipher.setAAD(gateContext(rowIndex, gateIndex));
      decipher.setAuthTag(entry.subarray(28, 44));
      const label = Buffer.concat([decipher.update(entry.subarray(12, 28)), decipher.final()]);
      if (label.length !== 16) invalid(400);
      wires[gate.out] = label;
    }
    outputs.push(circuit.outputs.map(wire => toBase64(wires[wire])));
  }
  const result = {profile: PROFILE, nonce: request.nonce, rowCount: request.rowCount, outputs};
  return {...result, inputSha256: await hashRequest(request),
    outputSha256: await hashOutput(request, outputs), programSha256: await hashProgram()};
}

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  try {
    if (req.method !== 'POST') { res.setHeader('Allow', 'POST'); invalid(405); }
    validateOrigin(req);
    if (!/^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(req.headers?.['content-type'] || '')) invalid(415);
    const result = await evaluate(await readBody(req));
    res.statusCode = 200;
    res.end(JSON.stringify(result));
  } catch (error) {
    res.statusCode = [400, 403, 405, 413, 415].includes(error?.status) ? error.status : 400;
    res.end(JSON.stringify({error: 'Invalid request.'}));
  }
}
