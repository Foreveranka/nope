// Explicit UNIT fixtures. No test below contacts or mutates an actual chain.
import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {KeyPair,KeyPairSigner,decodeSignedTransaction,baseEncode} from 'near-api-js';
import {createEscrowService,termsForJob} from './escrow.mjs';

const KIND='SPONSORED_TESTNET_ESCROW',CONTRACT='unit-escrow.testnet';
const digest=s=>createHash('sha256').update(s).digest();
const ch=s=>baseEncode(digest(s));
const CODE=ch('unit code'),BLOCK=ch('unit final block');
const canonical=v=>JSON.stringify(v,(_,x)=>x&&typeof x==='object'&&!Array.isArray(x)?Object.fromEntries(Object.keys(x).sort().map(k=>[k,x[k]])):x);
const copy=v=>v===undefined?undefined:structuredClone(v);
const b64=v=>Buffer.from(typeof v==='string'?v:JSON.stringify(v)).toString('base64');
const NOW=Date.parse('2026-11-14T10:00:00.000Z');
function job(){return{id:'a'.repeat(32),buyerId:'b'.repeat(32),taskHash:'c'.repeat(64),programHash:'d'.repeat(64),status:'AWARDED',payment:{kind:KIND,status:'NOT_FUNDED',awardedAtISO:new Date(NOW).toISOString()},selectedOffer:{providerId:'e'.repeat(32),paymentAccount:'unit-provider.testnet',amountYocto:'1000000000000000000'},delivery:null,decisions:[]};}
function memory(){const records=new Map();return{records,read:async p=>copy(records.get(p)??null),create:async(p,v)=>{if(records.has(p))return false;records.set(p,copy(v));return true;}};}
function fixture(options={}){
 const CONTRACT=options.contractId??'unit-escrow.testnet'; // Explicit UNIT account override, never a live RPC.
 const key=KeyPair.fromRandom('ed25519'),env={NOPE_ESCROW_CONTRACT_ID:CONTRACT,NOPE_ESCROW_CODE_HASH:CODE,NOPE_ESCROW_SIGNER_KEY:key.toString()};
 const store=memory(),holds=new Map(),results=new Map(),sent=[],requests=[];
 const state={chain:'testnet',code:CODE,nonce:9007199254740993n,permission:{FunctionCall:{receiver_id:CONTRACT,method_names:['fund','record_delivery','accept_and_release','refund'],allowance:'100000000000000000000000'}},lost:false,unknown:false,pending:false,failed:false,omitTransfer:false,wrongTransfer:false,callbackFailure:false,outerOnly:false,clock:NOW,inflationRatio:[1,1],gasPrice:'100000000',storagePrice:'10000000000000000000',storageUsage:203000,balance:'2900000000000000000000000',...options};
 function outcome(id,executor,children=[],status={SuccessValue:''}){return{id,block_hash:BLOCK,outcome:{executor_id:executor,receipt_ids:children,status}};}
 async function fetcher(url,init){
  assert.equal(url,'https://test.rpc.fastnear.com');assert.equal(init.redirect,'error');
  const {method,params}=JSON.parse(init.body);requests.push({method,params});let result;
  if(method==='status')result={chain_id:state.chain};
  else if(method==='query'){
   if(params.request_type==='view_account')result={code_hash:state.code,block_hash:BLOCK,amount:state.balance,storage_usage:state.storageUsage};
   else if(params.request_type==='view_access_key'){
    assert.equal(params.account_id,CONTRACT);assert.equal(params.public_key,key.getPublicKey().toString());
    // Deliberately a raw JSON numeric u64 greater than Number.MAX_SAFE_INTEGER.
    return new Response(`{"jsonrpc":"2.0","result":{"nonce":${state.nonce},"permission":${JSON.stringify(state.permission)},"block_hash":"${BLOCK}"}}`);
   }else if(params.request_type==='call_function'){
    assert.equal(params.block_id,BLOCK);
    const args=JSON.parse(Buffer.from(params.args_base64,'base64'));let value;
    if(params.method_name==='get_hold')value=holds.get(args.job_id)??null;
    else if(params.method_name==='get_config'){
     assert.deepEqual(args,{});
     let held=0n,spent=0n,pending=0n;
     for(const h of holds.values()){if(h.state==='Paid')spent+=BigInt(h.terms.amount);else if(h.state!=='Refunded'){held+=BigInt(h.terms.amount);if(h.state==='PayoutPending')pending+=BigInt(h.terms.amount);}}
     value={domain:'NOPE:WORKSPACE-ESCROW:V1:testnet',network:'testnet',contract_id:CONTRACT,max_holds:50,max_hold_amount:'10000000000000000000000',total_pool:'50000000000000000000000',available:String(50000000000000000000000n-held-spent),held:String(held),spent:String(spent),pending:String(pending),hold_count:holds.size,gas_reserve:'100000000000000000000000',storage_headroom_bytes:65536,...state.configOverride};
    }else throw Error('Unexpected fixture view');
    result={result:[...Buffer.from(JSON.stringify(value))],block_hash:params.method_name==='get_config'?(state.configBlock||BLOCK):BLOCK};
   }else throw Error('Unexpected fixture query');
  }else if(method==='send_tx'){
   const signed=decodeSignedTransaction(Buffer.from(params.signed_tx_base64,'base64')),tx=signed.transaction,call=tx.actions[0].functionCall,args=JSON.parse(Buffer.from(call.args));
   assert.equal(tx.signerId,CONTRACT);assert.equal(tx.receiverId,CONTRACT);assert.equal(tx.actions.length,1);assert.equal(call.gas,150000000000000n);assert.equal(call.deposit,0n);
   assert.ok(key.verify(digest(tx.encode()),signed.signature.data));
   const hash=baseEncode(digest(tx.encode()));sent.push({hash,tx,args,method:call.methodName});state.nonce=tx.nonce;
   const txView={hash,signer_id:CONTRACT,receiver_id:CONTRACT,public_key:key.getPublicKey().toString(),nonce:String(tx.nonce),actions:[{FunctionCall:{method_name:call.methodName,args:Buffer.from(call.args).toString('base64'),gas:Number(call.gas),deposit:'0'}}]};
   const root=ch(hash+'root'),transfer=ch(hash+'transfer'),callback=ch(hash+'callback');
   let h=holds.get(args.job_id||args.terms?.job_id);
   if(call.methodName==='fund'){
    h={terms:args.terms,binding_hash:termsForJob({...job(),id:args.terms.job_id},CONTRACT).bindingHash,state:'Held',nonce:'0',delivery:null,last_transfer_failure_nonce:null};holds.set(args.terms.job_id,h);
   }else if(call.methodName==='record_delivery'){h.delivery={version:args.version,output_hash:args.output_hash};h.state='Delivered';}
   else if(call.methodName==='accept_and_release'){
    h.nonce=String(BigInt(h.nonce)+1n);h.state=state.pending?'PayoutPending':state.failed||state.callbackFailure?'Delivered':'Paid';if(state.failed)h.last_transfer_failure_nonce=h.nonce;
   }else if(call.methodName==='refund')h.state='Refunded';else throw Error('Unexpected fixture mutation');
   const release=call.methodName==='accept_and_release';
   let receiptNodes=[outcome(root,CONTRACT,release?[transfer,callback]:[])];
   let receiptBodies=[];
   if(release){
    receiptNodes.push(outcome(transfer,h.terms.provider,[],state.failed?{Failure:{ActionError:'unit transfer failure'}}:{SuccessValue:''}),outcome(callback,CONTRACT,[],{SuccessValue:b64(state.failed||state.callbackFailure?'false':'true')}));
    if(!state.omitTransfer)receiptBodies.push({receipt_id:transfer,predecessor_id:CONTRACT,receiver_id:h.terms.provider,receipt:{Action:{actions:[{Transfer:{deposit:state.wrongTransfer?'2':h.terms.amount}}]}}});
    receiptBodies.push({receipt_id:callback,predecessor_id:CONTRACT,receiver_id:CONTRACT,receipt:{Action:{actions:[{FunctionCall:{method_name:'on_transfer',args:b64({job_id:args.job_id,binding_hash:args.binding_hash,nonce:h.nonce}),gas:20000000000000,deposit:'0'}}]}}});
   }
   if(state.outerOnly){receiptNodes=[outcome(root,CONTRACT)];receiptBodies=[];}
   if(state.receiptPadding)receiptNodes[0].outcome.logs=['UNIT bounded certificate fixture '+ 'x'.repeat(state.receiptPadding)];
   result={final_execution_status:state.pending?'EXECUTED':'FINAL',status:{SuccessValue:release?b64(state.failed||state.callbackFailure?'false':'true'):b64(h)},transaction:txView,transaction_outcome:outcome(hash,CONTRACT,[root],{SuccessReceiptId:root}),receipts_outcome:receiptNodes,receipts:receiptBodies};results.set(hash,copy(result));
   if(state.unknownNext)state.unknown=true;
   if(state.lost)throw Error('UNIT: server received tx, response lost');result={final_execution_status:'NONE'};
  }else if(method==='gas_price'){assert.deepEqual(params,[BLOCK]);if(state.priceUnavailable)return Response.json({error:{code:-32000,message:'UNIT prebroadcast RPC failure'}});result={gas_price:state.gasPrice};
  }else if(method==='EXPERIMENTAL_protocol_config'){assert.equal(params.block_id,BLOCK);result={runtime_config:{storage_amount_per_byte:state.storagePrice,transaction_costs:{pessimistic_gas_price_inflation_ratio:state.inflationRatio,action_receipt_creation_config:{send_sir:108059500000,send_not_sir:108059500000,execution:108059500000},action_creation_config:{function_call_cost:{send_sir:231986150000,send_not_sir:231986150000,execution:231986150000},function_call_cost_per_byte:{send_sir:2235934,send_not_sir:2235934,execution:2235934}},...state.feeOverride}}};
  }else if(method==='tx_status'||method==='EXPERIMENTAL_tx_status'){
   if(state.unknown||!results.has(params.tx_hash))return Response.json({error:{code:-32000,message:'UNIT unknown/pruned'}});
   result=copy(results.get(params.tx_hash));
  }else throw Error('Unexpected fixture RPC '+method);
  return Response.json({jsonrpc:'2.0',result});
 }
 const service=()=>createEscrowService({store,env,now:()=>state.clock,fetcher});
 return{key,env,store,holds,results,sent,requests,state,service};
}
async function fund(f,j=job()){j.payment=await f.service().operate(j,'fund');assert.equal(j.payment.status,'HELD');assert.equal(j.payment.verified,true);return j;}
async function record(f,j){j.status='DELIVERED';j.delivery={version:1,outputSha256:'f'.repeat(64)};j.payment=await f.service().operate(j,'record');assert.equal(j.payment.status,'HELD');assert.equal(j.payment.recordedVersion,1);assert.equal(j.payment.verified,true);return j;}
function accept(j){j.status='ACCEPTED';j.decisions.push({decision:'accept',version:j.delivery.version,outputSha256:j.delivery.outputSha256});}

