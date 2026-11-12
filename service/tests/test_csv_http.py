import http.client,json,tempfile,threading,time,unittest
from pathlib import Path
from service.server import create_server
class CsvHttpTests(unittest.TestCase):
 def setUp(self):
  self.tmp=tempfile.TemporaryDirectory();self.addCleanup(self.tmp.cleanup)
  def fake(records,path,on_stage=None):
   return {'verified':True,'records':[{'id':r['id'],'value':0 if r['value']==255 else min(r['value'],100),'duplicate':False} for r in records],'artifactHashes':{},'metrics':{}}
  self.s=create_server(port=0,runtime_dir=Path(self.tmp.name),pipeline=fake)
  self.t=threading.Thread(target=self.s.serve_forever,daemon=True);self.t.start();self.addCleanup(self.close)
 def close(self):self.s.shutdown();self.s.server_close();self.t.join()
 def req(self,path,body=None,foreign=False,csrf=True):
  c=http.client.HTTPConnection(*self.s.server_address);h={'Origin':'https://foreign.invalid' if foreign else self.s.origin,'Content-Type':'application/json'}
  if csrf:h['X-CSRF-Token']=self.s.state.csrf_token
  c.request('POST' if body is not None else 'GET',path,body=json.dumps(body) if body is not None else None,headers=h);r=c.getresponse();v=json.loads(r.read());c.close();return r.status,v
 def test_csv_roundtrip_and_test_pipeline_never_becomes_evidence(self):
  s,j=self.req('/api/csv/jobs',{'values':[255,144,42,5,123],'mode':'local'});self.assertEqual(s,201)
  for _ in range(100):
   s,d=self.req('/api/csv/jobs/'+j['id'])
   if d['status'] in ('COMPLETED','FAILED'):break
   time.sleep(.01)
  self.assertEqual(d['values'],[0,100,42,5,100]);self.assertFalse(d['evidence']['realFhe'])
  self.assertEqual(self.req('/api/csv/jobs/'+j['id']+'/evidence')[0],409)
  self.assertEqual(self.req('/api/csv/jobs/'+j['id']+'/anchor',{})[0],403)
 def test_origin_csrf_fields_and_missing_job(self):
  b={'values':[1],'mode':'local'}
  self.assertEqual(self.req('/api/csv/jobs',b,foreign=True)[0],403)
  self.assertEqual(self.req('/api/csv/jobs',b,csrf=False)[0],403)
  self.assertEqual(self.req('/api/csv/jobs',{**b,'filename':'private.csv'})[0],400)
  self.assertEqual(self.req('/api/csv/jobs/'+32*'a')[0],404)
  self.assertEqual(self.req('/api/csv/jobs',{'values':[True],'mode':'local'})[0],400)
