import { msg, bindText, bindAttribute, hasTranslation, getLocale, setLanguage, initI18n, localizeDocument, mountLanguagePicker } from './i18n.mjs';
import { MAX_BYTES, parseCSV, verifyValues, exportCSV } from './csv-input.mjs';
import { hashRequest, hashOutput, hashProgram, sha256 } from './gc-core.mjs';
import { PROFILE as RECIPE_PROFILE, compileRecipe, referenceApply, estimateRecipe, hashRecipeRequest, hashRecipeOutput, hashRecipeProgram } from './recipe-core.mjs';
import { prepareRecipe } from './recipe-client.mjs';
import { parseRecipeColumn, applyRecipeOutput } from './recipe-csv.mjs';
import { PROFILE as PLAN_PROFILE, estimatePlan, hashPlan, hashPlanRequest, hashPlanProgram, hashPlanOutput, validatePlanRequest, freezePlanData } from './plan-core.mjs';
import { preparePlan } from './plan-client.mjs';
import { PROFILE as PROOF_PROFILE, RECORD_PROFILE, isProofProfile, schemeForProfile, PROOF_PLAN_LIMITS, validateProofPlanRequest, validateProofPlanContext, canonicalProofPlanRequest, hashProofPlanRequest, hashProofPlanProgram, hashProofManifest } from './proof-protocol.mjs';
import { prepareProofPlan, decodeProofPlan } from './proof-client.mjs';
import { publicTask, publicTaskHash, acceptAgentProposal, privatePlanInputs, applyAgentOutput } from './agent-plan.mjs';
import { publicRecordTask, publicRecordTaskHash, acceptRecordProposal, privateRecordInputs, applyRecordOutput, recordTemplate } from './record-plan.mjs';
import { referenceRecord, estimateRecordPlan, hashRecordPlan, hashRecordOutput } from './record-core.mjs';
import { createVault, quoteCommitment, randomSalt, parseNearAmount, formatNearAmount } from './workspace-vault.mjs';
import { WALLET_ESCROW_POLICY } from './wallet-pins.mjs';

export const TOKEN_KEY = 'nope.workspace.session.v1';
export const PROFILE = 'nope-csv-gc-v1';
export { PROOF_PROFILE, RECORD_PROFILE };
// Use the function's canonical query entry: Vercel preserves original paths on rewrites.
export function workspaceApiUrl(path) {
  const url = new URL(path, 'https://workspace.invalid');
  const query = new URLSearchParams(url.searchParams); query.set('route', url.pathname.slice(1));
  return '/api/workspace?' + query.toString();
}
export const ROUTES = new Set(['/workspace', '/customer', '/provider', '/jobs/new', '/jobs', '/job', '/offer', '/delivery', '/payments', '/activity', '/settings']);
const HASH = /^[a-f0-9]{64}$/;
const proofTask = task => isProofProfile(task?.profile);
const baseTask = task => proofTask(task) ? task.task : task;
const taskRows = task => baseTask(task)?.rowCount;
const encodedResult = value => Object.fromEntries(['profile', 'nonce', 'rowCount', 'outputs', 'inputSha256', 'programSha256', 'outputSha256'].map(k => [k, value[k]]));
const proofBinding = job => ({ jobId: job.id, version: job.delivery?.version, contractId: job.payment?.contractId, bindingHash: job.payment?.bindingHash, provider: job.selectedOffer?.paymentAccount, amountYocto: job.selectedOffer?.amountYocto });
const proofContextKey = job => JSON.stringify([job.id, job.profile, job.delivery?.version, job.delivery?.nonce, job.delivery?.rowCount, job.delivery?.inputSha256, job.delivery?.programSha256, job.delivery?.outputSha256, job.planSha256, proofBinding(job)]);
const canonicalProofBundle = value => JSON.stringify(value, (_, v) => v && typeof v === 'object' && !Array.isArray(v) ? Object.fromEntries(Object.keys(v).sort().map(k => [k, v[k]])) : v);
export const hashPublicProofBundle = bundle => sha256(canonicalProofBundle(bundle));
export function serverProofMatches(job) {
  const p = job?.proof, d = job?.delivery;
  return isProofProfile(job?.profile) && escrowMetadata(job) && p?.status === 'VERIFIED' && p.scheme === schemeForProfile(job.profile) && p.version === 1 && Number.isSafeInteger(p.rowProofCount) && p.rowProofCount > 0 &&
    p.deliveryVersion === d?.version && p.outputSha256 === d?.outputSha256 && p.requestSha256 === d?.inputSha256 &&
    p.programSha256 === d?.programSha256 && p.planSha256 === job.planSha256 && p.bindingHash === job.payment?.bindingHash &&
    [p.bundleSha256, p.finalContext, p.manifestSha256].every(h => typeof h === 'string' && HASH.test(h));
}
function clientProofMatches(job, verification) {
  return serverProofMatches(job) && verification?.valid === true && verification.contextKey === proofContextKey(job) &&
    ['bundleSha256', 'finalContext', 'manifestSha256', 'requestSha256', 'rowProofCount'].every(k => verification[k] === job.proof[k]);
}
function proofCapability(value) {
  if (value === undefined) return Object.freeze({ profile: PROOF_PROFILE, enabled: false, contractId: null });
  if (!value || !isProofProfile(value.profile) || typeof value.enabled !== 'boolean' || value.enabled && (typeof value.contractId !== 'string' || !value.contractId.endsWith('.testnet') || !testnetAccount(value.contractId))) throw productError(msg('Geçerli sonuç kanıtı yeteneği alınamadı; eski sürüme geçilmedi.'));
  return Object.freeze({ profile: value.profile, enabled: value.enabled, contractId: value.contractId ?? null });
}
const TX_HASH = /^[1-9A-HJ-NP-Za-km-z]{43,44}$/;
const LEGACY_ESCROW_KIND = 'SPONSORED_TESTNET_ESCROW';
export const WALLET_ESCROW_KIND = 'WALLET_TESTNET_ESCROW';
const WALLET_RESUME_NAMESPACE = 'nope-wallet-redirect-v1';
const WALLET_RESUME_RECORD = '__wallet_redirect__';
const RESUME_ACTIONS = new Set(['fund', 'record', 'release', 'refund']);
const ESCROW_PENDING = new Set(['FUNDING_PENDING', 'RECORD_PENDING', 'PAYOUT_PENDING', 'REFUND_PENDING']);
const escrowStatuses = { NOT_FUNDED: msg('Henüz yatırılmadı'), FUNDING_PENDING: msg('Cüzdan yatırması kesinleşiyor'), HELD: msg('Müşteri tutarı zincirde emanette'), RECORD_PENDING: msg('Teslim kaydı kesinleşiyor'), RELEASE_READY: msg('Teslim zincirde kayıtlı'), PAYOUT_PENDING: msg('Ödeme kesinleşiyor'), PAID: msg('Zincirde ödeme doğrulandı'), REFUND_PENDING: msg('Müşteri cüzdanına iade kesinleşiyor'), REFUNDED: msg('İş bakiyesi müşteri cüzdanına iade edildi'), ERROR: msg('Ödeme işlemi tamamlanamadı · durumu kontrol edin'), UNKNOWN: msg('İşlemin sonucu belirsiz · yalnızca durum kontrolü') };
const walletJob = job => job?.payment?.kind === WALLET_ESCROW_KIND;
const legacyJob = job => !walletJob(job);
const escrowJob = job => walletJob(job) || job?.payment?.kind === LEGACY_ESCROW_KIND;
export function linkedWallet(session) {
  const wallet = session?.wallet;
  return wallet?.network === 'testnet' && testnetAccount(wallet.accountId) && typeof wallet.publicKey === 'string' && /^ed25519:[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(wallet.publicKey) && typeof wallet.verifiedAt === 'string' && Number.isFinite(Date.parse(wallet.verifiedAt)) ? wallet : null;
}
export function walletCapabilityMatches(value, policy = WALLET_ESCROW_POLICY) {
  return Boolean(policy && policy.network === 'testnet' && policy.requireKeyless === true && testnetAccount(policy.contractId) && TX_HASH.test(policy.codeHash) && policy.domain === 'NOPE:WALLET-ESCROW:V2:testnet' && policy.storageDepositYocto === '40960000000000000000000' && value?.required === true && value.enabled === true && value.network === 'testnet' && value.contractId === policy.contractId);
}
export function walletApiError(code) {
  if (code === 'WALLET_CHALLENGE_EXPIRED') return msg('Cüzdan doğrulama isteğinin süresi doldu. Hesap bağlamayı yeniden başlatıp yeni mesajı imzala.');
  if (code === 'WALLET_CHALLENGE_USED') return msg('Bu hesap bağlama isteği zaten kullanıldı. Durumu yenile veya yeni doğrulama isteği başlat.');
  if (code === 'WALLET_WRONG_NETWORK') return msg('Cüzdan ağı testnet olarak doğrulanamadı. Ana ağa geçilmedi; testnet bağlantısını kontrol et.');
  if (['WALLET_SIGNATURE_NOT_VERIFIED','WALLET_INVALID_PROOF','WALLET_INVALID_PUBLIC_KEY','WALLET_KEY_MISMATCH','WALLET_FULL_ACCESS_REQUIRED','WALLET_INVALID_ENCODING'].includes(code)) return msg('Cüzdan imzası ve hesap kontrolü doğrulanamadı. Doğru testnet hesabıyla yeni bağlama isteği başlat.');
  if (['WALLET_CHALLENGE_MISMATCH','WALLET_SESSION_MISMATCH'].includes(code)) return msg('Hesap bağlama isteği bu oturumla eşleşmiyor. Mevcut oturumdan yeni doğrulama isteği başlat.');
  if (code === 'WALLET_ACCOUNT_IMMUTABLE') return msg('Farklı cüzdan için önce açıkça yeni oturum başlat. Mevcut yerel kasa silinmedi.');
  return null;
}
const escrowMetadata = job => escrowJob(job) && job.payment.network === 'testnet' && testnetAccount(job.payment.contractId) && HASH.test(job.payment.bindingHash) && Object.hasOwn(escrowStatuses, job.payment.status);
const walletPartiesValid = job => job?.buyerWallet?.network === 'testnet' && testnetAccount(job.buyerWallet.accountId) && job.selectedOffer?.wallet?.network === 'testnet' && testnetAccount(job.selectedOffer.paymentAccount) && job.selectedOffer.wallet.accountId === job.selectedOffer.paymentAccount && job.buyerWallet.accountId !== job.selectedOffer.paymentAccount && ![job.buyerWallet.accountId,job.selectedOffer.paymentAccount].includes(job.payment?.contractId);
function deadlineReached(value) { return typeof value === 'string' && /^[1-9]\d{0,19}$/.test(value) && BigInt(Date.now()) * 1_000_000n >= BigInt(value); }
function deadlinePassed(value) { return deadlineReached(value) && BigInt(Date.now()) * 1_000_000n > BigInt(value); }
function resumeActionFor(job) {
  const payment = job?.payment, action = payment?.operation?.resumeAction;
  if (!escrowMetadata(job) || !RESUME_ACTIONS.has(action) || payment.operation.action !== action ||
      !ESCROW_PENDING.has(payment.status) || payment.operation.status !== 'PENDING') return null;
  if (action === 'fund') return job.status === 'AWARDED' && !deadlineReached(payment.executionDeadlineNs) ? action : null;
  if (action === 'refund') return ['AWARDED', 'DELIVERED', 'REVISION', 'ACCEPTED'].includes(job.status) && deadlinePassed(payment.reviewDeadlineNs) ? action : null;
  if (!Number.isInteger(job.delivery?.version) || job.delivery.version < 1 || !HASH.test(job.delivery.outputSha256)) return null;
  if (action === 'record') return job.status === 'DELIVERED' && !deadlineReached(payment.executionDeadlineNs) ? action : null;
  return job.status === 'ACCEPTED' && !deadlineReached(payment.reviewDeadlineNs) &&
    payment.recordedVersion === job.delivery.version && payment.recordedOutputHash === job.delivery.outputSha256 ? action : null;
}
export function escrowRecordedDelivery(job) {
  return escrowMetadata(job) && job.payment.verified === true && ['HELD', 'RELEASE_READY'].includes(job.payment.status) && Number.isInteger(job.delivery?.version) && job.delivery.version > 0 &&
    HASH.test(job.delivery.outputSha256) && job.payment.recordedVersion === job.delivery.version && job.payment.recordedOutputHash === job.delivery.outputSha256;
}
export function escrowExecutionAllowed(job) {
  return walletJob(job) && walletPartiesValid(job) && escrowMetadata(job) && job.payment.verified === true && !deadlineReached(job.payment.executionDeadlineNs) &&
    job.payment.status === 'HELD';
}
export function walletActionAllowed(job, action, session) {
  const account = linkedWallet(session)?.accountId;
  if (!walletJob(job) || !walletPartiesValid(job) || !escrowMetadata(job) || !account || ['UNKNOWN','ERROR','PAID','REFUNDED',...ESCROW_PENDING].includes(job.payment.status)) return false;
  const buyer = session.role === 'buyer' && account === job.buyerWallet?.accountId;
  if (action === 'fund') return buyer && job.status === 'AWARDED' && job.payment.status === 'NOT_FUNDED' && !deadlineReached(job.payment.executionDeadlineNs);
  if (action === 'record') return session.role === 'provider' && job.selectedOffer?.wallet?.network === 'testnet' && account === job.selectedOffer.wallet.accountId && account === job.selectedOffer.paymentAccount && job.status === 'DELIVERED' && job.payment.status === 'HELD' && job.payment.verified === true && !escrowRecordedDelivery(job) && Number.isInteger(job.delivery?.version) && job.delivery.version > 0 && HASH.test(job.delivery?.outputSha256) && !deadlineReached(job.payment.executionDeadlineNs);
  if (action === 'release') return buyer && job.status === 'ACCEPTED' && job.payment.status === 'RELEASE_READY' && escrowRecordedDelivery(job) && !deadlineReached(job.payment.reviewDeadlineNs);
  return action === 'refund' && buyer && ['AWARDED','DELIVERED','REVISION','ACCEPTED'].includes(job.status) && ['HELD','RELEASE_READY'].includes(job.payment.status) && job.payment.verified === true && deadlinePassed(job.payment.reviewDeadlineNs);
}
export function routeOf(href, origin = 'http://localhost') {
  const url = new URL(href, origin);
  if (url.origin !== new URL(origin).origin || !ROUTES.has(url.pathname)) return null;
  return { path: url.pathname, id: url.searchParams.get('id') || '' };
}
export function testnetAccount(value) {
  return typeof value === 'string' && (/^[a-f0-9]{64}$/.test(value) || (value.length >= 8 && value.length <= 64 && /^[a-z0-9]+(?:[-_][a-z0-9]+)*(?:\.[a-z0-9]+(?:[-_][a-z0-9]+)*)*\.testnet$/.test(value)));
}
export function createPayload({ jobId, title, description, deadlineISO, task, buyerPublicKey, publicTask: publicTaskValue }) {
  const rowCount = taskRows(task);
  if (!/^[a-f0-9]{32}$/.test(jobId) || ![PROFILE, RECIPE_PROFILE, PLAN_PROFILE, PROOF_PROFILE, RECORD_PROFILE].includes(task?.profile) || !Number.isInteger(rowCount) || rowCount < 1 || rowCount > 32) throw productError(msg('Invalid prepared job'));
  if (task.profile === RECIPE_PROFILE) estimateRecipe(task.recipe, task.rowCount);
  if (task.profile === PLAN_PROFILE) validatePlanRequest(task);
  if (proofTask(task)) { validateProofPlanRequest(task); if (task.proofManifest.context.jobId !== jobId) throw productError(msg('Proof job mismatch')); }
  if (task.profile !== PLAN_PROFILE && !proofTask(task) && publicTaskValue !== undefined) throw productError(msg('Public planning task requires a plan profile'));
  return { jobId, title, description, deadlineISO, profile: task.profile, rowCount, task, buyerPublicKey, ...(task.profile === PLAN_PROFILE || proofTask(task) ? { publicTask: task.profile === RECORD_PROFILE ? publicRecordTask(publicTaskValue) : publicTask(publicTaskValue) } : {}) };
}
const recipeTask = task => task?.profile === RECIPE_PROFILE;
const taskInputHash = task => proofTask(task) ? hashProofPlanRequest(task) : task?.profile === PLAN_PROFILE ? hashPlanRequest(task) : recipeTask(task) ? hashRecipeRequest(task) : hashRequest(task);
const taskProgramHash = task => proofTask(task) ? hashProofPlanProgram(task.task.plan) : task?.profile === PLAN_PROFILE ? hashPlanProgram(task.plan) : recipeTask(task) ? hashRecipeProgram(task.recipe) : hashProgram();
export async function verifyFundingCommitments(job, payload, {allowMissingLocal = false} = {}) {
  if (!walletJob(job) || !HASH.test(job.taskHash) || !HASH.test(job.programHash) || !HASH.test(job.planSha256)) throw productError(msg('İmzalanacak işlem güncel iş, tutar veya teslimle eşleşmiyor. İmza istenmedi.'));
  if (!payload?.task) {
    if (!allowMissingLocal) throw productError(msg('Bu cihazda özgün şifreli istek yok. Yerel dosya kontrolü yapılamadığını açıkça onaylamadan yatırma imzası istenmez.'));
    return {localChecked:false};
  }
  if (payload.jobId !== job.id || !isProofProfile(payload.profile) || payload.profile !== job.profile || payload.task.profile !== payload.profile) throw productError(msg('İmzalanacak işlem güncel iş, tutar veya teslimle eşleşmiyor. İmza istenmedi.'));
  validateProofPlanContext(payload.task,{jobId:job.id,buyerCommitment:await sha256('NOPE:buyer:'+job.buyerId),contractId:job.payment.contractId});
  if (await taskInputHash(payload.task) !== job.taskHash || await taskProgramHash(payload.task) !== job.programHash || payload.task.task.planSha256 !== job.planSha256) throw productError(msg('İmzalanacak işlem güncel iş, tutar veya teslimle eşleşmiyor. İmza istenmedi.'));
  return {localChecked:true};
}
// A private local fingerprint; never included in the planning task or remote job.
const datasetHash = dataset => sha256(JSON.stringify(dataset));

/** Actual dedicated browser worker. workerFactory is an explicit unit-test seam;
 * the production path never synthesizes a plan or falls back to a remote AI. */
export async function generateAgentPlan(task, { workerFactory = () => new Worker(new URL('./agent-model-worker.mjs', import.meta.url), { type: 'module' }), onProgress = () => {}, signal, timeoutMs = 300_000 } = {}) {
  task = publicTask(task);
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 300_000) throw productError(msg('Geçersiz yerel model zaman sınırı.'));
  const taskHash = await publicTaskHash(task);
  if (signal?.aborted) throw productError(msg('Yerel planlama iptal edildi; plan onaylanmadı.'));
  const worker = workerFactory();
  let timer, abort;
  try {
    const result = await new Promise((resolve, reject) => {
      abort = () => reject(productError(msg('Yerel planlama iptal edildi; plan onaylanmadı.')));
      signal?.addEventListener('abort', abort, { once: true });
      timer = setTimeout(() => reject(productError(msg('Yerel model beş dakikalık zaman sınırına ulaştı; plan onaylanmadı. Tekrar deneyin.'))), timeoutMs);
      worker.onmessage = event => {
        const value = event.data;
        if (value?.type === 'progress') { try { onProgress(value); } catch {} }
        else if (value?.type === 'plan') resolve(value);
        else if (value?.type === 'error') {
          const error = productError(modelFailure(value));
          // Sanitized worker diagnostics stay on the local Error for debugging;
          // the UI uses localizedMessage and never prints an unknown diagnostic.
          if (typeof value.error === 'string') error.message = value.error;
          reject(error);
        }
        else reject(productError(msg('Yerel modelden beklenmeyen cevap geldi.')));
      };
      worker.onerror = () => reject(productError(msg('Yerel model yüklenemedi veya bu tarayıcıda çalıştırılamadı.')));
      if (signal?.aborted) { abort(); return; }
      worker.postMessage({ type: 'plan', task, taskHash });
    });
    if (signal?.aborted) throw productError(msg('Yerel planlama iptal edildi; plan onaylanmadı.'));
    if (typeof result.raw !== 'string' || typeof result.model?.id !== 'string' || !result.model.id || typeof result.model.revision !== 'string' || !result.model.revision) throw productError(msg('Model kimliği veya plan cevabı eksik.'));
    const checked = await acceptAgentProposal(task, result.raw);
    if (signal?.aborted) throw productError(msg('Yerel planlama iptal edildi; plan onaylanmadı.'));
    return freezePlanData({ ...checked, model: { id: result.model.id, revision: result.model.revision } });
  } finally { clearTimeout(timer); signal?.removeEventListener('abort', abort); worker.terminate(); }
}

