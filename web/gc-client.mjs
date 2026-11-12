import { PROFILE, MAX_ROWS, buildCircuit, cryptoProvider, permutation, toBase64, fromBase64, deriveGateKey, gateContext, validateOutputLabels } from './gc-core.mjs';

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
  // Only output pairs survive in this closure. Do not export them for tests.
  const rowCount = input.length;
  return {request,decode(outputLabels) {
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
