#!/usr/bin/env node
import { pathToFileURL } from 'node:url';
import { ROOT, NETWORK, RPC, DOMAIN_HEX, domainHash, requirePolicy, requireAccount, verifyArtifact } from './policy.mjs';
import { json } from './storage.mjs';
import { TestnetRpc } from './transport.mjs';

// Read-only client: public evidence is sufficient. No wallet import or signing key is loaded.
export class RegistryTestnetClient {
  constructor({ network, rpc, accountId, publicKey }) {
    requirePolicy(network, rpc); requireAccount(accountId, publicKey);
    this.accountId = accountId;
    this.rpc = new TestnetRpc({ network, url: rpc });
  }
  async connect() {
    await this.rpc.connect();
    const account = await this.rpc.account(this.accountId);
    if (account?.code_hash !== verifyArtifact().code_hash) throw new Error('CONTRACT_CODE_MISMATCH');
    const owner = await this.rpc.view(this.accountId, 'owner');
    const domain = await this.rpc.view(this.accountId, 'network_domain_hash');
    if (owner.value !== this.accountId || JSON.stringify(domain.value) !== JSON.stringify(domainHash())) throw new Error('INITIALIZATION_POLICY_MISMATCH');
    return { network: NETWORK, rpc: RPC, account_id: this.accountId, code_hash: account.code_hash,
      owner: owner.value, network_domain_hash_hex: DOMAIN_HEX };
  }
  async getJob(jobId) {
    if (!/^[1-9][0-9]*$/.test(jobId) || BigInt(jobId) > 18446744073709551615n) throw new Error('INVALID_JOB_ID');
    await this.connect();
    return this.rpc.view(this.accountId, 'get_job', { job_id: jobId });
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const [jobId, nf, network, rf, rpc, ...extra] = process.argv.slice(2);
    if (nf !== '--network' || rf !== '--rpc' || extra.length) throw new Error('EXPLICIT_NETWORK_AND_RPC_REQUIRED');
    const identity = json(`${ROOT}evidence/identity.json`);
    const client = new RegistryTestnetClient({ network, rpc, accountId: identity.account_id, publicKey: identity.public_key });
    console.log(JSON.stringify(await client.getJob(jobId), null, 2));
  } catch (e) {
    console.error(JSON.stringify({ network: NETWORK, error: /^[A-Z][A-Z0-9_]+$/.test(e.message) ? e.message : 'READ_ONLY_CLIENT_FAILED' }));
    process.exitCode = 1;
  }
}
