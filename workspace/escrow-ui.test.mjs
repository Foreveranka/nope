import test from 'node:test';
import assert from 'node:assert/strict';
import {createWorkspace,decisionAllowed,escrowRecordedDelivery,escrowExecutionAllowed,PROFILE,TOKEN_KEY} from '../web/workspace.js';
import {quoteCommitment} from '../web/workspace-vault.mjs';
import {createGarbledJob} from '../web/gc-client.mjs';
import {executeTask} from './gc.mjs';
import {parseCSV} from '../web/csv-input.mjs';

// EXPLICIT OFFLINE API / FINALITY FIXTURES ONLY. No RPC, wallet, live sponsor,
// contract or real-chain payment is exercised or claimed by these UI tests.
const ID='a'.repeat(32),TX='2'.repeat(44),KIND='SPONSORED_TESTNET_ESCROW';
const BUYER={id:'fixture-buyer',role:'buyer',displayName:'Fixture buyer'},PROVIDER={id:'fixture-provider',role:'provider',displayName:'Fixture provider',paymentAccount:'supplier.testnet'};
const FUTURE=String((BigInt(Date.now())+3600000n)*1000000n),PAST=String((BigInt(Date.now())-3600000n)*1000000n);
const basePayment=()=>({kind:KIND,network:'testnet',status:'NOT_FUNDED',verified:false,contractId:'workspace-escrow.testnet',bindingHash:'b'.repeat(64),executionDeadlineNs:FUTURE,reviewDeadlineNs:FUTURE});
let encrypted;
async function cryptoFixture(){
 if(!encrypted)encrypted=(async()=>{const prepared=await createGarbledJob([154,255]),result=await executeTask(prepared.request);return {prepared,result,local:{dataset:parseCSV('private-key,value\nfixture-A,154\nfixture-B,\n'),column:1,values:[154,255],payload:{task:prepared.request}}};})();
 return encrypted;
}
async function fixture({status='AWARDED',payment={},delivery=false}={}){
 const c=await cryptoFixture(),salt='d'.repeat(64),amountYocto='1000000000000000000000';
 const quote={jobId:ID,providerId:PROVIDER.id,amountYocto,deliveryHours:1,salt};
 const job={id:ID,buyerId:BUYER.id,title:'Offline sponsored fixture',description:'Synthetic public task',status,profile:PROFILE,rowCount:2,deadlineISO:new Date(Date.now()+3600000).toISOString(),events:[],payment:{...basePayment(),verified:['HELD','RELEASE_READY','PAID','REFUNDED'].includes(payment.status),...payment},selectedOffer:{providerId:PROVIDER.id,paymentAccount:PROVIDER.paymentAccount,amountYocto},delivery:delivery?{...c.result,version:1}:null,offers:[]};
 job.offers=[{id:'e'.repeat(32),providerId:PROVIDER.id,providerName:PROVIDER.displayName,paymentAccount:PROVIDER.paymentAccount,envelope:{fixture:'NOT-REAL-ENVELOPE'},commitment:await quoteCommitment(ID,PROVIDER.id,amountYocto,salt)}];
 return {job,quote,...c};
}
class Element {
  constructor(tag) { this.tagName = tag.toUpperCase(); this.children = []; this.listeners = {}; this.dataset = {}; this.attributes = {}; this.value = ''; this.disabled = false; this.files = []; }
  set textContent(v) { this.text = String(v); this.children = []; }
  get textContent() { return (this.text || '') + this.children.map(x => x.textContent).join(' '); }
  append(...nodes) { for (const node of nodes) { if (node.parentElement) node.parentElement.children = node.parentElement.children.filter(x => x !== node); node.parentElement = this; this.children.push(node); if (this.tagName === 'SELECT' && this.children.length === 1) this.value = node.value; } }
  replaceChildren(...nodes) { this.children.forEach(n => n.parentElement = null); this.children = []; this.text = ''; this.append(...nodes); }
  addEventListener(name, fn) { (this.listeners[name] ||= []).push(fn); }
  setAttribute(k, v) { this.attributes[k] = v; }
  removeAttribute(k) { delete this.attributes[k]; }
  reportValidity() { return true; }
  async fire(type, event = {}) { for (const fn of this.listeners[type] || []) await fn({ preventDefault() {}, button: 0, ...event }); }
}
function descendants(node) { return [node, ...node.children.flatMap(descendants)]; }
async function settle(app) { for (let i = 0; i < 10000 && app.state.busy; i++) await new Promise(resolve => setTimeout(resolve, 1)); assert.equal(app.state.busy, false, 'UI action settled'); }

