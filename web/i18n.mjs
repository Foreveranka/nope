import DEFAULT_EN from './locales/en.mjs';
/** Explicit UI messages only. Customer data never passes through a translator. */
export const LANGUAGES=Object.freeze(['tr','en','de','es','fr']);
export const LANGUAGE_NAMES=Object.freeze({tr:'Türkçe',en:'English',de:'Deutsch',es:'Español',fr:'Français'});
export const STORAGE_KEY='nope.language';
const LOCALES={tr:'tr-TR',en:'en-GB',de:'de-DE',es:'es-ES',fr:'fr-FR'};
const BRAND=Symbol('NOPE.UI.message');
let language='tr',catalogs=Object.create(null),initialized;
let activeDocument,activeWindow,activeStorage;
const bindings=new WeakMap(),refs=new Set(),registered=new WeakSet();
const checkLanguage=value=>LANGUAGES.includes(value);
export const getLanguage=()=>language;
export const getLocale=()=>LOCALES[language];
const has=(obj,key)=>obj&&Object.hasOwn(obj,key);
// Membership, not output inequality: a valid catalog value may equal its key.
export const hasTranslation=source=>typeof source==='string'&&(has(catalogs.tr,source)||has(catalogs.en,source));
export function translate(source,values=[],lang=language){
 if(typeof source!=='string'||!Array.isArray(values))throw Error('Invalid UI message');
 const dict=catalogs[checkLanguage(lang)?lang:'en'];
 const pattern=has(dict,source)?dict[source]:has(catalogs.en,source)?catalogs.en[source]:source;
 return pattern.replace(/\{(\d+)\}/g,(token,index)=>Number(index)<values.length?String(values[Number(index)]??''):token);
}
export function msg(strings,...values){
 const source=Array.isArray(strings)&&Object.hasOwn(strings,'raw')?strings.reduce((s,part,i)=>s+(i?`{${i-1}}`:'')+part,''):strings;
 if(typeof source!=='string')throw Error('UI messages require a string');
 const args=Object.freeze([...values]);
 return Object.freeze({[BRAND]:true,source,values:args,toString(){return translate(source,args);},[Symbol.toPrimitive](){return translate(source,args);}});
}
export const isMessage=value=>Boolean(value&&value[BRAND]===true);
function remember(node,name,message){
 let map=bindings.get(node);if(!map){map=new Map();bindings.set(node,map);}
 if(isMessage(message)){
  map.set(name,message);
  if(!registered.has(node)){registered.add(node);refs.add(new WeakRef(node));}
 }else map.delete(name);
}
export function bindText(node,value){
 // Bind a dedicated text leaf so switching language never removes a label's
 // input, a button's icon, or another child added after its initial caption.
 if(node.nodeType===1&&node.ownerDocument?.createTextNode){
  node.textContent='';const leaf=node.ownerDocument.createTextNode(String(value??''));node.append(leaf);remember(leaf,'text',value);
 }else{remember(node,'text',value);node.textContent=String(value??'');}
 return node;
}
export function bindAttribute(node,name,value){remember(node,name,value);node.setAttribute(name,String(value??''));return node;}
function refresh(){
 for(const ref of refs){const node=ref.deref();if(!node){refs.delete(ref);continue;}
  const entries=bindings.get(node);if(!entries)continue;
  for(const [name,value]of entries){if(name==='text')node.textContent=String(value);else node.setAttribute(name,String(value));}
 }
 if(activeDocument?.documentElement)activeDocument.documentElement.lang=language;
 activeDocument?.querySelectorAll?.('[data-nope-language]').forEach(select=>{select.value=language;});
}
export function setLanguage(value,{persist=true}={}){
 if(!checkLanguage(value))throw Error('Unsupported language');
 language=Object.keys(catalogs).length&&!catalogs[value]?'en':value;
 if(persist){try{activeStorage?.setItem(STORAGE_KEY,value);}catch{/* Storage can be disabled. */}}
 refresh();
 if(activeWindow?.dispatchEvent&&typeof activeWindow.CustomEvent==='function')activeWindow.dispatchEvent(new activeWindow.CustomEvent('nope:languagechange',{detail:{language}}));
 return language;
}
/** Called once before dynamic/user content mounts. No MutationObserver or
 * blanket translation of subsequent DOM/customer values is installed. */
