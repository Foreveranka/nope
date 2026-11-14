import test from 'node:test';
import assert from 'node:assert/strict';
import {randomBytes} from 'node:crypto';
import {createWorkspace as createServerWorkspace,quoteCommitment} from './core.mjs';
import {executeTask} from './gc.mjs';
import {createWorkspace as createBrowserWorkspace,createPayload,TOKEN_KEY,generateAgentPlan,prepareApprovedAgentJob} from '../web/workspace.js';
import {createVault,randomSalt} from '../web/workspace-vault.mjs';
import {publicTask,publicTaskHash,acceptAgentProposal,privatePlanInputs,applyAgentOutput} from '../web/agent-plan.mjs';
import {PROFILE,hashPlan,hashPlanRequest,hashPlanProgram,hashPlanOutput} from '../web/plan-core.mjs';
import {preparePlan} from '../web/plan-client.mjs';
import {sha256} from '../web/gc-core.mjs';
import {parseCSV} from '../web/csv-input.mjs';
const ORIGIN='http://localhost:8712';
const CSV='private-score,private-name,private-ignore\n209,  Hidden97  ,Retained-A\n,Ab C3,Retained-B\n';
const TASK=publicTask({version:1,goal:'C1: fill blanks with 7 and clamp to 10..80. C2: trim, lowercase, redact digits.',columns:[{id:'C1',type:'number'},{id:'C2',type:'text'}]});
const STEPS=[{column:'C1',recipe:{type:'number',steps:[{op:'fill',value:7},{op:'clamp',min:10,max:80}]}},{column:'C2',recipe:{type:'text',steps:[{op:'trim'},{op:'lowercase'},{op:'redactDigits'}]}}];
// Unit-only model-generation fixture: NOT evidence of real model inference.
function modelFixture(raw=JSON.stringify({steps:STEPS})) {
 const messages=[],workers=[];
 const factory=()=>{const worker={terminate(){this.terminated=true;},postMessage(message){messages.push(structuredClone(message));queueMicrotask(()=>{this.onmessage({data:{type:'progress',message:'Synthetic unit model'}});this.onmessage({data:{type:'plan',raw,model:{id:'UNIT-ONLY-NOT-A-REAL-MODEL',revision:'unit-fixture'}}});});}};workers.push(worker);return worker;};
 return {factory,messages,workers};
}
class Store {
 records=new Map();
 async read(key){return structuredClone(this.records.get(key)??null);}
 async create(key,value){if(this.records.has(key))return false;this.records.set(key,structuredClone(value));return true;}
 async list({prefix,limit,cursor}){const keys=[...this.records.keys()].filter(k=>k.startsWith(prefix)).sort(),start=Number(cursor||0);return {pathnames:keys.slice(start,start+limit),cursor:start+limit<keys.length?String(start+limit):null};}
}
// Structured-clone storage tests cryptography and reload semantics, not IDB durability.
class LocalStorage {
 records=new Map();
 async get(key){return structuredClone(this.records.get(JSON.stringify(key)));}
 async put(key,value){this.records.set(JSON.stringify(key),structuredClone(value));}
 async installKeys(key,value){const k=JSON.stringify(key);if(!this.records.has(k))this.records.set(k,structuredClone(value));return structuredClone(this.records.get(k));}
 async deleteSession(session){for(const key of this.records.keys())if(JSON.parse(key)[0]===session)this.records.delete(key);}
}
async function fixture(){
 const store=new Store(),localStore=new LocalStorage(),now=Date.parse('2026-11-14T12:00:00Z');
 const handle=createServerWorkspace({store,env:{NOPE_WORKSPACE_ORIGIN:ORIGIN},now:()=>now});
 async function call(path,who,body,method=body===undefined?'GET':'POST'){
  const response=await handle(new Request(ORIGIN+'/api/workspace'+path,{method,headers:{origin:ORIGIN,...(who?{authorization:'Bearer '+who.token}:{}),...(body!==undefined?{'content-type':'application/json'}:{})},...(body!==undefined?{body:typeof body==='string'?body:JSON.stringify(body)}:{})}));
  return {status:response.status,data:await response.json()};
 }
 async function session(role,name){const r=await call('/session',null,{role,displayName:name,...(role==='provider'?{paymentAccount:name+'.testnet'}:{})});assert.equal(r.status,201);return {...r.data,vault:createVault(r.data.session.id,{storage:localStore})};}
 const buyer=await session('buyer','buyer'),provider=await session('provider','worker'),outsider=await session('provider','outsider'),otherBuyer=await session('buyer','other');
 async function award(payload){
  const id=payload.jobId,salt=randomSalt(),amountYocto='1000000000000000000000',quote={jobId:id,providerId:provider.session.id,amountYocto,salt};
  const envelope=await provider.vault.encryptQuote(payload.buyerPublicKey,quote);
  assert.equal((await call('/jobs/'+id+'/offers',provider,{envelope,commitment:quoteCommitment(id,quote.providerId,amountYocto,salt)})).status,200);
  const closed=await call('/jobs/'+id+'/close',buyer,{});assert.equal(closed.status,200);
  assert.equal((await call('/jobs/'+id+'/award',buyer,{offerId:closed.data.job.offers[0].id,amountYocto,salt})).status,200);
 }
 return {store,localStore,handle,call,buyer,provider,outsider,otherBuyer,award};
}
async function planDraft(f){
 const dataset=parseCSV(CSV),proposal=await acceptAgentProposal(TASK,{steps:STEPS});
 const approval={...proposal,datasetSha256:await sha256(JSON.stringify(dataset)),model:{id:'UNIT-ONLY',revision:'fixture'}};
 const prepared=await prepareApprovedAgentJob(dataset,TASK,approval,{approved:true});
 const payload=createPayload({jobId:randomBytes(16).toString('hex'),title:'Synthetic multicolumn task',description:'Separate public description',deadlineISO:'2026-11-15T12:00:00.000Z',task:prepared.request,publicTask:TASK,buyerPublicKey:await f.buyer.vault.buyerPublicKey()});
 return {dataset,proposal,approval,prepared,payload};
}
class Element {
 constructor(tag){this.tagName=tag.toUpperCase();this.children=[];this.listeners={};this.dataset={};this.attributes={};this.value='';this.disabled=false;this.files=[];}
 set textContent(value){this.text=String(value);this.children=[];}
 get textContent(){return (this.text||'')+this.children.map(x=>x.textContent).join(' ');}
 append(...nodes){for(const node of nodes){if(node.parentElement)node.parentElement.children=node.parentElement.children.filter(x=>x!==node);node.parentElement=this;this.children.push(node);if(this.tagName==='SELECT'&&this.children.length===1)this.value=node.value;}}
 replaceChildren(...nodes){this.children.forEach(n=>n.parentElement=null);this.children=[];this.text='';this.append(...nodes);}
 addEventListener(name,fn){(this.listeners[name]||=[]).push(fn);}
 setAttribute(key,value){this.attributes[key]=value;}
 removeAttribute(key){delete this.attributes[key];}
 reportValidity(){return true;}
 async fire(type,event={}){for(const fn of this.listeners[type]||[])await fn({preventDefault(){},button:0,...event});}
}
const descendants=node=>[node,...node.children.flatMap(descendants)];
function browser(f,who,path,{transform,losePublish=false,agentWorkerFactory}={}){
 const elements=new Map(['workspace-root','workspace-nav','workspace-identity','workspace-message','workspace-logout','workspace-heading','workspace-subtitle'].map(k=>[k,new Element('div')]));
 const saved=new Map([[TOKEN_KEY,who.token]]),storage={getItem:k=>saved.get(k),setItem:(k,v)=>saved.set(k,v),removeItem:k=>saved.delete(k)},calls=[];
 const win={location:new URL(ORIGIN+path),sessionStorage:storage,addEventListener(){},navigator:{clipboard:{writeText:async()=>{}}},URL,setTimeout,history:{pushState:(_,__,href)=>win.location=new URL(href,win.location),replaceState:(_,__,href)=>win.location=new URL(href,win.location)}};
 const doc={getElementById:k=>elements.get(k),createElement:tag=>new Element(tag),addEventListener(){},querySelectorAll:()=>[...descendants(elements.get('workspace-root')).filter(n=>['BUTTON','INPUT','SELECT','TEXTAREA'].includes(n.tagName)),elements.get('workspace-logout')]};
 const app=createBrowserWorkspace({document:doc,window:win,storage,agentWorkerFactory,vaultFactory:session=>createVault(session,{storage:f.localStore}),fetch:async(url,options)=>{
  const parsed=new URL(url,ORIGIN),route='/'+parsed.searchParams.get('route'),body=options.body?JSON.parse(options.body):undefined;calls.push({route,body,method:options.method});
  const result=await f.call(route,who,body,options.method);
  if(losePublish&&route==='/jobs'&&options.method==='POST')throw Error('synthetic lost response after committed publication');
  if(transform&&result.data.job)transform(result.data.job);
  return {ok:result.status>=200&&result.status<300,status:result.status,json:async()=>result.data};
 }});
 const all=()=>descendants(elements.get('workspace-root')),get=name=>all().find(e=>e.name===name);
 async function settle(){for(let i=0;i<30000&&app.state.busy;i++)await new Promise(resolve=>setTimeout(resolve,1));assert.equal(app.state.busy,false,'UI operation settles');}
 return {app,calls,all,get,text:()=>elements.get('workspace-root').textContent,message:()=>elements.get('workspace-message').textContent,
  change:async(name,value)=>{const input=get(name);assert.ok(input,name);if(input.type==='checkbox')input.checked=value;else input.value=value;await input.fire('change');await settle();},
  upload:async(source)=>{const file=get('csv');file.files=[{size:new TextEncoder().encode(source).length,arrayBuffer:async()=>new TextEncoder().encode(source).buffer}];await file.fire('change');await settle();},
  submit:async()=>{await all().find(e=>e.tagName==='FORM').fire('submit');await settle();},
  click:async(label)=>{const button=all().find(e=>e.tagName==='BUTTON'&&e.textContent===label);assert.ok(button,label);await button.fire('click');await settle();},
 };
}

