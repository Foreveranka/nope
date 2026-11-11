"""Official REST schema fixtures + full urllib boundary, no financial network calls."""
import copy
import io
import json
import tempfile
import unittest
import urllib.error
from dataclasses import replace
from email.message import Message
from pathlib import Path
from urllib.parse import parse_qs, urlsplit
from unittest.mock import patch
from payments.http import Credential, HTTPS, TransportError
from payments.interface import Action, Binding, Delivery, Money
from payments.market import MarketREST, NearMarketAdapter, Scope
from payments.model import Conflict, PaymentError, Unsupported
from payments.openapi import OfficialContract

FIXTURES = Path(__file__).resolve().parents[1] / 'fixtures'
DATA = json.loads((FIXTURES / 'official-rest-sanitized.json').read_text())

def uid(i):
    return '00000000-0000-4000-8000-%012d' % i


def binding():
    return Binding('1'*64, 'synthetic-attempt', uid(1), uid(2), uid(3), uid(4), '2'*64, '3'*64, Money(80_000_000))


class Response:
    def __init__(self, value, status=200, raw=None, content_type='application/json', headers=None):
        self.status = status
        self.stream = io.BytesIO(json.dumps(value).encode() if raw is None else raw)
        self.headers = Message()
        self.headers['Content-Type'] = content_type
        for k, v in (headers or {}).items():
            self.headers[k] = v
    def read1(self, size): return self.stream.read(size)
    def __enter__(self): return self
    def __exit__(self, *args): return False


class Wire:
    """Sanitized private response fixtures; this is NOT the live Market server."""
    def __init__(self):
        self.data = copy.deepcopy(DATA)
        self.requests = []
        self.error = None
        self.repeat_page = False
        self.schema_fault = False
    def open(self, request, timeout):
        self.requests.append(request)
        if self.error:
            raise self.error
        path = urlsplit(request.full_url).path
        query = parse_qs(urlsplit(request.full_url).query)
        op = {'/v1/me':'get_me', '/v1/jobs/'+uid(1):'get_job',
              '/v1/jobs/'+uid(1)+'/bids':'list_bids_on_job',
              '/v1/agents/me/assignments':'list_my_agent_assignments',
              '/v1/wallet/ledger':'list_ledger',
              '/v1/assignments/'+uid(3)+'/deliverable/versions':'list_deliverable_versions'}[path]
        value = copy.deepcopy(self.data[op])
        if int(query.get('offset', ['0'])[0]) and not self.repeat_page:
            key = {'list_bids_on_job':'bids', 'list_my_agent_assignments':'assignments', 'list_ledger':'entries'}[op]
            value[key] = []
        if self.schema_fault and op == 'get_job':
            del value['isPrivate']
        return Response(value)


class MarketTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.wire = Wire()
        self.buyer = MarketREST(Scope('buyer',uid(5),(uid(1),),(uid(3),)),
                                lambda: Credential('buyer',uid(5),'unit-test-buyer-secret'))
        self.worker = MarketREST(Scope('worker',uid(4),(uid(1),),(uid(3),)),
                                 lambda: Credential('worker',uid(4),'aat_'+'0'*32))
        self.buyer.http.opener = self.worker.http.opener = self.wire
        self.db = Path(self.temp.name)/'plans.sqlite3'
        self.adapter = NearMarketAdapter(self.db,self.buyer,self.worker)
        self.b = binding()
    def tearDown(self): self.temp.cleanup()
    def test_all_private_fixtures_use_pinned_real_schema(self):
        for op, value in DATA.items():
            if not op.startswith('_'):
                OfficialContract().response(op,200,value)
        OfficialContract().response('healthz',200,json.loads((FIXTURES/'official-health.json').read_text()))
    def test_schema_drift_or_tampered_pin_blocks(self):
        with patch('pathlib.Path.read_bytes', return_value=b'{}'):
            with self.assertRaises(Unsupported): OfficialContract()
        self.wire.schema_fault=True
        with self.assertRaises(PaymentError): self.buyer.read('get_job',{'id':uid(1)})
    def test_authenticated_scoped_get_only(self):
        self.assertEqual(self.buyer.read('get_job',{'id':uid(1)})['jobId'],uid(1))
        self.assertTrue(all(r.method=='GET' for r in self.wire.requests))
        self.assertTrue(all(r.get_header('Authorization')=='Bearer unit-test-buyer-secret' for r in self.wire.requests))
        with self.assertRaises(Unsupported): self.buyer.read('get_job',{'id':uid(99)})
        with self.assertRaises(Unsupported): self.buyer.read('submit_assignment',{'id':uid(3)})
        with self.assertRaises(Unsupported): self.worker.read('list_ledger')
    def test_wrong_buyer_or_credential_role_rejected(self):
        self.wire.data['get_me']['account']['account_id']=uid(10)
        with self.assertRaises(Conflict):self.buyer.read('get_job',{'id':uid(1)})
        self.assertEqual(len(self.wire.requests),1)
        self.buyer.http.provider=lambda:Credential('worker',uid(5),'secret')
        with self.assertRaises(TransportError):self.buyer.read('get_me')
    def test_worker_identity_checked(self):
        self.wire.data['list_my_agent_assignments']['assignments'][0]['assignment']['workerAgentId']=uid(10)
        with self.assertRaises(Conflict):self.adapter.assignment(self.b)
    def test_unknown_request_param_no_io(self):
        with self.assertRaises(PaymentError):self.buyer.read('get_job',{'id':uid(1)},{'secret':'x'})
        self.assertEqual(self.wire.requests,[])
    def test_pagination_uses_actual_rows_even_when_clamped(self):
        list(self.buyer.pages('list_bids_on_job','bids',{'id':uid(1)},page_size=50))
        urls=[r.full_url for r in self.wire.requests if '/bids?' in r.full_url]
        self.assertIn('offset=1',urls[-1])
    def test_repeated_page_or_cap_not_complete(self):
        self.wire.repeat_page=True
        with self.assertRaises(Conflict):list(self.buyer.pages('list_ledger','entries'))
        self.wire.repeat_page=False
        with self.assertRaises(Unsupported):list(self.buyer.pages('list_ledger','entries',max_pages=1))
    def test_award_exact_binding_local_durable_plan(self):
        plan=self.adapter.prepare('award-1',Action.AWARD,self.b)
        self.assertFalse(plan['dispatch_allowed'])
        self.assertEqual(plan['arguments'],{'job_id':uid(1),'bid_id':uid(2)})
        restart=NearMarketAdapter(self.db,self.buyer,self.worker)
        self.assertEqual(plan,restart.prepare('award-1',Action.AWARD,self.b))
        with self.assertRaises(Conflict):restart.prepare('award-1',Action.RELEASE,self.b)
        self.assertTrue(all(r.method=='GET' for r in self.wire.requests))
        content=self.db.read_bytes()
        self.assertNotIn(b'unit-test-buyer-secret',content)
        self.assertNotIn(b'Synthetic procurement',content)
    def test_wrong_price_worker_job_and_private_terms_fail(self):
        for field,value in [('amount','80.000001'),('bidderAgentId',uid(9)),('jobId',uid(9)),('status','accepted')]:
            with self.subTest(field=field):
                self.wire.data=copy.deepcopy(DATA)
                self.wire.data['list_bids_on_job']['bids'][0][field]=value
                with self.assertRaises(Conflict):self.adapter.prepare('bad-'+field,Action.AWARD,self.b)
        for field,value in [('isPrivate',False),('maxSlots',2),('budgetToken','USD'),('isTestRun',True),('jobKind','competition')]:
            with self.subTest(field=field):
                self.wire.data=copy.deepcopy(DATA);self.wire.data['get_job'][field]=value
                with self.assertRaises(Conflict):self.adapter.prepare('bad-'+field,Action.AWARD,self.b)
    def test_hold_candidates_are_not_confirmed_money(self):
        evidence=self.adapter.hold_evidence(self.b)
        self.assertEqual(evidence['ledger_candidates'][0]['status'],'confirmed')
        self.assertFalse(evidence['confirmed_hold'])
        plan=self.adapter.prepare('hold',Action.HOLD,self.b)
        self.assertIsNone(plan['tool'])
        self.assertFalse(plan['dispatch_allowed'])
    def test_accept_is_version_bound_but_never_cas_or_release(self):
        d=Delivery(1,'a'*64,'b'*64)
        plan=self.adapter.prepare('accept',Action.ACCEPT,self.b,d)
        self.assertEqual(plan['tool'],'marketplace__accept_result')
        self.assertFalse(plan['dispatch_allowed'])
        self.assertTrue(any('CAS' in b for b in plan['blockers']))
        self.assertTrue(plan['automatic_release_possible'])
        with self.assertRaises(Conflict):self.adapter.prepare('stale',Action.ACCEPT,self.b,replace(d,version=2))
        self.wire.data['list_my_agent_assignments']['assignments'][0]['assignment']['status']='disputed'
        with self.assertRaises(Conflict):self.adapter.prepare('dispute',Action.ACCEPT,self.b,d)
    def test_missing_worker_and_unknown_assignment_block(self):
        with self.assertRaises(Unsupported):NearMarketAdapter(self.db,self.buyer).prepare('a',Action.ACCEPT,self.b,Delivery(1,'a'*64,'b'*64))
        self.wire.data['list_my_agent_assignments']['assignments']=[]
        with self.assertRaises(Conflict):self.adapter.hold_evidence(self.b)
    def test_release_never_invents_a_remote_endpoint(self):
        plan=self.adapter.prepare('release',Action.RELEASE,self.b)
        self.assertIsNone(plan['tool'])
        with self.assertRaises(Unsupported):self.adapter.execute(None)
        self.assertFalse(self.adapter.capabilities()['separate_release_endpoint'])
    def test_unknown_recovery_restart_no_retry_or_state_inference(self):
        self.adapter.mark_unknown('lost',Action.ACCEPT,self.b)
        restart=NearMarketAdapter(self.db,self.buyer,self.worker)
        # Even confirmed ledger rows + accepted assignment do not identify this call.
        self.wire.data['list_my_agent_assignments']['assignments'][0]['assignment']['status']='accepted'
        result=restart.reconcile('lost',Action.ACCEPT,self.b)
        self.assertEqual(result['state'],'unknown')
        self.assertFalse(result['redispatch_allowed'])
        with self.assertRaises(Conflict):restart.mark_unknown('lost',Action.AWARD,self.b)
        self.wire.error=TimeoutError('unit-test-buyer-secret')
        result=restart.reconcile('lost',Action.ACCEPT,self.b)
        self.assertEqual(result['reason'],'READ_INCOMPLETE_OR_FAILED')
        self.assertNotIn('unit-test-buyer-secret',str(result))
        self.assertTrue(all(r.method=='GET' for r in self.wire.requests))


