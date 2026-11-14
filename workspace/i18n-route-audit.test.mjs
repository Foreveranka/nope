import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {createWorkspace,PROOF_PROFILE,TOKEN_KEY} from '../web/workspace.js';
import {initI18n,setLanguage,getLocale,translate,hasTranslation,msg} from '../web/i18n.mjs';
import {prepareRecipe,decodeRecipe} from '../web/recipe-client.mjs';
import {prepareProofPlan} from '../web/proof-plan-client.mjs';
import {wrapProofPlanResult,SCHEME} from '../web/proof-plan-core.mjs';
import {acceptAgentProposal} from '../web/agent-plan.mjs';
import {parseCSV} from '../web/csv-input.mjs';
import {sha256} from '../web/gc-core.mjs';
import {quoteCommitment} from '../web/workspace-vault.mjs';
import {executeTask} from './gc.mjs';

// OFFLINE rendered-route audit. Actual catalogs, i18n, workspace rendering,
// recipe/proof-plan preparation, GC evaluation and buyer decoding are used.
// API/storage/finality/model/proof metadata are explicit synthetic fixtures.
// No wallet, model asset, prover, RPC or real-chain verification is exercised.
const LANGS=['tr','en','de','es','fr'];
const dictionaries=Object.fromEntries(await Promise.all(LANGS.map(async lang=>[lang,JSON.parse(await readFile(new URL(`../web/locales/${lang}.json`,import.meta.url),'utf8'))])));
const workspaceSource=JSON.parse(await readFile(new URL('../web/locales/workspace-tr.json',import.meta.url),'utf8'));
await initI18n({document:{},window:{},storage:{getItem:()=> 'en'},fetch:async url=>({ok:true,json:async()=>dictionaries[new URL(url).pathname.split('/').at(-1).slice(0,-5)]})});
const ID='a'.repeat(32),TX='2'.repeat(44),BINDING='b'.repeat(64),CONTRACT='route-audit.testnet';
const wallet=accountId=>({accountId,publicKey:'ed25519:'+ '1'.repeat(32),network:'testnet',verifiedAt:'2026-11-14T00:00:00Z'});
const POLICY={network:'testnet',contractId:CONTRACT,codeHash:'2'.repeat(44),domain:'NOPE:WALLET-ESCROW:V2:testnet',requireKeyless:true,storageDepositYocto:'40960000000000000000000'};
const WALLET_CAPABILITY={required:true,enabled:true,network:'testnet',contractId:CONTRACT};
const BUYER={id:'route-audit-buyer',role:'buyer',displayName:'Metin',wallet:wallet('route-buyer.testnet')},PROVIDER={id:'route-audit-provider',role:'provider',displayName:'Sayı',paymentAccount:'route-supplier.testnet',wallet:wallet('route-supplier.testnet')};
const FUTURE=String((BigInt(Date.now())+86400000n)*1000000n),PAST=String((BigInt(Date.now())-86400000n)*1000000n),AMOUNT='1000000000000000000000';
const CSV='Sayı,private-number\nMetin,\n';
const STEPS=[{column:'C1',recipe:{type:'text',steps:[{op:'trim'}]}},{column:'C2',recipe:{type:'number',steps:[{op:'fill',value:7}]}}];
const TASK={version:1,goal:'Metin',columns:[{id:'C1',type:'text'},{id:'C2',type:'number'}]};
const DIAGNOSTIC='UNTRANSLATED SDK RuntimeError: private-local-diagnostic';
const encoded=value=>Object.fromEntries(['profile','nonce','rowCount','outputs','inputSha256','programSha256','outputSha256'].map(k=>[k,value[k]]));
let fixturePromise;
async function fixture(){
 return fixturePromise??=(async()=>{
  const dataset=parseCSV(CSV),approval=await acceptAgentProposal(TASK,{steps:STEPS});
  const proof=await prepareProofPlan({C1:['Metin'],C2:[255]},approval.plan,{jobId:ID,buyerCommitment:await sha256('NOPE:buyer:'+BUYER.id),contractId:CONTRACT});
  const proofResult=await wrapProofPlanResult(proof.request,await executeTask(proof.request.task));
  const recipe={type:'text',steps:[{op:'trim'}]},manual=await prepareRecipe(['Metin'],recipe),manualResult=await executeTask(manual.request);
  const agentApproval={...approval,datasetSha256:await sha256(JSON.stringify(dataset)),model:{id:'UNIT-ONLY-NOT-A-REAL-MODEL',revision:'fixture'}};
  const proofLocal={dataset,values:{C1:['Metin'],C2:[255]},agentApproval,proofDecoder:proof.decoder,proofWitness:proof.witness,payload:{jobId:ID,profile:PROOF_PROFILE,task:proof.request}};
  const manualLocal={dataset,column:0,values:['Metin'],recipe,payload:{task:manual.request}};
  const quote={jobId:ID,providerId:PROVIDER.id,amountYocto:AMOUNT,deliveryHours:1,note:'Tekliflere açık',salt:'d'.repeat(64)};
  const offer={id:'e'.repeat(32),providerId:PROVIDER.id,providerName:PROVIDER.displayName,wallet:structuredClone(PROVIDER.wallet),paymentAccount:PROVIDER.paymentAccount,envelope:{fixture:'NOT-AN-ACTUAL-ENVELOPE'},commitment:await quoteCommitment(ID,PROVIDER.id,AMOUNT,quote.salt)};
  return{dataset,proof,proofResult,proofLocal,manual,manualResult,manualLocal,quote,offer};
 })();
}
function job({status='OPEN',payment='wallet',payStatus='NOT_FUNDED',profile='proof',delivery=false,recorded=true,expired=false,selected=!['OPEN','CLOSED'].includes(status),...changes}={},f){
 const proof=profile==='proof',prepared=proof?f.proof:f.manual,result=proof?f.proofResult:f.manualResult;
 const d=delivery?{...result,version:2}:null;
 const p=payment!=='direct'?{kind:payment==='legacy'?'SPONSORED_TESTNET_ESCROW':'WALLET_TESTNET_ESCROW',network:'testnet',status:payStatus,verified:['HELD','RELEASE_READY','PAID','REFUNDED'].includes(payStatus),contractId:CONTRACT,bindingHash:BINDING,executionDeadlineNs:FUTURE,reviewDeadlineNs:expired?PAST:FUTURE,
  ...(recorded&&d?{recordedVersion:2,recordedOutputHash:d.outputSha256}:{}),fundTransactionHash:TX,...(['RECORD_PENDING','RELEASE_READY','PAYOUT_PENDING','PAID'].includes(payStatus)?{recordTransactionHash:TX}:{}),...(['PAYOUT_PENDING','PAID'].includes(payStatus)?{releaseTransactionHash:TX}:{}),...(['REFUND_PENDING','REFUNDED'].includes(payStatus)?{refundTransactionHash:TX}:{})}:{kind:'DIRECT_TESTNET_TRANSFER',status:payStatus,network:'testnet',...(payStatus==='PAID'?{transactionHash:TX}:{})};
 return{id:ID,buyerId:BUYER.id,buyerWallet:structuredClone(BUYER.wallet),title:'Sayı',description:'Metin',status,profile:prepared.request.profile,rowCount:1,taskHash:result.inputSha256,programHash:result.programSha256,deadlineISO:'2099-12-01T18:30:00Z',offers:[],events:[],payment:p,selectedOffer:selected?{providerId:PROVIDER.id,wallet:structuredClone(PROVIDER.wallet),paymentAccount:PROVIDER.paymentAccount,amountYocto:AMOUNT}:null,
  ...(proof?{plan:f.proof.request.task.plan,planSha256:f.proof.request.task.planSha256,publicTask:TASK,proof:{status:'NOT_CREATED'}}:{recipe:f.manual.request.recipe}),delivery:d,...changes};
}
class Node {
 constructor(doc,type,tag='',text=''){this.ownerDocument=doc;this.nodeType=type;this.tagName=tag.toUpperCase();this.children=[];this.listeners={};this.dataset={};this.attributes={};this.value='';this.disabled=false;this.files=[];this.text=text;}
 get childNodes(){return this.children;}
 set textContent(value){this.children.forEach(n=>n.parentElement=null);this.children=[];this.text=String(value);}
 get textContent(){return this.text+this.children.map(n=>n.textContent).join('');}
 append(...nodes){for(const n of nodes){if(n.parentElement)n.parentElement.children=n.parentElement.children.filter(x=>x!==n);n.parentElement=this;this.children.push(n);if(this.tagName==='SELECT'&&this.children.filter(x=>x.nodeType===1).length===1)this.value=n.value;}}
 replaceChildren(...nodes){this.textContent='';this.append(...nodes);}
 setAttribute(key,value){this.attributes[key]=String(value);if(key==='placeholder')this.placeholder=String(value);}
 getAttribute(key){return this.attributes[key]??null;}
 removeAttribute(key){delete this.attributes[key];}
 addEventListener(key,fn){(this.listeners[key]||=[]).push(fn);}
 reportValidity(){return true;}
 async fire(key,event={}){for(const fn of this.listeners[key]||[])await fn({preventDefault(){},...event});}
}
const descendants=n=>[n,...n.children.flatMap(descendants)];
function browser(f,{path='/customer',identity=BUYER,job:current=job({},f),local='none',capability=true,sessionError,apiError,quoteKey=true,pending=false,modelError,modelSteps=STEPS,garbleProofPlan}={}){
 const elements=new Map(),calls=[],records=new Map(),timers=new Map();let timerId=0;
 const doc={createElement:tag=>new Node(doc,1,tag),createTextNode:text=>new Node(doc,3,'',String(text)),getElementById:id=>elements.get(id),addEventListener(){},querySelectorAll:()=>[...all().filter(n=>['BUTTON','INPUT','SELECT','TEXTAREA'].includes(n.tagName)),elements.get('workspace-logout')]};
 for(const id of ['workspace-root','workspace-nav','workspace-identity','workspace-message','workspace-logout','workspace-heading','workspace-subtitle'])elements.set(id,doc.createElement('div'));
 const all=()=>descendants(elements.get('workspace-root')),storageMap=new Map(identity?[[TOKEN_KEY,'route-unit-token']]:[]);
 const storage={getItem:k=>storageMap.get(k),setItem:(k,v)=>storageMap.set(k,v),removeItem:k=>storageMap.delete(k)};
 const win={location:new URL('http://localhost'+path),sessionStorage:storage,addEventListener(){},setTimeout:fn=>{timers.set(++timerId,fn);return timerId;},clearTimeout:id=>timers.delete(id),history:{pushState:(_,__,href)=>win.location=new URL(href,win.location),replaceState:(_,__,href)=>win.location=new URL(href,win.location)}};
 if(local!=='none')records.set(ID,structuredClone(local==='proof'?f.proofLocal:f.manualLocal));
 if(pending){records.set('__pending_publish__',{unresolvedJobIds:[ID]});records.set(ID,{...f.manualLocal,payload:{task:f.manual.request,title:'Sayı',deadlineISO:'2001-01-01T00:00:00Z'},pending:true});}
 const vault={buyerPublicKey:async()=>({kty:'RSA',n:'unit-public-key'}),loadJob:async key=>records.get(key)||null,saveJob:async(key,value)=>records.set(key,structuredClone(value)),saveDecoder:async()=>{},decodeDelivery:async(_,delivery)=>decodeRecipe(encoded(delivery),f.manual.decoder),decryptQuote:async()=>{if(!quoteKey)throw Error('unit missing key');return structuredClone(f.quote);}};
 const worker=()=>({terminate(){},postMessage(){queueMicrotask(()=>{this.onmessage({data:{type:'progress',stage:'download',file:'unit-model.onnx',loaded:12,total:100}});this.onmessage({data:modelError?{type:'error',stage:'initializing',error:'Local model failed (initializing): '+modelError}:{type:'plan',raw:JSON.stringify({steps:modelSteps}),model:{id:'UNIT-ONLY-NOT-A-REAL-MODEL',revision:'fixture'}}});});}});
 const app=createWorkspace({document:doc,window:win,storage,walletPolicy:POLICY,walletFactory:async()=>{throw Error('Rendered-route audit must not request wallet signatures');},vaultFactory:()=>vault,agentWorkerFactory:worker,garbleProofPlan,fetch:async(url,options)=>{
  const u=new URL(url,'http://localhost'),route='/'+u.searchParams.get('route'),body=options.body?JSON.parse(options.body):undefined;calls.push({route,method:options.method,body});
  const status=route==='/session'?sessionError:apiError;if(status)return{ok:false,status,json:async()=>({error:'RAW SERVER ENGLISH MUST NEVER BE DISPLAYED'})};
  assert.equal(options.method,'GET','route audit never mutates remote jobs');
  return{ok:true,status:200,json:async()=>structuredClone(route==='/session'?{session:identity,proof:{profile:PROOF_PROFILE,enabled:capability,contractId:capability?CONTRACT:null},wallet:WALLET_CAPABILITY}:route==='/jobs'?{jobs:[current]}:{job:current})};
 }});
 async function settle(){for(let i=0;i<10000&&app.state.busy;i++)await new Promise(resolve=>setTimeout(resolve,1));assert.equal(app.state.busy,false);}
 return{app,doc,win,calls,elements,records,timers,all,get:name=>all().find(e=>e.name===name),text:()=>elements.get('workspace-root').textContent,
  enabled:key=>all().some(e=>e.tagName==='BUTTON'&&e.textContent===String(msg(key))&&!e.disabled),
  async click(key){const node=all().find(e=>e.tagName==='BUTTON'&&e.textContent===String(msg(key)));assert.ok(node,key);await node.fire('click');await settle();},
  async change(name,value){const node=this.get(name);assert.ok(node,name);if(node.type==='checkbox')node.checked=!!value;else node.value=value;await node.fire('change');await settle();},
  async upload(){const input=this.get('csv');input.files=[{size:CSV.length,arrayBuffer:async()=>new TextEncoder().encode(CSV).buffer}];await input.fire('change');await settle();},
  async submit(){await all().find(e=>e.tagName==='FORM').fire('submit');await settle();},
 };
}
const escaped=value=>value.replace(/[.*+?^${}()|[\]\\]/g,'\\$&');
const patterns=Object.fromEntries(LANGS.map(lang=>[lang,Object.entries(dictionaries[lang]).filter(([key,value])=>/[\p{L}]{3}/u.test(value)||['{0}: {1}','{0} · {1}','{0} · {1} · {2}'].includes(key)).map(([,value])=>new RegExp('^'+value.split(/\{\d+\}/).map(escaped).join('[\\s\\S]*')+'$','u'))]));
const foreignFragments=Object.fromEntries(LANGS.map(lang=>[lang,[...new Set(LANGS.filter(other=>other!==lang).flatMap(other=>Object.values(dictionaries[other]).flatMap(value=>value.split(/\{\d+\}/)).map(value=>value.trim()).filter(value=>value.length>=18&&!Object.values(dictionaries[lang]).some(target=>target.includes(value)))))]]));
function assertLocalized(h,lang,context){
 const nodes=[...h.elements.values()].flatMap(descendants);
 const raw=new Set(['2099-01-01T00:00:00Z','2099-01-02T00:00:00Z','2099-01-03T00:00:00Z','2099-01-04T00:00:00Z','2099-12-01T18:30:00Z',Number(BigInt(FUTURE)/1000000n),Number(BigInt(PAST)/1000000n)].map(value=>new Date(value).toLocaleString(getLocale())).concat(['Sayı','Metin','private-number','Tekliflere açık','PRIVATE user event: Job created.','CUSTOM_EVENT',ID,TX,BUYER.id,BUYER.wallet.accountId,PROVIDER.id,PROVIDER.paymentAccount,CONTRACT,'C1','C2','0.001',AMOUNT,'UNIT-ONLY-NOT-A-REAL-MODEL','fixture']));
 for(const node of nodes){
  if(node.nodeType!==3)continue;const text=node.textContent.trim();if(!text||raw.has(text)||/^\d+$/.test(text))continue;
  assert.ok(patterns[lang].some(pattern=>pattern.test(text)),`${context} ${lang}: unlocalized leaf ${JSON.stringify(text)}`);
  for(const fragment of foreignFragments[lang])assert.ok(!text.includes(fragment),`${context} ${lang}: foreign built-in fragment ${JSON.stringify(fragment)}`);
  assert.ok(!text.includes(DIAGNOSTIC),`${context}: raw SDK diagnostic leaked`);
 }
 for(const node of nodes.filter(n=>n.nodeType===1))for(const name of ['placeholder','aria-label','title']){
  const value=node.getAttribute(name);if(!value||raw.has(value))continue;
  assert.ok(patterns[lang].some(p=>p.test(value)),`${context} ${lang}: unlocalized ${name}: ${value}`);
 }
 assert.ok(h.calls.every(c=>c.method==='GET'),context+': unexpected mutation');
 assert.ok(h.calls.every(c=>!JSON.stringify(c).includes('private-number')&&!JSON.stringify(c).includes('proofWitness')&&!JSON.stringify(c).includes('outputPairs')),context+': private data left the client');
}
function cases(f){
 const list=[],add=(name,config)=>list.push({name,...config});
 add('guest onboarding',{path:'/workspace',identity:null});
 for(const identity of [BUYER,PROVIDER]){
  for(const path of [identity.role==='buyer'?'/customer':'/provider','/jobs','/settings'])add(identity.role+path,{path,identity});
  const events=[{at:'2099-01-01T00:00:00Z',status:'OPEN',stage:'OPEN',actorId:BUYER.id},{at:'2099-01-02T00:00:00Z',status:'PAID',stage:'PAID',actorId:PROVIDER.id},{at:'2099-01-03T00:00:00Z',type:'CUSTOM_EVENT',message:'PRIVATE user event: Job created.'},{at:'2099-01-04T00:00:00Z',status:'OPEN',message:'Tekliflere açık'}];
  add(identity.role+' history',{path:'/activity',identity,job:job({events},f)});
  for(const status of ['OPEN','CLOSED'])add(identity.role+' '+status+' detail',{path:'/job?id='+ID,identity,job:job({status,offers:status==='CLOSED'?[f.offer]:[]},f)});
  for(const payStatus of ['DUE','PAID','NOT_DUE'])add(identity.role+' direct '+payStatus,{path:'/payments?id='+ID,identity,job:job({payment:'direct',profile:'manual',status:payStatus==='PAID'?'PAID':'ACCEPTED',payStatus},f)});
  for(const payStatus of ['NOT_FUNDED','FUNDING_PENDING','RECORD_PENDING','PAYOUT_PENDING','REFUND_PENDING','UNKNOWN','ERROR','HELD','RELEASE_READY','PAID','REFUNDED']){
   const status=payStatus==='PAID'?'PAID':payStatus==='REFUNDED'?'REFUNDED':['PAYOUT_PENDING','RELEASE_READY'].includes(payStatus)?'ACCEPTED':['HELD','RECORD_PENDING'].includes(payStatus)?'DELIVERED':'AWARDED';
   add(identity.role+' escrow '+payStatus,{path:'/payments?id='+ID,identity,job:job({payment:'escrow',status,payStatus,delivery:status!=='AWARDED'},f)});
  }
 }
 add('v4 new job',{path:'/jobs/new'});add('disabled proof new job',{path:'/jobs/new',capability:false});
 add('new job role guard',{path:'/jobs/new',identity:PROVIDER});add('offer role guard',{path:'/offer?id='+ID});
 for(const payment of ['direct','escrow'])add('provider '+payment+' offer',{path:'/offer?id='+ID,identity:PROVIDER,job:job({payment,payStatus:payment==='direct'?'NOT_DUE':'NOT_FUNDED'},f)});
 add('closed offer guard',{path:'/offer?id='+ID,identity:PROVIDER,job:job({status:'CLOSED'},f)});
 add('sealed quote missing local key',{path:'/job?id='+ID,quoteKey:false,job:job({status:'CLOSED',offers:[f.offer]},f)});
 for(const payStatus of ['HELD','NOT_FUNDED','FUNDING_PENDING','UNKNOWN','REFUNDED'])add('provider execution '+payStatus,{path:'/delivery?id='+ID,identity:PROVIDER,job:job({status:'AWARDED',payment:'escrow',payStatus},f)});
 add('provider revision',{path:'/delivery?id='+ID,identity:PROVIDER,job:job({status:'REVISION',payment:'escrow',payStatus:'HELD'},f)});
 add('buyer no delivery',{path:'/delivery?id='+ID,job:job({status:'AWARDED'},f)});
 add('buyer missing local key',{path:'/delivery?id='+ID,job:job({status:'DELIVERED',delivery:true},f)});
 add('buyer decoded manual',{path:'/delivery?id='+ID,local:'manual',job:job({payment:'direct',profile:'manual',status:'DELIVERED',delivery:true},f)});
 add('buyer proof pending',{path:'/delivery?id='+ID,local:'proof',job:job({profile:'proof',payment:'escrow',payStatus:'HELD',status:'DELIVERED',delivery:true},f)});
 const proofRecorded=job({profile:'proof',payment:'escrow',payStatus:'HELD',status:'DELIVERED',delivery:true},f);
 proofRecorded.proof={status:'VERIFIED',scheme:SCHEME,version:1,rowProofCount:2,deliveryVersion:2,outputSha256:proofRecorded.delivery.outputSha256,requestSha256:proofRecorded.delivery.inputSha256,programSha256:proofRecorded.delivery.programSha256,planSha256:proofRecorded.planSha256,bindingHash:BINDING,bundleSha256:'c'.repeat(64),finalContext:'d'.repeat(64),manifestSha256:'e'.repeat(64)};
 add('buyer proof server-only verification',{path:'/delivery?id='+ID,local:'proof',job:proofRecorded});
 add('buyer proof missing key',{path:'/delivery?id='+ID,job:job({profile:'proof',payment:'escrow',payStatus:'HELD',status:'DELIVERED',delivery:true},f)});
 add('buyer record pending',{path:'/delivery?id='+ID,local:'proof',job:job({payment:'escrow',payStatus:'RECORD_PENDING',recorded:false,status:'DELIVERED',delivery:true},f)});
 add('buyer stale recorded version',{path:'/delivery?id='+ID,local:'proof',job:job({payment:'escrow',payStatus:'HELD',recorded:false,status:'DELIVERED',delivery:true},f)});
 add('accepted expired refund',{path:'/payments?id='+ID,job:job({payment:'escrow',payStatus:'RELEASE_READY',status:'ACCEPTED',delivery:true,expired:true},f)});
 add('missing selected provider',{path:'/payments?id='+ID,job:job({selected:false},f)});
 const unknown=job({},f);unknown.payment={kind:'CUSTOM_KIND'};add('unknown payment kind',{path:'/payments?id='+ID,job:unknown});
 for(const [action,status,payStatus] of [['fund','AWARDED','FUNDING_PENDING'],['record','DELIVERED','RECORD_PENDING'],['release','ACCEPTED','PAYOUT_PENDING'],['refund','ACCEPTED','REFUND_PENDING']]){
  const resumable=job({payment:'escrow',status,payStatus,delivery:action!=='fund',expired:action==='refund'},f);resumable.payment.operation={action,status:'PENDING',resumeAction:action};
  add('stale server resume hint '+action,{path:'/payments?id='+ID,job:resumable});
 }
 add('recovery pending publication',{pending:true});
 for(const apiError of [403,404,409,429,503])add('job API '+apiError,{path:'/job?id='+ID,apiError});
 add('session retry',{sessionError:503});
 return list;
}

