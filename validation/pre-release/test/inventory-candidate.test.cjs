'use strict';

// Pure, authored byte fixtures. No app launch, filesystem extraction, subprocess,
// provider, profile, database or native runtime is used by these tests.
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const zlib = require('node:zlib');
const { Pickle } = require('../../../desktop/node_modules/@electron/asar/lib/pickle.js');
const Open = require('../../../desktop/node_modules/unzipper/lib/Open/index.js');
const inventory = require('../inventory-candidate.cjs');
const { LIMITS, argumentsFor, candidateRelative, relativeName, packageManifest, packageRecord,
  parseAsar, preflightZip, zipEntryBytes, openZip, crc32, budget, javaMetadata, metadataRecord,
  nativeLock, jarInventory, main } = inventory;
const bytes = value => Buffer.from(typeof value === 'string' ? value : JSON.stringify(value));
const hash = value => crypto.createHash('sha256').update(value).digest('hex');

function asar(header, payload = Buffer.alloc(0)) {
  const body = Pickle.createEmpty(); body.writeString(typeof header === 'string' ? header : JSON.stringify(header));
  const head = body.toBuffer(), size = Pickle.createEmpty(); size.writeUInt32(head.length);
  return Buffer.concat([size.toBuffer(), head, payload]);
}
// Independent bitwise CRC used only to author the synthetic ZIPs. A published
// CRC check vector below also checks the production table implementation.
function fixtureCrc(data) {
  let value = 0xffffffff;
  for (const byte of data) {
    value ^= byte;
    for (let bit = 0; bit < 8; bit++) value = (value >>> 1) ^ ((value & 1) ? 0xedb88320 : 0);
  }
  return (value ^ 0xffffffff) >>> 0;
}
function zip(items, comment = Buffer.alloc(0)) {
  const localParts = [], centralParts = []; let offset = 0;
  for (const item of items) {
    const data = Buffer.isBuffer(item.data) ? item.data : bytes(item.data ?? '');
    const method = item.method ?? 0, compressed = method === 8 ? zlib.deflateRawSync(data) : data;
    const name = bytes(item.name), localName = bytes(item.localName ?? item.name), extra = item.extra ?? Buffer.alloc(0);
    const flags = item.flags ?? 0x800, size = item.size ?? data.length, crc = fixtureCrc(data);
    const local = Buffer.alloc(30), central = Buffer.alloc(46);
    local.writeUInt32LE(0x04034b50); local.writeUInt16LE(20, 4); local.writeUInt16LE(flags, 6); local.writeUInt16LE(method, 8);
    if (!(flags & 8)) { local.writeUInt32LE(crc, 14); local.writeUInt32LE(compressed.length, 18); local.writeUInt32LE(size, 22); }
    local.writeUInt16LE(localName.length, 26); local.writeUInt16LE(extra.length, 28);
    const descriptor = Buffer.alloc(flags & 8 ? 16 : 0);
    if (descriptor.length) {
      descriptor.writeUInt32LE(0x08074b50); descriptor.writeUInt32LE(crc, 4);
      descriptor.writeUInt32LE(compressed.length, 8); descriptor.writeUInt32LE(size, 12);
    }
    central.writeUInt32LE(0x02014b50); central.writeUInt16LE(0x314, 4); central.writeUInt16LE(20, 6);
    central.writeUInt16LE(flags, 8); central.writeUInt16LE(method, 10); central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(compressed.length, 20); central.writeUInt32LE(size, 24);
    central.writeUInt16LE(name.length, 28); central.writeUInt16LE(extra.length, 30);
    central.writeUInt32LE(item.attributes ?? 0, 38); central.writeUInt32LE(offset, 42);
    localParts.push(local, localName, extra, compressed, descriptor); centralParts.push(central, name, extra);
    offset += local.length + localName.length + extra.length + compressed.length + descriptor.length;
  }
  const central = Buffer.concat(centralParts), end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50); end.writeUInt16LE(items.length, 8); end.writeUInt16LE(items.length, 10);
  end.writeUInt32LE(central.length, 12); end.writeUInt32LE(offset, 16); end.writeUInt16LE(comment.length, 20);
  return Buffer.concat([...localParts, central, end, comment]);
}

