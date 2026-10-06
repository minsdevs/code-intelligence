'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const vm = require('node:vm');
const { createRequire } = require('node:module');
const { PassThrough } = require('node:stream');
const { createHook } = require('node:async_hooks');
const { promisify } = require('node:util');
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
function validatorWithIO(promises, electron = false) {
  const file = path.resolve(__dirname, '../src/runtime-manifest.cjs'), requireSource = createRequire(file);
  const context = { module: { exports: {} }, process: electron
    ? { platform: 'darwin', arch: 'arm64', versions: { electron: 'synthetic' } } : process,
    require: name => ['node:fs', 'original-fs'].includes(name)
      ? { ...fs, promises: { ...fs.promises, ...promises } } : requireSource(name) };
  vm.runInNewContext(fs.readFileSync(file, 'utf8'), context, { filename: file });
  return context.module.exports.validateRuntimeManifest;
}

for (const electron of [false, true]) test(`physical filesystem injection remains fail-closed in ${electron ? 'Electron' : 'Node'}`, async t => {
  const f = fixture(t); let calls = 0;
  const validate = validatorWithIO({ async lstat() {
    calls++; throw Object.assign(new Error('private-sentinel'), { code: 'EIO' });
  } }, electron);
  await assert.rejects(validate(f.root, f.manifest, platform), expected('RUNTIME_IO_EIO'));
  assert.equal(calls, 1);
});

test('Electron physical inventory requires original-fs and never falls back to ASAR metadata', async t => {
  const f = fixture(t), file = path.resolve(__dirname, '../src/runtime-manifest.cjs');
  const requireSource = createRequire(file), requested = [];
  const load = native => {
    const context = { module: { exports: {} }, process: { platform: 'darwin', arch: 'arm64', versions: { electron: 'synthetic' } },
      require(name) {
        requested.push(name);
        if (name === 'original-fs') { if (!native) throw new Error('ORIGINAL_FS_UNAVAILABLE'); return native; }
        if (name === 'node:fs') throw new Error('ASAR_FS_MUST_NOT_BE_USED');
        return requireSource(name);
      } };
    vm.runInNewContext(fs.readFileSync(file, 'utf8'), context, { filename: file });
    return context.module.exports.validateRuntimeManifest;
  };
  const validate = load(fs);
  assert.equal(await validate(f.root, f.manifest, platform), f.manifest);
  assert(requested.includes('original-fs')); assert.equal(requested.includes('node:fs'), false);
  assert.throws(() => load(null), /ORIGINAL_FS_UNAVAILABLE/);
  fs.writeFileSync(path.join(f.root, 'sample.txt'), 'changed');
  await assert.rejects(validate(f.root, f.manifest, platform), expected('RUNTIME_INVENTORY_HASH'));
});

test('native promise inventory remains correct across synchronous stat reentry into callback metadata', async t => {
  const f = fixture(t), ids = new Set(); let callbacks = 0, hookFailure = null;
  const hook = createHook({ init(id, type) { if (type === 'FSREQCALLBACK') ids.add(id); },
    before(id) { if (ids.has(id)) { callbacks++; try { fs.lstatSync(f.root, { bigint: true }); } catch (error) { hookFailure = error; } } },
    destroy(id) { ids.delete(id); } });
  let physical;
  try {
    hook.enable();
    // Exercise the callback/shared-array path under reentry without asserting
    // upstream remains buggy: future Node versions may fix its own implementation.
    await promisify(fs.lstat)(path.join(f.root, 'sample.txt'), { bigint: true });
    physical = await fs.promises.lstat(path.join(f.root, 'sample.txt'), { bigint: true });
    assert.equal(await validateRuntimeManifest(f.root, f.manifest, platform), f.manifest);
  } finally { hook.disable(); }
  assert.equal(hookFailure, null); assert(callbacks > 0); assert.equal(physical.isFile(), true);
});

