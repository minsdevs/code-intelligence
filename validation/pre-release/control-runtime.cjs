'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { preflightZip, zipEntryBytes, budget } = require('./inventory-candidate.cjs');

const MAX_JAR = 16 * 1024 * 1024;
const MAX_PROVENANCE = 1024 * 1024;
const MAIN_CLASS = 'dev.codeintelligence.desktop.DesktopControlApplication';
const CLASS_PREFIX = 'dev/codeintelligence/desktop/';
const REQUIRED_TOP = new Set([
  CLASS_PREFIX + 'DesktopControlApplication.class',
  CLASS_PREFIX + 'NativeLeaseWorker.class',
  CLASS_PREFIX + 'ManagedProcessWorker.class',
]);
const DEPENDENCIES = new Set([
  'tools.jackson.core:jackson-core',
  'tools.jackson.core:jackson-databind',
  'com.fasterxml.jackson.core:jackson-annotations',
]);
const sha256 = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
function fail(code) { throw Object.assign(new Error(code), { code }); }

function canonicalFile(file, maxBytes) {
  if (typeof file !== 'string' || !path.isAbsolute(file) || path.normalize(file) !== file) fail('CONTROL_PATH');
  let cursor = path.parse(file).root;
  for (const part of file.slice(cursor.length).split(path.sep).filter(Boolean)) {
    cursor = path.join(cursor, part);
    const stat = fs.lstatSync(cursor);
    if (stat.isSymbolicLink() || cursor !== file && !stat.isDirectory()) fail('CONTROL_PATH');
  }
  const real = fs.realpathSync(file); if (real !== file) fail('CONTROL_PATH');
  const stat = fs.lstatSync(file, { bigint: true });
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1n || stat.size <= 0n || stat.size > BigInt(maxBytes)
    || stat.mode & 0o7022n || typeof process.getuid === 'function' && stat.uid !== BigInt(process.getuid())) fail('CONTROL_FILE');
  const stamp = s => [s.dev, s.ino, s.size, s.mtimeNs, s.ctimeNs, s.nlink].join(':');
  const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
  try {
    if (stamp(fs.fstatSync(fd, { bigint: true })) !== stamp(stat)) fail('CONTROL_FILE');
    const size = Number(stat.size), bytes = Buffer.alloc(size + 1); let count = 0;
    while (count < bytes.length) {
      const n = fs.readSync(fd, bytes, count, bytes.length - count, count);
      if (!n) break; count += n;
    }
    if (count !== size || stamp(fs.fstatSync(fd, { bigint: true })) !== stamp(stat)
      || stamp(fs.lstatSync(file, { bigint: true })) !== stamp(stat)) fail('CONTROL_FILE');
    return bytes.subarray(0, size);
  } finally { fs.closeSync(fd); }
}

function parseJson(bytes) {
  if (!Buffer.isBuffer(bytes) || bytes.length > MAX_PROVENANCE) fail('CONTROL_PROVENANCE');
  try { return require('../t00/lib/json.cjs').parseJson(bytes); } catch { fail('CONTROL_PROVENANCE'); }
}

function parseManifest(bytes) {
  const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  const values = new Map(); let previous = null;
  for (const line of text.split(/\r?\n/)) {
    if (line === '') break;
    if (line.startsWith(' ')) {
      if (previous === null) fail('CONTROL_MANIFEST'); values.set(previous, values.get(previous) + line.slice(1)); continue;
    }
    const match = /^([A-Za-z0-9_-]+): (.*)$/.exec(line); if (!match) fail('CONTROL_MANIFEST');
    const key = match[1].toLowerCase(); if (values.has(key)) fail('CONTROL_MANIFEST');
    values.set(key, match[2]); previous = key;
  }
  if (values.get('main-class') !== MAIN_CLASS) fail('CONTROL_MANIFEST');
  if (values.has('class-path')) fail('CONTROL_MANIFEST');
  for (const key of values.keys()) if (/spring|boot|loader/.test(key)) fail('CONTROL_MANIFEST');
  return values;
}