test('five real catalogs cover rendered workspace routes for both roles, payment states and missing-key errors; live switching preserves nodes and requests',async t=>{
 const f=await fixture(),matrix=cases(f);assert.equal(matrix.length,77,'preserve the prior route/role/status matrix');let rendered=0;
 for(const [i,lang] of LANGS.entries())for(const c of matrix){
  setLanguage(lang,{persist:false});const h=browser(f,c);await h.app.start();assertLocalized(h,lang,c.name);rendered++;
  const count=h.calls.length,inputs=h.all().filter(n=>['INPUT','SELECT','TEXTAREA'].includes(n.tagName));
  const next=LANGS[(i+1)%LANGS.length];setLanguage(next,{persist:false});assertLocalized(h,next,c.name+' live');assert.equal(h.calls.length,count);assert.deepEqual(h.all().filter(n=>['INPUT','SELECT','TEXTAREA'].includes(n.tagName)),inputs);
  if(c.name==='provider execution HELD')assert.equal(h.enabled('Şifreli işi yürüt ve teslim et'),true);
  if(/^provider execution (?!HELD)/.test(c.name))assert.equal(h.enabled('Şifreli işi yürüt ve teslim et'),false);
  if(c.name==='buyer proof pending'||c.name==='buyer proof server-only verification'||c.name==='buyer record pending'||c.name==='buyer stale recorded version')assert.equal(h.enabled('Doğrulanan teslimi kabul et'),false);
  if(c.name==='buyer record pending'||c.name==='buyer stale recorded version')assert.equal(h.enabled('Düzeltme iste'),false);
  if(['buyer decoded manual','buyer proof pending','buyer proof server-only verification'].includes(c.name))assert.ok(h.text().includes(String(msg('Yerel kontrol başarılı: sonuç desteklenen temizleme kuralıyla eşleşiyor.'))),c.name);
  if(c.name==='buyer decoded manual')assert.equal(h.enabled('Doğrulanan teslimi kabul et'),false,'legacy records remain readonly even after real local decoding');
  if(c.name==='buyer proof pending'){assert.equal(h.enabled('Sonuç kanıtını oluştur ve doğrula'),true);assert.equal(h.enabled('Düzeltme iste'),true);}
  if(c.name==='buyer proof server-only verification'){assert.equal(h.enabled('Kanıtı bu cihazda bağımsız doğrula'),true);assert.equal(h.enabled('Düzeltme iste'),true);}
  if(c.name==='buyer missing local key'||c.name==='buyer proof missing key'){assert.ok(h.text().includes(String(msg('Bu cihazda orijinal CSV veya çözme anahtarı yok ya da teslim açılamıyor. Aynı tarayıcı ve cihazdaki kasayla yeniden açın. Oturum açmak anahtarları başka cihaza taşımaz; sonuç veya kabul oluşturulmadı.'))));assert.equal(h.enabled('Doğrulanan teslimi kabul et'),false);}
  if(c.name.endsWith('escrow PAID')||c.name.endsWith('escrow REFUNDED')){assert.equal(h.enabled('Kendi cüzdanımdan tam tutarı yatır'),false);assert.equal(h.enabled('Süre doldu · kendi cüzdanıma iade iste'),false);assert.equal(h.enabled('Son teslimin ödemesini cüzdanımda onayla'),false);}
  if(c.name==='accepted expired refund'){assert.equal(h.enabled('Son teslimin ödemesini cüzdanımda onayla'),false);assert.equal(h.enabled('Süre doldu · kendi cüzdanıma iade iste'),true);}
  if(c.name.endsWith('history')){assert.ok(h.text().includes('PRIVATE user event: Job created.'));assert.ok(h.text().includes('Tekliflere açık'));assert.ok(h.text().includes('CUSTOM_EVENT'));}
 }
 t.diagnostic(`${matrix.length} route/role/status cases × 5 languages = ${rendered} initial views and ${rendered} live-switch views; no remote mutations`);
});

