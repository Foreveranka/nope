/** Offline API resource-boundary checks. Wallet/chain adapters are explicit
 * fixtures; these tests do not sign messages, send funds or claim chain proof. */
import test from 'node:test';
import assert from 'node:assert/strict';
import {generateKeyPairSync,randomBytes} from 'node:crypto';
import {createWorkspace,sha} from './core.mjs';
import {ROOT} from './blob.mjs';
import {walletIdentity} from './wallet-auth.mjs';
import {WALLET_ESCROW_KIND} from './wallet-escrow.mjs';
import {prepareRecipe} from '../web/recipe-client.mjs';
const ORIGIN='http://localhost:8712',CONTRACT='quota.testnet',BLOCK='4'.repeat(44);
const canonical=v=>JSON.stringify(v,(_,x)=>x&&typeof x==='object'&&!Array.isArray(x)?Object.fromEntries(Object.keys(x).sort().map(k=>[k,x[k]])):x);
class Store{records=new Map();async read(k){return structuredClone(this.records.get(k)??null);}async create(k,v){if(this.records.has(k))return false;this.records.set(k,structuredClone(v));return true;}async list(){return{pathnames:[],cursor:null};}}
function setup(){
 const store=new Store();const walletAuth={get:async s=>({network:'testnet',accountId:s.displayName})};
 const walletEscrow={kind:WALLET_ESCROW_KIND,contractId:CONTRACT,prepare:async()=>{throw Error('not used');},confirm:async()=>{throw Error('not used');},context:j=>({bindingHash:j.payment.bindingHash,terms:{execution_deadline_ns:'100',review_deadline_ns:'200'}}),refresh:async j=>({...j.payment,stateVerified:true,receiptVerified:false,stateBlockHash:BLOCK,verified:true})};
 const handle=createWorkspace({store,env:{NOPE_WORKSPACE_ORIGIN:ORIGIN},walletAuth,walletEscrow,walletRequired:false,now:()=>Date.parse('2026-11-14T10:00:00Z')});
 async function call(path,token,body){const r=await handle(new Request(ORIGIN+'/api/workspace'+path,{method:body===undefined?'GET':'POST',headers:{origin:ORIGIN,...(token?{authorization:'Bearer '+token}:{}),...(body===undefined?{}:{'content-type':'application/json'})},...(body===undefined?{}:{body:JSON.stringify(body)})}));return{status:r.status,data:await r.json()};}
 async function session(role,account){const r=await call('/session',null,{role,displayName:account});assert.equal(r.status,201);return r.data.token;}
 return{store,call,session};
}
test('verified wallet job quota survives fresh cookies and sessions; unrelated wallet still creates',async()=>{
 const f=setup(),task=(await prepareRecipe([42],{type:'number',steps:[{op:'fill',value:0}]})).request;
 const buyerPublicKey=generateKeyPairSync('rsa',{modulusLength:2048}).publicKey.export({format:'jwk'});
 const body=()=>({jobId:randomBytes(16).toString('hex'),title:'Offline quota control',description:'Synthetic',deadlineISO:'2026-11-15T10:00:00Z',profile:task.profile,rowCount:1,task,buyerPublicKey});
 for(let i=0;i<5;i++){const token=await f.session('buyer','limited.testnet');assert.equal((await f.call('/jobs',token,body())).status,201);}
 const fresh=await f.session('buyer','limited.testnet');assert.equal((await f.call('/jobs',fresh,body())).status,429);
 const unrelated=await f.session('buyer','unrelated.testnet');assert.equal((await f.call('/jobs',unrelated,body())).status,201);
});
test('provider cannot spend final customer revision reserve; buyer can still observe a real transition',async()=>{
 const f=setup(),buyer=await f.session('buyer','buyer.testnet'),provider=await f.session('provider','provider.testnet');
 const id='1'.repeat(32),buyerId=walletIdentity('buyer','buyer.testnet');let previous=null;
 for(let revision=0;revision<224;revision++){
  const job={id,buyerId,buyerWallet:{network:'testnet',accountId:'buyer.testnet'},status:'AWARDED',offers:[],events:[],delivery:null,revision,selectedOffer:{wallet:{network:'testnet',accountId:'provider.testnet'},paymentAccount:'provider.testnet'},payment:{kind:WALLET_ESCROW_KIND,network:'testnet',contractId:CONTRACT,buyerAccount:'buyer.testnet',bindingHash:'a'.repeat(64),executionDeadlineNs:'100',reviewDeadlineNs:'200',awardedAtISO:'2026-11-14T10:00:00Z',status:'HELD',verified:false}};
  const record={job,previousHash:previous?sha(canonical(previous)):null};await f.store.create(ROOT+'jobs/'+id+'/'+String(revision).padStart(4,'0')+'.json',record);previous=record;
 }
 const denied=await f.call('/jobs/'+id+'/payment/refresh',provider,{});assert.equal(denied.status,409);assert.equal(denied.data.code,'REVISION_LIMIT');
 const recovered=await f.call('/jobs/'+id+'/payment/refresh',buyer,{});assert.equal(recovered.status,200,JSON.stringify(recovered.data));assert.equal(recovered.data.job.revision,224);
});
