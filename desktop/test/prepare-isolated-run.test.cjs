'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const test = require('node:test');
const { CLAIM_FILE } = require('../src/isolated-run.cjs');
const script = path.resolve(__dirname, '../scripts/prepare-isolated-run.cjs');

function fixture(t) {
  const base = process.platform === 'darwin' ? '/private/tmp' : fs.realpathSync(os.tmpdir());
  const root = fs.mkdtempSync(path.join(base, 'cipc-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const paths = Object.fromEntries(['parent', 'runtime', 'home', 'temp'].map(name => [name, path.join(root, name)]));
  for (const directory of Object.values(paths)) fs.mkdirSync(directory, { mode: 0o700 });
  const run = args => spawnSync(process.execPath, [script, ...args], { encoding: 'utf8', timeout: 10000,
    env: { HOME: paths.home, TMPDIR: paths.temp, PATH: path.dirname(process.execPath) } });
  return { ...paths, run };
}

test('preparation CLI returns a reusable fixed-identity claim without touching runtime or home', { skip: process.platform === 'win32' }, t => {
  const f = fixture(t);
  const sentinel = path.join(f.runtime, 'synthetic-runtime');
  fs.writeFileSync(sentinel, 'not executable');
  const args = ['--isolated-run-parent', f.parent, '--isolated-runtime-root', f.runtime];
  const first = f.run(args);
  assert.equal(first.status, 0, first.stderr);
  assert.equal(first.stderr, '');
  const result = JSON.parse(first.stdout);
  assert.equal(result.status, 'PREPARED');
  assert.equal(result.launchAllowed, true);
  assert.equal(result.purpose, 'validation');
  assert.deepEqual(result.appIdentity, { name: 'Code Intelligence Validation', appId: 'dev.codeintelligence.desktop.validation' });
  assert.equal(result.claimFile, path.join(result.root, CLAIM_FILE));
  assert.equal(path.dirname(result.root), f.parent);
  assert.equal(result.runtimeRoot, f.runtime);
  const claim = JSON.parse(fs.readFileSync(result.claimFile));
  assert.equal(claim.version, 2); assert.equal(claim.launchAllowed, true);
  assert.deepEqual(claim.paths, result.paths); assert.deepEqual(claim.appIdentity, result.appIdentity);
  for (const directory of Object.values(result.paths)) {
    assert.equal(path.dirname(directory), result.root);
    assert.equal(fs.statSync(directory).mode & 0o777, 0o700);
    assert.deepEqual(fs.readdirSync(directory), []);
  }
  assert.equal(fs.readFileSync(sentinel, 'utf8'), 'not executable');
  assert.deepEqual(fs.readdirSync(f.home), []);
  const second = f.run(args);
  assert.equal(second.status, 0, second.stderr);
  assert.notEqual(JSON.parse(second.stdout).root, result.root);
});

test('preparation CLI refusal is nonzero and excludes supplied private path text', t => {
  const f = fixture(t);
  const result = f.run(['--isolated-run-parent', path.join(f.parent, 'private-sentinel')]);
  assert.equal(result.status, 1);
  assert.equal(result.stdout, '');
  assert.deepEqual(JSON.parse(result.stderr), { status: 'REFUSED', launchAllowed: false, code: 'ISOLATED_RUN_INVALID' });
  assert.deepEqual(fs.readdirSync(f.parent), []);
  assert.equal(f.run([]).status, 1);
});