function browser(f,{identity=BUYER,path='/payments?id='+ID,local=true,decoded,hook,finalize=true}={}){
 const elements=new Map(['workspace-root','workspace-nav','workspace-identity','workspace-message','workspace-logout','workspace-heading','workspace-subtitle'].map(k=>[k,new Element('div')]));
 const calls=[],timers=new Map();let timerId=0;
 const storage={getItem:key=>key===TOKEN_KEY?'offline-session':null,setItem(){},removeItem(){}};
 const win={location:new URL('http://localhost'+path),sessionStorage:storage,addEventListener(){},navigator:{clipboard:{writeText:async()=>{}}},URL,
  setTimeout:fn=>{const id=++timerId;timers.set(id,fn);return id;},clearTimeout:id=>timers.delete(id),
  history:{pushState:(_,__,href)=>win.location=new URL(href,win.location),replaceState:(_,__,href)=>win.location=new URL(href,win.location)}};
 const all=()=>descendants(elements.get('workspace-root'));
 const doc={getElementById:k=>elements.get(k),createElement:tag=>new Element(tag),addEventListener(){},querySelectorAll:()=>all().filter(n=>['BUTTON','INPUT','SELECT','TEXTAREA'].includes(n.tagName))};
 let savedJob=local?f.local:null;const cryptoCalls={sealedQuotes:0};
 const vault={loadJob:async()=>savedJob,saveJob:async(_,value)=>{savedJob=value;},encryptQuote:async()=>{cryptoCalls.sealedQuotes++;return {fixture:'OFFLINE-NOT-REAL-QUOTE-ENVELOPE'};},decodeDelivery:async(_,labels)=>decoded??f.prepared.decode(Array.isArray(labels)?labels:labels.outputs),decryptQuote:async()=>f.quote};
 const app=createWorkspace({document:doc,window:win,storage,vaultFactory:()=>vault,fetch:async(url,options)=>{
  const route='/'+new URL(url,'http://localhost').searchParams.get('route'),body=options.body===undefined?undefined:JSON.parse(options.body),call={route,method:options.method,body};calls.push(call);
  let data;
  if(route==='/session')data={session:identity};
  else if(route==='/jobs')data={jobs:[f.job]};
  else if(options.method==='GET')data={job:f.job};
  else {
   const action=route.slice(('/jobs/'+ID+'/').length),j=f.job,resuming=action==='payment/'+j.payment.operation?.resumeAction;
   if(action.startsWith('payment/')&&action!=='payment/verify')assert.deepEqual(body,{},'escrow API bodies are exactly empty; no job/price/hash override from UI');
   if(action==='award'){assert.equal(body.offerId,j.offers[0].id);assert.equal(body.amountYocto,f.quote.amountYocto);j.status='AWARDED';}
   else if(action==='offers'){assert.deepEqual(Object.keys(body).sort(),['commitment','envelope']);j.ownOffer={id:'f'.repeat(32),providerId:identity.id};}
   else if(action==='payment/fund'){assert.equal(j.status,'AWARDED');if(!resuming)assert.equal(j.payment.status,'NOT_FUNDED');j.payment.status='FUNDING_PENDING';j.payment.verified=false;j.payment.fundTransactionHash=TX;}
   else if(action==='execute'){
    if(j.payment.kind===KIND)assert.equal(j.payment.status,'HELD');
    j.status='DELIVERED';j.delivery={...f.result,version:(j.delivery?.version||0)+1};
   }
   else if(action==='payment/record'){assert.equal(j.status,'DELIVERED');if(!resuming)assert.equal(j.payment.status,'HELD');j.payment.status='RECORD_PENDING';j.payment.verified=false;j.payment.recordTransactionHash=TX;}
   else if(action==='decision'){
    assert.equal(body.version,j.delivery.version);assert.equal(body.outputSha256,j.delivery.outputSha256);
    if(body.decision==='accept'){
     if(j.payment.kind===KIND){assert.equal(j.payment.status,'HELD');assert.equal(j.payment.recordedVersion,j.delivery.version);assert.equal(j.payment.recordedOutputHash,j.delivery.outputSha256);j.payment.status='RELEASE_READY';}
     else j.payment.status='DUE';
     j.status='ACCEPTED';
    }else j.status='REVISION';
   }
   else if(action==='payment/release'){assert.equal(j.status,'ACCEPTED');if(!resuming)assert.equal(j.payment.status,'RELEASE_READY');j.payment.status='PAYOUT_PENDING';j.payment.verified=false;j.payment.releaseTransactionHash=TX;}
   else if(action==='payment/refund'){assert.notEqual(j.status,'PAID');assert.ok(BigInt(j.payment.reviewDeadlineNs)<BigInt(Date.now())*1000000n);j.payment.status='REFUND_PENDING';j.payment.verified=false;j.payment.refundTransactionHash=TX;}
   else if(action==='payment/refresh'&&finalize){
    if(j.payment.status==='FUNDING_PENDING'){j.payment.status='HELD';j.payment.verified=true;}
    else if(j.payment.status==='RECORD_PENDING'){j.payment.status='HELD';j.payment.verified=true;j.payment.recordedVersion=j.delivery.version;j.payment.recordedOutputHash=j.delivery.outputSha256;}
    else if(j.payment.status==='PAYOUT_PENDING'){j.status='PAID';j.payment.status='PAID';j.payment.verified=true;}
    else if(j.payment.status==='REFUND_PENDING'){j.status='REFUNDED';j.payment.status='REFUNDED';j.payment.verified=true;}
   }
   else if(action==='payment/verify'){assert.ok(body.buyerAccount);assert.ok(body.transactionHash);j.status='PAID';j.payment.status='PAID';j.payment.verified=true;}
   if(resuming)delete j.payment.operation.resumeAction;
   data={job:j};
  }
  const replacement=await hook?.(call,f,data);if(replacement)return replacement;
  return {ok:true,status:200,json:async()=>structuredClone(data)};
 }});
 return {app,calls,all,timers,win,cryptoCalls,get:name=>all().find(e=>e.name===name),text:()=>elements.get('workspace-root').textContent,message:()=>elements.get('workspace-message').textContent,
  has:label=>all().some(e=>e.tagName==='BUTTON'&&e.textContent===label),
  enabled:label=>all().some(e=>e.tagName==='BUTTON'&&e.textContent===label&&!e.disabled),
  click:async label=>{const b=all().find(e=>e.tagName==='BUTTON'&&e.textContent===label);assert.ok(b,label);await b.fire('click');await settle(app);},
  poll:async()=>{const entry=timers.entries().next().value;assert.ok(entry,'a pending-status refresh is scheduled');timers.delete(entry[0]);entry[1]();await settle(app);},
  submit:async()=>{await all().find(e=>e.tagName==='FORM').fire('submit');await settle(app);}
 };
}

