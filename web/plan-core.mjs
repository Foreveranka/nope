/** Bounded public multi-column recipes. taskHash binds a task description; it
 * does not prove LLM provenance or correct execution. No CSV names or values. */
import {compileRecipe,estimateRecipe,canonicalRecipeRequest,validateRecipeRequest,
  validateRecipeOutputs,exactKeys,denseArray,validHash,nonceBytes,
  MAX_GATES,MAX_REQUEST_BYTES,RECIPE_CATALOGUE} from './recipe-core.mjs';
import {sha256} from './gc-core.mjs';

export const PROFILE = 'nope-csv-plan-gc-v3';
export {MAX_GATES,MAX_REQUEST_BYTES};
// Leave room for the workspace job title/description/key envelope/body fields.
export const MAX_PLAN_REQUEST_BYTES = MAX_REQUEST_BYTES - 16 * 1024;
export const MAX_COLUMNS = 4;
const fail = message => {throw new Error(message);};
const columnPattern = /^C(?:[1-9]|1[0-6])$/;
const isColumn = column => typeof column==='string' && columnPattern.test(column);
export function freezePlanData(value) {
  if(value && typeof value==='object') {Object.values(value).forEach(freezePlanData);Object.freeze(value);}
  return value;
}
export function normalizePlan(plan) {
  exactKeys(plan,['version','taskHash','steps']);
  if(plan.version!==1 || !validHash(plan.taskHash)) fail('Invalid plan version or task hash.');
  if(!Array.isArray(plan.steps) || plan.steps.length<1 || plan.steps.length>MAX_COLUMNS) fail('Expected 1–4 plan columns.');
  denseArray(plan.steps,plan.steps.length);
  const seen=new Set();
  const steps=plan.steps.map(step=> {
    exactKeys(step,['column','recipe']);
    if(!isColumn(step.column) || seen.has(step.column)) fail('Expected unique column aliases C1..C16.');
    seen.add(step.column);
    return {column:step.column,recipe:compileRecipe(step.recipe).recipe};
  });
  return freezePlanData({version:1,taskHash:plan.taskHash,steps});
}
export const hashPlan = plan => sha256(JSON.stringify(normalizePlan(plan)));

/** Exact wrapper size, computed before randomness, hashing or garbling. The v2
 * estimates include every encrypted label/table byte; wrapper overhead is added. */
export function estimatePlan(plan,rowCount) {
  plan=normalizePlan(plan);
  const estimates=plan.steps.map(({recipe})=>estimateRecipe(recipe,rowCount));
  const gateCount=estimates.reduce((total,e)=>total+e.gateCount,0);
  if(gateCount>MAX_GATES) fail('Plan exceeds the total 10000 gate budget.');
  const envelope={profile:PROFILE,plan,planSha256:'0'.repeat(64),nonce:'0'.repeat(32),rowCount,
    tasks:plan.steps.map(({column})=>({column,request:null}))};
  const serializedRequestBytes=JSON.stringify(envelope).length+
    estimates.reduce((total,e)=>total+e.serializedRequestBytes-4,0);
  if(serializedRequestBytes>=MAX_PLAN_REQUEST_BYTES) fail('Plan exceeds the total request budget (3 MiB minus 16 KiB workspace reserve).');
  return {rowCount,gateCount,serializedRequestBytes,estimates};
}

