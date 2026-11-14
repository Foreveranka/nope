/** Bounded, public recipes; honest browser/garbler and semi-honest evaluator.
 * This is not malicious-client security or a proof of correct execution.
 * Recipe, row count and topology are public. Values and output mappings stay local.
 * Text is full ASCII (including NUL), encoded as 16 tagged, padded bytes. The high
 * bit privately marks presence; no plaintext length or padding mask is transmitted.
 */
import {cryptoProvider, fromBase64, toBase64, nonceBytes, sha256} from './gc-core.mjs';
export {cryptoProvider, fromBase64, toBase64, nonceBytes};
export const PROFILE = 'nope-csv-recipe-gc-v2';
export const MAX_TEXT_BYTES = 16;
export const MAX_TEXT_ROWS = 8;
export const MAX_NUMBER_ROWS = 32;
export const MAX_GATES = 10000;
export const MAX_REQUEST_BYTES = 3 * 1024 * 1024;
export const ENTRY_BYTES = 44;
const encoder = new TextEncoder();
const fail = message => { throw new Error(message); };
export function exactKeys(value, keys) {
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
      ![Object.prototype, null].includes(Object.getPrototypeOf(value)) ||
      Reflect.ownKeys(value).length !== keys.length || keys.some(k => {
        const d = Object.getOwnPropertyDescriptor(value,k);
        return !d || !d.enumerable || !Object.hasOwn(d,'value');
      })) fail('Unexpected recipe protocol fields.');
}
// Reject sparse arrays, accessors and custom properties before reading elements.
// This also makes direct JS callers obey the same data-only contract as JSON.
export function denseArray(value,length) {
  if(!Array.isArray(value)||Object.getPrototypeOf(value)!==Array.prototype||
      !Number.isSafeInteger(length)||length<0||value.length!==length||
      Reflect.ownKeys(value).length!==length+1) fail('Expected a dense recipe array.');
  for(let i=0;i<length;i++) {
    const d=Object.getOwnPropertyDescriptor(value,String(i));
    if(!d||!d.enumerable||!Object.hasOwn(d,'value')) fail('Expected data-only recipe array elements.');
  }
  return value;
}
const byte = n => Number.isInteger(n) && n >= 0 && n <= 254;
function normalizeRecipe(recipe) {
  exactKeys(recipe,['type','steps']);
  if (!['number','text'].includes(recipe.type) || !Array.isArray(recipe.steps) || recipe.steps.length < 1 || recipe.steps.length > 4) fail('Expected a typed recipe with 1–4 steps.');
  denseArray(recipe.steps,recipe.steps.length);
  const steps = Array.from(recipe.steps,step => {
    if (!step || typeof step !== 'object') fail('Invalid recipe step.');
    const descriptor=Object.getOwnPropertyDescriptor(step,'op');
    if(!descriptor?.enumerable||!Object.hasOwn(descriptor,'value')) fail('Invalid recipe operation.');
    const op=descriptor.value;
    if (recipe.type === 'number' && op === 'fill') {
      exactKeys(step,['op','value']);
      if (!byte(step.value)) fail('Fill must be an integer in 0..254.');
      return {op:'fill',value:step.value};
    }
    if (recipe.type === 'number' && op === 'clamp') {
      exactKeys(step,['op','min','max']);
      if (!byte(step.min) || !byte(step.max) || step.min > step.max) fail('Invalid clamp range 0..254.');
      return {op:'clamp',min:step.min,max:step.max};
    }
    if (recipe.type === 'text' && ['trim','lowercase','uppercase','redactDigits'].includes(op)) {
      exactKeys(step,['op']); return {op};
    }
    fail('Operation is not allowed for this recipe type.');
  });
  return {type:recipe.type,steps};
}
function freeze(value) {
  if (value && typeof value === 'object') { Object.values(value).forEach(freeze); Object.freeze(value); }
  return value;
}
/** Gates are emitted solely here, never accepted from a caller. Constant folding
 * and common-subexpression sharing depend on public recipe data only. MUX is an
 * ordinary 3-input/8-entry garbled gate, not free-XOR or an evaluator shortcut.
 */
