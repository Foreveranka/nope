import handler from '../api/csv-gc.mjs';
import recipeHandler from '../api/recipe-gc.mjs';
import planHandler from '../api/plan-gc.mjs';
import {PROFILE,validateRequest,hashRequest,hashProgram} from '../web/gc-core.mjs';
import {PROFILE as RECIPE_PROFILE,validateRecipeRequest,hashRecipeRequest,hashRecipeProgram} from '../web/recipe-core.mjs';
import {PROFILE as PLAN_PROFILE,validatePlanRequest,hashPlan,hashPlanRequest,hashPlanProgram} from '../web/plan-core.mjs';
// Only approved deterministic profiles can select an evaluator. User-supplied
// programs, decoder fields and unknown versions are rejected by their validators.
function protocol(task){
 if(task?.profile===PROFILE)return {validate:validateRequest,hash:hashRequest,program:()=>hashProgram(),handler};
 if(task?.profile===RECIPE_PROFILE)return {validate:validateRecipeRequest,hash:hashRecipeRequest,program:()=>hashRecipeProgram(task.recipe),handler:recipeHandler};
 if(task?.profile===PLAN_PROFILE)return {validate:validatePlanRequest,hash:hashPlanRequest,program:()=>hashPlanProgram(task.plan),handler:planHandler};
 throw Error('Unsupported task profile');
}
export function validateTask(task){protocol(task).validate(task);return task;}
export const hashTask=task=>protocol(task).hash(task);
export const hashTaskProgram=task=>protocol(task).program();
/** Pure in-process adaptation of the actual existing evaluator, without decoder data. */
export async function executeTask(task){
 validateTask(task);
 if(task.profile===PLAN_PROFILE&&task.planSha256!==await hashPlan(task.plan))throw Error('Plan hash mismatch');
 const req={method:'POST',headers:{host:'workspace.internal',origin:'https://workspace.internal','content-type':'application/json'},body:task};
 const res={setHeader(){},end(body){this.body=JSON.parse(body);}};
 await protocol(task).handler(req,res);
 if(res.statusCode!==200)throw Error('Encrypted execution failed');
 return res.body;
}
