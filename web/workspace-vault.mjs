/** Browser-only prototype vault. IndexedDB stores nonextractable WebCrypto keys
 * and AES-256-GCM encrypted JSON; no CSV, filename, columns, values or budget is
 * sent anywhere by this module. sessionId is the stable local user namespace.
 * This assumes an honest browser and authenticated, uncompromised application:
 * same-origin malicious JS can USE these keys and read plaintext. This is not a
 * password vault, XSS defense, backup service, execution proof or wallet. Clearing
 * site storage loses access permanently. Payment belongs exclusively to testNEAR;
 * these RSA keys encrypt quotes, never sign transactions or represent wallets.
 */
import { cryptoProvider, fromBase64, sha256 } from './gc-core.mjs';
import { restoreGarbledJob } from './gc-client.mjs';
import { PROFILE as RECIPE_PROFILE, validateRecipeRequest, hashRecipeRequest, hashRecipeProgram, exactKeys, denseArray } from './recipe-core.mjs';
import { decodeRecipe } from './recipe-client.mjs';
import { PROFILE as PLAN_PROFILE, validatePlanRequest, hashPlan, hashPlanRequest, hashPlanProgram } from './plan-core.mjs';
import { decodePlan } from './plan-client.mjs';

const utf8 = new TextEncoder();
const text = new TextDecoder('utf-8',{fatal:true});
const DB_NAME = 'workspace-vault-v1', STORE = 'records';
const QUOTE_AAD = utf8.encode('workspace-vault/quote/v1');
const fail = message => { throw new Error(message); };
function id(value) {
  if (typeof value !== 'string' || !value.length || value.length > 1024) fail('A nonempty local identifier is required.');
  return value;
}
function b64(bytes) {
  let binary = '';
  for (let i=0;i<bytes.length;i+=8192) binary += String.fromCharCode(...bytes.subarray(i,i+8192));
  return btoa(binary);
}
function bytes(value, min=16, max=16*1024*1024) {
  if (typeof value !== 'string' || value.length > Math.ceil(max/3)*4 || !/^[A-Za-z0-9+/]*={0,2}$/.test(value)) fail('Invalid encrypted base64 payload.');
  const decoded = Uint8Array.from(atob(value),c=>c.charCodeAt(0));
  if (decoded.length < min || decoded.length > max) fail('Invalid encrypted payload length.');
  // Garbled text jobs can exceed 1 MiB. The label helper's spread-based
  // re-encoding is safe for small labels, not a complete encrypted job record.
  if (b64(decoded) !== value) fail('Invalid canonical encrypted base64.');
  return decoded;
}
function object(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail('Expected a JSON object.');
  return value;
}
function envelope(value, wrapped=false) {
  object(value);
  if (Object.keys(value).sort().join(',') !== (wrapped ? 'ciphertext,iv,wrappedKey' : 'ciphertext,iv')) fail('Invalid encrypted envelope fields.');
  return {iv:fromBase64(value.iv,12),ciphertext:bytes(value.ciphertext),...(wrapped ? {wrappedKey:fromBase64(value.wrappedKey,256)} : {})};
}
async function seal(key, value, aad) {
  const encoded = JSON.stringify(value);
  if (encoded === undefined) fail('Expected JSON data.');
  const crypto = cryptoProvider(), iv = crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = await crypto.subtle.encrypt({name:'AES-GCM',iv,additionalData:aad},key,utf8.encode(encoded));
  return {iv:b64(iv),ciphertext:b64(new Uint8Array(ciphertext))};
}
async function open(key, value, aad) {
  const {iv,ciphertext} = envelope(value);
  return JSON.parse(text.decode(await cryptoProvider().subtle.decrypt({name:'AES-GCM',iv,additionalData:aad},key,ciphertext)));
}

