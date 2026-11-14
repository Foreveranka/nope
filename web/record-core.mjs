/** Fixed record-v5 DSL and Boolean compiler. Public plans/topology; private u32
 * inputs. Assumes an honest local garbler and semi-honest evaluator. Transcript
 * hashes are commitments, not execution/provenance proofs. No caller circuits. */
import {cryptoProvider,fromBase64,toBase64,nonceBytes as parseNonce,sha256} from './gc-core.mjs';
import {exactKeys,denseArray,gateArity,gateTruth} from './recipe-core.mjs';
export {cryptoProvider,fromBase64,toBase64,exactKeys,denseArray,gateArity,gateTruth};
export const PROFILE='nope-record-rules-gc-v5';
export const MAX_ROWS=16,MAX_GATES=10000,MAX_REQUEST_BYTES=3*1024*1024-16*1024;
export const INPUT_BITS=256,INPUT_COUNT=258,OUTPUT_BITS=128,ENTRY_BYTES=44;
export const U32_MAX=0xffffffff;
const encoder=new TextEncoder(),columns=new Set(Array.from({length:16},(_,i)=>`C${i+1}`));
const operations=new Set(['addSat','subSat','min','max','eq','lte','and','select','mul16']);
const check=(ok,message)=>{if(!ok)throw new Error(message);};
export const validHash=v=>typeof v==='string'&&v.length===64&&/^[0-9a-f]{64}$/.test(v);
export function nonceBytes(v){check(typeof v==='string'&&v.length===32,'Invalid record nonce.');return parseNonce(v);}
const u32=n=>Number.isInteger(n)&&n>=0&&n<=U32_MAX&&!Object.is(n,-0);
export function freezeRecordData(v){if(v&&typeof v==='object'){Object.values(v).forEach(freezeRecordData);Object.freeze(v);}return v;}
function boundedArray(v,min,max){check(Array.isArray(v)&&v.length>=min&&v.length<=max,'Invalid bounded record array.');denseArray(v,v.length);}
export function normalizeRecordPlan(value){
 exactKeys(value,['version','taskHash','inputs','constants','steps','outputs']);
 check(value.version===1&&validHash(value.taskHash),'Invalid record plan version/task hash.');
 boundedArray(value.inputs,1,8);boundedArray(value.constants,0,4);boundedArray(value.steps,1,8);boundedArray(value.outputs,1,4);
 check(value.inputs.every(v=>columns.has(v))&&new Set(value.inputs).size===value.inputs.length,'Expected unique C1..C16 inputs.');
 check(value.constants.every(u32),'Expected u32 constants.');
 const ref=(n,i)=>u32(n)&&(n<value.inputs.length||(n>=8&&n<8+value.constants.length)||(n>=12&&n<12+i));
 const steps=value.steps.map((s,i)=>{
  exactKeys(s,['op','a','b','c']);
  check(operations.has(s.op)&&ref(s.a,i)&&ref(s.b,i),'Invalid record operation or forward/inactive reference.');
  check(s.op==='select'?ref(s.c,i):s.c===0&&!Object.is(s.c,-0),'Invalid record c reference/padding.');
  return {op:s.op,a:s.a,b:s.b,c:s.c};
 });
 check(value.outputs.every(n=>ref(n,steps.length)),'Invalid record output reference.');
 return freezeRecordData({version:1,taskHash:value.taskHash,inputs:[...value.inputs],constants:[...value.constants],steps,outputs:[...value.outputs]});
}
export const canonicalRecordPlan=plan=>JSON.stringify(normalizeRecordPlan(plan));
export const hashRecordPlan=plan=>sha256(PROFILE+'/plan/'+canonicalRecordPlan(plan));
/** A single record is a dense vector ordered by plan.inputs. All multiplication
 * range checks run even for dead steps, before garbling/randomness/crypto. */
