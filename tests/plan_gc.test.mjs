import test from 'node:test';
import assert from 'node:assert/strict';
import {Readable} from 'node:stream';
import {createHash} from 'node:crypto';
import {PROFILE,MAX_GATES,MAX_REQUEST_BYTES,MAX_PLAN_REQUEST_BYTES,normalizePlan,hashPlan,
  estimatePlan,validatePlanRequest,canonicalPlanRequest,hashPlanRequest,hashPlanProgram,
  canonicalPlanOutput,hashPlanOutput} from '../web/plan-core.mjs';
import {compileRecipe,estimateRecipe,hashRecipeProgram,hashRecipeRequest} from '../web/recipe-core.mjs';
import {preparePlan,decodePlan} from '../web/plan-client.mjs';
import handler,{evaluatePlanRequest} from '../api/plan-gc.mjs';

const clone=v=>JSON.parse(JSON.stringify(v));
const digest=v=>createHash('sha256').update(v).digest('hex');
const text=(...ops)=>({type:'text',steps:ops.map(op=>({op}))});
const number=(...steps)=>({type:'number',steps});
const fill=number({op:'fill',value:17},{op:'clamp',min:10,max:100});
const plan=(...steps)=>({version:1,taskHash:'ab'.repeat(32),steps});
const step=(column,recipe=fill)=>({column,recipe});
const mixedPlan=plan(step('C9',text('trim','lowercase','redactDigits')),step('C1'),
  step('C16',number({op:'clamp',min:20,max:80},{op:'fill',value:200})));
const mixedValues={C9:[' ACME42  ',' BETA7 ',' \0 Z9 '],C1:[255,2,201],C16:[255,0,250]};
const expected={C9:['acme**','beta*','\0 z*'],C1:[17,10,100],C16:[200,20,80]};
let mixedPromise,twinsPromise;
const mixed=()=>mixedPromise??=(async()=>{const job=await preparePlan(mixedValues,mixedPlan);return {...job,result:await evaluatePlanRequest(job.request)};})();
const twins=()=>twinsPromise??=(async()=>{const p=plan(step('C2'),step('C1'));const job=await preparePlan({C1:[255,1,200],C2:[255,1,200]},p);return {...job,result:await evaluatePlanRequest(job.request)};})();
const altered=s=>(s[0]==='A'?'B':'A')+s.slice(1);

test('plan schema rejects unknown keys, aliases, types, prototypes, sparse arrays and accessors without invoking hooks',async()=> {
  const valid=plan(step('C1'));
  for(const p of [null,{},[],{...valid,version:2},{...valid,version:'1'},
    {...valid,taskHash:'AB'.repeat(32)},{...valid,taskHash:'x'.repeat(64)},{...valid,taskHash:1},
    {...valid,headers:['private']},{...valid,steps:[]},plan(...['C1','C2','C3','C4','C5'].map(c=>step(c))),
    plan(step('C1'),step('C1')), ...['C0','C17','C01','c1',1,'C1\n'].map(c=>plan(step(c))),
    plan({...step('C1'),type:'number'}),plan(step('C1',{type:'number',steps:[{op:'trim'}]})),
    plan(step('C1',{type:'text',steps:[{op:'fill',value:1}]})),plan(step('C1',{...fill,secret:1})),
    plan(step('C1',number({op:'fill',value:'17'}))),plan(step('C1',number({op:'clamp',min:10,max:2}))),
    plan(step('C1',number({op:'fill',value:255}))),plan(step('C1',text('execute'))),
    Object.assign(Object.create({hidden:true}),valid),Object.assign(Object.create(Date.prototype),valid),
    {...valid,steps:Array(1)},plan(step('C1',{type:'text',steps:Array(1)}))]) assert.throws(()=>normalizePlan(p));
  const getter=()=>assert.fail('data-only validators must never execute getters');
  for(const field of ['version','taskHash','steps']) {
    const p=clone(valid);Object.defineProperty(p,field,{enumerable:true,get:getter});assert.throws(()=>normalizePlan(p));
  }
  const p=clone(valid);Object.defineProperty(p.steps,'0',{enumerable:true,get:getter});assert.throws(()=>normalizePlan(p));
  for(const [object,key] of [[p.steps,'custom'],[p,'toJSON']]) {
    const q=clone(valid);const target=object===p?q:q.steps;target[key]=getter;assert.throws(()=>normalizePlan(q));
  }
  const recipe=clone(fill);Object.defineProperty(recipe.steps[0],'value',{enumerable:true,get:getter});assert.throws(()=>normalizePlan(plan(step('C1',recipe))));
  const symbol=clone(valid);symbol[Symbol('extra')]=1;assert.throws(()=>normalizePlan(symbol));
  const nullProto=Object.assign(Object.create(null),valid);assert.deepEqual(normalizePlan(nullProto),valid);
  assert.ok(Object.isFrozen(normalizePlan(valid).steps[0].recipe.steps));
});

