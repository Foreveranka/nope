/** Read-only FINAL old-wallet inventory. Public state only, no wallet keys. */
import fs from 'node:fs';
import {createWalletRPC} from '../../workspace/wallet-auth.mjs';
const admitted=process.argv.includes('--admission-v1');
const contractId=admitted?'nope-wallet-66e1273c.testnet':'nope-wallet-44384e2f.testnet',codeHash=admitted?'5MAoowxLrnP7KWFFU2hAepMrQwUtgKpDtbgeFr7rcF9v':'6qzVqhNyk7KKvjzC6g8iPtJmHffTgb6YBh8Fp9xerXHy';
const at=process.argv.find(a=>a.startsWith('--at-block='))?.slice(11);if(at&&!/^[1-9][0-9]{0,11}$/.test(at))throw Error('INVALID_HISTORICAL_BLOCK');
const rpc=createWalletRPC({}),block=await rpc('block',at?{block_id:Number(at)}:{finality:'final'}),block_id=block.header.hash;
const account=await rpc('query',{request_type:'view_account',account_id:contractId,block_id});
const keys=await rpc('query',{request_type:'view_access_key_list',account_id:contractId,block_id});
const call=await rpc('query',{request_type:'call_function',account_id:contractId,method_name:'get_config',args_base64:'e30=',block_id});
const state=await rpc('query',{request_type:'view_state',account_id:contractId,prefix_base64:'U1RBVEU=',block_id});
if([account,keys,call,state].some(x=>x.block_hash!==block_id)||account.code_hash!==codeHash||keys.keys.length)throw Error('LEGACY_PIN_MISMATCH');
const config=JSON.parse(Buffer.from(call.result));
const entries=state.values.filter(x=>Buffer.from(x.key,'base64').toString()==='STATE');if(entries.length!==1)throw Error('LEGACY_STATE_REQUIRED');
const b=Buffer.from(entries[0].value,'base64');let i=0;
const take=n=>{if(i+n>b.length)throw Error('BOUNDS');const v=b.subarray(i,i+n);i+=n;return v;};
const u8=()=>take(1)[0],u32=()=>take(4).readUInt32LE(),uint=n=>{const v=take(n);let x=0n;for(let j=n-1;j>=0;j--)x=x*256n+BigInt(v[j]);return x.toString();};
const str=()=>{const n=u32();if(n>4096)throw Error('STRING_BOUND');return take(n).toString('utf8');};
const option=f=>{const tag=u8();if(tag===0)return null;if(tag!==1)throw Error('OPTION');return f();};
if(admitted){const admissionPublicKey=take(32).toString('hex');if(admissionPublicKey!==config.admission_public_key)throw Error('ADMISSION_KEY_MISMATCH');}
const count=u32();if(count>50)throw Error('HOLD_BOUND');const holds=[];
for(let n=0;n<count;n++){
 const namespace=str(),terms={job_id:str(),buyer_commitment:str(),buyer_account:str(),provider:str(),amount:uint(16),input_hash:str(),program_hash:str(),plan_hash:str(),execution_deadline_ns:uint(8),review_deadline_ns:uint(8)};
 const binding_hash=str(),tag=u8();if(tag>5)throw Error('STATE_TAG');const status=['Held','Delivered','PayoutPending','RefundPending','Paid','Refunded'][tag],nonce=uint(8);
 const delivery=option(()=>({version:u32(),output_hash:str()})),last_transfer_failure_nonce=option(()=>uint(8)),pending=option(()=>({action:u8(),previousState:u8()}));
 if(namespace!==terms.buyer_account+':'+terms.job_id)throw Error('NAMESPACE');holds.push({namespace,terms,binding_hash,state:status,nonce,delivery,last_transfer_failure_nonce,pending});
}
const totals={total_deposited:uint(16),liabilities:uint(16),total_paid:uint(16),total_refunded:uint(16),pending_outgoing:uint(16)};
if(i!==b.length||holds.length!==config.hold_count||Object.entries(totals).some(([k,v])=>config[k]!==v))throw Error('STATE_CONFIG_MISMATCH');
const open=holds.filter(h=>!['Paid','Refunded'].includes(h.state));
const out={network:'testnet',contractId,codeHash,readOnly:true,actualExternalChain:true,finalBlockHash:block_id,finalBlockHeight:String(block.header.height),checkedAt:new Date().toISOString(),keys:[],config,holds,outstandingHolds:open.length,pendingTransfers:holds.filter(h=>h.pending).length,cutoverFinanciallyClear:open.length===0&&totals.liabilities==='0'&&totals.pending_outgoing==='0'};
const dir=new URL(admitted?'./verification/storage-v2/':'./verification/admission-v1/',import.meta.url);
fs.mkdirSync(dir,{recursive:true});fs.writeFileSync(new URL(process.argv.includes('--after-cutover')?'legacy-after-cutover.json':'legacy-before-cutover.json',dir),JSON.stringify(out,null,2)+'\n');
if(admitted&&(holds.length!==3||!out.cutoverFinanciallyClear))throw Error('ADMITTED_V1_NOT_THREE_TERMINAL_ZERO_LIABILITY_HOLDS');
console.log(JSON.stringify({contractId,holdCount:holds.length,outstandingHolds:open.length,pendingTransfers:out.pendingTransfers,cutoverFinanciallyClear:out.cutoverFinanciallyClear}));
