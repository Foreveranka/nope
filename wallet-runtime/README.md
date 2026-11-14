# Testnet wallet runtime

`web/wallet-client.mjs` adapts pinned `@hot-labs/near-connect` **0.12.0** to NOPE's
wallet-funded escrow. esbuild **0.25.12** packages the real SDK and reviewed Intear
executor into same-origin assets. See [NEAR Connect docs](https://docs.near.org/tools/near-connect)
and the [wallet login guide](https://docs.near.org/web3-apps/tutorials/wallet-login).
The client supports testnet only. Connect/sign/send are invoked by explicit UI
actions; constructing the adapter performs none of them.

## Build and policy

From the repository root:

```sh
npm ci --prefix wallet-runtime --ignore-scripts
node wallet-runtime/package-browser.mjs
node --test tests/wallet-client.test.mjs
```

Packaging is offline after installation. The main build copies exactly five
assets from `dist/` into `/wallet-runtime/`, checking bytes and SHA-256 against
`dist/asset-manifest.json`. It also publishes that manifest as metadata. Do not
publish node_modules or review sources. Executable assets total **71,241 bytes**;
local dependencies occupy about 10 MiB.

| Asset | Bytes | SHA-256 |
| --- | ---: | --- |
| wallet-sdk.js | 51975 | 409454b636d0e96143bf383ce1a2eca134d6bd1ab519ed633f2689adebc2a3fd |
| bridge.js | 4420 | 51a2f08323a1b4dba6b06fc891aa4f1031768b67483344412d4d9841c014f432 |
| bridge.html | 313 | 0651471c9dfc8ad1c4ded6d309261b4f9028e24e843490a497efd1f81edacec4 |
| intear-executor.js | 13815 | 7a9d13b3bb3066bd70370c715a04ef98209f16cb743a5573959bd808ad08d41f |
| wallet.css | 718 | dd054bfdfa9940fac1e97556b758602715a279704d1826f14837fab56b9c96c9 |

Browser [wallet-pins.mjs](../web/wallet-pins.mjs) and server
[wallet-config.mjs](../workspace/wallet-config.mjs) contain exactly the same five
keys: network, contractId, codeHash, domain and requireKeyless. Current contract is
`nope-wallet-44384e2f.testnet`, code hash
`6qzVqhNyk7KKvjzC6g8iPtJmHffTgb6YBh8Fp9xerXHy`, domain
`NOPE:WALLET-ESCROW:V1:testnet`, with `requireKeyless:true`. The server verifies
matching FINAL code and an empty contract key list. Limits are **1 testNEAR per
job** and **50 permanent holds**. The application result-proof adapter accepts the same **1 yoctoNEAR–1 testNEAR** range, committing the exact canonical decimal price into the final proof context. Real endpoint proofs cover both boundaries and reject price substitution. New payments come from the buyer's own wallet;
legacy sponsor/direct-transfer jobs are historical read-only records.

## Adapter API

```js
import {createWalletClient} from './wallet-client.mjs'; // from web/
const wallet = createWalletClient({window, network:'testnet'});
await wallet.connect({walletId:'intear-wallet', accountId});
await wallet.currentAccount();
await wallet.signChallenge(challenge);
await wallet.sendTransaction(intent, bounds);
await wallet.completeRedirect();
await wallet.disconnect();
```

`connect()` presents a picker when walletId is omitted. Multiple accounts require
an explicit accountId or selectAccount callback. It returns
`{accountId,walletId,network:'testnet',publicKey?}`; currentAccount returns null until
connected. The underlying SDK connect method returns the wallet object. Injected
connectorFactory is a unit seam, never a fake production signer.

`signChallenge()` accepts the exact backend challenge: challengeId, network,
accountId, sessionId, role, origin, nonce, issuedAt, expiresAt, message, recipient
and callbackUrl. It validates the canonical context, preserves the signed callback
and passes a 32-byte nonce. Result is
`{challengeId,accountId,publicKey,signature}`: ed25519 base58 public key, canonical
base64 64-byte signature. A redirect returns `{redirected:true,challengeId}`.
The server independently checks the signature, single-use challenge and FINAL
FullAccess key. Challenge lifetime is five minutes.

`sendTransaction(intent,bounds)` accepts these shapes:

```js
// Backend intent; action is fund | record | release | refund.
{id, action, network:'testnet', bindingHash,
 transaction:{signerId, receiverId, actions:[{
  type:'FunctionCall', params:{methodName,args,gas,deposit}
 }]}}
// Bounds derived from the immutable displayed job.
{action,jobId,bindingHash,accountId,contractId,buyerAccount,
 provider,amountYocto,version,outputHash}
```

Optional bounds: network, buyerCommitment, inputHash, programHash, planHash,
executionDeadlineNs, reviewDeadlineNs, expectedArgs, gas and deposit. Fund requires
provider/amount; record requires provider; record/release require version/output.
Record signer must be exactly the bounded provider **or buyer** for recovery.
Fund/release/refund remain buyer-only. Standard UI recording uses the provider.

Only one FunctionCall at 150 Tgas to the pinned contract is accepted:
`fund`, `record_delivery`, `accept_and_release` or `refund`. Fund deposit equals
terms.amount, from 1 yoctoNEAR through 1 testNEAR; other deposits are zero. The
client recomputes fund's ordered all-string binding tuple and checks namespace,
recipient, hashes, deadlines and immutable bounds. JSON snapshots preserve args
order and isolate caller/SDK mutations; returned transaction args must match the
approved `JSON.stringify(args)` bytes. expectedArgs additionally checks caller
supplied exact args order. The wallet must preserve these bytes too.

Submission returns `{transactionHash}` or `{redirected:true,intentId}`. Neither
means FINAL, PAID or a valid proof. Backend observation checks transaction,
receipts and contract state separately. Every SDK transaction error becomes
`WALLET_TRANSACTION_UNKNOWN`, including rejected/closed messages; do not retry
automatically. `WALLET_REJECTED` is connection/message cancellation, not proof
that a transaction was never broadcast. Validation fails before SDK invocation.

`completeRedirect()` returns null, `{kind:'challenge',result}` or
`{kind:'transaction',intentId,transactionHash}`. It checks pending metadata,
origin, /settings path, state ID and callback fields, scrubs callback parameters
and never signs. Wrong-state or transaction-error callbacks cannot clear unknown
transactions. Expired login challenges can restart; transaction metadata never
expires away. Disconnect resets adapter metadata; the frontend must retain its
separate backend-observation recovery capsule for unknown sends.

Refund is an explicit buyer transaction after review expiry, returning that
job's deposit to the original buyer's wallet. The backend may retire an expired
record intent using matching FINAL time/state so it cannot block refund; it does
not relax unknown fund/release/refund guards. See [backend state/API docs](../workspace/README.md).

## Storage and opaque transport

Only `nope.wallet.client.v1.account` and `.pending` use sessionStorage. They contain
public account/operation metadata, not workspace tokens, CSV, nonce, signature or
wallet secrets. Workspace session storage is untouched. SDK selected-wallet and
Intear transport state are memory-only. Intear generates an ephemeral Ed25519
**transport-authentication** key for popup requests; it is not a NEAR account
signing key or registered FunctionCall key and disappears on reload. Real account
signing stays in the wallet; the adapter does not extract browser wallet stores.

`sdk-patches.mjs` replaces published inline/srcdoc packaging with static modules
and checks exact version-pinned source patterns. The parent validates iframe
source, null origin, random 256-bit capability, protocol, request ID, method and
response status; the child validates parent source/origin/capability and methods.
The sandbox is exactly `allow-scripts allow-popups allow-popups-to-escape-sandbox`.
Never combine it with allow-same-origin. There is no eval, new Function, blob
worker or runtime CDN executor download.

Deployment requirements in [vercel.json](../vercel.json):

- Global frame-src self; script-src self/wasm-unsafe-eval, no inline/eval exception.
- Only the bridge route overrides X-Frame-Options to SAMEORIGIN and frame-ancestors
  to self; other pages retain DENY/none.
- Public static wallet-runtime assets use Access-Control-Allow-Origin:* and
  Cross-Origin-Resource-Policy:cross-origin for opaque Origin:null module loads.
  No credentialed CORS is needed.
- The wallet popup is restricted to https://wallet.intear.tech. The reviewed web
  popup path needs no additional remote frame/connect/form origins or native bridge.

The official [manifest](https://raw.githubusercontent.com/hot-dao/near-selector/refs/heads/main/repository/manifest.json)
identifies https://wallet.intear.tech/near-selector.js; its immutable local copy's
upstream SHA `6decc283352af197feff4988628899d19e05f4168a4277fe699bd8a0d6178e34`
is enforced before packaging. The packaged copy applies only two checked field
renames, `callback_url` to `callbackUrl`, before transport hashing/signing. The
official wallet's [MessageToSign deserializer](https://github.com/INTEARnear/wallet/blob/main/web/src/pages/sign_message.rs#L75)
uses serde camelCase; the old snake_case field was ignored, so the wallet signed
an absent callback while NOPE correctly required `/settings`. Packaging records
both upstream and executed hashes plus `nep413-callback-camelcase-v1` in the asset
manifest. Backend authentication is not relaxed. The outer executor drops callbackUrl, so the
bridge invokes its real public inner connectedAccount.signMessage with the full
server payload. This is not a synthetic signing fallback. All five labels come
from the existing app i18n instance and are converted with `String(msg(...))`
before the SDK's strict primitive-string guard. No second i18n instance is bundled.

### Exact pinned Intear popup protocol

The executor opens `https://wallet.intear.tech/connect`, `/sign-message` and
`/send-transactions`. These URLs have no network/state query parameters. After
the exact popup sends `type:'ready'`, the bridge forwards the appropriate request:

- Login: `type:'signIn'`, with `data.networkId:'testnet'` and version `V3`.
  It requests no FunctionCall key. Success is `type:'connected'` with accountId
  and walletUrl; a returned origin other than the official web wallet is rejected.
- NEP-413: `type:'signMessage'`; `data.message` is JSON containing the exact server
  message, nonce byte array, recipient, `callbackUrl` and challenge-ID `state`.
  Success is `type:'signed'` carrying the signature object. The signed callback
  URL stays `/settings`; state is a separate payload field.
- Transaction: `type:'signAndSendTransactions'`, JSON `data.transactions` and
  `mode:'Send'`; success is `type:'sent'` carrying outcomes. The outer executor
  returns the first outcome for a single transaction. This web path uses popup
  messages, not a callback-URL redirect; the adapter's redirect support is separate.

If opening the popup is blocked, the pinned executor displays the localized
bridge prompt and retries after its Open button. A wallet error/closed popup can
return no result; a transaction still remains unknown rather than being retried.
Network is selected by login, not by inventing a `?network=testnet` URL. The
supported web path does not use the native logout-bridge WebSocket service.

## Verification evidence

The production C775 browser demo completed testnet wallet authentication, sealed
bidding, buyer funding, encrypted execution, provider delivery recording, six
browser-generated result proofs, explicit buyer acceptance and Intear payment
release, ending in FINAL **0.001 testNEAR provider payout**. The buyer checked
six cells/four changes. All six proofs passed local/server, fresh unauthenticated
process and live public browser verification. The [C775 lifecycle snapshot](../docs/verification/c775-full-browser-lifecycle.json)
records all 11 independent checks: exact native provider transfer, successful
nonce-bound callback and same-block pinned/keyless Paid hold, alongside the
unchanged six-proof bundle and public Paid binding.

| Check | Evidence |
| --- | --- |
| Public six-proof verifier | [C775 verifier](https://veil-procurement.vercel.app/verify?id=c77599347652ecdfb2362a620afa5e99), [independent proof snapshot](../docs/verification/c775-public-proof-only.json) |
| Exact funding and recording | [Fund-only snapshot](../docs/verification/c775-fund-only.json), [record-only snapshot](../docs/verification/c775-record-only.json) |
| Earlier Node-signed production flow | [One-row HTTP lifecycle](../docs/verification/wallet-funded-http-production.json), separate from browser popup evidence |
| Direct-chain payout/refund checks | [Financial evidence](../payments/wallet_escrow/verification/live-financial-checks.json) |
| Regression results | [Release checks](../docs/verification/wallet-release-checks.json): 494 root tests, 20 client tests, 25 focused client/auth tests and two real-vault session tests |

Intear login/NEP-413, fund, record and release popup flows have passed. Refund
popup signing remains untested; the direct-chain refund test is separate.
The public proof-only snapshot proves no payment by itself, and funding/record
snapshots prove no result correctness by themselves. The typed-result SNARK does
not establish original CSV provenance, honest garbling, provider execution origin
or an AES trace; the contract has no on-chain SNARK verifier.

Unit tests explicitly distinguish genuine synthetic cryptography from mocked
wallet/DOM/RPC responses. They cover strict label types, immutable intent bytes,
buyer recovery recording, callback binding, unknown transaction handling,
transport spoof rejection and the real vault's cleanup/reload behavior. The
494-test root snapshot includes the session-role fix; the earlier 492-test
snapshot is retained in release checks. This documentation update reruns no tests.
