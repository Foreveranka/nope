/** Synthetic frozen real-model proposal -> actual encrypted evaluator HTTP.
 * This reuses native neural output; browser inference is verified separately.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import {acceptAgentProposal,privatePlanInputs,applyAgentOutput} from '../web/agent-plan.mjs';
import {preparePlan,decodePlan} from '../web/plan-client.mjs';
import {parseCSV} from '../web/csv-input.mjs';
const origin=process.argv[2]||'http://127.0.0.1:8773';
if(!['http://127.0.0.1:8773','https://veil-procurement.vercel.app'].includes(origin))throw Error('Synthetic verification origin not approved');
const generation=JSON.parse(await fs.readFile(new URL('../planner-runtime/evidence/approved-38ce0d9/generation-evidence.json',import.meta.url),'utf8'));
assert.equal(generation.actualNeuralInference,true);
const selected=generation.results.find(r=>r.id==='holdout-english');assert.equal(selected.passed,true);
const accepted=await acceptAgentProposal(selected.task,selected.raw);
const dataset=parseCSV('record,private_supplier,private_score,private_note\nR01,"  ACME  ",,"İstanbul, preserve"\nR02," BETA42 ",200,keep\nR03,Gamma7,42,unchanged\n');
const start=performance.now(),prepared=await preparePlan(privatePlanInputs(dataset,accepted.plan),accepted.plan),body=JSON.stringify(prepared.request);
for(const secret of ['private_supplier','private_note','ACME','BETA42','İstanbul','decoder','outputPairs'])assert.equal(body.includes(secret),false,secret);
const r=await fetch(origin+'/api/plan-gc',{method:'POST',headers:{origin,'content-type':'application/json'},body});const reply=await r.json();assert.equal(r.status,200,JSON.stringify(reply));
const decoded=await decodePlan(reply,prepared.decoder),output=applyAgentOutput(dataset,accepted.plan,decoded);
assert.deepEqual(output.rows,[['R01','ACME','10','İstanbul, preserve'],['R02','BETA42','80','keep'],['R03','GAMMA7','42','unchanged']]);
const evidence={recordedAt:new Date().toISOString(),origin,syntheticOnly:true,realNativeModelProposal:true,browserInference:false,model:{id:generation.model,revision:generation.revision},task:selected.task,plan:accepted.plan,planSha256:accepted.planSha256,inputBytes:Buffer.byteLength(body),elapsedMs:Math.round(performance.now()-start),checks:{noPlaintextInRequest:true,actualHTTP:true,localDecode:true,fullCSVPreserved:true},inputSha256:reply.inputSha256,outputSha256:reply.outputSha256,programSha256:reply.programSha256,executionProof:false};
if(process.argv[3])await fs.writeFile(process.argv[3],JSON.stringify(evidence,null,2)+'\n');console.log(JSON.stringify(evidence,null,2));
