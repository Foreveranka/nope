/** Same-origin, fixed-input privacy demo. Importable without a DOM for node tests. */
export const STAGES = Object.freeze({
  starting: 'Testnet akışı başlatıldı', driver_ready: 'Testnet sürücüsü hazır',
  fhe_prepare_started: 'FHE girdisi şifreleniyor', prepared: 'Şifreli girdi ve anahtar bağlamaları hazır',
  chain_clock: 'Zincir zamanı okundu', create_job: 'İş testnete kaydedildi',
  bid: 'Kapalı teklif taahhüdü kaydedildi', close_not_ready: 'Zincirde teklif son zamanı bekleniyor',
  close: 'Teklif kümesi kapatıldı', mpc_started: 'Yerel üç taraflı MPC başladı',
  mpc_completed: 'MPC seçimi tamamlandı', begin_execution: 'Seçilen yürütücü kaydedildi',
  execution_bound: 'Hesaplama iş kaydına bağlandı', fhe_evaluation_started: 'Şifreli değerlendirme başladı',
  evaluated: 'Şifreli değerlendirme tamamlandı', client_verified: 'Yerel referans kontrolü geçti',
  sdk_claim_built: 'Bağlı sonuç makbuzu hazırlandı', submit_receipt: 'Sonuç makbuzu zincire gönderildi',
  decide: 'Müşteri kararı zincire kaydedildi', view: 'Zincir durumu okundu',
  accepted: 'Sonuç kayıt defterinde kabul edildi', driver_stopped: 'Testnet sürücüsü kapandı',
  rejected_begin_execution: 'Yetkisiz yürütme girişimi reddedildi',
  rejected_submit_receipt: 'Geçersiz makbuz girişimi reddedildi',
  rejected_decide: 'Yetkisiz kabul girişimi reddedildi', command_failed: 'Zincir komutu başarısız',
  payment_started: 'Sabit test ödemesi başlatıldı', payment_preflight: 'Test ödemesi ön kontrolü',
  payment_funded: 'Test ödeme sözleşmesi fonlandı', payment_released: 'Test ödemesi aktarıldı',
  payment_verified: 'Test ödeme makbuzu doğrulandı', completed: 'Demo tamamlanma olayı bildirildi',
  failed_or_interrupted: 'Çalıştırma başarısız veya kesintiye uğradı',
});
const INPUTS = Object.freeze([{ id: 7, value: 255 }, { id: 2, value: 144 }, { id: 7, value: 42 }, { id: 3, value: 5 }]);
const PRICES = [90_000_000, 80_000_000, 95_000_000];
const STATUSES = ['running', 'completed', 'failed', 'interrupted'];
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const text = (value, fallback = 'Bildirilmedi') => typeof value === 'string' && value.length ? value.slice(0, 500) : fallback;
const number = value => new Intl.NumberFormat('tr-TR', { maximumFractionDigits: 2 }).format(value);
const seconds = value => typeof value === 'number' && Number.isFinite(value) && value >= 0 ? `${number(value)} sn` : 'Süre bildirilmedi';
const flag = value => value === true ? 'Evet' : value === false ? 'Hayır' : 'Bildirilmedi';

