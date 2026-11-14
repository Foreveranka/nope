/** Offline deterministic packaging of published NEAR Connect and reviewed
 * official Intear executor. All executable assets are served from the app. */
import fs from'node:fs/promises';import{createHash}from'node:crypto';import{build}from'esbuild';
import{patchExecutor}from'./sdk-patches.mjs';
const root=new URL('./',import.meta.url),out=new URL('./dist/',root),sha=b=>createHash('sha256').update(b).digest('hex');
const source=await fs.readFile(new URL('./intear-executor.upstream.js',root));if(sha(source)!=='6decc283352af197feff4988628899d19e05f4168a4277fe699bd8a0d6178e34')throw Error('Reviewed official wallet executor hash changed');
await fs.rm(out,{recursive:true,force:true});await fs.mkdir(out,{recursive:true});
const plugin={name:'nope-opaque-static-sandbox',setup(b){
 b.onResolve({filter:/^\.\/iframe$/},a=>a.importer.includes('/SandboxedWallet/')?{path:new URL('./iframe-executor.mjs',root).pathname}:null);
 b.onLoad({filter:/\/SandboxedWallet\/executor\.js$/},async a=>{
  return {contents:patchExecutor(await fs.readFile(a.path,'utf8')),loader:'js'};
 });
 b.onLoad({filter:/\/NearConnector\.js$/},async a=>{let s=await fs.readFile(a.path,'utf8');const marker='window.addEventListener("message", async (event) => {';if(!s.includes(marker))throw Error('SDK incoming message shape changed');s=s.replace(marker,marker+'\n if (event.source !== window || event.origin !== window.location.origin) return;');return{contents:s,loader:'js'};});
}};
await build({entryPoints:{'wallet-sdk':new URL('./entry.mjs',root).pathname,'bridge':new URL('./bridge.mjs',root).pathname},outdir:out.pathname,bundle:true,splitting:false,format:'esm',platform:'browser',target:'es2022',plugins:[plugin],external:['./intear-executor.js'],minify:true,legalComments:'eof',logLevel:'info'});
await fs.writeFile(new URL('./intear-executor.js',out),source);await fs.copyFile(new URL('./wallet.css',root),new URL('./wallet.css',out));
await fs.writeFile(new URL('./bridge.html',out),'<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="./wallet.css"><script type="module" src="./bridge.js"></script><title>NOPE</title></head><body class="nope-wallet-bridge"><div id="root"></div></body></html>\n');
const names=['wallet-sdk.js','bridge.js','bridge.html','intear-executor.js','wallet.css'];const files=[];for(const name of names){const b=await fs.readFile(new URL(name,out));if(name.endsWith('.js')&&/\beval\s*\(|new\s+Function\s*\(/.test(b.toString()))throw Error('Dynamic code is prohibited');files.push({path:name,bytes:b.length,sha256:sha(b)});}
const manifest={version:1,network:'testnet',sdk:{name:'@hot-labs/near-connect',version:'0.12.0'},wallet:{id:'intear-wallet',source:'https://wallet.intear.tech/near-selector.js',sha256:sha(source)},csp:{frameSrc:["'self'"],bridgeFrameAncestors:["'self'"],extraConnectSrc:[],popupOrigins:['https://wallet.intear.tech']},files,totalBytes:files.reduce((n,f)=>n+f.bytes,0)};
await fs.writeFile(new URL('./asset-manifest.json',out),JSON.stringify(manifest,null,2)+'\n');console.log(JSON.stringify({out:out.pathname,files:files.length,bytes:manifest.totalBytes}));
