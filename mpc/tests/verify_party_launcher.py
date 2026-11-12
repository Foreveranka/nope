"""Manual real native test, never invoked by unittest discovery.

Centralized synthetic witnesses, three launcher processes and four private-input
clients. Explicit test-only dial mapping to approved loopback addresses; no
external listener, system alias, tunnel, namespace or independent operator claim.
"""
import argparse
import hashlib
import json
import os
from pathlib import Path
import secrets
import shutil
import socket
import subprocess
import sys
import time

from mpc import network_profile as net, sealed_client, v2
from mpc.party_launcher import Reservations
from mpc.sample_v2 import synthetic_closed_job, synthetic_intent
from mpc.run_local import ROOT, VENDOR, OPENSSL, certificates, cleanup, run_logged, wait_line


def sha(path):
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()


def write_json(path,value):
    Path(path).write_bytes(net.canonical(value))


def client_worker(session,slot):
    session = Path(session)
    manifest,profile,mapping = [json.loads((session/name).read_bytes()) for name in ("selection.json","profile.json","loopback.json")]
    pin = net.profile_digest(profile)
    checked = net.validate_profile(profile,pin,manifest,allow_remote=True)
    # This adapter exists ONLY in this explicit synthetic test executable.
    # Production sealed_client has no loopback override/profile bypass.
    original = sealed_client._connect_ipv4
    endpoints = {(p["address"],p["client_port"]):(mapping["addresses"][i],p["client_port"])
                 for i,p in enumerate(profile["parties"])}
    def local_dial(address,port,timeout):
        return original(*endpoints[(address,port)],timeout)
    sealed_client._connect_ipv4 = local_dial
    secret = json.load(sys.stdin)
    output = sealed_client.run(manifest,slot,17400,session/("C%d/Player-Data" % slot),
        secret["amount"],bytes.fromhex(secret["salt"]),timeout=300,codec_version=2,
        expected_manifest_hash=v2.manifest_digest(manifest),network_profile=checked,
        expected_network_profile_sha256=pin,allow_remote_network=True)
    print(json.dumps({"clientId":slot,"output":output}),flush=True)


def prepare(loopback_addresses=None):
    sessions = []
    try:
        return _prepare(loopback_addresses or ["127.0.0.1"]*3,sessions.append)
    except BaseException:
        for session in sessions:
            cleanup([],[],session)
        raise


