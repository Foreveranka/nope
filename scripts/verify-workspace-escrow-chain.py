#!/usr/bin/env python3
"""Independent read-only public-chain observer. No private file/key/witness input."""
import json, sys, base64, hashlib, urllib.request
from pathlib import Path
ROOT = Path(__file__).resolve().parents[1]
RPC = 'https://test.rpc.fastnear.com'
def rpc(method, params):
    req = urllib.request.Request(RPC, data=json.dumps({'jsonrpc':'2.0','id':'independent-nope-observer','method':method,'params':params}).encode(), headers={'Content-Type':'application/json'})
    with urllib.request.urlopen(req, timeout=25) as r:
        value=json.load(r)
    if 'error' in value:
        raise RuntimeError('Public RPC evidence unavailable: '+str(value['error'].get('code')))
    return value['result']
def require(value, message):
    if not value:
        raise RuntimeError(message)
evidence_path = ROOT/'docs/workspace-escrow/http-testnet-local.json'
if len(sys.argv)>1:
    if sys.argv[1] != 'production':
        raise RuntimeError('Only optional production mode is allowed')
    evidence_path=ROOT/'docs/workspace-escrow/http-testnet-production.json'
e=json.loads(evidence_path.read_text()); deployment=json.loads((ROOT/'docs/workspace-escrow/deployment-public.json').read_text())
require(e['syntheticOnly'] is True and e['actualExternalTestnet'] is True, 'Not the intended synthetic test')
require(rpc('status',[])['chain_id']=='testnet','Wrong chain')
contract=deployment['contractId']; p=e['payment']; txhash=p['releaseTransactionHash']
require(p['contractId']==contract and e['status']=='PAID','Wrong intended contract/status')
account=rpc('query',{'request_type':'view_account','account_id':contract,'finality':'final'})
require(account['code_hash']==deployment['codeHash'],'Unexpected deployed code')
view=rpc('query',{'request_type':'call_function','account_id':contract,'method_name':'get_hold','args_base64':base64.b64encode(json.dumps({'job_id':e['jobId']}).encode()).decode(),'block_id':account['block_hash']})
h=json.loads(bytes(view['result'])); require(h['state']=='Paid' and h['binding_hash']==p['bindingHash'],'Final hold not paid/matching')
require(h['delivery']['version']==p['recordedVersion'] and h['delivery']['output_hash']==e['outputSha256'],'Wrong accepted delivery')
t=h['terms']; require(t['provider']=='p2.veil-reg-e138f5c88250f821.testnet' and t['amount']=='1000000000000000000000','Wrong synthetic recipient or amount')
require(t['input_hash']==e['inputSha256'] and t['program_hash']==e['programSha256'] and t['plan_hash']==e['planSha256'],'Wrong computation bindings')
fields=['NOPE:WORKSPACE-ESCROW:V1:testnet',contract,t['job_id'],t['buyer_commitment'],t['provider'],t['amount'],t['input_hash'],t['program_hash'],t['plan_hash'],t['execution_deadline_ns'],t['review_deadline_ns']]
require(hashlib.sha256(json.dumps(fields,separators=(',',':'),ensure_ascii=False).encode()).hexdigest()==h['binding_hash'],'Independent term hash mismatch')
r=rpc('EXPERIMENTAL_tx_status',{'tx_hash':txhash,'sender_account_id':contract,'wait_until':'FINAL'})
require(r['final_execution_status']=='FINAL' and r['transaction']['hash']==txhash,'Transaction not final')
require(r['transaction']['signer_id']==contract and r['transaction']['receiver_id']==contract,'Unexpected signer/receiver')
require(r['status']=={'SuccessValue':base64.b64encode(b'true').decode()},'Callback result did not confirm payment')
call=r['transaction']['actions'][0].get('FunctionCall',{}); require(len(r['transaction']['actions'])==1 and call.get('method_name')=='accept_and_release' and call.get('deposit')=='0','Wrong action')
require(json.loads(base64.b64decode(call['args']))=={'job_id':e['jobId'],'binding_hash':h['binding_hash'],'version':h['delivery']['version'],'output_hash':h['delivery']['output_hash']},'Wrong signed acceptance')
nodes={}
for node in [r['transaction_outcome']]+r['receipts_outcome']:
    require(node['id'] not in nodes and 'Failure' not in node['outcome']['status'],'Failed or duplicated receipt')
    nodes[node['id']]=node
seen=set(); queue=[txhash]
while queue:
    key=queue.pop();require(key not in seen and key in nodes,'Incomplete/replayed receipt graph'); seen.add(key);queue.extend(nodes[key]['outcome']['receipt_ids'])
require(len(seen)==len(nodes),'Unrelated outcome in transaction')
transfers=[x for x in r['receipts'] if x.get('predecessor_id')==contract and x.get('receiver_id')==t['provider'] and x.get('receipt',{}).get('Action',{}).get('actions')==[{'Transfer':{'deposit':t['amount']}}]]
require(len(transfers)==1,'Exactly one bound native Transfer is required')
tr=transfers[0];require(nodes[tr['receipt_id']]['outcome']['status']=={'SuccessValue':''},'Native Transfer not successful')
callbacks=[]
for x in r['receipts']:
    a=x.get('receipt',{}).get('Action',{}).get('actions',[])
    if x.get('predecessor_id')==contract and x.get('receiver_id')==contract and len(a)==1 and a[0].get('FunctionCall',{}).get('method_name')=='on_transfer':
        c=a[0]['FunctionCall'];require(c.get('deposit')=='0' and c.get('gas')==20000000000000,'Wrong callback gas/deposit')
        require(json.loads(base64.b64decode(c['args']))=={'job_id':e['jobId'],'binding_hash':h['binding_hash'],'nonce':h['nonce']},'Wrong callback binding')
        require(nodes[x['receipt_id']]['outcome']['status']=={'SuccessValue':base64.b64encode(b'true').decode()},'Callback not successful');callbacks.append(x['receipt_id'])
require(len(callbacks)==1,'Exactly one matching callback is required')
raw=json.dumps(r,separators=(',',':'),sort_keys=True).encode()
(ROOT/'runtime/workspace-escrow/independent-release-raw.json').write_bytes(raw)
summary={'status':'PASS','network':'testnet','actualExternalChain':True,'independentReadOnlyObserver':'Python standard library; public inputs only','contractId':contract,'codeHash':account['code_hash'],'jobId':e['jobId'],'releaseTransactionHash':txhash,'nativeTransferReceiptId':tr['receipt_id'],'callbackReceiptId':callbacks[0],'provider':t['provider'],'amountYocto':t['amount'],'bindingHash':h['binding_hash'],'delivery':h['delivery'],'rawFinalRpcSha256':hashlib.sha256(raw).hexdigest(),'checks':{'finalReceiptTreeConnected':True,'exactlyOneNativeTransfer':True,'exactAmountRecipient':True,'successfulMatchingCallback':True,'finalPaidState':True,'taskPlanInputOutputBound':True},'computationProof':False}
out=ROOT/('docs/workspace-escrow/independent-chain-'+('production' if len(sys.argv)>1 else 'local')+'.json');out.write_text(json.dumps(summary,indent=2)+'\n');print(json.dumps(summary,indent=2))
