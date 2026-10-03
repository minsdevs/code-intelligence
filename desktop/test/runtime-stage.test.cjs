const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const test = require('node:test');
const { createRuntimeStage, requireBuildSequence } = require('../scripts/runtime-stage.cjs');

test('build sequence is explicit and exact rather than derived from version or time', () => {
  for (const value of ['0', '1', '9007199254740993', '9223372036854775807']) {
    assert.equal(requireBuildSequence(value), value);
  }
  for (const value of [undefined, null, 1, '', '01', '-1', '+1', '1.0', '1e4', '0.1.0', '1\n', '1\r', '1\u2028', '1 ',
    '9223372036854775808']) {
    assert.throws(() => requireBuildSequence(value), /BUILD_SEQUENCE/);
  }
});

function fixture(t, old = true) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ci-runtime-stage-')));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const stageDirectory = path.join(root, 'stage');
  fs.mkdirSync(stageDirectory);
  const current = path.join(stageDirectory, 'runtime');
  if (old) {
    fs.mkdirSync(current);
    fs.writeFileSync(path.join(current, 'runtime.txt'), 'old complete runtime');
  }
  return { root, stageDirectory, current };
}

function fill(transaction) {
  fs.mkdirSync(path.join(transaction.staging, 'nested'));
  fs.writeFileSync(path.join(transaction.staging, 'nested', 'runtime.txt'), 'new complete runtime');
}

function oldBytes(f) { return fs.readFileSync(path.join(f.current, 'runtime.txt'), 'utf8'); }
function retained(f) { return fs.readdirSync(f.stageDirectory).filter((name) => name.startsWith('runtime.previous-')); }

test('successful publication preserves the entire previous runtime', (t) => {
  const f = fixture(t);
  const tx = createRuntimeStage(f.stageDirectory);
  fill(tx);
  const result = tx.publish();
  assert.equal(fs.readFileSync(path.join(result.previous, 'runtime.txt'), 'utf8'), 'old complete runtime');
  assert.equal(fs.readFileSync(path.join(f.current, 'nested', 'runtime.txt'), 'utf8'), 'new complete runtime');
  assert.equal(fs.existsSync(path.join(f.stageDirectory, '.runtime-stage.lock')), false);
  assert.equal(fs.existsSync(path.join(f.stageDirectory, '.runtime-stage-recovery.json')), false);
  tx.close();
  const next = createRuntimeStage(f.stageDirectory);
  next.close();
  assert.equal(retained(f).length, 1);
});

test('first publication works without an old runtime', (t) => {
  const f = fixture(t, false);
  const tx = createRuntimeStage(f.stageDirectory);
  fill(tx);
  assert.equal(tx.publish().previous, null);
  assert.equal(retained(f).length, 0);
});

test('build failure cleanup removes only this new temporary tree', (t) => {
  const f = fixture(t);
  const other = path.join(f.stageDirectory, 'runtime.incoming-unrelated');
  fs.mkdirSync(other);
  fs.writeFileSync(path.join(other, 'keep'), 'another build recovery');
  const tx = createRuntimeStage(f.stageDirectory);
  fill(tx);
  tx.close();
  assert.equal(oldBytes(f), 'old complete runtime');
  assert.equal(fs.readFileSync(path.join(other, 'keep'), 'utf8'), 'another build recovery');
  assert.equal(fs.existsSync(tx.staging), false);
});

test('concurrent and interrupted invocations cannot acquire or clean the owner lock', (t) => {
  const f = fixture(t);
  const tx = createRuntimeStage(f.stageDirectory);
  fill(tx);
  const before = fs.readFileSync(path.join(f.stageDirectory, '.runtime-stage.lock'));
  assert.throws(() => createRuntimeStage(f.stageDirectory), /stage lock/);
  assert.deepEqual(fs.readFileSync(path.join(f.stageDirectory, '.runtime-stage.lock')), before);
  assert.ok(fs.existsSync(tx.staging));
  tx.close();
});

