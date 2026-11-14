/** Separate v5 artifact policy; never rewrite historical v4 policy or VKs. */
import fs from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {Barretenberg,BackendType,UltraHonkBackend} from '@aztec-foundation/bb.js';
import {APPROVED as prior} from './approved.mjs';
const sha=b=>createHash('sha256').update(b).digest('hex');
const bytes=await fs.readFile(new URL('./artifacts/record.json',import.meta.url)),program=JSON.parse(bytes);
const api=await Barretenberg.new({backend:BackendType.Wasm,threads:1,skipSrsInit:true});
try {
 const read=async k=>new Uint8Array(await fs.readFile(new URL(prior.srs[k].path,import.meta.url)));
 await api.srsInitSrs({pointsBuf:await read('g1'),numPoints:prior.srs.numPoints,g2Point:await read('g2')});
 await api.srsInitGrumpkinSrs({pointsBuf:await read('grumpkin'),numPoints:65536});
 const backend=new UltraHonkBackend(program.bytecode,api),vk=await backend.getVerificationKey({verifierTarget:'noir-recursive'});
 const sizes=await api.acirGetCircuitSizes(backend.acirUncompressedBytecode,true,true);
 if(sizes[1]>prior.srs.numPoints)throw Error('Record circuit exceeds pinned SRS');
 await fs.writeFile(new URL('./artifacts/record.vk',import.meta.url),vk);
 const manifest={...prior,scheme:'nope-record-noir-poseidon2-v1',circuits:{record:{circuitPath:'./artifacts/record.json',circuitSha256:sha(bytes),vkPath:'./artifacts/record.vk',vkSha256:sha(vk),vkBytes:vk.length,proofBytes:14656,gates:sizes[0],dyadic:sizes[1]}}};
 await fs.writeFile(new URL('./record-approved.mjs',import.meta.url),'// Reviewed record-only artifact pins; historical v4 pins remain separate.\nexport const APPROVED='+JSON.stringify(manifest,null,2)+';\n');
 const policy={id:manifest.scheme,relationVersion:1,noir:manifest.noir,barretenberg:manifest.barretenberg,verifierTarget:manifest.verifierTarget,rootEncoding:'poseidon2-bn254-hash4-fold-v1',srs:manifest.srs,circuits:{record:{circuitSha256:sha(bytes),verificationKeySha256:sha(vk)}}};
 const canonical=x=>Array.isArray(x)?'['+x.map(canonical).join(',')+']':x&&typeof x==='object'?'{'+Object.keys(x).sort().map(k=>JSON.stringify(k)+':'+canonical(x[k])).join(',')+'}':JSON.stringify(x);
 await fs.writeFile(new URL('./record-policy.mjs',import.meta.url),'const freeze=x=>{if(x&&typeof x===\'object\'){Object.values(x).forEach(freeze);Object.freeze(x);}return x;};\nexport const proofPolicy=freeze('+JSON.stringify(policy,null,2)+');\nexport const policyHash='+JSON.stringify(sha(canonical(policy)))+';\nexport const proofPolicyHash=policyHash;\n');
 console.log(JSON.stringify(manifest.circuits.record));
} finally {await api.destroy();}
