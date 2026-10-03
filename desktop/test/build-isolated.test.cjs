'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { copyDependencies, dependencyInventory, argumentsForBuild } = require('../scripts/build-isolated.cjs');

function fixture(t) {
  const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'ci-build-copy-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const source = path.join(root, 'dependencies'), workRoot = path.join(root, 'work');
  fs.mkdirSync(source, { mode: 0o700 }); fs.mkdirSync(path.join(workRoot, 'frontend'), { recursive: true, mode: 0o700 });
  fs.mkdirSync(path.join(source, 'synthetic-package'));
  fs.writeFileSync(path.join(source, 'synthetic-package', 'compiler.js'), 'synthetic compiler', { mode: 0o700 });
  return { root, source, workRoot, plan: { workRoot, assertIdentity() {} } };
}

test('copied dependencies and internal bin links cannot write through to original dependencies', t => {
  const f = fixture(t);
  fs.mkdirSync(path.join(f.source, '.bin'));
  fs.symlinkSync('../synthetic-package/compiler.js', path.join(f.source, '.bin', 'compiler'));
  const result = copyDependencies(f.plan, 'frontend', f.source);
  const copied = path.join(f.workRoot, 'frontend', 'node_modules');
  assert.equal(dependencyInventory(f.source).sha256, result.sha256);
  assert.equal(fs.realpathSync(path.join(copied, '.bin', 'compiler')), path.join(copied, 'synthetic-package', 'compiler.js'));
  assert.notEqual(fs.statSync(path.join(copied, 'synthetic-package', 'compiler.js')).ino,
    fs.statSync(path.join(f.source, 'synthetic-package', 'compiler.js')).ino);
  fs.writeFileSync(path.join(copied, '.bin', 'compiler'), 'changed private copy');
  assert.equal(fs.readFileSync(path.join(f.source, 'synthetic-package', 'compiler.js'), 'utf8'), 'synthetic compiler');
  assert.equal(dependencyInventory(f.source).sha256, result.sha256);
});

test('dependency links outside the input tree are refused before copying', t => {
  const f = fixture(t), outside = path.join(f.root, 'outside');
  fs.writeFileSync(outside, 'preserved');
  fs.symlinkSync('../outside', path.join(f.source, 'escape'));
  assert.throws(() => copyDependencies(f.plan, 'frontend', f.source), { code: 'DEPENDENCY_LINK_OUTSIDE' });
  assert.equal(fs.existsSync(path.join(f.workRoot, 'frontend', 'node_modules')), false);
  assert.equal(fs.readFileSync(outside, 'utf8'), 'preserved');
});

test('prior compiler caches are not copied and an existing destination is never overwritten', t => {
  const f = fixture(t);
  for (const name of ['.tmp', '.cache']) {
    fs.mkdirSync(path.join(f.source, name)); fs.writeFileSync(path.join(f.source, name, 'old'), 'preserved');
  }
  copyDependencies(f.plan, 'frontend', f.source);
  const copied = path.join(f.workRoot, 'frontend', 'node_modules');
  assert.deepEqual(fs.readdirSync(copied), ['synthetic-package']);
  assert.throws(() => copyDependencies(f.plan, 'frontend', f.source), { code: 'DEPENDENCY_DESTINATION_EXISTS' });
  assert.equal(fs.readFileSync(path.join(f.source, '.tmp', 'old'), 'utf8'), 'preserved');
});

test('CLI accepts only explicit unique source and parent arguments', () => {
  assert.deepEqual(argumentsForBuild(['--source-root', '/source', '--build-parent', '/runs']),
    { sourceDirectory: '/source', parentDirectory: '/runs' });
  for (const argv of [[], ['--source-root', '/source'], ['--source-root', '/source', '--build-parent'],
    ['--source-root', '/source', '--build-parent', '/runs', '--source-root', '/other'],
    ['--source-root', '/source', '--build-parent', '/runs', '--command', 'arbitrary'],
    ['--source-root', '--build-parent', '/runs']]) {
    assert.throws(() => argumentsForBuild(argv), { code: 'BUILD_ARGUMENT_INVALID' });
  }
});

test('a file growing during a bounded read is refused', t => {
  const f = fixture(t), file = path.join(f.source, 'synthetic-package', 'compiler.js');
  const read = fs.readSync; let changed = false;
  fs.readSync = function (...args) {
    if (!changed) { changed = true; fs.appendFileSync(file, 'concurrent growth'); }
    return read.apply(this, args);
  };
  try { assert.throws(() => dependencyInventory(f.source), { code: 'DEPENDENCY_CHANGED' }); }
  finally { fs.readSync = read; }
});

test('a dependency added after inventory is never copied and causes refusal', t => {
  const f = fixture(t), copied = path.join(f.workRoot, 'frontend', 'node_modules');
  const open = fs.openSync; let added = false;
  fs.openSync = function (file, ...args) {
    if (!added && typeof file === 'string' && file.startsWith(copied + path.sep)) {
      added = true; fs.writeFileSync(path.join(f.source, 'late-file'), 'concurrent dependency');
    }
    return open.call(this, file, ...args);
  };
  try { assert.throws(() => copyDependencies(f.plan, 'frontend', f.source), { code: 'DEPENDENCY_COPY_CHANGED' }); }
  finally { fs.openSync = open; }
  assert.equal(added, true);
  assert.equal(fs.existsSync(path.join(copied, 'late-file')), false);
});

test('oversized sparse dependency is refused before reading or copying its content', t => {
  const f = fixture(t), large = path.join(f.source, 'large');
  fs.writeFileSync(large, ''); fs.truncateSync(large, 512 * 1024 ** 2 + 1);
  assert.throws(() => copyDependencies(f.plan, 'frontend', f.source), { code: 'DEPENDENCY_LIMIT' });
  assert.equal(fs.existsSync(path.join(f.workRoot, 'frontend', 'node_modules')), false);
});
