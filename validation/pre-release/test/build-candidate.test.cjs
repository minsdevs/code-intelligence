'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const crypto = require('node:crypto');
const { argumentsForCandidate, replaceAnalyzerBuild, replaceAnalyzerRuntime } = require('../build-candidate.cjs');
const sha = file => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');

test('candidate argument parsing requires an explicit absolute bundle and ordered build identity', () => {
  assert.deepEqual(argumentsForCandidate(['--app', '/synthetic/Code Intelligence Validation.app', '--build-sequence', '123']),
    { app: '/synthetic/Code Intelligence Validation.app', buildSequence: '123' });
  for (const sequence of ['', '0', '01', '-1', '1\n', '9223372036854775808', '1e3']) {
    assert.throws(() => argumentsForCandidate(['--app', '/synthetic/app', '--build-sequence', sequence]));
  }
  for (const args of [[], ['--app', 'relative', '--build-sequence', '1'], ['--publish', '/app', '--build-sequence', '1'],
    ['--app', '/app', '--build-sequence', '1', '--overwrite'], ['--app', '/app', '--guess', '1']]) {
    assert.throws(() => argumentsForCandidate(args));
  }
});

function fixture(t) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ci-analyzer-stage-')));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.chmodSync(root, 0o700);
  const runtime = path.join(root, 'runtime'), compiled = path.join(root, 'compiled');
  fs.mkdirSync(path.join(runtime, 'ts-analyzer/dist'), { recursive: true, mode: 0o700 });
  fs.mkdirSync(compiled, { mode: 0o700 });
  fs.writeFileSync(path.join(runtime, 'ts-analyzer/dist/stale.js'), 'old');
  fs.writeFileSync(path.join(compiled, 'main.js'), 'new main');
  fs.writeFileSync(path.join(compiled, 'binding.js'), 'new resolver');
  const manifest = { files: { 'ts-analyzer/dist/stale.js': 'old-hash', 'jre/bin/java': 'retained-native-hash' } };
  return { root, runtime, compiled, manifest, plan: { workRoot: root, assertIdentity() { assert.equal(fs.realpathSync(root), root); } } };
}

test('analyzer staging replaces exactly compiled JS, updates inventory and retains the old owned copy', t => {
  const f = fixture(t), result = replaceAnalyzerBuild(f.plan, f.runtime, f.compiled, f.manifest);
  assert.equal(result.evidence.codeRebuilt, true); assert.equal(result.evidence.files, 2);
  assert.equal(result.manifest.files['ts-analyzer/dist/stale.js'], undefined);
  assert.equal(result.manifest.files['jre/bin/java'], 'retained-native-hash');
  assert.deepEqual(fs.readdirSync(path.join(f.runtime, 'ts-analyzer/dist')).sort(), ['binding.js', 'main.js']);
  assert.equal(fs.readFileSync(path.join(f.root, 'previous-analyzer-dist/stale.js'), 'utf8'), 'old');
  assert.equal(f.manifest.files['ts-analyzer/dist/stale.js'], 'old-hash');
});

test('analyzer staging refuses outside source, linked destination and preexisting preserved output before replacement', t => {
  for (const mode of ['outside', 'linked', 'existing']) {
    const f = fixture(t), target = path.join(f.runtime, 'ts-analyzer/dist');
    if (mode === 'existing') fs.mkdirSync(path.join(f.root, 'previous-analyzer-dist'));
    if (mode === 'linked') { fs.renameSync(target, target + '-kept'); fs.symlinkSync(target + '-kept', target); }
    assert.throws(() => replaceAnalyzerBuild(f.plan, f.runtime, mode === 'outside' ? os.tmpdir() : f.compiled, f.manifest));
    assert.equal(fs.readFileSync(path.join(target, 'stale.js'), 'utf8'), 'old');
  }
});

