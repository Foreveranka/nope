import test from 'node:test';
import assert from 'node:assert/strict';
import {Readable} from 'node:stream';
import {PROFILE,MAX_GATES,MAX_REQUEST_BYTES,compileRecipe,estimateRecipe,referenceApply,
  validateRecipeRequest,hashRecipeProgram,hashRecipeRequest,hashRecipeOutput,
  deriveRecipeGateKey,recipeGateContext,fromBase64,toBase64,cryptoProvider} from '../web/recipe-core.mjs';
import {prepareRecipe,decodeRecipe} from '../web/recipe-client.mjs';
import handler,{evaluateRecipeRequest} from '../api/recipe-gc.mjs';
import {createGarbledJob} from '../web/gc-client.mjs';
import v1Handler from '../api/csv-gc.mjs';
import {deriveGateKey} from '../web/gc-core.mjs';

const numeric = steps => ({type:'number',steps});
const text = (...ops) => ({type:'text',steps:ops.map(op=>({op}))});
const clone = value => JSON.parse(JSON.stringify(value));
const numRecipe = numeric([{op:'fill',value:17},{op:'clamp',min:10,max:100}]);
const tick = (s,i=0) => s.slice(0,i)+(s[i]==='A'?'B':'A')+s.slice(i+1);

// Independent Boolean interpreter checks the compiler without AES or decoder.
// In particular, it does not call the production gate truth function.
function clearCircuit(values,recipe) {
  const {circuit,inputBits}=compileRecipe(recipe);
  return values.map(value=> {
    const packed=recipe.type==='number'?[value]:Array.from({length:16},(_,i)=>i<value.length?value.charCodeAt(i)|128:0);
    const wires=packed.flatMap(n=>Array.from({length:8},(_,b)=>(n>>>b)&1));
    assert.equal(wires.length,inputBits);wires.push(0,1);
    for(const g of circuit.gates) {
      const a=wires[g.a],b=wires[g.b],c=wires[g.c];
      switch(g.op) {
        case 'AND': wires[g.out]=a&b;break;
        case 'OR': wires[g.out]=a|b;break;
        case 'XOR': wires[g.out]=a^b;break;
        case 'NOT': wires[g.out]=1-a;break;
        case 'COPY': wires[g.out]=a;break;
        case 'MUX': wires[g.out]=a===0?b:c;break;
        default:assert.fail('Unknown gate');
      }
    }
    const bytes=Array(circuit.outputs.length/8).fill(0);
    circuit.outputs.forEach((w,i)=>{bytes[i>>>3]|=wires[w]<<(i&7);});
    if(recipe.type==='number')return bytes[0];
    let result='',ended=false;
    for(const b of bytes) {
      if(b&128){assert.equal(ended,false,'contiguous private presence mask');result+=String.fromCharCode(b&127);}
      else{assert.equal(b,0,'zero padding');ended=true;}
    }
    return result;
  });
}
async function roundTrip(values,recipe) {
  const job=await prepareRecipe(values,recipe),result=await evaluateRecipeRequest(job.request);
  assert.deepEqual(await decodeRecipe(result,job.decoder),referenceApply(values,recipe));
  assert.equal(Buffer.byteLength(JSON.stringify(job.request)),estimateRecipe(recipe,values.length).serializedRequestBytes);
  return {...job,result};
}

