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
  const fail = () => {
    failure ??= new Error('MEMORY_SAMPLE_FAILED');
    for (const { reject, timer } of pending.values()) { clearTimeout(timer); reject(failure); }
    pending.clear();
  };
  worker.on('error', fail);
  worker.on('exit', () => { if (pending.size || !stopped) fail(); });
  worker.on('message', ({ id, value, failed }) => {
    const request = pending.get(id);
    if (!request) return;
    pending.delete(id); clearTimeout(request.timer);
    if (failed) request.reject(new Error('MEMORY_SAMPLE_FAILED'));
    else request.resolve(value);
  });
  const request = (kind, data) => {
    if (failure) return Promise.reject(failure);
    return new Promise((resolve, reject) => {
      const id = ++next;
      const timer = setTimeout(fail, 15000);
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
          try { value = await sampler?.stop(); } finally { await reader.close(); }
        } else throw new Error('MEMORY_SAMPLE_FAILED');
        parentPort.postMessage({ id, value });
      } catch { parentPort.postMessage({ id, failed: true }); }
    });
  })().catch(() => { process.exitCode = 1; });
}

module.exports = { prepareOwnedPhaseSampler };
