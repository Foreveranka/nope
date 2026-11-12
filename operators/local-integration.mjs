/** Run real local MPC -> ephemeral local synthetic report committee -> verifier.
 * No persisted signing keys, external hosts, deployment, payment or chain writes.
 */
import {generateKeyPairSync} from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {createProcurement} from '../procurement/core.mjs';
import {sha256} from '../procurement/codec.mjs';
import {createSelectionVerifier,committeeHash,evidenceBytes,evidenceHash,selectionPayload,signReport} from './selection-verifier.mjs';

const root=fileURLToPath(new URL('../',import.meta.url));
const run=spawnSync(process.env.PYTHON || 'python3',['-m','operators.local_mpc',...process.argv.slice(2)],{
  cwd:root,env:{...process.env,PYTHONDONTWRITEBYTECODE:'1'},encoding:'utf8',timeout:660000,maxBuffer:262144,
});
if (run.status !== 0) throw new Error('Native local MPC failed; inspect existing ignored mpc/runtime logs. No report issued.');
const result=JSON.parse(run.stdout);
if (result.runtime.status !== 'VERIFIED_LOCAL_MPC' || result.runtime.independentOperators !== false || !result.selectedProvider)
  throw new Error('No awarded real local synthetic result');
const now=Date.now();
const keys=[0,1,2].map(()=>generateKeyPairSync('ed25519'));
const committee={schema:'veil-selection-committee-v1',epoch:1,notBeforeMs:now-1000,expiresAtMs:now+300000,
  operation:'local-synthetic',members:keys.map((k,i)=>({id:`local-p${i}`,publicKey:k.publicKey.export({format:'der',type:'spki'}).subarray(12).toString('hex')}))};
const pin=committeeHash(committee);
// Exercise the actual HTTP handler too. This synthetic in-memory app lifecycle
// uses an injected clock to reconstruct admission before the already-run MPC's
// frozen deadline. It is not a deployed ledger or a finalized registry snapshot.
const records=new Map();
const store={read:async k=>structuredClone(records.get(k)??null),create:async(k,v)=>{
  if(records.has(k))return false;records.set(k,structuredClone(v));return true;
},list:async()=>({pathnames:[],cursor:null})};
const tokens=['a','b','c','d','e'].map(x=>x.repeat(43)); // Public synthetic invitations, no real credentials.
const principals=[result.job.buyer,...result.job.roster,'local-operator.near'];
const roles=['buyer','provider','provider','provider','operator'];
const env={NOPE_PROCUREMENT_GRANTS:JSON.stringify(tokens.map((t,i)=>({tokenHash:sha256(t),principal:principals[i],role:roles[i],expiresAt:now+3600000})))};
let clock=Number(BigInt(result.job.bidDeadlineNs)/1000000n)-1000;
let report,hash;
const verifier=createSelectionVerifier({committee,expectedCommitteeHash:pin,loadEvidence:async h=>{
  if (h!==hash) throw new Error('Unknown evidence');return evidenceBytes(report);
},allowLocalSynthetic:true});
const handle=createProcurement({store,env,now:()=>clock,selectionVerifier:verifier});
let sequence=0;
async function post(path,who,body) {
  const response=await handle(new Request('https://local-synthetic.test/api/procurement'+path,{
    method:'POST',headers:{'Content-Type':'application/json',Authorization:`Bearer ${tokens[who]}`,
      'Idempotency-Key':`local-operator-${String(sequence++).padStart(8,'0')}`},body:JSON.stringify(body),
  }));
  if(!response.ok)throw new Error(`Procurement integration failed: HTTP ${response.status}`);
  return response.json();
}
const j=result.job,id=j.id;
await post('/jobs',0,{jobId:id,title:j.title,profile:j.profile,roster:j.roster,bidDeadlineNs:j.bidDeadlineNs,resultDeadlineNs:j.resultDeadlineNs});
await post(`/jobs/${id}/publish`,0,{expectedRevision:0,intent:j.intent,budgetCommitment:j.budgetCommitment});
for(let i=0;i<3;i++)await post(`/jobs/${id}/bids`,i+1,{expectedRevision:i+1,commitment:j.bids[i].commitment});
clock=j.closedAt;
const {job:closedJob}=await post(`/jobs/${id}/close`,0,{expectedRevision:4});
const payload=selectionPayload(closedJob,result.selectedProvider,committee,pin,now);
report={payload,signatures:keys.map((k,i)=>signReport(payload,`local-p${i}`,k.privateKey,committee,pin,now))};
hash=evidenceHash(report);
clock=Date.now();
const verified=await verifier.verify({job:closedJob,evidenceHash:hash});
const {job:selectedJob}=await post(`/jobs/${id}/selection`,4,{expectedRevision:closedJob.revision,evidenceHash:hash});
console.log(JSON.stringify({schema:'veil-local-operator-integration-v1',runtime:result.runtime,
  job:closedJob,committee,committeeHash:pin,evidenceHash:hash,report,verified,assurance:verifier.assurance,
  httpIntegration:{status:selectedJob.status,selection:selectedJob.selection,revision:selectedJob.revision,
    storage:'synthetic-in-memory',admissionClock:'injected-pre-MPC-deadline',deployed:false}},null,2));
