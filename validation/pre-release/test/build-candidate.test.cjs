'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { argumentsForCandidate, replaceAnalyzerBuild } = require('../build-candidate.cjs');

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
