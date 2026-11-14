/** Public plan boundary. UTF-8 private metadata and values never enter these tasks. */
import {exactKeys,denseArray} from './recipe-core.mjs';
import {sha256} from './gc-core.mjs';
import {normalizeRecordPlan,referenceRecord,hashRecordPlan} from './record-core.mjs';
import {serializeRecipeCSV} from './recipe-csv.mjs';
const check=(v,m='Invalid private record plan')=>{if(!v)throw Error(m);};
export function publicRecordTask(value){
 exactKeys(value,['version','goal','columns']);check(value.version===2&&typeof value.goal==='string'&&value.goal.trim()&&new TextEncoder().encode(value.goal).length<=1800&&!/[\x00-\x1f\x7f]/.test(value.goal));
 check(Array.isArray(value.columns)&&value.columns.length>=1&&value.columns.length<=8);denseArray(value.columns,value.columns.length);const seen=new Set();
 const columns=value.columns.map(c=>{exactKeys(c,['id','type']);check(/^C(?:[1-9]|1[0-6])$/.test(c.id)&&c.type==='uint32'&&!seen.has(c.id));seen.add(c.id);return {...c};}).sort((a,b)=>Number(a.id.slice(1))-Number(b.id.slice(1)));
 return {version:2,goal:value.goal.trim(),columns};
}
export const publicRecordTaskHash=t=>sha256(JSON.stringify(publicRecordTask(t)));
export async function acceptRecordProposal(task,proposal){
 task=publicRecordTask(task);const plan=normalizeRecordPlan(proposal),taskHash=await publicRecordTaskHash(task);
 check(plan.taskHash===taskHash&&plan.inputs.length===task.columns.length&&plan.inputs.every(id=>task.columns.some(c=>c.id===id)));
 return {task,taskHash,plan,planSha256:await hashRecordPlan(plan)};
}
export function privateRecordInputs(dataset,plan){
 plan=normalizeRecordPlan(plan);check(dataset?.rows?.length>0);
 const values=dataset.rows.map(row=>plan.inputs.map(id=>{
  const index=Number(id.slice(1))-1;check(index<dataset.headers.length);const value=row[index];
  check(typeof value==='string'&&/^(0|[1-9][0-9]{0,9})$/.test(value)&&BigInt(value)<=4294967295n,'Record fields require canonical unsigned 32-bit integers; money uses minor units.');return Number(value);
 }));values.forEach(v=>referenceRecord(v,plan));return values;
}
export function applyRecordOutput(dataset,plan,outputs){
 plan=normalizeRecordPlan(plan);denseArray(outputs,dataset.rows.length);
 const headers=[...dataset.headers];const names=plan.outputs.map((_,i)=>{let name='NOPE_R'+(i+1);while(headers.includes(name))name+='_';headers.push(name);return name;});
 const rows=dataset.rows.map((row,i)=>{denseArray(outputs[i],plan.outputs.length);outputs[i].forEach(v=>check(Number.isSafeInteger(v)&&v>=0&&v<=4294967295));return [...row,...outputs[i].map(String)];});
 const result={headers,rows,delimiter:dataset.delimiter};return {...result,outputColumns:names,csv:serializeRecipeCSV(result)};
}
export async function recordTemplate(task,kind,inputs){
 task=publicRecordTask(task);const taskHash=await publicRecordTaskHash(task),step=(op,a,b,c=0)=>({op,a,b,c});let steps,outputs;
 if(kind==='invoice'&&inputs.length===4){steps=[step('mul16',0,1),step('subSat',2,12),step('lte',2,3),step('eq',2,12)];outputs=[12,13,14,15];}
 else if(kind==='cashflow'&&inputs.length===6){steps=[step('subSat',0,1),step('lte',1,0),step('lte',2,12),step('subSat',12,2),step('lte',3,15),step('lte',5,4),step('and',13,14),step('and',16,18)];outputs=[12,15,17,19];}
 else throw Error('Invalid record template');
 return acceptRecordProposal(task,{version:1,taskHash,inputs,constants:[],steps,outputs});
}
