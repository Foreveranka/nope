import test from 'node:test';
import assert from 'node:assert/strict';
import {KeyPair,KeyPairSigner} from 'near-api-js';
import {signMessage} from 'near-api-js/nep413';
import {createWorkspace,sha} from './core.mjs';
import {createWalletAuth,workspaceOrigins,WORKSPACE_ORIGIN as CURRENT,LEGACY_WORKSPACE_ORIGIN as OLD} from './wallet-auth.mjs';
import {createWorkspaceHandler} from '../api/workspace.mjs';
import {ROOT} from './blob.mjs';
class Store{
 records=new Map();
 async read(p){return structuredClone(this.records.get(p)??null);}
 async create(p,v){if(this.records.has(p))return false;this.records.set(p,structuredClone(v));return true;}
 async list(){return {pathnames:[]};}
}
function fixture(env={}){
 const store=new Store(),key=KeyPair.fromRandom('ed25519');
 const auth=createWalletAuth({store,env,config:{network:'testnet',contractId:'fixture.testnet'},rpc:async method=>method==='status'?{chain_id:'testnet'}:{block_hash:'2'.repeat(44),permission:'FullAccess'}});
 const core=createWorkspace({store,env,walletAuth:auth}),adapter=createWorkspaceHandler({env,handle:core});
 async function call(origin,route,{body,token,headers={},url='/api/workspace?route='+route}={}){
  const res={setHeader(){},end(b){this.data=JSON.parse(String(b));}};
  await adapter({url,method:body===undefined?'GET':'POST',headers:{host:new URL(origin).host,origin,...(token?{authorization:'Bearer '+token}:{}),...(body===undefined?{}:{'content-type':'application/json'}),...headers},body:body===undefined?'':body},res);
  return {status:res.statusCode,data:res.data};
 }
 async function session(origin){const r=await call(origin,'session',{body:{role:'buyer',displayName:'Synthetic origin fixture'}});assert.equal(r.status,201,JSON.stringify(r.data));return r.data;}
 async function proof(c,changes={}){
  const signed=await signMessage({signerAccount:{accountId:c.accountId,getSigner:()=>KeyPairSigner.fromSecretKey(key.toString())},payload:{message:c.message,nonce:new Uint8Array(Buffer.from(c.nonce,'base64')),recipient:c.recipient,callbackUrl:c.callbackUrl,...changes}});
  return {challengeId:c.challengeId,accountId:c.accountId,publicKey:signed.publicKey.toString(),signature:Buffer.from(signed.signature).toString('base64')};
 }
 return {store,auth,call,session,proof};
}
test('exact origin config defaults to confirmed canonical and legacy; explicit self-host config stays isolated',()=>{
 assert.deepEqual(workspaceOrigins({}),{canonical:CURRENT,allowed:[CURRENT,OLD]});
 assert.deepEqual(workspaceOrigins({NOPE_WORKSPACE_ORIGIN:'http://127.0.0.1:3000'}).allowed,['http://127.0.0.1:3000']);
 assert.deepEqual(workspaceOrigins({NOPE_WORKSPACE_ORIGIN:OLD,NOPE_WORKSPACE_COMPAT_ORIGINS:CURRENT}).allowed,[OLD,CURRENT]);
 for(const invalid of ['https://*.vercel.app','https://example.com/','https://user@example.com','https://example.com/path','https://example.com?x=1','http://example.com','null','garbage'])assert.throws(()=>workspaceOrigins({NOPE_WORKSPACE_COMPAT_ORIGINS:invalid}),{code:'WALLET_AUTH_ORIGIN'});
});
test('both origins support real NEP413 crypto; sessions, challenges, recipient and callback never cross origins',async()=>{
 const f=fixture();
 for(const origin of [CURRENT,OLD]){
  const other=origin===CURRENT?OLD:CURRENT,who=await f.session(origin),token=who.token;
  assert.equal((await f.call(other,'session',{token})).data.code,'SESSION_ORIGIN_MISMATCH');
  const c=(await f.call(origin,'wallet/challenge',{token,body:{accountId:'buyer.testnet'}})).data.challenge;
  assert.equal(c.origin,origin);assert.equal(c.recipient,origin);assert.equal(c.callbackUrl,origin+'/settings');assert.equal(JSON.parse(c.message).origin,origin);
  const body=await f.proof(c);
  await assert.rejects(f.auth.verify({session:who.session,origin:other,...body}),{code:'WALLET_CHALLENGE_MISMATCH'});
  assert.equal((await f.call(other,'wallet/verify',{token,body})).data.code,'SESSION_ORIGIN_MISMATCH');
  for(const changes of [{callbackUrl:other+'/settings'},{recipient:other},{message:c.message.replace(origin,other)}])assert.equal((await f.call(origin,'wallet/verify',{token,body:await f.proof(c,changes)})).data.code,'WALLET_SIGNATURE_NOT_VERIFIED');
  assert.equal((await f.call(origin,'wallet/verify',{token,body})).status,200);
  assert.equal((await f.call(origin,'wallet/verify',{token,body})).data.code,'WALLET_CHALLENGE_USED');
  assert.equal((await f.call(origin,'session',{token,headers:{origin:other}})).data.code,'ORIGIN_DENIED');
  assert.equal((await f.call(origin,'session',{token,headers:{origin:undefined}})).status,200);
 }
});
test('historical session and wallet link remain usable on old URL without rewriting stored records',async()=>{
 const f=fixture(),who=await f.session(OLD),token=who.token;
 const c=(await f.call(OLD,'wallet/challenge',{token,body:{accountId:'buyer.testnet'}})).data.challenge;
 assert.equal((await f.call(OLD,'wallet/verify',{token,body:await f.proof(c)})).status,200);
 const path=ROOT+'sessions/'+sha(token)+'.json';delete f.store.records.get(path).origin;
 const before=JSON.stringify([...f.store.records]);
 assert.equal((await f.call(OLD,'session',{token})).status,200);
 assert.equal((await f.call(CURRENT,'session',{token})).data.code,'SESSION_ORIGIN_MISMATCH');
 assert.equal(JSON.stringify([...f.store.records]),before);
});
test('adapter rejects unknown/preview Host, absolute URL mismatch and forwarded-host or paired-origin spoofing',async()=>{
 const f=fixture(),who=await f.session(CURRENT),token=who.token;
 for(const headers of [{host:'arbitrary-preview.vercel.app'},{host:'evil.invalid','x-forwarded-host':new URL(CURRENT).host},{host:new URL(OLD).host,origin:CURRENT},{'sec-fetch-site':'cross-site'}])assert.equal((await f.call(CURRENT,'session',{token,headers})).data.code,'ORIGIN_DENIED');
 assert.equal((await f.call(CURRENT,'session',{token,url:OLD+'/api/workspace/session'})).data.code,'ORIGIN_DENIED');
 assert.equal((await f.call(CURRENT,'session',{token,headers:{'x-forwarded-host':'evil.invalid','x-forwarded-proto':'http'}})).status,200);
 const r=await f.call(CURRENT,'session',{token,headers:{host:'arbitrary-preview.vercel.app',origin:undefined}});assert.equal(r.status,403);
});
