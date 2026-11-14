import test from 'node:test';import assert from 'node:assert/strict';
import {recordTemplate,privateRecordInputs,applyRecordOutput,acceptRecordProposal} from './record-plan.mjs';
import {prepareProofRecord,decodeProofRecord,proveProofRecord} from './record-proof-client.mjs';
import {executeTask} from '../workspace/gc.mjs';
import {verifyProofPlanBundle,proofRuntime,makeProofStatements,canonicalProofPlanRequest} from './record-proof-core.mjs';
import {hashRecordPlan} from './record-core.mjs';
const task=n=>({version:2,goal:'Synthetic confidential record audit; no personal information.',columns:Array.from({length:n},(_,i)=>({id:'C'+(i+1),type:'uint32'}))});
const options={jobId:'a'.repeat(32),buyerCommitment:'b'.repeat(64),contractId:'nope-wallet-5144c7d4.testnet'};
const binding={jobId:options.jobId,version:1,contractId:options.contractId,bindingHash:'c'.repeat(64),provider:'synthetic-provider.testnet',amountYocto:'1000000000000000000000'};
const encoded=d=>Object.fromEntries(['profile','nonce','rowCount','outputs','inputSha256','programSha256','outputSha256'].map(k=>[k,d[k]]));
test('multi-field invoice encrypted execution, actual proof, altered context/output/proof rejection',async()=>{
 try{
  const {plan,planSha256}=await recordTemplate(task(4),'invoice',['C1','C2','C3','C4']);assert.equal(planSha256,await hashRecordPlan(plan));
  const mutableOptions={...options},preparing=prepareProofRecord([[3,12500,40000,50000]],plan,mutableOptions);mutableOptions.jobId='d'.repeat(32);
  const p=await preparing;assert.equal(p.request.proofManifest.context.jobId,options.jobId);
  const result=await executeTask(p.request),delivery={...result,version:1,deliveredAt:'2026-11-14T17:00:00Z'};
  const mutableResult=structuredClone(result),decoding=decodeProofRecord(mutableResult,p.decoder);mutableResult.outputs[0][0]='broken-after-call';
  assert.deepEqual(await decoding,[[37500,2500,1,0]]);
  const mutableWitness=structuredClone(p.witness),proving=proveProofRecord({request:p.request,delivery,binding,witness:mutableWitness});mutableWitness.rows[0].inputSalt='broken-after-call';
  const bundle=await proving;
  assert.equal(bundle.rows[0].proof.publicInputs.length,55);
  assert.equal(await verifyProofPlanBundle({request:p.request,delivery,binding,bundle}),true);
  assert.equal(await verifyProofPlanBundle({request:p.request,delivery,binding:{...binding,amountYocto:'2000000000000000000000'},bundle}),false);
  const corrupt=structuredClone(bundle);corrupt.rows[0].proof.publicInputs[10]=(BigInt(corrupt.rows[0].proof.publicInputs[10])+1n).toString();
  assert.equal(await verifyProofPlanBundle({request:p.request,delivery,binding,bundle:corrupt}),false);
  const proofCorrupt=structuredClone(bundle);proofCorrupt.rows[0].proof.proof=(proofCorrupt.rows[0].proof.proof[0]==='A'?'B':'A')+proofCorrupt.rows[0].proof.proof.slice(1);
  assert.equal(await verifyProofPlanBundle({request:p.request,delivery,binding,bundle:proofCorrupt}),false);
  // Correct private bits with an incorrect result cannot satisfy the actual circuit.
  const expected=await makeProofStatements(p.request,delivery,binding),sdk=await proofRuntime(),bad=structuredClone(p.witness.rows[0]);
  [bad.outputPairs[0][0],bad.outputPairs[0][1]]=[bad.outputPairs[0][1],bad.outputPairs[0][0]];
  await assert.rejects(sdk.proveRow({statement:expected.rows[0].statement,witness:bad}));
  const wrongLabels=[...expected.rows[0].statement.outputLabels];wrongLabels[0]=p.witness.rows[0].outputPairs[0][1-p.witness.rows[0].outputPairs[0].indexOf(wrongLabels[0])];
  const falseStatement=await sdk.makeStatement({...expected.rows[0].statement,outputLabels:wrongLabels});
  await assert.rejects(sdk.proveRow({statement:falseStatement,witness:p.witness.rows[0]}),'actual arithmetic constraint rejects a false decoded output, even with valid label membership');
  const text=canonicalProofPlanRequest(p.request);assert.ok(!text.includes('inputPairs')&&!text.includes('inputSalt')&&!text.includes('outputPairs')&&!text.includes('inputBits'));
 }finally{await (await proofRuntime()).dispose();}
});
test('private record CSV preserves complex UTF-8 metadata locally and never includes it in public task',async()=>{
 const data={headers:['qty','unit','billed','limit','müşteri','açıklama'],rows:[['3','12500','40000','50000','Çağla Gizli Şirket','Özel sözleşme • müşteri kaydı']],delimiter:','};
 const approval=await recordTemplate(task(4),'invoice',['C1','C2','C3','C4']);
 assert.deepEqual(privateRecordInputs(data,approval.plan),[[3,12500,40000,50000]]);
 const output=applyRecordOutput(data,approval.plan,[[37500,2500,1,0]]);
 assert.equal(output.rows[0][4],'Çağla Gizli Şirket');assert.equal(output.rows[0][5],'Özel sözleşme • müşteri kaydı');
 assert.ok(!JSON.stringify(approval.task).includes('Çağla'));
 await assert.rejects(acceptRecordProposal(task(4),{...approval.plan,inputs:['C1','C2','C3','C5']}));
 assert.throws(()=>privateRecordInputs({...data,rows:[['3','12500','-1','50000','x','x']]},approval.plan));
});

test('actual record circuit agrees on u32 overflow, subtraction and hidden conditional selection',async()=>{
 try {
  const t=task(2),{publicRecordTaskHash}=await import('./record-plan.mjs');
  const plan={version:1,taskHash:await publicRecordTaskHash(t),inputs:['C1','C2'],constants:[],steps:[
   {op:'addSat',a:0,b:1,c:0},{op:'subSat',a:0,b:1,c:0},{op:'min',a:0,b:1,c:0},{op:'max',a:0,b:1,c:0},
   {op:'eq',a:0,b:1,c:0},{op:'lte',a:0,b:1,c:0},{op:'and',a:0,b:1,c:0},{op:'select',a:17,b:14,c:15}],outputs:[12,13,18,19]};
  const p=await prepareProofRecord([[4294967295,10]],plan,options),delivery={...await executeTask(p.request),version:1};
  assert.deepEqual(await decodeProofRecord(encoded(delivery),p.decoder),[[4294967295,4294967285,1,4294967295]]);
  const expected=await makeProofStatements(p.request,delivery,binding),sdk=await proofRuntime();
  await sdk.createProofRuntime().then(async runtime=>{try{await runtime.checkWitness({statement:expected.rows[0].statement,witness:p.witness.rows[0]});}finally{await runtime.dispose();}});
 }finally{await (await proofRuntime()).dispose();}
});