test('valid inventory is read-only and keeps the existing returned manifest contract', async t => {
  const { root, manifest } = fixture(t), file = path.join(root, 'sample.txt');
  const before = fs.statSync(file, { bigint: true }), bytes = fs.readFileSync(file);
  assert.equal(await validateRuntimeManifest(root, manifest, platform), manifest);
  assert.deepEqual(fs.readFileSync(file), bytes);
  const after = fs.statSync(file, { bigint: true });
  for (const field of ['ino', 'dev', 'size', 'mtimeNs', 'ctimeNs']) assert.equal(after[field], before[field]);
});

test('control runtime protocol requires both hashed artifacts and validates their bytes', async t => {
  const f = fixture(t);
  f.manifest.controlProtocol = 1; f.manifest.ownershipProtocol = 1;
  fs.mkdirSync(path.join(f.root, 'backend'));
  for (const name of ['code-intelligence-control.jar', 'code-intelligence-control-provenance.json']) {
    const relative = 'backend/' + name;
    fs.writeFileSync(path.join(f.root, relative), 'synthetic control bytes');
    f.manifest.files[relative] = sha('synthetic control bytes');
  }
  assert.equal(await validateRuntimeManifest(f.root, f.manifest, platform), f.manifest);
  fs.writeFileSync(path.join(f.root, 'backend/code-intelligence-control.jar'), 'altered control bytes');
  await assert.rejects(validateRuntimeManifest(f.root, f.manifest, platform), expected('RUNTIME_INVENTORY_HASH'));
});

for (const missing of ['code-intelligence-control.jar', 'code-intelligence-control-provenance.json']) {
  test(`control marker cannot accept an inventory that omits ${missing}`, async t => {
    const f = fixture(t);
    f.manifest.controlProtocol = 1; f.manifest.ownershipProtocol = 1;
    fs.mkdirSync(path.join(f.root, 'backend'));
    const present = missing.endsWith('.jar') ? 'code-intelligence-control-provenance.json' : 'code-intelligence-control.jar';
    fs.writeFileSync(path.join(f.root, 'backend', present), 'synthetic');
    f.manifest.files['backend/' + present] = sha('synthetic');
    await assert.rejects(validateRuntimeManifest(f.root, f.manifest, platform), expected('RUNTIME_INVENTORY_MISSING'));
  });
}

for (const controlProtocol of [0, 2, '1', null, true]) test(`unknown control marker ${JSON.stringify(controlProtocol)} fails closed`, async t => {
  const f = fixture(t); f.manifest.controlProtocol = controlProtocol; f.manifest.ownershipProtocol = 1;
  await assert.rejects(validateRuntimeManifest(f.root, f.manifest, platform), expected('RUNTIME_MANIFEST_PROTOCOL'));
});

test('a control marker requires guarded ownership and cannot select a Java helper on Windows', async t => {
  const f = fixture(t); f.manifest.controlProtocol = 1;
  await assert.rejects(validateRuntimeManifest(f.root, f.manifest, platform), expected('RUNTIME_MANIFEST_PROTOCOL'));
  Object.assign(f.manifest, { platform: 'win32', arch: 'x64', ownershipProtocol: 1 });
  await assert.rejects(validateRuntimeManifest(f.root, f.manifest, { platform: 'win32', arch: 'x64' }), expected('RUNTIME_MANIFEST_PROTOCOL'));
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
    return { read: handle.read.bind(handle),
      async stat(...statArgs) { const value = await handle.stat(...statArgs); if (++stats > 1) value.ctimeNs += 1n; return value; },
      async close() { closed++; await handle.close(); } };
  } });
  await assert.rejects(validate(f.root, f.manifest, platform), expected('RUNTIME_INVENTORY_CHANGED'));
  assert.equal(closed, 1);
});

test('a read failure retains the fixed IO classification and closes the opened handle', async t => {
  const f = fixture(t); let closed = 0;
  const validate = validatorWithIO({ async open(...args) {
    const handle = await fs.promises.open(...args);
    return { stat: handle.stat.bind(handle),
      async read() { throw Object.assign(new Error('private-sentinel'), { code: 'EMFILE' }); },
      async close() { closed++; await handle.close(); } };
  } });
  await assert.rejects(validate(f.root, f.manifest, platform), expected('RUNTIME_IO_EMFILE'));
  assert.equal(closed, 1);
});

