'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { createSourceVault, openSourceVault, MAX_FILE_BYTES, MAX_STORE_BYTES, MAX_STORE_ENTRIES } = require('../src/source-vault.cjs');

const digest = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const code = expected => error => error?.code === expected;
const stages = ['temp-written', 'file-synced', 'before-rename', 'renamed', 'directory-synced'];
const LINE_TERMINATORS = ['\n', '\r', '\r\n', '\u2028', '\u2029'];

// Synthetic OS wrapping: this key exists only in this disposable test process.
function syntheticWrapper() {
  const wrappingKey = crypto.randomBytes(32);
  return {
    isAvailable: () => true,
    wrap(bytes) {
      const nonce = crypto.randomBytes(12);
      const cipher = crypto.createCipheriv('aes-256-gcm', wrappingKey, nonce);
      const encrypted = Buffer.concat([cipher.update(bytes), cipher.final()]);
      return Buffer.concat([nonce, cipher.getAuthTag(), encrypted]);
    },
    unwrap(wrapped) {
      const decipher = crypto.createDecipheriv('aes-256-gcm', wrappingKey, wrapped.subarray(0, 12));
      decipher.setAuthTag(wrapped.subarray(12, 28));
      return Buffer.concat([decipher.update(wrapped.subarray(28)), decipher.final()]);
    },
  };
}

async function fixture(t, { create = true } = {}) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'ci-source-vault-test-')));
  const wrapper = syntheticWrapper();
  const options = { safetyRoot: path.join(root, 'safety'), sourceRoot: path.join(root, 'sources'),
    installationId: 'synthetic-installation_01', wrapper };
  const handles = [];
  const keyDirectory = path.join(options.safetyRoot, 'source-vault');
  const f = {
    root, options, wrapper, handles, keyDirectory,
    keyFile: path.join(keyDirectory, 'source-keyring.wrapped'),
    lockFile: path.join(keyDirectory, 'owner.lock'),
    blob: ({ projectId, sha256 }) => path.join(options.sourceRoot, String(projectId), sha256, 'blob.bin'),
    async create(extra = {}) { const v = await createSourceVault({ ...options, ...extra }); handles.push(v); return v; },
    async open(extra = {}) { const v = await openSourceVault({ ...options, ...extra }); handles.push(v); return v; },
    async rewriteKeyring(change) {
      const value = JSON.parse(wrapper.unwrap(await fs.readFile(f.keyFile)).toString('utf8'));
      const next = change(value);
      const bytes = Buffer.from(typeof next === 'string' ? next : JSON.stringify(next));
      await fs.writeFile(f.keyFile, wrapper.wrap(bytes), { mode: 0o600 });
    },
  };
  t.after(async () => {
    for (const handle of handles) await handle.close().catch(() => {});
    await fs.rm(root, { recursive: true, force: true });
  });
  if (create) f.vault = await f.create();
  return f;
}

function decodeEnvelope(bytes) {
  const length = bytes.readUInt32BE(8);
  return { header: JSON.parse(bytes.subarray(12, 12 + length).toString('utf8')), ciphertext: bytes.subarray(12 + length) };
}
function encodeEnvelope(header, ciphertext, rawHeader) {
  const encoded = Buffer.from(rawHeader ?? JSON.stringify(header));
  const prefix = Buffer.alloc(12);
  Buffer.from('CISRCBLB').copy(prefix); prefix.writeUInt32BE(encoded.length, 8);
  return Buffer.concat([prefix, encoded, ciphertext]);
}
async function allFiles(directory) {
  const results = [];
  for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
    const file = path.join(directory, entry.name);
    if (entry.isDirectory()) results.push(...await allFiles(file));
    else results.push(file);
  }
  return results;
}

test('stores raw bytes with plaintext SHA256 and reopens without changing wrapped keys', async t => {
  const f = await fixture(t);
  const bytes = Buffer.from([0, 255, 254, 0xc3, 0x28, 13, 10, 65]); // invalid UTF-8 is still a valid raw blob
  const stored = await f.vault.put({ projectId: 7, bytes });
  assert.equal(stored.sha256, digest(bytes));
  assert.equal(stored.byteSize, bytes.length);
  assert.equal(stored.projectId, '7');
  assert.equal(stored.deduplicated, false);
  const gitOid = crypto.createHash('sha1').update(Buffer.concat([Buffer.from(`blob ${bytes.length}\0`), bytes])).digest('hex');
  assert.notEqual(stored.sha256, gitOid);
  const wrappedBefore = await fs.readFile(f.keyFile);
  assert.deepEqual(await f.vault.read(stored), bytes);
  await f.vault.close();
  const reopened = await f.open();
  assert.deepEqual(await reopened.read(stored), bytes);
  assert.deepEqual(await fs.readFile(f.keyFile), wrappedBefore);
  await assert.rejects(reopened.read({ ...stored, sha256: gitOid }), code('SOURCE_VAULT_ARGUMENT'));
});

