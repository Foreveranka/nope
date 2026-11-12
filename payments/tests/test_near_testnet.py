"""Offline adversarial tests: these are authored RPC doubles, not live payments."""
import copy
import json
import tempfile
import unittest
from dataclasses import replace
from email.message import Message
from pathlib import Path

from payments.http import TransportError
from payments.model import Conflict, PaymentError, Unsupported
from payments.near_testnet import (NearTestnetRPC, NearTestnetPaymentRail,
    TestnetPaymentBinding, accepted_registry, verify_transfer)

TX, R1, R2, B1, B2, B3, CODE = ('1'*31+c for c in '2345678')


def binding(**changes):
    b = TestnetPaymentBinding('registry.testnet', CODE, '1', 'buyer.testnet',
        'provider.testnet', 10**21, '01'*32, '02'*32, '1', '03'*32, '04'*32, '05'*32)
    return replace(b, **changes)


def job():
    return {'job_id': '1', 'buyer': 'buyer.testnet', 'state': 'Accepted',
        'config': {'context_hash': [1]*32, 'executor': 'provider.testnet'},
        'job_binding_hash': [2]*32, 'attempt': '1', 'attempt_binding_hash': [3]*32,
        'attempt_binding_version': 1, 'selected_executor': None,
        'receipts': [{'receipt_hash': [4]*32, 'status': 'BuyerAccepted', 'decided_at_ns': '100',
            'claim': {'job_id': '1', 'attempt': '1', 'context_hash': [1]*32,
                'job_binding_hash': [2]*32, 'attempt_binding_hash': [3]*32, 'output_hash': [5]*32}}]}


def outcome(key, block, executor, status, children):
    return {'id': key, 'block_hash': block, 'outcome': {'executor_id': executor,
        'status': status, 'receipt_ids': children}}


def transfer():
    return {'final_execution_status': 'FINAL', 'status': {'SuccessValue': ''},
        'transaction': {'hash': TX, 'signer_id': 'buyer.testnet', 'receiver_id': 'provider.testnet',
            'actions': [{'Transfer': {'deposit': str(10**21)}}]},
        'transaction_outcome': outcome(TX, B2, 'buyer.testnet', {'SuccessReceiptId': R1}, [R1]),
        'receipts_outcome': [outcome(R1, B2, 'provider.testnet', {'SuccessValue': ''}, [R2]),
            outcome(R2, B3, 'buyer.testnet', {'SuccessValue': ''}, [])]}


class OfflineRPC:
    def __init__(self):
        self.value, self.tx, self.height, self.chain = job(), transfer(), 100, 'testnet'
    def status(self): return {'chain_id': self.chain, 'sync_info': {'syncing': False}}
    def account(self, account_id): return {'block_hash': B1, 'block_height': self.height, 'code_hash': CODE}
    def job(self, registry_id, job_id, block_hash):
        return {'result': list(json.dumps(self.value).encode()), 'block_hash': B1, 'block_height': self.height}
    def transaction(self, tx_hash, sender): return copy.deepcopy(self.tx)
    def block(self, block_hash): return {'header': {'hash': block_hash, 'height': 101 if block_hash == B2 else 102}}


