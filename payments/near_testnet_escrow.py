"""Real NOPE escrow call intents and read-only finalized receipt verification.

Signing/deployment/broadcast belong to the caller. This module never authenticates
or mutates a network. Native test NEAR only; it is not a Market sandbox adapter.
"""
import base64
from dataclasses import dataclass

from .http import strict_json
from .model import Conflict, PaymentError, canonical, hash32
from .near_testnet import (MAX_TEST_YOCTO, TestnetPaymentBinding, accepted_registry,
    account, chain_hash, natural, u64)

STORAGE_TOPUP = 2 * 10**22
CALL_GAS = 150000000000000


@dataclass(frozen=True)
class EscrowConfig:
    escrow_id: str
    escrow_code_hash: str
    registry_id: str
    registry_code_hash: str

    def validate(self):
        account(self.escrow_id); account(self.registry_id)
        chain_hash(self.escrow_code_hash); chain_hash(self.registry_code_hash)
        if self.escrow_id == self.registry_id:
            raise PaymentError('escrow and registry must be separate accounts')
        return self


def terms(binding):
    binding.validate()
    return {'job_id': binding.job_id, 'buyer': binding.buyer_id, 'provider': binding.provider_id,
        'amount': str(binding.amount_yocto), 'context_hash': list(bytes.fromhex(binding.context_hash)),
        'job_binding_hash': list(bytes.fromhex(binding.job_binding_hash))}


def acceptance(binding):
    return {'attempt': binding.attempt, 'attempt_binding_hash': list(bytes.fromhex(binding.attempt_binding_hash)),
        'receipt_hash': list(bytes.fromhex(binding.receipt_hash)), 'output_hash': list(bytes.fromhex(binding.output_hash))}


def fund_intent(config, job_id, buyer_id, provider_id, amount_yocto, context_hash, job_binding_hash):
    """Prepare funding BEFORE a receipt exists. No on-chain job verification yet.

    The buyer must check registry job/config and provider before signing. Bad terms
    can strand a hold pending cooperative refund. All terms are public metadata.
    """
    config.validate(); u64(job_id, 1); account(buyer_id); account(provider_id)
    natural(amount_yocto, 1, MAX_TEST_YOCTO); hash32(context_hash); hash32(job_binding_hash)
    if buyer_id != config.registry_id:
        raise PaymentError('pilot buyer must be the configured self-owned registry')
    if buyer_id == provider_id or provider_id == config.escrow_id:
        raise PaymentError('distinct buyer/provider/escrow required')
    value = {'job_id': job_id, 'buyer': buyer_id, 'provider': provider_id, 'amount': str(amount_yocto),
        'context_hash': list(bytes.fromhex(context_hash)), 'job_binding_hash': list(bytes.fromhex(job_binding_hash))}
    return call_intent(config, buyer_id, 'fund', {'terms': value}, amount_yocto + STORAGE_TOPUP)


def call_intent(config, signer_id, method, args, deposit=0):
    """NEAR JSON-RPC FunctionCall action shape; encode/sign with caller's SDK."""
    config.validate(); account(signer_id)
    if method not in ('fund', 'release', 'approve_refund', 'refund'):
        raise PaymentError('unsupported escrow action')
    return {'network_id': 'testnet', 'signer_id': signer_id, 'receiver_id': config.escrow_id,
        'actions': [{'FunctionCall': {'method_name': method,
            'args': base64.b64encode(canonical(args).encode()).decode(),
            'gas': CALL_GAS, 'deposit': str(deposit)}}]}


def decoded_view(response):
    raw = response.get('result')
    if type(raw) is not list or len(raw) > 65536 or any(type(x) is not int or not 0 <= x <= 255 for x in raw):
        raise PaymentError('invalid escrow view bytes')
    return strict_json(bytes(raw))


def exact_call_actions(actual, expected):
    """Exact action semantics; SDK JSON member order is not a financial change."""
    if type(actual) is not list or len(actual) != 1 or type(actual[0]) is not dict or set(actual[0]) != {'FunctionCall'}:
        return False
    call = actual[0]['FunctionCall']; wanted = expected[0]['FunctionCall']
    if type(call) is not dict or set(call) != set(wanted) or any(call[k] != wanted[k] for k in ('method_name', 'gas', 'deposit')):
        return False
    try:
        return strict_json(base64.b64decode(call['args'], validate=True)) == strict_json(base64.b64decode(wanted['args'], validate=True))
    except (ValueError, TypeError):
        return False


