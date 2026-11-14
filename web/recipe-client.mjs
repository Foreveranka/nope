import {PROFILE,ENTRY_BYTES,compileRecipe,estimateRecipe,encodeRecipeValues,cryptoProvider,
  fromBase64,toBase64,gateArity,gateTruth,recipeGateContext,deriveRecipeGateKey,
  hashRecipeProgram,hashRecipeRequest,hashRecipeOutput,validateRecipeOutputs,exactKeys,denseArray,validHash,nonceBytes} from './recipe-core.mjs';
function pair(crypto) {
  const a=crypto.getRandomValues(new Uint8Array(16)),b=crypto.getRandomValues(new Uint8Array(16));
  b[15]=(b[15]&254)|((a[15]&1)^1);return [a,b];
}
const perm = label => label[15]&1;
function freeze(v) {if(v&&typeof v==='object'){Object.values(v).forEach(freeze);Object.freeze(v);}return v;}
/** Only request crosses the network. Decoder contains output mappings and must
 * stay in the browser (or authenticated encrypted local storage), never a worker.
 */
export async function prepareRecipe(values,recipe) {
  const compiled=compileRecipe(recipe),encoded=encodeRecipeValues(values,compiled.recipe);
  estimateRecipe(compiled.recipe,encoded.length);
  const crypto=cryptoProvider(),nonce=Array.from(crypto.getRandomValues(new Uint8Array(16)),b=>b.toString(16).padStart(2,'0')).join('');
  const programSha256=await hashRecipeProgram(compiled.recipe),rows=[],outputPairs=[];
  for(let r=0;r<encoded.length;r++) {
    const pairs=Array.from({length:compiled.circuit.wireCount},()=>pair(crypto)),tables=[];
    for(const [g,gate] of compiled.circuit.gates.entries()) {
      const arity=gateArity(gate),table=new Array(2**arity),wires=[gate.a,gate.b,gate.c].slice(0,arity);
      await Promise.all(Array.from({length:table.length},async(_,truth)=> {
        const bits=Array.from({length:arity},(_,i)=>(truth>>>(arity-1-i))&1),labels=wires.map((w,i)=>pairs[w][bits[i]]);
        const key=await deriveRecipeGateKey(programSha256,nonce,r,g,labels),iv=crypto.getRandomValues(new Uint8Array(12));
        const sealed=new Uint8Array(await crypto.subtle.encrypt({name:'AES-GCM',iv,additionalData:recipeGateContext(programSha256,nonce,r,g),tagLength:128},key,pairs[gate.out][gateTruth(gate.op,...bits)]));
        const entry=new Uint8Array(ENTRY_BYTES);entry.set(iv);entry.set(sealed,12);
        table[labels.reduce((n,l)=>n*2+perm(l),0)]=toBase64(entry);
      }));
      tables.push(table);
    }
    const bits=encoded[r].flatMap(n=>Array.from({length:8},(_,i)=>(n>>>i)&1));
    bits.push(0,1);
    rows.push({inputs:compiled.circuit.inputs.map((w,i)=>toBase64(pairs[w][bits[i]])),tables});
    outputPairs.push(compiled.circuit.outputs.map(w=>pairs[w].map(toBase64)));
  }
  const request=freeze({profile:PROFILE,recipe:compiled.recipe,programSha256,nonce,rowCount:encoded.length,rows});
  const decoder=freeze({profile:PROFILE,recipe:compiled.recipe,nonce,rowCount:encoded.length,inputSha256:await hashRecipeRequest(request),programSha256,outputPairs});
  return {request,decoder};
}
/** Transcript commitments and per-wire membership checks are not execution
 * proofs. The caller can additionally compare against referenceApply locally.
 */
export async function decodeRecipe(result,decoder) {
  exactKeys(decoder,['profile','recipe','nonce','rowCount','inputSha256','programSha256','outputPairs']);
  const compiled=compileRecipe(decoder.recipe);estimateRecipe(compiled.recipe,decoder.rowCount);nonceBytes(decoder.nonce);
  if(decoder.profile!==PROFILE||!validHash(decoder.inputSha256)||decoder.programSha256!==await hashRecipeProgram(compiled.recipe)) throw new Error('Invalid decoder binding.');
  exactKeys(result,['profile','nonce','rowCount','outputs','inputSha256','programSha256','outputSha256']);
  if(result.profile!==PROFILE||result.nonce!==decoder.nonce||result.rowCount!==decoder.rowCount||result.inputSha256!==decoder.inputSha256||result.programSha256!==decoder.programSha256) throw new Error('Recipe result request/program binding mismatch.');
  validateRecipeOutputs(result.outputs,decoder.rowCount,compiled.outputBits);
  if(result.outputSha256!==await hashRecipeOutput(result.outputs)) throw new Error('Recipe output hash mismatch.');
  denseArray(decoder.outputPairs,decoder.rowCount);
  const seen=new Set();
  for(const row of decoder.outputPairs) {
    denseArray(row,compiled.outputBits);
    for(const p of row) {
      denseArray(p,2);
      const labels=p.map(l=>fromBase64(l));
      if(perm(labels[0])===perm(labels[1])) throw new Error('Invalid decoder permutation.');
      for(const l of p){if(seen.has(l))throw new Error('Duplicate decoder label.');seen.add(l);}
    }
  }
  return result.outputs.map((row,r)=> {
    const bytes=Array(compiled.outputBits/8).fill(0);
    row.forEach((label,i)=> {
      const bit=decoder.outputPairs[r][i].indexOf(label);
      if(bit<0) throw new Error('Output label does not belong to this job and wire.');
      bytes[i>>>3]|=bit<<(i&7);
    });
    if(compiled.recipe.type==='number') return bytes[0];
    let text='',ended=false;
    for(const b of bytes) {
      if(b&128) {if(ended)throw new Error('Invalid output padding.');text+=String.fromCharCode(b&127);}
      else {if(b!==0)throw new Error('Invalid output padding.');ended=true;}
    }
    return text;
  });
}
