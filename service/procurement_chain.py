"""Explicit local owner relay for publication only; no selection/payment execution.

publish() accepts a server-fetched app job and the mount's trusted live-session
projection, not browser assertions. A durable claim precedes the first Node call.
Every later call only reconciles the existing signed-transaction journal. Missing,
partial, failed or ambiguous evidence never authorizes a second broadcast.
See docs/PROCUREMENT-CHAIN-BRIDGE.md for the required authentication boundary.
"""
import base64
import contextlib
import copy
import json
import os
import re
import shutil
import sqlite3
import stat
import subprocess
import time
from pathlib import Path

from engine.protocol import canonical_json, read_regular, sha256
from mpc import v2
from sdk.registry import verify_registry_job
from .bid_client import _job as validate_app_job
from .procurement_client import ProcurementClientError, ProcurementConfig

__all__ = ["ProcurementChainBridge", "ProcurementChainError", "from_env"]

_RPC = "https://test.rpc.fastnear.com"
_DOMAIN = sha256(b"veil/registry/network/v1:near:testnet")
_SCOPE = "testnet-registry-publication-only"
_MAX_REPLY = 2 * 1024 * 1024
_SCHEMA = """
CREATE TABLE IF NOT EXISTS procurement_publications (
 app_id TEXT PRIMARY KEY, session_id TEXT NOT NULL UNIQUE,
 context_hash TEXT NOT NULL UNIQUE, request_hash TEXT NOT NULL,
 pin TEXT NOT NULL, job_json TEXT NOT NULL, state TEXT NOT NULL,
 tx_hash TEXT UNIQUE, registry_job_id TEXT UNIQUE, binding_json TEXT
);
"""


class ProcurementChainError(ProcurementClientError):
    pass


def _json(raw):
    def pairs(items):
        result = {}
        for key, value in items:
            if key in result:
                raise ValueError("duplicate JSON key")
            result[key] = value
        return result
    def invalid(_):
        raise ValueError("nonfinite JSON")
    if type(raw) not in (str, bytes) or len(raw) > _MAX_REPLY:
        raise ValueError("bounded JSON required")
    return json.loads(raw, object_pairs_hook=pairs, parse_constant=invalid)


def _id(value):
    if type(value) is not str or not re.fullmatch(r"[0-9a-f]{32}", value):
        raise ProcurementChainError("INVALID_CHAIN_JOB_ID")
    return value


def _base58(raw):
    alphabet = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz"
    number, encoded = int.from_bytes(raw, "big"), ""
    while number:
        number, digit = divmod(number, 58)
        encoded = alphabet[digit] + encoded
    return "1" * (len(raw) - len(raw.lstrip(b"\0"))) + encoded


