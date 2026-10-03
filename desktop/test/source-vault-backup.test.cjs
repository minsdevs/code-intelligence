'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { createSourceVault, openSourceVault, openSourceVaultRestoreStage, MAX_FILE_BYTES } = require('../src/source-vault.cjs');

const digest = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const code = expected => error => error?.code === expected;
const stages = ['temp-written', 'file-synced', 'before-rename', 'renamed', 'directory-synced'];

// Synthetic wrapping only: no Electron, OS keychain, provider, network or production data.
function syntheticWrapper() {
  const key = crypto.randomBytes(32);
  const calls = { wrap: 0, unwrap: 0 };
  return {
    calls,
    isAvailable: () => true,
    wrap(bytes) {
      calls.wrap++;
      const nonce = crypto.randomBytes(12);
      const cipher = crypto.createCipheriv('aes-256-gcm', key, nonce);
      const encrypted = Buffer.concat([cipher.update(bytes), cipher.final()]);
      return Buffer.concat([nonce, cipher.getAuthTag(), encrypted]);
    },
    unwrap(bytes) {
      calls.unwrap++;
      const decipher = crypto.createDecipheriv('aes-256-gcm', key, bytes.subarray(0, 12));
      decipher.setAuthTag(bytes.subarray(12, 28));
      return Buffer.concat([decipher.update(bytes.subarray(28)), decipher.final()]);
    },
  };
}

async function fixture(t) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'ci-backup-vault-')));
  const wrapper = syntheticWrapper();
  const options = { safetyRoot: path.join(root, 'safety'), sourceRoot: path.join(root, 'live'),
    installationId: 'synthetic-backup-installation', wrapper };
  const handles = [];
  const f = { root, wrapper, options, handles,
    stageRoot: path.join(root, 'stage'),
    keyFile: path.join(options.safetyRoot, 'source-vault', 'source-keyring.wrapped'),
    lockFile: path.join(options.safetyRoot, 'source-vault', 'owner.lock'),
    blob: (ref, sourceRoot = options.sourceRoot) => path.join(sourceRoot, String(ref.projectId), ref.sha256, 'blob.bin'),
    async stage(extra = {}) {
      await f.vault.close();
      await fs.mkdir(f.stageRoot, { mode: 0o700 });
      const stage = await openSourceVaultRestoreStage({ ...options, sourceRoot: f.stageRoot, ...extra });
      handles.push(stage);
      return stage;
    },
    async open(extra = {}) {
      const opened = await openSourceVault({ ...options, ...extra });
      handles.push(opened);
      return opened;
    },
    async retainedKey(keyId) {
      const bytes = wrapper.unwrap(await fs.readFile(f.keyFile));
      try { return Buffer.from(JSON.parse(bytes.toString()).keys.find(key => key.keyId === keyId).material, 'base64'); }
      finally { bytes.fill(0); }
    },
  };
  t.after(async () => {
    for (const handle of handles) await handle.close().catch(() => {});
    await fs.rm(root, { recursive: true, force: true });
  });
  f.vault = await createSourceVault(options);
  handles.push(f.vault);
  f.bytes = Buffer.from('synthetic retained source\0\xff\r\n');
  f.ref = await f.vault.put({ projectId: 7, bytes: f.bytes });
  f.packet = await f.vault.exportCiphertext(f.ref);
  return f;
}

