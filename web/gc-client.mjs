import { PROFILE, MAX_ROWS, buildCircuit, cryptoProvider, permutation, toBase64, fromBase64, deriveGateKey, gateContext, validateOutputLabels, validateRequest } from './gc-core.mjs';

/** Fresh independent labels for every wire, with opposite random permutation bits.
 * No global delta, free XOR, half gates, or output mapping in the request.
 * This is prototype garbling under the shared core's assumptions, not a proof.
 */
function wirePair(crypto) {
  const zero = crypto.getRandomValues(new Uint8Array(16));
  const one = crypto.getRandomValues(new Uint8Array(16));
  one[15] = (one[15] & 254) | ((zero[15] & 1) ^ 1);
  return [zero,one];
}
function truth(op,a,b) {
  switch (op) {
    case 'AND': return a & b;
    case 'OR': return a | b;
    case 'XOR': return a ^ b;
    case 'NOT': return a ^ 1;
    default: throw new Error('Unknown fixed gate.');
  }
}
export async function createGarbledJob(values) {
  if (!Array.isArray(values) || values.length < 1 || values.length > MAX_ROWS || Array.from(values).some(v=>!Number.isInteger(v) || v < 0 || v > 255)) throw new Error('Expected 1–32 byte values.');
  const input = values.slice(), crypto = cryptoProvider(), circuit = buildCircuit();
  const nonce = Array.from(crypto.getRandomValues(new Uint8Array(16)), b=>b.toString(16).padStart(2,'0')).join('');
  const outputPairs = [];
  const rows = [];
  for (let r = 0; r < input.length; r++) {
    const pairs = Array.from({length:circuit.wireCount},()=>wirePair(crypto));
    const tables = [];
    for (const [g,gate] of circuit.gates.entries()) {
      const table = new Array(gate.op === 'NOT' ? 2 : 4);
      await Promise.all([0,1].flatMap(a=> (gate.op === 'NOT' ? [undefined] : [0,1]).map(async b=> {
        const la = pairs[gate.a][a], lb = b === undefined ? undefined : pairs[gate.b][b];
        const key = await deriveGateKey(nonce,r,g,la,lb);
        const iv = crypto.getRandomValues(new Uint8Array(12));
        const sealed = new Uint8Array(await crypto.subtle.encrypt({name:'AES-GCM',iv,additionalData:gateContext(r,g),tagLength:128},key,pairs[gate.out][truth(gate.op,a,b)]));
        const entry = new Uint8Array(44); entry.set(iv); entry.set(sealed,12);
        table[lb === undefined ? permutation(la) : 2*permutation(la)+permutation(lb)] = toBase64(entry);
      })));
      tables.push(table);
    }
    rows.push({inputs:pairs.slice(0,10).map((pair,i)=>toBase64(pair[i < 8 ? (input[r] >>> i) & 1 : i - 8])),tables});
    outputPairs.push(circuit.outputs.map(wire=>pairs[wire].map(toBase64)));
  }
  const request = {profile:PROFILE,nonce,rowCount:input.length,rows};
  return decoder({nonce,rowCount:input.length,outputPairs,request});
}

const decoderAAD = new TextEncoder().encode(PROFILE + "/sealed-decoder/v1");
function decoder({nonce,rowCount,outputPairs,request}) {
  // Keep an immutable snapshot: callers cannot change the request sealed later.
  request = JSON.parse(JSON.stringify(request));
  const freeze = value => { if (value && typeof value === "object") { Object.values(value).forEach(freeze); Object.freeze(value); } return value; };
  freeze(request);
  return {request, async sealDecoder(key) {
    decoderKey(key);
    const crypto = cryptoProvider(), iv = crypto.getRandomValues(new Uint8Array(12));
    const plaintext = new TextEncoder().encode(JSON.stringify({nonce,rowCount,outputPairs,request}));
    const bytes = new Uint8Array(await crypto.subtle.encrypt({name:"AES-GCM",iv,additionalData:decoderAAD},key,plaintext));
    return {iv:toBase64(iv),ciphertext:encodeBytes(bytes)};
  },decode(outputLabels) {
    validateOutputLabels(outputLabels,rowCount);
    return outputLabels.map((row,r)=>row.reduce((value,label,i)=> {
      // Strict canonical encoding checked above; equality verifies membership,
      // not execution provenance. UI must compare the decoded result to reference.
      fromBase64(label);
      const bit = outputPairs[r][i].indexOf(label);
      if (bit < 0) throw new Error('Output label does not belong to this job and wire.');
      return value | (bit << i);
    },0));
  }};
}

// Chunked encoding avoids argument-stack limits for the largest 32-row request.
function encodeBytes(bytes) {
  let binary = '';
  for (let i=0;i<bytes.length;i+=8192) binary += String.fromCharCode(...bytes.subarray(i,i+8192));
  return btoa(binary);
}
function decoderKey(key) {
  if (key?.type !== 'secret' || key.algorithm?.name !== 'AES-GCM' || key.algorithm.length !== 256 || key.extractable !== false || !['encrypt','decrypt'].every(use=>key.usages.includes(use))) throw new Error('Nonextractable AES-256-GCM decoder key required.');
}
/** Restore only authenticated local decoder ciphertext; never exports its pairs.
 * Membership checks authenticate labels to wires, not evaluator execution.
 */
export async function restoreGarbledJob(sealed,key) {
  decoderKey(key);
  if (!sealed || Object.keys(sealed).sort().join(',') !== 'ciphertext,iv' || typeof sealed.ciphertext !== 'string' || sealed.ciphertext.length > 3000000) throw new Error('Invalid sealed decoder.');
  const length = atob(sealed.ciphertext).length;
  const ciphertext = fromBase64(sealed.ciphertext,length);
  const plaintext = await cryptoProvider().subtle.decrypt({name:'AES-GCM',iv:fromBase64(sealed.iv,12),additionalData:decoderAAD},key,ciphertext);
  const state = JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(plaintext));
  if (!state || Object.keys(state).sort().join(',') !== 'nonce,outputPairs,request,rowCount') throw new Error('Invalid decoder fields.');
  validateRequest(state.request);
  if (state.nonce !== state.request.nonce || state.rowCount !== state.request.rowCount) throw new Error('Invalid decoder request binding.');
  if (!Array.isArray(state.outputPairs) || state.outputPairs.length !== state.rowCount) throw new Error('Invalid output pair row count.');
  const seen = new Set();
  for (const row of state.outputPairs) {
    if (!Array.isArray(row) || row.length !== 8) throw new Error('Invalid output pair wire count.');
    for (const pair of row) {
      if (!Array.isArray(pair) || pair.length !== 2) throw new Error('Invalid output pair shape.');
      const labels = pair.map(label=>fromBase64(label));
      if (permutation(labels[0]) === permutation(labels[1])) throw new Error('Invalid output pair permutation.');
      for (const label of pair) { if (seen.has(label)) throw new Error('Duplicate output label.'); seen.add(label); }
    }
  }
  return decoder(state);
}
