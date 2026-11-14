import initAbi from '@noir-lang/noirc_abi';
import initACVM from '@noir-lang/acvm_js';
import {BROWSER_ASSETS} from './browser-assets.mjs';
export const browser=true;
export async function loadAsset(path){const url=new URL(path,import.meta.url);if(url.origin!==self.location.origin)throw new Error('Proof assets must be same-origin');const r=await fetch(url,{credentials:'same-origin',redirect:'error'});if(!r.ok)throw new Error('Missing proof asset: '+path);return new Uint8Array(await r.arrayBuffer());}
export async function verifiedBrowserAsset(name){const a=BROWSER_ASSETS[name],b=await loadAsset(a.path);const hash=Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',b)),x=>x.toString(16).padStart(2,'0')).join('');if(hash!==a.sha256)throw new Error('Browser asset integrity failure: '+name);return b;}
export async function initialize(){await Promise.all([initAbi({module_or_path:await verifiedBrowserAsset('abi')}),initACVM({module_or_path:await verifiedBrowserAsset('acvm')})]);}
export function backendOptions(){return {wasmPath:new URL('./assets/barretenberg.wasm.gz',import.meta.url).href};}
export function resourceProfile(api){return {wasmBytes:api?.backend?.wasm?.memory?.buffer?.byteLength??null,jsHeapBytes:self.performance?.memory?.usedJSHeapSize??null};}
