import test from 'node:test';
import assert from 'node:assert/strict';
import {createWorkspace,prepareApprovedRecordJob,createPayload,verifyFundingCommitments,serverProofMatches,hashPublicProofBundle,RECORD_PROFILE,PROOF_PROFILE,TOKEN_KEY} from './workspace.js';
import {recordTemplate,privateRecordInputs} from './record-plan.mjs';
import {prepareProofPlan} from './proof-client.mjs';
import {RECORD_SCHEME,SCHEME,wrapProofPlanResult,hashProofPlanRequest,hashProofPlanProgram,hashProofManifest} from './proof-protocol.mjs';
import {evaluateRecordRequest} from '../api/record-gc.mjs';
import {parseCSV} from './csv-input.mjs';
import {sha256} from './gc-core.mjs';

// Real local GC, proof precommitments and decoding. UI API/proof-worker/wallet
// fixtures below are NOT evidence of SNARK execution, chain finality or signing.
const ID='7'.repeat(32),CONTRACT='record-ui.testnet',BINDING='b'.repeat(64);
const wallet=accountId=>({accountId,publicKey:'ed25519:'+'1'.repeat(32),network:'testnet',verifiedAt:'2026-11-14T00:00:00Z'});
const BUYER={id:'a'.repeat(32),role:'buyer',displayName:'UI fixture',wallet:wallet('record-buyer.testnet')};
const POLICY={network:'testnet',contractId:CONTRACT,codeHash:'2'.repeat(44),domain:'NOPE:WALLET-ESCROW:V2:testnet',requireKeyless:true,storageDepositYocto:'40960000000000000000000'};
const CSV='özel-miktar;özel-birim;özel-fatura;özel-bütçe;özel-not\n3;12500;40000;50000;Çağrı 日本語\n';
const task={version:2,goal:'Audit the four anonymous invoice fields.',columns:[1,2,3,4].map(i=>({id:`C${i}`,type:'uint32'}))};
const options={jobId:ID,buyerCommitment:await sha256('NOPE:buyer:'+BUYER.id),contractId:CONTRACT};
const future=()=>String((BigInt(Date.now())+86400000n)*1000000n);
class Element{
 constructor(tag){this.tagName=tag.toUpperCase();this.children=[];this.listeners={};this.dataset={};this.attributes={};this.value='';this.disabled=false;this.files=[];}
 set textContent(v){this.text=String(v);this.children=[];}
 get textContent(){return(this.text||'')+this.children.map(x=>x.textContent).join(' ');}
 append(...nodes){for(const node of nodes){if(node.parentElement)node.parentElement.children=node.parentElement.children.filter(x=>x!==node);node.parentElement=this;this.children.push(node);if(this.tagName==='SELECT'&&this.children.length===1)this.value=node.value;}}
 replaceChildren(...nodes){this.children.forEach(n=>n.parentElement=null);this.children=[];this.text='';this.append(...nodes);}
 addEventListener(name,fn){(this.listeners[name]??=[]).push(fn);}
 setAttribute(k,v){this.attributes[k]=v;}
 removeAttribute(k){delete this.attributes[k];}
 reportValidity(){return true;}
 click(){}
 async fire(type){for(const fn of this.listeners[type]||[])await fn({preventDefault(){},button:0});}
}
const descendants=n=>[n,...n.children.flatMap(descendants)];
async function settle(app){for(let i=0;i<15000&&app.state.busy;i++)await new Promise(r=>setTimeout(r,1));assert.equal(app.state.busy,false,'UI action settled');}
let cached;
async function fixture(){
 if(!cached)cached=(async()=>{
  const dataset=parseCSV(CSV),approval=await recordTemplate(task,'invoice',['C1','C2','C3','C4']),values=privateRecordInputs(dataset,approval.plan);
  const prepared=await prepareProofPlan(values,approval.plan,options),result=await wrapProofPlanResult(prepared.request,await evaluateRecordRequest(prepared.request.task));
  return {dataset,values,prepared,result,approval:{...approval,datasetSha256:await sha256(JSON.stringify(dataset)),epoch:1,templateKind:'invoice'}};
 })();
 const f=structuredClone(await cached);f.local={dataset:f.dataset,values:f.values,recordApproval:f.approval,proofDecoder:f.prepared.decoder,proofWitness:f.prepared.witness,payload:{jobId:ID,profile:RECORD_PROFILE,task:f.prepared.request,publicTask:task}};
 f.job={id:ID,buyerId:BUYER.id,buyerWallet:wallet(BUYER.wallet.accountId),profile:RECORD_PROFILE,title:'Record invoice',description:'UI fixture',status:'DELIVERED',rowCount:1,publicTask:task,plan:f.approval.plan,planSha256:f.approval.planSha256,events:[],offers:[],delivery:{...f.result,version:1},selectedOffer:{providerId:'provider',paymentAccount:'record-supplier.testnet',wallet:wallet('record-supplier.testnet'),amountYocto:'1'},payment:{kind:'WALLET_TESTNET_ESCROW',network:'testnet',contractId:CONTRACT,bindingHash:BINDING,status:'HELD',verified:true,recordedVersion:1,recordedOutputHash:f.result.outputSha256,executionDeadlineNs:future(),reviewDeadlineNs:future()}};
 f.bundle={version:1,scheme:RECORD_SCHEME,finalContext:'f'.repeat(64),rows:[{column:'C1',row:0,proof:{fixture:'UNIT-NOT-A-SNARK'}}]};
 f.metadata=async()=>({status:'VERIFIED',scheme:RECORD_SCHEME,version:1,rowProofCount:1,bundleSha256:await hashPublicProofBundle(f.bundle),finalContext:f.bundle.finalContext,manifestSha256:await hashProofManifest(f.prepared.request),requestSha256:f.result.inputSha256,programSha256:f.result.programSha256,planSha256:f.approval.planSha256,deliveryVersion:f.job.delivery.version,outputSha256:f.result.outputSha256,bindingHash:BINDING});
 return f;
}
function browser({f,path='/jobs/new?workload=record',garbleProofPlan,saveHook,invalidWorker=false}={}){
 const elements=new Map(['workspace-root','workspace-nav','workspace-identity','workspace-message','workspace-logout','workspace-heading','workspace-subtitle'].map(k=>[k,new Element('div')]));
 const records=new Map(f?[[ID,structuredClone(f.local)]]:[]),order=[],calls=[],blobs=[],workerMessages=[];let modelCalls=0,app;
 const storage={getItem:k=>k===TOKEN_KEY?'unit-token':null,setItem(){},removeItem(){}};
 const win={location:new URL('http://localhost'+path),sessionStorage:storage,addEventListener(){},setTimeout:()=>1,clearTimeout(){},URL:{createObjectURL:blob=>{blobs.push(blob);return 'blob:unit';},revokeObjectURL(){}},history:{pushState:(_,__,href)=>win.location=new URL(href,win.location),replaceState:(_,__,href)=>win.location=new URL(href,win.location)}};
 const all=()=>descendants(elements.get('workspace-root')),doc={getElementById:k=>elements.get(k),createElement:tag=>new Element(tag),addEventListener(){},querySelectorAll:()=>all().filter(n=>['BUTTON','INPUT','SELECT','TEXTAREA'].includes(n.tagName))};
 const vault={loadJob:async id=>records.get(id),saveJob:async(id,value)=>{order.push('save:'+id);records.set(id,structuredClone(value));await saveHook?.(id,value,app);},buyerPublicKey:async()=>({kty:'RSA',n:'UNIT-PUBLIC-ONLY'})};
 app=createWorkspace({document:doc,window:win,storage,vaultFactory:()=>vault,walletPolicy:POLICY,garbleProofPlan,
  walletFactory:async()=>{throw Error('No wallet signatures in UI tests');},agentWorkerFactory:()=>{modelCalls++;throw Error('Templates must not invoke a model');},
  proofWorkerFactory:()=>({terminate(){},postMessage(value){workerMessages.push(structuredClone(value));queueMicrotask(()=>this.onmessage({data:value.type==='prove'?{type:'proof',bundle:f.bundle}:{type:'verified',valid:!invalidWorker}}));}}),
  fetch:async(url,opts)=>{
   const route='/'+new URL(url,'http://localhost').searchParams.get('route'),body=opts.body?JSON.parse(opts.body):undefined;calls.push({route,method:opts.method,body});order.push('network:'+opts.method+':'+route);let data;
   if(route==='/session')data={session:BUYER,proof:{profile:PROOF_PROFILE,enabled:true,contractId:CONTRACT},wallet:{required:true,enabled:true,network:'testnet',contractId:CONTRACT}};
   else if(route==='/jobs'&&opts.method==='POST')data={job:{id:body.jobId,buyerId:BUYER.id,buyerWallet:BUYER.wallet,profile:body.profile,status:'OPEN',title:body.title,description:body.description,rowCount:body.rowCount,plan:body.task.task.plan,planSha256:body.task.task.planSha256,publicTask:body.publicTask,events:[],offers:[]}};
   else if(route==='/jobs')data={jobs:[]};
   else if(route.endsWith('/proof/evidence'))data={version:1,network:'testnet',jobId:ID,task:f.prepared.request,bundle:f.bundle};
   else if(route.endsWith('/decision')){f.job.status=body.decision==='accept'?'ACCEPTED':'REVISION';if(body.decision==='accept')f.job.payment.status='RELEASE_READY';data={job:f.job};}
   else data={job:f?.job};
   return{ok:true,status:200,json:async()=>structuredClone(data)};
  }});
 return{app,all,calls,records,order,blobs,workerMessages,win,modelCalls:()=>modelCalls,get:name=>all().find(n=>n.name===name),text:()=>elements.get('workspace-root').textContent,message:()=>elements.get('workspace-message').textContent,
  enabled:label=>all().some(n=>n.tagName==='BUTTON'&&n.textContent===label&&!n.disabled),
  change:async(name,value)=>{const n=all().find(n=>n.name===name);assert.ok(n,name);if(n.type==='checkbox')n.checked=value;else n.value=value;await n.fire('change');await settle(app);},
  click:async text=>{const n=all().find(n=>n.tagName==='BUTTON'&&n.textContent===text);assert.ok(n,text);await n.fire('click');await settle(app);},
  upload:async(csv=CSV)=>{const n=all().find(n=>n.name==='csv');n.files=[{size:Buffer.byteLength(csv),arrayBuffer:async()=>new TextEncoder().encode(csv).buffer}];await n.fire('change');await settle(app);},
  submit:async()=>{await all().find(n=>n.tagName==='FORM').fire('submit');await settle(app);}};
}
async function mapInvoice(h){await h.upload();for(let i=0;i<4;i++)await h.change('recordRole'+i,'C'+(i+1));await h.click('Kuralları ve yerel sonuçları önizle');}

