"""Load only the approved portable MLIR, never jsonpickle or supplied code/config."""
import io
import zipfile

from engine.protocol import canonical_json, require_runtime, sha256
from .clean4 import OPTIONS, configuration
from .pins import ARTIFACT_PINS

MEMBERS = {"circuit.mlir", "client.specs.json", "build-options.json", "is_simulated"}


def inspect_bundle(artifacts):
    if set(artifacts) != set(ARTIFACT_PINS):
        raise ValueError("Portable bundle requires exactly server and specs")
    for name, pin in ARTIFACT_PINS.items():
        if type(artifacts[name]) is not bytes or sha256(artifacts[name]) != pin:
            raise ValueError("Unapproved portable FHE artifact: " + name)
    with zipfile.ZipFile(io.BytesIO(artifacts["server.zip"])) as archive:
        if set(archive.namelist()) != MEMBERS or len(archive.infolist()) != len(MEMBERS):
            raise ValueError("Unexpected portable archive members")
        if any(i.file_size > 2 * 1024 * 1024 for i in archive.infolist()):
            raise ValueError("Oversized portable archive member")
        members = {name: archive.read(name) for name in MEMBERS}
    if (members["client.specs.json"] != artifacts["client-specs.json"] or
            members["is_simulated"] != b"0" or
            members["build-options.json"] != canonical_json(OPTIONS)):
        raise ValueError("Portable configuration/spec mismatch")
    return members


def load_server(artifacts):
    """Compile approved public MLIR for the current CPU; suitable for warm reuse.

    Takes the two bytes values from approved_artifacts(artifact_set='portable-v1').
    No caller configuration, ZIP extraction, jsonpickle.loads or Server.load.
    Native compilation/deserialization still requires trusted, patched host code.
    """
    members = inspect_bundle(artifacts)  # Validate before importing native code.
    require_runtime()
    from concrete import fhe
    # Match Concrete's supported MLIR round trip: ClientSpecs also carries the
    # all-null TFHE-rs shape/type descriptors produced by the Python frontend.
    specs = fhe.ClientSpecs.deserialize(artifacts["client-specs.json"])
    server = fhe.Server.create(members["circuit.mlir"].decode("utf-8"), configuration(),
                               is_simulated=False, tfhers_specs=specs.tfhers_specs)
    if server.is_simulated or server.client_specs.serialize() != artifacts["client-specs.json"]:
        raise ValueError("Portable compilation produced incompatible client specs")
    server._veil_portable_sha256 = ARTIFACT_PINS["server.zip"]
    return server
