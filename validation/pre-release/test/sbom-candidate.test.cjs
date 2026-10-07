'use strict';

// Pure, authored byte fixtures for the offline SBOM generator and its readers.
// No candidate bundle, subprocess, network, profile or native runtime is used;
// the real-candidate run is recorded separately under validation/local/sbom/.
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const zlib = require('node:zlib');
const macho = require('../sbom-macho.cjs');
const zip = require('../sbom-zip.cjs');
const maven = require('../sbom-maven.cjs');
const sbom = require('../sbom-candidate.cjs');
const { crc32 } = require('../inventory-candidate.cjs');

const sha256 = value => crypto.createHash('sha256').update(value).digest('hex');
const RT = 'Contents/Resources/runtime/';

// ---------------------------------------------------------------- Mach-O fixtures
function stringCommand(cmd, value, fixed = 4) {
  const head = 8 + fixed, text = Buffer.from(value + '\0'), size = Math.ceil((head + text.length) / 8) * 8;
  const bytes = Buffer.alloc(size); bytes.writeUInt32LE(cmd, 0); bytes.writeUInt32LE(size, 4); bytes.writeUInt32LE(head, 8);
  text.copy(bytes, head); return bytes;
}
const dylib = (cmd, name) => stringCommand(cmd, name, 16); // name offset, timestamp, current, compatibility
const rpath = value => stringCommand(0x8000001c, value);
function buildVersion(minos, sdk) {
  const bytes = Buffer.alloc(24); bytes.writeUInt32LE(0x32, 0); bytes.writeUInt32LE(24, 4); bytes.writeUInt32LE(1, 8);
  const encode = text => { const [a, b = 0, c = 0] = text.split('.').map(Number); return (a << 16) | (b << 8) | c; };
  bytes.writeUInt32LE(encode(minos), 12); bytes.writeUInt32LE(encode(sdk), 16); return bytes;
}
function linkedit(vmsize, filesize) {
  const bytes = Buffer.alloc(72); bytes.writeUInt32LE(0x19, 0); bytes.writeUInt32LE(72, 4); bytes.write('__LINKEDIT', 8, 'latin1');
  bytes.writeBigUInt64LE(BigInt(vmsize), 32); bytes.writeBigUInt64LE(BigInt(filesize), 48); return bytes;
}
function codeSignature(offset, size) {
  const bytes = Buffer.alloc(16); bytes.writeUInt32LE(0x1d, 0); bytes.writeUInt32LE(16, 4);
  bytes.writeUInt32LE(offset, 8); bytes.writeUInt32LE(size, 12); return bytes;
}
function machO(filetype, commands, tail = Buffer.alloc(0)) {
  const body = Buffer.concat(commands), header = Buffer.alloc(32);
  header.writeUInt32LE(0xfeedfacf, 0); header.writeUInt32LE(0x0100000c, 4); header.writeUInt32LE(filetype, 12);
  header.writeUInt32LE(commands.length, 16); header.writeUInt32LE(body.length, 20);
  return Buffer.concat([header, body, tail]);
}

test('Mach-O reader decodes loads, rpaths, install name and LC_BUILD_VERSION of thin and fat files', () => {
  const thin = machO(6, [stringCommand(0xd, '@rpath/libpq.5.dylib', 16), dylib(0xc, '/usr/lib/libSystem.B.dylib'),
    dylib(0x80000018, '@rpath/libweak.dylib'), rpath('@loader_path/../lib'), buildVersion('13.0', '15.2')]);
  assert.equal(macho.machOKind(thin), 'thin');
  const parsed = macho.parseMachO(thin);
  assert.equal(parsed.kind, 'thin');
  const [slice] = parsed.slices;
  assert.equal(slice.cpu, 'arm64'); assert.equal(slice.filetype, 'DYLIB');
  assert.equal(slice.installName, '@rpath/libpq.5.dylib');
  assert.deepEqual(slice.loads.map(item => [item.command, item.name]),
    [['LC_LOAD_DYLIB', '/usr/lib/libSystem.B.dylib'], ['LC_LOAD_WEAK_DYLIB', '@rpath/libweak.dylib']]);
  assert.deepEqual(slice.rpaths, ['@loader_path/../lib']);
  assert.equal(slice.minos, '13.0'); assert.equal(slice.sdk, '15.2'); assert.equal(slice.platform, 'MACOS');

  const header = Buffer.alloc(8 + 20); header.writeUInt32BE(0xcafebabe, 0); header.writeUInt32BE(1, 4);
  header.writeUInt32BE(0x0100000c, 8); header.writeUInt32BE(28, 16); header.writeUInt32BE(thin.length, 20);
  const fat = Buffer.concat([header, thin]);
  assert.equal(macho.machOKind(fat), 'fat');
  assert.deepEqual(macho.parseMachO(fat).slices[0].rpaths, ['@loader_path/../lib']);
  // A Java class file shares 0xcafebabe; its big minor/major word is not a small arch count.
  const javaClass = Buffer.from([0xca, 0xfe, 0xba, 0xbe, 0x00, 0x00, 0x00, 0x41]);
  assert.equal(macho.machOKind(javaClass), null);
  const truncated = thin.subarray(0, 40);
  assert.throws(() => macho.parseMachO(truncated), { code: 'MACHO_COMMANDS' });
  assert.ok(macho.compareVersions('13.0', '13') === 0 && macho.compareVersions('14.1', '13.9') > 0 && macho.compareVersions('11', '13.0') < 0);
});

