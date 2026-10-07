'use strict';
// Read-only release-signing readiness inspector (validation/pre-release/native-signing-readiness.cjs)
// and its mirror of the runtime signing plan. No identity, keychain, notary or network access.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const zlib = require('node:zlib');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');
const readiness = require('../../validation/pre-release/native-signing-readiness.cjs');
const { signRuntime } = require('../scripts/sign-macos-runtime.cjs');
const { runtimeSigningTargets } = readiness;

const darwin = { skip: process.platform !== 'darwin' };
const sha = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const THIN = Buffer.from('cffaedfe0c000001', 'hex');

// Minimal ZIP writer for fixtures: STORED or DEFLATED entries, central directory, EOCD.
function zip(entries) {
  const locals = [], centrals = []; let offset = 0;
  for (const { name, data, deflate } of entries) {
    const body = deflate ? zlib.deflateRawSync(data) : data, file = Buffer.from(name);
    const local = Buffer.alloc(30); local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4);
    local.writeUInt16LE(deflate ? 8 : 0, 8); local.writeUInt32LE(body.length, 18); local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(file.length, 26);
    const central = Buffer.alloc(46); central.writeUInt32LE(0x02014b50, 0); central.writeUInt16LE(20, 4); central.writeUInt16LE(20, 6);
    central.writeUInt16LE(deflate ? 8 : 0, 10); central.writeUInt32LE(body.length, 20); central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(file.length, 28); central.writeUInt32LE(offset, 42);
    locals.push(local, file, body); centrals.push(central, file); offset += 30 + file.length + body.length;
  }
  const directory = Buffer.concat(centrals), end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(entries.length, 8); end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(directory.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, directory, end]);
}

test('Mach-O magic separates universal binaries from Java class files that share CAFEBABE', () => {
  for (const magic of ['feedface', 'cefaedfe', 'feedfacf', 'cffaedfe']) assert.equal(readiness.machOKind(Buffer.from(magic + '00000000', 'hex')), 'thin');
  assert.equal(readiness.machOKind(Buffer.from('cafebabe00000002', 'hex')), 'fat');
  assert.equal(readiness.machOKind(Buffer.from('cafebabe00000041', 'hex')), null, 'Java 21 class file');
  assert.equal(readiness.machOKind(Buffer.from('cafebabe0003002d', 'hex')), null, 'Java 1.1 class file');
  assert.equal(readiness.machOKind(Buffer.from('cafebabe', 'hex')), null);
  assert.equal(readiness.machOKind(Buffer.from('504b0304', 'hex')), null);
});

test('codesign display distinguishes ad-hoc, Developer ID with secure timestamp, and unsigned code', () => {
  const adhoc = readiness.parseCodesignDisplay(['Executable=/x/postgres', 'Identifier=postgres-5555',
    'CodeDirectory v=20500 size=17458 flags=0x10002(adhoc,runtime) hashes=534+7 location=embedded',
    'Signature=adhoc', 'TeamIdentifier=not set', 'Runtime Version=26.5.0'].join('\n'));
  assert.deepEqual([adhoc.signed, adhoc.adhoc, adhoc.runtime, adhoc.teamId, adhoc.secureTimestamp], [true, true, true, null, false]);
  const release = readiness.parseCodesignDisplay(['Identifier=dev.codeintelligence.desktop',
    'CodeDirectory v=20500 size=1 flags=0x10000(runtime) hashes=1+7 location=embedded',
    'Authority=Developer ID Application: Example Org (ABCDE12345)', 'Authority=Developer ID Certification Authority',
    'Authority=Apple Root CA', 'Timestamp=Oct 7, 2026 at 10:00:00', 'TeamIdentifier=ABCDE12345'].join('\n'));
  assert.deepEqual([release.adhoc, release.runtime, release.teamId, release.secureTimestamp, release.authorities.length], [false, true, 'ABCDE12345', true, 3]);
  const insecure = readiness.parseCodesignDisplay(['CodeDirectory v=20500 size=1 flags=0x0(none) hashes=1+7',
    'Signed Time=Oct 7, 2026', 'TeamIdentifier=ABCDE12345'].join('\n'));
  assert.equal(insecure.secureTimestamp, false, 'Signed Time is not a secure timestamp');
  assert.equal(insecure.runtime, false);
  assert.equal(readiness.parseCodesignDisplay('/x: code object is not signed at all\n').signed, false);
});