class NearTestnetEscrowClient:
    """Executable contract intents + real RPC verification, no simulated fallback.

    The caller MUST journal the signed transaction hash before broadcasting and
    never re-sign after uncertainty. This observer does not own a sending outbox.
    """
    def __init__(self, config, transport):
        self.config, self.transport = config.validate(), transport

    def _bound(self, binding):
        binding.validate()
        if binding.registry_id != self.config.registry_id or binding.registry_code_hash != self.config.registry_code_hash:
            raise Conflict('wrong configured registry')
        if binding.buyer_id != self.config.registry_id:
            raise Conflict('pilot buyer must be the configured self-owned registry')
        if binding.provider_id == self.config.escrow_id:
            raise Conflict('provider cannot be escrow')

    def inspect(self, job_id):
        u64(job_id, 1)
        status = self.transport.status()
        if status.get('chain_id') != 'testnet' or status.get('sync_info', {}).get('syncing') is not False:
            raise PaymentError('synchronized testnet required')
        code = self.transport.account(self.config.escrow_id)
        if code.get('code_hash') != self.config.escrow_code_hash:
            raise Conflict('escrow code hash changed or unreviewed')
        block = chain_hash(code.get('block_hash')); height = natural(code.get('block_height'), 1)
        def view(method, args):
            response = self.transport.view(self.config.escrow_id, method, args, block)
            if response.get('block_hash') != block or response.get('block_height') != height:
                raise Conflict('escrow view block mismatch')
            return decoded_view(response)
        if view('registry', {}) != self.config.registry_id or view('storage_topup', {}) != str(STORAGE_TOPUP):
            raise Conflict('escrow configuration mismatch')
        return {'hold': view('get_hold', {'job_id': job_id}), 'block_hash': block, 'block_height': height}

    def release_intent(self, binding):
        self._bound(binding)
        accepted_registry(self.transport, binding)
        snapshot = self.inspect(binding.job_id)
        hold = snapshot['hold']
        if type(hold) is not dict or hold.get('terms') != terms(binding) or hold.get('state') != 'Held':
            raise Conflict('exact funded hold required; pending/paid cannot retry')
        return call_intent(self.config, binding.buyer_id, 'release',
            {'job_id': binding.job_id, 'acceptance': acceptance(binding)})

    def refund_intent(self, binding, approve=False):
        self._bound(binding)
        hold = self.inspect(binding.job_id)['hold']
        if type(hold) is not dict or hold.get('terms') != terms(binding) or hold.get('state') != 'Held':
            raise Conflict('exact held payment required')
        if not approve and hold.get('provider_approves_refund') is not True:
            raise Conflict('provider approval required before buyer refund')
        return call_intent(self.config, binding.provider_id if approve else binding.buyer_id,
            'approve_refund' if approve else 'refund', {'job_id': binding.job_id})

    def verify_release(self, tx_hash, binding):
        """Verify exact call, connected finalized outcomes AND actual payout action.

        A successful outer call, a Paid string, or one provider outcome alone is
        insufficient. RPC must expose the receipt body for the native Transfer.
        """
        self._bound(binding); chain_hash(tx_hash)
        accepted_registry(self.transport, binding)
        result = self.transport.transaction_with_receipts(tx_hash, binding.buyer_id)
        expected = call_intent(self.config, binding.buyer_id, 'release',
            {'job_id': binding.job_id, 'acceptance': acceptance(binding)})
        transaction = result.get('transaction', {})
        if (result.get('final_execution_status') != 'FINAL'
                or result.get('status') != {'SuccessValue': base64.b64encode(b'true').decode()}
                or transaction.get('hash') != tx_hash
                or any(transaction.get(key) != expected[key] for key in ('signer_id', 'receiver_id'))
                or not exact_call_actions(transaction.get('actions'), expected['actions'])):
            raise Conflict('exact final successful escrow release transaction required')
        root = result.get('transaction_outcome')
        outcomes = result.get('receipts_outcome')
        if type(root) is not dict or root.get('id') != tx_hash or type(outcomes) is not list or not 1 <= len(outcomes) <= 64:
            raise Conflict('missing escrow execution outcomes')
        nodes = {}
        for node in [root] + outcomes:
            if type(node) is not dict: raise PaymentError('invalid outcome')
            key = chain_hash(node.get('id')); chain_hash(node.get('block_hash'))
            if key in nodes: raise Conflict('duplicate escrow outcome')
            outcome = node.get('outcome', {})
            status = outcome.get('status')
            children = outcome.get('receipt_ids')
            if type(children) is not list or len(set(children)) != len(children): raise Conflict('invalid receipt links')
            for child in children: chain_hash(child)
            if type(status) is not dict or len(status) != 1: raise Conflict('invalid outcome status')
            if 'SuccessReceiptId' in status:
                if status['SuccessReceiptId'] not in children: raise Conflict('unlinked success receipt')
            elif 'SuccessValue' in status:
                try: base64.b64decode(status['SuccessValue'], validate=True)
                except (ValueError, TypeError): raise Conflict('invalid success bytes') from None
            else: raise Conflict('failed or unknown escrow receipt')
            nodes[key] = node
        seen, pending = set(), [tx_hash]
        while pending:
            key = pending.pop()
            if key in seen or key not in nodes: raise Conflict('incomplete or cyclic escrow receipt tree')
            seen.add(key); pending.extend(nodes[key]['outcome']['receipt_ids'])
        if seen != set(nodes): raise Conflict('unrelated outcome')
        receipts = result.get('receipts')
        if type(receipts) is not list or len(receipts) > 64: raise Conflict('actual receipt bodies required')
        payouts = []
        for receipt in receipts:
            if (type(receipt) is dict and receipt.get('predecessor_id') == self.config.escrow_id
                    and receipt.get('receiver_id') == binding.provider_id
                    and receipt.get('receipt', {}).get('Action', {}).get('actions') == [{'Transfer': {'deposit': str(binding.amount_yocto)}}]):
                payouts.append(receipt.get('receipt_id'))
        if len(payouts) != 1 or payouts[0] not in nodes:
            raise Conflict('one exact escrow-to-provider native transfer receipt required')
        payout = nodes[payouts[0]]
        if payout['outcome'].get('executor_id') != binding.provider_id or payout['outcome']['status'] != {'SuccessValue': ''}:
            raise Conflict('native payout receipt did not execute successfully')
        snapshot = self.inspect(binding.job_id)
        hold = snapshot['hold']
        if type(hold) is not dict or hold.get('state') != 'Paid' or hold.get('terms') != terms(binding) or hold.get('acceptance') != acceptance(binding):
            raise Conflict('exact paid escrow state required')
        for block_hash in {node['block_hash'] for node in nodes.values()}:
            header = self.transport.block(block_hash).get('header', {})
            if header.get('hash') != block_hash or natural(header.get('height'), 1) > snapshot['block_height']:
                raise Conflict('outcome block inconsistent with finalized escrow state')
        return {'network': 'testnet', 'asset': 'native_test_NEAR', 'amount_yocto': str(binding.amount_yocto),
            'transaction_hash': tx_hash, 'payout_receipt_id': payouts[0], 'state': 'verified_nope_testnet_escrow_payout',
            'authority': 'trusted_testnet_rpc', 'market_settlement': False, 'escrow': True,
            'registry_and_payment_one_transaction': False, 'escrow_observation_block': snapshot['block_hash'],
            'registry_id': binding.registry_id, 'escrow_id': self.config.escrow_id,
            'job_id': binding.job_id, 'buyer_id': binding.buyer_id, 'provider_id': binding.provider_id,
            'registry_receipt_hash': binding.receipt_hash, 'ciphertext_output_hash': binding.output_hash,
            'context_hash': binding.context_hash, 'attempt': binding.attempt,
            'job_binding_hash': binding.job_binding_hash, 'attempt_binding_hash': binding.attempt_binding_hash,
            'escrow_code_hash': self.config.escrow_code_hash, 'registry_code_hash': self.config.registry_code_hash,
            'mpc_winning_price_proven': False, 'payout_amount_public': True}
