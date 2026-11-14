/** Buyer-wallet TESTNET escrow. Read-only RPC, immutable intents; NEVER broadcasts. */
import {createHash} from 'node:crypto';
import {testnetAccount,transactionHash} from './payment.mjs';
import {WALLET_ROOT,createWalletRPC,canonical,chainHash,decodeBase64} from './wallet-auth.mjs';
export const WALLET_ESCROW_KIND='WALLET_TESTNET_ESCROW';
export const WALLET_ESCROW_DOMAIN='NOPE:WALLET-ESCROW:V1:testnet';
const GAS='150000000000000',METHODS={fund:'fund',record:'record_delivery',release:'accept_and_release',refund:'refund'};
const HASH_FIELDS={fund:'fundTransactionHash',record:'recordTransactionHash',release:'releaseTransactionHash',refund:'refundTransactionHash'};
const PENDING={fund:'FUNDING_PENDING',record:'RECORD_PENDING',release:'PAYOUT_PENDING',refund:'REFUND_PENDING'};
const sha=s=>createHash('sha256').update(s).digest('hex');
const hex=(v,n=64)=>typeof v==='string'&&new RegExp(`^[a-f0-9]{${n}}$`).test(v);
const equal=(a,b)=>canonical(a)===canonical(b);
const fail=(code,status=409)=>{throw Object.assign(Error(code),{code,status});};
const check=(v,code,status)=>{if(!v)fail(code,status);};
const uint=v=>typeof v==='string'&&/^(0|[1-9][0-9]*)$/.test(v)&&BigInt(v)<(1n<<64n);
const delivery=job=>{const d=job.delivery;check(Number.isInteger(d?.version)&&d.version>0&&d.version<=0xffffffff&&hex(d.outputSha256),'WALLET_DELIVERY_REQUIRED');return{version:d.version,output_hash:d.outputSha256};};
export function walletTermsForJob(job,contractId){
 check(testnetAccount(contractId)&&hex(job?.id,32)&&hex(job?.buyerId,32)&&hex(job.taskHash)&&hex(job.programHash)&&hex(job.planSha256??'0'.repeat(64)),'WALLET_INVALID_JOB');
 const buyer=job.buyerWallet,offer=job.selectedOffer,amount=offer?.amountYocto;
 check(buyer?.network==='testnet'&&testnetAccount(buyer.accountId)&&offer?.wallet?.network==='testnet'&&offer.wallet.accountId===offer.paymentAccount&&testnetAccount(offer.paymentAccount)&&offer.paymentAccount!==buyer.accountId&&offer.paymentAccount!==contractId&&buyer.accountId!==contractId,'WALLET_PARTIES_NOT_VERIFIED');
 check(typeof amount==='string'&&/^[1-9][0-9]{0,24}$/.test(amount)&&BigInt(amount)<=10n**24n,'WALLET_AMOUNT_LIMIT');
 const awarded=job.payment?.awardedAtISO,ms=typeof awarded==='string'?Date.parse(awarded):NaN;
 check(Number.isSafeInteger(ms)&&ms>=0&&new Date(ms).toISOString()===awarded,'WALLET_AWARD_TIME_REQUIRED');
 const execution=BigInt(ms)*1000000n+86400000000000n,review=execution+86400000000000n;check(review<(1n<<64n),'WALLET_INVALID_DEADLINE');
 // Field order is the reviewed contract's compact-JSON binding tuple order.
 const terms={job_id:job.id,buyer_commitment:sha('NOPE:buyer:'+job.buyerId),buyer_account:buyer.accountId,provider:offer.paymentAccount,amount,input_hash:job.taskHash,program_hash:job.programHash,plan_hash:job.planSha256??'0'.repeat(64),execution_deadline_ns:String(execution),review_deadline_ns:String(review)};
 return{terms,bindingHash:sha(JSON.stringify([WALLET_ESCROW_DOMAIN,contractId,...Object.values(terms)]))};
}
export function createWalletEscrow({store,env=process.env,config,now=Date.now,rpc}={}){
 if(!config)return null;
 config=Object.freeze(structuredClone(config));
 check(config.network==='testnet'&&config.domain===WALLET_ESCROW_DOMAIN&&testnetAccount(config.contractId)&&chainHash(config.codeHash)&&config.requireKeyless===true&&store&&typeof store.read==='function'&&typeof store.create==='function','WALLET_ESCROW_CONFIG',503);
 rpc??=createWalletRPC(config);const contractId=config.contractId;
 function context(job){check(job.payment?.kind===WALLET_ESCROW_KIND&&job.payment.contractId===contractId,'WALLET_ESCROW_JOB_REQUIRED');return walletTermsForJob(job,contractId);}
 function actor(job,action,session){
  check(session?.wallet?.network==='testnet'&&testnetAccount(session.wallet.accountId),'WALLET_LINK_REQUIRED',403);
  const owner=session.role==='buyer'&&session.wallet.accountId===job.buyerWallet?.accountId;
  const provider=session.role==='provider'&&session.wallet.accountId===job.selectedOffer?.wallet?.accountId&&session.wallet.accountId===job.selectedOffer?.paymentAccount;
  check(owner||['record','refresh'].includes(action)&&provider,'WALLET_OWNER_REQUIRED',403);return session.wallet.accountId;
 }
 async function snapshot(ctx){
  check((await rpc('status',[]))?.chain_id==='testnet','WALLET_WRONG_NETWORK',503);
  const account=await rpc('query',{request_type:'view_account',account_id:contractId,finality:'final'});
  check(account.code_hash===config.codeHash&&chainHash(account.block_hash),'WALLET_CODE_PIN_MISMATCH',503);
  const keys=await rpc('query',{request_type:'view_access_key_list',account_id:contractId,block_id:account.block_hash});
  check(keys.block_hash===account.block_hash&&Array.isArray(keys.keys)&&keys.keys.length===0,'WALLET_CONTRACT_NOT_KEYLESS',503);
  const result=await rpc('query',{request_type:'call_function',account_id:contractId,method_name:'get_hold',args_base64:Buffer.from(JSON.stringify({buyer_account:ctx.terms.buyer_account,job_id:ctx.terms.job_id})).toString('base64'),block_id:account.block_hash});
  check(result.block_hash===account.block_hash&&Array.isArray(result.result)&&result.result.length<=16384&&result.result.every(b=>Number.isInteger(b)&&b>=0&&b<=255),'WALLET_HOLD_UNVERIFIED',503);
  const hold=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(new Uint8Array(result.result)));
  if(hold!==null){
   check(equal(hold.terms,ctx.terms)&&hold.binding_hash===ctx.bindingHash&&['Held','Delivered','PayoutPending','RefundPending','Paid','Refunded'].includes(hold.state)&&uint(hold.nonce),'WALLET_HOLD_BINDING_MISMATCH');
   check(hold.last_transfer_failure_nonce===null||uint(hold.last_transfer_failure_nonce),'WALLET_HOLD_INVALID');
   if(hold.delivery!==null)check(Number.isInteger(hold.delivery?.version)&&hold.delivery.version>0&&hold.delivery.version<=0xffffffff&&hex(hold.delivery.output_hash),'WALLET_HOLD_INVALID');
   if(['Delivered','PayoutPending','Paid'].includes(hold.state))check(hold.delivery!==null,'WALLET_HOLD_INVALID');
   if(['PayoutPending','RefundPending'].includes(hold.state))check(hold.pending?.action===(hold.state==='PayoutPending'?'payout':'refund')&&['Held','Delivered'].includes(hold.pending.previous_state),'WALLET_HOLD_INVALID');
   else check(hold.pending===null,'WALLET_HOLD_INVALID');
  }
  return{hold,blockHash:account.block_hash,blockHeight:String(account.block_height)};
 }
 function facts(job,ctx,snap){
  const h=snap.hold;
  const base={kind:WALLET_ESCROW_KIND,network:'testnet',contractId,buyerAccount:ctx.terms.buyer_account,bindingHash:ctx.bindingHash,executionDeadlineNs:ctx.terms.execution_deadline_ns,reviewDeadlineNs:ctx.terms.review_deadline_ns,awardedAtISO:job.payment.awardedAtISO,stateVerified:true,receiptVerified:false,stateBlockHash:snap.blockHash,verified:Boolean(h),verifiedTransactions:{...(job.payment.verifiedTransactions||{})}};
  for(const [action,key] of Object.entries(HASH_FIELDS))if(job.payment.verifiedTransactions?.[action]===job.payment[key]&&transactionHash(job.payment[key]))base[key]=job.payment[key];
  if(h?.delivery){base.recordedVersion=h.delivery.version;base.recordedOutputHash=h.delivery.output_hash;}
  const statuses={Held:job.status==='ACCEPTED'?'RELEASE_READY':'HELD',Delivered:job.status==='ACCEPTED'?'RELEASE_READY':'HELD',PayoutPending:'PAYOUT_PENDING',RefundPending:'REFUND_PENDING',Paid:'PAID',Refunded:'REFUNDED'};
  base.status=h?statuses[h.state]:'NOT_FUNDED';
  if(h&&['PayoutPending','RefundPending'].includes(h.state))base.verified=false;
  if(h?.delivery&&job.delivery&&(h.delivery.version>job.delivery.version||h.delivery.version===job.delivery.version&&h.delivery.output_hash!==job.delivery.outputSha256))fail('WALLET_LATEST_DELIVERY_MISMATCH');
  if(h?.state==='Paid')check(['ACCEPTED','PAID'].includes(job.status)&&h.delivery?.version===job.delivery?.version&&h.delivery?.output_hash===job.delivery?.outputSha256,'WALLET_ACCEPTANCE_REQUIRED');
  return base;
 }
 function allowed(job,action,ctx,payment){
  const ns=BigInt(now())*1000000n,execute=BigInt(ctx.terms.execution_deadline_ns),review=BigInt(ctx.terms.review_deadline_ns);
  if(action==='fund')return job.status==='AWARDED'&&payment.status==='NOT_FUNDED'&&ns<execute;
  if(action==='record')return job.status==='DELIVERED'&&payment.status==='HELD'&&ns<execute&&(!job.delivery||payment.recordedVersion!==job.delivery.version||payment.recordedOutputHash!==job.delivery.outputSha256);
  if(action==='release')return job.status==='ACCEPTED'&&payment.status==='RELEASE_READY'&&ns<review&&payment.recordedVersion===job.delivery?.version&&payment.recordedOutputHash===job.delivery?.outputSha256;
  return action==='refund'&&['AWARDED','DELIVERED','REVISION','ACCEPTED'].includes(job.status)&&['HELD','RELEASE_READY'].includes(payment.status)&&ns>review;
 }
 function intentFor(job,action,ctx,signerId){
  const args=action==='fund'?{terms:ctx.terms}:['record','release'].includes(action)?{buyer_account:ctx.terms.buyer_account,job_id:job.id,...delivery(job)}:{buyer_account:ctx.terms.buyer_account,job_id:job.id};
  const transaction={signerId,receiverId:contractId,actions:[{type:'FunctionCall',params:{methodName:METHODS[action],args,gas:GAS,deposit:action==='fund'?ctx.terms.amount:'0'}}]};
  const value={action,network:'testnet',bindingHash:ctx.bindingHash,transaction};return{id:sha(canonical(value)),...value};
 }
 async function intentRecord(job,action,session){
  const ctx=context(job),signerId=actor(job,action,session),intent=intentFor(job,action,ctx,signerId),path=`${WALLET_ROOT}intents/${intent.id}.json`,record=await store.read(path);
  check(record&&equal(record.intent,intent)&&record.jobId===job.id&&record.buyerAccount===ctx.terms.buyer_account,'WALLET_INTENT_REQUIRED');return{ctx,intent};
 }
 async function prepare(job,action,session){
  check(Object.hasOwn(METHODS,action),'WALLET_INVALID_ACTION',400);const ctx=context(job),signerId=actor(job,action,session),snap=await snapshot(ctx);let payment=facts(job,ctx,snap);
  if(job.payment.operation&&['PENDING','UNKNOWN'].includes(job.payment.operation.status)&&!['PAID','REFUNDED'].includes(payment.status)){
   const recovered=action==='refund'?await expiredRecord(job,ctx,snap,payment):null;
   if(recovered)payment=recovered;else return{intent:null,payment:await refresh(job,session)};
  }
  if(!allowed(job,action,ctx,payment)){
   if(action==='fund'&&snap.hold||['PAID','REFUNDED','PAYOUT_PENDING','REFUND_PENDING'].includes(payment.status))return{intent:null,payment};
   fail('WALLET_ACTION_NOT_ALLOWED');
  }
  const intent=intentFor(job,action,ctx,signerId),record={version:1,jobId:job.id,buyerAccount:ctx.terms.buyer_account,intent,createdAt:new Date(now()).toISOString()},path=`${WALLET_ROOT}intents/${intent.id}.json`;
  if(!await store.create(path,record)){const stored=await store.read(path);check(stored?.version===1&&stored.jobId===job.id&&stored.buyerAccount===ctx.terms.buyer_account&&equal(stored.intent,intent),'WALLET_INTENT_INTEGRITY',503);}
  return{intent,payment:{...payment,operation:{action,intentId:intent.id,status:'PREPARED'}}};
 }
 function checkTransaction(result,intent,hash){
  const tx=result?.transaction,c=tx?.actions?.[0]?.FunctionCall,expected=intent.transaction,a=expected.actions[0].params;
  check(tx?.hash===hash&&tx.signer_id===expected.signerId&&tx.receiver_id===contractId&&Array.isArray(tx.actions)&&tx.actions.length===1&&Object.keys(tx.actions[0]).join()==='FunctionCall'&&c.method_name===a.methodName&&String(c.gas)===a.gas&&c.deposit===a.deposit&&decodeBase64(c.args).toString('utf8')===JSON.stringify(a.args),'WALLET_TRANSACTION_MISMATCH');
  return result.final_execution_status==='FINAL';
 }
 function receipts(result,hash){
  check(result.transaction_outcome?.id===hash&&Array.isArray(result.receipts_outcome)&&result.receipts_outcome.length>0&&result.receipts_outcome.length<=64,'WALLET_RECEIPT_TREE_REQUIRED');
  const nodes=new Map();let failed=false;
  for(const node of [result.transaction_outcome,...result.receipts_outcome]){
   const o=node?.outcome,s=o?.status;check(chainHash(node?.id)&&chainHash(node.block_hash)&&!nodes.has(node.id)&&Array.isArray(o?.receipt_ids)&&o.receipt_ids.length<=64&&new Set(o.receipt_ids).size===o.receipt_ids.length&&o.receipt_ids.every(chainHash)&&s&&Object.keys(s).length===1,'WALLET_RECEIPT_TREE_REQUIRED');
   if(Object.hasOwn(s,'Failure'))failed=true;else if(typeof s.SuccessValue==='string')decodeBase64(s.SuccessValue);else check(typeof s.SuccessReceiptId==='string'&&o.receipt_ids.includes(s.SuccessReceiptId),'WALLET_RECEIPT_TREE_REQUIRED');nodes.set(node.id,node);
  }
  const seen=new Set(),todo=[hash];while(todo.length){const id=todo.pop();check(!seen.has(id)&&nodes.has(id),'WALLET_RECEIPT_TREE_REQUIRED');seen.add(id);todo.push(...nodes.get(id).outcome.receipt_ids);}check(seen.size===nodes.size,'WALLET_RECEIPT_TREE_REQUIRED');
  return{nodes,failed};
 }
 async function payout(result,intent,hold,nodes){
  check(hold&&hold.state===(intent.action==='release'?'Paid':'Refunded')&&result.status?.SuccessValue===Buffer.from('true').toString('base64'),'WALLET_TRANSFER_NOT_VERIFIED');
  const bodies=[];for(const id of nodes.keys())if(id!==result.transaction_outcome.id){
   let body=result.receipts?.find(r=>r.receipt_id===id);if(!body)body=await rpc('EXPERIMENTAL_receipt',{receipt_id:id});
   check(body?.receipt_id===id&&nodes.has(id),'WALLET_TRANSFER_NOT_VERIFIED');bodies.push(body);
  }
  const recipient=intent.action==='release'?hold.terms.provider:hold.terms.buyer_account;
  const transfer=bodies.filter(r=>r.predecessor_id===contractId&&r.receiver_id===recipient&&equal(r.receipt?.Action?.actions,[{Transfer:{deposit:hold.terms.amount}}]));
  check(transfer.length===1&&nodes.get(transfer[0].receipt_id).outcome.executor_id===recipient&&equal(nodes.get(transfer[0].receipt_id).outcome.status,{SuccessValue:''}),'WALLET_TRANSFER_NOT_VERIFIED');
  const callback=bodies.filter(r=>{const a=r.receipt?.Action?.actions,c=a?.[0]?.FunctionCall;if(r.predecessor_id!==contractId||r.receiver_id!==contractId||!Array.isArray(a)||a.length!==1||c?.method_name!=='on_transfer'||c.deposit!=='0'||String(c.gas)!=='20000000000000')return false;try{return equal(JSON.parse(decodeBase64(c.args)),{buyer_account:hold.terms.buyer_account,job_id:hold.terms.job_id,nonce:hold.nonce,action:intent.action==='release'?'payout':'refund'});}catch{return false;}});
  check(callback.length===1&&nodes.get(callback[0].receipt_id).outcome.executor_id===contractId&&equal(nodes.get(callback[0].receipt_id).outcome.status,{SuccessValue:Buffer.from('true').toString('base64')}),'WALLET_TRANSFER_NOT_VERIFIED');
 }
 function completed(intent,hold){
  if(!hold)return false;
  if(intent.action==='fund')return true;
  if(intent.action==='release')return hold.state==='Paid';
  if(intent.action==='refund')return hold.state==='Refunded';
  const args=intent.transaction.actions[0].params.args;
  return hold.delivery&&hold.delivery.version>=args.version&&(hold.delivery.version!==args.version||hold.delivery.output_hash===args.output_hash);
 }
 function uncertain(payment,operation){
  const pending=['PAYOUT_PENDING','REFUND_PENDING'].includes(payment.status);
  return{...payment,status:pending?payment.status:'UNKNOWN',verified:false,operation:{...operation,status:pending?'PENDING':'UNKNOWN'}};
 }
 function storedIntent(record,job,ctx){
  const intent=record?.intent,tx=intent?.transaction,args=tx?.actions?.[0]?.params?.args;
  check(record?.version===1&&record.jobId===job.id&&record.buyerAccount===ctx.terms.buyer_account&&Object.hasOwn(METHODS,intent?.action),'WALLET_INTENT_INTEGRITY',503);
  const signer=intent.action==='record'?[ctx.terms.buyer_account,ctx.terms.provider]:[ctx.terms.buyer_account];
  check(signer.includes(tx?.signerId),'WALLET_INTENT_INTEGRITY',503);
  const historical=intent.action==='record'?{...job,delivery:{version:args?.version,outputSha256:args?.output_hash}}:job;
  check(equal(intent,intentFor(historical,intent.action,ctx,tx.signerId)),'WALLET_INTENT_INTEGRITY',503);return intent;
 }
 const retirementPath=id=>`${WALLET_ROOT}intents/${sha('expired-record:'+id)}.json`;
 async function expiredRecord(job,ctx,snap,payment){
  const op=job.payment.operation,h=snap.hold;
  if(op?.action!=='record'||!['PREPARED','PENDING','UNKNOWN','EXPIRED'].includes(op.status)||!h||!['Held','Delivered'].includes(h.state)||h.pending!==null)return null;
  if(BigInt(now())*1000000n<=BigInt(ctx.terms.review_deadline_ns))return null;
  const record=await store.read(`${WALLET_ROOT}intents/${op.intentId}.json`),intent=storedIntent(record,job,ctx);
  check(intent.action==='record'&&intent.id===op.intentId,'WALLET_INTENT_INTEGRITY',503);
  if(completed(intent,h))return null;
  // A host-clock deadline cannot retire a possibly live transaction. Read the
  // SAME pinned FINAL block as the hold. After review expiry, record_delivery
  // can never execute: its immutable execution deadline is already in the past.
  const block=await rpc('block',{block_id:snap.blockHash}),header=block?.header;
  check(header?.hash===snap.blockHash&&String(header.height)===snap.blockHeight&&uint(String(header.timestamp_nanosec)),'WALLET_FINAL_TIME_UNVERIFIED',503);
  if(BigInt(header.timestamp_nanosec)<=BigInt(ctx.terms.review_deadline_ns))return null;
  const retired={version:1,kind:'EXPIRED_RECORD_INTENT',intentId:intent.id,jobId:job.id,buyerAccount:ctx.terms.buyer_account,codeHash:config.codeHash,blockHash:snap.blockHash,expiredAtNs:String(header.timestamp_nanosec),holdNonce:h.nonce};
  const path=retirementPath(intent.id);
  if(!await store.create(path,retired)){
   const prior=await store.read(path);
   check(prior?.version===1&&prior.kind===retired.kind&&prior.intentId===intent.id&&prior.jobId===job.id&&prior.buyerAccount===ctx.terms.buyer_account&&prior.codeHash===config.codeHash&&chainHash(prior.blockHash)&&uint(prior.expiredAtNs)&&BigInt(prior.expiredAtNs)>BigInt(ctx.terms.review_deadline_ns)&&uint(prior.holdNonce),'WALLET_INTENT_INTEGRITY',503);
  }
  // Keep the old intent/claim immutable. Its retirement marker prevents a late
  // record confirmation from resurrecting UNKNOWN over a buyer's new refund.
  return{...payment,operation:{...op,status:'EXPIRED',code:'WALLET_RECORD_WINDOW_EXPIRED',expiredAtBlockHash:snap.blockHash,holdNonce:h.nonce}};
 }
 async function observe(job,intent,hash){
  const ctx=context(job),operation={action:intent.action,intentId:intent.id,transactionHash:hash,status:'UNKNOWN'};
  let result;
  try{result=await rpc('tx',{tx_hash:hash,sender_account_id:intent.transaction.signerId,wait_until:'FINAL'});}catch(error){
   if(error.rpcCode===-32601){try{result=await rpc('EXPERIMENTAL_tx_status',{tx_hash:hash,sender_account_id:intent.transaction.signerId,wait_until:'FINAL'});}catch{}}
  }
  const snap=await snapshot(ctx),payment=facts(job,ctx,snap),recovered=await expiredRecord(job,ctx,snap,payment);
  if(recovered)return recovered;
  if(!result)return completed(intent,snap.hold)?payment:uncertain(payment,operation);
  checkTransaction(result,intent,hash);
  if(result.final_execution_status!=='FINAL')return{...payment,status:PENDING[intent.action],verified:false,operation:{...operation,status:'PENDING'}};
  const{nodes,failed}=receipts(result,hash);
  if(failed||Object.hasOwn(result.status||{},'Failure'))return{...payment,operation:{...operation,status:'ERROR',code:'WALLET_FINAL_TRANSACTION_FAILED'}};
  check(typeof result.status?.SuccessValue==='string','WALLET_FINAL_RESULT_REQUIRED');
  for(const block of new Set([...nodes.values()].map(n=>n.block_hash))){const b=await rpc('block',{block_id:block});check(b.header?.hash===block&&uint(String(b.header.timestamp_nanosec))&&BigInt(b.header.timestamp_nanosec)>=BigInt(Date.parse(job.createdAt))*1000000n&&BigInt(String(b.header.height))<=BigInt(snap.blockHeight),'WALLET_TRANSACTION_BLOCK_MISMATCH');}
  if(intent.action==='fund')check(snap.hold!==null,'WALLET_FUND_STATE_MISMATCH');
  if(['record','release'].includes(intent.action))check(equal(snap.hold?.delivery,{version:intent.transaction.actions[0].params.args.version,output_hash:intent.transaction.actions[0].params.args.output_hash}),'WALLET_LATEST_DELIVERY_MISMATCH');
  if(['release','refund'].includes(intent.action))await payout(result,intent,snap.hold,nodes);
  return{...payment,receiptVerified:true,verifiedTransactions:{...payment.verifiedTransactions,[intent.action]:hash},[HASH_FIELDS[intent.action]]:hash,operation:{...operation,status:'FINAL'}};
 }
 async function confirm(job,action,hash,session){
  check(Object.hasOwn(METHODS,action)&&chainHash(hash),'WALLET_INVALID_CONFIRMATION',400);const{intent}=await intentRecord(job,action,session);
  check(await store.read(retirementPath(intent.id))===null,'WALLET_INTENT_EXPIRED');
  if(job.payment.operation&&['PREPARED','PENDING','UNKNOWN'].includes(job.payment.operation.status))check(job.payment.operation.intentId===intent.id&&(!job.payment.operation.transactionHash||job.payment.operation.transactionHash===hash),'WALLET_PENDING_TRANSACTION_IMMUTABLE');
  const claim={jobId:job.id,buyerAccount:job.buyerWallet.accountId,intentId:intent.id,action,signerId:intent.transaction.signerId,transactionHash:hash},path=`${WALLET_ROOT}transactions/${sha(hash)}.json`;
  if(!await store.create(path,claim))check(equal(await store.read(path),claim),'WALLET_TRANSACTION_ALREADY_USED');
  return observe(job,intent,hash);
 }
 async function refresh(job,session){
  const ctx=context(job);actor(job,'refresh',session);const op=job.payment.operation;
  if(op?.transactionHash){const record=await store.read(`${WALLET_ROOT}intents/${op.intentId}.json`);return observe(job,storedIntent(record,job,ctx),op.transactionHash);}
  const snap=await snapshot(ctx),payment=facts(job,ctx,snap),recovered=await expiredRecord(job,ctx,snap,payment);
  if(recovered)return recovered;
  // No receipt hash is fabricated when a wallet broadcast response was lost.
  if(op&&['PREPARED','UNKNOWN','PENDING'].includes(op.status)){const record=await store.read(`${WALLET_ROOT}intents/${op.intentId}.json`),intent=storedIntent(record,job,ctx);if(!completed(intent,snap.hold))return uncertain(payment,op);}
  return payment;
 }
 return Object.freeze({kind:WALLET_ESCROW_KIND,contractId,network:'testnet',context,prepare,confirm,refresh});
}
