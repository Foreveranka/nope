/** Explicit actual TESTNET QA. Synthetic inputs only, never customer inputs.
 * run [--origin=http://127.0.0.1:8789] [--keys=<ignored identities.json>]
 * run --origin=https://veil-procurement.vercel.app --production-testnet=yes
 * The API runs in a separate process and never reads wallet keys. Recovery
 * material stays under ignored runtime/ with mode0600. NO automatic re-sign or
 * re-broadcast. A previously attempted transaction is only observed by its hash.
 */
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {fork,execFileSync} from 'node:child_process';
import {createServer} from 'node:http';
import assert from 'node:assert/strict';
import {randomBytes,generateKeyPairSync,privateDecrypt,constants,createDecipheriv,createHash} from 'node:crypto';
import {KeyPair,KeyPairSigner,PublicKey,actions,createTransaction,baseDecode,baseEncode} from 'near-api-js';
import {signMessage} from 'near-api-js/nep413';
import {createWorkspaceHandler} from '../api/workspace.mjs';
import {blobWorkspaceStore} from '../workspace/blob.mjs';
import {WALLET_ESCROW_POLICY as POLICY} from '../workspace/wallet-config.mjs';
import {createWalletRPC,walletIdentity,canonical} from '../workspace/wallet-auth.mjs';
import {quoteCommitment} from '../workspace/core.mjs';
import {acceptAgentProposal,privatePlanInputs,applyAgentOutput} from '../web/agent-plan.mjs';
import {prepareProofPlan,decodeProofPlan,proveProofPlan} from '../web/proof-plan-client.mjs';
import {verifyProofPlanBundle,proofRuntime} from '../web/proof-plan-core.mjs';
import {validatePublicEvidence,verifyPublicChainBinding} from '../web/public-proof.mjs';
import {parseCSV} from '../web/csv-input.mjs';
import {createVault} from '../web/workspace-vault.mjs';