test('short reads hash correctly and reuse one bounded buffer for the file', async t => {
  const f = fixture(t), seen = [];
  const validate = validatorWithIO({ async open(...args) {
    const handle = await fs.promises.open(...args);
    return { stat: handle.stat.bind(handle),
      async read(buffer, offset, length, position) {
        seen.push(buffer);
        return handle.read(buffer, offset, Math.min(length, 3), position);
      }, close: handle.close.bind(handle) };
  } });
  assert.equal(await validate(f.root, f.manifest, platform), f.manifest);
  assert(seen.length > 1); assert(seen.every(buffer => buffer === seen[0] && buffer.length === 64 * 1024));
});

test('truncation during read fails closed without following EOF indefinitely', async t => {
  const f = fixture(t), file = path.join(f.root, 'sample.txt'); let first = true;
  const validate = validatorWithIO({ async open(...args) {
    const handle = await fs.promises.open(...args);
    return { stat: handle.stat.bind(handle), async read(buffer, offset, length, position) {
      if (first) { first = false; fs.truncateSync(file, 1); }
      return handle.read(buffer, offset, length, position);
    }, close: handle.close.bind(handle) };
  } });
  await assert.rejects(validate(f.root, f.manifest, platform), expected('RUNTIME_INVENTORY_CHANGED'));
});

test('append during read is rejected by the bounded one-byte EOF check', async t => {
  const f = fixture(t), file = path.join(f.root, 'sample.txt'); let appended = false;
  const validate = validatorWithIO({ async open(...args) {
    const handle = await fs.promises.open(...args);
    return { stat: handle.stat.bind(handle), async read(buffer, offset, length, position) {
      const result = await handle.read(buffer, offset, length, position);
      if (!appended && position === 0) { appended = true; fs.appendFileSync(file, 'x'); }
      return result;
    }, close: handle.close.bind(handle) };
  } });
  await assert.rejects(validate(f.root, f.manifest, platform), expected('RUNTIME_INVENTORY_CHANGED'));
});

test('failure observer sees the original injected IO failure exactly once without replacing the public error', async t => {
  const f = fixture(t), observed = [];
  const failure = Object.assign(new Error('private-sentinel'), { code: 'EMFILE' });
  const validate = validatorWithIO({ async lstat() { throw failure; } });
  await assert.rejects(validate(f.root, f.manifest, { ...platform, onFailure(operation, error) { observed.push({ operation, error }); } }),
    expected('RUNTIME_IO_EMFILE'));
  assert.deepEqual(observed, [{ operation: 'LSTAT', error: failure }]);
});

test('READDIR failure reports only hashed relative path and fixed physical kinds', async t => {
  const f = fixture(t), directory = path.join(f.root, 'postgres'), observed = [];
  const validate = validatorWithIO({ async readdir(file, ...args) {
    if (file === directory) {
      fs.rmSync(directory, { recursive: true, force: true });
      fs.writeFileSync(directory, 'replacement');
      throw Object.assign(new Error('/private/raw-path'), { code: 'ENOTDIR' });
    }
    return fs.promises.readdir(file, ...args);
  } });
  await assert.rejects(validate(f.root, f.manifest, { ...platform, onFailure(operation, error, details) {
    observed.push({ operation, error, details });
  } }), expected('RUNTIME_INTEGRITY_FAILED'));
  assert.equal(observed.length, 1); assert.equal(observed[0].operation, 'READDIR');
  assert.equal(observed[0].error.code, 'ENOTDIR');
  assert.deepEqual({ ...observed[0].details }, {
    pathSha256: sha('postgres'), physicalKindBeforeFailure: 'DIRECTORY', physicalKindAfterFailure: 'FILE',
  });
  assert.doesNotMatch(JSON.stringify(observed[0].details), /postgres|private|raw-path/);
});

test('READDIR failure-time kind observation cannot replace the original error', async t => {
  const f = fixture(t), directory = path.join(f.root, 'postgres');
  const validate = validatorWithIO({ async readdir(file, ...args) {
    if (file === directory) {
      fs.rmSync(directory, { recursive: true, force: true });
      throw Object.assign(new Error('original'), { code: 'ENOTDIR' });
    }
    return fs.promises.readdir(file, ...args);
  } });
  await assert.rejects(validate(f.root, f.manifest, { ...platform, onFailure(_operation, original, details) {
    assert.equal(original.code, 'ENOTDIR'); assert.equal(details.physicalKindAfterFailure, 'UNAVAILABLE');
    throw new Error('observer-private');
  } }), expected('RUNTIME_INTEGRITY_FAILED'));
});

