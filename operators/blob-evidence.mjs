/** Optional existing private Vercel Blob storage. No service creation or writes
 * occur at import/factory time. This is evidence storage/verification, not MPC.
 */
import {get,put} from '@vercel/blob';
import {hash32} from '../procurement/codec.mjs';
import {createSelectionVerifier,evidenceBytes,evidenceHash} from './selection-verifier.mjs';

const pathname=hash=>{
  if (!hash32(hash)) throw new Error('Invalid evidence hash');
  return `nope-operator-evidence-v1/${hash}.json`;
};
export function blobSelectionEvidence(env=process.env,client={get,put}) {
  return {
    async loadEvidence(hash) {
      const result=await client.get(pathname(hash),{token:env.BLOB_READ_WRITE_TOKEN,access:'private',useCache:false});
      if (!result || result.statusCode!==200) throw new Error('Evidence unavailable');
      const reader=result.stream.getReader(),chunks=[];let size=0;
      try {
        for (;;) {
          const {done,value}=await reader.read();if(done)break;
          size+=value.byteLength;
          if(size>16384){await reader.cancel();throw new Error('Oversized evidence');}
          chunks.push(Buffer.from(value));
        }
      } finally {reader.releaseLock();}
      return Buffer.concat(chunks);
    },
    // Operator-controlled ingestion only. Validate full committee report against
    // the frozen job BEFORE publication. No bidder/browser upload endpoint here.
    async publish(report) {
      const bytes=evidenceBytes(report),hash=evidenceHash(report);
      if(bytes.length>16384)throw new Error('Oversized evidence');
      await client.put(pathname(hash),bytes,{token:env.BLOB_READ_WRITE_TOKEN,access:'private',
        addRandomSuffix:false,allowOverwrite:false,contentType:'application/json'});
      return hash;
    },
  };
}

export function createBlobSelectionVerifier({committee,expectedCommitteeHash,env=process.env,now=Date.now,
  allowLocalSynthetic=false,client={get,put}}) {
  const storage=blobSelectionEvidence(env,client);
  return createSelectionVerifier({committee,expectedCommitteeHash,now,allowLocalSynthetic,loadEvidence:storage.loadEvidence});
}
