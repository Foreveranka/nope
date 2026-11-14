# NOPE testnet wallet runtime — frozen handoff

Production uses the official NEAR-recommended `@hot-labs/near-connect`, pinned
**0.12.0**, with esbuild **0.25.12**. See the [official NEAR Connect docs](https://docs.near.org/tools/near-connect)
and [wallet login guide](https://docs.near.org/web3-apps/tutorials/wallet-login).
The adapter supports testnet only. Signatures and transactions require an explicit
frontend button action; constructing the client performs neither.

## Build and published assets

From the repository root:

```sh
npm ci --prefix wallet-runtime --ignore-scripts
node wallet-runtime/package-browser.mjs
node --test tests/wallet-client.test.mjs
```

The build is offline after installation. MAIN copies exactly these five files
from `wallet-runtime/dist/` to `/wallet-runtime/`, checking each SHA against
`dist/asset-manifest.json`. Do not publish node_modules, review sources or the
manifest as executable code. Dependencies occupy 10 MiB locally.

| Asset | Bytes | SHA-256 |
| --- | ---: | --- |
| wallet-sdk.js | 51975 | 409454b636d0e96143bf383ce1a2eca134d6bd1ab519ed633f2689adebc2a3fd |
| bridge.js | 4420 | 51a2f08323a1b4dba6b06fc891aa4f1031768b67483344412d4d9841c014f432 |
| bridge.html | 313 | 0651471c9dfc8ad1c4ded6d309261b4f9028e24e843490a497efd1f81edacec4 |
| intear-executor.js | 13817 | 6decc283352af197feff4988628899d19e05f4168a4277fe699bd8a0d6178e34 |
| wallet.css | 718 | dd054bfdfa9940fac1e97556b758602715a279704d1826f14837fab56b9c96c9 |

Total **71,243 bytes**. The only change from MAIN's earlier successful Chrome
smoke bundle is the SDK result-listener hardening: explicit success/failed status
and close-listener cleanup. Bridge/executor/CSS/HTML hashes are unchanged.

## Adapter API

```js
import {createWalletClient} from './wallet-client.mjs';
const wallet = createWalletClient({window, network:'testnet'});
await wallet.connect({walletId:'intear-wallet', accountId});
await wallet.currentAccount();
await wallet.signChallenge(challenge);
await wallet.sendTransaction(intent, bounds);
await wallet.completeRedirect();
await wallet.disconnect();
```

`connect()` presents wallet selection if omitted. Multiple accounts require an
explicit accountId or `selectAccount` callback; it never silently picks the first.
Account results contain `{accountId, walletId, network:'testnet', publicKey?}`.
`currentAccount()` returns null until connected. Selection callbacks and the
`connectorFactory` constructor option are unit seams, never production signers.

`signChallenge()` accepts the backend's exact challenge object: challengeId,
network, accountId, sessionId, role, origin, nonce, issuedAt, expiresAt, message,
recipient and callbackUrl. It validates the canonical server message and origin,
passes nonce as 32 bytes, and preserves the signed callbackUrl. Result is exactly
`{challengeId,accountId,publicKey,signature}`: ed25519 base58 public key, canonical
base64 64-byte signature. A redirect returns `{redirected:true,challengeId}`.
No local result establishes chain key ownership; the backend checks it.

`sendTransaction(intent,bounds)` accepts exactly:

```js
// Intent from backend; action is fund | record | release | refund.
{
 id, action, network:'testnet', bindingHash,
 transaction:{signerId,receiverId,actions:[{
  type:'FunctionCall', params:{methodName,args,gas,deposit}
 }]}
}
// Frontend bounds from the immutable displayed job.
{
 action, jobId, bindingHash, accountId, contractId, buyerAccount,
 provider, amountYocto, version, outputHash
}
```

Bounds also optionally accept network, buyerCommitment, inputHash, programHash,
planHash, executionDeadlineNs, reviewDeadlineNs, expectedArgs, gas and deposit.
Fund requires provider/amount; record requires provider; record/release require
version/outputHash. Supplying expectedArgs enforces JSON byte order too.
The exact five-key shared pin `{network,contractId,codeHash,domain,requireKeyless}`
must match the production import, and requireKeyless must be true. The current
public deployment is `nope-wallet-44384e2f.testnet`; the pin file is authoritative.
The adapter permits one FunctionCall, fixed 150 Tgas, and only fund,
record_delivery, accept_and_release or refund. Fund deposit equals its terms
amount, at most 1 testNEAR. Other deposits are zero. Fund recomputes the complete
ordered binding hash. Buyer/provider signers, namespace, hashes, deadlines and
immutable job bounds are checked before calling the SDK. Caller objects and SDK
arguments are separate snapshots; returned transaction method/args bytes, gas,
deposit, signer and receiver must match the approved snapshot.

Successful submission returns `{transactionHash}`; redirect returns
`{redirected:true,intentId}`. Neither means finality or escrow success. Backend
observation remains separate. Any error after invoking the wallet transaction
method is `WALLET_TRANSACTION_UNKNOWN`, even if the wallet says rejected/closed.
Never automatically retry it or discard the frontend recovery capsule.
`WALLET_REJECTED` applies to connection/message cancellation, not transaction
broadcast certainty. Validation errors occur before SDK invocation.

`completeRedirect()` returns null, `{kind:'challenge',result}`, or
`{kind:'transaction',intentId,transactionHash}`. It validates local pending state,
origin, /settings path, public state ID and callback fields, then scrubs wallet
callback query/hash parameters. It never signs. Wrong-state callbacks cannot
clear pending; transaction error callbacks retain unknown pending. Expired login
challenges clear and can restart; transaction pending never expires away.
Disconnect is an explicit reset of adapter connection/pending metadata; callers
must retain their separate backend-observation recovery capsule for unknown sends.

Only `nope.wallet.client.v1.account` and `.pending` are written to sessionStorage;
no bearer token, session ID, customer CSV, nonce, signature or wallet key is stored
there or put in callback URLs. Existing workspace session storage is untouched.
NEAR Connect selected-wallet and Intear transport state are memory-only. Intear's
published executor generates an ephemeral Ed25519 **transport-authentication** key
for wallet popup requests. It is not a NEAR account signing key, is not registered
as a FunctionCall key, and disappears on reload. Real account signing remains in
the wallet. No browser wallet store is extracted.

## Opaque bridge and CSP

The published SDK uses inline/srcdoc sandbox packaging. Our build replaces that
transport with static external modules and a random 256-bit capability, keeping
the reviewed official Intear signing implementation. `sdk-patches.mjs` checks
exact pinned SDK source patterns and fails the build if they drift. It also
checks popup source/origin and wallet-result source, null origin, capability,
protocol, method, request ID and result status. The child checks parent source,
pinned parent origin, capability and message type/method. Executable code uses
no eval, new Function, blob worker or runtime CDN.

The frame sandbox is exactly:

```
allow-scripts allow-popups allow-popups-to-escape-sandbox
```

Never add allow-same-origin. MAIN owns these route/header requirements:

- Global frame-src self; scripts remain self, no inline/eval relaxation.
- bridge.html: X-Frame-Options SAMEORIGIN and frame-ancestors self override the
  global DENY/none only on this route.
- Static wallet-sdk.js, bridge.js, intear-executor.js and wallet.css: public
  Access-Control-Allow-Origin:* for opaque Origin:null imports, no credentials.
- Only official popup origin https://wallet.intear.tech is allowed. Public Intear
  configuration forces its supported web-popup path. No remote frame-src,
  extra connect-src, native bridge or form-action exception is required by this
  path. Actual external wallet operation still needs a user wallet test.

The original Intear executor is copied byte-for-byte from the URL listed in the
[official manifest](https://raw.githubusercontent.com/hot-dao/near-selector/refs/heads/main/repository/manifest.json):
https://wallet.intear.tech/near-selector.js . Its SHA is enforced before packaging.
The outer published signMessage drops callbackUrl; bridge uses the real public
inner connectedAccount.signMessage with the full exact server payload. No
signInAndSignMessage fallback signs a different challenge. No dynamic manifest
or executor download occurs at runtime. Localized labels come from the existing
app i18n instance: title, cancel, frameTitle, open and prompt.

## Evidence and limits

**16/16 targeted tests passed** with `node --test tests/wallet-client.test.mjs`
on 2026-11-14 (~210 ms). They cover strict policy/intent boundaries, exact four
methods, immutable argument snapshots, callback binding/recovery, unknown
transaction retention and spoof rejection in all three real transport receivers.
The SDK result test executes the actual transformed published SDK source used by
the bundler; the iframe and child bridge tests execute their actual source.
Those tests use explicitly marked window/connector/executor fixtures. NEP-413
signing and independent verification use genuine local crypto with a newly
generated synthetic key and a fixture FullAccess RPC response. They are not
wallet or chain evidence.

MAIN reports actual Chrome passed using the built SDK with the production opaque
headers: createConnector -> wallet('intear-wallet') -> getAccounts() -> READY,
accounts0, no localhost errors or external popup, iframe disposed afterward.
This proves the transport loaded under that CSP. It does not prove real Intear
login, message signing, transaction signing or chain finality. No actual user
wallet was available; those popup interactions remain untested. No project funds
were moved by this implementation task. Planck's backend/chain harness is
separate evidence and must be reported separately.