test('UNIT: absent config disables, partial config and unbounded providers/amounts reject',()=>{
 assert.equal(createEscrowService({env:{}}),null);
 assert.throws(()=>createEscrowService({env:{NOPE_ESCROW_CONTRACT_ID:CONTRACT}}),/PARTIAL_CONFIG/);
 const j=job(),t=termsForJob(j,CONTRACT);assert.match(t.bindingHash,/^[a-f0-9]{64}$/);assert.equal(t.terms.execution_deadline_ns,String(BigInt(NOW)*1000000n+86400000000000n));
 for(const value of ['0','999999999999999999','10000000000000000000001','01','1e18',1000000000000000000]){j.selectedOffer.amountYocto=value;assert.throws(()=>termsForJob(j,CONTRACT),/AMOUNT/);}
 j.selectedOffer.amountYocto='1000000000000000000';j.selectedOffer.paymentAccount='buyer.near';assert.throws(()=>termsForJob(j,CONTRACT),/PROVIDER/);
});

test('UNIT: finalized fund/record/release requires exact native transfer + callback + Paid hold',async()=>{
 const f=fixture(),j=await record(f,await fund(f));accept(j);
 const p=await f.service().operate(j,'release');assert.equal(p.status,'PAID');assert.equal(p.verified,true);assert.equal(p.releaseTransactionHash,f.sent[2].hash);assert.equal(f.sent[0].tx.nonce,9007199254740994n);
 j.payment=p;j.status='PAID';const stable=await f.service().operate(j,'refresh');assert.deepEqual(stable,p);assert.equal(f.sent.length,3);
 assert.ok(!JSON.stringify(p).includes('signedBytes'));assert.ok(!JSON.stringify(p).includes(f.env.NOPE_ESCROW_SIGNER_KEY));
});

