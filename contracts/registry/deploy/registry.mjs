import { actions } from 'near-api-js';
import { join } from 'node:path';
import { NETWORK, RPC, FAUCET, DOMAIN, DOMAIN_HEX, EMPTY_CODE, domainHash, verifyArtifact, verifyFreshBuild, deploymentPlan, sha256 } from './policy.mjs';
import { PRIVATE, KEY_FILE, exists, json, privateJson, publicJson } from './storage.mjs';
import { sendOnce } from './transport.mjs';

export async function inspect(rpc, id) {
  await rpc.connect();
  const artifact = verifyArtifact();
  const account = await rpc.account(id.account_id);
  if (!account) return { account: null, expectedCode: artifact.code_hash, initialized: false };
  await rpc.access(id);
  if (![EMPTY_CODE, artifact.code_hash].includes(account.code_hash)) throw new Error('REFUSE_OVERWRITE_OTHER_CODE');
  const state = await rpc.query({ request_type: 'view_state', account_id: id.account_id, prefix_base64: Buffer.from('STATE').toString('base64') });
  const initialized = state.values.some(v => v.key === Buffer.from('STATE').toString('base64'));
  const result = { account, expectedCode: artifact.code_hash, initialized };
  if (initialized) {
    result.owner = (await rpc.view(id.account_id, 'owner')).value;
    result.domain = (await rpc.view(id.account_id, 'network_domain_hash')).value;
  }
  return result;
}

export async function faucet(rpc, id, fetcher = fetch) {
  await rpc.connect();
  const account = await rpc.account(id.account_id);
  if (account) {
    await rpc.access(id);
    return { network: NETWORK, account_id: id.account_id, status: 'account-already-exists-no-faucet-request' };
  }
  const path = join(PRIVATE, 'faucet-attempt.json');
  if (exists(path)) throw new Error('FAUCET_ALREADY_ATTEMPTED_NO_AUTOMATIC_RETRY');
  privateJson(path, { attempted_at: new Date().toISOString(), account_id: id.account_id, endpoint: FAUCET }, true);
  let response;
  try {
    response = await fetcher(FAUCET, {
      method: 'POST', redirect: 'error', signal: AbortSignal.timeout(25000),
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ newAccountId: id.account_id, newAccountPublicKey: id.public_key }),
    });
  } catch {
    publicJson('faucet', { network: NETWORK, account_id: id.account_id, endpoint: FAUCET, status: 'transport-blocked-or-unknown', retry: false });
    throw new Error('FAUCET_TRANSPORT_BLOCKED_OR_UNKNOWN');
  }
  const text = await response.text();
  // Capture upstream body privately, never log it or pass it to public evidence wholesale.
  privateJson(join(PRIVATE, 'faucet-response.json'), { status: response.status, body: text });
  const summary = { network: NETWORK, account_id: id.account_id, endpoint: FAUCET, http_status: response.status,
    status: response.ok ? 'request-returned-check-chain' : 'faucet-blocked', retry: false };
  publicJson('faucet', summary);
  if (!response.ok) throw new Error(`FAUCET_HTTP_${response.status}_NO_RETRY`);
  const created = await rpc.account(id.account_id);
  if (!created) throw new Error('FAUCET_ACCOUNT_NOT_FINAL_YET_NO_RETRY');
  await rpc.access(id);
  const confirmed = { ...summary, status: 'account-confirmed-on-testnet' };
  publicJson('faucet', confirmed);
  return confirmed;
}

const publicTransaction = result => ({
  transaction_hash: result.transaction.hash,
  signer_id: result.transaction.signer_id,
  receiver_id: result.transaction.receiver_id,
  final_execution_status: result.final_execution_status,
  status: result.status,
  block_hash: result.transaction_outcome.block_hash,
});