test('record query selects the template mode; role mapping and original-plus-derived preview stay local without a model',async()=>{
 const h=browser();await h.app.start();assert.equal(h.get('planningMode').value,'record');await mapInvoice(h);
 assert.ok(h.text().includes('37500'));assert.ok(h.text().includes('2500'));assert.ok(h.text().includes('Çağrı 日本語'));assert.ok(h.text().includes('yapay zekâ üretimi değildir'));
 assert.ok(h.text().includes('1887/10000'));assert.equal(h.get('recordApprove').disabled,false);assert.equal(h.enabled('Şifrele ve işi yayımla'),false);assert.equal(h.modelCalls(),0);
 const advanced=h.all().find(n=>n.tagName==='DETAILS'&&n.dataset.recordTechnical==='true');assert.ok(advanced);assert.notEqual(advanced.open,true);
 assert.equal(advanced.children[0].tagName,'SUMMARY');assert.equal(advanced.children[0].textContent,'Teknik planı göster');assert.ok(advanced.textContent.includes('1887/10000'));assert.ok(advanced.textContent.includes('R12'));
 const mainText=n=>n.tagName==='DETAILS'?'':(n.text||'')+n.children.map(mainText).join(' ');
 const visible=h.all().filter(n=>n.tagName==='FORM').map(mainText).join(' ');assert.ok(visible.includes('miktar × birim fiyat'));assert.ok(!visible.includes('R12'));assert.ok(!visible.includes('1887/10000'));
 assert.ok(h.calls.every(c=>c.method==='GET'));await h.change('recordApprove',true);assert.equal(h.enabled('Şifrele ve işi yayımla'),true);
 await h.change('recordRole0','C2');assert.equal(h.get('recordApprove').checked,false);assert.equal(h.enabled('Şifrele ve işi yayımla'),false);
 await h.click('Kuralları ve yerel sonuçları önizle');assert.match(h.message(),/farklı/);assert.equal(h.get('recordApprove').disabled,true);
});

