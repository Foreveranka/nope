import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {KeyPair,KeyPairSigner,baseEncode} from 'near-api-js';
import {signMessage} from 'near-api-js/nep413';
import {blobWorkspaceStore,ROOT} from './blob.mjs';
import {createWorkspace} from './core.mjs';
import {createWorkspaceHandler} from '../api/workspace.mjs';
import {createWalletAuth} from './wallet-auth.mjs';
import {createWalletEscrow,WALLET_ESCROW_KIND,WALLET_ESCROW_DOMAIN} from './wallet-escrow.mjs';

// Actual API HTTP transport + core + wallet services + production Blob adapter.
// Only Blob network transport and FINAL RPC are synthetic. No real chain calls,
// wallet broadcasts or funds. This specifically prevents a permissive test store
// from masking production wallet namespace validation failures.
const H=n=>baseEncode(Buffer.alloc(32,n)),BLOCK=H(2),TX=H(4),TIME=1700000000000;
const POLICY={network:'testnet',domain:WALLET_ESCROW_DOMAIN,contractId:'wallet-blob.testnet',codeHash:H(3),requireKeyless:true,storageDepositYocto:'40960000000000000000000'};
function transport(){
 const records=new Map(),calls=[];
 const client={async put(path,body,options){calls.push({method:'put',path,options});if(records.has(path))throw Error('occupied');records.set(path,body);},async get(path,options){calls.push({method:'get',path,options});return records.has(path)?{statusCode:200,stream:new Blob([records.get(path)]).stream()}:null;},async list(options){calls.push({method:'list',options});return{blobs:[...records.keys()].filter(p=>p.startsWith(options.prefix)).map(pathname=>({pathname})),hasMore:false};}};
 return{records,calls,client,store:blobWorkspaceStore({BLOB_READ_WRITE_TOKEN:'SYNTHETIC-BLOB-TOKEN'},client)};
}

test('production Blob adapter supports actual HTTP wallet session/challenge/verify and escrow intents, transaction claims and record retirement',async t=>{
 const b=transport();let now=TIME,hold=null,handler;
 const rpc=async(method,params)=>{
  if(method==='status')return{chain_id:'testnet'};
  if(method==='block')return{header:{hash:BLOCK,height:10,timestamp_nanosec:String(BigInt(now)*1000000n)}};
  if(method==='tx')throw Error('OFFLINE fixture: not broadcast');
  assert.equal(method,'query');
  if(params.request_type==='view_access_key')return{block_hash:BLOCK,permission:'FullAccess'};
  if(params.request_type==='view_account')return{block_hash:BLOCK,block_height:10,code_hash:POLICY.codeHash};
  if(params.request_type==='view_access_key_list'){assert.equal(params.block_id,BLOCK);return{block_hash:BLOCK,keys:[]};}
  assert.equal(params.request_type,'call_function');assert.equal(params.method_name,'get_hold');assert.equal(params.block_id,BLOCK);return{block_hash:BLOCK,result:[...Buffer.from(JSON.stringify(hold))]};
 };
 const server=createServer((req,res)=>handler(req,res));await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));t.after(()=>new Promise(resolve=>server.close(resolve)));
 const origin='http://127.0.0.1:'+server.address().port,env={NOPE_WORKSPACE_ORIGIN:origin};
 const auth=createWalletAuth({store:b.store,env,config:POLICY,now:()=>now,rpc}),escrow=createWalletEscrow({store:b.store,env,config:POLICY,now:()=>now,rpc});
 handler=createWorkspaceHandler({env,store:b.store,handle:createWorkspace({store:b.store,env,now:()=>now,walletAuth:auth,walletEscrow:escrow,walletRequired:true})});
 async function api(route,token,body){const response=await fetch(origin+'/api/workspace?route='+encodeURIComponent(route),{method:body===undefined?'GET':'POST',headers:{origin,...(token?{authorization:'Bearer '+token}:{}),...(body===undefined?{}:{'content-type':'application/json'})},...(body===undefined?{}:{body:JSON.stringify(body)})});return{status:response.status,data:await response.json()};}
 async function login(role,accountId){
  const session=await api('session',null,{role,displayName:'Blob fixture '+role});assert.equal(session.status,201,JSON.stringify(session.data));assert.equal(session.data.session.wallet,null,'session reads the wallet/sessions/32hex path before linking');
  assert.equal((await api('session',session.data.token)).status,200);
  const response=await api('wallet/challenge',session.data.token,{accountId});assert.equal(response.status,200,JSON.stringify(response.data));const c=response.data.challenge,key=KeyPair.fromRandom('ed25519');
  const signed=await signMessage({signerAccount:{accountId,getSigner:()=>KeyPairSigner.fromSecretKey(key.toString())},payload:{message:c.message,nonce:new Uint8Array(Buffer.from(c.nonce,'base64')),recipient:c.recipient,callbackUrl:c.callbackUrl}});
  const body={challengeId:c.challengeId,accountId,publicKey:signed.publicKey.toString(),signature:Buffer.from(signed.signature).toString('base64')};
  const verified=await api('wallet/verify',session.data.token,body);assert.equal(verified.status,200,JSON.stringify(verified.data));assert.equal((await api('wallet',session.data.token)).data.wallet.accountId,accountId);
  const replay=await api('wallet/verify',session.data.token,body);assert.equal(replay.status,409);assert.equal(replay.data.code,'WALLET_CHALLENGE_USED');
  assert.ok(!JSON.stringify([...b.records.values()]).includes(key.toString()));return{session:verified.data.session,token:session.data.token};
 }
 const buyer=await login('buyer','buyer-blob.testnet'),provider=await login('provider','provider-blob.testnet');
 const job={id:'a'.repeat(32),buyerId:buyer.session.id,buyerWallet:buyer.session.wallet,status:'AWARDED',createdAt:new Date(TIME).toISOString(),taskHash:'b'.repeat(64),programHash:'c'.repeat(64),planSha256:'d'.repeat(64),selectedOffer:{providerId:provider.session.id,paymentAccount:provider.session.wallet.accountId,wallet:provider.session.wallet,amountYocto:'1000000000000000000000'},payment:{kind:WALLET_ESCROW_KIND,network:'testnet',contractId:POLICY.contractId,status:'NOT_FUNDED',awardedAtISO:new Date(TIME).toISOString()}};
 const fund=await escrow.prepare(job,'fund',buyer.session);job.payment=fund.payment;
 const unknown=await escrow.confirm(job,'fund',TX,buyer.session);assert.equal(unknown.status,'UNKNOWN');job.payment=unknown;
 const ctx=escrow.context(job);hold={terms:ctx.terms,binding_hash:ctx.bindingHash,storage_deposit_yocto:'40960000000000000000000',state:'Held',nonce:'0',delivery:null,pending:null,last_transfer_failure_nonce:null};job.payment=await escrow.refresh(job,buyer.session);assert.equal(job.payment.status,'HELD');
 job.status='DELIVERED';job.delivery={version:1,outputSha256:'e'.repeat(64)};const record=await escrow.prepare(job,'record',provider.session);job.payment=record.payment;job.payment=await escrow.refresh(job,provider.session);assert.equal(job.payment.status,'UNKNOWN');
 now=TIME+3*86400000;job.payment=await escrow.refresh(job,buyer.session);assert.equal(job.payment.status,'HELD');assert.equal(job.payment.operation.status,'EXPIRED');
 const markers=[...b.records.entries()].filter(([p,v])=>p.startsWith(ROOT+'wallet/intents/')&&JSON.parse(v).kind==='EXPIRED_RECORD_INTENT');assert.equal(markers.length,1);assert.equal(JSON.parse(markers[0][1]).intentId,record.intent.id);
 const refund=await escrow.prepare(job,'refund',buyer.session);assert.equal(refund.intent.action,'refund');assert.equal(refund.intent.transaction.signerId,buyer.session.wallet.accountId);
 const written=[...b.records.keys()].filter(p=>p.startsWith(ROOT+'wallet/'));
 assert.deepEqual([...new Set(written.map(p=>p.slice((ROOT+'wallet/').length).split('/')[0]))].sort(),['challenges','claims','intents','sessions','transactions']);
 assert.ok(written.every(p=>/^nope-workspace-v1\/wallet\/(?:sessions\/[a-f0-9]{32}|(?:challenges|claims|intents|transactions)\/[a-f0-9]{64})\.json$/.test(p)));
 for(const call of b.calls){if(call.method==='put'){assert.equal(call.options.access,'private');assert.equal(call.options.allowOverwrite,false);assert.equal(call.options.addRandomSuffix,false);}if(call.method==='get'){assert.equal(call.options.access,'private');assert.equal(call.options.useCache,false);}}
});