function encodedEnvelope(header, ciphertext, rawHeader) {
  const encoded = Buffer.from(rawHeader ?? JSON.stringify(header));
  const prefix = Buffer.alloc(12);
  Buffer.from('CISRCBLB').copy(prefix); prefix.writeUInt32BE(encoded.length, 8);
  return Buffer.concat([prefix, encoded, ciphertext]);
}
function decodedEnvelope(bytes) {
  const length = bytes.readUInt32BE(8);
  return { header: JSON.parse(bytes.subarray(12, 12 + length).toString()), ciphertext: bytes.subarray(12 + length) };
}
function authenticatedEnvelope(packet, installationId, bytes, key) {
  const header = { format: 'code-intelligence-source-blob', major: 1, installationId,
    projectId: packet.projectId, keyId: packet.keyId, sha256: packet.sha256, byteSize: packet.byteSize };
  const nonce = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, nonce);
  cipher.setAAD(Buffer.from(JSON.stringify(header)));
  const ciphertext = Buffer.concat([cipher.update(bytes), cipher.final()]);
  return encodedEnvelope({ ...header, nonce: nonce.toString('base64'), tag: cipher.getAuthTag().toString('base64') }, ciphertext);
}
function withEnvelope(packet, envelope) { return { ...packet, envelope, cipherSha256: digest(envelope) }; }
async function files(root) {
  const result = [];
  for (const entry of await fs.readdir(root, { withFileTypes: true })) {
    const target = path.join(root, entry.name);
    if (entry.isDirectory()) result.push(...await files(target));
    else result.push(target);
  }
  return result;
}
function receipt(packet, deduplicated) {
  return { format: 1, projectId: packet.projectId, sha256: packet.sha256, byteSize: packet.byteSize,
    keyId: packet.keyId, cipherSha256: packet.cipherSha256, deduplicated };
}

test('exports verified exact ciphertext and restores retained key IDs without reencrypting or changing B', async t => {
  const f = await fixture(t);
  const oldPacket = f.packet;
  const rotated = await f.vault.rotate();
  const newRef = await f.vault.put({ projectId: 9, bytes: Buffer.from('second retained source') });
  const newPacket = await f.vault.exportCiphertext(newRef);
  assert.notEqual(oldPacket.keyId, rotated.activeKeyId);
  assert.equal(newPacket.keyId, rotated.activeKeyId);
  assert.deepEqual(Object.keys(oldPacket).sort(), ['byteSize', 'cipherSha256', 'envelope', 'format', 'keyId', 'projectId', 'sha256']);
  assert.deepEqual(oldPacket.envelope, await fs.readFile(f.blob(f.ref)));
  assert.equal(oldPacket.cipherSha256, digest(oldPacket.envelope));
  assert.equal(oldPacket.envelope.includes(f.bytes), false);
  const wrapped = await fs.readFile(f.keyFile);
  const wrappedStat = await fs.stat(f.keyFile, { bigint: true });
  const wraps = f.wrapper.calls.wrap;
  const sibling = path.join(f.options.safetyRoot, 'synthetic-journal');
  await fs.writeFile(sibling, 'untouched safety journal', { mode: 0o600 });
  const stage = await f.stage();
  assert.deepEqual(stage.info().keyIds, rotated.keyIds);
  for (const packet of [oldPacket, newPacket]) {
    assert.deepEqual(await stage.importCiphertext(packet), receipt(packet, false));
    assert.deepEqual(await fs.readFile(f.blob(packet, f.stageRoot)), packet.envelope);
    assert.deepEqual(await stage.exportCiphertext(packet), packet);
    assert.equal((await fs.stat(f.blob(packet, f.stageRoot))).mode & 0o7777, 0o600);
  }
  assert.deepEqual(await stage.read(oldPacket), f.bytes);
  for (const file of await files(f.stageRoot)) assert.equal((await fs.readFile(file)).includes(f.bytes), false);
  await stage.close();
  const reopened = await f.open({ sourceRoot: f.stageRoot });
  assert.deepEqual(await reopened.read(oldPacket), f.bytes);
  assert.deepEqual(reopened.info().keyIds, rotated.keyIds);
  assert.equal(f.wrapper.calls.wrap, wraps);
  assert.deepEqual(await fs.readFile(f.keyFile), wrapped);
  const after = await fs.stat(f.keyFile, { bigint: true });
  for (const field of ['ino', 'size', 'mtimeNs', 'ctimeNs']) assert.equal(after[field], wrappedStat[field]);
  assert.equal(await fs.readFile(sibling, 'utf8'), 'untouched safety journal');
});

