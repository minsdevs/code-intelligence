'use strict';
const assert = require('node:assert/strict');
const test = require('node:test');
const { EventEmitter } = require('node:events');
const { launchArguments, launchEnvironment, bounded, waitFor, closePackagedApplication,
  allProcessesExitedZero } = require('../scripts/packaged-keychain-acceptance.cjs');

test('direct packaged launch cannot inherit provider secrets, Electron loader or mock-keychain hooks', () => {
  const original = { HOME: '/owned/home', USER: 'fixture', LANG: 'en_US.UTF-8', PATH: '/unreviewed',
    NODE_OPTIONS: '--require injected.cjs', NODE_PATH: '/injected', ELECTRON_RUN_AS_NODE: '1',
    ELECTRON_EXTRA_LAUNCH_ARGS: '--use-mock-keychain', DYLD_INSERT_LIBRARIES: '/injected',
    GH_TOKEN: 'synthetic', OPENAI_API_KEY: 'synthetic', PGVECTOR_ROOT: '/old-extension' };
  const env = launchEnvironment(original);
  assert.deepEqual(Object.keys(env).sort(), ['HOME', 'LANG', 'LC_ALL', 'PATH', 'USER']);
  assert.equal(env.HOME, original.HOME); assert.equal(env.LC_ALL, 'C');
  assert.equal(env.PATH, '/usr/bin:/bin:/usr/sbin:/sbin');
  assert.equal(original.NODE_OPTIONS, '--require injected.cjs');
});

test('direct packaged arguments bind the generated claim and a loopback-only debugging port', () => {
  assert.deepEqual(launchArguments('/private/tmp/owned/.isolated-run.json', 41234), [
    '--isolated-run-claim=/private/tmp/owned/.isolated-run.json',
    '--remote-debugging-address=127.0.0.1', '--remote-debugging-port=41234',
  ]);
  for (const port of [0, 1024, 65536, 41234.5, '41234'])
    assert.throws(() => launchArguments('/private/tmp/owned/.isolated-run.json', port));
  for (const file of ['relative', '/private/tmp/claim\n--use-mock-keychain', '/private/tmp/claim\0'])
    assert.throws(() => launchArguments(file, 41234));
});

// In-memory process and CDP doubles only. No executable, profile, key or bundle is opened.
function fakeChild(pid = 43201) {
  const child = new EventEmitter();
  child.pid = pid; child.exitCode = null; child.signalCode = null; child.signals = [];
  child.finish = (code, signal = null) => {
    child.exitCode = code; child.signalCode = signal; child.emit('exit', code, signal);
  };
  child.kill = signal => { child.signals.push(signal); return false; };
  return child;
}
const limits = { requestTimeoutMs: 5, normalExitTimeoutMs: 10, killGraceMs: 5 };
const pending = () => new Promise(() => {});

test('a pending CDP operation and a pending polling action have external deadlines', { timeout: 1000 }, async () => {
  await assert.rejects(bounded(pending, 5, 'CDP_TIMEOUT'), /CDP_TIMEOUT/);
  await assert.rejects(waitFor(pending, 5, 'POLL_TIMEOUT'), /POLL_TIMEOUT/);
});

test('normal window close records only observed exit zero and sends no process signal', { timeout: 1000 }, async () => {
  const child = fakeChild(); let disconnects = 0;
  const result = await closePackagedApplication({ child, closeWindow: async () => child.finish(0),
    quitApplication: () => assert.fail('OS fallback must not run'), disconnect: async () => { disconnects++; } }, limits);
  assert.equal(result.pid, child.pid); assert.equal(result.normalWindowCloseRequested, true);
  assert.equal(result.normalApplicationQuitRequested, false); assert.equal(result.terminationConfirmed, true);
  assert.equal(result.processExitedZero, true); assert.equal(result.disconnected, true);
  assert.deepEqual(result.errors, []); assert.deepEqual(child.signals, []); assert.equal(disconnects, 1);
  assert.equal(child.listenerCount('exit'), 0); assert.equal(Object.hasOwn(result, 'cleanExit'), false);
});

test('before CDP attachment, the owned application quit request still awaits actual exit', { timeout: 1000 }, async () => {
  const child = fakeChild(); let requests = 0;
  const result = await closePackagedApplication({ child,
    quitApplication: async () => { requests++; child.finish(0); } }, limits);
  assert.equal(requests, 1); assert.equal(result.normalWindowCloseRequested, false);
  assert.equal(result.normalApplicationQuitRequested, true); assert.equal(result.processExitedZero, true);
  assert.deepEqual(child.signals, []); assert.deepEqual(result.errors, []);
});

