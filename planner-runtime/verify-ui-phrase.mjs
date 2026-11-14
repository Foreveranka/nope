/** Exact public UI paraphrase reproduction; does not modify the approved model or prompt. */
import fs from 'node:fs/promises';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {pipeline,env} from '@huggingface/transformers';
import {generatePlan,buildPlannerMessages} from '../web/agent-model-worker.mjs';
import {acceptAgentProposal} from '../web/agent-plan.mjs';
const root=path.dirname(fileURLToPath(import.meta.url));
const pack=JSON.parse(await fs.readFile(path.join(root,'model-pack.json'),'utf8'));
const cache=path.join(root,'.cache',pack.id);
for (const file of pack.files) {
 const bytes=await fs.readFile(path.join(cache,file.path));
 if(bytes.length!==file.bytes||createHash('sha256').update(bytes).digest('hex')!==file.sha256)throw Error('Model integrity mismatch.');
}
const task={version:1,goal:'For C2, trim leading and trailing spaces and lowercase. For C3, replace empty values with 0 then clamp between 0 and 100.',columns:[{id:'C2',type:'text'},{id:'C3',type:'number'}]};
const workerSha256=createHash('sha256').update(await fs.readFile(path.join(root,'../web/agent-model-worker.mjs'))).digest('hex');
const promptSha256=createHash('sha256').update(JSON.stringify(buildPlannerMessages(task))).digest('hex');
env.allowLocalModels=true;env.allowRemoteModels=false;env.useFSCache=false;
const generator=await pipeline('text-generation',cache,{device:'cpu',dtype:'q4',use_external_data_format:true,session_options:{intraOpNumThreads:4,interOpNumThreads:1}});
const started=performance.now();let sourceRaw,raw,generationError,accepted,validationError;
try{raw=await generatePlan(generator,task,value=>{sourceRaw=value;});}catch(error){generationError=error.message;}
if(raw)try{accepted=await acceptAgentProposal(task,raw);}catch(error){validationError=error.message;}
await generator.dispose();
const expected={steps:[{column:'C2',recipe:{type:'text',steps:[{op:'trim'},{op:'lowercase'}]}},{column:'C3',recipe:{type:'number',steps:[{op:'fill',value:0},{op:'clamp',min:0,max:100}]}}]};
const evidence={version:1,recordedAt:new Date().toISOString(),syntheticOnly:true,actualNeuralInference:true,backend:'onnxruntime-node CPU',model:pack.id,revision:pack.revision,dtype:'q4',runtime:'@huggingface/transformers@4.3.2',workerSha256,promptSha256,task,sourceRaw,raw,generationError,validationError,accepted:!!accepted,exactExpected:!!accepted&&JSON.stringify(JSON.parse(raw))===JSON.stringify(expected),elapsedMs:Math.round(performance.now()-started)};
await fs.writeFile(path.join(root,'ui-phrase-evidence.json'),JSON.stringify(evidence,null,2)+'\n');console.log(JSON.stringify(evidence,null,2));

if (!evidence.exactExpected) process.exitCode=1;
