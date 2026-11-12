#!/usr/bin/env node
import {spawnSync} from 'node:child_process';
import {createRequire} from 'node:module';
import {pathToFileURL,fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';
import {readFileSync,writeFileSync} from 'node:fs';
import {join} from 'node:path';
const root=fileURLToPath(new URL('./',import.meta.url));
const result=spawnSync(join(root,'cargo-local.sh'),['build','--locked','--offline','--release','--target','wasm32-unknown-unknown'],{cwd:root,env:{...process.env,RUSTFLAGS:'--cfg near'},stdio:'inherit'});
if(result.status!==0)process.exit(result.status??1);
const require=createRequire(new URL('../registry/deploy/package.json',import.meta.url));
const {baseEncode}=await import(pathToFileURL(require.resolve('near-api-js')).href);
const hash=b=>createHash('sha256').update(b).digest();
const wasm=readFileSync(join(root,'target/wasm32-unknown-unknown/release/csv_evidence.wasm'));
const sources=['src/lib.rs','Cargo.toml','Cargo.lock','cargo-local.sh'];
const evidence={nearSdk:'5.30.1',rust:'1.98.0',command:"RUSTFLAGS='--cfg near' ./cargo-local.sh build --locked --offline --release --target wasm32-unknown-unknown",wasmSha256:hash(wasm).toString('hex'),codeHash:baseEncode(hash(wasm)),sizeBytes:wasm.length,sourceSha256:Object.fromEntries(sources.map(p=>[p,hash(readFileSync(join(root,p))).toString('hex')])),builtAt:new Date().toISOString()};
writeFileSync(join(root,'evidence/build.json'),JSON.stringify(evidence,null,2)+'\n');
console.log(JSON.stringify(evidence));
