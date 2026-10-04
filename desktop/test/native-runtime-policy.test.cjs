'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const test = require('node:test');
const policy = require('../scripts/native-runtime-policy.cjs');
const { createRuntimeStage } = require('../scripts/runtime-stage.cjs');

// Metadata is synthetic; these tests never execute a native binary or an Apple tool.
const JAVA_RELEASE = 'JAVA_VERSION="21.0.12"\nMODULES="java.base java.sql"\n';
const PG_TOOLS = ['postgres', 'initdb', 'pg_isready', 'psql', 'createdb', 'pg_dump', 'pg_restore'];
const requiredExecutables = ['jre/bin/java', ...PG_TOOLS.map(name => `postgres/bin/${name}`), 'redis/bin/redis-server'];
const requiredModules = ['jre/lib/libjli.dylib', 'jre/lib/libjava.dylib', 'jre/lib/server/libjvm.dylib',
  'postgres/lib/postgresql/vector.dylib', 'postgres/lib/postgresql/pg_trgm.dylib'];
const postgresShare = 'postgres/share';
const digest = value => crypto.createHash('sha256').update(value).digest('hex');
function commands({ minimum = '13.0', platform = '1', old = false, deps = [], rpaths = [], extra = [] } = {}) {
  const blocks = [old ? `cmd LC_VERSION_MIN_MACOSX\nversion ${minimum}\nsdk 26.4`
    : `cmd LC_BUILD_VERSION\nplatform ${platform}\nminos ${minimum}\nsdk 26.4\nntools 1\ntool 3\nversion 1266.8`,
  ...deps.map(value => `cmd LC_LOAD_DYLIB\nname ${value} (offset 24)`),
  ...rpaths.map(value => `cmd LC_RPATH\npath ${value} (offset 12)`), ...extra];
  return 'synthetic-native:\n' + blocks.map((block, index) => `Load command ${index}\n${block}\n`).join('');
}
function entry(file, settings = {}) {
  const executable = requiredExecutables.includes(file);
  return { file, sha256: digest(file), mode: executable ? 0o755 : 0o644,
    fileDescription: `Mach-O 64-bit ${executable ? 'executable' : 'dynamically linked shared library'} arm64\n`,
    architectures: 'arm64\n', loadCommands: commands(settings), ...settings.entry };
}
function inventory() {
  return { minimumSystemVersion: '13.0', release: JAVA_RELEASE, requiredExecutables, requiredModules, native: [
    entry('jre/bin/java', { deps: ['@rpath/libjli.dylib', '/usr/lib/libSystem.B.dylib'], rpaths: ['@loader_path/../lib'] }),
    entry('jre/lib/libjli.dylib', { minimum: '11.0', deps: ['@loader_path/server/libjvm.dylib'] }),
    entry('jre/lib/server/libjvm.dylib', { old: true, deps: ['/System/Library/Frameworks/CoreFoundation.framework/Versions/A/CoreFoundation'] }),
    ...requiredExecutables.slice(1).map(file => entry(file)),
    entry('jre/lib/libjava.dylib'), ...requiredModules.slice(3).map(file => entry(file)),
  ] };
}
function rejects(action, code) {
  assert.throws(action, error => {
    assert.ok(error instanceof policy.NativeRuntimePolicyError, error.stack);
    assert.equal(error.code, 'NATIVE_RUNTIME_POLICY');
    assert.ok(error.findings.some(item => item.code === code), JSON.stringify(error.findings));
    return true;
  });
}
function fixture(t) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ci-native-policy-')));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}
function write(root, relative, content) {
  const file = path.join(root, relative);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
  return file;
}
function stage(root, candidate = inventory()) {
  write(root, 'jre/release', candidate.release);
  for (const name of ['vector', 'pg_trgm']) {
    write(root, `${postgresShare}/extension/${name}.control`, `default_version = '1.0'\nmodule_pathname = '$libdir/${name}'\n`);
    write(root, `${postgresShare}/extension/${name}--1.0.sql`, 'CREATE FUNCTION synthetic() RETURNS integer AS \'MODULE_PATHNAME\', \'synthetic\' LANGUAGE C;\n');
  }
  for (const item of candidate.native) {
    const file = write(root, item.file, Buffer.concat([Buffer.from('cffaedfe', 'hex'), Buffer.from(item.file)]));
    fs.chmodSync(file, item.mode);
  }
  write(root, 'backend/example.jar', 'synthetic non-native bytes');
  return file => {
    const item = candidate.native.find(item => path.join(root, item.file) === file);
    assert.ok(item, `unexpected native inspection: ${file}`);
    return { fileDescription: item.fileDescription, architectures: item.architectures, loadCommands: item.loadCommands };
  };
}

test('fixed policy agrees with package minimum and Gradle Java toolchain contract', () => {
  assert.deepEqual(policy.POLICY, { minimumSystemVersion: '13.0', javaMajor: 21, architecture: 'arm64' });
  assert.equal(require('../package.json').build.mac.minimumSystemVersion, '13.0');
  assert.match(fs.readFileSync(path.resolve(__dirname, '../../backend/build.gradle.kts'), 'utf8'), /JavaLanguageVersion\.of\(21\)/);
});

test('self-resolving arm64 Java 21 closure with macOS 11 and 13 minima passes', () => {
  assert.deepEqual(policy.validateNativeInventory(inventory()), { nativeFiles: 14, architecture: 'arm64', minimumSystemVersion: '13.0', javaMajor: 21 });
});

