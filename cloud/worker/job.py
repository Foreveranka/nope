"""One disposable bounded native process: download ciphertext, evaluate, exit.

Invoked with Python -I by server.py. URLs travel over stdin, never argv or logs.
"""
import os
from pathlib import Path
import sys
import time

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT))


class JobFailure(Exception):
    def __init__(self, code):
        self.code = code


def set_limits(memory_mb, timeout):
    import resource
    resource.setrlimit(resource.RLIMIT_CORE, (0, 0))
    resource.setrlimit(resource.RLIMIT_CPU, (timeout, timeout))
    resource.setrlimit(resource.RLIMIT_FSIZE, (512 * 1024 * 1024, 512 * 1024 * 1024))
    resource.setrlimit(resource.RLIMIT_NOFILE, (128, 128))
    # Linux RLIMIT_AS bounds native allocations as well as Python. Deployment must
    # also set container memory/pid limits; this is not an OS sandbox.
    if sys.platform == "linux":
        limit = memory_mb * 1024 * 1024
        resource.setrlimit(resource.RLIMIT_AS, (limit, limit))


def evaluate_encrypted(root):
    """Only fixed deployed portable artifacts. Never call a client/SK API."""
    try:
        from engine.protocol import approved_artifacts, write_new, require_runtime
        from engine.worker import evaluate
        artifacts = approved_artifacts(artifact_set="portable-v1")
        if set(artifacts) != {"server.zip", "client-specs.json"}:
            raise ValueError()
        for name, data in artifacts.items():
            write_new(root / name, data)
    except Exception:
        raise JobFailure(12) from None
    try:
        require_runtime()
        from concrete import fhe  # Native library import, no client instance.
    except Exception:
        raise JobFailure(13) from None
    try:
        evaluate(root)
    except Exception:
        raise JobFailure(14) from None


def run(root, data, host, timeout, evaluator=evaluate_encrypted):
    from cloud.worker.transport import download, validate_payload
    try:
        payload = validate_payload(data, host)
    except Exception:
        raise JobFailure(10) from None
    deadline = time.monotonic() + timeout
    try:
        for file in payload["files"]:
            download(file, root, host, deadline)
    except Exception:
        raise JobFailure(11) from None
    evaluator(root)


if __name__ == "__main__":
    try:
        os.umask(0o077)
        root, host, timeout, memory_mb = Path(sys.argv[1]), sys.argv[2], int(sys.argv[3]), int(sys.argv[4])
        set_limits(memory_mb, timeout)
        run(root, sys.stdin.buffer.read(32769), host, timeout)
    except JobFailure as failure:
        sys.exit(failure.code)
    except BaseException:
        # No raw exception, path, URL, input or native stderr is exposed.
        sys.exit(15)
