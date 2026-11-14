import test from 'node:test';
import assert from 'node:assert/strict';
import {PROFILE,INPUT_COUNT,OUTPUT_BITS,MAX_GATES,MAX_REQUEST_BYTES,U32_MAX,normalizeRecordPlan,compileRecordPlan,referenceRecord,
 estimateRecordPlan,validateRecordRequest,canonicalRecordRequest,hashRecordPlan,hashRecordProgram,hashRecordRequest,hashRecordOutput,
 validateRecordResult,recordGateContext,deriveRecordGateKey,gateTruth,fromBase64,toBase64} from './record-core.mjs';
import {recipeGateContext,deriveRecipeGateKey} from './recipe-core.mjs';
import {prepareRecord,decodeRecord} from './record-client.mjs';
import {evaluateRecordRequest} from '../api/record-gc.mjs';

const clone=structuredClone;
const plan=(op='addSat',extra={})=>({version:1,taskHash:'a'.repeat(64),inputs:['C1','C2'],constants:[],steps:[{op,a:0,b:1,c:0}],outputs:[12],...extra});
const invoice=plan('mul16',{inputs:['C1','C2','C3','C4'],steps:[{op:'mul16',a:0,b:1,c:0},{op:'subSat',a:2,b:12,c:0},{op:'lte',a:2,b:3,c:0},{op:'eq',a:2,b:12,c:0}],outputs:[12,13,14,15]});
function booleanEvaluate(values,compiled){
 const wires=Array.from({length:8},(_,i)=>values[i]??0).flatMap(n=>Array.from({length:32},(_,j)=>(n>>>j)&1));wires.push(0,1);
 for(const g of compiled.circuit.gates)wires[g.out]=gateTruth(g.op,wires[g.a],wires[g.b],wires[g.c]);
 const words=Array(4).fill(0);compiled.circuit.outputs.forEach((w,i)=>words[i>>>5]+=wires[w]*2**(i&31));return words;
}
function dummyRequest(p,rows){
 const c=compileRecordPlan(p);return {profile:PROFILE,plan:p,planSha256:'a'.repeat(64),programSha256:'b'.repeat(64),nonce:'c'.repeat(32),rowCount:rows,
  rows:Array.from({length:rows},()=>({inputs:Array(INPUT_COUNT).fill(toBase64(new Uint8Array(16))),tables:c.circuit.gates.map(g=>Array(g.op==='COPY'||g.op==='NOT'?2:g.op==='MUX'?8:4).fill(toBase64(new Uint8Array(44))))}))};
}
let randomState=0xc01234;
const random=()=>{randomState^=randomState<<13;randomState^=randomState>>>17;randomState^=randomState<<5;return randomState>>>0;};

test('u32 arithmetic and Boolean compiler agree on boundaries and randomized records for every op',()=>{
 const edge=[0,1,2,65535,65536,0x7fffffff,0x80000000,U32_MAX];
 for(const op of ['addSat','subSat','min','max','eq','lte','and','select','mul16']){
  const p=plan(op,op==='select'?{inputs:['C1','C2','C3'],steps:[{op,a:0,b:1,c:2}]}:{}),c=compileRecordPlan(p);
  const cases=[];for(const a of edge)for(const b of edge)if(op!=='mul16'||(a<=65535&&b<=65535))cases.push([a,b,U32_MAX-a]);
  for(let i=0;i<100;i++)cases.push(op==='mul16'?[random()&65535,random()&65535,0]:[random(),random(),random()]);
  for(const row of cases){const values=row.slice(0,p.inputs.length);assert.deepEqual(booleanEvaluate(values,c),referenceRecord(values,p),`${op}: ${values}`);}
 }
 assert.deepEqual(referenceRecord([65535,65535],plan('mul16')),[4294836225,0,0,0]);
 assert.deepEqual(referenceRecord([U32_MAX,1],plan()),[U32_MAX,0,0,0]);
 assert.deepEqual(referenceRecord([0,U32_MAX],plan('subSat')),[0,0,0,0]);
});

