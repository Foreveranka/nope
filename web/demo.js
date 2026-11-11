import { loadDeployment, checkCounts, recordedRun } from './deployment.mjs';

const $ = id => document.getElementById(id);
const state = { mode: null, token: null, run: null, known: false, loading: false, submitting: false, disposed: false, timer: null, version: 0 };
const LABELS = { running: 'Çalışıyor', completed: 'Tamamlandı', failed: 'Başarısız' };
const STAGES = {
  prepared: 'FHE girdisi ve anahtar bağlamaları hazır', registered: 'İş yerel NEAR sandbox’a kaydedildi',
  bids_closed: 'Sentetik teklifler kapandı', mpc_completed: 'MPC seçimi tamamlandı',
  executor_selected: 'Yürütücü seçildi', payment_held_fixture: 'Test ödemesi tutuldu · fixture',
  execution_bound: 'Kayıt ve yürütme girişimi bağlandı', evaluated: 'Şifreli değerlendirme tamamlandı',
  client_verified: 'İstemci referans kontrolü geçti', reported: 'Sonuç makbuzu bildirildi',
  accepted: 'Kayıt defterinde sonuç kabul edildi', payment_released_fixture: 'Test ödemesi serbest bırakıldı · fixture',
};
function el(tag, text, className) {
  const node = document.createElement(tag);
  if (text !== undefined) node.textContent = String(text);
  if (className) node.className = className;
  return node;
}
function seconds(value) {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
    ? `${new Intl.NumberFormat('tr-TR', { maximumFractionDigits: 1 }).format(value)} sn` : 'Süre bildirilmedi';
}
function message(text = '', error = false) {
  $('demo-message').textContent = text;
  $('demo-message').hidden = !text;
  $('demo-message').className = `message${error ? ' message-error' : ''}`;
}
async function request(path, options = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15000);
  try {
    const response = await fetch(path, { credentials: 'same-origin', cache: 'no-store', ...options, signal: controller.signal });
    let data;
    try { data = await response.json(); } catch { throw new Error(`Geçerli JSON alınamadı (HTTP ${response.status}).`); }
    if (!response.ok) {
      const error = new Error(typeof data?.error === 'string' ? data.error : `HTTP ${response.status}`);
      error.status = response.status;
      throw error;
    }
    return data;
  } catch (error) {
    if (error.name === 'AbortError') throw new Error('Durum isteği 15 saniye içinde yanıtlanmadı.');
    throw error;
  } finally { clearTimeout(timer); }
}
function checkRun(run) {
  if (run === null) return null;
  if (!run || typeof run.id !== 'string' || !Object.hasOwn(LABELS, run.status) || !Array.isArray(run.events) ||
    run.events.some(event => !event || typeof event.stage !== 'string' || typeof event.elapsed_seconds !== 'number' || !Number.isFinite(event.elapsed_seconds) || event.elapsed_seconds < 0)) {
    throw new Error('Demo yanıtının biçimi beklenenle eşleşmiyor.');
  }
  return run;
}
function controls() {
  const hosted = state.mode === 'hosted-evidence';
  const active = state.run?.status === 'running';
  $('demo-start').disabled = hosted || state.mode !== 'local' || !state.known || !state.token || state.loading || state.submitting || active;
  $('demo-start').textContent = hosted ? 'Yerel ortamda çalıştırılır' : state.submitting ? 'Başlatılıyor…' : active ? 'Demo çalışıyor…' : state.run ? 'Sentetik demoyu yeniden çalıştır ↗' : 'Sentetik akışı başlat ↗';
  $('demo-refresh').disabled = state.loading || state.submitting;
}
function renderResult(result) {
  const present = result && typeof result === 'object' && !Array.isArray(result);
  $('demo-result').hidden = !present;
  $('demo-result-empty').hidden = Boolean(present);
  const badge = $('demo-completed');
  badge.textContent = present ? result.completed === true ? 'Tamamlanma bildirildi' : 'Tamamlanma doğrulanmadı' : 'Sonuç bekleniyor';
  badge.className = `quiet-badge${present ? result.completed === true ? ' success' : ' failure' : ''}`;
  if (!present) return;
  const counts = checkCounts(result.checks);
  $('demo-passed').textContent = counts ? String(counts.passed) : '—';
  $('demo-total').textContent = counts ? String(counts.total) : '—';
  const rejections = result.rejected_registry_actions;
  $('demo-rejected').textContent = Array.isArray(rejections) ? String(rejections.filter(action => action?.rejected === true).length) : '—';
  $('demo-check-note').textContent = counts ? `${counts.failed} başarısız; ${counts.unknown} sonucu belirsiz kontrol. Reddedilen işlemler, kayıt defterinin engellediği test girişimleridir.` : 'Kontrol listesi bildirilmedi; sayı tahmin edilmedi.';
  $('demo-flags').replaceChildren();
  const flags = [
    ['real_fhe', 'Gerçek FHE', 'Evet · yerel şifreli hesap'],
    ['real_mpc', 'Gerçek MPC', 'Evet · yerel süreçler'],
    ['actual_near_sandbox', 'Gerçek NEAR sandbox', 'Evet · yerel test ağı'],
    ['independent_operators', 'Bağımsız işletmeciler', 'Sunucu evet bildirdi'],
    ['real_payment', 'Gerçek para hareketi', 'Sunucu evet bildirdi'],
    ['execution_proof', 'Hesaplama ispatı', 'Sunucu evet bildirdi'],
  ];
  for (const [key, label, yes] of flags) {
    const value = result[key];
    $('demo-flags').append(el('dt', label), el('dd', value === true ? yes : value === false ? 'Hayır' : 'Bildirilmedi'));
  }
  const payment = result.payment_mode;
  $('demo-flags').append(el('dt', 'Ödeme modu'), el('dd', payment === 'local_fixture_simulation' ? 'Yerel fixture · simülasyon' : typeof payment === 'string' ? payment : 'Bildirilmedi'));
  $('demo-checks').replaceChildren();
  if (Array.isArray(result.checks)) for (const check of result.checks) {
    const item = el('li');
    item.append(el('span', check?.pass === true ? 'Geçti' : check?.pass === false ? 'Başarısız' : 'Belirsiz', `quiet-badge${check?.pass === true ? ' success' : check?.pass === false ? ' failure' : ''}`),
      el('span', typeof check?.name === 'string' ? check.name : 'Adı bildirilmemiş kontrol'));
    $('demo-checks').append(item);
  }
}
function render() {
  const run = state.run;
  const hosted = state.mode === 'hosted-evidence';
  $('demo-hosted').hidden = !hosted;
  $('demo-status').textContent = run ? `${LABELS[run.status]}${hosted ? ' · kayıt' : ''}` : 'Hazır';
  $('demo-status').className = `quiet-badge${run?.status === 'completed' ? ' success' : run?.status === 'failed' ? ' failure' : ''}`;
  $('demo-summary').textContent = run ? `${hosted ? 'Kayıtlı yerel test' : 'Yerel test'} · ${run.id}` : hosted ? 'Kayıtlı yerel test sonucu henüz alınmadı.' : state.known ? 'Henüz demo çalıştırılmadı. Sabit sentetik senaryoyu düğmeyle başlatabilirsiniz.' : 'Demo durumu henüz alınmadı. Bağlantıyı yenileyin.';
  $('demo-events').replaceChildren();
  if (!run?.events.length) $('demo-events').append(el('li', run?.status === 'running' ? 'Hazırlık sürüyor. Henüz aşama olayı bildirilmedi.' : 'Henüz aşama kaydı yok.', 'panel-description'));
  else run.events.forEach((event, index) => {
    const last = index === run.events.length - 1;
    const style = last && run.status === 'running' ? 'active' : 'done';
    const item = el('li', undefined, `stage ${style}`);
    item.append(el('span', String(index + 1).padStart(2, '0'), 'stage-dot'));
    const copy = el('div', undefined, 'stage-copy');
    copy.append(el('h3', STAGES[event.stage] ?? event.stage), el('p', `Başlangıçtan ${seconds(event.elapsed_seconds)}`));
    item.append(copy);
    $('demo-events').append(item);
  });
  const elapsed = run?.result?.elapsed_seconds ?? run?.events.at(-1)?.elapsed_seconds;
  $('demo-time').textContent = elapsed === undefined ? 'Süre henüz bildirilmedi.' : `${run?.result ? 'Bildirilen toplam' : 'Son bildirilen aşama'}: ${seconds(elapsed)}`;
  renderResult(run?.result);
  controls();
}
function schedule() {
  clearTimeout(state.timer);
  if (!state.disposed && state.mode === 'local' && (state.run?.status === 'running' || !state.known)) state.timer = setTimeout(poll, 1000);
}
async function poll() {
  const version = state.version;
  try {
    const data = await request('/api/demo');
    if (state.disposed || version !== state.version) return;
    state.run = checkRun(data.run);
    state.known = true;
    render();
    message(state.run?.status === 'failed' ? state.run.error || 'Demo başarısız; istemci hata ayrıntısı bildirmedi.' : '', state.run?.status === 'failed');
  } catch (error) {
    if (version === state.version && !state.disposed) {
      state.known = false;
      controls();
      message(`Durum alınamadı: ${error.message} Yeni işlem gönderilmedi; durum tekrar kontrol edilecek.`, true);
    }
  } finally { if (version === state.version) schedule(); }
}
async function refresh() {
  if (state.loading || state.submitting || state.disposed) return;
  state.loading = true;
  clearTimeout(state.timer);
  ++state.version;
  controls();
  try {
    if (state.mode === null) {
      const deployment = await loadDeployment();
      state.mode = deployment.mode;
      state.summaryUrl = deployment.summaryUrl;
    }
    if (state.mode === 'hosted-evidence') {
      state.run = checkRun(recordedRun(await request(state.summaryUrl)));
      state.known = true;
      $('demo-connection').textContent = 'Kayıtlı kanıt · canlı hesap yok';
      $('demo-mode-note').textContent = 'Bu düğme yayında kapalıdır. Akış yalnızca yerel prototip ortamında başlatılır.';
    } else {
      const [capabilities, demo] = await Promise.allSettled([request('/api/capabilities'), request('/api/demo')]);
      if (capabilities.status === 'fulfilled' && typeof capabilities.value.csrfToken === 'string' && capabilities.value.csrfToken.length) state.token = capabilities.value.csrfToken;
      else { state.token = null; throw new Error('Yerel CSRF oturumu alınamadı. Durumu yenileyin.'); }
      if (demo.status !== 'fulfilled') throw demo.reason;
      state.run = checkRun(demo.value.run);
      state.known = true;
      $('demo-connection').textContent = 'Yerel istemciye bağlı';
      $('demo-mode-note').textContent = 'Başlatmak gerçek yerel bileşenleri çalıştırır. İşlem sürerken durum saniyede bir kontrol edilir.';
    }
    $('demo-connection').className = 'status-pill connected';
    message(state.run?.status === 'failed' ? state.run.error || 'Demo başarısız; hata ayrıntısı bildirilmedi.' : '', state.run?.status === 'failed');
  } catch (error) {
    state.known = false;
    $('demo-connection').textContent = 'Durum alınamadı';
    $('demo-connection').className = 'status-pill disconnected';
    message(error.message, true);
  } finally { state.loading = false; render(); schedule(); }
}
async function start() {
  if (state.mode !== 'local' || !state.known || !state.token || state.submitting || state.loading || state.run?.status === 'running') return;
  state.submitting = true;
  clearTimeout(state.timer);
  ++state.version;
  controls();
  message('Sentetik akış yerel istemciye gönderiliyor…');
  try {
    const data = await request('/api/demo', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': state.token }, body: '{}' });
    state.run = checkRun(data.run);
    if (!state.run) throw new Error('Başlatma yanıtında demo kimliği yok.');
    state.known = true;
    message();
  } catch (error) {
    state.known = false;
    message(error.status === 409 ? 'Etkin bir demo zaten var. Mevcut çalıştırmanın durumu alınıyor.' : `Başlatma yanıtı alınamadı: ${error.message} Yeniden gönderilmedi; önce mevcut durum kontrol edilecek.`, error.status !== 409);
  } finally { state.submitting = false; render(); schedule(); }
}
$('demo-start').addEventListener('click', start);
$('demo-refresh').addEventListener('click', refresh);
window.addEventListener('pagehide', () => { state.disposed = true; clearTimeout(state.timer); ++state.version; });
window.addEventListener('pageshow', event => { if (event.persisted) { state.disposed = false; refresh(); } });
refresh();