for (const minimum of ['11', '12.99.99', '13', '13.0', '13.0.0']) {
  test(`deployment target ${minimum} meets the macOS 13.0 floor`, () => {
    const value = inventory(); value.native[0].loadCommands = commands({ minimum });
    assert.equal(policy.validateNativeInventory(value).minimumSystemVersion, '13.0');
  });
}
for (const minimum of ['13.0.1', '13.1', '14', '26.0']) {
  test(`deployment target ${minimum} blocks publication without raising the app floor`, () => {
    const value = inventory(); value.native[1].loadCommands = commands({ minimum });
    rejects(() => policy.validateNativeInventory(value), 'MINIMUM_OS_EXCEEDED');
  });
}
for (const minimum of ['01.0', '13.00', '13.0.0.1', '65536', '..']) {
  test(`malformed deployment target ${minimum} is refused`, () => {
    rejects(() => policy.parseLoadCommands(commands({ minimum })), 'INVALID_DEPLOYMENT_TARGET');
  });
}
test('deployment metadata supports old minimum command and named macOS build platform', () => {
  assert.equal(policy.parseLoadCommands(commands({ minimum: '10.15', old: true })).minimum, '10.15');
  assert.equal(policy.parseLoadCommands(commands({ platform: 'macOS' })).minimum, '13.0');
});
for (const platform of ['2', 'iOS', '6']) {
  test(`non-macOS native platform ${platform} is refused`, () => {
    rejects(() => policy.parseLoadCommands(commands({ platform })), 'UNSUPPORTED_NATIVE_PLATFORM');
  });
}
test('missing or two deployment commands do not silently select a floor', () => {
  rejects(() => policy.parseLoadCommands('Load command 0\ncmd LC_UUID\nuuid 00\n'), 'MISSING_OR_AMBIGUOUS_DEPLOYMENT_TARGET');
  rejects(() => policy.parseLoadCommands(commands({ extra: ['cmd LC_VERSION_MIN_MACOSX\nversion 11.0'] })), 'MISSING_OR_AMBIGUOUS_DEPLOYMENT_TARGET');
});
test('duplicate fields and malformed or excessive tool output fail closed', () => {
  for (const text of [commands().replace('minos 13.0', 'minos 13.0\nminos 26.0'), commands().replace('platform 1', 'platform 1\nplatform 2'),
    commands().replace('cmd LC_BUILD_VERSION', 'cmd LC_BUILD_VERSION\ncmd LC_UUID'), '', 'x'.repeat(1024 * 1024 + 1), commands() + '\0']) {
    rejects(() => policy.parseLoadCommands(text), 'INVALID_LOAD_COMMANDS');
  }
});
test('embedded dynamic-loader environment or non-system loader is refused', () => {
  rejects(() => policy.parseLoadCommands(commands({ extra: ['cmd LC_DYLD_ENVIRONMENT\nname DYLD_LIBRARY_PATH=/tmp (offset 12)'] })), 'EMBEDDED_DYLD_ENVIRONMENT');
  rejects(() => policy.parseLoadCommands(commands({ extra: ['cmd LC_LOAD_DYLINKER\nname /build/dyld (offset 12)'] })), 'UNSUPPORTED_DYNAMIC_LINKER');
  assert.deepEqual(policy.parseLoadCommands(commands({ extra: ['cmd LC_LOAD_DYLINKER\nname /usr/lib/dyld (offset 12)'] })).dependencies, ['/usr/lib/dyld']);
});
test('LC_ID_DYLIB is not mistaken for a dependency', () => {
  const value = inventory(); value.native[1].loadCommands = commands({ extra: ['cmd LC_ID_DYLIB\nname /build/identity-only.dylib (offset 24)'] });
  assert.equal(policy.validateNativeInventory(value).nativeFiles, 14);
});