test('cross-field dependencies, constants, comparisons and conditionals keep step order',()=>{
 const p=plan('addSat',{inputs:['C16','C1','C9'],constants:[5,U32_MAX],steps:[
  {op:'addSat',a:0,b:8,c:0},{op:'subSat',a:1,b:12,c:0},{op:'lte',a:13,b:2,c:0},
  {op:'select',a:14,b:13,c:9},{op:'and',a:15,b:14,c:0},{op:'eq',a:15,b:9,c:0},
  {op:'max',a:12,b:15,c:0},{op:'min',a:18,b:9,c:0}],outputs:[15,16,17,19]});
 const c=compileRecordPlan(p);for(let i=0;i<200;i++){const values=[random(),random(),random()];assert.deepEqual(booleanEvaluate(values,c),referenceRecord(values,p));}
 const full=plan('addSat',{inputs:Array.from({length:8},(_,i)=>`C${i+1}`),constants:[0,1,65535,U32_MAX],steps:[{op:'addSat',a:7,b:11,c:0}],outputs:[0,7,11,12]});
 assert.deepEqual(booleanEvaluate([0,1,2,3,4,5,6,7],compileRecordPlan(full)),[0,7,U32_MAX,U32_MAX]);
 const copies=compileRecordPlan(plan('min',{outputs:[0,0,12,12]}));assert.equal(new Set(copies.circuit.outputs).size,128);
 assert.ok(copies.circuit.outputs.every(w=>w>=INPUT_COUNT));assert.ok(Object.isFrozen(copies.circuit.gates));
});

test('plans reject unknown fields/opcodes, inactive/forward refs and noncanonical data without executing accessors',()=>{
 const base=plan();
 const changes=[p=>p.version=2,p=>p.taskHash+='\n',p=>p.taskHash='A'.repeat(64),p=>p.inputs=[],p=>p.inputs=['C1','C1'],p=>p.inputs=['C17'],p=>p.inputs=['C1\n'],
  p=>p.constants=Array(5).fill(0),p=>p.constants=[-1],p=>p.constants=[U32_MAX+1],p=>p.constants=[-0],p=>p.steps=[],p=>p.steps=Array(9).fill(p.steps[0]),
  p=>p.steps[0].op='execute',p=>p.steps[0].a=2,p=>p.steps[0].a=8,p=>p.steps[0].a=12,p=>p.steps[0].b=20,p=>p.steps[0].a='0',p=>p.steps[0].c=1,
  p=>p.steps[0]={op:'select',a:0,b:1,c:8},p=>p.outputs=[],p=>p.outputs=Array(5).fill(0),p=>p.outputs=[13],p=>p.extra=1,p=>p.steps[0].extra=1,
  p=>p.inputs.extra='C3',p=>p.outputs=new Array(1),p=>Object.defineProperty(p,'hidden',{value:1}),p=>p[Symbol('secret')]=1];
 for(const change of changes){const bad=clone(base);change(bad);assert.throws(()=>normalizeRecordPlan(bad));}
 let ran=0;const bad=clone(base);Object.defineProperty(bad.steps[0],'op',{enumerable:true,get(){ran++;throw new Error('getter');}});
 assert.throws(()=>normalizeRecordPlan(bad));const badArray=clone(base);Object.defineProperty(badArray.inputs,'0',{enumerable:true,get(){ran++;return 'C1';}});
 assert.throws(()=>normalizeRecordPlan(badArray));assert.equal(ran,0);
 for(const values of [[-1,0],[U32_MAX+1,0],['1',0],[NaN,0],[Infinity,0],[-0,0],new Array(2),[0],[0,1,2]])assert.throws(()=>referenceRecord(values,base));
 const inherited=Object.assign(Object.create({hidden:true}),base);assert.throws(()=>normalizeRecordPlan(inherited));
});

