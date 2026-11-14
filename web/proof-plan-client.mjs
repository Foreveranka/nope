/** Client-local v4 preparation/decoding. Only returnValue.request is publishable.
 * No prover witness, pair alternatives or private salt enters an evaluator task. */
import {PROFILE,SCHEME,normalizeProofPlanOptions,estimateProofPlan,createProofPlanContext,proofPlanRowContext,
  proofRuntime,verifyProofPlanBindings,canonicalProofPlanRequest,hashProofPlanRequest,validateProofPlanResult,validateProofPlanRequest,makeProofStatements,canonicalProofPlanBundle,proofPlanRows} from './proof-plan-core.mjs';
import {PROFILE as BASE_PROFILE,normalizePlan,hashPlan,hashPlanRequest,hashPlanProgram,freezePlanData} from './plan-core.mjs';
import {compileRecipe,encodeRecipeValues,exactKeys,denseArray,cryptoProvider,fromBase64} from './recipe-core.mjs';
import {prepareRecipeProof} from './recipe-client.mjs';
import {decodePlan} from './plan-client.mjs';
import {sha256} from './gc-core.mjs';
const check=(v,m)=>{if(!v)throw new Error(m);};
const randomHex=n=>Array.from(cryptoProvider().getRandomValues(new Uint8Array(n)),b=>b.toString(16).padStart(2,'0')).join('');

export async function prepareProofPlan(valuesByColumn,plan,options){
 plan=normalizePlan(plan);options=normalizeProofPlanOptions(options);
 exactKeys(valuesByColumn,plan.steps.map(s=>s.column));
 const first=valuesByColumn[plan.steps[0].column];check(Array.isArray(first),'Expected column value arrays.');
 const rowCount=first.length;estimateProofPlan(plan,rowCount,options);
 // Complete every preflight before random generation, hashing, runtime startup or
 // garbling. Take private primitive snapshots so caller mutation cannot change it.
 const values=plan.steps.map(({column,recipe})=>{
  const value=valuesByColumn[column];denseArray(value,rowCount);encodeRecipeValues(value,recipe);return Array.from(value);
 });
 const sdk=await proofRuntime(),nonce=randomHex(16),tasks=[],decoderTasks=[],captured=[],nonces=new Set([nonce]);
 for(let i=0;i<plan.steps.length;i++){
  const step=plan.steps[i],p=await prepareRecipeProof(values[i],step.recipe);
  check(!nonces.has(p.request.nonce),'Random nonce collision.');nonces.add(p.request.nonce);
  tasks.push({column:step.column,request:p.request});decoderTasks.push({column:step.column,decoder:p.decoder});captured.push(p.witness);
 }
 const planSha256=await hashPlan(plan),baseProgramSha256=await hashPlanProgram(plan);
 const task=freezePlanData({profile:BASE_PROFILE,plan,planSha256,nonce,rowCount,tasks});
 const context=await createProofPlanContext(task,options),rows=[],witnessRows=[];
 for(let i=0;i<plan.steps.length;i++){
  const step=plan.steps[i],compiled=compileRecipe(step.recipe);
  for(let row=0;row<rowCount;row++){
   const preContext=await proofPlanRowContext(task,context,i,row),inputSalt=randomHex(32),outputSalt=randomHex(32);
   const inputPairs=captured[i].inputPairs[row],outputPairs=captured[i].outputPairs[row];
   denseArray(inputPairs,compiled.inputCount);denseArray(outputPairs,compiled.outputBits);
   const header={type:step.recipe.type,preContext,column:Number(step.column.slice(1)),row,recipe:step.recipe};
   const pairRoots=await sdk.commitRow({...header,inputPairs,outputPairs,inputSalt,outputSalt});
   const inputSelectedRoot=await sdk.selectedRoot({...header,role:'input',labels:task.tasks[i].request.rows[row].inputs});
   rows.push({column:step.column,row,type:step.recipe.type,preContext,inputPairRoot:pairRoots.inputPairRoot,outputPairRoot:pairRoots.outputPairRoot,inputSelectedRoot});
   witnessRows.push({column:step.column,row,inputPairs,outputPairs,inputSalt,outputSalt});
  }
 }
 const request=freezePlanData({profile:PROFILE,task,proofManifest:{version:1,scheme:SCHEME,context,rows}});
 const baseRequestSha256=await hashPlanRequest(task),inputSha256=await hashProofPlanRequest(request);
 const taskDecoder=freezePlanData({profile:BASE_PROFILE,plan,planSha256,nonce,rowCount,inputSha256:baseRequestSha256,programSha256:baseProgramSha256,tasks:decoderTasks});
 return{request,decoder:freezePlanData({profile:PROFILE,request,taskDecoder}),
  witness:freezePlanData({version:1,jobId:options.jobId,baseRequestSha256,inputSha256,rows:witnessRows})};
}

