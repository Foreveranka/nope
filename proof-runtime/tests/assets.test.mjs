import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {APPROVED} from '../approved.mjs';
import {proofPolicy} from '../policy.mjs';
const sha=b=>createHash('sha256').update(b).digest('hex');
test('approved SRS is public source assets with frozen byte hashes and policy paths',async()=>{
 let bytes=0;
 for(const key of ['g1','g2','grumpkin']){
  const a=APPROVED.srs[key];assert.match(a.path,/^\.\/assets\/[a-zA-Z0-9_.-]+\.dat$/);
  assert.deepEqual(proofPolicy.srs[key],a);
  const b=await fs.readFile(new URL('../'+a.path.slice(2),import.meta.url));
  assert.equal(b.length,a.bytes);assert.equal(sha(b),a.sha256);bytes+=b.length;
 }
 assert.equal(bytes,37748864);
});
test('browser allowlist copies the same SRS under assets without stale cache files',async()=>{
 const manifest=JSON.parse(await fs.readFile(new URL('../dist/asset-manifest.json',import.meta.url)));
 assert.equal(manifest.files.length,14);assert.equal(manifest.files.some(f=>f.path.startsWith('.cache/')),false);
 for(const key of ['g1','g2','grumpkin']){const a=APPROVED.srs[key],entry=manifest.files.find(f=>f.path===a.path.slice(2));assert.equal(entry.sha256,a.sha256);assert.equal(entry.bytes,a.bytes);const b=await fs.readFile(new URL('../dist/'+entry.path,import.meta.url));assert.equal(sha(b),a.sha256);}
});
test('Node independently verifies both proofs with network and cache reads forbidden',()=>{
 const r=spawnSync(process.execPath,[new URL('./assets-verify-process.mjs',import.meta.url).pathname],{encoding:'utf8'});
 assert.equal(r.status,0,r.stderr+r.stdout);assert.match(r.stdout,/VERIFIED assets-only number,text/);
});
