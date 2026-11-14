import test from 'node:test';
import assert from 'node:assert/strict';
import {baseEncode} from 'near-api-js';
import {createWalletEscrow,walletTermsForJob,WALLET_ESCROW_KIND,WALLET_ESCROW_DOMAIN} from './wallet-escrow.mjs';
import {walletIdentity} from './wallet-auth.mjs';
// Explicit FINAL RPC and chain-state fixtures only. No chain call, signer,
// wallet broadcast, customer deposit or real native transfer is performed.
class Store{records=new Map();async read(p){return structuredClone(this.records.get(p)??null);}async create(p,v){if(this.records.has(p))return false;this.records.set(p,structuredClone(v));return true;}}
const H=n=>baseEncode(Buffer.alloc(32,n)),BLOCK=H(2),CODE=H(3),TX=H(4),RECEIPT=H(5),TRANSFER=H(6),CALLBACK=H(7);
const TIME=1700000000000,BUYER='buyer-fixture.testnet',PROVIDER='provider-fixture.testnet';
const config={network:'testnet',domain:WALLET_ESCROW_DOMAIN,contractId:'wallet-contract.testnet',codeHash:CODE,requireKeyless:true};
const wallet=(accountId)=>({accountId,network:'testnet',publicKey:'ed25519:'+H(8),verifiedAt:new Date(TIME).toISOString()});
function fixture(){
 const store=new Store(),calls=[];let hold=null,code=CODE,keys=[],time=TIME+1000,chainTime=null,result=null,network='testnet';
 const buyer={id:walletIdentity('buyer',BUYER),role:'buyer',wallet:wallet(BUYER)},provider={id:walletIdentity('provider',PROVIDER),role:'provider',wallet:wallet(PROVIDER)};
 const job={id:'a'.repeat(32),buyerId:buyer.id,buyerWallet:buyer.wallet,status:'AWARDED',createdAt:new Date(TIME-1000).toISOString(),taskHash:'b'.repeat(64),programHash:'c'.repeat(64),planSha256:'d'.repeat(64),selectedOffer:{providerId:provider.id,paymentAccount:PROVIDER,wallet:provider.wallet,amountYocto:'1000000000000000000000'},payment:{kind:WALLET_ESCROW_KIND,network:'testnet',contractId:config.contractId,status:'NOT_FUNDED',awardedAtISO:new Date(TIME).toISOString()}};
 const service=createWalletEscrow({store,config,now:()=>time,rpc:async(method,params)=>{
  calls.push({method,params});if(method==='status')return{chain_id:network};
  if(method==='query'){
   if(params.request_type==='view_account')return{block_hash:BLOCK,block_height:10,code_hash:code};
   if(params.request_type==='view_access_key_list')return{block_hash:BLOCK,keys};
   assert.equal(params.block_id,BLOCK);assert.equal(params.method_name,'get_hold');assert.deepEqual(JSON.parse(Buffer.from(params.args_base64,'base64')),{buyer_account:BUYER,job_id:job.id});return{block_hash:BLOCK,result:[...Buffer.from(JSON.stringify(hold))]};
  }
  if(method==='tx'){if(!result)throw Error('fixture lost wallet/RPC result');return structuredClone(result);}
  if(method==='block')return{header:{hash:params.block_id,height:10,timestamp_nanosec:String(BigInt(chainTime??time)*1000000n)}};
  if(method==='EXPERIMENTAL_receipt')return result.receipts.find(r=>r.receipt_id===params.receipt_id);
  throw Error('Unexpected RPC '+method);
 }});
 function fund(){const c=service.context(job);hold={terms:c.terms,binding_hash:c.bindingHash,state:'Held',nonce:'0',delivery:null,pending:null,last_transfer_failure_nonce:null};}
 function tree(intent,{transfer=false,failed=false}={}){
  const a=intent.transaction.actions[0].params;
  const node=(id,executor,children,status)=>({id,block_hash:BLOCK,outcome:{executor_id:executor,receipt_ids:children,status}});
  const tx={hash:TX,signer_id:intent.transaction.signerId,receiver_id:config.contractId,actions:[{FunctionCall:{method_name:a.methodName,args:Buffer.from(JSON.stringify(a.args)).toString('base64'),gas:a.gas,deposit:a.deposit}}]};
  const root=node(TX,tx.signer_id,[RECEIPT],{SuccessReceiptId:RECEIPT});
  const receipts_outcome=transfer?[node(RECEIPT,config.contractId,[TRANSFER,CALLBACK],{SuccessReceiptId:CALLBACK}),node(TRANSFER,intent.action==='refund'?BUYER:PROVIDER,[],{SuccessValue:''}),node(CALLBACK,config.contractId,[],{SuccessValue:Buffer.from('true').toString('base64')})]:[node(RECEIPT,config.contractId,[],failed?{Failure:{fixture:'rejected'}}:{SuccessValue:Buffer.from('{}').toString('base64')})];
  const receipts=transfer?[{receipt_id:TRANSFER,predecessor_id:config.contractId,receiver_id:intent.action==='refund'?BUYER:PROVIDER,receipt:{Action:{actions:[{Transfer:{deposit:hold.terms.amount}}]}}},{receipt_id:CALLBACK,predecessor_id:config.contractId,receiver_id:config.contractId,receipt:{Action:{actions:[{FunctionCall:{method_name:'on_transfer',args:Buffer.from(JSON.stringify({buyer_account:BUYER,job_id:job.id,nonce:hold.nonce,action:intent.action==='refund'?'refund':'payout'})).toString('base64'),gas:'20000000000000',deposit:'0'}}]}}},{receipt_id:RECEIPT,predecessor_id:tx.signer_id,receiver_id:config.contractId,receipt:{Action:{actions:tx.actions}}}]:[];
  return{transaction:tx,transaction_outcome:root,receipts_outcome,receipts,final_execution_status:'FINAL',status:failed?{Failure:{fixture:'rejected'}}:{SuccessValue:Buffer.from(transfer?'true':'{}').toString('base64')}};
 }
 return{store,calls,service,job,buyer,provider,fund,tree,hold:()=>hold,setHold:v=>hold=v,setResult:v=>result=v,setKeys:v=>keys=v,setCode:v=>code=v,setTime:v=>time=v,setChainTime:v=>chainTime=v,setNetwork:v=>network=v};
}
test('wallet terms bind original buyer namespace, verified provider, exact amount/program and deadline with contract tuple order',()=>{
 const f=fixture(),c=walletTermsForJob(f.job,config.contractId);assert.equal(c.terms.buyer_account,BUYER);assert.equal(c.terms.amount,f.job.selectedOffer.amountYocto);assert.equal(c.terms.job_id,f.job.id);assert.notEqual(walletTermsForJob({...f.job,buyerWallet:wallet('different.testnet')},config.contractId).bindingHash,c.bindingHash);
 for(const change of [{buyerWallet:null},{selectedOffer:{...f.job.selectedOffer,paymentAccount:'arbitrary.testnet'}},{selectedOffer:{...f.job.selectedOffer,amountYocto:'1000000000000000000000001'}}])assert.throws(()=>walletTermsForJob({...f.job,...change},config.contractId));
});
test('FINAL pinned code and same-block empty contract key list are mandatory; user wallet still owns FullAccess keys',async()=>{
 for(const variant of ['code','keys','network']){const f=fixture();if(variant==='code')f.setCode(H(9));if(variant==='keys')f.setKeys([{public_key:'ed25519:'+H(8),access_key:{permission:'FullAccess'}}]);if(variant==='network')f.setNetwork('mainnet');await assert.rejects(f.service.prepare(f.job,'fund',f.buyer),variant);}
 const f=fixture(),p=await f.service.prepare(f.job,'fund',f.buyer);assert.equal(p.intent.transaction.actions[0].params.deposit,f.job.selectedOffer.amountYocto);assert.equal(p.payment.status,'NOT_FUNDED');assert.equal(p.payment.operation.status,'PREPARED');
 assert.ok(f.calls.some(c=>c.params?.request_type==='view_access_key_list'&&c.params.block_id===BLOCK));assert.ok(!f.calls.some(c=>/send|broadcast/.test(c.method)));
});
test('lost wallet transaction hash reconciles matching FINAL fund/record state without inventing a verified receipt or rebroadcasting',async()=>{
 const f=fixture(),p=await f.service.prepare(f.job,'fund',f.buyer);f.job.payment=p.payment;
 const uncertain=await f.service.refresh(f.job,f.buyer);assert.equal(uncertain.status,'UNKNOWN');assert.equal(uncertain.verified,false);f.job.payment=uncertain;assert.equal((await f.service.prepare(f.job,'fund',f.buyer)).intent,null);
 f.fund();const funded=await f.service.refresh(f.job,f.buyer);assert.equal(funded.status,'HELD');assert.equal(funded.verified,true);assert.equal(funded.stateVerified,true);assert.equal(funded.receiptVerified,false);assert.equal(funded.fundTransactionHash,undefined);
 f.job.status='DELIVERED';f.job.delivery={version:1,outputSha256:'e'.repeat(64)};f.job.payment=funded;const record=await f.service.prepare(f.job,'record',f.provider);assert.equal(record.intent.transaction.signerId,PROVIDER);assert.deepEqual(record.intent.transaction.actions[0].params.args,{buyer_account:BUYER,job_id:f.job.id,version:1,output_hash:f.job.delivery.outputSha256});
 f.hold().state='Delivered';f.hold().delivery={version:1,output_hash:f.job.delivery.outputSha256};f.job.payment=record.payment;const recorded=await f.service.refresh(f.job,f.provider);assert.equal(recorded.recordedVersion,1);assert.equal(recorded.recordedOutputHash,f.job.delivery.outputSha256);assert.equal(recorded.receiptVerified,false);
});
test('FINAL confirmation checks exact signer/account/action/serialized args/deposit and receipt closure; stale delivery never authorizes release',async()=>{
 for(const variant of ['signer','receiver','method','args','deposit','tree','pending']){
  const f=fixture(),p=await f.service.prepare(f.job,'fund',f.buyer);f.job.payment=p.payment;f.fund();const r=f.tree(p.intent);
  if(variant==='signer')r.transaction.signer_id='attacker.testnet';if(variant==='receiver')r.transaction.receiver_id='other.testnet';if(variant==='method')r.transaction.actions[0].FunctionCall.method_name='refund';if(variant==='args')r.transaction.actions[0].FunctionCall.args=Buffer.from('{}').toString('base64');if(variant==='deposit')r.transaction.actions[0].FunctionCall.deposit='0';if(variant==='tree')r.receipts_outcome=[];if(variant==='pending')r.final_execution_status='EXECUTED';f.setResult(r);
  if(variant==='pending'){const value=await f.service.confirm(f.job,'fund',TX,f.buyer);assert.equal(value.status,'FUNDING_PENDING');assert.equal(value.verified,false);}else await assert.rejects(f.service.confirm(f.job,'fund',TX,f.buyer),variant);
 }
 const f=fixture(),p=await f.service.prepare(f.job,'fund',f.buyer);f.job.payment=p.payment;f.fund();f.setResult(f.tree(p.intent));const held=await f.service.confirm(f.job,'fund',TX,f.buyer);assert.equal(held.fundTransactionHash,TX);assert.equal(held.receiptVerified,true);assert.deepEqual(await f.service.confirm(f.job,'fund',TX,f.buyer),held);
 f.job.status='ACCEPTED';f.job.delivery={version:2,outputSha256:'e'.repeat(64)};f.job.payment=held;f.hold().state='Delivered';f.hold().delivery={version:1,output_hash:'f'.repeat(64)};await assert.rejects(f.service.prepare(f.job,'release',f.buyer));
});
test('release and refund validate exact native recipient/amount and nonce-bound private callback; refund always returns to original buyer',async()=>{
 for(const action of ['release','refund'])for(const bad of [false,true]){
  const f=fixture();f.fund();f.job.status=action==='release'?'ACCEPTED':'AWARDED';if(action==='release'){f.job.delivery={version:1,outputSha256:'e'.repeat(64)};f.hold().state='Delivered';f.hold().delivery={version:1,output_hash:f.job.delivery.outputSha256};}else f.setTime(TIME+3*86400000);
  f.job.payment=await f.service.refresh(f.job,f.buyer);const p=await f.service.prepare(f.job,action,f.buyer);f.job.payment=p.payment;f.hold().state=action==='release'?'Paid':'Refunded';f.hold().nonce='1';const r=f.tree(p.intent,{transfer:true});if(bad)r.receipts.find(r=>r.receipt_id===TRANSFER).receiver_id='attacker.testnet';f.setResult(r);
  if(bad)await assert.rejects(f.service.confirm(f.job,action,TX,f.buyer));else{const result=await f.service.confirm(f.job,action,TX,f.buyer);assert.equal(result.status,action==='release'?'PAID':'REFUNDED');assert.equal(result.receiptVerified,true);assert.equal(result[action==='release'?'releaseTransactionHash':'refundTransactionHash'],TX);}
 }
});
test('verified account ownership is required in every action, and an attacker namespace or newer output cannot stand in for original terms',async()=>{
 const f=fixture();await assert.rejects(f.service.prepare(f.job,'fund',{...f.buyer,wallet:null}));await assert.rejects(f.service.prepare(f.job,'fund',f.provider));await assert.rejects(f.service.refresh(f.job,{...f.buyer,wallet:wallet('attacker.testnet')}));
 f.fund();f.hold().terms.buyer_account='attacker.testnet';await assert.rejects(f.service.refresh(f.job,f.buyer));
});