function classFamily(name) {
  if (REQUIRED_TOP.has(name)) return true;
  return /^dev\/codeintelligence\/desktop\/(?:NativeLeaseWorker|ManagedProcessWorker)\$[^/]+\.class$/.test(name);
}

function compiledClasses(classRoot) {
  if (typeof classRoot !== 'string' || !path.isAbsolute(classRoot) || path.normalize(classRoot) !== classRoot || fs.realpathSync(classRoot) !== classRoot) fail('CONTROL_CLASS_ROOT');
  const rootStat = fs.lstatSync(classRoot); if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) fail('CONTROL_CLASS_ROOT');
  const base = path.join(classRoot, 'dev/codeintelligence/desktop');
  if (fs.realpathSync(base) !== base) fail('CONTROL_CLASS_ROOT');
  const result = new Map();
  for (const name of fs.readdirSync(base)) {
    if (!/^(?:DesktopControlApplication|NativeLeaseWorker|ManagedProcessWorker)(?:\$[^/]+)?\.class$/.test(name)) continue;
    const file = path.join(base, name);
    result.set(CLASS_PREFIX + name, sha256(canonicalFile(file, 4 * 1024 * 1024)));
  }
  for (const required of REQUIRED_TOP) if (!result.has(required)) fail('CONTROL_CLASS_SET');
  for (const name of result.keys()) if (!classFamily(name)) fail('CONTROL_CLASS_SET');
  return result;
}

function validateDependencies(value) {
  if (!Array.isArray(value) || value.length !== 3) fail('CONTROL_DEPENDENCIES');
  const seen = new Set(), result = [];
  for (const item of value) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) fail('CONTROL_DEPENDENCIES');
    const keys = Object.keys(item).sort(); if (keys.join(',') !== 'artifactId,fileName,groupId,sha256,version') fail('CONTROL_DEPENDENCIES');
    const key = `${item.groupId}:${item.artifactId}`;
    if (!DEPENDENCIES.has(key) || seen.has(key)) fail('CONTROL_DEPENDENCIES'); seen.add(key);
    if (typeof item.version !== 'string' || !/^[0-9][A-Za-z0-9._+-]*$/.test(item.version)) fail('CONTROL_DEPENDENCIES');
    if (typeof item.fileName !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._+-]*\.jar$/.test(item.fileName)) fail('CONTROL_DEPENDENCIES');
    if (typeof item.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(item.sha256)) fail('CONTROL_DEPENDENCIES');
    result.push({ ...item });
  }
  if (seen.size !== DEPENDENCIES.size) fail('CONTROL_DEPENDENCIES');
  return result;
}