test('unit-only model fixture receives exactly public aliases/types/goal; strict plans and worker cleanup',async()=>{
 const model=modelFixture(),progress=[];
 const plan=await generateAgentPlan(TASK,{workerFactory:model.factory,onProgress:value=>progress.push(value)});
 assert.deepEqual(model.messages,[{type:'plan',task:TASK,taskHash:await publicTaskHash(TASK)}]);
 assert.equal(plan.model.id,'UNIT-ONLY-NOT-A-REAL-MODEL');assert.equal(progress.length,1);assert.equal(model.workers[0].terminated,true);
 assert.equal(plan.planSha256,await hashPlan(plan.plan));assert.ok(Object.isFrozen(plan.plan.steps));
 const wire=JSON.stringify(model.messages);
 for(const secret of ['private-score','private-name','Hidden97','Retained-A','dataset','headers','values','decoder'])assert.ok(!wire.includes(secret),secret);
 const invalid=modelFixture(JSON.stringify({steps:[{column:'C3',recipe:STEPS[0].recipe}]}));
 await assert.rejects(generateAgentPlan(TASK,{workerFactory:invalid.factory}),/sütun/);assert.ok(invalid.workers[0].terminated);
 let called=false;
 await assert.rejects(generateAgentPlan({...TASK,headers:['private-score']},{workerFactory:()=>{called=true;}}));assert.equal(called,false);
 const failed={postMessage(){queueMicrotask(()=>this.onmessage({data:{type:'error',error:'actual runtime unavailable'}}));},terminate(){this.done=true;}};
 await assert.rejects(generateAgentPlan(TASK,{workerFactory:()=>failed}),/runtime unavailable/);assert.ok(failed.done);
});

