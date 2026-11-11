"""Public codec and synthetic-test oracle; never an MPC substitute."""
import hashlib
import json

UPSTREAM = "cd4d517a8a37b266d7233ae412717ca181cec6bf"
MAX_AMOUNT = 10**12
DOMAIN = b"VEIL-MPC-v1\x00"
PROFILE = "sealed-cheapest-3-spdz2k-v1"


def canonical(value):
    return json.dumps(value, sort_keys=True, separators=(",", ":"),
                      ensure_ascii=True, allow_nan=False).encode("ascii")


def digest(value):
    return hashlib.sha256(canonical(value)).hexdigest()


def integer(value, low, high, name="amount"):
    if type(value) is not int or not low <= value <= high:
        raise ValueError("invalid " + name)
    return value


def validate_descriptor(d):
    if set(d) != {"profile", "job", "attempt", "qualified", "fixedFee", "upstream"}:
        raise ValueError("descriptor schema")
    if d["profile"] != PROFILE or d["upstream"] != UPSTREAM:
        raise ValueError("unsupported profile/build")
    for key in ("job", "attempt"):
        if not isinstance(d[key], str) or len(d[key]) != 64 or d[key] != d[key].lower():
            raise ValueError("invalid context")
        try:
            if bytes.fromhex(d[key]).hex() != d[key]:
                raise ValueError()
        except ValueError:
            raise ValueError("invalid context") from None
    if not isinstance(d["qualified"], list) or len(d["qualified"]) != 3 or any(
            type(x) is not bool for x in d["qualified"]):
        raise ValueError("three public qualification flags required")
    integer(d["fixedFee"], 0, MAX_AMOUNT, "fixed fee")
    return d


def commitment(descriptor, client_id, amount, salt):
    """C0=budget, C1..C3=slot0..2. Fixed uint64 big-endian, salt32."""
    validate_descriptor(descriptor)
    integer(client_id, 0, 3, "client id")
    integer(amount, 0 if client_id == 0 else 1, MAX_AMOUNT)
    if not isinstance(salt, bytes) or len(salt) != 32:
        raise ValueError("salt must be 32 bytes")
    return hashlib.sha256(DOMAIN + bytes.fromhex(digest(descriptor)) +
                          bytes([client_id]) + amount.to_bytes(8, "big") + salt).hexdigest()


def validate_manifest(m):
    if set(m) != {"descriptor", "commitments"}:
        raise ValueError("manifest schema")
    validate_descriptor(m["descriptor"])
    if not isinstance(m["commitments"], list) or len(m["commitments"]) != 4:
        raise ValueError("four commitments required")
    for c in m["commitments"]:
        if not isinstance(c, str) or len(c) != 64 or c != c.lower():
            raise ValueError("noncanonical digest")
        try:
            if bytes.fromhex(c).hex() != c:
                raise ValueError()
        except ValueError:
            raise ValueError("invalid digest") from None
    return m


def reference(budget, prices, qualified=(True, True, True), fixed_fee=0):
    integer(budget, 0, MAX_AMOUNT, "budget")
    integer(fixed_fee, 0, MAX_AMOUNT, "fixed fee")
    if len(prices) != 3 or len(qualified) != 3 or any(type(x) is not bool for x in qualified):
        raise ValueError("three prices and public qualification flags required")
    for price in prices:
        integer(price, 1, MAX_AMOUNT, "price")
    eligible = [(p, i) for i, p in enumerate(prices)
                if qualified[i] and p + fixed_fee <= budget]
    if not eligible:
        return {"buyer": [0, 0, 0, 0], "providers": [[0, 0] for _ in prices]}
    price, slot = min(eligible)
    return {"buyer": [1, slot + 1, price, price + fixed_fee],
            "providers": [[1, price] if i == slot else [0, 0] for i in range(3)]}
