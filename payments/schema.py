"""Fail-closed JSON Schema subset for injected MCP contracts, not a full engine.

Unsupported validation keywords, remote refs and recursive refs block the tool.
There is no fallback that silently treats an unknown keyword as validated.
"""
import datetime
import math
import re
import uuid
from urllib.parse import urlsplit
from .model import PaymentError, Unsupported, canonical

ANNOTATIONS = {"title", "description", "default", "examples", "$comment", "$schema", "deprecated", "readOnly", "writeOnly"}
KEYWORDS = {"type", "properties", "required", "additionalProperties", "items", "enum", "const",
            "minimum", "maximum", "exclusiveMinimum", "exclusiveMaximum", "minLength", "maxLength",
            "minItems", "maxItems", "uniqueItems", "pattern", "format", "allOf", "anyOf", "oneOf",
            "$defs", "definitions", "$ref"} | ANNOTATIONS
TYPES = {"object", "array", "string", "integer", "number", "boolean", "null"}


def _ref(root, reference):
    if not isinstance(reference, str) or not reference.startswith("#/"):
        raise Unsupported("only local JSON Schema references are supported")
    value = root
    try:
        for key in reference[2:].split("/"):
            value = value[key.replace("~1", "/").replace("~0", "~")]
    except (KeyError, TypeError):
        raise Unsupported("unresolved JSON Schema reference")
    return value


def check_schema(schema, root=None, seen=(), depth=0):
    if type(schema) is bool:
        return
    if not isinstance(schema, dict) or depth > 64:
        raise Unsupported("invalid or excessively nested schema")
    root = schema if root is None else root
    unknown = set(schema) - KEYWORDS
    if unknown:
        raise Unsupported("unsupported JSON Schema keywords: " + ",".join(sorted(unknown)))
    if "$ref" in schema:
        reference = schema["$ref"]
        if reference in seen:
            raise Unsupported("recursive JSON Schema references are not supported")
        check_schema(_ref(root, reference), root, seen + (reference,), depth + 1)
    if "type" in schema:
        types = schema["type"] if isinstance(schema["type"], list) else [schema["type"]]
        if not types or any(not isinstance(t, str) or t not in TYPES for t in types) or len(set(types)) != len(types):
            raise Unsupported("invalid schema type")
    for key in ("properties", "$defs", "definitions"):
        if key in schema:
            if not isinstance(schema[key], dict):
                raise Unsupported("invalid schema map")
            for child in schema[key].values():
                check_schema(child, root, seen, depth + 1)
    for key in ("items", "additionalProperties"):
        if key in schema:
            check_schema(schema[key], root, seen, depth + 1)
    for key in ("allOf", "anyOf", "oneOf"):
        if key in schema:
            if not isinstance(schema[key], list) or not schema[key]:
                raise Unsupported("invalid schema alternatives")
            for child in schema[key]:
                check_schema(child, root, seen, depth + 1)
    if "required" in schema and (not isinstance(schema["required"], list) or any(not isinstance(k, str) for k in schema["required"]) or len(set(schema["required"])) != len(schema["required"])):
        raise Unsupported("invalid required list")
    for key in ("minLength", "maxLength", "minItems", "maxItems"):
        if key in schema and (type(schema[key]) is not int or schema[key] < 0):
            raise Unsupported("invalid schema length bound")
    for key in ("minimum", "maximum", "exclusiveMinimum", "exclusiveMaximum"):
        if key in schema and (type(schema[key]) not in (int, float) or not math.isfinite(schema[key])):
            raise Unsupported("invalid schema number bound")
    if "enum" in schema and (not isinstance(schema["enum"], list) or not schema["enum"]):
        raise Unsupported("invalid schema enum")
    if "uniqueItems" in schema and type(schema["uniqueItems"]) is not bool:
        raise Unsupported("invalid uniqueItems")
    if "pattern" in schema:
        if not isinstance(schema["pattern"], str) or len(schema["pattern"]) > 512:
            raise Unsupported("unsupported schema pattern")
        try:
            re.compile(schema["pattern"])
        except re.error as exc:
            raise Unsupported("invalid schema pattern") from exc
    if "format" in schema and schema["format"] not in ("uuid", "date-time", "uri"):
        raise Unsupported("unsupported schema format")