async function verifyControlRuntime({ jarFile, provenanceFile, classRoot }) {
  const jar = canonicalFile(jarFile, MAX_JAR), provenanceBytes = canonicalFile(provenanceFile, MAX_PROVENANCE);
  const provenance = parseJson(provenanceBytes);
  if (!provenance || provenance.format !== 1 || provenance.kind !== 'DESKTOP_CONTROL_RUNTIME' || provenance.mainClass !== MAIN_CLASS) fail('CONTROL_PROVENANCE');
  if (Object.keys(provenance).sort().join(',') !== 'classes,dependencies,format,jarSha256,kind,licenses,mainClass') fail('CONTROL_PROVENANCE');
  const jarSha256 = sha256(jar); if (provenance.jarSha256 !== jarSha256) fail('CONTROL_JAR_HASH');
  const compiled = compiledClasses(classRoot);
  if (!provenance.classes || typeof provenance.classes !== 'object' || Array.isArray(provenance.classes)) fail('CONTROL_CLASS_SET');
  const declaredClasses = new Map(Object.entries(provenance.classes));
  if (declaredClasses.size !== compiled.size) fail('CONTROL_CLASS_SET');
  for (const [name, digest] of compiled) if (declaredClasses.get(name) !== digest || !/^[a-f0-9]{64}$/.test(digest)) fail('CONTROL_CLASS_SET');

  const usage = budget(), entries = preflightZip(jar, usage).entries, byName = new Map(entries.map(entry => [entry.name, entry]));
  if (entries.length > 10000 || entries.reduce((sum, entry) => sum + entry.size, 0) > 64 * 1024 * 1024) fail('CONTROL_JAR_LIMIT');
  const manifest = byName.get('META-INF/MANIFEST.MF'); if (!manifest || manifest.directory) fail('CONTROL_MANIFEST');
  const manifestValues = parseManifest(zipEntryBytes(jar, manifest, usage));
  const packagedClasses = entries.filter(entry => !entry.directory && classFamily(entry.name)).map(entry => entry.name).sort();
  if (JSON.stringify(packagedClasses) !== JSON.stringify([...compiled.keys()].sort())) fail('CONTROL_CLASS_SET');
  for (const entry of entries) {
    if (entry.directory) continue;
    if (entry.name === 'META-INF/MANIFEST.MF') continue;
    // Validate all compressed members, not only classes selected for comparison.
    zipEntryBytes(jar, entry, usage, 4 * 1024 * 1024);
    if (entry.name.endsWith('.class')) {
      const allowed = classFamily(entry.name)
        || /^tools\/jackson\//.test(entry.name)
        || /^com\/fasterxml\/jackson\/annotation\//.test(entry.name)
        || /^META-INF\/versions\/[0-9]+\/(?:tools\/jackson\/|com\/fasterxml\/jackson\/annotation\/)/.test(entry.name);
      if (!allowed || /(?:^|\/)org\/springframework\//.test(entry.name)) fail('CONTROL_EXTRA_CLASS');
    }
  }
  if (entries.some(entry => /^META-INF\/versions\/[0-9]+\//.test(entry.name))
      && manifestValues.get('multi-release') !== 'true') fail('CONTROL_MANIFEST');
  for (const [name, digest] of compiled) {
    const entry = byName.get(name); if (!entry || entry.directory) fail('CONTROL_CLASS_SET');
    if (sha256(zipEntryBytes(jar, entry, usage, 4 * 1024 * 1024)) !== digest) fail('CONTROL_CLASS_BYTES');
  }

  const dependencies = validateDependencies(provenance.dependencies);
  if (!Array.isArray(provenance.licenses)) fail('CONTROL_LICENSES');
  const licenses = [...provenance.licenses];
  if (new Set(licenses).size !== licenses.length) fail('CONTROL_LICENSES');
  const covered = new Set();
  for (const name of licenses) {
    if (typeof name !== 'string' || !/^META-INF\/licenses\/[A-Za-z0-9._+-]+\/[A-Za-z0-9._+-]+\/[A-Za-z0-9._+-]+\/.+/.test(name)) fail('CONTROL_LICENSES');
    const entry = byName.get(name); if (!entry || entry.directory) fail('CONTROL_LICENSES');
    zipEntryBytes(jar, entry, usage, 1024 * 1024);
    const match = /^META-INF\/licenses\/([^/]+)\/([^/]+)\/([^/]+)\/(.+)$/.exec(name);
    const key = `${match[1]}:${match[2]}`; if (!DEPENDENCIES.has(key) || match[3] !== dependencies.find(dep => `${dep.groupId}:${dep.artifactId}` === key)?.version) fail('CONTROL_LICENSES');
    if (/LICENSE/i.test(match[4])) covered.add(key);
  }
  for (const key of DEPENDENCIES) if (!covered.has(key)) fail('CONTROL_LICENSES');

  return { jarSha256, provenanceSha256: sha256(provenanceBytes), classesCount: compiled.size, entriesCount: entries.length, dependencies, licenses };
}

module.exports = Object.freeze({ verifyControlRuntime });
