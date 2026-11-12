/** Server-owned trust + 3/3 Ed25519 operator reports, never an execution proof.
 * No network, wallet, key generation, or evidence-supplied trust anchors.
 */
import {createPublicKey, sign, verify} from 'node:crypto';
import {closeSync, constants, fstatSync, fsyncSync, lstatSync, openSync, readFileSync, writeFileSync} from 'node:fs';
import {join, resolve} from 'node:path';
import {canonical, exact, hash32, ID, precommitContext, sha256, validateIntent} from '../procurement/codec.mjs';

const DOMAIN = Buffer.from('VEIL-OPERATOR-SELECTION-v1\0');
const SPKI = Buffer.from('302a300506032b6570032100', 'hex');
const COMMITTEE_FIELDS = ['schema','epoch','notBeforeMs','expiresAtMs','operation','members'];
const PAYLOAD_FIELDS = ['schema','kind','committeeHash','epoch','operation','jobId','closedRevision','contextHash','selectionRound','buyer','roster','commitments','selectedProvider','issuedAtMs','expiresAtMs'];
const requireThat = value => {if (!value) throw new Error('Operator selection evidence rejected');};
const integer = value => Number.isSafeInteger(value) && value >= 0;
const memberId = value => typeof value === 'string' && /^[a-z][a-z0-9-]{0,62}$/.test(value);
export const committeeHash = committee => sha256(canonical(committee));
export const evidenceBytes = evidence => Buffer.from(canonical(evidence), 'ascii');
export const evidenceHash = evidence => sha256(evidenceBytes(evidence));

export function validateCommittee(committee, expectedHash, nowMs) {
  requireThat(hash32(expectedHash) && exact(committee, COMMITTEE_FIELDS) && committeeHash(committee) === expectedHash);
  requireThat(committee.schema === 'veil-selection-committee-v1' && integer(committee.epoch) && committee.epoch > 0 &&
    integer(nowMs) && integer(committee.notBeforeMs) && integer(committee.expiresAtMs) &&
    committee.notBeforeMs <= nowMs && nowMs < committee.expiresAtMs && committee.expiresAtMs - committee.notBeforeMs <= 7*86400000 &&
    ['local-synthetic','operator-reported'].includes(committee.operation));
  requireThat(Array.isArray(committee.members) && committee.members.length === 3 &&
    committee.members.every(m => exact(m,['id','publicKey']) && memberId(m.id) && hash32(m.publicKey)) &&
    new Set(committee.members.map(m=>m.id)).size === 3 && new Set(committee.members.map(m=>m.publicKey)).size === 3);
}

function frozenJob(job, nowMs) {
  requireThat(job && typeof job.id === 'string' && ID.test(job.id) && job.status === 'CLOSED' &&
    integer(job.revision) && integer(job.closedAt) && job.closedAt <= nowMs &&
    job.ledger === 'app' && job.blockchainBinding === 'pending');
  validateIntent(job.intent);
  requireThat(job.contextHash === precommitContext(job.intent) && job.buyer === job.intent.buyer &&
    canonical(job.roster) === canonical(job.intent.roster) && job.bidDeadlineNs === job.intent.bidDeadlineNs &&
    job.resultDeadlineNs === job.intent.resultDeadlineNs && BigInt(job.closedAt)*1000000n >= BigInt(job.bidDeadlineNs) &&
    BigInt(nowMs)*1000000n < BigInt(job.resultDeadlineNs) && hash32(job.budgetCommitment));
  requireThat(Array.isArray(job.bids) && job.bids.length === 3 && job.bids.every((b,i) =>
    exact(b,['provider','slot','commitment']) && b.provider === job.roster[i] && b.slot === i+1 && hash32(b.commitment)));
  return [job.budgetCommitment, ...job.bids.map(b=>b.commitment)];
}

/** Public selection statement to be reviewed independently at EACH operator.
 * The signer must actually observe/approve the result. This cannot derive a
 * winner from commitments; no prices, salts or buyer budget belong here.
 */