test('canonical plan/hash/program keep semantic step order and normalize only object key order',async()=> {
  const p=plan(step('C16'),step('C1',text('trim'))),normalized=normalizePlan(p);
  const reordered={steps:p.steps.map(s=>({recipe:{steps:s.recipe.steps.map(op=>Object.fromEntries(Object.entries(op).reverse())),type:s.recipe.type},column:s.column})),taskHash:p.taskHash,version:1};
  assert.deepEqual(normalizePlan(reordered),normalized);
  assert.equal(await hashPlan(p),digest(JSON.stringify(normalized)));
  assert.equal(await hashPlan(p),await hashPlan(reordered));
  assert.equal(await hashPlanProgram(p),await hashPlanProgram(reordered));
  for(const changed of [plan(...clone(p.steps).reverse()),{...p,taskHash:'cd'.repeat(32)},
    plan(step('C15'),p.steps[1]),plan(step('C16',number(...clone(fill.steps).reverse())),p.steps[1])]) {
    assert.notEqual(await hashPlan(p),await hashPlan(changed));
    assert.notEqual(await hashPlanProgram(p),await hashPlanProgram(changed));
  }
  assert.notEqual(await hashPlan(p),await hashPlanProgram(p),'program commits the actual v2 topology in its own domain');
});

test('aggregate gate/serialized budgets and every value are checked before any crypto',async()=> {
  const gates=plan(...['C1','C2','C3','C4'].map(c=>step(c,text('lowercase'))));
  assert.ok(estimateRecipe(text('lowercase'),5).gateCount<MAX_GATES);
  assert.throws(()=>estimatePlan(gates,5),/total 10000 gate budget/);
  const bytes=plan(step('C1',text('trim')),step('C2',text('trim','trim','trim','trim')));
  const v2=bytes.steps.map(s=>estimateRecipe(s.recipe,2));
  assert.ok(v2.every(e=>e.serializedRequestBytes<MAX_REQUEST_BYTES));
  assert.ok(v2.reduce((n,e)=>n+e.gateCount,0)<=MAX_GATES);
  assert.throws(()=>estimatePlan(bytes,2),/total request budget/);
  assert.equal(MAX_PLAN_REQUEST_BYTES,MAX_REQUEST_BYTES-16384);
  for(const n of [0,9,33,1.5,'3',NaN])assert.throws(()=>estimatePlan(mixedPlan,n));
  const descriptor=Object.getOwnPropertyDescriptor(globalThis,'crypto');
  Object.defineProperty(globalThis,'crypto',{configurable:true,get(){assert.fail('preflight must precede even cryptoProvider');}});
  try {
    await assert.rejects(preparePlan(Object.fromEntries(gates.steps.map(s=>[s.column,Array(5).fill('a')])),gates),/total 10000/);
    await assert.rejects(preparePlan({C1:['a','b'],C2:['c','d']},bytes),/total request budget/);
    for(const values of [{C1:[1],C2:['wrong']},{C1:[1],C2:[2,3]},{C1:[1],C2:Array(1)},
      {C1:[1],C2:[null]},{C1:[1],C2:[256]},{C1:[1],C2:[NaN]},
      {C1:[1],C2:[2],headers:['private']},{C1:[1]}]) await assert.rejects(preparePlan(values,plan(step('C1'),step('C2'))));
    for(const values of [['é'],['x'.repeat(17)],[1]])await assert.rejects(preparePlan({C1:values},plan(step('C1',text('trim')))));
    const values={C1:[1]};Object.defineProperty(values,'C1',{get(){assert.fail('must not read value accessor');},enumerable:true});
    await assert.rejects(preparePlan(values,plan(step('C1'))));
  } finally {if(descriptor)Object.defineProperty(globalThis,'crypto',descriptor);else delete globalThis.crypto;}
});