for (const phase of ['BEFORE_MARKER', 'MARKER_DURABLE', 'PREVIOUS_RETAINED']) {
  test(`failure at ${phase} restores old runtime without deleting it`, (t) => {
    const f = fixture(t);
    const tx = createRuntimeStage(f.stageDirectory, { checkpoint: (state) => {
      if (state === phase) throw new Error('injected failure');
    } });
    fill(tx);
    assert.throws(() => tx.publish(), /injected failure/);
    tx.close();
    assert.equal(oldBytes(f), 'old complete runtime');
    assert.equal(fs.existsSync(tx.staging), false);
    assert.equal(fs.existsSync(path.join(f.stageDirectory, '.runtime-stage.lock')), false);
  });
}

test('failure after incoming rename retains both versions and blocks further stages', (t) => {
  const f = fixture(t);
  const tx = createRuntimeStage(f.stageDirectory, { checkpoint: (state) => {
    if (state === 'INCOMING_PUBLISHED') throw new Error('injected failure');
  } });
  fill(tx);
  assert.throws(() => tx.publish(), (error) => error.recoveryRequired === true);
  tx.close();
  assert.equal(retained(f).length, 1);
  assert.equal(fs.readFileSync(path.join(f.current, 'nested', 'runtime.txt'), 'utf8'), 'new complete runtime');
  assert.equal(fs.readFileSync(path.join(f.stageDirectory, retained(f)[0], 'runtime.txt'), 'utf8'), 'old complete runtime');
  assert.throws(() => createRuntimeStage(f.stageDirectory), /recovery/);
});

test('marker unlink followed by directory fsync failure keeps sticky recovery and lock', (t) => {
  const f = fixture(t);
  const tx = createRuntimeStage(f.stageDirectory);
  fill(tx);
  const unlink = fs.unlinkSync;
  const sync = fs.fsyncSync;
  let markerRemoved = false;
  fs.unlinkSync = (file) => {
    unlink(file);
    if (file.endsWith('.runtime-stage-recovery.json')) markerRemoved = true;
  };
  fs.fsyncSync = (fd) => {
    if (markerRemoved) throw new Error('injected post-unlink fsync failure');
    sync(fd);
  };
  try {
    assert.throws(() => tx.publish(), (error) => error.recoveryRequired === true);
    tx.close();
  } finally { fs.unlinkSync = unlink; fs.fsyncSync = sync; }
  assert.equal(fs.existsSync(path.join(f.stageDirectory, '.runtime-stage-recovery.json')), false);
  assert.ok(fs.existsSync(path.join(f.stageDirectory, '.runtime-stage.lock')));
  assert.equal(retained(f).length, 1);
  assert.throws(() => createRuntimeStage(f.stageDirectory), /stage lock/);
});

for (const phase of ['STAGED_FILE', 'STAGED_DIRECTORY', 'MARKER_FILE', 'MARKER_PARENT', 'OLD_RENAME_PARENT', 'NEW_RENAME_PARENT']) {
  test(`fsync failure at ${phase} preserves the appropriate recovery state`, (t) => {
    const f = fixture(t);
    const tx = createRuntimeStage(f.stageDirectory);
    fill(tx);
    const open = fs.openSync;
    const close = fs.closeSync;
    const sync = fs.fsyncSync;
    const descriptors = new Map();
    let injected = false;
    fs.openSync = (file, ...args) => {
      const fd = open(file, ...args);
      descriptors.set(fd, file);
      return fd;
    };
    fs.closeSync = (fd) => { descriptors.delete(fd); close(fd); };
    fs.fsyncSync = (fd) => {
      const file = descriptors.get(fd);
      const markerExists = fs.existsSync(path.join(f.stageDirectory, '.runtime-stage-recovery.json'));
      const oldMoved = retained(f).length === 1;
      const newMoved = fs.existsSync(path.join(f.current, 'nested', 'runtime.txt'));
      const boundary = {
        STAGED_FILE: file === path.join(tx.staging, 'nested', 'runtime.txt'),
        STAGED_DIRECTORY: file === tx.staging,
        MARKER_FILE: file === path.join(f.stageDirectory, '.runtime-stage-recovery.json'),
        MARKER_PARENT: file === f.stageDirectory && markerExists && !oldMoved,
        OLD_RENAME_PARENT: file === f.stageDirectory && oldMoved && !newMoved,
        NEW_RENAME_PARENT: file === f.stageDirectory && newMoved,
      }[phase];
      if (!injected && boundary) {
        injected = true;
        throw new Error('injected fsync boundary failure');
      }
      sync(fd);
    };
    try { assert.throws(() => tx.publish()); }
    finally { fs.openSync = open; fs.closeSync = close; fs.fsyncSync = sync; }
    assert.ok(injected, phase);
    tx.close();
    if (phase === 'NEW_RENAME_PARENT') {
      assert.equal(retained(f).length, 1);
      assert.ok(fs.existsSync(path.join(f.current, 'nested', 'runtime.txt')));
      assert.ok(fs.existsSync(path.join(f.stageDirectory, '.runtime-stage.lock')));
      assert.throws(() => createRuntimeStage(f.stageDirectory), /recovery/);
    } else {
      assert.equal(oldBytes(f), 'old complete runtime');
      assert.equal(fs.existsSync(path.join(f.stageDirectory, '.runtime-stage.lock')), false);
      assert.equal(fs.existsSync(path.join(f.stageDirectory, '.runtime-stage-recovery.json')), false);
    }
  });
}

