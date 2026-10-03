'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { initializePurposeKeyring, openPurposeKeyring, PurposeKeyringError } = require('../src/purpose-keyring.cjs');

// Public synthetic wrapping key, only temporary fixtures. Never consult Electron or the user's keychain.
function syntheticWrapper() {
  const key = Buffer.alloc(32, 77);
  return {
    async isAvailable() { return true; },
    async wrap(plaintext) {
      const nonce = crypto.randomBytes(12);
      const cipher = crypto.createCipheriv('aes-256-gcm', key, nonce);
      cipher.setAAD(Buffer.from('purpose-keyring-test-wrapper'));
      return Buffer.concat([nonce, cipher.update(plaintext), cipher.final(), cipher.getAuthTag()]);
    },
    async unwrap(wrapped) {
      const decipher = crypto.createDecipheriv('aes-256-gcm', key, wrapped.subarray(0, 12));
      decipher.setAAD(Buffer.from('purpose-keyring-test-wrapper'));
      decipher.setAuthTag(wrapped.subarray(-16));
      return Buffer.concat([decipher.update(wrapped.subarray(12, -16)), decipher.final()]);
    },
  };
}
async function fixture(t, overrides = {}) {
  const root = await fs.mkdtemp(path.join(await fs.realpath(os.tmpdir()), 'ci-purpose-'));
  await fs.chmod(root, 0o700);
  const handles = [];
  const options = { safetyRoot: path.join(root, 'safety'), restoreRoots: [path.join(root, 'data')],
    installationId: 'synthetic-install_A-1', wrapper: syntheticWrapper(), ...overrides };
  t.after(async () => {
    for (const handle of handles) await handle.close().catch(() => {});
    await fs.rm(root, { force: true, recursive: true });
  });
  return { root, options, directory: path.join(options.safetyRoot, 'purpose-keyring'),
    file: path.join(options.safetyRoot, 'purpose-keyring', 'purpose-keyring.wrapped'),
    async initialize(extra = {}) { const handle = await initializePurposeKeyring({ ...options, ...extra }); handles.push(handle); return handle; },
    async open(extra = {}) { const handle = await openPurposeKeyring({ ...options, ...extra }); handles.push(handle); return handle; },
  };
}
async function rejects(operation, code) {
  await assert.rejects(operation, error => {
    assert.ok(error instanceof PurposeKeyringError);
    assert.equal(error.code, code);
    assert.equal(error.cause, undefined);
    return true;
  });
}
async function replacePayload(f, change) {
  const bytes = await fs.readFile(f.file);
  const plaintext = await f.options.wrapper.unwrap(bytes);
  const changed = change(JSON.parse(plaintext.toString('utf8')), plaintext);
  const replacement = Buffer.isBuffer(changed) ? changed : Buffer.from(JSON.stringify(changed));
  await fs.writeFile(f.file, await f.options.wrapper.wrap(replacement), { mode: 0o600 });
  plaintext.fill(0); replacement.fill(0);
}
function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}

test('fresh keyring has independent purpose keys, private modes, metadata-only inventory, and wrapped persistence', async t => {
  const f = await fixture(t); const keyring = await f.initialize();
  const backupId = await keyring.currentKeyId('backup'); const safetyId = await keyring.currentKeyId('safety');
  assert.match(backupId, /^[a-f0-9]{32}$/); assert.match(safetyId, /^[a-f0-9]{32}$/);
  assert.notEqual(backupId, safetyId);
  const backup = await keyring.getBackupKey(backupId); const safety = await keyring.getMacKey(safetyId, 'safety');
  assert.equal(backup.length, 32); assert.equal(safety.length, 32); assert.notDeepEqual(backup, safety);
  for (const directory of [f.options.safetyRoot, f.directory]) assert.equal((await fs.stat(directory)).mode & 0o7777, 0o700);
  for (const filename of [f.file, path.join(f.directory, 'owner.lock')]) assert.equal((await fs.stat(filename)).mode & 0o7777, 0o600);
  const persisted = await fs.readFile(f.file);
  for (const bytes of [backup, safety]) {
    assert.equal(persisted.includes(bytes), false);
    assert.equal(persisted.includes(bytes.toString('base64')), false);
  }
  const info = await keyring.info(); assert.equal(info.major, 1);
  assert.deepEqual(info.purposes.backup.keyIds, [backupId]); assert.deepEqual(info.purposes.safety.keyIds, [safetyId]);
  assert.equal(Object.isFrozen(keyring), true); assert.equal(Object.isFrozen(info.purposes.safety.keyIds), true);
  assert.equal(JSON.stringify(info).includes(backup.toString('base64')), false);
  backup.fill(0); safety.fill(0);
});

