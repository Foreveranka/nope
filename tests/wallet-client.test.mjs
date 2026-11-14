/** UNIT connector/window/RPC fixtures only. No real wallet login, account funds,
 * chain transaction or finality. NEP-413 signing below is genuine local crypto
 * with a freshly generated synthetic key, never a customer or project key. */
import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash,generateKeyPairSync,sign} from 'node:crypto';
const admission=generateKeyPairSync('ed25519');
const admissionPublicKey=admission.publicKey.export({format:'der',type:'spki'}).subarray(-32).toString('hex');
import fs from 'node:fs/promises';
import vm from 'node:vm';
import {KeyPair,KeyPairSigner,baseEncode} from 'near-api-js';
import {verifyMessage} from 'near-api-js/nep413';
import {createWalletClient} from '../web/wallet-client.mjs';
import {msg} from '../web/i18n.mjs';
import {patchExecutor,patchIntearExecutor} from '../wallet-runtime/sdk-patches.mjs';
const ORIGIN='https://wallet-unit.invalid',DOMAIN='NOPE:WALLET-ESCROW:V2:testnet';
const HASH='b'.repeat(64),JOB='a'.repeat(32),GAS='150000000000000';
const policy={network:'testnet',contractId:'unit-escrow.testnet',codeHash:baseEncode(new Uint8Array(32).fill(9)),domain:DOMAIN,requireKeyless:true,storageDepositYocto:'40960000000000000000000',admissionPublicKey};
const sha=s=>createHash('sha256').update(s).digest('hex');
const canonical=v=>JSON.stringify(v,(_,x)=>x&&typeof x==='object'&&!Array.isArray(x)?Object.fromEntries(Object.keys(x).sort().map(k=>[k,x[k]])):x);
const clone=structuredClone;
class Storage{data=new Map();getItem(k){return this.data.get(k)??null;}setItem(k,v){this.data.set(k,String(v));}removeItem(k){this.data.delete(k);}}
function fixture({ids=['buyer.testnet'],network='testnet',policyOverride=policy,selection}={}){
 const storage=new Storage();storage.setItem('nope.workspace.session.v1','UNIT-UNRELATED-SESSION');
 const win={crypto:globalThis.crypto,sessionStorage:storage,location:new URL(ORIGIN+'/settings'),history:{replaceState(_s,_t,url){win.location=new URL(url);}}};
 const signer=new KeyPairSigner(KeyPair.fromRandom('ed25519'));let accounts=ids.map(accountId=>({accountId}));
 const calls=[];let signatureFormat='base64',responseMode='outcome',messageMode='signed',errorMessage='Network failure';
 const wallet={manifest:{id:'intear-wallet',name:'UNIT CONNECTOR FIXTURE',features:{testnet:true,signMessage:true,signAndSendTransaction:true}},
  async getAccounts(){return clone(accounts);},
  async signMessage(args){calls.push({kind:'message',args:clone(args)});if(messageMode==='redirect')return;const signed=await signer.signNep413Message(args.signerId,args);return {accountId:signed.accountId,publicKey:signed.publicKey.toString(),signature:signatureFormat==='base58'?'ed25519:'+baseEncode(signed.signature):Buffer.from(signed.signature).toString('base64')};},
  async signAndSendTransaction(args){calls.push({kind:'transaction',args:clone(args)});if(responseMode==='throw')throw Error(errorMessage);if(responseMode==='redirect')return;const p=args.actions[0].params;return {transaction:{hash:baseEncode(new Uint8Array(32).fill(4)),signer_id:args.signerId,receiver_id:args.receiverId,actions:[{FunctionCall:{method_name:p.methodName,args:Buffer.from(JSON.stringify(p.args)).toString('base64'),gas:p.gas,deposit:p.deposit}}]}};}
 };
 const connector={availableWallets:[wallet],whenManifestLoaded:Promise.resolve(),setLabels(value){if(!value||!['title','cancel','frameTitle','open','prompt'].every(k=>typeof value[k]==='string'&&value[k].trim()))throw Error('Wallet labels required');calls.push({kind:'labels',args:clone(value)});},selectWallet:async()=>wallet.manifest.id,connect:async args=>{calls.push({kind:'connect',args:clone(args)});return wallet;},disconnect:async()=>{calls.push({kind:'disconnect'});accounts=[];}};
 const client=createWalletClient({window:win,network,policy:policyOverride,connectorFactory:async options=>{assert.deepEqual(options,{network:'testnet',autoConnect:false});return connector;},selectAccount:selection});
 const now=Date.now(),context={version:1,purpose:'NOPE:WALLET-AUTH:V1',network:'testnet',accountId:ids[0],sessionId:'c'.repeat(32),role:'buyer',origin:ORIGIN,challengeId:'d'.repeat(64),nonce:Buffer.alloc(32,3).toString('base64'),issuedAt:new Date(now-1000).toISOString(),expiresAt:new Date(now+299000).toISOString()};
 const challenge={challengeId:context.challengeId,network:'testnet',accountId:ids[0],sessionId:context.sessionId,role:context.role,origin:ORIGIN,nonce:context.nonce,issuedAt:context.issuedAt,expiresAt:context.expiresAt,message:canonical(context),recipient:ORIGIN,callbackUrl:ORIGIN+'/settings'};
 return {client,storage,win,wallet,calls,challenge,setAccounts:v=>{accounts=v.map(accountId=>({accountId}));},signatureAs:v=>{signatureFormat=v;},messageAs:v=>{messageMode=v;},responseAs:(v,e)=>{responseMode=v;if(e)errorMessage=e;}};
}
function prepared(action='fund',accountId=action==='record'?'provider.testnet':'buyer.testnet'){
 const amount='1000000000000000000000000',terms={job_id:JOB,buyer_commitment:'c'.repeat(64),buyer_account:'buyer.testnet',provider:'provider.testnet',amount,input_hash:'d'.repeat(64),program_hash:'e'.repeat(64),plan_hash:'f'.repeat(64),execution_deadline_ns:String(BigInt(Date.now()+86400000)*1000000n),review_deadline_ns:String(BigInt(Date.now()+172800000)*1000000n)};
 const bindingHash=sha(JSON.stringify([DOMAIN,policy.contractId,...Object.values(terms)]));
 const args=action==='fund'?{terms,admission_signature:sign(null,Buffer.from('NOPE:WALLET-ADMISSION:V1\0'+bindingHash),admission.privateKey).toString('hex')}:action==='refund'?{buyer_account:terms.buyer_account,job_id:JOB}:{buyer_account:terms.buyer_account,job_id:JOB,version:2,output_hash:HASH};
 const method={fund:'fund',record:'record_delivery',release:'accept_and_release',refund:'refund'}[action];
 return {intent:{id:'f'.repeat(64),action,network:'testnet',bindingHash,transaction:{signerId:accountId,receiverId:policy.contractId,actions:[{type:'FunctionCall',params:{methodName:method,args,gas:GAS,deposit:action==='fund'?(BigInt(amount)+BigInt(policy.storageDepositYocto)).toString():'0'}}]}},bounds:{action,jobId:JOB,bindingHash,accountId,contractId:policy.contractId,buyerAccount:terms.buyer_account,provider:terms.provider,amountYocto:amount,version:2,outputHash:HASH,expectedArgs:clone(args)}};
}
const code=c=>e=>e?.code===c;
test('UNIT: construction never connects/signs, policy exactly5keys/keyless and testnet only',async()=>{
 const f=fixture();assert.equal(f.calls.length,0);assert.equal(await f.client.currentAccount(),null);
 for(const p of [{...policy,requireKeyless:false},{...policy,rpcUrl:'https://evil.invalid'},{...policy,network:'mainnet'}])await assert.rejects(fixture({policyOverride:p}).client.connect(),code('WALLET_POLICY_DISABLED'));
 await assert.rejects(fixture({network:'mainnet'}).client.connect(),code('WALLET_WRONG_NETWORK'));
 await assert.rejects(fixture({ids:['buyer.near']}).client.connect(),code('WALLET_WRONG_NETWORK'));
 const production=createWalletClient({window:f.win,policy:null});await assert.rejects(production.connect(),code('WALLET_POLICY_DISABLED'));
});
test('UNIT: real i18n message objects become primitive labels accepted by the strict runtime connector guard',async()=>{
 assert.equal(typeof msg('Testnet cüzdanı seç'),'object');
 const f=fixture();assert.equal((await f.client.connect()).accountId,'buyer.testnet');
 await f.client.connect();
 const labels=f.calls.filter(c=>c.kind==='labels');assert.equal(labels.length,2);
 const sources={title:'Testnet cüzdanı seç',cancel:'Cüzdan isteğini iptal et',frameTitle:'Testnet cüzdan bağlantısı',open:'Cüzdanı aç',prompt:'Devam etmek için cüzdanını aç.'};
 for(const call of labels)for(const [key,source]of Object.entries(sources)){assert.equal(typeof call.args[key],'string');assert.equal(call.args[key],String(msg(source)));}
 assert.equal(f.calls.filter(c=>c.kind==='message'||c.kind==='transaction').length,0);
});
test('UNIT: account selection explicit, never silently first; account switches reject',async()=>{
 const multi=fixture({ids:['buyer.testnet','second.testnet']});await assert.rejects(multi.client.connect(),code('WALLET_ACCOUNT_SELECTION_REQUIRED'));
 assert.equal((await multi.client.connect({accountId:'second.testnet'})).accountId,'second.testnet');
 multi.setAccounts(['third.testnet']);await assert.rejects(multi.client.currentAccount(),code('WALLET_ACCOUNT_SELECTION_REQUIRED'));
});
test('UNIT + REAL LOCAL NEP413 crypto: exact server nonce/message/recipient/callback verified independently',async()=>{
 const f=fixture();await f.client.connect();const result=await f.client.signChallenge(f.challenge);
 assert.deepEqual(Object.keys(result).sort(),['accountId','challengeId','publicKey','signature']);assert.equal(result.accountId,'buyer.testnet');
 const payload={message:f.challenge.message,nonce:Buffer.from(f.challenge.nonce,'base64'),recipient:f.challenge.recipient,callbackUrl:f.challenge.callbackUrl};
 await verifyMessage({signerAccountId:result.accountId,signerPublicKey:result.publicKey,payload,signature:Buffer.from(result.signature,'base64'),provider:{viewAccessKey:async()=>({permission:'FullAccess'})}});
 await assert.rejects(verifyMessage({signerAccountId:result.accountId,signerPublicKey:result.publicKey,payload:{...payload,callbackUrl:undefined},signature:Buffer.from(result.signature,'base64'),provider:{viewAccessKey:async()=>({permission:'FullAccess'})}}));
 const passed=f.calls.find(c=>c.kind==='message').args;assert.equal(passed.message,f.challenge.message);assert.deepEqual(passed.nonce,new Uint8Array(Buffer.from(f.challenge.nonce,'base64')));assert.equal(passed.callbackUrl,f.challenge.callbackUrl);
 assert.equal(f.storage.getItem('nope.workspace.session.v1'),'UNIT-UNRELATED-SESSION');assert.equal(f.storage.getItem('nope.wallet.client.v1.pending'),null);
});
test('UNIT: base58 Ed25519 signatures normalize to backendcanonicalbase64',async()=>{
 const f=fixture();f.signatureAs('base58');await f.client.connect();const result=await f.client.signChallenge(f.challenge);assert.equal(Buffer.from(result.signature,'base64').length,64);assert.equal(Buffer.from(result.signature,'base64').toString('base64'),result.signature);
});
test('UNIT: altered/expired/chosen-account challenge blocked before SDK signing',async()=>{
 for(const mutate of [c=>c.network='mainnet',c=>c.recipient='https://evil.invalid',c=>c.callbackUrl=ORIGIN+'/elsewhere',c=>c.accountId='other.testnet',c=>c.nonce='bad',c=>c.message+=' ',c=>c.expiresAt=new Date(Date.now()-1000).toISOString(),c=>c.extra=true]){
  const f=fixture();await f.client.connect();const c=clone(f.challenge);mutate(c);await assert.rejects(f.client.signChallenge(c));assert.equal(f.calls.filter(c=>c.kind==='message').length,0);
 }
});
test('UNIT transaction seam: exact4methods/funder/provider/zero-otherdeposit and unchanged JSONbytes',async()=>{
 for(const action of ['fund','record','release','refund']){const {intent,bounds}=prepared(action);const f=fixture({ids:[bounds.accountId]});await f.client.connect();const original=JSON.stringify(intent);const result=await f.client.sendTransaction(intent,bounds);assert.equal(result.transactionHash,baseEncode(new Uint8Array(32).fill(4)));assert.equal(JSON.stringify(intent),original);const sent=f.calls.find(c=>c.kind==='transaction').args;assert.equal(JSON.stringify(sent.actions),JSON.stringify(intent.transaction.actions));assert.equal(sent.signerId,bounds.accountId);assert.equal(sent.receiverId,bounds.contractId);assert.equal(sent.network,'testnet');assert.equal(new URL(sent.callbackUrl).searchParams.get('state'),intent.id);assert.equal(Object.hasOwn(result,'verified'),false);assert.equal(Object.hasOwn(result,'status'),false);}
});
test('UNIT: buyer recovery record accepts the exact buyer while preserving immutable delivery args bytes',async()=>{
 const {intent,bounds}=prepared('record','buyer.testnet'),f=fixture();await f.client.connect();
 const approved=JSON.stringify(intent.transaction.actions),args=JSON.stringify(intent.transaction.actions[0].params.args);
 assert.ok((await f.client.sendTransaction(intent,bounds)).transactionHash);
 const sent=f.calls.find(c=>c.kind==='transaction').args;
 assert.equal(sent.signerId,bounds.buyerAccount);assert.equal(JSON.stringify(sent.actions),approved);
 assert.equal(JSON.stringify(sent.actions[0].params.args),args);assert.equal(sent.actions[0].params.deposit,'0');
});
test('UNIT: buyer recovery record rejects other signers or changed bounds and never grants provider payout rights',async()=>{
 const variants=[
  {signer:'stranger.testnet',mutate:()=>{}},
  {signer:'buyer.testnet',mutate:x=>x.intent.transaction.signerId='provider.testnet'},
  {signer:'buyer.testnet',mutate:x=>x.bounds.buyerAccount='other-buyer.testnet'},
  {signer:'buyer.testnet',mutate:x=>x.bounds.provider='provider.near'},
  {signer:'buyer.testnet',mutate:x=>delete x.bounds.provider},
  {signer:'buyer.testnet',mutate:x=>x.intent.transaction.actions[0].params.args.job_id='0'.repeat(32)},
  {signer:'buyer.testnet',mutate:x=>x.intent.transaction.actions[0].params.args.version++},
  {signer:'buyer.testnet',mutate:x=>x.intent.transaction.actions[0].params.args.output_hash='0'.repeat(64)},
  {signer:'buyer.testnet',mutate:x=>x.intent.transaction.actions[0].params.deposit='1'}
 ];
 for(const {signer,mutate}of variants){const x=prepared('record',signer),f=fixture({ids:[signer]});await f.client.connect();mutate(x);await assert.rejects(f.client.sendTransaction(x.intent,x.bounds),code('WALLET_INVALID_INTENT'));assert.equal(f.calls.filter(c=>c.kind==='transaction').length,0);assert.equal(f.storage.getItem('nope.wallet.client.v1.pending'),null);}
 for(const action of ['fund','release','refund']){const x=prepared(action,'provider.testnet'),f=fixture({ids:['provider.testnet']});await f.client.connect();await assert.rejects(f.client.sendTransaction(x.intent,x.bounds),code('WALLET_INVALID_INTENT'));assert.equal(f.calls.filter(c=>c.kind==='transaction').length,0);}
});
test('UNIT: arbitraryactions/receivers/amounts/args/roles/deposits/gas rejected without signing',async()=>{
 const mutations=[x=>x.intent.transaction.receiverId='evil.testnet',x=>x.intent.network='mainnet',x=>x.intent.transaction.signerId='other.testnet',x=>x.intent.transaction.actions.push(clone(x.intent.transaction.actions[0])),x=>x.intent.transaction.actions[0].type='Transfer',x=>x.intent.transaction.actions[0].params.methodName='delete_account',x=>x.intent.transaction.actions[0].params.gas='300000000000000',x=>x.intent.transaction.actions[0].params.deposit='0',x=>x.intent.transaction.actions[0].params.args.terms.amount='1000000000000000000000001',x=>x.intent.transaction.actions[0].params.args.terms.input_hash='0'.repeat(64),x=>x.intent.transaction.actions[0].params.args.terms.extra='private',x=>x.bounds.expectedArgs.terms.job_id='0'.repeat(32),x=>x.bounds.buyerAccount='other.testnet'];
 for(const mutate of mutations){const f=fixture(),x=prepared();await f.client.connect();mutate(x);await assert.rejects(f.client.sendTransaction(x.intent,x.bounds));assert.equal(f.calls.filter(c=>c.kind==='transaction').length,0);}
 for(const action of ['record','release','refund']){const x=prepared(action),f=fixture({ids:[x.bounds.accountId]});await f.client.connect();x.intent.transaction.actions[0].params.deposit='1';await assert.rejects(f.client.sendTransaction(x.intent,x.bounds));assert.equal(f.calls.filter(c=>c.kind==='transaction').length,0);}
});
test('UNIT: arguments snapshotted before async account lookup; no duplicate sends afterunknown/closed',async()=>{
 const f=fixture();await f.client.connect();const x=prepared();const pending=f.client.sendTransaction(x.intent,x.bounds);x.intent.transaction.actions[0].params.deposit='999';const result=await pending;assert.ok(result.transactionHash);assert.equal(f.calls.find(c=>c.kind==='transaction').args.actions[0].params.deposit,(BigInt(x.bounds.amountYocto)+BigInt(policy.storageDepositYocto)).toString());
 const unknown=fixture();await unknown.client.connect();unknown.responseAs('throw','User rejected the transaction');const a=prepared();await assert.rejects(unknown.client.sendTransaction(a.intent,a.bounds),code('WALLET_TRANSACTION_UNKNOWN'));assert.ok(unknown.storage.getItem('nope.wallet.client.v1.pending'));await assert.rejects(unknown.client.sendTransaction(a.intent,a.bounds),code('WALLET_PENDING_OPERATION'));assert.equal(unknown.calls.filter(c=>c.kind==='transaction').length,1);
});
test('UNIT: wallet cannot mutate the approved transaction used to check its returned outcome',async()=>{
 const f=fixture();await f.client.connect();const original=f.wallet.signAndSendTransaction;
 f.wallet.signAndSendTransaction=async args=>{args.actions[0].params.methodName='delete_account';return original(args);};
 const x=prepared();await assert.rejects(f.client.sendTransaction(x.intent,x.bounds),code('WALLET_TRANSACTION_UNKNOWN'));
 assert.equal(x.intent.transaction.actions[0].params.methodName,'fund');assert.ok(f.storage.getItem('nope.wallet.client.v1.pending'));
});
test('UNIT redirectfixture: publicpending survives reload, callback scrubbed, no auto signing/finality',async()=>{
 const f=fixture();await f.client.connect();f.responseAs('redirect');const {intent,bounds}=prepared();assert.deepEqual(await f.client.sendTransaction(intent,bounds),{redirected:true,intentId:intent.id});
 const publicPending=JSON.parse(f.storage.getItem('nope.wallet.client.v1.pending'));for(const k of ['token','sessionId','secretKey','signature','privateKey'])assert.equal(Object.hasOwn(publicPending,k),false);
 const hash=baseEncode(new Uint8Array(32).fill(4));f.win.location=new URL(ORIGIN+'/settings?state='+intent.id+'&transactionHashes='+hash);
 const count=f.calls.length;const result=await f.client.completeRedirect();assert.deepEqual(result,{kind:'transaction',intentId:intent.id,transactionHash:hash});assert.equal(f.calls.length,count);assert.equal(f.win.location.search,'');assert.equal(f.storage.getItem('nope.workspace.session.v1'),'UNIT-UNRELATED-SESSION');
});
test('UNIT callbackfixture: challenge account/state/signature strict; malformedduplicates scrub too',async()=>{
 const f=fixture();await f.client.connect();f.messageAs('redirect');assert.deepEqual(await f.client.signChallenge(f.challenge),{redirected:true,challengeId:f.challenge.challengeId});
 const signer=new KeyPairSigner(KeyPair.fromRandom('ed25519')),signed=await signer.signNep413Message('buyer.testnet',{message:f.challenge.message,nonce:Buffer.from(f.challenge.nonce,'base64'),recipient:ORIGIN,callbackUrl:f.challenge.callbackUrl});
 f.win.location=new URL(ORIGIN+'/settings#'+new URLSearchParams({state:f.challenge.challengeId,accountId:'buyer.testnet',publicKey:signed.publicKey.toString(),signature:Buffer.from(signed.signature).toString('base64')}));
 assert.equal((await f.client.completeRedirect()).result.accountId,'buyer.testnet');assert.equal(f.win.location.hash,'');
 f.win.location=new URL(ORIGIN+'/settings?signature=bad&signature=bad');await assert.rejects(f.client.completeRedirect(),code('WALLET_CALLBACK_INVALID'));assert.equal(f.win.location.search,'');
});
test('UNIT: expired challenge can restart; transaction error callbacks never clear unknown pending',async()=>{
 const f=fixture();await f.client.connect();f.messageAs('redirect');await f.client.signChallenge(f.challenge);
 const key='nope.wallet.client.v1.pending',expired=JSON.parse(f.storage.getItem(key));expired.expiresAt=Date.now()-1;f.storage.setItem(key,JSON.stringify(expired));
 f.win.location=new URL(ORIGIN+'/settings?state='+f.challenge.challengeId+'&errorCode=expired');
 await assert.rejects(f.client.completeRedirect(),code('WALLET_CALLBACK_INVALID'));assert.equal(f.storage.getItem(key),null);assert.equal(f.win.location.search,'');
 f.messageAs('signed');assert.ok((await f.client.signChallenge(f.challenge)).signature);
 const x=prepared();f.responseAs('redirect');await f.client.sendTransaction(x.intent,x.bounds);const pending=f.storage.getItem(key);
 f.win.location=new URL(ORIGIN+'/settings?state='+('0'.repeat(64))+'&errorCode=rejected');
 await assert.rejects(f.client.completeRedirect(),code('WALLET_CALLBACK_INVALID'));assert.equal(f.storage.getItem(key),pending);
 f.win.location=new URL(ORIGIN+'/settings?state='+x.intent.id+'&errorCode=rejected');
 await assert.rejects(f.client.completeRedirect(),code('WALLET_TRANSACTION_UNKNOWN'));assert.equal(f.storage.getItem(key),pending);
 const past=JSON.parse(pending);past.expiresAt=Date.now()-1;f.storage.setItem(key,JSON.stringify(past));
 await assert.rejects(f.client.sendTransaction(x.intent,x.bounds),code('WALLET_PENDING_OPERATION'));assert.equal(f.calls.filter(c=>c.kind==='transaction').length,1);
});
test('UNIT: disconnect only clears adapter keys and wallet state, never workspace session',async()=>{
 const f=fixture();await f.client.connect();await f.client.disconnect();assert.equal(await f.client.currentAccount(),null);assert.equal(f.storage.getItem('nope.workspace.session.v1'),'UNIT-UNRELATED-SESSION');assert.equal(f.storage.getItem('nope.wallet.client.v1.account'),null);
});
function emitter(){const m=new Map();return {addEventListener(k,fn){m.set(k,[...(m.get(k)||[]),fn]);},removeEventListener(k,fn){m.set(k,(m.get(k)||[]).filter(f=>f!==fn));},emit(k,event){for(const fn of [...(m.get(k)||[])])fn(event);}};}
function element(tag){return {...emitter(),tag,contentWindow:tag==='iframe'?{postMessage(){}}:undefined,children:[],attrs:{},append(...nodes){this.children.push(...nodes);},setAttribute(k,v){this.attrs[k]=v;},remove(){this.removed=true;},showModal(){this.open=true;},close(){this.open=false;}};}
test('UNIT published SDK transformed by actual bundler: result source/cap/protocol/method/id/status cannot be spoofed',async()=>{
 const w=emitter(),frames=[];let sequence=0;
 class Frame{constructor(){this.origin='c'.repeat(64);this.iframe={contentWindow:{}};this.readyPromise=Promise.resolve();this.handlers={};frames.push(this);}on(k,fn){this.handlers[k]=fn;}postMessage(d){this.request=d;}dispose(){this.disposed=true;}}
 const exports={};const source=patchExecutor(await fs.readFile(new URL('../wallet-runtime/node_modules/@hot-labs/near-connect/build/SandboxedWallet/executor.js',import.meta.url),'utf8'));
 vm.runInNewContext(source,{exports,window:w,require:name=>name==='./iframe'?Frame:name==='../helpers/uuid'?{uuid4:()=>String(++sequence).padStart(32,'a')}:name==='../helpers/url'?{parseUrl:s=>new URL(s)}:{},URL,console});
 const executor=new exports.default({}, {id:'intear-wallet'});let resolved=false;const pending=executor.call('wallet:getAccounts',{network:'testnet'}).then(v=>{resolved=true;return v;});
 await new Promise(r=>setImmediate(r));const frame=frames[0],message={source:frame.iframe.contentWindow,origin:'null',data:{protocol:'NOPE:WALLET:FRAME:V1',origin:frame.origin,method:'getAccounts',id:frame.request.id,status:'success',result:[]}};
 for(const change of [e=>e.source={},e=>e.origin=ORIGIN,e=>e.data.protocol='wrong',e=>e.data.origin='d'.repeat(64),e=>e.data.method='signMessage',e=>e.data.id='wrong',e=>e.data.status='ready']){const e={...message,data:{...message.data}};change(e);w.emit('message',e);await Promise.resolve();assert.equal(resolved,false);assert.equal(frame.disposed,undefined);}
 w.emit('message',message);assert.deepEqual(await pending,[]);assert.equal(frame.disposed,true);
 const closed=executor.call('wallet:signMessage',{});await new Promise(r=>setImmediate(r));frames[1].handlers.close();await assert.rejects(closed,/Wallet closed/);
});
test('UNIT actual iframe transport: only null-origin exactframe+cap+method accepted; opaque sandbox retained',async()=>{
 const {default:Iframe}=await import('../wallet-runtime/iframe-executor.mjs');const oldW=globalThis.window,oldD=globalThis.document;
 const w={...emitter(),location:new URL(ORIGIN+'/settings')},d={createElement:element,body:element('body')};globalThis.window=w;globalThis.document=d;
 try{const seen=[];const frame=new Iframe({connector:{__nopeLabels:{frameTitle:'UNIT Frame',cancel:'UNIT Cancel'}},getAllStorage:async()=>({}),manifest:{id:'intear-wallet'}},'',(_f,e)=>seen.push(e));
  assert.equal(frame.iframe.attrs.sandbox,'allow-scripts allow-popups allow-popups-to-escape-sandbox');assert.equal(frame.iframe.attrs.sandbox.includes('allow-same-origin'),false);assert.match(frame.origin,/^[0-9a-f]{64}$/);
  const msg={source:frame.iframe.contentWindow,origin:'null',data:{protocol:'NOPE:WALLET:FRAME:V1',origin:frame.origin,id:'a'.repeat(64),method:'storage.get',params:{key:'UNIT'}}};
  for(const change of [e=>e.source={},e=>e.origin=ORIGIN,e=>e.data.origin='b'.repeat(64),e=>e.data.method='external',e=>e.data.protocol='wrong',e=>e.data.id='invalid']){const e={...msg,data:{...msg.data}};change(e);w.emit('message',e);}
  assert.equal(seen.length,0);w.emit('message',msg);assert.equal(seen.length,1);frame.dispose();w.emit('message',msg);assert.equal(seen.length,1);
 }finally{globalThis.window=oldW;globalThis.document=oldD;}
});
test('UNIT actual static child bridge: parent source+origin+cap, expected method and message type protected',async()=>{
 const e=emitter(),parent={posts:[],postMessage(data,origin){this.posts.push({data,origin});}},document={title:'',getElementById:()=>element('div'),createElement:element};
 const child={...e,parent,location:new URL(ORIGIN+'/wallet-runtime/bridge.html')};let accountCalls=0;
 const fakeWallet={near:{walletUrl:'https://wallet.intear.tech',requestConnection:async()=>null},getAccounts:async()=>{accountCalls++;return[];}};
 const context=vm.createContext({window:child,document,URL,crypto:globalThis.crypto,Uint8Array,Error,Map,WeakMap,console,__loadPinnedExecutor:async()=>child.selector.ready(fakeWallet)});
 const source=(await fs.readFile(new URL('../wallet-runtime/bridge.mjs',import.meta.url),'utf8')).replace("await import('./intear-executor.js');","await globalThis.__loadPinnedExecutor();");vm.runInContext(source,context);
 const cap='a'.repeat(64),config={protocol:'NOPE:WALLET:FRAME:V1',type:'initialize',origin:cap,parentOrigin:ORIGIN,location:ORIGIN+'/settings',storage:{},manifest:{id:'intear-wallet'},labels:{title:'UNIT',cancel:'UNIT',frameTitle:'UNIT',open:'UNIT',prompt:'UNIT'}};
 child.emit('message',{source:{},origin:ORIGIN,data:config});child.emit('message',{source:parent,origin:'https://evil.invalid',data:config});assert.equal(child.selector,undefined);
 child.emit('message',{source:parent,origin:ORIGIN,data:config});await new Promise(r=>setImmediate(r));assert.equal(parent.posts[0].data.method,'wallet-ready');assert.equal(parent.posts[0].origin,ORIGIN);
 const msg={source:parent,origin:ORIGIN,data:{protocol:config.protocol,origin:cap,id:'b'.repeat(64),method:'wallet:getAccounts',params:{network:'testnet'}}};
 for(const change of [x=>x.source={},x=>x.origin='null',x=>x.data.origin='c'.repeat(64),x=>x.data.protocol='wrong']){const x={...msg,data:{...msg.data}};change(x);child.emit('message',x);}
 await new Promise(r=>setImmediate(r));assert.equal(accountCalls,0);child.emit('message',msg);await new Promise(r=>setImmediate(r));assert.equal(accountCalls,1);
 child.emit('message',{...msg,data:{...msg.data,method:'wallet:deleteAccount'}});await new Promise(r=>setImmediate(r));assert.equal(accountCalls,1);assert.equal(parent.posts.at(-1).data.status,'failed');
 let resolved=false;const pending=child.selector.storage.get('UNIT').then(()=>{resolved=true;});const request=parent.posts.at(-1).data;
 child.emit('message',{source:parent,origin:ORIGIN,data:{...request,method:'storage.set',status:'success',result:'wrong'}});await new Promise(r=>setImmediate(r));assert.equal(resolved,false);
 child.emit('message',{source:parent,origin:ORIGIN,data:{...request,status:'success',result:null}});await pending;assert.equal(resolved,true);
});
test('UNIT pinned official Intear executor + actual bridge: popup URL/network/NEP413 state/transaction bytes survive separate frames', {timeout:5000},async()=>{
 // No wallet, network request or signing. Pinned source uses the packaging patch;
 // transport-key crypto and remote popup responses are explicitly UNIT stubs.
 const upstream=await fs.readFile(new URL('../wallet-runtime/intear-executor.upstream.js',import.meta.url),'utf8');
 assert.equal(sha(upstream),'6decc283352af197feff4988628899d19e05f4168a4277fe699bd8a0d6178e34');
 const bridge=(await fs.readFile(new URL('../wallet-runtime/bridge.mjs',import.meta.url),'utf8')).replace("await import('./intear-executor.js');","await globalThis.__loadPinnedExecutor();");
 const storage=new Map(),opened=[],sent=[],timers=new Set();let frameNumber=0;
 const transportCrypto={getRandomValues:b=>crypto.getRandomValues(b),subtle:{
  generateKey:async()=>({publicKey:'UNIT-TRANSPORT-PUBLIC',privateKey:'UNIT-TRANSPORT-NOT-A-REAL-KEY'}),
  exportKey:async format=>format==='raw'?new Uint8Array(32).fill(1).buffer:{x:'AQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQE',d:'UNIT-NOT-A-REAL-KEY'},
  importKey:async()=> 'UNIT-TRANSPORT-NOT-A-REAL-KEY',digest:async()=>new Uint8Array(32).buffer,sign:async()=>new Uint8Array(64).buffer
 }};
 async function frame(){
  const child={...emitter(),location:new URL(ORIGIN+'/wallet-runtime/bridge.html')},cap=String(++frameNumber).padStart(64,'a');let context,ready;
  const loaded=new Promise(resolve=>{ready=resolve;});
  const deliver=data=>setImmediate(()=>child.emit('message',{source:parent,origin:ORIGIN,data:{...data,protocol:'NOPE:WALLET:FRAME:V1',origin:cap}}));
  const parent={postMessage(data,target){assert.equal(target,ORIGIN);
   if(data.method==='wallet-ready'){ready();return;}
   let result=null;
   if(data.method==='storage.get')result=storage.get(data.params.key)??null;
   else if(data.method==='storage.set')storage.set(data.params.key,data.params.value);
   else if(data.method==='storage.remove')storage.delete(data.params.key);
   else if(data.method==='storage.keys')result=[...storage.keys()];
   else if(data.method==='open'){opened.push(data.params.url);result='UNIT-POPUP-'+opened.length;setImmediate(()=>deliver({type:'ready'}));}
   else if(data.method==='panel.postMessage'){
    const message=clone(data.params.data);sent.push(message);
    if(message.type==='signIn')deliver({type:'connected',accountId:'buyer.testnet',walletUrl:'https://wallet.intear.tech',useBridge:false});
    else if(message.type==='signMessage')deliver({type:'signed',signature:{accountId:'buyer.testnet',publicKey:'ed25519:UNIT',signature:'UNIT-NOT-A-SIGNATURE',state:JSON.parse(message.data.message).state}});
    else if(message.type==='signAndSendTransactions')deliver({type:'sent',outcomes:[{unitOutcome:true}]});
    else assert.fail('Unexpected popup message '+message.type);
   }else assert.ok(['panel.close','panel.focus','ui.showIframe','ui.hideIframe'].includes(data.method),data.method);
   deliver({...data,status:'success',result});
  }};
  child.parent=parent;
  context=vm.createContext({window:child,document:{title:''},URL,crypto:transportCrypto,Uint8Array,TextEncoder,atob,btoa,console:{error(){}},
   setInterval(fn,ms){const id=setInterval(fn,ms);timers.add(id);return id;},clearInterval(id){clearInterval(id);timers.delete(id);},
   __loadPinnedExecutor:async()=>vm.runInContext(patchIntearExecutor(upstream),context)});
  vm.runInContext(bridge,context);
  child.emit('message',{source:parent,origin:ORIGIN,data:{protocol:'NOPE:WALLET:FRAME:V1',type:'initialize',origin:cap,parentOrigin:ORIGIN,manifest:{id:'intear-wallet'},labels:{title:'UNIT',cancel:'UNIT',frameTitle:'UNIT',open:'UNIT',prompt:'UNIT'}}});
  await loaded;return child.selector.wallet;
 }
 try{
  const login=await frame();assert.deepEqual(JSON.parse(JSON.stringify(await login.signIn({network:'testnet'}))),[{accountId:'buyer.testnet'}]);
  assert.equal(opened[0],'https://wallet.intear.tech/connect');assert.equal(sent[0].data.networkId,'testnet');assert.equal(sent[0].data.version,'V3');
  assert.deepEqual(JSON.parse(sent[0].data.message),{});for(const key of ['contractId','methodNames','gasAllowance'])assert.equal(sent[0].data[key],undefined);
  const sign=await frame(),state='a'.repeat(64),nonce=new Uint8Array(32).fill(3);
  const signed=await sign.signMessage({network:'testnet',signerId:'buyer.testnet',message:'UNIT exact server challenge',nonce,recipient:ORIGIN,callbackUrl:ORIGIN+'/settings',state});
  assert.equal(signed.state,state);assert.equal(opened[1],'https://wallet.intear.tech/sign-message');
  assert.deepEqual(JSON.parse(sent[1].data.message),{message:'UNIT exact server challenge',nonce:[...nonce],recipient:ORIGIN,callbackUrl:ORIGIN+'/settings',state});
  const tx=await frame(),x=prepared('fund'),approved=JSON.stringify(x.intent.transaction.actions);
  assert.equal((await tx.signAndSendTransaction({...x.intent.transaction,network:'testnet'})).unitOutcome,true);
  assert.equal(opened[2],'https://wallet.intear.tech/send-transactions');assert.equal(sent[2].data.mode,'Send');
  const transactions=JSON.parse(sent[2].data.transactions);assert.equal(transactions.length,1);assert.equal(JSON.stringify(transactions[0].actions),approved);
  assert.equal(transactions[0].signerId,'buyer.testnet');assert.equal(transactions[0].receiverId,policy.contractId);
  const count=opened.length,closed=await frame();assert.deepEqual(JSON.parse(JSON.stringify(await closed.signIn({network:'mainnet'}))),[]);assert.equal(opened.length,count);
  await assert.rejects(sign.signMessage({network:'mainnet',signerId:'buyer.testnet'}),/Wallet account changed/);assert.equal(opened.length,count);
 }finally{for(const id of timers)clearInterval(id);}
});