test('explicit offline flags and a basename output are mandatory; invalid CLI fails before filesystem access', async () => {
  const app = '/repo/.native-product-Ab12/Code Intelligence Validation.app';
  assert.deepEqual(argumentsFor(['--offline', '--app', app, '--output', 'candidate-1.json']), { offline: true, app, output: 'candidate-1.json' });
  for (const argv of [[], ['--app', app, '--output', 'candidate.json'], ['--offline'],
    ['--offline', '--offline', '--app', app, '--output', 'candidate.json'],
    ['--offline', '--app', app, '--app', app, '--output', 'candidate.json'],
    ['--offline', '--app', app, '--output', '../existing.json'],
    ['--offline', '--app', app, '--output', '/tmp/existing.json'],
    ['--offline', '--app', app, '--output', 'candidate.json\n'],
    ['--offline', '--app', app, '--output', 'candidate.json', '--overwrite'],
    ['--offline', '--app', '', '--output', 'candidate.json'],
    ['--offline', '--app', 'relative.app', '--output', 'candidate.json'],
    ['--offline', '--app', app, '--output', 'github_pat_secret.json']]) {
    assert.throws(() => argumentsFor(argv), { code: 'ARGUMENTS' });
    await assert.rejects(main(argv), { code: 'ARGUMENTS' });
  }
});

test('candidate must be a direct original-checkout native-product child with the exact app name', () => {
  assert.equal(candidateRelative('/repo', '/repo/.native-product-Ab12/Code Intelligence Validation.app'), '.native-product-Ab12/Code Intelligence Validation.app');
  for (const app of ['/other/.native-product-Ab12/Code Intelligence Validation.app',
    '/repo/other/.native-product-Ab12/Code Intelligence Validation.app',
    '/repo/.native-product-Ab12/../.native-product-Ab12/Code Intelligence Validation.app',
    '/repo/.native-product-Ab12/Code Intelligence.app', './.native-product-Ab12/Code Intelligence Validation.app',
    '/repo/.native-product-Ab12/Code Intelligence Validation.app/']) {
    assert.throws(() => candidateRelative('/repo', app), { code: 'APP_PATH' });
  }
});

test('archive paths reject traversal, absolute, backslash, drive, encoded and control aliases', () => {
  for (const name of ['../x', '/x', './x', 'a//b', 'a/../x', 'a\\x', 'C:/x', 'x:stream', 'a/%2e%2e/x', 'a/%2F/x', 'a\0x', 'a\nx']) {
    assert.throws(() => relativeName(name), { code: 'ENTRY_PATH' }, name);
  }
  assert.equal(relativeName('META-INF/maven/g/a/', true), 'META-INF/maven/g/a');
});

test('package discovery selects installed roots including scopes/nesting, not examples or arbitrary JSON', () => {
  for (const name of ['package.json', 'node_modules/a/package.json', 'node_modules/@scope/a/package.json',
    'node_modules/a/node_modules/b/package.json', 'node_modules/@scope/a/node_modules/@other/b/package.json']) assert.equal(packageManifest(name), true, name);
  for (const name of ['node_modules/a/examples/package.json', 'src/package.json', 'node_modules/@scope/package.json',
    'node_modules/a/foo/package.json', 'node_modules/a/node_modules', 'package-lock.json']) assert.equal(packageManifest(name), false, name);
});

test('ASAR metadata is decoded from captured packed bytes without evaluating its scripts', () => {
  const data = bytes({ name: 'a', version: '1.2.3', license: 'MIT', scripts: { install: 'throw-do-not-run' } });
  const archive = asar({ files: { node_modules: { files: { a: { files: { 'package.json': { size: data.length, offset: '0' } } } } } } }, data);
  const entries = parseAsar(archive, Pickle); assert.equal(entries.length, 1);
  assert.equal(entries[0].name, 'node_modules/a/package.json');
  assert.deepEqual(archive.subarray(entries[0].start, entries[0].start + entries[0].size), data);
});

test('ASAR does not follow links, path components or overlarge and overlapping file ranges', () => {
  for (const header of [
    { files: { a: { link: '../../profile' } } },
    { files: { a: { files: {}, link: 'elsewhere' } } },
    { files: { '../a': { size: 1, offset: '0' } } },
    { files: { a: { size: LIMITS.entry + 1, offset: '0' } } },
    { files: { a: { size: 1, offset: '-1' } } },
    { files: { a: { size: 1, offset: '9007199254740992' } } },
    { files: { a: { size: 2, offset: '0' }, b: { size: 1, offset: '1' } } },
    { files: { a: { files: {}, size: 0 } } },
  ]) assert.throws(() => parseAsar(asar(header, bytes('xx')), Pickle));
  const decoded = parseAsar(asar({ files: { 'package.json': { size: 10, unpacked: true } } }), Pickle);
  assert.deepEqual(decoded, [{ name: 'package.json', size: 10, unpacked: true, start: null }]);
});