test('OFFLINE fixture: award funds once, finalized HELD unlocks execution, provider records, buyer reference accepts and exact payout finalizes',async()=>{
 const f=await fixture({status:'CLOSED'}),buyer=browser(f,{path:'/job?id='+ID});await buyer.app.start();
 assert.ok(buyer.text().includes('sonlu'));const consent=buyer.all().find(e=>e.type==='checkbox');assert.ok(consent.parentElement.textContent.includes('zincirde herkese açık'));consent.checked=true;
 await buyer.click('Bu sağlayıcıyı seç');assert.equal(f.job.payment.status,'FUNDING_PENDING');assert.equal(buyer.calls.filter(c=>c.route.endsWith('/payment/fund')).length,1);
 assert.equal(buyer.has('Sponsor havuzundan fon ayır'),false);await buyer.poll();assert.equal(f.job.payment.status,'HELD');
 const provider=browser(f,{identity:PROVIDER,path:'/delivery?id='+ID});await provider.app.start();await provider.click('Şifreli işi yürüt ve teslim et');
 const writes=provider.calls.filter(c=>c.method==='POST');assert.deepEqual(writes.map(c=>c.route.split('/').slice(-2).join('/')),[''+ID+'/execute','payment/record']);assert.equal(f.job.payment.status,'RECORD_PENDING');
 const awaiting=browser(f,{path:'/delivery?id='+ID});await awaiting.app.start();assert.ok(awaiting.text().includes('Yerel kontrol başarılı'));assert.equal(awaiting.enabled('Doğrulanan teslimi kabul et'),false);
 await provider.poll();assert.equal(f.job.payment.status,'HELD');assert.equal(f.job.payment.recordedVersion,1);assert.equal(f.job.payment.recordedOutputHash,f.job.delivery.outputSha256);
 const verified=browser(f,{path:'/delivery?id='+ID});await verified.app.start();assert.ok(verified.enabled('Doğrulanan teslimi kabul et'));await verified.click('Doğrulanan teslimi kabul et');
 assert.equal(f.job.status,'ACCEPTED');assert.equal(f.job.payment.status,'PAYOUT_PENDING');assert.ok(!verified.text().includes('Durum: Zincirde ödeme doğrulandı'));
 const decision=verified.calls.find(c=>c.route.endsWith('/decision'));assert.deepEqual(decision.body,{decision:'accept',version:1,outputSha256:f.job.delivery.outputSha256});assert.deepEqual(verified.calls.find(c=>c.route.endsWith('/payment/release')).body,{});
 await verified.poll();assert.equal(f.job.status,'PAID');assert.ok(verified.text().includes('Durum: Zincirde ödeme doğrulandı'));
 assert.equal(verified.has('Kabul edilen teslimin ödemesini serbest bırak'),false);assert.equal(verified.has('Sponsor havuzundan fon ayır'),false);
 const links=verified.all().filter(e=>e.tagName==='A'&&e.href?.includes('nearblocks.io'));assert.equal(links.length,3);assert.ok(links.every(e=>e.href==='https://testnet.nearblocks.io/txns/'+TX&&e.rel==='noopener noreferrer'));
});

