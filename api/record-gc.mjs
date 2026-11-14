/** Pure record-v5 evaluator. No HTTP handler, plaintext, decoder, witness, or
 * caller-supplied circuit. Reconstructs the fixed compiler from the public DSL. */
import {PROFILE,ENTRY_BYTES,validateRecordRequest,canonicalRecordRequest,hashRecordPlan,hashRecordProgram,hashRecordRequest,hashRecordOutput,
 cryptoProvider,fromBase64,toBase64,gateArity,recordGateContext,deriveRecordGateKey} from '../web/record-core.mjs';
export async function evaluateRecordRequest(value){
 // Canonicalization validates data-only objects and snapshots before any await.
 const request=JSON.parse(canonicalRecordRequest(value)),compiled=validateRecordRequest(request);
 const [planSha256,programSha256]=await Promise.all([hashRecordPlan(compiled.plan),hashRecordProgram(compiled.plan)]);
 if(request.planSha256!==planSha256||request.programSha256!==programSha256)throw new Error('Record plan/program hash mismatch.');
 const inputSha256=await hashRecordRequest(request),outputs=[],crypto=cryptoProvider();
 for(let r=0;r<request.rowCount;r++){
  const row=request.rows[r],wires=row.inputs.map(l=>fromBase64(l));
  for(const [g,gate]of compiled.circuit.gates.entries()){
   const labels=[gate.a,gate.b,gate.c].slice(0,gateArity(gate)).map(w=>wires[w]),select=labels.reduce((n,l)=>n*2+(l[15]&1),0);
   const entry=fromBase64(row.tables[g][select],ENTRY_BYTES),key=await deriveRecordGateKey(programSha256,request.nonce,r,g,labels);
   const label=new Uint8Array(await crypto.subtle.decrypt({name:'AES-GCM',iv:entry.subarray(0,12),additionalData:recordGateContext(programSha256,request.nonce,r,g),tagLength:128},key,entry.subarray(12)));
   if(label.length!==16)throw new Error('Invalid record evaluated label.');wires[gate.out]=label;
  }
  outputs.push(compiled.circuit.outputs.map(w=>toBase64(wires[w])));
 }
 return {profile:PROFILE,nonce:request.nonce,rowCount:request.rowCount,outputs,inputSha256,programSha256,outputSha256:await hashRecordOutput(outputs)};
}

// This Vercel route is deliberately closed. Evaluation is authorized through
// the selected-provider /api/workspace lifecycle, not a public compute endpoint.
export default function handler(_req,res){
 res.setHeader('Cache-Control','no-store');res.setHeader('Content-Type','application/json; charset=utf-8');res.setHeader('X-Content-Type-Options','nosniff');
 res.statusCode=404;res.end(JSON.stringify({error:'Not found.'}));
}