test('ASAR rejects truncated framing, duplicate decoded keys, invalid UTF-8 and excessive header declarations', () => {
  const valid = asar({ files: { a: { size: 0, offset: '0' } } });
  assert.throws(() => parseAsar(valid.subarray(0, 15), Pickle), { code: 'ASAR_SIZE' });
  const huge = Buffer.from(valid); huge.writeUInt32LE(LIMITS.json + 12, 4);
  assert.throws(() => parseAsar(huge, Pickle), { code: 'ASAR_HEADER' });
  assert.throws(() => parseAsar(asar('{"files":{"a":{"size":0,"size":0,"offset":"0"}}}'), Pickle), { code: 'JSON_INVALID' });
  const invalid = Buffer.from(valid); invalid[16] = 0xff;
  assert.throws(() => parseAsar(invalid, Pickle), { code: 'TEXT_ENCODING' });
});

test('classic ZIP stored/deflated/data-descriptor entries are cross-checked with the installed reader', async () => {
  for (const method of [0, 8]) for (const flags of [0x800, 0x808]) {
    const data = bytes('Manifest-Version: 1.0\r\nImplementation-Version: 1.2.3\r\n\r\n');
    const archive = zip([{ name: 'META-INF/MANIFEST.MF', data, method, flags }], bytes('synthetic comment'));
    const usage = budget(), entries = await openZip(archive, Open, usage);
    assert.equal(entries.length, 1); assert.equal(usage.entries, 1);
    assert.deepEqual(zipEntryBytes(archive, entries[0], usage), data);
  }
});

test('CRC check uses the known IEEE vector and rejects changed entry contents', () => {
  assert.equal(crc32(bytes('123456789')), 0xcbf43926);
  const archive = zip([{ name: 'data', data: 'abc' }]), usage = budget(), entry = preflightZip(archive, usage).entries[0];
  archive[entry.start] ^= 1;
  assert.throws(() => zipEntryBytes(archive, entry, usage), { code: 'ZIP_CONTENT' });
});

test('ZIP rejects unsafe paths even in unselected entries and duplicate file/directory identities', () => {
  for (const name of ['../secret', '/secret', 'C:/secret', 'a\\secret', 'a/%2e%2e/secret', 'a//secret']) {
    assert.throws(() => preflightZip(zip([{ name, data: 'unselected' }])));
  }
  for (const names of [['a', 'a'], ['a', 'a/'], ['a/', 'a'], ['a', 'a/b'], ['a/b', 'a']]) {
    assert.throws(() => preflightZip(zip(names.map(name => ({ name, data: name.endsWith('/') ? '' : 'x' })))));
  }
});

test('ZIP refuses links, unsupported methods, encryption and local/central name disagreement', () => {
  for (const item of [
    { name: 'linked', data: '../profile', attributes: (0xa000 << 16) >>> 0 },
    { name: 'device', data: '', attributes: (0x2000 << 16) >>> 0 },
    { name: 'encrypted', data: 'x', flags: 0x801 },
    { name: 'method', data: 'x', method: 12 },
    { name: 'safe', localName: '../unsafe', data: 'x' },
  ]) assert.throws(() => preflightZip(zip([item])));
});

test('ZIP64, multipart, truncated directory and incorrect descriptor fail before a reader is called', async () => {
  const valid = zip([{ name: 'data', data: 'abc', flags: 0x808 }]), changed = [];
  const multipart = Buffer.from(valid); multipart.writeUInt16LE(1, multipart.length - 22 + 4); changed.push(multipart);
  const zip64 = Buffer.from(valid); zip64.writeUInt16LE(65535, zip64.length - 22 + 10); changed.push(zip64);
  changed.push(valid.subarray(0, valid.length - 1));
  const descriptor = Buffer.from(valid), entry = preflightZip(valid).entries[0]; descriptor[entry.start + entry.compressed + 4] ^= 1; changed.push(descriptor);
  changed.push(zip([{ name: 'data', data: 'x', extra: Buffer.from([1, 0, 0, 0]) }]));
  for (const archive of changed) {
    let called = 0;
    await assert.rejects(openZip(archive, { buffer: async () => { called++; throw new Error('must not read'); } }, budget()));
    assert.equal(called, 0);
  }
});