test('actual create-job validation and model errors are localized in five languages, including Turkish internal-error text and unknown SDK failures',async()=>{
 const f=await fixture();
 for(const lang of LANGS){
  setLanguage(lang,{persist:false});const blocked=browser(f,{path:'/jobs/new',capability:false});await blocked.app.start();assert.equal(blocked.get('csv'),undefined);assertLocalized(blocked,lang,'proof capability blocked');
  const h=browser(f,{path:'/jobs/new',modelSteps:[{column:'C2',recipe:{type:'number',steps:[{op:'clamp',min:100,max:10}]}}]});await h.app.start();await h.upload();await h.change('agentColumn2','number');h.get('agentGoal').value='Metin';await h.click('Yerel ajanla plan üret');
  assert.equal(h.elements.get('workspace-message').textContent,translate('Invalid clamp range 0..254.'),lang);assertLocalized(h,lang,'invalid clamp');
  if(lang==='tr')assert.ok(!h.text().includes('Invalid clamp range'));
  for(const modelError of ['Model did not emit operation tuples.',DIAGNOSTIC]){
   const agent=browser(f,{path:'/jobs/new',modelError});await agent.app.start();await agent.upload();await agent.change('agentColumn1','text');await agent.change('agentColumn2','number');agent.get('agentGoal').value='Metin';await agent.click('Yerel ajanla plan üret');assertLocalized(agent,lang,'model error');
   assert.equal(agent.get('agentApprove').checked,false);assert.equal(agent.get('agentApprove').disabled,true);assert.ok(!agent.elements.get('workspace-message').textContent.includes(DIAGNOSTIC));
  }
 }
});

