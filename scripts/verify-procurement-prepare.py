"""Real local FHE preparation smoke with fabricated PUBLIC draft, no chain/network."""
import json
import time
import sys
from pathlib import Path
sys.path.insert(0,str(Path(__file__).resolve().parents[1]))
from service.procurement_client import ProcurementClient, ProcurementConfig
from engine.protocol import sha256,canonical_json
root=Path(__file__).resolve().parents[1]
config=ProcurementConfig(**json.loads((root/'service/procurement-config.json').read_text()))
now=int(time.time()*1000)
roster=['synthetic-a.testnet','synthetic-b.testnet','synthetic-c.testnet']
draft={'id':'34'*16,'title':'Synthetic preparation test','profile':'clean-4-records-v1','buyer':config.registry_account,'roster':roster,'bidDeadlineNs':str((now+300000)*1000000),'resultDeadlineNs':str((now+1200000)*1000000),'status':'DRAFT','revision':0,'createdAt':now,'updatedAt':now,'ledger':'app','blockchainBinding':'pending','intent':None,'contextHash':None,'budgetCommitment':None,'bids':[{'provider':p,'slot':n+1,'commitment':None} for n,p in enumerate(roster)],'closedAt':None,'selection':None,'deliveries':[],'decision':None}
start=time.monotonic()
with ProcurementClient(root/'runtime',config,timeout_seconds=1800) as client:
    prepared=client.prepare(draft,{'qualified':[True]*3,'fixedFee':0},budget=100000000)
    publish=client.publish_payload(prepared['id'],expected_revision=0)
    assert prepared['engineMode']=='real-fhe' and prepared['state']=='PREPARED'
    assert set(publish)=={'expectedRevision','intent','budgetCommitment'}
    assert 'budget' not in publish and 'salt' not in publish
    result={'realFhePreparation':True,'fabricatedPublicDraft':True,'networkRequests':False,'blockchainPublication':False,'mpcSelection':False,'payment':False,'elapsedSeconds':round(time.monotonic()-start,3),'contextHash':prepared['contextHash'],'artifactHashes':prepared['artifactHashes'],'publishPayloadSha256':sha256(canonical_json(publish))}
(root/'docs/verification/procurement-real-prepare.json').write_text(json.dumps(result,indent=2)+'\n')
print(json.dumps(result))
