// Offline SDK/signing tests with ephemeral keys and authored RPC outcomes only.
import test from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {pathToFileURL} from 'node:url';
import {mkdtempSync,readFileSync,readdirSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {EscrowTestnetAdapter,OWNER,ESCROW,CREATE_ALLOCATION,STORAGE_TOPUP,MAX_PRICE,
 storagePreflight,validateActions,finalTransaction,reviewedArtifact} from './client.mjs';
import {domainHash} from '../../contracts/registry/deploy/policy.mjs';
const requireSDK=createRequire(new URL('../../contracts/registry/deploy/package.json',import.meta.url));
const {actions,KeyPair,PublicKey,baseEncode}=await import(pathToFileURL(requireSDK.resolve('near-api-js')).href);
const key=KeyPair.fromRandom('ed25519');
const owner={account_id:OWNER,public_key:key.getPublicKey().toString(),private_key:key.toString()};
const artifact={bytes:Buffer.from('reviewed-wasm-only'),code_hash:'reviewed-code',size_bytes:219847,sha256:'pin'};
const hash=baseEncode(new Uint8Array(32).fill(1)),receipt=baseEncode(new Uint8Array(32).fill(2));
const terms={job_id:'7',buyer:OWNER,provider:`p1.${OWNER}`,amount:String(MAX_PRICE),context_hash:Array(32).fill(1),job_binding_hash:Array(32).fill(2)};
const fund=(t=terms)=>[actions.functionCall('fund',{terms:t},150000000000000n,BigInt(t.amount)+STORAGE_TOPUP)];
const result=tx=>({final_execution_status:'FINAL',status:{SuccessValue:''},transaction:{hash:tx,signer_id:OWNER,receiver_id:ESCROW},
 transaction_outcome:{id:tx,outcome:{status:{SuccessReceiptId:receipt},receipt_ids:[receipt]}},
 receipts_outcome:[{id:receipt,outcome:{status:{SuccessValue:''},receipt_ids:[]}}]});
function fixture(t){
 const runtime=mkdtempSync(join(tmpdir(),'nope-payments-'));t.after(()=>rmSync(runtime,{recursive:true,force:true}));
 const rpc={sends:0,queries:0,timeout:false,
  async connect(){},async account(id){return id===OWNER?{code_hash:'registry-code',amount:String(10n**25n),storage_usage:230000}:null;},
  async view(id,method){return{value:method==='owner'?OWNER:domainHash()};},
  async access(){return{nonce:1,block_hash:hash};},
  async request(method,params){
   if(method==='EXPERIMENTAL_protocol_config')return{runtime_config:{storage_amount_per_byte:'10000000000000000000'}};
   if(method==='send_tx'){
    this.sends++;const saved=JSON.parse(readFileSync(join(runtime,'fund-7.json')));this.saved=saved;
    // Proves a durable hash-only record existed before broadcast; no secret copy.
    assert.equal(Object.values(saved).includes(owner.private_key),false);
    if(this.timeout)throw new Error('TIMEOUT_UNKNOWN');return result(saved.tx_hash);
   }
   if(method==='tx'){this.queries++;assert.equal(params.tx_hash,this.saved.tx_hash);assert.equal(params.wait_until,'FINAL');return result(params.tx_hash);}
   throw new Error('UNEXPECTED_TEST_RPC_METHOD');
  }};
 const options={rpc,runtime,loadOwner:()=>owner,lock:async fn=>fn(),artifact:()=>artifact,registryPin:()=> 'registry-code'};
 return{rpc,runtime,adapter:new EscrowTestnetAdapter(options),options};
}

test('actual reviewed Wasm and exact storage bound',()=>{
 const a=reviewedArtifact();assert.equal(a.size_bytes,219847);assert.equal(a.code_hash,'36ArHnTqzmnL25wym4Hp5gLPAfp2yuShqKXAXYAUdo5A');
 const p=storagePreflight(a.size_bytes,'10000000000000000000');
 assert.equal(p.code_storage_yocto,'2198470000000000000000000');
 assert.equal(p.minimum_with_state_reserve_yocto,'2280390000000000000000000');assert.equal(p.sufficient,true);
 assert.equal(storagePreflight(a.size_bytes,'10000000000000000000',500000000000000000000000n).sufficient,false);
 assert.equal(p.allocation_yocto,String(CREATE_ALLOCATION));
 assert.throws(()=>storagePreflight(1,undefined),/STORAGE_PRICE_UNVERIFIED/);
});

test('no main lock-free signal or insufficient storage means zero sends and no child key',async t=>{
 const{adapter,rpc,runtime}=fixture(t);
 await assert.rejects(adapter.deploy(),/WAIT_FOR_MAIN_OWNER_LOCK_FREE_SIGNAL/);
 const request=rpc.request.bind(rpc);rpc.request=async(method,params)=>method==='EXPERIMENTAL_protocol_config'?{runtime_config:{storage_amount_per_byte:'100000000000000000000'}}:request(method,params);
 await assert.rejects(adapter.deploy({ownerLockFree:true}),/ESCROW_STORAGE_EXCEEDS_AUTHORIZED_3_TEST_NEAR/);
 assert.equal(rpc.sends,0);assert.deepEqual(readdirSync(runtime),[]);
});

test('owner retains one spendable test NEAR after own code storage, allocation and gas',async t=>{
 const{adapter,rpc,runtime}=fixture(t);
 rpc.account=async id=>id===OWNER?{code_hash:'registry-code',amount:String(5n*10n**24n),storage_usage:230000}:null;
 const plan=await adapter.plan();assert.equal(plan.storage.sufficient,true);assert.equal(plan.owner_reserve_sufficient,false);
 await assert.rejects(adapter.deploy({ownerLockFree:true}),/OWNER_MUST_RETAIN_ONE_TEST_NEAR/);
 assert.equal(rpc.sends,0);assert.deepEqual(readdirSync(runtime),[]);
});

test('existing owner lock rejection never enters mutation or loads identity',async t=>{
 const{options,rpc}=fixture(t);let loaded=false;
 const adapter=new EscrowTestnetAdapter({...options,loadOwner:()=>{loaded=true;return owner;},lock:async()=>{throw new Error('EEXIST');}});
 await assert.rejects(adapter.deploy({ownerLockFree:true}),/EEXIST/);assert.equal(loaded,false);assert.equal(rpc.sends,0);
});

test('real SDK signature persists hash before broadcast; timeout restart queries same hash only',async t=>{
 const{adapter,rpc,options}=fixture(t);rpc.timeout=true;
 await assert.rejects(adapter.locked(true,()=>adapter.sendOnce(owner,owner,ESCROW,'fund-7',fund(),artifact)),/TIMEOUT_UNKNOWN/);
 const original=rpc.saved.tx_hash;
 const restart=new EscrowTestnetAdapter(options);
 const recovered=await restart.locked(true,()=>restart.sendOnce(owner,owner,ESCROW,'fund-7',fund(),artifact));
 assert.equal(recovered.transaction.hash,original);assert.equal(rpc.sends,1);assert.equal(rpc.queries,1);
 await assert.rejects(restart.locked(true,()=>restart.sendOnce(owner,owner,ESCROW,'fund-7',fund({...terms,amount:'1'}),artifact)),/PAYMENT_JOURNAL_BINDING_MISMATCH/);
 assert.equal(rpc.sends,1);
});

test('sender refuses bypassing owner lock and arbitrary method/recipient/price/deposit',async t=>{
 const{adapter,rpc}=fixture(t);
 await assert.rejects(adapter.sendOnce(owner,owner,ESCROW,'fund-7',fund(),artifact),/EXCLUSIVE_OWNER_LOCK_REQUIRED/);
 const validate=(list,overrides={})=>validateActions({id:owner,receiver:ESCROW,label:'fund-7',list,artifact,...overrides});
 assert.throws(()=>validate(fund(),{receiver:'treasury.near'}),/POLICY/);
 assert.throws(()=>validate(fund({...terms,provider:'attacker.testnet'})),/POLICY/);
 assert.throws(()=>validate(fund({...terms,amount:String(MAX_PRICE+1n)})),/POLICY/);
 assert.throws(()=>validate([actions.functionCall('fund',{terms},150000000000000n,1n)]),/POLICY/);
 assert.throws(()=>validate([actions.transfer(MAX_PRICE)]),/POLICY/);
 assert.throws(()=>validate(fund(),{id:{account_id:'owner.near'}}),/NOT_ALLOWED/);
 assert.equal(rpc.sends,0);
});

test('account creation exact child, fixed allocation and exact fresh full-access key',()=>{
 const publicKey=key.getPublicKey().toString(),list=[actions.createAccount(),actions.transfer(CREATE_ALLOCATION),actions.addFullAccessKey(PublicKey.fromString(publicKey))];
 const validate=(list,extra={})=>validateActions({id:owner,receiver:ESCROW,label:'create-escrow',list,artifact,childPublicKey:publicKey,...extra});
 validate(list);
 assert.throws(()=>validate([actions.createAccount(),actions.transfer(CREATE_ALLOCATION+1n),list[2]]),/REJECTED/);
 assert.throws(()=>validate(list,{receiver:`p1.${OWNER}`}),/REJECTED/);
 assert.throws(()=>validate(list,{childPublicKey:KeyPair.fromRandom('ed25519').getPublicKey().toString()}),/REJECTED/);
});

test('deploy accepts reviewed bytes plus self-new only',()=>{
 const child={account_id:ESCROW},list=[actions.deployContract(artifact.bytes),actions.functionCall('new',{registry:OWNER},50000000000000n,0n)];
 validateActions({id:child,receiver:ESCROW,label:'deploy-escrow',list,artifact});
 assert.throws(()=>validateActions({id:child,receiver:ESCROW,label:'deploy-escrow',list:[actions.deployContract(Buffer.from('evil')),list[1]],artifact}),/REJECTED/);
 assert.throws(()=>validateActions({id:owner,receiver:ESCROW,label:'deploy-escrow',list,artifact}),/REJECTED/);
});

test('FINAL plus complete successful receipts required, never outer status alone',()=>{
 finalTransaction(result(hash),hash,OWNER,ESCROW);
 const cases=[];
 let value=result(hash);value.final_execution_status='EXECUTED_OPTIMISTIC';cases.push(value);
 value=result(hash);value.receipts_outcome=[];cases.push(value);
 value=result(hash);value.receipts_outcome[0].outcome.status={Failure:{}};cases.push(value);
 value=result(hash);value.transaction.hash=receipt;cases.push(value);
 value=result(hash);value.transaction.receiver_id='attacker.testnet';cases.push(value);
 value=result(hash);value.receipts_outcome[0].outcome.receipt_ids=[receipt];cases.push(value);
 for(const value of cases)assert.throws(()=>finalTransaction(value,hash,OWNER,ESCROW),/NO_RESEND/);
});
