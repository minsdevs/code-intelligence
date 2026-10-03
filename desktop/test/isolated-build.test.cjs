'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const test = require('node:test');
const vm = require('node:vm');
const { CLAIM_FILE, prepareBuildWorkspace } = require('../scripts/isolated-build.cjs');
const invalid = { code: 'ISOLATED_BUILD_INVALID' };
const posix = { skip: process.platform === 'win32' };

test('unsupported Windows and accessor inputs refuse without touching files or invoking Git', () => {
  let effects = 0;
  const refusedEffect = () => { effects++; throw new Error('unexpected external effect'); };
  const context = vm.createContext({ module: { exports: {} }, Buffer, process: { platform: 'win32' },
    require(name) {
      if (name === 'node:fs') return new Proxy({}, { get: refusedEffect });
      if (name === 'node:child_process') return { execFileSync: refusedEffect };
      return require(name);
    } });
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../scripts/isolated-build.cjs'), 'utf8'), context);
  const modeled = context.module.exports;
  const accessor = Object.defineProperty({}, 'sourceDirectory', { get: refusedEffect });
  assert.throws(() => modeled.prepareBuildWorkspace(accessor), invalid);
  assert.throws(() => modeled.prepareBuildWorkspace({ sourceDirectory: '/private/source', parentDirectory: '/private/runs' }),
    { code: 'ISOLATED_BUILD_UNSUPPORTED_PLATFORM' });
  assert.equal(effects, 0);
});

function write(root, relative, text) {
  const file = path.join(root, relative);
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  fs.writeFileSync(file, text, { mode: 0o600 });
  return file;
}

// Cleanup only this test's fresh tree, including deliberately read-only snapshots.
function makeDirectoriesWritable(directory) {
  if (!fs.lstatSync(directory).isDirectory()) return;
  fs.chmodSync(directory, 0o700);
  for (const name of fs.readdirSync(directory)) makeDirectoriesWritable(path.join(directory, name));
}

function fixture(t) {
  const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'ci-isolated-build-unit-'));
  t.after(() => { makeDirectoriesWritable(root); fs.rmSync(root, { recursive: true, force: true }); });
  const sourceDirectory = path.join(root, 'repository');
  const parentDirectory = path.join(root, 'runs');
  const home = path.join(root, 'git-home'); const temp = path.join(root, 'git-temp');
  for (const directory of [sourceDirectory, parentDirectory, home, temp]) fs.mkdirSync(directory, { mode: 0o700 });
  const gitEnvironment = { PATH: process.env.PATH, HOME: home, XDG_CONFIG_HOME: home, TMPDIR: temp, TMP: temp, TEMP: temp,
    GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_SYSTEM: '/dev/null', GIT_CONFIG_GLOBAL: '/dev/null', GIT_TERMINAL_PROMPT: '0',
    GIT_AUTHOR_NAME: 'Isolation Fixture', GIT_AUTHOR_EMAIL: 'fixture@example.invalid',
    GIT_COMMITTER_NAME: 'Isolation Fixture', GIT_COMMITTER_EMAIL: 'fixture@example.invalid',
    GIT_AUTHOR_DATE: '2026-01-01T00:00:00Z', GIT_COMMITTER_DATE: '2026-01-01T00:00:00Z', LC_ALL: 'C' };
  const git = (...args) => {
    const result = spawnSync('git', ['-c', 'core.hooksPath=/dev/null', '-c', 'commit.gpgSign=false',
      '-c', 'tag.gpgSign=false', '-c', 'core.fsmonitor=false', '-c', 'core.untrackedCache=false', ...args],
    { cwd: sourceDirectory, env: gitEnvironment, encoding: 'utf8', timeout: 10000 });
    assert.equal(result.error, undefined); assert.equal(result.status, 0, result.stderr);
    return result.stdout.trim();
  };
  const files = {
    'frontend/src/index.js': 'export const fixture = "original frontend";\n',
    'backend/src/main/Fixture.java': 'final class Fixture {}\n',
    'analyzers/ts-analyzer/src/main.ts': 'export const fixture = "original analyzer";\n',
    'desktop/src/main.cjs': 'module.exports = "original desktop";\n',
    'frontend/package.json': '{"name":"synthetic-build-fixture","private":true}\n',
    'frontend/dist/existing.js': 'preserved existing output\n',
    'desktop/stage/runtime/existing': 'preserved existing stage\n',
    'frontend/node_modules/synthetic/index.js': 'preserved existing dependency\n',
    'frontend/.env.synthetic': 'SYNTHETIC_VALUE=not-a-real-secret\n',
    'frontend/.hidden/synthetic': 'excluded hidden file\n',
    'outside/synthetic': 'excluded unrelated source\n',
  };
  for (const [relative, text] of Object.entries(files)) write(sourceDirectory, relative, text);
  git('init', '--quiet'); git('add', '--', '.'); git('commit', '--quiet', '-m', 'Synthetic isolated build fixture');
  const sourceCommit = git('rev-parse', 'HEAD');
  const before = Object.fromEntries(Object.keys(files).map(relative => [relative, fs.statSync(path.join(sourceDirectory, relative)).mtimeMs]));
  const assertOriginal = () => {
    for (const [relative, text] of Object.entries(files)) {
      assert.equal(fs.readFileSync(path.join(sourceDirectory, relative), 'utf8'), text);
      assert.equal(fs.statSync(path.join(sourceDirectory, relative)).mtimeMs, before[relative]);
    }
    assert.equal(git('rev-parse', 'HEAD'), sourceCommit);
  };
  return { root, sourceDirectory, parentDirectory, files, git, sourceCommit, assertOriginal,
    options: { sourceDirectory, parentDirectory } };
}

