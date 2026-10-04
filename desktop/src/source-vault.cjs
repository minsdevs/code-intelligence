'use strict';

// Main-process primitive only. It deliberately has no Electron, renderer, env-key, or network access.
const crypto = require('node:crypto');
const fs = require('node:fs/promises');
const { constants } = require('node:fs');
const path = require('node:path');
const { acquireNativeOwnerLock } = require('./native-owner-locks.cjs');

const MAX_FILE_BYTES = 2 * 1024 * 1024;
const MAX_HEADER_BYTES = 2048;
const MAX_WRAPPED_KEYRING_BYTES = 64 * 1024;
const MAX_KEYRING_BYTES = 32 * 1024;
const MAX_KEYS = 64;
const MAX_PENDING_OPERATIONS = 4;
const MAX_STORE_BYTES = 10 * 1024 * 1024 * 1024;
const MAX_STORE_ENTRIES = 200_000;
const MAGIC = Buffer.from('CISRCBLB');
const KEYRING_FORMAT = 'code-intelligence-source-keyring';
const BLOB_FORMAT = 'code-intelligence-source-blob';
const FORMAT_MAJOR = 1;
const KEY_ID = /^[a-f0-9]{32}$/;
const SHA256 = /^[a-f0-9]{64}$/;
const INSTALLATION_ID = /^[A-Za-z0-9_-]{1,128}$/;
const PROJECT_ID = /^[1-9][0-9]{0,18}$/;
const MAX_PROJECT_ID = 9223372036854775807n;
const PENDING_FILE = /^\.pending-[a-f0-9]{32}$/;

class SourceVaultError extends Error {
  constructor(code) {
    super({
      SOURCE_VAULT_ARGUMENT: 'Invalid source vault argument.',
      SOURCE_VAULT_UNSAFE_PATH: 'Source vault path permissions or identity are unsafe.',
      SOURCE_VAULT_LOCKED: 'Source vault ownership requires recovery or another owner to close.',
      SOURCE_VAULT_KEY_MISSING: 'Source encryption keys are missing; do not replace them.',
      SOURCE_VAULT_KEY_INVALID: 'Source encryption keys cannot be validated.',
      SOURCE_VAULT_WRAPPING_UNAVAILABLE: 'Secure source key wrapping is unavailable.',
      SOURCE_VAULT_NOT_FRESH: 'Source vault creation requires fresh source and key state.',
      SOURCE_VAULT_MODE: 'Source operation is not permitted for this vault mode.',
      SOURCE_VAULT_UNSUPPORTED: 'Source vault format or platform is unsupported.',
      SOURCE_VAULT_LIMIT: 'Source vault limit exceeded.',
      SOURCE_VAULT_MISSING: 'The requested source blob is unavailable.',
      SOURCE_VAULT_INTEGRITY: 'Source blob authentication or expected content validation failed.',
      SOURCE_VAULT_CLOSED: 'Source vault is closed or requires reopening after a failed key update.',
      SOURCE_VAULT_IO: 'Source vault operation failed; no successful publication is acknowledged.',
    }[code] || 'Source vault operation failed.');
    this.name = 'SourceVaultError';
    this.code = code;
  }
}

