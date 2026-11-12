// Dedicated, bounded synthetic TESTNET participant provisioning and registry calls.
// Keys never leave ignored local runtime. These accounts share one administrator.
import {actions,KeyPair,KeyPairSigner,PublicKey,createTransaction,baseEncode,baseDecode} from 'near-api-js';
import {mkdirSync,lstatSync,readFileSync,writeFileSync,openSync,closeSync,constants,fsyncSync,existsSync} from 'node:fs';
import {join} from 'node:path';
import {NETWORK,RPC,sha256} from './policy.mjs';
import {PRIVATE,loadIdentity,withLock} from './storage.mjs';
import {TestnetRpc,finalOutcome} from './transport.mjs';
import {inspect} from './registry.mjs';
export const PARTICIPANT_DIR=join(PRIVATE,'procurement-participants');
function directory(){if(!existsSync(PARTICIPANT_DIR))mkdirSync(PARTICIPANT_DIR,{mode:0o700});const s=lstatSync(PARTICIPANT_DIR);if(!s.isDirectory()||s.isSymbolicLink()||(s.mode&0o077))throw new Error('UNSAFE_PARTICIPANT_DIRECTORY');}
function privateWrite(file,data){const fd=openSync(file,constants.O_WRONLY|constants.O_CREAT|constants.O_EXCL|constants.O_NOFOLLOW,0o600);try{writeFileSync(fd,JSON.stringify(data));fsyncSync(fd);}finally{closeSync(fd);}}
function privateRead(file){const st=lstatSync(file);if(!st.isFile()||st.isSymbolicLink()||(st.mode&0o077))throw new Error('UNSAFE_PARTICIPANT_FILE');return JSON.parse(readFileSync(file,'utf8'));}
export function participantIdentities(owner){directory();return [1,2,3].map(n=>{const account_id=`p${n}.${owner.account_id}`,file=join(PARTICIPANT_DIR,`p${n}.json`);if(!existsSync(file)){const key=KeyPair.fromRandom('ed25519');privateWrite(file,{network:NETWORK,account_id,public_key:key.getPublicKey().toString(),private_key:key.toString()});}const id=privateRead(file);if(id.network!==NETWORK||id.account_id!==account_id||KeyPair.fromString(id.private_key).getPublicKey().toString()!==id.public_key)throw new Error('PARTICIPANT_IDENTITY_MISMATCH');return id;});}
export function validateParticipantActions(owner,id,receiver,list,provision=false){
 const children=[1,2,3].map(n=>`p${n}.${owner.account_id}`);
 if(!owner.account_id.endsWith('.testnet')||!id.account_id.endsWith('.testnet'))throw new Error('TESTNET_ONLY');
 if(provision){if(id.account_id!==owner.account_id||!children.includes(receiver)||list.length!==3||list[0].enum!=='createAccount'||list[1].enum!=='transfer'||list[1].transfer.deposit!==100000000000000000000000n||list[2].enum!=='addKey')throw new Error('PROVISION_POLICY_REJECTED');return;}
 if(receiver!==owner.account_id||![owner.account_id,...children].includes(id.account_id)||list.length!==1||list[0].enum!=='functionCall')throw new Error('REGISTRY_CALL_REJECTED');
 const call=list[0].functionCall;if(call.deposit!==0n||call.gas>100000000000000n||!['submit_bid','close_bids','begin_selected_attempt','report_result','decide_result','expire_job'].includes(call.methodName))throw new Error('REGISTRY_CALL_REJECTED');
 if(call.methodName==='submit_bid'&&!children.includes(id.account_id))throw new Error('PROVIDER_ONLY');
 if(['begin_selected_attempt','decide_result'].includes(call.methodName)&&id.account_id!==owner.account_id)throw new Error('BUYER_ONLY');
}
export async function sendParticipantOnce(rpc,owner,id,receiver,label,list,{provision=false}={}){
 directory();if(!/^[a-z0-9-]{1,100}$/.test(label))throw new Error('JOURNAL_LABEL_REJECTED');validateParticipantActions(owner,id,receiver,list,provision);
 await rpc.connect();const state=await inspect(rpc,owner);if(state.account?.code_hash!==state.expectedCode||state.owner!==owner.account_id)throw new Error('REGISTRY_PIN_MISMATCH');
 const file=join(PARTICIPANT_DIR,'tx-'+label+'.json');const digest=sha256(createTransaction(id.account_id,PublicKey.fromString(id.public_key),receiver,0n,list,new Uint8Array(32)).encode()).toString('hex');
 if(existsSync(file)){const saved=privateRead(file);if(saved.digest!==digest||saved.sender!==id.account_id)throw new Error('JOURNAL_PAYLOAD_MISMATCH');return finalOutcome(await rpc.request('tx',{tx_hash:saved.hash,sender_account_id:id.account_id,wait_until:'FINAL'}));}
 const access=await rpc.access(id);if(!Number.isSafeInteger(access.nonce))throw new Error('UNSAFE_NONCE');const tx=createTransaction(id.account_id,PublicKey.fromString(id.public_key),receiver,BigInt(access.nonce)+1n,list,baseDecode(access.block_hash));const signed=await KeyPairSigner.fromSecretKey(id.private_key).signTransaction(tx);privateWrite(file,{digest,sender:id.account_id,hash:baseEncode(signed.txHash)});
 return finalOutcome(await rpc.request('send_tx',{signed_tx_base64:Buffer.from(signed.signedTransaction.encode()).toString('base64'),wait_until:'FINAL'}));
}
export async function provisionParticipants(){return withLock(async()=>{const owner=loadIdentity(),rpc=new TestnetRpc({network:NETWORK,url:RPC}),ids=participantIdentities(owner),out=[];for(const [n,id]of ids.entries()){const before=await rpc.account(id.account_id);let tx=null;if(!before)tx=await sendParticipantOnce(rpc,owner,owner,id.account_id,'provision-p'+(n+1),[actions.createAccount(),actions.transfer(100000000000000000000000n),actions.addFullAccessKey(PublicKey.fromString(id.public_key))],{provision:true});await rpc.access(id);out.push({accountId:id.account_id,publicKey:id.public_key,network:NETWORK,transactionHash:tx?.transaction.hash||null,keyFile:join(PARTICIPANT_DIR,`p${n+1}.json`)});}return out;});}
