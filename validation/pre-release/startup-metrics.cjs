'use strict';

const assert = require('node:assert/strict');

const MAX_TABLE_BYTES = 2 * 1024 * 1024;
const MAX_ROWS = 50000;
const MAX_TREE = 1024;

function parseMemoryTable(text) {
  assert.equal(typeof text, 'string', 'MEMORY_TABLE_INVALID');
  assert(Buffer.byteLength(text) <= MAX_TABLE_BYTES, 'MEMORY_TABLE_LIMIT');
  if (!text.trim()) return [];

  const rows = text.trim().split('\n').map((line) => {
    const match = /^\s*([0-9]+)\s+([0-9]+)\s+([0-9]+)\s*$/.exec(line);
    assert(match, 'MEMORY_TABLE_INVALID');
    const pid = Number(match[1]);
    const ppid = Number(match[2]);
    const rssKiB = Number(match[3]);
    assert(Number.isSafeInteger(pid) && pid > 0, 'MEMORY_TABLE_INVALID');
    assert(Number.isSafeInteger(ppid) && ppid >= 0 && pid !== ppid, 'MEMORY_TABLE_INVALID');
    assert(Number.isSafeInteger(rssKiB) && rssKiB >= 0, 'MEMORY_TABLE_INVALID');
    return { pid, ppid, rssKiB };
  });

  assert(rows.length <= MAX_ROWS, 'MEMORY_TABLE_LIMIT');
  assert.equal(new Set(rows.map((row) => row.pid)).size, rows.length, 'MEMORY_TABLE_INVALID');
  return rows;
}

function memoryForOwner(rows, ownerPid) {
  assert(Array.isArray(rows), 'MEMORY_ROWS_INVALID');
  assert(Number.isSafeInteger(ownerPid) && ownerPid > 0, 'MEMORY_OWNER_INVALID');
  const byPid = new Map();
  for (const row of rows) {
    assert(row && Number.isSafeInteger(row.pid) && row.pid > 0, 'MEMORY_ROWS_INVALID');
    assert(Number.isSafeInteger(row.ppid) && row.ppid >= 0 && row.ppid !== row.pid, 'MEMORY_ROWS_INVALID');
    assert(Number.isSafeInteger(row.rssKiB) && row.rssKiB >= 0, 'MEMORY_ROWS_INVALID');
    assert(!byPid.has(row.pid), 'MEMORY_ROWS_INVALID');
    byPid.set(row.pid, row);
  }
  if (!byPid.has(ownerPid)) return null;

  const included = new Set([ownerPid]);
  let previous = -1;
  while (previous !== included.size) {
    previous = included.size;
    for (const row of rows) if (included.has(row.ppid)) included.add(row.pid);
    assert(included.size <= MAX_TREE, 'MEMORY_TREE_LIMIT');
  }

  const processes = rows.filter((row) => included.has(row.pid));
  let rssKiB = 0;
  for (const row of processes) {
    rssKiB += row.rssKiB;
    assert(Number.isSafeInteger(rssKiB), 'MEMORY_SUM_OVERFLOW');
  }
  return { rssKiB, processes };
}

function percentile95(values) {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.ceil(0.95 * sorted.length) - 1];
}

function evaluateStartupSamples(samples, {
  expectedRuns = 20,
  maxWarmMs = 10000,
  maxIdleRssKiB = 1572864,
} = {}) {
  assert(Array.isArray(samples), 'STARTUP_SAMPLES_INVALID');
  assert(Number.isSafeInteger(expectedRuns) && expectedRuns > 0, 'STARTUP_CONFIG_INVALID');
  assert(Number.isFinite(maxWarmMs) && maxWarmMs > 0, 'STARTUP_CONFIG_INVALID');
  assert(Number.isSafeInteger(maxIdleRssKiB) && maxIdleRssKiB > 0, 'STARTUP_CONFIG_INVALID');

  const failures = new Set();
  let completedRuns = 0;
  let failedRuns = 0;
  let unexecutedRuns = 0;
  const ready = [];
  const idle = [];

  for (const sample of samples) {
    assert(sample && typeof sample === 'object' && !Array.isArray(sample), 'STARTUP_SAMPLES_INVALID');
    assert(['PASS', 'FAIL', 'NOT_RUN'].includes(sample.status), 'STARTUP_SAMPLES_INVALID');

    if (sample.status === 'NOT_RUN') {
      unexecutedRuns += 1;
      failures.add('RUN_NOT_EXECUTED');
      continue;
    }

    completedRuns += 1;
    if (sample.status === 'FAIL') {
      failedRuns += 1;
      failures.add('RUN_FAILED');
    }

    if (!Number.isFinite(sample.readyMs) || sample.readyMs <= 0) failures.add('READY_SAMPLE_INVALID');
    if (!Number.isFinite(sample.idlePeakRssKiB) || sample.idlePeakRssKiB <= 0) failures.add('RSS_SAMPLE_INVALID');
    if (sample.cleanupConfirmed !== true) failures.add('CLEANUP_UNCONFIRMED');
    if (sample.samplingComplete !== true) failures.add('SAMPLING_INCOMPLETE');

    if (sample.status === 'PASS'
        && Number.isFinite(sample.readyMs) && sample.readyMs > 0
        && Number.isFinite(sample.idlePeakRssKiB) && sample.idlePeakRssKiB > 0
        && sample.cleanupConfirmed === true && sample.samplingComplete === true) {
      ready.push(sample.readyMs);
      idle.push(sample.idlePeakRssKiB);
    }
  }

  if (samples.length > expectedRuns) failures.add('RUN_COUNT_INVALID');
  const accounted = completedRuns + unexecutedRuns;
  if (accounted < expectedRuns) {
    unexecutedRuns += expectedRuns - accounted;
    failures.add('RUN_NOT_EXECUTED');
  }
  if (completedRuns !== expectedRuns || failedRuns !== 0 || unexecutedRuns !== 0 || ready.length !== expectedRuns || idle.length !== expectedRuns) {
    return {
      status: 'FAIL', requestedRuns: expectedRuns, completedRuns, failedRuns, unexecutedRuns,
      p95ReadyMs: null, p95IdleRssKiB: null, maxIdleRssKiB: null, failures: [...failures].sort(),
    };
  }

  const p95ReadyMs = percentile95(ready);
  const p95IdleRssKiB = percentile95(idle);
  const maxIdleRssKiBObserved = Math.max(...idle);
  if (p95ReadyMs > maxWarmMs) failures.add('READY_SLO_EXCEEDED');
  // The memory target is a ceiling, not permission to discard one high sample.
  if (maxIdleRssKiBObserved > maxIdleRssKiB) failures.add('RSS_SLO_EXCEEDED');
  return {
    status: failures.size === 0 ? 'PASS' : 'FAIL', requestedRuns: expectedRuns,
    completedRuns, failedRuns, unexecutedRuns, p95ReadyMs, p95IdleRssKiB, maxIdleRssKiB: maxIdleRssKiBObserved,
    failures: [...failures].sort(),
  };
}

module.exports = { parseMemoryTable, memoryForOwner, evaluateStartupSamples };
