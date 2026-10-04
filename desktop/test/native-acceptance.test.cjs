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

test('output exclusion never removes real source packages named stage, coverage, dist or build', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'native-source-packages-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const source = path.join(root, 'checkout'); fs.mkdirSync(source);
  for (const directory of ['desktop', 'frontend', 'backend', 'analyzers/ts-analyzer']) fs.mkdirSync(path.join(source, directory), { recursive: true });
  const sources = ['backend/src/main/java/dev/example/coverage/Coverage.java', 'backend/src/main/java/dev/example/job/stage/Stage.java',
    'frontend/src/features/coverage/Feature.tsx', 'backend/src/main/java/dev/example/build/Build.java', 'analyzers/ts-analyzer/src/dist/node.ts'];
  for (const file of sources) {
    assert.equal(included(file), true, file);
    fs.mkdirSync(path.dirname(path.join(source, file)), { recursive: true }); fs.writeFileSync(path.join(source, file), 'public source');
  }
  for (const file of ['backend/build/app.jar', 'frontend/coverage/result.json', 'frontend/dist/index.html',
    'desktop/stage/runtime/java', 'analyzers/ts-analyzer/dist/index.js', 'frontend/src/node_modules/secret.js']) assert.equal(included(file), false, file);
  const destination = path.join(root, 'copy'); assert.equal(copySource(source, destination).files, sources.length);
  for (const file of sources) assert.equal(fs.readFileSync(path.join(destination, file), 'utf8'), 'public source');
});

test('build diagnostics retain compiler IDs and public locations, not source, secrets, paths or runtime logs', t => {
  const { buildDiagnostics } = require('../scripts/native-acceptance.cjs');
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'native-diagnostics-')));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const relative = 'backend/src/main/java/dev/example/stage/Stage.java';
  const file = path.join(root, relative);
  fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, 'public source');
  const result = buildDiagnostics('> npm run build\n> ./gradlew bootJar\n', [
    file + ':42: error: cannot find symbol', '  symbol: class MissingStage',
    'error: package dev.example.coverage does not exist', 'error TS2345: secret source text',
    'Native runtime publication blocked: MINIMUM_OS_EXCEEDED [postgres/private.dylib]: 15.0 > 13.0',
    'https://user:password@example.invalid SECRET_KEY=private-token', 'runtime-source-body private-token',
    '/private/unknown.java:33: error: should not escape',
  ].join('\n'), root);
  assert.equal(result.lastBuildStep, 'backend-boot-jar');
  assert.deepEqual(result.compilerCodes, ['TS2345']); assert.deepEqual(result.policyCodes, ['MINIMUM_OS_EXCEEDED']);
  assert.deepEqual(result.javaSymbols, ['MissingStage']); assert.deepEqual(result.missingPackages, ['dev.example.coverage']);
  assert.deepEqual(result.locations, [{ file: relative, line: 42 }]);
  for (const privateText of [root, 'password', 'private-token', 'secret source text', 'private.dylib', 'runtime-source-body', 'unknown.java'])
    assert.equal(JSON.stringify(result).includes(privateText), false, privateText);
});

test('runtime command failures remain opaque and build diagnostics require explicit opt-in', () => {
  const { run } = require('../scripts/native-acceptance.cjs');
  const args = ['-e', 'process.stderr.write("error TS2345: private-token");process.exit(2)'];
  assert.throws(() => run(process.execPath, args, process.cwd()), error => {
    assert.equal(error.exitStatus, 2); assert.equal(error.commandEvidence.buildDiagnostics, undefined);
    assert.equal(JSON.stringify(error).includes('private-token'), false); return true;
  });
  assert.throws(() => run(process.execPath, args, process.cwd(), process.env, { buildDiagnostics: true }), error => {
    assert.deepEqual(error.commandEvidence.buildDiagnostics.compilerCodes, ['TS2345']);
    assert.equal(JSON.stringify(error).includes('private-token'), false); return true;
  });
});

test('private native closure preserves transitive dylibs and runs without the build prefix', {
  skip: process.platform !== 'darwin' || process.arch !== 'arm64',
}, t => {
  const { run, relocateMacLibraries } = require('../scripts/native-acceptance.cjs');
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'native-closure-unit-')));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const prefix = path.join(root, 'prefix'); fs.mkdirSync(prefix, { mode: 0o700 });
  const libraries = path.join(prefix, 'openssl', 'lib'); fs.mkdirSync(libraries, { recursive: true });
  const base = path.join(libraries, 'libproofbase.dylib'), leaf = path.join(libraries, 'libproofleaf.dylib');
  const flags = ['-arch', 'arm64', '-mmacosx-version-min=13.0', '-Wl,-headerpad_max_install_names'];
  const build = (name, source, args) => {
    const file = path.join(root, name + '.c'); fs.writeFileSync(file, source);
    run('/usr/bin/clang', [...flags, file, ...args], root);
  };
  build('base', 'int proofbase(void) { return 42; }', ['-dynamiclib', '-Wl,-install_name,@loader_path/libproofbase.dylib', '-o', base]);
  build('leaf', 'extern int proofbase(void); int proofleaf(void) { return proofbase(); }',
    ['-dynamiclib', base, '-Wl,-install_name,@rpath/libproofleaf.dylib', '-o', leaf]);
  for (const component of ['postgres', 'redis']) {
    const bin = path.join(prefix, component, 'bin'); fs.mkdirSync(bin, { recursive: true });
    build(component, 'extern int proofleaf(void); int main(void) { return proofleaf() == 42 ? 0 : 1; }',
      [leaf, '-Wl,-rpath,' + libraries, '-o', path.join(bin, 'proof')]);
  }
  const evidence = relocateMacLibraries(prefix);
  assert.deepEqual(evidence.map(item => item.nativeFiles), [3, 3]);
  for (const item of evidence) { assert.equal(item.minimumSystemVersion, '13.0'); assert.match(item.sha256, /^[a-f0-9]{64}$/); }
  fs.renameSync(path.join(prefix, 'openssl'), path.join(prefix, 'unavailable-original-libraries'));
  for (const component of ['postgres', 'redis']) run(path.join(prefix, component, 'bin', 'proof'), [], root);
  const read = component => fs.readFileSync(path.join(prefix, component, 'lib', 'libproofbase.dylib'));
  assert.deepEqual(read('postgres'), read('redis'), 'Closure copies remain byte-identical for the publication collision gate');
});

test('direct native Electron runner refuses local use before importing or launching Electron', async () => {
  const { runMac } = require('../scripts/native-acceptance-electron.cjs');
  await assert.rejects(runMac({ env: { ...hosted(), GITHUB_ACTIONS: 'false' } }), /Hosted workflow required/);
});
