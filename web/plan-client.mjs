import {PROFILE,normalizePlan,estimatePlan,hashPlan,hashPlanRequest,hashPlanProgram,
  hashPlanOutput,canonicalPlanOutput,freezePlanData} from './plan-core.mjs';
import {PROFILE as V2_PROFILE,compileRecipe,encodeRecipeValues,exactKeys,denseArray,
  validHash,nonceBytes,cryptoProvider,fromBase64,hashRecipeOutput} from './recipe-core.mjs';
import {prepareRecipe,decodeRecipe} from './recipe-client.mjs';

/** Preflight every column and the entire wrapper before ANY cryptography. Each
 * prepareRecipe invocation generates fresh labels for every row/wire, even when
 * recipes and input values repeat. Only request may leave the browser. */
export async function preparePlan(valuesByColumn,plan) {
  plan=normalizePlan(plan);
  exactKeys(valuesByColumn,plan.steps.map(step=>step.column));
  const first=valuesByColumn[plan.steps[0].column];
  if(!Array.isArray(first)) throw new Error('Expected column value arrays.');
  const rowCount=first.length;
  estimatePlan(plan,rowCount);
  const values=plan.steps.map(({column,recipe})=> {
    const columnValues=valuesByColumn[column];
    denseArray(columnValues,rowCount);
    encodeRecipeValues(columnValues,recipe);
    return Array.from(columnValues);
  });
  const nonce=Array.from(cryptoProvider().getRandomValues(new Uint8Array(16)),b=>b.toString(16).padStart(2,'0')).join('');
  const tasks=[],decoderTasks=[],nonces=new Set([nonce]);
  for(let i=0;i<plan.steps.length;i++) {
    const {column,recipe}=plan.steps[i];
    const prepared=await prepareRecipe(values[i],recipe);
    if(nonces.has(prepared.request.nonce)) throw new Error('Random nonce collision.');
    nonces.add(prepared.request.nonce);
    tasks.push({column,request:prepared.request});
    decoderTasks.push({column,decoder:prepared.decoder});
  }
  const planSha256=await hashPlan(plan),programSha256=await hashPlanProgram(plan);
  const request=freezePlanData({profile:PROFILE,plan,planSha256,nonce,rowCount,tasks});
  const decoder=freezePlanData({profile:PROFILE,plan,planSha256,nonce,rowCount,
    inputSha256:await hashPlanRequest(request),programSha256,tasks:decoderTasks});
  return {request,decoder};
}

function validateDecoder(decoder) {
  exactKeys(decoder,['profile','plan','planSha256','nonce','rowCount','inputSha256','programSha256','tasks']);
  if(decoder.profile!==PROFILE || !['planSha256','inputSha256','programSha256'].every(k=>validHash(decoder[k]))) throw new Error('Invalid plan decoder binding.');
  nonceBytes(decoder.nonce);
  const plan=normalizePlan(decoder.plan);estimatePlan(plan,decoder.rowCount);
  denseArray(decoder.tasks,plan.steps.length);
  const nonces=new Set([decoder.nonce]),labels=new Set();
  for(let i=0;i<plan.steps.length;i++) {
    const task=decoder.tasks[i],step=plan.steps[i];
    exactKeys(task,['column','decoder']);
    if(task.column!==step.column) throw new Error('Plan decoder column/order mismatch.');
    const d=task.decoder;
    exactKeys(d,['profile','recipe','nonce','rowCount','inputSha256','programSha256','outputPairs']);
    const compiled=compileRecipe(d.recipe);
    if(d.profile!==V2_PROFILE || d.rowCount!==decoder.rowCount || !validHash(d.inputSha256) || !validHash(d.programSha256) ||
        JSON.stringify(compiled.recipe)!==JSON.stringify(step.recipe)) throw new Error('Invalid mapped recipe decoder.');
    nonceBytes(d.nonce);
    if(nonces.has(d.nonce)) throw new Error('Duplicate plan decoder nonce.');
    nonces.add(d.nonce);
    denseArray(d.outputPairs,decoder.rowCount);
    for(const row of d.outputPairs) {
      denseArray(row,compiled.outputBits);
      for(const pair of row) {
        denseArray(pair,2);
        const bytes=pair.map(label=>fromBase64(label));
        if((bytes[0][15]&1)===(bytes[1][15]&1)) throw new Error('Invalid decoder permutation.');
        for(const label of pair) {
          if(labels.has(label)) throw new Error('Duplicate plan decoder label.');
          labels.add(label);
        }
      }
    }
  }
  return plan;
}

/** Rebuild full v2 result commitments using the locally retained v2 decoders.
 * Wire membership remains checked by the actual v2 decoder, never a clear path. */
export async function decodePlan(result,decoder) {
  const plan=validateDecoder(decoder);
  exactKeys(result,['profile','nonce','rowCount','outputs','inputSha256','outputSha256','programSha256']);
  nonceBytes(result.nonce);
  if(result.profile!==PROFILE || result.nonce!==decoder.nonce || result.rowCount!==decoder.rowCount ||
      result.inputSha256!==decoder.inputSha256 || result.programSha256!==decoder.programSha256 || !validHash(result.outputSha256)) throw new Error('Plan result request/program binding mismatch.');
  canonicalPlanOutput(result.outputs);
  for(let i=0;i<plan.steps.length;i++) {
    const task=result.outputs[i],step=plan.steps[i];
    if(result.outputs.length!==plan.steps.length || task.column!==step.column || task.outputs.length!==decoder.rowCount ||
        task.outputs[0].length!==compileRecipe(step.recipe).outputBits) throw new Error('Plan output type, column/order or row count mismatch.');
  }
  // Data-only validators above make these snapshots safe; no getters/toJSON.
  result=JSON.parse(JSON.stringify(result));decoder=JSON.parse(JSON.stringify(decoder));
  if(decoder.planSha256!==await hashPlan(plan) || decoder.programSha256!==await hashPlanProgram(plan)) throw new Error('Invalid plan decoder hash binding.');
  if(result.outputSha256!==await hashPlanOutput(result.outputs)) throw new Error('Plan output hash mismatch.');
  const decoded={};
  for(let i=0;i<plan.steps.length;i++) {
    const {column,outputs}=result.outputs[i],d=decoder.tasks[i].decoder;
    const v2result={profile:V2_PROFILE,nonce:d.nonce,rowCount:d.rowCount,outputs,
      inputSha256:d.inputSha256,programSha256:d.programSha256,outputSha256:await hashRecipeOutput(outputs)};
    decoded[column]=await decodeRecipe(v2result,d);
  }
  return decoded;
}