test('failed promotion and failed rollback preserve recoverable directories', (t) => {
  const f = fixture(t);
  const tx = createRuntimeStage(f.stageDirectory);
  fill(tx);
  const rename = fs.renameSync;
  fs.renameSync = (from, to) => {
    if (to === f.current) throw new Error('injected rename failure');
    rename(from, to);
  };
  try { assert.throws(() => tx.publish(), (error) => error.recoveryRequired === true); }
  finally { fs.renameSync = rename; }
  tx.close();
  assert.ok(fs.existsSync(tx.staging));
  assert.equal(fs.readFileSync(path.join(f.stageDirectory, retained(f)[0], 'runtime.txt'), 'utf8'), 'old complete runtime');
  assert.throws(() => createRuntimeStage(f.stageDirectory), /recovery/);
});

test('marker creation failure happens before moving the old runtime', (t) => {
  const f = fixture(t);
  const tx = createRuntimeStage(f.stageDirectory);
  fill(tx);
  const open = fs.openSync;
  fs.openSync = (file, ...args) => {
    if (typeof file === 'string' && file.endsWith('.runtime-stage-recovery.json')) throw new Error('injected disk full');
    return open(file, ...args);
  };
  try { assert.throws(() => tx.publish(), /disk full/); }
  finally { fs.openSync = open; }
  tx.close();
  assert.equal(oldBytes(f), 'old complete runtime');
});

test('an unexpected marker is retained instead of being removed during error cleanup', (t) => {
  const f = fixture(t);
  const marker = path.join(f.stageDirectory, '.runtime-stage-recovery.json');
  const tx = createRuntimeStage(f.stageDirectory, { checkpoint: (state) => {
    if (state === 'BEFORE_MARKER') fs.writeFileSync(marker, 'other recovery record');
  } });
  fill(tx);
  assert.throws(() => tx.publish(), (error) => error.recoveryRequired === true);
  tx.close();
  assert.equal(fs.readFileSync(marker, 'utf8'), 'other recovery record');
  assert.equal(oldBytes(f), 'old complete runtime');
  assert.ok(fs.existsSync(tx.staging));
});

test('static parent/runtime symlinks and non-directory destinations are rejected', (t) => {
  const f = fixture(t, false);
  const alias = path.join(f.root, 'alias');
  fs.symlinkSync(f.stageDirectory, alias);
  assert.throws(() => createRuntimeStage(path.join(alias, 'nested')), /real directories/);
  fs.symlinkSync(f.root, f.current);
  assert.throws(() => createRuntimeStage(f.stageDirectory), /real directories/);
  fs.unlinkSync(f.current);
  fs.writeFileSync(f.current, 'do not delete');
  assert.throws(() => createRuntimeStage(f.stageDirectory), /real directories/);
  assert.equal(fs.readFileSync(f.current, 'utf8'), 'do not delete');
});

