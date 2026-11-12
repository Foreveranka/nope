import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {readFileSync} from 'node:fs';
import {commitment,encodeIntent,precommitContext,MPC_PROGRAM_HASH,MPC_UPSTREAM,MPC_PROFILE,MAX_AMOUNT,sha256,validateIntent} from '../procurement/codec.mjs';

const intent={version:2,profile:MPC_PROFILE,networkDomainHash:'11'.repeat(32),registryAccount:'registry.testnet',buyer:'buyer.testnet',roster:['a.testnet','b.testnet','c.testnet'],qualified:[true,false,true],fixedFee:1250000,bidDeadlineNs:'1800000060000000000',resultDeadlineNs:'1800003600000000000',specHash:'22'.repeat(32),circuitHash:'33'.repeat(32),keyHash:'44'.repeat(32),outputPolicyHash:'55'.repeat(32),inputHash:'66'.repeat(32),registryExecutor:'executor.testnet',intentNonce:'77'.repeat(32),selectionRound:'88'.repeat(32),mpcProgramHash:MPC_PROGRAM_HASH,upstream:MPC_UPSTREAM};

test('intent binary bytes, context and four micro-unit commitments exactly match existing Python v2 implementation',()=>{
  const script=`import json,sys\nfrom mpc.v2 import encode_intent,precommit_context,commitment\ni=json.load(sys.stdin)\nc=precommit_context(i)\nprint(json.dumps(dict(encoded=encode_intent(i).hex(),context=c,commitments=[commitment(c,s,a,bytes([s+1])*32) for s,a in enumerate([0,1,1250000,10**12])])) )`;
  const run=spawnSync('python3',['-B','-c',script],{cwd:new URL('../',import.meta.url),input:JSON.stringify(intent),encoding:'utf8',timeout:10000});
  assert.equal(run.status,0,run.stderr);const python=JSON.parse(run.stdout);
  assert.equal(encodeIntent(intent).toString('hex'),python.encoded);assert.equal(precommitContext(intent),python.context);
  for(const [slot,amount] of [0,1,1250000,MAX_AMOUNT].entries())assert.equal(commitment(python.context,slot,amount,Buffer.alloc(32,slot+1)),python.commitments[slot]);
});
test('hardcoded accepted program hash is actual repository circuit and upstream matches Python build',()=>{
  const bytes=readFileSync(new URL('../mpc/programs/sealed_procurement_v2.mpc',import.meta.url));assert.equal(sha256(bytes),MPC_PROGRAM_HASH);
  const text=readFileSync(new URL('../mpc/auction.py',import.meta.url),'utf8');assert.equal(text.includes(`UPSTREAM = "${MPC_UPSTREAM}"`),true);
});
test('v2 codec rejects noncanonical amounts, booleans, U64 strings, unknown builds and extra fields',()=>{
  for(const patch of [{fixedFee:true},{fixedFee:1.5},{fixedFee:MAX_AMOUNT+1},{bidDeadlineNs:1800000060000000000},{bidDeadlineNs:'01800000060000000000'},{resultDeadlineNs:'18446744073709551616'},{qualified:[1,0,1]},{roster:['a.testnet','a.testnet','c.testnet']},{networkDomainHash:'0'.repeat(64)},{mpcProgramHash:'1'.repeat(64)},{salt:'private'}])assert.throws(()=>validateIntent({...intent,...patch}),JSON.stringify(patch));
  for(const [slot,amount,salt] of [[1,0,Buffer.alloc(32)],[0,-1,Buffer.alloc(32)],[4,1,Buffer.alloc(32)],[0,true,Buffer.alloc(32)],[1,MAX_AMOUNT+1,Buffer.alloc(32)],[1,10,Buffer.alloc(31)]])assert.throws(()=>commitment(precommitContext(intent),slot,amount,salt));
});
