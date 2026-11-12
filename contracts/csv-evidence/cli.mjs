#!/usr/bin/env node
// No arbitrary file paths or plaintext manifests accepted. Caller hashes exact raw bytes.
import {createRequire} from 'node:module';
import {pathToFileURL,fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';
import {readFileSync,writeFileSync,mkdirSync,lstatSync,existsSync,openSync,closeSync,fsyncSync,unlinkSync,constants} from 'node:fs';
import {join,dirname} from 'node:path';
import {loadIdentity} from '../registry/deploy/storage.mjs';
import {TestnetRpc} from '../registry/deploy/transport.mjs';
import {finalTransaction} from '../../payments/testnet_escrow/client.mjs';
const require=createRequire(new URL('../registry/deploy/package.json',import.meta.url));
const {actions,KeyPairSigner,PublicKey,createTransaction,baseDecode,baseEncode}=await import(pathToFileURL(require.resolve('near-api-js')).href);
export const ROOT=fileURLToPath(new URL('./',import.meta.url));
export const OWNER='veil-reg-e138f5c88250f821.testnet';
export const CONTRACT=`csv-evidence.${OWNER}`;
export const PROFILE='nope-csv-evidence-v1';
export const RPC='https://test.rpc.fastnear.com';
export const VERIFY_RPC='https://rpc.testnet.near.org';
const REGISTRY_CODE='5WzwjqPvm3nRz6CEkkx73R8dcBtu3YBH6gr6DnoccSEv';
const ALLOCATION=300000000000000000000000n; // maximum 0.3 test NEAR, once
const GAS_RESERVE=50000000000000000000000n;
const OWNER_RESERVE=1000000000000000000000000n;
const RUNTIME=join(ROOT,'runtime');
const sha=b=>createHash('sha256').update(b).digest();
const fail=e=>{throw new Error(e)};
export function metadata(hash,rows,batches){
 if(typeof hash!=='string'||!/^[a-f0-9]{64}$/.test(hash)||!Number.isInteger(rows)||rows<1||rows>32||!Number.isInteger(batches)||batches<1||batches>8||batches!==Math.ceil(rows/4))fail('INVALID_HASH_OR_COUNTS');
 return {manifest_hash:hash,profile:PROFILE,row_count:rows,batch_count:batches};
}
function secureRuntime(){
 if(!existsSync(RUNTIME))mkdirSync(RUNTIME,{mode:0o700});
 const st=lstatSync(RUNTIME);if(!st.isDirectory()||st.isSymbolicLink()||(st.mode&0o077))fail('UNSAFE_RUNTIME');
}
function privateRead(p){const st=lstatSync(p);if(!st.isFile()||st.isSymbolicLink()||(st.mode&0o777)!==0o600)fail('UNSAFE_JOURNAL');return JSON.parse(readFileSync(p,'utf8'));}
function journalWrite(p,v){const fd=openSync(p,constants.O_WRONLY|constants.O_CREAT|constants.O_EXCL|constants.O_NOFOLLOW,0o600);try{writeFileSync(fd,JSON.stringify(v));fsyncSync(fd)}finally{closeSync(fd)}const d=openSync(dirname(p),constants.O_RDONLY);try{fsyncSync(d)}finally{closeSync(d)}}
function publicWrite(name,v){writeFileSync(join(ROOT,'evidence',name+'.json'),JSON.stringify(v,null,2)+'\n');}
async function lock(fn){secureRuntime();const p=join(RUNTIME,'operation.lock');const fd=openSync(p,constants.O_WRONLY|constants.O_CREAT|constants.O_EXCL|constants.O_NOFOLLOW,0o600);closeSync(fd);try{return await fn()}finally{unlinkSync(p)}}
export function artifact(){
 const review=JSON.parse(readFileSync(join(ROOT,'evidence/build.json'),'utf8'));
 const wasm=readFileSync(join(ROOT,'target/wasm32-unknown-unknown/release/csv_evidence.wasm'));
 if(sha(wasm).toString('hex')!==review.wasmSha256||baseEncode(sha(wasm))!==review.codeHash||wasm.length!==review.sizeBytes)fail('UNREVIEWED_WASM');
 for(const [p,h]of Object.entries(review.sourceSha256))if(sha(readFileSync(join(ROOT,p))).toString('hex')!==h)fail('SOURCE_CHANGED_REBUILD_REQUIRED');
 return {...review,wasm};
}
function deployment(){const d=JSON.parse(readFileSync(join(ROOT,'evidence/deployment.json'),'utf8'));if(d.network!=='testnet'||d.contractId!==CONTRACT||d.owner!==OWNER||d.deployed!==true)fail('VERIFIED_DEPLOYMENT_REQUIRED');return d;}
function sameRecord(v,m){return v&&Object.keys(m).every(k=>v[k]===m[k])&&v.owner===OWNER&&typeof v.recorded_at==='string'&&/^\d+$/.test(v.recorded_at);}
async function pinOwner(rpc){await rpc.connect();const a=await rpc.account(OWNER);if(a?.code_hash!==REGISTRY_CODE)fail('EXISTING_REGISTRY_CODE_CHANGED');return a;}
export function validateActions(list,label,bytes,m){
 if(label==='deploy'){
  if(list.length!==4||list[0].enum!=='createAccount'||list[1].enum!=='transfer'||list[1].transfer.deposit!==ALLOCATION||list[2].enum!=='deployContract'||!Buffer.from(list[2].deployContract.code).equals(bytes))fail('DEPLOY_ACTION_POLICY');
  const c=list[3].functionCall;if(list[3].enum!=='functionCall'||c.methodName!=='new'||c.deposit!==0n||c.gas!==30000000000000n||JSON.stringify(JSON.parse(Buffer.from(c.args)))!==JSON.stringify({owner:OWNER}))fail('INIT_ACTION_POLICY');
 }else{
  if(!m||label!==`anchor-${m.manifest_hash}`||list.length!==1||list[0].enum!=='functionCall')fail('ANCHOR_ACTION_POLICY');
  const c=list[0].functionCall;if(c.methodName!=='record_manifest'||c.deposit!==0n||c.gas!==30000000000000n||JSON.stringify(JSON.parse(Buffer.from(c.args)))!==JSON.stringify(m))fail('ANCHOR_ACTION_POLICY');
 }
}
export async function sendOnce(rpc,id,label,list,bytes,m,journalDirectory=RUNTIME){
 if(id.account_id!==OWNER)fail('OWNER_REQUIRED');validateActions(list,label,bytes,m);
 const file=join(journalDirectory,label+'.json');
 const digest=sha(createTransaction(OWNER,PublicKey.fromString(id.public_key),CONTRACT,0n,list,new Uint8Array(32)).encode()).toString('hex');
 if(existsSync(file)){const j=privateRead(file);if(j.requestDigest!==digest||j.sender!==OWNER||j.receiver!==CONTRACT)fail('JOURNAL_MISMATCH');return finalTransaction(await rpc.request('tx',{tx_hash:j.transactionHash,sender_account_id:OWNER,wait_until:'FINAL'}),j.transactionHash,OWNER,CONTRACT);}
 await pinOwner(rpc);
 const a=await rpc.access(id);if(!Number.isSafeInteger(a.nonce)||a.nonce<0)fail('UNSAFE_NONCE');
 const tx=createTransaction(OWNER,PublicKey.fromString(id.public_key),CONTRACT,BigInt(a.nonce)+1n,list,baseDecode(a.block_hash));
 const signed=await KeyPairSigner.fromSecretKey(id.private_key).signTransaction(tx),hash=baseEncode(signed.txHash);
 // Durable, exclusive journal before the sole broadcast. Retry only queries this exact hash.
 journalWrite(file,{transactionHash:hash,requestDigest:digest,sender:OWNER,receiver:CONTRACT,preparedAt:new Date().toISOString()});
 return finalTransaction(await rpc.request('send_tx',{signed_tx_base64:Buffer.from(signed.signedTransaction.encode()).toString('base64'),wait_until:'FINAL'}),hash,OWNER,CONTRACT);
}
export async function plan(rpc=new TestnetRpc({url:RPC})){
 const a=await pinOwner(rpc),build=artifact(),child=await rpc.account(CONTRACT);
 const p=(await rpc.request('EXPERIMENTAL_protocol_config',{finality:'final'})).runtime_config?.storage_amount_per_byte;
 if(typeof p!=='string'||!/^\d+$/.test(p)||BigInt(p)<=0n||!Number.isSafeInteger(a.storage_usage))fail('STORAGE_PRICE_UNVERIFIED');
 const needed=BigInt(build.sizeBytes+2048)*BigInt(p);
 const retained=BigInt(a.amount)-BigInt(a.storage_usage)*BigInt(p)-ALLOCATION-GAS_RESERVE;
 return {network:'testnet',contractId:CONTRACT,owner:OWNER,codeHash:build.codeHash,wasmSha256:build.wasmSha256,sizeBytes:build.sizeBytes,childExists:!!child,childCodeHash:child?.code_hash??null,allocationYocto:String(ALLOCATION),storagePricePerByte:p,requiredWith2048ByteReserveYocto:String(needed),storageSufficient:needed<=ALLOCATION,ownerRetainedSpendableYocto:String(retained),ownerReserveSufficient:retained>=OWNER_RESERVE,mutationPerformed:false};
}
export async function deploy(){return lock(async()=>{
 const rpc=new TestnetRpc({url:RPC}),p=await plan(rpc);publicWrite('preflight',p);
 if(!p.storageSufficient)fail('WASM_EXCEEDS_0_3_TEST_NEAR_STORAGE_CAP');if(!p.ownerReserveSufficient)fail('INSUFFICIENT_OWNER_RESERVE');
 const b=artifact();let tx=null;
 if(p.childExists&&!existsSync(join(RUNTIME,'deploy.json')))fail('REFUSE_EXISTING_ACCOUNT');
 tx=await sendOnce(rpc,loadIdentity(),'deploy',[actions.createAccount(),actions.transfer(ALLOCATION),actions.deployContract(b.wasm),actions.functionCall('new',{owner:OWNER},30000000000000n,0n)],b.wasm);
 const observer=new TestnetRpc({url:VERIFY_RPC});await observer.connect();
 const a=await observer.account(CONTRACT),keys=await observer.query({request_type:'view_access_key_list',account_id:CONTRACT});
 // get_manifest also proves initialization: uninitialized state errors instead of null.
 const view=await observer.view(CONTRACT,'get_manifest',{manifest_hash:'00'.repeat(32)});
 if(a?.code_hash!==b.codeHash||view.value!==null||keys.keys.length!==0)fail('INDEPENDENT_DEPLOYMENT_POSTCHECK_FAILED');
 const result={...p,deployed:true,transactionHash:tx.transaction.hash,codeHash:a.code_hash,rpc:RPC,verificationRpc:VERIFY_RPC,verificationBlockHash:a.block_hash,verificationBlockHeight:a.block_height,accessKeys:0,immutableCode:true,profile:PROFILE,recordedAtUnit:'nanoseconds-string',mutationPerformed:true,verifiedAt:new Date().toISOString(),privacyProof:false,executionProof:false};publicWrite('deployment',result);return result;
 });}
export async function anchor(hash,rows,batches){const m=metadata(hash,rows,batches);return lock(async()=>{
 const d=deployment(),rpc=new TestnetRpc({url:RPC});await pinOwner(rpc);
 if((await rpc.account(CONTRACT))?.code_hash!==d.codeHash)fail('DEPLOYED_CODE_MISMATCH');
 const prior=(await rpc.view(CONTRACT,'get_manifest',{manifest_hash:hash})).value;
 const j=join(RUNTIME,`anchor-${hash}.json`);let txHash=null;
 if(prior){if(!sameRecord(prior,m))fail('MANIFEST_REPLAY_MISMATCH');if(existsSync(j)){const tx=await sendOnce(rpc,loadIdentity(),`anchor-${hash}`,[actions.functionCall('record_manifest',m,30000000000000n,0n)],null,m);txHash=tx.transaction.hash;}}
 else{const tx=await sendOnce(rpc,loadIdentity(),`anchor-${hash}`,[actions.functionCall('record_manifest',m,30000000000000n,0n)],null,m);txHash=tx.transaction.hash;}
 const observer=new TestnetRpc({url:VERIFY_RPC});await observer.connect();const code=await observer.account(CONTRACT);const v=await observer.view(CONTRACT,'get_manifest',{manifest_hash:hash});
 if(code?.code_hash!==d.codeHash||!sameRecord(v.value,m))fail('INDEPENDENT_ANCHOR_VERIFICATION_FAILED');
 const result={network:'testnet',contractId:CONTRACT,manifestSha256:hash,transactionHash:txHash,codeHash:code.code_hash,...v.value,idempotent:!!prior,broadcastPerformed:!prior,verificationRpc:VERIFY_RPC,verificationBlockHash:v.block_hash,verificationBlockHeight:v.block_height,privacyProof:false,executionProof:false};
 publicWrite(`anchor-${hash}`,result);return result;
 });}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){try{
 const [cmd,...a]=process.argv.slice(2);let v;
 if(cmd==='anchor'&&a.length===3&&/^[1-9][0-9]*$/.test(a[1])&&/^[1-9][0-9]*$/.test(a[2]))v=await anchor(a[0],Number(a[1]),Number(a[2]));
 else if(cmd==='plan'&&!a.length)v=await plan();else if(cmd==='deploy'&&!a.length)v=await deploy();else fail('USAGE_ANCHOR_HASH_ROWS_BATCHES_OR_PLAN_OR_DEPLOY');
 console.log(JSON.stringify(v));
 }catch(e){console.error(JSON.stringify({network:'testnet',contractId:CONTRACT,error:/^[A-Z][A-Z0-9_]+$/.test(e.message)?e.message:'OPERATION_FAILED_OR_UNKNOWN_QUERY_JOURNALED_HASH',retryBroadcast:false}));process.exitCode=1;}}
