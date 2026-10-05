'use strict';
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const test = require('node:test');
const { trackManagedProcess, closeInOrder } = require('./fixtures/owned-runtime-lifecycle.cjs');

test('failed startup keeps the actual owner handle before diagnostic reporting', async () => {
  let resolve;
  const child = Object.assign(new EventEmitter(), { pid: undefined, helperPid: 123,
    kill() {}, termination: new Promise(done => { resolve = done; }) });
  const records = new Set();
  const value = trackManagedProcess(child, 'startup-failed', records, () => { throw new Error('report failed'); });
  assert(records.has(value)); assert.equal(value.child, child); assert.equal(value.stopped, false);
  child.emit('error', new Error('synthetic protocol failure'));
  resolve({ stopped: true, exitCode: 2, signalCode: null }); await value.done;
  assert.equal(value.stopped, true); assert.equal(value.code, 2); assert.equal(value.error, true);
});

test('an unproved guardian termination never becomes stopped', async () => {
  const child = Object.assign(new EventEmitter(), { kill() {}, termination: Promise.reject(new Error('unknown termination')) });
  const value = trackManagedProcess(child, 'failed', new Set()); await value.done;
  assert.equal(value.stopped, false); assert.equal(value.error, true);
});

for (const failure of ['writers', 'sources', 'runtime', 'safety', 'transport', null]) {
  test(`cleanup barrier ${failure || 'none'} preserves the correct ownership order`, async () => {
    const calls = [], stage = name => async () => { calls.push(name); if (name === failure) throw new Error('synthetic'); };
    const result = await closeInOrder({ writers: [{}, {}], stop: stage('writers'),
      closeSources: stage('sources'), closeRuntime: stage('runtime'), closeSafety: stage('safety'), closeTransport: stage('transport') });
    const order = ['writers', 'writers', 'sources', 'runtime', 'safety', 'transport'];
    assert.equal(result.safe, failure === null);
    assert.deepEqual(calls, failure === null ? order : order.slice(0, failure === 'writers' ? 2 : order.indexOf(failure) + 1));
  });
}
