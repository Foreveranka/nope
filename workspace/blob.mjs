import {put,get,list} from '@vercel/blob';
export const ROOT='nope-workspace-v1/';
const valid=p=>typeof p==='string'&&/^nope-workspace-v1\/(?:sessions\/[a-f0-9]{64}\.json|clients\/[a-f0-9]{64}\/[0-9]{4}\.json|jobs\/[a-f0-9]{32}\/(?:task|[0-9]{4}|proof-[a-f0-9]{64})\.json|index\/[a-f0-9]{32}\.json|transactions\/[a-f0-9]{64}\.json|escrow\/(?:ops\/[a-f0-9]{64}\/[0-9]{4}\.json|nonces\/[a-f0-9]{64}\/(?:0|[1-9][0-9]{0,19})\.json))$/.test(p);
const MAX=1024*1024;
const bound=path=>path.endsWith('/task.json')?3*MAX:MAX;
export function blobWorkspaceStore(env=process.env,client={put,get,list}){
 const auth=()=>({token:env.BLOB_READ_WRITE_TOKEN});
 const read=async path=>{
  if(!valid(path))throw Error('Invalid path');
  const r=await client.get(path,{...auth(),access:'private',useCache:false});if(!r)return null;
  if(r.statusCode!==200)throw Error('Storage unavailable');
  const reader=r.stream.getReader(),chunks=[];let size=0;
  try{for(;;){const {done,value}=await reader.read();if(done)break;size+=value.byteLength;if(size>bound(path)){await reader.cancel();throw Error('Record bound');}chunks.push(Buffer.from(value));}}finally{reader.releaseLock();}
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
 };
 return {read,async create(path,value){
  if(!valid(path))throw Error('Invalid path');const body=JSON.stringify(value);if(Buffer.byteLength(body)>bound(path))throw Error('Record bound');
  try{await client.put(path,body,{...auth(),access:'private',addRandomSuffix:false,allowOverwrite:false,contentType:'application/json'});return true;}
  catch(e){if(await read(path)!==null)return false;throw e;}
 },async list({prefix=ROOT+'index/',cursor,limit=20}={}){
  if(prefix!==ROOT+'index/'||!Number.isInteger(limit)||limit<1||limit>20||cursor!==undefined&&(typeof cursor!=='string'||cursor.length>2048))throw Error('Invalid listing');
  const r=await client.list({...auth(),prefix,limit,...(cursor?{cursor}:{})});
  if(!Array.isArray(r.blobs)||r.blobs.length>limit||r.blobs.some(b=>!valid(b.pathname)||!b.pathname.startsWith(prefix)))throw Error('Invalid listing');
  return {pathnames:r.blobs.map(b=>b.pathname),cursor:r.hasMore?r.cursor:null};
 }};
}
