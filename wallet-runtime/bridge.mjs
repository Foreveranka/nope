/** Pinned executor runs ONLY inside an opaque sandbox. Parent-origin and random
 * capability checks protect every receiver, including the wallet's own listeners. */
const PROTOCOL='NOPE:WALLET:FRAME:V1',WALLET_ORIGIN='https://wallet.intear.tech';
const nativeAdd=window.addEventListener.bind(window),nativeRemove=window.removeEventListener.bind(window);let config=null,initialized=false;
const listeners=new WeakMap(),pending=new Map();
const valid=e=>config&&e.source===window.parent&&e.origin===config.parentOrigin&&e.data?.protocol===PROTOCOL&&e.data?.origin===config.origin;
const uuid=()=>Array.from(crypto.getRandomValues(new Uint8Array(32)),x=>x.toString(16).padStart(2,'0')).join('');
window.addEventListener=(type,fn,opts)=>{if(type!=='message')return nativeAdd(type,fn,opts);const wrapped=e=>{if(valid(e)){if(typeof fn==='function')fn(e);else fn.handleEvent(e);}};listeners.set(fn,wrapped);nativeAdd(type,wrapped,opts);};
window.removeEventListener=(type,fn,opts)=>nativeRemove(type,type==='message'?(listeners.get(fn)??fn):fn,opts);
function send(data){window.parent.postMessage({...data,protocol:PROTOCOL,origin:config.origin},config.parentOrigin);}
function call(method,params){const id=uuid();return new Promise((resolve,reject)=>{pending.set(id,{method,resolve,reject});send({id,method,params});});}
nativeAdd('message',event=>{
 if(!valid(event))return;const d=event.data,p=pending.get(d.id);if(!p||p.method!==d.method||!['success','failed'].includes(d.status))return;pending.delete(d.id);d.status==='success'?p.resolve(d.result):p.reject(Error('Wallet bridge request failed'));
});
class ProxyWindow {
 constructor(url,_features){const u=new URL(url);if(u.origin!==WALLET_ORIGIN||u.protocol!=='https:')throw Error('Wallet origin rejected');this.closed=false;this.idPromise=call('open',{url,features:_features});
  window.addEventListener('message',async e=>{if(e.data.method==='proxy-window:closed'&&e.data.windowId===await this.idPromise)this.closed=true;});
 }
 id(){return this.idPromise;}
 async close(){return call('panel.close',{windowId:await this.id()});}
 async focus(){return call('panel.focus',{windowId:await this.id()});}
 async postMessage(data,targetOrigin){if(targetOrigin!==WALLET_ORIGIN)throw Error('Wallet target origin rejected');return call('panel.postMessage',{windowId:await this.id(),data});}
}
async function prompt(args){await call('ui.showIframe',{});const root=document.getElementById('root');root.replaceChildren();const p=document.createElement('p');p.textContent=config.labels.prompt;const b=document.createElement('button');b.type='button';b.textContent=config.labels.open;root.append(p,b);await new Promise(resolve=>b.addEventListener('click',resolve,{once:true}));root.replaceChildren();await call('ui.hideIframe',{});}
async function ready(wallet){
 if(!wallet?.near||typeof wallet.near.requestConnection!=='function')throw Error('Pinned Intear executor shape changed');
 const near=wallet.near,request=near.requestConnection.bind(near);
 // Public Intear client option selects its supported web popup rather than a
 // remote nested iframe/native bridge. No vendor source/signing logic is changed.
 near.requestConnection=async args=>{
  if(args?.networkId!=='testnet'||args.functionCallKey!=null)throw Error('Only testnet without delegated keys is supported');
  const result=await request({...args,walletUrl:WALLET_ORIGIN});
  if(result&&near.walletUrl!==WALLET_ORIGIN){await near.disconnect();throw Error('Wallet origin changed');}return result;
 };
 // Published outer connector method drops callbackUrl. The pinned public inner
 // API accepts it. Preserve the exact server NEP-413 payload, never omit fallback.
 wallet.signMessage=async args=>{
  const a=near.connectedAccount;if(args.network!=='testnet'||!a||a.accountId!==args.signerId)throw Error('Wallet account changed');
  const result=await a.signMessage({message:args.message,nonce:args.nonce,recipient:args.recipient,callbackUrl:args.callbackUrl,state:args.state});
  if(!result)throw Error('User rejected the message');return result;
 };
 wallet.manifest=config.manifest;window.selector.wallet=wallet;send({method:'wallet-ready'});
}
async function initialize(e){
 const d=e.data;
 if(initialized||e.source!==window.parent||e.origin!==new URL(window.location.href).origin||!d||d.protocol!==PROTOCOL||d.type!=='initialize'||d.parentOrigin!==e.origin||!/^[0-9a-f]{64}$/.test(d.origin)||d.manifest?.id!=='intear-wallet')return;
 if(!d.labels||!['title','cancel','frameTitle','open','prompt'].every(k=>typeof d.labels[k]==='string'&&d.labels[k].length<512))return;
 initialized=true;config=d;document.title=d.labels.frameTitle;nativeRemove('message',initialize);
 window.selector={wallet:null,location:d.parentOrigin+'/settings',nearConnectVersion:'0.12.0',providers:{testnet:['https://test.rpc.fastnear.com'],mainnet:[]},uuid,call,ready,
  open:(url,_unused,features)=>new ProxyWindow(url,features),openNativeApp:()=>{throw Error('Native wallet bridge disabled');},
  ui:{showIframe:()=>call('ui.showIframe',{}),hideIframe:()=>call('ui.hideIframe',{}),whenApprove:prompt},
  storage:{get:key=>call('storage.get',{key}),set:(key,value)=>call('storage.set',{key,value}),remove:key=>call('storage.remove',{key}),keys:()=>call('storage.keys',{})}
 };
 window.addEventListener('message',async event=>{
  const data=event.data;if(!data.method?.startsWith('wallet:')||typeof data.id!=='string')return;
  const method=data.method.slice(7);if(!['signIn','getAccounts','signMessage','signOut','signAndSendTransaction'].includes(method)){send({id:data.id,method,status:'failed',result:'Method denied'});return;}
  try{const result=await window.selector.wallet[method](data.params);send({id:data.id,method,status:'success',result});}catch{send({id:data.id,method,status:'failed',result:'Wallet request failed or closed; outcome may be unknown'});}
 });
 await import('./intear-executor.js');
}
nativeAdd('message',initialize);