test('ZIP caps declared per-entry and cumulative sizes/counts without allocating the advertised data', () => {
  assert.throws(() => preflightZip(zip([{ name: 'bomb', data: 'x', method: 8, size: LIMITS.entry + 1 }])), { code: 'ZIP_ENTRY_LIMIT' });
  const archive = zip([{ name: 'data', data: 'x' }]);
  assert.throws(() => preflightZip(archive, { entries: LIMITS.allEntries, declaredBytes: 0, inflatedBytes: 0 }), { code: 'ZIP_TOTAL_LIMIT' });
  assert.throws(() => preflightZip(archive, { entries: 0, declaredBytes: LIMITS.declaredBytes, inflatedBytes: 0 }), { code: 'ZIP_TOTAL_LIMIT' });
  const tooMany = Buffer.from(archive); tooMany.writeUInt16LE(LIMITS.entries + 1, archive.length - 22 + 8); tooMany.writeUInt16LE(LIMITS.entries + 1, archive.length - 22 + 10);
  assert.throws(() => preflightZip(tooMany), { code: 'ZIP_DIRECTORY' });
});

test('ZIP inflation cannot trust understated uncompressed size or exceed a selected/aggregate budget', () => {
  const bomb = zip([{ name: 'small-declaration', data: 'x'.repeat(4096), method: 8, size: 1 }]);
  const usage = budget(), entry = preflightZip(bomb, usage).entries[0];
  assert.throws(() => zipEntryBytes(bomb, entry, usage), { code: 'ZIP_INFLATE' });
  const archive = zip([{ name: 'small', data: 'abcd' }]), checked = preflightZip(archive).entries[0];
  assert.throws(() => zipEntryBytes(archive, checked, budget(), 3), { code: 'ZIP_SELECTED_LIMIT' });
  assert.throws(() => zipEntryBytes(archive, checked, { entries: 0, declaredBytes: 0, inflatedBytes: LIMITS.inflatedBytes }), { code: 'ZIP_INFLATE_LIMIT' });
  assert.throws(() => zipEntryBytes(archive, { ...checked, start: -1 }, budget()), { code: 'ZIP_SELECTED_LIMIT' });
});

test('ZIP reader disagreement is a failure rather than silently accepting another entry', async () => {
  const archive = zip([{ name: 'data', data: 'abc' }]);
  await assert.rejects(openZip(archive, { buffer: async () => ({ files: [{ path: 'different' }] }) }, budget()), { code: 'ZIP_READER_DISAGREEMENT' });
});

test('ZIP refuses overlapping local records even when each header separately matches its central metadata', () => {
  const inner = zip([{ name: 'b', data: 'x' }]);
  const innerEnd = inner.length - 22, localB = inner.subarray(0, inner.readUInt32LE(innerEnd + 16));
  const archive = zip([{ name: 'a', data: localB }, { name: 'b', data: 'x' }]);
  const central = archive.readUInt32LE(archive.length - 22 + 16);
  const secondRecord = central + 46 + 1; // First central record has the one-byte name "a".
  archive.writeUInt32LE(31, secondRecord + 42); // Embedded b header starts inside a's data.
  assert.throws(() => preflightZip(archive), { code: 'ZIP_OVERLAP' });
});

test('nested parser accepts empty stored directories but never reads a directory as metadata', () => {
  const archive = zip([{ name: 'META-INF/', data: '' }]), usage = budget();
  const entry = preflightZip(archive, usage).entries[0];
  assert.equal(entry.directory, true);
  assert.throws(() => zipEntryBytes(archive, entry, usage), { code: 'ZIP_SELECTED_LIMIT' });
});

test('package output contains selected declarations/hashes and excludes paths, credentials, authors and scripts', () => {
  const raw = bytes({ name: '@scope/package', version: '1.2.3', license: '(MIT OR Apache-2.0)',
    author: '/Users/private/person', scripts: { install: 'not executed' }, secret: 'github_pat_private',
    repository: 'https://name:password@example.invalid' });
  const lock = { packages: { 'node_modules/@scope/package': { version: '1.2.3', integrity: 'sha512-YWJjZA==', resolved: 'https://private:secret@example.invalid' } } };
  const result = packageRecord(raw, { container: 'APP_ASAR', name: 'node_modules/@scope/package/package.json' }, lock, 'CURRENT_CHECKOUT_NOT_BUILD_ATTESTATION');
  assert.equal(result.name, '@scope/package'); assert.equal(result.version, '1.2.3'); assert.equal(result.lock.comparison, 'MATCH');
  assert.equal(result.license.status, 'DECLARED_NOT_REVIEWED'); assert.equal(result.evidence.sha256, hash(raw));
  assert.equal(result.evidence.entryPathSha256, hash('node_modules/@scope/package/package.json'));
  assert.doesNotMatch(JSON.stringify(result), /\/Users|password|github_pat|not executed|example\.invalid/);
});