export function referenceRecord(values,plan){
 plan=normalizeRecordPlan(plan);denseArray(values,plan.inputs.length);check(values.every(u32),'Expected unsigned u32 record fields.');
 const registers=Array(20).fill(0);values.forEach((x,i)=>registers[i]=x);plan.constants.forEach((x,i)=>registers[8+i]=x);
 plan.steps.forEach((s,i)=>{
  const a=registers[s.a],b=registers[s.b];let result;
  switch(s.op){
   case 'addSat':result=Math.min(U32_MAX,a+b);break;
   case 'subSat':result=Math.max(0,a-b);break;
   case 'min':result=Math.min(a,b);break;
   case 'max':result=Math.max(a,b);break;
   case 'eq':result=Number(a===b);break;
   case 'lte':result=Number(a<=b);break;
   case 'and':result=Number(a!==0&&b!==0);break;
   case 'select':result=a!==0?b:registers[s.c];break;
   case 'mul16':check(a<=65535&&b<=65535,'mul16 operands must be <=65535.');result=a*b;break;
  }
  registers[12+i]=result;
 });
 return Array.from({length:4},(_,i)=>i<plan.outputs.length?registers[plan.outputs[i]]:0);
}
/** LSB-first ripple arithmetic, public constant folding and memoization only.
 * MUX means selector ? c : b, matching the existing AES-GCM gate machinery. */
