/** Buyer-local record preparation/proving. Only request and public proof leave this device. */
import {prepareRecord,decodeRecord} from './record-client.mjs';
import {referenceRecord,normalizeRecordPlan,estimateRecordPlan} from './record-core.mjs';
import {cryptoProvider,exactKeys,denseArray} from './recipe-core.mjs';
import {sha256} from './gc-core.mjs';
import {PROFILE,SCHEME,proofRuntime,createProofPlanContext,proofPlanRowContext,canonicalProofPlanRequest,verifyProofPlanBindings,validateProofPlanResult,makeProofStatements,canonicalProofPlanBundle,normalizeProofPlanOptions,recordDataSnapshot} from './record-proof-core.mjs';
const check=v=>{if(!v)throw Error('Invalid private record proof data');};
const random=n=>Array.from(cryptoProvider().getRandomValues(new Uint8Array(n)),b=>b.toString(16).padStart(2,'0')).join('');
export async function prepareProofRecord(records,plan,options){
 plan=normalizeRecordPlan(plan);options=normalizeProofPlanOptions(options);records=recordDataSnapshot(records);estimateRecordPlan(plan,records.length);
 records.forEach(row=>referenceRecord(row,plan));
 const p=await prepareRecord(records,plan,{capture:true}),sdk=await proofRuntime();
 const context=await createProofPlanContext(p.request,options),rows=[],witnessRows=[];
 for(let row=0;row<records.length;row++){
  const preContext=await proofPlanRowContext(p.request,context,0,row),inputSalt=random(32),outputSalt=random(32);
  const header={type:'record',preContext,column:1,row,plan};
  const inputPairs=p.witness.inputPairs[row],outputPairs=p.witness.outputPairs[row];
  const roots=await sdk.commitRow({...header,inputPairs,outputPairs,inputSalt,outputSalt});
  const inputSelectedRoot=await sdk.selectedRoot({...header,role:'input',labels:p.request.rows[row].inputs});
  rows.push({column:'C1',row,type:'record',preContext,...roots,inputSelectedRoot});
  witnessRows.push({column:'C1',row,inputPairs,outputPairs,inputSalt,outputSalt});
 }
 const request={profile:PROFILE,task:p.request,proofManifest:{version:1,scheme:SCHEME,context,rows}};
 await verifyProofPlanBindings(request);const inputSha256=await sha256(canonicalProofPlanRequest(request));
 return {request,decoder:{profile:PROFILE,request,taskDecoder:p.decoder},witness:{version:1,jobId:options.jobId,baseRequestSha256:context.baseRequestSha256,inputSha256,rows:witnessRows}};
}
export async function decodeProofRecord(result,decoder){
 exactKeys(decoder,['profile','request','taskDecoder']);check(decoder.profile===PROFILE);result=recordDataSnapshot(result);decoder=recordDataSnapshot(decoder);
 const request=await verifyProofPlanBindings(decoder.request);validateProofPlanResult(result,request);
 check(result.inputSha256===await sha256(canonicalProofPlanRequest(request))&&result.programSha256===request.proofManifest.context.programSha256);
 return decodeRecord({...result,profile:request.task.profile,inputSha256:request.proofManifest.context.baseRequestSha256,programSha256:request.proofManifest.context.baseProgramSha256},decoder.taskDecoder);
}
export async function proveProofRecord({request,delivery,binding,witness,onProgress}){
 request=JSON.parse(canonicalProofPlanRequest(request));delivery=recordDataSnapshot(delivery);binding=recordDataSnapshot(binding);witness=recordDataSnapshot(witness);
 exactKeys(witness,['version','jobId','baseRequestSha256','inputSha256','rows']);
 check(witness.version===1&&witness.jobId===request.proofManifest.context.jobId&&witness.baseRequestSha256===request.proofManifest.context.baseRequestSha256&&witness.inputSha256===await sha256(canonicalProofPlanRequest(request)));
 const expected=await makeProofStatements(request,delivery,binding),sdk=await proofRuntime(),rows=[];denseArray(witness.rows,expected.rows.length);
 for(let i=0;i<expected.rows.length;i++){
  const w=witness.rows[i];exactKeys(w,['column','row','inputPairs','outputPairs','inputSalt','outputSalt']);check(w.column==='C1'&&w.row===i);
  const statement=expected.rows[i].statement,privateRow={inputPairs:w.inputPairs,outputPairs:w.outputPairs,inputSalt:w.inputSalt,outputSalt:w.outputSalt};
  const roots=await sdk.commitRow({...statement,...privateRow});check(roots.inputPairRoot===statement.inputPairRoot&&roots.outputPairRoot===statement.outputPairRoot);
  const proof=await sdk.proveRow({statement,witness:privateRow});rows.push({column:'C1',row:i,proof});onProgress?.({completed:i+1,total:expected.rows.length});
 }
 return JSON.parse(canonicalProofPlanBundle({version:1,scheme:SCHEME,finalContext:expected.finalContext,rows}));
}
