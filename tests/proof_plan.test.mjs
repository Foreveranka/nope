// Real v4 wrapper tests: actual AES-GCM GC evaluation, Poseidon2 roots and (where
// named) actual Noir/UltraHonk proofs. Synthetic inputs only; no chain/HTTP calls.
import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {prepareRecipe,prepareRecipeProof,decodeRecipe} from '../web/recipe-client.mjs';
import {preparePlan,decodePlan} from '../web/plan-client.mjs';
import {prepareProofPlan,decodeProofPlan,proveProofPlan} from '../web/proof-plan-client.mjs';
import {PROFILE,SCHEME,FIELD_MODULUS,proofPolicy,proofPolicyHash,validateProofPlanRequest,canonicalProofPlanRequest,
 hashProofPlanRequest,hashProofPlanProgram,hashProofManifest,validateProofPlanContext,verifyProofPlanBindings,
 proofPlanRows,proofPlanRowContext,wrapProofPlanResult,finalProofContext,makeProofStatements,verifyProofPlanBundle,
 canonicalProofPlanBundle,proofRuntime,estimateProofPlan,PROOF_PLAN_LIMITS,MAX_ROW_PROOFS,MAX_PROOF_BUNDLE_BYTES} from '../web/proof-plan-core.mjs';
import {PROFILE as V3,hashPlanRequest,hashPlanProgram,hashPlan,canonicalPlanOutput,hashPlanOutput} from '../web/plan-core.mjs';
import {fromBase64,compileRecipe,hashRecipeOutput} from '../web/recipe-core.mjs';
import {evaluatePlanRequest} from '../api/plan-gc.mjs';
import {evaluateRecipeRequest} from '../api/recipe-gc.mjs';
const clone=v=>JSON.parse(JSON.stringify(v));
const sha=s=>createHash('sha256').update(s).digest('hex');
const jobId='ab'.repeat(16),contractId='nope-work-da4cbb1e.testnet',buyerCommitment=sha('NOPE:buyer:'+'cd'.repeat(16));
const number={type:'number',steps:[{op:'fill',value:254},{op:'clamp',min:2,max:19}]};
const text={type:'text',steps:[{op:'trim'},{op:'lowercase'},{op:'uppercase'},{op:'redactDigits'}]};
const plan={version:1,taskHash:'ef'.repeat(32),steps:[{column:'C9',recipe:text},{column:'C2',recipe:number}]};
const values={C9:[' A9\0Z '],C2:[255]};
const options={jobId,buyerCommitment,contractId};
const binding={jobId,version:1,contractId,bindingHash:'12'.repeat(32),provider:'provider.testnet',amountYocto:'1000000000000000000000'};
let fixturePromise,bundlePromise;
const fixture=()=>fixturePromise??=(async()=>{
 const p=await prepareProofPlan(values,plan,options),base=await evaluatePlanRequest(p.request.task),result=await wrapProofPlanResult(p.request,base);
 return{...p,base,result};
})();
const actualBundle=()=>bundlePromise??=(async()=>{
 const p=await fixture(),progress=[];
 const bundle=await proveProofPlan({request:p.request,delivery:p.result,binding,witness:p.witness,onProgress:x=>progress.push(x)});
 return{bundle,progress};
})();
test.after(async()=>{await(await proofRuntime()).dispose();});

test('v3 API/strict decoder unchanged; private capture includes exact ordered input pairs and constant bits',async()=>{
 const original=await prepareRecipe([255],number);assert.deepEqual(Object.keys(original),['request','decoder']);
 assert.deepEqual(Object.keys(original.decoder),['profile','recipe','nonce','rowCount','inputSha256','programSha256','outputPairs']);
 const p=await prepareRecipeProof([255],number);assert.deepEqual(Object.keys(p),['request','decoder','witness']);
 assert.equal(p.witness.inputPairs[0].length,10);assert.equal(p.witness.outputPairs[0].length,8);assert.deepEqual(p.witness.inputBits[0],[1,1,1,1,1,1,1,1,0,1]);
 for(let i=0;i<10;i++)assert.equal(p.request.rows[0].inputs[i],p.witness.inputPairs[0][i][p.witness.inputBits[0][i]]);
 assert.deepEqual(await decodeRecipe(await evaluateRecipeRequest(p.request),p.decoder),[19]);
 const legacy=await preparePlan({C2:[255]}, {...plan,steps:[plan.steps[1]]});
 assert.deepEqual(await decodePlan(await evaluatePlanRequest(legacy.request),legacy.decoder),{C2:[19]});
});

