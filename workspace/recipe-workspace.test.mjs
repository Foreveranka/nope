import test from 'node:test';
import assert from 'node:assert/strict';
import {randomBytes} from 'node:crypto';
import {createWorkspace as createServerWorkspace, quoteCommitment} from './core.mjs';
import {ROOT} from './blob.mjs';
import {executeTask} from './gc.mjs';
import {createWorkspace as createBrowserWorkspace, createPayload, TOKEN_KEY} from '../web/workspace.js';
import {createVault, randomSalt} from '../web/workspace-vault.mjs';
import {createGarbledJob} from '../web/gc-client.mjs';
import {PROFILE, estimateRecipe, referenceApply, hashRecipeRequest, hashRecipeProgram, hashRecipeOutput} from '../web/recipe-core.mjs';
import {prepareRecipe} from '../web/recipe-client.mjs';
import {parseCSV} from '../web/csv-input.mjs';
import {parseRecipeColumn, applyRecipeOutput} from '../web/recipe-csv.mjs';

// Migration map: independent v2 API/GC/AES-vault/schema tests remain intact.
// Historical SPA creation is retired: these two browser tests seed actual v2
// ciphertext via the isolated backend fixture, then check readonly rendering and
// GET reconciliation. Wallet/v4 publication/finality is covered in proof-ui,
// escrow-ui and wallet-ui tests; no legacy production bypass is introduced.
const ORIGIN='http://localhost:8712';
const numberRecipe={type:'number',steps:[{op:'fill',value:7},{op:'clamp',min:10,max:80}]};
const textRecipe={type:'text',steps:[{op:'trim'},{op:'lowercase'},{op:'redactDigits'}]};
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
 async function publish(values,recipe){
  const prepared=await prepareRecipe(values,recipe),jobId=randomBytes(16).toString('hex');
  const payload=createPayload({jobId,title:'Synthetic recipe task',description:'Public instructions only',deadlineISO:'2026-11-15T12:00:00.000Z',task:prepared.request,buyerPublicKey:await buyer.vault.buyerPublicKey()});
  return {prepared,payload,publish:()=>call('/jobs',buyer,payload),post:(action,body={},who=buyer)=>call('/jobs/'+jobId+'/'+action,who,body)};
 }
 async function award(job){
  const salt=randomSalt(),amountYocto='1000000000000000000000',quote={jobId:job.payload.jobId,providerId:provider.session.id,amountYocto,salt};
  const envelope=await provider.vault.encryptQuote(job.payload.buyerPublicKey,quote);
  assert.equal((await job.post('offers',{envelope,commitment:quoteCommitment(quote.jobId,quote.providerId,amountYocto,salt)},provider)).status,200);
  const closed=await job.post('close');assert.equal(closed.status,200);
  assert.equal((await job.post('award',{offerId:closed.data.job.offers[0].id,amountYocto,salt})).status,200);
 }
 return {store,localStore,handle,call,buyer,provider,outsider,otherBuyer,publish,award};
}