function runtimeFixture(t) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ci-analyzer-runtime-')));
  t.after(() => fs.rmSync(root, { recursive: true, force: true })); fs.chmodSync(root, 0o700);
  const runtime = path.join(root, 'runtime'), compiled = path.join(root, 'compiled'), production = path.join(root, 'production');
  const target = path.join(runtime, 'ts-analyzer');
  for (const directory of [path.join(target, 'dist'), path.join(target, 'node_modules/old'), compiled,
    path.join(production, 'node_modules/proxy-addr')]) fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(target, 'package.json'), JSON.stringify({ name: 'ts-analyzer', version: '0.0.1' }));
  fs.writeFileSync(path.join(target, 'package-lock.json'), JSON.stringify({ name: 'ts-analyzer', version: '0.0.1' }));
  fs.writeFileSync(path.join(target, 'dist/stale.js'), 'old');
  fs.writeFileSync(path.join(target, 'node_modules/old/package.json'), '{"name":"old","version":"1.0.0"}');
  fs.writeFileSync(path.join(compiled, 'main.js'), 'new main'); fs.writeFileSync(path.join(compiled, 'binding.js'), 'new binding');
  const pkg = { name: 'ts-analyzer', version: '0.0.1', dependencies: { 'proxy-addr': '2.0.8' } };
  const lock = { name: 'ts-analyzer', version: '0.0.1', lockfileVersion: 3, packages: {
    '': { name: 'ts-analyzer', version: '0.0.1', dependencies: { 'proxy-addr': '2.0.8' } },
    'node_modules/proxy-addr': { version: '2.0.8' } } };
  fs.writeFileSync(path.join(production, 'package.json'), JSON.stringify(pkg));
  fs.writeFileSync(path.join(production, 'package-lock.json'), JSON.stringify(lock));
  fs.writeFileSync(path.join(production, 'node_modules/proxy-addr/package.json'), JSON.stringify({ name: 'proxy-addr', version: '2.0.8' }));
  const expectedInputs = { packageJsonSha256: sha(path.join(production, 'package.json')),
    packageLockSha256: sha(path.join(production, 'package-lock.json')) };
  const manifest = { files: { 'ts-analyzer/package.json': 'old-package', 'ts-analyzer/package-lock.json': 'old-lock',
    'ts-analyzer/dist/stale.js': 'old-dist', 'ts-analyzer/node_modules/old/package.json': 'old-dependency',
    'jre/bin/java': 'retained-native-hash' } };
  const plan = { workRoot: root, assertIdentity() { assert.equal(fs.realpathSync(root), root); } };
  return { root, runtime, target, compiled, production, expectedInputs, manifest, plan };
}

test('dependency restaging replaces the complete analyzer tree, preserves the old tree and rebuilds its manifest inventory', t => {
  const f = runtimeFixture(t), result = replaceAnalyzerRuntime(f.plan, f.runtime, f.compiled, f.production, f.manifest, f.expectedInputs);
  assert.equal(result.evidence.dependenciesRestaged, true); assert.equal(result.evidence.proxyAddrVersion, '2.0.8');
  assert.equal(result.evidence.files, 2); assert.equal(result.evidence.runtimeFiles, 5);
  assert.equal(result.evidence.productionFiles, 3);
  assert.equal(result.manifest.files['jre/bin/java'], 'retained-native-hash');
  for (const stale of ['ts-analyzer/dist/stale.js', 'ts-analyzer/node_modules/old/package.json'])
    assert.equal(result.manifest.files[stale], undefined);
  for (const name of ['package.json', 'package-lock.json', 'dist/main.js', 'dist/binding.js', 'node_modules/proxy-addr/package.json']) {
    assert.equal(result.manifest.files['ts-analyzer/' + name], sha(path.join(f.target, name)));
  }
  assert.equal(fs.readFileSync(path.join(f.root, 'previous-analyzer-runtime/dist/stale.js'), 'utf8'), 'old');
  assert.equal(fs.readFileSync(path.join(f.target, 'node_modules/proxy-addr/package.json'), 'utf8'),
    fs.readFileSync(path.join(f.production, 'node_modules/proxy-addr/package.json'), 'utf8'));
});

test('dependency restaging refuses a production symlink before changing the staged analyzer', t => {
  const f = runtimeFixture(t), sentinel = fs.readFileSync(path.join(f.target, 'dist/stale.js'), 'utf8');
  fs.symlinkSync('proxy-addr/package.json', path.join(f.production, 'node_modules/proxy-package-link'));
  assert.throws(() => replaceAnalyzerRuntime(f.plan, f.runtime, f.compiled, f.production, f.manifest, f.expectedInputs), /ANALYZER_RUNTIME_LINK/);
  assert.equal(fs.readFileSync(path.join(f.target, 'dist/stale.js'), 'utf8'), sentinel);
  assert.equal(fs.existsSync(path.join(f.root, 'previous-analyzer-runtime')), false);
});

test('dependency restaging refuses overlapping inputs before changing the staged analyzer', t => {
  const f = runtimeFixture(t), sentinel = fs.readFileSync(path.join(f.target, 'dist/stale.js'), 'utf8');
  assert.throws(() => replaceAnalyzerRuntime(f.plan, f.runtime, f.compiled, f.target, f.manifest, f.expectedInputs), /ANALYZER_RUNTIME_PATH_OVERLAP/);
  assert.equal(fs.readFileSync(path.join(f.target, 'dist/stale.js'), 'utf8'), sentinel);
});

