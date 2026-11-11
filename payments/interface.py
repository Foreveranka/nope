"""Public, stdlib-only payment boundary. No credentials or network implementation.

Internal models are NOT Market wire schemas. Live writes remain disabled.
"""
from dataclasses import dataclass
from enum import Enum
from typing import Any, Dict, Optional, Protocol


class State(str, Enum):
    NEW = "new"
    AWARDED = "awarded"
    HELD = "held"
    SUBMITTED = "submitted"
    ACCEPTED = "accepted"
    RELEASED = "released"
    REFUNDED = "refunded"
    DISPUTED = "disputed"
    UNKNOWN = "unknown"


class Action(str, Enum):
    AWARD = "award"
    HOLD = "hold"
    SUBMIT = "submit"
    ACCEPT = "accept"
    RELEASE = "release"
    REFUND = "refund"
    DISPUTE = "dispute"


@dataclass(frozen=True)
class Money:
    """USDC only: an integer number of millionths, never a float."""
    micros: int
    currency: str = "USDC"
    scale: int = 6


@dataclass(frozen=True)
class Binding:
    context_hash: str
    attempt_id: str
    job_id: str
    bid_id: str
    assignment_id: str
    worker_id: str
    terms_hash: str
    selection_hash: str
    price: Money


@dataclass(frozen=True)
class Delivery:
    version: int
    artifact_sha256: str
    receipt_sha256: str


@dataclass(frozen=True)
class Command:
    operation_id: str
    action: Action
    binding: Binding
    delivery: Optional[Delivery] = None
    expected_revision: int = 0


@dataclass(frozen=True)
class Observation:
    binding: Binding
    state: State
    revision: int
    delivery: Optional[Delivery]
    evidence_id: str
    authority: str  # 'local_fixture_simulation', never a settlement proof
    operation_id: Optional[str] = None


class PaymentRail(Protocol):
    mode: str

    def execute(self, command: Command) -> Observation:
        """Mutate a rail. Only local fixture implements this in this build."""
        ...

    def inspect(self, binding: Binding) -> Observation:
        ...

    def lookup(self, command: Command) -> Optional[Observation]:
        """Read outcome of exact operation; absence does NOT authorize redispatch."""
        ...


class ArtifactVerifier(Protocol):
    def verify(self, binding: Binding, delivery: Delivery,
               artifact: bytes, receipt: bytes) -> bool:
        """Trusted local policy after hash checks, not a remote payment authority."""
        ...


class AuthenticatedMCPTransport(Protocol):
    """Caller owns auth/refresh; tokens must never enter this package's state."""
    authenticated: bool
    principal: str
    server_info: Dict[str, Any]
    protocol_version: str

    def list_tools(self, cursor: Optional[str] = None) -> Dict[str, Any]:
        ...

    def call_tool(self, name: str, arguments: Dict[str, Any]) -> Dict[str, Any]:
        ...