test('live and ordinary open handles cannot import, and restore handles cannot put or rotate', async t => {
  const f = await fixture(t);
  await assert.rejects(f.vault.importCiphertext(f.packet), code('SOURCE_VAULT_MODE'));
  const stage = await f.stage();
  const wrapped = await fs.readFile(f.keyFile);
  await assert.rejects(stage.put({ projectId: 7, bytes: f.bytes }), code('SOURCE_VAULT_MODE'));
  await assert.rejects(stage.rotate(), code('SOURCE_VAULT_MODE'));
  assert.deepEqual(await fs.readdir(f.stageRoot), []);
  assert.deepEqual(await fs.readFile(f.keyFile), wrapped);
  await stage.close();
  const normal = await f.open({ sourceRoot: f.stageRoot, restoreStage: true, restoreStaging: true });
  await assert.rejects(normal.importCiphertext(f.packet), code('SOURCE_VAULT_MODE'));
  assert.deepEqual(await fs.readdir(f.stageRoot), []);
});

test('restore stage requires live source owner to close and refuses every populated root', async t => {
  const f = await fixture(t);
  await fs.mkdir(f.stageRoot, { mode: 0o700 });
  const lock = await fs.readFile(f.lockFile);
  const options = { ...f.options, sourceRoot: f.stageRoot };
  await assert.rejects(openSourceVaultRestoreStage(options), code('SOURCE_VAULT_LOCKED'));
  assert.deepEqual(await fs.readFile(f.lockFile), lock);
  await f.vault.close();
  await assert.rejects(openSourceVaultRestoreStage(f.options), code('SOURCE_VAULT_NOT_FRESH'));
  assert.deepEqual(await fs.readFile(f.blob(f.ref)), f.packet.envelope);
  await fs.mkdir(path.join(f.stageRoot, '7'), { mode: 0o700 });
  await assert.rejects(openSourceVaultRestoreStage(options), code('SOURCE_VAULT_NOT_FRESH'));
  assert.deepEqual(await fs.readdir(f.stageRoot), ['7']);
  await assert.rejects(fs.lstat(f.lockFile), { code: 'ENOENT' });
});

test('ciphertext input and reference are snapshotted synchronously before queued import', async t => {
  const f = await fixture(t);
  const stage = await f.stage();
  const value = { ...f.packet, envelope: Buffer.from(f.packet.envelope) };
  const pending = stage.importCiphertext(value);
  value.envelope.fill(88); value.projectId = '9'; value.keyId = '0'.repeat(32); value.sha256 = '0'.repeat(64);
  value.byteSize = 0; value.cipherSha256 = '0'.repeat(64);
  assert.deepEqual(await pending, receipt(f.packet, false));
  assert.deepEqual(await stage.read(f.ref), f.bytes);
  assert.deepEqual(await fs.readFile(f.blob(f.ref, f.stageRoot)), f.packet.envelope);
  assert.deepEqual(value.envelope, Buffer.alloc(value.envelope.length, 88));
  const exported = await stage.exportCiphertext(f.ref);
  exported.envelope.fill(77);
  assert.deepEqual((await stage.exportCiphertext(f.ref)).envelope, f.packet.envelope);
});

test('exact ciphertext retry is idempotent but a fresh valid encryption of the same content is rejected', async t => {
  const f = await fixture(t);
  const key = await f.retainedKey(f.ref.keyId);
  const differentEnvelope = authenticatedEnvelope(f.packet, f.options.installationId, f.bytes, key);
  key.fill(0);
  assert.notDeepEqual(differentEnvelope, f.packet.envelope);
  const stage = await f.stage();
  await stage.importCiphertext(f.packet);
  const before = await fs.stat(f.blob(f.ref, f.stageRoot), { bigint: true });
  const usage = stage.info().store;
  assert.deepEqual(await stage.importCiphertext(f.packet), receipt(f.packet, true));
  await assert.rejects(stage.importCiphertext(withEnvelope(f.packet, differentEnvelope)), code('SOURCE_VAULT_INTEGRITY'));
  const after = await fs.stat(f.blob(f.ref, f.stageRoot), { bigint: true });
  for (const field of ['ino', 'size', 'mtimeNs', 'ctimeNs']) assert.equal(after[field], before[field]);
  assert.deepEqual(await fs.readFile(f.blob(f.ref, f.stageRoot)), f.packet.envelope);
  assert.deepEqual(stage.info().store, usage);
});

