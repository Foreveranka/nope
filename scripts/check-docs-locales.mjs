// The documentation is first-party product content. Protocol/code fields are
// invariant; only prose is translated. Never run this over customer records.
import fs from 'node:fs/promises';
const base=new URL('../web/docs-locales/',import.meta.url),langs=['tr','en','de','es','fr'];
const read=async lang=>JSON.parse(await fs.readFile(new URL(lang+'.json',base),'utf8'));
const source=await read('tr');
const fixed=new Set(['version','id','kind','code','href']);
function compare(expected,actual,at='root'){
 if(Array.isArray(expected)){
  if(!Array.isArray(actual)||expected.length!==actual.length)throw Error('Documentation array parity: '+at);
  expected.forEach((v,i)=>compare(v,actual[i],at+'['+i+']'));return;
 }
 if(expected&&typeof expected==='object'){
  if(!actual||typeof actual!=='object'||Array.isArray(actual)||JSON.stringify(Object.keys(expected).sort())!==JSON.stringify(Object.keys(actual).sort()))throw Error('Documentation schema parity: '+at);
  for(const key of Object.keys(expected)){
   if(key==='locale')continue;
   if(fixed.has(key)){if(JSON.stringify(expected[key])!==JSON.stringify(actual[key]))throw Error('Documentation invariant changed: '+at+'.'+key);}
   else compare(expected[key],actual[key],at+'.'+key);
  }return;
 }
 if(typeof expected==='string'){
  if(typeof actual!=='string'||expected.trim()&&!actual.trim())throw Error('Missing documentation prose: '+at);
 }else if(actual!==expected)throw Error('Documentation value mismatch: '+at);
}
const summary=[];
for(const lang of langs){const d=await read(lang);if(d.version!==1||d.locale!==lang)throw Error('Invalid documentation catalog '+lang);compare(source,d);summary.push({language:lang,sections:d.sections.length,items:d.sections.reduce((n,s)=>n+s.items.length,0)});}
if(new Set(source.sections.map(s=>s.id)).size!==source.sections.length)throw Error('Duplicate documentation section anchor');
console.log(JSON.stringify({documentation:summary,complete:true,codeAndRouteParity:true}));
