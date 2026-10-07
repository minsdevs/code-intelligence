'use strict';

// Read-only release-signing readiness inspector for a packaged macOS candidate.
// It never signs, notarizes, staples, uploads, contacts Apple, changes the bundle,
// or reads signing identities, keychains or credentials. It compares every Mach-O in
// the bundle with the exact plan the release signing hook would execute.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const zlib = require('node:zlib');
const { createRequire } = require('node:module');
const { execFileSync, spawnSync } = require('node:child_process');
const { isMachOHeader, parseLoadCommands } = require('../../desktop/scripts/native-runtime-policy.cjs');

// Mirror of the file selection inside desktop/scripts/sign-macos-runtime.cjs signRuntime():
// every manifest file, in sorted order, whose first four bytes are a Mach-O header. The
// signing hook does not export it; desktop/test/signing-readiness.test.cjs pins this mirror
// to the files signRuntime actually re-signs, so drift in either copy fails that test.
function runtimeSigningTargets(runtimeRoot, manifest) {
  const nativeFiles = [];
  const head = Buffer.alloc(4);
  for (const relative of Object.keys(manifest.files).sort()) {
    const descriptor = fs.openSync(path.join(runtimeRoot, relative), fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    try {
      if (fs.readSync(descriptor, head, 0, 4, 0) === 4 && isMachOHeader(head)) nativeFiles.push(relative);
    } finally { fs.closeSync(descriptor); }
  }
  return nativeFiles;
}

const TOOL_ENV = Object.freeze({ PATH: '/usr/bin:/bin:/usr/sbin:/sbin', LANG: 'C', LC_ALL: 'C' });
const DECLARED_MINIMUM = '13.0';
const NOTARY_MINIMUM_SDK = '10.9';
const ZIP_LIMITS = Object.freeze({ archiveBytes: 512 * 1024 * 1024, entryBytes: 256 * 1024 * 1024, entries: 200000, depth: 3 });
const FUSE_SENTINEL = Buffer.from('dL7pKGdnNz796PbbjQWNKmHXBZaB9tsX');
const FUSE_NAMES = Object.freeze(['RunAsNode', 'EnableCookieEncryption', 'EnableNodeOptionsEnvironmentVariable',
  'EnableNodeCliInspectArguments', 'EnableEmbeddedAsarIntegrityValidation', 'OnlyLoadAppFromAsar',
  'LoadBrowserProcessSpecificV8Snapshot', 'GrantFileProtocolExtraPrivileges', 'WasmTrapHandlers']);
// Severity vocabulary. NOTARY_BLOCKER fails notarization or the stated release contract even
// after a correct Developer ID pass; SIGNING_PENDING is expected on an ad-hoc candidate and
// becomes RELEASE_BLOCKER when a Team ID is expected; REVIEW needs a decision, not a rebuild.
const SEVERITIES = Object.freeze(['NOTARY_BLOCKER', 'DEPLOYMENT_BLOCKER', 'RELEASE_BLOCKER', 'SIGNING_PENDING', 'REVIEW', 'INFO']);
const ENTITLEMENT_NEEDS = Object.freeze({
  // Least-privilege expectation per role. Evidence: upstream Electron/osx-sign defaults grant only
  // allow-jit to Electron main/GPU/renderer; HotSpot on macOS/aarch64 uses MAP_JIT; PostgreSQL
  // without LLVM JIT and Redis do not generate code; App Sandbox network keys are inert without
  // com.apple.security.app-sandbox. Removing a key still needs Developer ID runtime verification.
  'electron-main': ['com.apple.security.cs.allow-jit'],
  'electron-helper': ['com.apple.security.cs.allow-jit'],
  'jre-executable': ['com.apple.security.cs.allow-jit'],
  'postgres-executable': [], 'redis-executable': [], 'squirrel-updater': [],
});

function fail(code) { throw Object.assign(new Error(code), { code }); }
function tool(command, args, { allowFailure = false, maxBuffer = 4 * 1024 * 1024 } = {}) {
  const result = spawnSync(command, args, { encoding: 'utf8', env: TOOL_ENV, timeout: 60000, maxBuffer });
  if (result.error) fail('TOOL_FAILED_' + path.basename(command).toUpperCase());
  if (!allowFailure && result.status !== 0) fail('TOOL_FAILED_' + path.basename(command).toUpperCase());
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

// Mach-O magic, distinguishing a universal binary from a Java class file (both CAFEBABE).
function machOKind(bytes) {
  if (!Buffer.isBuffer(bytes) || bytes.length < 4) return null;
  const magic = bytes.subarray(0, 4).toString('hex');
  if (['feedface', 'cefaedfe', 'feedfacf', 'cffaedfe'].includes(magic)) return 'thin';
  if (['cafebabe', 'cafebabf'].includes(magic)) {
    if (bytes.length < 8) return null;
    const count = bytes.readUInt32BE(4);
    return count >= 1 && count <= 20 ? 'fat' : null;
  }
  return null;
}

function compareVersion(left, right) {
  const a = String(left).split('.').map(Number), b = String(right).split('.').map(Number);
  for (let i = 0; i < 3; i++) { const x = a[i] || 0, y = b[i] || 0; if (x !== y) return x < y ? -1 : 1; }
  return 0;
}

function parseCodesignDisplay(text) {
  if (typeof text !== 'string') fail('CODESIGN_OUTPUT_INVALID');
  if (/code object is not signed at all/.test(text)) return { signed: false, adhoc: false, runtime: false, teamId: null,
    secureTimestamp: false, authorities: [], identifier: null, flags: null };
  const value = key => { const match = new RegExp(`^${key}=(.*)$`, 'm').exec(text); return match ? match[1].trim() : null; };
  const cd = /^CodeDirectory v=\S+ size=\S+ flags=(0x[0-9a-f]+)\(([^)]*)\)/m.exec(text);
  const flags = cd ? cd[2].split(',').map(item => item.trim()).filter(Boolean) : [];
  const team = value('TeamIdentifier');
  return {
    signed: Boolean(cd), adhoc: value('Signature') === 'adhoc' || flags.includes('adhoc'), runtime: flags.includes('runtime'),
    teamId: team && team !== 'not set' ? team : null, secureTimestamp: value('Timestamp') !== null,
    authorities: [...text.matchAll(/^Authority=(.*)$/gm)].map(match => match[1].trim()),
    identifier: value('Identifier'), flags: cd ? cd[1] : null, runtimeVersion: value('Runtime Version'),
  };
}

function parseEntitlementsXml(text) {
  if (typeof text !== 'string' || !text.trim()) return [];
  const keys = [];
  for (const match of text.matchAll(/<key>([^<]+)<\/key>\s*<(true|false)\s*\/>/g)) if (match[2] === 'true') keys.push(match[1]);
  return [...new Set(keys)].sort();
}

function parseBuildVersion(text) {
  const block = /cmd LC_BUILD_VERSION[\s\S]*?minos ([0-9.]+)\s+sdk ([0-9.]+|n\/a)/.exec(text);
  if (block) return { minos: block[1], sdk: block[2] === 'n/a' ? null : block[2] };
  const legacy = /cmd LC_VERSION_MIN_MACOSX[\s\S]*?version ([0-9.]+)\s+sdk ([0-9.]+|n\/a)/.exec(text);
  return legacy ? { minos: legacy[1], sdk: legacy[2] === 'n/a' ? null : legacy[2] } : { minos: null, sdk: null };
}

function fileType(text) {
  if (/^\s*cmd LC_MAIN\s*$/m.test(text) || /^\s*cmd LC_UNIXTHREAD\s*$/m.test(text)) return 'EXECUTE';
  if (/^\s*cmd LC_ID_DYLIB\s*$/m.test(text)) return 'DYLIB';
  return 'BUNDLE';
}

function classifyReference(reference) {
  if (typeof reference !== 'string' || !reference) return 'invalid';
  if (/^@(rpath|loader_path|executable_path)(\/|$)/.test(reference)) return 'relative';
  if ((reference.startsWith('/usr/lib/') || reference.startsWith('/System/Library/')) && path.posix.normalize(reference) === reference) return 'system';
  return 'external';
}

function roleFor(relative, type) {
  if (relative.startsWith('Contents/MacOS/')) return 'electron-main';
  if (/^Contents\/Frameworks\/[^/]+ Helper[^/]*\.app\//.test(relative)) return 'electron-helper';
  if (relative.startsWith('Contents/Frameworks/Electron Framework.framework/')) return type === 'EXECUTE' ? 'electron-framework-executable' : 'electron-framework-library';
  if (/^Contents\/Frameworks\/(Squirrel|Mantle|ReactiveObjC)\.framework\//.test(relative)) return 'squirrel-updater';
  const runtime = /^Contents\/Resources\/runtime\/(jre|postgres|redis|ts-analyzer|backend)\//.exec(relative);
  if (runtime) return `${runtime[1]}-${type === 'EXECUTE' ? 'executable' : 'library'}`;
  return 'other';
}

// Minimal bounded ZIP central-directory reader (STORED/DEFLATED, ZIP64). It never extracts to disk.
function zipEntries(buffer) {
  const minimum = Math.max(0, buffer.length - 65557);
  let eocd = -1;
  for (let i = buffer.length - 22; i >= minimum; i--) if (buffer.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  if (eocd < 0) fail('ZIP_EOCD_MISSING');
  let count = buffer.readUInt16LE(eocd + 10), size = buffer.readUInt32LE(eocd + 12), offset = buffer.readUInt32LE(eocd + 16);
  if (count === 0xffff || size === 0xffffffff || offset === 0xffffffff) {
    const locator = eocd - 20;
    if (locator < 0 || buffer.readUInt32LE(locator) !== 0x07064b50) fail('ZIP64_LOCATOR_MISSING');
    const record = Number(buffer.readBigUInt64LE(locator + 8));
    if (record + 56 > buffer.length || buffer.readUInt32LE(record) !== 0x06064b50) fail('ZIP64_RECORD_INVALID');
    count = Number(buffer.readBigUInt64LE(record + 32)); size = Number(buffer.readBigUInt64LE(record + 40));
    offset = Number(buffer.readBigUInt64LE(record + 48));
  }
  if (count > ZIP_LIMITS.entries || offset + size > buffer.length) fail('ZIP_LIMIT');
  const entries = [];
  let cursor = offset;
  for (let index = 0; index < count; index++) {
    if (cursor + 46 > buffer.length || buffer.readUInt32LE(cursor) !== 0x02014b50) fail('ZIP_CENTRAL_INVALID');
    const method = buffer.readUInt16LE(cursor + 10);
    let compressed = buffer.readUInt32LE(cursor + 20), uncompressed = buffer.readUInt32LE(cursor + 24);
    const nameLength = buffer.readUInt16LE(cursor + 28), extraLength = buffer.readUInt16LE(cursor + 30), commentLength = buffer.readUInt16LE(cursor + 32);
    let local = buffer.readUInt32LE(cursor + 42);
    const name = buffer.subarray(cursor + 46, cursor + 46 + nameLength).toString('utf8');
    let extra = cursor + 46 + nameLength;
    const extraEnd = extra + extraLength;
    while (extra + 4 <= extraEnd) {
      const id = buffer.readUInt16LE(extra), length = buffer.readUInt16LE(extra + 2);
      if (id === 0x0001) {
        let field = extra + 4;
        if (uncompressed === 0xffffffff) { uncompressed = Number(buffer.readBigUInt64LE(field)); field += 8; }
        if (compressed === 0xffffffff) { compressed = Number(buffer.readBigUInt64LE(field)); field += 8; }
        if (local === 0xffffffff) { local = Number(buffer.readBigUInt64LE(field)); }
      }
      extra += 4 + length;
    }
    cursor = extraEnd + commentLength;
    if (name.endsWith('/')) continue;
    if (local + 30 > buffer.length || buffer.readUInt32LE(local) !== 0x04034b50) fail('ZIP_LOCAL_INVALID');
    const start = local + 30 + buffer.readUInt16LE(local + 26) + buffer.readUInt16LE(local + 28);
    if (start + compressed > buffer.length) fail('ZIP_ENTRY_BOUNDS');
    entries.push({ name, method, compressed, uncompressed, start });
  }
  return entries;
}

function entryPrefix(buffer, entry, bytes = 16) {
  const data = buffer.subarray(entry.start, entry.start + entry.compressed);
  if (entry.method === 0) return data.subarray(0, bytes);
  if (entry.method !== 8) return null;
  try { return zlib.inflateRawSync(data.subarray(0, Math.min(data.length, 4096)), { finishFlush: zlib.constants.Z_SYNC_FLUSH }).subarray(0, bytes); }
  catch { return zlib.inflateRawSync(data, { maxOutputLength: ZIP_LIMITS.entryBytes }).subarray(0, bytes); }
}
function entryBytes(buffer, entry) {
  if (entry.uncompressed > ZIP_LIMITS.entryBytes) fail('ZIP_ENTRY_LIMIT');
  const data = buffer.subarray(entry.start, entry.start + entry.compressed);
  if (entry.method === 0) return data;
  if (entry.method !== 8) fail('ZIP_METHOD_UNSUPPORTED');
  return zlib.inflateRawSync(data, { maxOutputLength: ZIP_LIMITS.entryBytes });
}

// Notarization inspects nested archives; a Mach-O inside a JAR must itself be signed.
function scanArchive(buffer, label, depth = 0, result = { archives: 0, entries: 0, machO: [], nativeNamed: [], unsupported: [] }) {
  result.archives++;
  let entries;
  try { entries = zipEntries(buffer); } catch (error) { result.unsupported.push({ archive: label, code: error.code || 'ZIP_INVALID' }); return result; }
  for (const entry of entries) {
    result.entries++;
    const member = `${label}!/${entry.name}`;
    if (/\.(dylib|jnilib|so|node)$/i.test(entry.name)) result.nativeNamed.push(member);
    const head = entryPrefix(buffer, entry);
    if (head === null) { result.unsupported.push({ archive: member, code: 'ZIP_METHOD_UNSUPPORTED' }); continue; }
    const kind = machOKind(head);
    if (kind) result.machO.push({ member, kind });
    else if (/\.(jar|zip)$/i.test(entry.name) && depth < ZIP_LIMITS.depth) scanArchive(entryBytes(buffer, entry), member, depth + 1, result);
  }
  return result;
}

function readFuses(file) {
  const bytes = fs.readFileSync(file);
  const index = bytes.indexOf(FUSE_SENTINEL);
  if (index < 0) return null;
  const version = bytes[index + FUSE_SENTINEL.length], length = bytes[index + FUSE_SENTINEL.length + 1];
  const wire = bytes.subarray(index + FUSE_SENTINEL.length + 2, index + FUSE_SENTINEL.length + 2 + length);
  return { version, fuses: Object.fromEntries([...wire].map((value, i) => [FUSE_NAMES[i] || `fuse${i}`,
    value === 0x31 ? 'ENABLE' : value === 0x30 ? 'DISABLE' : value === 0x72 ? 'REMOVED' : 'UNKNOWN'])) };
}

// Mirrors electron-builder 26 MacTargetHelper.getOptionsForFile + sign-macos-runtime.cjs ignore.
function plannedEntitlementFile(app, file, mac) {
  if (file === app) return mac.entitlements || null;
  if (file.includes('Library/LoginItems')) return mac.entitlementsLoginHelper || null;
  return mac.entitlementsInherit || null;
}
function builderIgnored(app, file, runtime) {
  const inside = (root, candidate) => { const r = path.relative(root, candidate); return r === '' || (!r.startsWith('..') && !path.isAbsolute(r)); };
  return inside(runtime, file) || file.endsWith('.kext') || file.startsWith('/Contents/PlugIns', app.length)
    || file.includes('/node_modules/puppeteer/.local-chromium') || file.includes('/node_modules/playwright-firefox/.local-browsers')
    || file.includes('/node_modules/playwright/.local-browsers');
}

// Inside-out check: every planned target located inside a bundle target is signed before it.
function signingOrderFindings(order, realpathOf = file => file) {
  const findings = [];
  const resolved = order.map(item => ({ ...item, real: realpathOf(item.file) }));
  resolved.forEach((bundle, index) => {
    if (!/\.(app|framework)$/.test(bundle.real)) return;
    for (let later = index + 1; later < resolved.length; later++) {
      const candidate = resolved[later].real;
      if (candidate !== bundle.real && candidate.startsWith(bundle.real + path.sep))
        findings.push({ code: 'SIGNING_ORDER_OUTSIDE_IN', bundle: bundle.file, target: resolved[later].file });
    }
  });
  return findings;
}

function coverageFindings(machO, plannedReal) {
  return machO.filter(file => !plannedReal.has(file)).map(file => ({ code: 'MACHO_NOT_IN_SIGNING_PLAN', file }));
}

function classifyFindings(findings, { expectTeamId } = {}) {
  return findings.map(item => {
    if (item.severity === 'SIGNING_PENDING' && expectTeamId) return { ...item, severity: 'RELEASE_BLOCKER' };
    return item;
  });
}

function walkBundle(app) {
  const files = [], links = [], special = [], directories = [];
  (function walk(directory) {
    for (const name of fs.readdirSync(directory).sort()) {
      const file = path.join(directory, name), stat = fs.lstatSync(file);
      if (stat.isSymbolicLink()) links.push({ file, target: fs.readlinkSync(file) });
      else if (stat.isDirectory()) { directories.push(file); walk(file); }
      else if (stat.isFile()) files.push({ file, mode: stat.mode & 0o7777, nlink: stat.nlink, size: stat.size });
      else special.push(file);
    }
  })(app);
  return { files, links, special, directories };
}

function header(file, bytes = 8) {
  const descriptor = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW), buffer = Buffer.alloc(bytes);
  try { return buffer.subarray(0, fs.readSync(descriptor, buffer, 0, bytes, 0)); } finally { fs.closeSync(descriptor); }
}

function plistValue(file, key) {
  const result = tool('/usr/bin/plutil', ['-extract', key, 'raw', '-o', '-', file], { allowFailure: true });
  return result.status === 0 ? result.stdout.trim() : null;
}

function xattrInventory(app) {
  const result = tool('/usr/bin/xattr', ['-r', app], { allowFailure: true, maxBuffer: 64 * 1024 * 1024 });
  const byName = {};
  for (const line of result.stdout.split('\n').filter(Boolean)) {
    const at = line.lastIndexOf(': ');
    if (at < 0) continue;
    const name = line.slice(at + 2);
    byName[name] = (byName[name] || 0) + 1;
  }
  return byName;
}

async function inspectBundle(app, { expectTeamId = null, repo = path.resolve(__dirname, '../..') } = {}) {
  assert(path.isAbsolute(app) && app.endsWith('.app'), 'APP_PATH_INVALID');
  const realApp = fs.realpathSync(app);
  const contents = path.join(realApp, 'Contents'), runtime = path.join(contents, 'Resources/runtime');
  const desktop = path.join(repo, 'desktop');
  const mac = JSON.parse(fs.readFileSync(path.join(desktop, 'package.json'), 'utf8')).build.mac;
  const findings = [];
  const add = (severity, code, detail = {}) => { assert(SEVERITIES.includes(severity)); findings.push({ severity, code, ...detail }); };
  const rel = file => path.relative(realApp, file);

  const inventory = walkBundle(realApp);
  if (inventory.files.some(item => item.file.endsWith('.cstemp'))) fail('CSTEMP_PRESENT');
  for (const item of inventory.special) add('NOTARY_BLOCKER', 'SPECIAL_FILE', { file: rel(item) });
  const links = inventory.links.map(link => {
    const resolved = path.resolve(path.dirname(link.file), link.target);
    const inside = !path.isAbsolute(link.target) && (resolved === realApp || resolved.startsWith(realApp + path.sep));
    const exists = fs.existsSync(link.file);
    if (!inside) add('NOTARY_BLOCKER', 'SYMLINK_ESCAPES_BUNDLE', { file: rel(link.file), target: link.target });
    else if (!exists) add('NOTARY_BLOCKER', 'DANGLING_SYMLINK', { file: rel(link.file), target: link.target });
    return { file: rel(link.file), target: link.target, insideBundle: inside, exists };
  });
  // @electron/osx-sign follows symlinks with stat(); never let it walk outside the bundle.
  const walkable = links.every(link => link.insideBundle && link.exists);

  const machO = [], executableData = [], staticArchives = [], privateFiles = [], hardlinks = [], archives = [];
  for (const item of inventory.files) {
    const head = header(item.file);
    const kind = machOKind(head);
    if (kind) machO.push({ ...item, kind });
    else if (item.mode & 0o111) executableData.push(rel(item.file));
    if (!kind && head.subarray(0, 4).toString('hex') === 'cafebabe') add('INFO', 'JAVA_CLASS_FILE_LOOSE', { file: rel(item.file) });
    if (/\.a$/.test(item.file) && head.toString('latin1').startsWith('!<arch>')) staticArchives.push(rel(item.file));
    if ((item.mode & 0o004) === 0) privateFiles.push(rel(item.file));
    if (item.nlink > 1) hardlinks.push(rel(item.file));
    if (/\.(jar|zip)$/i.test(item.file)) archives.push(item);
  }
  for (const file of executableData) add('REVIEW', 'EXECUTABLE_NON_MACHO', { file });
  if (staticArchives.length) add('REVIEW', 'STATIC_ARCHIVES_SHIPPED', { count: staticArchives.length, files: staticArchives });
  if (privateFiles.length) add('REVIEW', 'NOT_WORLD_READABLE', { count: privateFiles.length, sample: privateFiles.slice(0, 10) });
  if (hardlinks.length) add('REVIEW', 'HARDLINKED_FILES', { files: hardlinks });

  // Exact runtime plan from the signing hook, then the outer @electron/osx-sign walk.
  const manifest = JSON.parse(fs.readFileSync(path.join(runtime, 'runtime-manifest.json'), 'utf8'));
  const runtimePlan = runtimeSigningTargets(runtime, manifest).map(name => path.join(runtime, name));
  const builderRequire = createRequire(require.resolve('app-builder-lib/package.json', { paths: [desktop] }));
  const { walkAsync } = builderRequire('@electron/osx-sign/dist/cjs/util');
  const walked = walkable ? (await walkAsync(contents)).slice() : [];
  walked.sort((a, b) => b.split(path.sep).length - a.split(path.sep).length);
  const outerPlan = walkable ? [...walked, realApp].filter(file => !builderIgnored(realApp, file, runtime)) : [];
  const order = [...runtimePlan.map(file => ({ file, signer: 'signRuntime' })), ...outerPlan.map(file => ({ file, signer: 'osx-sign' }))];
  const realOf = file => fs.realpathSync(file);
  const plannedReal = new Set(order.map(item => realOf(item.file)));
  const machOReal = machO.map(item => item.file);
  if (!walkable) add('NOTARY_BLOCKER', 'SIGNING_PLAN_NOT_COMPUTABLE', { reason: 'symlink escapes the bundle or dangles' });
  else for (const item of coverageFindings(machOReal, plannedReal)) add('NOTARY_BLOCKER', item.code, { file: rel(item.file) });
  for (const item of signingOrderFindings(order, realOf)) add('NOTARY_BLOCKER', item.code, { bundle: rel(item.bundle), target: rel(item.target) });
  const outerNonMachO = outerPlan.filter(file => !/\.(app|framework)$/.test(file) && !machOReal.includes(realOf(file)));

  // Per Mach-O: signature, entitlements, deployment target, SDK and dependency classes.
  const entitlementFiles = { app: mac.entitlements, inherit: mac.entitlementsInherit };
  const plannedKeys = {};
  for (const [name, file] of Object.entries(entitlementFiles)) {
    plannedKeys[name] = file ? parseEntitlementsXml(fs.readFileSync(path.join(desktop, file), 'utf8')) : [];
  }
  const declared = plistValue(path.join(contents, 'Info.plist'), 'LSMinimumSystemVersion');
  if (declared !== DECLARED_MINIMUM) add('DEPLOYMENT_BLOCKER', 'DECLARED_MINIMUM_CHANGED', { declared, expected: DECLARED_MINIMUM });
  const details = [];
  for (const item of machO) {
    const relative = rel(item.file);
    const display = tool('/usr/bin/codesign', ['-d', '--verbose=4', item.file], { allowFailure: true });
    const signature = parseCodesignDisplay(display.stderr + display.stdout);
    const entitlementOutput = tool('/usr/bin/codesign', ['-d', '--entitlements', '-', '--xml', item.file], { allowFailure: true });
    const entitlements = parseEntitlementsXml(entitlementOutput.stdout);
    // -m: helper names contain "(GPU)", which otool would otherwise parse as archive(member).
    const loadText = tool('/usr/bin/otool', ['-m', '-arch', 'arm64', '-l', item.file]).stdout;
    const build = parseBuildVersion(loadText), type = fileType(loadText), role = roleFor(relative, type);
    let commands = null, parseError = null;
    try { commands = parseLoadCommands(loadText); } catch (error) { parseError = error.findings?.[0]?.code || error.code || 'LOAD_COMMANDS_INVALID'; }
    const references = commands ? commands.dependencies.filter(name => name !== '/usr/lib/dyld') : [];
    const external = references.filter(name => classifyReference(name) === 'external');
    const externalRpaths = (commands?.rpaths || []).filter(name => classifyReference(name) === 'external');
    const realFile = item.file;
    const signer = runtimePlan.includes(realFile) ? 'signRuntime' : 'osx-sign';
    // The outer bundle signature re-signs its main executable with the application entitlements.
    const planned = signer === 'signRuntime' ? plannedKeys.inherit : plannedKeys[role === 'electron-main' ? 'app' : 'inherit'];
    if (!signature.signed) add('NOTARY_BLOCKER', 'MACHO_UNSIGNED', { file: relative });
    else {
      if (signature.adhoc) add('SIGNING_PENDING', 'ADHOC_SIGNATURE', { file: relative });
      if (!signature.secureTimestamp) add('SIGNING_PENDING', 'NO_SECURE_TIMESTAMP', { file: relative });
      if (expectTeamId && signature.teamId !== expectTeamId) add('RELEASE_BLOCKER', 'TEAM_ID_MISMATCH', { file: relative, teamId: signature.teamId });
      if (type === 'EXECUTE' && !signature.runtime) add('NOTARY_BLOCKER', 'HARDENED_RUNTIME_MISSING', { file: relative });
    }
    if (!build.minos) add('NOTARY_BLOCKER', 'DEPLOYMENT_TARGET_MISSING', { file: relative });
    else if (compareVersion(build.minos, DECLARED_MINIMUM) > 0) add('DEPLOYMENT_BLOCKER', 'MINIMUM_OS_EXCEEDED', { file: relative, minos: build.minos, declared: DECLARED_MINIMUM });
    if (!build.sdk || compareVersion(build.sdk, NOTARY_MINIMUM_SDK) < 0) add('NOTARY_BLOCKER', 'SDK_TOO_OLD_OR_MISSING', { file: relative, sdk: build.sdk });
    for (const reference of external) add('NOTARY_BLOCKER', 'EXTERNAL_LIBRARY_REFERENCE', { file: relative, reference });
    for (const reference of externalRpaths) add('NOTARY_BLOCKER', 'EXTERNAL_RPATH', { file: relative, reference });
    if (parseError) add('REVIEW', 'LOAD_COMMANDS_UNPARSED', { file: relative, parseError });
    if (type === 'EXECUTE' && /\/pgxs\//.test(relative)) add('REVIEW', 'DEVELOPMENT_ONLY_EXECUTABLE', { file: relative });
    const needs = ENTITLEMENT_NEEDS[role];
    const unjustified = type === 'EXECUTE' && needs ? planned.filter(key => !needs.includes(key)) : [];
    details.push({ file: relative, sha256: crypto.createHash('sha256').update(fs.readFileSync(item.file)).digest('hex'),
      kind: item.kind, type, role, minos: build.minos, sdk: build.sdk, signer,
      signature: { signed: signature.signed, adhoc: signature.adhoc, runtime: signature.runtime, teamId: signature.teamId,
        secureTimestamp: signature.secureTimestamp, runtimeVersion: signature.runtimeVersion || null },
      // Entitlements are only embedded in and enforced for main executables, not libraries/bundles.
      entitlements, plannedEntitlements: type === 'EXECUTE' ? planned : [],
      entitlementsMatchPlan: type === 'EXECUTE' ? JSON.stringify(entitlements) === JSON.stringify(planned) : null,
      unjustifiedEntitlements: unjustified,
      references: { system: references.filter(name => classifyReference(name) === 'system').length,
        relative: references.filter(name => classifyReference(name) === 'relative').length, external, rpaths: commands?.rpaths || [] } });
  }
  for (const row of details.filter(item => item.unjustifiedEntitlements.length)) {
    add('REVIEW', 'ENTITLEMENT_BROADER_THAN_ROLE', { file: row.file, role: row.role, keys: row.unjustifiedEntitlements });
  }
  if (plannedKeys.inherit.some(key => key.startsWith('com.apple.security.network.')) && !plannedKeys.inherit.includes('com.apple.security.app-sandbox'))
    add('REVIEW', 'SANDBOX_ONLY_ENTITLEMENTS_WITHOUT_SANDBOX', { keys: plannedKeys.inherit.filter(key => key.startsWith('com.apple.security.network.')) });
  if (!plannedKeys.inherit.includes('com.apple.security.cs.allow-dyld-environment-variables'))
    add('INFO', 'DYLD_ENVIRONMENT_IGNORED_UNDER_HARDENED_RUNTIME', { note: 'DYLD_LIBRARY_PATH set by main.cjs for PostgreSQL/Redis is ignored; libraries must resolve via @rpath/@loader_path' });

  // Nested archives: each Mach-O member would be reported unsigned by the notary service.
  const archiveScan = { archives: 0, entries: 0, machO: [], nativeNamed: [], unsupported: [] };
  for (const item of archives) {
    if (item.size > ZIP_LIMITS.archiveBytes) { archiveScan.unsupported.push({ archive: rel(item.file), code: 'ZIP_ARCHIVE_LIMIT' }); continue; }
    scanArchive(fs.readFileSync(item.file), rel(item.file), 0, archiveScan);
  }
  for (const member of archiveScan.machO) add('NOTARY_BLOCKER', 'MACHO_INSIDE_ARCHIVE', { member: member.member });
  for (const item of archiveScan.unsupported) add('REVIEW', 'ARCHIVE_NOT_SCANNED', item);

  const frameworkBinary = path.join(contents, 'Frameworks/Electron Framework.framework/Versions/A/Electron Framework');
  const fuses = fs.existsSync(frameworkBinary) ? readFuses(frameworkBinary) : null;
  if (fuses?.fuses.RunAsNode === 'ENABLE') add('REVIEW', 'ELECTRON_RUN_AS_NODE_FUSE_ENABLED', { note: 'required by the bundled TypeScript analyzer launch (ELECTRON_RUN_AS_NODE=1); G-SEC decision' });
  if (fuses && fuses.fuses.EnableEmbeddedAsarIntegrityValidation !== 'ENABLE') add('REVIEW', 'ASAR_INTEGRITY_FUSE_NOT_ENABLED');
  for (const name of ['EnableNodeOptionsEnvironmentVariable', 'EnableNodeCliInspectArguments']) {
    // Default-on fuses let any launcher inject code into the signed process; the Playwright
    // validation runners currently rely on the inspector, so flipping needs a runner change.
    if (fuses?.fuses[name] === 'ENABLE') add('REVIEW', 'ELECTRON_CODE_INJECTION_FUSE_ENABLED', { fuse: name });
  }
  for (const row of details.filter(item => item.type === 'EXECUTE' && item.entitlementsMatchPlan === false)) {
    add('REVIEW', 'ENTITLEMENTS_DIFFER_FROM_PLAN', { file: row.file, actual: row.entitlements, planned: row.plannedEntitlements });
  }
  if (fs.existsSync(path.join(contents, 'Resources/default_app.asar'))) add('REVIEW', 'ELECTRON_DEFAULT_APP_SHIPPED', { file: 'Contents/Resources/default_app.asar' });
  const updaterFrameworks = ['Squirrel', 'Mantle', 'ReactiveObjC'].filter(name => fs.existsSync(path.join(contents, `Frameworks/${name}.framework`)));
  if (updaterFrameworks.length) add('REVIEW', 'UNUSED_UPDATER_FRAMEWORKS_SIGNED', { frameworks: updaterFrameworks });
  const xattrs = xattrInventory(realApp);
  for (const name of Object.keys(xattrs)) {
    if (['com.apple.FinderInfo', 'com.apple.ResourceFork', 'com.apple.quarantine'].includes(name)) add('NOTARY_BLOCKER', 'DETRITUS_XATTR', { name, count: xattrs[name] });
    else if (!name.startsWith('com.apple.cs.')) add('REVIEW', 'UNEXPECTED_XATTR', { name, count: xattrs[name] });
  }
  const verify = tool('/usr/bin/codesign', ['--verify', '--deep', '--strict', realApp], { allowFailure: true });
  if (verify.status !== 0) add('NOTARY_BLOCKER', 'CODESIGN_VERIFY_FAILED');

  const classified = classifyFindings(findings, { expectTeamId });
  const count = severity => classified.filter(item => item.severity === severity).length;
  const blocking = ['NOTARY_BLOCKER', 'DEPLOYMENT_BLOCKER', 'RELEASE_BLOCKER'].some(severity => count(severity) > 0);
  const minos = details.map(row => row.minos).filter(Boolean).sort(compareVersion);
  return {
    format: 1, scope: 'read-only-signing-readiness', signingPerformed: false, notarizationContacted: false,
    app: realApp, expectTeamId, declaredMinimumSystemVersion: declared,
    bundle: { identifier: plistValue(path.join(contents, 'Info.plist'), 'CFBundleIdentifier'),
      version: plistValue(path.join(contents, 'Info.plist'), 'CFBundleShortVersionString'), buildSequence: manifest.buildSequence },
    counts: { files: inventory.files.length, directories: inventory.directories.length, symlinks: links.length, machO: machO.length,
      runtimePlan: runtimePlan.length, outerPlan: outerPlan.length, outerNonMachOTargets: outerNonMachO.length,
      archives: archiveScan.archives, archiveEntries: archiveScan.entries, archiveMachO: archiveScan.machO.length,
      archiveNativeNamed: archiveScan.nativeNamed.length },
    plan: { order: order.map(item => ({ file: rel(item.file) || '.', signer: item.signer })), insideOut: !findings.some(item => item.code === 'SIGNING_ORDER_OUTSIDE_IN'),
      outerPlanComputed: walkable,
      coverage: walkable ? machO.length - findings.filter(item => item.code === 'MACHO_NOT_IN_SIGNING_PLAN').length : null, entitlementFiles, plannedKeys,
      outerNonMachOSample: outerNonMachO.slice(0, 20).map(rel) },
    deployment: { declared, highestMinos: minos.at(-1) || null, lowestMinos: minos[0] || null,
      byMinos: minos.reduce((map, value) => ({ ...map, [value]: (map[value] || 0) + 1 }), {}) },
    fuses, xattrs, links, archiveScan: { ...archiveScan, nativeNamed: archiveScan.nativeNamed.slice(0, 50) }, machO: details,
    findings: classified, summary: Object.fromEntries(SEVERITIES.map(severity => [severity, count(severity)])),
    status: blocking ? 'BLOCKED' : expectTeamId ? 'READY_FOR_NOTARIZATION_SUBMISSION' : 'READY_FOR_DEVELOPER_ID_SIGNING_PASS',
  };
}

function argumentsFor(argv) {
  const options = { app: null, expectTeamId: null };
  for (let i = 0; i < argv.length; i += 2) {
    if (argv[i] === '--app') options.app = argv[i + 1];
    else if (argv[i] === '--expect-team-id') options.expectTeamId = argv[i + 1];
    else fail('USAGE');
  }
  assert(typeof options.app === 'string' && path.isAbsolute(options.app) && options.app.endsWith('.app'), 'USAGE');
  if (options.expectTeamId !== null) assert.match(options.expectTeamId, /^[A-Z0-9]{10}$/, 'TEAM_ID_FORMAT');
  return options;
}

async function main(argv = process.argv.slice(2)) {
  assert.equal(process.platform, 'darwin');
  const options = argumentsFor(argv);
  const repo = fs.realpathSync(path.resolve(__dirname, '../..'));
  const { ensureOutputParent, assertOutputPath } = require('./owned-output.cjs');
  process.umask(0o077);
  const evidence = fs.mkdtempSync(path.join(ensureOutputParent(repo, 'validation/local/native-update-readiness'), 'signing-'));
  const report = await inspectBundle(options.app, { expectTeamId: options.expectTeamId, repo });
  report.evidence = path.relative(repo, evidence); report.observedAt = new Date().toISOString();
  report.inspectorSha256 = crypto.createHash('sha256').update(fs.readFileSync(__filename)).digest('hex');
  const file = assertOutputPath(evidence, path.join(evidence, 'report.json'));
  fs.writeFileSync(file, JSON.stringify(report, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
  console.log(JSON.stringify({ status: report.status, evidence: report.evidence, summary: report.summary, counts: report.counts,
    deployment: report.deployment, insideOut: report.plan.insideOut }));
  if (report.status === 'BLOCKED') process.exitCode = 1;
  return report;
}

module.exports = { machOKind, compareVersion, parseCodesignDisplay, parseEntitlementsXml, parseBuildVersion, fileType,
  classifyReference, roleFor, zipEntries, scanArchive, readFuses, plannedEntitlementFile, builderIgnored,
  signingOrderFindings, coverageFindings, classifyFindings, inspectBundle, argumentsFor, runtimeSigningTargets, ENTITLEMENT_NEEDS, main };
if (require.main === module) main().catch(error => { console.error(error.code || error.message); process.exitCode = 1; });