test('planner cancellation and bounded timeout terminate the worker without producing an approved plan',async()=>{
 const controller=new AbortController();let started;
 const ready=new Promise(resolve=>{started=resolve;});
 const worker={postMessage(){started();},terminate(){this.done=true;}};
 const pending=generateAgentPlan(TASK,{workerFactory:()=>worker,signal:controller.signal});
 await ready;controller.abort();await assert.rejects(pending,/iptal/);assert.ok(worker.done);
 const timed={postMessage(){},terminate(){this.done=true;}};
 await assert.rejects(generateAgentPlan(TASK,{workerFactory:()=>timed,timeoutMs:1}),/zaman sınırına/);assert.ok(timed.done);
 await assert.rejects(generateAgentPlan(TASK,{timeoutMs:900_000}),/zaman sınırı/);
 let created=false;await assert.rejects(generateAgentPlan(TASK,{signal:controller.signal,workerFactory:()=>{created=true;}}),/iptal/);assert.equal(created,false);
});

test('approval rechecks local file, public goal/schema, plan and explicit consent before garbling',async()=>{
 const dataset=parseCSV(CSV),proposal=await acceptAgentProposal(TASK,{steps:STEPS});
 const approval={...proposal,datasetSha256:await sha256(JSON.stringify(dataset)),model:{id:'UNIT-ONLY',revision:'fixture'}};
 let calls=0;const garblePlan=async()=>{calls++;throw Error('unexpected crypto');};
 const attempts=[
  [dataset,TASK,approval,false],
  [parseCSV(CSV.replace('209','208')),TASK,approval,true],
  [dataset,{...TASK,goal:'Different public goal'},approval,true],
  [dataset,{...TASK,columns:[{id:'C1',type:'text'},{id:'C2',type:'text'}]},approval,true],
  [dataset,TASK,{...approval,planSha256:'0'.repeat(64)},true],
  [dataset,TASK,{...approval,plan:{...approval.plan,steps:[{column:'C1',recipe:{type:'number',steps:[{op:'fill',value:9}]}}]}},true],
 ];
 for(const [data,task,binding,approved] of attempts)await assert.rejects(prepareApprovedAgentJob(data,task,binding,{approved,garblePlan}));
 assert.equal(calls,0,'stale or unapproved jobs fail before private encryption');
});

