/** Testnet wallet boundary. Production delegates every signature/transaction to
 * NEAR Connect; finality and chain ownership are verified by the backend.
 * connectorFactory is an explicitly injected UNIT seam, never a signing fallback. */
import {WALLET_ESCROW_POLICY} from './wallet-pins.mjs';
import {msg} from './i18n.mjs';
const DOMAIN='NOPE:WALLET-ESCROW:V2:testnet';
const METHODS=Object.freeze({fund:'fund',record:'record_delivery',release:'accept_and_release',refund:'refund'});
const TERMS=['job_id','buyer_commitment','buyer_account','provider','amount','input_hash','program_hash','plan_hash','execution_deadline_ns','review_deadline_ns'];
const GAS='150000000000000',MAX_AMOUNT=10n**24n,U64=(1n<<64n)-1n;
const PREFIX='nope.wallet.client.v1.',PENDING=PREFIX+'pending',ACCOUNT=PREFIX+'account';
export class WalletClientError extends Error {constructor(code){super(code);this.name='WalletClientError';this.code=code;}}
const fail=code=>{throw new WalletClientError(code);};
const check=(v,code='WALLET_INVALID_INTENT')=>{if(!v)fail(code);};
const plain=v=>v&&typeof v==='object'&&!Array.isArray(v)&&[Object.prototype,null].includes(Object.getPrototypeOf(v));
function exact(v,keys,code='WALLET_INVALID_INTENT'){
 check(plain(v)&&Reflect.ownKeys(v).length===keys.length,code);
 for(const k of keys){const d=Object.getOwnPropertyDescriptor(v,k);check(d?.enumerable&&Object.hasOwn(d,'value'),code);}
}
const hex=(s,n)=>typeof s==='string'&&new RegExp(`^[0-9a-f]{${n}}$`).test(s);
const account=s=>typeof s==='string'&&(hex(s,64)||(s.length>=8&&s.length<=64&&/^[a-z0-9]+(?:[-_][a-z0-9]+)*(?:\.[a-z0-9]+(?:[-_][a-z0-9]+)*)*\.testnet$/.test(s)));
const decimal=s=>typeof s==='string'&&/^(0|[1-9][0-9]{0,24})$/.test(s);
const canonical=v=>JSON.stringify(v,(_,x)=>plain(x)?Object.fromEntries(Object.keys(x).sort().map(k=>[k,x[k]])):x);
const snapshot=v=>JSON.parse(JSON.stringify(v));
function jsonData(v,depth=0){check(depth<=8);if(v===null||typeof v==='boolean'||typeof v==='string'||typeof v==='number'&&Number.isSafeInteger(v))return;if(Array.isArray(v)){check(Object.getPrototypeOf(v)===Array.prototype&&Reflect.ownKeys(v).length===v.length+1);for(let i=0;i<v.length;i++){const d=Object.getOwnPropertyDescriptor(v,String(i));check(d?.enumerable&&Object.hasOwn(d,'value'));jsonData(d.value,depth+1);}return;}check(plain(v));for(const k of Reflect.ownKeys(v)){check(typeof k==='string');const d=Object.getOwnPropertyDescriptor(v,k);check(d.enumerable&&Object.hasOwn(d,'value'));jsonData(d.value,depth+1);}}
const b64=bytes=>{let s='';for(const b of bytes)s+=String.fromCharCode(b);return btoa(s);};
function base64(s,n,code='WALLET_INVALID_ENCODING'){check(typeof s==='string'&&s.length<=4096,code);let b;try{b=Uint8Array.from(atob(s),x=>x.charCodeAt(0));}catch{fail(code);}check(b.length===n&&b64(b)===s,code);return b;}
const ALPHABET='123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
function base58(s,n){check(typeof s==='string'&&s.length<=90&&s.length>0,'WALLET_INVALID_ENCODING');let x=0n;for(const c of s){const i=ALPHABET.indexOf(c);check(i>=0,'WALLET_INVALID_ENCODING');x=x*58n+BigInt(i);}const bytes=[];while(x){bytes.unshift(Number(x&255n));x>>=8n;}let zeros=0;while(s[zeros]==='1')zeros++;const b=Uint8Array.from([...Array(zeros).fill(0),...bytes]);check(b.length===n,'WALLET_INVALID_ENCODING');return b;}
function publicKey(s){check(typeof s==='string'&&s.startsWith('ed25519:'),'WALLET_INVALID_SIGNATURE');base58(s.slice(8),32);return s;}
function signature(s){return typeof s==='string'&&s.startsWith('ed25519:')?b64(base58(s.slice(8),64)):(base64(s,64,'WALLET_INVALID_SIGNATURE'),s);}
function chainHash(s){check(typeof s==='string'&&s.length>=32&&s.length<=44,'WALLET_INVALID_TRANSACTION');base58(s,32);return s;}
async function digest(crypto,text){return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(text))),b=>b.toString(16).padStart(2,'0')).join('');}
function policyObject(policy){exact(policy,['network','contractId','codeHash','domain','requireKeyless','storageDepositYocto',...(policy?.admissionPublicKey!==undefined?['admissionPublicKey']:[])],'WALLET_POLICY_DISABLED');check(policy.storageDepositYocto==='40960000000000000000000'&&policy.network==='testnet'&&policy.requireKeyless===true&&policy.domain===DOMAIN&&account(policy.contractId)&&policy.contractId.endsWith('.testnet'),'WALLET_POLICY_DISABLED');if(policy.admissionPublicKey!==undefined)check(hex(policy.admissionPublicKey,64)&&policy.admissionPublicKey!=='0'.repeat(64),'WALLET_POLICY_DISABLED');chainHash(policy.codeHash);return snapshot(policy);}
function boundsObject(b){
 const required=['action','jobId','bindingHash','accountId','contractId','buyerAccount'];
 const optional=['network','provider','amountYocto','version','outputHash','buyerCommitment','inputHash','programHash','planHash','executionDeadlineNs','reviewDeadlineNs','expectedArgs','gas','deposit'];
 check(plain(b)&&required.every(k=>Object.hasOwn(b,k)));exact(b,Object.keys(b));check(Object.keys(b).every(k=>required.includes(k)||optional.includes(k)));jsonData(b);return snapshot(b);
}
/** Synchronous factory. Constructing it does not connect, sign or send. */
export function createWalletClient({window:win=globalThis.window,network='testnet',policy=WALLET_ESCROW_POLICY,connectorFactory,selectAccount,selectWallet,now=Date.now}={}){
 let connectorPromise,wallet=null,selected=null,busy=false;const crypto=win?.crypto??globalThis.crypto;
 const origin=win?.location?.origin;
 const enabled=()=>{
  check(network==='testnet','WALLET_WRONG_NETWORK');check(win&&crypto?.subtle&&win.sessionStorage,'WALLET_UNAVAILABLE');
  check(typeof origin==='string'&&(origin.startsWith('https://')||/^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin)),'WALLET_ORIGIN');
  const p=policyObject(policy);if(!connectorFactory)check(WALLET_ESCROW_POLICY&&canonical(p)===canonical(WALLET_ESCROW_POLICY),'WALLET_POLICY_DISABLED');return p;
 };
 const readPending=()=>{try{const raw=win.sessionStorage.getItem(PENDING);if(!raw)return null;check(raw.length<4096,'WALLET_CALLBACK_INVALID');const p=JSON.parse(raw);if(p?.kind==='challenge'&&Number.isFinite(p.expiresAt)&&p.expiresAt<=now()){win.sessionStorage.removeItem(PENDING);return null;}return p;}catch{fail('WALLET_CALLBACK_INVALID');}};
 const savePending=p=>{try{win.sessionStorage.setItem(PENDING,JSON.stringify(p));check(win.sessionStorage.getItem(PENDING)===JSON.stringify(p),'WALLET_STORAGE_UNAVAILABLE');}catch{fail('WALLET_STORAGE_UNAVAILABLE');}};
 const clearPending=()=>win.sessionStorage.removeItem(PENDING);
 const run=fn=>async(...args)=>{check(!busy,'WALLET_BUSY');enabled();busy=true;try{args=args.map(a=>{jsonData(a);return snapshot(a);});return await fn(...args);}catch(e){if(e instanceof WalletClientError)throw e;const msg=String(e?.message??e);if(/reject|denied|cancel|closed/i.test(msg))fail('WALLET_REJECTED');fail('WALLET_UNAVAILABLE');}finally{busy=false;}};
 const labels=()=>({title:String(msg('Testnet cüzdanı seç')),cancel:String(msg('Cüzdan isteğini iptal et')),frameTitle:String(msg('Testnet cüzdan bağlantısı')),open:String(msg('Cüzdanı aç')),prompt:String(msg('Devam etmek için cüzdanını aç.'))});
 async function connector(){if(!connectorPromise){connectorPromise=(async()=>{if(connectorFactory)return connectorFactory({network:'testnet',autoConnect:false});const sdk=await import('/wallet-runtime/wallet-sdk.js');return sdk.createConnector({window:win,network:'testnet',labels:labels()});})().catch(e=>{connectorPromise=null;throw e;});}const c=await connectorPromise;c.setLabels?.(labels());return c;}
 function saveAccount(a){selected=Object.freeze({...a});win.sessionStorage.setItem(ACCOUNT,JSON.stringify(selected));return {...selected};}
 async function chooseAccounts(w,options={}){
  const accounts=await w.getAccounts({network:'testnet'});check(Array.isArray(accounts)&&accounts.length>=1&&accounts.length<=32,'WALLET_ACCOUNT_REQUIRED');
  const clean=accounts.map(a=>{check(plain(a)&&account(a.accountId),'WALLET_WRONG_NETWORK');if(a.publicKey)publicKey(a.publicKey);return {accountId:a.accountId,...(a.publicKey?{publicKey:a.publicKey}:{})};});
  check(new Set(clean.map(a=>a.accountId)).size===clean.length,'WALLET_ACCOUNT_REQUIRED');
  let id=options.accountId??selected?.accountId;
  if(!id&&clean.length===1)id=clean[0].accountId;
  if(!id&&selectAccount)id=await selectAccount(snapshot(clean));
  check(typeof id==='string'&&clean.some(a=>a.accountId===id),'WALLET_ACCOUNT_SELECTION_REQUIRED');
  return saveAccount({...clean.find(a=>a.accountId===id),walletId:w.manifest.id,network:'testnet'});
 }
 async function current(){enabled();if(!wallet)return null;const old=selected;const next=await chooseAccounts(wallet,{accountId:old?.accountId});check(!old||next.accountId===old.accountId,'WALLET_ACCOUNT_CHANGED');return next;}
 const connect=run(async(options={})=>{
  exact(options,Object.keys(options),'WALLET_INVALID_OPTIONS');check(Object.keys(options).every(k=>['walletId','accountId'].includes(k)),'WALLET_INVALID_OPTIONS');
  const c=await connector();await c.whenManifestLoaded;
  let walletId=options.walletId;
  if(!walletId&&selectWallet)walletId=await selectWallet(c.availableWallets.map(w=>({id:w.manifest.id,name:w.manifest.name})));
  if(!walletId&&typeof c.selectWallet==='function')walletId=await c.selectWallet();
  check(typeof walletId==='string'&&c.availableWallets.some(w=>w.manifest.id===walletId&&w.manifest.features.testnet&&w.manifest.features.signMessage&&w.manifest.features.signAndSendTransaction),'WALLET_UNAVAILABLE');
  wallet=await c.connect({walletId});return chooseAccounts(wallet,options);
 });
 function challengeObject(value,a){
  const keys=['challengeId','network','accountId','sessionId','role','origin','nonce','issuedAt','expiresAt','message','recipient','callbackUrl'];exact(value,keys,'WALLET_INVALID_CHALLENGE');
  check(hex(value.challengeId,64)&&value.network==='testnet'&&value.accountId===a.accountId&&hex(value.sessionId,32)&&['buyer','provider'].includes(value.role)&&value.origin===origin&&value.recipient===origin&&value.callbackUrl===origin+'/settings','WALLET_INVALID_CHALLENGE');
  base64(value.nonce,32,'WALLET_INVALID_CHALLENGE');const issued=Date.parse(value.issuedAt),expires=Date.parse(value.expiresAt);
  check(Number.isFinite(issued)&&expires===issued+300000&&issued<=now()+30000&&now()<expires,'WALLET_CHALLENGE_EXPIRED');
  const expected={version:1,purpose:'NOPE:WALLET-AUTH:V1',network:'testnet',accountId:value.accountId,sessionId:value.sessionId,role:value.role,origin,challengeId:value.challengeId,nonce:value.nonce,issuedAt:value.issuedAt,expiresAt:value.expiresAt};
  check(value.message===canonical(expected),'WALLET_INVALID_CHALLENGE');return snapshot(value);
 }
 function signedResult(raw,challengeId,accountId){check(plain(raw)&&raw.accountId===accountId,'WALLET_ACCOUNT_CHANGED');return {challengeId,accountId,publicKey:publicKey(raw.publicKey),signature:signature(raw.signature)};}
 const signChallenge=run(async value=>{
  const a=await current();check(a,'WALLET_ACCOUNT_REQUIRED');const c=challengeObject(value,a);
  check(!readPending(),'WALLET_PENDING_OPERATION');
  savePending({kind:'challenge',challengeId:c.challengeId,accountId:a.accountId,walletId:a.walletId,network:'testnet',origin,createdAt:now(),expiresAt:Date.parse(c.expiresAt)});
  try{
   const raw=await wallet.signMessage({network:'testnet',signerId:a.accountId,message:c.message,nonce:base64(c.nonce,32),recipient:c.recipient,callbackUrl:c.callbackUrl,state:c.challengeId});
   if(raw==null)return {redirected:true,challengeId:c.challengeId};
   const result=signedResult(raw,c.challengeId,a.accountId);check((await current()).accountId===a.accountId,'WALLET_ACCOUNT_CHANGED');saveAccount({...a,publicKey:result.publicKey});clearPending();return result;
  }catch(e){if(/reject|denied|cancel|closed/i.test(String(e?.message??e)))clearPending();throw e;}
 });
 async function checkedIntent(value,rawBounds,a){
  exact(value,['id','action','network','bindingHash','transaction']);jsonData(value);const v=snapshot(value),b=boundsObject(rawBounds),p=enabled();
  check(hex(v.id,64)&&Object.hasOwn(METHODS,v.action)&&v.network==='testnet'&&hex(v.bindingHash,64));
  check(v.action===b.action&&v.bindingHash===b.bindingHash&&b.accountId===a.accountId&&account(b.buyerAccount)&&hex(b.jobId,32)&&b.contractId===p.contractId&&(!b.network||b.network==='testnet'));
  exact(v.transaction,['signerId','receiverId','actions']);check(v.transaction.signerId===a.accountId&&v.transaction.receiverId===p.contractId);
  const actions=v.transaction.actions;check(Array.isArray(actions)&&actions.length===1&&Object.keys(actions).length===1);exact(actions[0],['type','params']);check(actions[0].type==='FunctionCall');
  const call=actions[0].params;exact(call,['methodName','args','gas','deposit']);check(call.methodName===METHODS[v.action]&&call.gas===GAS&&decimal(call.deposit)&&BigInt(call.deposit)<=MAX_AMOUNT+BigInt(p.storageDepositYocto));
  if(b.gas!==undefined)check(call.gas===b.gas);if(b.deposit!==undefined)check(call.deposit===b.deposit);
  if(v.action==='fund'){
   check(a.accountId===b.buyerAccount);exact(call.args,['terms',...(p.admissionPublicKey?['admission_signature']:[])]);const t=call.args.terms;exact(t,TERMS);check(TERMS.every(k=>typeof t[k]==='string'));
   check(t.job_id===b.jobId&&t.buyer_account===b.buyerAccount&&account(t.provider)&&t.provider!==t.buyer_account&&t.provider!==p.contractId&&decimal(t.amount)&&BigInt(t.amount)>=1n&&BigInt(t.amount)<=MAX_AMOUNT&&call.deposit===(BigInt(t.amount)+BigInt(p.storageDepositYocto)).toString());
   check(t.provider===b.provider&&t.amount===b.amountYocto);for(const k of ['buyer_commitment','input_hash','program_hash','plan_hash'])check(hex(t[k],64));
   for(const k of ['execution_deadline_ns','review_deadline_ns'])check(/^[1-9][0-9]{0,19}$/.test(t[k])&&BigInt(t[k])<=U64);
   check(BigInt(t.execution_deadline_ns)>BigInt(now())*1000000n&&BigInt(t.review_deadline_ns)>BigInt(t.execution_deadline_ns)&&BigInt(t.review_deadline_ns)<=BigInt(now()+30*86400000)*1000000n);
   for(const [key,bound]of [['buyer_commitment','buyerCommitment'],['input_hash','inputHash'],['program_hash','programHash'],['plan_hash','planHash'],['execution_deadline_ns','executionDeadlineNs'],['review_deadline_ns','reviewDeadlineNs']])if(b[bound]!==undefined)check(t[key]===b[bound]);
   check(await digest(crypto,JSON.stringify([p.domain,p.contractId,...TERMS.map(k=>t[k])]))===v.bindingHash);
   if(p.admissionPublicKey){
    check(hex(call.args.admission_signature,128));
    const raw=s=>Uint8Array.from(s.match(/../g),x=>parseInt(x,16));
    const key=await crypto.subtle.importKey('raw',raw(p.admissionPublicKey),{name:'Ed25519'},false,['verify']);
    check(await crypto.subtle.verify('Ed25519',key,raw(call.args.admission_signature),new TextEncoder().encode('NOPE:WALLET-ADMISSION:V1\0'+v.bindingHash)));
   }
  }else{
   check(call.deposit==='0');const delivered=v.action==='record'||v.action==='release';exact(call.args,delivered?['buyer_account','job_id','version','output_hash']:['buyer_account','job_id']);
   check(call.args.buyer_account===b.buyerAccount&&call.args.job_id===b.jobId);
   if(v.action==='record')check(account(b.provider)&&(a.accountId===b.provider||a.accountId===b.buyerAccount));else check(a.accountId===b.buyerAccount);
   if(delivered)check(Number.isInteger(call.args.version)&&call.args.version>=1&&call.args.version<=0xffffffff&&call.args.version===b.version&&hex(call.args.output_hash,64)&&call.args.output_hash===b.outputHash);
  }
  if(b.expectedArgs!==undefined)check(JSON.stringify(call.args)===JSON.stringify(b.expectedArgs));
  check(new TextEncoder().encode(JSON.stringify(call.args)).length<=16384);return v;
 }
 const sendTransaction=run(async(value,bounds)=>{
  const a=await current();check(a,'WALLET_ACCOUNT_REQUIRED');const intent=await checkedIntent(value,bounds,a);check(!readPending(),'WALLET_PENDING_OPERATION');
  const state={kind:'transaction',intentId:intent.id,action:intent.action,accountId:a.accountId,walletId:a.walletId,network:'testnet',origin,createdAt:now(),expiresAt:now()+1800000};savePending(state);
  let raw;try{raw=await wallet.signAndSendTransaction({...snapshot(intent.transaction),network:'testnet',callbackUrl:origin+'/settings?state='+intent.id});}catch(e){// A closed wallet can already have broadcast. Never classify an SDK failure as pre-broadcast cancellation.
   fail('WALLET_TRANSACTION_UNKNOWN');}
  if(raw==null)return {redirected:true,intentId:intent.id};
  const tx=raw.transaction;check(tx&&tx.signer_id===a.accountId&&tx.receiver_id===intent.transaction.receiverId,'WALLET_TRANSACTION_UNKNOWN');
  check(Array.isArray(tx.actions)&&tx.actions.length===1,'WALLET_TRANSACTION_UNKNOWN');const c=tx.actions[0].FunctionCall,p=intent.transaction.actions[0].params;
  check(c&&c.method_name===p.methodName&&String(c.gas)===p.gas&&String(c.deposit)===p.deposit,'WALLET_TRANSACTION_UNKNOWN');
  const expected=b64(new TextEncoder().encode(JSON.stringify(p.args)));check(c.args===expected,'WALLET_TRANSACTION_UNKNOWN');
  const transactionHash=chainHash(tx.hash);clearPending();return {transactionHash};
 });
 const completeRedirect=run(async()=>{
  const u=new URL(win.location.href),pending=readPending(),names=['accountId','account_id','publicKey','public_key','signature','state','transactionHashes','errorCode','errorMessage'];
  const fragment=new URLSearchParams(u.hash.slice(1)),query=u.searchParams;const callbackKeys=names.filter(k=>query.has(k)||fragment.has(k));
  if(!callbackKeys.length)return null;
  let duplicate=false;const pairs=[];for(const k of names){const values=[...query.getAll(k),...fragment.getAll(k)];if(values.length>1)duplicate=true;if(values.length)pairs.push([k,values[0]]);query.delete(k);fragment.delete(k);}
  u.hash=fragment.toString()? '#'+fragment.toString():'';win.history.replaceState({},'',u.toString());check(!duplicate,'WALLET_CALLBACK_INVALID');
  check(pending&&pending.origin===origin&&pending.network==='testnet'&&pending.expiresAt>now()&&u.pathname==='/settings','WALLET_CALLBACK_INVALID');
  const data=Object.fromEntries(pairs);
  if(pending.kind==='challenge'){
   check(data.state===pending.challengeId,'WALLET_CALLBACK_INVALID');
   if(data.errorCode){clearPending();fail('WALLET_REJECTED');}
   const result=signedResult({accountId:data.accountId??data.account_id,publicKey:data.publicKey??data.public_key,signature:data.signature},pending.challengeId,pending.accountId);clearPending();return {kind:'challenge',result};
  }
  check(pending.kind==='transaction'&&data.state===pending.intentId,'WALLET_CALLBACK_INVALID');
  if(data.errorCode)fail('WALLET_TRANSACTION_UNKNOWN');
  check(typeof data.transactionHashes==='string'&&!data.transactionHashes.includes(','),'WALLET_CALLBACK_INVALID');
  const transactionHash=chainHash(data.transactionHashes);clearPending();return {kind:'transaction',intentId:pending.intentId,transactionHash};
 });
 const disconnect=run(async()=>{if(wallet){const c=await connector();await c.disconnect(wallet);}wallet=null;selected=null;connectorPromise=null;clearPending();win.sessionStorage.removeItem(ACCOUNT);});
 return Object.freeze({connect,currentAccount:()=>current(),signChallenge,sendTransaction,completeRedirect,disconnect});
}
