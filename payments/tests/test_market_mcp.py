"""Protocol mocks, NOT captured authenticated Market tool schemas.

Real schema-backed REST fixtures are exercised by test_market. Future atomic
accept schemas here are hypothetical solely to test fail-closed capability gates.
"""
import copy
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch
from payments.http import Credential
from payments.interface import Action, Command, Delivery
from payments.market_mcp import MarketMCP, MarketMCPTransport, PROTOCOL
from payments.market_writes import FinancialWriteAdapter, ReviewedWriteCapability, WriteAuthorization
from payments.model import Conflict, PaymentError, Unsupported, binding_hash
from payments.tests.test_market import Response, binding, uid
from payments.tests import test_market as rest_tests


def tool(name, fields, output=None):
    return {'name':name,'inputSchema':{'type':'object','properties':fields,'required':list(fields),'additionalProperties':False},
            'outputSchema': output or {'type':'object','properties':{'observed':{'type':'boolean'}},'required':['observed']}}


class ProtocolWire:
    def __init__(self):
        self.requests=[]
        self.tools=[]
        self.failure=None
        self.protocol=PROTOCOL
        self.wrong_id=False
        self.structured=True
    def open(self,request,timeout):
        import json
        body=json.loads(request.data)
        self.requests.append((request,body))
        method=body['method']
        if method=='notifications/initialized':return Response(None,status=202,raw=b'')
        if method=='initialize':result={'protocolVersion':self.protocol,'serverInfo':{'name':'EXPLICIT_PROTOCOL_MOCK','version':'1.0.0'},'capabilities':{'tools':{}}}
        elif method=='tools/list':result={'tools':self.tools}
        elif method=='tools/call':
            if self.failure:raise self.failure
            name=body['params']['name']
            content={'account':uid(5)} if name=='marketplace__whoami' else {'observed':True}
            result={'structuredContent':content} if self.structured else {'content':[{'type':'text','text':'not evidence'}]}
        else:raise AssertionError(method)
        return Response({'jsonrpc':'2.0','id':'wrong' if self.wrong_id else body['id'],'result':result},headers={'Mcp-Session-Id':'test-session'})


def connected(endpoint='/mcp', extra=()):
    transport=MarketMCPTransport(lambda:Credential('buyer_mcp',uid(5),'injected-secret'),uid(5),endpoint=endpoint)
    wire=ProtocolWire()
    transport.http.opener=wire
    transport.initialize()
    who=tool('marketplace__whoami',{}, {'type':'object','properties':{'account':{'type':'string'}},'required':['account']})
    wire.tools=[who]+list(extra)
    client=MarketMCP(transport,job_ids=(uid(1),),assignment_ids=(uid(3),),identity_resolver=lambda value:value['account'])
    client.discover()
    client.pins={t['name']:client.fingerprint(t) for t in wire.tools}
    return client,wire


class MCPTransportTests(unittest.TestCase):
    def test_real_envelope_negotiation_session_schema_pins(self):
        c,w=connected(extra=[tool('marketplace__get_job',{'job_id':{'type':'string','format':'uuid'}})])
        self.assertEqual(c.read_tool('marketplace__whoami',{}),{'account':uid(5)})
        c.read_tool('marketplace__get_job',{'job_id':uid(1)})
        self.assertTrue(all(r.full_url=='https://market.near.ai/mcp' for r,b in w.requests))
        self.assertTrue(any(r.get_header('Mcp-session-id')=='test-session' for r,b in w.requests))
        c.pins={}
        with self.assertRaises(Unsupported):c.read_tool('marketplace__whoami',{})
    def test_no_financial_call_through_read_surface(self):
        c,w=connected('/mcp/pro')
        n=len(w.requests)
        for name in ['marketplace__award_bid','marketplace__accept_result','marketplace__create_job','marketplace__call_connector_tool']:
            with self.assertRaises(Unsupported):c.read_tool(name,{})
            with self.assertRaises(Unsupported):c.transport.call_tool(name,{})
        self.assertEqual(n,len(w.requests))
    def test_wrong_resource_protocol_or_envelope_blocks(self):
        c,w=connected(extra=[tool('marketplace__get_job',{'job_id':{'type':'string'}})])
        with self.assertRaises(Unsupported):c.read_tool('marketplace__get_job',{'job_id':uid(9)})
        w.wrong_id=True
        with self.assertRaises(PaymentError):c.read_tool('marketplace__whoami',{})
        w.wrong_id=False;w.protocol='unsupported'
        with self.assertRaises(Unsupported):c.transport.initialize()
        self.assertFalse(c.transport.authenticated)
    def test_text_only_output_or_schema_drift_is_not_confirmation(self):
        c,w=connected()
        w.structured=False
        with self.assertRaises(Unsupported):c.read_tool('marketplace__whoami',{})
        w.tools[0]['outputSchema']['required'].append('new')
        with self.assertRaises(Conflict):c.discover()
    def test_endpoint_pinned(self):
        for target in ['/mcp/pro/other','https://evil.test/','/oauth/register']:
            with self.assertRaises(Unsupported):MarketMCPTransport(lambda:None,uid(5),endpoint=target)


