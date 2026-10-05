'use strict';

// Static, opt-in evidence only. Never loads code from the candidate or extracts an
// archive to disk. Usage from the original checkout:
// node validation/pre-release/inventory-candidate.cjs --offline \
//   --app '/absolute/checkout/.native-product-ID/Code Intelligence Validation.app' \
//   --output inventory-ID.json
// Output is new-only under validation/local/pre-release-final. This is NOT a SBOM
// completeness, dependency-graph, signature, license-compliance or CVE assertion.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const zlib = require('node:zlib');

const MiB = 1024 ** 2;
const LIMITS = Object.freeze({ metadata: MiB, json: 4 * MiB, asar: 64 * MiB, jar: 256 * MiB,
  entry: 64 * MiB, entries: 30000, allEntries: 200000, declaredBytes: 2 * 1024 ** 3,
  inflatedBytes: 512 * MiB, runtimeBytes: 2 * 1024 ** 3, runtimeFiles: 20000, packages: 3000,
  nestedJars: 512, depth: 64, report: 16 * MiB });
const sha256 = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
class InventoryError extends Error { constructor(code) { super(code); this.code = code; } }
function need(ok, code) { if (!ok) throw new InventoryError(code); }
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const uint = value => Number.isSafeInteger(value) && value >= 0;
const matches = (value, re) => typeof value === 'string' && re.exec(value)?.[0] === value;
function json(bytes) {
  need(Buffer.isBuffer(bytes) && bytes.length <= LIMITS.json, 'JSON_LIMIT');
  try { return require('../t00/lib/json.cjs').parseJson(bytes); } catch { throw new InventoryError('JSON_INVALID'); }
}
function utf8(bytes) {
  try { return new TextDecoder('utf-8', { fatal: true }).decode(bytes); }
  catch { throw new InventoryError('TEXT_ENCODING'); }
}
function relativeName(value, directory = false) {
  need(typeof value === 'string' && value.length > 0 && value.length <= 4096
    && !/[\\:\x00-\x1f\x7f]/.test(value) && !/%(?:2e|2f|5c)/i.test(value), 'ENTRY_PATH');
  const name = directory && value.endsWith('/') ? value.slice(0, -1) : value;
  const parts = name.split('/');
  need(parts.length <= LIMITS.depth && parts.every(part => part && part !== '.' && part !== '..'), 'ENTRY_PATH');
  return name;
}
function argumentsFor(argv) {
  const result = {};
  need(Array.isArray(argv), 'ARGUMENTS');
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    if (flag === '--offline') { need(!result.offline, 'ARGUMENTS'); result.offline = true; continue; }
    const key = flag === '--app' ? 'app' : flag === '--output' ? 'output' : null;
    need(key && !Object.hasOwn(result, key) && typeof argv[i + 1] === 'string', 'ARGUMENTS');
    result[key] = argv[++i];
  }
  need(result.offline && typeof result.app === 'string' && path.isAbsolute(result.app)
    && !/[\x00-\x1f\x7f]/.test(result.app)
    && matches(result.output, /^[A-Za-z0-9][A-Za-z0-9._-]{0,79}\.json$/)
    && !suspicious(result.output), 'ARGUMENTS');
  return result;
}
function candidateRelative(repo, app) {
  need(typeof app === 'string' && path.isAbsolute(app) && !app.endsWith(path.sep)
    && path.normalize(app) === app, 'APP_PATH');
  const relative = path.relative(repo, app);
  need(matches(relative, /^\.native-product-[A-Za-z0-9]+\/Code Intelligence Validation\.app$/), 'APP_PATH');
  return relative;
}