test('Mach-O closure classifies bundle, system, external, unresolved and escaping references', () => {
  const owner = RT + 'postgres/bin/postgres';
  const exists = rel => [RT + 'postgres/lib/libpq.5.dylib', RT + 'postgres/lib/libssl.3.dylib'].includes(rel);
  const slice = macho.parseMachO(machO(2, [dylib(0xc, '@rpath/libpq.5.dylib'), dylib(0xc, '/usr/lib/libSystem.B.dylib'),
    dylib(0xc, '/opt/homebrew/opt/openssl@3/lib/libssl.3.dylib'), dylib(0xc, '@rpath/missing.dylib'),
    dylib(0x80000018, '@rpath/optional.dylib'), dylib(0xc, '@executable_path/../lib/libssl.3.dylib'),
    rpath('@loader_path/../lib'), rpath('/opt/homebrew/lib'), rpath('@loader_path/../../../../../../../outside'), buildVersion('13.0', '15.0')])).slices[0];
  const { references, findings } = macho.classifyReferences(owner, slice, { exists, executableDirs: [] });
  assert.deepEqual(references.map(item => item.resolution), ['BUNDLE', 'SYSTEM', 'EXTERNAL', 'UNRESOLVED', 'UNRESOLVED', 'BUNDLE']);
  assert.deepEqual(references[0].resolvedTo, [RT + 'postgres/lib/libpq.5.dylib']);
  assert.deepEqual(findings.map(item => item.code).sort(), ['ESCAPING_RPATH', 'EXTERNAL_DEPENDENCY', 'EXTERNAL_RPATH',
    'UNRESOLVED_DEPENDENCY', 'UNRESOLVED_WEAK_DEPENDENCY'].sort());

  // A library resolved only through the loading executable's rpath is a bundle hit, not a pass by default.
  const library = macho.parseMachO(machO(6, [dylib(0xc, '@rpath/libpq.5.dylib'), buildVersion('11.0', '14.0')])).slices[0];
  const chained = macho.classifyReferences(RT + 'postgres/lib/plpgsql.dylib', library,
    { exists, executableDirs: [RT + 'postgres/bin'], executableRpaths: [RT + 'postgres/lib'] });
  assert.equal(chained.references[0].resolution, 'BUNDLE_VIA_EXECUTABLE_RPATH');
  assert.deepEqual(chained.findings, []);
  const noTarget = macho.parseMachO(machO(6, [dylib(0xc, '/usr/lib/libz.1.dylib')])).slices[0];
  assert.deepEqual(macho.classifyReferences(RT + 'x.dylib', noTarget, { exists, executableDirs: [] }).findings.map(item => item.code),
    ['MISSING_OR_AMBIGUOUS_DEPLOYMENT_TARGET']);
  assert.equal(macho.systemReference('/usr/lib/../../opt/homebrew/lib/x.dylib'), false);
});

