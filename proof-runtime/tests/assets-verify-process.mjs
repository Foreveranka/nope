import fs from 'node:fs';
import fsp from 'node:fs/promises';
import assert from 'node:assert/strict';
const read=fsp.readFile.bind(fsp),readSync=fs.readFileSync.bind(fs),seen=new Set();
function checked(path){const s=String(path);if(s.includes('/.cache/'))throw new Error('Cache read forbidden: '+s);if(s.includes('/assets/')&&s.endsWith('.dat'))seen.add(s.split('/').pop());return path;}
fsp.readFile=(path,...args)=>read(checked(path),...args);
fs.readFileSync=(path,...args)=>readSync(checked(path),...args);
globalThis.fetch=()=>{throw new Error('Runtime network forbidden');};
const {createProofRuntime}=await import('../sdk.mjs');
const runtime=await createProofRuntime();
try{for(const type of ['number','text']){const publicOnly=JSON.parse(await read(new URL('../runtime/'+type+'-public.json',import.meta.url)));assert.equal(await runtime.verifyRow(publicOnly),true);}
assert.deepEqual([...seen].sort(),['bn254_g1.dat','bn254_g2.dat','grumpkin_g1_v2.flat.dat']);console.log('VERIFIED assets-only number,text');}
finally{await runtime.dispose();}
