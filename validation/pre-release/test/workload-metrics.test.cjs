'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { SLO, percentile95, evaluateRow, describeSmoke, startPhaseSampler, phaseSamplingComplete } = require('../workload-metrics.cjs');
const { argumentsFor, instantMs, jobTimings } = require('../run-workload-benchmark.cjs');

const pass = (sequence, metrics, extra = {}) => ({ sequence, status: 'PASS', metrics, peakRssKiB: 1000000,
  samplingComplete: true, cleanupConfirmed: true, ...extra });
const series = (count, metrics, extra) => Array.from({ length: count }, (_, index) => pass(index + 1, metrics(index), extra));

test('limits are the unchanged section-4 values', () => {
  assert.deepEqual(SLO['analysis.small'].p95, { analysisMs: 30000 }); assert.equal(SLO['analysis.small'].rssKiB, 3 * 1024 * 1024);
  assert.deepEqual(SLO['analysis.medium'].p95, { analysisMs: 180000 }); assert.equal(SLO['analysis.medium'].rssKiB, 4 * 1024 * 1024);
  assert.deepEqual(SLO['analysis.large'].p95, { analysisMs: 600000 }); assert.equal(SLO['analysis.large'].rssKiB, 6 * 1024 * 1024);
  assert.equal(SLO['analysis.large'].hardTimeoutMs, 900000);
  assert.deepEqual(SLO['preview.medium'], { sizeClass: 'medium', p95: { previewCompleteMs: 10000 }, ceiling: { previewFirstResponseMs: 500 } });
  assert.deepEqual(SLO['incremental.medium'].p95, { refreshMs: 30000 });
  assert.deepEqual(SLO['cancel.medium'], { sizeClass: 'medium', ceiling: { cancelUiAckMs: 500, cancelReleaseMs: 10000 }, p95: { cancelReleaseMs: 5000 } });
  assert.deepEqual(SLO['graph.medium'].p95, { searchApiMs: 500, nodePageApiMs: 500, relationsApiMs: 500 });
  assert.deepEqual(SLO['graph.medium'].ceiling, { firstPageRenderMs: 2000 });
  assert(Object.isFrozen(SLO) && Object.isFrozen(SLO['analysis.small']));
});

test('p95 is the value at rank ceil(0.95n) and a failed sample ranks above every value', () => {
  assert.equal(percentile95(Array.from({ length: 20 }, (_, i) => i + 1)), 19);
  assert.equal(percentile95([5]), 5);
  assert.equal(percentile95([1, 2, 3, Infinity]), Infinity);
  const nineteen = [...Array.from({ length: 19 }, (_, i) => i + 1), Infinity];
  assert.equal(percentile95(nineteen), 19);
  assert.throws(() => percentile95([]), /PERCENTILE_INPUT_INVALID/);
  assert.throws(() => percentile95([NaN]), /PERCENTILE_INPUT_INVALID/);
  assert.throws(() => percentile95([-1]), /PERCENTILE_INPUT_INVALID/);
});

test('a complete twenty-run series within limits passes', () => {
  const result = evaluateRow('analysis.small', series(20, i => ({ analysisMs: 10000 + i * 100 })));
  assert.equal(result.status, 'PASS'); assert.equal(result.p95.analysisMs, 11800); assert.deepEqual(result.failures, []);
  assert.equal(result.maxPeakRssKiB, 1000000);
});

test('failed and timed-out runs stay in the denominator and fail the series', () => {
  const samples = series(20, i => ({ analysisMs: 10000 + i }));
  samples[3] = { ...samples[3], status: 'FAIL', failure: 'ANALYSIS_TIMEOUT', metrics: { analysisMs: null } };
  const result = evaluateRow('analysis.small', samples);
  assert.equal(result.status, 'FAIL'); assert.equal(result.failedRuns, 1); assert.equal(result.executedRuns, 20);
  assert(result.failures.includes('RUN_FAILED'));
  // Computing p95 from the nineteen successes alone would be 10018; the failure keeps it at rank 19 of 20.
  assert.equal(result.p95.analysisMs, 10019);
  samples[4] = { ...samples[4], status: 'FAIL', metrics: { analysisMs: 10004 } };
  const twice = evaluateRow('analysis.small', samples);
  assert.equal(twice.p95.analysisMs, null); assert(twice.failures.includes('ANALYSISMS_P95_EXCEEDED'));
});

