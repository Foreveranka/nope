/** API authorization/state tests. Escrow service below is a UNIT FIXTURE, not chain evidence. */
import test from 'node:test';import assert from 'node:assert/strict';import {randomBytes} from 'node:crypto';
import {createWorkspace,ESCROW_KIND,quoteCommitment} from './core.mjs';
import {prepareRecipe} from '../web/recipe-client.mjs';
const ORIGIN='http://localhost:8712',contractId='escrow-demo.testnet',tx='1'.repeat(43);
class Store{records=new Map();async read(k){return structuredClone(this.records.get(k)??null);}async create(k,v){if(this.records.has(k))return false;this.records.set(k,structuredClone(v));return true;}async list({prefix,limit}){return {pathnames:[...this.records.keys()].filter(k=>k.startsWith(prefix)).slice(0,limit)};}}
async function fixture({enabled=true}={}){
 const store=new Store(),calls=[];let next=null;let serviceMode='initial';
 const service={kind:ESCROW_KIND,contractId,async operate(job,action){calls.push({action,job:structuredClone(job)});if(next)return next(job,action);
  const base={...job.payment,kind:ESCROW_KIND,network:'testnet',contractId,bindingHash:'a'.repeat(64)};
  if(action==='fund'){serviceMode='fund';return {...base,status:'FUNDING_PENDING',verified:false};}
  if(action==='record'){serviceMode='record';return {...base,status:'RECORD_PENDING',verified:false};}
  if(action==='release'){serviceMode='release';return {...base,status:'PAYOUT_PENDING',verified:false};}
  if(action==='refund'){serviceMode='refund';return {...base,status:'REFUND_PENDING',verified:false};}
  if(serviceMode==='fund')return {...base,status:'HELD',verified:true,fundTransactionHash:tx};
  if(serviceMode==='record')return {...base,status:'HELD',verified:true,recordTransactionHash:tx,recordedVersion:job.delivery.version,recordedOutputHash:job.delivery.outputSha256};
  if(serviceMode==='release')return {...base,status:'PAID',verified:true,releaseTransactionHash:tx};
  if(serviceMode==='refund')return {...base,status:'REFUNDED',verified:true,refundTransactionHash:tx};
  return base;
 }};
 const handle=createWorkspace({store,env:{NOPE_WORKSPACE_ORIGIN:ORIGIN},now:()=>Date.parse('2026-11-14T12:00:00Z'),escrow:enabled?service:null});
 async function call(path,who,body,method=body===undefined?'GET':'POST'){
  const r=await handle(new Request(ORIGIN+'/api/workspace'+path,{method,headers:{origin:ORIGIN,...(who?{authorization:'Bearer '+who.token}:{}),...(body!==undefined?{'content-type':'application/json'}:{})},...(body!==undefined?{body:JSON.stringify(body)}:{})}));return {status:r.status,data:await r.json()};
 }
 const session=async(role,name)=>(await call('/session',null,{role,displayName:name,...(role==='provider'?{paymentAccount:name+'.testnet'}:{})})).data;
 const buyer=await session('buyer','buyer'),provider=await session('provider','provider'),outsider=await session('provider','outsider');
 const rsa=await crypto.subtle.generateKey({name:'RSA-OAEP',modulusLength:2048,publicExponent:new Uint8Array([1,0,1]),hash:'SHA-256'},true,['encrypt','decrypt']);
 const task=(await prepareRecipe([255,200,42],{type:'number',steps:[{op:'fill',value:0},{op:'clamp',min:0,max:100}]})).request;
 const id=randomBytes(16).toString('hex'),path='/jobs/'+id;
 const created=await call('/jobs',buyer,{jobId:id,title:'UNIT escrow API fixture',description:'No real chain service in this test',deadlineISO:'2026-11-15T12:00:00.000Z',profile:task.profile,rowCount:3,task,buyerPublicKey:await crypto.subtle.exportKey('jwk',rsa.publicKey)});assert.equal(created.status,201);
 async function award(amountYocto='1000000000000000000000'){
  const salt='b'.repeat(64),commitment=quoteCommitment(id,provider.session.id,amountYocto,salt);
  // Syntactically valid opaque UNIT envelope: no claim that this is a neural or chain test.
  const envelope={wrappedKey:Buffer.alloc(256).toString('base64'),iv:Buffer.alloc(12).toString('base64'),ciphertext:Buffer.alloc(17).toString('base64')};
  assert.equal((await call(path+'/offers',provider,{envelope,commitment})).status,200);
  const closed=await call(path+'/close',buyer,{});assert.equal(closed.status,200);
  return call(path+'/award',buyer,{offerId:closed.data.job.offers[0].id,amountYocto,salt});
 }
 const action=(name,who=buyer,body={})=>call(path+'/'+name,who,body);
 const fund=async()=>{assert.equal((await action('payment/fund')).data.job.payment.status,'FUNDING_PENDING');assert.equal((await action('payment/refresh')).data.job.payment.status,'HELD');};
 const record=async()=>{assert.equal((await action('payment/record',provider)).data.job.payment.status,'RECORD_PENDING');assert.equal((await action('payment/refresh',provider)).data.job.payment.status,'HELD');};
 const get=async()=> (await call(path,buyer)).data.job;
 return {call,action,award,fund,record,get,calls,buyer,provider,outsider,created,service,setNext:fn=>next=fn};
}
test('escrow jobs require actual finalized funding; mutations retain buyer/provider authorization and exact empty bodies',async()=>{
 const f=await fixture();assert.equal(f.created.data.job.payment.kind,ESCROW_KIND);
 assert.equal((await f.action('payment/refresh')).status,200);assert.equal(f.calls.length,0,'no signing before award');
 assert.equal((await f.award()).status,200);assert.match((await f.get()).payment.awardedAtISO,/2026-11-14/);
 assert.equal((await f.action('execute',f.provider)).data.code,'ESCROW_FUNDING_REQUIRED');
 for(const action of ['payment/fund','payment/release','payment/refund'])assert.equal((await f.action(action,f.provider)).status,403,action);
 assert.equal((await f.action('payment/refresh',f.outsider)).status,403);
 assert.equal((await f.action('payment/fund',f.buyer,{amountYocto:'1'})).status,400);
 assert.equal((await f.action('payment/verify',f.buyer,{transactionHash:tx,buyerAccount:'buyer.testnet'})).data.code,'ESCROW_DIRECT_TRANSFER_FORBIDDEN');
 assert.equal((await f.action('payment/fund')).data.job.payment.status,'FUNDING_PENDING');
 assert.equal((await f.action('execute',f.provider)).data.code,'ESCROW_FUNDING_REQUIRED');
 await f.action('payment/refresh');assert.equal((await f.action('execute',f.provider)).status,200);
});
test('latest delivery must be recorded before exact buyer acceptance; only final verified payout marks PAID',async()=>{
 const f=await fixture();await f.award();await f.fund();
 let delivered=(await f.action('execute',f.provider)).data.job;
 const decision=job=>({decision:'accept',version:job.delivery.version,outputSha256:job.delivery.outputSha256});
 assert.equal((await f.action('decision',f.buyer,decision(delivered))).data.code,'ESCROW_DELIVERY_RECORD_REQUIRED');
 assert.equal((await f.action('decision',f.buyer,{...decision(delivered),decision:'revise'})).data.code,'ESCROW_DELIVERY_RECORD_REQUIRED','cannot skip a chain delivery version by requesting an unrecorded revision');
 await f.action('payment/record',f.provider);assert.equal((await f.action('decision',f.buyer,decision(delivered))).data.code,'ESCROW_DELIVERY_RECORD_REQUIRED');
 await f.action('payment/refresh');assert.equal((await f.action('decision',f.buyer,{...decision(delivered),decision:'revise'})).data.job.status,'REVISION');
 delivered=(await f.action('execute',f.provider)).data.job;assert.equal(delivered.delivery.version,2);
 assert.equal((await f.action('decision',f.buyer,decision(delivered))).data.code,'ESCROW_DELIVERY_RECORD_REQUIRED','old on-chain version is not enough');
 await f.record();assert.equal((await f.action('decision',f.provider,decision(delivered))).status,403);
 const accepted=await f.action('decision',f.buyer,decision(delivered));assert.equal(accepted.data.job.status,'ACCEPTED');assert.equal(accepted.data.job.payment.status,'RELEASE_READY');
 const pending=await f.action('payment/release');assert.equal(pending.data.job.status,'ACCEPTED');assert.equal(pending.data.job.payment.status,'PAYOUT_PENDING');
 const paid=await f.action('payment/refresh');assert.equal(paid.data.job.status,'PAID');assert.equal(paid.data.job.payment.releaseTransactionHash,tx);
 const count=f.calls.length;assert.equal((await f.action('payment/release')).status,200);assert.equal(f.calls.length,count,'terminal release does not ask signer again');
 f.setNext(j=>({...j.payment,status:'REFUNDED',verified:true,refundTransactionHash:tx}));assert.equal((await f.action('payment/refresh')).status,503);assert.equal((await f.get()).status,'PAID','verified terminal settlement cannot regress to refund');
});
test('UNKNOWN funding remains blocked, unchanged refresh does not exhaust revisions, malformed final evidence fails closed',async()=>{
 const f=await fixture();await f.award();f.setNext(j=>({...j.payment,status:'UNKNOWN',verified:false}));
 const first=await f.action('payment/fund'),second=await f.action('payment/refresh');assert.equal(first.data.job.revision,second.data.job.revision);
 assert.equal((await f.action('execute',f.provider)).data.code,'ESCROW_FUNDING_REQUIRED');
 for(const bad of [j=>({...j.payment,status:'PAID',verified:true,releaseTransactionHash:tx}),j=>({...j.payment,status:'HELD',network:'mainnet'}),j=>({...j.payment,status:'REFUNDED',verified:false,refundTransactionHash:tx})]){f.setNext(bad);assert.equal((await f.action('payment/refresh')).status,503);assert.equal((await f.get()).status,'AWARDED');}
});
test('only buyer can request terminal refunded state and it cannot be executed afterward',async()=>{
 const f=await fixture();await f.award();await f.fund();
 assert.equal((await f.action('payment/refund',f.provider)).status,403);
 assert.equal((await f.action('payment/refund')).data.job.payment.status,'REFUND_PENDING');
 const refunded=await f.action('payment/refresh');assert.equal(refunded.data.job.status,'REFUNDED');assert.equal(refunded.data.job.payment.status,'REFUNDED');
 assert.equal((await f.action('execute',f.provider)).status,409);
});
test('legacy jobs keep direct transfer semantics; oversized sponsored price is rejected before award',async()=>{
 const legacy=await fixture({enabled:false});assert.equal(legacy.created.data.job.payment.kind,undefined);await legacy.award();
 assert.equal((await legacy.action('payment/fund')).data.code,'ESCROW_JOB_REQUIRED');assert.equal((await legacy.action('execute',legacy.provider)).status,200);
 const f=await fixture();assert.equal((await f.award('10000000000000000000001')).data.code,'ESCROW_AMOUNT_LIMIT');assert.equal((await f.get()).status,'CLOSED');
});

