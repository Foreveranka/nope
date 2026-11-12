import test from 'node:test';
import assert from 'node:assert/strict';
import {Readable} from 'node:stream';
import {createServer} from 'node:http';
import {createHash} from 'node:crypto';
import handler from '../api/csv-gc.mjs';
import {createGarbledJob} from '../web/gc-client.mjs';
import {
  PROFILE, ENTRY_BYTES, buildCircuit, fromBase64, toBase64,
  hashRequest, hashOutput, hashProgram, GATES_PER_ROW,
} from '../web/gc-core.mjs';

const MAX_BODY = 1024 * 1024;
const host = 'demo.example:8771';
const clone = value => structuredClone(value);
async function call(body, options = {}) {
  const raw = typeof body === 'string' ? body : JSON.stringify(body);
  const req = Readable.from(options.chunks || [Buffer.from(raw)]);
  Object.assign(req, {method: options.method || 'POST', headers: {
    host, origin: `http://${host}`, 'content-type': 'application/json', ...options.headers,
  }});
  if (options.parsed) req.body = body;
  const res = {headers: {}, setHeader(k,v) {this.headers[k.toLowerCase()] = v;},
    end(value) {this.body = JSON.parse(String(value));}};
  await handler(req, res);
  return res;
}
let fixture;
async function payload() {
  fixture ??= await createGarbledJob([42]);
  return clone(fixture.request);
}
function rejected(res, status = 400) {
  assert.equal(res.statusCode, status);
  assert.deepEqual(res.body, {error: 'Invalid request.'});
}

test('stateless raw and Vercel parsed requests evaluate labels with canonical commitments', async () => {
  const request = await payload();
  for (const parsed of [false, true]) {
    const response = await call(request, {parsed});
    assert.equal(response.statusCode, 200);
    const result = response.body;
    assert.deepEqual(Object.keys(result).sort(), ['profile','nonce','rowCount','outputs','inputSha256','outputSha256','programSha256'].sort());
    assert.equal(result.profile, PROFILE);
    assert.equal(result.nonce, request.nonce);
    assert.equal(result.rowCount, 1);
    assert.deepEqual(fixture.decode(result.outputs), [42]);
    assert.equal(result.inputSha256, await hashRequest(request));
    assert.equal(result.outputSha256, await hashOutput(request, result.outputs));
    assert.equal(result.programSha256, await hashProgram());
    assert.equal(result.inputSha256, createHash('sha256').update(JSON.stringify(request)).digest('hex'));
    assert.equal(result.outputSha256, createHash('sha256').update(JSON.stringify(result.outputs)).digest('hex'));
    const circuit=buildCircuit();
    assert.equal(result.programSha256, createHash('sha256').update(JSON.stringify({profile:PROFILE,
      inputs:circuit.inputs,gates:circuit.gates,outputs:circuit.outputs,wireCount:circuit.wireCount})).digest('hex'));
    for (const name of ['inputSha256','outputSha256','programSha256']) assert.match(result[name], /^[0-9a-f]{64}$/);
    assert.equal(response.headers['cache-control'], 'no-store');
    assert.equal(response.headers['access-control-allow-origin'], undefined);
  }
  // Identical replay needs no session state and returns the exact same labels.
  assert.deepEqual((await call(request)).body, (await call(request)).body);
  const reordered = {rows: request.rows.map(row=>({tables:row.tables,inputs:row.inputs})),rowCount:1,nonce:request.nonce,profile:PROFILE};
  assert.deepEqual((await call(reordered)).body, (await call(request)).body);
});

test('strict POST, exact Origin/Host, JSON and encoding guards', async () => {
  const request = await payload();
  for (const method of ['GET','PUT','DELETE','PATCH','OPTIONS']) {
    const res = await call(request, {method});
    rejected(res,405); assert.equal(res.headers.allow,'POST');
  }
  for (const origin of [undefined,'null',`http://${host}/`,`http://${host}/path`,`http://user@${host}`,
    'http://demo.example','http://demo.example:8772',`http://${host}.evil.invalid`,'https://evil.invalid']) {
    rejected(await call(request,{headers:{origin,'x-forwarded-host':host}}),403);
  }
  rejected(await call(request,{headers:{host:undefined}}),403);
  rejected(await call(request,{headers:{'sec-fetch-site':'cross-site'}}),403);
  for (const type of ['text/plain','application/jsonp','application/json; charset=latin1',undefined]) {
    rejected(await call(request,{headers:{'content-type':type}}),415);
  }
  rejected(await call(request,{headers:{'content-encoding':'gzip'}}),415);
  assert.equal((await call(request,{headers:{'x-forwarded-host':'evil.invalid'}})).statusCode,200);
});

