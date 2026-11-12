// A local explanatory diagram, never a computation or network request.
const scene=document.querySelector('.flow-scene');
const panel=document.querySelector('#flow-description');
const tabs=[...document.querySelectorAll('[data-flow]')];
const copy={
 client:['Veriniz önce kendi bilgisayarınızda şifrelenir.','Tarayıcı tek kullanımlık gizli etiketler ve şifreli devre üretir. Açık kayıtlar ve sonuç eşlemesi buluta gönderilmez.'],
 cipher:['Bulut, açık kayıtlarınızı almaz.','Yürütücü kodlanmış girdiyi ve şifreli devreyi işler. Sonucu anlamlandıran eşleme tarayıcınızda kalır.'],
 result:['Şifreli cevap geri gelir. Açma işi sizdedir.','Tarayıcı sonucu açar ve kuralla karşılaştırır. Boş değer sıfır, 100 üzeri sayı 100 olur; diğer sütunlar korunur.']
};
function activate(tab){
 const stage=tab.dataset.flow;
 if(!Object.hasOwn(copy,stage))return;
 scene.dataset.stage=stage;
 tabs.forEach(item=>{const active=item===tab;item.setAttribute('aria-selected',String(active));item.tabIndex=active?0:-1;});
 panel.setAttribute('aria-labelledby',tab.id);
 panel.querySelector('strong').textContent=copy[stage][0];
 panel.querySelector('p').textContent=copy[stage][1];
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
