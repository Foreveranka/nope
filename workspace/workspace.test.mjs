import test from 'node:test';
import assert from 'node:assert/strict';
import {randomBytes,generateKeyPairSync} from 'node:crypto';
import {Readable} from 'node:stream';
import {createServer} from 'node:http';
import {createWorkspace,quoteCommitment,sha} from './core.mjs';
import {blobWorkspaceStore,ROOT} from './blob.mjs';
import {paymentVerifier,RPC,testnetAccount} from './payment.mjs';
import {createWorkspaceHandler} from '../api/workspace.mjs';
import {createGarbledJob} from '../web/gc-client.mjs';
import {createVault,quoteCommitment as vaultCommitment,randomSalt} from '../web/workspace-vault.mjs';
import {hashRequest,hashOutput,hashProgram} from '../web/gc-core.mjs';
const ORIGIN='http://localhost:8712',env={NOPE_WORKSPACE_ORIGIN:ORIGIN};
// Synthetic-only immutable storage substitute. This does not claim live Blob persistence.
class Store{
 records=new Map();
 async read(p){return structuredClone(this.records.get(p)??null);}
 async create(p,v){if(this.records.has(p))return false;this.records.set(p,structuredClone(v));return true;}
 async list({prefix,limit,cursor}){const keys=[...this.records.keys()].filter(k=>k.startsWith(prefix)).sort(),n=Number(cursor||0);return {pathnames:keys.slice(n,n+limit),cursor:n+limit<keys.length?String(n+limit):null};}
}
const pub=generateKeyPairSync('rsa',{modulusLength:2048}).publicKey.export({format:'jwk'});
let fixture;
async function setup(options={}){
 const store=options.store||new Store();let time=Date.parse('2026-11-12T10:00:00.000Z');
 const handle=createWorkspace({store,env,now:()=>time,...options});
 async function call(path,{who,method='GET',body,headers={},origin=ORIGIN,cookie}={}){
  const h={...(origin?{origin}:{}),...(who?{authorization:`Bearer ${who.token}`} : {}),...(cookie?{cookie}:{}),...headers};if(body!==undefined)h['content-type']='application/json';
  const r=await handle(new Request(ORIGIN+'/api/workspace'+path,{method,headers:h,...(body!==undefined?{body:typeof body==='string'?body:JSON.stringify(body)}:{})}));return {status:r.status,data:await r.json(),headers:r.headers};
 }
 async function session(role,name=role,cookie){const r=await call('/session',{method:'POST',body:{role,displayName:name,...(role==='provider'?{paymentAccount:name+'.testnet'}:{})},cookie});assert.equal(r.status,201,JSON.stringify(r.data));return {...r.data,cookie:r.headers.get('set-cookie').split(';')[0]};}
 const buyer=await session('buyer'),provider=await session('provider'),outsider=await session('provider','outsider'),otherBuyer=await session('buyer','other');
 fixture??=await createGarbledJob([42,255]);
 const body={jobId:randomBytes(16).toString('hex'),title:'Synthetic job',description:'Synthetic public description',deadlineISO:'2026-11-13T10:00:00.000Z',profile:'nope-csv-gc-v1',rowCount:2,task:fixture.request,buyerPublicKey:pub};
 const create=()=>call('/jobs',{who:buyer,method:'POST',body});
 const envelope={wrappedKey:randomBytes(256).toString('base64'),iv:randomBytes(12).toString('base64'),ciphertext:randomBytes(80).toString('base64')};
 const amountYocto='1000000000000000000000000',salt=randomBytes(32).toString('hex');
 const post=(action,b={},who=buyer)=>call(`/jobs/${body.jobId}/${action}`,{who,method:'POST',body:b});
 const offer=()=>post('offers',{envelope,commitment:quoteCommitment(body.jobId,provider.session.id,amountYocto,salt)},provider);
 async function award(){assert.equal((await create()).status,201);assert.equal((await offer()).status,200);const closed=await post('close');assert.equal(closed.status,200);const offerId=closed.data.job.offers[0].id;const r=await post('award',{offerId,amountYocto,salt});assert.equal(r.status,200);return r;}
 return {store,handle,call,session,buyer,provider,outsider,otherBuyer,body,create,post,offer,award,amountYocto,salt,envelope,setTime:t=>{time=t;}};
}
test('sessions store only bearer hashes; native GET without Origin works; role/schema/origin guards',async()=>{
 const f=await setup();assert.equal((await f.call('/session',{who:f.buyer,origin:null})).status,200);
 assert.equal((await f.call('/session',{who:f.buyer,origin:'https://evil.invalid'})).status,403);
 assert.equal((await f.call('/session',{who:f.buyer,origin:null,headers:{'sec-fetch-site':'cross-site'}})).status,403);
 assert.equal((await f.call('/session')).status,401);
 assert.equal((await f.call('/session',{method:'POST',origin:null,body:{role:'buyer',displayName:'X'}})).status,403);
 assert.equal((await f.call('/session',{method:'POST',body:{role:'buyer',displayName:'X',privateKey:'NO'}})).status,400);
 assert.equal((await f.call('/session',{method:'DELETE'})).status,405);
 assert.equal((await f.call('/jobs',{method:'POST',who:f.provider,body:f.body})).status,403);
 const serialized=JSON.stringify([...f.store.records]);assert.ok(!serialized.includes(f.buyer.token));assert.ok(!serialized.includes(f.buyer.cookie.split('=')[1]));
 assert.ok([...f.store.records.keys()].includes(ROOT+'sessions/'+sha(f.buyer.token)+'.json'));
});
test('client-chosen creation is idempotent with canonical keys, including concurrent retries; no overwrite',async()=>{
 const f=await setup();const results=await Promise.all([f.create(),f.create()]);assert.ok(results.every(r=>[200,201].includes(r.status)),JSON.stringify(results));
 const reordered=Object.fromEntries(Object.entries(f.body).reverse());assert.equal((await f.call('/jobs',{who:f.buyer,method:'POST',body:reordered})).status,200);
 assert.equal((await f.call('/jobs',{who:f.buyer,method:'POST',body:{...f.body,title:'Changed'}})).status,409);
 assert.equal((await f.call('/jobs',{who:f.otherBuyer,method:'POST',body:f.body})).status,409);
 const job=results[0].data.job;assert.equal(job.events.length,1);assert.equal(job.events[0].actorId,f.buyer.session.id);assert.equal(job.createdAt,job.updatedAt);
 assert.equal((await f.call('/jobs/'+job.id,{who:f.otherBuyer})).status,404);
 assert.deepEqual((await f.call('/jobs',{who:f.otherBuyer})).data.jobs,[]);
});
test('strict job schema rejects metadata/plaintext/decoder injection and mismatched GC row count',async()=>{
 const f=await setup();for(const extra of [{filename:'secret.csv'},{headers:['x']},{budget:1},{plaintext:[42]}])assert.equal((await f.call('/jobs',{who:f.buyer,method:'POST',body:{...f.body,...extra}})).status,400);
 for(const b of [{...f.body,rowCount:33},{...f.body,rowCount:1},{...f.body,profile:'arbitrary'},{...f.body,task:{...f.body.task,decoder:[]}},{...f.body,buyerPublicKey:{...pub,d:'private'}},{...f.body,deadlineISO:'bad'}])assert.equal((await f.call('/jobs',{who:f.buyer,method:'POST',body:b})).status,400);
});
test('offer isolation, immutable per-provider offer, closed-only buyer envelopes, and selected-only task',async()=>{
 const f=await setup();await f.create();await f.offer();const id=f.body.jobId;
 assert.equal((await f.offer()).status,409);
 for(const who of [f.buyer,f.provider,f.outsider]){const j=(await f.call('/jobs/'+id,{who})).data.job;assert.ok(!('task'in j));assert.ok(!('offers'in j));if(who===f.provider)assert.equal(j.ownOffer.providerId,who.session.id);if(who===f.outsider)assert.equal(j.ownOffer,null);}
 assert.equal((await f.call('/jobs/'+id+'/task',{who:f.outsider})).status,403);
 assert.equal((await f.call('/jobs/'+id+'/task',{who:f.buyer})).status,200);
 assert.equal((await f.post('close',{},f.provider)).status,403);
 const closed=await f.post('close');assert.equal(closed.data.job.offers.length,1);assert.equal((await f.post('offers',{envelope:f.envelope,commitment:'a'.repeat(64)},f.outsider)).status,409);
 const offerId=closed.data.job.offers[0].id;
 assert.equal((await f.post('award',{offerId,amountYocto:f.amountYocto,salt:'0'.repeat(64)})).status,400);
 assert.equal((await f.post('award',{offerId,amountYocto:'01',salt:f.salt})).status,400);
 assert.equal((await f.post('award',{offerId,amountYocto:f.amountYocto,salt:f.salt})).status,200);
 assert.equal((await f.call('/jobs/'+id+'/task',{who:f.provider})).status,200);
 assert.equal((await f.call('/jobs/'+id+'/task',{who:f.outsider})).status,403);
 assert.equal((await f.post('execute',{},f.outsider)).status,403);
 assert.equal((await f.post('execute',{},f.buyer)).status,403);
});
test('real existing GC handler lifecycle, decoder stays client-side, exact version/hash decisions, re-execution',async()=>{
 const f=await setup();await f.award();f.setTime(Date.parse('2026-11-12T10:01:00Z'));
 const executed=await f.post('execute',{},f.provider);assert.equal(executed.status,200,JSON.stringify(executed.data));const d=executed.data.job.delivery;
 assert.deepEqual(fixture.decode(d.outputs),[42,0]);assert.equal(d.inputSha256,await hashRequest(fixture.request));assert.equal(d.outputSha256,await hashOutput(d.outputs));assert.equal(d.programSha256,await hashProgram());assert.equal(d.version,1);assert.equal(executed.data.job.payment.status,'NOT_DUE');
 assert.equal((await f.call('/jobs/'+f.body.jobId,{who:f.outsider})).data.job.delivery,null);
 assert.deepEqual((await f.post('execute',{},f.provider)).data.job.delivery,d);
 for(const b of [{decision:'accept',version:0,outputSha256:d.outputSha256},{decision:'accept',version:1,outputSha256:'a'.repeat(64)}])assert.equal((await f.post('decision',b)).status,409);
 assert.equal((await f.post('decision',{decision:'accept',version:1,outputSha256:d.outputSha256},f.provider)).status,403);
 assert.equal((await f.post('decision',{decision:'revise',version:1,outputSha256:d.outputSha256})).data.job.status,'REVISION');
 const second=(await f.post('execute',{},f.provider)).data.job.delivery;assert.equal(second.version,2);assert.equal(second.outputSha256,d.outputSha256);
 assert.equal((await f.post('decision',{decision:'accept',version:1,outputSha256:d.outputSha256})).status,409);
 const accepted=await f.post('decision',{decision:'accept',version:2,outputSha256:second.outputSha256});assert.equal(accepted.data.job.payment.status,'DUE');assert.equal(accepted.data.job.status,'ACCEPTED');assert.equal(accepted.data.job.events.at(-1).stage,'ACCEPTED');
 const stored=JSON.stringify([...f.store.records]);assert.ok(!stored.includes('outputPairs'));assert.ok(!stored.includes(f.salt)); // Losing plaintext prices/salts are never persisted
});
test('offer deadline, envelope bounds, unknown keys and required testnet payout account',async()=>{
 const f=await setup();await f.create();
 for(const body of [{envelope:{...f.envelope,price:3},commitment:'a'.repeat(64)},{envelope:{...f.envelope,iv:'bad'},commitment:'a'.repeat(64)},{envelope:f.envelope,commitment:'forged'},{envelope:f.envelope,commitment:'a'.repeat(64),amount:3}])assert.equal((await f.post('offers',body,f.provider)).status,400);
 const noAccount=await f.call('/session',{method:'POST',body:{role:'provider',displayName:'No account'}});assert.equal((await f.post('offers',{envelope:f.envelope,commitment:'a'.repeat(64)},noAccount.data)).status,400);
 f.setTime(Date.parse(f.body.deadlineISO));assert.equal((await f.offer()).status,409);assert.equal((await f.post('close')).status,200);
});
test('per-client jobs quota persists across buyer sessions without collecting IP addresses',async()=>{
 const f=await setup();for(let i=0;i<5;i++){const b={...f.body,jobId:i.toString(16).padStart(32,'0')};assert.equal((await f.call('/jobs',{who:f.buyer,method:'POST',body:b})).status,201);}
 assert.equal((await f.create()).status,429);
 const second=await f.session('buyer','Second',f.buyer.cookie);assert.equal((await f.call('/jobs',{who:second,method:'POST',body:f.body})).status,429);
 assert.ok(!JSON.stringify([...f.store.records]).includes('127.0.0.1'));
});
test('global daily sessions cap uses immutable competing claim slots',async()=>{
 const f=await setup();const replies=await Promise.all(Array.from({length:55},(_,i)=>f.call('/session',{method:'POST',body:{role:'buyer',displayName:'Synthetic '+i}})));
 assert.equal(replies.filter(r=>r.status===201).length,46);assert.equal(replies.filter(r=>r.status===429).length,9);
});
const HASH='3'.repeat(44),BLOCK='4'.repeat(44);
function rpcFixture(job,{mutate=()=>{},error=false}={}){
 const result={final_execution_status:'FINAL',status:{SuccessValue:''},transaction:{hash:HASH,signer_id:'payer.testnet',receiver_id:job.selectedOffer.paymentAccount,actions:[{Transfer:{deposit:job.selectedOffer.amountYocto}}]},transaction_outcome:{block_hash:BLOCK,outcome:{status:{SuccessReceiptId:'receipt'}}},receipts_outcome:[{block_hash:BLOCK,outcome:{status:{SuccessValue:''}}}]};mutate(result);
 const calls=[];const fetcher=async(url,init)=>{assert.equal(url,RPC);const {method,params}=JSON.parse(init.body);calls.push({method,params});assert.ok(['status','tx','block'].includes(method));return Response.json(error?{error:{}}:{result:method==='status'?{chain_id:'testnet'}:method==='tx'?result:{header:{hash:BLOCK,timestamp_nanosec:String(BigInt(Date.parse(job.createdAt)+1000)*1000000n)}}});};
 return {verify:paymentVerifier(fetcher),calls};
}
async function accepted(f){await f.award();const d=(await f.post('execute',{},f.provider)).data.job.delivery;return (await f.post('decision',{decision:'accept',version:d.version,outputSha256:d.outputSha256})).data.job;}
test('explicit SYNTHETIC RPC fixture verifies direct testnet transfer only; no signing/send methods',async()=>{
 const f=await setup();const j=await accepted(f),rpc=rpcFixture(j),facts=await rpc.verify({transactionHash:HASH,buyerAccount:'payer.testnet',job:j});assert.equal(facts.status,'PAID');assert.equal(facts.kind,'DIRECT_TESTNET_TRANSFER');assert.deepEqual(rpc.calls.map(x=>x.method),['status','tx','block']);assert.equal(rpc.calls[1].params.wait_until,'FINAL');
 for(const mutate of [r=>{r.final_execution_status='EXECUTED_OPTIMISTIC';},r=>{r.transaction.signer_id='wrong.testnet';},r=>{r.transaction.receiver_id='wrong.testnet';},r=>{r.transaction.actions[0].Transfer.deposit='1';},r=>{r.transaction.actions.push({Transfer:{deposit:'1'}});},r=>{r.receipts_outcome[0].outcome.status={Failure:{}};},r=>{r.status={Failure:{}};},r=>{r.receipts_outcome=[];},r=>{r.transaction.hash='5'.repeat(44);}])await assert.rejects(rpcFixture(j,{mutate}).verify({transactionHash:HASH,buyerAccount:'payer.testnet',job:j}));
 await assert.rejects(rpcFixture({...j,createdAt:'2030-01-01T00:00:00Z'}).verify({transactionHash:HASH,buyerAccount:'payer.near',job:j}));
 const oldFetcher=async(_,init)=>{const m=JSON.parse(init.body).method;return Response.json({result:m==='status'?{chain_id:'testnet'}:m==='tx'?{final_execution_status:'FINAL',status:{SuccessValue:''},transaction:{hash:HASH,signer_id:'payer.testnet',receiver_id:j.selectedOffer.paymentAccount,actions:[{Transfer:{deposit:j.selectedOffer.amountYocto}}]},transaction_outcome:{block_hash:BLOCK,outcome:{status:{SuccessValue:''}}},receipts_outcome:[{block_hash:BLOCK,outcome:{status:{SuccessValue:''}}}]}:{header:{hash:BLOCK,timestamp_nanosec:'1'}}});};
 await assert.rejects(paymentVerifier(oldFetcher)({transactionHash:HASH,buyerAccount:'payer.testnet',job:j}));
});
test('payment failures never mark PAID, synthetic verified fixture claims hash globally against reuse',async()=>{
 const store=new Store();let verify;
 const f=await setup({store,verifyPayment:args=>verify(args)});await accepted(f);verify=async()=>{throw Error('pending');};
 const payment={transactionHash:HASH,buyerAccount:'payer.testnet'};assert.equal((await f.post('payment/verify',payment)).status,409);
 assert.equal((await f.call('/jobs/'+f.body.jobId,{who:f.buyer})).data.job.payment.status,'DUE');
 verify=args=>rpcFixture(args.job).verify(args);const paid=await f.post('payment/verify',payment);assert.equal(paid.status,200);assert.equal(paid.data.job.status,'PAID');assert.equal((await f.post('payment/verify',payment)).status,200);
 const other=await setup({store,verifyPayment:args=>rpcFixture(args.job).verify(args)});await accepted(other);assert.equal((await other.post('payment/verify',payment)).data.code,'TRANSACTION_ALREADY_USED');
});
test('immutable CAS detects concurrent state edits; unknown storage outcome fails closed and creation retries recover',async()=>{
 const f=await setup();await f.create();const before=[...f.store.records].filter(([k])=>/jobs\/.*\/0000/.test(k));
 const replies=await Promise.all([f.offer(),f.post('close')]);assert.ok(replies.every(r=>[200,409].includes(r.status)));
 for(const [k,v]of before)assert.deepEqual(await f.store.read(k),v);
 const g=await setup();const create=g.store.create.bind(g.store);let once=true;g.store.create=async(p,v)=>{const result=await create(p,v);if(once&&/jobs\/.*\/0000/.test(p)){once=false;throw Error('response lost');}return result;};
 assert.equal((await g.create()).status,503);assert.equal((await g.create()).status,200);
});
test('Blob adapter is private immutable no-overwrite and never treats unknown outcome as success',async()=>{
 const calls=[],records=new Map();const client={async put(p,b,o){calls.push(o);if(records.has(p))throw Error('occupied');records.set(p,b);},async get(p,o){calls.push(o);return records.has(p)?{statusCode:200,stream:new Blob([records.get(p)]).stream()}:null;},async list(){return {blobs:[]};}};
 const store=blobWorkspaceStore({BLOB_READ_WRITE_TOKEN:'synthetic-only'},client),p=ROOT+'sessions/'+'a'.repeat(64)+'.json';assert.equal(await store.create(p,{x:1}),true);assert.equal(await store.create(p,{x:2}),false);assert.deepEqual(await store.read(p),{x:1});assert.ok(calls.every(o=>o.access==='private'));assert.equal(calls[0].allowOverwrite,false);assert.equal(calls[0].addRandomSuffix,false);
 await assert.rejects(store.create('../wrong',{}));
 const broken=blobWorkspaceStore({}, {put:async()=>{throw Error('unknown');},get:async()=>{throw Error('unreadable');}});await assert.rejects(broken.create(p,{}));
});
test('HTTP adapter query routes, parsed Vercel bodies, real missing-Origin GET and streaming bounds',async t=>{
 const store=new Store(),server=createServer(createWorkspaceHandler({store,env:{NOPE_WORKSPACE_ORIGIN:'http://127.0.0.1:8713'}}));await new Promise(resolve=>server.listen(8713,'127.0.0.1',resolve));t.after(()=>new Promise(resolve=>{server.closeAllConnections();server.close(resolve);}));const origin='http://127.0.0.1:8713';
 const r=await fetch(origin+'/api/workspace?route=session',{method:'POST',headers:{origin,'content-type':'application/json'},body:JSON.stringify({role:'buyer',displayName:'HTTP synthetic'})});assert.equal(r.status,201);const session=await r.json();
 const get=await fetch(origin+'/api/workspace?route=session',{headers:{authorization:'Bearer '+session.token}});assert.equal(get.status,200);assert.equal(get.headers.get('cache-control'),'no-store');
 assert.equal((await fetch(origin+'/api/workspace?route=session&route=jobs',{headers:{authorization:'Bearer '+session.token}})).status,404);
 const over=await fetch(origin+'/api/workspace?route=session',{method:'POST',headers:{origin,'content-type':'application/json'},body:Readable.from([Buffer.alloc(1048576),Buffer.alloc(1)]),duplex:'half'});assert.equal(over.status,413);
 const adapter=createWorkspaceHandler({store,env}),req=Readable.from([]);Object.assign(req,{url:'/api/workspace?route=session',method:'POST',headers:{origin:ORIGIN,'content-type':'application/json'},body:{role:'buyer',displayName:'Parsed'}});const res={headers:{},setHeader(k,v){this.headers[k]=v;},end(b){this.body=JSON.parse(String(b));}};await adapter(req,res);assert.equal(res.statusCode,201);
 const bad=Readable.from([]);Object.assign(bad,{url:'/api/workspace?route=session',method:'POST',headers:req.headers,body:{get role(){throw Error('must not execute');}}});await adapter(bad,res);assert.equal(res.statusCode,400);
});
test('strict JSON rejects duplicate schema keys, malformed UTF8 and 1MiB overflow',async()=>{
 const f=await setup();assert.equal((await f.call('/session',{method:'POST',body:'{"role":"buyer","role":"provider","displayName":"x"}'})).status,400);
 assert.equal((await f.call('/session',{method:'POST',body:'x'.repeat(1048577)})).status,413);
});
test('actual browser-vault RSA/AES encrypted quote matches backend commitment and award protocol',async()=>{
 const f=await setup(),records=new Map(),storage={get:async k=>structuredClone(records.get(JSON.stringify(k))),put:async(k,v)=>records.set(JSON.stringify(k),structuredClone(v)),installKeys:async(k,v)=>{const id=JSON.stringify(k);if(!records.has(id))records.set(id,structuredClone(v));return structuredClone(records.get(id));}};
 const buyerVault=createVault(f.buyer.session.id,{storage}),providerVault=createVault(f.provider.session.id,{storage});f.body.buyerPublicKey=await buyerVault.buyerPublicKey();await f.create();
 const salt=randomSalt(),quote={jobId:f.body.jobId,providerId:f.provider.session.id,amountYocto:f.amountYocto,salt};const commitment=await vaultCommitment(quote.jobId,quote.providerId,quote.amountYocto,quote.salt);assert.equal(commitment,quoteCommitment(quote.jobId,quote.providerId,quote.amountYocto,quote.salt));
 const envelope=await providerVault.encryptQuote(f.body.buyerPublicKey,quote);assert.equal((await f.post('offers',{envelope,commitment},f.provider)).status,200);
 const job=(await f.post('close')).data.job,decoded=await buyerVault.decryptQuote(job.offers[0].envelope);assert.deepEqual(decoded,quote);
 assert.equal((await f.post('award',{offerId:job.offers[0].id,amountYocto:decoded.amountYocto,salt:decoded.salt})).status,200);
 assert.ok(!JSON.stringify([...f.store.records]).includes(salt));
});
test('twenty immutable offers per client maximum across jobs, including role/session switching',async()=>{
 const f=await setup();let buyer=f.buyer;
 for(let n=0;n<21;n++){
  if(n&&n%5===0)buyer=await f.session('buyer','Buyer '+n);
  const jobId=(n+200).toString(16).padStart(32,'0'),body={...f.body,jobId};assert.equal((await f.call('/jobs',{who:buyer,method:'POST',body})).status,201);
  const result=await f.call('/jobs/'+jobId+'/offers',{who:f.provider,method:'POST',body:{envelope:f.envelope,commitment:quoteCommitment(jobId,f.provider.session.id,f.amountYocto,f.salt)}});assert.equal(result.status,n<20?200:429);
 }
});