test('persists only encrypted source/wrapped source-purpose keys under private modes', async t => {
  const f = await fixture(t);
  const plaintext = Buffer.from('synthetic source sentinel: never persisted as plaintext');
  const result = await f.vault.put({ projectId: '9223372036854775807', bytes: plaintext });
  const info = f.vault.info();
  assert.deepEqual(Object.keys(info).sort(), ['activeKeyId', 'format', 'installationId', 'keyIds', 'store']);
  const material = JSON.parse(f.wrapper.unwrap(await fs.readFile(f.keyFile)).toString());
  assert.equal(material.purpose, 'source');
  assert.equal(material.installationId, f.options.installationId);
  const rawKey = Buffer.from(material.keys[0].material, 'base64');
  for (const file of await allFiles(f.root)) {
    const data = await fs.readFile(file);
    assert.equal(data.includes(plaintext), false);
    assert.equal(data.includes(rawKey), false);
    assert.equal(data.includes(Buffer.from(material.keys[0].material)), false);
    assert.equal((await fs.stat(file)).mode & 0o7777, 0o600);
    assert.equal((await fs.stat(file)).nlink, 1);
  }
  for (const directory of [f.options.safetyRoot, f.options.sourceRoot, f.keyDirectory, path.dirname(f.blob(result))])
    assert.equal((await fs.stat(directory)).mode & 0o7777, 0o700);
  const { header, ciphertext } = decodeEnvelope(await fs.readFile(f.blob(result)));
  assert.equal(Buffer.from(header.nonce, 'base64').length, 12);
  assert.equal(Buffer.from(header.tag, 'base64').length, 16);
  assert.equal(ciphertext.length, plaintext.length);
  assert.deepEqual({ format: header.format, major: header.major, projectId: header.projectId,
    installationId: header.installationId, keyId: header.keyId, sha256: header.sha256, byteSize: header.byteSize },
  { format: 'code-intelligence-source-blob', major: 1, projectId: result.projectId,
    installationId: f.options.installationId, keyId: result.keyId, sha256: result.sha256, byteSize: result.byteSize });
});

test('copies caller bytes synchronously and never mutates the supplied buffer', async t => {
  const f = await fixture(t);
  const original = Buffer.from('approved synthetic bytes');
  const input = Buffer.from(original);
  const pending = f.vault.put({ projectId: 1, bytes: input });
  input.fill(88);
  const stored = await pending;
  assert.equal(stored.sha256, digest(original));
  assert.deepEqual(await f.vault.read(stored), original);
  assert.deepEqual(input, Buffer.alloc(input.length, 88));
});

test('bounds file size while allowing empty and exact 2MiB raw blobs', async t => {
  const f = await fixture(t);
  for (const bytes of [Buffer.alloc(0), Buffer.alloc(MAX_FILE_BYTES, 71)]) {
    const result = await f.vault.put({ projectId: 1, bytes });
    assert.deepEqual(await f.vault.read(result), bytes);
  }
  await assert.rejects(f.vault.put({ projectId: 1, bytes: Buffer.alloc(MAX_FILE_BYTES + 1) }), code('SOURCE_VAULT_LIMIT'));
  await assert.rejects(f.vault.put({ projectId: 1, bytes: 'text' }), code('SOURCE_VAULT_ARGUMENT'));
});

test('rejects path-like/noncanonical project IDs and invalid installation identity', async t => {
  const f = await fixture(t);
  for (const projectId of [0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1, '', '01', '../7', '7/8', '7\0', '9223372036854775808', 1n])
    await assert.rejects(f.vault.put({ projectId, bytes: Buffer.from('fixture') }), code('SOURCE_VAULT_ARGUMENT'));
  await f.vault.close();
  for (const installationId of ['', '../installation', 'identity+base64/', 'x'.repeat(129)])
    await assert.rejects(f.open({ installationId }), code('SOURCE_VAULT_ARGUMENT'));
});

test('project and expected hash line terminators are rejected without creating source entries', async t => {
  const f = await fixture(t);
  const bytes = Buffer.from('canonical identifier fixture');
  const stored = await f.vault.put({ projectId: 7, bytes });
  const before = f.vault.info().store;
  const encrypted = await fs.readFile(f.blob(stored));
  const wrapped = await fs.readFile(f.keyFile);
  for (const suffix of LINE_TERMINATORS) {
    await assert.rejects(f.vault.put({ projectId: '7' + suffix, bytes }), code('SOURCE_VAULT_ARGUMENT'));
    await assert.rejects(f.vault.read({ ...stored, projectId: '7' + suffix }), code('SOURCE_VAULT_ARGUMENT'));
    await assert.rejects(f.vault.read({ ...stored, sha256: stored.sha256 + suffix }), code('SOURCE_VAULT_ARGUMENT'));
    assert.deepEqual(f.vault.info().store, before);
    assert.equal((await fs.readdir(f.options.sourceRoot)).length, 1);
  }
  assert.equal((await fs.readFile(f.blob(stored))).equals(encrypted), true);
  assert.equal((await fs.readFile(f.keyFile)).equals(wrapped), true);
  assert.equal((await f.vault.read(stored)).equals(bytes), true);
});

test('installation identity line terminators fail before wrapping or creating vault roots', async t => {
  const f = await fixture(t, { create: false });
  let wrapperCalls = 0;
  const wrapper = {
    isAvailable() { wrapperCalls++; return f.wrapper.isAvailable(); },
    wrap(bytes) { wrapperCalls++; return f.wrapper.wrap(bytes); },
    unwrap(bytes) { wrapperCalls++; return f.wrapper.unwrap(bytes); },
  };
  for (const suffix of LINE_TERMINATORS) {
    const options = { installationId: f.options.installationId + suffix, wrapper };
    await assert.rejects(async () => {
      const unexpected = await f.create(options);
      await unexpected.close();
    }, code('SOURCE_VAULT_ARGUMENT'));
    await assert.rejects(f.open(options), code('SOURCE_VAULT_ARGUMENT'));
  }
  assert.equal(wrapperCalls, 0);
  assert.equal((await fs.readdir(f.root)).length, 0);
});

