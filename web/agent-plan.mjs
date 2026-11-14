/** Public planning boundary. Never send datasets, real headers, budgets, filenames,
 * samples or decoder material to a planner. Not a general private LLM or proof.
 */
import {exactKeys,denseArray} from './recipe-core.mjs';
import {sha256} from './gc-core.mjs';
import {normalizePlan,hashPlan} from './plan-core.mjs';
import {parseRecipeColumn,applyRecipeOutput,serializeRecipeCSV} from './recipe-csv.mjs';
const fail=message=>{throw Error(message);};
const alias=/^C(?:[1-9]|1[0-6])$/;
export function publicTask(value){
 exactKeys(value,['version','goal','columns']);
 if(value.version!==1||typeof value.goal!=='string'||!value.goal.trim()||new TextEncoder().encode(value.goal).length>1800||/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(value.goal))fail('İş tanımı boş olamaz ve en fazla 1800 UTF-8 bayt olmalıdır. Gizli veri yazmayın.');
 if(!Array.isArray(value.columns)||value.columns.length<1||value.columns.length>4)fail('Planlama için 1–4 anonim sütun seçin.');
 denseArray(value.columns,value.columns.length);const seen=new Set();
 const columns=value.columns.map(c=>{exactKeys(c,['id','type']);if(typeof c.id!=='string'||!alias.test(c.id)||!['text','number'].includes(c.type)||seen.has(c.id))fail('Sütun kimliği/türü geçersiz veya yinelenmiş.');seen.add(c.id);return {id:c.id,type:c.type};});
 columns.sort((a,b)=>Number(a.id.slice(1))-Number(b.id.slice(1)));
 return Object.freeze({version:1,goal:value.goal.trim(),columns:Object.freeze(columns.map(Object.freeze))});
}
export const publicTaskHash=task=>sha256(JSON.stringify(publicTask(task)));
/** Reject duplicate JSON keys and deep containers instead of silently accepting
 * last-key-wins model output. JSON.parse validates syntax before this walk.
 */
export function parsePlannerJSON(raw){
 if(typeof raw!=='string'||raw.length>16000)fail('Model cevabı boyut sınırını aştı.');
 let source=raw.trim();if(source.startsWith('```')){if(!/^```(?:json)?\s*\n[\s\S]*\n```$/.test(source))fail('Model tek bir JSON planı döndürmeli.');source=source.replace(/^```(?:json)?\s*\n/,'').replace(/\n```$/,'').trim();}
 let parsed;try{parsed=JSON.parse(source);}catch{fail('Model geçerli JSON üretmedi; plan çalıştırılmadı.');}
 let p=0;const ws=()=>{while(/\s/.test(source[p]||'x'))p++;};
 const str=()=>{const start=p++;while(p<source.length){if(source[p]==='\\'){p+=2;continue;}if(source[p++]==='"')return JSON.parse(source.slice(start,p));}fail('JSON metni tamamlanmadı.');};
 function walk(depth){if(depth>12)fail('Model planı fazla derin.');ws();if(source[p]==='{'){p++;ws();const seen=new Set();if(source[p]==='}'){p++;return;}for(;;){ws();const k=str();if(seen.has(k))fail('Model planında yinelenen JSON anahtarı var.');seen.add(k);ws();p++;walk(depth+1);ws();if(source[p++]==='}')break;}}
 else if(source[p]==='['){p++;ws();if(source[p]===']'){p++;return;}for(;;){walk(depth+1);ws();if(source[p++]===']')break;}}
 else if(source[p]==='"')str();else while(p<source.length&&!/[\s,}\]]/.test(source[p]))p++;}
 walk(0);return parsed;
}
/** Hash attachment happens outside the LLM. Full envelopes, if supplied, must
 * already match; the model cannot choose another task or arbitrary tool/code.
 */
export async function acceptAgentProposal(task,proposal){
 task=publicTask(task);if(typeof proposal==='string')proposal=parsePlannerJSON(proposal);
 const status=proposal&&typeof proposal==='object'?Object.getOwnPropertyDescriptor(proposal,'status'):null;
 if(status&&!Object.hasOwn(status,'value'))fail('Model cevabı veri nesnesi olmalı.');
 if(status?.value==='unsupported'){exactKeys(proposal,['status','reason']);if(typeof proposal.reason!=='string'||proposal.reason.length>500)fail('Geçersiz desteklenmeyen iş cevabı.');fail('Model bu işi desteklenen gizli işlemlerle planlayamadı: '+proposal.reason);}
 const taskHash=await publicTaskHash(task);let candidate;
 if(proposal&&Object.hasOwn(proposal,'taskHash')){exactKeys(proposal,['version','taskHash','steps']);if(proposal.taskHash!==taskHash||proposal.version!==1)fail('Plan bu iş tanımına ait değil.');candidate=proposal;}
 else {exactKeys(proposal,['steps']);candidate={version:1,taskHash,steps:proposal.steps};}
 const plan=normalizePlan(candidate);
 for(const step of plan.steps){const column=task.columns.find(c=>c.id===step.column);if(!column||column.type!==step.recipe.type)fail('Model onaylı sütun/tür dışında işlem istedi.');}
 return {task,taskHash,plan,planSha256:await hashPlan(plan)};
}
/** This helper is buyer-local only. Its result must not enter a model request. */
export function privatePlanInputs(dataset,plan){
 plan=normalizePlan(plan);const values={};
 for(const step of plan.steps){const column=Number(step.column.slice(1))-1;if(column>=dataset.headers.length)fail('Anonim sütun bu dosyada yok.');values[step.column]=parseRecipeColumn(dataset,column,step.recipe);}
 return values;
}
export function applyAgentOutput(dataset,plan,output){
 plan=normalizePlan(plan);exactKeys(output,plan.steps.map(s=>s.column));let result={headers:[...dataset.headers],rows:dataset.rows.map(r=>[...r]),delimiter:dataset.delimiter};
 // Validate every output against the original input. Filling one column can
 // enlarge the export beyond the input cap; that export is not a new upload.
 for(const step of plan.steps){const column=Number(step.column.slice(1))-1;const checked=applyRecipeOutput(dataset,column,output[step.column],step.recipe);result.rows.forEach((row,i)=>{row[column]=checked.rows[i][column];});}
 return {...result,csv:serializeRecipeCSV(result)};
}