test('testnet account format supports named and implicit accounts while excluding mainnet names',()=>{assert.equal(testnetAccount('alice.testnet'),true);assert.equal(testnetAccount('a'.repeat(64)),true);for(const a of ['alice.near','A'.repeat(64),'alice..testnet','-a.testnet'])assert.equal(testnetAccount(a),false);});
test('legacy pre-events immutable records remain readable and future events never invent past history',async()=>{
 const f=await setup();await f.create();const p=ROOT+'jobs/'+f.body.jobId+'/0000.json';delete f.store.records.get(p).job.events;
 const legacy=await f.call('/jobs/'+f.body.jobId,{who:f.buyer});assert.equal(legacy.status,200);assert.deepEqual(legacy.data.job.events,[]);
 f.setTime(Date.parse('2026-11-12T10:15:00Z'));const close=await f.post('close');assert.equal(close.status,200);assert.equal(close.data.job.events.length,1);assert.equal(close.data.job.events[0].stage,'CLOSED');assert.equal(close.data.job.events[0].at,'2026-11-12T10:15:00.000Z');assert.equal(f.store.records.get(p).job.events,undefined);
});
test('malformed UTF8 and spoofed forwarded headers do not bypass JSON or Origin validation',async()=>{
 const f=await setup();const invalid=await f.handle(new Request(ORIGIN+'/api/workspace/session',{method:'POST',headers:{origin:ORIGIN,'content-type':'application/json'},body:Buffer.from([0xff])}));assert.equal(invalid.status,400);
 assert.equal((await f.call('/session',{who:f.buyer,origin:'https://evil.invalid',headers:{'x-forwarded-host':'localhost:8712','x-forwarded-proto':'http'}})).status,403);
 assert.equal((await f.call('/session',{who:f.buyer,headers:{'x-forwarded-host':'evil.invalid'}})).status,200);
});
