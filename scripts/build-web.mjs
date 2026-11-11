// Allowlisted static publication only. Never package runtime, keys or Python.
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const target = path.join(root, 'dist');
const files = ['index.html', 'app.html', 'demo.html', 'styles.css', 'app.js', 'input.mjs', 'demo.js', 'deployment.mjs'];
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
await fs.writeFile(path.join(target, 'deployment.json'), JSON.stringify({ mode: 'hosted-evidence', summaryUrl: '/demo-evidence.json' }));
console.log(`Built ${files.length} static assets and sanitized recorded LOCAL test evidence. No runtime API or live payments.`);