test('mul16 invalid input and invalid intermediate reject before randomness, even for unused results',async()=>{
 const p=plan('mul16');assert.throws(()=>referenceRecord([65536,1],p),/mul16/);
 const intermediate=plan('addSat',{constants:[65535,1],steps:[{op:'addSat',a:8,b:9,c:0},{op:'mul16',a:12,b:0,c:0}],outputs:[1]});
 assert.throws(()=>referenceRecord([1,0],intermediate),/mul16/);
 const descriptor=Object.getOwnPropertyDescriptor(globalThis,'crypto');let calls=0;
 Object.defineProperty(globalThis,'crypto',{configurable:true,value:{subtle:{},getRandomValues(){calls++;throw new Error('Unexpected randomness.');}}});
 try{await assert.rejects(prepareRecord([[1,2],[65536,1]],p,{capture:true}),/mul16/);await assert.rejects(prepareRecord([[1,0]],intermediate),/mul16/);assert.equal(calls,0);}
 finally{if(descriptor)Object.defineProperty(globalThis,'crypto',descriptor);else delete globalThis.crypto;}
});

test('row, gate and exact serialized byte budgets reject before garbling without truncation',async()=>{
 const cheap=plan('eq',{steps:[{op:'eq',a:0,b:0,c:0}]});assert.equal(estimateRecordPlan(cheap,16).rowCount,16);
 for(const count of [0,17,1.5,-1])assert.throws(()=>estimateRecordPlan(cheap,count),/1..16/);
 assert.throws(()=>estimateRecordPlan(invoice,6),/10000/);assert.ok(estimateRecordPlan(invoice,5).gateCount<=MAX_GATES);
 // MUX-heavy plans reach the byte bound before the total gate bound.
 const muxPlan=plan('select',{inputs:['C1','C2','C3','C4','C5','C6','C7','C8'],steps:Array.from({length:8},(_,i)=>({op:'select',a:i,b:(i+1)%8,c:i?11+i:7})),outputs:[16,17,18,19]});
 let byteRejected=false;for(let rows=1;rows<=16;rows++){
  const gates=compileRecordPlan(muxPlan).gatesPerRow*rows;if(gates>MAX_GATES)continue;
  try{const estimate=estimateRecordPlan(muxPlan,rows);assert.ok(estimate.serializedRequestBytes<MAX_REQUEST_BYTES);}
  catch(e){assert.match(e.message,/byte budget/);byteRejected=true;}
 }assert.ok(byteRejected,'Exercise the envelope-reserved byte cap independently of gate cap.');
 for(const p of [cheap,invoice,plan('select',{steps:[{op:'select',a:0,b:1,c:0}]})]){
  const req=dummyRequest(p,1),text=canonicalRecordRequest(req);assert.equal(Buffer.byteLength(text),estimateRecordPlan(p,1).serializedRequestBytes);
 }
 await assert.rejects(prepareRecord(Array.from({length:17},()=>[0,0]),cheap),/1..16/);
});

test('plan and program hashes are deterministic, domain bound and sensitive to semantic public data',async()=>{
 const p=plan(),reordered={outputs:p.outputs,steps:p.steps,constants:p.constants,inputs:p.inputs,taskHash:p.taskHash,version:1};
 assert.equal(await hashRecordPlan(p),await hashRecordPlan(reordered));assert.equal(await hashRecordProgram(p),await hashRecordProgram(reordered));
 for(const change of [x=>x.taskHash='b'.repeat(64),x=>x.inputs.reverse(),x=>x.constants=[0],x=>x.steps[0].op='subSat',x=>x.outputs=[0]]){
  const bad=clone(p);change(bad);assert.notEqual(await hashRecordPlan(p),await hashRecordPlan(bad));assert.notEqual(await hashRecordProgram(p),await hashRecordProgram(bad));
 }assert.notEqual(await hashRecordPlan(p),await hashRecordProgram(p));
});