for (const major of ['17.0.15', '22', '26.0.2']) {
  test(`JAVA_VERSION ${major} is refused even with compatible deployment metadata`, () => {
    rejects(() => policy.validateNativeInventory({ ...inventory(), release: `JAVA_VERSION="${major}"\n` }), 'JAVA_MAJOR_MISMATCH');
  });
}
for (const release of ['', 'JAVA_VERSION="21.0.12"\nJAVA_VERSION="26.0.2"\n', 'JAVA_VERSION="021.0.12"\n', 'JAVA_VERSION="21.0.12"\0', 'x'.repeat(65537)]) {
  test(`invalid Java release metadata ${digest(release).slice(0, 8)} is refused`, () => {
    rejects(() => policy.validateNativeInventory({ ...inventory(), release }), 'INVALID_JAVA_RELEASE');
  });
}
test('raising or omitting the declaration cannot bypass the fixed macOS 13.0 policy', () => {
  for (const minimumSystemVersion of [undefined, '13.0.0', '26.0'])
    rejects(() => policy.validateNativeInventory({ ...inventory(), minimumSystemVersion }), 'DECLARED_MINIMUM_CHANGED');
});
test('missing Java launcher, wrong architecture, and non-native type each fail', () => {
  const value = inventory(); value.native = value.native.slice(1);
  rejects(() => policy.validateNativeInventory(value), 'JAVA_LAUNCHER_MISSING');
  const second = inventory(); second.native[1].architectures = 'x86_64\n';
  rejects(() => policy.validateNativeInventory(second), 'ARCHITECTURE_MISMATCH');
  second.native[1].architectures = 'arm64\0';
  rejects(() => policy.validateNativeInventory(second), 'INVALID_ARCHITECTURE_OUTPUT');
  second.native[1].architectures = 'arm64\n'; second.native[1].fileDescription = 'ELF shared object';
  rejects(() => policy.validateNativeInventory(second), 'UNSUPPORTED_NATIVE_TYPE');
});
test('universal binary with an inspected arm64 slice is accepted', () => {
  const value = inventory(); value.native[0].architectures = 'x86_64 arm64\n';
  assert.equal(policy.validateNativeInventory(value).architecture, 'arm64');
});
test('required native Java entrypoint cannot be a Mach-O dylib', () => {
  const value = inventory(); value.native[0].fileDescription = 'Mach-O 64-bit dynamically linked shared library arm64';
  rejects(() => policy.validateNativeInventory(value), 'REQUIRED_EXECUTABLE_TYPE');
});
test('a dylib load cannot resolve to MH_EXECUTE despite matching path and architecture', () => {
  const value = inventory(); value.native[1].fileDescription = 'Mach-O 64-bit executable arm64';
  rejects(() => policy.validateNativeInventory(value), 'DEPENDENCY_NOT_DYLIB');
});
test('required entrypoint must have owner execute permission', () => {
  const value = inventory(); value.native[0].mode = 0o644;
  rejects(() => policy.validateNativeInventory(value), 'REQUIRED_EXECUTABLE_MODE');
});
test('required native PG and Redis entrypoints cannot disappear through the Mach-O magic filter', t => {
  for (const name of requiredExecutables.slice(1)) {
    const root = fixture(t), inspect = stage(root);
    const elf = Buffer.alloc(64); elf.set([0x7f, 0x45, 0x4c, 0x46, 2, 1, 1]);
    elf.writeUInt16LE(2, 16); elf.writeUInt16LE(0x3e, 18); fs.writeFileSync(path.join(root, name), elf);
    rejects(() => policy.verifyNativeRuntime({ root, requiredExecutables, requiredModules, postgresShare, minimumSystemVersion: '13.0', inspect }), 'REQUIRED_EXECUTABLE_MISSING');
  }
});
test('required entrypoint contract cannot omit, duplicate, rename or move a product role', () => {
  for (const entries of [undefined, [], requiredExecutables.slice(0, -1), [...requiredExecutables.slice(0, -1), 'jre/bin/java'],
    requiredExecutables.map(name => name.endsWith('/postgres') ? 'other/bin/postgres' : name),
    requiredExecutables.map(name => name.endsWith('/psql') ? 'postgres/other-bin/psql' : name)]) {
    rejects(() => policy.validateNativeInventory({ ...inventory(), requiredExecutables: entries }), 'INVALID_REQUIRED_EXECUTABLES');
  }
});
test('Java cannot inherit executable kind from an unrelated universal x86-64 slice', () => {
  const value = inventory(); value.native[0].architectures = 'x86_64 arm64';
  value.native[0].fileDescription = 'Mach-O universal binary: [x86_64:Mach-O 64-bit executable x86_64] [arm64:Mach-O 64-bit dynamically linked shared library arm64]';
  rejects(() => policy.validateNativeInventory(value), 'REQUIRED_EXECUTABLE_TYPE');
});
test('dylib references reject MH_BUNDLE as well as an executable', () => {
  const value = inventory(); value.native[1].fileDescription = 'Mach-O 64-bit bundle arm64';
  rejects(() => policy.validateNativeInventory(value), 'DEPENDENCY_NOT_DYLIB');
});
test('an inspection callback cannot override filesystem execute permission', (t) => {
  const root = fixture(t), inspect = stage(root); fs.chmodSync(path.join(root, 'jre/bin/java'), 0o644);
  rejects(() => policy.verifyNativeRuntime({ root, requiredExecutables, requiredModules, postgresShare, minimumSystemVersion: '13.0',
    inspect: file => ({ ...inspect(file), mode: 0o755 }) }), 'REQUIRED_EXECUTABLE_MODE');
});
test('required pgvector ELF module is rejected even when all nine executable roles are healthy', t => {
  const root = fixture(t), inspect = stage(root);
  fs.writeFileSync(path.join(root, 'postgres/lib/postgresql/vector.dylib'), Buffer.from('7f454c4602010100', 'hex'));
  rejects(() => policy.verifyNativeRuntime({ root, requiredExecutables, requiredModules, postgresShare, minimumSystemVersion: '13.0', inspect }), 'UNSUPPORTED_LIBRARY_FORMAT');
});
test('required pgvector module cannot be omitted', () => {
  const value = inventory(); value.native = value.native.filter(item => !item.file.endsWith('/vector.dylib'));
  rejects(() => policy.validateNativeInventory(value), 'REQUIRED_MODULE_MISSING');
});
test('required pg_trgm module cannot be omitted', () => {
  const value = inventory(); value.native = value.native.filter(item => !item.file.endsWith('/pg_trgm.dylib'));
  rejects(() => policy.validateNativeInventory(value), 'REQUIRED_MODULE_MISSING');
});
test('required pgvector module cannot be MH_EXECUTE', () => {
  const value = inventory(); value.native.find(item => item.file.endsWith('/vector.dylib')).fileDescription = 'Mach-O 64-bit executable arm64';
  rejects(() => policy.validateNativeInventory(value), 'REQUIRED_MODULE_TYPE');
});
test('unlisted library-shaped ELF file cannot disappear through native magic filtering', t => {
  const root = fixture(t), inspect = stage(root);
  write(root, 'postgres/lib/extra.dylib', Buffer.from('7f454c4602010100', 'hex'));
  rejects(() => policy.verifyNativeRuntime({ root, requiredExecutables, requiredModules, postgresShare, minimumSystemVersion: '13.0', inspect }), 'UNSUPPORTED_LIBRARY_FORMAT');
});
for (const name of requiredModules.slice(0, 3)) {
  test(`required Java native module ${name} cannot be omitted`, () => {
    const value = inventory(); value.native = value.native.filter(item => item.file !== name);
    rejects(() => policy.validateNativeInventory(value), 'REQUIRED_MODULE_MISSING');
  });
}
test('required module contract cannot omit or substitute roles or split PG lib directories', () => {
  for (const modules of [undefined, [], requiredModules.slice(1), [...requiredModules.slice(0, -1), requiredModules[0]],
    requiredModules.map(name => name.endsWith('/pg_trgm.dylib') ? 'postgres/other/pg_trgm.dylib' : name)])
    rejects(() => policy.validateNativeInventory({ ...inventory(), requiredModules: modules }), 'INVALID_REQUIRED_MODULES');
});
for (const kind of ['bundle', 'dynamically linked shared library']) {
  test(`PostgreSQL vector and pg_trgm allow compatible arm64 ${kind} modules`, () => {
    const value = inventory();
    for (const name of requiredModules.slice(3)) value.native.find(item => item.file === name).fileDescription = `Mach-O 64-bit ${kind} arm64`;
    assert.equal(policy.validateNativeInventory(value).nativeFiles, 14);
  });
}
test('required modules also enforce arm64, macOS floor, readable mode and JRE dylib kind', () => {
  for (const [mutation, code] of [
    [item => { item.architectures = 'x86_64'; }, 'ARCHITECTURE_MISMATCH'],
    [item => { item.loadCommands = commands({ minimum: '26.0' }); }, 'MINIMUM_OS_EXCEEDED'],
    [item => { item.mode = 0; }, 'REQUIRED_MODULE_MODE'],
  ]) {
    const value = inventory(); mutation(value.native.find(item => item.file.endsWith('/vector.dylib')));
    rejects(() => policy.validateNativeInventory(value), code);
  }
  const value = inventory(); value.native[1].fileDescription = 'Mach-O 64-bit bundle arm64';
  rejects(() => policy.validateNativeInventory(value), 'REQUIRED_MODULE_TYPE');
});
test('all dynamic-library suffixes reject foreign or non-native bytes without relying on execute bits', t => {
  for (const name of ['extra.so', 'extra.so.1', 'extra.dylib', 'extra.jnilib', 'extra.node', 'extra.DYLIB']) {
    const root = fixture(t), inspect = stage(root); write(root, `postgres/lib/${name}`, 'non-native text');
    rejects(() => policy.verifyNativeRuntime({ root, requiredExecutables, requiredModules, postgresShare, minimumSystemVersion: '13.0', inspect }), 'UNSUPPORTED_LIBRARY_FORMAT');
  }
});
test('unlisted ELF native objects are rejected even without a library extension', t => {
  const root = fixture(t), inspect = stage(root); write(root, 'postgres/lib/foreign-object', Buffer.from('7f454c4602010100', 'hex'));
  rejects(() => policy.verifyNativeRuntime({ root, requiredExecutables, requiredModules, postgresShare, minimumSystemVersion: '13.0', inspect }), 'FOREIGN_NATIVE_FORMAT');
});
test('library names cannot disguise Mach-O executables as plugin or dylib roles', () => {
  const value = inventory(); value.native.push(entry('postgres/lib/extra.so', { entry: { fileDescription: 'Mach-O 64-bit executable arm64' } }));
  rejects(() => policy.validateNativeInventory(value), 'LIBRARY_ROLE_TYPE');
});
test('a macOS PostgreSQL .dylib filename may contain a dlopen MH_BUNDLE', () => {
  const value = inventory(); value.native.push(entry('postgres/lib/postgresql/other_plugin.dylib', {
    entry: { fileDescription: 'Mach-O 64-bit bundle arm64' },
  }));
  assert.equal(policy.validateNativeInventory(value).nativeFiles, 15);
});
test('the reviewed macOS PG role cannot be satisfied by a differently suffixed module', () => {
  const value = inventory(); value.native.find(item => item.file.endsWith('/vector.dylib')).file = 'postgres/lib/postgresql/vector.so';
  rejects(() => policy.validateNativeInventory(value), 'REQUIRED_MODULE_MISSING');
});
test('extension controls must bind exactly to their expected libdir module and canonical default version', t => {
  for (const text of ["default_version = '1.0'\nmodule_pathname = '/outside/vector'\n",
    "default_version = '1.0'\nmodule_pathname = '$libdir/other'\n",
    "default_version = '../outside'\nmodule_pathname = '$libdir/vector'\n",
    "default_version = '1.0'\ndefault_version = '2.0'\nmodule_pathname = '$libdir/vector'\n",
    "default_version = '1.0'\nmodule_pathname = '$libdir/vector'\nmodule_pathname = '/outside'\n"]) {
    const root = fixture(t), inspect = stage(root); write(root, `${postgresShare}/extension/vector.control`, text);
    rejects(() => policy.verifyNativeRuntime({ root, requiredExecutables, requiredModules, postgresShare, minimumSystemVersion: '13.0', inspect }), 'EXTENSION_CONTROL_BINDING');
  }
});
test('both required PG extensions need a bounded control and corresponding installation SQL', t => {
  for (const name of ['vector', 'pg_trgm']) {
    for (const suffix of ['.control', '--1.0.sql']) {
      const root = fixture(t), inspect = stage(root); fs.unlinkSync(path.join(root, postgresShare, 'extension', name + suffix));
      rejects(() => policy.verifyNativeRuntime({ root, requiredExecutables, requiredModules, postgresShare, minimumSystemVersion: '13.0', inspect }),
        suffix === '.control' ? 'REQUIRED_EXTENSION_CONTROL' : 'REQUIRED_EXTENSION_SQL');
    }
  }
});
test('extension metadata rejects oversized, empty, NUL and invalid UTF-8 inputs', t => {
  for (const [suffix, content] of [['.control', Buffer.alloc(65537, 'x')], ['.control', Buffer.from([0xff])],
    ['--1.0.sql', Buffer.alloc(0)], ['--1.0.sql', Buffer.from([0])], ['--1.0.sql', Buffer.alloc(4 * 1024 * 1024 + 1, 'x')]]) {
    const root = fixture(t), inspect = stage(root); write(root, `${postgresShare}/extension/vector${suffix}`, content);
    rejects(() => policy.verifyNativeRuntime({ root, requiredExecutables, requiredModules, postgresShare, minimumSystemVersion: '13.0', inspect }),
      suffix === '.control' ? 'REQUIRED_EXTENSION_CONTROL' : 'REQUIRED_EXTENSION_SQL');
  }
});
test('actual macOS pg_trgm base1.3 and upgrades to default1.6 form a valid installation path', t => {
  const root = fixture(t), inspect = stage(root), extension = path.join(root, postgresShare, 'extension');
  write(root, `${postgresShare}/extension/pg_trgm.control`, "default_version = '1.6'\nmodule_pathname = '$libdir/pg_trgm'\n");
  fs.unlinkSync(path.join(extension, 'pg_trgm--1.0.sql'));
  for (const file of ['pg_trgm--1.3.sql', 'pg_trgm--1.3--1.4.sql', 'pg_trgm--1.4--1.5.sql', 'pg_trgm--1.5--1.6.sql'])
    write(extension, file, '-- public synthetic SQL metadata\nSELECT 1;\n');
  assert.equal(policy.verifyNativeRuntime({ root, requiredExecutables, requiredModules, postgresShare, minimumSystemVersion: '13.0', inspect }).nativeFiles, 14);
});
test('missing base or an interrupted upgrade chain cannot satisfy an extension default version', t => {
  for (const scripts of [['pg_trgm--1.3--1.4.sql', 'pg_trgm--1.4--1.6.sql'],
    ['pg_trgm--1.3.sql', 'pg_trgm--1.3--1.4.sql', 'pg_trgm--1.5--1.6.sql'],
    ['pg_trgm--1.3.sql', 'pg_trgm--1.3--1.4.sql', 'pg_trgm--1.4--1.3.sql']]) {
    const root = fixture(t), inspect = stage(root), extension = path.join(root, postgresShare, 'extension');
    write(extension, 'pg_trgm.control', "default_version = '1.6'\nmodule_pathname = '$libdir/pg_trgm'\n");
    fs.unlinkSync(path.join(extension, 'pg_trgm--1.0.sql'));
    for (const file of scripts) write(extension, file, 'SELECT 1;\n');
    rejects(() => policy.verifyNativeRuntime({ root, requiredExecutables, requiredModules, postgresShare, minimumSystemVersion: '13.0', inspect }), 'REQUIRED_EXTENSION_SQL');
  }
});
test('every SQL file on the selected installation chain must pass bounded UTF-8 validation', t => {
  const root = fixture(t), inspect = stage(root), extension = path.join(root, postgresShare, 'extension');
  write(extension, 'pg_trgm.control', "default_version = '1.6'\nmodule_pathname = '$libdir/pg_trgm'\n");
  fs.unlinkSync(path.join(extension, 'pg_trgm--1.0.sql')); write(extension, 'pg_trgm--1.3.sql', 'SELECT 1;\n');
  write(extension, 'pg_trgm--1.3--1.6.sql', Buffer.from([0xff]));
  rejects(() => policy.verifyNativeRuntime({ root, requiredExecutables, requiredModules, postgresShare, minimumSystemVersion: '13.0', inspect }), 'REQUIRED_EXTENSION_SQL');
});
test('inventory paths, duplicate files and hashes must be exact', () => {
  for (const file of ['.', '../java', '/jre/bin/java', 'jre//bin/java', 'jre/../java', 'jre\\java', 'jre/java\n']) {
    const value = inventory(); value.native[0].file = file;
    rejects(() => policy.validateNativeInventory(value), 'INVALID_INVENTORY');
  }
  const value = inventory(); value.native.push(value.native[0]);
  rejects(() => policy.validateNativeInventory(value), 'INVALID_INVENTORY');
  const badHash = inventory(); badHash.native[0].sha256 += '\n';
  rejects(() => policy.validateNativeInventory(badHash), 'INVALID_INVENTORY');
});