test('lost release/refund hashes cannot turn an unchanged FINAL hold into permission to sign again',async()=>{
 for(const action of ['release','refund']){
  const f=fixture();f.fund();f.job.status=action==='release'?'ACCEPTED':'AWARDED';
  if(action==='release'){f.job.delivery={version:1,outputSha256:'e'.repeat(64)};f.hold().state='Delivered';f.hold().delivery={version:1,output_hash:f.job.delivery.outputSha256};}else f.setTime(TIME+3*86400000);
  f.job.payment=await f.service.refresh(f.job,f.buyer);const prepared=await f.service.prepare(f.job,action,f.buyer);f.job.payment=prepared.payment;
  const lost=await f.service.refresh(f.job,f.buyer);assert.equal(lost.status,'UNKNOWN');assert.equal(lost.verified,false);f.job.payment=lost;assert.equal((await f.service.prepare(f.job,action,f.buyer)).intent,null);
  const observed=await f.service.confirm(f.job,action,TX,f.buyer);assert.equal(observed.status,'UNKNOWN');f.job.payment=observed;assert.equal((await f.service.prepare(f.job,action,f.buyer)).intent,null);
  f.hold().state=action==='release'?'Paid':'Refunded';f.hold().nonce='1';const final=await f.service.refresh(f.job,f.buyer);assert.equal(final.status,action==='release'?'PAID':'REFUNDED');assert.equal(final.receiptVerified,false);assert.equal(final[action==='release'?'releaseTransactionHash':'refundTransactionHash'],undefined);
 }
});


