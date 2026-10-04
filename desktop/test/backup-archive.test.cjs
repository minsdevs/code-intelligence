'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { encryptFile, decryptFile, BackupArchiveError } = require('../src/backup-archive.cjs');
const { initializePurposeKeyring, openPurposeKeyring } = require('../src/purpose-keyring.cjs');

const CHUNK = 1024 * 1024;
const MAX = 10 * 1024 * 1024 * 1024;
const hash = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
function wrapper() {
  const key = Buffer.alloc(32, 96);
  return { async isAvailable() { return true; }, async wrap(bytes) {
    const nonce = crypto.randomBytes(12); const cipher = crypto.createCipheriv('aes-256-gcm', key, nonce);
    cipher.setAAD(Buffer.from('synthetic-backup-container-wrapper'));
    return Buffer.concat([nonce, cipher.update(bytes), cipher.final(), cipher.getAuthTag()]);
  }, async unwrap(bytes) {
    const decipher = crypto.createDecipheriv('aes-256-gcm', key, bytes.subarray(0, 12));
    decipher.setAAD(Buffer.from('synthetic-backup-container-wrapper')); decipher.setAuthTag(bytes.subarray(-16));
    return Buffer.concat([decipher.update(bytes.subarray(12, -16)), decipher.final()]);
  } };
}
async function fixture(t, payload = Buffer.from('synthetic opaque payload\0no archive extraction')) {
  const root = await fs.mkdtemp(path.join(await fs.realpath(os.tmpdir()), 'ci-backup-container-'));
  await fs.chmod(root, 0o700);
  const sourceRoot = path.join(root, 'staging'); const archiveRoot = path.join(root, 'archives'); const restoredRoot = path.join(root, 'restored');
  for (const dir of [sourceRoot, archiveRoot, restoredRoot]) await fs.mkdir(dir, { mode: 0o700 });
  const keyOptions = { safetyRoot: path.join(root, 'safety'), restoreRoots: [sourceRoot, archiveRoot, restoredRoot],
    installationId: '-synthetic-backup_installation', wrapper: wrapper() };
  const keyrings = []; const issued = []; const holder = { keys: await initializePurposeKeyring(keyOptions) }; keyrings.push(holder.keys);
  t.after(async () => { for (const keys of keyrings) await keys.close().catch(() => {}); await fs.rm(root, { recursive: true, force: true }); });
  const keyProvider = { currentKeyId: purpose => holder.keys.currentKeyId(purpose), async getBackupKey(id) {
    const bytes = await holder.keys.getBackupKey(id); issued.push(bytes); return bytes;
  } };
  const sourcePath = path.join(sourceRoot, 'input.bin'); const archivePath = path.join(archiveRoot, 'backup.cib');
  const restoredPath = path.join(restoredRoot, 'payload.bin'); await fs.writeFile(sourcePath, payload, { mode: 0o600 });
  const encryptOptions = { sourcePath, sourceRoot, destinationRoot: archiveRoot, destinationPath: archivePath,
    installationId: keyOptions.installationId, keyProvider };
  const decryptOptions = { sourcePath: archivePath, sourceRoot: archiveRoot, destinationRoot: restoredRoot, destinationPath: restoredPath,
    installationId: keyOptions.installationId, keyProvider };
  return { root, sourceRoot, archiveRoot, restoredRoot, sourcePath, archivePath, restoredPath, holder, issued, encryptOptions, decryptOptions,
    encrypt: overrides => encryptFile({ ...encryptOptions, ...overrides }), decrypt: overrides => decryptFile({ ...decryptOptions, ...overrides }),
    async reopenKeys() { await holder.keys.close(); holder.keys = await openPurposeKeyring(keyOptions); keyrings.push(holder.keys); },
  };
}
async function rejects(promise, code) {
  await assert.rejects(promise, error => {
    assert.ok(error instanceof BackupArchiveError); if (code) assert.equal(error.code, code);
    assert.equal(error.cause, undefined); assert.doesNotMatch(String(error), /synthetic-secret-path|injected-secret/); return true;
  });
}
async function noPublication(f, decrypting = true) {
  const target = decrypting ? f.restoredPath : f.archivePath;
  await assert.rejects(fs.stat(target), { code: 'ENOENT' });
  const files = await fs.readdir(decrypting ? f.restoredRoot : f.archiveRoot);
  assert.equal(files.some(name => name.startsWith('.archive-pending-')), false);
}
function keysCleared(f) {
  assert.ok(f.issued.length > 0);
  for (const bytes of f.issued) assert.equal(bytes.every(byte => byte === 0), true);
}
function parseArchive(bytes) {
  const size = bytes.readUInt32BE(8); const header = JSON.parse(bytes.subarray(12, 12 + size));
  const frames = []; let position = 12 + size;
  while (position < bytes.length) {
    const length = bytes.readUInt32BE(position + 4); frames.push(bytes.subarray(position, position + 36 + length)); position += 36 + length;
  }
  return { header, prefix: bytes.subarray(0, 12 + size), frames };
}
function replaceHeader(bytes, mutate) {
  const size = bytes.readUInt32BE(8); const original = bytes.subarray(12, 12 + size);
  const changed = mutate(JSON.parse(original), original);
  const encoded = Buffer.isBuffer(changed) ? changed : Buffer.from(JSON.stringify(changed));
  const prefix = Buffer.from(bytes.subarray(0, 12)); prefix.writeUInt32BE(encoded.length, 8);
  return Buffer.concat([prefix, encoded, bytes.subarray(12 + size)]);
}
function encryptBytes(bytes, key, nonce, aad) {
  const cipher = crypto.createCipheriv('aes-256-gcm', key, nonce); cipher.setAAD(aad);
  return { bytes: Buffer.concat([cipher.update(bytes), cipher.final()]), tag: cipher.getAuthTag() };
}
function core(header) { const { wrappedDek, ...metadata } = header; return metadata; }
function wrapAAD(header) { return Buffer.from(`CI-BACKUP-DEK-3\0${JSON.stringify(core(header))}`); }
function chunkAAD(header, headerHash, index, size) {
  return Buffer.from(JSON.stringify({ domain: 'CI-BACKUP-CHUNK-3', format: header.format, version: 3,
    identityHash: header.identityHash, keyId: header.keyId, archiveId: header.archiveId, headerHash,
    index, chunkCount: header.chunkCount, payloadBytes: header.payloadBytes, chunkPlainBytes: size }));
}
async function rewriteAuthenticated(f, change, duplicateNonce = false) {
  const original = parseArchive(await fs.readFile(f.archivePath));
  const key = await f.holder.keys.getBackupKey(original.header.keyId); let dek;
  try {
    const wrapped = original.header.wrappedDek;
    const decipher = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(wrapped.nonce, 'base64'));
    decipher.setAAD(wrapAAD(original.header)); decipher.setAuthTag(Buffer.from(wrapped.tag, 'base64'));
    dek = Buffer.concat([decipher.update(Buffer.from(wrapped.ciphertext, 'base64')), decipher.final()]);
    const header = structuredClone(original.header); change(header);
    const nonce = crypto.randomBytes(12); const encrypted = encryptBytes(dek, key, nonce, wrapAAD(header));
    header.wrappedDek = { nonce: nonce.toString('base64'), ciphertext: encrypted.bytes.toString('base64'), tag: encrypted.tag.toString('base64') };
    const encoded = Buffer.from(JSON.stringify(header)); const prefix = Buffer.from(original.prefix.subarray(0, 12)); prefix.writeUInt32BE(encoded.length, 8);
    const payload = await fs.readFile(f.sourcePath); const frames = []; const firstNonce = crypto.randomBytes(12);
    for (let index = 0; index < header.chunkCount; index++) {
      const plain = payload.subarray(index * CHUNK, Math.min(payload.length, (index + 1) * CHUNK));
      const chunkNonce = duplicateNonce ? firstNonce : crypto.randomBytes(12);
      const result = encryptBytes(plain, dek, chunkNonce, chunkAAD(header, hash(encoded), index, plain.length));
      const frame = Buffer.alloc(36); frame.writeUInt32BE(index, 0); frame.writeUInt32BE(plain.length, 4); chunkNonce.copy(frame, 8); result.tag.copy(frame, 20);
      frames.push(frame, result.bytes);
    }
    await fs.writeFile(f.archivePath, Buffer.concat([prefix, encoded, ...frames]));
  } finally { key.fill(0); dek?.fill(0); }
}
function deferred() { let resolve; const promise = new Promise(done => { resolve = done; }); return { resolve, promise }; }

