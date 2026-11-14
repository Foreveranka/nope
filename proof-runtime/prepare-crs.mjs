/** Offline build-time validation of checked-in public ceremony material.
 * No network fallback: a missing or altered approved asset fails the build. */
import fs from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {pathToFileURL} from 'node:url';
import {APPROVED} from './approved.mjs';
export async function prepareCrs() {
  for (const key of ['g1','g2','grumpkin']) {
    const asset=APPROVED.srs[key];
    if (!/^\.\/assets\/[a-zA-Z0-9_.-]+\.dat$/.test(asset.path)) throw new Error('Invalid public SRS asset path');
    const bytes=await fs.readFile(new URL(asset.path,import.meta.url));
    if (bytes.length!==asset.bytes || createHash('sha256').update(bytes).digest('hex')!==asset.sha256)
      throw new Error('Frozen public SRS integrity mismatch: '+asset.path);
  }
}
if (process.argv[1] && pathToFileURL(process.argv[1]).href===import.meta.url) {
  await prepareCrs();
  console.log('Checked-in public SRS verified offline');
}
