/** Explicit synthetic two-role test against the REAL API/NEAR relay. No fake service.
 * State is private local recovery material. Never publish it or its session tokens.
 */
import fs from 'node:fs';import path from 'node:path';import {fileURLToPath}from'node:url';import assert from'node:assert/strict';
import {randomBytes,generateKeyPairSync,privateDecrypt,constants,createDecipheriv,createHash}from'node:crypto';
import {acceptAgentProposal,privatePlanInputs,applyAgentOutput}from'../web/agent-plan.mjs';import{prepareProofPlan,decodeProofPlan,proveProofPlan}from'../web/proof-plan-client.mjs';import{verifyProofPlanBundle}from'../web/proof-plan-core.mjs';import{validatePublicEvidence,verifyPublicChainBinding}from'../web/public-proof.mjs';import{parseCSV}from'../web/csv-input.mjs';import{createVault}from'../web/workspace-vault.mjs';import{quoteCommitment}from'../workspace/core.mjs';
const ROOT=fileURLToPath(new URL('../',import.meta.url)),DIR=path.join(ROOT,'runtime/workspace-escrow');
const mode=process.argv[2],origin=process.argv[3]||'http://127.0.0.1:8773';
if(mode!=='run'||!['http://127.0.0.1:8773','https://veil-procurement.vercel.app'].includes(origin))throw Error('Explicit run and approved origin required');
const statePath=path.join(DIR,origin.startsWith('https:')?'proof-http-production-state.json':'proof-http-local-state.json');
fs.mkdirSync(DIR,{recursive:true,mode:0o700});let state;
function save(){const temp=statePath+'.tmp',fd=fs.openSync(temp,fs.constants.O_WRONLY|fs.constants.O_CREAT|fs.constants.O_EXCL|fs.constants.O_NOFOLLOW,0o600);try{fs.writeFileSync(fd,JSON.stringify(state));fs.fsyncSync(fd);}finally{fs.closeSync(fd);}fs.renameSync(temp,statePath);const d=fs.openSync(DIR,fs.constants.O_RDONLY);try{fs.fsyncSync(d);}finally{fs.closeSync(d);}}
if(fs.existsSync(statePath)){const s=fs.lstatSync(statePath);if(!s.isFile()||s.isSymbolicLink()||(s.mode&0o777)!==0o600)throw Error('Unsafe private HTTP state');state=JSON.parse(fs.readFileSync(statePath));if(state.origin!==origin)throw Error('Recovery origin mismatch');}
else{state={origin,syntheticOnly:true,jobId:randomBytes(16).toString('hex'),amountYocto:'1000000000000000000000',salt:randomBytes(32).toString('hex')};save();}
const start=performance.now();
function note(action,job){console.log(JSON.stringify({action,jobId:state.jobId,status:job?.status,payment:job?.payment?.status,operation:job?.payment?.operation?.status}));}
async function api(route,who,body){const r=await fetch(origin+'/api/workspace?route='+encodeURIComponent(route),{method:body===undefined?'GET':'POST',headers:{origin,...(state.cookie?{cookie:state.cookie}:{}),...(who?{authorization:'Bearer '+state[who].token}:{}),...(body!==undefined?{'content-type':'application/json'}:{})},...(body!==undefined?{body:JSON.stringify(body)}:{})});const set=r.headers.get('set-cookie');if(set){state.cookie=set.split(';')[0];save();}const data=await r.json();if(!r.ok)throw Object.assign(Error('API_'+r.status+'_'+data.code),{status:r.status,code:data.code});return data;}
for(const role of ['buyer','provider'])if(!state[role]){state[role]=await api('session',null,{role,displayName:'Escrow synthetic '+role,...(role==='provider'?{paymentAccount:'p2.veil-reg-e138f5c88250f821.testnet'}:{})});save();}
if(!state.prepared){const generation=JSON.parse(fs.readFileSync(path.join(ROOT,'planner-runtime/evidence/approved-38ce0d9/generation-evidence.json'),'utf8'));const row=generation.results.find(r=>r.id==='holdout-english');assert.equal(generation.actualNeuralInference,true);assert.equal(row.passed,true);state.task=row.task;state.plan=(await acceptAgentProposal(row.task,row.raw)).plan;
 state.dataset=parseCSV('record,private_supplier,private_score,private_note\nR01,"  ACME  ",,"İstanbul, preserve"\nR02," BETA42 ",200,keep\nR03,Gamma7,42,unchanged\n');assert.equal(state.buyer.proof?.enabled,true);state.prepared=await prepareProofPlan(privatePlanInputs(state.dataset,state.plan),state.plan,{jobId:state.jobId,buyerCommitment:createHash('sha256').update('NOPE:buyer:'+state.buyer.session.id).digest('hex'),contractId:state.buyer.proof.contractId});
 const pair=generateKeyPairSync('rsa',{modulusLength:2048});state.privateRSA=pair.privateKey.export({type:'pkcs8',format:'pem'});state.publicRSA=pair.publicKey.export({format:'jwk'});
 state.payload={jobId:state.jobId,title:'Synthetic agent result proof verification',description:'Synthetic public task. Two typed anonymous columns. No real money.',deadlineISO:new Date(Date.now()+3600000).toISOString(),profile:state.prepared.request.profile,rowCount:3,task:state.prepared.request,buyerPublicKey:state.publicRSA,publicTask:state.task};
 const forbiddenKeys=new Set(['decoder','witness','inputPairs','outputPairs','inputSalt','outputSalt']);
 const forbiddenValues=new Set(['private_supplier','private_score','private_note','ACME','BETA42','Gamma7','İstanbul, preserve']);
 const checkPublic=v=>{if(typeof v==='string')assert.equal(forbiddenValues.has(v),false,'Plaintext value in public payload');else if(v&&typeof v==='object')for(const[k,x]of Object.entries(v)){assert.equal(forbiddenKeys.has(k),false,'Private witness field in public payload');checkPublic(x);}};
 checkPublic(state.payload);save();}
