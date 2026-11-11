"""Real official REST reads and immutable, non-executable procurement plans.

This adapter intentionally is not PaymentRail: wire observations have no local
revision CAS, cryptographic acceptance binding, or exactly-once release claim.
"""
import copy
from dataclasses import asdict, dataclass
from .http import HTTPS
from .interface import Action
from .model import Conflict, PaymentError, Unsupported, binding_hash, delivery as check_delivery, digest
from .openapi import OfficialContract, OPENAPI_SHA256
from .schema import validate
from .storage import Database

PUBLIC = frozenset(('healthz', 'get_platform_config', 'browse_agents', 'get_job_terms'))
BUYER = frozenset(('get_me', 'get_job', 'list_bids_on_job', 'list_ledger', 'list_deliverable_versions'))
WORKER = frozenset(('get_job', 'list_my_agent_assignments', 'list_my_agent_bids', 'list_deliverable_versions'))


def uuid(value):
    validate(value, {'type': 'string', 'format': 'uuid'})
    return value


@dataclass(frozen=True)
class Scope:
    role: str
    principal: str
    job_ids: tuple = ()
    assignment_ids: tuple = ()

    def __post_init__(self):
        if self.role not in ('buyer', 'worker', 'public'):
            raise PaymentError('unknown Market role')
        if self.role != 'public':
            uuid(self.principal)
        if not isinstance(self.job_ids, tuple) or not isinstance(self.assignment_ids, tuple):
            raise PaymentError('scope resource lists must be immutable tuples')
        for item in self.job_ids + self.assignment_ids:
            uuid(item)


class MarketREST:
    contract_pin = OPENAPI_SHA256

    def __init__(self, scope, credential_provider=None, timeout=10):
        self.scope = scope
        self.http = HTTPS(credential_provider, timeout)
        self.contract = OfficialContract()

    def _fetch(self, op, path=None, query=None, public=False):
        method, target = self.contract.request(op, path, query)
        if method != 'GET':
            raise Unsupported('REST transport is read-only')
        status, value, _ = self.http.json(method, target, role=None if public else self.scope.role,
                                           principal=self.scope.principal)
        return self.contract.response(op, status, value)

    def read(self, op, path=None, query=None):
        path, query = dict(path or {}), dict(query or {})
        public = op in PUBLIC
        allow = BUYER if self.scope.role == 'buyer' else WORKER if self.scope.role == 'worker' else frozenset()
        if not public and op not in allow:
            raise Unsupported('operation outside read-only role scope')
        # Validate before any authenticated I/O, even the identity read.
        self.contract.request(op, path, query)
        if path:
            assignment = op == 'list_deliverable_versions'
            admitted = self.scope.assignment_ids if assignment else self.scope.job_ids
            if path.get('id') not in admitted:
                raise Unsupported('resource outside explicit local scope')
        if not public and self.scope.role == 'buyer':
            identity = self._fetch('get_me')
            if identity['account']['account_id'] != self.scope.principal:
                raise Conflict('authenticated buyer account differs from configured principal')
            if op == 'get_me':
                return identity
        result = self._fetch(op, path, query, public)
        if op == 'get_job':
            if result['jobId'] != path['id']:
                raise Conflict('job identity mismatch')
            if self.scope.role == 'buyer' and result['creatorAccountId'] != self.scope.principal:
                raise Conflict('job is not owned by configured buyer')
        if op == 'list_my_agent_assignments':
            for item in result['assignments']:
                a = item['assignment']
                if a['workerAgentId'] != self.scope.principal or a['jobId'] != item['job']['jobId']:
                    raise Conflict('worker assignment identity mismatch')
        if op == 'list_my_agent_bids':
            for item in result['bids']:
                if item['bidderAgentId'] != self.scope.principal:
                    raise Conflict('worker bid identity mismatch')
        return result

    def pages(self, op, rows_key, path=None, query=None, page_size=50, max_pages=20):
        """Bounded offset walk; NOT a consistent snapshot or negative evidence.

        Offset advances by rows returned, not the requested/clamped limit.
        Repeated IDs are a drift/error, never silently deduplicated evidence.
        """
        if op not in ('list_bids_on_job', 'list_ledger', 'list_my_agent_assignments', 'list_my_agent_bids'):
            raise Unsupported('operation has no reviewed pagination mapping')
        if type(page_size) is not int or not 1 <= page_size <= 50 or type(max_pages) is not int or not 1 <= max_pages <= 100:
            raise PaymentError('invalid bounded pagination')
        expected = {'list_bids_on_job': 'bids', 'list_ledger': 'entries',
                    'list_my_agent_assignments': 'assignments', 'list_my_agent_bids': 'bids'}[op]
        if rows_key != expected:
            raise PaymentError('wrong response envelope')
        offset, seen = 0, set()
        for _ in range(max_pages):
            q = dict(query or {}, limit=page_size, offset=offset)
            page = self.read(op, path, q)
            rows = page[rows_key]
            if not rows:
                return
            for row in rows:
                key = row['assignment']['assignmentId'] if rows_key == 'assignments' else row.get('ledgerEntryId', row.get('bidId'))
                if key in seen:
                    raise Conflict('pagination changed or repeated an identity')
                seen.add(key)
                yield copy.deepcopy(row)
            offset += len(rows)
            # Do not stop on short/clamped pages or on a moving total.
        raise Unsupported('pagination cap reached; evidence is incomplete')