test('OFFLINE fixture: missing/pending/unknown funding disables provider execution without sending any action',async()=>{
 for(const status of ['NOT_FUNDED','FUNDING_PENDING','UNKNOWN','ERROR','REFUND_PENDING','REFUNDED']){
  const f=await fixture({payment:{status}}),provider=browser(f,{identity:PROVIDER,path:'/delivery?id='+ID,finalize:false});await provider.app.start();
  const execute=provider.all().find(e=>e.textContent==='Şifreli işi yürüt ve teslim et');assert.equal(execute.disabled,true,status);
  await provider.click('Şifreli işi yürüt ve teslim et');assert.equal(provider.calls.filter(c=>c.method==='POST').length,0,status);
 }
});

test('OFFLINE fixture: buyer can finish recording; stale version/hash and wrong local result never offer acceptance',async()=>{
 const f=await fixture({status:'DELIVERED',payment:{status:'HELD'},delivery:true});
 for(const fields of [{},{recordedVersion:0,recordedOutputHash:f.job.delivery.outputSha256},{recordedVersion:1,recordedOutputHash:'f'.repeat(64)}]){
  Object.assign(f.job.payment,{recordedVersion:undefined,recordedOutputHash:undefined},fields);
  const buyer=browser(f,{path:'/delivery?id='+ID});await buyer.app.start();assert.equal(buyer.enabled('Doğrulanan teslimi kabul et'),false);assert.ok(buyer.has('Son teslimi zincirde kaydet'));
 }
 const buyer=browser(f,{path:'/delivery?id='+ID});await buyer.app.start();await buyer.click('Son teslimi zincirde kaydet');assert.equal(f.job.payment.status,'RECORD_PENDING');assert.equal(buyer.enabled('Doğrulanan teslimi kabul et'),false);await buyer.poll();assert.ok(buyer.enabled('Doğrulanan teslimi kabul et'));
 const incorrect=browser(f,{path:'/delivery?id='+ID,decoded:[99,0]});await incorrect.app.start();assert.equal(incorrect.enabled('Doğrulanan teslimi kabul et'),false);assert.ok(incorrect.text().includes('Yerel kontrol başarısız'));
 const missing=browser(f,{path:'/delivery?id='+ID,local:false});await missing.app.start();assert.equal(missing.enabled('Doğrulanan teslimi kabul et'),false);
});

test('OFFLINE fixture: rejected delivery revision retains funding but requires final recording of the new version',async()=>{
 const f=await fixture({status:'DELIVERED',payment:{status:'HELD'},delivery:true});Object.assign(f.job.payment,{recordedVersion:1,recordedOutputHash:f.job.delivery.outputSha256});
 const buyer=browser(f,{path:'/delivery?id='+ID});await buyer.app.start();await buyer.click('Düzeltme iste');assert.equal(f.job.status,'REVISION');assert.equal(f.job.payment.status,'HELD');
 const provider=browser(f,{identity:PROVIDER,path:'/delivery?id='+ID});await provider.app.start();await provider.click('Düzeltmeyi yeniden yürüt');assert.equal(f.job.delivery.version,2);assert.equal(f.job.payment.status,'RECORD_PENDING');assert.equal(f.job.payment.recordedVersion,1);
 const before=browser(f,{path:'/delivery?id='+ID});await before.app.start();assert.equal(before.enabled('Doğrulanan teslimi kabul et'),false);await provider.poll();
 const after=browser(f,{path:'/delivery?id='+ID});await after.app.start();assert.ok(after.enabled('Doğrulanan teslimi kabul et'));assert.equal(f.job.payment.recordedVersion,2);assert.equal(provider.calls.filter(c=>c.route.endsWith('/payment/fund')).length,0);
});

test('OFFLINE fixture: ambiguous release requires reconciliation before explicit recovery and never resends automatically',async()=>{
 const f=await fixture({status:'DELIVERED',payment:{status:'HELD'},delivery:true});Object.assign(f.job.payment,{recordedVersion:1,recordedOutputHash:f.job.delivery.outputSha256});
 let lost=true;
 const buyer=browser(f,{path:'/delivery?id='+ID,hook:call=>{if(call.route.endsWith('/payment/release')&&lost){lost=false;f.job.payment.status='RELEASE_READY';f.job.payment.verified=true;throw Error('OFFLINE lost reply before known broadcast');}}});
 await buyer.app.start();await buyer.click('Doğrulanan teslimi kabul et');assert.equal(f.job.status,'ACCEPTED');assert.equal(buyer.has('Kabul edilen teslimin ödemesini serbest bırak'),false);assert.match(buyer.message(),/sonucu doğrulanamadı/);
 assert.equal(buyer.calls.filter(c=>c.route.endsWith('/payment/release')).length,1);assert.equal(buyer.timers.size,0);
 await buyer.click('Escrow durumunu yenile');assert.ok(buyer.has('Kabul edilen teslimin ödemesini serbest bırak'));await buyer.click('Kabul edilen teslimin ödemesini serbest bırak');assert.equal(f.job.payment.status,'PAYOUT_PENDING');
 await buyer.poll();assert.equal(f.job.status,'PAID');assert.equal(buyer.calls.filter(c=>c.route.endsWith('/payment/release')).length,2,'second call needs explicit recovery after refresh');
});

