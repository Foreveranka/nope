"""Memory-only provider bid openings for the existing LOCAL loopback MPC client.

The HTTP mount must authenticate the provider and fetch published_job through its
authenticated procurement proxy. Never accept a browser's job/principal assertion
as that authentication. This service validates bindings, not network provenance.

Configure ProcurementConfig, plan_verifier, port and certificate_dir SERVER SIDE.
plan_verifier(public_expectations, evidence_hash) returns exactly:
    {"job": authenticated_CLOSED_app_Job,
     "manifest": authenticated_v2_selection_manifest,
     "manifestHash": independently_authenticated_v2_manifest_digest}
It must authenticate the frozen app revision, registry network/contract/code and
job provenance, and the admitted plan/round/transport/certificate trust anchors.
Merely recomputing hashes is NOT authentication. The service adds strict codec and
cross-snapshot checks; it cannot establish these sources' provenance itself.

Only an evidence hash comes from HTTP. There is no request-level manifest, host,
port, certificate path, trust anchor or runner override. Default execution calls
mpc.sealed_client.run with codec_version=2, pinned manifest hash and configured
local certificates/port; that implementation connects only to 127.0.0.1.

Each session can attempt private input ONCE, including on ambiguous failure.
No retries, recovery from restart, secret disk writes or secret outputs. This
does not claim durable replay protection, independent operators or an MPC proof.
Buyer budget input is a separate adapter, not part of this provider service.

Expiry/close immediately drops stored secret references. Already running native
or adapter code cannot be interrupted; its temporary secret references live until
it returns. Adapters must bound I/O; close() drains workers. Reference release is
not secure zeroing. Terminal snapshots can be evicted to keep storage bounded.
"""
import copy
import math
import re
import secrets
import threading
import time
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass, field
from pathlib import Path

from engine.protocol import PROFILE_ID, artifact_pins
from mpc import v2
from mpc.auction import MAX_AMOUNT, UPSTREAM, integer
from .procurement_client import ProcurementConfig

__all__ = ["BidClient", "BidClientError"]

_JOB_FIELDS = {"id", "title", "profile", "buyer", "roster", "bidDeadlineNs",
               "resultDeadlineNs", "status", "revision", "createdAt", "updatedAt",
               "ledger", "blockchainBinding", "intent", "contextHash", "budgetCommitment",
               "bids", "closedAt", "selection", "deliveries", "decision"}
_TERMINAL = {"INPUT_COMPLETE", "FAILED", "EXPIRED", "CLOSED"}


class BidClientError(RuntimeError):
    """Fixed public code, never engine/transport/verifier exception text."""
    def __init__(self, code):
        self.code = code
        super().__init__(code)


def _hash(value):
    if v2.hex32(value) == bytes(32):
        raise ValueError("nonzero public hash required")
    return value


def _seconds(value, maximum):
    if (type(value) not in (int, float) or not math.isfinite(value) or
            not 0 < value <= maximum):
        raise ValueError("invalid bounded timeout")
    return value


