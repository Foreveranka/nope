// Hosted, finite TESTNET sponsor relay. Journal records belong in PRIVATE Blob.
// This module never deploys, replenishes, exposes a key, or returns signed bytes.
import {createHash} from 'node:crypto';
import {actions,KeyPair,KeyPairSigner,createTransaction,decodeSignedTransaction,baseDecode,baseEncode} from 'near-api-js';

const DOMAIN='NOPE:WORKSPACE-ESCROW:V1:testnet';
const KIND='SPONSORED_TESTNET_ESCROW';
const RPC='https://test.rpc.fastnear.com';
const METHODS={fund:'fund',record:'record_delivery',release:'accept_and_release',refund:'refund'};
const ALLOWED=Object.values(METHODS).sort();
const GAS=150000000000000n,GAS_BUDGET=155000000000000n,MAX_CALL_BYTES=2048n,MAX_ALLOWANCE=200000000000000000000000n;
const BUDGET_CODES=new Set(['ESCROW_GAS_ALLOWANCE_INSUFFICIENT','ESCROW_ACCOUNT_RESERVE_INSUFFICIENT','ESCROW_GAS_BUDGET_UNVERIFIED','ESCROW_GAS_PROTOCOL_UNSUPPORTED']);
const ROOT='nope-workspace-v1/escrow/';
const LIMIT=64,MAX_CERTIFICATE_RECORD=1024*1024;
const hash=v=>createHash('sha256').update(v).digest();
const sha=v=>hash(typeof v==='string'?v:JSON.stringify(v)).toString('hex');
const hex=(v,n)=>typeof v==='string'&&new RegExp(`^[a-f0-9]{${n}}$`).test(v);
const chainHash=v=>typeof v==='string'&&/^[1-9A-HJ-NP-Za-km-z]{43,44}$/.test(v)&&baseDecode(v).length===32;
const account=v=>typeof v==='string'&&v.length<=64&&(/^[a-f0-9]{64}$/.test(v)||/^[a-z0-9]+(?:[-_][a-z0-9]+)*(?:\.[a-z0-9]+(?:[-_][a-z0-9]+)*)*\.testnet$/.test(v));
const canonical=v=>JSON.stringify(v,(_,x)=>x&&typeof x==='object'&&!Array.isArray(x)?Object.fromEntries(Object.keys(x).sort().map(k=>[k,x[k]])):x);
const equal=(a,b)=>canonical(a)===canonical(b);
const fail=code=>{throw Object.assign(new Error(code),{code,status:409});};
const requireThat=(v,code)=>{if(!v)fail(code);};
const decimal=v=>typeof v==='string'&&/^(0|[1-9][0-9]*)$/.test(v);
const uint=(v,max=(1n<<64n)-1n)=>{if(typeof v==='number'){requireThat(Number.isSafeInteger(v)&&v>=0,'ESCROW_UNSAFE_INTEGER');v=String(v);}requireThat(decimal(v)&&BigInt(v)<=max,'ESCROW_UNSAFE_INTEGER');return v;};
const opPath=(id,stage)=>`${ROOT}ops/${id}/${String(stage).padStart(4,'0')}.json`;
const pending={fund:'FUNDING_PENDING',record:'RECORD_PENDING',release:'PAYOUT_PENDING',refund:'REFUND_PENDING'};
const hashField={fund:'fundTransactionHash',record:'recordTransactionHash',release:'releaseTransactionHash',refund:'refundTransactionHash'};

