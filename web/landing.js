import {initI18n,setLanguage,localizeDocument,mountLanguagePicker,msg,bindText,bindAttribute} from './i18n.mjs';

// Finish locale selection before mounting explanatory-diagram handlers. There is
// no computation/network action in this local illustration.
try{await initI18n({document,window});}
catch{setLanguage('en',{persist:false});}
localizeDocument(document);
mountLanguagePicker({document,window});
const description=document.querySelector('meta[name="description"]');
if(description)bindAttribute(description,'content',msg('NOPE: Verini açığa çıkarmadan iş ver. Gizli teklif al, şifreli hesabı çalıştır ve teslimi kendi tarayıcında doğrula.'));
const scene=document.querySelector('.flow-scene');
const panel=document.querySelector('#flow-description');
const tabs=[...document.querySelectorAll('[data-flow]')];
const copy={
 client:[msg('Veriniz önce kendi bilgisayarınızda şifrelenir.'),msg('Tarayıcı tek kullanımlık gizli etiketler ve şifreli devre üretir. Açık kayıtlar ve sonuç eşlemesi buluta gönderilmez.')],
 cipher:[msg('Bulut, açık kayıtlarınızı almaz.'),msg('Yürütücü kodlanmış girdiyi ve şifreli devreyi işler. Sonucu anlamlandıran eşleme tarayıcınızda kalır.')],
 result:[msg('Şifreli cevap geri gelir. Açma işi sizdedir.'),msg('Tarayıcı sonucu açar ve kuralla karşılaştırır. Boş değer sıfır, 100 üzeri sayı 100 olur; diğer sütunlar korunur.')]
};
function activate(tab){
 const stage=tab.dataset.flow;
 if(!Object.hasOwn(copy,stage))return;
 scene.dataset.stage=stage;
 tabs.forEach(item=>{const active=item===tab;item.setAttribute('aria-selected',String(active));item.tabIndex=active?0:-1;});
 panel.setAttribute('aria-labelledby',tab.id);
 bindText(panel.querySelector('strong'),copy[stage][0]);
 bindText(panel.querySelector('p'),copy[stage][1]);
}
for(const tab of tabs){
 tab.addEventListener('click',()=>activate(tab));
 tab.addEventListener('keydown',event=>{
  const index=tabs.indexOf(tab);let next;
  if(event.key==='ArrowRight')next=(index+1)%tabs.length;
  else if(event.key==='ArrowLeft')next=(index+tabs.length-1)%tabs.length;
  else if(event.key==='Home')next=0;
  else if(event.key==='End')next=tabs.length-1;
  else return;
  event.preventDefault();activate(tabs[next]);tabs[next].focus();
 });
}
