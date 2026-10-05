'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const vm = require('node:vm');
const { createRequire } = require('node:module');
const { PassThrough } = require('node:stream');
const test = require('node:test');
const { validateRuntimeManifest } = require('../src/runtime-manifest.cjs');
const diagnostics = require('../src/startup-diagnostics.cjs');
const { observeStartup } = require('../scripts/native-acceptance-electron.cjs');
const platform = { platform: 'darwin', arch: 'arm64' };
const sha = bytes => crypto.createHash('sha256').update(bytes).digest('hex');

function fixture(t) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ci-manifest-diagnostic-')));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  for (const dir of ['bin', 'lib', 'pkglib', 'share']) fs.mkdirSync(path.join(root, 'postgres', dir), { recursive: true });
  fs.writeFileSync(path.join(root, 'sample.txt'), 'public synthetic bytes');
  const manifest = { format: 1, ...platform, buildSequence: '100', files: { 'sample.txt': sha('public synthetic bytes') },
    runtime: { postgresBin: 'postgres/bin', postgresLib: 'postgres/lib', postgresPkgLib: 'postgres/pkglib', postgresShare: 'postgres/share' } };
  fs.writeFileSync(path.join(root, 'runtime-manifest.json'), JSON.stringify(manifest));
  return { root, manifest };
}
function expected(code) {
  return error => {
    assert.equal(error.code, code); assert.equal(error.name, 'RuntimeIntegrityError');
    assert.equal(error.message, code.startsWith('RUNTIME_IO_')
      ? `Bundled runtime verification could not read or close a file (${code}).`
      : `Bundled runtime manifest or inventory is invalid (${code}).`);
    assert.equal(Object.hasOwn(error, 'cause'), false);
    return true;
  };
}
function validatorWithIO(promises) {
  const file = path.resolve(__dirname, '../src/runtime-manifest.cjs'), requireSource = createRequire(file);
  const context = { module: { exports: {} }, process,
    require: name => name === 'node:fs' ? { ...fs, promises: { ...fs.promises, ...promises } } : requireSource(name) };
  vm.runInNewContext(fs.readFileSync(file, 'utf8'), context, { filename: file });
  return context.module.exports.validateRuntimeManifest;
}

test('valid inventory is read-only and keeps the existing returned manifest contract', async t => {
  const { root, manifest } = fixture(t), file = path.join(root, 'sample.txt');
  const before = fs.statSync(file, { bigint: true }), bytes = fs.readFileSync(file);
  assert.equal(await validateRuntimeManifest(root, manifest, platform), manifest);
  assert.deepEqual(fs.readFileSync(file), bytes);
  const after = fs.statSync(file, { bigint: true });
  for (const field of ['ino', 'dev', 'size', 'mtimeNs', 'ctimeNs']) assert.equal(after[field], before[field]);
});

for (const [label, mutate, code] of [
  ['format', f => { f.manifest.format = 2; }, 'RUNTIME_MANIFEST_INVALID'],
  ['platform', f => { f.manifest.arch = 'x64'; }, 'RUNTIME_MANIFEST_PLATFORM'],
  ['build sequence', f => { f.manifest.buildSequence = '01'; }, 'RUNTIME_MANIFEST_BUILD'],
  ['unsafe inventory path', f => { f.manifest.files['../private-sentinel'] = 'a'.repeat(64); }, 'RUNTIME_MANIFEST_PATH'],
  ['unsafe layout', f => { f.manifest.runtime.postgresBin = '../private-sentinel'; }, 'RUNTIME_MANIFEST_PATH'],
  ['unexpected file', f => { fs.writeFileSync(path.join(f.root, 'private-sentinel'), 'extra'); }, 'RUNTIME_INVENTORY_UNEXPECTED'],
  ['missing listed file', f => { fs.unlinkSync(path.join(f.root, 'sample.txt')); }, 'RUNTIME_INVENTORY_MISSING'],
  ['different bytes', f => { fs.writeFileSync(path.join(f.root, 'sample.txt'), 'changed'); }, 'RUNTIME_INVENTORY_HASH'],
  ['symlink', f => { fs.symlinkSync('sample.txt', path.join(f.root, 'linked')); }, 'RUNTIME_INVENTORY_TYPE'],
  ['hardlink', f => { fs.linkSync(path.join(f.root, 'sample.txt'), path.join(f.root, 'linked')); }, 'RUNTIME_INVENTORY_TYPE'],
]) test(`manifest diagnostic identifies ${label} without trusting or exposing its path`, async t => {
  const f = fixture(t); mutate(f);
  await assert.rejects(validateRuntimeManifest(f.root, f.manifest, platform), expected(code));
});

test('an oversized sparse file is refused before opening a content stream', async t => {
  const f = fixture(t), file = path.join(f.root, 'sample.txt');
  fs.truncateSync(file, 512 * 1024 * 1024 + 1);
  let opens = 0;
  const validate = validatorWithIO({ async open() { opens++; throw new Error('should not open'); } });
  await assert.rejects(validate(f.root, f.manifest, platform), expected('RUNTIME_INVENTORY_LIMIT'));
  assert.equal(opens, 0);
});