// Only named metadata fields are exported. Authors, scripts, URLs, environment,
// arbitrary manifest fields, local paths and raw license text are never copied.
const suspicious = value => /(?:github_pat_|gh[pousr]_|xox[baprs]-|\bsk-[A-Za-z0-9_-]{16,}|\bAKIA[A-Z0-9]{16})/.test(value);
function atom(value, pattern = /^[A-Za-z0-9][A-Za-z0-9._+()-]*$/) {
  return typeof value === 'string' && value.length <= 160 && matches(value, pattern) && !suspicious(value) ? value : null;
}
const version = value => atom(value, /^[0-9][A-Za-z0-9._+-]*$/);
const npmName = value => atom(value, /^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/);
function licenseDeclaration(value) {
  const declaration = typeof value === 'string' && !value.startsWith('SEE LICENSE IN ')
    ? atom(value, /^[A-Za-z0-9(][A-Za-z0-9 .()+-]*$/) : null;
  return { declaration, status: declaration ? 'DECLARED_NOT_REVIEWED' : 'NOASSERTION' };
}
function evidence(container, name, bytes) {
  return { container, entryPathSha256: sha256(name), bytes: bytes.length, sha256: sha256(bytes) };
}
// Select only actual package roots, not package.json examples or tests inside them.
function packageManifest(name) {
  if (name === 'package.json') return true;
  const parts = name.split('/'); let index = 0;
  while (parts[index++] === 'node_modules') {
    if (parts[index]?.startsWith('@')) { if (!parts[index + 1]) return false; index += 2; }
    else if (parts[index]) index++; else return false;
    if (parts[index] === 'package.json' && index === parts.length - 1) return true;
  }
  return false;
}
function packageRecord(bytes, source, lock, lockScope) {
  const data = json(bytes); need(object(data), 'PACKAGE_METADATA');
  const key = source.name === 'package.json' ? '' : source.name.slice(0, -'/package.json'.length);
  const locked = object(lock?.packages) ? lock.packages[key] : null;
  const name = npmName(data.name), observedVersion = version(data.version);
  return { kind: 'npm', scope: source.container, name, version: observedVersion, declaredPrivate: data.private === true,
    status: name && observedVersion ? 'OBSERVED_METADATA' : 'NOASSERTION',
    license: licenseDeclaration(data.license), evidence: evidence(source.container, source.name, bytes),
    lock: { scope: lockScope, version: version(locked?.version),
      comparison: !locked ? 'MISSING' : !observedVersion || !version(locked.version) ? 'NOASSERTION'
        : observedVersion === locked.version ? 'MATCH' : 'MISMATCH',
      tarballIntegrity: matches(locked?.integrity, /^sha(?:256|384|512)-[A-Za-z0-9+/]+={0,2}$/) ? locked.integrity : null,
      tarballVerification: 'UNVERIFIED' } };
}

function parseAsar(bytes, Pickle) {
  need(Buffer.isBuffer(bytes) && bytes.length >= 16 && bytes.length <= LIMITS.asar, 'ASAR_SIZE');
  const headerSize = bytes.readUInt32LE(4), textLength = bytes.readUInt32LE(12);
  need(bytes.readUInt32LE(0) === 4 && headerSize >= 8 && headerSize <= LIMITS.json + 8
    && 8 + headerSize <= bytes.length && bytes.readUInt32LE(8) === headerSize - 4
    && textLength > 0 && textLength <= LIMITS.json && headerSize === 8 + Math.ceil(textLength / 4) * 4, 'ASAR_HEADER');
  const raw = bytes.subarray(16, 16 + textLength);
  need(bytes.subarray(16 + textLength, 8 + headerSize).every(byte => byte === 0), 'ASAR_HEADER');
  // Use the installed ASAR codec on bounded in-memory bytes, not extractFile's
  // pathname/link/unpacked-file reopening. No candidate JS module is required.
  need(Pickle && typeof Pickle.createFromBuffer === 'function', 'ASAR_READER_MISSING');
  const decoded = Pickle.createFromBuffer(bytes.subarray(8, 8 + headerSize)).createIterator().readString();
  need(decoded === utf8(raw), 'ASAR_HEADER');
  const header = json(raw), entries = [], spans = []; let count = 0;
  function walk(node, prefix, depth) {
    need(object(node) && !Object.hasOwn(node, 'link') && depth <= LIMITS.depth, 'ASAR_NODE');
    if (Object.hasOwn(node, 'files')) {
      need(object(node.files) && !Object.hasOwn(node, 'size') && !Object.hasOwn(node, 'offset'), 'ASAR_NODE');
      for (const [leaf, child] of Object.entries(node.files)) {
        need(leaf.indexOf('/') === -1 && ++count <= LIMITS.entries, 'ASAR_NODE');
        const name = relativeName(prefix ? prefix + '/' + leaf : leaf);
        walk(child, name, depth + 1);
      }
      return;
    }
    need(prefix && uint(node.size) && node.size <= LIMITS.entry
      && (!Object.hasOwn(node, 'unpacked') || typeof node.unpacked === 'boolean'), 'ASAR_SIZE');
    let start = null;
    if (!node.unpacked) {
      need(matches(node.offset, /^(?:0|[1-9][0-9]*)$/), 'ASAR_OFFSET');
      start = 8 + headerSize + Number(node.offset);
      need(uint(start) && start >= 8 + headerSize && start + node.size <= bytes.length, 'ASAR_OFFSET');
      if (node.size) spans.push([start, start + node.size]);
    } else need(!Object.hasOwn(node, 'offset'), 'ASAR_OFFSET');
    entries.push({ name: prefix, size: node.size, unpacked: node.unpacked === true, start });
  }
  need(object(header?.files), 'ASAR_HEADER'); walk(header, '', 0);
  spans.sort((a, b) => a[0] - b[0]);
  for (let i = 1; i < spans.length; i++) need(spans[i][0] >= spans[i - 1][1], 'ASAR_OVERLAP');
  return entries;
}

function budget() { return { entries: 0, declaredBytes: 0, inflatedBytes: 0 }; }
function noZip64Extra(bytes) {
  for (let i = 0; i < bytes.length;) {
    need(i + 4 <= bytes.length, 'ZIP_EXTRA');
    const id = bytes.readUInt16LE(i), length = bytes.readUInt16LE(i + 2);
    need(id !== 1 && i + 4 + length <= bytes.length, 'ZIP_EXTRA'); i += 4 + length;
  }
}
// Validate every central/local record before calling the existing ZIP reader.
// ZIP64, multipart, encrypted, linked and unsupported-compression inputs fail.
function preflightZip(bytes, usage = budget()) {
  need(Buffer.isBuffer(bytes) && bytes.length >= 22 && bytes.length <= LIMITS.jar, 'ZIP_SIZE');
  let end = -1;
  for (let i = bytes.length - 22; i >= Math.max(0, bytes.length - 65557); i--) {
    if (bytes.readUInt32LE(i) === 0x06054b50 && i + 22 + bytes.readUInt16LE(i + 20) === bytes.length) { end = i; break; }
  }
  need(end >= 0 && bytes.readUInt16LE(end + 4) === 0 && bytes.readUInt16LE(end + 6) === 0, 'ZIP_DIRECTORY');
  const count = bytes.readUInt16LE(end + 10), length = bytes.readUInt32LE(end + 12), offset = bytes.readUInt32LE(end + 16);
  need(count === bytes.readUInt16LE(end + 8) && count < 65535 && count <= LIMITS.entries
    && offset !== 0xffffffff && length !== 0xffffffff && offset + length === end, 'ZIP_DIRECTORY');
  usage.entries += count; need(usage.entries <= LIMITS.allEntries, 'ZIP_TOTAL_LIMIT');
  const entries = [], names = new Map(), spans = []; let cursor = offset;
  for (let i = 0; i < count; i++) {
    need(cursor + 46 <= end && bytes.readUInt32LE(cursor) === 0x02014b50, 'ZIP_DIRECTORY');
    const flags = bytes.readUInt16LE(cursor + 8), method = bytes.readUInt16LE(cursor + 10);
    const crc = bytes.readUInt32LE(cursor + 16), compressed = bytes.readUInt32LE(cursor + 20), size = bytes.readUInt32LE(cursor + 24);
    const nameLength = bytes.readUInt16LE(cursor + 28), extraLength = bytes.readUInt16LE(cursor + 30), comment = bytes.readUInt16LE(cursor + 32);
    const local = bytes.readUInt32LE(cursor + 42), mode = (bytes.readUInt32LE(cursor + 38) >>> 16) & 0xf000;
    need(!(flags & ~0x080e) && (method === 0 || method === 8) && bytes.readUInt16LE(cursor + 34) === 0
      && cursor + 46 + nameLength + extraLength + comment <= end, 'ZIP_ENTRY');
    need(size <= LIMITS.entry && compressed <= LIMITS.entry && (method !== 0 || size === compressed), 'ZIP_ENTRY_LIMIT');
    usage.declaredBytes += size; need(usage.declaredBytes <= LIMITS.declaredBytes, 'ZIP_TOTAL_LIMIT');
    const rawName = bytes.subarray(cursor + 46, cursor + 46 + nameLength), name = utf8(rawName), directory = name.endsWith('/');
    const canonical = relativeName(name, directory);
    need(!names.has(canonical) && (mode === 0 || mode === (directory ? 0x4000 : 0x8000))
      && (!directory || size === 0), 'ZIP_DUPLICATE_OR_TYPE');
    names.set(canonical, directory);
    noZip64Extra(bytes.subarray(cursor + 46 + nameLength, cursor + 46 + nameLength + extraLength));
    need(local + 30 <= offset && bytes.readUInt32LE(local) === 0x04034b50
      && bytes.readUInt16LE(local + 6) === flags && bytes.readUInt16LE(local + 8) === method, 'ZIP_LOCAL_HEADER');
    const localNameLength = bytes.readUInt16LE(local + 26), localExtraLength = bytes.readUInt16LE(local + 28);
    const start = local + 30 + localNameLength + localExtraLength;
    need(start + compressed <= offset && bytes.subarray(local + 30, local + 30 + localNameLength).equals(rawName), 'ZIP_LOCAL_HEADER');
    noZip64Extra(bytes.subarray(local + 30 + localNameLength, start));
    for (const [fieldOffset, expected] of [[14, crc], [18, compressed], [22, size]]) {
      const actual = bytes.readUInt32LE(local + fieldOffset);
      need(actual === expected || Boolean(flags & 8) && actual === 0, 'ZIP_LOCAL_HEADER');
    }
    let finish = start + compressed;
    if (flags & 8) {
      need(finish + 12 <= offset, 'ZIP_DESCRIPTOR');
      if (bytes.readUInt32LE(finish) === 0x08074b50) finish += 4;
      need(finish + 12 <= offset && bytes.readUInt32LE(finish) === crc
        && bytes.readUInt32LE(finish + 4) === compressed && bytes.readUInt32LE(finish + 8) === size, 'ZIP_DESCRIPTOR');
      finish += 12;
    }
    spans.push([local, finish]); entries.push({ name, directory, flags, method, crc, compressed, size, local, start });
    cursor += 46 + nameLength + extraLength + comment;
  }
  need(cursor === end, 'ZIP_DIRECTORY');
  spans.sort((a, b) => a[0] - b[0]);
  for (let i = 0; i < spans.length; i++) need(spans[i][0] >= (i ? spans[i - 1][1] : 0), 'ZIP_OVERLAP');
  for (const name of names.keys()) {
    const parts = name.split('/');
    for (let i = 1; i < parts.length; i++) need(names.get(parts.slice(0, i).join('/')) !== false, 'ZIP_PARENT_FILE');
  }
  return { entries, end };
}
const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  for (let i = 0; i < 8; i++) n = (n & 1) ? (0xedb88320 ^ (n >>> 1)) : (n >>> 1); return n >>> 0;
});
function crc32(bytes) { let n = 0xffffffff; for (const byte of bytes) n = CRC_TABLE[(n ^ byte) & 255] ^ (n >>> 8); return (n ^ 0xffffffff) >>> 0; }
function zipEntryBytes(bytes, entry, usage, maximum = LIMITS.metadata) {
  need(Buffer.isBuffer(bytes) && entry && !entry.directory && uint(entry.size) && uint(entry.start)
    && uint(entry.compressed) && entry.start + entry.compressed <= bytes.length
    && entry.size <= maximum && entry.size <= LIMITS.entry && (entry.method === 0 || entry.method === 8), 'ZIP_SELECTED_LIMIT');
  usage.inflatedBytes += entry.size; need(usage.inflatedBytes <= LIMITS.inflatedBytes, 'ZIP_INFLATE_LIMIT');
  const packed = bytes.subarray(entry.start, entry.start + entry.compressed); let result;
  try { result = entry.method === 0 ? packed : zlib.inflateRawSync(packed, { maxOutputLength: Math.max(1, entry.size) }); }
  catch { throw new InventoryError('ZIP_INFLATE'); }
  need(result.length === entry.size && crc32(result) === entry.crc, 'ZIP_CONTENT');
  return result;
}
async function openZip(bytes, Open, usage) {
  const checked = preflightZip(bytes, usage);
  need(Open && typeof Open.buffer === 'function', 'ZIP_READER_MISSING');
  // The bounded classic directory was validated before this parser allocates records.
  const parsed = await Open.buffer(bytes, { tailSize: bytes.length - checked.end });
  need(Array.isArray(parsed.files) && parsed.files.length === checked.entries.length, 'ZIP_READER_DISAGREEMENT');
  for (let i = 0; i < parsed.files.length; i++) {
    const actual = parsed.files[i], expected = checked.entries[i];
    need(actual.path === expected.name && actual.flags === expected.flags && actual.compressionMethod === expected.method
      && actual.uncompressedSize === expected.size && actual.compressedSize === expected.compressed
      && actual.offsetToLocalFileHeader === expected.local && actual.crc32 === expected.crc, 'ZIP_READER_DISAGREEMENT');
  }
  // Never call ZIP extract/buffer/stream helpers: inflate only a validated slice,
  // with maxOutputLength enforced inside zlib, and verify its exact length/CRC.
  return checked.entries;
}

