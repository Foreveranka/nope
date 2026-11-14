import {isProofProfile,schemeForProfile} from '../web/proof-protocol.mjs';
/** Public-result proof verification. No client witness, decoder, pair or salt is accepted. */
import {createHash} from 'node:crypto';
import {PROFILE,SCHEME,MAX_PROOF_BUNDLE_BYTES,makeProofStatements,hashProofManifest,canonicalProofPlanRequest,proofRuntime} from '../web/proof-protocol.mjs';
import {exactKeys,denseArray} from '../web/recipe-core.mjs';

export {MAX_PROOF_BUNDLE_BYTES};
const fail=()=>{throw Error('RESULT_PROOF_NOT_VERIFIED');};
const check=v=>{if(!v)fail();};
const digest=value=>createHash('sha256').update(value).digest('hex');
const canonical=value=>JSON.stringify(value,(_,v)=>v&&typeof v==='object'&&!Array.isArray(v)?Object.fromEntries(Object.keys(v).sort().map(k=>[k,v[k]])):v);
export const proofBundleHash=bundle=>digest(canonical(bundle));

export function proofBindingForJob(job){
 check(isProofProfile(job?.profile)&&['SPONSORED_TESTNET_ESCROW','WALLET_TESTNET_ESCROW'].includes(job.payment?.kind)&&job.delivery&&job.selectedOffer);
 return {jobId:job.id,version:job.delivery.version,contractId:job.payment.contractId,bindingHash:job.payment.bindingHash,
  provider:job.selectedOffer.paymentAccount,amountYocto:job.selectedOffer.amountYocto};
}

/** Expected signals are built from the stored task and exact current delivery,
 * never from the proof envelope's own public-input list. Every row must pass. */
export async function verifyJobProof({task,job,bundle}){
 check(isProofProfile(task?.profile)&&task.profile===job?.profile);
 exactKeys(bundle,['version','scheme','finalContext','rows']);
 check(bundle.version===1&&bundle.scheme===schemeForProfile(task.profile)&&Buffer.byteLength(JSON.stringify(bundle))<=MAX_PROOF_BUNDLE_BYTES);
 const expected=await makeProofStatements(task,job.delivery,proofBindingForJob(job));
 check(bundle.finalContext===expected.finalContext);
 denseArray(bundle.rows,expected.rows.length);
 const sdk=await proofRuntime(task);check(typeof sdk.verifyRow==='function');
 for(let i=0;i<expected.rows.length;i++){
  const row=bundle.rows[i],target=expected.rows[i];exactKeys(row,['column','row','proof']);
  check(row.column===target.column&&row.row===target.row);
  check(await sdk.verifyRow({statement:target.statement,proof:row.proof})===true);
 }
 const requestSha256=digest(canonicalProofPlanRequest(task));
 check(requestSha256===job.taskHash&&job.delivery.inputSha256===requestSha256&&job.delivery.programSha256===job.programHash);
 return {status:'VERIFIED',scheme:schemeForProfile(task.profile),version:1,bundleSha256:proofBundleHash(bundle),finalContext:expected.finalContext,
  requestSha256,manifestSha256:await hashProofManifest(task),programSha256:job.programHash,planSha256:job.planSha256,
  deliveryVersion:job.delivery.version,outputSha256:job.delivery.outputSha256,bindingHash:job.payment.bindingHash,rowProofCount:expected.rows.length};
}

export function matchesCurrentProof(job){
 const p=job?.proof,d=job?.delivery;
 return isProofProfile(job?.profile)&&p?.status==='VERIFIED'&&p.scheme===schemeForProfile(job.profile)&&p.version===1&&
  p.deliveryVersion===d?.version&&p.outputSha256===d?.outputSha256&&p.requestSha256===job.taskHash&&
  p.programSha256===job.programHash&&p.planSha256===job.planSha256&&p.bindingHash===job.payment?.bindingHash&&
  typeof p.bundleSha256==='string'&&/^[a-f0-9]{64}$/.test(p.bundleSha256);
}
export const proofPath=(jobId,hash)=>{
 check(typeof jobId==='string'&&/^[a-f0-9]{32}$/.test(jobId)&&typeof hash==='string'&&/^[a-f0-9]{64}$/.test(hash));
 return `nope-workspace-v1/jobs/${jobId}/proof-${hash}.json`;
};
