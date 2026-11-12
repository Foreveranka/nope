import {timingSafeEqual} from 'node:crypto';
import {PROFILE,ID,HEX,sha256,exact,hash32,account,validRoster,validDeadlines,validateIntent,precommitContext,canonical} from './codec.mjs';

const ROOT='nope-procurement-v1/';
const MAX_REVISIONS=64;
const MAX_BODY=16384;
class HttpError extends Error {constructor(status,code,message){super(message);this.status=status;this.code=code;}}
const fail=(status,code,message)=>{throw new HttpError(status,code,message);};
const pathFor=(id,revision)=>`${ROOT}jobs/${id}/revisions/${String(revision).padStart(3,'0')}.json`;
const participantPrefix=principal=>`${ROOT}participants/${sha256(principal)}/`;
const participants=job=>[job.buyer,...job.roster];
const canRead=(grant,job)=>grant.role==='buyer'&&grant.principal===job.buyer || grant.role==='provider'&&job.status!=='DRAFT'&&job.roster.includes(grant.principal);
const role=(grant,wanted)=>{if(grant.role!==wanted)fail(403,'FORBIDDEN','Role not authorized.');};
const own=(grant,job)=>{role(grant,'buyer');if(grant.principal!==job.buyer)fail(404,'NOT_FOUND','Job not found.');};
const schema=(body,fields)=>{if(!exact(body,fields))fail(400,'INVALID_BODY','Invalid request schema.');};
const state=(job,allowed)=>{if(!allowed.includes(job.status))fail(409,'INVALID_STATE','Operation unavailable in this job state.');};
const nanoseconds=milliseconds=>BigInt(milliseconds)*1000000n;

function grantsFrom(env){
  let grants;
  try{grants=JSON.parse(env.NOPE_PROCUREMENT_GRANTS||'[]');}catch{fail(503,'IDENTITY_UNAVAILABLE','Invitation configuration unavailable.');}
  const seen=new Set();
  if(!Array.isArray(grants)||grants.length>100)fail(503,'IDENTITY_UNAVAILABLE','Invitation configuration unavailable.');
  for(const g of grants){
    if(!exact(g,['tokenHash','principal','role','expiresAt'])||typeof g.tokenHash!=='string'||!HEX.test(g.tokenHash)||!account(g.principal)||!['buyer','provider','operator'].includes(g.role)||!Number.isSafeInteger(g.expiresAt)||g.expiresAt<0||seen.has(g.tokenHash))fail(503,'IDENTITY_UNAVAILABLE','Invitation configuration unavailable.');
    seen.add(g.tokenHash);
  }
  return grants;
}
function authenticate(request,grants,time){
  const header=request.headers.get('authorization')||'';
  if(!/^Bearer [A-Za-z0-9_-]{43,128}$/.test(header))fail(401,'INVITATION_REQUIRED','Access invitation required.');
  const hash=Buffer.from(sha256(header.slice(7)),'hex');
  const grant=grants.find(g=>timingSafeEqual(hash,Buffer.from(g.tokenHash,'hex')));
  if(!grant)fail(401,'INVITATION_INVALID','Access invitation invalid.');
  if(grant.expiresAt<=time)fail(401,'INVITATION_EXPIRED','Access invitation expired.');
  return grant;
}
// JSON.parse validates syntax; this bounded second pass rejects duplicate keys and excessive depth.
function strictJSON(source){
  const parsed=JSON.parse(source);let p=0;
  const space=()=>{while(/\s/.test(source[p]||'x'))p++;};
  const string=()=>{const start=p++;while(p<source.length){if(source[p]==='\\'){p+=2;continue;}if(source[p++]==='"')return JSON.parse(source.slice(start,p));}throw Error('string');};
  const walk=depth=>{
    if(depth>16)throw Error('depth');space();
    if(source[p]==='{'){
      p++;space();const seen=new Set();if(source[p]==='}'){p++;return;}
      for(;;){space();const key=string();if(seen.has(key))throw Error('duplicate');seen.add(key);space();p++;walk(depth+1);space();if(source[p++]==='}')break;}
    }else if(source[p]==='['){p++;space();if(source[p]===']'){p++;return;}for(;;){walk(depth+1);space();if(source[p++]===']')break;}}
    else if(source[p]==='"')string();
    else{while(p<source.length&&!/[\s,}\]]/.test(source[p]))p++;}
  };
  walk(0);return parsed;
}
async function bodyFor(request){
  if(!/^application\/json(?:\s*;|$)/i.test(request.headers.get('content-type')||''))fail(415,'JSON_REQUIRED','JSON required.');
  const length=request.headers.get('content-length');
  if(length&&/^\d+$/.test(length)&&Number(length)>MAX_BODY)fail(413,'BODY_TOO_LARGE','Payload too large.');
  if(!request.body)fail(400,'INVALID_JSON','JSON object required.');
  const reader=request.body.getReader();const chunks=[];let size=0;
  try{for(;;){const {done,value}=await reader.read();if(done)break;size+=value.byteLength;if(size>MAX_BODY){await reader.cancel();fail(413,'BODY_TOO_LARGE','Payload too large.');}chunks.push(Buffer.from(value));}}
  finally{reader.releaseLock();}
  try{return strictJSON(new TextDecoder('utf-8',{fatal:true}).decode(Buffer.concat(chunks)));}catch{fail(400,'INVALID_JSON','Invalid or ambiguous JSON.');}
}
const capabilities=selectionVerifier=>({durableAppLedger:true,sealedCommitments:true,selectionAdapterConfigured:typeof selectionVerifier?.verify==='function',blockchainBinding:false,encryptedExecution:false,independentOperators:false,payments:false});