class TestTransferEvidence(unittest.TestCase):
    def test_complete_success_tree(self):
        evidence = verify_transfer(transfer(), binding(), TX)
        self.assertEqual(evidence['transfer_receipt_id'], R1)
        self.assertEqual(evidence['receipt_count'], 2)

    def test_optimistic_failed_unknown_or_top_level_only_is_never_payment(self):
        for milestone in ['NONE', 'INCLUDED', 'INCLUDED_FINAL', 'EXECUTED', 'EXECUTED_OPTIMISTIC', None]:
            value = transfer(); value['final_execution_status'] = milestone
            with self.subTest(milestone=milestone), self.assertRaises(PaymentError):
                verify_transfer(value, binding(), TX)
        for status in [{'Failure': {}}, {'SuccessReceiptId': R1}, {'Unknown': None}, {}]:
            value = transfer(); value['status'] = status
            with self.assertRaises(PaymentError): verify_transfer(value, binding(), TX)
        value = transfer(); value['receipts_outcome'] = []
        with self.assertRaises(PaymentError): verify_transfer(value, binding(), TX)

    def test_exact_transaction_identity_amount_and_action(self):
        for key, bad in [('hash', R2), ('signer_id', 'attacker.testnet'), ('receiver_id', 'wrong.testnet'),
                         ('actions', [{'Transfer': {'deposit': '1'}}]),
                         ('actions', [{'FunctionCall': {'method_name': 'transfer'}}]),
                         ('actions', [{'Transfer': {'deposit': str(10**21)}}]*2)]:
            value = transfer(); value['transaction'][key] = bad
            with self.subTest(key=key), self.assertRaises(PaymentError): verify_transfer(value, binding(), TX)

    def test_missing_failed_unrelated_duplicate_and_cyclic_receipts(self):
        mutations = []
        value = transfer(); value['receipts_outcome'].pop(); mutations.append(value)
        value = transfer(); value['receipts_outcome'][1]['outcome']['status'] = {'Failure': {}}; mutations.append(value)
        value = transfer(); value['receipts_outcome'][0]['outcome']['executor_id'] = 'wrong.testnet'; mutations.append(value)
        value = transfer(); value['receipts_outcome'][1]['outcome']['receipt_ids'] = [R1]; mutations.append(value)
        value = transfer(); value['receipts_outcome'].append(copy.deepcopy(value['receipts_outcome'][0])); mutations.append(value)
        value = transfer(); value['receipts_outcome'][0]['outcome']['receipt_ids'] = []; mutations.append(value)
        value = transfer(); value['transaction_outcome']['outcome']['status'] = {'SuccessReceiptId': R2}; mutations.append(value)
        for i, value in enumerate(mutations):
            with self.subTest(i=i), self.assertRaises(PaymentError): verify_transfer(value, binding(), TX)

    def test_binding_rejects_mainnet_float_bool_zero_and_self_payment(self):
        for changes in [{'buyer_id': 'buyer.near'}, {'registry_id': 'registry.near'},
            {'amount_yocto': True}, {'amount_yocto': 1.0}, {'amount_yocto': 0}, {'amount_yocto': 10**24+1},
            {'provider_id': 'buyer.testnet'}, {'job_id': '01'}, {'attempt': '0'}, {'output_hash': 'x'*64}]:
            with self.subTest(changes=changes), self.assertRaises(PaymentError): binding(**changes).validate()