test('unsigned provider record retires only after FINAL review expiry and permits a separate buyer refund with exact nonce-bound receipt',async()=>{
 for(const directPrepare of [false,true]){
  const f=fixture();f.fund();f.job.status='DELIVERED';f.job.delivery={version:1,outputSha256:'e'.repeat(64)};f.job.payment=await f.service.refresh(f.job,f.buyer);
  const record=await f.service.prepare(f.job,'record',f.provider);f.job.payment=record.payment;
  const original=await f.store.read('nope-workspace-v1/wallet/intents/'+record.intent.id+'.json');
  f.job.payment=await f.service.refresh(f.job,f.provider);assert.equal(f.job.payment.status,'UNKNOWN');assert.equal(f.job.payment.operation.status,'UNKNOWN');
  const before=await f.service.prepare(f.job,'refund',f.buyer);assert.equal(before.intent,null);assert.equal(before.payment.status,'UNKNOWN');
  f.setTime(TIME+3*86400000);
  if(!directPrepare){const recovered=await f.service.refresh(f.job,f.buyer);assert.equal(recovered.status,'HELD');assert.equal(recovered.verified,true);assert.equal(recovered.operation.status,'EXPIRED');assert.equal(recovered.operation.holdNonce,'0');assert.equal(recovered.receiptVerified,false);assert.equal(recovered.recordTransactionHash,undefined);f.job.payment=recovered;}
  const refund=await f.service.prepare(f.job,'refund',f.buyer);assert.ok(refund.intent);assert.equal(refund.payment.status,'HELD');assert.equal(refund.intent.transaction.signerId,BUYER);assert.deepEqual(refund.intent.transaction.actions[0].params.args,{buyer_account:BUYER,job_id:f.job.id});assert.equal(refund.intent.transaction.actions[0].params.deposit,'0');f.job.payment=refund.payment;
  assert.deepEqual(await f.store.read('nope-workspace-v1/wallet/intents/'+record.intent.id+'.json'),original,'original provider intent remains immutable');
  await assert.rejects(f.service.confirm(f.job,'record',H(12),f.provider),{code:'WALLET_INTENT_EXPIRED'},'late record confirmation cannot replace the new buyer refund');
  f.hold().state='RefundPending';f.hold().nonce='1';f.hold().pending={action:'refund',previous_state:'Held'};const pending=await f.service.refresh(f.job,f.buyer);assert.equal(pending.status,'REFUND_PENDING');assert.equal(pending.verified,false);
  f.hold().state='Refunded';f.hold().pending=null;f.setResult(f.tree(refund.intent,{transfer:true}));const final=await f.service.confirm(f.job,'refund',TX,f.buyer);assert.equal(final.status,'REFUNDED');assert.equal(final.verified,true);assert.equal(final.receiptVerified,true);assert.equal(final.refundTransactionHash,TX);
  assert.ok(!f.calls.some(c=>/send|broadcast/.test(c.method)));
 }
});

