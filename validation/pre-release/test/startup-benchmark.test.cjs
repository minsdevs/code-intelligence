'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { argumentsFor, startMemorySampler } = require('../run-startup-benchmark.cjs');

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
