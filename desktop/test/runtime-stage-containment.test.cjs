'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const crypto = require('node:crypto');
const { fileURLToPath, pathToFileURL } = require('node:url');
const test = require('node:test');
const { createRuntimeStage } = require('../scripts/runtime-stage.cjs');
const source = fs.readFileSync(path.join(__dirname, '../scripts/stage-runtime.mjs'), 'utf8');

async function fixture(t) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ci-stage-containment-')));
  const stageDirectory = path.join(root, 'desktop/stage'); fs.mkdirSync(stageDirectory, { recursive: true });
  const old = path.join(stageDirectory, 'runtime'); fs.mkdirSync(old); fs.writeFileSync(path.join(old, 'keep'), 'old runtime bytes');
  const tx = createRuntimeStage(stageDirectory);
  t.after(() => { tx.close(); fs.rmSync(root, { recursive: true, force: true }); });
  const context = { fs, path, staging: tx.staging, process: { platform: 'darwin' }, nativePolicy: require('../scripts/native-runtime-policy.cjs') };
  vm.createContext(context);
  const api = await vm.runInContext(`(async () => { 'use strict';
    ${source.slice(source.indexOf('function exec('), source.indexOf("if (process.platform !== 'darwin' || process.arch !== 'arm64')"))}
    globalThis.guardStageDestination = typeof createStageDestinationGuard === 'function' ? createStageDestinationGuard(staging) : undefined;
    return { copy, mergeDirectory, commonDirectory, copyDynamicLibraries };
  })()`, context);
  // The PG layout slice runs separately and needs the helpers from the async scope.
  Object.assign(context, api);
  return { root, stageDirectory, old, tx, context, ...api };
}
function write(root, name, bytes) { const target = path.join(root, name); fs.mkdirSync(path.dirname(target), { recursive: true }); fs.writeFileSync(target, bytes); return target; }
function oldBytes(f) { return fs.readFileSync(path.join(f.old, 'keep'), 'utf8'); }
function pgDestinations(f, inputs) {
  Object.assign(f.context, inputs);
  const start = source.indexOf('const pgLayoutRoot ='), end = source.indexOf('const requiredPgBinaries =', start);
  return vm.runInContext(`${source.slice(start, end)}\n({ postgresBin, postgresFlatLib, postgresPkgLib, postgresShare })`, f.context);
}

test('actual PG layout and merge preserve old runtime when pkglibdir is outside bin/lib/share prefix', async (t) => {
  const f = await fixture(t), prefix = path.join(f.root, 'selected/source/pgroot'), pkg = path.join(f.root, 'selected/runtime');
  for (const name of ['bin', 'lib', 'share']) fs.mkdirSync(path.join(prefix, name), { recursive: true });
  write(pkg, 'keep', 'new extension bytes');
  const targets = pgDestinations(f, { pgBin: path.join(prefix, 'bin'), pgLib: path.join(prefix, 'lib'), pgShare: path.join(prefix, 'share'), pgPkgLib: pkg });
  f.mergeDirectory(pkg, targets.postgresPkgLib);
  assert.equal(oldBytes(f), 'old runtime bytes', 'pre-publication merge must not overwrite the previous runtime');
  assert.ok(targets.postgresPkgLib.startsWith(f.tx.staging + path.sep));
  assert.equal(fs.readFileSync(path.join(targets.postgresPkgLib, 'keep'), 'utf8'), 'new extension bytes');
  f.tx.close(); assert.equal(oldBytes(f), 'old runtime bytes');
});

test('actual merge rejects a destination ancestor link before chmod or outside overwrite', async (t) => {
  const f = await fixture(t), outsideMode = fs.statSync(f.old).mode;
  const input = path.join(f.root, 'source'); write(input, 'keep', 'new extension bytes');
  const linked = path.join(f.tx.staging, 'postgres'); fs.symlinkSync(f.old, linked);
  assert.throws(() => f.mergeDirectory(input, linked), /stage.*destination|destination.*stage/i);
  assert.equal(oldBytes(f), 'old runtime bytes'); assert.equal(fs.statSync(f.old).mode, outsideMode);
});