test('entitlements, deployment target and reference classes are parsed exactly', () => {
  assert.deepEqual(readiness.parseEntitlementsXml('<dict><key>b.key</key><true/><key>a.key</key><true/><key>off</key><false/></dict>'), ['a.key', 'b.key']);
  assert.deepEqual(readiness.parseEntitlementsXml(''), []);
  assert.deepEqual(readiness.parseBuildVersion('      cmd LC_BUILD_VERSION\n  cmdsize 32\n platform 1\n    minos 13.0\n      sdk 26.5\n'), { minos: '13.0', sdk: '26.5' });
  assert.deepEqual(readiness.parseBuildVersion('      cmd LC_VERSION_MIN_MACOSX\n  cmdsize 16\n  version 10.15\n      sdk n/a\n'), { minos: '10.15', sdk: null });
  assert.equal(readiness.compareVersion('13.0', '13'), 0); assert.equal(readiness.compareVersion('13.1', '13.0'), 1);
  assert.equal(readiness.compareVersion('11.0', '13.0'), -1);
  assert.equal(readiness.classifyReference('/usr/lib/libSystem.B.dylib'), 'system');
  assert.equal(readiness.classifyReference('/System/Library/Frameworks/Security.framework/Versions/A/Security'), 'system');
  assert.equal(readiness.classifyReference('@rpath/libpq.5.dylib'), 'relative');
  assert.equal(readiness.classifyReference('@loader_path/../lib/libssl.3.dylib'), 'relative');
  assert.equal(readiness.classifyReference('/opt/homebrew/opt/openssl@3/lib/libssl.3.dylib'), 'external');
  assert.equal(readiness.classifyReference('/usr/lib/../../opt/homebrew/lib/x.dylib'), 'external');
  assert.equal(readiness.classifyReference('/usr/local/lib/libredis.dylib'), 'external');
});

test('archive scan finds stored, deflated and nested-JAR Mach-O members but not Java classes', () => {
  const inner = zip([{ name: 'org/x/native/libjnidispatch.jnilib', data: Buffer.concat([THIN, Buffer.alloc(64)]), deflate: true },
    { name: 'org/x/A.class', data: Buffer.from('cafebabe00000041' + '00'.repeat(32), 'hex'), deflate: true }]);
  const outer = zip([{ name: 'BOOT-INF/lib/inner.jar', data: inner }, { name: 'a.dylib', data: Buffer.concat([THIN, Buffer.alloc(8)]) },
    { name: 'README.txt', data: Buffer.from('plain text '.repeat(100)), deflate: true }]);
  const result = readiness.scanArchive(outer, 'backend/app.jar');
  assert.deepEqual(result.machO.map(item => item.member).sort(),
    ['backend/app.jar!/BOOT-INF/lib/inner.jar!/org/x/native/libjnidispatch.jnilib', 'backend/app.jar!/a.dylib']);
  assert.equal(result.archives, 2); assert.equal(result.entries, 5); assert.equal(result.nativeNamed.length, 2);
  const broken = readiness.scanArchive(Buffer.from('not a zip archive at all'), 'x.jar');
  assert.deepEqual(broken.unsupported, [{ archive: 'x.jar', code: 'ZIP_EOCD_MISSING' }]);
});

test('signing plan coverage and inside-out order are checked against every Mach-O', () => {
  const order = [{ file: '/A.app/Contents/Frameworks/F.framework/Versions/A/F' }, { file: '/A.app/Contents/Frameworks/F.framework' },
    { file: '/A.app/Contents/MacOS/A' }, { file: '/A.app' }];
  assert.deepEqual(readiness.signingOrderFindings(order), []);
  const outsideIn = [order[1], order[0], order[3]];
  assert.deepEqual(readiness.signingOrderFindings(outsideIn).map(item => [item.code, item.target]),
    [['SIGNING_ORDER_OUTSIDE_IN', '/A.app/Contents/Frameworks/F.framework/Versions/A/F']]);
  assert.deepEqual(readiness.coverageFindings(['/A.app/Contents/MacOS/A', '/A.app/Contents/PlugIns/x'], new Set(['/A.app/Contents/MacOS/A'])),
    [{ code: 'MACHO_NOT_IN_SIGNING_PLAN', file: '/A.app/Contents/PlugIns/x' }]);
  const app = '/A.app', runtime = '/A.app/Contents/Resources/runtime';
  assert.equal(readiness.builderIgnored(app, '/A.app/Contents/Resources/runtime/jre/bin/java', runtime), true);
  assert.equal(readiness.builderIgnored(app, '/A.app/Contents/PlugIns/x', runtime), true);
  assert.equal(readiness.builderIgnored(app, '/A.app/Contents/Frameworks/F.framework', runtime), false);
  assert.equal(readiness.plannedEntitlementFile(app, app, { entitlements: 'a.plist', entitlementsInherit: 'b.plist' }), 'a.plist');
  assert.equal(readiness.plannedEntitlementFile(app, '/A.app/Contents/MacOS/A', { entitlements: 'a.plist', entitlementsInherit: 'b.plist' }), 'b.plist');
});