def _prepare(loopback_addresses,on_session):
    now = int(time.time())
    prepared = v2.prepare_synthetic(synthetic_intent(bid_deadline_ns=str((now-10)*10**9),
                                                   result_deadline_ns=str((now+1000)*10**9)),
                                    budget=100,prices=[90,80,95])
    manifest = v2.build_selection_manifest(prepared,synthetic_closed_job(prepared))
    digest = v2.manifest_digest(manifest)
    session = ROOT/"runtime"/("bind-"+secrets.token_hex(5))
    session.mkdir(mode=0o700,parents=True)
    on_session(session)
    write_json(session/"selection.json",manifest)
    source = ROOT/"programs/sealed_procurement_v2.mpc"
    prefix = "sealed_v2_"+digest[:16]
    run_logged([sys.executable,"compile.py","-R","64","-X","-o",prefix,source,session/"selection.json","17400"],
               VENDOR,session/"compiler.log",timeout=300)
    schedules = list((VENDOR/"Programs/Schedules").glob(prefix+"-*.sch"))
    if len(schedules)!=1:
        raise RuntimeError("ambiguous compiled schedule")
    schedule = schedules[0]
    tapes = [x.rsplit(":",1)[0]+".bc" for x in schedule.read_text().splitlines()[2].split()]
    bundle = {"schema":"veil-mpc-bytecode-bundle-v1","files":[
        {"name":name,"sha256":sha(VENDOR/"Programs/Bytecode"/name)} for name in sorted(tapes)]}
    write_json(session/"bytecode.json",bundle)
    certificates(session) # Seven keys generated separately; each directory receives only its own.
    def cert(name):
        import ssl
        return hashlib.sha256(ssl.PEM_cert_to_DER_cert((session/"P0/Player-Data"/name).read_text())).hexdigest()
    profile = dict(schema=net.SCHEMA,transport=net.TRANSPORT,upstream=net.UPSTREAM,epoch=1,
        not_before=now-1,expires_at=now+600,selection_manifest_sha256=digest,registry_job_id="1",
        job_binding_hash=bytes(manifest["closedJob"]["job_binding_hash"]).hex(),selection_round=manifest["selectionRound"],
        trust_anchor_sha256=cert("trust.pem"),
        parties=[dict(party=i,address="10.80.0.%d" % (11+i),peer_port=17500+i,client_port=17400+i,
                      tls_name="P%d" % i,certificate_sha256=cert("P%d.pem" % i)) for i in range(3)],
        clients=[dict(client=i,tls_name="C%d" % i,certificate_sha256=cert("C%d.pem" % i)) for i in range(4)],
        program=dict(name=schedule.stem,source_sha256=sha(source),transport_patch_sha256=sha(ROOT/"patches/local-transport.patch"),
                     build_recipe_sha256=sha(ROOT/"bootstrap.py"),binary_sha256=sha(VENDOR/"spdz2k-party.x"),
                     bytecode_sha256=sha(session/"bytecode.json"),schedule_sha256=sha(schedule)))
    pin = net.profile_digest(profile)
    write_json(session/"profile.json",profile)
    mapping = dict(schema="veil-loopback-functional-test-v1",profile_sha256=pin,
                   addresses=loopback_addresses,expires_at=now+600)
    write_json(session/"loopback.json",mapping)
    configs = []
    for party in range(3):
        state = session/("state%d" % party)
        state.mkdir(mode=0o700)
        Reservations(state,initialize=True)
        config = dict(schema="veil-party-launch-v1",party=party,profile=str(session/"profile.json"),profile_sha256=pin,
            selection_manifest=str(session/"selection.json"),selection_manifest_sha256=digest,
            build_stamp=str(ROOT/".local/build-stamp.json"),build_stamp_sha256=sha(ROOT/".local/build-stamp.json"),
            artifacts=dict(binary=str(VENDOR/"spdz2k-party.x"),shared_library=str(VENDOR/"libSPDZ.so"),
                           config=str(VENDOR/"CONFIG.mine"),recipe=str(ROOT/"bootstrap.py"),source=str(source),
                           patch=str(ROOT/"patches/local-transport.patch"),schedule=str(schedule),
                           bytecode_manifest=str(session/"bytecode.json"),bytecode_directory=str(VENDOR/"Programs/Bytecode")),
            tls_directory=str(session/("P%d/Player-Data" % party)),state_directory=str(state),openssl=str(OPENSSL),
            timeout_seconds=300,loopback_test=str(session/"loopback.json"),loopback_test_sha256=net.profile_digest(mapping))
        write_json(session/("config%d.json" % party),config)
        configs.append(config)
    return session,prepared,manifest,profile,configs


