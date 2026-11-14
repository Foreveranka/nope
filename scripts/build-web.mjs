// Allowlisted web/client publication. Never package runtime or private keys.
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const target = path.join(root, 'dist');
const files = ['nope-landing.css','nope-pixels.svg','nope-logo.svg','nope-display.ttf','PressStart2P-OFL.txt','nope-pixel.ttf','nope-mono.ttf','VT323-OFL.txt','SpaceMono-OFL.txt','workspace.html','workspace.css','workspace.js','workspace-vault.mjs','gc-verify-worker.mjs','csv-browser.js','csv-gc-worker.mjs','gc-core.mjs','gc-client.mjs','verify.html','verify.js','csv.html','csv.js','csv.css','csv-input.mjs','try.html','try.css','try.js','private-sum.mjs','privacy.html','privacy.js','privacy.css','testnet.html', 'testnet.js', 'market.html', 'market.js', 'market.css', 'sealed.mjs', 'index.html', 'app.html', 'demo.html', 'styles.css','landing.js', 'app.js', 'input.mjs', 'demo.js', 'deployment.mjs'];
await fs.rm(target, { recursive: true, force: true });
await fs.mkdir(target, { recursive: true });
for (const name of files) {
  const source = path.join(root, 'web', name);
  if (!(await fs.lstat(source)).isFile()) throw new Error(`Not a regular web asset: ${name}`);
  await fs.copyFile(source, path.join(target, name));
}
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
console.log(`Built ${files.length} static assets, invitation-only companion package, and recorded evidence. Cloud API is packaged separately; hosted payment actions remain disabled.`);
