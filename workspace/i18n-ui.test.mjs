import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {createWorkspace,PROOF_PROFILE} from '../web/workspace.js';
import {initI18n,setLanguage,getLanguage,STORAGE_KEY} from '../web/i18n.mjs';

// Explicit UI/transport/storage fixtures. This tests real workspace+i18n code,
// not translation quality, model accuracy, proof verification or chain finality.
const source=JSON.parse(await readFile(new URL('../web/locales/workspace-tr.json',import.meta.url),'utf8'));
const en={
 'Yeni şifreli iş':'New encrypted job','Şifreli teklif ver':'Submit an encrypted offer',
 'Müşteri':'Customer','Sağlayıcı':'Provider','Sayı':'Number','Metin':'Text','boş → {0}':'empty → {0}','aralık {0}–{1}':'range {0}–{1}',
 'Herkese açık tarif: {0}':'Public recipe: {0}','Herkese açık ajan hedefi: {0}':'Public agent goal: {0}',
 'Teklif sonu: {0}':'Offers close: {0}','Tekliflere açık':'Open for offers',
 'CSV yalnızca bu cihazda okundu. Önizlemeyi kontrol edin.':'The CSV was read only on this device. Check the preview.',
 'Geçerli bir testNEAR tutarı girin (en fazla 24 ondalık).':'Enter a valid testNEAR amount (up to 24 decimal places).',
 '{0} — desteklenmeyen sütun / tarif':'{0} — unsupported column / recipe',
 'ornek.testnet':'example.testnet','İşlem sürüyor…':'Working…','Şifrele ve işi yayımla':'Encrypt and publish',
};
const fr={
 ...en,'Müşteri':'Client','Sağlayıcı':'Prestataire','Yeni şifreli iş':'Nouvelle tâche chiffrée','Sayı':'Nombre','Metin':'Texte',
 'boş → {0}':'vide → {0}','aralık {0}–{1}':'intervalle {0}–{1}',
 'Herkese açık tarif: {0}':'Recette publique : {0}',
 'Geçerli bir testNEAR tutarı girin (en fazla 24 ondalık).':'Saisissez un montant testNEAR valide.',
};
assert.equal(getLanguage(),'tr','Node imports keep the established Turkish fixture default');
await initI18n({document:{},window:{},storage:{getItem:key=>key===STORAGE_KEY?'en':null},fetch:async url=>({ok:true,json:async()=>{
 const code=new URL(url).pathname.split('/').at(-1).slice(0,-5);return code==='tr'?source:code==='fr'?fr:en;
}})});
class Element {
 constructor(tag){this.tagName=tag.toUpperCase();this.children=[];this.listeners={};this.dataset={};this.attributes={};this.value='';this.disabled=false;this.files=[];}
 set textContent(value){this.text=String(value);this.children=[];}
 get textContent(){return(this.text||'')+this.children.map(child=>child.textContent).join(' ');}
 append(...nodes){for(const node of nodes){if(node.parentElement)node.parentElement.children=node.parentElement.children.filter(child=>child!==node);node.parentElement=this;this.children.push(node);if(this.tagName==='SELECT'&&this.children.length===1)this.value=node.value;}}
 replaceChildren(...nodes){this.children.forEach(n=>n.parentElement=null);this.children=[];this.text='';this.append(...nodes);}
 addEventListener(name,fn){(this.listeners[name]||=[]).push(fn);}
 setAttribute(name,value){this.attributes[name]=String(value);}
 removeAttribute(name){delete this.attributes[name];}
 reportValidity(){return true;}
 async fire(type){for(const fn of this.listeners[type]||[])await fn({preventDefault(){}});}
}
const descendants=node=>[node,...node.children.flatMap(descendants)];
const ID='a'.repeat(32),CONTRACT='i18n-escrow.testnet';
const wallet=accountId=>({accountId,publicKey:'ed25519:'+ '1'.repeat(32),network:'testnet',verifiedAt:'2026-11-14T00:00:00Z'});
const POLICY={network:'testnet',contractId:CONTRACT,codeHash:'2'.repeat(44),domain:'NOPE:WALLET-ESCROW:V1:testnet',requireKeyless:true};
const WALLET_CAPABILITY={required:true,enabled:true,network:'testnet',contractId:CONTRACT};
const BUYER={id:'i18n-unit-buyer',role:'buyer',displayName:'Metin',wallet:wallet('i18n-buyer.testnet')},PROVIDER={id:'i18n-unit-provider',role:'provider',displayName:'Sayı',paymentAccount:'i18n-fixture.testnet',wallet:wallet('i18n-fixture.testnet')};
const JOB={id:ID,buyerId:BUYER.id,buyerWallet:structuredClone(BUYER.wallet),payment:{kind:'WALLET_TESTNET_ESCROW',network:'testnet',status:'NOT_FUNDED',contractId:CONTRACT},title:'Sayı',description:'Metin',status:'OPEN',profile:PROOF_PROFILE,rowCount:2,deadlineISO:'2099-12-01T18:30:00Z',offers:[],publicTask:{version:1,goal:'Metin',columns:[{id:'C1',type:'number'}]}};
function browser({path='/jobs/new',identity=BUYER}={}){
 const elements=new Map(['workspace-root','workspace-nav','workspace-identity','workspace-message','workspace-logout','workspace-heading','workspace-subtitle'].map(key=>[key,new Element('div')]));
 const records=new Map(),calls=[],quotes=[],storage={getItem:()=> 'i18n-fixture-token',setItem(){},removeItem(){}};
 const all=()=>descendants(elements.get('workspace-root'));
 const win={location:new URL('http://localhost'+path),sessionStorage:storage,addEventListener(){},setTimeout,history:{pushState:(_,__,href)=>win.location=new URL(href,win.location),replaceState:(_,__,href)=>win.location=new URL(href,win.location)}};
 const doc={getElementById:key=>elements.get(key),createElement:tag=>new Element(tag),addEventListener(){},querySelectorAll:()=>[...all().filter(e=>['INPUT','BUTTON','SELECT','TEXTAREA'].includes(e.tagName)),elements.get('workspace-logout')]};
 const vault={buyerPublicKey:async()=>({kty:'RSA',n:'unit-public-key'}),loadJob:async key=>records.get(key)||null,saveJob:async(key,value)=>records.set(key,structuredClone(value)),saveDecoder:async()=>{},encryptQuote:async(_,quote)=>{quotes.push(structuredClone(quote));return{iv:'unit-iv',wrappedKey:'unit-key',ciphertext:'unit-ciphertext'};}};
 const app=createWorkspace({document:doc,window:win,storage,walletPolicy:POLICY,walletFactory:async()=>{throw Error('i18n test must not request a wallet signature');},agentWorkerFactory:()=>({terminate(){},postMessage(){queueMicrotask(()=>this.onmessage({data:{type:'plan',raw:JSON.stringify({steps:[{column:'C2',recipe:{type:'number',steps:[{op:'fill',value:0},{op:'clamp',min:0,max:100}]}}]}),model:{id:'UNIT-ONLY-NOT-A-REAL-MODEL',revision:'fixture'}}}));}}),vaultFactory:()=>vault,fetch:async(url,options)=>{
  const wire=new URL(url,'http://localhost'),route='/'+wire.searchParams.get('route'),body=options.body?JSON.parse(options.body):undefined;calls.push({route,method:options.method,body});
  const result=route==='/session'?{session:identity,proof:{profile:PROOF_PROFILE,enabled:true,contractId:CONTRACT},wallet:WALLET_CAPABILITY}:route==='/jobs'&&options.method==='GET'?{jobs:[JOB]}:route==='/jobs'&&options.method==='POST'?{job:{...JOB,...body,id:body.jobId}}:{job:JOB};
  return{ok:true,status:200,json:async()=>result};
 }});
 async function settle(){for(let i=0;i<10000&&app.state.busy;i++)await new Promise(resolve=>setTimeout(resolve,1));assert.equal(app.state.busy,false);}
 return{app,doc,all,elements,calls,quotes,records,get:name=>all().find(e=>e.name===name),text:()=>elements.get('workspace-root').textContent,
  async upload(){const csv='Sayı,private-score\nMetin,154\nMetin,\n',input=all().find(e=>e.type==='file');input.files=[{size:csv.length,arrayBuffer:async()=>new TextEncoder().encode(csv).buffer}];await input.fire('change');await settle();},
  async change(name,value){const input=this.get(name);if(input.type==='checkbox')input.checked=value;else input.value=value;await input.fire('change');await settle();},
  async click(label){const button=all().find(e=>e.tagName==='BUTTON'&&e.textContent===label);assert.ok(button,label);await button.fire('click');await settle();},
  async submit(){await all().find(e=>e.tagName==='FORM').fire('submit');await settle();},
 };
}