for(const [name,values,recipe,expected] of [
 ['numeric',[255,2,42,254],numberRecipe,[10,10,42,80]],
 ['text',['  SECRET97  ','Ab C3'],textRecipe,['secret**','ab c*']],
])test(`actual v2 ${name} lifecycle: sealed quote, authorized execution, local decoder, version/hash acceptance`,async()=>{
 const f=await fixture(),j=await f.publish(values,recipe),id=j.payload.jobId;
 await f.buyer.vault.saveJob(id,{values,privateMarker:'local-source-only'});await f.buyer.vault.saveDecoder(id,j.prepared);
 const created=await j.publish();assert.equal(created.status,201,JSON.stringify(created.data));assert.equal(created.data.job.profile,PROFILE);assert.deepEqual(created.data.job.recipe,recipe);
 assert.equal((await j.publish()).status,200,'same immutable task retries safely');
 for(const who of [f.provider,f.outsider]){
  assert.equal((await f.call('/jobs/'+id+'/task',who)).status,403);
  const publicJob=(await f.call('/jobs/'+id,who)).data.job;
  assert.deepEqual(publicJob.recipe,recipe);assert.equal(publicJob.task,undefined);assert.equal(publicJob.decoder,undefined);
 }
 assert.equal((await f.call('/jobs/'+id+'/task',f.otherBuyer)).status,404);
 assert.equal((await f.call('/jobs/'+id+'/task')).status,401);
 await f.award(j);
 assert.equal((await f.call('/jobs/'+id+'/task',f.provider)).status,200);
 assert.equal((await f.call('/jobs/'+id+'/task',f.outsider)).status,403);
 for(const who of [f.outsider,f.buyer])assert.equal((await j.post('execute',{},who)).status,403);
 const executed=await j.post('execute',{},f.provider);assert.equal(executed.status,200,JSON.stringify(executed.data));
 const delivery=executed.data.job.delivery;assert.equal(delivery.profile,PROFILE);assert.equal(delivery.version,1);
 const reloaded=createVault(f.buyer.session.id,{storage:f.localStore});
 assert.deepEqual(await reloaded.decodeDelivery(id,delivery),expected);
 assert.equal(delivery.inputSha256,await hashRecipeRequest(j.prepared.request));assert.equal(delivery.programSha256,await hashRecipeProgram(recipe));assert.equal(delivery.outputSha256,await hashRecipeOutput(delivery.outputs));
 assert.equal((await f.call('/jobs/'+id,f.outsider)).data.job.delivery,null);
 assert.deepEqual((await j.post('execute',{},f.provider)).data.job.delivery,delivery,'execute retry does not create a new version');
 for(const bad of [{version:0,outputSha256:delivery.outputSha256},{version:1,outputSha256:'f'.repeat(64)}])assert.equal((await j.post('decision',{decision:'accept',...bad})).status,409);
 assert.equal((await j.post('decision',{decision:'accept',version:1,outputSha256:delivery.outputSha256},f.provider)).status,403);
 assert.equal((await j.post('decision',{decision:'revise',version:1,outputSha256:delivery.outputSha256})).data.job.status,'REVISION');
 const second=(await j.post('execute',{},f.provider)).data.job.delivery;assert.equal(second.version,2);
 assert.equal((await j.post('decision',{decision:'accept',version:1,outputSha256:second.outputSha256})).status,409);
 const accepted=await j.post('decision',{decision:'accept',version:2,outputSha256:second.outputSha256});assert.equal(accepted.data.job.status,'ACCEPTED');assert.equal(accepted.data.job.payment.kind,'DIRECT_TESTNET_TRANSFER');assert.equal(accepted.data.job.payment.status,'DUE');
 const remote=JSON.stringify([...f.store.records]);for(const privateValue of ['outputPairs','privateMarker','local-source-only','SECRET97','Ab C3'])assert.ok(!remote.includes(privateValue),privateValue);
 const disk=JSON.stringify([...f.localStore.records]);assert.ok(!disk.includes('outputPairs'));assert.ok(!disk.includes('local-source-only'));
});

test('v2 schema and immutable task integrity reject decoder injection and recipe/program substitution',async()=>{
 const f=await fixture(),j=await f.publish([255,200],numberRecipe);
 for(const payload of [
  {...j.payload,recipe:numberRecipe},
  {...j.payload,task:{...j.prepared.request,decoder:j.prepared.decoder}},
  {...j.payload,task:{...j.prepared.request,recipe:{type:'number',steps:[{op:'fill',value:55}]}}},
  {...j.payload,task:{...j.prepared.request,programSha256:'0'.repeat(64)}},
  {...j.payload,rowCount:1},
  {...j.payload,profile:'unknown-v3'},
 ])assert.equal((await f.call('/jobs',f.buyer,payload)).status,400);
 assert.equal((await j.publish()).status,201);await f.award(j);
 const path=ROOT+'jobs/'+j.payload.jobId+'/task.json',stored=f.store.records.get(path);stored.task.nonce='0'.repeat(32);
 assert.equal((await f.call('/jobs/'+j.payload.jobId+'/task',f.provider)).status,503);
 assert.equal((await j.post('execute',{},f.provider)).status,503);
 assert.equal((await f.call('/jobs/'+j.payload.jobId+'/task',f.outsider)).status,403,'authorization precedes task access');
});

