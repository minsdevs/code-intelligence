'use strict';

const assert = require('node:assert/strict');
const { EventEmitter, once } = require('node:events');
const { PassThrough } = require('node:stream');
const childProcess = require('node:child_process');
const crypto = require('node:crypto');
const fs = require('node:fs/promises');
const path = require('node:path');
const test = require('node:test');
const { createManagedProcessSpawner, MAX_BOOTSTRAP } = require('../src/managed-process.cjs');

function frame(value) {
  const bytes = Buffer.from(JSON.stringify(value)); const prefix = Buffer.alloc(4); prefix.writeUInt32BE(bytes.length);
  return Buffer.concat([prefix, bytes]);
}
function options(extra = {}) {
  return { javaPath: '/synthetic/java', jarPath: '/synthetic/app.jar', command: '/synthetic/target',
    args: [], cwd: '/synthetic/work', env: {}, logPath: '/synthetic/log.txt', ...extra };
}
function harness({ start = true, startTimeoutMs = 1000 } = {}) {
  const helper = new EventEmitter(); helper.pid = 501;
  helper.stdin = new PassThrough(); helper.stdout = new PassThrough();
  helper.kill = () => { throw new Error('The facade must never kill its guardian'); };
  const requests = []; let pending = Buffer.alloc(0), launch;
  helper.stdin.on('data', chunk => {
    pending = Buffer.concat([pending, Buffer.from(chunk)]);
    while (pending.length >= 4 && pending.length >= pending.readUInt32BE(0) + 4) {
      const length = pending.readUInt32BE(0);
      const value = JSON.parse(pending.subarray(4, length + 4)); requests.push(value);
      pending = pending.subarray(length + 4);
      if (value.kind === 'START' && start) queueMicrotask(() => helper.stdout.write(frame({ version: 1, kind: 'STARTED', pid: '502', startedAt: '2026-10-03T00:00:00Z' })));
    }
  });
  const spawn = createManagedProcessSpawner({ startTimeoutMs, spawn(command, args, settings) {
    launch = { command, args, settings }; return helper;
  } });
  return { helper, requests, spawn, get launch() { return launch; }, exit(code = 0) {
    helper.stdout.write(frame({ version: 1, kind: 'EXIT', pid: '502', exitCode: code, stopped: true }));
  }, close(code = 0, signal = null) { helper.emit('close', code, signal); } };
}

test('sends target argv/env/bootstrap only through framed stdin and transfers bootstrap ownership', async () => {
  const h = harness(); const bootstrap = Buffer.from('synthetic-private-bootstrap');
  const owner = await h.spawn(options({ args: ['synthetic-private-argument'], env: { PRIVATE: 'synthetic-private-environment' }, bootstrap }));
  assert.equal(owner.pid, 502); assert.equal(owner.helperPid, 501);
  assert.deepEqual(h.launch.args, ['-Xms16m', '-Xmx64m', '-jar', '/synthetic/app.jar', '--ci-managed-process']);
  assert.equal(h.launch.settings.env.PRIVATE, undefined);
  assert.equal(h.launch.settings.env.JAVA_TOOL_OPTIONS, undefined);
  assert.equal(h.launch.settings.env.JDK_JAVA_OPTIONS, undefined);
  assert.equal(h.requests[0].env.PRIVATE, 'synthetic-private-environment');
  assert.deepEqual(h.requests[0].args, ['synthetic-private-argument']);
  assert.equal(Buffer.from(h.requests[0].bootstrap, 'base64').toString(), 'synthetic-private-bootstrap');
  assert.ok(bootstrap.every(byte => byte === 0));
  h.exit(); h.close(); await owner.termination;
});

test('target exit requires both a cleanup acknowledgement and normal helper close', async () => {
  const h = harness(); const owner = await h.spawn(options()); const exits = [];
  owner.on('exit', (...args) => exits.push(args));
  h.exit(7);
  assert.equal(owner.exitCode, null); assert.equal(owner.stopped(), false); assert.deepEqual(exits, []);
  h.close();
  assert.deepEqual(await owner.termination, { pid: 502, exitCode: 7, signalCode: null, stopped: true });
  assert.deepEqual(exits, [[7, null]]); assert.equal(owner.exitCode, 7); assert.equal(owner.stopped(), true);
});