test('v3 server binds actual public task, plan hash, column types and every nested program digest',async()=>{
 const f=await fixture(),d=await planDraft(f),clone=()=>structuredClone(d.payload);
 const invalid=[];
 for(const publicTask of [undefined,{...TASK,version:2},{...TASK,goal:'Tampered goal'},{...TASK,columns:[{id:'C1',type:'text'},{id:'C2',type:'text'}]},{...TASK,columns:[...TASK.columns,{id:'C1',type:'number'}]},{...TASK,headers:['private-score']},{...TASK,columns:[{id:'C1',type:'number',header:'private-score'}]}])invalid.push({...clone(),publicTask});
 const mismatch=clone();mismatch.task.planSha256='0'.repeat(64);invalid.push(mismatch);
 const nested=clone();nested.task.tasks[0].request.programSha256='0'.repeat(64);invalid.push(nested);
 const secret=clone();secret.task.decoder=d.prepared.decoder;invalid.push(secret);
 for(const payload of invalid){const r=await f.call('/jobs',f.buyer,payload);assert.equal(r.status,400,JSON.stringify(r.data));}
 const wrongTypeTask={...TASK,columns:[{id:'C1',type:'text'},{id:'C2',type:'text'}]},wrong=clone();
 wrong.publicTask=wrongTypeTask;wrong.task.plan.taskHash=await publicTaskHash(wrongTypeTask);wrong.task.planSha256=await hashPlan(wrong.task.plan);
 assert.equal((await f.call('/jobs',f.buyer,wrong)).status,400,'even recomputed hashes cannot authorize recipes for a different schema');
 const created=await f.call('/jobs',f.buyer,d.payload);assert.equal(created.status,201,JSON.stringify(created.data));assert.deepEqual(created.data.job.publicTask,TASK);assert.deepEqual(created.data.job.plan,d.prepared.request.plan);
 assert.equal((await f.call('/jobs',f.buyer,d.payload)).status,200);
 const replaced=clone();replaced.publicTask={...TASK,goal:'Replacement goal'};replaced.task.plan.taskHash=await publicTaskHash(replaced.publicTask);replaced.task.planSha256=await hashPlan(replaced.task.plan);
 assert.equal((await f.call('/jobs',f.buyer,replaced)).status,409,'published job is immutable even for another individually valid public task');
});