/** Dedicated proof worker; a verification result is never inferred from proving,
 * a server boolean, payment finality or a locally cached badge. */
export async function runProofWorker(value, { workerFactory = () => new Worker(new URL('./proof-worker.mjs', import.meta.url), { type: 'module' }), signal, onProgress = () => {}, timeoutMs = 600_000 } = {}) {
  if (!['prove', 'verify'].includes(value?.type) || !Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 600_000) throw productError(msg('Geçersiz kanıt işlemi.'));
  validateProofPlanRequest(value.request);
  const request = structuredClone({ type: value.type, request: value.request, delivery: value.delivery, binding: value.binding,
    ...(value.type === 'prove' ? { witness: value.witness } : { bundle: value.bundle }) });
  if (signal?.aborted) throw productError(msg('Kanıt işlemi iptal edildi.'));
  const worker = workerFactory(); let timer, abort, completed = 0;
  try {
    const result = await new Promise((resolve, reject) => {
      abort = () => reject(productError(msg('Kanıt işlemi iptal edildi.'))); signal?.addEventListener('abort', abort, { once: true });
      timer = setTimeout(() => reject(productError(msg('Kanıt işleminin zaman sınırı doldu; doğrulanmış sayılmadı.'))), timeoutMs);
      worker.onerror = () => reject(productError(msg('Kanıt çalışanı başlatılamadı veya tamamlanamadı.')));
      worker.onmessage = ({ data }) => {
        if (data?.type === 'progress') {
          if (data.total !== request.request.proofManifest.rows.length || !Number.isSafeInteger(data.completed) || data.completed < completed || data.completed > data.total) { reject(productError(msg('Geçersiz kanıt ilerlemesi.'))); return; }
          completed = data.completed; try { onProgress({ completed, total: data.total }); } catch {}
        } else if (request.type === 'prove' && data?.type === 'proof' && data.bundle && typeof data.bundle === 'object') resolve(data.bundle);
        else if (request.type === 'verify' && data?.type === 'verified' && data.valid === true) resolve(true);
        else reject(productError(typeof data?.error === 'string' ? msg(data.error) : msg('Sonuç kanıtı bu teslim için doğrulanamadı.')));
      };
      if (signal?.aborted) { abort(); return; } worker.postMessage(request);
    });
    if (signal?.aborted) throw productError(msg('Kanıt işlemi iptal edildi.'));
    return result;
  } finally { clearTimeout(timer); signal?.removeEventListener('abort', abort); worker.terminate(); }
}

/** Recheck the entire local approval immediately before creating ciphertext. */
export async function prepareApprovedAgentJob(dataset, task, approval, { approved = false, garblePlan = preparePlan, proofOptions } = {}) {
  dataset = freezePlanData(structuredClone(dataset)); task = publicTask(task);
  approval = approval && freezePlanData(structuredClone(approval));
  if (!approved || !approval || approval.datasetSha256 !== await datasetHash(dataset)) throw productError(msg('Dosya değişti veya plan onaylanmadı. Planı yeniden üretip onaylayın.'));
  const checked = await acceptAgentProposal(task, approval.plan);
  if (checked.taskHash !== approval.taskHash || checked.planSha256 !== approval.planSha256 || JSON.stringify(checked.task) !== JSON.stringify(approval.task)) throw productError(msg('İş tanımı veya sütun türleri değişti. Planı yeniden üretip onaylayın.'));
  const values = privatePlanInputs(dataset, checked.plan);
  estimatePlan(checked.plan, dataset.rows.length);
  const prepared = await garblePlan(values, checked.plan, proofOptions);
  if (proofOptions) {
    if (!proofTask(prepared.request) || !prepared.witness || !prepared.decoder) throw productError(msg('Sonuç kanıtı hazırlığı tamamlanmadı; eski sürüme geçilmedi.'));
    validateProofPlanRequest(prepared.request); validateProofPlanContext(prepared.request, proofOptions);
    const inputSha256 = await hashProofPlanRequest(prepared.request), context = prepared.request.proofManifest.context;
    if (context.buyerCommitment !== proofOptions.buyerCommitment || context.contractId !== proofOptions.contractId || prepared.witness.jobId !== proofOptions.jobId || prepared.witness.inputSha256 !== inputSha256 || prepared.decoder.profile !== PROOF_PROFILE || canonicalProofPlanRequest(prepared.decoder.request) !== canonicalProofPlanRequest(prepared.request)) throw productError(msg('Gizli kanıt hazırlığı iş bağlamıyla eşleşmiyor.'));
  } else validatePlanRequest(prepared.request);
  const base = baseTask(prepared.request);
  if (prepared.request.profile !== (proofOptions ? PROOF_PROFILE : PLAN_PROFILE) || base.rowCount !== dataset.rows.length || base.planSha256 !== checked.planSha256 || await hashPlan(base.plan) !== checked.planSha256) throw productError(msg('Şifreli görev onaylı planla eşleşmiyor.'));
  return { ...prepared, values, approval: freezePlanData({ ...checked, datasetSha256: approval.datasetSha256, model: approval.model }) };
}
/** Record approval is local, explicit and tied to the exact dataset and draft.
 * Reviewed templates do not invoke a model or receive real column names. */
export async function prepareApprovedRecordJob(dataset, task, approval, { approved = false, epoch, garblePlan = prepareProofPlan, proofOptions } = {}) {
  dataset = freezePlanData(structuredClone(dataset)); task = publicRecordTask(task);
  approval = approval && freezePlanData(structuredClone(approval));
  if (!approved || !approval || approval.datasetSha256 !== await datasetHash(dataset) || epoch !== undefined && approval.epoch !== epoch) throw productError(msg('Dosya değişti veya plan onaylanmadı. Planı yeniden üretip onaylayın.'));
  const checked = await acceptRecordProposal(task, approval.plan);
  if (checked.taskHash !== approval.taskHash || checked.planSha256 !== approval.planSha256 || JSON.stringify(checked.task) !== JSON.stringify(approval.task)) throw productError(msg('İş tanımı veya sütun türleri değişti. Planı yeniden üretip onaylayın.'));
  const values = privateRecordInputs(dataset, checked.plan); estimateRecordPlan(checked.plan, values.length);
  if (!proofOptions) throw productError(msg('Sonuç kanıtı hazırlığı tamamlanmadı; eski sürüme geçilmedi.'));
  const prepared = await garblePlan(values, checked.plan, proofOptions);
  if (prepared.request?.profile !== RECORD_PROFILE || prepared.decoder?.profile !== RECORD_PROFILE || !prepared.witness) throw productError(msg('Sonuç kanıtı hazırlığı tamamlanmadı; eski sürüme geçilmedi.'));
  validateProofPlanRequest(prepared.request); validateProofPlanContext(prepared.request, proofOptions);
  const inputSha256 = await hashProofPlanRequest(prepared.request), context = prepared.request.proofManifest.context, base = baseTask(prepared.request);
  if (context.buyerCommitment !== proofOptions.buyerCommitment || context.contractId !== proofOptions.contractId || prepared.witness.jobId !== proofOptions.jobId || prepared.witness.inputSha256 !== inputSha256 || canonicalProofPlanRequest(prepared.decoder.request) !== canonicalProofPlanRequest(prepared.request) || base.rowCount !== values.length || base.planSha256 !== checked.planSha256 || await hashRecordPlan(base.plan) !== checked.planSha256) throw productError(msg('Gizli kanıt hazırlığı iş bağlamıyla eşleşmiyor.'));
  return { ...prepared, values, approval: freezePlanData({ ...checked, datasetSha256: approval.datasetSha256, epoch: approval.epoch, templateKind: approval.templateKind }) };
}
const recordRoles = kind => kind === 'cashflow'
  ? [msg('Gelir'), msg('Giderler'), msg('Mevcut borç ödemesi'), msg('Önerilen ödeme'), msg('Kredi limiti'), msg('Talep edilen tutar')]
  : [msg('Miktar'), msg('Birim fiyat (kuruş)'), msg('Fatura tutarı (kuruş)'), msg('Bütçe (kuruş)')];
const recordOutputLabels = kind => kind === 'cashflow'
  ? [msg('Net nakit akışı'), msg('Borç sonrası kullanılabilir tutar'), msg('Talep limit içinde (1/0)'), msg('Ödeme karşılanabilir (1/0)')]
  : [msg('Beklenen fatura (kuruş)'), msg('Fazla faturalama (kuruş)'), msg('Bütçe içinde (1/0)'), msg('Fatura eşleşiyor (1/0)')];
const recordRuleSummary = kind => kind === 'cashflow'
  ? [msg('Net nakit akışı = gelir − giderler; negatif fark sıfır gösterilir.'), msg('Kullanılabilir tutar = net nakit akışı − mevcut borç ödemesi; negatif fark sıfır gösterilir.'), msg('Talep edilen tutarın kredi limitini aşıp aşmadığı kontrol edilir.'), msg('Ödeme uygunluğu: giderler geliri aşmamalı, mevcut borç net nakit akışına ve önerilen ödeme kalan tutara sığmalıdır. Sonuçlarda 1 evet, 0 hayır demektir.')]
  : [msg('Beklenen fatura = miktar × birim fiyat.'), msg('Fazla faturalama = fatura tutarı − beklenen tutar; negatif fark sıfır gösterilir.'), msg('Fatura tutarının bütçeyi aşıp aşmadığı kontrol edilir.'), msg('Fatura tutarı beklenen tutarla tam eşleşiyor mu? Sonuçlarda 1 evet, 0 hayır demektir.')];
function recordStepText(step, index) {
  const op = { addSat:msg('Doygun toplama'), subSat:msg('Sıfır tabanlı çıkarma'), min:msg('En küçük'), max:msg('En büyük'), eq:msg('Eşitlik'), lte:msg('Küçük veya eşit'), and:msg('Mantıksal VE'), select:msg('Koşullu seçim'), mul16:msg('Tam 16 bit çarpım') }[step.op];
  return msg`R${12 + index} = ${op} (R${step.a}, R${step.b}, R${step.c})`;
}
function recipeText(recipe) {
  const checked = compileRecipe(recipe).recipe;
  const type = checked.type === 'text' ? msg('Metin') : msg('Sayı');
  const steps = checked.steps.map(step => {
    if (step.op === 'fill') return msg`boş → ${step.value}`;
    if (step.op === 'clamp') return msg`aralık ${step.min}–${step.max}`;
    return {trim:msg('baş/son boşlukları sil'),lowercase:msg('küçük harf'),uppercase:msg('büyük harf'),redactDigits:msg('rakamları * yap')}[step.op];
  });
  return msg`${type}: ${Object.freeze({ toString: () => steps.map(String).join(' → ') })}`;
}
export function decisionAllowed(job, verified, session, proofVerification) {
  return walletJob(job) && walletPartiesValid(job) && linkedWallet(session)?.accountId === job.buyerWallet?.accountId && session?.role === 'buyer' && job.status === 'DELIVERED' && verified?.correct === true &&
    verified.version === job.delivery?.version && verified.outputSha256 === job.delivery?.outputSha256 && HASH.test(verified.outputSha256) && (!escrowJob(job) || job.payment.status === 'HELD' && escrowRecordedDelivery(job) && !deadlineReached(job.payment.reviewDeadlineNs)) &&
    (!isProofProfile(job.profile) || clientProofMatches(job, proofVerification));
}
function localDate(date) {
  return new Date(date.getTime() - date.getTimezoneOffset() * 60000).toISOString().slice(0, 16);
}
// Preserve the source message after Error stringifies its argument, so an
// already-visible error can change language without retrying the action.
function productError(text) {
  const error = new Error(String(text)); error.localizedMessage = text; return error;
}
class FriendlyError extends Error {
  constructor(text) { super(String(text)); this.localizedMessage = text; }
}
function diagnosticText(text) {
  // Catalog membership includes messages whose translation equals their key. Unknown
  // SDK/browser exceptions are diagnostics, not visitor-facing UI copy.
  if (hasTranslation(text)) return msg(text);
  return msg('İşlem tamamlanamadı. Bağlantıyı ve bu cihazdaki yerel kasayı kontrol edip durumu yenileyin.');
}
function errorText(error) {
  if (error.localizedMessage) return error.localizedMessage;
  const text = error.message || 'İşlem tamamlanamadı.';
  // This stale-plan validation also runs before browser catalogs initialize.
  if (text === 'Plan bu iş tanımına ait değil.') return msg('Plan bu iş tanımına ait değil.');
  // Only known validation templates are translated; model-authored explanations
  // and customer content remain interpolation values, never catalog keys.
  const unsupported = 'Model bu işi desteklenen gizli işlemlerle planlayamadı: ';
  if (text.startsWith(unsupported)) return msg`Model bu işi desteklenen gizli işlemlerle planlayamadı: ${text.slice(unsupported.length)}`;
  const row = /^(\d+)(\..*)$/.exec(text);
  if (row) {
    const number = row[1];
    switch (row[2]) {
      case '. veri satırı: metin en fazla 16 bayt yazdırılabilir ASCII olmalı. Türkçe karakter, sekme ve satır sonu desteklenmez; veri kesilmez.':
        return msg`${number}. veri satırı: metin en fazla 16 bayt yazdırılabilir ASCII olmalı. Türkçe karakter, sekme ve satır sonu desteklenmez; veri kesilmez.`;
      case '. CSV satırında sütun sayısı başlıkla eşleşmiyor.':
        return msg`${number}. CSV satırında sütun sayısı başlıkla eşleşmiyor.`;
      case '. CSV satırında =, +, - veya @ ile başlayan hücre var. Formül güvenliği için bu prototip negatif değerler dahil bu hücreleri reddeder; hücreler sessizce değiştirilmez.':
        return msg`${number}. CSV satırında =, +, - veya @ ile başlayan hücre var. Formül güvenliği için bu prototip negatif değerler dahil bu hücreleri reddeder; hücreler sessizce değiştirilmez.`;
      case '. veri satırı: seçilen sütun boş veya 0–254 arasında kanonik tam sayı olmalı (01 ve boşluk kabul edilmez). 255 boş hücre için ayrılmıştır.':
        return msg`${number}. veri satırı: seçilen sütun boş veya 0–254 arasında kanonik tam sayı olmalı (01 ve boşluk kabul edilmez). 255 boş hücre için ayrılmıştır.`;
    }
  }
  const rows = /^Expected 1–(\d+) rows\.$/.exec(text);
  if (rows) return msg`Expected 1–${rows[1]} rows.`;
  return diagnosticText(text);
}
const modelStages = {
  loading: msg('Model yükleniyor'), download: msg('Model indiriliyor'), verified: msg('Model dosyası doğrulandı'),
  initializing: msg('Model başlatılıyor'), fallback: msg('Model CPU üzerinde başlatılıyor'), generating: msg('Yerel plan üretiliyor'),
};
function modelProgress(value) {
  const stage = modelStages[value.stage] || msg('Yerel model çalışıyor…');
  if (value.file) return msg`${stage}: ${value.file}`;
  // Some worker progress messages carry byte counters without structured fields.
  // Keep those reported counters visible; the stage caption stays translatable.
  const counters = typeof value.message === 'string' && /\d+(?:\.\d+)?\s*\/\s*\d+(?:\.\d+)?/.exec(value.message);
  return counters && !Number.isFinite(value.loaded) ? msg`${stage} · ${counters[0]}` : stage;
}
function modelFailure(value) {
  const text = typeof value.error === 'string' ? value.error : 'Yerel model çalıştırılamadı.';
  const detail = /^Local model failed \([^)]*\): (.*)$/.exec(text);
  return detail ? msg`Yerel model başarısız (${modelStages[value.stage] || msg('Yerel model')}): ${errorText({ message: detail[1] })}` : diagnosticText(text);
}
// Values render again inside a bound message; dates must follow the new locale
// without changing datetime-local controls or any serialized wire timestamps.
const displayDate = value => Object.freeze({ toString: () => new Date(value).toLocaleString(getLocale()) });
const displayNumber = (value, decimals) => Object.freeze({ toString: () => value.toLocaleString(getLocale(), { minimumFractionDigits: decimals, maximumFractionDigits: decimals }) });
const fail = text => { throw new FriendlyError(text); };
const statusText = { OPEN: msg('Tekliflere açık'), CLOSED: msg('Teklifler kapandı'), AWARDED: msg('Sağlayıcı seçildi'), DELIVERED: msg('Teslim edildi'), REVISION: msg('Düzeltme istendi'), ACCEPTED: msg('Kabul edildi · ödeme bekliyor'), PAID: msg('Zincirde ödeme doğrulandı'), REFUNDED: msg('İade zincirde doğrulandı') };