test('UNIT: concurrent same-operation CAS signs deterministic transaction and broadcasts only once',async()=>{
 const f=fixture(),j=job();const results=await Promise.all(Array.from({length:6},()=>f.service().operate(copy(j),'fund')));
 assert.equal(f.sent.length,1);assert.equal(new Set(results.map(x=>x.fundTransactionHash)).size,1);
 const leases=[...f.store.records].filter(([p])=>p.includes('/nonces/'));assert.equal(leases.length,1);assert.equal(leases[0][1].nonce,'9007199254740994');
 assert.equal([...f.store.records.keys()].filter(p=>p.endsWith('/0002.json')).length,1);
});

test('UNIT: lost broadcast + restart + unknown finality never re-signs, re-sends or refunds',async()=>{
 const f=fixture({lost:true,unknown:true}),j=job();let signatures=0;
 const original=KeyPairSigner.prototype.signTransaction;
 KeyPairSigner.prototype.signTransaction=async function(...args){signatures++;return original.apply(this,args);};
 try{
  j.payment=await f.service().operate(j,'fund');assert.equal(j.payment.status,'UNKNOWN');assert.equal(signatures,1);
  assert.equal((await f.service().operate(j,'fund')).status,'UNKNOWN');assert.equal((await f.service().operate(j,'refresh')).status,'UNKNOWN');
  f.state.clock+=3*86400000;assert.equal((await f.service().operate(j,'refund')).status,'UNKNOWN');assert.equal(signatures,1);assert.equal(f.sent.length,1);
  f.state.unknown=false;const reconciled=await f.service().operate(j,'refresh');assert.equal(reconciled.status,'HELD');assert.equal(reconciled.verified,true);assert.equal(signatures,1);
 }finally{KeyPairSigner.prototype.signTransaction=original;}
});

test('UNIT: crash after persisted signed bytes, before attempt, resumes same bytes only on explicit action',async()=>{
 const f=fixture(),j=job();const create=f.store.create;let crash=true;
 f.store.create=async(p,v)=>{if(crash&&p.endsWith('/0002.json')){crash=false;throw Error('UNIT crash before broadcast marker');}return create(p,v);};
 await assert.rejects(f.service().operate(j,'fund'),/UNIT crash/);assert.equal(f.sent.length,0);
 const before=[...f.store.records].find(([p,v])=>p.endsWith('/0001.json')&&v.signedBytes)[1];
 let signatures=0;const original=KeyPairSigner.prototype.signTransaction;KeyPairSigner.prototype.signTransaction=async function(...a){signatures++;return original.apply(this,a);};
 try{assert.equal((await f.service().operate(j,'refresh')).status,'FUNDING_PENDING');assert.equal(f.sent.length,0);assert.equal((await f.service().operate(j,'fund')).status,'HELD');assert.equal(signatures,0);assert.equal(f.sent[0].hash,before.transactionHash);}finally{KeyPairSigner.prototype.signTransaction=original;}
});

test('UNIT: crash after attempt marker and before send stays UNKNOWN, never broadcasts on retry',async()=>{
 const f=fixture(),j=job();const create=f.store.create;let crash=true;
 f.store.create=async(p,v)=>{const r=await create(p,v);if(crash&&p.endsWith('/0002.json')){crash=false;throw Error('UNIT crash after attempt marker');}return r;};
 await assert.rejects(f.service().operate(j,'fund'),/UNIT crash/);assert.equal(f.sent.length,0);
 assert.equal((await f.service().operate(j,'fund')).status,'UNKNOWN');assert.equal((await f.service().operate(j,'refresh')).status,'UNKNOWN');assert.equal(f.sent.length,0);
});

test('UNIT: wrong network/code/full-access/extra methods/unlimited or excessive allowance never sign or send',async()=>{
 for(const mutate of [f=>f.state.chain='mainnet',f=>f.state.code=ch('other code'),f=>f.state.permission='FullAccess',f=>f.state.permission.FunctionCall.method_names.push('on_transfer'),f=>f.state.permission.FunctionCall.method_names=[],f=>f.state.permission.FunctionCall.receiver_id='other.testnet',f=>f.state.permission.FunctionCall.allowance=null,f=>f.state.permission.FunctionCall.allowance='200000000000000000000001']){
  const f=fixture();mutate(f);await assert.rejects(f.service().operate(job(),'fund'),/ESCROW_/);assert.equal(f.sent.length,0);assert.equal([...f.store.records.values()].some(v=>v.signedBytes),false);
 }
});

test('UNIT: unbound job/changed price/award/hash and mismatched chain hold reject without another send',async()=>{
 const f=fixture(),j=await fund(f);
 for(const mutate of [x=>x.id='0'.repeat(32),x=>x.selectedOffer.amountYocto='2000000000000000000',x=>x.taskHash='0'.repeat(64),x=>x.payment.awardedAtISO=new Date(NOW+1).toISOString(),x=>x.payment.kind='DIRECT_TESTNET_TRANSFER']){
  const bad=copy(j);mutate(bad);await assert.rejects(f.service().operate(bad,'release'),/ESCROW_/);assert.equal(f.sent.length,1);
 }
 f.holds.get(j.id).terms.program_hash='0'.repeat(64);await assert.rejects(f.service().operate(j,'refresh'),/BINDING_MISMATCH/);
});

test('UNIT: delivery version/hash and accepted decision must match exact latest recorded delivery',async()=>{
 const f=fixture(),j=await fund(f);j.status='DELIVERED';j.delivery={version:2,outputSha256:'f'.repeat(64)};
 await assert.rejects(f.service().operate(j,'record'),/VERSION/);assert.equal(f.sent.length,1);
 j.delivery.version=1;await record(f,j);accept(j);j.decisions[0].outputSha256='0'.repeat(64);
 await assert.rejects(f.service().operate(j,'release'),/RELEASE_STATE/);assert.equal(f.sent.length,2);
 j.decisions[0].outputSha256=j.delivery.outputSha256;j.delivery.outputSha256='0'.repeat(64);
 await assert.rejects(f.service().operate(j,'release'),/RELEASE_STATE/);assert.equal(f.sent.length,2);
});

