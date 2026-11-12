"""Public ciphertext commitments; never claims proof of non-observation."""
import hashlib
import json
import os
from pathlib import Path
import re
import subprocess
import threading
ROOT=Path(__file__).resolve().parents[1]
HASHES={'serverSha256','clientSpecsSha256','inputSha256','evaluationKeysSha256','requestManifestSha256','outputSha256','receiptSha256'}
class CsvEvidence:
    def __init__(self,jobs,enabled=False):
        self.jobs=jobs; self.enabled=enabled is True; self.lock=threading.Lock(); self.anchors={}
    def bundle(self,job_id):
        job=self.jobs.snapshot(job_id)
        if job['status']!='COMPLETED': raise ValueError('Complete the encrypted job first.')
        e=job.get('evidence',{})
        if e.get('realFhe') is not True or e.get('verified') is not True: raise ValueError('Actual verified FHE required.')
        if e.get('schema')!='nope-csv-evidence-v1' or e.get('profile')!='clean-column-batch4-v1': raise ValueError('Unknown evidence profile.')
        n=e.get('rowCount'); batches=e.get('batches')
        if type(n) is not int or not 1<=n<=32 or type(batches) is not list or len(batches)!=(n+3)//4: raise ValueError('Invalid evidence shape.')
        out=[]
        for i,b in enumerate(batches):
            hashes=b.get('artifactHashes',{})
            if b.get('index')!=i or type(hashes) is not dict or not {'inputSha256','outputSha256','serverSha256','evaluationKeysSha256'}<=set(hashes): raise ValueError('Missing ciphertext commitments.')
            if any(k not in HASHES or type(v) is not str or not re.fullmatch('[0-9a-f]{64}',v) for k,v in hashes.items()): raise ValueError('Invalid public hashes.')
            out.append({'index':i,'artifactHashes':hashes.copy()})
        manifest={'schema':e['schema'],'profile':e['profile'],'rowCount':n,'batches':out,'verified':True,'realFhe':True}
        raw=json.dumps(manifest,sort_keys=True,separators=(',',':'),ensure_ascii=True)
        digest=hashlib.sha256(raw.encode()).hexdigest()
        return {'manifestJson':raw,'manifestSha256':digest,'anchor':self.anchors.get(digest),'scope':'ciphertext-manifest-commitment','privacyProof':False}
    def anchor(self,job_id):
        if not self.enabled: raise PermissionError('Testnet anchoring is not enabled in this client.')
        with self.lock:
            bundle=self.bundle(job_id); h=bundle['manifestSha256']
            if h in self.anchors:return self.bundle(job_id)
            m=json.loads(bundle['manifestJson'])
            result=subprocess.run(['node',str(ROOT/'contracts/csv-evidence/cli.mjs'),'anchor',h,str(m['rowCount']),str(len(m['batches']))],cwd=ROOT,capture_output=True,timeout=180,check=True)
            value=json.loads(result.stdout)
            if value.get('network')!='testnet' or value.get('manifestSha256')!=h:raise ValueError('Anchor binding mismatch.')
            # Allowlist all outbound metadata; never reflect CLI logs or errors.
            self.anchors[h]={k:value[k] for k in ('network','contractId','manifestSha256','transactionHash','codeHash') if k in value}
            return self.bundle(job_id)