test('READDIR metadata construction failure cannot replace the captured public failure', async t => {
  const f = fixture(t), directory = path.join(f.root, 'postgres');
  const validate = validatorWithIO({ async readdir(file, ...args) {
    if (file === directory) throw Object.assign(new Error('original'), { code: 'ENOTDIR' });
    return fs.promises.readdir(file, ...args);
  } });
  const originalCreate = crypto.createHash;
  crypto.createHash = () => { throw new Error('observer-allocation'); };
  try {
    await assert.rejects(validate(f.root, f.manifest, { ...platform, onFailure() {} }), expected('RUNTIME_INTEGRITY_FAILED'));
  } finally { crypto.createHash = originalCreate; }
});

test('read buffers belong to bounded slots of one invocation and concurrent invocations remain isolated', async t => {
  const f = fixture(t), second = fixture(t);
  for (const item of [f, second]) for (const [name, bytes] of [['empty.txt', ''], ['multi.txt', 'z'.repeat(200000)]]) {
    fs.writeFileSync(path.join(item.root, name), bytes);
    item.manifest.files[name] = sha(bytes);
  }
  const buffers = new Map([[f.root, new Set()], [second.root, new Set()]]), opened = new Map();
  const validate = validatorWithIO({ async open(file, ...args) {
    const handle = await fs.promises.open(file, ...args);
    const root = path.dirname(file); opened.set(root, (opened.get(root) ?? 0) + 1);
    return { stat: handle.stat.bind(handle), close: handle.close.bind(handle),
      read(buffer, offset, length, position) {
        assert.equal(buffer.length, 65536); buffers.get(root).add(buffer);
        return handle.read(buffer, offset, length, position);
      } };
  } });
  await Promise.all([validate(f.root, f.manifest, platform), validate(second.root, second.manifest, platform)]);
  assert.equal(opened.get(f.root), 3); assert.equal(opened.get(second.root), 3);
  for (const root of [f.root, second.root]) assert(buffers.get(root).size >= 1 && buffers.get(root).size <= 3);
  for (const buffer of buffers.get(f.root)) assert.equal(buffers.get(second.root).has(buffer), false);
});

function manyFiles(t, count) {
  const f = fixture(t);
  for (let i = 0; i < count; i++) {
    const name = `many/${String(i).padStart(3, '0')}.txt`, bytes = 'x'.repeat(i + 1);
    fs.mkdirSync(path.join(f.root, 'many'), { recursive: true }); fs.writeFileSync(path.join(f.root, name), bytes);
    f.manifest.files[name] = sha(bytes);
  }
  return f;
}

test('content verification overlaps a bounded number of files and hashes every inventory entry', async t => {
  const f = manyFiles(t, 40); let open = 0, peak = 0, opened = 0;
  const validate = validatorWithIO({ async open(...args) {
    const handle = await fs.promises.open(...args); open++; opened++; peak = Math.max(peak, open);
    await new Promise(resolve => setImmediate(resolve));
    return { stat: handle.stat.bind(handle), read: handle.read.bind(handle),
      async close() { open--; await handle.close(); } };
  } });
  assert.equal(await validate(f.root, f.manifest, platform), f.manifest);
  assert.equal(opened, 41); assert.equal(open, 0); assert(peak > 1 && peak <= 8);
});

test('a content failure closes every in-flight handle and reports the earliest failed entry', async t => {
  const f = manyFiles(t, 40), observed = [];
  fs.writeFileSync(path.join(f.root, 'many/005.txt'), 'tampered'); fs.writeFileSync(path.join(f.root, 'many/030.txt'), 'tampered');
  let open = 0, opened = 0;
  const validate = validatorWithIO({ async open(...args) {
    const handle = await fs.promises.open(...args); open++; opened++;
    return { stat: handle.stat.bind(handle), read: handle.read.bind(handle),
      async close() { await new Promise(resolve => setImmediate(resolve)); open--; await handle.close(); } };
  } });
  await assert.rejects(validate(f.root, f.manifest, { ...platform, onFailure(operation) { observed.push(operation); } }),
    expected('RUNTIME_INVENTORY_HASH'));
  assert.equal(open, 0); assert(opened < 41); assert.deepEqual(observed, ['HASH']);
});

