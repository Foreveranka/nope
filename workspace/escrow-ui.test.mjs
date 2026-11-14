import test from 'node:test';
import assert from 'node:assert/strict';
import {createWorkspace,escrowRecordedDelivery,walletActionAllowed,PROOF_PROFILE,TOKEN_KEY,hashPublicProofBundle} from '../web/workspace.js';
import {createWalletClient} from '../web/wallet-client.mjs';
import {quoteCommitment} from '../web/workspace-vault.mjs';
import {prepareProofPlan} from '../web/proof-plan-client.mjs';
import {wrapProofPlanResult,SCHEME,finalProofContext,hashProofManifest} from '../web/proof-plan-core.mjs';
import {acceptAgentProposal} from '../web/agent-plan.mjs';
import {sha256} from '../web/gc-core.mjs';
import {executeTask} from './gc.mjs';
import {parseCSV} from '../web/csv-input.mjs';

// EXPLICIT OFFLINE UI / WALLET / FINALITY / PROOF-WORKER FIXTURES ONLY.
// v4 preparation, GC evaluation and buyer decoding use actual local code.
// Dedicated tests also run the real wallet-client validator against a synthetic
// connector; other adapter fixtures assert exact known intents and bounds.
// The adapter synthesizes only the known responses below: no signer/key, model,
// prover, RPC, real contract, broadcast or independent chain verification.
const ID='a'.repeat(32),TX='2'.repeat(44),KIND='WALLET_TESTNET_ESCROW',CONTRACT='wallet-ui.testnet';
const POLICY={network:'testnet',contractId:CONTRACT,codeHash:'2'.repeat(44),domain:'NOPE:WALLET-ESCROW:V2:testnet',requireKeyless:true,storageDepositYocto:'40960000000000000000000'};
const CAPABILITY={required:true,enabled:true,network:'testnet',contractId:CONTRACT};
const wallet=accountId=>({accountId,publicKey:'ed25519:'+ '1'.repeat(32),network:'testnet',verifiedAt:'2026-11-14T00:00:00Z'});
const BUYER={id:(await sha256('NOPE:wallet-session:v1:testnet:buyer:buyer-ui.testnet')).slice(0,32),role:'buyer',displayName:'Fixture buyer',wallet:wallet('buyer-ui.testnet')};
const PROVIDER={id:'fixture-provider',role:'provider',displayName:'Fixture provider',paymentAccount:'supplier.testnet',wallet:wallet('supplier.testnet')};
const FUTURE=String((BigInt(Date.now())+3600000n)*1000000n),REVIEW=String((BigInt(Date.now())+7200000n)*1000000n),PAST=String((BigInt(Date.now())-3600000n)*1000000n);
const LABEL={fund:'Kendi cüzdanımdan tam tutarı yatır',record:'Sağlayıcı cüzdanımla son teslimi kaydet',release:'Son teslimin ödemesini cüzdanımda onayla',refund:'Süre doldu · kendi cüzdanıma iade iste',refresh:'Escrow durumunu yenile',execute:'Şifreli işi yürüt ve teslim et',accept:'Doğrulanan teslimi kabul et',revise:'Düzeltme iste',prove:'Sonuç kanıtını oluştur ve doğrula'};
const TASK={version:1,goal:'Fill C1 blanks with 7.',columns:[{id:'C1',type:'number'}]},STEPS=[{column:'C1',recipe:{type:'number',steps:[{op:'fill',value:7}]}}];
const bindingFor=j=>({jobId:j.id,version:j.delivery.version,contractId:j.payment.contractId,bindingHash:j.payment.bindingHash,provider:j.selectedOffer.paymentAccount,amountYocto:j.selectedOffer.amountYocto});
let encrypted;
async function cryptoFixture(){
 return encrypted??=(async()=>{const values={C1:[255]},approval=await acceptAgentProposal(TASK,{steps:STEPS});
  // CSV parser omits a blank-only line: use a second retained text column.
  const actualDataset=parseCSV('private-value,private-keep\n,secret-value\n');
  const prepared=await prepareProofPlan(values,approval.plan,{jobId:ID,buyerCommitment:await sha256('NOPE:buyer:'+BUYER.id),contractId:CONTRACT}),result=await wrapProofPlanResult(prepared.request,await executeTask(prepared.request.task));
  return {prepared,result,approval,local:{dataset:actualDataset,values,agentApproval:{...approval,datasetSha256:await sha256(JSON.stringify(actualDataset)),model:{id:'UNIT-ONLY-NOT-A-MODEL',revision:'fixture'}},payload:{jobId:ID,profile:PROOF_PROFILE,task:prepared.request,publicTask:TASK},proofDecoder:prepared.decoder,proofWitness:prepared.witness}};
 })();
}
function termsFor(j){return{job_id:j.id,buyer_commitment:j.buyerCommitment,buyer_account:j.buyerWallet.accountId,provider:j.selectedOffer.paymentAccount,amount:j.selectedOffer.amountYocto,input_hash:j.taskHash,program_hash:j.programHash,plan_hash:j.planSha256,execution_deadline_ns:j.payment.executionDeadlineNs,review_deadline_ns:j.payment.reviewDeadlineNs};}
function intentFor(j,action){
 assert.ok(['fund','record','release','refund'].includes(action));
 const args=action==='fund'?{terms:termsFor(j)}:{buyer_account:j.buyerWallet.accountId,job_id:j.id,...(['record','release'].includes(action)?{version:j.delivery.version,output_hash:j.delivery.outputSha256}:{})};
 return{id:'c'.repeat(64),action,network:'testnet',bindingHash:j.payment.bindingHash,transaction:{signerId:action==='record'?j.selectedOffer.paymentAccount:j.buyerWallet.accountId,receiverId:CONTRACT,actions:[{type:'FunctionCall',params:{methodName:{fund:'fund',record:'record_delivery',release:'accept_and_release',refund:'refund'}[action],args,gas:'150000000000000',deposit:action==='fund'?(BigInt(j.selectedOffer.amountYocto)+BigInt(POLICY.storageDepositYocto)).toString():'0'}}]}};
}
async function fixture({status='AWARDED',payment={},delivery=false,recorded=false}={}){
 const c=await cryptoFixture(),salt='d'.repeat(64),amountYocto='1000000000000000000000';
 const quote={jobId:ID,providerId:PROVIDER.id,amountYocto,deliveryHours:1,salt};
 const job={id:ID,buyerId:BUYER.id,buyerWallet:structuredClone(BUYER.wallet),buyerCommitment:await sha256('NOPE:buyer:'+BUYER.id),title:'OFFLINE customer-wallet fixture',description:'Synthetic public task',status,profile:PROOF_PROFILE,rowCount:1,publicTask:TASK,plan:c.approval.plan,planSha256:c.approval.planSha256,taskHash:c.result.inputSha256,programHash:c.result.programSha256,deadlineISO:new Date(Date.now()+3600000).toISOString(),events:[],proof:{status:'NOT_CREATED'},payment:{kind:KIND,network:'testnet',status:'NOT_FUNDED',verified:['HELD','RELEASE_READY','PAID','REFUNDED'].includes(payment.status),contractId:CONTRACT,buyerAccount:BUYER.wallet.accountId,bindingHash:'b'.repeat(64),executionDeadlineNs:FUTURE,reviewDeadlineNs:REVIEW,...payment},selectedOffer:{providerId:PROVIDER.id,paymentAccount:PROVIDER.paymentAccount,wallet:structuredClone(PROVIDER.wallet),amountYocto},delivery:delivery?{...c.result,version:1}:null,offers:[]};
 job.payment.bindingHash=await sha256(JSON.stringify([POLICY.domain,CONTRACT,...Object.values(termsFor(job))]));
 if(recorded)Object.assign(job.payment,{recordedVersion:1,recordedOutputHash:job.delivery.outputSha256});
 job.offers=[{id:'e'.repeat(32),providerId:PROVIDER.id,providerName:PROVIDER.displayName,paymentAccount:PROVIDER.paymentAccount,wallet:structuredClone(PROVIDER.wallet),envelope:{fixture:'NOT-REAL-ENVELOPE'},commitment:await quoteCommitment(ID,PROVIDER.id,amountYocto,salt)}];
 const selectedOffer=structuredClone(job.selectedOffer);if(['OPEN','CLOSED'].includes(status))job.selectedOffer=null;
 const f={job,quote,selectedOffer,...c};
 f.bundle=async()=>({version:1,scheme:SCHEME,finalContext:await finalProofContext(c.prepared.request,job.delivery,bindingFor(job)),rows:[{column:'C1',row:0,proof:{fixture:'UNIT-ONLY-NOT-A-SNARK'}}]});
 f.metadata=async()=>({status:'VERIFIED',scheme:SCHEME,version:1,bundleSha256:await hashPublicProofBundle(await f.bundle()),finalContext:(await f.bundle()).finalContext,requestSha256:job.delivery.inputSha256,manifestSha256:await hashProofManifest(c.prepared.request),programSha256:job.delivery.programSha256,planSha256:job.planSha256,deliveryVersion:job.delivery.version,outputSha256:job.delivery.outputSha256,bindingHash:job.payment.bindingHash,rowProofCount:1});
 return f;
}
class Element {
 constructor(tag){this.tagName=tag.toUpperCase();this.children=[];this.listeners={};this.dataset={};this.attributes={};this.value='';this.disabled=false;this.checked=false;this.files=[];}
 set textContent(v){this.text=String(v);this.children=[];}
 get textContent(){return(this.text||'')+this.children.map(x=>x.textContent).join(' ');}
 append(...nodes){for(const node of nodes){if(node.parentElement)node.parentElement.children=node.parentElement.children.filter(x=>x!==node);node.parentElement=this;this.children.push(node);if(this.tagName==='SELECT'&&this.children.length===1)this.value=node.value;}}
 replaceChildren(...nodes){this.children.forEach(n=>n.parentElement=null);this.children=[];this.text='';this.append(...nodes);}
 addEventListener(name,fn){(this.listeners[name]||=[]).push(fn);}
 setAttribute(k,v){this.attributes[k]=v;}
 removeAttribute(k){delete this.attributes[k];}
 reportValidity(){return true;}
 async fire(type,event={}){for(const fn of this.listeners[type]||[])await fn({preventDefault(){},button:0,...event});}
}
const descendants=node=>[node,...node.children.flatMap(descendants)];
async function settle(app){for(let i=0;i<10000&&app.state.busy;i++)await new Promise(resolve=>setTimeout(resolve,1));assert.equal(app.state.busy,false,'UI action settled');}
function browser(f,{identity=BUYER,path='/payments?id='+ID,local=true,hook,finalize=true,signer=identity.wallet,cancel=false,unknown=false,redirect=false,records=new Map(),genuineWallet=false,walletCapability=CAPABILITY,walletPolicy=POLICY}={}){
 const elements=new Map(['workspace-root','workspace-nav','workspace-identity','workspace-message','workspace-logout','workspace-heading','workspace-subtitle'].map(k=>[k,new Element('div')]));
 const calls=[],sends=[],broadcasts=[],preparedIntents=[],clientErrors=[],proofMessages=[],timers=new Map();let timerId=0;
 const sessionRecords=new Map([[TOKEN_KEY,'offline-session']]);
 const storage={getItem:key=>sessionRecords.get(key)||null,setItem:(key,value)=>sessionRecords.set(key,value),removeItem:key=>sessionRecords.delete(key)};
 const win={location:new URL('http://localhost'+path),sessionStorage:storage,addEventListener(){},navigator:{clipboard:{writeText:async()=>{}}},URL,setTimeout:fn=>{timers.set(++timerId,fn);return timerId;},clearTimeout:id=>timers.delete(id),history:{pushState:(_,__,href)=>win.location=new URL(href,win.location),replaceState:(_,__,href)=>win.location=new URL(href,win.location)}};
 const all=()=>descendants(elements.get('workspace-root'));
 const doc={getElementById:k=>elements.get(k),createElement:tag=>new Element(tag),addEventListener(){},querySelectorAll:()=>all().filter(n=>['BUTTON','INPUT','SELECT','TEXTAREA'].includes(n.tagName))};
 const cryptoCalls={sealedQuotes:0};
 const vaultFactory=namespace=>({loadJob:async key=>key===ID&&namespace!=='nope-wallet-redirect-v1'?(local?f.local:null):records.get(namespace+':'+key)||null,saveJob:async(key,v)=>records.set(namespace+':'+key,structuredClone(v)),encryptQuote:async()=>{cryptoCalls.sealedQuotes++;return{fixture:'OFFLINE-NOT-REAL-ENVELOPE'};},decryptQuote:async()=>f.quote});
 const walletFactory=async options=>{assert.deepEqual(options.policy,walletPolicy);assert.equal(options.network,'testnet');let actual;
  if(genuineWallet){
   const walletConnector={manifest:{id:'UNIT-ONLY-CONNECTOR'},getAccounts:async()=>[{accountId:signer.accountId,publicKey:signer.publicKey}],signAndSendTransaction:async request=>{
    broadcasts.push(structuredClone(request));const call=request.actions[0].params;
    assert.deepEqual(request,{...intentFor(f.job,'fund').transaction,network:'testnet',callbackUrl:'http://localhost/settings?state='+ 'c'.repeat(64)});
    return{transaction:{hash:TX,signer_id:request.signerId,receiver_id:request.receiverId,actions:[{FunctionCall:{method_name:call.methodName,args:Buffer.from(JSON.stringify(call.args)).toString('base64'),gas:call.gas,deposit:call.deposit}}]}};
   }};
   actual=createWalletClient({...options,connectorFactory:()=>({whenManifestLoaded:Promise.resolve(),availableWallets:[{manifest:{id:'UNIT-ONLY-CONNECTOR',features:{testnet:true,signMessage:true,signAndSendTransaction:true}}}],selectWallet:async()=> 'UNIT-ONLY-CONNECTOR',connect:async()=>walletConnector})});
  }
  const actualCall=async(name,...args)=>{try{return await actual[name](...args);}catch(error){clientErrors.push({stage:name,code:error.code,message:error.message});throw error;}};
  return{
  currentAccount:async()=>actual?actualCall('currentAccount'):signer,connect:async options=>actual?actualCall('connect',options):signer,completeRedirect:async()=>null,
  sendTransaction:async(intent,bounds)=>{
   const j=f.job;assert.deepEqual(intent,genuineWallet?preparedIntents.at(-1):intentFor(j,intent.action),'UI forwards exact prepared intent without adding/removing arguments');
   assert.deepEqual(bounds,{action:intent.action,jobId:ID,bindingHash:j.payment.bindingHash,accountId:identity.wallet.accountId,contractId:CONTRACT,provider:j.selectedOffer.paymentAccount,amountYocto:j.selectedOffer.amountYocto,buyerAccount:j.buyerWallet.accountId,...(intent.action==='fund'?{buyerCommitment:j.buyerCommitment,inputHash:j.taskHash,programHash:j.programHash,planHash:j.planSha256,executionDeadlineNs:j.payment.executionDeadlineNs,reviewDeadlineNs:j.payment.reviewDeadlineNs}:{}),...(['record','release'].includes(intent.action)?{version:j.delivery.version,outputHash:j.delivery.outputSha256}:{})});
   sends.push(structuredClone({intent,bounds}));
   if(cancel||unknown)throw Object.assign(Error('Explicit unit adapter outcome'),{code:cancel?'WALLET_REJECTED':'WALLET_TRANSACTION_UNKNOWN'});
   if(actual){try{return await actual.sendTransaction(intent,bounds);}catch(error){clientErrors.push({code:error.code,message:error.message});throw error;}}
   return redirect?{redirected:true}:{transactionHash:TX};
  }
 };};
 const proofWorkerFactory=()=>({terminate(){this.terminated=true;},postMessage(value){assert.ok(['prove','verify'].includes(value.type));assert.deepEqual(value.request,f.prepared.request);proofMessages.push(structuredClone(value));queueMicrotask(async()=>this.onmessage({data:value.type==='prove'?{type:'proof',bundle:await f.bundle()}:{type:'verified',valid:true}}));}});
 const app=createWorkspace({document:doc,window:win,storage,walletPolicy,walletFactory,proofWorkerFactory,vaultFactory,fetch:async(url,options)=>{
  const route='/'+new URL(url,'http://localhost').searchParams.get('route'),body=options.body===undefined?undefined:JSON.parse(options.body),call={route,method:options.method,body};calls.push(call);const j=f.job;let data;
  if(route==='/session')data={session:identity,proof:{profile:PROOF_PROFILE,enabled:true,contractId:CONTRACT},wallet:walletCapability};
  else if(route==='/wallet')data={wallet:identity.wallet};
  else if(route==='/jobs')data={jobs:[j]};
  else if(route.endsWith('/proof/evidence'))data={version:1,network:'testnet',jobId:ID,walletBuyerAccount:j.buyerWallet.accountId,task:f.prepared.request,delivery:j.delivery,binding:bindingFor(j),proof:j.proof,bundle:await f.bundle()};
  else if(route.endsWith('/task'))data={task:f.prepared.request};
  else if(options.method==='GET'){assert.equal(route,'/jobs/'+ID);data={job:j};}
  else{
   const action=route.slice(('/jobs/'+ID+'/').length);
   if(action==='award'){assert.deepEqual(body,{offerId:j.offers[0].id,amountYocto:f.quote.amountYocto,salt:f.quote.salt});j.selectedOffer=structuredClone(f.selectedOffer);j.status='AWARDED';}
   else if(action==='offers'){assert.deepEqual(Object.keys(body).sort(),['commitment','envelope']);j.ownOffer={id:'f'.repeat(32),providerId:identity.id};}
   else if(action==='execute'){assert.equal(j.payment.status,'HELD');assert.equal(j.payment.verified,true);j.status='DELIVERED';j.delivery={...f.result,version:(j.delivery?.version||0)+1};j.proof={status:'NOT_CREATED'};}
   else if(action==='proof'){assert.deepEqual(Object.keys(body).sort(),['bundle','outputSha256','version']);assert.deepEqual(body.bundle,await f.bundle());assert.equal(body.version,j.delivery.version);assert.equal(body.outputSha256,j.delivery.outputSha256);j.proof=await f.metadata();}
   else if(action==='decision'){assert.deepEqual(Object.keys(body).sort(),['decision','outputSha256','version']);assert.equal(body.version,j.delivery.version);assert.equal(body.outputSha256,j.delivery.outputSha256);assert.equal(escrowRecordedDelivery(j),true);j.status=body.decision==='accept'?'ACCEPTED':'REVISION';if(body.decision==='accept')j.payment.status='RELEASE_READY';}
   else if(action==='payment/prepare'){assert.deepEqual(Object.keys(body),['action']);assert.equal(walletActionAllowed(j,body.action,identity),true);data={job:j,intent:intentFor(j,body.action)};}
   else if(action==='payment/confirm'){
    assert.deepEqual(body,{action:sends.at(-1).intent.action,transactionHash:TX});assert.equal(body.action,sends.at(-1).bounds.action);
    j.payment.status={fund:'FUNDING_PENDING',record:'RECORD_PENDING',release:'PAYOUT_PENDING',refund:'REFUND_PENDING'}[body.action];j.payment.verified=false;j.payment[body.action+'TransactionHash']=TX;
   }else if(action==='payment/refresh'){
    assert.deepEqual(body,{});
    if(finalize){
     if(j.payment.status==='FUNDING_PENDING'){j.payment.status='HELD';j.payment.verified=true;}
     else if(j.payment.status==='RECORD_PENDING'){j.payment.status='HELD';j.payment.verified=true;j.payment.recordedVersion=j.delivery.version;j.payment.recordedOutputHash=j.delivery.outputSha256;}
     else if(j.payment.status==='PAYOUT_PENDING'){j.status='PAID';j.payment.status='PAID';j.payment.verified=true;}
     else if(j.payment.status==='REFUND_PENDING'){j.status='REFUNDED';j.payment.status='REFUNDED';j.payment.verified=true;j.payment.refundAccount=j.buyerWallet.accountId;}
    }
   }else assert.fail('Unexpected legacy or unowned mutation '+route);
   data??={job:j};
  }
  const replacement=await hook?.(call,f,data);if(replacement)return replacement;
  if(route.endsWith('/payment/prepare'))preparedIntents.push(structuredClone(data.intent));
  return{ok:true,status:200,json:async()=>structuredClone(data)};
 }});
 return{app,calls,sends,broadcasts,preparedIntents,clientErrors,proofMessages,all,timers,win,records,cryptoCalls,get:name=>all().find(e=>e.name===name),text:()=>elements.get('workspace-root').textContent,message:()=>elements.get('workspace-message').textContent,
  has:label=>all().some(e=>e.tagName==='BUTTON'&&e.textContent===label),enabled:label=>all().some(e=>e.tagName==='BUTTON'&&e.textContent===label&&!e.disabled),
  click:async label=>{const b=all().find(e=>e.tagName==='BUTTON'&&e.textContent===label);assert.ok(b,label);await b.fire('click');await settle(app);},
  poll:async()=>{const entry=timers.entries().next().value;assert.ok(entry,'pending finality schedules read-only refresh');timers.delete(entry[0]);entry[1]();await settle(app);},
  submit:async()=>{await all().find(e=>e.tagName==='FORM').fire('submit');await settle(app);}
 };
}
const writes=h=>h.calls.filter(c=>c.method==='POST');
const signs=h=>h.sends.map(x=>x.intent.action);

