"""Local staged procurement companion; no HTTP, signing or network orchestration.

Mount behind the companion's existing loopback/origin/CSRF checks. Construct one
ProcurementClient per process, call prepare(draft, required, budget=...), then
publish_payload(id, expected_revision=...). Preparation/publication expose only
public metadata. run_private_input(id, evidence_hash=...) delivers the retained
budget to slot 0 of the LOCAL loopback MPC client, once per session. Its optional
SERVER-CONFIGURED plan_verifier(public_expectations, evidence_hash) returns exact
{job: authenticated CLOSED app Job, manifest: v2 selection manifest, manifestHash:
independently authenticated manifest digest}. It must authenticate the frozen app
revision, registry network/contract/code and app-to-registry job mapping, plus the
admitted plan/round and configured local port/certificate trust anchors. Codec
checks supplement, never replace, that authentication. No default verifier exists.

Private input returns buyer-authorized winner price/total in a LOCAL-ONLY
privateInput snapshot summary; never forward snapshots to the cloud. The budget
and salt are consumed even on ambiguous input failure, with no retry. Successful
input leaves the FHE session PREPARED; evaluate/finalize retain their own gates.
evaluate(id, evidence_hash=...) requires a SERVER-CONFIGURED binding_verifier:
    verifier(public_expectations, evidence_hash) -> authenticated registry Job
The adapter must authenticate finalized network/contract/code AND selected MPC
evidence for this exact app draft, intent and commitment. A hash is only a lookup
reference, not authentication. No verifier is installed by default.

finalize() returns decrypted synthetic records to the LOCAL caller only. Never
forward its result to the procurement cloud. Registry transactions, trusted
plan/selection authentication and HTTP are separate
integration dependencies. This module never fabricates registry metadata.

All PreparedJob operations (including failure/expiry cleanup) use the same sole
worker thread. A TTL requests cleanup, but cannot interrupt native keygen or a
blocking configured adapter: cleanup runs as soon as that operation returns.
Adapters must enforce their own bounded I/O deadlines. No new session is admitted
until cleanup finishes. Python/native reference release is not secure zeroing.
"""
import copy
import math
import re
import secrets
import threading
import time
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass
from pathlib import Path

from engine.protocol import (PROFILE_ID, artifact_pins, read_regular,
                             sha256, validate_external_binding)
from mpc.auction import MAX_AMOUNT, UPSTREAM, integer
from mpc import v2
from sdk.registry import verify_registry_job
from sdk.receipt import _job as validate_executing_job

__all__ = ["ProcurementClient", "ProcurementConfig", "ProcurementClientError"]

_ROOT = Path(__file__).resolve().parents[1]
_DRAFT_FIELDS = {"id", "title", "profile", "buyer", "roster", "bidDeadlineNs",
                 "resultDeadlineNs", "status", "revision", "createdAt", "updatedAt",
                 "ledger", "blockchainBinding", "intent", "contextHash",
                 "budgetCommitment", "bids", "closedAt", "selection", "deliveries", "decision"}


def _hash(value):
    if v2.hex32(value) == bytes(32):
        raise ValueError("nonzero hash required")
    return value


@dataclass(frozen=True)
class ProcurementConfig:
    """Trusted administrator pins, never populated from an HTTP request.

    No registry/network/policy fallback. from_testnet_deployment reads the existing
    public deployment evidence, not a wallet file or a fresh chain attestation.
    Program/build and FHE artifact identities are checked against source modules.
    specHash denotes the allowlisted FHE client-specs artifact in this client.
    """
    registry_account: str
    network_domain_hash: str
    registry_executor: str
    output_policy_hash: str
    mpc_program_hash: str
    upstream: str
    artifact_set: str = "portable-v1"

    def __post_init__(self):
        v2.account(self.registry_account)
        v2.account(self.registry_executor)
        _hash(self.network_domain_hash)
        _hash(self.output_policy_hash)
        if self.mpc_program_hash != v2.program_hash() or self.upstream != UPSTREAM:
            raise ValueError("MPC program/build pin mismatch")
        artifact_pins(self.artifact_set)

    @classmethod
    def from_testnet_deployment(cls, *, registry_executor, output_policy_hash,
                                artifact_set="portable-v1"):
        import json
        deployment = json.loads(read_regular(
            _ROOT / "contracts/registry/deploy/evidence/deployment.json", 65536))
        domain = deployment["network_domain_hash_hex"]
        if (deployment["network"] != "testnet" or
                deployment["rpc"] != "https://rpc.testnet.near.org" or
                deployment["network_domain"] != "veil/registry/network/v1:near:testnet" or
                sha256(deployment["network_domain"].encode("ascii")) != domain or
                v2.registry_hash(deployment["network_domain_hash"]).hex() != domain or
                not deployment["account_id"].endswith(".testnet")):
            raise ValueError("canonical testnet deployment mismatch")
        return cls(deployment["account_id"], domain, registry_executor,
                   output_policy_hash, v2.program_hash(), UPSTREAM, artifact_set)