test('existing safety root supports source-vault and journal siblings without changing them', async t => {
  const f = await fixture(t);
  await fs.mkdir(f.options.safetyRoot, { mode: 0o700 });
  await fs.mkdir(path.join(f.options.safetyRoot, 'source-vault'), { mode: 0o700 });
  await fs.writeFile(path.join(f.options.safetyRoot, 'ai-off.json'), 'synthetic latch', { mode: 0o600 });
  const keyring = await f.initialize(); await keyring.close();
  assert.equal(await fs.readFile(path.join(f.options.safetyRoot, 'ai-off.json'), 'utf8'), 'synthetic latch');
  assert.equal((await fs.stat(path.join(f.options.safetyRoot, 'source-vault'))).isDirectory(), true);
});

for (const value of ['_leading', '-leading', 'a', 'a'.repeat(128)]) {
  test(`bounded installation grammar accepts ${value.length === 128 ? '128 bytes' : value}`, async t => {
    const f = await fixture(t, { installationId: value }); const keyring = await f.initialize();
    assert.equal((await keyring.info()).installationId, value);
  });
}
for (const value of ['', 'a'.repeat(129), 'abc\n', 'abc/path', '.', 123]) {
  test(`installation grammar rejects ${JSON.stringify(value)}`, async t => {
    const f = await fixture(t, { installationId: value });
    await rejects(f.initialize(), 'PURPOSE_KEYRING_ARGUMENT');
  });
}

test('all public key reads are copies and close does not mutate caller-owned copies', async t => {
  const f = await fixture(t); const keyring = await f.initialize();
  const id = await keyring.currentKeyId('safety');
  const original = await keyring.getMacKey(id, 'safety'); const expected = Buffer.from(original);
  original.fill(0); assert.deepEqual(await keyring.getMacKey(id, 'safety'), expected);
  const held = await keyring.getMacKey(id, 'safety'); await keyring.close();
  assert.deepEqual(held, expected); held.fill(0); expected.fill(0);
});

test('cross-purpose reads and unspecified journal purpose are refused', async t => {
  const f = await fixture(t); const keyring = await f.initialize();
  const backupId = await keyring.currentKeyId('backup'); const safetyId = await keyring.currentKeyId('safety');
  await rejects(keyring.getMacKey(backupId, 'safety'), 'PURPOSE_KEYRING_MISSING');
  await rejects(keyring.getBackupKey(safetyId), 'PURPOSE_KEYRING_MISSING');
  await rejects(keyring.getMacKey(safetyId, 'backup'), 'PURPOSE_KEYRING_ARGUMENT');
  await rejects(keyring.getMacKey(safetyId), 'PURPOSE_KEYRING_ARGUMENT');
  for (const unknown of ['source', 'credential', '__proto__', 'safety\n', null]) {
    await rejects(keyring.currentKeyId(unknown), 'PURPOSE_KEYRING_ARGUMENT');
    await rejects(keyring.rotate(unknown), 'PURPOSE_KEYRING_ARGUMENT');
  }
  for (const bad of ['', 'a'.repeat(32) + '\n', '../x', 'A'.repeat(32), {}, null]) {
    await rejects(keyring.getBackupKey(bad), 'PURPOSE_KEYRING_ARGUMENT');
  }
});