test('OFFLINE funding screen discloses nonrefundable storage and the separate total before signing',async()=>{
 const f=await fixture({status:'AWARDED'});
 const h=browser(f,{walletPolicy:{...POLICY,storageDepositYocto:'40960000000000000000000'}});await h.app.start();
 const total=(BigInt(f.job.selectedOffer.amountYocto)+40960000000000000000000n).toString();
 const {formatNearAmount}=await import('../web/workspace-vault.mjs');
 assert.ok(h.text().includes('0.04096 testNEAR (iade edilmez)'));
 assert.ok(h.text().includes(formatNearAmount(total)+' testNEAR + ağ işlem ücreti'));
 assert.equal(h.sends.length,0);assert.equal(h.broadcasts.length,0);
});

test('OFFLINE wallet flow separates award, funding, execution, recording, v4 acceptance and release; only final chain fixture is PAID',async()=>{
 const f=await fixture({status:'CLOSED'}),buyer=browser(f,{path:'/job?id='+ID});await buyer.app.start();
 const consent=buyer.all().find(e=>e.type==='checkbox');assert.ok(consent.parentElement.textContent.includes('zincirde herkese açık'));consent.checked=true;
 await buyer.click('Bu sağlayıcıyı seç');assert.equal(f.job.status,'AWARDED');assert.equal(f.job.payment.status,'NOT_FUNDED');assert.deepEqual(signs(buyer),[]);assert.equal(writes(buyer).length,1,'award never funds automatically');
 await buyer.click(LABEL.fund);assert.equal(f.job.payment.status,'FUNDING_PENDING');assert.deepEqual(signs(buyer),['fund']);assert.deepEqual(writes(buyer).slice(1).map(c=>[c.route.split('/').at(-1),c.body]),[['prepare',{action:'fund'}],['confirm',{action:'fund',transactionHash:TX}]]);
 await buyer.poll();assert.equal(f.job.payment.status,'HELD');
 const provider=browser(f,{identity:PROVIDER,path:'/delivery?id='+ID});await provider.app.start();await provider.click(LABEL.execute);assert.equal(f.job.status,'DELIVERED');assert.deepEqual(signs(provider),[],'execution never records automatically');assert.equal(writes(provider).length,1);
 const awaiting=browser(f,{path:'/delivery?id='+ID});await awaiting.app.start();assert.ok(awaiting.text().includes('Yerel kontrol başarılı'));assert.equal(awaiting.enabled(LABEL.accept),false);assert.equal(awaiting.has(LABEL.record),false,'only selected provider signs delivery recording');
 await provider.click(LABEL.record);assert.equal(f.job.payment.status,'RECORD_PENDING');assert.deepEqual(signs(provider),['record']);await provider.poll();assert.equal(f.job.payment.recordedVersion,1);assert.equal(f.job.payment.recordedOutputHash,f.job.delivery.outputSha256);
 const verified=browser(f,{path:'/delivery?id='+ID});await verified.app.start();assert.equal(verified.enabled(LABEL.accept),false);await verified.click(LABEL.prove);assert.deepEqual(verified.proofMessages.map(x=>x.type),['prove','verify']);assert.equal(verified.enabled(LABEL.accept),true);await verified.click(LABEL.accept);
 assert.equal(f.job.status,'ACCEPTED');assert.equal(f.job.payment.status,'RELEASE_READY');assert.deepEqual(signs(verified),[],'acceptance never releases automatically');assert.deepEqual(writes(verified).find(c=>c.route.endsWith('/decision')).body,{decision:'accept',version:1,outputSha256:f.job.delivery.outputSha256});
 await verified.click(LABEL.release);assert.equal(f.job.status,'ACCEPTED');assert.equal(f.job.payment.status,'PAYOUT_PENDING');assert.ok(!verified.text().includes('Durum: Zincirde ödeme doğrulandı'));assert.deepEqual(signs(verified),['release']);await verified.poll();assert.equal(f.job.status,'PAID');assert.ok(verified.text().includes('Durum: Zincirde ödeme doğrulandı'));
 assert.equal(verified.has(LABEL.release),false);assert.equal(verified.has('Sponsor havuzundan fon ayır'),false);
 const links=verified.all().filter(e=>e.tagName==='A'&&e.href?.includes('nearblocks.io'));assert.equal(links.length,3);assert.ok(links.every(e=>e.href==='https://testnet.nearblocks.io/txns/'+TX&&e.rel==='noopener noreferrer'));
});

