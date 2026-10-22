'use strict';
// Host-independent policy and synthetic filesystem fixtures; no Linux binary runs.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const test = require('node:test');
const { parseElfHeader, parseElfMetadata, validateClosure, inventory, requireLinuxHost, digest } = require('../scripts/linux-runtime-policy.cjs');
const { EXTRACT_TAR } = require('../scripts/provision-linux-runtime.cjs');
const { makeReadable, stageLinuxRuntime } = require('../scripts/stage-linux-runtime.cjs');
const { validateRuntimeManifest } = require('../src/runtime-manifest.cjs');
function temp(t) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ci-linux-policy-')));
  t.after(() => fs.rmSync(root, { recursive: true, force: true })); return root;
}
function elfHeader(machine = 62) {
  const bytes = Buffer.alloc(64); Buffer.from('7f454c46', 'hex').copy(bytes);
  bytes[4] = 2; bytes[5] = 1; bytes[6] = 1; bytes.writeUInt16LE(3, 16); bytes.writeUInt16LE(machine, 18); return bytes;
}
const elf = (needed = [], rpaths = ['$ORIGIN'], glibc = ['2.17']) => ({ elf: { needed, rpaths, glibc } });
test('native staging refuses another host or architecture before preparing files', async () => {
  for (const [platform, arch] of [['darwin', 'arm64'], ['win32', 'x64'], ['linux', 'arm64']])
    assert.throws(() => requireLinuxHost(platform, arch), { code: 'LINUX_X64_NATIVE_HOST_REQUIRED' });
  requireLinuxHost('linux', 'x64');
  if (process.platform !== 'linux' || process.arch !== 'x64') await assert.rejects(stageLinuxRuntime(), { code: 'LINUX_X64_NATIVE_HOST_REQUIRED' });
});
test('ELF inventory refuses foreign CPU and unsupported native byte formats', t => {
  assert.equal(parseElfHeader(Buffer.from('text')), null);
  assert.deepEqual(parseElfHeader(elfHeader()), { type: 3, machine: 62 });
  assert.throws(() => parseElfHeader(elfHeader(183)), { code: 'ELF_X64_REQUIRED' });
  const bigEndian = elfHeader(); bigEndian[5] = 2;
  assert.throws(() => parseElfHeader(bigEndian), { code: 'ELF64_LITTLE_ENDIAN_REQUIRED' });
  const root = temp(t); fs.writeFileSync(path.join(root, 'addon.node'), 'not ELF');
  assert.throws(() => inventory(root, () => ({})), { code: 'LINUX_FOREIGN_NATIVE_FORMAT' });
});
test('static readelf parsing limits loader, dependency names and glibc contracts', () => {
  const parsed = parseElfMetadata(' (NEEDED) Shared library: [libssl.so.3]\n (RUNPATH) Library runpath: [$ORIGIN:$ORIGIN/../../lib]',
    ' Name: GLIBC_2.35\n Name: GLIBC_2.2.5', '[Requesting program interpreter: /lib64/ld-linux-x86-64.so.2]');
  assert.deepEqual(parsed.needed, ['libssl.so.3']); assert.deepEqual(parsed.glibc, ['2.35', '2.2.5']);
  assert.throws(() => parseElfMetadata('(NEEDED) Shared library: [/tmp/lib.so]', ''), { code: 'ELF_UNSAFE_DEPENDENCY' });
  assert.throws(() => parseElfMetadata('', '', '[Requesting program interpreter: /tmp/loader]'), { code: 'ELF_INTERPRETER_REJECTED' });
  assert.throws(() => parseElfMetadata('', 'Name: GLIBC_PRIVATE'), { code: 'ELF_PRIVATE_GLIBC_REJECTED' });
});
test('ELF closure permits only bundled relative dependencies and the explicit glibc baseline', () => {
  const entries = new Map([['postgres/bin/postgres', elf(['libssl.so.3', 'libc.so.6'], ['$ORIGIN/../../lib'])],
    ['lib/libssl.so.3', elf(['libcrypto.so.3'])], ['lib/libcrypto.so.3', elf(['libc.so.6'])]]);
  assert.equal(validateClosure(entries), entries);
  entries.delete('lib/libcrypto.so.3');
  assert.throws(() => validateClosure(entries), { code: 'ELF_DEPENDENCY_NOT_BUNDLED' });
  for (const rpath of ['/usr/lib', '', '.', '$ORIGIN/../../../escape', '$LIB', '${ORIGIN}'])
    assert.throws(() => validateClosure(new Map([['postgres/bin/postgres', elf([], [rpath])]])), /ELF_.*(?:PATH|ESCAPE)/);
  assert.throws(() => validateClosure(new Map([['lib/example.so', elf([], ['$ORIGIN'], ['2.36'])]])), { code: 'LINUX_GLIBC_2_35_BASELINE_EXCEEDED' });
  assert.throws(() => validateClosure(new Map([['lib/libc.so.6', elf()]])), { code: 'ELF_SYSTEM_LIBRARY_SHADOWING' });
});
test('distribution permissions are normalized but links and extra write access are refused', { skip: process.platform === 'win32' }, t => {
  const root = temp(t), file = path.join(root, 'data'), executable = path.join(root, 'java');
  fs.writeFileSync(file, 'data', { mode: 0o600 }); fs.writeFileSync(executable, 'executable', { mode: 0o700 });
  makeReadable(root); assert.equal(fs.statSync(root).mode & 0o777, 0o755);
  assert.equal(fs.statSync(file).mode & 0o777, 0o644); assert.equal(fs.statSync(executable).mode & 0o777, 0o755);
  fs.chmodSync(file, 0o666); assert.throws(() => inventory(root), { code: 'LINUX_RUNTIME_FILE_UNSAFE' });
  fs.chmodSync(file, 0o644); fs.symlinkSync('data', path.join(root, 'alias'));
  assert.throws(() => makeReadable(root), /Unsafe/); assert.throws(() => inventory(root), { code: 'LINUX_RUNTIME_FILE_UNSAFE' });
});
test('Linux launch manifest requires the dedicated control runtime and closed inventory', async t => {
  const root = temp(t), names = ['jre/bin/java', 'redis/bin/redis-server', 'linux-provenance.json', 'backend/code-intelligence.jar',
    'backend/code-intelligence-control.jar', 'backend/code-intelligence-control-provenance.json',
    'postgres/bin/postgres', 'postgres/lib/vector.so', 'postgres/lib/pg_trgm.so'];
  const files = {};
  for (const name of names) {
    fs.mkdirSync(path.dirname(path.join(root, name)), { recursive: true }); fs.writeFileSync(path.join(root, name), name); files[name] = digest(name);
  }
  const manifest = { format: 1, platform: 'linux', arch: 'x64', buildSequence: '1', minimumGlibc: '2.35',
    backupProtocol: 3, ownershipProtocol: 1, controlProtocol: 1, files,
    runtime: { postgresBin: 'postgres/bin', postgresLib: 'postgres/lib', postgresPkgLib: 'postgres/lib', postgresShare: 'postgres/share' } };
  await validateRuntimeManifest(root, manifest, { platform: 'linux', arch: 'x64' });
  await assert.rejects(validateRuntimeManifest(root, { ...manifest, controlProtocol: undefined }, { platform: 'linux', arch: 'x64' }), { code: 'RUNTIME_MANIFEST_PROTOCOL' });
  fs.writeFileSync(path.join(root, 'unexpected'), 'extra');
  await assert.rejects(validateRuntimeManifest(root, manifest, { platform: 'linux', arch: 'x64' }), { code: 'RUNTIME_INVENTORY_UNEXPECTED' });
});
test('source archive extraction materializes internal licenses and rejects traversal/link escapes', { skip: process.platform === 'win32' }, t => {
  const root = temp(t);
  const cases = [['good', 'prefix/legal/COPYING', 'regular', ''], ['traversal', 'prefix/../escape', 'regular', ''],
    ['external-link', 'prefix/legal/COPYING', 'link', '../../../escape'], ['device', 'prefix/device', 'device', '']];
  for (const [name, member, kind, link] of cases) {
    const archive = path.join(root, name + '.tar'), destination = path.join(root, name); fs.mkdirSync(destination);
    const create = spawnSync('python3', ['-c', String.raw`import tarfile,io,sys
archive,member,kind,link=sys.argv[1:]
with tarfile.open(archive,'w') as out:
 info=tarfile.TarInfo(member); info.mode=0o644
 if kind=='regular': info.size=4; out.addfile(info,io.BytesIO(b'test'))
 elif kind=='link': info.type=tarfile.SYMTYPE; info.linkname=link; out.addfile(info)
 else: info.type=tarfile.CHRTYPE; out.addfile(info)
 if kind=='regular' and '..' not in member:
  alias=tarfile.TarInfo('prefix/legal/LICENSE'); alias.type=tarfile.SYMTYPE; alias.linkname='COPYING'; out.addfile(alias)
`, archive, member, kind, link], { encoding: 'utf8' });
    assert.equal(create.status, 0, create.stderr);
    const result = spawnSync('python3', ['-c', EXTRACT_TAR, archive, destination, 'prefix'], { encoding: 'utf8' });
    if (name === 'good') {
      assert.equal(result.status, 0, result.stderr);
      assert.equal(fs.readFileSync(path.join(destination, 'legal/LICENSE'), 'utf8'), 'test');
      assert.equal(fs.lstatSync(path.join(destination, 'legal/LICENSE')).isSymbolicLink(), false);
    } else assert.notEqual(result.status, 0);
    assert.equal(fs.existsSync(path.join(root, 'escape')), false);
  }
});
