'use strict';

// Main-only opaque file container. This module does not select/export/scrub/execute/restore a database.
const crypto = require('node:crypto');
const fs = require('node:fs/promises');
const { constants } = require('node:fs');
const path = require('node:path');

const FORMAT = 'code-intelligence-backup-container';
const VERSION = 3;
const MAGIC = Buffer.from('CIBAK003');
const CHUNK_BYTES = 1024 * 1024;
const MAX_PAYLOAD = 10 * 1024 * 1024 * 1024;
const MAX_HEADER = 4096;
const FRAME_BYTES = 36; // index:uint32, ciphertext length:uint32, nonce:12, GCM tag:16
const HEX32 = /^[a-f0-9]{32}$/;
const HEX64 = /^[a-f0-9]{64}$/;
const INSTALLATION_ID = /^[A-Za-z0-9_-]{1,128}$/;
const MESSAGES = Object.freeze({
  BACKUP_ARCHIVE_ARGUMENT: 'Invalid backup container argument.',
  BACKUP_ARCHIVE_UNSUPPORTED: 'Backup container format or platform is unsupported.',
  BACKUP_ARCHIVE_UNSAFE_PATH: 'Backup container file identity or permissions are unsafe.',
  BACKUP_ARCHIVE_MISSING: 'The requested backup container input is missing.',
  BACKUP_ARCHIVE_EXISTS: 'Backup container publication requires a fresh destination.',
  BACKUP_ARCHIVE_LIMIT: 'Backup container size limit exceeded.',
  BACKUP_ARCHIVE_BUSY: 'Backup container operation capacity was reached.',
  BACKUP_ARCHIVE_FORMAT: 'Backup container framing or metadata is invalid.',
  BACKUP_ARCHIVE_INTEGRITY: 'Backup container authentication or content verification failed.',
  BACKUP_ARCHIVE_KEY_UNAVAILABLE: 'The required retained backup key is unavailable.',
  BACKUP_ARCHIVE_SOURCE_CHANGED: 'Backup container input changed during processing.',
  BACKUP_ARCHIVE_IO: 'Backup container operation failed; no successful publication is acknowledged.',
});
let activeOperations = 0;