test('real record preparation is context-bound and locally saved before POST; only public v2 aliases leave the UI',async()=>{
 const h=browser();await h.app.start();await mapInvoice(h);await h.change('recordApprove',true);h.get('title').value='Anonymous invoice audit';await h.submit();
 const post=h.calls.find(c=>c.route==='/jobs'&&c.method==='POST');assert.ok(post,h.message());assert.equal(post.body.profile,RECORD_PROFILE);assert.equal(post.body.publicTask.version,2);
 assert.deepEqual(post.body.publicTask.columns,[1,2,3,4].map(i=>({id:'C'+i,type:'uint32'})));
 const local=h.records.get(post.body.jobId);assert.ok(local.proofWitness.rows[0].inputPairs);assert.equal(local.proofDecoder.profile,RECORD_PROFILE);assert.ok(local.recordApproval.datasetSha256);assert.equal(local.pending,false);
 assert.ok(h.order.indexOf('save:'+post.body.jobId)<h.order.indexOf('network:POST:/jobs'));
 for(const secret of ['özel-miktar','özel-not','Çağrı','日本語','inputPairs','outputPairs','inputSalt','proofDecoder','templateKind'])assert.ok(!JSON.stringify(post.body).includes(secret),secret);
 assert.equal(createPayload(post.body).rowCount,1);assert.equal(post.body.task.proofManifest.context.jobId,post.body.jobId);assert.equal(post.body.task.proofManifest.context.buyerCommitment,options.buyerCommitment);
});

