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
  const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'ci-prepare-contract-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const paths = Object.fromEntries(['parent', 'runtime', 'home', 'temp'].map(name => [name, path.join(root, name)]));
  for (const directory of Object.values(paths)) fs.mkdirSync(directory, { mode: 0o700 });
  const run = args => spawnSync(process.execPath, [script, ...args], { encoding: 'utf8', timeout: 10000,
    env: { HOME: paths.home, TMPDIR: paths.temp, PATH: path.dirname(process.execPath) } });
  return { ...paths, run };
}

test('preparation CLI reports fresh private paths but never launch permission', { skip: process.platform === 'win32' }, t => {
  const f = fixture(t);
  const sentinel = path.join(f.runtime, 'synthetic-runtime');
  fs.writeFileSync(sentinel, 'not executable');
  const args = ['--isolated-run-parent', f.parent, '--isolated-runtime-root', f.runtime];
  const first = f.run(args);
  assert.equal(first.status, 0, first.stderr);
  assert.equal(first.stderr, '');
  const result = JSON.parse(first.stdout);
  assert.equal(result.status, 'PREPARED_BLOCKED');
  assert.equal(result.launchAllowed, false);
  assert.deepEqual(result.blockers, ['CREDENTIAL_STORE_UNVERIFIED', 'SERVICE_ENDPOINT_OWNERSHIP_UNPROVEN']);
  assert.equal(path.dirname(result.root), f.parent);
  assert.equal(result.runtimeRoot, f.runtime);
  const claim = JSON.parse(fs.readFileSync(path.join(result.root, CLAIM_FILE)));
  assert.equal(claim.launchAllowed, false);
  assert.deepEqual(claim.paths, result.paths);
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

test('help describes preparation and leaves the fresh fixture untouched', t => {
  const f = fixture(t);
  const result = f.run(['--help']);
  assert.equal(result.status, 0);
  assert.match(result.stdout, /Does not build or launch Electron/);
  assert.match(result.stdout, /remain unverified/);
  assert.deepEqual(fs.readdirSync(f.parent), []);
});
