"""Reproducible payment-only test evidence as JSON; no external services."""
import datetime
import hashlib
import io
import json
import sys
import time
import unittest
from pathlib import Path


def main():
    root = Path(__file__).resolve().parent
    suite = unittest.defaultTestLoader.discover(str(root / "tests"), top_level_dir=str(root.parent))
    stream = io.StringIO()
    start = time.monotonic()
    result = unittest.TextTestRunner(stream=stream, verbosity=2).run(suite)
    report = {"kind": "payment_boundary_local_test_evidence",
              "observedAt": datetime.datetime.now(datetime.timezone.utc).isoformat(),
              "python": sys.version, "testsRun": result.testsRun,
              "passed": result.wasSuccessful(), "failures": len(result.failures),
              "errors": len(result.errors), "skipped": len(result.skipped),
              "elapsedSeconds": round(time.monotonic() - start, 3),
              "mode": "local_fixture_simulation", "livePayments": False,
              "actualCrypto": ["SHA-256", "HMAC-SHA256 with public synthetic fixture key"],
              "actualLocalProcessTests": ["os._exit after rail release commit", "four concurrent processes same release operation"],
              "notTestedHere": ["live MCP/account operations", "real-money settlement", "NEAR sandbox", "FHE correctness", "production security/privacy"],
              "sourceSha256": {str(p.relative_to(root)): hashlib.sha256(p.read_bytes()).hexdigest()
                               for p in sorted(root.rglob("*.py"))},
              "testLog": stream.getvalue()}
    print(json.dumps(report, indent=2, sort_keys=True))
    return 0 if result.wasSuccessful() else 1


if __name__ == "__main__":
    sys.exit(main())
