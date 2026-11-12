"""One-shot, fixed-synthetic Privacy demo. No network IO on import.

run(path, on_event=None) requires NOPE_ENABLE_PRIVACY_DEMO=1. The path must
be a fresh direct child of ROOT/runtime; integration.testnet owns its creation.
Callbacks receive (stage, elapsed_seconds). Never expose native output or the
unfiltered integration result. Started markers survive success and failure;
restart reconciliation is read-only/operator work, never automatic resubmission.
"""
import contextlib
import fcntl
import json
import os
from pathlib import Path
import re
import signal
import stat
import subprocess
import sys
import time

from payments.http import strict_json
from payments.near_testnet import (NearTestnetRPC, TestnetPaymentBinding,
                                  accepted_registry, chain_hash, hex_hash, u64)
from payments.near_testnet_escrow import EscrowConfig, NearTestnetEscrowClient

ROOT = Path(__file__).resolve().parents[1]
OWNER = "veil-reg-e138f5c88250f821.testnet"
ESCROW = "escrow." + OWNER
REGISTRY_CODE = "5WzwjqPvm3nRz6CEkkx73R8dcBtu3YBH6gr6DnoccSEv"
ESCROW_CODE = "36ArHnTqzmnL25wym4Hp5gLPAfp2yuShqKXAXYAUdo5A"
AMOUNT = 10**21
PAYMENT_CAVEAT = ("Public fixed 0.001 test NEAR demonstration payment; "
                  "not proof of the private MPC winning price. No real-money payment.")
# These are the existing integration.testnet fixtures, not caller-supplied data.
SYNTHETIC_FIXTURE = {"records": [{"id": 7, "value": 255}, {"id": 2, "value": 144},
                                {"id": 7, "value": 42}, {"id": 3, "value": 5}],
                     "budget": 100_000_000, "prices": [90_000_000, 80_000_000, 95_000_000]}
LIMITS = [
    "Fixed synthetic inputs only; budget/prices are centralized and known to the coordinator.",
    "Actual encrypted evaluator subprocess and three MPC processes share one host/UID.",
    "Operators and testnet accounts have one administrator; independent operators: false.",
    "Buyer acceptance and client reference verification are not execution proofs.",
    "Registry does not verify MPC selection or winning price; RPC observations are trusted.",
    PAYMENT_CAVEAT,
    "Registry lifecycle and escrow settlement are separate transactions.",
    "Local journals are not independent timestamp or light-client proofs.",
    "Interrupted outcomes require manual read-only reconciliation; no automatic retry.",
]
COMMANDS = frozenset(("create_job", "bid", "close", "begin_execution", "submit_receipt", "decide"))
PAYMENT_FILES = ("testnet-payout.json", "testnet-payout-verified.json")
MAX_FILE = 2 * 1024 * 1024


class PrivacyDemoError(RuntimeError):
    """Only fixed machine codes cross the service boundary."""


def _fail(code):
    raise PrivacyDemoError(code)


def _sync_dir(path):
    fd = os.open(path, os.O_RDONLY)
    try:
        os.fsync(fd)
    finally:
        os.close(fd)


def _write(path, value):
    raw = (json.dumps(value, allow_nan=False, sort_keys=True) + "\n").encode()
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
    with os.fdopen(fd, "wb") as stream:
        stream.write(raw)
        stream.flush()
        os.fsync(stream.fileno())
    _sync_dir(path.parent)


def _read_bytes(path):
    fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW)
    with os.fdopen(fd, "rb") as stream:
        info = os.fstat(stream.fileno())
        if not stat.S_ISREG(info.st_mode) or info.st_size > MAX_FILE:
            _fail("UNSAFE_EVIDENCE_FILE")
        raw = stream.read(MAX_FILE + 1)
        if len(raw) > MAX_FILE:
            _fail("EVIDENCE_TOO_LARGE")
        return raw


def _read(path):
    return strict_json(_read_bytes(path))


def _bounded(command, timeout):
    """No child stdout/stderr is surfaced. Never retry a timed-out mutation."""
    with subprocess.Popen(command, cwd=ROOT, stdin=subprocess.DEVNULL,
                          stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
                          start_new_session=True) as child:
        try:
            if child.wait(timeout=timeout) != 0:
                _fail("CHILD_FAILED_OR_UNKNOWN_NO_RESUBMIT")
        except BaseException:
            if child.poll() is None:
                # Python integration worker handles TERM by unwinding the driver
                # context; the escrow sender retains its signed once-journals.
                os.killpg(child.pid, signal.SIGTERM)
                try:
                    child.wait(timeout=15)
                except subprocess.TimeoutExpired:
                    os.killpg(child.pid, signal.SIGKILL)
                    child.wait(timeout=5)
            raise


