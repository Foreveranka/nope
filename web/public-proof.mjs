/** Independent public transcript/chain checks. This module never accepts a witness. */
import {PROFILE,canonicalProofPlanRequest,hashProofPlanProgram} from './proof-plan-core.mjs';
import {hashPlan,hashPlanOutput} from './plan-core.mjs';
import {sha256} from './gc-core.mjs';
export const CHAIN_POLICY=Object.freeze({network:'testnet',contractId:'nope-work-da4cbb1e.testnet',codeHash:'94XLBcytUKaL19QBzQqKFKsDvNZipcn5yvEUFEuumsPm'});
const RPC='https://test.rpc.fastnear.com';
const check=(v,m)=>{if(!v)throw Error(m);};
const hex=(v,n)=>typeof v==='string'&&new RegExp(`^[0-9a-f]{${n}}$`).test(v);

export async function boundedPublicJSON(response,maxBytes){
 check(response.ok,'Herkese açık kayıt alınamadı.');
 const reader=response.body.getReader(),chunks=[];let size=0;
 try{for(;;){const {done,value}=await reader.read();if(done)break;size+=value.byteLength;if(size>maxBytes){await reader.cancel();throw Error('Kanıt kaydı boyut sınırını aştı.');}chunks.push(value);}}
 finally{reader.releaseLock();}
 const bytes=new Uint8Array(size);let p=0;for(const c of chunks){bytes.set(c,p);p+=c.length;}
 return JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes));
}
export function validatePublicEvidence(e,expectedJobId){
 check(e?.version===1&&e.network==='testnet'&&hex(e.jobId,32)&&e.task?.profile===PROFILE,'Desteklenen sonuç kanıtı değil.');
 if(expectedJobId!==undefined)check(hex(expectedJobId,32)&&e.jobId===expectedJobId,'Dönen kanıt istenen işe ait değil.');
 check(e.binding?.jobId===e.jobId&&e.binding.contractId===CHAIN_POLICY.contractId&&e.task.proofManifest?.context.jobId===e.jobId&&
  e.task.proofManifest.context.contractId===CHAIN_POLICY.contractId&&hex(e.task.proofManifest.context.buyerCommitment,64),'Kanıt iş veya sözleşme bağlamıyla eşleşmiyor.');
 check(Number.isInteger(e.binding.version)&&e.binding.version>0&&e.delivery?.version===e.binding.version&&hex(e.delivery.inputSha256,64)&&hex(e.delivery.outputSha256,64),'Teslim sürümü veya özeti geçersiz.');
 canonicalProofPlanRequest(e.task);return e;
}
export async function verifyPublicChainBinding(e,{fetcher=globalThis.fetch}={}){
 validatePublicEvidence(e);
 async function rpc(method,params){
  const r=await fetcher(RPC,{method:'POST',redirect:'error',signal:AbortSignal.timeout(20000),headers:{'content-type':'application/json'},body:JSON.stringify({jsonrpc:'2.0',id:'nope-public-proof',method,params})});
  const j=await boundedPublicJSON(r,2*1024*1024);check(!j.error&&j.result!==undefined,'Testnet kaydı bağımsız olarak sorgulanamadı.');return j.result;
 }
 check((await rpc('status',[])).chain_id===CHAIN_POLICY.network,'Yanlış ağ.');
 const account=await rpc('query',{request_type:'view_account',account_id:CHAIN_POLICY.contractId,finality:'final'});
 check(account.code_hash===CHAIN_POLICY.codeHash&&typeof account.block_hash==='string','Sözleşme kodu sabit doğrulama politikasıyla eşleşmiyor.');
 const args=btoa(JSON.stringify({job_id:e.jobId}));
 const view=await rpc('query',{request_type:'call_function',account_id:CHAIN_POLICY.contractId,method_name:'get_hold',args_base64:args,block_id:account.block_hash});
 check(view.block_hash===account.block_hash&&Array.isArray(view.result)&&view.result.length<=16384&&view.result.every(x=>Number.isInteger(x)&&x>=0&&x<256),'Kesinleşmiş sözleşme kaydı geçersiz.');
 const hold=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(Uint8Array.from(view.result))),t=hold?.terms;
 const inputHash=await sha256(canonicalProofPlanRequest(e.task)),programHash=await hashProofPlanProgram(e.task.task.plan),planHash=await hashPlan(e.task.task.plan),outputHash=await hashPlanOutput(e.delivery.outputs);
 check(t&&t.job_id===e.jobId&&t.buyer_commitment===e.task.proofManifest.context.buyerCommitment&&t.provider===e.binding.provider&&t.amount===e.binding.amountYocto&&
  t.input_hash===inputHash&&t.program_hash===programHash&&t.plan_hash===planHash,'Zincirdeki ön taahhüt, şifreli girdi veya program farklı.');
 check(e.delivery.inputSha256===inputHash&&e.delivery.programSha256===programHash&&e.delivery.outputSha256===outputHash,'Teslim edilen şifreli veri değiştirilmiş.');
 check(hold.delivery?.version===e.delivery.version&&hold.delivery.output_hash===outputHash&&['Delivered','PayoutPending','Paid','Refunded'].includes(hold.state),'Son teslim sürümü zincirde kayıtlı değil veya farklı.');
 for(const k of ['execution_deadline_ns','review_deadline_ns'])check(typeof t[k]==='string'&&/^[1-9][0-9]{0,19}$/.test(t[k]),'Sözleşme zamanı geçersiz.');
 const bindingHash=await sha256(JSON.stringify(['NOPE:WORKSPACE-ESCROW:V1:testnet',CHAIN_POLICY.contractId,t.job_id,t.buyer_commitment,t.provider,t.amount,t.input_hash,t.program_hash,t.plan_hash,t.execution_deadline_ns,t.review_deadline_ns]));
 check(hold.binding_hash===bindingHash&&e.binding.bindingHash===bindingHash,'Escrow bağ özeti eşleşmiyor.');
 return{network:'testnet',contractId:CHAIN_POLICY.contractId,codeHash:CHAIN_POLICY.codeHash,blockHash:account.block_hash,
  inputSha256:inputHash,programSha256:programHash,planSha256:planHash,outputSha256:outputHash,version:e.delivery.version,bindingHash,escrowState:hold.state};
}
