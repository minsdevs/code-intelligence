'use strict';

const assert = require('node:assert/strict');
const path = require('node:path');
const vm = require('node:vm');
const test = require('node:test');
const { EventEmitter } = require('node:events');
const { installOwnedInterruption, installOwnedDialogs, captureOwnedApplication } = require('../../validation/backup-compatibility/interruption-hooks.cjs');
const parent = '/private/tmp/ciri-synthetic', profile = parent + '/desktop-run-synthetic/user';
const transactionId = '12345678-1234-4123-8123-123456789abc';
const transaction = profile + '/recovery/' + transactionId;

function harness(install, overrides = {}) {
  const calls = [], emitted = [];
  const io = {
    async rename(...args) { calls.push(['rename', ...args]); },
    async unlink(...args) { calls.push(['unlink', ...args]); },
  };
  const fs = { promises: io, realpathSync: file => file,
    lstatSync: () => ({ uid: 501, mode: 0o700, nlink: 1, isFile: () => true, isSymbolicLink: () => false }), ...overrides.fs };
  const process = { getuid: () => 501, getBuiltinModule: name => ({ 'assert/strict': assert, fs, path })[name],
    stderr: { write: line => emitted.push(line) } };
  const app = { getName: () => 'Code Intelligence Acceptance', getPath: () => profile, ...overrides.app };
  // Like Playwright, no module-scope helper, closure or require binding is carried over.
  const execute = vm.runInNewContext('(' + install.toString() + ')', { process });
  return { calls, io, emitted, app, execute, fs };
}

test('serialized source hook faults after one real rename and passes rollback and unrelated paths through', async () => {
  const h = harness(installOwnedInterruption), original = { ...h.io };
  const hook = h.execute({ app: h.app }, { profile, parent, mode: 'AFTER_SOURCE_RENAME' });
  for (const source of [profile + '/other/repos', '/outside/data/repos']) {
    await h.io.rename(source, transaction + '/previous-repos');
  }
  await h.io.rename(profile + '/data/repos', profile + '/recovery/not-a-uuid/previous-repos');
  assert.equal(hook.inspect(), null);
  await assert.rejects(h.io.rename(profile + '/data/repos', transaction + '/previous-repos'), { code: 'EIO' });
  assert.equal(h.calls.length, 4);
  assert.deepEqual(JSON.parse(JSON.stringify(hook.inspect())), { mode: 'AFTER_SOURCE_RENAME', transactionId, operationCompleted: true, count: 1 });
  await h.io.rename(transaction + '/previous-repos', profile + '/data/repos');
  await h.io.rename(profile + '/data/repos', transaction + '/previous-repos');
  assert.equal(h.calls.length, 6); assert.equal(hook.inspect().count, 1);
  assert.equal(hook.restore().count, 1);
  assert.equal(h.io.rename, original.rename); assert.equal(h.io.unlink, original.unlink);
});

test('serialized completed-cleanup hook preserves its target and cannot trip on incoming or another profile', async () => {
  const h = harness(installOwnedInterruption);
  const hook = h.execute({ app: h.app }, { profile, parent, mode: 'BEFORE_COMPLETED_CLEANUP' });
  await h.io.unlink(transaction + '/incoming/payload.bin');
  await h.io.unlink('/outside/recovery/' + transactionId + '/checkpoint/payload.bin');
  await h.io.unlink(profile + '/recovery/not-a-uuid/checkpoint/payload.bin');
  assert.equal(hook.inspect(), null);
  await assert.rejects(h.io.unlink(transaction + '/checkpoint/payload.bin'), { code: 'EIO' });
  assert.equal(h.calls.length, 3); assert.equal(hook.inspect().operationCompleted, false);
  assert.equal(hook.restore().count, 1);
  await h.io.unlink(transaction + '/checkpoint/payload.bin'); assert.equal(h.calls.length, 4);
});

test('hooks refuse ordinary profiles, another claim, noncanonical paths, wrong owners and modes before installation', () => {
  for (const overrides of [
    { app: { getName: () => 'Code Intelligence Validation' } },
    { app: { getPath: () => '/real/user/profile' } },
    { fs: { realpathSync: file => file + '-other' } },
    { fs: { lstatSync: () => ({ uid: 502, mode: 0o700 }) } },
    { fs: { lstatSync: () => ({ uid: 501, mode: 0o755 }) } },
  ]) {
    const h = harness(installOwnedInterruption, overrides), original = { ...h.io };
    assert.throws(() => h.execute({ app: h.app }, { profile, parent, mode: 'AFTER_SOURCE_RENAME' }));
    assert.equal(h.io.rename, original.rename); assert.equal(h.io.unlink, original.unlink);
  }
  const h = harness(installOwnedInterruption), original = { ...h.io };
  assert.throws(() => h.execute({ app: h.app }, { profile, parent: '/elsewhere', mode: 'AFTER_SOURCE_RENAME' }));
  assert.throws(() => h.execute({ app: h.app }, { profile, parent, mode: 'SIGKILL' }));
  assert.equal(h.io.rename, original.rename); assert.equal(h.io.unlink, original.unlink);
});