def _integration(path):
    # Calls the existing genuine run, with its own lock and fresh-directory check.
    code = ("import signal,sys; from integration.testnet import run; "
            "signal.signal(signal.SIGTERM,lambda *_:sys.exit(1)); "
            "run(sys.argv[1],driver_ready=True)")
    _bounded([sys.executable, "-c", code, str(path)], 2100)
    return _read(path / "result.json")


def _config():
    return EscrowConfig(ESCROW, ESCROW_CODE, OWNER, REGISTRY_CODE)


def _binding(summary):
    """Bind payment to this run, never to the global previous-job handoff."""
    from sdk.registry import verify_registry_job
    from integration.testnet import DOMAIN_HASH
    if (type(summary) is not dict or any(summary.get(k) is not True for k in
            ("completed", "synthetic_only", "real_fhe", "real_mpc", "actual_near_testnet"))
            or summary.get("network") != "testnet" or summary.get("contract_account") != OWNER
            or summary.get("independent_operators") is not False
            or summary.get("execution_proof") is not False):
        _fail("GENUINE_SYNTHETIC_INTEGRATION_REQUIRED")
    job = summary["accepted_job"]
    jid = u64(summary["job_id"], 1)
    provider = summary["selected_executor"]
    if (provider not in ["p%d.%s" % (n, OWNER) for n in (1, 2, 3)]
            or job["job_id"] != jid or job["buyer"] != OWNER or job["state"] != "Accepted"
            or job["selected_executor"] != provider or job["attempt_binding_version"] != 2
            or not verify_registry_job(job, contract_account=OWNER, network_domain_hash=list(DOMAIN_HASH))):
        _fail("EXACT_ACCEPTED_JOB_REQUIRED")
    receipt = job["receipts"][-1]
    claim = receipt["claim"]
    if receipt["status"] != "BuyerAccepted" or claim["job_id"] != jid or claim["attempt"] != job["attempt"]:
        _fail("EXACT_ACCEPTED_RECEIPT_REQUIRED")
    for key in ("context_hash", "job_binding_hash", "attempt_binding_hash"):
        expected = job["config"][key] if key == "context_hash" else job[key]
        if claim[key] != expected:
            _fail("RECEIPT_BINDING_MISMATCH")
    if hex_hash(claim["output_hash"]) != summary.get("artifactHashes", {}).get("outputSha256"):
        _fail("FHE_CIPHERTEXT_OUTPUT_BINDING_MISMATCH")
    return TestnetPaymentBinding(registry_id=OWNER, registry_code_hash=REGISTRY_CODE,
        job_id=jid, buyer_id=OWNER, provider_id=provider, amount_yocto=AMOUNT,
        context_hash=hex_hash(job["config"]["context_hash"]),
        job_binding_hash=hex_hash(job["job_binding_hash"]), attempt=u64(job["attempt"], 1),
        attempt_binding_hash=hex_hash(job["attempt_binding_hash"]),
        receipt_hash=hex_hash(receipt["receipt_hash"]), output_hash=hex_hash(claim["output_hash"])).validate()


def _driver_released(path, summary):
    events = _read_bytes(path / "events.jsonl").splitlines()
    last = strict_json(events[-1]) if events else {}
    lock = ROOT / "contracts/registry/deploy/runtime/near-testnet/operation.lock"
    if (last.get("stage") != "driver_stopped" or last.get("public") != {"exit_code": 0}
            or os.path.lexists(lock)
            or not any(c.get("name") == "Node testnet driver exited cleanly" and c.get("pass") is True
                       for c in summary.get("checks", []))):
        _fail("DRIVER_OWNER_LOCK_NOT_RELEASED")


class _DeadlineRPC(NearTestnetRPC):
    def __init__(self):
        super().__init__()
        self.deadline = time.monotonic() + 180

    def _request(self, method, params):
        remaining = self.deadline - time.monotonic()
        if remaining <= 0:
            _fail("OBSERVER_DEADLINE_NO_RESUBMIT")
        self.timeout = min(15, remaining)
        return super()._request(method, params)


def _preflight(binding):
    rpc = _DeadlineRPC()
    accepted_registry(rpc, binding)
    if NearTestnetEscrowClient(_config(), rpc).inspect(binding.job_id)["hold"] is not None:
        _fail("EXISTING_PAYMENT_NO_RESUBMIT")


def _validate_handoff(value, binding):
    for key in ("registry_id", "registry_code_hash", "job_id", "buyer_id", "provider_id",
                "context_hash", "job_binding_hash", "attempt", "attempt_binding_hash", "receipt_hash", "output_hash"):
        if value.get(key) != getattr(binding, key):
            _fail("PAYMENT_HANDOFF_BINDING_MISMATCH")
    if (value.get("network") != "testnet" or value.get("escrow_id") != ESCROW
            or value.get("escrow_code_hash") != ESCROW_CODE or value.get("amount_yocto") != str(AMOUNT)
            or value.get("finality") != "FINAL" or value.get("state") != "Paid"
            or value.get("fixed_demonstration_price") is not True
            or value.get("mpc_winning_price_proven") is not False
            or value.get("payout_amount_public") is not True):
        _fail("FIXED_PUBLIC_TESTNET_PAYMENT_REQUIRED")
    chain_hash(value["fund_hash"])
    chain_hash(value["release_hash"])


