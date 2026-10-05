'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { createNativeOwnerLocks, acquireNativeOwnerLock } = require('../src/native-owner-locks.cjs');

// Actual provider/FS identity checks, synthetic child protocol. No Java, native
// process, OS key, database or signal is used by these failure regressions.
async function fixture(t) {
  const root = await fs.mkdtemp(path.join(await fs.realpath(os.tmpdir()), 'ci-lease-exceptions-'));
  const safetyRoot = path.join(root, 'safety'), role = path.join(safetyRoot, 'purpose-keyring');
  await fs.mkdir(role, { recursive: true, mode: 0o700 });
  const marker = path.join(role, 'owner.lock'); await fs.writeFile(marker, 'synthetic-protocol-marker\n', { mode: 0o600 });
  const javaPath = path.join(root, 'java'), jarPath = path.join(root, 'app.jar');
  for (const file of [javaPath, jarPath]) await fs.writeFile(file, 'nonexecutable synthetic fixture', { mode: 0o600 });
  const helper = new EventEmitter(); helper.pid = 12345;
  helper.stdout = new EventEmitter(); helper.stderr = new EventEmitter();
  const controls = { throwWrite: false, throwDestroy: false, throwKill: false, throwEnd: false, autoClose: true };
  let closed = false, lost = 0;
  const exit = () => { if (!closed) { closed = true; helper.emit('exit', 0, null); helper.emit('close', 0, null); } };
  const stdin = new EventEmitter(); helper.stdin = stdin;
  stdin.write = (text, done) => {
    if (controls.throwWrite) throw new Error('private-fixture-write-detail');
    const parts = text.trimEnd().split('\t');
    queueMicrotask(() => {
      const reply = parts[0] === 'ACQUIRE' ? 'READY\t' + parts[4]
        : parts[0] === 'CHECK' ? 'HELD\t' + parts[1] : 'RELEASED\t' + parts[1];
      helper.stdout.emit('data', Buffer.from(reply + '\n')); done?.();
    }); return true;
  };
  stdin.destroy = () => { if (controls.throwDestroy) throw new Error('private-fixture-destroy-detail'); };
  stdin.end = () => { if (controls.throwEnd) throw new Error('private-fixture-end-detail'); if (controls.autoClose) queueMicrotask(exit); };
  helper.kill = () => {
    if (controls.throwKill) throw new Error('private-fixture-kill-detail');
    if (controls.autoClose) queueMicrotask(exit); return true;
  };
  const provider = await createNativeOwnerLocks({ javaPath, jarPath, safetyRoot, installationId: 'fixture',
    assertMainOwnership: () => true, onLost: () => { lost++; }, timeoutMs: 50, spawnImpl: () => helper });
  const acquire = () => acquireNativeOwnerLock(provider, { safetyRoot, installationId: 'fixture', kind: 'purpose-keyring' });
  t.after(async () => { exit(); await fs.rm(root, { recursive: true }); });
  return { helper, controls, provider, acquire, marker, exit, lost: () => lost };
}
const safe = code => error => { assert.equal(error.code, code); assert.equal(error.cause, undefined);
  assert.doesNotMatch(error.message, /private-fixture/); return true; };

test('synchronous destroy and kill failure never escapes a loss event or releases the active reservation', async t => {
  const f = await fixture(t), lease = await f.acquire(), before = await fs.readFile(f.marker);
  Object.assign(f.controls, { throwDestroy: true, throwKill: true, autoClose: false });
  assert.doesNotThrow(() => f.helper.stderr.emit('data', Buffer.from('untrusted diagnostic')));
  assert.equal(lease.isHeld(), false); assert.equal(f.lost(), 1);
  await assert.rejects(lease.release(), safe('NATIVE_OWNER_TERMINATION'));
  await assert.rejects(f.provider.close(), safe('NATIVE_OWNER_BUSY'));
  assert.deepEqual(await fs.readFile(f.marker), before);
});

test('a synchronous CHECK write error is sanitized and cleanup requires the original helper close', async t => {
  const f = await fixture(t), lease = await f.acquire(); f.controls.throwWrite = true;
  await assert.rejects(lease.check(), safe('NATIVE_OWNER_PROCESS'));
  await assert.rejects(lease.release(), safe('NATIVE_OWNER_PROCESS'));
  await f.provider.close(); assert.equal(f.lost(), 1);
});

test('synchronous RELEASE end failure remains observable even when owned helper shutdown succeeds', async t => {
  const f = await fixture(t), lease = await f.acquire(); f.controls.throwEnd = true;
  await assert.rejects(lease.release(), safe('NATIVE_OWNER_PROCESS'));
  await f.provider.close(); assert.equal(f.lost(), 1);
});

test('failed startup and failed termination preserve the reservation rather than permitting another acquire', async t => {
  const f = await fixture(t);
  Object.assign(f.controls, { throwWrite: true, throwDestroy: true, throwKill: true, autoClose: false });
  await assert.rejects(f.acquire(), safe('NATIVE_OWNER_TERMINATION'));
  await assert.rejects(f.acquire(), safe('NATIVE_OWNER_BUSY'));
  await assert.rejects(f.provider.close(), safe('NATIVE_OWNER_BUSY'));
  assert.equal(f.lost(), 0);
});
