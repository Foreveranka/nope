import test from 'node:test';
import assert from 'node:assert/strict';
import {createWorkspace,TOKEN_KEY,PROOF_PROFILE} from '../web/workspace.js';
import {createVault} from '../web/workspace-vault.mjs';

// Real vault validation/AES/RSA with explicitly in-memory storage and DOM/API
// fixtures. No wallet SDK, signing, browser control, credentials or network.
class Element{
 constructor(tag){this.tagName=tag.toUpperCase();this.children=[];this.listeners={};this.dataset={};this.attributes={};this.value='';this.checked=false;this.disabled=false;}
 set textContent(v){this.text=String(v);this.children=[];}get textContent(){return(this.text||'')+this.children.map(n=>n.textContent).join(' ');}
 append(...nodes){this.children.push(...nodes);}replaceChildren(...nodes){this.children=[];this.text='';this.append(...nodes);}
 addEventListener(k,fn){(this.listeners[k]||=[]).push(fn);}setAttribute(k,v){this.attributes[k]=v;}removeAttribute(k){delete this.attributes[k];}
 async fire(k){for(const fn of this.listeners[k]||[])await fn({preventDefault(){}});}
}
const all=n=>[n,...n.children.flatMap(all)],NS='nope-wallet-redirect-v1',RECORD='__wallet_redirect__';
async function setup(){
 const records=new Map(),key=k=>JSON.stringify(k),vaultStorage={
  get:async k=>structuredClone(records.get(key(k))),put:async(k,v)=>{records.set(key(k),structuredClone(v));},
  installKeys:async(k,v)=>{if(!records.has(key(k)))records.set(key(k),structuredClone(v));return structuredClone(records.get(key(k)));},
  deleteSession:async()=>assert.fail('Logout must never delete a vault namespace')
 };
 const identity={id:'a'.repeat(32),role:'provider',displayName:'UNIT provider',paymentAccount:'unit-provider.testnet',wallet:{accountId:'unit-provider.testnet',network:'testnet',publicKey:'ed25519:'+'1'.repeat(32),verifiedAt:'2026-11-14T00:00:00Z'}};
 const factory=namespace=>createVault(namespace,{storage:vaultStorage}),vault=factory(identity.id),saved={dataset:{headers:['UNIT private'],rows:[['UNIT value']]},decoder:{unit:'preserved'}};
 await vault.saveJob('private-job',saved);
 const storageMap=new Map([[TOKEN_KEY,'UNIT-SESSION'],['other-app','keep']]),storage={getItem:k=>storageMap.get(k)??null,setItem:(k,v)=>storageMap.set(k,v),removeItem:k=>storageMap.delete(k)};
 const elements=new Map(['workspace-root','workspace-nav','workspace-identity','workspace-message','workspace-logout','workspace-heading','workspace-subtitle'].map(k=>[k,new Element('div')]));
 const doc={getElementById:k=>elements.get(k),createElement:tag=>new Element(tag),addEventListener(){},querySelectorAll:()=>[...all(elements.get('workspace-root')),elements.get('workspace-logout')]};
 const win={location:new URL('https://unit.invalid/settings'),sessionStorage:storage,addEventListener(){},history:{pushState(_s,_t,url){win.location=new URL(url,win.location);},replaceState(_s,_t,url){win.location=new URL(url,win.location);}}};
 const options={document:doc,window:win,storage,vaultFactory:factory,walletFactory:async()=>assert.fail('Role change must not connect/sign'),fetch:async url=>{
  assert.equal(new URL(url,'https://unit.invalid').searchParams.get('route'),'session');return{ok:true,json:async()=>({session:identity,proof:{profile:PROOF_PROFILE,enabled:false,contractId:null}})};
 }};const app=createWorkspace(options);
 await app.start();
 await factory(NS).saveJob(RECORD,{version:1,token:'UNIT-OLD-TOKEN',pending:{kind:'challenge',challengeId:'b'.repeat(64)}});
 async function settle(){for(let i=0;i<1000&&app.state.busy;i++)await new Promise(r=>setTimeout(r,1));assert.equal(app.state.busy,false);}
 const roleButton=()=>all(elements.get('workspace-root')).find(n=>n.tagName==='BUTTON'&&n.textContent==='Rol değiştirmek için yeni oturum başlat');
 return{app,win,storageMap,elements,vault,saved,reload:()=>createWorkspace(options),resume:()=>factory(NS).loadJob(RECORD),roleButton,
  consent:()=>all(elements.get('workspace-root')).find(n=>n.type==='checkbox'),
  async click(node){assert.ok(node);await node.fire('click');await settle();}};
}
test('settings role change and shared sign-out clear resume through real vault object validation while preserving private jobs',async()=>{
 for(const action of ['role-change','sign-out']){
  const h=await setup();
  if(action==='role-change'){
   await h.click(h.roleButton());assert.equal(h.app.state.session.role,'provider');assert.equal(h.storageMap.get(TOKEN_KEY),'UNIT-SESSION');
   h.consent().checked=true;await h.click(h.roleButton());
  }else await h.click(h.elements.get('workspace-logout'));
  assert.equal(h.app.state.session,null,action);assert.equal(h.storageMap.has(TOKEN_KEY),false);assert.equal(h.storageMap.get('other-app'),'keep');
  assert.equal(h.win.location.pathname,'/workspace');assert.deepEqual(await h.vault.loadJob('private-job'),h.saved);
  assert.deepEqual(await h.resume(),{version:1,cleared:true});assert.equal(h.app.state.walletPending,null);
  assert.ok(all(h.elements.get('workspace-root')).some(n=>n.tagName==='SELECT'&&n.name==='role'));
  const reloaded=h.reload();await reloaded.start();assert.equal(reloaded.state.session,null);assert.equal(reloaded.state.walletPending,null);assert.deepEqual(await h.vault.loadJob('private-job'),h.saved);
 }
});
test('role change and shared sign-out preserve unresolved transaction capsule, session and vault',async()=>{
 for(const action of ['role-change','sign-out']){
  const h=await setup(),before=await h.resume();h.app.state.walletPending={kind:'transaction',intentId:'c'.repeat(64)};
  if(action==='role-change'){h.consent().checked=true;await h.click(h.roleButton());}else await h.click(h.elements.get('workspace-logout'));
  assert.equal(h.app.state.session.role,'provider');assert.equal(h.storageMap.get(TOKEN_KEY),'UNIT-SESSION');assert.equal(h.win.location.pathname,'/settings');
  assert.deepEqual(await h.resume(),before);assert.equal(h.app.state.walletPending.kind,'transaction');assert.deepEqual(await h.vault.loadJob('private-job'),h.saved);
 }
});
