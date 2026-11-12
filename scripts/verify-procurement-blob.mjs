// Authorized real private-Blob persistence check. Synthetic metadata only; no bids/files/payments.
import {randomBytes,createHash} from 'node:crypto';import fs from 'node:fs/promises';import assert from 'node:assert/strict';
import {createProcurement} from '../procurement/core.mjs';import {blobProcurementStore} from '../procurement/blob.mjs';
try{
 const token=randomBytes(32).toString('base64url'),hash=createHash('sha256').update(token).digest('hex'),id=randomBytes(16).toString('hex'),now=Date.now();
 const grants=[{tokenHash:hash,principal:'synthetic-storage-buyer.testnet',role:'buyer',expiresAt:now+3600000},...['a','b','c'].map((p,n)=>({tokenHash:createHash('sha256').update(randomBytes(32)).digest('hex'),principal:`synthetic-${p}.testnet`,role:'provider',expiresAt:now+3600000}))];
 const env={...process.env,NOPE_PROCUREMENT_GRANTS:JSON.stringify(grants)};
 const fresh=()=>createProcurement({store:blobProcurementStore(env),env});
 const body={jobId:id,title:'SYNTHETIC persistence verification',profile:'clean-4-records-v1',roster:grants.slice(1).map(g=>g.principal),bidDeadlineNs:String(BigInt(now+300000)*1000000n),resultDeadlineNs:String(BigInt(now+600000)*1000000n)};
 const request=()=>new Request('https://veil-procurement.vercel.app/api/procurement/jobs',{method:'POST',headers:{Authorization:'Bearer '+token,'Content-Type':'application/json','Idempotency-Key':'synthetic-storage-'+id},body:JSON.stringify(body)});
 const created=await fresh()(request());assert.equal(created.status,201,'create failed');const first=await created.json();
 const read=await fresh()(new Request('https://veil-procurement.vercel.app/api/procurement/jobs/'+id,{headers:{Authorization:'Bearer '+token}}));assert.equal(read.status,200,'read failed');assert.deepEqual(await read.json(),first);
 const replay=await fresh()(request());assert.equal(replay.status,201,'replay failed');assert.deepEqual(await replay.json(),first);
 const conflict=structuredClone(body);conflict.title='Different synthetic body';
 const bad=await fresh()(new Request('https://veil-procurement.vercel.app/api/procurement/jobs',{method:'POST',headers:{Authorization:'Bearer '+token,'Content-Type':'application/json','Idempotency-Key':'synthetic-storage-'+id},body:JSON.stringify(conflict)}));assert.equal(bad.status,409);
 const evidence={realPrivateBlob:true,syntheticMetadata:true,jobId:id,restartReadMatched:true,replayMatched:true,conflictingReplayRejected:true,realPayment:false,blockchain:false,verifiedAt:new Date().toISOString()};
 await fs.writeFile('docs/verification/procurement-real-blob.json',JSON.stringify(evidence,null,2)+'\n');console.log(JSON.stringify(evidence));
}catch(e){console.error(JSON.stringify({ok:false,phase:'real-private-blob',error:e.name==='AssertionError'?e.message:'STORAGE_CHECK_FAILED'}));process.exitCode=1;}
