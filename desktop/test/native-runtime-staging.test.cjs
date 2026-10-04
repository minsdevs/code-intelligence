'use strict';

const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');
const policy = require('../scripts/native-runtime-policy.cjs');
const { relocateMacLibraries } = require('../scripts/native-acceptance.cjs');

const nativeMac = process.platform === 'darwin' && process.arch === 'arm64';

// Real clang-built Mach-O files, Apple load-command inspection and ad-hoc signing.
// All writes and execution are confined to this test's private temporary directory.
test('product staging follows relocated load edges, not original dylib install IDs', { skip: !nativeMac }, () => {
  const scratch = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ci-native-staging-')));
  try {
    const prefix = path.join(scratch, 'prefix');
    fs.mkdirSync(prefix, { mode: 0o700 });
    for (const directory of ['openssl/lib', 'postgres/bin', 'redis/bin'])
      fs.mkdirSync(path.join(prefix, directory), { recursive: true });
    const run = (command, args) => execFileSync(command, args, {
      cwd: scratch, encoding: 'utf8', timeout: 30000, stdio: ['ignore', 'pipe', 'pipe'],
      env: { PATH: '/usr/bin:/bin', LANG: 'C', LC_ALL: 'C' },
    }).trim();
    const compile = (name, text, args) => {
      const source = path.join(scratch, name + '.c'); fs.writeFileSync(source, text);
      run('/usr/bin/xcrun', ['clang', '-arch', 'arm64', '-mmacosx-version-min=13.0',
        '-Wl,-headerpad_max_install_names', source, ...args]);
    };
    const crypto = path.join(prefix, 'openssl/lib/libcrypto.3.dylib');
    const ssl = path.join(prefix, 'openssl/lib/libssl.3.dylib');
    compile('crypto', 'int crypto_value(void) { return 41; }\n', ['-dynamiclib', '-Wl,-install_name,' + crypto, '-o', crypto]);
    compile('ssl', 'extern int crypto_value(void); int ssl_value(void) { return crypto_value() + 1; }\n',
      ['-dynamiclib', '-Wl,-install_name,' + ssl, crypto, '-o', ssl]);
    const executable = path.join(prefix, 'postgres/bin/postgres');
    compile('postgres', '#include <stdio.h>\nextern int ssl_value(void); int main(void) { printf("%d\\n", ssl_value()); return 0; }\n',
      [ssl, '-o', executable]);
    fs.copyFileSync(executable, path.join(prefix, 'redis/bin/redis-server'));
    const closure = relocateMacLibraries(prefix);
    assert.deepEqual(closure.map(item => item.nativeFiles), [3, 3]);
    const relocated = path.join(prefix, 'postgres/lib/libssl.3.dylib');
    assert.notDeepEqual(fs.readFileSync(relocated), fs.readFileSync(ssl));
    assert.ok(run('/usr/bin/otool', ['-D', relocated]).includes(ssl), 'original absolute LC_ID_DYLIB remains');
    assert.ok(policy.parseLoadCommands(run('/usr/bin/otool', ['-l', relocated])).dependencies.includes('@loader_path/libcrypto.3.dylib'));

    const staging = path.join(scratch, 'stage with spaces'); fs.mkdirSync(staging);
    const source = fs.readFileSync(path.resolve(__dirname, '../scripts/stage-runtime.mjs'), 'utf8');
    const begin = source.indexOf('function createStageDestinationGuard(');
    const end = source.indexOf('\nfunction filesUnder(');
    assert.ok(begin >= 0 && end > begin);
    const product = vm.runInNewContext(`${source.slice(begin, end)}\nconst guardStageDestination = createStageDestinationGuard(staging);\n({ copy, copyDynamicLibraries, guardStageDestination });`, {
      fs, path, process, nativePolicy: policy, staging, output: run,
    });
    const destination = path.join(staging, 'postgres/lib');
    product.copy(path.join(prefix, 'postgres/lib'), destination);
    product.copy(executable, path.join(staging, 'postgres/bin/postgres'));
    product.copyDynamicLibraries([executable], destination);
    // Traversing the staged tree also covers spaces without tokenizing install names.
    product.copyDynamicLibraries([path.join(staging, 'postgres/bin/postgres')], destination);
    assert.deepEqual(fs.readFileSync(path.join(destination, 'libssl.3.dylib')), fs.readFileSync(relocated));
    for (const file of [path.join(staging, 'postgres/bin/postgres'), ...fs.readdirSync(destination).map(name => path.join(destination, name))]) {
      const metadata = policy.parseLoadCommands(run('/usr/bin/otool', ['-l', file]));
      assert.equal(metadata.minimum, '13.0');
      assert.deepEqual(metadata.rpaths, []);
      for (const reference of metadata.dependencies) {
        if (reference.startsWith('/usr/lib/')) continue;
        assert.ok(reference.startsWith('@loader_path/'), reference);
        const dependency = fs.realpathSync(path.resolve(path.dirname(file), reference.slice('@loader_path/'.length)));
        assert.ok(dependency.startsWith(staging + path.sep), dependency);
      }
    }
    // Hide every source library: the staged executable must still load its closure.
    const hidden = path.join(scratch, 'hidden-prefix'); fs.renameSync(prefix, hidden);
    try { assert.equal(run(path.join(staging, 'postgres/bin/postgres'), []), '42'); }
    finally { fs.renameSync(hidden, prefix); }

    // A real load edge to the original external library remains a conflict, not an ID exemption.
    const external = path.join(scratch, 'external-client');
    compile('external-client', 'extern int ssl_value(void); int main(void) { return ssl_value(); }\n', [ssl, '-o', external]);
    assert.throws(() => product.copyDynamicLibraries([external], destination), error =>
      error instanceof policy.NativeRuntimePolicyError && error.findings.some(item => item.code === 'COPY_BASENAME_COLLISION'));
    assert.deepEqual(fs.readFileSync(path.join(destination, 'libssl.3.dylib')), fs.readFileSync(relocated));

    // Missing non-system load edges must still fail closed, even with an existing basename.
    fs.renameSync(ssl, ssl + '.hidden');
    assert.throws(() => product.copyDynamicLibraries([external], destination), error =>
      error instanceof policy.NativeRuntimePolicyError && error.findings.some(item => item.code === 'UNRESOLVED_COPY_DEPENDENCY'));
    run('/usr/bin/install_name_tool', ['-add_rpath', '@loader_path', '-add_rpath', '@loader_path/absent',
      path.join(destination, 'libssl.3.dylib')]);
    const diagnosticStart = source.indexOf('function emitNativeStageClosure(');
    const diagnosticEnd = source.indexOf('\nfunction hash(', diagnosticStart);
    const diagnosticGuard = product.guardStageDestination;
    const records = [];
    const emit = vm.runInNewContext(source.slice(diagnosticStart, diagnosticEnd) + '\nemitNativeStageClosure', {
      fs, path, Buffer, nativePolicy: policy, output: run,
      guardStageDestination: diagnosticGuard,
      process: { stderr: { write: line => records.push(line) } },
    });
    const failure = { code: 'UNRESOLVED_NATIVE_REFERENCE', file: 'postgres/lib/libssl.3.dylib', detail: '@loader_path/libcrypto.3.dylib' };
    emit(new policy.NativeRuntimePolicyError([
      { ...failure, file: '../private.dylib' }, { ...failure, detail: '/private/secret.dylib' },
      { ...failure, detail: '@rpath/not-in-load-commands.dylib' },
      { ...failure, file: 'postgres/lib/missing.dylib' }, failure,
    ]), staging);
    assert.equal(records.length, 1);
    assert.deepEqual(JSON.parse(records[0].slice('NATIVE_STAGE_CLOSURE '.length)), {
      file: failure.file, reference: failure.detail, rpaths: [{ kind: 'loader', directory: 'postgres/lib' }],
    });
    assert.equal(records[0].includes(scratch), false);
    fs.symlinkSync(destination, path.join(staging, 'postgres/linked'));
    emit(new policy.NativeRuntimePolicyError([{ ...failure, file: 'postgres/linked/libssl.3.dylib' }]), staging);
    assert.equal(records.length, 1, 'no evidence from a linked ancestor');
    records.length = 0;
    emit(new policy.NativeRuntimePolicyError(Array(20).fill(failure)), staging);
    assert.equal(records.length, 12, 'evidence is bounded before transaction cleanup');
  } finally { fs.rmSync(scratch, { recursive: true, force: true }); }
});