test('rotation changes only requested purpose, preserves every old key, and survives restart', async t => {
  const f = await fixture(t); const keyring = await f.initialize();
  const backup1 = await keyring.currentKeyId('backup'); const safety1 = await keyring.currentKeyId('safety');
  const backupBytes = await keyring.getBackupKey(backup1); const safetyBytes = await keyring.getMacKey(safety1, 'safety');
  const safety2 = await keyring.rotate('safety'); assert.notEqual(safety1, safety2);
  assert.equal(await keyring.currentKeyId('backup'), backup1);
  const backup2 = await keyring.rotate('backup'); assert.notEqual(backup1, backup2);
  await keyring.close(); const reopened = await f.open();
  assert.equal(await reopened.currentKeyId('backup'), backup2); assert.equal(await reopened.currentKeyId('safety'), safety2);
  assert.deepEqual(await reopened.getBackupKey(backup1), backupBytes);
  assert.deepEqual(await reopened.getMacKey(safety1, 'safety'), safetyBytes);
  const info = await reopened.info(); assert.equal(info.purposes.backup.revision, 2); assert.equal(info.purposes.safety.revision, 2);
});

test('same wrapper cannot make another installation keyring acceptable', async t => {
  const f = await fixture(t); const keyring = await f.initialize(); await keyring.close();
  await rejects(f.open({ installationId: 'different-installation' }), 'PURPOSE_KEYRING_INVALID');
  const reopened = await f.open(); assert.equal((await reopened.info()).installationId, f.options.installationId);
});

const corruptions = [
  ['unknown major', value => ({ ...value, major: 2 }), 'PURPOSE_KEYRING_UNSUPPORTED'],
  ['missing major', value => { delete value.major; return value; }, 'PURPOSE_KEYRING_UNSUPPORTED'],
  ['source keyring format', value => ({ ...value, format: 'code-intelligence-source-keyring' })],
  ['credential purpose', value => { value.purposes[0].purpose = 'credential'; return value; }],
  ['cross-purpose list swap', value => { value.purposes.reverse(); return value; }],
  ['installation binding', value => ({ ...value, installationId: 'other' })],
  ['extra field', value => ({ ...value, arbitrary: true })],
  ['revision mismatch', value => ({ ...value, revision: 900 })],
  ['active key mismatch', value => { value.purposes[1].activeKeyId = '0'.repeat(32); return value; }],
  ['duplicate key ID', value => { value.purposes[1].keys[0].keyId = value.purposes[0].keys[0].keyId; return value; }],
  ['cross-purpose duplicate material', value => { value.purposes[1].keys[0].material = value.purposes[0].keys[0].material; return value; }],
  ['short key bytes', value => { value.purposes[0].keys[0].material = Buffer.alloc(31).toString('base64'); return value; }],
  ['noncanonical base64', value => { value.purposes[0].keys[0].material = 'A'.repeat(43) + '!'; return value; }],
  ['duplicate JSON member', (_value, bytes) => Buffer.from(bytes.toString('utf8').replace('"major":1', '"major":1,"major":1'))],
  ['trailing JSON data', (_value, bytes) => Buffer.concat([bytes, Buffer.from('{}')])],
  ['noncanonical whitespace', (_value, bytes) => Buffer.concat([bytes, Buffer.from('\n')])],
  ['invalid UTF8', (_value, bytes) => Buffer.concat([bytes, Buffer.from([0xff])])],
];
for (const [name, change, code = 'PURPOSE_KEYRING_INVALID'] of corruptions) {
  test(`authenticated wrapper still rejects ${name}`, async t => {
    const f = await fixture(t); const keyring = await f.initialize(); await keyring.close();
    await replacePayload(f, change); await rejects(f.open(), code);
  });
}

test('tampered ciphertext fails without disclosing wrapper errors or generating new keys', async t => {
  const f = await fixture(t); const keyring = await f.initialize(); await keyring.close();
  const bytes = await fs.readFile(f.file); bytes[15] ^= 1; await fs.writeFile(f.file, bytes);
  await rejects(f.open(), 'PURPOSE_KEYRING_INVALID');
  await rejects(f.initialize(), 'PURPOSE_KEYRING_NOT_FRESH');
  assert.deepEqual(await fs.readFile(f.file), bytes);
});

test('missing keyring and missing directory never cause automatic reinitialization', async t => {
  const f = await fixture(t); await rejects(f.open(), 'PURPOSE_KEYRING_MISSING');
  const keyring = await f.initialize(); await keyring.close(); await fs.unlink(f.file);
  await rejects(f.open(), 'PURPOSE_KEYRING_MISSING');
  await rejects(f.initialize(), 'PURPOSE_KEYRING_NOT_FRESH');
});