for (const value of [-1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1, undefined, 65537]) {
  test(`invalid file read count ${value} fails immediately and closes the descriptor`, async t => {
    const f = fixture(t); let closed = 0, reads = 0;
    const validate = validatorWithIO({ async open(...args) {
      const handle = await fs.promises.open(...args);
      return { stat: handle.stat.bind(handle), async read() { reads++; return { bytesRead: value }; },
        async close() { closed++; await handle.close(); } };
    } });
    await assert.rejects(validate(f.root, f.manifest, platform), expected('RUNTIME_NODE_RANGE'));
    assert.equal(reads, 1); assert.equal(closed, 1);
  });
}

for (const corrupt of [false, true]) test(`close failure ${corrupt ? 'does not mask the first hash failure' : 'still refuses an otherwise valid inventory'}`, async t => {
  const f = fixture(t); let closed = 0;
  if (corrupt) fs.writeFileSync(path.join(f.root, 'sample.txt'), 'different bytes');
  const validate = validatorWithIO({ async open(...args) {
    const handle = await fs.promises.open(...args);
    return { stat: handle.stat.bind(handle), read: handle.read.bind(handle),
      async close() { closed++; await handle.close(); throw Object.assign(new Error('private-sentinel-close'), { code: 'EIO' }); } };
  } });
  await assert.rejects(validate(f.root, f.manifest, platform), expected(corrupt ? 'RUNTIME_INVENTORY_HASH' : 'RUNTIME_IO_EIO'));
  assert.equal(closed, 1);
});

test('observer throw never replaces the original failure or close precedence', async t => {
  const f = fixture(t); fs.writeFileSync(path.join(f.root, 'sample.txt'), 'different bytes');
  const validate = validatorWithIO({ async open(...args) {
    const handle = await fs.promises.open(...args);
    return { stat: handle.stat.bind(handle), read: handle.read.bind(handle),
      async close() { await handle.close(); throw Object.assign(new Error('private-close'), { code: 'EIO' }); } };
  } });
  await assert.rejects(validate(f.root, f.manifest, { ...platform, onFailure() { throw new Error('observer-private'); } }),
    expected('RUNTIME_INVENTORY_HASH'));
});