for (const reference of ['/opt/homebrew/opt/example/lib/libjli.dylib', '/tmp/stage/jre/lib/libjli.dylib', 'libjli.dylib', '/usr/lib/../../build/evil.dylib']) {
  test(`host-dependent load reference ${reference} is rejected despite a matching bundled basename`, () => {
    const value = inventory(); value.native[0].loadCommands = commands({ deps: [reference] });
    rejects(() => policy.validateNativeInventory(value), 'NON_RELOCATABLE_REFERENCE');
  });
}
test('missing or unresolved optional and re-exported dylibs also block publication', () => {
  for (const command of ['LC_LOAD_DYLIB', 'LC_LOAD_WEAK_DYLIB', 'LC_REEXPORT_DYLIB', 'LC_LOAD_UPWARD_DYLIB', 'LC_LAZY_LOAD_DYLIB', 'LC_PREBOUND_DYLIB']) {
    const value = inventory(); value.native[0].loadCommands = commands({ extra: [`cmd ${command}\nname @loader_path/missing.dylib (offset 24)`] });
    rejects(() => policy.validateNativeInventory(value), 'UNRESOLVED_NATIVE_REFERENCE');
  }
});
test('rpath requires the owning object to supply a closed resolution without DYLD fallback', () => {
  const value = inventory(); value.native[0].loadCommands = commands({ deps: ['@rpath/libjli.dylib'] });
  const previous = process.env.DYLD_LIBRARY_PATH;
  process.env.DYLD_LIBRARY_PATH = '/synthetic/host/lib';
  try { rejects(() => policy.validateNativeInventory(value), 'UNRESOLVED_NATIVE_REFERENCE'); }
  finally { if (previous === undefined) delete process.env.DYLD_LIBRARY_PATH; else process.env.DYLD_LIBRARY_PATH = previous; }
});
test('rpath never accepts host absolute directories or guesses a plugin executable', () => {
  for (const rpath of ['/opt/homebrew/lib', '@rpath/lib', '@executable_path/../lib']) {
    const value = inventory(); value.native[1].loadCommands = commands({ rpaths: [rpath] });
    rejects(() => policy.validateNativeInventory(value), 'UNSUPPORTED_RPATH');
  }
});
test('executable-relative references resolve only on an actual executable', () => {
  const value = inventory(); value.native[0].loadCommands = commands({ deps: ['@executable_path/../lib/libjli.dylib'] });
  assert.equal(policy.validateNativeInventory(value).nativeFiles, 14);
  value.native[1].loadCommands = commands({ deps: ['@executable_path/../lib/libjli.dylib'] });
  rejects(() => policy.validateNativeInventory(value), 'NON_RELOCATABLE_REFERENCE');
});
test('loader and rpath traversal cannot escape the staged runtime', () => {
  for (const config of [{ deps: ['@loader_path/../../../outside.dylib'] },
    { rpaths: ['@loader_path/../../..'], deps: ['@rpath/outside.dylib'] },
    { rpaths: ['@loader_path'], deps: ['@rpath/../../../outside.dylib'] }]) {
    const value = inventory(); value.native[0].loadCommands = commands(config);
    rejects(() => policy.validateNativeInventory(value), 'ESCAPING_NATIVE_REFERENCE');
  }
});
test('conflicting basenames fail and identical copies remain acceptable', () => {
  const value = inventory(); value.native.push(entry('redis/lib/libjli.dylib'));
  rejects(() => policy.validateNativeInventory(value), 'BASENAME_COLLISION');
  value.native.at(-1).sha256 = value.native[1].sha256;
  assert.equal(policy.validateNativeInventory(value).nativeFiles, 15);
});
test('multiple rpath candidates with different bytes are explicitly ambiguous', () => {
  const value = inventory(); value.native.push(entry('redis/lib/libjli.dylib'));
  value.native[0].loadCommands = commands({ deps: ['@rpath/libjli.dylib'], rpaths: ['@loader_path/../lib', '@loader_path/../../redis/lib'] });
  rejects(() => policy.validateNativeInventory(value), 'AMBIGUOUS_NATIVE_REFERENCE');
});

