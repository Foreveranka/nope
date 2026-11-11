import copy
import unittest
from payments.mcp import BlockedLiveRail, MCPBoundary
from payments.model import Conflict, PaymentError, Unsupported
from payments.schema import check_schema, validate

READ = "marketplace__get_job_status"
WRITE = "marketplace__accept_result"


def tool(name=READ):
    # Explicitly synthetic schemas. They are not assertions about Market wire.
    return {"name": name, "inputSchema": {"type": "object", "required": ["fixture_job_id"],
            "properties": {"fixture_job_id": {"type": "string", "minLength": 1}}, "additionalProperties": False},
            "outputSchema": {"type": "object", "required": ["fixture_status"],
            "properties": {"fixture_status": {"enum": ["submitted", "disputed"]}}, "additionalProperties": False}}


class FakeTransport:
    authenticated = True
    principal = "synthetic-buyer"
    server_info = {"name": "synthetic-market-mcp", "version": "fixture-1"}
    protocol_version = "2025-06-18"

    def __init__(self):
        self.pages = [{"tools": [tool()], "nextCursor": "page-2"}, {"tools": [tool(WRITE)]}]
        self.calls = []
        self.lists = []
        self.response = {"isError": False, "structuredContent": {"fixture_status": "submitted"}}

    def list_tools(self, cursor=None):
        self.lists.append(cursor)
        return copy.deepcopy(self.pages[0 if cursor is None else 1])

    def call_tool(self, name, arguments):
        self.calls.append((name, arguments))
        return copy.deepcopy(self.response)