test('actual encrypted v3 lifecycle: selected-provider-only execution, reload decode, multicolumn reference, exact acceptance',async()=>{
 const f=await fixture(),d=await planDraft(f),id=d.payload.jobId;
 await f.buyer.vault.saveJob(id,{dataset:d.dataset,values:d.prepared.values,agentApproval:d.approval,payload:d.payload});await f.buyer.vault.saveDecoder(id,d.prepared);
 assert.equal((await f.call('/jobs',f.buyer,d.payload)).status,201);
 for(const who of [f.provider,f.outsider])assert.equal((await f.call('/jobs/'+id+'/task',who)).status,403);
 assert.equal((await f.call('/jobs/'+id+'/task',f.otherBuyer)).status,404);
 await f.award(d.payload);
 assert.equal((await f.call('/jobs/'+id+'/task',f.provider)).status,200);
 assert.equal((await f.call('/jobs/'+id+'/task',f.outsider)).status,403);
 for(const who of [f.outsider,f.buyer])assert.equal((await f.call('/jobs/'+id+'/execute',who,{})).status,403);
 assert.equal((await f.call('/jobs/'+id+'/execute',f.provider,{task:{profile:PROFILE}})).status,400,'provider cannot supply a replacement bundle');
 const delivered=await f.call('/jobs/'+id+'/execute',f.provider,{});assert.equal(delivered.status,200,JSON.stringify(delivered.data));
 const delivery=delivered.data.job.delivery,reloaded=createVault(f.buyer.session.id,{storage:f.localStore});
 assert.equal(delivery.profile,PROFILE);assert.equal(delivery.nonce,d.prepared.request.nonce);assert.equal(delivery.rowCount,2);
 assert.equal(delivery.inputSha256,await hashPlanRequest(d.prepared.request));assert.equal(delivery.programSha256,await hashPlanProgram(d.prepared.request.plan));assert.equal(delivery.outputSha256,await hashPlanOutput(delivery.outputs));
 const decoded=await reloaded.decodeDelivery(id,delivery);assert.deepEqual(decoded,{C1:[80,10],C2:['hidden**','ab c*']});
 const output=applyAgentOutput(d.dataset,d.prepared.request.plan,decoded);assert.deepEqual(output.headers,d.dataset.headers);assert.deepEqual(output.rows,[['80','hidden**','Retained-A'],['10','ab c*','Retained-B']]);
 assert.throws(()=>applyAgentOutput(d.dataset,d.prepared.request.plan,{...decoded,C1:[79,10]}),/eşleşmiyor/);
 assert.deepEqual((await f.call('/jobs/'+id+'/execute',f.provider,{})).data.job.delivery,delivery);
 assert.equal((await f.call('/jobs/'+id,f.outsider)).data.job.delivery,null);
 const decision={decision:'accept',version:delivery.version,outputSha256:delivery.outputSha256};
 for(const bad of [{...decision,version:0},{...decision,outputSha256:'f'.repeat(64)}])assert.equal((await f.call('/jobs/'+id+'/decision',f.buyer,bad)).status,409);
 assert.equal((await f.call('/jobs/'+id+'/decision',f.provider,decision)).status,403);
 assert.equal((await f.call('/jobs/'+id+'/decision',f.buyer,{...decision,decision:'revise'})).data.job.status,'REVISION');
 const second=(await f.call('/jobs/'+id+'/execute',f.provider,{})).data.job.delivery;assert.equal(second.version,2);
 assert.deepEqual(await reloaded.decodeDelivery(id,second),decoded);
 assert.equal((await f.call('/jobs/'+id+'/decision',f.buyer,decision)).status,409);
 assert.equal((await f.call('/jobs/'+id+'/decision',f.buyer,{...decision,version:2})).data.job.status,'ACCEPTED');
 const remote=JSON.stringify([...f.store.records]);for(const secret of ['private-score','private-name','Hidden97','Retained-A','outputPairs','decoder','dataset'])assert.ok(!remote.includes(secret),secret);
 const disk=JSON.stringify([...f.localStore.records]);for(const secret of ['private-score','Hidden97','outputPairs'])assert.ok(!disk.includes(secret),secret);
 const tampered=structuredClone(delivery);tampered.nonce='0'.repeat(32);await assert.rejects(reloaded.decodeDelivery(id,tampered));
 const mismatched=structuredClone(d.prepared);mismatched.decoder.planSha256='0'.repeat(64);await assert.rejects(reloaded.saveDecoder(id,mismatched));
});