test('a value of a failed run is never used as a success value', () => {
  const samples = series(20, () => ({ analysisMs: 1000 }));
  samples[0] = { ...samples[0], status: 'FAIL', metrics: { analysisMs: 1 } };
  const result = evaluateRow('analysis.small', samples);
  assert.equal(result.maximum.analysisMs, null);
});

test('p95 above the limit, RSS above the ceiling and incomplete sampling fail', () => {
  const slow = evaluateRow('analysis.small', series(20, i => ({ analysisMs: i < 18 ? 1000 : 40000 })));
  assert.equal(slow.status, 'FAIL'); assert.deepEqual(slow.failures, ['ANALYSISMS_P95_EXCEEDED']);
  const oneHigh = series(20, () => ({ analysisMs: 1000 }));
  oneHigh[7] = { ...oneHigh[7], peakRssKiB: 3 * 1024 * 1024 + 1 };
  assert.deepEqual(evaluateRow('analysis.small', oneHigh).failures, ['RSS_CEILING_EXCEEDED']);
  const missing = series(20, () => ({ analysisMs: 1000 }));
  missing[2] = { ...missing[2], peakRssKiB: null };
  assert.deepEqual(evaluateRow('analysis.small', missing).failures, ['RSS_CEILING_EXCEEDED']);
  const gaps = series(20, () => ({ analysisMs: 1000 }));
  gaps[9] = { ...gaps[9], samplingComplete: false };
  assert.deepEqual(evaluateRow('analysis.small', gaps).failures, ['SAMPLING_INCOMPLETE']);
  const dirty = series(20, () => ({ analysisMs: 1000 }));
  dirty[9] = { ...dirty[9], cleanupConfirmed: false };
  assert.deepEqual(evaluateRow('analysis.small', dirty).failures, ['CLEANUP_UNCONFIRMED']);
});

test('short or oversized series and unexecuted runs cannot pass', () => {
  const short = evaluateRow('analysis.small', series(19, () => ({ analysisMs: 1000 })));
  assert.equal(short.status, 'FAIL'); assert.equal(short.unexecutedRuns, 1); assert(short.failures.includes('RUN_NOT_EXECUTED'));
  const extra = evaluateRow('analysis.small', series(21, () => ({ analysisMs: 1000 })));
  assert(extra.failures.includes('RUN_COUNT_INVALID'));
  const notRun = series(20, () => ({ analysisMs: 1000 })); notRun[19] = { sequence: 20, status: 'NOT_RUN' };
  assert.equal(evaluateRow('analysis.small', notRun).status, 'FAIL');
  assert.throws(() => evaluateRow('analysis.small', [{ status: 'SKIPPED' }]), /WORKLOAD_SAMPLES_INVALID/);
  assert.throws(() => evaluateRow('analysis.tiny', []), /WORKLOAD_ROW_INVALID/);
});

test('ceilings apply to every run while p95 rows pool repeated API calls', () => {
  const cancel = series(20, () => ({ cancelUiAckMs: 100, cancelReleaseMs: 3000 }));
  assert.equal(evaluateRow('cancel.medium', cancel).status, 'PASS');
  cancel[0] = { ...cancel[0], metrics: { cancelUiAckMs: 501, cancelReleaseMs: 3000 } };
  assert.deepEqual(evaluateRow('cancel.medium', cancel).failures, ['CANCELUIACKMS_MAXIMUM_EXCEEDED']);
  const release = series(20, i => ({ cancelUiAckMs: 100, cancelReleaseMs: i === 0 ? 9000 : 3000 }));
  assert.equal(evaluateRow('cancel.medium', release).status, 'PASS');
  release[1] = { ...release[1], metrics: { cancelUiAckMs: 100, cancelReleaseMs: 10001 } };
  assert.deepEqual(evaluateRow('cancel.medium', release).failures, ['CANCELRELEASEMS_MAXIMUM_EXCEEDED', 'CANCELRELEASEMS_P95_EXCEEDED']);
  const graph = series(20, i => ({ searchApiMs: [10, 20, 30, 40, i === 0 ? 900 : 50], nodePageApiMs: [5], relationsApiMs: [5], firstPageRenderMs: 300 }));
  const pooled = evaluateRow('graph.medium', graph);
  assert.equal(pooled.status, 'PASS'); assert.equal(pooled.p95.searchApiMs, 50); assert.equal(pooled.maximum.searchApiMs, 900);
  graph[3] = { ...graph[3], metrics: { ...graph[3].metrics, searchApiMs: [] } };
  assert.deepEqual(evaluateRow('graph.medium', graph).failures, []);
  assert.equal(evaluateRow('graph.medium', graph).maximum.searchApiMs, null);
});

