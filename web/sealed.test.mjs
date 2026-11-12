import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {parseAmount,sealAmount} from './sealed.mjs';
test('browser commitments match existing Python MPC v2, including all slots and boundaries',async()=>{
 for(const v of JSON.parse(fs.readFileSync(new URL('../docs/verification/sealed-browser-vectors.json',import.meta.url)))) {
  const result=await sealAmount(v.contextHash,v.slot,BigInt(v.amount),Uint8Array.from(Buffer.from(v.salt,'hex')));
  assert.equal(result.commitment,v.commitment);assert.equal(result.witness.amount,v.amount);
 }
});
test('decimal units never use floating point or silently round',()=>{
 assert.equal(parseAmount('1.000001'),1000001n);assert.equal(parseAmount('0',{budget:true}),0n);
 for(const s of ['1e2','01','-1','1.0000001','NaN','0','1000000.000001']) assert.throws(()=>parseAmount(s));
});
test('fresh salt hides identical prices; context and participant are bound',async()=>{
 const a=await sealAmount('ab'.repeat(32),1,42n),b=await sealAmount('ab'.repeat(32),1,42n);
 assert.notEqual(a.commitment,b.commitment);
 const salt=Uint8Array.from(Buffer.from(a.witness.salt,'hex'));
 assert.notEqual(a.commitment,(await sealAmount('ac'.repeat(32),1,42n,salt)).commitment);
 assert.notEqual(a.commitment,(await sealAmount('ab'.repeat(32),2,42n,salt)).commitment);
});