test('real DOM text-leaf bindings preserve populated agent drafts, local headers, raw goals and approval while all five languages change',async()=>{
 const f=await fixture();setLanguage('en',{persist:false});const h=browser(f,{path:'/jobs/new'});await h.app.start();await h.upload();await h.change('agentColumn1','text');await h.change('agentColumn2','number');h.get('agentGoal').value='Metin';h.get('title').value='Sayı';h.get('description').value='Metin';await h.click('Yerel ajanla plan üret');await h.change('agentApprove',true);
 const form=h.all().find(n=>n.tagName==='FORM'),goal=h.get('agentGoal'),approve=h.get('agentApprove'),count=h.calls.length;
 for(const lang of LANGS){setLanguage(lang,{persist:false});assertLocalized(h,lang,'populated agent draft');assert.equal(h.get('agentGoal'),goal);assert.equal(goal.value,'Metin');assert.equal(h.get('title').value,'Sayı');assert.equal(h.get('description').value,'Metin');assert.equal(h.get('agentApprove'),approve);assert.equal(approve.checked,true);assert.equal(approve.disabled,false);assert.equal(h.all().find(n=>n.tagName==='FORM'),form);assert.equal(h.calls.length,count);assert.ok(h.text().includes('Sayı'));assert.ok(h.text().includes('Metin'));}
});