test('incremental rows require confirmed full-result equality in every run', () => {
  const rows = series(20, () => ({ refreshMs: 1000 }), { checks: { resultEqualsFull: true } });
  assert.equal(evaluateRow('incremental.medium', rows).status, 'PASS');
  rows[5] = { ...rows[5], checks: { resultEqualsFull: false } };
  assert.deepEqual(evaluateRow('incremental.medium', rows).failures, ['RESULTEQUALSFULL_NOT_CONFIRMED']);
});

test('a large hard timeout is reported even beside other failures', () => {
  const rows = series(20, () => ({ analysisMs: 1000 }));
  rows[0] = { ...rows[0], status: 'FAIL', failure: 'ANALYSIS_HARD_TIMEOUT', metrics: {} };
  assert(evaluateRow('analysis.large', rows).failures.includes('HARD_TIMEOUT_REACHED'));
});

test('smoke observations are labelled and never assessed', () => {
  const result = describeSmoke('analysis.small', [pass(1, { analysisMs: 65000 }, { peakRssKiB: 2000000 })]);
  assert.equal(result.status, 'SINGLE_OBSERVATION_NOT_ASSESSED');
  assert.deepEqual(result.observations[0].values.analysisMs, { values: [65000], limitMs: 30000, withinLimit: false });
  assert.equal(result.observations[0].rssWithinLimit, true);
  const failed = describeSmoke('analysis.medium', [{ sequence: 1, status: 'FAIL', failure: 'ANALYSIS_FAILED', metrics: {} }]);
  assert.equal(failed.observations[0].values.analysisMs.withinLimit, null);
});

test('phase sampler keeps per-phase peaks, only the owner tree, and a gap rule', async t => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'workload-sampler-test-')));
  const file = path.join(root, 'samples.csv'), fd = fs.openSync(file, 'wx', 0o600);
  t.after(() => { fs.closeSync(fd); fs.rmSync(root, { recursive: true, force: true }); });
  let now = 0, reads = 0;
  const tables = [[{ pid: 10, ppid: 1, rssKiB: 100 }, { pid: 11, ppid: 10, rssKiB: 50 }, { pid: 99, ppid: 1, rssKiB: 9999 }],
    [{ pid: 10, ppid: 1, rssKiB: 300 }, { pid: 12, ppid: 10, rssKiB: 400 }]];
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  // A sample belongs to the phase that was active when its read began.
  const sampler = startPhaseSampler(10, fd, 1, 0, { intervalMs: 30, now: () => now, stopTimeoutMs: 20, read: async () => {
    reads++;
    if (reads === 1) return tables[0];
    if (reads === 2) { await gate; return tables[1]; }
    return new Promise(() => {});
  } });
  await new Promise(resolve => setImmediate(resolve));
  sampler.phase('ANALYSIS'); now = 100;
  await new Promise(resolve => setTimeout(resolve, 40));
  release();
  await new Promise(resolve => setTimeout(resolve, 40));
  now = 150;
  const memory = await sampler.stop();
  assert.equal(reads, 3);
  assert.equal(memory.samples, 2);
  assert.equal(memory.phases.STARTUP.peakRssKiB, 150); assert.equal(memory.phases.ANALYSIS.peakRssKiB, 700);
  assert.equal(memory.peakRssKiB, 700); assert.deepEqual(memory.observedPids, [10, 11, 12]);
  // The outstanding third read is a recorded sampling failure, not a hang.
  assert.equal(memory.failure, 'MEMORY_SAMPLE_FAILED');
  assert.equal(phaseSamplingComplete(memory, 'ANALYSIS'), false);
  const csv = fs.readFileSync(file, 'utf8');
  assert.doesNotMatch(csv, /,99,/); assert.match(csv, /^1,100,ANALYSIS,12,10,400$/m);
});