class BackupArchiveError extends Error {
  constructor(code) {
    const safeCode = Object.hasOwn(MESSAGES, code) ? code : 'BACKUP_ARCHIVE_IO';
    super(MESSAGES[safeCode]); this.name = 'BackupArchiveError'; this.code = safeCode;
  }
}
function fail(code) { throw new BackupArchiveError(code); }
function safeError(error) { return new BackupArchiveError(error instanceof BackupArchiveError ? error.code : 'BACKUP_ARCHIVE_IO'); }
function sameIdentity(a, b) { return a.dev === b.dev && a.ino === b.ino; }
function sameState(a, b) {
  return sameIdentity(a, b) && a.size === b.size && a.mtimeNs === b.mtimeNs && a.ctimeNs === b.ctimeNs;
}
function checkPrivate(stat, directory, links = 1n) {
  if ((directory ? !stat.isDirectory() : !stat.isFile()) || stat.isSymbolicLink()
      || stat.uid !== BigInt(process.getuid()) || (stat.mode & 0o7777n) !== (directory ? 0o700n : 0o600n)
      || (!directory && stat.nlink !== links)) fail('BACKUP_ARCHIVE_UNSAFE_PATH');
}
function canonicalPath(value) {
  if (typeof value !== 'string' || !path.isAbsolute(value) || path.resolve(value) !== value
      || value.includes('\0') || Buffer.byteLength(value) > 4096 || path.parse(value).root === value)
    fail('BACKUP_ARCHIVE_ARGUMENT');
  return value;
}
async function statOrMissing(file) {
  try { return await fs.lstat(file, { bigint: true }); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}
async function privateDirectory(directory, expected) {
  let current = path.parse(directory).root;
  for (const part of directory.slice(current.length).split(path.sep).filter(Boolean)) {
    current = path.join(current, part);
    const stat = await statOrMissing(current);
    if (!stat) fail('BACKUP_ARCHIVE_MISSING');
    if (!stat.isDirectory() || stat.isSymbolicLink() || await fs.realpath(current) !== current)
      fail('BACKUP_ARCHIVE_UNSAFE_PATH');
  }
  const stat = await fs.lstat(directory, { bigint: true }); checkPrivate(stat, true);
  if (expected && !sameIdentity(stat, expected)) fail('BACKUP_ARCHIVE_UNSAFE_PATH');
  return stat;
}
async function syncDirectory(directory, expected) {
  await privateDirectory(directory, expected);
  const handle = await fs.open(directory, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  try {
    const stat = await handle.stat({ bigint: true }); checkPrivate(stat, true);
    if (!sameIdentity(stat, expected)) fail('BACKUP_ARCHIVE_UNSAFE_PATH');
    await handle.sync(); await privateDirectory(directory, expected);
  } finally { await handle.close(); }
}
function exact(value, names) {
  return value && typeof value === 'object' && !Array.isArray(value)
    && Object.keys(value).length === names.length && names.every(name => Object.hasOwn(value, name));
}
function hex(value, regex, length) { return typeof value === 'string' && value.length === length && regex.test(value); }
function base64(value, size) {
  if (typeof value !== 'string' || value.length !== Math.ceil(size / 3) * 4) fail('BACKUP_ARCHIVE_FORMAT');
  const bytes = Buffer.from(value, 'base64');
  if (bytes.length !== size || bytes.toString('base64') !== value) { bytes.fill(0); fail('BACKUP_ARCHIVE_FORMAT'); }
  return bytes;
}
const hash = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const chunkCount = bytes => Math.ceil(bytes / CHUNK_BYTES);
const chunkSize = (metadata, index) => Math.min(CHUNK_BYTES, metadata.payloadBytes - index * CHUNK_BYTES);
function core(value) {
  return { format: FORMAT, version: VERSION, identityHash: value.identityHash, keyId: value.keyId,
    archiveId: value.archiveId, chunkBytes: CHUNK_BYTES, chunkCount: value.chunkCount,
    payloadBytes: value.payloadBytes, payloadSha256: value.payloadSha256 };
}
function encodeHeader(metadata, wrappedDek) { return Buffer.from(JSON.stringify({ ...core(metadata), wrappedDek }), 'utf8'); }
function wrapAad(metadata) { return Buffer.from(`CI-BACKUP-DEK-3\0${JSON.stringify(core(metadata))}`, 'utf8'); }
function chunkAad(metadata, headerHash, index, bytes) {
  return Buffer.from(JSON.stringify({ domain: 'CI-BACKUP-CHUNK-3', format: FORMAT, version: VERSION,
    identityHash: metadata.identityHash, keyId: metadata.keyId, archiveId: metadata.archiveId,
    headerHash, index, chunkCount: metadata.chunkCount, payloadBytes: metadata.payloadBytes, chunkPlainBytes: bytes }), 'utf8');
}
function uniqueNonce(seen) {
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const nonce = crypto.randomBytes(12); const encoded = nonce.toString('hex');
    if (!seen.has(encoded)) { seen.add(encoded); return nonce; }
  }
  fail('BACKUP_ARCHIVE_IO');
}
function encryptBytes(bytes, key, nonce, aad) {
  const cipher = crypto.createCipheriv('aes-256-gcm', key, nonce, { authTagLength: 16 }); cipher.setAAD(aad);
  return { bytes: Buffer.concat([cipher.update(bytes), cipher.final()]), tag: cipher.getAuthTag() };
}
function decryptBytes(bytes, key, nonce, tag, aad) {
  let unauthenticated; let result;
  try {
    const decipher = crypto.createDecipheriv('aes-256-gcm', key, nonce, { authTagLength: 16 });
    decipher.setAAD(aad); decipher.setAuthTag(tag); unauthenticated = decipher.update(bytes);
    result = Buffer.concat([unauthenticated, decipher.final()]); return result;
  } catch { result?.fill(0); fail('BACKUP_ARCHIVE_INTEGRITY'); }
  finally { unauthenticated?.fill(0); }
}
async function backupKey(provider, id, operation) {
  let key;
  try {
    try { key = await provider.getBackupKey(id); } catch { fail('BACKUP_ARCHIVE_KEY_UNAVAILABLE'); }
    if (!Buffer.isBuffer(key) || key.length !== 32) fail('BACKUP_ARCHIVE_KEY_UNAVAILABLE');
    return operation(key);
  } finally { if (Buffer.isBuffer(key)) key.fill(0); }
}
async function readExactly(handle, bytes, position, code = 'BACKUP_ARCHIVE_INTEGRITY') {
  let offset = 0;
  while (offset < bytes.length) {
    const { bytesRead } = await handle.read(bytes, offset, bytes.length - offset, position + offset);
    if (!bytesRead) fail(code);
    offset += bytesRead;
  }
}
async function eof(handle, position, code) {
  const probe = Buffer.alloc(1);
  try { if ((await handle.read(probe, 0, 1, position)).bytesRead !== 0) fail(code); }
  finally { probe.fill(0); }
}
async function digestFile(handle, length, code) {
  const digest = crypto.createHash('sha256'); const buffer = Buffer.alloc(Math.min(CHUNK_BYTES, length));
  try {
    for (let offset = 0; offset < length; offset += buffer.length) {
      const bytes = buffer.subarray(0, Math.min(buffer.length, length - offset));
      await readExactly(handle, bytes, offset, code); digest.update(bytes);
    }
    await eof(handle, length, code); return digest.digest('hex');
  } finally { buffer.fill(0); }
}
async function inputFile(options, maximum) {
  const before = await statOrMissing(options.sourcePath);
  if (!before) fail('BACKUP_ARCHIVE_MISSING'); checkPrivate(before, false);
  if (before.size > BigInt(maximum)) fail('BACKUP_ARCHIVE_LIMIT');
  const handle = await fs.open(options.sourcePath, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const opened = await handle.stat({ bigint: true }); checkPrivate(opened, false);
    if (!sameState(before, opened)) fail('BACKUP_ARCHIVE_SOURCE_CHANGED');
    return { handle, stat: opened, async verify() {
      await privateDirectory(options.sourceRoot, options.sourceStat);
      const current = await statOrMissing(options.sourcePath); const after = await handle.stat({ bigint: true });
      if (!current) fail('BACKUP_ARCHIVE_SOURCE_CHANGED'); checkPrivate(current, false); checkPrivate(after, false);
      if (!sameState(opened, current) || !sameState(opened, after)) fail('BACKUP_ARCHIVE_SOURCE_CHANGED');
    } };
  } catch (error) { await handle.close(); throw error; }
}
async function outputFile(options) {
  const { beforeWrite } = options;
  await privateDirectory(options.destinationRoot, options.destinationStat);
  if (await statOrMissing(options.destinationPath)) fail('BACKUP_ARCHIVE_EXISTS');
  const temporary = path.join(options.destinationRoot, `.archive-pending-${crypto.randomBytes(16).toString('hex')}`);
  const handle = await fs.open(temporary, constants.O_RDWR | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  let identity;
  try { identity = await handle.stat({ bigint: true }); }
  catch (error) { await handle.close().catch(() => {}); throw error; }
  let closed = false; let linked = false; let removed = false; let length = 0;
  const writtenHash = crypto.createHash('sha256');
  const unlinkTemporary = async () => {
    if (removed) return;
    await privateDirectory(options.destinationRoot, options.destinationStat);
    const current = await statOrMissing(temporary);
    if (!current || !sameIdentity(current, identity)) fail('BACKUP_ARCHIVE_UNSAFE_PATH');
    checkPrivate(current, false, linked ? 2n : 1n);
    if (linked) {
      const target = await statOrMissing(options.destinationPath);
      if (!target || !sameIdentity(current, target)) fail('BACKUP_ARCHIVE_UNSAFE_PATH');
    }
    await fs.unlink(temporary); removed = true;
  };
  return { async write(bytes) {
    // Account for the complete output buffer once before any part reaches disk.
    // Short-write retries below continue the same reservation without double charging.
    if (beforeWrite) await beforeWrite(String(bytes.length));
    let offset = 0;
    while (offset < bytes.length) {
      const { bytesWritten } = await handle.write(bytes, offset, bytes.length - offset, length + offset);
      if (!bytesWritten) fail('BACKUP_ARCHIVE_IO'); offset += bytesWritten;
    }
    writtenHash.update(bytes); length += bytes.length;
  }, async publish(verifyInput) {
    await options.fault?.('output:verified');
    checkPrivate(await handle.stat({ bigint: true }), false);
    await handle.sync(); await options.fault?.('output:file-synced');
    const written = await handle.stat({ bigint: true }); checkPrivate(written, false);
    if (written.size !== BigInt(length)) fail('BACKUP_ARCHIVE_INTEGRITY');
    if (await digestFile(handle, length, 'BACKUP_ARCHIVE_INTEGRITY') !== writtenHash.digest('hex')) fail('BACKUP_ARCHIVE_INTEGRITY');
    if (!sameState(written, await handle.stat({ bigint: true }))) fail('BACKUP_ARCHIVE_UNSAFE_PATH');
    await verifyInput(); await privateDirectory(options.destinationRoot, options.destinationStat);
    await options.fault?.('output:before-publish');
    await verifyInput(); await privateDirectory(options.destinationRoot, options.destinationStat);
    const current = await fs.lstat(temporary, { bigint: true }); checkPrivate(current, false);
    if (!sameState(current, written)) fail('BACKUP_ARCHIVE_UNSAFE_PATH');
    // link is atomic and cannot overwrite a racing destination (unlike POSIX rename).
    try { await fs.link(temporary, options.destinationPath); linked = true; }
    catch (error) { if (error.code === 'EEXIST') fail('BACKUP_ARCHIVE_EXISTS'); throw error; }
    await options.fault?.('output:published');
    await unlinkTemporary(); await options.fault?.('output:temp-unlinked');
    const published = await handle.stat({ bigint: true }); checkPrivate(published, false);
    if (!sameIdentity(published, written) || published.size !== written.size || published.mtimeNs !== written.mtimeNs)
      fail('BACKUP_ARCHIVE_UNSAFE_PATH');
    await syncDirectory(options.destinationRoot, options.destinationStat);
    await options.fault?.('output:directory-synced');
    const target = await fs.lstat(options.destinationPath, { bigint: true }); checkPrivate(target, false);
    if (!sameState(target, published) || !sameState(target, await handle.stat({ bigint: true }))) fail('BACKUP_ARCHIVE_UNSAFE_PATH');
    await handle.close(); closed = true;
  }, async close() {
    try { if (!closed) { await handle.close(); closed = true; } }
    finally { if (!removed) await unlinkTemporary(); }
  }, async checkCreated() { checkPrivate(identity, false); await options.fault?.('output:created'); } };
}
async function metadataFromInput(input, options) {
  const prefix = Buffer.alloc(12); await readExactly(input.handle, prefix, 0);
  if (!prefix.subarray(0, 8).equals(MAGIC)) fail('BACKUP_ARCHIVE_UNSUPPORTED');
  const length = prefix.readUInt32BE(8);
  if (length < 1 || length > MAX_HEADER) fail('BACKUP_ARCHIVE_FORMAT');
  const bytes = Buffer.alloc(length); await readExactly(input.handle, bytes, 12);
  let value;
  try { value = JSON.parse(bytes.toString('utf8')); } catch { fail('BACKUP_ARCHIVE_FORMAT'); }
  if (value?.version !== VERSION) fail('BACKUP_ARCHIVE_UNSUPPORTED');
  if (!exact(value, ['format', 'version', 'identityHash', 'keyId', 'archiveId', 'chunkBytes', 'chunkCount',
    'payloadBytes', 'payloadSha256', 'wrappedDek']) || value.format !== FORMAT
      || !hex(value.identityHash, HEX64, 64) || value.identityHash !== options.identityHash
      || !hex(value.keyId, HEX32, 32) || !hex(value.archiveId, HEX32, 32)
      || !hex(value.payloadSha256, HEX64, 64) || value.chunkBytes !== CHUNK_BYTES
      || !Number.isSafeInteger(value.payloadBytes) || value.payloadBytes < 0 || value.payloadBytes > options.maximum
      || value.chunkCount !== chunkCount(value.payloadBytes)
      || !exact(value.wrappedDek, ['nonce', 'ciphertext', 'tag'])) fail('BACKUP_ARCHIVE_FORMAT');
  const nonce = base64(value.wrappedDek.nonce, 12); const ciphertext = base64(value.wrappedDek.ciphertext, 32);
  const tag = base64(value.wrappedDek.tag, 16);
  const metadata = core(value);
  const wrapped = { nonce: nonce.toString('base64'), ciphertext: ciphertext.toString('base64'), tag: tag.toString('base64') };
  if (!encodeHeader(metadata, wrapped).equals(bytes)) fail('BACKUP_ARCHIVE_FORMAT');
  if (input.stat.size !== BigInt(12 + length + metadata.chunkCount * FRAME_BYTES + metadata.payloadBytes)) fail('BACKUP_ARCHIVE_FORMAT');
  const dek = await backupKey(options.keyProvider, metadata.keyId,
    key => decryptBytes(ciphertext, key, nonce, tag, wrapAad(metadata)));
  return { metadata, dek, nonce, headerHash: hash(bytes), position: 12 + length };
}
function publicMetadata(metadata) {
  return Object.freeze({ format: VERSION, archiveId: metadata.archiveId, keyId: metadata.keyId,
    identityHash: metadata.identityHash, payloadBytes: metadata.payloadBytes,
    payloadSha256: metadata.payloadSha256, chunkCount: metadata.chunkCount });
}
async function encrypt(input, options) {
  let dek; let output;
  try {
    const payloadBytes = Number(input.stat.size);
    const payloadSha256 = await digestFile(input.handle, payloadBytes, 'BACKUP_ARCHIVE_SOURCE_CHANGED');
    await input.verify(); await options.fault?.('encrypt:after-hash'); await input.verify();
    let id;
    try { id = await options.keyProvider.currentKeyId('backup'); } catch { fail('BACKUP_ARCHIVE_KEY_UNAVAILABLE'); }
    if (!hex(id, HEX32, 32)) fail('BACKUP_ARCHIVE_KEY_UNAVAILABLE');
    const metadata = core({ identityHash: options.identityHash, keyId: id, archiveId: crypto.randomBytes(16).toString('hex'),
      chunkCount: chunkCount(payloadBytes), payloadBytes, payloadSha256 });
    dek = crypto.randomBytes(32); const seen = new Set(); const wrapNonce = uniqueNonce(seen);
    const wrapped = await backupKey(options.keyProvider, id, key => encryptBytes(dek, key, wrapNonce, wrapAad(metadata)));
    const header = encodeHeader(metadata, { nonce: wrapNonce.toString('base64'), ciphertext: wrapped.bytes.toString('base64'), tag: wrapped.tag.toString('base64') });
    if (header.length > MAX_HEADER) fail('BACKUP_ARCHIVE_LIMIT');
    const prefix = Buffer.alloc(12); MAGIC.copy(prefix); prefix.writeUInt32BE(header.length, 8);
    const headerHash = hash(header); const payloadDigest = crypto.createHash('sha256');
    output = await outputFile(options); await output.checkCreated(); await output.write(prefix); await output.write(header);
    for (let index = 0; index < metadata.chunkCount; index += 1) {
      const bytes = Buffer.alloc(chunkSize(metadata, index));
      try {
        await readExactly(input.handle, bytes, index * CHUNK_BYTES, 'BACKUP_ARCHIVE_SOURCE_CHANGED'); payloadDigest.update(bytes);
        const nonce = uniqueNonce(seen); const encrypted = encryptBytes(bytes, dek, nonce, chunkAad(metadata, headerHash, index, bytes.length));
        const frame = Buffer.alloc(FRAME_BYTES); frame.writeUInt32BE(index, 0); frame.writeUInt32BE(bytes.length, 4);
        nonce.copy(frame, 8); encrypted.tag.copy(frame, 20);
        await output.write(frame); await output.write(encrypted.bytes); await options.fault?.('encrypt:chunk-written');
      } finally { bytes.fill(0); }
    }
    await eof(input.handle, payloadBytes, 'BACKUP_ARCHIVE_SOURCE_CHANGED'); await input.verify();
    if (payloadDigest.digest('hex') !== payloadSha256) fail('BACKUP_ARCHIVE_SOURCE_CHANGED');
    await output.publish(() => input.verify()); return publicMetadata(metadata);
  } finally { dek?.fill(0); if (output) await output.close(); }
}
async function decrypt(input, options) {
  let dek; let output;
  try {
    const parsed = await metadataFromInput(input, options); ({ dek } = parsed);
    const { metadata, headerHash } = parsed; let position = parsed.position;
    const seen = new Set([parsed.nonce.toString('hex')]); const payloadDigest = crypto.createHash('sha256');
    output = await outputFile(options); await output.checkCreated();
    for (let index = 0; index < metadata.chunkCount; index += 1) {
      const frame = Buffer.alloc(FRAME_BYTES); await readExactly(input.handle, frame, position); position += FRAME_BYTES;
      const size = frame.readUInt32BE(4); const nonce = frame.subarray(8, 20); const encoded = nonce.toString('hex');
      if (frame.readUInt32BE(0) !== index || size !== chunkSize(metadata, index) || seen.has(encoded)) fail('BACKUP_ARCHIVE_FORMAT');
      seen.add(encoded);
      const ciphertext = Buffer.alloc(size); await readExactly(input.handle, ciphertext, position); position += size;
      const plaintext = decryptBytes(ciphertext, dek, nonce, frame.subarray(20, 36), chunkAad(metadata, headerHash, index, size));
      try {
        payloadDigest.update(plaintext); await output.write(plaintext); await options.fault?.('decrypt:chunk-written');
      } finally { plaintext.fill(0); }
    }
    await eof(input.handle, position, 'BACKUP_ARCHIVE_INTEGRITY'); await input.verify();
    if (payloadDigest.digest('hex') !== metadata.payloadSha256) fail('BACKUP_ARCHIVE_INTEGRITY');
    await output.publish(() => input.verify()); return publicMetadata(metadata);
  } finally { dek?.fill(0); if (output) await output.close(); }
}
async function run(value, decrypting) {
  let input;
  if (activeOperations >= 2) throw new BackupArchiveError('BACKUP_ARCHIVE_BUSY');
  activeOperations += 1;
  try {
    if (typeof process.getuid !== 'function' || !constants.O_NOFOLLOW || !constants.O_DIRECTORY) fail('BACKUP_ARCHIVE_UNSUPPORTED');
    if (!value || typeof value !== 'object') fail('BACKUP_ARCHIVE_ARGUMENT');
    const options = { sourcePath: canonicalPath(value.sourcePath), destinationPath: canonicalPath(value.destinationPath),
      sourceRoot: canonicalPath(value.sourceRoot), destinationRoot: canonicalPath(value.destinationRoot),
      maximum: value.maxPayloadBytes ?? MAX_PAYLOAD, fault: value.fault, beforeWrite: value.beforeWrite };
    if (path.dirname(options.sourcePath) !== options.sourceRoot || path.dirname(options.destinationPath) !== options.destinationRoot
        || options.sourcePath === options.destinationPath || typeof value.installationId !== 'string'
        || value.installationId.match(INSTALLATION_ID)?.[0] !== value.installationId
        || !Number.isSafeInteger(options.maximum) || options.maximum < 0 || options.maximum > MAX_PAYLOAD
        || (options.fault !== undefined && typeof options.fault !== 'function')
        || (options.beforeWrite !== undefined && typeof options.beforeWrite !== 'function')
        || !value.keyProvider || typeof value.keyProvider.getBackupKey !== 'function'
        || (!decrypting && typeof value.keyProvider.currentKeyId !== 'function')) fail('BACKUP_ARCHIVE_ARGUMENT');
    options.keyProvider = { getBackupKey: value.keyProvider.getBackupKey.bind(value.keyProvider),
      currentKeyId: value.keyProvider.currentKeyId?.bind(value.keyProvider) };
    options.identityHash = hash(Buffer.from(`CI-BACKUP-INSTALLATION-3\0${value.installationId}`, 'utf8'));
    options.sourceStat = await privateDirectory(options.sourceRoot);
    options.destinationStat = await privateDirectory(options.destinationRoot);
    if (await statOrMissing(options.destinationPath)) fail('BACKUP_ARCHIVE_EXISTS');
    const maximum = decrypting ? options.maximum + 12 + MAX_HEADER + chunkCount(options.maximum) * FRAME_BYTES : options.maximum;
    input = await inputFile(options, maximum);
    return await (decrypting ? decrypt(input, options) : encrypt(input, options));
  } catch (error) { throw safeError(error); }
  finally {
    try { if (input) await input.handle.close(); }
    catch (error) { throw safeError(error); }
    finally { activeOperations -= 1; }
  }
}

module.exports = Object.freeze({ encryptFile: options => run(options, false), decryptFile: options => run(options, true), BackupArchiveError });