export function compileRecipe(recipe) {
  recipe = normalizeRecipe(recipe);
  const inputBits = recipe.type === 'number' ? 8 : 128;
  const zero = inputBits, one = inputBits + 1, inputCount = inputBits + 2;
  const gates = [], memo = new Map(); let next = inputCount;
  const gate = (op,a,b,c) => {
    if (op === 'NOT') {
      if (a === zero) return one;
      if (a === one) return zero;
      const prior = gates[a-inputCount];
      if (prior?.op === 'NOT') return prior.a;
    }
    if (['AND','OR','XOR'].includes(op)) {
      if (a > b) [a,b] = [b,a];
      if (a === b) return op === 'XOR' ? zero : a;
      if (op === 'AND' && (a === zero || b === zero)) return zero;
      if (op === 'AND' && (a === one || b === one)) return a === one ? b : a;
      if (op === 'OR' && (a === one || b === one)) return one;
      if (op === 'OR' && (a === zero || b === zero)) return a === zero ? b : a;
      if (op === 'XOR' && (a === zero || b === zero)) return a === zero ? b : a;
      if (op === 'XOR' && (a === one || b === one)) return gate('NOT',a === one ? b : a);
    }
    if (op === 'MUX') {
      if (b === c) return b;
      if (a === zero || a === one) return a === zero ? b : c;
      if (b === zero && c === one) return a;
      if (b === one && c === zero) return gate('NOT',a);
      if (b === zero) return gate('AND',a,c);
      if (c === zero) return gate('AND',gate('NOT',a),b);
      if (b === one) return gate('OR',gate('NOT',a),c);
      if (c === one) return gate('OR',a,b);
    }
    const key = `${op}:${a}:${b}:${c}`;
    if (op !== 'COPY' && memo.has(key)) return memo.get(key);
    const out = next++;
    gates.push({op,a,...(b === undefined ? {} : {b}),...(c === undefined ? {} : {c}),out});
    if (gates.length > MAX_GATES) fail('Recipe exceeds the gate budget.');
    if (op !== 'COPY') memo.set(key,out);
    return out;
  };
  const not = a => gate('NOT',a), and = (a,b) => gate('AND',a,b), or = (a,b) => gate('OR',a,b);
  const xor = (a,b) => gate('XOR',a,b), mux = (s,a,b) => gate('MUX',s,a,b);
  const constant = (n,width=8) => Array.from({length:width},(_,i) => (n >>> i)&1 ? one : zero);
  const eq = (bits,n) => bits.reduce((v,w,i) => and(v,(n >>> i)&1 ? w : not(w)),one);
  const lt = (bits,n) => {
    let equal = one, less = zero;
    for (let i=bits.length-1;i>=0;i--) {
      if ((n >>> i)&1) less = or(less,and(equal,not(bits[i])));
      equal = and(equal,(n >>> i)&1 ? bits[i] : not(bits[i]));
    }
    return less;
  };
  let outputs;
  if (recipe.type === 'number') {
    let bits = Array.from({length:8},(_,i)=>i);
    for (const step of recipe.steps) {
      const missing = eq(bits,255);
      if (step.op === 'fill') bits = bits.map((w,i)=>mux(missing,w,constant(step.value)[i]));
      else {
        const low = lt(bits,step.min), high = not(lt(bits,step.max+1));
        const min = constant(step.min), max = constant(step.max);
        bits = bits.map((w,i)=>mux(missing,mux(high,mux(low,w,min[i]),max[i]),w));
      }
    }
    outputs = bits;
  } else {
    let chars = Array.from({length:16},(_,i)=>Array.from({length:8},(_,b)=>i*8+b));
    for (const step of recipe.steps) {
      if (step.op === 'trim') {
        const spaces = chars.map(ch=>and(ch[7],eq(ch.slice(0,7),32)));
        let seen = zero;
        // Remove trailing ASCII spaces and clear every absent byte.
        const trimmed = new Array(16);
        for (let i=15;i>=0;i--) {
          seen = or(seen,and(chars[i][7],not(spaces[i])));
          const keep = and(chars[i][7],seen);
          trimmed[i] = [...chars[i].slice(0,7).map(w=>and(keep,w)),keep];
        }
        let prefix = one;
        const leading = spaces.map(space => (prefix = and(prefix,space)));
        // Prefix sums modulo16 yield the barrel-shift bits. All-16-space rows
        // have already become zeros, so their shift modulo16 is harmless.
        const shift = [0,1,2,3].map(k=> {
          let bit = zero;
          for (let j=(1<<k)-1;j<16;j+=(1<<k)) bit=xor(bit,leading[j]);
          return bit;
        });
        chars = trimmed;
        for (let k=0;k<4;k++) {
          const prior = chars, distance = 1<<k;
          chars = prior.map((ch,i)=>ch.map((w,b)=>mux(shift[k],w,i+distance<16 ? prior[i+distance][b] : zero)));
        }
      } else {
        chars = chars.map(ch=> {
          const bits = ch.slice(0,7);
          const from = step.op === 'lowercase' ? 65 : step.op === 'uppercase' ? 97 : 48;
          const end = step.op === 'lowercase' ? 91 : step.op === 'uppercase' ? 123 : 58;
          const match = and(ch[7],and(not(lt(bits,from)),lt(bits,end)));
          if (step.op === 'redactDigits') return [...bits.map((w,i)=>mux(match,w,constant(42,7)[i])),ch[7]];
          const out = bits.slice(); out[5] = step.op === 'lowercase' ? or(out[5],match) : and(out[5],not(match));
          return [...out,ch[7]];
        });
      }
    }
    outputs = chars.flat();
  }
  // Dedicated output wires prevent aliases exposing decoding pairs for inputs
  // or making swaps between output positions pass membership checks.
  outputs = outputs.map(w=>gate('COPY',w));
  const circuit = {inputs:Array.from({length:inputCount},(_,i)=>i),gates,outputs,wireCount:next};
  const canonicalProgram = JSON.stringify({profile:PROFILE,recipe,circuit});
  return freeze({profile:PROFILE,recipe,circuit,canonicalProgram,inputBits,inputCount,
    outputBits:outputs.length,gatesPerRow:gates.length,gateCount:gates.length,
    maxRows:recipe.type === 'number' ? MAX_NUMBER_ROWS : MAX_TEXT_ROWS});
}
/** Exact serialized size: every label is canonical base64(16)=24 chars; every
 * entry is canonical base64(44)=60 chars. No cryptography needed for preflight.
 */