test('copy guard skips only canonical OS library references', (t) => {
  const root = fixture(t);
  assert.equal(policy.verifyDependencyCopy({ reference: '/usr/lib/libSystem.B.dylib', dependency: null, destination: root }), null);
  assert.equal(policy.verifyDependencyCopy({ reference: '/System/Library/Frameworks/AppKit.framework/AppKit', dependency: null, destination: root }), null);
  for (const reference of ['/usr/lib/../../tmp/host.dylib', '@rpath/missing.dylib', '/opt/homebrew/lib/missing.dylib'])
    rejects(() => policy.verifyDependencyCopy({ reference, dependency: null, destination: root }), 'UNRESOLVED_COPY_DEPENDENCY');
});
test('copy guard compares an existing target before the copy loop can silently skip it', (t) => {
  const root = fixture(t), destination = path.join(root, 'destination'); fs.mkdirSync(destination);
  const dependency = write(root, 'source/libexample.dylib', 'source bytes');
  const target = write(destination, 'libexample.dylib', 'different bytes');
  rejects(() => policy.verifyDependencyCopy({ reference: dependency, dependency, destination }), 'COPY_BASENAME_COLLISION');
  assert.equal(fs.readFileSync(target, 'utf8'), 'different bytes');
  fs.writeFileSync(target, 'source bytes');
  assert.equal(policy.verifyDependencyCopy({ reference: dependency, dependency, destination }), target);
});
test('copy guard accepts a canonical regular source alias but does not follow target links', (t) => {
  const root = fixture(t), destination = path.join(root, 'destination'); fs.mkdirSync(destination);
  const actual = write(root, 'source/libexample.1.dylib', 'source bytes');
  const dependency = path.join(root, 'source/libexample.dylib'); fs.symlinkSync(actual, dependency);
  const target = path.join(destination, 'libexample.dylib');
  assert.equal(policy.verifyDependencyCopy({ reference: dependency, dependency, destination }), target);
  fs.symlinkSync(actual, target);
  rejects(() => policy.verifyDependencyCopy({ reference: dependency, dependency, destination }), 'UNSAFE_NATIVE_FILE');
  assert.equal(fs.lstatSync(target).isSymbolicLink(), true);
});
test('copy guard rejects directory, dangling source, and hardlinked target', (t) => {
  const root = fixture(t), destination = path.join(root, 'destination'); fs.mkdirSync(destination);
  rejects(() => policy.verifyDependencyCopy({ reference: root, dependency: root, destination }), 'UNSAFE_NATIVE_FILE');
  const missing = path.join(root, 'missing.dylib'); fs.symlinkSync(path.join(root, 'absent'), missing);
  rejects(() => policy.verifyDependencyCopy({ reference: missing, dependency: missing, destination }), 'UNRESOLVED_COPY_DEPENDENCY');
  const dependency = write(root, 'source/libexample.dylib', 'source bytes');
  const target = write(destination, 'libexample.dylib', 'source bytes'); fs.linkSync(target, path.join(destination, 'alias'));
  rejects(() => policy.verifyDependencyCopy({ reference: dependency, dependency, destination }), 'UNSAFE_NATIVE_FILE');
});