test('record retirement refuses stale FINAL time and every in-flight monetary state; an unrelated buyer cannot acquire the refund intent',async()=>{
 for(const state of ['stale-final','PayoutPending','RefundPending']){
  const f=fixture();f.fund();f.job.status='DELIVERED';f.job.delivery={version:1,outputSha256:'e'.repeat(64)};f.job.payment=await f.service.refresh(f.job,f.buyer);const record=await f.service.prepare(f.job,'record',f.provider);f.job.payment=record.payment;f.job.payment=await f.service.refresh(f.job,f.provider);f.setTime(TIME+3*86400000);
  if(state==='stale-final')f.setChainTime(TIME+86400000);else{f.hold().state=state;f.hold().delivery={version:1,output_hash:f.job.delivery.outputSha256};f.hold().nonce='3';f.hold().pending={action:state==='PayoutPending'?'payout':'refund',previous_state:'Delivered'};}
  const value=await f.service.refresh(f.job,f.buyer);assert.equal(value.verified,false);assert.notEqual(value.operation?.status,'EXPIRED');f.job.payment=value;assert.equal((await f.service.prepare(f.job,'refund',f.buyer)).intent,null,state);
  await assert.rejects(f.service.prepare(f.job,'refund',{...f.buyer,wallet:wallet('unrelated.testnet')}),{code:'WALLET_OWNER_REQUIRED'});
 }
});
