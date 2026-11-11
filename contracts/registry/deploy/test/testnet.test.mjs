import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { KeyPairEd25519, actions, SignedTransaction, baseEncode } from 'near-api-js';
import { NETWORK, RPC, DOMAIN, DOMAIN_HEX, EMPTY_CODE, domainHash, sha256, requirePolicy, accountForPublicKey, deploymentPlan, verifyArtifact } from '../policy.mjs';
import { privateDirectory, PRIVATE } from '../storage.mjs';
import { TestnetRpc, RpcFailure, finalOutcome, assertActions, sendOnce } from '../transport.mjs';
import { inspect, syntheticConfig, verifySmokeJob } from '../registry.mjs';

const key = KeyPairEd25519.fromRandom();
const public_key = key.getPublicKey().toString();
const id = { account_id: accountForPublicKey(public_key), public_key, private_key: key.toString() };
const init = () => actions.functionCall('new', { owner: id.account_id, network_domain_hash: domainHash() }, 50_000_000_000_000n, 0n);
const good = hash => ({ final_execution_status: 'FINAL', status: { SuccessValue: '' },
  transaction: { hash, signer_id: id.account_id, receiver_id: id.account_id },
  transaction_outcome: { block_hash: 'block', outcome: { status: { SuccessReceiptId: 'r' } } },
  receipts_outcome: [{ outcome: { status: { SuccessValue: '' } } }] });

