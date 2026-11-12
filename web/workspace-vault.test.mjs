import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createVault, parseNearAmount, formatNearAmount, quoteCommitment, randomSalt } from './workspace-vault.mjs';
import { createGarbledJob } from './gc-client.mjs';
import { buildCircuit, deriveGateKey, gateContext, fromBase64, toBase64 } from './gc-core.mjs';

// This is ONLY a structured-cloning memory adapter, not IndexedDB. Crypto tests
// below use real Node WebCrypto. Browser IndexedDB durability is not claimed.
class MemoryStorage {
  records=new Map();
  async get(key) { return structuredClone(this.records.get(JSON.stringify(key))); }
  async put(key,value) { this.records.set(JSON.stringify(key),structuredClone(value)); }
  async installKeys(key,value) {
    const k=JSON.stringify(key);
    if (!this.records.has(k)) this.records.set(k,structuredClone(value));
    return structuredClone(this.records.get(k));
  }
  async deleteSession(session) {
    for (const key of this.records.keys()) if(JSON.parse(key)[0]===session)this.records.delete(key);
  }
}
async function evaluate(request) {
  const circuit=buildCircuit();
  return Promise.all(request.rows.map(async(row,r)=> {
    const wires=row.inputs.map(s=>fromBase64(s));
    for(const [g,gate] of circuit.gates.entries()) {
      const a=wires[gate.a],b=gate.op==='NOT'?undefined:wires[gate.b];
      const entry=fromBase64(row.tables[g][b?2*(a[15]&1)+(b[15]&1):a[15]&1],44);
      const key=await deriveGateKey(request.nonce,r,g,a,b);
      wires[gate.out]=new Uint8Array(await crypto.subtle.decrypt({name:'AES-GCM',iv:entry.subarray(0,12),additionalData:gateContext(r,g)},key,entry.subarray(12)));
    }
    return circuit.outputs.map(w=>toBase64(wires[w]));
  }));
}
function corrupt(envelope,field) {
  const result=structuredClone(envelope),bytes=Buffer.from(result[field],'base64');
  bytes[0]^=1;result[field]=bytes.toString('base64');return result;
}

test('exact NEAR decimal conversion and display, including 1 yocto and amounts beyond safe Number',()=> {
  for(const [near,amount] of [['0','0'],['1','1000000000000000000000000'],['0.000000000000000000000001','1'],['12345678901234567890.123456789012345678901234','12345678901234567890123456789012345678901234'],['0.1234567','123456700000000000000000']]) {
    assert.equal(parseNearAmount(near),BigInt(amount));
    assert.equal(formatNearAmount(amount),near);
    assert.equal(formatNearAmount(BigInt(amount)),near);
  }
  assert.equal(formatNearAmount(parseNearAmount('1.230000')), '1.23');
  for(const bad of [1,0.1,'',' 1','1 ','01','-1','+1','.1','1.','1e3','0.0000000000000000000000001','NaN','1,5'])assert.throws(()=>parseNearAmount(bad));
  for(const bad of [1,-1n,'-1','01','1.1'])assert.throws(()=>formatNearAmount(bad));
});

test('quote commitment matches exact backend four-string JSON SHA-256 and fresh 32-byte salts',async()=> {
  const salt=randomSalt(),other=randomSalt();
  assert.match(salt,/^[0-9a-f]{64}$/);assert.notEqual(salt,other);
  const amount=parseNearAmount('1.234567890123456789012345').toString();
  const expected=createHash('sha256').update(JSON.stringify(['job-1','bidder-1',amount,salt])).digest('hex');
  assert.equal(await quoteCommitment('job-1','bidder-1',amount,salt),expected);
  assert.equal(await quoteCommitment('job-1','bidder-1',BigInt(amount),salt),expected);
  for(const args of [['','bidder',amount,salt],['job','bidder',1,salt],['job','bidder',amount,'ab'.repeat(16)],['job','bidder',amount,'AB'.repeat(32)]])await assert.rejects(quoteCommitment(...args));
});

test('encrypted local JSON restores via a new instance; only structured-cloned nonextractable keys persist',async()=> {
  const storage=new MemoryStorage(),vault=createVault('guest',{storage});
  const data={csv:'private-marker\n255\n42',dataset:[{value:255}],filename:'secret.csv',column:'private-value',values:[255,42],budget:'12.345678901234567890123456'};
  await vault.saveJob('job',data);
  assert.deepEqual(await createVault('guest',{storage}).loadJob('job'),data);
  assert.equal(await vault.loadJob('missing'),null);
  const record=await storage.get(['guest','job','job']);
  assert.deepEqual(Object.keys(record).sort(),['ciphertext','iv']);
  assert.doesNotMatch(JSON.stringify([...storage.records.values()]),/private-marker|secret.csv|private-value|12\.3456789/);
  const keys=await storage.get(['guest','keys']);
  assert.equal(keys.aes.constructor.name,'CryptoKey');assert.equal(keys.aes.algorithm.length,256);
  assert.equal(keys.privateKey.algorithm.modulusLength,2048);
  assert.equal(keys.aes.extractable,false);assert.equal(keys.privateKey.extractable,false);
  await assert.rejects(crypto.subtle.exportKey('raw',keys.aes));
  await assert.rejects(crypto.subtle.exportKey('jwk',keys.privateKey));
  await vault.saveJob('job',data);
  assert.notEqual((await storage.get(['guest','job','job'])).iv,record.iv);
  await storage.put(['guest','job','job'],corrupt(record,'ciphertext'));
  await assert.rejects(vault.loadJob('job'));
});