function javaMetadata(bytes, kind) {
  need(bytes.length <= LIMITS.metadata, 'METADATA_LIMIT');
  const values = new Map(); let previous = null;
  for (const line of utf8(bytes).split(/\r?\n/)) {
    if (kind === 'manifest' && line === '') break; // Main section only.
    if (kind === 'manifest' && line.startsWith(' ')) {
      need(previous !== null, 'METADATA_FORMAT'); values.set(previous, values.get(previous) + line.slice(1)); continue;
    }
    if (!line.trim() || kind !== 'manifest' && /^[ \t]*[#!]/.test(line)) continue;
    const match = kind === 'manifest' ? /^([A-Za-z0-9_-]+): (.*)$/.exec(line)
      : kind === 'release' ? /^([A-Z0-9_]+)="([^"\r\n]*)"$/.exec(line)
        : /^[ \t]*([^\s:=]+)[ \t]*[=:][ \t]*(.*)$/.exec(line);
    need(match && !match[1].includes('\\') && !match[2].includes('\\'), 'METADATA_FORMAT');
    const key = kind === 'manifest' ? match[1].toLowerCase() : match[1];
    need(!values.has(key) && values.size < 256, 'METADATA_DUPLICATE');
    values.set(key, match[2]); previous = key;
  }
  if (kind === 'release') {
    const modules = (values.get('MODULES') || '').split(' ').filter(Boolean);
    need(modules.length <= 128 && modules.every(value => atom(value)), 'METADATA_FORMAT');
    return { javaVersion: version(values.get('JAVA_VERSION')), modules };
  }
  if (kind === 'pom') return { groupId: atom(values.get('groupId')), artifactId: atom(values.get('artifactId')), version: version(values.get('version')) };
  return { implementationVersion: version(values.get('implementation-version')), bundleVersion: version(values.get('bundle-version')),
    mainClass: atom(values.get('main-class'), /^[A-Za-z_$][A-Za-z0-9_.$]*$/),
    startClass: atom(values.get('start-class'), /^[A-Za-z_$][A-Za-z0-9_.$]*$/) };
}
function metadataRecord(bytes, kind, container, name) {
  const source = evidence(container, name, bytes);
  try {
    const fields = javaMetadata(bytes, kind);
    const present = kind === 'release' ? fields.javaVersion !== null : kind === 'pom'
      ? fields.groupId && fields.artifactId && fields.version : Object.values(fields).some(value => value !== null);
    return { status: present ? 'DECLARED_STATIC_METADATA' : 'NOASSERTION', fields, evidence: source };
  }
  catch (error) { if (!(error instanceof InventoryError)) throw error;
    return { status: 'NOASSERTION', reason: 'UNSUPPORTED_OR_INVALID_METADATA', evidence: source }; }
}
async function jarInventory(bytes, Open) {
  const usage = budget(), entries = await openZip(bytes, Open, usage);
  const selected = entries.filter(entry => !entry.directory && /^BOOT-INF\/lib\/[^/]+\.jar$/.test(entry.name));
  need(selected.length > 0 && selected.length <= LIMITS.nestedJars, 'BACKEND_LIBRARIES');
  const main = entries.find(entry => entry.name === 'META-INF/MANIFEST.MF'), components = [];
  for (const entry of selected) {
    const nested = zipEntryBytes(bytes, entry, usage, LIMITS.entry), metadata = [];
    let records;
    try { records = await openZip(nested, Open, usage); }
    catch (error) {
      // Old/ZIP64/non-regular metadata layouts cannot be interpreted by this
      // conservative reader. Preserve the verified outer-entry hash and explicit
      // non-coverage instead of relaxing ZIP guards or guessing Maven coordinates.
      if (!(error instanceof InventoryError) || !['ZIP_DUPLICATE_OR_TYPE', 'ZIP_EXTRA'].includes(error.code)) throw error;
      components.push({ kind: 'jar', fileName: atom(path.posix.basename(entry.name)),
        evidence: evidence('BACKEND_JAR', entry.name, nested), metadata: [],
        metadataInspection: 'UNSUPPORTED_ARCHIVE_LAYOUT', reason: error.code,
        license: { status: 'NOASSERTION' }, dependencyGraph: 'UNVERIFIED' });
      continue;
    }
    for (const record of records) {
      const kind = record.name === 'META-INF/MANIFEST.MF' ? 'manifest'
        : /^META-INF\/maven\/[^/]+\/[^/]+\/pom\.properties$/.test(record.name) ? 'pom' : null;
      if (kind) metadata.push({ kind, ...metadataRecord(zipEntryBytes(nested, record, usage), kind, 'NESTED_JAR', record.name) });
    }
    components.push({ kind: 'jar', fileName: atom(path.posix.basename(entry.name)),
      evidence: evidence('BACKEND_JAR', entry.name, nested), metadata,
      metadataInspection: 'BOUNDED_METADATA_PARSED',
      license: { status: 'NOASSERTION' }, dependencyGraph: 'UNVERIFIED' });
  }
  return { components, mainManifest: main ? metadataRecord(zipEntryBytes(bytes, main, usage), 'manifest', 'BACKEND_JAR', main.name) : { status: 'NOASSERTION' },
    usage, unselectedEntryContents: 'NOT_DECOMPRESSED', archiveSignatures: 'UNVERIFIED' };
}