test('a hung window close cannot prevent PID quit fallback or hide the failed request', { timeout: 1000 }, async () => {
  const child = fakeChild();
  const result = await closePackagedApplication({ child, closeWindow: pending,
    quitApplication: async () => child.finish(0) }, limits);
  assert.equal(result.normalWindowCloseRequested, true); assert.equal(result.normalApplicationQuitRequested, true);
  assert.equal(result.terminationConfirmed, true); assert.equal(result.processExitedZero, true);
  assert(result.errors.includes('PACKAGE_WINDOW_CLOSE_TIMEOUT')); assert.deepEqual(child.signals, []);
});

test('ignored SIGTERM escalates to SIGKILL and waits for its exit event', { timeout: 1000 }, async () => {
  const child = fakeChild();
  child.kill = signal => {
    child.signals.push(signal);
    if (signal === 'SIGKILL') queueMicrotask(() => child.finish(null, signal));
    return true;
  };
  const result = await closePackagedApplication({ child, quitApplication: async () => {} }, limits);
  assert.deepEqual(child.signals, ['SIGTERM', 'SIGKILL']); assert.deepEqual(result.signalsRequested, child.signals);
  assert.equal(result.terminationConfirmed, true); assert.equal(result.signalCode, 'SIGKILL');
  assert.equal(result.processExitedZero, false); assert(result.errors.length > 0);
  assert.equal(child.listenerCount('exit'), 0);
});

test('a synchronous SIGTERM failure still permits owned SIGKILL and exit confirmation', { timeout: 1000 }, async () => {
  const child = fakeChild();
  child.kill = signal => {
    child.signals.push(signal);
    if (signal === 'SIGTERM') throw new Error('synthetic signal failure');
    queueMicrotask(() => child.finish(null, signal)); return true;
  };
  const result = await closePackagedApplication({ child, quitApplication: async () => {} }, limits);
  assert.deepEqual(child.signals, ['SIGTERM', 'SIGKILL']); assert.equal(result.terminationConfirmed, true);
  assert.equal(result.processExitedZero, false); assert(result.errors.length > 0);
});

test('signals without exit evidence leave termination explicitly unconfirmed', { timeout: 1000 }, async () => {
  const child = fakeChild();
  const result = await closePackagedApplication({ child, quitApplication: async () => {} }, limits);
  assert.deepEqual(result.signalsRequested, ['SIGTERM', 'SIGKILL']);
  assert.equal(result.terminationConfirmed, false); assert.equal(result.processExitedZero, false);
  assert.equal(result.exitCode, null); assert.equal(result.signalCode, null); assert(result.errors.length > 0);
  assert.equal(child.listenerCount('exit'), 0);
});

test('a failed spawn never signals an undefined PID or reports process exit zero', { timeout: 1000 }, async () => {
  const child = fakeChild(); child.pid = undefined; child.exitCode = -2;
  const result = await closePackagedApplication({ child,
    quitApplication: () => assert.fail('No process was spawned') }, limits);
  assert.equal(result.pid, null); assert.equal(result.processExitedZero, false);
  assert.equal(result.terminationConfirmed, false); assert.deepEqual(child.signals, []);
  assert.deepEqual(result.errors, ['PACKAGE_NOT_SPAWNED']);
});

test('a hung CDP disconnect is bounded after the owned process has already stopped', { timeout: 1000 }, async () => {
  const child = fakeChild();
  const result = await closePackagedApplication({ child, closeWindow: async () => child.finish(0), disconnect: pending }, limits);
  assert.equal(result.terminationConfirmed, true); assert.equal(result.processExitedZero, true);
  assert.equal(result.disconnected, false); assert(result.errors.includes('PACKAGE_CDP_DISCONNECT_TIMEOUT'));
  assert.deepEqual(child.signals, []);
});

test('the second nonzero process exit remains visible to aggregate reporting', { timeout: 1000 }, async () => {
  const first = fakeChild(43201), second = fakeChild(43202);
  first.finish(0); second.finish(1);
  const firstResult = { ...await closePackagedApplication({ child: first }, limits), launch: 1 };
  const secondResult = { ...await closePackagedApplication({ child: second }, limits), launch: 2 };
  const launches = [{ sequence: 1, pid: first.pid }, { sequence: 2, pid: second.pid }];
  assert.equal(secondResult.pid, second.pid); assert.equal(secondResult.exitCode, 1);
  assert.equal(secondResult.terminationConfirmed, true); assert.equal(secondResult.processExitedZero, false);
  assert.equal(allProcessesExitedZero(launches, [firstResult, secondResult]), false);
  assert.equal(allProcessesExitedZero(launches, [firstResult]), false);
  assert.equal(allProcessesExitedZero([], []), false);
  assert.equal(allProcessesExitedZero([launches[0]], [firstResult]), true);
  assert.equal(allProcessesExitedZero([launches[0]], [{ ...firstResult, pid: 99999 }]), false);
});