class PreparationTests(unittest.TestCase):
    def setUp(self):
        self.tmp=tempfile.TemporaryDirectory();self.db=Path(self.tmp.name)/'prepare.db'
        self.prep=tool('marketplace__prepare_job',{'client_request_id':{'type':'string'},'token':{'enum':['USDC']},
                    'worker_agent_id':{'type':'string'},'title':{'type':'string'},'description':{'type':'string'}})
        self.c,self.w=connected(extra=[self.prep])
        self.args={'client_request_id':'draft-1','token':'USDC','worker_agent_id':uid(4),'title':'synthetic','description':'no private data'}
    def tearDown(self):self.tmp.cleanup()
    def count(self):return sum(b['method']=='tools/call' and b['params']['name']=='marketplace__prepare_job' for r,b in self.w.requests)
    def test_nonfinancial_draft_replay_and_payload_conflict(self):
        p=self.c.plan_tool('marketplace__prepare_job',self.args)
        self.assertFalse(p['remote_call_performed'])
        result=self.c.prepare_hire(self.db,'draft-1',self.args)
        self.assertEqual(result['state'],'observed');self.assertFalse(result['financial_confirmation'])
        result=self.c.prepare_hire(self.db,'draft-1',self.args)
        self.assertFalse(result['remote_call_performed']);self.assertEqual(self.count(),1)
        with self.assertRaises(Conflict):self.c.prepare_hire(self.db,'draft-1',dict(self.args,title='changed'))
        self.assertNotIn(b'injected-secret',self.db.read_bytes())
        self.assertNotIn(b'no private data',self.db.read_bytes())
    def test_draft_timeout_stays_unknown_no_auto_retry(self):
        original=self.c.transport.prepare_tool
        self.c.transport.prepare_tool=lambda args:(_ for _ in ()).throw(TimeoutError('secret'))
        result=self.c.prepare_hire(self.db,'draft-1',self.args)
        self.assertEqual(result['state'],'unknown')
        self.c.transport.prepare_tool=original
        result=self.c.prepare_hire(self.db,'draft-1',self.args)
        self.assertFalse(result['remote_call_performed'])
        result=self.c.prepare_hire(self.db,'draft-1',self.args,reconcile=True)
        self.assertEqual(result['state'],'observed');self.assertEqual(self.count(),1)
    def test_crash_sent_requires_explicit_operator_recovery_same_key(self):
        self.c.transport.prepare_tool=lambda args:(_ for _ in ()).throw(KeyboardInterrupt())
        with self.assertRaises(KeyboardInterrupt):self.c.prepare_hire(self.db,'draft-1',self.args)
        self.assertEqual(self.c.prepare_hire(self.db,'draft-1',self.args,reconcile=True)['state'],'sent')
        self.c.recover_crashed_draft(self.db,'draft-1')
        self.assertEqual(self.c.prepare_hire(self.db,'draft-1',self.args)['state'],'unknown')
    def test_missing_identity_or_wrong_endpoint_blocks(self):
        self.c.identity_resolver=None
        with self.assertRaises(Unsupported):self.c.prepare_hire(self.db,'draft-1',self.args)
        self.c.transport.endpoint='/mcp/pro'
        with self.assertRaises(Unsupported):self.c.prepare_hire(self.db,'draft-1',self.args)


