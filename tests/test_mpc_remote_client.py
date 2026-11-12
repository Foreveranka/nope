"""Real Python mTLS at ephemeral loopback ports, NOT native/independent-host MPC.

Only the TCP dial helper is redirected by the test to ephemeral loopback ports;
production profiles still reject loopback and require literal approved endpoints.
No native process/build or active runtime/session is touched. Keys are temporary
synthetic PKI fixtures, destroyed at teardown. No private MPC inputs are sent.
"""

from contextlib import contextmanager
from contextlib import redirect_stderr
from copy import deepcopy
import hashlib
import io
import json
from pathlib import Path
import shutil
import socket
import ssl
import struct
import subprocess
import tempfile
import threading
import time
import unittest
from unittest.mock import patch

from mpc import network_profile as net, sealed_client as client, v2
from mpc.sample_v2 import synthetic_closed_job, synthetic_intent


def cert_der(path):
    return ssl.PEM_cert_to_DER_cert(path.read_text())


def sha(value):
    return hashlib.sha256(value).hexdigest()


class TLSCluster:
    """Three real TLS test responders returning only the public domain frame."""
    def __init__(self, root, *, overrides=None, consecutive=False, domain=None):
        self.root, self.overrides = root, overrides or {}
        self.domain = domain or struct.pack("<iii", ord("R"), 128, 64)
        self.sockets, self.threads, self.seen_clients, self.errors = [], [], [], []
        for _ in range(40):
            sockets = []
            try:
                base = 0
                for i in range(3):
                    listener = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
                    sockets.append(listener)
                    listener.bind(("127.0.0.1", base+i if consecutive and i else 0))
                    if i == 0:
                        base = listener.getsockname()[1]
                        if consecutive and base > 65530:
                            raise OSError("retry ephemeral consecutive allocation")
                    listener.listen(1)
                    listener.settimeout(3)
                self.sockets = sockets
                break
            except OSError:
                for s in sockets:
                    s.close()
        if len(self.sockets) != 3:
            raise RuntimeError("could not allocate private TLS test listeners")
        self.base = self.sockets[0].getsockname()[1]
        self.destinations = [("127.0.0.1", s.getsockname()[1]) for s in self.sockets]
        self.active = []

    def serve(self, party):
        raw = secured = None
        try:
            raw, _ = self.sockets[party].accept()
            raw.settimeout(3)
            if client.receive(raw, 1) != b"0":
                raise ValueError("test responder expects C0 public slot")
            context = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
            context.minimum_version = ssl.TLSVersion.TLSv1_2
            context.verify_mode = ssl.CERT_REQUIRED
            context.load_verify_locations(cafile=str(self.root / "trust.pem"))
            name = self.overrides.get(party, "P%d" % party)
            context.load_cert_chain(str(self.root / (name+".pem")), str(self.root / (name+".key")))
            secured = context.wrap_socket(raw, server_side=True)
            self.active.append(secured)
            if secured.getpeercert(binary_form=True) != cert_der(self.root / "C0.pem"):
                raise ValueError("test responder rejects foreign C leaf")
            self.seen_clients.append(party)
            client.send(secured, self.domain)
            secured.recv(1)  # Client closes after domain-only transport check.
        except (OSError, EOFError, ValueError) as exc:
            self.errors.append(type(exc).__name__)
        finally:
            if secured is not None:
                secured.close()
            if raw is not None:
                raw.close()

    def __enter__(self):
        for i in range(3):
            thread = threading.Thread(target=self.serve, args=(i,), daemon=True)
            self.threads.append(thread)
            thread.start()
        return self

    def __exit__(self, *_args):
        for s in self.sockets + self.active:
            s.close()
        for thread in self.threads:
            thread.join(timeout=4)


class RemoteClientTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.temp = tempfile.TemporaryDirectory(prefix="veil-remote-client-test-")
        cls.root = Path(cls.temp.name)
        executable = shutil.which("openssl")
        if executable is None:
            raise RuntimeError("OpenSSL required for real mutual TLS tests")

        def openssl(*args):
            subprocess.run([executable, *map(str, args)], check=True, stdout=subprocess.DEVNULL,
                           stderr=subprocess.DEVNULL, timeout=20)

        cls.openssl = staticmethod(openssl)
        conf = cls.root / "openssl.cnf"
        conf.write_text("[req]\ndistinguished_name=dn\nprompt=no\n[dn]\nCN=unused\n")
        for ca in ("root", "rogue"):
            openssl("req", "-newkey", "rsa:2048", "-nodes", "-x509", "-sha256", "-days", "1",
                    "-config", conf, "-subj", "/CN="+ca, "-keyout", cls.root/(ca+".key"),
                    "-out", cls.root/(ca+".pem"), "-addext", "basicConstraints=critical,CA:TRUE",
                    "-addext", "keyUsage=critical,keyCertSign,cRLSign")
        shutil.copyfile(cls.root/"root.pem", cls.root/"trust.pem")
        identities = [(name,name,"root") for name in ("P0","P1","P2","C0","C1","C2","C3")]
        identities += [("P1-alt","P1","root"), ("P1-rogue","P1","rogue"),
                       ("C0-rogue","C0","rogue")]
        for serial, (file_name, tls_name, ca) in enumerate(identities, 10):
            key, csr, cert = [cls.root/(file_name+suffix) for suffix in (".key",".csr",".pem")]
            openssl("req", "-new", "-newkey", "rsa:2048", "-nodes", "-sha256", "-config", conf,
                    "-subj", "/CN="+tls_name, "-keyout", key, "-out", csr)
            key.chmod(0o600)
            ext = cls.root/(file_name+".ext")
            ext.write_text("basicConstraints=critical,CA:FALSE\nkeyUsage=critical,digitalSignature,keyEncipherment\n"
                           "extendedKeyUsage=serverAuth,clientAuth\nsubjectAltName=DNS:"+tls_name+"\n")
            openssl("x509", "-req", "-in", csr, "-CA", cls.root/(ca+".pem"), "-CAkey", cls.root/(ca+".key"),
                    "-set_serial", str(serial), "-days", "1", "-sha256", "-extfile", ext, "-out", cert)

    @classmethod
    def tearDownClass(cls):
        cls.temp.cleanup()

    def setUp(self):
        self.directory_temp = tempfile.TemporaryDirectory(dir=self.root)
        self.directory = Path(self.directory_temp.name)
        for name in ("P0","P1","P2","C0","C1","C2","C3","trust"):
            shutil.copyfile(self.root/(name+".pem"), self.directory/(name+".pem"))
        shutil.copyfile(self.root/"C0.key", self.directory/"C0.key")
        (self.directory/"C0.key").chmod(0o600)
        now = int(time.time())
        prepared = v2.prepare_synthetic(synthetic_intent(
            bid_deadline_ns=str((now-10)*10**9), result_deadline_ns=str((now+1000)*10**9)))
        self.selection = v2.build_selection_manifest(prepared, synthetic_closed_job(prepared))
        self.selection_pin = v2.manifest_digest(self.selection)
        fake_artifact = sha(b"explicit unbuilt artifact declaration for transport-only test")
        self.profile = dict(schema=net.SCHEMA, transport=net.TRANSPORT, upstream=net.UPSTREAM,
            epoch=1, not_before=now-5, expires_at=now+300,
            selection_manifest_sha256=self.selection_pin, registry_job_id="1",
            job_binding_hash=bytes(self.selection["closedJob"]["job_binding_hash"]).hex(),
            selection_round=self.selection["selectionRound"], trust_anchor_sha256=sha(cert_der(self.root/"root.pem")),
            parties=[dict(party=i,address="10.80.0.%d" % (11+i),peer_port=17500+i,client_port=17400+i,
                          tls_name="P%d" % i,certificate_sha256=sha(cert_der(self.root/("P%d.pem" % i)))) for i in range(3)],
            clients=[dict(client=i,tls_name="C%d" % i,certificate_sha256=sha(cert_der(self.root/("C%d.pem" % i)))) for i in range(4)],
            program=dict(name="sealed_v2_"+self.selection_pin[:16],source_sha256=v2.program_hash(),
                         transport_patch_sha256=fake_artifact,build_recipe_sha256=fake_artifact,
                         binary_sha256=fake_artifact,bytecode_sha256=fake_artifact,schedule_sha256=fake_artifact))
        self.refresh()

    def refresh(self):
        self.pin = net.profile_digest(self.profile)
        self.checked = net.validate_profile(self.profile,self.pin,self.selection,allow_remote=True)

    def tearDown(self):
        self.directory_temp.cleanup()

    def connect(self, **kwargs):
        args = dict(network_profile=self.checked, expected_network_profile_sha256=self.pin,
                    selection_manifest=self.selection, allow_remote_network=True)
        args.update(kwargs)
        return client.connect("C0",17400,self.directory,2,**args)

    @contextmanager
    def mapped_transport(self, cluster):
        # Redirection is TEST-ONLY. The actual production AF_INET dial helper is
        # used for every redirected TCP connection and the entire TLS handshake.
        original_connect = client._connect_ipv4
        original_wrap = ssl.SSLContext.wrap_socket
        wrapped, attempted, raw_sockets = [], [], []

        def dial(address, port, timeout):
            attempted.append((address,port))
            party = [("10.80.0.%d" % (11+i),17400+i) for i in range(3)].index((address,port))
            raw = original_connect(*cluster.destinations[party],timeout)
            raw_sockets.append(raw)
            return raw

        def wrap(context, sock, *args, **kwargs):
            secured = original_wrap(context,sock,*args,**kwargs)
            if not kwargs.get("server_side",False):
                wrapped.append(secured)
            return secured

        with patch.object(client,"_connect_ipv4",side_effect=dial), \
                patch.object(ssl.SSLContext,"wrap_socket",new=wrap), \
                patch.object(socket,"getaddrinfo",side_effect=AssertionError("remote DNS forbidden")):
            yield attempted, wrapped, raw_sockets

    def test_actual_three_party_mutual_tls_domain_only_transport(self):
        with TLSCluster(self.root) as cluster, self.mapped_transport(cluster) as (attempted,wrapped,raw):
            sockets = self.connect()
            try:
                self.assertEqual(len(sockets),3)
                self.assertEqual(attempted,[("10.80.0.%d" % (11+i),17400+i) for i in range(3)])
                self.assertEqual(sorted(cluster.seen_clients),[0,1,2])
            finally:
                for s in sockets:
                    s.close()
            self.assertTrue(all(s.fileno()==-1 for s in wrapped+raw))

    def test_same_ca_same_name_unapproved_leaf_rejected_and_all_sockets_closed(self):
        with TLSCluster(self.root,overrides={1:"P1-alt"}) as cluster, self.mapped_transport(cluster) as (_,wrapped,raw):
            with self.assertRaisesRegex(ValueError,"party certificate mismatch"):
                self.connect()
            self.assertTrue(all(s.fileno()==-1 for s in wrapped+raw))

    def test_wrong_ca_is_rejected_during_real_handshake_and_prior_sockets_close(self):
        with TLSCluster(self.root,overrides={1:"P1-rogue"}) as cluster, self.mapped_transport(cluster) as (_,wrapped,raw):
            with self.assertRaises(ssl.SSLError):
                self.connect()
            self.assertTrue(all(s.fileno()==-1 for s in wrapped+raw))

    def test_wrong_slot_hostname_is_rejected_during_real_handshake(self):
        with TLSCluster(self.root,overrides={1:"P2"}) as cluster, self.mapped_transport(cluster) as (_,wrapped,raw):
            with self.assertRaises(ssl.SSLError):
                self.connect()
            self.assertTrue(all(s.fileno()==-1 for s in wrapped+raw))

    def test_server_rejects_untrusted_client_ca_with_real_mutual_tls(self):
        shutil.copyfile(self.root/"C0-rogue.pem",self.directory/"C0.pem")
        shutil.copyfile(self.root/"C0-rogue.key",self.directory/"C0.key")
        self.profile["clients"][0]["certificate_sha256"] = sha(cert_der(self.root/"C0-rogue.pem"))
        self.refresh()  # Matching declared leaf does not bypass peer's CA trust.
        with TLSCluster(self.root) as cluster, self.mapped_transport(cluster) as (_,wrapped,raw):
            with self.assertRaises((ssl.SSLError,EOFError,OSError)):
                self.connect()
            self.assertTrue(all(s.fileno()==-1 for s in wrapped+raw))
            self.assertEqual(cluster.seen_clients,[])

    def test_server_rejects_wrong_client_leaf_even_if_ca_trusts_it(self):
        shutil.copyfile(self.root/"C1.pem",self.directory/"C0.pem")
        shutil.copyfile(self.root/"C1.key",self.directory/"C0.key")
        # Make the client declaration locally coherent with a foreign identity;
        # the server still pins the expected C0 leaf and rejects this transport.
        self.profile["clients"][0]["certificate_sha256"] = sha(cert_der(self.root/"C1.pem"))
        self.profile["clients"][1]["certificate_sha256"] = sha(cert_der(self.root/"C0.pem"))
        shutil.copyfile(self.root/"C0.pem",self.directory/"C1.pem")
        self.refresh()
        with TLSCluster(self.root) as cluster, self.mapped_transport(cluster) as (_,wrapped,raw):
            with self.assertRaises((EOFError,OSError)):
                self.connect()
            self.assertTrue(all(s.fileno()==-1 for s in wrapped+raw))

    def test_local_certificate_ca_or_private_key_tampering_fails_before_network(self):
        for name, replacement in (("P1.pem","P1-alt.pem"),("trust.pem","rogue.pem"),("C0.key","C1.key")):
            target = self.directory/name
            original = target.read_bytes()
            try:
                shutil.copyfile(self.root/replacement,target)
                with patch.object(client,"_connect_ipv4",side_effect=AssertionError("no networking")):
                    with self.assertRaises((ValueError,ssl.SSLError)):
                        self.connect()
            finally:
                target.write_bytes(original)

    def test_missing_or_foreign_private_key_fails_before_network(self):
        with patch.object(client,"_connect_ipv4",side_effect=AssertionError("no networking")):
            (self.directory/"C0.key").chmod(0o644)
            with self.assertRaises(ValueError):
                self.connect()
            (self.directory/"C0.key").chmod(0o600)
            shutil.copyfile(self.root/"C1.key",self.directory/"C1.key")
            with self.assertRaises(ValueError):
                self.connect()
            (self.directory/"C1.key").unlink()
            (self.directory/"C0.key").unlink()
            with self.assertRaises(OSError):
                self.connect()

    def test_raw_browser_dictionary_missing_opt_in_foreign_job_and_unapproved_pin_rejected(self):
        foreign = deepcopy(self.selection)
        foreign["closedJob"]["closed_at_ns"] = str(int(foreign["closedJob"]["closed_at_ns"])+1)
        v2.validate_manifest(foreign)
        with patch.object(client,"_connect_ipv4",side_effect=AssertionError("no networking")):
            for kwargs in (dict(network_profile=self.profile),dict(allow_remote_network=False),
                           dict(allow_remote_network=1),dict(expected_network_profile_sha256=sha(b"foreign")),
                           dict(selection_manifest=foreign),dict(network_profile=None)):
                with self.subTest(kwargs=list(kwargs)), self.assertRaises(ValueError):
                    self.connect(**kwargs)

    def test_expired_profile_revalidated_even_for_immutable_instance(self):
        with patch.object(net.time,"time",return_value=self.profile["expires_at"]), \
                patch.object(client,"_connect_ipv4",side_effect=AssertionError("no networking")):
            with self.assertRaises(ValueError):
                self.connect()

    def test_profile_expiry_stops_existing_connection_before_any_new_frame(self):
        with TLSCluster(self.root) as cluster, self.mapped_transport(cluster):
            sockets = self.connect()
            try:
                with patch.object(client.time,"time",return_value=self.profile["expires_at"]+1):
                    with self.assertRaises(TimeoutError):
                        client.send(sockets[0],b"synthetic test frame must not be sent")
            finally:
                for s in sockets:
                    s.close()

    def test_wall_clock_rollback_cannot_extend_initial_profile_lifetime(self):
        with patch.object(client.time,"time",return_value=100), \
                patch.object(client.time,"monotonic",return_value=10):
            deadline = client._connection_deadline(600,101)
        with patch.object(client.time,"time",return_value=90), \
                patch.object(client.time,"monotonic",return_value=12):
            with self.assertRaises(TimeoutError):
                client._remaining(deadline,101)

    def test_partial_frame_cannot_reset_remote_total_io_deadline(self):
        class FragmentedSocket:
            def settimeout(self, timeout):
                pass
            def recv(self, size):
                return b"x"
        wrapped = client._DeadlineSocket(FragmentedSocket(),1,100)
        with patch.object(client.time,"time",return_value=0), \
                patch.object(client.time,"monotonic",side_effect=[0,.4,.4,.8,.8,1.2]):
            with self.assertRaises(TimeoutError):
                client.read_exact(wrapped,3)

    def test_bad_public_domain_closes_all_authenticated_connections(self):
        with TLSCluster(self.root,domain=struct.pack("<iii",ord("R"),64,64)) as cluster, self.mapped_transport(cluster) as (_,wrapped,raw):
            with self.assertRaisesRegex(ValueError,"identical SPDZ2k"):
                self.connect()
            self.assertTrue(all(s.fileno()==-1 for s in wrapped+raw))

    def test_default_loopback_transport_keeps_original_call_signature(self):
        # Actual original local path: three adjacent ephemeral loopback ports,
        # with no approved profile, remote helper or HTTP host configuration.
        with TLSCluster(self.root,consecutive=True) as cluster, \
                patch.object(client,"_connect_ipv4",side_effect=AssertionError("remote path forbidden")):
            sockets = client.connect("C0",cluster.base,self.directory,2)
            self.assertEqual(len(sockets),3)
            for s in sockets:
                s.close()

    def test_run_requires_pinned_v2_and_disallows_remote_test_override_before_io(self):
        base = dict(codec_version=2,expected_manifest_hash=self.selection_pin,network_profile=self.checked,
                    expected_network_profile_sha256=self.pin,allow_remote_network=True)
        with patch.object(client,"connect",side_effect=AssertionError("must not connect")):
            for change in (dict(expected_manifest_hash=None),dict(unsafe_test_override={"rawAmount":1}),
                           dict(codec_version=1),dict(network_profile=self.profile),dict(port=19400)):
                options = dict(base,**change)
                port = options.pop("port",17400)
                with self.subTest(change=list(change)), self.assertRaises(ValueError):
                    client.run(self.selection,0,port,self.directory,100,b"s"*32,**options)

    def test_invalid_profile_prevents_reading_private_stdin_in_cli(self):
        manifest_path = self.directory/"selection.json"
        manifest_path.write_text(json.dumps(self.selection))
        argv = ["sealed-client","--codec-version","2","--manifest",str(manifest_path),"--client-id","0",
                "--port","17400","--cert-dir",str(self.directory),"--allow-remote-network"]
        with patch.object(client.sys,"argv",argv), patch.object(client.json,"load",side_effect=AssertionError("no secret read")), \
                redirect_stderr(io.StringIO()):
            with self.assertRaises(SystemExit) as exit_code:
                client.main()
        self.assertEqual(exit_code.exception.code,1)


if __name__ == "__main__":
    unittest.main()
