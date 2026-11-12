import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, createDecipheriv } from 'node:crypto';
import { createGarbledJob } from './gc-client.mjs';
import { PROFILE, buildCircuit, GATES_PER_ROW, canonicalRequest, canonicalOutput, hashRequest, hashOutput, hashProgram, programSha256, validateRequest, fromBase64, toBase64, deriveGateKey, gateContext } from './gc-core.mjs';

// Independent Node evaluator: no client secrets or production KDF/decryption helpers.
// Separate API agent also tests the HTTP evaluator against these browser jobs.
function evaluate(request) {
  validateRequest(request);
  const circuit = buildCircuit();
  return request.rows.map((row,r)=> {
    const wires = row.inputs.map(s=>Buffer.from(s,'base64'));
    circuit.gates.forEach((gate,g)=> {
      const a=wires[gate.a], b=gate.op === 'NOT' ? undefined : wires[gate.b];
      const index=b ? 2*(a[15]&1)+(b[15]&1) : a[15]&1;
      const suffix=Buffer.alloc(8); suffix.writeUInt32BE(r,0); suffix.writeUInt32BE(g,4);
      const context=Buffer.concat([Buffer.from('nope-csv-gc-v1/garble'),suffix]);
      const key=createHash('sha256').update(Buffer.concat([context,Buffer.from(request.nonce,'hex'),a,...(b?[b]:[])])).digest();
      const entry=Buffer.from(row.tables[g][index],'base64');
      const decipher=createDecipheriv('aes-256-gcm',key,entry.subarray(0,12));
      decipher.setAAD(context); decipher.setAuthTag(entry.subarray(28));
      wires[gate.out]=Buffer.concat([decipher.update(entry.subarray(12,28)),decipher.final()]);
    });
    return circuit.outputs.map(w=>wires[w].toString('base64'));
  });
}
const clean=v=>v===255?0:Math.min(100,v);
const copy=x=>JSON.parse(JSON.stringify(x));

test('all 256 byte inputs: real garbling and independent AES-GCM evaluation',async()=> {
  for(let start=0;start<256;start+=32) {
    const values=Array.from({length:32},(_,i)=>start+i);
    const job=await createGarbledJob(values);
    assert.deepEqual(job.decode(evaluate(job.request)),values.map(clean));
    assert.deepEqual(Object.keys(job).sort(),['decode','request']);
    assert.deepEqual(Object.keys(job.request).sort(),['nonce','profile','rowCount','rows']);
    assert.equal(job.request.profile,PROFILE);
    for(const row of job.request.rows) {
      assert.equal(row.inputs.length,10);
      assert.equal(row.tables.length,GATES_PER_ROW);
      row.inputs.forEach(s=>assert.equal(fromBase64(s).length,16));
      row.tables.flat().forEach(s=>assert.equal(fromBase64(s,44).length,44));
    }
    assert.doesNotMatch(JSON.stringify(job.request),/"(?:values|secret|outputPairs|outputs|outputLabels|filename|headers|decode)"/);
  }
});

test('fixed topology is deeply immutable, bounded, and forward-only',()=> {
  const c=buildCircuit();
  assert.equal(GATES_PER_ROW,68); assert.equal(c.wireCount,78);
  assert.ok(Object.isFrozen(c) && Object.isFrozen(c.gates) && Object.isFrozen(c.inputs) && Object.isFrozen(c.outputs));
  c.gates.forEach((g,i)=> {
    assert.ok(Object.isFrozen(g)); assert.equal(g.out,10+i);
    assert.ok(g.a<g.out); if(g.op!=='NOT') assert.ok(g.b<g.out);
  });
  assert.throws(()=>{c.outputs[0]=0;});
});

test('fresh jobs, independent rows, canonical commitments and wire membership',async()=> {
  const a=await createGarbledJob([255,0,100,101]), b=await createGarbledJob([255,0,100,101]);
  const outputs=evaluate(a.request);
  assert.notEqual(a.request.nonce,b.request.nonce);
  assert.notDeepEqual(a.request.rows,b.request.rows);
  assert.equal(new Set(a.request.rows.flatMap(r=>r.inputs)).size,40);
  assert.throws(()=>b.decode(outputs),/belong/);
  const swapped=copy(outputs); [swapped[0],swapped[1]]=[swapped[1],swapped[0]];
  assert.throws(()=>a.decode(swapped),/belong/);
  const shuffled=copy(outputs); [shuffled[0][0],shuffled[0][1]]=[shuffled[0][1],shuffled[0][0]];
  assert.throws(()=>a.decode(shuffled),/belong/);
  assert.throws(()=>a.decode(outputs.slice(1)),/row/);
  assert.throws(()=>a.decode([[...outputs[0],outputs[0][0]],...outputs.slice(1)]),/count/);
  const forged=copy(outputs); forged[0][0]=toBase64(new Uint8Array(16));
  assert.throws(()=>a.decode(forged),/belong/);
  const digest=s=>createHash('sha256').update(s).digest('hex');
  assert.equal(await hashRequest(a.request),digest(canonicalRequest(a.request)));
  assert.equal(canonicalOutput(outputs),JSON.stringify(outputs));
  assert.equal(await hashOutput(outputs),digest(JSON.stringify(outputs)));
  assert.equal(await hashOutput(a.request,outputs),await hashOutput({outputs}));
  assert.equal(await hashProgram(),await programSha256());
  assert.equal(canonicalRequest({...a.request,rows:a.request.rows,nonce:a.request.nonce}),canonicalRequest(a.request));
});

