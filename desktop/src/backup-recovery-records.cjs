'use strict';

// Trusted main-only recovery evidence, outside every ordinary restore root.
// Authentication here never establishes PostgreSQL, source, or safety-journal authority.
const crypto = require('node:crypto');
const fs = require('node:fs/promises');
const { constants } = require('node:fs');
const path = require('node:path');
const { types } = require('node:util');
const { readStorageFile, writeStorageFile } = require('./windows-storage-files.cjs');
const { openAuthenticatedState } = require('./windows-authenticated-state.cjs');

const VERSION = 1;
const MAGIC = Buffer.from('CIBREC01');
const MAX_PLAIN = 64 * 1024 * 1024;
const MAX_HEADER = 4096;
const MAX_RECORDS = 4096;
const MAX_NODES = 250000;
const MAX_DEPTH = 64;
const MAX_PENDING = 16;
const MAX_SCRATCHES = 256;
const HEX32 = /^[a-f0-9]{32}$/;
const HEX64 = /^[a-f0-9]{64}$/;
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const BUILD = /^(?:0|[1-9][0-9]{0,18})$/;
const KINDS = Object.freeze(['BACKUP', 'RESTORE']);
const APPEND_PHASES = Object.freeze(['MERGED', 'SEALED', 'STAGED', 'DATABASE_SWAPPED', 'SOURCES_SWAPPED', 'HEALTH_VERIFIED', 'RETENTION_READY', 'ROLLED_BACK']);
const COLLECTION_PHASES = Object.freeze(['GC_BEGIN', 'GC_END']);
const PHASES = Object.freeze(['PREPARED', ...APPEND_PHASES, 'COMPLETED', ...COLLECTION_PHASES, 'RECOVERY_SCRATCH']);
const SCRATCH_FIELDS = Object.freeze(['transactionId', 'relativeDirectory', 'directoryIdentity', 'payloadIdentity', 'payloadSha256']);
const owners = new Set(); // Main's single-instance/mutex is still required across processes.
const MESSAGES = Object.freeze({
  BACKUP_RECOVERY_ARGUMENT: 'Invalid recovery record argument.',
  BACKUP_RECOVERY_UNSUPPORTED: 'Recovery record version or platform is unsupported.',
  BACKUP_RECOVERY_UNSAFE_PATH: 'Recovery record file identity or permissions are unsafe.',
  BACKUP_RECOVERY_MISSING: 'Recovery records are missing; initialization is not inferred.',
  BACKUP_RECOVERY_EXISTS: 'Recovery record initialization or publication requires a fresh destination.',
  BACKUP_RECOVERY_INVALID: 'Recovery record authentication, framing, or chain is invalid.',
  BACKUP_RECOVERY_CAPACITY: 'Recovery record capacity was reached.',
  BACKUP_RECOVERY_BUSY: 'Recovery record ownership or operation capacity is unavailable.',
  BACKUP_RECOVERY_STATE: 'Recovery record operation does not match the pending transaction.',
  BACKUP_RECOVERY_KEY_UNAVAILABLE: 'The retained backup key is unavailable.',
  BACKUP_RECOVERY_COMPLETION_UNVERIFIED: 'Recovery completion requires authoritative verification.',
  BACKUP_RECOVERY_COLLECTION_UNVERIFIED: 'Recovery collection requires authoritative verification.',
  BACKUP_RECOVERY_CLOSED: 'Recovery records are closed or require reopening after a failed operation.',
  BACKUP_RECOVERY_IO: 'Recovery record durability was not acknowledged; reopen and verify the evidence.',
});

