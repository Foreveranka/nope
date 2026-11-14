import test from 'node:test';
import assert from 'node:assert/strict';
import {createWorkspace,PROOF_PROFILE,TOKEN_KEY} from '../web/workspace.js';
import {readFile} from 'node:fs/promises';
import {initI18n,setLanguage,msg} from '../web/i18n.mjs';
import {sha256} from '../web/gc-core.mjs';

// Explicit authentication/adapter/API fixtures. The signature is a UNIT marker,
// not a valid signature, key or authentication proof. No wallet SDK, signer,
// model, prover, network request or chain access is used by this file.
const ID='a'.repeat(32),CONTRACT='wallet-auth-ui.testnet',ACCOUNT='wallet-customer.testnet';
const POLICY={network:'testnet',contractId:CONTRACT,codeHash:'2'.repeat(44),domain:'NOPE:WALLET-ESCROW:V1:testnet',requireKeyless:true};
const CAPABILITY={required:true,enabled:true,network:'testnet',contractId:CONTRACT};
const WALLET={accountId:ACCOUNT,network:'testnet',publicKey:'ed25519:'+ '1'.repeat(32),verifiedAt:'2026-11-14T00:00:00Z'};
const SIGNED={challengeId:'e'.repeat(64),accountId:ACCOUNT,publicKey:WALLET.publicKey,signature:'UNIT-ONLY-NOT-A-SIGNATURE'};
class Element{
 constructor(tag){this.tagName=tag.toUpperCase();this.children=[];this.listeners={};this.dataset={};this.attributes={};this.value='';this.disabled=false;this.checked=false;this.files=[];}
 set textContent(v){this.text=String(v);this.children=[];}
 get textContent(){return(this.text||'')+this.children.map(n=>n.textContent).join(' ');}
 append(...nodes){for(const n of nodes){if(n.parentElement)n.parentElement.children=n.parentElement.children.filter(x=>x!==n);n.parentElement=this;this.children.push(n);if(this.tagName==='SELECT'&&this.children.length===1)this.value=n.value;}}
 replaceChildren(...nodes){this.children.forEach(n=>n.parentElement=null);this.children=[];this.text='';this.append(...nodes);}
 addEventListener(name,fn){(this.listeners[name]||=[]).push(fn);}
 setAttribute(k,v){this.attributes[k]=v;}
 removeAttribute(k){delete this.attributes[k];}
 reportValidity(){return true;}
 async fire(type){for(const fn of this.listeners[type]||[])await fn({preventDefault(){}});}
}
const descendants=n=>[n,...n.children.flatMap(descendants)];
async function browser({role='buyer',path='/jobs/new',cancel=false,redirect=false,badSession=false,badAccount=false,capability=CAPABILITY,policy=POLICY,apiFailure}={}){
 let session={id:'unsigned-unit-session',role,displayName:'UNIT user'};const stableId=(await sha256('NOPE:wallet-session:v1:testnet:'+role+':'+ACCOUNT)).slice(0,32);
 const elements=new Map(['workspace-root','workspace-nav','workspace-identity','workspace-message','workspace-logout','workspace-heading','workspace-subtitle'].map(k=>[k,new Element('div')])),calls=[],walletCalls=[],records=new Map();
 const storage={getItem:k=>k===TOKEN_KEY?'unit-token':null,setItem(){},removeItem(){}};
 const win={location:new URL('http://localhost'+path),sessionStorage:storage,addEventListener(){},history:{pushState:(_,__,href)=>win.location=new URL(href,win.location),replaceState:(_,__,href)=>win.location=new URL(href,win.location)}};
 const all=()=>descendants(elements.get('workspace-root')),doc={getElementById:k=>elements.get(k),createElement:tag=>new Element(tag),addEventListener(){},querySelectorAll:()=>all().filter(e=>['INPUT','BUTTON','SELECT','TEXTAREA'].includes(e.tagName))};
 let challenge;
 const app=createWorkspace({document:doc,window:win,storage,walletPolicy:policy,vaultFactory:namespace=>({loadJob:async key=>records.get(namespace+':'+key)||null,saveJob:async(key,value)=>records.set(namespace+':'+key,structuredClone(value))}),walletFactory:async options=>{
  assert.deepEqual(options.policy,POLICY);assert.equal(options.network,'testnet');return{
   connect:async input=>{walletCalls.push({type:'connect',input});assert.deepEqual(input,{accountId:ACCOUNT});return{accountId:ACCOUNT,network:'testnet'};},
   signChallenge:async value=>{walletCalls.push({type:'signChallenge',value:structuredClone(value)});assert.deepEqual(value,challenge);assert.equal(value.sessionId,'unsigned-unit-session');assert.equal(value.accountId,ACCOUNT);if(cancel)throw Object.assign(Error('UNIT cancellation'),{code:'WALLET_REJECTED'});return redirect?{redirected:true}:{...SIGNED};},
   currentAccount:async()=>({accountId:ACCOUNT,network:'testnet'}),completeRedirect:async()=>null,
   sendTransaction:async()=>assert.fail('Connecting a wallet must never send funds')
  };
 },fetch:async(url,options)=>{
  const route='/'+new URL(url,'http://localhost').searchParams.get('route'),body=options.body?JSON.parse(options.body):undefined;calls.push({route,method:options.method,body});let result;
  if(apiFailure?.route===route)return{ok:false,status:403,json:async()=>({code:apiFailure.code,error:'RAW PRIVATE AUTH DIAGNOSTIC MUST NEVER BE DISPLAYED',signature:'UNIT PRIVATE RESPONSE MARKER'})};
  if(route==='/session'){assert.equal(options.method,'GET');result={session,proof:{profile:PROOF_PROFILE,enabled:true,contractId:CONTRACT},wallet:capability};}
  else if(route==='/wallet'){assert.equal(options.method,'GET');result={wallet:session.wallet||null};}
  else if(route==='/wallet/challenge'){
   assert.equal(options.method,'POST');assert.deepEqual(body,{accountId:ACCOUNT});
   challenge={challengeId:SIGNED.challengeId,network:'testnet',accountId:ACCOUNT,sessionId:session.id,role,origin:'http://localhost',nonce:'UNIT-ONLY-NONCE',issuedAt:'2026-11-14T00:00:00Z',expiresAt:'2026-11-14T00:05:00Z',message:'UNIT-ONLY-NEP413-CHALLENGE',recipient:'http://localhost',callbackUrl:'http://localhost/settings'};result={challenge};
  }else if(route==='/wallet/verify'){
   assert.equal(options.method,'POST');assert.deepEqual(body,SIGNED);session={id:badSession?'f'.repeat(32):stableId,role,displayName:'UNIT user',...(role==='provider'?{paymentAccount:ACCOUNT}:{}),wallet:{...WALLET,...(badAccount?{accountId:'other-wallet.testnet'}:{})}};result={session,wallet:session.wallet};
  }else if(route==='/jobs'){assert.equal(options.method,'GET');result={jobs:[]};}
  else if(route==='/jobs/'+ID){assert.equal(options.method,'GET');result={job:{id:ID,buyerId:'buyer-unit',buyerWallet:{...WALLET,accountId:'buyer-unit.testnet'},status:'OPEN',title:'UNIT job',description:'Synthetic',profile:PROOF_PROFILE,deadlineISO:'2099-01-01T00:00:00Z',rowCount:1,payment:{kind:'WALLET_TESTNET_ESCROW',network:'testnet',contractId:CONTRACT,status:'NOT_FUNDED'},offers:[]}};}
  else assert.fail('Unrecognized unit route '+route);
  return{ok:true,status:200,json:async()=>structuredClone(result)};
 }});
 async function settle(){for(let i=0;i<10000&&app.state.busy;i++)await new Promise(resolve=>setTimeout(resolve,1));assert.equal(app.state.busy,false);}
 return{app,calls,walletCalls,records,all,get:name=>all().find(e=>e.name===name),text:()=>elements.get('workspace-root').textContent,message:()=>elements.get('workspace-message').textContent,
  click:async label=>{const b=all().find(e=>e.tagName==='BUTTON'&&e.textContent===label);assert.ok(b,label);await b.fire('click');await settle();}
 };
}