test('missing or unsafe metadata and mismatched locks remain explicit, without source-lock substitution', () => {
  const result = packageRecord(bytes({ name: '/Users/private', version: 'github_pat_secret', license: 'SEE LICENSE IN /Users/private' }),
    { container: 'TS_RUNTIME', name: 'package.json' }, { packages: { '': { version: '1.0.0' } } }, 'SHIPPED_LOCK_DECLARATION');
  assert.equal(result.name, null); assert.equal(result.version, null); assert.equal(result.status, 'NOASSERTION');
  assert.equal(result.license.declaration, null); assert.equal(result.lock.comparison, 'NOASSERTION');
  const mismatch = packageRecord(bytes({ name: 'a', version: '2.0.0' }), { container: 'APP_ASAR', name: 'package.json' },
    { packages: { '': { version: '1.0.0' } } }, 'CURRENT_CHECKOUT_NOT_BUILD_ATTESTATION');
  assert.equal(mismatch.version, '2.0.0'); assert.equal(mismatch.lock.comparison, 'MISMATCH');
  const missing = packageRecord(bytes({ name: 'a', version: '2.0.0' }), { container: 'APP_ASAR', name: 'package.json' }, null, 'MISSING');
  assert.equal(missing.lock.comparison, 'MISSING');
  assert.throws(() => packageRecord(bytes('{"name":"a","version":"1.0.0","version":"2.0.0"}'),
    { container: 'APP_ASAR', name: 'package.json' }, null, 'MISSING'), { code: 'JSON_INVALID' });
});

test('JRE, manifest continuation and Maven metadata are static and only selected fields survive', () => {
  assert.deepEqual(javaMetadata(bytes('JAVA_VERSION="21.0.12"\nMODULES="java.base java.sql"\nBUILD_PATH="/Users/private"\n'), 'release'),
    { javaVersion: '21.0.12', modules: ['java.base', 'java.sql'] });
  const manifest = javaMetadata(bytes('Manifest-Version: 1.0\r\nImplementation-Version: 1.2.\r\n 3\r\nMain-Class: example.Main\r\nBuild-User: /Users/private\r\n\r\nName: secret\r\n'), 'manifest');
  assert.equal(manifest.implementationVersion, '1.2.3'); assert.equal(manifest.mainClass, 'example.Main');
  assert.doesNotMatch(JSON.stringify(manifest), /private|secret/);
  assert.deepEqual(javaMetadata(bytes('# authored only\ngroupId=example.group\nartifactId=demo\nversion=1.0.0\n'), 'pom'),
    { groupId: 'example.group', artifactId: 'demo', version: '1.0.0' });
});

test('duplicate or unsupported properties never become guessed coordinates, and absent versions are unverified', () => {
  for (const data of ['groupId=a\ngroupId=b\n', 'groupId=example\\u002egroup\n', 'version=1.0.\\\n 0\n']) {
    const result = metadataRecord(bytes(data), 'pom', 'NESTED_JAR', 'META-INF/maven/a/b/pom.properties');
    assert.equal(result.status, 'NOASSERTION'); assert.equal(result.fields, undefined);
  }
  assert.throws(() => javaMetadata(bytes('Implementation-Version: 1.0\nimplementation-version: 2.0\n'), 'manifest'), { code: 'METADATA_DUPLICATE' });
  assert.equal(metadataRecord(bytes('Manifest-Version: 1.0\n\n'), 'manifest', 'JAR', 'META-INF/MANIFEST.MF').status, 'NOASSERTION');
  assert.equal(metadataRecord(bytes('MODULES="java.base"\n'), 'release', 'RUNTIME', 'jre/release').status, 'NOASSERTION');
});