class BackupRecoveryRecordsError extends Error {
  constructor(code) {
    const safe = Object.hasOwn(MESSAGES, code) ? code : 'BACKUP_RECOVERY_IO';
    super(MESSAGES[safe]); this.name = 'BackupRecoveryRecordsError'; this.code = safe;
  }
}
function fail(code) { throw new BackupRecoveryRecordsError(code); }
function safeError(error) { return new BackupRecoveryRecordsError(error instanceof BackupRecoveryRecordsError ? error.code : 'BACKUP_RECOVERY_IO'); }
const hash = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const validHex = (value, size, regex) => typeof value === 'string' && value.length === size && regex.test(value);
const validUuid = value => typeof value === 'string' && value.length === 36 && UUID.test(value);
function validBuild(value) {
  return typeof value === 'string' && value.length <= 19 && BUILD.test(value) && BigInt(value) <= 9223372036854775807n;
}
function ownData(value, names, code = 'BACKUP_RECOVERY_ARGUMENT') {
  if (!value || typeof value !== 'object' || types.isProxy(value) || Array.isArray(value)
      || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) fail(code);
  const descriptors = Object.getOwnPropertyDescriptors(value);
  if (Reflect.ownKeys(descriptors).length !== names.length || names.some(name => !Object.hasOwn(descriptors, name)
      || !Object.hasOwn(descriptors[name], 'value') || !descriptors[name].enumerable)) fail(code);
  return Object.fromEntries(names.map(name => [name, descriptors[name].value]));
}
function scratchInput(argument, code = 'BACKUP_RECOVERY_ARGUMENT') {
  const value = ownData(argument, SCRATCH_FIELDS, code);
  const directory = value.relativeDirectory;
  const validIdentity = input => typeof input === 'string' && (/^WI1:(?:0|[1-9][0-9]{0,19}):(?:0|[1-9][0-9]{0,19}):(?:0|[1-9][0-9]{0,19})$/.test(input)
    || input.length <= 41 && input.match(/^(?:0|[1-9][0-9]{0,19}):(?:0|[1-9][0-9]{0,19})$/)?.[0] === input
    && input.split(':').every(part => BigInt(part) <= 18446744073709551615n));
  if (!validUuid(value.transactionId) || typeof directory !== 'string'
      || directory.match(/^verification\/verify-(?:checkpoint|incoming|product)-[a-f0-9-]{36}$/)?.[0] !== directory
      || !validUuid(directory.slice(-36)) || !validIdentity(value.directoryIdentity)
      || !validIdentity(value.payloadIdentity) || !validHex(value.payloadSha256, 64, HEX64)) fail(code);
  return value;
}
function unicode(value) {
  for (let i = 0; i < value.length; i += 1) {
    const c = value.charCodeAt(i);
    if (c >= 0xd800 && c <= 0xdbff) {
      const next = value.charCodeAt(++i);
      if (!(next >= 0xdc00 && next <= 0xdfff)) fail('BACKUP_RECOVERY_ARGUMENT');
    } else if (c >= 0xdc00 && c <= 0xdfff) fail('BACKUP_RECOVERY_ARGUMENT');
  }
}
// Capture synchronously before queueing. Getters, proxies, cycles, sparse arrays and unsafe integers
// cannot silently alter the exact normalized main input. Decimal/large identifiers belong in strings.
function canonical(value, maximum = MAX_PLAIN) {
  let bytes = 0; let nodes = 0; const ancestors = new Set();
  const add = text => { bytes += Buffer.byteLength(text); if (bytes > maximum) fail('BACKUP_RECOVERY_CAPACITY'); return text; };
  const visit = (item, depth) => {
    if (++nodes > MAX_NODES || depth > MAX_DEPTH) fail('BACKUP_RECOVERY_CAPACITY');
    if (item === null) return add('null');
    if (typeof item === 'string') { if (item.length > maximum) fail('BACKUP_RECOVERY_CAPACITY'); unicode(item); return add(JSON.stringify(item)); }
    if (typeof item === 'boolean') return add(item ? 'true' : 'false');
    if (typeof item === 'number') {
      if (!Number.isFinite(item) || Object.is(item, -0) || (Number.isInteger(item) && !Number.isSafeInteger(item))) fail('BACKUP_RECOVERY_ARGUMENT');
      return add(JSON.stringify(item));
    }
    if (!item || typeof item !== 'object' || types.isProxy(item) || ancestors.has(item)) fail('BACKUP_RECOVERY_ARGUMENT');
    const array = Array.isArray(item);
    if (array ? Object.getPrototypeOf(item) !== Array.prototype : ![Object.prototype, null].includes(Object.getPrototypeOf(item))) fail('BACKUP_RECOVERY_ARGUMENT');
    const descriptors = Object.getOwnPropertyDescriptors(item); const keys = Reflect.ownKeys(descriptors);
    if (keys.some(key => typeof key !== 'string')) fail('BACKUP_RECOVERY_ARGUMENT');
    ancestors.add(item);
    let result;
    if (array) {
      const size = descriptors.length?.value;
      if (!Number.isSafeInteger(size) || size < 0 || size > MAX_NODES || keys.length !== size + 1) fail('BACKUP_RECOVERY_ARGUMENT');
      const parts = [];
      add('['); for (let i = 0; i < size; i += 1) {
        const descriptor = descriptors[String(i)];
        if (!descriptor || !Object.hasOwn(descriptor, 'value') || !descriptor.enumerable) fail('BACKUP_RECOVERY_ARGUMENT');
        if (i) add(','); parts.push(visit(descriptor.value, depth + 1));
      } add(']'); result = `[${parts.join(',')}]`;
    } else {
      const parts = []; add('{');
      for (const key of keys.sort()) {
        const descriptor = descriptors[key];
        if (!Object.hasOwn(descriptor, 'value') || !descriptor.enumerable) fail('BACKUP_RECOVERY_ARGUMENT');
        unicode(key); if (parts.length) add(',');
        const encodedKey = add(JSON.stringify(key)); add(':'); parts.push(`${encodedKey}:${visit(descriptor.value, depth + 1)}`);
      } add('}'); result = `{${parts.join(',')}}`;
    }
    ancestors.delete(item); return result;
  };
  return visit(value, 0);
}
function capture(value) { return JSON.parse(canonical(value)); }
function frozen(value) {
  if (value && typeof value === 'object') { for (const child of Object.values(value)) frozen(child); Object.freeze(value); }
  return value;
}
function parseCanonical(bytes) {
  try { const value = JSON.parse(bytes.toString('utf8')); if (!Buffer.from(canonical(value)).equals(bytes)) fail('BACKUP_RECOVERY_INVALID'); return value; }
  catch (error) { if (error instanceof BackupRecoveryRecordsError && error.code === 'BACKUP_RECOVERY_CAPACITY') throw error; fail('BACKUP_RECOVERY_INVALID'); }
}
function sameIdentity(a, b) { return a.platform === 'win32' || b.platform === 'win32' ? a.platform === b.platform && a.identity === b.identity : a.dev === b.dev && a.ino === b.ino; }
function sameState(a, b) { return a.platform === 'win32' || b.platform === 'win32' ? sameIdentity(a, b) && a.token === b.token : sameIdentity(a, b) && a.size === b.size && a.mtimeNs === b.mtimeNs && a.ctimeNs === b.ctimeNs; }
function checkPrivate(stat, directory) {
  if ((directory ? !stat.isDirectory() : !stat.isFile()) || stat.isSymbolicLink()
      || stat.uid !== BigInt(process.getuid()) || (stat.mode & 0o7777n) !== (directory ? 0o700n : 0o600n)
      || (!directory && stat.nlink !== 1n)) fail('BACKUP_RECOVERY_UNSAFE_PATH');
}
async function statOrMissing(file) {
  try { return await fs.lstat(file, { bigint: true }); } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}