@contextlib.contextmanager
def _preserve_payment_files(path):
    """Archive byte-exact old proof before the existing client may overwrite it.

    The main operator must serialize all signer operations, including standalone
    client/verify_payout.py invocations. The per-run archive survives interruption;
    the durable marker prevents a restart from erasing it or resubmitting.
    """
    directory = ROOT / "payments/testnet_escrow/verification"
    archive = path / "payment-evidence-before"
    archive.mkdir(mode=0o700)
    saved = {}
    for name in PAYMENT_FILES:
        original = directory / name
        if os.path.lexists(original):
            raw = _read_bytes(original)
            mode = stat.S_IMODE(original.stat().st_mode)
            saved[name] = (raw, mode)
            fd = os.open(archive / name, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
            with os.fdopen(fd, "wb") as stream:
                stream.write(raw); stream.flush(); os.fsync(stream.fileno())
        else:
            saved[name] = None
    _write(archive / "manifest.json", {n: {"existed": v is not None,
        "mode": v[1] if v else None} for n, v in saved.items()})
    # Persist both new directory entries before the client overwrites old proof.
    for parent in (path, path.parent):
        fd = os.open(parent, os.O_RDONLY | os.O_DIRECTORY)
        try:
            os.fsync(fd)
        finally:
            os.close(fd)
    try:
        yield directory
    finally:
        # Restoration must run even if capturing the new evidence fails.
        for name, previous in saved.items():
            original = directory / name
            if previous is None:
                if os.path.lexists(original):
                    if original.is_symlink():
                        _fail("PAYMENT_EVIDENCE_RESTORE_CONFLICT")
                    original.unlink()
            else:
                temporary = archive / (name + ".restore")
                fd = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, previous[1])
                with os.fdopen(fd, "wb") as stream:
                    stream.write(previous[0]); stream.flush(); os.fsync(stream.fileno())
                os.chmod(temporary, previous[1])
                os.replace(temporary, original)
        _sync_dir(directory)


def _pay(path, binding):
    with _preserve_payment_files(path) as directory:
        try:
            _bounded(["node", str(ROOT / "payments/testnet_escrow/client.mjs"),
                      "pay", binding.job_id, "--owner-lock-free"], 300)
        finally:
            # Preserve a newly written handoff even on a client failure. It is
            # unverified until exact binding + independent observer checks pass.
            source = directory / "testnet-payout.json"
            if source.is_file() and not source.is_symlink():
                _write(path / "payment-handoff.json", _read(source))
        value = _read(path / "payment-handoff.json")
        _validate_handoff(value, binding)
    observed = NearTestnetEscrowClient(_config(), _DeadlineRPC()).verify_release(value["release_hash"], binding)
    _write(path / "payment-verified.json", observed)
    return value, observed


def _transactions(summary, payment):
    result = []
    for tx in summary["transactions"]:
        if tx.get("command") not in COMMANDS or tx.get("finality") != "FINAL":
            _fail("UNEXPECTED_REGISTRY_TRANSACTION")
        result.append({"command": tx["command"], "hash": chain_hash(tx["hash"])})
    for command in ("fund", "release"):
        result.append({"command": command, "hash": chain_hash(payment[command + "_hash"])})
    if len(result) > 16 or len({tx["hash"] for tx in result}) != len(result):
        _fail("TRANSACTION_SET_INVALID")
    for tx in result:
        tx["explorerUrl"] = "https://testnet.nearblocks.io/txns/" + tx["hash"]
    return result


def _records(summary):
    records = summary.get("verified_synthetic_records")
    if records is None:
        return None
    if type(records) is not list or len(records) != 4:
        _fail("INVALID_VERIFIED_RECORDS")
    for row in records:
        if (type(row) is not dict or set(row) != {"id", "value", "duplicate"}
                or type(row["duplicate"]) is not bool
                or any(type(row[k]) is not int or not 0 <= row[k] <= 255 for k in ("id", "value"))):
            _fail("INVALID_VERIFIED_RECORDS")
    return [{key: row[key] for key in ("id", "value", "duplicate")} for row in records]


