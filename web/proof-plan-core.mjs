/** Public v4 precommitment/result bindings. Ciphertexts + public commitments only.
 * Actual Poseidon2/SNARK functions belong to the independently pinned runtime. */
import {PROFILE as BASE_PROFILE,normalizePlan,estimatePlan,validatePlanRequest,canonicalPlanRequest,
  hashPlan,hashPlanRequest,hashPlanProgram,canonicalPlanOutput,hashPlanOutput,freezePlanData,MAX_PLAN_REQUEST_BYTES} from './plan-core.mjs';
import {compileRecipe,exactKeys,denseArray,validHash,nonceBytes} from './recipe-core.mjs';
import {sha256} from './gc-core.mjs';
import {proofPolicy,policyHash} from '../proof-runtime/policy.mjs';
import {APPROVED} from '../proof-runtime/approved.mjs';
export {proofPolicy,policyHash as proofPolicyHash} from '../proof-runtime/policy.mjs';
export const PROFILE='nope-csv-proof-plan-gc-v4';
export const SCHEME='nope-result-noir-poseidon2-v1';
export const DOMAIN='NOPE:PROOF-PLAN:V4';
export const MAX_ROW_PROOFS=40;
export const MAX_PROOF_BUNDLE_BYTES=1024*1024-1024;
export const PROOF_PLAN_LIMITS=freezePlanData({maxRowProofs:MAX_ROW_PROOFS,maxProofBundleBytes:MAX_PROOF_BUNDLE_BYTES,proofBytes:{number:APPROVED.circuits.number.proofBytes,text:APPROVED.circuits.text.proofBytes}});
export const FIELD_MODULUS=21888242871839275222246405745257275088548364400416034343698204186575808495617n;
const CONTEXT_KEYS=['domain','network','jobId','buyerCommitment','contractId','policyHash','baseRequestSha256','planSha256','baseProgramSha256','programSha256','nonce','rowCount'];
const ROW_KEYS=['column','row','type','preContext','inputPairRoot','outputPairRoot','inputSelectedRoot'];
const RESULT_KEYS=['profile','nonce','rowCount','outputs','inputSha256','outputSha256','programSha256'];
const bad=m=>{throw new Error(m);};
const check=(v,m)=>{if(!v)bad(m);};
const hex=(v,n)=>typeof v==='string'&&new RegExp(`^[0-9a-f]{${n}}$`).test(v);
const namedAccount=v=>typeof v==='string'&&v.length<=64&&/^[a-z0-9]+(?:[-_][a-z0-9]+)*(?:\.[a-z0-9]+(?:[-_][a-z0-9]+)*)*\.testnet$/.test(v);
const providerAccount=v=>namedAccount(v)||hex(v,64);
const field=v=>typeof v==='string'&&/^(0|[1-9][0-9]{0,76})$/.test(v)&&BigInt(v)<FIELD_MODULUS;
const bytes=s=>new TextEncoder().encode(s).length;
const equal=(a,b)=>JSON.stringify(a)===JSON.stringify(b);
const optionalKeys=(value,required,optional)=>{
 check(value&&typeof value==='object'&&!Array.isArray(value),'Expected options object.');
 const keys=Object.keys(value);exactKeys(value,keys);
 check(required.every(k=>keys.includes(k))&&keys.every(k=>required.includes(k)||optional.includes(k)),'Unexpected options fields.');
};
export async function proofRuntime(){
 const sdk=await import('../proof-runtime/sdk.mjs');
 check(['commitRow','selectedRoot','makeStatement'].every(k=>typeof sdk[k]==='function'),'Actual proof runtime unavailable.');
 return sdk;
}
function contextObject(task,c){
 exactKeys(c,CONTEXT_KEYS);
 check(c.domain===DOMAIN&&c.network==='testnet'&&hex(c.jobId,32),'Invalid v4 job context.');
 check(validHash(c.policyHash)&&c.policyHash===policyHash&&proofPolicy.id===SCHEME,'Unapproved proof policy.');
 check(c.buyerCommitment===null||validHash(c.buyerCommitment),'Invalid buyer commitment.');
 check(c.contractId===null||namedAccount(c.contractId),'Invalid proof contract.');
 for(const k of ['baseRequestSha256','planSha256','baseProgramSha256','programSha256'])check(validHash(c[k]),'Invalid proof-context digest.');
 nonceBytes(c.nonce);
 check(c.nonce===task.nonce&&c.rowCount===task.rowCount&&c.planSha256===task.planSha256,'Proof-context task mismatch.');
 return Object.fromEntries(CONTEXT_KEYS.map(k=>[k,c[k]]));
}
function manifestObject(task,m){
 exactKeys(m,['version','scheme','context','rows']);
 check(m.version===1&&m.scheme===SCHEME,'Unsupported proof manifest.');
 const context=contextObject(task,m.context),plan=normalizePlan(task.plan);
 check(plan.steps.length*task.rowCount<=MAX_ROW_PROOFS,'Proof plan exceeds 40 row-proof budget.');
 denseArray(m.rows,plan.steps.length*task.rowCount);
 const rows=[];
 for(let columnIndex=0;columnIndex<plan.steps.length;columnIndex++){
  const step=plan.steps[columnIndex];
  for(let row=0;row<task.rowCount;row++){
   const r=m.rows[rows.length];exactKeys(r,ROW_KEYS);
   check(r.column===step.column&&r.row===row&&r.type===step.recipe.type,'Proof row order/type mismatch.');
   check(validHash(r.preContext),'Invalid row context.');
   for(const k of ['inputPairRoot','outputPairRoot','inputSelectedRoot'])check(field(r[k]),'Invalid proof field.');
   rows.push(Object.fromEntries(ROW_KEYS.map(k=>[k,r[k]])));
  }
 }
 return{version:1,scheme:SCHEME,context,rows};
}
export function validateProofPlanRequest(request){
 exactKeys(request,['profile','task','proofManifest']);check(request.profile===PROFILE,'Invalid proof-plan profile.');
 const base=validatePlanRequest(request.task),manifest=manifestObject(request.task,request.proofManifest);
 const canonical=JSON.stringify({profile:PROFILE,task:JSON.parse(canonicalPlanRequest(request.task)),proofManifest:manifest});
 check(bytes(canonical)<MAX_PLAN_REQUEST_BYTES,'Proof plan exceeds total request budget.');
 return{...base,manifest};
}
export function canonicalProofPlanRequest(request){
 const {manifest}=validateProofPlanRequest(request);
 return JSON.stringify({profile:PROFILE,task:JSON.parse(canonicalPlanRequest(request.task)),proofManifest:manifest});
}
const snapshot=request=>JSON.parse(canonicalProofPlanRequest(request));
export function canonicalProofManifest(request){validateProofPlanRequest(request);return JSON.stringify(manifestObject(request.task,request.proofManifest));}
export const hashProofManifest=request=>sha256(canonicalProofManifest(request));
export async function hashProofPlanProgram(plan){
 plan=normalizePlan(plan);
 const canonicalPolicy=JSON.stringify(proofPolicy,(_,x)=>x&&typeof x==='object'&&!Array.isArray(x)?Object.fromEntries(Object.keys(x).sort().map(k=>[k,x[k]])):x);
 check(validHash(policyHash)&&proofPolicy.id===SCHEME&&await sha256(canonicalPolicy)===policyHash,'Approved proof policy metadata hash mismatch.');
 const baseProgramSha256=await hashPlanProgram(plan);
 return sha256(JSON.stringify({profile:PROFILE,scheme:SCHEME,version:1,policyHash,baseProgramSha256}));
}
export function normalizeProofPlanOptions(options){
 optionalKeys(options,['jobId'],['buyerCommitment','contractId']);
 check(hex(options.jobId,32),'Invalid proof job ID.');
 check(options.buyerCommitment==null||validHash(options.buyerCommitment),'Invalid buyer commitment.');
 check(options.contractId==null||namedAccount(options.contractId),'Invalid proof contract.');
 return{jobId:options.jobId,buyerCommitment:options.buyerCommitment??null,contractId:options.contractId??null};
}
export function estimateProofPlan(plan,rowCount,options){
 plan=normalizePlan(plan);options=normalizeProofPlanOptions(options);
 const rowProofCount=plan.steps.length*rowCount;
 check(Number.isInteger(rowCount)&&rowCount>0&&rowProofCount<=MAX_ROW_PROOFS,'Proof plan exceeds 40 row-proof budget.');
 const base=estimatePlan(plan,rowCount),zero='0'.repeat(64),rows=[],proofRows=[];
 for(const step of plan.steps)for(let row=0;row<rowCount;row++){
  rows.push({column:step.column,row,type:step.recipe.type,preContext:zero,inputPairRoot:'1'.repeat(77),outputPairRoot:'1'.repeat(77),inputSelectedRoot:'1'.repeat(77)});
  const a=APPROVED.circuits[step.recipe.type],policy=proofPolicy.circuits[step.recipe.type];
  check(Number.isSafeInteger(a.proofBytes)&&a.proofBytes>0&&a.proofBytes<MAX_PROOF_BUNDLE_BYTES,'Invalid approved proof byte bound.');
  // Largest legal decimal fields, exact approved base64 byte-length and all JSON
  // keys/row coordinates. Conservative even though many ABI fields are smaller.
  proofRows.push({column:step.column,row,proof:{version:1,scheme:SCHEME,type:step.recipe.type,circuitSha256:policy.circuitSha256,verificationKeySha256:policy.verificationKeySha256,
   proof:'A'.repeat(4*Math.ceil(a.proofBytes/3)),publicInputs:Array(28).fill('1'.repeat(77))}});
 }
 const estimatedProofBundleBytes=bytes(JSON.stringify({version:1,scheme:SCHEME,finalContext:zero,rows:proofRows}));
 check(estimatedProofBundleBytes<MAX_PROOF_BUNDLE_BYTES,'Proof bundle exceeds publication byte budget.');
 const context={domain:DOMAIN,network:'testnet',...options,policyHash,baseRequestSha256:zero,planSha256:zero,baseProgramSha256:zero,programSha256:zero,nonce:'0'.repeat(32),rowCount};
 const manifest={version:1,scheme:SCHEME,context,rows};
 const serializedRequestBytes=base.serializedRequestBytes+bytes(JSON.stringify({profile:PROFILE,task:null,proofManifest:manifest}))-4;
 check(serializedRequestBytes<MAX_PLAN_REQUEST_BYTES,'Proof plan exceeds total request budget.');
 return{...base,serializedRequestBytes,rowProofCount,maxRowProofs:MAX_ROW_PROOFS,estimatedProofBundleBytes,maxProofBundleBytes:MAX_PROOF_BUNDLE_BYTES};
}
export async function createProofPlanContext(task,options){
 validatePlanRequest(task);options=normalizeProofPlanOptions(options);
 const c={domain:DOMAIN,network:'testnet',jobId:options.jobId,buyerCommitment:options.buyerCommitment??null,contractId:options.contractId??null,policyHash,
  baseRequestSha256:'0'.repeat(64),planSha256:task.planSha256,baseProgramSha256:'0'.repeat(64),programSha256:'0'.repeat(64),nonce:task.nonce,rowCount:task.rowCount};
 contextObject(task,c);task=JSON.parse(canonicalPlanRequest(task));
 [c.baseRequestSha256,c.planSha256,c.baseProgramSha256,c.programSha256]=await Promise.all([
  hashPlanRequest(task),hashPlan(task.plan),hashPlanProgram(task.plan),hashProofPlanProgram(task.plan)
 ]);
 check(task.planSha256===c.planSha256,'Plan hash mismatch.');
 return freezePlanData(c);
}
export function validateProofPlanContext(request,expected){
 validateProofPlanRequest(request);optionalKeys(expected,['jobId'],['buyerCommitment','contractId']);
 const c=request.proofManifest.context;
 check(hex(expected.jobId,32)&&c.jobId===expected.jobId,'Proof job mismatch.');
 if(c.buyerCommitment!==null||Object.hasOwn(expected,'buyerCommitment'))check((expected.buyerCommitment===null||validHash(expected.buyerCommitment))&&c.buyerCommitment===expected.buyerCommitment,'Proof buyer mismatch.');
 if(c.contractId!==null||Object.hasOwn(expected,'contractId'))check((expected.contractId===null||namedAccount(expected.contractId))&&c.contractId===expected.contractId,'Proof contract mismatch.');
 return true;
}
export async function proofPlanRowContext(task,context,columnIndex,row){
 validatePlanRequest(task);context=contextObject(task,context);
 check(Number.isInteger(columnIndex)&&columnIndex>=0&&columnIndex<task.plan.steps.length&&Number.isInteger(row)&&row>=0&&row<task.rowCount,'Invalid proof row coordinate.');
 const step=normalizePlan(task.plan).steps[columnIndex],compiled=compileRecipe(step.recipe);
 return sha256(JSON.stringify({domain:DOMAIN+'/row',context,columnIndex,column:step.column,row,type:step.recipe.type,recipe:step.recipe,
  nonce:task.tasks[columnIndex].request.nonce,inputCount:compiled.inputCount,outputBits:compiled.outputBits}));
}
export function proofPlanRows(request){
 request=snapshot(request);const rows=[];
 for(let columnIndex=0;columnIndex<request.task.plan.steps.length;columnIndex++){
  const step=request.task.plan.steps[columnIndex],compiled=compileRecipe(step.recipe);
  for(let row=0;row<request.task.rowCount;row++){
   const m=request.proofManifest.rows[rows.length];
   rows.push({...m,columnIndex,columnNumber:Number(step.column.slice(1)),recipe:step.recipe,inputCount:compiled.inputCount,outputBits:compiled.outputBits,inputLabels:request.task.tasks[columnIndex].request.rows[row].inputs});
  }
 }
 return freezePlanData(rows);
}
export async function verifyProofPlanBindings(value){
 const request=snapshot(value),c=request.proofManifest.context;
 const expected=await createProofPlanContext(request.task,{jobId:c.jobId,buyerCommitment:c.buyerCommitment,contractId:c.contractId});
 check(equal(c,expected),'Proof-context hash mismatch.');
 const sdk=await proofRuntime();
 for(const r of proofPlanRows(request)){
  const preContext=await proofPlanRowContext(request.task,c,r.columnIndex,r.row);
  check(preContext===r.preContext,'Proof row context mismatch.');
  const selected=await sdk.selectedRoot({role:'input',type:r.type,preContext,column:r.columnNumber,row:r.row,recipe:r.recipe,labels:r.inputLabels});
  check(field(selected)&&selected===r.inputSelectedRoot,'Actual input-selection commitment mismatch.');
 }
 return freezePlanData(request);
}
export async function hashProofPlanRequest(request){
 const checked=await verifyProofPlanBindings(request);
 return sha256(canonicalProofPlanRequest(checked));
}
export function validateProofPlanResult(result,request){
 exactKeys(result,RESULT_KEYS);validateProofPlanRequest(request);
 check(result.profile===PROFILE&&result.nonce===request.task.nonce&&result.rowCount===request.task.rowCount,'Proof result context mismatch.');
 for(const k of ['inputSha256','outputSha256','programSha256'])check(validHash(result[k]),'Invalid proof result hash.');
 canonicalPlanOutput(result.outputs);
 denseArray(result.outputs,request.task.plan.steps.length);
 for(let i=0;i<result.outputs.length;i++){
  const out=result.outputs[i],step=request.task.plan.steps[i];
  check(out.column===step.column,'Output column order mismatch.');denseArray(out.outputs,request.task.rowCount);
  for(const row of out.outputs)denseArray(row,compileRecipe(step.recipe).outputBits);
 }
 return result;
}
export async function wrapProofPlanResult(value,baseResult){
 const requestSnapshot=snapshot(value);exactKeys(baseResult,RESULT_KEYS);
 const pending={...baseResult,profile:PROFILE};validateProofPlanResult(pending,requestSnapshot);
 baseResult=JSON.parse(JSON.stringify(baseResult));
 const request=await verifyProofPlanBindings(requestSnapshot);
 check(baseResult.profile===BASE_PROFILE&&baseResult.nonce===request.task.nonce&&baseResult.rowCount===request.task.rowCount,'Actual base result mismatch.');
 // Validate all public data before snapshotting or awaiting any output hashes.
 const out={...baseResult,profile:PROFILE};validateProofPlanResult(out,request);
 const result=JSON.parse(JSON.stringify(baseResult)),c=request.proofManifest.context;
 check(result.inputSha256===c.baseRequestSha256&&result.programSha256===c.baseProgramSha256,'Actual base evaluator binding mismatch.');
 check(result.outputSha256===await hashPlanOutput(result.outputs),'Actual output hash mismatch.');
 return freezePlanData({...result,profile:PROFILE,inputSha256:await sha256(canonicalProofPlanRequest(request)),programSha256:c.programSha256});
}
function deliveryObject(delivery,request,binding){
 optionalKeys(delivery,RESULT_KEYS,['version','deliveredAt']);
 if(Object.hasOwn(delivery,'version'))check(delivery.version===binding.version,'Delivery revision mismatch.');
 if(Object.hasOwn(delivery,'deliveredAt'))check(typeof delivery.deliveredAt==='string'&&Number.isFinite(Date.parse(delivery.deliveredAt)),'Invalid delivery time.');
 const r=Object.fromEntries(RESULT_KEYS.map(k=>[k,delivery[k]]));validateProofPlanResult(r,request);return JSON.parse(JSON.stringify(r));
}
function bindingObject(binding,request){
 exactKeys(binding,['jobId','version','contractId','bindingHash','provider','amountYocto']);
 check(hex(binding.jobId,32)&&binding.jobId===request.proofManifest.context.jobId,'Final proof job mismatch.');
 check(Number.isInteger(binding.version)&&binding.version>0&&binding.version<=0xffffffff,'Invalid delivery version.');
 check(namedAccount(binding.contractId)&&validHash(binding.bindingHash)&&providerAccount(binding.provider)&&binding.provider!==binding.contractId,'Invalid final escrow context.');
 // The canonical decimal price is committed by finalContext, not interpreted as
 // a circuit field. Match the wallet escrow's exact 1 yocto..1 testNEAR range.
 check(typeof binding.amountYocto==='string'&&/^[1-9][0-9]{0,24}$/.exec(binding.amountYocto)?.[0]===binding.amountYocto&&BigInt(binding.amountYocto)>=1n&&BigInt(binding.amountYocto)<=10n**24n,'Invalid selected proof price.');
 const c=request.proofManifest.context;if(c.contractId!==null)check(c.contractId===binding.contractId,'Final contract mismatch.');
 return{...binding};
}
async function finalData(value,delivery,expected){
 const requestSnapshot=snapshot(value),binding=bindingObject(expected,requestSnapshot),result=deliveryObject(delivery,requestSnapshot,binding);
 const request=await verifyProofPlanBindings(requestSnapshot);
 const requestSha256=await sha256(canonicalProofPlanRequest(request)),c=request.proofManifest.context;
 check(result.inputSha256===requestSha256&&result.programSha256===c.programSha256,'Outer delivery binding mismatch.');
 const outputSha256=await hashPlanOutput(result.outputs);check(outputSha256===result.outputSha256,'Actual delivered output hash mismatch.');
 const context={domain:DOMAIN+'/delivery',version:1,network:'testnet',jobId:binding.jobId,requestSha256,baseRequestSha256:c.baseRequestSha256,
  programSha256:c.programSha256,planSha256:c.planSha256,manifestSha256:await hashProofManifest(request),deliveryVersion:binding.version,outputSha256,
  contractId:binding.contractId,escrowBindingHash:binding.bindingHash,selectedProvider:binding.provider,amountYocto:binding.amountYocto};
 return{request,result,binding,finalContext:await sha256(JSON.stringify(context))};
}
export async function finalProofContext(request,delivery,binding){return(await finalData(request,delivery,binding)).finalContext;}
export async function makeProofStatements(value,delivery,expected){
 const {request,result,finalContext}=await finalData(value,delivery,expected),sdk=await proofRuntime(),rows=[];
 for(const r of proofPlanRows(request)){
  const statement=await sdk.makeStatement({type:r.type,preContext:r.preContext,finalContext,column:r.columnNumber,row:r.row,recipe:r.recipe,
   inputPairRoot:r.inputPairRoot,outputPairRoot:r.outputPairRoot,inputLabels:r.inputLabels,outputLabels:result.outputs[r.columnIndex].outputs[r.row]});
  check(statement&&statement.inputSelectedRoot===r.inputSelectedRoot,'Statement input root mismatch.');
  rows.push({column:r.column,row:r.row,statement});
 }
 return freezePlanData({finalContext,rows});
}