async function setupAgentUI(buyer){
 await buyer.app.start();assert.equal(buyer.get('planningMode').value,'manual');
 await buyer.change('planningMode','agent');await buyer.upload(CSV);
 await buyer.change('agentColumn1','number');await buyer.change('agentColumn2','text');await buyer.change('agentGoal',TASK.goal);
 buyer.get('title').value='Synthetic agent cleanup';buyer.get('description').value='Separate public description';buyer.get('deadlineISO').value='2026-11-15T15:00';
}

test('agent UI keeps visible loading progress and cancellation available while all publishing controls are busy',async()=>{
 const f=await fixture();let started;
 const ready=new Promise(resolve=>{started=resolve;});
 const worker={postMessage(){this.onmessage({data:{type:'progress',stage:'download',message:'Downloading unit-fixture bytes 12 / 100'}});started();},terminate(){this.done=true;}};
 const buyer=browser(f,f.buyer,'/jobs/new',{agentWorkerFactory:()=>worker});await setupAgentUI(buyer);
 const pending=buyer.all().find(e=>e.textContent==='Yerel ajanla plan üret').fire('click');await ready;
 assert.equal(buyer.app.state.busy,true);assert.ok(buyer.text().includes('12 / 100'));
 const cancel=buyer.all().find(e=>e.textContent==='Yerel planlamayı iptal et');assert.equal(cancel.hidden,false);assert.equal(cancel.disabled,false);
 assert.equal(buyer.all().find(e=>e.type==='submit').disabled,true);
 await buyer.click('Yerel planlamayı iptal et');await pending;
 assert.ok(worker.done);assert.equal(buyer.get('agentApprove').checked,false);assert.equal(buyer.get('agentApprove').disabled,true);assert.match(buyer.message(),/iptal/);
 assert.equal(buyer.calls.filter(c=>c.route==='/jobs'&&c.method==='POST').length,0);
});

test('agent SPA lifecycle uses unit-only model fixture, real multi-column crypto/server/vault and buyer reference gate',async()=>{
 const f=await fixture(),model=modelFixture(),buyer=browser(f,f.buyer,'/jobs/new',{agentWorkerFactory:model.factory});await setupAgentUI(buyer);
 await buyer.click('Yerel ajanla plan üret');assert.ok(buyer.text().includes('UNIT-ONLY-NOT-A-REAL-MODEL'),buyer.message());
 assert.ok(buyer.text().includes(TASK.goal));assert.ok(buyer.text().includes('hidden**'));assert.ok(buyer.text().includes('Plan SHA-256:'));
 assert.equal(buyer.all().find(e=>e.type==='submit').disabled,true);await buyer.change('agentApprove',true);assert.equal(buyer.all().find(e=>e.type==='submit').disabled,false);
 await buyer.submit();const post=buyer.calls.find(c=>c.route==='/jobs'&&c.method==='POST');assert.ok(post,buyer.message());const id=post.body.jobId;
 assert.deepEqual(post.body.publicTask,TASK);assert.equal(post.body.profile,PROFILE);
 for(const secret of ['private-score','private-name','Hidden97','Retained-A','decoder','dataset','outputPairs'])assert.ok(!JSON.stringify(post.body).includes(secret),secret);
 assert.deepEqual(model.messages[0].task,TASK);assert.ok(!JSON.stringify(model.messages).includes('private-score'));
 await f.award(post.body);const provider=browser(f,f.provider,'/delivery?id='+id);await provider.app.start();assert.ok(provider.text().includes(TASK.goal));assert.ok(!provider.text().includes('Hidden97'));
 await provider.click('Şifreli işi yürüt ve teslim et');
 const reopened=browser(f,f.buyer,'/delivery?id='+id);await reopened.app.start();assert.ok(reopened.text().includes('Yerel kontrol başarılı'),reopened.text());assert.ok(reopened.text().includes('Hidden97'));assert.ok(reopened.text().includes('hidden**'));assert.ok(reopened.text().includes('private-score'));
 for(const transform of [job=>{job.delivery.programSha256='0'.repeat(64);},job=>{job.publicTask.goal='tampered public goal';},job=>{job.planSha256='0'.repeat(64);}]){
  const bad=browser(f,f.buyer,'/delivery?id='+id,{transform});await bad.app.start();assert.ok(!bad.all().some(e=>e.textContent==='Doğrulanan teslimi kabul et'));
 }
 await reopened.click('Doğrulanan teslimi kabul et');const accepted=reopened.calls.find(c=>c.route.endsWith('/decision'));assert.deepEqual(Object.keys(accepted.body).sort(),['decision','outputSha256','version']);assert.equal((await f.call('/jobs/'+id,f.buyer)).data.job.status,'ACCEPTED');
});

