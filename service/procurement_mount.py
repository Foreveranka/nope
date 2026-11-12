"""Local-only preparation mount. Explicit synthetic fixture; never cloud plaintext."""
import json
import os
import re
import threading
import time
from pathlib import Path
from .procurement_client import ProcurementClient, ProcurementConfig, ProcurementClientError
from .bid_client import BidClient, BidClientError
from engine.protocol import canonical_json, sha256, read_regular

class ProcurementMount:
    def __init__(self, runtime_dir, proxy, *, chain_bridge=None):
        root=Path(__file__).resolve().parent
        config=json.loads(read_regular(root/'procurement-config.json',16384))
        policy=json.loads(read_regular(root/'procurement-policy.json',16384))
        if config['output_policy_hash'] != sha256(canonical_json(policy)):
            raise ValueError('Output policy mismatch')
        self.config=ProcurementConfig(**config)
        self.client=ProcurementClient(runtime_dir,self.config,timeout_seconds=1800)
        self.bidders=BidClient(self.config)
        self.proxy=proxy
        if chain_bridge is None and os.environ.get('NOPE_ENABLE_TESTNET_RELAY')=='1':
            from .procurement_chain import from_env
            chain_bridge=from_env(runtime_dir,self.config)
        self.chain_bridge=chain_bridge
        self.lock=threading.RLock()
        self.principal=None

    def request(self, action, body, authorization):
        status,session=self.proxy.request('GET','/api/procurement/session',authorization)
        if action.startswith('bid-'):
            if status!=200 or session.get('role')!='provider':
                raise BidClientError('PROVIDER_REQUIRED')
            if action=='bid-recover' and type(body) is dict and set(body)=={'jobId'}:
                return self.bidders.lookup(body['jobId'],session['principal'])
            if action=='bid-prepare' and type(body) is dict and set(body)=={'jobId','price'}:
                status,data=self.proxy.request('GET','/api/procurement/jobs/'+str(body['jobId']),authorization)
                if status!=200:
                    raise BidClientError('JOB_UNAVAILABLE')
                return self.bidders.prepare(data['job'],session['principal'],price=body['price'])
            if type(body) is not dict or not isinstance(body.get('sessionId'),str):
                raise BidClientError('INVALID_REQUEST')
            snapshot=self.bidders.snapshot(body['sessionId'])
            if snapshot['provider']!=session['principal']:
                raise BidClientError('SESSION_OWNER_MISMATCH')
            if action=='bid-snapshot' and set(body)=={'sessionId'}:
                return snapshot
            if action=='bid-close' and set(body)=={'sessionId'}:
                return self.bidders.close_session(body['sessionId'])
            if action=='bid-input' and set(body)=={'sessionId','evidenceHash'}:
                return self.bidders.run_private_input(body['sessionId'],evidence_hash=body['evidenceHash'])
            raise BidClientError('UNSUPPORTED_LOCAL_ACTION')
        if status!=200 or session.get('role')!='buyer' or session.get('principal')!=self.config.registry_account:
            raise ProcurementClientError('TESTNET_BUYER_REQUIRED')
        if action=='chain-capabilities' and body=={}:
            return {'publicationConfigured':self.chain_bridge is not None,
                    'network':'testnet','scope':'registry-publication-only'}
        if action in ('chain-publish','chain-status'):
            fields={'jobId','sessionId'} if action=='chain-publish' else {'jobId'}
            if (type(body) is not dict or set(body)!=fields or
                    not isinstance(body.get('jobId'),str) or
                    not re.fullmatch(r'[0-9a-f]{32}',body['jobId'])):
                raise ProcurementClientError('INVALID_CHAIN_REQUEST')
            if self.chain_bridge is None:
                raise ProcurementClientError('TESTNET_RELAY_UNAVAILABLE')
            status,data=self.proxy.request('GET','/api/procurement/jobs/'+body['jobId'],authorization)
            job=data.get('job',{})
            if status!=200 or job.get('id')!=body['jobId'] or job.get('buyer')!=session['principal']:
                raise ProcurementClientError('JOB_UNAVAILABLE')
            if action=='chain-status':
                return self.chain_bridge.status(body['jobId'])
            with self.lock:
                snapshot=self.client.snapshot()
                if (self.principal!=session['principal'] or not snapshot or
                        snapshot.get('id')!=body['sessionId'] or
                        snapshot.get('draftId')!=job['id'] or snapshot.get('state')!='PREPARED' or
                        snapshot.get('engineMode')!='real-fhe'):
                    raise ProcurementClientError('LOCAL_PREPARATION_REQUIRED')
                expected={key:snapshot[key] for key in
                          ('id','draftId','intent','contextHash','budgetCommitment')}
                if (job.get('status')!='PUBLISHED' or any(job.get(key)!=expected[key]
                        for key in ('intent','contextHash','budgetCommitment'))):
                    raise ProcurementClientError('PUBLICATION_CONTEXT_MISMATCH')
                return self.chain_bridge.publish(job,expected)
        with self.lock:
            if action=='prepare':
                if type(body) is not dict or set(body)!={'jobId','budget'}:
                    raise ProcurementClientError('INVALID_PREPARATION')
                status,data=self.proxy.request('GET','/api/procurement/jobs/'+str(body['jobId']),authorization)
                if status!=200 or data.get('job',{}).get('buyer')!=session['principal']:
                    raise ProcurementClientError('DRAFT_UNAVAILABLE')
                # The key stays in memory, so this pilot has a bounded complete lifecycle.
                if int(data['job']['resultDeadlineNs'])>time.time_ns()+1750*1000000000:
                    raise ProcurementClientError('PILOT_DELIVERY_MUST_BE_WITHIN_29_MINUTES')
                result=self.client.prepare(data['job'],{'qualified':[True,True,True],'fixedFee':0},budget=body['budget'])
                self.principal=session['principal']
                return result
            if self.principal!=session['principal']:
                raise ProcurementClientError('SESSION_OWNER_MISMATCH')
            if action=='snapshot' and body=={}:
                return {'session':self.client.snapshot()}
            if action=='publish-payload' and type(body) is dict and set(body)=={'sessionId','expectedRevision'}:
                return self.client.publish_payload(body['sessionId'],expected_revision=body['expectedRevision'])
            if action=='budget-input' and type(body) is dict and set(body)=={'sessionId','evidenceHash'}:
                return self.client.run_private_input(body['sessionId'],evidence_hash=body['evidenceHash'])
            if action=='close' and type(body) is dict and set(body)=={'sessionId'}:
                self.client.close_session(body['sessionId'])
                return {'closed':True}
            raise ProcurementClientError('UNSUPPORTED_LOCAL_ACTION')

    def close(self):
        self.client.close()
        self.bidders.close()