test('fresh build snapshots only allowed tracked inputs and preserves original source and existing outputs', posix, t => {
  const f = fixture(t); const plan = prepareBuildWorkspace(f.options);
  assert.equal(Object.isFrozen(plan), true); assert.equal(Object.isFrozen(plan.paths), true);
  assert.equal(plan.sourceCommit, f.sourceCommit); assert.equal(path.dirname(plan.root), f.parentDirectory);
  for (const directory of [plan.sourceRoot, plan.workRoot, plan.outputRoot]) assert.equal(path.dirname(directory), plan.root);
  for (const relative of ['frontend/src/index.js', 'backend/src/main/Fixture.java',
    'analyzers/ts-analyzer/src/main.ts', 'desktop/src/main.cjs', 'frontend/package.json']) {
    assert.equal(fs.readFileSync(path.join(plan.sourceRoot, relative), 'utf8'), f.files[relative]);
    assert.equal(fs.readFileSync(path.join(plan.workRoot, relative), 'utf8'), f.files[relative]);
    assert.equal(fs.statSync(path.join(plan.sourceRoot, relative)).mode & 0o222, 0);
    assert.notEqual(fs.statSync(path.join(plan.workRoot, relative)).mode & 0o200, 0);
  }
  for (const relative of ['frontend/dist', 'desktop/stage', 'frontend/node_modules', 'frontend/.env.synthetic', 'frontend/.hidden', 'outside', '.git']) {
    assert.equal(fs.existsSync(path.join(plan.sourceRoot, relative)), false);
    assert.equal(fs.existsSync(path.join(plan.workRoot, relative)), false);
  }
  assert.deepEqual(fs.readdirSync(plan.outputRoot), []);
  assert.doesNotThrow(() => plan.assertIdentity()); f.assertOriginal();
});