test('OFFLINE unheld, unverified, expired or unknown funds cannot execute, even through a retained disabled button',async()=>{
 for(const payment of [...['NOT_FUNDED','FUNDING_PENDING','UNKNOWN','ERROR','REFUND_PENDING','REFUNDED'].map(status=>({status})),{status:'HELD',verified:false},{status:'HELD',executionDeadlineNs:PAST}]){
  const h=browser(await fixture({payment}),{identity:PROVIDER,path:'/delivery?id='+ID,finalize:false});await h.app.start();assert.equal(h.enabled(LABEL.execute),false,JSON.stringify(payment));await h.click(LABEL.execute);assert.equal(writes(h).length,0);assert.equal(h.sends.length,0);
 }
});

test('OFFLINE latest chain record/version/hash gates both decisions; full local v4 proof additionally gates acceptance',async()=>{
 for(const fields of [{},{recordedVersion:0},{recordedOutputHash:'f'.repeat(64)},{status:'RECORD_PENDING',verified:false},{status:'RELEASE_READY'},{verified:false}]){
  const f=await fixture({status:'DELIVERED',payment:{status:'HELD'},delivery:true,recorded:true});
  if(!Object.keys(fields).length){delete f.job.payment.recordedVersion;delete f.job.payment.recordedOutputHash;}else Object.assign(f.job.payment,fields);
  const h=browser(f,{path:'/delivery?id='+ID});await h.app.start();assert.equal(h.enabled(LABEL.accept),false);assert.equal(h.enabled(LABEL.revise),false);await h.click(LABEL.accept);await h.click(LABEL.revise);assert.equal(writes(h).filter(c=>c.route.endsWith('/decision')).length,0);
 }
 const f=await fixture({status:'DELIVERED',payment:{status:'HELD'},delivery:true,recorded:true}),h=browser(f,{path:'/delivery?id='+ID});await h.app.start();assert.equal(h.enabled(LABEL.revise),true);assert.equal(h.enabled(LABEL.accept),false);await h.click(LABEL.prove);assert.equal(h.enabled(LABEL.accept),true);
});