for (const size of [0, MAX_FILE_BYTES]) test(`exports and restores exact raw content bounds at ${size} bytes`, async t => {
  const f = await fixture(t);
  const bytes = Buffer.alloc(size, 0xff);
  const ref = await f.vault.put({ projectId: 9, bytes });
  const packet = await f.vault.exportCiphertext(ref);
  const stage = await f.stage();
  assert.deepEqual(await stage.importCiphertext(packet), receipt(packet, false));
  assert.deepEqual(await stage.read(ref), bytes);
  assert.deepEqual(await fs.readFile(f.blob(ref, f.stageRoot)), packet.envelope);
  assert.deepEqual(await stage.exportCiphertext(ref), packet);
});

for (const [name, extra] of [
  ['ciphertext byte quota', packet => ({ maxStoreBytes: packet.envelope.length - 1 })],
  ['directory and blob entry quota', () => ({ maxStoreEntries: 2 })],
]) test(`rejects import before writes when exceeding ${name}`, async t => {
  const f = await fixture(t);
  const stage = await f.stage(extra(f.packet));
  const wrapped = await fs.readFile(f.keyFile);
  await assert.rejects(stage.importCiphertext(f.packet), code('SOURCE_VAULT_LIMIT'));
  assert.deepEqual(await fs.readdir(f.stageRoot), []);
  assert.deepEqual(await fs.readFile(f.keyFile), wrapped);
  assert.equal(stage.info().store.storedBytes, 0);
  assert.equal(stage.info().store.entries, 0);
});

test('accepts exact ciphertext quotas and charges duplicate imports only once', async t => {
  const f = await fixture(t);
  const stage = await f.stage({ maxStoreBytes: f.packet.envelope.length, maxStoreEntries: 3 });
  await stage.importCiphertext(f.packet);
  assert.deepEqual(await stage.importCiphertext(f.packet), receipt(f.packet, true));
  assert.equal(stage.info().store.storedBytes, f.packet.envelope.length);
  assert.equal(stage.info().store.entries, 3);
});

test('imports remain bounded at four accepted operations and close drains their durable results', async t => {
  const f = await fixture(t);
  const stage = await f.stage();
  const pending = Array.from({ length: 4 }, () => stage.importCiphertext(f.packet));
  await assert.rejects(stage.importCiphertext(f.packet), code('SOURCE_VAULT_LIMIT'));
  const closing = stage.close();
  await assert.rejects(stage.importCiphertext(f.packet), code('SOURCE_VAULT_CLOSED'));
  assert.deepEqual(await Promise.all(pending), [false, true, true, true].map(deduplicated => receipt(f.packet, deduplicated)));
  await closing;
  await assert.rejects(fs.lstat(f.lockFile), { code: 'ENOENT' });
  const reopened = await f.open({ sourceRoot: f.stageRoot });
  assert.deepEqual(await reopened.read(f.packet), f.bytes);
});

for (const [name, change] of [
  ['project', { projectId: '8' }], ['hash', { sha256: 'a'.repeat(64) }],
  ['size', { byteSize: 1 }], ['key ID', { keyId: 'a'.repeat(32) }],
]) test(`import binds expected ${name} before changing the stage`, async t => {
  const f = await fixture(t);
  const stage = await f.stage();
  await assert.rejects(stage.importCiphertext({ ...f.packet, ...change }), code('SOURCE_VAULT_INTEGRITY'));
  assert.deepEqual(await fs.readdir(f.stageRoot), []);
});

test('export binds the caller key ID even when another retained key could decrypt the stored header', async t => {
  const f = await fixture(t);
  const rotated = await f.vault.rotate();
  await assert.rejects(f.vault.exportCiphertext({ ...f.ref, keyId: rotated.activeKeyId }), code('SOURCE_VAULT_INTEGRITY'));
  assert.deepEqual((await f.vault.exportCiphertext(f.ref)).envelope, f.packet.envelope);
});

