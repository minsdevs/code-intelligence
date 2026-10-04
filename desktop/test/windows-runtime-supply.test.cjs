'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { parsePe, validateClosure, inventory, systemDll, verifyWindowsRuntime, REQUIRED } = require('../scripts/windows-pe-policy.cjs');
const { zipEntries, extractZip, crc32 } = require('../scripts/windows-runtime-archive.cjs');
const { validateRuntimeManifest } = require('../src/runtime-manifest.cjs');
const { runWindowsProduct } = require('../scripts/native-acceptance-windows-product.cjs');
const supplies = require('../scripts/windows-runtime-supply.json');
function temporary(t) {
  const root = fs.mkdtempSync(path.join(fs.realpathSync(path.resolve(__dirname, '..', '..')), '.windows-runtime-test-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true })); return root;
}
function put(root, file, bytes) { const target = path.join(root, file); fs.mkdirSync(path.dirname(target), { recursive: true }); fs.writeFileSync(target, bytes); return target; }
const hash = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
function image({ imports = ['KERNEL32.dll'], delayed = [], machine = 0x8664, dll = false } = {}) {
  const bytes = Buffer.alloc(0xa00); bytes.writeUInt16LE(0x5a4d); bytes.writeUInt32LE(0x80, 0x3c); bytes.writeUInt32LE(0x4550, 0x80);
  bytes.writeUInt16LE(machine, 0x84); bytes.writeUInt16LE(1, 0x86); bytes.writeUInt16LE(240, 0x94); bytes.writeUInt16LE(dll ? 0x2002 : 2, 0x96);
  bytes.writeUInt16LE(0x20b, 0x98); bytes.writeBigUInt64LE(0x140000000n, 0xb0); bytes.writeUInt32LE(0x200, 0xd4); bytes.writeUInt32LE(16, 0x104);
  bytes.write('.rdata', 0x188); bytes.writeUInt32LE(0x800, 0x190); bytes.writeUInt32LE(0x1000, 0x194); bytes.writeUInt32LE(0x800, 0x198); bytes.writeUInt32LE(0x200, 0x19c);
  let string = 0x500;
  for (const [index, stride, at, names] of [[1, 20, 0x200, imports], [13, 32, 0x300, delayed]]) {
    if (!names.length) continue;
    bytes.writeUInt32LE(at + 0xe00, 0x108 + index * 8); bytes.writeUInt32LE((names.length + 1) * stride, 0x10c + index * 8);
    names.forEach((name, i) => { if (index === 13) bytes.writeUInt32LE(1, at + i * stride); bytes.writeUInt32LE(string + 0xe00, at + i * stride + (index === 1 ? 12 : 4)); bytes.write(name + '\0', string); string += name.length + 1; });
  }
  return bytes;
}
function item(bytes) { return { hash: hash(bytes), pe: parsePe(bytes) }; }
function zip(name, content = Buffer.from('bytes')) {
  const encoded = Buffer.from(name), local = Buffer.alloc(30), central = Buffer.alloc(46), end = Buffer.alloc(22);
  local.writeUInt32LE(0x04034b50); local.writeUInt16LE(20, 4); local.writeUInt32LE(crc32(content), 14); local.writeUInt32LE(content.length, 18); local.writeUInt32LE(content.length, 22); local.writeUInt16LE(encoded.length, 26);
  central.writeUInt32LE(0x02014b50); central.writeUInt16LE(20, 6); central.writeUInt32LE(crc32(content), 16); central.writeUInt32LE(content.length, 20); central.writeUInt32LE(content.length, 24); central.writeUInt16LE(encoded.length, 28);
  const start = local.length + encoded.length + content.length;
  end.writeUInt32LE(0x06054b50); end.writeUInt16LE(1, 8); end.writeUInt16LE(1, 10); end.writeUInt32LE(central.length + encoded.length, 12); end.writeUInt32LE(start, 16);
  return Buffer.concat([local, encoded, content, central, encoded, end]);
}
test('x64 PE parses both eager and delayed DLL imports', () => {
  const parsed = parsePe(image({ imports: ['KERNEL32.dll', 'libpq.dll'], delayed: ['VCRUNTIME140.dll'] }));
  assert.equal(parsed.machine, 0x8664); assert.equal(parsed.dll, false);
  assert.deepEqual(parsed.imports, ['kernel32.dll', 'libpq.dll']); assert.deepEqual(parsed.delayImports, ['vcruntime140.dll']);
});
for (const machine of [0x14c, 0xaa64, 0xa641]) test('reject wrong native architecture ' + machine, () => assert.throws(() => parsePe(image({ machine })), /ARCHITECTURE/));
test('PE rejects truncated headers, out-of-range RVAs and unterminated descriptors', () => {
  assert.throws(() => parsePe(image().subarray(0, 160)), /INVALID_PE/);
  const rva = image(); rva.writeUInt32LE(0xfffffff0, 0x110); assert.throws(() => parsePe(rva), /INVALID_PE/);
  const noEnd = image(); noEnd.writeUInt32LE(20, 0x114); assert.throws(() => parsePe(noEnd), /INVALID_PE/);
});
test('delay import VA must be representable against the actual image base', () => {
  const bytes = image({ delayed: ['example.dll'] }); bytes.writeUInt32LE(0, 0x300); assert.throws(() => parsePe(bytes), /INVALID_PE/);
});
test('DLL names cannot introduce paths, ADS or reserved devices', () => {
  for (const name of ['../evil.dll', 'C:evil.dll', 'CON.dll', 'dir\\evil.dll']) assert.throws(() => parsePe(image({ imports: [name] })));
});
test('API-set whitelist rejects fabricated contracts and VC redistributables are not system DLLs', () => {
  assert.equal(systemDll('api-ms-win-core-synch-l1-2-0.dll'), true);
  assert.equal(systemDll('api-ms-win-core-madeup-l1-1-0.dll'), false);
  assert.equal(systemDll('vcruntime140.dll'), false);
});
test('closure resolves app-local transitive and delayed imports without the host PATH', () => {
  const files = new Map([
    ['postgres/bin/postgres.exe', item(image({ delayed: ['a.dll'] }))],
    ['postgres/bin/a.dll', item(image({ imports: ['b.dll'], dll: true }))],
    ['postgres/lib/b.dll', item(image({ dll: true }))]
  ]);
  assert.ok(validateClosure(files).some(edge => edge.target === 'postgres/lib/b.dll'));
  files.delete('postgres/lib/b.dll'); assert.throws(() => validateClosure(files), /UNRESOLVED_NATIVE_REFERENCE/);
});
test('closure cannot borrow dependencies from unrelated runtimes and rejects conflicting basenames', () => {
  const files = new Map([['cache/GarnetServer.exe', item(image({ imports: ['a.dll'] }))], ['postgres/bin/a.dll', item(image({ dll: true }))]]);
  assert.throws(() => validateClosure(files), /UNRESOLVED/);
  files.set('cache/a.dll', item(image({ dll: true }))); assert.doesNotThrow(() => validateClosure(files));
  files.set('postgres/bin/postgres.exe', item(image({ imports: ['a.dll'] })));
  files.set('postgres/lib/a.dll', item(image({ imports: ['user32.dll'], dll: true })));
  assert.throws(() => validateClosure(files), /BASENAME_COLLISION/);
});
test('system DLL shadowing is refused rather than declared trusted', () => {
  const files = new Map([['cache/GarnetServer.exe', item(image())], ['cache/kernel32.dll', item(image({ dll: true }))]]);
  assert.throws(() => validateClosure(files), /SYSTEM_DLL_SHADOW/);
});
test('inventory rejects fake or foreign native payloads and hardlinks', t => {
  const root = temporary(t); put(root, 'fake.dll', 'not PE'); assert.throws(() => inventory(root), /INVALID_PE/); fs.unlinkSync(path.join(root, 'fake.dll'));
  put(root, 'foreign', Buffer.from('7f454c46', 'hex')); assert.throws(() => inventory(root), /INVALID_PE/); fs.unlinkSync(path.join(root, 'foreign'));
  put(root, 'ordinary', 'safe'); fs.linkSync(path.join(root, 'ordinary'), path.join(root, 'alias')); assert.throws(() => inventory(root), /UNSAFE_STAGE_ENTRY/);
});
test('ZIP extraction checks CRC and cannot write outside a fresh destination', t => {
  const root = temporary(t), bytes = zip('a/file.txt'); assert.equal(zipEntries(bytes)[0].read().toString(), 'bytes');
  extractZip(bytes, path.join(root, 'out')); assert.equal(fs.readFileSync(path.join(root, 'out', 'a', 'file.txt'), 'utf8'), 'bytes');
  assert.throws(() => extractZip(bytes, path.join(root, 'out')), /fresh/);
  bytes[30 + Buffer.byteLength('a/file.txt')] ^= 1; assert.throws(() => zipEntries(bytes)[0].read(), /Invalid/);
  for (const name of ['../escape', 'C:/escape', 'a/file:stream', 'CON', 'a\\b']) assert.throws(() => zipEntries(zip(name)), /unsafe/);
});
test('PE provenance, required native modules and extension SQL are mandatory', t => {
  const root = temporary(t); for (const file of REQUIRED) put(root, file, image({ dll: file.endsWith('.dll') }));
  assert.throws(() => verifyWindowsRuntime({ root, supplies }), /PROVENANCE_MISSING/);
  const sources = {}, files = {};
  for (const [name, notice] of Object.entries(require('../scripts/windows-runtime-notices.json'))) put(root, `notices/dependencies/${name}.txt`, notice.text);
  for (const [name, supply] of Object.entries(supplies)) { sources[name] = { ...supply, notice: 'notices/' + name }; put(root, sources[name].notice, 'fixture notice'); }
  for (const [name, value] of inventory(root)) if (value.pe) files[name] = { sha256: value.hash, sources: ['jdk'], method: 'fixture' };
  put(root, 'jre/release', 'JAVA_VERSION="21.0.8"\n');
  put(root, 'cache/GarnetServer.runtimeconfig.json', JSON.stringify({ runtimeOptions: { tfm: 'net10.0', rollForward: 'Disable', includedFrameworks: [{ name: 'Microsoft.NETCore.App', version: '10.0.12' }] } }));
  const provenance = { format: 1, sources, files };
  assert.throws(() => verifyWindowsRuntime({ root, provenance, supplies }), /REQUIRED_EXTENSION_CONTROL/);
  for (const name of ['vector', 'pg_trgm']) { put(root, `postgres/share/extension/${name}.control`, `default_version = '1.0'\nmodule_pathname = '$libdir/${name}'`); put(root, `postgres/share/extension/${name}--1.0.sql`, 'select 1;'); }
  assert.ok(verifyWindowsRuntime({ root, provenance, supplies }).native > 0);
  const configuration = path.join(root, 'cache/GarnetServer.runtimeconfig.json'), original = fs.readFileSync(configuration);
  put(root, 'cache/GarnetServer.runtimeconfig.json', JSON.stringify({ runtimeOptions: { tfm: 'net10.0', framework: { name: 'Microsoft.NETCore.App', version: '10.0.12' } } }));
  assert.throws(() => verifyWindowsRuntime({ root, provenance, supplies }), /CACHE_SELF_CONTAINED_REQUIRED/);
  fs.writeFileSync(configuration, original);
  provenance.sources.jdk.sha256 = '0'.repeat(64); assert.throws(() => verifyWindowsRuntime({ root, provenance, supplies }), /UNPINNED_SUPPLY/);
});
test('runtime manifest checks exact bytes and inventory, not only listed paths', async t => {
  const root = temporary(t), manifest = { format: 1, buildSequence: '1', platform: 'darwin', arch: 'arm64', runtime: { postgresBin: 'postgres/bin', postgresLib: 'postgres/lib', postgresPkgLib: 'postgres/lib', postgresShare: 'postgres/share' }, files: { 'sample.txt': hash('sample') } };
  put(root, 'sample.txt', 'sample'); put(root, 'runtime-manifest.json', JSON.stringify(manifest));
  await validateRuntimeManifest(root, manifest, { platform: 'darwin', arch: 'arm64' });
  put(root, 'extra.txt', 'extra'); await assert.rejects(validateRuntimeManifest(root, manifest, { platform: 'darwin', arch: 'arm64' }), /invalid/);
  fs.unlinkSync(path.join(root, 'extra.txt')); put(root, 'sample.txt', 'changed'); await assert.rejects(validateRuntimeManifest(root, manifest, { platform: 'darwin', arch: 'arm64' }), /invalid/);
});
test('runtime manifest rejects Windows case collisions before any helper executes', async t => {
  const root = temporary(t), manifest = { format: 1, buildSequence: '1', platform: 'win32', arch: 'x64', backupProtocol: 3, ownershipProtocol: 1,
    runtime: { cache: 'garnet-2.2.0' }, files: { 'a.dll': 'a'.repeat(64), 'A.dll': 'a'.repeat(64) } };
  await assert.rejects(validateRuntimeManifest(root, manifest, { platform: 'win32', arch: 'x64' }), /invalid/);
});
test('Windows product runner cannot be used to launch local Electron', async () => {
  await assert.rejects(runWindowsProduct({ env: { GITHUB_ACTIONS: 'false' } }), /Hosted workflow required/);
});