test('OFFLINE revision requires a fresh delivery record and fresh proof, never another deposit',async()=>{
 const f=await fixture({status:'DELIVERED',payment:{status:'HELD'},delivery:true,recorded:true}),buyer=browser(f,{path:'/delivery?id='+ID});await buyer.app.start();await buyer.click(LABEL.revise);assert.equal(f.job.status,'REVISION');
 const provider=browser(f,{identity:PROVIDER,path:'/delivery?id='+ID});await provider.app.start();await provider.click('Düzeltmeyi yeniden yürüt');assert.equal(f.job.delivery.version,2);assert.equal(f.job.payment.status,'HELD');assert.equal(f.job.payment.recordedVersion,1);assert.deepEqual(signs(provider),[]);
 const before=browser(f,{path:'/delivery?id='+ID});await before.app.start();assert.equal(before.enabled(LABEL.accept),false);assert.equal(before.enabled(LABEL.revise),false);
 await provider.click(LABEL.record);await provider.poll();const after=browser(f,{path:'/delivery?id='+ID});await after.app.start();assert.equal(after.enabled(LABEL.accept),false,'v1 proof does not authorize v2');await after.click(LABEL.prove);assert.equal(after.enabled(LABEL.accept),true);assert.equal(f.job.payment.recordedVersion,2);assert.deepEqual(signs(provider),['record']);
});

