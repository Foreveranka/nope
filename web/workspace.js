import { MAX_BYTES, parseCSV, verifyValues, exportCSV } from './csv-input.mjs';
import { hashRequest, hashOutput, hashProgram, sha256 } from './gc-core.mjs';
import { PROFILE as RECIPE_PROFILE, compileRecipe, referenceApply, estimateRecipe, hashRecipeRequest, hashRecipeOutput, hashRecipeProgram } from './recipe-core.mjs';
import { prepareRecipe } from './recipe-client.mjs';
import { parseRecipeColumn, applyRecipeOutput } from './recipe-csv.mjs';
import { PROFILE as PLAN_PROFILE, estimatePlan, hashPlan, hashPlanRequest, hashPlanProgram, hashPlanOutput, validatePlanRequest, freezePlanData } from './plan-core.mjs';
import { preparePlan } from './plan-client.mjs';
import { publicTask, publicTaskHash, acceptAgentProposal, privatePlanInputs, applyAgentOutput } from './agent-plan.mjs';
import { createVault, quoteCommitment, randomSalt, parseNearAmount, formatNearAmount } from './workspace-vault.mjs';

export const TOKEN_KEY = 'nope.workspace.session.v1';
export const PROFILE = 'nope-csv-gc-v1';
// Use the function's canonical query entry: Vercel preserves original paths on rewrites.
export function workspaceApiUrl(path) {
  const url = new URL(path, 'https://workspace.invalid');
  const query = new URLSearchParams(url.searchParams); query.set('route', url.pathname.slice(1));
  return '/api/workspace?' + query.toString();
}
export const ROUTES = new Set(['/workspace', '/customer', '/provider', '/jobs/new', '/jobs', '/job', '/offer', '/delivery', '/payments', '/activity', '/settings']);
const HASH = /^[a-f0-9]{64}$/;
export function routeOf(href, origin = 'http://localhost') {
  const url = new URL(href, origin);
  if (url.origin !== new URL(origin).origin || !ROUTES.has(url.pathname)) return null;
  return { path: url.pathname, id: url.searchParams.get('id') || '' };
}
export function testnetAccount(value) {
  return typeof value === 'string' && (/^[a-f0-9]{64}$/.test(value) || (value.length >= 8 && value.length <= 64 && /^[a-z0-9]+(?:[-_][a-z0-9]+)*(?:\.[a-z0-9]+(?:[-_][a-z0-9]+)*)*\.testnet$/.test(value)));
}
export function createPayload({ jobId, title, description, deadlineISO, task, buyerPublicKey, publicTask: publicTaskValue }) {
  if (!/^[a-f0-9]{32}$/.test(jobId) || ![PROFILE, RECIPE_PROFILE, PLAN_PROFILE].includes(task?.profile) || !Number.isInteger(task.rowCount) || task.rowCount < 1 || task.rowCount > 32) throw new Error('Invalid prepared job');
  if (task.profile === RECIPE_PROFILE) estimateRecipe(task.recipe, task.rowCount);
  if (task.profile === PLAN_PROFILE) validatePlanRequest(task);
  if (task.profile !== PLAN_PROFILE && publicTaskValue !== undefined) throw Error('Public planning task requires v3');
  return { jobId, title, description, deadlineISO, profile: task.profile, rowCount: task.rowCount, task, buyerPublicKey, ...(task.profile === PLAN_PROFILE ? { publicTask: publicTask(publicTaskValue) } : {}) };
}
const recipeTask = task => task?.profile === RECIPE_PROFILE;
const taskInputHash = task => task?.profile === PLAN_PROFILE ? hashPlanRequest(task) : recipeTask(task) ? hashRecipeRequest(task) : hashRequest(task);
const taskProgramHash = task => task?.profile === PLAN_PROFILE ? hashPlanProgram(task.plan) : recipeTask(task) ? hashRecipeProgram(task.recipe) : hashProgram();
// A private local fingerprint; never included in the planning task or remote job.
const datasetHash = dataset => sha256(JSON.stringify(dataset));

/** Actual dedicated browser worker. workerFactory is an explicit unit-test seam;
 * the production path never synthesizes a plan or falls back to a remote AI. */
export async function generateAgentPlan(task, { workerFactory = () => new Worker(new URL('./agent-model-worker.mjs', import.meta.url), { type: 'module' }), onProgress = () => {}, signal, timeoutMs = 300_000 } = {}) {
  task = publicTask(task);
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 300_000) throw Error('Geçersiz yerel model zaman sınırı.');
  const taskHash = await publicTaskHash(task);
  if (signal?.aborted) throw Error('Yerel planlama iptal edildi; plan onaylanmadı.');
  const worker = workerFactory();
  let timer, abort;
  try {
    const result = await new Promise((resolve, reject) => {
      abort = () => reject(Error('Yerel planlama iptal edildi; plan onaylanmadı.'));
      signal?.addEventListener('abort', abort, { once: true });
      timer = setTimeout(() => reject(Error('Yerel model beş dakikalık zaman sınırına ulaştı; plan onaylanmadı. Tekrar deneyin.')), timeoutMs);
      worker.onmessage = event => {
        const value = event.data;
        if (value?.type === 'progress') { try { onProgress(value); } catch {} }
        else if (value?.type === 'plan') resolve(value);
        else if (value?.type === 'error') reject(Error(typeof value.error === 'string' ? value.error : 'Yerel model çalıştırılamadı.'));
        else reject(Error('Yerel modelden beklenmeyen cevap geldi.'));
      };
      worker.onerror = () => reject(Error('Yerel model yüklenemedi veya bu tarayıcıda çalıştırılamadı.'));
      if (signal?.aborted) { abort(); return; }
      worker.postMessage({ type: 'plan', task, taskHash });
    });
    if (signal?.aborted) throw Error('Yerel planlama iptal edildi; plan onaylanmadı.');
    if (typeof result.raw !== 'string' || typeof result.model?.id !== 'string' || !result.model.id || typeof result.model.revision !== 'string' || !result.model.revision) throw Error('Model kimliği veya plan cevabı eksik.');
    const checked = await acceptAgentProposal(task, result.raw);
    if (signal?.aborted) throw Error('Yerel planlama iptal edildi; plan onaylanmadı.');
    return freezePlanData({ ...checked, model: { id: result.model.id, revision: result.model.revision } });
  } finally { clearTimeout(timer); signal?.removeEventListener('abort', abort); worker.terminate(); }
}

/** Recheck the entire local approval immediately before creating ciphertext. */
export async function prepareApprovedAgentJob(dataset, task, approval, { approved = false, garblePlan = preparePlan } = {}) {
  dataset = freezePlanData(structuredClone(dataset)); task = publicTask(task);
  approval = approval && freezePlanData(structuredClone(approval));
  if (!approved || !approval || approval.datasetSha256 !== await datasetHash(dataset)) throw Error('Dosya değişti veya plan onaylanmadı. Planı yeniden üretip onaylayın.');
  const checked = await acceptAgentProposal(task, approval.plan);
  if (checked.taskHash !== approval.taskHash || checked.planSha256 !== approval.planSha256 || JSON.stringify(checked.task) !== JSON.stringify(approval.task)) throw Error('İş tanımı veya sütun türleri değişti. Planı yeniden üretip onaylayın.');
  const values = privatePlanInputs(dataset, checked.plan);
  estimatePlan(checked.plan, dataset.rows.length);
  const prepared = await garblePlan(values, checked.plan);
  validatePlanRequest(prepared.request);
  if (prepared.request.profile !== PLAN_PROFILE || prepared.request.rowCount !== dataset.rows.length || prepared.request.planSha256 !== checked.planSha256 || await hashPlan(prepared.request.plan) !== checked.planSha256) throw Error('Şifreli görev onaylı planla eşleşmiyor.');
  return { ...prepared, values, approval: freezePlanData({ ...checked, datasetSha256: approval.datasetSha256, model: approval.model }) };
}
function recipeText(recipe) {
  const checked = compileRecipe(recipe).recipe;
  return (checked.type === 'text' ? 'Metin' : 'Sayı') + ': ' + checked.steps.map(step => {
    if (step.op === 'fill') return `boş → ${step.value}`;
    if (step.op === 'clamp') return `aralık ${step.min}–${step.max}`;
    return {trim:'baş/son boşlukları sil',lowercase:'küçük harf',uppercase:'büyük harf',redactDigits:'rakamları * yap'}[step.op];
  }).join(' → ');
}
export function decisionAllowed(job, verified, session) {
  return session?.role === 'buyer' && job?.buyerId === session.id && job.status === 'DELIVERED' && verified?.correct === true &&
    verified.version === job.delivery?.version && verified.outputSha256 === job.delivery?.outputSha256 && HASH.test(verified.outputSha256);
}
function localDate(date) {
  return new Date(date.getTime() - date.getTimezoneOffset() * 60000).toISOString().slice(0, 16);
}
class FriendlyError extends Error {}
const fail = text => { throw new FriendlyError(text); };
const statusText = { OPEN: 'Tekliflere açık', CLOSED: 'Teklifler kapandı', AWARDED: 'Sağlayıcı seçildi', DELIVERED: 'Teslim edildi', REVISION: 'Düzeltme istendi', ACCEPTED: 'Kabul edildi · ödeme bekliyor', PAID: 'Zincirde ödeme doğrulandı' };