test('UNIT: unknown, missing/incorrect transfer, outer-only success and failed callback never establish payment',async()=>{
 for(const mode of ['omitTransfer','wrongTransfer','callbackFailure','outerOnly','unknown','pending','failed']){
  const f=fixture(),j=await record(f,await fund(f));accept(j);f.state[mode==='unknown'?'unknownNext':mode]=true;
  const p=await f.service().operate(j,'release');assert.notEqual(p.status,'PAID',mode);assert.equal(p.verified,false);assert.ok(['UNKNOWN','PAYOUT_PENDING','ERROR'].includes(p.status),mode+': '+p.status);
  j.payment=p;await f.service().operate(j,'release');await f.service().operate(j,'refresh');assert.equal(f.sent.length,3,mode);
  if(mode==='pending'){f.state.clock+=3*86400000;await f.service().operate(j,'refund');assert.equal(f.sent.length,3);}
 }
});

test('UNIT: refund is deadline-gated and exact finalized Refunded requires transaction hash',async()=>{
 const f=fixture(),j=await fund(f);await assert.rejects(f.service().operate(j,'refund'),/REFUND_STATE/);
 f.state.clock+=2*86400000+1;const p=await f.service().operate(j,'refund');assert.equal(p.status,'REFUNDED');assert.equal(p.verified,true);assert.equal(p.refundTransactionHash,f.sent[1].hash);j.payment=p;j.status='REFUNDED';assert.deepEqual(await f.service().operate(j,'refresh'),p);assert.equal(f.sent.length,2);
});

test('UNIT: immutable signed journal and nonce lease tampering reject before broadcast',async()=>{
 const f=fixture(),j=job(),create=f.store.create;let crash=true;
 f.store.create=async(p,v)=>{if(crash&&p.endsWith('/0002.json')){crash=false;throw Error('UNIT pause');}return create(p,v);};
 await assert.rejects(f.service().operate(j,'fund'),/UNIT pause/);
 const signed=[...f.store.records.values()].find(x=>x.signedBytes);signed.requestDigest='0'.repeat(64);
 await assert.rejects(f.service().operate(j,'fund'),/JOURNAL/);assert.equal(f.sent.length,0);
});

test('UNIT: concurrent different jobs reserve distinct exact-u64 key nonce slots',async()=>{
 const f=fixture(),a=job(),b=job();b.id='1'.repeat(32);
 const outcomes=await Promise.all([f.service().operate(a,'fund'),f.service().operate(b,'fund')]);
 assert.equal(f.sent.length,2);assert.equal(new Set(f.sent.map(x=>String(x.tx.nonce))).size,2);assert.deepEqual(f.sent.map(x=>x.tx.nonce).sort(),[9007199254740994n,9007199254740995n]);assert.ok(outcomes.every(x=>x.status==='HELD'));
});

test('UNIT: code and permission are checked again after signing before attempt/broadcast',async()=>{
 for(const mutate of [f=>f.state.code=ch('changed during signing'),f=>f.state.permission='FullAccess']){
  const f=fixture(),create=f.store.create;
  f.store.create=async(p,v)=>{const result=await create(p,v);if(v.signedBytes)mutate(f);return result;};
  await assert.rejects(f.service().operate(job(),'fund'),/ESCROW_(CODE_PIN_MISMATCH|KEY_PERMISSION_REJECTED)/);assert.equal(f.sent.length,0);assert.equal([...f.store.records.values()].some(v=>v.signedBytes),true);assert.equal([...f.store.records.values()].some(v=>v.transactionHash&&!v.signedBytes&&v.opId&&!v.status),false);
 }
});

test('UNIT: independent binding vector uses every ordered string term and actual 32-hex job id',()=>{
 const j=job(),{terms,bindingHash}=termsForJob(j,CONTRACT);
 const vector=['NOPE:WORKSPACE-ESCROW:V1:testnet',CONTRACT,j.id,digest('NOPE:buyer:'+j.buyerId).toString('hex'),j.selectedOffer.paymentAccount,j.selectedOffer.amountYocto,j.taskHash,j.programHash,'0'.repeat(64),'1794736800000000000','1794823200000000000'];
 assert.deepEqual(Object.values(terms),vector.slice(2));assert.equal(bindingHash,digest(JSON.stringify(vector)).toString('hex'));
});

test('UNIT: actual finalized transaction mismatch or an unrelated outcome stays UNKNOWN',async()=>{
 for(const mutate of [r=>r.transaction.actions[0].FunctionCall.deposit='1',r=>r.transaction.actions[0].FunctionCall.args=b64({job_id:'0'.repeat(32)}),r=>r.transaction.receiver_id='other.testnet',r=>r.receipts_outcome.push({id:ch('unrelated'),block_hash:BLOCK,outcome:{executor_id:CONTRACT,receipt_ids:[],status:{SuccessValue:''}}})]){
  const f=fixture(),j=await fund(f);
  // Test unobserved/bare legacy finality, without the new retained certificate.
  const final=[...f.store.records.values()].find(v=>v.status==='FINAL');delete final.certificate;delete final.certificateHash;
  mutate(f.results.get(f.sent[0].hash));
  const p=await f.service().operate(j,'refresh');assert.equal(p.status,'UNKNOWN');assert.equal(p.verified,false);await f.service().operate(j,'fund');assert.equal(f.sent.length,1);
 }
});

test('UNIT: final failed payout cannot authorize a refund while live state is still PayoutPending',async()=>{
 const f=fixture(),j=await record(f,await fund(f));accept(j);f.state.failed=true;
 j.payment=await f.service().operate(j,'release');assert.equal(j.payment.status,'ERROR');
 f.holds.get(j.id).state='PayoutPending';f.state.clock+=3*86400000;
 await assert.rejects(f.service().operate(j,'refund'),/REFUND_STATE/);assert.equal(f.sent.length,3);
});

test('UNIT: bounded nonce lease collision search never signs beyond 64 slots',async()=>{
 const f=fixture(),keyId=digest(JSON.stringify(['NOPE:WORKSPACE-ESCROW:V1:testnet','key',CONTRACT,f.key.getPublicKey().toString()])).toString('hex');
 for(let i=1n;i<=64n;i++)f.store.records.set(`nope-workspace-v1/escrow/nonces/${keyId}/${f.state.nonce+i}.json`,{opId:digest('other op'+i).toString('hex')});
 await assert.rejects(f.service().operate(job(),'fund'),/NONCE_SLOTS_EXHAUSTED/);assert.equal(f.sent.length,0);assert.equal([...f.store.records.values()].some(x=>x.signedBytes),false);
});