test('OFFLINE expired hold refunds explicitly to the immutable customer wallet, never sponsor/provider; finality still required',async()=>{
 for(const accepted of [false,true]){
  const f=await fixture({status:accepted?'ACCEPTED':'AWARDED',payment:{status:accepted?'RELEASE_READY':'HELD',reviewDeadlineNs:PAST,executionDeadlineNs:PAST},delivery:accepted,recorded:accepted}),h=browser(f);await h.app.start();assert.equal(writes(h).length,0);assert.equal(h.has(LABEL.release),false);assert.equal(h.enabled(LABEL.refund),true);
  await h.click(LABEL.refund);assert.equal(f.job.payment.status,'REFUND_PENDING');assert.notEqual(f.job.status,'REFUNDED');assert.equal(h.sends[0].intent.transaction.signerId,BUYER.wallet.accountId);assert.deepEqual(h.sends[0].intent.transaction.actions[0].params.args,{buyer_account:BUYER.wallet.accountId,job_id:ID});assert.equal(h.sends[0].intent.transaction.actions[0].params.deposit,'0');
  await h.poll();assert.equal(f.job.status,'REFUNDED');assert.equal(f.job.payment.refundAccount,BUYER.wallet.accountId);assert.equal(h.has(LABEL.refund),false);
 }
 for(const status of ['PAYOUT_PENDING','UNKNOWN','ERROR','PAID','REFUND_PENDING']){const h=browser(await fixture({payment:{status,reviewDeadlineNs:PAST}}));await h.app.start();assert.equal(h.has(LABEL.refund),false,status);}
 const h=browser(await fixture({payment:{status:'HELD'}}));await h.app.start();assert.equal(h.has(LABEL.refund),false);
});

