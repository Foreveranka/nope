/** Validate complete product translations, including interpolation integrity. */
import fs from 'node:fs/promises';
const root=new URL('../web/locales/',import.meta.url);
const sources=await Promise.all(['workspace-tr.json','static-tr.json'].map(async name=>JSON.parse(await fs.readFile(new URL(name,root),'utf8'))));
const merged=Object.fromEntries(Object.entries(Object.assign({'Dil':'Dil','Dil seçimi':'Dil seçimi'},...sources)).sort(([a],[b])=>a.localeCompare(b,'tr')));
for(const [key,value]of Object.entries(merged))if(typeof value!=='string'||key!==value||!key.trim())throw Error('Invalid source UI catalog key');
if(process.argv.includes('--write-tr'))await fs.writeFile(new URL('tr.json',root),JSON.stringify(merged,null,2)+'\n');
const placeholders=s=>[...s.matchAll(/\{\d+\}/g)].map(m=>m[0]).sort().join(',');
const results=[];
for(const lang of ['tr','en','de','es','fr']){
 const dict=JSON.parse(await fs.readFile(new URL(lang+'.json',root),'utf8'));
 const missing=Object.keys(merged).filter(k=>!Object.hasOwn(dict,k)),extra=Object.keys(dict).filter(k=>!Object.hasOwn(merged,k));
 const invalid=Object.keys(merged).filter(k=>Object.hasOwn(dict,k)&&(typeof dict[k]!=='string'||!dict[k].trim()||placeholders(k)!==placeholders(dict[k])));
 if(missing.length||extra.length||invalid.length)throw Error(JSON.stringify({lang,missing,extra,invalid}));
 if(lang==='tr'&&Object.keys(merged).some(k=>merged[k]!==dict[k]))throw Error('Stale Turkish source catalog');
 results.push({language:lang,keys:Object.keys(dict).length});
}
const english=JSON.parse(await fs.readFile(new URL('en.json',root),'utf8'));
const fallback='// Generated from en.json; same-origin core fallback, never customer data.\nexport default '+JSON.stringify(english)+';\n';
if(process.argv.includes('--write-tr'))await fs.writeFile(new URL('en.mjs',root),fallback);
else if(await fs.readFile(new URL('en.mjs',root),'utf8')!==fallback)throw Error('Stale bundled English fallback');
console.log(JSON.stringify({catalogs:results,complete:true,placeholderParity:true}));