test('ad-hoc signatures are pending before signing and release blockers when a Team ID is expected', () => {
  const findings = [{ severity: 'SIGNING_PENDING', code: 'ADHOC_SIGNATURE' }, { severity: 'REVIEW', code: 'X' }];
  assert.deepEqual(readiness.classifyFindings(findings).map(item => item.severity), ['SIGNING_PENDING', 'REVIEW']);
  assert.deepEqual(readiness.classifyFindings(findings, { expectTeamId: 'ABCDE12345' }).map(item => item.severity), ['RELEASE_BLOCKER', 'REVIEW']);
  assert.throws(() => readiness.argumentsFor(['--app', '/x/A.app', '--expect-team-id', 'not-a-team']), /TEAM_ID_FORMAT/);
  assert.throws(() => readiness.argumentsFor(['--app', 'relative/A.app']), /USAGE/);
  assert.throws(() => readiness.argumentsFor(['--app', '/x/A.app', '--sign', 'yes']), /USAGE/);
});

test('Electron fuse wire is read from the sentinel without modifying the binary', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codeintel-fuse-')); t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const file = path.join(root, 'Electron Framework');
  fs.writeFileSync(file, Buffer.concat([Buffer.alloc(32), Buffer.from('dL7pKGdnNz796PbbjQWNKmHXBZaB9tsX'), Buffer.from([1, 4]), Buffer.from('10r0'), Buffer.alloc(16)]));
  const before = sha(fs.readFileSync(file));
  assert.deepEqual(readiness.readFuses(file), { version: 1, fuses: { RunAsNode: 'ENABLE', EnableCookieEncryption: 'DISABLE',
    EnableNodeOptionsEnvironmentVariable: 'REMOVED', EnableNodeCliInspectArguments: 'DISABLE' } });
  assert.equal(sha(fs.readFileSync(file)), before);
  fs.writeFileSync(file, Buffer.alloc(64)); assert.equal(readiness.readFuses(file), null);
});

function compile(root, output, minimum = '13.0') {
  const source = path.join(root, `${path.basename(output)}.c`);
  fs.writeFileSync(source, 'int main(void) { return 0; }\n');
  execFileSync('/usr/bin/clang', ['-arch', 'arm64', `-mmacosx-version-min=${minimum}`, source, '-o', output], { stdio: 'pipe', timeout: 120000 });
  fs.rmSync(source);
}

test('runtime signing plan is exactly the set signRuntime signs', darwin, async t => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'codeintel-plan-'))); t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const runtime = path.join(root, 'Plan.app/Contents/Resources/runtime');
  for (const name of ['postgres/bin', 'postgres/lib', 'postgres/share', 'redis/bin']) fs.mkdirSync(path.join(runtime, name), { recursive: true });
  compile(root, path.join(runtime, 'postgres/bin/postgres')); compile(root, path.join(runtime, 'redis/bin/redis-server'));
  fs.writeFileSync(path.join(runtime, 'postgres/share/catalog.txt'), 'resource\n');
  const files = {};
  for (const name of ['postgres/bin/postgres', 'redis/bin/redis-server', 'postgres/share/catalog.txt']) files[name] = sha(fs.readFileSync(path.join(runtime, name)));
  const manifest = { format: 1, platform: 'darwin', arch: process.arch, buildSequence: '1',
    runtime: { postgresBin: 'postgres/bin', postgresLib: 'postgres/lib', postgresPkgLib: 'postgres/lib', postgresShare: 'postgres/share' }, files };
  fs.writeFileSync(path.join(runtime, 'runtime-manifest.json'), JSON.stringify(manifest));
  const plan = runtimeSigningTargets(runtime, manifest);
  assert.deepEqual(plan, ['postgres/bin/postgres', 'redis/bin/redis-server']);
  const signed = await signRuntime(runtime, { identity: '-', optionsForFile: () => ({ hardenedRuntime: true,
    entitlements: path.resolve(__dirname, '../build/entitlements.mac.plist') }) });
  const changed = Object.keys(files).filter(name => signed.files[name] !== files[name]).sort();
  assert.deepEqual(changed, plan);
});

