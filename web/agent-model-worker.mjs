/** Neural inference only: public goal + anonymous typed columns. No CSV/value input. */
import {validateModelRequest} from './agent-model-runtime.mjs';
import {publicTaskHash,parsePlannerJSON,acceptAgentProposal} from './agent-plan.mjs';
export const SYSTEM_PROMPT = 'You are a restricted cleaning planner. Output JSON only. Success: {"operations":[["C1","trim"],["C1","lowercase"],["C2","fill",0],["C2","clamp",0,100]]}. Every operation is a separate array. Allowed text ops: trim, lowercase, uppercase, redactDigits. Allowed number ops: fill integer0..254, clamp min max integers0..254. Use ONLY the user column IDs. Include ALL requested operations in order. If ANY action is unsupported or unclear, output {"status":"unsupported","reason":"Unsupported operation"}. Translation, sentiment, summarizing, sorting and arbitrary code are unsupported. Never return a partial plan. Understand English and Turkish. No markdown. No explanation.';
const EXAMPLES = [
  ['Trim C3 and translate it into Turkish.',{status:'unsupported',reason:'Unsupported operation'}],
  ['C1 metnini İngilizceye çevir.',{status:'unsupported',reason:'Unsupported operation'}],
  ['C3: trim spaces then uppercase and redact digits. C4: fill missing with 9 then clamp between 2 and 90.',{operations:[['C3','trim'],['C3','uppercase'],['C3','redactDigits'],['C4','fill',9],['C4','clamp',2,90]]}],
  ['C1 boşluklarını kırp ve küçük harfe çevir. C2 eksikleri 3 ile doldur ve 0-120 arasına sınırla.',{operations:[['C1','trim'],['C1','lowercase'],['C2','fill',3],['C2','clamp',0,120]]}],
];
export function buildPlannerMessages(task) {
  return [{role:'system',content:SYSTEM_PROMPT + '\nCurrent column types: '+JSON.stringify(task.columns)},
    ...EXAMPLES.flatMap(([input,output])=>[{role:'user',content:input},{role:'assistant',content:JSON.stringify(output)}]),
    {role:'user',content:task.goal}];
}
/** Syntax adapter only. IDs, operations, constants and order all come from tokens.
 * No goal matching, operation inference, repair, dropping tuples or defaults.
 */
