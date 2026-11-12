import json
import tempfile
import time
import unittest
from pathlib import Path
from unittest.mock import patch, Mock
from service.procurement_mount import ProcurementMount
from service.procurement_client import ProcurementClientError
from service.bid_client import BidClientError

class PublicProxy:
    def __init__(self, principal): self.principal=principal;self.calls=[]
    def request(self, method, target, authorization):
        self.calls.append((method,target,authorization))
        if target.endswith('/session'): return 200,{'principal':self.principal,'role':'buyer'}
        return 200,{'job':{'buyer':self.principal,'resultDeadlineNs':str(time.time_ns()+1200*10**9)}}
class FakeClient:
    def __init__(self,*a,**kw): self.prepared=None
    def prepare(self,draft,required,budget): self.prepared=budget;return {'id':'test-session','state':'PREPARED'}
    def close(self): pass

class MountTests(unittest.TestCase):
    def setUp(self):
        self.tmp=tempfile.TemporaryDirectory();self.addCleanup(self.tmp.cleanup)
        self.patch=patch('service.procurement_mount.ProcurementClient',FakeClient);self.patch.start();self.addCleanup(self.patch.stop)
        cfg=json.loads(Path('service/procurement-config.json').read_text())
        self.proxy=PublicProxy(cfg['registry_account']);self.mount=ProcurementMount(Path(self.tmp.name),self.proxy)
    def test_budget_only_reaches_local_client(self):
        self.mount.request('prepare',{'jobId':'ab'*16,'budget':123456},'Bearer synthetic')
        self.assertEqual(self.mount.client.prepared,123456)
        self.assertTrue(all(method=='GET' for method,_,_ in self.proxy.calls))
        self.assertNotIn('123456',repr(self.proxy.calls))
    def test_other_buyer_cannot_prepare_for_owner_registry(self):
        self.proxy.principal='other.testnet'
        with self.assertRaisesRegex(ProcurementClientError,'TESTNET_BUYER_REQUIRED'):
            self.mount.request('prepare',{'jobId':'ab'*16,'budget':1},'Bearer synthetic')
        self.assertIsNone(self.mount.client.prepared)
    def test_private_fields_cannot_be_added_to_prepare(self):
        with self.assertRaisesRegex(ProcurementClientError,'INVALID_PREPARATION'):
            self.mount.request('prepare',{'jobId':'ab'*16,'budget':1,'records':[]},'Bearer synthetic')
    def test_bid_price_only_sent_to_local_client(self):
        self.mount.bidders.close()
        self.mount.bidders=Mock()
        self.proxy.request=Mock(side_effect=[(200,{'role':'provider','principal':'p1.testnet'}),(200,{'job':{'id':'ab'*16}})])
        self.mount.request('bid-prepare',{'jobId':'ab'*16,'price':987654},'Bearer synthetic')
        self.mount.bidders.prepare.assert_called_once_with({'id':'ab'*16},'p1.testnet',price=987654)
        self.assertNotIn('987654',str(self.proxy.request.call_args_list))
    def test_bid_owner_cannot_be_changed(self):
        self.mount.bidders.close()
        self.mount.bidders=Mock()
        self.mount.bidders.snapshot.return_value={'provider':'p1.testnet'}
        self.proxy.request=Mock(return_value=(200,{'role':'provider','principal':'p2.testnet'}))
        with self.assertRaisesRegex(BidClientError,'SESSION_OWNER_MISMATCH'):
            self.mount.request('bid-close',{'sessionId':'ab'*16},'Bearer synthetic')
        self.mount.bidders.close_session.assert_not_called()
if __name__=='__main__':unittest.main()
