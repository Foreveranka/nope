/** Static hosting never starts local computation or sends records to a public API. */
export function summaryPath(value) {
  if (typeof value !== 'string' || !/^\/[a-zA-Z0-9_./-]+$/.test(value) || value.startsWith('//') || value.split('/').some(part => part === '.' || part === '..')) {
    throw new Error('Kayıtlı sonuç adresi aynı kaynaktaki bir dosya yolu olmalı.');
  }
  return value;
}
export async function loadDeployment() {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 10000);
  try {
    const response = await fetch('/deployment.json', { credentials: 'same-origin', cache: 'no-store', signal: controller.signal });
    if (response.status === 404) return { mode: 'local' };
    if (!response.ok) throw new Error('Yayın yapılandırması alınamadı. İşlem başlatılmadı.');
    const config = await response.json();
    if (config?.mode !== 'hosted-evidence') throw new Error('Yayın yapılandırması tanınmadı. İşlem başlatılmadı.');
    return { mode: 'hosted-evidence', summaryUrl: summaryPath(config.summaryUrl) };
  } finally { clearTimeout(timer); }
}
export function checkCounts(checks) {
  if (!Array.isArray(checks)) return null;
  return { total: checks.length, passed: checks.filter(item => item?.pass === true).length,
    failed: checks.filter(item => item?.pass === false).length,
    unknown: checks.filter(item => typeof item?.pass !== 'boolean').length };
}
export function recordedRun(data) {
  if (data?.run) return data.run;
  if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error('Kayıtlı demo sonucu alınamadı.');
  const result = data.result ?? data;
  if (typeof result?.completed !== 'boolean') throw new Error('Kayıtlı sonuç tamamlanma durumu içermiyor.');
  return { id: typeof data.id === 'string' ? data.id : 'recorded-local-run',
    status: result.completed ? 'completed' : 'failed', events: data.events ?? result.events ?? [], result,
    error: typeof data.error === 'string' ? data.error : undefined };
}