export function isLocalOrigin(origin) {
  try {
    const url = new URL(origin);
    return ['http:', 'https:'].includes(url.protocol) && ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) && !url.username && !url.password;
  } catch { return false; }
}
export function transactionURL(hash, network) {
  if (network !== 'testnet' || typeof hash !== 'string' || !/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(hash)) return null;
  const alphabet = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
  let value = 0n;
  for (const char of hash) value = value * 58n + BigInt(alphabet.indexOf(char));
  const bytes = value === 0n ? 0 : Math.ceil(value.toString(2).length / 8);
  const zeros = hash.length - hash.replace(/^1+/, '').length;
  return bytes + zeros === 32 ? `https://testnet.nearblocks.io/txns/${hash}` : null;
}
export function formatYocto(value) {
  if (typeof value !== 'string' || !/^(0|[1-9][0-9]{0,39})$/.test(value)) return 'Tutar bildirilmedi';
  const padded = value.padStart(25, '0');
  const fraction = padded.slice(-24).replace(/0+$/, '');
  return `${padded.slice(0, -24)}${fraction ? `,${fraction}` : ''} test NEAR (${value} yoctoNEAR)`;
}
export function validateRun(run) {
  if (run === null) return null;
  if (!object(run) || typeof run.id !== 'string' || !run.id.length || run.id.length > 160 || !STATUSES.includes(run.status) || !Array.isArray(run.events) || run.events.length > 2048 ||
    run.events.some(event => !object(event) || typeof event.stage !== 'string' || !event.stage.length || event.stage.length > 160 || typeof event.elapsed_seconds !== 'number' || !Number.isFinite(event.elapsed_seconds) || event.elapsed_seconds < 0) ||
    (run.result !== undefined && !object(run.result))) throw new Error('Demo yanıtının biçimi geçersiz. Tamamlanma doğrulanamadı.');
  return run;
}
export function recordedRun(data) {
  if (!object(data)) throw new Error('Kayıtlı kanıtın biçimi geçersiz.');
  if (Object.hasOwn(data, 'run')) {
    const run = validateRun(data.run);
    if (!run || run.status === 'running') throw new Error('Kayıtlı kanıt sonlanmış bir çalıştırma içermiyor.');
    return run;
  }
  const result = data.result ?? data;
  if (!object(result) || typeof result.completed !== 'boolean') throw new Error('Kayıtlı kanıtta tamamlanma durumu yok.');
  return validateRun({ id: text(data.id, 'kayitli-testnet'), status: result.completed ? 'completed' : 'failed',
    events: data.events ?? result.stage_elapsed_seconds ?? [], result, error: data.error });
}
export function completionVerified(run) {
  const r = run?.result;
  return run?.status === 'completed' && r?.completed === true && r.network === 'testnet' && r.synthetic_only === true && r.real_fhe === true && r.real_mpc === true &&
    r.independent_operators === false && r.execution_proof === false && r.payment?.verified === true && r.payment?.mpcPriceProven === false &&
    r.payment?.amountYocto === '1000000000000000000000' && Boolean(transactionURL(r.payment?.transactionHash, r.network)) &&
    Array.isArray(r.checks) && r.checks.length > 0 && r.checks.every(check => check?.pass === true) &&
    Array.isArray(r.transactions) && r.transactions.length > 0 && r.transactions.every(tx => transactionURL(tx?.hash, r.network));
}
export function canStart(state, confirmed, local) {
  return local && state.mode === 'local' && state.enabled === true && state.fresh && Boolean(state.token) && confirmed &&
    !state.loading && !state.submitting && !state.uncertain && !state.disposed && state.run === null;
}

