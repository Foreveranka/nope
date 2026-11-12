"""Local administrative single-party launcher. No HTTP API or automatic jobs.

Approved config/profile/build pins, immutable artifact copies, own-key-only TLS,
durable round reservation, explicit bind and conservative abort cleanup. A local
party completion is NOT whole-MPC verification, attestation or independence.
"""

import argparse
from contextlib import contextmanager
import hashlib
import json
import os
from pathlib import Path
import re
import shlex
import shutil
import signal
import sqlite3
import ssl
import stat
import subprocess
import sys
import time
from urllib.parse import quote

from mpc import network_profile as net
from operators.control import Crypto, file_digest, private_file
from operators.validate_manifest import ManifestError

ROOT = Path(__file__).resolve().parent
ARTIFACTS = ("binary", "shared_library", "config", "recipe", "source", "patch", "schedule",
             "bytecode_manifest", "bytecode_directory")
CONFIG_FIELDS = ("schema", "party", "profile", "profile_sha256", "selection_manifest",
                 "selection_manifest_sha256", "build_stamp", "build_stamp_sha256", "artifacts",
                 "tls_directory", "state_directory", "openssl", "timeout_seconds",
                 "loopback_test", "loopback_test_sha256")


def require(ok, message):
    if not ok:
        raise net.NetworkProfileError(message)


def load(path):
    return net.load_profile(path)


def _spawn_native(args, **options):
    return subprocess.Popen(args, **options)


def owner_directory(path):
    path = Path(path)
    info = path.lstat()
    require(path.is_absolute() and stat.S_ISDIR(info.st_mode) and info.st_uid == os.geteuid()
            and info.st_mode & 0o077 == 0, "owner-only absolute state directory required")
    return path


class Reservations:
    def __init__(self, directory, *, initialize=False):
        self.path = owner_directory(directory) / "party.sqlite"
        if initialize:
            fd = os.open(self.path, os.O_CREAT|os.O_EXCL|os.O_WRONLY, 0o600)
            os.close(fd)
        private_file(self.path)
        if initialize:
            with self.connection() as db:
                db.executescript("""
                    CREATE TABLE meta(id INTEGER PRIMARY KEY, epoch INTEGER, pin TEXT, clock INTEGER);
                    INSERT INTO meta VALUES(1,0,'',0);
                    CREATE TABLE rounds(job TEXT, round TEXT, party INTEGER, profile TEXT,
                        status TEXT, PRIMARY KEY(job,round,party));
                    PRAGMA user_version=1;
                """)

    @contextmanager
    def connection(self):
        private_file(self.path)
        db = sqlite3.connect("file:"+quote(str(self.path))+"?mode=rw",uri=True,isolation_level=None,timeout=5)
        try:
            db.execute("PRAGMA synchronous=FULL")
            with db:
                yield db
        finally:
            db.close()

    def reserve(self, profile, pin, party, now):
        roster_pin = net.profile_digest({k:profile[k] for k in ("transport","trust_anchor_sha256","parties","clients")})
        with self.connection() as db:
            require(db.execute("PRAGMA user_version").fetchone()[0] == 1, "unsupported reservation state")
            require(db.execute("PRAGMA quick_check").fetchone()[0] == "ok", "reservation integrity failure")
            db.execute("BEGIN IMMEDIATE")
            row = db.execute("SELECT epoch,pin,clock FROM meta WHERE id=1").fetchone()
            require(row is not None, "missing reservation metadata")
            epoch, old_pin, clock = row
            require(now >= clock, "reservation clock rollback")
            require(profile["epoch"] > epoch or (profile["epoch"] == epoch and old_pin == roster_pin),
                    "reservation epoch rollback or substitution")
            try:
                db.execute("INSERT INTO rounds VALUES(?,?,?,?,?)", (
                    profile["job_binding_hash"],profile["selection_round"],party,pin,"reserved"))
            except sqlite3.IntegrityError:
                raise net.NetworkProfileError("party round replay rejected") from None
            db.execute("UPDATE meta SET epoch=?,pin=?,clock=? WHERE id=1",(profile["epoch"],roster_pin,now))
            db.commit()

    def finish(self, profile, party, status):
        with self.connection() as db:
            db.execute("UPDATE rounds SET status=? WHERE job=? AND round=? AND party=?", (
                status,profile["job_binding_hash"],profile["selection_round"],party))


