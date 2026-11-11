# Current v2 integration update

`verify_registry_job` in `sdk/registry.py` recomputes job/Borsh and complete bidset with explicit trusted contract/network inputs. It is not a light client. `build_receipt_claim` supports paired `selected_executor` / `attempt_binding_version` and binds v2 attempts to the selected executor. Staged request protocol 2 requires original canonical `external_binding` bytes, hashed into both request and receipt. The supplied NEAR job/attempt/bidset must match those bytes. This prevents cross-attempt reuse in the staged path; it still is not an execution proof.

Run all SDK tests with `python3 -B -m unittest discover -s sdk/tests` (40 cases at integration verification). The following historical description documents legacy request protocol 1; its post-hoc/reuse limitations apply to that legacy path. See `integration/run.py` for the current pre-evaluation binding flow.

# Offline FHE → registry receipt adapter

Python 3.9+, standard library only. Import `BindingError` and
`build_receipt_claim` from `sdk`. The constructor returns a detached JSON-compatible
`ReceiptClaim`: 32-byte integer **lists** and canonical decimal U64 **strings**,
matching `contracts/registry/src/lib.rs`. It does not return a signed transaction,
authenticate an executor, submit anything, pay anything, or accept a result.
It neither executes nor imports Concrete and never reads or hashes result records.

```python
from sdk import build_receipt_claim

claim = build_receipt_claim(
    registry_job,                 # Full caller-trusted get_job snapshot
    engine_result,                # Verified run_job metadata; records may be omitted
    request_manifest=request_bytes,  # Original engine request.json bytes
    evaluator_receipt=receipt_bytes, # Original engine receipt.json bytes
    expected_registry_attempt="1",  # Explicitly selected current NEAR U64 attempt
    expected_engine_attempt_id=chosen_local_attempt_id,  # Distinct 32-char hex ID
    policy=approved_policy,        # Explicit caller-approved policy described below
)
# If a caller separately chooses to submit, report_result expects {"claim": claim}.
# The constructor itself has no submission, signing, wallet, or payment API.
```

All validation failures raise `BindingError` (`ValueError`). Inputs are not mutated;
returned lists have no aliases into caller-owned containers. Optional plaintext
`engine_result["records"]` is not even accessed or copied. The constructor performs
no file, network, or subprocess I/O and logs nothing.

## Inputs and strict checks

`registry_job` must have the complete `get_job` schema, including `state`,
`closed_at_ns`, full canonical `bids`, and `receipts`. The lifecycle example's `job`
is a partial integration vector, so passing it unchanged is intentionally invalid.
Only `Executing` is eligible. Unknown states and fields are rejected. Attempts
must be current, canonical decimal strings in 1..16; job IDs must be positive U64
strings. Account IDs, sorted unique bidder roster, full bidset, nonzero commitments,
deadlines, and rejected prior-attempt history are checked. Public bidset, attempt,
and historical receipt hashes are recomputed using the contract's Borsh schemas.
The already committed `job_binding_hash` is taken from the supplied snapshot;
this API has no contract-account/network-domain parameters to recompute it.

The approved `policy` dictionary must contain **exactly**:

```python
approved_policy = {
    "profile_id": "clean-4-records-v1",
    "verification_method": "client_plaintext_reference",
    "requires_execution_proof": False,
    "spec_hash": approved_spec_hash,               # 32 integer bytes
    "output_policy_hash": approved_output_policy_hash, # 32 integer bytes
}
```

Supply those hashes from the caller's reviewed policy configuration, not an
untrusted job's claim about what policy applies. Both must equal JobConfig exactly.
This dictionary is an explicit trusted interpretation/lookup of opaque policy
digests; the adapter cannot recover policy semantics from a hash or prove that
interpretation. Proof-required, missing, unknown, or non-boolean policy settings
fail closed. No alternate proof or attestation policy is supported.

`engine_result` requires `verified is True`, `metrics`, and `artifactHashes`; an
optional `records` field is ignored. Pass the direct engine result shape, not an
HTTP Job wrapper. The metrics must identify real Concrete 2.11.0 FHE with the
supported profile and client-reference verification, explicitly **not** a
cryptographic proof. Unknown metadata keys and malformed flags/timings are rejected.
The public engine artifact map has exactly seven SHA-256 hex digests:
`serverSha256`, `clientSpecsSha256`, `evaluationKeysSha256`, `inputSha256`,
`outputSha256`, `requestManifestSha256`, `receiptSha256`.