for (const size of [0, 1, CHUNK - 1, CHUNK, CHUNK + 1, CHUNK * 2 + 17]) {
  test(`opaque ${size}-byte payload roundtrips at fixed chunk boundaries`, async t => {
    const payload = Buffer.alloc(size, 43); const f = await fixture(t, payload);
    const encoded = await f.encrypt(); const decoded = await f.decrypt();
    assert.deepEqual(decoded, encoded); assert.equal(encoded.format, 3); assert.equal(encoded.payloadBytes, size);
    assert.equal(encoded.payloadSha256, hash(payload)); assert.equal(encoded.chunkCount, Math.ceil(size / CHUNK));
    assert.equal(Object.isFrozen(encoded), true); assert.deepEqual(await fs.readFile(f.restoredPath), payload);
    assert.deepEqual(await fs.readFile(f.sourcePath), payload);
    for (const file of [f.archivePath, f.restoredPath]) {
      const stat = await fs.stat(file); assert.equal(stat.nlink, 1); assert.equal(stat.mode & 0o7777, 0o600);
    }
    keysCleared(f);
  });
}

test('archive persists wrapped DEK/ciphertext, independent archive IDs and nonces, without installation text or raw keys', async t => {
  const payload = Buffer.from('synthetic private staged payload repeated; no credentials from user data'); const f = await fixture(t, payload);
  const first = await f.encrypt(); const firstBytes = await fs.readFile(f.archivePath);
  const secondPath = path.join(f.archiveRoot, 'second.cib'); const second = await f.encrypt({ destinationPath: secondPath });
  const secondBytes = await fs.readFile(secondPath); assert.notEqual(first.archiveId, second.archiveId); assert.notDeepEqual(firstBytes, secondBytes);
  assert.equal(firstBytes.includes(payload), false); assert.equal(firstBytes.includes(f.encryptOptions.installationId), false);
  const key = await f.holder.keys.getBackupKey(first.keyId);
  try { assert.equal(firstBytes.includes(key), false); assert.equal(firstBytes.includes(key.toString('base64')), false); }
  finally { key.fill(0); }
  const parsed = parseArchive(firstBytes); const nonces = [Buffer.from(parsed.header.wrappedDek.nonce, 'base64').toString('hex'), ...parsed.frames.map(frame => frame.subarray(8, 20).toString('hex'))];
  assert.equal(new Set(nonces).size, nonces.length); keysCleared(f);
});