test('wrapped keyring identities with line terminators cannot be opened or rewritten implicitly', async t => {
  const f = await fixture(t);
  const stored = await f.vault.put({ projectId: 7, bytes: Buffer.from('key identity fixture') });
  await f.vault.close();
  const original = await fs.readFile(f.keyFile);
  const encrypted = await fs.readFile(f.blob(stored));
  for (const suffix of LINE_TERMINATORS) {
    for (const field of ['keyId', 'activeKeyId', 'installationId']) {
      await fs.writeFile(f.keyFile, original);
      await f.rewriteKeyring(value => {
        if (field === 'keyId') {
          value.keys[0].keyId += suffix;
          value.activeKeyId = value.keys[0].keyId;
        } else value[field] += suffix;
        return value;
      });
      const invalid = await fs.readFile(f.keyFile);
      await assert.rejects(async () => {
        const unexpected = await f.open();
        await unexpected.close();
      }, code('SOURCE_VAULT_KEY_INVALID'));
      assert.equal((await fs.readFile(f.keyFile)).equals(invalid), true);
      assert.equal((await fs.readFile(f.blob(stored))).equals(encrypted), true);
    }
  }
  await fs.writeFile(f.keyFile, original);
  const reopened = await f.open();
  assert.equal((await reopened.read(stored)).toString(), 'key identity fixture');
});

test('blob header key IDs with line terminators are invalid before key lookup', async t => {
  const f = await fixture(t);
  const stored = await f.vault.put({ projectId: 7, bytes: Buffer.from('header identity fixture') });
  const original = await fs.readFile(f.blob(stored));
  const decoded = decodeEnvelope(original);
  for (const suffix of LINE_TERMINATORS) {
    const changed = encodeEnvelope({ ...decoded.header, keyId: decoded.header.keyId + suffix }, decoded.ciphertext);
    await fs.writeFile(f.blob(stored), changed);
    await assert.rejects(f.vault.read(stored), code('SOURCE_VAULT_INTEGRITY'));
    assert.equal((await fs.readFile(f.blob(stored))).equals(changed), true);
  }
  await fs.writeFile(f.blob(stored), original);
  assert.equal((await f.vault.read(stored)).toString(), 'header identity fixture');
});

for (const kind of ['project', 'hash', 'pending']) {
  test(`managed ${kind} basenames with line terminators cannot pass the opening scan`, async t => {
    const f = await fixture(t);
    const stored = await f.vault.put({ projectId: 7, bytes: Buffer.from('managed name fixture') });
    await f.vault.close();
    const wrapped = await fs.readFile(f.keyFile);
    const encrypted = await fs.readFile(f.blob(stored));
    const parent = kind === 'project' ? f.options.sourceRoot
      : kind === 'hash' ? path.dirname(path.dirname(f.blob(stored))) : path.dirname(f.blob(stored));
    const prefix = kind === 'project' ? '8' : kind === 'hash' ? 'a'.repeat(64) : `.pending-${'a'.repeat(32)}`;
    for (const suffix of LINE_TERMINATORS) {
      const invalid = path.join(parent, prefix + suffix);
      if (kind === 'pending') await fs.writeFile(invalid, encrypted, { mode: 0o600 });
      else await fs.mkdir(invalid, { mode: 0o700 });
      await assert.rejects(async () => {
        const unexpected = await f.open();
        await unexpected.close();
      }, code('SOURCE_VAULT_UNSAFE_PATH'));
      assert.equal((await fs.readFile(f.keyFile)).equals(wrapped), true);
      assert.equal((await fs.readFile(f.blob(stored))).equals(encrypted), true);
      if (kind === 'pending') {
        assert.equal((await fs.readFile(invalid)).equals(encrypted), true);
        await fs.unlink(invalid);
      } else {
        assert.equal((await fs.lstat(invalid)).isDirectory(), true);
        await fs.rmdir(invalid);
      }
    }
    const reopened = await f.open();
    assert.equal((await reopened.read(stored)).toString(), 'managed name fixture');
  });
}

test('accepts base64url installation identities beginning with underscore or hyphen', async t => {
  const f = await fixture(t, { create: false });
  const vault = await f.create({ installationId: '_-synthetic_installation' });
  const saved = await vault.put({ projectId: 1, bytes: Buffer.from('fixture') });
  await vault.close();
  const reopened = await f.open({ installationId: '_-synthetic_installation' });
  assert.deepEqual(await reopened.read(saved), Buffer.from('fixture'));
});

test('deduplicates verified bytes without overwriting ciphertext or changing the old key after rotation', async t => {
  const f = await fixture(t);
  const bytes = Buffer.from('same approved source');
  const first = await f.vault.put({ projectId: 1, bytes });
  const before = await fs.readFile(f.blob(first));
  const stat = await fs.stat(f.blob(first), { bigint: true });
  const oldInfo = f.vault.info();
  const rotated = await f.vault.rotate();
  assert.notEqual(rotated.activeKeyId, oldInfo.activeKeyId);
  assert.deepEqual(rotated.keyIds.slice(0, 1), oldInfo.keyIds);
  const deduplicated = await f.vault.put({ projectId: 1, bytes });
  assert.equal(deduplicated.deduplicated, true);
  assert.equal(deduplicated.keyId, first.keyId);
  assert.deepEqual(await fs.readFile(f.blob(first)), before);
  const after = await fs.stat(f.blob(first), { bigint: true });
  assert.equal(after.ino, stat.ino); assert.equal(after.mtimeNs, stat.mtimeNs);
  const second = await f.vault.put({ projectId: 1, bytes: Buffer.from('new approved source') });
  assert.equal(second.keyId, rotated.activeKeyId);
  await f.vault.close();
  const reopened = await f.open();
  assert.deepEqual(await reopened.read(first), bytes);
  assert.deepEqual(await reopened.read(second), Buffer.from('new approved source'));
  assert.deepEqual(reopened.info().keyIds, rotated.keyIds);
});

