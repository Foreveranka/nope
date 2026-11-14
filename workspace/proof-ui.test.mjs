import test from 'node:test';
import assert from 'node:assert/strict';
import {createWorkspace,createPayload,PROOF_PROFILE,TOKEN_KEY,runProofWorker,hashPublicProofBundle,decisionAllowed} from '../web/workspace.js';
import {prepareProofPlan} from '../web/proof-plan-client.mjs';
import {SCHEME,finalProofContext,hashProofManifest,wrapProofPlanResult} from '../web/proof-plan-core.mjs';
import {acceptAgentProposal} from '../web/agent-plan.mjs';
import {sha256} from '../web/gc-core.mjs';
import {parseCSV} from '../web/csv-input.mjs';
import {createVault} from '../web/workspace-vault.mjs';
import {executeTask} from './gc.mjs';

// UNIT UI / WORKER / SERVER FIXTURES ONLY. Preparation, GC and vault encryption
// are real local code; proof-worker responses and API verification are mocked.
// This file is NOT evidence of actual SNARK proving, model accuracy or chain use.
const ID='a'.repeat(32),CONTRACT='proof-ui.testnet',BINDING='b'.repeat(64);
const wallet=accountId=>({accountId,publicKey:'ed25519:'+ '1'.repeat(32),network:'testnet',verifiedAt:'2026-11-14T00:00:00Z'});
const POLICY={network:'testnet',contractId:CONTRACT,codeHash:'2'.repeat(44),domain:'NOPE:WALLET-ESCROW:V2:testnet',requireKeyless:true,storageDepositYocto:'40960000000000000000000'};
const WALLET_CAPABILITY={required:true,enabled:true,network:'testnet',contractId:CONTRACT};
const BUYER={id: (await sha256('NOPE:wallet-session:v1:testnet:buyer:proof-buyer.testnet')).slice(0,32),role:'buyer',displayName:'Unit buyer',wallet:wallet('proof-buyer.testnet')};
const TASK={version:1,goal:'Fill C1 blanks with 7.',columns:[{id:'C1',type:'number'}]};
const STEPS=[{column:'C1',recipe:{type:'number',steps:[{op:'fill',value:7}]}}];
const CSV='private-score,private-keep\n,secret-value\n';
const FUTURE=String((BigInt(Date.now())+86400000n)*1000000n);
class LocalStorage {
 records=new Map();
 async get(key){return structuredClone(this.records.get(JSON.stringify(key)));}
 async put(key,value){this.records.set(JSON.stringify(key),structuredClone(value));}
 async installKeys(key,value){const k=JSON.stringify(key);if(!this.records.has(k))this.records.set(k,structuredClone(value));return structuredClone(this.records.get(k));}
 async deleteSession(session){for(const key of this.records.keys())if(JSON.parse(key)[0]===session)this.records.delete(key);}
}
let preparedFixture;
async function baseFixture(){
 if(!preparedFixture)preparedFixture=(async()=>{
  const approval=await acceptAgentProposal(TASK,{steps:STEPS}),dataset=parseCSV(CSV),values={C1:[255]};
  const prepared=await prepareProofPlan(values,approval.plan,{jobId:ID,buyerCommitment:await sha256('NOPE:buyer:'+BUYER.id),contractId:CONTRACT});
  const result=await wrapProofPlanResult(prepared.request,await executeTask(prepared.request.task));
  return {approval:{...approval,datasetSha256:await sha256(JSON.stringify(dataset)),model:{id:'UNIT-ONLY-MODEL',revision:'fixture'}},dataset,values,prepared,result};
 })();return preparedFixture;
}
const bindingFor=job=>({jobId:job.id,version:job.delivery.version,contractId:job.payment.contractId,bindingHash:job.payment.bindingHash,provider:job.selectedOffer.paymentAccount,amountYocto:job.selectedOffer.amountYocto});
async function fixture(){
 const base=await baseFixture(),store=new LocalStorage(),vault=createVault(BUYER.id,{storage:store});
 const local={dataset:base.dataset,values:base.values,agentApproval:base.approval,payload:{jobId:ID,profile:PROOF_PROFILE,task:base.prepared.request,publicTask:TASK},proofDecoder:base.prepared.decoder,proofWitness:base.prepared.witness};
 await vault.saveJob(ID,local);
 const job={id:ID,buyerId:BUYER.id,buyerWallet:structuredClone(BUYER.wallet),title:'UNIT v4 proof task',description:'Public fixture',profile:PROOF_PROFILE,status:'DELIVERED',rowCount:1,publicTask:TASK,plan:base.approval.plan,planSha256:base.approval.planSha256,deadlineISO:new Date(Date.now()+3600000).toISOString(),events:[],offers:[],delivery:{...base.result,version:1},selectedOffer:{providerId:'unit-provider',wallet:wallet('supplier.testnet'),paymentAccount:'supplier.testnet',amountYocto:'1000000000000000000000'},payment:{kind:'WALLET_TESTNET_ESCROW',network:'testnet',status:'HELD',verified:true,contractId:CONTRACT,bindingHash:BINDING,executionDeadlineNs:FUTURE,reviewDeadlineNs:FUTURE,recordedVersion:1,recordedOutputHash:base.result.outputSha256}};
 const bundle={version:1,scheme:SCHEME,finalContext:await finalProofContext(base.prepared.request,job.delivery,bindingFor(job)),rows:[{column:'C1',row:0,proof:{fixture:'UNIT-ONLY-NOT-A-REAL-SNARK'}}]};
 async function metadata(){return {status:'VERIFIED',scheme:SCHEME,version:1,bundleSha256:await hashPublicProofBundle(bundle),finalContext:bundle.finalContext,requestSha256:job.delivery.inputSha256,manifestSha256:await hashProofManifest(base.prepared.request),programSha256:job.delivery.programSha256,planSha256:job.planSha256,deliveryVersion:job.delivery.version,outputSha256:job.delivery.outputSha256,bindingHash:BINDING,rowProofCount:1};}
 return {...base,store,vault,local,job,bundle,metadata};
}
function workers(f,{invalid=false,onPost,hold=false}={}){
 const messages=[],instances=[];
 return {messages,instances,factory:()=>{const worker={terminate(){this.terminated=true;},postMessage(value){messages.push(structuredClone(value));onPost?.(value,worker);if(hold)return;queueMicrotask(()=>{this.onmessage({data:{type:'progress',completed:1,total:1}});this.onmessage({data:value.type==='prove'?{type:'proof',bundle:f.bundle}:{type:'verified',valid:!invalid}});});}};instances.push(worker);return worker;}};
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

function browser(f,{path='/delivery?id='+ID,capability={profile:PROOF_PROFILE,enabled:true,contractId:CONTRACT},worker,identity=BUYER,walletCapability=WALLET_CAPABILITY,walletPolicy=POLICY,garbleProofPlan,garblePlan,hook,proposalSteps=STEPS}={}){
 const elements=new Map(['workspace-root','workspace-nav','workspace-identity','workspace-message','workspace-logout','workspace-heading','workspace-subtitle'].map(k=>[k,new Element('div')]));
 const storage={getItem:()=> 'unit-token',setItem(){},removeItem(){}},events={},timers=new Map();let timerId=0;
 const win={location:new URL('http://localhost'+path),sessionStorage:storage,addEventListener:(k,fn)=>events[k]=fn,
  setTimeout:fn=>{const id=++timerId;timers.set(id,fn);return id;},clearTimeout:id=>timers.delete(id),
  history:{pushState:(_,__,href)=>win.location=new URL(href,win.location),replaceState:(_,__,href)=>win.location=new URL(href,win.location)}};
 const all=()=>descendants(elements.get('workspace-root'));
 const doc={getElementById:k=>elements.get(k),createElement:tag=>new Element(tag),addEventListener(){},querySelectorAll:()=>all().filter(n=>['BUTTON','INPUT','SELECT','TEXTAREA'].includes(n.tagName))};
 const modelFactory=()=>({terminate(){},postMessage(){queueMicrotask(()=>this.onmessage({data:{type:'plan',raw:JSON.stringify({steps:proposalSteps}),model:{id:'UNIT-ONLY-MODEL',revision:'fixture'}}}));}});
 const calls=[];const app=createWorkspace({document:doc,window:win,storage,walletPolicy,walletFactory:async()=>{throw Error('This proof test must not request a wallet signature');},proofWorkerFactory:worker?.factory,agentWorkerFactory:modelFactory,garbleProofPlan,garblePlan,vaultFactory:()=>createVault(BUYER.id,{storage:f.store}),fetch:async(url,options)=>{
  const route='/'+new URL(url,'http://localhost').searchParams.get('route'),body=options.body?JSON.parse(options.body):undefined,call={route,body,method:options.method};calls.push(call);let data;
  if(route==='/session')data={session:identity,proof:capability,wallet:walletCapability};
  else if(route==='/jobs'&&options.method==='POST'){
   f.request=body.task;f.job={...f.job,id:body.jobId,status:'OPEN',profile:body.profile,rowCount:body.rowCount,publicTask:body.publicTask,plan:body.task.task?.plan||body.task.plan,planSha256:body.task.task?.planSha256||body.task.planSha256,delivery:null,selectedOffer:null,proof:undefined};data={job:f.job};
  }else if(route==='/jobs')data={jobs:[f.job]};
  else if(route.endsWith('/proof/evidence'))data={version:1,network:'testnet',jobId:f.job.id,task:f.prepared.request,delivery:f.job.delivery,binding:bindingFor(f.job),walletBuyerAccount:f.job.buyerWallet.accountId,proof:f.job.proof,bundle:f.bundle};
  else if(route.endsWith('/task'))data={task:f.prepared.request};
  else if(route.endsWith('/proof')&&options.method==='POST'){
   assert.deepEqual(Object.keys(body).sort(),['bundle','outputSha256','version']);assert.equal(body.version,f.job.delivery.version);assert.equal(body.outputSha256,f.job.delivery.outputSha256);
   f.job.proof=await f.metadata();data={job:f.job};
  }else if(route.endsWith('/decision')){
   assert.equal(body.version,f.job.delivery.version);assert.equal(body.outputSha256,f.job.delivery.outputSha256);
   f.job.status=body.decision==='accept'?'ACCEPTED':'REVISION';if(body.decision==='accept')f.job.payment.status='RELEASE_READY';data={job:f.job};
  }else if(route.includes('/payment/')&&options.method==='POST'){assert.fail('Proof/acceptance must not automatically request a payment: '+route);}
  else data={job:f.job};
  const custom=await hook?.(call,f,data);if(custom)return custom;return {ok:true,status:200,json:async()=>structuredClone(data)};
 }});
 return {app,calls,all,win,events,elements,get:name=>all().find(e=>e.name===name),text:()=>elements.get('workspace-root').textContent,message:()=>elements.get('workspace-message').textContent,
  enabled:label=>all().some(e=>e.tagName==='BUTTON'&&e.textContent===label&&!e.disabled),
  click:async label=>{const button=all().find(e=>e.tagName==='BUTTON'&&e.textContent===label);assert.ok(button,label);await button.fire('click');await settle(app);},
  change:async(name,value)=>{const input=all().find(e=>e.name===name);assert.ok(input,name);if(input.type==='checkbox')input.checked=value;else input.value=value;await input.fire('change');await settle(app);},
  upload:async(source=CSV)=>{const file=all().find(e=>e.name==='csv');file.files=[{size:source.length,arrayBuffer:async()=>new TextEncoder().encode(source).buffer}];await file.fire('change');await settle(app);},
  submit:async()=>{await all().find(e=>e.tagName==='FORM').fire('submit');await settle(app);}
 };
}

test('v4 unit fixture publishes the precommitted outer task, stable session/job context and keeps witness/decoder encrypted locally',async()=>{
 const f=await fixture();let preparedOptions;
 const buyer=browser(f,{path:'/jobs/new',garblePlan:()=>{throw Error('v3 fallback forbidden');},garbleProofPlan:async(values,plan,options)=>{preparedOptions=structuredClone(options);return prepareProofPlan(values,plan,options);}});await buyer.app.start();assert.equal(buyer.get('planningMode').value,'agent');await buyer.change('planningMode','agent');await buyer.upload();await buyer.change('agentColumn1','number');await buyer.change('agentGoal',TASK.goal);
 buyer.get('title').value='UNIT v4 publish';await buyer.click('Yerel ajanla plan üret');await buyer.change('agentApprove',true);await buyer.submit();
 const post=buyer.calls.find(c=>c.route==='/jobs'&&c.method==='POST');assert.ok(post,buyer.message());assert.equal(post.body.profile,PROOF_PROFILE);assert.equal(post.body.rowCount,1);assert.equal(post.body.task.rowCount,undefined);assert.equal(post.body.task.task.rowCount,1);assert.equal(post.body.jobId,preparedOptions.jobId);assert.equal(preparedOptions.buyerCommitment,await sha256('NOPE:buyer:'+BUYER.id));assert.equal(preparedOptions.contractId,CONTRACT);
 for(const privateText of ['inputPairs','outputPairs','inputSalt','outputSalt','proofWitness','decoder','private-score','secret-value'])assert.ok(!JSON.stringify(post.body).includes(privateText),privateText);
 const restored=await createVault(BUYER.id,{storage:f.store}).loadJob(post.body.jobId);assert.ok(restored.proofWitness.rows[0].inputPairs);assert.equal(restored.proofDecoder.profile,PROOF_PROFILE);assert.equal(restored.pending,false);
 const disk=JSON.stringify([...f.store.records]);for(const secret of ['inputPairs','inputSalt','private-score','secret-value'])assert.ok(!disk.includes(secret),secret);
 assert.ok(buyer.text().includes('v4'));assert.equal(createPayload({...post.body}).rowCount,1);
});

test('enabled v4 initialization failure never invokes v3 fallback or publishes an unproven job',async()=>{
 const f=await fixture();let v3=0;
 const buyer=browser(f,{path:'/jobs/new',garblePlan:()=>{v3++;},garbleProofPlan:()=>{throw Error('UNIT proof assets unavailable');}});await buyer.app.start();await buyer.change('planningMode','agent');await buyer.upload();await buyer.change('agentColumn1','number');await buyer.change('agentGoal',TASK.goal);buyer.get('title').value='UNIT fail closed';await buyer.click('Yerel ajanla plan üret');await buyer.change('agentApprove',true);await buyer.submit();
 assert.equal(v3,0);assert.equal(buyer.calls.filter(c=>c.route==='/jobs'&&c.method==='POST').length,0);assert.match(buyer.message(),/İşlem tamamlanamadı/);assert.ok(!buyer.message().includes('UNIT proof assets unavailable'),'unknown SDK diagnostic is never visitor-facing copy');
});

test('new jobs fail closed without matching wallet/proof capabilities or a signed wallet, never preparing manual/v3 fallback',async()=>{
 for(const options of [
  {capability:{profile:PROOF_PROFILE,enabled:false,contractId:null}},
  {capability:{profile:PROOF_PROFILE,enabled:true,contractId:'invalid.near'}},
  {walletCapability:null},{walletCapability:{...WALLET_CAPABILITY,required:false}},
  {walletCapability:{...WALLET_CAPABILITY,network:'mainnet'}},
  {walletCapability:{...WALLET_CAPABILITY,contractId:'different.testnet'}},
  {walletPolicy:null},{identity:{...BUYER,wallet:null}},
 ]){
  const f=await fixture();let preparations=0;
  const buyer=browser(f,{path:'/jobs/new',...options,garbleProofPlan:()=>{preparations++;},garblePlan:()=>{preparations++;}});await buyer.app.start();
  assert.equal(buyer.get('planningMode'),undefined);assert.equal(buyer.get('csv'),undefined);assert.equal(preparations,0);assert.equal(buyer.calls.some(c=>c.method==='POST'),false);
 }
});

test('v4 unit fixture requires the worker verification response AND exact server metadata; witness stays in the local prove worker',async()=>{
 const f=await fixture(),w=workers(f),buyer=browser(f,{worker:w});await buyer.app.start();assert.ok(buyer.text().includes('Yerel kontrol başarılı'));assert.equal(buyer.enabled('Doğrulanan teslimi kabul et'),false);assert.equal(buyer.enabled('Düzeltme iste'),true);
 await buyer.click('Sonuç kanıtını oluştur ve doğrula');assert.deepEqual(w.messages.map(m=>m.type),['prove','verify']);assert.ok(w.messages[0].witness.rows[0].inputPairs);assert.equal(w.messages[1].witness,undefined);assert.ok(w.instances.every(instance=>instance.terminated));assert.equal(buyer.enabled('Doğrulanan teslimi kabul et'),true,buyer.message());assert.ok(buyer.text().includes('Bağımsız sonuç kanıtı doğrulandı'));
 const submission=buyer.calls.find(c=>c.route.endsWith('/proof')&&c.method==='POST');assert.ok(submission);for(const secret of ['inputPairs','inputSalt','proofWitness','private-score','secret-value'])assert.ok(!JSON.stringify(submission.body).includes(secret),secret);
 await buyer.click('Doğrulanan teslimi kabul et');assert.equal(f.job.status,'ACCEPTED');assert.equal(f.job.payment.status,'RELEASE_READY');assert.ok(!buyer.calls.some(c=>c.route.includes('/payment/')),'acceptance requires a separate explicit wallet release');
});

test('reload ignores saved/server booleans and independently verifies public evidence again before enabling acceptance',async()=>{
 const f=await fixture();f.job.proof=await f.metadata();await f.vault.saveJob(ID,{...f.local,clientProofVerified:true});
 const w=workers(f),buyer=browser(f,{worker:w});await buyer.app.start();assert.equal(buyer.enabled('Doğrulanan teslimi kabul et'),false);assert.equal(w.messages.length,0);await buyer.click('Kanıtı bu cihazda bağımsız doğrula');assert.deepEqual(w.messages.map(m=>m.type),['verify']);assert.equal(w.messages[0].witness,undefined);assert.equal(buyer.enabled('Doğrulanan teslimi kabul et'),true,buyer.message());assert.ok(buyer.calls.some(c=>c.route.endsWith('/proof/evidence')));
 const again=browser(f,{worker:workers(f)});await again.app.start();assert.equal(again.enabled('Doğrulanan teslimi kabul et'),false,'a new page has no inherited verification cache');
});

test('invalid proof, mismatched server record and stale delivery fail closed while revision remains available',async()=>{
 for(const scenario of ['invalid-worker','bad-server-hash','stale-delivery']){
  const f=await fixture();const w=workers(f,{invalid:scenario==='invalid-worker',onPost:value=>{if(scenario==='stale-delivery'&&value.type==='verify')f.job.delivery.version=2;}});
  const buyer=browser(f,{worker:w,hook:call=>{if(scenario==='bad-server-hash'&&call.route.endsWith('/proof')&&call.method==='POST')f.job.proof.outputSha256='f'.repeat(64);}});await buyer.app.start();await buyer.click('Sonuç kanıtını oluştur ve doğrula');assert.equal(buyer.enabled('Doğrulanan teslimi kabul et'),false,scenario);assert.equal(buyer.app.state.proofVerifications.size,0,scenario);
  if(scenario!=='bad-server-hash')assert.equal(buyer.calls.filter(c=>c.route.endsWith('/proof')&&c.method==='POST').length,0,scenario);
  if(scenario==='invalid-worker'){assert.equal(buyer.enabled('Düzeltme iste'),true);await buyer.click('Düzeltme iste');assert.equal(f.job.status,'REVISION');}
 }
});

test('cancelled and navigated proof workers terminate without posting or accepting late results',async()=>{
 for(const navigation of [false,true]){
  const f=await fixture();let started;const ready=new Promise(resolve=>{started=resolve;});const w=workers(f,{hold:true,onPost:()=>started()});const buyer=browser(f,{worker:w});await buyer.app.start();
  const pending=buyer.all().find(e=>e.tagName==='BUTTON'&&e.textContent==='Sonuç kanıtını oluştur ve doğrula').fire('click');await ready;
  if(navigation){buyer.win.location=new URL('http://localhost/customer');buyer.events.popstate();}else await buyer.click('Kanıt işlemini iptal et');
  await pending;assert.ok(w.instances.every(instance=>instance.terminated));assert.equal(buyer.calls.filter(c=>c.route.endsWith('/proof')&&c.method==='POST').length,0);assert.equal(buyer.app.state.proofVerifications.size,0);
  w.instances[0].onmessage({data:{type:'proof',bundle:f.bundle}});assert.equal(buyer.app.state.proofVerifications.size,0,'late completion cannot revive acceptance');
 }
});

test('proof worker progress is actual row progress, rejects invalid completion and handles timeout',async()=>{
 const f=await fixture(),progress=[],w=workers(f);assert.equal(await runProofWorker({type:'verify',request:f.prepared.request,delivery:f.job.delivery,binding:bindingFor(f.job),bundle:f.bundle},{workerFactory:w.factory,onProgress:p=>progress.push(p)}),true);assert.deepEqual(progress,[{completed:1,total:1}]);
 const bad={terminate(){this.done=true;},postMessage(){queueMicrotask(()=>this.onmessage({data:{type:'progress',completed:2,total:1}}));}};
 await assert.rejects(runProofWorker({type:'verify',request:f.prepared.request,delivery:f.job.delivery,binding:bindingFor(f.job),bundle:f.bundle},{workerFactory:()=>bad}),/ilerlemesi/);assert.equal(bad.done,true);
 const silent={terminate(){this.done=true;},postMessage(){}};await assert.rejects(runProofWorker({type:'verify',request:f.prepared.request,delivery:f.job.delivery,binding:bindingFor(f.job),bundle:f.bundle},{workerFactory:()=>silent,timeoutMs:1}),/zaman sınırı/);assert.ok(silent.done);
});

test('a changed server proof after client verification cannot use a stale enabled accept button',async()=>{
 const f=await fixture(),buyer=browser(f,{worker:workers(f)});await buyer.app.start();await buyer.click('Sonuç kanıtını oluştur ve doğrula');assert.equal(buyer.enabled('Doğrulanan teslimi kabul et'),true);
 f.job.proof.bundleSha256='f'.repeat(64);await buyer.click('Doğrulanan teslimi kabul et');assert.equal(buyer.calls.some(c=>c.route.endsWith('/decision')),false);assert.equal(buyer.enabled('Doğrulanan teslimi kabul et'),false);
});

test('v4 agent preflight shows processed cells, accepts 40 and rejects 42 before publication or crypto preparation',async()=>{
 const f=await fixture();let preparations=0;const buyer=browser(f,{path:'/jobs/new',proposalSteps:[...STEPS,{column:'C2',recipe:STEPS[0].recipe}],garbleProofPlan:()=>{preparations++;throw Error('Preparation must not run in this preflight test');}});await buyer.app.start();
 assert.equal(buyer.get('planningMode').value,'agent');assert.ok(buyer.text().includes('En fazla 40 işlenen hücre'));
 const source=rows=>'private-A,private-B\n'+Array(rows).fill('0,0').join('\n')+'\n';
 async function configure(rows){await buyer.upload(source(rows));await buyer.change('agentColumn1','number');await buyer.change('agentColumn2','number');await buyer.change('agentGoal','Fill C1 and C2 blanks with 7.');await buyer.click('Yerel ajanla plan üret');}
 await configure(20);assert.ok(buyer.text().includes('2 sütun × 20 satır = 40/40 işlenen hücre'));assert.equal(buyer.get('agentApprove').disabled,false);
 await configure(21);assert.match(buyer.message(),/2 sütun × 21 satır = 42/);assert.equal(buyer.get('agentApprove').disabled,true);assert.equal(buyer.get('agentApprove').checked,false);assert.equal(preparations,0);assert.equal(buyer.calls.filter(c=>c.route==='/jobs'&&c.method==='POST').length,0);
});

test('delivery shows local vault/decode/hash stages and clears pending status after successful verification',async()=>{
 const f=await fixture(),get=f.store.get.bind(f.store);let entered,release;
 const loading=new Promise(resolve=>{entered=resolve;}),wait=new Promise(resolve=>{release=resolve;});
 f.store.get=async key=>{if(key[1]==='job'&&key[2]===ID){entered();await wait;}return get(key);};
 const buyer=browser(f,{worker:workers(f)}),starting=buyer.app.start();await loading;
 const pending=buyer.all().find(e=>e.dataset.deliveryPending==='true');assert.ok(pending);assert.match(pending.textContent,/Yerel kasa açılıyor/);assert.equal(pending.attributes.role,'status');assert.notEqual(pending.hidden,true);
 const stages=[],descriptor=Object.getOwnPropertyDescriptor(Element.prototype,'textContent');
 Object.defineProperty(pending,'textContent',{get(){return descriptor.get.call(this);},set(value){stages.push(String(value));descriptor.set.call(this,value);}});
 release();await starting;assert.ok(stages.some(s=>s.includes('Şifreli teslim çözülüyor')));assert.ok(stages.some(s=>s.includes('Yerel sonuç, plan ve veri özetleri')));assert.ok(stages.some(s=>s.includes('girdi, çıktı ve program özetleri')));assert.equal(pending.hidden,true);assert.equal(pending.textContent,'');assert.ok(buyer.text().includes('Yerel kontrol başarılı'));
});

test('delivery clears pending status when local vault or decoder fails and shows the existing error',async()=>{
 for(const failure of ['vault','decoder']){
  const f=await fixture();
  if(failure==='vault'){const get=f.store.get.bind(f.store);f.store.get=async key=>{if(key[1]==='job'&&key[2]===ID)throw Error('UNIT storage failure');return get(key);};}
  else await f.vault.saveJob(ID,{...f.local,proofDecoder:{}});
  const buyer=browser(f,{worker:workers(f)});await buyer.app.start();const pending=buyer.all().find(e=>e.dataset.deliveryPending==='true');assert.equal(pending.hidden,true);assert.equal(pending.textContent,'');assert.ok(buyer.text().includes('orijinal CSV veya çözme anahtarı yok'));assert.equal(buyer.enabled('Doğrulanan teslimi kabul et'),false);
 }
});

test('every proof metadata hash is bound exactly; a worker boolean cannot replace request, manifest, plan, program, output or context bindings',async()=>{
 for(const key of ['requestSha256','manifestSha256','programSha256','planSha256','outputSha256','bindingHash','finalContext','bundleSha256']){
  const f=await fixture(),buyer=browser(f,{worker:workers(f),hook:call=>{if(call.route.endsWith('/proof')&&call.method==='POST')f.job.proof[key]='f'.repeat(64);}});await buyer.app.start();await buyer.click('Sonuç kanıtını oluştur ve doğrula');assert.equal(buyer.enabled('Doğrulanan teslimi kabul et'),false,key);assert.equal(buyer.app.state.proofVerifications.size,0,key);assert.equal(buyer.calls.some(c=>c.route.endsWith('/decision')),false,key);
 }
});

test('independent public proof verification without the local decoder never grants customer acceptance',async()=>{
 const f=await fixture();f.job.proof=await f.metadata();await f.vault.saveJob(ID,{...f.local,proofDecoder:null,clientProofVerified:true});const w=workers(f),buyer=browser(f,{worker:w});await buyer.app.start();assert.equal(buyer.enabled('Doğrulanan teslimi kabul et'),false);await buyer.click('Kanıtı bu cihazda bağımsız doğrula');assert.deepEqual(w.messages.map(m=>m.type),['verify']);assert.equal(buyer.enabled('Doğrulanan teslimi kabul et'),false);assert.equal(buyer.calls.some(c=>c.route.endsWith('/decision')),false);
});

test('verified proof and correct local decode still require the latest chain record and the immutable buyer wallet',async()=>{
 const f=await fixture(),buyer=browser(f,{worker:workers(f)});await buyer.app.start();await buyer.click('Sonuç kanıtını oluştur ve doğrula');const verification=buyer.app.state.proofVerifications.get(ID),decoded={correct:true,version:1,outputSha256:f.job.delivery.outputSha256};assert.equal(decisionAllowed(f.job,decoded,BUYER,verification),true);
 for(const mutate of [j=>j.payment.verified=false,j=>j.payment.recordedVersion=0,j=>j.payment.recordedOutputHash='f'.repeat(64),j=>j.delivery.version=2,j=>j.delivery.outputSha256='f'.repeat(64),j=>j.status='REVISION']){
  const changed=structuredClone(f.job);mutate(changed);assert.equal(decisionAllowed(changed,decoded,BUYER,verification),false);
 }
 assert.equal(decisionAllowed(f.job,decoded,{...BUYER,wallet:wallet('wrong-wallet.testnet')},verification),false);assert.equal(decisionAllowed(f.job,decoded,{...BUYER,wallet:null},verification),false);
 f.job.payment.recordedVersion=0;await buyer.click('Doğrulanan teslimi kabul et');assert.equal(buyer.calls.some(c=>c.route.endsWith('/decision')),false,'a retained enabled button rechecks the chain record');
});