test('filesystem gate inspects native magic rather than executable bits or extensions', (t) => {
  const root = fixture(t), value = inventory(); value.native.push(entry('postgres/lib/plugin.no-extension'));
  const inspect = stage(root, value), seen = [];
  const result = policy.verifyNativeRuntime({ root, requiredExecutables, requiredModules, postgresShare, minimumSystemVersion: '13.0', inspect: file => { seen.push(path.relative(root, file)); return inspect(file); } });
  assert.equal(result.nativeFiles, 15); assert.deepEqual(seen.sort(), value.native.map(item => item.file).sort());
});
for (const link of ['symlink', 'dangling', 'hardlink', 'directory']) {
  test(`filesystem gate refuses ${link} entries anywhere in the new stage`, (t) => {
    const root = fixture(t), inspect = stage(root), linked = path.join(root, 'linked');
    if (link === 'hardlink') fs.linkSync(path.join(root, 'jre/bin/java'), linked);
    else fs.symlinkSync(link === 'dangling' ? 'absent' : link === 'directory' ? 'jre' : 'jre/bin/java', linked);
    rejects(() => policy.verifyNativeRuntime({ root, requiredExecutables, requiredModules, postgresShare, minimumSystemVersion: '13.0', inspect }), 'UNSAFE_STAGE_ENTRY');
  });
}
test('filesystem gate rejects a root alias', (t) => {
  const parent = fixture(t), root = path.join(parent, 'runtime'); fs.mkdirSync(root); const inspect = stage(root);
  const alias = path.join(parent, 'alias'); fs.symlinkSync(root, alias);
  rejects(() => policy.verifyNativeRuntime({ root: alias, requiredExecutables, requiredModules, postgresShare, minimumSystemVersion: '13.0', inspect }), 'INVALID_STAGE_ROOT');
});
test('inspection failure and mutation of current or already inspected binaries block the gate', (t) => {
  for (const mutation of ['throw', 'current', 'previous']) {
    const parent = fixture(t), root = path.join(parent, 'runtime'); fs.mkdirSync(root); const inspect = stage(root);
    let first;
    const action = () => policy.verifyNativeRuntime({ root, requiredExecutables, requiredModules, postgresShare, minimumSystemVersion: '13.0', inspect(file) {
      if (mutation === 'throw') throw new Error('synthetic inspector failure');
      if (mutation === 'current') fs.appendFileSync(file, 'mutation');
      if (mutation === 'previous' && first) fs.appendFileSync(first, 'mutation');
      first ||= file; return inspect(file);
    } });
    if (mutation === 'throw') assert.throws(action, /synthetic inspector failure/);
    else rejects(action, mutation === 'current' ? 'NATIVE_CHANGED' : 'STAGE_CHANGED');
  }
});
test('inspection callback cannot replace authoritative path or byte hash', (t) => {
  const root = fixture(t), inspect = stage(root);
  assert.equal(policy.verifyNativeRuntime({ root, requiredExecutables, requiredModules, postgresShare, minimumSystemVersion: '13.0', inspect: file => ({ ...inspect(file), file: '../outside', sha256: 'invalid' }) }).nativeFiles, 14);
});
test('release file must exist, be bounded, and contain valid UTF-8', (t) => {
  for (const content of [null, Buffer.alloc(65537, 'x'), Buffer.from([0xff, 0xfe])]) {
    const root = fixture(t), inspect = stage(root), file = path.join(root, 'jre/release');
    if (content === null) fs.unlinkSync(file); else fs.writeFileSync(file, content);
    rejects(() => policy.verifyNativeRuntime({ root, requiredExecutables, requiredModules, postgresShare, minimumSystemVersion: '13.0', inspect }), 'INVALID_JAVA_RELEASE');
  }
});
test('native size bound is checked before hashing or launching inspection tools', (t) => {
  const root = fixture(t); stage(root);
  fs.truncateSync(path.join(root, 'jre/bin/java'), 256 * 1024 * 1024 + 1);
  let inspections = 0;
  rejects(() => policy.verifyNativeRuntime({ root, requiredExecutables, requiredModules, postgresShare, minimumSystemVersion: '13.0', inspect() { inspections++; } }), 'NATIVE_LIMIT');
  assert.equal(inspections, 0);
});
test('production inspector uses only bounded Apple metadata commands with a closed environment', (t) => {
  const root = fixture(t), inspect = stage(root), calls = [];
  const source = fs.readFileSync(path.resolve(__dirname, '../scripts/native-runtime-policy.cjs'), 'utf8');
  const exports = { exports: {} };
  vm.runInNewContext(source, { module: exports, Buffer, require: name => name !== 'node:child_process' ? require(name) : {
    execFileSync(tool, args, options) {
      calls.push({ tool, args, options });
      const observation = inspect(args.at(-1));
      if (tool === '/usr/bin/file') { assert.deepEqual(Array.from(args.slice(0, -1)), ['-b']); return observation.fileDescription; }
      if (tool === '/usr/bin/lipo') { assert.deepEqual(Array.from(args.slice(0, -1)), ['-archs']); return observation.architectures; }
      assert.equal(tool, '/usr/bin/otool'); assert.deepEqual(Array.from(args.slice(0, -1)), ['-arch', 'arm64', '-l']); return observation.loadCommands;
    },
  } });
  assert.equal(exports.exports.verifyNativeRuntime({ root, requiredExecutables, requiredModules, postgresShare, minimumSystemVersion: '13.0' }).nativeFiles, 14);
  assert.equal(calls.length, 42);
  for (const { options } of calls) {
    assert.deepEqual(JSON.parse(JSON.stringify(options.env)), { PATH: '/usr/bin:/bin', LANG: 'C', LC_ALL: 'C' });
    assert.equal(options.timeout, 15000); assert.equal(options.maxBuffer, 1024 * 1024);
    assert.deepEqual(Array.from(options.stdio), ['ignore', 'pipe', 'pipe']);
  }
});
test('production inspection failures do not echo tool stderr into publication errors', (t) => {
  const root = fixture(t); stage(root);
  const source = fs.readFileSync(path.resolve(__dirname, '../scripts/native-runtime-policy.cjs'), 'utf8'), exports = { exports: {} };
  vm.runInNewContext(source, { module: exports, Buffer, require: name => name !== 'node:child_process' ? require(name) : {
    execFileSync() { throw new Error('untrusted-native-tool-sentinel'); },
  } });
  assert.throws(() => exports.exports.verifyNativeRuntime({ root, requiredExecutables, requiredModules, postgresShare, minimumSystemVersion: '13.0' }), error => {
    assert.equal(error.code, 'NATIVE_RUNTIME_POLICY'); assert.equal(error.findings[0].code, 'NATIVE_INSPECTION_FAILED');
    assert.ok(!error.message.includes('untrusted-native-tool-sentinel')); return true;
  });
});