test('actual encrypted multi-column three-row text and number workflow and exact wrapper size',async()=> {
  const job=await mixed();
  assert.deepEqual(await decodePlan(job.result,job.decoder),expected);
  assert.equal(job.request.profile,PROFILE);assert.equal(job.request.rowCount,3);
  assert.equal(job.request.planSha256,await hashPlan(mixedPlan));
  assert.equal(job.result.inputSha256,await hashPlanRequest(job.request));
  assert.equal(job.result.programSha256,await hashPlanProgram(mixedPlan));
  assert.equal(job.result.outputSha256,await hashPlanOutput(job.result.outputs));
  assert.equal(Buffer.byteLength(JSON.stringify(job.request)),estimatePlan(mixedPlan,3).serializedRequestBytes);
  assert.ok(Buffer.byteLength(JSON.stringify(job.request))+16384<MAX_REQUEST_BYTES);
  assert.equal(validatePlanRequest(job.request).gateCount,estimatePlan(mixedPlan,3).gateCount);
  assert.equal(job.result.nonce,job.request.nonce);assert.equal(job.decoder.nonce,job.request.nonce);
  for(const task of job.request.tasks) {
    assert.equal(task.request.programSha256,await hashRecipeProgram(task.request.recipe));
    assert.equal(job.decoder.tasks.find(t=>t.column===task.column).decoder.inputSha256,await hashRecipeRequest(task.request));
  }
  assert.deepEqual(Object.keys(job.result).sort(),['profile','nonce','rowCount','outputs','inputSha256','outputSha256','programSha256'].sort());
});

test('request/output hashes canonicalize object keys and bind aliases, order, labels, nonce and every table entry',async()=> {
  const {request,result}=await mixed();
  const reversed=value=>Array.isArray(value)?value.map(reversed):value&&typeof value==='object'?Object.fromEntries(Object.entries(value).reverse().map(([k,v])=>[k,reversed(v)])):value;
  assert.equal(canonicalPlanRequest(reversed(request)),canonicalPlanRequest(request));
  assert.equal(await hashPlanRequest(request),digest(canonicalPlanRequest(request)));
  assert.equal(await hashPlanOutput(reversed(result.outputs)),digest(canonicalPlanOutput(result.outputs)));
  for(const change of [r=>{r.nonce='01'.repeat(16);},r=>{r.plan.taskHash='00'.repeat(32);},r=>{r.planSha256='00'.repeat(32);},
    r=>{r.tasks[0].request.rows[0].tables[0][0]=altered(r.tasks[0].request.rows[0].tables[0][0]);}]) {
    const r=clone(request);change(r);assert.notEqual(await hashPlanRequest(r),await hashPlanRequest(request));
  }
  assert.notEqual(await hashPlanOutput(result.outputs),await hashPlanOutput(clone(result.outputs).reverse()));
  const changed=clone(result.outputs);changed[0].column='C8';assert.notEqual(await hashPlanOutput(changed),result.outputSha256);
});

test('fresh nonces and labels even for identical columns and across jobs; no plaintext metadata or decoding material crosses boundary',async()=> {
  const {request,decoder,result}=await twins();
  const again=await preparePlan({C1:[255,1,200],C2:[255,1,200]},request.plan);
  const nonceList=[request.nonce,...request.tasks.map(t=>t.request.nonce),again.request.nonce,...again.request.tasks.map(t=>t.request.nonce)];
  assert.equal(new Set(nonceList).size,nonceList.length);
  assert.ok(nonceList.every(n=>/^[0-9a-f]{32}$/.test(n)));
  const labels=[...request.tasks,...again.request.tasks].flatMap(t=>t.request.rows.flatMap(row=>row.inputs));
  assert.equal(new Set(labels).size,labels.length,'no input-label reuse across columns, rows or jobs');
  const pairs=[...decoder.tasks,...again.decoder.tasks].flatMap(t=>t.decoder.outputPairs.flat(2));
  assert.equal(new Set(pairs).size,pairs.length,'no output-pair reuse');
  assert.ok(pairs.every(label=>!labels.includes(label)));
  assert.deepEqual(await decodePlan(result,decoder),{C2:[17,10,100],C1:[17,10,100]});
  const publicString=JSON.stringify((await mixed()).request);
  for(const forbidden of ['ACME42','BETA7','outputPairs','decoder','headers','filename','valuesByColumn','secretKey']) assert.equal(publicString.includes(forbidden),false);
  assert.deepEqual(Object.keys(request).sort(),['profile','plan','planSha256','nonce','rowCount','tasks'].sort());
  assert.ok(Object.isFrozen(request.tasks[0].request.rows));
});