export function selectionPayload(job, selectedProvider, committee, expectedHash, nowMs) {
  validateCommittee(committee, expectedHash, nowMs);
  const commitments = frozenJob(job, nowMs);
  const slot = job.roster.indexOf(selectedProvider);
  requireThat(slot >= 0 && job.intent.qualified[slot] === true);
  return {
    schema:'veil-selection-report-v1', kind:'operator-reported-selection',
    committeeHash:expectedHash, epoch:committee.epoch, operation:committee.operation,
    jobId:job.id, closedRevision:job.revision, contextHash:job.contextHash,
    selectionRound:job.intent.selectionRound, buyer:job.buyer, roster:[...job.roster],
    commitments, selectedProvider, issuedAtMs:nowMs,
    expiresAtMs:Math.min(nowMs+300000, committee.expiresAtMs,
      Number(BigInt(job.resultDeadlineNs)/1000000n)),
  };
}

function publicObject(raw) {
  return createPublicKey({key:Buffer.concat([SPKI,Buffer.from(raw,'hex')]),format:'der',type:'spki'});
}
const signingBytes = payload => Buffer.concat([DOMAIN, evidenceBytes(payload)]);

function reportHeader(payload, committee, expectedHash, nowMs) {
  validateCommittee(committee, expectedHash, nowMs);
  requireThat(exact(payload,PAYLOAD_FIELDS) && payload.committeeHash === expectedHash &&
    payload.epoch === committee.epoch && payload.operation === committee.operation &&
    payload.schema === 'veil-selection-report-v1' && payload.kind === 'operator-reported-selection' &&
    integer(payload.issuedAtMs) && integer(payload.expiresAtMs) &&
    committee.notBeforeMs <= payload.issuedAtMs && payload.issuedAtMs <= nowMs && nowMs < payload.expiresAtMs &&
    payload.expiresAtMs <= Math.min(payload.issuedAtMs+300000,committee.expiresAtMs));
}

export function signReport(payload, operatorId, privateKey, committee, expectedHash, nowMs) {
  reportHeader(payload,committee,expectedHash,nowMs);
  const member = committee.members.find(m=>m.id===operatorId);
  requireThat(member);
  const signature = sign(null, signingBytes(payload), privateKey);
  requireThat(verify(null, signingBytes(payload), publicObject(member.publicKey), signature));
  return {operatorId,signature:signature.toString('hex')};
}

/** Crash-conservative one-report-per-job/round/signer journal. Directory must
 * already exist, owned by this UID, mode 0700. Missing completed record after a
 * crash is burned: do not delete reservation to retry. No admin rollback defense.
 */
export function signReportOnce(payload, operatorId, keyPath, directory, committee, expectedHash, nowMs) {
  const dir = lstatSync(directory);
  requireThat(dir.isDirectory() && !dir.isSymbolicLink() && dir.uid === process.getuid() && (dir.mode & 0o077) === 0);
  const fd = openSync(keyPath,constants.O_RDONLY|constants.O_NOFOLLOW);
  let key;
  try {
    const info=fstatSync(fd);
    requireThat(info.isFile() && info.uid === process.getuid() && (info.mode & 0o077) === 0 && info.size <= 8192);
    key=readFileSync(fd);
  } finally {closeSync(fd);}
  reportHeader(payload,committee,expectedHash,nowMs);
  const member=committee.members.find(m=>m.id===operatorId);
  requireThat(member && createPublicKey(key).export({format:'der',type:'spki'}).equals(
    Buffer.concat([SPKI,Buffer.from(member.publicKey,'hex')])));
  requireThat(typeof payload.jobId === 'string' && ID.test(payload.jobId) && hash32(payload.selectionRound) && memberId(operatorId));
  const token=sha256(`VEIL-REPORT-JOURNAL-v1\0${payload.jobId}\0${payload.selectionRound}\0${operatorId}`);
  const reservation=join(resolve(directory),token+'.reserved');
  const writeNew=(path,value)=>{const f=openSync(path,'wx',0o600);try{writeFileSync(f,value);fsyncSync(f);}finally{closeSync(f);}};
  writeNew(reservation,evidenceBytes({payloadHash:sha256(evidenceBytes(payload))}));
  const syncDir=()=>{const f=openSync(directory,'r');try{fsyncSync(f);}finally{closeSync(f);}};
  syncDir();
  // Sign only after durable reservation.
  const completed={operatorId,signature:signReport(payload,operatorId,key,committee,expectedHash,nowMs).signature};
  writeNew(join(resolve(directory),token+'.receipt'),evidenceBytes(completed));
  syncDir();
  return completed;
}

