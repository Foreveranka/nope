/** Independent public transcript/chain checks. This module never accepts a witness. */
import {PROFILE,canonicalProofPlanRequest,hashProofPlanProgram} from './proof-plan-core.mjs';
import {hashPlan,hashPlanOutput} from './plan-core.mjs';
import {sha256} from './gc-core.mjs';
import {WALLET_ESCROW_POLICY,HISTORICAL_WALLET_ESCROW_POLICIES} from './wallet-pins.mjs';
export const CHAIN_POLICY=Object.freeze({network:'testnet',contractId:'nope-work-da4cbb1e.testnet',codeHash:'94XLBcytUKaL19QBzQqKFKsDvNZipcn5yvEUFEuumsPm'});
// Only immutable, reviewed deployment pins are trusted; API evidence cannot add one.
export function chainPolicyFor(contractId){return [CHAIN_POLICY,WALLET_ESCROW_POLICY,...HISTORICAL_WALLET_ESCROW_POLICIES].find(p=>p&&p.network==='testnet'&&p.contractId===contractId)||null;}
const RPC='https://test.rpc.fastnear.com';
const check=(v,m)=>{if(!v)throw Error(m);};
const hex=(v,n)=>typeof v==='string'&&new RegExp(`^[0-9a-f]{${n}}$`).test(v);
const walletAccount=v=>typeof v==='string'&&v.length>=8&&v.length<=64&&(hex(v,64)||/^[a-z0-9]+(?:[-_][a-z0-9]+)*(?:\.[a-z0-9]+(?:[-_][a-z0-9]+)*)*\.testnet$/.test(v));

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
 const policy=chainPolicyFor(e.binding?.contractId);
 check(policy&&e.binding?.jobId===e.jobId&&e.task.proofManifest?.context.jobId===e.jobId&&
  e.task.proofManifest.context.contractId===policy.contractId&&hex(e.task.proofManifest.context.buyerCommitment,64),'Kanıt iş veya sözleşme bağlamıyla eşleşmiyor.');
 check(Number.isInteger(e.binding.version)&&e.binding.version>0&&e.delivery?.version===e.binding.version&&hex(e.delivery.inputSha256,64)&&hex(e.delivery.outputSha256,64),'Teslim sürümü veya özeti geçersiz.');
 canonicalProofPlanRequest(e.task);return e;
}
export async function verifyPublicChainBinding(e,{fetcher=globalThis.fetch}={}){
 validatePublicEvidence(e);
 const policy=chainPolicyFor(e.binding.contractId);
 async function rpc(method,params){
  const r=await fetcher(RPC,{method:'POST',redirect:'error',signal:AbortSignal.timeout(20000),headers:{'content-type':'application/json'},body:JSON.stringify({jsonrpc:'2.0',id:'nope-public-proof',method,params})});
  const j=await boundedPublicJSON(r,2*1024*1024);check(!j.error&&j.result!==undefined,'Testnet kaydı bağımsız olarak sorgulanamadı.');return j.result;
 }
 check((await rpc('status',[])).chain_id===policy.network,'Yanlış ağ.');
 const account=await rpc('query',{request_type:'view_account',account_id:policy.contractId,finality:'final'});
 check(account.code_hash===policy.codeHash&&typeof account.block_hash==='string','Sözleşme kodu sabit doğrulama politikasıyla eşleşmiyor.');
 const walletFunded=['NOPE:WALLET-ESCROW:V1:testnet','NOPE:WALLET-ESCROW:V2:testnet'].includes(policy.domain);
 if(walletFunded&&policy.requireKeyless){
  const keys=await rpc('query',{request_type:'view_access_key_list',account_id:policy.contractId,block_id:account.block_hash});
  check(keys.block_hash===account.block_hash&&Array.isArray(keys.keys)&&keys.keys.length===0,'Sözleşme kodu sabit doğrulama politikasıyla eşleşmiyor.');
 }
 if(walletFunded)check(walletAccount(e.walletBuyerAccount),'Kanıt iş veya sözleşme bağlamıyla eşleşmiyor.');
 const args=btoa(JSON.stringify({job_id:e.jobId,...(walletFunded?{buyer_account:e.walletBuyerAccount}:{})}));
 const view=await rpc('query',{request_type:'call_function',account_id:policy.contractId,method_name:'get_hold',args_base64:args,block_id:account.block_hash});
 check(view.block_hash===account.block_hash&&Array.isArray(view.result)&&view.result.length<=16384&&view.result.every(x=>Number.isInteger(x)&&x>=0&&x<256),'Kesinleşmiş sözleşme kaydı geçersiz.');
 const hold=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(Uint8Array.from(view.result))),t=hold?.terms;
 if(policy.domain==='NOPE:WALLET-ESCROW:V2:testnet')check(policy.storageDepositYocto==='40960000000000000000000'&&hold?.storage_deposit_yocto===policy.storageDepositYocto,'Kalıcı kayıt depolama bedeli sabit politikayla eşleşmiyor.');
 const inputHash=await sha256(canonicalProofPlanRequest(e.task)),programHash=await hashProofPlanProgram(e.task.task.plan),planHash=await hashPlan(e.task.task.plan),outputHash=await hashPlanOutput(e.delivery.outputs);
 check(t&&t.job_id===e.jobId&&t.buyer_commitment===e.task.proofManifest.context.buyerCommitment&&t.provider===e.binding.provider&&t.amount===e.binding.amountYocto&&
  t.input_hash===inputHash&&t.program_hash===programHash&&t.plan_hash===planHash,'Zincirdeki ön taahhüt, şifreli girdi veya program farklı.');
 check(e.delivery.inputSha256===inputHash&&e.delivery.programSha256===programHash&&e.delivery.outputSha256===outputHash,'Teslim edilen şifreli veri değiştirilmiş.');
 check(hold.delivery?.version===e.delivery.version&&hold.delivery.output_hash===outputHash&&['Delivered','PayoutPending','Paid','Refunded'].includes(hold.state),'Son teslim sürümü zincirde kayıtlı değil veya farklı.');
 for(const k of ['execution_deadline_ns','review_deadline_ns'])check(typeof t[k]==='string'&&/^[1-9][0-9]{0,19}$/.test(t[k]),'Sözleşme zamanı geçersiz.');
 if(walletFunded)check(t.buyer_account===e.walletBuyerAccount,'Kanıt iş veya sözleşme bağlamıyla eşleşmiyor.');
 const bindingHash=await sha256(JSON.stringify([walletFunded?policy.domain:'NOPE:WORKSPACE-ESCROW:V1:testnet',policy.contractId,t.job_id,t.buyer_commitment,...(walletFunded?[t.buyer_account]:[]),t.provider,t.amount,t.input_hash,t.program_hash,t.plan_hash,t.execution_deadline_ns,t.review_deadline_ns]));
 check(hold.binding_hash===bindingHash&&e.binding.bindingHash===bindingHash,'Escrow bağ özeti eşleşmiyor.');
 return{network:'testnet',contractId:policy.contractId,codeHash:policy.codeHash,blockHash:account.block_hash,
  inputSha256:inputHash,programSha256:programHash,planSha256:planHash,outputSha256:outputHash,version:e.delivery.version,bindingHash,escrowState:hold.state,...(policy.storageDepositYocto?{storageDepositYocto:policy.storageDepositYocto,totalFundingYocto:(BigInt(t.amount)+BigInt(policy.storageDepositYocto)).toString(),storageDepositRefundable:false}:{})};
}
