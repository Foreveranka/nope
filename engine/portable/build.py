"""python -m engine.portable.build OUT_DIR -- reproducible public MLIR export.

Does not alter pins or approved artifacts. Review and pin candidate explicitly.
"""
import argparse
import importlib.metadata
import io
import json
import platform
import tempfile
import zipfile
from pathlib import Path

from engine.protocol import canonical_json, require_runtime, sha256, write_new
from . import clean4

MEMBERS = {"circuit.mlir", "client.specs.json", "build-options.json", "is_simulated"}


def deterministic_zip(members):
    stream = io.BytesIO()
    with zipfile.ZipFile(stream, "w", compression=zipfile.ZIP_STORED) as archive:
        for name, data in sorted(members.items()):
            info = zipfile.ZipInfo(name, (1980, 1, 1, 0, 0, 0))
            info.create_system = 3
            info.external_attr = 0o100600 << 16
            archive.writestr(info, data)
    return stream.getvalue()


def build(output, *, check_approved=False):
    require_runtime()
    if importlib.metadata.version("numpy") != "1.26.4":
        raise RuntimeError("Reproducible build requires numpy==1.26.4")
    target = Path(output)
    target.mkdir(mode=0o700, parents=True, exist_ok=True)
    if any(target.iterdir()):
        raise ValueError("Build destination must be empty")
    circuit = clean4.compile_circuit()
    # Public supported export API; read only MLIR, not jsonpickle configuration.
    with tempfile.TemporaryDirectory(prefix="clean4-export-") as temporary:
        path = Path(temporary) / "export.zip"
        circuit.server.save(path, via_mlir=True)
        with zipfile.ZipFile(path) as archive:
            members = {"circuit.mlir": archive.read("circuit.mlir"),
                       "client.specs.json": archive.read("client.specs.json"),
                       "is_simulated": archive.read("is_simulated"),
                       "build-options.json": canonical_json(clean4.OPTIONS)}
    blobs = {"server.zip": deterministic_zip(members),
             "client-specs.json": members["client.specs.json"]}
    source = Path(clean4.__file__).read_bytes()
    manifest = {"schema": "veil-clean4-portable-build-v1", "profileId": "clean-4-records-v1",
                "concrete_python": "2.11.0", "numpy": "1.26.4",
                "sourceSha256": sha256(source), "source": "engine/portable/clean4.py",
                "options": clean4.OPTIONS, "inputset": "two-full-uint1-vectors-zero-and-one",
                "members": {n: sha256(b) for n, b in members.items()},
                "artifacts": {n: sha256(b) for n, b in blobs.items()},
                "format": "deterministic-stored-zip-mlir-no-jsonpickle",
                "global_p_error_reported": circuit.global_p_error,
                "security_bits_requested": 128,
                "reproducibility": "MLIR bundle byte identity; native binaries are host-specific"}
    for name, data in blobs.items():
        write_new(target / name, data)
    write_new(target / "BUILD.json", canonical_json(manifest))
    write_new(target / "SHA256.json", canonical_json(
        {**manifest["artifacts"], "BUILD.json": sha256(canonical_json(manifest))}))
    # Host observation deliberately separate from deterministic artifact identity.
    write_new(target / "build-host.json", canonical_json(
        {"python": platform.python_version(), "platform": platform.platform(),
         "server_api_sha256": sha256(Path(__import__("concrete.fhe.compilation.server",
             fromlist=["Server"]).__file__).read_bytes())}))
    if check_approved:
        from .pins import ARTIFACT_PINS, SOURCE_SHA256
        if manifest["sourceSha256"] != SOURCE_SHA256 or manifest["artifacts"] != ARTIFACT_PINS:
            raise ValueError("Rebuilt candidate differs from reviewed source/artifacts")
    print(json.dumps(manifest, sort_keys=True), flush=True)
    return manifest


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("output")
    parser.add_argument("--check-approved", action="store_true")
    args = parser.parse_args()
    build(args.output, check_approved=args.check_approved)