test('OFFLINE signed wallet cancellation does not confirm, pay or silently retry; a new signature needs explicit user action',async()=>{
 const f=await fixture(),h=browser(f,{cancel:true});await h.app.start();await h.click(LABEL.fund);assert.deepEqual(signs(h),['fund']);assert.equal(f.job.payment.status,'NOT_FUNDED');assert.equal(h.calls.some(c=>c.route.endsWith('/confirm')),false);assert.equal(h.app.state.walletPending,null);assert.match(h.message(),/iptal edildi/);assert.equal(h.timers.size,0);assert.equal(h.enabled(LABEL.fund),true);
});

test('OFFLINE unknown wallet broadcast blocks all new actions across refresh and reload, without inferred safe resume',async()=>{
 const f=await fixture(),records=new Map(),h=browser(f,{unknown:true,records});await h.app.start();const original=h.all().find(e=>e.textContent===LABEL.fund);await h.click(LABEL.fund);assert.equal(h.app.state.walletPending.kind,'transaction');assert.equal(h.app.state.walletPending.transactionHash,undefined);assert.equal(h.has(LABEL.fund),false);await original.fire('click');await settle(h.app);assert.equal(h.sends.length,1);assert.equal(h.calls.some(c=>c.route.endsWith('/confirm')),false);
 await h.click(LABEL.refresh);assert.equal(h.has(LABEL.fund),false);assert.equal(h.sends.length,1);const reload=browser(f,{records});await reload.app.start();assert.equal(reload.has(LABEL.fund),false);assert.equal(reload.sends.length,0);assert.equal(writes(reload).length,0);
});

test('OFFLINE lost confirm response only reconfirms the same hash or refreshes; never prepares/broadcasts again',async()=>{
 const f=await fixture();let lost=true;const h=browser(f,{hook:call=>{if(call.route.endsWith('/confirm')&&lost){lost=false;throw Error('UNIT lost committed confirm response');}}});await h.app.start();await h.click(LABEL.fund);assert.equal(f.job.payment.status,'FUNDING_PENDING');assert.equal(h.has(LABEL.fund),false);assert.equal(h.app.state.walletPending.transactionHash,TX);
 await h.click('Mevcut işlem kaydını doğrula');assert.equal(h.sends.length,1);assert.equal(h.calls.filter(c=>c.route.endsWith('/prepare')).length,1);assert.deepEqual(h.calls.filter(c=>c.route.endsWith('/confirm')).map(c=>c.body),[{action:'fund',transactionHash:TX},{action:'fund',transactionHash:TX}]);await h.poll();assert.equal(f.job.payment.status,'HELD');
});

test('OFFLINE redirected signature remains pending without confirm or resend and survives a page load',async()=>{
 const f=await fixture(),records=new Map(),h=browser(f,{redirect:true,records});await h.app.start();await h.click(LABEL.fund);assert.equal(h.has(LABEL.fund),false);assert.equal(h.calls.some(c=>c.route.endsWith('/confirm')),false);assert.equal(f.job.payment.status,'NOT_FUNDED');const reload=browser(f,{records});await reload.app.start();assert.equal(reload.has(LABEL.fund),false);assert.equal(reload.sends.length,0);assert.equal(writes(reload).length,0);
});

test('OFFLINE wrong session/active wallet or missing signed capability never prepares or sends',async()=>{
 for(const options of [{identity:{...BUYER,wallet:wallet('wrong-buyer.testnet')}},{identity:{...BUYER,wallet:null}},{signer:wallet('wrong-signer.testnet')},{signer:{...BUYER.wallet,network:'mainnet'}},{walletCapability:null},{walletPolicy:null},{walletCapability:{...CAPABILITY,contractId:'wrong-contract.testnet'}}]){
  const f=await fixture(),h=browser(f,options);await h.app.start();if(h.has(LABEL.fund))await h.click(LABEL.fund);assert.equal(h.sends.length,0);assert.equal(writes(h).length,0,JSON.stringify(options));
 }
});

test('OFFLINE same buyer wallet owns immutable jobs across session IDs; session ID alone never grants wallet ownership',async()=>{
 const f=await fixture(),returning=browser(f,{identity:{...BUYER,id:'new-session-id'}});await returning.app.start();assert.equal(returning.enabled(LABEL.fund),true);await returning.click(LABEL.fund);assert.equal(returning.sends[0].intent.transaction.signerId,f.job.buyerWallet.accountId);
 const wrong=browser(await fixture(),{identity:{...BUYER,wallet:wallet('different.testnet')}});await wrong.app.start();assert.equal(wrong.has(LABEL.fund),false);assert.equal(writes(wrong).length,0);
});

test('OFFLINE stale prepared job, amount, buyer, binding or delivery never reaches the wallet signer',async()=>{
 for(const change of [j=>j.payment.bindingHash='f'.repeat(64),j=>j.selectedOffer.amountYocto='9',j=>j.selectedOffer.paymentAccount='other-supplier.testnet',j=>j.buyerWallet.accountId='other-buyer.testnet',j=>j.delivery.version++,j=>j.delivery.outputSha256='f'.repeat(64)]){
  const f=await fixture({status:'ACCEPTED',payment:{status:'RELEASE_READY'},delivery:true,recorded:true}),h=browser(f,{hook:(call,_f,data)=>{if(call.route.endsWith('/prepare'))change(data.job);}});await h.app.start();await h.click(LABEL.release);assert.equal(h.sends.length,0);assert.equal(h.calls.some(c=>c.route.endsWith('/confirm')),false);
 }
});

