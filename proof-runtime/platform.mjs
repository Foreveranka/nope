import fs from 'node:fs/promises';
export const browser=false;
export async function loadAsset(path) {return new Uint8Array(await fs.readFile(new URL(path,import.meta.url)));}
export function backendOptions(){return {};}
export function resourceProfile(api){return {wasmBytes:api?.backend?.wasm?.memory?.buffer?.byteLength??null,...process.memoryUsage()};}

export async function initialize(){}
