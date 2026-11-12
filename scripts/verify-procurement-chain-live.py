"""One bounded, explicitly enabled SYNTHETIC app-to-testnet publication check.

Never silently restart a partially completed job: its RAM FHE key is gone.
Only public identifiers/hash evidence is retained. No selection/payment claim.
"""
import importlib.util
import json
import os
from pathlib import Path
import secrets
import sys
import time

ROOT=Path(__file__).resolve().parents[1]
sys.path.insert(0,str(ROOT))

def main():
    if os.environ.get('NOPE_ENABLE_TESTNET_RELAY')!='1':
        raise RuntimeError('Explicit testnet relay enablement required')
    from service.procurement_mount import ProcurementMount
    from service.procurement_proxy import ProcurementProxy
    spec=importlib.util.spec_from_file_location('deployed_probe',ROOT/'scripts/verify-deployed-procurement.py')
    probe=importlib.util.module_from_spec(spec);spec.loader.exec_module(probe)
    invitations=[json.loads(p.read_text()) for p in (ROOT/'runtime/procurement-invitations').glob('*.json') if p.name!='grants.json']
    buyer=next(x for x in invitations if x['role']=='buyer')
    roster=sorted(x['principal'] for x in invitations if x['role']=='provider')
    assert len(roster)==3
    directory=ROOT/'runtime/app-chain-live-probe'
    directory.mkdir(mode=0o700,exist_ok=True)
    journal=directory/'started.json'
    if journal.exists():
        raise RuntimeError('Prior probe exists; reconcile it read-only, do not create another job')
    mount=ProcurementMount(directory,ProcurementProxy())
    auth='Bearer '+buyer['token']
    try:
        assert mount.request('chain-capabilities',{},auth)['publicationConfigured'] is True
        now=time.time_ns()
        body={'jobId':secrets.token_hex(16),'title':'Synthetic application chain publication',
              'profile':'clean-4-records-v1','roster':roster,
              'bidDeadlineNs':str(now+600*10**9),'resultDeadlineNs':str(now+1200*10**9)}
        keys={'create':secrets.token_hex(16),'publish':secrets.token_hex(16)}
        with journal.open('x') as f:json.dump({'body':body,'keys':keys,'scope':'public-synthetic-metadata-only'},f)
        status,created=probe.call('jobs',buyer['token'],body,keys['create'])
        assert status==201 and created['job']['status']=='DRAFT'
        prepared=mount.request('prepare',{'jobId':body['jobId'],'budget':75000000},auth)
        payload=mount.request('publish-payload',{'sessionId':prepared['id'],'expectedRevision':0},auth)
        status,published=probe.call('jobs/'+body['jobId']+'/publish',buyer['token'],payload,keys['publish'])
        assert status==200 and published['job']['status']=='PUBLISHED'
        result=mount.request('chain-publish',{'jobId':body['jobId'],'sessionId':prepared['id']},auth)
        assert result['finalExecutionStatus']=='FINAL'
        assert result['scope']=='testnet-registry-publication-only'
        check=mount.request('chain-status',{'jobId':body['jobId']},auth)
        assert check['transactionHash']==result['transactionHash'] and check['registryJobId']==result['registryJobId']
        evidence={'applicationJobId':body['jobId'],'registryJobId':result['registryJobId'],
                  'transactionHash':result['transactionHash'],'finalExecutionStatus':'FINAL',
                  'actualCloudApp':True,'actualLocalFHEPreparation':True,'actualTestnetPublication':True,
                  'readOnlyReconciliation':True,'selectionExecuted':False,'paymentExecuted':False,
                  'verifiedAt':time.strftime('%Y-%m-%dT%H:%M:%SZ',time.gmtime())}
        (ROOT/'docs/verification/procurement-app-chain-live.json').write_text(json.dumps(evidence,indent=2)+'\n')
        print(json.dumps(evidence))
    finally:
        mount.close()

if __name__=='__main__':main()