def chain_hash(value):
    alphabet = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz"
    if type(value) is not str or not 32 <= len(value) <= 44:
        raise ValueError("base58 chain hash required")
    number = 0
    for character in value:
        if character not in alphabet:
            raise ValueError("invalid base58 chain hash")
        number = number * 58 + alphabet.index(character)
    raw = b"\0" * (len(value) - len(value.lstrip("1")))
    raw += number.to_bytes((number.bit_length() + 7) // 8, "big")
    if len(raw) != 32 or _base58(raw) != value:
        raise ValueError("canonical 32-byte chain hash required")
    return value


class _Database:
    """Short durable CAS transactions, separate connections across local callers."""
    def __init__(self, path):
        self.path = str(path)
        with self.connect() as db:
            db.executescript(_SCHEMA)

    @contextlib.contextmanager
    def connect(self):
        db = sqlite3.connect(self.path, timeout=10, isolation_level=None)
        db.row_factory = sqlite3.Row
        try:
            db.execute("PRAGMA journal_mode=WAL")
            db.execute("PRAGMA synchronous=FULL")
            yield db
        finally:
            db.close()

    @contextlib.contextmanager
    def transaction(self):
        with self.connect() as db:
            db.execute("BEGIN IMMEDIATE")
            try:
                yield db
                db.commit()
            except BaseException:
                db.rollback()
                raise


def _config(job):
    intent = job["intent"]
    fields = {"spec_hash": "specHash", "circuit_hash": "circuitHash", "key_hash": "keyHash",
              "output_policy_hash": "outputPolicyHash", "input_hash": "inputHash"}
    result = {key: list(v2.hex32(intent[value])) for key, value in fields.items()}
    result.update(context_hash=list(v2.hex32(job["contextHash"])),
        budget_commitment=list(v2.hex32(job["budgetCommitment"])),
        bid_deadline_ns=intent["bidDeadlineNs"], result_deadline_ns=intent["resultDeadlineNs"],
        authorized_bidders=intent["roster"], executor=intent["registryExecutor"])
    return result


def _projection(job):
    return {key: copy.deepcopy(job[key]) for key in ("id", "status", "buyer", "roster",
            "bidDeadlineNs", "resultDeadlineNs", "intent", "contextHash", "budgetCommitment")}


# Fixed local wrapper around EXISTING modules. Not the broad integration driver:
# only publication can mutate, and reconciliation never loads a signer or calls
# publishTestnet/sendOnce. Request bodies go over stdin; no job or key in argv.
_NODE = r"""
import {readFileSync,lstatSync} from 'node:fs';
import {join} from 'node:path';
import {actions,createTransaction,PublicKey} from 'near-api-js';
import {publicationConfig,publishTestnet} from './procurement.mjs';
import {loadIdentity,withLock,PRIVATE} from './storage.mjs';
import {TestnetRpc,finalOutcome} from './transport.mjs';
import {NETWORK,RPC,DOMAIN_HEX,domainHash,requireAccount,verifyArtifact,sha256} from './policy.mjs';
const LIMIT=2*1024*1024, FAST='https://test.rpc.fastnear.com';
const emit=x=>{const s=JSON.stringify(x);if(Buffer.byteLength(s)>LIMIT)throw Error('REPLY_LIMIT');process.stdout.write(s+'\n');};
const read=p=>{const s=lstatSync(p);if(!s.isFile()||s.isSymbolicLink()||s.size>65536)throw Error('INVALID_PUBLIC_FILE');return JSON.parse(readFileSync(p,'utf8'));};
const fetcher=async(url,options)=>{
 if(url!==FAST)throw Error('RPC_PIN');
 const response=await fetch(url,{...options,redirect:'error'});
 if(!response.ok){await response.body?.cancel();throw Error('RPC_HTTP');}
 const chunks=[];let size=0;const reader=response.body.getReader();
 try{for(;;){const {done,value}=await reader.read();if(done)break;size+=value.length;if(size>LIMIT)throw Error('RPC_LIMIT');chunks.push(Buffer.from(value));}}
 finally{await reader.cancel();}
 return {ok:true,json:async()=>JSON.parse(Buffer.concat(chunks).toString('utf8'))};
};
try{
 let text='';for await(const chunk of process.stdin){text+=chunk;if(Buffer.byteLength(text)>65536)throw Error('BODY_LIMIT');}
 const q=JSON.parse(text);
 if(Object.keys(q).sort().join(',')!=='command,job'||!['publish','reconcile'].includes(q.command))throw Error('COMMAND_POLICY');
 if(NETWORK!=='testnet'||RPC!==FAST)throw Error('NETWORK_POLICY');
 const identity=read('evidence/identity.json');
 requireAccount(identity.account_id,identity.public_key);
 if(identity.network!=='testnet'||q.job.intent.networkDomainHash!==DOMAIN_HEX)throw Error('OWNER_DOMAIN_POLICY');
 const config=publicationConfig(q.job,identity),artifact=verifyArtifact();
 const rpc=new TestnetRpc({network:NETWORK,url:FAST,fetcher});
 const actionList=[actions.functionCall('create_job',{config},50000000000000n,0n)];
 const expectedDigest=sha256(createTransaction(identity.account_id,PublicKey.fromString(identity.public_key),
   identity.account_id,0n,actionList,new Uint8Array(32)).encode()).toString('hex');
 const label='procurement-'+q.job.id,journalPath=join(PRIVATE,label+'.json');
 const readAt=async(method,args,anchor)=>{
   const r=await rpc.request('query',{request_type:'call_function',account_id:identity.account_id,
     block_id:anchor.block_hash,method_name:method,args_base64:Buffer.from(JSON.stringify(args)).toString('base64')});
   return {value:JSON.parse(Buffer.from(r.result).toString('utf8')),block_hash:r.block_hash,block_height:r.block_height};
 };
 const anchor=async()=>{
   const status=await rpc.connect();if(status.sync_info?.syncing!==false)throw Error('RPC_SYNC');
   const account=await rpc.account(identity.account_id);
   if(!account||account.code_hash!==artifact.code_hash)throw Error('REGISTRY_CODE_PIN');
   const owner=await readAt('owner',{},account),domain=await readAt('network_domain_hash',{},account);
   if(owner.value!==identity.account_id||JSON.stringify(domain.value)!==JSON.stringify(domainHash()))throw Error('REGISTRY_OWNER_DOMAIN');
   return {status,account,owner,domain};
 };
 if(q.command==='publish'){
   await withLock(async()=>{
     await anchor();
     const signer=loadIdentity();
     if(signer.account_id!==identity.account_id||signer.public_key!==identity.public_key)throw Error('OWNER_IDENTITY_PIN');
     await publishTestnet(q.job,rpc,signer);
   });
 }
 let journal;
 try{journal=read(journalPath);}catch(e){if(e.code==='ENOENT'){emit({kind:'NO_JOURNAL'});process.exit(0);}throw e;}
 if(journal.account_id!==identity.account_id||journal.label!==label||journal.request_digest!==expectedDigest)throw Error('SIGNED_JOURNAL_MISMATCH');
 const transaction=finalOutcome(await rpc.request('tx',{tx_hash:journal.tx_hash,sender_account_id:identity.account_id,wait_until:'FINAL'}));
 const created=JSON.parse(Buffer.from(transaction.status.SuccessValue,'base64').toString('utf8'));
 if(typeof created.job_id!=='string'||!/^\d+$/.test(created.job_id))throw Error('CREATED_JOB_RETURN');
 const current=await anchor(),view=await readAt('get_job',{job_id:created.job_id},current.account);
 const hashes=[...new Set([transaction.transaction_outcome?.block_hash,
     ...(transaction.receipts_outcome??[]).map(x=>x.block_hash),current.account.block_hash])];
 if(hashes.length>65)throw Error('BLOCK_LIMIT');
 const blocks=[];for(const hash of hashes)blocks.push(await rpc.request('block',{block_id:hash}));
 emit({kind:'FINAL_EVIDENCE',network:NETWORK,rpc:FAST,registryAccount:identity.account_id,
   publicKey:identity.public_key,codeHash:artifact.code_hash,journalTransactionHash:journal.tx_hash,
   transaction,...current,view,blocks});
}catch{emit({kind:'UNKNOWN'});process.exitCode=1;}
"""


class _NodeRelay:
    def __init__(self, root, executable):
        self.directory = root / "contracts/registry/deploy"
        self.executable = executable

    def _request(self, command, job):
        packet = canonical_json({"command": command, "job": job})
        if len(packet) > 65536:
            raise ValueError("bounded public request required")
        result = subprocess.run([self.executable, "--input-type=module", "-e", _NODE],
            cwd=str(self.directory), input=packet, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL,
            timeout=180, check=False, env={"PATH": os.defpath, "NODE_NO_WARNINGS": "1"})
        if result.returncode != 0 or len(result.stdout) > _MAX_REPLY:
            raise ValueError("relay outcome unknown")
        return _json(result.stdout)

    def publish(self, job):
        return self._request("publish", job)

    def reconcile(self, job):
        return self._request("reconcile", job)


def _pins(root, config):
    deploy = root / "contracts/registry/deploy"
    identity = _json(read_regular(deploy / "evidence/identity.json", 65536))
    lock = _json(read_regular(deploy / "artifact-lock.json", 65536))
    deployment = _json(read_regular(deploy / "evidence/deployment.json", 65536))
    owner = identity["account_id"]
    expected_owner = "veil-reg-" + sha256(identity["public_key"].encode())[:16] + ".testnet"
    code = _base58(v2.hex32(lock["sha256"]))
    if (identity["network"] != "testnet" or owner != expected_owner or owner != config.registry_account or
            config.network_domain_hash != _DOMAIN or deployment["account_id"] != owner or
            deployment["network"] != "testnet" or deployment["code_hash"] != code):
        raise ValueError("fixed owner/deployment pin mismatch")
    # No private contents read. Only the existing Node signer may load this file.
    key = (deploy / "runtime/near-testnet/identity.json").lstat()
    if not stat.S_ISREG(key.st_mode) or stat.S_IMODE(key.st_mode) != 0o600 or key.st_uid != os.getuid():
        raise ValueError("owner key file metadata invalid")
    for relative in ("procurement.mjs", "policy.mjs", "transport.mjs", "storage.mjs", "registry.mjs",
                     "node_modules/near-api-js/package.json"):
        if not (deploy / relative).is_file():
            raise ValueError("owner relay dependency unavailable")
    return {"owner": owner, "publicKey": identity["public_key"], "codeHash": code, "networkDomainHash": _DOMAIN}


def _created_job(value, job, pins):
    if type(value) is not dict or set(value) not in (v2.JOB_FIELDS, v2.JOB_FIELDS | {"selected_executor", "attempt_binding_version"}):
        raise ValueError("created registry job schema")
    if (value["buyer"] != pins["owner"] or value["state"] != "Open" or value["attempt"] != "0" or
            value["bidset_root"] is not None or value["closed_at_ns"] is not None or
            value["attempt_binding_hash"] is not None or value["receipts"] != [] or
            value.get("selected_executor") is not None or value.get("attempt_binding_version") is not None or
            any(bid["commitment"] is not None for bid in value["bids"])):
        raise ValueError("create_job did not return a fresh open job")
    verify_registry_job(value, contract_account=pins["owner"],
                        network_domain_hash=list(v2.hex32(_DOMAIN)), expected_config=_config(job))
    return value


def _verify(evidence, job, pins):
    """Strict FINAL/action/outcome tree and one-finalized-block publication binding."""
    if (type(evidence) is not dict or evidence.get("kind") != "FINAL_EVIDENCE" or
            evidence.get("network") != "testnet" or evidence.get("rpc") != _RPC or
            evidence.get("registryAccount") != pins["owner"] or evidence.get("publicKey") != pins["publicKey"] or
            evidence.get("codeHash") != pins["codeHash"] or
            evidence["status"].get("chain_id") != "testnet" or evidence["status"].get("sync_info", {}).get("syncing") is not False):
        raise ValueError("testnet RPC/identity provenance mismatch")
    tx_hash = chain_hash(evidence["journalTransactionHash"])
    result = evidence["transaction"]
    if result.get("final_execution_status") != "FINAL" or set(result.get("status", {})) != {"SuccessValue"}:
        raise ValueError("transaction not FINAL and successful")
    created = _created_job(_json(base64.b64decode(result["status"]["SuccessValue"], validate=True)), job, pins)
    tx = result["transaction"]
    if (tx.get("hash") != tx_hash or tx.get("signer_id") != pins["owner"] or
            tx.get("receiver_id") != pins["owner"] or tx.get("public_key") != pins["publicKey"] or
            type(tx.get("actions")) is not list or len(tx["actions"]) != 1 or
            set(tx["actions"][0]) != {"FunctionCall"}):
        raise ValueError("wrong signer/receiver/action/transaction")
    action = tx["actions"][0]["FunctionCall"]
    arguments = _json(base64.b64decode(action["args"], validate=True))
    v2.schema(arguments, {"config"}, "create_job arguments")
    v2.schema(arguments["config"], v2.CONFIG_FIELDS, "create_job config")
    for key in v2.CONFIG_HASHES:
        v2.registry_hash(arguments["config"][key])
    if (set(action) != {"method_name", "args", "gas", "deposit"} or
            action["method_name"] != "create_job" or action["deposit"] != "0" or
            type(action["gas"]) is not int or action["gas"] != 50_000_000_000_000 or
            arguments != {"config": _config(job)}):
        raise ValueError("transaction differs from exact publication")
    root, receipts = result["transaction_outcome"], result["receipts_outcome"]
    if root.get("id") != tx_hash or type(receipts) is not list or not 1 <= len(receipts) <= 64:
        raise ValueError("complete outcome evidence required")
    nodes = {}
    for item in [root] + receipts:
        identity = chain_hash(item["id"])
        chain_hash(item["block_hash"])
        if identity in nodes:
            raise ValueError("duplicate outcome")
        outcome = item["outcome"]
        children, status_value = outcome["receipt_ids"], outcome["status"]
        if type(children) is not list or len(children) != len(set(children)) or type(status_value) is not dict or len(status_value) != 1:
            raise ValueError("invalid outcome links/status")
        for child in children:
            chain_hash(child)
        if "SuccessReceiptId" in status_value:
            if status_value["SuccessReceiptId"] not in children:
                raise ValueError("unlinked success receipt")
        elif "SuccessValue" in status_value:
            base64.b64decode(status_value["SuccessValue"], validate=True)
        else:
            raise ValueError("failed or unknown receipt")
        nodes[identity] = item
    execution = root["outcome"]
    if execution.get("executor_id") != pins["owner"] or set(execution["status"]) != {"SuccessReceiptId"}:
        raise ValueError("wrong root outcome")
    creation = nodes[execution["status"]["SuccessReceiptId"]]["outcome"]
    if creation.get("executor_id") != pins["owner"] or creation["status"] != result["status"]:
        raise ValueError("creation receipt does not confirm returned job")
    pending, visited = [tx_hash], set()
    while pending:
        identity = pending.pop()
        if identity in visited or identity not in nodes:
            raise ValueError("missing/reused/cyclic receipt")
        visited.add(identity)
        pending.extend(nodes[identity]["outcome"]["receipt_ids"])
    if visited != set(nodes):
        raise ValueError("unrelated receipt evidence")
    account, view = evidence["account"], evidence["view"]
    block_hash, height = chain_hash(account["block_hash"]), account["block_height"]
    if type(height) is not int or height <= 0 or account["code_hash"] != pins["codeHash"]:
        raise ValueError("unreviewed code/final block")
    for observed in (evidence["owner"], evidence["domain"], view):
        if observed["block_hash"] != block_hash or type(observed["block_height"]) is not int or observed["block_height"] != height:
            raise ValueError("mixed final block views")
    if evidence["owner"]["value"] != pins["owner"] or v2.registry_hash(evidence["domain"]["value"]).hex() != _DOMAIN:
        raise ValueError("final owner/domain mismatch")
    current = view["value"]
    verify_registry_job(current, contract_account=pins["owner"],
                        network_domain_hash=list(v2.hex32(_DOMAIN)), expected_config=_config(job))
    if (current["job_id"] != created["job_id"] or current["buyer"] != pins["owner"] or
            current["job_binding_hash"] != created["job_binding_hash"]):
        raise ValueError("final view differs from creation")
    blocks = evidence["blocks"]
    wanted = {block_hash} | {item["block_hash"] for item in nodes.values()}
    if type(blocks) is not list or len(blocks) != len(wanted):
        raise ValueError("complete outcome block evidence required")
    observed = set()
    for block in blocks:
        header = block["header"]
        identity, block_height = chain_hash(header["hash"]), header["height"]
        if identity in observed or identity not in wanted or type(block_height) is not int or not 0 < block_height <= height:
            raise ValueError("outcome not anchored by final registry block")
        if identity == block_hash and block_height != height:
            raise ValueError("final anchor height mismatch")
        observed.add(identity)
    return {"registryJobId": created["job_id"], "transactionHash": tx_hash,
            "jobBindingHash": v2.registry_hash(created["job_binding_hash"]).hex(),
            "finalExecutionStatus": "FINAL", "blockHash": block_hash, "blockHeight": height,
            "registryCodeHash": pins["codeHash"], "authority": "trusted-testnet-rpc"}


class ProcurementChainBridge:
    """Explicit owner-host bridge. Construct via from_env for the default-off mount.

    test_driver is an explicitly trusted no-network test double, never an HTTP
    input. It implements publish(public_job) and reconcile(public_job). Production
    uses the fixed Node module wrapper; no arbitrary subprocess or RPC is exposed.
    """
    def __init__(self, journal_dir, config, *, relay_root, node_executable=None, test_driver=None):
        try:
            if type(config) is not ProcurementConfig:
                raise ValueError("trusted procurement config required")
            root = Path(relay_root)
            if not root.is_absolute() or root.is_symlink() or not root.is_dir():
                raise ValueError("explicit owner repository required")
            self._pins = _pins(root.resolve(), config)
            executable = node_executable or shutil.which("node")
            if not executable or not Path(executable).is_absolute() or not os.access(executable, os.X_OK):
                raise ValueError("local Node executable unavailable")
            self._driver = test_driver or _NodeRelay(root.resolve(), str(executable))
            self._mode = "test-double" if test_driver is not None else "local-node-relay"
            self._config = config
            self._pin = sha256(canonical_json(dict(self._pins, evidenceMode=self._mode)))
            directory = Path(journal_dir)
            directory.mkdir(mode=0o700, parents=True, exist_ok=True)
            info = directory.lstat()
            if not stat.S_ISDIR(info.st_mode) or info.st_uid != os.getuid() or stat.S_IMODE(info.st_mode) & 0o077:
                raise ValueError("private owned journal directory required")
            path = directory / "publication.sqlite3"
            try:
                descriptor = os.open(str(path), os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
                os.close(descriptor)
            except FileExistsError:
                pass
            info = path.lstat()
            if not stat.S_ISREG(info.st_mode) or info.st_nlink != 1 or info.st_uid != os.getuid() or stat.S_IMODE(info.st_mode) != 0o600:
                raise ValueError("private regular journal file required")
            self._db = _Database(path)
        except Exception:
            raise ProcurementChainError("CHAIN_RELAY_CONFIGURATION_INVALID") from None

    @classmethod
    def from_env(cls, runtime_dir, config):
        if os.environ.get("NOPE_ENABLE_TESTNET_RELAY") != "1":
            return None
        root = os.environ.get("NOPE_TESTNET_RELAY_ROOT")
        if not root:
            raise ProcurementChainError("CHAIN_RELAY_ROOT_REQUIRED")
        return cls(Path(runtime_dir) / "procurement-chain", config, relay_root=root,
                   node_executable=os.environ.get("NOPE_TESTNET_NODE"))

    def capabilities(self):
        return {"enabled": True, "network": "testnet", "scope": _SCOPE,
                "ownerOnly": True, "reconciliationReadOnly": True, "transport": self._mode,
                "selectionExecuted": False, "paymentExecuted": False}

    def _row(self, job_id):
        with self._db.connect() as db:
            row = db.execute("SELECT * FROM procurement_publications WHERE app_id=?", (_id(job_id),)).fetchone()
        if row is None:
            raise ProcurementChainError("CHAIN_JOB_UNKNOWN")
        if row["pin"] != self._pin:
            raise ProcurementChainError("CHAIN_JOURNAL_PIN_MISMATCH")
        job = _json(row["job_json"])
        if sha256(canonical_json(job)) != row["request_hash"]:
            raise ProcurementChainError("CHAIN_JOURNAL_REQUEST_MISMATCH")
        return row, job

    def _public(self, row, job):
        result = {"applicationJobId": row["app_id"], "localSessionId": row["session_id"],
            "network": "testnet", "registryAccount": self._pins["owner"], "scope": _SCOPE,
            "state": row["state"], "contextHash": job["contextHash"],
            "budgetCommitment": job["budgetCommitment"], "retryAllowed": False,
            "selectionExecuted": False, "paymentExecuted": False, "evidenceMode": self._mode}
        if row["binding_json"] is not None:
            result.update(_json(row["binding_json"]))
        return result

    def publish(self, job, expected):
        """Owner-authorized mount only. Journal first; submit at most once per app/session."""
        try:
            return self._publish(job, expected)
        except ProcurementChainError:
            raise
        except Exception:
            raise ProcurementChainError("CHAIN_JOURNAL_UNAVAILABLE") from None

    def _publish(self, job, expected):
        try:
            job, expected = copy.deepcopy(job), copy.deepcopy(expected)
            if len(canonical_json(job)) > 65536:
                raise ValueError("public app job too large")
            validate_app_job(job, self._config, "PUBLISHED")
            v2.schema(expected, {"id", "draftId", "intent", "contextHash", "budgetCommitment"}, "trusted local session projection")
            _id(expected["id"])
            v2.validate_intent(expected["intent"])
            if (job["buyer"] != self._pins["owner"] or job["intent"]["buyer"] != self._pins["owner"] or
                    expected["draftId"] != job["id"] or expected["intent"] != job["intent"] or
                    expected["contextHash"] != job["contextHash"] or expected["budgetCommitment"] != job["budgetCommitment"]):
                raise ValueError("owner/exact prepared session mismatch")
            public = _projection(job)
            encoded = canonical_json(public).decode()
            fingerprint = sha256(encoded.encode())
        except Exception:
            raise ProcurementChainError("CHAIN_PUBLICATION_MISMATCH") from None
        try:
            with self._db.transaction() as db:
                old = db.execute("SELECT * FROM procurement_publications WHERE app_id=?", (job["id"],)).fetchone()
                if old is not None:
                    if old["request_hash"] != fingerprint or old["session_id"] != expected["id"] or old["pin"] != self._pin:
                        raise ProcurementChainError("CHAIN_PUBLICATION_CONFLICT")
                    first = False
                else:
                    if time.time_ns() >= v2.u64(job["bidDeadlineNs"]):
                        raise ProcurementChainError("CHAIN_PUBLICATION_EXPIRED")
                    if v2.u64(job["resultDeadlineNs"]) - time.time_ns() > 30 * 86400 * 10**9:
                        raise ProcurementChainError("CHAIN_DEADLINE_POLICY")
                    if db.execute("SELECT COUNT(*) FROM procurement_publications").fetchone()[0] >= 1024:
                        raise ProcurementChainError("CHAIN_JOURNAL_FULL")
                    # Crash before, during or after this single dispatch is never
                    # grounds for fresh signing. Only status() may reconcile it.
                    db.execute("INSERT INTO procurement_publications VALUES (?,?,?,?,?,?,?,NULL,NULL,NULL)",
                        (job["id"], expected["id"], job["contextHash"], fingerprint, self._pin, encoded, "SUBMITTING"))
                    first = True
        except sqlite3.IntegrityError:
            raise ProcurementChainError("CHAIN_PUBLICATION_CONFLICT") from None
        if not first:
            result = self.status(job["id"])
        else:
            result = self._observe(job["id"], submit=True)
        if result["state"] != "BOUND":
            raise ProcurementChainError("CHAIN_OUTCOME_UNKNOWN")
        return result

    def _observe(self, job_id, *, submit=False):
        row, job = self._row(job_id)
        if row["state"] == "BOUND":
            return self._public(row, job)
        try:
            evidence = (self._driver.publish if submit else self._driver.reconcile)(copy.deepcopy(job))
            binding = _verify(evidence, job, self._pins)
            with self._db.transaction() as db:
                db.execute("UPDATE procurement_publications SET state='BOUND',tx_hash=?,registry_job_id=?,binding_json=? WHERE app_id=? AND state!='BOUND'",
                    (binding["transactionHash"], binding["registryJobId"], canonical_json(binding).decode(), job_id))
        except Exception:
            with self._db.transaction() as db:
                db.execute("UPDATE procurement_publications SET state='UNKNOWN' WHERE app_id=? AND state!='BOUND'", (job_id,))
        row, job = self._row(job_id)
        return self._public(row, job)

    def status(self, job_id):
        """Read-only Node reconciliation of a persisted request; never signs/broadcasts.

        BOUND is an immutable publication fact, not a claim about current registry
        selection/delivery/payment state. Unknown outcomes remain non-retryable.
        """
        try:
            return self._observe(_id(job_id))
        except ProcurementChainError:
            raise
        except Exception:
            raise ProcurementChainError("CHAIN_RECONCILIATION_UNAVAILABLE") from None


def from_env(runtime_dir, config):
    return ProcurementChainBridge.from_env(runtime_dir, config)