for (const kind of ['copy', 'merge', 'dependencies']) {
  test(`actual ${kind} rejects lexical destinations outside incoming before creating or replacing files`, async (t) => {
    const f = await fixture(t), input = write(f.root, 'source/keep', 'new bytes');
    for (const outside of [f.old, path.join(f.root, 'missing-parent/new-directory'), f.tx.staging + '-prefix-collision']) {
      const action = kind === 'copy' ? () => f.copy(input, path.join(outside, 'keep'))
        : kind === 'merge' ? () => f.mergeDirectory(path.dirname(input), outside) : () => f.copyDynamicLibraries([], outside);
      assert.throws(action, /stage.*destination|destination.*stage/i);
      assert.equal(oldBytes(f), 'old runtime bytes');
      if (outside !== f.old) assert.equal(fs.existsSync(outside), false);
    }
  });
}
for (const kind of ['ancestor', 'leaf-link', 'leaf-hardlink', 'dangling']) {
  test(`copy refuses ${kind} destination without changing the previous runtime`, async (t) => {
    const f = await fixture(t), input = write(f.root, 'source/keep', 'new bytes'), target = path.join(f.tx.staging, 'target');
    let destination = target;
    if (kind === 'ancestor') { fs.symlinkSync(f.old, target); destination = path.join(target, 'keep'); }
    else if (kind === 'leaf-link') fs.symlinkSync(path.join(f.old, 'keep'), target);
    else if (kind === 'leaf-hardlink') fs.linkSync(path.join(f.old, 'keep'), target);
    else fs.symlinkSync(path.join(f.old, 'not-created'), target);
    assert.throws(() => f.copy(input, destination), /stage.*destination|destination.*stage/i);
    assert.equal(oldBytes(f), 'old runtime bytes'); assert.equal(fs.existsSync(path.join(f.old, 'not-created')), false);
  });
}
test('recursive copy checks each existing nested destination before following an ancestor link', async (t) => {
  const f = await fixture(t), input = path.join(f.root, 'source'), target = path.join(f.tx.staging, 'target');
  write(input, 'nested/keep', 'new nested bytes'); fs.mkdirSync(target); fs.symlinkSync(f.old, path.join(target, 'nested'));
  assert.throws(() => f.copy(input, target), /stage.*destination|destination.*stage/i);
  assert.equal(oldBytes(f), 'old runtime bytes');
});
test('a copied source alias cannot be used as a write-through destination for a later overlay', async (t) => {
  const f = await fixture(t), input = path.join(f.root, 'source'), target = path.join(f.tx.staging, 'target'); fs.mkdirSync(input);
  fs.symlinkSync(f.old, path.join(input, 'nested'));
  f.copy(input, target);
  const nested = path.join(target, 'nested');
  if (!fs.lstatSync(nested).isSymbolicLink()) {
    // Node versions that fully dereference the first copy own independent bytes already.
    assert.notEqual(fs.statSync(path.join(nested, 'keep')).ino, fs.statSync(path.join(f.old, 'keep')).ino);
    fs.rmSync(nested, { recursive: true }); fs.symlinkSync(f.old, nested);
  }
  const overlay = write(f.root, 'overlay/keep', 'overlay bytes');
  assert.throws(() => f.copy(overlay, path.join(nested, 'keep')), /stage.*destination|destination.*stage/i);
  assert.equal(oldBytes(f), 'old runtime bytes');
});
test('changed incoming root identity is rejected before any copy', async (t) => {
  const f = await fixture(t), input = write(f.root, 'source/keep', 'new bytes'), retained = f.tx.staging + '-retained';
  fs.renameSync(f.tx.staging, retained); fs.mkdirSync(f.tx.staging, { mode: 0o700 });
  try {
    assert.throws(() => f.copy(input, path.join(f.tx.staging, 'keep')), /stage.*destination|destination.*stage/i);
    assert.equal(fs.readdirSync(f.tx.staging).length, 0); assert.equal(oldBytes(f), 'old runtime bytes');
  } finally { fs.rmdirSync(f.tx.staging); fs.renameSync(retained, f.tx.staging); }
});
test('changed incoming root mode is rejected before any copy', async (t) => {
  const f = await fixture(t), input = write(f.root, 'source/keep', 'new bytes'), mode = fs.statSync(f.tx.staging).mode & 0o777;
  fs.chmodSync(f.tx.staging, 0o755);
  try { assert.throws(() => f.copy(input, path.join(f.tx.staging, 'keep')), /stage.*destination|destination.*stage/i); }
  finally { fs.chmodSync(f.tx.staging, mode); }
  assert.equal(oldBytes(f), 'old runtime bytes');
});
test('valid nested copy and overlay stay confined to fresh staging', async (t) => {
  const f = await fixture(t), input = path.join(f.root, 'source'), target = path.join(f.tx.staging, 'postgres/lib');
  write(input, 'nested/libexample.dylib', 'first bytes'); f.copy(input, target);
  write(input, 'nested/libexample.dylib', 'replacement bytes'); f.mergeDirectory(input, target);
  assert.equal(fs.readFileSync(path.join(target, 'nested/libexample.dylib'), 'utf8'), 'replacement bytes');
  assert.equal(oldBytes(f), 'old runtime bytes'); f.tx.close(); assert.equal(oldBytes(f), 'old runtime bytes');
});
test('PG build path inputs must be absolute and normalized', async (t) => {
  const f = await fixture(t);
  for (const value of ['relative/lib', '/synthetic/../lib', '/synthetic/lib\0'])
    assert.throws(() => f.commonDirectory(['/synthetic/bin', '/synthetic/share', value]), /absolute normalized/);
});