test('canonical HTTP query routes admit only named escrow actions and keep auth/body for core validation',async()=>{
 const {createWorkspaceHandler}=await import('../api/workspace.mjs');let observed;
 const adapter=createWorkspaceHandler({env:{NOPE_WORKSPACE_ORIGIN:ORIGIN},handle:async req=>{observed={url:req.url,auth:req.headers.get('authorization'),body:await req.json()};return Response.json({unitOnly:true});}});
 const id='a'.repeat(32);
 for(const action of ['fund','record','release','refund','refresh']){
  observed=null;const res={setHeader(){},end(b){this.body=JSON.parse(b);}};
  await adapter({url:'/api/workspace?route=jobs/'+id+'/payment/'+action,method:'POST',headers:{origin:ORIGIN,authorization:'Bearer '+'a'.repeat(43),'content-type':'application/json'},body:{}},res);
  assert.equal(res.statusCode,200);assert.ok(observed.url.endsWith('/jobs/'+id+'/payment/'+action));assert.deepEqual(observed.body,{});assert.equal(observed.auth,'Bearer '+'a'.repeat(43));
 }
 const res={setHeader(){},end(){}};await adapter({url:'/api/workspace?route=jobs/'+id+'/payment/deploy',method:'POST',headers:{origin:ORIGIN,'content-type':'application/json'},body:{}},res);assert.equal(res.statusCode,404);
});
test('private Blob admits bounded escrow journal/nonce namespaces and rejects path injection and ambiguous nonces',async()=>{
 const {blobWorkspaceStore}=await import('./blob.mjs');const writes=[];
 const client={put:async(p,v,options)=>{writes.push({p,options});},get:async()=>null,list:async()=>({blobs:[]})};
 const store=blobWorkspaceStore({BLOB_READ_WRITE_TOKEN:'UNIT_ONLY'},client),key='a'.repeat(64),base='nope-workspace-v1/escrow/';
 await store.create(base+'ops/'+key+'/0004.json',{unit:true});await store.create(base+'nonces/'+key+'/123.json',{unit:true});
 assert.equal(writes.length,2);assert.ok(writes.every(x=>x.options.access==='private'&&x.options.allowOverwrite===false));
 for(const suffix of ['ops/'+key+'/../secret.json','nonces/'+key+'/01.json','nonces/'+key+'/-1.json','ops/'+key+'/00001.json'])await assert.rejects(store.create(base+suffix,{}));
});