test('incoming symlinks/hardlinks fail before publication and outside data survives cleanup', (t) => {
  for (const kind of ['symbolic', 'hard']) {
    const f = fixture(t);
    const outside = path.join(f.root, 'outside');
    fs.writeFileSync(outside, 'keep');
    const tx = createRuntimeStage(f.stageDirectory);
    if (kind === 'symbolic') fs.symlinkSync(outside, path.join(tx.staging, 'link'));
    else fs.linkSync(outside, path.join(tx.staging, 'link'));
    assert.throws(() => tx.publish(), /link or special/);
    tx.close();
    assert.equal(fs.readFileSync(outside, 'utf8'), 'keep');
    assert.equal(oldBytes(f), 'old complete runtime');
  }
});

test('replaced lock cannot be removed by the original transaction cleanup', (t) => {
  const f = fixture(t);
  const tx = createRuntimeStage(f.stageDirectory);
  const lock = path.join(f.stageDirectory, '.runtime-stage.lock');
  fs.renameSync(lock, path.join(f.root, 'old-lock'));
  fs.writeFileSync(lock, 'another owner');
  assert.throws(() => tx.close(), /ownership changed/);
  assert.equal(fs.readFileSync(lock, 'utf8'), 'another owner');
  assert.ok(fs.existsSync(tx.staging));
});

test('a process exiting between renames leaves old bytes, incoming bytes and a recovery marker', (t) => {
  const f = fixture(t);
  const helper = require.resolve('../scripts/runtime-stage.cjs');
  const script = `
    const fs = require('node:fs');
    const path = require('node:path');
    const {createRuntimeStage} = require(process.argv[1]);
    const tx = createRuntimeStage(process.argv[2], {checkpoint: s => {if(s === 'PREVIOUS_RETAINED') process.exit(73);}});
    fs.writeFileSync(path.join(tx.staging, 'incoming'), 'new bytes');
    tx.publish();
  `;
  const result = spawnSync(process.execPath, ['-e', script, helper, f.stageDirectory], { encoding: 'utf8' });
  assert.equal(result.status, 73, result.stderr);
  const marker = JSON.parse(fs.readFileSync(path.join(f.stageDirectory, '.runtime-stage-recovery.json'), 'utf8'));
  assert.equal(fs.readFileSync(path.join(f.stageDirectory, marker.previous, 'runtime.txt'), 'utf8'), 'old complete runtime');
  assert.equal(fs.readFileSync(path.join(f.stageDirectory, marker.incoming, 'incoming'), 'utf8'), 'new bytes');
  assert.throws(() => createRuntimeStage(f.stageDirectory), /recovery/);
});

function legalFixture(t) {
  const f = fixture(t), tx = createRuntimeStage(f.stageDirectory);
  const legal = path.join(tx.staging, 'jre', 'legal'), base = path.join(legal, 'java.base'), module = path.join(legal, 'java.compiler');
  fs.mkdirSync(base, { recursive: true, mode: 0o755 }); fs.mkdirSync(module, { mode: 0o755 });
  const target = path.join(base, 'LICENSE'), link = path.join(module, 'LICENSE');
  fs.writeFileSync(target, 'Public synthetic runtime license.\n', { mode: 0o444 }); fs.symlinkSync('../java.base/LICENSE', link);
  return { ...f, tx, legal, base, module, target, link };
}

