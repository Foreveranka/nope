/** Real ciphertext bindings; RPC below is a UNIT fixture, not public-chain evidence. */
import test from 'node:test';import assert from 'node:assert/strict';
import {prepareProofPlan} from '../web/proof-plan-client.mjs';
import {wrapProofPlanResult,hashProofPlanRequest,hashProofPlanProgram,proofRuntime} from '../web/proof-plan-core.mjs';
import {hashPlan} from '../web/plan-core.mjs';import{sha256}from'../web/gc-core.mjs';import{evaluatePlanRequest}from'../api/plan-gc.mjs';
import {CHAIN_POLICY,validatePublicEvidence,verifyPublicChainBinding,boundedPublicJSON} from '../web/public-proof.mjs';
const clone=v=>structuredClone(v);let pending;
async function fixture(){return pending??=(async()=>{
 const jobId='aa'.repeat(16),buyerCommitment='bb'.repeat(32),plan={version:1,taskHash:'cc'.repeat(32),steps:[{column:'C1',recipe:{type:'number',steps:[{op:'fill',value:7}]}}]};
 const p=await prepareProofPlan({C1:[255]},plan,{jobId,buyerCommitment,contractId:CHAIN_POLICY.contractId});
 const delivery={...await wrapProofPlanResult(p.request,await evaluatePlanRequest(p.request.task)),version:1};
 const terms={job_id:jobId,buyer_commitment:buyerCommitment,provider:'provider.testnet',amount:'1000000000000000000000',input_hash:await hashProofPlanRequest(p.request),program_hash:await hashProofPlanProgram(plan),plan_hash:await hashPlan(plan),execution_deadline_ns:'1794794400000000000',review_deadline_ns:'1794880800000000000'};
 const bindingHash=await sha256(JSON.stringify(['NOPE:WORKSPACE-ESCROW:V1:testnet',CHAIN_POLICY.contractId,...Object.values(terms)]));
 const hold={terms,binding_hash:bindingHash,state:'Delivered',delivery:{version:1,output_hash:delivery.outputSha256}};
 const evidence={version:1,network:'testnet',jobId,task:p.request,delivery,binding:{jobId,version:1,contractId:CHAIN_POLICY.contractId,bindingHash,provider:terms.provider,amountYocto:terms.amount}};
 return {evidence,hold};
})();}
test.after(async()=>{await(await proofRuntime()).dispose();});
const rpcFor=(hold,alter=()=>{})=>async(url,options)=>{
 assert.equal(url,'https://test.rpc.fastnear.com');const request=JSON.parse(options.body);let result;
 if(request.method==='status')result={chain_id:'testnet'};
 else if(request.params.request_type==='view_account')result={code_hash:CHAIN_POLICY.codeHash,block_hash:'1'.repeat(43)};
 else {assert.equal(request.params.method_name,'get_hold');assert.equal(request.params.block_id,'1'.repeat(43));result={block_hash:'1'.repeat(43),result:[...new TextEncoder().encode(JSON.stringify(hold))]};}
 alter(result,request);return Response.json({jsonrpc:'2.0',result});
};
test('requested public job identity cannot be replaced by a different valid evidence bundle',async()=>{
 const {evidence}=await fixture();assert.equal(validatePublicEvidence(evidence,evidence.jobId),evidence);
 assert.throws(()=>validatePublicEvidence(evidence,'dd'.repeat(16)),/istenen işe/);
});
test('public verifier derives exact ciphertext/plan/output/award bindings from a pinned finalized contract snapshot',async()=>{
 const {evidence,hold}=await fixture();const result=await verifyPublicChainBinding(evidence,{fetcher:rpcFor(hold)});assert.equal(result.bindingHash,hold.binding_hash);assert.equal(result.version,1);
 for(const mutate of [h=>h.terms.input_hash='00'.repeat(32),h=>h.terms.provider='attacker.testnet',h=>h.terms.amount='2',h=>h.delivery.version=2,h=>h.delivery.output_hash='00'.repeat(32),h=>h.binding_hash='00'.repeat(32)]){
  const bad=clone(hold);mutate(bad);await assert.rejects(verifyPublicChainBinding(evidence,{fetcher:rpcFor(bad)}));
 }
 for(const alter of [(r,q)=>{if(q.method==='status')r.chain_id='mainnet';},(r,q)=>{if(q.params?.request_type==='view_account')r.code_hash='wrong';},(r,q)=>{if(q.params?.method_name==='get_hold')r.block_hash='2'.repeat(43);}])await assert.rejects(verifyPublicChainBinding(evidence,{fetcher:rpcFor(hold,alter)}));
 const changed=clone(evidence);changed.delivery.outputSha256='00'.repeat(32);await assert.rejects(verifyPublicChainBinding(changed,{fetcher:rpcFor(hold)}));
});
test('oversized public RPC/evidence bytes are rejected before JSON parsing',async()=>{
 await assert.rejects(boundedPublicJSON(new Response('x'.repeat(1025)),1024),/boyut/);
 await assert.rejects(boundedPublicJSON(new Response('{}',{status:503}),1024));
});