export function estimateRecipe(recipe,rowCount) {
  const compiled = compileRecipe(recipe);
  if (!Number.isInteger(rowCount) || rowCount < 1 || rowCount > compiled.maxRows) fail(`Expected 1–${compiled.maxRows} rows.`);
  const gateCount = compiled.gatesPerRow * rowCount;
  if (gateCount > MAX_GATES) fail('Recipe and row count exceed the 10000 gate budget.');
  const rowBytes = JSON.stringify({inputs:Array(compiled.inputCount).fill('A'.repeat(24)),
    tables:compiled.circuit.gates.map(g=>Array(gateArity(g)===1 ? 2 : gateArity(g)===2 ? 4 : 8).fill('A'.repeat(60)))}).length;
  const baseBytes = JSON.stringify({profile:PROFILE,recipe:compiled.recipe,programSha256:'0'.repeat(64),nonce:'0'.repeat(32),rowCount,rows:[]}).length;
  const serializedRequestBytes = baseBytes + rowCount*rowBytes + rowCount-1;
  if (serializedRequestBytes >= MAX_REQUEST_BYTES) fail('Recipe and row count exceed the 3 MiB request budget.');
  return {rowCount,gatesPerRow:compiled.gatesPerRow,gateCount,serializedRequestBytes,
    maxRows:compiled.maxRows,inputBits:compiled.inputBits,outputBits:compiled.outputBits};
}
export function encodeRecipeValues(values,recipe) {
  const compiled = compileRecipe(recipe);
  estimateRecipe(compiled.recipe,values?.length);
  denseArray(values,values.length);
  return Array.from(values,value=> {
    if (compiled.recipe.type === 'number') {
      if (!Number.isInteger(value) || value<0 || value>255) fail('Expected integer byte values 0..255 (255 is missing).');
      return [value];
    }
    if (typeof value !== 'string' || value.length>16 || /[^\x00-\x7f]/.test(value)) fail('Expected ASCII text of at most 16 bytes; no truncation.');
    return Array.from({length:16},(_,i)=>i<value.length ? value.charCodeAt(i)|128 : 0);
  });
}
export function referenceApply(values,recipe) {
  recipe=normalizeRecipe(recipe); encodeRecipeValues(values,recipe);
  return values.map(value=> {
    for (const step of recipe.steps) {
      if (step.op==='fill') { if(value===255) value=step.value; }
      else if(step.op==='clamp') { if(value!==255) value=Math.min(step.max,Math.max(step.min,value)); }
      else if(step.op==='trim') value=value.replace(/^ +| +$/g,'');
      else if(step.op==='lowercase') value=value.replace(/[A-Z]/g,c=>c.toLowerCase());
      else if(step.op==='uppercase') value=value.replace(/[a-z]/g,c=>c.toUpperCase());
      else value=value.replace(/[0-9]/g,'*');
    }
    return value;
  });
}
export const gateArity = g => g.op==='NOT' || g.op==='COPY' ? 1 : g.op==='MUX' ? 3 : 2;
export function gateTruth(op,a,b,c) {
  if(op==='NOT') return a^1;
  if(op==='COPY') return a;
  if(op==='AND') return a&b;
  if(op==='OR') return a|b;
  if(op==='XOR') return a^b;
  if(op==='MUX') return a ? c : b;
  fail('Unknown recipe gate.');
}
const hashPattern = /^[0-9a-f]{64}$/;
export function validHash(value) { return typeof value==='string' && hashPattern.test(value); }
export function recipeGateContext(programSha256,nonce,row,gate) {
  if(!validHash(programSha256) || !Number.isInteger(row) || row<0 || row>=32 || !Number.isInteger(gate) || gate<0 || gate>=MAX_GATES) fail('Invalid recipe gate context.');
  const domain=encoder.encode(`${PROFILE}/garble/${programSha256}/`), salt=nonceBytes(nonce);
  const out=new Uint8Array(domain.length+24);out.set(domain);out.set(salt,domain.length);
  const v=new DataView(out.buffer);v.setUint32(domain.length+16,row,false);v.setUint32(domain.length+20,gate,false);
  return out;
}
/** Profile/program/nonce/row/gate and ordered label concatenation bind keys and
 * AAD. No v1 key derivation is reused, including for identical wire coordinates.
 */