test('rejects path-like, noncanonical, unknown format and oversized import arguments without writes', async t => {
  const f = await fixture(t);
  const stage = await f.stage();
  for (const change of [
    { projectId: '../7' }, { projectId: '7\n' }, { sha256: f.packet.sha256 + '\n' },
    { keyId: f.packet.keyId + '\n' }, { keyId: undefined }, { byteSize: -1 },
    { byteSize: MAX_FILE_BYTES + 1 }, { cipherSha256: f.packet.cipherSha256 + '\n' },
    { envelope: new Uint8Array(f.packet.envelope) }, { envelope: 'untrusted path' },
  ]) await assert.rejects(stage.importCiphertext({ ...f.packet, ...change }), code('SOURCE_VAULT_ARGUMENT'));
  await assert.rejects(stage.importCiphertext({ ...f.packet, format: 2 }), code('SOURCE_VAULT_UNSUPPORTED'));
  await assert.rejects(stage.exportCiphertext({ ...f.packet, format: 2 }), code('SOURCE_VAULT_UNSUPPORTED'));
  await assert.rejects(stage.importCiphertext({ ...f.packet, envelope: Buffer.alloc(MAX_FILE_BYTES + 2048 + 13) }), code('SOURCE_VAULT_LIMIT'));
  assert.deepEqual(await fs.readdir(f.stageRoot), []);
});

test('independently checks ciphertext SHA, AEAD and authenticated plaintext SHA before publication', async t => {
  const f = await fixture(t);
  const key = await f.retainedKey(f.ref.keyId);
  const dishonest = { ...f.packet, sha256: 'a'.repeat(64) };
  const envelope = authenticatedEnvelope(dishonest, f.options.installationId, f.bytes, key);
  key.fill(0);
  const stage = await f.stage();
  await assert.rejects(stage.importCiphertext({ ...f.packet, cipherSha256: '0'.repeat(64) }), code('SOURCE_VAULT_INTEGRITY'));
  const damaged = Buffer.from(f.packet.envelope); damaged[damaged.length - 1] ^= 1;
  await assert.rejects(stage.importCiphertext(withEnvelope(f.packet, damaged)), code('SOURCE_VAULT_INTEGRITY'));
  await assert.rejects(stage.importCiphertext(withEnvelope(dishonest, envelope)), code('SOURCE_VAULT_INTEGRITY'));
  assert.deepEqual(await fs.readdir(f.stageRoot), []);
});

for (const [name, mutate, expectedCode = 'SOURCE_VAULT_INTEGRITY'] of [
  ['installation identity', h => { h.installationId = 'another-installation'; }],
  ['project identity', h => { h.projectId = '8'; }],
  ['plaintext size', h => { h.byteSize++; }],
  ['major version', h => { h.major = 2; }, 'SOURCE_VAULT_UNSUPPORTED'],
  ['unknown header field', h => { h.extra = true; }],
  ['short GCM tag', h => { h.tag = Buffer.alloc(15).toString('base64'); }],
  ['short nonce', h => { h.nonce = Buffer.alloc(11).toString('base64'); }],
]) test(`import rejects ${name} tampering even after ciphertext digest is updated`, async t => {
  const f = await fixture(t);
  const { header, ciphertext } = decodedEnvelope(f.packet.envelope);
  mutate(header);
  const stage = await f.stage();
  await assert.rejects(stage.importCiphertext(withEnvelope(f.packet, encodedEnvelope(header, ciphertext))), code(expectedCode));
  assert.deepEqual(await fs.readdir(f.stageRoot), []);
});

