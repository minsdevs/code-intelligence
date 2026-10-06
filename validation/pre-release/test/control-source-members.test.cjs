'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { verifyControlSourceMembers } = require('../control-runtime.cjs');

const hash = value => crypto.createHash('sha256').update(value).digest('hex');
const member = (name, data) => ({ name, data });

// Independent stored ZIP fixture: no test imports, extraction or external tools.
function crc32(bytes) {
  let value = 0xffffffff;
  for (const byte of bytes) {
    value ^= byte;
    for (let bit = 0; bit < 8; bit++) value = (value >>> 1) ^ ((value & 1) ? 0xedb88320 : 0);
  }
  return (value ^ 0xffffffff) >>> 0;
}

function zip(items) {
  const locals = [], centrals = []; let offset = 0;
  for (const item of items) {
    const name = Buffer.from(item.name), data = Buffer.from(item.data), crc = crc32(data);
    const local = Buffer.alloc(30), central = Buffer.alloc(46);
    local.writeUInt32LE(0x04034b50); local.writeUInt16LE(20, 4); local.writeUInt16LE(0x800, 6);
    local.writeUInt32LE(crc, 14); local.writeUInt32LE(data.length, 18); local.writeUInt32LE(data.length, 22); local.writeUInt16LE(name.length, 26);
    central.writeUInt32LE(0x02014b50); central.writeUInt16LE(0x314, 4); central.writeUInt16LE(20, 6); central.writeUInt16LE(0x800, 8);
    central.writeUInt32LE(crc, 16); central.writeUInt32LE(data.length, 20); central.writeUInt32LE(data.length, 24); central.writeUInt16LE(name.length, 28); central.writeUInt32LE(offset, 42);
    locals.push(local, name, data); centrals.push(central, name); offset += local.length + name.length + data.length;
  }
  const central = Buffer.concat(centrals), end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50); end.writeUInt16LE(items.length, 8); end.writeUInt16LE(items.length, 10);
  end.writeUInt32LE(central.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, central, end]);
}