test('strict public recipe allowlist, types, parameters, ordering, and row bounds',async()=> {
  for(const bad of [null,{}, {type:'text',steps:[]}, {type:'number',steps:[{op:'lowercase'}]},
    text('eval'),text('trim','lowercase','uppercase','trim','lowercase'),
    numeric([{op:'fill',value:255}]),numeric([{op:'fill',value:-1}]),numeric([{op:'fill',value:1.5}]),
    numeric([{op:'clamp',min:100,max:99}]),numeric([{op:'clamp',min:0,max:255}]),
    {type:'text',steps:[{op:'trim',code:'arbitrary'}]}, {...text('trim'),gates:[]}]) assert.throws(()=>compileRecipe(bad));
  for(const values of [[],Array(33).fill(1),[NaN],[null],['10'],[256],[-1],[1.2]]) await assert.rejects(prepareRecipe(values,numRecipe));
  for(const values of [Array(9).fill('a'),['a'.repeat(17)],['İ'],['é'],['😀'],[7]]) await assert.rejects(prepareRecipe(values,text('trim')));
  const fillThenClamp=numeric([{op:'fill',value:200},{op:'clamp',min:0,max:100}]);
  const clampThenFill=numeric([{op:'clamp',min:0,max:100},{op:'fill',value:200}]);
  assert.deepEqual(referenceApply([255],fillThenClamp),[100]);
  assert.deepEqual(referenceApply([255],clampThenFill),[200]);
  assert.deepEqual(clearCircuit([255],fillThenClamp),[100]);
  assert.deepEqual(clearCircuit([255],clampThenFill),[200]);
  assert.throws(()=>compileRecipe({type:'text',steps:Array(1)}));
  const accessorStep={};Object.defineProperty(accessorStep,'op',{enumerable:true,get(){assert.fail('must not invoke step getter');}});
  assert.throws(()=>compileRecipe({type:'text',steps:[accessorStep]}));
  const steps=[{op:'trim'}];steps.toJSON=()=>assert.fail('must not invoke steps hook');
  assert.throws(()=>compileRecipe({type:'text',steps}));
  await assert.rejects(prepareRecipe(Array(2),numRecipe));
});

test('deterministic topology, canonical program/hash and exact pre-garbling budgets',async()=> {
  const a=compileRecipe(numRecipe),b=compileRecipe({steps:[{value:17,op:'fill'},{max:100,op:'clamp',min:10}],type:'number'});
  assert.equal(a.canonicalProgram,b.canonicalProgram);assert.deepEqual(a.circuit,b.circuit);
  assert.ok(Object.isFrozen(a.circuit.gates));
  assert.notEqual(await hashRecipeProgram(numRecipe),await hashRecipeProgram(numeric([{op:'fill',value:18},{op:'clamp',min:10,max:100}])));
  assert.ok(estimateRecipe(text('trim'),8).gateCount<=MAX_GATES);
  assert.ok(estimateRecipe(text('trim'),8).serializedRequestBytes<MAX_REQUEST_BYTES);
  assert.throws(()=>estimateRecipe(text('trim','lowercase','redactDigits'),8),/budget/);
  assert.throws(()=>estimateRecipe(numRecipe,33));assert.throws(()=>estimateRecipe(text('trim'),9));
  await assert.rejects(prepareRecipe(Array(8).fill('secret'),text('trim','lowercase','redactDigits')),/budget/);
  for(const step of a.circuit.gates)assert.ok(step.a<step.out&&(step.b===undefined||step.b<step.out)&&(step.c===undefined||step.c<step.out));
  assert.equal(new Set(a.circuit.outputs).size,a.outputBits);
});

test('numeric compiler exhausts all 256 inputs over clamp boundaries and all fill values',()=> {
  const values=Array.from({length:256},(_,i)=>i);
  for(const min of [0,1,10,127,253,254])for(const max of [min,Math.max(min,100),254]) {
    const recipe=numeric([{op:'clamp',min,max}]);
    assert.deepEqual(clearCircuit(values,recipe),values.map(v=>v===255?255:Math.min(max,Math.max(min,v))));
  }
  for(let value=0;value<255;value++) {
    const recipe=numeric([{op:'fill',value},{op:'clamp',min:1,max:253}]);
    assert.deepEqual(clearCircuit(values,recipe),values.map(v=>Math.max(1,Math.min(253,v===255?value:v))));
  }
  const chained=numeric([{op:'clamp',min:20,max:200},{op:'fill',value:250},{op:'clamp',min:10,max:254},{op:'fill',value:0}]);
  assert.deepEqual(clearCircuit(values,chained),values.map(v=>v===255?250:Math.min(200,Math.max(20,v))));
});

test('actual garbled numeric evaluation exhausts all 256 byte inputs and missing-sentinel edge ranges',async()=> {
  for(let start=0;start<256;start+=32) await roundTrip(Array.from({length:32},(_,i)=>start+i),numRecipe);
  for(const recipe of [numeric([{op:'clamp',min:254,max:254}]),numeric([{op:'clamp',min:0,max:0},{op:'fill',value:254}]),
    numeric([{op:'fill',value:254},{op:'clamp',min:0,max:0}])]) await roundTrip([0,1,100,253,254,255],recipe);
});

