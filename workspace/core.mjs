import {randomBytes,createHash,createPublicKey} from 'node:crypto';
import {PROFILE} from '../web/gc-core.mjs';
import {PROFILE as RECIPE_PROFILE} from '../web/recipe-core.mjs';
import {PROFILE as PLAN_PROFILE,hashPlan} from '../web/plan-core.mjs';
import {PROFILE as PROOF_PROFILE,validateProofPlanContext,canonicalProofPlanRequest} from '../web/proof-plan-core.mjs';
import {verifyJobProof,matchesCurrentProof,proofPath,proofBundleHash,proofBindingForJob} from './proof.mjs';
import {publicTask,publicTaskHash,acceptAgentProposal} from '../web/agent-plan.mjs';
import {ROOT} from './blob.mjs';
import {executeTask,validateTask,hashTask,hashTaskProgram} from './gc.mjs';
import {paymentVerifier,testnetAccount,transactionHash} from './payment.mjs';
import {WALLET_ESCROW_KIND} from './wallet-escrow.mjs';
import {walletIdentity,chainHash} from './wallet-auth.mjs';
export const sha=value=>createHash('sha256').update(value).digest('hex');
const canonical=v=>JSON.stringify(v&&typeof v==='object'?Array.isArray(v)?v.map(x=>JSON.parse(canonical(x))):Object.fromEntries(Object.keys(v).sort().map(k=>[k,JSON.parse(canonical(v[k]))])):v);
const exact=(o,keys)=>o&&typeof o==='object'&&!Array.isArray(o)&&Object.keys(o).sort().join()===keys.slice().sort().join();
const fail=(status,code)=>{throw Object.assign(Error(code),{status,code});};
const schema=(o,keys)=>{if(!exact(o,keys))fail(400,'INVALID_BODY');};
const hex=(s,n)=>typeof s==='string'&&new RegExp(`^[a-f0-9]{${n}}$`).test(s);
const path=(id,n)=>`${ROOT}jobs/${id}/${String(n).padStart(4,'0')}.json`;
const text=(s,max,empty=false)=>typeof s==='string'&&s.length<=max&&(empty||s.trim().length>0)&&!/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(s);
const amount=s=>typeof s==='string'&&/^[1-9][0-9]{0,26}$/.test(s)&&BigInt(s)>=10n**18n&&BigInt(s)<=100n*10n**24n;
export const quoteCommitment=(jobId,providerId,amountYocto,salt)=>sha(JSON.stringify([jobId,providerId,amountYocto,salt]));
export const ESCROW_KIND='SPONSORED_TESTNET_ESCROW';
const GUEST_ID=Symbol('original guest session');
const walletPayment=j=>j.payment?.kind===WALLET_ESCROW_KIND;
const escrowPayment=j=>j.payment?.kind===ESCROW_KIND||walletPayment(j);
const walletOwner=(s,j)=>s.role==='buyer'&&s.wallet?.network==='testnet'&&s.wallet.accountId===j.buyerWallet?.accountId;
const owner=(s,j)=>walletPayment(j)?walletOwner(s,j):s.id===j.buyerId||s[GUEST_ID]===j.buyerId;
const providerOwner=(s,j)=>walletPayment(j)?s.role==='provider'&&s.wallet?.network==='testnet'&&s.wallet.accountId===j.selectedOffer?.wallet?.accountId&&s.wallet.accountId===j.selectedOffer?.paymentAccount:[s.id,s[GUEST_ID]].includes(j.selectedOffer?.providerId)&&j.selectedOffer?.providerId!==undefined;
const escrowStatuses=new Set(['NOT_FUNDED','FUNDING_PENDING','HELD','RECORD_PENDING','RELEASE_READY','PAYOUT_PENDING','PAID','REFUND_PENDING','REFUNDED','ERROR','UNKNOWN']);
const response=(data,status=200,extra={})=>Response.json(data,{status,headers:{'Cache-Control':'no-store','X-Content-Type-Options':'nosniff','Referrer-Policy':'no-referrer',...extra}});
// Reject ambiguous JSON duplicate keys and bound depth as well as bytes.
export function strictJSON(source){
 const value=JSON.parse(source);let p=0;
 const ws=()=>{while(/\s/.test(source[p]||'x'))p++;};
 const str=()=>{const start=p++;while(p<source.length){if(source[p]==='\\'){p+=2;continue;}if(source[p++]==='"')return JSON.parse(source.slice(start,p));}throw Error('JSON');};
 function walk(d){if(d>16)throw Error('Depth');ws();if(source[p]==='{'){p++;ws();const seen=new Set();if(source[p]==='}'){p++;return;}for(;;){ws();const k=str();if(seen.has(k))throw Error('Duplicate');seen.add(k);ws();p++;walk(d+1);ws();if(source[p++]==='}')break;}}
 else if(source[p]==='['){p++;ws();if(source[p]===']'){p++;return;}for(;;){walk(d+1);ws();if(source[p++]===']')break;}}
 else if(source[p]==='"')str();else while(p<source.length&&!/[\s,}\]]/.test(source[p]))p++;}
 walk(0);return value;
}
async function bodyFor(req,max=1048576){
 if(!/^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(req.headers.get('content-type')||''))fail(415,'JSON_REQUIRED');
 if(req.headers.has('content-encoding')&&req.headers.get('content-encoding')!=='identity')fail(415,'INVALID_ENCODING');
 const len=req.headers.get('content-length');if(len!==null&&!/^(0|[1-9][0-9]*)$/.test(len))fail(400,'INVALID_LENGTH');if(len!==null&&Number(len)>max)fail(413,'BODY_TOO_LARGE');
 if(!req.body)fail(400,'INVALID_JSON');const reader=req.body.getReader(),chunks=[];let size=0;
 try{for(;;){const {done,value}=await reader.read();if(done)break;size+=value.byteLength;if(size>max){await reader.cancel();fail(413,'BODY_TOO_LARGE');}chunks.push(Buffer.from(value));}}finally{reader.releaseLock();}
 if(len!==null&&Number(len)!==size)fail(400,'INVALID_LENGTH');
 let body;try{body=strictJSON(new TextDecoder('utf-8',{fatal:true}).decode(Buffer.concat(chunks)));}catch{fail(size>1048576?413:400,size>1048576?'BODY_TOO_LARGE':'INVALID_JSON');}
 if(size>1048576&&![RECIPE_PROFILE,PLAN_PROFILE,PROOF_PROFILE].includes(body?.task?.profile))fail(413,'BODY_TOO_LARGE');
 return body;
}
function publicKey(key){
 if(!key||typeof key!=='object'||Array.isArray(key)||Object.keys(key).some(k=>!['kty','n','e','alg','ext','key_ops'].includes(k))||!['kty','n','e'].every(k=>Object.hasOwn(key,k))||key.kty!=='RSA'||key.e!=='AQAB'||typeof key.n!=='string'||!/^[A-Za-z0-9_-]{342}$/.test(key.n)||Buffer.from(key.n,'base64url').toString('base64url')!==key.n||key.alg!==undefined&&key.alg!=='RSA-OAEP-256'||key.ext!==undefined&&typeof key.ext!=='boolean'||key.key_ops!==undefined&&(!Array.isArray(key.key_ops)||key.key_ops.length!==1||key.key_ops[0]!=='encrypt'))fail(400,'INVALID_PUBLIC_KEY');
 try{if(createPublicKey({key,format:'jwk'}).asymmetricKeyDetails.modulusLength!==2048)throw Error();}catch{fail(400,'INVALID_PUBLIC_KEY');}
}
function envelope(e){
 schema(e,['wrappedKey','iv','ciphertext']);
 for(const [k,min,max] of [['wrappedKey',256,256],['iv',12,12],['ciphertext',17,8192]]){
  const s=e[k];if(typeof s!=='string'||s.length>4*Math.ceil(max/3)||!/^[A-Za-z0-9+/]*={0,2}$/.test(s))fail(400,'INVALID_ENVELOPE');const b=Buffer.from(s,'base64');if(b.length<min||b.length>max||b.toString('base64')!==s)fail(400,'INVALID_ENVELOPE');
 }
 if(Buffer.byteLength(JSON.stringify(e))>8192)fail(400,'INVALID_ENVELOPE');
}
/** No network fallback or in-memory production state. All mutable state uses immutable CAS slots. */
export function createWorkspace({store,env=process.env,now=Date.now,verifyPayment=paymentVerifier(),escrow=null,walletAuth=null,walletEscrow=null,walletRequired=Boolean(walletEscrow)}={}){
 if(!store||!['read','create','list'].every(k=>typeof store[k]==='function'))throw Error('Durable store required');
 if(escrow&&(!testnetAccount(escrow.contractId)||typeof escrow.operate!=='function'||escrow.kind!==ESCROW_KIND))throw Error('Invalid testnet escrow service');
 if(walletEscrow&&(!testnetAccount(walletEscrow.contractId)||walletEscrow.kind!==WALLET_ESCROW_KIND||!['prepare','confirm','refresh','context'].every(k=>typeof walletEscrow[k]==='function')))throw Error('Invalid wallet escrow service');
 if(walletRequired&&(!walletEscrow||!walletAuth))throw Error('Wallet authentication and escrow services required');
 const proofEscrow=walletRequired?walletEscrow:walletEscrow||escrow;
 const proofCapabilities=()=>({proof:{profile:PROOF_PROFILE,enabled:Boolean(proofEscrow),contractId:proofEscrow?.contractId||null},...(walletAuth?{wallet:{required:walletRequired,enabled:true,network:'testnet',contractId:walletEscrow?.contractId||null}}:{})});
 async function sessionView(raw){
  if(!walletAuth)return raw;
  const wallet=await walletAuth.get(raw);
  return Object.defineProperty({...raw,...(wallet?{id:walletIdentity(raw.role,wallet.accountId),paymentAccount:raw.role==='provider'?wallet.accountId:raw.paymentAccount}:{}),wallet},GUEST_ID,{value:raw.id});
 }
 const linked=s=>{if(!s.wallet||s.wallet.network!=='testnet'||!testnetAccount(s.wallet.accountId))fail(403,'WALLET_LINK_REQUIRED');};
 function walletFacts(job,facts){
  if(!facts||facts.kind!==WALLET_ESCROW_KIND||facts.network!=='testnet'||facts.contractId!==job.payment.contractId||facts.buyerAccount!==job.buyerWallet?.accountId||!escrowStatuses.has(facts.status)||facts.verified===true&&(facts.stateVerified!==true||!chainHash(facts.stateBlockHash)))fail(503,'WALLET_ESCROW_INTEGRITY');
  const ctx=walletEscrow.context(job);if(facts.bindingHash!==ctx.bindingHash||facts.executionDeadlineNs!==ctx.terms.execution_deadline_ns||facts.reviewDeadlineNs!==ctx.terms.review_deadline_ns)fail(503,'WALLET_ESCROW_INTEGRITY');
  if(['PAID','REFUNDED'].includes(job.payment.status)&&facts.status!==job.payment.status)fail(503,'ESCROW_FINAL_STATE_CHANGED');
  if(facts.status==='PAID'&&(!['ACCEPTED','PAID'].includes(job.status)||facts.verified!==true||facts.recordedVersion!==job.delivery?.version||facts.recordedOutputHash!==job.delivery?.outputSha256))fail(503,'WALLET_ESCROW_INTEGRITY');
  if(facts.status==='REFUNDED'&&facts.verified!==true)fail(503,'WALLET_ESCROW_INTEGRITY');
  job.payment={...facts,awardedAtISO:job.payment.awardedAtISO};if(facts.status==='PAID')job.status='PAID';if(facts.status==='REFUNDED')job.status='REFUNDED';
 }
 async function walletRefresh(job,s){if(!walletEscrow||walletEscrow.contractId!==job.payment.contractId)fail(503,'WALLET_ESCROW_UNAVAILABLE');walletFacts(job,await walletEscrow.refresh(structuredClone(job),s));}

 async function savedProof(job){
  if(!matchesCurrentProof(job))fail(409,'RESULT_PROOF_REQUIRED');
  const record=await store.read(proofPath(job.id,job.proof.bundleSha256));
  if(!record||!exact(record,['bundle'])||proofBundleHash(record.bundle)!==job.proof.bundleSha256)fail(503,'PROOF_INTEGRITY');
  return record.bundle;
 }
 async function storedTask(job){
  const record=await store.read(`${ROOT}jobs/${job.id}/task.json`);
  if(!record||await hashTask(record.task)!==job.taskHash)fail(503,'TASK_INTEGRITY');
  return record.task;
 }
 async function requireCurrentProof(job){
  const bundle=await savedProof(job),task=await storedTask(job);
  let facts;try{facts=await verifyJobProof({task,job,bundle});}catch{fail(409,'RESULT_PROOF_NOT_VERIFIED');}
  if(facts.bundleSha256!==job.proof.bundleSha256)fail(503,'PROOF_INTEGRITY');
  return facts;
 }
 async function history(id){const records=[];for(let n=0;n<256;n++){const r=await store.read(path(id,n));if(r===null)break;if(r?.job?.id!==id||r.job.revision!==n||r.previousHash!==(n?sha(canonical(records[n-1])):null))fail(503,'LEDGER_INTEGRITY');records.push(r);}return records;}
 async function commit(records,job,actorId){
  const at=new Date(now()).toISOString();job.updatedAt=at;job.events=[...(job.events||[]),{stage:job.status,status:job.status,at,actorId}];
  if(job.events.length>256)fail(409,'REVISION_LIMIT');
  if(job.revision>=256)fail(409,'REVISION_LIMIT');const record={job,previousHash:records.length?sha(canonical(records.at(-1))):null};
  if(await store.create(path(job.id,job.revision),record))return job;
  const found=await store.read(path(job.id,job.revision));if(found&&canonical(found)===canonical(record))return found.job;
  fail(409,'REVISION_CONFLICT');
 }
 async function quota(client,kind,operation){
  const prefix=`${ROOT}clients/${client}/`;
  for(let n=0;n<64;n++){
   const p=prefix+String(n).padStart(4,'0')+'.json',r=await store.read(p);
   if(r){if(r.kind===kind&&r.operation===operation)return;continue;}
   const previous=[];for(let i=0;i<n;i++)previous.push(await store.read(prefix+String(i).padStart(4,'0')+'.json'));
   if(previous.filter(x=>x?.kind===kind).length>={sessions:10,jobs:5,offers:20}[kind])fail(429,'GUEST_QUOTA');
   if(await store.create(p,{kind,operation}))return;
   const found=await store.read(p);if(found?.kind===kind&&found.operation===operation)return;
  }fail(429,'GUEST_QUOTA');
 }
 async function daySessionClaim(){
  // Daily global claim slots share the constrained client-slot namespace, no IP collection.
  const day=sha('daily-session-cap:'+new Date(now()).toISOString().slice(0,10));
  for(let n=0;n<50;n++){const p=`${ROOT}clients/${day}/${String(n).padStart(4,'0')}.json`;if(await store.read(p)===null&&await store.create(p,{claimedAt:new Date(now()).toISOString()}))return;}
  fail(429,'DAILY_SESSION_CAP');
 }
 function view(job,s,summary=false){
  const {offers,taskHash,programHash,creationHash,decisions,...out}=job;
  // Ciphertext/program commitments are public wallet-intent bounds, not CSV.
  if(walletPayment(job)){out.taskHash=taskHash;out.programHash=programHash;}
  if(!owner(s,job)&&!providerOwner(s,job))out.delivery=null;
  // Public activity preserves actual timestamps without identifying competing bidders.
  out.events=(job.events||[]).map(e=>e.actorId===job.buyerId||e.actorId===s.id?e:{...e,actorId:null});
  if(!summary){if(s.role==='buyer'&&owner(s,job)&&job.status!=='OPEN')out.offers=offers;
   if(s.role==='provider')out.ownOffer=offers.find(o=>walletPayment(job)?s.wallet?.accountId===o.wallet?.accountId:[s.id,s[GUEST_ID]].includes(o.providerId))||null;
  }return out;
 }
 const role=(s,r)=>{if(s.role!==r)fail(403,'ROLE_FORBIDDEN');};
 const buyer=(s,j)=>{role(s,'buyer');if(!owner(s,j))fail(404,'JOB_NOT_FOUND');};
 const selected=(s,j)=>{role(s,'provider');if(!providerOwner(s,j))fail(403,'SELECTED_PROVIDER_REQUIRED');};
 const state=(j,allowed)=>{if(!allowed.includes(j.status))fail(409,'INVALID_STATE');};
 return async req=>{
  try{
   const url=new URL(req.url),origin=req.headers.get('origin'),allowed=env.NOPE_WORKSPACE_ORIGIN||'https://veil-procurement.vercel.app';
   if((origin?origin!==allowed:req.method!=='GET')||url.origin!==allowed||new URL(allowed).origin!==allowed||!(/^https:\/\//.test(allowed)||/^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(allowed))||req.headers.get('sec-fetch-site')==='cross-site')fail(403,'ORIGIN_DENIED');
   if(!['GET','POST'].includes(req.method))fail(405,'METHOD_NOT_ALLOWED');
   const route=url.pathname.slice('/api/workspace'.length);
   if(!url.pathname.startsWith('/api/workspace/')||[...url.searchParams.keys()].some(k=>!['cursor'].includes(k))||url.searchParams.getAll('cursor').length>1)fail(404,'ROUTE_NOT_FOUND');
   if(req.method==='POST'&&route==='/session'){
    const b=await bodyFor(req);if(!exact(b,['role','displayName'])&&!exact(b,['role','displayName','paymentAccount']))fail(400,'INVALID_BODY');
    if(!['buyer','provider'].includes(b.role)||!text(b.displayName,40)||b.paymentAccount!==undefined&&!testnetAccount(b.paymentAccount))fail(400,'INVALID_SESSION');
    const cookie=/(?:^|;\s*)workspace_client=([A-Za-z0-9_-]{43})(?:;|$)/.exec(req.headers.get('cookie')||'')?.[1];
    const clientToken=cookie||randomBytes(32).toString('base64url'),client=sha(clientToken),token=randomBytes(32).toString('base64url');
    await quota(client,'sessions',sha(token));await daySessionClaim();
    const session={id:randomBytes(16).toString('hex'),role:b.role,displayName:b.displayName,paymentAccount:b.paymentAccount||null};
    if(!await store.create(`${ROOT}sessions/${sha(token)}.json`,{session,client}))fail(503,'SESSION_UNAVAILABLE');
    return response({token,session:await sessionView(session),...proofCapabilities()},201,{'Set-Cookie':`workspace_client=${clientToken}; Path=/api/workspace; HttpOnly; SameSite=Strict; Max-Age=2592000${allowed.startsWith('https:')?'; Secure':''}`});
   }
   // Deliberately public evidence contains only ciphertexts, commitments and an
   // already verified proof. Never return sessions, quotes, names or local keys.
   const evidenceMatch=/^\/jobs\/([a-f0-9]{32})\/proof\/evidence$/.exec(route);
   if(req.method==='GET'&&evidenceMatch){
    const job=(await history(evidenceMatch[1])).at(-1)?.job;
    if(!job||job.profile!==PROOF_PROFILE||!matchesCurrentProof(job))fail(404,'PROOF_NOT_FOUND');
    const bundle=await savedProof(job),record=await store.read(`${ROOT}jobs/${job.id}/task.json`);
    if(!record||sha(canonicalProofPlanRequest(record.task))!==job.taskHash)fail(503,'TASK_INTEGRITY');
    return response({version:1,network:'testnet',jobId:job.id,task:record.task,delivery:job.delivery,binding:proofBindingForJob(job),proof:job.proof,bundle,...(walletPayment(job)?{walletBuyerAccount:job.buyerWallet.accountId}:{})});
   }
   const auth=req.headers.get('authorization')||'';if(!/^Bearer [A-Za-z0-9_-]{43}$/.test(auth))fail(401,'SESSION_REQUIRED');
   const record=await store.read(`${ROOT}sessions/${sha(auth.slice(7))}.json`);if(!record)fail(401,'SESSION_REQUIRED');const s=await sessionView(record.session);
   if(route==='/session'&&req.method==='GET')return response({session:s,...proofCapabilities()});
   if(route==='/wallet'&&req.method==='GET')return response({wallet:s.wallet||null});
   if(req.method==='POST'&&['/wallet/challenge','/wallet/verify'].includes(route)){
    if(!walletAuth)fail(503,'WALLET_AUTH_UNAVAILABLE');const input=await bodyFor(req);
    if(route==='/wallet/challenge'){schema(input,['accountId']);return response({challenge:await walletAuth.challenge({session:record.session,origin:allowed,...input})});}
    schema(input,['challengeId','accountId','publicKey','signature']);const wallet=await walletAuth.verify({session:record.session,origin:allowed,...input});return response({wallet,session:await sessionView(record.session)});
   }
   if(route==='/jobs'&&req.method==='GET'){
    const cursor=url.searchParams.get('cursor')||undefined;if(cursor&&cursor.length>2048)fail(400,'INVALID_CURSOR');
    const page=await store.list({prefix:ROOT+'index/',limit:20,cursor}),jobs=[];
    for(const p of page.pathnames){const id=p.slice((ROOT+'index/').length,-5);const j=(await history(id)).at(-1)?.job;if(j&&(s.role==='provider'||owner(s,j)))jobs.push(view(j,s,true));}
    return response({jobs,nextCursor:page.cursor});
   }
   const b=req.method==='POST'?await bodyFor(req,route==='/jobs'?3*1024*1024:1048576):null;
   if(route==='/jobs'&&req.method==='POST'){
    role(s,'buyer');if(walletEscrow)linked(s);if(walletRequired){linked(s);if(b?.profile!==PROOF_PROFILE)fail(400,'WALLET_PROOF_PROFILE_REQUIRED');}const planned=[PLAN_PROFILE,PROOF_PROFILE].includes(b?.profile);
    schema(b,['jobId','title','description','deadlineISO','profile','rowCount','task','buyerPublicKey',...(planned?['publicTask']:[])]);
    if(!hex(b.jobId,32)||!text(b.title,100)||!text(b.description,1000,true)||![PROFILE,RECIPE_PROFILE,PLAN_PROFILE,PROOF_PROFILE].includes(b.profile)||!Number.isInteger(b.rowCount)||b.rowCount<1||b.rowCount>32||typeof b.deadlineISO!=='string'||!/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{3})?Z$/.test(b.deadlineISO)||!Number.isFinite(Date.parse(b.deadlineISO)))fail(400,'INVALID_JOB');
    const prepared=b.profile===PROOF_PROFILE?b.task?.task:b.task;
    try{
     validateTask(b.task);
     if(b.task.profile===RECIPE_PROFILE&&b.task.programSha256!==await hashTaskProgram(b.task))throw Error('Program mismatch');
     if(planned){const task=publicTask(b.publicTask);if(await publicTaskHash(task)!==prepared.plan.taskHash||prepared.planSha256!==await hashPlan(prepared.plan))throw Error('Plan mismatch');await acceptAgentProposal(task,prepared.plan);for(const item of prepared.tasks)if(item.request.programSha256!==await hashTaskProgram(item.request))throw Error('Program mismatch');}
     if(b.profile===PROOF_PROFILE){
      if(!proofEscrow||b.task.proofManifest.context.buyerCommitment!==sha('NOPE:buyer:'+s.id)||b.task.proofManifest.context.contractId!==proofEscrow.contractId)throw Error('Proof context required');
      validateProofPlanContext(b.task,{jobId:b.jobId,buyerCommitment:sha('NOPE:buyer:'+s.id),contractId:proofEscrow.contractId});
     }
    }catch{fail(400,'INVALID_TASK');}
    if(prepared?.rowCount!==b.rowCount||b.task.profile!==b.profile)fail(400,'TASK_MISMATCH');publicKey(b.buyerPublicKey);
    const creationHash=sha(canonical(b)),records=await history(b.jobId),existing=records.at(-1)?.job;
    if(existing){if(!owner(s,existing)||existing.creationHash!==creationHash)fail(409,'JOB_EXISTS');return response({job:view(existing,s)});}
    if(Date.parse(b.deadlineISO)<=now()||Date.parse(b.deadlineISO)>now()+30*86400000)fail(400,'INVALID_DEADLINE');
    await quota(record.client,'jobs',b.jobId);
    const taskPath=`${ROOT}jobs/${b.jobId}/task.json`,taskRecord={buyerId:s.id,creationHash,task:b.task};
    if(!await store.create(taskPath,taskRecord)&&canonical(await store.read(taskPath))!==canonical(taskRecord))fail(409,'JOB_EXISTS');
    await store.create(`${ROOT}index/${b.jobId}.json`,{id:b.jobId});
    const job={id:b.jobId,buyerId:s.id,buyerName:s.displayName,title:b.title,description:b.description,deadlineISO:b.deadlineISO,status:'OPEN',profile:b.profile,...(b.profile===RECIPE_PROFILE?{recipe:structuredClone(b.task.recipe)}:planned?{plan:structuredClone(prepared.plan),planSha256:prepared.planSha256,publicTask:publicTask(b.publicTask)}:{}),...(b.profile===PROOF_PROFILE?{proof:{status:'NOT_CREATED'}}:{}),rowCount:b.rowCount,createdAt:new Date(now()).toISOString(),buyerPublicKey:b.buyerPublicKey,offerCount:0,selectedOffer:null,delivery:null,...(walletEscrow?{buyerWallet:structuredClone(s.wallet)}:{}),payment:walletEscrow?{kind:WALLET_ESCROW_KIND,network:'testnet',contractId:walletEscrow.contractId,buyerAccount:s.wallet.accountId,status:'NOT_FUNDED'}:escrow?{kind:ESCROW_KIND,network:'testnet',contractId:escrow.contractId,status:'NOT_FUNDED'}:{status:'NOT_DUE'},revision:0,events:[],offers:[],decisions:[],creationHash,taskHash:await hashTask(b.task),programHash:await hashTaskProgram(b.task)};
    try{return response({job:view(await commit([],job,s.id),s)},201);}catch(e){if(e.code!=='REVISION_CONFLICT')throw e;const current=(await history(b.jobId)).at(-1)?.job;if(current?.buyerId===s.id&&current.creationHash===creationHash)return response({job:view(current,s)});throw e;}
   }
   const match=/^\/jobs\/([a-f0-9]{32})(?:\/(offers|close|award|task|execute|decision|proof|payment\/(?:verify|fund|record|release|refund|refresh|prepare|confirm)))?$/.exec(route);if(!match)fail(404,'ROUTE_NOT_FOUND');
   const records=await history(match[1]),current=records.at(-1)?.job;if(!current||s.role==='buyer'&&!owner(s,current))fail(404,'JOB_NOT_FOUND');const action=match[2];
   if(req.method==='GET'){
    if(!action)return response({job:view(current,s)});
    if(action==='task'){if(!owner(s,current))selected(s,current);const t=await store.read(`${ROOT}jobs/${current.id}/task.json`);if(!t||await hashTask(t.task)!==current.taskHash)fail(503,'TASK_INTEGRITY');return response({task:t.task});}
    fail(405,'METHOD_NOT_ALLOWED');
   }
   if(!action||action==='task')fail(405,'METHOD_NOT_ALLOWED');
   if(walletRequired&&!walletPayment(current))fail(409,'LEGACY_JOB_READ_ONLY');
   if(walletPayment(current))linked(s);
   const j=structuredClone(current);j.revision++;
   if(action==='offers'){
    role(s,'provider');if(walletPayment(j)){linked(s);if(s.paymentAccount!==s.wallet.accountId)fail(403,'WALLET_ACCOUNT_MISMATCH');}schema(b,['envelope','commitment']);envelope(b.envelope);if(!hex(b.commitment,64))fail(400,'INVALID_COMMITMENT');if(!testnetAccount(s.paymentAccount))fail(400,'PAYMENT_ACCOUNT_REQUIRED');state(j,['OPEN']);if(now()>=Date.parse(j.deadlineISO))fail(409,'OFFER_DEADLINE');
    if(j.offers.some(o=>walletPayment(j)?o.wallet?.accountId===s.wallet.accountId:o.providerId===s.id))fail(409,'OFFER_EXISTS');if(j.offers.length>=64)fail(409,'OFFER_LIMIT');
    await quota(record.client,'offers',j.id+':'+s.id);
    j.offers.push({id:randomBytes(16).toString('hex'),providerId:s.id,providerName:s.displayName,paymentAccount:s.paymentAccount,...(walletPayment(j)?{wallet:structuredClone(s.wallet)}:{}),envelope:b.envelope,commitment:b.commitment,createdAt:new Date(now()).toISOString()});j.offerCount=j.offers.length;
   }else if(action==='close'){
    buyer(s,j);schema(b,[]);if(j.status!=='OPEN')return response({job:view(current,s)});j.status='CLOSED';
   }else if(action==='award'){
    buyer(s,j);schema(b,['offerId','amountYocto','salt']);state(j,['CLOSED']);if(!hex(b.offerId,32)||!(walletPayment(j)?typeof b.amountYocto==='string'&&/^[1-9][0-9]{0,24}$/.test(b.amountYocto)&&BigInt(b.amountYocto)<=10n**24n:amount(b.amountYocto))||!hex(b.salt,64))fail(400,'INVALID_AWARD');
    if(j.payment.kind===ESCROW_KIND&&BigInt(b.amountYocto)>10n**22n)fail(400,'ESCROW_AMOUNT_LIMIT');
    const o=j.offers.find(o=>o.id===b.offerId);if(!o||quoteCommitment(j.id,o.providerId,b.amountYocto,b.salt)!==o.commitment)fail(400,'COMMITMENT_MISMATCH');
    j.selectedOffer={offerId:o.id,providerId:o.providerId,paymentAccount:o.paymentAccount,amountYocto:b.amountYocto,...(walletPayment(j)?{wallet:structuredClone(o.wallet)}:{})};j.status='AWARDED';
    if(escrowPayment(j))j.payment={...j.payment,awardedAtISO:new Date(now()).toISOString()};
    if(walletPayment(j)){const ctx=walletEscrow.context(j);j.payment={...j.payment,bindingHash:ctx.bindingHash,executionDeadlineNs:ctx.terms.execution_deadline_ns,reviewDeadlineNs:ctx.terms.review_deadline_ns};}
   }else if(action==='execute'){
    selected(s,j);schema(b,[]);if(['DELIVERED','ACCEPTED','PAID'].includes(j.status)&&j.delivery)return response({job:view(current,s)});state(j,['AWARDED','REVISION']);
    if(walletPayment(j))await walletRefresh(j,s);
    if(escrowPayment(j)&&(j.payment.status!=='HELD'||walletPayment(j)&&(j.payment.verified!==true||BigInt(now())*1000000n>=BigInt(j.payment.executionDeadlineNs))))fail(409,'ESCROW_FUNDING_REQUIRED');
    const t=await store.read(`${ROOT}jobs/${j.id}/task.json`);if(!t||await hashTask(t.task)!==j.taskHash)fail(503,'TASK_INTEGRITY');
    let result;try{result=await executeTask(t.task);}catch{fail(422,'EXECUTION_FAILED');}
    const expectedNonce=t.task.profile===PROOF_PROFILE?t.task.task.nonce:t.task.nonce;
    if(result.profile!==j.profile||result.nonce!==expectedNonce||result.rowCount!==j.rowCount||result.inputSha256!==j.taskHash||result.programSha256!==j.programHash)fail(503,'EXECUTION_INTEGRITY');
    j.delivery={...([RECIPE_PROFILE,PLAN_PROFILE,PROOF_PROFILE].includes(j.profile)?{profile:result.profile,nonce:result.nonce,rowCount:result.rowCount}:{}),outputs:result.outputs,inputSha256:result.inputSha256,outputSha256:result.outputSha256,programSha256:result.programSha256,version:(j.delivery?.version||0)+1,deliveredAt:new Date(now()).toISOString()};j.status='DELIVERED';
    if(j.profile===PROOF_PROFILE)j.proof={status:'NOT_CREATED'};
   }else if(action==='proof'){
    buyer(s,j);schema(b,['version','outputSha256','bundle']);state(j,['DELIVERED']);
    if(j.profile!==PROOF_PROFILE||b.version!==j.delivery.version||b.outputSha256!==j.delivery.outputSha256)fail(409,'DELIVERY_MISMATCH');
    const task=await storedTask(j);let facts;
    try{facts=await verifyJobProof({task,job:j,bundle:b.bundle});}catch{fail(422,'RESULT_PROOF_NOT_VERIFIED');}
    if(matchesCurrentProof(current)&&current.proof.bundleSha256===facts.bundleSha256)return response({job:view(current,s)});
    const p=proofPath(j.id,facts.bundleSha256),record={bundle:b.bundle};
    if(!await store.create(p,record)&&canonical(await store.read(p))!==canonical(record))fail(503,'PROOF_INTEGRITY');
    j.proof={...facts,verifiedAt:new Date(now()).toISOString()};
   }else if(action==='decision'){
    buyer(s,j);schema(b,['decision','version','outputSha256']);state(j,['DELIVERED']);
    if(!['accept','revise'].includes(b.decision)||!Number.isInteger(b.version)||b.version!==j.delivery.version||b.outputSha256!==j.delivery.outputSha256)fail(409,'DELIVERY_MISMATCH');
    if(walletPayment(j)){await walletRefresh(j,s);if(BigInt(now())*1000000n>=BigInt(j.payment.reviewDeadlineNs))fail(409,'WALLET_REVIEW_DEADLINE');}
    if(escrowPayment(j)&&(j.payment.status!=='HELD'||j.payment.verified!==true||j.payment.recordedVersion!==j.delivery.version||j.payment.recordedOutputHash!==j.delivery.outputSha256))fail(409,'ESCROW_DELIVERY_RECORD_REQUIRED');
    if(b.decision==='accept'&&j.profile===PROOF_PROFILE)await requireCurrentProof(j);
    if(j.decisions.length>=20)fail(409,'REVISION_LIMIT');j.decisions.push({...b,...(b.decision==='accept'&&j.profile===PROOF_PROFILE?{proofSha256:j.proof.bundleSha256}:{}),at:new Date(now()).toISOString()});j.status=b.decision==='accept'?'ACCEPTED':'REVISION';if(b.decision==='accept')j.payment=escrowPayment(j)?{...j.payment,status:'RELEASE_READY'}:{status:'DUE',network:'testnet',kind:'DIRECT_TESTNET_TRANSFER'};
   }else if(action==='payment/prepare'||action==='payment/confirm'||action==='payment/refresh'&&walletPayment(j)){
    if(!walletPayment(j)||!walletEscrow)fail(409,'WALLET_ESCROW_JOB_REQUIRED');
    const operation=action==='payment/refresh'?'refresh':b?.action;
    schema(b,action==='payment/refresh'?[]:action==='payment/prepare'?['action']:['action','transactionHash']);
    if(!['fund','record','release','refund','refresh'].includes(operation))fail(400,'WALLET_INVALID_ACTION');
    if(operation==='record'||operation==='refresh'){if(!owner(s,j))selected(s,j);}else buyer(s,j);
    if(operation==='release'&&j.profile===PROOF_PROFILE){if(j.status!=='ACCEPTED'||j.decisions.at(-1)?.proofSha256!==j.proof?.bundleSha256)fail(409,'RESULT_PROOF_REQUIRED');await requireCurrentProof(j);}
    let intent;
    if(action==='payment/prepare'){const result=await walletEscrow.prepare(structuredClone(j),operation,s);walletFacts(j,result.payment);intent=result.intent;}
    else if(action==='payment/confirm')walletFacts(j,await walletEscrow.confirm(structuredClone(j),operation,b.transactionHash,s));
    else if(j.selectedOffer)await walletRefresh(j,s);
    if(canonical(j.payment)===canonical(current.payment)&&j.status===current.status)return response({job:view(current,s),...(action==='payment/prepare'?{intent}:{})});
    return response({job:view(await commit(records,j,s.id),s),...(action==='payment/prepare'?{intent}:{})});
   }else if(action==='payment/verify'){
    if(escrowPayment(j))fail(409,'ESCROW_DIRECT_TRANSFER_FORBIDDEN');
    buyer(s,j);schema(b,['transactionHash','buyerAccount']);if(!transactionHash(b.transactionHash)||!testnetAccount(b.buyerAccount))fail(400,'INVALID_PAYMENT');
    if(j.payment.status==='PAID'){if(j.payment.transactionHash===b.transactionHash&&j.payment.buyerAccount===b.buyerAccount)return response({job:view(current,s)});fail(409,'ALREADY_PAID');}state(j,['ACCEPTED']);
    let facts;try{facts=await verifyPayment({...b,job:j});}catch{fail(409,'PAYMENT_NOT_VERIFIED');}
    if(facts?.status!=='PAID'||facts.network!=='testnet'||facts.transactionHash!==b.transactionHash||facts.buyerAccount!==b.buyerAccount||facts.receiverId!==j.selectedOffer.paymentAccount||facts.amountYocto!==j.selectedOffer.amountYocto)fail(409,'PAYMENT_NOT_VERIFIED');
    const claimPath=`${ROOT}transactions/${sha(b.transactionHash)}.json`,claim={jobId:j.id,buyerId:s.id,buyerAccount:b.buyerAccount};
    if(!await store.create(claimPath,claim)&&canonical(await store.read(claimPath))!==canonical(claim))fail(409,'TRANSACTION_ALREADY_USED');
    j.payment={...facts,verifiedAt:new Date(now()).toISOString()};j.status='PAID';
   }else if(action.startsWith('payment/')){
    schema(b,[]);if(walletPayment(j))fail(409,'WALLET_SIGNED_TRANSACTION_REQUIRED');if(!escrowPayment(j))fail(409,'ESCROW_JOB_REQUIRED');
    const operation=action.slice('payment/'.length);
    if(operation==='record'||operation==='refresh'){if(s.id!==j.buyerId)selected(s,j);}
    else buyer(s,j);
    if(operation==='refresh'&&!j.selectedOffer)return response({job:view(current,s)});
    if(operation==='fund')state(j,['AWARDED']);
    if(operation==='record')state(j,['DELIVERED']);
    if(operation==='release'){if(j.status==='PAID')return response({job:view(current,s)});state(j,['ACCEPTED']);}
    if(operation==='refund')state(j,['AWARDED','REVISION','DELIVERED','ACCEPTED']);
    if(!escrow||escrow.contractId!==j.payment.contractId)fail(503,'ESCROW_UNAVAILABLE');
    if(operation==='release'&&j.profile===PROOF_PROFILE){
     if(j.decisions.at(-1)?.proofSha256!==j.proof?.bundleSha256)fail(409,'RESULT_PROOF_REQUIRED');
     await requireCurrentProof(j);
    }
    let facts;try{facts=await escrow.operate(structuredClone(j),operation);}catch{fail(503,'ESCROW_UNAVAILABLE');}
    if(!facts||facts.kind!==ESCROW_KIND||facts.network!=='testnet'||facts.contractId!==j.payment.contractId||!escrowStatuses.has(facts.status))fail(503,'ESCROW_INTEGRITY');
    if(['PAID','REFUNDED'].includes(j.payment.status)&&facts.status!==j.payment.status)fail(503,'ESCROW_FINAL_STATE_CHANGED');
    if(facts.status==='PAID'&&(j.status!=='ACCEPTED'&&j.status!=='PAID'||facts.verified!==true||!transactionHash(facts.releaseTransactionHash)))fail(503,'ESCROW_INTEGRITY');
    if(facts.status==='REFUNDED'&&(facts.verified!==true||!transactionHash(facts.refundTransactionHash)))fail(503,'ESCROW_INTEGRITY');
    const payment={...facts,awardedAtISO:j.payment.awardedAtISO};
    if(canonical(payment)===canonical(j.payment))return response({job:view(current,s)});
    j.payment=payment;
    if(facts.status==='PAID')j.status='PAID';
    if(facts.status==='REFUNDED')j.status='REFUNDED';
   }
   return response({job:view(await commit(records,j,s.id),s)});
  }catch(e){const status=[400,401,403,404,405,409,413,415,422,429,503].includes(e.status)?e.status:503;return response({error:status===503?'Service temporarily unavailable.':'Request rejected.',code:e.code||'SERVICE_UNAVAILABLE'},status);}
 };
}