test('old backup remains decryptable after purpose-keyring rotation and full reopen', async t => {
  const f = await fixture(t); const first = await f.encrypt(); const nextId = await f.holder.keys.rotate('backup');
  assert.notEqual(nextId, first.keyId); await f.reopenKeys();
  const decoded = await f.decrypt(); assert.equal(decoded.keyId, first.keyId); keysCleared(f);
});

test('empty archive still authenticates the DEK header and verifies the entire plaintext hash', async t => {
  const f = await fixture(t, Buffer.alloc(0)); await f.encrypt();
  assert.equal(parseArchive(await fs.readFile(f.archivePath)).frames.length, 0);
  await rewriteAuthenticated(f, header => { header.payloadSha256 = hash('incorrect empty payload hash'); });
  await rejects(f.decrypt(), 'BACKUP_ARCHIVE_INTEGRITY'); await noPublication(f); keysCleared(f);
});

test('whole-payload hash catches wrong authenticated metadata even with valid chunk AEAD', async t => {
  const f = await fixture(t, Buffer.alloc(CHUNK + 1, 61)); await f.encrypt();
  await rewriteAuthenticated(f, header => { header.payloadSha256 = hash('incorrect expected payload hash'); });
  await rejects(f.decrypt(), 'BACKUP_ARCHIVE_INTEGRITY'); await noPublication(f);
});

test('authenticated duplicate chunk nonce is rejected before second plaintext publication', async t => {
  const f = await fixture(t, Buffer.alloc(CHUNK + 1, 61)); await f.encrypt();
  await rewriteAuthenticated(f, () => {}, true);
  await rejects(f.decrypt(), 'BACKUP_ARCHIVE_FORMAT'); await noPublication(f);
});

for (const [label, change] of [
  ['unknown version', value => ({ ...value, version: 4 })],
  ['unknown format', value => ({ ...value, format: 'other' })],
  ['changed identity hash', value => ({ ...value, identityHash: '0'.repeat(64) })],
  ['changed archive ID', value => ({ ...value, archiveId: '0'.repeat(32) })],
  ['changed key ID', value => ({ ...value, keyId: '0'.repeat(32) })],
  ['noncanonical key ID', value => ({ ...value, keyId: value.keyId + '\n' })],
  ['changed size', value => ({ ...value, payloadBytes: value.payloadBytes + 1 })],
  ['changed chunk count', value => ({ ...value, chunkCount: value.chunkCount + 1 })],
  ['changed chunk bytes', value => ({ ...value, chunkBytes: CHUNK / 2 })],
  ['changed hash', value => ({ ...value, payloadSha256: '0'.repeat(64) })],
  ['negative size', value => ({ ...value, payloadBytes: -1 })],
  ['over-cap size', value => ({ ...value, payloadBytes: MAX + 1 })],
  ['noninteger size', value => ({ ...value, payloadBytes: 1.5 })],
  ['unknown field', value => ({ ...value, extra: true })],
  ['DEK tag', value => { value.wrappedDek.tag = Buffer.alloc(16).toString('base64'); return value; }],
  ['DEK nonce length', value => { value.wrappedDek.nonce = Buffer.alloc(11).toString('base64'); return value; }],
  ['DEK ciphertext', value => { value.wrappedDek.ciphertext = Buffer.alloc(32).toString('base64'); return value; }],
  ['duplicate JSON field', (_value, bytes) => Buffer.from(bytes.toString().replace('"version":3', '"version":3,"version":3'))],
  ['noncanonical whitespace', (_value, bytes) => Buffer.concat([bytes, Buffer.from('\n')])],
  ['invalid UTF8', (_value, bytes) => Buffer.concat([bytes, Buffer.from([255])])],
]) {
  test(`header ${label} fails closed`, async t => {
    const f = await fixture(t); await f.encrypt(); const original = await fs.readFile(f.archivePath);
    await fs.writeFile(f.archivePath, replaceHeader(original, change));
    await rejects(f.decrypt()); await noPublication(f);
  });
}