export function validatePlanRequest(request) {
  exactKeys(request,['profile','plan','planSha256','nonce','rowCount','tasks']);
  if(request.profile!==PROFILE || !validHash(request.planSha256)) fail('Invalid plan profile or hash.');
  nonceBytes(request.nonce);
  const plan=normalizePlan(request.plan),estimate=estimatePlan(plan,request.rowCount);
  denseArray(request.tasks,plan.steps.length);
  const nonces=new Set([request.nonce]);
  for(let i=0;i<plan.steps.length;i++) {
    const task=request.tasks[i],step=plan.steps[i];
    exactKeys(task,['column','request']);
    if(task.column!==step.column) fail('Plan task column/order mismatch.');
    const compiled=validateRecipeRequest(task.request);
    if(task.request.rowCount!==request.rowCount || JSON.stringify(compiled.recipe)!==JSON.stringify(step.recipe)) fail('Plan task type, recipe or row count mismatch.');
    if(nonces.has(task.request.nonce)) fail('Plan and task nonces must be distinct.');
    nonces.add(task.request.nonce);
  }
  // Request strings are all canonical ASCII after validation. This also bounds
  // direct JS requests with an unnecessarily escaped public representation.
  if(JSON.stringify(request).length>=MAX_PLAN_REQUEST_BYTES) fail('Plan exceeds the total request budget (3 MiB minus 16 KiB workspace reserve).');
  return {plan,...estimate};
}
export function canonicalPlanRequest(request) {
  const {plan}=validatePlanRequest(request);
  return JSON.stringify({profile:PROFILE,plan,planSha256:request.planSha256,nonce:request.nonce,rowCount:request.rowCount,
    tasks:request.tasks.map(task=>({column:task.column,request:JSON.parse(canonicalRecipeRequest(task.request))}))});
}
export const hashPlanRequest = request => sha256(canonicalPlanRequest(request));
export function hashPlanProgram(plan) {
  plan=normalizePlan(plan);
  return sha256(JSON.stringify({profile:PROFILE,plan,
    programs:plan.steps.map(({column,recipe})=>({column,program:JSON.parse(compileRecipe(recipe).canonicalProgram)}))}));
}

/** Generic delivery hashing needs only the public typed label arrays. The plan
 * supplies the expected column order and exact number/text width when decoding. */
export function canonicalPlanOutput(outputs) {
  if(!Array.isArray(outputs) || outputs.length<1 || outputs.length>MAX_COLUMNS) fail('Expected 1–4 plan outputs.');
  denseArray(outputs,outputs.length);
  const seen=new Set();let rowCount;
  const canonical=outputs.map(task=> {
    exactKeys(task,['column','outputs']);
    if(!isColumn(task.column) || seen.has(task.column)) fail('Invalid output column.');
    seen.add(task.column);
    if(!Array.isArray(task.outputs) || task.outputs.length<1 || task.outputs.length>32) fail('Invalid output row count.');
    if(rowCount===undefined) rowCount=task.outputs.length;
    if(task.outputs.length!==rowCount) fail('Output row counts differ.');
    denseArray(task.outputs,rowCount);
    if(!Array.isArray(task.outputs[0])) fail('Expected typed output label arrays.');
    const width=task.outputs[0].length;
    if(width!==8 && width!==128 || width===128 && rowCount>8) fail('Invalid typed output width.');
    validateRecipeOutputs(task.outputs,rowCount,width);
    return {column:task.column,outputs:task.outputs};
  });
  return JSON.stringify(canonical);
}
export const hashPlanOutput = outputs => sha256(canonicalPlanOutput(outputs));
export const PLAN_CATALOGUE = freezePlanData({profile:PROFILE,version:1,
  limits:{maxColumns:MAX_COLUMNS,columnAliases:'C1..C16',maxGates:MAX_GATES,maxRequestBytes:MAX_PLAN_REQUEST_BYTES,maxHttpRequestBytes:MAX_REQUEST_BYTES,
    maxNumberRows:32,maxTextRows:8,maxTextBytes:16,maxRecipeSteps:4},
  recipe:RECIPE_CATALOGUE,
  order:'Plan steps and task/output columns execute in supplied order; each alias occurs once.',
  disclosure:'Public plan, task hash, row count and topology; no CSV headers, values, keys or decoders.',
  securityModel:'Honest browser garbler; semi-honest evaluator; transcript binding is not an execution proof or proof of LLM provenance.'});