const base='jobs/'+state.jobId;let job;
try{job=(await api(base,'buyer')).job;}catch(e){if(e.status!==404)throw e;job=(await api('jobs','buyer',state.payload)).job;}
assert.equal(job.payment.kind,'SPONSORED_TESTNET_ESCROW','API must use real configured escrow, not direct-transfer fallback');note('published',job);
if(job.status==='OPEN'){
 const providerJob=(await api(base,'provider')).job;
 if(!providerJob.ownOffer){const quote={jobId:state.jobId,providerId:state.provider.session.id,amountYocto:state.amountYocto,hours:1,note:'Synthetic encrypted execution',salt:state.salt};
  const vault=createVault(state.provider.session.id,{storage:{}});const envelope=await vault.encryptQuote(state.publicRSA,quote);state.envelope=envelope;save();await api(base+'/offers','provider',{envelope,commitment:quoteCommitment(state.jobId,quote.providerId,quote.amountYocto,quote.salt)});
 }job=(await api(base+'/close','buyer',{})).job;
}
if(job.status==='CLOSED'){
 const offer=job.offers.find(o=>o.providerId===state.provider.session.id);assert.ok(offer);
 const e=offer.envelope,key=privateDecrypt({key:state.privateRSA,oaepHash:'sha256',padding:constants.RSA_PKCS1_OAEP_PADDING},Buffer.from(e.wrappedKey,'base64'));
 const encrypted=Buffer.from(e.ciphertext,'base64'),dec=createDecipheriv('aes-256-gcm',key,Buffer.from(e.iv,'base64'));dec.setAAD(Buffer.from('workspace-vault/quote/v1'));dec.setAuthTag(encrypted.subarray(-16));
 const quote=JSON.parse(Buffer.concat([dec.update(encrypted.subarray(0,-16)),dec.final()]).toString());assert.equal(quote.amountYocto,state.amountYocto);assert.equal(quote.salt,state.salt);
 job=(await api(base+'/award','buyer',{offerId:offer.id,amountYocto:quote.amountYocto,salt:quote.salt})).job;note('awarded',job);
}
async function reconcile(accepted){const resumed=new Set();for(let i=0;i<30;i++){
 if(accepted(job))return;await new Promise(r=>setTimeout(r,1000));job=(await api(base+'/payment/refresh','buyer',{})).job;note('reconcile',job);
 const op=job.payment.operation,action=op?.resumeAction;
 if(action){
  assert.ok(['fund','record','release'].includes(action));assert.equal(op.action,action);assert.equal(op.status,'PENDING');
  assert.ok(['FUNDING_PENDING','RECORD_PENDING','PAYOUT_PENDING'].includes(job.payment.status));assert.ok(op.transactionHash);
  if(!resumed.has(op.operationId)){resumed.add(op.operationId);const exact=op.transactionHash;
   job=(await api(base+'/payment/'+action,'buyer',{})).job;assert.equal(job.payment.operation.transactionHash,exact,'Recovery must retain exact persisted signed transaction');note('resume-explicit-unbroadcast',job);
  }
 }
 if(job.payment.status==='ERROR')throw Error('Actual testnet operation failed; no resend');
 }throw Error('Same-transaction reconciliation incomplete; private recovery state preserved, no replacement signed');}
