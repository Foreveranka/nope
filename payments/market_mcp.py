"""Authenticated Streamable HTTP JSON MCP: discovery, reads and local plans only.

Read/prepare methods never dispatch financial tools. An explicit gated dispatcher
can use /mcp/pro; neither endpoint performs registration or token issuance here.
JSON and bounded SSE JSON-RPC responses are supported; prose is never a result.
"""
import copy
import uuid
from .http import HTTPS
from .mcp import MCPBoundary
from .model import Conflict, PaymentError, Unsupported

READ_NAMES = frozenset(('marketplace__whoami', 'marketplace__browse_agents',
    'marketplace__get_agent', 'marketplace__get_job', 'marketplace__get_job_status',
    'marketplace__get_job_result', 'marketplace__get_draft_status',
    'marketplace__list_my_jobs', 'marketplace__list_bids', 'marketplace__list_my_assignments',
    'marketplace__list_my_bids'))
PLAN_NAMES = frozenset(('marketplace__prepare_job', 'marketplace__award_bid',
                       'marketplace__accept_result'))
PROTOCOL = '2025-03-26'


class MarketMCPTransport:
    """Implements AuthenticatedMCPTransport using injected, refreshable credentials.

    One account per instance. The local principal assertion must additionally be
    checked against reviewed whoami output by the caller; it is not OAuth proof.
    Endpoint is pinned to /mcp or /mcp/pro; preparation requires /mcp.
    """
    def __init__(self, credential_provider, principal, timeout=10, endpoint='/mcp'):
        if endpoint not in ('/mcp', '/mcp/pro'):
            raise Unsupported('only official MCP endpoints are allowed')
        self.endpoint = endpoint
        self.principal = principal
        self.http = HTTPS(credential_provider, timeout)
        self.authenticated = False
        self.server_info, self.protocol_version = {}, ''
        self.session = None
        self.scope = {'job_ids': frozenset(), 'assignment_ids': frozenset()}

    def _rpc(self, method, params=None, notification=False):
        request_id = str(uuid.uuid4())
        body = {'jsonrpc': '2.0', 'method': method}
        if params is not None:
            body['params'] = params
        if not notification:
            body['id'] = request_id
        headers = {}
        if self.protocol_version:
            headers['MCP-Protocol-Version'] = self.protocol_version
        if self.session:
            headers['Mcp-Session-Id'] = self.session
        status, value, response_headers = self.http.json('POST', self.endpoint, body, role='buyer_mcp',
                                                        principal=self.principal, headers=headers)
        session = response_headers.get('Mcp-Session-Id')
        if session:
            if self.session and session != self.session:
                raise Conflict('MCP session changed unexpectedly')
            if not isinstance(session, str) or not 1 <= len(session) <= 512 or any(ord(c) < 33 or ord(c) > 126 for c in session):
                raise PaymentError('invalid MCP session id')
            self.session = session
        if notification:
            if status not in (200, 202, 204):
                raise PaymentError('MCP notification refused')
            return None
        if (status != 200 or not isinstance(value, dict) or value.get('jsonrpc') != '2.0'
                or value.get('id') != request_id or ('result' in value) == ('error' in value)):
            raise PaymentError('invalid MCP response envelope or request correlation')
        if 'error' in value:
            raise PaymentError('MCP protocol error; response details redacted')
        if not isinstance(value['result'], dict):
            raise PaymentError('MCP object result required')
        return value['result']

    def initialize(self):
        # Reset identity before network access; failed renegotiation cannot reuse it.
        self.authenticated, self.server_info, self.protocol_version = False, {}, ''
        self.session = None
        result = self._rpc('initialize', {'protocolVersion': PROTOCOL, 'capabilities': {},
                                         'clientInfo': {'name': 'veil-payments-read-prepare', 'version': '1.0.0'}})
        info, capabilities = result.get('serverInfo'), result.get('capabilities')
        if (result.get('protocolVersion') != PROTOCOL or not isinstance(info, dict)
                or not isinstance(info.get('name'), str) or not info['name']
                or not isinstance(info.get('version'), str) or not info['version']
                or not isinstance(capabilities, dict) or not isinstance(capabilities.get('tools'), dict)):
            raise Unsupported('MCP negotiation or tool capability unsupported')
        self.server_info, self.protocol_version = copy.deepcopy(info), PROTOCOL
        self._rpc('notifications/initialized', notification=True)
        self.authenticated = True
        return {'serverInfo': copy.deepcopy(info), 'protocolVersion': PROTOCOL}

    def list_tools(self, cursor=None):
        if self.authenticated is not True:
            raise Unsupported('initialize authenticated MCP first')
        return self._rpc('tools/list', {} if cursor is None else {'cursor': cursor})

    def prepare_tool(self, arguments):
        if self.authenticated is not True or self.endpoint != '/mcp':
            raise Unsupported('draft preparation requires authenticated standard /mcp')
        # The standard endpoint saves a draft; never invoke /mcp/pro/create_job.
        return self._rpc('tools/call', {'name': 'marketplace__prepare_job',
                                        'arguments': copy.deepcopy(arguments)})

    def call_financial_tool(self, name, arguments):
        # Only FinancialWriteAdapter invokes this after capability, role, budget,
        # schema and durable reservation gates. Not called by read/prepare APIs.
        if self.authenticated is not True or self.endpoint != '/mcp/pro' or name not in ('marketplace__award_bid', 'marketplace__accept_result'):
            raise Unsupported('financial tool requires authenticated /mcp/pro buyer transport')
        return self._rpc('tools/call', {'name': name, 'arguments': copy.deepcopy(arguments)})

    def call_tool(self, name, arguments):
        if self.authenticated is not True or name not in READ_NAMES:
            raise Unsupported('only authenticated reviewed read tools can be dispatched')
        if name in ('marketplace__get_job', 'marketplace__get_job_status', 'marketplace__get_job_result', 'marketplace__list_bids'):
            if arguments.get('job_id') not in self.scope['job_ids']:
                raise Unsupported('MCP job outside explicit local resource scope')
        if 'assignment_id' in arguments and arguments['assignment_id'] not in self.scope['assignment_ids']:
            raise Unsupported('MCP assignment outside explicit local resource scope')
        return self._rpc('tools/call', {'name': name, 'arguments': copy.deepcopy(arguments)})


