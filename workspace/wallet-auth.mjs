/** Session-bound NEP-413 authentication. No wallet secret or transaction signer. */
import {randomBytes,createHash} from 'node:crypto';
import {verifyMessage} from 'near-api-js/nep413';
import {PublicKey,baseDecode} from 'near-api-js';
import {testnetAccount} from './payment.mjs';
export const walletIdentity=(role,accountId)=>createHash('sha256').update('NOPE:wallet-session:v1:testnet:'+role+':'+accountId).digest('hex').slice(0,32);
export const WALLET_ROOT='nope-workspace-v1/wallet/';
const sha=s=>createHash('sha256').update(s).digest('hex');
const fail=(code,status=409)=>{throw Object.assign(Error(code),{code,status});};
const check=(v,code,status)=>{if(!v)fail(code,status);};
const exact=(v,keys)=>v&&typeof v==='object'&&!Array.isArray(v)&&Object.keys(v).sort().join()===keys.slice().sort().join();
const hash=v=>typeof v==='string'&&/^[a-f0-9]{64}$/.test(v);
export const chainHash=v=>{try{return typeof v==='string'&&/^[1-9A-HJ-NP-Za-km-z]{43,44}$/.test(v)&&baseDecode(v).length===32;}catch{return false;}};
export const canonical=v=>JSON.stringify(v,(_,x)=>x&&typeof x==='object'&&!Array.isArray(x)?Object.fromEntries(Object.keys(x).sort().map(k=>[k,x[k]])):x);
export function decodeBase64(value,length){
 check(typeof value==='string'&&value.length<=2*1024*1024&&/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value),'WALLET_INVALID_ENCODING',400);
 const bytes=Buffer.from(value,'base64');check(bytes.toString('base64')===value&&(length===undefined||bytes.length===length),'WALLET_INVALID_ENCODING',400);return bytes;
}
export function createWalletRPC(config,{fetcher=fetch}={}){
 const url=config?.rpcUrl||'https://test.rpc.fastnear.com';
 check(['https://test.rpc.fastnear.com','https://rpc.testnet.near.org'].includes(url),'WALLET_RPC_CONFIG',503);
 return async(method,params)=>{
  const response=await fetcher(url,{method:'POST',redirect:'error',headers:{'content-type':'application/json'},signal:AbortSignal.timeout(12000),body:JSON.stringify({jsonrpc:'2.0',id:'wallet-read-only',method,params})});
  check(response.ok&&response.body,'WALLET_RPC_UNAVAILABLE',503);
  const reader=response.body.getReader(),chunks=[];let size=0;
  try{for(;;){const{done,value}=await reader.read();if(done)break;size+=value.byteLength;if(size>2*1024*1024){await reader.cancel();fail('WALLET_RPC_BOUND',503);}chunks.push(Buffer.from(value));}}finally{reader.releaseLock();}
  // Preserve RPC u64 lexical integers rather than round them through IEEE-754.
  const source=new TextDecoder('utf-8',{fatal:true}).decode(Buffer.concat(chunks));
  const data=JSON.parse(source.replace(/"(?:\\.|[^"\\])*"|-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?/g,t=>t[0]!=='"'&&/^-?\d+$/.test(t)&&!Number.isSafeInteger(Number(t))?JSON.stringify(t):t));
  if(data.error)throw Object.assign(Error('WALLET_RPC_UNAVAILABLE'),{code:'WALLET_RPC_UNAVAILABLE',status:503,rpcCode:data.error.code});
  check(Object.hasOwn(data,'result'),'WALLET_RPC_UNAVAILABLE',503);return data.result;
 };
}
export const WORKSPACE_ORIGIN='https://nope-workspace.vercel.app';
export const LEGACY_WORKSPACE_ORIGIN='https://veil-procurement.vercel.app';
// Configuration is an exact allowlist, never a wildcard or a forwarded-host rule.
export function workspaceOrigins(env=process.env){
 const canonical=env.NOPE_WORKSPACE_ORIGIN||WORKSPACE_ORIGIN;
 const compatibility=env.NOPE_WORKSPACE_COMPAT_ORIGINS===undefined?(canonical===WORKSPACE_ORIGIN?[LEGACY_WORKSPACE_ORIGIN]:[]):env.NOPE_WORKSPACE_COMPAT_ORIGINS.split(',').map(s=>s.trim());
 const allowed=[...new Set([canonical,...compatibility.filter(s=>s!=='')])];
 for(const origin of allowed){
  let url;try{url=new URL(origin);}catch{fail('WALLET_AUTH_ORIGIN',503);}
  check(url.origin===origin&&!url.hostname.includes('*')&&(url.protocol==='https:'||/^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin)),'WALLET_AUTH_ORIGIN',503);
 }
 return {canonical,allowed};
}
export function createWalletAuth({store,env=process.env,config,now=Date.now,rpc}={}){
 if(!config)return null;
 check(config.network==='testnet'&&testnetAccount(config.contractId)&&store&&typeof store.read==='function'&&typeof store.create==='function','WALLET_AUTH_CONFIG',503);
 rpc??=createWalletRPC(config);
 const origins=workspaceOrigins(env);
 function sessionFor(session,requestOrigin){check(session&&/^[a-f0-9]{32}$/.test(session.id)&&['buyer','provider'].includes(session.role)&&origins.allowed.includes(requestOrigin),'WALLET_SESSION_MISMATCH',403);}
 async function get(session,origin=origins.canonical){
  sessionFor(session,origin);const record=await store.read(`${WALLET_ROOT}sessions/${session.id}.json`);if(record===null)return null;
  check(record.version===1&&record.sessionId===session.id&&record.role===session.role&&record.origin===origin&&record.wallet?.network==='testnet'&&testnetAccount(record.wallet.accountId)&&typeof record.wallet.publicKey==='string','WALLET_LINK_INTEGRITY',503);
  return structuredClone(record.wallet);
 }
 async function challenge({session,accountId,origin}){
  sessionFor(session,origin);check(testnetAccount(accountId),'WALLET_ACCOUNT_REQUIRED',400);
  const linked=await get(session,origin);check(!linked||linked.accountId===accountId,'WALLET_ACCOUNT_IMMUTABLE');
  let limited=true;
  for(let i=0;i<8;i++){const id=sha(`rate:${session.id}:${Math.floor(now()/300000)}:${i}`);if(await store.create(`${WALLET_ROOT}challenges/${id}.json`,{rate:true})){limited=false;break;}}
  check(!limited,'WALLET_CHALLENGE_LIMIT',429);
  const issuedAtMs=now();
  const challengeId=randomBytes(32).toString('hex'),nonce=randomBytes(32).toString('base64'),issuedAt=new Date(issuedAtMs).toISOString(),expiresAt=new Date(issuedAtMs+300000).toISOString();
  const context={version:1,purpose:'NOPE:WALLET-AUTH:V1',network:'testnet',accountId,sessionId:session.id,role:session.role,origin,challengeId,nonce,issuedAt,expiresAt};
  const value={challengeId,network:'testnet',accountId,sessionId:session.id,role:session.role,origin,nonce,issuedAt,expiresAt,message:canonical(context),recipient:origin,callbackUrl:origin+'/settings'};
  check(await store.create(`${WALLET_ROOT}challenges/${challengeId}.json`,value),'WALLET_CHALLENGE_COLLISION',503);return Object.freeze(value);
 }
 async function verify({session,origin,...input}){
  sessionFor(session,origin);check(exact(input,['challengeId','accountId','publicKey','signature'])&&hash(input.challengeId)&&testnetAccount(input.accountId),'WALLET_INVALID_PROOF',400);
  const c=await store.read(`${WALLET_ROOT}challenges/${input.challengeId}.json`);
  check(c&&c.challengeId===input.challengeId&&c.sessionId===session.id&&c.role===session.role&&c.origin===origin&&c.network==='testnet'&&c.accountId===input.accountId&&c.recipient===origin&&c.callbackUrl===origin+'/settings','WALLET_CHALLENGE_MISMATCH',403);
  check(Number.isFinite(Date.parse(c.issuedAt))&&Date.parse(c.issuedAt)<=now()&&Date.parse(c.expiresAt)===Date.parse(c.issuedAt)+300000&&now()<Date.parse(c.expiresAt),'WALLET_CHALLENGE_EXPIRED');
  const expected={version:1,purpose:'NOPE:WALLET-AUTH:V1',network:'testnet',accountId:c.accountId,sessionId:c.sessionId,role:c.role,origin,challengeId:c.challengeId,nonce:c.nonce,issuedAt:c.issuedAt,expiresAt:c.expiresAt};
  check(c.message===canonical(expected),'WALLET_CHALLENGE_INTEGRITY',503);
  check(typeof input.publicKey==='string'&&/^ed25519:[1-9A-HJ-NP-Za-km-z]{43,44}$/.test(input.publicKey),'WALLET_INVALID_PUBLIC_KEY',400);
  let key;try{key=PublicKey.from(input.publicKey);check(key.toString()===input.publicKey&&key.data.length===32,'WALLET_INVALID_PUBLIC_KEY',400);}catch{fail('WALLET_INVALID_PUBLIC_KEY',400);}
  const signature=decodeBase64(input.signature,64),nonce=decodeBase64(c.nonce,32),linked=await get(session,origin);check(!linked||linked.accountId===c.accountId,'WALLET_ACCOUNT_IMMUTABLE');
  check((await rpc('status',[]))?.chain_id==='testnet','WALLET_WRONG_NETWORK',503);
  let blockHash;
  try{
   await verifyMessage({signerAccountId:c.accountId,signerPublicKey:key,payload:{message:c.message,nonce:new Uint8Array(nonce),recipient:c.recipient,callbackUrl:c.callbackUrl},signature:new Uint8Array(signature),provider:{async viewAccessKey({accountId,publicKey}){
    check(accountId===c.accountId&&publicKey.toString()===input.publicKey,'WALLET_KEY_MISMATCH');
    const result=await rpc('query',{request_type:'view_access_key',account_id:accountId,public_key:input.publicKey,finality:'final'});
    check(chainHash(result?.block_hash)&&result.permission==='FullAccess','WALLET_FULL_ACCESS_REQUIRED');blockHash=result.block_hash;return result;
   }}});
  }catch{fail('WALLET_SIGNATURE_NOT_VERIFIED',403);}
  check(now()<Date.parse(c.expiresAt),'WALLET_CHALLENGE_EXPIRED');
  check(await store.create(`${WALLET_ROOT}claims/${sha(c.nonce)}.json`,{challengeId:c.challengeId,sessionId:session.id,accountId:c.accountId,signatureSha256:sha(signature),usedAt:new Date(now()).toISOString()}),'WALLET_CHALLENGE_USED');
  const wallet={accountId:c.accountId,network:'testnet',publicKey:input.publicKey,verifiedAt:new Date(now()).toISOString()};
  const record={version:1,sessionId:session.id,role:session.role,origin,wallet,blockHash};
  if(!await store.create(`${WALLET_ROOT}sessions/${session.id}.json`,record)){
   const winner=await get(session,origin);check(winner?.accountId===c.accountId&&winner.network==='testnet','WALLET_ACCOUNT_IMMUTABLE');return winner;
  }
  return wallet;
 }
 return Object.freeze({challenge,verify,get,network:'testnet'});
}