for (const code of ['EACCES', 'EPERM', 'ENOENT', 'EMFILE', 'ENFILE', 'EIO', 'ENOMEM', 'ENOSPC', 'NOT_REVIEWED']) {
  test(`injected filesystem ${code} yields a bounded public code and no private original detail`, async t => {
    const f = fixture(t);
    const failure = Object.assign(new Error('private-sentinel /Users/private password=secret'), { code });
    const validate = validatorWithIO({ async lstat() { throw failure; } });
    const publicCode = code === 'NOT_REVIEWED' ? 'RUNTIME_INTEGRITY_FAILED' : 'RUNTIME_IO_' + code;
    await assert.rejects(validate(f.root, f.manifest, platform), expected(publicCode));
  });
}

test('an unchanged hash with a changed file identity stamp is still rejected and the handle closes', async t => {
  const f = fixture(t); let closed = 0;
  const validate = validatorWithIO({ async open(...args) {
    const handle = await fs.promises.open(...args); let stats = 0;
    return { createReadStream: handle.createReadStream.bind(handle),
      async stat(...statArgs) { const value = await handle.stat(...statArgs); if (++stats > 1) value.ctimeNs += 1n; return value; },
      async close() { closed++; await handle.close(); } };
  } });
  await assert.rejects(validate(f.root, f.manifest, platform), expected('RUNTIME_INVENTORY_CHANGED'));
  assert.equal(closed, 1);
});

test('a stream read failure retains the fixed IO classification and closes the opened handle', async t => {
  const f = fixture(t); let closed = 0;
  const validate = validatorWithIO({ async open(...args) {
    const handle = await fs.promises.open(...args);
    return { stat: handle.stat.bind(handle),
      createReadStream: () => ({ async *[Symbol.asyncIterator]() { throw Object.assign(new Error('private-sentinel'), { code: 'EMFILE' }); } }),
      async close() { closed++; await handle.close(); } };
  } });
  await assert.rejects(validate(f.root, f.manifest, platform), expected('RUNTIME_IO_EMFILE'));
  assert.equal(closed, 1);
});

for (const corrupt of [false, true]) test(`close failure ${corrupt ? 'does not mask the first hash failure' : 'still refuses an otherwise valid inventory'}`, async t => {
  const f = fixture(t); let closed = 0;
  if (corrupt) fs.writeFileSync(path.join(f.root, 'sample.txt'), 'different bytes');
  const validate = validatorWithIO({ async open(...args) {
    const handle = await fs.promises.open(...args);
    return { stat: handle.stat.bind(handle), createReadStream: handle.createReadStream.bind(handle),
      async close() { closed++; await handle.close(); throw Object.assign(new Error('private-sentinel-close'), { code: 'EIO' }); } };
  } });
  await assert.rejects(validate(f.root, f.manifest, platform), expected(corrupt ? 'RUNTIME_INVENTORY_HASH' : 'RUNTIME_IO_EIO'));
  assert.equal(closed, 1);
});

test('a modified diagnostic instance is reconstructed without its message, cause, path or extra properties', () => {
  const error = new diagnostics.RuntimeIntegrityError('RUNTIME_INVENTORY_HASH');
  error.message = 'private-sentinel-message'; error.cause = new Error('private-sentinel-cause'); error.path = '/private/sentinel';
  const safe = diagnostics.integrityError(error);
  expected('RUNTIME_INVENTORY_HASH')(safe);
  assert.notEqual(safe, error); assert.equal(Object.hasOwn(safe, 'path'), false);
  assert.doesNotMatch(JSON.stringify(safe), /private|sentinel/);
});

test('every reviewed integrity code survives fragmented startup observation without arbitrary metadata', () => {
  for (const code of diagnostics.INTEGRITY_CODES) {
    const child = { stderr: new PassThrough() }, report = {};
    const stop = observeStartup(child, report, () => {});
    child.stderr.write('DESKTOP_STARTUP MAN'); child.stderr.write('IFEST FAILED ' + code + '\n');
    assert.deepEqual(report.startup, { phase: 'MANIFEST', state: 'FAILED', code });
    child.stderr.write('DESKTOP_STARTUP READY\n');
    assert.equal(report.startup.code, code); stop(); child.stderr.end();
  }
});

test('startup diagnostic vocabulary rejects arbitrary values, suffixes, fields and throwing getters', () => {
  for (const line of ['DESKTOP_STARTUP MANIFEST FAILED RUNTIME_PRIVATE_SENTINEL',
    'DESKTOP_STARTUP MANIFEST FAILED RUNTIME_IO_EMFILE /Users/private',
    'DESKTOP_STARTUP MANIFEST FAILED RUNTIME_IO_EMFILE\n', 'DESKTOP_STARTUP PRIVATE_SENTINEL']) {
    assert.equal(diagnostics.parseStartupLine(line), null);
  }
  assert.equal(diagnostics.startupFailureCode({ code: 'RUNTIME_PRIVATE_SENTINEL' }), 'MAIN_STARTUP_FAILED');
  const hostile = { get code() { throw new Error('private-sentinel'); } };
  assert.equal(diagnostics.startupFailureCode(hostile), 'MAIN_STARTUP_FAILED');
  expected('RUNTIME_INTEGRITY_FAILED')(diagnostics.integrityError(hostile));
  expected('RUNTIME_INTEGRITY_FAILED')(new diagnostics.RuntimeIntegrityError('private-sentinel'));
});
