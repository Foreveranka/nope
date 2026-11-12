const root=document.getElementById('result');
const el=(tag,text)=>{const n=document.createElement(tag);n.textContent=text;return n;};
try{
 const response=await fetch('/testnet-evidence.json',{cache:'no-store',credentials:'omit'});
 if(!response.ok)throw Error('Kayıt henüz yayımlanmadı.');
 const data=await response.json();
 if(data.schema!==1||data.network!=='testnet'||data.completed!==true||!Array.isArray(data.transactions))throw Error('Doğrulama kaydı geçersiz.');
 root.replaceChildren(el('h2',`İş #${data.jobId} · teslim kabul edildi`));
 root.append(el('p',`Gerçek FHE ve yerel MPC ile işlendi. ${data.checksPassed} bağlama ve sonuç kontrolü geçti.`));
 root.append(el('p',data.payment?.verified?'Test NEAR ödemesi: sözleşmeden sağlayıcıya aktarım makbuzu doğrulandı. Tutar herkese açık, sabit bir test bedelidir; gizli kazanan teklifin ödendiği ispatlanmış değildir.':'Bu kayıtta doğrulanmış ödeme yok.'));
 const list=document.createElement('ol');
 for(const item of data.transactions){
  if(typeof item.hash!=='string'||!/^\w{32,64}$/.test(item.hash))throw Error('İşlem kimliği geçersiz.');
  const li=document.createElement('li'),a=el('a',item.label+' — '+item.hash.slice(0,10)+'…');
  a.href='https://testnet.nearblocks.io/txns/'+encodeURIComponent(item.hash);a.target='_blank';a.rel='noopener noreferrer';li.append(a);list.append(li);
 }
 root.append(list);
}catch(error){root.replaceChildren(el('p',error.message));}