class FinancialGateTests(unittest.TestCase):
    """All dispatches use ProtocolWire; no live /mcp/pro requests occur."""
    def setUp(self):
        self.rest=rest_tests.MarketTests();self.rest.setUp()
        self.tmp=tempfile.TemporaryDirectory();self.db=Path(self.tmp.name)/'financial.db'
        self.award=tool('marketplace__award_bid',{'job_id':{'type':'string'},'bid_id':{'type':'string'}})
        self.accept=tool('marketplace__accept_result',{'job_id':{'type':'string'},'assignment_id':{'type':'string'}})
        self.c,self.w=connected('/mcp/pro',[self.award,self.accept])
        self.writer=FinancialWriteAdapter(self.db,self.c,self.rest.adapter,lambda b,d:True)
        self.auth=WriteAuthorization(True,uid(5),'shared-budget',80_000_000,binding_hash(binding()),(Action.AWARD,Action.ACCEPT))
        self.cap=ReviewedWriteCapability(self.award['name'],self.c.fingerprint(self.award),
                       'https://docs.market.near.ai/mcp/pro',False,{'job_id':'job_id','bid_id':'bid_id'},{})
        self.cmd=Command('award-1',Action.AWARD,binding())
    def tearDown(self):self.rest.tearDown();self.tmp.cleanup()
    def financial_count(self):return sum(b['method']=='tools/call' and b['params']['name'] in (self.award['name'],self.accept['name']) for r,b in self.w.requests)
    def test_real_financial_transport_offline_authorized_exact_bid_no_retry(self):
        result=self.writer.perform(self.cmd,self.auth,self.cap)
        self.assertEqual(result['state'],'observed');self.assertFalse(result['settlement_confirmed'])
        self.writer.perform(self.cmd,self.auth,self.cap)
        self.assertEqual(self.financial_count(),1)
        req=[r for r,b in self.w.requests if b['method']=='tools/call' and b['params']['name']==self.award['name']][0]
        self.assertEqual(req.full_url,'https://market.near.ai/mcp/pro')
        with self.assertRaises(Conflict):self.writer.perform(Command('new-id',Action.AWARD,binding()),self.auth,self.cap)
        self.assertNotIn(b'injected-secret',self.db.read_bytes())
    def test_missing_budget_role_capability_pin_or_auth_no_dispatch(self):
        from dataclasses import replace
        cases=[(replace(self.auth,approved=False),self.cap),(replace(self.auth,principal=uid(9)),self.cap),
               (replace(self.auth,budget_micros=1),self.cap),(self.auth,None),
               (self.auth,replace(self.cap,schema_hash='0'*64))]
        for auth,cap in cases:
            with self.subTest(auth=auth):
                with self.assertRaises((Unsupported,Conflict)):self.writer.perform(self.cmd,auth,cap)
        self.assertEqual(self.financial_count(),0)
    def test_unknown_keeps_budget_and_new_id_lock_after_restart(self):
        original=self.c.transport.call_financial_tool
        self.c.transport.call_financial_tool=lambda n,a:(_ for _ in ()).throw(TimeoutError('injected-secret'))
        self.assertEqual(self.writer.perform(self.cmd,self.auth,self.cap)['state'],'unknown')
        self.c.transport.call_financial_tool=original
        restart=FinancialWriteAdapter(self.db,self.c,self.rest.adapter)
        self.assertEqual(restart.perform(self.cmd,self.auth,self.cap)['state'],'unknown')
        with self.assertRaises(Conflict):restart.perform(Command('new-id',Action.AWARD,binding()),self.auth,self.cap)
        evidence=restart.reconcile('award-1',lambda op:{'status':'accepted','jobId':uid(1)})
        self.assertEqual(evidence['state'],'unknown');self.assertFalse(evidence['settlement_confirmed'])
        self.assertEqual(self.financial_count(),0)
    def test_current_documented_accept_without_cas_cannot_dispatch(self):
        from dataclasses import replace
        cmd=Command('accept-1',Action.ACCEPT,binding(),Delivery(1,'a'*64,'b'*64))
        cap=ReviewedWriteCapability(self.accept['name'],self.c.fingerprint(self.accept),
              'https://docs.market.near.ai/mcp/pro',False,{'job_id':'job_id','assignment_id':'assignment_id'},{})
        with self.assertRaises(Unsupported):self.writer.perform(cmd,self.auth,cap)
        # A boolean assertion is insufficient: the required guards must also be
        # present in the exact discovered input schema. They are not in this mock
        # of the documented current args. This is not an official schema capture.
        with self.assertRaises(Unsupported):self.writer.perform(cmd,self.auth,replace(cap,atomic_compare_enforced=True))
        self.assertEqual(self.financial_count(),0)
    def test_atomic_accept_transport_is_implemented_for_a_hypothetical_capability(self):
        # NOT current official API evidence. Proves that a real capability, if
        # added/reviewed, enables transport rather than a hardcoded live ban.
        self.writer.perform(self.cmd,self.auth,self.cap)
        atomic=tool('marketplace__accept_result',{
            'job_id':{'type':'string'},'assignment_id':{'type':'string'},
            'expected_version':{'type':'integer'},'expected_artifact_hash':{'type':'string'}})
        self.w.tools=[self.w.tools[0],self.award,atomic]
        # A changed catalog requires explicit re-review/new boundary.
        c=MarketMCP(self.c.transport,job_ids=(uid(1),),assignment_ids=(uid(3),),identity_resolver=lambda v:v['account'])
        c.discover();c.pins={t['name']:c.fingerprint(t) for t in self.w.tools}
        cap=ReviewedWriteCapability(atomic['name'],c.fingerprint(atomic),
             'https://docs.market.near.ai/HYPOTHETICAL-TEST-NOT-OFFICIAL-EVIDENCE',True,
             {'job_id':'job_id','assignment_id':'assignment_id','delivery_version':'expected_version','artifact_sha256':'expected_artifact_hash'}, {})
        writer=FinancialWriteAdapter(self.db,c,self.rest.adapter,lambda b,d:True)
        result=writer.perform(Command('accept-cas',Action.ACCEPT,binding(),Delivery(1,'a'*64,'b'*64)),self.auth,cap)
        self.assertEqual(result['state'],'observed')
        self.assertFalse(result['settlement_confirmed'])
        self.assertEqual(self.financial_count(),2)

    def test_shared_budget_is_atomic_across_distinct_assignments(self):
        from concurrent.futures import ThreadPoolExecutor
        from dataclasses import replace
        class BoundPreflight:
            def prepare(self,op,action,b,delivery):
                return {'binding_hash':binding_hash(b),'action':action.value}
        # Budget test uses only a local preflight harness; real official-schema
        # preflight is separately exercised by every normal financial test.
        self.writer.preflight=BoundPreflight()
        bindings=[binding(),replace(binding(),job_id=uid(10),bid_id=uid(11),assignment_id=uid(12))]
        def run(i):
            try:
                b=bindings[i]
                auth=replace(self.auth,binding_hash=binding_hash(b))
                return self.writer.perform(Command('race-'+str(i),Action.AWARD,b),auth,self.cap)['state']
            except Conflict:
                return 'budget_blocked'
        with ThreadPoolExecutor(max_workers=2) as pool:
            results=list(pool.map(run,range(2)))
        self.assertEqual(sorted(results),['budget_blocked','observed'])
        self.assertEqual(self.financial_count(),1)

    def test_no_standalone_hold_or_release_transport(self):
        for action in [Action.HOLD,Action.RELEASE]:
            with self.assertRaises(Unsupported):self.writer.perform(Command('never',action,binding()),self.auth,self.cap)

if __name__=='__main__':unittest.main()
