/** Own NEW free-testnet accounts only. Private material stays in ignored runtime. */
import fs from 'node:fs';import path from 'node:path';import {fileURLToPath} from 'node:url';import {createHash,generateKeyPairSync,createPrivateKey,createPublicKey} from 'node:crypto';
import {KeyPair,KeyPairSigner,PublicKey,actions,createTransaction,baseDecode,baseEncode} from 'near-api-js';
import {TestnetRpc,finalOutcome} from '../../contracts/registry/deploy/transport.mjs';
export const ROOT=path.dirname(fileURLToPath(import.meta.url));
export const DIR=path.join(ROOT,'runtime/storage-v2');export const PUBLIC=path.join(ROOT,'verification/storage-v2');
export const DOMAIN='NOPE:WALLET-ESCROW:V2:testnet';
const FAUCET='https://helper.nearprotocol.com/account';
export const sha=b=>createHash('sha256').update(b).digest();
export const rpc=new TestnetRpc({network:'testnet',url:'https://test.rpc.fastnear.com'});
function secure(){fs.mkdirSync(DIR,{recursive:true,mode:0o700});const s=fs.lstatSync(DIR);if(!s.isDirectory()||s.isSymbolicLink()||(s.mode&0o077))throw Error('UNSAFE_PRIVATE_DIRECTORY');fs.mkdirSync(PUBLIC,{recursive:true});}
export function privateWrite(name,data){secure();const p=path.join(DIR,name),fd=fs.openSync(p,fs.constants.O_WRONLY|fs.constants.O_CREAT|fs.constants.O_EXCL|fs.constants.O_NOFOLLOW,0o600);try{fs.writeFileSync(fd,JSON.stringify(data,null,2)+'\n');fs.fsyncSync(fd);}finally{fs.closeSync(fd);}}
export function privateRead(name){secure();const p=path.join(DIR,name),s=fs.lstatSync(p);if(!s.isFile()||s.isSymbolicLink()||(s.mode&0o777)!==0o600)throw Error('UNSAFE_PRIVATE_FILE');return JSON.parse(fs.readFileSync(p,'utf8'));}
export const publicWrite=(name,data)=>{fs.mkdirSync(PUBLIC,{recursive:true});fs.writeFileSync(path.join(PUBLIC,name),JSON.stringify(data,null,2)+'\n');};
export function admissionKey(){
 // Reuse the already-configured admission credential; never log or export it.
 const source=path.join(ROOT,'runtime/admission-v1/admission-key.json'),st=fs.lstatSync(source);
 if(!st.isFile()||st.isSymbolicLink()||(st.mode&0o777)!==0o600)throw Error('UNSAFE_ADMISSION_KEY_FILE');
 const value=JSON.parse(fs.readFileSync(source,'utf8')),key=createPrivateKey({key:Buffer.from(value.privateKeyBase64,'base64'),format:'der',type:'pkcs8'});
 if(key.asymmetricKeyType!=='ed25519'||createPublicKey(key).export({format:'der',type:'spki'}).subarray(-32).toString('hex')!==value.publicKey)throw Error('ADMISSION_KEY_MISMATCH');
 return value;
}

