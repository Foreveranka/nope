import {compile_program,createFileManager} from '@noir-lang/noir_wasm';
import {Noir} from '@noir-lang/noir_js';
import {Barretenberg,BackendType,UltraHonkBackend} from '@aztec-foundation/bb.js';
import fs from 'node:fs/promises';
const {program}=await compile_program(createFileManager(new URL('./circuits/smoke',import.meta.url).pathname));
console.log('COMPILED',program.noir_version,program.bytecode.length);
await fs.writeFile(new URL('./artifacts/smoke.json',import.meta.url),JSON.stringify(program));
const api=await Barretenberg.new({backend:BackendType.Wasm,threads:1,crsPath:new URL('./.cache/crs',import.meta.url).pathname});
const nbytes=n=>Uint8Array.from(BigInt(n).toString(16).padStart(64,'0').match(/../g),x=>parseInt(x,16));
try {
 const {hash}=await api.poseidon2Hash({inputs:[1,0,0,0].map(nbytes)});
 const y=BigInt('0x'+Buffer.from(hash).toString('hex')).toString();
 const {witness}=await new Noir(program).execute({x:'1',y});
 const backend=new UltraHonkBackend(program.bytecode,api);
 const proof=await backend.generateProof(witness,{verifierTarget:'noir-recursive'});
 console.log('REAL_PROOF',proof.proof.length,proof.publicInputs.length,await backend.verifyProof(proof,{verifierTarget:'noir-recursive'}));
} finally {await api.destroy();}