export function createWorkspace({ document: doc, window: win, fetch: fetcher = globalThis.fetch, storage = win.sessionStorage, vaultFactory = createVault, garble = prepareRecipe, garblePlan = preparePlan, garbleProofPlan = prepareProofPlan, agentWorkerFactory, proofWorkerFactory, walletPolicy = WALLET_ESCROW_POLICY, walletFactory = async options => (await import('./wallet-client.mjs')).createWalletClient(options) } = {}) {
  const $ = id => doc.getElementById(id);
  const root = $('workspace-root');
  const state = { token: storage.getItem(TOKEN_KEY), session: null, vault: null, epoch: 0, busy: false, draft: null, uncertain: false, newDraftAllowed: false, escrowUncertain: new Set(), escrowPoll: null, escrowPollKey: '', escrowPollCount: 0, proofCapability: null, walletCapability: null, walletPending: null, proofVerifications: new Map(), proofAbort: null };
  let walletClient;
  const walletConfigured = () => walletCapabilityMatches(state.walletCapability, walletPolicy);
  const client = async () => {
    if (!walletConfigured()) fail(msg('Testnet cüzdan emaneti kullanılamıyor. Yeni iş veya eski ödeme akışına geçiş yapılmadı.'));
    return walletClient ??= await walletFactory({window:win, network:'testnet', policy:walletPolicy});
  };
  const redirectVault = () => vaultFactory(WALLET_RESUME_NAMESPACE);
  async function saveWalletResume(pending) {
    const previous = await redirectVault().loadJob(WALLET_RESUME_RECORD);
    if (previous?.pending?.kind === 'transaction' && previous.token !== state.token && linkedWallet(state.session)?.accountId !== previous.pending.accountId) fail(msg('Önceki cüzdan işlemi bekliyor. Yeni işlem imzalamadan mevcut kaydı doğrula.'));
    const value = {version:1, token:state.token, sessionId:state.session.id, expiresAt:Date.now()+15*60*1000, pending};
    await redirectVault().saveJob(WALLET_RESUME_RECORD, value);
    const saved = await redirectVault().loadJob(WALLET_RESUME_RECORD);
    if (JSON.stringify(saved) !== JSON.stringify(value)) fail(msg('Cüzdan dönüşü için yerel oturum kaydedilemedi. İmza istenmedi.'));
    state.walletPending = pending;
  }
  async function clearWalletResume() { await redirectVault().saveJob(WALLET_RESUME_RECORD, {version:1,cleared:true}); state.walletPending = null; }
  function walletError(error) {
    if (error?.code === 'WALLET_REJECTED') return msg('Cüzdan imzası iptal edildi. İşlem tamamlandı sayılmadı.');
    return msg('Cüzdan işlemi tamamlanamadı veya sonucu belirsiz. Yeni imza istemeden mevcut işlemi kontrol edin.');
  }
  function ownsWallet(job, action) {
    const account = linkedWallet(state.session)?.accountId;
    return Boolean(account && (action === 'record' ? isSelected(job) && account === job.selectedOffer?.paymentAccount : isBuyer(job) && account === job.buyerWallet?.accountId));
  }
  async function verifyWalletResult(result) {
    const {wallet, session} = await api('/wallet/verify','POST',result);
    if (!/^[a-f0-9]{32}$/.test(session?.id) || session.role !== state.session.role || linkedWallet(session)?.accountId !== result.accountId || wallet?.accountId !== result.accountId || linkedWallet(session).publicKey !== result.publicKey || wallet.publicKey !== result.publicKey || session.id !== (await sha256('NOPE:wallet-session:v1:testnet:'+session.role+':'+result.accountId)).slice(0,32)) fail(msg('Cüzdan bağlaması doğrulanamadı. Hesap işlemleri kapalı.'));
    state.session = session; state.vault = vaultFactory(session.id); state.proofVerifications.clear(); await clearWalletResume(); chrome();
  }
  async function connectWallet(accountId) {
    try {
      const wallet = await client(), account = await wallet.connect(accountId ? {accountId} : {});
      if (account?.network !== 'testnet' || !testnetAccount(account.accountId)) fail(msg('Yalnızca bağlı testnet cüzdanı kullanılabilir.'));
      if (linkedWallet(state.session) && linkedWallet(state.session).accountId !== account.accountId) fail(msg('Farklı cüzdan için önce açıkça yeni oturum başlat. Mevcut yerel kasa silinmedi.'));
      const {challenge} = await api('/wallet/challenge','POST',{accountId:account.accountId});
      await saveWalletResume({kind:'challenge', accountId:account.accountId, challengeId:challenge?.challengeId});
      message(msg('Cüzdanında hesap bağlama mesajını incele ve imzala. Bu imza para göndermez.'));
      const result = await wallet.signChallenge(challenge);
      if (result?.redirected === true) return;
      await verifyWalletResult(result); await render(); message(msg('Testnet cüzdanı imzayla doğrulandı.'));
    } catch (error) { if (error?.code === 'WALLET_REJECTED') await clearWalletResume(); await render(); fail(error instanceof FriendlyError ? errorText(error) : walletError(error)); }
  }
  function walletPanel(target = root) {
    const panel = card(msg('Bağlı testnet cüzdanı'), target), wallet = linkedWallet(state.session);
    paragraph(msg('Her iki rol de hesap kontrolünü cüzdan imzasıyla doğrular. Özel cüzdan anahtarını NOPE’a verme. Testnet tutarı ve işlem ücretini kendi cüzdanında onaylarsın.'), panel);
    paragraph(wallet ? msg`Doğrulanmış hesap: ${wallet.accountId} · testnet` : msg('Henüz imzayla doğrulanmış cüzdan yok.'), panel, wallet ? 'badge' : 'muted');
    if (!walletConfigured()) { paragraph(msg('Testnet cüzdan emaneti kullanılamıyor. Yeni iş veya eski ödeme akışına geçiş yapılmadı.'), panel, 'danger'); return; }
    if (state.walletPending?.kind === 'transaction') {
      paragraph(msg('Önceki cüzdan işlemi bekliyor. Yeni işlem imzalamadan mevcut kaydı doğrula.'), panel, 'notice');
      if (state.walletPending.transactionHash) button(msg('Mevcut işlem kaydını doğrula'), async () => { await confirmWalletTransaction(state.walletPending); await render(); }, panel, 'btn secondary');
      else button(msg('Cüzdan dönüşünü kontrol et'),async () => { await completeWalletReturn(); await render(); },panel,'btn secondary');
      return;
    }
    const account = field(panel,msg('Bağlamak istediğin testnet hesabı (çoklu hesap için)'),{required:false,name:'walletAccount',value:wallet?.accountId || '',maxLength:64,placeholder:msg('ornek.testnet')});
    button(wallet ? msg('Cüzdan hesabını yeniden doğrula') : msg('Cüzdanı bağla ve imzayla doğrula'), () => connectWallet(account.value.trim()), panel, 'btn secondary');
  }
  function el(tag, text, cls) {
    const node = doc.createElement(tag);
    if (text !== undefined && text !== null) bindText(node, text);
    if (cls) node.className = cls;
    return node;
  }
  function message(text = '', error = false) {
    const node = $('workspace-message');
    if (!node) return;
    bindText(node, text); node.hidden = !String(text); node.dataset.error = String(error);
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
    if (maxLength) input.maxLength = maxLength; if (placeholder) bindAttribute(input, 'placeholder', placeholder);
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
    state.busy = true; controlsBusy(true); message(msg('İşlem sürüyor…'));
    try { await fn(); }
    catch (err) { message(err instanceof FriendlyError ? errorText(err) : msg('İşlem tamamlanamadı. Bağlantıyı ve bu cihazdaki yerel kasayı kontrol edip durumu yenileyin.'), true); }
    finally { state.busy = false; controlsBusy(false); if (state.pendingNavigation) { state.pendingNavigation = false; await render(); } }
  }
  async function api(path, method = 'GET', body) {
    let response;
    try { response = await fetcher(workspaceApiUrl(path), { method, credentials: 'same-origin', cache: 'no-store', headers: { ...(state.token ? { Authorization: 'Bearer ' + state.token } : {}), ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}) }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) }); }
    catch { fail(msg('Sunucuya ulaşılamadı. İşlemin durumunu yenileyerek kontrol edin.')); }
    if (!response.ok) {
      if (response.status === 401) { state.proofAbort?.abort(); state.proofVerifications.clear(); state.proofCapability = null; state.walletCapability = null; state.token = null; state.session = null; state.vault = null; storage.removeItem(TOKEN_KEY); chrome(); }
      let walletText;
      if (path === '/wallet' || path === '/wallet/challenge' || path === '/wallet/verify') {
        try { const data = await response.json(); walletText = typeof data?.code === 'string' && data.code.length <= 80 ? walletApiError(data.code) : null; } catch { /* Raw server text and signature diagnostics never enter the UI. */ }
      }
      const text = walletText || (response.status === 401 ? msg('Oturum geçersiz veya süresi dolmuş. Yerel kasa silinmedi.') : response.status === 403 ? msg('Bu oturumun bu işleme yetkisi yok.') : response.status === 404 ? msg('İş bulunamadı veya bu oturum için erişilebilir değil.') : response.status === 409 ? msg('İşin durumu değişmiş olabilir. Yenileyip son durumu kontrol edin.') : response.status === 429 ? msg('Çok fazla istek gönderildi. Biraz sonra tekrar deneyin.') : msg('Sunucu işlemi tamamlayamadı. Güncel durumu kontrol edin.'));
      const error = new FriendlyError(text); error.status = response.status; throw error;
    }
    try { return await response.json(); } catch { fail(msg('Sunucu yanıtı okunamadı. Yenileyerek işlem durumunu kontrol edin.')); }
  }
  function chrome() {
    const session = state.session, nav = $('workspace-nav'); nav?.replaceChildren();
    if ($('workspace-identity')) bindText($('workspace-identity'), session ? msg`${session.displayName} · ${session.role === 'buyer' ? msg('Müşteri') : msg('Sağlayıcı')}` : msg('Misafir'));
    if ($('workspace-logout')) $('workspace-logout').hidden = !session;
    const items = !session ? [[msg('Başlangıç'), '/workspace']] : session.role === 'buyer' ? [[msg('Genel bakış'), '/customer'], [msg('Yeni iş'), '/jobs/new'], [msg('İşlerim'), '/jobs'], [msg('Hareketler'), '/activity'], [msg('Kimlik ve kasa'), '/settings']] : [[msg('Genel bakış'), '/provider'], [msg('Açık işler'), '/jobs'], [msg('Hareketler'), '/activity'], [msg('Kimlik ve kasa'), '/settings']];
    for (const [text, href] of items) {
      const a = link(text, href, nav, ''); if (win.location.pathname === href) a.setAttribute('aria-current', 'page');
    }
  }
  const documentTitleBinding = { set textContent(value) { doc.title = String(value) + ' — NOPE'; } };
  function title(text, subtitle) {
    const role = state.session ? (state.session.role === 'buyer' ? msg('Müşteri') : msg('Sağlayıcı')) : null;
    bindText(documentTitleBinding, role ? msg`${text} · ${role}` : text);
    if ($('workspace-heading')) bindText($('workspace-heading'), text);
    if ($('workspace-subtitle')) bindText($('workspace-subtitle'), subtitle || '');
  }
  function jobLink(path, id) { return `${path}?id=${encodeURIComponent(id)}`; }
  function isBuyer(job) { return state.session?.role === 'buyer' && (walletJob(job) ? job.buyerWallet?.network === 'testnet' && linkedWallet(state.session)?.accountId === job.buyerWallet.accountId && Boolean(linkedWallet(state.session)) : job.buyerId === state.session.id); }
  function isSelected(job) { return state.session?.role === 'provider' && (walletJob(job) ? job.selectedOffer?.wallet?.network === 'testnet' && Boolean(linkedWallet(state.session)) && linkedWallet(state.session).accountId === job.selectedOffer.wallet.accountId && linkedWallet(state.session).accountId === job.selectedOffer.paymentAccount : job.selectedOffer?.providerId === state.session.id); }
  const localVaultFor = job => walletJob(job) && isBuyer(job) && job.buyerId !== state.session.id ? vaultFactory(job.buyerId) : state.vault;
  function requireRole(role) { if (state.session?.role !== role) fail(msg('Bu sayfa mevcut oturum rolünüze açık değil. Rol değiştirmek için ayarlardan açıkça yeni oturum başlatın.')); }
  async function navigate(href, replace = false) {
    const route = routeOf(href, win.location.origin); if (!route || state.busy) return;
    win.history[replace ? 'replaceState' : 'pushState']({}, '', href); await render();
  }
  function renderJobs(jobs, target = root) {
    if (!jobs.length) { paragraph(msg('Henüz burada görüntülenecek iş yok.'), target, 'empty'); return; }
    const list = el('div', null, 'list'); target.append(list);
    for (const job of jobs) {
      const row = el('section', null, 'card job-row'); list.append(row);
      const info = el('div', null, 'job-row-main'); row.append(info); info.append(el('h2', job.title));
      const badge = paragraph(statusText[job.status] || job.status, info, 'badge job-status'); badge.dataset.status = job.status;
      paragraph(msg`${job.rowCount} satır · Şifreli CSV görevi`, info);
      if (job.recipe) paragraph(recipeText(job.recipe), info);
      if (job.publicTask) paragraph(msg`Herkese açık ajan hedefi: ${job.publicTask.goal}`, info);
      if (job.deadlineISO) paragraph(msg`Teklif sonu: ${displayDate(job.deadlineISO)}`, info);
      link(msg('İşi aç'), jobLink('/job', job.id), row);
    }
  }
  async function jobsList(target = root) {
    const epoch = state.epoch;
    const { jobs, nextCursor } = await api('/jobs'); if (epoch !== state.epoch) return []; renderJobs(jobs || [], target);
    let cursor = nextCursor;
    if (cursor) { const more = button(msg('Daha fazla iş'), async () => {
      const result = await api('/jobs?cursor=' + encodeURIComponent(cursor)); if (epoch !== state.epoch) return; renderJobs(result.jobs || [], target);
      cursor = result.nextCursor; more.hidden = !cursor;
    }, target, 'btn secondary'); }
    return jobs || [];
  }
  function onboarding() {
    title(msg('İşi ver. Ya da işe başla.'), msg('Müşteri olarak gizli teklif al; sağlayıcı olarak şifreli görevleri yürüt.'));
    if (state.session) { paragraph(msg('Geçerli oturumunuz korunuyor.')); link(msg('Çalışma alanına devam et'), state.session.role === 'buyer' ? '/customer' : '/provider'); link(msg('Rol ve yerel kasa'), '/settings'); return; }
    const layout = el('div', null, 'onboarding-grid'); root.append(layout);
    const intro = card(msg('Aynı iş. Ayrı görünürlük.'), layout);
    paragraph(msg('[ NOPE / PRIVATE WORK ]'), intro, 'role-kicker');
    const buyerRole = el('div', null, 'role-card'); intro.append(buyerRole);
    buyerRole.append(el('h3', msg('01 / Müşteri')));
    paragraph(msg('CSV’yi kendi cihazında şifrele, teklifleri karşılaştır ve teslimi uygulamanın içinde kontrol et.'), buyerRole);
    const providerRole = el('div', null, 'role-card'); intro.append(providerRole);
    providerRole.append(el('h3', msg('02 / Sağlayıcı')));
    paragraph(msg('Açık iş tanımlarını gör, müşteriye şifreli teklif ver ve seçildiğinde şifreli hesabı yürüt.'), providerRole);
    paragraph(msg('Hesap kontrolü cüzdan imzasıyla doğrulanır. Müşteri emanet tutarını kendi testnet cüzdanından yatırır.'), intro, 'muted');
    const panel = card(msg('Çalışma alanına katıl'), layout);
    const { node, submit } = form(panel, msg('Test oturumu başlat'), async () => {
      const selected = role.value;
      const { token, session, proof, wallet } = await api('/session', 'POST', { role: selected, displayName: name.value.trim() });
      if (!token || !session || session.role !== selected) fail(msg('Oturum doğrulanamadı.'));
      state.proofCapability = proofCapability(proof); state.walletCapability = wallet ?? null; storage.setItem(TOKEN_KEY, token); state.token = token; state.session = session; state.vault = vaultFactory(session.id); state.draft = null; chrome();
      win.history.pushState({}, '', '/settings'); await render(); message(linkedWallet(state.session) ? msg('Testnet cüzdanı imzayla doğrulandı.') : msg('Test oturumu açıldı. Devam etmek için testnet cüzdanını imzayla bağla.'));
    });
    const name = field(node, msg('Görünen ad (kişisel veri kullanmayın)'), { value: '', maxLength: 60, name: 'displayName' });
    const roleWrap = el('label', null, 'field'); roleWrap.append(el('span', msg('Rol'))); const role = el('select'); role.name = 'role';
    for (const [value, text] of [['buyer', msg('Müşteri — iş yayımla')], ['provider', msg('Sağlayıcı — teklif ver')]]) { const o = el('option', text); o.value = value; role.append(o); }
    roleWrap.append(role); node.append(roleWrap);
    node.append(submit); paragraph(msg('Müşteri ve sağlayıcı, testnet hesabını cüzdan imzasıyla doğrular. CSV, çözücü ve teklif şifreleme anahtarları yerel kasada kalır; cüzdan imza anahtarı NOPE’a verilmez.'), panel);
  }
  async function newJob() {
    requireRole('buyer'); title(msg('Yeni şifreli iş'), msg('1. CSV seçin → 2. Yerel önizlemeyi kontrol edin → 3. Şifreleyip yayımlayın'));
    if (!walletConfigured() || !linkedWallet(state.session) || state.proofCapability?.enabled !== true || state.proofCapability.contractId !== walletPolicy?.contractId) {
      walletPanel(); paragraph(msg('Yeni iş için doğrulanmış müşteri cüzdanı ve aynı sözleşmeye bağlı v4 sonuç kanıtı gerekir. Eski sürüme geçilmedi.')); link(msg('Kimlik ve kasa'), '/settings'); return;
    }
    const panel = card(msg('CSV hazırlığı'));
    const proofEnabled = true;
    paragraph(msg('Yeni işler bağımsız sonuç kanıtı ve müşterinin kendi cüzdanından emanet yatırmasını gerektirir. Hazırlık veya cüzdan kullanılamıyorsa eski sürüme geçilmez.'), panel);
    button(msg('Çok alanlı şifreli kuralları dene'), () => { mode.value = 'record'; updateMode(); }, panel, 'btn secondary');
    const recipeIntro = paragraph(msg('Seçilen sütuna uygulanacak tarifi belirleyin. Sayı: 1–32 satır, boş veya 0–254 tam sayı (255 boş hücre için ayrılmıştır). Metin: en fazla 8 satır ve hücre başına 16 bayt yazdırılabilir ASCII. Tarif herkese açıktır; CSV başlıkları, dosya adı ve değerler bu cihazda kalır.'), panel);
    const { node, submit } = form(panel, msg('Şifrele ve işi yayımla'), async () => {
      if (!walletConfigured() || !linkedWallet(state.session) || !['agent','record'].includes(mode.value)) fail(msg('Yeni iş için doğrulanmış müşteri cüzdanı ve aynı sözleşmeye bağlı v4 sonuç kanıtı gerekir. Eski sürüme geçilmedi.'));
      if ((await unresolvedJobIds()).length && !state.newDraftAllowed) fail(msg('Önce belirsiz yayımlamayı kontrol edin veya uyarıyı onaylayarak ayrı bir yeni taslak başlatın.'));
      if (!dataset) fail(msg('Önce geçerli bir CSV seçin.'));
      const agentMode = mode.value === 'agent', recordMode = mode.value === 'record', revision = draftRevision, pageEpoch = state.epoch, source = dataset, approvedPlan = recordMode ? recordApproval : agentApproval;
      const jobId = randomSalt().slice(0, 32);
      let recipe, values, gcjob;
      try {
        if (recordMode) {
          const proofOptions = { jobId, buyerCommitment: await sha256('NOPE:buyer:' + state.session.id), contractId: state.proofCapability.contractId };
          gcjob = await prepareApprovedRecordJob(source, currentRecordTask(), recordApproval, { approved: recordApprove.checked, epoch: draftRevision, garblePlan: garbleProofPlan, proofOptions });
          values = gcjob.values;
        } else if (agentMode) {
          const proofOptions = proofEnabled ? { jobId, buyerCommitment: await sha256('NOPE:buyer:' + state.session.id), contractId: state.proofCapability.contractId } : undefined;
          gcjob = await prepareApprovedAgentJob(source, currentTask(), agentApproval, { approved: approve.checked, garblePlan: proofEnabled ? garbleProofPlan : garblePlan, proofOptions });
          values = gcjob.values;
        } else { recipe = selectedRecipe(); values = parseRecipeColumn(source, Number(column.value), recipe); estimateRecipe(recipe, values.length); }
      }
      catch (error) { fail(errorText(error)); }
      const deadline = new Date(deadlineInput.value);
      if (!Number.isFinite(deadline.getTime()) || deadline.getTime() <= Date.now()) fail(msg('Teklif sonu gelecekte olmalı.'));
      if (budget.value) { try { parseNearAmount(budget.value); } catch { fail(msg('Gizli bütçe için geçerli bir testNEAR tutarı girin.')); } }
      message(msg('Yerel şifreleme ve güvenli kasa kaydı hazırlanıyor…'));
      gcjob ??= await garble(values, recipe);
      const buyerPublicKey = await state.vault.buyerPublicKey();
      const payload = createPayload({ jobId, title: titleInput.value.trim(), description: description.value.trim(), deadlineISO: deadline.toISOString(), task: gcjob.request, buyerPublicKey, ...(agentMode || recordMode ? { publicTask: gcjob.approval.task } : {}) });
      const local = { dataset: source, values, ...(recordMode ? { recordApproval: gcjob.approval } : agentMode ? { agentApproval: gcjob.approval } : { column: Number(column.value), recipe }), ...(proofTask(gcjob.request) ? { proofDecoder: gcjob.decoder, proofWitness: gcjob.witness } : {}), hiddenBudget: budget.value || null, payload, pending: true };
      // Store and read back *both* local records before any network publication.
      await state.vault.saveJob(jobId, local); if (!proofTask(gcjob.request)) await state.vault.saveDecoder(jobId, gcjob);
      const saved = await state.vault.loadJob(jobId);
      if (!saved || proofTask(gcjob.request) && (JSON.stringify(saved.proofDecoder) !== JSON.stringify(gcjob.decoder) || JSON.stringify(saved.proofWitness) !== JSON.stringify(gcjob.witness))) fail(msg('Yerel kasa kaydı doğrulanamadı; iş yayımlanmadı.'));
      if (agentMode && (revision !== draftRevision || mode.value !== 'agent' || !approve.checked || agentApproval !== approvedPlan || await publicTaskHash(currentTask()) !== approvedPlan.taskHash)) fail(msg('Taslak değişti. Planı yeniden üretip onaylayın; iş yayımlanmadı.'));
      const recordDraftCurrent = () => !recordMode || revision === draftRevision && pageEpoch === state.epoch && dataset === source && mode.value === 'record' && recordApprove.checked && recordApproval === approvedPlan;
      if (recordMode) {
        const taskHash = await publicRecordTaskHash(currentRecordTask()), fingerprint = await datasetHash(dataset);
        if (!recordDraftCurrent() || taskHash !== approvedPlan.taskHash || fingerprint !== approvedPlan.datasetSha256) fail(msg('Taslak değişti. Planı yeniden üretip onaylayın; iş yayımlanmadı.'));
      }
      await updateUnresolved(jobId, true);
      if (!recordDraftCurrent()) fail(msg('Taslak değişti. Planı yeniden üretip onaylayın; iş yayımlanmadı.'));
      state.draft = { jobId, payload }; state.uncertain = true; state.newDraftAllowed = false;
      let job;
      try { ({ job } = await api('/jobs', 'POST', payload)); }
      catch (err) {
        if ([400, 413, 415, 422, 429].includes(err.status)) {
          await updateUnresolved(jobId, false); state.draft = null; state.newDraftAllowed = state.uncertain;
          fail(msg('Yayımlama sunucu tarafından reddedildi. Yerel CSV ve çözücü korundu. Son zamanı ve alanları kontrol edip tekrar deneyin.'));
        }
        await renderRecovery(panel); fail(msg('Yayımlama sonucu kesin değil. CSV ve çözücü yerel kasada saklandı. Aynı iş kimliğini kontrol edin. Ayrı bir yeni iş için önce belirsizlik uyarısını onaylayın.')); }
      await finishPublish(job, local, jobId);
    });
    const titleInput = field(node, msg('Herkese açık iş başlığı — kişisel veri eklemeyin'), { maxLength: 100, name: 'title' });
    const description = field(node, msg('Herkese açık açıklama — CSV veya kişisel veri eklemeyin'), { type: 'textarea', maxLength: 1000, name: 'description' });
    const budget = field(node, msg('Gizli bütçe (isteğe bağlı testNEAR; yalnızca yerel kasa)'), { required: false, name: 'hiddenBudget' });
    const deadlineInput = field(node, msg('Teklif son zamanı'), { type: 'datetime-local', value: localDate(new Date(Date.now() + 3600000)), name: 'deadlineISO' });
    const file = field(node, msg('CSV dosyası — bu cihazda okunur'), { type: 'file', required: false, name: 'csv' }); file.accept = '.csv,text/csv';
    function select(label, name, options, parent = node) {
      const wrap = el('label', null, 'field'); wrap.append(el('span', label)); const input = el('select'); input.name = name;
      for (const [value, text] of options) { const option = el('option', text); option.value = value; input.append(option); }
      wrap.append(input); parent.append(wrap); return input;
    }
    const mode = select(msg('Hazırlama modu'), 'planningMode', [['agent', msg('Yerel AI ajanı · v4 bağımsız sonuç kanıtı (varsayılan)')], ['record', msg('Çok alanlı şifreli kurallar · v5 sonuç kanıtı')]]);
    mode.value = proofEnabled ? (new URL(win.location.href).searchParams.get('workload') === 'record' ? 'record' : 'agent') : 'manual';
    const recipeType = select(msg('Sütun türü'), 'recipeType', [['number', msg('Sayı')], ['text', msg('Metin (ASCII)')]]);
    const fill = field(node, msg('Boş sayıları doldur'), { type: 'checkbox', required: false, name: 'recipeFill' }); fill.checked = true;
    const fillValue = field(node, msg('Boş hücre yerine (0–254)'), { type: 'number', value: '0', name: 'recipeFillValue' }); fillValue.min = '0'; fillValue.max = '254'; fillValue.step = '1';
    const clamp = field(node, msg('Sayıları alt/üst sınıra çek'), { type: 'checkbox', required: false, name: 'recipeClamp' }); clamp.checked = true;
    const minValue = field(node, msg('Alt sınır (0–254)'), { type: 'number', value: '0', name: 'recipeMin' }); minValue.min = '0'; minValue.max = '254'; minValue.step = '1';
    const maxValue = field(node, msg('Üst sınır (0–254)'), { type: 'number', value: '100', name: 'recipeMax' }); maxValue.min = '0'; maxValue.max = '254'; maxValue.step = '1';
    const trim = field(node, msg('Metnin başındaki/sonundaki ASCII boşlukları sil'), { type: 'checkbox', required: false, name: 'recipeTrim' }); trim.checked = true;
    const letterCase = select(msg('Harf dönüşümü'), 'recipeCase', [['lowercase', msg('Küçük harf')], ['uppercase', msg('Büyük harf')], ['none', msg('Değiştirme')]]);
    const redact = field(node, msg('ASCII rakamları * ile değiştir'), { type: 'checkbox', required: false, name: 'recipeRedactDigits' }); redact.checked = false;
    const column = select(msg('İşlenecek sütun'), 'column', []);
    const preview = el('div', null, 'stack'); node.append(preview); let dataset = null;
    let draftRevision = 0, agentApproval = null, recordApproval = null, planningController = null;
    const recordPanel = el('div', null, 'stack'); node.append(recordPanel); recordPanel.hidden = true;
    paragraph(msg('İncelenmiş kural şablonu: model çıkarımı yapılmaz. Birden fazla gizli alan birlikte hesaplanır; yalnızca takma adlar ve kurallar açıktır. Gerçek başlıklar, hücreler ve yerel sonuçlar bu cihazda kalır.'), recordPanel);
    paragraph(msg('Para tutarlarını kuruş gibi en küçük birimde, 0–4294967295 tam sayı girin. Fatura miktarı ve birim fiyat 0–65535 olmalıdır. En fazla 16 satır, toplam 10000 kapı ve ayrılmış zarf alanıyla 3 MiB istek sınırı uygulanır. Plan daha düşük satır sınırı gerektirebilir; veri kesilmez.'), recordPanel);
    paragraph(msg('Bu şablonlarda fatura en fazla 5, nakit akışı en fazla 11 satır destekler. Önizlemede dosyanızın gerçek kapı ve bayt hesabı gösterilir.'), recordPanel);
    const templateKind = select(msg('İncelenmiş kural şablonu'), 'recordTemplate', [['invoice', msg('Fatura denetimi · 4 gizli alan')], ['cashflow', msg('Nakit akışı ve ödeme uygunluğu · 6 gizli alan')]], recordPanel);
    const recordMapping = el('div', null, 'stack'); recordPanel.append(recordMapping); const recordInputs = [];
    const recordView = el('div', null, 'stack');
    const recordGenerate = button(msg('Kuralları ve yerel sonuçları önizle'), async () => {
      if (!dataset || mode.value !== 'record') fail(msg('Önce CSV seçip çok alanlı kural modunu açın.'));
      invalidateAgent(); const revision = draftRevision, pageEpoch = state.epoch, source = dataset, kind = templateKind.value;
      try {
        const task = currentRecordTask(), aliases = recordInputs.map(input => input.value);
        const proposal = await recordTemplate(task, kind, aliases);
        let values, estimate;
        try { values = privateRecordInputs(source, proposal.plan); estimate = estimateRecordPlan(proposal.plan, values.length); }
        catch { throw productError(msg('Alan eşlemelerini ve sınırları kontrol edin: değerler işaretsiz 32 bit tam sayı, fatura çarpanları en fazla 65535 olmalıdır. Satır, kapı veya istek boyutu sınırı aşıldıysa daha küçük bir dosya seçin; veri kesilmedi ve gönderilmedi.')); }
        const expected = values.map(row => referenceRecord(row, proposal.plan).slice(0, proposal.plan.outputs.length)), fingerprint = await datasetHash(source);
        if (revision !== draftRevision || pageEpoch !== state.epoch || source !== dataset || mode.value !== 'record') fail(msg('Taslak değişti. Planı yeniden üretip onaylayın; iş yayımlanmadı.'));
        recordApproval = freezePlanData({ ...proposal, datasetSha256: fingerprint, epoch: revision, templateKind: kind });
        paragraph(msg('İncelenmiş şablon · yapay zekâ üretimi değildir'), recordView);
        recordRuleSummary(kind).forEach(text => paragraph(text, recordView));
        recordInputs.forEach((input, i) => paragraph(msg`${recordRoles(kind)[i]} ↔ ${source.headers[Number(input.value.slice(1)) - 1]} (yalnızca bu cihazda)`, recordView));
        table([msg('Satır'), ...source.headers, ...recordOutputLabels(kind)], source.rows.map((row, i) => [i + 1, ...row, ...expected[i]]), recordView);
        recordTechnicalPlan(proposal.plan, proposal.planSha256, recordView, estimate);
        enabled(recordApprove, true); message(msg('Kuralları, özel alan eşlemelerini ve dört türetilmiş sonucu inceleyip onaylayın. Henüz veri gönderilmedi.'));
      } catch (error) { invalidateAgent(); fail(errorText(error)); }
    }, recordPanel);
    recordPanel.append(recordView);
    const recordApprove = field(recordPanel, msg('Alan eşlemelerini, kuralları ve tüm yerel sonuçları inceledim; bu dosya için şifreli yürütmeyi onaylıyorum.'), { type: 'checkbox', required: false, name: 'recordApprove' }); recordApprove.checked = false; recordApprove.disabled = true;
    function currentRecordTask() {
      const aliases = recordInputs.map(input => input.value);
      if (!dataset || aliases.length !== recordRoles(templateKind.value).length || aliases.some(id => !/^C(?:[1-9]|1[0-6])$/.test(id)) || new Set(aliases).size !== aliases.length) fail(msg('Her rol için farklı bir özel CSV sütunu seçin.'));
      return publicRecordTask({ version: 2, goal: String(templateKind.value === 'invoice' ? msg('Fatura denetimi: beklenen tutar, fazla faturalama, bütçe ve eşleşme.') : msg('Nakit akışı: net tutar, borç sonrası bakiye, kredi limiti ve ödeme uygunluğu.')), columns: aliases.map(id => ({ id, type: 'uint32' })) });
    }
    function rebuildRecordMapping() {
      recordMapping.replaceChildren(); recordInputs.length = 0;
      for (const [i, role] of recordRoles(templateKind.value).entries()) {
        const input = select(role, `recordRole${i}`, [['', msg('Özel sütunu seçin')], ...(dataset?.headers || []).map((header, j) => [`C${j + 1}`, msg`C${j + 1} ↔ ${header} (eşleme yalnızca bu cihazda)`])], recordMapping);
        recordInputs.push(input); input.addEventListener('change', invalidateAgent);
      }
    }
    templateKind.addEventListener('change', () => { invalidateAgent(); rebuildRecordMapping(); });
    recordApprove.addEventListener('change', () => enabled(submit, !!recordApproval && recordApprove.checked && mode.value === 'record'));
    rebuildRecordMapping();
    const agentPanel = el('div', null, 'stack'); node.append(agentPanel); agentPanel.hidden = true;
    if (proofEnabled) paragraph(msg`En fazla ${PROOF_PLAN_LIMITS.maxRowProofs} işlenen hücre: planda işlenen sütun sayısı × veri satırı sayısı. Sayı verisinde 32 satır sınırı korunur; metin sütunları en fazla 8 satır ve hücre başına 16 bayt yazdırılabilir ASCII destekler. Veri kesilmez.`, agentPanel);
    paragraph(msg('Yerel model yalnızca herkese açık hedefi, C1…C16 takma adlarını ve seçtiğiniz türleri görür (en fazla 4 seçili sütun). Dosya adı, gerçek başlıklar ve hücreler modele verilmez. İlk kullanımda yaklaşık 412,5 MB model ağırlığı indirilip tarayıcıda önbelleğe alınır. Çıkarım bu tarayıcıda çalışır; çıkarım API’sine veri gönderilmez.'), agentPanel);
    const goal = field(agentPanel, msg('Herkese açık ajan hedefi — yalnızca C1, C2 gibi takma adları kullanın; gizli veri yazmayın'), { type: 'textarea', required: false, maxLength: 1800, name: 'agentGoal' });
    const schemaPanel = el('div', null, 'stack'); agentPanel.append(schemaPanel);
    const schemaInputs = [];
    const planView = el('div', null, 'stack');
    const generate = button(msg('Yerel ajanla plan üret'), async () => {
      if (!dataset || mode.value !== 'agent') fail(msg('Önce CSV seçip ajan modunu açın.'));
      invalidateAgent(); const revision = draftRevision, source = dataset;
      const controller = new AbortController(); planningController = controller;
      cancelPlanning.hidden = false; cancelPlanning.disabled = false;
      paragraph(msg('Model hazırlanıyor…'), planView);
      try {
        const task = currentTask();
        const proposal = await generateAgentPlan(task, { workerFactory: agentWorkerFactory, signal: controller.signal, onProgress: value => {
          if (revision === draftRevision) {
            const count = Number.isFinite(value.loaded) && Number.isFinite(value.total) && value.total > 0 ? msg` · ${Math.round(value.loaded / value.total * 100)}% (${displayNumber(value.loaded / 1e6, 1)} / ${displayNumber(value.total / 1e6, 1)} MB)` : '';
            bindText(planView, msg`${modelProgress(value)}${count}`);
          }
        } });
        if (controller.signal.aborted) fail(msg('Yerel planlama iptal edildi; plan onaylanmadı.'));
        if (revision !== draftRevision || source !== dataset || mode.value !== 'agent') fail(msg('Taslak değişti; eski model planı kullanılmadı.'));
        const proofCells = proposal.plan.steps.length * source.rows.length;
        if (proofEnabled && proofCells > PROOF_PLAN_LIMITS.maxRowProofs) throw productError(msg`v4 kanıtı en fazla ${PROOF_PLAN_LIMITS.maxRowProofs} işlenen hücre destekler; bu plan ${proposal.plan.steps.length} sütun × ${source.rows.length} satır = ${proofCells} hücre içeriyor. Daha az satır veya sütun seçin; veri kesilmedi.`);
        const values = privatePlanInputs(source, proposal.plan);
        estimatePlan(proposal.plan, source.rows.length);
        const fingerprint = await datasetHash(source);
        if (controller.signal.aborted) fail(msg('Yerel planlama iptal edildi; plan onaylanmadı.'));
        if (revision !== draftRevision || source !== dataset || mode.value !== 'agent') fail(msg('Taslak değişti; eski model planı kullanılmadı.'));
        agentApproval = freezePlanData({ ...proposal, datasetSha256: fingerprint });
        planView.replaceChildren();
        paragraph(msg`Onaylanacak herkese açık hedef: ${proposal.task.goal}`, planView);
        paragraph(msg`Model: ${proposal.model.id} · revizyon ${proposal.model.revision}`, planView);
        paragraph(msg`İş SHA-256: ${proposal.taskHash}`, planView);
        paragraph(msg`Plan SHA-256: ${proposal.planSha256}`, planView);
        if (proofEnabled) paragraph(msg`${proposal.plan.steps.length} sütun × ${source.rows.length} satır = ${proofCells}/${PROOF_PLAN_LIMITS.maxRowProofs} işlenen hücre`, planView);
        for (const step of proposal.plan.steps) {
          paragraph(msg`${step.column}: ${recipeText(step.recipe)}`, planView);
          const input = values[step.column], expected = referenceApply(input, step.recipe);
          table([msg('Satır'), msg`${step.column} · ÖNCE (yerel)`, msg('Beklenen SONRA (yerel)')], input.map((v, i) => [i + 1, displayCell(v, step.recipe), displayCell(expected[i], step.recipe)]), planView);
        }
        enabled(approve, true); message(msg('Plan biçimi ve desteklenen işlemler kontrol edildi. Hedefe uygunluğunu, adımları ve yerel önizlemeyi inceleyip onaylayın.'));
      } catch (error) { invalidateAgent(); fail(errorText(error)); }
      finally { if (planningController === controller) planningController = null; cancelPlanning.hidden = true; cancelPlanning.disabled = true; }
    }, agentPanel);
    const cancelPlanning = el('button', msg('Yerel planlamayı iptal et'), 'btn secondary'); cancelPlanning.type = 'button'; cancelPlanning.hidden = true; cancelPlanning.disabled = true;
    cancelPlanning.dataset.allowBusy = 'true'; cancelPlanning.addEventListener('click', () => planningController?.abort()); agentPanel.append(cancelPlanning);
    agentPanel.append(planView);
    const approve = field(agentPanel, msg('Bu hedefe ait yukarıdaki planı ve tüm yerel önce/sonra sonuçlarını inceledim; şifreli yürütme için onaylıyorum.'), { type: 'checkbox', required: false, name: 'agentApprove' }); approve.checked = false; approve.disabled = true;
    function displayCell(value, recipe) { return value === '' || recipe.type === 'number' && value === 255 ? msg('(boş)') : value; }
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
      recordApproval = null; recordApprove.checked = false; enabled(recordApprove, false); recordView.replaceChildren();
      planView.replaceChildren(); if (['agent','record'].includes(mode.value)) enabled(submit, false);
    }
    function rebuildSchema() {
      schemaPanel.replaceChildren(); schemaInputs.length = 0;
      dataset?.headers.forEach((header, i) => {
        const input = select(msg`C${i + 1} ↔ ${header} (eşleme yalnızca bu cihazda)`, `agentColumn${i + 1}`, [['ignore', msg('Yoksay')], ['number', msg('Sayı')], ['text', msg('Metin (ASCII)')]], schemaPanel);
        input.dataset.alias = `C${i + 1}`; schemaInputs.push(input);
        input.addEventListener('change', () => { invalidateAgent();
          if (schemaInputs.filter(s => s.value !== 'ignore').length > 4) { input.value = 'ignore'; message(msg('En fazla dört sütun seçebilirsiniz.'), true); }
        });
      });
    }
    function updateMode() {
      invalidateAgent(); const agent = mode.value === 'agent', record = mode.value === 'record'; agentPanel.hidden = !agent; recordPanel.hidden = !record; preview.hidden = agent || record;
      recipeIntro.hidden = record;
      updateRecipeFields();
      for (const input of [recipeType,fill,fillValue,clamp,minValue,maxValue,trim,letterCase,redact,column]) {
        if (agent || record) { input.parentElement.hidden = true; input.required = false; enabled(input, false); }
      }
      if (!agent && !record) { recipeType.parentElement.hidden = false; column.parentElement.hidden = false; enabled(recipeType, true); enabled(column, true); showPreview(); }
      enabled(goal, agent); goal.required = agent; enabled(generate, agent);
      schemaInputs.forEach(input => enabled(input, agent));
      enabled(templateKind, record); enabled(recordGenerate, record); recordInputs.forEach(input => enabled(input, record));
    }
    mode.addEventListener('change', updateMode);
    goal.addEventListener('input', invalidateAgent); goal.addEventListener('change', invalidateAgent);
    approve.addEventListener('change', () => enabled(submit, !!agentApproval && approve.checked && mode.value === 'agent'));
    function selectedRecipe() {
      const integer = input => { if (!/^(0|[1-9]\d{0,2})$/.test(input.value) || Number(input.value) > 254) throw productError(msg('Tarif sayıları 0–254 tam sayı olmalı.')); return Number(input.value); };
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
        catch { option.disabled = true; bindText(option, msg`${header} — desteklenmeyen sütun / tarif`); }
        column.append(option);
      });
      column.value = valid.has(previous) ? previous : String(first < 0 ? 0 : first);
    }
    const showPreview = () => {
      if (['agent','record'].includes(mode.value)) return;
      preview.replaceChildren(); submit.disabled = true;
      if (state.busy) submit.dataset.wasDisabled = 'true';
      updateRecipeFields(); if (!dataset) return;
      try { const recipe = selectedRecipe(), values = parseRecipeColumn(dataset, Number(column.value), recipe); estimateRecipe(recipe, values.length);
        const expected = referenceApply(values, recipe);
        paragraph(msg`Herkese açık tarif: ${recipeText(recipe)}`, preview);
        paragraph(msg`${values.length} satır · yerel ÖNCE önizlemesi`, preview);
        table([msg('Satır'), msg('Önce'), msg('Beklenen sonra')], values.map((v, i) => [i + 1, v === 255 || v === '' ? msg('(boş)') : v, expected[i] === 255 || expected[i] === '' ? msg('(boş)') : expected[i]]), preview);
        submit.disabled = false; if (state.busy) submit.dataset.wasDisabled = 'false';
      } catch (error) { paragraph(error.message ? errorText(error) : msg('Sütun ve tarif sınırlarını kontrol edin.'), preview, 'danger'); }
    };
    column.addEventListener('change', showPreview);
    for (const input of [recipeType,fill,fillValue,clamp,minValue,maxValue,trim,letterCase,redact]) {
      const update = () => { refreshColumns(); showPreview(); };
      input.addEventListener('change', update); if (input.type === 'number') input.addEventListener('input', update);
    }
    file.addEventListener('change', () => { invalidateAgent(); return run(async () => {
      dataset = null; submit.disabled = true; column.replaceChildren(); preview.replaceChildren();
      rebuildSchema(); rebuildRecordMapping();
      const chosen = file.files[0]; if (!chosen) return;
      if (chosen.size > MAX_BYTES) fail(msg('Dosya en fazla 64 KiB olabilir.'));
      try { dataset = freezePlanData(parseCSV(new TextDecoder('utf-8', { fatal: true }).decode(await chosen.arrayBuffer()))); }
      catch { fail(msg('CSV okunamadı. Başlık, 1–32 satır, UTF-8 ve desteklenen hücre biçimini kontrol edin.')); }
      rebuildSchema(); rebuildRecordMapping(); refreshColumns(); showPreview(); updateMode(); message(msg('CSV yalnızca bu cihazda okundu. Önizlemeyi kontrol edin.'));
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
    if (!job?.id || job.id !== expectedId) fail(msg('Yayımlanan iş kimliği doğrulanamadı; yerel kayıt korundu.'));
    await state.vault.saveJob(job.id, { ...local, pending: false }); await updateUnresolved(job.id, false);
    state.draft = null; state.newDraftAllowed = false;
    win.history.pushState({}, '', jobLink('/job', job.id)); await render(); message(msg('İş yayımlandı. CSV ve çözücü yalnızca yerel kasada saklanıyor. Diğer belirsiz girişimler genel bakışta korunur.'));
  }
  async function renderRecovery(target) {
    const ids = await unresolvedJobIds(); state.uncertain = ids.length > 0;
    // Re-render only this recovery section; a failed attempt must not duplicate controls.
    let container = Array.from(target.children).find(node => node.dataset?.publishRecovery === 'true');
    if (!container) { container = el('div', null, 'stack'); container.dataset.publishRecovery = 'true'; target.append(container); }
    container.replaceChildren();
    if (!ids.length) return;
    const panel = card(msg('Doğrulanmamış yayımlamalar'), container);
    paragraph(msg('Bu girişimler iptal edilmiş veya başarısız sayılmaz. Yerel CSV, çözücü ve aynı iş kimliği korunur. Yeni bir taslak eski girişimi yeniden göndermez veya silmez.'), panel, 'danger');
    for (const jobId of ids) {
      const local = await state.vault.loadJob(jobId);
      const row = card(msg('Yayımlama hâlâ doğrulanmadı'), panel);
      paragraph(msg`Yerel iş kimliği: ${jobId}`, row);
      if (local?.payload?.title) paragraph(local.payload.title, row);
      if (local?.payload?.deadlineISO && Date.parse(local.payload.deadlineISO) <= Date.now()) paragraph(msg('Eski teklif son zamanı geçti. Yeni teklifler alınamaz; bu durum önceki yayımlamanın sonucunu doğrulamaz.'), row);
      button(msg('Aynı işin durumunu kontrol et'), async () => {
        try { const { job } = await api('/jobs/' + encodeURIComponent(jobId)); await finishPublish(job, local, jobId); }
        catch (err) { if (err.status === 404) fail(msg('Eski iş henüz bulunamadı. Önceki girişim hâlâ doğrulanmamış olarak saklanıyor; daha sonra aynı kimliği tekrar kontrol edebilirsiniz.')); throw err; }
      }, row);
      button(msg('Aynı kimlik ve içerikle güvenli tekrar dene'), async () => {
        if (!local?.payload) fail(msg('Yerel yayımlama kaydı eksik. Aynı iş kimliği ve mevcut kasa korunuyor; durumu kontrol edin.'));
        if (!walletConfigured() || !linkedWallet(state.session) || !isProofProfile(local.payload.profile) || local.payload.task?.profile !== local.payload.profile || local.payload.task?.proofManifest?.context?.contractId !== walletPolicy.contractId || local.payload.task.proofManifest.context.buyerCommitment !== await sha256('NOPE:buyer:'+state.session.id)) fail(msg('Yeni iş için doğrulanmış müşteri cüzdanı ve aynı sözleşmeye bağlı v4 sonuç kanıtı gerekir. Eski sürüme geçilmedi.'));
        try { const { job } = await api('/jobs', 'POST', local.payload); await finishPublish(job, local, jobId); }
        catch (err) { if (err.status === 400) fail(msg('Eski girişim doğrulanamadı; son zamanı geçmiş olabilir. Eski kayıt ve çözücü korunuyor. Durumu kontrol edebilir veya uyarıyı onaylayarak ayrı bir yeni taslak açabilirsiniz.')); throw err; }
      }, row, 'btn secondary');
    }
    const consent = field(panel, msg('Eski yayımlamanın hâlâ doğrulanmadığını anlıyorum. Eski kaydı koruyarak, farklı kimlikli ayrı bir yeni iş hazırlamak istiyorum.'), { type: 'checkbox', required: false, name: 'newDraftConsent' });
    button(msg('Eski girişimi koru ve ayrı yeni taslak aç'), async () => {
      if (!consent.checked) fail(msg('Önce eski girişimin belirsiz kaldığını ve yeni taslağın ayrı bir iş olacağını onaylayın.'));
      // Consent opens an empty draft only. It neither retries nor publishes anything.
      state.newDraftAllowed = true; state.draft = null;
      win.history.pushState({}, '', '/jobs/new'); await render();
      message(msg('Ayrı yeni taslak açıldı. Eski girişimler ve çözücüleri korundu; yeni işi yayımlamak ayrıca sizin işleminizi gerektirir.'));
    }, panel, 'btn secondary');
    link(msg('İşlerimi kontrol et'), '/jobs', panel);
  }
  function table(headers, rows, target) {
    const wrap = el('div', null, 'table-wrap'), node = el('table'); const head = el('thead'), hr = el('tr');
    headers.forEach(h => { const th = el('th', h); th.scope = 'col'; hr.append(th); }); head.append(hr); node.append(head);
    const body = el('tbody'); rows.forEach(row => { const tr = el('tr'); row.forEach(cell => tr.append(el('td', cell))); body.append(tr); }); node.append(body); wrap.append(node); target.append(wrap);
  }
  function clearEscrowPoll() {
    if (state.escrowPoll !== null) { if (win.clearTimeout) win.clearTimeout(state.escrowPoll); else clearTimeout(state.escrowPoll); state.escrowPoll = null; }
  }
  function canRecordDelivery(job) {
    return escrowMetadata(job) && job.payment.verified === true && job.status === 'DELIVERED' && job.delivery &&
      job.payment.status === 'HELD' && !escrowRecordedDelivery(job) && !deadlineReached(job.payment.executionDeadlineNs);
  }
  function canRefund(job) {
    return escrowMetadata(job) && job.payment.verified === true && ['AWARDED', 'DELIVERED', 'REVISION', 'ACCEPTED'].includes(job.status) &&
      ['HELD', 'RELEASE_READY'].includes(job.payment.status) && deadlinePassed(job.payment.reviewDeadlineNs);
  }
  async function confirmWalletTransaction(pending) {
    if (!pending || pending.kind !== 'transaction' || !TX_HASH.test(pending.transactionHash) || !/^[a-f0-9]{32}$/.test(pending.jobId) || !RESUME_ACTIONS.has(pending.action) || linkedWallet(state.session)?.accountId !== pending.accountId) fail(msg('Cüzdan işlem kaydı bu oturumla eşleşmiyor. Yeni işlem gönderilmedi.'));
    const {job:updated} = await api('/jobs/' + encodeURIComponent(pending.jobId) + '/payment/confirm','POST',{action:pending.action,transactionHash:pending.transactionHash});
    if (updated?.id !== pending.jobId || !walletJob(updated) || updated.payment.contractId !== walletPolicy?.contractId || updated.payment.bindingHash !== pending.bindingHash || !Object.hasOwn(escrowStatuses,updated.payment.status)) fail(msg('Cüzdan işlem kaydı bu oturumla eşleşmiyor. Yeni işlem gönderilmedi.'));
    // Confirmation registers the exact hash for the server's read-only observer.
    // A wallet response never grants a local FINAL or PAID status.
    await clearWalletResume();
    if (['UNKNOWN','ERROR'].includes(updated.payment.status)) state.escrowUncertain.add(pending.jobId); else state.escrowUncertain.delete(pending.jobId);
    return updated;
  }
  async function escrowOperation(job, action, {allowMissingLocal = false} = {}) {
    if (!walletJob(job)) fail(msg('Bu eski sponsor işi yalnızca okunur. Yeni imza veya ödeme başlatılmaz.'));
    if (action === 'refresh') {
      const {job:updated} = await api('/jobs/' + encodeURIComponent(job.id) + '/payment/refresh','POST',{});
      if (updated?.id !== job.id || !walletJob(updated) || updated.payment.contractId !== job.payment.contractId || !Object.hasOwn(escrowStatuses,updated.payment.status)) fail(msg('Cüzdan işlem kaydı bu oturumla eşleşmiyor. Yeni işlem gönderilmedi.'));
      if (['UNKNOWN','ERROR'].includes(updated.payment.status)) state.escrowUncertain.add(job.id); else state.escrowUncertain.delete(job.id);
      return updated;
    }
    if (!walletConfigured() || job.payment.contractId !== walletPolicy.contractId || state.walletPending || state.escrowUncertain.has(job.id) || !walletActionAllowed(job,action,state.session)) fail(msg('Bu ödeme işlemi güncel iş ve teslim durumunda kullanılamaz. Önce durumu yenileyin.'));
    try {
      const local = action === 'fund' ? await localVaultFor(job).loadJob(job.id) : null;
      if (action === 'fund') await verifyFundingCommitments(job,local?.payload,{allowMissingLocal});
      const signer = await client(), accountId = linkedWallet(state.session).accountId;
      const account = await signer.currentAccount() || await signer.connect({accountId});
      if (account?.network !== 'testnet' || account.accountId !== accountId) fail(msg('Yalnızca bağlı testnet cüzdanı kullanılabilir.'));
      const {job:latest,intent} = await api('/jobs/' + encodeURIComponent(job.id) + '/payment/prepare','POST',{action});
      if (!walletActionAllowed(latest,action,state.session) || latest.id !== job.id || latest.payment.bindingHash !== job.payment.bindingHash || latest.payment.contractId !== walletPolicy.contractId || latest.selectedOffer?.paymentAccount !== job.selectedOffer?.paymentAccount || latest.selectedOffer?.amountYocto !== job.selectedOffer?.amountYocto || latest.buyerWallet?.accountId !== job.buyerWallet?.accountId || ['record','release'].includes(action) && (latest.delivery?.version !== job.delivery?.version || latest.delivery?.outputSha256 !== job.delivery?.outputSha256) || intent?.action !== action || intent.bindingHash !== latest.payment.bindingHash || typeof intent.id !== 'string' || !HASH.test(intent.id)) fail(msg('İmzalanacak işlem güncel iş, tutar veya teslimle eşleşmiyor. İmza istenmedi.'));
      if (action === 'fund') await verifyFundingCommitments(latest,local?.payload,{allowMissingLocal});
      const pending = {kind:'transaction',jobId:job.id,action,intentId:intent.id,accountId,bindingHash:latest.payment.bindingHash};
      await saveWalletResume(pending);
      state.escrowUncertain.add(job.id);
      const bounds = {action,jobId:job.id,bindingHash:latest.payment.bindingHash,accountId,contractId:walletPolicy.contractId,provider:latest.selectedOffer.paymentAccount,amountYocto:latest.selectedOffer.amountYocto,buyerAccount:latest.buyerWallet.accountId,...(action === 'fund'?{buyerCommitment:await sha256('NOPE:buyer:'+latest.buyerId),inputHash:latest.taskHash,programHash:latest.programHash,planHash:latest.planSha256 || '0'.repeat(64),executionDeadlineNs:latest.payment.executionDeadlineNs,reviewDeadlineNs:latest.payment.reviewDeadlineNs}:{}),...(['record','release'].includes(action)?{version:latest.delivery.version,outputHash:latest.delivery.outputSha256}:{})};
      message(msg('Cüzdanında sözleşmeyi, tam tutarı ve işlemi inceleyip açıkça imzala. Henüz kesinleşmedi.'));
      const result = await signer.sendTransaction(intent,bounds);
      if (result?.redirected === true) return latest;
      if (!TX_HASH.test(result?.transactionHash)) fail(msg('Cüzdan işlemi tamamlanamadı veya sonucu belirsiz. Yeni imza istemeden mevcut işlemi kontrol edin.'));
      await saveWalletResume({...pending,transactionHash:result.transactionHash});
      return await confirmWalletTransaction(state.walletPending);
    } catch (error) {
      if (['WALLET_REJECTED','WALLET_INVALID_INTENT','WALLET_ACCOUNT_REQUIRED','WALLET_ACCOUNT_CHANGED','WALLET_WRONG_NETWORK','WALLET_POLICY_DISABLED','WALLET_STORAGE_UNAVAILABLE'].includes(error?.code)) { await clearWalletResume(); state.escrowUncertain.delete(job.id); }
      await render();
      if (error instanceof FriendlyError) throw error;
      fail(walletError(error));
    }
  }
  function scheduleEscrowRefresh(job, target) {
    if (!ESCROW_PENDING.has(job.payment.status) || !win.setTimeout) return;
    const key = `${job.id}:${job.payment.status}`;
    if (state.escrowPollKey !== key) { state.escrowPollKey = key; state.escrowPollCount = 0; }
    if (state.escrowPollCount >= 12) { paragraph(msg('Otomatik kontrol durdu. Yeni gönderim yapmadan escrow durumunu elle yenileyebilirsiniz.'), target); return; }
    clearEscrowPoll(); const epoch = state.epoch;
    const poll = () => {
      state.escrowPoll = null;
      if (epoch !== state.epoch || !state.session) return;
      if (state.busy) { state.escrowPoll = win.setTimeout(poll, 2500); state.escrowPoll?.unref?.(); return; }
      state.escrowPollCount++;
      void run(async () => { await escrowOperation(job, 'refresh'); await render(); });
    };
    state.escrowPoll = win.setTimeout(poll, 2500); state.escrowPoll?.unref?.();
  }
  async function escrowPanel(job, target = root) {
    const legacy = legacyJob(job), panel = card(legacy ? msg('Eski sponsor işi · yalnızca okunur') : msg('Cüzdan destekli testnet escrow'),target), payment = job.payment;
    panel.className += ' wallet-payment';
    paragraph(legacy ? msg('Bu kayıt eski sponsor akışına aittir. Durumu ve geçmiş işlem özetleri gösterilir; yeni fonlama, yürütme, kabul veya ödeme başlatılmaz.') : msg('Bu işin tutarını müşteri kendi testnet cüzdanından yatırır. Her işin ayrı bakiye kaydı vardır; ortak müşteri havuzundan çekim yapılmaz. Özel cüzdan anahtarını NOPE almaz.'),panel);
    const trusted = escrowMetadata(job) && (!['HELD','RELEASE_READY','PAID','REFUNDED'].includes(payment.status) || payment.verified === true) && (payment.status !== 'PAID' || job.status === 'PAID') && (payment.status !== 'REFUNDED' || job.status === 'REFUNDED');
    paragraph(msg`Durum: ${legacy ? payment.status : trusted ? escrowStatuses[payment.status] : msg('Bilinmeyen veya eksik testnet ödeme bilgisi · yalnızca durum kontrolü')}`,panel,trusted && payment.status === 'PAID' ? 'badge' : 'muted');
    if (job.selectedOffer) {
      paragraph(msg`Herkese açık seçilen tutar: ${formatNearAmount(job.selectedOffer.amountYocto)} testNEAR`,panel);
      if (walletJob(job) && payment.contractId === walletPolicy?.contractId && /^[1-9][0-9]{0,24}$/.test(walletPolicy.storageDepositYocto || '')) {
        const storageCost=walletPolicy.storageDepositYocto,total=(BigInt(job.selectedOffer.amountYocto)+BigInt(storageCost)).toString();
        paragraph(msg`Kalıcı işlem kaydı depolaması: ${formatNearAmount(storageCost)} testNEAR (iade edilmez).`,panel);
        paragraph(msg`Cüzdan fonlama toplamı: ${formatNearAmount(total)} testNEAR + ağ işlem ücreti.`,panel);
        paragraph(msg('Hizmet bedeli kabul veya uygun iadeyle aktarılır. Depolama bedeli zincirdeki kayıtların saklanmasını karşılar.'),panel);
      }
      paragraph(msg`Testnet alıcısı: ${job.selectedOffer.paymentAccount}`,panel);
    }
    if (walletJob(job) && job.buyerWallet?.accountId) paragraph(msg`Müşteri cüzdanı: ${job.buyerWallet.accountId}`,panel);
    if (walletJob(job)) {
      if (HASH.test(job.taskHash)) paragraph(msg`${msg('Şifreli girdi özeti')}: ${job.taskHash}`,panel);
      if (HASH.test(job.programHash)) paragraph(msg`${msg('Program özeti')}: ${job.programHash}`,panel);
      if (HASH.test(job.planSha256)) paragraph(msg`Plan SHA-256: ${job.planSha256}`,panel);
    }
    if (trusted) {
      paragraph(msg`Testnet sözleşmesi: ${payment.contractId} · bağ SHA-256: ${payment.bindingHash}`,panel);
      if (Number.isInteger(payment.recordedVersion) && payment.recordedVersion > 0 && HASH.test(payment.recordedOutputHash)) paragraph(msg`Zincirde kesinleşmiş teslim: sürüm ${payment.recordedVersion} · şifreli çıktı SHA-256: ${payment.recordedOutputHash}`,panel);
      for (const [key,label] of [['executionDeadlineNs',msg('Yürütme sonu')],['reviewDeadlineNs',msg('İnceleme ve iade sınırı')]]) if (typeof payment[key] === 'string' && /^[1-9]\d{0,19}$/.test(payment[key])) paragraph(msg`${label}: ${displayDate(Number(BigInt(payment[key])/1_000_000n))}`,panel);
      for (const [key,label] of [['fundTransactionHash',msg('Yatırma')],['recordTransactionHash',msg('Teslim kaydı')],['releaseTransactionHash',msg('Serbest bırakma')],['refundTransactionHash',msg('İade')]]) {
        if (!TX_HASH.test(payment[key] || '')) continue;
        const a = el('a',msg`${label} · testnet işlem kaydı`,'btn secondary'); a.href = 'https://testnet.nearblocks.io/txns/' + payment[key]; a.target = '_blank'; a.rel = 'noopener noreferrer'; panel.append(a);
      }
    }
    if (legacy) return panel;
    const pending = state.walletPending?.jobId === job.id;
    if (state.escrowUncertain.has(job.id) || pending) paragraph(msg('Önceki işlemin sonucu doğrulanmadı. Yeni fonlama, kayıt, ödeme veya iade göndermeden durumu yenileyin.'),panel,'danger');
    if (!linkedWallet(state.session)) { walletPanel(panel); return panel; }
    if (isBuyer(job) || isSelected(job)) button(msg('Escrow durumunu yenile'),async () => { await escrowOperation(job,'refresh'); await render(); },panel,'btn secondary');
    if (pending && state.walletPending.transactionHash) button(msg('Mevcut işlem kaydını doğrula'),async () => { await confirmWalletTransaction(state.walletPending); await render(); },panel,'btn secondary');
    if (trusted && !pending && !state.walletPending && !state.escrowUncertain.has(job.id) && walletConfigured() && job.payment.contractId === walletPolicy.contractId) {
      let fundConsent;
      if (walletActionAllowed(job,'fund',state.session) && !(await localVaultFor(job).loadJob(job.id))?.payload?.task) fundConsent = field(panel,msg('Bu cihazda özgün şifreli istek yok. Yerel dosya kontrolü olmadan görünen iş özetlerini ve tam tutarı yatırmayı açıkça onaylıyorum.'),{type:'checkbox',required:false,name:'confirmMissingLocalFunding'});
      for (const [action,label] of [['fund',msg('Kendi cüzdanımdan tam tutarı yatır')],['record',msg('Sağlayıcı cüzdanımla son teslimi kaydet')],['release',msg('Son teslimin ödemesini cüzdanımda onayla')],['refund',msg('Süre doldu · kendi cüzdanıma iade iste')]]) {
        if (walletActionAllowed(job,action,state.session)) {
          const act = button(label,async () => { await escrowOperation(job,action,{allowMissingLocal:action === 'fund' && fundConsent?.checked === true}); await render(); },panel,'btn secondary');
          if (action === 'fund' && fundConsent) { act.disabled = !fundConsent.checked; fundConsent.addEventListener('change',() => { act.disabled = !fundConsent.checked; }); }
        }
      }
    }
    if (!walletConfigured()) paragraph(msg('Testnet cüzdan emaneti kullanılamıyor. Yeni iş veya eski ödeme akışına geçiş yapılmadı.'),panel,'danger');
    if (job.status === 'DELIVERED' && !escrowRecordedDelivery(job)) paragraph(msg('Kabul ve düzeltmeden önce sağlayıcı son teslimin zincir kaydını kendi cüzdanıyla kesinleştirmelidir. Kayıt teslimi kabul etmek değildir.'),panel);
    paragraph(msg('Cüzdanın imza veya gönderim cevabı ödeme kanıtı değildir. Yerel kontrol, güncel SNARK, açık kabul ve zincirde kesinleşmiş transfer ayrı adımlardır. Süre sonrası iade yalnızca bu işin müşterisine döner.'),panel);
    if (trusted && ESCROW_PENDING.has(payment.status)) scheduleEscrowRefresh(job,panel);
    return panel;
  }
  function proofPanel(job, local, localCorrect) {
    if (!isProofProfile(job.profile)) { paragraph(msg('Bu eski iş sürümünde bağımsız sonuç kanıtı yok; yerel sonuç kontrolü ve ödeme kaydı ayrı değerlendirilir.')); return; }
    const panel = card(msg('Bağımsız sonuç kanıtı')), previous = state.proofVerifications.get(job.id);
    if (previous && !clientProofMatches(job, previous)) state.proofVerifications.delete(job.id);
    const checked = clientProofMatches(job, state.proofVerifications.get(job.id));
    const status = paragraph(checked ? msg('Bağımsız sonuç kanıtı doğrulandı.') : serverProofMatches(job) ? msg('Sunucu kanıtı doğruladı; bu cihazda bağımsız doğrulama gerekli.') : msg('Sonuç kanıtı henüz oluşturulmadı veya güncel teslimle eşleşmiyor.'), panel, checked ? 'badge' : 'muted');
    paragraph(msg('Kanıt, sonucun önceden sabitlenen gizli eşlemeye göre doğruluğunu denetler. Sağlayıcının AES hesabını çalıştırdığını veya dosyanın kaynağını kanıtlamaz. Mevcut testnet sözleşmesi SNARK doğrulamaz.'), panel);
    if (job.proof?.bundleSha256 && HASH.test(job.proof.bundleSha256)) paragraph(msg`Kanıt SHA-256: ${job.proof.bundleSha256}`, panel);
    link(msg('Herkese açık kanıt görünümü'), '/verify?id=' + encodeURIComponent(job.id), panel, 'btn secondary');
    const cancel = el('button', msg('Kanıt işlemini iptal et'), 'btn secondary'); cancel.type = 'button'; cancel.hidden = true; cancel.disabled = true; cancel.dataset.allowBusy = 'true';
    let active = null; cancel.addEventListener('click', () => active?.abort());
    async function perform(type) {
      const epoch = state.epoch, contextKey = proofContextKey(job), controller = new AbortController();
      active = controller; state.proofAbort = controller; cancel.hidden = false; cancel.disabled = false; state.proofVerifications.delete(job.id);
      const current = () => {
        const route = routeOf(win.location.href, win.location.origin);
        if (controller.signal.aborted || epoch !== state.epoch || route?.path !== '/delivery' || route.id !== job.id) fail(msg('Kanıt işlemi iptal edildi veya teslim değişti; eski sonuç kullanılmadı.'));
      };
      const progress = stage => ({ completed, total }) => { if (!controller.signal.aborted && epoch === state.epoch) bindText(status, msg`${stage}: ${completed}/${total} satır tamamlandı.`); };
      try {
        current();
        const { job: fresh } = await api('/jobs/' + encodeURIComponent(job.id)); current();
        if (proofContextKey(fresh) !== contextKey) fail(msg('Teslim veya iş bağlamı değişti; güncel teslimi yeniden açın.'));
        let request, bundle;
        if (type === 'prove') {
          if (!local?.proofWitness || !proofTask(local.payload?.task) || !localCorrect) fail(msg('Bu cihazda doğrulanmış veri ve gizli kanıt eşlemesi gerekli.'));
          request = local.payload.task; bindText(status, msg('Sonuç kanıtı oluşturuluyor…'));
          bundle = await runProofWorker({ type: 'prove', request, delivery: job.delivery, binding: proofBinding(job), witness: local.proofWitness }, { workerFactory: proofWorkerFactory, signal: controller.signal, onProgress: progress(msg('Kanıt üretimi')) });
        } else {
          bindText(status, msg('Herkese açık kanıt alınıyor…'));
          const evidence = await api('/jobs/' + encodeURIComponent(job.id) + '/proof/evidence'); current();
          if (evidence.version !== 1 || evidence.network !== 'testnet' || evidence.jobId !== job.id || !proofTask(evidence.task) || evidence.task.profile !== job.profile || !evidence.bundle) fail(msg('Bu teslim için geçerli herkese açık kanıt bulunamadı.'));
          request = evidence.task; bundle = evidence.bundle;
        }
        current(); bindText(status, msg('Kanıt bağımsız olarak doğrulanıyor…'));
        await runProofWorker({ type: 'verify', request, delivery: job.delivery, binding: proofBinding(job), bundle }, { workerFactory: proofWorkerFactory, signal: controller.signal, onProgress: progress(msg('Bağımsız doğrulama')) });
        current();
        const info = { valid: true, contextKey, bundleSha256: await hashPublicProofBundle(bundle), finalContext: bundle.finalContext,
          manifestSha256: await hashProofManifest(request), requestSha256: await sha256(canonicalProofPlanRequest(request)), rowProofCount: request.proofManifest.rows.length };
        current(); const { job: latest } = await api('/jobs/' + encodeURIComponent(job.id)); current();
        if (proofContextKey(latest) !== contextKey) fail(msg('Teslim değişti; önceki sürümün kanıtı kabul için kullanılamaz.'));
        let updated = latest;
        if (type === 'prove') {
          bindText(status, msg('Kanıt sunucuda bağımsız olarak doğrulanıyor…'));
          ({ job: updated } = await api('/jobs/' + encodeURIComponent(job.id) + '/proof', 'POST', { version: job.delivery.version, outputSha256: job.delivery.outputSha256, bundle }));
          current();
        }
        if (updated?.id !== job.id || !clientProofMatches(updated, info)) fail(msg('Sunucunun güncel kanıt kaydı bu bağımsız doğrulamayla eşleşmiyor; kabul kapalı.'));
        state.proofVerifications.set(job.id, Object.freeze(info));
      } catch (error) {
        state.proofVerifications.delete(job.id);
        fail(error instanceof FriendlyError ? errorText(error) : msg('Sonuç kanıtı tamamlanamadı veya bu teslim için doğrulanamadı. Kabul kapalı; gizli eşleme bu cihazda kaldı.'));
      } finally {
        active = null; if (state.proofAbort === controller) state.proofAbort = null;
        cancel.hidden = true; cancel.disabled = true; await render();
      }
    }
    if (walletJob(job) && job.status === 'DELIVERED' && localCorrect && local?.proofWitness) button(msg('Sonuç kanıtını oluştur ve doğrula'), () => perform('prove'), panel);
    else if (!local?.proofWitness) paragraph(msg('Gizli kanıt eşlemesi bu cihazda yok. Var olan herkese açık kanıt doğrulanabilir; yeni kanıt üretilemez.'), panel);
    if (serverProofMatches(job)) button(msg('Kanıtı bu cihazda bağımsız doğrula'), () => perform('verify'), panel, 'btn secondary');
    panel.append(cancel);
    if (!checked && job.status === 'DELIVERED') paragraph(msg('Kabul için yerel sonuç kontrolü, son teslimin kesinleşmiş zincir kaydı ve bu cihazda bağımsız doğrulanmış güncel sonuç kanıtı gerekir. Düzeltme istemek için başarılı kanıt gerekmez.'), panel);
  }
  async function offers(job, target) {
    const panel = card(msg('Şifreli teklifler'), target);
    if (job.status === 'OPEN') { paragraph(msg('Teklif içerikleri kapanıştan önce açılmaz. Son zamanda veya erken kapatma düğmesiyle kapatın.'), panel); return; }
    if (!job.offers?.length) { paragraph(msg('Henüz teklif yok.'), panel, 'empty'); return; }
    for (const offer of job.offers) {
      const row = card(offer.providerName || msg('Sağlayıcı'), panel);
      try {
        const quote = await localVaultFor(job).decryptQuote(offer.envelope);
        if (await quoteCommitment(job.id, offer.providerId, quote.amountYocto, quote.salt) !== offer.commitment || quote.jobId !== job.id || quote.providerId !== offer.providerId) fail(msg('Teklif bağı doğrulanamadı.'));
        paragraph(msg`${formatNearAmount(quote.amountYocto)} testNEAR · ${quote.deliveryHours} saat`, row); paragraph(quote.note || msg('Not eklenmedi.'), row);
        paragraph(msg`Testnet alıcı hesabı: ${offer.paymentAccount}`, row);
        if (walletJob(job) && job.status === 'CLOSED') {
          const consent = field(row, msg('Seçilen sağlayıcının, cüzdan hesaplarının ve tam tutarın zincirde herkese açık olmasını onaylıyorum. Yatırmayı kendi cüzdanımda ayrıca imzalayacağım.'), { type: 'checkbox', required: false });
          button(msg('Bu sağlayıcıyı seç'), async () => {
            if (!consent.checked) fail(msg('Seçilen fiyatın açık hâle gelmesini onaylayın.'));
            const { job: awarded } = await api('/jobs/' + encodeURIComponent(job.id) + '/award', 'POST', { offerId: offer.id, amountYocto: quote.amountYocto, salt: quote.salt });
            if (awarded?.id !== job.id || !walletJob(awarded)) fail(msg('Cüzdan işlem kaydı bu oturumla eşleşmiyor. Yeni işlem gönderilmedi.'));
            await render(); message(msg('Sağlayıcı seçildi. Tam tutarı kendi cüzdanından ayrıca yatır; kesinleşmeden yürütme başlamaz.'));
          }, row);
        }
      } catch { paragraph(msg('Teklif bu cihazdaki anahtarla açılamadı veya taahhüdü doğrulanamadı. Seçim kapalı.'), row, 'danger'); }
    }
  }
  function recordTechnicalPlan(plan, planSha256, target, estimate) {
    const details = el('details', null, 'stack'); details.dataset.recordTechnical = 'true';
    details.append(el('summary', msg('Teknik planı göster'))); target.append(details);
    paragraph(msg`Plan SHA-256: ${planSha256}`, details);
    if (estimate) paragraph(msg`${estimate.rowCount} satır · ${estimate.gateCount}/10000 kapı · ${estimate.serializedRequestBytes} bayt şifreli istek`, details);
    plan.inputs.forEach((alias, i) => paragraph(msg`R${i} ↔ ${alias} · işaretsiz 32 bit`, details));
    plan.steps.forEach((step, i) => paragraph(recordStepText(step, i), details));
    details.append(el('pre', JSON.stringify(plan, null, 2))); return details;
  }
  function publicPlanInfo(job, target) {
    if (job.profile === RECORD_PROFILE && job.plan) {
      paragraph(msg('v5 · Çok alanlı kurallar ve bağımsız sonuç kanıtı. Özel alanlar ve kanıt tanığı müşterinin cihazında kalır.'), target);
      paragraph(msg`Herkese açık kural hedefi: ${job.publicTask?.goal || ''}`, target);
      recordTechnicalPlan(job.plan, job.planSha256, target); return;
    }
    if (![PLAN_PROFILE, PROOF_PROFILE].includes(job.profile) || !job.plan) return;
    if (job.profile === PROOF_PROFILE) paragraph(msg('v4 · Kabul öncesi bağımsız sonuç kanıtı gerekir. Gizli eşleme ve kanıt tanığı müşterinin cihazında kalır.'), target);
    paragraph(msg`Herkese açık ajan hedefi: ${job.publicTask?.goal || ''}`, target);
    paragraph(msg`Plan SHA-256: ${job.planSha256}`, target);
    for (const step of job.plan.steps) paragraph(msg`${step.column}: ${recipeText(step.recipe)}`, target);
  }
  async function detail(job) {
    title(job.title, statusText[job.status] || job.status);
    const panel = card(msg('İş bilgisi')); paragraph(job.description, panel); paragraph(msg`İş kimliği: ${job.id}`, panel); paragraph(msg`${job.rowCount} satır · ${job.profile}`, panel);
    if (job.recipe) paragraph(msg`Herkese açık tarif: ${recipeText(job.recipe)}`, panel);
    publicPlanInfo(job, panel);
    if (legacyJob(job)) paragraph(msg('Bu eski sponsor işi yalnızca okunur. Yeni imza veya ödeme başlatılmaz.'),panel,'notice');
    paragraph(msg`Teklif sonu: ${displayDate(job.deadlineISO)}`, panel);
    for (const [key, label] of [['taskHash', msg('Şifreli girdi özeti')], ['programHash', msg('Program özeti')]]) { const hash = job[key] || job.delivery?.[key]; if (hash) paragraph(msg`${label}: ${hash}`, panel); }
    if (isBuyer(job)) {
      const local = await localVaultFor(job).loadJob(job.id);
      if (local?.payload?.task) { paragraph(msg`Yerel şifreli girdi SHA-256: ${await taskInputHash(local.payload.task)}`, panel); paragraph(msg`Program SHA-256: ${await taskProgramHash(local.payload.task)}`, panel); }
      if (walletJob(job) && job.status === 'OPEN') button(msg('Teklifleri şimdi kapat'), async () => { await api('/jobs/' + encodeURIComponent(job.id) + '/close', 'POST', {}); await render(); message(msg('Teklifler kapatıldı. Yeni teklif alınmaz.')); }, panel, 'btn secondary');
      await offers(job, root);
      if (job.delivery) link(msg('Teslimi yerel olarak doğrula'), jobLink('/delivery', job.id));
    } else if (state.session.role === 'provider') {
      if (job.ownOffer) {
        const local = await state.vault.loadJob(job.id);
        paragraph(local?.ownQuote ? msg`Kendi teklifiniz: ${formatNearAmount(local.ownQuote.amountYocto)} testNEAR · ${local.ownQuote.deliveryHours} saat` : msg('Teklifiniz sunucuda kayıtlı. Yerel teklif bu cihazda bulunamadı.'), panel);
      } else if (walletJob(job) && job.status === 'OPEN') link(msg('Şifreli teklif ver'), jobLink('/offer', job.id), panel);
      if (isSelected(job)) link(msg('Şifreli işi yürüt / teslim'), jobLink('/delivery', job.id), panel);
    }
    if (job.selectedOffer) { paragraph(msg`Seçilen tutar: ${formatNearAmount(job.selectedOffer.amountYocto)} testNEAR · ${job.selectedOffer.paymentAccount}`, panel); link(msg('Ödeme ve makbuz'), jobLink('/payments', job.id), panel); }
    if (escrowJob(job) && (isBuyer(job) || isSelected(job)) && job.selectedOffer) await escrowPanel(job);
    button(msg('Durumu yenile'), render, panel, 'btn secondary');
  }
  async function offerForm(job) {
    requireRole('provider'); title(msg('Şifreli teklif ver'), job.title);
    if (!walletJob(job)) { paragraph(msg('Bu eski sponsor işi yalnızca okunur. Yeni imza veya ödeme başlatılmaz.')); return; }
    if (!walletConfigured() || !linkedWallet(state.session) || state.session.paymentAccount !== linkedWallet(state.session).accountId) { walletPanel(); return; }
    if (job.status !== 'OPEN' || job.ownOffer || new Date(job.deadlineISO).getTime() <= Date.now()) fail(msg('Bu iş yeni teklif almıyor veya teklifiniz zaten kayıtlı.'));
    if (!testnetAccount(state.session.paymentAccount)) fail(msg('Geçerli bir testnet ödeme hesabına sahip sağlayıcı oturumu gerekli.'));
    const panel = card(msg('Teklifiniz yalnızca müşteriye açılır')); paragraph(msg('Fiyat, teslim süresi ve not tarayıcıda müşterinin RSA anahtarıyla hibrit şifrelenir. Sunucuya açık fiyat gönderilmez. Müşteri kapanıştan sonra teklifleri kendi cihazında karşılaştırır; otomatik MPC seçimi yapılmaz.'), panel);
    paragraph(msg('Seçilirsen bağlı sağlayıcı hesabın ve teklif tutarın zincirde görünür olur. Müşteri tam tutarı kendi cüzdanından yatırır. Bu sözleşmede iş başına üst sınır 1 testNEAR’dır.'), panel);
    if (job.recipe) paragraph(msg`Herkese açık tarif: ${recipeText(job.recipe)}`, panel);
    publicPlanInfo(job, panel);
    const { node, submit } = form(panel, msg('Şifrele ve teklif gönder'), async () => {
      let amountYocto; try { amountYocto = parseNearAmount(amount.value).toString(); } catch { fail(msg('Geçerli bir testNEAR tutarı girin (en fazla 24 ondalık).')); }
      if (BigInt(amountYocto) <= 0n) fail(msg('Teklif tutarı sıfırdan büyük olmalı.'));
      if (BigInt(amountYocto) > 10n ** 24n) fail(msg('Bu cüzdan sözleşmesinde teklif en fazla 1 testNEAR olabilir.'));
      const hoursValue = Number(hours.value); if (!Number.isInteger(hoursValue) || hoursValue < 1 || hoursValue > 720) fail(msg('Teslim süresi 1–720 tam saat olmalı.'));
      const previous = await state.vault.loadJob(job.id) || {};
      const quote = previous.pendingOffer?.quote || { jobId: job.id, providerId: state.session.id, amountYocto, deliveryHours: hoursValue, note: note.value.trim(), salt: randomSalt() };
      if (BigInt(quote.amountYocto) > 10n ** 24n) fail(msg('Bu cüzdan sözleşmesinde teklif en fazla 1 testNEAR olabilir.'));
      const envelope = previous.pendingOffer?.envelope || await state.vault.encryptQuote(job.buyerPublicKey, quote);
      const commitment = await quoteCommitment(job.id, state.session.id, quote.amountYocto, quote.salt);
      await state.vault.saveJob(job.id, { ...previous, ownQuote: quote, pendingOffer: { quote, envelope } });
      await api('/jobs/' + encodeURIComponent(job.id) + '/offers', 'POST', { envelope, commitment });
      await state.vault.saveJob(job.id, { ...previous, ownQuote: quote }); win.history.pushState({}, '', jobLink('/job', job.id)); await render(); message(msg('Şifreli teklif kaydedildi.'));
    });
    const amount = field(node, msg('Teklif (testNEAR; en fazla 1)'), { name: 'amount', placeholder: msg('0.001') }); amount.inputMode = 'decimal';
    const hours = field(node, msg('Teslim süresi (saat)'), { type: 'number', value: '1', name: 'deliveryHours' }); hours.min = '1'; hours.max = '720'; hours.step = '1';
    const note = field(node, msg('Teklif notu (kişisel veri eklemeyin)'), { type: 'textarea', required: false, maxLength: 500, name: 'note' }); node.append(submit);
    paragraph(msg`Ödeme hesabınız: ${state.session.paymentAccount} · yalnızca testnet`, panel);
    const cached = await state.vault.loadJob(job.id);
    if (cached?.pendingOffer) paragraph(msg('Önceki teklif gönderiminin sonucu belirsiz. Önce iş detayını yenileyin; tekrar gönderim aynı saklanan şifreli teklifi kullanır.'), panel);
  }
  async function delivery(job) {
    title(msg('Teslim ve yerel kontrol'), job.title);
    if (isSelected(job)) {
      const panel = card(msg('Şifreli yürütme')); paragraph(msg('Yalnızca seçilen sağlayıcı bu işi yürütebilir. Sunucu şifreli devreyi işler; sağlayıcıya CSV veya çözülmüş değer gösterilmez.'), panel);
      if (job.recipe) paragraph(msg`Yürütülecek tarif: ${recipeText(job.recipe)}`, panel);
      publicPlanInfo(job, panel);
      if (escrowJob(job)) await escrowPanel(job);
      if (walletJob(job) && ['AWARDED', 'REVISION'].includes(job.status)) {
        const execute = button(job.status === 'REVISION' ? msg('Düzeltmeyi yeniden yürüt') : msg('Şifreli işi yürüt ve teslim et'), async () => {
          if (!escrowExecutionAllowed(job) || state.escrowUncertain.has(job.id) || state.walletPending) fail(msg('Yürütmeden önce müşterinin cüzdan yatırmasının zincirde kesinleşmesini bekle.'));
          await api('/jobs/' + encodeURIComponent(job.id) + '/execute', 'POST', {});
          await render(); message(msg('Şifreli teslim oluşturuldu. Sağlayıcı son teslimin zincir kaydını kendi cüzdanında ayrıca imzalamalı.'));
        }, panel);
        execute.disabled = !escrowExecutionAllowed(job) || state.escrowUncertain.has(job.id) || Boolean(state.walletPending);
        if (execute.disabled) paragraph(msg('Yürütmeden önce müşterinin cüzdan yatırmasının zincirde kesinleşmesini bekle.'), panel);
      }
      if (job.delivery) paragraph(msg`Teslim sürümü ${job.delivery.version} · şifreli çıktı SHA-256: ${job.delivery.outputSha256}`, panel);
      return;
    }
    if (!isBuyer(job)) fail(msg('Teslim yalnızca iş sahibi ve seçilen sağlayıcıya açıktır.'));
    if (escrowJob(job)) await escrowPanel(job);
    if (!job.delivery) { paragraph(msg('Henüz teslim yok.'), root, 'empty'); return; }
    const panel = card(msg('Bu cihazda doğrulama'));
    paragraph(msg('Sonuç etiketleri bu işin yerel çözücüsüyle açılır ve orijinal değerlerle karşılaştırılır. Bu kontrol yürütme kaynağı veya bağımsız operatör kanıtı değildir.'), panel);
    let local, outputs;
    const isRecipe = job.profile === RECIPE_PROFILE, isRecord = job.profile === RECORD_PROFILE, isProof = isProofProfile(job.profile), isPlan = job.profile === PLAN_PROFILE || isProof;
    publicPlanInfo(job, panel);
    const pending = paragraph('', panel); pending.dataset.deliveryPending = 'true'; pending.setAttribute('role', 'status'); pending.setAttribute('aria-live', 'polite');
    async function deliveryStage(text) {
      bindText(pending, text);
      // Let the visible status paint before local decoding/hashing can occupy CPU.
      if (win.requestAnimationFrame && !doc.hidden) await new Promise(resolve => win.requestAnimationFrame(() => win.setTimeout(resolve, 0)));
    }
    function clearDeliveryStage() { bindText(pending, ''); pending.hidden = true; }
    try {
      await deliveryStage(msg('Yerel kasa açılıyor; veri ve çözücü bu cihazda yükleniyor…'));
      local = await localVaultFor(job).loadJob(job.id); if (!local?.dataset || (isPlan ? !(isRecord ? local.recordApproval : local.agentApproval) || !local.values : !Array.isArray(local.values))) throw Error();
      await deliveryStage(isRecord ? msg('Şifreli kayıt teslimi çözülüyor; alan eşlemeleri ve giriş bağları denetleniyor…') : isProof ? msg('Şifreli teslim çözülüyor; v4 eşleme ve giriş bağları denetleniyor…') : msg('Şifreli teslim bu cihazda çözülüyor…'));
      outputs = isProof ? await decodeProofPlan(encodedResult(job.delivery), local.proofDecoder) : await state.vault.decodeDelivery(job.id, isRecipe || isPlan ? job.delivery : job.delivery.outputs);
    }
    catch { clearDeliveryStage(); if (isProof) proofPanel(job, local, false); paragraph(msg('Bu cihazda orijinal CSV veya çözme anahtarı yok ya da teslim açılamıyor. Aynı tarayıcı ve cihazdaki kasayla yeniden açın. Oturum açmak anahtarları başka cihaza taşımaz; sonuç veya kabul oluşturulmadı.'), panel, 'danger'); return; }
    const verified = { correct: false, version: job.delivery.version, outputSha256: job.delivery.outputSha256 };
    let recipeCSV, recordResult;
    try {
      await deliveryStage(msg('Yerel sonuç, plan ve veri özetleri karşılaştırılıyor…'));
      const task = local.payload?.task;
      const base = baseTask(task);
      if (!task || task.profile !== job.profile || taskRows(task) !== job.rowCount || (!isPlan && outputs.length !== local.values.length)) throw Error();
      if (isPlan) {
        if (isProof) validateProofPlanContext(task, { jobId: job.id, buyerCommitment: await sha256('NOPE:buyer:' + job.buyerId), contractId: job.payment?.contractId });
        const approval = isRecord ? local.recordApproval : local.agentApproval, checked = isRecord ? await acceptRecordProposal(job.publicTask, base.plan) : await acceptAgentProposal(job.publicTask, base.plan);
        if (checked.taskHash !== approval.taskHash || checked.planSha256 !== approval.planSha256 || checked.planSha256 !== job.planSha256 ||
            await (isRecord ? hashRecordPlan(job.plan) : hashPlan(job.plan)) !== checked.planSha256 || base.planSha256 !== checked.planSha256 ||
            JSON.stringify(checked.task) !== JSON.stringify(approval.task) || await datasetHash(local.dataset) !== approval.datasetSha256 ||
            JSON.stringify(isRecord ? privateRecordInputs(local.dataset, base.plan) : privatePlanInputs(local.dataset, base.plan)) !== JSON.stringify(local.values)) throw Error();
        if (isRecord) {
          const expected = local.values.map(row => referenceRecord(row, base.plan).slice(0, base.plan.outputs.length));
          if (JSON.stringify(outputs) !== JSON.stringify(expected)) throw Error();
          recordResult = applyRecordOutput(local.dataset, base.plan, outputs); recipeCSV = recordResult.csv;
        } else recipeCSV = applyAgentOutput(local.dataset, base.plan, outputs).csv;
        if (job.delivery.profile !== job.profile || job.delivery.nonce !== base.nonce || job.delivery.rowCount !== base.rowCount) throw Error();
      } else if (isRecipe) {
        // Re-extract the encrypted local dataset and check every value against
        // the bound public program, rather than trusting a cached preview.
        const values = parseRecipeColumn(local.dataset, local.column, task.recipe);
        if (JSON.stringify(values) !== JSON.stringify(local.values) || await hashRecipeProgram(job.recipe) !== await hashRecipeProgram(task.recipe)) throw Error();
        recipeCSV = applyRecipeOutput(local.dataset, local.column, outputs, task.recipe).csv;
        if (job.delivery.profile !== job.profile || job.delivery.nonce !== task.nonce || job.delivery.rowCount !== task.rowCount) throw Error();
      } else if (job.profile !== PROFILE || !verifyValues(local.values, outputs)) throw Error();
      await deliveryStage(msg('Şifreli girdi, çıktı ve program özetleri denetleniyor…'));
      if (await taskInputHash(task) !== job.delivery.inputSha256 || (isRecord ? await hashRecordOutput(job.delivery.outputs) : isPlan ? await hashPlanOutput(job.delivery.outputs) : isRecipe ? await hashRecipeOutput(job.delivery.outputs) : await hashOutput(job.delivery.outputs)) !== job.delivery.outputSha256 || await taskProgramHash(task) !== job.delivery.programSha256) throw Error();
      verified.correct = true;
    } catch { verified.correct = false; }
    clearDeliveryStage();
    paragraph(verified.correct ? isRecord ? msg('Yerel kontrol başarılı: dört türetilmiş sonuç onaylı çok alanlı kurallarla eşleşiyor.') : msg('Yerel kontrol başarılı: sonuç desteklenen temizleme kuralıyla eşleşiyor.') : msg('Yerel kontrol başarısız. Teslim kabul edilemez.'), panel, verified.correct ? 'badge' : 'danger');
    proofPanel(job, local, verified.correct);
    let changedOnly = false; const summary = el('p', null, 'muted'); panel.append(summary); const results = el('div'); panel.append(results);
    const show = () => {
      results.replaceChildren();
      if (isRecord) {
        if (!verified.correct || !recordResult) return;
        bindText(summary, msg`${job.rowCount} satır · dört türetilmiş sonuç · asıl sütunlar ve satır sırası korunur`);
        table([msg('Satır'), ...local.dataset.headers, ...recordOutputLabels(local.recordApproval.templateKind)], recordResult.rows.map((row, i) => [i + 1, ...row]), results); return;
      }
      if (isPlan) {
        let total = 0, changed = 0;
        for (const step of baseTask(local.payload.task).plan.steps) {
          const column = Number(step.column.slice(1)) - 1;
          const rows = outputs[step.column].map((v, i) => [i + 1, local.dataset.rows[i][column] || msg('(boş)'), step.recipe.type === 'number' && v === 255 || v === '' ? msg('(boş)') : v]);
          const different = rows.filter((_, i) => local.values[step.column][i] !== outputs[step.column][i]);
          total += rows.length; changed += different.length;
          paragraph(msg`${step.column} ↔ ${local.dataset.headers[column]} (yerel)`, results);
          table([msg('Satır'), msg('ÖNCE'), msg('SONRA')], changedOnly ? different : rows, results);
        }
        bindText(summary, msg`${job.rowCount} satır · ${total} işlenen hücre · ${changed} değişen`);
        return;
      }
      const rows = outputs.map((v, i) => [i + 1, local.dataset.rows[i][local.column] === '' ? msg('(boş)') : local.dataset.rows[i][local.column], ((isRecipe && local.payload.task.recipe.type === 'number' && v === 255) || v === '') ? msg('(boş)') : v]);
      const changed = rows.filter((row, i) => isRecipe ? local.values[i] !== outputs[i] : local.values[i] === 255 || local.values[i] !== outputs[i]);
      bindText(summary, msg`${rows.length} satır · ${changed.length} değişen · ${rows.length - changed.length} değişmeyen`);
      table([msg('Satır'), msg('ÖNCE'), msg('SONRA')], changedOnly ? changed : rows, results);
    }; show();
    if (!isRecord) button(msg('Değişen / tüm satırlar'), () => { changedOnly = !changedOnly; show(); message(msg('Tablo görünümü değişti.')); }, panel, 'btn secondary');
    if (verified.correct) {
      button(msg('CSV olarak indir (isteğe bağlı)'), () => {
        const blob = new Blob([isRecipe || isPlan ? recipeCSV : exportCSV(local.dataset, local.column, outputs)], { type: 'text/csv;charset=utf-8' }), url = win.URL.createObjectURL(blob);
        const a = el('a'); a.href = url; a.download = 'temizlenmis.csv'; a.click(); win.setTimeout(() => win.URL.revokeObjectURL(url), 1000); message(msg('CSV indirme hazırlandı.'));
      }, panel, 'btn secondary');
    }
    const acceptReady = decisionAllowed(job, verified, state.session, state.proofVerifications.get(job.id)) && (!escrowJob(job) || !state.escrowUncertain.has(job.id));
    if (walletJob(job) && (acceptReady || job.status === 'DELIVERED' && verified.correct)) {
      const accept = button(msg('Doğrulanan teslimi kabul et'), async () => {
        if (!decisionAllowed(job, verified, state.session, state.proofVerifications.get(job.id)) || escrowJob(job) && state.escrowUncertain.has(job.id)) fail(msg('Yerel sonuç, son teslimin zincir kaydı ve v4 için bağımsız sonuç kanıtı doğrulanmadan kabul edilemez.'));
        if (isProofProfile(job.profile)) {
          const { job: latest } = await api('/jobs/' + encodeURIComponent(job.id));
          if (!decisionAllowed(latest, verified, state.session, state.proofVerifications.get(job.id))) { await render(); fail(msg('Güncel teslim veya kanıt kaydı değişti. Kabul etmeden önce kanıtı yeniden bağımsız doğrulayın.')); }
        }
        const { job: accepted } = await api('/jobs/' + encodeURIComponent(job.id) + '/decision', 'POST', { decision: 'accept', version: verified.version, outputSha256: verified.outputSha256 });
        if (escrowJob(job)) {
          if (accepted?.id !== job.id || accepted.status !== 'ACCEPTED' || !escrowRecordedDelivery(accepted)) { await render(); fail(msg('Kabulün ve son teslim kaydının durumunu yenileyin. Yeni ödeme gönderilmedi.')); }
          await render(); message(msg('Teslim açıkça kabul edildi. Ödeme henüz yapılmadı; son teslimin serbest bırakmasını cüzdanında ayrıca imzala.'));
        } else { await render(); message(msg('Teslim kabul edildi. Manuel testnet ödeme henüz yapılmadı.')); }
      }, panel);
      accept.disabled = !acceptReady;
    }
    if (walletJob(job) && job.status === 'DELIVERED') {
      const revisionReady = !escrowJob(job) || job.payment.status === 'HELD' && escrowRecordedDelivery(job) && !state.escrowUncertain.has(job.id);
      const revise = button(msg('Düzeltme iste'), async () => {
        if (!revisionReady) fail(msg('Sürüm atlanmaması için önce son teslimin zincir kaydını kesinleştirin. Bu kayıt teslimi kabul etmek değildir.'));
        await api('/jobs/' + encodeURIComponent(job.id) + '/decision', 'POST', { decision: 'revise', version: job.delivery.version, outputSha256: job.delivery.outputSha256 }); await render(); message(msg('Düzeltme istendi.'));
      }, panel, 'btn secondary');
      revise.disabled = !revisionReady;
    }
    if (['ACCEPTED', 'PAID'].includes(job.status)) link(msg('Ödeme durumunu aç'), jobLink('/payments', job.id), panel);
  }
  async function payments(job) {
    if (!isBuyer(job) && !isSelected(job)) fail(msg('Bu ödeme kaydına erişiminiz yok.'));
    title(walletJob(job) ? msg('Cüzdan destekli testnet escrow') : msg('Eski ödeme kaydı · yalnızca okunur'),job.title);
    if (escrowJob(job)) { await escrowPanel(job); return; }
    const panel = card(msg('Eski ödeme kaydı · yalnızca okunur'));
    paragraph(msg('Bu eski kayıt için yeni transfer veya imza başlatılmaz. Mevcut tutar, alıcı ve doğrulanmış makbuz bilgileri gösterilir.'),panel);
    if (job.selectedOffer) {
      paragraph(msg`Tam tutar: ${formatNearAmount(job.selectedOffer.amountYocto)} testNEAR`,panel);
      paragraph(msg`Alıcı: ${job.selectedOffer.paymentAccount}`,panel);
    }
    paragraph(msg`Durum: ${job.payment?.status || job.status}`,panel);
    if (TX_HASH.test(job.payment?.transactionHash || '')) paragraph(msg`İşlem: ${job.payment.transactionHash}`,panel);
  }
  async function activity() {
    title(msg('Hareketler'), msg('Sunucunun sağladığı durum kayıtları')); const epoch = state.epoch; const jobs = await jobsList(); if (epoch !== state.epoch) return;
    for (const job of jobs) {
      const events = job.history || job.events;
      if (Array.isArray(events) && events.length) { const panel = card(msg`${job.title} · durum geçmişi`);
        table([msg('Zaman'), msg('Durum'), msg('Açıklama')], events.map(e => { const at = e.at || e.createdAt, status = e.status || e.type || e.stage || ''; return [at ? msg`${displayDate(at)}` : '', statusText[status] || status, e.message || '']; }), panel);
      }
    }
    paragraph(msg('Geçmiş kaydı sunulmadığında yalnızca güncel sunucu durumu gösterilir; eksik hareketler oluşturulmaz.'));
  }
  function settings() {
    title(msg('Kimlik ve yerel kasa'), msg('Anahtarlar bu tarayıcı ve cihaza bağlıdır.')); const panel = card(msg('Oturum ve cüzdan hesabı'));
    paragraph(msg`${state.session.displayName} · ${state.session.role === 'buyer' ? msg('Müşteri') : msg('Sağlayıcı')} · ${state.session.id}`, panel);
    if (state.session.paymentAccount) paragraph(msg`Testnet hesabı: ${state.session.paymentAccount}`, panel);
    paragraph(msg('Oturum bu sekmede korunur; cüzdan yönlendirmesi öncesinde kısa süreli dönüş kaydı da yerel şifreli kasaya yazılır. Aynı cüzdan ve rol iş sahipliğini geri getirir; farklı cihazda özel CSV veya çözücü geri gelmez. Yerel kasayı silmek çözme ve kanıt üretme yeteneğini kaybettirebilir.'), panel);
    walletPanel();
    paragraph(msg('Çıkış yerel kasayı silmez. Aynı cüzdan ve rolle yeniden bağlanınca iş sahipliği geri gelir; bu cihazdaki kasa korunuyorsa özel verilere erişilebilir. Farklı cüzdan veya rol iş yetkilerini değiştirir. Kayıp CSV ve çözücü yeniden girişle kurtarılamaz.'), panel, 'danger');
    const consent = field(panel, msg('Başka cüzdan veya rolün iş yetkilerini değiştirdiğini ve yerel kasayı silmenin dosya ile çözücüyü kaybettirebileceğini anladım. Kasayı koruyarak çıkış yapmayı onaylıyorum.'), { type: 'checkbox', required: false });
    button(msg('Rol değiştirmek için yeni oturum başlat'), async () => { if (!consent.checked) fail(msg('Önce yerel kasa ve cüzdan yetkileri uyarısını onaylayın.')); await logout(); }, panel, 'btn secondary');
  }
  async function logout() {
    state.proofAbort?.abort(); state.proofVerifications.clear(); state.proofCapability = null;
    if (state.walletPending?.kind === 'transaction') fail(msg('Önceki cüzdan işlemi bekliyor. Yeni işlem imzalamadan mevcut kaydı doğrula.'));
    await clearWalletResume(); state.walletCapability = null; walletClient = undefined;
    state.epoch++; storage.removeItem(TOKEN_KEY); state.token = null; state.session = null; state.vault = null; state.draft = null; state.uncertain = false; state.newDraftAllowed = false;
    win.history.pushState({}, '', '/workspace'); await render(); message(msg('Oturum kapandı. Yerel kasa korundu. Aynı cüzdan ve rolle yeniden bağlanabilirsin; kayıp yerel dosyalar yeniden girişle geri gelmez.'));
  }
  async function render() {
    state.proofAbort?.abort();
    clearEscrowPoll();
    const epoch = ++state.epoch; root.replaceChildren(); chrome(); message();
    const route = routeOf(win.location.href, win.location.origin);
    if (!route) { title(msg('Sayfa bulunamadı')); link(msg('Çalışma alanına dön'), '/workspace'); return; }
    if (!state.session || route.path === '/workspace') { onboarding(); return; }
    root.setAttribute('aria-busy', 'true'); paragraph(msg('Yükleniyor…'));
    try {
      if (['/job', '/offer', '/delivery', '/payments'].includes(route.path)) {
        if (!route.id || !/^[a-f0-9]{32}$/.test(route.id)) fail(msg('Geçerli bir iş kimliği gerekli.'));
        const { job } = await api('/jobs/' + encodeURIComponent(route.id)); if (epoch !== state.epoch) return; root.replaceChildren();
        if (route.path === '/job') await detail(job);
        if (route.path === '/offer') await offerForm(job);
        if (route.path === '/delivery') await delivery(job);
        if (route.path === '/payments') await payments(job);
        return job;
      } else {
        root.replaceChildren();
        if (route.path === '/jobs/new') await newJob();
        else if (route.path === '/settings') settings();
        else if (route.path === '/activity') await activity();
        else {
          if (route.path === '/customer') requireRole('buyer');
          if (route.path === '/provider') requireRole('provider');
          title(route.path === '/jobs' ? (state.session.role === 'buyer' ? msg('İşlerim') : msg('Açık işler ve tekliflerim')) : state.session.role === 'buyer' ? msg('İşlerin, kontrolün altında.') : msg('Bir sonraki işin burada.'), msg('İşleri, teklifleri ve teslimleri tek yerden takip et.'));
          if (state.session.role === 'buyer') link(msg('Yeni şifreli iş oluştur'), '/jobs/new');
          if (!linkedWallet(state.session) || !walletConfigured()) walletPanel();
          if (state.session.role === 'buyer') await renderRecovery(root);
          const summary = el('div', null, 'dashboard-summary'); root.append(summary);
          try {
            const jobs = await jobsList();
            for (const [label, count] of [
              [msg('Bu sayfadaki işler'), jobs.length],
              [msg('Tekliflere açık'), jobs.filter(j => j.status === 'OPEN').length],
              [msg('Teslim / kabul bekleyen'), jobs.filter(j => ['AWARDED', 'DELIVERED', 'REVISION'].includes(j.status)).length],
            ]) { const box = el('div', null, 'metric-card'); box.append(el('span', label), el('strong', count, 'summary-count')); summary.append(box); }
          } catch (err) { summary.hidden = true; paragraph(err instanceof FriendlyError ? errorText(err) : msg('İş listesi yüklenemedi. Yerel doğrulanmamış girişimler korunuyor.'), root, 'danger'); }
          button(msg('Listeyi yenile'), render, root, 'btn secondary');
        }
      }
    } catch (err) {
      if (epoch !== state.epoch) return; root.replaceChildren(); title(msg('İşlem şu anda kullanılamıyor'));
      paragraph(err instanceof FriendlyError ? errorText(err) : msg('Bu sayfa yüklenemedi. Bağlantınızı ve yerel kasa erişimini kontrol edin.'), root, 'danger');
      button(msg('Yeniden dene'), render); link(msg('Çalışma alanına dön'), '/workspace');
    } finally { if (epoch === state.epoch) { root.removeAttribute('aria-busy'); if (state.busy) controlsBusy(true); } }
  }
  let listenersBound = false;
  async function completeWalletReturn() {
    if (!state.walletPending) return;
    const result = await (await client()).completeRedirect();
    if (!result) return;
    const pending = state.walletPending;
    if (result.kind === 'challenge' && pending.kind === 'challenge' && result.result?.challengeId === pending.challengeId && result.result.accountId === pending.accountId) {
      await verifyWalletResult(result.result); return;
    }
    if (result.kind === 'transaction' && pending.kind === 'transaction' && result.intentId === pending.intentId && TX_HASH.test(result.transactionHash)) {
      await saveWalletResume({...pending,transactionHash:result.transactionHash}); await confirmWalletTransaction(state.walletPending); return;
    }
    fail(msg('Cüzdan işlem kaydı bu oturumla eşleşmiyor. Yeni işlem gönderilmedi.'));
  }
  async function start() {
    if (!listenersBound) {
    listenersBound = true;
    doc.addEventListener('click', event => {
      const a = event.target.closest?.('a[data-route]');
      if (!a || event.defaultPrevented || event.button > 0 || event.ctrlKey || event.metaKey || event.shiftKey || event.altKey || a.target === '_blank' || !routeOf(a.href, win.location.origin)) return;
      event.preventDefault(); if (!state.busy) void navigate(a.href);
    });
    win.addEventListener('popstate', () => { if (state.busy) { state.pendingNavigation = true; state.proofAbort?.abort(); } else void render(); });
    $('workspace-logout')?.addEventListener('click', () => run(logout));
    }
    let resume;
    try { resume = await redirectVault().loadJob(WALLET_RESUME_RECORD); } catch { /* Existing sessions still open when IndexedDB is unavailable. */ }
    if (!state.token && win.location.pathname === '/settings' && resume?.version === 1 && typeof resume.token === 'string' && resume.expiresAt > Date.now()) { state.token = resume.token; storage.setItem(TOKEN_KEY,resume.token); }
    if (state.token) {
      try { const { session, proof, wallet } = await api('/session'); if (!session || !['buyer', 'provider'].includes(session.role)) throw Error(); state.proofCapability = proofCapability(proof); state.walletCapability = wallet ?? null; state.session = session; state.vault = vaultFactory(session.id); }
      catch (err) {
        if (!state.token) await render();
        else { root.replaceChildren(); title(msg('Oturum doğrulanamadı')); paragraph(msg('Kimliğiniz korunuyor. Yeni kimlik oluşturmadan bağlantıyı yeniden deneyin.')); button(msg('Oturumu yeniden doğrula'), start); }
        message(err instanceof FriendlyError ? errorText(err) : msg('Oturum geri yüklenemedi. Yeniden deneyin.'), true); return;
      }
    }
    if (state.session && resume?.version === 1 && resume.token === state.token && (resume.sessionId === state.session.id || resume.pending?.kind === 'challenge' && linkedWallet(state.session)?.accountId === resume.pending.accountId)) {
      state.walletPending = resume.pending;
      if (win.location.pathname === '/settings') {
        try { await completeWalletReturn(); }
        catch (error) { await render(); message(error instanceof FriendlyError ? errorText(error) : walletError(error),true); return; }
      }
    }
    await render();
  }
  return { start, render, navigate, state, api };
}
if (typeof document !== 'undefined' && document.getElementById('workspace-root')) {
  void (async () => {
    try { await initI18n({ document, window }); }
    catch { setLanguage('en', { persist: false }); }
    localizeDocument(document);
    mountLanguagePicker({ document, window, target: document.querySelector('.site-header') || document.querySelector('header') });
    const app = createWorkspace({ document, window });
    await app.start();
  })();
}