test('UNIT: actual durable payout certificate retains PAID after receipt pruning with no signing or sending',async()=>{
 const f=fixture(),j=await record(f,await fund(f));accept(j);
 j.payment=await f.service().operate(j,'release');j.status='PAID';
 const final=[...f.store.records.values()].find(v=>v.status==='FINAL'&&v.certificate?.receiptEvidence.transaction.actions[0].FunctionCall.method_name==='accept_and_release');
 assert.ok(final);assert.ok(Buffer.byteLength(JSON.stringify(final))<=1024*1024);
 assert.deepEqual(final.certificate.receiptEvidence,f.results.get(j.payment.releaseTransactionHash));
 assert.deepEqual(final.certificate.holdSnapshot,{blockHash:BLOCK,hold:f.holds.get(j.id)});
 assert.equal(final.certificateHash,digest(canonical(final.certificate)).toString('hex'));
 f.state.unknown=true;f.results.clear();f.requests.length=0;
 let signatures=0;const original=KeyPairSigner.prototype.signTransaction;
 KeyPairSigner.prototype.signTransaction=async function(...a){signatures++;return original.apply(this,a);};
 try{
  const service=f.service();assert.deepEqual(await service.operate(j,'refresh'),j.payment);assert.deepEqual(await service.operate(j,'release'),j.payment);
  assert.equal(signatures,0);assert.equal(f.sent.length,3);assert.equal(f.requests.filter(r=>r.method==='tx_status'||r.method==='EXPERIMENTAL_tx_status').length,0);
  assert.ok(f.requests.filter(r=>r.method==='status').length>=4,'live network still rechecked');
  assert.ok(f.requests.filter(r=>r.params?.request_type==='view_account').length>=4,'live code still rechecked');
  assert.ok(f.requests.filter(r=>r.params?.method_name==='get_hold').length>=4,'live hold still rechecked');
  assert.equal(JSON.stringify(j.payment).includes('certificate'),false);
 }finally{KeyPairSigner.prototype.signTransaction=original;}
});

test('UNIT: certified REFUNDED remains stable after receipts are pruned',async()=>{
 const f=fixture(),j=await fund(f);f.state.clock+=2*86400000+1;
 j.payment=await f.service().operate(j,'refund');j.status='REFUNDED';f.results.clear();f.state.unknown=true;
 assert.deepEqual(await f.service().operate(j,'refresh'),j.payment);assert.equal(f.sent.length,2);
});

test('UNIT: a cached FINAL/Paid label without a receipt certificate cannot establish payment',async()=>{
 const f=fixture(),j=await record(f,await fund(f));accept(j);j.payment=await f.service().operate(j,'release');j.status='PAID';
 const final=[...f.store.records.values()].find(v=>v.transactionHash===j.payment.releaseTransactionHash&&v.status==='FINAL');
 delete final.certificate;delete final.certificateHash;f.state.unknown=true;
 const p=await f.service().operate(j,'refresh');assert.notEqual(p.status,'PAID');assert.equal(p.status,'UNKNOWN');assert.equal(p.verified,false);assert.equal(f.sent.length,3);
 await f.service().operate(j,'release');assert.equal(f.sent.length,3);
});

test('UNIT: certificate tampering, including recomputed digest with wrong transfer, is rejected',async()=>{
 for(const mutate of [
  c=>c.certificate.receiptEvidence.receipts[0].receipt.Action.actions[0].Transfer.deposit='2',
  c=>c.certificate.holdSnapshot.hold.binding_hash='0'.repeat(64),
  c=>c.certificate.receiptEvidence.receipts.pop(),
  c=>c.certificateHash='0'.repeat(64),
  c=>{delete c.certificate;},
  c=>{c.certificate.receiptEvidence.receipts[0].receipt.Action.actions[0].Transfer.deposit='2';c.certificateHash=digest(canonical(c.certificate)).toString('hex');}
 ]){
  const f=fixture(),j=await record(f,await fund(f));accept(j);j.payment=await f.service().operate(j,'release');j.status='PAID';
  const final=[...f.store.records.values()].find(v=>v.status==='FINAL'&&v.transactionHash===j.payment.releaseTransactionHash);mutate(final);
  await assert.rejects(f.service().operate(j,'refresh'),/JOURNAL_CERTIFICATE_MISMATCH/);assert.equal(f.sent.length,3);
 }
});

test('UNIT: a valid terminal certificate cannot emit regressed facts from contradictory live hold/code',async()=>{
 for(const mutate of [f=>f.holds.get(job().id).state='Delivered',f=>f.holds.get(job().id).nonce='2',f=>f.state.code=ch('unit foreign code')]){
  const f=fixture(),j=await record(f,await fund(f));accept(j);j.payment=await f.service().operate(j,'release');j.status='PAID';mutate(f);
  await assert.rejects(f.service().operate(j,'refresh'),/ESCROW_(FINAL_STATE_MISMATCH|CODE_PIN_MISMATCH)/);assert.equal(f.sent.length,3);
 }
});

test('UNIT: oversized successful evidence remains UNKNOWN and is never marked FINAL',async()=>{
 const f=fixture(),j=await record(f,await fund(f));accept(j);f.state.receiptPadding=1024*1024;
 const p=await f.service().operate(j,'release');assert.equal(p.status,'UNKNOWN');assert.equal(p.verified,false);
 const release=f.sent[2];assert.equal([...f.store.records.values()].some(v=>v.status==='FINAL'&&v.transactionHash===release.hash),false);assert.equal(f.sent.length,3);
});

test('UNIT: immutable present Blob records are read at most once per operate and never cached across calls',async()=>{
 const f=fixture(),service=f.service();f.service=()=>service;
 const j=await record(f,await fund(f));accept(j);j.payment=await service.operate(j,'release');j.status='PAID';
 const read=f.store.read;let presentReads=new Map();
 f.store.read=async p=>{const value=await read(p);if(value!==null)presentReads.set(p,(presentReads.get(p)||0)+1);return value;};
 assert.deepEqual(await service.operate(j,'refresh'),j.payment);
 assert.equal(presentReads.size,16);assert.ok([...presentReads.values()].every(n=>n===1));
 const firstKeys=[...presentReads.keys()].sort();presentReads=new Map();
 assert.deepEqual(await service.operate(j,'refresh'),j.payment);assert.deepEqual([...presentReads.keys()].sort(),firstKeys);assert.ok([...presentReads.values()].every(n=>n===1));
 const final=[...f.store.records.values()].find(v=>v.status==='FINAL'&&v.transactionHash===j.payment.releaseTransactionHash);final.certificateHash='0'.repeat(64);
 await assert.rejects(service.operate(j,'refresh'),/JOURNAL_CERTIFICATE_MISMATCH/);
});

