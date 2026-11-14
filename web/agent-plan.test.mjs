import test from 'node:test';import assert from 'node:assert/strict';
import {publicTask,publicTaskHash,parsePlannerJSON,acceptAgentProposal,privatePlanInputs,applyAgentOutput} from './agent-plan.mjs';
import {parseCSV} from './csv-input.mjs';
const task={version:1,goal:'Trim and lowercase C2; fill missing C3 with 0 then clamp to 100.',columns:[{id:'C2',type:'text'},{id:'C3',type:'number'}]};
const proposal={steps:[{column:'C2',recipe:{type:'text',steps:[{op:'trim'},{op:'lowercase'}]}},{column:'C3',recipe:{type:'number',steps:[{op:'fill',value:0},{op:'clamp',min:0,max:100}]}}]};
test('planner receives only public brief and anonymous typed schema; metadata and getters fail closed',()=>{
 const seen=[];for(const key of ['headers','rows','filename','budget','decoder','samples','token'])assert.throws(()=>publicTask({...task,[key]:'private'}));
 assert.throws(()=>publicTask({...task,columns:[{id:'C2',type:'text',name:'Secret customer'}]}));
 const item={id:'C2',type:'text'};Object.defineProperty(item,'secret',{get(){seen.push(1);return 'private';},enumerable:true});assert.throws(()=>publicTask({...task,columns:[item]}));assert.deepEqual(seen,[]);
 const sparse=Array(1);assert.throws(()=>publicTask({...task,columns:sparse}));
 assert.throws(()=>publicTask({...task,columns:[{id:'C2',type:'text'},{id:'C2',type:'text'}]}));
 assert.throws(()=>publicTask({...task,columns:[{id:'C17',type:'text'}]}));
 assert.deepEqual(publicTask({...task,columns:task.columns.slice().reverse()}),task);
});
test('model JSON parsing rejects duplicate/deep/trailing-code output rather than repairing it',()=>{
 assert.deepEqual(parsePlannerJSON('```json\n'+JSON.stringify(proposal)+'\n```'),proposal);
 for(const raw of ['{"steps":[],"steps":[]}','{"steps":[]}\nfetch("/secret")','I think '+JSON.stringify(proposal),'['.repeat(14)+'0'+']'.repeat(14)])assert.throws(()=>parsePlannerJSON(raw));
 assert.throws(()=>parsePlannerJSON('x'.repeat(16001)));
});
test('agent proposal binding rejects unknown operations, wrong columns/types and stale goals',async()=>{
 const accepted=await acceptAgentProposal(task,JSON.stringify(proposal));assert.match(accepted.planSha256,/^[a-f0-9]{64}$/);assert.equal(accepted.plan.taskHash,await publicTaskHash(task));
 const changed={...task,goal:'Different public requirement'};await assert.rejects(acceptAgentProposal(changed,accepted.plan));
 await assert.rejects(acceptAgentProposal(task,{status:'unsupported',reason:'Semantic translation is unavailable.'}),/desteklenen/);
 for(const p of [
  {steps:[{column:'C1',recipe:proposal.steps[0].recipe}]},
  {steps:[{column:'C2',recipe:proposal.steps[1].recipe}]},
  {steps:[{column:'C2',recipe:{type:'text',steps:[{op:'fetch',url:'https://evil.test'}]}}]},
  {...proposal,reason:'extra unapproved output'},
 ])await assert.rejects(acceptAgentProposal(task,p));
});
test('multi-column private inputs and results stay local; nonselected UTF8 cells and exact semantics preserved',async()=>{
 const {plan}=await acceptAgentProposal(task,proposal);
 const dataset=parseCSV('id;private_supplier;private_score;note\nR1;"  ACME  ";;"İstanbul, keep"\nR2;BETA;200;özel\n');
 const inputs=privatePlanInputs(dataset,plan);assert.deepEqual(inputs,{C2:['  ACME  ','BETA'],C3:[255,200]});
 const result=applyAgentOutput(dataset,plan,{C2:['acme','beta'],C3:[0,100]});
 assert.deepEqual(result.rows,[['R1','acme','0','İstanbul, keep'],['R2','beta','100','özel']]);assert.equal(result.delimiter,';');assert.deepEqual(result.headers,dataset.headers);
 assert.equal(JSON.stringify(plan).includes('private_supplier'),false);
 assert.throws(()=>applyAgentOutput(dataset,plan,{C2:['wrong','beta'],C3:[0,100]}));
 assert.throws(()=>applyAgentOutput(dataset,plan,{C2:['acme','beta'],C3:[0,100],C1:['leak']}));
 assert.deepEqual(dataset.rows[0],['R1','  ACME  ','','İstanbul, keep']);
});
test('valid maximum-size source may grow when multiple numeric columns are filled',async()=>{
 const source='a,b,note\n,,'+'x'.repeat(65536-'a,b,note\n,,'.length);
 assert.equal(new TextEncoder().encode(source).length,65536);
 const dataset=parseCSV(source);
 const {plan}=await acceptAgentProposal({version:1,goal:'Fill C1 and C2 with 254.',columns:[{id:'C1',type:'number'},{id:'C2',type:'number'}]}, {steps:['C1','C2'].map(column=>({column,recipe:{type:'number',steps:[{op:'fill',value:254}]}}))});
 const result=applyAgentOutput(dataset,plan,{C1:[254],C2:[254]});
 assert.deepEqual(result.rows,[['254','254',dataset.rows[0][2]]]);
 assert.ok(new TextEncoder().encode(result.csv).length>65536);
 assert.deepEqual(dataset.rows[0].slice(0,2),['','']);
 assert.throws(()=>applyAgentOutput(dataset,plan,{C1:[254],C2:[253]}));
});
