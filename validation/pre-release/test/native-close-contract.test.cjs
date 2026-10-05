'use strict';
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const test = require('node:test');
const { PassThrough } = require('node:stream');
const { closeOwnedApplication, closeValidatedApplication, observeStartup } = require('../../../desktop/scripts/native-acceptance-electron.cjs');

function fixture(close) {
  const signals = [], child = Object.assign(new EventEmitter(), {
    exitCode: null, signalCode: null,
    kill(signal) { signals.push(signal); },
  });
  const exit = (code, signal = null) => { child.exitCode = code; child.signalCode = signal; child.emit('exit', code, signal); };
  return { child, signals, exit, app: { process: () => child, close: () => close(exit) } };
}

test('direct Electron close observes a natural exit0 without sending a signal', async () => {
  const f = fixture(exit => { exit(0); return Promise.resolve(); });
  await closeOwnedApplication(f.app, { timeoutMs: 50, killGraceMs: 1 });
  assert.deepEqual(f.signals, []); assert.equal(f.child.listenerCount('exit'), 0);
});

test('an already exited owned child is accepted when its SDK close completes', async () => {
  const f = fixture(() => Promise.resolve()); f.exit(0);
  await closeOwnedApplication(f.app, { timeoutMs: 50, killGraceMs: 1 });
  assert.deepEqual(f.signals, []); assert.equal(f.child.listenerCount('exit'), 0);
});

test('a close timeout remains a failure even if the direct child has exited0', async () => {
  const f = fixture(exit => { exit(0); return new Promise(() => {}); });
  await assert.rejects(closeOwnedApplication(f.app, { timeoutMs: 5, killGraceMs: 1 }), /NATIVE_ELECTRON_CLOSE_TIMEOUT/);
  assert.deepEqual(f.signals, []); assert.equal(f.child.listenerCount('exit'), 0);
});

for (const [code, signal] of [[9, null], [null, 'SIGTERM']]) {
  test(`non-clean direct exit ${code}/${signal} cannot pass or trigger adoption of another process`, async () => {
    const f = fixture(exit => { exit(code, signal); return Promise.resolve(); });
    await assert.rejects(closeOwnedApplication(f.app, { timeoutMs: 50, killGraceMs: 1 }), /NATIVE_ELECTRON_UNCLEAN_EXIT/);
    assert.deepEqual(f.signals, []); assert.equal(f.child.listenerCount('exit'), 0);
  });
}

test('an unconfirmed stop escalates only its captured child and retains the original close timeout', async () => {
  const f = fixture(() => new Promise(() => {}));
  await assert.rejects(closeOwnedApplication(f.app, { timeoutMs: 5, killGraceMs: 1 }), /NATIVE_ELECTRON_CLOSE_TIMEOUT/);
  assert.deepEqual(f.signals, ['SIGTERM', 'SIGKILL']);
  assert.equal(f.child.exitCode, null); assert.equal(f.child.signalCode, null);
  assert.equal(f.child.listenerCount('exit'), 0);
});

test('synchronous signal failure cannot replace the original SDK close error', async () => {
  const primary = new Error('synthetic close failure');
  const f = fixture(() => Promise.reject(primary));
  f.child.kill = signal => { f.signals.push(signal); throw new Error('synthetic signal failure'); };
  await assert.rejects(closeOwnedApplication(f.app, { timeoutMs: 50, killGraceMs: 1 }), error => error === primary);
  assert.deepEqual(f.signals, ['SIGTERM', 'SIGKILL']); assert.equal(f.child.listenerCount('exit'), 0);
});

function observedFixture(t, close) {
  const f = fixture(exit => close(exit, f.child.stderr));
  f.child.stderr = new PassThrough();
  f.report = { phase: 'native-clean-shutdown' };
  const stop = observeStartup(f.child, f.report, () => {}, () => 1);
  t.after(() => { stop(); f.child.stderr.destroy(); });
  return f;
}