const PROOF_KEYS=['version','scheme','type','circuitSha256','verificationKeySha256','proof','publicInputs'];
function publicProofObject(p){
 exactKeys(p,PROOF_KEYS);
 check(p.version===1&&p.scheme===SCHEME&&['number','text'].includes(p.type),'Invalid row proof profile.');
 const approved=proofPolicy.circuits[p.type];
 check(p.circuitSha256===approved.circuitSha256&&p.verificationKeySha256===approved.verificationKeySha256,'Unapproved proof artifact/key.');
 check(typeof p.proof==='string'&&p.proof.length===4*Math.ceil(APPROVED.circuits[p.type].proofBytes/3)&&/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(p.proof),'Invalid proof encoding.');
 denseArray(p.publicInputs,28);for(const x of p.publicInputs)check(field(x),'Invalid public proof input.');
 return Object.fromEntries(PROOF_KEYS.map(k=>[k,k==='publicInputs'?[...p[k]]:p[k]]));
}
export function canonicalProofPlanBundle(bundle){
 exactKeys(bundle,['version','scheme','finalContext','rows']);
 check(bundle.version===1&&bundle.scheme===SCHEME&&validHash(bundle.finalContext),'Invalid proof bundle.');
 check(Array.isArray(bundle.rows)&&bundle.rows.length>=1&&bundle.rows.length<=MAX_ROW_PROOFS,'Invalid proof coverage.');denseArray(bundle.rows,bundle.rows.length);
 const rows=bundle.rows.map(r=>{
  exactKeys(r,['column','row','proof']);
  check(typeof r.column==='string'&&/^C(?:[1-9]|1[0-6])$/.test(r.column)&&Number.isInteger(r.row)&&r.row>=0&&r.row<32,'Invalid proof row coordinate.');
  return{column:r.column,row:r.row,proof:publicProofObject(r.proof)};
 });
 const text=JSON.stringify({version:1,scheme:SCHEME,finalContext:bundle.finalContext,rows});
 check(bytes(text)<MAX_PROOF_BUNDLE_BYTES,'Proof bundle exceeds byte budget.');return text;
}
/** Expected binding must be derived from authenticated job/RPC state by caller.
 * Returns true ONLY after every actual proof verifies against expected signals. */
export async function verifyProofPlanBundle(args){
 optionalKeys(args,['request','delivery','binding','bundle'],['onProgress']);
 check(args.onProgress===undefined||typeof args.onProgress==='function','Invalid proof progress callback.');
 let bundle;try{bundle=JSON.parse(canonicalProofPlanBundle(args.bundle));}catch{return false;}
 const expected=await makeProofStatements(args.request,args.delivery,args.binding);
 if(bundle.finalContext!==expected.finalContext||bundle.rows.length!==expected.rows.length)return false;
 for(let i=0;i<expected.rows.length;i++){
  const r=expected.rows[i],b=bundle.rows[i];
  if(r.column!==b.column||r.row!==b.row||b.proof.type!==r.statement.type||!equal(b.proof.publicInputs,r.statement.publicInputs))return false;
 }
 const sdk=await proofRuntime(),total=expected.rows.length;
 for(let i=0;i<total;i++){
  const verified=await sdk.verifyRow({statement:expected.rows[i].statement,proof:bundle.rows[i].proof});
  if(args.onProgress)args.onProgress({completed:i+1,total});
  if(verified!==true)return false;
 }
 return true;
}
