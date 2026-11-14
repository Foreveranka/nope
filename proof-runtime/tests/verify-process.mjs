import fs from'node:fs/promises';import{createProofRuntime}from'../sdk.mjs';
const {statement,proof}=JSON.parse(await fs.readFile(new URL('../runtime/'+process.argv[2]+'-public.json',import.meta.url)));const verifier=await createProofRuntime();try{const ok=await verifier.verifyRow({statement,proof});console.log('VERIFIED',ok);if(!ok)process.exitCode=1;}finally{await verifier.dispose();}