def preflight(config, approved_config_sha256, *, allow_remote=False, allow_loopback_test=False):
    """Read-only preflight; config hash and explicit local opt-in are mandatory."""
    net._hash(approved_config_sha256,"approved config hash")
    config = net.parse_profile(net.canonical(config))
    net._object(config,CONFIG_FIELDS,"party config")
    require(net.profile_digest(config) == approved_config_sha256,"party config approval mismatch")
    require(config["schema"] == "veil-party-launch-v1","unsupported party config")
    net._integer(config["party"],0,2,"party")
    net._integer(config["timeout_seconds"],1,900,"timeout")
    for key in ("profile","selection_manifest","build_stamp","tls_directory","state_directory","openssl"):
        require(type(config[key]) is str and Path(config[key]).is_absolute(),"absolute configured paths required")
    net._object(config["artifacts"],ARTIFACTS,"artifacts")
    for path in config["artifacts"].values():
        require(type(path) is str and Path(path).is_absolute(),"absolute artifact paths required")
    selection = load(config["selection_manifest"])
    checked = net.validate_profile(load(config["profile"]),config["profile_sha256"],selection,
                                   allow_remote=allow_remote)
    profile = checked.as_dict()
    require(config["selection_manifest_sha256"] == checked.selection_manifest_sha256,"selection pin mismatch")
    addresses = [p["address"] for p in profile["parties"]]
    mode = "approved-explicit-bind"
    effective_expiry = profile["expires_at"]
    if config["loopback_test"] is not None or config["loopback_test_sha256"] is not None:
        require(allow_loopback_test is True,"loopback functional test requires separate explicit opt-in")
        require(type(config["loopback_test"]) is str and Path(config["loopback_test"]).is_absolute(),
                "absolute loopback test approval required")
        mapping = load(config["loopback_test"])
        net._object(mapping,("schema","profile_sha256","addresses","expires_at"),"loopback test mapping")
        require(mapping["schema"] == "veil-loopback-functional-test-v1" and
                mapping["profile_sha256"] == checked.profile_sha256 and
                net.profile_digest(mapping) == config["loopback_test_sha256"],"loopback test approval mismatch")
        net._integer(mapping["expires_at"],1,profile["expires_at"],"loopback test expiry")
        require(int(time.time()) < mapping["expires_at"],"loopback test expired")
        effective_expiry = min(effective_expiry,mapping["expires_at"])
        addresses = mapping["addresses"]
        require(type(addresses) is list and len(addresses) == 3 and
                all(a in ("127.0.0.1","127.0.0.2","127.0.0.3") for a in addresses),
                "loopback test requires three explicitly approved loopback entries")
        mode = "same-administration-loopback-functional-test"
    else:
        require(allow_loopback_test is False,"unused loopback test opt-in")
    artifacts = config["artifacts"]
    require(file_digest(config["build_stamp"]) == config["build_stamp_sha256"],"build stamp pin mismatch")
    stamp = load(config["build_stamp"])
    require(stamp.get("upstream") == net.UPSTREAM and stamp.get("insecureFlags") is False and
            stamp.get("livePreprocessing") is True and
            stamp.get("transportGeneration") == "explicit-bind-leaf-pin-v2","unapproved secure runtime generation")
    for field, artifact in (("binarySha256","binary"),("sharedLibrarySha256","shared_library"),
                            ("configSha256","config"),("transportPatchSha256","patch")):
        require(file_digest(artifacts[artifact]) == stamp[field],"runtime artifact differs from build stamp")
    for field, artifact in (("source_sha256","source"),("transport_patch_sha256","patch"),
                            ("build_recipe_sha256","recipe"),("binary_sha256","binary"),
                            ("schedule_sha256","schedule"),("bytecode_sha256","bytecode_manifest")):
        require(file_digest(artifacts[artifact]) == profile["program"][field],"approved artifact pin mismatch")
    config_text = Path(artifacts["config"]).read_text()
    require("INSECURE" not in config_text and "USE_KOS = 0" in config_text,"unsupported secure build config")
    bundle = load(artifacts["bytecode_manifest"])
    net._object(bundle,("schema","files"),"bytecode bundle")
    require(bundle["schema"] == "veil-mpc-bytecode-bundle-v1" and type(bundle["files"]) is list and
            1 <= len(bundle["files"]) <= 64,"unsupported bytecode bundle")
    tapes = {}
    for entry in bundle["files"]:
        net._object(entry,("name","sha256"),"bytecode tape")
        name = entry["name"]
        require(type(name) is str and len(name) <= 255 and
                re.fullmatch(r"[A-Za-z0-9_.()=-]+\.bc",name) is not None and
                name.startswith(profile["program"]["name"]+"-") and name not in tapes,
                "unsafe or duplicate bytecode tape name")
        net._hash(entry["sha256"],"bytecode tape hash")
        path = Path(artifacts["bytecode_directory"])/name
        require(file_digest(path) == entry["sha256"],"bytecode tape digest mismatch")
        tapes[name] = str(path)
    schedule = Path(artifacts["schedule"]).read_text().splitlines()
    require(len(schedule) >= 7 and schedule[0] == "1" and schedule[1] == str(len(tapes)) and
            schedule[6] == "R:64","unsupported fixed-profile schedule")
    schedule_tapes = [t.rsplit(":",1)[0]+".bc" for t in schedule[2].split()]
    require(len(schedule_tapes) == len(tapes) and set(schedule_tapes) == set(tapes),"schedule tape set mismatch")
    compile_argv = shlex.split(schedule[5])
    require(compile_argv[-1] == "17400" and "-R" in compile_argv and "-X" in compile_argv and
            "-I" not in compile_argv and "--insecure" not in compile_argv,"unsupported compiled client port or security flags")
    crypto = Crypto(config["openssl"])
    tls = Path(config["tls_directory"])
    require(tls.is_absolute() and not tls.is_symlink() and tls.is_dir(),"invalid local TLS directory")
    identities = [(p["tls_name"],p["certificate_sha256"]) for p in profile["parties"]+profile["clients"]]
    root_der = crypto.run("x509","-in",tls/"trust.pem","-outform","DER")
    require(hashlib.sha256(root_der).hexdigest() == profile["trust_anchor_sha256"],"TLS root pin mismatch")
    for name,pin in identities:
        cert = tls/(name+".pem")
        require(hashlib.sha256(crypto.run("x509","-in",cert,"-outform","DER")).hexdigest() == pin,"TLS leaf pin mismatch")
        require(b"CA:FALSE" in crypto.run("x509","-in",cert,"-noout","-ext","basicConstraints"),"TLS leaf CA constraint")
        for purpose in ("sslserver","sslclient"):
            crypto.run("verify","-CAfile",tls/"trust.pem","-no-CApath","-no-CAstore",
                       "-purpose",purpose,"-verify_hostname",name,cert)
    identity = "P%d" % config["party"]
    private_file(tls/(identity+".key"))
    require({p.name for p in tls.glob("*.key")} == {identity+".key"},"foreign private keys in party TLS directory")
    ctx = ssl.SSLContext(ssl.PROTOCOL_TLS_CLIENT)
    ctx.load_cert_chain(str(tls/(identity+".pem")),str(tls/(identity+".key")))
    Reservations(config["state_directory"]) # Missing replay state fails before a launch.
    return dict(config=config,profile=profile,profile_sha256=checked.profile_sha256,
                addresses=addresses,mode=mode,tapes=tapes,crypto=crypto,effective_expiry=effective_expiry)