test('wallet Blob whitelist rejects traversal, wrong IDs, extra suffixes and unknown namespaces before contacting transport',async()=>{
 const b=transport(),root=ROOT+'wallet/',h='a'.repeat(64),id='b'.repeat(32);
 const invalid=[root+'sessions/'+h+'.json',...['challenges','claims','intents','transactions'].map(k=>root+k+'/'+id+'.json'),root+'sessions/'+id.toUpperCase()+'.json',root+'challenges/'+h.toUpperCase()+'.json',root+'sessions/'+id+'.json/extra',root+'claims/'+h+'.json.bak',root+'intents/'+h+'.json?x=1',root+'intents/'+h+'.json\n',root+'challenges/../'+h+'.json',root+'claims/%2e%2e/'+h+'.json',root+'intents//'+h+'.json',root+'transactions/%2f'+h+'.json',root+'keys/'+h+'.json',root+'sessions/anything.json',root+h+'.json',root+'sessions/'+id+'/record.json','nope-workspace-v2/wallet/sessions/'+id+'.json','other-root/wallet/claims/'+h+'.json'];
 for(const path of invalid){await assert.rejects(b.store.read(path),/Invalid path/,path);await assert.rejects(b.store.create(path,{}),/Invalid path/,path);}
 await assert.rejects(b.store.list({prefix:root}),/Invalid listing/);assert.equal(b.calls.length,0,'invalid paths never reach Blob');
});

test('wallet records retain 1MiB/private/immutable bounds and cannot use the legacy task 3MiB allowance',async()=>{
 const b=transport(),path=ROOT+'wallet/intents/'+'a'.repeat(64)+'.json';assert.equal(await b.store.create(path,{version:1}),true);assert.equal(await b.store.create(path,{version:2}),false);assert.deepEqual(await b.store.read(path),{version:1});
 const large={data:'x'.repeat(1024*1024)};await assert.rejects(b.store.create(ROOT+'wallet/claims/'+'b'.repeat(64)+'.json',large),/Record bound/);
 b.records.set(path,JSON.stringify(large));await assert.rejects(b.store.read(path),/Record bound/);
 await assert.rejects(b.store.create(ROOT+'wallet/intents/task.json',{}),/Invalid path/);
 const broken=blobWorkspaceStore({}, {put:async()=>{throw Error('write outcome unknown');},get:async()=>{throw Error('read unavailable');}});await assert.rejects(broken.create(ROOT+'wallet/transactions/'+'c'.repeat(64)+'.json',{}),/read unavailable/);
});
