// Explicit NOPE TESTNET custody adapter. Never imports a mainnet wallet/defaults.
// SDK is read from the existing registry installation; no new npm installation.
import {createRequire} from 'node:module';
import {pathToFileURL, fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';
import {mkdirSync,lstatSync,readFileSync,writeFileSync,openSync,closeSync,fsyncSync,existsSync,constants} from 'node:fs';
import {dirname,join} from 'node:path';
import {loadIdentity,withLock} from '../../contracts/registry/deploy/storage.mjs';
import {TestnetRpc} from '../../contracts/registry/deploy/transport.mjs';
import {verifyArtifact as registryArtifact,domainHash} from '../../contracts/registry/deploy/policy.mjs';

const sdkRequire=createRequire(new URL('../../contracts/registry/deploy/package.json',import.meta.url));
const {actions,KeyPair,KeyPairSigner,PublicKey,createTransaction,baseDecode,baseEncode}=await import(pathToFileURL(sdkRequire.resolve('near-api-js')).href);
export const ROOT=fileURLToPath(new URL('./',import.meta.url));
export const OWNER='veil-reg-e138f5c88250f821.testnet';
export const ESCROW=`escrow.${OWNER}`;
export const NETWORK='testnet';
export const RPC='https://test.rpc.fastnear.com'; // official NEAR RPC provider list; explicit selection, no fallback
export const CREATE_ALLOCATION=3000000000000000000000000n; // explicit <=3 test NEAR
export const OWNER_MIN_RETAIN=1000000000000000000000000n;
const GAS_RESERVE=50000000000000000000000n; // additional 0.05 test NEAR allowance
export const MAX_PRICE=1000000000000000000000n; // <=0.001 test NEAR
export const STORAGE_TOPUP=20000000000000000000000n;
const EMPTY='11111111111111111111111111111111';
const hash=bytes=>createHash('sha256').update(bytes).digest();
const fail=code=>{throw new Error(code);};
const equal=(a,b)=>JSON.stringify(a)===JSON.stringify(b);
const u64=s=>typeof s==='string'&&/^[1-9][0-9]{0,19}$/.test(s)&&BigInt(s)<2n**64n;
const bytes=v=>Array.isArray(v)&&v.length===32&&v.every(x=>Number.isInteger(x)&&x>=0&&x<256)&&v.some(x=>x!==0);

function secureDirectory(path){
 if(!existsSync(path))mkdirSync(path,{mode:0o700});
 const stat=lstatSync(path);if(!stat.isDirectory()||stat.isSymbolicLink()||(stat.mode&0o077))fail('UNSAFE_PAYMENT_RUNTIME');
}
function privateRead(path){
 const stat=lstatSync(path);if(!stat.isFile()||stat.isSymbolicLink()||(stat.mode&0o777)!==0o600)fail('UNSAFE_PAYMENT_FILE');
 return JSON.parse(readFileSync(path,'utf8'));
}
function privateWrite(path,value){
 const fd=openSync(path,constants.O_WRONLY|constants.O_CREAT|constants.O_EXCL|constants.O_NOFOLLOW,0o600);
 try{writeFileSync(fd,JSON.stringify(value));fsyncSync(fd);}finally{closeSync(fd);}
 const parent=openSync(dirname(path),constants.O_RDONLY);try{fsyncSync(parent);}finally{closeSync(parent);}
}

export function reviewedArtifact(){
 const review=JSON.parse(readFileSync(join(ROOT,'verification/build.json'),'utf8'));
 const wasm=readFileSync(join(ROOT,'target/wasm32-unknown-unknown/release/nope_testnet_escrow.wasm'));
 if(hash(wasm).toString('hex')!==review.wasm_sha256||wasm.length!==review.size_bytes)fail('ESCROW_WASM_NOT_REVIEWED');
 for(const [name,pin]of Object.entries(review.source_sha256))if(hash(readFileSync(join(ROOT,name))).toString('hex')!==pin)fail('ESCROW_SOURCE_CHANGED_REBUILD_REVIEW');
 return{bytes:wasm,code_hash:baseEncode(hash(wasm)),size_bytes:wasm.length,sha256:review.wasm_sha256};
}

export function storagePreflight(wasmSize,pricePerByte,balance=CREATE_ALLOCATION){
 if(!Number.isSafeInteger(wasmSize)||wasmSize<8||typeof pricePerByte!=='string'||!/^\d+$/.test(pricePerByte)||BigInt(pricePerByte)<=0n)fail('STORAGE_PRICE_UNVERIFIED');
 const code=BigInt(wasmSize)*BigInt(pricePerByte),required=BigInt(wasmSize+8192)*BigInt(pricePerByte);
 return{code_storage_yocto:String(code),minimum_with_state_reserve_yocto:String(required),
  allocation_yocto:String(balance),sufficient:balance>=required,storage_price_per_byte:pricePerByte};
}

export function validateActions({id,receiver,label,list,artifact,childPublicKey}){
 if(!/^[a-z0-9-]{1,100}$/.test(label)||![OWNER,ESCROW].includes(id.account_id))fail('SIGNER_OR_LABEL_NOT_ALLOWED');
 if(label==='create-escrow'){
  if(id.account_id!==OWNER||receiver!==ESCROW||list.length!==3||list[0].enum!=='createAccount'||list[1].enum!=='transfer'||list[1].transfer.deposit!==CREATE_ALLOCATION||list[2].enum!=='addKey'||list[2].addKey.publicKey.toString()!==childPublicKey||list[2].addKey.accessKey.permission.enum!=='fullAccess')fail('CREATE_ESCROW_POLICY_REJECTED');
  return;
 }
 if(label==='deploy-escrow'){
  if(id.account_id!==ESCROW||receiver!==ESCROW||list.length!==2||list[0].enum!=='deployContract'||!Buffer.from(list[0].deployContract.code).equals(artifact.bytes))fail('DEPLOY_ESCROW_POLICY_REJECTED');
  const call=list[1].functionCall;
  if(list[1].enum!=='functionCall'||call.methodName!=='new'||call.deposit!==0n||call.gas!==50000000000000n||!equal(JSON.parse(Buffer.from(call.args)),{registry:OWNER}))fail('ESCROW_INITIALIZATION_REJECTED');
  return;
 }
 if(id.account_id!==OWNER||receiver!==ESCROW||list.length!==1||list[0].enum!=='functionCall')fail('ESCROW_CALL_POLICY_REJECTED');
 const call=list[0].functionCall,args=JSON.parse(Buffer.from(call.args));
 if(call.gas!==150000000000000n)fail('ESCROW_GAS_BOUND_REJECTED');
 if(label.startsWith('fund-')){
  const t=args.terms;
  if(call.methodName!=='fund'||!equal(Object.keys(args),['terms'])||!t||!u64(t.job_id)||label!==`fund-${t.job_id}`||t.buyer!==OWNER||![1,2,3].some(n=>t.provider===`p${n}.${OWNER}`)||!/^\d+$/.test(t.amount)||BigInt(t.amount)<1n||BigInt(t.amount)>MAX_PRICE||call.deposit!==BigInt(t.amount)+STORAGE_TOPUP||!bytes(t.context_hash)||!bytes(t.job_binding_hash)||Object.keys(t).sort().join(',')!==['job_id','buyer','provider','amount','context_hash','job_binding_hash'].sort().join(','))fail('ESCROW_FUNDING_POLICY_REJECTED');
 }else if(label.startsWith('release-')){
  const a=args.acceptance;
  if(call.methodName!=='release'||call.deposit!==0n||!u64(args.job_id)||label!==`release-${args.job_id}`||!a||!u64(a.attempt)||!bytes(a.attempt_binding_hash)||!bytes(a.receipt_hash)||!bytes(a.output_hash)||Object.keys(args).sort().join(',')!=='acceptance,job_id'||Object.keys(a).sort().join(',')!=='attempt,attempt_binding_hash,output_hash,receipt_hash')fail('ESCROW_RELEASE_POLICY_REJECTED');
 }else fail('ESCROW_METHOD_NOT_ALLOWED');
}

export function finalTransaction(result,expectedHash,sender,receiver){
 if(result?.final_execution_status!=='FINAL'||typeof result.status?.SuccessValue!=='string'||result.transaction?.hash!==expectedHash||result.transaction.signer_id!==sender||result.transaction.receiver_id!==receiver||result.transaction_outcome?.id!==expectedHash||!Array.isArray(result.receipts_outcome)||!result.receipts_outcome.length)fail('FINAL_TRANSACTION_EVIDENCE_REQUIRED_NO_RESEND');
 const nodes=new Map();
 for(const item of[result.transaction_outcome,...result.receipts_outcome]){
  if(!item?.id||nodes.has(item.id)||!Array.isArray(item.outcome?.receipt_ids))fail('INCOMPLETE_RECEIPT_TREE_NO_RESEND');
  const s=item.outcome.status;
  if(!s||Object.keys(s).length!==1||!(typeof s.SuccessValue==='string'||typeof s.SuccessReceiptId==='string'))fail('FAILED_OR_UNKNOWN_RECEIPT_NO_RESEND');
  if(s.SuccessReceiptId&&!item.outcome.receipt_ids.includes(s.SuccessReceiptId))fail('UNLINKED_RECEIPT_NO_RESEND');
  nodes.set(item.id,item);
 }
 const seen=new Set(),pending=[expectedHash];
 while(pending.length){const key=pending.pop();if(seen.has(key)||!nodes.has(key))fail('INCOMPLETE_RECEIPT_TREE_NO_RESEND');seen.add(key);pending.push(...nodes.get(key).outcome.receipt_ids);}
 if(seen.size!==nodes.size)fail('UNRELATED_RECEIPT_NO_RESEND');
 return result;
}

export class EscrowTestnetAdapter{
 #locked=false;
 constructor({rpc=new TestnetRpc({network:NETWORK,url:RPC}),runtime=join(ROOT,'runtime'),loadOwner=loadIdentity,lock=withLock,artifact=reviewedArtifact,registryPin=()=>registryArtifact().code_hash}={}){
  this.rpc=rpc;this.runtime=runtime;this.loadOwner=loadOwner;this.lock=lock;this.artifact=artifact;this.registryPin=registryPin;
 }
 async locked(ownerLockFree,fn){
  if(ownerLockFree!==true)fail('WAIT_FOR_MAIN_OWNER_LOCK_FREE_SIGNAL');
  return this.lock(async()=>{this.#locked=true;try{return await fn();}finally{this.#locked=false;}});
 }
 async pinRegistry(owner){
  if(owner.account_id!==OWNER)fail('DEDICATED_OWNER_REQUIRED');
  await this.rpc.connect();const state=await this.rpc.account(OWNER);
  if(state?.code_hash!==this.registryPin())fail('EXISTING_REGISTRY_CODE_PIN_MISMATCH');
  if((await this.rpc.view(OWNER,'owner',{})).value!==OWNER||!equal((await this.rpc.view(OWNER,'network_domain_hash',{})).value,domainHash()))fail('EXISTING_REGISTRY_POLICY_MISMATCH');
  return state;
 }
 async plan(){
  const owner=this.loadOwner(),ownerAccount=await this.pinRegistry(owner),artifact=this.artifact();
  const config=await this.rpc.request('EXPERIMENTAL_protocol_config',{finality:'final'});
  const child=await this.rpc.account(ESCROW),balance=child?BigInt(child.amount):CREATE_ALLOCATION;
  if(child&&![EMPTY,artifact.code_hash].includes(child.code_hash))fail('REFUSE_OVERWRITE_FOREIGN_ESCROW_CODE');
  const price=config.runtime_config?.storage_amount_per_byte;
  if(typeof ownerAccount.amount!=='string'||!/^\d+$/.test(ownerAccount.amount)||!Number.isSafeInteger(ownerAccount.storage_usage)||ownerAccount.storage_usage<0||typeof price!=='string'||!/^\d+$/.test(price))fail('OWNER_SPENDABLE_BALANCE_UNVERIFIED');
  const retained=BigInt(ownerAccount.amount)-BigInt(ownerAccount.storage_usage)*BigInt(price)-(child?0n:CREATE_ALLOCATION)-GAS_RESERVE;
  return{network:NETWORK,rpc:RPC,registry_id:OWNER,escrow_id:ESCROW,escrow_code_hash:artifact.code_hash,
   wasm_sha256:artifact.sha256,wasm_size:artifact.size_bytes,already_deployed:child?.code_hash===artifact.code_hash,
   storage:storagePreflight(artifact.size_bytes,price,balance),
   owner_spendable_retained_yocto:String(retained),owner_minimum_retained_yocto:String(OWNER_MIN_RETAIN),owner_reserve_sufficient:retained>=OWNER_MIN_RETAIN,
   mutation_performed:false,owner_lock_required:true};
 }
 childIdentity(){
  secureDirectory(this.runtime);const path=join(this.runtime,'escrow-identity.json');
  if(!existsSync(path)){const key=KeyPair.fromRandom('ed25519');privateWrite(path,{network:NETWORK,account_id:ESCROW,public_key:key.getPublicKey().toString(),private_key:key.toString()});}
  const id=privateRead(path);
  if(id.network!==NETWORK||id.account_id!==ESCROW||KeyPair.fromString(id.private_key).getPublicKey().toString()!==id.public_key)fail('ESCROW_KEY_MISMATCH');
  return id;
 }
 async sendOnce(owner,id,receiver,label,list,artifact,childPublicKey){
  if(!this.#locked)fail('EXCLUSIVE_OWNER_LOCK_REQUIRED');
  validateActions({id,receiver,label,list,artifact,childPublicKey});await this.pinRegistry(owner);
  secureDirectory(this.runtime);
  const file=join(this.runtime,`${label}.json`);
  const requestHash=hash(createTransaction(id.account_id,PublicKey.fromString(id.public_key),receiver,0n,list,new Uint8Array(32)).encode()).toString('hex');
  if(existsSync(file)){
   const old=privateRead(file);if(old.request_hash!==requestHash||old.sender!==id.account_id||old.receiver!==receiver)fail('PAYMENT_JOURNAL_BINDING_MISMATCH');
   // Never re-sign/re-broadcast. The same signed hash is queried after any ambiguity.
   return finalTransaction(await this.rpc.request('tx',{tx_hash:old.tx_hash,sender_account_id:id.account_id,wait_until:'FINAL'}),old.tx_hash,id.account_id,receiver);
  }
  const access=await this.rpc.access(id);if(!Number.isSafeInteger(access.nonce)||access.nonce<0)fail('UNSAFE_NONCE');
  const tx=createTransaction(id.account_id,PublicKey.fromString(id.public_key),receiver,BigInt(access.nonce)+1n,list,baseDecode(access.block_hash));
  const signed=await KeyPairSigner.fromSecretKey(id.private_key).signTransaction(tx),txHash=baseEncode(signed.txHash);
  privateWrite(file,{network:NETWORK,sender:id.account_id,receiver,label,tx_hash:txHash,request_hash:requestHash});
  // Journal contains no private key and is fsynced before the first broadcast.
  return finalTransaction(await this.rpc.request('send_tx',{signed_tx_base64:Buffer.from(signed.signedTransaction.encode()).toString('base64'),wait_until:'FINAL'}),txHash,id.account_id,receiver);
 }
 async deploy({ownerLockFree=false}={}){
  return this.locked(ownerLockFree,async()=>{
   const plan=await this.plan();
   // Stop BEFORE account/key creation if the authorized allocation cannot deploy.
   if(!plan.storage.sufficient)fail('ESCROW_STORAGE_EXCEEDS_AUTHORIZED_3_TEST_NEAR');
   if(!plan.owner_reserve_sufficient)fail('OWNER_MUST_RETAIN_ONE_TEST_NEAR_AFTER_STORAGE_AND_GAS');
   const owner=this.loadOwner(),child=this.childIdentity(),artifact=this.artifact();
   let account=await this.rpc.account(ESCROW),create=null,deploy=null;
   if(!account||existsSync(join(this.runtime,'create-escrow.json'))){create=await this.sendOnce(owner,owner,ESCROW,'create-escrow',[actions.createAccount(),actions.transfer(CREATE_ALLOCATION),actions.addFullAccessKey(PublicKey.fromString(child.public_key))],artifact,child.public_key);account=await this.rpc.account(ESCROW);}
   await this.rpc.access(child);
   if(account.code_hash!==artifact.code_hash||existsSync(join(this.runtime,'deploy-escrow.json'))){
    if(![EMPTY,artifact.code_hash].includes(account.code_hash))fail('REFUSE_OVERWRITE_FOREIGN_ESCROW_CODE');
    deploy=await this.sendOnce(owner,child,ESCROW,'deploy-escrow',[actions.deployContract(artifact.bytes),actions.functionCall('new',{registry:OWNER},50000000000000n,0n)],artifact);
   }
   if((await this.rpc.account(ESCROW))?.code_hash!==artifact.code_hash||(await this.rpc.view(ESCROW,'registry',{})).value!==OWNER||(await this.rpc.view(ESCROW,'storage_topup',{})).value!==String(STORAGE_TOPUP))fail('ESCROW_DEPLOYMENT_POSTCHECK_FAILED');
   return{...plan,mutation_performed:Boolean(create||deploy),create_hash:create?.transaction.hash??null,deploy_hash:deploy?.transaction.hash??null};
  });
 }
 async fundAndRelease(jobId,{ownerLockFree=false,amount=MAX_PRICE}={}){
  if(!u64(jobId)||typeof amount!=='bigint'||amount<1n||amount>MAX_PRICE)fail('BOUNDED_TESTNET_PRICE_REQUIRED');
  return this.locked(ownerLockFree,async()=>{
   const owner=this.loadOwner();await this.pinRegistry(owner);const artifact=this.artifact();
   if((await this.rpc.account(ESCROW))?.code_hash!==artifact.code_hash||(await this.rpc.view(ESCROW,'registry',{})).value!==OWNER)fail('DEPLOYED_ESCROW_REQUIRED');
   const job=(await this.rpc.view(OWNER,'get_job',{job_id:jobId})).value,receipt=job?.receipts?.at(-1);
   const provider=job?.attempt_binding_version===2?job.selected_executor:job?.attempt_binding_version===1?job.config?.executor:null;
   if(job?.state!=='Accepted'||job.buyer!==OWNER||receipt?.status!=='BuyerAccepted'||![1,2,3].some(n=>provider===`p${n}.${OWNER}`))fail('ACCEPTED_EXACT_INTEGRATION_JOB_REQUIRED');
   const terms={job_id:jobId,buyer:OWNER,provider,amount:String(amount),context_hash:job.config.context_hash,job_binding_hash:job.job_binding_hash};
   const acceptance={attempt:job.attempt,attempt_binding_hash:job.attempt_binding_hash,receipt_hash:receipt.receipt_hash,output_hash:receipt.claim?.output_hash};
   const fundActions=[actions.functionCall('fund',{terms},150000000000000n,amount+STORAGE_TOPUP)];
   let hold=(await this.rpc.view(ESCROW,'get_hold',{job_id:jobId})).value,fund=null;
   if(!hold||existsSync(join(this.runtime,`fund-${jobId}.json`))){fund=await this.sendOnce(owner,owner,ESCROW,`fund-${jobId}`,fundActions,artifact);hold=(await this.rpc.view(ESCROW,'get_hold',{job_id:jobId})).value;}
   if(!equal(hold?.terms,terms)){
    // JSON map ordering is not financial identity; compare each exact term below.
    if(!hold||Object.keys(terms).some(k=>!equal(hold.terms?.[k],terms[k])))fail('EXACT_FUNDED_TERMS_REQUIRED');
   }
   if(!['Held','Paid','PayoutPending','Verifying'].includes(hold.state))fail('ESCROW_HOLD_STATE_NOT_RELEASABLE');
   // A retained journal is always reconciled, even if the hold already says Paid.
   // With no journal, only Held authorizes the first release attempt.
   if(hold.state!=='Held'&&!existsSync(join(this.runtime,`release-${jobId}.json`)))fail('PAYMENT_UNKNOWN_NO_NEW_RELEASE');
   const release=await this.sendOnce(owner,owner,ESCROW,`release-${jobId}`,[actions.functionCall('release',{job_id:jobId,acceptance},150000000000000n,0n)],artifact);
   if(release.status.SuccessValue!==Buffer.from('true').toString('base64'))fail('ESCROW_RELEASE_NOT_CONFIRMED_NO_RESEND');
   hold=(await this.rpc.view(ESCROW,'get_hold',{job_id:jobId})).value;
   if(hold?.state!=='Paid'||Object.keys(acceptance).some(k=>!equal(hold.acceptance?.[k],acceptance[k])))fail('EXACT_PAID_STATE_REQUIRED');
   const result={network:NETWORK,escrow_id:ESCROW,registry_id:OWNER,escrow_code_hash:artifact.code_hash,registry_code_hash:this.registryPin(),
    job_id:jobId,buyer_id:OWNER,provider_id:provider,amount_yocto:String(amount),fund_hash:fund?.transaction.hash??null,release_hash:release.transaction.hash,
    context_hash:Buffer.from(terms.context_hash).toString('hex'),job_binding_hash:Buffer.from(terms.job_binding_hash).toString('hex'),
    attempt:acceptance.attempt,attempt_binding_hash:Buffer.from(acceptance.attempt_binding_hash).toString('hex'),receipt_hash:Buffer.from(acceptance.receipt_hash).toString('hex'),output_hash:Buffer.from(acceptance.output_hash).toString('hex'),
    finality:'FINAL',state:'Paid',observer_verification_required:true,market_settlement:false,
    fixed_demonstration_price:true,mpc_winning_price_proven:false,payout_amount_public:true};
   // Public, deliberately secret-free handoff to the independent Python observer.
   writeFileSync(join(ROOT,'verification/testnet-payout.json'),JSON.stringify(result,null,2)+'\n');
   return result;
  });
 }
}

if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){
 try{
  const [command,...args]=process.argv.slice(2),adapter=new EscrowTestnetAdapter();let result;
  if(command==='plan'&&!args.length)result=await adapter.plan();
  else if(command==='deploy'&&equal(args,['--owner-lock-free']))result=await adapter.deploy({ownerLockFree:true});
  else if(command==='pay'&&args.length===2&&u64(args[0])&&args[1]==='--owner-lock-free')result=await adapter.fundAndRelease(args[0],{ownerLockFree:true});
  else fail('EXPLICIT_ESCROW_COMMAND_AND_OWNER_SIGNAL_REQUIRED');
  console.log(JSON.stringify(result,null,2));
 }catch(e){console.error(JSON.stringify({network:NETWORK,error:/^[A-Z][A-Z0-9_]+$/.test(e.message)?e.message:'ESCROW_TESTNET_OPERATION_FAILED_OR_UNKNOWN',retry:false}));process.exitCode=1;}
}
