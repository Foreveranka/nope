/** Browser-side lifecycle for the public-task-only local planner. */
import {publicTask} from './agent-plan.mjs';
export const AGENT_MODEL_TIMEOUT_MS = 300_000;
function keys(value, expected) {
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
      Object.getPrototypeOf(value) !== Object.prototype ||
      Reflect.ownKeys(value).length !== expected.length || expected.some(key => {
        const d = Object.getOwnPropertyDescriptor(value, key);
        return !d?.enumerable || !Object.hasOwn(d, 'value');
      })) throw new Error('Unexpected public planner fields.');
}
export function validateModelRequest(request) {
  keys(request, ['type', 'task', 'taskHash']);
  if (request.type !== 'plan' || typeof request.taskHash !== 'string' || !/^[a-f0-9]{64}$/.test(request.taskHash)) throw new Error('Invalid public planner request.');
  return {type:'plan',task:publicTask(request.task),taskHash:request.taskHash};
}
/** Terminates the dedicated worker on success, failure, cancellation or timeout. */
export function planWithLocalModel(request, {onProgress = () => {}, signal, timeoutMs = AGENT_MODEL_TIMEOUT_MS} = {}) {
  const publicRequest = validateModelRequest(request);
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 600_000) throw new Error('Invalid planner timeout.');
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new Error('Local planning cancelled.'));
    const worker = new Worker(new URL('./agent-model-worker.mjs', import.meta.url), {type:'module'});
    let timer;
    const finish = (error, result) => {
      clearTimeout(timer); signal?.removeEventListener('abort', abort); worker.terminate();
      error ? reject(error) : resolve(result);
    };
    const abort = () => finish(new Error('Local planning cancelled.'));
    signal?.addEventListener('abort', abort, {once:true});
    timer = setTimeout(() => finish(new Error('Local model timed out. No plan was accepted.')), timeoutMs);
    worker.onerror = () => finish(new Error('Local model worker failed. Check self-hosted assets and browser capabilities.'));
    worker.onmessage = ({data}) => {
      if (data?.type === 'progress') { try { onProgress(data); } catch {} }
      else if (data?.type === 'plan' && typeof data.raw === 'string') finish(null, data);
      else if (data?.type === 'error') finish(new Error(data.error || 'Local planning failed.'));
      else finish(new Error('Unexpected local model response.'));
    };
    worker.postMessage(publicRequest);
  });
}