/** Typed integration:
 * input: {job: frozen procurement Job, evidenceHash: hex32}
 * output: EXACT {provider, contextHash, evidenceHash, closedRevision, commitments}
 * loadEvidence(hash) MUST return bounded immutable canonical JSON bytes, obtained
 * from server-owned storage, not a URL/key supplied by the HTTP caller.
 * HTTP core owns authorization, CAS and durable one-time CLOSED -> SELECTED.
 */
export function createSelectionVerifier({committee,expectedCommitteeHash,loadEvidence,now=Date.now,allowLocalSynthetic=false}) {
  // Snapshot configured trust; mutating the caller's object cannot change keys.
  const trusted=structuredClone(committee);
  requireThat(typeof loadEvidence === 'function');
  const verifySelection = async function ({job,evidenceHash:expectedEvidenceHash}) {
    let nowMs=now();
    validateCommittee(trusted,expectedCommitteeHash,nowMs);
    requireThat(trusted.operation !== 'local-synthetic' || allowLocalSynthetic === true);
    requireThat(hash32(expectedEvidenceHash));
    const raw=await loadEvidence(expectedEvidenceHash);
    nowMs=now(); // Storage latency must not extend committee or receipt validity.
    validateCommittee(trusted,expectedCommitteeHash,nowMs);
    requireThat((Buffer.isBuffer(raw) || raw instanceof Uint8Array) && raw.length <= 16384);
    const bytes=Buffer.from(raw);
    requireThat(sha256(bytes) === expectedEvidenceHash);
    const report=JSON.parse(bytes.toString('utf8'));
    requireThat(exact(report,['payload','signatures']) && evidenceBytes(report).equals(bytes));
    const p=report.payload;
    requireThat(exact(p,PAYLOAD_FIELDS) && integer(p.issuedAtMs) && p.issuedAtMs <= nowMs &&
      p.issuedAtMs >= job.closedAt && nowMs < p.expiresAtMs);
    const expected=selectionPayload(job,p.selectedProvider,trusted,expectedCommitteeHash,p.issuedAtMs);
    requireThat(canonical(p) === canonical(expected));
    frozenJob(job,nowMs); // Recheck job deadline at verification, not only issuance.
    requireThat(Array.isArray(report.signatures) && report.signatures.length === 3);
    const seen=new Set();
    for (const s of report.signatures) {
      requireThat(exact(s,['operatorId','signature']) && typeof s.signature === 'string' && /^[0-9a-f]{128}$/.test(s.signature));
      const member=trusted.members.find(m=>m.id===s.operatorId);
      requireThat(member && !seen.has(member.id));
      requireThat(verify(null,signingBytes(p),publicObject(member.publicKey),Buffer.from(s.signature,'hex')));
      seen.add(member.id);
    }
    const completedAt=now();
    validateCommittee(trusted,expectedCommitteeHash,completedAt);
    requireThat(completedAt < p.expiresAtMs);
    frozenJob(job,completedAt);
    return {provider:p.selectedProvider,contextHash:p.contextHash,evidenceHash:expectedEvidenceHash,
      closedRevision:p.closedRevision,commitments:[...p.commitments]};
  };
  return Object.freeze({verify:verifySelection,assurance:Object.freeze({
    kind:'operator-reported-selection',operation:trusted.operation,
    independentOperators:false,executionProof:false,chainFinalityVerified:false,
  })});
}