Pass original request and receipt **bytes**, not dictionaries or reserialized
JSON: their exact bytes are hashed against the engine artifact map. Duplicate JSON
keys, invalid JSON numbers, unknown fields and payloads over 16 KiB are rejected.
The embedded request, local attempt ID, protocol, profile, pinned circuit and client
spec, all input/key hashes, output digest and evaluator timings must agree across
the request, receipt and engine result.

Mapping into the registry claim is exact:

| Engine metadata | Registry field |
| --- | --- |
| `serverSha256` | Must equal `config.circuit_hash` |
| `evaluationKeysSha256` | Must equal `config.key_hash` |
| `inputSha256` | Must equal `config.input_hash` |
| `outputSha256` | Becomes `output_hash`; must equal the receipt's ciphertext-output digest |

All other claim fields are copied from validated immutable job/config/attempt
metadata, never silently rewritten to fit engine output. Hashes containing zero
bytes or beginning with `00` are valid; only an entirely zero hash is rejected as
required by the registry. The output hash is never computed from plaintext records.
Without ciphertext bytes the adapter checks metadata consistency; it does not
independently rehash the encrypted request/output. The engine already does that.

## Exact trust boundary

The caller must obtain a sufficiently fresh Job from the **intended contract and
network through a trusted state source**, and trust the supplied engine metadata,
original manifests and approved policy configuration. This library does not fetch
or authenticate state, verify finality, authenticate an executor or receipt, check
the current chain timestamp, or prove the supplied values originated in the engine.
A forged but internally consistent snapshot is not detected as forgery. A stale
`Executing` snapshot may describe a job whose deadline has already passed; only an
explicit real registry call would enforce the current state, time and executor.

**The local engine hex `attemptId` and registry U64 `attempt` have no cryptographic
mapping.** They are validated independently against explicit caller choices. This
adapter constructs a claim bound to the chosen registry context; it does not prove
FHE ran for that NEAR attempt. The same consistent FHE evidence can be used to
construct a claim for another compatible context. A test demonstrates this limit
with a rejected-attempt retry. These are equality checks and an executor-report
claim format, not an execution proof, signature, attestation, precommitted workflow,
or an authenticated-input guarantee. Executor authorization would be enforced by
the registry's predecessor check only if a separate caller explicitly submits.

## Actual verification and fixtures

From the repository root:

```sh
python3 -B -m unittest sdk.tests.test_receipt -v
```

The suite reads actual saved synthetic HTTP/FHE evidence from
`docs/verification/http-fhe-check.json` and the registry interface vector from
`contracts/registry/examples/lifecycle.json`. `fixtures/request.json` and
`fixtures/receipt.json` are byte-exact copies of the public metadata for HTTP job
`b16369e64f9b4b10946417b51be1ee79`. They were checked against that evidence's hashes
before copying; tests repeat those checks. They contain no records or keys and
make the tests independent of ignored runtime directories.

Tests also read `contracts/registry/verification/sandbox-fhe-binding.json`, which
records a **post-hoc local sandbox** claim/acceptance using the saved FHE hashes.
Its actual `Accepted` state is rejected. A clearly labeled offline reconstruction
of its pre-report `Executing` state produces exactly the saved claim and receipt
digest, checked against the registry's independent Borsh encoder. This constructor
was not used to send that transaction, and those tests do not execute a node.

The unchanged Rust lifecycle vector's receipt digest is independently matched:
`dd357485ab05554fe289c7aca1a6725255be5a91dd42be15eccf4748ef652292`.
Other tests cover circuit/key/input/output substitutions, raw-byte digest changes,
manifest/receipt/local-attempt/profile mismatch, proof-required policies, unknown
fields/states, hash/U64 validation, prior-attempt bindings, input immutability,
leading zero output hashes, and absence of plaintext access or I/O.

Only `sdk/` is changed for this adapter. No FHE rerun, new chain/sandbox execution,
credentials, transaction, signature, or payment is involved in this verification.
