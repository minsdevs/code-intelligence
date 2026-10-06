'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { argumentsFor, startMemorySampler, parsePowerSource, acObservedAtRunBoundaries } = require('../run-startup-benchmark.cjs');

function output(t) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'startup-sampler-test-')));
  const file = path.join(root, 'samples.csv'), fd = fs.openSync(file, 'wx', 0o600);
  t.after(() => { fs.closeSync(fd); fs.rmSync(root, { recursive: true, force: true }); });
  return { file, fd };
}
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
const settle = () => new Promise(resolve => setImmediate(resolve));

test('startup measurement requires its fixed twenty-run opt-in and an absolute bundle', () => {
  assert.deepEqual(argumentsFor(['--app', '/synthetic/Validation.app', '--warm-startup-20']), { app: '/synthetic/Validation.app' });
  for (const argv of [[], ['--app', '/synthetic/Validation.app'], ['--app', 'relative', '--warm-startup-20'],
    ['--app', '/app\n', '--warm-startup-20'], ['--app', '/app', '--warm-startup-1'],
    ['--app', '/app', '--warm-startup-20', '--ignore-failure']]) assert.throws(() => argumentsFor(argv));
});

test('power observation rejects ambiguous/unknown values and checks every run boundary', () => {
  assert.equal(parsePowerSource("Now drawing from 'AC Power'\n -InternalBattery-0\t80%; charging;"), 'AC');
  assert.equal(parsePowerSource("Now drawing from 'Battery Power'\n -InternalBattery-0\t80%; discharging;"), 'BATTERY');
  for (const value of ['', "Now drawing from 'AC Power'\nNow drawing from 'Battery Power'", 'x'.repeat(8193), null]) {
    assert.equal(parsePowerSource(value), 'UNKNOWN');
  }
  const passed = { powerAtStart: 'AC', powerAtEnd: 'AC' };
  assert.equal(acObservedAtRunBoundaries('AC', [passed, passed]), true);
  for (const rows of [[], [null], [passed, { ...passed, powerAtEnd: 'BATTERY' }],
    [passed, { ...passed, powerAtStart: 'UNKNOWN' }], [passed, { status: 'NOT_RUN' }]]) {
    assert.equal(acObservedAtRunBoundaries('AC', rows), false);
  }
  assert.equal(acObservedAtRunBoundaries('BATTERY', [passed]), false);
});

test('sampler only sums the captured owner tree and keeps idle peaks distinct', async t => {
  const out = output(t); let now = 40, calls = 0;
  const first = deferred(), second = deferred();
  const sampler = startMemorySampler({ pid: 10 }, out.fd, 2, 20, { intervalMs: 1, now: () => now,
    read: () => { calls++; return calls === 1 ? first.promise : second.promise; } });
  first.resolve([{ pid: 10, ppid: 1, rssKiB: 20 }, { pid: 11, ppid: 10, rssKiB: 30 }, { pid: 99, ppid: 1, rssKiB: 900 }]);
  await settle(); sampler.idle(); now = 50;
  second.resolve([{ pid: 10, ppid: 1, rssKiB: 21 }, { pid: 11, ppid: 10, rssKiB: 35 }]);
  await new Promise(resolve => setTimeout(resolve, 5));
  const result = await sampler.stop();
  assert.equal(result.failure, null); assert.equal(result.firstSampleDelayMs, 20);
  assert.equal(result.peakRssKiB, 56); assert.equal(result.idlePeakRssKiB, 56);
  assert(result.idleSamples >= 1); assert.deepEqual(result.observedPids, [10, 11]);
  assert.doesNotMatch(fs.readFileSync(out.file, 'utf8'), /,99,/);
  const stoppedAt = calls; await settle(); assert.equal(calls, stoppedAt);
});

test('stop joins a pending read without overlapping or writing after stop', async t => {
  const out = output(t), pending = deferred(); let reads = 0;
  const sampler = startMemorySampler({ pid: 10 }, out.fd, 1, 0, {
    read: () => { reads++; return pending.promise; }, intervalMs: 1, now: () => 10 });
  const stopped = sampler.stop();
  pending.resolve([{ pid: 10, ppid: 1, rssKiB: 20 }]);
  const result = await stopped;
  assert.equal(reads, 1); assert.equal(result.samples, 0);
  assert.equal(fs.readFileSync(out.file, 'utf8'), '');
});

test('a stalled final read remains an unobserved gap and repeated stop keeps the same measurement boundary', async t => {
  const out = output(t), pending = deferred(), entered = deferred();
  let now = 0, reads = 0;
  const rows = [{ pid: 10, ppid: 1, rssKiB: 20 }];
  const sampler = startMemorySampler({ pid: 10 }, out.fd, 1, 0, {
    intervalMs: 1, now: () => now,
    read: () => {
      if (++reads === 1) return Promise.resolve(rows);
      entered.resolve();
      return pending.promise;
    },
  });
  await entered.promise;
  now = 400;
  const stopped = sampler.stop();
  pending.resolve(rows);
  const result = await stopped;
  assert.equal(result.samples, 1);
  assert.equal(result.trailingGapMs, 400);
  assert.equal(result.maximumGapMs, 400);
  assert(result.maximumGapMs > 250);
  now = 2000;
  assert.equal((await sampler.stop()).trailingGapMs, 400);
  assert.equal(fs.readFileSync(out.file, 'utf8').trim().split('\n').length, 1);
});

for (const kind of ['absent', 'zero', 'exception']) test(`invalid memory observation ${kind} is retained as failure`, async t => {
  const out = output(t);
  const sampler = startMemorySampler({ pid: 10 }, out.fd, 1, 0, { now: () => 10,
    read: async () => {
      if (kind === 'exception') throw new Error('private-sentinel');
      return kind === 'absent' ? [{ pid: 99, ppid: 1, rssKiB: 100 }] : [{ pid: 10, ppid: 1, rssKiB: 0 }];
    } });
  await settle();
  const result = await sampler.stop();
  assert.equal(result.failure, 'MEMORY_SAMPLE_FAILED'); assert.equal(result.samples, 0);
  assert.doesNotMatch(JSON.stringify(result), /private-sentinel/);
  assert.equal(fs.readFileSync(out.file, 'utf8'), '');
});

test('resource CSV limit refuses the whole oversized batch before writing', async t => {
  const out = output(t); fs.writeSync(out.fd, 'preserved\n');
  const sampler = startMemorySampler({ pid: 10 }, out.fd, 1, 0, { now: () => 10, maxCsvBytes: 16,
    read: async () => [{ pid: 10, ppid: 1, rssKiB: 100 }] });
  await settle(); const result = await sampler.stop();
  assert.equal(result.failure, 'MEMORY_EVIDENCE_LIMIT'); assert.equal(result.samples, 0);
  assert.equal(fs.readFileSync(out.file, 'utf8'), 'preserved\n');
});

test('sampler count limit ends collection without a hot infinite write loop', async t => {
  const out = output(t);
  const sampler = startMemorySampler({ pid: 10 }, out.fd, 1, 0, { now: () => 10, intervalMs: 1, maxSamples: 1,
    read: async () => [{ pid: 10, ppid: 1, rssKiB: 100 }] });
  await new Promise(resolve => setTimeout(resolve, 10));
  const result = await sampler.stop();
  assert.equal(result.failure, 'MEMORY_EVIDENCE_LIMIT'); assert.equal(result.samples, 1);
  assert.equal(fs.readFileSync(out.file, 'utf8').trim().split('\n').length, 1);
});