test('import rejects duplicate header keys, truncation, trailing bytes and oversized header before writes', async t => {
  const f = await fixture(t);
  const { header, ciphertext } = decodedEnvelope(f.packet.envelope);
  const overflow = Buffer.from(f.packet.envelope); overflow.writeUInt32BE(0xffffffff, 8);
  const stage = await f.stage();
  for (const envelope of [
    Buffer.alloc(0), f.packet.envelope.subarray(0, -1), Buffer.concat([f.packet.envelope, Buffer.from([0])]), overflow,
    encodedEnvelope(header, ciphertext, JSON.stringify(header).replace('"major":1', '"major":2,"major":1')),
  ]) await assert.rejects(stage.importCiphertext(withEnvelope(f.packet, envelope)), code('SOURCE_VAULT_INTEGRITY'));
  assert.deepEqual(await fs.readdir(f.stageRoot), []);
});

for (const kind of ['symlink', 'hardlink', 'mode']) test(`export refuses a ${kind} source blob and preserves its target`, async t => {
  const f = await fixture(t);
  const target = path.join(f.root, 'retained-ciphertext');
  if (kind === 'mode') await fs.chmod(f.blob(f.ref), 0o644);
  else {
    await fs.rename(f.blob(f.ref), target);
    if (kind === 'symlink') await fs.symlink(target, f.blob(f.ref));
    else await fs.link(target, f.blob(f.ref));
  }
  await assert.rejects(f.vault.exportCiphertext(f.ref), code('SOURCE_VAULT_UNSAFE_PATH'));
  assert.deepEqual(await fs.readFile(kind === 'mode' ? f.blob(f.ref) : target), f.packet.envelope);
});

test('export never acknowledges damaged, missing or oversized stored ciphertext', async t => {
  const f = await fixture(t);
  const damaged = Buffer.from(f.packet.envelope); damaged[damaged.length - 1] ^= 1;
  await fs.writeFile(f.blob(f.ref), damaged);
  await assert.rejects(f.vault.exportCiphertext(f.ref), code('SOURCE_VAULT_INTEGRITY'));
  await fs.truncate(f.blob(f.ref), MAX_FILE_BYTES + 2048 + 13);
  await assert.rejects(f.vault.exportCiphertext(f.ref), code('SOURCE_VAULT_LIMIT'));
  await fs.unlink(f.blob(f.ref));
  await assert.rejects(f.vault.exportCiphertext(f.ref), code('SOURCE_VAULT_MISSING'));
});

test('stage creation refuses symlink roots and unsafe permissions without traversing targets', async t => {
  const f = await fixture(t);
  await f.vault.close();
  const target = path.join(f.root, 'target');
  await fs.mkdir(target, { mode: 0o700 });
  await fs.symlink(target, f.stageRoot);
  await assert.rejects(openSourceVaultRestoreStage({ ...f.options, sourceRoot: f.stageRoot }), code('SOURCE_VAULT_UNSAFE_PATH'));
  assert.deepEqual(await fs.readdir(target), []);
  await fs.unlink(f.stageRoot);
  await fs.mkdir(f.stageRoot, { mode: 0o755 });
  await assert.rejects(openSourceVaultRestoreStage({ ...f.options, sourceRoot: f.stageRoot }), code('SOURCE_VAULT_UNSAFE_PATH'));
});

test('live stage refuses replaced roots and introduced project symlinks without writing outside', async t => {
  const f = await fixture(t);
  const stage = await f.stage();
  const target = path.join(f.root, 'target');
  await fs.mkdir(target, { mode: 0o700 });
  await fs.symlink(target, path.join(f.stageRoot, f.ref.projectId));
  await assert.rejects(stage.importCiphertext(f.packet), code('SOURCE_VAULT_UNSAFE_PATH'));
  assert.deepEqual(await fs.readdir(target), []);
  await fs.unlink(path.join(f.stageRoot, f.ref.projectId));
  await fs.rename(f.stageRoot, path.join(f.root, 'old-stage'));
  await fs.mkdir(f.stageRoot, { mode: 0o700 });
  await assert.rejects(stage.importCiphertext(f.packet), code('SOURCE_VAULT_UNSAFE_PATH'));
  assert.deepEqual(await fs.readdir(f.stageRoot), []);
});

