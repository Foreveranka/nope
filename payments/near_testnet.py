"""NEAR testnet native-transfer preparation and read-only reconciliation.

No keys, signing, broadcast, escrow, Market calls or USDC conversion. A trusted
caller sends a separately signed testnet transfer and supplies its hash BEFORE
broadcast. RPC evidence is trusted node testimony, not a light-client proof.
"""
import base64
import math
import re
import sqlite3
import urllib.request
import uuid
from dataclasses import asdict, dataclass
from typing import Protocol

from .http import NoRedirect, TransportError, strict_json
from .model import Conflict, PaymentError, Unsupported, canonical, hash32, identifier
from .storage import Database


RPC_ENDPOINTS = (
    'https://test.rpc.fastnear.com',
    'https://rpc.testnet.near.org',
    'https://archival-rpc.testnet.near.org',
)
BASE58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz'
MAX_TEST_YOCTO = 10**24  # at most 1 native test NEAR per plan; no token conversion


def account(value):
    if (not isinstance(value, str) or not 2 <= len(value) <= 64
            or not value.endswith('.testnet')
            or not re.fullmatch(r'[a-z0-9]+(?:[-_.][a-z0-9]+)*', value)):
        raise PaymentError('named testnet account required')
    return value


def chain_hash(value):
    if not isinstance(value, str) or not 32 <= len(value) <= 44:
        raise PaymentError('expected base58 32-byte NEAR hash')
    number = 0
    for char in value:
        if char not in BASE58:
            raise PaymentError('invalid base58 hash')
        number = number * 58 + BASE58.index(char)
    raw = b'\0' * (len(value) - len(value.lstrip('1')))
    raw += number.to_bytes((number.bit_length() + 7) // 8, 'big')
    if len(raw) != 32:
        raise PaymentError('expected 32-byte NEAR hash')
    return value


def natural(value, minimum=0, maximum=2**64-1):
    if type(value) is not int or not minimum <= value <= maximum:
        raise PaymentError('invalid bounded integer')
    return value


def u64(value, minimum=0):
    if not isinstance(value, str) or not re.fullmatch(r'0|[1-9][0-9]{0,19}', value):
        raise PaymentError('expected canonical U64 string')
    natural(int(value), minimum)
    return value


def hex_hash(value):
    if type(value) is not list or len(value) != 32 or any(type(x) is not int or not 0 <= x <= 255 for x in value):
        raise PaymentError('expected registry byte[32]')
    return bytes(value).hex()


class TestnetReadTransport(Protocol):
    """Only reads; custom implementations are an explicit trusted boundary."""
    def status(self): ...
    def account(self, account_id): ...
    def job(self, registry_id, job_id, block_hash): ...
    def transaction(self, tx_hash, sender_id): ...
    def block(self, block_hash): ...


class NearTestnetRPC:
    """Real bounded HTTPS JSON-RPC, pinned public testnet origins, no retries.

    The method allowlist prevents using this client to submit even pre-signed
    transactions. No auth headers, redirects, cookies or environment proxies.
    """
    def __init__(self, endpoint=RPC_ENDPOINTS[0], timeout=15, max_bytes=2*1024*1024):
        if endpoint not in RPC_ENDPOINTS:
            raise Unsupported('only reviewed public testnet RPC origins are permitted')
        if type(timeout) not in (int, float) or not math.isfinite(timeout) or not 0 < timeout <= 30:
            raise PaymentError('invalid timeout')
        natural(max_bytes, 1, 4*1024*1024)
        self.endpoint, self.timeout, self.max_bytes = endpoint, timeout, max_bytes
        self.opener = urllib.request.build_opener(urllib.request.ProxyHandler({}), NoRedirect())

    def _request(self, method, params):
        if method == 'status':
            valid = params == []
        elif method == 'block':
            valid = type(params) is dict and set(params) == {'block_id'}
            if valid: chain_hash(params['block_id'])
        elif method in ('tx', 'EXPERIMENTAL_tx_status'):
            valid = (type(params) is dict and set(params) == {'tx_hash', 'sender_account_id', 'wait_until'}
                     and params['wait_until'] == 'FINAL')
            if valid:
                chain_hash(params['tx_hash']); account(params['sender_account_id'])
        elif method == 'query':
            valid = type(params) is dict
            if valid and params.get('request_type') == 'view_account':
                valid = set(params) == {'request_type', 'account_id', 'finality'} and params['finality'] == 'final'
            elif valid and params.get('request_type') == 'call_function':
                valid = (set(params) == {'request_type', 'account_id', 'block_id', 'method_name', 'args_base64'}
                         and params['method_name'] in ('get_job', 'get_hold', 'registry', 'storage_topup'))
                if valid:
                    chain_hash(params['block_id'])
                    try:
                        args = strict_json(base64.b64decode(params['args_base64'], validate=True))
                        expected = {'job_id'} if params['method_name'] in ('get_job', 'get_hold') else set()
                        valid = type(args) is dict and set(args) == expected
                        if valid and expected: u64(args['job_id'], 1)
                    except (ValueError, TypeError):
                        valid = False
            else:
                valid = False
            if valid: account(params['account_id'])
        else:
            valid = False
        if not valid:
            raise Unsupported('read-only testnet RPC method/parameters required')
        request_id = str(uuid.uuid4())
        body = canonical({'jsonrpc': '2.0', 'id': request_id, 'method': method, 'params': params}).encode()
        request = urllib.request.Request(self.endpoint, data=body, method='POST', headers={
            'Content-Type': 'application/json', 'Accept': 'application/json',
            'User-Agent': 'nope-testnet-payment-observer/1'})
        try:
            with self.opener.open(request, timeout=self.timeout) as response:
                if response.status != 200 or response.headers.get_content_type() != 'application/json':
                    raise TransportError('testnet_rpc_http_or_content_type')
                raw = response.read(self.max_bytes + 1)
                if len(raw) > self.max_bytes:
                    raise TransportError('testnet_rpc_response_too_large')
            envelope = strict_json(raw)
        except TransportError:
            raise
        except Exception:
            raise TransportError('testnet_rpc_unavailable_or_invalid_json') from None
        if (type(envelope) is not dict or envelope.get('jsonrpc') != '2.0'
                or envelope.get('id') != request_id or 'error' in envelope
                or type(envelope.get('result')) is not dict):
            raise TransportError('testnet_rpc_error_or_correlation')
        return envelope['result']

    def status(self):
        value = self._request('status', [])
        if value.get('chain_id') != 'testnet' or value.get('sync_info', {}).get('syncing') is not False:
            raise PaymentError('RPC must be synchronized testnet')
        return value

    def account(self, account_id):
        return self._request('query', {'request_type': 'view_account', 'account_id': account(account_id), 'finality': 'final'})

    def job(self, registry_id, job_id, block_hash):
        return self.view(registry_id, 'get_job', {'job_id': u64(job_id, 1)}, block_hash)

    def view(self, account_id, method_name, args, block_hash):
        return self._request('query', {'request_type': 'call_function', 'account_id': account(account_id),
            'block_id': chain_hash(block_hash), 'method_name': method_name,
            'args_base64': base64.b64encode(canonical(args).encode()).decode()})

    def transaction(self, tx_hash, sender_id):
        return self._request('tx', {'tx_hash': chain_hash(tx_hash), 'sender_account_id': account(sender_id), 'wait_until': 'FINAL'})

    def block(self, block_hash):
        return self._request('block', {'block_id': chain_hash(block_hash)})

    def transaction_with_receipts(self, tx_hash, sender_id):
        return self._request('EXPERIMENTAL_tx_status', {'tx_hash': chain_hash(tx_hash),
            'sender_account_id': account(sender_id), 'wait_until': 'FINAL'})


@dataclass(frozen=True)
class TestnetPaymentBinding:
    registry_id: str
    registry_code_hash: str
    job_id: str
    buyer_id: str
    provider_id: str
    amount_yocto: int
    context_hash: str
    job_binding_hash: str
    attempt: str
    attempt_binding_hash: str
    receipt_hash: str
    output_hash: str  # ciphertext artifact hash, not plaintext result

    def validate(self):
        for name in ('registry_id', 'buyer_id', 'provider_id'): account(getattr(self, name))
        if self.buyer_id == self.provider_id:
            raise PaymentError('self-payment is not buyer/provider settlement')
        chain_hash(self.registry_code_hash)
        u64(self.job_id, 1); u64(self.attempt, 1)
        natural(self.amount_yocto, 1, MAX_TEST_YOCTO)
        for name in ('context_hash', 'job_binding_hash', 'attempt_binding_hash', 'receipt_hash', 'output_hash'):
            hash32(getattr(self, name))
        return self


def accepted_registry(transport, binding):
    """Read code and accepted exact receipt at one finalized registry block."""
    binding.validate()
    status = transport.status()
    if status.get('chain_id') != 'testnet' or status.get('sync_info', {}).get('syncing') is not False:
        raise PaymentError('synchronized testnet required')
    code = transport.account(binding.registry_id)
    if code.get('code_hash') != binding.registry_code_hash:
        raise Conflict('registry code hash changed or unreviewed')
    block = chain_hash(code.get('block_hash'))
    height = natural(code.get('block_height'), 1)
    response = transport.job(binding.registry_id, binding.job_id, block)
    if response.get('block_hash') != block or response.get('block_height') != height:
        raise Conflict('registry view block mismatch')
    raw = response.get('result')
    if type(raw) is not list or len(raw) > 256*1024 or any(type(x) is not int or not 0 <= x <= 255 for x in raw):
        raise PaymentError('invalid registry view bytes')
    job = strict_json(bytes(raw))
    if type(job) is not dict or job.get('state') != 'Accepted' or job.get('buyer') != binding.buyer_id or job.get('job_id') != binding.job_id:
        raise Conflict('job must be buyer-accepted with exact identity')
    if job.get('attempt') != binding.attempt or hex_hash(job.get('job_binding_hash')) != binding.job_binding_hash or hex_hash(job.get('attempt_binding_hash')) != binding.attempt_binding_hash:
        raise Conflict('job/attempt binding mismatch')
    config = job.get('config')
    if type(config) is not dict or hex_hash(config.get('context_hash')) != binding.context_hash:
        raise Conflict('context mismatch')
    version = job.get('attempt_binding_version')
    if type(version) is not int or version not in (1, 2):
        raise Conflict('unknown registry executor binding version')
    executor = config.get('executor') if version == 1 else job.get('selected_executor')
    if executor != binding.provider_id:
        raise Conflict('provider is not the attempt executor')
    receipts = job.get('receipts')
    if type(receipts) is not list or not receipts or type(receipts[-1]) is not dict:
        raise Conflict('missing current registry receipt')
    receipt = receipts[-1]
    if receipt.get('status') != 'BuyerAccepted' or hex_hash(receipt.get('receipt_hash')) != binding.receipt_hash:
        raise Conflict('current receipt not accepted or changed')
    u64(receipt.get('decided_at_ns'), 1)
    claim = receipt.get('claim')
    if type(claim) is not dict or claim.get('job_id') != binding.job_id or claim.get('attempt') != binding.attempt:
        raise Conflict('receipt identity mismatch')
    for key in ('context_hash', 'job_binding_hash', 'attempt_binding_hash', 'output_hash'):
        if hex_hash(claim.get(key)) != getattr(binding, key):
            raise Conflict('receipt claim mismatch: ' + key)
    return {'block_hash': block, 'block_height': height}


def verify_transfer(result, binding, tx_hash):
    """Only exact native Transfer, FINAL and complete successful outcome tree.

    Receipt outcomes (not a submitted hash or top-level status alone) establish
    execution. Unsupported node shapes fail closed. Refund outcomes are included.
    """
    binding.validate(); chain_hash(tx_hash)
    if type(result) is not dict or result.get('final_execution_status') != 'FINAL' or result.get('status') != {'SuccessValue': ''}:
        raise Conflict('transfer is not final and successful')
    tx = result.get('transaction')
    if (type(tx) is not dict or tx.get('hash') != tx_hash or tx.get('signer_id') != binding.buyer_id
            or tx.get('receiver_id') != binding.provider_id
            or tx.get('actions') != [{'Transfer': {'deposit': str(binding.amount_yocto)}}]):
        raise Conflict('transaction hash/signer/recipient/amount/actions mismatch')
    root = result.get('transaction_outcome')
    receipts = result.get('receipts_outcome')
    if type(root) is not dict or root.get('id') != tx_hash or type(receipts) is not list or not 1 <= len(receipts) <= 64:
        raise Conflict('missing execution/receipt evidence')
    nodes = {}
    for item in [root] + receipts:
        if type(item) is not dict:
            raise PaymentError('invalid outcome')
        key = chain_hash(item.get('id')); chain_hash(item.get('block_hash'))
        if key in nodes:
            raise Conflict('duplicate outcome')
        outcome = item.get('outcome')
        if type(outcome) is not dict or type(outcome.get('receipt_ids')) is not list:
            raise PaymentError('missing outcome receipt links')
        for child in outcome['receipt_ids']: chain_hash(child)
        if len(set(outcome['receipt_ids'])) != len(outcome['receipt_ids']):
            raise Conflict('duplicate receipt links')
        success = outcome.get('status')
        if type(success) is not dict or len(success) != 1:
            raise Conflict('invalid outcome status')
        if 'SuccessReceiptId' in success:
            if chain_hash(success['SuccessReceiptId']) not in outcome['receipt_ids']:
                raise Conflict('success receipt not linked')
        elif success != {'SuccessValue': ''}:
            raise Conflict('failed, unknown or non-transfer receipt')
        nodes[key] = item
    root_outcome = root['outcome']
    root_status = root_outcome['status']
    if root_outcome.get('executor_id') != binding.buyer_id or set(root_status) != {'SuccessReceiptId'}:
        raise Conflict('wrong transaction execution identity/status')
    transfer_id = root_status['SuccessReceiptId']
    if transfer_id not in nodes or nodes[transfer_id]['outcome'].get('executor_id') != binding.provider_id or nodes[transfer_id]['outcome']['status'] != {'SuccessValue': ''}:
        raise Conflict('recipient transfer receipt not successful')
    visited, pending = set(), [tx_hash]
    while pending:
        key = pending.pop()
        if key in visited or key not in nodes:
            raise Conflict('cyclic, reused or missing receipt outcome')
        visited.add(key)
        pending.extend(nodes[key]['outcome']['receipt_ids'])
    if visited != set(nodes):
        raise Conflict('unrelated receipt outcome')
    # confirm() separately reads these exact block headers for height ordering.
    return {'transaction_hash': tx_hash, 'transfer_receipt_id': transfer_id,
            'outcome_block_hashes': sorted({item['block_hash'] for item in nodes.values()}),
            'receipt_count': len(receipts)}


SCHEMA = '''
CREATE TABLE IF NOT EXISTS near_testnet_payment_plans (
 operation_id TEXT PRIMARY KEY, binding_json TEXT NOT NULL,
 registry_id TEXT NOT NULL, job_id TEXT NOT NULL, anchor_json TEXT NOT NULL,
 tx_hash TEXT UNIQUE, evidence_json TEXT,
 UNIQUE(registry_id, job_id)
);
'''


class NearTestnetPaymentRail:
    """Separate native-test-NEAR rail; deliberately not the USDC PaymentRail.

    One durable plan per registry/job and one reserved signed tx hash. This is
    local replay protection in a shared DB, not on-chain idempotency. Do not use
    separate databases to pay the same job. Uncertainty never permits resending.
    """
    mode = 'near_testnet_native_transfer_observer'

    def __init__(self, db_path, transport: TestnetReadTransport):
        self.db, self.transport = Database(db_path, SCHEMA), transport

    def capabilities(self):
        return {'mode': self.mode, 'network': 'testnet', 'asset': 'native_test_NEAR',
                'broadcast': False, 'escrow': False, 'market_settlement': False,
                'atomic_registry_payment': False, 'light_client_proof': False}

    def prepare(self, operation_id, binding):
        identifier(operation_id); binding.validate()
        encoded = canonical(asdict(binding))
        anchor = accepted_registry(self.transport, binding)
        # Recipient must already exist; this adapter does not create accounts.
        self.transport.account(binding.provider_id)
        with self.db.transaction() as db:
            prior = db.execute('SELECT * FROM near_testnet_payment_plans WHERE operation_id=?', (operation_id,)).fetchone()
            if prior:
                if prior['binding_json'] != encoded:
                    raise Conflict('operation immutable binding mismatch')
                return self._plan(prior)
            try:
                db.execute('INSERT INTO near_testnet_payment_plans VALUES (?,?,?,?,?,NULL,NULL)',
                    (operation_id, encoded, binding.registry_id, binding.job_id, canonical(anchor)))
            except sqlite3.IntegrityError:
                raise Conflict('job already has a payment plan') from None
            return self._plan(db.execute('SELECT * FROM near_testnet_payment_plans WHERE operation_id=?', (operation_id,)).fetchone())

    @staticmethod
    def _plan(row):
        binding = strict_json(row['binding_json'])
        return {'operation_id': row['operation_id'], 'binding': binding,
                'anchor': strict_json(row['anchor_json']), 'tx_hash': row['tx_hash'],
                'state': 'verified_testnet_transfer' if row['evidence_json'] else ('awaiting_final_evidence' if row['tx_hash'] else 'unsigned_plan'),
                'unsigned_intent': {'network_id': 'testnet', 'signer_id': binding['buyer_id'],
                    'receiver_id': binding['provider_id'], 'actions': [{'Transfer': {'deposit': str(binding['amount_yocto'])}}]},
                'evidence': strict_json(row['evidence_json']) if row['evidence_json'] else None}

    def inspect(self, operation_id):
        identifier(operation_id)
        with self.db.connect() as db:
            row = db.execute('SELECT * FROM near_testnet_payment_plans WHERE operation_id=?', (operation_id,)).fetchone()
            if row is None: raise Conflict('unknown payment plan')
            return self._plan(row)

    def reserve_transaction(self, operation_id, tx_hash):
        """Persist the signed hash before caller broadcast; never replace it."""
        identifier(operation_id); chain_hash(tx_hash)
        with self.db.transaction() as db:
            row = db.execute('SELECT * FROM near_testnet_payment_plans WHERE operation_id=?', (operation_id,)).fetchone()
            if row is None: raise Conflict('unknown payment plan')
            if row['tx_hash'] is not None and row['tx_hash'] != tx_hash:
                raise Conflict('transaction already reserved; reconcile the same hash')
            try:
                db.execute('UPDATE near_testnet_payment_plans SET tx_hash=? WHERE operation_id=?', (tx_hash, operation_id))
            except sqlite3.IntegrityError:
                raise Conflict('transaction already assigned to another plan') from None
        return self.inspect(operation_id)

    def confirm(self, operation_id):
        plan = self.inspect(operation_id)
        if not plan['tx_hash']: raise Conflict('reserve signed transaction hash before broadcast')
        binding = TestnetPaymentBinding(**plan['binding']).validate()
        registry = accepted_registry(self.transport, binding)
        result = self.transport.transaction(plan['tx_hash'], binding.buyer_id)
        evidence = verify_transfer(result, binding, plan['tx_hash'])
        # A successful old transfer cannot be reused for a newly prepared job.
        # The transport must resolve these exact block headers, not caller heights.
        heights = []
        for block_hash in evidence['outcome_block_hashes']:
            block = self.transport.block(block_hash)
            header = block.get('header', {})
            if header.get('hash') != block_hash:
                raise Conflict('outcome block hash mismatch')
            heights.append(natural(header.get('height'), 1))
        if min(heights) <= plan['anchor']['block_height'] or max(heights) > registry['block_height']:
            raise Conflict('payment must follow prepared acceptance and be visible at final registry block')
        evidence.update({'authority': 'trusted_testnet_rpc', 'network': 'testnet',
            'asset': 'native_test_NEAR', 'amount_yocto': str(binding.amount_yocto),
            'registry_observation': registry, 'atomic_registry_payment': False,
            'market_settlement': False, 'escrow': False})
        with self.db.transaction() as db:
            db.execute('UPDATE near_testnet_payment_plans SET evidence_json=? WHERE operation_id=? AND tx_hash=?',
                (canonical(evidence), operation_id, plan['tx_hash']))
        return self.inspect(operation_id)
