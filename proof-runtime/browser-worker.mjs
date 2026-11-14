import {createProofRuntime}from'./sdk.mjs';
let runtime;let chain=Promise.resolve();
const allowed=new Set(['commitRow','selectedRoot','makeStatement','proveRow','verifyRow','profile','dispose']);
self.onmessage=({data})=>{chain=chain.then(async()=>{const {id,method,args}=data;try{if(!allowed.has(method))throw new Error('Unsupported proof method');runtime??=await createProofRuntime();const result=await runtime[method](args);self.postMessage({id,result});}catch(e){self.postMessage({id,error:e.message});}});};
