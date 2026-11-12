import { MAX_BYTES, EXAMPLE_CSV, parseCSV, columnValues, verifyValues, exportCSV, validateEvidence, verifyEvidenceBundle } from './csv-input.mjs';

const $ = id => document.getElementById(id);
const state = { dataset: null, filename: '', column: null, values: null, caps: null, busy: false, anchoring: false, epoch: 0, controller: null, jobId: null, bundle: null, urls: [] };
const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(location.hostname);
const stages = { QUEUED: 'Sırada', ENCRYPTING: 'Şifreleniyor', EVALUATING: 'Şifreli hesaplama', VERIFYING: 'Yerel kontrol', COMPLETED: 'Tamamlandı', FAILED: 'Başarısız' };
function message(text, error = false) { $('message').textContent = text; $('message').dataset.error = String(error); }
function ready() { $('run').disabled = state.busy || state.anchoring || !state.values || !state.caps; $('column').disabled = state.busy || state.anchoring || !state.dataset; $('mode').disabled = state.busy || state.anchoring; $('file').disabled = state.anchoring; }
function revokeResults() {
  for (const url of state.urls) URL.revokeObjectURL(url);
  state.urls = []; state.bundle = null; state.jobId = null;
  for (const id of ['download', 'evidence-download']) $(id).removeAttribute('href');
  $('result').hidden = true; $('evidence-download').hidden = true; $('anchor').hidden = true;
  $('anchor-status').textContent = ''; $('proof-status').textContent = ''; $('retry-evidence').hidden = true;
}
function invalidate() {
  state.epoch++; state.controller?.abort(); state.controller = null; state.busy = false;
  revokeResults(); $('events').replaceChildren(); ready();
}
function blobLink(id, contents, type, name) {
  const url = URL.createObjectURL(new Blob([contents], { type })); state.urls.push(url);
  $(id).href = url; $(id).download = name; $(id).hidden = false;
}
function outputName(suffix) { return state.filename.replace(/\.csv$/i, '') + suffix; }
function preview() {
  const table = $('preview'); table.replaceChildren();
  if (!state.dataset) { $('preview-wrap').hidden = true; return; }
  const caption = document.createElement('caption'); caption.textContent = `${state.dataset.rows.length} veri satırı · ${state.dataset.headers.length} sütun · tüm satırlar`; table.append(caption);
  const head = document.createElement('thead'), body = document.createElement('tbody');
  for (const [i, row] of [state.dataset.headers, ...state.dataset.rows].entries()) {
    const tr = document.createElement('tr');
    row.forEach((cell, j) => { const td = document.createElement(i === 0 ? 'th' : 'td'); td.textContent = cell; if (i === 0) td.scope = 'col'; if (j === state.column) td.className = 'selected'; tr.append(td); });
    (i === 0 ? head : body).append(tr);
  }
  table.append(head, body); $('preview-wrap').hidden = false;
}
function validateColumn() {
  state.values = null;
  try {
    if (state.column === null) throw new Error('Temizlenecek sayısal sütunu seç.');
    state.values = columnValues(state.dataset, state.column);
    $('validation').textContent = `${state.values.length} değer hazır. Boş → 0; 100 üzeri → 100. Diğer sütunlar korunur.`;
    message(state.caps ? 'Hazır. Seçili sütunu müşteri istemcinde temizleyebilirsin.' : 'Önizleme hazır. Çalıştırmak için yerel istemcide bu dosyayı seç.');
  } catch (error) { $('validation').textContent = error.message; message(error.message, true); }
  preview(); ready();
}

async function api(path, options = {}, signal = undefined) {
  const response = await fetch(path, { ...options, signal, credentials: 'same-origin', cache: 'no-store', redirect: 'error' });
  if (!response.ok) { const error = new Error(`Yerel API işlemi tamamlanamadı (HTTP ${response.status}).`); error.status = response.status; throw error; }
  return response.json();
}
async function connect() {
  try {
    const caps = await api('/api/capabilities', {}, AbortSignal.timeout(10000));
    if (!loopback || typeof caps.csrfToken !== 'string' || !caps.csrfToken || caps.csrfToken.length > 512) throw new Error('Yerel oturum doğrulanamadı.');
    state.caps = caps; $('remote-option').disabled = !['configured','available'].includes(caps.evaluationModes?.remote?.status); $('connection').textContent = 'Yerel istemciye bağlı'; $('setup').hidden = true;
  } catch (error) {
    state.caps = null; $('setup').hidden = false;
    $('connection').textContent = error.status === 404 ? 'Web önizlemesi · yerel istemci gerekli' : 'Yerel istemci bağlantısı yok';
  }
  ready();
}