test('bundle inspection reports uncovered, escaping, archived and too-new code without changing the bundle', darwin, async t => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'codeintel-readiness-'))); t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const app = path.join(root, 'Probe.app'), contents = path.join(app, 'Contents'), runtime = path.join(contents, 'Resources/runtime');
  for (const name of ['MacOS', 'PlugIns', 'Resources/runtime/postgres/bin', 'Resources/runtime/postgres/share', 'Resources/runtime/backend'])
    fs.mkdirSync(path.join(contents, name), { recursive: true });
  fs.writeFileSync(path.join(contents, 'Info.plist'), '<?xml version="1.0" encoding="UTF-8"?>\n<plist version="1.0"><dict>'
    + '<key>CFBundleExecutable</key><string>Probe</string><key>CFBundleIdentifier</key><string>test.probe</string>'
    + '<key>LSMinimumSystemVersion</key><string>13.0</string></dict></plist>\n');
  compile(root, path.join(contents, 'MacOS/Probe'));
  compile(root, path.join(runtime, 'postgres/bin/postgres'), '14.0');
  const entitlements = path.resolve(__dirname, '../build/entitlements.mac.plist');
  for (const file of [path.join(contents, 'MacOS/Probe'), path.join(runtime, 'postgres/bin/postgres')])
    execFileSync('/usr/bin/codesign', ['--force', '--sign', '-', '--options', 'runtime', '--entitlements', entitlements, file], { stdio: 'pipe' });
  compile(root, path.join(contents, 'PlugIns/unplanned'));
  // arm64 linkers ad-hoc sign by default; this binary must be genuinely unsigned.
  execFileSync('/usr/bin/codesign', ['--remove-signature', path.join(contents, 'PlugIns/unplanned')], { stdio: 'pipe' });
  fs.writeFileSync(path.join(runtime, 'backend/app.jar'), zip([{ name: 'native/libx.dylib', data: Buffer.concat([THIN, Buffer.alloc(32)]), deflate: true }]));
  const files = Object.fromEntries(['postgres/bin/postgres', 'backend/app.jar'].map(name => [name, sha(fs.readFileSync(path.join(runtime, name)))]));
  fs.writeFileSync(path.join(runtime, 'runtime-manifest.json'), JSON.stringify({ format: 1, platform: 'darwin', arch: process.arch,
    buildSequence: '1', files }));
  const snapshot = () => execFileSync('/usr/bin/find', [app, '-exec', '/usr/bin/stat', '-f', '%N %m %z %p', '{}', ';'], { encoding: 'utf8' });
  const before = snapshot();
  const report = await readiness.inspectBundle(app);
  const codes = new Set(report.findings.map(item => `${item.severity}:${item.code}`));
  for (const expected of ['NOTARY_BLOCKER:MACHO_NOT_IN_SIGNING_PLAN', 'NOTARY_BLOCKER:MACHO_UNSIGNED',
    'NOTARY_BLOCKER:MACHO_INSIDE_ARCHIVE','DEPLOYMENT_BLOCKER:MINIMUM_OS_EXCEEDED', 'SIGNING_PENDING:ADHOC_SIGNATURE',
    'SIGNING_PENDING:NO_SECURE_TIMESTAMP']) assert(codes.has(expected), expected);
  assert.equal(report.status, 'BLOCKED');
  assert.deepEqual(report.findings.filter(item => item.code === 'MACHO_NOT_IN_SIGNING_PLAN').map(item => item.file), ['Contents/PlugIns/unplanned']);
  assert.equal(report.counts.machO, 3); assert.equal(report.counts.runtimePlan, 1); assert.equal(report.plan.insideOut, true);
  assert.equal(report.deployment.highestMinos, '14.0');
  const postgres = report.machO.find(item => item.file.endsWith('postgres/bin/postgres'));
  assert.equal(postgres.signer, 'signRuntime'); assert.equal(postgres.role, 'postgres-executable');
  assert.deepEqual(postgres.unjustifiedEntitlements.includes('com.apple.security.cs.allow-jit'), true);
  const strict = await readiness.inspectBundle(app, { expectTeamId: 'ABCDE12345' });
  assert(strict.findings.some(item => item.severity === 'RELEASE_BLOCKER' && item.code === 'ADHOC_SIGNATURE'));
  assert(strict.findings.some(item => item.severity === 'RELEASE_BLOCKER' && item.code === 'TEAM_ID_MISMATCH'));
  assert.equal(snapshot(), before, 'inspection must not change bundle metadata or content');
  // A link out of the bundle must never be walked (osx-sign follows links with stat()).
  const outside = path.join(root, 'outside'); fs.mkdirSync(outside);
  compile(root, path.join(outside, 'foreign'));
  fs.symlinkSync(outside, path.join(contents, 'Resources/escape'));
  fs.symlinkSync('missing-target', path.join(contents, 'Resources/dangling'));
  const escaped = await readiness.inspectBundle(app);
  const escapedCodes = escaped.findings.map(item => item.code);
  for (const code of ['SYMLINK_ESCAPES_BUNDLE', 'DANGLING_SYMLINK', 'SIGNING_PLAN_NOT_COMPUTABLE']) assert(escapedCodes.includes(code), code);
  assert.equal(escaped.plan.outerPlanComputed, false); assert.equal(escaped.plan.coverage, null);
  assert(!escaped.plan.order.some(item => item.file.includes('foreign')));
});