test('OFFLINE pending polling refreshes only, is bounded, stops on navigation and never retries a signature',async()=>{
 const f=await fixture({status:'ACCEPTED',payment:{status:'PAYOUT_PENDING',releaseTransactionHash:TX}}),h=browser(f,{finalize:false});await h.app.start();for(let i=0;i<12;i++)await h.poll();assert.equal(h.timers.size,0);assert.ok(h.text().includes('Otomatik kontrol durdu'));assert.ok(writes(h).every(c=>c.route.endsWith('/payment/refresh')));assert.equal(h.sends.length,0);
 const other=browser(await fixture({payment:{status:'FUNDING_PENDING'}}),{finalize:false});await other.app.start();assert.equal(other.timers.size,1);await other.app.navigate('/customer');assert.equal(other.timers.size,0);
});

test('OFFLINE invalid chain/explorer metadata and contradictory terminal states cannot display finalized payment or enable signatures',async()=>{
 for(const payment of [{network:'mainnet',releaseTransactionHash:TX},{contractId:'escrow.near',releaseTransactionHash:TX},{status:'FUTURE_UNKNOWN',releaseTransactionHash:TX}]){
  const f=await fixture({payment}),h=browser(f);await h.app.start();assert.equal(h.all().filter(e=>e.href?.includes('nearblocks.io')).length,0);assert.equal(h.has(LABEL.fund),false);
 }
 const badHash=browser(await fixture({payment:{releaseTransactionHash:'https://evil.invalid/'}}));await badHash.app.start();assert.equal(badHash.all().filter(e=>e.href?.includes('evil.invalid')).length,0);
 for(const status of ['PAID','REFUNDED']){const h=browser(await fixture({status:'ACCEPTED',payment:{status}}));await h.app.start();assert.ok(h.text().includes('Bilinmeyen veya eksik testnet ödeme bilgisi'));assert.ok(!h.text().includes('Durum: Zincirde ödeme doğrulandı'));assert.equal(h.has(LABEL.release),false);}
});

test('OFFLINE all legacy sponsor/direct routes are readonly, including offers, award, execute, decisions and receipts',async()=>{
 for(const kind of ['SPONSORED_TESTNET_ESCROW','DIRECT_TESTNET_TRANSFER'])for(const [path,status,identity] of [['/payments','ACCEPTED',BUYER],['/offer','OPEN',PROVIDER],['/job','CLOSED',BUYER],['/delivery','AWARDED',PROVIDER],['/delivery','DELIVERED',BUYER]]){
  const f=await fixture({status,payment:{kind,status:'HELD'},delivery:status==='DELIVERED',recorded:status==='DELIVERED'}),h=browser(f,{path:path+'?id='+ID,identity});await h.app.start();
  for(const label of [...Object.values(LABEL),'Bu sağlayıcıyı seç','Sponsor havuzundan fon ayır','Testnet ödemesini doğrula'])assert.equal(h.enabled(label),false,kind+' '+path+' '+label);
  assert.equal(h.get('buyerAccount'),undefined);assert.equal(h.get('transactionHash'),undefined);assert.equal(h.get('amount'),undefined);assert.equal(writes(h).length,0);assert.equal(h.sends.length,0);assert.equal(h.timers.size,0);
 }
});

test('OFFLINE stale legacy resume hints never authorize a new signature, including unknown/sent/expired operations',async()=>{
 for(const action of ['fund','record','release','refund'])for(const status of ['UNKNOWN','ERROR','FUNDING_PENDING','RECORD_PENDING','PAYOUT_PENDING','REFUND_PENDING']){
  const f=await fixture({status:action==='fund'?'AWARDED':action==='record'?'DELIVERED':'ACCEPTED',payment:{status,verified:false,operation:{action,status:'PENDING',operationId:'e'.repeat(64),resumeAction:action}},delivery:true,recorded:true}),h=browser(f,{finalize:false});await h.app.start();assert.equal(h.all().some(e=>e.tagName==='BUTTON'&&e.textContent.startsWith('Mevcut imzalı işlemi sürdür')),false);assert.equal(h.has(LABEL[action]),false);assert.equal(writes(h).length,0);assert.equal(h.sends.length,0);
 }
});

test('OFFLINE offer bound is 1 testNEAR; former sponsor 0.01 cap never applies and legacy offers stay readonly',async()=>{
 const f=await fixture({status:'OPEN'}),h=browser(f,{identity:PROVIDER,path:'/offer?id='+ID});await h.app.start();assert.ok(h.text().includes('1 testNEAR'));h.get('amount').value='1.000000000000000000000001';await h.submit();assert.equal(h.cryptoCalls.sealedQuotes,0);assert.equal(writes(h).length,0);assert.match(h.message(),/en fazla 1 testNEAR/);
 h.get('amount').value='0.02';await h.submit();assert.equal(h.cryptoCalls.sealedQuotes,1);assert.equal(h.calls.filter(c=>c.route.endsWith('/offers')).length,1);
 const max=browser(await fixture({status:'OPEN'}),{identity:PROVIDER,path:'/offer?id='+ID});await max.app.start();max.get('amount').value='1';await max.submit();assert.equal(max.calls.filter(c=>c.route.endsWith('/offers')).length,1);
});

test('OFFLINE finalized PAID in confirm or subsequent GET replaces pending state without another transaction',async()=>{
 for(const timing of ['confirm-response','render-GET']){
  const f=await fixture({status:'ACCEPTED',payment:{status:'RELEASE_READY'},delivery:true,recorded:true});let confirmed=false;const h=browser(f,{hook:call=>{if(call.route.endsWith('/confirm'))confirmed=true;if(confirmed&&(timing==='confirm-response'||call.method==='GET')){f.job.status='PAID';f.job.payment.status='PAID';f.job.payment.verified=true;}}});await h.app.start();await h.click(LABEL.release);assert.equal(f.job.status,'PAID');assert.ok(h.text().includes('Durum: Zincirde ödeme doğrulandı'));assert.deepEqual(signs(h),['release']);assert.equal(h.calls.filter(c=>c.route.endsWith('/confirm')).length,1);assert.equal(h.timers.size,0);
 }
});