def _job(job, config, status):
    v2.schema(job, _JOB_FIELDS, "authenticated app job")
    if (type(job["id"]) is not str or not re.fullmatch(r"[0-9a-f]{32}", job["id"]) or
            type(job["title"]) is not str or
            not re.fullmatch(r"[A-Za-z0-9 .,()_-]{1,100}", job["title"]) or
            job["status"] != status or job["profile"] != PROFILE_ID or
            job["ledger"] != "app" or job["blockchainBinding"] != "pending" or
            job["selection"] is not None or job["decision"] is not None or job["deliveries"] != []):
        raise ValueError("invalid app job metadata")
    integer(job["revision"], 1, 63, "app revision")
    for key in ("createdAt", "updatedAt"):
        integer(job[key], 0, 2**53 - 1, key)
    if job["updatedAt"] < job["createdAt"]:
        raise ValueError("invalid app timestamps")
    intent = v2.validate_intent(job["intent"])
    pins = artifact_pins(config.artifact_set)
    if (intent["registryAccount"] != config.registry_account or
            intent["networkDomainHash"] != config.network_domain_hash or
            intent["registryExecutor"] != config.registry_executor or
            intent["outputPolicyHash"] != config.output_policy_hash or
            intent["mpcProgramHash"] != config.mpc_program_hash or
            intent["mpcProgramHash"] != v2.program_hash() or intent["upstream"] != UPSTREAM or
            intent["upstream"] != config.upstream or
            intent["specHash"] != pins["client-specs.json"] or
            intent["circuitHash"] != pins["server.zip"]):
        raise ValueError("intent differs from configured source/artifact pins")
    for key in ("buyer", "roster", "bidDeadlineNs", "resultDeadlineNs"):
        if job[key] != intent[key]:
            raise ValueError("job differs from intent")
    if job["contextHash"] != v2.precommit_context(intent):
        raise ValueError("intent context mismatch")
    _hash(job["budgetCommitment"])
    bids = job["bids"]
    if type(bids) is not list or len(bids) != 3:
        raise ValueError("three app bid slots required")
    seen = set()
    for slot, (provider, bid) in enumerate(zip(intent["roster"], bids), 1):
        v2.schema(bid, {"provider", "slot", "commitment"}, "app bid")
        if bid["provider"] != provider or type(bid["slot"]) is not int or bid["slot"] != slot:
            raise ValueError("app bid roster/slot mismatch")
        committed = bid["commitment"]
        if committed is not None:
            _hash(committed)
            if committed in seen:
                raise ValueError("duplicate app bid commitment")
            seen.add(committed)
        elif status == "CLOSED":
            raise ValueError("complete frozen bidset required")
    if status == "PUBLISHED":
        if job["closedAt"] is not None:
            raise ValueError("published job already closed")
    else:
        integer(job["closedAt"], 0, 2**53 - 1, "closure time")
        # App times are milliseconds; registry/intent times are nanoseconds.
        if not (v2.u64(intent["bidDeadlineNs"]) // 10**6 <= job["closedAt"] <=
                v2.u64(intent["resultDeadlineNs"]) // 10**6):
            raise ValueError("app closure outside intent window")
    return job


@dataclass
class _Session:
    public: dict
    job: dict
    deadline: float
    price: object = field(repr=False)
    salt: object = field(repr=False)
    timer: object = field(default=None, repr=False)
    running: bool = False

    def __reduce_ex__(self, protocol):
        raise TypeError("Bid openings cannot be serialized")

    def release(self, *, cancel_timer=True):
        self.price = self.salt = None
        if cancel_timer and self.timer is not None:
            self.timer.cancel()


class BidClient:
    """Bounded local provider sessions; public APIs never return private outputs.

    prepare(published_job, provider_principal, price=integer_micro_units) returns
    {id,jobId,provider,slot,contextHash,commitment,state,expiresAt} only.
    snapshot(id), close_session(id), run_private_input(id,evidence_hash=...) return
    detached copies of the same public snapshot (plus manifestHash after input).
    lookup(job_id, provider) returns the matching live public snapshot or None,
    for recovery after a lost prepare response. It never refreshes an opening.

    The mount must authorize each session operation against snapshot(id).provider.
    runner is a SERVER-owned adapter with the same signature as sealed_client.run;
    omitting it invokes the real strict client, never a synthetic MPC substitute.
    Configure both port and certificate_dir before attempting any input. A
    max_sessions-sized pool permits three provider inputs to enter concurrently.
    """
    def __init__(self, config, *, timeout_seconds=1800, max_sessions=3,
                 plan_verifier=None, runner=None, port=None, certificate_dir=None,
                 input_timeout_seconds=60):
        if type(config) is not ProcurementConfig:
            raise ValueError("explicit trusted ProcurementConfig required")
        _seconds(timeout_seconds, 1800)
        _seconds(input_timeout_seconds, 600)
        integer(max_sessions, 1, 16, "maximum sessions")
        for adapter in (plan_verifier, runner):
            if adapter is not None and not callable(adapter):
                raise ValueError("server adapter must be callable")
        if (port is None) != (certificate_dir is None):
            raise ValueError("configure both local port and certificate directory")
        if port is not None:
            integer(port, 1024, 65532, "local port")
            certificate_dir = Path(certificate_dir)
            if (not certificate_dir.is_absolute() or certificate_dir.is_symlink() or
                    not certificate_dir.is_dir()):
                raise ValueError("configured absolute local certificate directory required")
            certificate_dir = certificate_dir.resolve()
        self._config = config
        self._ttl, self._max = timeout_seconds, max_sessions
        self._verifier, self._runner = plan_verifier, runner
        self._port, self._certificates = port, certificate_dir
        self._input_timeout = input_timeout_seconds
        self._lock = threading.RLock()
        self._pool = ThreadPoolExecutor(max_workers=max_sessions, thread_name_prefix="provider-input")
        self._worker = threading.local()
        self._sessions = {}
        self._closed = False

    def __reduce_ex__(self, protocol):
        raise TypeError("Live bid clients cannot be serialized")

    def __enter__(self):
        return self

    def __exit__(self, *args):
        self.close()

    def _admit(self):
        if getattr(self._worker, "inside", False):
            raise BidClientError("REENTRANT_CALL")
        if self._closed:
            raise BidClientError("CLIENT_CLOSED")

    def _get(self, identity):
        if type(identity) is not str or identity not in self._sessions:
            raise BidClientError("UNKNOWN_SESSION")
        session = self._sessions[identity]
        if time.monotonic() >= session.deadline and session.public["state"] not in _TERMINAL:
            session.public["state"] = "EXPIRED"
            session.release()
        return session

    def prepare(self, published_job, provider_principal, *, price):
        """Validate an authenticated publication; keep a fresh 32-byte opening RAM-only."""
        try:
            job = _job(copy.deepcopy(published_job), self._config, "PUBLISHED")
            v2.account(provider_principal)
            integer(price, 1, MAX_AMOUNT, "provider price")
            slot = job["roster"].index(provider_principal) + 1
            if (time.time_ns() >= v2.u64(job["bidDeadlineNs"]) or
                    job["bids"][slot - 1]["commitment"] is not None):
                raise ValueError("bid deadline passed or immutable bid already exists")
        except Exception:
            raise BidClientError("INVALID_BID_PREPARATION") from None
        with self._lock:
            self._admit()
            # Keep terminal entries for inspection until capacity is needed; never
            # evict a worker or a live opening, even when its TTL has elapsed.
            for identity in list(self._sessions):
                self._get(identity)
            for session in self._sessions.values():
                if (session.job["id"] == job["id"] and session.public["provider"] == provider_principal and
                        (session.running or session.public["state"] not in _TERMINAL)):
                    raise BidClientError("BID_ALREADY_PREPARED")
            if len(self._sessions) >= self._max:
                for identity, session in list(self._sessions.items()):
                    if not session.running and session.public["state"] in _TERMINAL:
                        del self._sessions[identity]
                        break
                if len(self._sessions) >= self._max:
                    raise BidClientError("SESSION_LIMIT")
            if time.time_ns() >= v2.u64(job["bidDeadlineNs"]):
                raise BidClientError("INVALID_BID_PREPARATION")
            salt = secrets.token_bytes(32)
            identity = secrets.token_hex(16)
            public = {"id": identity, "jobId": job["id"], "provider": provider_principal, "slot": slot,
                      "contextHash": job["contextHash"], "commitment": v2.commitment(job["contextHash"], slot, price, salt),
                      "state": "PREPARED", "expiresAt": int(time.time() * 1000 + self._ttl * 1000)}
            session = _Session(public, job, time.monotonic() + self._ttl, price, salt)
            session.timer = threading.Timer(self._ttl, self._expire, args=(identity,))
            session.timer.daemon = True
            self._sessions[identity] = session
            session.timer.start()
            return copy.deepcopy(public)

    def snapshot(self, identity):
        with self._lock:
            return copy.deepcopy(self._get(identity).public)

    def lookup(self, job_id, provider):
        """Recover a live public session for the mount's authenticated provider.

        Returns None for absent or terminal sessions, including expired/closed
        ones. The mount supplies provider from its authenticated session, never
        an arbitrary request principal. No new opening, deadline or timer is set.
        """
        try:
            if type(job_id) is not str or not re.fullmatch(r"[0-9a-f]{32}", job_id):
                raise ValueError("canonical public job id required")
            v2.account(provider)
        except Exception:
            raise BidClientError("INVALID_LOOKUP") from None
        with self._lock:
            self._admit()
            for identity in reversed(self._sessions):
                session = self._sessions[identity]
                if session.public["jobId"] == job_id and session.public["provider"] == provider:
                    session = self._get(identity)  # Enforce TTL even if timer is delayed.
                    if session.public["state"] not in _TERMINAL:
                        return copy.deepcopy(session.public)
            return None

    def _expire(self, identity):
        with self._lock:
            session = self._sessions.get(identity)
            if session is not None and session.public["state"] not in _TERMINAL:
                session.public["state"] = "EXPIRED"
                session.release()

    def close_session(self, identity):
        with self._lock:
            session = self._get(identity)
            if session.public["state"] not in _TERMINAL:
                session.public["state"] = "CLOSED"
            session.release()
            return copy.deepcopy(session.public)

    def run_private_input(self, identity, *, evidence_hash):
        """One conservative attempt; only an evidence hash is accepted from HTTP."""
        try:
            _hash(evidence_hash)
        except Exception:
            raise BidClientError("INVALID_EVIDENCE_HASH") from None
        with self._lock:
            self._admit()
            session = self._get(identity)
            if session.public["state"] != "PREPARED":
                raise BidClientError("INVALID_STATE")
            if self._verifier is None or self._port is None:
                raise BidClientError("PRIVATE_INPUT_UNAVAILABLE")
            if not (v2.u64(session.job["bidDeadlineNs"]) <= time.time_ns() <
                    v2.u64(session.job["resultDeadlineNs"])):
                raise BidClientError("INPUT_WINDOW_CLOSED")
            session.public["state"] = "VERIFYING_PLAN"
            session.running = True
            future = self._pool.submit(self._run, session, evidence_hash)
        return future.result()

    def _plan(self, session, evidence_hash):
        # No opening is copied into verifier expectations or any public structure.
        expected = {"job": copy.deepcopy(session.job), "provider": session.public["provider"],
                    "slot": session.public["slot"], "commitment": session.public["commitment"]}
        plan = copy.deepcopy(self._verifier(expected, evidence_hash))
        v2.schema(plan, {"job", "manifest", "manifestHash"}, "authenticated input plan")
        closed = _job(plan["job"], self._config, "CLOSED")
        for key in ("id", "title", "profile", "buyer", "roster", "bidDeadlineNs", "resultDeadlineNs",
                    "createdAt", "intent", "contextHash", "budgetCommitment"):
            if closed[key] != session.job[key]:
                raise ValueError("frozen app job differs from prepared bid")
        if closed["revision"] <= session.job["revision"] or closed["updatedAt"] < session.job["updatedAt"]:
            raise ValueError("closed app revision regressed")
        for known, frozen in zip(session.job["bids"], closed["bids"]):
            if known["commitment"] is not None and known["commitment"] != frozen["commitment"]:
                raise ValueError("previously published bid changed")
        manifest = v2.validate_manifest(plan["manifest"])
        if (v2.u64(manifest["closedJob"]["job_id"]) == 0 or
                manifest["intent"] != session.job["intent"] or
                manifest["commitments"] != [closed["budgetCommitment"]] +
                [bid["commitment"] for bid in closed["bids"]] or
                manifest["commitments"][session.public["slot"]] != session.public["commitment"] or
                v2.manifest_digest(manifest) != _hash(plan["manifestHash"])):
            raise ValueError("manifest/intent/four-commitment mismatch")
        return manifest, plan["manifestHash"]

    def _run(self, session, evidence_hash):
        self._worker.inside = True
        amount = salt = output = None
        try:
            manifest, manifest_hash = self._plan(session, evidence_hash)
            with self._lock:
                self._get(session.public["id"])
                if self._closed or session.public["state"] != "VERIFYING_PLAN":
                    raise ValueError("session ended before private input")
                remaining = min(session.deadline - time.monotonic(),
                    (v2.u64(session.job["resultDeadlineNs"]) - time.time_ns()) / 10**9,
                    self._input_timeout)
                _seconds(remaining, 600)
                amount, salt = session.price, session.salt
                if v2.commitment(session.public["contextHash"], session.public["slot"], amount, salt) != session.public["commitment"]:
                    raise ValueError("own bid opening mismatch")
                session.public["state"] = "SENDING_INPUT"
                # Transfer service ownership to this sole attempt. No second
                # caller can acquire the opening, even if the adapter fails.
                session.release(cancel_timer=False)
            if self._runner is None:
                from mpc.sealed_client import run
            else:
                run = self._runner
            output = run(manifest, session.public["slot"], self._port, self._certificates,
                         amount, salt, timeout=remaining, codec_version=2,
                         expected_manifest_hash=manifest_hash)
            # Provider output is [won_flag, own payout]. Check its shape, then
            # discard it: returning a payout would expose the retained price.
            if (type(output) is not list or len(output) != 2 or type(output[0]) is not int or
                    output[0] not in (0, 1) or type(output[1]) is not int or
                    output[1] != (amount if output[0] else 0)):
                raise ValueError("invalid provider private output")
            with self._lock:
                self._get(session.public["id"])
                if self._closed or session.public["state"] != "SENDING_INPUT":
                    raise ValueError("session ended during private input")
                session.public.update(state="INPUT_COMPLETE", manifestHash=manifest_hash)
                return copy.deepcopy(session.public)
        except Exception:
            with self._lock:
                if session.public["state"] not in _TERMINAL:
                    session.public["state"] = "FAILED"
            raise BidClientError("PRIVATE_INPUT_FAILED") from None
        finally:
            amount = salt = output = None
            with self._lock:
                session.release()
                session.running = False
            self._worker.inside = False

    def close(self):
        """Stop admission, erase stored openings, drain bounded in-flight adapters."""
        if getattr(self._worker, "inside", False):
            raise BidClientError("REENTRANT_CALL")
        with self._lock:
            self._closed = True
            for identity in self._sessions:
                self.close_session(identity)
        self._pool.shutdown(wait=True)