def launch(config, approved_config_sha256, *, allow_remote=False, allow_loopback_test=False, on_started=None):
    checked = preflight(config,approved_config_sha256,allow_remote=allow_remote,allow_loopback_test=allow_loopback_test)
    config,profile = checked["config"],checked["profile"]
    party = config["party"]
    reservations = Reservations(config["state_directory"])
    reservations.reserve(profile,checked["profile_sha256"],party,int(time.time()))
    state = owner_directory(config["state_directory"])
    session = state/("party%d-" % party+os.urandom(8).hex())
    process = None
    status = "aborted"
    try:
        session.mkdir(mode=0o700)
        native = session/"native"
        native.mkdir(mode=0o700)
        for key,name in (("binary","spdz2k-party.x"),("shared_library","libSPDZ.so")):
            shutil.copyfile(config["artifacts"][key],native/name)
        (native/"spdz2k-party.x").chmod(0o700)
        # Rehash copies before execution rather than executing mutable source paths.
        stamp = load(config["build_stamp"])
        require(file_digest(native/"spdz2k-party.x") == stamp["binarySha256"] and
                file_digest(native/"libSPDZ.so") == stamp["sharedLibrarySha256"],"runtime copy changed")
        programs = session/"Programs"
        (programs/"Schedules").mkdir(parents=True)
        (programs/"Bytecode").mkdir()
        schedule_path = programs/"Schedules"/(profile["program"]["name"]+".sch")
        shutil.copyfile(config["artifacts"]["schedule"],schedule_path)
        require(file_digest(schedule_path) == profile["program"]["schedule_sha256"],"schedule copy changed")
        bundle = load(config["artifacts"]["bytecode_manifest"])
        for tape in bundle["files"]:
            target = programs/"Bytecode"/tape["name"]
            shutil.copyfile(checked["tapes"][tape["name"]],target)
            require(file_digest(target) == tape["sha256"],"bytecode copy changed")
        player_data = session/"Player-Data"
        player_data.mkdir(mode=0o700)
        tls = Path(config["tls_directory"])
        for principal in profile["parties"]+profile["clients"]:
            name = principal["tls_name"]+".pem"
            shutil.copyfile(tls/name,player_data/name)
        shutil.copyfile(tls/"trust.pem",player_data/"trust.pem")
        identity = "P%d" % party
        shutil.copyfile(tls/(identity+".key"),player_data/(identity+".key"))
        (player_data/(identity+".key")).chmod(0o600)
        for principal in profile["parties"]+profile["clients"]:
            der = checked["crypto"].run("x509","-in",player_data/(principal["tls_name"]+".pem"),"-outform","DER")
            require(hashlib.sha256(der).hexdigest() == principal["certificate_sha256"],"TLS leaf copy changed")
        root_der = checked["crypto"].run("x509","-in",player_data/"trust.pem","-outform","DER")
        require(hashlib.sha256(root_der).hexdigest() == profile["trust_anchor_sha256"],"TLS root copy changed")
        copied_ctx = ssl.SSLContext(ssl.PROTOCOL_TLS_CLIENT)
        copied_ctx.load_cert_chain(str(player_data/(identity+".pem")),str(player_data/(identity+".key")))
        checked["crypto"].run("rehash",player_data)
        peers = session/"peers.txt"
        peers.write_text("".join("%s:%d\n" % (a,17500+i) for i,a in enumerate(checked["addresses"])))
        args = [str(native/"spdz2k-party.x"),"-N","3","-p",str(party),"-ip",str(peers),"-pn","17500",
                "-SP","64","-S","40","-b","1024","-OF",".","--veil-enable-bind",
                "--veil-bind-ipv4",checked["addresses"][party],"--veil-network-profile-sha256",checked["profile_sha256"],
                profile["program"]["name"]]
        deadline = min(time.monotonic()+config["timeout_seconds"],
                       time.monotonic()+checked["effective_expiry"]-time.time())
        require(deadline > time.monotonic(),"profile expired before launch")
        with (session/"party.log").open("xb") as output:
            process = _spawn_native(args,cwd=session,stdout=output,stderr=subprocess.STDOUT,start_new_session=True,
                env={"PATH":"/usr/bin:/bin","OPENSSL_CONF":"/dev/null",
                     "DYLD_LIBRARY_PATH":str(native),"LD_LIBRARY_PATH":str(native)})
            if on_started:
                on_started({"event":"PARTY_STARTED","party":party,"mode":checked["mode"],"profile_sha256":checked["profile_sha256"]})
            code = process.wait(timeout=max(.01,deadline-time.monotonic()))
        log = (session/"party.log").read_bytes()
        require(code == 0 and b"SEALED_AUCTION_CHECKS_COMPLETE" in log,"party aborted or incomplete native checks")
        status = "local-party-completed"
        return dict(status=status,party=party,mode=checked["mode"],native_exit_code=code,
                    launch_config_sha256=approved_config_sha256,loopback_test_sha256=config["loopback_test_sha256"],
                    profile_sha256=checked["profile_sha256"],selection_manifest_sha256=config["selection_manifest_sha256"],
                    binary_sha256=stamp["binarySha256"],shared_library_sha256=stamp["sharedLibrarySha256"],
                    transport_patch_sha256=stamp["transportPatchSha256"],log_sha256=file_digest(session/"party.log"),
                    independent_operators=False,whole_mpc_verified=False,execution_proof=False)
    finally:
        if process is not None and process.poll() is None:
            os.killpg(process.pid,signal.SIGTERM)
            try:
                process.wait(timeout=5)
            except subprocess.TimeoutExpired:
                os.killpg(process.pid,signal.SIGKILL)
                process.wait(timeout=5)
        if session.exists():
            shutil.rmtree(session/"Player-Data",ignore_errors=True)
            shutil.rmtree(session/"native",ignore_errors=True)
        reservations.finish(profile,party,status)


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    commands = parser.add_subparsers(dest="command",required=True)
    init = commands.add_parser("init-state")
    init.add_argument("--state-directory",required=True)
    for name in ("check","run"):
        p = commands.add_parser(name)
        p.add_argument("--config",required=True)
        p.add_argument("--config-sha256",required=True)
        p.add_argument("--allow-remote-network",action="store_true")
        p.add_argument("--allow-loopback-functional-test",action="store_true")
    args = parser.parse_args(argv)
    try:
        if args.command == "init-state":
            Reservations(args.state_directory,initialize=True)
            result = {"state_initialized":True}
        else:
            config = load(args.config)
            options = dict(allow_remote=args.allow_remote_network,allow_loopback_test=args.allow_loopback_functional_test)
            if args.command == "check":
                checked = preflight(config,args.config_sha256,**options)
                result = {"party_preflight_passed":True,"mode":checked["mode"],"independent_operators":False}
            else:
                result = launch(config,args.config_sha256,**options,
                                on_started=lambda event: print(json.dumps(event),flush=True))
        print(json.dumps(result,sort_keys=True),flush=True)
        return 0
    except (ValueError,OSError,sqlite3.Error,subprocess.SubprocessError,ManifestError):
        print(json.dumps({"error":"Party launch rejected or aborted.","whole_mpc_verified":False}),file=sys.stderr)
        return 2
    except KeyboardInterrupt:
        return 130


if __name__ == "__main__":
    signal.signal(signal.SIGTERM,lambda *_args: (_ for _ in ()).throw(KeyboardInterrupt()))
    sys.exit(main())