test('a changed hook cannot silently restore over another owner', () => {
  const h = harness(installOwnedInterruption);
  const hook = h.execute({ app: h.app }, { profile, parent, mode: 'AFTER_SOURCE_RENAME' });
  const other = async () => {}; h.io.rename = other;
  assert.throws(() => hook.restore()); assert.equal(h.io.rename, other);
});

test('serialized dialog controller accepts only one exact recovery consent and emits fixed codes without error detail', async () => {
  const h = harness(installOwnedDialogs), dialog = {};
  const nonce = 'a'.repeat(32);
  h.execute({ app: h.app, dialog }, { profile, parent, nonce, recover: true });
  const options = { title: 'Verify interrupted recovery', type: 'warning', buttons: ['Verify and recover', 'Quit'], defaultId: 0, cancelId: 1 };
  assert.equal((await dialog.showMessageBox(options)).response, 0);
  assert.equal((await dialog.showMessageBox(options)).response, 1);
  dialog.showErrorBox('Code Intelligence shutdown requires recovery', 'private-secret-must-not-escape');
  dialog.showErrorBox('Code Intelligence could not start', 'private-secret-must-not-escape');
  assert.deepEqual(h.emitted, ['RECOVERY_ACCEPTED', 'UNEXPECTED_CONFIRMATION', 'SHUTDOWN_RECOVERY_REQUIRED', 'STARTUP_FAILED', 'STARTUP_OTHER']
    .map(code => 'OWNED_RECOVERY_EVENT ' + nonce + ' ' + code + '\n'));
  assert.doesNotMatch(h.emitted.join(''), /private-secret/);
});

test('normal launch cannot grant recovery consent or silently classify an unexpected error as clean', async () => {
  const h = harness(installOwnedDialogs), dialog = {};
  h.execute({ app: h.app, dialog }, { profile, parent, nonce: 'b'.repeat(32), recover: false });
  assert.equal((await dialog.showMessageBox({ title: 'Verify interrupted recovery' })).response, 1);
  dialog.showErrorBox('arbitrary private error', 'arbitrary private detail');
  assert.match(h.emitted[0], /UNEXPECTED_CONFIRMATION/); assert.match(h.emitted[1], /UNEXPECTED_NATIVE_ERROR/);
  assert.doesNotMatch(h.emitted.join(''), /arbitrary|private/);
});

test('owned process capture survives SDK early-exit disposal without PID adoption or a second close request', async () => {
  const child = Object.assign(new EventEmitter(), { pid: 4242, exitCode: null, signalCode: null, kill() { throw new Error('not requested'); } });
  let calls = 0, closes = 0;
  const sdk = { process() { calls++; return child; }, async close() { closes++; } };
  const owner = captureOwnedApplication(sdk);
  await owner.close(); assert.equal(closes, 1);
  child.exitCode = 0; sdk.process = () => { throw new Error('SDK disposed'); };
  await owner.close(); assert.equal(owner.process(), child); assert.equal(closes, 1); assert.equal(calls, 1);
  assert.throws(() => captureOwnedApplication({ process: () => undefined }), /OWNED_PROCESS_MISSING/);
});

test('startup diagnostics classify static inventory and resource failures without exporting dynamic messages', () => {
  const h = harness(installOwnedDialogs), dialog = {};
  h.execute({ app: h.app, dialog }, { profile, parent, nonce: 'c'.repeat(32), recover: false });
  for (const detail of ['Bundled runtime manifest or inventory is invalid.', 'EMFILE: private/file/name', 'ENFILE: private/file/name', 'private arbitrary detail']) {
    dialog.showErrorBox('Code Intelligence could not start', detail);
  }
  assert.match(h.emitted.join(''), /MANIFEST_INVALID/); assert.match(h.emitted.join(''), /IO_FILE_LIMIT/);
  assert.match(h.emitted.join(''), /IO_SYSTEM_FILE_LIMIT/); assert.match(h.emitted.join(''), /STARTUP_OTHER/);
  assert.doesNotMatch(h.emitted.join(''), /private|arbitrary|detail/);
});