test('ASCII compiler exhausts byte alphabet, trim lengths and short strings while preserving internal spaces/NUL',()=> {
  const alphabet=Array.from({length:128},(_,i)=>String.fromCharCode(i));
  for(const recipe of [text('lowercase'),text('uppercase'),text('redactDigits'),text('lowercase','uppercase','redactDigits')]) {
    assert.deepEqual(clearCircuit(alphabet,recipe),alphabet.map(s=> {
      for(const {op} of recipe.steps)s=op==='lowercase'?s.replace(/[A-Z]/g,c=>c.toLowerCase()):op==='uppercase'?s.replace(/[a-z]/g,c=>c.toUpperCase()):s.replace(/[0-9]/g,'*');
      return s;
    }));
  }
  const strings=['',' '.repeat(16),'\0',' \0 ',' A  B ','\t A \t'];
  for(let leading=0;leading<=16;leading++)for(let trailing=0;trailing<=16-leading;trailing++) {
    strings.push(' '.repeat(leading)+'X'.repeat(16-leading-trailing)+' '.repeat(trailing));
  }
  let layer=[''];
  for(let n=0;n<4;n++) {layer=layer.flatMap(s=>[' ','A','9','\0','\t'].map(c=>s+c));strings.push(...layer);}
  for(const recipe of [text('trim'),text('trim','lowercase','redactDigits'),text('uppercase','trim','lowercase','trim')]) {
    assert.deepEqual(clearCircuit(strings,recipe),strings.map(s=> {
      for(const {op} of recipe.steps)s=op==='trim'?s.replace(/^ +| +$/g,''):op==='lowercase'?s.replace(/[A-Z]/g,c=>c.toLowerCase()):op==='uppercase'?s.replace(/[a-z]/g,c=>c.toUpperCase()):s.replace(/[0-9]/g,'*');
      return s;
    }));
  }
});

test('actual text garbling covers all ASCII bytes with fixed hidden lengths and padding',async()=> {
  const ascii=Array.from({length:8},(_,r)=>Array.from({length:16},(_,i)=>String.fromCharCode(r*16+i)).join(''));
  for(const recipe of [text('lowercase'),text('uppercase'),text('redactDigits')]) await roundTrip(ascii,recipe);
  await roundTrip(['',' '.repeat(16),' A  B ','\0',' \0 ',' X'.padEnd(16),'\t A \t','0123456789ABCDEF'],text('trim'));
  await roundTrip([' ACME42  ',' BETA7 ','  A B 9 ','\0 Z9 '],text('trim','lowercase','redactDigits'));
});

test('privacy: public allowlisted envelope contains no plaintext, key, decoder or inactive label pairs',async()=> {
  const a=await prepareRecipe(['SECRET 913'],text('lowercase')),b=await prepareRecipe(['x'],text('lowercase'));
  assert.deepEqual(Object.keys(a.request).sort(),['nonce','profile','programSha256','recipe','rowCount','rows'].sort());
  assert.deepEqual(Object.keys(a.request.rows[0]).sort(),['inputs','tables']);
  assert.equal(JSON.stringify(a.request).length,JSON.stringify(b.request).length,'length independent of string value and private length');
  assert.notEqual(a.request.nonce,b.request.nonce);assert.notDeepEqual(a.request.rows,b.request.rows);
  const wire=JSON.stringify(a.request);
  assert.ok(!wire.includes('SECRET 913'));
  for(const forbidden of ['decoder','outputPairs','plaintext','secretKey','values'])assert.ok(!Object.hasOwn(a.request,forbidden));
  const transmitted=new Set(a.request.rows.flatMap(r=>r.inputs));
  for(const row of a.decoder.outputPairs)for(const pair of row)for(const label of pair)assert.equal(transmitted.has(label),false);
  assert.equal(a.request.rows[0].inputs.length,130);
  const ra=await evaluateRecipeRequest(a.request),rb=await evaluateRecipeRequest(b.request);
  assert.equal(ra.outputs[0].length,128);assert.equal(rb.outputs[0].length,128);
});