const fileStamp = stat => [stat.dev, stat.ino, stat.uid, stat.gid, stat.mode, stat.nlink, stat.size, stat.mtimeNs, stat.ctimeNs].join(':');
const dirStamp = stat => [stat.dev, stat.ino, stat.uid, stat.gid, stat.mode].join(':');
class LocalReader {
  constructor(root) {
    need(path.isAbsolute(root) && fs.realpathSync(root) === root && typeof process.getuid === 'function', 'ROOT_PATH');
    this.root = root; this.directories = new Map(); this.files = new Map(); this.directory('');
  }
  directory(relative) {
    if (relative) relativeName(relative);
    let current = this.root;
    for (const part of ['', ...(relative ? relative.split('/') : [])]) {
      if (part) current = path.join(current, part);
      const stat = fs.lstatSync(current, { bigint: true });
      need(stat.isDirectory() && !stat.isSymbolicLink() && stat.uid === BigInt(process.getuid())
        && !(stat.mode & 0o022n) && fs.realpathSync(current) === current, 'DIRECTORY_UNSAFE');
      const before = this.directories.get(current);
      need(before === undefined || before === dirStamp(stat), 'INPUT_CHANGED'); this.directories.set(current, dirStamp(stat));
    }
    return current;
  }
  file(relative, maximum, capture = true) {
    relativeName(relative); this.directory(path.posix.dirname(relative) === '.' ? '' : path.posix.dirname(relative));
    const target = path.join(this.root, relative), before = fs.lstatSync(target, { bigint: true });
    need(before.isFile() && !before.isSymbolicLink() && before.nlink === 1n && before.uid === BigInt(process.getuid())
      && !(before.mode & 0o022n) && before.size <= BigInt(maximum), 'FILE_UNSAFE_OR_LIMIT');
    const prior = this.files.get(target); need(!prior || prior.stamp === fileStamp(before), 'INPUT_CHANGED');
    const fd = fs.openSync(target, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
    const hash = crypto.createHash('sha256'), buffer = Buffer.alloc(65536), chunks = []; let size = 0;
    try {
      need(fileStamp(fs.fstatSync(fd, { bigint: true })) === fileStamp(before), 'INPUT_CHANGED');
      for (;;) {
        const used = fs.readSync(fd, buffer, 0, Math.min(buffer.length, Number(before.size) - size + 1), size);
        if (!used) break;
        size += used; need(size <= Number(before.size) && size <= maximum, 'INPUT_CHANGED');
        hash.update(buffer.subarray(0, used)); if (capture) chunks.push(Buffer.from(buffer.subarray(0, used)));
      }
      need(size === Number(before.size) && fileStamp(fs.fstatSync(fd, { bigint: true })) === fileStamp(before)
        && fileStamp(fs.lstatSync(target, { bigint: true })) === fileStamp(before), 'INPUT_CHANGED');
    } finally { buffer.fill(0); fs.closeSync(fd); }
    const digest = hash.digest('hex'); need(!prior || prior.sha256 === digest, 'INPUT_CHANGED');
    this.files.set(target, { stamp: fileStamp(before), sha256: digest });
    return { bytes: size, sha256: digest, ...(capture ? { data: Buffer.concat(chunks, size) } : {}) };
  }
  recheck() {
    for (const [name, stamp] of this.directories) need(dirStamp(fs.lstatSync(name, { bigint: true })) === stamp
      && fs.realpathSync(name) === name, 'INPUT_CHANGED');
    for (const [name, value] of this.files) need(fileStamp(fs.lstatSync(name, { bigint: true })) === value.stamp, 'INPUT_CHANGED');
  }
  scanRuntime(relative) {
    let files = 0, bytes = 0, entries = 0; const names = [];
    const walk = (root, depth) => {
      need(depth <= LIMITS.depth, 'RUNTIME_LIMIT'); this.directory(root);
      for (const name of fs.readdirSync(path.join(this.root, root))) {
        need(++entries <= LIMITS.runtimeFiles, 'RUNTIME_LIMIT'); relativeName(name);
        const child = root + '/' + name, stat = fs.lstatSync(path.join(this.root, child), { bigint: true });
        need(!stat.isSymbolicLink(), 'RUNTIME_LINK');
        if (stat.isDirectory()) walk(child, depth + 1);
        else {
          need(stat.isFile() && stat.nlink === 1n && stat.uid === BigInt(process.getuid())
            && !(stat.mode & 0o022n) && stat.size <= 512n * BigInt(MiB), 'RUNTIME_TYPE');
          files++; bytes += Number(stat.size); need(bytes <= LIMITS.runtimeBytes, 'RUNTIME_LIMIT'); names.push(child.slice(relative.length + 1));
        }
      }
    };
    walk(relative, 0); return { files, bytes, names: names.sort() };
  }
}

function loadReaders(reader) {
  const lockBytes = reader.file('desktop/package-lock.json', LIMITS.json), lock = json(lockBytes.data), tools = [];
  for (const name of ['@electron/asar', 'unzipper']) {
    const location = 'desktop/node_modules/' + name;
    const metaBytes = reader.file(location + '/package.json', LIMITS.metadata), meta = json(metaBytes.data);
    need(meta.name === name && version(meta.version) && lock.packages?.['node_modules/' + name]?.version === meta.version, 'READER_DEPENDENCY');
    const entry = name === 'unzipper' ? '/lib/Open/index.js' : '/lib/pickle.js';
    tools.push({ name, version: meta.version, packageSha256: metaBytes.sha256, entrySha256: reader.file(location + entry, LIMITS.metadata).sha256 });
  }
  return { lock, tools, checkoutLockSha256: lockBytes.sha256,
    Pickle: require(path.join(reader.root, 'desktop/node_modules/@electron/asar/lib/pickle.js')).Pickle,
    Open: require(path.join(reader.root, 'desktop/node_modules/unzipper/lib/Open/index.js')) };
}
function nativeLock(bytes) {
  const lock = json(bytes), ids = new Set(), known = { openssl: 'LICENSE.txt', postgres: 'COPYRIGHT', redis: 'LICENSE.txt', pgvector: 'LICENSE' };
  need(lock.format === 1 && Array.isArray(lock.sources) && lock.sources.length === 4, 'NATIVE_SOURCE_LOCK');
  return lock.sources.map(item => {
    need(object(item) && Object.hasOwn(known, item.id) && !ids.has(item.id) && version(item.version)
      && item.licenseFile === known[item.id] && matches(item.sha256, /^[a-f0-9]{64}$/), 'NATIVE_SOURCE_LOCK');
    ids.add(item.id);
    return { name: item.id, version: item.version, sourceArchiveSha256: item.sha256,
      revision: matches(item.revision, /^[a-f0-9]{40}$/) ? item.revision : null,
      licenseFile: item.id + '-' + item.version + '-' + known[item.id] };
  });
}

async function inventory(reader, appRelative, readers) {
  reader.directory(appRelative);
  const resources = appRelative + '/Contents/Resources', runtime = resources + '/runtime';
  const manifestFile = runtime + '/runtime-manifest.json', manifestBytes = reader.file(manifestFile, LIMITS.json), manifest = json(manifestBytes.data);
  need(manifest.platform === 'darwin' && manifest.arch === 'arm64' && manifest.backupProtocol === 3 && object(manifest.files), 'RUNTIME_MANIFEST');
  const initialScan = reader.scanRuntime(runtime);
  const { validateRuntimeManifest } = require('../../desktop/src/runtime-manifest.cjs');
  await validateRuntimeManifest(path.join(reader.root, runtime), manifest, { platform: 'darwin', arch: 'arm64' });
  function runtimeFile(name, maximum = LIMITS.metadata, capture = true) {
    relativeName(name); need(Object.hasOwn(manifest.files, name), 'RUNTIME_EVIDENCE_MISSING');
    const value = reader.file(runtime + '/' + name, maximum, capture); need(value.sha256 === manifest.files[name], 'RUNTIME_HASH'); return value;
  }
  const archive = reader.file(resources + '/app.asar', LIMITS.asar), asarEntries = parseAsar(archive.data, readers.Pickle), packages = [];
  for (const entry of asarEntries.filter(item => packageManifest(item.name))) {
    need(entry.size <= LIMITS.metadata && packages.length < LIMITS.packages, 'PACKAGE_LIMIT');
    const bytes = entry.unpacked ? reader.file(resources + '/app.asar.unpacked/' + entry.name, LIMITS.metadata).data
      : archive.data.subarray(entry.start, entry.start + entry.size);
    need(bytes.length === entry.size, 'ASAR_UNPACKED_SIZE');
    packages.push({ ...packageRecord(bytes, { container: 'APP_ASAR', name: entry.name }, readers.lock, 'CURRENT_CHECKOUT_NOT_BUILD_ATTESTATION'),
      storage: entry.unpacked ? 'ASAR_UNPACKED_METADATA' : 'PACKED_ASAR_METADATA' });
  }
  need(asarEntries.some(entry => entry.name === 'package.json'), 'APP_PACKAGE_MISSING');
  const tsLock = runtimeFile('ts-analyzer/package-lock.json', LIMITS.json), lock = json(tsLock.data);
  need([2, 3].includes(lock.lockfileVersion) && object(lock.packages), 'ANALYZER_LOCK');
  const tsNames = Object.keys(manifest.files).filter(name => name.startsWith('ts-analyzer/') && packageManifest(name.slice('ts-analyzer/'.length))).sort();
  need(tsNames.includes('ts-analyzer/package.json'), 'ANALYZER_PACKAGE_MISSING');
  for (const name of tsNames) {
    need(packages.length < LIMITS.packages, 'PACKAGE_LIMIT');
    packages.push(packageRecord(runtimeFile(name).data, { container: 'TS_RUNTIME', name: name.slice('ts-analyzer/'.length) }, lock, 'SHIPPED_LOCK_DECLARATION'));
  }
  const jarBytes = runtimeFile('backend/code-intelligence.jar', LIMITS.jar), backend = await jarInventory(jarBytes.data, readers.Open);
  const release = runtimeFile('jre/release'), jre = metadataRecord(release.data, 'release', 'RUNTIME', 'jre/release');
  const noticesRoot = relativeName(manifest.runtime.postgresShare) + '/code-intelligence-notices';
  const sourceLock = runtimeFile(noticesRoot + '/source-lock.json'), native = [];
  for (const item of nativeLock(sourceLock.data)) {
    const name = noticesRoot + '/' + item.licenseFile, license = runtimeFile(name);
    const namedBinaries = item.name === 'postgres' ? [manifest.runtime.postgresBin + '/postgres']
      : item.name === 'redis' ? ['redis/bin/redis-server']
        : item.name === 'pgvector' ? [manifest.runtime.postgresPkgLib + '/vector.dylib']
          : Object.keys(manifest.files).filter(value => /^(?:postgres|redis)\/lib\/lib(?:ssl|crypto)(?:\.[0-9]+)*\.dylib$/.test(value));
    const binaries = namedBinaries.map(value => {
      const file = runtimeFile(value, 512 * MiB, false);
      return { container: 'RUNTIME', entryPathSha256: sha256(value), bytes: file.bytes, sha256: file.sha256 };
    });
    native.push({ kind: 'native-source-declaration', name: item.name, version: item.version, sourceArchiveSha256: item.sourceArchiveSha256,
      revision: item.revision, sourceArchiveVerification: 'UNVERIFIED', binaryVersionBinding: 'UNVERIFIED',
      namedBinaryFiles: binaries,
      evidence: evidence('RUNTIME', noticesRoot + '/source-lock.json', sourceLock.data),
      license: { status: 'UNVERIFIED', evidence: evidence('RUNTIME', name, license.data) } });
  }
  const legal = [];
  for (const name of Object.keys(manifest.files).sort()) {
    if (/^jre\/legal\/[^/]+\/(?:LICENSE|NOTICE|ASSEMBLY_EXCEPTION|ADDITIONAL_LICENSE_INFO)$/.test(name)) {
      const value = runtimeFile(name); legal.push(evidence('RUNTIME', name, value.data));
    }
  }
  // Revalidate before publication. This detects ordinary changes, not a hostile
  // same-OS-user ancestor-swap attack or a cryptographic publisher identity.
  await validateRuntimeManifest(path.join(reader.root, runtime), manifest, { platform: 'darwin', arch: 'arm64' });
  need(JSON.stringify(reader.scanRuntime(runtime)) === JSON.stringify(initialScan), 'INPUT_CHANGED');
  need(reader.file(manifestFile, LIMITS.json).sha256 === manifestBytes.sha256
    && reader.file(resources + '/app.asar', LIMITS.asar, false).sha256 === archive.sha256, 'INPUT_CHANGED');
  reader.recheck();
  return { format: 1, kind: 'STATIC_COMPONENT_PROVENANCE_INVENTORY', status: 'OBSERVED_WITH_LIMITATIONS', completeSbom: false,
    candidate: { appAsar: { bytes: archive.bytes, sha256: archive.sha256 },
      runtimeManifest: { bytes: manifestBytes.bytes, sha256: manifestBytes.sha256, filesVerified: initialScan.files - 1 },
      backendJar: { bytes: jarBytes.bytes, sha256: jarBytes.sha256 }, buildSequence: manifest.buildSequence,
      fullAppDigest: 'NOT_MEASURED', runtimeManifestByteVerification: 'VERIFIED' },
    tool: { sourceSha256: reader.file('validation/pre-release/inventory-candidate.cjs', LIMITS.metadata).sha256,
      readers: readers.tools, checkoutLockSha256: readers.checkoutLockSha256 },
    packages, backend, jre: { ...jre, legalFiles: legal, licenseReview: 'UNVERIFIED' }, native,
    shippedAnalyzerLock: evidence('RUNTIME', 'ts-analyzer/package-lock.json', tsLock.data),
    coverage: { appPackageManifests: packages.filter(item => item.scope === 'APP_ASAR').length,
      analyzerPackageManifests: tsNames.length, nestedJars: backend.components.length,
      unsupportedNestedArchiveLayouts: backend.components.filter(item => item.metadataInspection === 'UNSUPPORTED_ARCHIVE_LAYOUT').length,
      dependencyGraph: 'UNVERIFIED', productionDependencyClassification: 'UNVERIFIED',
      browserBundledTransitives: 'NOASSERTION', electronChromiumNodeBinaryVersions: 'UNVERIFIED',
      fullLicenseObligations: 'UNVERIFIED', currentCveStatus: 'UNVERIFIED', signaturesAndNotarization: 'UNVERIFIED',
      nativeBinaryToSourceMapping: 'UNVERIFIED', unpackedUnselectedFiles: 'NOT_INVENTORIED' },
    limits: LIMITS, limitations: ['Metadata declarations and hashes are not a resolved dependency graph or a complete SBOM.',
      'Current checkout locks are comparison evidence, not proof of this candidate build.',
      'Only selected metadata is decompressed; other ZIP entry contents and signatures are not verified.',
      'Nested archives rejected by the conservative metadata parser retain only their verified outer-entry hash; their coordinates and contents are unverified.',
      'No candidate code, install hooks, subprocess, database, profile, key store or network request is invoked.',
      'Paths are hashed; raw metadata outside the selected fields is omitted.',
      'Path checks cover static owned trees and ordinary drift, not hostile concurrent ancestor replacement.'] };
}

function outputTarget(reader, name, create) {
  need(matches(name, /^[A-Za-z0-9][A-Za-z0-9._-]{0,79}\.json$/), 'OUTPUT_NAME');
  const parent = 'validation/local/pre-release-final'; reader.directory('validation/local');
  const directory = path.join(reader.root, parent);
  try { fs.lstatSync(directory); reader.directory(parent); }
  catch (error) { if (error.code !== 'ENOENT') throw error;
    if (create) { fs.mkdirSync(directory, { mode: 0o700 }); reader.directory(parent); } }
  const target = path.join(directory, name);
  try { fs.lstatSync(target); throw new InventoryError('OUTPUT_EXISTS'); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  return target;
}
async function main(argv) {
  const options = argumentsFor(argv); // No candidate/output I/O until flags are valid.
  need(process.platform === 'darwin' && process.arch === 'arm64' && !process.versions.electron, 'HOST_UNSUPPORTED');
  const root = fs.realpathSync(path.resolve(__dirname, '../..')), appRelative = candidateRelative(root, options.app), reader = new LocalReader(root);
  reader.directory(appRelative); need(fs.realpathSync(options.app) === options.app, 'APP_PATH');
  outputTarget(reader, options.output, false);
  reader.file('validation/pre-release/inventory-candidate.cjs', LIMITS.metadata); // Bind the tool before the scan, then recheck it.
  const report = await inventory(reader, appRelative, loadReaders(reader));
  const bytes = Buffer.from(JSON.stringify(report, null, 2) + '\n'); need(bytes.length <= LIMITS.report, 'REPORT_LIMIT');
  reader.recheck(); const target = outputTarget(reader, options.output, true); reader.recheck();
  const fd = fs.openSync(target, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, 0o600);
  try { fs.writeFileSync(fd, bytes); fs.fsyncSync(fd); }
  finally { fs.closeSync(fd); }
  const written = reader.file('validation/local/pre-release-final/' + options.output, LIMITS.report, false);
  need(written.sha256 === sha256(bytes), 'OUTPUT_CHANGED');
  return { status: 'STATIC_INVENTORY_WRITTEN', outputFile: options.output, sha256: written.sha256, completeSbom: false };
}

module.exports = { LIMITS, InventoryError, argumentsFor, candidateRelative, relativeName, packageManifest, packageRecord,
  parseAsar, preflightZip, zipEntryBytes, openZip, crc32, budget, javaMetadata, metadataRecord, nativeLock, jarInventory, main };
if (require.main === module) {
  main(process.argv.slice(2)).then(result => process.stdout.write(JSON.stringify(result) + '\n')).catch(error => {
    process.stderr.write(JSON.stringify({ status: 'INVENTORY_FAILED', code: error instanceof InventoryError ? error.code : 'INVENTORY_IO_OR_READER_FAILED' }) + '\n');
    process.exitCode = 1;
  });
}
