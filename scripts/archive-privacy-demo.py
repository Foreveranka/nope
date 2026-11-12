#!/usr/bin/env python3
"""Publish only a completed, exact-bound synthetic Privacy run; no raw logs/keys."""
import argparse
import hashlib
import json
from pathlib import Path
import sys
from datetime import datetime,timezone
ROOT=Path(__file__).resolve().parents[1]
sys.path.insert(0,str(ROOT))
from service.privacy_demo import public_result,STAGES
from integration.privacy_demo import _binding,_validate_handoff

def main():
    parser=argparse.ArgumentParser(description=__doc__);parser.add_argument('directory',type=Path);args=parser.parse_args()
    path=args.directory.resolve()
    if path.parent!=ROOT/'runtime' or not path.name.startswith('privacy-demo-'):
        parser.error('Existing direct runtime privacy demo required')
    def read(name):
        p=path/name
        if p.is_symlink() or not p.is_file() or p.stat().st_size>2*1024*1024: raise ValueError('Invalid evidence file')
        return json.loads(p.read_text())
    result=public_result(read('privacy-http-result.json'))
    raw=read('result.json');binding=_binding(raw)
    handoff=read('payment-handoff.json');_validate_handoff(handoff,binding)
    observed=read('payment-verified.json')
    assert result['completed'] and result['synthetic_only'] and result['real_fhe'] and result['real_mpc']
    assert not result['independent_operators'] and not result['execution_proof']
    assert result['job_id']==binding.job_id==observed['job_id']
    assert result['payment']['transactionHash']==handoff['release_hash']==observed['transaction_hash']
    assert result['payment']['verified'] and observed['state']=='verified_nope_testnet_escrow_payout'
    assert result['selected_executor']==binding.provider_id==observed['provider_id']
    assert observed['ciphertext_output_hash']==binding.output_hash==result['artifactHashes']['outputSha256']
    assert result['checks'] and all(x['pass'] for x in result['checks'])
    assert len(result['transactions'])==10
    assert result['verified_synthetic_records']==raw['verified_synthetic_records']
    events=[]
    for name in ('events.jsonl','privacy-events.jsonl'):
        for line in (path/name).read_text().splitlines():
            row=json.loads(line)
            if row['stage'] in STAGES:events.append({k:row[k] for k in ('stage','elapsed_seconds')})
    events.sort(key=lambda row:row['elapsed_seconds'])
    evidence={'schema':1,'recordedAt':datetime.now(timezone.utc).isoformat(),
        'mode':'recorded-testnet-evidence','liveExecution':False,
        'run':{'id':path.name.removeprefix('privacy-demo-'),'status':'completed','events':events,'result':result}}
    target=ROOT/'docs/verification'
    (target/'privacy-demo-public.json').write_text(json.dumps(evidence,ensure_ascii=False,indent=2)+'\n')
    names=['result.json','payment-handoff.json','payment-verified.json','privacy-http-result.json','events.jsonl','privacy-events.jsonl']
    manifest={'scope':'local-synthetic-run-and-trusted-RPC-observer','jobId':binding.job_id,
        'startedFromBrowser':True,'sha256':{name:hashlib.sha256((path/name).read_bytes()).hexdigest() for name in names}}
    (target/'privacy-demo-evidence-manifest.json').write_text(json.dumps(manifest,indent=2)+'\n')
    print(json.dumps({'archived':True,'job':binding.job_id,'transactions':len(result['transactions']),'publicFile':str(target/'privacy-demo-public.json')}))

if __name__=='__main__':main()
