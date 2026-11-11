import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { baseEncode } from 'near-api-js';

export const ROOT = fileURLToPath(new URL('./', import.meta.url));
export const NETWORK = 'testnet';
export const RPC = 'https://rpc.testnet.near.org';
// Official near-cli-rs testnet faucet configuration, checked 2026-11-12.
export const FAUCET = 'https://helper.nearprotocol.com/account';
export const DOMAIN = 'veil/registry/network/v1:near:testnet';
export const sha256 = value => createHash('sha256').update(value).digest();
// Explicit fixed domain; not inferred from an environment variable or RPC response.
export const DOMAIN_HEX = 'b913ada2cc6f5e0f14bc58b1515dc858d28730f9fbccc078dc74ef98df6ffb9d';
export const domainHash = () => Array.from(Buffer.from(DOMAIN_HEX, 'hex'));
export const EMPTY_CODE = '11111111111111111111111111111111';

export function requirePolicy(network, rpc) {
  if (network !== NETWORK || rpc !== RPC) throw new Error('TESTNET_ENDPOINT_REQUIRED');
}
export function accountForPublicKey(publicKey) {
  return `veil-reg-${sha256(publicKey).toString('hex').slice(0, 16)}.testnet`;
}
export function requireAccount(account, publicKey) {
  if (account !== accountForPublicKey(publicKey)) throw new Error('FRESH_IDENTITY_REQUIRED');
}
export function verifyArtifact() {
  const lock = JSON.parse(readFileSync(new URL('./artifact-lock.json', import.meta.url)));
  const bytes = readFileSync(new URL('../target/wasm32-unknown-unknown/release/veil_registry.wasm', import.meta.url));
  if (sha256(bytes).toString('hex') !== lock.sha256 || bytes.length !== lock.size_bytes) {
    throw new Error('REVIEWED_WASM_MISMATCH');
  }
  const reviewed = JSON.parse(readFileSync(new URL('../verification/artifact.json', import.meta.url)));
  if (reviewed.sha256 !== lock.sha256) throw new Error('REVIEWED_METADATA_MISMATCH');
  for (const [path, expected] of Object.entries(lock.source_sha256)) {
    if (sha256(readFileSync(new URL(`../${path}`, import.meta.url))).toString('hex') !== expected) {
      throw new Error('CONTRACT_SOURCE_CHANGED_REVIEW_REQUIRED');
    }
  }
  return { bytes, sha256: lock.sha256, code_hash: baseEncode(sha256(bytes)), size_bytes: bytes.length };
}

export function verifyFreshBuild() {
  const artifact = verifyArtifact();
  const rebuilt = readFileSync(new URL('./runtime/near-testnet/build/wasm32-unknown-unknown/release/veil_registry.wasm', import.meta.url));
  if (!rebuilt.equals(artifact.bytes)) throw new Error('FRESH_BUILD_DOES_NOT_MATCH_REVIEWED_WASM');
  return artifact;
}

export function deploymentPlan({ account, expectedCode, initialized, owner, domain }, expectedAccount) {
  if (!account) throw new Error('FAUCET_ACCOUNT_REQUIRED');
  if (account.code_hash !== EMPTY_CODE && account.code_hash !== expectedCode) {
    throw new Error('REFUSE_OVERWRITE_OTHER_CODE');
  }
  if (initialized) {
    if (account.code_hash !== expectedCode || owner !== expectedAccount || JSON.stringify(domain) !== JSON.stringify(domainHash())) {
      throw new Error('EXISTING_INITIALIZATION_MISMATCH');
    }
    return 'already-deployed';
  }
  return account.code_hash === EMPTY_CODE ? 'deploy-and-init' : 'init-only';
}