test('recipe decoder AES records survive reload beside legacy decoders and fail on context/ciphertext tampering',async()=>{
 const storage=new LocalStorage(),vault=createVault('buyer',{storage});
 const old=await createGarbledJob([255,150]),next=await prepareRecipe([255,150],numberRecipe);
 await vault.saveDecoder('legacy',old);await vault.saveDecoder('recipe',next);
 const reloaded=createVault('buyer',{storage}),legacyResult=await executeTask(old.request),result=await executeTask(next.request);
 assert.deepEqual(await reloaded.decodeDelivery('legacy',legacyResult.outputs),[0,100]);assert.deepEqual(await reloaded.decodeDelivery('recipe',result),[10,80]);
 await assert.rejects(reloaded.decodeDelivery('recipe',{...result,inputSha256:'0'.repeat(64)}));
 await assert.rejects(reloaded.decodeDelivery('recipe',{...result,programSha256:'0'.repeat(64)}));
 const foreign=await prepareRecipe([255,150],numberRecipe);await assert.rejects(reloaded.decodeDelivery('recipe',await executeTask(foreign.request)));
 await assert.rejects(vault.saveDecoder('mismatch',{request:next.request,decoder:foreign.decoder}));
 const record=await storage.get(['buyer','decoder','recipe']);assert.deepEqual(Object.keys(record).sort(),['ciphertext','iv']);
 await storage.put(['buyer','decoder','copy'],record);await assert.rejects(reloaded.decodeDelivery('copy',result));
 const raw=Buffer.from(record.ciphertext,'base64');raw[0]^=1;await storage.put(['buyer','decoder','recipe'],{...record,ciphertext:raw.toString('base64')});await assert.rejects(reloaded.decodeDelivery('recipe',result));
});

test('recipe CSV preserves unselected fields, missing sentinels and strict local limits before garbling',()=>{
 const dataset=parseCSV('key;selected;other\nS1;"  ABC91  ";"x,y"\nS2;"A B3";keep\n');
 const values=parseRecipeColumn(dataset,1,textRecipe);assert.deepEqual(values,['  ABC91  ','A B3']);
 const out=applyRecipeOutput(dataset,1,referenceApply(values,textRecipe),textRecipe);assert.deepEqual(out.rows,[['S1','abc**','x,y'],['S2','a b*','keep']]);assert.deepEqual(out.headers,dataset.headers);assert.equal(out.delimiter,';');
 assert.throws(()=>applyRecipeOutput(dataset,1,['bad','bad'],textRecipe));
 for(const value of ['ş','a'.repeat(17)])assert.throws(()=>parseRecipeColumn(parseCSV('selected\n'+value+'\n'),0,textRecipe));
 assert.throws(()=>parseRecipeColumn(parseCSV('selected\n'+Array(9).fill('ABC').join('\n')+'\n'),0,textRecipe));
 const missing=parseCSV('selected\n""\n'),clampOnly={type:'number',steps:[{op:'clamp',min:10,max:80}]};assert.equal(applyRecipeOutput(missing,0,[255],clampOnly).rows[0][0],'');
 assert.throws(()=>estimateRecipe({type:'text',steps:[{op:'trim'},{op:'trim'},{op:'trim'},{op:'trim'}]},8));
});