class TransportTests(unittest.TestCase):
    def client(self, response):
        h=HTTPS(lambda:Credential('buyer',uid(5),'private-test-token'))
        class Opener:
            def open(self,req,timeout):
                if isinstance(response,Exception):raise response
                return response
        h.opener=Opener()
        return h
    def test_redacted_http_error_timeout_not_retried(self):
        for error in [TimeoutError('private-test-token'),urllib.error.HTTPError('https://secret',401,'private-test-token',{},io.BytesIO(b'private-test-token'))]:
            with self.subTest(error=type(error).__name__):
                with self.assertRaises(TransportError) as ctx:self.client(error).json('GET','/v1/me',role='buyer',principal=uid(5))
                self.assertNotIn('private-test-token',str(ctx.exception))
    def test_invalid_or_duplicate_json_and_oversize_fail(self):
        for raw in [b'{"a":1,"a":2}',b'{"a":NaN}',b'not json']:
            with self.assertRaises(TransportError):self.client(Response(None,raw=raw)).json('GET','/healthz')
        h=self.client(Response(None,raw=b' '*100));h.max_bytes=10
        with self.assertRaises(TransportError):h.json('GET','/healthz')
    def test_origin_redirect_and_format_fail_closed(self):
        for target in ['https://evil.test/','//evil.test/','/../secret','/bad\r\npath']:
            with self.assertRaises(Unsupported):self.client(Response({})).json('GET',target)
        with self.assertRaises(TransportError):self.client(Response({},content_type='text/html')).json('GET','/healthz')
        h=HTTPS()
        request=__import__('urllib.request',fromlist=['Request']).Request('https://market.near.ai/healthz')
        handler=__import__('payments.http',fromlist=['NoRedirect']).NoRedirect()
        self.assertIsNone(handler.redirect_request(request,None,302,'',{},'https://evil.test/'))
    def test_mcp_sse_is_correlated_and_bounded(self):
        message=b': keepalive\n\nevent: message\ndata: {"jsonrpc":"2.0","method":"notifications/progress","params":{}}\n\nevent: message\ndata: {"jsonrpc":"2.0","id":"r1","result":{"ok":true}}\n\n'
        status,value,headers=self.client(Response(None,raw=message,content_type='text/event-stream')).json(
            'POST','/mcp',{'jsonrpc':'2.0','id':'r1','method':'tools/list'})
        self.assertEqual(value['result'],{'ok':True})
        with self.assertRaises(TransportError):self.client(Response(None,raw=message,content_type='text/event-stream')).json(
            'POST','/mcp',{'jsonrpc':'2.0','id':'other','method':'tools/list'})
        with self.assertRaises(TransportError):self.client(Response(None,raw=b'data: prose\n\n',content_type='text/event-stream')).json(
            'POST','/mcp',{'jsonrpc':'2.0','id':'r1','method':'tools/list'})

    def test_finite_timeout_and_hidden_credential_repr(self):
        for timeout in [0,61,float('nan'),True]:
            with self.assertRaises(PaymentError):HTTPS(timeout=timeout)
        self.assertNotIn('private-test-token',repr(Credential('buyer',uid(5),'private-test-token')))
    def test_numeric_format_and_invalid_uuid_validated(self):
        c=OfficialContract()
        with self.assertRaises(PaymentError):c.request('get_job',{'id':'not-uuid'})
        value=copy.deepcopy(DATA['get_job']);value['maxSlots']=2**40
        with self.assertRaises(PaymentError):c.response('get_job',200,value)
        with self.assertRaises(PaymentError):c.response('get_job',200,dict(DATA['get_job'],status='invented'))

if __name__=='__main__':unittest.main()