def _matches_type(value, name):
    return {"object": lambda: isinstance(value, dict),
            "array": lambda: isinstance(value, list),
            "string": lambda: isinstance(value, str),
            "integer": lambda: type(value) is int,
            "number": lambda: type(value) in (int, float) and math.isfinite(value),
            "boolean": lambda: type(value) is bool,
            "null": lambda: value is None}[name]()


def validate(value, schema, root=None, depth=0):
    root = schema if root is None else root
    if depth == 0:
        check_schema(schema)
        try:
            canonical(value)  # refuse non-JSON, NaN and infinities
        except (ValueError, TypeError):
            raise PaymentError("tool payload is not finite JSON")
    if depth > 128:
        raise PaymentError("tool payload too deeply nested")
    if schema is True:
        return
    if schema is False:
        raise PaymentError("schema forbids this payload")
    if "$ref" in schema:
        validate(value, _ref(root, schema["$ref"]), root, depth + 1)
    types = schema.get("type", [])
    types = [types] if isinstance(types, str) else types
    if types and not any(_matches_type(value, name) for name in types):
        raise PaymentError("tool payload has wrong type")
    if "enum" in schema and not any(canonical(value) == canonical(v) for v in schema["enum"]):
        raise PaymentError("tool payload enum mismatch")
    if "const" in schema and canonical(value) != canonical(schema["const"]):
        raise PaymentError("tool payload const mismatch")
    for key in ("allOf", "anyOf", "oneOf"):
        if key in schema:
            count = 0
            for child in schema[key]:
                try:
                    validate(value, child, root, depth + 1)
                    count += 1
                except PaymentError:
                    pass
            if (key == "allOf" and count != len(schema[key])) or (key == "anyOf" and count == 0) or (key == "oneOf" and count != 1):
                raise PaymentError("tool payload alternatives mismatch")
    if isinstance(value, dict):
        if any(not isinstance(k, str) for k in value):
            raise PaymentError("object keys must be strings")
        if not set(schema.get("required", [])).issubset(value):
            raise PaymentError("tool payload missing required property")
        properties = schema.get("properties", {})
        for key, child in value.items():
            validate(child, properties.get(key, schema.get("additionalProperties", True)), root, depth + 1)
    if isinstance(value, list):
        if not schema.get("minItems", 0) <= len(value) <= schema.get("maxItems", len(value)):
            raise PaymentError("tool payload array length mismatch")
        if schema.get("uniqueItems") and len({canonical(v) for v in value}) != len(value):
            raise PaymentError("tool payload array not unique")
        for child in value:
            validate(child, schema.get("items", True), root, depth + 1)
    if isinstance(value, str):
        if not schema.get("minLength", 0) <= len(value) <= schema.get("maxLength", len(value)):
            raise PaymentError("tool payload string length mismatch")
        if "pattern" in schema and re.search(schema["pattern"], value) is None:
            raise PaymentError("tool payload pattern mismatch")
        try:
            if schema.get("format") == "uuid":
                if str(uuid.UUID(value)) != value.lower():
                    raise ValueError()
            if schema.get("format") == "date-time":
                parsed = datetime.datetime.fromisoformat(value.replace("Z", "+00:00"))
                if parsed.tzinfo is None:
                    raise ValueError()
            if schema.get("format") == "uri" and not urlsplit(value).scheme:
                raise ValueError()
        except ValueError:
            raise PaymentError("tool payload format mismatch")
    if type(value) in (int, float):
        if ("minimum" in schema and value < schema["minimum"]) or ("maximum" in schema and value > schema["maximum"]) or ("exclusiveMinimum" in schema and value <= schema["exclusiveMinimum"]) or ("exclusiveMaximum" in schema and value >= schema["exclusiveMaximum"]):
            raise PaymentError("tool payload number out of bounds")