export function identities(){
 secure();if(!fs.existsSync(path.join(DIR,'identities.json'))){
  const contractKey=KeyPair.fromRandom('ed25519'),suffix=sha(contractKey.getPublicKey().toString()).toString('hex').slice(0,8),out={network:'testnet'};
  for(const role of ['contract','buyer','provider']){const k=role==='contract'?contractKey:KeyPair.fromRandom('ed25519');out[role]={network:'testnet',account_id:`nope-${role==='contract'?'wallet':role}-${suffix}.testnet`,public_key:k.getPublicKey().toString(),private_key:k.toString()};}
  privateWrite('identities.json',out);
 }
 const ids=privateRead('identities.json');if(ids.network!=='testnet')throw Error('TESTNET_ONLY');
 for(const role of ['contract','buyer','provider']){const id=ids[role];if(id.network!=='testnet'||!new RegExp(`^nope-${role==='contract'?'wallet':role}-[0-9a-f]{8}\\.testnet$`).test(id.account_id)||KeyPair.fromString(id.private_key).getPublicKey().toString()!==id.public_key)throw Error('PRIVATE_IDENTITY_MISMATCH');}
 publicWrite('accounts-public.json',{network:'testnet',createdAt:new Date().toISOString(),testOnly:true,prizeWallet:false,accounts:Object.fromEntries(['contract','buyer','provider'].map(role=>[role,{accountId:ids[role].account_id,publicKey:ids[role].public_key,network:'testnet',localKeyFile:path.join(DIR,'identities.json'),localKeyField:role+'.private_key',verifiedDate:new Date().toISOString().slice(0,10),purpose:role==='contract'?'new wallet escrow bootstrap; require FINAL deployment-public.json key-removal evidence before deposits':'synthetic customer-wallet escrow test '+role}]))});
 return ids;
}
export async function faucet(role){
 if(!['contract','buyer','provider'].includes(role))throw Error('INVALID_ROLE');const id=identities()[role];await rpc.connect();let a=await rpc.account(id.account_id);
 if(!a){
  const journal=`faucet-${role}.json`;if(fs.existsSync(path.join(DIR,journal)))throw Error('FAUCET_ALREADY_ATTEMPTED_RECONCILE_ONLY');
  privateWrite(journal,{at:new Date().toISOString(),network:'testnet',endpoint:FAUCET,body:{newAccountId:id.account_id,newAccountPublicKey:id.public_key}});
  const response=await fetch(FAUCET,{method:'POST',redirect:'error',signal:AbortSignal.timeout(25000),headers:{'content-type':'application/json'},body:JSON.stringify({newAccountId:id.account_id,newAccountPublicKey:id.public_key})});
  privateWrite(`faucet-${role}-response.json`,{status:response.status,body:await response.text()});if(!response.ok)throw Error('FAUCET_HTTP_'+response.status+'_NO_RETRY');
  for(let i=0;i<10;i++){a=await rpc.account(id.account_id);if(a)break;await new Promise(r=>setTimeout(r,1000));}
 }
 if(!a)throw Error('ACCOUNT_NOT_FINAL_YET');await rpc.access(id);
 const result={network:'testnet',role,accountId:id.account_id,publicKey:id.public_key,balanceYocto:a.amount,codeHash:a.code_hash,blockHash:a.block_hash,blockHeight:a.block_height,verifiedAt:new Date().toISOString(),actualExternalChain:true};publicWrite(`faucet-${role}-public.json`,result);return result;
}
export async function sendOnce(id,label,receiver,list){
 const ids=identities();if(!['contract','buyer','provider'].some(role=>ids[role].account_id===id.account_id)||receiver!==ids.contract.account_id)throw Error('NEW_ESCROW_ONLY');
 if(!/^[a-z0-9-]+$/.test(label))throw Error('INVALID_LABEL');
 const name=`tx-${label}.json`,requestHash=sha(createTransaction(id.account_id,PublicKey.fromString(id.public_key),receiver,0n,list,new Uint8Array(32)).encode()).toString('hex');
 if(fs.existsSync(path.join(DIR,name))){const old=privateRead(name);if(old.requestHash!==requestHash||old.sender!==id.account_id||old.receiver!==receiver)throw Error('JOURNAL_MISMATCH');return finalOutcome(await rpc.request('EXPERIMENTAL_tx_status',{tx_hash:old.transactionHash,sender_account_id:id.account_id,wait_until:'FINAL'}));}
 await rpc.connect();const access=await rpc.access(id);if(!Number.isSafeInteger(access.nonce))throw Error('UNSAFE_NONCE');
 const tx=createTransaction(id.account_id,PublicKey.fromString(id.public_key),receiver,BigInt(access.nonce)+1n,list,baseDecode(access.block_hash));const signed=await KeyPairSigner.fromSecretKey(id.private_key).signTransaction(tx);
 privateWrite(name,{network:'testnet',sender:id.account_id,receiver,requestHash,transactionHash:baseEncode(signed.txHash),signedTransaction:Buffer.from(signed.signedTransaction.encode()).toString('base64'),preparedAt:new Date().toISOString()});
 return finalOutcome(await rpc.request('send_tx',{signed_tx_base64:Buffer.from(signed.signedTransaction.encode()).toString('base64'),wait_until:'FINAL'}));
}
export function build(){
 const wasm=fs.readFileSync(path.join(ROOT,'../testnet_escrow/target/wasm32-unknown-unknown/release/nope_wallet_escrow.wasm'));
 const exports=WebAssembly.Module.exports(new WebAssembly.Module(wasm)).map(x=>x.name);
 if(!['new','fund','get_hold','get_config','record_delivery','accept_and_release','refund','on_transfer'].every(n=>exports.includes(n)))throw Error('MISSING_WASM_EXPORT');
 const sourceNames=['Cargo.toml','Cargo.lock','src/lib.rs'];const report={network:'testnet',domain:DOMAIN,bytes:wasm.length,wasmSha256:sha(wasm).toString('hex'),codeHash:baseEncode(sha(wasm)),exports,sources:Object.fromEntries(sourceNames.map(n=>[n,sha(fs.readFileSync(path.join(ROOT,n))).toString('hex')]))};
 fs.mkdirSync(PUBLIC,{recursive:true});fs.writeFileSync(path.join(PUBLIC,'nope_wallet_escrow.wasm'),wasm);publicWrite('build-public.json',report);return{...report,wasm};
}
export async function deployAndLock(){
 const ids=identities(),id=ids.contract,review=JSON.parse(fs.readFileSync(path.join(PUBLIC,'build-public.json'),'utf8'));
 const wasm=fs.readFileSync(path.join(PUBLIC,'nope_wallet_escrow.wasm'));
 if(sha(wasm).toString('hex')!==review.wasmSha256||wasm.length!==review.bytes||baseEncode(sha(wasm))!==review.codeHash)throw Error('REVIEWED_WASM_CHANGED');
 for(const[n,h]of Object.entries(review.sources))if(sha(fs.readFileSync(path.join(ROOT,n))).toString('hex')!==h)throw Error('REVIEWED_CONTRACT_SOURCE_CHANGED');
 const b={...review,wasm};
 const unit=fs.readFileSync(path.join(ROOT,'verification/storage-v2-unit-tests.log'),'utf8'),sandbox=fs.readFileSync(path.join(ROOT,'verification/storage-v2-sandbox-tests.log'),'utf8');
 if(!/test result: ok\. 18 passed; 0 failed/.test(unit)||!sandbox.includes('LOCAL_SANDBOX actual keyless Wasm')||!/test result: ok\. 1 passed; 0 failed/.test(sandbox))throw Error('UNIT_AND_ACTUAL_SANDBOX_REQUIRED');
 await rpc.connect();const before=await rpc.account(id.account_id);if(!before)throw Error('NEW_FREE_ACCOUNT_REQUIRED');
 if(!['11111111111111111111111111111111',b.codeHash].includes(before.code_hash))throw Error('REFUSE_OTHER_CODE_OVERWRITE');
 const config=await rpc.request('EXPERIMENTAL_protocol_config',{finality:'final'}),storage=BigInt(config.runtime_config.storage_amount_per_byte);
 const minimum=(BigInt(b.bytes)+131072n+8192n)*storage+10n**23n;
 if(BigInt(before.amount)<minimum)throw Error('BOOTSTRAP_STORAGE_GAS_TOO_SMALL');
 let deploy;if(before.code_hash!==b.codeHash)deploy=await sendOnce(id,'deploy',id.account_id,[actions.deployContract(b.wasm),actions.functionCall('new',{admission_public_key:admissionKey().publicKey},50_000_000_000_000n,0n)]);
 const c=(await rpc.view(id.account_id,'get_config',{})).value;if(c.admission_public_key!==admissionKey().publicKey||c.domain!==DOMAIN||c.storage_deposit_yocto!=='40960000000000000000000'||c.hold_count!=='0'||c.storage_deposit_refundable!==false||c.total_deposited!=='0'||c.liabilities!=='0')throw Error('UNFUNDED_INITIALIZER_REQUIRED_BEFORE_LOCK');
 let keys=await rpc.query({request_type:'view_access_key_list',account_id:id.account_id});let lock;
 if(keys.keys.length){if(keys.keys.length>10)throw Error('UNEXPECTED_KEY_COUNT');lock=await sendOnce(id,'remove-all-contract-keys',id.account_id,keys.keys.map(k=>actions.deleteKey(PublicKey.fromString(k.public_key))));}
 const block=await rpc.request('block',{finality:'final'}),blockId=block.header.hash;
 const account=await rpc.request('query',{request_type:'view_account',account_id:id.account_id,block_id:blockId});keys=await rpc.request('query',{request_type:'view_access_key_list',account_id:id.account_id,block_id:blockId});
 const finalView=await rpc.request('query',{request_type:'call_function',account_id:id.account_id,method_name:'get_config',args_base64:'e30=',block_id:blockId});
 const finalConfig=JSON.parse(Buffer.from(finalView.result));
 if(account.block_hash!==blockId||keys.block_hash!==blockId||finalView.block_hash!==blockId||account.code_hash!==b.codeHash||keys.keys.length!==0||finalConfig.total_deposited!=='0')throw Error('FINAL_CODE_KEYLESS_OR_UNFUNDED_MISMATCH');
 const result={storageDepositYocto:finalConfig.storage_deposit_yocto,admissionPublicKey:admissionKey().publicKey,network:'testnet',contractId:id.account_id,codeHash:b.codeHash,domain:DOMAIN,wasmSha256:b.wasmSha256,bytes:b.bytes,requireKeyless:true,keys:keys.keys,finalBlockHash:blockId,finalBlockHeight:block.header.height,initializerConfig:c,deployTransactionHash:deploy?.transaction?.hash??privateRead('tx-deploy.json').transactionHash,lockTransactionHash:lock?.transaction?.hash??(fs.existsSync(path.join(DIR,'tx-remove-all-contract-keys.json'))?privateRead('tx-remove-all-contract-keys.json').transactionHash:null),actualExternalChain:true,customerFundingBeforeLock:false,verifiedAt:new Date().toISOString()};
 publicWrite('deployment-public.json',result);return result;
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
 const mode=process.argv[2];let result;
 try{if(mode==='prepare'){const ids=identities(),b=build();result={contractId:ids.contract.account_id,codeHash:b.codeHash,bytes:b.bytes,domain:DOMAIN,deployed:false,locked:false};}
 else if(mode==='faucet')result=await faucet(process.argv[3]);else if(mode==='deploy-lock')result=await deployAndLock();else throw Error('EXPLICIT_PREPARE_FAUCET_OR_DEPLOY_LOCK_MODE_REQUIRED');console.log(JSON.stringify(result));}
 catch(error){console.error('WALLET_PROVISION_FAILED: '+(error instanceof Error?error.message:'UNKNOWN'));process.exitCode=1;}
}