test('dependency restaging refuses a preexisting preservation path before changing the staged analyzer', t => {
  const f = runtimeFixture(t), sentinel = fs.readFileSync(path.join(f.target, 'dist/stale.js'), 'utf8');
  fs.mkdirSync(path.join(f.root, 'previous-analyzer-runtime'));
  assert.throws(() => replaceAnalyzerRuntime(f.plan, f.runtime, f.compiled, f.production, f.manifest, f.expectedInputs),
    /ANALYZER_RUNTIME_RESERVED_EXISTS/);
  assert.equal(fs.readFileSync(path.join(f.target, 'dist/stale.js'), 'utf8'), sentinel);
});

test('dependency restaging refuses package bytes changed from the bound input before changing the staged analyzer', t => {
  const f = runtimeFixture(t), sentinel = fs.readFileSync(path.join(f.target, 'dist/stale.js'), 'utf8');
  fs.writeFileSync(path.join(f.production, 'package.json'), JSON.stringify({ name: 'ts-analyzer', version: '0.0.1', changed: true }));
  assert.throws(() => replaceAnalyzerRuntime(f.plan, f.runtime, f.compiled, f.production, f.manifest, f.expectedInputs),
    /ANALYZER_DEPENDENCY_INPUT_CHANGED/);
  assert.equal(fs.readFileSync(path.join(f.target, 'dist/stale.js'), 'utf8'), sentinel);
  assert.equal(fs.existsSync(path.join(f.root, 'prepared-analyzer-runtime')), false);
});

function renameFailureFacade(f, mode) {
  const prepared = path.join(f.root, 'prepared-analyzer-runtime'), previous = path.join(f.root, 'previous-analyzer-runtime');
  const primary = Object.assign(new Error('injected second rename failure'), { code: 'EINJECTED' });
  return { primary, io: {
    lstatSync: fs.lstatSync,
    renameSync(source, destination) {
      if (source === prepared && destination === f.target) {
        if (mode === 'target-appears') fs.mkdirSync(f.target, { mode: 0o700 });
        throw primary;
      }
      if (mode === 'rollback-fails' && source === previous && destination === f.target) {
        throw Object.assign(new Error('injected rollback failure'), { code: 'EROLLBACK' });
      }
      return fs.renameSync(source, destination);
    },
  } };
}

test('second analyzer runtime rename failure restores the verified previous tree and preserves the primary error', t => {
  const f = runtimeFixture(t), injected = renameFailureFacade(f, 'restore');
  let caught; try {
    replaceAnalyzerRuntime(f.plan, f.runtime, f.compiled, f.production, f.manifest, f.expectedInputs, injected.io);
  } catch (error) { caught = error; }
  assert.equal(caught, injected.primary); assert.equal(caught.rollbackCode, 'ANALYZER_RUNTIME_ROLLBACK_RESTORED');
  assert.equal(fs.readFileSync(path.join(f.target, 'dist/stale.js'), 'utf8'), 'old');
  assert.equal(fs.existsSync(path.join(f.root, 'previous-analyzer-runtime')), false);
  assert.equal(fs.existsSync(path.join(f.root, 'prepared-analyzer-runtime')), true);
});

test('failed analyzer runtime rollback retains the verified previous copy and preserves the primary error', t => {
  const f = runtimeFixture(t), injected = renameFailureFacade(f, 'rollback-fails');
  let caught; try {
    replaceAnalyzerRuntime(f.plan, f.runtime, f.compiled, f.production, f.manifest, f.expectedInputs, injected.io);
  } catch (error) { caught = error; }
  assert.equal(caught, injected.primary); assert.equal(caught.rollbackCode, 'ANALYZER_RUNTIME_ROLLBACK_FAILED');
  assert.equal(fs.existsSync(f.target), false);
  assert.equal(fs.readFileSync(path.join(f.root, 'previous-analyzer-runtime/dist/stale.js'), 'utf8'), 'old');
  assert.equal(fs.existsSync(path.join(f.root, 'prepared-analyzer-runtime')), true);
});

test('rollback never overwrites a target that appears after the second analyzer runtime rename fails', t => {
  const f = runtimeFixture(t), injected = renameFailureFacade(f, 'target-appears');
  let caught; try {
    replaceAnalyzerRuntime(f.plan, f.runtime, f.compiled, f.production, f.manifest, f.expectedInputs, injected.io);
  } catch (error) { caught = error; }
  assert.equal(caught, injected.primary); assert.equal(caught.rollbackCode, 'ANALYZER_RUNTIME_ROLLBACK_BLOCKED');
  assert.equal(fs.lstatSync(f.target).isDirectory(), true);
  assert.deepEqual(fs.readdirSync(f.target), []);
  assert.equal(fs.readFileSync(path.join(f.root, 'previous-analyzer-runtime/dist/stale.js'), 'utf8'), 'old');
  assert.equal(fs.existsSync(path.join(f.root, 'prepared-analyzer-runtime')), true);
});