export async function deriveRecipeGateKey(programSha256,nonce,row,gate,labels) {
  const context=recipeGateContext(programSha256,nonce,row,gate);
  if(!Array.isArray(labels) || labels.length<1 || labels.length>3 || labels.some(l=>!(l instanceof Uint8Array)||l.length!==16)) fail('Invalid recipe key labels.');
  const material=new Uint8Array(context.length+1+labels.length*16);material.set(context);material[context.length]=labels.length;
  labels.forEach((label,i)=>material.set(label,context.length+1+i*16));
  const crypto=cryptoProvider(),digest=await crypto.subtle.digest('SHA-256',material);
  return crypto.subtle.importKey('raw',digest,{name:'AES-GCM'},false,['encrypt','decrypt']);
}
export function validateRecipeRequest(request) {
  exactKeys(request,['profile','recipe','programSha256','nonce','rowCount','rows']);
  if(request.profile!==PROFILE || !validHash(request.programSha256)) fail('Unsupported recipe profile or program hash.');
  nonceBytes(request.nonce);
  const compiled=compileRecipe(request.recipe);estimateRecipe(compiled.recipe,request.rowCount);
  denseArray(request.rows,request.rowCount);
  for(const row of request.rows) {
    exactKeys(row,['inputs','tables']);
    denseArray(row.inputs,compiled.inputCount);denseArray(row.tables,compiled.gatesPerRow);
    for(const label of row.inputs) fromBase64(label);
    for(let i=0;i<row.tables.length;i++) {
      const table=row.tables[i];
      denseArray(table,2**gateArity(compiled.circuit.gates[i]));
      for(const entry of table) fromBase64(entry,ENTRY_BYTES);
    }
  }
  return compiled;
}
export function canonicalRecipeRequest(request) {
  const compiled=validateRecipeRequest(request);
  return JSON.stringify({profile:PROFILE,recipe:compiled.recipe,programSha256:request.programSha256,nonce:request.nonce,rowCount:request.rowCount,
    rows:request.rows.map(row=>({inputs:row.inputs,tables:row.tables}))});
}
export function validateRecipeOutputs(outputs,rowCount,outputBits) {
  denseArray(outputs,rowCount);
  for(const row of outputs) {
    denseArray(row,outputBits);
    for(const label of row) fromBase64(label);
  }
}
export const hashRecipeProgram = recipe => sha256(compileRecipe(recipe).canonicalProgram);
export const hashRecipeRequest = request => sha256(canonicalRecipeRequest(request));
export const hashRecipeOutput = outputs => sha256(JSON.stringify(outputs));
export const RECIPE_CATALOGUE = freeze({profile:PROFILE,version:2,securityModel:'honest browser garbler; semi-honest evaluator; no execution proof',
  limits:{maxSteps:4,maxNumberRows:32,maxTextRows:8,maxTextBytes:16,maxGates:MAX_GATES,maxRequestBytes:MAX_REQUEST_BYTES},
  number:{input:'integer 0..255; 255 is missing',operations:[{op:'fill',value:'integer 0..254'},{op:'clamp',min:'integer 0..254',max:'integer min..254'}],missing:'clamp preserves 255 until fill'},
  text:{input:'ASCII, at most 16 bytes, fixed encrypted padding',operations:[{op:'trim'},{op:'lowercase'},{op:'uppercase'},{op:'redactDigits'}],whitespace:'trim ASCII space only; internal spaces preserved'},
  order:'Steps execute in supplied order. 1..4 type-specific allowlisted steps; no code or caller-supplied gates.',
  disclosure:'Public recipe, row count and topology; no plaintext, key, decoder or unused input labels.'});