test('failed native gate leaves old runtime unchanged and permits only owned incoming cleanup', (t) => {
  const root = fixture(t), stageDirectory = path.join(root, 'stage'); fs.mkdirSync(stageDirectory);
  const previous = write(stageDirectory, 'runtime/keep', 'old complete runtime');
  const tx = createRuntimeStage(stageDirectory), value = inventory(); value.native[1].loadCommands = commands({ minimum: '26.0' });
  const inspect = stage(tx.staging, value);
  try {
    rejects(() => { policy.verifyNativeRuntime({ root: tx.staging, requiredExecutables, requiredModules, postgresShare, minimumSystemVersion: '13.0', inspect }); tx.publish(); }, 'MINIMUM_OS_EXCEEDED');
    assert.equal(fs.readFileSync(previous, 'utf8'), 'old complete runtime');
    assert.equal(fs.readdirSync(stageDirectory).some(name => name.startsWith('runtime.previous-')), false);
  } finally { tx.close(); }
  assert.equal(fs.existsSync(tx.staging), false); assert.equal(fs.readFileSync(previous, 'utf8'), 'old complete runtime');
});
test('compatible synthetic native closure can pass the existing no-link publisher', (t) => {
  const root = fixture(t), stageDirectory = path.join(root, 'stage'); fs.mkdirSync(stageDirectory);
  const tx = createRuntimeStage(stageDirectory), inspect = stage(tx.staging);
  try {
    policy.verifyNativeRuntime({ root: tx.staging, requiredExecutables, requiredModules, postgresShare, minimumSystemVersion: '13.0', inspect });
    tx.publish(); assert.ok(fs.existsSync(path.join(stageDirectory, 'runtime/jre/bin/java')));
  } finally { tx.close(); }
});