export function adaptModelOperations(sourceRaw,task) {
  const proposal = parsePlannerJSON(sourceRaw);
  if (proposal?.status === 'unsupported') {
    if (Object.keys(proposal).sort().join(',') !== 'reason,status' || typeof proposal.reason !== 'string' || proposal.reason.length > 500) throw new Error('Invalid unsupported model response.');
    return JSON.stringify(proposal);
  }
  if (!proposal || Object.keys(proposal).join(',') !== 'operations' || !Array.isArray(proposal.operations) || proposal.operations.length < 1 || proposal.operations.length > 16) throw new Error('Model did not emit operation tuples.');
  const steps = [], seen = new Map();
  for (const tuple of proposal.operations) {
    if (!Array.isArray(tuple) || tuple.length < 2 || typeof tuple[0] !== 'string' || typeof tuple[1] !== 'string') throw new Error('Invalid model operation tuple.');
    const [column,op] = tuple, type = task.columns.find(item=>item.id===column)?.type;
    if (!type) throw new Error('Model chose an unknown column.');
    let operation;
    if (type === 'text' && ['trim','lowercase','uppercase','redactDigits'].includes(op) && tuple.length === 2) operation={op};
    else if (type === 'number' && op === 'fill' && tuple.length === 3) operation={op,value:tuple[2]};
    else if (type === 'number' && op === 'clamp' && tuple.length === 4) operation={op,min:tuple[2],max:tuple[3]};
    else throw new Error('Model requested an unsupported operation; entire proposal rejected.');
    if (!seen.has(column)) { const step={column,recipe:{type,steps:[]}}; seen.set(column,step); steps.push(step); }
    seen.get(column).recipe.steps.push(operation);
  }
  return JSON.stringify({steps});
}
export async function generatePlan(generator, task, onModelOutput=()=>{}) {
  const prompt = generator.tokenizer.apply_chat_template(buildPlannerMessages(task), {
    tokenize:false, add_generation_prompt:true, enable_thinking:false,
  });
  const output = await generator(prompt, {max_new_tokens:256, do_sample:false, return_full_text:false});
  const sourceRaw = output?.[0]?.generated_text;
  if (typeof sourceRaw !== 'string' || !sourceRaw.trim() || sourceRaw.length > 16000) throw new Error('Model did not return a bounded text proposal.');
  onModelOutput(sourceRaw);
  const raw = adaptModelOperations(sourceRaw,task);
  // Defense in depth, while MAIN still independently accepts/rejects the result.
  if (JSON.parse(raw).status !== 'unsupported') await acceptAgentProposal(task,raw);
  return raw;
}
/** Bounded download; hash every cache hit too, before ONNX can consume bytes. */
export async function verifiedModelResponse(response,file,onProgress=()=>{}) {
  if (!response?.ok || !response.body) throw new Error('Model asset unavailable.');
  const bytes = new Uint8Array(file.bytes), reader = response.body.getReader();
  let loaded = 0, lastUpdate = 0;
  try {
    for (;;) {
      const {done,value} = await reader.read();
      if (done) break;
      if (loaded + value.byteLength > bytes.byteLength) throw new Error('Oversized model asset.');
      bytes.set(value,loaded); loaded += value.byteLength;
      if (performance.now() - lastUpdate > 500) { onProgress(loaded,file.bytes); lastUpdate = performance.now(); }
    }
  } catch (error) { await reader.cancel().catch(()=>{}); throw error; }
  const digest = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',bytes)), n=>n.toString(16).padStart(2,'0')).join('');
  if (loaded !== file.bytes || digest !== file.sha256) throw new Error('Model integrity verification failed.');
  return new Response(bytes,{headers:{'content-length':String(loaded)}});
}
let active = false;
if (typeof WorkerGlobalScope !== 'undefined' && globalThis instanceof WorkerGlobalScope) {
  globalThis.onmessage = async ({data}) => {
    if (active) return postMessage({type:'error',code:'BUSY',error:'Local planner is busy.'});
    active = true;
    let failureStage = 'request';
    const progress = (stage,message,extra={}) => { failureStage = stage; postMessage({type:'progress',stage,message,...extra}); };
    try {
      const request = validateModelRequest(data);
      if (request.taskHash !== await publicTaskHash(request.task)) throw new Error('Public task hash mismatch.');
      progress('loading','Loading the local neural planner; only public instructions enter the model.');
      const [{pipeline,env}, packResponse] = await Promise.all([
        import('./agent-model/transformers.mjs'),
        fetch(new URL('./agent-model/model-pack.json',import.meta.url), {credentials:'omit',referrerPolicy:'no-referrer'}),
      ]);
      if (!packResponse.ok) throw new Error('Model manifest is unavailable.');
      const pack = await packResponse.json();
      if (pack.id !== 'onnx-community/Qwen3-0.6B-ONNX-OPT' || pack.revision !== '4799e655597b49210adb5c1ebe5b9d3bd04005a0') throw new Error('Unexpected model manifest.');
      env.allowLocalModels = true; env.allowRemoteModels = false;
      env.useBrowserCache = false; env.useFSCache = false; env.useWasmCache = false;
      env.useCustomCache = true;
      const base = `https://huggingface.co/${pack.id}/resolve/${pack.revision}/`;
      const assetBase = new URL('./agent-model/',import.meta.url);
      const networkFetch = globalThis.fetch.bind(globalThis);
      // Library optional-file probes may not escape the fixed asset allowlist.
      globalThis.fetch = (resource,options) => {
        const url = new URL(typeof resource === 'string' || resource instanceof URL ? resource : resource.url,import.meta.url);
        if (url.origin !== assetBase.origin || !url.href.startsWith(assetBase.href) || !['ort-wasm-simd-threaded.asyncify.mjs','ort-wasm-simd-threaded.asyncify.wasm'].includes(url.pathname.split('/').at(-1))) throw new Error('Unlisted runtime network request blocked.');
        return networkFetch(resource,options);
      };
      let cache;
      try { cache = await caches.open('nope-agent-model-verified-v1'); } catch {}
      env.customCache = {
        async match(key) {
          const file = pack.files.find(file => [base+file.path, `/models/${pack.id}/${file.path}`, `${pack.id}/${pack.revision}/${file.path}`].includes(key));
          if (!file) return undefined;
          const assetURL = base + file.path;
          let response = await cache?.match(assetURL);
          if (!response) {
            progress('download',`Downloading ${file.path}`,{file:file.path,total:file.bytes});
            response = await networkFetch(assetURL,{method:'GET',credentials:'omit',referrerPolicy:'no-referrer'});
          }
          if (!response.ok) throw new Error('Model download failed.');
          let verified;
          try {
            verified = await verifiedModelResponse(response,file,(loaded,total)=>progress('download',`Loading ${file.path}`,{file:file.path,loaded,total}));
          } catch (error) { await cache?.delete(assetURL); throw error; }
          try { await cache?.put(assetURL,verified.clone()); } catch {}
          progress('verified',`Verified ${file.path}`,{file:file.path,loaded:file.bytes,total:file.bytes});
          return verified;
        },
        async put() {},
      };
      env.backends.onnx.wasm.numThreads = 1;
      env.backends.onnx.wasm.proxy = false;
      env.backends.onnx.wasm.wasmPaths = {
        mjs:new URL('./agent-model/ort-wasm-simd-threaded.asyncify.mjs',import.meta.url).href,
        wasm:new URL('./agent-model/ort-wasm-simd-threaded.asyncify.wasm',import.meta.url).href,
      };
      let device = 'wasm';
      try { if (await navigator.gpu?.requestAdapter()) device = 'webgpu'; } catch {}
      let generator;
      progress('initializing',`Initializing the local model (${device}).`);
      const options = {revision:pack.revision,dtype:'q4',device,use_external_data_format:true};
      try { generator = await pipeline('text-generation',pack.id,options); }
      catch (error) {
        if (device !== 'webgpu') throw error;
        progress('fallback','WebGPU initialization failed; using single-thread WASM CPU.');
        device = 'wasm'; generator = await pipeline('text-generation',pack.id,{...options,device});
      }
      progress('generating',`Generating a public plan locally (${device}).`);
      let sourceRaw;
      const raw = await generatePlan(generator,request.task,value=>{sourceRaw=value;});
      postMessage({type:'plan',raw,model:{id:pack.id,revision:pack.revision,dtype:'q4',runtime:'@huggingface/transformers@4.3.2',device,outputFormat:'operation-tuples-v1',sourceRaw}});
      await generator.dispose();
    } catch (error) {
      const reason = String(error?.message || 'Unknown local runtime error')
        .replace(/https?:\/\/[^\s<>"']+/g,'[URL]')
        .replace(/<[^>]*>/g,'').replace(/[\x00-\x1f\x7f]/g,' ').slice(0,180);
      postMessage({type:'error',code:'LOCAL_MODEL_FAILED',stage:failureStage,error:`Local model failed (${failureStage}): ${reason}`});
    } finally { active = false; }
  };
}