test('strict request task shape, type, row count and order, with malformed data-only structures rejected',async()=> {
  const {request}=await twins();
  const changes=[r=>{r.extra=1;},r=>{r.profile='nope-csv-recipe-gc-v2';},r=>{delete r.nonce;},r=>{r.nonce='F'.repeat(32);},
    r=>{r.rowCount='3';},r=>{r.rowCount=2;},r=>{r.tasks.reverse();},r=>{r.tasks.pop();},r=>{r.tasks[0].column='C3';},
    r=>{r.tasks[0].headers=['hidden'];},r=>{r.tasks[0].request.rowCount=2;},r=>{r.tasks[0].request.recipe.steps[0].value=5;},
    r=>{r.tasks[0].request.nonce=r.nonce;},r=>{r.tasks[1].request.nonce=r.tasks[0].request.nonce;},
    r=>{r.tasks[0].request.decoder={};},r=>{r.tasks[0].request.rows[0].inputs.pop();},r=>{r.tasks[0].request.rows[0].tables[0][0]='A';},
    r=>{r.tasks=Array(2);},r=>{r.tasks[0].request.rows[0].tables[0]=Array(4);}];
  for(const mutate of changes){const r=clone(request);mutate(r);assert.throws(()=>validatePlanRequest(r));}
  const accessor=clone(request);Object.defineProperty(accessor.tasks[0],'request',{get(){assert.fail('must not invoke request getter');},enumerable:true});assert.throws(()=>validatePlanRequest(accessor));
  const proto=clone(request);Object.setPrototypeOf(proto.tasks[0],{inherited:1});assert.throws(()=>validatePlanRequest(proto));
  for(const mutate of [r=>{r.planSha256='00'.repeat(32);},r=>{r.tasks[0].request.programSha256='00'.repeat(32);},
    r=>{r.tasks[0].request.nonce='01'.repeat(16);},r=>{r.tasks[0].request.rows[0].tables[0]=r.tasks[0].request.rows[0].tables[0].map(altered);}]) {
    const r=clone(request);mutate(r);await assert.rejects(evaluatePlanRequest(r));
  }
});

test('decoder rejects context/hash/type/order tampering and cross-job/column/row/wire outputs even with recomputed output hash',async()=> {
  const {request,result,decoder}=await twins();
  for(const mutate of [r=>{r.profile='wrong';},r=>{r.nonce='00'.repeat(16);},r=>{r.rowCount=2;},r=>{r.extra='metadata';},
    ...['inputSha256','outputSha256','programSha256'].map(key=>r=>{r[key]='00'.repeat(32);})]) {
    const r=clone(result);mutate(r);await assert.rejects(decodePlan(r,decoder));
  }
  for(const mutate of [r=>{r.outputs.reverse();},r=>{[r.outputs[0].outputs,r.outputs[1].outputs]=[r.outputs[1].outputs,r.outputs[0].outputs];},
    r=>{r.outputs[0].outputs.reverse();},r=>{r.outputs[0].outputs[0].reverse();},r=>{r.outputs[0].outputs[0][0]=altered(r.outputs[0].outputs[0][0]);},
    r=>{r.outputs[0].column='C3';}]) {
    const r=clone(result);mutate(r);r.outputSha256=await hashPlanOutput(r.outputs);await assert.rejects(decodePlan(r,decoder));
  }
  const foreign=await preparePlan({C1:[255,1,200],C2:[255,1,200]},request.plan),foreignResult=await evaluatePlanRequest(foreign.request);
  await assert.rejects(decodePlan(foreignResult,decoder));
  const forged=clone(result);forged.outputs=foreignResult.outputs;forged.outputSha256=await hashPlanOutput(forged.outputs);
  await assert.rejects(decodePlan(forged,decoder),/belong/);
  const differentType=clone(result);differentType.outputs[0].outputs=differentType.outputs[0].outputs.map(row=>Array(128).fill(row[0]));
  differentType.outputSha256=await hashPlanOutput(differentType.outputs);await assert.rejects(decodePlan(differentType,decoder),/type/);
  for(const mutate of [d=>{d.planSha256='00'.repeat(32);},d=>{d.tasks.reverse();},d=>{d.tasks[1].decoder.nonce=d.tasks[0].decoder.nonce;},
    d=>{d.tasks[0].decoder.outputPairs[0][1]=d.tasks[0].decoder.outputPairs[0][0];},d=>{d.tasks[0].decoder.recipe.steps[0].value=18;}]) {
    const d=clone(decoder);mutate(d);await assert.rejects(decodePlan(result,d));
  }
});