test('new-job and offer forms require an explicit session-bound signed wallet connection for both roles',async()=>{
 for(const role of ['buyer','provider']){
  const h=await browser({role,path:role==='buyer'?'/jobs/new':'/offer?id='+ID});await h.app.start();assert.equal(h.get(role==='buyer'?'csv':'amount'),undefined);assert.equal(h.calls.some(c=>c.method==='POST'),false);
  h.get('walletAccount').value=ACCOUNT;await h.click('Cüzdanı bağla ve imzayla doğrula');assert.deepEqual(h.calls.filter(c=>c.method==='POST').map(c=>[c.route,c.body]),[['/wallet/challenge',{accountId:ACCOUNT}],['/wallet/verify',SIGNED]]);assert.deepEqual(h.walletCalls.map(c=>c.type),['connect','signChallenge']);assert.equal(h.app.state.session.wallet.accountId,ACCOUNT);assert.ok(h.get(role==='buyer'?'csv':'amount'));assert.equal(h.app.state.walletPending,null);assert.equal(h.calls.some(c=>c.route.includes('/payment/')),false);
 }
});

test('cancelled wallet authentication cannot unlock jobs/offers or submit a verify response',async()=>{
 for(const role of ['buyer','provider']){
  const h=await browser({role,cancel:true,path:role==='buyer'?'/jobs/new':'/offer?id='+ID});await h.app.start();h.get('walletAccount').value=ACCOUNT;await h.click('Cüzdanı bağla ve imzayla doğrula');assert.equal(h.calls.filter(c=>c.route==='/wallet/verify').length,0);assert.equal(h.app.state.session.wallet,undefined);assert.equal(h.app.state.walletPending,null);assert.equal(h.get(role==='buyer'?'csv':'amount'),undefined);assert.match(h.message(),/iptal edildi/);
 }
});

