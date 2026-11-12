/** Shared fixed protocol, not a security audit or a verifiable-computation proof.
 * Prototype assumes an honest browser/garbler and a semi-honest evaluator,
 * secure WebCrypto/CSPRNG and authenticated delivery of this application.
 * Row count/topology are public. No OT: all private inputs belong to browser.
 * Never send output decoding pairs, CSV metadata, or unused input labels.
 */
/** Wire format (no arbitrary topology supplied):
 * {profile,nonce:32 lowercase hex,rowCount:1..32,rows:[{inputs,tables}]}.
 * inputs: 10 canonical base64 labels (8 value bits LSB-first, zero, one).
 * tables: 68 arrays, 2 entries for NOT, 4 otherwise, point-permute ordered.
 * Each entry base64(IV12 || AES256GCM(label16) || tag16), 44 bytes.
 * Key SHA256(UTF8(profile+'/garble') || u32BE(row) || u32BE(gate)
 *            || nonce16 || A16 || B16); omit B only for unary NOT.
 * AAD is the domain and two indices; IV is independently random per entry.
 * Response outputs: rowCount arrays of 8 base64 labels, LSB-first.
 * canonicalRequest fixes JSON key order; canonicalOutput is JSON(outputs).
 * Hashes commit to transcripts and the fixed program; they prove no execution.
 */