async function privateDirectory(directory, expected) {
  let current = path.parse(directory).root;
  for (const part of directory.slice(current.length).split(path.sep).filter(Boolean)) {
    current = path.join(current, part); const stat = await statOrMissing(current);
    if (!stat) fail('BACKUP_RECOVERY_MISSING');
    if (!stat.isDirectory() || stat.isSymbolicLink() || await fs.realpath(current) !== current) fail('BACKUP_RECOVERY_UNSAFE_PATH');
  }
  const stat = await fs.lstat(directory, { bigint: true }); checkPrivate(stat, true);
  if (expected && !sameIdentity(stat, expected)) fail('BACKUP_RECOVERY_UNSAFE_PATH');
  return stat;
}
async function syncDirectory(directory, expected) {
  const before = await privateDirectory(directory, expected);
  const handle = await fs.open(directory, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  try { const opened = await handle.stat({ bigint: true }); checkPrivate(opened, true);
    if (!sameIdentity(before, opened)) fail('BACKUP_RECOVERY_UNSAFE_PATH');
    await handle.sync(); await privateDirectory(directory, before);
  } finally { await handle.close(); }
}
function recordName(sequence) { return `record-${String(sequence).padStart(8, '0')}.enc`; }
function receiptName(sequence) { return `receipt-${String(sequence).padStart(8, '0')}.enc`; }
function fileRole(name) {
  if (name === 'enrollment.enc') return 'ENROLLMENT'; if (name === 'active.enc') return 'ACTIVE';
  if (/^record-[0-9]{8}\.enc$/.test(name) && name.length === 19) return 'RECORD';
  if (/^receipt-[0-9]{8}\.enc$/.test(name) && name.length === 20) return 'RECEIPT';
  fail('BACKUP_RECOVERY_INVALID');
}
function base64(value, length) {
  if (typeof value !== 'string' || value.length !== Math.ceil(length / 3) * 4) fail('BACKUP_RECOVERY_INVALID');
  const bytes = Buffer.from(value, 'base64');
  if (bytes.length !== length || bytes.toString('base64') !== value) { bytes.fill(0); fail('BACKUP_RECOVERY_INVALID'); }
  return bytes;
}
function encrypt(bytes, key, nonce, aad) {
  const cipher = crypto.createCipheriv('aes-256-gcm', key, nonce, { authTagLength: 16 }); cipher.setAAD(aad);
  return { ciphertext: Buffer.concat([cipher.update(bytes), cipher.final()]), tag: cipher.getAuthTag() };
}
function decrypt(bytes, key, nonce, tag, aad) {
  let partial;
  try { const decipher = crypto.createDecipheriv('aes-256-gcm', key, nonce, { authTagLength: 16 });
    decipher.setAAD(aad); decipher.setAuthTag(tag); partial = decipher.update(bytes);
    return Buffer.concat([partial, decipher.final()]);
  } catch { fail('BACKUP_RECOVERY_INVALID'); } finally { partial?.fill(0); }
}
async function withKey(provider, id, operation) {
  let key;
  try { try { key = await provider.getBackupKey(id); } catch { fail('BACKUP_RECOVERY_KEY_UNAVAILABLE'); }
    if (!Buffer.isBuffer(key) || key.length !== 32) fail('BACKUP_RECOVERY_KEY_UNAVAILABLE');
    return await operation(key);
  } finally { if (Buffer.isBuffer(key)) key.fill(0); }
}
function wrapAAD(core) { return Buffer.from(`CI-RECOVERY-DEK-1\0${canonical(core)}`); }
function dataAAD(core, wrappedDek) { return Buffer.from(`CI-RECOVERY-DATA-1\0${canonical({ core, wrappedDek })}`); }

async function createBackupRecoveryRecords(options) {
  let root; let owns = false; let storage;
  try {
    if (process.platform === 'win32' ? !options?.windowsBoundary : !constants.O_NOFOLLOW || !constants.O_DIRECTORY || typeof process.getuid !== 'function') fail('BACKUP_RECOVERY_UNSUPPORTED');
    if (!options || typeof options !== 'object' || types.isProxy(options) || Array.isArray(options)
        || ![Object.prototype, null].includes(Object.getPrototypeOf(options))) fail('BACKUP_RECOVERY_ARGUMENT');
    const allowed = ['root', 'installationId', 'runningBuild', 'keyProvider', 'verifyCompletion', 'verifyCollection', 'initialize', 'windowsBoundary'];
    const descriptors = Object.getOwnPropertyDescriptors(options);
    if (Reflect.ownKeys(descriptors).some(name => !allowed.includes(name) || !Object.hasOwn(descriptors[name], 'value')
        || !descriptors[name].enumerable)) fail('BACKUP_RECOVERY_ARGUMENT');
    const config = Object.fromEntries(Object.entries(descriptors).map(([key, descriptor]) => [key, descriptor.value]));
    root = config.root;
    if (typeof root !== 'string' || !path.isAbsolute(root) || path.resolve(root) !== root || root.includes('\0')
        || Buffer.byteLength(root) > 4096 || path.parse(root).root === root
        || typeof config.installationId !== 'string' || config.installationId.length < 1 || config.installationId.length > 128
        || !/^[A-Za-z0-9_-]+$/.test(config.installationId) || !validBuild(config.runningBuild)
        || (config.initialize !== undefined && typeof config.initialize !== 'boolean')
        || (config.verifyCompletion !== undefined && typeof config.verifyCompletion !== 'function')
        || (config.verifyCollection !== undefined && typeof config.verifyCollection !== 'function')) fail('BACKUP_RECOVERY_ARGUMENT');
    const provider = ownData(config.keyProvider, ['currentKeyId', 'getBackupKey']);
    if (typeof provider.currentKeyId !== 'function' || typeof provider.getBackupKey !== 'function') fail('BACKUP_RECOVERY_ARGUMENT');
    // Snapshot function references: changing the caller's facade cannot replace authority mid-operation.
    const keys = { currentKeyId: provider.currentKeyId.bind(config.keyProvider), getBackupKey: provider.getBackupKey.bind(config.keyProvider) };
    const verifyCompletion = config.verifyCompletion;
    const verifyCollection = config.verifyCollection;
    const identityHash = hash(`CI-RECOVERY-INSTALLATION-1\0${config.installationId}`);
    if (owners.has(root)) fail('BACKUP_RECOVERY_BUSY'); owners.add(root); owns = true;
    if (config.windowsBoundary) {
      if (config.initialize === true) await config.windowsBoundary.createDirectory(root);
      storage = await config.windowsBoundary.openStorage(root, { mode: 'private' });
    } else if (config.initialize === true) {
      const parent = await privateDirectory(path.dirname(root));
      try { await fs.mkdir(root, { mode: 0o700 }); } catch (error) { if (error.code === 'EEXIST') fail('BACKUP_RECOVERY_EXISTS'); throw error; }
      await syncDirectory(path.dirname(root), parent);
    }
    const rootStat = storage ? await storage.stat('', { directory: true }) : await privateDirectory(root);
    let activeState;
    const checkRoot = async () => { if (storage) { if (!sameIdentity(rootStat, await storage.stat('', { directory: true }))) fail('BACKUP_RECOVERY_UNSAFE_PATH'); } else await privateDirectory(root, rootStat); };
    const namesAtRoot = async () => { if (!storage) return fs.readdir(root); const names = []; for await (const entry of storage.entries()) { if (entry.directory) fail('BACKUP_RECOVERY_INVALID'); names.push(entry.name); } return names; };
    let rootId; let knownFiles = new Map(); let serial = Promise.resolve(); let pending = 0;
    let closing = false; let poisoned = false; let closePromise;

    async function readFile(name) {
      if (storage) { const file = await readStorageFile(storage, name, MAX_PLAIN + MAX_HEADER + 12); return { bytes: file.bytes, stat: file.state, hash: hash(file.bytes) }; }
      await privateDirectory(root, rootStat); const file = path.join(root, name);
      const before = await statOrMissing(file); if (!before) fail('BACKUP_RECOVERY_MISSING'); checkPrivate(before, false);
      if (before.size < 13n || before.size > BigInt(MAX_PLAIN + MAX_HEADER + 12)) fail('BACKUP_RECOVERY_CAPACITY');
      const handle = await fs.open(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
      let bytes;
      try {
        const opened = await handle.stat({ bigint: true }); checkPrivate(opened, false);
        if (!sameState(before, opened)) fail('BACKUP_RECOVERY_UNSAFE_PATH');
        bytes = Buffer.alloc(Number(opened.size)); let offset = 0;
        while (offset < bytes.length) { const { bytesRead } = await handle.read(bytes, offset, bytes.length - offset, offset);
          if (!bytesRead) fail('BACKUP_RECOVERY_INVALID'); offset += bytesRead; }
        const extra = Buffer.alloc(1); if ((await handle.read(extra, 0, 1, offset)).bytesRead) fail('BACKUP_RECOVERY_INVALID');
        const after = await handle.stat({ bigint: true }); const current = await fs.lstat(file, { bigint: true });
        checkPrivate(after, false); checkPrivate(current, false);
        if (!sameState(opened, after) || !sameState(after, current)) fail('BACKUP_RECOVERY_UNSAFE_PATH');
        await privateDirectory(root, rootStat); return { bytes, stat: after, hash: hash(bytes) };
      } catch (error) { bytes?.fill(0); throw error; } finally { await handle.close(); }
    }
    async function encode(name, value) {
      let keyId; try { keyId = await keys.currentKeyId('backup'); } catch { fail('BACKUP_RECOVERY_KEY_UNAVAILABLE'); }
      if (!validHex(keyId, 32, HEX32)) fail('BACKUP_RECOVERY_KEY_UNAVAILABLE');
      const plain = Buffer.from(canonical(value)); let dek;
      try {
        dek = crypto.randomBytes(32);
        const core = { version: VERSION, identityHash, rootId, role: fileRole(name), name, keyId,
          minimumBuild: config.runningBuild, plainBytes: plain.length, plainSha256: hash(plain) };
        const wrappedDek = await withKey(keys, keyId, key => {
          const nonce = crypto.randomBytes(12); const result = encrypt(dek, key, nonce, wrapAAD(core));
          return { nonce: nonce.toString('base64'), ciphertext: result.ciphertext.toString('base64'), tag: result.tag.toString('base64') };
        });
        const nonce = crypto.randomBytes(12); const result = encrypt(plain, dek, nonce, dataAAD(core, wrappedDek));
        const header = Buffer.from(canonical({ core, wrappedDek, nonce: nonce.toString('base64'), tag: result.tag.toString('base64') }));
        if (header.length > MAX_HEADER) fail('BACKUP_RECOVERY_CAPACITY');
        const prefix = Buffer.alloc(12); MAGIC.copy(prefix); prefix.writeUInt32BE(header.length, 8);
        return { bytes: Buffer.concat([prefix, header, result.ciphertext]), plainBytes: plain.length };
      } finally { dek?.fill(0); plain.fill(0); }
    }
    async function decode(name, bytes) {
      if (bytes.length < 13 || !bytes.subarray(0, 8).equals(MAGIC)) fail('BACKUP_RECOVERY_UNSUPPORTED');
      const size = bytes.readUInt32BE(8);
      if (size < 2 || size > MAX_HEADER || bytes.length < 12 + size) fail('BACKUP_RECOVERY_INVALID');
      const header = ownData(parseCanonical(bytes.subarray(12, 12 + size)), ['core', 'wrappedDek', 'nonce', 'tag'], 'BACKUP_RECOVERY_INVALID');
      const core = ownData(header.core, ['version', 'identityHash', 'rootId', 'role', 'name', 'keyId', 'minimumBuild', 'plainBytes', 'plainSha256'], 'BACKUP_RECOVERY_INVALID');
      if (core.version !== VERSION || !validBuild(core.minimumBuild) || BigInt(core.minimumBuild) > BigInt(config.runningBuild)) fail('BACKUP_RECOVERY_UNSUPPORTED');
      if (core.identityHash !== identityHash || !validHex(core.rootId, 32, HEX32) || (rootId && core.rootId !== rootId)
          || core.role !== fileRole(name) || core.name !== name || !validHex(core.keyId, 32, HEX32)
          || !Number.isSafeInteger(core.plainBytes) || core.plainBytes < 2 || core.plainBytes > MAX_PLAIN
          || !validHex(core.plainSha256, 64, HEX64) || bytes.length !== 12 + size + core.plainBytes) fail('BACKUP_RECOVERY_INVALID');
      const wrapped = ownData(header.wrappedDek, ['nonce', 'ciphertext', 'tag'], 'BACKUP_RECOVERY_INVALID');
      let dek; let plain;
      try {
        dek = await withKey(keys, core.keyId, key => decrypt(base64(wrapped.ciphertext, 32), key, base64(wrapped.nonce, 12), base64(wrapped.tag, 16), wrapAAD(core)));
        if (dek.length !== 32) fail('BACKUP_RECOVERY_INVALID');
        plain = decrypt(bytes.subarray(12 + size), dek, base64(header.nonce, 12), base64(header.tag, 16), dataAAD(core, wrapped));
        if (hash(plain) !== core.plainSha256) fail('BACKUP_RECOVERY_INVALID');
        return { value: parseCanonical(plain), core };
      } finally { dek?.fill(0); plain?.fill(0); }
    }
    async function publish(name, value, state) {
      const encoded = await encode(name, value);
      if ((state?.plainBytes || 0) + encoded.plainBytes > MAX_PLAIN) { encoded.bytes.fill(0); fail('BACKUP_RECOVERY_CAPACITY'); }
      let handle;
      try {
        if (storage) {
          const created = await writeStorageFile(storage, name, encoded.bytes);
          const readback = await readFile(name);
          try { if (!sameState(created, readback.stat) || !readback.bytes.equals(encoded.bytes)) fail('BACKUP_RECOVERY_INVALID'); await decode(name, readback.bytes); }
          finally { readback.bytes.fill(0); }
          return;
        }
        await privateDirectory(root, rootStat);
        // Exclusive final name, no replacement. A failed/torn write remains recovery evidence.
        // Acknowledgement requires file+directory fsync and exact authenticated readback.
        try { handle = await fs.open(path.join(root, name), constants.O_RDWR | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600); }
        catch (error) { if (error.code === 'EEXIST') fail('BACKUP_RECOVERY_EXISTS'); throw error; }
        const created = await handle.stat({ bigint: true }); checkPrivate(created, false); let offset = 0;
        while (offset < encoded.bytes.length) {
          const { bytesWritten } = await handle.write(encoded.bytes, offset, encoded.bytes.length - offset, offset);
          if (!bytesWritten) fail('BACKUP_RECOVERY_IO'); offset += bytesWritten;
        }
        await handle.sync(); await syncDirectory(root, rootStat);
        const readback = await readFile(name);
        try {
          if (!sameIdentity(created, readback.stat) || !readback.bytes.equals(encoded.bytes)) fail('BACKUP_RECOVERY_INVALID');
          await decode(name, readback.bytes);
        } finally { readback.bytes.fill(0); }
      } catch (error) { poisoned = true; throw error; }
      finally { encoded.bytes.fill(0); if (handle) await handle.close(); }
    }
    async function load(checkKnown = true) {
      await checkRoot();
      const names = (await namesAtRoot()).sort();
      if (names.length > 2 * MAX_RECORDS + 3) fail('BACKUP_RECOVERY_CAPACITY');
      if (!names.includes('enrollment.enc')) fail('BACKUP_RECOVERY_MISSING');
      const recordNames = []; const receiptNames = [];
      for (const name of names) {
        if (storage && ['active.0', 'active.1'].includes(name)) continue;
        if (storage && name === 'active.enc') fail('BACKUP_RECOVERY_INVALID');
        const role = fileRole(name); if (role === 'RECORD') recordNames.push(name); if (role === 'RECEIPT') receiptNames.push(name);
      }
      if (recordNames.length > MAX_RECORDS || recordNames.some((name, i) => name !== recordName(i + 1))) fail('BACKUP_RECOVERY_INVALID');
      const files = new Map(); let plainBytes = 0; let minimumBuild = '0';
      const read = async name => {
        const file = await readFile(name);
        try {
          const decoded = await decode(name, file.bytes); plainBytes += decoded.core.plainBytes;
          if (plainBytes > MAX_PLAIN) fail('BACKUP_RECOVERY_CAPACITY');
          if (BigInt(decoded.core.minimumBuild) > BigInt(minimumBuild)) minimumBuild = decoded.core.minimumBuild;
          const known = knownFiles.get(name);
          if (checkKnown && known && (!sameState(known.stat, file.stat) || known.hash !== file.hash)) fail('BACKUP_RECOVERY_INVALID');
          files.set(name, { hash: file.hash, stat: file.stat }); return { ...decoded, hash: file.hash };
        } finally { file.bytes.fill(0); }
      };
      const genesis = await read('enrollment.enc');
      const enrollment = ownData(genesis.value, ['version', 'rootId'], 'BACKUP_RECOVERY_INVALID');
      if (enrollment.version !== VERSION || enrollment.rootId !== genesis.core.rootId) fail('BACKUP_RECOVERY_INVALID');
      if (!rootId) rootId = enrollment.rootId;
      const receipts = new Map();
      for (const name of receiptNames) {
        const entry = await read(name);
        const value = ownData(entry.value, ['version', 'transactionId', 'kind', 'sequence', 'recordHash', 'receipt'], 'BACKUP_RECOVERY_INVALID');
        if (value.version !== VERSION || !validUuid(value.transactionId) || !KINDS.includes(value.kind)
            || !Number.isSafeInteger(value.sequence) || value.sequence < 1 || value.sequence > MAX_RECORDS
            || name !== receiptName(value.sequence) || !validHex(value.recordHash, 64, HEX64)) fail('BACKUP_RECOVERY_INVALID');
        receipts.set(value.sequence, value);
      }
      const transactions = []; const ids = new Set(); const collections = new Map(); const scratches = new Map();
      let previousHash = genesis.hash; let current; let pendingCollection; let lastCollectionSequence = 0;
      for (let i = 0; i < recordNames.length; i += 1) {
        const entry = await read(recordNames[i]);
        const value = ownData(entry.value, ['version', 'sequence', 'previousHash', 'transactionId', 'kind', 'phase', 'data'], 'BACKUP_RECOVERY_INVALID');
        if (value.version !== VERSION || value.sequence !== i + 1 || value.previousHash !== previousHash
            || !validUuid(value.transactionId) || !KINDS.includes(value.kind) || !PHASES.includes(value.phase)) fail('BACKUP_RECOVERY_INVALID');
        if (value.phase === 'RECOVERY_SCRATCH') {
          const data = ownData(value.data, SCRATCH_FIELDS.slice(1), 'BACKUP_RECOVERY_INVALID');
          const scratch = scratchInput({ transactionId: value.transactionId, ...data }, 'BACKUP_RECOVERY_INVALID');
          const identity = `${value.transactionId}:${scratch.relativeDirectory}`;
          if (!current || current.transactionId !== value.transactionId || current.kind !== value.kind
              || pendingCollection || lastCollectionSequence > current.preparedSequence || scratches.has(identity)
              || current.scratchCount >= MAX_SCRATCHES) fail('BACKUP_RECOVERY_INVALID');
          current.scratchCount++;
          scratches.set(identity, { value: scratch, sequence: value.sequence });
          // Side evidence never advances the transaction's ordinary phase or completion receipt.
          previousHash = entry.hash; continue;
        }
        if (COLLECTION_PHASES.includes(value.phase)) {
          const data = ownData(value.data, ['manifestSha256'], 'BACKUP_RECOVERY_INVALID');
          const target = transactions.find(transaction => transaction.transactionId === value.transactionId);
          if (!validHex(data.manifestSha256, 64, HEX64) || !current?.completed || !current.proof
              || !target?.completed || !target.proof || target.kind !== value.kind
              || transactions.slice(-2).includes(target) || target.retentionHash !== data.manifestSha256) fail('BACKUP_RECOVERY_INVALID');
          const collection = collections.get(value.transactionId);
          if (value.phase === 'GC_BEGIN') {
            if (pendingCollection || collection) fail('BACKUP_RECOVERY_INVALID');
            pendingCollection = { transactionId: value.transactionId, manifestSha256: data.manifestSha256,
              state: 'BEGUN', beginSequence: value.sequence };
            collections.set(value.transactionId, pendingCollection);
          } else {
            if (!collection || collection !== pendingCollection || collection.manifestSha256 !== data.manifestSha256) fail('BACKUP_RECOVERY_INVALID');
            collection.state = 'COMPLETED'; collection.endSequence = value.sequence; pendingCollection = undefined;
          }
          lastCollectionSequence = value.sequence; previousHash = entry.hash; continue;
        }
        if (value.phase === 'PREPARED') {
          if (pendingCollection || current && (!current.completed || !current.proof) || ids.has(value.transactionId)) fail('BACKUP_RECOVERY_INVALID');
          ids.add(value.transactionId); current = { transactionId: value.transactionId, kind: value.kind,
            input: value.data, records: [], preparedSequence: value.sequence, preparedHash: entry.hash, completed: false, proof: false, scratchCount: 0 };
          transactions.push(current);
        } else if (!current || current.completed || current.transactionId !== value.transactionId || current.kind !== value.kind
            || (current.rolledBack && !['HEALTH_VERIFIED', 'RETENTION_READY', 'COMPLETED'].includes(value.phase))) fail('BACKUP_RECOVERY_INVALID');
        if (value.phase === 'ROLLED_BACK') current.rolledBack = true;
        if (value.phase === 'RETENTION_READY') current.retentionHash = hash(canonical(value.data));
        current.records.push({ sequence: value.sequence, phase: value.phase, data: value.data, hash: entry.hash });
        if (value.phase === 'COMPLETED') {
          current.completed = true; const proof = receipts.get(value.sequence);
          if (proof) {
            if (proof.transactionId !== value.transactionId || proof.kind !== value.kind || proof.recordHash !== entry.hash
                || canonical(proof.receipt) !== canonical(value.data)) fail('BACKUP_RECOVERY_INVALID');
            current.proof = true; receipts.delete(value.sequence);
          }
        }
        previousHash = entry.hash;
      }
      if (receipts.size) fail('BACKUP_RECOVERY_INVALID');
      let markerPresent = false;
      let nativeMarker;
      if (storage) { const bytes = await activeState.read(); try { nativeMarker = ownData(parseCanonical(bytes), ['active', 'marker'], 'BACKUP_RECOVERY_INVALID'); if (typeof nativeMarker.active !== 'boolean' || !nativeMarker.active && nativeMarker.marker !== null) fail('BACKUP_RECOVERY_INVALID'); } finally { bytes.fill(0); } }
      if (storage ? nativeMarker.active : names.includes('active.enc')) {
        const marker = ownData(storage ? nativeMarker.marker : (await read('active.enc')).value, ['version', 'transactionId', 'kind', 'sequence', 'recordHash'], 'BACKUP_RECOVERY_INVALID');
        if (!current || marker.version !== VERSION || marker.transactionId !== current.transactionId || marker.kind !== current.kind
            || marker.sequence !== current.preparedSequence || marker.recordHash !== current.preparedHash
            || lastCollectionSequence > current.preparedSequence) fail('BACKUP_RECOVERY_INVALID');
        markerPresent = true;
      }
      if (checkKnown) for (const [name] of knownFiles) if (!files.has(name)) fail('BACKUP_RECOVERY_INVALID');
      // Detect replacement/removal of previously read files and directory changes during asynchronous key calls.
      if (JSON.stringify((await namesAtRoot()).sort()) !== JSON.stringify(names)) fail('BACKUP_RECOVERY_INVALID');
      for (const [name, file] of files) {
        const latest = storage ? await storage.stat(name, { missing: true }) : await statOrMissing(path.join(root, name));
        if (!latest) fail('BACKUP_RECOVERY_INVALID'); if (!storage) checkPrivate(latest, false);
        if (!sameState(latest, file.stat)) fail('BACKUP_RECOVERY_UNSAFE_PATH');
      }
      await checkRoot();
      const active = current && (!current.completed || !current.proof || markerPresent) ? current : null;
      const snapshot = frozen({ version: VERSION, minimumBuild, head: { sequence: recordNames.length, hash: previousHash },
        active: active ? { transactionId: active.transactionId, kind: active.kind, input: active.input,
          phase: active.records.at(-1).phase, records: active.records, markerPresent, completionReceiptPresent: active.proof } : null,
        completed: transactions.filter(transaction => transaction !== active).map(transaction => ({ transactionId: transaction.transactionId,
          kind: transaction.kind, sequence: transaction.records.at(-1).sequence, receipt: transaction.records.at(-1).data })),
        collections: [...collections.values()].map(({ transactionId, manifestSha256, state }) => ({ transactionId, manifestSha256, state })),
        scratches: [...scratches.values()].map(item => item.value) });
      return { snapshot, files, plainBytes, current, ids, transactions, collections, scratches };
    }
    function remember(state) { knownFiles = state.files; return state.snapshot; }
    function enqueue(operation) {
      if (closing || poisoned) return Promise.reject(new BackupRecoveryRecordsError('BACKUP_RECOVERY_CLOSED'));
      if (pending >= MAX_PENDING) return Promise.reject(new BackupRecoveryRecordsError('BACKUP_RECOVERY_BUSY'));
      pending += 1;
      const work = serial.then(async () => {
        if (poisoned) fail('BACKUP_RECOVERY_CLOSED');
        try { return await operation(); } catch (error) {
          const safe = safeError(error);
          if (['BACKUP_RECOVERY_IO', 'BACKUP_RECOVERY_INVALID', 'BACKUP_RECOVERY_UNSAFE_PATH', 'BACKUP_RECOVERY_MISSING'].includes(safe.code)) poisoned = true;
          throw safe;
        }
      });
      serial = work.catch(() => {}).finally(() => { pending -= 1; }); return work;
    }
    async function ensureActive(state) {
      if (state.snapshot.active.markerPresent) return state;
      const transaction = state.current;
      const marker = { version: VERSION, transactionId: transaction.transactionId, kind: transaction.kind,
        sequence: transaction.preparedSequence, recordHash: transaction.preparedHash };
      if (storage) await activeState.write(Buffer.from(canonical({ active: true, marker })));
      else await publish('active.enc', marker, state);
      return load();
    }
    async function appendRecord(state, transactionId, kind, phase, data) {
      const sequence = state.snapshot.head.sequence + 1;
      if (sequence > MAX_RECORDS) fail('BACKUP_RECOVERY_CAPACITY');
      await publish(recordName(sequence), { version: VERSION, sequence, previousHash: state.snapshot.head.hash, transactionId, kind, phase, data }, state);
      return load();
    }
    async function revalidate(previous) {
      const state = await load();
      if (state.files.size !== previous.files.size || [...state.files].some(([name, file]) => {
        const old = previous.files.get(name); return !old || old.hash !== file.hash || !sameState(old.stat, file.stat);
      })) fail('BACKUP_RECOVERY_INVALID');
      return state;
    }
    async function acknowledgeExisting(state, sequence, name = recordName(sequence)) {
      // Reading a valid file after an uncertain ACK is not a durability acknowledgement.
      // Exact retries explicitly sync the original inode and directory; they never rewrite history.
      const expected = state.files.get(name);
      if (storage) { const writer = await storage.openWrite(name, { mode: 'append', expected: expected.stat, maxBytes: Number(expected.stat.size) }); try { await writer.commit(); } finally { await writer.close(); } return revalidate(state); }
      const handle = await fs.open(path.join(root, name), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
      try {
        const opened = await handle.stat({ bigint: true }); checkPrivate(opened, false);
        if (!sameState(opened, expected.stat)) fail('BACKUP_RECOVERY_UNSAFE_PATH');
        await handle.sync(); await syncDirectory(root, rootStat);
        return await revalidate(state);
      } finally { await handle.close(); }
    }
    function collect(argument, operation) {
      let value;
      try {
        value = ownData(argument, ['transactionId', 'manifestSha256']);
        if (!validUuid(value.transactionId) || !validHex(value.manifestSha256, 64, HEX64)) fail('BACKUP_RECOVERY_ARGUMENT');
      } catch (error) { return Promise.reject(safeError(error)); }
      return enqueue(async () => {
        let state = await load();
        const target = state.transactions.find(transaction => transaction.transactionId === value.transactionId);
        const collection = state.collections.get(value.transactionId);
        if (state.snapshot.active || !target?.completed || !target.proof
            || state.transactions.slice(-2).includes(target) || target.retentionHash !== value.manifestSha256
            || [...state.collections.values()].some(item => item.state === 'BEGUN' && item !== collection)
            || collection && collection.manifestSha256 !== value.manifestSha256
            || operation === 'END' && !collection) fail('BACKUP_RECOVERY_STATE');
        if (!collection) {
          // Reserve both global sequence numbers and exact plaintext space for the matching GC_END.
          if (state.snapshot.head.sequence > MAX_RECORDS - 2) fail('BACKUP_RECOVERY_CAPACITY');
          const future = phase => ({ version: VERSION, sequence: state.snapshot.head.sequence + (phase === 'GC_BEGIN' ? 1 : 2),
            previousHash: state.snapshot.head.hash, transactionId: value.transactionId, kind: target.kind, phase,
            data: { manifestSha256: value.manifestSha256 } });
          if (state.plainBytes + Buffer.byteLength(canonical(future('GC_BEGIN'))) + Buffer.byteLength(canonical(future('GC_END'))) > MAX_PLAIN) fail('BACKUP_RECOVERY_CAPACITY');
        }
        if (!verifyCollection) fail('BACKUP_RECOVERY_COLLECTION_UNVERIFIED');
        let verified = false;
        try { verified = await verifyCollection(state.snapshot, frozen({ ...value, operation })); } catch { /* Authority details stay private. */ }
        if (verified !== true) fail('BACKUP_RECOVERY_COLLECTION_UNVERIFIED');
        state = await revalidate(state);
        if (collection && (operation === 'BEGIN' || collection.state === 'COMPLETED')) {
          // A BEGIN retry after END returns COMPLETED, never a new deletion permission.
          state = await acknowledgeExisting(state, collection.endSequence || collection.beginSequence);
        } else {
          if (operation === 'END') state = await acknowledgeExisting(state, collection.beginSequence);
          state = await appendRecord(state, value.transactionId, target.kind, operation === 'BEGIN' ? 'GC_BEGIN' : 'GC_END',
            { manifestSha256: value.manifestSha256 });
        }
        return remember(state);
      });
    }
    if (config.initialize === true) {
      if ((await namesAtRoot()).length) fail('BACKUP_RECOVERY_EXISTS'); rootId = crypto.randomBytes(16).toString('hex');
      await publish('enrollment.enc', { version: VERSION, rootId });
    }
    if (storage) {
      if (!rootId) { const file = await readFile('enrollment.enc'); try { rootId = (await decode('enrollment.enc', file.bytes)).core.rootId; } finally { file.bytes.fill(0); } }
      activeState = await openAuthenticatedState({ storage, file: 'active', installationId: config.installationId,
        purpose: 'backup-recovery-active', mode: 'slots', fresh: config.initialize === true,
        initialValue: Buffer.from(canonical({ active: false, marker: null })), maxPayloadBytes: 4096, maxEncodedBytes: 16384,
        seal: async bytes => (await encode('active.enc', { envelope: bytes.toString('base64') })).bytes,
        unseal: async bytes => Buffer.from((await decode('active.enc', bytes)).value.envelope, 'base64') });
    }
    remember(await load());
    return Object.freeze({
      begin(argument) {
        let value;
        try { value = ownData(argument, ['transactionId', 'kind', 'input']);
          if (!validUuid(value.transactionId) || !KINDS.includes(value.kind)) fail('BACKUP_RECOVERY_ARGUMENT'); value.input = capture(value.input);
        } catch (error) { return Promise.reject(safeError(error)); }
        return enqueue(async () => {
          let state = await load();
          if (state.snapshot.active || state.ids.has(value.transactionId)
              || state.snapshot.collections.some(collection => collection.state === 'BEGUN')) fail('BACKUP_RECOVERY_STATE');
          if (state.snapshot.head.sequence >= MAX_RECORDS - 1) fail('BACKUP_RECOVERY_CAPACITY');
          state = await appendRecord(state, value.transactionId, value.kind, 'PREPARED', value.input);
          state = await ensureActive(state); return remember(state);
        });
      },
      append(argument) {
        let value;
        try { value = ownData(argument, ['transactionId', 'phase', 'data']);
          if (!validUuid(value.transactionId) || !APPEND_PHASES.includes(value.phase)) fail('BACKUP_RECOVERY_ARGUMENT'); value.data = capture(value.data);
        } catch (error) { return Promise.reject(safeError(error)); }
        return enqueue(async () => {
          let state = await load(); const active = state.snapshot.active;
          if (!active || active.transactionId !== value.transactionId || active.phase === 'COMPLETED'
              || state.current.rolledBack && !['HEALTH_VERIFIED', 'RETENTION_READY'].includes(value.phase)) fail('BACKUP_RECOVERY_STATE');
          if (state.snapshot.head.sequence >= MAX_RECORDS - 1) fail('BACKUP_RECOVERY_CAPACITY');
          state = await ensureActive(state); state = await appendRecord(state, value.transactionId, active.kind, value.phase, value.data); return remember(state);
        });
      },
      read() { return enqueue(async () => remember(await load())); },
      registerScratch(argument) {
        let value;
        try { value = scratchInput(argument); } catch (error) { return Promise.reject(safeError(error)); }
        return enqueue(async () => {
          let state = await load(); const active = state.snapshot.active;
          if (!active || active.transactionId !== value.transactionId) fail('BACKUP_RECOVERY_STATE');
          const existing = state.scratches.get(`${value.transactionId}:${value.relativeDirectory}`);
          if (existing) {
            if (canonical(existing.value) !== canonical(value)) fail('BACKUP_RECOVERY_STATE');
            state = await acknowledgeExisting(state, existing.sequence);
          } else {
            if (state.current.scratchCount >= MAX_SCRATCHES
                || state.snapshot.head.sequence >= MAX_RECORDS - (state.current.completed ? 0 : 1)) fail('BACKUP_RECOVERY_CAPACITY');
            state = await ensureActive(state);
            const { transactionId, ...data } = value;
            state = await appendRecord(state, transactionId, active.kind, 'RECOVERY_SCRATCH', data);
          }
          return remember(state);
        });
      },
      readTransaction(argument) {
        let value;
        try { value = ownData(argument, ['transactionId']); if (!validUuid(value.transactionId)) fail('BACKUP_RECOVERY_ARGUMENT'); }
        catch (error) { return Promise.reject(safeError(error)); }
        return enqueue(async () => {
          const state = await load(); remember(state);
          const transaction = state.transactions.find(item => item.transactionId === value.transactionId);
          if (!transaction) return null;
          const active = state.snapshot.active?.transactionId === value.transactionId;
          // load() already produces private, authenticated bounded JSON. No caller objects or filesystem authority escape.
          return frozen({ transactionId: transaction.transactionId, kind: transaction.kind, input: transaction.input,
            phase: transaction.records.at(-1).phase, records: transaction.records,
            receipt: transaction.proof ? transaction.records.at(-1).data : null,
            status: active ? 'ACTIVE' : 'COMPLETED', markerPresent: active && state.snapshot.active.markerPresent,
            completionReceiptPresent: transaction.proof });
        });
      },
      beginCollection(argument) { return collect(argument, 'BEGIN'); },
      finishCollection(argument) { return collect(argument, 'END'); },
      complete(argument) {
        let value;
        try { value = ownData(argument, ['transactionId', 'receipt']);
          if (!validUuid(value.transactionId)) fail('BACKUP_RECOVERY_ARGUMENT'); value.receipt = capture(value.receipt);
        } catch (error) { return Promise.reject(safeError(error)); }
        return enqueue(async () => {
          let state = await load(); const active = state.snapshot.active;
          if (!active || active.transactionId !== value.transactionId) fail('BACKUP_RECOVERY_STATE');
          if (active.phase === 'COMPLETED' && canonical(active.records.at(-1).data) !== canonical(value.receipt)) fail('BACKUP_RECOVERY_STATE');
          if (!verifyCompletion) fail('BACKUP_RECOVERY_COMPLETION_UNVERIFIED');
          let verified = false;
          try { verified = await verifyCompletion(state.snapshot, frozen(capture(value))); } catch { /* No authority details escape. */ }
          if (verified !== true) fail('BACKUP_RECOVERY_COMPLETION_UNVERIFIED');
          // Revalidate files after the asynchronous authority check, before any completion write.
          state = await revalidate(state);
          state = await ensureActive(state);
          if (state.snapshot.active.phase !== 'COMPLETED') state = await appendRecord(state, value.transactionId, active.kind, 'COMPLETED', value.receipt);
          if (!state.snapshot.active.completionReceiptPresent) {
            const last = state.current.records.at(-1);
            await publish(receiptName(last.sequence), { version: VERSION, transactionId: value.transactionId, kind: active.kind,
              sequence: last.sequence, recordHash: last.hash, receipt: value.receipt }, state); state = await load();
          }
          if (storage) {
            const sequence = state.current.records.at(-1).sequence;
            state = await acknowledgeExisting(state, sequence);
            state = await acknowledgeExisting(state, sequence, receiptName(sequence));
            await activeState.write(Buffer.from(canonical({ active: false, marker: null }))); return remember(await load());
          }
          const marker = state.files.get('active.enc'); await privateDirectory(root, rootStat);
          const current = await fs.lstat(path.join(root, 'active.enc'), { bigint: true }); checkPrivate(current, false);
          if (!sameState(current, marker.stat)) fail('BACKUP_RECOVERY_UNSAFE_PATH');
          try { await fs.unlink(path.join(root, 'active.enc')); await syncDirectory(root, rootStat); }
          catch (error) { poisoned = true; throw error; }
          knownFiles.delete('active.enc'); return remember(await load());
        });
      },
      close() {
        if (closePromise) return closePromise; closing = true;
        closePromise = serial.then(async () => { knownFiles.clear(); await storage?.close(); owners.delete(root); owns = false; }); return closePromise;
      },
    });
  } catch (error) { await storage?.close().catch(() => {}); if (owns) owners.delete(root); throw safeError(error); }
}

module.exports = { createBackupRecoveryRecords, BackupRecoveryRecordsError };