test('signature-insensitive comparison masks only the code-signature fields', () => {
  const build = (vmsize, filesize, signatureSize, code, blob) => {
    const commands = [linkedit(vmsize, filesize), codeSignature(0, signatureSize)];
    const prefix = machO(2, commands, code), at = prefix.length;
    const bytes = Buffer.concat([prefix, blob]);
    bytes.writeUInt32LE(at, 32 + 72 + 8); // LC_CODE_SIGNATURE dataoff
    return bytes;
  };
  const code = Buffer.from('identical text section bytes');
  const upstream = build(0x4000, 0x1200, 0x900, code, Buffer.alloc(0x900, 1));
  const resigned = build(0x8000, 0x1500, 0xc00, code, Buffer.alloc(0xc00, 7));
  assert.equal(sbom.codeBytesEqualIgnoringSignature(upstream, resigned), true);
  const patched = build(0x8000, 0x1500, 0xc00, Buffer.from('identical text section bytez'), Buffer.alloc(0xc00, 7));
  assert.equal(sbom.codeBytesEqualIgnoringSignature(upstream, patched), false);
  assert.equal(sbom.codeBytesEqualIgnoringSignature(machO(2, [buildVersion('13.0', '15.0')]), upstream), false);
});

// ---------------------------------------------------------------- ZIP fixtures
function zipOf(members) {
  const locals = [], centrals = []; let offset = 0;
  for (const { name, data, method = 0, mode = 0o100644 } of members) {
    const packed = method === 8 ? zlib.deflateRawSync(data) : data, nameBytes = Buffer.from(name);
    const local = Buffer.alloc(30); local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4); local.writeUInt16LE(method, 8);
    local.writeUInt32LE(crc32(data), 14); local.writeUInt32LE(packed.length, 18); local.writeUInt32LE(data.length, 22); local.writeUInt16LE(nameBytes.length, 26);
    const central = Buffer.alloc(46); central.writeUInt32LE(0x02014b50, 0); central.writeUInt16LE((3 << 8) | 20, 4); central.writeUInt16LE(20, 6);
    central.writeUInt16LE(method, 10); central.writeUInt32LE(crc32(data), 16); central.writeUInt32LE(packed.length, 20);
    central.writeUInt32LE(data.length, 24); central.writeUInt16LE(nameBytes.length, 28); central.writeUInt32LE((mode << 16) >>> 0, 38); central.writeUInt32LE(offset, 42);
    locals.push(local, nameBytes, packed); centrals.push(central, nameBytes);
    offset += 30 + nameBytes.length + packed.length;
  }
  const directory = Buffer.concat(centrals), end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(members.length, 8); end.writeUInt16LE(members.length, 10);
  end.writeUInt32LE(directory.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, directory, end]);
}

test('lenient ZIP reader lists stored, deflated, directory and symlink members and verifies CRC', () => {
  const licence = Buffer.from('Apache License\nVersion 2.0, January 2004\n'.repeat(20));
  const archive = zipOf([{ name: 'META-INF/', data: Buffer.alloc(0), mode: 0o040755 },
    { name: 'META-INF/LICENSE.txt', data: licence, method: 8 }, { name: 'a/B.class', data: Buffer.from([0xca, 0xfe, 0xba, 0xbe]) },
    { name: 'link', data: Buffer.from('../../etc/passwd'), mode: 0o120777 }]);
  const entries = zip.listZip(archive);
  assert.deepEqual(entries.map(item => [item.name, item.type]), [['META-INF/', 'dir'], ['META-INF/LICENSE.txt', 'file'], ['a/B.class', 'file'], ['link', 'symlink']]);
  assert.deepEqual(zip.readMember(archive, entries[1]), licence);
  assert.throws(() => zip.readMember(archive, entries[0]), { code: 'ZIP_MEMBER' });
  assert.throws(() => zip.readMember(archive, entries[1], 10), { code: 'ZIP_MEMBER' });
  const corrupted = Buffer.from(archive); const at = corrupted.indexOf(Buffer.from([0xca, 0xfe, 0xba, 0xbe])); corrupted[at] ^= 1;
  assert.throws(() => zip.readMember(corrupted, zip.listZip(corrupted)[2]), { code: 'ZIP_CONTENT' });
  assert.throws(() => zip.listZip(Buffer.alloc(40)), { code: 'ZIP_DIRECTORY' });
});