for (const defect of ['missing', 'reordered', 'duplicate-index', 'oversized-length', 'nonce', 'tag', 'ciphertext', 'trailing', 'cross-archive']) {
  test(`chunk ${defect} is rejected with no published plaintext`, async t => {
    const f = await fixture(t, Buffer.alloc(CHUNK + 1, 45)); await f.encrypt(); const original = await fs.readFile(f.archivePath);
    const { prefix, frames } = parseArchive(original); let modified;
    if (defect === 'missing') modified = Buffer.concat([prefix, frames[0]]);
    else if (defect === 'reordered') modified = Buffer.concat([prefix, frames[1], frames[0]]);
    else if (defect === 'trailing') modified = Buffer.concat([original, Buffer.from([1])]);
    else if (defect === 'cross-archive') {
      const otherPath = path.join(f.archiveRoot, 'other.cib'); await f.encrypt({ destinationPath: otherPath });
      modified = Buffer.concat([prefix, parseArchive(await fs.readFile(otherPath)).frames[0], frames[1]]);
    } else {
      const first = Buffer.from(frames[0]); const second = Buffer.from(frames[1]);
      if (defect === 'duplicate-index') second.writeUInt32BE(0, 0);
      if (defect === 'oversized-length') first.writeUInt32BE(0xffffffff, 4);
      if (defect === 'nonce') first[8] ^= 1;
      if (defect === 'tag') first[20] ^= 1;
      if (defect === 'ciphertext') first[36] ^= 1;
      modified = Buffer.concat([prefix, first, second]);
    }
    await fs.writeFile(f.archivePath, modified); await rejects(f.decrypt()); await noPublication(f);
  });
}

test('truncation at prefix, header, frame and ciphertext boundaries always fails without plaintext', async t => {
  const f = await fixture(t, Buffer.alloc(CHUNK + 2, 43)); await f.encrypt(); const original = await fs.readFile(f.archivePath);
  const start = parseArchive(original).prefix.length;
  for (const offset of [0, 7, 11, 12, start - 1, start, start + 8, start + 35, start + 36, original.length - 1]) {
    await fs.writeFile(f.archivePath, original.subarray(0, offset)); await rejects(f.decrypt()); await noPublication(f);
  }
});

test('header length allocation bound and magic/version checks precede decoding', async t => {
  const f = await fixture(t); await f.encrypt(); const original = await fs.readFile(f.archivePath);
  for (const size of [0, 4097, 0xffffffff]) {
    const changed = Buffer.from(original); changed.writeUInt32BE(size, 8); await fs.writeFile(f.archivePath, changed);
    await rejects(f.decrypt(), 'BACKUP_ARCHIVE_FORMAT'); await noPublication(f);
  }
  const changed = Buffer.from(original); changed[0] ^= 1; await fs.writeFile(f.archivePath, changed);
  await rejects(f.decrypt(), 'BACKUP_ARCHIVE_UNSUPPORTED');
});

test('wrong installation, unavailable old key, and wrong-purpose key never publish plaintext', async t => {
  const f = await fixture(t); await f.encrypt();
  await rejects(f.decrypt({ installationId: 'other-installation' }), 'BACKUP_ARCHIVE_FORMAT');
  await rejects(f.decrypt({ keyProvider: { async getBackupKey() { throw new Error('injected-secret'); } } }), 'BACKUP_ARCHIVE_KEY_UNAVAILABLE');
  const safetyId = await f.holder.keys.currentKeyId('safety'); const issued = [];
  await rejects(f.decrypt({ keyProvider: { async getBackupKey() { const key = await f.holder.keys.getMacKey(safetyId, 'safety'); issued.push(key); return key; } } }), 'BACKUP_ARCHIVE_INTEGRITY');
  for (const key of issued) assert.equal(key.every(byte => byte === 0), true);
  await noPublication(f);
});

for (const size of [0, 31, 33]) {
  test(`invalid ${size}-byte backup key copy is cleared on both encryption and decryption failure`, async t => {
    const f = await fixture(t); await f.encrypt(); const issued = [];
    const keyProvider = { currentKeyId: () => 'a'.repeat(32), async getBackupKey() { const bytes = Buffer.alloc(size, 68); issued.push(bytes); return bytes; } };
    await rejects(f.encrypt({ destinationPath: path.join(f.archiveRoot, 'invalid.cib'), keyProvider }), 'BACKUP_ARCHIVE_KEY_UNAVAILABLE');
    await rejects(f.decrypt({ keyProvider }), 'BACKUP_ARCHIVE_KEY_UNAVAILABLE');
    assert.equal(issued.length, 2); for (const key of issued) assert.equal(key.every(byte => byte === 0), true);
    await noPublication(f);
  });
}

test('payload cap is fixed at 10GiB and lower test limits apply before input allocation', async t => {
  const f = await fixture(t, Buffer.alloc(10, 71));
  await rejects(f.encrypt({ maxPayloadBytes: 9 }), 'BACKUP_ARCHIVE_LIMIT'); await noPublication(f, false);
  await f.encrypt({ maxPayloadBytes: 10 }); await rejects(f.decrypt({ maxPayloadBytes: 9 }), 'BACKUP_ARCHIVE_FORMAT');
  await noPublication(f);
  for (const maxPayloadBytes of [MAX + 1, -1, 0.5, NaN, '10']) await rejects(f.decrypt({ maxPayloadBytes }), 'BACKUP_ARCHIVE_ARGUMENT');
  await fs.truncate(f.sourcePath, MAX + 1); // Sparse synthetic size; no 10GiB payload is written/read.
  await rejects(f.encrypt({ destinationPath: path.join(f.archiveRoot, 'oversized.cib') }), 'BACKUP_ARCHIVE_LIMIT');
});

