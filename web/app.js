import { EXAMPLE_RECORDS, DEFAULT_TITLE, validateRecords, parseCSV, toCSV, capabilityReady, metricText } from './input.mjs';
import { loadDeployment } from './deployment.mjs';

const $ = id => document.getElementById(id);
const STAGES = [
  ['QUEUED', 'Sıraya alındı', 'Yerel istemci işlemi hazırlıyor.'],
  ['ENCRYPTING', 'Şifreleniyor', 'Girdi yerel istemcide şifreleniyor.'],
  ['EVALUATING', 'Hesaplanıyor', 'Ayrı değerlendirici şifreli veriyi işliyor.'],
  ['VERIFYING', 'Doğrulanıyor', 'Sonuç yerelde açılıp karşılaştırılıyor.'],
  ['COMPLETED', 'Tamamlandı', 'Sonuç ve doğrulama durumu hazır.'],
];
const LABELS = Object.fromEntries([...STAGES.map(([key, label]) => [key, label]), ['FAILED', 'Başarısız']]);
const ACTIVE = new Set(['QUEUED', 'ENCRYPTING', 'EVALUATING', 'VERIFYING']);
const state = { capabilities: null, jobs: [], selected: null, inputs: new Map(), mode: 'rows', busy: false, refreshing: false, timer: null, disposed: false };
let deployment = null;
const rowInputs = [];
const capabilityRefreshes = new Set();
let capabilityRequest = null;
const el = (tag, text, className) => {
  const node = document.createElement(tag);
  if (text !== undefined) node.textContent = String(text);
  if (className) node.className = className;
  return node;
};
function message(text = '', error = false) {
  $('global-message').textContent = text;
  $('global-message').className = `message${error ? ' message-error' : ''}`;
  $('global-message').hidden = !text;
}
function dateText(value) {
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? new Intl.DateTimeFormat('tr-TR', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit', second: '2-digit' }).format(date) : 'Zaman bildirilmedi';
}
function durationText(milliseconds) {
  const seconds = Math.max(0, Math.round(milliseconds / 1000));
  return seconds < 60 ? `${seconds} sn` : `${Math.floor(seconds / 60)} dk ${seconds % 60} sn`;
}
async function request(path, options = {}) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15000);
  try {
    const response = await fetch(path, { credentials: 'same-origin', cache: 'no-store', ...options, signal: controller.signal });
    let body;
    try { body = await response.json(); } catch { throw new Error(`Yerel istemci geçerli JSON döndürmedi (HTTP ${response.status}).`); }
    if (!response.ok) throw new Error(typeof body?.error === 'string' ? body.error : `HTTP ${response.status}`);
    return body;
  } catch (error) {
    if (error.name === 'AbortError') throw new Error('Yerel istemci 15 saniye içinde yanıt vermedi.');
    throw error;
  } finally { clearTimeout(timeout); }
}
function checkJob(job) {
  if (!job || typeof job.id !== 'string' || !(job.status in LABELS)) throw new Error('İstemciden beklenen işlem biçimi alınamadı.');
  return job;
}
function readInput() {
  return state.mode === 'csv' ? parseCSV($('csv-input').value) : validateRecords(rowInputs.map(row => ({ id: row.id.value, value: row.value.value })));
}
function validate() {
  const checked = readInput();
  for (const row of rowInputs) for (const input of Object.values(row)) input.removeAttribute('aria-invalid');
  $('csv-input').removeAttribute('aria-invalid');
  if (!checked.valid) {
    if (state.mode === 'csv') $('csv-input').setAttribute('aria-invalid', 'true');
    else for (const error of checked.errors) rowInputs[error.row]?.[error.field]?.setAttribute('aria-invalid', 'true');
  }
  $('validation').className = `validation${checked.valid ? '' : ' invalid'}`;
  if (checked.valid) {
    const ids = new Set();
    let repeated = 0;
    for (const record of checked.records) { if (ids.has(record.id)) repeated++; ids.add(record.id); }
    $('validation').textContent = `4 kayıt hazır.${repeated ? ` ${repeated} sonraki kayıt yinelenen kimlik olarak işaretlenecek.` : ' Tüm alanlar geçerli.'}`;
  } else $('validation').textContent = checked.errors.map(error => error.message).join(' ');
  $('submit-job').disabled = !checked.valid || state.busy || !capabilityReady(state.capabilities);
  return checked;
}
function loadExample() {
  EXAMPLE_RECORDS.forEach((record, index) => {
    for (const field of ['id', 'value']) rowInputs[index][field].value = record[field];
  });
  $('csv-input').value = toCSV(EXAMPLE_RECORDS);
  validate();
}
function setupRows() {
  for (let index = 0; index < 4; index++) {
    const tr = el('tr');
    const label = el('th', String(index + 1).padStart(2, '0'));
    label.scope = 'row'; tr.append(label);
    const inputs = {};
    for (const field of ['id', 'value']) {
      const td = el('td');
      const input = el('input');
      input.type = 'text'; input.inputMode = 'numeric'; input.maxLength = 3;
      input.autocomplete = 'off'; input.spellcheck = false;
      input.setAttribute('aria-label', `${index + 1}. kayıt ${field === 'id' ? 'kimlik' : 'değer'}`);
      input.setAttribute('aria-describedby', 'validation');
      input.addEventListener('input', validate);
      inputs[field] = input; td.append(input); tr.append(td);
    }
    rowInputs.push(inputs); $('record-rows').append(tr);
  }
}
function switchMode(mode, focus = false) {
  if (mode === state.mode) return;
  const checked = readInput();
  if (!checked.valid) {
    validate();
    message('Biçim değiştirmeden önce girdideki hataları düzeltin.', true);
    if (state.mode === 'csv') $('csv-input').focus();
    else rowInputs[checked.errors[0]?.row]?.[checked.errors[0]?.field]?.focus();
    return;
  }
  if (mode === 'csv') $('csv-input').value = toCSV(checked.records);
  else checked.records.forEach((record, index) => { for (const field of ['id', 'value']) rowInputs[index][field].value = record[field]; });
  state.mode = mode;
  for (const tabMode of ['rows', 'csv']) {
    const selected = tabMode === mode;
    $(`${tabMode}-tab`).setAttribute('aria-selected', String(selected));
    $(`${tabMode}-tab`).tabIndex = selected ? 0 : -1;
    $(`${tabMode}-panel`).hidden = !selected;
  }
  validate(); message();
  if (focus) $(`${mode}-tab`).focus();
}
function setConnection(text, connected) {
  $('connection').textContent = text;
  $('connection').className = `status-pill ${connected ? 'connected' : 'disconnected'}`;
}
function renderCapabilities() {
  const data = state.capabilities;
  $('capabilities').replaceChildren();
  $('capability-version').textContent = data ? `Sürüm: ${data.version ?? 'bildirilmedi'} · Profil: ${data.profile?.id ?? 'bildirilmedi'}` : '';
  if (!data || !Array.isArray(data.capabilities) || !data.capabilities.length) {
    $('capabilities').append(el('p', data ? 'İstemci yetenek ayrıntısı bildirmedi.' : 'Yetenek bilgisi alınamadı. Bağlantıyı yenileyin.'));
    return;
  }
  for (const capability of data.capabilities) {
    const item = el('article', undefined, 'capability');
    const top = el('div', undefined, 'capability-top');
    top.append(el('strong', capability.label ?? capability.id ?? 'Yetenek'), el('span', capability.status ?? 'bilinmiyor', 'quiet-badge'));
    item.append(top, el('p', capability.detail ?? 'Ayrıntı bildirilmedi.'));
    $('capabilities').append(item);
  }
}
// Recheck after completion and on inspection; never poll capabilities continuously.
function refreshCapabilities() {
  if (deployment?.mode !== 'local') return Promise.resolve();
  if (capabilityRequest) return capabilityRequest;
  $('capability-version').textContent = 'Yetenek bilgisi güncelleniyor…';
  capabilityRequest = request('/api/capabilities').then(data => {
    state.capabilities = data;
    renderCapabilities();
    setConnection(capabilityReady(data) ? 'Yerel istemciye bağlı' : 'Profil veya oturum uyumsuz', capabilityReady(data));
    validate();
  }).catch(error => {
    $('capability-version').textContent = `Yetenek bilgisi güncellenemedi: ${error.message} Önceki bilgi gösteriliyor; yeniden açarak deneyin.`;
  }).finally(() => { capabilityRequest = null; });
  return capabilityRequest;
}
function renderHistory() {
  $('history-count').textContent = String(state.jobs.length);
  $('job-history').replaceChildren();
  if (!state.jobs.length) { $('job-history').append(el('p', 'Henüz bir işlem yok. İlk dört kayıtla başlayın.', 'panel-description')); return; }
  const sorted = [...state.jobs].sort((a, b) => String(b.createdAt ?? '').localeCompare(String(a.createdAt ?? '')));
  for (const job of sorted) {
    const button = el('button', undefined, 'history-item'); button.type = 'button';
    button.setAttribute('aria-pressed', String(job.id === state.selected?.id));
    const copy = el('span'); copy.append(el('strong', job.title || 'Adsız işlem'), el('small', dateText(job.createdAt)));
    button.append(copy, el('span', LABELS[job.status], `quiet-badge${job.status === 'FAILED' ? ' failure' : job.status === 'COMPLETED' ? ' success' : ''}`));
    button.addEventListener('click', () => selectJob(job)); $('job-history').append(button);
  }
}
function renderStages() {
  const job = state.selected;
  const activeIndex = job ? STAGES.findIndex(([key]) => key === job.status) : -1;
  const events = Array.isArray(job?.events) ? job.events : [];
  const lastStage = [...events].reverse().find(event => STAGES.some(([key]) => key === event.stage));
  const failedIndex = job?.status === 'FAILED' ? Math.max(0, STAGES.findIndex(([key]) => key === lastStage?.stage)) : -1;
  $('stages').replaceChildren();
  for (const [index, [key, label, description]] of STAGES.entries()) {
    const isDone = job?.status === 'COMPLETED' || index < activeIndex || (failedIndex >= 0 && index < failedIndex);
    const isActive = index === activeIndex && job?.status !== 'COMPLETED';
    const failed = index === failedIndex;
    const li = el('li', undefined, `stage${isDone ? ' done' : isActive ? ' active' : failed ? ' failed' : ''}`);
    if (isActive || failed) li.setAttribute('aria-current', 'step');
    li.append(el('span', isDone ? '✓' : failed ? '!' : String(index + 1).padStart(2, '0'), 'stage-dot'));
    const copy = el('div', undefined, 'stage-copy');
    copy.append(el('h3', label), el('p', description)); li.append(copy); $('stages').append(li);
  }
}
function renderResult() {
  const job = state.selected;
  const result = job?.result;
  const validRecords = result && validateRecords(result.records).valid && result.records.every(record => typeof record.duplicate === 'boolean');
  const hasResult = job?.status === 'COMPLETED' && validRecords;
  $('result-empty').hidden = Boolean(hasResult); $('result-content').hidden = !hasResult;
  $('result-rows').replaceChildren();
  const badge = $('verified-badge'); badge.className = 'quiet-badge';
  if (!hasResult) {
    badge.textContent = job?.status === 'COMPLETED' ? 'Sonuç bulunamadı' : job?.status === 'FAILED' ? 'İşlem başarısız' : 'Sonuç bekleniyor';
    if (job?.status === 'COMPLETED') $('result-empty').querySelector('h3').textContent = 'İstemci bu işlem için kullanılabilir sonuç döndürmedi.';
    else $('result-empty').querySelector('h3').textContent = 'Karşılaştırma için bir işlem başlatın.';
    return;
  }
  const verified = result.verified === true;
  badge.textContent = verified ? 'Referansla eşleşti' : 'Doğrulanmadı';
  badge.classList.add(verified ? 'success' : 'failure');
  const input = state.inputs.get(job.id);
  $('result-note').textContent = input ? 'Girdi ile yerel istemcinin döndürdüğü sonuç karşılaştırılıyor.' : 'Önceki girdiler bu tarayıcı oturumunda yok. Yalnızca istemcinin döndürdüğü sonuç gösteriliyor.';
  result.records.forEach((record, index) => {
    const tr = el('tr');
    for (const value of [String(index + 1).padStart(2, '0'), record.id, input?.[index]?.value ?? '—', record.value]) tr.append(el('td', value));
    const duplicate = el('td'); duplicate.append(el('span', record.duplicate ? 'Evet · sonraki kayıt' : 'Hayır', record.duplicate ? 'duplicate-tag' : 'no-duplicate')); tr.append(duplicate);
    $('result-rows').append(tr);
  });
}
function renderData(id, data, empty) {
  $(id).replaceChildren();
  if (!data || typeof data !== 'object' || !Object.keys(data).length) { $(id).append(el('dt', empty)); return; }
  for (const [key, value] of Object.entries(data)) $(id).append(el('dt', key), el('dd', metricText(key, value)));
}
function renderAudit() {
  const job = state.selected;
  $('audit-job-name').textContent = job ? `${job.title || 'Adsız işlem'} · ${job.id}` : 'Henüz bir işlem seçilmedi.';
  $('audit-events').replaceChildren();
  if (!job?.events?.length) $('audit-events').append(el('li', 'İstemci aşama kaydı bildirmedi.'));
  else for (const event of job.events) {
    const li = el('li');
    const time = el('time', dateText(event.at));
    if (typeof event.at === 'string' && Number.isFinite(Date.parse(event.at))) time.dateTime = event.at;
    li.append(el('strong', LABELS[event.stage] ?? event.stage ?? 'Aşama'), time, el('span', event.message ?? ''));
    $('audit-events').append(li);
  }
  renderData('audit-metrics', job?.metrics, 'Metrik bildirilmedi.');
  renderData('audit-hashes', job?.artifactHashes, 'Artefakt özeti bildirilmedi.');
}
function renderSelected() {
  const job = state.selected;
  $('job-status').textContent = job ? LABELS[job.status] : 'Hazır';
  $('job-status').className = `quiet-badge${job?.status === 'FAILED' ? ' failure' : job?.status === 'COMPLETED' ? ' success' : ''}`;
  $('job-summary').textContent = job ? `${job.title || 'Adsız işlem'} · ${job.id}` : 'Bir işlem başlattığınızda gerçek aşamalar burada görünür.';
  $('job-audit').disabled = !job;
  $('job-error').hidden = job?.status !== 'FAILED';
  $('job-error').textContent = job?.status === 'FAILED' ? (job.error || 'İstemci hata ayrıntısı bildirmedi.') : '';
  const start = Date.parse(job?.createdAt); const end = ACTIVE.has(job?.status) ? Date.now() : Date.parse(job?.updatedAt);
  $('job-time').textContent = Number.isFinite(start) && Number.isFinite(end) ? `Toplam geçen: ${durationText(end - start)}` : 'Henüz zaman ölçümü yok.';
  renderStages(); renderResult(); renderAudit();
  if (job?.status === 'COMPLETED' && !capabilityRefreshes.has(job.id)) {
    capabilityRefreshes.add(job.id);
    refreshCapabilities();
  }
}
function upsertJob(job) {
  const index = state.jobs.findIndex(item => item.id === job.id);
  if (index < 0) state.jobs.unshift(job); else state.jobs[index] = job;
}
let selectionVersion = 0;
async function selectJob(job) {
  const version = ++selectionVersion;
  state.selected = job; renderSelected(); renderHistory();
  try {
    const response = await request(`/api/jobs/${encodeURIComponent(job.id)}`);
    const current = checkJob(response.job);
    if (current.id !== job.id) throw new Error('İşlem kimliği yanıtla eşleşmedi.');
    if (version !== selectionVersion) return;
    state.selected = current; upsertJob(current); renderSelected(); renderHistory();
  } catch (error) { if (version === selectionVersion) message(`İşlem alınamadı: ${error.message}`, true); }
  schedulePoll();
}
function schedulePoll() {
  clearTimeout(state.timer);
  if (deployment?.mode !== 'local') return;
  if (!state.disposed && (ACTIVE.has(state.selected?.status) || state.jobs.some(job => ACTIVE.has(job.status)))) state.timer = setTimeout(poll, 1800);
}
async function poll() {
  if (state.disposed) return;
  const version = selectionVersion;
  const selectedId = state.selected?.id;
  try {
    const response = await request('/api/jobs');
    if (!Array.isArray(response.jobs)) throw new Error('İşlem listesi alınamadı.');
    state.jobs = response.jobs.map(checkJob);
    if (selectedId && version === selectionVersion) {
      const current = await request(`/api/jobs/${encodeURIComponent(selectedId)}`);
      if (version === selectionVersion) {
        const job = checkJob(current.job);
        if (job.id !== selectedId) throw new Error('İşlem kimliği yanıtla eşleşmedi.');
        state.selected = job; upsertJob(job); renderSelected();
      }
    }
    renderHistory();
    if ($('global-message').dataset.pollError === 'true') { message(); delete $('global-message').dataset.pollError; }
  } catch (error) {
    message(`Durum güncellenemedi: ${error.message} Yeniden denenecek.`, true);
    $('global-message').dataset.pollError = 'true';
  } finally { schedulePoll(); }
}
async function refresh() {
  if (deployment?.mode !== 'local') return;
  if (state.refreshing) return;
  state.refreshing = true; $('refresh').disabled = true;
  setConnection('Yerel istemci kontrol ediliyor', false);
  const results = await Promise.allSettled([request('/api/capabilities'), request('/api/jobs')]);
  const [capabilities, jobs] = results;
  const errors = [];
  if (capabilities.status === 'fulfilled') {
    state.capabilities = capabilities.value;
    if (capabilityReady(state.capabilities)) setConnection('Yerel istemciye bağlı', true);
    else { setConnection('Profil veya oturum uyumsuz', false); errors.push('Beklenen dört kayıt profili veya CSRF oturumu alınamadı.'); }
  } else { state.capabilities = null; setConnection('Yerel istemciye ulaşılamıyor', false); errors.push(capabilities.reason.message); }
  if (jobs.status === 'fulfilled') {
    try {
      if (!Array.isArray(jobs.value.jobs)) throw new Error('İstemci geçerli işlem listesi döndürmedi.');
      state.jobs = jobs.value.jobs.map(checkJob);
      if (!state.selected && state.jobs.length) state.selected = [...state.jobs].sort((a, b) => String(b.createdAt ?? '').localeCompare(String(a.createdAt ?? '')))[0];
      renderHistory();
    } catch (error) { errors.push(error.message); }
  } else { errors.push(jobs.reason.message); }
  if (errors.length && !state.jobs.length) $('job-history').replaceChildren(el('p', 'Geçmiş alınamadı. Bağlantıyı yenileyin.', 'panel-description'));
  renderCapabilities(); renderSelected(); validate();
  message(errors.join(' '), errors.length > 0);
  state.refreshing = false; $('refresh').disabled = false;
  if (state.selected) await selectJob(state.selected);
  schedulePoll();
}
async function submit(event) {
  event.preventDefault();
  if (deployment?.mode !== 'local') return;
  const checked = validate();
  if (!checked.valid) {
    if (state.mode === 'csv') $('csv-input').focus();
    else rowInputs[checked.errors[0]?.row]?.[checked.errors[0]?.field]?.focus();
    return;
  }
  if (state.busy || !capabilityReady(state.capabilities)) return;
  const title = $('job-title').value.trim() || DEFAULT_TITLE;
  const records = checked.records.map(record => ({ ...record }));
  state.busy = true; validate(); message('İşlem yerel istemciye gönderiliyor…');
  try {
    const response = await request('/api/jobs', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': state.capabilities.csrfToken }, body: JSON.stringify({ title, records }) });
    const job = checkJob(response.job);
    selectionVersion++;
    state.inputs.set(job.id, records); state.selected = job; upsertJob(job);
    renderSelected(); renderHistory(); message('İşlem oluşturuldu. Aşamalar otomatik güncellenir.');
    schedulePoll();
  } catch (error) { message(`İşlem isteği tamamlanamadı: ${error.message} Yeniden göndermeden önce geçmişi yenileyin.`, true); }
  finally { state.busy = false; validate(); }
}
function openAudit() {
  renderAudit();
  if (!$('audit-dialog').open) { $('audit-dialog').showModal(); document.body.style.overflow = 'hidden'; }
  refreshCapabilities();
}
setupRows(); loadExample(); renderSelected(); renderAudit();
$('job-form').addEventListener('submit', submit);
$('csv-input').addEventListener('input', validate);
$('reset-example').addEventListener('click', () => { loadExample(); message('Sentetik örnek yeniden yüklendi.'); });
for (const mode of ['rows', 'csv']) {
  $(`${mode}-tab`).addEventListener('click', () => switchMode(mode));
  $(`${mode}-tab`).addEventListener('keydown', event => {
    if (['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) {
      event.preventDefault();
      switchMode(event.key === 'Home' ? 'rows' : event.key === 'End' ? 'csv' : mode === 'rows' ? 'csv' : 'rows', true);
    }
  });
}
$('csv-file').addEventListener('change', async event => {
  const file = event.target.files?.[0];
  if (!file) return;
  try {
    if (file.size > 65536) throw new Error('CSV dosyası en fazla 64 KiB olabilir.');
    const text = await file.text();
    $('csv-input').value = text;
    validate(); message('CSV yerelde okundu. Gönderilmeden önce doğrulanır.');
  } catch (error) { message(error.message, true); }
  finally { event.target.value = ''; }
});
for (const id of ['open-audit', 'job-audit', 'footer-audit']) $(id).addEventListener('click', openAudit);
$('close-audit').addEventListener('click', () => $('audit-dialog').close());
$('audit-dialog').addEventListener('close', () => { document.body.style.overflow = ''; });
$('audit-dialog').addEventListener('click', event => { if (event.target === $('audit-dialog')) { const bounds = event.target.getBoundingClientRect(); if (event.clientX < bounds.left || event.clientX > bounds.right) event.target.close(); } });
$('refresh').addEventListener('click', () => deployment ? refresh() : bootstrap());
window.addEventListener('pagehide', () => { state.disposed = true; clearTimeout(state.timer); });
window.addEventListener('pageshow', event => { if (event.persisted) { state.disposed = false; refresh(); } });
async function bootstrap() {
  $('refresh').disabled = true;
  try {
    deployment = await loadDeployment();
    if (deployment.mode === 'hosted-evidence') {
      $('hosted-app').hidden = false;
      document.querySelector('.workspace-grid').hidden = true;
      $('refresh').hidden = true;
      setConnection('Yayında salt okunur · yerelde çalışır', true);
      message();
      return;
    }
    await refresh();
  } catch (error) {
    setConnection('Çalışma modu belirlenemedi', false);
    message(`${error.message} Veri gönderilmedi.`, true);
    $('refresh').disabled = false;
  }
}
bootstrap();

if (location.hash === '#audit') openAudit();
