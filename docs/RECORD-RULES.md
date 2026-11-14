# Private record rules v5

This extension adds **joint computation over multiple secret fields**, not a claim of general encrypted LLM inference. The existing V2 testnet escrow is unchanged. Historical v4 programs, verification keys, policies and evidence remain byte-identical; version selection is explicit in `web/proof-protocol.mjs`.

## Typed public program

A plan has exact fields `version`, `taskHash`, `inputs`, `constants`, `steps`, `outputs`. `inputs` lists one to eight distinct anonymous aliases C1..C16 in private-vector order. Public task version 2 declares only an explicit public goal and typed anonymous aliases. The task hash binds that normalized description. Original CSV headers and field mappings remain local.

Registers 0..7 hold private u32 fields, unused slots are zero. Registers 8..11 hold at most four **public** u32 constants; unused slots are zero. Each of up to eight instructions writes register 12+i and may reference only active input/constant registers or earlier instructions. One to four register references select the output words; remaining output words are constrained to zero.

Every instruction has `{op,a,b,c}`. `c` must be zero except for `select`.

| Operation | Exact meaning |
|---|---|
| `addSat` | min(a+b, 2^32−1) |
| `subSat` | max(a−b, 0) |
| `min`, `max` | unsigned minimum/maximum |
| `eq`, `lte` | 0 or 1 for equality / unsigned ≤ |
| `and` | 1 iff a and b are both nonzero |
| `select` | a != 0 ? b : c |
| `mul16` | exact a×b; both operands must fit 16 unsigned bits |

Selected clear values must be canonical integer strings in 0..4,294,967,295. Money uses minor units; no rounding or floating point is introduced. Every `mul16` domain check runs locally **before** randomness/garbling/publication, including dead instructions. The Noir relation independently constrains those bounds. The clear reference implementation and fixed Boolean compiler both implement the same arithmetic; caller-supplied circuits are not accepted.

## Cryptographic flow

1. The buyer parses the CSV locally and maps selected roles to aliases. Names, UTF-8 notes, filename and unselected fields do not enter the public task.
2. The buyer validates the program/domain and all rows, checks the actual gate/byte budget, reviews clear expected results and explicitly approves the plan.
3. Each record gets fresh random ordered label pairs for **258 input wires** (eight u32 words plus zero/one) and **128 output wires**. AES-GCM garbled gate keys bind v5 profile, program digest, fresh nonce, row, gate and selected labels. Garbling topology depends on the public program, not private values.
4. Only one selected label per input wire and encrypted gate tables leave the buyer. Pair alternatives, clear bits, decoding mappings and root salts remain in the encrypted local vault.
5. The evaluator rebuilds the allowlisted topology, checks exact request hashes and evaluates authenticated gate ciphertexts. It returns result labels; it receives no plaintext result decoder.
6. A separate pinned Noir VM proves the returned labels encode the public program's correct u32 result under the buyer's precommitted ordered mappings. Poseidon2 roots bind input/output pairs and selections. The statement includes public program ABI, job and final delivery context, selected provider/amount and exact escrow binding. The record proof has 55 public inputs.
7. Buyer browser and API verify the real proof before explicit acceptance and escrow release. The public verifier additionally checks the reviewed contract code/keyless state and FINAL hold/delivery binding through the trusted RPC.

The proof is **result correctness under an honestly prepared precommitment**. It does not prove honest initial garbling, CSV provenance, physical execution by a particular machine, an AES execution trace or understanding of a natural-language goal. The customer necessarily sees its own clear values and outputs. Public rules, aliases, dimensions, topology, commitments, selected provider and price can leak metadata. The frontend/API/RPC remain trust boundaries. No external independent operator network is claimed.

## Current workloads and budgets

The invoice template uses four private inputs (quantity, unit minor-units, billed minor-units, budget minor-units), computing expected amount, positive excess billing, budget flag and exact-match flag. `quantity` and `unit price` must each be ≤65,535. It measures 1,887 gates per record; five records fit 9,435 gates and about 2.35 MB before the proof manifest. Both lower and outer protocol bounds are checked.

The cash-flow template uses six private fields (income, expenses, existing debt payment, proposed new payment, credit limit, requested principal). It returns disposable income, residual payment capacity, a separate credit-limit flag and a cash-flow flag. Do not present these two flags as one final loan decision. It measures 834 gates per record; eleven records fit 9,174 gates and about 2.39 MB.

All programs are bounded by 16 rows, 10,000 total gates and less than 3 MiB including the reserved outer envelope. Some programs fit fewer rows. No truncation, label reuse between rows or plaintext fallback is permitted. This is a small pilot, not a production-scale bulk invoice platform.

## Reproduction

Installed pinned dependencies and the existing local public SRS are sufficient:

```sh
node proof-runtime/compile-record.mjs
node proof-runtime/approve-record.mjs
node --test web/record-core.test.mjs web/record-proof.test.mjs workspace/record-workspace.test.mjs
npm run check:locales
npm run build
```

Recompiling/reapproving is a development action, not a verifier option. The verifier never accepts a caller-supplied verification key. Keep historical v4 pins untouched. The recorded circuit has 95,436 gates, dyadic size 131,072, with the existing 524,288-point pinned public SRS.

The explicit wallet HTTP harness supports `--workload=record-invoice` with a fresh `--case=`. It uses **real testnet transactions** and ignored private recovery material; it is not an offline test or permission to use mainnet/user funds. The local run evidence records actual chain hashes and all checks while disclosing `browserTest:false`, `authoredPlan:true`, `neuralPlanning:false`.