test('v4 immutable manifest precedes actual evaluation and binds every mixed typed row, wire and root',async()=>{
 const p=await fixture(),r=p.request;assert.equal(r.profile,PROFILE);assert.equal(r.task.profile,V3);
 assert.deepEqual(Object.keys(r),['profile','task','proofManifest']);assert.ok(Object.isFrozen(r.proofManifest.rows[0]));
 const rows=r.proofManifest.rows;assert.deepEqual(rows.map(x=>[x.column,x.row,x.type]),[['C9',0,'text'],['C2',0,'number']]);
 assert.equal(r.proofManifest.context.policyHash,proofPolicyHash);assert.equal(r.proofManifest.context.baseRequestSha256,await hashPlanRequest(r.task));
 assert.equal(r.proofManifest.context.baseProgramSha256,await hashPlanProgram(plan));
 assert.equal(r.proofManifest.context.planSha256,await hashPlan(plan));
 const canonical=canonicalProofPlanRequest(r);assert.equal(await hashProofPlanRequest(r),sha(canonical));assert.notEqual(await hashProofPlanRequest(r),await hashPlanRequest(r.task));
 for(const row of proofPlanRows(r)){
  const privateRow=p.witness.rows.find(x=>x.column===row.column&&x.row===row.row),sdk=await proofRuntime();
  const roots=await sdk.commitRow({...row,...privateRow,column:row.columnNumber});assert.equal(roots.inputPairRoot,row.inputPairRoot);assert.equal(roots.outputPairRoot,row.outputPairRoot);
  assert.equal(row.preContext,await proofPlanRowContext(r.task,r.proofManifest.context,row.columnIndex,row.row));
  assert.equal(await sdk.selectedRoot({...row,column:row.columnNumber,role:'input',labels:row.inputLabels}),row.inputSelectedRoot);
  assert.equal(row.inputLabels.length,row.type==='text'?130:10);
 }
 assert.equal(canonicalProofPlanRequest(r),canonical,'real evaluation/proof preparations cannot replace prior roots');
});

test('no witness, alternative pair arrays, private salts or decoder can enter the public v4 request',async()=>{
 const p=await fixture(),publicText=canonicalProofPlanRequest(p.request);
 for(const name of ['inputPairs','outputPairs','inputSalt','outputSalt','inputBits','decoder','witness','proof'])assert.ok(!publicText.includes('"'+name+'"'));
 assert.ok(!publicText.includes(JSON.stringify(values.C9[0])));assert.ok(!publicText.includes('A*'));
 for(const row of p.witness.rows){assert.ok(!publicText.includes(row.inputSalt));assert.ok(!publicText.includes(row.outputSalt));}
 for(const key of ['witness','decoder','proof','verified']){const bad=clone(p.request);bad[key]=p.witness;assert.throws(()=>validateProofPlanRequest(bad));}
});

test('proof policy identity commits actual immutable artifact/VK/SRS/settings metadata, not a mutable scheme label',async()=>{
 const policyJSON=JSON.stringify(proofPolicy,(_,x)=>x&&typeof x==='object'&&!Array.isArray(x)?Object.fromEntries(Object.keys(x).sort().map(k=>[k,x[k]])):x);
 assert.equal(sha(policyJSON),proofPolicyHash);assert.ok(Object.isFrozen(proofPolicy.circuits.text));
 const expected=sha(JSON.stringify({profile:PROFILE,scheme:SCHEME,version:1,policyHash:proofPolicyHash,baseProgramSha256:await hashPlanProgram(plan)}));
 assert.equal(await hashProofPlanProgram(plan),expected);
 const p=await fixture(),bad=clone(p.request);bad.proofManifest.context.policyHash='00'.repeat(32);assert.throws(()=>validateProofPlanRequest(bad),/policy/);
});

