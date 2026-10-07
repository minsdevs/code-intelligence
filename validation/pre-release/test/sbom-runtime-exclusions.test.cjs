'use strict';

// Authored ZIP and resolution fixtures for the production runtime exclusion check
// (supply-chain defect D2). No Gradle build, candidate bundle or network is used.
const test = require('node:test');
const assert = require('node:assert/strict');
const zlib = require('node:zlib');
const licence = require('../licence-obligations.cjs');
const exclusions = require('../sbom-runtime-exclusions.cjs');
const { crc32 } = require('../inventory-candidate.cjs');

function zipOf(members) {
  const locals = [], centrals = []; let offset = 0;
  for (const { name, data, method = 0 } of members) {
    const packed = method === 8 ? zlib.deflateRawSync(data) : data, nameBytes = Buffer.from(name);
    const local = Buffer.alloc(30); local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4); local.writeUInt16LE(method, 8);
    local.writeUInt32LE(crc32(data), 14); local.writeUInt32LE(packed.length, 18); local.writeUInt32LE(data.length, 22); local.writeUInt16LE(nameBytes.length, 26);
    const central = Buffer.alloc(46); central.writeUInt32LE(0x02014b50, 0); central.writeUInt16LE((3 << 8) | 20, 4); central.writeUInt16LE(20, 6);
    central.writeUInt16LE(method, 10); central.writeUInt32LE(crc32(data), 16); central.writeUInt32LE(packed.length, 20);
    central.writeUInt32LE(data.length, 24); central.writeUInt16LE(nameBytes.length, 28);
    central.writeUInt32LE(((name.endsWith('/') ? 0o040755 : 0o100644) << 16) >>> 0, 38); central.writeUInt32LE(offset, 42);
    locals.push(local, nameBytes, packed); centrals.push(central, nameBytes);
    offset += 30 + nameBytes.length + packed.length;
  }
  const directory = Buffer.concat(centrals), end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(members.length, 8); end.writeUInt16LE(members.length, 10);
  end.writeUInt32LE(directory.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, directory, end]);
}
const CLASS = Buffer.from([0xca, 0xfe, 0xba, 0xbe]);
const library = (group, artifact, version, classes) => zipOf([
  { name: 'META-INF/MANIFEST.MF', data: Buffer.from('Manifest-Version: 1.0\n') },
  ...(group ? [{ name: `META-INF/maven/${group}/${artifact}/pom.properties`, data: Buffer.from(`groupId=${group}\nartifactId=${artifact}\nversion=${version}\n`) }] : []),
  ...classes.map(name => ({ name, data: CLASS }))]);
const bootJar = nested => zipOf([{ name: 'BOOT-INF/', data: Buffer.alloc(0) }, { name: 'BOOT-INF/classes/app/Main.class', data: CLASS },
  ...Object.entries(nested).map(([name, data]) => ({ name: `BOOT-INF/lib/${name}`, data, method: 8 })),
  { name: 'org/springframework/boot/loader/launch/JarLauncher.class', data: CLASS }]);

test('policy excludes jmh-core and the benchmark-only pair it pulls in, with a reason for each', () => {
  const rules = licence.POLICY.excludedRuntime;
  assert.deepEqual(rules.map(rule => [rule.group, rule.artifact || null]),
    [['org.openjdk.jmh', null], ['net.sf.jopt-simple', 'jopt-simple'], ['org.apache.commons', 'commons-math3']]);
  for (const rule of rules) { assert.match(rule.reason, /\S{10}/); assert.match(rule.classPrefix, /^[a-z]+(?:\/[a-z0-9]+)*\/$/); }
  assert.equal(licence.excludedRuntime({ groupId: 'org.openjdk.jmh', artifactId: 'jmh-generator-annprocess' }).group, 'org.openjdk.jmh');
  assert.equal(licence.excludedRuntime({ groupId: 'org.apache.commons', artifactId: 'commons-math3' }).artifact, 'commons-math3');
  for (const allowed of [{ groupId: 'org.apache.commons', artifactId: 'commons-lang3' }, { groupId: 'com.github.jsqlparser', artifactId: 'jsqlparser' },
    { groupId: 'org.openjdk.jmh.evil', artifactId: 'x' }, {}, null]) assert.equal(licence.excludedRuntime(allowed), null);
});

