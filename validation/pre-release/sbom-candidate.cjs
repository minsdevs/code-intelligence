'use strict';

// Offline CycloneDX 1.5 SBOM, file attribution, Mach-O closure, provenance and
// licence-obligation evidence for one retained candidate bundle. Usage from the
// repository root that contains the candidate:
//   node validation/pre-release/sbom-candidate.cjs --offline \
//     --app '<repo>/.native-product-ID/Code Intelligence Validation.app' \
//     --resolved-maven runtime-resolved-ID.json \
//     [--gradle-cache ~/.gradle/caches/modules-2/files-2.1] \
//     [--electron-zip '<cache>/electron-vX-darwin-arm64.zip'] [--otool-cross-check]
// Bytes are read and hashed only. Archives are parsed in memory and never
// extracted; no candidate code, install script, database, profile or key store
// is used and no network request is made. /usr/bin/otool (static reader) is run
// only with --otool-cross-check. Output is a new private directory under
// validation/local/sbom/.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');
const inventory = require('./inventory-candidate.cjs');
const macho = require('./sbom-macho.cjs');
const maven = require('./sbom-maven.cjs');
const zip = require('./sbom-zip.cjs');
const licence = require('./licence-obligations.cjs');
const { ensureOutputParent } = require('./owned-output.cjs');

const MiB = 1024 * 1024;
const LIMITS = Object.freeze({ files: 20000, bundleBytes: 2 * 1024 ** 3, fileBytes: 512 * MiB, capture: 4 * MiB,
  nestedJars: 512, outputBytes: 64 * MiB, occurrences: 25 });
const TOOL = 'sbom-candidate.cjs';
const sha256 = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
class SbomError extends Error { constructor(code, detail) { super(code); this.code = code; this.detail = detail; } }
const need = (ok, code, detail) => { if (!ok) throw new SbomError(code, detail); };
const LICENCE_FILE = /^(?:licen[cs]e|copying|copyright|unlicense|copyrightnotice|notice|thirdpartynotices?|third-party-notices|legal)(?:[._-][A-Za-z0-9._-]*)?$/i;
const NOTICE_FILE = /^(?:notice|thirdpartynotices?|third-party-notices)(?:[._-][A-Za-z0-9._-]*)?$/i;

// ---------------------------------------------------------------- arguments
function argumentsFor(argv) {
  const result = { otool: false };
  need(Array.isArray(argv), 'ARGUMENTS');
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    if (flag === '--offline') { need(!result.offline, 'ARGUMENTS'); result.offline = true; continue; }
    if (flag === '--otool-cross-check') { need(!result.otool, 'ARGUMENTS'); result.otool = true; continue; }
    const key = { '--app': 'app', '--resolved-maven': 'resolved', '--gradle-cache': 'gradleCache', '--electron-zip': 'electronZip' }[flag];
    need(key && !Object.hasOwn(result, key) && typeof argv[i + 1] === 'string', 'ARGUMENTS');
    result[key] = argv[++i];
  }
  need(result.offline && typeof result.app === 'string' && path.isAbsolute(result.app)
    && typeof result.resolved === 'string' && /^[A-Za-z0-9][A-Za-z0-9._-]{0,79}\.json$/.test(result.resolved), 'ARGUMENTS');
  for (const key of ['gradleCache', 'electronZip']) need(result[key] === undefined || path.isAbsolute(result[key]), 'ARGUMENTS');
  return result;
}

// ---------------------------------------------------------------- bundle walk
function readRegular(file, maximum) {
  const before = fs.lstatSync(file, { bigint: true });
  need(before.isFile() && !before.isSymbolicLink() && before.nlink === 1n && before.size <= BigInt(maximum), 'FILE_UNSAFE_OR_LIMIT', file);
  const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  try {
    const size = Number(before.size), data = Buffer.alloc(size); let count = 0;
    while (count < size) { const n = fs.readSync(fd, data, count, size - count, count); if (!n) break; count += n; }
    const after = fs.fstatSync(fd, { bigint: true });
    need(count === size && after.size === before.size && after.mtimeNs === before.mtimeNs && after.ino === before.ino, 'INPUT_CHANGED', file);
    return data;
  } finally { fs.closeSync(fd); }
}

function walkBundle(appRoot) {
  need(path.isAbsolute(appRoot) && fs.realpathSync(appRoot) === appRoot, 'APP_PATH');
  const entries = []; let files = 0, bytes = 0;
  const visit = (rel, depth) => {
    need(depth <= 64, 'BUNDLE_DEPTH');
    const abs = rel ? path.join(appRoot, rel) : appRoot, stat = fs.lstatSync(abs);
    if (stat.isSymbolicLink()) {
      const target = fs.readlinkSync(abs), resolved = path.posix.normalize(path.posix.join(path.posix.dirname(rel), target));
      entries.push({ rel, type: 'symlink', target, resolved,
        inside: !path.posix.isAbsolute(target) && resolved !== '..' && !resolved.startsWith('../') });
      return;
    }
    if (stat.isDirectory()) {
      if (rel) entries.push({ rel, type: 'dir' });
      for (const name of fs.readdirSync(abs).sort()) visit(rel ? `${rel}/${name}` : name, depth + 1);
      return;
    }
    need(stat.isFile() && stat.nlink === 1 && ++files <= LIMITS.files, 'BUNDLE_ENTRY', rel);
    bytes += stat.size; need(bytes <= LIMITS.bundleBytes, 'BUNDLE_LIMIT');
    entries.push({ rel, type: 'file', size: stat.size, mode: stat.mode & 0o7777 });
  };
  visit('', 0);
  return entries;
}
function treeDigest(rows) {
  const lines = rows.map(row => `${row.sha256}  ${row.location}\n`).sort();
  return sha256(lines.join(''));
}

// ---------------------------------------------------------------- plist / strings
function plistStrings(text) {
  const values = {};
  for (const match of String(text).matchAll(/<key>([^<]{1,128})<\/key>\s*<string>([^<]{0,512})<\/string>/g)) values[match[1]] = match[2];
  return values;
}
function uniqueWitness(bytes, expression) {
  const found = new Map();
  for (const match of bytes.toString('latin1').matchAll(expression)) found.set(match[1], (found.get(match[1]) || 0) + 1);
  const ranked = [...found.entries()].sort((a, b) => b[1] - a[1]);
  return { value: ranked.length && (ranked.length === 1 || ranked[0][1] > ranked[1][1]) ? ranked[0][0] : null,
    candidates: Object.fromEntries(ranked.slice(0, 5)) };
}

// ---------------------------------------------------------------- npm helpers
// Package root of a path below node_modules, e.g. a/node_modules/@s/p/x -> a/node_modules/@s/p
function npmRoot(rel) {
  const parts = rel.split('/'); let root = null;
  for (let i = 0; i < parts.length - 1; i++) {
    if (parts[i] !== 'node_modules') continue;
    if (parts[i + 1]?.startsWith('@') && parts[i + 2] !== undefined && i + 2 < parts.length - 1) root = parts.slice(0, i + 3).join('/');
    else if (parts[i + 1] && !parts[i + 1].startsWith('@') && i + 1 < parts.length - 1) root = parts.slice(0, i + 2).join('/');
  }
  return root;
}
function npmExpression(manifest) {
  if (typeof manifest.license === 'string') return manifest.license.replace(/^\((.*)\)$/, '$1').trim() ? manifest.license : null;
  if (manifest.license && typeof manifest.license.type === 'string') return manifest.license.type;
  if (Array.isArray(manifest.licenses)) {
    const types = manifest.licenses.map(item => (typeof item === 'string' ? item : item?.type)).filter(value => typeof value === 'string');
    return types.length ? types.join(' OR ') : null;
  }
  return null;
}
const purlNpm = (name, version) => `pkg:npm/${name.startsWith('@') ? '%40' + name.slice(1) : name}@${version}`;