test('OFFLINE fixture: lost committed fund response reconciles existing operation rather than sending another fund',async()=>{
 const f=await fixture();let lost=true;const buyer=browser(f,{hook:call=>{if(call.route.endsWith('/payment/fund')&&lost){lost=false;throw Error('OFFLINE committed fund lost response');}}});
 await buyer.app.start();await buyer.click('Sponsor havuzundan fon ayır');assert.equal(f.job.payment.status,'FUNDING_PENDING');assert.equal(buyer.has('Sponsor havuzundan fon ayır'),false);
 await buyer.click('Escrow durumunu yenile');assert.equal(f.job.payment.status,'HELD');assert.equal(buyer.calls.filter(c=>c.route.endsWith('/payment/fund')).length,1);
});

test('OFFLINE fixture: expiry only offers explicit refund to sponsor pool; no silent payout and no actions after terminal refund',async()=>{
 const f=await fixture({payment:{status:'HELD',reviewDeadlineNs:PAST,executionDeadlineNs:PAST}}),buyer=browser(f);await buyer.app.start();
 assert.equal(buyer.calls.filter(c=>c.method==='POST').length,0);assert.ok(buyer.text().includes('iade ziyaretçiye değil sponsor havuzuna döner'));
 await buyer.click('Süre doldu · ayrılan fonu sponsor havuzuna döndür');assert.equal(f.job.payment.status,'REFUND_PENDING');assert.notEqual(f.job.status,'REFUNDED');await buyer.poll();assert.equal(f.job.status,'REFUNDED');assert.equal(f.job.payment.status,'REFUNDED');assert.equal(buyer.has('Süre doldu · ayrılan fonu sponsor havuzuna döndür'),false);
 const future=browser(await fixture({payment:{status:'HELD'}}));await future.app.start();assert.equal(future.has('Süre doldu · ayrılan fonu sponsor havuzuna döndür'),false);
});

test('OFFLINE fixture: pending polling calls refresh only, is bounded and stops on navigation; malformed public metadata cannot create explorer links',async()=>{
 const f=await fixture({payment:{status:'PAYOUT_PENDING',releaseTransactionHash:TX}}),buyer=browser(f,{finalize:false});await buyer.app.start();
 for(let i=0;i<12;i++)await buyer.poll();assert.equal(buyer.timers.size,0);assert.ok(buyer.text().includes('Otomatik kontrol durdu'));assert.ok(buyer.calls.filter(c=>c.method==='POST').every(c=>c.route.endsWith('/payment/refresh')));
 const other=browser(await fixture({payment:{status:'FUNDING_PENDING'}}),{finalize:false});await other.app.start();assert.equal(other.timers.size,1);await other.app.navigate('/customer');assert.equal(other.timers.size,0);
 for(const payment of [{network:'mainnet',releaseTransactionHash:TX},{contractId:'escrow.near',releaseTransactionHash:TX},{bindingHash:'bad',releaseTransactionHash:TX},{releaseTransactionHash:'https://evil.invalid/'},{status:'FUTURE_UNKNOWN',releaseTransactionHash:TX}]){
  const invalid=browser(await fixture({payment}));await invalid.app.start();assert.equal(invalid.all().filter(e=>e.href?.includes('nearblocks.io')).length,0);assert.equal(invalid.has('Sponsor havuzundan fon ayır'),payment.releaseTransactionHash==='https://evil.invalid/','bad hash is omitted; otherwise valid metadata may still fund');
 }
});

test('OFFLINE legacy direct-transfer fixture keeps wallet/receipt flow and never calls sponsored endpoints',async()=>{
 const f=await fixture({status:'ACCEPTED',payment:{kind:'DIRECT_TESTNET_TRANSFER',status:'DUE'}}),buyer=browser(f);await buyer.app.start();
 assert.ok(buyer.text().includes('Doğrudan transfer · escrow değil'));assert.ok(buyer.all().some(e=>e.href==='https://testnet.mynearwallet.com/'));assert.equal(buyer.has('Sponsor havuzundan fon ayır'),false);
 buyer.get('buyerAccount').value='legacy-buyer.testnet';buyer.get('transactionHash').value=TX;await buyer.submit();assert.equal(f.job.status,'PAID');
 const sent=buyer.calls.filter(c=>c.method==='POST');assert.equal(sent.length,1);assert.ok(sent[0].route.endsWith('/payment/verify'));assert.deepEqual(sent[0].body,{buyerAccount:'legacy-buyer.testnet',transactionHash:TX});
});

