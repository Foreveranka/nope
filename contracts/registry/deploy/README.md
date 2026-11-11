# NEAR testnet registry deployment

Only this directory is changed. Contract logic, root packages and other workers' files
are untouched. This deploys the existing reviewed registry, not FHE/MPC computation,
payments, an attestation service or a production system.

## Actual public deployment

- Network: **testnet**, RPC strictly `https://rpc.testnet.near.org`.
- Contract / owner: `veil-reg-e138f5c88250f821.testnet`.
- Public key: `ed25519:EAuYFJXHyJy2w2miPvyJeMtYpJBBBf9NWvqxFQW44sZk`.
- Deployment and private self-initialization were one atomic transaction:
  [`2Jf5HeHAphLfYHWGvR4Tvd3wBs5ZFirbbdHqAWFSdf2L`](https://testnet.nearblocks.io/txns/2Jf5HeHAphLfYHWGvR4Tvd3wBs5ZFirbbdHqAWFSdf2L).
- WASM SHA-256: `431e1bbfcf89c5f305e668c265b66d1cd70246a3546d59b48c578009be71c553`.
- On-chain code hash: `5WzwjqPvm3nRz6CEkkx73R8dcBtu3YBH6gr6DnoccSEv`.
- Fixed domain: `veil/registry/network/v1:near:testnet`; SHA-256
  `b913ada2cc6f5e0f14bc58b1515dc858d28730f9fbccc078dc74ef98df6ffb9d`.
- Key file: `runtime/near-testnet/identity.json` (0600, ignored, never publish).
  Absolute path is recorded in the public identity evidence; file contents are private.
- One successful official free-faucet request funded this new identity. No existing
  wallet, mainnet connection, real asset, paid service or user contact was used.

Public records: [identity](evidence/identity.json), [fresh build](evidence/build.json),
[faucet](evidence/faucet.json), [deployment and views](evidence/deployment.json),
[synthetic create-job/view](evidence/smoke.json). Timestamps are UTC.
`verification/artifact.json` one directory above remains historical local verification;
this directory records the later live deployment without rewriting that history.

## Reproduce / inspect

Run in `contracts/registry/deploy/` with Node >=22.22.2:

```sh
npm ci --ignore-scripts --no-audit --no-fund
npm test
node build.mjs
node cli.mjs check --network testnet --rpc https://rpc.testnet.near.org
node cli.mjs prepare --network testnet --rpc https://rpc.testnet.near.org
node cli.mjs faucet --network testnet --rpc https://rpc.testnet.near.org
node cli.mjs deploy --network testnet --rpc https://rpc.testnet.near.org
node cli.mjs smoke --network testnet --rpc https://rpc.testnet.near.org
node client.mjs 1 --network testnet --rpc https://rpc.testnet.near.org
```

`client.mjs` is read-only and uses public identity evidence; it never loads a secret key.
The synthetic smoke creates only job 1, with the same single account honestly filling
owner/bidder/executor roles. It does not claim three independent parties or run a full
auction. All commitment values are synthetic. It attaches zero deposit.

`build.mjs` uses the existing project-scoped Rust toolchain and places all generated
output inside ignored `runtime/near-testnet/`. Deployment requires a byte-identical
fresh build, the existing reviewed WASM, pinned artifact metadata and unchanged source
fingerprints (`artifact-lock.json`). No rebuilt unreviewed WASM is substituted.

## Mutation guards and reruns

Every chain operation is restricted to the exact RPC above and checks `chain_id=testnet`.
HTTP redirects are rejected. There is no environment-driven RPC, wallet discovery,
global CLI config, seed import, transfer action, paid provider, or mainnet fallback.
The SDK is pinned to `near-api-js@7.5.3` with a local package lock and dependencies.

`prepare` generates an Ed25519 identity with the SDK's OS-backed
`crypto.getRandomValues`, exclusively writes the secret file at 0600, and only prints
its account/public key/path. It never invokes CLI secret-printing commands. Runtime
directories are private; mutation commands are serialized with a local lock.

`faucet` first checks account existence and key ownership. It records the attempt
before the single POST to the official CLI's testnet faucet endpoint. It never repeats
a request automatically, including on login/captcha/rate-limit/unknown outcomes.
Upstream response bodies remain private. If the response is delayed, inspect the
account on-chain; do not delete the journal and retry blindly.

`deploy` inspects account/code/STATE/owner/domain before mutation, refuses foreign code
or incompatible initialization, and self-signs deploy+`new` atomically. An already
initialized matching registry is left unchanged. `smoke` first reads job 1, preserves
its prepared configuration and refuses to replace an unrecognized existing job.

Each signed transaction hash is durably journaled before broadcast. A rerun queries
that hash rather than re-signing or broadcasting another mutation. Unknown/failed
transactions stop for inspection; there is intentionally no automatic recovery that
could duplicate a job. A process crash may leave an operation lock: inspect it and
the transaction journal locally before removing a stale lock. Do not delete keys or
journals as a retry mechanism. CLI errors print bounded codes; error context stays
under ignored runtime. Public evidence is assembled from explicit public fields.

## Official references checked 12 November 2026

- [NEAR API documentation](https://docs.near.org/tools/near-api): local signing,
  contract calls and WASM deployment. Installed package declarations and SDK source
  were checked against these current examples.
- [NEAR CLI documentation](https://docs.near.org/tools/near-cli):
  `account create-account sponsor-by-faucet-service ... network-config testnet create`.
  CLI was verified from official docs/source; it was not installed globally or used
  to generate/log credentials.
- [Official CLI faucet request implementation](https://github.com/near/near-cli-rs/blob/main/src/commands/account/create_account/sponsor_by_faucet_service/mod.rs):
  public-only POST fields `newAccountId` and `newAccountPublicKey`.
- [Official CLI network configuration](https://github.com/near/near-cli-rs/blob/main/src/config/mod.rs):
  testnet faucet `https://helper.nearprotocol.com/account`. Only this explicitly
  verified faucet is permitted in addition to the exact user-approved RPC.
- [Official near-api-js repository](https://github.com/near/near-api-js): installed
  npm package version verified as 7.5.3 and pinned locally. No root package changes.