class ProcurementClientError(RuntimeError):
    """Fixed public error codes/messages; engine/adapter exceptions never escape."""
    def __init__(self, code):
        self.code = code
        super().__init__(code)


def _draft(value, now_ns):
    v2.schema(value, _DRAFT_FIELDS, "public draft")
    if (type(value["id"]) is not str or not re.fullmatch(r"[0-9a-f]{32}", value["id"]) or
            type(value["title"]) is not str or
            not re.fullmatch(r"[A-Za-z0-9 .,()_-]{1,100}", value["title"]) or
            value["profile"] != PROFILE_ID or value["status"] != "DRAFT" or
            type(value["revision"]) is not int or value["revision"] != 0 or
            value["ledger"] != "app" or value["blockchainBinding"] != "pending"):
        raise ValueError("invalid draft metadata")
    for field in ("createdAt", "updatedAt"):
        integer(value[field], 0, 2**53 - 1, field)
    for field in ("intent", "contextHash", "budgetCommitment", "closedAt", "selection", "decision"):
        if value[field] is not None:
            raise ValueError("draft already contains publication/selection data")
    if value["deliveries"] != []:
        raise ValueError("draft already delivered")
    v2.account(value["buyer"])
    roster = value["roster"]
    if type(roster) is not list or len(roster) != 3:
        raise ValueError("three providers required")
    for provider in roster:
        v2.account(provider)
    if roster != sorted(set(roster)) or value["buyer"] in roster:
        raise ValueError("canonical roster required")
    bids = value["bids"]
    if type(bids) is not list or len(bids) != 3:
        raise ValueError("draft bid slots required")
    for slot, (provider, bid) in enumerate(zip(roster, bids), 1):
        v2.schema(bid, {"provider", "slot", "commitment"}, "draft bid")
        if (bid["provider"] != provider or type(bid["slot"]) is not int or
                bid["slot"] != slot or bid["commitment"] is not None):
            raise ValueError("draft bid mismatch")
    begin, end = v2.u64(value["bidDeadlineNs"]), v2.u64(value["resultDeadlineNs"])
    if not now_ns < begin < end or end - begin >= 30 * 86400 * 10**9:
        raise ValueError("invalid draft deadlines")
    return value


