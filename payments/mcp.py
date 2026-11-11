"""Injected MCP discovery/schema boundary. No OAuth, HTTP or write dispatcher.

Tool schemas come from tools/list, never from guessed REST-to-MCP conversion.
Plans are local data; a plan is not authorization to execute it.
"""
import copy
import datetime
from .model import Conflict, PaymentError, Unsupported, digest
from .schema import check_schema, validate

# Names documented by NEAR Agent Market. No account calls are made by discovery
# tests; a future caller must separately authorize read access to its own account.
READ_TOOLS = frozenset({"marketplace__get_job", "marketplace__get_job_status",
                        "marketplace__get_job_result", "marketplace__list_my_assignments",
                        "marketplace__list_my_jobs", "marketplace__list_my_bids"})
LIVE_GAPS = (
    "Live mutations are disabled by this build and current authorization.",
    "Capture negotiated server/protocol/principal metadata and exact tools/list schemas; pin reviewed schema hashes.",
    "Verify private job creation/first supplier participation without public fallback.",
    "Verify exact-price award, assignment identity and assignment-linked confirmed financial evidence.",
    "Verify atomic expected-version/hash acceptance; pre/post reads alone leave a race.",
    "Market accept can release funds in one call; do not invent a separate remote release endpoint.",
    "Verify dispute opening, private evidence, auto-accept deadline and refund/split financial reconciliation.",
    "Verify missing-response recovery; MCP request IDs do not establish remote idempotency.",
)


class MCPBoundary:
    def __init__(self, transport, reviewed_pins=None):
        self.transport = transport
        self.pins = copy.deepcopy(reviewed_pins or {})
        self.tools = {}
        self.manifest = None

    def _identity(self):
        t = self.transport
        if t.authenticated is not True or not isinstance(t.principal, str) or not t.principal:
            raise Unsupported("injected transport must attest authenticated principal")
        if not isinstance(t.server_info, dict) or not t.server_info.get("name") or not t.server_info.get("version") or not isinstance(t.protocol_version, str) or not t.protocol_version:
            raise Unsupported("negotiated server name/version and protocol version required")
        return {"serverInfo": copy.deepcopy(t.server_info), "protocolVersion": t.protocol_version,
                "principalHash": digest(t.principal)}

    def discover(self):
        identity = self._identity()
        tools, cursor, seen = {}, None, set()
        for _ in range(100):
            page = self.transport.list_tools(cursor)
            if not isinstance(page, dict) or not isinstance(page.get("tools"), list):
                raise PaymentError("invalid tools/list response")
            for tool in page["tools"]:
                if not isinstance(tool, dict) or not isinstance(tool.get("name"), str) or not tool["name"] or "inputSchema" not in tool or tool["name"] in tools:
                    raise PaymentError("invalid or duplicated MCP tool")
                tools[tool["name"]] = copy.deepcopy(tool)
                if len(tools) > 1000:
                    raise Unsupported("tool discovery exceeds local limit")
            cursor = page.get("nextCursor")
            if cursor is None:
                break
            if not isinstance(cursor, str) or not cursor or cursor in seen:
                raise Conflict("invalid/repeating tools/list cursor")
            seen.add(cursor)
        else:
            raise Unsupported("tools/list pagination limit exceeded")
        hashes = {name: self.fingerprint(tool) for name, tool in tools.items()}
        if self.manifest and (identity != self.manifest["identity"] or hashes != self.manifest["toolSchemaHashes"]):
            self.tools = {}
            raise Conflict("MCP identity/schema drift; review and repin before use")
        self.tools = tools
        self.manifest = {"identity": identity, "toolSchemaHashes": hashes,
                         "capturedAt": datetime.datetime.now(datetime.timezone.utc).isoformat(),
                         "liveMutationEnabled": False}
        return copy.deepcopy(self.manifest)

    @staticmethod
    def fingerprint(tool):
        return digest({"name": tool["name"], "inputSchema": tool["inputSchema"],
                       "outputSchema": tool.get("outputSchema")})

    def _tool(self, name):
        if self.manifest is None or self._identity() != self.manifest["identity"]:
            raise Unsupported("discover tools for this authenticated identity first")
        tool = self.tools.get(name)
        if tool is None:
            raise Unsupported("tool absent from discovered schema: " + name)
        if self.pins.get(name) != self.fingerprint(tool):
            raise Unsupported("review and pin exact discovered input/output schemas: " + name)
        check_schema(tool["inputSchema"])
        if tool.get("outputSchema") is None:
            raise Unsupported("validated structured output schema required: " + name)
        check_schema(tool["outputSchema"])
        return tool

    def plan_tool(self, name, arguments):
        tool = self._tool(name)
        validate(arguments, tool["inputSchema"])
        return {"kind": "local_plan_only", "tool": name,
                "arguments": copy.deepcopy(arguments), "schemaHash": self.fingerprint(tool),
                "liveMutationEnabled": False, "gaps": list(LIVE_GAPS)}

    def read_tool(self, name, arguments):
        if name not in READ_TOOLS:
            raise Unsupported("tool is not on the explicit read-only allowlist")
        tool = self._tool(name)
        validate(arguments, tool["inputSchema"])
        result = self.transport.call_tool(name, copy.deepcopy(arguments))
        if not isinstance(result, dict) or result.get("isError", False) is not False:
            raise PaymentError("MCP tool error; not payment confirmation")
        if "structuredContent" not in result:
            raise Unsupported("structuredContent required; no guessed parsing of text or approval links")
        validate(result["structuredContent"], tool["outputSchema"])
        return copy.deepcopy(result["structuredContent"])


class BlockedLiveRail:
    mode = "live_blocked"

    def __init__(self, boundary=None):
        self.boundary = boundary

    def capabilities(self):
        return {"mode": self.mode, "live_payments": False, "gaps": list(LIVE_GAPS)}

    def execute(self, command):
        raise Unsupported("live mutation blocked; " + " ".join(LIVE_GAPS))

    def inspect(self, binding):
        raise Unsupported("no verified assignment/financial schema mapping; see payments/LIVE-GAPS.md")

    def lookup(self, command):
        raise Unsupported("no verified remote operation recovery mapping; see payments/LIVE-GAPS.md")
