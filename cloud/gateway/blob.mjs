import {put,get,del,issueSignedToken,presignUrl} from '@vercel/blob';
import {readBounded} from './core.mjs';
export function blobStore(env=process.env) {
  const auth = () => ({token:env.BLOB_READ_WRITE_TOKEN});
  const read = async path => {
    const result = await get(path,{...auth(),access:'private',useCache:false});
    if (!result) return null;
    if (result.statusCode !== 200) throw new Error('Unexpected storage response');
    return JSON.parse((await readBounded(result.stream,1500000)).toString('utf8'));
  };
  return {
    read,
    async create(path,value) {
      try { await put(path,JSON.stringify(value),{...auth(),access:'private',addRandomSuffix:false,allowOverwrite:false,contentType:'application/json',ttlDays:7}); return true; }
      catch(error) { if(await read(path) !== null) return false; throw error; }
    },
    async sign(path,operation,{size,expiresAt}) {
      const contentType=path.endsWith('.json')?'application/json':'application/octet-stream';
      const limits = operation==='put'?{maximumSizeInBytes:size,allowedContentTypes:[contentType]} : {};
      const token = await issueSignedToken({...auth(),pathname:path,operations:[operation],validUntil:expiresAt,...limits});
      const options = operation==='put'?{...limits,allowOverwrite:false,addRandomSuffix:false,ttlDays:1}: {useCache:false};
      return (await presignUrl(token,{pathname:path,operation,access:'private',...options})).presignedUrl;
    },
    remove:paths => del(paths,auth()),
  };
}
