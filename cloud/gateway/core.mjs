import { createHash, timingSafeEqual } from 'node:crypto';

export const sha256 = value => createHash('sha256').update(value).digest('hex');
const HEX = /^[0-9a-f]{64}$/;
const ID = /^[0-9a-f]{32}$/;
const LIMITS = { 'request.json': 8192, 'binding.json': 8192, 'request.bin': 2097152, 'evaluation.keys': 536870912 };
const BODY_LIMIT = 16384;
class HttpError extends Error { constructor(status, message) { super(message); this.status = status; } }
const reject = (status, message) => { throw new HttpError(status, message); };
const exact = (x, keys) => x && typeof x === 'object' && !Array.isArray(x) && Object.keys(x).sort().join('|') === [...keys].sort().join('|');
export async function readBounded(stream, limit) {
  const reader = stream.getReader(); const chunks = []; let size = 0;
  try { for (;;) { const {done, value} = await reader.read(); if (done) break; size += value.length;
    if (size > limit) { await reader.cancel(); reject(413, 'Payload too large.'); } chunks.push(Buffer.from(value));
  }} finally { reader.releaseLock(); }
  return Buffer.concat(chunks);
}
function authenticate(request, env, now) {
  const header = request.headers.get('authorization') || '';
  if (!/^Bearer [A-Za-z0-9_-]{43,128}$/.test(header)) reject(401, 'Access invitation required.');
  let grants; try { grants = JSON.parse(env.VEIL_ACCESS_GRANTS || '[]'); } catch { reject(503, 'Access configuration unavailable.'); }
  if (!Array.isArray(grants) || grants.length > 100) reject(503, 'Access configuration unavailable.');
  const digest = Buffer.from(sha256(header.slice(7)), 'hex');
  for (const grant of grants) {
    if (!HEX.test(grant.tokenHash || '') || !timingSafeEqual(digest, Buffer.from(grant.tokenHash, 'hex'))) continue;
    if (!/^[a-z0-9-]{1,48}$/.test(grant.owner || '') || !Array.isArray(grant.jobIds) || grant.jobIds.length > 50 ||
      grant.jobIds.some(id => !ID.test(id)) || !Number.isSafeInteger(grant.expiresAt) || !Number.isSafeInteger(grant.issuedAt) || grant.issuedAt > now + 30000 || grant.expiresAt <= grant.issuedAt || grant.expiresAt - grant.issuedAt > 6 * 86400000) reject(503, 'Access configuration unavailable.');
    if (grant.expiresAt <= now) reject(401, 'Access invitation expired.');
    return grant;
  }
  reject(401, 'Access invitation invalid.');
}
function descriptors(body) {
  if (!exact(body, ['jobId', 'files', 'requestManifestSha256']) || !ID.test(body.jobId || '') || !HEX.test(body.requestManifestSha256 || '')) reject(400, 'Invalid encrypted job.');
  if (!Array.isArray(body.files) || ![3,4].includes(body.files.length)) reject(400, 'Invalid file set.');
  const names = new Set();
  for (const f of body.files) {
    if (!exact(f, ['name','size','sha256']) || !Object.hasOwn(LIMITS,f.name) || names.has(f.name) || !HEX.test(f.sha256 || '') || !Number.isSafeInteger(f.size) || f.size < 1 || f.size > LIMITS[f.name]) reject(400, 'Invalid encrypted file descriptor.');
    names.add(f.name);
  }
  if (!['request.json','request.bin','evaluation.keys'].every(name => names.has(name)) || body.files.find(f => f.name === 'request.json').sha256 !== body.requestManifestSha256) reject(400, 'Missing or mismatched request.');
  return body.files.map(({name,size,sha256})=>({name,size,sha256})).sort((a,b) => a.name.localeCompare(b.name));
}
export function createGateway({store, env = process.env, fetcher = fetch, now = Date.now}) {
  const response = (data, status=200) => Response.json(data, {status, headers:{'Cache-Control':'no-store','X-Content-Type-Options':'nosniff'}});
  return async request => {
    try {
      const path = new URL(request.url).pathname.replace(/\/$/, '');
      // No cookie authentication, no CORS. Hosted browser and local companion use explicit bearer invitations.
      const origin = request.headers.get('origin');
      if (origin && origin !== env.VEIL_PUBLIC_ORIGIN) reject(403, 'Origin denied.');
      if (path === '/api/cloud/health' && request.method === 'GET') return response({ok:true, version:'0.2.0', encryptedEvaluationConfigured:Boolean(env.VEIL_WORKER_URL && env.VEIL_WORKER_TOKEN), paymentsEnabled:false, independentOperators:false});
      const grant = authenticate(request, env, now());
      if (path === '/api/cloud/session' && request.method === 'GET') return response({owner:grant.owner, expiresAt:grant.expiresAt, jobIds:grant.jobIds, profile:'clean-4-records-v1', plaintextLocation:'customer-companion', paymentsEnabled:false});
      const root = `veil-v1/${grant.owner}/`;
      const match = /^\/api\/cloud\/jobs\/([0-9a-f]{32})(?:\/(evaluate|result))?$/.exec(path);
      let body;
      if (request.method === 'POST') {
        if (!(request.headers.get('content-type') || '').startsWith('application/json')) reject(415, 'JSON required.');
        try { body = JSON.parse((await readBounded(request.body, BODY_LIMIT)).toString('utf8')); } catch(e) { if(e instanceof HttpError) throw e; reject(400,'Invalid JSON.'); }
      }
      if (path === '/api/cloud/jobs' && request.method === 'POST') {
        const files = descriptors(body);
        if (!grant.jobIds.includes(body.jobId)) reject(404, 'Job not found.');
        if (!env.VEIL_WORKER_URL || !env.VEIL_WORKER_TOKEN) reject(503, 'Encrypted evaluator not configured.');
        const prefix = root + body.jobId + '/';
        const metadata = {jobId:body.jobId, requestManifestSha256:body.requestManifestSha256, files};
        const existing = await store.read(prefix+'job.json');
        if (existing && JSON.stringify(existing) !== JSON.stringify(metadata)) reject(409, 'Job already bound to another encrypted request.');
        if (!existing && !await store.create(prefix+'job.json', metadata)) {
          const raced = await store.read(prefix+'job.json');
          if (JSON.stringify(raced) !== JSON.stringify(metadata)) reject(409, 'Job already bound to another encrypted request.');
        }
        if (await store.read(prefix+'claim.json')) reject(409, 'Evaluation already claimed; retrieve its status.');
        const uploads = [];
        for (const file of files) uploads.push({...file, url:await store.sign(prefix+file.name, 'put', {size:file.size, expiresAt:Math.min(grant.expiresAt, now()+900000)})});
        return response({jobId:body.jobId, uploads}, 201);
      }
      if (!match || !grant.jobIds.includes(match[1])) reject(404, 'Job not found.');
      const prefix = root + match[1] + '/';
      const metadata = await store.read(prefix+'job.json');
      if (!metadata) reject(404, 'Job not found.');
      const result = await store.read(prefix+'result.json');
      if (match[2] === 'result' && request.method === 'GET') {
        if (!result) reject(409, 'No completed encrypted result.');
        return response(result);
      }
      if (!match[2] && request.method === 'GET') {
        const failure = await store.read(prefix+'failure.json');
        const claim = await store.read(prefix+'claim.json');
        return response({jobId:match[1], status:result?'COMPLETED':failure?'FAILED_OR_UNKNOWN':claim?'RUNNING_OR_UNKNOWN':'AWAITING_UPLOAD', requestManifestSha256:metadata.requestManifestSha256});
      }
      if (match[2] !== 'evaluate' || request.method !== 'POST') reject(405, 'Method not allowed.');
      if (!exact(body, [])) reject(400, 'Expected empty object.');
      if (result) return response({jobId:match[1],status:'COMPLETED'});
      const url = new URL(env.VEIL_WORKER_URL || 'https://invalid.invalid');
      if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash || (url.port && url.port !== '443') || !env.VEIL_WORKER_TOKEN) reject(503, 'Encrypted evaluator not configured.');
      // Blob create-if-absent is the durable one-shot fence, including uncertain network outcomes.
      if (!await store.create(prefix+'claim.json', {claimedAt:now()})) reject(409, 'Evaluation already claimed; no automatic retry.');
      try {
        const files = [];
        for (const file of metadata.files) files.push({...file,url:await store.sign(prefix+file.name,'get',{expiresAt:Math.min(grant.expiresAt,now()+300000)})});
        const reply = await fetcher(new URL('/evaluate',url),{method:'POST',redirect:'error',headers:{'Authorization':`Bearer ${env.VEIL_WORKER_TOKEN}`,'Content-Type':'application/json'},body:JSON.stringify({files,requestManifestSha256:metadata.requestManifestSha256}),signal:AbortSignal.timeout(240000)});
        if (!reply.ok) throw new Error('Worker rejected');
        const bytes = await readBounded(reply.body, 1500000);
        const output = JSON.parse(bytes.toString('utf8'));
        if (!exact(output,['receipt','receiptBase64','outputBase64','receiptSha256','outputSha256']) || typeof output.outputBase64 !== 'string' || typeof output.receiptBase64 !== 'string' || !/^[A-Za-z0-9+/]*={0,2}$/.test(output.outputBase64) || !/^[A-Za-z0-9+/]*={0,2}$/.test(output.receiptBase64) || !HEX.test(output.outputSha256||'') || !HEX.test(output.receiptSha256||'') || output.receipt?.requestManifestSha256 !== metadata.requestManifestSha256 || output.receipt?.outputSha256 !== output.outputSha256 || sha256(Buffer.from(output.outputBase64,'base64')) !== output.outputSha256 || sha256(Buffer.from(output.receiptBase64,'base64')) !== output.receiptSha256 || JSON.stringify(JSON.parse(Buffer.from(output.receiptBase64,'base64').toString('utf8'))) !== JSON.stringify(output.receipt)) throw new Error('Invalid worker response');
        await store.create(prefix+'result.json',output);
        return response({jobId:match[1],status:'COMPLETED'});
      } catch {
        await store.create(prefix+'failure.json',{failedAt:now(),status:'FAILED_OR_UNKNOWN'});
        reject(502,'Evaluation failed or its outcome is unknown. This job will not be replayed.');
      } finally {
        // Input/key TTL is a backup if the function is terminated before finally.
        await store.remove(metadata.files.map(f=>prefix+f.name)).catch(()=>{});
      }
    } catch(error) { return response({error:error instanceof HttpError?error.message:'Service temporarily unavailable.'},error instanceof HttpError?error.status:503); }
  };
}