test('jlink legal internal links become independent files before unchanged no-link publication', t => {
  const f = legalFixture(t); const second = path.join(f.module, 'ADDITIONAL_LICENSE_INFO');
  fs.symlinkSync('../java.base/LICENSE', second);
  const before = fs.lstatSync(f.target, { bigint: true }), bytes = fs.readFileSync(f.target);
  assert.deepEqual(f.tx.materializeJreLegal(), { materialized: 2, bytes: bytes.length * 2 });
  for (const file of [f.link, second]) {
    const stat = fs.lstatSync(file, { bigint: true });
    assert.equal(stat.isFile(), true); assert.equal(stat.isSymbolicLink(), false); assert.equal(stat.nlink, 1n);
    assert.notEqual(stat.ino, before.ino); assert.equal(stat.mode & 0o777n, 0o444n); assert.deepEqual(fs.readFileSync(file), bytes);
  }
  assert.notEqual(fs.statSync(f.link).ino, fs.statSync(second).ino);
  const after = fs.lstatSync(f.target, { bigint: true });
  assert.equal(after.ino, before.ino); assert.equal(after.ctimeNs, before.ctimeNs); assert.equal(after.nlink, 1n);
  assert.deepEqual(f.tx.materializeJreLegal(), { materialized: 0, bytes: 0 });
  const published = f.tx.publish(); assert.equal(fs.readFileSync(path.join(published.previous, 'runtime.txt'), 'utf8'), 'old complete runtime');
  assert.deepEqual(fs.readFileSync(path.join(f.current, 'jre/legal/java.compiler/LICENSE')), bytes);
  assert.throws(() => f.tx.materializeJreLegal(), /not materializable/);
});

for (const kind of ['absolute-external', 'relative-external', 'absolute-internal', 'loop', 'link-chain', 'missing', 'directory',
  'linked-parent', 'hardlink-target', 'writable-target', 'executable-target', 'model-setid-target', 'writable-directory']) {
  test(`jlink legal ${kind} is rejected before any link is replaced`, t => {
    const f = legalFixture(t); const outside = path.join(f.root, 'outside.txt'); fs.writeFileSync(outside, 'never change');
    const safe = path.join(f.module, 'A_FIRST_LICENSE'); fs.symlinkSync('../java.base/LICENSE', safe);
    fs.unlinkSync(f.link);
    if (kind === 'absolute-external') fs.symlinkSync(outside, f.link);
    if (kind === 'relative-external') fs.symlinkSync(path.relative(f.module, outside), f.link);
    if (kind === 'absolute-internal') fs.symlinkSync(f.target, f.link);
    if (kind === 'loop') fs.symlinkSync('LICENSE', f.link);
    if (kind === 'link-chain') fs.symlinkSync('A_FIRST_LICENSE', f.link);
    if (kind === 'missing') fs.symlinkSync('../java.base/MISSING', f.link);
    if (kind === 'directory') fs.symlinkSync('../java.base', f.link);
    if (kind === 'linked-parent') {
      fs.symlinkSync('../java.base', path.join(f.legal, 'linked')); fs.symlinkSync('../linked/LICENSE', f.link);
    }
    if (kind === 'hardlink-target') { fs.linkSync(f.target, path.join(f.base, 'HARD')); fs.symlinkSync('../java.base/LICENSE', f.link); }
    if (['writable-target', 'executable-target', 'model-setid-target', 'writable-directory'].includes(kind)) {
      fs.symlinkSync('../java.base/LICENSE', f.link);
      if (kind === 'writable-target') fs.chmodSync(f.target, 0o666);
      if (kind === 'executable-target') fs.chmodSync(f.target, 0o555);
      if (kind === 'writable-directory') fs.chmodSync(f.base, 0o777);
    }
    const lstat = fs.lstatSync;
    // Some managed filesystems strip setuid on chmod. Model the rejected metadata explicitly.
    if (kind === 'model-setid-target') fs.lstatSync = (file, ...args) => {
      const stat = lstat(file, ...args); if (file === f.target) stat.mode |= typeof stat.mode === 'bigint' ? 0o4000n : 0o4000; return stat;
    };
    try { assert.throws(() => f.tx.materializeJreLegal()); } finally { fs.lstatSync = lstat; }
    assert.equal(fs.lstatSync(safe).isSymbolicLink(), true);
    assert.equal(fs.readFileSync(outside, 'utf8'), 'never change'); assert.equal(oldBytes(f), 'old complete runtime');
    f.tx.close();
  });
}

