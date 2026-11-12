/** Local operator approval CLI. Never expose this command as a public signing API. */
import {parseArgs} from 'node:util';
import {readFileSync,statSync} from 'node:fs';
import {canonical} from '../procurement/codec.mjs';
import {createSelectionVerifier,evidenceBytes,evidenceHash,selectionPayload,signReportOnce} from './selection-verifier.mjs';

function read(path) {
  if (statSync(path).size>16384) throw new Error('Oversized input');
  return readFileSync(path);
}
function json(path) {return JSON.parse(read(path).toString('utf8'));}
try {
  const {values,positionals}=parseArgs({allowPositionals:true,options:{
    job:{type:'string'},payload:{type:'string'},report:{type:'string'},committee:{type:'string'},
    'committee-sha256':{type:'string'},'operator-id':{type:'string'},key:{type:'string'},
    'state-directory':{type:'string'},'allow-local-synthetic':{type:'boolean',default:false},
  }});
  if (positionals.length!==1 || !['sign','verify'].includes(positionals[0])) throw new Error('Command required');
  const committee=json(values.committee),pin=values['committee-sha256'],job=json(values.job),now=Date.now();
  if (committee.operation==='local-synthetic' && !values['allow-local-synthetic']) throw new Error('Local evidence requires explicit opt-in');
  if (positionals[0]==='sign') {
    const payload=json(values.payload);
    const expected=selectionPayload(job,payload.selectedProvider,committee,pin,payload.issuedAtMs);
    if (canonical(payload)!==canonical(expected)) throw new Error('Foreign job or frozen context');
    const signature=signReportOnce(payload,values['operator-id'],values.key,values['state-directory'],committee,pin,now);
    console.log(JSON.stringify(signature));
  } else {
    const raw=read(values.report),report=JSON.parse(raw.toString('utf8'));
    if (!evidenceBytes(report).equals(raw)) throw new Error('Canonical evidence required');
    const verifier=createSelectionVerifier({committee,expectedCommitteeHash:pin,
      allowLocalSynthetic:values['allow-local-synthetic'],loadEvidence:async()=>raw});
    console.log(JSON.stringify({verified:await verifier.verify({job,evidenceHash:evidenceHash(report)}),assurance:verifier.assurance}));
  }
} catch {
  console.error(JSON.stringify({error:'Operator report rejected. No execution or independence claim.'}));
  process.exitCode=2;
}