test('OFFLINE immutable wallet snapshots must match the linked testnet buyer and selected provider',async()=>{
 for(const change of [j=>j.selectedOffer.wallet.accountId='other-provider.testnet',j=>j.selectedOffer.wallet.network='mainnet',j=>delete j.selectedOffer.wallet]){
  const f=await fixture({status:'DELIVERED',payment:{status:'HELD'},delivery:true});change(f.job);assert.equal(walletActionAllowed(f.job,'record',PROVIDER),false);const h=browser(f,{identity:PROVIDER,path:'/delivery?id='+ID});await h.app.start();assert.equal(h.has(LABEL.record),false);assert.equal(writes(h).length,0);assert.equal(h.sends.length,0);
 }
 const f=await fixture();f.job.buyerWallet.network='mainnet';assert.equal(walletActionAllowed(f.job,'fund',BUYER),false);const h=browser(f);await h.app.start();assert.equal(h.has(LABEL.fund),false);
});

test('OFFLINE actual wallet-client validates fund intent, immutable bounds and exact encoded args before the fixture connector broadcasts',async()=>{
 const f=await fixture(),h=browser(f,{genuineWallet:true});await h.app.start();await h.click(LABEL.fund);assert.equal(h.broadcasts.length,1,h.message()+JSON.stringify({calls:h.calls,errors:h.clientErrors,sends:h.sends}));assert.equal(f.job.payment.status,'FUNDING_PENDING');assert.equal(h.sends.length,1);const {intent,bounds}=h.sends[0];
 assert.equal(bounds.inputHash,f.result.inputSha256);assert.equal(bounds.programHash,f.result.programSha256);assert.ok(Object.values(bounds).every(value=>value!==undefined),'no omitted server-view hash becomes an undefined wallet bound');
 assert.deepEqual(Object.keys(intent.transaction.actions[0].params).sort(),['args','deposit','gas','methodName']);assert.deepEqual(Object.keys(intent.transaction.actions[0].params.args),['terms']);assert.deepEqual(Object.keys(intent.transaction.actions[0].params.args.terms),['job_id','buyer_commitment','buyer_account','provider','amount','input_hash','program_hash','plan_hash','execution_deadline_ns','review_deadline_ns']);assert.ok(Object.values(intent.transaction.actions[0].params.args.terms).every(value=>typeof value==='string'));assert.deepEqual(h.calls.find(c=>c.route.endsWith('/confirm')).body,{action:'fund',transactionHash:TX});
});

test('OFFLINE missing public task/program commitments never reach a real wallet-client connector or confirmation',async()=>{
 for(const field of ['taskHash','programHash']){
  const f=await fixture();delete f.job[field];const h=browser(f,{genuineWallet:true});await h.app.start();await h.click(LABEL.fund);assert.equal(h.broadcasts.length,0,field);assert.equal(h.calls.some(c=>c.route.endsWith('/confirm')),false,field);assert.equal(f.job.payment.status,'NOT_FUNDED');
 }
});

test('OFFLINE a self-consistent server fund intent cannot replace the actual local encrypted task commitments',async()=>{
 for(const field of ['taskHash','programHash']){
  const f=await fixture();f.job[field]='f'.repeat(64);f.job.payment.bindingHash=await sha256(JSON.stringify([POLICY.domain,CONTRACT,...Object.values(termsFor(f.job))]));const h=browser(f,{genuineWallet:true});await h.app.start();await h.click(LABEL.fund);assert.equal(h.broadcasts.length,0,field+': server intent/bounds agree but local prepared task differs');assert.equal(h.calls.some(c=>c.route.endsWith('/confirm')),false,field);assert.equal(f.job.payment.status,'NOT_FUNDED');
 }
});

test('OFFLINE actual wallet-client rejects altered method/schema, undefined args, deposit and hashes before the synthetic connector is invoked',async()=>{
 for(const mutate of [i=>i.transaction.actions[0].params.args.terms.input_hash=undefined,i=>i.transaction.actions[0].params.args.terms.program_hash='f'.repeat(64),i=>i.transaction.actions[0].params.args.extra='not-allowed',i=>i.transaction.actions[0].params.deposit='0',i=>i.transaction.actions[0].params.methodName='refund',i=>i.transaction.receiverId='other-contract.testnet',i=>i.transaction.signerId='wrong-buyer.testnet']){
  const f=await fixture(),h=browser(f,{genuineWallet:true,hook:(call,_f,data)=>{if(call.route.endsWith('/prepare'))mutate(data.intent);}});await h.app.start();await h.click(LABEL.fund);assert.equal(h.sends.length,1,'malformed prepared intent reaches actual validator');assert.equal(h.broadcasts.length,0);assert.equal(h.calls.some(c=>c.route.endsWith('/confirm')),false);assert.equal(f.job.payment.status,'NOT_FUNDED');assert.equal(h.clientErrors.at(-1).code,'WALLET_INVALID_INTENT');
 }
});

test('OFFLINE missing local task needs explicit funding acknowledgement; refund needs no local data',async()=>{
 const f=await fixture(),h=browser(f,{genuineWallet:true,local:false});await h.app.start();assert.equal(h.enabled(LABEL.fund),false);await h.click(LABEL.fund);assert.equal(h.sends.length,0);assert.equal(h.calls.some(c=>c.route.endsWith('/prepare')),false);
 const consent=h.get('confirmMissingLocalFunding');assert.ok(consent);assert.equal(consent.checked,false);consent.checked=true;await consent.fire('change');await h.click(LABEL.fund);assert.equal(h.broadcasts.length,1,h.message());assert.equal(f.job.payment.status,'FUNDING_PENDING');
 const expired=await fixture({payment:{status:'HELD',executionDeadlineNs:PAST,reviewDeadlineNs:PAST}}),refund=browser(expired,{local:false});await refund.app.start();assert.equal(refund.get('confirmMissingLocalFunding'),undefined);assert.equal(refund.enabled(LABEL.refund),true);await refund.click(LABEL.refund);assert.equal(expired.job.payment.status,'REFUND_PENDING');assert.deepEqual(signs(refund),['refund']);
});