test('body bounded before parsing: raw, chunked, Buffer and parsed Vercel bodies', async () => {
  const request = await payload();
  rejected(await call('x'.repeat(MAX_BODY+1)),413);
  rejected(await call('',{chunks:[Buffer.alloc(MAX_BODY),Buffer.alloc(1)]}),413);
  rejected(await call(Buffer.alloc(MAX_BODY+1),{parsed:true}),413);
  rejected(await call({padding:'x'.repeat(MAX_BODY)},{parsed:true}),413);
  rejected(await call({padding:'\u0000'.repeat(MAX_BODY/5)},{parsed:true}),413);
  rejected(await call({padding:'😀'.repeat(MAX_BODY/4)},{parsed:true}),413);
  rejected(await call(request,{headers:{'content-length':String(MAX_BODY+1)}}),413);
  rejected(await call(request,{headers:{'content-length':'9999999999999999999999999999'}}),413);
  for (const length of ['-1','01','1e3','1.2','']) rejected(await call(request,{headers:{'content-length':length}}));
  rejected(await call(request,{headers:{'content-length':'1'}}));
  rejected(await call('{broken'));
  rejected(await call('',{chunks:[Buffer.from([0xff])]}));
  const exact = JSON.stringify(request).padEnd(MAX_BODY,' ');
  assert.equal((await call(exact)).statusCode,200);
  assert.equal((await call(Buffer.from(JSON.stringify(request)),{parsed:true})).statusCode,200);
});

test('rejects plaintext, keys, decoder maps, circuit injection and all incorrect shapes', async () => {
  const request = await payload();
  for (const body of [null,[],{}, {...request,profile:'other'}, {...request,nonce:'A'.repeat(32)},
    {...request,nonce:'0'.repeat(31)}, {...request,rowCount:0}, {...request,rowCount:33},
    {...request,rowCount:1.5}, {...request,rowCount:'1'}, {...request,rowCount:2},
    {...request,rows:[]}, {...request,rows:[null]}, {...request,rows:{}},
    ...['plaintext','key','secretKey','session','invitation','outputPairs','outputs','gates'].map(key=>({...request,[key]:[]}))]) {
    rejected(await call(body));
  }
  const mutations = [
    r=>{r.rows[0].plaintext=42;}, r=>{r.rows[0].gates=buildCircuit().gates;},
    r=>{r.rows[0].inputs.pop();}, r=>{r.rows[0].inputs.push(r.rows[0].inputs[0]);},
    r=>{r.rows[0].tables.pop();}, r=>{r.rows[0].tables.push(r.rows[0].tables[0]);},
    r=>{r.rows[0].tables[0]=[];}, r=>{r.rows[0].tables[0]={a:0,out:0};},
    r=>{r.rows[0].tables[0].push(r.rows[0].tables[0][0]);},
    r=>{r.rows[0].tables[0][0]={iv:'a',ciphertext:'b',tag:'c'};},
  ];
  for (const mutate of mutations) { const r=clone(request); mutate(r); rejected(await call(r)); }
  assert.equal(request.rows[0].tables.length,GATES_PER_ROW);
});

test('requires exact canonical base64 for every label and packed IV/cipher/tag entry', async () => {
  const request = await payload();
  const invalidLabels = ['',null,0,' '.repeat(24),'!'.repeat(24),toBase64(new Uint8Array(15)),toBase64(new Uint8Array(17)),
    request.rows[0].inputs[0].replace(/==$/,'')];
  const noncanonical = request.rows[0].inputs[0].slice(0,-3)+'B==';
  invalidLabels.push(noncanonical);
  for (const label of invalidLabels) {
    const r=clone(request); r.rows[0].inputs[0]=label; rejected(await call(r));
  }
  for (const entry of ['',null,{},'A'.repeat(60),toBase64(new Uint8Array(43)),toBase64(new Uint8Array(45)),
    request.rows[0].tables[0][0]+'\n']) {
    const r=clone(request); r.rows[0].tables[0][0]=entry; rejected(await call(r));
  }
});

