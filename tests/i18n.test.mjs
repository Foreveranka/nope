import test from'node:test';import assert from'node:assert/strict';
let run=0;const moduleForTest=()=>import('../web/i18n.mjs?isolated='+ ++run);
class Node {
 constructor(type,doc){this.nodeType=type;this.ownerDocument=doc;this.childNodes=[];this.attrs={};this._text='';this.dataset={};this.value='';this.listeners={};}
 get textContent(){return this.nodeType===3?this._text:this.childNodes.map(n=>n.textContent).join('');}
 set textContent(v){if(this.nodeType===3)this._text=String(v);else{this.childNodes=[];if(v!==''){const t=this.ownerDocument.createTextNode(String(v));this.append(t);}}}
 append(...nodes){for(const node of nodes){this.childNodes.push(node);node.parentElement=this;}}
 setAttribute(k,v){this.attrs[k]=String(v);}getAttribute(k){return this.attrs[k]??null;}
 matches(selector){return this.tag==='script'||this.tag==='style'||this.tag==='textarea'||this.tag==='pre'||this.tag==='code'||this.attrs['data-i18n-ignore']!==undefined;}
 closest(selector){return this.matches(selector)?this:this.parentElement?.closest(selector);}
 addEventListener(name,fn){this.listeners[name]=fn;}
}
function dom(){const doc={createElement(tag){const n=new Node(1,doc);n.tag=tag;return n;},createTextNode(value){const n=new Node(3,doc);n.textContent=value;return n;}};doc.documentElement=doc.createElement('html');doc.head=doc.createElement('head');doc.body=doc.createElement('body');doc.header=doc.createElement('header');doc.body.append(doc.header);doc.documentElement.append(doc.head,doc.body);doc.querySelector=selector=>selector==='[data-nope-language]'?doc.querySelectorAll(selector)[0]:selector==='.topbar'?doc.header:null;doc.querySelectorAll=()=>{const out=[];const walk=n=>{if(n.dataset.nopeLanguage)out.push(n);n.childNodes.forEach(walk);};walk(doc.documentElement);return out;};return doc;}
function env({preference,countryLanguage='en',countryFailure=false,storageFailure=false}={}){
 const doc=dom(),records=new Map(preference?[['nope.language',preference]]:[]),calls=[];
 const storage={getItem:k=>{if(storageFailure)throw Error('blocked');return records.get(k);},setItem:(k,v)=>{if(storageFailure)throw Error('blocked');records.set(k,v);}};
 const dictionaries={tr:{'Yeni iş':'Yeni iş','Dil':'Dil','Dil seçimi':'Dil seçimi'},en:{'Yeni iş':'New job','Dil':'Language','Dil seçimi':'Language selection'},de:{'Yeni iş':'Neuer Auftrag','Dil':'Sprache','Dil seçimi':'Sprache auswählen'},es:{'Yeni iş':'Nuevo trabajo','Dil':'Idioma','Dil seçimi':'Seleccionar idioma'},fr:{'Yeni iş':'Nouvelle mission','Dil':'Langue','Dil seçimi':'Choisir la langue'}};
 const fetch=async(url,options)=>{calls.push({url:String(url),options});if(String(url)==='/api/locale'){if(countryFailure)throw Error('offline');return{ok:true,json:async()=>({language:countryLanguage})};}const lang=String(url).match(/\/([a-z]{2})\.json$/)[1];return{ok:true,json:async()=>dictionaries[lang]};};
 return{doc,records,calls,storage,fetch,win:{localStorage:storage}};
}
test('manual preference wins over country, persists, and customer values never translate',async()=>{
 const i=await moduleForTest(),e=env({preference:'de',countryLanguage:'tr'});
 await i.initI18n({document:e.doc,window:e.win,fetch:e.fetch,storage:e.storage});assert.equal(i.getLanguage(),'de');assert.ok(!e.calls.some(c=>c.url==='/api/locale'));
 const caption=e.doc.createElement('label'),input=e.doc.createElement('input');input.value='PRIVATE CSV CONTENT';i.bindText(caption,i.msg('Yeni iş'));caption.append(input);e.doc.body.append(caption);
 const customer=e.doc.createElement('p');i.bindText(customer,'Yeni iş');e.doc.body.append(customer);
 i.setLanguage('fr');assert.equal(caption.childNodes[0].textContent,'Nouvelle mission');assert.equal(caption.childNodes[1],input);assert.equal(input.value,'PRIVATE CSV CONTENT');assert.equal(customer.textContent,'Yeni iş');assert.equal(e.records.get(i.STORAGE_KEY),'fr');
 const payload=i.msg`Untrusted ${'<img src=x onerror=alert(1)>'}`;const output=e.doc.createElement('p');i.bindText(output,payload);assert.equal(output.childNodes[0].nodeType,3);assert.match(output.textContent,/<img/);
});
test('country language is used only as automatic default and IP failure falls back to English',async()=>{
 for(const config of [{countryLanguage:'es',expected:'es'},{countryLanguage:'xx',expected:'en'},{countryFailure:true,expected:'en'},{preference:'invalid',countryLanguage:'fr',expected:'fr'},{storageFailure:true,countryFailure:true,expected:'en'}]){
  const i=await moduleForTest(),e=env(config);await i.initI18n({document:e.doc,window:e.win,fetch:e.fetch,storage:e.storage});assert.equal(i.getLanguage(),config.expected);assert.equal(e.doc.documentElement.lang,config.expected);assert.equal(e.calls.filter(c=>c.url==='/api/locale').length,1);assert.equal(e.calls.find(c=>c.url==='/api/locale').options.credentials,'omit');
 }
});
test('picker exposes all five languages and updates labels without replacing a draft',async()=>{
 const i=await moduleForTest(),e=env({countryLanguage:'en'});await i.initI18n({document:e.doc,window:e.win,fetch:e.fetch,storage:e.storage});
 const input=e.doc.createElement('textarea');input.value='unsent private draft';e.doc.body.append(input);
 const picker=i.mountLanguagePicker({document:e.doc,window:e.win});assert.deepEqual(picker.childNodes.map(n=>n.value),['tr','en','de','es','fr']);assert.equal(picker.attrs['aria-label'],'Language selection');picker.value='es';picker.listeners.change();assert.equal(i.getLanguage(),'es');assert.equal(picker.attrs['aria-label'],'Seleccionar idioma');assert.equal(input.value,'unsent private draft');assert.equal(i.mountLanguagePicker({document:e.doc,window:e.win}),picker);assert.throws(()=>i.setLanguage('ru'));
});
test('static localization is an initial pass, not an observer of future customer text',async()=>{
 const i=await moduleForTest(),e=env({countryLanguage:'en'}),h=e.doc.createElement('h1');h.textContent='  Yeni iş  ';e.doc.body.append(h);
 const code=e.doc.createElement('code');code.textContent='Yeni iş';e.doc.body.append(code);
 await i.initI18n({document:e.doc,window:e.win,fetch:e.fetch,storage:e.storage});assert.equal(h.textContent,'  New job  ');assert.equal(code.textContent,'Yeni iş');
 const privateNode=e.doc.createElement('p');privateNode.textContent='Yeni iş';e.doc.body.append(privateNode);i.setLanguage('fr');assert.equal(h.textContent,'  Nouvelle mission  ');assert.equal(privateNode.textContent,'Yeni iş');
});

test('an unavailable or stalled optional catalog retains English and does not block startup',async()=>{
 for(const failure of ['fr','en','all']){
  const i=await moduleForTest(),e=env({countryLanguage:'fr'}),base=e.fetch;
  const fetch=async(url,options)=>{
   if(String(url)!=='/api/locale'){
    assert.ok(options.signal instanceof AbortSignal,'catalog fetch has a bounded abort signal');
    const code=String(url).match(/\/([a-z]{2})\.json$/)[1];
    if(failure==='all'||code===failure)throw Object.assign(Error('catalog unavailable'),{name:'AbortError'});
   }
   return base(url,options);
  };
  await i.initI18n({document:e.doc,window:e.win,fetch,storage:e.storage});
  assert.equal(i.getLanguage(),failure==='en'?'fr':'en');
  i.setLanguage('en',{persist:false});assert.equal(String(i.msg('Yeni iş')),'New job');
  if(failure==='fr'){i.setLanguage('fr');assert.equal(i.getLanguage(),'en');assert.equal(e.records.get(i.STORAGE_KEY),'fr','keep desired choice for next successful load');}
 }
});
