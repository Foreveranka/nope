import test from 'node:test';
import assert from 'node:assert/strict';
import {blobWorkspaceStore,ROOT} from './blob.mjs';
const task=ROOT+'jobs/'+ 'a'.repeat(32) + '/task.json';
const metadata=ROOT+'jobs/'+ 'a'.repeat(32) + '/0000.json';
test('real Blob adapter preserves bounded multi-megabyte encoded tasks without increasing metadata limits',async()=>{
 const records=new Map();
 const store=blobWorkspaceStore({}, {
  async put(path,body,options){assert.equal(options.access,'private');assert.equal(options.allowOverwrite,false);records.set(path,body);},
  async get(path){const body=records.get(path);if(!body)return null;return {statusCode:200,stream:new Blob([body]).stream()};},
 });
 const value={encoded:'x'.repeat(1200000)};
 assert.equal(await store.create(task,value),true);assert.deepEqual(await store.read(task),value);
 await assert.rejects(store.create(metadata,value),/Record bound/);
 records.set(metadata,JSON.stringify(value));await assert.rejects(store.read(metadata),/Record bound/);
 await assert.rejects(store.create(task,{encoded:'x'.repeat(3*1024*1024)}),/Record bound/);
 records.set(task,JSON.stringify({encoded:'x'.repeat(3*1024*1024)}));await assert.rejects(store.read(task),/Record bound/);
});