export function localizeDocument(doc=globalThis.document){
 if(!doc?.documentElement)return;
 const dictionary=catalogs.tr||catalogs.en||Object.create(null),skip='script,style,code,pre,textarea,[data-i18n-ignore]';
 const visit=node=>{
  if(node.nodeType===3){
   const text=node.textContent||'',key=text.trim();
   if(key&&has(dictionary,key)&&!node.parentElement?.closest?.(skip)){
    const leading=text.slice(0,text.indexOf(key)),trailing=text.slice(text.indexOf(key)+key.length);
    // Outer whitespace is presentation, not a catalog entry.
    const rendered={ [BRAND]:true,toString:()=>leading+String(msg(key))+trailing };
    bindText(node,rendered);
   }
  }else{
   if(node.matches?.(skip))return;
   for(const name of ['aria-label','placeholder','title','alt']){const value=node.getAttribute?.(name);if(value&&has(dictionary,value))bindAttribute(node,name,msg(value));}
   for(const child of Array.from(node.childNodes||[]))visit(child);
  }
 };
 visit(doc.documentElement);doc.documentElement.lang=language;
}
export async function initI18n({document:doc=globalThis.document,window:win=globalThis.window,fetch:fetcher=globalThis.fetch,storage}={}){
 if(initialized)return initialized;
 initialized=(async()=>{
  activeDocument=doc;activeWindow=win;
  try{activeStorage=storage??win?.localStorage;}catch{activeStorage=undefined;}
  let preferred;try{preferred=activeStorage?.getItem(STORAGE_KEY);}catch{}
  language=checkLanguage(preferred)?preferred:'en';
  // English ships with the core module: an unavailable unused translation
  // cannot discard English or prevent startup. Network catalogs are optional
  // replacements and each request has a bounded lifetime.
  catalogs={en:DEFAULT_EN};localizeDocument(doc);
  const loaded=await Promise.allSettled(['tr','en','de','es','fr'].map(async code=>{
   const r=await fetcher(new URL(`./locales/${code}.json`,import.meta.url),{credentials:'same-origin',redirect:'error',signal:AbortSignal.timeout(5000)});
   if(!r.ok)throw Error('Missing UI language catalog');const data=await r.json();
   if(!data||typeof data!=='object'||Array.isArray(data)||!Object.keys(data).length||Object.values(data).some(v=>typeof v!=='string'))throw Error('Invalid UI language catalog');
   return[code,data];
  }));
  for(const item of loaded)if(item.status==='fulfilled')catalogs[item.value[0]]=item.value[1];
  let resolved=checkLanguage(preferred)?preferred:'en';
  if(!checkLanguage(preferred)){
   try{
    const response=await fetcher('/api/locale',{credentials:'omit',cache:'no-store',redirect:'error',signal:AbortSignal.timeout(2500)});
    const data=response.ok?await response.json():null;
    resolved=checkLanguage(data?.language)?data.language:'en';
   }catch{resolved='en';}
  }
  setLanguage(catalogs[resolved]?resolved:'en',{persist:false});
  return language;
 })();
 try{return await initialized;}catch(error){initialized=undefined;throw error;}
}
export function mountLanguagePicker({document:doc=globalThis.document,window:win=globalThis.window,target}={}){
 if(!doc?.createElement)return null;
 const existing=doc.querySelector('[data-nope-language]');if(existing)return existing;
 const host=target||doc.querySelector('.topbar')||doc.querySelector('.site-header');if(!host)return null;
 const label=doc.createElement('label');label.className='language-picker';
 const text=doc.createElement('span');bindText(text,msg('Dil'));label.append(text);
 const select=doc.createElement('select');select.dataset.nopeLanguage='true';select.name='language';bindAttribute(select,'aria-label',msg('Dil seçimi'));
 for(const code of LANGUAGES){const option=doc.createElement('option');option.value=code;option.textContent=LANGUAGE_NAMES[code];select.append(option);}
 select.value=language;select.addEventListener('change',()=>setLanguage(select.value));label.append(select);host.append(label);return select;
}
