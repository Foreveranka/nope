import test from 'node:test';
import assert from 'node:assert/strict';
import {blobProcurementStore} from '../procurement/blob.mjs';
const revision='nope-procurement-v1/jobs/'+'a'.repeat(32)+'/revisions/000.json';
const prefix='nope-procurement-v1/participants/'+'b'.repeat(64)+'/';
const index=prefix+'a'.repeat(32)+'.json';
const bytes=value=>new Response(JSON.stringify(value)).body;
function mock(){
  const objects=new Map();const calls=[];
  const client={
    async get(path,options){calls.push({operation:'get',path,options});return objects.has(path)?{statusCode:200,stream:bytes(objects.get(path))}:null;},
    async put(path,value,options){calls.push({operation:'put',path,options});if(objects.has(path))throw Error('Already exists');objects.set(path,JSON.parse(value));},
    async list(options){calls.push({operation:'list',options});return {blobs:[{pathname:index}],hasMore:false};},
  };
  const store=blobProcurementStore({},client);return {objects,calls,client,store};
}
test('blob records are private, immutable, bounded and have no expiry policy',async()=>{
  const f=mock();assert.equal(await f.store.create(revision,{schema:1}),true);assert.equal(await f.store.create(revision,{schema:2}),false);assert.deepEqual(await f.store.read(revision),{schema:1});
  for(const call of f.calls.filter(c=>c.operation==='put')){assert.equal(call.options.access,'private');assert.equal(call.options.allowOverwrite,false);assert.equal(call.options.addRandomSuffix,false);assert.equal('ttlDays' in call.options,false);}
  assert.equal(f.calls.filter(c=>c.operation==='get').every(c=>c.options.useCache===false),true);
  assert.deepEqual(await f.store.list({prefix,limit:20}),{pathnames:[index],cursor:null});
  await assert.rejects(f.store.create(revision,{large:'x'.repeat(65536)}));assert.equal('remove' in f.store,false);assert.equal('sign' in f.store,false);
});
test('unknown writes require readback and never become false success when storage is unreadable or absent',async()=>{
  const f=mock();f.client.put=async(path,value)=>{f.objects.set(path,JSON.parse(value));throw Error('lost reply');};assert.equal(await f.store.create(revision,{schema:1}),false);
  const g=mock();g.client.put=async()=>{throw Error('not written or unknown');};await assert.rejects(g.store.create(revision,{schema:1}));
  g.client.get=async()=>{throw Error('unavailable');};await assert.rejects(g.store.create(revision,{schema:1}));
});
test('blob store cannot pivot out of procurement records or principal-constrained listings',async()=>{
  const f=mock();for(const path of ['veil-v1/owner/secret','../keys',revision+'/suffix','nope-procurement-v1/jobs/'+'a'.repeat(32)+'/revisions/9999.json']){await assert.rejects(f.store.read(path));await assert.rejects(f.store.create(path,{}));}
  for(const query of [{prefix:'',limit:20},{prefix:'nope-procurement-v1/',limit:20},{prefix,limit:21},{prefix,limit:0},{prefix,limit:1,cursor:'x'.repeat(2049)}])await assert.rejects(f.store.list(query));
  assert.equal(f.calls.length,0);
});
test('blob read and list reject oversized or foreign responses',async()=>{
  const f=mock();f.client.get=async()=>({statusCode:200,stream:new Response('x'.repeat(65537)).body});await assert.rejects(f.store.read(revision));
  f.client.get=async()=>({statusCode:206,stream:bytes({})});await assert.rejects(f.store.read(revision));
  f.client.list=async()=>({blobs:[{pathname:'nope-procurement-v1/participants/'+'c'.repeat(64)+'/'+'a'.repeat(32)+'.json'}],hasMore:false});await assert.rejects(f.store.list({prefix,limit:20}));
});
