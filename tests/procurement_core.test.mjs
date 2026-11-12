import test from 'node:test';
import assert from 'node:assert/strict';
import {createProcurement} from '../procurement/core.mjs';
import {MPC_UPSTREAM,MPC_PROGRAM_HASH,MPC_PROFILE,PROFILE,sha256,precommitContext,commitment,canonical} from '../procurement/codec.mjs';

const BASE='https://pilot.invalid/api/procurement';
const TOKENS={buyer:'a'.repeat(43),provider1:'b'.repeat(43),provider2:'c'.repeat(43),provider3:'d'.repeat(43),outsider:'e'.repeat(43),operator:'f'.repeat(43),otherBuyer:'g'.repeat(43)};
const PRINCIPALS={buyer:'buyer.testnet',provider1:'one.testnet',provider2:'two.testnet',provider3:'three.testnet',outsider:'outsider.testnet',operator:'operator.testnet',otherBuyer:'other.testnet'};
const ROSTER=[PRINCIPALS.provider1,PRINCIPALS.provider2,PRINCIPALS.provider3].sort();
const T=1800000000000;
const HASH=n=>sha256(String(n));
let counter=0;
class Store {
  data=new Map();fault=null;listCalls=[];readCalls=[];
  async read(path){this.readCalls.push(path);if(this.fault?.read?.(path))throw Error('read offline');return structuredClone(this.data.get(path)??null);}
  async create(path,value){
    if(this.fault?.before?.(path))throw Error('unknown before write');
    // Yield makes independent requests actually race on a CAS slot.
    await Promise.resolve();
    if(this.data.has(path))return false;
    this.data.set(path,structuredClone(value));
    if(this.fault?.after?.(path))throw Error('reply lost');
    return true;
  }
  async list({prefix,limit,cursor}){
    this.listCalls.push({prefix,limit,cursor});
    const paths=[...this.data.keys()].filter(p=>p.startsWith(prefix)).sort();
    const start=cursor?Number(Buffer.from(cursor,'base64url').toString()):0;
    const end=start+limit;
    return {pathnames:paths.slice(start,end),cursor:end<paths.length?Buffer.from(String(end)).toString('base64url'):null};
  }
}
function fixture({selectionVerifier,store=new Store(),expiresAt=T+10*86400000}={}){
  let clock=T;
  const grants=Object.keys(TOKENS).map(name=>({tokenHash:sha256(TOKENS[name]),principal:PRINCIPALS[name],role:name==='operator'?'operator':name.includes('Buyer')||name==='buyer'?'buyer':'provider',expiresAt}));
  const env={NOPE_PROCUREMENT_GRANTS:JSON.stringify(grants)};
  const make=()=>createProcurement({store,env,now:()=>clock,selectionVerifier});
  let handle=make();
  const call=async(name,path='',{body,method=body===undefined?'GET':'POST',key='request-key-'+String(++counter).padStart(10,'0'),headers={}}={})=>{
    const response=await handle(new Request(BASE+path,{method,headers:{Authorization:'Bearer '+TOKENS[name],...(body===undefined?{}:{'content-type':'application/json','idempotency-key':key}),...headers},...(body===undefined?{}:{body:typeof body==='string'?body:JSON.stringify(body)})}));
    return {status:response.status,body:await response.json(),headers:response.headers};
  };
  const draft=(id='1'.repeat(32))=>({jobId:id,title:'Pilot clean records',profile:PROFILE,roster:ROSTER,bidDeadlineNs:String(BigInt(T+60000)*1000000n),resultDeadlineNs:String(BigInt(T+3600000)*1000000n)});
  const intent=(d=draft())=>({version:2,profile:MPC_PROFILE,networkDomainHash:HASH('network'),registryAccount:'registry.testnet',buyer:PRINCIPALS.buyer,roster:d.roster,qualified:[true,true,true],fixedFee:1250000,bidDeadlineNs:d.bidDeadlineNs,resultDeadlineNs:d.resultDeadlineNs,specHash:HASH('spec'),circuitHash:HASH('circuit'),keyHash:HASH('key'),outputPolicyHash:HASH('policy'),inputHash:HASH('input'),registryExecutor:'executor.testnet',intentNonce:HASH('nonce'),selectionRound:HASH('round'),mpcProgramHash:MPC_PROGRAM_HASH,upstream:MPC_UPSTREAM});
  const create=async()=>{const r=await call('buyer','/jobs',{body:draft()});assert.equal(r.status,201,JSON.stringify(r.body));return r.body.job;};
  const publish=async()=>{await create();const i=intent();const r=await call('buyer','/jobs/'+draft().jobId+'/publish',{body:{expectedRevision:0,intent:i,budgetCommitment:commitment(precommitContext(i),0,100000000,Buffer.alloc(32,1))}});assert.equal(r.status,200,JSON.stringify(r.body));return r.body.job;};
  const bids=async()=>{await publish();let revision=1;for(const provider of ['provider1','provider2','provider3']){const r=await call(provider,'/jobs/'+draft().jobId+'/bids',{body:{expectedRevision:revision++,commitment:HASH(provider)}});assert.equal(r.status,200,JSON.stringify(r.body));}return revision;};
  const close=async()=>{const revision=await bids();clock=T+60000;const r=await call('buyer','/jobs/'+draft().jobId+'/close',{body:{expectedRevision:revision}});assert.equal(r.status,200,JSON.stringify(r.body));return r.body.job;};
  return {store,env,grants,call,draft,intent,create,publish,bids,close,setTime:value=>clock=value,restart:()=>{handle=make();}};
}
const suffix='/jobs/'+'1'.repeat(32);
const goodVerifier={verify:async({job,evidenceHash})=>({provider:ROSTER[1],contextHash:job.contextHash,evidenceHash,closedRevision:job.revision,commitments:[job.budgetCommitment,...job.bids.map(b=>b.commitment)]})};
const nameFor=principal=>Object.keys(PRINCIPALS).find(k=>PRINCIPALS[k]===principal);

