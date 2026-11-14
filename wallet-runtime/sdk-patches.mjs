/** Strict, version-pinned build-time transport patches. Tests exercise the same
 * transformed published SDK source that esbuild packages. */
export function patchExecutor(source){
 const changes=[
  ['localStorage','this.connector.__nopeWalletStorage'],
  ['if (url && url.origin === ev.origin) {','if (url && url.origin === ev.origin && ev.source === panel) {'],
  ['panel.postMessage(event.data.params.data, "*");','panel.postMessage(event.data.params.data, "https://wallet.intear.tech");'],
  ['if (event.data.id !== id || event.data.origin !== iframe.origin)','if (event.source !== iframe.iframe.contentWindow || event.origin !== "null" || event.data.protocol !== "NOPE:WALLET:FRAME:V1" || event.data.method !== method.replace("wallet:", "") || !["success", "failed"].includes(event.data.status) || event.data.id !== id || event.data.origin !== iframe.origin)'],
  ['iframe.on("close", () => reject(new Error("Wallet closed")));','iframe.on("close", () => { window.removeEventListener("message", handler); reject(new Error("Wallet closed")); });']
 ];
 for(const[from,to]of changes){if(!source.includes(from))throw Error('Pinned SDK shim pattern changed: '+from);source=source.replaceAll(from,to);}
 const start=source.indexOf('    async loadCode() {'),end=source.indexOf('    async call(method, params) {',start);
 if(start<0||end<0)throw Error('Pinned SDK loadCode shape changed');
 return source.slice(0,start)+'    async loadCode() { return "pinned-static-executor"; }\n'+source.slice(end);
}