test('UNIT: null Blob reads are not cached when a concurrent broadcast-attempt CAS winner appears',async()=>{
 const f=fixture(),create=f.store.create,read=f.store.read;let attemptReads=0,competed=false;
 f.store.read=async p=>{if(p.endsWith('/0002.json'))attemptReads++;return read(p);};
 f.store.create=async(p,v)=>{if(!competed&&p.endsWith('/0002.json')){competed=true;await create(p,v);return false;}return create(p,v);};
 const p=await f.service().operate(job(),'fund');assert.equal(p.status,'UNKNOWN');assert.ok(attemptReads>=2);assert.equal(f.sent.length,0);
 assert.equal((await f.service().operate(job(),'fund')).status,'UNKNOWN');assert.equal(f.sent.length,0);
});

test('UNIT: 100m gas-price profile fits finite .05 allowance and 2.9 balance; 1e9 blocks before stage0/sign/send',async()=>{
 const f=fixture();f.state.permission.FunctionCall.allowance='50000000000000000000000';
 const j=await fund(f);assert.equal(j.payment.status,'HELD');
 assert.ok(f.requests.some(r=>r.method==='gas_price'&&r.params[0]===BLOCK));
 assert.ok(f.requests.some(r=>r.method==='EXPERIMENTAL_protocol_config'&&r.params.block_id===BLOCK));
 assert.ok(f.requests.some(r=>r.params?.method_name==='get_config'&&r.params.block_id===BLOCK));
 const high=fixture({gasPrice:'1000000000'});high.state.permission.FunctionCall.allowance='50000000000000000000000';
 let signatures=0;const original=KeyPairSigner.prototype.signTransaction;KeyPairSigner.prototype.signTransaction=async function(...a){signatures++;return original.apply(this,a);};
 try{
  const p=await high.service().operate(job(),'fund');assert.equal(p.status,'ERROR');assert.equal(p.code,'ESCROW_GAS_ALLOWANCE_INSUFFICIENT');assert.equal(p.verified,false);
  assert.equal(signatures,0);assert.equal(high.sent.length,0);assert.equal([...high.store.records.values()].some(r=>r.intent||r.signedBytes||r.nonceFloor),false);
 }finally{KeyPairSigner.prototype.signTransaction=original;}
});

test('UNIT: live storage/headroom/reserve/pool accounting prevent underfunded signing',async()=>{
 for(const options of [
  {balance:'2800000000000000000000000'},
  {storagePrice:'20000000000000000000'},
  {storageUsage:300000},
  {configOverride:{storage_headroom_bytes:165536}},
  {configOverride:{gas_reserve:'300000000000000000000000'}}
 ]){
  const f=fixture(options),p=await f.service().operate(job(),'fund');assert.equal(p.status,'ERROR');assert.equal(p.code,'ESCROW_ACCOUNT_RESERVE_INSUFFICIENT');assert.equal(p.verified,false);assert.equal(f.sent.length,0);assert.equal([...f.store.records.values()].some(r=>r.intent||r.signedBytes),false);
 }
});

test('UNIT: required balance uses unspent/pending-adjusted pool, not available or double-counted held',async()=>{
 const budget=155000000000000n*100000000n,base=(203000n+65536n)*10000000000000000000n+100000000000000000000000n;
 const f=fixture({balance:String(base+50000000000000000000000n+budget)}),j=await fund(f);
 j.status='DELIVERED';j.delivery={version:1,outputSha256:'f'.repeat(64)};j.payment=await f.service().operate(j,'record');assert.equal(j.payment.status,'HELD');
 const low=fixture({balance:String(base+50000000000000000000000n+budget-1n)});
 const p=await low.service().operate(job(),'fund');assert.equal(p.code,'ESCROW_ACCOUNT_RESERVE_INSUFFICIENT');assert.equal(low.sent.length,0);
});

test('UNIT: malformed prices, inconsistent pool accounting and a mismatched snapshot never sign',async()=>{
 for(const options of [
  {gasPrice:undefined},{gasPrice:'0'},{gasPrice:100000000},{gasPrice:'1e8'},
  {storagePrice:'0'},{storagePrice:undefined},{storageUsage:1.5},
  {configOverride:{available:'0'}},{configOverride:{pending:'1'}},
  {configOverride:{gas_reserve:'0'}},{configOverride:{storage_headroom_bytes:0}},
  {configBlock:ch('unit other final block')}
 ]){
  const f=fixture(options);
  const p=await f.service().operate(job(),'fund');assert.equal(p.code,'ESCROW_GAS_BUDGET_UNVERIFIED');assert.equal(p.status,'ERROR');
  assert.equal(f.sent.length,0);assert.equal([...f.store.records.values()].some(r=>r.signedBytes),false);
 }
});

test('UNIT: gas-price or remaining allowance rise/fall after signing is rechecked before broadcast marker',async()=>{
 for(const mutate of [f=>f.state.gasPrice='1000000000',f=>f.state.permission.FunctionCall.allowance='1']){
  const f=fixture(),create=f.store.create;f.state.permission.FunctionCall.allowance='50000000000000000000000';
  f.store.create=async(p,v)=>{const result=await create(p,v);if(v.signedBytes)mutate(f);return result;};
  const p=await f.service().operate(job(),'fund');assert.equal(p.status,'ERROR');assert.equal(p.code,'ESCROW_GAS_ALLOWANCE_INSUFFICIENT');assert.equal(f.sent.length,0);assert.ok([...f.store.records.values()].some(r=>r.signedBytes));
  assert.equal([...f.store.records.values()].some(r=>r.opId&&r.transactionHash&&!r.signedBytes&&!r.status),false);
 }
});

test('UNIT: price changes after the attempt marker remain UNKNOWN and cannot cause a replacement send',async()=>{
 const f=fixture(),create=f.store.create;let changed=false;
 f.store.create=async(p,v)=>{const result=await create(p,v);if(!changed&&p.endsWith('/0002.json')){changed=true;f.state.gasPrice='1000000000';f.state.unknown=true;f.state.lost=true;}return result;};
 const j=job();j.payment=await f.service().operate(j,'fund');assert.equal(j.payment.status,'UNKNOWN');assert.equal(f.sent.length,1);
 assert.equal((await f.service().operate(j,'fund')).status,'UNKNOWN');assert.equal((await f.service().operate(j,'refresh')).status,'UNKNOWN');assert.equal(f.sent.length,1);
});