export function createProcurement({store,env=process.env,now=Date.now,selectionVerifier}={}){
  if(!store||!['read','create','list'].every(k=>typeof store[k]==='function'))throw new Error('Durable procurement store required');
  const response=(data,status=200)=>Response.json(data,{status,headers:{'Cache-Control':'no-store','X-Content-Type-Options':'nosniff','Referrer-Policy':'no-referrer'}});
  async function history(id){
    const records=[];
    for(let n=0;n<MAX_REVISIONS;n++){
      const record=await store.read(pathFor(id,n));if(record===null)break;
      if(!record||record.schema!==1||record.job?.id!==id||record.job.revision!==n||record.previousHash!==(n?sha256(canonical(records[n-1])):null)||!exact(record.operation,['actor','role','keyHash','fingerprint','httpStatus']))fail(503,'LEDGER_UNAVAILABLE','Ledger integrity unavailable.');
      records.push(record);
    }
    return records;
  }
  async function write(record){
    const path=pathFor(record.job.id,record.job.revision);
    try{
      if(await store.create(path,record))return;
    }catch{
      let found;
      try{found=await store.read(path);}catch{fail(503,'STORAGE_UNKNOWN','Storage outcome unknown; retry the same key and payload.');}
      if(found&&canonical(found)===canonical(record))return;
      if(found&&canonical(found.operation)===canonical(record.operation))return found;
      if(found)fail(409,'REVISION_CONFLICT','Revision occupied; retrieve the current job.');
      fail(503,'STORAGE_UNKNOWN','Storage outcome unknown; retry the same key and payload.');
    }
    const found=await store.read(path);
    if(found&&canonical(found)===canonical(record))return;
    // Same operation can race with independently sampled server timestamps.
    if(found&&canonical(found.operation)===canonical(record.operation))return found;
    if(!found)fail(503,'STORAGE_UNKNOWN','Storage outcome unknown; retry the same key and payload.');
    fail(409,'REVISION_CONFLICT','Revision occupied; retrieve the current job.');
  }
  return async request=>{
    try{
      const url=new URL(request.url);const path=url.pathname;const method=request.method;
      const origin=request.headers.get('origin');
      const allowedOrigin=env.NOPE_PROCUREMENT_ORIGIN||url.origin;
      if(origin&&origin!==allowedOrigin)fail(403,'ORIGIN_DENIED','Origin denied.');
      if(path==='/api/procurement/health'&&method==='GET')return response({ok:true,version:'1',profile:PROFILE,ledger:'app',blockchainBinding:'pending',capabilities:capabilities(selectionVerifier)});
      const grants=grantsFrom(env);const grant=authenticate(request,grants,now());
      const activeProviders=()=>[...new Set(grants.filter(g=>g.role==='provider'&&g.expiresAt>now()).map(g=>g.principal))].sort();
      if(path==='/api/procurement/session'&&method==='GET')return response({principal:grant.principal,role:grant.role,expiresAt:grant.expiresAt,profile:PROFILE,ledger:'app',blockchainBinding:'pending',capabilities:capabilities(selectionVerifier),...(grant.role==='buyer'?{availableProviders:activeProviders()}: {})});
      const collection=path==='/api/procurement/jobs';
      const match=/^\/api\/procurement\/jobs\/([0-9a-f]{32})(?:\/(publish|bids|close|selection|deliveries|decision))?$/.exec(path);
      if(!collection&&!match)fail(404,'NOT_FOUND','Route not found.');
      if(collection&&method==='GET'){
        const allowed=new Set(['limit','cursor']);
        if([...url.searchParams.keys()].some(k=>!allowed.has(k)||url.searchParams.getAll(k).length!==1))fail(400,'INVALID_QUERY','Invalid listing query.');
        const limitValue=url.searchParams.get('limit')||'20';const cursor=url.searchParams.get('cursor')||undefined;
        if(!/^(?:[1-9]|1[0-9]|20)$/.test(limitValue)||(cursor&&(cursor.length>2048||/[\x00-\x20\x7f]/.test(cursor))))fail(400,'INVALID_QUERY','Invalid listing bounds.');
        const prefix=participantPrefix(grant.principal);const limit=Number(limitValue);
        const page=await store.list({prefix,limit,cursor});
        if(!page||!Array.isArray(page.pathnames)||page.pathnames.length>limit||page.pathnames.some(p=>typeof p!=='string'||!p.startsWith(prefix)||!ID.test(p.slice(prefix.length,-5))||!p.endsWith('.json'))||(page.cursor!==null&&typeof page.cursor!=='string'))throw Error('Invalid index listing');
        const jobs=[];
        for(const indexed of page.pathnames){const id=indexed.slice(prefix.length,-5);const records=await history(id);const job=records.at(-1)?.job;if(job&&canRead(grant,job))jobs.push(job);}
        return response({jobs,nextCursor:page.cursor});
      }
      if(!['GET','POST'].includes(method)||collection&&method!=='POST'||match&&method==='GET'&&match[2])fail(405,'METHOD_NOT_ALLOWED','Method not allowed.');
      let body,key,fingerprint,keyHash;
      if(method==='POST'){
        key=request.headers.get('idempotency-key')||'';
        if(!/^[A-Za-z0-9_-]{16,80}$/.test(key))fail(400,'IDEMPOTENCY_REQUIRED','A 16–80 character Idempotency-Key is required.');
        body=await bodyFor(request);
        keyHash=sha256(key);
        fingerprint=sha256(canonical({method,path,body}));
      }
      if(match?.[2]==='selection')role(grant,'operator');
      const id=collection?body?.jobId:match[1];
      if(typeof id!=='string'||!ID.test(id))fail(400,'INVALID_JOB_ID','Invalid job identifier.');
      const records=await history(id);const current=records.at(-1)?.job;const action=collection?'create':match[2];
      if(current){
        if(action==='selection')role(grant,'operator');
        else if(!canRead(grant,current))fail(404,'NOT_FOUND','Job not found.');
      }else if(!collection)fail(404,'NOT_FOUND','Job not found.');
      if(method==='GET')return response({job:current});
      if(action==='selection')role(grant,'operator');
      // Replay committed operations before state/deadline/revision validation, but only after current authorization.
      const replay=records.find(r=>r.operation.actor===grant.principal&&r.operation.role===grant.role&&r.operation.keyHash===keyHash);
      if(replay){if(replay.operation.fingerprint!==fingerprint)fail(409,'IDEMPOTENCY_CONFLICT','Key already used with another payload or action.');return response({job:replay.job},replay.operation.httpStatus);}
      let job;
      if(action==='create'){
        role(grant,'buyer');schema(body,['jobId','title','profile','roster','bidDeadlineNs','resultDeadlineNs']);
        if(current)fail(409,'JOB_EXISTS','Job identifier already exists.');
        if(typeof body.title!=='string'||body.title.length<1||body.title.length>100||body.title!==body.title.trim()||!/[A-Za-z0-9]/.test(body.title)||!/^[A-Za-z0-9 .,()_-]+$/.test(body.title)||body.profile!==PROFILE||!validRoster(body.roster,grant.principal)||!body.roster.every(p=>activeProviders().includes(p))||!validDeadlines(body.bidDeadlineNs,body.resultDeadlineNs)||BigInt(body.bidDeadlineNs)<=nanoseconds(now()))fail(400,'INVALID_DRAFT','Invalid draft, active roster or deadlines.');
        const time=now();job={id,title:body.title,profile:PROFILE,buyer:grant.principal,roster:[...body.roster],bidDeadlineNs:body.bidDeadlineNs,resultDeadlineNs:body.resultDeadlineNs,status:'DRAFT',revision:0,createdAt:time,updatedAt:time,ledger:'app',blockchainBinding:'pending',intent:null,contextHash:null,budgetCommitment:null,bids:body.roster.map((provider,n)=>({provider,slot:n+1,commitment:null})),closedAt:null,selection:null,deliveries:[],decision:null};
        // Reserve discoverability BEFORE canonical job commit. Orphans are harmless and filtered on reads.
        for(const principal of participants(job)){
          const indexPath=participantPrefix(principal)+id+'.json';const entry={jobId:id};
          try{if(!await store.create(indexPath,entry)){const found=await store.read(indexPath);if(canonical(found)!==canonical(entry))throw Error('Index collision');}}
          catch{const found=await store.read(indexPath);if(canonical(found)!==canonical(entry))fail(503,'STORAGE_UNKNOWN','Index outcome unknown; retry the same key and payload.');}
        }
      }else{
        if(!current)fail(404,'NOT_FOUND','Job not found.');
        if(!Number.isInteger(body?.expectedRevision)||body.expectedRevision!==current.revision)fail(409,'REVISION_CONFLICT','Expected revision does not match current job.');
        if(current.revision>=MAX_REVISIONS-1)fail(409,'REVISION_LIMIT','Job revision limit reached.');
        job=structuredClone(current);job.revision++;job.updatedAt=now();
        if(action==='publish'){
          own(grant,job);state(job,['DRAFT']);schema(body,['expectedRevision','intent','budgetCommitment']);
          try{validateIntent(body.intent);}catch{fail(400,'INVALID_INTENT','Invalid exact v2 intent.');}
          const intent=body.intent;
          if(intent.buyer!==job.buyer||canonical(intent.roster)!==canonical(job.roster)||intent.bidDeadlineNs!==job.bidDeadlineNs||intent.resultDeadlineNs!==job.resultDeadlineNs||!job.roster.every(p=>activeProviders().includes(p))||!hash32(body.budgetCommitment))fail(400,'INTENT_MISMATCH','Intent must bind the exact draft, active roster and budget commitment.');
          if(nanoseconds(now())>=BigInt(job.bidDeadlineNs))fail(409,'BID_DEADLINE','Bid deadline has passed.');
          job.intent=intent;job.contextHash=precommitContext(intent);job.budgetCommitment=body.budgetCommitment;job.status='PUBLISHED';
        }else if(action==='bids'){
          role(grant,'provider');state(job,['PUBLISHED']);schema(body,['expectedRevision','commitment']);
          if(nanoseconds(now())>=BigInt(job.bidDeadlineNs))fail(409,'BID_DEADLINE','Bid deadline has passed.');
          if(!hash32(body.commitment))fail(400,'INVALID_COMMITMENT','Nonzero hash commitment required.');
          const bid=job.bids.find(b=>b.provider===grant.principal);
          if(!bid)fail(404,'NOT_FOUND','Job not found.');
          if(bid.commitment)fail(409,'BID_IMMUTABLE','Bid commitment already submitted.');
          if(job.bids.some(b=>b.commitment===body.commitment))fail(409,'DUPLICATE_COMMITMENT','Bid commitments must be distinct.');
          bid.commitment=body.commitment;
        }else if(action==='close'){
          own(grant,job);state(job,['PUBLISHED']);schema(body,['expectedRevision']);
          if(nanoseconds(now())<BigInt(job.bidDeadlineNs))fail(409,'BID_DEADLINE','Bidding is still open.');
          if(nanoseconds(now())>=BigInt(job.resultDeadlineNs))fail(409,'RESULT_DEADLINE','Result deadline has passed.');
          job.closedAt=now();job.status='CLOSED';
        }else if(action==='selection'){
          role(grant,'operator');state(job,['CLOSED']);schema(body,['expectedRevision','evidenceHash']);
          if(!hash32(body.evidenceHash))fail(400,'INVALID_EVIDENCE','Evidence hash required.');
          if(!job.bids.every(b=>b.commitment))fail(409,'INCOMPLETE_BIDS','All three frozen bid commitments are required.');
          if(nanoseconds(now())>=BigInt(job.resultDeadlineNs))fail(409,'RESULT_DEADLINE','Result deadline has passed.');
          if(typeof selectionVerifier?.verify!=='function')fail(503,'SELECTION_UNAVAILABLE','Signed external committee validation is not configured.');
          let verified;
          try{verified=await selectionVerifier.verify({job:structuredClone(current),evidenceHash:body.evidenceHash});}catch{fail(503,'SELECTION_UNAVAILABLE','Signed external committee validation unavailable.');}
          if(!exact(verified,['provider','contextHash','evidenceHash','closedRevision','commitments'])||!job.roster.includes(verified.provider)||!job.intent.qualified[job.roster.indexOf(verified.provider)]||verified.contextHash!==job.contextHash||verified.evidenceHash!==body.evidenceHash||verified.closedRevision!==current.revision||canonical(verified.commitments)!==canonical([job.budgetCommitment,...job.bids.map(b=>b.commitment)]))fail(503,'SELECTION_UNAVAILABLE','External evidence did not validate exact frozen selection bindings.');
          if(nanoseconds(now())>=BigInt(job.resultDeadlineNs))fail(409,'RESULT_DEADLINE','Result deadline has passed.');
          job.selection={provider:verified.provider,evidenceHash:verified.evidenceHash};job.status='SELECTED';
        }else if(action==='deliveries'){
          role(grant,'provider');state(job,['SELECTED','DELIVERED','REJECTED']);schema(body,['expectedRevision','version','outputHash','receiptHash']);
          if(grant.principal!==job.selection?.provider)fail(403,'FORBIDDEN','Only selected provider may deliver.');
          if(current.revision>=MAX_REVISIONS-2)fail(409,'REVISION_LIMIT','Final revision reserved for the buyer decision.');
          if(nanoseconds(now())>=BigInt(job.resultDeadlineNs))fail(409,'RESULT_DEADLINE','Result deadline has passed.');
          if(!Number.isSafeInteger(body.version)||body.version!==job.deliveries.length+1||!hash32(body.outputHash)||!hash32(body.receiptHash))fail(400,'INVALID_DELIVERY','Next delivery version and encrypted artifact hashes required.');
          job.deliveries.push({version:body.version,outputHash:body.outputHash,receiptHash:body.receiptHash,submittedAt:now()});job.decision=null;job.status='DELIVERED';
        }else if(action==='decision'){
          own(grant,job);state(job,['DELIVERED']);schema(body,['expectedRevision','version','outputHash','receiptHash','decision']);
          const delivery=job.deliveries.at(-1);
          if(!['accept','reject'].includes(body.decision)||body.version!==delivery.version||body.outputHash!==delivery.outputHash||body.receiptHash!==delivery.receiptHash)fail(409,'DELIVERY_MISMATCH','Decision must bind the exact latest delivery version and hashes.');
          job.decision={version:body.version,outputHash:body.outputHash,receiptHash:body.receiptHash,decision:body.decision,decidedAt:now()};job.status=body.decision==='accept'?'ACCEPTED':'REJECTED';
        }else fail(405,'METHOD_NOT_ALLOWED','Method not allowed.');
      }
      if(grant.expiresAt<=now())fail(401,'INVITATION_EXPIRED','Access invitation expired.');
      const httpStatus=action==='create'?201:200;
      const record={schema:1,job,previousHash:records.length?sha256(canonical(records.at(-1))):null,operation:{actor:grant.principal,role:grant.role,keyHash,fingerprint,httpStatus}};
      const raced=await write(record);
      return response({job:raced?.job||job},httpStatus);
    }catch(error){return response({error:error instanceof HttpError?error.message:'Storage unavailable; retrieve status and retry the same key and payload.',code:error instanceof HttpError?error.code:'STORAGE_UNKNOWN'},error instanceof HttpError?error.status:503);}
  };
}
