import test from 'node:test';
import assert from 'node:assert/strict';
import {generateKeyPairSync} from 'node:crypto';
import {mkdtempSync,readFileSync,rmSync,mkdirSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {precommitContext} from '../../procurement/codec.mjs';
import {createSelectionVerifier,committeeHash,evidenceBytes,evidenceHash,selectionPayload,signReport,signReportOnce} from '../selection-verifier.mjs';

const now=1800000000000;
const keys=[0,1,2,3].map(()=>generateKeyPairSync('ed25519'));
const publicKey=k=>k.publicKey.export({format:'der',type:'spki'}).subarray(12).toString('hex');
function fixture(operation='operator-reported') {
  const intent=JSON.parse(readFileSync(new URL('../examples/synthetic-v2-plan.json',import.meta.url))).execution.intent;
  intent.bidDeadlineNs=String(BigInt(now-1000)*1000000n);
  intent.resultDeadlineNs=String(BigInt(now+3600000)*1000000n);
  const job={id:'ab'.repeat(16),status:'CLOSED',revision:5,closedAt:now-500,ledger:'app',blockchainBinding:'pending',
    intent,buyer:intent.buyer,roster:intent.roster,contextHash:precommitContext(intent),
    bidDeadlineNs:intent.bidDeadlineNs,resultDeadlineNs:intent.resultDeadlineNs,
    budgetCommitment:'f1'.repeat(32),bids:intent.roster.map((provider,i)=>({provider,slot:i+1,commitment:`a${i+1}`.repeat(32)}))};
  const committee={schema:'veil-selection-committee-v1',epoch:1,notBeforeMs:now-1000,expiresAtMs:now+600000,
    operation,members:keys.slice(0,3).map((k,i)=>({id:`operator-${i}`,publicKey:publicKey(k)}))};
  const pin=committeeHash(committee);
  const payload=selectionPayload(job,job.roster[1],committee,pin,now);
  const report={payload,signatures:keys.slice(0,3).map((k,i)=>signReport(payload,`operator-${i}`,k.privateKey,committee,pin,now))};
  return {job,committee,pin,report};
}
async function check(f, options={}) {
  const hash=evidenceHash(f.report);
  const verifier=createSelectionVerifier({committee:f.committee,expectedCommitteeHash:f.pin,
    loadEvidence:async()=>evidenceBytes(f.report),now:()=>now,...options});
  return verifier.verify({job:f.job,evidenceHash:hash});
}

test('3/3 configured signatures bind exact provider without claiming independence or proof',async()=>{
  const f=fixture();const verified=await check(f);
  assert.equal(verified.provider,f.job.roster[1]);
  assert.deepEqual(Object.keys(verified).sort(),['provider','contextHash','evidenceHash','closedRevision','commitments'].sort());
  assert.equal(verified.contextHash,f.job.contextHash);
  assert.deepEqual(verified.commitments,[f.job.budgetCommitment,...f.job.bids.map(b=>b.commitment)]);
});

test('arbitrary signer, wrong key, duplicate member, partial quorum and signature tamper fail',async()=>{
  for (const change of [
    r=>r.signatures[0].operatorId='attacker',
    r=>r.signatures[0].signature='00'.repeat(64),
    r=>r.signatures[1]=r.signatures[0],
    r=>r.signatures.pop(),
  ]) {const f=fixture();change(f.report);await assert.rejects(check(f));}
  const f=fixture();
  assert.throws(()=>signReport(f.report.payload,'operator-0',keys[3].privateKey,f.committee,f.pin,now));
});

test('legitimate signatures for a foreign app job, context, frozen commitment, round or provider fail',async()=>{
  for (const change of [
    p=>p.jobId='bc'.repeat(16),p=>p.contextHash='a'.repeat(64),p=>p.selectionRound='b'.repeat(64),
    p=>p.commitments[0]='c'.repeat(64),p=>p.commitments[2]='d'.repeat(64),
    p=>p.roster.reverse(),p=>p.buyer='another.testnet',p=>p.closedRevision++,p=>p.selectedProvider='outsider.testnet',
  ]) {
    const f=fixture();change(f.report.payload);
    f.report.signatures=keys.slice(0,3).map((k,i)=>signReport(f.report.payload,`operator-${i}`,k.privateKey,f.committee,f.pin,now));
    await assert.rejects(check(f));
  }
});

test('changing selected provider without new member signatures fails',async()=>{
  const f=fixture();f.report.payload.selectedProvider=f.job.roster[0];await assert.rejects(check(f));
});

test('expired roster, expired receipt, future issue and same epoch foreign committee fail',async()=>{
  const f=fixture();
  await assert.rejects(check(f,{now:()=>now+300000}));
  await assert.rejects(check(f,{now:()=>now+600000}));
  await assert.rejects(check(f,{now:()=>now-1}));
  f.committee.members[0].publicKey=publicKey(keys[3]);await assert.rejects(check(f));
});

test('storage latency cannot extend an expired receipt or roster',async()=>{
  const f=fixture();let clock=now;
  const verifier=createSelectionVerifier({committee:f.committee,expectedCommitteeHash:f.pin,now:()=>clock,
    loadEvidence:async()=>{clock=now+300001;return evidenceBytes(f.report);}});
  await assert.rejects(verifier.verify({job:f.job,evidenceHash:evidenceHash(f.report)}));
});

test('missing slots, reorder, wrong context, nonclosed job and post-selection replay fail',async()=>{
  for (const change of [j=>j.bids[1].commitment=null,j=>j.bids.reverse(),j=>j.contextHash='a'.repeat(64),
    j=>j.status='SELECTED',j=>j.status='PUBLISHED',j=>j.revision++,j=>j.intent.qualified[1]=false,
    j=>j.ledger='near',j=>j.blockchainBinding='confirmed']) {
    const f=fixture();change(f.job);await assert.rejects(check(f));
  }
});

test('local-synthetic committee requires explicit server opt-in',async()=>{
  const f=fixture('local-synthetic');await assert.rejects(check(f));
  assert.equal((await check(f,{allowLocalSynthetic:true})).provider,f.job.roster[1]);
});

test('hash substitution, noncanonical/duplicate JSON and unsupported proof claims fail',async()=>{
  const f=fixture();
  await assert.rejects(check(f,{loadEvidence:async()=>Buffer.from('{}')}));
  const pretty=Buffer.from(JSON.stringify(f.report,null,2));
  const verifier=createSelectionVerifier({committee:f.committee,expectedCommitteeHash:f.pin,now:()=>now,loadEvidence:async()=>pretty});
  const {createHash}=await import('node:crypto');
  await assert.rejects(verifier.verify({job:f.job,evidenceHash:createHash('sha256').update(pretty).digest('hex')}));
  f.report.payload.executionProof=true;await assert.rejects(check(f));
});

test('configured committee cannot be replaced by mutating the original object',async()=>{
  const f=fixture();const hash=evidenceHash(f.report);
  const verifier=createSelectionVerifier({committee:f.committee,expectedCommitteeHash:f.pin,now:()=>now,loadEvidence:async()=>evidenceBytes(f.report)});
  f.committee.members[0].publicKey=publicKey(keys[3]);
  assert.equal((await verifier.verify({job:f.job,evidenceHash:hash})).provider,f.job.roster[1]);
});

test('durable signing reservation rejects repeat and conflicting selected provider across restart',()=>{
  const f=fixture();const dir=mkdtempSync(join(tmpdir(),'veil-report-'));
  try {
    const state=join(dir,'state');mkdirSync(state,0o700);
    const key=join(dir,'operator.key');writeFileSync(key,keys[0].privateKey.export({format:'pem',type:'pkcs8'}),{mode:0o600});
    const signed=signReportOnce(f.report.payload,'operator-0',key,state,f.committee,f.pin,now);
    assert.equal(signed.signature,f.report.signatures[0].signature);
    assert.throws(()=>signReportOnce(f.report.payload,'operator-0',key,state,f.committee,f.pin,now));
    const conflict={...f.report.payload,selectedProvider:f.job.roster[0]};
    assert.throws(()=>signReportOnce(conflict,'operator-0',key,state,f.committee,f.pin,now));
  } finally {rmSync(dir,{recursive:true,force:true});}
});

test('real procurement HTTP handler accepts exact signed frozen result and blocks new-key replay',async()=>{
  const {createProcurement}=await import('../../procurement/core.mjs');
  const {sha256}=await import('../../procurement/codec.mjs');
  const f=fixture();let clock=now-2000;
  const tokens=['a','b','c','d','e'].map(x=>x.repeat(43));
  const principals=[f.job.buyer,...f.job.roster,'committee.testnet'];
  const roles=['buyer','provider','provider','provider','operator'];
  const env={NOPE_PROCUREMENT_GRANTS:JSON.stringify(tokens.map((token,i)=>({tokenHash:sha256(token),principal:principals[i],role:roles[i],expiresAt:now+3600000})))};
  const records=new Map();
  const store={read:async key=>structuredClone(records.get(key)??null),create:async(key,value)=>{
    if(records.has(key))return false;records.set(key,structuredClone(value));return true;
  },list:async()=>({pathnames:[],cursor:null})};
  let report;
  const adapter=createSelectionVerifier({committee:f.committee,expectedCommitteeHash:f.pin,now:()=>clock,loadEvidence:async()=>evidenceBytes(report)});
  const handle=createProcurement({store,env,now:()=>clock,selectionVerifier:adapter});
  let sequence=0;
  async function post(path,who,body,key=`operator-test-${String(sequence++).padStart(8,'0')}`) {
    const response=await handle(new Request('https://synthetic.test/api/procurement'+path,{method:'POST',
      headers:{'Content-Type':'application/json',Authorization:`Bearer ${tokens[who]}`,'Idempotency-Key':key},body:JSON.stringify(body)}));
    return {status:response.status,body:await response.json()};
  }
  const id=f.job.id;
  let response=await post('/jobs',0,{jobId:id,title:'Synthetic committee bridge',profile:'clean-4-records-v1',roster:f.job.roster,
    bidDeadlineNs:f.job.bidDeadlineNs,resultDeadlineNs:f.job.resultDeadlineNs});
  assert.equal(response.status,201);
  response=await post(`/jobs/${id}/publish`,0,{expectedRevision:0,intent:f.job.intent,budgetCommitment:f.job.budgetCommitment});assert.equal(response.status,200);
  for(let i=0;i<3;i++) {
    response=await post(`/jobs/${id}/bids`,i+1,{expectedRevision:i+1,commitment:f.job.bids[i].commitment});assert.equal(response.status,200);
  }
  clock=now;
  response=await post(`/jobs/${id}/close`,0,{expectedRevision:4});assert.equal(response.status,200);
  const closed=response.body.job;
  const payload=selectionPayload(closed,closed.roster[1],f.committee,f.pin,now);
  report={payload,signatures:keys.slice(0,3).map((k,i)=>signReport(payload,`operator-${i}`,k.privateKey,f.committee,f.pin,now))};
  const hash=evidenceHash(report),request={expectedRevision:5,evidenceHash:hash};
  const bad=structuredClone(report);bad.payload.jobId='cc'.repeat(16);
  report=bad;
  response=await post(`/jobs/${id}/selection`,4,request);assert.equal(response.status,503);
  report={payload,signatures:keys.slice(0,3).map((k,i)=>signReport(payload,`operator-${i}`,k.privateKey,f.committee,f.pin,now))};
  response=await post(`/jobs/${id}/selection`,4,request,'same-selection-key-0001');
  assert.equal(response.status,200);assert.equal(response.body.job.status,'SELECTED');
  assert.deepEqual(response.body.job.selection,{provider:closed.roster[1],evidenceHash:hash});
  response=await post(`/jobs/${id}/selection`,4,request,'same-selection-key-0001');assert.equal(response.status,200);
  response=await post(`/jobs/${id}/selection`,4,{expectedRevision:6,evidenceHash:hash});assert.equal(response.status,409);
});