function fail(code) { throw new SourceVaultError(code); }
function fullMatch(value, pattern) {
  return typeof value === 'string' && value.match(pattern)?.[0] === value;
}
function safeError(error) {
  return error instanceof SourceVaultError ? error : new SourceVaultError('SOURCE_VAULT_IO');
}
function sameIdentity(a, b) {
  if (a.platform === 'win32' || b.platform === 'win32')
    return a.platform === b.platform && a.identity === b.identity;
  return a.dev === b.dev && a.ino === b.ino;
}
function sameFileState(a, b) {
  if (a.platform === 'win32' || b.platform === 'win32')
    return sameIdentity(a, b) && a.token === b.token;
  return sameIdentity(a, b) && a.size === b.size && a.mtimeNs === b.mtimeNs && a.ctimeNs === b.ctimeNs;
}
function checkPrivate(stat, directory) {
  // Native sessions enforce SID/DACL and retained-ancestor confinement.
  if (stat.platform === 'win32') {
    if (stat.kind !== (directory ? 'directory' : 'file')) fail('SOURCE_VAULT_UNSAFE_PATH');
    return;
  }
  if ((directory ? !stat.isDirectory() : !stat.isFile()) || stat.isSymbolicLink()
      || stat.uid !== BigInt(process.getuid()) || (stat.mode & 0o7777n) !== (directory ? 0o700n : 0o600n)
      || (!directory && stat.nlink !== 1n)) fail('SOURCE_VAULT_UNSAFE_PATH');
}
function rootArgument(value) {
  if (typeof value !== 'string' || !path.isAbsolute(value) || value.includes('\0')
      || Buffer.byteLength(value) > 4096 || path.resolve(value) !== value
      || path.parse(value).root === value) fail('SOURCE_VAULT_ARGUMENT');
  return value;
}
function projectArgument(value) {
  const id = typeof value === 'number' && Number.isSafeInteger(value) ? String(value) : value;
  if (!fullMatch(id, PROJECT_ID) || BigInt(id) > MAX_PROJECT_ID)
    fail('SOURCE_VAULT_ARGUMENT');
  return id;
}
function readArguments(value) {
  if (!value || typeof value !== 'object') fail('SOURCE_VAULT_ARGUMENT');
  const projectId = projectArgument(value.projectId);
  if (!fullMatch(value.sha256, SHA256)
      || !Number.isSafeInteger(value.byteSize) || value.byteSize < 0 || value.byteSize > MAX_FILE_BYTES)
    fail('SOURCE_VAULT_ARGUMENT');
  return { projectId, sha256: value.sha256, byteSize: value.byteSize };
}
function ciphertextArguments(value) {
  const expected = readArguments(value);
  if (!fullMatch(value.keyId, KEY_ID)) fail('SOURCE_VAULT_ARGUMENT');
  if (value.format !== undefined && value.format !== FORMAT_MAJOR) fail('SOURCE_VAULT_UNSUPPORTED');
  return { ...expected, keyId: value.keyId };
}
function digest(bytes) { return crypto.createHash('sha256').update(bytes).digest('hex'); }
function fields(value, names) {
  return value && typeof value === 'object' && !Array.isArray(value)
    && Object.keys(value).length === names.length && names.every(name => Object.hasOwn(value, name));
}
function base64(value, size, code) {
  if (typeof value !== 'string' || value.length !== Math.ceil(size / 3) * 4) fail(code);
  const bytes = Buffer.from(value, 'base64');
  if (bytes.length !== size || bytes.toString('base64') !== value) { bytes.fill(0); fail(code); }
  return bytes;
}
async function statOrMissing(file) {
  try { return await fs.lstat(file, { bigint: true }); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}

// Callers canonicalize the trusted OS/userData parent before appending module-owned paths.
// These pathname checks are not native descriptor-relative ancestor-race confinement.
async function pathChain(directory) {
  let current = path.parse(directory).root;
  for (const part of directory.slice(current.length).split(path.sep).filter(Boolean)) {
    current = path.join(current, part);
    const stat = await fs.lstat(current, { bigint: true });
    if (!stat.isDirectory() || stat.isSymbolicLink()) fail('SOURCE_VAULT_UNSAFE_PATH');
  }
}
async function privateDirectory(directory, expected) {
  await pathChain(directory);
  const stat = await fs.lstat(directory, { bigint: true });
  checkPrivate(stat, true);
  if (expected && !sameIdentity(stat, expected)) fail('SOURCE_VAULT_UNSAFE_PATH');
  return stat;
}
async function syncDirectory(directory) {
  const before = await privateDirectory(directory);
  const handle = await fs.open(directory, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  try {
    const opened = await handle.stat({ bigint: true });
    checkPrivate(opened, true);
    if (!sameIdentity(before, opened)) fail('SOURCE_VAULT_UNSAFE_PATH');
    await handle.sync();
    await privateDirectory(directory, before);
  } finally { await handle.close(); }
}
async function ensureDirectory(directory) {
  await privateDirectory(path.dirname(directory));
  let created = false;
  try { await fs.mkdir(directory, { mode: 0o700 }); created = true; }
  catch (error) { if (error.code !== 'EEXIST') throw error; }
  const stat = await privateDirectory(directory);
  if (created) await syncDirectory(path.dirname(directory));
  return stat;
}
async function directoryEmpty(directory) {
  const entries = await fs.opendir(directory);
  try { return (await entries.read()) === null; } finally { await entries.close(); }
}

function directoryEntry(stat) {
  return stat.platform === 'win32' ? stat : { kind: 'directory', dev: stat.dev, ino: stat.ino };
}
function quotaArgument(value, maximum) {
  if (!Number.isSafeInteger(value) || value < 1 || value > maximum) fail('SOURCE_VAULT_ARGUMENT');
  return value;
}
async function scanDirectory(directory, depth, prefix, entries, maximum) {
  const before = await privateDirectory(directory);
  const stream = await fs.opendir(directory);
  try {
    for await (const entry of stream) {
      if (entries.size >= maximum) fail('SOURCE_VAULT_LIMIT');
      const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
      const absolute = path.join(directory, entry.name);
      const stat = await fs.lstat(absolute, { bigint: true });
      if (depth < 2) {
        if (depth === 0) {
          try { projectArgument(entry.name); } catch { fail('SOURCE_VAULT_UNSAFE_PATH'); }
        } else if (!fullMatch(entry.name, SHA256)) fail('SOURCE_VAULT_UNSAFE_PATH');
        checkPrivate(stat, true);
        entries.set(relative, directoryEntry(stat));
        await scanDirectory(absolute, depth + 1, relative, entries, maximum);
      } else {
        if (entry.name !== 'blob.bin' && !fullMatch(entry.name, PENDING_FILE)) fail('SOURCE_VAULT_UNSAFE_PATH');
        checkPrivate(stat, false);
        if (stat.size > BigInt(MAX_FILE_BYTES + MAX_HEADER_BYTES + 12)) fail('SOURCE_VAULT_LIMIT');
        entries.set(relative, { kind: 'file', bytes: Number(stat.size) });
      }
    }
  } finally { await stream.close().catch(() => {}); }
  const after = await privateDirectory(directory, before);
  if (before.mtimeNs !== after.mtimeNs || before.ctimeNs !== after.ctimeNs) fail('SOURCE_VAULT_UNSAFE_PATH');
}
async function scanSourceStore(sourceRoot, maximum) {
  const entries = new Map();
  await scanDirectory(sourceRoot, 0, '', entries, maximum);
  let bytes = 0;
  for (const entry of entries.values()) if (entry.kind === 'file') bytes += entry.bytes;
  return { entries, bytes };
}
async function readPrivateFile(file, maximum, missingCode) {
  await privateDirectory(path.dirname(file));
  const before = await statOrMissing(file);
  if (!before) fail(missingCode);
  checkPrivate(before, false);
  if (before.size > BigInt(maximum)) fail('SOURCE_VAULT_LIMIT');
  const handle = await fs.open(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  let bytes;
  try {
    const opened = await handle.stat({ bigint: true });
    checkPrivate(opened, false);
    if (!sameFileState(before, opened)) fail('SOURCE_VAULT_UNSAFE_PATH');
    bytes = Buffer.alloc(Number(opened.size));
    let offset = 0;
    while (offset < bytes.length) {
      const { bytesRead } = await handle.read(bytes, offset, bytes.length - offset, offset);
      if (bytesRead === 0) fail('SOURCE_VAULT_INTEGRITY');
      offset += bytesRead;
    }
    const after = await handle.stat({ bigint: true });
    checkPrivate(after, false);
    const current = await fs.lstat(file, { bigint: true });
    checkPrivate(current, false);
    if (!sameFileState(opened, after) || !sameFileState(after, current)) fail('SOURCE_VAULT_UNSAFE_PATH');
    return { bytes, stat: after };
  } catch (error) {
    bytes?.fill(0);
    throw error;
  } finally { await handle.close(); }
}
async function unlinkOwned(file, expected) {
  const current = await statOrMissing(file);
  if (!current) return;
  checkPrivate(current, false);
  if (!sameIdentity(current, expected)) fail('SOURCE_VAULT_UNSAFE_PATH');
  await fs.unlink(file);
}

async function acquireLock(directory) {
  const file = path.join(directory, 'owner.lock');
  let handle;
  try { handle = await fs.open(file, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600); }
  catch (error) { if (error.code === 'EEXIST' || error.code === 'ELOOP') fail('SOURCE_VAULT_LOCKED'); throw error; }
  let stat;
  try {
    stat = await handle.stat({ bigint: true });
    checkPrivate(stat, false);
    await handle.writeFile(JSON.stringify({ format: 1, pid: process.pid, owner: crypto.randomBytes(16).toString('hex') }));
    await handle.sync();
    await syncDirectory(directory);
  } catch (error) {
    await handle.close();
    if (stat) await unlinkOwned(file, stat).catch(() => {});
    throw error;
  }
  const written = await handle.stat({ bigint: true });
  return {
    async check() {
      const current = await statOrMissing(file);
      if (!current) fail('SOURCE_VAULT_LOCKED');
      checkPrivate(current, false);
      if (!sameFileState(current, written)) fail('SOURCE_VAULT_LOCKED');
    },
    async release() {
      try { await unlinkOwned(file, stat); await syncDirectory(directory); }
      finally { await handle.close(); }
    },
  };
}

// Only ciphertext/wrapped keys reach this writer. The caller owns the exclusive vault lock.
async function atomicWrite(directory, filename, bytes, { previous = null, fault, kind, checkOwnership }) {
  const target = path.join(directory, filename);
  const temporary = path.join(directory, `.pending-${crypto.randomBytes(16).toString('hex')}`);
  const directoryStat = await privateDirectory(directory);
  let handle;
  let temporaryStat;
  let renamed = false;
  try {
    await checkOwnership();
    handle = await fs.open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    temporaryStat = await handle.stat({ bigint: true });
    checkPrivate(temporaryStat, false);
    await handle.writeFile(bytes);
    await fault?.(`${kind}:temp-written`);
    await handle.sync();
    await fault?.(`${kind}:file-synced`);
    const written = await handle.stat({ bigint: true });
    checkPrivate(written, false);
    if (written.size !== BigInt(bytes.length)) fail('SOURCE_VAULT_IO');
    await handle.close(); handle = null;
    await privateDirectory(directory, directoryStat);
    await fault?.(`${kind}:before-rename`);
    await checkOwnership();
    const staged = await fs.lstat(temporary, { bigint: true });
    checkPrivate(staged, false);
    if (!sameFileState(staged, written)) fail('SOURCE_VAULT_UNSAFE_PATH');
    const current = await statOrMissing(target);
    if (previous) {
      if (!current) fail('SOURCE_VAULT_KEY_MISSING');
      checkPrivate(current, false);
      if (!sameFileState(current, previous)) fail('SOURCE_VAULT_UNSAFE_PATH');
    } else if (current) fail('SOURCE_VAULT_NOT_FRESH');
    await fs.rename(temporary, target);
    renamed = true;
    await fault?.(`${kind}:renamed`);
    await syncDirectory(directory);
    await fault?.(`${kind}:directory-synced`);
    await checkOwnership();
    const committed = await readPrivateFile(target, bytes.length, 'SOURCE_VAULT_MISSING');
    if (!sameIdentity(committed.stat, written) || !committed.bytes.equals(bytes)) fail('SOURCE_VAULT_INTEGRITY');
    return committed.stat;
  } finally {
    if (handle) await handle.close();
    if (!renamed && temporaryStat) await unlinkOwned(temporary, temporaryStat);
  }
}

function keyringPlaintext(installationId, keys) {
  return Buffer.from(JSON.stringify({
    format: KEYRING_FORMAT, major: FORMAT_MAJOR, purpose: 'source', installationId,
    revision: keys.size, activeKeyId: [...keys.keys()].at(-1),
    keys: [...keys].map(([keyId, key]) => ({ keyId, material: key.toString('base64') })),
  }), 'utf8');
}
function parseKeyring(bytes, installationId) {
  if (!Buffer.isBuffer(bytes) || bytes.length === 0 || bytes.length > MAX_KEYRING_BYTES) fail('SOURCE_VAULT_KEY_INVALID');
  let value;
  try { value = JSON.parse(bytes.toString('utf8')); } catch { fail('SOURCE_VAULT_KEY_INVALID'); }
  if (value?.major !== FORMAT_MAJOR) fail('SOURCE_VAULT_UNSUPPORTED');
  if (!fields(value, ['format', 'major', 'purpose', 'installationId', 'revision', 'activeKeyId', 'keys'])
      || value.format !== KEYRING_FORMAT || value.purpose !== 'source' || value.installationId !== installationId
      || !fullMatch(value.activeKeyId, KEY_ID)
      || !Array.isArray(value.keys) || value.keys.length < 1 || value.keys.length > MAX_KEYS
      || value.revision !== value.keys.length) fail('SOURCE_VAULT_KEY_INVALID');
  const keys = new Map();
  try {
    for (const entry of value.keys) {
      if (!fields(entry, ['keyId', 'material']) || !fullMatch(entry.keyId, KEY_ID)
          || keys.has(entry.keyId)) fail('SOURCE_VAULT_KEY_INVALID');
      keys.set(entry.keyId, base64(entry.material, 32, 'SOURCE_VAULT_KEY_INVALID'));
    }
    const canonical = keyringPlaintext(installationId, keys);
    try {
      if (value.activeKeyId !== [...keys.keys()].at(-1) || !canonical.equals(bytes)) fail('SOURCE_VAULT_KEY_INVALID');
    } finally { canonical.fill(0); }
    return keys;
  } catch (error) { for (const key of keys.values()) key.fill(0); throw error; }
}
async function wrapKeyring(wrapper, installationId, keys) {
  const plaintext = keyringPlaintext(installationId, keys);
  try {
    if (await wrapper.isAvailable() !== true) fail('SOURCE_VAULT_WRAPPING_UNAVAILABLE');
    const wrapped = await wrapper.wrap(plaintext);
    if (!Buffer.isBuffer(wrapped) || wrapped.length === 0 || wrapped.length > MAX_WRAPPED_KEYRING_BYTES
        || wrapped.equals(plaintext)) fail('SOURCE_VAULT_KEY_INVALID');
    return Buffer.from(wrapped);
  } catch (error) {
    if (error instanceof SourceVaultError) throw error;
    fail('SOURCE_VAULT_WRAPPING_UNAVAILABLE');
  } finally { plaintext.fill(0); }
}
async function loadKeyring(file, wrapper, installationId) {
  const wrapped = await readPrivateFile(file, MAX_WRAPPED_KEYRING_BYTES, 'SOURCE_VAULT_KEY_MISSING');
  let plaintext;
  try {
    plaintext = await wrapper.unwrap(wrapped.bytes);
    return { keys: parseKeyring(plaintext, installationId), stat: wrapped.stat };
  } catch (error) {
    if (error instanceof SourceVaultError) throw error;
    fail('SOURCE_VAULT_KEY_INVALID');
  } finally { if (Buffer.isBuffer(plaintext)) plaintext.fill(0); wrapped.bytes.fill(0); }
}

async function openPosixEnrollment(file, installationId, wrapper, fresh) {
  const expected = Buffer.from(JSON.stringify({ format: 'code-intelligence-source-enrollment', major: 1, installationId }));
  let wrapped, readback, plaintext;
  try {
    if (fresh) {
      try { wrapped = await wrapper.wrap(expected); } catch { fail('SOURCE_VAULT_WRAPPING_UNAVAILABLE'); }
      if (!Buffer.isBuffer(wrapped) || !wrapped.length || wrapped.length > 4096 || wrapped.equals(expected)) fail('SOURCE_VAULT_KEY_INVALID');
      const directory = path.dirname(file), before = await privateDirectory(directory);
      const handle = await fs.open(file, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
      try {
        checkPrivate(await handle.stat({ bigint: true }), false);
        await handle.writeFile(wrapped); await handle.sync();
        await privateDirectory(directory, before); await syncDirectory(directory);
      } finally { await handle.close(); }
      // Incomplete enrollment remains evidence; never unlink it to retry key generation.
    }
    readback = await readPrivateFile(file, 4096, 'SOURCE_VAULT_KEY_MISSING');
    try { plaintext = await wrapper.unwrap(readback.bytes); } catch { fail('SOURCE_VAULT_KEY_INVALID'); }
    if (!Buffer.isBuffer(plaintext) || !plaintext.equals(expected)) fail('SOURCE_VAULT_KEY_INVALID');
    return readback.stat;
  } finally {
    expected.fill(0); if (Buffer.isBuffer(wrapped)) wrapped.fill(0);
    readback?.bytes.fill(0); if (Buffer.isBuffer(plaintext)) plaintext.fill(0);
  }
}

function aad(fields) {
  return Buffer.from(JSON.stringify({ format: BLOB_FORMAT, major: FORMAT_MAJOR,
    installationId: fields.installationId, projectId: fields.projectId, keyId: fields.keyId,
    sha256: fields.sha256, byteSize: fields.byteSize }), 'utf8');
}
function encryptBlob(metadata, plaintext, key) {
  const nonce = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, nonce, { authTagLength: 16 });
  cipher.setAAD(aad(metadata));
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const header = Buffer.from(JSON.stringify({ ...JSON.parse(aad(metadata).toString('utf8')),
    nonce: nonce.toString('base64'), tag: cipher.getAuthTag().toString('base64') }), 'utf8');
  const prefix = Buffer.alloc(12);
  MAGIC.copy(prefix); prefix.writeUInt32BE(header.length, 8);
  return Buffer.concat([prefix, header, ciphertext]);
}
function decryptBlob(envelope, expected, installationId, keys) {
  if (envelope.length < 12 || !envelope.subarray(0, 8).equals(MAGIC)) fail('SOURCE_VAULT_INTEGRITY');
  const headerSize = envelope.readUInt32BE(8);
  if (headerSize < 1 || headerSize > MAX_HEADER_BYTES || 12 + headerSize > envelope.length) fail('SOURCE_VAULT_INTEGRITY');
  const encoded = envelope.subarray(12, 12 + headerSize);
  let header;
  try { header = JSON.parse(encoded.toString('utf8')); } catch { fail('SOURCE_VAULT_INTEGRITY'); }
  if (header?.major !== FORMAT_MAJOR) fail('SOURCE_VAULT_UNSUPPORTED');
  if (!fields(header, ['format', 'major', 'installationId', 'projectId', 'keyId', 'sha256', 'byteSize', 'nonce', 'tag'])
      || header.format !== BLOB_FORMAT || header.installationId !== installationId
      || header.projectId !== expected.projectId || header.sha256 !== expected.sha256
      || header.byteSize !== expected.byteSize || envelope.length !== 12 + headerSize + expected.byteSize
      || (expected.keyId !== undefined && header.keyId !== expected.keyId)
      || !fullMatch(header.keyId, KEY_ID)) fail('SOURCE_VAULT_INTEGRITY');
  const nonce = base64(header.nonce, 12, 'SOURCE_VAULT_INTEGRITY');
  const tag = base64(header.tag, 16, 'SOURCE_VAULT_INTEGRITY');
  const canonical = Buffer.from(JSON.stringify({ ...JSON.parse(aad(header).toString('utf8')),
    nonce: header.nonce, tag: header.tag }), 'utf8');
  if (!canonical.equals(encoded)) fail('SOURCE_VAULT_INTEGRITY');
  const key = keys.get(header.keyId);
  if (!key) fail('SOURCE_VAULT_KEY_MISSING');
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, nonce, { authTagLength: 16 });
  decipher.setAAD(aad(header)); decipher.setAuthTag(tag);
  let unauthenticated;
  let plaintext;
  try {
    unauthenticated = decipher.update(envelope.subarray(12 + headerSize));
    plaintext = Buffer.concat([unauthenticated, decipher.final()]);
    if (plaintext.length !== expected.byteSize || crypto.createHash('sha256').update(plaintext).digest('hex') !== expected.sha256)
      fail('SOURCE_VAULT_INTEGRITY');
    return { bytes: plaintext, keyId: header.keyId };
  } catch {
    plaintext?.fill(0);
    fail('SOURCE_VAULT_INTEGRITY');
  } finally { unauthenticated?.fill(0); }
}

const posixStorage = { privateDirectory, ensureDirectory, directoryEmpty, statOrMissing,
  readPrivateFile, scanDirectory, scanSourceStore, atomicWrite, syncDirectory,
  mkdir: directory => fs.mkdir(directory, { mode: 0o700 }), entries: directory => fs.opendir(directory) };

async function initialize(options, fresh, restoreStage = false) {
  let lock;
  let keys;
  let nativeStorage;
  try {
    if (!options || typeof options !== 'object') fail('SOURCE_VAULT_ARGUMENT');
    const windows = process.platform === 'win32';
    if (windows ? !options.windowsBoundary || options.ownerLocks === undefined
      : typeof process.getuid !== 'function' || !constants.O_NOFOLLOW || !constants.O_DIRECTORY)
      fail('SOURCE_VAULT_UNSUPPORTED');
    const safetyRoot = rootArgument(options.safetyRoot);
    const sourceRoot = rootArgument(options.sourceRoot);
    const { installationId, wrapper, fault, ownerLocks } = options;
    const maxStoreBytes = quotaArgument(options.maxStoreBytes ?? MAX_STORE_BYTES, MAX_STORE_BYTES);
    const maxStoreEntries = quotaArgument(options.maxStoreEntries ?? MAX_STORE_ENTRIES, MAX_STORE_ENTRIES);
    if (!fullMatch(installationId, INSTALLATION_ID)
        || !wrapper || !['isAvailable', 'wrap', 'unwrap'].every(name => typeof wrapper[name] === 'function')
        || (fault !== undefined && typeof fault !== 'function')) fail('SOURCE_VAULT_ARGUMENT');
    const safetyComparison = windows ? safetyRoot.toLowerCase() : safetyRoot;
    const sourceComparison = windows ? sourceRoot.toLowerCase() : sourceRoot;
    if (safetyComparison === sourceComparison || safetyComparison.startsWith(sourceComparison + path.sep)
        || sourceComparison.startsWith(safetyComparison + path.sep)) fail('SOURCE_VAULT_UNSAFE_PATH');
    if (await wrapper.isAvailable() !== true) fail('SOURCE_VAULT_WRAPPING_UNAVAILABLE');
    if (windows) nativeStorage = await require('./source-vault-windows.cjs').openSourceVaultStorage({
      windowsBoundary: options.windowsBoundary, safetyRoot, sourceRoot, fail, sameIdentity, sameFileState,
      projectArgument, maxBlobBytes: MAX_FILE_BYTES + MAX_HEADER_BYTES + 12 });
    const { privateDirectory, ensureDirectory, directoryEmpty, statOrMissing, readPrivateFile,
      scanDirectory, scanSourceStore, atomicWrite, syncDirectory, mkdir, entries: directoryEntries } = nativeStorage || posixStorage;
    await privateDirectory(path.dirname(safetyRoot));
    await privateDirectory(path.dirname(sourceRoot));
    const safetyStat = fresh ? await ensureDirectory(safetyRoot) : await privateDirectory(safetyRoot);
    const sourceStat = fresh ? await ensureDirectory(sourceRoot) : await privateDirectory(sourceRoot);
    const keyDirectory = path.join(safetyRoot, 'source-vault');
    const enrollmentFile = path.join(safetyRoot, 'source-vault.enrollment');
    let enrollmentStat;
    if (fresh && await statOrMissing(keyDirectory, { directory: true })) fail('SOURCE_VAULT_NOT_FRESH');
    const priorEnrollment = await statOrMissing(enrollmentFile);
    if (fresh && priorEnrollment) fail('SOURCE_VAULT_NOT_FRESH');
    if (!fresh && !priorEnrollment) fail('SOURCE_VAULT_KEY_MISSING');
    if (windows) {
      const enrollment = Buffer.from('source-vault-enrolled-v1');
      try {
        // This immutable authenticated marker commits enrollment BEFORE key generation.
        // Its presence forbids fresh enrollment even if the mutable key directory disappears.
        const state = await require('./windows-authenticated-state.cjs').openAuthenticatedState({
          storage: nativeStorage.storage(enrollmentFile), file: enrollmentFile,
          installationId, purpose: 'source-enrollment', mode: 'append',
          seal: bytes => wrapper.wrap(bytes), unseal: bytes => wrapper.unwrap(bytes),
          maxPayloadBytes: 64, maxEncodedBytes: 4096, maxRecords: 1, fresh, initialValue: enrollment });
        enrollmentStat = await statOrMissing(enrollmentFile);
        const checked = await state.read();
        try { if (!checked.equals(enrollment)) fail('SOURCE_VAULT_KEY_INVALID'); }
        finally { checked.fill(0); }
      } catch { fail('SOURCE_VAULT_KEY_INVALID'); }
      finally { enrollment.fill(0); }
    } else enrollmentStat = await openPosixEnrollment(enrollmentFile, installationId, wrapper, fresh);
    if (fresh) {
      // An existing directory marks prior initialization, even if all keys/blobs were lost.
      // Never remove it automatically after an interrupted create or treat unlink as a commit.
      try { await mkdir(keyDirectory); }
      catch (error) { if (error.code === 'EEXIST') fail('SOURCE_VAULT_NOT_FRESH'); throw error; }
      await syncDirectory(safetyRoot);
    }
    const keyStat = await privateDirectory(keyDirectory);
    if (ownerLocks !== undefined) {
      try {
        const native = await acquireNativeOwnerLock(ownerLocks, { safetyRoot, kind: 'source-vault', installationId });
        lock = Object.freeze({ isHeld: native.isHeld, ...Object.fromEntries(['check', 'release'].map(name => [name, async () => {
          try { await native[name](); } catch { fail('SOURCE_VAULT_LOCKED'); }
        }])) });
      } catch { fail('SOURCE_VAULT_LOCKED'); }
    } else lock = await acquireLock(keyDirectory);
    const checkOwnership = () => lock.check();
    const keyFile = path.join(keyDirectory, 'source-keyring.wrapped');
    let keyFileStat;
    let keyState;
    const openWindowsKeys = async initialValue => {
      try {
        return await require('./windows-authenticated-state.cjs').openAuthenticatedState({
          storage: nativeStorage.storage(keyFile), file: keyFile, installationId, purpose: 'source-keyring',
          mode: 'append', seal: bytes => wrapper.wrap(bytes), unseal: bytes => wrapper.unwrap(bytes),
          maxPayloadBytes: MAX_KEYRING_BYTES, maxEncodedBytes: MAX_WRAPPED_KEYRING_BYTES,
          maxRecords: MAX_KEYS, fresh, initialValue });
      } catch { fail('SOURCE_VAULT_KEY_INVALID'); }
    };
    if (fresh) {
      if (!await directoryEmpty(sourceRoot) || await statOrMissing(keyFile)) fail('SOURCE_VAULT_NOT_FRESH');
      // Only owner.lock is permitted here. Interrupted key creation requires explicit recovery/open.
      const entries = await directoryEntries(keyDirectory);
      try { for await (const entry of entries) if (entry.name !== 'owner.lock') fail('SOURCE_VAULT_NOT_FRESH'); }
      finally { if (entries.close) await entries.close().catch(() => {}); }
      keys = new Map([[crypto.randomBytes(16).toString('hex'), crypto.randomBytes(32)]]);
      if (windows) {
        const plaintext = keyringPlaintext(installationId, keys);
        try {
          await checkOwnership(); keyState = await openWindowsKeys(plaintext);
          keyFileStat = await statOrMissing(keyFile);
          const checked = await keyState.read();
          try { if (!checked.equals(plaintext)) fail('SOURCE_VAULT_KEY_INVALID'); }
          finally { checked.fill(0); }
        } finally { plaintext.fill(0); }
      } else {
        const wrapped = await wrapKeyring(wrapper, installationId, keys);
        try { keyFileStat = await atomicWrite(keyDirectory, 'source-keyring.wrapped', wrapped, { fault, kind: 'keyring', checkOwnership }); }
        finally { wrapped.fill(0); }
      }
    } else if (windows) {
      if (!await statOrMissing(keyFile)) fail('SOURCE_VAULT_KEY_MISSING');
      keyState = await openWindowsKeys();
      keyFileStat = await statOrMissing(keyFile);
      const plaintext = await keyState.read();
      try { keys = parseKeyring(plaintext, installationId); }
      finally { plaintext.fill(0); }
    } else {
      ({ keys, stat: keyFileStat } = await loadKeyring(keyFile, wrapper, installationId));
    }
    // A trusted caller creates a new private stage, closes the live vault, then opens this
    // factory with the existing safety area B. Never resume into or merge a populated stage.
    if (restoreStage && !await directoryEmpty(sourceRoot)) fail('SOURCE_VAULT_NOT_FRESH');
    const store = await scanSourceStore(sourceRoot, maxStoreEntries);
    if (restoreStage && store.entries.size !== 0) fail('SOURCE_VAULT_NOT_FRESH');

    let closed = false;
    let closing = false;
    let poisoned = false;
    let closePromise;
    let pending = 0;
    let queue = Promise.resolve();
    const ensureUsable = () => {
      nativeStorage?.assertLive();
      if (closed || closing || poisoned || ownerLocks !== undefined && !lock.isHeld()) fail('SOURCE_VAULT_CLOSED');
    };
    const verifyRoots = async () => {
      await privateDirectory(safetyRoot, safetyStat);
      await privateDirectory(sourceRoot, sourceStat);
      await privateDirectory(keyDirectory, keyStat);
      await lock.check();
      const enrollment = await statOrMissing(enrollmentFile);
      if (!enrollment) fail('SOURCE_VAULT_KEY_MISSING');
      checkPrivate(enrollment, false);
      if (!sameFileState(enrollment, enrollmentStat)) fail('SOURCE_VAULT_KEY_INVALID');
      const current = await statOrMissing(keyFile);
      if (!current) fail('SOURCE_VAULT_KEY_MISSING');
      checkPrivate(current, false);
      if (!sameFileState(current, keyFileStat)) fail('SOURCE_VAULT_KEY_INVALID');
    };
    const publicInfo = () => Object.freeze({ format: FORMAT_MAJOR, installationId,
      activeKeyId: [...keys.keys()].at(-1), keyIds: Object.freeze([...keys.keys()]),
      store: Object.freeze({ storedBytes: store.bytes, maxStoreBytes, entries: store.entries.size, maxStoreEntries }) });
    const enqueue = (operation, cleanup) => {
      try {
        ensureUsable();
        if (pending >= MAX_PENDING_OPERATIONS) fail('SOURCE_VAULT_LIMIT');
      } catch (error) { cleanup?.(); return Promise.reject(safeError(error)); }
      pending += 1;
      const result = queue.then(async () => {
        if (poisoned) fail('SOURCE_VAULT_CLOSED');
        await verifyRoots();
        return operation();
      }).catch(error => { throw safeError(error); }).finally(() => { pending -= 1; cleanup?.(); });
      queue = result.catch(() => {});
      return result;
    };
    const address = ({ projectId, sha256 }) => path.join(sourceRoot, projectId, sha256);
    // Account only the attempted address after success/failure, avoiding a full-store O(n²) rescan.
    // The exclusive owner contract forbids external store mutations while this handle is live.
    const accountAttempt = async (expected) => {
      const projectDirectory = path.join(sourceRoot, expected.projectId);
      const projectStat = await statOrMissing(projectDirectory, { directory: true });
      if (!projectStat) return;
      checkPrivate(projectStat, true);
      const knownProject = store.entries.get(expected.projectId);
      if (knownProject && !sameIdentity(knownProject, projectStat)) fail('SOURCE_VAULT_UNSAFE_PATH');
      store.entries.set(expected.projectId, directoryEntry(projectStat));
      const directory = address(expected);
      const stat = await statOrMissing(directory, { directory: true });
      if (!stat) return;
      checkPrivate(stat, true);
      const prefix = `${expected.projectId}/${expected.sha256}`;
      const discovered = new Map([[prefix, directoryEntry(stat)]]);
      await scanDirectory(directory, 2, prefix, discovered, maxStoreEntries);
      for (const [name, entry] of discovered) {
        const old = store.entries.get(name);
        if (old?.kind === 'file') store.bytes -= old.bytes;
        store.entries.set(name, entry);
        if (entry.kind === 'file') store.bytes += entry.bytes;
      }
      if (store.entries.size > maxStoreEntries) fail('SOURCE_VAULT_LIMIT');
    };
    const readStoredEnvelope = async (expected) => {
      const directory = address(expected);
      if (!await statOrMissing(path.dirname(directory), { directory: true })) fail('SOURCE_VAULT_MISSING');
      if (!await statOrMissing(directory, { directory: true })) fail('SOURCE_VAULT_MISSING');
      const projectStat = await privateDirectory(path.dirname(directory), store.entries.get(expected.projectId));
      const addressStat = await privateDirectory(directory, store.entries.get(`${expected.projectId}/${expected.sha256}`));
      const encrypted = await readPrivateFile(path.join(directory, 'blob.bin'), MAX_FILE_BYTES + MAX_HEADER_BYTES + 12, 'SOURCE_VAULT_MISSING');
      try {
        await privateDirectory(path.dirname(directory), projectStat);
        await privateDirectory(directory, addressStat);
        return encrypted;
      } catch (error) { encrypted.bytes.fill(0); throw error; }
    };
    const readStored = async (expected) => {
      const encrypted = await readStoredEnvelope(expected);
      try { return decryptBlob(encrypted.bytes, expected, installationId, keys); }
      finally { encrypted.bytes.fill(0); }
    };
    const authenticateCiphertext = (envelope, expected, cipherSha256) => {
      if (digest(envelope) !== cipherSha256) fail('SOURCE_VAULT_INTEGRITY');
      const verified = decryptBlob(envelope, expected, installationId, keys);
      verified.bytes.fill(0);
    };
    const vault = {
      info() { ensureUsable(); return publicInfo(); },
      put(value) {
        let projectId;
        let plaintext;
        try {
          ensureUsable();
          if (restoreStage) fail('SOURCE_VAULT_MODE');
          if (pending >= MAX_PENDING_OPERATIONS) fail('SOURCE_VAULT_LIMIT');
          projectId = projectArgument(value?.projectId);
          if (!(value?.bytes instanceof Uint8Array)) fail('SOURCE_VAULT_ARGUMENT');
          if (value.bytes.byteLength > MAX_FILE_BYTES) fail('SOURCE_VAULT_LIMIT');
          // Snapshot caller-owned bytes before any await/queueing; never persist this buffer.
          plaintext = Buffer.from(value.bytes);
        } catch (error) { return Promise.reject(safeError(error)); }
        return enqueue(async () => {
          const sha256 = crypto.createHash('sha256').update(plaintext).digest('hex');
          const expected = { projectId, sha256, byteSize: plaintext.length };
          const projectDirectory = path.join(sourceRoot, projectId);
          const directory = address(expected);
          const prefix = `${projectId}/${sha256}`;
          const knownProject = store.entries.get(projectId);
          const knownAddress = store.entries.get(prefix);
          if (knownProject) await privateDirectory(projectDirectory, knownProject);
          else if (await statOrMissing(projectDirectory, { directory: true })) fail('SOURCE_VAULT_UNSAFE_PATH');
          if (knownAddress) {
            await privateDirectory(directory, knownAddress);
            const existing = await readStored(expected);
            try {
              if (!existing.bytes.equals(plaintext)) fail('SOURCE_VAULT_INTEGRITY');
              await syncDirectory(directory);
              await verifyRoots();
              return Object.freeze({ format: FORMAT_MAJOR, ...expected, keyId: existing.keyId, deduplicated: true });
            } finally { existing.bytes.fill(0); }
          }
          // Native missing checks require existing retained ancestors; an absent project has no address.
          if (knownProject && await statOrMissing(directory, { directory: true })) fail('SOURCE_VAULT_UNSAFE_PATH');
          const keyId = [...keys.keys()].at(-1);
          const encrypted = encryptBlob({ installationId, ...expected, keyId }, plaintext, keys.get(keyId));
          // Reserve both payload and metadata entries BEFORE creating anything. Rename reuses the temp entry.
          const requiredEntries = (knownProject ? 0 : 1) + 2;
          if (store.bytes + encrypted.length > maxStoreBytes
              || store.entries.size + requiredEntries > maxStoreEntries) fail('SOURCE_VAULT_LIMIT');
          try {
            await checkOwnership();
            if (!knownProject) {
              await mkdir(projectDirectory);
              await privateDirectory(projectDirectory);
              await syncDirectory(sourceRoot);
            }
            await checkOwnership(); await mkdir(directory);
            // Interrupted reservations remain isolated; ambiguous existing residue is never overwritten/cleaned.
            await privateDirectory(directory);
            await syncDirectory(projectDirectory);
            await atomicWrite(directory, 'blob.bin', encrypted, { fault, kind: 'blob', checkOwnership });
            // Authenticate persisted bytes before a successful source publication on either platform.
            const checked = await readStored(expected);
            try { if (!checked.bytes.equals(plaintext)) fail('SOURCE_VAULT_INTEGRITY'); }
            finally { checked.bytes.fill(0); }
            await verifyRoots();
            return Object.freeze({ format: FORMAT_MAJOR, ...expected, keyId, deduplicated: false });
          } finally {
            try { await accountAttempt(expected); }
            catch (error) { poisoned = true; throw error; }
          }
        }, () => plaintext.fill(0));
      },
      read(value) {
        let expected;
        try { expected = readArguments(value); } catch (error) { return Promise.reject(safeError(error)); }
        return enqueue(async () => {
          const result = await readStored(expected);
          try { await verifyRoots(); return result.bytes; }
          catch (error) { result.bytes.fill(0); throw error; }
        });
      },
      exportCiphertext(value) {
        let expected;
        try { expected = ciphertextArguments(value); } catch (error) { return Promise.reject(safeError(error)); }
        return enqueue(async () => {
          const encrypted = await readStoredEnvelope(expected);
          try {
            const cipherSha256 = digest(encrypted.bytes);
            authenticateCiphertext(encrypted.bytes, expected, cipherSha256);
            await verifyRoots();
            // Only this authenticated ciphertext copy crosses the backup boundary. The caller
            // owns it; no plaintext or key material is returned or stored by this operation.
            return Object.freeze({ format: FORMAT_MAJOR, ...expected, envelope: encrypted.bytes, cipherSha256 });
          } catch (error) { encrypted.bytes.fill(0); throw error; }
        });
      },
      importCiphertext(value) {
        let expected;
        let envelope;
        let cipherSha256;
        try {
          ensureUsable();
          if (!restoreStage) fail('SOURCE_VAULT_MODE');
          if (pending >= MAX_PENDING_OPERATIONS) fail('SOURCE_VAULT_LIMIT');
          expected = ciphertextArguments(value);
          if (!Buffer.isBuffer(value.envelope) || !fullMatch(value.cipherSha256, SHA256)) fail('SOURCE_VAULT_ARGUMENT');
          if (value.envelope.length > MAX_FILE_BYTES + MAX_HEADER_BYTES + 12) fail('SOURCE_VAULT_LIMIT');
          cipherSha256 = value.cipherSha256;
          // Snapshot the caller's ciphertext and reference before any queueing or await.
          envelope = Buffer.from(value.envelope);
        } catch (error) { return Promise.reject(safeError(error)); }
        return enqueue(async () => {
          // Validate against retained B keys before creating even an empty project directory.
          authenticateCiphertext(envelope, expected, cipherSha256);
          const projectDirectory = path.join(sourceRoot, expected.projectId);
          const directory = address(expected);
          const prefix = `${expected.projectId}/${expected.sha256}`;
          const knownProject = store.entries.get(expected.projectId);
          const knownAddress = store.entries.get(prefix);
          const receipt = deduplicated => Object.freeze({ format: FORMAT_MAJOR, ...expected, cipherSha256, deduplicated });
          if (knownProject) await privateDirectory(projectDirectory, knownProject);
          else if (await statOrMissing(projectDirectory, { directory: true })) fail('SOURCE_VAULT_UNSAFE_PATH');
          if (knownAddress) {
            await privateDirectory(directory, knownAddress);
            const existing = await readStoredEnvelope(expected);
            try {
              authenticateCiphertext(existing.bytes, expected, cipherSha256);
              if (!existing.bytes.equals(envelope)) fail('SOURCE_VAULT_INTEGRITY');
              await syncDirectory(directory);
              await verifyRoots();
              return receipt(true);
            } finally { existing.bytes.fill(0); }
          }
          // Native missing checks require existing retained ancestors; an absent project has no address.
          if (knownProject && await statOrMissing(directory, { directory: true })) fail('SOURCE_VAULT_UNSAFE_PATH');
          const requiredEntries = (knownProject ? 0 : 1) + 2;
          if (store.bytes + envelope.length > maxStoreBytes
              || store.entries.size + requiredEntries > maxStoreEntries) fail('SOURCE_VAULT_LIMIT');
          try {
            await checkOwnership();
            if (!knownProject) {
              await mkdir(projectDirectory);
              await privateDirectory(projectDirectory);
              await syncDirectory(sourceRoot);
            }
            await checkOwnership(); await mkdir(directory);
            await privateDirectory(directory);
            await syncDirectory(projectDirectory);
            const committed = await atomicWrite(directory, 'blob.bin', envelope, { fault, kind: 'blob', checkOwnership });
            const readback = await readStoredEnvelope(expected);
            try {
              if (!sameFileState(committed, readback.stat) || !readback.bytes.equals(envelope)) fail('SOURCE_VAULT_INTEGRITY');
              authenticateCiphertext(readback.bytes, expected, cipherSha256);
              await verifyRoots();
              return receipt(false);
            } finally { readback.bytes.fill(0); }
          } finally {
            try { await accountAttempt(expected); }
            catch (error) { poisoned = true; throw error; }
          }
        }, () => envelope.fill(0));
      },
      rotate() {
        return enqueue(async () => {
          if (restoreStage) fail('SOURCE_VAULT_MODE');
          if (keys.size >= MAX_KEYS) fail('SOURCE_VAULT_LIMIT');
          const newKey = crypto.randomBytes(32);
          const next = new Map(keys);
          let keyId;
          for (let attempt = 0; attempt < 16; attempt += 1) {
            keyId = crypto.randomBytes(16).toString('hex');
            if (!next.has(keyId)) break;
          }
          if (next.has(keyId)) { newKey.fill(0); fail('SOURCE_VAULT_IO'); }
          next.set(keyId, newKey);
          try {
            if (windows) {
              if (await wrapper.isAvailable() !== true) fail('SOURCE_VAULT_WRAPPING_UNAVAILABLE');
              const plaintext = keyringPlaintext(installationId, next);
              try {
                await checkOwnership();
                await fault?.('keyring:native-before-append');
                await keyState.write(plaintext);
                await fault?.('keyring:native-appended');
                keyFileStat = await statOrMissing(keyFile);
                const checked = await keyState.read();
                try { if (!checked.equals(plaintext)) fail('SOURCE_VAULT_KEY_INVALID'); }
                finally { checked.fill(0); }
              } finally { plaintext.fill(0); }
            } else {
              const wrapped = await wrapKeyring(wrapper, installationId, next);
              try {
                keyFileStat = await atomicWrite(keyDirectory, 'source-keyring.wrapped', wrapped,
                  { previous: keyFileStat, fault, kind: 'keyring', checkOwnership });
              } finally { wrapped.fill(0); }
            }
            keys = next;
            await verifyRoots();
            return publicInfo();
          } catch (error) { newKey.fill(0); poisoned = true; throw error; }
        });
      },
      close() {
        if (closePromise) return closePromise;
        closing = true;
        closePromise = (async () => {
          await queue;
          for (const key of keys.values()) key.fill(0);
          closed = true;
          try { await nativeStorage?.close(); }
          finally { try { await lock.release(); } catch (error) { throw safeError(error); } }
        })();
        return closePromise;
      },
    };
    await verifyRoots();
    return Object.freeze(vault);
  } catch (error) {
    if (keys) for (const key of keys.values()) key.fill(0);
    if (nativeStorage) await nativeStorage.close().catch(() => {});
    if (lock) await lock.release().catch(() => {});
    throw safeError(error);
  }
}

function createSourceVault(options) { return initialize(options, true); }
function openSourceVault(options) { return initialize(options, false); }
// Main-process restore coordinator only. Never expose this factory through a renderer or
// backend option. Source/key roots must be trusted canonical paths, not archive pathnames.
function openSourceVaultRestoreStage(options) { return initialize(options, false, true); }

module.exports = { createSourceVault, openSourceVault, openSourceVaultRestoreStage, SourceVaultError,
  MAX_FILE_BYTES, MAX_STORE_BYTES, MAX_STORE_ENTRIES };
