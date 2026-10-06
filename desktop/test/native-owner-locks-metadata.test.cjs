'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { EventEmitter } = require('node:events');

const sourceFile = path.resolve(__dirname, '../src/native-owner-locks.cjs');
const names = ['root', 'role', 'marker'];
const posix = process.platform !== 'win32' && typeof process.getuid === 'function';
const nextTurn = () => new Promise(resolve => setImmediate(resolve));

function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  promise.catch(() => {});
  return { promise, resolve, reject };
}

async function bounded(promise, label) {
  let timer;
  try {
    return await Promise.race([promise, new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(`Synthetic metadata boundary stalled: ${label}`)), 1000);
    })]);
  } finally { clearTimeout(timer); }
}

function metadataPass() {
  const gates = Object.fromEntries(names.map(name => [name, {
    entered: deferred(), unblock: deferred(), finished: deferred(), calls: 0,
  }]));
  return {
    gates,
    started: Promise.all(names.map(name => gates[name].entered.promise)),
    async read(name, operation) {
      const gate = gates[name];
      assert.equal(++gate.calls, 1, 'Each pass must independently read each metadata target once.');
      gate.entered.resolve();
      try { await gate.unblock.promise; return await operation(); }
      finally { gate.finished.resolve(); }
    },
    release(name) { gates[name].unblock.resolve(); },
    reject(name, error) { gates[name].unblock.reject(error); },
    releaseAll() { for (const name of names) gates[name].unblock.resolve(); },
  };
}