class TestRegistryAndDurability(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.path = Path(self.tmp.name)/'payments.sqlite'
        self.rpc = OfflineRPC()
        self.rail = NearTestnetPaymentRail(self.path, self.rpc)
    def tearDown(self): self.tmp.cleanup()

    def test_exact_acceptance_and_selected_executor(self):
        self.assertEqual(accepted_registry(self.rpc, binding())['block_height'], 100)
        self.rpc.value['attempt_binding_version'] = 2
        self.rpc.value['selected_executor'] = 'provider.testnet'
        accepted_registry(self.rpc, binding())
        self.rpc.value['selected_executor'] = 'attacker.testnet'
        with self.assertRaises(Conflict): accepted_registry(self.rpc, binding())

    def test_nonaccepted_or_changed_receipt_code_context_cannot_prepare(self):
        for key, bad in [('state', 'Open'), ('buyer', 'wrong.testnet'), ('attempt', '2'),
                         ('job_binding_hash', [9]*32), ('receipts', [])]:
            self.rpc.value = job(); self.rpc.value[key] = bad
            with self.subTest(key=key), self.assertRaises(PaymentError): self.rail.prepare('one', binding())
        self.rpc.value = job(); self.rpc.value['receipts'][-1]['claim']['output_hash'] = [9]*32
        with self.assertRaises(PaymentError): self.rail.prepare('one', binding())
        self.rpc.value = job(); self.rpc.chain = 'mainnet'
        with self.assertRaises(PaymentError): self.rail.prepare('one', binding())
        self.rpc.chain = 'testnet'
        with self.assertRaises(PaymentError): self.rail.prepare('one', binding(registry_code_hash=B2))

    def test_restart_reservation_immutable_job_and_no_replacement(self):
        plan = self.rail.prepare('one', binding())
        self.assertEqual(plan['state'], 'unsigned_plan')
        with self.assertRaises(Conflict): self.rail.confirm('one')
        self.rail.reserve_transaction('one', TX)
        restart = NearTestnetPaymentRail(self.path, self.rpc)
        self.assertEqual(restart.inspect('one')['tx_hash'], TX)
        with self.assertRaises(Conflict): restart.reserve_transaction('one', R2)
        with self.assertRaises(Conflict): restart.prepare('new-operation', binding())
        with self.assertRaises(Conflict): restart.prepare('one', binding(amount_yocto=2))
        self.rpc.height = 103
        verified = restart.confirm('one')
        self.assertEqual(verified['state'], 'verified_testnet_transfer')
        self.assertFalse(verified['evidence']['escrow'])
        self.assertFalse(verified['evidence']['market_settlement'])

    def test_timeout_old_transfer_missing_block_and_changed_view_stay_unconfirmed(self):
        self.rail.prepare('one', binding()); self.rail.reserve_transaction('one', TX)
        with self.assertRaises(Conflict): self.rail.confirm('one') # final view predates payment
        self.rpc.height = 103
        self.rpc.tx['receipts_outcome'].pop()
        with self.assertRaises(Conflict): self.rail.confirm('one')
        self.rpc.tx = transfer(); self.rpc.value['state'] = 'Rejected'
        with self.assertRaises(Conflict): self.rail.confirm('one')
        self.assertEqual(self.rail.inspect('one')['state'], 'awaiting_final_evidence')
        self.assertEqual(self.rail.inspect('one')['tx_hash'], TX)

    def test_one_transaction_cannot_be_assigned_to_two_jobs(self):
        self.rail.prepare('one', binding()); self.rail.reserve_transaction('one', TX)
        self.rpc.value['job_id'] = '2'; self.rpc.value['receipts'][0]['claim']['job_id'] = '2'
        self.rail.prepare('two', binding(job_id='2'))
        with self.assertRaises(Conflict): self.rail.reserve_transaction('two', TX)


class HTTPResponse:
    status = 200
    def __init__(self, raw):
        self.raw = raw; self.headers = Message(); self.headers['Content-Type'] = 'application/json'
    def __enter__(self): return self
    def __exit__(self, *args): pass
    def read(self, maximum): return self.raw[:maximum]


class OfflineOpener:
    def __init__(self, transform=lambda v: v): self.calls = []; self.transform = transform
    def open(self, request, timeout):
        body = json.loads(request.data); self.calls.append(body)
        return HTTPResponse(json.dumps(self.transform({'jsonrpc': '2.0', 'id': body['id'],
            'result': {'chain_id': 'testnet', 'sync_info': {'syncing': False}}})).encode())


class TestRealTransportConstruction(unittest.TestCase):
    def test_pinned_endpoint_and_no_mutation_surface(self):
        for url in ['https://rpc.mainnet.near.org', 'http://rpc.testnet.near.org',
                    'https://rpc.testnet.near.org/evil', 'https://rpc.testnet.near.org@evil.org']:
            with self.assertRaises(Unsupported): NearTestnetRPC(url)
        rpc = NearTestnetRPC(); rpc.opener = OfflineOpener()
        for method, params in [('send_tx', {}), ('broadcast_tx_commit', []),
            ('query', {'request_type': 'call_function', 'account_id': 'registry.testnet',
                'block_id': B1, 'method_name': 'decide_result', 'args_base64': 'e30='})]:
            with self.assertRaises(Unsupported): rpc._request(method, params)
        self.assertFalse(rpc.opener.calls)

    def test_actual_jsonrpc_wire_shapes_require_final(self):
        rpc = NearTestnetRPC(); rpc.opener = OfflineOpener()
        rpc.status(); rpc.transaction(TX, 'buyer.testnet'); rpc.job('registry.testnet', '1', B1); rpc.block(B2)
        calls = rpc.opener.calls
        self.assertEqual(calls[1]['params']['wait_until'], 'FINAL')
        self.assertEqual(calls[2]['params']['block_id'], B1)
        self.assertEqual(calls[3]['params'], {'block_id': B2})

    def test_error_wrong_id_oversize_and_mainnet_status_fail_closed(self):
        transforms = [lambda v: dict(v, id='wrong'), lambda v: dict(v, error={'message': 'secret not logged'}),
            lambda v: dict(v, result={'chain_id': 'mainnet'}), lambda v: dict(v, result=None)]
        for transform in transforms:
            rpc = NearTestnetRPC(); rpc.opener = OfflineOpener(transform)
            with self.assertRaises(PaymentError): rpc.status()
        rpc = NearTestnetRPC(max_bytes=10); rpc.opener = OfflineOpener()
        with self.assertRaises(TransportError): rpc.status()


if __name__ == '__main__': unittest.main()