$('file').addEventListener('change', async () => {
  invalidate(); const epoch = state.epoch, file = $('file').files[0];
  state.dataset = null; state.values = null; state.column = null; state.filename = '';
  $('column').replaceChildren(new Option('Önce dosya seç', '')); preview(); ready();
  $('validation').textContent = 'Boş hücreler → 0 · 100 üzerindeki değerler → 100';
  $('file-info').textContent = '1–32 veri satırı, en fazla 16 sütun.';
  if (!file) { message('Dosya seçimini bekliyor.'); return; }
  try {
    if (file.size > MAX_BYTES) throw new Error('Dosya en fazla 64 KiB olabilir.');
    const bytes = await file.arrayBuffer();
    if (epoch !== state.epoch) return;
    const dataset = parseCSV(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
    state.dataset = dataset; state.filename = file.name;
    $('file-info').textContent = `${file.name} · ${dataset.rows.length} satır · ${dataset.headers.length} sütun`;
    $('column').replaceChildren(new Option('Sütun seç', ''), ...dataset.headers.map((h, i) => new Option(h, String(i))));
    message('Dosya açıldı. Temizlenecek sütunu seç.'); preview(); ready();
  } catch (error) { if (epoch === state.epoch) message(`Dosya açılamadı: ${error.message}`, true); }
});
$('column').addEventListener('change', () => { invalidate(); state.column = $('column').value === '' ? null : Number($('column').value); validateColumn(); });
$('mode').addEventListener('change', () => { invalidate(); if (state.dataset) validateColumn(); });
$('reset').addEventListener('click', () => {
  if (state.anchoring) return;
  invalidate(); state.dataset = null; state.filename = ''; state.values = null; state.column = null;
  $('file').value = ''; $('file-info').textContent = '1–32 veri satırı, en fazla 16 sütun.';
  $('column').replaceChildren(new Option('Önce dosya seç', '')); $('validation').textContent = 'Boş hücreler → 0 · 100 üzerindeki değerler → 100';
  preview(); ready(); message('Dosya ve sonuç temizlendi. Yeni dosya seçebilirsin.');
});
function showEvents(job) {
  if (!Array.isArray(job.events)) throw new Error('İşlem aşamaları alınamadı.');
  $('events').replaceChildren(...job.events.map(event => {
    const li = document.createElement('li'), title = document.createElement('strong');
    title.textContent = (Number.isInteger(event.batchIndex) ? `Parti ${event.batchIndex + 1} · ` : '') + (stages[event.stage] || String(event.stage));
    const detail = document.createElement('span'); detail.textContent = typeof event.message === 'string' ? event.message : '';
    li.append(title, detail); return li;
  }));
  message(stages[job.status] || `API durumu: ${job.status}`);
}
async function loadEvidence(epoch) {
  $('retry-evidence').hidden = true;
  try {
    const bundle = await api(`/api/csv/jobs/${encodeURIComponent(state.jobId)}/evidence`, {}, AbortSignal.timeout(15000));
    if (epoch !== state.epoch) return;
    await verifyEvidenceBundle(bundle, state.values.length, state.completedEvidence);
    if (epoch !== state.epoch) return;
    state.bundle = bundle;
    blobLink('evidence-download', JSON.stringify(bundle, null, 2) + '\n', 'application/json', outputName('-kanit.json'));
    $('proof-status').textContent = 'Şifreli artefakt manifestinin SHA-256 özeti tarayıcıda eşleşti. Bu, gizlilik ispatı değildir.';
    $('anchor').hidden = state.caps?.csvAnchorEnabled !== true || bundle.anchor != null;
    $('anchor-status').textContent = bundle.anchor ? 'Backend testnet kaydı bildirdi. Bağımsız zincir kontrolü için /verify sayfasını kullan.' : 'Henüz zincir kaydı bildirilmedi.';
    if (bundle.anchor && /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(bundle.anchor.transactionHash || '')) {
      const tx = document.createElement('a'); tx.textContent = ' Testnet işlemini aç ↗';
      tx.href = 'https://testnet.nearblocks.io/txns/' + bundle.anchor.transactionHash; tx.target = '_blank'; tx.rel = 'noreferrer noopener';
      $('anchor-status').append(tx);
    }
  } catch (error) {
    if (epoch !== state.epoch) return;
    $('proof-status').textContent = `CSV hazır; kanıt paketi alınamadı: ${error.message}`; $('retry-evidence').hidden = false;
  }
}
$('retry-evidence').addEventListener('click', () => loadEvidence(state.epoch));
$('run').addEventListener('click', async () => {
  if (state.busy || !state.caps || !state.values || !loopback) return;
  invalidate(); state.busy = true; const epoch = state.epoch;
  const controller = new AbortController(); state.controller = controller; ready(); message('Seçili değerler müşteri istemcisine gönderiliyor…');
  try {
    const input = columnValues(state.dataset, state.column);
    let job = await api('/api/csv/jobs', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': state.caps.csrfToken }, body: JSON.stringify({ values: input, mode: $('mode').value }) }, controller.signal);
    if (epoch !== state.epoch) return;
    if (typeof job.id !== 'string' || !/^[a-zA-Z0-9_-]{1,128}$/.test(job.id)) throw new Error('İşlem kimliği alınamadı.');
    const id = job.id;
    for (;;) {
      if (epoch !== state.epoch) return;
      if (job.id !== id) throw new Error('İşlem kimliği eşleşmiyor.');
      showEvents(job);
      if (job.status === 'FAILED') throw new Error(typeof job.error === 'string' ? job.error : 'Yerel hesaplama başarısız oldu.');
      if (job.status === 'COMPLETED') {
        if (!verifyValues(input, job.values) || !validateEvidence(job.evidence, input.length) || job.evidence.verified !== true || job.evidence.realFhe !== true) throw new Error('Tamamlanan sonuç veya gerçek hesaplama kanıtı doğrulanamadı; indirme açılmadı.');
        const csv = exportCSV(state.dataset, state.column, job.values);
        blobLink('download', csv, 'text/csv;charset=utf-8', outputName('-temiz.csv'));
        state.jobId = id; state.completedEvidence = job.evidence; $('result').hidden = false;
        message('Tamamlandı. Tüm satırlar temizleme profiliyle eşleşti.');
        await loadEvidence(epoch); break;
      }
      await new Promise(resolve => setTimeout(resolve, 1500));
      if (epoch !== state.epoch) return;
      job = await api(`/api/csv/jobs/${encodeURIComponent(id)}`, {}, controller.signal);
    }
  } catch (error) { if (epoch === state.epoch) message(error.message, true); }
  finally { if (epoch === state.epoch) { state.busy = false; ready(); } }
});
$('anchor').addEventListener('click', async () => {
  if (state.anchoring || state.caps?.csvAnchorEnabled !== true || !state.bundle || !state.jobId) return;
  state.anchoring = true; $('anchor').disabled = true; $('reset').disabled = true; ready();
  const epoch = state.epoch;
  $('anchor-status').textContent = 'Yalnızca testnette manifest özeti kaydediliyor…';
  try {
    await api(`/api/csv/jobs/${encodeURIComponent(state.jobId)}/anchor`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': state.caps.csrfToken }, body: '{}' });
    await loadEvidence(epoch);
  } catch (error) { $('anchor-status').textContent = `Testnet kaydı tamamlanamadı: ${error.message}`; }
  finally { state.anchoring = false; $('anchor').disabled = false; $('reset').disabled = false; ready(); }
});
const exampleURL = URL.createObjectURL(new Blob(['\uFEFF' + EXAMPLE_CSV], { type: 'text/csv;charset=utf-8' }));
$('example').href = exampleURL; $('example').download = 'nope-sentetik-ornek.csv';
window.addEventListener('pagehide', () => { invalidate(); URL.revokeObjectURL(exampleURL); });
connect();
