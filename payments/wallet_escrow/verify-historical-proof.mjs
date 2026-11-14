/** Real public C775 proof compatibility; read-only, no sessions/witness/keys. */
import fs from 'node:fs';
import {boundedPublicJSON,validatePublicEvidence,verifyPublicChainBinding} from '../../web/public-proof.mjs';
import {verifyProofPlanBundle,proofRuntime} from '../../web/proof-plan-core.mjs';
const id='c77599347652ecdfb2362a620afa5e99';
const url='https://nope-workspace.vercel.app/api/workspace?'+new URLSearchParams({route:'jobs/'+id+'/proof/evidence'});
const e=validatePublicEvidence(await boundedPublicJSON(await fetch(url,{signal:AbortSignal.timeout(30000)}),5*1024*1024),id);
let result;try{const chain=await verifyPublicChainBinding(e);const verified=await verifyProofPlanBundle({request:e.task,delivery:e.delivery,binding:e.binding,bundle:e.bundle});if(!verified||chain.escrowState!=='Paid')throw Error('HISTORICAL_PROOF_FAILED');result={jobId:id,readOnly:true,actualExternalChain:true,actualProofsVerified:e.bundle.rows.length,verified,checkedAt:new Date().toISOString(),...chain};}finally{await(await proofRuntime()).dispose();}
fs.writeFileSync(new URL('./verification/admission-v1/historical-c775.json',import.meta.url),JSON.stringify(result,null,2)+'\n');console.log(JSON.stringify(result));