test('unknown proof-preparation SDK diagnostics stay local and never permit publication or proof acceptance',async()=>{
 const f=await fixture();
 for(const lang of LANGS){
  setLanguage(lang,{persist:false});const h=browser(f,{path:'/jobs/new',garbleProofPlan:async()=>{throw Error(DIAGNOSTIC);}});await h.app.start();await h.upload();await h.change('agentColumn1','text');await h.change('agentColumn2','number');h.get('agentGoal').value='Metin';h.get('title').value='Sayı';await h.click('Yerel ajanla plan üret');await h.change('agentApprove',true);await h.submit();
  assert.equal(h.elements.get('workspace-message').textContent,String(msg('İşlem tamamlanamadı. Bağlantıyı ve bu cihazdaki yerel kasayı kontrol edip durumu yenileyin.')));assertLocalized(h,lang,'unknown SDK failure');assert.ok(h.calls.every(c=>c.method==='GET'));
 }
});

test('Turkish source diagnostic values are Turkish while target-language source-key sets remain complete',()=>{
 for(const key of Object.keys(workspaceSource)){
  assert.ok(hasTranslation(key),`missing catalog membership: ${key}`);
  assert.equal(dictionaries.tr[key],workspaceSource[key],'regenerate the merged Turkish catalog from source values');
  for(const lang of LANGS)assert.ok(Object.hasOwn(dictionaries[lang],key),`${lang}: missing source key ${key}`);
 }
 // Membership includes identity English translations; it is not inferred from
 // translated text being different from the source diagnostic.
 assert.ok(hasTranslation('Secure WebCrypto is required.'));
 assert.equal(dictionaries.en['Secure WebCrypto is required.'],'Secure WebCrypto is required.');
 const englishDiagnostic=/^(?:A nonempty |Actual |Approved |Delivery revision |Duplicate |Expected |Fill must |Final |Hash input |IndexedDB |Invalid |Local (?:model|planning) |Mapped plan |Model (?:asset|chose|did|download|integrity|manifest|requested) |No local |Operation |Outer delivery |Output |Oversized |Plan (?:and|decoder|exceeds|hash|output|result|task) |Private (?:pairs|witness) |Proof(?:-| (?:bundle|buyer|contract|job|plan|result|row))|Public (?:planning|task) |Random nonce |Recipe |Secure WebCrypto |Statement |Unapproved |Unexpected |Unknown recipe |Unlisted |Unsupported |Unverified |Vault )/;
 assert.deepEqual(Object.entries(workspaceSource).filter(([key,value])=>key===value&&englishDiagnostic.test(key)),[],'English diagnostic values remain untranslated in Turkish');
});


test('provider offer validation preserves raw notes, amounts and inputs across five languages without posting a quote',async()=>{
 const f=await fixture();
 for(const lang of LANGS){
  setLanguage(lang,{persist:false});const h=browser(f,{path:'/offer?id='+ID,identity:PROVIDER,job:job({payment:'escrow',payStatus:'NOT_FUNDED'},f)});await h.app.start();
  const amount=h.get('amount'),note=h.get('note');amount.value='invalid';note.value='Metin';await h.submit();
  assert.equal(h.elements.get('workspace-message').textContent,String(msg('Geçerli bir testNEAR tutarı girin (en fazla 24 ondalık).')));assertLocalized(h,lang,'provider amount error');
  amount.value='1.000000000000000000000001';await h.submit();assert.equal(h.elements.get('workspace-message').textContent,String(msg('Bu cüzdan sözleşmesinde teklif en fazla 1 testNEAR olabilir.')));assertLocalized(h,lang,'provider cap error');
  for(const next of LANGS){setLanguage(next,{persist:false});assert.equal(h.get('amount'),amount);assert.equal(h.get('note'),note);assert.equal(amount.value,'1.000000000000000000000001');assert.equal(note.value,'Metin');assertLocalized(h,next,'provider preserved note');}
 }
});