// ---------------------------------------------------------------- attribution rules
const PG_BIN = /^(?:postgres|initdb|pg_isready|psql|createdb|pg_dump|pg_restore)$/;
// PostgreSQL 16 server modules, client libraries and encoding conversion procs.
const PG_LIB = /^(?:lib(?:pq|ecpg|ecpg_compat|pgtypes|pgcommon(?:_shlib)?|pgport(?:_shlib)?|pgfeutils)(?:\.[0-9]+)?\.(?:dylib|a)|libpqwalreceiver\.dylib|pgoutput\.dylib|plpgsql\.dylib|pg_trgm\.dylib|dict_snowball\.dylib|(?:[a-z0-9_]+_and_[a-z0-9_]+|euc2004_sjis2004)\.dylib)$/;
// ADR-01 xpc-required candidates: the adapter supervisor service carries a second copy of the app's
// Electron (its Node worker) and the TypeScript analyzer, which no longer ships in the runtime.
const ADAPTER_SERVICE = 'Contents/XPCServices/AdapterSupervisor.xpc/';
function attributeFile(rel) {
  const R = 'Contents/Resources/', RT = R + 'runtime/';
  if (rel === 'Contents/MacOS/adapter-bridge') return 'first-party:adapter-supervisor';
  if (rel.startsWith(ADAPTER_SERVICE)) {
    const inner = rel.slice(ADAPTER_SERVICE.length);
    if (inner === 'Contents/Info.plist' || /(?:^|\/)_CodeSignature\/CodeResources$/.test(inner)) return 'first-party:packaging';
    if (inner === 'Contents/MacOS/AdapterSupervisor') return 'first-party:adapter-supervisor';
    if (inner === 'Contents/MacOS/adapter-node') return 'electron';
    if (/^Contents\/Frameworks\/(?:Electron Framework|Mantle|ReactiveObjC|Squirrel)\.framework\//.test(inner)) return attributeFile(inner);
    if (inner.startsWith('Contents/Resources/ts-analyzer/')) return attributeFile(RT + inner.slice('Contents/Resources/'.length));
    return null;
  }
  if (rel === 'Contents/Info.plist' || rel === 'Contents/PkgInfo') return 'first-party:packaging';
  if (/^Contents(?:\/Frameworks\/[^/]+\.app\/Contents)?\/_CodeSignature\/CodeResources$/.test(rel)) return 'first-party:packaging';
  if (/\/_CodeSignature\/CodeResources$/.test(rel) && rel.startsWith('Contents/Frameworks/')) return 'first-party:packaging';
  if (rel === 'Contents/MacOS/Code Intelligence Validation' || rel === 'Contents/MacOS/Code Intelligence') return 'electron';
  if (rel === R + 'default_app.asar' || rel === R + 'electron.icns') return 'electron';
  if (rel.startsWith(R + 'legal/electron/')) return 'electron';
  if (rel.startsWith(R + 'legal/third-party/')) return 'first-party:packaging';
  if (rel === R + 'app.asar') return 'container:app.asar';
  if (rel.startsWith(R + 'app.asar.unpacked/')) return 'asar-unpacked';
  if (rel.startsWith('Contents/Frameworks/')) {
    const f = rel.slice('Contents/Frameworks/'.length);
    if (f.startsWith('Squirrel.framework/')) return 'squirrel-mac';
    if (f.startsWith('Mantle.framework/')) return 'mantle';
    if (f.startsWith('ReactiveObjC.framework/')) return 'reactiveobjc';
    if (f.startsWith('Electron Framework.framework/')) {
      if (/\/Libraries\/libffmpeg\.dylib$/.test(f)) return 'ffmpeg';
      if (/\/Libraries\/(?:libvk_swiftshader\.dylib|vk_swiftshader_icd\.json)$/.test(f)) return 'swiftshader';
      if (/\/Helpers\/chrome_crashpad_handler$/.test(f)) return 'crashpad';
      return 'electron';
    }
    if (/^[^/]+ Helper(?: \((?:GPU|Plugin|Renderer)\))?\.app\/Contents\/(?:MacOS\/[^/]+|Info\.plist|PkgInfo)$/.test(f)) return 'electron';
    return null;
  }
  if (!rel.startsWith(RT)) return null;
  const r = rel.slice(RT.length);
  if (r === 'runtime-manifest.json') return 'first-party:packaging';
  if (r === 'backend/code-intelligence.jar') return 'container:backend.jar';
  if (r === 'backend/code-intelligence-control.jar') return 'container:control.jar';
  if (r === 'backend/code-intelligence-control-provenance.json') return 'first-party:backend';
  if (/^backend\/backup-migrations\/V[0-9]+__[A-Za-z0-9_]+\.sql$/.test(r)) return 'first-party:backend';
  if (r.startsWith('jre/')) return 'temurin-jre';
  if (r === 'redis/bin/redis-server') return 'redis';
  if (/^(?:postgres|redis)\/lib\/lib(?:ssl|crypto)\.3\.dylib$/.test(r)) return 'openssl';
  if (r === 'postgres/lib/vector.dylib' || /^postgres\/share\/extension\/vector(?:--[0-9.]+(?:--[0-9.]+)?\.sql|\.control)$/.test(r)) return 'pgvector';
  if (r.startsWith('postgres/share/code-intelligence-notices/')) return 'first-party:packaging';
  if (r.startsWith('postgres/share/timezone/')) return 'iana-tzdata';
  if (r.startsWith('postgres/bin/')) return PG_BIN.test(r.slice('postgres/bin/'.length)) ? 'postgresql' : null;
  if (r.startsWith('postgres/lib/pgxs/') || r.startsWith('postgres/lib/pkgconfig/')) return 'postgresql';
  if (r.startsWith('postgres/lib/')) return PG_LIB.test(r.slice('postgres/lib/'.length)) ? 'postgresql' : null;
  if (r.startsWith('postgres/share/') || r.startsWith('postgres/include/')) return 'postgresql';
  // npm's hidden lockfile is install metadata written by the first-party build.
  if (r === 'ts-analyzer/node_modules/.package-lock.json') return 'first-party:ts-analyzer';
  if (r.startsWith('ts-analyzer/node_modules/')) return 'analyzer-npm';
  if (/^ts-analyzer\/(?:dist\/.+|package\.json|package-lock\.json)$/.test(r)) return 'first-party:ts-analyzer';
  return null;
}
function attributeBackendMember(name) {
  if (/^BOOT-INF\/lib\/[^/]+\.jar$/.test(name)) return 'nested-jar';
  if (name.startsWith('BOOT-INF/classes/static/')) return 'first-party:frontend';
  if (name.startsWith('BOOT-INF/classes/')) return 'first-party:backend';
  if (name.startsWith('org/springframework/boot/loader/') || name === 'META-INF/services/java.nio.file.spi.FileSystemProvider') return 'spring-boot-loader';
  if (['META-INF/MANIFEST.MF', 'META-INF/BOOT.SF', 'BOOT-INF/classpath.idx', 'BOOT-INF/layers.idx'].includes(name)) return 'first-party:packaging';
  if (/^(?:META-INF|BOOT-INF|org|org\/springframework|org\/springframework\/boot)\/$/.test(name)) return 'first-party:packaging';
  return null;
}

// ---------------------------------------------------------------- Mach-O signature-insensitive comparison
// Ad-hoc re-signing changes LC_CODE_SIGNATURE size, __LINKEDIT size and the
// signature blob. Compare everything before the signature with those fields masked.
function codeBytesEqualIgnoringSignature(a, b) {
  const locate = bytes => {
    if (bytes.readUInt32LE(0) !== 0xfeedfacf) return null;
    const ncmds = bytes.readUInt32LE(16); let cursor = 32, signature = null; const masks = [];
    for (let i = 0; i < ncmds; i++) {
      const cmd = bytes.readUInt32LE(cursor), size = bytes.readUInt32LE(cursor + 4);
      if (cmd === 0x1d) { signature = bytes.readUInt32LE(cursor + 8); masks.push([cursor + 12, 4]); }
      if (cmd === 0x19 && bytes.subarray(cursor + 8, cursor + 24).toString('latin1').replace(/\0+$/, '') === '__LINKEDIT') {
        masks.push([cursor + 32, 8], [cursor + 48, 8]);
      }
      cursor += size;
    }
    return signature === null ? null : { signature, masks };
  };
  const x = locate(a), y = locate(b);
  if (!x || !y || x.signature !== y.signature) return false;
  const left = Buffer.from(a.subarray(0, x.signature)), right = Buffer.from(b.subarray(0, y.signature));
  for (const [at, length] of [...x.masks, ...y.masks]) { left.fill(0, at, at + length); right.fill(0, at, at + length); }
  return left.equals(right);
}

// ---------------------------------------------------------------- otool cross-check
// The command-line tools otool wrapper splits paths containing parentheses (the
// Electron helper names), so a private alias with a plain name is passed instead.
// The alias is a symlink in a fresh private temporary directory; the bundle is
// never written.
function otoolCrossCheck(file, slice) {
  const alias = fs.mkdtempSync(path.join(fs.realpathSync(require('node:os').tmpdir()), 'sbom-otool-'));
  const target = path.join(alias, 'binary');
  fs.symlinkSync(file, target);
  const run = args => execFileSync('/usr/bin/otool', [...args, target], { encoding: 'utf8', timeout: 30000, maxBuffer: 4 * MiB,
    env: { PATH: '/usr/bin:/bin', LANG: 'C', LC_ALL: 'C' }, stdio: ['ignore', 'pipe', 'pipe'] });
  try { return otoolCompare(run, slice); } finally { fs.rmSync(alias, { recursive: true, force: true }); }
}
// `run(args)` invokes otool with args followed by the binary path.
function otoolCompare(run, slice) {
  const result = { status: 'MATCH', differences: [] };
  try {
    const { parseLoadCommands } = require('../../desktop/scripts/native-runtime-policy.cjs');
    const parsed = parseLoadCommands(run(['-arch', 'arm64', '-l']));
    const ownLoads = slice.loads.map(item => item.name).concat(slice.dylinker ? [slice.dylinker] : []).sort();
    if (JSON.stringify([...parsed.dependencies].sort()) !== JSON.stringify(ownLoads)) result.differences.push('LOADS');
    if (JSON.stringify([...parsed.rpaths]) !== JSON.stringify(slice.rpaths)) result.differences.push('RPATHS');
    if (macho.compareVersions(parsed.minimum, slice.minos) !== 0) result.differences.push('MINOS');
    if ((parsed.installName || null) !== slice.installName) result.differences.push('INSTALL_NAME');
    const listed = run(['-arch', 'arm64', '-L']).split('\n').slice(1)
      .map(line => /^\t(.+) \(compatibility version [^)]*\)$/.exec(line)?.[1]).filter(Boolean);
    const expected = new Set([...slice.loads.map(item => item.name), ...(slice.installName ? [slice.installName] : [])]);
    if (listed.length !== expected.size || listed.some(name => !expected.has(name))) result.differences.push('OTOOL_L');
    result.otoolL = listed.length;
  } catch (error) { result.status = 'OTOOL_FAILED'; result.error = error.code || error.name; return result; }
  if (result.differences.length) result.status = 'MISMATCH';
  return result;
}