test('UNIT: spent and pending pool deductions enter the exact balance floor',async()=>{
 const budget=155000000000000n*100000000n,base=(203000n+65536n)*10000000000000000000n+100000000000000000000000n;
 const configOverride={available:'20000000000000000000000',held:'20000000000000000000000',spent:'10000000000000000000000',pending:'10000000000000000000000',hold_count:2};
 const needed=base+30000000000000000000000n+budget;
 const f=fixture({configOverride,balance:String(needed)});assert.equal((await f.service().operate(job(),'fund')).status,'HELD');
 const low=fixture({configOverride,balance:String(needed-1n)});assert.equal((await low.service().operate(job(),'fund')).code,'ESCROW_ACCOUNT_RESERVE_INSUFFICIENT');assert.equal(low.sent.length,0);
});

test('UNIT: a depleted remaining key allowance blocks a later action before its intent/signature',async()=>{
 const f=fixture(),j=await fund(f);f.state.permission.FunctionCall.allowance='10000000000000000000000';
 j.status='DELIVERED';j.delivery={version:1,outputSha256:'f'.repeat(64)};
 const p=await f.service().operate(j,'record');assert.equal(p.status,'ERROR');assert.equal(p.code,'ESCROW_GAS_ALLOWANCE_INSUFFICIENT');assert.equal(f.sent.length,1);
 assert.equal([...f.store.records.values()].filter(r=>r.signedBytes).length,1);assert.equal([...f.store.records.values()].filter(r=>r.intent).length,1);
});

test('UNIT: current >=4 testNEAR / .2 key profile passes dynamic preflight at simulated 1e9 gas price',async()=>{
 const f=fixture({balance:'4000000000000000000000000',gasPrice:'1000000000'});
 f.state.permission.FunctionCall.allowance='200000000000000000000000';
 const p=await f.service().operate(job(),'fund');assert.equal(p.status,'HELD');assert.equal(p.verified,true);assert.equal(f.sent.length,1);
 assert.equal(f.sent[0].tx.signerId,f.env.NOPE_ESCROW_CONTRACT_ID);assert.equal(f.sent[0].tx.receiverId,f.env.NOPE_ESCROW_CONTRACT_ID);
});

test('UNIT: standalone account configuration binds every query, self-call and retained payout certificate',async()=>{
 const contractId='nope-work-da4cbb1e.testnet';
 const f=fixture({contractId,balance:'4000000000000000000000000',gasPrice:'1000000000'});
 f.state.permission.FunctionCall.allowance='200000000000000000000000';
 const j=await record(f,await fund(f));accept(j);j.payment=await f.service().operate(j,'release');j.status='PAID';
 assert.equal(j.payment.status,'PAID');assert.equal(j.payment.contractId,contractId);
 assert.ok(f.sent.every(s=>s.tx.signerId===contractId&&s.tx.receiverId===contractId));
 assert.ok(f.requests.filter(r=>r.params?.account_id).every(r=>r.params.account_id===contractId));
 const certificates=[...f.store.records.values()].filter(r=>r.certificate);
 assert.equal(certificates.length,3);assert.ok(certificates.every(r=>r.certificate.contractId===contractId&&r.certificate.holdSnapshot.hold.binding_hash===j.payment.bindingHash));
 f.state.unknown=true;f.results.clear();assert.deepEqual(await f.service().operate(j,'refresh'),j.payment);assert.equal(f.sent.length,3);
});

test('UNIT: supported protocol requires explicit [1,1]; nonunit/missing/malformed inflation rejects before ANY sign',async()=>{
 for(const inflationRatio of [[103,100],undefined,null,[],[1],[2,2],['1','1'],[1,0]]){
  const f=fixture({inflationRatio});let signatures=0;const original=KeyPairSigner.prototype.signTransaction;
  KeyPairSigner.prototype.signTransaction=async function(...a){signatures++;return original.apply(this,a);};
  try{
   const p=await f.service().operate(job(),'fund');assert.equal(p.status,'ERROR');assert.equal(p.code,'ESCROW_GAS_PROTOCOL_UNSUPPORTED');assert.equal(p.verified,false);
   assert.equal(signatures,0);assert.equal(f.sent.length,0);assert.equal([...f.store.records.values()].some(r=>r.intent||r.signedBytes||r.nonceFloor),false);
  }finally{KeyPairSigner.prototype.signTransaction=original;}
 }
 const supported=fixture({inflationRatio:[1,1]});assert.equal((await supported.service().operate(job(),'fund')).status,'HELD');
});

test('UNIT: protocol fee changes must still fit the bounded 5 Tgas action envelope',async()=>{
 const high={send_sir:3000000000000,send_not_sir:3000000000000,execution:3000000000000};
 for(const feeOverride of [
  {action_receipt_creation_config:high},
  {action_creation_config:{function_call_cost:high,function_call_cost_per_byte:{send_sir:1,send_not_sir:1,execution:1}}},
  {action_creation_config:{function_call_cost:{send_sir:1,send_not_sir:1,execution:1},function_call_cost_per_byte:{send_sir:2000000000,send_not_sir:2000000000,execution:2000000000}}}
 ]){
  const f=fixture({feeOverride}),p=await f.service().operate(job(),'fund');assert.equal(p.status,'ERROR');assert.equal(p.code,'ESCROW_GAS_PROTOCOL_UNSUPPORTED');assert.equal(f.sent.length,0);assert.equal([...f.store.records.values()].some(r=>r.intent||r.signedBytes),false);
 }
 const missing=fixture({feeOverride:{action_creation_config:{}}}),p=await missing.service().operate(job(),'fund');assert.equal(p.code,'ESCROW_GAS_BUDGET_UNVERIFIED');assert.equal(missing.sent.length,0);
});

test('UNIT: a protocol inflation change after signing blocks broadcast; stored transaction is never replaced',async()=>{
 const f=fixture(),create=f.store.create;
 f.store.create=async(p,v)=>{const result=await create(p,v);if(v.signedBytes)f.state.inflationRatio=[103,100];return result;};
 const j=job();j.payment=await f.service().operate(j,'fund');assert.equal(j.payment.status,'ERROR');assert.equal(j.payment.code,'ESCROW_GAS_PROTOCOL_UNSUPPORTED');assert.equal(f.sent.length,0);
 const signed=[...f.store.records.values()].find(r=>r.signedBytes);assert.ok(signed);
 f.state.inflationRatio=[1,1];assert.equal((await f.service().operate(j,'fund')).fundTransactionHash,signed.transactionHash);assert.equal(f.sent.length,1);
});