test('generated work and output are independent of immutable source and original checkout', posix, t => {
  const f = fixture(t); const plan = prepareBuildWorkspace(f.options);
  write(plan.workRoot, 'frontend/dist/generated.js', 'new generated output');
  write(plan.outputRoot, 'fresh-package/manifest.json', '{"synthetic":true}');
  assert.equal(fs.readFileSync(path.join(plan.sourceRoot, 'frontend/src/index.js'), 'utf8'), f.files['frontend/src/index.js']);
  assert.doesNotThrow(() => plan.assertIdentity()); f.assertOriginal();
});

test('modifying a copied work input never writes through and fails later identity validation', posix, t => {
  const f = fixture(t); const plan = prepareBuildWorkspace(f.options);
  write(plan.workRoot, 'frontend/src/index.js', 'synthetic changed work input');
  assert.equal(fs.readFileSync(path.join(plan.sourceRoot, 'frontend/src/index.js'), 'utf8'), f.files['frontend/src/index.js']);
  assert.throws(() => plan.assertIdentity(), invalid); f.assertOriginal();
});

test('every preparation creates a distinct run and refuses reuse of an already claimed run', posix, t => {
  const f = fixture(t); const first = prepareBuildWorkspace(f.options); const second = prepareBuildWorkspace(f.options);
  assert.notEqual(first.root, second.root); assert.notEqual(first.outputRoot, second.outputRoot);
  assert.throws(() => prepareBuildWorkspace({ ...f.options, parentDirectory: first.root }), invalid);
  assert.throws(() => prepareBuildWorkspace({ ...f.options, parentDirectory: first.outputRoot }), invalid);
  assert.doesNotThrow(() => first.assertIdentity()); assert.doesNotThrow(() => second.assertIdentity()); f.assertOriginal();
});

test('tracked working-tree and staged edits are refused before any run is created', posix, t => {
  for (const staged of [false, true]) {
    const f = fixture(t); write(f.sourceDirectory, 'frontend/src/index.js', 'uncommitted synthetic change');
    if (staged) f.git('add', '--', 'frontend/src/index.js');
    assert.throws(() => prepareBuildWorkspace(f.options), { code: 'ISOLATED_BUILD_DIRTY' });
    assert.deepEqual(fs.readdirSync(f.parentDirectory), []);
    assert.equal(fs.readFileSync(path.join(f.sourceDirectory, 'frontend/src/index.js'), 'utf8'), 'uncommitted synthetic change');
  }
});

test('untracked source and cache files cannot enter the committed snapshot', posix, t => {
  const f = fixture(t); write(f.sourceDirectory, 'frontend/src/untracked.js', 'must remain outside snapshot');
  write(f.sourceDirectory, 'desktop/cache/untracked', 'untracked cache');
  const plan = prepareBuildWorkspace(f.options);
  for (const root of [plan.sourceRoot, plan.workRoot]) assert.equal(fs.existsSync(path.join(root, 'frontend/src/untracked.js')), false);
  assert.doesNotThrow(() => plan.assertIdentity()); f.assertOriginal();
});

test('relative, overlapping and alias paths cannot create a run in an existing source tree', posix, t => {
  const f = fixture(t); const alias = path.join(f.root, 'source-alias'); fs.symlinkSync(f.sourceDirectory, alias);
  for (const options of [
    { ...f.options, sourceDirectory: 'relative-source' }, { ...f.options, parentDirectory: 'relative-parent' },
    { ...f.options, parentDirectory: f.sourceDirectory },
    { ...f.options, parentDirectory: path.join(f.sourceDirectory, 'frontend') },
    { ...f.options, sourceDirectory: alias },
  ]) assert.throws(() => prepareBuildWorkspace(options), invalid);
  assert.deepEqual(fs.readdirSync(f.parentDirectory), []); f.assertOriginal();
});

test('tracked symlinks cannot import files from outside the source checkout', posix, t => {
  const f = fixture(t); const outside = write(f.root, 'outside-sentinel', 'synthetic external content');
  fs.symlinkSync(outside, path.join(f.sourceDirectory, 'frontend/src/external-link'));
  f.git('add', '--', 'frontend/src/external-link'); f.git('commit', '--quiet', '-m', 'Synthetic forbidden link');
  assert.throws(() => prepareBuildWorkspace(f.options), invalid);
  assert.equal(fs.readFileSync(outside, 'utf8'), 'synthetic external content');
});