def _metadata(summary):
    checks = []
    for item in summary.get("checks", []):
        name = item.get("name")
        if (type(name) is not str or not 1 <= len(name) <= 160
                or not name.isprintable() or item.get("pass") is not True):
            _fail("INVALID_INTEGRATION_CHECK")
        checks.append({"name": name, "pass": True})
    if not 1 <= len(checks) <= 64:
        _fail("VERIFIED_INTEGRATION_CHECKS_REQUIRED")
    hashes = {}
    allowed = ("serverSha256", "evaluationKeysSha256", "inputSha256", "outputSha256",
               "requestSha256", "receiptSha256", "externalBindingSha256", "manifestSha256")
    for key, value in summary.get("artifactHashes", {}).items():
        if key in allowed and type(value) is str and re.fullmatch(r"[0-9a-f]{64}", value):
            hashes[key] = value
    return checks, hashes


def run(output_dir, on_event=None):
    """Execute once, returning only the service/UI public presentation schema."""
    if os.environ.get("NOPE_ENABLE_PRIVACY_DEMO") != "1":
        _fail("EXPLICIT_PRIVACY_DEMO_OPT_IN_REQUIRED")
    runtime = ROOT / "runtime"
    path = Path(output_dir).absolute()
    if (runtime.is_symlink() or path.parent != runtime or path.is_symlink()
            or os.path.lexists(path) or not path.name.startswith("privacy-demo-")):
        _fail("FRESH_DIRECT_CHILD_RUNTIME_REQUIRED")
    runtime.mkdir(mode=0o700, exist_ok=True)
    started = time.monotonic()
    # Sibling marker does not violate testnet.run's nonexistent-output contract.
    marker = runtime / (path.name + ".started.json")
    lock = os.open(runtime / "privacy-demo.lock", os.O_CREAT | os.O_RDWR | os.O_NOFOLLOW, 0o600)
    try:
        try:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            _fail("PRIVACY_DEMO_BUSY_NO_RESUBMIT")
        try:
            _write(marker, {"network": "testnet", "synthetic_only": True, "automatic_retry": False})
        except FileExistsError:
            _fail("PRIVACY_DEMO_ALREADY_STARTED_NO_RESUBMIT")

        def event(stage):
            elapsed = time.monotonic() - started
            item = {"stage": stage, "elapsed_seconds": elapsed}
            if path.is_dir() and not path.is_symlink():
                fd = os.open(path / "privacy-events.jsonl", os.O_WRONLY | os.O_CREAT | os.O_APPEND | os.O_NOFOLLOW, 0o600)
                with os.fdopen(fd, "ab") as stream:
                    stream.write((json.dumps(item) + "\n").encode()); stream.flush(); os.fsync(stream.fileno())
            if on_event is not None:
                try:
                    on_event(stage, elapsed)
                except Exception:
                    pass  # UI failure must not change a financial operation.

        try:
            summary = _integration(path)
            binding = _binding(summary)
            _driver_released(path, summary)
            records = _records(summary)
            checks, hashes = _metadata(summary)
            _preflight(binding)
            event("payment_started")
            payment, observed = _pay(path, binding)
            if (observed.get("state") != "verified_nope_testnet_escrow_payout"
                    or observed.get("transaction_hash") != payment["release_hash"]
                    or observed.get("amount_yocto") != str(AMOUNT)):
                _fail("INDEPENDENT_PAYMENT_VERIFICATION_REQUIRED")
            event("payment_verified")
            result = {"completed": True, "network": "testnet", "job_id": binding.job_id,
                "selected_executor": binding.provider_id, "real_fhe": True, "real_mpc": True,
                "actual_near_testnet": True, "actual_near_sandbox": False,
                "real_payment": True, "payments_executed": True,
                "independent_operators": False, "execution_proof": False,
                "synthetic_only": True, "transactions": _transactions(summary, payment),
                "checks": checks, "artifactHashes": hashes,
                "payment": {"verified": True, "amountYocto": str(AMOUNT),
                    "transactionHash": payment["release_hash"], "mpcPriceProven": False,
                    "amountPublic": True, "fixedDemonstrationPrice": True, "caveat": PAYMENT_CAVEAT,
                    "explorerUrl": "https://testnet.nearblocks.io/txns/" + payment["release_hash"]},
                "limits": list(LIMITS), "elapsed_seconds": time.monotonic() - started}
            if records is not None:
                result["verified_synthetic_records"] = records
            _write(path / "privacy-result.json", result)
            event("completed")
            return result
        except BaseException as exc:
            event("failed_or_interrupted")
            if path.is_dir() and not path.is_symlink():
                _write(path / "privacy-failure.json", {"completed": False, "network": "testnet",
                    "error": "PRIVACY_DEMO_INCOMPLETE_OR_UNKNOWN", "automatic_retry": False})
            if isinstance(exc, (KeyboardInterrupt, SystemExit)):
                raise
            _fail("PRIVACY_DEMO_INCOMPLETE_OR_UNKNOWN_NO_RESUBMIT")
    finally:
        os.close(lock)