test('profile/program/nonce/row/gate and ordered labels separate garbling keys',async()=> {
  const hash=await hashRecipeProgram(numRecipe),nonce='01'.repeat(16),a=new Uint8Array(16).fill(3),b=new Uint8Array(16).fill(5),iv=new Uint8Array(12);
  const seal=async(key,aad=new Uint8Array())=>toBase64(new Uint8Array(await cryptoProvider().subtle.encrypt({name:'AES-GCM',iv,additionalData:aad},key,a)));
  const derive=(p,n,r,g,labels)=>deriveRecipeGateKey(p,n,r,g,labels);
  const contexts=[[hash,nonce,0,0,[a,b]],[hash,nonce,1,0,[a,b]],[hash,nonce,0,1,[a,b]],
    [hash,'02'.repeat(16),0,0,[a,b]],['00'.repeat(32),nonce,0,0,[a,b]],[hash,nonce,0,0,[b,a]],[hash,nonce,0,0,[a,a]],[hash,nonce,0,0,[a]]];
  const ciphertexts=await Promise.all(contexts.map(async c=>seal(await derive(...c))));
  assert.equal(new Set(ciphertexts).size,contexts.length);
  assert.notEqual(ciphertexts[0],await seal(await deriveGateKey(nonce,0,0,a,b)));
  assert.notDeepEqual(recipeGateContext(hash,nonce,0,0),recipeGateContext(hash,nonce,0,1));
});

test('tampered labels/tables, recipe/program, nonce, row and gate substitution are rejected',async()=> {
  const {request,decoder}=await prepareRecipe([255,101],numRecipe);
  const mutations=[r=>{r.profile='nope-csv-gc-v1';},r=>{r.recipe.steps[0].value=18;},r=>{r.programSha256='00'.repeat(32);},
    r=>{r.nonce='ff'.repeat(16);},r=>{r.rows.reverse();},r=>{r.rows[0].inputs[0]=tick(r.rows[0].inputs[0]);},
    r=>{[r.rows[0].tables[0],r.rows[0].tables[1]]=[r.rows[0].tables[1],r.rows[0].tables[0]];},
    r=>{r.rows[0].tables[0]=r.rows[0].tables[0].map(e=>tick(e,20));},
    r=>{r.rows[0].decoder=[];},r=>{r.rows[0].inputs.push(r.rows[0].inputs[0]);},r=>{r.rows[0].tables[0].push('A'.repeat(60));}];
  for(const mutate of mutations){const r=clone(request);mutate(r);await assert.rejects(evaluateRecipeRequest(r));}
  // Even an unused-entry change is caught by the local transcript commitment.
  const compiled=compileRecipe(numRecipe),g=compiled.circuit.gates[0],row=request.rows[0];
  const labels=[g.a,g.b,g.c].filter(w=>w!==undefined).map(w=>fromBase64(row.inputs[w]));
  const selected=labels.reduce((n,l)=>n*2+(l[15]&1),0),unused=selected^1;
  const modified=clone(request);modified.rows[0].tables[0][unused]=tick(modified.rows[0].tables[0][unused],20);
  const origResult=await evaluateRecipeRequest(request),modifiedResult=await evaluateRecipeRequest(modified);
  assert.deepEqual(origResult.outputs,modifiedResult.outputs);assert.notEqual(origResult.inputSha256,modifiedResult.inputSha256);
  await assert.rejects(decodeRecipe(modifiedResult,decoder),/binding/);
});