def verify():
    probes = []
    for address in ("127.0.0.1","127.0.0.2","127.0.0.3"):
        s = socket.socket()
        try:
            s.bind((address,0))
            probes.append(dict(address=address,bindable=True))
        except OSError as error:
            probes.append(dict(address=address,bindable=False,errno=error.errno))
        finally:
            s.close()
    session = None
    processes,logs = [],[]
    try:
        addresses = [p["address"] for p in probes] if all(p["bindable"] for p in probes) else ["127.0.0.1"]*3
        session,prepared,manifest,profile,configs = prepare(addresses)
        start = time.monotonic()
        launchers = []
        for party,config in enumerate(configs):
            log = (session/("launcher%d.error.log" % party)).open("wb")
            logs.append(log)
            proc = subprocess.Popen([sys.executable,"-m","mpc.party_launcher","run","--config",str(session/("config%d.json" % party)),
                "--config-sha256",net.profile_digest(config),"--allow-remote-network","--allow-loopback-functional-test"],
                cwd=ROOT.parent,stdout=subprocess.PIPE,stderr=log,text=True,start_new_session=True,
                env=dict(os.environ,PYTHONDONTWRITEBYTECODE="1"))
            processes.append(proc); launchers.append(proc)
        for proc in launchers:
            event = json.loads(wait_line(proc,30))
            if event.get("event")!="PARTY_STARTED":
                raise RuntimeError("party launcher did not start native process")
        clients = []
        for slot in range(4):
            log = (session/("client%d.error.log" % slot)).open("wb")
            logs.append(log)
            proc = subprocess.Popen([sys.executable,"-m","mpc.tests.verify_party_launcher","--client",str(slot),"--session",str(session)],
                cwd=ROOT.parent,stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=log,text=True,start_new_session=True,
                env=dict(os.environ,PYTHONDONTWRITEBYTECODE="1"))
            processes.append(proc);clients.append(proc)
            proc.stdin.write(json.dumps(dict(amount=prepared.amounts[slot],salt=prepared.salts[slot].hex())))
            proc.stdin.close()
            if wait_line(proc,30)!="CONNECTED":
                raise RuntimeError("private client did not complete real pinned native TLS")
        outputs = [json.loads(wait_line(p,300))["output"] for p in clients]
        parties = [json.loads(wait_line(p,300)) for p in launchers]
        for p in processes:
            if p.wait(timeout=30)!=0:
                raise RuntimeError("native launcher/client failed")
        if outputs!=[[1,2,80,80],[0,0],[1,80],[0,0]]:
            raise RuntimeError("actual MPC output differs from fixed synthetic expectation")
        for party,result in enumerate(parties):
            if result["status"]!="local-party-completed" or result["whole_mpc_verified"] is not False:
                raise RuntimeError("incorrect local party completion claim")
            state = session/("state%d" % party)
            if list(state.rglob("*.key")) or list(state.rglob("Player-Data")):
                raise RuntimeError("launcher did not erase its transient key/preprocessing")
            log_paths = list(state.glob("party*/party.log"))
            text = log_paths[0].read_text()
            if "VEIL_EXPLICIT_BIND" not in text or "VEIL_EXPLICIT_CLIENT_LISTENER" not in text:
                raise RuntimeError("missing actual native explicit-bind evidence")
        result = dict(status="VERIFIED_NATIVE_LAUNCHER_LOOPBACK_MPC",runtimeSeconds=time.monotonic()-start,
            actualSyntheticPrivateOutputs=outputs,parties=parties,selectionManifestHash=v2.manifest_digest(manifest),
            profileSha256=net.profile_digest(profile),wholeSyntheticMpcVerified=True,independentOperators=False,
            externalHostsVerified=False,executionProof=False,interfaceProbes=probes,
            threeInterfaceTest="passed" if len(set(addresses))==3 else "unavailable-no-interface-alias-created",
            exercisedInterfaces=sorted(set(addresses)),testDialMapping="explicit-test-only-profile-endpoints-to-loopback",
            nativeBuild=json.loads((ROOT/".local/build-stamp.json").read_text()),session=str(session))
        # Replay must fail without starting another native process.
        replay = subprocess.run([sys.executable,"-m","mpc.party_launcher","run","--config",str(session/"config0.json"),
            "--config-sha256",net.profile_digest(configs[0]),"--allow-remote-network","--allow-loopback-functional-test"],
            cwd=ROOT.parent,capture_output=True,text=True,timeout=30)
        if replay.returncode!=2 or "PARTY_STARTED" in replay.stdout:
            raise RuntimeError("launcher replay was not rejected before native launch")
        result["durableReplayRejected"] = True
        return result
    finally:
        if session is not None:
            cleanup(processes,logs,session)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--client",type=int,choices=range(4))
    parser.add_argument("--session")
    args = parser.parse_args()
    if args.client is not None:
        client_worker(args.session,args.client)
    else:
        result = verify()
        target = ROOT/"evidence/explicit-bind-functional.json"
        target.write_text(json.dumps(result,indent=2)+"\n")
        print(json.dumps(result,indent=2))


if __name__ == "__main__":
    main()
