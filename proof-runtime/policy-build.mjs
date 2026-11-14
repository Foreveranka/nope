import fs from 'node:fs/promises';import {createHash}from'node:crypto';
const a=JSON.parse(await fs.readFile(new URL('./artifacts/approved-manifest.json',import.meta.url)));
const proofPolicy={id:a.scheme,relationVersion:1,noir:a.noir,barretenberg:a.barretenberg,verifierTarget:a.verifierTarget,rootEncoding:'poseidon2-bn254-hash4-fold-v1',srs:a.srs,circuits:Object.fromEntries(Object.entries(a.circuits).map(([k,v])=>[k,{circuitSha256:v.circuitSha256,verificationKeySha256:v.vkSha256}]))};
const canonical=x=>Array.isArray(x)?'['+x.map(canonical).join(',')+']':x&&typeof x==='object'?'{'+Object.keys(x).sort().map(k=>JSON.stringify(k)+':'+canonical(x[k])).join(',')+'}':JSON.stringify(x);
const policyHash=createHash('sha256').update(canonical(proofPolicy)).digest('hex');
await fs.writeFile(new URL('./policy.mjs',import.meta.url),`// Public approved policy identity; no cryptographic SDK/WASM import.\nconst freeze=x=>{if(x&&typeof x==='object'){Object.values(x).forEach(freeze);Object.freeze(x);}return x;};\nexport const proofPolicy=freeze(${JSON.stringify(proofPolicy,null,2)});\nexport const policyHash='${policyHash}';\nexport const proofPolicyHash=policyHash;\n`);console.log(policyHash);
