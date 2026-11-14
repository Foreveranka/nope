import test from 'node:test';
import assert from 'node:assert/strict';
import {generateKeyPairSync,randomBytes} from 'node:crypto';
import {KeyPair,KeyPairSigner,baseEncode} from 'near-api-js';
import {signMessage} from 'near-api-js/nep413';
import {createWorkspace,quoteCommitment,sha} from './core.mjs';
import {createWalletAuth,walletIdentity} from './wallet-auth.mjs';
import {createWalletEscrow,WALLET_ESCROW_DOMAIN,WALLET_ESCROW_KIND} from './wallet-escrow.mjs';
import {prepareProofPlan} from '../web/proof-plan-client.mjs';
import {hashProofPlanRequest} from '../web/proof-plan-core.mjs';
import {acceptAgentProposal} from '../web/agent-plan.mjs';
import {ROOT} from './blob.mjs';
// Actual NEP-413 SDK signatures and encrypted v4 execution. Storage, FINAL
// chain states and account RPC are offline fixtures. No actual SNARK, wallet
// broadcast, native payout, customer funding or deployed contract is claimed.
class Store{records=new Map();async read(p){return structuredClone(this.records.get(p)??null);}async create(p,v){if(this.records.has(p))return false;this.records.set(p,structuredClone(v));return true;}async list({prefix,limit,cursor}){const keys=[...this.records.keys()].filter(p=>p.startsWith(prefix)).sort(),n=Number(cursor||0);return{pathnames:keys.slice(n,n+limit),cursor:n+limit<keys.length?String(n+limit):null};}}
const ORIGIN='http://localhost:8712',BLOCK=baseEncode(Buffer.alloc(32,2)),CODE=baseEncode(Buffer.alloc(32,3));
const admission=generateKeyPairSync('ed25519'),admissionPublicKey=admission.publicKey.export({format:'der',type:'spki'}).subarray(-32).toString('hex'),admissionEnv=admission.privateKey.export({format:'der',type:'pkcs8'}).toString('base64');
const POLICY={admissionPublicKey,network:'testnet',domain:WALLET_ESCROW_DOMAIN,contractId:'wallet-core.testnet',codeHash:CODE,requireKeyless:true,storageDepositYocto:'40960000000000000000000'};
const PUBLIC_KEY=generateKeyPairSync('rsa',{modulusLength:2048}).publicKey.export({format:'jwk'});
async function setup(){
 const store=new Store(),calls=[];let time=Date.parse('2026-11-14T10:00:00.000Z'),hold=null,blockHash=BLOCK;
 const rpc=async(method,params)=>{
  calls.push({method,params});if(method==='status')return{chain_id:'testnet'};
  if(method==='block')return{header:{hash:blockHash,height:10,timestamp_nanosec:String(BigInt(time)*1000000n)}};
  assert.equal(method,'query');if(params.request_type==='view_access_key')return{block_hash:BLOCK,permission:'FullAccess'};
  if(params.request_type==='view_account')return{block_hash:blockHash,block_height:10,code_hash:CODE};
  if(params.request_type==='view_access_key_list')return{block_hash:blockHash,keys:[]};
  assert.equal(params.method_name,'get_hold');assert.equal(params.block_id,blockHash);if(hold)assert.deepEqual(JSON.parse(Buffer.from(params.args_base64,'base64')),{buyer_account:hold.terms.buyer_account,job_id:hold.terms.job_id});return{block_hash:blockHash,result:[...Buffer.from(JSON.stringify(hold))]};
 };
 const env={NOPE_WORKSPACE_ORIGIN:ORIGIN,NOPE_WALLET_ADMISSION_KEY:admissionEnv},walletAuth=createWalletAuth({store,env,config:POLICY,now:()=>time,rpc}),walletEscrow=createWalletEscrow({store,env,config:POLICY,now:()=>time,rpc});
 const core=createWorkspace({store,env,now:()=>time,walletAuth,walletEscrow,walletRequired:true});
 async function call(path,who,body){const method=body===undefined?'GET':'POST';const r=await core(new Request(ORIGIN+'/api/workspace'+path,{method,headers:{origin:ORIGIN,...(who?{authorization:'Bearer '+who.token}:{}),...(body!==undefined?{'content-type':'application/json'}:{})},...(body!==undefined?{body:JSON.stringify(body)}:{})}));return{status:r.status,data:await r.json()};}
 async function session(role,name=role){const r=await call('/session',null,{role,displayName:name});assert.equal(r.status,201,JSON.stringify(r.data));return r.data;}
 async function link(who,accountId,key){const c=await call('/wallet/challenge',who,{accountId});assert.equal(c.status,200,JSON.stringify(c.data));const challenge=c.data.challenge,signer=KeyPairSigner.fromSecretKey(key.toString());const proof=await signMessage({signerAccount:{accountId,getSigner:()=>signer},payload:{message:challenge.message,nonce:new Uint8Array(Buffer.from(challenge.nonce,'base64')),recipient:challenge.recipient,callbackUrl:challenge.callbackUrl}});const r=await call('/wallet/verify',who,{challengeId:challenge.challengeId,accountId,publicKey:proof.publicKey.toString(),signature:Buffer.from(proof.signature).toString('base64')});assert.equal(r.status,200,JSON.stringify(r.data));who.session=r.data.session;return r.data;}
 return{store,calls,walletEscrow,core,call,session,link,setBlock:v=>blockHash=v,setTime:v=>time=v,now:()=>time,setHold:v=>hold=structuredClone(v),hold:()=>hold};
}
test('wallet API requires verified owners, exact funding before encrypted execution, final record per revision, real proof before acceptance, and wallet-only refund recovery',async()=>{
 const f=await setup(),buyer=await f.session('buyer'),provider=await f.session('provider'),buyerKey=KeyPair.fromRandom('ed25519'),providerKey=KeyPair.fromRandom('ed25519');
 assert.equal((await f.call('/jobs',buyer,{})).data.code,'WALLET_LINK_REQUIRED');
 await f.link(buyer,'buyer-recover.testnet',buyerKey);await f.link(provider,'provider-recover.testnet',providerKey);assert.equal(buyer.session.id,walletIdentity('buyer','buyer-recover.testnet'));assert.equal(provider.session.paymentAccount,'provider-recover.testnet');
 const jobId=randomBytes(16).toString('hex'),task={version:1,goal:'Fill C1 blanks with 7.',columns:[{id:'C1',type:'number'}]},proposal=await acceptAgentProposal(task,{steps:[{column:'C1',recipe:{type:'number',steps:[{op:'fill',value:7}]}}]});
 const prepared=await prepareProofPlan({C1:[255]},proposal.plan,{jobId,buyerCommitment:sha('NOPE:buyer:'+buyer.session.id),contractId:POLICY.contractId});
 const body={jobId,title:'Offline wallet job',description:'Synthetic public brief',deadlineISO:new Date(f.now()+3600000).toISOString(),profile:prepared.request.profile,rowCount:1,task:prepared.request,buyerPublicKey:PUBLIC_KEY,publicTask:task};
 const create=await f.call('/jobs',buyer,body);assert.equal(create.status,201,JSON.stringify(create.data));assert.equal(create.data.job.payment.kind,WALLET_ESCROW_KIND);assert.equal(create.data.job.buyerWallet.accountId,'buyer-recover.testnet');
 assert.equal(create.data.job.taskHash,await hashProofPlanRequest(prepared.request));assert.match(create.data.job.programHash,/^[a-f0-9]{64}$/);
 for(const key of ['task','dataset','headers','decoder','proofDecoder','proofWitness','inputPairs','outputPairs','creationHash','decisions'])assert.equal(Object.hasOwn(create.data.job,key),false,key);
 const amountYocto='1000000000000000000000',salt='d'.repeat(64),envelope={wrappedKey:randomBytes(256).toString('base64'),iv:randomBytes(12).toString('base64'),ciphertext:randomBytes(32).toString('base64')};
 const path='/jobs/'+jobId,post=(action,b={},who=buyer)=>f.call(path+'/'+action,who,b);
 assert.equal((await post('offers',{envelope,commitment:quoteCommitment(jobId,provider.session.id,amountYocto,salt)},provider)).status,200);
 const closed=await post('close'),offerId=closed.data.job.offers[0].id;const awarded=await post('award',{offerId,amountYocto,salt});assert.equal(awarded.status,200,JSON.stringify(awarded.data));let job=awarded.data.job;
 assert.equal((await post('execute',{},provider)).data.code,'ESCROW_FUNDING_REQUIRED');assert.equal((await post('payment/fund')).data.code,'WALLET_SIGNED_TRANSACTION_REQUIRED');
 const intent=await post('payment/prepare',{action:'fund'});assert.equal(intent.status,200,JSON.stringify(intent.data));assert.equal(intent.data.job.payment.status,'NOT_FUNDED');assert.equal(intent.data.intent.transaction.actions[0].params.deposit,(BigInt(amountYocto)+BigInt(POLICY.storageDepositYocto)).toString());
 assert.equal((await post('payment/prepare',{action:'fund',amountYocto:'1'})).status,400);
 assert.equal((await post('payment/refresh')).data.job.payment.status,'UNKNOWN');assert.equal((await post('payment/prepare',{action:'fund'})).data.intent,null);
 const ctx={terms:intent.data.intent.transaction.actions[0].params.args.terms,bindingHash:intent.data.intent.bindingHash};f.setHold({terms:ctx.terms,binding_hash:ctx.bindingHash,storage_deposit_yocto:'40960000000000000000000',state:'Held',nonce:'0',delivery:null,pending:null,last_transfer_failure_nonce:null});
 const funded=await post('payment/refresh');assert.equal(funded.data.job.payment.status,'HELD');assert.equal(funded.data.job.payment.stateVerified,true);assert.equal(funded.data.job.payment.receiptVerified,false);assert.equal(funded.data.job.payment.fundTransactionHash,undefined);
 // Actual read-only RPC refresh path across >256 different FINAL observations.
 // A selected counterparty must not spend the buyer's finite ledger capacity.
 const revision=funded.data.job.revision,recordCount=f.store.records.size;
 for(let i=1;i<=260;i++){
  const block=Buffer.alloc(32,2);block.writeUInt32BE(i,28);f.setBlock(baseEncode(block));
  const refreshed=await post('payment/refresh',{},provider);assert.equal(refreshed.status,200,JSON.stringify(refreshed.data));
  assert.equal(refreshed.data.job.revision,revision);assert.equal(refreshed.data.job.payment.stateBlockHash,baseEncode(block));
 }
 assert.equal(f.store.records.size,recordCount);
 const executed=await post('execute',{},provider);assert.equal(executed.status,200,JSON.stringify(executed.data));job=executed.data.job;assert.equal(job.delivery.version,1);assert.equal(job.programHash,job.delivery.programSha256);assert.equal(job.taskHash,job.delivery.inputSha256);assert.equal(job.delivery.inputSha256,await hashProofPlanRequest(prepared.request));
 const record=await post('payment/prepare',{action:'record'},provider);assert.equal(record.status,200,JSON.stringify(record.data));assert.deepEqual(record.data.intent.transaction.actions[0].params.args,{buyer_account:'buyer-recover.testnet',job_id:jobId,version:1,output_hash:job.delivery.outputSha256});
 assert.equal((await post('decision',{decision:'revise',version:1,outputSha256:job.delivery.outputSha256})).data.code,'ESCROW_DELIVERY_RECORD_REQUIRED');
 f.hold().state='Delivered';f.hold().delivery={version:1,output_hash:job.delivery.outputSha256};assert.equal((await post('payment/refresh',{},provider)).data.job.payment.recordedVersion,1);
 assert.equal((await post('decision',{decision:'accept',version:1,outputSha256:job.delivery.outputSha256})).data.code,'RESULT_PROOF_REQUIRED');
 assert.equal((await post('payment/prepare',{action:'release'})).data.code,'RESULT_PROOF_REQUIRED');
 assert.equal((await post('proof',{version:1,outputSha256:job.delivery.outputSha256,bundle:{fixture:'NOT-A-SNARK'}})).status,422);
 assert.equal((await post('decision',{decision:'revise',version:1,outputSha256:job.delivery.outputSha256})).data.job.status,'REVISION');
 job=(await post('execute',{},provider)).data.job;assert.equal(job.delivery.version,2);assert.equal((await post('decision',{decision:'revise',version:2,outputSha256:job.delivery.outputSha256})).data.code,'ESCROW_DELIVERY_RECORD_REQUIRED');
 // A provider record never signed/broadcast must retire once, rather than
 // churning its nested expiry metadata at every newer FINAL observation.
 assert.equal((await post('payment/prepare',{action:'record'},provider)).status,200);
 assert.equal((await post('payment/refresh',{},provider)).data.job.payment.status,'UNKNOWN');
 f.setTime(Number(BigInt(ctx.terms.review_deadline_ns)/1000000n)+1);
 const retired=await post('payment/refresh',{},provider);assert.equal(retired.status,200,JSON.stringify(retired.data));assert.equal(retired.data.job.payment.operation.status,'EXPIRED');
 const retiredRevision=retired.data.job.revision,retiredBlock=retired.data.job.payment.operation.expiredAtBlockHash;
 for(let i=261;i<=520;i++){
  const block=Buffer.alloc(32,2);block.writeUInt32BE(i,28);f.setBlock(baseEncode(block));
  const observed=await post('payment/refresh',{},i%2?provider:buyer);
  assert.equal(observed.status,200,JSON.stringify(observed.data));assert.equal(observed.data.job.revision,retiredRevision);
  assert.equal(observed.data.job.payment.operation.expiredAtBlockHash,retiredBlock);
 }
 const fresh=await f.session('buyer','new device with no local CSV');const guestId=fresh.session.id;await f.link(fresh,'buyer-recover.testnet',buyerKey);assert.notEqual(guestId,fresh.session.id);assert.equal(fresh.session.id,buyer.session.id);
 const listed=await f.call('/jobs',fresh);assert.ok(listed.data.jobs.some(j=>j.id===jobId));const restored=(await f.call(path,fresh)).data.job;assert.equal(restored.buyerId,buyer.session.id);assert.equal(restored.buyerWallet.accountId,'buyer-recover.testnet');assert.ok(!('decoder' in restored));
 const fakeToken=randomBytes(32).toString('base64url');await f.store.create(ROOT+'sessions/'+sha(fakeToken)+'.json',{session:{id:buyer.session.id,role:'buyer',displayName:'forged guest collision',paymentAccount:null},client:'f'.repeat(64)});
 assert.equal((await f.call(path,{token:fakeToken})).status,404);assert.equal((await f.call(path+'/payment/prepare',{token:fakeToken},{action:'refund'})).status,404);
 f.setTime(Number(BigInt(ctx.terms.review_deadline_ns)/1000000n)+1);
 const refund=await post('payment/prepare',{action:'refund'},fresh);assert.equal(refund.status,200,JSON.stringify(refund.data));assert.equal(refund.data.intent.transaction.signerId,'buyer-recover.testnet');assert.deepEqual(refund.data.intent.transaction.actions[0].params.args,{buyer_account:'buyer-recover.testnet',job_id:jobId});
 f.hold().state='RefundPending';f.hold().nonce='1';f.hold().pending={action:'refund',previous_state:'Delivered'};assert.equal((await post('payment/refresh',{},fresh)).data.job.payment.status,'REFUND_PENDING');
 f.hold().state='Refunded';f.hold().pending=null;const refunded=await post('payment/refresh',{},fresh);assert.equal(refunded.data.job.status,'REFUNDED');assert.equal(refunded.data.job.payment.receiptVerified,false);assert.equal(refunded.data.job.payment.refundTransactionHash,undefined);
 assert.ok(!f.calls.some(c=>/send|broadcast/.test(c.method)));const remote=JSON.stringify([...f.store.records]);for(const secret of [buyerKey.toString(),providerKey.toString(),'proofWitness','outputPairs','inputPairs','decoder'])assert.ok(!remote.includes(secret),secret);
});
