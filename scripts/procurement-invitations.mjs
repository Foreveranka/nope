// Offline bootstrap: output private invitation files, never print credentials.
import fs from 'node:fs/promises';
import path from 'node:path';
import {randomBytes,createHash} from 'node:crypto';
const root=path.resolve('runtime/procurement-invitations');
const args=process.argv.slice(2);
if(args.length!==1){console.error('Usage: node scripts/procurement-invitations.mjs roster.json');process.exit(2);}
const input=JSON.parse(await fs.readFile(args[0],'utf8'));
if(!Array.isArray(input)||input.length<4||input.length>30)throw new Error('Expected 4–30 identities');
const seen=new Set(),accounts=[];
for(const row of input){if(Object.keys(row).sort().join(',')!=='principal,role'||!['buyer','provider','operator'].includes(row.role)||typeof row.principal!=='string'||row.principal.length<2||row.principal.length>64||!/^[a-z0-9]+(?:[._-][a-z0-9]+)*$/.test(row.principal)||seen.has(row.principal))throw new Error('Invalid or duplicate invitation identity');seen.add(row.principal);accounts.push(row);}
await fs.mkdir(path.dirname(root),{recursive:true,mode:0o700});await fs.mkdir(root,{mode:0o700}); // Refuse accidental replacement of existing invitations.
const expiresAt=Date.now()+6*86400*1000,grants=[];
for(const {principal,role}of accounts){const token=randomBytes(32).toString('base64url');grants.push({tokenHash:createHash('sha256').update(token).digest('hex'),principal,role,expiresAt});await fs.writeFile(path.join(root,principal+'.json'),JSON.stringify({principal,role,token,expiresAt},null,2)+'\n',{mode:0o600,flag:'wx'});}
await fs.writeFile(path.join(root,'grants.json'),JSON.stringify(grants),{mode:0o600,flag:'wx'});
console.log('Private invitations created under runtime/procurement-invitations. Tokens were not printed. Configure only grants.json as NOPE_PROCUREMENT_GRANTS. These are app invitations, not proof of NEAR account ownership.');