test('TERM and KILL are child-control commands, never signals sent to the helper', async () => {
  const h = harness(); const owner = await h.spawn(options());
  assert.equal(owner.kill('SIGTERM'), true); assert.equal(owner.kill('SIGKILL'), true);
  assert.deepEqual(h.requests.slice(1), [
    { version: 1, kind: 'STOP', signal: 'SIGTERM' }, { version: 1, kind: 'STOP', signal: 'SIGKILL' },
  ]);
  assert.equal(owner.killed, true); assert.equal(owner.exitCode, null);
  h.exit(137); h.close(); await owner.termination;
  assert.equal(owner.kill(), false);
});

test('guardian SIGKILL leaves target termination unknown and emits no false target exit', async () => {
  const h = harness(); const owner = await h.spawn(options()); let exits = 0;
  owner.on('exit', () => { exits++; }); h.close(null, 'SIGKILL');
  await assert.rejects(owner.termination, { code: 'MANAGED_PROCESS_HELPER_DIED' });
  assert.equal(owner.exitCode, null); assert.equal(owner.signalCode, null); assert.equal(owner.stopped(), false);
  assert.equal(exits, 0); assert.equal(owner.failure.code, 'MANAGED_PROCESS_HELPER_DIED');
});

for (const attack of ['wrong-pid', 'unproved', 'unknown-field', 'duplicate', 'truncated', 'helper-error-exit']) {
  test(`invalid termination protocol cannot produce stopped success: ${attack}`, async () => {
    const h = harness(); const owner = await h.spawn(options());
    const value = { version: 1, kind: 'EXIT', pid: '502', exitCode: 0, stopped: true };
    if (attack === 'wrong-pid') value.pid = '999';
    if (attack === 'unproved') value.stopped = false;
    if (attack === 'unknown-field') value.secret = 'never-copy-this-error';
    if (attack === 'duplicate') {
      const body = Buffer.from('{"version":1,"version":1,"kind":"EXIT","pid":"502","exitCode":0,"stopped":true}');
      const prefix = Buffer.alloc(4); prefix.writeUInt32BE(body.length); h.helper.stdout.write(Buffer.concat([prefix, body]));
    } else if (attack === 'truncated') h.helper.stdout.write(Buffer.from([0, 0, 1]));
    else h.helper.stdout.write(frame(value));
    h.close(attack === 'helper-error-exit' ? 2 : 0);
    await assert.rejects(owner.termination);
    assert.equal(owner.exitCode, null); assert.equal(owner.stopped(), false);
    assert.ok(!owner.failure.message.includes('never-copy-this-error'));
  });
}

test('startup timeout closes the lifetime pipe and retains an unverified owner on the error', async () => {
  const h = harness({ start: false, startTimeoutMs: 20 });
  await assert.rejects(h.spawn(options()), error => {
    assert.equal(error.code, 'MANAGED_PROCESS_START_TIMEOUT');
    assert.equal(error.managedProcess.stopped(), false); return true;
  });
  assert.equal(h.helper.stdin.writableEnded, true); h.close(2);
});

test('invalid launch requests cannot spawn and still clear the transferred bootstrap', async () => {
  let spawns = 0;
  const spawn = createManagedProcessSpawner({ spawn() { spawns++; throw new Error(); } });
  const bootstrap = Buffer.alloc(MAX_BOOTSTRAP + 1, 7);
  await assert.rejects(spawn(options({ bootstrap })), { code: 'MANAGED_PROCESS_INVALID' });
  assert.ok(bootstrap.every(byte => byte === 0));
  await assert.rejects(spawn(options({ pid: 123 })), { code: 'MANAGED_PROCESS_INVALID' });
  await assert.rejects(spawn(options({ command: 'relative' })), { code: 'MANAGED_PROCESS_INVALID' });
  let calls = 0; const guarded = options(); Object.defineProperty(guarded, 'env', { get() { calls++; return {}; } });
  await assert.rejects(spawn(guarded), { code: 'MANAGED_PROCESS_INVALID' });
  assert.equal(spawns, 0); assert.equal(calls, 0);
});

// Quarantined after static ownership review. A fresh directory and matching numeric PIDs
// do not bind a signal to the same process lifetime. In particular, killing the guardian
// removes the only owner of its targets; PID files cannot supply replacement ownership.
// CI_GUARDIAN_TEST_CONFIG must not re-enable this test. Historical evidence is unchanged.
// A replacement must retain directly created ChildProcess handles until confirmed exit,
// use the guardian's owned control channel for its targets, and have an independently
// reviewed cleanup boundary before testing guardian loss. No PID-based fallback is allowed.
test('real Java guardian process lifecycle — quarantined pending owned cleanup', {
  skip: 'Native process execution is blocked: launch-bound cleanup and guardian-loss containment are not verified.'
}, () => {
  assert.fail('This quarantined test must not execute; restore only after ownership review and explicit execution authorization.');
});
