import {randomBytes,createHash,createPublicKey} from 'node:crypto';
import {PROFILE} from '../web/gc-core.mjs';
import {PROFILE as RECIPE_PROFILE} from '../web/recipe-core.mjs';
import {ROOT} from './blob.mjs';
import {executeTask,validateTask,hashTask,hashTaskProgram} from './gc.mjs';
import {paymentVerifier,testnetAccount,transactionHash} from './payment.mjs';
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
 if(size>1048576&&body?.task?.profile!==RECIPE_PROFILE)fail(413,'BODY_TOO_LARGE');
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
export function createWorkspace({store,env=process.env,now=Date.now,verifyPayment=paymentVerifier()}={}){
 if(!store||!['read','create','list'].every(k=>typeof store[k]==='function'))throw Error('Durable store required');
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
  if(s.id!==job.buyerId&&s.id!==job.selectedOffer?.providerId)out.delivery=null;
  // Public activity preserves actual timestamps without identifying competing bidders.
  out.events=(job.events||[]).map(e=>e.actorId===job.buyerId||e.actorId===s.id?e:{...e,actorId:null});
  if(!summary){if(s.role==='buyer'&&s.id===job.buyerId&&job.status!=='OPEN')out.offers=offers;
   if(s.role==='provider')out.ownOffer=offers.find(o=>o.providerId===s.id)||null;
  }return out;
 }
 const role=(s,r)=>{if(s.role!==r)fail(403,'ROLE_FORBIDDEN');};
 const buyer=(s,j)=>{role(s,'buyer');if(s.id!==j.buyerId)fail(404,'JOB_NOT_FOUND');};
 const selected=(s,j)=>{role(s,'provider');if(j.selectedOffer?.providerId!==s.id)fail(403,'SELECTED_PROVIDER_REQUIRED');};
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
    return response({token,session},201,{'Set-Cookie':`workspace_client=${clientToken}; Path=/api/workspace; HttpOnly; SameSite=Strict; Max-Age=2592000${allowed.startsWith('https:')?'; Secure':''}`});
   }
   const auth=req.headers.get('authorization')||'';if(!/^Bearer [A-Za-z0-9_-]{43}$/.test(auth))fail(401,'SESSION_REQUIRED');
   const record=await store.read(`${ROOT}sessions/${sha(auth.slice(7))}.json`);if(!record)fail(401,'SESSION_REQUIRED');const s=record.session;
   if(route==='/session'&&req.method==='GET')return response({session:s});
   if(route==='/jobs'&&req.method==='GET'){
    const cursor=url.searchParams.get('cursor')||undefined;if(cursor&&cursor.length>2048)fail(400,'INVALID_CURSOR');
    const page=await store.list({prefix:ROOT+'index/',limit:20,cursor}),jobs=[];
    for(const p of page.pathnames){const id=p.slice((ROOT+'index/').length,-5);const j=(await history(id)).at(-1)?.job;if(j&&(s.role==='provider'||j.buyerId===s.id))jobs.push(view(j,s,true));}
    return response({jobs,nextCursor:page.cursor});
   }
   const b=req.method==='POST'?await bodyFor(req,route==='/jobs'?3*1024*1024:1048576):null;
   if(route==='/jobs'&&req.method==='POST'){
    role(s,'buyer');schema(b,['jobId','title','description','deadlineISO','profile','rowCount','task','buyerPublicKey']);
    if(!hex(b.jobId,32)||!text(b.title,100)||!text(b.description,1000,true)||![PROFILE,RECIPE_PROFILE].includes(b.profile)||!Number.isInteger(b.rowCount)||b.rowCount<1||b.rowCount>32||typeof b.deadlineISO!=='string'||!/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{3})?Z$/.test(b.deadlineISO)||!Number.isFinite(Date.parse(b.deadlineISO)))fail(400,'INVALID_JOB');
    try{validateTask(b.task);if(b.task.profile===RECIPE_PROFILE&&b.task.programSha256!==await hashTaskProgram(b.task))throw Error('Program mismatch');}catch{fail(400,'INVALID_TASK');}if(b.task.rowCount!==b.rowCount||b.task.profile!==b.profile)fail(400,'TASK_MISMATCH');publicKey(b.buyerPublicKey);
    const creationHash=sha(canonical(b)),records=await history(b.jobId),existing=records.at(-1)?.job;
    if(existing){if(existing.buyerId!==s.id||existing.creationHash!==creationHash)fail(409,'JOB_EXISTS');return response({job:view(existing,s)});}
    if(Date.parse(b.deadlineISO)<=now()||Date.parse(b.deadlineISO)>now()+30*86400000)fail(400,'INVALID_DEADLINE');
    await quota(record.client,'jobs',b.jobId);
    const taskPath=`${ROOT}jobs/${b.jobId}/task.json`,taskRecord={buyerId:s.id,creationHash,task:b.task};
    if(!await store.create(taskPath,taskRecord)&&canonical(await store.read(taskPath))!==canonical(taskRecord))fail(409,'JOB_EXISTS');
    await store.create(`${ROOT}index/${b.jobId}.json`,{id:b.jobId});
    const job={id:b.jobId,buyerId:s.id,buyerName:s.displayName,title:b.title,description:b.description,deadlineISO:b.deadlineISO,status:'OPEN',profile:b.profile,...(b.profile===RECIPE_PROFILE?{recipe:structuredClone(b.task.recipe)}:{}),rowCount:b.rowCount,createdAt:new Date(now()).toISOString(),buyerPublicKey:b.buyerPublicKey,offerCount:0,selectedOffer:null,delivery:null,payment:{status:'NOT_DUE'},revision:0,events:[],offers:[],decisions:[],creationHash,taskHash:await hashTask(b.task),programHash:await hashTaskProgram(b.task)};
    try{return response({job:view(await commit([],job,s.id),s)},201);}catch(e){if(e.code!=='REVISION_CONFLICT')throw e;const current=(await history(b.jobId)).at(-1)?.job;if(current?.buyerId===s.id&&current.creationHash===creationHash)return response({job:view(current,s)});throw e;}
   }
   const match=/^\/jobs\/([a-f0-9]{32})(?:\/(offers|close|award|task|execute|decision|payment\/verify))?$/.exec(route);if(!match)fail(404,'ROUTE_NOT_FOUND');
   const records=await history(match[1]),current=records.at(-1)?.job;if(!current||s.role==='buyer'&&s.id!==current.buyerId)fail(404,'JOB_NOT_FOUND');const action=match[2];
   if(req.method==='GET'){
    if(!action)return response({job:view(current,s)});
    if(action==='task'){if(s.id!==current.buyerId)selected(s,current);const t=await store.read(`${ROOT}jobs/${current.id}/task.json`);if(!t||await hashTask(t.task)!==current.taskHash)fail(503,'TASK_INTEGRITY');return response({task:t.task});}
    fail(405,'METHOD_NOT_ALLOWED');
   }
   if(!action||action==='task')fail(405,'METHOD_NOT_ALLOWED');
   const j=structuredClone(current);j.revision++;
   if(action==='offers'){
    role(s,'provider');schema(b,['envelope','commitment']);envelope(b.envelope);if(!hex(b.commitment,64))fail(400,'INVALID_COMMITMENT');if(!testnetAccount(s.paymentAccount))fail(400,'PAYMENT_ACCOUNT_REQUIRED');state(j,['OPEN']);if(now()>=Date.parse(j.deadlineISO))fail(409,'OFFER_DEADLINE');
    if(j.offers.some(o=>o.providerId===s.id))fail(409,'OFFER_EXISTS');if(j.offers.length>=64)fail(409,'OFFER_LIMIT');
    await quota(record.client,'offers',j.id+':'+s.id);
    j.offers.push({id:randomBytes(16).toString('hex'),providerId:s.id,providerName:s.displayName,paymentAccount:s.paymentAccount,envelope:b.envelope,commitment:b.commitment,createdAt:new Date(now()).toISOString()});j.offerCount=j.offers.length;
   }else if(action==='close'){
    buyer(s,j);schema(b,[]);if(j.status!=='OPEN')return response({job:view(current,s)});j.status='CLOSED';
   }else if(action==='award'){
    buyer(s,j);schema(b,['offerId','amountYocto','salt']);state(j,['CLOSED']);if(!hex(b.offerId,32)||!amount(b.amountYocto)||!hex(b.salt,64))fail(400,'INVALID_AWARD');
    const o=j.offers.find(o=>o.id===b.offerId);if(!o||quoteCommitment(j.id,o.providerId,b.amountYocto,b.salt)!==o.commitment)fail(400,'COMMITMENT_MISMATCH');
    j.selectedOffer={offerId:o.id,providerId:o.providerId,paymentAccount:o.paymentAccount,amountYocto:b.amountYocto};j.status='AWARDED';
   }else if(action==='execute'){
    selected(s,j);schema(b,[]);if(['DELIVERED','ACCEPTED','PAID'].includes(j.status)&&j.delivery)return response({job:view(current,s)});state(j,['AWARDED','REVISION']);
    const t=await store.read(`${ROOT}jobs/${j.id}/task.json`);if(!t||await hashTask(t.task)!==j.taskHash)fail(503,'TASK_INTEGRITY');
    let result;try{result=await executeTask(t.task);}catch{fail(422,'EXECUTION_FAILED');}
    if(result.profile!==j.profile||result.nonce!==t.task.nonce||result.rowCount!==j.rowCount||result.inputSha256!==j.taskHash||result.programSha256!==j.programHash)fail(503,'EXECUTION_INTEGRITY');
    j.delivery={...(j.profile===RECIPE_PROFILE?{profile:result.profile,nonce:result.nonce,rowCount:result.rowCount}:{}),outputs:result.outputs,inputSha256:result.inputSha256,outputSha256:result.outputSha256,programSha256:result.programSha256,version:(j.delivery?.version||0)+1,deliveredAt:new Date(now()).toISOString()};j.status='DELIVERED';
   }else if(action==='decision'){
    buyer(s,j);schema(b,['decision','version','outputSha256']);state(j,['DELIVERED']);
    if(!['accept','revise'].includes(b.decision)||!Number.isInteger(b.version)||b.version!==j.delivery.version||b.outputSha256!==j.delivery.outputSha256)fail(409,'DELIVERY_MISMATCH');
    if(j.decisions.length>=20)fail(409,'REVISION_LIMIT');j.decisions.push({...b,at:new Date(now()).toISOString()});j.status=b.decision==='accept'?'ACCEPTED':'REVISION';if(b.decision==='accept')j.payment={status:'DUE',network:'testnet',kind:'DIRECT_TESTNET_TRANSFER'};
   }else if(action==='payment/verify'){
    buyer(s,j);schema(b,['transactionHash','buyerAccount']);if(!transactionHash(b.transactionHash)||!testnetAccount(b.buyerAccount))fail(400,'INVALID_PAYMENT');
    if(j.payment.status==='PAID'){if(j.payment.transactionHash===b.transactionHash&&j.payment.buyerAccount===b.buyerAccount)return response({job:view(current,s)});fail(409,'ALREADY_PAID');}state(j,['ACCEPTED']);
    let facts;try{facts=await verifyPayment({...b,job:j});}catch{fail(409,'PAYMENT_NOT_VERIFIED');}
    if(facts?.status!=='PAID'||facts.network!=='testnet'||facts.transactionHash!==b.transactionHash||facts.buyerAccount!==b.buyerAccount||facts.receiverId!==j.selectedOffer.paymentAccount||facts.amountYocto!==j.selectedOffer.amountYocto)fail(409,'PAYMENT_NOT_VERIFIED');
    const claimPath=`${ROOT}transactions/${sha(b.transactionHash)}.json`,claim={jobId:j.id,buyerId:s.id,buyerAccount:b.buyerAccount};
    if(!await store.create(claimPath,claim)&&canonical(await store.read(claimPath))!==canonical(claim))fail(409,'TRANSACTION_ALREADY_USED');
    j.payment={...facts,verifiedAt:new Date(now()).toISOString()};j.status='PAID';
   }
   return response({job:view(await commit(records,j,s.id),s)});
  }catch(e){const status=[400,401,403,404,405,409,413,415,422,429,503].includes(e.status)?e.status:503;return response({error:status===503?'Service temporarily unavailable.':'Request rejected.',code:e.code||'SERVICE_UNAVAILABLE'},status);}
 };
}
