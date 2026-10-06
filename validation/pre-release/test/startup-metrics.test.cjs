'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { parseMemoryTable, memoryForOwner, evaluateStartupSamples } = require('../startup-metrics.cjs');

function pass(readyMs = 100, idlePeakRssKiB = 100) {
  return { status: 'PASS', readyMs, idlePeakRssKiB, cleanupConfirmed: true, samplingComplete: true };
}

test('parseMemoryTable parses a normal ps table including zero RSS', () => {
  assert.deepEqual(parseMemoryTable('100 1 0\n101 100 42\n'), [
    { pid: 100, ppid: 1, rssKiB: 0 },
    { pid: 101, ppid: 100, rssKiB: 42 },
  ]);
});

test('parseMemoryTable rejects negative-like, duplicate and unsafe values', () => {
  for (const value of ['100 1 -1', '100 1 1\n100 1 2', '9007199254740992 1 1', '100 100 1']) {
    assert.throws(() => parseMemoryTable(value));
  }
});

test('memoryForOwner returns null when owner is absent', () => {
  assert.equal(memoryForOwner([{ pid: 2, ppid: 1, rssKiB: 10 }], 99), null);
});

test('memoryForOwner sums only the owner closure regardless of row order', () => {
  const rows = parseMemoryTable('12 11 30\n20 1 500\n10 1 10\n11 10 20\n');
  assert.deepEqual(memoryForOwner(rows, 10), {
    rssKiB: 60,
    processes: [
      { pid: 12, ppid: 11, rssKiB: 30 },
      { pid: 10, ppid: 1, rssKiB: 10 },
      { pid: 11, ppid: 10, rssKiB: 20 },
    ],
  });
});

test('evaluateStartupSamples passes twenty complete runs and calculates nearest-rank p95', () => {
  const samples = Array.from({ length: 20 }, (_, index) => pass(index + 1, 100 + index));
  assert.deepEqual(evaluateStartupSamples(samples), {
    status: 'PASS', requestedRuns: 20, completedRuns: 20, failedRuns: 0, unexecutedRuns: 0,
    p95ReadyMs: 19, p95IdleRssKiB: 118, maxIdleRssKiB: 119, failures: [],
  });
});

test('evaluateStartupSamples is independent of sample order', () => {
  const samples = Array.from({ length: 20 }, (_, index) => pass(index + 1, 1000 + index)).reverse();
  assert.equal(evaluateStartupSamples(samples).p95ReadyMs, 19);
});

test('evaluateStartupSamples rejects invalid counts and nineteen-only input without recomputing p95', () => {
  const nineteen = Array.from({ length: 19 }, () => pass());
  const result = evaluateStartupSamples(nineteen);
  assert.equal(result.status, 'FAIL');
  assert.equal(result.unexecutedRuns, 1);
  assert.equal(result.p95ReadyMs, null);
  assert.equal(result.p95IdleRssKiB, null);

  const tooMany = evaluateStartupSamples(Array.from({ length: 21 }, () => pass()));
  assert.equal(tooMany.status, 'FAIL');
  assert(tooMany.failures.includes('RUN_COUNT_INVALID'));
});

test('evaluateStartupSamples rejects NOT_RUN and failed runs using the full denominator', () => {
  const notRun = Array.from({ length: 20 }, () => pass());
  notRun[3] = { status: 'NOT_RUN', readyMs: null, idlePeakRssKiB: null, cleanupConfirmed: false, samplingComplete: false };
  const a = evaluateStartupSamples(notRun);
  assert.equal(a.completedRuns, 19); assert.equal(a.unexecutedRuns, 1); assert.equal(a.p95ReadyMs, null);

  const failed = Array.from({ length: 20 }, () => pass());
  failed[5] = { status: 'FAIL', readyMs: 100, idlePeakRssKiB: 100, cleanupConfirmed: true, samplingComplete: true };
  const b = evaluateStartupSamples(failed);
  assert.equal(b.failedRuns, 1); assert.equal(b.p95ReadyMs, null);
});

test('evaluateStartupSamples rejects zero, NaN and nonfinite samples', () => {
  const cases = [
    { field: 'readyMs', value: 0 },
    { field: 'idlePeakRssKiB', value: 0 },
    { field: 'readyMs', value: NaN },
    { field: 'idlePeakRssKiB', value: Infinity },
  ];
  for (const item of cases) {
    const samples = Array.from({ length: 20 }, () => pass());
    samples[0] = { ...samples[0], [item.field]: item.value };
    const result = evaluateStartupSamples(samples);
    assert.equal(result.status, 'FAIL');
    assert.equal(result.p95ReadyMs, null);
    assert.equal(result.p95IdleRssKiB, null);
  }
});

test('evaluateStartupSamples rejects missing cleanup or incomplete sampling', () => {
  const cleanup = Array.from({ length: 20 }, () => pass());
  cleanup[0] = { ...cleanup[0], cleanupConfirmed: false };
  assert(evaluateStartupSamples(cleanup).failures.includes('CLEANUP_UNCONFIRMED'));

  const sampling = Array.from({ length: 20 }, () => pass());
  sampling[0] = { ...sampling[0], samplingComplete: false };
  assert(evaluateStartupSamples(sampling).failures.includes('SAMPLING_INCOMPLETE'));
});

test('evaluateStartupSamples preserves p95 values when SLOs are exceeded', () => {
  const samples = Array.from({ length: 20 }, () => pass(100, 100));
  samples[18] = pass(11000, 1600000);
  samples[19] = pass(12000, 1700000);
  const result = evaluateStartupSamples(samples);
  assert.equal(result.status, 'FAIL');
  assert.equal(result.p95ReadyMs, 11000);
  assert.equal(result.p95IdleRssKiB, 1600000);
  assert(result.failures.includes('READY_SLO_EXCEEDED'));
  assert(result.failures.includes('RSS_SLO_EXCEEDED'));
});

test('a single idle memory ceiling violation fails even when its p95 is below the limit', () => {
  const samples = Array.from({ length: 20 }, () => pass(100, 100));
  samples[19] = pass(100, 1572865);
  const result = evaluateStartupSamples(samples);
  assert.equal(result.status, 'FAIL'); assert.equal(result.p95IdleRssKiB, 100);
  assert.equal(result.maxIdleRssKiB, 1572865);
  assert(result.failures.includes('RSS_SLO_EXCEEDED'));
});