test('actual stage script validates before manifest/publication and retains protocol markers', () => {
  const source = fs.readFileSync(path.resolve(__dirname, '../scripts/stage-runtime.mjs'), 'utf8');
  const gateIndex = source.indexOf('nativePolicy.verifyNativeRuntime(');
  const end = source.indexOf('\nconsole.log(`Staged', gateIndex);
  assert.ok(gateIndex > source.indexOf('stageTransaction.materializePgAliases(pgLib)'));
  assert.ok(end > gateIndex);
  const tail = source.slice(gateIndex, end), events = [];
  function run(fail) {
    events.length = 0;
    return vm.runInNewContext(tail, {
      nativePolicy: { verifyNativeRuntime(value) { events.push('gate'); assert.equal(value.minimumSystemVersion, '13.0'); assert.deepEqual(Array.from(value.requiredExecutables), requiredExecutables); assert.deepEqual(Array.from(value.requiredModules), requiredModules); assert.equal(value.postgresShare, postgresShare); if (fail) throw new Error('native gate rejected'); } },
      fs: { readFileSync() { return JSON.stringify({ build: { mac: { minimumSystemVersion: '13.0' } } }); }, writeFileSync(_file, bytes) {
        events.push('manifest'); const manifest = JSON.parse(bytes); assert.equal(manifest.ownershipProtocol, 1); assert.equal(manifest.backupProtocol, 3);
      } }, path, desktop: '/synthetic/desktop', staging: '/synthetic/staging', buildSequence: '12',
      process: { platform: 'darwin', arch: 'arm64' }, filesUnder: () => [], hash: () => { throw new Error('no files'); },
      guardStageDestination: value => value,
      requiredPgBinaries: PG_TOOLS,
      postgresBin: '/synthetic/staging/postgres/bin', postgresFlatLib: '/synthetic/staging/postgres/lib', postgresPkgLib: '/synthetic/staging/postgres/lib/postgresql', postgresShare: '/synthetic/staging/postgres/share',
      stageTransaction: { publish() { events.push('publish'); return {}; } },
    });
  }
  assert.throws(() => run(true), /native gate rejected/); assert.deepEqual(events, ['gate']);
  run(false); assert.deepEqual(events, ['gate', 'manifest', 'publish']);
});

test('actual dependency-copy loop fails before skipping a conflicting basename', (t) => {
  const root = fixture(t), destination = path.join(root, 'destination'); fs.mkdirSync(destination);
  const executable = write(root, 'bin/postgres', 'synthetic executable');
  const dependency = write(root, 'source/libexample.dylib', 'source bytes');
  write(destination, 'libexample.dylib', 'conflicting bytes');
  const source = fs.readFileSync(path.resolve(__dirname, '../scripts/stage-runtime.mjs'), 'utf8');
  const part = source.slice(source.indexOf('function copyDynamicLibraries('), source.indexOf('\nfunction filesUnder('));
  let copies = 0;
  const guardFactory = source.match(/function createStageDestinationGuard\(incoming\) \{[\s\S]*?\n\}/)?.[0]; assert.ok(guardFactory);
  const guardStageDestination = vm.runInNewContext(`(${guardFactory})`, { fs, path })(root);
  const copyDynamicLibraries = vm.runInNewContext(`${part}\ncopyDynamicLibraries`, {
    fs, path, process: { platform: 'darwin' }, nativePolicy: policy, guardStageDestination,
    output: () => commands({ deps: [dependency] }),
    resolveMachODependency: value => value, copy: () => { copies++; },
  });
  rejects(() => copyDynamicLibraries([executable], destination), 'COPY_BASENAME_COLLISION'); assert.equal(copies, 0);
});
