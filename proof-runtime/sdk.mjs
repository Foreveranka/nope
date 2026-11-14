import {Barretenberg,BackendType,UltraHonkBackend,UltraHonkVerifierBackend} from '@aztec-foundation/bb.js';
import {Noir} from '@noir-lang/noir_js';
import {loadAsset,backendOptions,resourceProfile,initialize} from './platform.mjs';
import {APPROVED} from './approved.mjs';
import {proofPolicy,policyHash} from './policy.mjs';
export const SCHEME='nope-result-noir-poseidon2-v1';
export const FIELD=21888242871839275222246405745257275088548364400416034343698204186575808495617n;
const opts=Object.freeze({verifierTarget:'noir-recursive'});
const fail=m=>{throw new Error(m);};
export function hexBytes(s){if(typeof s!=='string'||!/^([0-9a-f]{2})*$/.test(s))fail('Invalid hex');return Uint8Array.from(s.match(/../g)??[],x=>parseInt(x,16));}
export function bytesHex(b){return Array.from(b,x=>x.toString(16).padStart(2,'0')).join('');}
const field=n=>{if(typeof n!=='string'||!/^(0|[1-9][0-9]*)$/.test(n)||BigInt(n)>=FIELD)fail('Invalid field');return n;};
const limbs=s=>{if(typeof s!=='string'||!/^[0-9a-f]{64}$/.test(s))fail('Expected 32-byte lowercase hex');return [BigInt('0x'+s.slice(0,32)).toString(),BigInt('0x'+s.slice(32)).toString()];};
const b64=b=>{let s='';for(const x of b)s+=String.fromCharCode(x);return btoa(s);};
const unb64=s=>{if(typeof s!=='string'||s.length>100000)fail('Invalid base64');let b;try{b=Uint8Array.from(atob(s),x=>x.charCodeAt(0));}catch{fail('Invalid base64');}if(b64(b)!==s)fail('Noncanonical base64');return b;};
const label=s=>{const b=unb64(s);if(b.length!==16)fail('Expected 16-byte label');return BigInt('0x'+bytesHex(b)).toString();};
const count=t=>t==='number'?[10,8]:t==='text'?[130,128]:fail('Unknown type');
const arr=(v,n)=>{if(!Array.isArray(v)||v.length!==n||Object.keys(v).length!==n)fail('Invalid array length');return v;};
function recipeABI(type,recipe){
 if(!recipe||recipe.type!==type||Object.keys(recipe).sort().join(',')!=='steps,type'||!Array.isArray(recipe.steps)||recipe.steps.length<1||recipe.steps.length>4)fail('Invalid recipe');
 const ops=[0,0,0,0],params=Array.from({length:4},()=>[0,0,0]);
 recipe.steps.forEach((s,i)=>{const keys=Object.keys(s).sort().join(',');const byte=n=>Number.isInteger(n)&&n>=0&&n<=254;
 if(type==='number'&&s.op==='fill'&&keys==='op,value'&&byte(s.value)){ops[i]=1;params[i][0]=s.value;}
 else if(type==='number'&&s.op==='clamp'&&keys==='max,min,op'&&byte(s.min)&&byte(s.max)&&s.min<=s.max){ops[i]=2;params[i]=[s.min,s.max,0];}
 else if(type==='text'&&keys==='op'&&['trim','lowercase','uppercase','redactDigits'].includes(s.op)){ops[i]=3+['trim','lowercase','uppercase','redactDigits'].indexOf(s.op);}
 else fail('Invalid operation');});
 return {ops,params,step_count:recipe.steps.length};
}
function header(a){count(a.type);if(!Number.isInteger(a.column)||a.column<1||a.column>16||!Number.isInteger(a.row)||a.row<0||a.row>=32)fail('Invalid coordinates');const r=recipeABI(a.type,a.recipe);return [a.type==='number'?1:2,a.column,a.row,...limbs(a.preContext),r.step_count,...r.ops,...r.params.flat()].map(String);}
const pairs=(p,n)=>arr(p,n).map(x=>{const q=arr(x,2).map(label);if(q[0]===q[1]||((BigInt(q[0])^BigInt(q[1]))&1n)!==1n)fail('Invalid distinct/permutation pair');return q;});
const selection=(labels,p)=>arr(labels,p.length).map((x,i)=>{const l=label(x);if(l===p[i][0])return false;if(l===p[i][1])return true;fail('Selected label absent from ordered pair');});
export function publicInputs(s){const h=header(s);return [...limbs(s.preContext),...limbs(s.finalContext),...h.slice(1,3),...h.slice(5),field(s.inputPairRoot),field(s.outputPairRoot),field(s.inputSelectedRoot),field(s.outputSelectedRoot),field(s.statementRoot)];}
export function getRuntimeDescriptor(){return structuredClone({scheme:SCHEME,relationVersion:1,field:FIELD.toString(),hash:'poseidon2-bn254-hash4-fold-v1',policyHash,artifacts:APPROVED.circuits});}
export async function createProofRuntime(){
 for(const type of ['number','text']){const a=APPROVED.circuits[type],p=proofPolicy.circuits[type];if(a.circuitSha256!==p.circuitSha256||a.vkSha256!==p.verificationKeySha256||proofPolicy.verifierTarget!==opts.verifierTarget)fail('Approved policy/artifact disagreement');}
 for(const key of ['g1','g2','grumpkin']){const a=APPROVED.srs?.[key],p=proofPolicy.srs[key];if(!a||a.path!==p.path||a.sha256!==p.sha256||a.bytes!==p.bytes)fail('Approved policy/SRS disagreement');}
 if(APPROVED.srs.numPoints!==proofPolicy.srs.numPoints)fail('Approved SRS size disagreement');
 const start=performance.now();let disposed=false,srsReady=false,chain=Promise.resolve();const programs=new Map(),backends=new Map();
 await initialize();
 let api=await Barretenberg.new({backend:BackendType.Wasm,threads:1,skipSrsInit:true,memory:{initial:512,maximum:32768},...backendOptions()});
 const locked=fn=>(...args)=>{args=structuredClone(args);const r=chain.then(()=>{if(disposed)fail('Proof runtime disposed');return fn(...args);});chain=r.catch(()=>{});return r;};
 async function verifiedAsset(path,sha){const b=await loadAsset(path);if(bytesHex(new Uint8Array(await crypto.subtle.digest('SHA-256',b)))!==sha)fail('Approved artifact hash mismatch: '+path);return b;}
 async function ready(){if(!srsReady){
  if(APPROVED.srs){const s=APPROVED.srs;const [g1,g2,gk]=await Promise.all([verifiedAsset(s.g1.path,s.g1.sha256),verifiedAsset(s.g2.path,s.g2.sha256),verifiedAsset(s.grumpkin.path,s.grumpkin.sha256)]);await api.srsInitSrs({pointsBuf:g1,numPoints:s.numPoints,g2Point:g2});await api.srsInitGrumpkinSrs({pointsBuf:gk,numPoints:65536});}
  else fail('Missing approved public SRS');srsReady=true;
 }}
 async function program(type){count(type);const a=APPROVED.circuits[type];if(!a)fail('Unapproved circuit');if(!programs.has(type)){const p=JSON.parse(new TextDecoder().decode(await verifiedAsset(a.circuitPath,a.circuitSha256)));programs.set(type,p);backends.set(type,new UltraHonkBackend(p.bytecode,api));}return programs.get(type);}
 async function h4(xs){const {hash}=await api.poseidon2Hash({inputs:xs.map(x=>hexBytes(BigInt(x).toString(16).padStart(64,'0')))});return BigInt('0x'+bytesHex(hash)).toString();}
 async function fold(d,f){let h=await h4([d,1,f.length,0]);for(let i=0;i<f.length;i+=3)h=await h4([h,f[i]??0,f[i+1]??0,f[i+2]??0]);return h;}
 async function commitRow(a){const h=header(a),[i,o]=count(a.type);return {inputPairRoot:await fold(101,[...h,...limbs(a.inputSalt),...pairs(a.inputPairs,i).flat()]),outputPairRoot:await fold(102,[...h,...limbs(a.outputSalt),...pairs(a.outputPairs,o).flat()])};}
 async function selectedRoot(a){const h=header(a),[i,o]=count(a.type);if(!['input','output'].includes(a.role))fail('Invalid role');return fold(a.role==='input'?103:104,[...h,...arr(a.labels,a.role==='input'?i:o).map(label)]);}
 async function makeStatement(a){const h=header(a);const s={type:a.type,preContext:a.preContext,finalContext:a.finalContext,column:a.column,row:a.row,recipe:structuredClone(a.recipe),inputPairRoot:field(a.inputPairRoot),outputPairRoot:field(a.outputPairRoot),inputSelectedRoot:await selectedRoot({...a,role:'input',labels:a.inputLabels}),outputSelectedRoot:await selectedRoot({...a,role:'output',labels:a.outputLabels})};s.statementRoot=await fold(105,[...h,...limbs(a.finalContext),s.inputPairRoot,s.outputPairRoot,s.inputSelectedRoot,s.outputSelectedRoot]);return {...s,inputLabels:[...a.inputLabels],outputLabels:[...a.outputLabels],publicInputs:publicInputs(s)};}
 async function validateStatement(s){const expected=await makeStatement(s);for(const k of ['inputSelectedRoot','outputSelectedRoot','statementRoot'])if(expected[k]!==s[k])fail('Statement mismatch: '+k);return expected;}
 async function witnessInput(statement,witness){const s=await validateStatement(statement),[i,o]=count(s.type),ip=pairs(witness.inputPairs,i),op=pairs(witness.outputPairs,o);const r=recipeABI(s.type,s.recipe);return {pre_context:limbs(s.preContext),final_context:limbs(s.finalContext),column:s.column,row:s.row,...r,input_pair_root:s.inputPairRoot,output_pair_root:s.outputPairRoot,input_selected_root:s.inputSelectedRoot,output_selected_root:s.outputSelectedRoot,statement:s.statementRoot,input_salt:limbs(witness.inputSalt),output_salt:limbs(witness.outputSalt),input_pairs:ip,output_pairs:op,input_bits:selection(s.inputLabels,ip),output_bits:selection(s.outputLabels,op)};}
 async function proveRow({statement,witness}){const p=await program(statement.type);const input=await witnessInput(statement,witness);const {witness:w}=await new Noir(p).execute(input);await ready();const proof=await backends.get(statement.type).generateProof(w,opts);if(proof.publicInputs.map(x=>BigInt(x).toString()).join(',')!==publicInputs(statement).join(','))fail('Unexpected public ABI');return {version:1,scheme:SCHEME,type:statement.type,circuitSha256:APPROVED.circuits[statement.type].circuitSha256,verificationKeySha256:APPROVED.circuits[statement.type].vkSha256,proof:b64(proof.proof),publicInputs:proof.publicInputs.map(x=>BigInt(x).toString())};}
 async function verifyRow({statement,proof}){try{const s=await validateStatement(statement),a=APPROVED.circuits[s.type];if(!proof||Object.keys(proof).sort().join(',')!=='circuitSha256,proof,publicInputs,scheme,type,verificationKeySha256,version'||proof.version!==1||proof.scheme!==SCHEME||proof.type!==s.type||proof.circuitSha256!==a.circuitSha256||proof.verificationKeySha256!==a.vkSha256)return false;const pi=publicInputs(s);if(arr(proof.publicInputs,28).some((x,i)=>field(x)!==pi[i]))return false;const bytes=unb64(proof.proof);if(bytes.length!==a.proofBytes)return false;const vk=await verifiedAsset(a.vkPath,a.vkSha256);await ready();return await new UltraHonkVerifierBackend(api).verifyProof({proof:bytes,publicInputs:pi.map(x=>'0x'+BigInt(x).toString(16).padStart(64,'0')),verificationKey:vk},opts);}catch{return false;}}
 return {commitRow:locked(commitRow),selectedRoot:locked(selectedRoot),makeStatement:locked(makeStatement),proveRow:locked(proveRow),verifyRow:locked(verifyRow),
  // Exposed only to constraint tests, never to the remote verifier.
  checkWitness:locked(async a=>new Noir(await program(a.statement.type)).execute(await witnessInput(a.statement,a.witness))),
  profile:()=>({threads:1,backend:'Wasm',maximumWasmBytes:2147483648,srsReady,disposed,ageMs:Math.round(performance.now()-start),...resourceProfile(api)}),
  dispose:async()=>{await chain;if(!disposed){disposed=true;programs.clear();backends.clear();await api.destroy();api=null;}}
 };
}
let shared;
const singleton=()=>shared??=(createProofRuntime().catch(e=>{shared=undefined;throw e;}));
export const commitRow=async a=>(await singleton()).commitRow(a);
export const selectedRoot=async a=>(await singleton()).selectedRoot(a);
export const makeStatement=async a=>(await singleton()).makeStatement(a);
export const proveRow=async a=>(await singleton()).proveRow(a);
export const verifyRow=async a=>(await singleton()).verifyRow(a);
export async function dispose(){if(shared){const s=shared;shared=undefined;await(await s).dispose();}}
