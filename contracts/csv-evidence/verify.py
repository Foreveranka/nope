#!/usr/bin/env python3
"""Independent public HTTP observer; no signer, key imports, or transaction submission."""
import json
import pathlib
import re
import sys
import urllib.request
RPC = 'https://rpc.testnet.near.org'
CONTRACT = 'csv-evidence.veil-reg-e138f5c88250f821.testnet'
OWNER = 'veil-reg-e138f5c88250f821.testnet'
ROOT = pathlib.Path(__file__).resolve().parent

def rpc(method, params):
    request = urllib.request.Request(RPC, data=json.dumps({'jsonrpc':'2.0','id':'csv-observer','method':method,'params':params}).encode(), headers={'Content-Type':'application/json'})
    with urllib.request.urlopen(request, timeout=25) as response:
        result = json.load(response)
    if 'error' in result:
        raise ValueError('OBSERVER_RPC_ERROR')
    return result['result']

def verify(h, rows, batches):
    import base64
    if not re.fullmatch('[0-9a-f]{64}',h) or not 1 <= rows <= 32 or batches != (rows+3)//4:
        raise ValueError('INVALID_HASH_OR_COUNTS')
    deployment=json.loads((ROOT/'evidence/deployment.json').read_text())
    assert deployment['deployed'] and deployment['network']=='testnet' and deployment['contractId']==CONTRACT
    assert rpc('status',[])['chain_id']=='testnet'
    account=rpc('query',{'request_type':'view_account','account_id':CONTRACT,'finality':'final'})
    assert account['code_hash']==deployment['codeHash']
    keys=rpc('query',{'request_type':'view_access_key_list','account_id':CONTRACT,'finality':'final'})
    assert keys['keys']==[]
    result=rpc('query',{'request_type':'call_function','account_id':CONTRACT,'method_name':'get_manifest','args_base64':base64.b64encode(json.dumps({'manifest_hash':h}).encode()).decode(),'finality':'final'})
    record=json.loads(bytes(result['result']))
    assert set(record)=={'manifest_hash','profile','row_count','batch_count','recorded_at','owner'}
    assert record['manifest_hash']==h and record['profile']=='nope-csv-evidence-v1' and record['row_count']==rows and record['batch_count']==batches and record['owner']==OWNER
    assert re.fullmatch('[0-9]+',record['recorded_at'])
    return {'network':'testnet','contractId':CONTRACT,'manifestSha256':h,'codeHash':account['code_hash'],'record':record,'verificationRpc':RPC,'verificationBlockHash':result['block_hash'],'verificationBlockHeight':result['block_height'],'verified':True,'privacyProof':False,'executionProof':False}

if __name__=='__main__':
    try:
        if len(sys.argv)!=4:
            raise ValueError('USAGE_HASH_ROWS_BATCHES')
        print(json.dumps(verify(sys.argv[1],int(sys.argv[2]),int(sys.argv[3]))))
    except Exception:
        print(json.dumps({'network':'testnet','contractId':CONTRACT,'error':'INDEPENDENT_VERIFICATION_FAILED'}),file=sys.stderr)
        sys.exit(1)
