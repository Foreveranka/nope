"""Capability-gated real /mcp/pro transport; NOT enabled by current API evidence.

No stock capability is supplied: current official schema/docs do not establish
atomic version/hash acceptance or enforced procurement bindings. Offline tests
use explicitly hypothetical advertised contracts to exercise the ready transport.
A schema property alone does NOT prove its enforcement semantics.
"""
from dataclasses import asdict, dataclass
from .interface import Action
from .model import Conflict, PaymentError, Unsupported, canonical, command_dict, digest, integer
from .schema import validate
from .storage import Database


@dataclass(frozen=True)
class WriteAuthorization:
    """Explicit caller authorization, never loaded from env or defaulted true.

    budget is a gross USDC cap including any allowed fees; no deposits, top-ups,
    dispute bonds, conversions or other rails are within this authorization.
    scope_id identifies ONE shared persistent aggregate budget, not each job.
    """
    approved: bool
    principal: str
    scope_id: str
    budget_micros: int
    binding_hash: str
    actions: tuple


@dataclass(frozen=True)
class ReviewedWriteCapability:
    """Operator-reviewed server enforcement, tied to exact discovered schemas.

    input_fields maps internal guard names to actual REQUIRED tool properties.
    output echoes are optional observations, never proof of financial settlement.
    semantics_source names the official evidence establishing enforcement. The
    current repo ships NONE: never populate this from a guessed property list.
    """
    tool: str
    schema_hash: str
    semantics_source: str
    atomic_compare_enforced: bool
    input_fields: dict
    output_fields: dict


DDL = '''
CREATE TABLE IF NOT EXISTS market_write_budgets (
 scope_id TEXT PRIMARY KEY, principal_hash TEXT NOT NULL, cap INTEGER NOT NULL, reserved INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS market_write_outbox (
 operation_id TEXT PRIMARY KEY, assignment_id TEXT NOT NULL, binding_hash TEXT NOT NULL,
 request_hash TEXT NOT NULL, scope_id TEXT NOT NULL, action TEXT NOT NULL,
 state TEXT NOT NULL, response_hash TEXT,
 FOREIGN KEY(scope_id) REFERENCES market_write_budgets(scope_id)
);
CREATE UNIQUE INDEX IF NOT EXISTS market_write_assignment_once
 ON market_write_outbox(assignment_id, action);
'''