test('changed file, task or epoch refuses approval before garbling; navigating during vault save refuses POST',async()=>{
 const f=await fixture();let called=0;const garblePlan=()=>{called++;throw Error('must not garble');};
 for(const [dataset,t,approval,epoch]of [[f.dataset,task,f.approval,2],[{...f.dataset,rows:[['4','12500','40000','50000','different']]},task,f.approval,1],[f.dataset,{...task,goal:'Changed public goal'},f.approval,1]])
  await assert.rejects(prepareApprovedRecordJob(dataset,t,approval,{approved:true,epoch,proofOptions:options,garblePlan}));
 await assert.rejects(prepareApprovedRecordJob(f.dataset,task,f.approval,{approved:false,epoch:1,proofOptions:options,garblePlan}));assert.equal(called,0);
 let changed=false;const h=browser({saveHook:async(id,value,app)=>{if(value?.proofDecoder&&!changed){changed=true;app.state.epoch++;}}});
 await h.app.start();await mapInvoice(h);await h.change('recordApprove',true);await h.submit();assert.equal(h.calls.some(c=>c.method==='POST'),false);assert.match(h.message(),/Taslak değişti/);
});

test('u32, mul16 and actual invoice/cashflow budgets refuse locally without data transmission',async()=>{
 for(const csv of [CSV.replace('3;12500','65536;12500'),CSV.replace('3;12500','3;4294967296'),CSV.replace('3;12500','3.0;12500'),'q,u,b,budget\n'+Array(6).fill('3,12500,40000,50000').join('\n')]){
  const h=browser();await h.app.start();await h.upload(csv);for(let i=0;i<4;i++)await h.change('recordRole'+i,'C'+(i+1));await h.click('Kuralları ve yerel sonuçları önizle');assert.equal(h.get('recordApprove').disabled,true);assert.ok(h.calls.every(c=>c.method==='GET'));assert.match(h.message(),/sınırları/);
 }
 const h=browser();await h.app.start();await h.change('recordTemplate','cashflow');
 for(const count of [11,12]){
  await h.upload('income,expenses,debt,payment,limit,request\n'+Array(count).fill('100000,30000,10000,20000,50000,40000').join('\n'));
  for(let i=0;i<6;i++)await h.change('recordRole'+i,'C'+(i+1));await h.click('Kuralları ve yerel sonuçları önizle');assert.equal(h.get('recordApprove').disabled,count===12,h.message());
  if(count===11){assert.ok(h.text().includes('9174/10000'));assert.ok(h.text().includes('60000'));assert.ok(h.text().includes('net nakit akışı − mevcut borç'));}else assert.match(h.message(),/sınırları/);
 }assert.equal(h.modelCalls(),0);assert.ok(h.calls.every(c=>c.method==='GET'));
});

