"""Owner-local one-shot testnet demonstration; no secrets in HTTP snapshots."""
import copy
import json
import math
import os
from pathlib import Path
import re
import secrets
import threading
from concurrent.futures import ThreadPoolExecutor

from .demo import DemoBusy

STAGES = frozenset(('starting','driver_ready','fhe_prepare_started','prepared','chain_clock',
    'create_job','bid','close_not_ready','close','mpc_started','mpc_completed','begin_execution',
    'execution_bound','fhe_evaluation_started','evaluated','client_verified','sdk_claim_built',
    'submit_receipt','decide','view','accepted','driver_stopped','payment_started','payment_verified',
    'failed_or_interrupted','completed'))
def public_result(result):
    """Project every nested value; raw subprocess/stdout/credential fields never pass."""
    if type(result) is not dict: raise ValueError("Invalid result")
    if type(result.get("payment")) is not dict: raise ValueError("Invalid payment")
    if any(type(result.get(key,[])) is not list or any(type(row) is not dict for row in result.get(key,[])) for key in ("transactions","checks")): raise ValueError("Invalid result lists")
    if type(result.get("artifactHashes",{})) is not dict: raise ValueError("Invalid hashes")
    def txhash(value):
        return value if type(value) is str and re.fullmatch(r"[1-9A-HJ-NP-Za-km-z]{32,44}",value) else None
    value={key:result.get(key) is True for key in
        ('completed','real_fhe','real_mpc','independent_operators','execution_proof','synthetic_only')}
    value['network']='testnet'
    jid=result.get('job_id')
    if type(jid) is not str or not re.fullmatch(r'[0-9]{1,20}',jid): raise ValueError('Invalid job id')
    value['job_id']=jid
    provider=result.get('selected_executor')
    if type(provider) is not str or not re.fullmatch(r'p[123]\.veil-reg-e138f5c88250f821\.testnet',provider):
        raise ValueError('Invalid provider')
    value['selected_executor']=provider
    elapsed=result.get('elapsed_seconds',0)
    if type(elapsed) not in (int,float) or not math.isfinite(elapsed) or elapsed<0: raise ValueError('Invalid duration')
    value['elapsed_seconds']=elapsed
    payment=result['payment']; amount=payment.get('amountYocto'); payment_hash=txhash(payment.get('transactionHash'))
    if amount!='1000000000000000000000' or not payment_hash: raise ValueError('Invalid payment')
    value['payment']={'verified':payment.get('verified') is True,'amountYocto':amount,
        'transactionHash':payment_hash,'mpcPriceProven':False,'publicAmount':True}
    value['transactions']=[]
    for item in result.get('transactions',[]):
        h=txhash(item.get('hash')); command=item.get('command')
        if not h or command not in ('create_job','bid','close','begin_execution','submit_receipt','decide','fund','release'):
            raise ValueError('Invalid transaction')
        value['transactions'].append({'command':command,'hash':h})
    value['checks']=[{'name':'Kontrol '+str(i+1),'pass':item.get('pass') is True}
        for i,item in enumerate(result.get('checks',[]))]
    value['artifactHashes']={k:v for k,v in result.get('artifactHashes',{}).items()
        if k in ('inputSha256','outputSha256','serverSha256','evaluationKeysSha256','externalBindingSha256')
        and type(v) is str and re.fullmatch(r'[0-9a-f]{64}',v)}
    records=result.get('verified_synthetic_records')
    if records is not None:
        if (type(records) is not list or len(records)!=4 or any(type(r) is not dict
            or type(r.get('id')) is not int or not 0<=r['id']<=255
            or type(r.get('value')) is not int or not 0<=r['value']<=255
            or type(r.get('duplicate')) is not bool for r in records)): raise ValueError('Invalid records')
        value['verified_synthetic_records']=[{k:r[k] for k in ('id','value','duplicate')} for r in records]
    value['limits']=['Sentetik girdiler aynı operatör tarafından hazırlanır.',
        'Üç MPC süreci aynı makinede; bağımsız operatör kanıtı yok.',
        'Ödeme açık sabit test bedeli; gizli kazanan fiyatla eşitlik ispatı yok.',
        'FHE sonucu yerel referansla doğrulanır; genel yürütme ispatı değil.']
    return value



