import fs from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {Barretenberg,BackendType,UltraHonkBackend} from '@aztec-foundation/bb.js';
const sha=b=>createHash('sha256').update(b).digest('hex');
import {APPROVED} from './approved.mjs';
import {prepareCrs} from './prepare-crs.mjs';
await prepareCrs();
const api=await Barretenberg.new({backend:BackendType.Wasm,threads:1,skipSrsInit:true});
const readSrs=async key=>new Uint8Array(await fs.readFile(new URL(APPROVED.srs[key].path,import.meta.url)));
await api.srsInitSrs({pointsBuf:await readSrs('g1'),numPoints:APPROVED.srs.numPoints,g2Point:await readSrs('g2')});
await api.srsInitGrumpkinSrs({pointsBuf:await readSrs('grumpkin'),numPoints:65536});
const manifest={scheme:'nope-result-noir-poseidon2-v1',noir:'1.0.0',barretenberg:'6.0.0',verifierTarget:'noir-recursive',circuits:{}};
try{for(const type of ['number','text']){const bytes=await fs.readFile(new URL(`./artifacts/${type}.json`,import.meta.url));const program=JSON.parse(bytes);const b=new UltraHonkBackend(program.bytecode,api);const start=performance.now();const vk=await b.getVerificationKey({verifierTarget:'noir-recursive'});await fs.writeFile(new URL(`./artifacts/${type}.vk`,import.meta.url),vk);const sizes=await api.acirGetCircuitSizes(b.acirUncompressedBytecode,true,true);manifest.circuits[type]={circuitPath:`./artifacts/${type}.json`,circuitSha256:sha(bytes),vkPath:`./artifacts/${type}.vk`,vkSha256:sha(vk),vkBytes:vk.length,proofBytes:14656,gates:sizes[0],dyadic:sizes[1]};console.log(type,manifest.circuits[type],Math.round(performance.now()-start));}
manifest.srs={numPoints:524288};for(const [key,file]of [['g1','bn254_g1.dat'],['g2','bn254_g2.dat'],['grumpkin','grumpkin_g1_v2.flat.dat']]){const bytes=await fs.readFile(new URL('./assets/'+file,import.meta.url));manifest.srs[key]={path:'./assets/'+file,sha256:sha(bytes),bytes:bytes.length};}
await fs.writeFile(new URL('./artifacts/approved-manifest.json',import.meta.url),JSON.stringify(manifest,null,2)+'\n');await fs.writeFile(new URL('./approved.mjs',import.meta.url),'// Generated from reviewed compiled circuits; verifier never accepts a caller VK.\nexport const APPROVED='+JSON.stringify(manifest,null,2)+';\n');}finally{await api.destroy();}
