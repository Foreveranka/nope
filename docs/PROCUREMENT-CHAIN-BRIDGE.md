# Local procurement publication bridge

## Mount interface

```python
from service.procurement_chain import from_env, ProcurementChainBridge, ProcurementChainError

bridge = from_env(runtime_dir, procurement_config)
# None unless explicitly enabled; do not advertise chain publication when None.

expected = {
    "id": local_session_id,
    "draftId": application_job_id,
    "intent": prepared_intent,
    "contextHash": prepared_context_hash,
    "budgetCommitment": prepared_budget_commitment,
}
binding = bridge.publish(authenticated_published_job, expected)
status = bridge.status(application_job_id)
```

`ProcurementChainError` subclasses `ProcurementClientError`, with fixed public
`.code` values. The mount authenticates the buyer as the fixed registry owner,
fetches the full PUBLISHED app job through its authenticated proxy, and constructs
the exact five-field `expected` object from its own live `ProcurementClient`.
Never populate `expected` from the browser, a stored browser snapshot or an HTTP
`verified` claim. Keep the mount's session lock around snapshot validation and
publication, and require the exact PREPARED session/draft with real FHE mode.
Never pass the full local snapshot: its `privateInput` field can contain a buyer's
winner price. Neither a budget opening nor a provider price belongs in this API.

The browser routes need only `chain-publish {jobId,sessionId}` and
`chain-status {jobId}`. Authorization remains necessary for both. No browser
transaction, signer, RPC, identity file, repository path or evidence is accepted.

## Explicit owner-host configuration

Enable only on the local owner host:

```text
NOPE_ENABLE_TESTNET_RELAY=1
NOPE_TESTNET_RELAY_ROOT=/absolute/path/to/near-private-procurement
# Optional server-owned absolute executable path:
NOPE_TESTNET_NODE=/absolute/path/to/node
```

The repository must contain the existing Node deployment modules, installed
`near-api-js`, reviewed artifact lock/build evidence and contract artifacts,
public owner identity and the existing dedicated local testnet wallet. Python
does not read that wallet's contents. The existing Node signer loads it only for
an explicit first publication. The standalone installer does not include this
tree and must show this capability disabled by default.

The bridge uses only the approved `https://test.rpc.fastnear.com` endpoint and the
existing `procurement.mjs` / `transport.mjs` signing policy. No live broadcast or
RPC calls are performed by the implementation's unit tests.

## Results and restart behavior

`publish(job, expected)` returns a verified binding with `state: "BOUND"`,
`finalExecutionStatus: "FINAL"`, decimal `registryJobId`, base58
`transactionHash`, `applicationJobId`, `localSessionId`, `registryAccount`,
`contextHash`, `budgetCommitment`, and
`scope: "testnet-registry-publication-only"`. It also includes the registry job
binding hash, final observation block/hash, code hash and evidence authority.
This is trusted-RPC evidence, not an independently verified light-client proof.
Selection and payment flags remain false.

A durable SQLite claim is committed before invoking the existing Node signer.
The app job, local session and context cannot be reused for another publication.
Repeated publication requests only reconcile; they never trigger a second
submission. An ambiguous first result raises `CHAIN_OUTCOME_UNKNOWN`.
`status(job_id)` can recover the binding from the Node signed-transaction journal
after restart, without the FHE secret key or an in-memory session. Missing or
incomplete evidence returns `state: "UNKNOWN"`, without a FINAL marker and with
`retryAllowed: false`. Even a crash before signing does not authorize a retry.
A previously verified BOUND result is cached publication evidence, not a fresh
claim about auction selection, delivery or payment.

The private runtime journal contains only whitelisted public job metadata and
verified binding fields. Budget/price openings, secret keys, raw subprocess logs
and browser identity paths are never journal inputs. Preserve both the runtime
journal and the owner's existing Node transaction journal across restarts.

## Packaging and validation

Python uses standard-library SQLite and a small local canonical base58 hash
validator; it has no `payments` dependency. Its existing engine protocol, SDK,
MPC v2, bid-client validation and procurement configuration imports are included
in the companion package. Node and the owner deployment tree remain an explicitly
configured host dependency, not a standalone installer capability.

No changes to the Node driver are required: the fixed wrapper imports the existing
`publishTestnet` helper and gathers complete transaction, receipt, block and
registry evidence for strict Python validation. Reconciliation does not call the
signer or broadcast helper.

Validation: `python3 -B -m unittest discover -s tests -p test_procurement_chain.py`
passes 15 no-network tests using explicitly labelled fabricated evidence and an
injected driver. These cover exact session binding, FINAL evidence mutations,
concurrent durable claims, lost responses, restart reconciliation and journal
privacy. Real owner-host publication remains the main agent's controlled live
verification step; these unit tests do not establish testnet completion.