test('zero-byte lower cap still supports the fully authenticated empty container', async t => {
  const f = await fixture(t, Buffer.alloc(0)); await f.encrypt({ maxPayloadBytes: 0 }); await f.decrypt({ maxPayloadBytes: 0 });
  assert.equal((await fs.stat(f.restoredPath)).size, 0);
});

test('existing encryption/decryption destinations are never overwritten', async t => {
  const f = await fixture(t); await fs.writeFile(f.archivePath, 'existing archive', { mode: 0o600 });
  await rejects(f.encrypt(), 'BACKUP_ARCHIVE_EXISTS'); assert.equal(await fs.readFile(f.archivePath, 'utf8'), 'existing archive');
  await fs.unlink(f.archivePath); await f.encrypt(); await fs.writeFile(f.restoredPath, 'existing plaintext', { mode: 0o600 });
  await rejects(f.decrypt(), 'BACKUP_ARCHIVE_EXISTS'); assert.equal(await fs.readFile(f.restoredPath, 'utf8'), 'existing plaintext');
});

for (const decrypting of [false, true]) {
  test(`racing destination creation cannot be clobbered by ${decrypting ? 'decrypt' : 'encrypt'} publication`, async t => {
    const f = await fixture(t); if (decrypting) await f.encrypt();
    const target = decrypting ? f.restoredPath : f.archivePath;
    const fault = async stage => { if (stage === 'output:before-publish') await fs.writeFile(target, 'concurrent owner', { flag: 'wx', mode: 0o600 }); };
    await rejects(decrypting ? f.decrypt({ fault }) : f.encrypt({ fault }), 'BACKUP_ARCHIVE_EXISTS');
    assert.equal(await fs.readFile(target, 'utf8'), 'concurrent owner');
    assert.equal((await fs.readdir(decrypting ? f.restoredRoot : f.archiveRoot)).some(name => name.startsWith('.archive-pending-')), false);
  });
}

for (const stage of ['output:created', 'output:verified', 'output:file-synced', 'output:before-publish', 'output:published', 'output:temp-unlinked', 'output:directory-synced']) {
  for (const decrypting of [false, true]) {
    test(`${decrypting ? 'decrypt' : 'encrypt'} fault at ${stage} never ACKs or deletes another destination`, async t => {
      const payload = Buffer.alloc(31, 35); const f = await fixture(t, payload); if (decrypting) await f.encrypt();
      const fault = actual => { if (actual === stage) throw new Error('injected-secret'); };
      await rejects(decrypting ? f.decrypt({ fault }) : f.encrypt({ fault }), 'BACKUP_ARCHIVE_IO');
      const published = ['output:published', 'output:temp-unlinked', 'output:directory-synced'].includes(stage);
      if (!published) await noPublication(f, decrypting);
      else if (decrypting) assert.deepEqual(await fs.readFile(f.restoredPath), payload);
      else { await f.decrypt(); assert.deepEqual(await fs.readFile(f.restoredPath), payload); }
      assert.deepEqual(await fs.readFile(f.sourcePath), payload); keysCleared(f);
    });
  }
}

test('publication acknowledgment waits for directory fsync completion', async t => {
  const f = await fixture(t); const reached = deferred(); const release = deferred(); let completed = false;
  const pending = f.encrypt({ async fault(stage) { if (stage === 'output:directory-synced') { reached.resolve(); await release.promise; } } })
    .then(result => { completed = true; return result; });
  await reached.promise; assert.equal(completed, false); release.resolve(); await pending; assert.equal(completed, true);
});

for (const stage of ['encrypt:after-hash', 'encrypt:chunk-written', 'decrypt:chunk-written']) {
  test(`input mutation during ${stage} prevents publication`, async t => {
    const f = await fixture(t, Buffer.alloc(CHUNK + 1, 49)); const decrypting = stage.startsWith('decrypt'); if (decrypting) await f.encrypt();
    let changed = false; const target = decrypting ? f.archivePath : f.sourcePath;
    const fault = async actual => { if (!changed && actual === stage) { changed = true; await fs.appendFile(target, Buffer.from([32])); } };
    await rejects(decrypting ? f.decrypt({ fault }) : f.encrypt({ fault })); await noPublication(f, decrypting);
  });
}

test('same-size source mutation between hashing and encryption is detected', async t => {
  const f = await fixture(t, Buffer.alloc(31, 40));
  await rejects(f.encrypt({ async fault(stage) {
    if (stage === 'encrypt:after-hash') await fs.writeFile(f.sourcePath, Buffer.alloc(31, 41));
  } }), 'BACKUP_ARCHIVE_SOURCE_CHANGED'); await noPublication(f, false);
});