test('AES-GCM key/AAD bind v5 profile, program, nonce, row, gate, arity and ordered operands',async()=>{
 const hash='a'.repeat(64),nonce='b'.repeat(32),a=new Uint8Array(16).fill(3),b=new Uint8Array(16).fill(7),iv=new Uint8Array(12);
 const key=await deriveRecordGateKey(hash,nonce,0,0,[a,b]),context=recordGateContext(hash,nonce,0,0);
 const sealed=await crypto.subtle.encrypt({name:'AES-GCM',iv,additionalData:context},key,a);
 const alternatives=[['c'.repeat(64),nonce,0,0,[a,b]],[hash,'c'.repeat(32),0,0,[a,b]],[hash,nonce,1,0,[a,b]],[hash,nonce,0,1,[a,b]],[hash,nonce,0,0,[b,a]],[hash,nonce,0,0,[a]]];
 for(const args of alternatives){const bad=await deriveRecordGateKey(...args);await assert.rejects(crypto.subtle.decrypt({name:'AES-GCM',iv,additionalData:context},bad,sealed));}
 const old=await deriveRecipeGateKey(hash,nonce,0,0,[a,b]);assert.notDeepEqual(context,recipeGateContext(hash,nonce,0,0));
 await assert.rejects(crypto.subtle.decrypt({name:'AES-GCM',iv,additionalData:context},old,sealed));
 await assert.rejects(crypto.subtle.decrypt({name:'AES-GCM',iv,additionalData:recordGateContext(hash,nonce,1,0)},key,sealed));
});

let invoicePrepared,invoiceResult;
test('actual AES-GCM evaluator computes multi-input invoice audit; request exposes selected labels only',async()=>{
 const records=[[12,150,1850,2000],[65535,65535,4294836225,U32_MAX]];
 invoicePrepared=await prepareRecord(records,invoice,{capture:true});invoiceResult=await evaluateRecordRequest(invoicePrepared.request);
 assert.deepEqual(await decodeRecord(invoiceResult,invoicePrepared.decoder),records.map(row=>referenceRecord(row,invoice)));
 assert.equal(Buffer.byteLength(canonicalRecordRequest(invoicePrepared.request)),estimateRecordPlan(invoice,2).serializedRequestBytes);
 assert.deepEqual(Object.keys(invoicePrepared.request),['profile','plan','planSha256','programSha256','nonce','rowCount','rows']);
 assert.deepEqual(Object.keys(invoicePrepared.witness),['inputPairs','outputPairs','inputBits']);
 assert.equal(invoicePrepared.request.rows[0].inputs.length,258);assert.equal(invoiceResult.outputs[0].length,128);
 for(let r=0;r<2;r++){
  const w=invoicePrepared.witness;assert.equal(w.inputBits[r].length,258);assert.deepEqual(w.inputBits[r].slice(128),[...Array(128).fill(0),0,1]);
  for(let i=0;i<258;i++)assert.equal(invoicePrepared.request.rows[r].inputs[i],w.inputPairs[r][i][w.inputBits[r][i]]);
  const publicText=JSON.stringify(invoicePrepared.request);assert.ok(!publicText.includes(w.inputPairs[r][0][1-w.inputBits[r][0]]));assert.ok(!publicText.includes(w.outputPairs[r][0][0]));
 }
 assert.equal(validateRecordResult(invoiceResult,invoicePrepared.request),invoiceResult);
 assert.equal(await hashRecordRequest(invoicePrepared.request),invoiceResult.inputSha256);
});

