import test from 'node:test';
import assert from 'node:assert/strict';
import {publicTaskHash} from '../web/agent-plan.mjs';
import {validateModelRequest} from '../web/agent-model-runtime.mjs';
import {buildPlannerMessages} from '../web/agent-model-worker.mjs';
const task={version:1,goal:'Trim C1',columns:[{id:'C1',type:'text'}]};
const envelope={type:'plan',task,taskHash:'a'.repeat(64)};
test('rejects extra private fields before looking at their values',()=>{
 let read=false;
 const input={...envelope};Object.defineProperty(input,'dataset',{enumerable:true,get(){read=true;throw Error('private');}});
 assert.throws(()=>validateModelRequest(input));assert.equal(read,false);
 for(const field of ['headers','rows','filename','budget','key'])assert.throws(()=>validateModelRequest({...envelope,[field]:'PRIVATE'}));
 for(const field of ['headers','rows','filename','budget','key'])assert.throws(()=>validateModelRequest({...envelope,task:{...task,[field]:'PRIVATE'}}));
});
test('uses MAIN anonymous schema limits and canonical task',()=>{
 assert.deepEqual(validateModelRequest(envelope),envelope);
 assert.throws(()=>validateModelRequest({...envelope,task:{...task,columns:[{id:1,type:'text'}]}}));
 assert.throws(()=>validateModelRequest({...envelope,task:{...task,columns:[{id:'C17',type:'text'}]}}));
 assert.throws(()=>validateModelRequest({...envelope,task:{...task,columns:Array.from({length:5},(_,i)=>({id:`C${i+1}`,type:'text'}))}}));
 assert.throws(()=>validateModelRequest({...envelope,task:{...task,goal:'a\0b'}}));
 assert.throws(()=>validateModelRequest({...envelope,task:{...task,goal:'ü'.repeat(901)}}));
});
test('model messages contain public task only, never task hash or metadata',async()=>{
 const hash=await publicTaskHash(task);
 const messages=buildPlannerMessages(task);
 assert.equal(messages.at(-1).content,task.goal);
 assert.ok(messages[0].content.endsWith(JSON.stringify(task.columns)));
 assert.ok(!JSON.stringify(messages).includes(hash));
});
test('verifies model bytes and rejects truncated, corrupt and oversized files',async()=>{
 const {verifiedModelResponse}=await import('../web/agent-model-worker.mjs');
 const {createHash}=await import('node:crypto');
 const bytes=new TextEncoder().encode('public model fixture');
 const file={bytes:bytes.length,sha256:createHash('sha256').update(bytes).digest('hex')};
 const verified=await verifiedModelResponse(new Response(bytes),file);
 assert.equal(await verified.text(),'public model fixture');
 await assert.rejects(verifiedModelResponse(new Response(bytes.slice(1)),file));
 const corrupt=bytes.slice();corrupt[0]^=1;
 await assert.rejects(verifiedModelResponse(new Response(corrupt),file));
 await assert.rejects(verifiedModelResponse(new Response(new Uint8Array(bytes.length+1)),file));
});
test('tuple adapter copies model choices, never repairs, drops or guesses operations',async()=>{
 const {adaptModelOperations}=await import('../web/agent-model-worker.mjs');
 const publicTask={version:1,goal:'Public instruction',columns:[{id:'C2',type:'text'},{id:'C3',type:'number'}]};
 const raw='{"operations":[["C2","uppercase"],["C2","redactDigits"],["C3","fill",7],["C3","clamp",10,80]]}';
 assert.deepEqual(JSON.parse(adaptModelOperations(raw,publicTask)),{steps:[
  {column:'C2',recipe:{type:'text',steps:[{op:'uppercase'},{op:'redactDigits'}]}},
  {column:'C3',recipe:{type:'number',steps:[{op:'fill',value:7},{op:'clamp',min:10,max:80}]}}
 ]});
 assert.throws(()=>adaptModelOperations('{"operations":[["C2","trim"],["C2","translate","Turkish"]]}',publicTask));
 assert.throws(()=>adaptModelOperations('{"operations":[["C9","trim"]]}',publicTask));
 assert.throws(()=>adaptModelOperations('{"operations":[["C2","fill",7]]}',publicTask));
 assert.throws(()=>adaptModelOperations('{"operations":[["C3","fill"]]}',publicTask));
 assert.throws(()=>adaptModelOperations('{"operations":[["C3","fill",7]],"operations":[["C3","fill",8]]}',publicTask));
});