export const PROFILE = 'nope-csv-gc-v1';
export const MAX_ROWS = 32;
export const LABEL_BYTES = 16;
export const ENTRY_BYTES = 44;
const encoder = new TextEncoder();
const fail = message => { throw new Error(message); };
export function cryptoProvider() {
  const c = globalThis.crypto;
  if (!c?.subtle || !c?.getRandomValues) fail('Secure WebCrypto is required.');
  return c;
}
export function toBase64(bytes) {
  return btoa(String.fromCharCode(...bytes));
}
export function fromBase64(value, length = LABEL_BYTES) {
  if (typeof value !== 'string' || value.length !== 4 * Math.ceil(length / 3) || !/^[A-Za-z0-9+/]*={0,2}$/.test(value)) fail('Invalid canonical base64.');
  let bytes;
  try { bytes = Uint8Array.from(atob(value), c => c.charCodeAt(0)); } catch { fail('Invalid base64.'); }
  if (bytes.length !== length || toBase64(bytes) !== value) fail('Invalid base64 length or encoding.');
  return bytes;
}
export function permutation(label) { return label[LABEL_BYTES - 1] & 1; }
export function nonceBytes(nonce) {
  if (typeof nonce !== 'string' || !/^[0-9a-f]{32}$/.test(nonce)) fail('Invalid job nonce.');
  return Uint8Array.from(nonce.match(/../g), b => parseInt(b, 16));
}
// One canonical per-row circuit: value bits LSB first, zero wire8, one wire9.
// No simplification based on values, no free XOR, every gate allocates a wire.
function makeCircuit() {
  const gates = []; let next = 10;
  const gate = (op, a, b) => { const out = next++; gates.push(Object.freeze(b === undefined ? {op,a,out} : {op,a,b,out})); return out; };
  let equal = 9, greater = 8, empty = 9;
  for (let i = 7; i >= 0; i--) {
    const bit = (100 >>> i) & 1;
    const not = gate('NOT', i);
    if (!bit) greater = gate('OR', greater, gate('AND', equal, i));
    equal = gate('AND', equal, bit ? i : not);
    empty = gate('AND', empty, i);
  }
  const valid = gate('NOT', empty), keep = gate('NOT', greater);
  const outputs = [];
  for (let i = 0; i < 8; i++) {
    // mux expressed using ordinary independent garbled AND/XOR gates.
    const low = gate('AND', keep, i);
    const high = gate('AND', greater, (100 >>> i) & 1 ? 9 : 8);
    outputs.push(gate('AND', valid, gate('XOR', low, high)));
  }
  return Object.freeze({ inputs: Object.freeze(Array.from({length:10}, (_,i)=>i)), gates: Object.freeze(gates), outputs: Object.freeze(outputs), wireCount:next });
}
const CIRCUIT = makeCircuit();
export const GATES_PER_ROW = CIRCUIT.gates.length;
export const MAX_GATES = MAX_ROWS * GATES_PER_ROW;
export function buildCircuit() { return CIRCUIT; }
export function gateContext(rowIndex, gateIndex) {
  if (!Number.isInteger(rowIndex) || rowIndex < 0 || rowIndex >= MAX_ROWS || !Number.isInteger(gateIndex) || gateIndex < 0 || gateIndex >= GATES_PER_ROW) fail('Invalid gate coordinates.');
  const domain = encoder.encode(PROFILE + '/garble');
  const info = new Uint8Array(domain.length + 8); info.set(domain);
  const view = new DataView(info.buffer); view.setUint32(domain.length, rowIndex, false); view.setUint32(domain.length + 4, gateIndex, false);
  return info;
}
/** Ordered concatenation deliberately avoids A XOR B / duplicate-input bugs. */
export async function deriveGateKey(nonce, rowIndex, gateIndex, a, b) {
  if (!(a instanceof Uint8Array) || a.length !== 16 || (b !== undefined && (!(b instanceof Uint8Array) || b.length !== 16))) fail('Invalid key labels.');
  const context = gateContext(rowIndex,gateIndex), salt = nonceBytes(nonce);
  const material = new Uint8Array(context.length + salt.length + (b === undefined ? 16 : 32));
  material.set(context); material.set(salt,context.length); material.set(a,context.length+16);
  if (b) material.set(b,context.length+32);
  const crypto = cryptoProvider();
  const digest = await crypto.subtle.digest('SHA-256',material);
  return crypto.subtle.importKey('raw',digest,{name:'AES-GCM'},false,['encrypt','decrypt']);
}
function exactKeys(value, keys) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).sort().join(',') !== keys.slice().sort().join(',')) fail('Unexpected protocol fields.');
}
export function validateRequest(request) {
  exactKeys(request,['profile','nonce','rowCount','rows']);
  if (request.profile !== PROFILE) fail('Unsupported garbled profile.');
  nonceBytes(request.nonce);
  if (!Number.isInteger(request.rowCount) || request.rowCount < 1 || request.rowCount > MAX_ROWS || !Array.isArray(request.rows) || request.rows.length !== request.rowCount) fail('Expected 1–32 rows.');
  for (const row of request.rows) {
    exactKeys(row,['inputs','tables']);
    if (!Array.isArray(row.inputs) || row.inputs.length !== 10 || !Array.isArray(row.tables) || row.tables.length !== GATES_PER_ROW) fail('Invalid fixed circuit shape.');
    for (const label of row.inputs) fromBase64(label);
    for (const [i,table] of row.tables.entries()) {
      if (!Array.isArray(table) || table.length !== (CIRCUIT.gates[i].op === 'NOT' ? 2 : 4)) fail('Invalid gate table shape.');
      for (const entry of table) fromBase64(entry,ENTRY_BYTES);
    }
  }
  return request;
}
export function canonicalRequest(request) {
  validateRequest(request);
  return JSON.stringify({profile:PROFILE,nonce:request.nonce,rowCount:request.rowCount,rows:request.rows.map(row=>({inputs:row.inputs,tables:row.tables}))});
}
/** Output commitment is compact JSON of labels; request hash separately binds context. */
export function canonicalOutput(outputs) {
  validateOutputLabels(outputs,outputs?.length);
  return JSON.stringify(outputs);
}
export function canonicalProgram() {
  return JSON.stringify({profile:PROFILE,inputs:CIRCUIT.inputs,gates:CIRCUIT.gates,outputs:CIRCUIT.outputs,wireCount:CIRCUIT.wireCount});
}
export const hashProgram = () => sha256(canonicalProgram());
export const programSha256 = hashProgram;

export function validateOutputLabels(labels, rowCount) {
  if (!Number.isInteger(rowCount) || rowCount < 1 || rowCount > MAX_ROWS || !Array.isArray(labels) || labels.length !== rowCount) fail('Invalid output row count.');
  for (const row of labels) {
    if (!Array.isArray(row) || row.length !== 8) fail('Invalid output label count.');
    for (const label of row) fromBase64(label);
  }
  return labels;
}
export async function sha256(text) {
  if (typeof text !== 'string') fail('Hash input must be text.');
  const hash = await cryptoProvider().subtle.digest('SHA-256',encoder.encode(text));
  return Array.from(new Uint8Array(hash),b=>b.toString(16).padStart(2,'0')).join('');
}
export const hashRequest = request => sha256(canonicalRequest(request));
export const hashOutput = (value, outputs) => sha256(canonicalOutput(outputs ?? (Array.isArray(value) ? value : value.outputs)));