// The provider runs unchanged in a private VM. Only this module's fs facade is
// injected; no shared fs method, native executable, OS lease or process is used.
async function fixture(t) {
  const root = await fs.mkdtemp(path.join(await fs.realpath(os.tmpdir()), 'ci-lease-metadata-'));
  const safetyRoot = path.join(root, 'safety'), role = path.join(safetyRoot, 'purpose-keyring');
  const marker = path.join(role, 'owner.lock');
  const javaPath = path.join(root, 'java'), jarPath = path.join(root, 'app.jar');
  const targets = new Map([[safetyRoot, 'root'], [role, 'role'], [marker, 'marker']]);
  const passes = [], tasks = [], events = [], losses = [];
  let activePass = null, provider, lease, acquisition, owned = true, closed = false, spawns = 0;
  const helper = new EventEmitter(), childClosed = deferred();
  helper.pid = 12345;
  helper.stdin = new EventEmitter(); helper.stdout = new EventEmitter(); helper.stderr = new EventEmitter();
  helper.once('close', (code, signal) => childClosed.resolve({ code, signal }));
  const exit = () => {
    if (closed) return;
    closed = true; events.push('CLOSE');
    helper.emit('exit', 0, null); helper.emit('close', 0, null);
  };
  helper.stdin.write = (line, done) => {
    const parts = line.trimEnd().split('\t'), operation = parts[0];
    assert(['ACQUIRE', 'CHECK', 'RELEASE'].includes(operation));
    events.push(operation);
    queueMicrotask(() => {
      if (closed) return;
      const reply = operation === 'ACQUIRE' ? `READY\t${parts[4]}`
        : operation === 'CHECK' ? `HELD\t${parts[1]}` : `RELEASED\t${parts[1]}`;
      events.push(reply.split('\t')[0]);
      helper.stdout.emit('data', Buffer.from(reply + '\n')); done?.();
    });
    return true;
  };
  helper.stdin.destroy = () => { events.push('DESTROY'); };
  helper.stdin.end = () => { events.push('END'); queueMicrotask(exit); };
  helper.kill = () => { events.push('KILL'); queueMicrotask(exit); return true; };

  const track = promise => {
    const observed = { settled: false, value: undefined, error: undefined };
    observed.promise = Promise.resolve(promise).then(value => {
      observed.settled = true; observed.value = value;
      return { status: 'fulfilled', value };
    }, error => {
      observed.settled = true; observed.error = error;
      return { status: 'rejected', error };
    });
    tasks.push(observed.promise);
    return observed;
  };

  // Registered before setup/acquisition: a failed assertion or a sequential-read
  // regression releases every gate before joining checks and closing the owner.
  t.after(async () => {
    activePass = null;
    for (const pass of passes) pass.releaseAll();
    try {
      await Promise.all(tasks);
      const currentLease = lease || acquisition?.value;
      if (currentLease) await currentLease.release().catch(() => {});
      exit(); await childClosed.promise;
      if (provider) await provider.close();
    } finally {
      exit(); await childClosed.promise;
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  await fs.chmod(root, 0o700);
  await fs.mkdir(role, { recursive: true, mode: 0o700 });
  await fs.writeFile(marker, 'synthetic-protocol-marker\n', { mode: 0o600 });
  for (const file of [javaPath, jarPath]) {
    await fs.writeFile(file, 'nonexecutable synthetic fixture', { mode: 0o600 });
  }
  const localFs = Object.freeze({ ...fs,
    lstat(file, options) {
      const pass = activePass, name = targets.get(file);
      const read = () => fs.lstat(file, options);
      return pass && name && options?.bigint === true ? pass.read(name, read) : read();
    },
  });
  const context = vm.createContext({ module: { exports: {} }, Buffer, setTimeout, clearTimeout, queueMicrotask,
    process: { platform: 'darwin', getuid: process.getuid.bind(process), env: {} },
    require(name) {
      if (name === 'node:fs/promises') return localFs;
      if (name === 'node:child_process') return { spawn() { throw new Error('Native process execution is forbidden.'); } };
      return require(name.startsWith('./') ? path.resolve(path.dirname(sourceFile), name) : name);
    },
  });
  vm.runInContext(await fs.readFile(sourceFile, 'utf8'), context, { filename: sourceFile });
  const api = context.module.exports;
  provider = await api.createNativeOwnerLocks({ javaPath, jarPath, safetyRoot, installationId: 'fixture',
    assertMainOwnership: () => owned, onLost: error => { losses.push(error); }, timeoutMs: 500,
    spawnImpl(command, args, options) {
      assert.equal(++spawns, 1); assert.equal(command, javaPath);
      assert.equal(args.at(-1), '--ci-desktop-lease'); assert.equal(options.shell, false);
      return helper;
    },
  });
  acquisition = track(api.acquireNativeOwnerLock(provider, { safetyRoot, installationId: 'fixture', kind: 'purpose-keyring' }));
  const acquired = await bounded(acquisition.promise, 'initial lease');
  assert.equal(acquired.status, 'fulfilled'); lease = acquired.value;
  return {
    lease, provider, marker, events, losses, track,
    arm() { const pass = metadataPass(); passes.push(pass); activePass = pass; return pass; },
    disarm() { activePass = null; },
    loseMainOwnership() { owned = false; },
    count(operation) { return events.filter(event => event === operation).length; },
    cleanupStarted() { return events.some(event => ['DESTROY', 'KILL', 'END', 'CLOSE'].includes(event)); },
  };
}

async function completedRead(pass, name) {
  await bounded(pass.gates[name].finished.promise, `${name} read`);
  await nextTurn();
}

function rejected(outcome, code) {
  assert.equal(outcome.status, 'rejected');
  assert.equal(outcome.error.code, code);
  assert.equal(outcome.error.cause, undefined);
  assert.doesNotMatch(outcome.error.message, /PRIVATE_METADATA|synthetic-protocol-marker/);
  return outcome.error;
}

test('all three metadata gates precede CHECK and all three post-HELD gates precede success', { timeout: 5000, skip: !posix }, async t => {
  const f = await fixture(t), checks = f.count('CHECK'), held = f.count('HELD');
  const before = f.arm(), checking = f.track(f.lease.check());
  await bounded(before.started, 'three pre-CHECK reads');
  assert.deepEqual(names.map(name => before.gates[name].calls), [1, 1, 1]);
  assert.equal(f.count('CHECK'), checks); assert.equal(checking.settled, false);
  for (const name of ['root', 'marker']) {
    before.release(name); await completedRead(before, name);
    assert.equal(f.count('CHECK'), checks); assert.equal(checking.settled, false);
  }
  const after = f.arm(); before.release('role');
  await bounded(after.started, 'three post-HELD reads');
  assert.equal(f.count('CHECK'), checks + 1); assert.equal(f.count('HELD'), held + 1);
  assert.deepEqual(names.map(name => after.gates[name].calls), [1, 1, 1]);
  assert.equal(checking.settled, false);
  for (const name of ['role', 'root']) {
    after.release(name); await completedRead(after, name);
    assert.equal(checking.settled, false);
  }
  after.release('marker');
  assert.equal((await bounded(checking.promise, 'completed check')).status, 'fulfilled');
  assert.equal(f.lease.isHeld(), true); assert.equal(f.losses.length, 0);
  f.disarm();
  assert.equal((await bounded(f.track(f.lease.release()).promise, 'normal release')).status, 'fulfilled');
  await f.provider.close(); assert.equal(f.count('CLOSE'), 1);
});

test('failed metadata joins remaining reads before rejection, loss cleanup or queued release', { timeout: 5000, skip: !posix }, async t => {
  const f = await fixture(t), checks = f.count('CHECK');
  const pass = f.arm(), checking = f.track(f.lease.check());
  await bounded(pass.started, 'three failing-pass reads');
  const releasing = f.track(f.lease.release());
  const markerFailure = Object.assign(new Error('PRIVATE_METADATA_MARKER'), { code: 'EIO' });
  const rootFailure = Object.assign(new Error('PRIVATE_METADATA_ROOT'), { code: 'EPERM' });
  // A later array entry fails first. Neither rejection may finish the pass while
  // the role read is outstanding; the public lease error remains sanitized.
  pass.reject('marker', markerFailure); await completedRead(pass, 'marker');
  assert.equal(checking.settled, false); assert.equal(releasing.settled, false);
  assert.equal(f.cleanupStarted(), false); assert.equal(f.losses.length, 0);
  pass.reject('root', rootFailure); await completedRead(pass, 'root');
  assert.equal(checking.settled, false); assert.equal(releasing.settled, false);
  assert.equal(f.cleanupStarted(), false); assert.equal(f.count('CHECK'), checks);
  await assert.rejects(f.provider.close(), error => error.code === 'NATIVE_OWNER_BUSY');
  pass.release('role');
  const error = rejected(await bounded(checking.promise, 'failed check'), 'NATIVE_OWNER_LOST');
  assert.notStrictEqual(error, rootFailure); assert.notStrictEqual(error, markerFailure);
  assert.strictEqual(rejected(await bounded(releasing.promise, 'failed release'), 'NATIVE_OWNER_LOST'), error);
  assert.equal(f.count('CHECK'), checks); assert.equal(f.losses.length, 1);
  assert.equal(f.losses[0].code, 'NATIVE_OWNER_LOST');
  await f.provider.close(); assert.equal(f.count('CLOSE'), 1);
});

test('main ownership lost during pending metadata prevents CHECK and reports loss once', { timeout: 5000, skip: !posix }, async t => {
  const f = await fixture(t), checks = f.count('CHECK');
  const pass = f.arm(), checking = f.track(f.lease.check());
  await bounded(pass.started, 'reads before ownership loss');
  f.loseMainOwnership();
  for (const name of ['root', 'role']) {
    pass.release(name); await completedRead(pass, name);
    assert.equal(checking.settled, false); assert.equal(f.count('CHECK'), checks);
  }
  pass.release('marker');
  rejected(await bounded(checking.promise, 'ownership rejection'), 'NATIVE_OWNER_MAIN_OWNERSHIP');
  assert.equal(f.count('CHECK'), checks); assert.equal(f.lease.isHeld(), false);
  assert.equal(f.lease.isHeld(), false); assert.equal(f.losses.length, 1);
  assert.equal(f.losses[0].code, 'NATIVE_OWNER_LOST');
  rejected(await bounded(f.track(f.lease.release()).promise, 'lost-owner release'), 'NATIVE_OWNER_MAIN_OWNERSHIP');
  assert.equal(f.losses.length, 1); await f.provider.close();
});

test('a changed marker after HELD rejects the check after joining post-exchange reads', { timeout: 5000, skip: !posix }, async t => {
  const f = await fixture(t), checks = f.count('CHECK'), held = f.count('HELD');
  const before = f.arm(), checking = f.track(f.lease.check());
  await bounded(before.started, 'pre-exchange reads');
  const after = f.arm(); before.releaseAll();
  await bounded(after.started, 'post-exchange reads');
  assert.equal(f.count('CHECK'), checks + 1); assert.equal(f.count('HELD'), held + 1);
  await fs.appendFile(f.marker, 'changed-after-held\n');
  for (const name of ['root', 'role']) {
    after.release(name); await completedRead(after, name);
    assert.equal(checking.settled, false); assert.equal(f.losses.length, 0);
  }
  after.release('marker');
  rejected(await bounded(checking.promise, 'post-HELD marker rejection'), 'NATIVE_OWNER_LOST');
  assert.equal(f.lease.isHeld(), false); assert.equal(f.losses.length, 1);
  assert.equal(f.count('CHECK'), checks + 1);
  assert.equal(await fs.readFile(f.marker, 'utf8'), 'synthetic-protocol-marker\nchanged-after-held\n');
  rejected(await bounded(f.track(f.lease.release()).promise, 'changed-marker release'), 'NATIVE_OWNER_LOST');
  await f.provider.close();
});
