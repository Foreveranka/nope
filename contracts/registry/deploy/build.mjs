#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { openSync, closeSync } from 'node:fs';
import { join } from 'node:path';
import { ROOT, verifyArtifact, verifyFreshBuild } from './policy.mjs';
import { PRIVATE, privateDirectory, publicJson } from './storage.mjs';

privateDirectory();
verifyArtifact();
const log = openSync(join(PRIVATE, 'build.log'), 'w', 0o600);
const args = ['build', '--locked', '--release', '--target', 'wasm32-unknown-unknown', '--target-dir', join(PRIVATE, 'build')];
const result = spawnSync(join(ROOT, '../scripts/cargo-local.sh'), args, {
  cwd: ROOT, env: { ...process.env, RUSTFLAGS: '--cfg near' }, stdio: ['ignore', log, log],
});
closeSync(log);
if (result.status !== 0) throw new Error('BUILD_FAILED_SEE_PRIVATE_BUILD_LOG');
const artifact = verifyFreshBuild();
const evidence = { wasm_sha256: artifact.sha256, code_hash: artifact.code_hash, size_bytes: artifact.size_bytes,
  fresh_build_byte_identical: true, command: "RUSTFLAGS='--cfg near' ../scripts/cargo-local.sh build --locked --release --target wasm32-unknown-unknown --target-dir runtime/near-testnet/build",
  verified_at: new Date().toISOString() };
publicJson('build', evidence);
console.log(JSON.stringify(evidence, null, 2));