export async function deploy(rpc, id) {
  const artifact = verifyFreshBuild();
  const before = await inspect(rpc, id);
  const plan = deploymentPlan(before, id.account_id);
  const txFile = join(PRIVATE, 'deploy.json');
  let tx;
  if (plan !== 'already-deployed') {
    const init = actions.functionCall('new', { owner: id.account_id, network_domain_hash: domainHash() }, 50_000_000_000_000n, 0n);
    const list = plan === 'deploy-and-init' ? [actions.deployContract(artifact.bytes), init] : [init];
    tx = await sendOnce(rpc, id, 'deploy', list, artifact.bytes);
  } else if (exists(txFile)) {
    tx = await rpc.request('tx', { tx_hash: json(txFile).tx_hash, sender_account_id: id.account_id, wait_until: 'FINAL' });
  }
  const after = await inspect(rpc, id);
  if (deploymentPlan(after, id.account_id) !== 'already-deployed') throw new Error('POST_DEPLOY_VERIFICATION_FAILED');
  const result = {
    network: NETWORK, rpc: RPC, account_id: id.account_id, public_key: id.public_key,
    private_key_file: KEY_FILE, wasm_sha256: artifact.sha256, code_hash: after.account.code_hash,
    size_bytes: artifact.size_bytes, network_domain: DOMAIN, network_domain_hash_hex: DOMAIN_HEX,
    owner: after.owner, network_domain_hash: after.domain, plan,
    transaction: tx ? publicTransaction(tx) : null, verified_at: new Date().toISOString(),
    production_ready: false, independent_participants: 1, execution_proof_verified: false,
  };
  publicJson('deployment', result);
  return result;
}

export function syntheticConfig(id, timestampNs) {
  const hash = name => Array.from(sha256(`veil/testnet/synthetic-smoke/v1/${name}`));
  return {
    spec_hash: hash('spec'), circuit_hash: hash('circuit'), key_hash: hash('key'),
    output_policy_hash: hash('executor-claim-only'), context_hash: hash('context'),
    input_hash: hash('synthetic-input'), budget_commitment: hash('no-real-payment'),
    bid_deadline_ns: (BigInt(timestampNs) + 86_400_000_000_000n).toString(),
    result_deadline_ns: (BigInt(timestampNs) + 172_800_000_000_000n).toString(),
    authorized_bidders: [id.account_id], executor: id.account_id,
  };
}
export function verifySmokeJob(job, config, account) {
  if (!job || job.job_id !== '1' || job.buyer !== account || job.state !== 'Open'
    || JSON.stringify(job.config) !== JSON.stringify(config)) throw new Error('SYNTHETIC_JOB_MISMATCH');
}
export async function smoke(rpc, id) {
  const current = await inspect(rpc, id);
  if (deploymentPlan(current, id.account_id) !== 'already-deployed') throw new Error('DEPLOY_FIRST');
  const requestPath = join(PRIVATE, 'smoke-config.json');
  const before = await rpc.view(id.account_id, 'get_job', { job_id: '1' });
  if (!exists(requestPath)) {
    if (before.value !== null) throw new Error('REFUSE_EXISTING_UNRECOGNIZED_JOB');
    const block = await rpc.request('block', { finality: 'final' });
    privateJson(requestPath, syntheticConfig(id, block.header.timestamp_nanosec), true);
  }
  const config = json(requestPath);
  let tx;
  if (before.value === null) {
    tx = await sendOnce(rpc, id, 'smoke', [actions.functionCall('create_job', { config }, 50_000_000_000_000n, 0n)]);
  } else if (exists(join(PRIVATE, 'smoke.json'))) {
    tx = await rpc.request('tx', { tx_hash: json(join(PRIVATE, 'smoke.json')).tx_hash, sender_account_id: id.account_id, wait_until: 'FINAL' });
  }
  const after = await rpc.view(id.account_id, 'get_job', { job_id: '1' });
  verifySmokeJob(after.value, config, id.account_id);
  const evidence = { network: NETWORK, rpc: RPC, account_id: id.account_id, code_hash: current.account.code_hash,
    synthetic: true, independent_participants: 1, roles_share_one_account: true,
    fhe_executed: false, mpc_executed: false, payment_executed: false, execution_proof_verified: false,
    transaction: tx ? publicTransaction(tx) : null, view: after, verified_at: new Date().toISOString() };
  publicJson('smoke', evidence);
  return evidence;
}
