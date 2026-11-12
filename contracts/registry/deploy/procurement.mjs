// Bind an already prepared application job to the existing owner-only TESTNET registry.
// This local relay loads only the dedicated faucet testnet identity. Never deploy in Vercel.
import {actions} from 'near-api-js';
import {pathToFileURL} from 'node:url';
import {readFileSync} from 'node:fs';
import {validateIntent,precommitContext,hash32,canonical} from '../../../procurement/codec.mjs';
import {NETWORK,RPC,DOMAIN_HEX,requirePolicy} from './policy.mjs';
import {loadIdentity,withLock,publicJson} from './storage.mjs';
import {TestnetRpc,sendOnce} from './transport.mjs';
import {inspect} from './registry.mjs';
export function publicationConfig(job,identity){
 if(!job||!/^[0-9a-f]{32}$/.test(job.id)||job.status!=='PUBLISHED')throw new Error('PUBLISHED_JOB_REQUIRED');
 const i=job.intent;validateIntent(i);
 if(job.buyer!==identity.account_id||i.buyer!==identity.account_id||i.registryAccount!==identity.account_id||i.networkDomainHash!==DOMAIN_HEX)throw new Error('OWNER_TESTNET_BINDING_REQUIRED');
 if(canonical(job.roster)!==canonical(i.roster)||job.bidDeadlineNs!==i.bidDeadlineNs||job.resultDeadlineNs!==i.resultDeadlineNs||job.contextHash!==precommitContext(i)||!hash32(job.budgetCommitment))throw new Error('PUBLICATION_CONTEXT_MISMATCH');
 const c={};for(const [to,from]of Object.entries({spec_hash:'specHash',circuit_hash:'circuitHash',key_hash:'keyHash',output_policy_hash:'outputPolicyHash',input_hash:'inputHash'}))c[to]=[...Buffer.from(i[from],'hex')];
 return {...c,context_hash:[...Buffer.from(job.contextHash,'hex')],budget_commitment:[...Buffer.from(job.budgetCommitment,'hex')],bid_deadline_ns:i.bidDeadlineNs,result_deadline_ns:i.resultDeadlineNs,authorized_bidders:i.roster,executor:i.registryExecutor};
}
export async function publishTestnet(job,rpc,identity){
 const config=publicationConfig(job,identity);const state=await inspect(rpc,identity);
 if(!state.initialized||state.owner!==identity.account_id||state.account?.code_hash!==state.expectedCode)throw new Error('REVIEWED_REGISTRY_REQUIRED');
 const tx=await sendOnce(rpc,identity,'procurement-'+job.id,[actions.functionCall('create_job',{config},50_000_000_000_000n,0n)]);
 let created;try{created=JSON.parse(Buffer.from(tx.status.SuccessValue,'base64').toString('utf8'));}catch{throw new Error('CREATED_JOB_RETURN_INVALID');}
 if(!created||!/^\d+$/.test(created.job_id))throw new Error('CREATED_JOB_RETURN_INVALID');
 const view=await rpc.view(identity.account_id,'get_job',{job_id:created.job_id});
 if(view.value?.buyer!==job.buyer||canonical(view.value.config)!==canonical(config)||canonical(created.config)!==canonical(config))throw new Error('FINAL_REGISTRY_BINDING_MISMATCH');
 return {applicationJobId:job.id,network:NETWORK,registryAccount:identity.account_id,registryJobId:created.job_id,transactionHash:tx.transaction.hash,finalExecutionStatus:tx.final_execution_status,view,scope:'testnet-registry-publication-only',paymentExecuted:false,selectionExecuted:false};
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){
 try{const [file,nf,network,rf,rpc,...extra]=process.argv.slice(2);if(nf!=='--network'||rf!=='--rpc'||extra.length)throw new Error('EXPLICIT_TESTNET_FLAGS_REQUIRED');requirePolicy(network,rpc);const raw=readFileSync(file);if(raw.length>65536)throw new Error('JOB_TOO_LARGE');const job=JSON.parse(raw);const result=await withLock(()=>publishTestnet(job,new TestnetRpc({network,url:rpc}),loadIdentity()));publicJson('procurement-'+job.id,result);console.log(JSON.stringify({applicationJobId:job.id,registryJobId:result.registryJobId,transactionHash:result.transactionHash,network:NETWORK}));}
 catch(e){console.error(JSON.stringify({error:/^[A-Z][A-Z0-9_]+$/.test(e.message)?e.message:'PUBLICATION_FAILED_OR_UNKNOWN'}));process.exitCode=1;}
}