test('output schema rejects sparse/accessor/prototype/unknown-key structures before hashing or decoding',async()=> {
  const {result,decoder}=await twins();
  for(const outputs of [[],Array(1),[...clone(result.outputs),clone(result.outputs[0])],
    [{column:'C1',outputs:Array(3)}],[{column:'C1',outputs:[[1]]}],
    [{column:'C1',outputs:clone(result.outputs[0].outputs),plaintext:'secret'}],
    [{column:'C1',outputs:Array(3).fill(Array(9).fill('A'.repeat(24)))}]]) assert.throws(()=>canonicalPlanOutput(outputs));
  const outputs=clone(result.outputs);Object.defineProperty(outputs[0],'outputs',{enumerable:true,get(){assert.fail('must not invoke output getter');}});
  assert.throws(()=>canonicalPlanOutput(outputs));
  const r=clone(result);r.outputs[0].outputs[0]=Object.create(null,{length:{get(){assert.fail('must not invoke row length getter');}}});
  await assert.rejects(decodePlan(r,decoder));
  const sparse=clone(result);delete sparse.outputs[0].outputs[0][0];await assert.rejects(decodePlan(sparse,decoder));
});

async function http(body,options={}) {
  const req=Readable.from(options.chunks||[]);req.method=options.method||'POST';
  req.headers={host:'example.test',origin:'https://example.test','content-type':'application/json',...options.headers};
  if(body!==undefined)req.body=body;
  const headers={};let raw;
  const res={statusCode:0,setHeader(k,v){headers[k]=v;},end(v){raw=v;}};
  await handler(req,res);return {status:res.statusCode,headers,body:JSON.parse(raw)};
}
test('HTTP public catalogue and actual same-origin POST; transport bounds and generic errors',async()=> {
  const catalogue=await http(undefined,{method:'GET',headers:{origin:undefined}});
  assert.equal(catalogue.status,200);assert.equal(catalogue.body.profile,PROFILE);
  assert.equal(catalogue.body.limits.maxRequestBytes,MAX_PLAN_REQUEST_BYTES);
  assert.equal(catalogue.headers['X-Content-Type-Options'],'nosniff');
  const {request,decoder}=await twins(),raw=Buffer.from(JSON.stringify(request));
  for(const body of [request,raw,raw.toString()]) {
    const reply=await http(body);assert.equal(reply.status,200);assert.deepEqual(await decodePlan(reply.body,decoder),{C2:[17,10,100],C1:[17,10,100]});
  }
  assert.equal((await http(undefined,{chunks:[raw.subarray(0,100),raw.subarray(100)],headers:{'content-length':String(raw.length)}})).status,200);
  for(const [body,options,status] of [[request,{method:'DELETE'},405],[request,{headers:{origin:'https://attacker.test'}},403],
    [request,{headers:{origin:undefined}},403],[request,{headers:{'sec-fetch-site':'cross-site'}},403],
    [request,{headers:{'content-type':'text/plain'}},415],[request,{headers:{'content-encoding':'gzip'}},415],
    [request,{headers:{'content-length':String(MAX_REQUEST_BYTES)}},413],[raw,{headers:{'content-length':'1'}},400],
    ['{',{},400],[' '.repeat(MAX_REQUEST_BYTES),{},413],[undefined,{chunks:[Buffer.alloc(MAX_REQUEST_BYTES)]},413],
    [{...request,headers:['private']},{},400],[{...request,decoder},{},400]]) {
    const reply=await http(body,options);assert.equal(reply.status,status);assert.deepEqual(reply.body,{error:'Invalid request.'});assert.equal(reply.headers['Cache-Control'],'no-store');
  }
  const hooked={toJSON(){assert.fail('must not invoke JSON hook');}};assert.equal((await http(hooked)).status,400);
});

test('async operations snapshot validated request/result/decoder before awaiting hashes',async()=> {
  const job=await twins();
  const request=clone(job.request),evaluation=evaluatePlanRequest(request);request.plan.taskHash='00'.repeat(32);request.tasks.reverse();
  const result=await evaluation;assert.equal(result.inputSha256,job.result.inputSha256);
  const mutableResult=clone(result),decoder=clone(job.decoder),decoding=decodePlan(mutableResult,decoder);
  mutableResult.outputs.reverse();decoder.tasks.reverse();
  assert.deepEqual(await decoding,{C2:[17,10,100],C1:[17,10,100]});
  const values={C1:[255,1,200]},p=plan(step('C1',clone(fill))),preparation=preparePlan(values,p);
  values.C1.fill(99);p.steps[0].recipe.steps[0].value=7;
  const prepared=await preparation;
  assert.deepEqual(await decodePlan(await evaluatePlanRequest(prepared.request),prepared.decoder),{C1:[17,10,100]});
});