/** Exact decimal testNEAR -> yoctoNEAR. Strings only; no floating point. */
export function parseNearAmount(value) {
  if (typeof value !== 'string' || !/^(0|[1-9]\d*)(?:\.\d{1,24})?$/.test(value)) fail('Expected a nonnegative NEAR decimal with at most 24 fractional digits.');
  const [whole,fraction=''] = value.split('.');
  return BigInt(whole)*10n**24n + BigInt(fraction.padEnd(24,'0'));
}
function yocto(value) {
  if (typeof value === 'bigint' && value >= 0n) return value.toString();
  if (typeof value !== 'string' || !/^(0|[1-9]\d*)$/.test(value)) fail('Expected a canonical nonnegative yoctoNEAR integer string or BigInt.');
  return value;
}
/** Exact yoctoNEAR -> decimal NEAR, trimming trailing fractional zeroes. */
export function formatNearAmount(value) {
  const amount = BigInt(yocto(value)), scale = 10n**24n;
  const fraction = (amount%scale).toString().padStart(24,'0').replace(/0+$/,'');
  return (amount/scale).toString() + (fraction ? '.'+fraction : '');
}
/** 32 random bytes, 64 lowercase hex characters. */
export function randomSalt() {
  return Array.from(cryptoProvider().getRandomValues(new Uint8Array(32)),b=>b.toString(16).padStart(2,'0')).join('');
}
export async function quoteCommitment(jobId,providerId,amountYocto,salt) {
  id(jobId); id(providerId);
  // Backend commits to strings, including amount. Normalize BigInt without floats.
  const amount = yocto(amountYocto);
  if (typeof salt !== 'string' || !/^[0-9a-f]{64}$/.test(salt)) fail('Expected a 32-byte lowercase hex salt.');
  return sha256(JSON.stringify([jobId,providerId,amount,salt]));
}

/** Native IndexedDB adapter. installKeys uses ONE readwrite transaction to avoid
 * competing tabs overwriting keys. Resolve writes only after transaction commit.
 * No fallback to ephemeral memory or localStorage when persistence fails.
 */
function indexedStorage() {
  let connection;
  function db() {
    if (!connection) connection = new Promise((resolve,reject)=> {
      if (!globalThis.indexedDB) return reject(new Error('IndexedDB is required for the local vault.'));
      const request = globalThis.indexedDB.open(DB_NAME,1);
      request.onupgradeneeded = ()=>request.result.createObjectStore(STORE);
      request.onerror = ()=>reject(request.error);
      request.onblocked = ()=>reject(new Error('Vault database upgrade is blocked.'));
      request.onsuccess = ()=> {
        const database = request.result;
        database.onversionchange = ()=>{ database.close(); connection=undefined; };
        resolve(database);
      };
    });
    return connection;
  }
  async function transaction(mode,work) {
    const database = await db();
    return new Promise((resolve,reject)=> {
      const tx = database.transaction(STORE,mode), store = tx.objectStore(STORE);
      let result;
      tx.oncomplete = ()=>resolve(result);
      tx.onabort = ()=>reject(tx.error || new Error('Vault transaction aborted.'));
      tx.onerror = ()=>{}; // transaction abort supplies the final error
      try { work(store,value=>{result=value;}); } catch(error) { tx.abort(); reject(error); }
    });
  }
  return {
    get: key=>transaction('readonly',(store,done)=> { const r=store.get(key); r.onsuccess=()=>done(r.result); }),
    put: (key,value)=>transaction('readwrite',store=>store.put(value,key)),
    installKeys: (key,candidate)=>transaction('readwrite',(store,done)=> {
      const r=store.get(key);
      r.onsuccess=()=> { if (r.result) done(r.result); else {store.put(candidate,key);done(candidate);} };
    }),
    deleteSession: sessionId=>transaction('readwrite',store=> {
      const r=store.openCursor();
      r.onsuccess=()=> {
        const cursor=r.result;
        if (!cursor) return;
        if (Array.isArray(cursor.key) && cursor.key[0] === sessionId) cursor.delete();
        cursor.continue();
      };
    }),
  };
}
async function newKeys() {
  const crypto = cryptoProvider();
  const aes = await crypto.subtle.generateKey({name:'AES-GCM',length:256},false,['encrypt','decrypt']);
  const rsa = await crypto.subtle.generateKey({name:'RSA-OAEP',modulusLength:2048,publicExponent:new Uint8Array([1,0,1]),hash:'SHA-256'},false,['encrypt','decrypt']);
  return {aes,privateKey:rsa.privateKey,publicKey:rsa.publicKey};
}
function validateKeys(keys) {
  if (keys?.aes?.type !== 'secret' || keys.aes.extractable !== false || keys.aes.algorithm?.name !== 'AES-GCM' || keys.aes.algorithm.length !== 256 || !['encrypt','decrypt'].every(x=>keys.aes.usages.includes(x)) || keys.privateKey?.type !== 'private' || keys.privateKey.extractable !== false || keys.privateKey.algorithm?.name !== 'RSA-OAEP' || keys.privateKey.algorithm.modulusLength !== 2048 || keys.privateKey.algorithm.hash?.name !== 'SHA-256' || !keys.privateKey.usages.includes('decrypt') || keys.publicKey?.type !== 'public') fail('Invalid local vault keys.');
  return keys;
}