test('validated close drains a late completion diagnostic after direct exit0', async t => {
  const f = observedFixture(t, (exit, stream) => {
    exit(0); setImmediate(() => stream.end('DESKTOP_SHUTDOWN COMPLETE\n'));
  });
  await closeValidatedApplication(f.app, f.report);
  assert.equal(f.report.shutdown.state, 'COMPLETE');
  assert.equal(f.child.stderr.readableEnded, true);
  assert.equal(f.child.stderr.listenerCount('end'), 0);
  assert.deepEqual(f.signals, []);
});

for (const late of [false, true]) test(`cleanup FAILED cannot pass exit0 even with a COMPLETE record (late=${late})`, async t => {
  const f = observedFixture(t, (exit, stream) => {
    if (late) {
      stream.write('DESKTOP_SHUTDOWN COMPLETE\n');
      exit(0);
      setImmediate(() => stream.end('DESKTOP_SHUTDOWN STORAGE FAILED SAFETY_RECOVERY_REQUIRED\n'));
    } else {
      stream.end('DESKTOP_SHUTDOWN STORAGE FAILED SAFETY_RECOVERY_REQUIRED\nDESKTOP_SHUTDOWN COMPLETE\n');
      exit(0);
    }
  });
  await assert.rejects(closeValidatedApplication(f.app, f.report), error => {
    assert.equal(error.message, 'NATIVE_SHUTDOWN_RECOVERY_REQUIRED');
    const { recordFailure } = require('../../../desktop/scripts/native-acceptance.cjs');
    assert.equal(recordFailure(f.report, error).code, 'NATIVE_SHUTDOWN_RECOVERY_REQUIRED');
    return true;
  });
  assert.equal(f.child.exitCode, 0); assert.equal(f.report.status, 'FAIL');
  assert.equal(f.report.shutdown.state, 'FAILED'); assert.deepEqual(f.signals, []);
});

test('a legacy or incomplete diagnostic stream is unconfirmed rather than a cleanup failure or PASS', async t => {
  const f = observedFixture(t, (exit, stream) => { stream.end('DESKTOP_SHUTDOWN BACKEND\n'); exit(0); });
  await assert.rejects(closeValidatedApplication(f.app, f.report), /NATIVE_SHUTDOWN_UNCONFIRMED/);
  assert.equal(f.report.shutdown.state, 'RUNNING'); assert.deepEqual(f.signals, []);
});

test('an open diagnostic pipe times out without assuming all cleanup output was received', async t => {
  const f = observedFixture(t, (exit, stream) => { stream.write('DESKTOP_SHUTDOWN COMPLETE\n'); exit(0); });
  await assert.rejects(closeValidatedApplication(f.app, f.report, { diagnosticTimeoutMs: 1 }), /NATIVE_SHUTDOWN_DIAGNOSTIC_TIMEOUT/);
  for (const name of ['end', 'close', 'error']) assert.equal(f.child.stderr.listenerCount(name), 0);
  assert.deepEqual(f.signals, []);
});

test('a destroyed diagnostic pipe cannot validate a possibly truncated COMPLETE record', async t => {
  const f = observedFixture(t, (exit, stream) => { stream.write('DESKTOP_SHUTDOWN COMPLETE\n'); stream.destroy(); exit(0); });
  await assert.rejects(closeValidatedApplication(f.app, f.report), /NATIVE_SHUTDOWN_UNCONFIRMED/);
  assert.deepEqual(f.signals, []);
});

test('an SDK failure stays primary even when cleanup diagnostics also report failure', async t => {
  const primary = new Error('SDK_CLOSE_FAILED');
  const f = observedFixture(t, (exit, stream) => {
    stream.end('DESKTOP_SHUTDOWN STORAGE FAILED SAFETY_RECOVERY_REQUIRED\n');
    exit(0); return Promise.reject(primary);
  });
  await assert.rejects(closeValidatedApplication(f.app, f.report), error => error === primary);
  assert.deepEqual(f.signals, []);
});