// Minimal DOM adapter exercises the production SPA handlers with the actual
// workspace API, crypto engine and AES vault. It does not claim visual QA.
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
function browser(f,who,path,{transform,losePublish=false}={}){
 const elements=new Map(['workspace-root','workspace-nav','workspace-identity','workspace-message','workspace-logout','workspace-heading','workspace-subtitle'].map(k=>[k,new Element('div')]));
 let signingAttempts=0;
 const saved=new Map([[TOKEN_KEY,who.token]]),storage={getItem:k=>saved.get(k),setItem:(k,v)=>saved.set(k,v),removeItem:k=>saved.delete(k)},calls=[];
 const win={location:new URL(ORIGIN+path),sessionStorage:storage,addEventListener(){},navigator:{clipboard:{writeText:async()=>{}}},URL,setTimeout,history:{pushState:(_,__,href)=>win.location=new URL(href,win.location),replaceState:(_,__,href)=>win.location=new URL(href,win.location)}};
 const doc={getElementById:k=>elements.get(k),createElement:tag=>new Element(tag),addEventListener(){},querySelectorAll:()=>[...descendants(elements.get('workspace-root')).filter(n=>['BUTTON','INPUT','SELECT','TEXTAREA'].includes(n.tagName)),elements.get('workspace-logout')]};
 const app=createBrowserWorkspace({document:doc,window:win,storage,walletFactory:async()=>{signingAttempts++;throw Error('Readonly legacy UI never requests a signer');},vaultFactory:session=>createVault(session,{storage:f.localStore}),fetch:async(url,options)=>{
  const parsed=new URL(url,ORIGIN),route='/'+parsed.searchParams.get('route'),body=options.body?JSON.parse(options.body):undefined;calls.push({route,body,method:options.method});
  const result=await f.call(route,who,body,options.method);
  if(losePublish&&route==='/jobs'&&options.method==='POST')throw Error('synthetic lost response after committed publication');
  if(transform&&result.data.job)transform(result.data.job);
  return {ok:result.status>=200&&result.status<300,status:result.status,json:async()=>result.data};
 }});
 const all=()=>descendants(elements.get('workspace-root')),get=name=>all().find(e=>e.name===name);
 async function settle(){for(let i=0;i<30000&&app.state.busy;i++)await new Promise(resolve=>setTimeout(resolve,1));assert.equal(app.state.busy,false,'UI operation settles');}
 return {app,calls,all,get,signingAttempts:()=>signingAttempts,text:()=>elements.get('workspace-root').textContent,message:()=>elements.get('workspace-message').textContent,
  change:async(name,value)=>{const input=get(name);assert.ok(input,name);if(input.type==='checkbox')input.checked=value;else input.value=value;await input.fire('change');await settle();},
  upload:async(source)=>{const file=get('csv');file.files=[{size:new TextEncoder().encode(source).length,arrayBuffer:async()=>new TextEncoder().encode(source).buffer}];await file.fire('change');await settle();},
  submit:async()=>{await all().find(e=>e.tagName==='FORM').fire('submit');await settle();},
  click:async(label)=>{const button=all().find(e=>e.tagName==='BUTTON'&&e.textContent===label);assert.ok(button,label);await button.fire('click');await settle();},
 };
}

test('legacy recipe SPA reloads real encrypted decoder and reference results without execution or acceptance actions',async()=>{
 const f=await fixture(),recipe={type:'text',steps:[{op:'trim'},{op:'uppercase'},{op:'redactDigits'}]},dataset=parseCSV('private-key,secret-column,keep\nK1,"  Secret97  ",untouched\nK2,Ab C3,retained\n'),values=parseRecipeColumn(dataset,1,recipe),j=await f.publish(values,recipe),jobId=j.payload.jobId;
 await f.buyer.vault.saveJob(jobId,{dataset,values,column:1,recipe,payload:j.payload,pending:false});await f.buyer.vault.saveDecoder(jobId,j.prepared);
 assert.equal((await j.publish()).status,201);assert.equal(j.payload.task.profile,PROFILE);assert.deepEqual(j.payload.task.recipe,recipe);
 for(const secret of ['private-key','secret-column','Secret97','untouched','outputPairs','decoder'])assert.ok(!JSON.stringify(j.payload).includes(secret),secret);
 assert.equal((await f.buyer.vault.loadJob(jobId)).pending,false);await f.award(j);
 const provider=browser(f,f.provider,'/delivery?id='+jobId);await provider.app.start();assert.ok(provider.text().includes('büyük harf'));assert.ok(!provider.text().includes('Secret97'));assert.equal(provider.all().some(e=>e.textContent==='Şifreli işi yürüt ve teslim et'),false);assert.equal(provider.calls.some(c=>c.method==='POST'),false);assert.equal(provider.signingAttempts(),0);
 assert.equal((await j.post('execute',{},f.provider)).status,200,'actual delivery seeded outside the readonly SPA');
 const reopened=browser(f,f.buyer,'/delivery?id='+jobId);await reopened.app.start();assert.ok(reopened.text().includes('Yerel kontrol başarılı'));assert.ok(reopened.text().includes('Secret97'));assert.ok(reopened.text().includes('SECRET**'));
 const corrupted=browser(f,f.buyer,'/delivery?id='+jobId,{transform:job=>{job.delivery.programSha256='0'.repeat(64);}});await corrupted.app.start();assert.match(corrupted.text(),/Yerel kontrol başarısız|orijinal CSV veya çözme anahtarı yok/);assert.ok(!corrupted.text().includes('Yerel kontrol başarılı'));assert.ok(!corrupted.all().some(e=>e.textContent==='Doğrulanan teslimi kabul et'));
 for(const label of ['Doğrulanan teslimi kabul et','Düzeltme iste'])assert.equal(reopened.all().some(e=>e.textContent===label),false);assert.equal(reopened.calls.some(c=>c.method==='POST'),false);assert.equal(reopened.signingAttempts(),0);assert.equal((await f.call('/jobs/'+jobId,f.buyer)).data.job.status,'DELIVERED');
});