test('uses separate randomized ciphertext per project and rejects a blob copied across projects', async t => {
  const f = await fixture(t);
  const bytes = Buffer.from('same raw bytes across two projects');
  const a = await f.vault.put({ projectId: 1, bytes });
  const b = await f.vault.put({ projectId: 2, bytes });
  const aEnvelope = await fs.readFile(f.blob(a));
  const bEnvelope = await fs.readFile(f.blob(b));
  assert.notEqual(decodeEnvelope(aEnvelope).header.nonce, decodeEnvelope(bEnvelope).header.nonce);
  assert.notDeepEqual(aEnvelope, bEnvelope);
  await fs.writeFile(f.blob(b), aEnvelope);
  await assert.rejects(f.vault.read(b), code('SOURCE_VAULT_INTEGRITY'));
  const changed = decodeEnvelope(aEnvelope);
  changed.header.projectId = '2';
  await fs.writeFile(f.blob(b), encodeEnvelope(changed.header, changed.ciphertext));
  await assert.rejects(f.vault.read(b), code('SOURCE_VAULT_INTEGRITY'));
  assert.deepEqual(await f.vault.read(a), bytes);
});

test('refuses wrong installation/wrapping key and missing key state without replacing anything', async t => {
  const f = await fixture(t);
  await f.vault.put({ projectId: 1, bytes: Buffer.from('retained source') });
  const original = await fs.readFile(f.keyFile);
  await f.vault.close();
  await assert.rejects(f.open({ installationId: 'another-installation' }), code('SOURCE_VAULT_KEY_INVALID'));
  await assert.rejects(f.open({ wrapper: syntheticWrapper() }), code('SOURCE_VAULT_KEY_INVALID'));
  assert.deepEqual(await fs.readFile(f.keyFile), original);
  await fs.unlink(f.keyFile);
  await assert.rejects(f.open(), code('SOURCE_VAULT_KEY_MISSING'));
  await assert.rejects(f.create(), code('SOURCE_VAULT_NOT_FRESH'));
  await assert.rejects(fs.lstat(f.keyFile), { code: 'ENOENT' });
});

test('unavailable or plaintext wrapping fails closed before publishing keys', async t => {
  const f = await fixture(t, { create: false });
  let wraps = 0;
  const unavailable = { isAvailable: () => false, wrap: () => { wraps += 1; }, unwrap: () => {} };
  await assert.rejects(f.create({ wrapper: unavailable }), code('SOURCE_VAULT_WRAPPING_UNAVAILABLE'));
  assert.equal(wraps, 0);
  await assert.rejects(fs.lstat(f.options.safetyRoot), { code: 'ENOENT' });
  await assert.rejects(f.create({ wrapper: { isAvailable: () => true, wrap: bytes => bytes, unwrap: bytes => bytes } }), code('SOURCE_VAULT_KEY_INVALID'));
  await assert.rejects(fs.lstat(f.keyFile), { code: 'ENOENT' });
});

test('validates expected hash and size separately from GCM authentication', async t => {
  const f = await fixture(t);
  const original = await f.vault.put({ projectId: 1, bytes: Buffer.from('fixture content') });
  await assert.rejects(f.vault.read({ ...original, byteSize: original.byteSize + 1 }), code('SOURCE_VAULT_INTEGRITY'));
  // Construct a valid authenticated envelope whose declared plaintext hash is dishonest.
  const ring = JSON.parse(f.wrapper.unwrap(await fs.readFile(f.keyFile)).toString());
  const key = Buffer.from(ring.keys.find(entry => entry.keyId === original.keyId).material, 'base64');
  const wrong = { ...original, sha256: 'a'.repeat(64) };
  const header = { format: 'code-intelligence-source-blob', major: 1, installationId: f.options.installationId,
    projectId: wrong.projectId, keyId: wrong.keyId, sha256: wrong.sha256, byteSize: wrong.byteSize };
  const nonce = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, nonce);
  cipher.setAAD(Buffer.from(JSON.stringify(header)));
  const encrypted = Buffer.concat([cipher.update(Buffer.from('fixture content')), cipher.final()]);
  const envelope = encodeEnvelope({ ...header, nonce: nonce.toString('base64'), tag: cipher.getAuthTag().toString('base64') }, encrypted);
  await fs.mkdir(path.dirname(f.blob(wrong)), { mode: 0o700 });
  await fs.writeFile(f.blob(wrong), envelope, { mode: 0o600 });
  await assert.rejects(f.vault.read(wrong), code('SOURCE_VAULT_INTEGRITY'));
});

for (const [name, mutate, expectedCode] of [
  ['unknown major', h => { h.major = 2; }, 'SOURCE_VAULT_UNSUPPORTED'],
  ['unknown field', h => { h.extra = 'unrecognized'; }, 'SOURCE_VAULT_INTEGRITY'],
  ['installation mismatch', h => { h.installationId = 'other-installation'; }, 'SOURCE_VAULT_INTEGRITY'],
  ['hash mismatch', h => { h.sha256 = '0'.repeat(64); }, 'SOURCE_VAULT_INTEGRITY'],
  ['size mismatch', h => { h.byteSize += 1; }, 'SOURCE_VAULT_INTEGRITY'],
  ['missing source key', h => { h.keyId = '0'.repeat(32); }, 'SOURCE_VAULT_KEY_MISSING'],
  ['invalid nonce', h => { h.nonce = Buffer.alloc(11).toString('base64'); }, 'SOURCE_VAULT_INTEGRITY'],
  ['invalid tag length', h => { h.tag = Buffer.alloc(15).toString('base64'); }, 'SOURCE_VAULT_INTEGRITY'],
  ['tag tamper', h => { h.tag = Buffer.alloc(16).toString('base64'); }, 'SOURCE_VAULT_INTEGRITY'],
]) test(`rejects source envelope ${name}`, async t => {
  const f = await fixture(t);
  const result = await f.vault.put({ projectId: 1, bytes: Buffer.from('fixture') });
  const { header, ciphertext } = decodeEnvelope(await fs.readFile(f.blob(result)));
  mutate(header);
  await fs.writeFile(f.blob(result), encodeEnvelope(header, ciphertext));
  await assert.rejects(f.vault.read(result), code(expectedCode));
});

