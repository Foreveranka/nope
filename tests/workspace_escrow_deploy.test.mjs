import test from'node:test';import assert from'node:assert/strict';import{actions,KeyPair,PublicKey}from'near-api-js';import{validateProvisioning,faucetRequest,CONTRACT,METHODS}from'../scripts/workspace-escrow-deploy.mjs';
const online=KeyPair.fromRandom('ed25519').getPublicKey(),build={wasm:Buffer.from([0,97,115,109,1,0,0,0])};
function request(methods=METHODS,receiver=CONTRACT,allowance=2n*10n**23n){return{label:'deploy-workspace-escrow',id:{account_id:CONTRACT},receiver:CONTRACT,list:[actions.deployContract(build.wasm),actions.functionCall('new',{},50_000_000_000_000n,0n),actions.addFunctionCallAccessKey(online,receiver,methods,allowance)],build,onlinePublicKey:online.toString()};}
test('offline testnet deployment admits only pinned Wasm, constructor and finite receiver/method-scoped online key',()=>{
 assert.doesNotThrow(()=>validateProvisioning(request()));
 for(const r of[request([...METHODS,'new']),request([...METHODS,'on_transfer']),request([]),request(METHODS,'outsider.testnet'),request(METHODS,CONTRACT,null),request(METHODS,CONTRACT,3n*10n**23n)])assert.throws(()=>validateProvisioning(r));
 const full=request();full.list[2]=actions.addFullAccessKey(online);assert.throws(()=>validateProvisioning(full));
 const attached=request();attached.list[1]=actions.functionCall('new',{},50_000_000_000_000n,1n);assert.throws(()=>validateProvisioning(attached));
 const wasm=request();wasm.list[0]=actions.deployContract(Buffer.from([0,97,115,109,0,0,0,0]));assert.throws(()=>validateProvisioning(wasm));
 for(const id of['mainnet.near','veil-reg-e138f5c88250f821.testnet','outsider.testnet'])assert.throws(()=>validateProvisioning({...request(),id:{account_id:id}}));
 const transfer=request();transfer.list.push(actions.transfer(1n));assert.throws(()=>validateProvisioning(transfer));
});
test('free faucet request contains only the fresh testnet account and its public key, never a signing key',()=>{
 const key=KeyPair.fromRandom('ed25519'),body=faucetRequest(key.getPublicKey().toString());assert.deepEqual(body,{newAccountId:CONTRACT,newAccountPublicKey:key.getPublicKey().toString()});assert.equal(JSON.stringify(body).includes(key.toString()),false);
 assert.throws(()=>faucetRequest(key.toString()));assert.throws(()=>faucetRequest(''));assert.throws(()=>faucetRequest(PublicKey.fromString(key.getPublicKey().toString())));
});
