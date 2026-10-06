'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { parseProcessTable, descendants, ensureNativeParent, killCapturedApplication } = require('../../validation/backup-compatibility/owned-crash.cjs');
const { argumentsFor } = require('../../validation/backup-compatibility/native-interruption.cjs');

function childProcess({ pid = 4100, exitCode = null, signalCode = null, killResult = true, killError } = {}) {
  const child = Object.assign(new EventEmitter(), {
    pid, exitCode, signalCode, kills: [],
    kill(signal) {
      this.kills.push(signal);
      if (killError) throw killError;
      return killResult;
    },
  });
  return child;
}

function owner(child) { return { process: () => child }; }

test('owner crash requires an exact opt-in after an explicit app and supported restore point', () => {
  const base = ['--app', '/synthetic/Code Intelligence Validation.app', '--point', 'AFTER_SOURCE_RENAME'];
  assert.deepEqual(argumentsFor(base), { app: base[1], point: base[3], ownerCrash: false });
  assert.deepEqual(argumentsFor([...base, '--owner-crash']), { app: base[1], point: base[3], ownerCrash: true });
  for (const argv of [[], ['--owner-crash'], [...base, '--force'], [...base, '--owner-crash', '--owner-crash'],
    ['--app', 'relative.app', '--point', base[3]], ['--app', base[1], '--point', 'ARBITRARY_POINT']]) {
    assert.throws(() => argumentsFor(argv));
  }
});

function privateRepo(t) {
  const repo = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'owned-crash-contract-')));
  fs.chmodSync(repo, 0o700);
  t.after(() => fs.rmSync(repo, { recursive: true, force: true }));
  return repo;
}

test('native parent is private, reusable and preserves existing claim directories', t => {
  const repo = privateRepo(t), parent = ensureNativeParent(repo);
  assert.equal(parent, path.join(repo, '.nr'));
  assert.equal(fs.statSync(parent).mode & 0o7777, 0o700);
  const sentinel = path.join(parent, 'owned-sentinel'); fs.writeFileSync(sentinel, 'preserved', { mode: 0o600 });
  assert.equal(ensureNativeParent(repo), parent);
  assert.equal(fs.readFileSync(sentinel, 'utf8'), 'preserved');
});

test('linked or nonprivate native parent is rejected without changing the target', t => {
  for (const mode of ['link', 'permissions', 'file']) {
    const repo = privateRepo(t), parent = path.join(repo, '.nr'), target = path.join(repo, 'kept');
    fs.mkdirSync(target, { mode: 0o700 }); fs.writeFileSync(path.join(target, 'sentinel'), 'preserved');
    if (mode === 'link') fs.symlinkSync(target, parent);
    else if (mode === 'permissions') { fs.mkdirSync(parent, { mode: 0o700 }); fs.chmodSync(parent, 0o755); }
    else fs.writeFileSync(parent, 'preserved');
    const before = fs.lstatSync(parent);
    assert.throws(() => ensureNativeParent(repo), /NATIVE_PARENT_UNSAFE/);
    assert.equal(fs.lstatSync(parent).ino, before.ino);
    assert.equal(fs.lstatSync(parent).mode, before.mode);
    assert.equal(fs.readFileSync(path.join(target, 'sentinel'), 'utf8'), 'preserved');
  }
});

test('process table parsing is strict, bounded and rejects duplicate or malformed identities', () => {
  assert.deepEqual(parseProcessTable(' 10 1\n11 10\n12 11\n'), [
    { pid: 10, ppid: 1 }, { pid: 11, ppid: 10 }, { pid: 12, ppid: 11 },
  ]);
  for (const value of ['1 1\n', '0 1\n', '-1 1\n', '1 -1\n', '1 0 extra\n', '1\t\n', '1 0\n1 0\n']) {
    assert.throws(() => parseProcessTable(value));
  }
  assert.throws(() => parseProcessTable('1 0\n'.repeat(50001)));
});

test('descendants computes transitive closure while foreign pids remain observation-only', () => {
  const rows = [
    { pid: 4100, ppid: 1 }, { pid: 4101, ppid: 4100 }, { pid: 4102, ppid: 4101 },
    { pid: 9000, ppid: 1 }, { pid: 9001, ppid: 9000 },
  ];
  assert.deepEqual(descendants(rows, 4100), rows.slice(0, 3));
  assert.throws(() => descendants(rows, 7777), /OWNED_PROCESS_NOT_OBSERVED/);
});