// Execute the whole actual stage script. All build/config commands and native metadata
// readers are synthetic; filesystem copies, guards, materializers and publisher are real.
async function fullStage(t, { pkgOutside = false, elf = false, wrongJava = false, elfVector = false, missingVector = false } = {}) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ci-stage-complete-')));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const repo = path.join(root, 'repo'), desktop = path.join(repo, 'desktop');
  const pgRoot = path.join(root, 'selected/source/pgroot'), pgBin = path.join(pgRoot, 'bin'), pgLib = path.join(pgRoot, 'lib'), pgShare = path.join(pgRoot, 'share');
  const pgPkgLib = pkgOutside ? path.join(root, 'selected/runtime') : path.join(pgLib, 'postgresql');
  const previous = write(desktop, 'stage/runtime/keep', 'old complete runtime');
  write(pgPkgLib, 'keep', 'new package bytes'); write(pgLib, 'placeholder', 'synthetic library directory');
  for (const name of ['vector', 'pg_trgm']) {
    write(pgShare, `extension/${name}.control`, `default_version = '1.0'\nmodule_pathname = '$libdir/${name}'\n`);
    write(pgShare, `extension/${name}--1.0.sql`, 'CREATE FUNCTION synthetic() RETURNS integer AS \'MODULE_PATHNAME\', \'synthetic\' LANGUAGE C;\n');
    if (name !== 'vector' || !missingVector) write(pgPkgLib, `${name}.dylib`, Buffer.from(elfVector && name === 'vector' ? '7f454c4602010100' : 'cffaedfe00000000', 'hex'));
  }
  const bytes = elf ? Buffer.from('7f454c4602010100', 'hex') : Buffer.from('cffaedfe00000000', 'hex');
  const pgNames = ['postgres', 'initdb', 'pg_isready', 'psql', 'createdb', 'pg_dump', 'pg_restore'];
  for (const name of pgNames) fs.chmodSync(write(pgBin, name, bytes), 0o755);
  const redis = write(root, 'selected/redis-server', bytes); fs.chmodSync(redis, 0o755);
  write(repo, 'backend/build/libs/synthetic.jar', 'synthetic jar');
  // The standalone control runtime and its build proof are staged with the backend since dac77cc.
  const controlJar = write(repo, 'backend/build/libs/code-intelligence-control.jar', 'synthetic control jar');
  write(repo, 'backend/build/libs/code-intelligence-control-provenance.json', JSON.stringify({ format: 1,
    kind: 'DESKTOP_CONTROL_RUNTIME', mainClass: 'dev.codeintelligence.desktop.DesktopControlApplication',
    jarSha256: crypto.createHash('sha256').update(fs.readFileSync(controlJar)).digest('hex') }));
  write(repo, 'backend/src/main/resources/db/migration/V1__synthetic.sql', '-- synthetic');
  write(repo, 'analyzers/ts-analyzer/dist/index.js', '// synthetic');
  for (const name of ['package.json', 'package-lock.json']) write(repo, `analyzers/ts-analyzer/${name}`, '{}');
  write(desktop, 'package.json', JSON.stringify({ build: { mac: { minimumSystemVersion: '13.0' } } }));
  const pgConfig = path.join(root, 'selected/pg_config');
  const env = { CODE_INTELLIGENCE_BUILD_SEQUENCE: '1', JAVA_HOME: path.join(root, 'selected/java'), PG_CONFIG: pgConfig, REDIS_SERVER: redis };
  const exit = [], calls = [];
  function execFileSync(command, args) {
    calls.push([command, ...args]);
    if (command === 'npm' || command === './gradlew') return Buffer.alloc(0);
    if (command === path.join(env.JAVA_HOME, 'bin/jlink')) {
      const output = args[args.indexOf('--output') + 1];
      write(output, 'release', `JAVA_VERSION="${wrongJava ? '26.0.2' : '21.0.12'}"\n`);
      fs.chmodSync(write(output, 'bin/java', Buffer.from('cffaedfe00000000', 'hex')), 0o755);
      for (const file of ['lib/libjli.dylib', 'lib/libjava.dylib', 'lib/server/libjvm.dylib']) write(output, file, Buffer.from('cffaedfe00000000', 'hex'));
      fs.chmodSync(write(output, 'legal/java.base/LICENSE', 'public synthetic license'), 0o444);
      return Buffer.alloc(0);
    }
    if (command === pgConfig) return ({ '--bindir': pgBin, '--libdir': pgLib, '--pkglibdir': pgPkgLib, '--sharedir': pgShare })[args[0]] + '\n';
    if (command === '/usr/bin/file' && args[0] === '-b') return 'Mach-O 64-bit dynamically linked shared library arm64\n';
    if (['otool', '/usr/bin/otool'].includes(command) && args.includes('-l')) {
      const identity = path.basename(args.at(-1)) === 'libjvm.dylib'
        ? 'Load command 2\ncmd LC_ID_DYLIB\nname @rpath/libjvm.dylib (offset 24)\n' : '';
      return 'Load command 0\ncmd LC_BUILD_VERSION\nplatform 1\nminos 13.0\nsdk 26.4\nLoad command 1\ncmd LC_LOAD_DYLIB\nname /usr/lib/libSystem.B.dylib (offset 24)\n' + identity;
    }
    throw new Error('Unexpected synthetic command');
  }
  const nativePolicy = require('../scripts/native-runtime-policy.cjs');
  let error, gateCalls = 0, required, modules;
  const policyWrapper = { ...nativePolicy, verifyNativeRuntime(options) {
    gateCalls++; required = options.requiredExecutables; modules = options.requiredModules;
    return nativePolicy.verifyNativeRuntime({ ...options, inspect: file => ({
      fileDescription: `Mach-O 64-bit ${file.includes('/jre/') && file.endsWith('.dylib') ? 'dynamically linked shared library' : file.endsWith('.dylib') || file.endsWith('.so') ? 'bundle' : 'executable'} arm64\n`, architectures: 'arm64\n',
      loadCommands: 'Load command 0\ncmd LC_BUILD_VERSION\nplatform 1\nminos 13.0\nsdk 26.4\n',
    }) });
  } };
  try {
    // Keep all module bindings in one async scope; settle it before exit cleanup.
    await vm.runInNewContext(`(async () => { 'use strict';
      ${source.replace(/^import .*;\n/gm, '').replaceAll('import.meta.url', 'moduleURL')}
    })()`, {
      fs, path, crypto, fileURLToPath, execFileSync, Buffer, runtimeStage: { createRuntimeStage, requireBuildSequence: require('../scripts/runtime-stage.cjs').requireBuildSequence },
      nativePolicy: policyWrapper, moduleURL: pathToFileURL(path.join(desktop, 'scripts/stage-runtime.mjs')).href,
      process: { env, platform: 'darwin', arch: 'arm64', stdout: { write() {} }, stderr: { write() {} }, on(name, handler) { assert.equal(name, 'exit'); exit.push(handler); } },
      console: { log() {} },
    }, { timeout: 10000 });
  } catch (value) { error = value; }
  finally { for (const handler of exit) handler(); }
  return { desktop, previous, error, gateCalls, required, modules, calls };
}