class MarketMCP(MCPBoundary):
    """Exact tools/list input AND output schemas required; no REST projection.

    Never persists raw responses or OAuth material. Caller owns identity checking,
    refresh and principal-specific reviewed pins; discovery is not authorization.
    """
    def __init__(self, transport, reviewed_pins=None, job_ids=(), assignment_ids=(), identity_resolver=None):
        super().__init__(transport, reviewed_pins)
        self.identity_resolver = identity_resolver
        transport.scope = {'job_ids': frozenset(job_ids), 'assignment_ids': frozenset(assignment_ids)}

    def read_tool(self, name, arguments):
        if name not in READ_NAMES:
            raise Unsupported('not an allowlisted Market read tool')
        from .schema import validate
        tool = self._tool(name)
        validate(arguments, tool['inputSchema'])
        result = self.transport.call_tool(name, copy.deepcopy(arguments))
        if not isinstance(result, dict) or result.get('isError', False) is not False or 'structuredContent' not in result:
            raise Unsupported('validated structuredContent required; text and links are not confirmations')
        validate(result['structuredContent'], tool['outputSchema'])
        return copy.deepcopy(result['structuredContent'])

    def plan_tool(self, name, arguments):
        if name not in PLAN_NAMES:
            raise Unsupported('only hire/award/accept preparation is supported')
        plan = super().plan_tool(name, arguments)
        if name == 'marketplace__prepare_job':
            request_id = arguments.get('client_request_id')
            if not isinstance(request_id, str) or not 1 <= len(request_id) <= 128:
                raise PaymentError('stable client_request_id required for draft preparation')
            if arguments.get('token') != 'USDC':
                raise Unsupported('explicit USDC required; no rail default')
        if name in ('marketplace__award_bid', 'marketplace__accept_result'):
            if arguments.get('job_id') not in self.transport.scope['job_ids']:
                raise Unsupported('job outside explicit MCP resource scope')
        if 'assignment_id' in arguments and arguments['assignment_id'] not in self.transport.scope['assignment_ids']:
            raise Unsupported('assignment outside explicit MCP resource scope')
        plan.update(endpoint='https://market.near.ai/mcp', dispatch_allowed=False,
                    financial_mutation=False, remote_call_performed=False,
                    warning='Only a local plan; /mcp links require website approval; /mcp/pro moves funds')
        return plan


    def prepare_hire(self, db_path, operation_id, arguments, reconcile=False):
        """Optionally save a real nonfinancial draft, with exact-key recovery.

        Only this method can dispatch prepare_job. It never approves the draft.
        Requires current discovered+reviewed schemas and whoami identity extraction.
        Caller re-supplies the original brief after restart; only hashes are stored.
        A repeated known ID is local replay, not another remote call. UNKNOWN is
        retried only by explicit reconcile=True, using the SAME documented draft
        client_request_id, input hash, principal and schema hash. Not for money.
        """
        from .model import digest, identifier
        from .schema import validate
        from .storage import Database
        identifier(operation_id)
        if self.transport.endpoint != '/mcp':
            raise Unsupported('prepare_job is only supported on standard /mcp')
        if type(reconcile) is not bool:
            raise PaymentError('reconcile must be boolean')
        if self.identity_resolver is None:
            raise Unsupported('reviewed whoami identity resolver required before remote draft preparation')
        plan = self.plan_tool('marketplace__prepare_job', arguments)
        if arguments['client_request_id'] != operation_id:
            raise Conflict('draft client_request_id must equal stable local operation id')
        identity = self.read_tool('marketplace__whoami', {})
        try:
            actual_principal = self.identity_resolver(copy.deepcopy(identity))
        except Exception:
            raise Conflict('whoami principal could not be verified') from None
        if actual_principal != self.transport.principal:
            raise Conflict('authenticated whoami differs from configured buyer principal')
        fingerprint = digest({'identity': self.manifest['identity'], 'tool': plan['schemaHash'],
                              'arguments': arguments, 'operation_id': operation_id})
        db = Database(db_path, """
        CREATE TABLE IF NOT EXISTS market_draft_preparations (
          operation_id TEXT PRIMARY KEY, request_hash TEXT NOT NULL,
          state TEXT NOT NULL, response_hash TEXT
        );
        """)
        # Do not hold the DB transaction across a network call. 'sent' survives
        # a process crash. Concurrent reconciles never race an active sent call.
        with db.transaction() as conn:
            old = conn.execute('SELECT * FROM market_draft_preparations WHERE operation_id=?', (operation_id,)).fetchone()
            if old:
                if old['request_hash'] != fingerprint:
                    raise Conflict('draft key, arguments, identity or reviewed schema changed')
                if old['state'] == 'observed' or not reconcile or old['state'] == 'sent':
                    return {'operation_id': operation_id, 'state': old['state'],
                            'response_sha256': old['response_hash'], 'remote_call_performed': False}
                conn.execute("UPDATE market_draft_preparations SET state='sent' WHERE operation_id=?", (operation_id,))
            else:
                conn.execute('INSERT INTO market_draft_preparations VALUES (?,?,?,NULL)', (operation_id, fingerprint, 'sent'))
        try:
            result = self.transport.prepare_tool(copy.deepcopy(arguments))
            tool = self._tool('marketplace__prepare_job')
            if (not isinstance(result, dict) or result.get('isError', False) is not False
                    or 'structuredContent' not in result):
                raise Unsupported('draft result lacks validated structured output')
            validate(result['structuredContent'], tool['outputSchema'])
            content = result['structuredContent']
            response_hash = digest(content)
        except Exception:
            with db.transaction() as conn:
                conn.execute("UPDATE market_draft_preparations SET state='unknown' WHERE operation_id=?", (operation_id,))
            return {'operation_id': operation_id, 'state': 'unknown', 'financial_confirmation': False,
                    'remote_call_performed': True, 'retry_requires_exact_draft_reconciliation': True}
        with db.transaction() as conn:
            conn.execute("UPDATE market_draft_preparations SET state='observed',response_hash=? WHERE operation_id=?", (response_hash, operation_id))
        return {'operation_id': operation_id, 'state': 'observed', 'result': copy.deepcopy(content),
                'response_sha256': response_hash, 'remote_call_performed': True,
                'financial_confirmation': False}

    @staticmethod
    def recover_crashed_draft(db_path, operation_id):
        """Operator recovery after ensuring the original process has stopped.

        Does not dispatch, clear ownership or use a new ID. Caller may subsequently
        call prepare_hire(reconcile=True) with the exact original payload. Unlike
        financial writes, the official draft API documents same-key replay.
        """
        from .storage import Database
        from .model import identifier
        identifier(operation_id)
        db = Database(db_path, '')
        with db.transaction() as conn:
            old = conn.execute('SELECT * FROM market_draft_preparations WHERE operation_id=?', (operation_id,)).fetchone()
            if old is None:
                raise Conflict('no prior draft preparation')
            conn.execute("UPDATE market_draft_preparations SET state='unknown' WHERE operation_id=? AND state='sent'", (operation_id,))
        return {'operation_id': operation_id, 'financial_confirmation': False}