test('public capabilities are honest; invitation identity and provider choices are role scoped',async()=>{
  const f=fixture();
  const h=await f.call('buyer','/health',{headers:{Authorization:''}});assert.equal(h.status,200);assert.equal(h.body.capabilities.payments,false);assert.equal(h.body.capabilities.independentOperators,false);assert.equal(h.body.capabilities.blockchainBinding,false);assert.equal(h.body.capabilities.selectionAdapterConfigured,false);
  const session=await f.call('buyer','/session');assert.equal(session.status,200);assert.deepEqual(session.body.availableProviders,[...ROSTER,PRINCIPALS.outsider].sort());assert.equal(session.headers.get('cache-control'),'no-store');assert.equal(JSON.stringify(session.body).includes('tokenHash'),false);
  assert.equal(Object.hasOwn((await f.call('provider1','/session')).body,'availableProviders'),false);
  assert.equal((await f.call('buyer','/session',{headers:{Authorization:'',Cookie:'token='+TOKENS.buyer}})).status,401);
  assert.equal((await f.call('buyer','/health',{headers:{Origin:'https://foreign.invalid'}})).status,403);
  f.setTime(f.grants[0].expiresAt);assert.equal((await f.call('buyer','/session')).body.code,'INVITATION_EXPIRED');
});
test('invalid grant config fails closed including unrelated malformed grants',async()=>{
  const f=fixture();f.env.NOPE_PROCUREMENT_GRANTS='broken';assert.equal((await f.call('buyer','/session')).status,503);
  f.env.NOPE_PROCUREMENT_GRANTS=JSON.stringify([...f.grants,{tokenHash:'bad'}]);assert.equal((await f.call('buyer','/session')).status,503);
  f.env.NOPE_PROCUREMENT_GRANTS=JSON.stringify([...f.grants,f.grants[0]]);assert.equal((await f.call('buyer','/session')).status,503);
});
test('draft discoverability, publish visibility and constrained indexes do not leak other jobs',async()=>{
  const f=fixture();await f.create();
  assert.equal((await f.call('provider1',suffix)).status,404);assert.equal((await f.call('outsider',suffix)).status,404);assert.equal((await f.call('operator',suffix)).status,404);
  assert.equal((await f.call('buyer','/jobs')).body.jobs.length,1);assert.equal((await f.call('provider1','/jobs')).body.jobs.length,0);
  assert.equal((await f.call('otherBuyer','/jobs')).body.jobs.length,0);
  const i=f.intent();assert.equal((await f.call('buyer',suffix+'/publish',{body:{expectedRevision:0,intent:i,budgetCommitment:HASH('budget')}})).status,200);
  assert.equal((await f.call('provider1',suffix)).body.job.contextHash,precommitContext(i));assert.equal((await f.call('provider1','/jobs')).body.jobs.length,1);
  assert.equal((await f.call('outsider',suffix)).status,404);assert.equal((await f.call('outsider','/jobs')).body.jobs.length,0);
  assert.equal(f.store.listCalls.every(c=>/^nope-procurement-v1\/participants\/[a-f0-9]{64}\/$/.test(c.prefix)&&c.limit<=20),true);
  assert.equal((await f.call('buyer','/jobs?limit=21')).status,400);assert.equal((await f.call('buyer','/jobs?prefix=other')).status,400);assert.equal((await f.call('buyer','/jobs?limit=1&limit=2')).status,400);
});
test('draft requires exact fixed profile, active sorted three-person roster and safe title; plaintext rejected without writes',async()=>{
  const f=fixture();
  const invalid=[{budget:10},{records:[{id:1,value:1}]},{title:'<script>'},{title:'a'.repeat(101)},{profile:'generic-csv'},{roster:ROSTER.slice(0,2)},{roster:[ROSTER[0],ROSTER[0],ROSTER[2]]},{roster:[...ROSTER].reverse()},{roster:['a.testnet','b.testnet','c.testnet']},{bidDeadlineNs:String(BigInt(T)*1000000n)},{resultDeadlineNs:'01'},{jobId:'../secrets'}];
  for(const patch of invalid){const r=await f.call('buyer','/jobs',{body:{...f.draft(),...patch}});assert.equal(r.status,400,JSON.stringify(patch));}
  assert.equal(f.store.data.size,0);assert.equal((await f.call('provider1','/jobs',{body:f.draft()})).status,403);
  f.grants.find(g=>g.principal===ROSTER[0]).expiresAt=T;f.env.NOPE_PROCUREMENT_GRANTS=JSON.stringify(f.grants);assert.equal((await f.call('buyer','/jobs',{body:f.draft()})).status,400);
});
test('strict request body limits, invalid JSON and ambiguous duplicate keys',async()=>{
  const f=fixture();
  for(const body of ['{}','{"jobId":"1","jobId":"2"}','{"x":{"a":1,"\\u0061":2}}','{"x":'+ '['.repeat(18)+'0'+']'.repeat(18)+'}','{"x":NaN}'])assert.equal((await f.call('buyer','/jobs',{body})).status,400);
  assert.equal((await f.call('buyer','/jobs',{body:' '.repeat(16385)})).status,413);
  assert.equal((await f.call('buyer','/jobs',{body:f.draft(),headers:{'content-type':'text/plain'}})).status,415);
  assert.equal((await f.call('buyer','/jobs',{body:f.draft(),key:'short'})).status,400);assert.equal(f.store.data.size,0);
});
test('intent publication validates every binding and does not fabricate registry finality',async()=>{
  const f=fixture();await f.create();
  for(const patch of [{buyer:'different.testnet'},{roster:[...ROSTER].reverse()},{keyHash:'0'.repeat(64)},{inputHash:'x'.repeat(64)},{fixedFee:1000000000001},{mpcProgramHash:HASH('other')},{upstream:'another'},{bidDeadlineNs:'42'},{newField:true}]){
    assert.equal((await f.call('buyer',suffix+'/publish',{body:{expectedRevision:0,intent:{...f.intent(),...patch},budgetCommitment:HASH('budget')}})).status,400,JSON.stringify(patch));
  }
  const r=await f.call('buyer',suffix+'/publish',{body:{expectedRevision:0,intent:f.intent(),budgetCommitment:HASH('budget')}});assert.equal(r.status,200);assert.equal(r.body.job.blockchainBinding,'pending');assert.equal(r.body.job.ledger,'app');
  assert.equal(r.body.job.contextHash,precommitContext(f.intent()));assert.equal(r.body.job.bids.every(b=>b.commitment===null),true);
});
test('idempotency survives handler restart, key reordering and later revisions, but detects changed payload/action',async()=>{
  const f=fixture();const key='idempotent-create-00001';const body=f.draft();const first=await f.call('buyer','/jobs',{body,key});f.restart();
  const reordered=Object.fromEntries(Object.entries(body).reverse());const second=await f.call('buyer','/jobs',{body:reordered,key});assert.equal(second.status,201);assert.deepEqual(second.body,first.body);
  assert.equal((await f.call('buyer','/jobs',{body:{...body,title:'Changed'},key})).body.code,'IDEMPOTENCY_CONFLICT');
  assert.equal((await f.call('buyer',suffix+'/publish',{body:{expectedRevision:0,intent:f.intent(),budgetCommitment:HASH('b')},key})).body.code,'IDEMPOTENCY_CONFLICT');
  const published=await f.call('buyer',suffix+'/publish',{body:{expectedRevision:0,intent:f.intent(),budgetCommitment:HASH('b')}});assert.equal(published.status,200);
  assert.deepEqual((await f.call('buyer','/jobs',{body,key})).body,first.body);
  f.setTime(f.grants[0].expiresAt);assert.equal((await f.call('buyer','/jobs',{body,key})).status,401);
});
test('simultaneous same create key yields one canonical response and durable revision',async()=>{
  const f=fixture();const replies=await Promise.all(Array.from({length:8},()=>f.call('buyer','/jobs',{body:f.draft(),key:'same-create-operation-01'})));
  assert.equal(replies.every(r=>r.status===201),true,JSON.stringify(replies));assert.equal(new Set(replies.map(r=>canonical(r.body))).size,1);assert.equal([...f.store.data.keys()].filter(k=>k.includes('/revisions/')).length,1);
});
test('concurrent provider revisions admit only one CAS winner, loser can retry after GET',async()=>{
  const f=fixture();await f.publish();
  const replies=await Promise.all(['provider1','provider2'].map(p=>f.call(p,suffix+'/bids',{body:{expectedRevision:1,commitment:HASH(p)}})));
  assert.deepEqual(replies.map(r=>r.status).sort(),[200,409]);
  const loser=['provider1','provider2'][replies.findIndex(r=>r.status===409)];const read=await f.call(loser,suffix);assert.equal(read.body.job.revision,2);assert.equal(read.body.job.bids.filter(b=>b.commitment).length,1);
  assert.equal((await f.call(loser,suffix+'/bids',{body:{expectedRevision:2,commitment:HASH(loser)}})).status,200);
  assert.equal([...f.store.data.keys()].filter(k=>k.includes('/revisions/')).length,4);
});
test('successful writes with lost acknowledgements are confirmed; unreadable outcomes stay unknown and replay once recovered',async()=>{
  const f=fixture();const body=f.draft();const key='lost-acknowledgement-001';
  f.store.fault={after:p=>p.endsWith('/000.json')};
  assert.equal((await f.call('buyer','/jobs',{body,key})).status,201);assert.equal((await f.call('buyer','/jobs',{body,key})).status,201);
  const g=fixture();let committed=false;
  g.store.fault={after:p=>{if(p.endsWith('/000.json')){committed=true;return true;}return false;},read:p=>committed&&p.endsWith('/000.json')};
  const unknown=await g.call('buyer','/jobs',{body:g.draft(),key});assert.equal(unknown.status,503);assert.equal(unknown.body.code,'STORAGE_UNKNOWN');
  g.store.fault=null;g.restart();assert.equal((await g.call('buyer','/jobs',{body:g.draft(),key})).status,201);assert.equal([...g.store.data.keys()].filter(p=>p.includes('/revisions/')).length,1);
});
test('crash orphan index cannot expose a nonexistent draft and same request repairs discoverability',async()=>{
  const f=fixture();f.store.fault={before:p=>p.endsWith('/000.json')};
  assert.equal((await f.call('buyer','/jobs',{body:f.draft(),key:'orphan-index-repair-001'})).status,503);assert.equal((await f.call('buyer','/jobs')).body.jobs.length,0);
  f.store.fault=null;assert.equal((await f.call('buyer','/jobs',{body:f.draft(),key:'orphan-index-repair-001'})).status,201);assert.equal((await f.call('buyer','/jobs')).body.jobs.length,1);
});
test('bid admission is provider/object scoped, immutable and deadline strict',async()=>{
  const f=fixture();await f.publish();
  assert.equal((await f.call('buyer',suffix+'/bids',{body:{expectedRevision:1,commitment:HASH('b')}})).status,403);
  assert.equal((await f.call('outsider',suffix+'/bids',{body:{expectedRevision:1,commitment:HASH('b')}})).status,404);
  assert.equal((await f.call('provider1',suffix+'/bids',{body:{expectedRevision:1,commitment:'0'.repeat(64)}})).status,400);
  const body={expectedRevision:1,commitment:HASH('b')};const key='provider-one-bid-00001';const r=await f.call('provider1',suffix+'/bids',{body,key});assert.equal(r.status,200);
  assert.equal((await f.call('provider1',suffix+'/bids',{body:{expectedRevision:2,commitment:HASH('c')}})).body.code,'BID_IMMUTABLE');
  assert.equal((await f.call('provider2',suffix+'/bids',{body:{expectedRevision:2,commitment:HASH('b')}})).body.code,'DUPLICATE_COMMITMENT');
  f.setTime(T+60000);assert.equal((await f.call('provider2',suffix+'/bids',{body:{expectedRevision:2,commitment:HASH('c')}})).body.code,'BID_DEADLINE');
  assert.deepEqual((await f.call('provider1',suffix+'/bids',{body,key})).body,r.body);
});
test('close is buyer-only and freezes missing slots; missing bids cannot be selected',async()=>{
  const f=fixture();await f.publish();assert.equal((await f.call('buyer',suffix+'/close',{body:{expectedRevision:1}})).body.code,'BID_DEADLINE');
  f.setTime(T+60000);assert.equal((await f.call('provider1',suffix+'/close',{body:{expectedRevision:1}})).status,403);
  const closed=await f.call('buyer',suffix+'/close',{body:{expectedRevision:1}});assert.equal(closed.status,200);assert.equal(closed.body.job.bids.filter(b=>b.commitment===null).length,3);
  assert.equal((await f.call('operator',suffix+'/selection',{body:{expectedRevision:2,evidenceHash:HASH('ev')}})).body.code,'INCOMPLETE_BIDS');
});
test('selection fails closed by default and role errors do not reveal other jobs',async()=>{
  const f=fixture();const closed=await f.close();const body={expectedRevision:closed.revision,evidenceHash:HASH('ev')};
  assert.equal((await f.call('buyer',suffix+'/selection',{body})).status,403);assert.equal((await f.call('otherBuyer',suffix+'/selection',{body})).status,403);assert.equal((await f.call('otherBuyer','/jobs/'+'f'.repeat(32)+'/selection',{body})).status,403);
  const r=await f.call('operator',suffix+'/selection',{body});assert.equal(r.status,503);assert.equal(r.body.code,'SELECTION_UNAVAILABLE');assert.equal((await f.call('buyer',suffix)).body.job.status,'CLOSED');
});
test('selection adapter must bind every frozen field; unvalidated results never append',async()=>{
  for(const patch of [{provider:'outsider.testnet'},{contextHash:HASH('wrong')},{evidenceHash:HASH('wrong')},{closedRevision:0},{commitments:[HASH('one')]},{verified:true}]){
    const f=fixture({selectionVerifier:{verify:async args=>({...await goodVerifier.verify(args),...patch})}});const closed=await f.close();const r=await f.call('operator',suffix+'/selection',{body:{expectedRevision:closed.revision,evidenceHash:HASH('ev')}});assert.equal(r.status,503,JSON.stringify(patch));assert.equal((await f.call('buyer',suffix)).body.job.revision,closed.revision);
  }
});
test('selected-provider delivery, exact latest decision and terminal acceptance are durable metadata only',async()=>{
  const f=fixture({selectionVerifier:goodVerifier});const closed=await f.close();
  const selection=await f.call('operator',suffix+'/selection',{body:{expectedRevision:closed.revision,evidenceHash:HASH('ev')},key:'selection-operation-001'});assert.equal(selection.status,200);
  const provider=nameFor(ROSTER[1]);const other=nameFor(ROSTER[0]);
  const deliver=rev=>({expectedRevision:rev,version:1,outputHash:HASH('ciphertext1'),receiptHash:HASH('receipt1')});
  assert.equal((await f.call(other,suffix+'/deliveries',{body:deliver(6)})).status,403);
  assert.equal((await f.call(provider,suffix+'/deliveries',{body:{...deliver(6),outputBase64:'plaintext'}})).status,400);
  const d=await f.call(provider,suffix+'/deliveries',{body:deliver(6)});assert.equal(d.status,200);assert.equal(d.body.job.status,'DELIVERED');
  const decision={expectedRevision:7,version:1,outputHash:HASH('ciphertext1'),receiptHash:HASH('receipt1'),decision:'accept'};
  assert.equal((await f.call(provider,suffix+'/decision',{body:decision})).status,403);
  for(const patch of [{version:2},{outputHash:HASH('other')},{receiptHash:HASH('other')},{expectedRevision:6}])assert.equal((await f.call('buyer',suffix+'/decision',{body:{...decision,...patch}})).status,409);
  const v2=await f.call(provider,suffix+'/deliveries',{body:{...deliver(7),version:2,outputHash:HASH('ciphertext2')}});assert.equal(v2.status,200);
  assert.equal((await f.call('buyer',suffix+'/decision',{body:{...decision,expectedRevision:8}})).body.code,'DELIVERY_MISMATCH');
  const exact={expectedRevision:8,version:2,outputHash:HASH('ciphertext2'),receiptHash:HASH('receipt1'),decision:'accept'};
  const accepted=await f.call('buyer',suffix+'/decision',{body:exact,key:'accept-latest-exact-0001'});assert.equal(accepted.status,200);assert.equal(accepted.body.job.status,'ACCEPTED');f.restart();
  assert.deepEqual((await f.call('buyer',suffix+'/decision',{body:exact,key:'accept-latest-exact-0001'})).body,accepted.body);
  assert.equal((await f.call(provider,suffix+'/deliveries',{body:{...deliver(9),version:3}})).status,409);assert.equal(accepted.body.job.blockchainBinding,'pending');
  const serialized=JSON.stringify([...f.store.data.values()]);for(const witness of ['budget":','price":','salt":','records":','outputBase64','receiptBase64'])assert.equal(serialized.includes(witness),false);
});
test('selection racing with expiry never appends, and result deadline restricts deliveries',async()=>{
  let f;f=fixture({selectionVerifier:{verify:async args=>{const v=await goodVerifier.verify(args);f.setTime(T+3600000);return v;}}});const closed=await f.close();
  assert.equal((await f.call('operator',suffix+'/selection',{body:{expectedRevision:closed.revision,evidenceHash:HASH('ev')}})).body.code,'RESULT_DEADLINE');
  const g=fixture({selectionVerifier:goodVerifier});await g.close();await g.call('operator',suffix+'/selection',{body:{expectedRevision:5,evidenceHash:HASH('ev')}});g.setTime(T+3600000);
  assert.equal((await g.call(nameFor(ROSTER[1]),suffix+'/deliveries',{body:{expectedRevision:6,version:1,outputHash:HASH('o'),receiptHash:HASH('r')}})).body.code,'RESULT_DEADLINE');
});
test('selection concurrent replay does not change selected revision or claim independent committee execution',async()=>{
  const f=fixture({selectionVerifier:goodVerifier});await f.close();
  const replies=await Promise.all(Array.from({length:4},()=>f.call('operator',suffix+'/selection',{body:{expectedRevision:5,evidenceHash:HASH('ev')},key:'selection-replayed-key-01'})));
  assert.equal(replies.every(r=>r.status===200),true);assert.equal(new Set(replies.map(r=>canonical(r.body))).size,1);assert.equal((await f.call('buyer',suffix)).body.job.revision,6);
  assert.equal((await f.call('buyer','/health')).body.capabilities.independentOperators,false);
});

