"""Orchestrator-callable LOCAL SYNTHETIC v2 selection, no external mutations."""
from .run_local import execute_fixture
from .v2 import PreparedSynthetic, build_selection_manifest


def run_selection(prepared, closed_job, *, timeout=600, port=16400):
    """Close -> real MPC selection -> return winner; never starts an attempt.

    Caller supplies the independently retrieved Closed registry snapshot. This
    checks its codec/config/roster, NOT chain finality or a durable replay guard.
    All four secrets are centralized in PreparedSynthetic; not a real bid API.
    """
    if not isinstance(prepared, PreparedSynthetic):
        raise ValueError("PreparedSynthetic required")
    manifest = build_selection_manifest(prepared, closed_job)
    result = execute_fixture(manifest, prepared.amounts, prepared.salts,
                             case="v2-selection", timeout=timeout, port=port, codec_version=2)
    buyer = result["output"]["buyer"]
    result.update(precommitContext=prepared.context_hash,
                  selectionRound=manifest["selectionRound"],
                  jobBindingHash=bytes(closed_job["job_binding_hash"]).hex(),
                  bidsetRoot=bytes(closed_job["bidset_root"]).hex(),
                  selectedExecutor=prepared.intent["roster"][buyer[1] - 1] if buyer[0] else None,
                  registryCodecBindingVerified=True, chainFinalityVerified=False,
                  durableSelectionReplayGuard=False)
    return result


def run_prepared(prepared, closed_job, *, timeout=600, port=17400):
    """Orchestrator spelling; identical to run_selection (winner IDs 1..3)."""
    return run_selection(prepared, closed_job, timeout=timeout, port=port)