// ---------------------------------------------------------------- main analysis
async function analyse({ repo, appRelative, resolvedMaven, gradleCache, electronZip, otool, readers }) {
  const appRoot = path.join(repo, appRelative);
  const entries = walkBundle(appRoot);
  const files = entries.filter(item => item.type === 'file'), symlinks = entries.filter(item => item.type === 'symlink');
  const fileSet = new Set(files.map(item => item.rel));
  const existsInBundle = rel => fileSet.has(rel) || symlinks.some(item => item.rel === rel)
    || entries.some(item => item.type === 'dir' && item.rel === rel);
  const attribution = [], held = new Map(), machos = [], staticArchives = [];
  const keep = rel => /\/(?:Info\.plist|release|runtime-manifest\.json|code-intelligence-control-provenance\.json|source-lock\.json|package\.json|package-lock\.json)$/.test('/' + rel)
    || LICENCE_FILE.test(path.posix.basename(rel)) || rel.includes('/jre/legal/') || rel.includes('/code-intelligence-notices/')
    || rel.includes('/legal/') || /\.(?:asar|jar)$/.test(rel) || /\/Electron Framework$/.test(rel) || /\/(?:redis-server|postgres|libcrypto\.3\.dylib|vector\.control|libjvm\.dylib)$/.test(rel);
  for (const item of files) {
    const data = readRegular(path.join(appRoot, item.rel), LIMITS.fileBytes);
    item.sha256 = sha256(data);
    if (data.length >= 8 && data.subarray(0, 8).toString('latin1') === '!<arch>\n') staticArchives.push(item.rel);
    if (macho.machOKind(data)) {
      let parsed; try { parsed = macho.parseMachO(data); } catch (error) { parsed = { error: error.code || 'MACHO_PARSE' }; }
      machos.push({ rel: item.rel, sha256: item.sha256, parsed });
    }
    if (keep(item.rel)) held.set(item.rel, data);
    attribution.push({ location: item.rel, component: attributeFile(item.rel), sha256: item.sha256, bytes: item.size });
  }
  const resources = 'Contents/Resources/', runtime = resources + 'runtime/';
  const bytesOf = rel => held.get(rel) || readRegular(path.join(appRoot, rel), LIMITS.fileBytes);
  const components = new Map();
  const component = (ref, base) => { if (!components.has(ref)) components.set(ref, { ref, files: [], noticeEvidence: [], properties: {}, ...base }); return components.get(ref); };

  // ---- runtime manifest re-verification (candidate integrity record, not provenance)
  const manifest = JSON.parse(bytesOf(runtime + 'runtime-manifest.json').toString('utf8'));
  const runtimeFiles = files.filter(item => item.rel.startsWith(runtime) && item.rel !== runtime + 'runtime-manifest.json');
  const manifestCheck = { declared: Object.keys(manifest.files).length, present: runtimeFiles.length, mismatched: [], missing: [], undeclared: [] };
  for (const item of runtimeFiles) {
    const name = item.rel.slice(runtime.length);
    if (!Object.hasOwn(manifest.files, name)) manifestCheck.undeclared.push(name);
    else if (manifest.files[name] !== item.sha256) manifestCheck.mismatched.push(name);
  }
  for (const name of Object.keys(manifest.files)) if (!fileSet.has(runtime + name)) manifestCheck.missing.push(name);
  manifestCheck.status = manifestCheck.mismatched.length || manifestCheck.missing.length || manifestCheck.undeclared.length ? 'FAIL' : 'PASS';

  // ---- first-party and fixed components
  const appPlist = plistStrings(bytesOf('Contents/Info.plist'));
  const product = { name: appPlist.CFBundleName || 'Code Intelligence Validation', version: appPlist.CFBundleShortVersionString || null,
    bundleId: appPlist.CFBundleIdentifier || null, minimumSystemVersion: appPlist.LSMinimumSystemVersion || null };
  for (const [ref, name] of [['first-party:packaging', 'code-intelligence packaging metadata'], ['first-party:desktop', 'code-intelligence-desktop'],
    ['first-party:backend', 'code-intelligence-backend'], ['first-party:frontend', 'code-intelligence-frontend bundle'], ['first-party:ts-analyzer', 'ts-analyzer'],
    ['first-party:control', 'code-intelligence-control'], ['first-party:adapter-supervisor', 'code-intelligence adapter supervisor and bridge']]) {
    component(ref, { kind: 'first-party', type: 'application', name, version: product.version, expression: 'MIT', firstParty: true });
  }

  // ---- Electron family
  const frameworkRel = 'Contents/Frameworks/Electron Framework.framework/Versions/A/';
  const frameworkPlist = plistStrings(bytesOf(frameworkRel + 'Resources/Info.plist'));
  const frameworkBinary = bytesOf(frameworkRel + 'Electron Framework');
  const witnesses = { chromium: uniqueWitness(frameworkBinary, /Chrome\/([0-9]+\.[0-9]+\.[0-9]+\.[0-9]+)/g),
    v8: uniqueWitness(frameworkBinary, /\b([0-9]+\.[0-9]+\.[0-9]+\.[0-9]+)-electron\.[0-9]+\b/g),
    node: uniqueWitness(frameworkBinary, /\bv(2[0-9]\.[0-9]+\.[0-9]+)\b/g),
    electronUserAgent: uniqueWitness(frameworkBinary, /Electron\/([0-9]+\.[0-9]+\.[0-9]+)/g) };
  const electronVersion = frameworkPlist.CFBundleVersion || null;
  const lockElectron = readers.desktopLock.packages?.['node_modules/electron']?.version || null;
  const electronLicenceFiles = ['legal/electron/LICENSE', 'legal/electron/LICENSES.chromium.html'].filter(name => fileSet.has(resources + name));
  const electronNotice = electronLicenceFiles.length === 2 ? [{ kind: 'LICENCE', visibility: 'BUNDLE_LEGAL', location: resources + 'legal/electron/' }] : [];
  const workerPlist = ADAPTER_SERVICE + 'Contents/Frameworks/Electron Framework.framework/Versions/A/Resources/Info.plist';
  const adapterWorkerCopy = fileSet.has(workerPlist)
    ? { location: ADAPTER_SERVICE + 'Contents/Frameworks/Electron Framework.framework/', version: plistStrings(bytesOf(workerPlist)).CFBundleVersion || null }
    : null;
  component('electron', { kind: 'electron', type: 'framework', name: 'electron', version: electronVersion, policy: 'electron',
    purl: electronVersion && `pkg:generic/electron@${electronVersion}?download_url=https://github.com/electron/electron/releases/download/v${electronVersion}/electron-v${electronVersion}-darwin-arm64.zip`,
    noticeEvidence: electronNotice, properties: { checkoutLockVersion: lockElectron, userAgentWitness: witnesses.electronUserAgent.value,
      ...(adapterWorkerCopy ? { adapterWorkerCopy } : {}) } });
  // The worker copy is attributed to the app's Electron components only when it is the same release.
  if (adapterWorkerCopy && adapterWorkerCopy.version !== electronVersion) {
    for (const row of attribution) {
      if (row.location === ADAPTER_SERVICE + 'Contents/MacOS/adapter-node' || row.location.startsWith(ADAPTER_SERVICE + 'Contents/Frameworks/')) {
        if (row.component !== 'first-party:packaging') row.component = null;
      }
    }
  }
  for (const [ref, name, version, policy] of [['chromium', 'chromium', witnesses.chromium.value, 'chromium'], ['v8', 'v8', witnesses.v8.value, 'chromium'],
    ['nodejs', 'node.js (embedded in Electron)', witnesses.node.value, 'chromium'], ['ffmpeg', 'ffmpeg (Chromium build)', null, 'ffmpeg'],
    ['swiftshader', 'swiftshader', null, 'swiftshader'], ['crashpad', 'crashpad', null, 'crashpad'], ['squirrel-mac', 'Squirrel.Mac', null, 'squirrel-mac'],
    ['mantle', 'Mantle', null, 'mantle'], ['reactiveobjc', 'ReactiveObjC', null, 'reactiveobjc']]) {
    const notices = ['mantle', 'reactiveobjc'].includes(ref) ? [] : electronLicenceFiles.includes('legal/electron/LICENSES.chromium.html')
      ? [{ kind: 'LICENCE', visibility: 'BUNDLE_LEGAL', location: resources + 'legal/electron/LICENSES.chromium.html' }] : [];
    component(ref, { kind: 'electron-part', type: ref === 'nodejs' || ref === 'v8' || ref === 'chromium' ? 'framework' : 'library', name, version,
      policy, parent: 'electron', noticeEvidence: notices, properties: ref === 'chromium' || ref === 'v8' || ref === 'nodejs'
        ? { versionSource: 'string witness in Electron Framework binary', candidates: witnesses[ref === 'nodejs' ? 'node' : ref].candidates } : {} });
  }

  // ---- JRE
  const release = bytesOf(runtime + 'jre/release').toString('utf8');
  const javaVersion = /^JAVA_VERSION="([^"]+)"$/m.exec(release)?.[1] || null;
  const modules = (/^MODULES="([^"]*)"$/m.exec(release)?.[1] || '').split(' ').filter(Boolean);
  const jvm = bytesOf(runtime + 'jre/lib/server/libjvm.dylib');
  // Every OpenJDK libjvm carries "Oracle Corporation" as java.vm.specification.vendor,
  // so only distributor names count; an Oracle-built JDK therefore stays unidentified.
  const vendor = uniqueWitness(jvm, /(Eclipse Adoptium|Azul Systems, Inc\.|Amazon\.com Inc\.|Microsoft|BellSoft)/g);
  const build = uniqueWitness(jvm, /\b(21\.[0-9]+\.[0-9]+\+[0-9]+(?:-LTS)?)\b/g);
  const legalFiles = files.filter(item => item.rel.startsWith(runtime + 'jre/legal/'));
  const thirdPartyMd = [...new Set(legalFiles.filter(item => item.rel.endsWith('.md')).map(item => path.posix.basename(item.rel, '.md')))].sort();
  component('temurin-jre', { kind: 'jre', type: 'platform', name: 'eclipse-temurin-jre (jlink image)', version: build.value || javaVersion, policy: 'temurin-jre',
    purl: `pkg:generic/eclipse-temurin@${encodeURIComponent(build.value || javaVersion)}?arch=aarch64&os=mac`,
    noticeEvidence: legalFiles.some(item => item.rel.endsWith('/LICENSE')) ? [{ kind: 'LICENCE', visibility: 'BUNDLE_LEGAL', location: runtime + 'jre/legal/' }] : [],
    properties: { javaVersion, vendorWitness: vendor.value, vendorCandidates: vendor.candidates, buildWitness: build.value, modules,
      legalFiles: legalFiles.length, embeddedThirdPartyNotices: thirdPartyMd },
    // macos-runtime-supply.json locks only the four C sources; the JDK used by jlink has no URL/digest record.
    provenance: { recordedSourceUrl: null, recordedSha256: null, status: 'NO_REPOSITORY_SUPPLY_RECORD' } });

  // ---- Native runtimes from the source lock
  const sourceLockRel = runtime + 'postgres/share/code-intelligence-notices/source-lock.json';
  const sourceLock = JSON.parse(bytesOf(sourceLockRel).toString('utf8'));
  const repoSupply = readers.supply;
  const nativeNames = { postgres: 'postgresql', redis: 'redis', openssl: 'openssl', pgvector: 'pgvector' };
  const binaryWitness = {
    postgresql: uniqueWitness(bytesOf(runtime + 'postgres/bin/postgres'), /PostgreSQL ([0-9]+\.[0-9]+)/g),
    // The bare-version pattern also hits command-history strings ("8.6.0" ...); the
    // REDIS_VERSION constant name precedes the server's own version string.
    redis: uniqueWitness(bytesOf(runtime + 'redis/bin/redis-server'), /REDIS_VERSION\0([0-9]+\.[0-9]+\.[0-9]+)\0/g),
    openssl: uniqueWitness(bytesOf(runtime + 'postgres/lib/libcrypto.3.dylib'), /OpenSSL ([0-9]+\.[0-9]+\.[0-9]+)/g),
    pgvector: { value: /default_version\s*=\s*'([0-9.]+)'/.exec(bytesOf(runtime + 'postgres/share/extension/vector.control').toString('utf8'))?.[1] || null, candidates: {} },
  };
  for (const item of sourceLock.sources) {
    const ref = nativeNames[item.id]; need(ref, 'NATIVE_SOURCE_UNKNOWN', item.id);
    const recorded = repoSupply.sources.find(entry => entry.id === item.id);
    const noticeRel = `${runtime}postgres/share/code-intelligence-notices/${item.id}-${item.version}-${item.licenseFile}`;
    component(ref, { kind: 'native-runtime', type: 'application', name: ref, version: item.version, policy: ref,
      purl: ref === 'pgvector' ? `pkg:github/pgvector/pgvector@v${item.version}` : `pkg:generic/${ref}@${item.version}?download_url=${encodeURIComponent(item.url)}`,
      noticeEvidence: fileSet.has(noticeRel) ? [{ kind: 'LICENCE', visibility: 'BUNDLE_LEGAL', location: noticeRel }] : [],
      provenance: { sourceUrl: item.url, sourceSha256: item.sha256, checksumSource: item.checksumSource, revision: item.revision || null,
        shippedLockMatchesRepository: Boolean(recorded) && JSON.stringify(recorded) === JSON.stringify(item),
        binaryVersionWitness: binaryWitness[ref].value, binaryVersionMatchesLock: binaryWitness[ref].value === item.version,
        binaryToSourceBytes: 'NOT_REPRODUCIBLE_BUILD_VERIFIED' } });
  }
  component('iana-tzdata', { kind: 'native-runtime', type: 'data', name: 'IANA time zone database (compiled by PostgreSQL)', version: null, policy: 'iana-tzdata', parent: 'postgresql' });
  // Third-party code statically compiled into the native runtimes (reviewed assertions).
  for (const item of licence.POLICY.embedded) {
    const binary = bytesOf(runtime + item.binary);
    const witness = item.witness ? new RegExp(item.witness).test(binary.toString('latin1')) : null;
    component(item.ref, { kind: 'native-embedded', type: 'library', name: item.name, version: item.version || null, expression: item.expression,
      parent: item.parent, properties: { binary: item.binary, nameStringWitness: witness === null ? 'NOT_OBSERVABLE' : witness ? 'PRESENT' : 'ABSENT',
        identification: 'REVIEWED_ASSERTION_FROM_UPSTREAM_SOURCE_LAYOUT' } });
  }

  // ---- spring boot loader
  component('spring-boot-loader', { kind: 'maven', type: 'library', group: 'org.springframework.boot', name: 'spring-boot-loader', version: null,
    policy: 'spring-boot-loader', parent: 'first-party:backend' });

  // ---- npm packages: app.asar
  const asarBytes = bytesOf(resources + 'app.asar');
  const asarEntries = inventory.parseAsar(asarBytes, readers.Pickle);
  const asarMember = entry => (entry.unpacked ? bytesOf(`${resources}app.asar.unpacked/${entry.name}`) : asarBytes.subarray(entry.start, entry.start + entry.size));
  const npmComponent = (scope, root, manifestBytes, lockFile, lockScope) => {
    const data = JSON.parse(manifestBytes.toString('utf8'));
    const key = root.replace(/^ts-analyzer\//, '');
    const locked = lockFile?.packages?.[key] || null;
    const ref = `npm:${scope}:${root}`;
    return component(ref, { kind: 'npm', type: 'library', scopeName: scope, name: data.name, version: data.version,
      purl: data.name && data.version ? purlNpm(data.name, data.version) : null, expression: npmExpression(data), declaredPrivate: data.private === true,
      provenance: { lockScope, lockVersion: locked?.version || null, lockIntegrity: locked?.integrity || null, lockResolved: locked?.resolved || null,
        lockComparison: !locked ? 'MISSING' : locked.version === data.version ? 'MATCH' : 'MISMATCH', tarballBytes: 'NOT_RECHECKED' } });
  };
  const asarRoots = new Map();
  for (const entry of asarEntries) {
    if (entry.name.endsWith('/package.json') && inventory.packageManifest(entry.name)) {
      const root = entry.name.slice(0, -'/package.json'.length);
      asarRoots.set(root, npmComponent('app.asar', root, asarMember(entry), readers.desktopLock, 'CURRENT_CHECKOUT_DESKTOP_LOCK_NOT_BUILD_ATTESTATION'));
    }
  }
  for (const entry of asarEntries) {
    const location = `${resources}app.asar!/${entry.name}`, bytes = asarMember(entry), digest = sha256(bytes);
    let ref = null;
    if (entry.name === 'package.json' || entry.name.startsWith('src/')) ref = 'first-party:desktop';
    else { const root = npmRoot(entry.name); if (root && asarRoots.has(root)) ref = asarRoots.get(root).ref; }
    attribution.push({ location, component: ref, sha256: digest, bytes: entry.size, container: resources + 'app.asar' });
    if (ref && ref.startsWith('npm:')) {
      const comp = components.get(ref), base = path.posix.basename(entry.name);
      if (path.posix.dirname(entry.name) === npmRootDir(ref) && LICENCE_FILE.test(base)) {
        comp.noticeEvidence.push({ kind: NOTICE_FILE.test(base) ? 'NOTICE' : 'LICENCE', visibility: 'ARTEFACT', location, sha256: digest });
        if (!NOTICE_FILE.test(base) || /notice/i.test(base)) comp.licenceTexts = [...(comp.licenceTexts || []), { location, sha256: digest, text: bytes.toString('utf8') }];
      }
    }
  }
  function npmRootDir(ref) { return ref.replace(/^npm:[^:]+:/, ''); }

  // ---- npm packages: analyzer (runtime, or the adapter supervisor service of an xpc-required candidate)
  const analyzerParent = fileSet.has(runtime + 'ts-analyzer/package-lock.json') ? runtime : ADAPTER_SERVICE + 'Contents/Resources/';
  const analyzerLock = JSON.parse(bytesOf(analyzerParent + 'ts-analyzer/package-lock.json').toString('utf8'));
  const analyzerRoots = new Map();
  for (const item of files.filter(entry => entry.rel.startsWith(analyzerParent + 'ts-analyzer/node_modules/') && entry.rel.endsWith('/package.json'))) {
    const inner = item.rel.slice(analyzerParent.length);
    if (!inventory.packageManifest(inner.slice('ts-analyzer/'.length))) continue;
    const root = inner.slice(0, -'/package.json'.length);
    analyzerRoots.set(root, npmComponent('ts-analyzer', root, bytesOf(item.rel), analyzerLock, 'SHIPPED_ANALYZER_LOCK'));
  }
  for (const row of attribution) {
    if (row.component !== 'analyzer-npm') continue;
    const inner = row.location.startsWith(analyzerParent) ? row.location.slice(analyzerParent.length) : null, root = inner && npmRoot(inner);
    const comp = root && analyzerRoots.get(root);
    row.component = comp ? comp.ref : null;
    if (comp && path.posix.dirname(inner) === root && LICENCE_FILE.test(path.posix.basename(inner))) {
      const base = path.posix.basename(inner);
      comp.noticeEvidence.push({ kind: NOTICE_FILE.test(base) ? 'NOTICE' : 'LICENCE', visibility: 'ARTEFACT', location: row.location, sha256: row.sha256 });
      comp.licenceTexts = [...(comp.licenceTexts || []), { location: row.location, sha256: row.sha256, text: bytesOf(row.location).toString('utf8') }];
    }
  }

  // ---- backend JAR
  const jarRel = runtime + 'backend/code-intelligence.jar', jarBytes = bytesOf(jarRel);
  const usage = inventory.budget(), jarEntries = inventory.preflightZip(jarBytes, usage).entries;
  const resolvedByHash = new Map();
  for (const item of resolvedMaven.components) {
    if (!resolvedByHash.has(item.sha256)) resolvedByHash.set(item.sha256, []);
    resolvedByHash.get(item.sha256).push(item);
  }
  const nestedByName = new Map();
  // The Spring Boot Gradle plugin copies the loader classes and the jarmode JAR
  // from resources embedded in spring-boot-loader-tools; that cached JAR is the
  // byte reference for both when available.
  const outerManifest = inventory.zipEntryBytes(jarBytes, jarEntries.find(item => item.name === 'META-INF/MANIFEST.MF'), usage).toString('utf8');
  const bootVersion = /^Spring-Boot-Version: (.+)$/m.exec(outerManifest)?.[1]?.trim() || null;
  const loaderToolsFile = gradleCache && bootVersion ? maven.cachedFile(gradleCache, 'org.springframework.boot', 'spring-boot-loader-tools', bootVersion, 'jar')[0] : null;
  const loaderTools = loaderToolsFile ? fs.readFileSync(loaderToolsFile) : null;
  const loaderToolsMembers = loaderTools ? new Map(zip.listZip(loaderTools).filter(item => item.type === 'file').map(item => [item.name, item])) : new Map();
  const loaderToolsResource = name => (loaderToolsMembers.has(name) ? zip.readMember(loaderTools, loaderToolsMembers.get(name)) : null);
  const loaderToolsLicences = loaderTools ? maven.declaredLicences({ cacheRoot: gradleCache, groupId: 'org.springframework.boot',
    artifactId: 'spring-boot-loader-tools', version: bootVersion }) : null;
  for (const entry of jarEntries) {
    const location = `${jarRel}!/${entry.name}`;
    if (entry.directory) { attribution.push({ location, component: attributeBackendMember(entry.name) || 'first-party:packaging', sha256: null, bytes: 0, container: jarRel, directory: true }); continue; }
    const rule = attributeBackendMember(entry.name);
    if (rule !== 'nested-jar') {
      const bytes = inventory.zipEntryBytes(jarBytes, entry, usage, 64 * MiB);
      attribution.push({ location, component: rule, sha256: sha256(bytes), bytes: entry.size, container: jarRel });
      continue;
    }
    const nested = inventory.zipEntryBytes(jarBytes, entry, usage, 64 * MiB), digest = sha256(nested), fileName = path.posix.basename(entry.name);
    const matches = (resolvedByHash.get(digest) || []).filter(item => item.fileName === fileName);
    let members = [], memberError = null;
    try { members = zip.listZip(nested); } catch (error) { memberError = error.code || 'ZIP'; }
    const read = (name, maximum = MiB) => { const member = members.find(item => item.name === name && item.type === 'file'); return member ? zip.readMember(nested, member, maximum) : null; };
    const poms = members.filter(item => /^META-INF\/maven\/[^/]+\/[^/]+\/pom\.properties$/.test(item.name));
    let coordinate = matches.length === 1 ? { groupId: matches[0].groupId, artifactId: matches[0].artifactId, version: matches[0].version, source: 'RESOLVED_GRADLE_SHA256' } : null;
    if (!coordinate && poms.length === 1) {
      let fields = {};
      try { fields = inventory.javaMetadata(read(poms[0].name), 'pom'); } catch { fields = {}; }
      if (fields.groupId && fields.artifactId && fields.version) coordinate = { ...fields, source: 'NESTED_POM_PROPERTIES' };
    }
    if (!coordinate && gradleCache) coordinate = maven.findCachedByFile(gradleCache, fileName, digest, sha256);
    const jarmode = loaderToolsResource('META-INF/jarmode/spring-boot-jarmode-tools.jar');
    if (!coordinate && fileName === `spring-boot-jarmode-tools-${bootVersion}.jar` && jarmode && sha256(jarmode) === digest) {
      coordinate = { groupId: 'org.springframework.boot', artifactId: 'spring-boot-jarmode-tools', version: bootVersion,
        source: 'SPRING_BOOT_LOADER_TOOLS_EMBEDDED_RESOURCE_SHA256' };
    }
    const ref = coordinate ? `maven:${coordinate.groupId}:${coordinate.artifactId}:${coordinate.version}` : `jar:${fileName}`;
    const embeddedPomEntry = coordinate && members.find(item => item.name === `META-INF/maven/${coordinate.groupId}/${coordinate.artifactId}/pom.xml`);
    const embeddedPom = embeddedPomEntry ? zip.readMember(nested, embeddedPomEntry, 2 * MiB).toString('utf8') : null;
    let declared = coordinate ? maven.declaredLicences({ embeddedPom, cacheRoot: gradleCache, ...coordinate }) : { licences: [], source: 'NONE', chain: [] };
    if (!declared.licences.length && coordinate?.source.startsWith('SPRING_BOOT_LOADER_TOOLS') && loaderToolsLicences?.licences.length) {
      declared = { ...loaderToolsLicences, source: 'CONTAINING_ARTEFACT_POM:spring-boot-loader-tools' };
    }
    const manifestText = read('META-INF/MANIFEST.MF');
    const bundleLicense = manifestText ? /^Bundle-License: (.*(?:\r?\n .*)*)$/m.exec(manifestText.toString('utf8'))?.[1]?.replace(/\r?\n /g, '') : null;
    let { expression, unknown } = licence.expressionFromDeclarations(declared.licences);
    let licenceSource = declared.source;
    if (!expression && bundleLicense) {
      const options = bundleLicense.split(',').map(value => value.split(';')[0].replace(/"/g, '').trim()).filter(Boolean);
      const mapped = licence.expressionFromDeclarations(options.map(value => (/^https?:/.test(value) ? { url: value } : { name: value })));
      if (mapped.expression) { expression = mapped.expression; unknown = mapped.unknown; licenceSource = 'BUNDLE_LICENSE_HEADER'; }
    }
    const licenceMembers = members.filter(item => item.type === 'file' && /^(?:META-INF\/)?(?:[^/]*\/)?[^/]+$/.test(item.name)
      && LICENCE_FILE.test(path.posix.basename(item.name)) && (item.name.startsWith('META-INF/') || !item.name.includes('/')));
    const comp = component(ref, { kind: 'maven', type: 'library', group: coordinate?.groupId || null, name: coordinate?.artifactId || fileName,
      version: coordinate?.version || null, fileName, purl: coordinate ? `pkg:maven/${coordinate.groupId}/${coordinate.artifactId}@${coordinate.version}?type=jar` : null,
      expression, hashes: [digest],
      provenance: { coordinateSource: coordinate?.source || 'NONE',
        gradleCacheSha256Match: matches.length === 1 || /SHA256$/.test(coordinate?.source || ''),
        recordedRepositoryDigest: 'NONE_NO_GRADLE_VERIFICATION_METADATA' },
      properties: { members: members.length, memberListing: memberError || 'OK', licenceDeclarationSource: licenceSource, licenceChain: declared.chain,
        unmappedLicenceNames: unknown.map(item => item.name || item.url), bundleLicense: bundleLicense || null,
        packageRoots: [...new Set(members.filter(item => item.name.endsWith('.class')).map(item => item.name.split('/').slice(0, 3).join('.')))].slice(0, 40) } });
    for (const member of licenceMembers) {
      let text = null; try { text = zip.readMember(nested, member, 2 * MiB); } catch { text = null; }
      if (!text) continue;
      const kind = NOTICE_FILE.test(path.posix.basename(member.name)) ? 'NOTICE' : 'LICENCE';
      comp.noticeEvidence.push({ kind, visibility: 'ARTEFACT', location: `${location}!/${member.name}`, sha256: sha256(text) });
      comp.licenceTexts = [...(comp.licenceTexts || []), { location: `${location}!/${member.name}`, sha256: sha256(text), text: text.toString('utf8') }];
    }
    nestedByName.set(entry.name, { ref, bytes: nested, members, digest });
    attribution.push({ location, component: ref, sha256: digest, bytes: entry.size, container: jarRel, nestedMembers: members.length });
  }
  // Loader classes: compare every copied member with the loader JAR embedded in
  // the cached spring-boot-loader-tools of the same Spring Boot version.
  const loader = components.get('spring-boot-loader');
  loader.version = bootVersion; loader.purl = bootVersion && `pkg:maven/org.springframework.boot/spring-boot-loader@${bootVersion}?type=jar`;
  loader.provenance = { loaderMembersCompared: 0, loaderMembersMatched: 0, reference: 'NOT_AVAILABLE' };
  const loaderJar = loaderToolsResource('META-INF/loader/spring-boot-loader.jar');
  if (loaderJar) {
    const refEntries = new Map(zip.listZip(loaderJar).filter(item => item.type === 'file').map(item => [item.name, item]));
    loader.provenance.reference = `GRADLE_CACHE spring-boot-loader-tools-${bootVersion}.jar!/META-INF/loader/spring-boot-loader.jar`;
    loader.provenance.referenceSha256 = sha256(loaderJar); loader.provenance.loaderToolsSha256 = sha256(loaderTools);
    for (const row of attribution.filter(item => item.component === 'spring-boot-loader' && !item.directory)) {
      const name = row.location.slice(jarRel.length + 2), other = refEntries.get(name);
      loader.provenance.loaderMembersCompared++;
      if (other && sha256(zip.readMember(loaderJar, other)) === row.sha256) loader.provenance.loaderMembersMatched++;
    }
    if (loaderToolsLicences?.licences.length) {
      const mapped = licence.expressionFromDeclarations(loaderToolsLicences.licences);
      if (mapped.expression) { loader.expression = mapped.expression; loader.properties.licenceDeclarationSource = 'CONTAINING_ARTEFACT_POM:spring-boot-loader-tools'; }
    }
    const notice = loaderToolsResource('META-INF/LICENSE.txt');
    // Reference text for notice generation only; it is not shipped in the bundle.
    if (notice) loader.referenceTexts = [{ location: `gradle-cache:org.springframework.boot/spring-boot-loader-tools/${bootVersion}!/META-INF/LICENSE.txt`,
      sha256: sha256(notice), text: notice.toString('utf8') }];
  }

  // ---- control JAR: attribute every shaded member by exact bytes
  const controlRel = runtime + 'backend/code-intelligence-control.jar', controlBytes = bytesOf(controlRel);
  const provenance = JSON.parse(bytesOf(runtime + 'backend/code-intelligence-control-provenance.json').toString('utf8'));
  need(provenance.jarSha256 === sha256(controlBytes), 'CONTROL_JAR_HASH');
  const controlUsage = inventory.budget(), controlEntries = inventory.preflightZip(controlBytes, controlUsage).entries;
  const sources = provenance.dependencies.map(dep => {
    const nested = nestedByName.get(`BOOT-INF/lib/${dep.fileName}`);
    need(nested && nested.digest === dep.sha256, 'CONTROL_SOURCE_ARCHIVE', dep.fileName);
    const byName = new Map(nested.members.filter(item => item.type === 'file').map(item => [item.name, item]));
    return { dep, ref: nested.ref, nested, byName };
  });
  const controlSummary = { members: 0, firstParty: 0, dependency: 0, relocatedLicences: 0, manifest: 0, unattributed: [] };
  for (const entry of controlEntries) {
    const location = `${controlRel}!/${entry.name}`;
    if (entry.directory) { attribution.push({ location, component: 'first-party:packaging', sha256: null, bytes: 0, container: controlRel, directory: true }); continue; }
    const bytes = inventory.zipEntryBytes(controlBytes, entry, controlUsage, 16 * MiB), digest = sha256(bytes); let ref = null;
    controlSummary.members++;
    if (entry.name === 'META-INF/MANIFEST.MF') { ref = 'first-party:packaging'; controlSummary.manifest++; }
    else if (provenance.classes[entry.name] === digest) { ref = 'first-party:control'; controlSummary.firstParty++; }
    else {
      const licenceMatch = /^META-INF\/licenses\/([^/]+)\/([^/]+)\/([^/]+)\/(.+)$/.exec(entry.name);
      for (const source of sources) {
        if (licenceMatch && licenceMatch[1] === source.dep.groupId && licenceMatch[2] === source.dep.artifactId && licenceMatch[3] === source.dep.version) {
          const original = source.byName.get(`META-INF/${licenceMatch[4]}`);
          if (original && sha256(zip.readMember(source.nested.bytes, original)) === digest) { ref = source.ref; controlSummary.relocatedLicences++; break; }
        }
        const original = source.byName.get(entry.name);
        if (original && sha256(zip.readMember(source.nested.bytes, original)) === digest) { ref = source.ref; controlSummary.dependency++; break; }
      }
    }
    if (!ref) controlSummary.unattributed.push(entry.name);
    attribution.push({ location, component: ref, sha256: digest, bytes: entry.size, container: controlRel });
  }

  // ---- frontend bundle: declared components from the checkout lock (not byte-bound)
  const frontendDeclared = [];
  for (const [key, value] of Object.entries(readers.frontendLock.packages || {})) {
    if (!key || value.dev || value.devOptional) continue;
    const name = key.replace(/^.*node_modules\//, '');
    const ref = `npm:frontend:${key}`;
    frontendDeclared.push(ref);
    component(ref, { kind: 'npm-bundled', type: 'library', scopeName: 'frontend-bundle', name, version: value.version, purl: purlNpm(name, value.version),
      expression: value.license || null, parent: 'first-party:frontend',
      provenance: { lockScope: 'CURRENT_CHECKOUT_FRONTEND_LOCK_NOT_BUILD_ATTESTATION', lockIntegrity: value.integrity || null,
        lockResolved: value.resolved || null, bundleBinding: 'DECLARED_NOT_BYTE_BOUND' } });
  }
  const staticRows = attribution.filter(row => row.component === 'first-party:frontend');
  const banners = new Map();
  for (const row of staticRows.filter(item => /\.(?:css|js)$/.test(item.location))) {
    const entry = jarEntries.find(item => `${jarRel}!/${item.name}` === row.location);
    const text = inventory.zipEntryBytes(jarBytes, entry, usage, 64 * MiB).toString('latin1');
    for (const match of text.matchAll(/\/\*! ([a-z0-9@/._-]+) v([0-9][0-9A-Za-z.+-]*) \| ([A-Za-z0-9.-]+) License/g)) banners.set(`${match[1]}@${match[2]}`, { name: match[1], version: match[2], licence: match[3], location: row.location });
  }
  for (const banner of banners.values()) {
    if (frontendDeclared.some(ref => components.get(ref).name === banner.name)) continue;
    const ref = `npm:frontend-banner:${banner.name}@${banner.version}`;
    component(ref, { kind: 'npm-bundled', type: 'library', scopeName: 'frontend-bundle', name: banner.name, version: banner.version,
      purl: purlNpm(banner.name, banner.version), expression: banner.licence, parent: 'first-party:frontend',
      noticeEvidence: [{ kind: 'LICENCE', visibility: 'ARTEFACT', location: banner.location, partial: 'BANNER_ONLY' }],
      provenance: { bundleBinding: 'LICENCE_BANNER_IN_BUNDLE' } });
  }

  // ---- shipped third-party notices index (packaging fix), if present
  const noticesIndexRel = resources + 'legal/third-party/third-party-notices.json';
  const noticesIndex = fileSet.has(noticesIndexRel) ? JSON.parse(bytesOf(noticesIndexRel).toString('utf8')) : null;
  const noticesText = noticesIndex && fileSet.has(resources + 'legal/third-party/THIRD-PARTY-NOTICES.txt')
    ? bytesOf(resources + 'legal/third-party/THIRD-PARTY-NOTICES.txt').toString('utf8') : '';
  if (noticesIndex) {
    for (const item of noticesIndex.components || []) {
      const matched = [...components.values()].filter(comp => comp.name === item.name && comp.version === item.version);
      const textsPresent = (item.licenceTextSha256 || []).every(digest => noticesText.includes(`[text ${digest}]`));
      for (const comp of matched) {
        if (textsPresent && item.licenceTextSha256?.length) comp.noticeEvidence.push({ kind: 'LICENCE', visibility: 'BUNDLE_LEGAL', location: noticesIndexRel });
        if (item.sourceUrl) comp.noticeEvidence.push({ kind: 'SOURCE_STATEMENT', visibility: 'BUNDLE_LEGAL', location: noticesIndexRel, url: item.sourceUrl });
      }
    }
  }

  // ---- resolve remaining file-level attributions and collect per-component rows
  for (const row of attribution) {
    if (row.component === 'asar-unpacked') row.component = null;
    if (row.component && row.component.startsWith('container:')) row.container = row.container || null;
    if (row.component && !row.component.startsWith('container:') && components.has(row.component)) components.get(row.component).files.push(row);
  }
  const containerRows = attribution.filter(row => row.component?.startsWith('container:'));
  for (const row of containerRows) row.component = 'first-party:packaging';
  for (const row of containerRows) components.get('first-party:packaging').files.push(row);
  const unattributed = attribution.filter(row => !row.component && !row.directory);

  // ---- Electron upstream comparison
  let electronProvenance = { status: 'NOT_RUN', reason: 'No --electron-zip supplied' };
  if (electronZip) electronProvenance = compareElectron({ electronZip, electronVersion, checksums: readers.electronChecksums, files, appRoot, held, bytesOf });
  components.get('electron').provenance = electronProvenance;

  // ---- Mach-O closure
  // A load chain stays inside one subsystem: the Electron app, or one runtime tree
  // (jre, postgres, redis). Executables of another subsystem never load its images.
  const domain = rel => (rel.startsWith(runtime) ? rel.split('/').slice(0, 4).join('/') : 'electron');
  const executables = machos.filter(item => item.parsed.slices?.some(slice => slice.filetype === 'EXECUTE'));
  const machoReport = machos.map(item => {
    if (item.parsed.error) return { file: item.rel, sha256: item.sha256, error: item.parsed.error };
    const peers = executables.filter(other => domain(other.rel) === domain(item.rel));
    const executableDirs = [...new Set(peers.map(other => path.posix.dirname(other.rel)))];
    const executableRpaths = [...new Set(peers.flatMap(other => other.parsed.slices.flatMap(slice => slice.rpaths
      .filter(value => /^@(?:executable|loader)_path(?:\/|$)/.test(value))
      .map(value => path.posix.normalize(path.posix.join(path.posix.dirname(other.rel), value.replace(/^@(?:executable|loader)_path/, '')))))))]
      .filter(value => value !== '..' && !value.startsWith('../'));
    const slices = item.parsed.slices.map(slice => {
      const classified = macho.classifyReferences(item.rel, slice, { exists: existsInBundle, executableDirs, executableRpaths });
      return { cpu: slice.cpu, filetype: slice.filetype, minos: slice.minos, sdk: slice.sdk, platform: slice.platform,
        installName: slice.installName, rpaths: slice.rpaths, references: classified.references, findings: classified.findings,
        ...(otool ? { otool: otoolCrossCheck(path.join(appRoot, item.rel), slice) } : {}) };
    });
    return { file: item.rel, sha256: item.sha256, kind: item.parsed.kind, component: attribution.find(row => row.location === item.rel)?.component || null, slices };
  });
  const declaredMinimum = product.minimumSystemVersion;
  const machoFindings = machoReport.flatMap(item => (item.slices || []).flatMap(slice => slice.findings));
  const maxMinos = machoReport.flatMap(item => (item.slices || []).map(slice => slice.minos)).filter(Boolean)
    .sort(macho.compareVersions).pop() || null;
  const machoSummary = { machOFiles: machoReport.length, parseErrors: machoReport.filter(item => item.error).length,
    nonArm64Slices: machoReport.flatMap(item => (item.slices || []).filter(slice => slice.cpu !== 'arm64')).length,
    externalReferences: machoFindings.filter(item => item.code === 'EXTERNAL_DEPENDENCY').length,
    externalRpaths: machoFindings.filter(item => item.code === 'EXTERNAL_RPATH').length,
    unresolved: machoFindings.filter(item => item.code === 'UNRESOLVED_DEPENDENCY').length,
    otherFindings: machoFindings.filter(item => !['EXTERNAL_DEPENDENCY', 'EXTERNAL_RPATH', 'UNRESOLVED_DEPENDENCY'].includes(item.code)).length,
    systemReferences: [...new Set(machoReport.flatMap(item => (item.slices || []).flatMap(slice => slice.references.filter(ref => ref.resolution === 'SYSTEM').map(ref => ref.name))))].sort(),
    declaredMinimumSystemVersion: declaredMinimum, maximumBinaryMinos: maxMinos,
    binariesAboveDeclaredMinimum: machoReport.flatMap(item => (item.slices || []).filter(slice => declaredMinimum && slice.minos
      && macho.compareVersions(slice.minos, declaredMinimum) > 0).map(() => item.file)),
    minosHistogram: machoReport.reduce((acc, item) => { for (const slice of item.slices || []) acc[slice.minos] = (acc[slice.minos] || 0) + 1; return acc; }, {}),
    staticArchives, otool: otool ? machoReport.reduce((acc, item) => { for (const slice of item.slices || []) acc[slice.otool.status] = (acc[slice.otool.status] || 0) + 1; return acc; }, {}) : 'NOT_RUN' };

  // ---- licence evaluation
  for (const comp of components.values()) {
    const policyEntry = comp.policy ? licence.POLICY.components[comp.policy] : null;
    let declaredExpression = comp.expression;
    if (!declaredExpression && !policyEntry && !comp.firstParty) {
      // Only when metadata is silent: a single shipped licence text with exact anchors.
      const identified = [...new Set((comp.licenceTexts || []).map(text => licence.identifyText(text.text)).filter(Boolean))];
      if (identified.length === 1) { comp.expression = declaredExpression = identified[0]; comp.properties.licenceDeclarationSource = 'SHIPPED_LICENCE_TEXT_IDENTIFIED'; }
    }
    if (policyEntry && !comp.expression) comp.expression = policyEntry.expression;
    comp.licenceSourceKind = comp.firstParty ? 'REPOSITORY_LICENCE'
      : declaredExpression ? (comp.kind === 'maven' ? comp.properties.licenceDeclarationSource || 'DECLARED'
        : comp.kind?.startsWith('npm') ? 'PACKAGE_METADATA' : comp.kind === 'native-embedded' ? 'REVIEWED_POLICY_ASSERTION' : 'DECLARED')
        : policyEntry ? 'REVIEWED_POLICY_ASSERTION' : 'NONE';
    if (comp.firstParty) { comp.licence = { class: 'PERMISSIVE', chosen: ['MIT'], obligations: [], findings: [] }; continue; }
    const replaceable = comp.kind === 'maven' || comp.kind === 'npm' ? 'MANIFEST_HASH_ENFORCED' : comp.ref === 'ffmpeg' ? 'SIGNED_BUNDLE' : 'UNKNOWN';
    comp.licence = licence.evaluate({ expression: comp.expression, noticeEvidence: comp.noticeEvidence, replaceable, legalReview: policyEntry?.legalReview || null });
  }

  return { appRoot, entries, files, symlinks, attribution, unattributed, components, manifestCheck, product, witnesses, machoReport, machoSummary,
    controlSummary, electronProvenance, frontendDeclared, staticAssets: staticRows.length, noticesIndex: noticesIndex ? 'PRESENT' : 'ABSENT', sourceLock };
}

function compareElectron({ electronZip, electronVersion, checksums, files, appRoot, held, bytesOf }) {
  const expectedName = `electron-v${electronVersion}-darwin-arm64.zip`, expected = checksums?.[expectedName];
  const archive = readRegular(electronZip, 512 * MiB), digest = sha256(archive);
  const result = { archive: expectedName, archiveSha256: digest, recordedSha256: expected || null,
    archiveDigestMatchesRecordedChecksum: Boolean(expected) && expected === digest,
    recordSource: 'desktop/node_modules/electron/checksums.json (electron npm package; lock integrity in desktop/package-lock.json)' };
  if (!result.archiveDigestMatchesRecordedChecksum) return { ...result, status: 'FAIL_ARCHIVE_DIGEST' };
  const members = zip.listZip(archive), byName = new Map(members.map(item => [item.name, item]));
  const productName = 'Code Intelligence Validation';
  const upstreamName = rel => {
    let name = rel.replace(/^Contents\/MacOS\/Code Intelligence Validation$/, 'Contents/MacOS/Electron')
      .replace(new RegExp(`${productName} Helper`, 'g'), 'Electron Helper');
    if (name.startsWith('Contents/Resources/legal/electron/')) return name.slice('Contents/Resources/legal/electron/'.length);
    return `Electron.app/${name}`;
  };
  const counts = { identical: 0, codeIdenticalSignatureDiffers: 0, plistModifiedByPackager: 0, differs: [], absentUpstream: [] };
  for (const item of files.filter(entry => entry.rel.startsWith('Contents/Frameworks/') || entry.rel.startsWith('Contents/MacOS/')
    || ['Contents/Resources/default_app.asar', 'Contents/Resources/electron.icns'].includes(entry.rel) || entry.rel.startsWith('Contents/Resources/legal/electron/'))) {
    if (/\/_CodeSignature\/CodeResources$/.test(item.rel)) continue;
    const member = byName.get(upstreamName(item.rel));
    if (!member || member.type !== 'file') { counts.absentUpstream.push(item.rel); continue; }
    const upstream = zip.readMember(archive, member, 512 * MiB);
    if (sha256(upstream) === item.sha256) { counts.identical++; continue; }
    if (item.rel.endsWith('/Info.plist')) { counts.plistModifiedByPackager++; continue; }
    const local = held.get(item.rel) || bytesOf(item.rel);
    if (macho.machOKind(local) && codeBytesEqualIgnoringSignature(local, upstream)) counts.codeIdenticalSignatureDiffers++;
    else counts.differs.push(item.rel);
  }
  const upstreamOnly = members.filter(item => item.type === 'file' && !item.name.startsWith('Electron.app/')).map(item => item.name);
  return { ...result, status: counts.differs.length || counts.absentUpstream.length ? 'DIFFERENCES' : 'MATCH', ...counts,
    upstreamTopLevelFiles: upstreamOnly,
    upstreamLicenceFilesShipped: ['LICENSE', 'LICENSES.chromium.html'].every(name => files.some(item => item.rel === `Contents/Resources/legal/electron/${name}`)) };
}

// ---------------------------------------------------------------- CycloneDX
function cycloneDx(result, meta) {
  const bomRef = comp => comp.ref;
  const licences = comp => {
    if (!comp.expression) return undefined;
    try { const alternatives = licence.parseExpression(comp.expression);
      if (alternatives.length === 1 && alternatives[0].length === 1 && !alternatives[0][0].includes(' WITH ') && !alternatives[0][0].startsWith('LicenseRef-')
        && licence.POLICY.licences[alternatives[0][0]]) return [{ license: { id: alternatives[0][0] } }];
      return [{ expression: comp.expression }];
    } catch { return [{ license: { name: comp.expression } }]; }
  };
  const components = [...result.components.values()].filter(comp => comp.files.length || comp.kind === 'npm-bundled' || comp.parent).map(comp => {
    const rows = comp.files.filter(row => row.sha256);
    const hash = comp.hashes?.[0] || (rows.length === 1 ? rows[0].sha256 : rows.length ? treeDigest(rows) : null);
    const properties = [
      { name: 'ci:kind', value: comp.kind }, { name: 'ci:attributedFiles', value: String(comp.files.length) },
      { name: 'ci:hashBasis', value: comp.hashes?.[0] || rows.length === 1 ? 'FILE_SHA256' : rows.length ? 'TREE_DIGEST_SHA256(sorted "sha256  location\\n")' : 'NONE' },
      { name: 'ci:licenceSource', value: comp.licenceSourceKind },
      { name: 'ci:licenceClass', value: comp.licence?.class || 'UNKNOWN' },
      ...(comp.licence?.chosen?.length ? [{ name: 'ci:licenceElected', value: comp.licence.chosen.join(' AND ') }] : []),
      ...Object.entries(comp.properties || {}).filter(([, value]) => value !== null && value !== undefined)
        .map(([name, value]) => ({ name: `ci:${name}`, value: typeof value === 'string' ? value : JSON.stringify(value) })),
      ...(comp.provenance ? [{ name: 'ci:provenance', value: JSON.stringify(comp.provenance) }] : []),
    ];
    return { type: comp.type === 'data' ? 'data' : comp.type === 'platform' ? 'platform' : comp.type, 'bom-ref': bomRef(comp),
      ...(comp.group ? { group: comp.group } : {}), name: comp.name || comp.ref, ...(comp.version ? { version: comp.version } : {}),
      ...(comp.firstParty ? { supplier: { name: 'Code Intelligence (first party)' } } : {}),
      ...(hash ? { hashes: [{ alg: 'SHA-256', content: hash }] } : {}),
      ...(licences(comp) ? { licenses: licences(comp) } : {}), ...(comp.purl ? { purl: comp.purl } : {}),
      ...(rows.length ? { evidence: { occurrences: rows.slice(0, LIMITS.occurrences).map(row => ({ location: row.location })) } } : {}),
      properties };
  });
  const refs = new Set(components.map(item => item['bom-ref']));
  const dependsOn = parent => [...result.components.values()].filter(comp => comp.parent === parent && refs.has(comp.ref)).map(comp => comp.ref);
  const topLevel = [...result.components.values()].filter(comp => !comp.parent && refs.has(comp.ref)).map(comp => comp.ref);
  const backendLibs = [...result.components.values()].filter(comp => comp.kind === 'maven' && !comp.parent && refs.has(comp.ref)).map(comp => comp.ref);
  const asarLibs = [...result.components.values()].filter(comp => comp.scopeName === 'app.asar' && refs.has(comp.ref)).map(comp => comp.ref);
  const analyzerLibs = [...result.components.values()].filter(comp => comp.scopeName === 'ts-analyzer' && refs.has(comp.ref)).map(comp => comp.ref);
  return { bomFormat: 'CycloneDX', specVersion: '1.5', serialNumber: `urn:uuid:${meta.serial}`, version: 1,
    metadata: { timestamp: meta.timestamp,
      tools: { components: [{ type: 'application', name: TOOL, version: meta.toolSha256.slice(0, 12), hashes: [{ alg: 'SHA-256', content: meta.toolSha256 }] }] },
      component: { type: 'application', 'bom-ref': 'app', name: result.product.name, version: result.product.version,
        hashes: [{ alg: 'SHA-256', content: meta.bundleTreeDigest }],
        properties: [{ name: 'ci:bundleId', value: String(result.product.bundleId) }, { name: 'ci:minimumSystemVersion', value: String(result.product.minimumSystemVersion) },
          { name: 'ci:buildSequence', value: String(meta.buildSequence) }, { name: 'ci:candidate', value: meta.candidate },
          { name: 'ci:bundleTreeDigestBasis', value: 'SHA-256 over sorted "sha256  relativePath\\n" of every regular file plus "symlink  relativePath -> target\\n"' }] },
      properties: [{ name: 'ci:attributionGranularity', value: 'Every filesystem file; every first-level member of app.asar, the backend JAR and the control JAR; nested backend JAR members inherit their JAR component.' },
        { name: 'ci:unattributed', value: String(result.unattributed.length) }] },
    components,
    dependencies: [{ ref: 'app', dependsOn: topLevel.filter(ref => ref !== 'app') },
      { ref: 'electron', dependsOn: dependsOn('electron') }, { ref: 'postgresql', dependsOn: dependsOn('postgresql') },
      { ref: 'redis', dependsOn: dependsOn('redis') },
      { ref: 'first-party:backend', dependsOn: [...backendLibs, ...dependsOn('first-party:backend')] },
      { ref: 'first-party:frontend', dependsOn: dependsOn('first-party:frontend') },
      { ref: 'first-party:desktop', dependsOn: asarLibs }, { ref: 'first-party:ts-analyzer', dependsOn: analyzerLibs }]
      .filter(item => refs.has(item.ref) || item.ref === 'app'),
    compositions: [{ aggregate: result.unattributed.length ? 'incomplete' : 'complete', assemblies: ['app'] },
      // Minified browser assets are bound to lockfile declarations, not bytes.
      ...(refs.has('first-party:frontend') ? [{ aggregate: 'incomplete', assemblies: ['first-party:frontend'] }] : [])] };
}

// Structural subset of the CycloneDX 1.5 JSON schema that this generator uses.
// The official schema is not available offline; this keeps the emitted document
// within the fields, enums and reference rules it relies on.
const COMPONENT_TYPES = new Set(['application', 'framework', 'library', 'container', 'platform', 'operating-system', 'device',
  'device-driver', 'firmware', 'file', 'machine-learning-model', 'data']);
function validateCycloneDx(bom) {
  const errors = [], refs = new Set();
  const check = (ok, message) => { if (!ok) errors.push(message); };
  check(bom.bomFormat === 'CycloneDX' && bom.specVersion === '1.5' && bom.version === 1, 'header');
  check(/^urn:uuid:[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(bom.serialNumber), 'serialNumber');
  check(typeof bom.metadata?.timestamp === 'string' && !Number.isNaN(Date.parse(bom.metadata.timestamp)), 'timestamp');
  const component = (item, where) => {
    check(COMPONENT_TYPES.has(item.type), `${where}: type`);
    check(typeof item.name === 'string' && item.name.length > 0, `${where}: name`);
    check(item.version === undefined || typeof item.version === 'string', `${where}: version`);
    check(typeof item['bom-ref'] === 'string' && !refs.has(item['bom-ref']), `${where}: bom-ref`); refs.add(item['bom-ref']);
    for (const hash of item.hashes || []) check(hash.alg === 'SHA-256' && /^[a-f0-9]{64}$/.test(hash.content), `${where}: hash`);
    for (const entry of item.licenses || []) {
      const keys = Object.keys(entry);
      check(keys.length === 1 && (keys[0] === 'expression' ? typeof entry.expression === 'string'
        : keys[0] === 'license' && (typeof entry.license.id === 'string' || typeof entry.license.name === 'string')), `${where}: licenses`);
    }
    check(!item.licenses || item.licenses.length === 1 || item.licenses.every(entry => entry.license), `${where}: expression must be alone`);
    for (const property of item.properties || []) check(typeof property.name === 'string' && typeof property.value === 'string', `${where}: property`);
    for (const occurrence of item.evidence?.occurrences || []) check(typeof occurrence.location === 'string', `${where}: occurrence`);
    check(item.purl === undefined || /^pkg:[a-z]+\/.+/.test(item.purl), `${where}: purl`);
  };
  component(bom.metadata.component, 'metadata.component');
  (bom.components || []).forEach((item, index) => component(item, `components[${index}]`));
  for (const dependency of bom.dependencies || []) {
    check(refs.has(dependency.ref), `dependency ${dependency.ref}`);
    for (const ref of dependency.dependsOn || []) check(refs.has(ref), `dependsOn ${ref}`);
  }
  for (const composition of bom.compositions || []) {
    check(['complete', 'incomplete', 'unknown', 'not_specified'].includes(composition.aggregate), 'composition aggregate');
    for (const ref of composition.assemblies || []) check(refs.has(ref), `assembly ${ref}`);
  }
  return errors;
}

// ---------------------------------------------------------------- CLI
function loadReaders(repo) {
  const json = rel => JSON.parse(fs.readFileSync(path.join(repo, rel), 'utf8'));
  return { desktopLock: json('desktop/package-lock.json'), frontendLock: json('frontend/package-lock.json'),
    supply: json('desktop/scripts/macos-runtime-supply.json'),
    electronChecksums: (() => { try { return json('desktop/node_modules/electron/checksums.json'); } catch { return null; } })(),
    Pickle: require(path.join(repo, 'desktop/node_modules/@electron/asar/lib/pickle.js')).Pickle };
}
async function main(argv) {
  const options = argumentsFor(argv);
  need(process.platform === 'darwin' && !process.versions.electron, 'HOST_UNSUPPORTED');
  const repo = fs.realpathSync(path.resolve(__dirname, '../..'));
  const appRelative = inventory.candidateRelative(repo, options.app);
  need(fs.realpathSync(options.app) === options.app, 'APP_PATH');
  const resolvedFile = path.join(repo, 'validation/local/pre-release-final', options.resolved);
  const resolvedBytes = readRegular(resolvedFile, 4 * MiB), resolvedMaven = JSON.parse(resolvedBytes.toString('utf8'));
  need(resolvedMaven?.kind === 'RESOLVED_GRADLE_RUNTIME_ARTIFACTS' && Array.isArray(resolvedMaven.components), 'RESOLVED_MAVEN_INVALID');
  const toolFiles = ['sbom-candidate.cjs', 'sbom-macho.cjs', 'sbom-maven.cjs', 'sbom-zip.cjs', 'licence-obligations.cjs', 'licence-policy.json', 'inventory-candidate.cjs'];
  const toolSha256 = sha256(toolFiles.map(name => sha256(fs.readFileSync(path.join(__dirname, name)))).join('\n'));
  const started = new Date().toISOString();
  const result = await analyse({ repo, appRelative, resolvedMaven, gradleCache: options.gradleCache, electronZip: options.electronZip,
    otool: options.otool, readers: loadReaders(repo) });
  const bundleTreeDigest = sha256([...result.files.map(item => `${item.sha256}  ${item.rel}\n`),
    ...result.symlinks.map(item => `symlink  ${item.rel} -> ${item.target}\n`)].sort().join(''));
  const manifestSha256 = sha256(fs.readFileSync(path.join(result.appRoot, 'Contents/Resources/runtime/runtime-manifest.json')));
  const serial = sha256(`${bundleTreeDigest}:${toolSha256}`).replace(/^(.{8})(.{4})(.{3})(.{3})(.{12}).*$/, '$1-$2-5$3-8$4-$5');
  const meta = { timestamp: started, toolSha256, bundleTreeDigest,
    buildSequence: JSON.parse(fs.readFileSync(path.join(result.appRoot, 'Contents/Resources/runtime/runtime-manifest.json'))).buildSequence,
    candidate: appRelative.split('/')[0], serial };
  const bom = cycloneDx(result, meta);
  const schemaErrors = validateCycloneDx(bom);
  need(!schemaErrors.length, 'CYCLONEDX_STRUCTURE', schemaErrors.slice(0, 5));
  const parent = ensureOutputParent(repo, 'validation/local/sbom');
  const runDir = fs.mkdtempSync(path.join(parent, 'run-')); fs.chmodSync(runDir, 0o700);
  const write = (name, value) => {
    const bytes = Buffer.from(typeof value === 'string' ? value : JSON.stringify(value, null, 2) + '\n');
    need(bytes.length <= LIMITS.outputBytes, 'OUTPUT_LIMIT', name);
    fs.writeFileSync(path.join(runDir, name), bytes, { flag: 'wx', mode: 0o600 });
    return sha256(bytes);
  };
  const comps = [...result.components.values()].filter(comp => comp.files.length || comp.kind === 'npm-bundled' || comp.parent);
  const obligations = comps.filter(comp => !comp.firstParty).map(comp => ({ ref: comp.ref, name: comp.name, version: comp.version, kind: comp.kind,
    expression: comp.expression || null, licenceSource: comp.licenceSourceKind, class: comp.licence.class, elected: comp.licence.chosen,
    obligations: comp.licence.obligations, findings: comp.licence.findings,
    noticeEvidence: comp.noticeEvidence.map(({ kind, visibility, location }) => ({ kind, visibility, location })) }));
  const texts = new Map();
  for (const comp of comps) for (const text of [...(comp.licenceTexts || []), ...(comp.referenceTexts || [])]) if (!texts.has(text.sha256)) texts.set(text.sha256, text.text);
  fs.mkdirSync(path.join(runDir, 'licence-texts'), { mode: 0o700 });
  for (const [digest, text] of texts) fs.writeFileSync(path.join(runDir, 'licence-texts', `${digest}.txt`), text, { flag: 'wx', mode: 0o600 });
  // shipped=true: the text is inside the candidate bundle; false: offline reference copy for notice generation.
  const textIndex = comps.filter(comp => comp.licenceTexts?.length || comp.referenceTexts?.length).map(comp => ({ ref: comp.ref, name: comp.name,
    version: comp.version, kind: comp.kind, expression: comp.expression || null,
    texts: [...(comp.licenceTexts || []).map(text => ({ sha256: text.sha256, location: text.location, shipped: true })),
      ...(comp.referenceTexts || []).map(text => ({ sha256: text.sha256, location: text.location, shipped: false }))] }));
  const classCounts = obligations.reduce((acc, item) => { acc[item.class] = (acc[item.class] || 0) + 1; return acc; }, {});
  const findingCounts = obligations.flatMap(item => item.findings).reduce((acc, item) => { acc[item.code] = (acc[item.code] || 0) + 1; return acc; }, {});
  const hashes = {
    'sbom.cdx.json': write('sbom.cdx.json', bom),
    'attribution.json': write('attribution.json', { format: 1, bundleFiles: result.files.length, symlinks: result.symlinks,
      directories: result.entries.filter(item => item.type === 'dir').length, rows: result.attribution }),
    'macho.json': write('macho.json', { format: 1, summary: result.machoSummary, binaries: result.machoReport }),
    'licence-obligations.json': write('licence-obligations.json', { format: 1, policy: 'validation/pre-release/licence-policy.json',
      status: licence.POLICY.status, classCounts, findingCounts, components: obligations }),
    'licence-texts.json': write('licence-texts.json', { format: 1, texts: texts.size, components: textIndex }),
  };
  const byKind = comps.reduce((acc, comp) => { acc[comp.kind] = (acc[comp.kind] || 0) + 1; return acc; }, {});
  const summary = { format: 1, status: 'SBOM_WRITTEN', tool: TOOL, toolSha256, startedAt: started, finishedAt: new Date().toISOString(),
    candidate: { app: appRelative, bundleTreeDigest, runtimeManifestSha256: manifestSha256, product: result.product },
    standard: 'CycloneDX 1.5 JSON', inputs: { resolvedMaven: options.resolved, resolvedMavenSha256: sha256(resolvedBytes),
      gradleCache: options.gradleCache ? 'READ_ONLY_POM_AND_LOADER_LOOKUP' : 'NOT_USED', electronZip: options.electronZip ? 'READ_ONLY_COMPARISON' : 'NOT_USED',
      otoolCrossCheck: options.otool },
    counts: { bundleFiles: result.files.length, symlinks: result.symlinks.length, symlinksOutsideBundle: result.symlinks.filter(item => !item.inside).length,
      attributedRows: result.attribution.filter(row => !row.directory).length, unattributed: result.unattributed.length,
      components: comps.length, componentsByKind: byKind, controlJar: result.controlSummary, frontendStaticAssets: result.staticAssets,
      frontendDeclaredComponents: result.frontendDeclared.length },
    unattributed: result.unattributed.map(row => row.location),
    runtimeManifest: result.manifestCheck.status === 'PASS' ? { status: 'PASS', declared: result.manifestCheck.declared } : result.manifestCheck,
    electron: { version: result.components.get('electron').version, chromium: result.witnesses.chromium.value, v8: result.witnesses.v8.value,
      node: result.witnesses.node.value, provenance: result.electronProvenance },
    macho: result.machoSummary, licence: { classCounts, findingCounts, thirdPartyNoticesIndex: result.noticesIndex },
    provenance: {
      runtimes: ['electron', 'temurin-jre', 'postgresql', 'pgvector', 'redis', 'openssl', 'spring-boot-loader'].map(ref => {
        const comp = result.components.get(ref); return { ref, version: comp.version, provenance: comp.provenance || null };
      }),
      maven: comps.filter(comp => comp.kind === 'maven' && comp.ref !== 'spring-boot-loader').reduce((acc, comp) => {
        acc[comp.provenance.coordinateSource] = (acc[comp.provenance.coordinateSource] || 0) + 1; return acc; }, {}),
      npm: comps.filter(comp => comp.kind === 'npm').reduce((acc, comp) => {
        const key = `${comp.provenance.lockScope}:${comp.provenance.lockComparison}`; acc[key] = (acc[key] || 0) + 1; return acc; }, {}),
    },
    completeSbom: result.unattributed.length === 0, outputs: hashes,
    limits: ['Frontend bundle components are lockfile declarations, not byte-bound to the minified assets.',
      'Nested backend JAR members inherit their JAR component; shaded third-party packages inside a JAR are listed only as package roots.',
      'Native binaries are bound to their source lock by version strings, not by reproducible builds.',
      'Licence classes and obligations are an engineering checklist, not legal advice.'] };
  hashes['summary.json'] = write('summary.json', summary);
  return { status: summary.status, runDirectory: path.relative(repo, runDir), unattributed: summary.counts.unattributed,
    components: summary.counts.components, completeSbom: summary.completeSbom, sha256: hashes };
}

module.exports = { LIMITS, argumentsFor, attributeFile, attributeBackendMember, npmRoot, npmExpression, plistStrings, uniqueWitness,
  codeBytesEqualIgnoringSignature, treeDigest, cycloneDx, validateCycloneDx, otoolCompare, main };
if (require.main === module) {
  main(process.argv.slice(2)).then(result => process.stdout.write(JSON.stringify(result) + '\n')).catch(error => {
    process.stderr.write(JSON.stringify({ status: 'SBOM_FAILED', code: error.code || error.name, detail: error.detail || null }) + '\n');
    process.exitCode = 1;
  });
}
