import fs from 'node:fs/promises';
import {createProofRuntime,getRuntimeDescriptor} from './sdk.mjs';
import {prepareRecipeProof,decodeRecipe} from '../web/recipe-client.mjs';
import {evaluateRecipeRequest as evaluateRecipe} from '../api/recipe-gc.mjs';
const runtime=await createProofRuntime(),results=[];
try{for(const [type,value,steps] of [['number',255,[{op:'fill',value:254},{op:'clamp',min:2,max:19}]],['text','  Ab9 \u0000  ',[{op:'trim'},{op:'lowercase'},{op:'uppercase'},{op:'redactDigits'}]]]){
 const recipe={type,steps};const gc=await prepareRecipeProof([value],recipe);const result=await evaluateRecipe(gc.request);const decoded=await decodeRecipe(result,gc.decoder);
 const witness={inputPairs:gc.witness.inputPairs[0],outputPairs:gc.witness.outputPairs[0],inputSalt:'11'.repeat(32),outputSalt:'22'.repeat(32)};
 const context={type,column:1,row:0,preContext:'33'.repeat(32),finalContext:'44'.repeat(32),recipe};
 const roots=await runtime.commitRow({...context,...witness});const statement=await runtime.makeStatement({...context,...roots,inputLabels:gc.request.rows[0].inputs,outputLabels:result.outputs[0]});
 const start=performance.now();const proof=await runtime.proveRow({statement,witness});const proveMs=Math.round(performance.now()-start);const verifyStart=performance.now();const verified=await runtime.verifyRow({statement,proof});
 const row={type,decoded,proveMs,verifyMs:Math.round(performance.now()-verifyStart),verified,proofBytes:atob(proof.proof).length,profile:runtime.profile(),artifact:getRuntimeDescriptor().artifacts[type]};results.push(row);console.log(JSON.stringify(row));
 await fs.mkdir(new URL('./runtime/',import.meta.url),{recursive:true});await fs.writeFile(new URL(`./runtime/${type}-synthetic.json`,import.meta.url),JSON.stringify({statement,proof,witness}));
 await fs.writeFile(new URL(`./runtime/${type}-public.json`,import.meta.url),JSON.stringify({statement,proof}));
 if(!verified)throw new Error('Independent verification failed');
}await fs.writeFile(new URL('./runtime/measurements.json',import.meta.url),JSON.stringify(results,null,2)+'\n');}finally{await runtime.dispose();}