/** Synchronous factory; every returned method is async. No raw key is exposed.
 * Optional {storage} is for tests ONLY: get(key), put(key,value), atomic
 * installKeys(key,candidate), deleteSession(sessionId). The adapter must implement
 * structured clone and atomic install; memory tests do not prove IDB durability.
 * Records are indexed by [sessionId,kind,jobId]; AAD binds ciphertext to that key.
 */
export function createVault(sessionId,{storage}={}) {
  id(sessionId);
  const store = storage ?? indexedStorage();
  const keyId = [sessionId,'keys'];
  // Read every time, including after clear() from a different tab/vault instance.
  async function keys() {
    const saved = await store.get(keyId);
    return validateKeys(saved ?? await store.installKeys(keyId,await newKeys()));
  }
  const recordId = (kind,jobId)=>[sessionId,kind,id(jobId)];
  const aad = record=>utf8.encode(JSON.stringify(['workspace-vault',1,...record]));
  async function save(kind,jobId,data) {
    const record=recordId(kind,jobId), {aes}=await keys();
    await store.put(record,await seal(aes,data,aad(record)));
  }
  async function load(kind,jobId) {
    const record=recordId(kind,jobId), saved=await store.get(record);
    if (saved === undefined) return null;
    const {aes}=await keys();
    return open(aes,saved,aad(record));
  }
  return {
    async buyerPublicKey() {
      return cryptoProvider().subtle.exportKey('jwk',(await keys()).publicKey);
    },
    async encryptQuote(publicJwk,quoteObject) {
      object(quoteObject); object(publicJwk);
      if (publicJwk.kty !== 'RSA' || ['d','p','q','dp','dq','qi','oth'].some(field=>publicJwk[field] !== undefined) || (publicJwk.alg !== undefined && publicJwk.alg !== 'RSA-OAEP-256')) fail('Expected a public RSA-OAEP SHA-256 JWK.');
      const crypto = cryptoProvider();
      const publicKey = await crypto.subtle.importKey('jwk',publicJwk,{name:'RSA-OAEP',hash:'SHA-256'},false,['encrypt']);
      if (publicKey.algorithm.modulusLength !== 2048 || Array.from(publicKey.algorithm.publicExponent).join(',') !== '1,0,1') fail('Expected RSA-2048 with exponent 65537.');
      // Only one-use transport AES bytes exist briefly so RSA can wrap them.
      // The persistent vault AES key and buyer RSA private key never export.
      const raw = crypto.getRandomValues(new Uint8Array(32));
      try {
        const key = await crypto.subtle.importKey('raw',raw,{name:'AES-GCM'},false,['encrypt']);
        const wrapped = await crypto.subtle.encrypt({name:'RSA-OAEP'},publicKey,raw);
        return {wrappedKey:b64(new Uint8Array(wrapped)),...await seal(key,quoteObject,QUOTE_AAD)};
      } finally { raw.fill(0); }
    },
    async decryptQuote(value) {
      const {iv,ciphertext,wrappedKey}=envelope(value,true), crypto=cryptoProvider();
      const raw=new Uint8Array(await crypto.subtle.decrypt({name:'RSA-OAEP'},(await keys()).privateKey,wrappedKey));
      try {
        if (raw.length !== 32) fail('Invalid quote transport key.');
        const key=await crypto.subtle.importKey('raw',raw,{name:'AES-GCM'},false,['decrypt']);
        return object(JSON.parse(text.decode(await crypto.subtle.decrypt({name:'AES-GCM',iv,additionalData:QUOTE_AAD},key,ciphertext))));
      } finally { raw.fill(0); }
    },
    async saveJob(jobId,data) { await save('job',jobId,object(data)); },
    async loadJob(jobId) { return load('job',jobId); },
    async saveDecoder(jobId,job) {
      id(jobId);
      if (job?.request?.profile === PLAN_PROFILE) {
        validatePlanRequest(job.request);
        const decoder = object(job.decoder);
        if (decoder.profile !== PLAN_PROFILE || decoder.nonce !== job.request.nonce || decoder.rowCount !== job.request.rowCount ||
            decoder.inputSha256 !== await hashPlanRequest(job.request) || decoder.programSha256 !== await hashPlanProgram(job.request.plan) ||
            decoder.planSha256 !== await hashPlan(job.request.plan) || job.request.planSha256 !== decoder.planSha256 ||
            JSON.stringify(decoder.plan) !== JSON.stringify(job.request.plan)) fail('Plan decoder does not match the prepared request.');
        denseArray(decoder.tasks,job.request.tasks.length);
        for (let i=0;i<job.request.tasks.length;i++) {
          const mapped=decoder.tasks[i],task=job.request.tasks[i]; exactKeys(mapped,['column','decoder']);
          const d=object(mapped.decoder),request=task.request;
          if (mapped.column !== task.column || d.profile !== RECIPE_PROFILE || d.nonce !== request.nonce || d.rowCount !== request.rowCount ||
              d.inputSha256 !== await hashRecipeRequest(request) || d.programSha256 !== await hashRecipeProgram(request.recipe) ||
              request.programSha256 !== d.programSha256 || JSON.stringify(d.recipe) !== JSON.stringify(request.recipe)) fail('Mapped plan decoder does not match the prepared request.');
        }
        await save('decoder',jobId,{kind:'plan-v3',decoder});
        const restored = await load('decoder',jobId);
        if (JSON.stringify(restored?.decoder) !== JSON.stringify(decoder)) fail('Plan decoder storage verification failed.');
        return;
      }
      if (job?.request?.profile === RECIPE_PROFILE) {
        validateRecipeRequest(job.request);
        const decoder = object(job.decoder);
        if (decoder.profile !== RECIPE_PROFILE || decoder.nonce !== job.request.nonce || decoder.rowCount !== job.request.rowCount ||
            decoder.inputSha256 !== await hashRecipeRequest(job.request) || decoder.programSha256 !== await hashRecipeProgram(job.request.recipe) ||
            JSON.stringify(decoder.recipe) !== JSON.stringify(job.request.recipe)) fail('Recipe decoder does not match the prepared request.');
        // The plain JSON output pairs are secrets. Reuse the vault AES record
        // encryption and session/job AAD; they never enter a network payload.
        await save('decoder',jobId,{kind:'recipe-v2',decoder});
        const restored = await load('decoder',jobId);
        if (JSON.stringify(restored?.decoder) !== JSON.stringify(decoder)) fail('Recipe decoder storage verification failed.');
        return;
      }
      if (typeof job?.sealDecoder !== 'function') fail('Expected a garbled job with sealDecoder.');
      await save('decoder',jobId,await job.sealDecoder((await keys()).aes));
    },
    async decodeDelivery(jobId,outputs) {
      const sealed=await load('decoder',jobId);
      if (!sealed) fail('No local decoder for this job. Restore requires the original browser storage.');
      if (sealed.kind === 'recipe-v2' || sealed.kind === 'plan-v3') {
        const {profile,nonce,rowCount,inputSha256,programSha256,outputSha256,outputs:labels} = object(outputs);
        return (sealed.kind === 'plan-v3' ? decodePlan : decodeRecipe)({profile,nonce,rowCount,inputSha256,programSha256,outputSha256,outputs:labels},sealed.decoder);
      }
      const job=await restoreGarbledJob(sealed,(await keys()).aes);
      return job.decode(Array.isArray(outputs) ? outputs : outputs.outputs);
    },
    async clear() { await store.deleteSession(sessionId); },
  };
}