test('admission signature is verified before any wallet transaction, binds exact terms and pinned key',async()=>{
 for(const change of [p=>delete p.intent.transaction.actions[0].params.args.admission_signature,p=>p.intent.transaction.actions[0].params.args.admission_signature='00'.repeat(64),p=>{const a=p.intent.transaction.actions[0].params.args;a.terms.review_deadline_ns=String(BigInt(a.terms.review_deadline_ns)+1n);p.intent.bindingHash=sha(JSON.stringify([DOMAIN,policy.contractId,...Object.values(a.terms)]));p.bounds.bindingHash=p.intent.bindingHash;p.bounds.expectedArgs=clone(a);}]){
  const f=fixture();await f.client.connect();const p=prepared();change(p);await assert.rejects(f.client.sendTransaction(p.intent,p.bounds));assert.equal(f.calls.filter(c=>c.kind==='transaction').length,0);
 }
 const f=fixture({policyOverride:{...policy,admissionPublicKey:generateKeyPairSync('ed25519').publicKey.export({format:'der',type:'spki'}).subarray(-32).toString('hex')}});await f.client.connect();const p=prepared();await assert.rejects(f.client.sendTransaction(p.intent,p.bounds));assert.equal(f.calls.filter(c=>c.kind==='transaction').length,0);
});


