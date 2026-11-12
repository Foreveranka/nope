"""Synthetic offline receipt tests, never a live settlement claim."""
import base64
import copy
import json
import unittest

from payments.model import PaymentError
from payments.near_testnet_escrow import (EscrowConfig, NearTestnetEscrowClient,
    acceptance, call_intent, fund_intent, terms)
from payments.tests.test_near_testnet import OfflineRPC, TX, B1, B2, CODE, binding as original_binding, outcome


def binding(**changes):
    return original_binding(registry_id='buyer.testnet', **changes)

IDS = ['1'*31+c for c in 'ABCDEFGH']


def hold(state='Held'):
    return {'terms': terms(binding()), 'state': state, 'nonce': '1',
        'acceptance': acceptance(binding()), 'provider_approves_refund': False}


CONFIG = EscrowConfig('escrow.testnet', CODE, 'buyer.testnet', CODE)


def release():
    call_id, registry_id, callback_id, payout_id, final_id = IDS[:5]
    intent = call_intent(CONFIG, 'buyer.testnet', 'release',
        {'job_id': '1', 'acceptance': acceptance(binding())})
    return {'final_execution_status': 'FINAL', 'status': {'SuccessValue': 'dHJ1ZQ=='},
        'transaction': {'hash': TX, **{key: intent[key] for key in ('signer_id', 'receiver_id', 'actions')}},
        'transaction_outcome': outcome(TX, B2, 'buyer.testnet', {'SuccessReceiptId': call_id}, [call_id]),
        'receipts_outcome': [
            outcome(call_id, B2, 'escrow.testnet', {'SuccessReceiptId': callback_id}, [registry_id, callback_id]),
            outcome(registry_id, B2, 'registry.testnet', {'SuccessValue': 'bnVsbA=='}, []),
            outcome(callback_id, B2, 'escrow.testnet', {'SuccessReceiptId': final_id}, [payout_id, final_id]),
            outcome(payout_id, B2, 'provider.testnet', {'SuccessValue': ''}, []),
            outcome(final_id, B2, 'escrow.testnet', {'SuccessValue': 'dHJ1ZQ=='}, [])],
        'receipts': [{'receipt_id': payout_id, 'predecessor_id': 'escrow.testnet', 'receiver_id': 'provider.testnet',
            'receipt': {'Action': {'actions': [{'Transfer': {'deposit': str(10**21)}}]}}}]}


class OfflineEscrowRPC(OfflineRPC):
    def __init__(self): super().__init__(); self.hold = hold(); self.height = 103; self.release = release()
    def view(self, account_id, method, args, block_hash):
        value = {'registry': 'buyer.testnet', 'storage_topup': str(2*10**22), 'get_hold': self.hold}[method]
        return {'result': list(json.dumps(value).encode()), 'block_hash': B1, 'block_height': self.height}
    def transaction_with_receipts(self, tx_hash, sender_id): return copy.deepcopy(self.release)


