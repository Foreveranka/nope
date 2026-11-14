/** Explicit server secret configuration; value travels only through child stdin. */
import {spawnSync} from 'node:child_process';
import {admissionKey,publicWrite} from './provision.mjs';
if(!process.argv.includes('--apply'))throw Error('EXPLICIT_APPLY_REQUIRED');
const key=admissionKey(),results=[];
for(const environment of ['production','preview']){
 const r=spawnSync('vercel',['env','add','NOPE_WALLET_ADMISSION_KEY',environment,'--sensitive','--force','--yes','--non-interactive'],{input:key.privateKeyBase64+'\n',encoding:'utf8',maxBuffer:1024*1024});
 if(r.status!==0){console.error('ADMISSION_ENV_FAILED environment='+environment+' exit='+r.status);process.exit(1);}
 results.push({environment,configured:true,sensitive:true,transport:'subprocess stdin',valueLogged:false});
}
publicWrite('server-env-public.json',{name:'NOPE_WALLET_ADMISSION_KEY',publicKey:key.publicKey,configuredAt:new Date().toISOString(),results});
console.log(JSON.stringify({name:'NOPE_WALLET_ADMISSION_KEY',results}));