test('rejects duplicate header fields, ciphertext corruption, truncation, and excessive header/file lengths', async t => {
  const f = await fixture(t);
  const result = await f.vault.put({ projectId: 1, bytes: Buffer.from('fixture') });
  const original = await fs.readFile(f.blob(result));
  const { header, ciphertext } = decodeEnvelope(original);
  const duplicate = JSON.stringify(header).replace('"major":1', '"major":2,"major":1');
  const corrupt = Buffer.from(original); corrupt[corrupt.length - 1] ^= 1;
  const headerTooLarge = Buffer.from(original); headerTooLarge.writeUInt32BE(0xffffffff, 8);
  for (const invalid of [encodeEnvelope(header, ciphertext, duplicate), corrupt, original.subarray(0, original.length - 1), headerTooLarge]) {
    await fs.writeFile(f.blob(result), invalid);
    await assert.rejects(f.vault.read(result), code('SOURCE_VAULT_INTEGRITY'));
  }
  await fs.truncate(f.blob(result), MAX_FILE_BYTES + 4096);
  await assert.rejects(f.vault.read(result), code('SOURCE_VAULT_LIMIT'));
});

test('does not overwrite a damaged existing content address', async t => {
  const f = await fixture(t);
  const bytes = Buffer.from('fixture');
  const result = await f.vault.put({ projectId: 1, bytes });
  const damaged = Buffer.from('damaged ciphertext');
  await fs.writeFile(f.blob(result), damaged);
  await assert.rejects(f.vault.put({ projectId: 1, bytes }), code('SOURCE_VAULT_INTEGRITY'));
  assert.deepEqual(await fs.readFile(f.blob(result)), damaged);
});

test('rejects keyring unknown fields/major/purpose, duplicate fields, and oversized input before unwrap', async t => {
  const f = await fixture(t);
  await f.vault.close();
  const original = await fs.readFile(f.keyFile);
  for (const [change, expected] of [
    [value => ({ ...value, extra: 1 }), 'SOURCE_VAULT_KEY_INVALID'],
    [value => ({ ...value, major: 2 }), 'SOURCE_VAULT_UNSUPPORTED'],
    [value => ({ ...value, purpose: 'credential' }), 'SOURCE_VAULT_KEY_INVALID'],
    [value => JSON.stringify(value).replace('"major":1', '"major":2,"major":1'), 'SOURCE_VAULT_KEY_INVALID'],
  ]) {
    await fs.writeFile(f.keyFile, original);
    await f.rewriteKeyring(change);
    await assert.rejects(f.open(), code(expected));
  }
  await fs.truncate(f.keyFile, 64 * 1024 + 1);
  let unwraps = 0;
  await assert.rejects(f.open({ wrapper: { ...f.wrapper, unwrap: bytes => { unwraps += 1; return f.wrapper.unwrap(bytes); } } }), code('SOURCE_VAULT_LIMIT'));
  assert.equal(unwraps, 0);
});

test('bounds unwrapped keyring size and retained key count without deleting old keys', async t => {
  const f = await fixture(t);
  const old = await f.vault.put({ projectId: 1, bytes: Buffer.from('old fixture') });
  await f.vault.close();
  await assert.rejects(f.open({ wrapper: { ...f.wrapper, unwrap: () => Buffer.alloc(32 * 1024 + 1) } }), code('SOURCE_VAULT_KEY_INVALID'));
  await f.rewriteKeyring(value => {
    while (value.keys.length < 64) value.keys.push({ keyId: crypto.randomBytes(16).toString('hex'), material: crypto.randomBytes(32).toString('base64') });
    value.revision = value.keys.length; value.activeKeyId = value.keys.at(-1).keyId;
    return value;
  });
  const reopened = await f.open();
  assert.equal(reopened.info().keyIds.length, 64);
  const before = await fs.readFile(f.keyFile);
  await assert.rejects(reopened.rotate(), code('SOURCE_VAULT_LIMIT'));
  assert.deepEqual(await fs.readFile(f.keyFile), before);
  assert.deepEqual(await reopened.read(old), Buffer.from('old fixture'));
});

test('requires disjoint private canonical roots and rejects symlink ancestors without following them', async t => {
  const f = await fixture(t, { create: false });
  await assert.rejects(f.create({ sourceRoot: f.options.safetyRoot }), code('SOURCE_VAULT_UNSAFE_PATH'));
  await assert.rejects(f.create({ sourceRoot: path.join(f.options.safetyRoot, 'sources') }), code('SOURCE_VAULT_UNSAFE_PATH'));
  await assert.rejects(f.create({ safetyRoot: `${f.options.safetyRoot}/`, sourceRoot: path.join(f.options.safetyRoot, 'sources') }), code('SOURCE_VAULT_ARGUMENT'));
  const alias = path.join(f.root, 'alias');
  await fs.symlink(f.root, alias);
  await assert.rejects(f.create({ safetyRoot: path.join(alias, 'safety') }), code('SOURCE_VAULT_UNSAFE_PATH'));
  await fs.mkdir(f.options.safetyRoot, { mode: 0o755 });
  await assert.rejects(f.create(), code('SOURCE_VAULT_UNSAFE_PATH'));
  await assert.rejects(f.create({ sourceRoot: path.join(f.root, 'x', '..', 'sources') + '/..' }), code('SOURCE_VAULT_ARGUMENT'));
});