class PrivacyDemoRuns:
    def __init__(self, runtime, enabled=False, runner=None):
        self.runtime = Path(runtime)
        self.enabled = enabled is True
        self.runner = runner
        self.lock = threading.RLock()
        self.pool = ThreadPoolExecutor(max_workers=1, thread_name_prefix='privacy-demo')
        self.closed = False
        self.current = None
        self.path = None
        self.marker = self.runtime / 'privacy-demo-active.json'
        if self.enabled and self.marker.exists():
            # Restart must never initiate a replacement transaction or new run.
            self.current = {'id':'previous-session','status':'interrupted','events':[],
                'error':'Önceki demo kaydı var. Otomatik yeniden çalıştırılmaz; işlem makbuzları sorgulanmalıdır.'}
            try:
                if self.marker.is_symlink() or self.marker.stat().st_size>4096: raise ValueError('Invalid marker')
                marker=json.loads(self.marker.read_text())
                if type(marker) is not dict: raise ValueError('Invalid marker shape')
                identity=marker.get('id')
                if type(identity) is not str or not re.fullmatch(r'[0-9a-f]{24}',identity): raise ValueError('Invalid identity')
                if marker.get('directory')!='privacy-demo-'+identity: raise ValueError('Invalid directory')
                path=self.runtime/marker['directory']
                if path.is_symlink(): raise ValueError('Invalid output directory')
                saved=path/'privacy-http-result.json'
                if saved.is_symlink() or not saved.is_file() or saved.stat().st_size>131072: raise ValueError('No completed result')
                restored=json.loads(saved.read_text())
                result=public_result(restored)
                if (result['completed'] is not True or restored.get('network')!='testnet'
                    or result['synthetic_only'] is not True or result['real_fhe'] is not True
                    or result['real_mpc'] is not True or result['payment']['verified'] is not True
                    or result['independent_operators'] is not False or result['execution_proof'] is not False):
                    raise ValueError('Invalid completed result')
                self.path=path
                self.current={'id':identity,'status':'completed','events':[], 'result':result}
            except (ValueError,TypeError,KeyError,OSError):
                pass


    def snapshot(self):
        with self.lock:
            result = copy.deepcopy(self.current)
            if result and self.path:
                events = []
                file = self.path / 'events.jsonl'
                if file.is_file() and not file.is_symlink():
                    with file.open('rb') as stream:
                        for line in stream.read(262144).splitlines(keepends=True):
                            if not line.endswith(b'\n'): continue
                            try:
                                item=json.loads(line)
                                stage=item.get('stage'); elapsed=item.get('elapsed_seconds')
                                if stage in STAGES and type(elapsed) in (int,float) and math.isfinite(elapsed) and elapsed>=0:
                                    events.append({'stage':stage,'elapsed_seconds':elapsed})
                            except (ValueError,TypeError): pass
                result['events'] = events + copy.deepcopy(self.current['events'])
            return {'enabled': self.enabled and not self.closed, 'run': result}

    def start(self):
        with self.lock:
            if not self.enabled or self.closed:
                raise DemoBusy('Testnet demo yalnız açıkça etkinleştirilmiş yerel operatörde çalışır.')
            if self.current is not None:
                raise DemoBusy('Bu oturumda bir demo başlatıldı; çift işlem için yeniden çalıştırma kapalı.')
            self.runtime.mkdir(parents=True,exist_ok=True,mode=0o700)
            identity=secrets.token_hex(12)
            self.path=self.runtime / ('privacy-demo-'+identity)
            try:
                fd=os.open(self.marker,os.O_WRONLY|os.O_CREAT|os.O_EXCL|os.O_NOFOLLOW,0o600)
            except FileExistsError:
                raise DemoBusy('Kalıcı demo kaydı mevcut; otomatik yeniden çalıştırma kapalı.') from None
            with os.fdopen(fd,'w') as stream:
                json.dump({'id':identity,'directory':self.path.name,'network':'testnet'},stream)
                stream.flush();os.fsync(stream.fileno())
            directory_fd=os.open(self.runtime,os.O_RDONLY)
            try: os.fsync(directory_fd)
            finally: os.close(directory_fd)
            self.current={'id':identity,'status':'running','events':[]}
            self.pool.submit(self._run,self.path)
            return self.snapshot()

    def _event(self,stage,elapsed_seconds=0):
        if stage not in STAGES: return
        if type(elapsed_seconds) not in (int,float) or not math.isfinite(elapsed_seconds) or elapsed_seconds<0: return
        with self.lock:
            self.current['events'].append({'stage':stage,'elapsed_seconds':elapsed_seconds})

    def _run(self,path):
        try:
            runner=self.runner
            if runner is None:
                from integration.privacy_demo import run
                runner=run
            result=runner(path,on_event=self._event)
            if (result.get('completed') is not True or result.get('network')!='testnet'
                or result.get('real_fhe') is not True or result.get('real_mpc') is not True
                or result.get('independent_operators') is not False or result.get('execution_proof') is not False
                or result.get('synthetic_only') is not True
                or result.get('payment',{}).get('verified') is not True):
                raise ValueError('Full verified testnet result required')
            # runner's public summary has a fixed schema, never copy raw native logs.
            safe=public_result(result)
            # Public, synthetic-only output persists for read-only restart display.
            path.mkdir(mode=0o700,exist_ok=True)
            fd=os.open(path/'privacy-http-result.json',os.O_WRONLY|os.O_CREAT|os.O_EXCL|os.O_NOFOLLOW,0o600)
            with os.fdopen(fd,'w') as stream:
                json.dump(safe,stream);stream.flush();os.fsync(stream.fileno())
            with self.lock:
                self.current.update(status='completed',result=safe)
        except Exception:
            with self.lock:
                self.current.update(status='failed',error='Demo tamamlanamadı. İşlem belirsizse tekrar gönderilmez; yerel makbuzlar korunmuştur.')

    def close(self):
        with self.lock: self.closed=True
        self.pool.shutdown(wait=True)