test('OFFLINE fixture: unavailable sponsor/API and unknown finality only allow reconciliation, never a blind second send',async()=>{
 const f=await fixture(),buyer=browser(f,{hook:call=>call.route.endsWith('/payment/fund')?{ok:false,status:503,json:async()=>({code:'ESCROW_UNKNOWN_FINALITY'})}:undefined,finalize:false});await buyer.app.start();
 const original=buyer.all().find(e=>e.textContent==='Sponsor havuzundan fon ayır');await buyer.click('Sponsor havuzundan fon ayır');assert.match(buyer.message(),/sonucu doğrulanamadı/);assert.equal(buyer.has('Sponsor havuzundan fon ayır'),false);
 await original.fire('click');await settle(buyer.app);assert.equal(buyer.calls.filter(c=>c.route.endsWith('/payment/fund')).length,1);
 f.job.payment.status='UNKNOWN';await buyer.click('Escrow durumunu yenile');assert.equal(buyer.has('Sponsor havuzundan fon ayır'),false);assert.equal(buyer.has('Kabul edilen teslimin ödemesini serbest bırak'),false);assert.equal(buyer.timers.size,0);
 const expired=browser(await fixture({payment:{executionDeadlineNs:PAST}}));await expired.app.start();assert.equal(expired.has('Sponsor havuzundan fon ayır'),false);
});

test('OFFLINE fixture: UI never reports Paid or Refunded from contradictory terminal payment metadata',async()=>{
 for(const status of ['PAID','REFUNDED']){
  const buyer=browser(await fixture({status:'ACCEPTED',payment:{status}}));await buyer.app.start();assert.ok(buyer.text().includes('Bilinmeyen veya eksik testnet ödeme bilgisi'));
  assert.ok(!buyer.text().includes('Durum: Zincirde ödeme doğrulandı'));assert.equal(buyer.has('Kabul edilen teslimin ödemesini serbest bırak'),false);
 }
});

test('OFFLINE fixture: unverified HELD and unrecorded revisions cannot bypass finality or skip a delivery version',async()=>{
 const f=await fixture({status:'DELIVERED',payment:{status:'HELD'},delivery:true});const buyer=browser(f,{path:'/delivery?id='+ID});await buyer.app.start();
 for(const label of ['Doğrulanan teslimi kabul et','Düzeltme iste']){const button=buyer.all().find(e=>e.tagName==='BUTTON'&&e.textContent===label);assert.equal(button.disabled,true);await buyer.click(label);}
 assert.equal(buyer.calls.filter(c=>c.route.endsWith('/decision')).length,0,'both handlers reject unrecorded decisions even if a disabled button is triggered');
 Object.assign(f.job.payment,{verified:false,recordedVersion:1,recordedOutputHash:f.job.delivery.outputSha256});
 const unverified=browser(f,{path:'/delivery?id='+ID});await unverified.app.start();assert.equal(unverified.enabled('Doğrulanan teslimi kabul et'),false);assert.equal(escrowRecordedDelivery(f.job),false);
 f.job.status='AWARDED';assert.equal(escrowExecutionAllowed(f.job),false);
});

test('OFFLINE fixture: both decision buttons require HELD verified and the exact latest version/hash after final recording',async()=>{
 const f=await fixture({status:'DELIVERED',payment:{status:'HELD'},delivery:true});
 for(const fields of [
  {status:'RECORD_PENDING',verified:false,recordedVersion:1,recordedOutputHash:f.job.delivery.outputSha256},
  {status:'HELD',verified:true,recordedVersion:0,recordedOutputHash:f.job.delivery.outputSha256},
  {status:'HELD',verified:true,recordedVersion:1,recordedOutputHash:'f'.repeat(64)},
  {status:'RELEASE_READY',verified:true,recordedVersion:1,recordedOutputHash:f.job.delivery.outputSha256},
 ]){
  Object.assign(f.job.payment,fields);const buyer=browser(f,{path:'/delivery?id='+ID});await buyer.app.start();
  for(const label of ['Doğrulanan teslimi kabul et','Düzeltme iste']){assert.equal(buyer.enabled(label),false);await buyer.click(label);}
  assert.equal(buyer.calls.filter(c=>c.route.endsWith('/decision')).length,0);
 }
 Object.assign(f.job.payment,{status:'HELD',verified:true,recordedVersion:1,recordedOutputHash:f.job.delivery.outputSha256});const ready=browser(f,{path:'/delivery?id='+ID});await ready.app.start();
 assert.equal(ready.enabled('Doğrulanan teslimi kabul et'),true);assert.equal(ready.enabled('Düzeltme iste'),true);
});