for (const kind of ['symlink', 'hardlink', 'corruption']) test(`duplicate import refuses ${kind} at the existing target without overwriting it`, async t => {
  const f = await fixture(t);
  const stage = await f.stage();
  await stage.importCiphertext(f.packet);
  const blob = f.blob(f.ref, f.stageRoot);
  const target = path.join(f.root, 'untouched-ciphertext');
  if (kind === 'corruption') await fs.writeFile(blob, 'preserve damaged blob');
  else {
    await fs.rename(blob, target);
    if (kind === 'symlink') await fs.symlink(target, blob);
    else await fs.link(target, blob);
  }
  await assert.rejects(stage.importCiphertext(f.packet), code(kind === 'corruption' ? 'SOURCE_VAULT_INTEGRITY' : 'SOURCE_VAULT_UNSAFE_PATH'));
  if (kind === 'corruption') assert.equal(await fs.readFile(blob, 'utf8'), 'preserve damaged blob');
  else assert.deepEqual(await fs.readFile(target), f.packet.envelope);
});

test('missing safety area or keyring never initializes replacement state for restore', async t => {
  const f = await fixture(t);
  await f.vault.close();
  await fs.mkdir(f.stageRoot, { mode: 0o700 });
  const absent = path.join(f.root, 'missing-safety');
  const wraps = f.wrapper.calls.wrap;
  await assert.rejects(openSourceVaultRestoreStage({ ...f.options, sourceRoot: f.stageRoot, safetyRoot: absent }));
  await assert.rejects(fs.lstat(absent), { code: 'ENOENT' });
  await fs.unlink(f.keyFile);
  await assert.rejects(openSourceVaultRestoreStage({ ...f.options, sourceRoot: f.stageRoot }), code('SOURCE_VAULT_KEY_MISSING'));
  await assert.rejects(fs.lstat(f.keyFile), { code: 'ENOENT' });
  assert.deepEqual(await fs.readdir(f.stageRoot), []);
  assert.equal(f.wrapper.calls.wrap, wraps);
});

test('restore rejects wrong installation or wrapping key and preserves existing B ciphertext', async t => {
  const f = await fixture(t);
  await f.vault.close();
  await fs.mkdir(f.stageRoot, { mode: 0o700 });
  const wrapped = await fs.readFile(f.keyFile);
  for (const extra of [{ installationId: 'other-installation' }, { wrapper: syntheticWrapper() }])
    await assert.rejects(openSourceVaultRestoreStage({ ...f.options, sourceRoot: f.stageRoot, ...extra }), code('SOURCE_VAULT_KEY_INVALID'));
  assert.deepEqual(await fs.readFile(f.keyFile), wrapped);
  assert.deepEqual(await fs.readdir(f.stageRoot), []);
});

test('restoring ciphertext with a missing retained key never rotates or substitutes the active key', async t => {
  const f = await fixture(t);
  await f.vault.rotate();
  await f.vault.close();
  const raw = f.wrapper.unwrap(await fs.readFile(f.keyFile));
  const ring = JSON.parse(raw.toString()); raw.fill(0);
  ring.keys = ring.keys.filter(key => key.keyId !== f.packet.keyId); ring.revision = ring.keys.length;
  await fs.writeFile(f.keyFile, f.wrapper.wrap(Buffer.from(JSON.stringify(ring))));
  const wrapped = await fs.readFile(f.keyFile);
  const wraps = f.wrapper.calls.wrap;
  const stage = await f.stage();
  await assert.rejects(stage.importCiphertext(f.packet), code('SOURCE_VAULT_KEY_MISSING'));
  assert.deepEqual(await fs.readFile(f.keyFile), wrapped);
  assert.equal(f.wrapper.calls.wrap, wraps);
  assert.deepEqual(await fs.readdir(f.stageRoot), []);
});

