"""Allowlist verified PUBLIC testnet evidence; never traverse runtime/key material."""
import argparse, json, re
from pathlib import Path
ROOT=Path(__file__).resolve().parents[1]
LABELS={'create_job':'İş kaydı','bid':'Sağlayıcı taahhüdü','close':'Tekliflerin kapanışı','begin_execution':'Seçilen sağlayıcı','submit_receipt':'Sonuç makbuzu','decide':'Müşteri kabulü'}
def publish(result_path,payment_path=None):
    result=json.loads(Path(result_path).read_text())
    if (result.get('completed') is not True or result.get('network')!='testnet' or
        result.get('real_fhe') is not True or result.get('real_mpc') is not True or
        result.get('independent_operators') is not False or
        not result.get('checks') or any(c.get('pass') is not True for c in result['checks']) or
        result.get('accepted_job',{}).get('state')!='Accepted'):
        raise ValueError('Completed actual testnet evidence required')
    transactions=[]
    for tx in result['transactions']:
        if tx.get('finality')!='FINAL' or not re.fullmatch(r'[1-9A-HJ-NP-Za-km-z]{32,64}',tx.get('hash','')):
            raise ValueError('Unfinalized or malformed transaction')
        transactions.append({'label':LABELS[tx['command']],'hash':tx['hash']})
    public={'schema':1,'network':'testnet','completed':True,'jobId':result['job_id'],
            'checksPassed':len(result['checks']),'independentOperators':False,
            'transactions':transactions,'payment':{'verified':False}}
    if payment_path:
        p=json.loads(Path(payment_path).read_text())
        if (p.get('state')!='verified_nope_testnet_escrow_payout' or p.get('network')!='testnet' or
            p.get('job_binding_hash')!=bytes(result['accepted_job']['job_binding_hash']).hex() or
            p.get('ciphertext_output_hash')!=result['artifactHashes']['outputSha256']):
            raise ValueError('Exact payout observer evidence required')
        public['payment']={'verified':True,'amountYocto':p['amount_yocto'],'publicAmount':True,'mpcPriceProven':False}
        transactions.append({'label':'Test NEAR ödemesi','hash':p['transaction_hash']})
    target=ROOT/'docs/verification/testnet-public-summary.json'
    target.write_text(json.dumps(public,ensure_ascii=False,indent=2)+'\n')
    print(json.dumps({'published':str(target),'transactions':len(transactions),'paymentVerified':public['payment']['verified']}))
if __name__=='__main__':
    a=argparse.ArgumentParser(description=__doc__);a.add_argument('result');a.add_argument('--payment');x=a.parse_args();publish(x.result,x.payment)
