// JSONL driver for a genuine TESTNET synthetic integration; no mainnet/default wallet.
import readline from 'node:readline';
import {randomBytes} from 'node:crypto';
import {actions} from 'near-api-js';
import {loadIdentity,withLock} from './storage.mjs';
import {TestnetRpc,sendOnce} from './transport.mjs';
import {NETWORK,RPC,domainHash} from './policy.mjs';
import {inspect} from './registry.mjs';
import {participantIdentities,sendParticipantOnce} from './participants.mjs';
const emit=x=>process.stdout.write(JSON.stringify(x)+'\n');
const bytes=x=>Array.isArray(x)&&x.length===32&&x.every(n=>Number.isInteger(n)&&n>=0&&n<=255);
const u64=x=>typeof x==='string'&&/^[1-9][0-9]{0,19}$/.test(x)&&BigInt(x)<2n**64n;
try{await withLock(async()=>{
 const owner=loadIdentity(),rpc=new TestnetRpc({network:NETWORK,url:RPC}),providers=participantIdentities(owner),run=randomBytes(8).toString('hex');
 const state=await inspect(rpc,owner);if(state.owner!==owner.account_id||state.account?.code_hash!==state.expectedCode)throw new Error('REGISTRY_PIN_MISMATCH');
 for(const id of providers)await rpc.access(id);
 emit({event:'ready',network:NETWORK,local_only:false,contract_id:owner.account_id,network_domain_hash:domainHash(),run_id:run,identities:{buyer:owner.account_id,executor:owner.account_id,bidder0:providers[0].account_id,bidder1:providers[1].account_id,bidder2:providers[2].account_id},independent_administrators:false});
 const actor=name=>{if(name===undefined||name===owner.account_id)return owner;const p=providers.find(x=>x.account_id===name);if(!p)throw new Error('UNKNOWN_ACTOR');return p;};
 const now=async()=>BigInt((await rpc.request('block',{finality:'final'})).header.timestamp_nanosec);
 const view=async id=>{if(!u64(id))throw new Error('INVALID_JOB_ID');const v=await rpc.view(owner.account_id,'get_job',{job_id:id});if(!v.value)throw new Error('UNKNOWN_JOB');return v;};
 for await(const line of readline.createInterface({input:process.stdin,crlfDelay:Infinity})){
  let req;try{if(Buffer.byteLength(line)>65536)throw new Error('BODY_TOO_LARGE');req=JSON.parse(line);if(!Number.isSafeInteger(req.id)||req.id<1)throw new Error('REQUEST_ID_REQUIRED');let result,tx;
   if(req.command==='now'){const n=await now();result={timestamp_ns:String(n),suggested_bid_deadline_ns:String(n+180000000000n),suggested_result_deadline_ns:String(n+1200000000000n)};}
   else if(req.command==='create_job'){
    const c=req.config,roster=providers.map(p=>p.account_id).sort(),fields=['spec_hash','circuit_hash','key_hash','output_policy_hash','context_hash','input_hash','budget_commitment'];
    if(!c||Object.keys(c).sort().join(',')!==[...fields,'bid_deadline_ns','result_deadline_ns','authorized_bidders','executor'].sort().join(',')||fields.some(k=>!bytes(c[k])||c[k].every(n=>n===0))||JSON.stringify(c.authorized_bidders)!==JSON.stringify(roster)||c.executor!==owner.account_id||!u64(c.bid_deadline_ns)||!u64(c.result_deadline_ns))throw new Error('CONFIG_POLICY_MISMATCH');
    tx=await sendOnce(rpc,owner,'integration-'+run+'-create',[actions.functionCall('create_job',{config:c},50000000000000n,0n)]);
    const created=JSON.parse(Buffer.from(tx.status.SuccessValue,'base64').toString());const v=await view(created.job_id);result={job:v.value,block_hash:v.block_hash};
   }else if(['view','bid','close','begin_execution','submit_receipt','decide'].includes(req.command)){
    const jid=req.job_id;if(!u64(jid))throw new Error('INVALID_JOB_ID');const before=await view(jid);let method,args;
    if(req.command==='view')result={job:before.value,block_hash:before.block_hash};
    else if(req.command==='close'&&await now()<BigInt(before.value.config.bid_deadline_ns))result={notReady:true,waitSeconds:Math.min(20,Math.max(1,Math.ceil(Number(BigInt(before.value.config.bid_deadline_ns)-await now())/1e9)))};
    else{
     if(req.command==='bid'){method='submit_bid';args={job_id:jid,expected_job_binding_hash:req.expected_job_binding_hash,commitment:req.commitment};if(!bytes(args.commitment)||!bytes(args.expected_job_binding_hash))throw new Error('INVALID_BID');}
     if(req.command==='close'){method='close_bids';args={job_id:jid};}
     if(req.command==='begin_execution'){method='begin_selected_attempt';args={job_id:jid,expected_bidset_root:req.expected_bidset_root,selected_executor:req.selected_executor};if(!providers.some(p=>p.account_id===args.selected_executor)||!bytes(args.expected_bidset_root))throw new Error('INVALID_SELECTION');}
     if(req.command==='submit_receipt'){method='report_result';args={claim:req.claim};if(req.claim?.job_id!==jid)throw new Error('CLAIM_JOB_MISMATCH');}
     if(req.command==='decide'){method='decide_result';args={job_id:jid,expected_receipt_hash:req.expected_receipt_hash,accept:req.accept};if(typeof req.accept!=='boolean'||!bytes(req.expected_receipt_hash))throw new Error('INVALID_DECISION');}
     const signer=actor(req.actor),label=`integration-${run}-${req.command.replaceAll('_','-')}-${req.id}`;
     tx=await sendParticipantOnce(rpc,owner,signer,owner.account_id,label,[actions.functionCall(method,args,80000000000000n,0n)]);
     const after=await view(jid);result={job:after.value,block_hash:after.block_hash};
    }
   }else throw new Error('UNKNOWN_COMMAND');
   if(tx)result.transaction={hash:tx.transaction.hash,signer:tx.transaction.signer_id,receiver:tx.transaction.receiver_id,finality:tx.final_execution_status};
   emit({id:req.id,ok:true,result});
  }catch(e){emit({id:req?.id??null,ok:false,error:/^[A-Z][A-Z0-9_]+$/.test(e.message)?e.message:'TESTNET_COMMAND_FAILED_OR_UNKNOWN'});}
 }
});}catch(e){emit({event:'fatal',network:NETWORK,error:/^[A-Z][A-Z0-9_]+$/.test(e.message)?e.message:'TESTNET_DRIVER_FAILED'});process.exitCode=1;}
