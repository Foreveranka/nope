/** External opaque-frame transport for pinned NEAR Connect 0.12.0. No eval/srcdoc.
 * The SDK's method semantics are unchanged. Only packaging/transport is replaced. */
const PROTOCOL='NOPE:WALLET:FRAME:V1';
const METHODS=new Set(['wallet-ready','ui.showIframe','ui.hideIframe','storage.get','storage.set','storage.remove','storage.keys','panel.focus','panel.postMessage','panel.close','open']);
export default class IframeExecutor {
 constructor(executor,_unusedCode,onMessage){
  this.executor=executor;this.origin=Array.from(crypto.getRandomValues(new Uint8Array(32)),x=>x.toString(16).padStart(2,'0')).join('');this.disposed=false;this.listeners=new Map();
  this.iframe=document.createElement('iframe');this.iframe.src=new URL('./bridge.html',import.meta.url).href;this.iframe.title=executor.connector.__nopeLabels.frameTitle;this.iframe.className='nope-wallet-frame';this.iframe.hidden=true;
  this.iframe.setAttribute('sandbox','allow-scripts allow-popups allow-popups-to-escape-sandbox');
  this.container=document.createElement('dialog');this.container.className='nope-wallet-dialog';const cancel=document.createElement('button');cancel.type='button';cancel.textContent=executor.connector.__nopeLabels.cancel;cancel.className='btn secondary';cancel.addEventListener('click',()=>{this.emit('close',{});this.dispose();});this.container.append(cancel,this.iframe);
  this.container.addEventListener('cancel',e=>{e.preventDefault();this.emit('close',{});this.dispose();});document.body.append(this.container);
  this.readyPromise=new Promise(resolve=>{this.readyResolve=resolve;});
  this.handler=event=>{
   if(this.disposed||event.source!==this.iframe.contentWindow||event.origin!=='null')return;
   const d=event.data;if(!d||typeof d!=='object'||d.protocol!==PROTOCOL||d.origin!==this.origin)return;
   if(d.method==='wallet-ready'){this.readyResolve();return;}
   if(!METHODS.has(d.method)||typeof d.id!=='string'||!/^[0-9a-f-]{32,64}$/.test(d.id))return;
   onMessage(this,event);
  };
  window.addEventListener('message',this.handler);
  this.iframe.addEventListener('load',async()=>{
   const storage=await executor.getAllStorage();if(this.disposed)return;
   this.iframe.contentWindow.postMessage({protocol:PROTOCOL,type:'initialize',origin:this.origin,parentOrigin:window.location.origin,location:window.location.origin+'/settings',storage,manifest:executor.manifest,labels:executor.connector.__nopeLabels},'*');
  },{once:true});
 }
 on(type,fn){this.listeners.set(type,[...(this.listeners.get(type)||[]),fn]);}
 emit(type,data){for(const fn of this.listeners.get(type)||[])fn(data);}
 show(){this.iframe.hidden=false;if(!this.container.open)this.container.showModal();}
 hide(){this.iframe.hidden=true;if(this.container.open)this.container.close();}
 postMessage(data){if(!this.disposed)this.iframe.contentWindow?.postMessage({...data,origin:this.origin,protocol:PROTOCOL},'*');}
 dispose(){if(this.disposed)return;this.disposed=true;window.removeEventListener('message',this.handler);this.container.remove();this.listeners.clear();}
}