test('same-install unwrapped source-shaped payload is refused', async t => {
  const f = await fixture(t); const keyring = await f.initialize(); await keyring.close();
  await replacePayload(f, () => ({ format: 'code-intelligence-source-keyring', major: 1, purpose: 'source',
    installationId: f.options.installationId, revision: 1, activeKeyId: 'a'.repeat(32),
    keys: [{ keyId: 'a'.repeat(32), material: Buffer.alloc(32, 3).toString('base64') }] }));
  await rejects(f.open(), 'PURPOSE_KEYRING_INVALID');
});

for (const relation of ['equal', 'ancestor', 'descendant']) {
  test(`restore root ${relation} of safety root is rejected before state creation`, async t => {
    const f = await fixture(t);
    const root = relation === 'equal' ? f.options.safetyRoot : relation === 'ancestor' ? f.root : path.join(f.options.safetyRoot, 'nested');
    await rejects(f.initialize({ restoreRoots: [root] }), 'PURPOSE_KEYRING_UNSAFE_PATH');
    await assert.rejects(fs.stat(f.options.safetyRoot), { code: 'ENOENT' });
  });
}

test('restore-root symlink alias to safety is refused', async t => {
  const f = await fixture(t); await fs.mkdir(f.options.safetyRoot, { mode: 0o700 });
  const alias = path.join(f.root, 'restore-alias'); await fs.symlink(f.options.safetyRoot, alias);
  await rejects(f.initialize({ restoreRoots: [path.join(alias, 'nested')] }), 'PURPOSE_KEYRING_UNSAFE_PATH');
});

test('restore paths are copied and rechecked before every key use', async t => {
  const f = await fixture(t); const keyring = await f.initialize();
  f.options.restoreRoots.push(f.root); // Mutating the caller array cannot reconfigure a live keyring.
  assert.equal(typeof await keyring.currentKeyId('safety'), 'string');
  await fs.symlink(f.options.safetyRoot, f.options.restoreRoots[0]);
  await rejects(keyring.currentKeyId('safety'), 'PURPOSE_KEYRING_UNSAFE_PATH');
  await rejects(keyring.info(), 'PURPOSE_KEYRING_CLOSED');
});

test('invalid path, restore-list, limit, and wrapper arguments are rejected', async t => {
  const f = await fixture(t);
  for (const safetyRoot of ['relative', '/', f.options.safetyRoot + '/', f.root + '/a/../safety', f.root + '/null\0byte']) {
    await rejects(f.initialize({ safetyRoot }), 'PURPOSE_KEYRING_ARGUMENT');
  }
  for (const restoreRoots of [undefined, [], [f.root + '/a/../b'], Array(33).fill(path.join(f.root, 'data'))]) {
    await rejects(f.initialize({ restoreRoots }), 'PURPOSE_KEYRING_ARGUMENT');
  }
  for (const limits of [null, [], { unknown: 1 }, { keysPerPurpose: 65 }, { pendingOperations: 0 }, { keyringBytes: 1.1 }]) {
    await rejects(f.initialize({ limits }), 'PURPOSE_KEYRING_ARGUMENT');
  }
  await rejects(f.initialize({ wrapper: {} }), 'PURPOSE_KEYRING_ARGUMENT');
  await rejects(f.initialize({ fault: 1 }), 'PURPOSE_KEYRING_ARGUMENT');
});

for (const component of ['safety', 'key-directory', 'key-file']) {
  test(`${component} symlink is rejected`, async t => {
    const f = await fixture(t); const keyring = await f.initialize(); await keyring.close();
    const target = component === 'safety' ? f.options.safetyRoot : component === 'key-directory' ? f.directory : f.file;
    const saved = path.join(f.root, 'saved-' + component); await fs.rename(target, saved); await fs.symlink(saved, target);
    await rejects(f.open(), 'PURPOSE_KEYRING_UNSAFE_PATH');
  });
}
for (const component of ['safety', 'key-directory', 'key-file']) {
  test(`${component} broad mode is refused without silent repair`, async t => {
    const f = await fixture(t); const keyring = await f.initialize(); await keyring.close();
    const target = component === 'safety' ? f.options.safetyRoot : component === 'key-directory' ? f.directory : f.file;
    const badMode = component === 'key-file' ? 0o644 : 0o755; await fs.chmod(target, badMode);
    await rejects(f.open(), 'PURPOSE_KEYRING_UNSAFE_PATH');
    assert.equal((await fs.stat(target)).mode & 0o7777, badMode);
  });
}