for (const decrypting of [false, true]) {
  test((decrypting ? 'decrypt integrity' : 'encrypt source mutation') + ' remains the primary error when resource closes also fail', async t => {
    const f = await fixture(t, Buffer.alloc(31, 40));
    let original;
    if (decrypting) {
      await f.encrypt(); original = await fs.readFile(f.archivePath);
      const corrupt = Buffer.from(original); corrupt[corrupt.length - 1] ^= 1;
      await fs.writeFile(f.archivePath, corrupt);
    }
    const open = fs.open, inputPath = decrypting ? f.archivePath : f.sourcePath;
    t.mock.method(fs, 'open', async (...args) => {
      const handle = await open(...args);
      if (args[0] === inputPath || path.basename(args[0]).startsWith('.archive-pending-')) {
        const close = handle.close.bind(handle);
        t.mock.method(handle, 'close', async () => { await close(); throw new Error('private cleanup detail'); });
      }
      return handle;
    });
    const operation = decrypting ? f.decrypt() : f.encrypt({ async fault(stage) {
      if (stage === 'encrypt:after-hash') await fs.writeFile(f.sourcePath, Buffer.alloc(31, 41));
    } });
    await rejects(operation, decrypting ? 'BACKUP_ARCHIVE_INTEGRITY' : 'BACKUP_ARCHIVE_SOURCE_CHANGED');
    await noPublication(f, decrypting);
    t.mock.restoreAll();
    if (decrypting) { await fs.writeFile(f.archivePath, original); await f.decrypt(); }
    else await f.encrypt();
  });
}

test('a final input close failure still prevents an archive success acknowledgement', async t => {
  const payload = Buffer.alloc(31, 53), f = await fixture(t, payload), open = fs.open;
  t.mock.method(fs, 'open', async (...args) => {
    const handle = await open(...args);
    if (args[0] === f.sourcePath) {
      const close = handle.close.bind(handle);
      t.mock.method(handle, 'close', async () => { await close(); throw new Error('private cleanup detail'); });
    }
    return handle;
  });
  await rejects(f.encrypt(), 'BACKUP_ARCHIVE_IO');
  t.mock.restoreAll();
  await f.decrypt(); assert.deepEqual(await fs.readFile(f.restoredPath), payload);
});

test('replaced input path cannot be read through an old open descriptor', async t => {
  const f = await fixture(t);
  await rejects(f.encrypt({ async fault(stage) {
    if (stage === 'encrypt:after-hash') { await fs.rename(f.sourcePath, path.join(f.sourceRoot, 'saved.bin')); await fs.writeFile(f.sourcePath, 'replacement', { mode: 0o600 }); }
  } }), 'BACKUP_ARCHIVE_SOURCE_CHANGED'); await noPublication(f, false);
});

test('temporary content mutation is caught by bounded output reread before publication', async t => {
  const f = await fixture(t);
  await rejects(f.encrypt({ async fault(stage) {
    if (stage === 'output:verified') {
      const name = (await fs.readdir(f.archiveRoot)).find(value => value.startsWith('.archive-pending-'));
      const handle = await fs.open(path.join(f.archiveRoot, name), 'r+');
      try { await handle.write(Buffer.from([0]), 0, 1, 0); } finally { await handle.close(); }
    }
  } }), 'BACKUP_ARCHIVE_INTEGRITY'); await noPublication(f, false);
});

test('replaced temporary path is preserved and never treated as this operation-owned file', async t => {
  const f = await fixture(t); let foreign;
  await rejects(f.encrypt({ async fault(stage) {
    if (stage === 'output:created') {
      const name = (await fs.readdir(f.archiveRoot)).find(value => value.startsWith('.archive-pending-')); foreign = path.join(f.archiveRoot, name);
      await fs.rename(foreign, path.join(f.archiveRoot, 'moved-own-temp'));
      await fs.writeFile(foreign, 'foreign replacement', { mode: 0o600 });
    }
  } }), 'BACKUP_ARCHIVE_UNSAFE_PATH');
  assert.equal(await fs.readFile(foreign, 'utf8'), 'foreign replacement'); await assert.rejects(fs.stat(f.archivePath), { code: 'ENOENT' });
});

for (const defect of ['source-symlink', 'source-hardlink', 'source-mode', 'source-root-symlink', 'destination-root-symlink', 'destination-root-mode']) {
  test(`${defect} cannot bypass private no-follow file boundaries`, async t => {
    const f = await fixture(t);
    if (defect === 'source-symlink') { const moved = path.join(f.sourceRoot, 'other'); await fs.rename(f.sourcePath, moved); await fs.symlink(moved, f.sourcePath); }
    if (defect === 'source-hardlink') await fs.link(f.sourcePath, path.join(f.sourceRoot, 'other'));
    if (defect === 'source-mode') await fs.chmod(f.sourcePath, 0o644);
    if (defect.endsWith('root-symlink')) {
      const root = defect.startsWith('source') ? f.sourceRoot : f.archiveRoot; const moved = root + '-saved'; await fs.rename(root, moved); await fs.symlink(moved, root);
    }
    if (defect === 'destination-root-mode') await fs.chmod(f.archiveRoot, 0o755);
    await rejects(f.encrypt(), 'BACKUP_ARCHIVE_UNSAFE_PATH');
  });
}

test('canonical direct-child paths and bounded installation identity are required', async t => {
  const f = await fixture(t);
  for (const sourcePath of ['relative', f.sourcePath + '/', f.sourceRoot + '/a/../input.bin', path.join(f.sourceRoot, 'nested', 'file')])
    await rejects(f.encrypt({ sourcePath }), 'BACKUP_ARCHIVE_ARGUMENT');
  for (const installationId of ['', 'a'.repeat(129), '../other', 'space id', 'id\n'])
    await rejects(f.encrypt({ installationId }), 'BACKUP_ARCHIVE_ARGUMENT');
  await rejects(f.encrypt({ destinationPath: f.sourcePath, destinationRoot: f.sourceRoot }), 'BACKUP_ARCHIVE_ARGUMENT');
});