const ROOT=fileURLToPath(new URL('../',import.meta.url)),SELF=fileURLToPath(import.meta.url);
const mode=process.argv[2],options=Object.fromEntries(process.argv.slice(3).map(arg=>{assert.match(arg,/^--[a-z-]+=/,'Named options required');const i=arg.indexOf('=');return[arg.slice(2,i),arg.slice(i+1)];}));
const origin=options.origin||'http://127.0.0.1:8789',url=new URL(origin);
const production=options['production-testnet']==='yes';
assert.equal(url.origin,origin);assert.ok(['run','serve','verify-public'].includes(mode),'Explicit run required');
if(production){assert.equal(origin,'https://veil-procurement.vercel.app');assert.notEqual(mode,'serve');}
else{assert.equal(url.protocol,'http:');assert.equal(url.hostname,'127.0.0.1');assert.ok(Number(url.port)>=1024);}
assert.equal(POLICY?.network,'testnet','Reviewed deployment pin required');assert.equal(POLICY.requireKeyless,true);assert.notEqual(POLICY.contractId,undefined);
const DIR=path.join(ROOT,production?'runtime/wallet-workspace-production':'runtime/wallet-workspace-http'),STATE=path.join(DIR,'client-state.json'),LEDGER=path.join(DIR,'ledger');
const EVIDENCE=path.join(ROOT,'docs/verification',production?'wallet-funded-http-production.json':'wallet-funded-http-local.json');
const sha=value=>createHash('sha256').update(value).digest('hex');
const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));
let stage=mode,state,serverChild;
function note(action,extra={}){process.stdout.write(JSON.stringify({action,...extra})+'\n');}
function privateDir(dir){fs.mkdirSync(dir,{recursive:true,mode:0o700});const s=fs.lstatSync(dir);assert.ok(s.isDirectory()&&!s.isSymbolicLink()&&!(s.mode&0o077),'Unsafe private directory');}
function privateRead(file){const s=fs.lstatSync(file);assert.ok(s.isFile()&&!s.isSymbolicLink()&&(s.mode&0o777)===0o600,'Unsafe private file');return JSON.parse(fs.readFileSync(file,'utf8'));}
function privateWrite(file,value,exclusive=false){
 privateDir(path.dirname(file));const temporary=exclusive?file:file+'.'+randomBytes(8).toString('hex')+'.tmp';
 const fd=fs.openSync(temporary,fs.constants.O_WRONLY|fs.constants.O_CREAT|fs.constants.O_EXCL|fs.constants.O_NOFOLLOW,0o600);
 try{fs.writeFileSync(fd,JSON.stringify(value));fs.fsyncSync(fd);}finally{fs.closeSync(fd);}
 if(!exclusive)fs.renameSync(temporary,file);
 const d=fs.openSync(path.dirname(file),fs.constants.O_RDONLY);try{fs.fsyncSync(d);}finally{fs.closeSync(d);}
}
function save(){privateWrite(STATE,state);}
function ledgerStore(){
 privateDir(LEDGER);
 const target=p=>{assert.match(p,/^nope-workspace-v1\/[a-z0-9/-]+\.json$/);return path.join(LEDGER,p);};
 const raw={async read(p){const file=target(p);return fs.existsSync(file)?privateRead(file):null;},async create(p,value){try{privateWrite(target(p),value,true);return true;}catch(error){if(error.code==='EEXIST')return false;throw error;}},async list({prefix,limit=20,cursor}){assert.equal(prefix,'nope-workspace-v1/index/');const dir=path.dirname(target(prefix+'a'.repeat(32)+'.json'));const names=fs.existsSync(dir)?fs.readdirSync(dir).filter(n=>/^[a-f0-9]{32}\.json$/.test(n)).sort():[],start=Number(cursor||0);assert.ok(Number.isSafeInteger(start)&&start>=0);return{pathnames:names.slice(start,start+limit).map(n=>prefix+n),cursor:start+limit<names.length?String(start+limit):null};}};
 // Exercise the production adapter's exact path/size/private-access guards.
 // The transport alone is a local filesystem fixture; no Blob token is used.
 return blobWorkspaceStore({}, {
  async get(p,options){assert.equal(options.access,'private');assert.equal(options.useCache,false);const value=await raw.read(p);return value===null?null:{statusCode:200,stream:new Blob([JSON.stringify(value)]).stream()};},
  async put(p,body,options){assert.equal(options.access,'private');assert.equal(options.allowOverwrite,false);if(!await raw.create(p,JSON.parse(body)))throw Error('Local immutable blob already exists');},
  async list(options){const result=await raw.list(options);return{blobs:result.pathnames.map(pathname=>({pathname})),hasMore:result.cursor!==null,cursor:result.cursor};}
 });
}
async function pin(rpc){
 assert.equal((await rpc('status',[])).chain_id,'testnet');
 const account=await rpc('query',{request_type:'view_account',account_id:POLICY.contractId,finality:'final'});assert.equal(account.code_hash,POLICY.codeHash);
 const keys=await rpc('query',{request_type:'view_access_key_list',account_id:POLICY.contractId,block_id:account.block_hash});assert.equal(keys.block_hash,account.block_hash);assert.deepEqual(keys.keys,[]);
 return{blockHash:account.block_hash,blockHeight:account.block_height,codeHash:account.code_hash,keys:[]};
}
async function api(route,who,body){
 const response=await fetch(origin+'/api/workspace?route='+encodeURIComponent(route),{method:body===undefined?'GET':'POST',redirect:'error',signal:AbortSignal.timeout(180000),headers:{origin,...(state?.cookie?{cookie:state.cookie}:{}),...(who?{authorization:'Bearer '+state[who].token}:{}),...(body!==undefined?{'content-type':'application/json'}:{})},...(body!==undefined?{body:JSON.stringify(body)}:{})});
 const cookie=response.headers.get('set-cookie');if(cookie&&state){state.cookie=cookie.split(';')[0];save();}
 const data=await response.json();if(!response.ok)throw Object.assign(Error('API_'+response.status+'_'+(data.code||'UNKNOWN')),{code:'API_'+response.status+'_'+(data.code||'UNKNOWN'),status:response.status});return data;
}
async function startServer(){
 const child=fork(SELF,['serve','--origin='+origin],{cwd:ROOT,env:{PATH:process.env.PATH,HOME:process.env.HOME},stdio:['ignore','pipe','pipe','ipc']});
 let diagnostic='';child.stderr.on('data',chunk=>{diagnostic=(diagnostic+chunk.toString()).slice(-10000);});
 await new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(Error('LOCAL_API_START_TIMEOUT')),20000);child.once('error',reject);child.once('exit',()=>{clearTimeout(timer);reject(Error('LOCAL_API_EXITED'));});child.on('message',message=>{if(message?.ready===origin){clearTimeout(timer);resolve();}});});return child;
}
async function provePublic(){
 const jobId=options.job;assert.match(jobId,/^[a-f0-9]{32}$/);
 const response=await fetch(origin+'/api/workspace?route='+encodeURIComponent('jobs/'+jobId+'/proof/evidence'),{redirect:'error',signal:AbortSignal.timeout(30000)});assert.equal(response.status,200);
 const e=validatePublicEvidence(await response.json(),jobId);assert.equal(e.walletBuyerAccount,options.buyer);assert.equal(e.binding.contractId,POLICY.contractId);
 const chain=await verifyPublicChainBinding(e);assert.equal(chain.escrowState,'Paid');
 assert.equal(await verifyProofPlanBundle({request:e.task,delivery:e.delivery,binding:e.binding,bundle:e.bundle}),true);
 const result={jobId,buyerWitnessUsed:false,authenticatedSessionUsed:false,actualSNARKVerified:true,chain,rows:e.bundle.rows.length,publicEvidenceSha256:sha(canonical(e))};
 process.send?.({publicVerification:result});await(await proofRuntime()).dispose();
}
async function run(){
 privateDir(DIR);assert.equal(execFileSync('git',['check-ignore','--quiet',path.relative(ROOT,DIR)],{cwd:ROOT}).length,0,'Recovery directory must be ignored');
 const lock=path.join(DIR,'qa.lock'),fd=fs.openSync(lock,fs.constants.O_WRONLY|fs.constants.O_CREAT|fs.constants.O_EXCL|fs.constants.O_NOFOLLOW,0o600);fs.writeSync(fd,String(process.pid));
 try{
  stage='read-local-test-wallets';const keyPath=path.resolve(ROOT,options.keys||'payments/wallet_escrow/runtime/identities.json');assert.ok(keyPath.startsWith(ROOT));execFileSync('git',['check-ignore','--quiet',path.relative(ROOT,keyPath)],{cwd:ROOT});
  const identities=privateRead(keyPath);assert.equal(identities.network,'testnet');
  const ids=Object.fromEntries(['buyer','provider'].map(role=>{const id=identities[role];assert.equal(id.network,'testnet');assert.ok(id.account_id.endsWith('.testnet'));assert.notEqual(id.account_id,POLICY.contractId);assert.equal(KeyPair.fromString(id.private_key).getPublicKey().toString(),id.public_key);return[role,id];}));
  delete identities.contract;assert.notEqual(ids.buyer.account_id,ids.provider.account_id);
  const rpc=createWalletRPC(POLICY),started=performance.now();stage='verify-keyless-pins';const initialPin=await pin(rpc);
  if(fs.existsSync(STATE)){state=privateRead(STATE);assert.equal(state.origin,origin);assert.equal(state.contractId,POLICY.contractId);assert.equal(state.buyerAccount,ids.buyer.account_id);assert.equal(state.providerAccount,ids.provider.account_id);}
  else{state={version:1,origin,contractId:POLICY.contractId,buyerAccount:ids.buyer.account_id,providerAccount:ids.provider.account_id,jobId:randomBytes(16).toString('hex'),amountYocto:'1000000000000000000000',salt:randomBytes(32).toString('hex'),checks:{},transactions:{},startedAt:new Date().toISOString()};save();}
  if(!production)serverChild=await startServer();note(production?'actual-production-HTTP-ready':'actual-local-HTTP-ready',{origin,jobId:state.jobId});
  for(const role of ['buyer','provider']){
   stage='NEP413-'+role;
   if(!state[role]){state[role]=await api('session',null,{role,displayName:'Wallet HTTP synthetic '+role});save();}
   let session=(await api('session',role)).session;
   if(!session.wallet){const{challenge}=await api('wallet/challenge',role,{accountId:ids[role].account_id});const signer=KeyPairSigner.fromSecretKey(ids[role].private_key);
    const signed=await signMessage({signerAccount:{accountId:ids[role].account_id,getSigner:()=>signer},payload:{message:challenge.message,nonce:new Uint8Array(Buffer.from(challenge.nonce,'base64')),recipient:challenge.recipient,callbackUrl:challenge.callbackUrl}});
    const verified=await api('wallet/verify',role,{challengeId:challenge.challengeId,accountId:ids[role].account_id,publicKey:signed.publicKey.toString(),signature:Buffer.from(signed.signature).toString('base64')});session=verified.session;
   }
   assert.equal(session.wallet.accountId,ids[role].account_id);assert.equal(session.wallet.network,'testnet');assert.equal(session.id,walletIdentity(role,ids[role].account_id));state[role].session=session;state.checks[role+'NEP413Verified']=true;save();
  }
  assert.equal(state.buyer.wallet?.required??state.buyer.proof?.enabled,true);
  stage='prepare-one-row-v4';
  if(!state.prepared){
   state.dataset=parseCSV('private_score,private_preserved\n,keep-synthetic-X\n');state.task={version:1,goal:'Fill C1 blanks with 7.',columns:[{id:'C1',type:'number'}]};
   state.plan=(await acceptAgentProposal(state.task,{steps:[{column:'C1',recipe:{type:'number',steps:[{op:'fill',value:7}]}}]})).plan;
   state.prepared=await prepareProofPlan(privatePlanInputs(state.dataset,state.plan),state.plan,{jobId:state.jobId,buyerCommitment:sha('NOPE:buyer:'+state.buyer.session.id),contractId:POLICY.contractId});
   const pair=generateKeyPairSync('rsa',{modulusLength:2048});state.privateRSA=pair.privateKey.export({type:'pkcs8',format:'pem'});state.publicRSA=pair.publicKey.export({format:'jwk'});
   state.payload={jobId:state.jobId,title:'Actual wallet-funded HTTP proof QA',description:'Synthetic one-row numeric v4 result proof. Authored plan; no neural inference claim.',deadlineISO:new Date(Date.now()+3600000).toISOString(),profile:state.prepared.request.profile,rowCount:1,task:state.prepared.request,buyerPublicKey:state.publicRSA,publicTask:state.task};
   const wire=JSON.stringify(state.payload);for(const forbidden of ['private_score','private_preserved','keep-synthetic-X','decoder','proofWitness','inputPairs','outputPairs','inputSalt','outputSalt'])assert.ok(!wire.includes(forbidden),'Private local material in job payload');save();
  }
  const base='jobs/'+state.jobId;let job;
  try{job=(await api(base,'buyer')).job;}catch(error){if(error.status!==404)throw error;job=(await api('jobs','buyer',state.payload)).job;}
  assert.equal(job.payment.kind,'WALLET_TESTNET_ESCROW');assert.equal(job.buyerWallet.accountId,ids.buyer.account_id);assert.equal(job.buyerId,state.buyer.session.id);
  stage='sealed-encrypted-quote';
  if(job.status==='OPEN'){
   const providerView=(await api(base,'provider')).job;
   if(!providerView.ownOffer){const quote={jobId:state.jobId,providerId:state.provider.session.id,amountYocto:state.amountYocto,deliveryHours:1,note:'Synthetic encrypted HTTP QA',salt:state.salt};const vault=createVault(state.provider.session.id,{storage:{}});const envelope=await vault.encryptQuote(state.publicRSA,quote);
    await api(base+'/offers','provider',{envelope,commitment:quoteCommitment(state.jobId,quote.providerId,quote.amountYocto,quote.salt)});
   }
   assert.ok(!Object.hasOwn((await api(base,'buyer')).job,'offers'));job=(await api(base+'/close','buyer',{})).job;
  }
  if(job.status==='CLOSED'){
   const offer=job.offers.find(o=>o.wallet?.accountId===ids.provider.account_id);assert.ok(offer);
   const e=offer.envelope,key=privateDecrypt({key:state.privateRSA,oaepHash:'sha256',padding:constants.RSA_PKCS1_OAEP_PADDING},Buffer.from(e.wrappedKey,'base64')),encrypted=Buffer.from(e.ciphertext,'base64'),dec=createDecipheriv('aes-256-gcm',key,Buffer.from(e.iv,'base64'));
   dec.setAAD(Buffer.from('workspace-vault/quote/v1'));dec.setAuthTag(encrypted.subarray(-16));const quote=JSON.parse(Buffer.concat([dec.update(encrypted.subarray(0,-16)),dec.final()]).toString());assert.equal(quote.salt,state.salt);assert.equal(quote.amountYocto,state.amountYocto);assert.equal(quote.providerId,state.provider.session.id);state.checks.sealedQuoteLocallyDecrypted=true;save();
   job=(await api(base+'/award','buyer',{offerId:offer.id,amountYocto:quote.amountYocto,salt:quote.salt})).job;
  }
  async function refreshUntil(predicate){for(let i=0;i<30;i++){if(predicate(job))return;await sleep(1000);job=(await api(base+'/payment/refresh','buyer',{})).job;note('observe-existing-transaction',{status:job.status,payment:job.payment.status});}throw Error('FINAL_OBSERVATION_INCOMPLETE_NO_RESEND');}
  async function walletAction(action,role,predicate){
   stage='wallet-'+action;let journal=state.transactions[action];
   if(!journal){
    const prepared=await api(base+'/payment/prepare',role,{action});job=prepared.job;const intent=prepared.intent;assert.ok(intent,'No signing intent; reconcile existing operation');
    const tx=intent.transaction,a=tx.actions[0].params;assert.equal(intent.action,action);assert.equal(intent.network,'testnet');assert.equal(tx.signerId,ids[role].account_id);assert.equal(tx.receiverId,POLICY.contractId);assert.equal(tx.actions.length,1);assert.equal(tx.actions[0].type,'FunctionCall');assert.equal(a.gas,'150000000000000');assert.equal(a.methodName,{fund:'fund',record:'record_delivery',release:'accept_and_release'}[action]);assert.equal(a.deposit,action==='fund'?state.amountYocto:'0');assert.equal(intent.bindingHash,job.payment.bindingHash);
    if(action==='fund'){assert.equal(a.args.terms.buyer_account,ids.buyer.account_id);assert.equal(a.args.terms.provider,ids.provider.account_id);assert.equal(a.args.terms.amount,state.amountYocto);assert.equal(a.args.terms.input_hash,job.taskHash);assert.equal(a.args.terms.program_hash,job.programHash);assert.equal(a.args.terms.job_id,state.jobId);assert.equal(a.args.terms.buyer_commitment,sha('NOPE:buyer:'+job.buyerId));}
    else assert.deepEqual(a.args,{buyer_account:ids.buyer.account_id,job_id:state.jobId,version:job.delivery.version,output_hash:job.delivery.outputSha256});
    await pin(rpc);const access=await rpc('query',{request_type:'view_access_key',account_id:ids[role].account_id,public_key:ids[role].public_key,finality:'final'});assert.equal(access.permission,'FullAccess');
    const transaction=createTransaction(ids[role].account_id,PublicKey.fromString(ids[role].public_key),POLICY.contractId,BigInt(access.nonce)+1n,[actions.functionCall(a.methodName,a.args,BigInt(a.gas),BigInt(a.deposit))],baseDecode(access.block_hash));
    const signed=await KeyPairSigner.fromSecretKey(ids[role].private_key).signTransaction(transaction);journal={intent,transactionHash:baseEncode(signed.txHash),signedBytes:Buffer.from(signed.signedTransaction.encode()).toString('base64'),signerId:ids[role].account_id,broadcastAttempted:false,signedAt:new Date().toISOString()};state.transactions[action]=journal;save();
    // Mark BEFORE the network call. Any crash/timeout after this point is
    // reconciled by hash only; the same or a replacement tx is never auto-sent.
    journal.broadcastAttempted=true;save();
    try{await fetch('https://test.rpc.fastnear.com',{method:'POST',redirect:'error',signal:AbortSignal.timeout(20000),headers:{'content-type':'application/json'},body:JSON.stringify({jsonrpc:'2.0',id:'explicit-local-test-client-broadcast',method:'send_tx',params:{signed_tx_base64:journal.signedBytes,wait_until:'NONE'}})});}catch{/* Observe the persisted hash; never send again. */}
   }
   assert.equal(journal.signerId,ids[role].account_id);assert.equal(journal.intent.action,action);assert.equal(journal.broadcastAttempted,true,'Prepared but unbroadcast journal requires explicit manual review');
   for(let attempt=0;;attempt++){
    try{job=(await api(base+'/payment/confirm',role,{action,transactionHash:journal.transactionHash})).job;break;}
    catch(error){
     // A FINAL tx responder can be ahead of a different RPC node's FINAL
     // account snapshot. Retry only this read/confirm of the identical hash.
     if(error.code!=='API_409_WALLET_TRANSACTION_BLOCK_MISMATCH'||attempt>=20)throw error;
     note('wait-for-coherent-FINAL-snapshot',{action,transactionHash:journal.transactionHash});await sleep(1000);
    }
   }
   await refreshUntil(predicate);assert.equal(job.payment.verifiedTransactions?.[action],journal.transactionHash);assert.equal(job.payment[{fund:'fundTransactionHash',record:'recordTransactionHash',release:'releaseTransactionHash'}[action]],journal.transactionHash);state.checks[action+'ReceiptVerified']=true;save();note('actual-wallet-action-FINAL',{action,transactionHash:journal.transactionHash,status:job.status,payment:job.payment.status});
  }
  if(job.status==='AWARDED'){
   if(!state.checks.unfundedExecutionRejected){await assert.rejects(api(base+'/execute','provider',{}),error=>error.code==='API_409_ESCROW_FUNDING_REQUIRED');state.checks.unfundedExecutionRejected=true;save();}
   await walletAction('fund','buyer',j=>j.payment.status==='HELD'&&j.payment.verified===true);stage='actual-encrypted-execution';job=(await api(base+'/execute','provider',{})).job;
  }
  if(job.delivery){stage='buyer-local-reference';const d=job.delivery,result=await decodeProofPlan({profile:d.profile,nonce:d.nonce,rowCount:d.rowCount,outputs:d.outputs,inputSha256:d.inputSha256,programSha256:d.programSha256,outputSha256:d.outputSha256},state.prepared.decoder);const csv=applyAgentOutput(state.dataset,state.plan,result);assert.deepEqual(result,{C1:[7]});assert.deepEqual(csv.rows,[['7','keep-synthetic-X']]);state.checks.localReferenceMatched=true;save();}
  if(job.status==='DELIVERED'){
   await walletAction('record','provider',j=>j.payment.status==='HELD'&&j.payment.verified===true&&j.payment.recordedVersion===j.delivery.version&&j.payment.recordedOutputHash===j.delivery.outputSha256);
   if(!state.checks.acceptanceRequiresActualProof){await assert.rejects(api(base+'/decision','buyer',{decision:'accept',version:job.delivery.version,outputSha256:job.delivery.outputSha256}),error=>error.code==='API_409_RESULT_PROOF_REQUIRED');state.checks.acceptanceRequiresActualProof=true;save();}
   stage='actual-SNARK';const binding={jobId:job.id,version:job.delivery.version,contractId:POLICY.contractId,bindingHash:job.payment.bindingHash,provider:ids.provider.account_id,amountYocto:state.amountYocto};
   if(!state.bundle){state.bundle=await proveProofPlan({request:state.prepared.request,delivery:job.delivery,binding,witness:state.prepared.witness,onProgress:p=>note('actual-SNARK-progress',p)});save();}
   assert.equal(await verifyProofPlanBundle({request:state.prepared.request,delivery:job.delivery,binding,bundle:state.bundle}),true);state.checks.actualSNARKLocallyVerified=true;save();
   if(job.proof?.status!=='VERIFIED')job=(await api(base+'/proof','buyer',{version:job.delivery.version,outputSha256:job.delivery.outputSha256,bundle:state.bundle})).job;
   assert.equal(job.proof.status,'VERIFIED');state.checks.actualSNARKServerVerified=true;save();stage='explicit-buyer-acceptance';job=(await api(base+'/decision','buyer',{decision:'accept',version:job.delivery.version,outputSha256:job.delivery.outputSha256})).job;assert.equal(job.status,'ACCEPTED');state.checks.explicitBuyerAcceptance=true;save();
  }
  if(job.status==='ACCEPTED')await walletAction('release','buyer',j=>j.status==='PAID'&&j.payment.status==='PAID'&&j.payment.verified===true);
  assert.equal(job.status,'PAID');state.final=job;save();await(await proofRuntime()).dispose();
  stage='independent-public-verification';
  const publicCheck=await new Promise((resolve,reject)=>{const child=fork(SELF,['verify-public','--origin='+origin,'--job='+state.jobId,'--buyer='+ids.buyer.account_id,...(production?['--production-testnet=yes']:[])],{cwd:ROOT,env:{PATH:process.env.PATH,HOME:process.env.HOME},stdio:['ignore','pipe','pipe','ipc']});const timer=setTimeout(()=>{child.kill('SIGTERM');reject(Error('PUBLIC_VERIFIER_TIMEOUT'));},180000);child.on('message',m=>{if(m?.publicVerification){clearTimeout(timer);resolve(m.publicVerification);}});child.once('error',reject);child.once('exit',code=>{clearTimeout(timer);if(code)reject(Error('PUBLIC_VERIFIER_FAILED'));});});
  state.checks.independentPublicSNARKAndChainVerified=true;save();
  for(const key of ['buyerNEP413Verified','providerNEP413Verified','sealedQuoteLocallyDecrypted','unfundedExecutionRejected','fundReceiptVerified','recordReceiptVerified','localReferenceMatched','acceptanceRequiresActualProof','actualSNARKLocallyVerified','actualSNARKServerVerified','explicitBuyerAcceptance','releaseReceiptVerified','independentPublicSNARKAndChainVerified'])assert.equal(state.checks[key],true,key);
  const finalPin=await pin(rpc),evidence={recordedAt:new Date().toISOString(),origin,network:'testnet',syntheticOnly:true,actualHTTP:true,actualExternalTestnet:true,browserTest:false,authoredPlan:true,neuralPlanning:false,contractId:POLICY.contractId,codeHash:POLICY.codeHash,requireKeyless:true,initialPin,finalPin,buyerAccount:ids.buyer.account_id,providerAccount:ids.provider.account_id,jobId:job.id,profile:job.profile,rowCount:job.rowCount,processedCells:1,status:job.status,amountYocto:state.amountYocto,payment:job.payment,proof:job.proof,publicVerification:publicCheck,checks:state.checks,transactionHashes:Object.fromEntries(Object.entries(state.transactions).map(([action,j])=>[action,j.transactionHash])),proofClaim:'Typed result correctness relative to precommitted buyer mappings; not AES execution provenance, original CSV provenance, or on-chain SNARK verification.',elapsedMs:Math.round(performance.now()-started)};
  fs.mkdirSync(path.dirname(EVIDENCE),{recursive:true});fs.writeFileSync(EVIDENCE,JSON.stringify(evidence,null,2)+'\n');note('verified-actual-wallet-HTTP-cycle',{jobId:state.jobId,status:job.status,evidence:path.relative(ROOT,EVIDENCE)});
 }finally{serverChild?.kill('SIGTERM');await(await proofRuntime()).dispose().catch(()=>{});fs.closeSync(fd);fs.unlinkSync(lock);}
}
try{
 if(mode==='serve'){
  privateDir(DIR);const handler=createWorkspaceHandler({env:{NOPE_WORKSPACE_ORIGIN:origin},store:ledgerStore()}),server=createServer(handler);await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(Number(url.port),'127.0.0.1',resolve);});process.send?.({ready:origin});process.on('SIGTERM',()=>server.close(()=>process.exit(0)));
 }else if(mode==='verify-public')await provePublic();
 else await run();
}catch(error){const code=typeof error.code==='string'&&/^[A-Z0-9_]+$/.test(error.code)?error.code:typeof error.message==='string'&&/^[A-Z0-9_]+$/.test(error.message)?error.message:'QA_CHECK_FAILED';
 if(state)privateWrite(path.join(DIR,'last-error.json'),{stage,code,stack:String(error.stack)});note('wallet-HTTP-QA-stopped',{stage,code,noAutomaticResend:true});process.exitCode=1;
}