test('decoder verifies all context/hash fields and per-row/per-wire label membership',async()=> {
  const job=await roundTrip([255,200],numRecipe),result=job.result;
  for(const field of ['inputSha256','programSha256','outputSha256']) {
    const r=clone(result);r[field]='00'.repeat(32);await assert.rejects(decodeRecipe(r,job.decoder));
  }
  for(const mutate of [r=>{r.nonce='00'.repeat(16);},r=>{r.profile='wrong';},r=>{r.rowCount=1;},r=>{r.extra=true;},r=>{r.outputs[0].pop();}]) {
    const r=clone(result);mutate(r);await assert.rejects(decodeRecipe(r,job.decoder));
  }
  for(const mutate of [r=>{r.outputs.reverse();},r=>{r.outputs[0].reverse();},r=>{r.outputs[0][0]=tick(r.outputs[0][0]);}]) {
    const r=clone(result);mutate(r);r.outputSha256=await hashRecipeOutput(r.outputs);await assert.rejects(decodeRecipe(r,job.decoder),/belong/);
  }
  const foreign=await roundTrip([255,200],numRecipe);await assert.rejects(decodeRecipe(foreign.result,job.decoder));
  const broken=clone(job.decoder);broken.outputPairs[0][1]=broken.outputPairs[0][0];await assert.rejects(decodeRecipe(result,broken),/Duplicate/);
});

async function http(body,options={}) {
  const req=Readable.from(options.chunks||[]);
  req.method=options.method||'POST';req.headers={host:'example.test',origin:'https://example.test','content-type':'application/json',...options.headers};
  if(body!==undefined)req.body=body;
  const headers={};let response;
  const res={statusCode:0,setHeader:(k,v)=>{headers[k]=v;},end:b=>{response=b;}};
  await (options.handler||handler)(req,res);
  return {status:res.statusCode,headers,body:JSON.parse(response)};
}
test('HTTP public catalogue; same-origin POST; bounded parsed/string/stream bodies and generic errors',async()=> {
  const catalogue=await http(undefined,{method:'GET',headers:{origin:undefined}});
  assert.equal(catalogue.status,200);assert.equal(catalogue.body.profile,PROFILE);assert.equal(catalogue.body.limits.maxGates,10000);
  const job=await prepareRecipe([255,200],numRecipe);
  for(const body of [job.request,JSON.stringify(job.request),Buffer.from(JSON.stringify(job.request))]) {
    const reply=await http(body);assert.equal(reply.status,200);assert.deepEqual(await decodeRecipe(reply.body,job.decoder),[17,100]);
  }
  const raw=Buffer.from(JSON.stringify(job.request)),streamed=await http(undefined,{chunks:[raw.subarray(0,10),raw.subarray(10)],headers:{'content-length':String(raw.length)}});
  assert.equal(streamed.status,200);
  for(const [body,opts,status] of [
    [job.request,{method:'PUT'},405],[job.request,{headers:{origin:'https://attacker.test'}},403],
    [job.request,{headers:{'sec-fetch-site':'cross-site'}},403],[job.request,{headers:{origin:undefined}},403],
    [job.request,{headers:{'content-type':'text/plain'}},415],[job.request,{headers:{'content-encoding':'gzip'}},415],
    [job.request,{headers:{'content-length':String(MAX_REQUEST_BYTES)}},413],[job.request,{headers:{'content-length':'-1'}},400],
    ['{',{},400],[raw,{headers:{'content-length':'1'}},400],[' '.repeat(MAX_REQUEST_BYTES),{},413],
    [undefined,{chunks:[Buffer.alloc(MAX_REQUEST_BYTES)]},413],[{...job.request,decoder:job.decoder},{},400]]) {
    const reply=await http(body,opts);assert.equal(reply.status,status);assert.deepEqual(reply.body,{error:'Invalid request.'});assert.equal(reply.headers['Cache-Control'],'no-store');
  }
  const hooked={toJSON(){assert.fail('must not invoke toJSON');}};assert.equal((await http(hooked)).status,400);
  const accessor={};Object.defineProperty(accessor,'value',{enumerable:true,get(){assert.fail('must not invoke accessor');}});assert.equal((await http(accessor)).status,400);
  const cyclic={};cyclic.self=cyclic;assert.equal((await http(cyclic)).status,400);
});

test('legacy v1 remains compatible and cannot be confused with recipe v2',async()=> {
  const v1=await createGarbledJob([255,101,7]),reply=await http(v1.request,{handler:v1Handler});
  assert.equal(reply.status,200);assert.deepEqual(v1.decode(reply.body.outputs),[0,100,7]);
  assert.throws(()=>validateRecipeRequest(v1.request));
  const v2=await prepareRecipe([255,101,7],numRecipe);assert.equal((await http(v2.request,{handler:v1Handler})).status,400);
});
