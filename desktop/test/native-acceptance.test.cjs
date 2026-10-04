'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { included, requireHosted, copySource } = require('../scripts/native-acceptance.cjs');
const { tapCounts } = require('../scripts/native-acceptance-windows.cjs');

const hosted = () => ({ GITHUB_ACTIONS: 'true', RUNNER_ENVIRONMENT: 'github-hosted', GITHUB_EVENT_NAME: 'workflow_dispatch',
  NATIVE_ACCEPTANCE_CONSENT: 'disposable-hosted-os', GITHUB_SHA: 'a'.repeat(40),
  CODE_INTELLIGENCE_BUILD_SEQUENCE: '123', RUNNER_TEMP: os.tmpdir(), GITHUB_WORKSPACE: os.tmpdir() });

test('native TAP evidence requires complete unambiguous numeric counters', () => {
  const tap = '# tests 6\n# pass 6\n# fail 0\n# cancelled 0\n# skipped 0\n# todo 0\n';
  assert.deepEqual(tapCounts(tap), { tests: 6, pass: 6, fail: 0, cancelled: 0, skipped: 0, todo: 0 });
  assert.throws(() => tapCounts(''));
  assert.throws(() => tapCounts(tap + '# pass 6\n'));
  assert.throws(() => tapCounts(tap.replace('# fail 0\n', '')));
});

test('acceptance rejects local/self-hosted, automatic events, missing consent, invalid sequence and injected Node options', () => {
  requireHosted(hosted(), 'darwin', 'arm64');
  requireHosted(hosted(), 'win32', 'x64');
  for (const patch of [
    { GITHUB_ACTIONS: 'false' }, { RUNNER_ENVIRONMENT: 'self-hosted' }, { GITHUB_EVENT_NAME: 'push' },
    { NATIVE_ACCEPTANCE_CONSENT: '' }, { CODE_INTELLIGENCE_BUILD_SEQUENCE: '01' },
    { CODE_INTELLIGENCE_BUILD_SEQUENCE: '9223372036854775808' }, { CODE_INTELLIGENCE_BUILD_SEQUENCE: '1;exit' },
    { GITHUB_SHA: 'branch-name' }, { RUNNER_TEMP: 'relative' }, { NODE_OPTIONS: '--require injected.cjs' },
    { ELECTRON_RUN_AS_NODE: '1' }, { CODE_INTELLIGENCE_ISOLATED_RUN: '1' },
  ]) assert.throws(() => requireHosted({ ...hosted(), ...patch }, 'darwin', 'arm64'));
  assert.throws(() => requireHosted(hosted(), 'darwin', 'x64'));
  assert.throws(() => requireHosted(hosted(), 'linux', 'x64'));
});

test('pre-merge execution accepts only same-repository head and target', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'native-acceptance-event-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const file = path.join(root, 'event.json');
  const env = { ...hosted(), GITHUB_EVENT_NAME: 'pull_request', GITHUB_EVENT_PATH: file, GITHUB_REPOSITORY: 'owner/repo' };
  const event = { pull_request: { head: { repo: { full_name: 'owner/repo' } }, base: { repo: { full_name: 'owner/repo' } } } };
  fs.writeFileSync(file, JSON.stringify(event)); requireHosted(env, 'darwin', 'arm64');
  event.pull_request.head.repo.full_name = 'fork/repo';
  fs.writeFileSync(file, JSON.stringify(event)); assert.throws(() => requireHosted(env, 'darwin', 'arm64'));
  event.pull_request.head.repo.full_name = 'owner/repo'; event.pull_request.base.repo.full_name = 'other/repo';
  fs.writeFileSync(file, JSON.stringify(event)); assert.throws(() => requireHosted(env, 'darwin', 'arm64'));
});

test('fresh source selection excludes dependencies, ignored outputs, credentials and original product data', () => {
  for (const relative of ['desktop/src/main.cjs', 'desktop/build/entitlements.mac.plist',
    'desktop/native/windows/CMakeLists.txt', 'backend/gradle/wrapper/gradle-wrapper.jar', 'frontend/package-lock.json']) assert.equal(included(relative), true, relative);
  for (const relative of ['desktop/stage/runtime/java', 'desktop/dist/product.app', 'backend/build/app.jar',
    'backend/.gradle/cache', '.repowise/wiki.db', 'desktop/node_modules/electron', 'analyzers/ts-analyzer/dist/index.js',
    'frontend/.env', 'desktop/secrets/secret.json', 'desktop/userData/cache', 'desktop/certificate.p12',
    'desktop/test-results/result.json']) assert.equal(included(relative), false, relative);
});

test('fresh source copy preserves current bytes/executable permissions and refuses reuse or links', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'native-acceptance-test-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const source = path.join(root, 'checkout'); fs.mkdirSync(source);
  for (const directory of ['desktop', 'frontend', 'backend', 'analyzers/ts-analyzer']) fs.mkdirSync(path.join(source, directory), { recursive: true });
  fs.writeFileSync(path.join(source, 'desktop', 'current.cjs'), 'current source');
  fs.writeFileSync(path.join(source, 'backend', 'gradlew'), '#!/bin/sh\nexit 0\n', { mode: 0o700 });
  fs.mkdirSync(path.join(source, 'desktop', 'stage')); fs.writeFileSync(path.join(source, 'desktop', 'stage', 'preserve'), 'old output');
  const destination = path.join(root, 'copy');
  const result = copySource(source, destination);
  assert.equal(result.files, 2); assert.match(result.sha256, /^[a-f0-9]{64}$/);
  assert.equal(fs.readFileSync(path.join(destination, 'desktop', 'current.cjs'), 'utf8'), 'current source');
  assert.equal(fs.existsSync(path.join(destination, 'desktop', 'stage')), false);
  assert.equal(fs.readFileSync(path.join(source, 'desktop', 'stage', 'preserve'), 'utf8'), 'old output');
  assert.throws(() => copySource(source, destination));
  if (process.platform !== 'win32') {
    assert.ok(fs.statSync(path.join(destination, 'backend', 'gradlew')).mode & 0o100);
    fs.symlinkSync(path.join(source, 'desktop', 'current.cjs'), path.join(source, 'desktop', 'link.cjs'));
    assert.throws(() => copySource(source, path.join(root, 'linked-copy')));
  }
});