// ---------------------------------------------------------------- Maven POM reading
test('POM reader takes project licences and coordinates, not those of parent or dependencies', () => {
  const pom = `<?xml version="1.0"?><project><!-- <licenses><license><name>GPL</name></license></licenses> -->
    <parent><groupId>org.example</groupId><artifactId>parent</artifactId><version>7</version></parent>
    <artifactId>child</artifactId>
    <dependencies><dependency><groupId>other</groupId><artifactId>dep</artifactId><version>9</version></dependency></dependencies>
    <licenses><license><name>The Apache Software License, Version 2.0</name><url>https://www.apache.org/licenses/LICENSE-2.0.txt</url></license>
    <license><name>GNU Lesser General Public License, version 2.1</name></license></licenses></project>`;
  const parsed = maven.parsePom(pom);
  assert.deepEqual([parsed.groupId, parsed.artifactId, parsed.version], ['org.example', 'child', '7']);
  assert.deepEqual(parsed.parent, { groupId: 'org.example', artifactId: 'parent', version: '7' });
  assert.equal(parsed.licences.length, 2);
  assert.equal(maven.parsePom('not xml'), null);
  const declared = maven.declaredLicences({ embeddedPom: pom, groupId: 'org.example', artifactId: 'child', version: '7' });
  assert.equal(declared.source, 'EMBEDDED_POM'); assert.deepEqual(declared.chain, ['org.example:child:7']);
  assert.deepEqual(maven.cachedFile('/nonexistent', '../x', 'a', '1', 'pom'), []);
});

// ---------------------------------------------------------------- attribution rules
test('file attribution maps every known bundle path family and leaves unknown files unattributed', () => {
  const cases = {
    'Contents/Info.plist': 'first-party:packaging',
    'Contents/MacOS/Code Intelligence Validation': 'electron',
    'Contents/Frameworks/Electron Framework.framework/Versions/A/Libraries/libffmpeg.dylib': 'ffmpeg',
    'Contents/Frameworks/Electron Framework.framework/Versions/A/Helpers/chrome_crashpad_handler': 'crashpad',
    'Contents/Frameworks/Squirrel.framework/Versions/A/Squirrel': 'squirrel-mac',
    'Contents/Frameworks/Code Intelligence Validation Helper (GPU).app/Contents/MacOS/Code Intelligence Validation Helper (GPU)': 'electron',
    'Contents/Resources/legal/electron/LICENSES.chromium.html': 'electron',
    'Contents/Resources/legal/third-party/THIRD-PARTY-NOTICES.txt': 'first-party:packaging',
    'Contents/Resources/app.asar': 'container:app.asar',
    [RT + 'jre/lib/server/libjvm.dylib']: 'temurin-jre',
    [RT + 'redis/bin/redis-server']: 'redis',
    [RT + 'redis/lib/libcrypto.3.dylib']: 'openssl',
    [RT + 'postgres/lib/vector.dylib']: 'pgvector',
    [RT + 'postgres/share/extension/vector--0.8.6--0.8.7.sql']: 'pgvector',
    [RT + 'postgres/share/timezone/Europe/Berlin']: 'iana-tzdata',
    [RT + 'postgres/bin/postgres']: 'postgresql',
    [RT + 'postgres/lib/utf8_and_sjis.dylib']: 'postgresql',
    [RT + 'postgres/lib/euc2004_sjis2004.dylib']: 'postgresql',
    [RT + 'ts-analyzer/node_modules/typescript/lib/typescript.js']: 'analyzer-npm',
    [RT + 'ts-analyzer/dist/index.js']: 'first-party:ts-analyzer',
    [RT + 'backend/backup-migrations/V1__baseline.sql']: 'first-party:backend',
  };
  for (const [rel, expected] of Object.entries(cases)) assert.equal(sbom.attributeFile(rel), expected, rel);
  for (const rel of ['Contents/Frameworks/Unknown.framework/Unknown', RT + 'postgres/bin/pg_ctl_evil', RT + 'postgres/lib/libunknown.dylib',
    RT + 'node/bin/node', 'Contents/Resources/extra.bin']) assert.equal(sbom.attributeFile(rel), null, rel);
  assert.equal(sbom.attributeBackendMember('BOOT-INF/lib/a-1.jar'), 'nested-jar');
  assert.equal(sbom.attributeBackendMember('BOOT-INF/classes/static/assets/index.js'), 'first-party:frontend');
  assert.equal(sbom.attributeBackendMember('org/springframework/boot/loader/launch/JarLauncher.class'), 'spring-boot-loader');
  assert.equal(sbom.attributeBackendMember('com/evil/Injected.class'), null);
});