test('rejects symlink/hardlink blobs and project-directory links without modifying their targets', async t => {
  const f = await fixture(t);
  const bytes = Buffer.from('fixture');
  const stored = await f.vault.put({ projectId: 1, bytes });
  const external = path.join(f.root, 'untouched-envelope');
  await fs.rename(f.blob(stored), external);
  await fs.symlink(external, f.blob(stored));
  await assert.rejects(f.vault.read(stored), code('SOURCE_VAULT_UNSAFE_PATH'));
  const original = await fs.readFile(external);
  await fs.unlink(f.blob(stored));
  await fs.link(external, f.blob(stored));
  await assert.rejects(f.vault.read(stored), code('SOURCE_VAULT_UNSAFE_PATH'));
  await assert.rejects(f.vault.put({ projectId: 1, bytes }), code('SOURCE_VAULT_UNSAFE_PATH'));
  assert.deepEqual(await fs.readFile(external), original);
  await fs.symlink(path.join(f.options.sourceRoot, '1'), path.join(f.options.sourceRoot, '2'));
  await assert.rejects(f.vault.put({ projectId: 2, bytes: Buffer.from('other') }), code('SOURCE_VAULT_UNSAFE_PATH'));
});

test('rejects widened key/blob permissions and a replaced live source root', async t => {
  const f = await fixture(t);
  const result = await f.vault.put({ projectId: 1, bytes: Buffer.from('fixture') });
  await fs.chmod(f.blob(result), 0o644);
  await assert.rejects(f.vault.read(result), code('SOURCE_VAULT_UNSAFE_PATH'));
  await fs.chmod(f.blob(result), 0o600);
  await fs.chmod(f.keyFile, 0o644);
  await assert.rejects(f.vault.read(result), code('SOURCE_VAULT_UNSAFE_PATH'));
  await fs.chmod(f.keyFile, 0o600);
  // Reopen after the key metadata change; active handles reject even same-key replacement.
  await f.vault.close();
  const reopened = await f.open();
  await fs.rename(f.options.sourceRoot, path.join(f.root, 'retained-sources'));
  await fs.mkdir(f.options.sourceRoot, { mode: 0o700 });
  await assert.rejects(reopened.read(result), code('SOURCE_VAULT_UNSAFE_PATH'));
});

test('rejects linked keyring files without changing the wrapped-key target', async t => {
  const f = await fixture(t);
  await f.vault.close();
  const retained = path.join(f.keyDirectory, 'retained-wrapped-key');
  await fs.rename(f.keyFile, retained);
  const original = await fs.readFile(retained);
  await fs.symlink(retained, f.keyFile);
  await assert.rejects(f.open(), code('SOURCE_VAULT_UNSAFE_PATH'));
  await fs.unlink(f.keyFile);
  await fs.link(retained, f.keyFile);
  await assert.rejects(f.open(), code('SOURCE_VAULT_UNSAFE_PATH'));
  assert.deepEqual(await fs.readFile(retained), original);
});

test('a live handle stops on keyring loss and does not manufacture replacement keys', async t => {
  const f = await fixture(t);
  const result = await f.vault.put({ projectId: 1, bytes: Buffer.from('retained fixture') });
  await fs.unlink(f.keyFile);
  await assert.rejects(f.vault.read(result), code('SOURCE_VAULT_KEY_MISSING'));
  await assert.rejects(f.vault.rotate(), code('SOURCE_VAULT_KEY_MISSING'));
  await assert.rejects(f.vault.put({ projectId: 1, bytes: Buffer.from('new fixture') }), code('SOURCE_VAULT_KEY_MISSING'));
  await assert.rejects(fs.lstat(f.keyFile), { code: 'ENOENT' });
});

test('cannot reinitialize an empty store whose prior keyring was lost', async t => {
  const f = await fixture(t);
  await f.vault.close();
  await fs.unlink(f.keyFile);
  assert.deepEqual(await fs.readdir(f.options.sourceRoot), []);
  await assert.rejects(f.create(), code('SOURCE_VAULT_NOT_FRESH'));
  await assert.rejects(f.open(), code('SOURCE_VAULT_KEY_MISSING'));
  await assert.rejects(fs.lstat(f.keyFile), { code: 'ENOENT' });
});

test('exclusive source lock leaves journal siblings alone and never guesses whether an existing lock is stale', async t => {
  const f = await fixture(t);
  const journal = path.join(f.options.safetyRoot, 'ai-journal');
  await fs.mkdir(journal, { mode: 0o700 });
  await fs.writeFile(path.join(journal, 'writer.lock'), 'synthetic journal owner', { mode: 0o600 });
  const lock = await fs.readFile(f.lockFile);
  await assert.rejects(f.open(), code('SOURCE_VAULT_LOCKED'));
  assert.deepEqual(await fs.readFile(f.lockFile), lock);
  await f.vault.close();
  await fs.writeFile(f.lockFile, 'ambiguous stale source owner', { mode: 0o600 });
  await assert.rejects(f.open(), code('SOURCE_VAULT_LOCKED'));
  assert.equal(await fs.readFile(f.lockFile, 'utf8'), 'ambiguous stale source owner');
  assert.equal(await fs.readFile(path.join(journal, 'writer.lock'), 'utf8'), 'synthetic journal owner');
});

test('does not remove a replaced ownership lock and refuses further operations', async t => {
  const f = await fixture(t);
  await fs.rename(f.lockFile, path.join(f.keyDirectory, 'previous-owner.lock'));
  await fs.writeFile(f.lockFile, 'new synthetic owner', { mode: 0o600 });
  await assert.rejects(f.vault.put({ projectId: 1, bytes: Buffer.from('fixture') }), code('SOURCE_VAULT_LOCKED'));
  await assert.rejects(f.vault.close(), code('SOURCE_VAULT_UNSAFE_PATH'));
  assert.equal(await fs.readFile(f.lockFile, 'utf8'), 'new synthetic owner');
});

