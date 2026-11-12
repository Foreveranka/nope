import test from 'node:test';
import assert from 'node:assert/strict';
import {Readable} from 'node:stream';
import handler from '../api/procurement.mjs';
async function call(url,{body='',method='GET',headers={}}={}){
 const req=Readable.from(body?[Buffer.from(body)]:[]);Object.assign(req,{url,method,headers});
 const response={headers:{},statusCode:0,headersSent:false,writableEnded:false,destroyed:false,setHeader(k,v){this.headers[k.toLowerCase()]=v;},end(v){this.body=JSON.parse(String(v));this.writableEnded=true;}};
 await handler(req,response);return response;
}
test('actual procurement Vercel adapter preserves public health and no-store',async()=>{const r=await call('/api/procurement?route=health');assert.equal(r.statusCode,200);assert.equal(r.headers['cache-control'],'no-store');});
test('procurement adapter cannot replace authorization with cookies or a forged forwarded origin',async()=>{const r=await call('/api/procurement?route=session',{headers:{cookie:'token=fake','x-forwarded-host':'evil.invalid',origin:'https://evil.invalid'}});assert.equal(r.statusCode,403);assert.ok(r.body.error);});
test('procurement adapter limits stream before storage or auth',async()=>{const r=await call('/api/procurement?route=jobs',{method:'POST',body:'x'.repeat(16385)});assert.equal(r.statusCode,413);assert.equal(r.body.code,'BODY_TOO_LARGE');});
test('procurement adapter rejects duplicate rewritten routes without exposing internals',async()=>{const r=await call('/api/procurement?route=health&route=jobs');assert.equal(r.statusCode,503);assert.equal(r.body.code,'SERVICE_UNAVAILABLE');});