test('materialization is confined to the fresh transaction and does not relax other publisher symlink checks', t => {
  const f = legalFixture(t); const outside = path.join(f.root, 'outside.txt'); fs.writeFileSync(outside, 'keep');
  fs.symlinkSync(outside, path.join(f.tx.staging, 'unrelated-link'));
  assert.throws(() => f.tx.materializeJreLegal(f.current), /not materializable/);
  assert.equal(fs.lstatSync(f.link).isSymbolicLink(), true);
  f.tx.materializeJreLegal(); assert.equal(fs.lstatSync(f.link).isFile(), true);
  assert.throws(() => f.tx.publish(), /link or special/);
  f.tx.close(); assert.equal(oldBytes(f), 'old complete runtime'); assert.equal(fs.readFileSync(outside, 'utf8'), 'keep');
});

for (const mutation of ['target-permissions', 'parent-permissions', 'target-replaced', 'link-replaced']) {
  test(`materializer detects ${mutation} during copying and never promotes partial files`, t => {
    const f = legalFixture(t), read = fs.readSync; let changed = false;
    fs.readSync = (...args) => {
      const result = read(...args);
      if (result && !changed) {
        changed = true;
        if (mutation === 'target-permissions') fs.chmodSync(f.target, 0o644);
        if (mutation === 'parent-permissions') fs.chmodSync(f.module, 0o700);
        if (mutation === 'target-replaced') { fs.renameSync(f.target, path.join(f.base, 'OLD')); fs.writeFileSync(f.target, 'replacement'); }
        if (mutation === 'link-replaced') { fs.unlinkSync(f.link); fs.writeFileSync(f.link, 'replacement link'); }
      }
      return result;
    };
    try { assert.throws(() => f.tx.materializeJreLegal(), /unchanged internal/); }
    finally { fs.readSync = read; }
    assert.equal(changed, true); assert.equal(fs.readdirSync(f.module).some(name => name.startsWith('.ci-legal-')), false);
    if (mutation !== 'link-replaced') assert.equal(fs.lstatSync(f.link).isSymbolicLink(), true);
    else assert.equal(fs.readFileSync(f.link, 'utf8'), 'replacement link');
    assert.equal(oldBytes(f), 'old complete runtime'); f.tx.close();
  });
}

test('changed fresh staging permissions block legal materialization and preserve recovery ownership', t => {
  const f = legalFixture(t); fs.chmodSync(f.tx.staging, 0o755);
  assert.throws(() => f.tx.materializeJreLegal(), /ownership or permissions changed/);
  assert.equal(fs.lstatSync(f.link).isSymbolicLink(), true); f.tx.close();
  assert.equal(fs.existsSync(f.tx.staging), true); assert.equal(oldBytes(f), 'old complete runtime');
});

test('actual staging copy plus bounded PG alias materialization creates independent regular libraries', t => {
  const f = fixture(t), tx = createRuntimeStage(f.stageDirectory);
  const source = path.join(f.root, 'pg-lib'), target = path.join(tx.staging, 'postgres', 'lib');
  fs.mkdirSync(source); const original = path.join(source, 'libpq.5.dylib'); fs.writeFileSync(original, 'synthetic library');
  fs.symlinkSync(original, path.join(source, 'libpq.dylib'));
  const script = fs.readFileSync(path.join(__dirname, '../scripts/stage-runtime.mjs'), 'utf8');
  const helper = script.match(/function copy\(source, destination\) \{[\s\S]*?\n\}/)?.[0]; assert.ok(helper);
  const guardFactory = script.match(/function createStageDestinationGuard\(incoming\) \{[\s\S]*?\n\}/)?.[0]; assert.ok(guardFactory);
  const guardStageDestination = require('node:vm').runInNewContext(`(${guardFactory})`, { fs, path })(tx.staging);
  const copy = require('node:vm').runInNewContext(`(${helper})`, { fs, path, guardStageDestination }); copy(source, target);
  const aliasWasLink = fs.lstatSync(path.join(target, 'libpq.dylib')).isSymbolicLink();
  assert.deepEqual(tx.materializePgAliases(source), { materialized: aliasWasLink ? 1 : 0 });
  for (const name of ['libpq.dylib', 'libpq.5.dylib']) {
    const file = path.join(target, name), stat = fs.lstatSync(file);
    assert.equal(stat.isFile(), true); assert.equal(stat.isSymbolicLink(), false); assert.equal(stat.nlink, 1);
    assert.notEqual(stat.ino, fs.statSync(original).ino); assert.equal(fs.readFileSync(file, 'utf8'), 'synthetic library');
  }
  assert.notEqual(fs.statSync(path.join(target, 'libpq.dylib')).ino, fs.statSync(path.join(target, 'libpq.5.dylib')).ino);
  assert.equal(fs.lstatSync(path.join(source, 'libpq.dylib')).isSymbolicLink(), true);
  assert.deepEqual(tx.materializePgAliases(source), { materialized: 0 });
  tx.publish(); assert.equal(fs.readFileSync(path.join(f.current, 'postgres/lib/libpq.dylib'), 'utf8'), 'synthetic library');
});

