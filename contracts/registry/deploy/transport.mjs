import { KeyPairSigner, PublicKey, createTransaction, baseDecode, baseEncode } from 'near-api-js';
import { join } from 'node:path';
import { RPC, NETWORK, requirePolicy, requireAccount, sha256, domainHash } from './policy.mjs';
import { PRIVATE, exists, json, privateJson } from './storage.mjs';

export class RpcFailure extends Error {
  constructor(code, detail) { super(code); this.detail = detail; }
}
export class TestnetRpc {
  constructor({ network = NETWORK, url = RPC, fetcher = fetch } = {}) {
    requirePolicy(network, url); this.url = url; this.fetcher = fetcher;
  }
  async request(method, params) {
    const response = await this.fetcher(this.url, {
      method: 'POST', redirect: 'error', signal: AbortSignal.timeout(25000),
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 'veil-testnet', method, params }),
    });
    if (!response.ok) throw new RpcFailure(`RPC_HTTP_${response.status}`);
    const result = await response.json();
    if (result.error) throw new RpcFailure('RPC_ERROR', result.error);
    return result.result;
  }
  async connect() {
    const status = await this.request('status', []);
    if (status.chain_id !== NETWORK) throw new Error('RPC_CHAIN_IS_NOT_TESTNET');
    return status;
  }
  query(request) { return this.request('query', { finality: 'final', ...request }); }
  async account(account_id) {
    try { return await this.query({ request_type: 'view_account', account_id }); }
    catch (e) {
      if (e instanceof RpcFailure && e.detail?.cause?.name === 'UNKNOWN_ACCOUNT') return null;
      throw e;
    }
  }
  async view(account_id, method_name, args = {}) {
    const result = await this.query({ request_type: 'call_function', account_id, method_name, args_base64: Buffer.from(JSON.stringify(args)).toString('base64') });
    return { value: JSON.parse(Buffer.from(result.result).toString('utf8')), block_hash: result.block_hash, block_height: result.block_height };
  }
  async access(id) {
    const key = await this.query({ request_type: 'view_access_key', account_id: id.account_id, public_key: id.public_key });
    if (key.permission !== 'FullAccess') throw new Error('FRESH_FULL_ACCESS_KEY_REQUIRED');
    return key;
  }
}
export function finalOutcome(result) {
  if (result.final_execution_status !== 'FINAL') throw new Error('TRANSACTION_NOT_FINAL_NO_RESUBMIT');
  if (!result.status || !Object.hasOwn(result.status, 'SuccessValue')) throw new Error('TRANSACTION_EXECUTION_FAILED');
  for (const item of [result.transaction_outcome, ...(result.receipts_outcome ?? [])]) {
    if (item?.outcome?.status?.Failure) throw new Error('TRANSACTION_RECEIPT_FAILED');
  }
  return result;
}
// Only these action shapes can ever be signed. No transfer, deletion, added keys or cross-contract call.
export function assertActions(actions, id, reviewedBytes) {
  requireAccount(id.account_id, id.public_key);
  if (!actions.length || actions.length > 2) throw new Error('ACTION_NOT_ALLOWED');
  for (const action of actions) {
    if (action.enum === 'deployContract') {
      if (!reviewedBytes || !Buffer.from(action.deployContract.code).equals(reviewedBytes)) throw new Error('UNREVIEWED_DEPLOY_ACTION');
    } else if (action.enum === 'functionCall') {
      const a = action.functionCall;
      if (!['new', 'create_job'].includes(a.methodName) || a.deposit !== 0n || a.gas > 100_000_000_000_000n) throw new Error('ACTION_NOT_ALLOWED');
      if (a.methodName === 'new') {
        const args = JSON.parse(Buffer.from(a.args).toString('utf8'));
        if (args.owner !== id.account_id || JSON.stringify(args.network_domain_hash) !== JSON.stringify(domainHash())) throw new Error('INITIALIZATION_POLICY_MISMATCH');
      }
    } else throw new Error('ACTION_NOT_ALLOWED');
  }
}
export async function sendOnce(rpc, id, label, actionList, reviewedBytes, journalDirectory = PRIVATE) {
  assertActions(actionList, id, reviewedBytes);
  if (!/^[a-z0-9-]+$/.test(label)) throw new Error('INVALID_JOURNAL_LABEL');
  const file = join(journalDirectory, `${label}.json`);
  const requestDigest = sha256(createTransaction(id.account_id, PublicKey.fromString(id.public_key), id.account_id,
    0n, actionList, new Uint8Array(32)).encode()).toString('hex');
  // Signed hash is persisted before broadcast. Unknown status never triggers automatic re-signing.
  if (exists(file)) {
    const old = json(file);
    if (old.account_id !== id.account_id || old.request_digest !== requestDigest) throw new Error('JOURNAL_REQUEST_MISMATCH');
    const result = finalOutcome(await rpc.request('tx', { tx_hash: old.tx_hash, sender_account_id: id.account_id, wait_until: 'FINAL' }));
    return result;
  }
  await rpc.connect();
  const access = await rpc.access(id);
  // Parse JSON integers without nonce precision loss: nonce remains well below 2^53 on this fresh key.
  if (!Number.isSafeInteger(access.nonce)) throw new Error('UNSAFE_NONCE');
  const transaction = createTransaction(id.account_id, PublicKey.fromString(id.public_key), id.account_id,
    BigInt(access.nonce) + 1n, actionList, baseDecode(access.block_hash));
  const signer = KeyPairSigner.fromSecretKey(id.private_key);
  const signed = await signer.signTransaction(transaction);
  privateJson(file, { tx_hash: baseEncode(signed.txHash), account_id: id.account_id, label,
    request_digest: requestDigest,
    action_digest: sha256(transaction.encode()).toString('hex'), prepared_at: new Date().toISOString() }, true);
  return finalOutcome(await rpc.request('send_tx', { signed_tx_base64: Buffer.from(signed.signedTransaction.encode()).toString('base64'), wait_until: 'FINAL' }));
}
