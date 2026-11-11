"""Strict internal encoding; hashes bind local data, not remote authority."""
import hashlib
import json
import re
from dataclasses import asdict
from .interface import Action, Binding, Command, Delivery, Money, Observation, State


class PaymentError(ValueError):
    pass


class Conflict(PaymentError):
    pass


class Unsupported(PaymentError):
    pass


MAX_MICROS = 2**63 - 1


def integer(value, minimum=0, maximum=MAX_MICROS):
    if type(value) is not int or not minimum <= value <= maximum:
        raise PaymentError("expected bounded integer (not bool or float)")
    return value


def identifier(value):
    if not isinstance(value, str) or not re.fullmatch(r"[A-Za-z0-9_.:-]{1,128}", value):
        raise PaymentError("expected opaque identifier, 1..128 ASCII characters")
    return value


def hash32(value):
    if not isinstance(value, str) or not re.fullmatch(r"[0-9a-f]{64}", value):
        raise PaymentError("expected lowercase SHA-256 hex")
    return value


def money(value):
    if not isinstance(value, Money) or value.currency != "USDC" or type(value.scale) is not int or value.scale != 6:
        raise PaymentError("only USDC scale=6 is supported")
    integer(value.micros, 1)
    return value


def parse_usdc(text):
    """Allow harmless extra trailing zeros; never round, exponentiate or float."""
    if not isinstance(text, str) or len(text) > 100 or not re.fullmatch(r"(?:0|[1-9][0-9]*)(?:\.[0-9]+)?", text):
        raise PaymentError("expected unsigned decimal string")
    whole, _, fraction = text.partition(".")
    if any(c != "0" for c in fraction[6:]):
        raise PaymentError("sub-micro amount is not representable")
    return money(Money(int(whole) * 1000000 + int((fraction[:6] + "000000")[:6])))


def binding(value):
    if not isinstance(value, Binding):
        raise PaymentError("expected Binding")
    for key in ("context_hash", "terms_hash", "selection_hash"):
        hash32(getattr(value, key))
    for key in ("attempt_id", "job_id", "bid_id", "assignment_id", "worker_id"):
        identifier(getattr(value, key))
    money(value.price)
    return value


def delivery(value):
    if not isinstance(value, Delivery):
        raise PaymentError("expected versioned Delivery")
    integer(value.version, 1)
    hash32(value.artifact_sha256)
    hash32(value.receipt_sha256)
    return value


def canonical(value):
    return json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=True, allow_nan=False)


def digest(value):
    return hashlib.sha256(canonical(value).encode("ascii")).hexdigest()


def binding_hash(value):
    return digest({"domain": "veil-payment-binding-v1", "binding": asdict(binding(value))})


def load_binding(value):
    value = dict(value)
    value["price"] = Money(**value["price"])
    return binding(Binding(**value))


def load_delivery(value):
    return None if value is None else delivery(Delivery(**value))


def command_dict(value):
    identifier(value.operation_id)
    binding(value.binding)
    if type(value.action) is not Action:
        raise PaymentError("expected Action enum")
    integer(value.expected_revision)
    if value.delivery is not None:
        delivery(value.delivery)
    return asdict(value)


def load_command(value):
    return Command(value["operation_id"], Action(value["action"]),
                   load_binding(value["binding"]), load_delivery(value["delivery"]),
                   value["expected_revision"])


def observation_dict(value):
    if not isinstance(value, Observation) or type(value.state) is not State:
        raise PaymentError("invalid observation")
    binding(value.binding)
    integer(value.revision)
    identifier(value.evidence_id)
    if value.operation_id is not None:
        identifier(value.operation_id)
    if value.delivery is not None:
        delivery(value.delivery)
    return asdict(value)


def load_observation(value):
    result = Observation(load_binding(value["binding"]), State(value["state"]),
                         value["revision"], load_delivery(value["delivery"]),
                         value["evidence_id"], value["authority"], value.get("operation_id"))
    observation_dict(result)
    return result


TARGET = {Action.AWARD: State.AWARDED, Action.HOLD: State.HELD,
          Action.SUBMIT: State.SUBMITTED, Action.ACCEPT: State.ACCEPTED,
          Action.RELEASE: State.RELEASED, Action.REFUND: State.REFUNDED,
          Action.DISPUTE: State.DISPUTED}
ALLOWED = {Action.AWARD: {State.NEW}, Action.HOLD: {State.AWARDED},
           Action.SUBMIT: {State.HELD, State.SUBMITTED},
           Action.ACCEPT: {State.SUBMITTED}, Action.RELEASE: {State.ACCEPTED},
           Action.REFUND: {State.HELD},
           Action.DISPUTE: {State.SUBMITTED}}


def guard(action, state, previous_delivery, proposed_delivery):
    if type(action) is not Action or state not in ALLOWED[action]:
        raise Conflict("invalid state transition: %s -> %s" % (state.value, str(action)))
    if action == Action.SUBMIT:
        delivery(proposed_delivery)
        expected = 1 if previous_delivery is None else previous_delivery.version + 1
        if proposed_delivery.version != expected:
            raise Conflict("submission version must be exactly next version")
    elif action in (Action.ACCEPT, Action.RELEASE, Action.DISPUTE):
        delivery(proposed_delivery)
        if proposed_delivery != previous_delivery:
            raise Conflict("delivery version/artifact/receipt mismatch")
    elif proposed_delivery is not None:
        raise Conflict("this action must not include a delivery")