test('record funding validates the exact profile, job, buyer, request, plan and program before any signer',async()=>{
 const f=await fixture(),payload=f.local.payload,job={...f.job,taskHash:await hashProofPlanRequest(f.prepared.request),programHash:await hashProofPlanProgram(f.approval.plan)};
 assert.deepEqual(await verifyFundingCommitments(job,payload),{localChecked:true});
 for(const alter of [p=>p.profile=PROOF_PROFILE,p=>p.jobId='0'.repeat(32),p=>p.task.proofManifest.context.buyerCommitment='0'.repeat(64),p=>p.task.task.planSha256='0'.repeat(64)]){
  const p=structuredClone(payload);alter(p);await assert.rejects(verifyFundingCommitments(job,p));
 }await assert.rejects(verifyFundingCommitments({...job,programHash:'0'.repeat(64)},payload));
});

test('delivery renders original Unicode columns and four derived values; correct proof scheme and current chain record gate acceptance',async()=>{
 const f=await fixture();f.job.proof=await f.metadata();assert.equal(serverProofMatches(f.job),true);const h=browser({f,path:'/delivery?id='+ID});await h.app.start();
 assert.ok(h.text().includes('Yerel kontrol başarılı'),h.text());assert.ok(h.text().includes('Çağrı 日本語'));assert.ok(h.text().includes('37500'));assert.ok(h.text().includes('2500'));assert.ok(h.text().includes('Fatura eşleşiyor'));
 assert.equal(h.enabled('Doğrulanan teslimi kabul et'),false);await h.click('Kanıtı bu cihazda bağımsız doğrula');assert.equal(h.enabled('Doğrulanan teslimi kabul et'),true,h.message());assert.equal(h.workerMessages[0].witness,undefined);
 await h.click('CSV olarak indir (isteğe bağlı)');const csv=await h.blobs[0].text();assert.ok(csv.includes('Çağrı 日本語'));assert.ok(csv.includes('37500;2500;1;0'));
 f.job.proof.scheme=SCHEME;assert.equal(serverProofMatches(f.job),false);await h.click('Doğrulanan teslimi kabul et');assert.equal(h.calls.some(c=>c.route.endsWith('/decision')),false);
 assert.ok(!h.calls.some(c=>c.route.includes('/payment/')),'No payment or wallet operation is automatic.');
});

test('record delivery cannot accept a stale chain record, a mismatching local reference or a failed independent verifier',async()=>{
 for(const scenario of ['chain','values','verifier']){
  const f=await fixture();f.job.proof=await f.metadata();if(scenario==='chain')f.job.payment.recordedVersion=0;if(scenario==='values')f.local.values[0][0]=4;
  const h=browser({f,path:'/delivery?id='+ID,invalidWorker:scenario==='verifier'});await h.app.start();
  if(scenario==='values')assert.ok(h.text().includes('Yerel kontrol başarısız'));else await h.click('Kanıtı bu cihazda bağımsız doğrula');
  assert.equal(h.enabled('Doğrulanan teslimi kabul et'),false,scenario);assert.equal(h.calls.some(c=>c.route.endsWith('/decision')),false);
 }
});