test('RSA-OAEP + AES-GCM hybrid quotes restore, are randomized, and reject wrong recipient/tampering',async()=> {
  const storage=new MemoryStorage(),buyer=createVault('buyer',{storage}),bidder=createVault('bidder',{storage});
  const pub=await buyer.buyerPublicKey();
  assert.equal(pub.kty,'RSA');assert.equal(pub.alg,'RSA-OAEP-256');assert.equal(pub.d,undefined);
  assert.deepEqual(await createVault('buyer',{storage}).buyerPublicKey(),pub);
  const quote={jobId:'job',providerId:'bidder',amountYocto:parseNearAmount('0.000001').toString(),salt:randomSalt(),deliveryHours:2,note:'private-bid'};
  const a=await bidder.encryptQuote(pub,quote), b=await bidder.encryptQuote(pub,quote);
  assert.deepEqual(Object.keys(a).sort(),['ciphertext','iv','wrappedKey']);
  assert.equal(Buffer.from(a.wrappedKey,'base64').length,256);
  assert.doesNotMatch(JSON.stringify(a),/private-bid|amountYocto/);
  assert.notEqual(a.wrappedKey,b.wrappedKey);assert.notEqual(a.iv,b.iv);assert.notEqual(a.ciphertext,b.ciphertext);
  assert.deepEqual(await createVault('buyer',{storage}).decryptQuote(a),quote);
  await assert.rejects(bidder.decryptQuote(a));
  for(const field of ['wrappedKey','iv','ciphertext'])await assert.rejects(buyer.decryptQuote(corrupt(a,field)));
  await assert.rejects(buyer.decryptQuote({...a,plaintext:quote}));
  await assert.rejects(bidder.encryptQuote({...pub,d:'secret'},quote));
  await assert.rejects(bidder.encryptQuote({...pub,alg:'RSA-OAEP'},quote));
});

test('session/job AAD isolates records; clear removes only one session and rotates its keys',async()=> {
  const storage=new MemoryStorage(),a=createVault('a',{storage}),b=createVault('b',{storage});
  const pub=await a.buyerPublicKey();
  await a.saveJob('job',{filename:'a.csv'});await b.saveJob('job',{filename:'b.csv'});
  const encrypted=await storage.get(['a','job','job']);
  await storage.put(['a','job','other'],encrypted);await assert.rejects(a.loadJob('other'));
  await storage.put(['b','job','copied'],encrypted);await assert.rejects(b.loadJob('copied'));
  await a.clear();assert.equal(await a.loadJob('job'),null);
  assert.deepEqual(await b.loadJob('job'),{filename:'b.csv'});
  assert.ok([...storage.records.keys()].every(key=>JSON.parse(key)[0]!=='a'));
  assert.notDeepEqual(await a.buyerPublicKey(),pub);
});

test('simultaneous instances atomically install the same key and do not lose either job',async()=> {
  const storage=new MemoryStorage(),a=createVault('race',{storage}),b=createVault('race',{storage});
  await Promise.all([a.saveJob('one',{value:1}),b.saveJob('two',{value:2})]);
  assert.deepEqual(await a.buyerPublicKey(),await b.buyerPublicKey());
  assert.deepEqual(await a.loadJob('two'),{value:2});assert.deepEqual(await b.loadJob('one'),{value:1});
});

test('garbled decoder restores after reload; delivery labels stay bound to the original job',async()=> {
  const storage=new MemoryStorage(),vault=createVault('guest',{storage}),gcjob=await createGarbledJob([255,42,150]);
  const outputs=await evaluate(gcjob.request);
  await vault.saveJob('job',{filename:'customer.csv',values:[255,42,150]});
  await vault.saveDecoder('job',gcjob);
  const reloaded=createVault('guest',{storage});
  assert.deepEqual(await reloaded.decodeDelivery('job',outputs),[0,42,100]);
  assert.deepEqual((await reloaded.loadJob('job')).values,[255,42,150]);
  await assert.rejects(reloaded.decodeDelivery('missing',outputs),/No local decoder/);
  const other=await createGarbledJob([255,42,150]);
  await assert.rejects(reloaded.decodeDelivery('job',await evaluate(other.request)),/belong/);
  await storage.put(['guest','decoder','copy'],await storage.get(['guest','decoder','job']));
  await assert.rejects(reloaded.decodeDelivery('copy',outputs));
  await storage.put(['guest','decoder','job'],corrupt(await storage.get(['guest','decoder','job']),'iv'));
  await assert.rejects(reloaded.decodeDelivery('job',outputs));
  await vault.clear();await assert.rejects(reloaded.decodeDelivery('job',outputs),/No local decoder/);
});

test('storage failures propagate; no ephemeral fallback is presented as durable',async()=> {
  if (!globalThis.indexedDB) await assert.rejects(createVault('no-idb').saveJob('job',{}),/IndexedDB/);
  const storage={get:async()=>{throw new Error('Storage denied');}};
  await assert.rejects(createVault('guest',{storage}).buyerPublicKey(),/Storage denied/);
  assert.throws(()=>createVault(''));
});
