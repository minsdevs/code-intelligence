'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { ensureOutputParent, assertOutputPath } = require('../owned-output.cjs');

function fixture(t) {
  const repo = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ci-output-test-')));
  fs.chmodSync(repo, 0o700); t.after(() => fs.rmSync(repo, { recursive: true, force: true }));
  return repo;
}
test('only approved relative output parents are created and existing safe parents are reused', t => {
  const root = fixture(t), expected = path.join(root, 'validation/local/pre-release-candidate');
  assert.equal(ensureOutputParent(root, 'validation/local/pre-release-candidate'), expected);
  assert.equal(ensureOutputParent(root, 'validation/local/pre-release-candidate'), expected);
  assert.equal(fs.statSync(expected).mode & 0o777, 0o700);
  assert.equal(assertOutputPath(expected, path.join(expected, 'result.json')), path.join(expected, 'result.json'));
  for (const relative of ['frontend/src', 'validation/local/../src', 'validation/locality', '/validation/local'])
    assert.throws(() => ensureOutputParent(root, relative), /OWNED_OUTPUT_REFUSED/);
  assert.throws(() => assertOutputPath(expected, path.join(root, 'outside.json')), /OWNED_OUTPUT_REFUSED/);
});

test('a non-writable shared evidence ancestor is allowed but the output family remains private', t => {
  const root = fixture(t); fs.mkdirSync(path.join(root, 'validation/local'), { recursive: true, mode: 0o755 });
  fs.chmodSync(path.join(root, 'validation/local'), 0o755);
  const parent = ensureOutputParent(root, 'validation/local/pre-release-final');
  assert.equal(fs.statSync(parent).mode & 0o777, 0o700);
  fs.chmodSync(parent, 0o755);
  assert.throws(() => ensureOutputParent(root, 'validation/local/pre-release-final'), /OWNED_OUTPUT_REFUSED/);
});
for (const at of ['validation', 'local', 'pre-release-candidate']) test(`a symlink at ${at} is rejected before creating any output in its target`, t => {
  const root = fixture(t), target = path.join(root, 'preserved-source'); fs.mkdirSync(target, { mode: 0o700 });
  let parent = root;
  for (const part of ['validation', 'local', 'pre-release-candidate']) {
    const directory = path.join(parent, part);
    if (part === at) { fs.symlinkSync(target, directory); break; }
    fs.mkdirSync(directory, { mode: 0o700 }); parent = directory;
  }
  assert.throws(() => ensureOutputParent(root, 'validation/local/pre-release-candidate'), /OWNED_OUTPUT_REFUSED/);
  assert.deepEqual(fs.readdirSync(target), []);
});
