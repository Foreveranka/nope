# Third-party notices

The [root MIT license](LICENSE) applies to original NOPE code and documentation. It does not replace the licenses/terms of third-party software, model weights, fonts, public proof material or vendored upstream code. Keep their notices when redistributing them.

This is an inventory of prominent direct components in the current browser/Node application, not an exhaustive SBOM of every transitive package or historical prototype. Exact dependency versions and package integrity values are retained in the root and runtime `package-lock.json` files; package distributions contain the applicable upstream license information.

| Component | Version/source used | Upstream license or notice |
| --- | --- | --- |
| NEAR JavaScript API | `near-api-js` 7.5.3; [near/near-api-js](https://github.com/near/near-api-js) | Package metadata: MIT AND Apache-2.0; retain its distribution's LICENSE |
| Vercel Blob | `@vercel/blob` 2.9.0; [vercel/storage](https://github.com/vercel/storage) | Apache-2.0 |
| NEAR Connect | `@hot-labs/near-connect` 0.12.0; [hot-dao/near-selector](https://github.com/hot-dao/near-selector) | MIT as declared in the package metadata; NOPE's source-pattern-checked transport modifications are documented in `wallet-runtime/README.md` |
| Transformers.js | `@huggingface/transformers` 4.3.2; [huggingface/transformers.js](https://github.com/huggingface/transformers.js) | Apache-2.0; packaging retains `transformers-LICENSE.txt` in the public model runtime |
| ONNX Runtime Web | Distribution pinned by the planner runtime lockfile | MIT; [retained Microsoft notice](planner-runtime/onnxruntime-LICENSE.txt), also copied by the browser packager |
| Noir JS/compiler WASM | `@noir-lang/noir_js` and `@noir-lang/noir_wasm` 1.0.0; [noir-lang/noir](https://github.com/noir-lang/noir) | MIT OR Apache-2.0 as declared by the packages |
| Barretenberg | `@aztec-foundation/bb.js` 6.0.0; [AztecProtocol/aztec-packages](https://github.com/AztecProtocol/aztec-packages) | MIT as declared by the package |
| NEAR Rust SDK | `near-sdk` 5.30.1, pinned by the escrow Cargo manifests/lockfiles | MIT OR Apache-2.0 as declared by the crate |
| esbuild | 0.25.12 in proof/wallet runtimes; 0.28.2 in planner runtime | MIT; build tool, not a new model or cryptographic implementation |
| Qwen3-0.6B ONNX weights | `onnx-community/Qwen3-0.6B-ONNX-OPT`, revision `4799e655597b49210adb5c1ebe5b9d3bd04005a0` | Apache-2.0 as recorded in the [pinned model manifest](planner-runtime/model-pack.json); public files are fetched from the model host, not relicensed or represented as NOPE-trained weights |
| Press Start 2P | `web/nope-display.ttf` | SIL Open Font License 1.1; copyright 2012 The Press Start 2P Project Authors; [retained license](web/PressStart2P-OFL.txt) |
| VT323 | `web/nope-pixel.ttf` | SIL Open Font License 1.1; copyright 2011 The VT323 Project Authors; [retained license](web/VT323-OFL.txt) |
| Space Mono | `web/nope-mono.ttf` | SIL Open Font License 1.1; copyright 2016 The Space Mono Project Authors; [retained license](web/SpaceMono-OFL.txt) |

## Upstream wallet executor

The vendored Intear executor is copied byte-for-byte from the official distribution at `https://wallet.intear.tech/near-selector.js`; its source SHA-256 is `6decc283352af197feff4988628899d19e05f4168a4277fe699bd8a0d6178e34`. The upstream bytes and review rendering are kept in `wallet-runtime/intear-executor.upstream.js` and `wallet-runtime/intear-executor.review.js`.

It remains third-party upstream code, subject to its upstream terms. The root MIT grant does **not** purport to relicense that executor. Source origin, pinning and the narrow bridge/SDK modifications are explained in [wallet runtime documentation](wallet-runtime/README.md).

## Proof material and historical components

Approved public circuit artifacts, verification keys and SRS hashes are documented in [the proof runtime](proof-runtime/README.md), its [public asset inventory](proof-runtime/assets/README.md) and [approved manifest](proof-runtime/approved.mjs). These are not model weights or private ceremony contributions. Their distribution and upstream attributions are separate from original application code.

Earlier Concrete FHE, MP-SPDZ, native worker and registry experiments retain their own dependencies, upstream notices and historical evidence. The current application README identifies them as earlier components; its MIT license does not overwrite their dependency licenses. No claim is made that every file in this repository was authored from scratch.

## Development assistance

Codex assisted implementation, review, tests and documentation. The local Qwen model proposes bounded transformation plans at runtime as documented in the application. AI assistance is disclosed separately from third-party software licenses and does not replace feature verification, human plan approval or the stated proof/trust boundaries.