test('an unreadable or absent owner is a sampling failure and writes no row', async t => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'workload-sampler-test-')));
  const file = path.join(root, 'samples.csv'), fd = fs.openSync(file, 'wx', 0o600);
  t.after(() => { fs.closeSync(fd); fs.rmSync(root, { recursive: true, force: true }); });
  for (const read of [async () => { throw new Error('private-sentinel'); }, async () => [{ pid: 99, ppid: 1, rssKiB: 5 }]]) {
    const sampler = startPhaseSampler(10, fd, 1, 0, { read, now: () => 1 });
    await new Promise(resolve => setImmediate(resolve));
    const memory = await sampler.stop();
    assert.equal(memory.failure, 'MEMORY_SAMPLE_FAILED'); assert.equal(memory.samples, 0);
    assert.doesNotMatch(JSON.stringify(memory), /private-sentinel/);
  }
  assert.equal(fs.readFileSync(file, 'utf8'), '');
});

test('phase sampling completeness requires samples, no failure and bounded gaps', () => {
  const memory = { failure: null, missingOwnerSamples: 0, phases: { ANALYSIS: { samples: 10, maximumGapMs: 120 } } };
  assert.equal(phaseSamplingComplete(memory, 'ANALYSIS'), true);
  assert.equal(phaseSamplingComplete(memory, 'GRAPH'), false);
  assert.equal(phaseSamplingComplete({ ...memory, failure: 'MEMORY_SAMPLE_FAILED' }, 'ANALYSIS'), false);
  assert.equal(phaseSamplingComplete({ ...memory, phases: { ANALYSIS: { samples: 10, maximumGapMs: 251 } } }, 'ANALYSIS'), false);
});

test('runner arguments require an explicit class and mode and accept only known rows', () => {
  assert.deepEqual(argumentsFor(['--app', '/a/X.app', '--class', 'medium', '--series-20']),
    { app: '/a/X.app', sizeClass: 'medium', runs: 20, series: true, rows: ['analysis', 'graph', 'incremental', 'cancel'], keepWork: false });
  assert.deepEqual(argumentsFor(['--app', '/a/X.app', '--class', 'small', '--smoke-2', '--rows', 'cancel,analysis']).rows, ['analysis', 'cancel']);
  assert.deepEqual(argumentsFor(['--app', '/a/X.app', '--class', 'small', '--smoke-1', '--rows', 'analysis,delete', '--keep-work']),
    { app: '/a/X.app', sizeClass: 'small', runs: 1, series: false, rows: ['analysis', 'delete'], keepWork: true });
  for (const argv of [[], ['--app', 'rel', '--class', 'small', '--smoke-1'], ['--app', '/a', '--class', 'huge', '--smoke-1'],
    ['--app', '/a', '--class', 'small', '--series-5'], ['--app', '/a', '--class', 'small', '--smoke-1', '--rows', 'graph'],
    ['--app', '/a', '--class', 'small', '--smoke-1', '--rows', 'analysis,restore'], ['--app', '/a', '--class', 'small', '--smoke-1', '--ignore-failure'],
    ['--app', '/a', '--class', 'small', '--series-20', '--keep-work'],
    ['--app', '/a', '--class', 'small', '--smoke-1', '--rows', 'analysis', '--rows', 'analysis']]) {
    assert.throws(() => argumentsFor(argv));
  }
});

test('server step timings parse nanosecond instants and keep only public codes', () => {
  assert.equal(instantMs('2026-10-07T00:00:01.500000000Z') - instantMs('2026-10-07T00:00:00Z'), 1500);
  assert.equal(instantMs('not a time'), null);
  const timings = jobTimings({ status: 'FAILED', failureCode: 'path /Users/x', createdAt: '2026-10-07T00:00:00Z',
    startedAt: '2026-10-07T00:00:00.250Z', finishedAt: '2026-10-07T00:00:10.250Z',
    steps: [{ stepKey: 'TS_PARSING', status: 'FAILED', progressPct: 20, startedAt: '2026-10-07T00:00:01Z', finishedAt: '2026-10-07T00:00:03.5Z', error: '/private/source' }] });
  assert.deepEqual(timings, { status: 'FAILED', failureCode: null, queuedMs: 250, runMs: 10000,
    steps: [{ key: 'TS_PARSING', status: 'FAILED', progressPct: 20, durationMs: 2500 }] });
  assert.doesNotMatch(JSON.stringify(timings), /private|Users/);
});