test('OFFLINE fixture: accepted unpaid hold refunds only after deadline; expired release is disabled and guarded',async()=>{
 const f=await fixture({status:'ACCEPTED',payment:{status:'RELEASE_READY',reviewDeadlineNs:PAST},delivery:true});Object.assign(f.job.payment,{recordedVersion:1,recordedOutputHash:f.job.delivery.outputSha256});
 const buyer=browser(f);await buyer.app.start();assert.equal(buyer.enabled('Kabul edilen teslimin ödemesini serbest bırak'),false);assert.equal(buyer.enabled('Süre doldu · ayrılan fonu sponsor havuzuna döndür'),true);
 await buyer.click('Kabul edilen teslimin ödemesini serbest bırak');assert.equal(buyer.calls.filter(c=>c.method==='POST').length,0);
 await buyer.click('Süre doldu · ayrılan fonu sponsor havuzuna döndür');await buyer.poll();assert.equal(f.job.status,'REFUNDED');assert.ok(!buyer.calls.some(c=>c.route.endsWith('/payment/release')));
 for(const status of ['PAYOUT_PENDING','UNKNOWN','ERROR','PAID','REFUND_PENDING']){
  const blocked=browser(await fixture({status:'ACCEPTED',payment:{status,reviewDeadlineNs:PAST}}));await blocked.app.start();assert.equal(blocked.has('Süre doldu · ayrılan fonu sponsor havuzuna döndür'),false,status);
 }
 const future=browser(await fixture({status:'ACCEPTED',payment:{status:'RELEASE_READY'},delivery:true}));await future.app.start();assert.equal(future.has('Süre doldu · ayrılan fonu sponsor havuzuna döndür'),false);
});

test('OFFLINE fixture: each backend-authorized unsent operation resumes only by an explicit named empty-body POST',async()=>{
 const labels={fund:'fon ayırma',record:'teslim kaydı',release:'ödeme',refund:'sponsor havuzuna dönüş'};
 for(const action of ['fund','record','release','refund']){
  const f=await fixture({status:action==='fund'?'AWARDED':action==='record'?'DELIVERED':'ACCEPTED',payment:{status:{fund:'FUNDING_PENDING',record:'RECORD_PENDING',release:'PAYOUT_PENDING',refund:'REFUND_PENDING'}[action],verified:false,reviewDeadlineNs:action==='refund'?PAST:FUTURE,operation:{action,status:'PENDING',operationId:'e'.repeat(64),resumeAction:action}},delivery:true});
  Object.assign(f.job.payment,{recordedVersion:1,recordedOutputHash:f.job.delivery.outputSha256});
  const buyer=browser(f,{finalize:false});await buyer.app.start();const label='Mevcut imzalı işlemi sürdür · '+labels[action];assert.equal(buyer.enabled(label),true,action);assert.equal(buyer.calls.filter(c=>c.method==='POST').length,0,'resume is never automatic');
  await buyer.click(label);const mutations=buyer.calls.filter(c=>c.method==='POST');assert.equal(mutations.length,1);assert.equal(mutations[0].route,'/jobs/'+ID+'/payment/'+action);assert.deepEqual(mutations[0].body,{});assert.equal(buyer.has(label),false,'authorization disappears after the backend consumes it');
  await buyer.poll();assert.ok(buyer.calls.filter(c=>c.method==='POST').slice(1).every(c=>c.route.endsWith('/payment/refresh')),'polling does not resume or send again');
 }
});

test('OFFLINE fixture: resume never infers safety from a hash/code and rejects unknown, sent, mismatched or expired authorization',async()=>{
 for(const payment of [
  {status:'UNKNOWN',operation:{action:'fund',status:'UNKNOWN',resumeAction:'fund'}},
  {status:'ERROR',operation:{action:'fund',status:'PENDING',resumeAction:'fund'}},
  {status:'ERROR',fundTransactionHash:TX,code:'ESCROW_GAS_ALLOWANCE_INSUFFICIENT',operation:{action:'fund',status:'ERROR'}},
  {status:'FUNDING_PENDING',operation:{action:'fund',status:'PENDING',resumeAction:'fund/../../release'}},
  {status:'ERROR',operation:{action:'record',status:'PENDING',resumeAction:'fund'}},
  {status:'ERROR',operation:{action:'fund',status:'FINAL',resumeAction:'fund'}},
  {status:'ERROR',executionDeadlineNs:PAST,operation:{action:'fund',status:'PENDING',resumeAction:'fund'}},
 ]){
  const buyer=browser(await fixture({payment}),{finalize:false});await buyer.app.start();assert.ok(!buyer.all().some(e=>e.tagName==='BUTTON'&&e.textContent.startsWith('Mevcut imzalı işlemi sürdür')));assert.equal(buyer.calls.filter(c=>c.method==='POST').length,0);
 }
 const release=await fixture({status:'ACCEPTED',payment:{status:'ERROR',reviewDeadlineNs:PAST,operation:{action:'release',status:'PENDING',resumeAction:'release'}},delivery:true});Object.assign(release.job.payment,{recordedVersion:1,recordedOutputHash:release.job.delivery.outputSha256});
 const expired=browser(release);await expired.app.start();assert.equal(expired.has('Mevcut imzalı işlemi sürdür · ödeme'),false);
 const f=await fixture({payment:{status:'FUNDING_PENDING',operation:{action:'fund',status:'PENDING',resumeAction:'fund'}}}),provider=browser(f,{identity:PROVIDER});await provider.app.start();assert.equal(provider.has('Mevcut imzalı işlemi sürdür · fon ayırma'),false);
});