test('hardlinked key file is rejected', async t => {
  const f = await fixture(t); const keyring = await f.initialize(); await keyring.close();
  await fs.link(f.file, path.join(f.root, 'second-key-link'));
  await rejects(f.open(), 'PURPOSE_KEYRING_UNSAFE_PATH');
});

test('unexpected key directory entries and crash-left pending files require recovery', async t => {
  const f = await fixture(t); const keyring = await f.initialize(); await keyring.close();
  const residue = path.join(f.directory, '.pending-' + 'a'.repeat(32));
  await fs.writeFile(residue, 'synthetic incomplete ciphertext', { mode: 0o600 });
  await rejects(f.open(), 'PURPOSE_KEYRING_INVALID');
  assert.equal(await fs.readFile(residue, 'utf8'), 'synthetic incomplete ciphertext');
});

test('replaced roots and files poison a live handle without returning cached keys', async t => {
  const f = await fixture(t); const keyring = await f.initialize(); const id = await keyring.currentKeyId('backup');
  const original = await fs.readFile(f.file); await fs.unlink(f.file); await fs.writeFile(f.file, original, { mode: 0o600 });
  await rejects(keyring.getBackupKey(id), 'PURPOSE_KEYRING_INVALID');
  await rejects(keyring.currentKeyId('backup'), 'PURPOSE_KEYRING_CLOSED');
});

test('another writer, including crash-left lock, never gets automatic lock deletion', async t => {
  const f = await fixture(t); const keyring = await f.initialize();
  await rejects(f.open(), 'PURPOSE_KEYRING_LOCKED');
  await keyring.close();
  const lock = path.join(f.directory, 'owner.lock');
  await fs.writeFile(lock, JSON.stringify({ pid: 2147483647, owner: 'synthetic dead process' }), { mode: 0o600 });
  const original = await fs.readFile(lock);
  await rejects(f.open(), 'PURPOSE_KEYRING_LOCKED'); assert.deepEqual(await fs.readFile(lock), original);
});

test('replacement lock is preserved on key read and close', async t => {
  const f = await fixture(t); const keyring = await f.initialize(); const lock = path.join(f.directory, 'owner.lock');
  await fs.unlink(lock); await fs.writeFile(lock, 'synthetic other owner', { mode: 0o600 });
  await rejects(keyring.currentKeyId('safety'), 'PURPOSE_KEYRING_LOCKED');
  await rejects(keyring.close(), 'PURPOSE_KEYRING_LOCKED');
  assert.equal(await fs.readFile(lock, 'utf8'), 'synthetic other owner');
});

test('missing live key file fails closed despite keys in memory', async t => {
  const f = await fixture(t); const keyring = await f.initialize(); const id = await keyring.currentKeyId('safety');
  await fs.unlink(f.file); await rejects(keyring.getMacKey(id, 'safety'), 'PURPOSE_KEYRING_MISSING');
  await rejects(keyring.getMacKey(id, 'safety'), 'PURPOSE_KEYRING_CLOSED');
});

test('secure wrapping unavailable has no plaintext fallback or key creation', async t => {
  const f = await fixture(t, { wrapper: { ...syntheticWrapper(), async isAvailable() { return false; } } });
  await rejects(f.initialize(), 'PURPOSE_KEYRING_WRAPPING_UNAVAILABLE');
  await assert.rejects(fs.stat(f.options.safetyRoot), { code: 'ENOENT' });
});

test('wrapper availability loss blocks already opened key use and requires reopen', async t => {
  let available = true;
  const f = await fixture(t, { wrapper: { ...syntheticWrapper(), async isAvailable() { return available; } } });
  const keyring = await f.initialize(); available = false;
  await rejects(keyring.currentKeyId('backup'), 'PURPOSE_KEYRING_WRAPPING_UNAVAILABLE');
  available = true; await rejects(keyring.currentKeyId('backup'), 'PURPOSE_KEYRING_CLOSED');
  await keyring.close(); await f.open();
});