export function mountPrivacy({ document: doc, fetch: fetcher, origin, setTimer = setTimeout, clearTimer = clearTimeout }) {
  const $ = id => doc.getElementById(`privacy-${id}`);
  const local = isLocalOrigin(origin);
  const state = { mode: null, enabled: false, token: null, run: null, fresh: false, loading: false, submitting: false,
    uncertain: false, disposed: false, version: 0, timer: null, message: '' };
  function el(tag, content, className) {
    const node = doc.createElement(tag);
    if (content !== undefined) node.textContent = String(content);
    if (className) node.className = className;
    return node;
  }
  async function request(path, options = {}) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 15000);
    try {
      const response = await fetcher(path, { credentials: 'same-origin', cache: 'no-store', redirect: 'error', ...options, signal: controller.signal });
      if (!response.ok) {
        const error = new Error(`HTTP ${response.status}. Demo durumu alınamadı.`);
        error.status = response.status;
        throw error;
      }
      return await response.json();
    } catch (error) {
      if (error.name === 'AbortError') throw new Error('Sunucu zamanında yanıt vermedi. İşlem sonucu belirsiz.');
      throw error;
    } finally { clearTimeout(timer); }
  }
  function accept(data) {
    if (!object(data) || typeof data.enabled !== 'boolean' || !Object.hasOwn(data, 'run')) throw new Error('Demo API yanıtı tanınmadı.');
    const run = validateRun(data.run);
    state.run = run;
    state.enabled = data.enabled;
    state.fresh = true;
    if (run !== null) state.uncertain = false;
  }
  function renderSamples() {
    const reveal = $('reveal').checked;
    $('input-label').textContent = reveal ? 'Sentetik açık girdiler' : 'Değerler görünümde gizli';
    $('records').replaceChildren();
    INPUTS.forEach((record, index) => {
      const row = el('tr');
      row.append(el('td', String(index + 1).padStart(2, '0')), el('td', reveal ? record.id : '••••', reveal ? '' : 'privacy-mask'), el('td', reveal ? record.value : '••••', reveal ? '' : 'privacy-mask'));
      $('records').append(row);
    });
    $('bids').replaceChildren();
    PRICES.forEach((price, index) => {
      const row = el('li');
      row.append(el('span', `Sağlayıcı ${index + 1}`), el('span', reveal ? `${number(price)} · sentetik birim` : 'Kapalı · ••••'));
      $('bids').append(row);
    });
    $('budget').textContent = reveal ? 'Sentetik bütçe: 100.000.000 birim. Fiyatlar ve bütçe test NEAR ödemesi değildir; koordinatör bu değerleri bilir.' : 'Bütçe ve fiyatlar görünümde gizli. Bunlar test ödemesinin tutarı değildir.';
    $('output').replaceChildren();
    const records = state.run?.result?.verified_synthetic_records;
    const valid = state.run?.status === 'completed' && state.run?.result?.completed === true && state.run?.result?.real_fhe === true &&
      Array.isArray(records) && records.length === 4 && records.every(r => object(r) && Number.isInteger(r.id) && r.id >= 0 && r.id <= 255 && Number.isInteger(r.value) && r.value >= 0 && r.value <= 255 && typeof r.duplicate === 'boolean');
    $('output-label').textContent = valid ? `${state.mode === 'replay' ? 'Kayıtlı' : 'API'} · çözülen 4 kayıt` : 'Doğrulanmış çıktı alınmadı';
    $('output-note').textContent = valid ? (reveal ? 'Sunucunun bildirdiği gerçek FHE çıktısı · sentetik kayıtlar.' : 'Çıktı alındı. Görmek için sentetik açık değerler seçeneğini açın.') : 'Gerçek çalıştırmanın çözülen kayıtları gelmeden sonuç gösterilmez.';
    if (valid && reveal) {
      const table = el('table');
      table.append(el('caption', 'Çözülen sentetik FHE çıktısı', 'sr-only'));
      const head = el('thead'), header = el('tr');
      for (const name of ['Kimlik', 'Değer', 'Tekrar']) { const cell = el('th', name); cell.scope = 'col'; header.append(cell); }
      head.append(header);
      const body = el('tbody');
      for (const r of records) { const row = el('tr'); row.append(el('td', r.id), el('td', r.value), el('td', r.duplicate ? 'Evet' : 'Hayır')); body.append(row); }
      table.append(head, body); $('output').append(table);
    }
  }
  function renderResult() {
    const result = state.run?.result;
    $('result').hidden = !result;
    $('result-note').textContent = !state.fresh ? 'Güncel durum doğrulanamadı. Varsa aşağıdaki bilgiler son alınan yanıta aittir.' : completionVerified(state.run) ?
      `${state.mode === 'replay' ? 'Kayıtlı çalıştırma' : 'Çalıştırma'}: FHE, MPC, testnet ve sabit test ödeme kontrolleri bildirildi.` : result ? 'Bildirilen sonuç aşağıda. Akışın tamamlanması henüz doğrulanmadı.' : 'Sonuç ve ödeme henüz doğrulanmadı.';
    $('facts').replaceChildren(); $('checks').replaceChildren(); $('transactions').replaceChildren();
    if (!result) return;
    const fact = (label, value) => { const row = el('div'); row.append(el('dt', label), el('dd', value)); $('facts').append(row); };
    fact('Ağ', result.network === 'testnet' ? 'NEAR testnet' : 'Testnet doğrulanmadı');
    fact('İş kimliği', text(result.job_id)); fact('Seçilen yürütücü', text(result.selected_executor));
    fact('Gerçek FHE / gerçek MPC', `${flag(result.real_fhe)} / ${flag(result.real_mpc)}`);
    fact('Bağımsız operatörler', result.independent_operators === false ? 'Hayır · aynı makine' : 'Bağımsızlık doğrulanmadı');
    fact('Yürütme ispatı', result.execution_proof === false ? 'Yok · yerel referans kontrolü' : 'Bağımsız ispat doğrulanmadı');
    fact('Test ödeme makbuzu', result.payment?.verified === true ? 'API tarafından doğrulandı' : 'Doğrulanmadı');
    fact('Sabit test bedeli', formatYocto(result.payment?.amountYocto));
    fact('MPC fiyatının ödendiği ispatı', 'Yok · sabit test bedeli');
    const checks = Array.isArray(result.checks) ? result.checks : [];
    const passed = checks.filter(c => c?.pass === true).length;
    const failed = checks.filter(c => c?.pass === false).length;
    $('check-count').textContent = Array.isArray(result.checks) ? `${passed}/${checks.length} geçti · ${failed} başarısız · ${checks.length - passed - failed} belirsiz` : 'Kontrol listesi bildirilmedi';
    for (const check of checks) {
      const row = el('li'); row.dataset.tone = check?.pass === true ? 'success' : check?.pass === false ? 'error' : 'unknown';
      row.append(el('span', check?.pass === true ? 'Geçti' : check?.pass === false ? 'Başarısız' : 'Belirsiz'), el('span', text(check?.name, 'Adsız kontrol'))); $('checks').append(row);
    }
    const transactions = Array.isArray(result.transactions) ? [...result.transactions] : [];
    const paymentHash = result.payment?.transactionHash;
    if (typeof paymentHash === 'string' && !transactions.some(tx => tx?.hash === paymentHash)) transactions.push({ label: 'Sabit test ödemesi', hash: paymentHash });
    for (const tx of transactions) {
      const row = el('li'), label = text(tx?.label ?? tx?.command, 'Testnet işlemi');
      const url = transactionURL(tx?.hash, result.network);
      if (url) { const a = el('a', `${label} ↗`); a.href = url; a.target = '_blank'; a.rel = 'noopener noreferrer'; row.append(a, el('small', tx.hash)); }
      else row.append(el('span', `${label} · geçerli testnet işlem kimliği yok`));
      $('transactions').append(row);
    }
    if (!transactions.length) $('transactions').append(el('li', 'İşlem makbuzu bildirilmedi.'));
  }
  function render() {
    const replay = state.mode === 'replay', active = state.run?.status === 'running';
    $('mode').textContent = replay ? 'Kayıtlı kanıt' : state.fresh && state.mode === 'local' ? 'Yerel API' : state.mode === 'unavailable' ? 'API kullanılamıyor' : 'Bağlantı kontrolü';
    $('replay').hidden = !replay;
    $('setup').hidden = state.mode === null || (state.mode === 'local' && state.enabled === true);
    $('mode-note').textContent = replay ? 'Bu yayın önceki testnet çalıştırmasını gösterir. Yeni çalışma için sahibin hazır yerel deposu gerekir.' : state.mode === 'local' ?
      state.enabled ? 'Hazır yerel ortamda sabit senaryo çalışır. Olaylar aynı kaynaktaki API’den alınır.' : 'Yerel API mevcut; çalıştırma devre dışı. Sahibin FHE/MPC ortamı ve testnet cüzdanları hazır olmalı.' :
      state.mode === 'unavailable' ? 'Çalıştırma API’sine erişilemedi. Yeni işlem başlatılmadı; tamamlanma doğrulanamadı.' : 'Aynı kaynaktaki demo API’si sorgulanıyor. Henüz işlem başlatılmadı.';
    $('consent-field').disabled = !local || state.mode !== 'local' || !state.enabled || !state.fresh || state.loading || state.submitting || state.run !== null || state.uncertain;
    $('start').disabled = !canStart(state, $('consent').checked, local);
    $('start').textContent = replay ? 'Yeni çalışma için yerel ortam gerekli' : state.submitting ? 'Başlatma yanıtı bekleniyor…' : active ? 'Demo çalışıyor' : state.run ? 'Bu oturumun çalıştırması sonlandı' : 'Testnet demosunu çalıştır ↗';
    $('refresh').disabled = state.loading || state.submitting;
    const status = $('status');
    status.dataset.tone = 'unknown';
    if (!state.fresh) status.textContent = state.loading ? 'Durum alınıyor…' : 'Durum doğrulanamıyor';
    else if (!state.run) status.textContent = state.uncertain ? 'Başlatma sonucu belirsiz' : 'Henüz çalıştırılmadı';
    else if (state.run.status === 'running') status.textContent = 'Çalışıyor · canlı olaylar';
    else if (completionVerified(state.run)) { status.textContent = replay ? 'Kayıtlı çalışma tamamlandı' : 'Tamamlandı · testnet'; status.dataset.tone = 'success'; }
    else if (['failed', 'interrupted'].includes(state.run.status)) { status.textContent = state.run.status === 'failed' ? 'Başarısız' : 'Kesintiye uğradı'; status.dataset.tone = 'error'; }
    else status.textContent = 'Tamamlanma doğrulanamadı';
    $('message').textContent = state.message; $('message').hidden = !state.message;
    $('run-id').textContent = state.run ? `${replay ? 'Kayıtlı çalışma' : 'Çalıştırma'} · ${state.run.id}${state.fresh ? '' : ' · son bilinen durum'}` : 'Henüz çalıştırma kaydı alınmadı.';
    $('events').replaceChildren();
    const events = state.run?.events ?? [];
    $('event-count').textContent = `${events.length} olay`;
    if (!events.length) $('events').append(el('li', active ? 'Çalıştırma bildirildi; henüz aşama olayı yok.' : 'Henüz aşama kaydı yok.', 'privacy-empty'));
    events.forEach((event, index) => {
      const row = el('li', undefined, active && index === events.length - 1 ? 'privacy-current' : '');
      const copy = el('div', undefined, 'privacy-event-copy');
      copy.append(el('strong', Object.hasOwn(STAGES, event.stage) ? STAGES[event.stage] : event.stage), el('small', `${event.stage} · ${seconds(event.elapsed_seconds)}`));
      row.append(el('span', String(index + 1).padStart(2, '0'), 'privacy-event-index'), copy); $('events').append(row);
    });
    $('time').textContent = events.length ? `Son bildirilen olay: başlangıçtan ${seconds(events.at(-1).elapsed_seconds)}. Süreler sunucu ölçümüdür.` : 'Süre tahmini yapılmaz; yalnızca bildirilen ölçümler gösterilir.';
    renderSamples(); renderResult();
  }
  function schedule() {
    clearTimer(state.timer);
    if (!state.disposed && state.mode === 'local' && (state.run?.status === 'running' || state.uncertain)) state.timer = setTimer(() => refresh(), 1500);
  }
  async function refresh() {
    if (state.loading || state.submitting || state.disposed) return;
    state.loading = true; clearTimer(state.timer);
    const version = ++state.version;
    const current = () => !state.disposed && version === state.version;
    render();
    try {
      // API is always probed first. Only an absent public route (404) permits replay.
      let data;
      try { data = await request('/api/privacy-demo'); }
      catch (error) {
        if (error.status !== 404 || local) throw error;
        const recorded = recordedRun(await request('/privacy-evidence.json'));
        if (!current()) return;
        state.mode = 'replay'; state.run = recorded; state.fresh = true; state.enabled = false; state.token = null;
      }
      if (!current()) return;
      if (data !== undefined) {
        accept(data); state.token = null;
        if (!local) throw new Error('Çalıştırma yalnızca yerel sahibin ortamında kullanılabilir.');
        state.mode = 'local';
        if (state.enabled) {
          const caps = await request('/api/capabilities');
          if (!current()) return;
          if (typeof caps?.csrfToken !== 'string' || !caps.csrfToken.length || caps.csrfToken.length > 512) throw new Error('CSRF oturumu alınamadı. İşlem başlatılamaz.');
          state.token = caps.csrfToken;
        }
      }
      if (!current()) return;
      state.message = state.run && ['failed', 'interrupted'].includes(state.run.status) ? text(state.run.error, 'Çalıştırma başarıyla sonlanmadı. Yeni işlem otomatik gönderilmez.') :
        state.uncertain ? 'Başlatma sonucu belirsiz; istek tekrar gönderilmiyor. Durumu yenileyin ve sahibin yerel sürecini kontrol edin.' : '';
    } catch (error) {
      if (!current()) return;
      state.fresh = false; state.token = null;
      if (state.mode !== 'local') state.mode = 'unavailable';
      state.message = `${text(error.message, 'Bağlantı hatası.')} Yeni işlem gönderilmedi; otomatik başlatma tekrarı yok.`;
    } finally { if (current()) { state.loading = false; render(); schedule(); } }
  }
  async function start() {
    if (!canStart(state, $('consent').checked, local)) return;
    state.submitting = true; state.uncertain = true; state.message = ''; clearTimer(state.timer);
    const version = ++state.version; $('consent').checked = false; render();
    try {
      const data = await request('/api/privacy-demo', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': state.token }, body: '{}' });
      if (state.disposed || version !== state.version) return;
      accept(data);
      if (!state.run) throw new Error('Başlatma yanıtında çalıştırma kimliği yok.');
      state.message = ['failed', 'interrupted'].includes(state.run.status) ? text(state.run.error, 'Çalıştırma tamamlanmadı.') : '';
    } catch (error) {
      if (state.disposed || version !== state.version) return;
      state.fresh = false;
      state.message = error.status === 409 ? 'Başlatma çakışması. İstek tekrar gönderilmiyor; mevcut çalıştırmanın durumu sorgulanacak.' : `${text(error.message)} Başlatma sonucu belirsiz; istek tekrar gönderilmiyor.`;
    } finally {
      if (!state.disposed && version === state.version) { state.submitting = false; render(); schedule(); }
    }
  }
  function dispose() { state.disposed = true; ++state.version; clearTimer(state.timer); }
  $('start').addEventListener('click', start);
  $('refresh').addEventListener('click', refresh);
  $('consent').addEventListener('change', render);
  $('reveal').addEventListener('change', renderSamples);
  return { state, refresh, start, render, dispose, resume() { state.disposed = false; return refresh(); } };
}

if (typeof document !== 'undefined' && document.getElementById('privacy-start')) {
  const app = mountPrivacy({ document, fetch: globalThis.fetch.bind(globalThis), origin: window.location.origin });
  window.addEventListener('pagehide', app.dispose);
  window.addEventListener('pageshow', event => { if (event.persisted) app.resume(); });
  app.refresh();
}