test('tampered IV, ciphertext, tag, labels, nonce and reordered rows fail closed',async()=> {
  const {request}=await createGarbledJob([42,154]);
  const gate=buildCircuit().gates[0];
  const a=fromBase64(request.rows[0].inputs[gate.a]);
  const selected=a[15]&1; // first gate NOT
  for(const offset of [0,12,28,43]) {
    const bad=copy(request), bytes=fromBase64(bad.rows[0].tables[0][selected],44);
    bytes[offset]^=1; bad.rows[0].tables[0][selected]=toBase64(bytes);
    assert.throws(()=>evaluate(bad));
  }
  const bad=copy(request); bad.nonce='0'.repeat(32); assert.throws(()=>evaluate(bad));
  const changed=copy(request); const label=fromBase64(changed.rows[0].inputs[7]); label[0]^=1;
  changed.rows[0].inputs[7]=toBase64(label); assert.throws(()=>evaluate(changed));
  const reordered=copy(request); reordered.rows.reverse(); assert.throws(()=>evaluate(reordered));
});

test('strict protocol shape, limits and canonical base64',async()=> {
  for(const values of [[],new Array(1),new Array(33).fill(1),[-1],[256],[1.5],[NaN],['1'],new Uint8Array([1])]) await assert.rejects(createGarbledJob(values));
  const {request}=await createGarbledJob([1]);
  const mutations=[r=>r.circuit={},r=>r.rows[0].values=[1],r=>r.rowCount=33,r=>r.nonce=r.nonce.toUpperCase(),r=>r.rows[0].inputs.push(r.rows[0].inputs[0]),r=>r.rows[0].tables.pop(),r=>r.rows[0].tables[0].push(r.rows[0].tables[0][0]),r=>r.rows[0].inputs[0]='AAAAAAAAAAAAAAAAAAAAAB=='];
  for(const mutate of mutations) {const bad=copy(request);mutate(bad);assert.throws(()=>validateRequest(bad));}
});

test('ordered double keys preserve duplicate inputs and gate/row domains',async()=> {
  const label=new Uint8Array(16).fill(7), other=new Uint8Array(16).fill(9), nonce='01'.repeat(16);
  async function seal(a,b,r=0,g=0) {
    const key=await deriveGateKey(nonce,r,g,a,b);
    return Buffer.from(await crypto.subtle.encrypt({name:'AES-GCM',iv:new Uint8Array(12),additionalData:gateContext(r,g)},key,label)).toString('hex');
  }
  assert.notEqual(await seal(label,label),await seal(other,other));
  assert.notEqual(await seal(label,other),await seal(other,label));
  assert.notEqual(await seal(label,other),await seal(label,other,1));
  assert.notEqual(await seal(label,other),await seal(label,other,0,1));
});

test('instrumented CSPRNG confirms independent per-wire pairs and random IV calls without secret exports',async()=> {
  const descriptor=Object.getOwnPropertyDescriptor(globalThis,'crypto'), real=globalThis.crypto;
  const draws=[];
  Object.defineProperty(globalThis,'crypto',{configurable:true,value:{subtle:real.subtle,getRandomValues(bytes) {
    real.getRandomValues(bytes); draws.push(bytes); return bytes;
  }}});
  try {
    const job=await createGarbledJob([42]);
    const labels=draws.filter(bytes=>bytes.length===16).slice(1); // skip nonce
    assert.equal(labels.length,2*buildCircuit().wireCount);
    assert.equal(new Set(labels.map(toBase64)).size,labels.length);
    for(let i=0;i<labels.length;i+=2) assert.equal((labels[i][15]^labels[i+1][15])&1,1);
    const ivs=draws.filter(bytes=>bytes.length===12);
    assert.equal(ivs.length,buildCircuit().gates.reduce((n,g)=>n+(g.op==='NOT'?2:4),0));
    assert.equal(new Set(ivs.map(toBase64)).size,ivs.length);
    const sent=job.request.rows[0].inputs;
    for(let wire=0;wire<10;wire++) {
      const zero=toBase64(labels[wire*2]), one=toBase64(labels[wire*2+1]);
      assert.ok(sent.includes(zero)!==sent.includes(one));
    }
    const serialized=JSON.stringify(job.request);
    for(const wire of buildCircuit().outputs) {
      assert.equal(serialized.includes(toBase64(labels[wire*2])),false);
      assert.equal(serialized.includes(toBase64(labels[wire*2+1])),false);
    }
  } finally {
    if(descriptor) Object.defineProperty(globalThis,'crypto',descriptor); else delete globalThis.crypto;
  }
});