test('legacy v2 pending publication reconciles exact payload/decoder by GET without allowing a replay POST',async()=>{
 const f=await fixture(),dataset=parseCSV('key,points\nS1,190\nS2,\n'),values=parseRecipeColumn(dataset,1,numberRecipe),j=await f.publish(values,numberRecipe),id=j.payload.jobId;
 await f.buyer.vault.saveJob(id,{dataset,values,column:1,recipe:numberRecipe,payload:j.payload,pending:true});await f.buyer.vault.saveDecoder(id,j.prepared);await f.buyer.vault.saveJob('__pending_publish__',{jobId:id,unresolvedJobIds:[id]});assert.equal((await j.publish()).status,201);
 assert.equal(j.payload.profile,PROFILE);assert.deepEqual(j.payload.task.recipe,numberRecipe);assert.equal((await f.buyer.vault.loadJob(id)).pending,true);
 const reloaded=browser(f,f.buyer,'/customer');await reloaded.app.start();assert.ok(reloaded.text().includes(id));await reloaded.click('Aynı kimlik ve içerikle güvenli tekrar dene');assert.equal(reloaded.calls.filter(c=>c.method==='POST').length,0);assert.equal((await f.buyer.vault.loadJob(id)).pending,true);
 await reloaded.click('Aynı işin durumunu kontrol et');assert.equal((await f.buyer.vault.loadJob(id)).pending,false);assert.deepEqual((await f.buyer.vault.loadJob('__pending_publish__')).unresolvedJobIds,[]);
 const task=(await f.call('/jobs/'+id+'/task',f.buyer)).data.task;assert.deepEqual(task,j.payload.task);assert.deepEqual(await createVault(f.buyer.session.id,{storage:f.localStore}).decodeDelivery(id,await executeTask(task)),[80,10]);assert.equal(reloaded.calls.filter(c=>c.method==='POST').length,0,'lookup never republishes');
});

test('only bounded v2 job creation can exceed 1MiB, up to the 3MiB transport cap',async()=>{
 const f=await fixture();
 const recipe={type:'number',steps:[{op:'fill',value:7},{op:'clamp',min:10,max:80},{op:'fill',value:2},{op:'clamp',min:20,max:200}]};
 estimateRecipe(recipe,32);
 const j=await f.publish(Array.from({length:32},(_,i)=>i%2?255:i*7),recipe);
 const size=Buffer.byteLength(JSON.stringify(j.payload));assert.ok(size>1024*1024,'actual approved recipe request exercises expanded transport allowance');assert.ok(size<3*1024*1024);
 assert.equal((await j.publish()).status,201);
 assert.equal((await f.call('/session',null,'x'.repeat(1024*1024+1))).status,413);
 assert.equal((await f.call('/jobs',f.buyer,'x'.repeat(3*1024*1024+1))).status,413);
 assert.equal((await f.call('/jobs',f.buyer,JSON.stringify({...j.payload,task:{...j.payload.task,profile:'nope-csv-gc-v1'}}))).status,413,'legacy requests do not inherit the expanded cap');
});