test('boot JAR check reads every nested JAR by its own pom.properties and by class prefix', () => {
  const failing = bootJar({
    'jsqlparser-5.3.jar': library('com.github.jsqlparser', 'jsqlparser', '5.3', ['net/sf/jsqlparser/parser/CCJSqlParserUtil.class']),
    'jmh-core-1.37.jar': library('org.openjdk.jmh', 'jmh-core', '1.37', ['org/openjdk/jmh/runner/Runner.class']),
    // A repackaged copy without Maven metadata is still caught by its classes.
    'renamed.jar': library(null, null, null, ['joptsimple/OptionParser.class']),
  });
  const coordinates = exclusions.bootJarCoordinates(failing);
  assert.deepEqual(coordinates.map(item => [item.fileName, item.groupId, item.artifactId, item.version]), [
    ['jsqlparser-5.3.jar', 'com.github.jsqlparser', 'jsqlparser', '5.3'],
    ['jmh-core-1.37.jar', 'org.openjdk.jmh', 'jmh-core', '1.37'],
    ['renamed.jar', null, null, null]]);
  const result = exclusions.check(coordinates);
  assert.equal(result.status, 'FAIL'); assert.equal(result.checked, 3);
  assert.deepEqual(result.excluded.map(item => [item.fileName, item.rule, item.matchedBy]),
    [['jmh-core-1.37.jar', 'org.openjdk.jmh', 'MAVEN_COORDINATE'], ['renamed.jar', 'net.sf.jopt-simple:jopt-simple', 'CLASS_PREFIX']]);
  const passing = bootJar({ 'jsqlparser-5.3.jar': library('com.github.jsqlparser', 'jsqlparser', '5.3', ['net/sf/jsqlparser/parser/CCJSqlParserUtil.class']) });
  assert.deepEqual(exclusions.check(exclusions.bootJarCoordinates(passing)), { status: 'PASS', checked: 1, excluded: [] });
  assert.throws(() => exclusions.bootJarCoordinates(zipOf([{ name: 'a.txt', data: Buffer.from('x') }])), { code: 'NOT_A_BOOT_JAR' });
});

test('resolution check uses the runtime-inventory format and fails on an excluded coordinate', () => {
  const resolved = components => ({ format: 1, kind: 'RESOLVED_GRADLE_RUNTIME_ARTIFACTS', components });
  const jsql = { groupId: 'com.github.jsqlparser', artifactId: 'jsqlparser', version: '5.3', fileName: 'jsqlparser-5.3.jar', sha256: 'a'.repeat(64) };
  const math = { groupId: 'org.apache.commons', artifactId: 'commons-math3', version: '3.6.1', fileName: 'commons-math3-3.6.1.jar', sha256: 'b'.repeat(64) };
  const failing = exclusions.check(exclusions.resolvedCoordinates(resolved([jsql, math])));
  assert.equal(failing.status, 'FAIL');
  assert.deepEqual(failing.excluded.map(item => [item.artifactId, item.rule, item.matchedBy]), [['commons-math3', 'org.apache.commons:commons-math3', 'MAVEN_COORDINATE']]);
  assert.equal(exclusions.check(exclusions.resolvedCoordinates(resolved([jsql]))).status, 'PASS');
  for (const malformed of [null, {}, { kind: 'OTHER', components: [] }, resolved(null)])
    assert.throws(() => exclusions.resolvedCoordinates(malformed), { code: 'RESOLVED_MAVEN_INVALID' });
});

test('arguments take exactly one absolute boot JAR or one resolution file name', () => {
  assert.deepEqual(exclusions.argumentsFor(['--jar', '/abs/code-intelligence.jar']), { jar: '/abs/code-intelligence.jar' });
  assert.deepEqual(exclusions.argumentsFor(['--resolved', 'runtime-resolved-X.json']), { resolved: 'runtime-resolved-X.json' });
  for (const argv of [[], ['--jar', 'relative.jar'], ['--resolved', '../x.json'], ['--jar', '/a.jar', '--resolved', 'r.json'], ['--other', 'x']])
    assert.throws(() => exclusions.argumentsFor(argv), { code: 'ARGUMENTS' });
});
