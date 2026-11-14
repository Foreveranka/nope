/** Self-host JS + WASM only. Weights stay pinned remote downloads, never deployment files. */
import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';
import {build} from '../planner-runtime/node_modules/esbuild/lib/main.js';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export async function packageAgentModel({outDir = path.join(root,'runtime/agent-model-public')} = {}) {
  outDir = path.resolve(outDir);
  await fs.mkdir(outDir,{recursive:true});
  await build({stdin:{contents:"export {pipeline,env} from '@huggingface/transformers';",resolveDir:path.join(root,'planner-runtime'),sourcefile:'agent-model-entry.mjs'},
    bundle:true,platform:'browser',format:'esm',target:'es2022',minify:true,
    outfile:path.join(outDir,'transformers.mjs'),legalComments:'eof'});
  const wasmFiles = ['ort-wasm-simd-threaded.asyncify.mjs','ort-wasm-simd-threaded.asyncify.wasm'];
  for (const name of wasmFiles) await fs.copyFile(path.join(root,'planner-runtime/node_modules/onnxruntime-web/dist',name),path.join(outDir,name));
  await fs.copyFile(path.join(root,'planner-runtime/model-pack.json'),path.join(outDir,'model-pack.json'));
  await fs.copyFile(path.join(root,'planner-runtime/node_modules/@huggingface/transformers/LICENSE'),path.join(outDir,'transformers-LICENSE.txt'));
  await fs.copyFile(path.join(root,'planner-runtime/onnxruntime-LICENSE.txt'),path.join(outDir,'onnxruntime-LICENSE.txt'));
  const files = [];
  for (const name of ['transformers.mjs',...wasmFiles,'model-pack.json','transformers-LICENSE.txt','onnxruntime-LICENSE.txt']) {
    const bytes = await fs.readFile(path.join(outDir,name));
    files.push({path:name,bytes:bytes.length,sha256:createHash('sha256').update(bytes).digest('hex')});
  }
  const manifest = {version:1,files,totalBytes:files.reduce((sum,file)=>sum+file.bytes,0)};
  await fs.writeFile(path.join(outDir,'assets.json'),JSON.stringify(manifest,null,2)+'\n');
  return {outDir,...manifest};
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  if (args.length && !(args.length === 2 && args[0] === '--outDir')) throw new Error('Usage: node scripts/package-agent-model.mjs [--outDir path]');
  console.log(JSON.stringify(await packageAgentModel(args.length ? {outDir:args[1]} : {}),null,2));
}