test('npm helpers resolve nested package roots and declared licence expressions', () => {
  assert.equal(sbom.npmRoot('node_modules/a/index.js'), 'node_modules/a');
  assert.equal(sbom.npmRoot('node_modules/@s/p/lib/x.js'), 'node_modules/@s/p');
  assert.equal(sbom.npmRoot('node_modules/a/node_modules/@s/p/package.json'), 'node_modules/a/node_modules/@s/p');
  assert.equal(sbom.npmRoot('src/main.cjs'), null);
  assert.equal(sbom.npmRoot('node_modules/@s/package.json'), null);
  assert.equal(sbom.npmExpression({ license: 'MIT' }), 'MIT');
  assert.equal(sbom.npmExpression({ license: { type: 'ISC' } }), 'ISC');
  assert.equal(sbom.npmExpression({ licenses: [{ type: 'MIT' }, 'Apache-2.0'] }), 'MIT OR Apache-2.0');
  assert.equal(sbom.npmExpression({}), null);
});

test('version witnesses require a unique most-frequent value', () => {
  assert.equal(sbom.uniqueWitness(Buffer.from('Chrome/1.2.3.4 x Chrome/1.2.3.4 Chrome/9.9.9.9'), /Chrome\/([0-9.]+)/g).value, '1.2.3.4');
  assert.equal(sbom.uniqueWitness(Buffer.from('Chrome/1.2.3.4 Chrome/9.9.9.9'), /Chrome\/([0-9.]+)/g).value, null);
  assert.equal(sbom.uniqueWitness(Buffer.from('none'), /Chrome\/([0-9.]+)/g).value, null);
  assert.deepEqual(sbom.plistStrings('<key>CFBundleVersion</key>\n<string>44.4.5</string>'), { CFBundleVersion: '44.4.5' });
});

test('arguments require --offline, an absolute app path and a resolved-maven file name only', () => {
  const app = '/repo/.native-product-x/Code Intelligence Validation.app';
  assert.deepEqual(sbom.argumentsFor(['--offline', '--app', app, '--resolved-maven', 'runtime-resolved-x.json']),
    { otool: false, offline: true, app, resolved: 'runtime-resolved-x.json' });
  for (const argv of [['--app', app, '--resolved-maven', 'r.json'], ['--offline', '--app', 'relative.app', '--resolved-maven', 'r.json'],
    ['--offline', '--app', app, '--resolved-maven', '../r.json'], ['--offline', '--offline', '--app', app, '--resolved-maven', 'r.json'],
    ['--offline', '--app', app, '--resolved-maven', 'r.json', '--electron-zip', 'relative.zip'], ['--offline', '--app', app, '--resolved-maven', 'r.json', '--online']]) {
    assert.throws(() => sbom.argumentsFor(argv), { code: 'ARGUMENTS' }, JSON.stringify(argv));
  }
});

// ---------------------------------------------------------------- CycloneDX document
function syntheticResult(unattributed) {
  const file = (location, text) => ({ location, sha256: sha256(text) });
  const comp = (ref, extra) => ({ ref, files: [], noticeEvidence: [], properties: {}, licence: { class: 'PERMISSIVE', chosen: ['MIT'] },
    licenceSourceKind: 'DECLARED', type: 'library', ...extra });
  const components = new Map([
    ['first-party:backend', comp('first-party:backend', { kind: 'first-party', type: 'application', name: 'backend', version: '0.1.0', firstParty: true, expression: 'MIT',
      files: [file('a', 'a'), file('b', 'b')] })],
    ['redis', comp('redis', { kind: 'native-runtime', type: 'application', name: 'redis', version: '8.10.2', expression: 'LicenseRef-RSALv2 OR SSPL-1.0 OR AGPL-3.0-only',
      purl: 'pkg:generic/redis@8.10.2', files: [file(RT + 'redis/bin/redis-server', 'r')], provenance: { sourceSha256: 'x' } })],
    ['redis:lua', comp('redis:lua', { kind: 'native-embedded', name: 'Lua', version: '5.1', parent: 'redis', expression: 'MIT' })],
    ['maven:g:a:1', comp('maven:g:a:1', { kind: 'maven', group: 'g', name: 'a', version: '1', expression: 'Apache-2.0', hashes: [sha256('jar')],
      purl: 'pkg:maven/g/a@1?type=jar', files: [file('jar', 'jar')] })],
    ['orphan', comp('orphan', { kind: 'npm', name: 'orphan' })],
  ]);
  return { components, unattributed, product: { name: 'Code Intelligence Validation', version: '0.1.0', bundleId: 'id', minimumSystemVersion: '13.0' } };
}
const meta = { timestamp: '2026-10-07T00:00:00.000Z', toolSha256: 'a'.repeat(64), bundleTreeDigest: 'b'.repeat(64), buildSequence: '1',
  candidate: '.native-product-x', serial: '12345678-1234-5123-8123-123456789abc' };

