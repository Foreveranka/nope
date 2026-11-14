/** Offline-only, narrowly scoped NOPE TESTNET provisioner. No parent wallet access. */
import {KeyPair,KeyPairSigner,PublicKey,actions,createTransaction,baseDecode,baseEncode} from 'near-api-js';
import fs from 'node:fs';import path from 'node:path';import {fileURLToPath} from 'node:url';import {createHash} from 'node:crypto';
import {TestnetRpc,finalOutcome} from '../contracts/registry/deploy/transport.mjs';
export const CONTRACT='nope-work-da4cbb1e.testnet';
export const METHODS=['fund','record_delivery','accept_and_release','refund'];
export const FAUCET='https://helper.nearprotocol.com/account'; // official near-cli-rs testnet faucet
const RPC='https://test.rpc.fastnear.com',NETWORK='testnet';
const ALLOWANCE=2n*10n**23n,MIN_BALANCE=4n*10n**24n;
const ROOT=fileURLToPath(new URL('../',import.meta.url)),DIR=path.join(ROOT,'runtime/workspace-escrow');
const sha=b=>createHash('sha256').update(b).digest();
function secureDir(){if(!fs.existsSync(DIR))fs.mkdirSync(DIR,{mode:0o700});const s=fs.lstatSync(DIR);if(!s.isDirectory()||s.isSymbolicLink()||(s.mode&0o077))throw Error('UNSAFE_ESCROW_DIRECTORY');}
function readPrivate(name){const p=path.join(DIR,name),s=fs.lstatSync(p);if(!s.isFile()||s.isSymbolicLink()||(s.mode&0o777)!==0o600)throw Error('UNSAFE_ESCROW_FILE');return JSON.parse(fs.readFileSync(p,'utf8'));}
function writePrivate(name,value){secureDir();const p=path.join(DIR,name),fd=fs.openSync(p,fs.constants.O_WRONLY|fs.constants.O_CREAT|fs.constants.O_EXCL|fs.constants.O_NOFOLLOW,0o600);try{fs.writeFileSync(fd,JSON.stringify(value,null,2)+'\n');fs.fsyncSync(fd);}finally{fs.closeSync(fd);}const d=fs.openSync(DIR,fs.constants.O_RDONLY);try{fs.fsyncSync(d);}finally{fs.closeSync(d);}}
function identity(name,purpose){secureDir();if(!fs.existsSync(path.join(DIR,name))){const k=KeyPair.fromRandom('ed25519');writePrivate(name,{network:NETWORK,account_id:CONTRACT,purpose,public_key:k.getPublicKey().toString(),private_key:k.toString()});}const id=readPrivate(name);if(id.network!==NETWORK||id.account_id!==CONTRACT||id.purpose!==purpose||KeyPair.fromString(id.private_key).getPublicKey().toString()!==id.public_key)throw Error('ESCROW_IDENTITY_MISMATCH');return id;}
async function locked(fn){secureDir();const p=path.join(DIR,'offline-operation.lock'),fd=fs.openSync(p,fs.constants.O_WRONLY|fs.constants.O_CREAT|fs.constants.O_EXCL|fs.constants.O_NOFOLLOW,0o600);fs.writeFileSync(fd,String(process.pid));fs.closeSync(fd);try{return await fn();}finally{fs.unlinkSync(p);}}
export function reviewedBuild(){
 const review=JSON.parse(fs.readFileSync(path.join(ROOT,'docs/workspace-escrow/build-reviewed.json'),'utf8'));
 if(review.network!==NETWORK||typeof review.artifactPath!=='string'||!review.artifactPath.startsWith('payments/')||review.artifactPath.split('/').includes('..'))throw Error('INVALID_BUILD_REVIEW');
 for(const [name,hash]of Object.entries(review.sources)){if(!name.startsWith('payments/workspace_escrow/')||name.split('/').includes('..')||sha(fs.readFileSync(path.join(ROOT,name))).toString('hex')!==hash)throw Error('ESCROW_SOURCE_CHANGED');}
 const wasm=fs.readFileSync(path.join(ROOT,review.artifactPath));if(sha(wasm).toString('hex')!==review.wasmSha256||wasm.length!==review.bytes)throw Error('ESCROW_BUILD_CHANGED');return {...review,wasm,codeHash:baseEncode(sha(wasm))};
}
export function faucetRequest(publicKey){
 if(typeof publicKey!=='string'||!publicKey.startsWith('ed25519:')||PublicKey.fromString(publicKey).toString()!==publicKey)throw Error('INVALID_FAUCET_PUBLIC_KEY');
 return{newAccountId:CONTRACT,newAccountPublicKey:publicKey};
}
export function validateProvisioning({label,id,receiver,list,build,onlinePublicKey}){
 if(label!=='deploy-workspace-escrow'||id.account_id!==CONTRACT||receiver!==CONTRACT||list.length!==3||list[0].enum!=='deployContract'||!Buffer.from(list[0].deployContract.code).equals(build.wasm))throw Error('DEPLOY_POLICY_REJECTED');
 const c=list[1].functionCall,k=list[2].addKey,p=k?.accessKey.permission;
 if(list[1].enum!=='functionCall'||c.methodName!=='new'||Buffer.from(c.args).toString()!=='{}'||c.deposit!==0n||c.gas!==50_000_000_000_000n||list[2].enum!=='addKey'||k.publicKey.toString()!==onlinePublicKey||p?.enum!=='functionCall'||p.functionCall.receiverId!==CONTRACT||JSON.stringify(p.functionCall.methodNames)!==JSON.stringify(METHODS)||p.functionCall.allowance!==ALLOWANCE)throw Error('ONLINE_SCOPE_POLICY_REJECTED');
}
async function account(rpc){try{return await rpc.query({request_type:'view_account',account_id:CONTRACT});}catch(e){if(e.detail?.cause?.name==='UNKNOWN_ACCOUNT')return null;throw e;}}
export async function requestFaucet(){return locked(async()=>{
 const rpc=new TestnetRpc({network:NETWORK,url:RPC}),id=identity('offline-deployment-key.json','nope-workspace-testnet-offline-deployment');await rpc.connect();
 if(await account(rpc)){await rpc.access(id);return{network:NETWORK,contractId:CONTRACT,accountConfirmed:true,faucetRequestSent:false};}
 if(fs.existsSync(path.join(DIR,'faucet-attempt.json')))throw Error('FAUCET_ALREADY_ATTEMPTED_RECONCILE_ONLY');
 const body=faucetRequest(id.public_key);writePrivate('faucet-attempt.json',{network:NETWORK,endpoint:FAUCET,body,at:new Date().toISOString()});
 let r;try{r=await fetch(FAUCET,{method:'POST',redirect:'error',signal:AbortSignal.timeout(25000),headers:{'content-type':'application/json'},body:JSON.stringify(body)});}catch{throw Error('FAUCET_TRANSPORT_UNKNOWN_NO_RETRY');}
 const text=await r.text();writePrivate('faucet-response.json',{status:r.status,body:text});if(!r.ok)throw Error('FAUCET_HTTP_'+r.status+'_NO_RETRY');
 let a;for(let i=0;i<10;i++){a=await account(rpc);if(a)break;await new Promise(resolve=>setTimeout(resolve,1000));}
 if(!a)throw Error('FAUCET_NOT_FINAL_YET_RECONCILE_ONLY');await rpc.access(id);
 const out={network:NETWORK,contractId:CONTRACT,publicKey:id.public_key,endpoint:FAUCET,httpStatus:r.status,accountConfirmed:true,confirmedBlockHash:a.block_hash,faucetRequestSent:true,noParentWalletAccess:true};fs.writeFileSync(path.join(ROOT,'docs/workspace-escrow/faucet-public.json'),JSON.stringify(out,null,2)+'\n');return out;
});}
async function preflight(rpc,build){
 await rpc.connect();const a=await account(rpc);
 if(a&&!['11111111111111111111111111111111',build.codeHash].includes(a.code_hash))throw Error('REFUSE_FOREIGN_CODE_OVERWRITE');
 const config=await rpc.request('EXPERIMENTAL_protocol_config',{finality:'final'}),price=BigInt(config.runtime_config.storage_amount_per_byte);
 const gasPrice=BigInt((await rpc.request('gas_price',[null])).gas_price),gasBudget=155_000_000_000_000n*gasPrice;
 if(gasBudget>=ALLOWANCE)throw Error('LIVE_GAS_EXCEEDS_LIMITED_ALLOWANCE');
 const minimum=(BigInt(build.bytes)+65536n+1024n)*price+15n*10n**22n+ALLOWANCE;
 if(a&&(BigInt(a.amount)<MIN_BALANCE||BigInt(a.amount)<minimum))throw Error('FAUCET_BALANCE_INSUFFICIENT_FOR_VERIFIED_PROFILE');
 return{a,minimum,gasPrice,gasBudget};
}
async function sendOnce(rpc,id,list,build,onlinePublicKey){
 validateProvisioning({label:'deploy-workspace-escrow',id,receiver:CONTRACT,list,build,onlinePublicKey});await preflight(rpc,build);
 const requestHash=sha(createTransaction(id.account_id,PublicKey.fromString(id.public_key),CONTRACT,0n,list,new Uint8Array(32)).encode()).toString('hex'),name='deploy-workspace-escrow.json';
 if(fs.existsSync(path.join(DIR,name))){const j=readPrivate(name);if(j.sender!==CONTRACT||j.requestHash!==requestHash)throw Error('PROVISIONING_JOURNAL_MISMATCH');return finalOutcome(await rpc.request('EXPERIMENTAL_tx_status',{tx_hash:j.transactionHash,sender_account_id:CONTRACT,wait_until:'FINAL'}));}
 const access=await rpc.access(id);if(!Number.isSafeInteger(access.nonce)||access.nonce<0)throw Error('UNSAFE_NONCE');
 const tx=createTransaction(CONTRACT,PublicKey.fromString(id.public_key),CONTRACT,BigInt(access.nonce)+1n,list,baseDecode(access.block_hash));const signed=await KeyPairSigner.fromSecretKey(id.private_key).signTransaction(tx),hash=baseEncode(signed.txHash);
 writePrivate(name,{network:NETWORK,sender:CONTRACT,requestHash,transactionHash:hash,signedTransaction:Buffer.from(signed.signedTransaction.encode()).toString('base64'),preparedAt:new Date().toISOString()});
 return finalOutcome(await rpc.request('send_tx',{signed_tx_base64:Buffer.from(signed.signedTransaction.encode()).toString('base64'),wait_until:'FINAL'}));
}
export async function provision({deploy=false}={}){return locked(async()=>{
 const rpc=new TestnetRpc({network:NETWORK,url:RPC}),build=reviewedBuild(),pre=await preflight(rpc,build),old=pre.a;
 const result={network:NETWORK,contractId:CONTRACT,codeHash:build.codeHash,wasmSha256:build.wasmSha256,bytes:build.bytes,minimumAccountBalanceYocto:MIN_BALANCE.toString(),minimumRequiredYocto:pre.minimum.toString(),liveGasPriceYocto:pre.gasPrice.toString(),conservativeCallGasBudgetYocto:pre.gasBudget.toString(),onlineInitialGasAllowanceYocto:ALLOWANCE.toString(),alreadyDeployed:old?.code_hash===build.codeHash,accountMissing:!old,mutationPerformed:false,noParentWalletAccess:true};
 if(!deploy)return result;if(!old)throw Error('FREE_FAUCET_ACCOUNT_REQUIRED');
 const offline=identity('offline-deployment-key.json','nope-workspace-testnet-offline-deployment'),online=identity('online-function-key.json','nope-workspace-testnet-narrow-function-key');
 if(old.code_hash!==build.codeHash)await sendOnce(rpc,offline,[actions.deployContract(build.wasm),actions.functionCall('new',{},50_000_000_000_000n,0n),actions.addFunctionCallAccessKey(PublicKey.fromString(online.public_key),CONTRACT,METHODS,ALLOWANCE)],build,online.public_key);
 const final=await account(rpc);if(final?.code_hash!==build.codeHash)throw Error('FINAL_DEPLOY_CODE_MISMATCH');
 const config=(await rpc.view(CONTRACT,'get_config',{})).value;
 if(config.domain!=='NOPE:WORKSPACE-ESCROW:V1:testnet'||config.network!=='testnet'||config.contract_id!==CONTRACT||config.total_pool!=='50000000000000000000000'||config.max_hold_amount!=='10000000000000000000000'||config.max_holds!==50)throw Error('FINAL_CONTRACT_CONFIG_MISMATCH');
 const key=await rpc.query({request_type:'view_access_key',account_id:CONTRACT,public_key:online.public_key}),permission=key.permission?.FunctionCall;
 if(permission?.receiver_id!==CONTRACT||JSON.stringify([...permission.method_names].sort())!==JSON.stringify([...METHODS].sort())||BigInt(permission.allowance)>ALLOWANCE)throw Error('FINAL_ONLINE_KEY_SCOPE_MISMATCH');
 const evidence={...result,accountMissing:false,mutationPerformed:true,verifiedAt:new Date().toISOString(),actualExternalChain:true,config,onlinePublicKey:online.public_key,onlinePermission:key.permission,deployTransactionHash:readPrivate('deploy-workspace-escrow.json').transactionHash};
 fs.writeFileSync(path.join(ROOT,'docs/workspace-escrow/deployment-public.json'),JSON.stringify(evidence,null,2)+'\n');return evidence;
});}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){const mode=process.argv[2]||'plan';if(!['plan','faucet','deploy'].includes(mode))throw Error('Explicit plan, faucet or deploy required');console.log(JSON.stringify(await(mode==='faucet'?requestFaucet():provision({deploy:mode==='deploy'})),null,2));}
