"""Run an explicit local payment simulation with real SHA-256/HMAC checks."""
import json
import tempfile
from dataclasses import asdict
from pathlib import Path
from .adapter import PaymentAdapter
from .fixture import LocalFixtureRail
from .interface import Action, State
from .synthetic import SyntheticVerifier, make_binding, package


def run():
    with tempfile.TemporaryDirectory(prefix="veil-payment-simulation-") as root:
        root = Path(root)
        binding = make_binding()
        delivery, artifact, receipt = package(binding)
        rail = LocalFixtureRail(root / "rail.sqlite3")
        rail.register(binding)
        adapter = PaymentAdapter(root / "outbox.sqlite3", rail, SyntheticVerifier())
        adapter.register(binding)
        events = []
        for action in (Action.AWARD, Action.HOLD, Action.SUBMIT, Action.ACCEPT, Action.RELEASE):
            if action == Action.ACCEPT:
                adapter.verify_artifact(binding, delivery, artifact, receipt)
            arg = delivery if action in (Action.SUBMIT, Action.ACCEPT, Action.RELEASE) else None
            result = adapter.perform("demo-" + action.value, action, binding, arg)
            if result.state == State.UNKNOWN:
                raise RuntimeError("unexpected ambiguous simulation outcome")
            events.append({"action": action.value, "state": result.state.value, "revision": result.revision})
        duplicate = adapter.perform("demo-release", Action.RELEASE, binding, delivery)
        assert duplicate == result
        assert rail.movement_count(binding, "release") == 1
        return {"mode": "local_fixture_simulation", "real_money": False,
                "actual_crypto": ["SHA-256", "HMAC-SHA256 synthetic receipt"],
                "artifact_is_actual_ciphertext": False,
                "near_sandbox_run_by_this_demo": False,
                "live_payments": False, "settlement_proof": False,
                "local_validity_forces_remote_payment": False,
                "binding": asdict(binding), "delivery": asdict(delivery),
                "events": events, "release_movements": 1, "same_operation_retry_equal": True}


if __name__ == "__main__":
    print(json.dumps(run(), indent=2, sort_keys=True))
