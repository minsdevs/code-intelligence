'use strict';

// The benchmark driver hashes/mutates fixtures synchronously. Sample in a dedicated
// worker so its event-loop pauses cannot silently remove product RSS observations.
const { Worker, isMainThread, parentPort, workerData } = require('node:worker_threads');
const { startPhaseSampler } = require('./workload-metrics.cjs');
const { readOwnerMemory } = require('./process-memory.cjs');

function startOwnedPhaseSampler(ownerPid, fd, sequence, started) {
  const worker = new Worker(__filename, { workerData: { ownerPid, fd, sequence, started } });
  let next = 0, failure, stopped;
  const pending = new Map();
  const fail = () => {
    failure ??= new Error('MEMORY_SAMPLE_FAILED');
    for (const { reject } of pending.values()) reject(failure);
    pending.clear();
  };
  worker.on('error', fail);
  worker.on('exit', () => { if (pending.size || !stopped) fail(); });
  worker.on('message', ({ id, value, failed }) => {
    const request = pending.get(id);
    if (!request) return;
    pending.delete(id);
    if (failed) request.reject(new Error('MEMORY_SAMPLE_FAILED'));
    else request.resolve(value);
  });
  const request = (kind, name) => {
    if (failure) return Promise.reject(failure);
    return new Promise((resolve, reject) => {
      const id = ++next;
      pending.set(id, { resolve, reject });
      worker.postMessage({ id, kind, name });
    });
  };
  return Object.freeze({
    phase: name => request('phase', name),
    snapshot: () => request('snapshot'),
    stop() {
      stopped ??= request('stop').finally(() => worker.terminate());
      return stopped;
    },
  });
}

if (!isMainThread) {
  const { ownerPid, fd, sequence, started } = workerData;
  const sampler = startPhaseSampler(ownerPid, fd, sequence, started, { read: () => readOwnerMemory(ownerPid) });
  parentPort.on('message', async ({ id, kind, name }) => {
    try {
      let value;
      if (kind === 'phase') sampler.phase(name);
      else if (kind === 'snapshot') value = sampler.snapshot();
      else if (kind === 'stop') value = await sampler.stop();
      else throw new Error('MEMORY_SAMPLE_FAILED');
      parentPort.postMessage({ id, value });
    } catch { parentPort.postMessage({ id, failed: true }); }
  });
}

module.exports = { startOwnedPhaseSampler };