test('request, selected ciphertext, public plan/hash and result tampering fail closed',async()=>{
 assert.ok(invoicePrepared);const {request,decoder}=invoicePrepared;
 for(const change of [r=>r.profile='nope-csv-recipe-gc-v2',r=>r.planSha256='0'.repeat(64),r=>r.programSha256='0'.repeat(64),r=>r.plan.taskHash='c'.repeat(64),r=>r.nonce='0'.repeat(32),r=>r.extra=true,r=>r.rows[0].inputs.pop(),r=>r.rows[0].tables[0].pop()]){
  const bad=clone(request);change(bad);await assert.rejects(evaluateRecordRequest(bad));
 }
 const bad=clone(request),g=compileRecordPlan(invoice).circuit.gates[0],labels=[g.a,g.b,g.c].slice(0,g.op==='NOT'||g.op==='COPY'?1:g.op==='MUX'?3:2).map(w=>fromBase64(bad.rows[0].inputs[w]));
 const index=labels.reduce((n,l)=>n*2+(l[15]&1),0),entry=fromBase64(bad.rows[0].tables[0][index],44);entry[20]^=1;bad.rows[0].tables[0][index]=toBase64(entry);await assert.rejects(evaluateRecordRequest(bad));
 for(const change of [r=>r.inputSha256='0'.repeat(64),r=>r.programSha256='0'.repeat(64),r=>r.outputSha256='0'.repeat(64),r=>r.nonce='0'.repeat(32),r=>r.rowCount=1,r=>r.outputs[0][0]=toBase64(new Uint8Array(16)),r=>r.extra='witness']){
  const result=clone(invoiceResult);change(result);await assert.rejects(decodeRecord(result,decoder));
 }
 const swapped=clone(invoiceResult);[swapped.outputs[0][0],swapped.outputs[0][1]]=[swapped.outputs[0][1],swapped.outputs[0][0]];swapped.outputSha256=await hashRecordOutput(swapped.outputs);await assert.rejects(decodeRecord(swapped,decoder),/belong/);
 // Structural validation is synchronous; it leaves cryptographic digest checks to callers.
 const digestChanged=clone(invoiceResult);digestChanged.outputSha256='0'.repeat(64);assert.equal(validateRecordResult(digestChanged,request),digestChanged);
});

test('request/result accessors and sparse arrays are rejected before invocation',()=>{
 let invoked=0;const req=clone(invoicePrepared.request);Object.defineProperty(req.rows[0].inputs,'0',{enumerable:true,get(){invoked++;return 'x';}});assert.throws(()=>validateRecordRequest(req));
 const result=clone(invoiceResult);Object.defineProperty(result,'outputs',{enumerable:true,get(){invoked++;return [];}});assert.throws(()=>validateRecordResult(result));
 const sparse=clone(invoicePrepared.request);delete sparse.rows[0].tables[0][0];assert.throws(()=>validateRecordRequest(sparse));assert.equal(invoked,0);
});

test('decoder returns actual output count, enforces unsigned high bits and rejects valid-label nonzero padding',async()=>{
 const p=plan('addSat'),prepared=await prepareRecord([[U32_MAX,1]],p),result=await evaluateRecordRequest(prepared.request);
 assert.equal(prepared.witness,undefined);assert.deepEqual(await decodeRecord(result,prepared.decoder),[[U32_MAX]]);
 const bad=clone(result);bad.outputs[0][32]=prepared.decoder.outputPairs[0][32][1];bad.outputSha256=await hashRecordOutput(bad.outputs);
 await assert.rejects(decodeRecord(bad,prepared.decoder),/padding/);
 const decoder=clone(prepared.decoder);decoder.outputPairs[0][0]=decoder.outputPairs[0][1];await assert.rejects(decodeRecord(result,decoder),/Duplicate/);
});

test('inputs and plans snapshot before asynchronous garbling/evaluation/decoding',async()=>{
 const p=plan('eq',{steps:[{op:'eq',a:0,b:0,c:0}]}),values=[[123,456]],pending=prepareRecord(values,p);values[0][0]=-1;p.outputs[0]=1;
 const prepared=await pending,request=clone(prepared.request),evaluating=evaluateRecordRequest(request);request.nonce='0'.repeat(32);request.rows[0].inputs[0]='broken';
 const result=await evaluating,r=clone(result),d=clone(prepared.decoder),decoding=decodeRecord(r,d);r.nonce='0'.repeat(32);d.outputPairs[0][0].reverse();
 assert.deepEqual(await decoding,[[1]]);
});
