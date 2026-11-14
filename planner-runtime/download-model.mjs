/** Downloads this one allowlisted model only; streams to disk while hashing. */
import fs from 'node:fs/promises';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {fileURLToPath} from 'node:url';
const root = path.dirname(fileURLToPath(import.meta.url));
const pack = JSON.parse(await fs.readFile(path.join(root,'model-pack.json'),'utf8'));
const cache = path.join(root,'.cache',pack.id);
for (const file of pack.files) {
  const target = path.join(cache,file.path);
  try {
    const data = await fs.readFile(target);
    if (data.length === file.bytes && createHash('sha256').update(data).digest('hex') === file.sha256) {
      console.log('verified existing',file.path); continue;
    }
  } catch {}
  await fs.mkdir(path.dirname(target),{recursive:true});
  const response = await fetch(`https://huggingface.co/${pack.id}/resolve/${pack.revision}/${file.path}`,{signal:AbortSignal.timeout(240000)});
  if (!response.ok) throw new Error(`Download failed ${file.path}: ${response.status}`);
  console.log('download',file.path,response.url.split('?')[0]);
  const hash = createHash('sha256'); let size = 0;
  const handle = await fs.open(target+'.partial','w');
  try {
    for await (const chunk of response.body) {
      size += chunk.length;
      if (size > file.bytes) throw new Error('Oversized model asset.');
      hash.update(chunk); await handle.write(chunk);
    }
  } finally { await handle.close(); }
  if (size !== file.bytes || hash.digest('hex') !== file.sha256) throw new Error(`Integrity failed: ${file.path}`);
  await fs.rename(target+'.partial',target);
  console.log('verified',file.path,size);
}
