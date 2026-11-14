/** Real CPU inference on synthetic public tasks. Never reads a CSV. */
import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';
import {pipeline,env} from '@huggingface/transformers';
import {generatePlan} from '../web/agent-model-worker.mjs';
import {acceptAgentProposal} from '../web/agent-plan.mjs';
const root=path.dirname(fileURLToPath(import.meta.url));
const pack=JSON.parse(await fs.readFile(path.join(root,'model-pack.json'),'utf8'));
const cache=path.join(root,'.cache',pack.id);
for(const file of pack.files){
 const data=await fs.readFile(path.join(cache,file.path));
 if(data.length!==file.bytes||createHash('sha256').update(data).digest('hex')!==file.sha256)throw Error('Model hash mismatch.');
}
env.allowRemoteModels=false;env.allowLocalModels=true;env.useFSCache=false;
const loadStarted=performance.now();
const generator=await pipeline('text-generation',cache,{device:'cpu',dtype:'q4',use_external_data_format:true,session_options:{intraOpNumThreads:4,interOpNumThreads:1}});
console.log('MODEL_LOADED',Math.round(performance.now()-loadStarted));
const expected={steps:[{column:'C1',recipe:{type:'text',steps:[{op:'trim'},{op:'lowercase'}]}},{column:'C2',recipe:{type:'number',steps:[{op:'fill',value:0},{op:'clamp',min:0,max:100}]}}]};
const cases=[
 {id:'english',goal:'Trim leading and trailing spaces from C1, then convert C1 to lowercase. Fill missing C2 values with 0, then clamp C2 between 0 and 100.',expected},
 {id:'turkish',goal:'C1 sütunundaki baştaki ve sondaki boşlukları temizle, sonra küçük harfe dönüştür. C2 sütunundaki eksik değerleri 0 ile doldur, sonra değerleri 0 ile 100 arasında sınırla.',expected},
 {id:'unsupported-translation',goal:'Translate C1 text into Turkish.',unsupported:true},
 {id:'unsupported-turkish',goal:'C1 metnini İngilizceye çevir ve duygusunu analiz et.',unsupported:true},
];
const results=[];
for(const test of cases){
 const task={version:1,goal:test.goal,columns:[{id:'C1',type:'text'},{id:'C2',type:'number'}]};
 const start=performance.now(); const raw=await generatePlan(generator,task);
 let accepted;try{accepted=await acceptAgentProposal(task,raw);}catch(error){if(!test.unsupported)throw error;}
 const parsed=JSON.parse(raw);
 const passed=test.unsupported?parsed.status==='unsupported'&&!accepted:JSON.stringify(parsed)===JSON.stringify(test.expected)&&!!accepted;
 const result={id:test.id,task,raw,passed,elapsedMs:Math.round(performance.now()-start)};
 results.push(result);console.log(JSON.stringify(result));
}
await generator.dispose();
const evidence={version:1,syntheticOnly:true,actualNeuralInference:true,backend:'onnxruntime-node CPU',model:pack.id,revision:pack.revision,dtype:'q4',runtime:'@huggingface/transformers@4.3.2',hashesVerified:pack.files,results};
await fs.writeFile(path.join(root,'generation-evidence.json'),JSON.stringify(evidence,null,2)+'\n');
if(results.some(result=>!result.passed))process.exitCode=1;