function fixture(t, mutate = () => {}) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'control-source-members-')));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const classRoot = path.join(root, 'classes');
  fs.mkdirSync(path.join(classRoot, 'dev/codeintelligence/desktop'), { recursive: true });
  const classes = [
    member('dev/codeintelligence/desktop/DesktopControlApplication.class', 'dispatcher'),
    member('dev/codeintelligence/desktop/NativeLeaseWorker.class', 'lease'),
    member('dev/codeintelligence/desktop/ManagedProcessWorker.class', 'managed'),
    member('dev/codeintelligence/desktop/ManagedProcessWorker$Guardian.class', 'guardian'),
  ];
  for (const { name, data } of classes) fs.writeFileSync(path.join(classRoot, name), data, { mode: 0o600 });
  const dependencies = [
    { groupId: 'tools.jackson.core', artifactId: 'jackson-core', version: '3.1.7', fileName: 'jackson-core-3.1.7.jar' },
    { groupId: 'tools.jackson.core', artifactId: 'jackson-databind', version: '3.1.7', fileName: 'jackson-databind-3.1.7.jar' },
    { groupId: 'com.fasterxml.jackson.core', artifactId: 'jackson-annotations', version: '2.21.7', fileName: 'jackson-annotations-2.21.7.jar' },
  ];
  const legal = [
    [member('META-INF/LICENSE.txt', 'core license'), member('META-INF/NOTICE', 'core notice'),
      member('META-INF/lowercase-license.txt', 'lowercase license'), member('META-INF/legal/Notice.txt', 'nested notice')],
    [member('META-INF/LICENSE', 'databind license')],
    [member('META-INF/LICENSE', 'annotations license')],
  ];
  // Explicit Gradle copy/exclude expectations, independent of the verifier's regexes.
  // Lowercase and nested legal entries are copied at both original and relocated paths.
  const copied = [
    [member('tools/jackson/core/JsonFactory.class', 'core'),
      member('META-INF/versions/21/tools/jackson/core/JsonFactory.class', 'core21'),
      member('META-INF/services/tools.jackson.core.TokenStreamFactory', 'core-provider'), ...legal[0].slice(2)],
    [member('tools/jackson/databind/ObjectMapper.class', 'databind'),
      member('tools/jackson/databind/config.properties', 'strict=true')],
    [member('com/fasterxml/jackson/annotation/JsonProperty.class', 'annotations')],
  ];
  const manifest = member('META-INF/MANIFEST.MF', 'Manifest-Version: 1.0\r\n\r\n');
  const omitted = [
    [manifest, member('module-info.class', 'module'), member('META-INF/versions/21/module-info.class', 'module21'),
      member('META-INF/CORE.SF', 'signature'), member('META-INF/CORE.RSA', 'rsa'), member('META-INF/CORE.DSA', 'dsa'),
      member('META-INF/.SF', 'empty-prefix signature'), member('META-INF/.RSA', 'empty-prefix rsa'), member('META-INF/.DSA', 'empty-prefix dsa'),
      ...legal[0].slice(0, 2)],
    [manifest, ...legal[1]],
    [manifest, ...legal[2]],
  ];
  const sources = copied.map((items, index) => [...items, ...omitted[index]].map(item => ({ ...item })));
  const backendItems = sources.map((items, index) => {
    const data = zip(items), dependency = dependencies[index];
    dependency.sha256 = hash(data);
    return member('BOOT-INF/lib/' + dependency.fileName, data);
  });
  const licenseItems = dependencies.flatMap((dependency, index) => legal[index].map(({ name, data }) =>
    member(`META-INF/licenses/${dependency.groupId}/${dependency.artifactId}/${dependency.version}/${name.slice('META-INF/'.length)}`, data)));
  const state = {
    sources, dependencies, backendItems, licenses: licenseItems.map(item => item.name),
    items: [member('META-INF/MANIFEST.MF', 'Manifest-Version: 1.0\r\nMain-Class: dev.codeintelligence.desktop.DesktopControlApplication\r\nMulti-Release: true\r\n\r\n'),
      ...classes.map(item => ({ ...item })), ...copied.flat().map(item => ({ ...item })), ...licenseItems],
  };
  mutate(state);
  // Seal after mutation so target changes cannot be rejected merely by the outer JAR hash.
  const jar = zip(state.items), jarFile = path.join(root, 'control.jar'), backendJarFile = path.join(root, 'backend.jar');
  fs.writeFileSync(jarFile, jar, { mode: 0o600 });
  fs.writeFileSync(backendJarFile, zip(state.backendItems), { mode: 0o600 });
  const provenance = {
    format: 1, kind: 'DESKTOP_CONTROL_RUNTIME', mainClass: 'dev.codeintelligence.desktop.DesktopControlApplication',
    jarSha256: hash(jar), classes: Object.fromEntries(classes.map(({ name, data }) => [name, hash(data)])),
    dependencies: state.dependencies, licenses: state.licenses,
  };
  const provenanceFile = path.join(root, 'provenance.json');
  fs.writeFileSync(provenanceFile, JSON.stringify(provenance), { mode: 0o600 });
  return { root, classRoot, jarFile, provenanceFile, backendJarFile, provenance };
}

test('all copied bytes, compiled classes and relocated licenses match three hash-bound archives', async t => {
  const f = fixture(t), result = await verifyControlSourceMembers(f);
  assert.equal(result.jarSha256, f.provenance.jarSha256);
  assert.equal(result.provenanceSha256, hash(fs.readFileSync(f.provenanceFile)));
  assert.equal(result.backendJarSha256, hash(fs.readFileSync(f.backendJarFile)));
  assert.equal(result.allShadedRegularMembersVerified, true);
  assert.equal(result.classesCount, 4);
  assert.equal(result.comparedRegularMembers, 18);
  assert.equal(result.entriesCount, 19);
  assert.equal(result.sourceArchiveMembers, 23);
  assert.deepEqual(result.dependencies, f.provenance.dependencies);
  assert.deepEqual([...result.licenses].sort(), [...f.provenance.licenses].sort());
  assert.deepEqual(result.sourceArchives, f.provenance.dependencies.map((dependency, index) => ({
    ...dependency, copiedMembers: [5, 2, 1][index], omittedMembers: [11, 2, 2][index], relocatedLicenses: [4, 1, 1][index],
  })));
});