test('bounded participant listing paginates only the authorized prefix, including stale reserved rows',async()=>{
  const f=fixture();
  for(let n=1;n<=5;n++){const d=f.draft(String(n).padStart(32,'0'));assert.equal((await f.call('buyer','/jobs',{body:d})).status,201);}
  let cursor=null;const ids=[];
  do{const r=await f.call('buyer','/jobs?limit=2'+(cursor?'&cursor='+encodeURIComponent(cursor):''));assert.equal(r.status,200);assert.equal(r.body.jobs.length<=2,true);ids.push(...r.body.jobs.map(j=>j.id));cursor=r.body.nextCursor;}while(cursor);
  assert.equal(ids.length,5);assert.equal(new Set(ids).size,5);assert.equal(f.store.listCalls.every(c=>c.limit===2),true);
});
test('decision rejection permits a distinct next delivery and no skipped version',async()=>{
  const f=fixture({selectionVerifier:goodVerifier});await f.close();await f.call('operator',suffix+'/selection',{body:{expectedRevision:5,evidenceHash:HASH('ev')}});
  const provider=nameFor(ROSTER[1]);const fields={version:1,outputHash:HASH('out'),receiptHash:HASH('receipt')};
  assert.equal((await f.call(provider,suffix+'/deliveries',{body:{expectedRevision:6,...fields}})).status,200);
  const reject=await f.call('buyer',suffix+'/decision',{body:{expectedRevision:7,...fields,decision:'reject'}});assert.equal(reject.status,200);assert.equal(reject.body.job.status,'REJECTED');
  assert.equal((await f.call(provider,suffix+'/deliveries',{body:{expectedRevision:8,...fields}})).body.code,'INVALID_DELIVERY');
  const resubmitted=await f.call(provider,suffix+'/deliveries',{body:{expectedRevision:8,...fields,version:2}});assert.equal(resubmitted.status,200);assert.equal(resubmitted.body.job.decision,null);
});
test('revision cap bounds durable rows while existing idempotent responses remain retrievable',async()=>{
  const f=fixture({selectionVerifier:goodVerifier});await f.close();await f.call('operator',suffix+'/selection',{body:{expectedRevision:5,evidenceHash:HASH('ev')}});
  const provider=nameFor(ROSTER[1]);let finalBody,key;
  for(let revision=6;revision<62;revision++){
    const body={expectedRevision:revision,version:revision-5,outputHash:HASH('output'+revision),receiptHash:HASH('receipt'+revision)};
    key='bounded-delivery-'+String(revision).padStart(8,'0');
    assert.equal((await f.call(provider,suffix+'/deliveries',{body,key})).status,200);finalBody=body;
  }
  const r=await f.call(provider,suffix+'/deliveries',{body:{...finalBody,expectedRevision:62,version:58}});assert.equal(r.status,409);assert.equal(r.body.code,'REVISION_LIMIT');
  assert.equal((await f.call(provider,suffix+'/deliveries',{body:finalBody,key})).status,200);
  const accepted=await f.call('buyer',suffix+'/decision',{body:{expectedRevision:62,version:finalBody.version,outputHash:finalBody.outputHash,receiptHash:finalBody.receiptHash,decision:'accept'}});
  assert.equal(accepted.status,200);assert.equal(accepted.body.job.revision,63);
  assert.equal([...f.store.data.keys()].filter(p=>p.includes('/revisions/')).length,64);
});
test('tampering an earlier immutable revision breaks the append chain rather than returning unverified state',async()=>{
  const f=fixture();await f.publish();const path=[...f.store.data.keys()].find(p=>p.endsWith('/000.json'));f.store.data.get(path).job.title='tampered';
  const r=await f.call('buyer',suffix);assert.equal(r.status,503);assert.equal(r.body.code,'LEDGER_UNAVAILABLE');
});
test('invitation expiring during external verification cannot commit selection',async()=>{
  let f;f=fixture({selectionVerifier:{verify:async args=>{const value=await goodVerifier.verify(args);f.grants.find(g=>g.role==='operator').expiresAt=T+60001;f.env.NOPE_PROCUREMENT_GRANTS=JSON.stringify(f.grants);f.setTime(T+60001);return value;}},expiresAt:T+60001});
  await f.close();const result=await f.call('operator',suffix+'/selection',{body:{expectedRevision:5,evidenceHash:HASH('ev')}});assert.equal(result.status,401);assert.equal((await f.call('buyer','/health')).status,200);
  f.setTime(T+60000);assert.equal((await f.call('buyer',suffix)).body.job.revision,5);
});