function pgAliasesFixture(t) {
  const f = fixture(t), tx = createRuntimeStage(f.stageDirectory), source = path.join(f.root, 'source-lib'), target = path.join(tx.staging, 'postgres', 'lib');
  fs.mkdirSync(source); fs.mkdirSync(target, { recursive: true });
  const mappings = { 'libpq.dylib': 'libpq.5.dylib', 'libpgtypes.dylib': 'libpgtypes.3.dylib',
    'libecpg.dylib': 'libecpg.6.dylib', 'libecpg_compat.dylib': 'libecpg_compat.3.dylib' };
  for (const [name, version] of Object.entries(mappings)) {
    fs.writeFileSync(path.join(source, version), `public synthetic ${version}`, { mode: 0o644 });
    fs.symlinkSync(path.join(source, version), path.join(source, name));
    fs.copyFileSync(path.join(source, version), path.join(target, version));
    fs.symlinkSync(path.join(source, version), path.join(target, name));
  }
  return { ...f, tx, source, target, mappings };
}

test('all four known PG aliases preserve exact bytes and modes without changing source libraries', t => {
  const f = pgAliasesFixture(t);
  const before = new Map(Object.values(f.mappings).map(name => [name, fs.statSync(path.join(f.source, name), { bigint: true })]));
  assert.deepEqual(f.tx.materializePgAliases(f.source), { materialized: 4 });
  for (const [name, version] of Object.entries(f.mappings)) {
    const stat = fs.statSync(path.join(f.target, name));
    assert.equal(stat.nlink, 1); assert.notEqual(stat.ino, fs.statSync(path.join(f.target, version)).ino);
    assert.equal(stat.mode & 0o777, 0o644); assert.deepEqual(fs.readFileSync(path.join(f.target, name)), fs.readFileSync(path.join(f.source, version)));
    const after = fs.statSync(path.join(f.source, version), { bigint: true });
    assert.equal(after.ino, before.get(version).ino); assert.equal(after.ctimeNs, before.get(version).ctimeNs);
  }
  f.tx.publish(); assert.equal(oldBytes({ ...f, current: path.join(f.stageDirectory, retained(f)[0]) }), 'old complete runtime');
});

