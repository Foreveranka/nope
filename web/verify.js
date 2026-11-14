import {boundedPublicJSON,validatePublicEvidence,verifyPublicChainBinding} from './public-proof.mjs';
import {initI18n,setLanguage,localizeDocument,mountLanguagePicker,msg,bindText} from './i18n.mjs';

// Select/localize first: a query-string job must not begin automatic verification
// before the initial static UI and language picker are ready.
try{await initI18n({document,window});}
catch{setLanguage('en',{persist:false});}
localizeDocument(document);
mountLanguagePicker({document,window});
const localizedError=message=>Object.assign(new Error(String(message)),{localizedMessage:message});
const $=id=>document.getElementById(id);

// New v4 route: obtain only public ciphertext evidence and independently verify
// its real proof. A hosted `verified` field never establishes this result.
let resultEpoch=0,resultWorker=null,resultTimer=null,resultAbort=null,resultReject=null;
function stopResultWork(){const reject=resultReject;resultReject=null;resultWorker?.terminate();resultWorker=null;clearTimeout(resultTimer);resultTimer=null;resultAbort?.abort();resultAbort=null;reject?.(localizedError(msg('Doğrulama iptal edildi.')));}
function proofInBrowser(evidence,current){return new Promise((resolve,reject)=>{
 const w=new Worker('/proof-worker.mjs',{type:'module'});resultWorker=w;resultReject=reject;
 const finish=()=>{clearTimeout(resultTimer);resultTimer=null;w.terminate();if(resultWorker===w){resultWorker=null;resultReject=null;}};
 resultTimer=setTimeout(()=>{finish();reject(localizedError(msg('Doğrulama zaman sınırına ulaştı; kanıt onaylanmadı.')));},300000);
 w.onmessage=({data})=>{
  if(current!==resultEpoch){finish();return;}
  if(data?.type==='progress'){
   if(Number.isSafeInteger(data.completed)&&Number.isSafeInteger(data.total)&&data.total>0&&data.completed>=0&&data.completed<=data.total)
    bindText($('result-status'),msg`Sonuç kanıtı bu tarayıcıda doğrulanıyor · ${data.completed}/${data.total} satır.`);
  }else if(data?.type==='verified'&&data.valid===true){finish();resolve();}
  else{finish();reject(localizedError(msg('Sonuç kanıtı bu teslim için doğrulanamadı.')));}
 };
 w.onerror=()=>{finish();reject(localizedError(msg('Bu tarayıcıda sonuç doğrulayıcısı çalıştırılamadı.')));};
 w.postMessage({type:'verify',request:evidence.task,delivery:evidence.delivery,binding:evidence.binding,bundle:evidence.bundle});
});}
$('result-cancel').onclick=()=>{resultEpoch++;stopResultWork();$('result-check').disabled=false;$('result-cancel').hidden=true;bindText($('result-status'),msg('Doğrulama iptal edildi; kanıt onaylanmadı.'));};
$('result-proof-form').onsubmit=async event=>{
 event.preventDefault();const jobId=$('result-job-id').value.trim();if(!/^[a-f0-9]{32}$/.test(jobId)){ bindText($('result-status'),msg('32 karakterli geçerli bir iş kimliği yaz.'));return;}
 const current=++resultEpoch;stopResultWork();$('result-check').disabled=true;$('result-cancel').hidden=false;$('result-details').hidden=true;$('result-details').textContent='';
 bindText($('result-status'),msg('Herkese açık şifreli kayıt ve sonuç kanıtı alınıyor…'));
 try{
  const controller=new AbortController();resultAbort=controller;const timeout=setTimeout(()=>controller.abort(),30000);let evidence;
  try{const response=await fetch('/api/workspace?'+new URLSearchParams({route:'jobs/'+jobId+'/proof/evidence'}),{cache:'no-store',signal:controller.signal});evidence=validatePublicEvidence(await boundedPublicJSON(response,5*1024*1024),jobId);}finally{clearTimeout(timeout);}
  if(current!==resultEpoch)return;
  if(evidence.jobId!==jobId)throw localizedError(msg('Dönen kanıt istenen işe ait değil; doğrulama durduruldu.'));
  bindText($('result-status'),msg('Şifreli girdi, ön taahhüt ve son teslim kesinleşmiş testnet kaydından karşılaştırılıyor…'));
  const chain=await verifyPublicChainBinding(evidence);if(current!==resultEpoch)return;
  bindText($('result-status'),msg('Zincir bağı eşleşti. Gerçek sonuç kanıtı bu tarayıcıda doğrulanıyor…'));
  await proofInBrowser(evidence,current);if(current!==resultEpoch)return;
  bindText($('result-status'),msg('Bağımsız sonuç kanıtı ve kesinleşmiş zincir bağı doğrulandı. CSV veya gizli eşleme açılmadı.'));
  $('result-details').textContent=JSON.stringify({jobId,relation:'Önceden sabitlenen eşleme altında onaylı işlemin doğru sonucu',...chain,proofRows:evidence.bundle.rows.length},null,2);$('result-details').hidden=false;
  const url=new URL(location.href);url.searchParams.set('id',jobId);history.replaceState({},'',url);
 }catch(error){if(current===resultEpoch)bindText($('result-status'),error?.name==='AbortError'?msg('Kayıt alınamadı; sonuç kanıtı onaylanmadı.'):error?.localizedMessage||msg(error?.message||'Doğrulama tamamlanamadı.'));}
 finally{if(current===resultEpoch){stopResultWork();$('result-check').disabled=false;$('result-cancel').hidden=true;}}
};
const resultId=new URL(location.href).searchParams.get('id');if(resultId&&/^[a-f0-9]{32}$/.test(resultId)){ $('result-job-id').value=resultId;$('result-proof-form').requestSubmit();}
