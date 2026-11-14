/** Versioned multi-field record proofs. Values, pair alternatives and salts stay buyer-local. */
import {exactKeys,denseArray,validHash,nonceBytes} from './recipe-core.mjs';
import {sha256} from './gc-core.mjs';
import {normalizeRecordPlan,validateRecordRequest,canonicalRecordRequest,hashRecordRequest,hashRecordProgram,hashRecordPlan,hashRecordOutput,validateRecordResult} from './record-core.mjs';
import {proofPolicy,policyHash} from '../proof-runtime/record-policy.mjs';
import {APPROVED} from '../proof-runtime/record-approved.mjs';
export {proofPolicy,policyHash as proofPolicyHash};
export const PROFILE='nope-record-proof-gc-v5',SCHEME='nope-record-noir-poseidon2-v1',DOMAIN='NOPE:RECORD-PROOF:V5';
export const MAX_PROOF_BUNDLE_BYTES=1024*1024-1024;
const MAX_BYTES=3*1024*1024-16384;
const CKEYS=['domain','network','jobId','buyerCommitment','contractId','policyHash','baseRequestSha256','planSha256','baseProgramSha256','programSha256','nonce','rowCount'];
const RKEYS=['column','row','type','preContext','inputPairRoot','outputPairRoot','inputSelectedRoot'];
const RESULT=['profile','nonce','rowCount','outputs','inputSha256','outputSha256','programSha256'];
const check=(v,m='Invalid record proof binding')=>{if(!v)throw Error(m);};
const hex=(v,n)=>typeof v==='string'&&new RegExp(`^[0-9a-f]{${n}}$`).test(v);
const field=v=>typeof v==='string'&&/^(0|[1-9][0-9]{0,76})$/.test(v)&&BigInt(v)<21888242871839275222246405745257275088548364400416034343698204186575808495617n;
const account=v=>typeof v==='string'&&v.length>=8&&v.length<=64&&/^[a-z0-9]+(?:[-_][a-z0-9]+)*(?:\.[a-z0-9]+(?:[-_][a-z0-9]+)*)*\.testnet$/.test(v);
const textBytes=x=>new TextEncoder().encode(typeof x==='string'?x:JSON.stringify(x)).length;
/** Data-only snapshots before the first await. Never invoke accessors or accept
 * sparse/custom arrays while copying caller-owned proof parameters. */
