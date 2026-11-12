import test from 'node:test';
import assert from 'node:assert/strict';
import {blobSelectionEvidence} from '../blob-evidence.mjs';
import {evidenceBytes,evidenceHash} from '../selection-verifier.mjs';

test('optional Blob transport uses fixed content-addressed private immutable paths',async()=>{
  const report={payload:{public:'synthetic-only'},signatures:[]};const hash=evidenceHash(report);
  const calls=[];
  const client={put:async(...args)=>calls.push(args),get:async(...args)=>{
    calls.push(args);return {statusCode:200,stream:new ReadableStream({start(c){c.enqueue(evidenceBytes(report));c.close();}})};
  }};
  const storage=blobSelectionEvidence({},client);
  assert.equal(await storage.publish(report),hash);
  assert.equal(calls[0][0],`nope-operator-evidence-v1/${hash}.json`);
  assert.equal(calls[0][2].access,'private');assert.equal(calls[0][2].allowOverwrite,false);
  assert.deepEqual(await storage.loadEvidence(hash),evidenceBytes(report));
  assert.equal(calls[1][1].access,'private');assert.equal(calls[1][1].useCache,false);
  await assert.rejects(storage.loadEvidence('https://attacker.test/report.json'));
});

test('bounded Blob read cancels oversized streams and rejects unavailable storage',async()=>{
  let cancelled=false;
  const storage=blobSelectionEvidence({}, {get:async()=>({statusCode:200,stream:new ReadableStream({
    start(c){c.enqueue(new Uint8Array(16385));},cancel(){cancelled=true;},
  })})});
  await assert.rejects(storage.loadEvidence('a'.repeat(64)));assert.equal(cancelled,true);
  await assert.rejects(blobSelectionEvidence({}, {get:async()=>null}).loadEvidence('a'.repeat(64)));
});