// RPC nonce is a JSON u64 number: preserve its lexical integer before JSON.parse.
function rpcJSON(text){return JSON.parse(text.replace(/"(?:\\.|[^"\\])*"|-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?/g,token=>token[0]!=='"'&&/^-?[0-9]+$/.test(token)&&!Number.isSafeInteger(Number(token))?JSON.stringify(token):token));}
function decode64(v){requireThat(typeof v==='string'&&v.length<=65536&&/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(v),'ESCROW_INVALID_ENCODING');return Buffer.from(v,'base64');}
function deliveryFor(job){const d=job.delivery;requireThat(d&&Number.isInteger(d.version)&&d.version>0&&d.version<=0xffffffff&&hex(d.outputSha256,64),'ESCROW_DELIVERY_MISMATCH');return{version:d.version,output_hash:d.outputSha256};}

/** Pure immutable workspace terms; no old U64 job-id translation. */
export function termsForJob(job,contractId){
 requireThat(account(contractId)&&contractId.endsWith('.testnet'),'ESCROW_INVALID_CONTRACT');
 requireThat(hex(job?.id,32)&&hex(job?.buyerId,32)&&hex(job?.taskHash,64)&&hex(job?.programHash,64),'ESCROW_INVALID_JOB');
 const offer=job.selectedOffer,amount=offer?.amountYocto;
 requireThat(account(offer?.paymentAccount)&&offer.paymentAccount!==contractId&&decimal(amount)&&BigInt(amount)>=10n**18n&&BigInt(amount)<=10n**22n,'ESCROW_INVALID_AMOUNT_OR_PROVIDER');
 const awarded=job.payment?.awardedAtISO,ms=typeof awarded==='string'?Date.parse(awarded):NaN;
 requireThat(Number.isSafeInteger(ms)&&ms>=0&&new Date(ms).toISOString()===awarded,'ESCROW_AWARD_TIME_REQUIRED');
 const plan=job.planSha256??'0'.repeat(64);requireThat(hex(plan,64),'ESCROW_INVALID_PLAN');
 const execution=BigInt(ms)*1000000n+24n*60n*60n*1000000000n,review=execution+24n*60n*60n*1000000000n;
 requireThat(review<(1n<<64n),'ESCROW_INVALID_DEADLINE');
 const terms={job_id:job.id,buyer_commitment:sha('NOPE:buyer:'+job.buyerId),provider:offer.paymentAccount,amount,input_hash:job.taskHash,program_hash:job.programHash,plan_hash:plan,execution_deadline_ns:String(execution),review_deadline_ns:String(review)};
 const bindingHash=sha([DOMAIN,contractId,...Object.values(terms)]);
 return{terms,bindingHash};
}

/** fetcher is an explicit unit-test seam; the endpoint and policy cannot change. */
export function createEscrowService({store,env=process.env,now=Date.now,fetcher=globalThis.fetch}={}){
 const names=['NOPE_ESCROW_CONTRACT_ID','NOPE_ESCROW_CODE_HASH','NOPE_ESCROW_SIGNER_KEY'];
 if(names.every(k=>env[k]===undefined))return null;
 requireThat(names.every(k=>typeof env[k]==='string'&&env[k].length>0),'ESCROW_PARTIAL_CONFIG');
 const contractId=env.NOPE_ESCROW_CONTRACT_ID,codeHash=env.NOPE_ESCROW_CODE_HASH;
 requireThat(account(contractId)&&contractId.endsWith('.testnet')&&chainHash(codeHash),'ESCROW_INVALID_CONFIG');
 requireThat(store&&typeof store.read==='function'&&typeof store.create==='function','ESCROW_DURABLE_STORE_REQUIRED');
 let key,signer;try{key=KeyPair.fromString(env.NOPE_ESCROW_SIGNER_KEY);requireThat(key.getPublicKey().toString().startsWith('ed25519:'),'ESCROW_INVALID_KEY');signer=KeyPairSigner.fromSecretKey(env.NOPE_ESCROW_SIGNER_KEY);}catch{fail('ESCROW_INVALID_KEY');}
 const publicKey=key.getPublicKey().toString(),keyId=sha([DOMAIN,'key',contractId,publicKey]);
 async function rpc(method,params){
  let response;try{response=await fetcher(RPC,{method:'POST',redirect:'error',signal:AbortSignal.timeout(12000),headers:{'content-type':'application/json'},body:JSON.stringify({jsonrpc:'2.0',id:'workspace-escrow',method,params})});}catch{fail('ESCROW_RPC_UNAVAILABLE');}
  requireThat(response.ok,'ESCROW_RPC_UNAVAILABLE');
  const reader=response.body.getReader(),chunks=[];let size=0;
  try{for(;;){const {done,value}=await reader.read();if(done)break;size+=value.byteLength;if(size>2*1024*1024){await reader.cancel();fail('ESCROW_RPC_BOUND');}chunks.push(Buffer.from(value));}}finally{reader.releaseLock();}
  let json;try{json=rpcJSON(Buffer.concat(chunks).toString('utf8'));}catch{fail('ESCROW_RPC_INVALID');}
  if(json.error){if(json.error.code===-32601)fail('ESCROW_RPC_METHOD_UNAVAILABLE');fail('ESCROW_RPC_UNKNOWN');}
  requireThat(json.result!==undefined&&json.result!==null,'ESCROW_RPC_UNKNOWN');return json.result;
 }
 async function pin(withKey=false){
  requireThat((await rpc('status',[])).chain_id==='testnet','ESCROW_WRONG_NETWORK');
  const state=await rpc('query',{request_type:'view_account',account_id:contractId,finality:'final'});
  requireThat(state.code_hash===codeHash&&chainHash(state.block_hash),'ESCROW_CODE_PIN_MISMATCH');
  if(!withKey)return state;
  // All budget observations refer to the SAME finalized account snapshot. No
  // gas/storage price defaults: a missing or malformed response blocks signing.
  const [access,configView,priceView,protocol]=await Promise.all([
   rpc('query',{request_type:'view_access_key',account_id:contractId,public_key:publicKey,block_id:state.block_hash}),
   rpc('query',{request_type:'call_function',account_id:contractId,method_name:'get_config',args_base64:Buffer.from('{}').toString('base64'),block_id:state.block_hash}),
   rpc('gas_price',[state.block_hash]),
   rpc('EXPERIMENTAL_protocol_config',{block_id:state.block_hash})
  ]);
  const p=access.permission?.FunctionCall;
  requireThat(p&&Object.keys(access.permission).length===1&&p.receiver_id===contractId&&Array.isArray(p.method_names)&&equal([...p.method_names].sort(),ALLOWED)&&decimal(p.allowance)&&BigInt(p.allowance)>0n&&BigInt(p.allowance)<=MAX_ALLOWANCE,'ESCROW_KEY_PERMISSION_REJECTED');
  const nonce=uint(access.nonce);requireThat(chainHash(access.block_hash)&&access.block_hash===state.block_hash,'ESCROW_KEY_BLOCK_MISMATCH');
  gasBudget(state,p,configView,priceView,protocol);
  return{...state,nonce};
 }
 function gasBudget(state,permission,configView,priceView,protocol){
  const bad='ESCROW_GAS_BUDGET_UNVERIFIED',u128=(value)=>{
   requireThat(decimal(value)&&BigInt(value)<(1n<<128n),bad);return BigInt(value);
  };
  requireThat(configView.block_hash===state.block_hash&&Array.isArray(configView.result)&&configView.result.length<=16384&&configView.result.every(n=>Number.isInteger(n)&&n>=0&&n<256),bad);
  let c;try{c=JSON.parse(Buffer.from(configView.result).toString('utf8'));}catch{fail(bad);}
  requireThat(c?.domain===DOMAIN&&c.network==='testnet'&&c.contract_id===contractId&&c.max_holds===50&&c.max_hold_amount==='10000000000000000000000'&&Number.isInteger(c.hold_count)&&c.hold_count>=0&&c.hold_count<=50,bad);
  const total=u128(c.total_pool),available=u128(c.available),held=u128(c.held),spent=u128(c.spent),pendingPool=u128(c.pending),reserve=u128(c.gas_reserve);
  requireThat(total===50000000000000000000000n&&available+held+spent===total&&pendingPool<=held&&reserve>=100000000000000000000000n,bad);
  let storage,headroom;try{storage=BigInt(uint(state.storage_usage));headroom=BigInt(uint(c.storage_headroom_bytes));}catch{fail(bad);}
  requireThat(headroom>=65536n,bad);
  const gasPrice=u128(priceView.gas_price),storagePrice=u128(protocol.runtime_config?.storage_amount_per_byte),balance=u128(state.amount);
  requireThat((protocol.chain_id===undefined||protocol.chain_id==='testnet')&&gasPrice>0n&&storagePrice>0n&&(priceView.block_hash===undefined||priceView.block_hash===state.block_hash)&&(protocol.block_hash===undefined||protocol.block_hash===state.block_hash),bad);
  const fees=protocol.runtime_config?.transaction_costs;
  // Nonunit inflation needs the protocol's full pessimistic-price formula. This
  // relay supports only the explicitly observed unit-ratio profile, never a default.
  requireThat(equal(fees?.pessimistic_gas_price_inflation_ratio,[1,1]),'ESCROW_GAS_PROTOCOL_UNSUPPORTED');
  const fee=(value)=>{try{
   const sir=BigInt(uint(value?.send_sir)),other=BigInt(uint(value?.send_not_sir)),execution=BigInt(uint(value?.execution));
   return(sir>other?sir:other)+execution;
  }catch{fail(bad);}};
  const calls=fees.action_creation_config;
  // Bound BOTH send and execution fees at the protocol's current prices. The
  // serialized method+arguments are independently capped before any journal/sign.
  const overhead=fee(fees.action_receipt_creation_config)+fee(calls?.function_call_cost)+MAX_CALL_BYTES*fee(calls?.function_call_cost_per_byte);
  requireThat(overhead<=GAS_BUDGET-GAS,'ESCROW_GAS_PROTOCOL_UNSUPPORTED');
  // 150 Tgas attached plus a VALIDATED <=5 Tgas transaction/action envelope.
  // This consumes only the finite access-key allowance, never the sponsor pool.
  const prepaid=GAS_BUDGET*gasPrice;
  requireThat(BigInt(permission.allowance)>=prepaid,'ESCROW_GAS_ALLOWANCE_INSUFFICIENT');
  const remainingPool=total-spent-pendingPool;
  requireThat(balance>=(storage+headroom)*storagePrice+reserve+remainingPool+prepaid,'ESCROW_ACCOUNT_RESERVE_INSUFFICIENT');
 }
 async function holdAt(ctx,snapshot){
  const r=await rpc('query',{request_type:'call_function',account_id:contractId,method_name:'get_hold',args_base64:Buffer.from(JSON.stringify({job_id:ctx.terms.job_id})).toString('base64'),block_id:snapshot.block_hash});
  requireThat(r.block_hash===snapshot.block_hash&&Array.isArray(r.result)&&r.result.length<=16384&&r.result.every(n=>Number.isInteger(n)&&n>=0&&n<256),'ESCROW_HOLD_UNVERIFIED');
  let h;try{h=JSON.parse(Buffer.from(r.result).toString('utf8'));}catch{fail('ESCROW_HOLD_UNVERIFIED');}
  return checkedHold(ctx,h);
 }
 function checkedHold(ctx,h){
  if(h===null)return null;
  requireThat(h&&equal(h.terms,ctx.terms)&&h.binding_hash===ctx.bindingHash&&['Held','Delivered','PayoutPending','Paid','Refunded'].includes(h.state),'ESCROW_HOLD_BINDING_MISMATCH');
  uint(h.nonce);if(h.last_transfer_failure_nonce!==null)uint(h.last_transfer_failure_nonce);
  if(h.state==='Held')requireThat(h.delivery===null,'ESCROW_HOLD_DELIVERY_MISMATCH');
  if(h.delivery!==null)requireThat(Number.isInteger(h.delivery?.version)&&h.delivery.version>0&&h.delivery.version<=0xffffffff&&hex(h.delivery.output_hash,64),'ESCROW_HOLD_DELIVERY_MISMATCH');
  if(['Delivered','PayoutPending','Paid'].includes(h.state))requireThat(h.delivery!==null,'ESCROW_HOLD_DELIVERY_MISMATCH');
  return h;
 }
 async function cas(journal,path,value){if(await journal.create(path,value))return value;const winner=await journal.read(path);requireThat(winner!==null,'ESCROW_JOURNAL_UNAVAILABLE');return winner;}
 function intentFor(ctx,action,job){
  const d=['record','release'].includes(action)?deliveryFor(job):null;
  const args=action==='fund'?{terms:ctx.terms}:{job_id:job.id,binding_hash:ctx.bindingHash,...(d||{})};
  requireThat(BigInt(Buffer.byteLength(METHODS[action])+Buffer.byteLength(JSON.stringify(args)))<=MAX_CALL_BYTES,'ESCROW_CALL_BOUND');
  const opId=sha([DOMAIN,'operation',action,job.id,ctx.bindingHash,d?String(d.version):'',d?.output_hash||'']);
  const requestDigest=sha([DOMAIN,'request',contractId,publicKey,METHODS[action],canonical(args),String(GAS),'0']);
  return{opId,requestDigest,action,method:METHODS[action],args,bindingHash:ctx.bindingHash,publicKey};
 }
 function validateIntent(intent,ctx){
  requireThat(intent&&METHODS[intent.action]===intent.method&&intent.bindingHash===ctx.bindingHash&&intent.publicKey===publicKey,'ESCROW_JOURNAL_BINDING_MISMATCH');
  const d=['record','release'].includes(intent.action)?{version:intent.args?.version,outputSha256:intent.args?.output_hash}:null;
  const expected=intentFor(ctx,intent.action,{id:ctx.terms.job_id,delivery:d});
  requireThat(equal(intent,expected),'ESCROW_JOURNAL_INTENT_MISMATCH');
 }
 async function laneFor(ctx,journal){
  const laneId=sha([DOMAIN,'job-lane',contractId,ctx.terms.job_id]);
  const identity={domain:DOMAIN,contractId,jobId:ctx.terms.job_id,bindingHash:ctx.bindingHash};
  const old=await journal.read(opPath(laneId,0));if(old!==null)requireThat(equal(old,identity),'ESCROW_JOB_BINDING_CHANGED');
  const entries=[];
  for(let i=1;i<=LIMIT;i++){const item=await journal.read(opPath(laneId,i));if(item===null)return{laneId,identity,entries,next:i};validateIntent(item,ctx);requireThat(!entries.some(x=>x.opId===item.opId),'ESCROW_DUPLICATE_LANE');entries.push(item);}
  return{laneId,identity,entries,next:null};
 }
 function basePayment(ctx,job){return{kind:KIND,network:'testnet',contractId,bindingHash:ctx.bindingHash,awardedAtISO:job.payment.awardedAtISO,executionDeadlineNs:ctx.terms.execution_deadline_ns,reviewDeadlineNs:ctx.terms.review_deadline_ns};}
 function factsFor(ctx,job,h,entries,observed){
  const out={...basePayment(ctx,job),status:'NOT_FUNDED',verified:false};
  if(h){
   if(h.delivery){out.recordedVersion=h.delivery.version;out.recordedOutputHash=h.delivery.output_hash;}
   if(h.state==='Held'||h.state==='Delivered'){out.status=job.status==='ACCEPTED'&&h.state==='Delivered'&&equal(h.delivery,deliveryFor(job))?'RELEASE_READY':'HELD';out.verified=true;}
   else if(h.state==='PayoutPending')out.status='PAYOUT_PENDING';
   else out.status='UNKNOWN'; // Paid/Refunded alone is not transaction evidence.
  }
  for(const entry of entries){const o=observed.get(entry.opId);if(o?.transactionHash)out[hashField[entry.action]]=o.transactionHash;}
  const latest=entries.at(-1),o=latest&&observed.get(latest.opId);
  if(o){
   out.operation={action:latest.action,status:o.status,operationId:latest.opId,...(o.transactionHash?{transactionHash:o.transactionHash}:{})};
   if(o.code)out.code=o.code;
   if(o.status==='FINAL'){
    if(['release','refund'].includes(latest.action))requireThat(o.terminalHold&&equal(h,o.terminalHold),'ESCROW_FINAL_STATE_MISMATCH');
    if(latest.action==='release'&&h?.state==='Paid'&&equal(h.delivery,deliveryFor(job))){out.status='PAID';out.verified=true;}
    if(latest.action==='refund'&&h?.state==='Refunded'){out.status='REFUNDED';out.verified=true;}
   }else if(o.status==='ERROR'){out.status=h?.state==='PayoutPending'?'PAYOUT_PENDING':'ERROR';out.verified=false;}
   else {out.status=o.status==='UNKNOWN'?'UNKNOWN':pending[latest.action];out.verified=false;}
  }
  return out;
 }
 function validateNew(job,action,h,ctx){
  const ns=BigInt(now())*1000000n;
  if(action==='fund')requireThat(job.status==='AWARDED'&&!h&&ns<BigInt(ctx.terms.execution_deadline_ns),'ESCROW_FUND_STATE');
  if(action==='record'){
   const d=deliveryFor(job);requireThat(job.status==='DELIVERED'&&h&&['Held','Delivered'].includes(h.state)&&ns<=BigInt(ctx.terms.execution_deadline_ns),'ESCROW_RECORD_STATE');
   requireThat(d.version===(h.delivery?.version||0)+1,'ESCROW_DELIVERY_VERSION');
  }
  if(action==='release'){
   const d=deliveryFor(job),acceptance=job.decisions?.at(-1);
   requireThat(job.status==='ACCEPTED'&&h?.state==='Delivered'&&equal(d,h.delivery)&&ns<=BigInt(ctx.terms.review_deadline_ns)&&acceptance?.decision==='accept'&&acceptance.version===d.version&&acceptance.outputSha256===d.output_hash,'ESCROW_RELEASE_STATE');
  }
  if(action==='refund')requireThat(['AWARDED','DELIVERED','REVISION','ACCEPTED'].includes(job.status)&&h&&['Held','Delivered'].includes(h.state)&&ns>BigInt(ctx.terms.review_deadline_ns),'ESCROW_REFUND_STATE');
 }
 function transactionFor(intent,lease){return createTransaction(contractId,key.getPublicKey(),contractId,BigInt(lease.nonce),[actions.functionCall(intent.method,intent.args,GAS,0n)],baseDecode(lease.blockHash));}
 async function signedFor(intent,journal){
  let stage0=await journal.read(opPath(intent.opId,0));
  if(stage0===null){const live=await pin(true);stage0=await cas(journal,opPath(intent.opId,0),{intent,nonceFloor:live.nonce,blockHash:live.block_hash});}
  requireThat(equal(stage0.intent,intent)&&chainHash(stage0.blockHash),'ESCROW_JOURNAL_INTENT_MISMATCH');const floor=BigInt(uint(stage0.nonceFloor));
  let lease;
  for(let i=1;i<=LIMIT;i++){
   const nonce=String(floor+BigInt(i));uint(nonce);
   const candidate={opId:intent.opId,requestDigest:intent.requestDigest,nonce,blockHash:stage0.blockHash,publicKey};
   const winner=await cas(journal,`${ROOT}nonces/${keyId}/${nonce}.json`,candidate);
   if(winner.opId===intent.opId){requireThat(equal(winner,candidate),'ESCROW_NONCE_LEASE_MISMATCH');lease=winner;break;}
  }
  requireThat(lease,'ESCROW_NONCE_SLOTS_EXHAUSTED');
  let signed=await journal.read(opPath(intent.opId,1));
  if(signed===null){
   const live=await pin(true);requireThat(BigInt(live.nonce)<BigInt(lease.nonce),'ESCROW_LEASE_ALREADY_CONSUMED');
   const result=await signer.signTransaction(transactionFor(intent,lease));
   signed=await cas(journal,opPath(intent.opId,1),{opId:intent.opId,requestDigest:intent.requestDigest,nonce:lease.nonce,blockHash:lease.blockHash,transactionHash:baseEncode(result.txHash),signedBytes:Buffer.from(result.signedTransaction.encode()).toString('base64')});
  }
  return checkedSigned(intent,signed,lease);
 }
 function checkedSigned(intent,signed,lease){
  const bytes=decode64(signed.signedBytes);let tx;try{tx=decodeSignedTransaction(bytes);}catch{fail('ESCROW_SIGNED_JOURNAL_MISMATCH');}
  const expected=transactionFor(intent,lease);
  requireThat(signed.opId===intent.opId&&signed.requestDigest===intent.requestDigest&&signed.nonce===lease.nonce&&signed.blockHash===lease.blockHash&&Buffer.from(tx.transaction.encode()).equals(Buffer.from(expected.encode()))&&signed.transactionHash===baseEncode(hash(expected.encode())),'ESCROW_SIGNED_JOURNAL_MISMATCH');
  requireThat(tx.signature.enum==='ed25519Signature'&&key.verify(hash(expected.encode()),tx.signature.data),'ESCROW_SIGNED_JOURNAL_MISMATCH');
  return signed;
 }
 function checkTransaction(r,intent,signed){
  if(r?.final_execution_status!=='FINAL')return 'PENDING';
  const tx=r.transaction,c=tx?.actions?.[0]?.FunctionCall;
  requireThat(tx?.hash===signed.transactionHash&&tx.signer_id===contractId&&tx.receiver_id===contractId&&tx.public_key===publicKey&&uint(tx.nonce)===signed.nonce&&Array.isArray(tx.actions)&&tx.actions.length===1&&Object.keys(tx.actions[0]).join()==='FunctionCall'&&c.method_name===intent.method&&uint(c.gas)===String(GAS)&&c.deposit==='0'&&equal(JSON.parse(decode64(c.args).toString('utf8')),intent.args),'ESCROW_TRANSACTION_MISMATCH');
  requireThat(r.transaction_outcome?.id===signed.transactionHash&&Array.isArray(r.receipts_outcome)&&r.receipts_outcome.length>0&&r.receipts_outcome.length<=64,'ESCROW_RECEIPT_TREE_REQUIRED');
  const nodes=new Map();let failed=Object.hasOwn(r.status||{},'Failure');
  for(const node of [r.transaction_outcome,...r.receipts_outcome]){
   const o=node?.outcome,s=o?.status;
   requireThat(chainHash(node?.id)&&chainHash(node.block_hash)&&!nodes.has(node.id)&&Array.isArray(o?.receipt_ids)&&o.receipt_ids.length<=64&&new Set(o.receipt_ids).size===o.receipt_ids.length&&o.receipt_ids.every(chainHash)&&s&&Object.keys(s).length===1,'ESCROW_RECEIPT_TREE_REQUIRED');
   if(Object.hasOwn(s,'Failure'))failed=true;
   else if(typeof s.SuccessValue==='string')decode64(s.SuccessValue);
   else requireThat(typeof s.SuccessReceiptId==='string'&&o.receipt_ids.includes(s.SuccessReceiptId),'ESCROW_RECEIPT_TREE_REQUIRED');
   nodes.set(node.id,node);
  }
  const seen=new Set(),todo=[signed.transactionHash];
  while(todo.length){const id=todo.pop();requireThat(!seen.has(id)&&nodes.has(id),'ESCROW_RECEIPT_TREE_REQUIRED');seen.add(id);todo.push(...nodes.get(id).outcome.receipt_ids);}
  requireThat(seen.size===nodes.size,'ESCROW_RECEIPT_TREE_REQUIRED');
  if(failed)return 'ERROR';
  requireThat(typeof r.status?.SuccessValue==='string','ESCROW_FINAL_RESULT_REQUIRED');decode64(r.status.SuccessValue);
  return nodes;
 }
 function checkPayout(r,nodes,intent,h){
  requireThat(h?.state==='Paid'&&equal(h.delivery,{version:intent.args.version,output_hash:intent.args.output_hash})&&r.status.SuccessValue===Buffer.from('true').toString('base64'),'ESCROW_PAYOUT_EVIDENCE_REQUIRED');
  requireThat(Array.isArray(r.receipts)&&r.receipts.length<=64,'ESCROW_PAYOUT_EVIDENCE_REQUIRED');
  const bodies=new Map();for(const item of r.receipts){requireThat(chainHash(item?.receipt_id)&&!bodies.has(item.receipt_id)&&nodes.has(item.receipt_id),'ESCROW_PAYOUT_EVIDENCE_REQUIRED');bodies.set(item.receipt_id,item);}
  const transfers=r.receipts.filter(item=>item.predecessor_id===contractId&&item.receiver_id===h.terms.provider&&equal(item.receipt?.Action?.actions,[{Transfer:{deposit:h.terms.amount}}]));
  requireThat(transfers.length===1,'ESCROW_PAYOUT_EVIDENCE_REQUIRED');
  const transfer=nodes.get(transfers[0].receipt_id)?.outcome;
  requireThat(transfer?.executor_id===h.terms.provider&&equal(transfer.status,{SuccessValue:''}),'ESCROW_PAYOUT_EVIDENCE_REQUIRED');
  const callbacks=r.receipts.filter(item=>{
   const list=item.receipt?.Action?.actions,c=list?.[0]?.FunctionCall;
   if(item.predecessor_id!==contractId||item.receiver_id!==contractId||!Array.isArray(list)||list.length!==1||Object.keys(list[0]).join()!=='FunctionCall'||c?.method_name!=='on_transfer'||c.deposit!=='0'||uint(c.gas)!=='20000000000000')return false;
   try{return equal(JSON.parse(decode64(c.args).toString('utf8')),{job_id:intent.args.job_id,binding_hash:intent.bindingHash,nonce:h.nonce});}catch{return false;}
  });
  requireThat(callbacks.length===1,'ESCROW_PAYOUT_EVIDENCE_REQUIRED');
  const callback=nodes.get(callbacks[0].receipt_id)?.outcome;
  requireThat(callback?.executor_id===contractId&&equal(callback.status,{SuccessValue:Buffer.from('true').toString('base64')}),'ESCROW_PAYOUT_EVIDENCE_REQUIRED');
 }
 function checkFinalState(r,result,intent,h){
  if(intent.action==='release')checkPayout(r,result,intent,h);
  if(intent.action==='fund')requireThat(h&&['Held','Delivered','PayoutPending','Paid','Refunded'].includes(h.state),'ESCROW_FINAL_STATE_MISMATCH');
  if(intent.action==='record')requireThat(h?.delivery&&h.delivery.version>=intent.args.version&&(h.delivery.version!==intent.args.version||h.delivery.output_hash===intent.args.output_hash),'ESCROW_FINAL_STATE_MISMATCH');
  if(intent.action==='refund')requireThat(h?.state==='Refunded','ESCROW_FINAL_STATE_MISMATCH');
 }
 function finalOutcome(intent,signed,final,ctx){
  requireThat(final.opId===intent.opId&&final.requestDigest===intent.requestDigest&&final.transactionHash===signed.transactionHash&&['FINAL','ERROR'].includes(final.status),'ESCROW_JOURNAL_FINAL_MISMATCH');
  if(final.status!=='FINAL')return null;
  if(!final.certificate){requireThat(final.certificateHash===undefined,'ESCROW_JOURNAL_CERTIFICATE_MISMATCH');return null;} // Legacy bare status is not evidence.
  try{
   const c=final.certificate;
   requireThat(Buffer.byteLength(JSON.stringify(final))<=MAX_CERTIFICATE_RECORD&&hex(final.certificateHash,64)&&sha(canonical(c))===final.certificateHash,'ESCROW_CERTIFICATE_INVALID');
   requireThat(c.version===1&&c.domain===DOMAIN&&c.network==='testnet'&&c.contractId===contractId&&c.codeHash===codeHash&&c.opId===intent.opId&&c.requestDigest===intent.requestDigest&&c.transactionHash===signed.transactionHash&&chainHash(c.holdSnapshot?.blockHash),'ESCROW_CERTIFICATE_INVALID');
   const h=checkedHold(ctx,c.holdSnapshot.hold),result=checkTransaction(c.receiptEvidence,intent,signed);
   requireThat(result instanceof Map,'ESCROW_CERTIFICATE_INVALID');
   checkFinalState(c.receiptEvidence,result,intent,h);
   return{status:'FINAL',transactionHash:signed.transactionHash,...(['release','refund'].includes(intent.action)?{terminalHold:h}:{})};
  }catch{fail('ESCROW_JOURNAL_CERTIFICATE_MISMATCH');}
 }
 async function observe(intent,ctx,journal){
  const [initial,signed,attempt,final]=await Promise.all([0,1,2,3].map(stage=>journal.read(opPath(intent.opId,stage))));
  if(initial!==null)requireThat(equal(initial.intent,intent),'ESCROW_JOURNAL_INTENT_MISMATCH');
  if(signed===null){requireThat(attempt===null&&final===null,'ESCROW_JOURNAL_ORDER_MISMATCH');return{status:'PENDING'};}
  requireThat(initial&&signed.opId===intent.opId&&signed.requestDigest===intent.requestDigest&&chainHash(signed.transactionHash),'ESCROW_JOURNAL_INTENT_MISMATCH');
  if(attempt===null){requireThat(final===null,'ESCROW_JOURNAL_ORDER_MISMATCH');return{status:'PENDING',transactionHash:signed.transactionHash};}
  requireThat(equal(attempt,{opId:intent.opId,requestDigest:intent.requestDigest,transactionHash:signed.transactionHash}),'ESCROW_JOURNAL_ATTEMPT_MISMATCH');
  const transactionHash=signed.transactionHash;
  if(final!==null){const certified=finalOutcome(intent,signed,final,ctx);if(certified)return certified;}
  try{
   let r;try{r=await rpc('tx_status',{tx_hash:transactionHash,sender_account_id:contractId,wait_until:'FINAL'});}catch(e){if(e.code!=='ESCROW_RPC_METHOD_UNAVAILABLE')throw e;r=await rpc('EXPERIMENTAL_tx_status',{tx_hash:transactionHash,sender_account_id:contractId,wait_until:'FINAL'});}
   const result=checkTransaction(r,intent,signed);
   if(result==='PENDING')return{status:'PENDING',transactionHash};
   const snapshot=await pin(),h=await holdAt(ctx,snapshot);
   if(result==='ERROR'){
    // Retain the existing failure journal. Pending native transfers remain nonrefundable.
    const outcome={status:'ERROR',transactionHash,code:'ESCROW_FINAL_TRANSACTION_FAILED'};
    const winner=await cas(journal,opPath(intent.opId,3),{...outcome,opId:intent.opId,requestDigest:intent.requestDigest});
    requireThat(winner.status==='ERROR'&&winner.opId===intent.opId&&winner.requestDigest===intent.requestDigest&&winner.transactionHash===transactionHash,'ESCROW_JOURNAL_FINAL_MISMATCH');return outcome;
   }
   checkFinalState(r,result,intent,h);
   // Atomically retain actual RPC evidence BEFORE returning verified FINAL.
   // A digest pins the complete raw parsed result and the observed bound hold.
   const certificate={version:1,domain:DOMAIN,network:'testnet',contractId,codeHash,opId:intent.opId,requestDigest:intent.requestDigest,transactionHash,receiptEvidence:r,holdSnapshot:{blockHash:snapshot.block_hash,hold:h}};
   const record={status:'FINAL',transactionHash,opId:intent.opId,requestDigest:intent.requestDigest,certificate,certificateHash:sha(canonical(certificate))};
   requireThat(Buffer.byteLength(JSON.stringify(record))<=MAX_CERTIFICATE_RECORD,'ESCROW_CERTIFICATE_BOUND');
   const winner=await cas(journal,opPath(intent.opId,3),record);
   // Concurrent observers can legitimately see different finalized blocks. Validate
   // the immutable winner's evidence rather than requiring byte-identical snapshots.
   const certified=finalOutcome(intent,signed,winner,ctx);
   if(certified)return certified;
   requireThat(winner.status==='FINAL','ESCROW_JOURNAL_FINAL_MISMATCH');
   // An old immutable status without a certificate still needs fresh RPC evidence
   // each time; it never becomes an offline finality assertion.
   return{status:'FINAL',transactionHash,...(['release','refund'].includes(intent.action)?{terminalHold:h}:{})};
  }catch(e){
   if(e.code?.startsWith('ESCROW_JOURNAL'))throw e;
   return{status:'UNKNOWN',transactionHash,code:e.code==='ESCROW_PAYOUT_EVIDENCE_REQUIRED'?e.code:'ESCROW_UNKNOWN_FINALITY'};
  }
 }
 async function run(intent,ctx,journal){
  const existingAttempt=await journal.read(opPath(intent.opId,2));
  if(existingAttempt!==null)return observe(intent,ctx,journal); // absolutely no re-sign or re-send
  let signed;
  try{
   signed=await signedFor(intent,journal);
   // Prices, remaining allowance, account storage/balance and contract pool may
   // change after signing. Recheck before the irreversible broadcast marker.
   await pin(true);
  }catch(e){
   if(!BUDGET_CODES.has(e.code))throw e;
   if(await journal.read(opPath(intent.opId,2))!==null)return observe(intent,ctx,journal);
   return{status:'ERROR',code:e.code,...(signed?{transactionHash:signed.transactionHash}:{})};
  }
  const marker={opId:intent.opId,requestDigest:intent.requestDigest,transactionHash:signed.transactionHash};
  if(await journal.create(opPath(intent.opId,2),marker)){
   // Price/nonce changes AFTER this point can cause rejection or uncertainty.
   // Never replace or resend: only observe this exact transaction hash.
   try{await rpc('send_tx',{signed_tx_base64:signed.signedBytes,wait_until:'NONE'});}catch{/* reconcile only; never retransmit */}
  }else requireThat(equal(await journal.read(opPath(intent.opId,2)),marker),'ESCROW_JOURNAL_ATTEMPT_MISMATCH');
  return observe(intent,ctx,journal);
 }
 async function resumeActionFor(ctx,job,h,entries,observed,journal){
  const intent=entries.at(-1),o=intent&&observed.get(intent.opId);
  // An ERROR/UNKNOWN is never a resume authorization. Refresh must first prove
  // that the LAST operation has valid persisted bytes and no broadcast attempt.
  if(!intent||o?.status!=='PENDING'||!o.transactionHash)return null;
  const [initial,signed,attempt,final]=await Promise.all([0,1,2,3].map(stage=>journal.read(opPath(intent.opId,stage))));
  if(attempt!==null||final!==null||signed===null)return null;
  requireThat(initial&&equal(initial.intent,intent)&&chainHash(initial.blockHash),'ESCROW_JOURNAL_INTENT_MISMATCH');
  const nonce=BigInt(uint(signed.nonce)),floor=BigInt(uint(initial.nonceFloor));
  requireThat(nonce>floor&&nonce<=floor+BigInt(LIMIT)&&signed.blockHash===initial.blockHash,'ESCROW_NONCE_LEASE_MISMATCH');
  const lease=await journal.read(`${ROOT}nonces/${keyId}/${signed.nonce}.json`);
  requireThat(equal(lease,{opId:intent.opId,requestDigest:intent.requestDigest,nonce:signed.nonce,blockHash:initial.blockHash,publicKey}),'ESCROW_NONCE_LEASE_MISMATCH');
  checkedSigned(intent,signed,lease); // Signature/hash/args checked WITHOUT signing.
  try{
   if(!equal(intent,intentFor(ctx,intent.action,job)))return null;
   validateNew(job,intent.action,h,ctx);
  }catch{return null;}
  // Misses are never cached. A concurrent winner suppresses the hint; even a
  // later race is safe because run() reconciles an existing marker, never resends.
  return await journal.read(opPath(intent.opId,2))===null?intent.action:null;
 }
 function journalForOperate(){
  const present=new Map();
  return{
   async read(path){
    if(present.has(path))return present.get(path);
    const record=await store.read(path);
    if(record!==null)present.set(path,record); // A miss can become a concurrent CAS winner.
    return record;
   },
   async create(path,value){
    if(present.has(path))return false;
    const created=await store.create(path,value);
    if(created)present.set(path,value);
    return created;
   }
  };
 }
 async function operate(job,action){
  const journal=journalForOperate();
  requireThat(action==='refresh'||Object.hasOwn(METHODS,action),'ESCROW_ACTION_REJECTED');
  requireThat(job?.payment?.kind===KIND,'ESCROW_JOB_KIND_MISMATCH');
  const ctx=termsForJob(job,contractId);
  requireThat((job.payment.contractId===undefined||job.payment.contractId===contractId)&&(job.payment.bindingHash===undefined||job.payment.bindingHash===ctx.bindingHash),'ESCROW_JOB_BINDING_CHANGED');
  const lane=await laneFor(ctx,journal),observed=new Map();
  let snapshot=await pin(),h=await holdAt(ctx,snapshot);
  // Certificates are revalidated against their exact intent/hash. No cached RPC:
  // code and bound hold are freshly observed both before and after reconciliation.
  for(const item of lane.entries)observed.set(item.opId,await observe(item,ctx,journal));
  const last=lane.entries.at(-1);
  if(action!=='refresh'){
   const intent=intentFor(ctx,action,job),existing=lane.entries.find(x=>x.opId===intent.opId);
   if(existing){
    requireThat(equal(existing,intent),'ESCROW_JOURNAL_INTENT_MISMATCH');
    // Older completed actions cannot regress the latest state or trigger writes.
    if(last.opId===intent.opId&&!['FINAL','ERROR'].includes(observed.get(intent.opId)?.status)){
     if(await journal.read(opPath(intent.opId,2))===null)validateNew(job,action,h,ctx);
     observed.set(intent.opId,await run(intent,ctx,journal));
    }
   }else if(!last||['FINAL','ERROR'].includes(observed.get(last.opId)?.status)){
    validateNew(job,action,h,ctx);
    requireThat(lane.next!==null,'ESCROW_OPERATION_LIMIT');
    requireThat(equal(await cas(journal,opPath(lane.laneId,0),lane.identity),lane.identity),'ESCROW_JOB_BINDING_CHANGED');
    const claimed=await cas(journal,opPath(lane.laneId,lane.next),intent);
    validateIntent(claimed,ctx);lane.entries.push(claimed);
    if(equal(claimed,intent))observed.set(intent.opId,await run(intent,ctx,journal));
    else observed.set(claimed.opId,await observe(claimed,ctx,journal));
   }
  }
  snapshot=await pin();h=await holdAt(ctx,snapshot);
  const facts=factsFor(ctx,job,h,lane.entries,observed);
  const resumeAction=await resumeActionFor(ctx,job,h,lane.entries,observed,journal);
  if(resumeAction)facts.operation.resumeAction=resumeAction;
  return facts;
 }
 return{kind:KIND,contractId,operate};
}
