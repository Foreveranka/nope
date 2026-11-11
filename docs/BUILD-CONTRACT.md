# Build contract v0.1
Working name: Veil Procurement. Local functional prototype, no production-security claims.
Root: /Users/mete/near-private-procurement
Research: /Users/mete/Desktop/NEAR-Hackathon-2026-Arastirma/Gizli-Is-Pazari-Fizibilite

## Ownership
Main: service/, tests/ (integration), scripts/, root files, docs/ except worker-specific docs.
FHE worker: engine/ only (incl tests + README).
UI worker: web/ only.
NEAR worker: contracts/registry/ only (incl tests/docs/toolchain locally scoped).
MPC worker: mpc/ only (incl tests/docs/dependency build).

## Functional local vertical slice
Landing / explains procurement and opens /app. Browser submits synthetic 4-record numeric dataset to a loopback-only local client companion (Python HTTP server), NOT remote evaluator. Client owns plaintext and in-memory FHE SK. Separate evaluator subprocess gets only approved fixed server artifact, evaluation key, encrypted request. Decrypt + reference check at client; no plaintext returned to evaluator. Fixed profile: exactly 4 records {id:0..255,value:0..255}; duplicates FLAGGED (later same id), sentinel255 -> 0, clamp>100 ->100. Not arbitrary CSV cleaning.
No plaintext or secret keys persisted. Result in client-process memory, job metadata in local state. Encrypted artifacts may persist runtime/ ignored by Git. Strict same origin, reject foreign origins/Host, random CSRF token for mutations, 127.0.0.1 binding. Client trust and same-UID isolation limit visible. Cannot claim generic browser-native FHE: Concrete Python local companion.

## API frontend/main
GET /api/capabilities -> {version,profile:{id:'clean-4-records-v1',recordCount:4},capabilities:[{id,label,status,detail}],csrfToken}
GET /api/jobs -> {jobs:Job[]}
POST /api/jobs header X-CSRF-Token + JSON {title:string,records:[{id:number,value:number}]} -> 201 {job:Job}; starts real FHE async. No bids/budget plaintext at coordinator pretending sealed auction. MCP/market live payments unsupported.
GET /api/jobs/:id -> {job:Job}
Job {id,title,status:'QUEUED'|'ENCRYPTING'|'EVALUATING'|'VERIFYING'|'COMPLETED'|'FAILED',createdAt,updatedAt,events:[{stage,at,message}],result?:{records:[{id,value,duplicate}],verified:boolean},metrics?:object,artifactHashes?:object,error?:string}
GET /health -> {ok:true}. JSON errors {error:string}. 64KiB body max. Frontend poll while active, show real error and measured timing, no invented metrics.
UI input CSV id,value only or editable four rows; client-side schema validation; landing, workflow history, result/capability view. Responsive polished editorial dark ink/ivory + emerald; no remote scripts/fonts/analytics.

## Engine interface for service
engine/pipeline.py export run_job(records, job_dir, on_stage=None) -> dict {records:[{id,value,duplicate}], verified:bool,metrics:dict,artifactHashes:dict}; on_stage(stage,message) called ENCRYPTING/EVALUATING/VERIFYING. No plaintext disk. Python3.9 compatible. Service imports module inside worker thread. Configure research artifact/venv via env/explicit default; don't regenerate old research outputs. Worker CLI owns encrypted evaluation; do NOT unpickle user artifact. Allowlisted artifact SHA check. Serial single FHE worker to control memory. Tests + genuine end-to-end result with synthetic data required.

## NEAR contract independent target
Rust near-sdk pinned verified version. Registry only, NO funds custody. owner creates job with spec/circuit/key/output-policy/context hashes, deadline, fixed authorized bidders, authorized executor. Bidders submit commitment hashes; freeze all received bid entries at deadline, no omission; receipt binds job, attempt, input/root/output etc. No bare host signature called attestation. States explicit, authorization/deadline/replay tests. Local/sandbox tests and actual Wasm build if toolchain feasible, no testnet account creation/spend. Do not imply registry executes FHE/MPC/payment. Receipt can be executor-reported explicitly, acceptance by buyer; reject arbitrary autoaccept.

## MPC target
Real MP-SPDZ malicious SPDZ2k first-price cheapest eligible 3 prices and secret budget, tie lowest slot, private outputs where feasible. Inputs context bound. Local three-process functionality != independent trust. No fake offline/insecure compilation for security claim; if runtime unavailable report exact tests/source vs untested. Keep entirely separate from single-key FHE auction experiment, never pretend latter hides bids from buyer. No network fund use. Expose eventual CLI integration and document gates, no mock labelled MPC.

## SDK binding extension (FHE worker after engine complete)
Ownership sdk/ only, read engine/ and contracts/registry/ interfaces. Pure Python3.9 adapter to build a NEAR ReceiptClaim from immutable registry Job + verified engine result. Strict jobstate/attempt/hash/config validation, outputhash only ciphertext; reject circuit/input/eval-key mismatch, unknown profile, proof-required policy. No implicit signing/spending; returns JSON-compatible bytearrays/U64strings ready for explicit transaction caller. Document it binds manifests and authenticatedclaims, not a proof/attestation. Tests real saved syntheticengineevidence and registryfixtures. No engine/service/contract mutation.