if(job.status==='AWARDED'){
 if(job.payment.status==='NOT_FUNDED')job=(await api(base+'/payment/fund','buyer',{})).job;
 await reconcile(j=>j.payment.status==='HELD'&&j.payment.verified===true);note('funded',job);
 job=(await api(base+'/execute','provider',{})).job;note('evaluated',job);
}
if(job.delivery){const result=await decodeProofPlan({profile:job.delivery.profile,nonce:job.delivery.nonce,rowCount:job.delivery.rowCount,outputs:job.delivery.outputs,inputSha256:job.delivery.inputSha256,outputSha256:job.delivery.outputSha256,programSha256:job.delivery.programSha256},state.prepared.decoder);const csv=applyAgentOutput(state.dataset,state.plan,result);assert.deepEqual(csv.rows,[['R01','ACME','10','İstanbul, preserve'],['R02','BETA42','80','keep'],['R03','GAMMA7','42','unchanged']]);state.referenceVerified=true;save();}
if(job.status==='DELIVERED'){
 if(job.payment.status==='HELD'&&job.payment.recordedVersion!==job.delivery.version)job=(await api(base+'/payment/record','provider',{})).job;
 await reconcile(j=>j.payment.status==='HELD'&&j.payment.verified===true&&j.payment.recordedVersion===j.delivery.version&&j.payment.recordedOutputHash===j.delivery.outputSha256);
 if(!job.proof||job.proof.status!=='VERIFIED'){
  const binding={jobId:job.id,version:job.delivery.version,contractId:job.payment.contractId,bindingHash:job.payment.bindingHash,provider:job.selectedOffer.paymentAccount,amountYocto:job.selectedOffer.amountYocto};
  if(!state.bundle){state.bundle=await proveProofPlan({request:state.prepared.request,delivery:job.delivery,binding,witness:state.prepared.witness,onProgress:p=>console.log(JSON.stringify({action:'real-SNARK-progress',...p}))});save();}
  assert.equal(await verifyProofPlanBundle({request:state.prepared.request,delivery:job.delivery,binding,bundle:state.bundle}),true);
  job=(await api(base+'/proof','buyer',{version:job.delivery.version,outputSha256:job.delivery.outputSha256,bundle:state.bundle})).job;note('SNARK-verified-server',job);
 }
 job=(await api(base+'/decision','buyer',{decision:'accept',version:job.delivery.version,outputSha256:job.delivery.outputSha256})).job;note('accepted',job);
}
if(job.status==='ACCEPTED'){
 if(job.payment.status==='RELEASE_READY')job=(await api(base+'/payment/release','buyer',{})).job;
 await reconcile(j=>j.status==='PAID'&&j.payment.status==='PAID'&&j.payment.verified===true);
}
assert.equal(job.status,'PAID');assert.equal(state.referenceVerified,true);state.final=job;save();
const evidence={recordedAt:new Date().toISOString(),origin,syntheticOnly:true,actualHTTP:true,actualExternalTestnet:true,nativeModelProposalReused:true,browserInference:false,jobId:state.jobId,profile:job.profile,status:job.status,payment:job.payment,inputSha256:job.delivery.inputSha256,outputSha256:job.delivery.outputSha256,programSha256:job.delivery.programSha256,planSha256:job.planSha256,checks:{sealedQuoteLocalDecrypt:true,actualEncryptedEvaluation:true,localReferenceMatched:true,finalizedFundingRequired:true,exactDeliveryRecorded:true,exactBuyerAcceptance:true,finalizedPayoutVerifiedByRelay:true,noFallbackOrReplacementTransaction:true},elapsedMs:Math.round(performance.now()-start),resultProof:true,proofClaim:'Typed result semantics relative to precommitted client mappings; not AES execution provenance or original CSV provenance',proof:job.proof};
fs.writeFileSync(path.join(ROOT,'docs/execution-proof/http-testnet-'+(origin.startsWith('https:')?'production':'local')+'.json'),JSON.stringify(evidence,null,2)+'\n');note('verified-actual-testnet-payout',job);

const publicEvidence=validatePublicEvidence(await api(base+'/proof/evidence',null),state.jobId);
const chain=await verifyPublicChainBinding(publicEvidence);assert.equal(chain.escrowState,'Paid','Independent RPC must observe actual completed payout');
assert.equal(await verifyProofPlanBundle({request:publicEvidence.task,delivery:publicEvidence.delivery,binding:publicEvidence.binding,bundle:publicEvidence.bundle}),true);
fs.writeFileSync(path.join(ROOT,'docs/execution-proof/independent-public-'+(origin.startsWith('https:')?'production':'local')+'.json'),JSON.stringify({recordedAt:new Date().toISOString(),jobId:state.jobId,chain,actualSNARKVerification:true,buyerWitnessUsed:false,rows:publicEvidence.bundle.rows.length},null,2)+'\n');
console.log(JSON.stringify({action:'independent-public-verification',jobId:state.jobId,rows:publicEvidence.bundle.rows.length,escrowState:chain.escrowState}));