test('wrong returned wallet identity or unstable authenticated session never unlocks a new-job form',async()=>{
 for(const options of [{badSession:true},{badAccount:true}]){const h=await browser(options);await h.app.start();h.get('walletAccount').value=ACCOUNT;await h.click('Cüzdanı bağla ve imzayla doğrula');assert.equal(h.get('csv'),undefined);assert.equal(h.app.state.session.wallet,undefined);assert.match(h.message(),/bağlaması doğrulanamadı/);assert.equal(h.calls.some(c=>c.route==='/jobs'&&c.method==='POST'),false);}
});

test('a redirected authentication remains unverified and does not invent an account or publish a job',async()=>{
 const h=await browser({redirect:true});await h.app.start();h.get('walletAccount').value=ACCOUNT;await h.click('Cüzdanı bağla ve imzayla doğrula');assert.equal(h.get('csv'),undefined);assert.equal(h.app.state.session.wallet,undefined);assert.equal(h.app.state.walletPending.kind,'challenge');assert.equal(h.calls.some(c=>c.route==='/wallet/verify'),false);assert.equal(h.calls.some(c=>c.route==='/jobs'&&c.method==='POST'),false);
});

test('disabled or mismatched deployment capability offers no wallet connection, manual preparation or sponsor fallback',async()=>{
 for(const options of [{policy:null},{capability:null},{capability:{...CAPABILITY,enabled:false}},{capability:{...CAPABILITY,required:false}},{capability:{...CAPABILITY,network:'mainnet'}},{capability:{...CAPABILITY,contractId:'different-contract.testnet'}}]){
  const h=await browser(options);await h.app.start();assert.equal(h.get('walletAccount'),undefined);assert.equal(h.get('planningMode'),undefined);assert.equal(h.get('csv'),undefined);assert.equal(h.calls.some(c=>c.method==='POST'),false);assert.equal(h.walletCalls.length,0);
 }
});


