/** Only request is publishable. Decoder/witness and both alternatives of any
 * wire remain buyer-local, including during proof generation. */
import {PROFILE,INPUT_COUNT,OUTPUT_BITS,ENTRY_BYTES,compileRecordPlan,estimateRecordPlan,referenceRecord,normalizeRecordPlan,
 exactKeys,denseArray,cryptoProvider,fromBase64,toBase64,gateArity,gateTruth,recordGateContext,deriveRecordGateKey,
 hashRecordPlan,hashRecordProgram,hashRecordRequest,hashRecordOutput,validateRecordResult,freezeRecordData,validHash,nonceBytes} from './record-core.mjs';
const check=(ok,message)=>{if(!ok)throw new Error(message);};
const perm=label=>label[15]&1;
function pair(crypto){const a=crypto.getRandomValues(new Uint8Array(16)),b=crypto.getRandomValues(new Uint8Array(16));b[15]=(b[15]&254)|((a[15]&1)^1);return [a,b];}
export async function prepareRecord(records,plan,options={capture:false}){
 exactKeys(options,['capture']);check(typeof options.capture==='boolean','Invalid record capture option.');const capture=options.capture;
 plan=normalizeRecordPlan(plan);const compiled=compileRecordPlan(plan);
 check(Array.isArray(records),'Expected record vectors.');estimateRecordPlan(plan,records.length);denseArray(records,records.length);
 // Every value and every intermediate mul16 range is validated before any
 // randomness, async operation or table allocation. Snapshot before awaiting.
 const values=records.map(row=>{referenceRecord(row,plan);return [...row];});
 const crypto=cryptoProvider(),nonce=Array.from(crypto.getRandomValues(new Uint8Array(16)),b=>b.toString(16).padStart(2,'0')).join('');
 const [planSha256,programSha256]=await Promise.all([hashRecordPlan(plan),hashRecordProgram(plan)]),rows=[],outputPairs=[],inputPairs=[],inputBits=[];
 for(let r=0;r<values.length;r++){
  const pairs=Array.from({length:compiled.circuit.wireCount},()=>pair(crypto)),tables=[];
  for(const [g,gate]of compiled.circuit.gates.entries()){
   const arity=gateArity(gate),table=new Array(2**arity),wires=[gate.a,gate.b,gate.c].slice(0,arity);
   await Promise.all(Array.from({length:table.length},async(_,truth)=>{
    const bits=Array.from({length:arity},(_,i)=>(truth>>>(arity-1-i))&1),labels=wires.map((w,i)=>pairs[w][bits[i]]);
    const key=await deriveRecordGateKey(programSha256,nonce,r,g,labels),iv=crypto.getRandomValues(new Uint8Array(12));
    const sealed=new Uint8Array(await crypto.subtle.encrypt({name:'AES-GCM',iv,additionalData:recordGateContext(programSha256,nonce,r,g),tagLength:128},key,pairs[gate.out][gateTruth(gate.op,...bits)]));
    const entry=new Uint8Array(ENTRY_BYTES);entry.set(iv);entry.set(sealed,12);table[labels.reduce((n,l)=>n*2+perm(l),0)]=toBase64(entry);
   }));tables.push(table);
  }
  const padded=Array.from({length:8},(_,i)=>values[r][i]??0),bits=padded.flatMap(n=>Array.from({length:32},(_,i)=>(n>>>i)&1));bits.push(0,1);
  check(bits.length===INPUT_COUNT,'Internal record input width mismatch.');
  if(capture){inputPairs.push(compiled.circuit.inputs.map(w=>pairs[w].map(toBase64)));inputBits.push([...bits]);}
  rows.push({inputs:compiled.circuit.inputs.map((w,i)=>toBase64(pairs[w][bits[i]])),tables});outputPairs.push(compiled.circuit.outputs.map(w=>pairs[w].map(toBase64)));
 }
 const request=freezeRecordData({profile:PROFILE,plan,planSha256,programSha256,nonce,rowCount:values.length,rows});
 const decoder=freezeRecordData({profile:PROFILE,plan,planSha256,nonce,rowCount:values.length,inputSha256:await hashRecordRequest(request),programSha256,outputPairs});
 return capture?{request,decoder,witness:freezeRecordData({inputPairs,outputPairs,inputBits})}:{request,decoder};
}
/** Validates transcript bindings and output-label membership, not provenance.
 * Results are snapshotted before awaits to avoid mutation of checked data. */
export async function decodeRecord(result,decoder){
 exactKeys(decoder,['profile','plan','planSha256','nonce','rowCount','inputSha256','programSha256','outputPairs']);
 const plan=normalizeRecordPlan(decoder.plan);estimateRecordPlan(plan,decoder.rowCount);nonceBytes(decoder.nonce);
 check(decoder.profile===PROFILE&&validHash(decoder.planSha256)&&validHash(decoder.inputSha256)&&validHash(decoder.programSha256),'Invalid record decoder binding.');
 validateRecordResult(result);denseArray(decoder.outputPairs,decoder.rowCount);const seen=new Set();
 for(const row of decoder.outputPairs){
  denseArray(row,OUTPUT_BITS);for(const p of row){denseArray(p,2);const labels=p.map(l=>fromBase64(l));check(perm(labels[0])!==perm(labels[1]),'Invalid decoder permutation.');
   for(const l of p){check(!seen.has(l),'Duplicate decoder label.');seen.add(l);}
  }
 }
 result=JSON.parse(JSON.stringify(result));decoder=JSON.parse(JSON.stringify(decoder));
 const [planHash,programHash,outputHash]=await Promise.all([hashRecordPlan(plan),hashRecordProgram(plan),hashRecordOutput(result.outputs)]);
 check(decoder.planSha256===planHash&&decoder.programSha256===programHash,'Record decoder plan/program mismatch.');
 check(result.nonce===decoder.nonce&&result.rowCount===decoder.rowCount&&result.inputSha256===decoder.inputSha256&&result.programSha256===decoder.programSha256,'Record result request/program binding mismatch.');
 check(result.outputSha256===outputHash,'Record output hash mismatch.');
 return result.outputs.map((row,r)=>{
  const words=Array(4).fill(0);row.forEach((label,i)=>{const bit=decoder.outputPairs[r][i].indexOf(label);check(bit>=0,'Output label does not belong to this job and wire.');words[i>>>5]+=bit*2**(i&31);});
  check(words.slice(plan.outputs.length).every(n=>n===0),'Invalid nonzero record output padding.');return words.slice(0,plan.outputs.length);
 });
}