test('strict schemas reject wrong counts/order/coordinates/context and noncanonical fields before hashing',async()=>{
 const p=await fixture();
 const changes=[r=>r.profile=V3,r=>r.proofManifest.version=2,r=>r.proofManifest.scheme='fake',r=>r.proofManifest.rows.reverse(),r=>r.proofManifest.rows.pop(),r=>r.proofManifest.rows[0].row=1,r=>r.proofManifest.rows[0].type='number',r=>r.proofManifest.context.nonce='0'.repeat(32),r=>r.proofManifest.context.extra=true,r=>r.proofManifest.rows[0].inputPairs=[],r=>r.proofManifest.rows[0].inputPairRoot=FIELD_MODULUS.toString(),r=>r.proofManifest.rows[0].inputPairRoot='01',r=>r.proofManifest.rows[0].inputPairRoot=1,r=>r.proofManifest.rows[0].inputPairRoot='-1'];
 for(const mutate of changes){const r=clone(p.request);mutate(r);assert.throws(()=>validateProofPlanRequest(r));}
 const r=clone(p.request);Object.defineProperty(r.proofManifest.context,'jobId',{enumerable:true,get(){assert.fail('must not execute getter');}});assert.throws(()=>validateProofPlanRequest(r));
 const a=clone(p.request);Object.defineProperty(a.proofManifest.rows,'0',{enumerable:true,get(){assert.fail('must not execute array getter');}});assert.throws(()=>validateProofPlanRequest(a));
});

test('actual public hash/root/context bindings reject mutated request data and claimed selected roots',async()=>{
 const p=await fixture();
 for(const mutate of [r=>r.proofManifest.context.baseRequestSha256='0'.repeat(64),r=>r.proofManifest.context.programSha256='1'.repeat(64),r=>r.proofManifest.rows[0].preContext='2'.repeat(64),r=>r.proofManifest.rows[0].inputSelectedRoot='0',r=>{const a=r.task.tasks[1].request.rows[0].inputs;[a[8],a[9]]=[a[9],a[8]];}]){
  const r=clone(p.request);mutate(r);await assert.rejects(hashProofPlanRequest(r));
 }
 assert.equal(validateProofPlanContext(p.request,options),true);
 for(const key of ['buyerCommitment','contractId']){const absent=clone(p.request);absent.proofManifest.context[key]=null;assert.throws(()=>validateProofPlanContext(absent,options),'expected session/config bindings cannot be omitted');}
 for(const other of [{...options,jobId:'11'.repeat(16)},{...options,buyerCommitment:'22'.repeat(32)},{...options,contractId:'other.testnet'}])assert.throws(()=>validateProofPlanContext(p.request,other));
});

test('actual v4 evaluation/decoding preserves mixed semantics and rejects v3 or wrong outer result bindings',async()=>{
 const p=await fixture();assert.equal(p.result.profile,PROFILE);assert.equal(p.result.inputSha256,await hashProofPlanRequest(p.request));
 assert.equal(p.result.programSha256,await hashProofPlanProgram(plan));assert.equal(p.result.outputSha256,await hashPlanOutput(p.result.outputs));
 assert.equal(Object.hasOwn(p.result,'proof'),false);assert.deepEqual(await decodeProofPlan(p.result,p.decoder),{C9:['A*\0Z'],C2:[19]});
 await assert.rejects(decodeProofPlan(p.base,p.decoder));
 for(const mutate of [r=>r.inputSha256='0'.repeat(64),r=>r.programSha256=p.base.programSha256,r=>r.outputSha256='0'.repeat(64),r=>r.outputs.reverse(),r=>r.proof={verified:true}]){const r=clone(p.result);mutate(r);await assert.rejects(decodeProofPlan(r,p.decoder));}
 const d=clone(p.decoder);d.taskDecoder.tasks[0].decoder.witness=p.witness;await assert.rejects(decodeProofPlan(p.result,d));
 const bad=clone(p.base);bad.inputSha256='0'.repeat(64);await assert.rejects(wrapProofPlanResult(p.request,bad));
});