class EscrowClientTests(unittest.TestCase):
    def setUp(self): self.rpc = OfflineEscrowRPC(); self.client = NearTestnetEscrowClient(CONFIG, self.rpc)

    def test_real_function_call_intents_have_exact_native_deposit(self):
        intent = fund_intent(CONFIG, '1', 'buyer.testnet', 'provider.testnet', 10**21, '01'*32, '02'*32)
        action = intent['actions'][0]['FunctionCall']
        self.assertEqual(action['method_name'], 'fund')
        self.assertEqual(action['deposit'], str(10**21+2*10**22))
        self.assertEqual(json.loads(base64.b64decode(action['args'])), {'terms': terms(binding())})
        self.assertEqual(self.client.release_intent(binding())['actions'][0]['FunctionCall']['deposit'], '0')

    def test_release_requires_current_accepted_job_and_exact_held_terms(self):
        for state in ['Verifying', 'PayoutPending', 'Paid', 'RefundPending', 'Refunded', None]:
            self.rpc.hold = hold(state)
            with self.assertRaises(PaymentError): self.client.release_intent(binding())
        self.rpc.hold = hold(); self.rpc.hold['terms']['amount'] = '1'
        with self.assertRaises(PaymentError): self.client.release_intent(binding())
        self.rpc.hold = hold(); self.rpc.value['state'] = 'Reported'
        with self.assertRaises(PaymentError): self.client.release_intent(binding())

    def test_refund_requires_separate_provider_approval(self):
        with self.assertRaises(PaymentError): self.client.refund_intent(binding())
        self.assertEqual(self.client.refund_intent(binding(), approve=True)['signer_id'], 'provider.testnet')
        self.rpc.hold['provider_approves_refund'] = True
        self.assertEqual(self.client.refund_intent(binding())['signer_id'], 'buyer.testnet')

    def test_actual_final_transfer_receipt_and_exact_paid_state(self):
        self.rpc.hold = hold('Paid')
        evidence = self.client.verify_release(TX, binding())
        self.assertTrue(evidence['escrow']); self.assertFalse(evidence['market_settlement'])
        self.assertEqual(evidence['payout_receipt_id'], IDS[3])

    def test_sdk_json_argument_order_is_equivalent_but_duplicate_keys_fail(self):
        self.rpc.hold = hold('Paid')
        call = self.rpc.release['transaction']['actions'][0]['FunctionCall']
        reordered = {'job_id': '1', 'acceptance': acceptance(binding())}
        call['args'] = base64.b64encode(json.dumps(reordered).encode()).decode()
        self.client.verify_release(TX, binding())
        call['args'] = base64.b64encode(b'{"job_id":"1","job_id":"2","acceptance":{}}').decode()
        with self.assertRaises(PaymentError): self.client.verify_release(TX, binding())

    def test_paid_string_success_call_or_transfer_body_alone_not_enough(self):
        self.rpc.hold = hold('Paid')
        mutations = []
        value = release(); value['receipts'] = []; mutations.append(value)
        value = release(); value['receipts'][0]['receipt']['Action']['actions'][0]['Transfer']['deposit'] = '1'; mutations.append(value)
        value = release(); value['receipts'][0]['predecessor_id'] = 'attacker.testnet'; mutations.append(value)
        value = release(); value['receipts_outcome'][3]['outcome']['status'] = {'Failure': {}}; mutations.append(value)
        value = release(); value['receipts_outcome'].pop(); mutations.append(value)
        value = release(); value['final_execution_status'] = 'EXECUTED_OPTIMISTIC'; mutations.append(value)
        value = release(); value['status'] = {'SuccessValue': 'ZmFsc2U='}; mutations.append(value)
        value = release(); value['transaction']['actions'][0]['FunctionCall']['deposit'] = '1'; mutations.append(value)
        value = release(); value['transaction']['signer_id'] = 'attacker.testnet'; mutations.append(value)
        for i, value in enumerate(mutations):
            self.rpc.release = value
            with self.subTest(i=i), self.assertRaises(PaymentError): self.client.verify_release(TX, binding())
        self.rpc.release = release(); self.rpc.hold['acceptance']['receipt_hash'] = [9]*32
        with self.assertRaises(PaymentError): self.client.verify_release(TX, binding())

    def test_mainnet_self_funding_wrong_registry_and_code_drift_fail(self):
        with self.assertRaises(PaymentError): EscrowConfig('escrow.near', CODE, 'registry.testnet', CODE).validate()
        with self.assertRaises(PaymentError): fund_intent(CONFIG, '1', 'buyer.testnet', 'buyer.testnet', 1, '01'*32, '02'*32)
        rpc = OfflineEscrowRPC()
        client = NearTestnetEscrowClient(EscrowConfig('escrow.testnet', B2, 'buyer.testnet', CODE), rpc)
        with self.assertRaises(PaymentError): client.inspect('1')


if __name__ == '__main__': unittest.main()