export function createWorkspace({ document: doc, window: win, fetch: fetcher = globalThis.fetch, storage = win.sessionStorage, vaultFactory = createVault, garble = prepareRecipe, garblePlan = preparePlan, agentWorkerFactory } = {}) {
  const $ = id => doc.getElementById(id);
  const root = $('workspace-root');
  const state = { token: storage.getItem(TOKEN_KEY), session: null, vault: null, epoch: 0, busy: false, draft: null, uncertain: false, newDraftAllowed: false };
  function el(tag, text, cls) {
    const node = doc.createElement(tag);
    if (text !== undefined && text !== null) node.textContent = String(text);
    if (cls) node.className = cls;
    return node;
  }
  function message(text = '', error = false) {
    const node = $('workspace-message');
    if (!node) return;
    node.textContent = text; node.hidden = !text; node.dataset.error = String(error);
  }
  function paragraph(text, target = root, cls = 'muted') { const p = el('p', text, cls); target.append(p); return p; }
  function card(title, target = root) { const node = el('section', null, 'card stack'); if (title) node.append(el('h2', title)); target.append(node); return node; }
  function link(text, href, target = root, cls = 'btn secondary') {
    const node = el('a', text, cls); node.href = href; node.dataset.route = ''; target.append(node); return node;
  }
  function button(text, handler, target = root, cls = 'btn') {
    const node = el('button', text, cls); node.type = 'button';
    node.addEventListener('click', () => run(handler)); target.append(node); return node;
  }
  function field(parent, label, { type = 'text', required = true, value = '', maxLength, placeholder, name } = {}) {
    const wrap = el('label', null, 'field'); wrap.append(el('span', label));
    const input = el(type === 'textarea' ? 'textarea' : 'input'); if (type !== 'textarea') input.type = type;
    input.required = required; input.value = value; if (name) input.name = name;
    if (maxLength) input.maxLength = maxLength; if (placeholder) input.placeholder = placeholder;
    wrap.append(input); parent.append(wrap); return input;
  }
  function form(parent, label, handler) {
    const node = el('form', null, 'stack'); const submit = el('button', label, 'btn'); submit.type = 'submit';
    node.addEventListener('submit', event => { event.preventDefault(); if (node.reportValidity()) run(handler); });
    parent.append(node); node.append(submit); return { node, submit };
  }
  function controlsBusy(busy) {
    doc.querySelectorAll('#workspace-root button, #workspace-root input, #workspace-root select, #workspace-root textarea, #workspace-logout').forEach(node => {
      if (node.dataset.allowBusy === 'true') return;
      if (busy) { if (node.dataset.wasDisabled === undefined) node.dataset.wasDisabled = String(node.disabled); node.disabled = true; }
      else if (node.dataset.wasDisabled !== undefined) { node.disabled = node.dataset.wasDisabled === 'true'; delete node.dataset.wasDisabled; }
    });
  }
  async function run(fn) {
    if (state.busy) return;
    state.busy = true; controlsBusy(true); message('İşlem sürüyor…');
    try { await fn(); }
    catch (err) { message(err instanceof FriendlyError ? err.message : 'İşlem tamamlanamadı. Bağlantıyı ve bu cihazdaki yerel kasayı kontrol edip durumu yenileyin.', true); }
    finally { state.busy = false; controlsBusy(false); if (state.pendingNavigation) { state.pendingNavigation = false; await render(); } }
  }
  async function api(path, method = 'GET', body) {
    let response;
    try { response = await fetcher(workspaceApiUrl(path), { method, credentials: 'same-origin', cache: 'no-store', headers: { ...(state.token ? { Authorization: 'Bearer ' + state.token } : {}), ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}) }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) }); }
    catch { fail('Sunucuya ulaşılamadı. İşlemin durumunu yenileyerek kontrol edin.'); }
    if (!response.ok) {
      if (response.status === 401) { state.token = null; state.session = null; state.vault = null; storage.removeItem(TOKEN_KEY); chrome(); }
      const text = response.status === 401 ? 'Oturum geçersiz veya süresi dolmuş. Yerel kasa silinmedi.' : response.status === 403 ? 'Bu oturumun bu işleme yetkisi yok.' : response.status === 404 ? 'İş bulunamadı veya bu oturum için erişilebilir değil.' : response.status === 409 ? 'İşin durumu değişmiş olabilir. Yenileyip son durumu kontrol edin.' : response.status === 429 ? 'Çok fazla istek gönderildi. Biraz sonra tekrar deneyin.' : 'Sunucu işlemi tamamlayamadı. Güncel durumu kontrol edin.';
      const error = new FriendlyError(text); error.status = response.status; throw error;
    }
    try { return await response.json(); } catch { fail('Sunucu yanıtı okunamadı. Yenileyerek işlem durumunu kontrol edin.'); }
  }
  function chrome() {
    const session = state.session, nav = $('workspace-nav'); nav?.replaceChildren();
    if ($('workspace-identity')) $('workspace-identity').textContent = session ? `${session.displayName} · ${session.role === 'buyer' ? 'Müşteri' : 'Sağlayıcı'} · testnet` : 'Test çalışma alanı · misafir';
    if ($('workspace-logout')) $('workspace-logout').hidden = !session;
    const items = !session ? [['Başlangıç', '/workspace']] : session.role === 'buyer' ? [['Genel bakış', '/customer'], ['Yeni iş', '/jobs/new'], ['İşlerim', '/jobs'], ['Hareketler', '/activity'], ['Kimlik ve kasa', '/settings']] : [['Genel bakış', '/provider'], ['Açık işler', '/jobs'], ['Hareketler', '/activity'], ['Kimlik ve kasa', '/settings']];
    for (const [text, href] of items) {
      const a = link(text, href, nav, ''); if (win.location.pathname === href) a.setAttribute('aria-current', 'page');
    }
  }
  function title(text, subtitle) { if ($('workspace-heading')) $('workspace-heading').textContent = text; if ($('workspace-subtitle')) $('workspace-subtitle').textContent = subtitle || ''; }
  function jobLink(path, id) { return `${path}?id=${encodeURIComponent(id)}`; }
  function isBuyer(job) { return state.session?.role === 'buyer' && job.buyerId === state.session.id; }
  function isSelected(job) { return state.session?.role === 'provider' && job.selectedOffer?.providerId === state.session.id; }
  function requireRole(role) { if (state.session?.role !== role) fail('Bu sayfa mevcut oturum rolünüze açık değil. Rol değiştirmek için ayarlardan açıkça yeni oturum başlatın.'); }
  async function navigate(href, replace = false) {
    const route = routeOf(href, win.location.origin); if (!route || state.busy) return;
    win.history[replace ? 'replaceState' : 'pushState']({}, '', href); await render();
  }
  function renderJobs(jobs, target = root) {
    if (!jobs.length) { paragraph('Henüz burada görüntülenecek iş yok.', target, 'empty'); return; }
    const list = el('div', null, 'list'); target.append(list);
    for (const job of jobs) {
      const row = el('section', null, 'card job-row'); list.append(row);
      const info = el('div', null, 'job-row-main'); row.append(info); info.append(el('h2', job.title));
      const badge = paragraph(statusText[job.status] || job.status, info, 'badge job-status'); badge.dataset.status = job.status;
      paragraph(`${job.rowCount} satır · Şifreli CSV görevi`, info);
      if (job.recipe) paragraph(recipeText(job.recipe), info);
      if (job.publicTask) paragraph(`Herkese açık ajan hedefi: ${job.publicTask.goal}`, info);
      if (job.deadlineISO) paragraph(`Teklif sonu: ${new Date(job.deadlineISO).toLocaleString('tr-TR')}`, info);
      link('İşi aç', jobLink('/job', job.id), row);
    }
  }
  async function jobsList(target = root) {
    const epoch = state.epoch;
    const { jobs, nextCursor } = await api('/jobs'); if (epoch !== state.epoch) return []; renderJobs(jobs || [], target);
    let cursor = nextCursor;
    if (cursor) { const more = button('Daha fazla iş', async () => {
      const result = await api('/jobs?cursor=' + encodeURIComponent(cursor)); if (epoch !== state.epoch) return; renderJobs(result.jobs || [], target);
      cursor = result.nextCursor; more.hidden = !cursor;
    }, target, 'btn secondary'); }
    return jobs || [];
  }
  function onboarding() {
    title('İşi ver. Ya da işe başla.', 'Müşteri olarak gizli teklif al; sağlayıcı olarak şifreli görevleri yürüt.');
    if (state.session) { paragraph('Geçerli oturumunuz korunuyor.'); link('Çalışma alanına devam et', state.session.role === 'buyer' ? '/customer' : '/provider'); link('Rol ve yerel kasa', '/settings'); return; }
    const layout = el('div', null, 'onboarding-grid'); root.append(layout);
    const intro = card('Aynı iş. Ayrı görünürlük.', layout);
    paragraph('[ NOPE / PRIVATE WORK ]', intro, 'role-kicker');
    const buyerRole = el('div', null, 'role-card'); intro.append(buyerRole);
    buyerRole.append(el('h3', '01 / Müşteri'));
    paragraph('CSV’yi kendi cihazında şifrele, teklifleri karşılaştır ve teslimi uygulamanın içinde kontrol et.', buyerRole);
    const providerRole = el('div', null, 'role-card'); intro.append(providerRole);
    providerRole.append(el('h3', '02 / Sağlayıcı'));
    paragraph('Açık iş tanımlarını gör, müşteriye şifreli teklif ver ve seçildiğinde şifreli hesabı yürüt.', providerRole);
    paragraph('Bu bir testnet pilotudur. Test kimliği oluşturulur; gerçek para kullanılmaz.', intro, 'muted');
    const panel = card('Çalışma alanına katıl', layout);
    const { node, submit } = form(panel, 'Test oturumu başlat', async () => {
      const selected = role.value;
      if (selected === 'provider' && !testnetAccount(account.value.trim())) fail('Yalnızca .testnet hesabı veya 64 haneli hex testnet hesabı kullanın.');
      const { token, session } = await api('/session', 'POST', { role: selected, displayName: name.value.trim(), ...(selected === 'provider' ? { paymentAccount: account.value.trim() } : {}) });
      if (!token || !session || session.role !== selected) fail('Oturum doğrulanamadı.');
      storage.setItem(TOKEN_KEY, token); state.token = token; state.session = session; state.vault = vaultFactory(session.id); state.draft = null; chrome();
      win.history.pushState({}, '', selected === 'buyer' ? '/customer' : '/provider'); await render(); message('Test oturumu açıldı. Kimliğiniz bu sekmede korunur.');
    });
    const name = field(node, 'Görünen ad (kişisel veri kullanmayın)', { value: '', maxLength: 60, name: 'displayName' });
    const roleWrap = el('label', null, 'field'); roleWrap.append(el('span', 'Rol')); const role = el('select'); role.name = 'role';
    for (const [value, text] of [['buyer', 'Müşteri — iş yayımla'], ['provider', 'Sağlayıcı — teklif ver']]) { const o = el('option', text); o.value = value; role.append(o); }
    roleWrap.append(role); node.append(roleWrap);
    const account = field(node, 'Testnet ödeme hesabı', { required: false, name: 'paymentAccount', placeholder: 'ornek.testnet', maxLength: 64 });
    const update = () => { account.parentElement.hidden = role.value !== 'provider'; account.required = role.value === 'provider'; }; role.addEventListener('change', update); update();
    node.append(submit); paragraph('Davet veya gerçek kimlik doğrulaması yerine test kimliği oluşturulur. Rolünüz sunucu oturumuyla belirlenir. CSV ve özel anahtarlar bu cihazdaki kasada kalır.', panel);
  }
  async function newJob() {
    requireRole('buyer'); title('Yeni şifreli iş', '1. CSV seçin → 2. Yerel önizlemeyi kontrol edin → 3. Şifreleyip yayımlayın');
    const panel = card('CSV hazırlığı');
    paragraph('Seçilen sütuna uygulanacak tarifi belirleyin. Sayı: 1–32 satır, boş veya 0–254 tam sayı (255 boş hücre için ayrılmıştır). Metin: en fazla 8 satır ve hücre başına 16 bayt yazdırılabilir ASCII. Tarif herkese açıktır; CSV başlıkları, dosya adı ve değerler bu cihazda kalır.', panel);
    const { node, submit } = form(panel, 'Şifrele ve işi yayımla', async () => {
      if ((await unresolvedJobIds()).length && !state.newDraftAllowed) fail('Önce belirsiz yayımlamayı kontrol edin veya uyarıyı onaylayarak ayrı bir yeni taslak başlatın.');
      if (!dataset) fail('Önce geçerli bir CSV seçin.');
      const agentMode = mode.value === 'agent', revision = draftRevision, source = dataset, approvedPlan = agentApproval;
      let recipe, values, gcjob;
      try {
        if (agentMode) {
          gcjob = await prepareApprovedAgentJob(source, currentTask(), agentApproval, { approved: approve.checked, garblePlan });
          values = gcjob.values;
        } else { recipe = selectedRecipe(); values = parseRecipeColumn(source, Number(column.value), recipe); estimateRecipe(recipe, values.length); }
      }
      catch (error) { fail(error.message); }
      const deadline = new Date(deadlineInput.value);
      if (!Number.isFinite(deadline.getTime()) || deadline.getTime() <= Date.now()) fail('Teklif sonu gelecekte olmalı.');
      if (budget.value) { try { parseNearAmount(budget.value); } catch { fail('Gizli bütçe için geçerli bir testNEAR tutarı girin.'); } }
      message('Yerel şifreleme ve güvenli kasa kaydı hazırlanıyor…');
      const jobId = randomSalt().slice(0, 32);
      gcjob ??= await garble(values, recipe);
      const buyerPublicKey = await state.vault.buyerPublicKey();
      const payload = createPayload({ jobId, title: titleInput.value.trim(), description: description.value.trim(), deadlineISO: deadline.toISOString(), task: gcjob.request, buyerPublicKey, ...(agentMode ? { publicTask: gcjob.approval.task } : {}) });
      const local = { dataset: source, values, ...(agentMode ? { agentApproval: gcjob.approval } : { column: Number(column.value), recipe }), hiddenBudget: budget.value || null, payload, pending: true };
      // Store and read back *both* local records before any network publication.
      await state.vault.saveJob(jobId, local); await state.vault.saveDecoder(jobId, gcjob);
      if (!(await state.vault.loadJob(jobId))) fail('Yerel kasa kaydı doğrulanamadı; iş yayımlanmadı.');
      if (agentMode && (revision !== draftRevision || mode.value !== 'agent' || !approve.checked || agentApproval !== approvedPlan || await publicTaskHash(currentTask()) !== approvedPlan.taskHash)) fail('Taslak değişti. Planı yeniden üretip onaylayın; iş yayımlanmadı.');
      await updateUnresolved(jobId, true);
      state.draft = { jobId, payload }; state.uncertain = true; state.newDraftAllowed = false;
      let job;
      try { ({ job } = await api('/jobs', 'POST', payload)); }
      catch (err) {
        if ([400, 413, 415, 422, 429].includes(err.status)) {
          await updateUnresolved(jobId, false); state.draft = null; state.newDraftAllowed = state.uncertain;
          fail('Yayımlama sunucu tarafından reddedildi. Yerel CSV ve çözücü korundu. Son zamanı ve alanları kontrol edip tekrar deneyin.');
        }
        await renderRecovery(panel); fail('Yayımlama sonucu kesin değil. CSV ve çözücü yerel kasada saklandı. Aynı iş kimliğini kontrol edin. Ayrı bir yeni iş için önce belirsizlik uyarısını onaylayın.'); }
      await finishPublish(job, local, jobId);
    });
    const titleInput = field(node, 'Herkese açık iş başlığı — kişisel veri eklemeyin', { maxLength: 100, name: 'title' });
    const description = field(node, 'Herkese açık açıklama — CSV veya kişisel veri eklemeyin', { type: 'textarea', maxLength: 1000, name: 'description' });
    const budget = field(node, 'Gizli bütçe (isteğe bağlı testNEAR; yalnızca yerel kasa)', { required: false, name: 'hiddenBudget' });
    const deadlineInput = field(node, 'Teklif son zamanı', { type: 'datetime-local', value: localDate(new Date(Date.now() + 3600000)), name: 'deadlineISO' });
    const file = field(node, 'CSV dosyası — bu cihazda okunur', { type: 'file', required: false, name: 'csv' }); file.accept = '.csv,text/csv';
    function select(label, name, options, parent = node) {
      const wrap = el('label', null, 'field'); wrap.append(el('span', label)); const input = el('select'); input.name = name;
      for (const [value, text] of options) { const option = el('option', text); option.value = value; input.append(option); }
      wrap.append(input); parent.append(wrap); return input;
    }
    const mode = select('Hazırlama modu', 'planningMode', [['manual', 'Manuel tarif (varsayılan)'], ['agent', 'Yerel AI ajanı ile planla']]);
    const recipeType = select('Sütun türü', 'recipeType', [['number', 'Sayı'], ['text', 'Metin (ASCII)']]);
    const fill = field(node, 'Boş sayıları doldur', { type: 'checkbox', required: false, name: 'recipeFill' }); fill.checked = true;
    const fillValue = field(node, 'Boş hücre yerine (0–254)', { type: 'number', value: '0', name: 'recipeFillValue' }); fillValue.min = '0'; fillValue.max = '254'; fillValue.step = '1';
    const clamp = field(node, 'Sayıları alt/üst sınıra çek', { type: 'checkbox', required: false, name: 'recipeClamp' }); clamp.checked = true;
    const minValue = field(node, 'Alt sınır (0–254)', { type: 'number', value: '0', name: 'recipeMin' }); minValue.min = '0'; minValue.max = '254'; minValue.step = '1';
    const maxValue = field(node, 'Üst sınır (0–254)', { type: 'number', value: '100', name: 'recipeMax' }); maxValue.min = '0'; maxValue.max = '254'; maxValue.step = '1';
    const trim = field(node, 'Metnin başındaki/sonundaki ASCII boşlukları sil', { type: 'checkbox', required: false, name: 'recipeTrim' }); trim.checked = true;
    const letterCase = select('Harf dönüşümü', 'recipeCase', [['lowercase', 'Küçük harf'], ['uppercase', 'Büyük harf'], ['none', 'Değiştirme']]);
    const redact = field(node, 'ASCII rakamları * ile değiştir', { type: 'checkbox', required: false, name: 'recipeRedactDigits' }); redact.checked = false;
    const column = select('İşlenecek sütun', 'column', []);
    const preview = el('div', null, 'stack'); node.append(preview); let dataset = null;
    let draftRevision = 0, agentApproval = null, planningController = null;
    const agentPanel = el('div', null, 'stack'); node.append(agentPanel); agentPanel.hidden = true;
    paragraph('Yerel model yalnızca herkese açık hedefi, C1…C16 takma adlarını ve seçtiğiniz türleri görür (en fazla 4 seçili sütun). Dosya adı, gerçek başlıklar ve hücreler modele verilmez. İlk kullanımda yaklaşık 412,5 MB model ağırlığı indirilip tarayıcıda önbelleğe alınır. Çıkarım bu tarayıcıda çalışır; çıkarım API’sine veri gönderilmez.', agentPanel);
    const goal = field(agentPanel, 'Herkese açık ajan hedefi — yalnızca C1, C2 gibi takma adları kullanın; gizli veri yazmayın', { type: 'textarea', required: false, maxLength: 1800, name: 'agentGoal' });
    const schemaPanel = el('div', null, 'stack'); agentPanel.append(schemaPanel);
    const schemaInputs = [];
    const planView = el('div', null, 'stack');
    const generate = button('Yerel ajanla plan üret', async () => {
      if (!dataset || mode.value !== 'agent') fail('Önce CSV seçip ajan modunu açın.');
      invalidateAgent(); const revision = draftRevision, source = dataset;
      const controller = new AbortController(); planningController = controller;
      cancelPlanning.hidden = false; cancelPlanning.disabled = false;
      paragraph('Model hazırlanıyor…', planView);
      try {
        const task = currentTask();
        const proposal = await generateAgentPlan(task, { workerFactory: agentWorkerFactory, signal: controller.signal, onProgress: value => {
          if (revision === draftRevision) {
            const count = Number.isFinite(value.loaded) && Number.isFinite(value.total) && value.total > 0 ? ` · ${Math.round(value.loaded / value.total * 100)}% (${(value.loaded / 1e6).toFixed(1)} / ${(value.total / 1e6).toFixed(1)} MB)` : '';
            planView.textContent = (typeof value.message === 'string' ? value.message : 'Yerel model çalışıyor…') + count;
          }
        } });
        if (controller.signal.aborted) fail('Yerel planlama iptal edildi; plan onaylanmadı.');
        if (revision !== draftRevision || source !== dataset || mode.value !== 'agent') fail('Taslak değişti; eski model planı kullanılmadı.');
        const values = privatePlanInputs(source, proposal.plan);
        estimatePlan(proposal.plan, source.rows.length);
        const fingerprint = await datasetHash(source);
        if (controller.signal.aborted) fail('Yerel planlama iptal edildi; plan onaylanmadı.');
        if (revision !== draftRevision || source !== dataset || mode.value !== 'agent') fail('Taslak değişti; eski model planı kullanılmadı.');
        agentApproval = freezePlanData({ ...proposal, datasetSha256: fingerprint });
        planView.replaceChildren();
        paragraph(`Onaylanacak herkese açık hedef: ${proposal.task.goal}`, planView);
        paragraph(`Model: ${proposal.model.id} · revizyon ${proposal.model.revision}`, planView);
        paragraph(`İş SHA-256: ${proposal.taskHash}`, planView);
        paragraph(`Plan SHA-256: ${proposal.planSha256}`, planView);
        for (const step of proposal.plan.steps) {
          paragraph(`${step.column}: ${recipeText(step.recipe)}`, planView);
          const input = values[step.column], expected = referenceApply(input, step.recipe);
          table(['Satır', `${step.column} · ÖNCE (yerel)`, 'Beklenen SONRA (yerel)'], input.map((v, i) => [i + 1, displayCell(v, step.recipe), displayCell(expected[i], step.recipe)]), planView);
        }
        enabled(approve, true); message('Plan biçimi ve desteklenen işlemler kontrol edildi. Hedefe uygunluğunu, adımları ve yerel önizlemeyi inceleyip onaylayın.');
      } catch (error) { invalidateAgent(); fail(error.message); }
      finally { if (planningController === controller) planningController = null; cancelPlanning.hidden = true; cancelPlanning.disabled = true; }
    }, agentPanel);
    const cancelPlanning = el('button', 'Yerel planlamayı iptal et', 'btn secondary'); cancelPlanning.type = 'button'; cancelPlanning.hidden = true; cancelPlanning.disabled = true;
    cancelPlanning.dataset.allowBusy = 'true'; cancelPlanning.addEventListener('click', () => planningController?.abort()); agentPanel.append(cancelPlanning);
    agentPanel.append(planView);
    const approve = field(agentPanel, 'Bu hedefe ait yukarıdaki planı ve tüm yerel önce/sonra sonuçlarını inceledim; şifreli yürütme için onaylıyorum.', { type: 'checkbox', required: false, name: 'agentApprove' }); approve.checked = false; approve.disabled = true;
    function displayCell(value, recipe) { return value === '' || recipe.type === 'number' && value === 255 ? '(boş)' : value; }
    function enabled(input, active) {
      if (state.busy) { input.dataset.wasDisabled = String(!active); input.disabled = true; }
      else input.disabled = !active;
    }
    function currentTask() {
      return publicTask({ version: 1, goal: goal.value, columns: schemaInputs.filter(input => input.value !== 'ignore').map(input => ({ id: input.dataset.alias, type: input.value })) });
    }
    function invalidateAgent() {
      planningController?.abort();
      draftRevision++; agentApproval = null; approve.checked = false; enabled(approve, false);
      planView.replaceChildren(); if (mode.value === 'agent') enabled(submit, false);
    }
    function rebuildSchema() {
      schemaPanel.replaceChildren(); schemaInputs.length = 0;
      dataset?.headers.forEach((header, i) => {
        const input = select(`C${i + 1} ↔ ${header} (eşleme yalnızca bu cihazda)`, `agentColumn${i + 1}`, [['ignore', 'Yoksay'], ['number', 'Sayı'], ['text', 'Metin (ASCII)']], schemaPanel);
        input.dataset.alias = `C${i + 1}`; schemaInputs.push(input);
        input.addEventListener('change', () => { invalidateAgent();
          if (schemaInputs.filter(s => s.value !== 'ignore').length > 4) { input.value = 'ignore'; message('En fazla dört sütun seçebilirsiniz.', true); }
        });
      });
    }
    function updateMode() {
      invalidateAgent(); const agent = mode.value === 'agent'; agentPanel.hidden = !agent; preview.hidden = agent;
      updateRecipeFields();
      for (const input of [recipeType,fill,fillValue,clamp,minValue,maxValue,trim,letterCase,redact,column]) {
        if (agent) { input.parentElement.hidden = true; input.required = false; enabled(input, false); }
      }
      if (!agent) { recipeType.parentElement.hidden = false; column.parentElement.hidden = false; enabled(recipeType, true); enabled(column, true); showPreview(); }
      enabled(goal, agent); goal.required = agent; enabled(generate, agent);
      schemaInputs.forEach(input => enabled(input, agent));
    }
    mode.addEventListener('change', updateMode);
    goal.addEventListener('input', invalidateAgent); goal.addEventListener('change', invalidateAgent);
    approve.addEventListener('change', () => enabled(submit, !!agentApproval && approve.checked && mode.value === 'agent'));
    function selectedRecipe() {
      const integer = input => { if (!/^(0|[1-9]\d{0,2})$/.test(input.value) || Number(input.value) > 254) throw Error('Tarif sayıları 0–254 tam sayı olmalı.'); return Number(input.value); };
      const steps = recipeType.value === 'number' ? [fill.checked && {op:'fill',value:integer(fillValue)}, clamp.checked && {op:'clamp',min:integer(minValue),max:integer(maxValue)}].filter(Boolean) :
        [trim.checked && {op:'trim'}, letterCase.value !== 'none' && {op:letterCase.value}, redact.checked && {op:'redactDigits'}].filter(Boolean);
      const recipe = {type:recipeType.value,steps}; compileRecipe(recipe); return recipe;
    }
    function updateRecipeFields() {
      const numeric = recipeType.value === 'number';
      function enabled(input, active) {
        if (state.busy) { input.dataset.wasDisabled = String(!active); input.disabled = true; }
        else input.disabled = !active;
      }
      for (const input of [fill,fillValue,clamp,minValue,maxValue]) {
        const active = numeric && ([fill,clamp].includes(input) || (input === fillValue ? fill.checked : clamp.checked));
        input.parentElement.hidden = !numeric; input.required = active && ![fill,clamp].includes(input); enabled(input,active);
      }
      for (const input of [trim,letterCase,redact]) { input.parentElement.hidden = numeric; enabled(input,!numeric); }
    }
    function refreshColumns() {
      if (!dataset) return;
      const previous = column.value, valid = new Set(); let first = -1;
      column.replaceChildren();
      dataset.headers.forEach((header, i) => {
        const option = el('option', header); option.value = String(i);
        try { parseRecipeColumn(dataset, i, selectedRecipe()); valid.add(String(i)); if (first < 0) first = i; }
        catch { option.disabled = true; option.textContent = header + ' — desteklenmeyen sütun / tarif'; }
        column.append(option);
      });
      column.value = valid.has(previous) ? previous : String(first < 0 ? 0 : first);
    }
    const showPreview = () => {
      if (mode.value === 'agent') return;
      preview.replaceChildren(); submit.disabled = true;
      if (state.busy) submit.dataset.wasDisabled = 'true';
      updateRecipeFields(); if (!dataset) return;
      try { const recipe = selectedRecipe(), values = parseRecipeColumn(dataset, Number(column.value), recipe); estimateRecipe(recipe, values.length);
        const expected = referenceApply(values, recipe);
        paragraph('Herkese açık tarif: ' + recipeText(recipe), preview);
        paragraph(`${values.length} satır · yerel ÖNCE önizlemesi`, preview);
        table(['Satır', 'Önce', 'Beklenen sonra'], values.map((v, i) => [i + 1, v === 255 || v === '' ? '(boş)' : v, expected[i] === 255 || expected[i] === '' ? '(boş)' : expected[i]]), preview);
        submit.disabled = false; if (state.busy) submit.dataset.wasDisabled = 'false';
      } catch (error) { paragraph(error.message || 'Sütun ve tarif sınırlarını kontrol edin.', preview, 'danger'); }
    };
    column.addEventListener('change', showPreview);
    for (const input of [recipeType,fill,fillValue,clamp,minValue,maxValue,trim,letterCase,redact]) {
      const update = () => { refreshColumns(); showPreview(); };
      input.addEventListener('change', update); if (input.type === 'number') input.addEventListener('input', update);
    }
    file.addEventListener('change', () => { invalidateAgent(); return run(async () => {
      dataset = null; submit.disabled = true; column.replaceChildren(); preview.replaceChildren();
      rebuildSchema();
      const chosen = file.files[0]; if (!chosen) return;
      if (chosen.size > MAX_BYTES) fail('Dosya en fazla 64 KiB olabilir.');
      try { dataset = freezePlanData(parseCSV(new TextDecoder('utf-8', { fatal: true }).decode(await chosen.arrayBuffer()))); }
      catch { fail('CSV okunamadı. Başlık, 1–32 satır, UTF-8 ve desteklenen hücre biçimini kontrol edin.'); }
      rebuildSchema(); refreshColumns(); showPreview(); message('CSV yalnızca bu cihazda okundu. Önizlemeyi kontrol edin.');
    }); });
    node.append(submit); submit.disabled = true;
    updateMode();
    await renderRecovery(panel);
  }
  // Migrate the original single pending pointer without discarding unresolved attempts.
  async function unresolvedJobIds() {
    const pending = await state.vault.loadJob('__pending_publish__');
    return [...new Set([...(Array.isArray(pending?.unresolvedJobIds) ? pending.unresolvedJobIds : []), pending?.jobId].filter(id => typeof id === 'string' && /^[a-f0-9]{32}$/.test(id)))];
  }
  async function updateUnresolved(jobId, add) {
    const ids = await unresolvedJobIds();
    const unresolved = add ? [...new Set([...ids, jobId])] : ids.filter(id => id !== jobId);
    await state.vault.saveJob('__pending_publish__', { jobId: unresolved.at(-1) || null, unresolvedJobIds: unresolved });
    state.uncertain = unresolved.length > 0;
  }
  async function finishPublish(job, local, expectedId) {
    if (!job?.id || job.id !== expectedId) fail('Yayımlanan iş kimliği doğrulanamadı; yerel kayıt korundu.');
    await state.vault.saveJob(job.id, { ...local, pending: false }); await updateUnresolved(job.id, false);
    state.draft = null; state.newDraftAllowed = false;
    win.history.pushState({}, '', jobLink('/job', job.id)); await render(); message('İş yayımlandı. CSV ve çözücü yalnızca yerel kasada saklanıyor. Diğer belirsiz girişimler genel bakışta korunur.');
  }
  async function renderRecovery(target) {
    const ids = await unresolvedJobIds(); state.uncertain = ids.length > 0;
    // Re-render only this recovery section; a failed attempt must not duplicate controls.
    let container = Array.from(target.children).find(node => node.dataset?.publishRecovery === 'true');
    if (!container) { container = el('div', null, 'stack'); container.dataset.publishRecovery = 'true'; target.append(container); }
    container.replaceChildren();
    if (!ids.length) return;
    const panel = card('Doğrulanmamış yayımlamalar', container);
    paragraph('Bu girişimler iptal edilmiş veya başarısız sayılmaz. Yerel CSV, çözücü ve aynı iş kimliği korunur. Yeni bir taslak eski girişimi yeniden göndermez veya silmez.', panel, 'danger');
    for (const jobId of ids) {
      const local = await state.vault.loadJob(jobId);
      const row = card('Yayımlama hâlâ doğrulanmadı', panel);
      paragraph(`Yerel iş kimliği: ${jobId}`, row);
      if (local?.payload?.title) paragraph(local.payload.title, row);
      if (local?.payload?.deadlineISO && Date.parse(local.payload.deadlineISO) <= Date.now()) paragraph('Eski teklif son zamanı geçti. Yeni teklifler alınamaz; bu durum önceki yayımlamanın sonucunu doğrulamaz.', row);
      button('Aynı işin durumunu kontrol et', async () => {
        try { const { job } = await api('/jobs/' + encodeURIComponent(jobId)); await finishPublish(job, local, jobId); }
        catch (err) { if (err.status === 404) fail('Eski iş henüz bulunamadı. Önceki girişim hâlâ doğrulanmamış olarak saklanıyor; daha sonra aynı kimliği tekrar kontrol edebilirsiniz.'); throw err; }
      }, row);
      button('Aynı kimlik ve içerikle güvenli tekrar dene', async () => {
        if (!local?.payload) fail('Yerel yayımlama kaydı eksik. Aynı iş kimliği ve mevcut kasa korunuyor; durumu kontrol edin.');
        try { const { job } = await api('/jobs', 'POST', local.payload); await finishPublish(job, local, jobId); }
        catch (err) { if (err.status === 400) fail('Eski girişim doğrulanamadı; son zamanı geçmiş olabilir. Eski kayıt ve çözücü korunuyor. Durumu kontrol edebilir veya uyarıyı onaylayarak ayrı bir yeni taslak açabilirsiniz.'); throw err; }
      }, row, 'btn secondary');
    }
    const consent = field(panel, 'Eski yayımlamanın hâlâ doğrulanmadığını anlıyorum. Eski kaydı koruyarak, farklı kimlikli ayrı bir yeni iş hazırlamak istiyorum.', { type: 'checkbox', required: false, name: 'newDraftConsent' });
    button('Eski girişimi koru ve ayrı yeni taslak aç', async () => {
      if (!consent.checked) fail('Önce eski girişimin belirsiz kaldığını ve yeni taslağın ayrı bir iş olacağını onaylayın.');
      // Consent opens an empty draft only. It neither retries nor publishes anything.
      state.newDraftAllowed = true; state.draft = null;
      win.history.pushState({}, '', '/jobs/new'); await render();
      message('Ayrı yeni taslak açıldı. Eski girişimler ve çözücüleri korundu; yeni işi yayımlamak ayrıca sizin işleminizi gerektirir.');
    }, panel, 'btn secondary');
    link('İşlerimi kontrol et', '/jobs', panel);
  }
  function table(headers, rows, target) {
    const wrap = el('div', null, 'table-wrap'), node = el('table'); const head = el('thead'), hr = el('tr');
    headers.forEach(h => { const th = el('th', h); th.scope = 'col'; hr.append(th); }); head.append(hr); node.append(head);
    const body = el('tbody'); rows.forEach(row => { const tr = el('tr'); row.forEach(cell => tr.append(el('td', cell))); body.append(tr); }); node.append(body); wrap.append(node); target.append(wrap);
  }
  async function offers(job, target) {
    const panel = card('Şifreli teklifler', target);
    if (job.status === 'OPEN') { paragraph('Teklif içerikleri kapanıştan önce açılmaz. Son zamanda veya erken kapatma düğmesiyle kapatın.', panel); return; }
    if (!job.offers?.length) { paragraph('Henüz teklif yok.', panel, 'empty'); return; }
    for (const offer of job.offers) {
      const row = card(offer.providerName || 'Sağlayıcı', panel);
      try {
        const quote = await state.vault.decryptQuote(offer.envelope);
        if (await quoteCommitment(job.id, offer.providerId, quote.amountYocto, quote.salt) !== offer.commitment || quote.jobId !== job.id || quote.providerId !== offer.providerId) fail('Teklif bağı doğrulanamadı.');
        paragraph(`${formatNearAmount(quote.amountYocto)} testNEAR · ${quote.deliveryHours} saat`, row); paragraph(quote.note || 'Not eklenmedi.', row);
        paragraph(`Testnet alıcı hesabı: ${offer.paymentAccount}`, row);
        if (job.status === 'CLOSED') {
          const consent = field(row, 'Seçtiğim teklif tutarının manuel testnet ödeme için açık olmasını onaylıyorum.', { type: 'checkbox', required: false });
          button('Bu sağlayıcıyı seç', async () => {
            if (!consent.checked) fail('Seçilen fiyatın açık hâle gelmesini onaylayın.');
            await api('/jobs/' + encodeURIComponent(job.id) + '/award', 'POST', { offerId: offer.id, amountYocto: quote.amountYocto, salt: quote.salt }); await render(); message('Sağlayıcı seçildi. Bu seçim otomatik MPC sonucu değildir.');
          }, row);
        }
      } catch { paragraph('Teklif bu cihazdaki anahtarla açılamadı veya taahhüdü doğrulanamadı. Seçim kapalı.', row, 'danger'); }
    }
  }
  function publicPlanInfo(job, target) {
    if (job.profile !== PLAN_PROFILE || !job.plan) return;
    paragraph(`Herkese açık ajan hedefi: ${job.publicTask?.goal || ''}`, target);
    paragraph(`Plan SHA-256: ${job.planSha256}`, target);
    for (const step of job.plan.steps) paragraph(`${step.column}: ${recipeText(step.recipe)}`, target);
  }
  async function detail(job) {
    title(job.title, statusText[job.status] || job.status);
    const panel = card('İş bilgisi'); paragraph(job.description, panel); paragraph(`İş kimliği: ${job.id}`, panel); paragraph(`${job.rowCount} satır · ${job.profile}`, panel);
    if (job.recipe) paragraph('Herkese açık tarif: ' + recipeText(job.recipe), panel);
    publicPlanInfo(job, panel);
    paragraph(`Teklif sonu: ${new Date(job.deadlineISO).toLocaleString('tr-TR')}`, panel);
    for (const [key, label] of [['taskHash', 'Şifreli girdi özeti'], ['programHash', 'Program özeti']]) { const hash = job[key] || job.delivery?.[key]; if (hash) paragraph(`${label}: ${hash}`, panel); }
    if (isBuyer(job)) {
      const local = await state.vault.loadJob(job.id);
      if (local?.payload?.task) { paragraph(`Yerel şifreli girdi SHA-256: ${await taskInputHash(local.payload.task)}`, panel); paragraph(`Program SHA-256: ${await taskProgramHash(local.payload.task)}`, panel); }
      if (job.status === 'OPEN') button('Teklifleri şimdi kapat', async () => { await api('/jobs/' + encodeURIComponent(job.id) + '/close', 'POST', {}); await render(); message('Teklifler kapatıldı. Yeni teklif alınmaz.'); }, panel, 'btn secondary');
      await offers(job, root);
      if (job.delivery) link('Teslimi yerel olarak doğrula', jobLink('/delivery', job.id));
    } else if (state.session.role === 'provider') {
      if (job.ownOffer) {
        const local = await state.vault.loadJob(job.id);
        paragraph(local?.ownQuote ? `Kendi teklifiniz: ${formatNearAmount(local.ownQuote.amountYocto)} testNEAR · ${local.ownQuote.deliveryHours} saat` : 'Teklifiniz sunucuda kayıtlı. Yerel teklif bu cihazda bulunamadı.', panel);
      } else if (job.status === 'OPEN') link('Şifreli teklif ver', jobLink('/offer', job.id), panel);
      if (isSelected(job)) link('Şifreli işi yürüt / teslim', jobLink('/delivery', job.id), panel);
    }
    if (job.selectedOffer) { paragraph(`Seçilen tutar: ${formatNearAmount(job.selectedOffer.amountYocto)} testNEAR · ${job.selectedOffer.paymentAccount}`, panel); link('Ödeme ve makbuz', jobLink('/payments', job.id), panel); }
    button('Durumu yenile', render, panel, 'btn secondary');
  }
  async function offerForm(job) {
    requireRole('provider'); title('Şifreli teklif ver', job.title);
    if (job.status !== 'OPEN' || job.ownOffer || new Date(job.deadlineISO).getTime() <= Date.now()) fail('Bu iş yeni teklif almıyor veya teklifiniz zaten kayıtlı.');
    if (!testnetAccount(state.session.paymentAccount)) fail('Geçerli bir testnet ödeme hesabına sahip sağlayıcı oturumu gerekli.');
    const panel = card('Teklifiniz yalnızca müşteriye açılır'); paragraph('Fiyat, teslim süresi ve not tarayıcıda müşterinin RSA anahtarıyla hibrit şifrelenir. Sunucuya açık fiyat gönderilmez. Müşteri kapanıştan sonra teklifleri kendi cihazında karşılaştırır; otomatik MPC seçimi yapılmaz.', panel);
    if (job.recipe) paragraph('Herkese açık tarif: ' + recipeText(job.recipe), panel);
    publicPlanInfo(job, panel);
    const { node, submit } = form(panel, 'Şifrele ve teklif gönder', async () => {
      let amountYocto; try { amountYocto = parseNearAmount(amount.value).toString(); } catch { fail('Geçerli bir testNEAR tutarı girin (en fazla 24 ondalık).'); }
      if (BigInt(amountYocto) <= 0n) fail('Teklif tutarı sıfırdan büyük olmalı.');
      const hoursValue = Number(hours.value); if (!Number.isInteger(hoursValue) || hoursValue < 1 || hoursValue > 720) fail('Teslim süresi 1–720 tam saat olmalı.');
      const previous = await state.vault.loadJob(job.id) || {};
      const quote = previous.pendingOffer?.quote || { jobId: job.id, providerId: state.session.id, amountYocto, deliveryHours: hoursValue, note: note.value.trim(), salt: randomSalt() };
      const envelope = previous.pendingOffer?.envelope || await state.vault.encryptQuote(job.buyerPublicKey, quote);
      const commitment = await quoteCommitment(job.id, state.session.id, quote.amountYocto, quote.salt);
      await state.vault.saveJob(job.id, { ...previous, ownQuote: quote, pendingOffer: { quote, envelope } });
      await api('/jobs/' + encodeURIComponent(job.id) + '/offers', 'POST', { envelope, commitment });
      await state.vault.saveJob(job.id, { ...previous, ownQuote: quote }); win.history.pushState({}, '', jobLink('/job', job.id)); await render(); message('Şifreli teklif kaydedildi.');
    });
    const amount = field(node, 'Teklif (testNEAR)', { name: 'amount', placeholder: '0.001' }); amount.inputMode = 'decimal';
    const hours = field(node, 'Teslim süresi (saat)', { type: 'number', value: '1', name: 'deliveryHours' }); hours.min = '1'; hours.max = '720'; hours.step = '1';
    const note = field(node, 'Teklif notu (kişisel veri eklemeyin)', { type: 'textarea', required: false, maxLength: 500, name: 'note' }); node.append(submit);
    paragraph(`Ödeme hesabınız: ${state.session.paymentAccount} · yalnızca testnet`, panel);
    const cached = await state.vault.loadJob(job.id);
    if (cached?.pendingOffer) paragraph('Önceki teklif gönderiminin sonucu belirsiz. Önce iş detayını yenileyin; tekrar gönderim aynı saklanan şifreli teklifi kullanır.', panel);
  }
  async function delivery(job) {
    title('Teslim ve yerel kontrol', job.title);
    if (isSelected(job)) {
      const panel = card('Şifreli yürütme'); paragraph('Yalnızca seçilen sağlayıcı bu işi yürütebilir. Sunucu şifreli devreyi işler; sağlayıcıya CSV veya çözülmüş değer gösterilmez.', panel);
      if (job.recipe) paragraph('Yürütülecek tarif: ' + recipeText(job.recipe), panel);
      publicPlanInfo(job, panel);
      if (['AWARDED', 'REVISION'].includes(job.status)) button(job.status === 'REVISION' ? 'Düzeltmeyi yeniden yürüt' : 'Şifreli işi yürüt ve teslim et', async () => {
        await api('/jobs/' + encodeURIComponent(job.id) + '/execute', 'POST', {}); await render(); message('Şifreli teslim oluşturuldu. Müşteri kendi cihazında doğrulayacak.');
      }, panel);
      if (job.delivery) paragraph(`Teslim sürümü ${job.delivery.version} · şifreli çıktı SHA-256: ${job.delivery.outputSha256}`, panel);
      return;
    }
    if (!isBuyer(job)) fail('Teslim yalnızca iş sahibi ve seçilen sağlayıcıya açıktır.');
    if (!job.delivery) { paragraph('Henüz teslim yok.', root, 'empty'); return; }
    const panel = card('Bu cihazda doğrulama');
    paragraph('Sonuç etiketleri bu işin yerel çözücüsüyle açılır ve orijinal değerlerle karşılaştırılır. Bu kontrol yürütme kaynağı veya bağımsız operatör kanıtı değildir.', panel);
    let local, outputs;
    const isRecipe = job.profile === RECIPE_PROFILE, isPlan = job.profile === PLAN_PROFILE;
    publicPlanInfo(job, panel);
    try { local = await state.vault.loadJob(job.id); if (!local?.dataset || (isPlan ? !local.agentApproval || !local.values : !Array.isArray(local.values))) throw Error(); outputs = await state.vault.decodeDelivery(job.id, isRecipe || isPlan ? job.delivery : job.delivery.outputs); }
    catch { paragraph('Bu cihazda orijinal CSV veya çözme anahtarı yok ya da teslim açılamıyor. Aynı tarayıcı ve cihazdaki kasayla yeniden açın. Oturum açmak anahtarları başka cihaza taşımaz; sonuç veya kabul oluşturulmadı.', panel, 'danger'); return; }
    const verified = { correct: false, version: job.delivery.version, outputSha256: job.delivery.outputSha256 };
    let recipeCSV;
    try {
      const task = local.payload?.task;
      if (!task || task.profile !== job.profile || task.rowCount !== job.rowCount || (!isPlan && outputs.length !== local.values.length)) throw Error();
      if (isPlan) {
        const approval = local.agentApproval, checked = await acceptAgentProposal(job.publicTask, task.plan);
        if (checked.taskHash !== approval.taskHash || checked.planSha256 !== approval.planSha256 || checked.planSha256 !== job.planSha256 ||
            await hashPlan(job.plan) !== checked.planSha256 || task.planSha256 !== checked.planSha256 ||
            JSON.stringify(checked.task) !== JSON.stringify(approval.task) || await datasetHash(local.dataset) !== approval.datasetSha256 ||
            JSON.stringify(privatePlanInputs(local.dataset, task.plan)) !== JSON.stringify(local.values)) throw Error();
        recipeCSV = applyAgentOutput(local.dataset, task.plan, outputs).csv;
        if (job.delivery.profile !== job.profile || job.delivery.nonce !== task.nonce || job.delivery.rowCount !== task.rowCount) throw Error();
      } else if (isRecipe) {
        // Re-extract the encrypted local dataset and check every value against
        // the bound public program, rather than trusting a cached preview.
        const values = parseRecipeColumn(local.dataset, local.column, task.recipe);
        if (JSON.stringify(values) !== JSON.stringify(local.values) || await hashRecipeProgram(job.recipe) !== await hashRecipeProgram(task.recipe)) throw Error();
        recipeCSV = applyRecipeOutput(local.dataset, local.column, outputs, task.recipe).csv;
        if (job.delivery.profile !== job.profile || job.delivery.nonce !== task.nonce || job.delivery.rowCount !== task.rowCount) throw Error();
      } else if (job.profile !== PROFILE || !verifyValues(local.values, outputs)) throw Error();
      if (await taskInputHash(task) !== job.delivery.inputSha256 || (isPlan ? await hashPlanOutput(job.delivery.outputs) : isRecipe ? await hashRecipeOutput(job.delivery.outputs) : await hashOutput(job.delivery.outputs)) !== job.delivery.outputSha256 || await taskProgramHash(task) !== job.delivery.programSha256) throw Error();
      verified.correct = true;
    } catch { verified.correct = false; }
    paragraph(verified.correct ? 'Yerel kontrol başarılı: sonuç desteklenen temizleme kuralıyla eşleşiyor.' : 'Yerel kontrol başarısız. Teslim kabul edilemez.', panel, verified.correct ? 'badge' : 'danger');
    let changedOnly = false; const summary = el('p', null, 'muted'); panel.append(summary); const results = el('div'); panel.append(results);
    const show = () => {
      results.replaceChildren();
      if (isPlan) {
        let total = 0, changed = 0;
        for (const step of local.payload.task.plan.steps) {
          const column = Number(step.column.slice(1)) - 1;
          const rows = outputs[step.column].map((v, i) => [i + 1, local.dataset.rows[i][column] || '(boş)', step.recipe.type === 'number' && v === 255 || v === '' ? '(boş)' : v]);
          const different = rows.filter((_, i) => local.values[step.column][i] !== outputs[step.column][i]);
          total += rows.length; changed += different.length;
          paragraph(`${step.column} ↔ ${local.dataset.headers[column]} (yerel)`, results);
          table(['Satır', 'ÖNCE', 'SONRA'], changedOnly ? different : rows, results);
        }
        summary.textContent = `${job.rowCount} satır · ${total} işlenen hücre · ${changed} değişen`;
        return;
      }
      const rows = outputs.map((v, i) => [i + 1, local.dataset.rows[i][local.column] === '' ? '(boş)' : local.dataset.rows[i][local.column], ((isRecipe && local.payload.task.recipe.type === 'number' && v === 255) || v === '') ? '(boş)' : v]);
      const changed = rows.filter((row, i) => isRecipe ? local.values[i] !== outputs[i] : local.values[i] === 255 || local.values[i] !== outputs[i]);
      summary.textContent = `${rows.length} satır · ${changed.length} değişen · ${rows.length - changed.length} değişmeyen`;
      table(['Satır', 'ÖNCE', 'SONRA'], changedOnly ? changed : rows, results);
    }; show();
    button('Değişen / tüm satırlar', () => { changedOnly = !changedOnly; show(); message('Tablo görünümü değişti.'); }, panel, 'btn secondary');
    if (verified.correct) {
      button('CSV olarak indir (isteğe bağlı)', () => {
        const blob = new Blob([isRecipe || isPlan ? recipeCSV : exportCSV(local.dataset, local.column, outputs)], { type: 'text/csv;charset=utf-8' }), url = win.URL.createObjectURL(blob);
        const a = el('a'); a.href = url; a.download = 'temizlenmis.csv'; a.click(); win.setTimeout(() => win.URL.revokeObjectURL(url), 1000); message('CSV indirme hazırlandı.');
      }, panel, 'btn secondary');
    }
    if (decisionAllowed(job, verified, state.session)) button('Doğrulanan teslimi kabul et', async () => {
      if (!decisionAllowed(job, verified, state.session)) fail('Yerel doğrulama olmadan kabul edilemez.');
      await api('/jobs/' + encodeURIComponent(job.id) + '/decision', 'POST', { decision: 'accept', version: verified.version, outputSha256: verified.outputSha256 }); await render(); message('Teslim kabul edildi. Manuel testnet ödeme henüz yapılmadı.');
    }, panel);
    if (job.status === 'DELIVERED') button('Düzeltme iste', async () => { await api('/jobs/' + encodeURIComponent(job.id) + '/decision', 'POST', { decision: 'revise', version: job.delivery.version, outputSha256: job.delivery.outputSha256 }); await render(); message('Düzeltme istendi.'); }, panel, 'btn secondary');
    if (['ACCEPTED', 'PAID'].includes(job.status)) link('Ödeme durumunu aç', jobLink('/payments', job.id), panel);
  }
  async function payments(job) {
    title('Manuel testnet ödeme', job.title); const panel = card('Doğrudan transfer · escrow değil');
    paragraph('Gerçek para veya kart kullanılmaz. Uygulama imza atmaz, para göndermez ve bakiye saklamaz. Testnet cüzdanınızda tek bir doğrudan NEAR transferi yapın; ardından makbuzu doğrulatın.', panel);
    if (!job.selectedOffer) { paragraph('Önce bir sağlayıcı seçilmeli.', panel); return; }
    if (!isBuyer(job) && !isSelected(job)) fail('Bu ödeme kaydına erişiminiz yok.');
    const selected = job.selectedOffer;
    paragraph(`Tam tutar: ${formatNearAmount(selected.amountYocto)} testNEAR`, panel); paragraph(`YoctoNEAR: ${selected.amountYocto}`, panel); paragraph(`Alıcı: ${selected.paymentAccount}`, panel);
    button('Tutarı kopyala', async () => { await win.navigator.clipboard.writeText(formatNearAmount(selected.amountYocto)); message('TestNEAR tutarı kopyalandı.'); }, panel, 'btn secondary');
    button('Alıcı hesabını kopyala', async () => { await win.navigator.clipboard.writeText(selected.paymentAccount); message('Alıcı hesabı kopyalandı.'); }, panel, 'btn secondary');
    if (job.status === 'PAID') { paragraph('PAID — sunucu gerçek testnet işlem makbuzunu doğruladı.', panel, 'badge'); if (job.payment?.transactionHash) paragraph(`İşlem: ${job.payment.transactionHash}`, panel); return; }
    if (job.status !== 'ACCEPTED' || job.payment?.status !== 'DUE') { paragraph('Ödeme henüz vadesinde değil. Önce müşteri teslimi kabul etmeli.', panel); return; }
    paragraph('Ödeme bekleniyor (DUE). Makbuz doğrulanana kadar ödenmiş sayılmaz.', panel);
    const wallet = el('a', 'Testnet cüzdanını ayrı sekmede aç', 'btn secondary'); wallet.href = 'https://testnet.mynearwallet.com/'; wallet.target = '_blank'; wallet.rel = 'noopener noreferrer'; panel.append(wallet);
    if (!isBuyer(job)) return;
    const { node, submit } = form(panel, 'Testnet makbuzunu doğrula', async () => {
      if (!testnetAccount(account.value.trim())) fail('Gönderen için geçerli bir testnet hesabı girin.');
      if (!/^[1-9A-HJ-NP-Za-km-z]{43,44}$/.test(tx.value.trim())) fail('Geçerli testnet işlem hashini girin.');
      const { job: updated } = await api('/jobs/' + encodeURIComponent(job.id) + '/payment/verify', 'POST', { buyerAccount: account.value.trim(), transactionHash: tx.value.trim() });
      if (updated?.status !== 'PAID') { message('Makbuz henüz doğrulanmadı; ödeme bekliyor. Kesinleşmeyi bekleyip yeniden kontrol edin.', true); return; }
      await render(); message('Gerçek testnet makbuzu doğrulandı. Ödeme tamamlandı.');
    });
    const account = field(node, 'Transferi yapan testnet hesabınız', { name: 'buyerAccount', maxLength: 64 });
    const tx = field(node, 'Testnet işlem hashi', { name: 'transactionHash', maxLength: 44 }); node.append(submit);
  }
  async function activity() {
    title('Hareketler', 'Sunucunun sağladığı durum kayıtları'); const epoch = state.epoch; const jobs = await jobsList(); if (epoch !== state.epoch) return;
    for (const job of jobs) {
      const events = job.history || job.events;
      if (Array.isArray(events) && events.length) { const panel = card(job.title + ' · durum geçmişi');
        table(['Zaman', 'Durum', 'Açıklama'], events.map(e => [e.at || e.createdAt || '', e.status || e.type || e.stage || '', e.message || '']), panel);
      }
    }
    paragraph('Geçmiş kaydı sunulmadığında yalnızca güncel sunucu durumu gösterilir; eksik hareketler oluşturulmaz.');
  }
  function settings() {
    title('Kimlik ve yerel kasa', 'Anahtarlar bu tarayıcı ve cihaza bağlıdır.'); const panel = card('Mevcut test kimliği');
    paragraph(`${state.session.displayName} · ${state.session.role} · ${state.session.id}`, panel);
    if (state.session.paymentAccount) paragraph(`Testnet hesabı: ${state.session.paymentAccount}`, panel);
    paragraph('Oturum belirteci yalnızca bu sekmenin sessionStorage alanında tutulur; sayfayı yenileyince korunur. Özel RSA anahtarları, CSV ve çözücü şifreli IndexedDB kasasındadır. Anahtar dışa aktarımı yoktur. Site verilerini temizlemek, farklı cihaz veya yeni kimlik kullanmak eski işlerin çözülmesini engelleyebilir.', panel);
    paragraph('Çıkış yalnızca oturumu kapatır, eski kasayı silmez. Yeni oturum yeni kimlik oluşturur; önceki kasanın saklanması yeni kimliğe erişim sağlamaz.', panel, 'danger');
    const consent = field(panel, 'Yeni kimliğin eski iş ve anahtarlara erişmeyeceğini anladım; mevcut kasayı koruyarak çıkış yap.', { type: 'checkbox', required: false });
    button('Rol değiştirmek için yeni oturum başlat', async () => { if (!consent.checked) fail('Önce yerel anahtar ve eski kimlik uyarısını onaylayın.'); await logout(); }, panel, 'btn secondary');
  }
  async function logout() {
    state.epoch++; storage.removeItem(TOKEN_KEY); state.token = null; state.session = null; state.vault = null; state.draft = null; state.uncertain = false; state.newDraftAllowed = false;
    win.history.pushState({}, '', '/workspace'); await render(); message('Oturum kapandı. Eski yerel kasa silinmedi; yeni oturum eski kimliğe erişim sağlamaz.');
  }
  async function render() {
    const epoch = ++state.epoch; root.replaceChildren(); chrome(); message();
    const route = routeOf(win.location.href, win.location.origin);
    if (!route) { title('Sayfa bulunamadı'); link('Çalışma alanına dön', '/workspace'); return; }
    if (!state.session || route.path === '/workspace') { onboarding(); return; }
    root.setAttribute('aria-busy', 'true'); paragraph('Yükleniyor…');
    try {
      if (['/job', '/offer', '/delivery', '/payments'].includes(route.path)) {
        if (!route.id || !/^[a-f0-9]{32}$/.test(route.id)) fail('Geçerli bir iş kimliği gerekli.');
        const { job } = await api('/jobs/' + encodeURIComponent(route.id)); if (epoch !== state.epoch) return; root.replaceChildren();
        if (route.path === '/job') await detail(job);
        if (route.path === '/offer') await offerForm(job);
        if (route.path === '/delivery') await delivery(job);
        if (route.path === '/payments') await payments(job);
      } else {
        root.replaceChildren();
        if (route.path === '/jobs/new') await newJob();
        else if (route.path === '/settings') settings();
        else if (route.path === '/activity') await activity();
        else {
          if (route.path === '/customer') requireRole('buyer');
          if (route.path === '/provider') requireRole('provider');
          title(route.path === '/jobs' ? (state.session.role === 'buyer' ? 'İşlerim' : 'Açık işler ve tekliflerim') : state.session.role === 'buyer' ? 'İşlerin, kontrolün altında.' : 'Bir sonraki işin burada.', 'İşleri, teklifleri ve teslimleri tek yerden takip et.');
          if (state.session.role === 'buyer') link('Yeni şifreli iş oluştur', '/jobs/new');
          if (state.session.role === 'buyer') await renderRecovery(root);
          const summary = el('div', null, 'dashboard-summary'); root.append(summary);
          try {
            const jobs = await jobsList();
            for (const [label, count] of [
              ['Bu sayfadaki işler', jobs.length],
              ['Tekliflere açık', jobs.filter(j => j.status === 'OPEN').length],
              ['Teslim / kabul bekleyen', jobs.filter(j => ['AWARDED', 'DELIVERED', 'REVISION'].includes(j.status)).length],
            ]) { const box = el('div', null, 'metric-card'); box.append(el('span', label), el('strong', count, 'summary-count')); summary.append(box); }
          } catch (err) { summary.hidden = true; paragraph(err instanceof FriendlyError ? err.message : 'İş listesi yüklenemedi. Yerel doğrulanmamış girişimler korunuyor.', root, 'danger'); }
          button('Listeyi yenile', render, root, 'btn secondary');
        }
      }
    } catch (err) {
      if (epoch !== state.epoch) return; root.replaceChildren(); title('İşlem şu anda kullanılamıyor');
      paragraph(err instanceof FriendlyError ? err.message : 'Bu sayfa yüklenemedi. Bağlantınızı ve yerel kasa erişimini kontrol edin.', root, 'danger');
      button('Yeniden dene', render); link('Çalışma alanına dön', '/workspace');
    } finally { if (epoch === state.epoch) { root.removeAttribute('aria-busy'); if (state.busy) controlsBusy(true); } }
  }
  let listenersBound = false;
  async function start() {
    if (!listenersBound) {
    listenersBound = true;
    doc.addEventListener('click', event => {
      const a = event.target.closest?.('a[data-route]');
      if (!a || event.defaultPrevented || event.button > 0 || event.ctrlKey || event.metaKey || event.shiftKey || event.altKey || a.target === '_blank' || !routeOf(a.href, win.location.origin)) return;
      event.preventDefault(); if (!state.busy) void navigate(a.href);
    });
    win.addEventListener('popstate', () => { if (state.busy) state.pendingNavigation = true; else void render(); });
    $('workspace-logout')?.addEventListener('click', () => run(logout));
    }
    if (state.token) {
      try { const { session } = await api('/session'); if (!session || !['buyer', 'provider'].includes(session.role)) throw Error(); state.session = session; state.vault = vaultFactory(session.id); }
      catch (err) {
        if (!state.token) await render();
        else { root.replaceChildren(); title('Oturum doğrulanamadı'); paragraph('Kimliğiniz korunuyor. Yeni kimlik oluşturmadan bağlantıyı yeniden deneyin.'); button('Oturumu yeniden doğrula', start); }
        message(err instanceof FriendlyError ? err.message : 'Oturum geri yüklenemedi. Yeniden deneyin.', true); return;
      }
    }
    await render();
  }
  return { start, render, navigate, state, api };
}
if (typeof document !== 'undefined' && document.getElementById('workspace-root')) {
  const app = createWorkspace({ document, window });
  void app.start();
}