JOURNAL = '''
CREATE TABLE IF NOT EXISTS market_plans (
 operation_id TEXT PRIMARY KEY, request_hash TEXT NOT NULL, plan_json TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS market_unknown (
 operation_id TEXT PRIMARY KEY, request_hash TEXT NOT NULL, state TEXT NOT NULL,
 evidence_hash TEXT
);
'''


class NearMarketAdapter:
    mode = 'official_market_read_prepare'

    def __init__(self, db_path, buyer, worker=None):
        if buyer.scope.role != 'buyer' or (worker and worker.scope.role != 'worker'):
            raise Unsupported('separate buyer and worker role clients required')
        self.db, self.buyer, self.worker = Database(db_path, JOURNAL), buyer, worker

    def capabilities(self):
        return dict(mode=self.mode, authenticated_reads=True, local_preparation=True,
                    live_financial_mutations=False, acceptance_cas=False,
                    remote_idempotency_guarantee=False, separate_release_endpoint=False,
                    platform_auto_accept_can_release=True, remote_hold_from_local_reserve=False)

    def _job(self, binding):
        binding_hash(binding)
        for value in (binding.job_id, binding.bid_id, binding.assignment_id, binding.worker_id):
            uuid(value)
        job = self.buyer.read('get_job', {'id': binding.job_id})
        if job['isPrivate'] is not True or job['maxSlots'] != 1 or job['jobKind'] == 'competition' or job['isTestRun']:
            raise Conflict('requires private single-slot paid non-competition job')
        if job['budgetToken'] != 'USDC':
            raise Conflict('only explicit USDC supported; no currency fallback')
        if not 3 <= job['acceptanceWindowDays'] <= 7:
            raise Conflict('unsupported acceptance window')
        return job

    def assignment(self, binding):
        if self.worker is None or self.worker.scope.principal != binding.worker_id:
            raise Unsupported('separate scoped worker credential required for official assignment view')
        if binding.assignment_id not in self.worker.scope.assignment_ids or binding.job_id not in self.worker.scope.job_ids:
            raise Unsupported('assignment outside configured worker resource scope')
        rows = self.worker.pages('list_my_agent_assignments', 'assignments', query={'status': 'all'})
        found = [r for r in rows if r['assignment']['assignmentId'] == binding.assignment_id]
        if len(found) != 1:
            raise Conflict('no unique assignment observed; absence is not financial evidence')
        row, a = found[0], found[0]['assignment']
        from .model import parse_usdc
        if (a['jobId'], a.get('bidId'), a['workerAgentId']) != (binding.job_id, binding.bid_id, binding.worker_id):
            raise Conflict('assignment does not match immutable binding')
        if a['escrowToken'] != 'USDC' or parse_usdc(a['escrowAmount']) != binding.price:
            raise Conflict('assignment currency or exact price mismatch')
        return row

    def hold_evidence(self, binding):
        self._job(binding)
        row = self.assignment(binding)
        # referenceKind is a free string, not an enumerated/semantically specified
        # assignment FK. Preserve only candidates, never promote a hire by memo/job.
        candidates = []
        for entry in self.buyer.pages('list_ledger', 'entries'):
            if entry.get('jobId') == binding.job_id or entry.get('referenceId') == binding.assignment_id:
                candidates.append(entry)
        return {'assignment': row, 'ledger_candidates': candidates, 'confirmed_hold': False,
                'authority': 'official_api_observation_not_settlement_proof',
                'blockers': ['ledger referenceKind/referenceId assignment semantics not established',
                             'credit-pool and crypto funding split must be reconciled',
                             'assignment escrowAmount alone does not prove confirmed funding']}

    def _save(self, operation_id, request, plan):
        import json
        from .model import canonical, identifier
        identifier(operation_id)
        request_hash = digest(request)
        with self.db.transaction() as db:
            old = db.execute('SELECT * FROM market_plans WHERE operation_id=?', (operation_id,)).fetchone()
            if old:
                if old['request_hash'] != request_hash:
                    raise Conflict('operation id reused for a different local plan')
                return json.loads(old['plan_json'])
            db.execute('INSERT INTO market_plans VALUES (?,?,?)', (operation_id, request_hash, canonical(plan)))
        return copy.deepcopy(plan)

    def prepare(self, operation_id, action, binding, delivery=None):
        """Perform real reads; persist a reviewable plan, never send a financial call."""
        if action not in (Action.AWARD, Action.HOLD, Action.ACCEPT, Action.RELEASE):
            raise Unsupported('unsupported live preparation action')
        job = self._job(binding)
        blockers = ['local context/terms/selection hashes are not server-enforced terms',
                    'financial dispatch disabled by this adapter',
                    'platform auto-accept cannot be paused by a local gate']
        evidence = {'job': job}
        arguments = {'job_id': binding.job_id}
        tool = None
        if action == Action.AWARD:
            if delivery is not None or job['status'] not in ('open', 'filling') or job['currentMaxSlots'] != 1:
                raise Conflict('job is not a single open award slot')
            from .model import parse_usdc
            matches = [r for r in self.buyer.pages('list_bids_on_job', 'bids', {'id': binding.job_id}) if r['bidId'] == binding.bid_id]
            if len(matches) != 1:
                raise Conflict('exact bid not observed')
            bid = matches[0]
            if bid['bidder']['agentId'] != binding.worker_id:
                raise Conflict('bidder identity differs from bound worker')
            if (bid['jobId'], bid['bidderAgentId'], bid['status']) != (binding.job_id, binding.worker_id, 'pending') or parse_usdc(bid['amount']) != binding.price:
                raise Conflict('bid identity, pending state or exact price mismatch')
            evidence['bid'] = bid
            tool, arguments['bid_id'] = 'marketplace__award_bid', binding.bid_id
            blockers += ['award outcome needs authoritative assignment and funding correlation',
                         'no documented client idempotency key or exact-operation lookup for award']
        elif action == Action.HOLD:
            if delivery is not None:
                raise Conflict('hold cannot carry a delivery')
            evidence['hold'] = self.hold_evidence(binding)
            blockers += evidence['hold']['blockers'] + ['hold is part of award, not a separate remote operation']
        elif action == Action.ACCEPT:
            check_delivery(delivery)
            row = self.assignment(binding)
            a = row['assignment']
            if a['status'] != 'submitted':
                raise Conflict('assignment not submitted, or disputed/terminal')
            versions = self.buyer.read('list_deliverable_versions', {'id': binding.assignment_id})['versions']
            if not versions or any(type(v['version']) is not int or v['version'] < 1 for v in versions):
                raise Conflict('no versioned deliverable observed')
            if [v['version'] for v in versions] != list(range(1, len(versions)+1)):
                raise Conflict('deliverable versions are not consecutive oldest-first')
            latest = versions[-1]
            if latest['version'] != delivery.version or not latest.get('deliverableHash') or latest['deliverableHash'] != a.get('deliverableHash'):
                raise Conflict('delivery changed or lacks matching current wire hash')
            if not row.get('autoAcceptAt'):
                blockers.append('authoritative active auto-accept deadline unavailable')
            evidence.update(assignment=row, latest_version=latest)
            tool, arguments['assignment_id'] = 'marketplace__accept_result', binding.assignment_id
            blockers += ['accept has no documented expected version/hash CAS; read-then-accept is racy',
                         'Markdown deliverable hash does not prove ciphertext retrieval/decryption or receipt validity',
                         'acceptance queues/releases payment; accepted status is not confirmed payout evidence']
        else:
            blockers += ['accept/auto-accept owns remote release; no separate release will be dispatched']
        plan = {'kind': 'blocked_financial_plan', 'action': action.value, 'operation_id': operation_id,
                'binding_hash': binding_hash(binding), 'schema_sha256': self.buyer.contract_pin,
                'evidence_sha256': digest(evidence), 'tool': tool, 'arguments': arguments,
                'dispatch_allowed': False, 'blockers': blockers,
                'automatic_release_possible': True, 'observation_is_snapshot_not_cas': True}
        # Only hashes and IDs reach disk: no brief, token, delivered bytes, or raw ledger.
        return self._save(operation_id, {'action': action.value, 'binding': asdict(binding),
                                        'delivery': asdict(delivery) if delivery else None}, plan)

    def execute(self, command):
        raise Unsupported('no financial dispatcher; award/accept on /mcp/pro move money; release is platform-owned')

    def mark_unknown(self, operation_id, action, binding):
        """Import an ambiguous external outcome; never claim this adapter sent it."""
        from .model import identifier
        identifier(operation_id)
        if action not in (Action.AWARD, Action.HOLD, Action.ACCEPT, Action.RELEASE):
            raise Unsupported('unsupported reconciliation action')
        request_hash = digest({'action': action.value, 'binding': binding_hash(binding)})
        with self.db.transaction() as db:
            old = db.execute('SELECT * FROM market_unknown WHERE operation_id=?', (operation_id,)).fetchone()
            if old and old['request_hash'] != request_hash:
                raise Conflict('unknown operation id payload conflict')
            db.execute('INSERT OR IGNORE INTO market_unknown VALUES (?,?,?,NULL)', (operation_id, request_hash, 'unknown'))
        return {'operation_id': operation_id, 'state': 'unknown'}

    def reconcile(self, operation_id, action, binding):
        request_hash = digest({'action': action.value, 'binding': binding_hash(binding)})
        with self.db.connect() as db:
            old = db.execute('SELECT * FROM market_unknown WHERE operation_id=?', (operation_id,)).fetchone()
            if not old or old['request_hash'] != request_hash:
                raise Conflict('unknown operation missing or binding mismatch')
        try:
            evidence = self.hold_evidence(binding)
            evidence_hash = digest(evidence)
            reason = 'NO_DOCUMENTED_EXACT_OPERATION_CORRELATION'
        except PaymentError:
            evidence_hash, reason = None, 'READ_INCOMPLETE_OR_FAILED'
        with self.db.transaction() as db:
            db.execute('UPDATE market_unknown SET evidence_hash=? WHERE operation_id=?', (evidence_hash, operation_id))
        # accepted/cancelled, job-only rows, lack of rows or elapsed time cannot
        # resolve the exact ambiguous call, nor permit a new-ID retry.
        return {'operation_id': operation_id, 'state': 'unknown', 'redispatch_allowed': False,
                'evidence_sha256': evidence_hash, 'reason': reason}