test('a declared dependency archive cannot be missing from the backend', async t => {
  const f = fixture(t, s => { s.backendItems.splice(1, 1); });
  await assert.rejects(verifyControlSourceMembers(f), { code: 'CONTROL_SOURCE_ARCHIVE_MISSING' });
});

test('matching archive filenames do not bypass a source SHA mismatch', async t => {
  const f = fixture(t, s => {
    s.sources[0][0].data = 'changed source';
    s.backendItems[0].data = zip(s.sources[0]); // Keep the original provenance SHA.
  });
  await assert.rejects(verifyControlSourceMembers(f), { code: 'CONTROL_SOURCE_ARCHIVE_HASH' });
});

test('matching archive bytes and SHA do not bypass the exact BOOT-INF/lib filename', async t => {
  const f = fixture(t, s => { s.backendItems[0].name = 'BOOT-INF/lib/renamed.jar'; });
  await assert.rejects(verifyControlSourceMembers(f), { code: 'CONTROL_SOURCE_ARCHIVE_MISSING' });
});

const resource = 'tools/jackson/databind/config.properties';
for (const [label, mutate, code] of [
  ['an extra class in an allowed Jackson namespace', s => { s.items.push(member('tools/jackson/core/Injected.class', 'extra')); }, 'CONTROL_SOURCE_MEMBER_SET'],
  ['an excluded empty-prefix signature left in the target', s => { s.items.push(member('META-INF/.SF', 'empty-prefix signature')); }, 'CONTROL_SOURCE_MEMBER_SET'],
  ['a renamed member with the same member count', s => { s.items.find(item => item.name === resource).name = 'tools/jackson/databind/renamed.properties'; }, 'CONTROL_SOURCE_MEMBER_SET'],
  ['a missing copied resource', s => { s.items = s.items.filter(item => item.name !== resource); }, 'CONTROL_SOURCE_MEMBER_SET'],
  ['changed Jackson class bytes with unchanged names', s => { s.items.find(item => item.name === 'tools/jackson/core/JsonFactory.class').data = 'replacement'; }, 'CONTROL_SOURCE_MEMBER_BYTES'],
  ['changed resource bytes with unchanged names', s => { s.items.find(item => item.name === resource).data = 'strict=false'; }, 'CONTROL_SOURCE_MEMBER_BYTES'],
  ['changed relocated license bytes', s => { s.items.find(item => item.name === s.licenses[0]).data = 'replacement license'; }, 'CONTROL_SOURCE_MEMBER_BYTES'],
  ['an omitted NOTICE in the provenance license list', s => { s.licenses = s.licenses.filter(name => !name.endsWith('/NOTICE')); }, 'CONTROL_SOURCE_LICENSE_SET'],
]) {
  test(`a freshly hashed target still rejects ${label}`, async t => {
    await assert.rejects(verifyControlSourceMembers(fixture(t, mutate)), { code });
  });
}

test('two hash-bound source archives cannot claim the same member even with identical bytes', async t => {
  const f = fixture(t, s => {
    s.sources[1].push({ ...s.sources[0][0] });
    const bytes = zip(s.sources[1]);
    s.backendItems[1].data = bytes;
    s.dependencies[1].sha256 = hash(bytes);
  });
  await assert.rejects(verifyControlSourceMembers(f), { code: 'CONTROL_SOURCE_COLLISION' });
});

test('a symlink backend archive is rejected', async t => {
  const f = fixture(t), link = path.join(f.root, 'linked-backend.jar');
  fs.symlinkSync(f.backendJarFile, link);
  await assert.rejects(verifyControlSourceMembers({ ...f, backendJarFile: link }), { code: 'CONTROL_PATH' });
});
