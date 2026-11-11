#!/usr/bin/env node
import { join } from 'node:path';
import { NETWORK, RPC, DOMAIN_HEX, verifyArtifact, requirePolicy } from './policy.mjs';
import { prepareIdentity, loadIdentity, withLock, privateJson, PRIVATE, publicJson } from './storage.mjs';
import { TestnetRpc } from './transport.mjs';
import { faucet, deploy, smoke, inspect } from './registry.mjs';

// Explicit mandatory network flags; no .env, wallet discovery, default mainnet or global CLI config.
const [command, networkFlag, network, rpcFlag, rpc, ...extra] = process.argv.slice(2);
try {
  if (networkFlag !== '--network' || rpcFlag !== '--rpc' || extra.length) throw new Error('USAGE_COMMAND_NETWORK_RPC_REQUIRED');
  requirePolicy(network, rpc);
  if (!['prepare', 'check', 'faucet', 'deploy', 'smoke', 'view', 'inspect'].includes(command)) throw new Error('UNKNOWN_COMMAND');
  const result = await withLock(async () => {
    const artifact = verifyArtifact();
    if (command === 'prepare') return prepareIdentity();
    if (command === 'check') return { network: NETWORK, rpc: RPC, wasm_sha256: artifact.sha256,
      code_hash: artifact.code_hash, size_bytes: artifact.size_bytes, network_domain_hash_hex: DOMAIN_HEX };
    const id = loadIdentity();
    const client = new TestnetRpc({ network, url: rpc });
    if (command === 'faucet') return faucet(client, id);
    if (command === 'deploy') return deploy(client, id);
    if (command === 'smoke') return smoke(client, id);
    if (command === 'inspect') return inspect(client, id);
    await client.connect();
    return client.view(id.account_id, 'get_job', { job_id: '1' });
  });
  console.log(JSON.stringify(result, null, 2));
} catch (error) {
  // Never output arbitrary SDK/transport errors: their context can include key material.
  const code = /^[A-Z][A-Z0-9_]+$/.test(error.message) ? error.message : 'LOCAL_OR_TRANSPORT_ERROR';
  try { privateJson(join(PRIVATE, 'last-error.json'), { code, message: error.message, at: new Date().toISOString() }); } catch {}
  const result = { network: NETWORK, rpc: RPC, command, error: code, private_details_file: join(PRIVATE, 'last-error.json') };
  if (['faucet', 'deploy', 'smoke', 'view', 'inspect'].includes(command)) publicJson('last-attempt', { ...result, at: new Date().toISOString() });
  console.error(JSON.stringify(result));
  process.exitCode = 1;
}
