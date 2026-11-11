// Creates a scoped pilot invitation locally. Never prints the bearer credential.
import fs from 'node:fs/promises';
import path from 'node:path';
import {randomBytes,createHash} from 'node:crypto';
const [owner='pilot', countRaw='2'] = process.argv.slice(2);
const count=Number(countRaw);
if(!/^[a-z0-9-]{1,48}$/.test(owner)||!Number.isInteger(count)||count<1||count>10)throw new Error('Expected owner and 1–10 job slots.');
const root=path.resolve('runtime/cloud-access');await fs.mkdir(root,{recursive:true,mode:0o700});
const token=randomBytes(32).toString('base64url');
const grant={owner,tokenHash:createHash('sha256').update(token).digest('hex'),jobIds:Array.from({length:count},()=>randomBytes(16).toString('hex')),issuedAt:Date.now(),expiresAt:Date.now()+86400000};
await fs.writeFile(path.join(root,owner+'.json'),JSON.stringify({token,grant},null,2),{mode:0o600,flag:'wx'});
console.log(`Created ${count} one-shot slots for ${owner}; private invitation saved under runtime/cloud-access. Expires in 24 hours.`);