export async function decodeProofPlan(result,decoder){
 exactKeys(decoder,['profile','request','taskDecoder']);check(decoder.profile===PROFILE,'Invalid private proof decoder.');
 validateProofPlanResult(result,decoder.request);
 const r=JSON.parse(JSON.stringify(result)),requestSnapshot=JSON.parse(canonicalProofPlanRequest(decoder.request)),taskDecoder=decoder.taskDecoder;
 const request=await verifyProofPlanBindings(requestSnapshot),c=request.proofManifest.context;
 check(r.inputSha256===await sha256(canonicalProofPlanRequest(request))&&r.programSha256===c.programSha256,'Proof result outer binding mismatch.');
 // Existing v3/v2 decoder validates its own exact private schema and all actual
 // per-wire memberships. A v4 proof claim is not invented by local decoding.
 return decodePlan({...r,profile:BASE_PROFILE,inputSha256:c.baseRequestSha256,programSha256:c.baseProgramSha256},taskDecoder);
}


function localWitnessSnapshot(witness,request){
 exactKeys(witness,['version','jobId','baseRequestSha256','inputSha256','rows']);
 check(witness.version===1&&witness.jobId===request.proofManifest.context.jobId&&witness.baseRequestSha256===request.proofManifest.context.baseRequestSha256,'Private witness context mismatch.');
 check(typeof witness.inputSha256==='string'&&/^[0-9a-f]{64}$/.test(witness.inputSha256),'Invalid private witness digest.');
 const rows=proofPlanRows(request);denseArray(witness.rows,rows.length);
 for(let i=0;i<rows.length;i++){
  const w=witness.rows[i],r=rows[i];exactKeys(w,['column','row','inputPairs','outputPairs','inputSalt','outputSalt']);
  check(w.column===r.column&&w.row===r.row,'Private witness row order mismatch.');
  for(const k of ['inputSalt','outputSalt'])check(typeof w[k]==='string'&&/^[0-9a-f]{64}$/.test(w[k]),'Invalid private proof salt.');
  for(const [key,count] of [['inputPairs',r.inputCount],['outputPairs',r.outputBits]]){
   denseArray(w[key],count);
   for(const pair of w[key]){denseArray(pair,2);const a=fromBase64(pair[0]),b=fromBase64(pair[1]);check((a[15]&1)!==(b[15]&1),'Invalid private label pair.');}
  }
 }
 return JSON.parse(JSON.stringify(witness));
}
/** Buyer-local proof generation. Public bundle contains no private witness or
 * decoder. onProgress fires only after an actual row proof has completed. */
export async function proveProofPlan(args){
 const keys=Object.keys(args??{});exactKeys(args,keys);
 check(['request','delivery','binding','witness'].every(k=>keys.includes(k))&&keys.every(k=>['request','delivery','binding','witness','onProgress'].includes(k)),'Invalid proof generation arguments.');
 check(args.onProgress===undefined||typeof args.onProgress==='function','Invalid proof progress callback.');
 validateProofPlanRequest(args.request);const request=JSON.parse(canonicalProofPlanRequest(args.request)),witness=localWitnessSnapshot(args.witness,request);
 const expected=await makeProofStatements(request,args.delivery,args.binding);
 check(witness.inputSha256===await sha256(canonicalProofPlanRequest(request)),'Private witness request mismatch.');
 const sdk=await proofRuntime(),rows=[],total=expected.rows.length;
 for(let i=0;i<total;i++){
  const row=expected.rows[i],w=witness.rows[i],statement=row.statement;
  const privateRow={inputPairs:w.inputPairs,outputPairs:w.outputPairs,inputSalt:w.inputSalt,outputSalt:w.outputSalt};
  const roots=await sdk.commitRow({...statement,...privateRow});
  check(roots.inputPairRoot===statement.inputPairRoot&&roots.outputPairRoot===statement.outputPairRoot,'Private pairs differ from anchored commitments.');
  const proof=await sdk.proveRow({statement,witness:privateRow});
  rows.push({column:row.column,row:row.row,proof});
  if(args.onProgress)args.onProgress({completed:i+1,total});
 }
 const bundle={version:1,scheme:SCHEME,finalContext:expected.finalContext,rows};
 // Enforce the exact public schema again so no SDK/internal witness fields escape.
 return freezePlanData(JSON.parse(canonicalProofPlanBundle(bundle)));
}