test('wrapper and fault error details never cross public error boundary', async t => {
  const secret = 'synthetic-path-token-DO-NOT-EXPOSE';
  const f = await fixture(t, { wrapper: { ...syntheticWrapper(), async wrap() { throw new Error(secret); } } });
  await assert.rejects(f.initialize(), error => {
    assert.equal(error.code, 'PURPOSE_KEYRING_WRAPPING_UNAVAILABLE'); assert.equal(String(error).includes(secret), false);
    assert.equal(error.cause, undefined); assert.equal(JSON.stringify(error).includes(secret), false); return true;
  });
});

for (const behavior of ['plaintext', 'oversized', 'unreadable', 'non-buffer']) {
  test(`wrapper ${behavior} output is rejected before publication`, async t => {
    const wrapped = syntheticWrapper();
    const f = await fixture(t, { wrapper: { ...wrapped, async wrap(bytes) {
      if (behavior === 'plaintext') return Buffer.from(bytes);
      if (behavior === 'oversized') return Buffer.alloc(65537);
      if (behavior === 'non-buffer') return new Uint8Array(10);
      return wrapped.wrap(Buffer.from('{}'));
    } } });
    await rejects(f.initialize(), 'PURPOSE_KEYRING_INVALID');
    await assert.rejects(fs.stat(f.file), { code: 'ENOENT' });
    await rejects(f.initialize(), 'PURPOSE_KEYRING_NOT_FRESH');
  });
}

test('wrapper temporary plaintext references are cleared after initialization and rotation', async t => {
  const seen = []; const wrapped = syntheticWrapper();
  const f = await fixture(t, { wrapper: { ...wrapped, async wrap(bytes) { seen.push(bytes); return wrapped.wrap(bytes); },
    async unwrap(bytes) { const result = await wrapped.unwrap(bytes); seen.push(result); return result; } } });
  const keyring = await f.initialize(); await keyring.rotate('backup');
  assert.ok(seen.length >= 4);
  for (const bytes of seen) assert.equal(bytes.every(byte => byte === 0), true);
});

for (const stage of ['temp-written', 'file-synced', 'before-rename', 'renamed', 'directory-synced']) {
  test(`initialization fault at ${stage} never ACKs or silently resets state`, async t => {
    const f = await fixture(t, { fault: actual => { if (actual === `keyring:${stage}`) throw new Error('synthetic fsync fault'); } });
    await rejects(f.initialize(), 'PURPOSE_KEYRING_IO');
    await rejects(f.initialize({ fault: undefined }), 'PURPOSE_KEYRING_NOT_FRESH');
    if (['renamed', 'directory-synced'].includes(stage)) {
      const opened = await f.open({ fault: undefined }); assert.equal((await opened.info()).purposes.backup.revision, 1);
    } else await rejects(f.open({ fault: undefined }), 'PURPOSE_KEYRING_MISSING');
  });
  test(`rotation fault at ${stage} poisons handle, retains all previous keys, and reopens a whole version`, async t => {
    let armed = false;
    const f = await fixture(t, { fault: actual => { if (armed && actual === `keyring:${stage}`) throw new Error('synthetic fsync fault'); } });
    const keyring = await f.initialize(); const oldId = await keyring.currentKeyId('backup');
    const oldBytes = await keyring.getBackupKey(oldId); armed = true;
    await rejects(keyring.rotate('backup'), 'PURPOSE_KEYRING_IO');
    await rejects(keyring.getBackupKey(oldId), 'PURPOSE_KEYRING_CLOSED');
    await keyring.close(); const opened = await f.open({ fault: undefined });
    assert.deepEqual(await opened.getBackupKey(oldId), oldBytes);
    const expectedRevision = ['renamed', 'directory-synced'].includes(stage) ? 2 : 1;
    assert.equal((await opened.info()).purposes.backup.revision, expectedRevision);
    assert.equal((await opened.info()).purposes.safety.revision, 1);
  });
}

test('success is not observable until containing-directory fsync stage completes', async t => {
  const reached = deferred(); const release = deferred();
  const f = await fixture(t, { async fault(stage) {
    if (stage === 'keyring:directory-synced') { reached.resolve(); await release.promise; }
  } });
  let completed = false; const creating = f.initialize().then(value => { completed = true; return value; });
  await reached.promise; assert.equal(completed, false); release.resolve();
  const keyring = await creating; assert.equal(completed, true); await keyring.close();
});

