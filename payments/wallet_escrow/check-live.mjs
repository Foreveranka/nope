/** Real synthetic wallet-funded testnet checks; no private customer data/proof. */
import fs from 'node:fs';import path from 'node:path';import {randomBytes} from 'node:crypto';
import {actions} from 'near-api-js';
import {ROOT,DIR,PUBLIC,DOMAIN,rpc,sha,identities,privateRead,privateWrite,publicWrite,sendOnce} from './provision.mjs';
const AMOUNT='1000000000000000000000'; //0.001 testNEAR
const ids=identities(),contract=ids.contract.account_id;
function require(value,message){if(!value)throw Error(message);}
const binding=t=>sha(JSON.stringify([DOMAIN,contract,t.job_id,t.buyer_commitment,t.buyer_account,t.provider,t.amount,t.input_hash,t.program_hash,t.plan_hash,t.execution_deadline_ns,t.review_deadline_ns])).toString('hex');
async function ready(){
 await rpc.connect();const expected=JSON.parse(fs.readFileSync(path.join(PUBLIC,'deployment-public.json'),'utf8'));
 const block=await rpc.request('block',{finality:'final'}),b=block.header.hash;
 const a=await rpc.request('query',{request_type:'view_account',account_id:contract,block_id:b});
 const k=await rpc.request('query',{request_type:'view_access_key_list',account_id:contract,block_id:b});
 require(expected.requireKeyless===true&&expected.keys.length===0&&a.code_hash===expected.codeHash&&k.keys.length===0,'PINNED_FINAL_KEYLESS_CONTRACT_REQUIRED');return{blockHash:b,codeHash:a.code_hash,keys:k.keys};
}
async function savedTerms(name,short){
 if(fs.existsSync(path.join(DIR,`live-${name}-terms.json`)))return privateRead(`live-${name}-terms.json`);
 const b=await rpc.request('block',{finality:'final'}),now=BigInt(b.header.timestamp_nanosec);
 const t={job_id:randomBytes(16).toString('hex'),buyer_commitment:sha('NOPE:synthetic-customer-wallet:'+ids.buyer.account_id).toString('hex'),buyer_account:ids.buyer.account_id,provider:ids.provider.account_id,amount:AMOUNT,input_hash:'22'.repeat(32),program_hash:'33'.repeat(32),plan_hash:'44'.repeat(32),execution_deadline_ns:(now+(short?40n:3600n)*10n**9n).toString(),review_deadline_ns:(now+(short?60n:7200n)*10n**9n).toString()};
 privateWrite(`live-${name}-terms.json`,t);return t;
}
async function call(id,label,method,args,deposit=0n){
 await ready();return sendOnce(id,'live-'+label,contract,[actions.functionCall(method,args,150_000_000_000_000n,deposit)]);
}
async function get(t){return(await rpc.view(contract,'get_hold',{buyer_account:t.buyer_account,job_id:t.job_id})).value;}
function verifyFund(result,t){
 const c=result.transaction.actions[0]?.FunctionCall;
 require(result.final_execution_status==='FINAL'&&result.transaction.signer_id===t.buyer_account&&result.transaction.receiver_id===contract&&result.transaction.actions.length===1&&c?.method_name==='fund'&&c.deposit===t.amount,'EXACT_CUSTOMER_WALLET_FUND_TRANSACTION_REQUIRED');
 require(JSON.stringify(JSON.parse(Buffer.from(c.args,'base64').toString()))===JSON.stringify({terms:t}),'FUNDED_TERMS_MISMATCH');
 const h=JSON.parse(Buffer.from(result.status.SuccessValue,'base64').toString());require(h.binding_hash===binding(t)&&h.state==='Held','FUNDED_BINDING_MISMATCH');return h;
}
function verifyNative(result,t,h,action){
 require(result.final_execution_status==='FINAL'&&result.transaction.signer_id===t.buyer_account&&result.transaction.receiver_id===contract&&result.status.SuccessValue===Buffer.from('true').toString('base64'),'FINAL_BUYER_TRANSFER_RESULT_REQUIRED');
 const nodes=new Map();for(const n of[result.transaction_outcome,...result.receipts_outcome]){require(!nodes.has(n.id)&&!n.outcome.status.Failure,'FAILED_OR_DUPLICATE_RECEIPT');nodes.set(n.id,n);}
 const seen=new Set(),queue=[result.transaction.hash];while(queue.length){const id=queue.pop();require(!seen.has(id)&&nodes.has(id),'DISCONNECTED_RECEIPT_GRAPH');seen.add(id);queue.push(...nodes.get(id).outcome.receipt_ids);}require(seen.size===nodes.size,'UNRELATED_RECEIPT_OUTCOME');
 const receiver=action==='payout'?t.provider:t.buyer_account;
 const transfers=result.receipts.filter(r=>r.predecessor_id===contract&&r.receiver_id===receiver&&JSON.stringify(r.receipt?.Action?.actions)===JSON.stringify([{Transfer:{deposit:t.amount}}]));
 require(transfers.length===1&&JSON.stringify(nodes.get(transfers[0].receipt_id)?.outcome.status)==='{"SuccessValue":""}','ONE_SUCCESSFUL_EXACT_NATIVE_TRANSFER_REQUIRED');
 const callbacks=result.receipts.filter(r=>r.predecessor_id===contract&&r.receiver_id===contract&&r.receipt?.Action?.actions?.length===1&&r.receipt.Action.actions[0]?.FunctionCall?.method_name==='on_transfer');require(callbacks.length===1,'ONE_CALLBACK_REQUIRED');
 const cb=callbacks[0],c=cb.receipt.Action.actions[0].FunctionCall,args=JSON.parse(Buffer.from(c.args,'base64').toString());
 require(c.deposit==='0'&&c.gas===20_000_000_000_000&&args.buyer_account===t.buyer_account&&args.job_id===t.job_id&&args.nonce===h.nonce&&args.action===action,'CALLBACK_BINDING_MISMATCH');
 require(nodes.get(cb.receipt_id)?.outcome.status.SuccessValue===Buffer.from('true').toString('base64'),'CALLBACK_DID_NOT_CONFIRM_SUCCESS');
 require(h.state===(action==='payout'?'Paid':'Refunded')&&h.pending===null&&h.binding_hash===binding(t),'FINAL_HOLD_MISMATCH');
 return{transactionHash:result.transaction.hash,transferReceiptId:transfers[0].receipt_id,callbackReceiptId:cb.receipt_id,receiver,amountYocto:t.amount,nonce:h.nonce,state:h.state,finalReceiptGraphConnected:true,exactNativeTransfer:true,successfulNonceActionCallback:true};
}
async function main(){
 const pin=await ready(),payout=await savedTerms('payout',false);
 const fund=await call(ids.buyer,'payout-fund','fund',{terms:payout},BigInt(AMOUNT));verifyFund(fund,payout);publicWrite('live-payout-fund-rpc.json',fund);
 const args={buyer_account:payout.buyer_account,job_id:payout.job_id,version:1,output_hash:'55'.repeat(32)};
 const record=await call(ids.provider,'payout-record','record_delivery',args);publicWrite('live-payout-record-rpc.json',record);
 let paid=await call(ids.buyer,'payout-release','accept_and_release',args);
 // send_tx can omit receipt bodies. Reconcile the SAME signed transaction,
 // never generate a new payment merely to obtain observation data.
 paid=await rpc.request('EXPERIMENTAL_tx_status',{tx_hash:paid.transaction.hash,sender_account_id:ids.buyer.account_id,wait_until:'FINAL'});publicWrite('live-payout-release-rpc.json',paid);
 const ph=await get(payout),payment=verifyNative(paid,payout,ph,'payout');
 publicWrite('live-payout-check.json',{status:'PASS',network:'testnet',contractId:contract,codeHash:pin.codeHash,buyer:payout.buyer_account,provider:payout.provider,jobId:payout.job_id,bindingHash:ph.binding_hash,actualExternalChain:true,computationProof:false,...payment});
 if(process.argv.includes('--payout-only')){console.log(JSON.stringify({status:'PASS',stage:'payout-read-only-reconciled',...payment}));return;}
 const refund=await savedTerms('refund',true),fund2=await call(ids.buyer,'refund-fund','fund',{terms:refund},BigInt(AMOUNT));verifyFund(fund2,refund);publicWrite('live-refund-fund-rpc.json',fund2);
 console.log(JSON.stringify({stage:'payout-verified-refund-deadline-pending',contractId:contract,payment,refundJobId:refund.job_id,reviewDeadlineNs:refund.review_deadline_ns}));
 for(;;){const b=await rpc.request('block',{finality:'final'});if(BigInt(b.header.timestamp_nanosec)>BigInt(refund.review_deadline_ns))break;await new Promise(r=>setTimeout(r,3000));}
 let returned=await call(ids.buyer,'refund-return','refund',{buyer_account:refund.buyer_account,job_id:refund.job_id});
 returned=await rpc.request('EXPERIMENTAL_tx_status',{tx_hash:returned.transaction.hash,sender_account_id:ids.buyer.account_id,wait_until:'FINAL'});publicWrite('live-refund-return-rpc.json',returned);
 const rh=await get(refund),refunded=verifyNative(returned,refund,rh,'refund');
 const config=(await rpc.view(contract,'get_config',{})).value;
 require(BigInt(config.total_deposited)===BigInt(config.liabilities)+BigInt(config.total_paid)+BigInt(config.total_refunded)&&BigInt(config.pending_outgoing)<=BigInt(config.liabilities),'GLOBAL_LIABILITY_ACCOUNTING_MISMATCH');
 const finalPin=await ready();const out={status:'PASS',network:'testnet',actualExternalChain:true,syntheticOnly:true,computationProof:false,contractId:contract,codeHash:pin.codeHash,keys:finalPin.keys,buyer:payout.buyer_account,provider:payout.provider,amountYoctoEach:AMOUNT,payout:{jobId:payout.job_id,bindingHash:ph.binding_hash,...payment},refund:{jobId:refund.job_id,bindingHash:rh.binding_hash,...refunded},finalConfig:config,verifiedAt:new Date().toISOString()};publicWrite('live-financial-checks.json',out);console.log(JSON.stringify(out));
}
main().catch(e=>{console.error('WALLET_LIVE_CHECK_FAILED: '+e.message);process.exitCode=1;});
