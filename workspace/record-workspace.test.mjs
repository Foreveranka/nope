/** Actual GC + Noir proofs; escrow/storage/session transport here are UNIT fixtures. */
import test from 'node:test';
import assert from 'node:assert/strict';
import {randomBytes} from 'node:crypto';
import {createWorkspace,ESCROW_KIND,quoteCommitment,sha} from './core.mjs';
import {proofPath,proofBundleHash} from './proof.mjs';
import {recordTemplate} from '../web/record-plan.mjs';
import {prepareProofPlan,decodeProofPlan,proveProofPlan} from '../web/proof-client.mjs';
import {proofRuntime,verifyProofPlanBundle} from '../web/proof-protocol.mjs';
const ORIGIN='http://localhost:8712',contractId='nope-work-da4cbb1e.testnet',clone=v=>structuredClone(v);
class Store{records=new Map();async read(k){return clone(this.records.get(k)??null);}async create(k,v){if(this.records.has(k))return false;this.records.set(k,clone(v));return true;}async list({prefix,limit}){return{pathnames:[...this.records.keys()].filter(k=>k.startsWith(prefix)).slice(0,limit)};}}
test.after(async()=>{await(await proofRuntime({profile:'nope-record-proof-gc-v5'})).dispose();});

test('v5 record jobs require genuine multi-field result proofs before acceptance/release and preserve authorization/replay rejection',async()=>{
 const store=new Store(),calls=[];
 const escrow={kind:ESCROW_KIND,contractId,async operate(job,action){calls.push(action);const base={...job.payment,network:'testnet',kind:ESCROW_KIND,contractId,bindingHash:'ab'.repeat(32),verified:true};
  if(action==='release')return{...base,status:'PAID',releaseTransactionHash:'1'.repeat(43)};
  return{...base,status:'HELD',...(action==='record'?{recordedVersion:job.delivery.version,recordedOutputHash:job.delivery.outputSha256}:{})};
 }};
 const handle=createWorkspace({store,escrow,env:{NOPE_WORKSPACE_ORIGIN:ORIGIN},now:()=>Date.parse('2026-11-14T12:00:00Z')});
 async function call(path,who,body){const r=await handle(new Request(ORIGIN+'/api/workspace'+path,{method:body===undefined?'GET':'POST',headers:{origin:ORIGIN,...(who?{authorization:'Bearer '+who.token}:{}),...(body===undefined?{}:{'content-type':'application/json'})},...(body===undefined?{}:{body:JSON.stringify(body)})}));return{status:r.status,data:await r.json()};}
 const buyer=(await call('/session',null,{role:'buyer',displayName:'UNIT proof buyer'})).data;
 const provider=(await call('/session',null,{role:'provider',displayName:'UNIT provider',paymentAccount:'provider.testnet'})).data;
 assert.deepEqual(buyer.proof,{profile:'nope-csv-proof-plan-gc-v4',enabled:true,contractId});
 const id=randomBytes(16).toString('hex'),path='/jobs/'+id;
 const task={version:2,goal:'Audit an invoice from four private fields.',columns:['C1','C2','C3','C4'].map(id=>({id,type:'uint32'}))};
 const {plan}=await recordTemplate(task,'invoice',['C1','C2','C3','C4']);
 const prepared=await prepareProofPlan([[3,12500,40000,50000]],plan,{jobId:id,buyerCommitment:sha('NOPE:buyer:'+buyer.session.id),contractId});
 const rsa=await crypto.subtle.generateKey({name:'RSA-OAEP',modulusLength:2048,publicExponent:Uint8Array.of(1,0,1),hash:'SHA-256'},true,['encrypt','decrypt']);
 const payload={jobId:id,title:'UNIT real result proof',description:'Unit state machine, not chain evidence',deadlineISO:'2026-11-15T12:00:00.000Z',profile:prepared.request.profile,rowCount:1,task:prepared.request,buyerPublicKey:await crypto.subtle.exportKey('jwk',rsa.publicKey),publicTask:task};
 const wrong=clone(payload);wrong.task.proofManifest.context.buyerCommitment='00'.repeat(32);assert.equal((await call('/jobs',buyer,wrong)).data.code,'INVALID_TASK');
 assert.equal((await call('/jobs',buyer,payload)).status,201);
 const salt='cd'.repeat(32),amountYocto='1000000000000000000000';
 const envelope={wrappedKey:Buffer.alloc(256).toString('base64'),iv:Buffer.alloc(12).toString('base64'),ciphertext:Buffer.alloc(17).toString('base64')};
 assert.equal((await call(path+'/offers',provider,{envelope,commitment:quoteCommitment(id,provider.session.id,amountYocto,salt)})).status,200);
 const closed=(await call(path+'/close',buyer,{})).data.job;
 await call(path+'/award',buyer,{offerId:closed.offers[0].id,amountYocto,salt});await call(path+'/payment/fund',buyer,{});
 let job=(await call(path+'/execute',provider,{})).data.job;assert.equal(job.status,'DELIVERED');assert.equal(job.delivery.profile,prepared.request.profile);
 assert.deepEqual(await decodeProofPlan(Object.fromEntries(['profile','nonce','rowCount','outputs','inputSha256','outputSha256','programSha256'].map(k=>[k,job.delivery[k]])),prepared.decoder),[[37500,2500,1,0]]);
 job=(await call(path+'/payment/record',provider,{})).data.job;
 const decision=(kind='accept')=>({decision:kind,version:job.delivery.version,outputSha256:job.delivery.outputSha256});
 assert.equal((await call(path+'/decision',buyer,decision())).data.code,'RESULT_PROOF_REQUIRED');
 assert.equal((await call(path+'/proof',provider,{version:1,outputSha256:job.delivery.outputSha256,bundle:{verified:true}})).status,403);
 assert.equal((await call(path+'/proof',buyer,{version:1,outputSha256:job.delivery.outputSha256,bundle:{verified:true}})).status,422);
 const binding=()=>({jobId:id,version:job.delivery.version,contractId,bindingHash:job.payment.bindingHash,provider:'provider.testnet',amountYocto});
 let bundle=await proveProofPlan({request:prepared.request,delivery:job.delivery,binding:binding(),witness:prepared.witness});
 const proofBody=b=>({version:job.delivery.version,outputSha256:job.delivery.outputSha256,bundle:b});
 for(const mutate of [b=>b.rows.pop(),b=>b.finalContext='00'.repeat(32),b=>b.rows[0].proof.verificationKeySha256='00'.repeat(32),b=>b.rows[0].proof.proof=(b.rows[0].proof.proof[0]==='A'?'B':'A')+b.rows[0].proof.proof.slice(1),b=>b.rows[0].proof.verified=true]){
  const bad=clone(bundle);mutate(bad);assert.equal((await call(path+'/proof',buyer,proofBody(bad))).status,422);
 }
 job=(await call(path+'/proof',buyer,proofBody(bundle))).data.job;assert.equal(job.proof.status,'VERIFIED');assert.equal(job.proof.rowProofCount,1);
 const revision=job.revision;assert.equal((await call(path+'/proof',buyer,proofBody(bundle))).data.job.revision,revision,'same verified proof is idempotent');
 const evidence=await call(path+'/proof/evidence',null);assert.equal(evidence.status,200);
 const wire=JSON.stringify(evidence.data);for(const privateKey of ['witness','inputPairs','outputPairs','inputSalt','outputSalt','buyerPublicKey','offers','Secret9'])assert.equal(wire.includes(privateKey),false,privateKey);
 assert.equal(await verifyProofPlanBundle({request:evidence.data.task,delivery:evidence.data.delivery,binding:evidence.data.binding,bundle:evidence.data.bundle}),true);
 // A legitimate revision invalidates the old proof despite identical encoded outputs.
 assert.equal((await call(path+'/decision',buyer,decision('revise'))).data.job.status,'REVISION');
 job=(await call(path+'/execute',provider,{})).data.job;assert.equal(job.delivery.version,2);assert.equal(job.proof.status,'NOT_CREATED');
 job=(await call(path+'/payment/record',provider,{})).data.job;
 assert.equal((await call(path+'/proof',buyer,proofBody(bundle))).status,422);assert.equal((await call(path+'/decision',buyer,decision())).data.code,'RESULT_PROOF_REQUIRED');
 bundle=await proveProofPlan({request:prepared.request,delivery:job.delivery,binding:binding(),witness:prepared.witness});
 job=(await call(path+'/proof',buyer,proofBody(bundle))).data.job;
 job=(await call(path+'/decision',buyer,decision())).data.job;assert.equal(job.status,'ACCEPTED');
 // Corrupting the persisted proof cannot turn a previous success flag into payment.
 const hash=proofBundleHash(bundle),saved=clone(store.records.get(proofPath(id,hash)));
 store.records.set(proofPath(id,hash),{bundle:{verified:true}});
 assert.equal((await call(path+'/payment/release',buyer,{})).data.code,'PROOF_INTEGRITY');assert.equal(calls.includes('release'),false);
 store.records.set(proofPath(id,hash),saved);
 job=(await call(path+'/payment/release',buyer,{})).data.job;assert.equal(job.status,'PAID');
});