test('English workspace live bindings preserve a populated draft, local CSV headers and nested recipe labels through language changes',async()=>{
 setLanguage('en',{persist:false});const h=browser();await h.app.start();assert.equal(h.elements.get('workspace-heading').textContent,'New encrypted job');assert.equal(h.doc.title,'New encrypted job · Customer — NOPE');
 await h.upload();const form=h.all().find(e=>e.tagName==='FORM'),title=h.get('title'),goal=h.get('agentGoal');title.value='Sayı';h.get('description').value='Metin';goal.value='Metin';await h.change('agentColumn2','number');await h.click('Yerel ajanla plan üret');await h.change('agentApprove',true);
 assert.ok(h.text().includes('C2: Number: empty → 0 → range 0–100'));
 assert.equal(h.get('column').children[0].textContent,'Sayı — unsupported column / recipe');
 const requests=h.calls.length;setLanguage('fr',{persist:false});
 assert.equal(h.elements.get('workspace-heading').textContent,'Nouvelle tâche chiffrée');assert.equal(h.doc.title,'Nouvelle tâche chiffrée · Client — NOPE');assert.ok(h.text().includes('C2: Nombre: vide → 0 → intervalle 0–100'));
 assert.equal(h.get('title'),title);assert.equal(title.value,'Sayı');assert.equal(goal.value,'Metin');assert.equal(h.all().find(e=>e.tagName==='FORM'),form);assert.equal(h.calls.length,requests);
 setLanguage('en',{persist:false});await h.submit();const post=h.calls.find(c=>c.route==='/jobs'&&c.method==='POST');assert.ok(post);
 assert.equal(post.body.title,'Sayı');assert.equal(post.body.description,'Metin');assert.equal(post.body.profile,PROOF_PROFILE);
 assert.equal(post.body.publicTask.goal,'Metin');assert.equal(Object.hasOwn(post.body,'source'),false);
 const local=h.records.get(post.body.jobId);assert.deepEqual(local.dataset.headers,['Sayı','private-score']);assert.equal(local.dataset.rows[0][0],'Metin');
});

