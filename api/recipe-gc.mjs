/** Stateless bounded recipe evaluator. No decoder, secret keys or CSV plaintext. */
import {PROFILE,ENTRY_BYTES,MAX_REQUEST_BYTES,RECIPE_CATALOGUE,compileRecipe,
  validateRecipeRequest,hashRecipeProgram,hashRecipeRequest,hashRecipeOutput,
  fromBase64,toBase64,cryptoProvider,gateArity,recipeGateContext,deriveRecipeGateKey} from '../web/recipe-core.mjs';
export {compileRecipe,validateRecipeRequest,hashRecipeProgram,hashRecipeRequest,hashRecipeOutput};
export async function evaluateRecipeRequest(request) {
  // Snapshot before the first await; the evaluator and commitments use identical data.
  validateRecipeRequest(request);
  request=JSON.parse(JSON.stringify(request));
  const compiled=validateRecipeRequest(request),programSha256=await hashRecipeProgram(compiled.recipe);
  if(request.programSha256!==programSha256) throw new Error('Recipe program hash mismatch.');
  const inputSha256=await hashRecipeRequest(request),outputs=[],crypto=cryptoProvider();
  for(let r=0;r<request.rowCount;r++) {
    const row=request.rows[r],wires=row.inputs.map(l=>fromBase64(l));
    for(const [g,gate] of compiled.circuit.gates.entries()) {
      const labels=[gate.a,gate.b,gate.c].slice(0,gateArity(gate)).map(w=>wires[w]);
      const select=labels.reduce((n,l)=>n*2+(l[15]&1),0),entry=fromBase64(row.tables[g][select],ENTRY_BYTES);
      const key=await deriveRecipeGateKey(programSha256,request.nonce,r,g,labels);
      const label=new Uint8Array(await crypto.subtle.decrypt({name:'AES-GCM',iv:entry.subarray(0,12),additionalData:recipeGateContext(programSha256,request.nonce,r,g),tagLength:128},key,entry.subarray(12)));
      if(label.length!==16) throw new Error('Invalid evaluated label.');
      wires[gate.out]=label;
    }
    outputs.push(compiled.circuit.outputs.map(w=>toBase64(wires[w])));
  }
  return {profile:PROFILE,nonce:request.nonce,rowCount:request.rowCount,outputs,inputSha256,programSha256,outputSha256:await hashRecipeOutput(outputs)};
}
const invalid = status => {throw Object.assign(new Error('Invalid request.'),{status});};
function boundedJson(value) {
  let budget=MAX_REQUEST_BYTES;const seen=new WeakSet();
  const spend=n=>{budget-=n;if(budget<=0)invalid(413);};
  const visit=(v,depth)=> {
    if(depth>16)invalid(400);
    if(v===null){spend(4);return;}
    if(typeof v==='string'){if(v.length>=MAX_REQUEST_BYTES)invalid(413);spend(Buffer.byteLength(JSON.stringify(v)));return;}
    if(typeof v==='number'&&Number.isFinite(v)){spend(String(v).length);return;}
    if(typeof v==='boolean'){spend(5);return;}
    if(!v||typeof v!=='object'||seen.has(v))invalid(400);
    const array=Array.isArray(v);
    if(Object.getPrototypeOf(v)!==(array?Array.prototype:Object.prototype)&&!(Object.getPrototypeOf(v)===null&&!array))invalid(400);
    seen.add(v);spend(2);let count=0;
    for(const key of Reflect.ownKeys(v)) {
      if(array&&key==='length')continue;
      if(typeof key!=='string'||(array&&String(count)!==key))invalid(400);
      const d=Object.getOwnPropertyDescriptor(v,key);
      if(!d.enumerable||!Object.hasOwn(d,'value'))invalid(400);
      if(count++)spend(1);
      if(!array)spend(Buffer.byteLength(JSON.stringify(key))+1);
      visit(d.value,depth+1);
    }
    if(array&&count!==v.length)invalid(400);
    seen.delete(v);
  };visit(value,0);return Buffer.from(JSON.stringify(value));
}
async function readBody(req) {
  const length=req.headers?.['content-length'];
  if(length!==undefined&&(typeof length!=='string'||!/^(0|[1-9][0-9]*)$/.test(length)))invalid(400);
  if(length!==undefined&&(!Number.isSafeInteger(Number(length))||Number(length)>=MAX_REQUEST_BYTES))invalid(413);
  if(req.headers?.['content-encoding']!==undefined&&req.headers['content-encoding']!=='identity')invalid(415);
  let bytes;
  if(req.body!==undefined) {
    if(Buffer.isBuffer(req.body))bytes=req.body;
    else if(typeof req.body==='string'){if(Buffer.byteLength(req.body)>=MAX_REQUEST_BYTES)invalid(413);bytes=Buffer.from(req.body);}
    else bytes=boundedJson(req.body);
  } else {
    const chunks=[];let size=0;
    for await(const chunk of req) {
      if(typeof chunk!=='string'&&!Buffer.isBuffer(chunk)&&!(chunk instanceof Uint8Array))invalid(400);
      const part=Buffer.from(chunk);size+=part.length;if(size>=MAX_REQUEST_BYTES)invalid(413);chunks.push(part);
    }
    bytes=Buffer.concat(chunks,size);
  }
  if(bytes.length>=MAX_REQUEST_BYTES)invalid(413);
  if(length!==undefined&&(req.body===undefined||typeof req.body==='string'||Buffer.isBuffer(req.body))&&Number(length)!==bytes.length)invalid(400);
  try{return JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes));}catch{invalid(400);}
}
function origin(req) {
  const {host,origin}=req.headers||{};
  if(typeof host!=='string'||typeof origin!=='string')invalid(403);
  try{const u=new URL(origin);if(!['http:','https:'].includes(u.protocol)||u.origin!==origin||u.host!==host||req.headers['sec-fetch-site']==='cross-site')invalid(403);}catch{invalid(403);}
}
export default async function handler(req,res) {
  res.setHeader('Cache-Control','no-store');res.setHeader('Content-Type','application/json; charset=utf-8');res.setHeader('X-Content-Type-Options','nosniff');
  try {
    if(req.method==='GET'){res.statusCode=200;res.end(JSON.stringify(RECIPE_CATALOGUE));return;}
    if(req.method!=='POST'){res.setHeader('Allow','GET, POST');invalid(405);}
    origin(req);
    if(!/^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(req.headers?.['content-type']||''))invalid(415);
    const result=await evaluateRecipeRequest(await readBody(req));res.statusCode=200;res.end(JSON.stringify(result));
  } catch(error) {
    res.statusCode=[400,403,405,413,415].includes(error?.status)?error.status:400;
    res.end(JSON.stringify({error:'Invalid request.'}));
  }
}