class FinancialWriteAdapter:
    def __init__(self, db_path, market_mcp, preflight=None, artifact_verifier=None):
        self.db, self.market = Database(db_path, DDL), market_mcp
        self.preflight, self.artifact_verifier = preflight, artifact_verifier

    def perform(self, command, authorization, capability):
        """Single attempt after all gates; no implicit/repeated remote retries.

        HOLD and RELEASE do not have their own wire calls. Award funds escrow;
        accept may release it. Unknown outcomes retain budget + assignment lock.
        """
        from .model import binding_hash, identifier
        command_dict(command)
        if command.action not in (Action.AWARD, Action.ACCEPT):
            raise Unsupported('only award/accept have financial wire operations; no separate hold/release')
        bh = binding_hash(command.binding)
        if not isinstance(authorization, WriteAuthorization) or authorization.approved is not True:
            raise Unsupported('explicit caller write authorization required')
        identifier(authorization.scope_id)
        integer(authorization.budget_micros, 1)
        if (authorization.principal != self.market.transport.principal or authorization.binding_hash != bh
                or command.action not in authorization.actions or self.market.transport.endpoint != '/mcp/pro'):
            raise Unsupported('write principal, binding, action or endpoint outside authorization')
        tool_name = {Action.AWARD: 'marketplace__award_bid', Action.ACCEPT: 'marketplace__accept_result'}[command.action]
        if not isinstance(capability, ReviewedWriteCapability) or capability.tool != tool_name:
            raise Unsupported('reviewed server capability missing for this operation')
        if not capability.semantics_source.startswith(('https://market.near.ai/', 'https://docs.market.near.ai/')):
            raise Unsupported('official server enforcement evidence required')
        if command.action == Action.ACCEPT and capability.atomic_compare_enforced is not True:
            raise Unsupported('server-enforced atomic deliverable version/hash comparison capability missing')
        tool = self.market._tool(tool_name)
        if self.market.fingerprint(tool) != capability.schema_hash:
            raise Conflict('reviewed write capability does not match current exact MCP schema')
        if self.market.identity_resolver is None:
            raise Unsupported('reviewed authenticated whoami identity resolver required')
        identity = self.market.read_tool('marketplace__whoami', {})
        if self.market.identity_resolver(identity) != authorization.principal:
            raise Conflict('authenticated write principal differs from authorization')
        # Award needs the native immutable job/bid selection, not invented
        # context/hash parameters. Local preflight checks price/worker/private
        # single-slot terms. Accept additionally needs actual atomic version/hash
        # arguments from the discovered schema, with reviewed enforcement.
        required = {'job_id', 'bid_id'} if command.action == Action.AWARD else {
            'job_id', 'assignment_id', 'delivery_version', 'artifact_sha256'}
        if command.action == Action.ACCEPT:
            if command.delivery is None:
                raise PaymentError('versioned verified delivery required')
            if self.artifact_verifier is None or self.artifact_verifier(command.binding, command.delivery) is not True:
                raise Conflict('current artifact/receipt retrieval, decryption and verification not established')
        if self.preflight is None:
            raise Unsupported('official bound job/bid/assignment preflight required')
        plan = self.preflight.prepare(command.operation_id, command.action, command.binding, command.delivery)
        if plan['binding_hash'] != bh or plan['action'] != command.action.value:
            raise Conflict('preflight belongs to another binding/action')
        values = dict(operation_id=command.operation_id, job_id=command.binding.job_id,
                      bid_id=command.binding.bid_id, assignment_id=command.binding.assignment_id,
                      worker_id=command.binding.worker_id, terms_hash=command.binding.terms_hash,
                      context_hash=command.binding.context_hash, selection_hash=command.binding.selection_hash,
                      amount_micros=command.binding.price.micros, currency='USDC', expected_revision=command.expected_revision)
        if command.delivery:
            values.update(delivery_version=command.delivery.version, artifact_sha256=command.delivery.artifact_sha256,
                          receipt_sha256=command.delivery.receipt_sha256)
        properties, required_names = tool['inputSchema'].get('properties', {}), tool['inputSchema'].get('required', [])
        if set(capability.input_fields) != required or len(set(capability.input_fields.values())) != len(required):
            raise Unsupported('complete exact server guard mapping missing')
        if any(name not in properties or name not in required_names for name in capability.input_fields.values()):
            raise Unsupported('required atomic guards absent from advertised tool input schema')
        arguments = {capability.input_fields[k]: values[k] for k in required}
        validate(arguments, tool['inputSchema'])
        # A schema-valid synchronous response is an observation, not confirmed
        # escrow or payout. Echo checks are optional ONLY for observation; no
        # financial projector is supplied and no idempotency guarantee inferred.
        # Names, if configured, must actually exist in the discovered schema.
        output = tool['outputSchema']
        if any(k not in values or name not in output.get('properties', {})
               for k, name in capability.output_fields.items()):
            raise Unsupported('configured output binding absent from advertised schema')
        request_hash = digest({'command': asdict(command), 'arguments': arguments,
                               'schema': capability.schema_hash, 'principal': authorization.principal,
                               'capability': asdict(capability), 'budget_micros': authorization.budget_micros,
                               'budget_scope': authorization.scope_id})
        with self.db.transaction() as db:
            old = db.execute('SELECT * FROM market_write_outbox WHERE operation_id=?', (command.operation_id,)).fetchone()
            if old:
                if old['request_hash'] != request_hash or old['scope_id'] != authorization.scope_id:
                    raise Conflict('operation id reused with another payload or budget')
                return {'operation_id': command.operation_id, 'state': old['state'], 'redispatch_allowed': False}
            if db.execute("SELECT 1 FROM market_write_outbox WHERE assignment_id=? AND (state IN ('sent','unknown') OR action=?)",
                          (command.binding.assignment_id, command.action.value)).fetchone():
                raise Conflict('assignment action already attempted or has unresolved financial outcome')
            budget = db.execute('SELECT * FROM market_write_budgets WHERE scope_id=?', (authorization.scope_id,)).fetchone()
            ph = digest(authorization.principal)
            if budget is None:
                db.execute('INSERT INTO market_write_budgets VALUES (?,?,?,0)', (authorization.scope_id, ph, authorization.budget_micros))
                reserved = 0
            elif budget['principal_hash'] != ph or budget['cap'] != authorization.budget_micros:
                raise Conflict('shared budget principal/cap changed')
            else:
                reserved = budget['reserved']
            # Reserve gross price once, at award. Accept requires that same binding
            # was awarded under this budget, not a second price reservation.
            amount = command.binding.price.micros if command.action == Action.AWARD else 0
            if command.action == Action.ACCEPT and not db.execute(
                    "SELECT 1 FROM market_write_outbox WHERE assignment_id=? AND binding_hash=? AND scope_id=? AND action='award' AND state='observed'",
                    (command.binding.assignment_id, bh, authorization.scope_id)).fetchone():
                raise Conflict('no matching observed award under shared budget')
            if reserved + amount > authorization.budget_micros:
                raise Conflict('aggregate authorized budget exceeded')
            db.execute('UPDATE market_write_budgets SET reserved=reserved+? WHERE scope_id=?', (amount, authorization.scope_id))
            db.execute('INSERT INTO market_write_outbox VALUES (?,?,?,?,?,?,?,NULL)',
                       (command.operation_id, command.binding.assignment_id, bh, request_hash, authorization.scope_id, command.action.value, 'sent'))
        try:
            result = self.market.transport.call_financial_tool(tool_name, arguments)
            if not isinstance(result, dict) or result.get('isError', False) is not False or 'structuredContent' not in result:
                raise PaymentError('unconfirmed financial response')
            value = result['structuredContent']
            validate(value, output)
            if any(name not in value or canonical(value[name]) != canonical(values[k])
                   for k, name in capability.output_fields.items()):
                raise Conflict('financial response substituted operation or enforced bindings')
            response_hash = digest(value)
        except Exception:
            with self.db.transaction() as db:
                db.execute("UPDATE market_write_outbox SET state='unknown' WHERE operation_id=?", (command.operation_id,))
            return {'operation_id': command.operation_id, 'state': 'unknown', 'redispatch_allowed': False}
        with self.db.transaction() as db:
            db.execute("UPDATE market_write_outbox SET state='observed',response_hash=? WHERE operation_id=?", (response_hash, command.operation_id))
        return {'operation_id': command.operation_id, 'state': 'observed', 'response_sha256': response_hash,
                'settlement_confirmed': False, 'redispatch_allowed': False}

    def reconcile(self, operation_id, inspect_exact_operation=None):
        """Read-only evidence hook; no undocumented lookup route, no resend.

        There is no shipped exact-operation schema/mapping, so even the hook's
        evidence stays an observation hash. A generic current-state read cannot
        release the durable lock/budget. A future projector needs independent
        reviewed financial-status and exact-operation contracts before promotion.
        """
        from .model import identifier
        identifier(operation_id)
        with self.db.connect() as db:
            row = db.execute('SELECT * FROM market_write_outbox WHERE operation_id=?', (operation_id,)).fetchone()
            if row is None:
                raise Conflict('unknown financial operation id')
        evidence_hash = None
        if inspect_exact_operation is not None:
            try:
                evidence_hash = digest(inspect_exact_operation(operation_id))
            except Exception:
                pass
        return {'operation_id': operation_id, 'state': row['state'] if row['state'] == 'observed' else 'unknown',
                'evidence_sha256': evidence_hash, 'redispatch_allowed': False,
                'settlement_confirmed': False, 'blocker': 'NO_REVIEWED_EXACT_OPERATION_FINANCIAL_PROJECTOR'}