test('exact testnet endpoint policy rejects mainnet, alternate origins, redirects and credentials', () => {
  requirePolicy(NETWORK, RPC);
  for (const [network, rpc] of [['mainnet', RPC], ['testnet', 'https://rpc.mainnet.near.org'],
    ['testnet', RPC + '/'], ['testnet', RPC + '.evil'], ['testnet', 'http://rpc.testnet.near.org'],
    ['testnet', 'https://user@rpc.testnet.near.org']]) assert.throws(() => requirePolicy(network, rpc));
});
test('RPC verifies chain ID and disables redirects', async () => {
  let options;
  const rpc = new TestnetRpc({ fetcher: async (url, opts) => {
    assert.equal(url, RPC); options = opts;
    return { ok: true, json: async () => ({ result: { chain_id: 'mainnet' } }) };
  } });
  await assert.rejects(() => rpc.connect(), /RPC_CHAIN_IS_NOT_TESTNET/);
  assert.equal(options.redirect, 'error');
});
test('only UNKNOWN_ACCOUNT is treated as absent, not rate limits or arbitrary errors', async () => {
  const rpc = new TestnetRpc();
  rpc.query = async () => { throw new RpcFailure('RPC_ERROR', { cause: { name: 'UNKNOWN_ACCOUNT' } }); };
  assert.equal(await rpc.account(id.account_id), null);
  rpc.query = async () => { throw new RpcFailure('RPC_HTTP_429'); };
  await assert.rejects(() => rpc.account(id.account_id), /429/);
});
test('fixed network domain and reviewed local WASM are pinned', () => {
  assert.equal(sha256(DOMAIN).toString('hex'), DOMAIN_HEX);
  assert.equal(domainHash().length, 32);
  const artifact = verifyArtifact();
  assert.equal(artifact.sha256, '431e1bbfcf89c5f305e668c265b66d1cd70246a3546d59b48c578009be71c553');
  assert.equal(artifact.code_hash, baseEncode(sha256(artifact.bytes)));
});
test('deployment plans handle absent, empty, initialized and hostile state', () => {
  const expectedCode = verifyArtifact().code_hash;
  assert.throws(() => deploymentPlan({ account: null }, id.account_id), /FAUCET_ACCOUNT_REQUIRED/);
  assert.equal(deploymentPlan({ account: { code_hash: EMPTY_CODE }, expectedCode, initialized: false }, id.account_id), 'deploy-and-init');
  assert.equal(deploymentPlan({ account: { code_hash: expectedCode }, expectedCode, initialized: false }, id.account_id), 'init-only');
  const ready = { account: { code_hash: expectedCode }, expectedCode, initialized: true, owner: id.account_id, domain: domainHash() };
  assert.equal(deploymentPlan(ready, id.account_id), 'already-deployed');
  assert.throws(() => deploymentPlan({ ...ready, owner: 'outsider.testnet' }, id.account_id), /MISMATCH/);
  assert.throws(() => deploymentPlan({ ...ready, domain: Array(32).fill(1) }, id.account_id), /MISMATCH/);
  assert.throws(() => deploymentPlan({ ...ready, account: { code_hash: 'other' } }, id.account_id), /REFUSE_OVERWRITE/);
});
test('inspection refuses unknown code before querying its state', async () => {
  const rpc = { connect: async () => {}, account: async () => ({ code_hash: 'unreviewed' }), access: async () => {},
    query: async () => { assert.fail('must not query unreviewed code'); } };
  await assert.rejects(() => inspect(rpc, id), /REFUSE_OVERWRITE/);
});
test('action guard rejects funds, other wallets, other methods, code and wrong initialization', () => {
  assertActions([init()], id);
  for (const action of [actions.transfer(1n), actions.functionCall('create_job', {}, 1n, 1n),
    actions.functionCall('submit_result', {}, 1n, 0n), actions.deployContract(new Uint8Array([1])),
    actions.functionCall('new', { owner: id.account_id, network_domain_hash: Array(32).fill(0) }, 1n, 0n)]) {
    assert.throws(() => assertActions([action], id));
  }
  assert.throws(() => assertActions([init()], { ...id, account_id: 'existing-wallet.testnet' }), /FRESH_IDENTITY/);
});
test('finality and failed receipt guards fail closed', () => {
  assert.equal(finalOutcome(good('tx')).transaction.hash, 'tx');
  assert.throws(() => finalOutcome({ ...good('tx'), final_execution_status: 'EXECUTED_OPTIMISTIC' }), /NOT_FINAL/);
  assert.throws(() => finalOutcome({ ...good('tx'), status: { Failure: {} } }), /EXECUTION_FAILED/);
  assert.throws(() => finalOutcome({ ...good('tx'), receipts_outcome: [{ outcome: { status: { Failure: {} } } }] }), /RECEIPT_FAILED/);
});
test('unknown broadcast is journaled before sending and rerun only checks the same tx hash', async () => {
  privateDirectory();
  const dir = mkdtempSync(join(PRIVATE, 'offline-test-'));
  let sends = 0; let checks = 0; let expectedHash;
  const rpc = { connect: async () => {}, access: async () => ({ nonce: 0, block_hash: EMPTY_CODE }),
    request: async (method, args) => {
      const journal = JSON.parse(readFileSync(join(dir, 'test.json')));
      expectedHash = journal.tx_hash;
      if (method === 'send_tx') {
        sends++;
        const signed = SignedTransaction.decode(Buffer.from(args.signed_tx_base64, 'base64'));
        assert.equal(signed.transaction.receiverId, id.account_id);
        assert.equal(signed.transaction.actions[0].functionCall.methodName, 'new');
        throw new Error('simulated lost response');
      }
      assert.equal(method, 'tx'); assert.equal(args.tx_hash, expectedHash); checks++;
      return good(expectedHash);
    } };
  try {
    await assert.rejects(() => sendOnce(rpc, id, 'test', [init()], undefined, dir), /lost response/);
    assert.equal(statSync(join(dir, 'test.json')).mode & 0o777, 0o600);
    const result = await sendOnce(rpc, id, 'test', [init()], undefined, dir);
    assert.equal(result.transaction.hash, expectedHash);
    assert.equal(sends, 1); assert.equal(checks, 1);
    await assert.rejects(() => sendOnce(rpc, id, 'test', [actions.functionCall('create_job', {}, 1n, 0n)], undefined, dir), /JOURNAL_REQUEST_MISMATCH/);
    assert.equal(sends, 1);
  } finally { rmSync(dir, { recursive: true }); }
});
test('synthetic smoke uses one honest identity, string timestamps, nonzero distinct hashes', () => {
  const now = '1794456000000000000';
  const config = syntheticConfig(id, now);
  assert.deepEqual(config.authorized_bidders, [id.account_id]);
  assert.equal(config.executor, id.account_id);
  assert(BigInt(config.bid_deadline_ns) > BigInt(now));
  assert(BigInt(config.result_deadline_ns) > BigInt(config.bid_deadline_ns));
  const job = { job_id: '1', buyer: id.account_id, state: 'Open', config };
  verifySmokeJob(job, config, id.account_id);
  assert.throws(() => verifySmokeJob({ ...job, buyer: 'other.testnet' }, config, id.account_id), /MISMATCH/);
});