test('ordered pair polarity is committed; neither pair sorting nor row substitution is valid',async()=>{
 const p=await fixture(),row=proofPlanRows(p.request)[1],w=clone(p.witness.rows[1]),sdk=await proofRuntime();
 [w.outputPairs[0][0],w.outputPairs[0][1]]=[w.outputPairs[0][1],w.outputPairs[0][0]];
 const changed=await sdk.commitRow({...row,...w,column:row.columnNumber});assert.notEqual(changed.outputPairRoot,row.outputPairRoot);
 const other=await sdk.commitRow({...row,...p.witness.rows[1],column:row.columnNumber,row:1});assert.notEqual(other.inputPairRoot,row.inputPairRoot);
});

test('final context/expected statements bind exact outer request/manifest, actual labels, revision and selected escrow terms',async()=>{
 const p=await fixture(),expected=await makeProofStatements(p.request,p.result,binding);
 assert.equal(expected.finalContext,await finalProofContext(p.request,p.result,binding));assert.equal(expected.rows.length,2);
 assert.deepEqual(expected.rows.map(r=>[r.column,r.row]),[['C9',0],['C2',0]]);
 for(const r of expected.rows){assert.equal(r.statement.finalContext,expected.finalContext);assert.equal(r.statement.publicInputs.length,28);assert.equal(r.statement.inputSelectedRoot,p.request.proofManifest.rows[expected.rows.indexOf(r)].inputSelectedRoot);}
 for(const changed of [{...binding,version:2},{...binding,bindingHash:'33'.repeat(32)},{...binding,provider:'other.testnet'},{...binding,amountYocto:'2000000000000000000000'}])assert.notEqual(await finalProofContext(p.request,p.result,changed),expected.finalContext);
 for(const bad of [{...binding,jobId:'00'.repeat(16)},{...binding,version:0},{...binding,contractId:'other.testnet'},{...binding,amountYocto:'01'},{...binding,provider:contractId}])await assert.rejects(finalProofContext(p.request,p.result,bad));
 await assert.rejects(finalProofContext(p.request,{...p.result,version:2},binding));
 const wrong=clone(p.result);wrong.outputSha256='44'.repeat(32);await assert.rejects(makeProofStatements(p.request,wrong,binding));
});

test('async public result/context helpers snapshot arguments before awaiting root/hash computations',async()=>{
 const p=await fixture(),r=clone(p.result),b=clone(binding);
 const expected=await finalProofContext(p.request,r,b),promise=finalProofContext(p.request,r,b);b.version=99;r.outputSha256='55'.repeat(32);assert.equal(await promise,expected);
 const base=clone(p.base),wrapped=wrapProofPlanResult(p.request,base);base.outputSha256='66'.repeat(32);assert.deepEqual(await wrapped,p.result);
});

test('preparation validates all values/context/size before ANY cryptography or runtime startup',async()=>{
 const descriptor=Object.getOwnPropertyDescriptor(globalThis,'crypto');Object.defineProperty(globalThis,'crypto',{configurable:true,get(){assert.fail('invalid preparation must not access crypto');}});
 try{
  for(const [v,o] of [[values,{...options,jobId:'bad'}],[{...values,C2:[999]},options],[{...values,C9:['text too long beyond sixteen']},options],[{...values,C2:[1,2]},options],[{...values,secret:'must not leak'},options]])await assert.rejects(prepareProofPlan(v,plan,o));
 }finally{Object.defineProperty(globalThis,'crypto',descriptor);}
});

test('ACTUAL Noir/UltraHonk mixed-row bundle generation and independent expected-statement verification',async()=>{
 const p=await fixture(),{bundle,progress}=await actualBundle();assert.deepEqual(Object.keys(bundle),['version','scheme','finalContext','rows']);
 assert.deepEqual(progress,[{completed:1,total:2},{completed:2,total:2}]);
 for(const r of bundle.rows){assert.equal(Buffer.from(r.proof.proof,'base64').length,14656);assert.equal(r.proof.publicInputs.length,28);}
 const verifiedProgress=[];assert.equal(await verifyProofPlanBundle({request:p.request,delivery:p.result,binding,bundle,onProgress:x=>verifiedProgress.push(x)}),true);
 assert.deepEqual(verifiedProgress,[{completed:1,total:2},{completed:2,total:2}]);
 assert.equal(sha(canonicalProofPlanBundle(bundle)),sha(JSON.stringify(bundle)));
 const publicText=canonicalProofPlanBundle(bundle);for(const key of ['inputPairs','outputPairs','inputSalt','outputSalt','witness','decoder'])assert.ok(!publicText.includes('"'+key+'"'));
});

