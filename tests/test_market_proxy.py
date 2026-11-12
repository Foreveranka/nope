import unittest
from service.procurement_proxy import ProcurementProxy, ProxyError, ORIGIN

class NeverOpen:
    def open(self, *a, **kw):
        raise AssertionError('Invalid input reached network')

class ProxyTests(unittest.TestCase):
    def setUp(self):
        self.proxy = ProcurementProxy(NeverOpen())
        self.auth = 'Bearer ' + 'a' * 43
    def test_private_values_rejected_before_network(self):
        base = {'expectedRevision': 0, 'intent': {'salt': 'private'}, 'budgetCommitment': 'b'*64}
        with self.assertRaises(ProxyError):
            self.proxy.request('POST','/api/procurement/jobs/'+'1'*32+'/publish', self.auth, base, 'request-key-12345')
    def test_no_generic_proxy_or_redirect_target(self):
        for route in ['https://evil.invalid/api/procurement/jobs','//evil.invalid/api/procurement/jobs','/api/procurement/../jobs','/api/procurement/jobs?route=evil','/api/procurement/jobs?limit=1&limit=2']:
            with self.subTest(route=route), self.assertRaises(ProxyError):
                self.proxy.request('GET',route,self.auth)
    def test_unknown_fields_and_missing_idempotency_rejected(self):
        for body,key in [({'expectedRevision':0,'price':20},'request-key-12345'),({'expectedRevision':0},None)]:
            with self.assertRaises(ProxyError):
                self.proxy.request('POST','/api/procurement/jobs/'+'1'*32+'/close',self.auth,body,key)
    def test_no_cookie_or_hash_as_auth(self):
        for auth in [None,'a'*43,'Bearer a','Bearer '+ 'a'*43+'\n']:
            with self.assertRaises(ProxyError): self.proxy.request('GET','/api/procurement/session',auth)
if __name__=='__main__': unittest.main()
