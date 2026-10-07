'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { execFile } = require('node:child_process');
const { ownerTreeBytes, sampleOwnerTree, startOwnerMemoryReporter, WATCH_MS, IDLE_MS } = require('../src/owner-memory.cjs');

test('ps output is summed over the owner tree only', () => {
  const ps = `
      1     0   9000
     50     1    200
     51    50    300
     52    51    400
     60     1   5000
     61    60   7000
  `;
  assert.equal(ownerTreeBytes(ps, 50), (200 + 300 + 400) * 1024);
  assert.equal(ownerTreeBytes(ps, 61), 7000 * 1024);
  assert.equal(ownerTreeBytes(ps, 99), null);
  assert.equal(ownerTreeBytes('garbage line\n', 1), null);
  assert.equal(ownerTreeBytes('1 0 -5\n', 1), null);
  // A self-parented entry is counted once.
  assert.equal(ownerTreeBytes('7 7 10\n', 7), 10 * 1024);
});

test('the real process tree of this process is measurable', { skip: process.platform === 'win32' }, async () => {
  const own = await sampleOwnerTree(execFile, process.pid);
  assert.ok(own > 16 * 1024 * 1024, `owner tree ${own}`);
});

test('a failed or truncated ps yields no sample', async () => {
  const failing = (file, args, options, callback) => queueMicrotask(() => callback(new Error('maxBuffer exceeded'), '1 0 1\n'));
  assert.equal(await sampleOwnerTree(failing, 1), null);
});

function fakeTimers() {
  const timers = new Set();
  return {
    timers,
    setTimeout: (fn, delay) => { const timer = { fn, delay }; timers.add(timer); return timer; },
    clearTimeout: timer => timers.delete(timer),
    async fire() {
      const [timer] = timers; timers.delete(timer); await timer.fn(); return timer.delay;
    },
  };
}

test('the reporter samples fast only while the backend watches a run and stops cleanly', async () => {
  const clock = fakeTimers(); const reports = []; const answers = [true, false]; let ready = true; let runs = 0;
  const ps = (file, args, options, callback) => { runs++; queueMicrotask(() => callback(null, '10 1 4\n11 10 6\n')); };
  const reporter = startOwnerMemoryReporter({ root: 10, execFile: ps, active: () => ready,
    report: async bytes => { reports.push(bytes); return answers.shift(); }, setTimeout: clock.setTimeout, clearTimeout: clock.clearTimeout });
  assert.equal(await clock.fire(), 0);
  assert.deepEqual(reports, [10 * 1024]);
  assert.equal([...clock.timers][0].delay, WATCH_MS);
  await clock.fire();
  assert.equal([...clock.timers][0].delay, IDLE_MS);
  ready = false;
  await clock.fire();
  assert.equal(runs, 2); assert.equal(reports.length, 2);
  ready = true;
  // A failed report is skipped until the next idle report.
  const failing = startOwnerMemoryReporter({ root: 10, execFile: ps, active: () => true,
    report: async () => { throw new Error('backend unavailable'); }, setTimeout: clock.setTimeout, clearTimeout: clock.clearTimeout });
  reporter.stop();
  assert.equal(await clock.fire(), 0);
  assert.equal([...clock.timers][0].delay, IDLE_MS);
  failing.stop();
  assert.equal(clock.timers.size, 0);
});