test('captured owner is the only signal authority and observed foreign pids are never killed', async () => {
  const child = childProcess();
  const tables = [
    [{ pid: 4100, ppid: 1 }, { pid: 4101, ppid: 4100 }, { pid: 9900, ppid: 1 }],
    [{ pid: 9900, ppid: 1 }],
  ];
  const proof = {};
  child.kill = function kill(signal) {
    this.kills.push(signal);
    queueMicrotask(() => {
      this.signalCode = 'SIGKILL';
      this.emit('exit', null, 'SIGKILL');
      this.emit('close');
    });
    return true;
  };
  await killCapturedApplication(owner(child), proof, { readProcesses: async () => tables.shift(), timeoutMs: 50, intervalMs: 1 });
  assert.deepEqual(child.kills, ['SIGKILL']);
  assert.deepEqual(proof.observedBefore.map(row => row.pid), [4100, 4101]);
  assert.deepEqual(proof.remainingObservedPids, []);
  assert.equal(proof.observedTreeGone, true);
  assert.equal(child.listenerCount('exit'), 0); assert.equal(child.listenerCount('close'), 0);
});

test('already exited owner and an owner that exits during the table read are refused before SIGKILL', async () => {
  for (const child of [childProcess({ exitCode: 0 }), childProcess({ signalCode: 'SIGTERM' })]) {
    await assert.rejects(killCapturedApplication(owner(child), {}, { readProcesses: async () => [] }));
    assert.deepEqual(child.kills, []);
  }
  const child = childProcess();
  await assert.rejects(killCapturedApplication(owner(child), {}, {
    readProcesses: async () => {
      child.exitCode = 0; child.emit('exit', 0, null); child.emit('close');
      return [{ pid: child.pid, ppid: 1 }, { pid: child.pid + 1, ppid: child.pid }];
    }, timeoutMs: 50, intervalMs: 1,
  }));
  assert.deepEqual(child.kills, []);
  assert.equal(child.listenerCount('exit'), 0); assert.equal(child.listenerCount('close'), 0);
});

test('kill false, thrown kill and wrong exit signal all fail without adopting observed pids', async () => {
  const rows = async () => [{ pid: 4100, ppid: 1 }, { pid: 4101, ppid: 4100 }];
  for (const child of [childProcess({ killResult: false }), childProcess({ killError: new Error('synthetic-kill-failure') })]) {
    await assert.rejects(killCapturedApplication(owner(child), {}, { readProcesses: rows, timeoutMs: 50, intervalMs: 1 }));
    assert.deepEqual(child.kills, ['SIGKILL']);
    assert.equal(child.listenerCount('exit'), 0); assert.equal(child.listenerCount('close'), 0);
  }
  const child = childProcess();
  child.kill = function kill(signal) {
    this.kills.push(signal);
    queueMicrotask(() => { this.signalCode = 'SIGTERM'; this.emit('exit', null, 'SIGTERM'); this.emit('close'); });
    return true;
  };
  await assert.rejects(killCapturedApplication(owner(child), {}, { readProcesses: rows, timeoutMs: 50, intervalMs: 1 }));
  assert.deepEqual(child.kills, ['SIGKILL']);
  assert.equal(child.listenerCount('exit'), 0); assert.equal(child.listenerCount('close'), 0);
});

test('known descendants remaining and missing close observation fail and clean listeners', async () => {
  const lingering = childProcess();
  lingering.kill = function kill(signal) {
    this.kills.push(signal);
    queueMicrotask(() => { this.signalCode = 'SIGKILL'; this.emit('exit', null, 'SIGKILL'); this.emit('close'); });
    return true;
  };
  await assert.rejects(killCapturedApplication(owner(lingering), {}, {
    readProcesses: async () => [{ pid: 4100, ppid: 1 }, { pid: 4101, ppid: 4100 }], timeoutMs: 5, intervalMs: 1,
  }), /OBSERVED_DESCENDANTS_REMAIN/);
  assert.equal(lingering.listenerCount('exit'), 0); assert.equal(lingering.listenerCount('close'), 0);

  const noClose = childProcess(); let reads = 0;
  noClose.kill = function kill(signal) {
    this.kills.push(signal);
    queueMicrotask(() => { this.signalCode = 'SIGKILL'; this.emit('exit', null, 'SIGKILL'); });
    return true;
  };
  await assert.rejects(killCapturedApplication(owner(noClose), {}, {
    readProcesses: async () => reads++ ? [] : [{ pid: 4100, ppid: 1 }, { pid: 4101, ppid: 4100 }], timeoutMs: 5, intervalMs: 1,
  }), /OWNED_CRASH_PIPE_TIMEOUT/);
  assert.equal(noClose.listenerCount('exit'), 0); assert.equal(noClose.listenerCount('close'), 0);
});