class ProcurementClient:
    """One live in-memory session, bounded admission; synchronous mountable API.

    test_prepare_job is a trusted, explicitly labelled TEST DOUBLE hook. Production
    imports and calls engine.pipeline.prepare_job on the dedicated worker thread.
    evaluator, if configured, is a trusted ciphertext-only transport compatible
    with PreparedJob.evaluate_remote; omitted means actual local evaluation.
    Call close() on server shutdown (or use a with block).
    """
    def __init__(self, runtime_dir, config, *, timeout_seconds=900,
                 binding_verifier=None, evaluator=None, test_prepare_job=None,
                 plan_verifier=None, runner=None, port=None, certificate_dir=None,
                 input_timeout_seconds=60):
        if type(config) is not ProcurementConfig:
            raise ValueError("explicit ProcurementConfig required")
        if (type(timeout_seconds) not in (int, float) or
                not math.isfinite(timeout_seconds) or not 0 < timeout_seconds <= 1800):
            raise ValueError("timeout must be positive and at most 1800 seconds")
        for callback in (binding_verifier, evaluator, test_prepare_job, plan_verifier, runner):
            if callback is not None and not callable(callback):
                raise ValueError("configured adapter must be callable")
        if (type(input_timeout_seconds) not in (int, float) or
                not math.isfinite(input_timeout_seconds) or not 0 < input_timeout_seconds <= 600):
            raise ValueError("input timeout must be positive and at most 600 seconds")
        if (port is None) != (certificate_dir is None):
            raise ValueError("configure both local port and certificate directory")
        if port is not None:
            integer(port, 1024, 65532, "local port")
            certificate_dir = Path(certificate_dir)
            if (not certificate_dir.is_absolute() or certificate_dir.is_symlink() or
                    not certificate_dir.is_dir()):
                raise ValueError("configured absolute local certificate directory required")
            certificate_dir = certificate_dir.resolve()
        if evaluator is not None and config.artifact_set != "portable-v1":
            raise ValueError("remote evaluator requires portable artifacts")
        self._runtime = Path(runtime_dir)
        self._config = config
        self._timeout = timeout_seconds
        self._verifier, self._evaluator = binding_verifier, evaluator
        self._plan_verifier, self._input_runner = plan_verifier, runner
        self._input_port, self._input_certificates = port, certificate_dir
        self._input_timeout = input_timeout_seconds
        self._test_prepare = test_prepare_job
        self._lock = threading.RLock()
        self._pool = ThreadPoolExecutor(max_workers=1, thread_name_prefix="procurement-client")
        self._active = self._busy = self._closed = False
        self._worker_id = None
        self._public = None
        self._private = None  # Accessed only by the sole worker, never snapshotted.
        self._timer = None
        self._ending = None
        self._end_future = None
        self._deadline = None

    def __reduce_ex__(self, protocol):
        raise TypeError("Live procurement clients cannot be serialized")

    def __enter__(self):
        return self

    def __exit__(self, *args):
        self.close()

    def snapshot(self):
        """Detached LOCAL snapshot; no budget/salt/records/paths, but buyer price after MPC."""
        with self._lock:
            return copy.deepcopy(self._public)

    def prepare(self, draft, required, *, budget):
        """Encrypt fixed synthetic four-record data and seal public intent once.

        draft is the exact cloud Job returned by POST /jobs (DRAFT, revision 0).
        required is exactly {qualified: [bool,bool,bool], fixedFee: integer}.
        budget is a LOCAL micro-unit integer, never part of the public draft/body.
        Repeated prepare is rejected while any session/cleanup remains live.
        """
        try:
            draft, required = copy.deepcopy(draft), copy.deepcopy(required)
            _draft(draft, time.time_ns())
            v2.schema(required, {"qualified", "fixedFee"}, "required parameters")
            flags = required["qualified"]
            if type(flags) is not list or len(flags) != 3 or any(type(x) is not bool for x in flags):
                raise ValueError("qualification flags required")
            integer(required["fixedFee"], 0, MAX_AMOUNT, "fixed fee")
            integer(budget, 0, MAX_AMOUNT, "budget")
        except Exception:
            raise ProcurementClientError("INVALID_PREPARATION") from None
        with self._lock:
            self._admit()
            if self._active or self._busy:
                raise ProcurementClientError("SESSION_BUSY")
            identity = secrets.token_hex(16)
            self._active = self._busy = True
            self._ending = None
            self._end_future = None
            self._public = {"id": identity, "draftId": draft["id"], "state": "PREPARING",
                            "engineMode": "test-double" if self._test_prepare else "real-fhe"}
            self._deadline = time.monotonic() + self._timeout
            self._timer = threading.Timer(self._timeout, self._expire, args=(identity,))
            self._timer.daemon = True
            self._timer.start()
            future = self._pool.submit(self._prepare, draft, required, budget, identity)
        return future.result()

    def _admit(self):
        if threading.get_ident() == self._worker_id:
            raise ProcurementClientError("REENTRANT_CALL")
        if self._closed:
            raise ProcurementClientError("CLIENT_CLOSED")

    def _check_live(self):
        with self._lock:
            if self._ending or self._closed:
                raise ProcurementClientError("SESSION_ENDED")

    def _prepare(self, draft, required, budget, identity):
        def operation():
            config = self._config
            if config.mpc_program_hash != v2.program_hash() or config.upstream != UPSTREAM:
                raise ValueError("MPC source changed since configuration")
            if self._test_prepare is None:
                from engine.pipeline import prepare_job
            else:
                prepare_job = self._test_prepare
            # Deliberately synthetic, matching the existing integration fixture.
            records = [{"id": 7, "value": 255}, {"id": 2, "value": 144},
                       {"id": 7, "value": 42}, {"id": 3, "value": 5}]
            prepared = prepare_job(records, self._runtime / ("procurement-" + identity),
                                   artifact_set=config.artifact_set)
            self._private = {"prepared": prepared, "budget": budget, "salt": secrets.token_bytes(32)}
            hashes = dict(prepared.artifact_hashes)
            pins = artifact_pins(config.artifact_set)
            if (hashes["serverSha256"] != pins["server.zip"] or
                    hashes["clientSpecsSha256"] != pins["client-specs.json"]):
                raise ValueError("engine artifact mismatch")
            for value in hashes.values():
                _hash(value)
            intent = v2.build_intent(network_domain_hash=config.network_domain_hash,
                registry_account=config.registry_account, buyer=draft["buyer"], roster=draft["roster"],
                qualified=required["qualified"], fixed_fee=required["fixedFee"],
                bid_deadline_ns=draft["bidDeadlineNs"], result_deadline_ns=draft["resultDeadlineNs"],
                spec_hash=hashes["clientSpecsSha256"], circuit_hash=hashes["serverSha256"],
                key_hash=hashes["evaluationKeysSha256"], input_hash=hashes["inputSha256"],
                output_policy_hash=config.output_policy_hash, registry_executor=config.registry_executor)
            if intent["mpcProgramHash"] != config.mpc_program_hash:
                raise ValueError("MPC source changed during FHE preparation")
            context = v2.precommit_context(intent)
            committed = v2.commitment(context, 0, budget, self._private["salt"])
            self._private.update(draft=draft, intent=intent, context=context, commitment=committed)
            return {"intent": intent, "contextHash": context, "budgetCommitment": committed,
                    "artifactHashes": hashes}
        return self._run(operation, "PREPARED")

    def _call(self, identity, expected, operation, state, *, admission=None):
        with self._lock:
            self._admit()
            if not self._public or identity != self._public["id"]:
                raise ProcurementClientError("UNKNOWN_SESSION")
            if self._ending or not self._active or self._public["state"] not in expected:
                raise ProcurementClientError("INVALID_STATE")
            if self._busy:
                raise ProcurementClientError("SESSION_BUSY")
            if admission is not None:
                admission()
            self._busy = True
            future = self._pool.submit(self._run, operation, state)
        return future.result()

    def _run(self, operation, state):
        self._worker_id = threading.get_ident()
        try:
            with self._lock:
                if self._ending:
                    raise ProcurementClientError("SESSION_ENDED")
            result = operation()
            with self._lock:
                if self._ending:
                    raise ProcurementClientError("SESSION_ENDED")
                if state is not None:
                    self._public.update(copy.deepcopy(result), state=state)
                    return self.snapshot()
                return result
        except Exception:
            with self._lock:
                if not self._ending:
                    self._public["state"] = "FAILED"
                    self._cleanup()
            raise ProcurementClientError("LOCAL_OPERATION_FAILED") from None
        finally:
            with self._lock:
                if not self._ending:
                    self._busy = False

    def publish_payload(self, identity, *, expected_revision):
        """Exact cloud publish body, repeatable for caller-owned idempotency retry."""
        if type(expected_revision) is not int or expected_revision != 0:
            raise ProcurementClientError("REVISION_MISMATCH")
        def operation():
            if time.time_ns() >= v2.u64(self._private["intent"]["bidDeadlineNs"]):
                raise ValueError("publication deadline passed")
            return {"expectedRevision": expected_revision,
                    "intent": copy.deepcopy(self._private["intent"]),
                    "budgetCommitment": self._private["commitment"]}
        return self._call(identity, {"PREPARED"}, operation, None)

    def _budget_plan(self, evidence_hash):
        """Authenticate via configured adapter, then bind exact draft and all four slots."""
        private = self._private
        expected = {"draft": private["draft"], "intent": private["intent"],
                    "contextHash": private["context"], "budgetCommitment": private["commitment"]}
        plan = copy.deepcopy(self._plan_verifier(copy.deepcopy(expected), evidence_hash))
        v2.schema(plan, {"job", "manifest", "manifestHash"}, "authenticated buyer input plan")
        closed, draft, intent = plan["job"], private["draft"], private["intent"]
        v2.schema(closed, _DRAFT_FIELDS, "authenticated frozen app job")
        for key in ("id", "title", "profile", "buyer", "roster", "bidDeadlineNs", "resultDeadlineNs",
                    "createdAt", "ledger", "blockchainBinding"):
            if closed[key] != draft[key]:
                raise ValueError("frozen app job differs from prepared draft")
        integer(closed["revision"], 1, 63, "closed app revision")
        integer(closed["createdAt"], 0, 2**53 - 1, "app creation time")
        integer(closed["updatedAt"], 0, 2**53 - 1, "app update time")
        integer(closed["closedAt"], 0, 2**53 - 1, "app closure time")
        if (closed["status"] != "CLOSED" or closed["selection"] is not None or
                closed["decision"] is not None or closed["deliveries"] != [] or
                closed["updatedAt"] < max(draft["updatedAt"], closed["closedAt"]) or
                closed["closedAt"] < closed["createdAt"] or
                not v2.u64(intent["bidDeadlineNs"]) // 10**6 <= closed["closedAt"] <=
                v2.u64(intent["resultDeadlineNs"]) // 10**6):
            raise ValueError("invalid frozen app state/times")
        v2.validate_intent(closed["intent"])
        if (closed["intent"] != intent or closed["contextHash"] != private["context"] or
                closed["budgetCommitment"] != private["commitment"] or
                intent["mpcProgramHash"] != self._config.mpc_program_hash or
                intent["mpcProgramHash"] != v2.program_hash() or intent["upstream"] != UPSTREAM):
            raise ValueError("frozen intent/budget/build differs from prepared session")
        bids = closed["bids"]
        if type(bids) is not list or len(bids) != 3:
            raise ValueError("all three frozen app bids required")
        commitments = [_hash(closed["budgetCommitment"])]
        for slot, (provider, bid) in enumerate(zip(intent["roster"], bids), 1):
            v2.schema(bid, {"provider", "slot", "commitment"}, "frozen app bid")
            if bid["provider"] != provider or type(bid["slot"]) is not int or bid["slot"] != slot:
                raise ValueError("frozen bid roster/slot mismatch")
            commitments.append(_hash(bid["commitment"]))
        manifest = v2.validate_manifest(plan["manifest"])
        if (v2.u64(manifest["closedJob"]["job_id"]) == 0 or manifest["intent"] != intent or
                manifest["commitments"] != commitments or
                v2.manifest_digest(manifest) != _hash(plan["manifestHash"])):
            raise ValueError("registry manifest/four commitments/digest mismatch")
        return manifest, plan["manifestHash"]

    def run_private_input(self, identity, *, evidence_hash):
        """Send slot-0 budget once; return LOCAL buyer result, keeping successful FHE alive.

        Only the evidence hash is a request parameter. runner is SERVER configured
        with sealed_client.run's signature; the default imports the strict real
        loopback client, codec_version=2 and an authenticated expected digest.
        Missing configuration/early calls do not consume the opening. Once a plan
        attempt starts, any error burns the opening and follows existing FAILED
        FHE cleanup. No automatic retry after an ambiguous outcome.
        """
        if self._plan_verifier is None or self._input_port is None:
            raise ProcurementClientError("PRIVATE_INPUT_UNAVAILABLE")
        try:
            _hash(evidence_hash)
        except Exception:
            raise ProcurementClientError("INVALID_EVIDENCE_HASH") from None

        def admission():
            if "privateInput" in self._public:
                raise ProcurementClientError("INVALID_STATE")
            intent = self._public["intent"]
            if not v2.u64(intent["bidDeadlineNs"]) <= time.time_ns() < v2.u64(intent["resultDeadlineNs"]):
                raise ProcurementClientError("INPUT_WINDOW_CLOSED")

        def operation():
            budget = salt = output = None
            private = self._private
            try:
                with self._lock:
                    self._public["privateInput"] = {"state": "VERIFYING_PLAN"}
                manifest, manifest_hash = self._budget_plan(evidence_hash)
                self._check_live()
                budget, salt = private["budget"], private["salt"]
                if v2.commitment(private["context"], 0, budget, salt) != private["commitment"]:
                    raise ValueError("retained budget opening mismatch")
                intent = private["intent"]
                if time.time_ns() < v2.u64(intent["bidDeadlineNs"]):
                    raise ValueError("input precedes bid deadline")
                remaining = min(self._deadline - time.monotonic(), self._input_timeout,
                                (v2.u64(intent["resultDeadlineNs"]) - time.time_ns()) / 10**9)
                if not 0 < remaining <= 600:
                    raise ValueError("private input deadline passed")
                with self._lock:
                    self._check_live()
                    private["budget"] = private["salt"] = None
                    self._public["privateInput"]["state"] = "SENDING_INPUT"
                if self._input_runner is None:
                    from mpc.sealed_client import run
                else:
                    run = self._input_runner
                output = run(manifest, 0, self._input_port, self._input_certificates, budget, salt,
                             timeout=remaining, codec_version=2, expected_manifest_hash=manifest_hash)
                if (time.monotonic() >= self._deadline or
                        not v2.u64(intent["bidDeadlineNs"]) <= time.time_ns() <
                        v2.u64(intent["resultDeadlineNs"])):
                    raise ValueError("buyer output arrived after the input window")
                if type(output) is not list or len(output) != 4 or any(type(x) is not int for x in output):
                    raise ValueError("invalid buyer output schema")
                found, slot, price, total = output
                if found == 0:
                    if output != [0, 0, 0, 0]:
                        raise ValueError("invalid no-winner output")
                elif (found != 1 or not 1 <= slot <= 3 or not intent["qualified"][slot - 1] or
                      not 1 <= price <= MAX_AMOUNT or total != price + intent["fixedFee"] or total > budget):
                    raise ValueError("invalid buyer winner/price/total")
                self._check_live()
                return {"privateInput": {"state": "INPUT_COMPLETE", "manifestHash": manifest_hash,
                        "found": bool(found), "selectedSlot": slot,
                        "selectedProvider": intent["roster"][slot - 1] if found else None,
                        "price": price, "total": total}}
            except Exception:
                with self._lock:
                    self._public["privateInput"]["state"] = "FAILED"
                raise
            finally:
                private["budget"] = private["salt"] = None
                budget = salt = output = None
        try:
            return self._call(identity, {"PREPARED"}, operation, "PREPARED", admission=admission)
        except ProcurementClientError as error:
            if error.code == "LOCAL_OPERATION_FAILED":
                raise ProcurementClientError("PRIVATE_INPUT_FAILED") from None
            raise

    def evaluate(self, identity, *, evidence_hash):
        """Authenticate selected registry attempt, bind once, then real evaluation.

        No caller-supplied binding/verified boolean is accepted. Verifier receives
        a detached public dict and nonzero evidence hash, never budget or salt.
        Registry consistency checks supplement, but do not replace, authentication.
        """
        if self._verifier is None:
            raise ProcurementClientError("BINDING_UNAVAILABLE")
        try:
            _hash(evidence_hash)
        except Exception:
            raise ProcurementClientError("INVALID_EVIDENCE_HASH") from None
        def operation():
            private = self._private
            intent = private["intent"]
            with self._lock:
                self._public["state"] = "EVALUATING"
            expected = {"draft": private["draft"], "intent": intent,
                        "contextHash": private["context"], "budgetCommitment": private["commitment"]}
            job = copy.deepcopy(self._verifier(copy.deepcopy(expected), evidence_hash))
            expected_config = {"spec_hash": list(v2.hex32(intent["specHash"])),
                "circuit_hash": list(v2.hex32(intent["circuitHash"])),
                "key_hash": list(v2.hex32(intent["keyHash"])),
                "output_policy_hash": list(v2.hex32(intent["outputPolicyHash"])),
                "context_hash": list(v2.hex32(private["context"])),
                "input_hash": list(v2.hex32(intent["inputHash"])),
                "budget_commitment": list(v2.hex32(private["commitment"])),
                "bid_deadline_ns": intent["bidDeadlineNs"], "result_deadline_ns": intent["resultDeadlineNs"],
                "authorized_bidders": intent["roster"], "executor": intent["registryExecutor"]}
            verify_registry_job(job, contract_account=self._config.registry_account,
                                network_domain_hash=list(v2.hex32(self._config.network_domain_hash)),
                                expected_config=expected_config)
            validate_executing_job(job, job["attempt"])
            if (job["buyer"] != intent["buyer"] or job.get("attempt_binding_version") != 2 or
                    any(bid["commitment"] is None for bid in job["bids"]) or
                    not intent["qualified"][intent["roster"].index(job["selected_executor"])] or
                    not v2.u64(intent["bidDeadlineNs"]) <= time.time_ns() <
                    v2.u64(intent["resultDeadlineNs"])):
                raise ValueError("selected registry job mismatch/expired")
            binding = {key: job[key] for key in ("job_id", "attempt")}
            binding.update({key: v2.registry_hash(job[key]).hex() for key in
                            ("job_binding_hash", "attempt_binding_hash", "bidset_root")})
            validate_external_binding(binding)
            self._check_live()
            private["prepared"].bind_external(binding)
            self._check_live()
            if self._evaluator is None:
                evaluation = private["prepared"].evaluate()
            else:
                evaluation = private["prepared"].evaluate_remote(self._evaluator)
            # Allowlist hashes only; engine receipt/metrics are never arbitrary API data.
            return {"evaluationHashes": {key: _hash(evaluation[key]) for key in
                    ("outputSha256", "receiptSha256", "requestManifestSha256")}}
        return self._call(identity, {"PREPARED"}, operation, "EVALUATED")

    def finalize(self, identity):
        """Return decrypted, reference-checked data locally, then release all secrets."""
        def operation():
            result = self._private["prepared"].finalize()
            if result.get("verified") is not True:
                raise ValueError("local reference check failed")
            with self._lock:
                self._check_live()
                self._public["state"] = "FINALIZED"
            self._cleanup()
            return result
        return self._call(identity, {"EVALUATED"}, operation, None)

    def _cleanup(self):
        # Sole worker only: PreparedJob owns a thread-affine generator lock.
        try:
            if self._private is not None:
                self._private["prepared"].close()
        except Exception:
            # A trusted engine/adapter may have raised a secret-bearing error.
            # Keep the release path and all public failures non-reflective.
            with self._lock:
                self._public["state"] = "FAILED"
        finally:
            if self._private is not None:
                self._private.clear()
            self._private = None
            with self._lock:
                self._active = False
                if self._timer:
                    self._timer.cancel()

    def _close_worker(self):
        self._worker_id = threading.get_ident()
        try:
            self._cleanup()
        finally:
            with self._lock:
                self._busy = False

    def _end(self, identity, state):
        with self._lock:
            if not self._public or identity != self._public["id"]:
                raise ProcurementClientError("UNKNOWN_SESSION")
            if self._ending:
                return self._end_future
            if not self._active:
                return None
            self._ending = state
            self._busy = True
            self._public["state"] = state
            self._timer.cancel()
            self._end_future = self._pool.submit(self._close_worker)
            return self._end_future

    def _expire(self, identity):
        with self._lock:
            if not self._closed and self._public and self._public["id"] == identity:
                self._end(identity, "EXPIRED")

    def close_session(self, identity):
        """Idempotently release a session; wait for same-thread cleanup."""
        with self._lock:
            self._admit()
            future = self._end(identity, "CLOSED")
        if future:
            future.result()
        return self.snapshot()

    def close(self):
        """Stop admission, drain current operation, release SK on its owner thread."""
        if threading.get_ident() == self._worker_id:
            raise ProcurementClientError("REENTRANT_CALL")
        with self._lock:
            if not self._closed:
                self._closed = True
                if self._active:
                    self._end(self._public["id"], "CLOSED")
        self._pool.shutdown(wait=True)
