export const RPC='https://test.rpc.fastnear.com';
export const testnetAccount=value=>typeof value==='string'&&value.length>=8&&value.length<=64&&(/^[a-f0-9]{64}$/.test(value)||/^[a-z0-9]+(?:[-_][a-z0-9]+)*(?:\.[a-z0-9]+(?:[-_][a-z0-9]+)*)*\.testnet$/.test(value));
export const transactionHash=value=>typeof value==='string'&&/^[1-9A-HJ-NP-Za-km-z]{43,44}$/.test(value);
const success=s=>s&&typeof s==='object'&&!Object.hasOwn(s,'Failure')&&(Object.hasOwn(s,'SuccessValue')||Object.hasOwn(s,'SuccessReceiptId'));
/** Read-only testnet RPC. A direct transfer has no job memo and is NOT escrow. */
export function paymentVerifier(fetcher=fetch){
 async function rpc(method,params){
  const r=await fetcher(RPC,{method:'POST',redirect:'error',signal:AbortSignal.timeout(12000),headers:{'content-type':'application/json'},body:JSON.stringify({jsonrpc:'2.0',id:'workspace',method,params})});
  if(!r.ok)throw Error('RPC unavailable');
  const reader=r.body.getReader(),chunks=[];let size=0;
  try{for(;;){const {done,value}=await reader.read();if(done)break;size+=value.byteLength;if(size>2*1024*1024){await reader.cancel();throw Error('RPC bound');}chunks.push(Buffer.from(value));}}finally{reader.releaseLock();}
  const json=JSON.parse(Buffer.concat(chunks).toString('utf8'));if(json.error||!json.result)throw Error('RPC unavailable');return json.result;
 }
 return async({transactionHash:hash,buyerAccount,job})=>{
  if(!transactionHash(hash)||!testnetAccount(buyerAccount))throw Error('Invalid payment');
  if((await rpc('status',[])).chain_id!=='testnet')throw Error('Wrong network');
  const result=await rpc('tx',{tx_hash:hash,sender_account_id:buyerAccount,wait_until:'FINAL'}),tx=result.transaction;
  if(result.final_execution_status!=='FINAL'||!Object.hasOwn(result.status||{},'SuccessValue')||!tx||tx.hash!==hash||tx.signer_id!==buyerAccount||tx.receiver_id!==job.selectedOffer.paymentAccount||!Array.isArray(tx.actions)||tx.actions.length!==1||Object.keys(tx.actions[0]).join()!=='Transfer'||tx.actions[0].Transfer.deposit!==job.selectedOffer.amountYocto)throw Error('Transfer mismatch');
  const outcomes=[result.transaction_outcome,...(result.receipts_outcome||[])];
  if(outcomes.length<2||outcomes.some(o=>!success(o?.outcome?.status)||!transactionHash(o?.block_hash)))throw Error('Unsuccessful receipts');
  let transactionTime;
  for(const hash of new Set(outcomes.map(o=>o.block_hash))){
   const block=await rpc('block',{block_id:hash}),h=block.header;
   if(h?.hash!==hash||typeof h.timestamp_nanosec!=='string'||!/^\d+$/.test(h.timestamp_nanosec)||BigInt(h.timestamp_nanosec)<BigInt(Date.parse(job.createdAt))*1000000n)throw Error('Old transfer');
   if(hash===result.transaction_outcome.block_hash)transactionTime=h.timestamp_nanosec;
  }
  return {status:'PAID',network:'testnet',kind:'DIRECT_TESTNET_TRANSFER',transactionHash:hash,buyerAccount,receiverId:tx.receiver_id,amountYocto:tx.actions[0].Transfer.deposit,blockTimestampNanosec:transactionTime};
 };
}
