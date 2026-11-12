"""Actual HTTPS invitation/ledger smoke test; credentials never printed or logged."""
import hashlib,json,secrets,time,urllib.request,urllib.error
from pathlib import Path
ROOT=Path(__file__).resolve().parents[1]
ORIGIN='https://veil-procurement.vercel.app'
class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self,*args,**kwargs):raise RuntimeError('Unexpected redirect')
opener=urllib.request.build_opener(urllib.request.ProxyHandler({}),NoRedirect())
def call(route,token=None,body=None,key=None):
    headers={'Accept':'application/json'}
    if token:headers['Authorization']='Bearer '+token
    if body is not None:headers.update({'Content-Type':'application/json','Idempotency-Key':key,'Origin':ORIGIN})
    request=urllib.request.Request(ORIGIN+'/api/procurement/'+route,data=None if body is None else json.dumps(body).encode(),headers=headers,method='GET' if body is None else 'POST')
    try:response=opener.open(request,timeout=30)
    except urllib.error.HTTPError as error:response=error
    with response:
        raw=response.read(1048577)
        if len(raw)>1048576:raise RuntimeError('Oversized reply')
        return response.status,json.loads(raw)
def main():
    invitations=[json.loads(p.read_text()) for p in (ROOT/'runtime/procurement-invitations').glob('*.json') if p.name!='grants.json']
    buyer=next(x for x in invitations if x['role']=='buyer');providers=sorted((x for x in invitations if x['role']=='provider'),key=lambda x:x['principal'])
    assert len(providers)==3
    assert call('health')[0]==200
    assert call('session')[0]==401
    status,session=call('session',buyer['token']);assert status==200 and session['principal']==buyer['principal'] and session['role']=='buyer'
    journal=ROOT/'runtime/deployed-procurement-probe.json'
    if not journal.exists():
        now=time.time_ns();probe={'key':secrets.token_hex(16),'body':{'jobId':secrets.token_hex(16),'title':'Synthetic deployed API verification','profile':'clean-4-records-v1','roster':[x['principal'] for x in providers],'bidDeadlineNs':str(now+300*10**9),'resultDeadlineNs':str(now+1200*10**9)}}
        with journal.open('x') as f:json.dump(probe,f)
    probe=json.loads(journal.read_text());body=probe['body'];key=probe['key']
    first,created=call('jobs',buyer['token'],body,key);assert first==201 and created['job']['status']=='DRAFT'
    assert call('jobs/'+body['jobId'],providers[0]['token'])[0]==404
    status,found=call('jobs/'+body['jobId'],buyer['token']);assert status==200 and found['job']==created['job']
    status,replay=call('jobs',buyer['token'],body,key);assert status==201 and replay['job']==created['job']
    assert call('jobs',buyer['token'],{**body,'title':'Changed retry'},key)[0]==409
    result={'origin':ORIGIN,'jobId':body['jobId'],'verifiedAt':time.strftime('%Y-%m-%dT%H:%M:%SZ',time.gmtime()),'actualDeployedHTTPS':True,'health':True,'unauthenticatedRejected':True,'buyerSession':True,'draftCreated':True,'providerDraftInvisible':True,'durableRead':True,'idempotentReplay':True,'conflictingReplayRejected':True,'blockchainBinding':False}
    (ROOT/'docs/verification/procurement-deployed-https.json').write_text(json.dumps(result,indent=2)+'\n')
    print(json.dumps(result))
if __name__=='__main__':main()