test('actual public verifier rejects partial/reordered/stale/tampered bundles and caller booleans',async()=>{
 const p=await fixture(),{bundle}=await actualBundle();
 for(const mutate of [b=>b.rows.pop(),b=>b.rows.reverse(),b=>b.rows.push(clone(b.rows[0])),b=>b.finalContext='77'.repeat(32),b=>b.verified=true,b=>b.witness=p.witness,b=>b.rows[0].proof.verified=true,b=>b.rows[0].proof.publicInputs[0]='0',b=>b.rows[0].proof.proof='AAAA',b=>b.rows[0].proof.verificationKeySha256='88'.repeat(32)]){
  const bad=clone(bundle);mutate(bad);assert.equal(await verifyProofPlanBundle({request:p.request,delivery:p.result,binding,bundle:bad}),false);
 }
 assert.equal(await verifyProofPlanBundle({request:p.request,delivery:p.result,binding:{...binding,version:2},bundle}),false);
});

test('private row witness changes cannot be silently recommitted or uploaded in a proof bundle',async()=>{
 const p=await fixture(),w=clone(p.witness);[w.rows[0].outputPairs[0][0],w.rows[0].outputPairs[0][1]]=[w.rows[0].outputPairs[0][1],w.rows[0].outputPairs[0][0]];
 const progress=[];await assert.rejects(proveProofPlan({request:p.request,delivery:p.result,binding,witness:w,onProgress:x=>progress.push(x)}),/anchored commitments/);assert.deepEqual(progress,[]);
});


test('row-proof/publication byte budgets reject oversize plans before ANY crypto and expose honest UI limits',async()=>{
 const p={...plan,steps:['C1','C2','C3','C4'].map(column=>({column,recipe:{type:'number',steps:[{op:'fill',value:0}]}}))};
 const e=estimateProofPlan(p,10,options);assert.equal(e.rowProofCount,40);assert.equal(e.maxRowProofs,40);assert.equal(e.maxProofBundleBytes,1024*1024-1024);
 assert.ok(e.estimatedProofBundleBytes<e.maxProofBundleBytes);assert.ok(e.estimatedProofBundleBytes>40*19544);
 assert.equal(PROOF_PLAN_LIMITS.maxRowProofs,MAX_ROW_PROOFS);assert.equal(PROOF_PLAN_LIMITS.maxProofBundleBytes,MAX_PROOF_BUNDLE_BYTES);assert.equal(PROOF_PLAN_LIMITS.proofBytes.number,14656);
 const descriptor=Object.getOwnPropertyDescriptor(globalThis,'crypto');Object.defineProperty(globalThis,'crypto',{configurable:true,get(){assert.fail('oversize proof coverage must reject before cryptography');}});
 try{
  assert.throws(()=>estimateProofPlan(p,32,options),/40 row-proof/);
  await assert.rejects(prepareProofPlan(Object.fromEntries(p.steps.map(s=>[s.column,Array(32).fill(1)])),p,options),/40 row-proof/);
 }finally{Object.defineProperty(globalThis,'crypto',descriptor);}
});

test('public bundle count/byte caps share the same preflight envelope and reject omitted-limit workarounds',async()=>{
 const {bundle}=await actualBundle();
 const big=clone(bundle);big.rows=Array.from({length:41},()=>clone(bundle.rows[0]));assert.throws(()=>canonicalProofPlanBundle(big),/coverage/);
 // Deliberately format-only size vector, NOT a valid proof claim: maximum legal
 // decimal signal widths and actual approved proof-byte lengths bound serialization.
 const bound=clone(bundle);bound.rows=Array.from({length:40},(_,i)=>({...clone(bundle.rows[1]),column:'C'+(i%16+1),row:i%32}));
 for(const r of bound.rows)r.proof.publicInputs=Array(28).fill('1'.repeat(77));
 assert.ok(Buffer.byteLength(canonicalProofPlanBundle(bound))<MAX_PROOF_BUNDLE_BYTES);
 const oversized=clone(bundle);oversized.rows[0].proof.proof='A'.repeat(1024*1024);assert.throws(()=>canonicalProofPlanBundle(oversized));
});
