// Allowlisted web/client publication. Never package runtime or private keys.
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import {createHash} from 'node:crypto';
import {packageAgentModel} from './package-agent-model.mjs';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const target = path.join(root, 'dist');
execFileSync(process.execPath,[path.join(root,'scripts/check-locales.mjs')],{stdio:'inherit'});
execFileSync(process.execPath,[path.join(root,'scripts/check-docs-locales.mjs')],{stdio:'inherit'});
const files = ['docs.html','docs.js','docs.css','docs-locales/tr.json','docs-locales/en.json','docs-locales/de.json','docs-locales/es.json','docs-locales/fr.json','i18n.mjs','i18n.css','locales/en.mjs','locales/tr.json','locales/en.json','locales/de.json','locales/es.json','locales/fr.json','proof-plan-core.mjs','proof-plan-client.mjs','proof-worker.mjs','public-proof.mjs','verify-proof.css','agent-plan.mjs','plan-core.mjs','plan-client.mjs','agent-model-worker.mjs','agent-model-runtime.mjs','recipes.html','recipes.js','recipe-csv.mjs','recipe-core.mjs','recipe-client.mjs','nope-landing.css','nope-pixels.svg','nope-logo.svg','nope-display.ttf','PressStart2P-OFL.txt','nope-pixel.ttf','nope-mono.ttf','VT323-OFL.txt','SpaceMono-OFL.txt','workspace.html','workspace.css','workspace.js','workspace-vault.mjs','gc-verify-worker.mjs','csv-browser.js','csv-gc-worker.mjs','gc-core.mjs','gc-client.mjs','verify.html','verify.js','csv.html','csv.js','csv.css','csv-input.mjs','try.html','try.css','try.js','private-sum.mjs','privacy.html','privacy.js','privacy.css','testnet.html', 'testnet.js', 'market.html', 'market.js', 'market.css', 'sealed.mjs', 'index.html', 'app.html', 'demo.html', 'styles.css','landing.js', 'app.js', 'input.mjs', 'demo.js', 'deployment.mjs'];
await fs.rm(target, { recursive: true, force: true });
await fs.mkdir(target, { recursive: true });
for (const name of files) {
  const source = path.join(root, 'web', name);
  if (!(await fs.lstat(source)).isFile()) throw new Error(`Not a regular web asset: ${name}`);
  await fs.mkdir(path.dirname(path.join(target,name)),{recursive:true});
  await fs.copyFile(source, path.join(target, name));
}
// Only vetted JS/WASM/model manifests enter the deployment, never model weights or caches.
const plannerAssets = await packageAgentModel();
const plannerTarget = path.join(target,'agent-model');
await fs.mkdir(plannerTarget,{recursive:true});
for (const asset of [...plannerAssets.files.map(f=>f.path),'assets.json']) {
  if(!/^[a-zA-Z0-9.-]+$/.test(asset)) throw new Error('Invalid planner asset name');
  await fs.copyFile(path.join(plannerAssets.outDir,asset),path.join(plannerTarget,asset));
}
// Build the real same-origin proof runtime from pinned packages and public assets.
execFileSync(process.execPath,[path.join(root,'proof-runtime/package-browser.mjs')],{stdio:'inherit'});
const proofDist=path.join(root,'proof-runtime/dist');
const proofAssets=JSON.parse(await fs.readFile(path.join(proofDist,'asset-manifest.json'),'utf8'));
if(proofAssets.version!==1||!Array.isArray(proofAssets.files)||proofAssets.files.length>20||proofAssets.totalBytes>64*1024*1024)throw Error('Invalid proof asset manifest');
const proofAllowed=new Set(['proof-sdk.js','proof-worker.js','artifacts/approved-manifest.json','artifacts/number.json','artifacts/number.vk','artifacts/text.json','artifacts/text.vk','assets/abi.wasm','assets/acvm.wasm','assets/barretenberg.wasm.gz','assets/barretenberg-threads.wasm.gz','assets/bn254_g1.dat','assets/bn254_g2.dat','assets/grumpkin_g1_v2.flat.dat']);
for(const asset of proofAssets.files){
 if(!proofAllowed.delete(asset.path)||!Number.isSafeInteger(asset.bytes)||asset.bytes<1||asset.bytes>40*1024*1024)throw Error('Unapproved proof asset');
 const source=path.join(proofDist,asset.path),dest=path.join(target,'proof-runtime',asset.path);
 if(!(await fs.lstat(source)).isFile())throw Error('Not a regular proof asset');
 const data=await fs.readFile(source);if(data.length!==asset.bytes||createHash('sha256').update(data).digest('hex')!==asset.sha256)throw Error('Proof asset integrity mismatch');
 await fs.mkdir(path.dirname(dest),{recursive:true});await fs.writeFile(dest,data);
}
if(proofAllowed.size)throw Error('Incomplete proof runtime package');
await fs.copyFile(path.join(proofDist,'asset-manifest.json'),path.join(target,'proof-runtime/asset-manifest.json'));
await fs.copyFile(path.join(root,'proof-runtime/policy.mjs'),path.join(target,'proof-runtime/policy.mjs'));
await fs.copyFile(path.join(root,'proof-runtime/approved.mjs'),path.join(target,'proof-runtime/approved.mjs'));
await fs.writeFile(path.join(target,'proof-runtime/sdk.mjs'),"export * from './proof-sdk.js';\n");
const evidence = JSON.parse(await fs.readFile(path.join(root, 'docs/verification/e2e-local-result.json'), 'utf8'));
if (evidence.completed !== true || evidence.real_payment !== false || evidence.external_chain !== false || evidence.payment_mode !== 'local_fixture_simulation') {
  throw new Error('Refusing to publish ambiguous/unverified evidence');
}
const fields = ['completed', 'elapsed_seconds', 'checks', 'payment_mode', 'real_fhe', 'real_mpc', 'actual_near_sandbox', 'independent_operators', 'real_payment', 'execution_proof'];
const result = Object.fromEntries(fields.map(key => [key, evidence[key]]));
result.rejected_registry_actions = evidence.rejected_registry_actions.map(({command, rejected}) => ({command, rejected}));
const run = { id: 'verified-local-run', status: 'completed', events: evidence.public_events || [], result };
await fs.writeFile(path.join(target, 'demo-evidence.json'), JSON.stringify({ run }, null, 2));
const testnetSource=path.join(root,'docs/verification/testnet-public-summary.json');
try {
 const raw=await fs.readFile(testnetSource,'utf8'), summary=JSON.parse(raw);
 if(summary.schema!==1||summary.network!=='testnet'||summary.completed!==true||!Array.isArray(summary.transactions))throw new Error('Invalid testnet evidence');
 await fs.writeFile(path.join(target,'testnet-evidence.json'),raw);
}catch(error){if(error.code!=='ENOENT')throw error;}
const privacySource=path.join(root,'docs/verification/privacy-demo-public.json');
try {
 const raw=await fs.readFile(privacySource,'utf8'), value=JSON.parse(raw);
 if(value.run?.status!=='completed'||value.run?.result?.network!=='testnet'||value.run?.result?.payment?.verified!==true||value.run?.result?.synthetic_only!==true||value.run?.result?.independent_operators!==false||value.run?.result?.execution_proof!==false)throw new Error('Invalid full privacy demo evidence');
 await fs.writeFile(path.join(target,'privacy-evidence.json'),raw);
}catch(error){if(error.code!=='ENOENT')throw error;}
await fs.copyFile(path.join(root,'docs/verification/csv-browser-proof.json'),path.join(target,'csv-proof.json'));
await fs.writeFile(path.join(target, 'deployment.json'), JSON.stringify({ mode: 'hosted-evidence', summaryUrl: '/demo-evidence.json' }));
execFileSync('python3', [path.join(root,'scripts/package-client.py'), path.join(target,'nope-client.zip')], {stdio:'inherit'});
// Preserve existing download links while publishing the new brand.
await fs.copyFile(path.join(target,'nope-client.zip'), path.join(target,'veil-client.zip'));
console.log(`Built ${files.length} static assets, invitation-only companion package, and recorded evidence. APIs are packaged separately; workspace testnet escrow requires explicit server configuration.`);