test('OFFLINE fixture: lost resume response blocks another send until refresh removes stale backend authorization',async()=>{
 const f=await fixture({payment:{status:'FUNDING_PENDING',operation:{action:'fund',status:'PENDING',resumeAction:'fund'}}});let lost=true;
 const buyer=browser(f,{hook:call=>{if(call.route.endsWith('/payment/fund')&&lost){lost=false;throw Error('OFFLINE lost resume response after backend consumes authorization');}}});await buyer.app.start();
 const label='Mevcut imzalı işlemi sürdür · fon ayırma',original=buyer.all().find(e=>e.tagName==='BUTTON'&&e.textContent===label);await buyer.click(label);assert.equal(buyer.has(label),false);await original.fire('click');await settle(buyer.app);assert.equal(buyer.calls.filter(c=>c.route.endsWith('/payment/fund')).length,1);
 await buyer.click('Escrow durumunu yenile');assert.equal(f.job.payment.status,'HELD');assert.equal(buyer.has(label),false);
});

test('OFFLINE fixture: refresh may expose a safe pending resume hint after ERROR without signing or sending automatically',async()=>{
 const f=await fixture({payment:{status:'ERROR',verified:false,code:'ESCROW_GAS_ALLOWANCE_INSUFFICIENT',operation:{action:'fund',status:'ERROR'}}});
 const buyer=browser(f,{finalize:false,hook:call=>{if(call.route.endsWith('/payment/refresh')){f.job.payment.status='FUNDING_PENDING';f.job.payment.operation={action:'fund',status:'PENDING',operationId:'e'.repeat(64),resumeAction:'fund'};}}});await buyer.app.start();
 const label='Mevcut imzalı işlemi sürdür · fon ayırma';assert.equal(buyer.has(label),false);await buyer.click('Escrow durumunu yenile');assert.equal(buyer.enabled(label),true);assert.equal(buyer.calls.filter(c=>c.route.endsWith('/payment/fund')).length,0);
 await buyer.click(label);assert.equal(buyer.calls.filter(c=>c.route.endsWith('/payment/fund')).length,1);
});

test('OFFLINE fixture: sponsored offer max is displayed and enforced before sealing while legacy offers keep their range',async()=>{
 const f=await fixture({status:'OPEN'}),supplier=browser(f,{identity:PROVIDER,path:'/offer?id='+ID});await supplier.app.start();assert.ok(supplier.text().includes('0.01 testNEAR'));supplier.get('amount').value='0.010000000000000000000001';await supplier.submit();assert.equal(supplier.cryptoCalls.sealedQuotes,0);assert.equal(supplier.calls.filter(c=>c.method==='POST').length,0);assert.match(supplier.message(),/en fazla 0.01/);
 supplier.get('amount').value='0.01';await supplier.submit();assert.equal(supplier.cryptoCalls.sealedQuotes,1);assert.equal(supplier.calls.filter(c=>c.route.endsWith('/offers')).length,1);
 const legacy=await fixture({status:'OPEN',payment:{kind:'DIRECT_TESTNET_TRANSFER'}}),old=browser(legacy,{identity:PROVIDER,path:'/offer?id='+ID});await old.app.start();old.get('amount').value='0.02';await old.submit();assert.equal(old.calls.filter(c=>c.route.endsWith('/offers')).length,1,'legacy direct jobs are not subjected to the sponsor cap');
});

test('OFFLINE fixture: finalized Paid in release response or following render replaces the stale checking banner',async()=>{
 for(const timing of ['release-response','render-GET']){
  const f=await fixture({status:'DELIVERED',payment:{status:'HELD'},delivery:true});Object.assign(f.job.payment,{recordedVersion:1,recordedOutputHash:f.job.delivery.outputSha256});let released=false;
  const buyer=browser(f,{path:'/delivery?id='+ID,hook:call=>{
   if(call.route.endsWith('/payment/release'))released=true;
   if(released&&(timing==='release-response'||call.method==='GET')){f.job.status='PAID';f.job.payment.status='PAID';f.job.payment.verified=true;}
  }});await buyer.app.start();await buyer.click('Doğrulanan teslimi kabul et');
  assert.ok(buyer.text().includes('Durum: Zincirde ödeme doğrulandı'));assert.match(buyer.message(),/zincirde kesinleşti/);assert.ok(!buyer.message().includes('kontrol ediliyor'),timing);
  assert.equal(buyer.calls.filter(c=>c.route.endsWith('/payment/release')).length,1);
 }
});