class MCPTests(unittest.TestCase):
    def setUp(self):
        self.transport = FakeTransport()
        self.boundary = MCPBoundary(self.transport, {READ: MCPBoundary.fingerprint(tool()), WRITE: MCPBoundary.fingerprint(tool(WRITE))})

    def test_discovery_pagination_pins_and_validated_read(self):
        manifest = self.boundary.discover()
        self.assertEqual(self.transport.lists, [None, "page-2"])
        self.assertFalse(manifest["liveMutationEnabled"])
        self.assertNotIn("synthetic-buyer", str(manifest))
        self.assertEqual(self.boundary.read_tool(READ, {"fixture_job_id": "job1"}), {"fixture_status": "submitted"})
        self.assertEqual(len(self.transport.calls), 1)

    def test_no_mutation_via_read_path_or_live_rail(self):
        self.boundary.discover()
        with self.assertRaises(Unsupported):
            self.boundary.read_tool(WRITE, {"fixture_job_id": "job1"})
        plan = self.boundary.plan_tool(WRITE, {"fixture_job_id": "job1"})
        self.assertEqual(plan["kind"], "local_plan_only")
        self.assertFalse(plan["liveMutationEnabled"])
        self.assertTrue(plan["gaps"])
        self.assertEqual(self.transport.calls, [])
        with self.assertRaises(Unsupported):
            BlockedLiveRail(self.boundary).execute(None)
        self.assertEqual(self.transport.calls, [])

    def test_no_implicit_trust_on_first_discovery(self):
        boundary = MCPBoundary(self.transport)
        boundary.discover()
        with self.assertRaises(Unsupported):
            boundary.read_tool(READ, {"fixture_job_id": "job1"})
        self.assertEqual(self.transport.calls, [])

    def test_input_must_match_exact_discovered_schema(self):
        self.boundary.discover()
        for value in [{"job_id": "guessed"}, {"fixture_job_id": 1}, {}, {"fixture_job_id": "x", "auto_accept": True}]:
            with self.subTest(value=value), self.assertRaises(PaymentError):
                self.boundary.read_tool(READ, value)
        self.assertEqual(self.transport.calls, [])

    def test_output_error_unknown_enum_missing_output_and_link_not_success(self):
        self.boundary.discover()
        for response in [{"isError": True, "structuredContent": {"fixture_status": "submitted"}},
                         {"structuredContent": {"fixture_status": "released"}},
                         {"structuredContent": {"approval_url": "https://example.invalid/approve"}},
                         {"content": [{"type": "text", "text": "payment successful"}]},
                         {"isError": "false", "structuredContent": {"fixture_status": "submitted"}}]:
            self.transport.response = response
            with self.subTest(response=response), self.assertRaises(PaymentError):
                self.boundary.read_tool(READ, {"fixture_job_id": "x"})

    def test_unknown_schema_keywords_block_instead_of_partial_validation(self):
        self.transport.pages[0]["tools"][0]["inputSchema"]["dependentRequired"] = {"fixture_job_id": ["guard"]}
        updated = self.transport.pages[0]["tools"][0]
        self.boundary = MCPBoundary(self.transport, {READ: MCPBoundary.fingerprint(updated)})
        self.boundary.discover()
        with self.assertRaises(Unsupported):
            self.boundary.read_tool(READ, {"fixture_job_id": "x"})
        self.assertEqual(self.transport.calls, [])

    def test_schema_drift_and_identity_drift_disable_tools(self):
        self.boundary.discover()
        self.transport.pages[0]["tools"][0]["inputSchema"]["required"] = []
        with self.assertRaises(Conflict):
            self.boundary.discover()
        with self.assertRaises(Unsupported):
            self.boundary.read_tool(READ, {"fixture_job_id": "x"})
        self.transport.principal = "another-principal"
        with self.assertRaises(Unsupported):
            self.boundary.plan_tool(WRITE, {"fixture_job_id": "x"})
        self.assertEqual(self.transport.calls, [])

    def test_anonymous_transport_and_missing_negotiation_blocked(self):
        self.transport.authenticated = False
        with self.assertRaises(Unsupported):
            self.boundary.discover()
        self.transport.authenticated = True
        self.transport.server_info = {"name": "x"}
        with self.assertRaises(Unsupported):
            self.boundary.discover()
        self.assertEqual(self.transport.lists, [])

    def test_duplicate_tool_repeating_cursor_and_missing_output_schema_blocked(self):
        self.transport.pages[1]["tools"] = [tool()]
        with self.assertRaises(PaymentError):
            self.boundary.discover()
        self.transport.pages[1]["tools"] = []
        self.transport.pages[1]["nextCursor"] = "page-2"
        with self.assertRaises(Conflict):
            self.boundary.discover()
        self.transport.pages[1] = {"tools": []}
        self.transport.pages[0]["tools"][0].pop("outputSchema")
        self.boundary = MCPBoundary(self.transport, {READ: MCPBoundary.fingerprint(self.transport.pages[0]["tools"][0])})
        self.boundary.discover()
        with self.assertRaises(Unsupported):
            self.boundary.read_tool(READ, {"fixture_job_id": "x"})

    def test_local_ref_constraints_types_and_formats(self):
        schema = {"type": "object", "$defs": {"positive": {"type": "integer", "minimum": 1}},
                  "properties": {"n": {"$ref": "#/$defs/positive"}}, "required": ["n"], "additionalProperties": False}
        validate({"n": 1}, schema)
        for value in [{"n": True}, {"n": 1.0}, {"n": 0}]:
            with self.assertRaises(PaymentError):
                validate(value, schema)
        validate("2026-11-11T00:00:00Z", {"type": "string", "format": "date-time"})
        with self.assertRaises(PaymentError):
            validate("2026-11-11T00:00:00", {"format": "date-time"})
        for schema in [{"$ref": "https://example.invalid/schema"}, {"$defs": {"x": {"$ref": "#/$defs/x"}}},
                       {"format": "unknown"}, {"minItems": True}, {"type": "mystery"}]:
            with self.subTest(schema=schema), self.assertRaises(Unsupported):
                check_schema(schema)

    def test_alternatives_bounds_and_non_json_values(self):
        validate([1, 2], {"type": "array", "items": {"type": "integer"}, "uniqueItems": True, "minItems": 2, "maxItems": 2})
        for value in [[1, 1], [True, 2], [1], [1, 2, 3]]:
            with self.assertRaises(PaymentError):
                validate(value, {"type": "array", "items": {"type": "integer"}, "uniqueItems": True, "minItems": 2, "maxItems": 2})
        validate(2, {"allOf": [{"type": "integer"}, {"minimum": 1}], "anyOf": [{"const": 2}, {"const": 3}]})
        with self.assertRaises(PaymentError):
            validate(2, {"oneOf": [{"type": "integer"}, {"type": "number"}]})
        with self.assertRaises(PaymentError):
            validate(float("nan"), {"type": "number"})
        with self.assertRaises(PaymentError):
            validate(True, {"enum": [1]})


if __name__ == "__main__":
    unittest.main()