test('nested JAR inventory reads only metadata and actual library bytes; no dependency graph or license is invented', async () => {
  const pom = bytes('groupId=example\nartifactId=one\nversion=1.2.3\n');
  const nested = zip([{ name: 'META-INF/MANIFEST.MF', data: 'Manifest-Version: 1.0\nImplementation-Version: 1.2.3\n\n', method: 8 },
    { name: 'META-INF/maven/example/one/pom.properties', data: pom }, { name: 'example/Unexecuted.class', data: 'not code to execute' }]);
  const outer = zip([{ name: 'META-INF/MANIFEST.MF', data: 'Manifest-Version: 1.0\nMain-Class: example.Main\n\n' },
    { name: 'BOOT-INF/lib/one-1.2.3.jar', data: nested }, { name: 'BOOT-INF/classes/static/app.js', data: 'throw new Error("do not run")' }]);
  const result = await jarInventory(outer, Open);
  assert.equal(result.components.length, 1); const item = result.components[0];
  assert.equal(item.fileName, 'one-1.2.3.jar'); assert.equal(item.evidence.sha256, hash(nested));
  assert.deepEqual(item.metadata.find(value => value.kind === 'pom').fields, { groupId: 'example', artifactId: 'one', version: '1.2.3' });
  assert.equal(item.license.status, 'NOASSERTION'); assert.equal(item.dependencyGraph, 'UNVERIFIED');
  assert.equal(result.unselectedEntryContents, 'NOT_DECOMPRESSED'); assert.doesNotMatch(JSON.stringify(result), /do not run|not code to execute/);
});

test('unsafe paths inside a nested dependency also fail the entire inventory', async () => {
  const nested = zip([{ name: '../profile', data: 'x' }]);
  await assert.rejects(jarInventory(zip([{ name: 'BOOT-INF/lib/bad.jar', data: nested }]), Open), { code: 'ENTRY_PATH' });
});

test('unsupported nested metadata layouts retain only verified bytes and explicit non-coverage', async () => {
  const duplicate = zip([{ name: 'META-INF/MANIFEST.MF', data: 'one' }, { name: 'META-INF/MANIFEST.MF', data: 'two' }]);
  const accepted = zip([{ name: 'META-INF/maven/example/ok/pom.properties', data: 'groupId=example\nartifactId=ok\nversion=1.0\n' }]);
  const result = await jarInventory(zip([{ name: 'BOOT-INF/lib/unsupported.jar', data: duplicate },
    { name: 'BOOT-INF/lib/ok-1.0.jar', data: accepted }]), Open);
  const unknown = result.components[0];
  assert.equal(unknown.metadataInspection, 'UNSUPPORTED_ARCHIVE_LAYOUT');
  assert.equal(unknown.reason, 'ZIP_DUPLICATE_OR_TYPE');
  assert.deepEqual(unknown.metadata, []); assert.equal(unknown.evidence.sha256, hash(duplicate));
  assert.equal(result.components[1].metadata[0].fields.groupId, 'example');
});

function sourceLock() {
  return { format: 1, sources: [['openssl', '3.5.8', 'LICENSE.txt'], ['postgres', '16.15', 'COPYRIGHT'],
    ['redis', '8.10.2', 'LICENSE.txt'], ['pgvector', '0.8.7', 'LICENSE']].map(([id, version, licenseFile]) =>
    ({ id, version, licenseFile, sha256: 'a'.repeat(64), url: 'https://private:secret@example.invalid', checksumSource: '/Users/private' })) };
}
test('native source declarations retain hashes without treating sources as binary-version or license proof', () => {
  const result = nativeLock(bytes(sourceLock())); assert.equal(result.length, 4);
  assert.equal(result[2].name, 'redis'); assert.equal(result[2].version, '8.10.2');
  assert.equal(result[2].licenseFile, 'redis-8.10.2-LICENSE.txt');
  assert.equal(result[2].sourceArchiveSha256, 'a'.repeat(64));
  assert.doesNotMatch(JSON.stringify(result), /private|secret|example\.invalid|\/Users/);
  for (const mutate of [value => { value.sources[0].licenseFile = '../../profile'; },
    value => { value.sources[0].sha256 = 'unknown'; }, value => { value.sources[0].version = '../escape'; },
    value => { value.sources[1] = value.sources[0]; }, value => { value.sources.pop(); }]) {
    const value = sourceLock(); mutate(value); assert.throws(() => nativeLock(bytes(value)), { code: 'NATIVE_SOURCE_LOCK' });
  }
});