test('child environment confines writable homes and caches without forwarding host secrets or execution hooks', posix, t => {
  const f = fixture(t); const plan = prepareBuildWorkspace(f.options);
  const names = ['TOKEN', 'GITHUB_TOKEN', 'NODE_OPTIONS', 'JAVA_TOOL_OPTIONS', 'DYLD_INSERT_LIBRARIES'];
  const previous = Object.fromEntries(names.map(name => [name, process.env[name]]));
  try {
    for (const name of names) process.env[name] = 'synthetic-host-value-must-not-leak';
    const env = plan.childEnvironment();
    for (const name of names) assert.equal(Object.hasOwn(env, name), false);
    assert.equal(env.HOME, plan.paths.home); assert.equal(env.TMPDIR, plan.paths.temp);
    assert.equal(env.GRADLE_USER_HOME, plan.paths.gradleHome);
    assert.equal(env.ELECTRON_CACHE, plan.paths.electronCache);
    assert.equal(env.ELECTRON_BUILDER_CACHE, plan.paths.builderCache);
    for (const value of Object.values(env)) assert.equal(String(value).includes('synthetic-host-value-must-not-leak'), false);
    for (const name of ['HOME', 'TMPDIR', 'TMP', 'TEMP', 'GRADLE_USER_HOME', 'ELECTRON_CACHE', 'ELECTRON_BUILDER_CACHE',
      'npm_config_cache', 'npm_config_userconfig', 'npm_config_globalconfig']) {
      assert.equal(env[name].startsWith(plan.root + path.sep), true, name);
    }
  } finally {
    for (const name of names) { if (previous[name] === undefined) delete process.env[name]; else process.env[name] = previous[name]; }
  }
  f.assertOriginal();
});

for (const mutation of ['changed-input', 'extra-input', 'replaced-input-directory']) {
  test(`identity validation refuses ${mutation} while preserving the failed run claim`, posix, t => {
    const f = fixture(t); const plan = prepareBuildWorkspace(f.options);
    const directory = path.join(plan.sourceRoot, 'frontend/src');
    fs.chmodSync(directory, 0o700);
    if (mutation === 'changed-input') {
      const input = path.join(directory, 'index.js'); fs.chmodSync(input, 0o600); fs.writeFileSync(input, 'tampered synthetic input'); fs.chmodSync(input, 0o444);
    } else if (mutation === 'extra-input') write(directory, 'extra.js', 'unrecorded synthetic input');
    else {
      fs.chmodSync(path.dirname(directory), 0o700);
      fs.renameSync(directory, directory + '.old'); fs.mkdirSync(directory, { mode: 0o700 });
    }
    if (mutation !== 'replaced-input-directory') fs.chmodSync(directory, 0o555);
    assert.throws(() => plan.assertIdentity(), invalid);
    assert.throws(() => plan.childEnvironment(), invalid);
    assert.equal(fs.existsSync(path.join(plan.root, CLAIM_FILE)), true);
    f.assertOriginal();
  });
}

test('claim alteration cannot authorize a prepared workspace and leaves evidence in place', posix, t => {
  const f = fixture(t); const plan = prepareBuildWorkspace(f.options);
  const claim = path.join(plan.root, CLAIM_FILE); const record = JSON.parse(fs.readFileSync(claim, 'utf8'));
  assert.equal(record.launchAllowed, false);
  fs.chmodSync(claim, 0o600); fs.writeFileSync(claim, JSON.stringify({ ...record, launchAllowed: true }));
  assert.throws(() => plan.assertIdentity(), invalid);
  assert.equal(fs.existsSync(claim), true); f.assertOriginal();
});