for (const mutation of ['source-alias-external', 'destination-alias-external', 'different-bytes', 'different-mode', 'target-hardlink', 'source-hardlink',
  'missing-versioned', 'versioned-symlink', 'loop', 'directory', 'writable-target']) {
  test(`PG ${mutation} fails before alias replacement and blocks publication`, t => {
    const f = pgAliasesFixture(t), name = 'libpq.dylib', version = 'libpq.5.dylib';
    const file = path.join(f.target, name), copied = path.join(f.target, version), original = path.join(f.source, version);
    const outside = path.join(f.root, 'outside'); fs.writeFileSync(outside, 'outside remains');
    if (mutation === 'source-alias-external') { fs.unlinkSync(path.join(f.source, name)); fs.symlinkSync(outside, path.join(f.source, name)); }
    if (mutation === 'destination-alias-external') { fs.unlinkSync(file); fs.symlinkSync(outside, file); }
    if (mutation === 'different-bytes') fs.writeFileSync(copied, 'changed bytes');
    if (mutation === 'different-mode') fs.chmodSync(copied, 0o444);
    if (mutation === 'target-hardlink') fs.linkSync(copied, path.join(f.target, 'hard'));
    if (mutation === 'source-hardlink') fs.linkSync(original, path.join(f.source, 'hard'));
    if (mutation === 'missing-versioned') fs.unlinkSync(copied);
    if (mutation === 'versioned-symlink') { fs.unlinkSync(copied); fs.symlinkSync(original, copied); }
    if (mutation === 'loop') { fs.unlinkSync(file); fs.symlinkSync(name, file); }
    if (mutation === 'directory') { fs.unlinkSync(copied); fs.mkdirSync(copied); }
    if (mutation === 'writable-target') fs.chmodSync(copied, 0o666);
    assert.throws(() => f.tx.materializePgAliases(f.source));
    assert.equal(fs.lstatSync(file).isSymbolicLink(), true); assert.equal(fs.readFileSync(outside, 'utf8'), 'outside remains');
    assert.throws(() => f.tx.publish(), /no longer publishable/); f.tx.close(); assert.equal(oldBytes(f), 'old complete runtime');
  });
}

test('unknown PG aliases stay unmodified and the publisher still rejects them', t => {
  const f = pgAliasesFixture(t), unknown = path.join(f.target, 'libfuture.dylib'); fs.symlinkSync('libpq.5.dylib', unknown);
  f.tx.materializePgAliases(f.source); assert.equal(fs.lstatSync(unknown).isSymbolicLink(), true);
  assert.throws(() => f.tx.publish(), /link or special/); f.tx.close(); assert.equal(oldBytes(f), 'old complete runtime');
});

test('an inserted destination link between PG unlink and copy cannot overwrite an outside file', t => {
  const f = pgAliasesFixture(t), copyFile = fs.copyFileSync, outside = path.join(f.root, 'outside'), alias = path.join(f.target, 'libpq.dylib');
  fs.writeFileSync(outside, 'keep exact'); let changed = false;
  fs.copyFileSync = (source, destination, flags) => {
    if (destination === alias && !changed) { changed = true; fs.symlinkSync(outside, destination); }
    return copyFile(source, destination, flags);
  };
  try { assert.throws(() => f.tx.materializePgAliases(f.source)); } finally { fs.copyFileSync = copyFile; }
  assert.equal(changed, true); assert.equal(fs.readFileSync(outside, 'utf8'), 'keep exact');
  assert.equal(fs.lstatSync(alias).isSymbolicLink(), true); assert.throws(() => f.tx.publish(), /no longer publishable/);
  f.tx.close(); assert.equal(fs.readFileSync(outside, 'utf8'), 'keep exact');
});

for (const mutation of ['source-mode', 'staged-bytes', 'alias-replaced']) {
  test(`PG ${mutation} changed after validation is refused before publication`, t => {
    const f = pgAliasesFixture(t), read = fs.readSync, unlink = fs.unlinkSync; let changed = false;
    const alias = path.join(f.target, 'libpq.dylib'), target = path.join(f.target, 'libpq.5.dylib');
    if (mutation === 'source-mode' || mutation === 'alias-replaced') {
      fs.readSync = (...args) => {
        const count = read(...args);
        if (count && !changed) {
          changed = true;
          if (mutation === 'source-mode') fs.chmodSync(path.join(f.source, 'libpq.5.dylib'), 0o444);
          else { fs.unlinkSync(alias); fs.writeFileSync(alias, 'replacement'); }
        }
        return count;
      };
    } else fs.unlinkSync = file => {
      unlink(file);
      if (file === alias && !changed) { changed = true; fs.writeFileSync(target, 'mutated after validation'); }
    };
    try { assert.throws(() => f.tx.materializePgAliases(f.source)); } finally { fs.readSync = read; fs.unlinkSync = unlink; }
    assert.equal(changed, true); assert.throws(() => f.tx.publish(), /no longer publishable/); f.tx.close();
    assert.equal(oldBytes(f), 'old complete runtime');
  });
}
