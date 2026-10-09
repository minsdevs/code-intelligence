'use strict';
const assert = require('node:assert/strict');
const test = require('node:test');
const vm = require('node:vm');
const { installWorkloadWatch, installWorkloadClick, describeSmoke, evaluateRow } = require('../workload-metrics.cjs');

function renderer(texts) {
  let now = 100, callback, click, disconnected = false;
  const buttons = texts.map(textContent => ({ textContent }));
  const window = { __workload: { marks: {} } };
  const context = vm.createContext({ window, performance: { now: () => now, timeOrigin: 900000 },
    document: { querySelectorAll: () => buttons, addEventListener: (event, fn) => { assert.equal(event, 'click'); click = fn; } },
    MutationObserver: class {
      constructor(fn) { callback = fn; }
      observe() {}
      disconnect() { disconnected = true; }
    } });
  const watch = options => vm.runInContext(`(${installWorkloadWatch.toString()})`, context)(options);
  vm.runInContext(`(${installWorkloadClick.toString()})("click")`, context);
  return { window, buttons, watch, click: () => click(), at(value) { now = value; }, mutate() { if (!disconnected) callback(); } };
}

test('empty icon buttons cannot acknowledge cancellation before the action', () => {
  const r = renderer(['', 'Cancel analysis']);
  r.watch({ name: 'ack', condition: { kind: 'button', text: 'Cancelling…', after: 'click' } });
  assert.equal(r.window.__workload.marks.ack, undefined);
  r.at(121); r.click();
  r.buttons[1].textContent = 'Cancelling…'; r.at(124); r.mutate();
  assert.equal(r.window.__workload.marks.ack - r.window.__workload.marks.click, 3);
});

test('a pre-action UI state cannot supply the acknowledgement origin', () => {
  const r = renderer(['Inspecting…']);
  r.watch({ name: 'ack', condition: { kind: 'button', text: ['Inspecting…'], after: 'click' } });
  assert.equal(r.window.__workload.marks.ack, undefined);
  r.at(130); r.click(); r.mutate();
  assert.equal(r.window.__workload.marks.ack, 130);
});

test('renderer clock remains independent of host and wall clock origins', () => {
  const r = renderer(['Cancel analysis']);
  r.watch({ name: 'ack', condition: { kind: 'button', text: ['Cancelling…'], after: 'click' } });
  const hostActionTime = 140;
  r.at(110); r.click();
  r.buttons[0].textContent = 'Cancelling…'; r.at(119); r.mutate();
  assert.equal(r.window.__workload.marks.ack - hostActionTime, -21);
  assert.equal(r.window.__workload.marks.ack - r.window.__workload.marks.click, 9);
});

test('negative historic acknowledgements remain invalid and unchanged in smoke and series', () => {
  const sample = { sequence: 1, status: 'PASS', cleanupConfirmed: true, metrics: { cancelUiAckMs: -21, cancelReleaseMs: 100 } };
  const smoke = describeSmoke('cancel.medium', [sample]);
  assert.equal(smoke.observations[0].values.cancelUiAckMs.withinLimit, false);
  assert.deepEqual(smoke.observations[0].values.cancelUiAckMs.values, [-21]);
  assert.equal(evaluateRow('cancel.medium', [sample], { expectedRuns: 1 }).status, 'FAIL');
  assert.equal(sample.metrics.cancelUiAckMs, -21);
});