test('all accepted operations are bounded to two, and capacity is released after failure', async t => {
  const f = await fixture(t); const release = deferred(); const both = deferred(); let entered = 0;
  const fault = async stage => { if (stage === 'encrypt:after-hash') { if (++entered === 2) both.resolve(); await release.promise; throw new Error('injected-secret'); } };
  const first = f.encrypt({ fault }); const second = f.encrypt({ fault, destinationPath: path.join(f.archiveRoot, 'second.cib') });
  const settled = Promise.allSettled([first, second]); await both.promise;
  await rejects(f.encrypt({ destinationPath: path.join(f.archiveRoot, 'third.cib') }), 'BACKUP_ARCHIVE_BUSY');
  release.resolve(); assert.equal((await settled).every(value => value.status === 'rejected'), true);
  await f.encrypt(); await f.decrypt();
});

test('two concurrent writers to one destination yield exactly one complete archive', async t => {
  const f = await fixture(t); const release = deferred(); let entered = 0;
  const fault = async stage => { if (stage === 'output:before-publish') { if (++entered === 2) release.resolve(); await release.promise; } };
  const results = await Promise.allSettled([f.encrypt({ fault }), f.encrypt({ fault })]);
  assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
  assert.equal(results.find(result => result.status === 'rejected').reason.code, 'BACKUP_ARCHIVE_EXISTS'); await f.decrypt();
});

test('nonce collision aborts and clears the per-archive DEK instead of reusing a nonce', async t => {
  const f = await fixture(t); const original = crypto.randomBytes; const deks = [];
  crypto.randomBytes = size => { if (size === 12) return Buffer.alloc(12, 97); const bytes = original(size); if (size === 32) deks.push(bytes); return bytes; };
  try { await rejects(f.encrypt(), 'BACKUP_ARCHIVE_IO'); }
  finally { crypto.randomBytes = original; }
  assert.equal(deks.length, 1); assert.equal(deks[0].every(byte => byte === 0), true); await noPublication(f, false); keysCleared(f);
});

test('multi-chunk processing uses bounded reads and works with whole-file read APIs disabled', async t => {
  const f = await fixture(t, Buffer.alloc(CHUNK * 4 + 1, 75));
  const probe = await fs.open(f.sourcePath, 'r'); const prototype = Object.getPrototypeOf(probe); await probe.close();
  const originalRead = prototype.read; const originalReadFile = fs.readFile; let maximumReadBuffer = 0;
  prototype.read = function (buffer, ...args) {
    if (Buffer.isBuffer(buffer)) maximumReadBuffer = Math.max(maximumReadBuffer, buffer.length);
    return originalRead.call(this, buffer, ...args);
  };
  fs.readFile = async () => { throw new Error('Whole-file read is forbidden in this resource regression.'); };
  try { await f.encrypt(); await f.decrypt(); }
  finally { prototype.read = originalRead; fs.readFile = originalReadFile; }
  assert.equal(maximumReadBuffer, CHUNK);
  assert.equal((await fs.stat(f.restoredPath)).size, CHUNK * 4 + 1);
});

test('beforeWrite meters prefix, header, every encrypted frame and ciphertext, and decrypted plaintext exactly', async t => {
  const payload = Buffer.alloc(CHUNK + 17, 42); const f = await fixture(t, payload);
  const encrypted = [], decrypted = [];
  const meter = (root, calls) => async function (bytes) {
    assert.equal(this, undefined); assert.equal(arguments.length, 1); assert.match(bytes, /^(0|[1-9][0-9]*)$/);
    const [temporary] = (await fs.readdir(root)).filter(name => name.startsWith('.archive-pending-'));
    assert.ok(temporary);
    assert.equal((await fs.stat(path.join(root, temporary), { bigint: true })).size, calls.reduce((sum, n) => sum + BigInt(n), 0n));
    calls.push(bytes);
  };
  await f.encrypt({ beforeWrite: meter(f.archiveRoot, encrypted) });
  const archive = await fs.readFile(f.archivePath); const parsed = parseArchive(archive);
  assert.deepEqual(encrypted, ['12', String(parsed.prefix.length - 12), '36', String(CHUNK), '36', '17']);
  assert.equal(encrypted.reduce((sum, n) => sum + BigInt(n), 0n), BigInt(archive.length));
  await f.decrypt({ beforeWrite: meter(f.restoredRoot, decrypted) });
  assert.deepEqual(decrypted, [String(CHUNK), '17']); assert.deepEqual(await fs.readFile(f.restoredPath), payload); keysCleared(f);
});

