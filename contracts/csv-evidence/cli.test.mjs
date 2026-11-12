import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,rmSync,readFileSync,lstatSync} from 'node:fs';
import {createRequire} from 'node:module';
import {pathToFileURL} from 'node:url';
import {join} from 'node:path';
import {metadata,validateActions,sendOnce,ROOT,OWNER,PROFILE} from './cli.mjs';
const require=createRequire(new URL('../registry/deploy/package.json',import.meta.url));
const {actions,KeyPair}=await import(pathToFileURL(require.resolve('near-api-js')).href);
const h='ab'.repeat(32);
test('strict metadata, exact bounded batch relation',()=>{
 assert.deepEqual(metadata(h,5,2),{manifest_hash:h,profile:PROFILE,row_count:5,batch_count:2});
 for(const args of [[h,5,1],[h,1,2],[h,0,1],[h,33,8],[h,1,0],[h,32,9],[h,1.5,1],['AA'.repeat(32),1,1],['/tmp/manifest.json',1,1],[h,'5',2]])assert.throws(()=>metadata(...args));
 for(let rows=1;rows<=32;rows++)assert.doesNotThrow(()=>metadata(h,rows,Math.ceil(rows/4)));
});
test('actions forbid transfer/topup/key/deployment outside exact atomic bounded creation',()=>{
 const m=metadata(h,5,2),call=actions.functionCall('record_manifest',m,30000000000000n,0n);
 assert.doesNotThrow(()=>validateActions([call],`anchor-${h}`,null,m));
 assert.throws(()=>validateActions([actions.transfer(1n)],`anchor-${h}`,null,m));
 assert.throws(()=>validateActions([actions.functionCall('record_manifest',m,30000000000000n,1n)],`anchor-${h}`,null,m));
 assert.throws(()=>validateActions([actions.functionCall('new',{owner:OWNER},30000000000000n,0n)],`anchor-${h}`,null,m));
 const bytes=Buffer.from('reviewed');const list=[actions.createAccount(),actions.transfer(300000000000000000000000n),actions.deployContract(bytes),actions.functionCall('new',{owner:OWNER},30000000000000n,0n)];
 assert.doesNotThrow(()=>validateActions(list,'deploy',bytes));list[1]=actions.transfer(300000000000000000000001n);assert.throws(()=>validateActions(list,'deploy',bytes));
});
test('unknown broadcast has fsynced 0600 journal; repeat queries same hash, never resigns or broadcasts',async()=>{
 mkdirSync(join(ROOT,'runtime'),{recursive:true,mode:0o700});const dir=mkdtempSync(join(ROOT,'runtime','test-'));
 const key=KeyPair.fromRandom('ed25519');const id={account_id:OWNER,public_key:key.getPublicKey().toString(),private_key:key.toString()};
 let broadcasts=0,queries=0,accesses=0;const label=`anchor-${h}`,m=metadata(h,5,2),list=[actions.functionCall('record_manifest',m,30000000000000n,0n)];
 const rpc={connect:async()=>{},account:async()=>({code_hash:'5WzwjqPvm3nRz6CEkkx73R8dcBtu3YBH6gr6DnoccSEv'}),access:async()=>{accesses++;return{nonce:1,block_hash:'11111111111111111111111111111111'}},request:async(method,p)=>{
  const file=join(dir,label+'.json');const journal=JSON.parse(readFileSync(file,'utf8'));assert.equal(lstatSync(file).mode&0o777,0o600);assert.equal('private_key' in journal,false);
  if(method==='send_tx'){broadcasts++;assert.ok(p.signed_tx_base64);throw new Error('TIMEOUT');}
  assert.equal(method,'tx');assert.equal(p.tx_hash,journal.transactionHash);queries++;throw new Error('STILL_UNKNOWN');
 }};
 try{await assert.rejects(sendOnce(rpc,id,label,list,null,m,dir),/TIMEOUT/);await assert.rejects(sendOnce(rpc,id,label,list,null,m,dir),/STILL_UNKNOWN/);assert.equal(broadcasts,1);assert.equal(queries,1);assert.equal(accesses,1);
 await assert.rejects(sendOnce(rpc,id,label,[actions.functionCall('record_manifest',metadata(h,6,2),30000000000000n,0n)],null,metadata(h,6,2),dir),/JOURNAL_MISMATCH/);
 }finally{rmSync(dir,{recursive:true});}
});
