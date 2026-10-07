'use strict';
// Pure parts of validation/pre-release/native-loader-probe.cjs: lsof parsing, mapped-image
// classification and the developer-root sandbox profile. No app launch happens here.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync, spawnSync } = require('node:child_process');
const probe = require('../../validation/pre-release/native-loader-probe.cjs');

const APP = '/Users/x/repo/.native-product-abc/Code Intelligence Validation.app';
const PROFILE = '/Users/x/repo/.nr/desktop-run-abc';

test('lsof field output keeps only program text and memory-mapped images', () => {
  const text = ['p101', 'fcwd', 'tDIR', 'n/', 'ftxt', 'tREG', `n${APP}/Contents/Resources/runtime/postgres/bin/postgres`,
    'ftxt', 'tREG', 'n/usr/lib/dyld', 'f3', 'tREG', 'n/opt/homebrew/lib/not-mapped.dylib', 'p102', 'fmem', 'tREG', 'n/opt/homebrew/lib/libssl.3.dylib', ''].join('\n');
  assert.deepEqual(probe.parseLsof(text), [
    { pid: 101, fd: 'txt', type: 'REG', name: `${APP}/Contents/Resources/runtime/postgres/bin/postgres` },
    { pid: 101, fd: 'txt', type: 'REG', name: '/usr/lib/dyld' },
    { pid: 102, fd: 'mem', type: 'REG', name: '/opt/homebrew/lib/libssl.3.dylib' }]);
});

test('process executables come from the first program-text mapping, not a retitled process name', () => {
  // PostgreSQL children rewrite their title ("postgres: checkpointer"); ps comm is not a path.
  const rows = probe.parseLsof(['p201', 'ftxt', 'tREG', `n${APP}/Contents/Resources/runtime/postgres/bin/postgres`, 'ftxt', 'tREG', 'n/usr/lib/dyld',
    'p202', 'fmem', 'tREG', `n${APP}/Contents/Resources/runtime/postgres/lib/libpq.5.dylib`, 'ftxt', 'tREG', 'n/opt/homebrew/bin/postgres',
    'p203', 'fmem', 'tREG', `n${APP}/Contents/Resources/runtime/redis/lib/libssl.3.dylib`, ''].join('\n'));
  assert.deepEqual([...probe.executablesFromMappings(rows, [201, 202, 203, 204])],
    [[201, `${APP}/Contents/Resources/runtime/postgres/bin/postgres`], [202, '/opt/homebrew/bin/postgres'], [203, null], [204, null]]);
  assert.deepEqual(probe.executablesOutside(probe.executablesFromMappings(rows, [201, 202, 203, 204]), APP),
    [{ pid: 202, executable: '/opt/homebrew/bin/postgres' }, { pid: 203, executable: null }, { pid: 204, executable: null }]);
});

test('mapped paths are classified as bundle, OS, profile, developer root or other', () => {
  const context = { app: APP, profileRoot: PROFILE };
  assert.equal(probe.classifyMappedPath(`${APP}/Contents/Frameworks/Electron Framework.framework/Versions/A/Electron Framework`, context), 'bundle');
  assert.equal(probe.classifyMappedPath(`${APP}-evil/x.dylib`, context), 'other', 'sibling prefix is not inside the bundle');
  for (const file of ['/usr/lib/dyld', '/System/Volumes/Preboot/Cryptexes/OS/System/Library/dyld/dyld_shared_cache_arm64e',
    '/System/Library/Fonts/SFNS.ttf', '/usr/share/icu/icudt76l.dat']) assert.equal(probe.classifyMappedPath(file, context), 'os', file);
  assert.equal(probe.classifyMappedPath(`${PROFILE}/userData/GPUCache/data_1`, context), 'profile');
  for (const file of ['/opt/homebrew/opt/openssl@3/lib/libssl.3.dylib', '/usr/local/lib/libredis.dylib',
    '/Library/Java/JavaVirtualMachines/x/Contents/Home/lib/server/libjvm.dylib']) assert.equal(probe.classifyMappedPath(file, context), 'developer', file);
  assert.equal(probe.classifyMappedPath('/private/var/folders/x/T/cache.bin', context), 'other');
  assert.equal(probe.classifyMappedPath('relative/path', context), 'invalid');
});

test('code mapped from a developer root or another non-OS location is a finding; data is only listed', t => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'codeintel-loader-'))); t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const code = path.join(root, 'foreign.dylib'), data = path.join(root, 'cache.bin');
  fs.writeFileSync(code, Buffer.concat([Buffer.from('cffaedfe0c000001', 'hex'), Buffer.alloc(32)]));
  fs.writeFileSync(data, 'not code');
  const result = probe.evaluateMappings([
    { pid: 1, fd: 'txt', name: `${APP}/Contents/MacOS/Code Intelligence Validation` },
    { pid: 1, fd: 'txt', name: '/usr/lib/dyld' },
    { pid: 2, fd: 'txt', name: '/opt/homebrew/lib/libssl.3.dylib' },
    { pid: 3, fd: 'txt', name: code }, { pid: 3, fd: 'txt', name: data }], { app: APP, profileRoot: PROFILE });
  assert.deepEqual(result.classes, { bundle: 1, os: 1, developer: 1, other: 2 });
  assert.deepEqual(result.findings.map(item => item.code).sort(), ['CODE_MAPPED_OUTSIDE_BUNDLE_AND_OS', 'DEVELOPER_ROOT_MAPPED']);
  assert.deepEqual(result.nonCodeOutside, [data]);
});

test('sandbox profile denies every developer root and is rejected for unsafe paths', () => {
  const profile = probe.sandboxProfile('/Users/synthetic');
  for (const root of probe.DEVELOPER_ROOTS) assert(profile.includes(`(subpath "${root}")`), root);
  assert(profile.includes('(subpath "/Users/synthetic/.nvm")') && profile.startsWith('(version 1)(allow default)(deny file-read*'));
  assert.throws(() => probe.sandboxProfile('/Users/bad"name'), /SANDBOX_PATH_INVALID/);
});

test('the developer-root sandbox really denies reads on this host', { skip: process.platform !== 'darwin' || !fs.existsSync('/usr/bin/sandbox-exec') }, t => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'codeintel-sandbox-'))); t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const env = { PATH: '/usr/bin:/bin', LANG: 'C', LC_ALL: 'C' };
  const profile = `(version 1)(allow default)(deny file-read* (subpath "${root}"))`;
  fs.writeFileSync(path.join(root, 'x'), 'x');
  assert.notEqual(spawnSync('/usr/bin/sandbox-exec', ['-p', profile, '/bin/cat', path.join(root, 'x')], { env }).status, 0);
  assert.equal(execFileSync('/usr/bin/sandbox-exec', ['-p', profile, '/bin/echo', 'allowed'], { env, encoding: 'utf8' }).trim(), 'allowed');
});

test('probe arguments accept only a retained validation candidate and the explicit packaged-app switch', () => {
  assert.deepEqual(probe.argumentsFor(['--app', `/r/.native-product-a1/Code Intelligence Validation.app`]), { app: '/r/.native-product-a1/Code Intelligence Validation.app', packaged: false });
  assert.equal(probe.argumentsFor(['--app', `/r/.native-product-a1/Code Intelligence Validation.app`, '--packaged-app']).packaged, true);
  for (const argv of [['--app', '/Applications/Code Intelligence.app'], ['--app', 'rel/.native-product-a/Code Intelligence Validation.app'],
    ['--app', '/r/.native-product-a1/Code Intelligence Validation.app', '--real-profile']]) assert.throws(() => probe.argumentsFor(argv));
});