test('concurrent rotations and reads serialize and close drains already accepted operations', async t => {
  const entered = deferred(); const release = deferred(); let armed = false;
  const f = await fixture(t, { async fault(stage) { if (armed && stage === 'keyring:file-synced') {
    armed = false; entered.resolve(); await release.promise;
  } } });
  const keyring = await f.initialize(); const original = await keyring.currentKeyId('safety');
  armed = true; const rotation = keyring.rotate('safety'); await entered.promise;
  const readCurrent = keyring.currentKeyId('safety'); const readOld = keyring.getMacKey(original, 'safety');
  const rotateBackup = keyring.rotate('backup');
  const closing = keyring.close(); assert.equal(closing, keyring.close());
  await rejects(keyring.currentKeyId('safety'), 'PURPOSE_KEYRING_CLOSED');
  release.resolve();
  const newId = await rotation; assert.equal(await readCurrent, newId); assert.equal((await readOld).length, 32);
  const newBackup = await rotateBackup; await closing;
  const reopened = await f.open(); assert.equal(await reopened.currentKeyId('safety'), newId);
  assert.equal(await reopened.currentKeyId('backup'), newBackup);
});

test('pending operation capacity is bounded without affecting accepted writes', async t => {
  const entered = deferred(); const release = deferred(); let armed = false;
  const f = await fixture(t, { limits: { pendingOperations: 2 }, async fault(stage) {
    if (armed && stage === 'keyring:temp-written') { armed = false; entered.resolve(); await release.promise; }
  } });
  const keyring = await f.initialize(); armed = true;
  const rotation = keyring.rotate('backup'); await entered.promise;
  const accepted = keyring.currentKeyId('backup');
  await rejects(keyring.info(), 'PURPOSE_KEYRING_CAPACITY');
  release.resolve(); assert.equal(await accepted, await rotation);
  assert.equal((await keyring.info()).purposes.backup.revision, 2);
});

test('per-purpose key capacity blocks rotation while preserving reads and the other purpose', async t => {
  const f = await fixture(t, { limits: { keysPerPurpose: 2 } }); const keyring = await f.initialize();
  const backup1 = await keyring.currentKeyId('backup'); const backup2 = await keyring.rotate('backup');
  await rejects(keyring.rotate('backup'), 'PURPOSE_KEYRING_CAPACITY');
  assert.equal(await keyring.currentKeyId('backup'), backup2); assert.equal((await keyring.getBackupKey(backup1)).length, 32);
  await keyring.rotate('safety'); await keyring.close(); const reopened = await f.open();
  assert.equal((await reopened.info()).purposes.backup.keyIds.length, 2);
});

test('bounded wrapped and plaintext keyring inputs are rejected before unbounded reads', async t => {
  const f = await fixture(t); const keyring = await f.initialize(); await keyring.close();
  const original = await fs.readFile(f.file);
  await fs.writeFile(f.file, Buffer.alloc(65537)); await rejects(f.open(), 'PURPOSE_KEYRING_CAPACITY');
  await fs.writeFile(f.file, original);
  await rejects(f.open({ limits: { keyringBytes: 100 } }), 'PURPOSE_KEYRING_INVALID');
  await rejects(f.open({ limits: { wrappedBytes: 100 } }), 'PURPOSE_KEYRING_CAPACITY');
});

test('plaintext capacity failure during initialization leaves explicit recovery state', async t => {
  const f = await fixture(t, { limits: { keyringBytes: 100 } });
  await rejects(f.initialize(), 'PURPOSE_KEYRING_CAPACITY');
  await rejects(f.initialize({ limits: undefined }), 'PURPOSE_KEYRING_NOT_FRESH');
});

test('concurrent fresh initialization cannot create competing inventories', async t => {
  const f = await fixture(t);
  const outcomes = await Promise.allSettled([f.initialize(), f.initialize()]);
  assert.equal(outcomes.filter(result => result.status === 'fulfilled').length, 1);
  assert.equal(outcomes.filter(result => result.status === 'rejected')[0].reason.code, 'PURPOSE_KEYRING_NOT_FRESH');
});
