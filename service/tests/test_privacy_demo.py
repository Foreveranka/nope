import json
from pathlib import Path
import tempfile
import threading
import unittest
from service.privacy_demo import PrivacyDemoRuns
from service.demo import DemoBusy
from service.tests import test_server as helpers


def success(path,on_event):
    on_event('payment_verified',2)
    return dict(completed=True,network='testnet',real_fhe=True,real_mpc=True,
        independent_operators=False,execution_proof=False,synthetic_only=True,job_id='5',selected_executor='p2.veil-reg-e138f5c88250f821.testnet',
        payment={'verified':True,'amountYocto':'1000000000000000000000','transactionHash':'1'*32,'privateKey':'never'},
        transactions=[{'command':'bid','hash':'1'*32,'stdout':'never'}],secret='never')

class PrivacyStateTests(unittest.TestCase):
    def test_disabled_never_runs(self):
        with tempfile.TemporaryDirectory() as d:
            r=PrivacyDemoRuns(d,runner=success)
            try:
                with self.assertRaises(DemoBusy):r.start()
                self.assertFalse(r.snapshot()['enabled'])
            finally:r.close()
    def test_one_shot_restart_and_safe_result(self):
        with tempfile.TemporaryDirectory() as d:
            r=PrivacyDemoRuns(d,enabled=True,runner=success)
            r.start();r.close()
            state=r.snapshot()['run']
            self.assertEqual(state['status'],'completed');self.assertNotIn('secret',state['result']);self.assertNotIn('never',json.dumps(state))
            with self.assertRaises(DemoBusy):r.start()
            new=PrivacyDemoRuns(d,enabled=True,runner=success)
            try:
                self.assertEqual(new.snapshot()['run']['status'],'completed')
                with self.assertRaises(DemoBusy):new.start()
            finally:new.close()
    def test_concurrent_instances_claim_before_runner(self):
        entered,finish=threading.Event(),threading.Event()
        def wait(path,on_event):entered.set();finish.wait(2);return success(path,on_event)
        with tempfile.TemporaryDirectory() as d:
            a=PrivacyDemoRuns(d,True,wait);b=PrivacyDemoRuns(d,True,wait)
            try:
                a.start();self.assertTrue(entered.wait(1))
                with self.assertRaises(DemoBusy):b.start()
            finally:finish.set();a.close();b.close()
    def test_unverified_payment_fails_and_error_not_reflected(self):
        with tempfile.TemporaryDirectory() as d:
            def invalid(path,on_event):
                value=success(path,on_event);value['payment']['verified']=False;return value
            r=PrivacyDemoRuns(d,True,invalid);r.start();r.close()
            self.assertEqual(r.snapshot()['run']['status'],'failed')
            self.assertNotIn('result',r.snapshot()['run'])
    def test_event_allowlist_and_partial_line(self):
        with tempfile.TemporaryDirectory() as d:
            r=PrivacyDemoRuns(d,True,success);r.start();r.close()
            r.path.mkdir(exist_ok=True)
            (r.path/'events.jsonl').write_text(json.dumps({'stage':'prepared','elapsed_seconds':1,'secret':'bad'})+'\n'+json.dumps({'stage':'private-secret','elapsed_seconds':1})+'\n'+json.dumps({'stage':'accepted','elapsed_seconds':2}))
            events=r.snapshot()['run']['events']
            self.assertEqual(events[0],{'stage':'prepared','elapsed_seconds':1})
            self.assertNotIn('private-secret',str(events));self.assertNotIn('accepted',str(events))
    def test_started_marker_without_final_is_interrupted(self):
        with tempfile.TemporaryDirectory() as d:
            identity='a'*24
            (Path(d)/'privacy-demo-active.json').write_text(json.dumps({'id':identity,'directory':'privacy-demo-'+identity}))
            r=PrivacyDemoRuns(d,True,success)
            try:
                self.assertEqual(r.snapshot()['run']['status'],'interrupted')
                with self.assertRaises(DemoBusy):r.start()
            finally:r.close()
    def test_marker_cannot_select_other_directory(self):
        with tempfile.TemporaryDirectory() as d:
            (Path(d)/'privacy-demo-active.json').write_text(json.dumps({'id':'a'*24,'directory':'../outside'}))
            r=PrivacyDemoRuns(d,True,success)
            try:
                self.assertEqual(r.snapshot()['run']['status'],'interrupted')
                self.assertIsNone(r.path)
            finally:r.close()
    def test_nonobject_marker_and_saved_result_fail_closed(self):
        for saved in (False,True):
            with self.subTest(saved=saved),tempfile.TemporaryDirectory() as d:
                root=Path(d);identity='b'*24;name='privacy-demo-'+identity
                (root/'privacy-demo-active.json').write_text(json.dumps({'id':identity,'directory':name}) if saved else '[]')
                if saved:
                    (root/name).mkdir();(root/name/'privacy-http-result.json').write_text('[]')
                r=PrivacyDemoRuns(root,True,success)
                try:
                    self.assertEqual(r.snapshot()['run']['status'],'interrupted')
                    with self.assertRaises(DemoBusy):r.start()
                finally:r.close()
    def test_symlink_marker_refused(self):
        with tempfile.TemporaryDirectory() as d:
            r=PrivacyDemoRuns(d,True,success)
            (Path(d)/'privacy-demo-active.json').symlink_to(Path(d)/'nonexistent')
            try:
                with self.assertRaises(DemoBusy):r.start()
            finally:r.close()

class PrivacyEndpointTests(unittest.TestCase):
    setUp=helpers.ServerTests.setUp
    close_server=helpers.ServerTests.close_server
    request=helpers.ServerTests.request
    def test_disabled_and_csrf(self):
        s,_,b=self.request('/api/privacy-demo');self.assertEqual(s,200);self.assertFalse(json.loads(b)['enabled'])
        self.assertEqual(self.request('/api/privacy-demo','POST',{}, {'Content-Type':'application/json'})[0],403)
        self.assertEqual(self.request('/api/privacy-demo','POST',{'records':[]},self.headers)[0],400)
        self.assertEqual(self.request('/api/privacy-demo','POST',{},self.headers)[0],409)
    def test_foreign_origin_cannot_read(self):
        self.assertEqual(self.request('/api/privacy-demo',headers={'Origin':'https://evil.invalid'})[0],403)

if __name__=='__main__':unittest.main()