test('UNIT: refresh authorizes explicit SAME signed operation after prebroadcast failure for all four actions',async()=>{
 for(const action of ['fund','record','release','refund']){
  const f=fixture();let j=job();
  if(action!=='fund')j=await fund(f,j);
  if(action==='record'){j.status='DELIVERED';j.delivery={version:1,outputSha256:'f'.repeat(64)};}
  if(action==='release'){j=await record(f,j);accept(j);}
  if(action==='refund')f.state.clock+=2*86400000+1;
  const priorSends=f.sent.length,create=f.store.create;
  f.store.create=async(p,v)=>{const result=await create(p,v);if(v.signedBytes)f.state.inflationRatio=[103,100];return result;};
  j.payment=await f.service().operate(j,action);assert.equal(j.payment.status,'ERROR');assert.equal(j.payment.operation.resumeAction,undefined,'an error response itself cannot authorize recovery');
  assert.equal(f.sent.length,priorSends);
  const saved=[...f.store.records.values()].find(r=>r.signedBytes&&r.opId===j.payment.operation.operationId);
  assert.ok(saved);const leaseCount=[...f.store.records.keys()].filter(p=>p.includes('/nonces/')).length;
  f.state.inflationRatio=[1,1];f.store.create=create;
  let signatures=0;const original=KeyPairSigner.prototype.signTransaction;KeyPairSigner.prototype.signTransaction=async function(...a){signatures++;return original.apply(this,a);};
  try{
   j.payment=await f.service().operate(j,'refresh');assert.equal(j.payment.operation.resumeAction,action);assert.equal(j.payment.operation.transactionHash,saved.transactionHash);
   assert.deepEqual(await f.service().operate(j,'refresh'),j.payment,'recovery metadata is stable');assert.equal(f.sent.length,priorSends,'refresh never broadcasts');
   const completed=await f.service().operate(j,j.payment.operation.resumeAction);
   assert.equal(completed[({fund:'fundTransactionHash',record:'recordTransactionHash',release:'releaseTransactionHash',refund:'refundTransactionHash'})[action]],saved.transactionHash);
   assert.equal(completed.operation.resumeAction,undefined);assert.equal(completed.verified,true);assert.equal(signatures,0);assert.equal(f.sent.length,priorSends+1);
   assert.equal([...f.store.records.keys()].filter(p=>p.includes('/nonces/')).length,leaseCount,'no replacement nonce');
  }finally{KeyPairSigner.prototype.signTransaction=original;}
 }
});

test('UNIT: any persisted broadcast attempt suppresses resumeAction for pending/unknown/failed operations',async()=>{
 for(const mode of ['unknown','pending','failed']){
  const f=fixture(),j=await record(f,await fund(f));accept(j);f.state[mode==='unknown'?'unknownNext':mode]=true;
  j.payment=await f.service().operate(j,'release');assert.equal(j.payment.operation.resumeAction,undefined);
  const refreshed=await f.service().operate(j,'refresh');assert.equal(refreshed.operation.resumeAction,undefined);assert.equal(f.sent.length,3);
 }
});

test('UNIT: unsigned intent, expired deadline and invalid release state cannot offer resumeAction',async()=>{
 const unsigned=fixture({gasPrice:'10000000000'}),u=job();u.payment=await unsigned.service().operate(u,'fund');
 assert.equal((await unsigned.service().operate(u,'refresh')).operation.resumeAction,undefined);
 for(const action of ['fund','release']){
  const f=fixture();let j=job();if(action==='release'){j=await record(f,await fund(f));accept(j);}
  const create=f.store.create;f.store.create=async(p,v)=>{const result=await create(p,v);if(v.signedBytes)f.state.inflationRatio=[103,100];return result;};
  j.payment=await f.service().operate(j,action);f.state.inflationRatio=[1,1];
  if(action==='fund')f.state.clock+=3*86400000;else j.status='DELIVERED';
  assert.equal((await f.service().operate(j,'refresh')).operation.resumeAction,undefined);assert.equal(f.sent.length,action==='fund'?0:2);
 }
});

test('UNIT: recovery hint verifies persisted signature, exact lease and transaction hash without signing',async()=>{
 for(const tamper of [
  (f,s)=>s.transactionHash=ch('UNIT wrong signed hash'),
  (f,s)=>s.signedBytes=Buffer.from('UNIT corrupt signed bytes').toString('base64'),
  (f,s)=>{const lease=[...f.store.records.values()].find(r=>r.nonce===s.nonce&&r.publicKey);lease.requestDigest='0'.repeat(64);}
 ]){
  const f=fixture(),j=job(),create=f.store.create;
  f.store.create=async(p,v)=>{const result=await create(p,v);if(v.signedBytes)f.state.inflationRatio=[103,100];return result;};
  j.payment=await f.service().operate(j,'fund');f.state.inflationRatio=[1,1];const signed=[...f.store.records.values()].find(r=>r.signedBytes);tamper(f,signed);
  await assert.rejects(f.service().operate(j,'refresh'),/ESCROW_(SIGNED_JOURNAL_MISMATCH|NONCE_LEASE_MISMATCH)/);assert.equal(f.sent.length,0);
 }
});

test('UNIT: prebroadcast RPC failure preserves a refresh-visible exact resume without signing again',async()=>{
 const f=fixture(),j=job(),create=f.store.create;
 f.store.create=async(p,v)=>{const result=await create(p,v);if(v.signedBytes)f.state.priceUnavailable=true;return result;};
 await assert.rejects(f.service().operate(j,'fund'),/ESCROW_RPC_UNKNOWN/);assert.equal(f.sent.length,0);
 const saved=[...f.store.records.values()].find(v=>v.signedBytes);assert.ok(saved);
 let signatures=0;const original=KeyPairSigner.prototype.signTransaction;KeyPairSigner.prototype.signTransaction=async function(...a){signatures++;return original.apply(this,a);};
 try{
  j.payment=await f.service().operate(j,'refresh');assert.equal(j.payment.operation.resumeAction,'fund');assert.equal(j.payment.operation.transactionHash,saved.transactionHash);assert.equal(f.sent.length,0);
  f.state.priceUnavailable=false;const p=await f.service().operate(j,j.payment.operation.resumeAction);assert.equal(p.status,'HELD');assert.equal(p.fundTransactionHash,saved.transactionHash);assert.equal(signatures,0);assert.equal(f.sent.length,1);
 }finally{KeyPairSigner.prototype.signTransaction=original;}
});