export function compileRecordPlan(value){
 const plan=normalizeRecordPlan(value),zero=256,one=257,gates=[],memo=new Map();let next=INPUT_COUNT;
 const gate=(op,a,b,c)=>{
  if(op==='NOT'){
   if(a===zero)return one;if(a===one)return zero;
   const prior=gates[a-INPUT_COUNT];if(prior?.op==='NOT')return prior.a;
  }
  if(['AND','OR','XOR'].includes(op)){
   if(a>b)[a,b]=[b,a];
   if(a===b)return op==='XOR'?zero:a;
   if(op==='AND'&&(a===zero||b===zero))return zero;
   if(op==='AND'&&(a===one||b===one))return a===one?b:a;
   if(op==='OR'&&(a===one||b===one))return one;
   if(op==='OR'&&(a===zero||b===zero))return a===zero?b:a;
   if(op==='XOR'&&(a===zero||b===zero))return a===zero?b:a;
   if(op==='XOR'&&(a===one||b===one))return gate('NOT',a===one?b:a);
  }
  if(op==='MUX'){
   if(b===c)return b;if(a===zero||a===one)return a===zero?b:c;
   if(b===zero&&c===one)return a;if(b===one&&c===zero)return gate('NOT',a);
   if(b===zero)return gate('AND',a,c);if(c===zero)return gate('AND',gate('NOT',a),b);
   if(b===one)return gate('OR',gate('NOT',a),c);if(c===one)return gate('OR',a,b);
  }
  const key=`${op}:${a}:${b}:${c}`;if(op!=='COPY'&&memo.has(key))return memo.get(key);
  const out=next++;gates.push({op,a,...(b===undefined?{}:{b}),...(c===undefined?{}:{c}),out});
  check(gates.length<=MAX_GATES,'Record exceeds 10000 gate budget.');if(op!=='COPY')memo.set(key,out);return out;
 };
 const not=a=>gate('NOT',a),and=(a,b)=>gate('AND',a,b),or=(a,b)=>gate('OR',a,b),xor=(a,b)=>gate('XOR',a,b);
 const mux=(s,f,t)=>gate('MUX',s,f,t),constant=n=>Array.from({length:32},(_,i)=>(n>>>i)&1?one:zero);
 const boolWord=bit=>[bit,...Array(31).fill(zero)],nonzero=a=>a.reduce(or,zero);
 const equal=(a,b)=>not(a.reduce((diff,w,i)=>or(diff,xor(w,b[i])),zero));
 const less=(a,b)=>{let lt=zero;for(let i=0;i<32;i++)lt=mux(xor(a[i],b[i]),lt,b[i]);return lt;};
 const add=(a,b)=>{
  let carry=zero;const bits=a.map((w,i)=>{const p=xor(w,b[i]),sum=xor(p,carry);carry=or(and(w,b[i]),and(p,carry));return sum;});
  return {bits,carry};
 };
 const registers=Array.from({length:20},()=>constant(0));
 for(let i=0;i<plan.inputs.length;i++)registers[i]=Array.from({length:32},(_,b)=>i*32+b);
 plan.constants.forEach((x,i)=>registers[8+i]=constant(x));
 plan.steps.forEach((s,i)=>{
  const a=registers[s.a],b=registers[s.b];let bits;
  switch(s.op){
   case 'addSat':{const sum=add(a,b);bits=sum.bits.map(w=>or(w,sum.carry));break;}
   case 'subSat':{
    let borrow=zero;bits=a.map((w,j)=>{const p=xor(w,b[j]),diff=xor(p,borrow);borrow=or(and(not(w),b[j]),and(not(p),borrow));return diff;});
    bits=bits.map(w=>and(w,not(borrow)));break;
   }
   case 'min':{const lt=less(a,b);bits=a.map((w,j)=>mux(lt,b[j],w));break;}
   case 'max':{const lt=less(a,b);bits=a.map((w,j)=>mux(lt,w,b[j]));break;}
   case 'eq':bits=boolWord(equal(a,b));break;
   case 'lte':bits=boolWord(not(less(b,a)));break;
   case 'and':bits=boolWord(and(nonzero(a),nonzero(b)));break;
   case 'select':{const select=nonzero(a),c=registers[s.c];bits=b.map((w,j)=>mux(select,c[j],w));break;}
   case 'mul16':{
    // Defined only on <=16-bit operands: local reference enforces this before
    // garbling; the separate proof relation must also assert both ranges.
    bits=constant(0);
    for(let k=0;k<16;k++)bits=add(bits,Array.from({length:32},(_,j)=>j>=k&&j<k+16?and(a[j-k],b[k]):zero)).bits;
    break;
   }
  }
  registers[12+i]=bits;
 });
 // Dedicated fresh wires, including all zero padding, prevent mapping aliases.
 const outputs=Array.from({length:4},(_,i)=>i<plan.outputs.length?registers[plan.outputs[i]]:constant(0)).flat().map(w=>gate('COPY',w));
 const circuit={inputs:Array.from({length:INPUT_COUNT},(_,i)=>i),gates,outputs,wireCount:next};
 return freezeRecordData({profile:PROFILE,plan,circuit,canonicalProgram:JSON.stringify({profile:PROFILE,plan,circuit}),inputBits:INPUT_BITS,inputCount:INPUT_COUNT,outputBits:OUTPUT_BITS,gatesPerRow:gates.length,gateCount:gates.length,maxRows:MAX_ROWS});
}
export function estimateRecordPlan(plan,rowCount){
 const compiled=compileRecordPlan(plan);check(Number.isInteger(rowCount)&&rowCount>=1&&rowCount<=MAX_ROWS,'Expected 1..16 record rows.');
 const gateCount=compiled.gatesPerRow*rowCount;check(gateCount<=MAX_GATES,'Records exceed 10000 total gate budget.');
 const rowBytes=JSON.stringify({inputs:Array(INPUT_COUNT).fill('A'.repeat(24)),tables:compiled.circuit.gates.map(g=>Array(2**gateArity(g)).fill('A'.repeat(60)))}).length;
 const baseBytes=JSON.stringify({profile:PROFILE,plan:compiled.plan,planSha256:'0'.repeat(64),programSha256:'0'.repeat(64),nonce:'0'.repeat(32),rowCount,rows:[]}).length;
 const serializedRequestBytes=baseBytes+rowCount*rowBytes+rowCount-1;
 check(serializedRequestBytes<MAX_REQUEST_BYTES,'Records exceed request byte budget.');
 return {rowCount,gatesPerRow:compiled.gatesPerRow,gateCount,serializedRequestBytes,maxRows:MAX_ROWS,maxGates:MAX_GATES,maxRequestBytes:MAX_REQUEST_BYTES,inputBits:INPUT_BITS,inputCount:INPUT_COUNT,outputBits:OUTPUT_BITS};
}
export function validateRecordRequest(request){
 exactKeys(request,['profile','plan','planSha256','programSha256','nonce','rowCount','rows']);
 check(request.profile===PROFILE&&validHash(request.planSha256)&&validHash(request.programSha256),'Invalid record request profile/hash.');nonceBytes(request.nonce);
 const compiled=compileRecordPlan(request.plan);estimateRecordPlan(compiled.plan,request.rowCount);denseArray(request.rows,request.rowCount);
 for(const row of request.rows){
  exactKeys(row,['inputs','tables']);denseArray(row.inputs,INPUT_COUNT);denseArray(row.tables,compiled.gatesPerRow);
  row.inputs.forEach(l=>fromBase64(l));
  row.tables.forEach((table,i)=>{denseArray(table,2**gateArity(compiled.circuit.gates[i]));table.forEach(e=>fromBase64(e,ENTRY_BYTES));});
 }
 return compiled;
}
export function canonicalRecordRequest(request){
 const compiled=validateRecordRequest(request);
 return JSON.stringify({profile:PROFILE,plan:compiled.plan,planSha256:request.planSha256,programSha256:request.programSha256,nonce:request.nonce,rowCount:request.rowCount,rows:request.rows.map(r=>({inputs:r.inputs,tables:r.tables}))});
}
export const hashRecordRequest=request=>sha256(canonicalRecordRequest(request));
export const hashRecordProgram=plan=>sha256(compileRecordPlan(plan).canonicalProgram);
export function validateRecordOutputs(outputs,rowCount){
 check(Number.isInteger(rowCount)&&rowCount>=1&&rowCount<=MAX_ROWS,'Invalid record output row count.');denseArray(outputs,rowCount);
 outputs.forEach(row=>{denseArray(row,OUTPUT_BITS);row.forEach(l=>fromBase64(l));});return outputs;
}
export const hashRecordOutput=outputs=>{validateRecordOutputs(outputs,outputs?.length);return sha256(JSON.stringify({profile:PROFILE,outputs}));};
export function validateRecordResult(result,request){
 exactKeys(result,['profile','nonce','rowCount','outputs','inputSha256','programSha256','outputSha256']);
 check(result.profile===PROFILE&&['inputSha256','programSha256','outputSha256'].every(k=>validHash(result[k])),'Invalid record result profile/hash.');nonceBytes(result.nonce);
 validateRecordOutputs(result.outputs,result.rowCount);
 if(request){validateRecordRequest(request);check(result.nonce===request.nonce&&result.rowCount===request.rowCount&&result.programSha256===request.programSha256,'Record result context mismatch.');}
 return result;
}
export function recordGateContext(programSha256,nonce,row,gate){
 check(validHash(programSha256)&&Number.isInteger(row)&&row>=0&&row<MAX_ROWS&&Number.isInteger(gate)&&gate>=0&&gate<MAX_GATES,'Invalid record gate context.');
 const domain=encoder.encode(`${PROFILE}/garble/${programSha256}/`),salt=nonceBytes(nonce),out=new Uint8Array(domain.length+24);out.set(domain);out.set(salt,domain.length);
 const view=new DataView(out.buffer);view.setUint32(domain.length+16,row,false);view.setUint32(domain.length+20,gate,false);return out;
}
export async function deriveRecordGateKey(programSha256,nonce,row,gate,labels){
 const context=recordGateContext(programSha256,nonce,row,gate);boundedArray(labels,1,3);
 check(labels.every(l=>l instanceof Uint8Array&&l.length===16),'Invalid record key labels.');
 const material=new Uint8Array(context.length+1+labels.length*16);material.set(context);material[context.length]=labels.length;labels.forEach((l,i)=>material.set(l,context.length+1+i*16));
 const crypto=cryptoProvider(),digest=await crypto.subtle.digest('SHA-256',material);return crypto.subtle.importKey('raw',digest,{name:'AES-GCM'},false,['encrypt','decrypt']);
}