test('successful verification does not invoke the failure observer', async t => {
  const f = fixture(t); let calls = 0;
  assert.equal(await validateRuntimeManifest(f.root, f.manifest, { ...platform, onFailure() { calls++; } }), f.manifest);
  assert.equal(calls, 0);
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

test('integrity failure protocol exposes only fixed operation code and kind values', () => {
  const failure = Object.assign(new Error('private /Users/secret'), { code: 'EIO' });
  const value = diagnostics.integrityDiagnostic('STREAM', failure);
  assert.deepEqual(value, { operation: 'STREAM', code: 'EIO', kind: 'Error' });
  const line = diagnostics.formatIntegrityDiagnostic(value);
  assert.equal(line, 'DESKTOP_INTEGRITY STREAM EIO Error');
  assert.deepEqual(diagnostics.parseIntegrityLine(line), value);
  assert.equal(diagnostics.parseIntegrityLine('DESKTOP_INTEGRITY STREAM PRIVATE Error'), null);
  assert.doesNotMatch(JSON.stringify(value), /private|secret|Users/);
});

test('integrity diagnostic hostile getters are sampled once and never escape', () => {
  let codeReads = 0, nameReads = 0;
  const hostile = { get code() { codeReads++; throw new Error('private-code'); },
    get name() { nameReads++; throw new Error('private-name'); } };
  assert.deepEqual(diagnostics.integrityDiagnostic('OPEN', hostile), { operation: 'OPEN', code: 'UNCLASSIFIED', kind: 'OTHER' });
  assert.equal(codeReads, 1); assert.equal(nameReads, 1);
});

test('READDIR extended integrity protocol round-trips fixed details and rejects malformed metadata', () => {
  const details = { pathSha256: 'a'.repeat(64), physicalKindBeforeFailure: 'DIRECTORY', physicalKindAfterFailure: 'FILE' };
  const value = diagnostics.integrityDiagnostic('READDIR', Object.assign(new Error('private'), { code: 'ENOTDIR' }), details);
  const line = diagnostics.formatIntegrityDiagnostic(value);
  assert.equal(line, `DESKTOP_INTEGRITY READDIR ENOTDIR Error ${'a'.repeat(64)} DIRECTORY FILE`);
  assert.deepEqual(diagnostics.parseIntegrityLine(line), value);
  assert.equal(diagnostics.parseIntegrityLine(`DESKTOP_INTEGRITY READDIR ENOTDIR Error ${'a'.repeat(63)} DIRECTORY FILE`), null);
  assert.equal(diagnostics.parseIntegrityLine(`DESKTOP_INTEGRITY OPEN ENOTDIR Error ${'a'.repeat(64)} DIRECTORY FILE`), null);
  assert.equal(diagnostics.formatIntegrityDiagnostic({ ...value, extra: 'private' }), null);
});

test('malicious READDIR detail getters cannot emit raw values or break four-token fallback', () => {
  const reads = { pathSha256: 0, physicalKindBeforeFailure: 0, physicalKindAfterFailure: 0 };
  const details = {};
  for (const [name, first] of Object.entries({ pathSha256: 'b'.repeat(64), physicalKindBeforeFailure: 'DIRECTORY', physicalKindAfterFailure: 'UNAVAILABLE' })) {
    Object.defineProperty(details, name, { get() { return ++reads[name] === 1 ? first : '/private'; } });
  }
  const value = diagnostics.integrityDiagnostic('READDIR', Object.assign(new Error('private'), { code: 'ENOTDIR' }), details);
  assert.deepEqual(reads, { pathSha256: 1, physicalKindBeforeFailure: 1, physicalKindAfterFailure: 1 });
  assert.doesNotMatch(JSON.stringify(value), /private/);
  assert.equal(diagnostics.formatIntegrityDiagnostic({ operation: 'READDIR', code: 'ENOTDIR', kind: 'Error', pathSha256: 'bad' }), null);
  assert.equal(diagnostics.formatIntegrityDiagnostic(diagnostics.integrityDiagnostic('READDIR', new Error('private'))),
    'DESKTOP_INTEGRITY READDIR UNCLASSIFIED Error');
});

test('READDIR details reject extra fields and non-string sha without coercion', () => {
  const extra = { pathSha256: 'c'.repeat(64), physicalKindBeforeFailure: 'DIRECTORY',
    physicalKindAfterFailure: 'FILE', rawPath: '/private' };
  assert.deepEqual(diagnostics.integrityDiagnostic('READDIR', new Error('private'), extra),
    { operation: 'READDIR', code: 'UNCLASSIFIED', kind: 'Error' });
  let coerced = 0;
  const hostileSha = { toString() { coerced++; return 'd'.repeat(64); } };
  assert.deepEqual(diagnostics.integrityDiagnostic('READDIR', new Error('private'), {
    pathSha256: hostileSha, physicalKindBeforeFailure: 'DIRECTORY', physicalKindAfterFailure: 'FILE',
  }), { operation: 'READDIR', code: 'UNCLASSIFIED', kind: 'Error' });
  assert.equal(coerced, 0);
});

test('diagnostic formatting snapshots getters once and cannot emit a changing private value', () => {
  const reads = { operation: 0, code: 0, kind: 0 };
  const value = Object.fromEntries([]);
  for (const [name, first] of Object.entries({ operation: 'OPEN', code: 'EIO', kind: 'Error' })) {
    Object.defineProperty(value, name, { get() { return ++reads[name] === 1 ? first : '/private-sentinel'; } });
  }
  assert.equal(diagnostics.formatIntegrityDiagnostic(value), 'DESKTOP_INTEGRITY OPEN EIO Error');
  assert.deepEqual(reads, { operation: 1, code: 1, kind: 1 });
  assert.equal(diagnostics.formatIntegrityDiagnostic({ get operation() { throw new Error('private'); } }), null);
});

test('a mutating or asynchronously rejecting observer cannot change the primary integrity failure', async t => {
  const f = fixture(t);
  const failure = Object.assign(new Error('private-original'), { code: 'EIO' });
  const validate = validatorWithIO({ async lstat() { throw failure; } });
  await assert.rejects(validate(f.root, f.manifest, { ...platform, onFailure(_operation, original) {
    original.code = 'EPERM';
    return Promise.reject(new Error('private-observer'));
  } }), expected('RUNTIME_IO_EIO'));
  await new Promise(resolve => setImmediate(resolve));
});

test('early integrity observation retains only the first fixed record despite oversized or private stderr', () => {
  const child = { stderr: new PassThrough() }, report = {};
  const stop = observeStartup(child, report, () => {});
  child.stderr.write('x'.repeat(1024) + 'DESKTOP_INTEGRITY OPEN EIO Error\n');
  child.stderr.write('DESKTOP_INTEGRITY OPEN private-token Error\n');
  child.stderr.write('DESKTOP_INTE'); child.stderr.write('GRITY STREAM EINVAL Error\r\n');
  child.stderr.write('DESKTOP_STARTUP MANIFEST FAILED RUNTIME_INTEGRITY_FAILED\n');
  child.stderr.write('DESKTOP_INTEGRITY CLOSE EIO Error\n');
  assert.deepEqual(report.integrityFailure, { operation: 'STREAM', code: 'EINVAL', kind: 'Error' });
  assert.equal(report.startup.code, 'RUNTIME_INTEGRITY_FAILED');
  assert.doesNotMatch(JSON.stringify(report), /private|token/);
  stop(); child.stderr.end();
});

test('finite stream/argument/abort diagnostics retain a cause category without exporting raw details', () => {
  for (const [input, output] of Object.entries({ EBADF: 'RUNTIME_IO_EBADF', EINTR: 'RUNTIME_IO_EINTR',
    EAGAIN: 'RUNTIME_IO_EAGAIN', ECANCELED: 'RUNTIME_IO_ECANCELED', ERR_STREAM_PREMATURE_CLOSE: 'RUNTIME_STREAM_CLOSED',
    ERR_STREAM_DESTROYED: 'RUNTIME_STREAM_DESTROYED', ABORT_ERR: 'RUNTIME_OPERATION_ABORTED',
    ERR_INVALID_ARG_TYPE: 'RUNTIME_NODE_ARGUMENT', ERR_INVALID_ARG_VALUE: 'RUNTIME_NODE_ARGUMENT',
    ERR_OUT_OF_RANGE: 'RUNTIME_NODE_RANGE', ERR_INVALID_STATE: 'RUNTIME_NODE_STATE' })) {
    const error = Object.assign(new Error('private-sentinel-path and value'), { code: input });
    const safe = diagnostics.integrityError(error); expected(output)(safe);
    assert.equal(diagnostics.parseStartupLine('DESKTOP_STARTUP MANIFEST FAILED ' + safe.code).code, output);
  }
  expected('RUNTIME_JS_TYPE_ERROR')(diagnostics.integrityError(new TypeError('private-sentinel')));
  expected('RUNTIME_JS_RANGE_ERROR')(diagnostics.integrityError(new RangeError('private-sentinel')));
  expected('RUNTIME_INTEGRITY_FAILED')(diagnostics.integrityError({ code: 'ERR_STREAM_PRIVATE_SENTINEL' }));
});

test('throwing prototype traps cannot escape the fixed integrity error boundary', () => {
  for (const trapped of [new Proxy({}, { getPrototypeOf() { throw new Error('private-prototype'); } }),
    new Proxy({}, { get() { throw new Error('private-getter'); }, getPrototypeOf() { throw new Error('private-prototype'); } })]) {
    const result = diagnostics.integrityError(trapped);
    expected('RUNTIME_INTEGRITY_FAILED')(result);
    assert.doesNotMatch(JSON.stringify(result), /private/);
  }
});