test('live keyring identity changes fail before importing any ciphertext', async t => {
  const f = await fixture(t);
  const stage = await f.stage();
  const wrapped = await fs.readFile(f.keyFile);
  await fs.rename(f.keyFile, path.join(f.root, 'retained-keyring'));
  await fs.writeFile(f.keyFile, wrapped, { mode: 0o600 });
  await assert.rejects(stage.importCiphertext(f.packet), code('SOURCE_VAULT_KEY_INVALID'));
  assert.deepEqual(await fs.readdir(f.stageRoot), []);
  assert.deepEqual(await fs.readFile(f.keyFile), wrapped);
});

for (const point of stages) test(`import durability failure at ${point} has no receipt, retains B, and never harms live ciphertext`, async t => {
  const f = await fixture(t);
  const wrapped = await fs.readFile(f.keyFile);
  const events = [];
  let armed = true;
  const stage = await f.stage({ fault(event) { events.push(event); if (armed && event === `blob:${point}`) throw new Error('synthetic secret-free fault'); } });
  await assert.rejects(stage.importCiphertext(f.packet), code('SOURCE_VAULT_IO'));
  assert.deepEqual(events, stages.slice(0, stages.indexOf(point) + 1).map(stage => `blob:${stage}`));
  assert.deepEqual(await fs.readFile(f.keyFile), wrapped);
  assert.deepEqual(await fs.readFile(f.blob(f.ref)), f.packet.envelope);
  const directory = path.dirname(f.blob(f.ref, f.stageRoot));
  assert.equal((await fs.readdir(directory)).some(name => name.startsWith('.pending-')), false);
  armed = false;
  if (point === 'renamed' || point === 'directory-synced') {
    assert.deepEqual(await stage.importCiphertext(f.packet), receipt(f.packet, true));
    assert.deepEqual(await stage.read(f.packet), f.bytes);
  } else {
    await assert.rejects(stage.importCiphertext(f.packet), code('SOURCE_VAULT_MISSING'));
    assert.deepEqual(await fs.readdir(directory), []);
  }
});

test('import verifies durable readback and preserves a competing target rather than overwriting it', async t => {
  const f = await fixture(t);
  const stage = await f.stage({ fault: async event => {
    if (event === 'blob:before-rename') await fs.writeFile(f.blob(f.ref, f.stageRoot), 'competing ciphertext', { mode: 0o600 });
  } });
  await assert.rejects(stage.importCiphertext(f.packet), code('SOURCE_VAULT_NOT_FRESH'));
  assert.equal(await fs.readFile(f.blob(f.ref, f.stageRoot), 'utf8'), 'competing ciphertext');
  assert.deepEqual(await fs.readFile(f.blob(f.ref)), f.packet.envelope);
});

test('post-fsync ciphertext mutation fails readback without a successful restore receipt', async t => {
  const f = await fixture(t);
  const damaged = Buffer.from(f.packet.envelope); damaged[damaged.length - 1] ^= 1;
  const stage = await f.stage({ fault: async event => {
    if (event === 'blob:directory-synced') await fs.writeFile(f.blob(f.ref, f.stageRoot), damaged);
  } });
  await assert.rejects(stage.importCiphertext(f.packet), code('SOURCE_VAULT_INTEGRITY'));
  assert.deepEqual(await fs.readFile(f.blob(f.ref, f.stageRoot)), damaged);
  await assert.rejects(stage.exportCiphertext(f.ref), code('SOURCE_VAULT_INTEGRITY'));
});

test('ciphertext errors remain static and never return synthetic plaintext, paths or key material', async t => {
  const f = await fixture(t);
  const key = await f.retainedKey(f.ref.keyId);
  const stage = await f.stage();
  let error;
  try { await stage.importCiphertext({ ...f.packet, cipherSha256: '0'.repeat(64) }); }
  catch (caught) { error = caught; }
  assert.equal(error?.code, 'SOURCE_VAULT_INTEGRITY');
  assert.equal(error.message, 'Source blob authentication or expected content validation failed.');
  const serialized = JSON.stringify(error);
  for (const secret of [f.bytes.toString(), f.root, key.toString('base64'), key.toString('hex')])
    assert.equal(serialized.includes(secret), false);
  key.fill(0);
});
