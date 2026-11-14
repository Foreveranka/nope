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
 {id:'holdout-english',goal:'Trim C2 then uppercase C2. Fill missing C3 with 7 and clamp C3 between 10 and 80.',columns:[{id:'C2',type:'text'},{id:'C3',type:'number'}],expected:{steps:[{column:'C2',recipe:{type:'text',steps:[{op:'trim'},{op:'uppercase'}]}},{column:'C3',recipe:{type:'number',steps:[{op:'fill',value:7},{op:'clamp',min:10,max:80}]}}]}},
 {id:'holdout-turkish',goal:'C2 metninin başındaki ve sonundaki boşlukları kırp, sonra büyük harfe dönüştür. C3 eksiklerini 7 ile doldur, ardından 10 ile 80 arasına sınırla.',columns:[{id:'C2',type:'text'},{id:'C3',type:'number'}],expected:{steps:[{column:'C2',recipe:{type:'text',steps:[{op:'trim'},{op:'uppercase'}]}},{column:'C3',recipe:{type:'number',steps:[{op:'fill',value:7},{op:'clamp',min:10,max:80}]}}]}},
 {id:'unsupported-mixed-english',goal:'Trim C1 then translate it into Turkish.',unsupported:true},
 {id:'unsupported-mixed-turkish',goal:'C1 boşluklarını kırp ve metni İngilizceye çevir.',unsupported:true},
 {id:'unsupported-translation',goal:'Translate C1 text into Turkish.',unsupported:true},
 {id:'unsupported-turkish',goal:'C1 metnini İngilizceye çevir ve duygusunu analiz et.',unsupported:true},
];
const results=[];
for(const test of cases){
 const task={version:1,goal:test.goal,columns:test.columns||[{id:'C1',type:'text'},{id:'C2',type:'number'}]};
 const start=performance.now(); let raw,sourceRaw,generationError;
 try{raw=await generatePlan(generator,task,value=>{sourceRaw=value;});}catch(error){generationError=error.message;}
 let accepted,validationError;try{accepted=await acceptAgentProposal(task,raw);}catch(error){validationError=error.message;}
 let parsed;try{parsed=JSON.parse(raw);}catch{parsed={};}
 const passed=test.unsupported?!accepted&&(parsed.status==='unsupported'||!!generationError):JSON.stringify(parsed)===JSON.stringify(test.expected)&&!!accepted;
 const disposition=generationError?'rejected-malformed-or-unsupported-model-output':parsed.status==='unsupported'?'model-explicit-unsupported':'validated-exact-expected-plan';
 const result={id:test.id,task,sourceRaw,raw,generationError,validationError,disposition,passed,elapsedMs:Math.round(performance.now()-start)};
 results.push(result);console.log(JSON.stringify(result));
}
await generator.dispose();
const summary={correctSupported:results.filter(r=>r.passed&&r.disposition==='validated-exact-expected-plan').length,explicitUnsupported:results.filter(r=>r.disposition==='model-explicit-unsupported').length,rejectedMalformedOrUnsupported:results.filter(r=>r.disposition==='rejected-malformed-or-unsupported-model-output').length,passed:results.filter(r=>r.passed).length,total:results.length};
const evidence={version:1,recordedAt:new Date().toISOString(),summary,syntheticOnly:true,actualNeuralInference:true,backend:'onnxruntime-node CPU',model:pack.id,revision:pack.revision,dtype:'q4',runtime:'@huggingface/transformers@4.3.2',hashesVerified:pack.files,results};
await fs.writeFile(path.join(root,'generation-evidence.json'),JSON.stringify(evidence,null,2)+'\n');
if(results.some(result=>!result.passed))process.exitCode=1;