test('goal/schema/file/mode changes invalidate agent approval and silent task changes are rejected on publish',async()=>{
 const f=await fixture(),model=modelFixture(),buyer=browser(f,f.buyer,'/jobs/new',{agentWorkerFactory:model.factory});await setupAgentUI(buyer);
 async function approve(){await buyer.click('Yerel ajanla plan üret');await buyer.change('agentApprove',true);assert.equal(buyer.get('agentApprove').checked,true,buyer.message());}
 await approve();await buyer.change('agentGoal',TASK.goal+' ');assert.equal(buyer.get('agentApprove').checked,false);assert.equal(buyer.all().find(e=>e.type==='submit').disabled,true);
 await approve();await buyer.change('agentColumn2','ignore');assert.equal(buyer.get('agentApprove').checked,false);await buyer.change('agentColumn2','text');
 await approve();await buyer.upload(CSV);assert.equal(buyer.get('agentApprove').checked,false);assert.equal(buyer.get('agentColumn1').value,'ignore');await buyer.change('agentColumn1','number');await buyer.change('agentColumn2','text');
 await approve();await buyer.change('planningMode','manual');assert.equal(buyer.get('agentApprove').checked,false);await buyer.change('planningMode','agent');
 await approve();buyer.get('agentGoal').value='Silently changed goal';await buyer.submit();assert.equal(buyer.calls.filter(c=>c.route==='/jobs'&&c.method==='POST').length,0);assert.match(buyer.message(),/plan|tanımı|sütun/i);
});

test('agent pending publication reload recovers the exact public task/ciphertext and local multicolumn decoder',async()=>{
 const f=await fixture(),model=modelFixture(),buyer=browser(f,f.buyer,'/jobs/new',{agentWorkerFactory:model.factory,losePublish:true});await setupAgentUI(buyer);await buyer.click('Yerel ajanla plan üret');await buyer.change('agentApprove',true);await buyer.submit();
 const post=buyer.calls.find(c=>c.route==='/jobs'&&c.method==='POST');assert.ok(post,buyer.message());const id=post.body.jobId;assert.equal((await f.buyer.vault.loadJob(id)).pending,true);
 const reloaded=browser(f,f.buyer,'/customer');await reloaded.app.start();await reloaded.click('Aynı işin durumunu kontrol et');assert.equal((await f.buyer.vault.loadJob(id)).pending,false);assert.equal(reloaded.calls.filter(c=>c.method==='POST').length,0);
 const task=(await f.call('/jobs/'+id+'/task',f.buyer)).data.task;assert.deepEqual(task,post.body.task);
 assert.deepEqual(await createVault(f.buyer.session.id,{storage:f.localStore}).decodeDelivery(id,await executeTask(task)),{C1:[80,10],C2:['hidden**','ab c*']});
});

