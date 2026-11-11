import { mkdirSync, readFileSync, writeFileSync, lstatSync, openSync, closeSync, fsyncSync, renameSync, unlinkSync, constants } from 'node:fs';
import { join } from 'node:path';
import { KeyPair, KeyPairEd25519 } from 'near-api-js';
import { ROOT, NETWORK, accountForPublicKey, requireAccount } from './policy.mjs';

export const PRIVATE = join(ROOT, 'runtime', 'near-testnet');
export const KEY_FILE = join(PRIVATE, 'identity.json');
export const json = path => JSON.parse(readFileSync(path, 'utf8'));
export function exists(path) {
  try { lstatSync(path); return true; } catch (e) { if (e.code === 'ENOENT') return false; throw e; }
}
export function privateDirectory() {
  for (const path of [join(ROOT, 'runtime'), PRIVATE]) {
    if (!exists(path)) mkdirSync(path, { mode: 0o700 });
    const s = lstatSync(path);
    if (!s.isDirectory() || s.isSymbolicLink() || (s.mode & 0o077)) throw new Error('UNSAFE_RUNTIME_PERMISSIONS');
  }
}
export function privateJson(path, value, exclusive = false) {
  privateDirectory();
  const destination = exclusive ? path : `${path}.tmp`;
  const fd = openSync(destination, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  try { writeFileSync(fd, JSON.stringify(value, null, 2) + '\n'); fsyncSync(fd); } finally { closeSync(fd); }
  if (!exclusive) renameSync(destination, path);
}
export function publicJson(name, value) {
  const path = join(ROOT, 'evidence');
  mkdirSync(path, { recursive: true });
  // Caller constructs explicitly public records; never serialize a signer/identity.
  writeFileSync(join(path, `${name}.json`), JSON.stringify(value, null, 2) + '\n', { mode: 0o644 });
}
export function loadIdentity() {
  privateDirectory();
  const st = lstatSync(KEY_FILE);
  if (!st.isFile() || st.isSymbolicLink() || (st.mode & 0o777) !== 0o600) throw new Error('KEY_MODE_MUST_BE_0600');
  const id = json(KEY_FILE);
  if (id.network !== NETWORK || id.purpose !== 'veil-registry-faucet-only-v1') throw new Error('FRESH_IDENTITY_REQUIRED');
  const key = KeyPair.fromString(id.private_key);
  if (key.getPublicKey().toString() !== id.public_key) throw new Error('IDENTITY_KEY_MISMATCH');
  requireAccount(id.account_id, id.public_key);
  return id;
}
export function prepareIdentity() {
  privateDirectory();
  if (!exists(KEY_FILE)) {
    // SDK uses crypto.getRandomValues(32 bytes), backed by OS entropy in Node.
    const key = KeyPairEd25519.fromRandom();
    const public_key = key.getPublicKey().toString();
    privateJson(KEY_FILE, {
      network: NETWORK, purpose: 'veil-registry-faucet-only-v1',
      account_id: accountForPublicKey(public_key), public_key,
      private_key: key.toString(), created_at: new Date().toISOString(),
    }, true);
  }
  const id = loadIdentity();
  const result = { network: NETWORK, account_id: id.account_id, public_key: id.public_key, private_key_file: KEY_FILE };
  publicJson('identity', result);
  return result;
}
// Mutating commands serialize across processes; stale lock requires explicit local inspection.
export async function withLock(fn) {
  privateDirectory();
  const path = join(PRIVATE, 'operation.lock');
  const fd = openSync(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o600);
  closeSync(fd);
  try { return await fn(); } finally { unlinkSync(path); }
}
