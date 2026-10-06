'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { included, requireHosted, copySource } = require('../scripts/native-acceptance.cjs');
const { tapCounts } = require('../scripts/native-acceptance-windows.cjs');
const { selectAdoptiumPackage } = require('../scripts/native-acceptance-host.cjs');

const hosted = () => ({ GITHUB_ACTIONS: 'true', RUNNER_ENVIRONMENT: 'github-hosted', GITHUB_EVENT_NAME: 'workflow_dispatch',
  NATIVE_ACCEPTANCE_CONSENT: 'disposable-hosted-os', GITHUB_SHA: 'a'.repeat(40),
  CODE_INTELLIGENCE_BUILD_SEQUENCE: '123', RUNNER_TEMP: os.tmpdir(), GITHUB_WORKSPACE: os.tmpdir() });

test('host JDK selection accepts only checksum-bound Temurin 21 macOS archives', () => {
  const valid = { vendor: 'eclipse', version: { major: 21 }, binary: {
    architecture: 'aarch64', os: 'mac', image_type: 'jdk', jvm_impl: 'hotspot', package: {
      name: 'OpenJDK21U-jdk_aarch64_mac_hotspot_21.0.12.1_1.tar.gz', checksum: 'a'.repeat(64),
      link: 'https://github.com/adoptium/temurin21-binaries/releases/download/jdk-21.0.12.1%2B1/archive.tar.gz'
    }
  } };
  assert.deepEqual(selectAdoptiumPackage([valid]), {
    name: valid.binary.package.name, checksum: valid.binary.package.checksum, link: valid.binary.package.link
  });
  for (const patch of [
    { version: { major: 22 } }, { vendor: 'other' },
    { binary: { ...valid.binary, architecture: 'x64' } },
    { binary: { ...valid.binary, package: { ...valid.binary.package, checksum: 'latest' } } },
    { binary: { ...valid.binary, package: { ...valid.binary.package, name: '../jdk.tar.gz' } } },
    { binary: { ...valid.binary, package: { ...valid.binary.package, link: 'http://github.com/archive.tar.gz' } } },
    { binary: { ...valid.binary, package: { ...valid.binary.package, link: 'https://example.invalid/archive.tar.gz' } } },
  ]) assert.throws(() => selectAdoptiumPackage([{ ...valid, ...patch }]));
});

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
  for (const relative of ['desktop/stage/runtime/java', 'desktop/dist/product.app', 'desktop/dist-validation/product.app', 'backend/build/app.jar',
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

test('native linker diagnostics retain only bounded public enums, never raw linker inputs', () => {
  const { buildDiagnostics } = require('../scripts/native-acceptance.cjs');
  const text = [
    'Undefined symbols for architecture arm64:',
    '  "_private_token", referenced from:',
    '      /Users/private/project/private-object.o',
    'ld: symbol(s) not found for architecture arm64',
    'ld: library not found for -lssl',
    "ld: library 'crypto' not found",
    "ld: library 'credential-private-token' not found",
    'make[2]: *** [redis-server] Error 1',
    'make: *** [private-target] Error 2',
    'https://user:password@example.invalid private-token',
  ].join('\n');
  const result = buildDiagnostics('', text);
  assert.deepEqual(result.nativeLink, {
    reasons: ['undefined-symbols', 'library-not-found'], architectures: ['arm64'],
    missingLibraries: ['ssl', 'crypto'], failedTargets: ['redis-server'], rejectedDriverFlags: [],
  });
  assert.ok(result.categories.includes('native-link'));
  assert.deepEqual(buildDiagnostics('', text.repeat(100)).nativeLink, result.nativeLink);
  for (const secret of ['private_token', '/Users/', 'private-object', 'credential-', 'private-target', 'password', 'private-token'])
    assert.equal(JSON.stringify(result).includes(secret), false, secret);
  assert.deepEqual(buildDiagnostics().nativeLink, { reasons: [], architectures: [], missingLibraries: [], failedTargets: [], rejectedDriverFlags: [] });
});

test('native linker diagnostics distinguish toolchain, architecture and duplicate-symbol failures', () => {
  const { buildDiagnostics } = require('../scripts/native-acceptance.cjs');
  const result = buildDiagnostics('', [
    'ld: 2 duplicate symbols for architecture arm64',
    'ld: ignoring file /private/object.o: incompatible architecture',
    'object was built for newer macOS version (15.0) than being linked (13.0)',
    'ld: unknown option: --private-token',
    'ld: Assertion failed: private compiler contents',
  ].join('\n'));
  assert.deepEqual(result.nativeLink.reasons, ['duplicate-symbols', 'architecture-mismatch', 'deployment-target-mismatch', 'unsupported-option', 'linker-crash']);
  assert.equal(JSON.stringify(result).includes('private'), false);
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

test('native closure artifacts retain bounded staged edges but reject absolute paths and malformed records', () => {
  const { buildDiagnostics } = require('../scripts/native-acceptance.cjs');
  const edge = { file: 'jre/lib/libjli.dylib', reference: '@rpath/libjvm.dylib',
    rpaths: [{ kind: 'loader', directory: 'jre/lib/server' }] };
  const record = item => 'NATIVE_STAGE_CLOSURE ' + JSON.stringify(item) + '\n';
  const rejected = [
    { ...edge, file: '/private/libjli.dylib' }, { ...edge, file: 'jre/../../private/libjli.dylib' },
    { ...edge, reference: '/Users/private/libjvm.dylib' }, { ...edge, reference: '@rpath/../../private.dylib' },
    { ...edge, reference: '@loader_path/../../../../private.dylib' },
    { ...edge, reference: '@rpath/libjvm.dylib\nprivate-secret' },
    { ...edge, rpaths: [{ kind: 'loader', directory: '/private/directory' }] },
    { ...edge, rpaths: [{ kind: 'private-kind', directory: 'jre/lib' }] },
    { ...edge, rpaths: Array(17).fill(edge.rpaths[0]) },
    { ...edge, privateKey: 'private-secret' }, { ...edge, file: 'jre/lib/' + 'x'.repeat(256) },
  ];
  const text = record(edge).repeat(20) + rejected.map(record).join('') + 'NATIVE_STAGE_CLOSURE {invalid json}\n';
  assert.deepEqual(buildDiagnostics('', text).nativeClosure, [edge]);
  assert.deepEqual(buildDiagnostics('', text.replaceAll('\n', '\r\n')).nativeClosure, [edge]);
  assert.equal(JSON.stringify(buildDiagnostics('', text)).includes('private'), false);
  const many = Array.from({ length: 20 }, (_, index) => ({ ...edge, file: 'jre/lib/lib' + index + '.dylib' }));
  assert.deepEqual(buildDiagnostics(many.map(record).join('')).nativeClosure, many.slice(0, 12));
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

test('direct native Electron runner refuses unauthenticated local use before importing or launching Electron', async () => {
  const { runProduct } = require('../scripts/native-acceptance-electron.cjs');
  await assert.rejects(runProduct({ env: { ...hosted(), GITHUB_ACTIONS: 'false' } }), /Hosted workflow required/);
});

test('one product deadline survives successful steps and refuses late mutations', async t => {
  const { createDeadline } = require('../scripts/native-acceptance-electron.cjs');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'native-deadline-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const file = path.join(root, 'acknowledged');
  let now = 0; const budget = createDeadline(100, () => now);
  await budget.run(() => fs.writeFileSync(file, 'first'));
  now = 60;
  await budget.run(() => fs.writeFileSync(file, 'second'));
  const late = budget.run(() => fs.writeFileSync(file, 'late'));
  now = 101;
  await assert.rejects(late, /NATIVE_PRODUCT_DEADLINE/);
  await assert.rejects(budget.run(() => fs.unlinkSync(file)), /NATIVE_PRODUCT_DEADLINE/);
  assert.equal(fs.readFileSync(file, 'utf8'), 'second');
});

test('a failed product operation blocks later actions and preserves its primary error', async () => {
  const { createDeadline } = require('../scripts/native-acceptance-electron.cjs');
  const budget = createDeadline(100, () => 0), primary = new Error('FIRST_STEP_FAILED');
  await assert.rejects(budget.run(() => { throw primary; }), error => error === primary);
  await assert.rejects(budget.run(() => { throw new Error('MUST_NOT_EXECUTE'); }), error => error === primary);
});

test('startup evidence accepts fragmented static records but no raw details or oversized tails', () => {
  const { PassThrough } = require('node:stream');
  const { observeStartup } = require('../scripts/native-acceptance-electron.cjs');
  const child = { stderr: new PassThrough() }, report = {};
  const stop = observeStartup(child, report, () => {});
  child.stderr.write('private-token\nDESKTOP_STAR'); child.stderr.write('TUP TLS\r\n');
  assert.deepEqual(report.startup, { phase: 'TLS', state: 'RUNNING' });
  child.stderr.write('x'.repeat(1024) + 'DESKTOP_STARTUP BACKEND\n');
  child.stderr.write('DESKTOP_STARTUP /Users/private\nDESKTOP_STARTUP TLS FAILED private-token\n');
  assert.deepEqual(report.startup, { phase: 'TLS', state: 'RUNNING' });
  child.stderr.write('DESKTOP_STARTUP SAFETY FAILED SAFETY_RECOVERY_REQUIRED\nDESKTOP_STARTUP READY\n');
  assert.deepEqual(report.startup, { phase: 'SAFETY', state: 'FAILED', code: 'SAFETY_RECOVERY_REQUIRED' });
  assert.equal(JSON.stringify(report).includes('private'), false);
  stop(); child.stderr.end();
});

test('shutdown observation records bounded phase timings and preserves the first failure', () => {
  const { PassThrough } = require('node:stream');
  const { observeStartup } = require('../scripts/native-acceptance-electron.cjs');
  const child = { stderr: new PassThrough() }, report = {}; let now = 100;
  const stop = observeStartup(child, report, () => {}, () => now);
  child.stderr.write('DESKTOP_SHUT'); child.stderr.write('DOWN QUEUED\r\n');
  now = 124; child.stderr.write('DESKTOP_SHUTDOWN BACKEND\n');
  now = 135; child.stderr.write('DESKTOP_SHUTDOWN BACKEND FAILED SAFETY_RECOVERY_REQUIRED\n');
  now = 145; child.stderr.write('DESKTOP_SHUTDOWN REDIS\nDESKTOP_SHUTDOWN COMPLETE\n');
  assert.deepEqual(report.shutdown, { phase: 'BACKEND', state: 'FAILED', code: 'SAFETY_RECOVERY_REQUIRED', elapsedMs: 35 });
  assert.deepEqual(report.shutdownTrace.map(row => row.elapsedMs), [0, 24, 35, 45, 45]);
  for (let index = 0; index < 100; index++) child.stderr.write('DESKTOP_SHUTDOWN REDIS\n');
  assert.equal(report.shutdownTrace.length, 32);
  assert.equal(report.shutdown.phase, 'BACKEND');
  stop(); assert.equal(child.stderr.listenerCount('data'), 0); child.stderr.end();
});

test('shutdown diagnostics cannot persist arbitrary error text, paths or oversize prefixes', () => {
  const { PassThrough } = require('node:stream');
  const { parseShutdownLine } = require('../src/startup-diagnostics.cjs');
  const { observeStartup } = require('../scripts/native-acceptance-electron.cjs');
  const child = { stderr: new PassThrough() }, report = {};
  const stop = observeStartup(child, report, () => {}, () => 1);
  for (const line of ['DESKTOP_SHUTDOWN /Users/private', 'DESKTOP_SHUTDOWN BACKEND private-token',
    'DESKTOP_SHUTDOWN BACKEND FAILED private-token', 'DESKTOP_SHUTDOWN COMPLETE FAILED SAFETY_RECOVERY_REQUIRED',
    'DESKTOP_SHUTDOWN BACKEND FAILED SAFETY_RECOVERY_REQUIRED /Users/private', 'x'.repeat(1024) + 'DESKTOP_SHUTDOWN COMPLETE']) {
    assert.equal(parseShutdownLine(line), null); child.stderr.write(line + '\n');
  }
  assert.deepEqual(report, {});
  child.stderr.write('DESKTOP_SHUTDOWN COMPLETE\n');
  assert.deepEqual(report.shutdown, { phase: 'COMPLETE', state: 'COMPLETE', elapsedMs: 0 });
  assert.doesNotMatch(JSON.stringify(report), /private|token/);
  stop(); child.stderr.end();
});

test('Windows policy evidence keeps public binary identity but rejects private or injected fields', () => {
  const { buildDiagnostics } = require('../scripts/native-acceptance.cjs');
  const { parsePe } = require('../scripts/windows-pe-policy.cjs');
  let failure;
  try { parsePe(Buffer.from('MZ'), 'cache/coreclr.dll'); } catch (error) { failure = error; }
  assert.equal(failure.code, 'INVALID_PE');
  const record = value => 'NATIVE_WINDOWS_POLICY ' + JSON.stringify(value) + '\n';
  const rejected = [
    { code: 'PRIVATE_SECRET', file: 'cache/coreclr.dll' },
    { ...failure.publicPolicy, file: '/Users/private/coreclr.dll' },
    { ...failure.publicPolicy, file: 'cache/../../private.dll' },
    { ...failure.publicPolicy, file: 'cache/coreclr.dll\nprivate-token' },
    { ...failure.publicPolicy, reference: 'C:\\private\\secret.dll' },
    { ...failure.publicPolicy, secret: 'private-token' },
  ];
  const report = buildDiagnostics(record(failure.publicPolicy).repeat(16) + rejected.map(record).join(''));
  assert.deepEqual(report.windowsPolicy, [{ code: 'INVALID_PE', file: 'cache/coreclr.dll' }]);
  assert.equal(JSON.stringify(report).includes('private'), false);
  const many = Array.from({ length: 20 }, (_, i) => ({ code: 'INVALID_PE', file: 'cache/library' + i + '.dll' }));
  assert.deepEqual(buildDiagnostics(many.map(record).join('')).windowsPolicy, many.slice(0, 12));
});

test('macOS provisioning failure report bounds log reads and records source versions without raw text', t => {
  const { recordProvisioningFailure } = require('../scripts/native-acceptance.cjs');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'native-provision-diagnostics-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.writeFileSync(path.join(root, 'build-output'), "ld: library 'early' not found\n" + 'private-token\n'.repeat(30000) + "ld: library 'ssl' not found\n");
  fs.writeFileSync(path.join(root, 'redis-source.json'), JSON.stringify({ version: '8.10.2', sourceSha256: 'a'.repeat(64), sourceUrl: 'https://user:password@example.invalid' }));
  fs.writeFileSync(path.join(root, 'postgres-source.json'), JSON.stringify({ version: '16.15/private-token', sourceSha256: 'b'.repeat(64) }));
  fs.writeFileSync(path.join(root, 'openssl-source.json'), JSON.stringify({ version: '3.6.0', sourceSha256: 'private-token' }));
  const artifact = path.join(root, 'provisioning.json');
  const executionContext = { kind: 'disposable-macos-vm', provider: 'tart-apple-virtualization' };
  fs.writeFileSync(artifact, JSON.stringify({ status: 'RUNNING', executionContext }));
  recordProvisioningFailure({ work: root, step: 'redis-build', exitCode: 2, artifact });
  const report = JSON.parse(fs.readFileSync(artifact, 'utf8'));
  assert.equal(report.status, 'FAIL'); assert.equal(report.step, 'redis-build'); assert.equal(report.exitCode, 2);
  assert.deepEqual(report.executionContext, executionContext);
  assert.equal(report.logBytes, fs.statSync(path.join(root, 'build-output')).size);
  assert.equal(report.diagnosticsTruncated, true);
  assert.deepEqual(report.sources, { redis: { version: '8.10.2', sha256: 'a'.repeat(64) } });
  assert.deepEqual(report.diagnostics.nativeLink.missingLibraries, ['ssl']);
  for (const value of [root, 'private-token', 'password', 'https://']) assert.equal(JSON.stringify(report).includes(value), false);
});


test('native storage probe uses the automation identity before ready in both processes', t => {
  const vm = require('node:vm');
  const identities = require('../src/isolated-run.cjs').VALIDATION_IDENTITIES;
  const contexts = require('../scripts/native-acceptance-context.cjs');
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'native-probe-identity-')));
  fs.chmodSync(root, 0o700);
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const directory = path.join(root, 'probe'); fs.mkdirSync(directory, { mode: 0o700 });
  const source = fs.readFileSync(path.join(__dirname, '../scripts/native-acceptance-safe-storage.cjs'), 'utf8');
  for (const mode of ['write', 'read']) {
    let name; const paths = {};
    const app = {
      setName(value) { name = value; },
      setPath(key, value) { paths[key] = value; },
      setAppLogsPath(value) { paths.logs = value; },
      whenReady() {
        assert.equal(name, identities.automation.name);
        assert.notEqual(name, identities.validation.name);
        assert.equal(paths.userData, path.join(directory, 'electron-profile'));
        for (const value of Object.values(paths)) contexts.privateDescendant(directory, value);
        // Exercise all pre-ready setup without accessing the OS credential store.
        return { then() { return { catch() {} }; } };
      },
    };
    vm.runInNewContext(source, {
      process: { argv: ['electron', 'probe', mode, directory] },
      require: name => name === 'electron' ? { app, safeStorage: {} }
        : name === './native-acceptance-context.cjs' ? {
          ...contexts, requireExecutionContext: () => ({ kind: 'isolated-macos-host', tempRoot: root }),
        } : name === '../src/isolated-run.cjs' ? { VALIDATION_IDENTITIES: identities } : require(name),
    });
  }
});

test('native linker diagnostics explain reproduced Darwin test-module driver flag failure', () => {
  const { buildDiagnostics } = require('../scripts/native-acceptance.cjs');
  const result = buildDiagnostics('', [
    'ld: unknown options: -mmacosx-version-min=13.0 -Wl,-headerpad_max_install_names -private-token',
    'make[2]: *** [commandfilter.so] Error 1',
    'make[1]: *** [module_tests] Error 2',
    'make: *** [build] Error 1',
  ].join('\n'));
  assert.deepEqual(result.nativeLink, {
    reasons: ['unsupported-option'], architectures: [], missingLibraries: [],
    failedTargets: ['module_tests', 'commandfilter.so', 'build'],
    rejectedDriverFlags: ['-mmacosx-version-min=13.0', '-Wl,-headerpad_max_install_names'],
  });
  assert.equal(JSON.stringify(result).includes('private-token'), false);
});

test('step failures keep their code and add only a fixed signal without raw message text', () => {
  const { recordFailure } = require('../scripts/native-acceptance.cjs');
  const cases = [
    [new Error('page.evaluate: TypeError: Failed to fetch https://127.0.0.1:1/private?token=secret'), 'NETWORK_FAILED', 'Error'],
    [new Error('page.evaluate: Execution context was destroyed, most likely because of a navigation'), 'RENDERER_CONTEXT_DESTROYED', 'Error'],
    [new Error('Target page, context or browser has been closed /Users/private'), 'TARGET_CLOSED', 'Error'],
    [new SyntaxError('Unexpected token < in JSON at position 0'), 'JSON_INVALID', 'SyntaxError'],
    [new Error('unclassified /Users/private/secret'), null, 'Error'],
  ];
  for (const [error, signal, errorName] of cases) {
    const report = { phase: 'real-main-backup' };
    assert.deepEqual(recordFailure(report, error), { category: 'native-step-failed', code: 'NATIVE_ACCEPTANCE_STEP_FAILED',
      phase: 'real-main-backup', exitStatus: null, command: null, errorName, signal });
    assert.equal(JSON.stringify(report).includes('private'), false); assert.equal(JSON.stringify(report).includes('secret'), false);
  }
  const coded = { phase: 'x' }; recordFailure(coded, new Error('NATIVE_BACKUP_TIMEOUT'));
  assert.equal(coded.failure.code, 'NATIVE_BACKUP_TIMEOUT'); assert.equal(coded.failure.signal, null);
  const weird = { phase: 'x' }; const odd = new Error('x'); odd.name = 'Bad name/with path'; recordFailure(weird, odd);
  assert.equal(weird.failure.errorName, null);
});