test('empty archive meters its prefix and header while empty decryption performs no output-byte write', async t => {
  const f = await fixture(t, Buffer.alloc(0)); const encrypted = [], decrypted = [];
  await f.encrypt({ beforeWrite: async bytes => { encrypted.push(bytes); } });
  assert.equal(encrypted.length, 2); assert.equal(encrypted[0], '12');
  assert.equal(encrypted.reduce((sum, n) => sum + BigInt(n), 0n), (await fs.stat(f.archivePath, { bigint: true })).size);
  await f.decrypt({ beforeWrite: async bytes => { decrypted.push(bytes); } });
  assert.deepEqual(decrypted, []); assert.equal((await fs.stat(f.restoredPath)).size, 0); keysCleared(f);
});

for (const decrypting of [false, true]) {
  test(`beforeWrite ${decrypting ? 'decrypt' : 'encrypt'} waits before writing and captures the original callback`, async t => {
    const f = await fixture(t, Buffer.alloc(CHUNK + 1, 43)); if (decrypting) await f.encrypt();
    const gate = deferred(); const entered = deferred(); let calls = 0;
    const options = { ...(decrypting ? f.decryptOptions : f.encryptOptions), beforeWrite: async () => {
      calls++; entered.resolve(); await gate.promise;
    } };
    const pending = (decrypting ? decryptFile : encryptFile)(options);
    options.beforeWrite = async () => { throw new Error('replacement callback must not run'); };
    await entered.promise;
    const root = decrypting ? f.restoredRoot : f.archiveRoot;
    const [temporary] = (await fs.readdir(root)).filter(name => name.startsWith('.archive-pending-'));
    assert.equal((await fs.stat(path.join(root, temporary))).size, 0);
    await assert.rejects(fs.stat(decrypting ? f.restoredPath : f.archivePath), { code: 'ENOENT' });
    gate.resolve(); await pending; assert.equal(calls, decrypting ? 2 : 6); keysCleared(f);
  });
}

for (const [label, decrypting, blocked] of [
  ['prefix', false, 0], ['header', false, 1], ['frame', false, 2], ['ciphertext', false, 3],
  ['later ciphertext', false, 5], ['first plaintext', true, 0], ['later plaintext', true, 1],
]) {
  test(`beforeWrite rejects ${label} with no unapproved bytes or publication and cleans only its owned temporary`, async t => {
    const payload = Buffer.alloc(CHUNK + 1, 44); const f = await fixture(t, payload); if (decrypting) await f.encrypt();
    const root = decrypting ? f.restoredRoot : f.archiveRoot; const sentinel = path.join(root, 'keep.bin');
    await fs.writeFile(sentinel, 'untouched', { mode: 0o600 });
    let calls = 0; let approved = 0n; let observed;
    const beforeWrite = async bytes => {
      const [temporary] = (await fs.readdir(root)).filter(name => name.startsWith('.archive-pending-'));
      observed = await fs.stat(path.join(root, temporary), { bigint: true });
      assert.equal(observed.size, approved);
      if (calls++ === blocked) throw new Error('injected-secret capacity rejection');
      approved += BigInt(bytes);
    };
    await rejects(decrypting ? f.decrypt({ beforeWrite }) : f.encrypt({ beforeWrite }), 'BACKUP_ARCHIVE_IO');
    assert.equal(calls, blocked + 1); assert.equal(observed.size, approved);
    await noPublication(f, decrypting); assert.deepEqual(await fs.readFile(f.sourcePath), payload);
    assert.equal(await fs.readFile(sentinel, 'utf8'), 'untouched'); keysCleared(f);
    // Failure released the operation slot and did not leave an owned partial destination.
    await (decrypting ? f.decrypt() : f.encrypt());
  });
}

for (const beforeWrite of [null, false, 1, 'function', {}]) {
  test(`invalid beforeWrite ${typeof beforeWrite}/${String(beforeWrite)} rejects before archive output creation`, async t => {
    const f = await fixture(t); await rejects(f.encrypt({ beforeWrite }), 'BACKUP_ARCHIVE_ARGUMENT');
    assert.deepEqual(await fs.readdir(f.archiveRoot), []);
    await f.encrypt(); await rejects(f.decrypt({ beforeWrite }), 'BACKUP_ARCHIVE_ARGUMENT');
    assert.deepEqual(await fs.readdir(f.restoredRoot), []);
  });
}

test('beforeWrite archive reservations cover each buffer once despite short OS writes', async t => {
  const payload = Buffer.alloc(157, 45); const f = await fixture(t, payload);
  const probe = await fs.open(f.sourcePath, 'r'); const prototype = Object.getPrototypeOf(probe); await probe.close();
  const original = prototype.write; let calls = 0; const amounts = [];
  prototype.write = function (bytes, offset, length, position) {
    calls++; return original.call(this, bytes, offset, Math.min(length, 71), position);
  };
  try {
    await f.encrypt({ beforeWrite: async bytes => { amounts.push(BigInt(bytes)); } });
    assert.equal(amounts.length, 4); assert.ok(calls > 4);
    assert.equal(amounts.reduce((sum, bytes) => sum + bytes, 0n), (await fs.stat(f.archivePath, { bigint: true })).size);
    amounts.length = 0; calls = 0;
    await f.decrypt({ beforeWrite: async bytes => { amounts.push(BigInt(bytes)); } });
    assert.deepEqual(amounts, [157n]); assert.equal(calls, 3);
    assert.deepEqual(await fs.readFile(f.restoredPath), payload);
  } finally { prototype.write = original; }
});
