import {put,get,list} from '@vercel/blob';

const ROOT='nope-procurement-v1/';
const validPath=path=>typeof path==='string' && (new RegExp('^'+ROOT+'(?:jobs/[0-9a-f]{32}/revisions/[0-9]{3}\\.json|participants/[0-9a-f]{64}/[0-9a-f]{32}\\.json)$')).test(path);
const validPrefix=prefix=>typeof prefix==='string' && (new RegExp('^'+ROOT+'participants/[0-9a-f]{64}/$')).test(prefix);
async function readJSON(stream) {
  const reader=stream.getReader();const chunks=[];let size=0;
  try {for(;;){const {done,value}=await reader.read();if(done)break;size+=value.byteLength;if(size>65536){await reader.cancel();throw new Error('Storage record too large');}chunks.push(Buffer.from(value));}}
  finally{reader.releaseLock();}
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}
/** Private immutable application ledger. No TTL, plaintext upload, signing or delete API. */
export function blobProcurementStore(env=process.env,client={put,get,list}) {
  const auth=()=>({token:env.BLOB_READ_WRITE_TOKEN});
  const read=async path=>{
    if(!validPath(path))throw new Error('Invalid procurement path');
    const result=await client.get(path,{...auth(),access:'private',useCache:false});
    if(!result)return null;
    if(result.statusCode!==200)throw new Error('Unknown storage response');
    return readJSON(result.stream);
  };
  return {
    read,
    async create(path,value){
      if(!validPath(path))throw new Error('Invalid procurement path');
      const body=JSON.stringify(value);
      if(Buffer.byteLength(body)>65536)throw new Error('Storage record too large');
      try{
        await client.put(path,body,{...auth(),access:'private',addRandomSuffix:false,allowOverwrite:false,contentType:'application/json'});
        return true;
      }catch(error){
        // Readback distinguishes an occupied CAS slot; caller compares exact operation.
        // Readback failure/absence propagates an unknown outcome, never a false success.
        if(await read(path)!==null)return false;
        throw error;
      }
    },
    async list({prefix,limit,cursor}){
      if(!validPrefix(prefix)||!Number.isInteger(limit)||limit<1||limit>20|| (cursor!==undefined&&(typeof cursor!=='string'||cursor.length>2048)))throw new Error('Invalid constrained listing');
      const result=await client.list({...auth(),prefix,limit,...(cursor?{cursor}:{})});
      if(!Array.isArray(result.blobs)||result.blobs.length>limit||result.blobs.some(b=>!validPath(b.pathname)||!b.pathname.startsWith(prefix)))throw new Error('Invalid storage listing');
      return {pathnames:result.blobs.map(b=>b.pathname),cursor:result.hasMore?result.cursor:null};
    },
  };
}
