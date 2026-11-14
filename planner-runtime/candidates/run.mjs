/** Real inference. Preserves each run, errors and unsafe accepted subsets. */
import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {createHash,randomUUID} from 'node:crypto';
import {pipeline,env} from '@huggingface/transformers';
import {suite} from './suite.mjs';
import {prompts} from './prompts.mjs';
import {adaptModelOperations} from '../../web/agent-model-worker.mjs';
import {acceptAgentProposal,publicTask} from '../../web/agent-plan.mjs';
const dir=path.dirname(fileURLToPath(import.meta.url)), runtime=path.resolve(dir,'..');
const names=process.argv.slice(2);if(!names.length||names.some(name=>!Object.hasOwn(prompts,name)))throw Error('Select candidate names: '+Object.keys(prompts).join(', '));
const sha=bytes=>createHash('sha256').update(bytes).digest('hex');
const pack=JSON.parse(await fs.readFile(path.join(runtime,'model-pack.json'),'utf8'));
const cache=path.join(runtime,'.cache',pack.id);
for(const file of pack.files){const bytes=await fs.readFile(path.join(cache,file.path));if(bytes.length!==file.bytes||sha(bytes)!==file.sha256)throw Error('Model integrity mismatch.');}
const sourceHashes=Object.fromEntries(await Promise.all(['suite.mjs','prompts.mjs','run.mjs'].map(async name=>[name,sha(await fs.readFile(path.join(dir,name)))])));
const frozenPaths=['web/agent-model-worker.mjs','web/agent-model-runtime.mjs','planner-runtime/model-pack.json','planner-runtime/package-lock.json'];
const frozenHashes=Object.fromEntries(await Promise.all(frozenPaths.map(async file=>[file,sha(await fs.readFile(path.resolve(runtime,'..',file)))])));
await fs.mkdir(path.join(dir,'runs'),{recursive:true});
const runId=new Date().toISOString().replaceAll(':','-')+'-'+randomUUID().slice(0,6);
const out=path.join(dir,'runs',runId);await fs.mkdir(out);
env.allowRemoteModels=false;env.allowLocalModels=true;env.useFSCache=false;
const loadStart=performance.now();
const generator=await pipeline('text-generation',cache,{device:'cpu',dtype:'q4',use_external_data_format:true,session_options:{intraOpNumThreads:4,interOpNumThreads:1}});
const loadMs=Math.round(performance.now()-loadStart);
const sort=steps=>steps.map(s=>({column:s.column,recipe:s.recipe})).sort((a,b)=>Number(a.column.slice(1))-Number(b.column.slice(1)));
const outcomes=[];
try{
 for(const name of names){
  const results=[];
  for(const item of suite){
   const task=publicTask(item.task),messages=prompts[name].messages(task),start=performance.now();
   let sourceRaw,raw,accepted,error,explicitUnsupported=false;
   try{
    const prompt=generator.tokenizer.apply_chat_template(messages,{tokenize:false,add_generation_prompt:true,enable_thinking:false});
    const output=await generator(prompt,{max_new_tokens:256,do_sample:false,return_full_text:false});sourceRaw=output?.[0]?.generated_text;
    raw=adaptModelOperations(sourceRaw,task);explicitUnsupported=JSON.parse(raw).status==='unsupported';
    if(!explicitUnsupported)accepted=await acceptAgentProposal(task,raw);
   }catch(caught){error=caught.message;}
   const exact=!!accepted&&item.kind==='supported'&&JSON.stringify(sort(accepted.plan.steps))===JSON.stringify(sort(item.expected.steps));
   const disposition=accepted?(exact?'correct-supported-plan':item.kind==='unsupported'?'UNSAFE-accepted-unsupported-request':'WRONG-accepted-plan'):explicitUnsupported?'explicit-unsupported':'rejected-invalid-output';
   const result={id:item.id,lang:item.lang,split:item.split,kind:item.kind,task,expected:item.expected,messages,messagesSha256:sha(JSON.stringify(messages)),sourceRaw,raw,error,accepted:!!accepted,exact,disposition,elapsedMs:Math.round(performance.now()-start)};
   results.push(result);await fs.appendFile(path.join(out,name+'.jsonl'),JSON.stringify(result)+'\n');
   console.log(JSON.stringify({candidate:name,id:item.id,disposition,elapsedMs:result.elapsedMs,sourceRaw}));
  }
  const summarize=list=>({positiveTotal:list.filter(r=>r.kind==='supported').length,positiveExact:list.filter(r=>r.kind==='supported'&&r.exact).length,positiveWrongAccepted:list.filter(r=>r.kind==='supported'&&r.accepted&&!r.exact).length,positiveRejected:list.filter(r=>r.kind==='supported'&&!r.accepted).length,negativeTotal:list.filter(r=>r.kind==='unsupported').length,negativeExplicit:list.filter(r=>r.kind==='unsupported'&&r.disposition==='explicit-unsupported').length,negativeInvalidRejected:list.filter(r=>r.kind==='unsupported'&&r.disposition==='rejected-invalid-output').length,negativeUnsafeAccepted:list.filter(r=>r.kind==='unsupported'&&r.accepted).length,totalInferenceMs:list.reduce((s,r)=>s+r.elapsedMs,0)});
  const summary={all:summarize(results),development:summarize(results.filter(r=>r.split==='development')),holdout:summarize(results.filter(r=>r.split==='holdout'))};
  outcomes.push({name,summary});await fs.writeFile(path.join(out,name+'.json'),JSON.stringify({version:1,runId,recordedAt:new Date().toISOString(),actualNeuralInference:true,syntheticOnly:true,model:pack.id,revision:pack.revision,dtype:pack.dtype,backend:'onnxruntime-node CPU',runtime:'@huggingface/transformers@4.3.2',loadMs,newModelDownloadBytes:0,sourceHashes,frozenHashes,summary,results},null,2)+'\n');
  console.log('SUMMARY '+JSON.stringify({name,summary}));
 }
}finally{await generator.dispose();}
for(const file of frozenPaths)if(sha(await fs.readFile(path.resolve(runtime,'..',file)))!==frozenHashes[file])throw Error('Active source changed during experiment: '+file);
await fs.writeFile(path.join(out,'summary.json'),JSON.stringify({runId,sourceHashes,frozenHashes,loadMs,outcomes},null,2)+'\n');console.log('RUN_DIRECTORY '+out);
