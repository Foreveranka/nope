/** Real encrypted bindings; RPC is explicitly an offline fixture, not chain evidence. */
import test from 'node:test';import assert from 'node:assert/strict';
import {WALLET_ESCROW_POLICY as POLICY} from '../web/wallet-pins.mjs';
import {chainPolicyFor,validatePublicEvidence,verifyPublicChainBinding} from '../web/public-proof.mjs';
import {prepareProofPlan} from '../web/proof-plan-client.mjs';
import {wrapProofPlanResult,hashProofPlanRequest,hashProofPlanProgram,proofRuntime} from '../web/proof-plan-core.mjs';
import {hashPlan} from '../web/plan-core.mjs';import {sha256} from '../web/gc-core.mjs';import {evaluatePlanRequest} from '../api/plan-gc.mjs';
let pending;
async function fixture(){return pending??=(async()=>{
 assert.ok(POLICY?.network==='testnet'&&POLICY.requireKeyless===true,'reviewed keyless wallet escrow deployment must be pinned before publishing');
 const jobId='ef'.repeat(16),buyer='buyer-wallet.testnet',buyerCommitment='aa'.repeat(32),plan={version:1,taskHash:'bb'.repeat(32),steps:[{column:'C1',recipe:{type:'number',steps:[{op:'fill',value:7}]}}]};
 const p=await prepareProofPlan({C1:[255]},plan,{jobId,buyerCommitment,contractId:POLICY.contractId});
 const delivery={...await wrapProofPlanResult(p.request,await evaluatePlanRequest(p.request.task)),version:1};
 const terms={job_id:jobId,buyer_commitment:buyerCommitment,buyer_account:buyer,provider:'provider-wallet.testnet',amount:'1000000000000000000000',input_hash:await hashProofPlanRequest(p.request),program_hash:await hashProofPlanProgram(plan),plan_hash:await hashPlan(plan),execution_deadline_ns:'1994794400000000000',review_deadline_ns:'1994880800000000000'};
 const bindingHash=await sha256(JSON.stringify([POLICY.domain,POLICY.contractId,...Object.values(terms)]));
 const hold={terms,binding_hash:bindingHash,state:'Delivered',delivery:{version:1,output_hash:delivery.outputSha256}};
 const evidence={version:1,network:'testnet',jobId,walletBuyerAccount:buyer,task:p.request,delivery,binding:{jobId,version:1,contractId:POLICY.contractId,bindingHash,provider:terms.provider,amountYocto:terms.amount}};
 return{hold,evidence};
})();}
const rpc=(hold,{keys=[],buyer,code,block}={})=>async(url,options)=>{
 assert.equal(url,'https://test.rpc.fastnear.com');const q=JSON.parse(options.body);let result;
 if(q.method==='status')result={chain_id:'testnet'};
 else if(q.params.request_type==='view_account')result={code_hash:code??POLICY.codeHash,block_hash:'1'.repeat(43)};
 else if(q.params.request_type==='view_access_key_list'){assert.equal(q.params.block_id,'1'.repeat(43));result={keys,block_hash:block??'1'.repeat(43)};}
 else{assert.equal(q.params.method_name,'get_hold');assert.equal(q.params.block_id,'1'.repeat(43));const args=JSON.parse(Buffer.from(q.params.args_base64,'base64').toString());assert.deepEqual(args,{job_id:hold.terms.job_id,buyer_account:buyer??hold.terms.buyer_account});result={block_hash:'1'.repeat(43),result:[...new TextEncoder().encode(JSON.stringify(hold))]};}
 return Response.json({jsonrpc:'2.0',result});
};
test.after(async()=>{if(pending)await(await proofRuntime()).dispose();});
test('wallet proof verifier pins namespace, exact customer deposit terms and immutable keyless contract',async()=>{
 const {hold,evidence}=await fixture();assert.equal(chainPolicyFor(POLICY.contractId),POLICY);assert.equal(validatePublicEvidence(evidence),evidence);
 const facts=await verifyPublicChainBinding(evidence,{fetcher:rpc(hold)});assert.equal(facts.bindingHash,hold.binding_hash);assert.equal(facts.contractId,POLICY.contractId);
 for(const change of [h=>h.terms.buyer_account='attacker.testnet',h=>h.terms.amount='2',h=>h.delivery.version=2,h=>h.terms.provider='attacker.testnet']){
  const changed=structuredClone(hold);change(changed);await assert.rejects(verifyPublicChainBinding(evidence,{fetcher:rpc(changed,{buyer:evidence.walletBuyerAccount})}));
 }
});
test('wallet proof rejects admin keys, wrong code, mixed final blocks and evidence-provided deployment pins',async()=>{
 const {hold,evidence}=await fixture();
 for(const opts of [{keys:[{public_key:'unit-deploy-key',access_key:{permission:'FullAccess'}}]},{code:'wrong'},{block:'2'.repeat(43)}])await assert.rejects(verifyPublicChainBinding(evidence,{fetcher:rpc(hold,opts)}));
 const changed=structuredClone(evidence);changed.binding.contractId='unreviewed.testnet';changed.policy={...POLICY,contractId:'unreviewed.testnet'};assert.throws(()=>validatePublicEvidence(changed));
 const missing=structuredClone(evidence);delete missing.walletBuyerAccount;await assert.rejects(verifyPublicChainBinding(missing,{fetcher:rpc(hold)}));
});
