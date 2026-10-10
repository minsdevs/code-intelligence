'use strict';

// Prepare this worker/native helper before quiet admission. Fixture hashing in the
// driver must not pause either sampling or the selected-PID native response reader.
const { Worker, isMainThread, parentPort, workerData } = require('node:worker_threads');
const { startPhaseSampler } = require('./workload-metrics.cjs');
const { openNativeRss } = require('./native-rss.cjs');

async function prepareOwnedPhaseSampler(nativeReader) {
  const worker = new Worker(__filename, { workerData: { nativeReader } });
  let next = 0, failure, stopped, started = false;
  const pending = new Map();
  const fail = detail => {
    if (!failure) { failure = new Error('MEMORY_SAMPLE_FAILED'); failure.detail = typeof detail === 'string' ? detail : null; }
    for (const { reject, timer } of pending.values()) { clearTimeout(timer); reject(failure); }
    pending.clear();
  };
  worker.on('error', () => fail('WORKER_ERROR'));
  worker.on('exit', () => { if (pending.size || !stopped) fail('WORKER_EXIT'); });
  worker.on('message', ({ id, value, failed, detail, partial }) => {
    const request = pending.get(id);
    if (!request) return;
    pending.delete(id); clearTimeout(request.timer);
    if (failed) { const error = new Error('MEMORY_SAMPLE_FAILED'); error.detail = typeof detail === 'string' ? detail : null; error.partial = partial ?? null; request.reject(error); }
    else request.resolve(value);
  });
  const request = (kind, data) => {
    if (failure) return Promise.reject(failure);
    return new Promise((resolve, reject) => {
      const id = ++next;
      const timer = setTimeout(() => fail('WORKER_TIMEOUT'), 15000);
      pending.set(id, { resolve, reject, timer });
      worker.postMessage({ id, kind, data });
    });
  };
  const close = () => { stopped ??= request('stop').finally(() => worker.terminate()); return stopped; };
  let helper;
  try { helper = await request('ready'); }
  catch (error) { await close().catch(() => {}); throw error; }
  return Object.freeze({
    helperPid: helper.pid,
    async start(ownerPid, fd, sequence, at) {
      if (started || stopped) throw new Error('MEMORY_SAMPLE_FAILED');
      started = true;
      await request('start', { ownerPid, fd, sequence, started: at });
      return Object.freeze({ phase: name => request('phase', name), snapshot: () => request('snapshot'), stop: close });
    },
    close,
  });
}

if (!isMainThread) {
  (async () => {
    const reader = await openNativeRss(workerData.nativeReader);
    let sampler;
    parentPort.on('message', async ({ id, kind, data }) => {
      try {
        let value;
        if (kind === 'ready') value = { pid: reader.pid };
        else if (kind === 'start' && !sampler) {
          const { ownerPid, fd, sequence, started } = data;
          sampler = startPhaseSampler(ownerPid, fd, sequence, started, { read: () => reader.read(ownerPid) });
        } else if (kind === 'phase' && sampler) sampler.phase(data);
        else if (kind === 'snapshot' && sampler) value = sampler.snapshot();
        else if (kind === 'stop') {
          let closeError = null;
          try { value = await sampler?.stop(); } finally { try { await reader.close(); } catch (error) { closeError = error; } }
          // The samples collected so far stay with the failure instead of being discarded with it.
          if (closeError) { closeError.partial = value ?? null; throw closeError; }
        } else throw new Error('MEMORY_SAMPLE_FAILED');
        parentPort.postMessage({ id, value });
      } catch (error) {
        // Only a known failure code (and already-structured partial results) crosses the thread boundary, never raw error text.
        const code = typeof error?.code === 'string' ? error.code : typeof error?.message === 'string' ? error.message : null;
        parentPort.postMessage({ id, failed: true, detail: code && /^[A-Z][A-Z0-9_]{2,63}$/.test(code) ? `${kind}:${code}` : `${kind}:UNCLASSIFIED`,
          partial: error?.partial ?? null });
      }
    });
  })().catch(() => { process.exitCode = 1; });
}

module.exports = { prepareOwnedPhaseSampler };
