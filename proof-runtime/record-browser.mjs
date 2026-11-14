export * from './record-sdk.mjs';
export {proofPolicy,policyHash,proofPolicyHash}from'./record-policy.mjs';
/** One persistent external same-origin worker. All rows share its one WASM backend. */
export function createWorkerProofRuntime(){
 const worker=new Worker(new URL('./record-proof-worker.js',import.meta.url),{type:'module',name:'nope-result-proof'});
 let serial=0,closed=false;const pending=new Map();
 worker.onmessage=({data})=>{const p=pending.get(data.id);if(!p)return;pending.delete(data.id);data.error?p.reject(new Error(data.error)):p.resolve(data.result);};
 worker.onerror=e=>{for(const p of pending.values())p.reject(new Error(e.message));pending.clear();};
 const call=(method,args)=>{if(closed)return Promise.reject(new Error('Proof worker disposed'));const id=++serial;return new Promise((resolve,reject)=>{pending.set(id,{resolve,reject});worker.postMessage({id,method,args});});};
 const runtime=Object.fromEntries(['commitRow','selectedRoot','makeStatement','proveRow','verifyRow','profile'].map(m=>[m,a=>call(m,a)]));
 runtime.dispose=async()=>{if(closed)return;try{await call('dispose');}finally{closed=true;worker.terminate();for(const p of pending.values())p.reject(new Error('Proof worker disposed'));pending.clear();}};
 return runtime;
}