export function recordDataSnapshot(value){
 const seen=new Set();
 function copy(v,depth){
  check(depth<=12,'Record proof data is too deep');
  if(v===null||typeof v==='string'||typeof v==='boolean')return v;
  if(typeof v==='number'){check(Number.isFinite(v));return v;}
  check(v&&typeof v==='object'&&!seen.has(v));seen.add(v);
  let result;
  if(Array.isArray(v)){denseArray(v,v.length);result=Array.from({length:v.length},(_,i)=>copy(Object.getOwnPropertyDescriptor(v,String(i)).value,depth+1));}
  else {const keys=Reflect.ownKeys(v);check(keys.every(k=>typeof k==='string'));exactKeys(v,keys);result=Object.fromEntries(keys.map(k=>[k,copy(Object.getOwnPropertyDescriptor(v,k).value,depth+1)]));}
  seen.delete(v);return result;
 }
 return copy(value,0);
}
export async function proofRuntime(){return import('../proof-runtime/record-sdk.mjs');}
export async function hashProofPlanProgram(plan){return sha256(JSON.stringify({profile:PROFILE,scheme:SCHEME,policyHash,baseProgramSha256:await hashRecordProgram(normalizeRecordPlan(plan))}));}
export function normalizeProofPlanOptions(o){exactKeys(o,['jobId','buyerCommitment','contractId']);check(hex(o.jobId,32)&&validHash(o.buyerCommitment)&&account(o.contractId));return {...o};}
export async function createProofPlanContext(task,options){
 task=JSON.parse(canonicalRecordRequest(task));options=normalizeProofPlanOptions(options);check(task.planSha256===await hashRecordPlan(task.plan)&&task.programSha256===await hashRecordProgram(task.plan));
 return {domain:DOMAIN,network:'testnet',...options,policyHash,baseRequestSha256:await hashRecordRequest(task),planSha256:task.planSha256,
  baseProgramSha256:await hashRecordProgram(task.plan),programSha256:await hashProofPlanProgram(task.plan),nonce:task.nonce,rowCount:task.rowCount};
}
function contextObject(task,c){
 exactKeys(c,CKEYS);normalizeProofPlanOptions({jobId:c.jobId,buyerCommitment:c.buyerCommitment,contractId:c.contractId});
 check(c.domain===DOMAIN&&c.network==='testnet'&&c.policyHash===policyHash&&c.nonce===task.nonce&&c.rowCount===task.rowCount&&c.planSha256===task.planSha256);
 for(const k of ['baseRequestSha256','planSha256','baseProgramSha256','programSha256'])check(validHash(c[k]));
 nonceBytes(c.nonce);return Object.fromEntries(CKEYS.map(k=>[k,c[k]]));
}
export function validateProofPlanRequest(request){
 exactKeys(request,['profile','task','proofManifest']);check(request.profile===PROFILE);validateRecordRequest(request.task);
 const m=request.proofManifest;exactKeys(m,['version','scheme','context','rows']);check(m.version===1&&m.scheme===SCHEME);contextObject(request.task,m.context);
 denseArray(m.rows,request.task.rowCount);
 m.rows.forEach((r,i)=>{exactKeys(r,RKEYS);check(r.column==='C1'&&r.row===i&&r.type==='record'&&validHash(r.preContext));for(const k of ['inputPairRoot','outputPairRoot','inputSelectedRoot'])check(field(r[k]));});
 check(textBytes(request)<MAX_BYTES,'Record proof request exceeds total byte budget');
 return {plan:normalizeRecordPlan(request.task.plan),manifest:m,rowCount:request.task.rowCount};
}
export function canonicalProofPlanRequest(request){validateProofPlanRequest(request);return JSON.stringify({profile:PROFILE,task:JSON.parse(canonicalRecordRequest(request.task)),proofManifest:request.proofManifest});}
const snapshot=r=>JSON.parse(canonicalProofPlanRequest(r));
export const hashProofManifest=r=>{validateProofPlanRequest(r);return sha256(JSON.stringify(r.proofManifest));};
export async function proofPlanRowContext(task,c,_columnIndex,row){
 validateRecordRequest(task);contextObject(task,c);check(_columnIndex===0&&Number.isInteger(row)&&row>=0&&row<task.rowCount);
 return sha256(JSON.stringify({domain:DOMAIN+'/row',context:c,columnIndex:0,column:'C1',row,type:'record',plan:normalizeRecordPlan(task.plan),nonce:task.nonce,inputCount:258,outputBits:128}));
}
export function validateProofPlanContext(request,expected){validateProofPlanRequest(request);const c=request.proofManifest.context;for(const k of Object.keys(expected)){check(['jobId','buyerCommitment','contractId'].includes(k)&&c[k]===expected[k]);}check(hex(expected.jobId,32));return true;}
export async function verifyProofPlanBindings(value){
 const r=snapshot(value),c=r.proofManifest.context,expected=await createProofPlanContext(r.task,{jobId:c.jobId,buyerCommitment:c.buyerCommitment,contractId:c.contractId});
 check(JSON.stringify(contextObject(r.task,c))===JSON.stringify(contextObject(r.task,expected)),'Record proof context digest mismatch');
 const sdk=await proofRuntime();
 for(const row of r.proofManifest.rows){
  check(row.preContext===await proofPlanRowContext(r.task,c,0,row.row));
  check(row.inputSelectedRoot===await sdk.selectedRoot({type:'record',preContext:row.preContext,column:1,row:row.row,plan:r.task.plan,role:'input',labels:r.task.rows[row.row].inputs}));
 }
 return r;
}
export const hashProofPlanRequest=async r=>sha256(canonicalProofPlanRequest(await verifyProofPlanBindings(r)));
export function validateProofPlanResult(result,request){
 exactKeys(result,RESULT);validateProofPlanRequest(request);check(result.profile===PROFILE&&result.nonce===request.task.nonce&&result.rowCount===request.task.rowCount&&validHash(result.inputSha256)&&validHash(result.outputSha256)&&result.programSha256===request.proofManifest.context.programSha256);
 // Validate typed encrypted outputs using the lower-layer exact schema.
 validateRecordResult({...result,profile:request.task.profile,inputSha256:request.proofManifest.context.baseRequestSha256,programSha256:request.proofManifest.context.baseProgramSha256},request.task);
 return result;
}
export async function wrapProofPlanResult(request,result){
 result=recordDataSnapshot(result);request=await verifyProofPlanBindings(request);validateRecordResult(result,request.task);
 check(result.inputSha256===request.proofManifest.context.baseRequestSha256&&result.outputSha256===await hashRecordOutput(result.outputs));
 return {...result,profile:PROFILE,inputSha256:await sha256(canonicalProofPlanRequest(request)),programSha256:request.proofManifest.context.programSha256};
}
export function proofPlanRows(request){request=snapshot(request);return request.proofManifest.rows.map(r=>({...r,columnIndex:0,columnNumber:1,plan:request.task.plan,inputCount:258,outputBits:128,inputLabels:request.task.rows[r.row].inputs}));}
function bindingObject(b,r){
 exactKeys(b,['jobId','version','contractId','bindingHash','provider','amountYocto']);
 check(b.jobId===r.proofManifest.context.jobId&&Number.isSafeInteger(b.version)&&b.version>0&&b.version<=0xffffffff&&b.contractId===r.proofManifest.context.contractId&&account(b.contractId)&&validHash(b.bindingHash));
 check((account(b.provider)||hex(b.provider,64))&&b.provider!==b.contractId);
 check(typeof b.amountYocto==='string'&&/^[1-9][0-9]{0,24}$/.test(b.amountYocto)&&BigInt(b.amountYocto)<=10n**24n);return {...b};
}
export async function makeProofStatements(value,delivery,expected){
 delivery=recordDataSnapshot(delivery);expected=recordDataSnapshot(expected);
 const r=await verifyProofPlanBindings(value),b=bindingObject(expected,r),keys=Object.keys(delivery);
 check(RESULT.every(k=>keys.includes(k))&&keys.every(k=>[...RESULT,'version','deliveredAt'].includes(k)));exactKeys(delivery,keys);
 if(delivery.version!==undefined)check(delivery.version===b.version);
 if(delivery.deliveredAt!==undefined)check(typeof delivery.deliveredAt==='string'&&Number.isFinite(Date.parse(delivery.deliveredAt)));
 const result=Object.fromEntries(RESULT.map(k=>[k,delivery[k]]));validateProofPlanResult(result,r);
 const requestSha256=await sha256(canonicalProofPlanRequest(r)),c=r.proofManifest.context;
 check(result.inputSha256===requestSha256&&result.outputSha256===await hashRecordOutput(result.outputs));
 const finalContext=await sha256(JSON.stringify({domain:DOMAIN+'/delivery',version:1,network:'testnet',jobId:b.jobId,requestSha256,baseRequestSha256:c.baseRequestSha256,programSha256:c.programSha256,planSha256:c.planSha256,manifestSha256:await hashProofManifest(r),deliveryVersion:b.version,outputSha256:result.outputSha256,contractId:b.contractId,escrowBindingHash:b.bindingHash,selectedProvider:b.provider,amountYocto:b.amountYocto}));
 const sdk=await proofRuntime(),rows=[];
 for(const row of proofPlanRows(r)){
  const statement=await sdk.makeStatement({type:'record',preContext:row.preContext,finalContext,column:1,row:row.row,plan:r.task.plan,inputPairRoot:row.inputPairRoot,outputPairRoot:row.outputPairRoot,inputLabels:row.inputLabels,outputLabels:result.outputs[row.row]});
  check(statement.inputSelectedRoot===row.inputSelectedRoot);rows.push({column:'C1',row:row.row,statement});
 }
 return {finalContext,rows};
}
export function canonicalProofPlanBundle(bundle){
 exactKeys(bundle,['version','scheme','finalContext','rows']);check(bundle.version===1&&bundle.scheme===SCHEME&&validHash(bundle.finalContext));check(Array.isArray(bundle.rows)&&bundle.rows.length>=1&&bundle.rows.length<=16);denseArray(bundle.rows,bundle.rows.length);
 for(const [i,r] of bundle.rows.entries()){
  exactKeys(r,['column','row','proof']);check(r.column==='C1'&&r.row===i);const p=r.proof;
  exactKeys(p,['version','scheme','type','circuitSha256','verificationKeySha256','proof','publicInputs']);
  check(p.version===1&&p.scheme===SCHEME&&p.type==='record'&&p.circuitSha256===APPROVED.circuits.record.circuitSha256&&p.verificationKeySha256===APPROVED.circuits.record.vkSha256);
  check(typeof p.proof==='string'&&p.proof.length===4*Math.ceil(APPROVED.circuits.record.proofBytes/3)&&/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(p.proof));denseArray(p.publicInputs,55);p.publicInputs.forEach(x=>check(field(x)));
 }
 const text=JSON.stringify(bundle);check(textBytes(text)<MAX_PROOF_BUNDLE_BYTES);return text;
}
export async function verifyProofPlanBundle({request,delivery,binding,bundle,onProgress}){
 try {
  bundle=JSON.parse(canonicalProofPlanBundle(bundle));const expected=await makeProofStatements(request,delivery,binding);if(bundle.finalContext!==expected.finalContext||bundle.rows.length!==expected.rows.length)return false;
  const sdk=await proofRuntime();
  for(let i=0;i<expected.rows.length;i++){
   const e=expected.rows[i],p=bundle.rows[i].proof;
   if(JSON.stringify(p.publicInputs)!==JSON.stringify(e.statement.publicInputs)||await sdk.verifyRow({statement:e.statement,proof:p})!==true)return false;
   onProgress?.({completed:i+1,total:expected.rows.length});
  }
  return true;
 }catch{return false;}
}