test('CycloneDX 1.5 output is structurally valid, hashes components and reports completeness honestly', () => {
  const bom = sbom.cycloneDx(syntheticResult([]), meta);
  assert.deepEqual(sbom.validateCycloneDx(bom), []);
  assert.equal(bom.specVersion, '1.5');
  const refs = bom.components.map(item => item['bom-ref']);
  assert.ok(refs.includes('redis:lua'), 'embedded components with a parent are emitted without own files');
  assert.ok(!refs.includes('orphan'), 'components without files or parent are not emitted');
  const backend = bom.components.find(item => item['bom-ref'] === 'first-party:backend');
  assert.equal(backend.hashes[0].content, sbom.treeDigest(syntheticResult([]).components.get('first-party:backend').files));
  const redis = bom.components.find(item => item['bom-ref'] === 'redis');
  assert.deepEqual(redis.licenses, [{ expression: 'LicenseRef-RSALv2 OR SSPL-1.0 OR AGPL-3.0-only' }]);
  assert.deepEqual(bom.components.find(item => item['bom-ref'] === 'maven:g:a:1').licenses, [{ license: { id: 'Apache-2.0' } }]);
  assert.deepEqual(bom.dependencies.find(item => item.ref === 'redis').dependsOn, ['redis:lua']);
  assert.deepEqual(bom.dependencies.find(item => item.ref === 'first-party:backend').dependsOn, ['maven:g:a:1']);
  assert.equal(bom.compositions[0].aggregate, 'complete');
  assert.equal(sbom.cycloneDx(syntheticResult([{ location: 'x' }]), meta).compositions[0].aggregate, 'incomplete');
});

test('CycloneDX structural validation rejects duplicate refs, bad hashes, dangling dependencies and mixed licence forms', () => {
  const bom = sbom.cycloneDx(syntheticResult([]), meta);
  bom.components.push({ ...bom.components[0] });
  bom.components[1].hashes = [{ alg: 'SHA-256', content: 'nothex' }];
  bom.components[2].licenses = [{ expression: 'MIT' }, { license: { id: 'MIT' } }];
  bom.dependencies.push({ ref: 'missing', dependsOn: ['also-missing'] });
  bom.serialNumber = 'urn:uuid:not-a-uuid';
  const errors = sbom.validateCycloneDx(bom);
  for (const expected of ['serialNumber', 'bom-ref', 'hash', 'expression must be alone', 'dependency missing', 'dependsOn also-missing']) {
    assert.ok(errors.some(error => error.includes(expected)), `${expected}: ${errors.join('; ')}`);
  }
});

test('otool cross-check compares loads, rpaths, minimum OS and install name against the byte reader', () => {
  const slice = macho.parseMachO(machO(6, [stringCommand(0xd, '@rpath/libx.dylib', 16), dylib(0xc, '/usr/lib/libSystem.B.dylib'),
    rpath('@loader_path'), buildVersion('13.0', '15.0')])).slices[0];
  const listing = minos => [
    'Load command 0', '      cmd LC_ID_DYLIB', '  cmdsize 48', '     name @rpath/libx.dylib (offset 24)',
    'Load command 1', '      cmd LC_LOAD_DYLIB', '  cmdsize 56', '     name /usr/lib/libSystem.B.dylib (offset 24)',
    'Load command 2', '      cmd LC_RPATH', '  cmdsize 32', '     path @loader_path (offset 12)',
    'Load command 3', '      cmd LC_BUILD_VERSION', '  cmdsize 24', ' platform 1', '    minos ' + minos, '      sdk 15.0', '   ntools 0', ''].join('\n');
  const dashL = 'binary:\n\t@rpath/libx.dylib (compatibility version 1.0.0, current version 1.0.0)\n\t/usr/lib/libSystem.B.dylib (compatibility version 1.0.0, current version 1.0.0)\n';
  const run = minos => args => (args.includes('-l') ? listing(minos) : dashL);
  assert.deepEqual(sbom.otoolCompare(run('13.0'), slice), { status: 'MATCH', differences: [], otoolL: 2 });
  assert.deepEqual(sbom.otoolCompare(run('14.0'), slice).differences, ['MINOS']);
  assert.equal(sbom.otoolCompare(() => { throw Object.assign(new Error('x'), { code: 'ENOENT' }); }, slice).status, 'OTOOL_FAILED');
});