test('English offer errors update live while input notes, amounts and encrypted transport stay unchanged',async()=>{
 setLanguage('en',{persist:false});const h=browser({path:'/offer?id='+ID,identity:PROVIDER});await h.app.start();
 assert.equal(h.elements.get('workspace-heading').textContent,'Submit an encrypted offer');assert.equal(h.elements.get('workspace-subtitle').textContent,'Sayı');
 assert.equal(h.get('amount').attributes.placeholder,'0.001');
 h.get('amount').value='invalid';h.get('note').value='Sayı';await h.submit();
 const banner=h.elements.get('workspace-message');assert.equal(banner.textContent,'Enter a valid testNEAR amount (up to 24 decimal places).');
 const count=h.calls.length;setLanguage('fr',{persist:false});assert.equal(banner.textContent,'Saisissez un montant testNEAR valide.');assert.equal(h.calls.length,count);assert.equal(h.get('note').value,'Sayı');
 h.get('amount').value='0.001';await h.submit();assert.equal(h.quotes[0].amountYocto,'1000000000000000000000');assert.equal(h.quotes[0].note,'Sayı');
 const post=h.calls.find(c=>c.route.endsWith('/offers')&&c.method==='POST');assert.deepEqual(Object.keys(post.body).sort(),['commitment','envelope']);assert.equal(JSON.stringify(post.body).includes('Sayı'),false);
});

test('workspace dates and module-created status messages follow live locale changes while public titles and goals remain raw',async()=>{
 setLanguage('en',{persist:false});const h=browser({path:'/customer'});await h.app.start();
 const deadline=h.all().find(e=>e.textContent==='Offers close: '+new Date(JOB.deadlineISO).toLocaleString('en-GB'));
 assert.ok(deadline);assert.ok(h.all().some(e=>e.textContent==='Open for offers'));assert.ok(h.all().some(e=>e.tagName==='H2'&&e.textContent==='Sayı'));assert.ok(h.text().includes('Public agent goal: Metin'));
 const count=h.calls.length;setLanguage('de',{persist:false});assert.equal(deadline.textContent,'Offers close: '+new Date(JOB.deadlineISO).toLocaleString('de-DE'));assert.equal(h.calls.length,count);
 assert.ok(h.all().some(e=>e.tagName==='H2'&&e.textContent==='Sayı'));assert.ok(h.text().includes('Public agent goal: Metin'));
 setLanguage('tr',{persist:false});assert.ok(h.all().some(e=>e.textContent==='Tekliflere açık'));assert.equal(h.calls.length,count);
});
