/** Buyer-local proving / public-only verification. Never used as an LLM worker. */
import {proveProofPlan} from './proof-plan-client.mjs';
import {verifyProofPlanBundle} from './proof-plan-core.mjs';

let busy=false;
self.onmessage=async ({data})=>{
 if(busy){self.postMessage({type:'error',error:'Kanıt işlemi zaten çalışıyor.'});return;}
 busy=true;
 try{
  if(!data||!['prove','verify'].includes(data.type))throw Error('Unsupported proof action');
  const onProgress=({completed,total})=>{
   if(Number.isSafeInteger(completed)&&Number.isSafeInteger(total)&&completed>=0&&completed<=total&&total>=1&&total<=128)
    self.postMessage({type:'progress',completed,total});
  };
  if(data.type==='prove'){
   const bundle=await proveProofPlan({request:data.request,delivery:data.delivery,binding:data.binding,witness:data.witness,onProgress});
   self.postMessage({type:'proof',bundle});
  }else{
   const valid=await verifyProofPlanBundle({request:data.request,delivery:data.delivery,binding:data.binding,bundle:data.bundle,onProgress});
   if(valid!==true)throw Error('Unverified result');
   self.postMessage({type:'verified',valid:true});
  }
 }catch{
  // Exceptions from a private witness calculator must not become shared diagnostics.
  self.postMessage({type:'error',error:'Sonuç kanıtı oluşturulamadı veya bu teslim için doğrulanamadı. Veri ve gizli eşleme bu cihazda kaldı.'});
 }finally{busy=false;}
};
