import test from 'node:test';
import assert from 'node:assert/strict';
import {KeyPair,KeyPairSigner} from 'near-api-js';
import {signMessage} from 'near-api-js/nep413';
import {createWalletAuth,WALLET_ROOT} from './wallet-auth.mjs';
import fs from 'node:fs/promises';
import vm from 'node:vm';
import {patchIntearExecutor} from '../wallet-runtime/sdk-patches.mjs';
// Real NEP-413 signatures and SDK verification; immutable store and FINAL RPC
// are explicit offline fixtures, not evidence of live wallet ownership.
class Store{records=new Map();async read(p){return structuredClone(this.records.get(p)??null);}async create(p,v){if(this.records.has(p))return false;this.records.set(p,structuredClone(v));return true;}}
const ORIGIN='http://localhost:8712',SESSION={id:'a'.repeat(32),role:'buyer'},POLICY={network:'testnet',contractId:'wallet-fixture.testnet',codeHash:'2'.repeat(44),domain:'NOPE:WALLET-ESCROW:V1:testnet'};
function fixture({clockStep=0}={}){const store=new Store(),key=KeyPair.fromRandom('ed25519'),rpcCalls=[];let time=1700000000000,permission='FullAccess',chain='testnet';
 const auth=createWalletAuth({store,env:{NOPE_WORKSPACE_ORIGIN:ORIGIN},config:POLICY,now:()=>{const value=time;time+=clockStep;return value;},rpc:async(method,params)=>{rpcCalls.push({method,params});return method==='status'?{chain_id:chain}:{block_hash:'2'.repeat(44),permission};}});
 async function request(session=SESSION,accountId='buyer.testnet'){return auth.challenge({session,accountId,origin:ORIGIN});}
 async function proof(c,changes={}){const signer=KeyPairSigner.fromSecretKey(key.toString());const result=await signMessage({signerAccount:{accountId:c.accountId,getSigner:()=>signer},payload:{message:c.message,nonce:new Uint8Array(Buffer.from(c.nonce,'base64')),recipient:c.recipient,callbackUrl:c.callbackUrl,...changes}});return{challengeId:c.challengeId,accountId:c.accountId,publicKey:result.publicKey.toString(),signature:Buffer.from(result.signature).toString('base64')};}
 const verify=(input,session=SESSION,origin=ORIGIN)=>auth.verify({session,origin,...input});return{store,key,auth,request,proof,verify,rpcCalls,setTime:t=>time=t,setPermission:v=>permission=v,setChain:v=>chain=v};
}
test('NEP-413 actual SDK signature links exact session/account/testnet/origin with a FINAL FullAccess query',async()=>{
 const f=fixture(),c=await f.request();assert.equal(Buffer.from(c.nonce,'base64').length,32);assert.equal(Date.parse(c.expiresAt)-Date.parse(c.issuedAt),300000);assert.equal(c.callbackUrl,ORIGIN+'/settings');
 const input=await f.proof(c),wallet=await f.verify(input);assert.deepEqual(await f.auth.get(SESSION),wallet);assert.equal(wallet.accountId,'buyer.testnet');assert.equal(wallet.publicKey,f.key.getPublicKey().toString());
 assert.deepEqual(f.rpcCalls.at(-1).params,{request_type:'view_access_key',account_id:'buyer.testnet',public_key:input.publicKey,finality:'final'});
 const disk=JSON.stringify([...f.store.records]);assert.ok(!disk.includes(f.key.toString()));assert.ok(!disk.includes(input.signature));assert.equal(wallet.network,'testnet');
});
test('challenge lifetime remains exact when clock advances between every read',async()=>{
 const f=fixture({clockStep:1}),c=await f.request();
 assert.equal(Date.parse(c.expiresAt)-Date.parse(c.issuedAt),300000);
 assert.equal((await f.verify(await f.proof(c))).accountId,c.accountId);
});
test('actual pinned Intear callback wire mismatch fails auth; camelCase wire preserves required callback with genuine synthetic NEP413 crypto',async()=>{
 const f=fixture(),c=await f.request();
 const source=await fs.readFile(new URL('../wallet-runtime/intear-executor.upstream.js',import.meta.url),'utf8');
 function walletPayload(executor){
  // Evaluate the actual published encoder expression, then project the official
  // wallet MessageToSign schema (serde rename_all="camelCase"). Unknown snake
  // callback_url is ignored by serde, leaving its optional callback empty.
  const start=executor.indexOf('i=JSON.stringify({message:t.message'),end=executor.indexOf('),c=Date.now()',start);
  assert.ok(start>=0&&end>start);
  const wire=vm.runInNewContext(executor.slice(start+2,end+1),{t:{message:c.message,nonce:Uint8Array.from(Buffer.from(c.nonce,'base64')),recipient:c.recipient,callbackUrl:c.callbackUrl,state:c.challengeId},Uint8Array});
  const decoded=JSON.parse(wire);
  return {message:decoded.message,nonce:Uint8Array.from(decoded.nonce),recipient:decoded.recipient,callbackUrl:decoded.callbackUrl};
 }
 const broken=walletPayload(source);assert.equal(broken.callbackUrl,undefined);
 await assert.rejects(f.verify(await f.proof(c,broken)),{code:'WALLET_SIGNATURE_NOT_VERIFIED'});assert.equal(await f.auth.get(SESSION),null);
 const fixed=walletPayload(patchIntearExecutor(source));assert.equal(fixed.callbackUrl,c.callbackUrl);
 const linked=await f.verify(await f.proof(c,fixed));assert.equal(linked.accountId,c.accountId);
 assert.equal(f.rpcCalls.at(-1).params.finality,'final');
 assert.throws(()=>patchIntearExecutor(patchIntearExecutor(source)),/callback shape changed/);
});
test('challenge claims are single-use under concurrent verification and account binding is immutable',async()=>{
 const f=fixture(),c=await f.request(),p=await f.proof(c),results=await Promise.allSettled([f.verify(p),f.verify(p)]);assert.equal(results.filter(r=>r.status==='fulfilled').length,1);assert.equal(results.find(r=>r.status==='rejected').reason.code,'WALLET_CHALLENGE_USED');
 await assert.rejects(f.request(SESSION,'other.testnet'),{code:'WALLET_ACCOUNT_IMMUTABLE'});assert.ok([...f.store.records.keys()].some(p=>p.startsWith(WALLET_ROOT+'claims/')));
});
test('expiry, session, role, origin, network, callback and signature substitution fail closed without linking',async()=>{
 for(const variant of ['expired','session','role','origin','network','callback','signature','function-call']){
  const f=fixture(),c=await f.request(),p=await f.proof(c,variant==='callback'?{callbackUrl:ORIGIN+'/attacker'}:{});
  if(variant==='expired')f.setTime(Date.parse(c.expiresAt));if(variant==='network')f.setChain('mainnet');if(variant==='function-call')f.setPermission({FunctionCall:{receiver_id:'buyer.testnet',method_names:['anything'],allowance:'100'}});
  if(variant==='signature')p.signature=Buffer.alloc(64).toString('base64');
  await assert.rejects(f.verify(p,variant==='session'?{...SESSION,id:'b'.repeat(32)}:variant==='role'?{...SESSION,role:'provider'}:SESSION,variant==='origin'?'https://evil.invalid':ORIGIN),variant);
  assert.equal(await f.auth.get(SESSION),null,variant);
 }
});
test('nonce and canonical challenge fields resist private-store tampering; challenge storage is bounded',async()=>{
 const f=fixture(),c=await f.request(),p=await f.proof(c);const path=WALLET_ROOT+'challenges/'+c.challengeId+'.json',record=await f.store.read(path);record.message=record.message.replace('buyer.testnet','other.testnet');f.store.records.set(path,record);await assert.rejects(f.verify(p),{code:'WALLET_CHALLENGE_INTEGRITY'});
 for(let i=0;i<7;i++)await f.request();await assert.rejects(f.request(),{code:'WALLET_CHALLENGE_LIMIT'});
 const g=fixture(),d=await g.request(),q=await g.proof(d);await assert.rejects(g.verify({...q,signature:q.signature+'='}),{code:'WALLET_INVALID_ENCODING'});await assert.rejects(g.verify({...q,privateKey:'never'}),{code:'WALLET_INVALID_PROOF'});
});
