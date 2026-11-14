# Browser-local public-task planner

This directory owns the model dependency lock, immutable public model manifest and
synthetic generation checks. No key, API account, hosted inference or CSV is used.
The neural model receives only a public goal and anonymous typed column IDs. The
public goal must itself contain no sensitive values. This cannot make an arbitrary
natural-language goal private or provide an execution proof.

## Packaging contract

From the repository root:

```sh
npm ci --prefix planner-runtime --ignore-scripts
node scripts/package-agent-model.mjs
# Optional explicit output location:
node scripts/package-agent-model.mjs --outDir runtime/agent-model-public
```

Default generated directory: `runtime/agent-model-public/` (root runtime is ignored).
MAIN copies only `assets.json` and its listed files into `dist/agent-model/`.
Source `web/agent-model-worker.mjs`, `web/agent-model-runtime.mjs` and their MAIN
public-boundary imports must also be served at the web root. Preview must map
`/agent-model/*` to this exact generated directory, not expose runtime generally.
No model weight enters Git, a deployment function or the static artifact.

Exact generated files:

| File | Bytes |
| --- | ---: |
| transformers.mjs | 550576 |
| ort-wasm-simd-threaded.asyncify.mjs | 53057 |
| ort-wasm-simd-threaded.asyncify.wasm | 26861777 |
| model-pack.json | 1226 |
| transformers-LICENSE.txt | 11358 |
| onnxruntime-LICENSE.txt | 1073 |

Total listed bytes: **27479067** plus the small generated assets.json. The asset
manifest records hashes of actual bundled bytes. No CDN JS, eval or blob worker.
The WASM runtime uses one CPU thread and no proxy. No COOP/COEP header is required.

## Dependencies

- `@huggingface/transformers` **4.3.2**, current npm stable when checked 14 Nov 2026.
- `esbuild` **0.28.2**, build dependency, all output bundled as browser ESM.
- Upstream runtime transitive: `onnxruntime-web` **1.31.0-dev.20260914-8d85527a0**.
  This is the exact version required by Transformers.js 4.3.2, not a separately
  selected stable ONNX runtime. Native generation uses upstream `onnxruntime-node`
  **1.30.0**. Native packages are never imported by the browser build.
- All other transitive packages, platforms and integrity hashes are in
  `planner-runtime/package-lock.json`. Do not edit the root package for these.

## Model download and integrity

`onnx-community/Qwen3-0.6B-ONNX-OPT`, commit
`4799e655597b49210adb5c1ebe5b9d3bd04005a0`, q4, Apache-2.0.
Total model bytes **412501229**. Main graph 369635B; external weight file
403007488B; tokenizer 9117036B; three small metadata files.

Every required file's SHA-256 and byte count are recorded in `model-pack.json`.
The worker streams a bounded GET, validates SHA-256 before ONNX consumption and
checks browser-cache hits again. It never POSTs tasks or data. Only exact pinned
manifest URLs can download weights. Unexpected library probes are blocked. The
model cache contains public weights only. It can be deleted with ordinary browser
site data; errors/cancellation never create a substitute plan.

Actual GET redirects observed for both graph and weights on 14 Nov 2026:
`https://huggingface.co` to `https://us.aws.cdn.hf.co/xet-bridge-us/...`.
The CDN redirect carries only a public model-file authorization query, no task.
No `cas-server.xethub.hf.co` or `cas-bridge.xethub.hf.co` redirect was observed.
Regional HF routing can change; newly blocked origins should fail visibly and be
reviewed, never broaden to wildcard origins.

Needed CSP additions for MAIN (this worker does not edit CSP):

```text
script-src 'self' 'wasm-unsafe-eval';
worker-src 'self';
connect-src 'self' https://huggingface.co https://us.aws.cdn.hf.co;
```

Keep other existing directives. Do not add `unsafe-eval`, CDN scripts, `blob:` or
upload endpoints. JS/MJS and WASM must have correct MIME types. WebGPU requires a
secure context (HTTPS or localhost); unsupported/failed GPU initialization tries
single-thread WASM CPU. A dedicated worker can be terminated to bound total time.

## Protocol

Request, exact fields only:

```js
{type:'plan',task:{version:1,goal:'public goal',columns:[{id:'C1',type:'text'}]},taskHash:'64 lowercase hex'}
```

Validation reuses MAIN `publicTask` and verifies `publicTaskHash` in the worker:
1-4 columns, aliases C1-C16, at most 1800 UTF-8 goal bytes, no forbidden controls.
No dataset, real header, filename, raw row, budget or key field is accepted.

Progress: `{type:'progress',stage,message,file?,loaded?,total?}`.
Result: `{type:'plan',raw:string,model:{id,revision,dtype,runtime,device,outputFormat,sourceRaw}}`.

The model emits flat operation tuples (`operation-tuples-v1`) to reduce nested JSON
errors at 0.6B. A deterministic syntax adapter groups its emitted IDs, operations
and constants into typed `{steps}`. It never examines goal text, infers operations,
adds constants, repairs JSON or drops unknown operations. `model.sourceRaw` retains
the exact neural tokens. A single unknown/malformed tuple rejects the entire plan.
MAIN still attaches version/hash and validates independently.
Error: `{type:'error',code:'LOCAL_MODEL_FAILED',stage,error}`. Error reason strips
URLs, HTML, controls and is capped to 180 characters. MAIN still must validate
raw output using `acceptAgentProposal`; a model response is never executable code.

`planWithLocalModel(request,{onProgress,signal,timeoutMs})` is an optional helper.
Default timeout is 300000ms, maximum 600000ms. It terminates on every exit. An
integrator may use its own dedicated worker lifecycle with the same protocol.

## Verification

```sh
node --test planner-runtime/*.test.mjs
node planner-runtime/download-model.mjs   # exactly one 412.5MB model, SHA checked
node planner-runtime/verify-generation.mjs
```

Download cache: `planner-runtime/.cache/onnx-community/Qwen3-0.6B-ONNX-OPT/`, ignored.
Native test checks exact model hashes and records actual raw generations and
validation in `generation-evidence.json`. Read its `passed` fields; existence is
not success. Browser GPU/WASM validation is a separate requirement and must not be
inferred from native CPU success. Negative semantic examples test fail-closed
behavior; an LLM cannot guarantee correct interpretation for all possible goals.

Primary sources: [Transformers.js stable release](https://github.com/huggingface/transformers.js/releases/tag/4.3.2),
[official model export](https://huggingface.co/onnx-community/Qwen3-0.6B-ONNX-OPT/tree/4799e655597b49210adb5c1ebe5b9d3bd04005a0),
[Qwen model and non-thinking mode](https://huggingface.co/Qwen/Qwen3-0.6B),
[ONNX environment and WASM paths](https://onnxruntime.ai/docs/tutorials/web/env-flags-and-session-options.html).

Verified native CPU result (14 Nov 2026): four exact supported plans (English and
Turkish; English/Turkish alias/constant holdouts using C2/C3, fill7, clamp10..80);
two standalone unsupported tasks emitted explicit unsupported; two mixed
trim/translation requests generated malformed JSON and were rejected entirely.
The latter establishes fail-closed validation, not reliable semantic refusal.
`generation-evidence.json` preserves source tokens, converted proposals, timings
and each rejection disposition. No claim of general semantic correctness follows.