test('GCM authenticates selected row, IV, tag, nonce and row/gate context with generic failures', async () => {
  const request = await payload();
  for (const offset of [0,12,28,43]) {
    const r=clone(request);
    // All entries are modified, ensuring point-and-permute selects a tampered one.
    r.rows[0].tables[0]=r.rows[0].tables[0].map(entry=>{
      const bytes=fromBase64(entry,ENTRY_BYTES); bytes[offset]^=1; return toBase64(bytes);
    });
    rejected(await call(r));
  }
  const nonce=clone(request); nonce.nonce=(request.nonce[0]==='0'?'1':'0')+request.nonce.slice(1);
  rejected(await call(nonce));
  const row = await createGarbledJob([42,42]);
  const swapped=clone(row.request); swapped.rows.reverse(); rejected(await call(swapped));
  const gates=clone(request);
  const binary=buildCircuit().gates.flatMap((g,i)=>g.op==='NOT'?[]:[i]);
  [gates.rows[0].tables[binary[0]],gates.rows[0].tables[binary[1]]] =
    [gates.rows[0].tables[binary[1]],gates.rows[0].tables[binary[0]]];
  rejected(await call(gates));
  const other=await createGarbledJob([42]);
  const outputs=(await call(request)).body.outputs;
  assert.throws(()=>other.decode(outputs));
});

test('point-and-permute decrypts exactly one entry per gate', async () => {
  const request=await payload();
  const gate=buildCircuit().gates[0];
  assert.equal(gate.op,'NOT');
  const selected=fromBase64(request.rows[0].inputs[gate.a])[15]&1;
  const bytes=fromBase64(request.rows[0].tables[0][1-selected],ENTRY_BYTES);
  bytes[28]^=1;
  request.rows[0].tables[0][1-selected]=toBase64(bytes);
  const result=await call(request);
  assert.equal(result.statusCode,200);
  assert.deepEqual(fixture.decode(result.body.outputs),[42]);
});

test('offline actual HTTP rejects invalid transport, chunked overflow and authenticated table tamper', async t => {
  const server=createServer(handler);
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  t.after(()=>new Promise(resolve=>{server.closeAllConnections();server.close(resolve);}));
  const origin=`http://127.0.0.1:${server.address().port}`;
  async function http(body, options={}) {
    const response=await fetch(origin,{method:'POST',headers:{origin,'content-type':'application/json',...options.headers},
      ...options,body});
    return {statusCode:response.status,body:await response.json()};
  }
  rejected(await http('{broken'));
  rejected(await http('{}',{headers:{origin:'https://foreign.invalid','content-type':'application/json'}}),403);
  rejected(await http('not JSON',{headers:{origin,'content-type':'text/plain'}}),415);
  rejected(await http(Readable.from([Buffer.alloc(MAX_BODY),Buffer.alloc(1)]),{duplex:'half'}),413);
  const tampered=await payload();
  tampered.rows[0].tables[0]=tampered.rows[0].tables[0].map(entry=>{
    const bytes=fromBase64(entry,ENTRY_BYTES);bytes[43]^=1;return toBase64(bytes);
  });
  rejected(await http(JSON.stringify(tampered)));
});

test('offline actual HTTP: client garbles, server evaluates, client decodes every byte including edges', {timeout:120000}, async t => {
  const server=createServer(handler);
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  t.after(()=>new Promise(resolve=>{server.closeAllConnections();server.close(resolve);}));
  const origin=`http://127.0.0.1:${server.address().port}`;
  for (let start=0; start<256; start+=32) {
    const values=Array.from({length:32},(_,i)=>start+i);
    const job=await createGarbledJob(values);
    const serialized=JSON.stringify(job.request);
    assert.ok(Buffer.byteLength(serialized)<=MAX_BODY);
    const response=await fetch(`${origin}/api/csv-gc`,{method:'POST',headers:{origin,'content-type':'application/json'},body:serialized});
    assert.equal(response.status,200);
    const result=await response.json();
    assert.deepEqual(job.decode(result.outputs), values.map(value=>value===255?0:Math.min(value,100)));
    assert.equal(result.inputSha256,await hashRequest(job.request));
    assert.equal(result.outputSha256,await hashOutput(job.request,result.outputs));
    assert.equal(result.programSha256,await hashProgram());
  }
});