for (const stage of stages) test(`blob durability failure at ${stage} never acknowledges success or harms another blob`, async t => {
  const f = await fixture(t, { create: false });
  let armed = false;
  const events = [];
  const vault = await f.create({ fault: point => { events.push(point); if (armed && point === `blob:${stage}`) throw new Error('injected'); } });
  const healthy = await vault.put({ projectId: 1, bytes: Buffer.from('healthy source') });
  const healthyEnvelope = await fs.readFile(f.blob(healthy));
  armed = true; events.length = 0;
  const bytes = Buffer.from('interrupted source');
  const expected = { projectId: '1', sha256: digest(bytes), byteSize: bytes.length };
  await assert.rejects(vault.put({ projectId: 1, bytes }), code('SOURCE_VAULT_IO'));
  assert.deepEqual(events, stages.slice(0, stages.indexOf(stage) + 1).map(s => `blob:${s}`));
  assert.deepEqual(await vault.read(healthy), Buffer.from('healthy source'));
  assert.deepEqual(await fs.readFile(f.blob(healthy)), healthyEnvelope);
  armed = false;
  if (stage === 'renamed' || stage === 'directory-synced') {
    assert.deepEqual(await vault.read(expected), bytes);
    assert.equal((await vault.put({ projectId: 1, bytes })).deduplicated, true);
  } else {
    await assert.rejects(vault.read(expected), code('SOURCE_VAULT_MISSING'));
    await assert.rejects(vault.put({ projectId: 1, bytes }), code('SOURCE_VAULT_MISSING'));
    assert.deepEqual(await fs.readdir(path.dirname(f.blob(expected))), []);
  }
  const next = await vault.put({ projectId: 1, bytes: Buffer.from('unrelated new source') });
  assert.deepEqual(await vault.read(next), Buffer.from('unrelated new source'));
});

for (const stage of stages) test(`rotation durability failure at ${stage} retains all old source keys on reopen`, async t => {
  const f = await fixture(t, { create: false });
  let armed = false;
  const vault = await f.create({ fault: point => { if (armed && point === `keyring:${stage}`) throw new Error('injected'); } });
  const retained = await vault.put({ projectId: 1, bytes: Buffer.from('old retained bytes') });
  const old = vault.info();
  armed = true;
  await assert.rejects(vault.rotate(), code('SOURCE_VAULT_IO'));
  assert.throws(() => vault.info(), code('SOURCE_VAULT_CLOSED'));
  await vault.close();
  const reopened = await f.open();
  assert.deepEqual(await reopened.read(retained), Buffer.from('old retained bytes'));
  assert.equal(reopened.info().keyIds.includes(old.activeKeyId), true);
  assert.equal(reopened.info().keyIds.length, stage === 'renamed' || stage === 'directory-synced' ? 2 : 1);
});

test('rejects a target introduced before publication instead of overwriting it', async t => {
  const f = await fixture(t, { create: false });
  const bytes = Buffer.from('fixture');
  const expected = { projectId: '1', sha256: digest(bytes), byteSize: bytes.length };
  const vault = await f.create({ fault: async point => {
    if (point === 'blob:before-rename') await fs.writeFile(f.blob(expected), 'preserve competing file', { mode: 0o600 });
  } });
  await assert.rejects(vault.put({ projectId: 1, bytes }), code('SOURCE_VAULT_NOT_FRESH'));
  assert.equal(await fs.readFile(f.blob(expected), 'utf8'), 'preserve competing file');
});

test('bounds pending inputs and drains queued operations before an idempotent close', async t => {
  const f = await fixture(t, { create: false });
  let release;
  const gate = new Promise(done => { release = done; });
  let entered;
  const waiting = new Promise(done => { entered = done; });
  let blocked = false;
  const vault = await f.create({ fault: async point => {
    if (point === 'blob:temp-written' && !blocked) { blocked = true; entered(); await gate; }
  } });
  const puts = [vault.put({ projectId: 1, bytes: Buffer.from('0') })];
  await waiting;
  for (let i = 1; i < 4; i += 1) puts.push(vault.put({ projectId: 1, bytes: Buffer.from(String(i)) }));
  await assert.rejects(vault.put({ projectId: 1, bytes: Buffer.from('excess') }), code('SOURCE_VAULT_LIMIT'));
  const close = vault.close();
  assert.equal(vault.close(), close);
  release();
  const metadata = await Promise.all(puts);
  await close;
  await assert.rejects(vault.put({ projectId: 1, bytes: Buffer.from('closed') }), code('SOURCE_VAULT_CLOSED'));
  const reopened = await f.open();
  for (let i = 0; i < 4; i += 1) assert.deepEqual(await reopened.read(metadata[i]), Buffer.from(String(i)));
});

test('enforces aggregate ciphertext-byte quota before creating entries and allows verified dedup at the limit', async t => {
  const f = await fixture(t);
  const input = Buffer.from('first fixture source');
  const saved = await f.vault.put({ projectId: 1, bytes: input });
  const size = (await fs.stat(f.blob(saved))).size;
  assert.equal(f.vault.info().store.storedBytes, size);
  assert.equal(f.vault.info().store.entries, 3);
  await f.vault.close();
  const exact = await f.open({ maxStoreBytes: size });
  assert.equal((await exact.put({ projectId: 1, bytes: input })).deduplicated, true);
  const before = exact.info().store;
  const newBytes = Buffer.from('second source with same length');
  await assert.rejects(exact.put({ projectId: 1, bytes: newBytes }), code('SOURCE_VAULT_LIMIT'));
  await assert.rejects(fs.lstat(path.dirname(f.blob({ projectId: 1, sha256: digest(newBytes) }))), { code: 'ENOENT' });
  assert.deepEqual(exact.info().store, before);
  await exact.close();
  const over = await f.open({ maxStoreBytes: 1 });
  assert.deepEqual(await over.read(saved), input);
  assert.equal((await over.put({ projectId: 1, bytes: input })).deduplicated, true);
  await assert.rejects(over.put({ projectId: 2, bytes: input }), code('SOURCE_VAULT_LIMIT'));
  assert.equal(over.info().store.storedBytes, size);
});