test('whole stage preserves the old runtime after external pkglibdir merge and final gate failure', async (t) => {
  const f = await fullStage(t, { pkgOutside: true, wrongJava: true });
  assert.equal(f.gateCalls, 1); assert.equal(f.error.code, 'NATIVE_RUNTIME_POLICY');
  assert.ok(f.error.findings.some(item => item.code === 'JAVA_MAJOR_MISMATCH'));
  assert.equal(fs.readFileSync(f.previous, 'utf8'), 'old complete runtime');
  assert.deepEqual(fs.readdirSync(path.join(f.desktop, 'stage')), ['runtime']);
});
test('whole stage refuses non-Mach-O PostgreSQL and Redis binaries before an arm64 manifest is published', async (t) => {
  const f = await fullStage(t, { elf: true });
  assert.equal(f.gateCalls, 1); assert.equal(f.error.code, 'NATIVE_RUNTIME_POLICY');
  assert.equal(f.error.findings.filter(item => item.code === 'REQUIRED_EXECUTABLE_MISSING').length, 8);
  assert.equal(f.required.length, 9); assert.equal(fs.readFileSync(f.previous, 'utf8'), 'old complete runtime');
  assert.equal(fs.existsSync(path.join(f.desktop, 'stage/runtime/runtime-manifest.json')), false);
  assert.deepEqual(fs.readdirSync(path.join(f.desktop, 'stage')), ['runtime']);
});
test('whole compatible synthetic stage publishes all nine required executables and retains its predecessor', async (t) => {
  const f = await fullStage(t); assert.equal(f.error, undefined); assert.equal(f.gateCalls, 1); assert.equal(f.required.length, 9);
  const stage = path.join(f.desktop, 'stage'), retained = fs.readdirSync(stage).find(name => name.startsWith('runtime.previous-'));
  assert.ok(retained); assert.equal(fs.readFileSync(path.join(stage, retained, 'keep'), 'utf8'), 'old complete runtime');
  const manifest = JSON.parse(fs.readFileSync(path.join(stage, 'runtime/runtime-manifest.json')));
  assert.equal(manifest.arch, 'arm64'); assert.equal(manifest.ownershipProtocol, 1); assert.equal(manifest.backupProtocol, 3);
  for (const file of f.required) assert.ok(manifest.files[file]);
  assert.equal(f.modules.length, 5); for (const file of f.modules) assert.ok(manifest.files[file]);
});
test('whole stage refuses an ELF pgvector plugin while retaining the previous runtime', async (t) => {
  const f = await fullStage(t, { elfVector: true }); assert.equal(f.gateCalls, 1);
  assert.equal(f.error.code, 'NATIVE_RUNTIME_POLICY'); assert.ok(f.error.findings.some(item => item.code === 'UNSUPPORTED_LIBRARY_FORMAT'));
  assert.equal(fs.readFileSync(f.previous, 'utf8'), 'old complete runtime');
  assert.deepEqual(fs.readdirSync(path.join(f.desktop, 'stage')), ['runtime']);
});
test('whole stage refuses a missing pgvector plugin despite present control and installation SQL', async (t) => {
  const f = await fullStage(t, { missingVector: true }); assert.equal(f.gateCalls, 1);
  assert.equal(f.error.code, 'NATIVE_RUNTIME_POLICY'); assert.ok(f.error.findings.some(item => item.code === 'REQUIRED_MODULE_MISSING'));
  assert.equal(fs.readFileSync(f.previous, 'utf8'), 'old complete runtime');
  assert.deepEqual(fs.readdirSync(path.join(f.desktop, 'stage')), ['runtime']);
});