test('V2 requires exact price plus retained storage at both price bounds; rejects price-only, overpayment and missing policy',async()=>{
 for(const amount of ['1','1000000000000000000000000']){
  const p=prepared(),a=p.intent.transaction.actions[0].params;
  a.args.terms.amount=amount;p.bounds.amountYocto=amount;
  p.intent.bindingHash=sha(JSON.stringify([DOMAIN,policy.contractId,...Object.values(a.args.terms)]));p.bounds.bindingHash=p.intent.bindingHash;
  a.args.admission_signature=sign(null,Buffer.from('NOPE:WALLET-ADMISSION:V1\0'+p.intent.bindingHash),admission.privateKey).toString('hex');
  p.bounds.expectedArgs=clone(a.args);a.deposit=(BigInt(amount)+BigInt(policy.storageDepositYocto)).toString();
  const good=fixture();await good.client.connect();assert.ok((await good.client.sendTransaction(p.intent,p.bounds)).transactionHash);
  for(const wrong of [amount,(BigInt(a.deposit)-1n).toString(),(BigInt(a.deposit)+1n).toString()]){
   const f=fixture();await f.client.connect();const bad=clone(p);bad.intent.transaction.actions[0].params.deposit=wrong;
   await assert.rejects(f.client.sendTransaction(bad.intent,bad.bounds));assert.equal(f.calls.filter(x=>x.kind==='transaction').length,0);
  }
 }
 for(const amount of [undefined,'0','040960000000000000000000','40960000000000000000001']){
  const p={...policy};if(amount===undefined)delete p.storageDepositYocto;else p.storageDepositYocto=amount;
  await assert.rejects(fixture({policyOverride:p}).client.connect(),code('WALLET_POLICY_DISABLED'));
 }
});