test('counts preserved pending/orphan ciphertext on reopen and rotation never resets the quota ledger', async t => {
  const f = await fixture(t);
  const input = Buffer.from('retained fixture');
  const saved = await f.vault.put({ projectId: 1, bytes: input });
  const encrypted = await fs.readFile(f.blob(saved));
  await f.vault.close();
  const orphanDirectory = path.join(f.options.sourceRoot, '1', '0'.repeat(64));
  await fs.mkdir(orphanDirectory, { mode: 0o700 });
  const pending = path.join(orphanDirectory, `.pending-${'a'.repeat(32)}`);
  await fs.writeFile(pending, encrypted, { mode: 0o600 });
  const reopened = await f.open({ maxStoreBytes: encrypted.length * 2 });
  assert.equal(reopened.info().store.storedBytes, encrypted.length * 2);
  assert.equal(reopened.info().store.entries, 5);
  const before = reopened.info().store;
  await reopened.rotate();
  assert.deepEqual(reopened.info().store, before);
  await assert.rejects(reopened.put({ projectId: 1, bytes: Buffer.from('new data') }), code('SOURCE_VAULT_LIMIT'));
  assert.deepEqual(await fs.readFile(pending), encrypted);
  assert.deepEqual(await reopened.read(saved), input);
});

test('charges surviving ciphertext after an unacknowledged rename failure', async t => {
  const f = await fixture(t, { create: false });
  const vault = await f.create({ fault: point => { if (point === 'blob:renamed') throw new Error('injected'); } });
  const bytes = Buffer.from('surviving encrypted source');
  await assert.rejects(vault.put({ projectId: 1, bytes }), code('SOURCE_VAULT_IO'));
  const expected = { projectId: '1', sha256: digest(bytes), byteSize: bytes.length };
  const encryptedSize = (await fs.stat(f.blob(expected))).size;
  assert.equal(vault.info().store.storedBytes, encryptedSize);
  assert.equal(vault.info().store.entries, 3);
  await vault.close();
  const reopened = await f.open({ maxStoreBytes: encryptedSize });
  assert.equal(reopened.info().store.storedBytes, encryptedSize);
  await assert.rejects(reopened.put({ projectId: 1, bytes: Buffer.from('other') }), code('SOURCE_VAULT_LIMIT'));
});

test('reserves entry capacity before mkdir and charges empty failure residue', async t => {
  const f = await fixture(t, { create: false });
  const vault = await f.create({ maxStoreEntries: 3, fault: point => {
    if (point === 'blob:temp-written') throw new Error('injected');
  } });
  await assert.rejects(vault.put({ projectId: 1, bytes: Buffer.from('interrupted') }), code('SOURCE_VAULT_IO'));
  assert.equal(vault.info().store.entries, 2); // project + hash directory; owned temp was cleaned.
  assert.equal(vault.info().store.storedBytes, 0);
  const next = Buffer.from('another address');
  await assert.rejects(vault.put({ projectId: 1, bytes: next }), code('SOURCE_VAULT_LIMIT'));
  assert.equal(vault.info().store.entries, 2);
  await assert.rejects(fs.lstat(path.dirname(f.blob({ projectId: 1, sha256: digest(next) }))), { code: 'ENOENT' });
  await vault.close();
  const reopened = await f.open({ maxStoreEntries: 3 });
  assert.equal(reopened.info().store.entries, 2);
  await assert.rejects(reopened.put({ projectId: 1, bytes: next }), code('SOURCE_VAULT_LIMIT'));
});

test('bounds the opening walk and rejects unknown or too-deep entries without deleting them', async t => {
  const f = await fixture(t);
  const saved = await f.vault.put({ projectId: 1, bytes: Buffer.from('fixture') });
  await f.vault.close();
  await assert.rejects(f.open({ maxStoreEntries: 2 }), code('SOURCE_VAULT_LIMIT'));
  const unknown = path.join(f.options.sourceRoot, 'unclassified.bin');
  await fs.writeFile(unknown, 'synthetic orphan', { mode: 0o600 });
  await assert.rejects(f.open(), code('SOURCE_VAULT_UNSAFE_PATH'));
  assert.equal(await fs.readFile(unknown, 'utf8'), 'synthetic orphan');
  await fs.unlink(unknown);
  const tooDeep = path.join(path.dirname(f.blob(saved)), 'nested');
  await fs.mkdir(tooDeep, { mode: 0o700 });
  await assert.rejects(f.open(), code('SOURCE_VAULT_UNSAFE_PATH'));
  assert.equal((await fs.stat(tooDeep)).isDirectory(), true);
});

test('quota controls may only lower the fixed installation ceilings', async t => {
  const f = await fixture(t, { create: false });
  for (const maxStoreBytes of [0, -1, 1.5, MAX_STORE_BYTES + 1, Infinity])
    await assert.rejects(f.create({ maxStoreBytes }), code('SOURCE_VAULT_ARGUMENT'));
  for (const maxStoreEntries of [0, -1, 1.5, MAX_STORE_ENTRIES + 1, Infinity])
    await assert.rejects(f.create({ maxStoreEntries }), code('SOURCE_VAULT_ARGUMENT'));
  await assert.rejects(fs.lstat(f.options.safetyRoot), { code: 'ENOENT' });
});
