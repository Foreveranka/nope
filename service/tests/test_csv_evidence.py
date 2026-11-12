import copy,hashlib,json,unittest
from service.csv_evidence import CsvEvidence
class Jobs:
 def __init__(self,e):self.e=e
 def snapshot(self,id):return {'status':'COMPLETED','evidence':self.e}
class EvidenceTests(unittest.TestCase):
 def evidence(self):return {'schema':'nope-csv-evidence-v1','profile':'clean-column-batch4-v1','rowCount':1,'realFhe':True,'verified':True,'batches':[{'index':0,'artifactHashes':{k:'a'*64 for k in ('inputSha256','outputSha256','serverSha256','evaluationKeysSha256')}}]}
 def test_exact_bytes_commitment_no_input_and_disabled_signer(self):
  e=self.evidence();e['values']=[99];m=CsvEvidence(Jobs(e));b=m.bundle('x');self.assertNotIn('values',b['manifestJson']);self.assertFalse(b['privacyProof']);self.assertIsNone(b['anchor']);self.assertEqual(hashlib.sha256(b['manifestJson'].encode()).hexdigest(),b['manifestSha256'])
  with self.assertRaises(PermissionError):m.anchor('x')
 def test_unverified_fake_missing_and_private_fields_reject(self):
  for f in ('realFhe','verified'):
   e=self.evidence();e[f]=False
   with self.assertRaises(ValueError):CsvEvidence(Jobs(e)).bundle('x')
  for k in ('privateKey','plaintextSha256'):
   e=self.evidence();e['batches'][0]['artifactHashes'][k]='a'*64
   with self.assertRaises(ValueError):CsvEvidence(Jobs(e)).bundle('x')