test('wallet auth failures expose only allowlisted localized guidance in all five languages and preserve forms without retrying',async()=>{
 const langs=['tr','en','de','es','fr'],catalogs=Object.fromEntries(await Promise.all(langs.map(async lang=>[lang,JSON.parse(await readFile(new URL('../web/locales/'+lang+'.json',import.meta.url),'utf8'))])));
 await initI18n({document:{},window:{},storage:{getItem:()=> 'tr'},fetch:async url=>({ok:true,json:async()=>catalogs[new URL(url).pathname.split('/').at(-1).slice(0,-5)]})});
 const groups=[
  [['WALLET_CHALLENGE_EXPIRED'],'Cüzdan doğrulama isteğinin süresi doldu. Hesap bağlamayı yeniden başlatıp yeni mesajı imzala.'],
  [['WALLET_CHALLENGE_USED'],'Bu hesap bağlama isteği zaten kullanıldı. Durumu yenile veya yeni doğrulama isteği başlat.'],
  [['WALLET_WRONG_NETWORK'],'Cüzdan ağı testnet olarak doğrulanamadı. Ana ağa geçilmedi; testnet bağlantısını kontrol et.'],
  [['WALLET_SIGNATURE_NOT_VERIFIED','WALLET_INVALID_PROOF','WALLET_INVALID_PUBLIC_KEY','WALLET_KEY_MISMATCH','WALLET_FULL_ACCESS_REQUIRED','WALLET_INVALID_ENCODING'],'Cüzdan imzası ve hesap kontrolü doğrulanamadı. Doğru testnet hesabıyla yeni bağlama isteği başlat.'],
  [['WALLET_CHALLENGE_MISMATCH','WALLET_SESSION_MISMATCH'],'Hesap bağlama isteği bu oturumla eşleşmiyor. Mevcut oturumdan yeni doğrulama isteği başlat.'],
  [['WALLET_ACCOUNT_IMMUTABLE'],'Farklı cüzdan için önce açıkça yeni oturum başlat. Mevcut yerel kasa silinmedi.'],
  [['RAW PRIVATE UNKNOWN CODE','x'.repeat(81),null,{code:'WALLET_CHALLENGE_EXPIRED'}],'Bu oturumun bu işleme yetkisi yok.'],
 ];
 for(const lang of langs)for(const [codes,key] of groups)for(const code of codes){
  setLanguage(lang,{persist:false});const h=await browser({path:'/settings',apiFailure:{route:'/wallet/verify',code}});await h.app.start();h.get('walletAccount').value=ACCOUNT;await h.click(String(msg('Cüzdanı bağla ve imzayla doğrula')));assert.equal(h.message(),String(msg(key)),String(code));assert.equal(h.app.state.session.wallet,undefined);assert.equal(h.calls.filter(c=>c.route==='/wallet/verify').length,1);assert.ok(!h.message().includes('RAW PRIVATE'));assert.ok(!h.message().includes('UNIT PRIVATE RESPONSE MARKER'));
  const count=h.calls.length,account=h.get('walletAccount');account.value=ACCOUNT;setLanguage(langs[(langs.indexOf(lang)+1)%langs.length],{persist:false});assert.equal(h.message(),String(msg(key)));assert.equal(h.get('walletAccount'),account);assert.equal(account.value,ACCOUNT);assert.equal(h.calls.length,count,'language changes never retry failed auth');
 }
 setLanguage('tr',{persist:false});const h=await browser({path:'/settings',apiFailure:{route:'/wallet/challenge',code:'WALLET_CHALLENGE_EXPIRED'}});await h.app.start();h.get('walletAccount').value=ACCOUNT;await h.click('Cüzdanı bağla ve imzayla doğrula');assert.equal(h.walletCalls.some(c=>c.type==='signChallenge'),false);assert.equal(h.calls.some(c=>c.route==='/wallet/verify'),false);assert.equal(h.message(),String(msg(groups[0][1])));
});
