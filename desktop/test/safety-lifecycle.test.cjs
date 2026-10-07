'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs/promises');
const fsSync = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');
// Model macOS in the VM even on the Linux CI runner; filesystem calls use only POSIX temp fixtures.
const lifecycle = loadModule({ platform: 'darwin' });
const keyrings = require('../src/purpose-keyring.cjs');
const journals = require('../src/safety-journal.cjs');

// Synthetic string encryption only: this suite never loads Electron or uses an OS keychain.
function storage() {
  const key = Buffer.alloc(32, 47);
  const calls = { encrypt: 0, decrypt: 0 };
  return {
    calls,
    isEncryptionAvailable: () => true,
    encryptString(value) {
      calls.encrypt++;
      const nonce = crypto.randomBytes(12);
      const cipher = crypto.createCipheriv('aes-256-gcm', key, nonce);
      cipher.setAAD(Buffer.from('synthetic-main-storage'));
      return Buffer.concat([nonce, cipher.update(value, 'utf8'), cipher.final(), cipher.getAuthTag()]);
    },
    decryptString(bytes) {
      calls.decrypt++;
      const cipher = crypto.createDecipheriv('aes-256-gcm', key, bytes.subarray(0, 12));
      cipher.setAAD(Buffer.from('synthetic-main-storage')); cipher.setAuthTag(bytes.subarray(-16));
      return Buffer.concat([cipher.update(bytes.subarray(12, -16)), cipher.final()]).toString('utf8');
    },
  };
}
function loadModule(overrides = {}) {
  const context = vm.createContext({
    module: { exports: {} }, Buffer,
    process: { platform: overrides.platform || 'darwin', getuid: process.getuid.bind(process) },
    require(name) {
      if (Object.hasOwn(overrides, name)) return overrides[name];
      if (name.startsWith('./')) return require(path.resolve(__dirname, '../src', name));
      return require(name);
    },
  });
  vm.runInContext(fsSync.readFileSync(path.join(__dirname, '../src/safety-lifecycle.cjs'), 'utf8'), context);
  return context.module.exports;
}
async function fixture(t) {
  const root = await fs.mkdtemp(path.join(await fs.realpath(os.tmpdir()), 'ci-safety-lifecycle-'));
  await fs.chmod(root, 0o700);
  const safeStorage = storage(); const opened = [];
  t.after(async () => {
    for (const item of opened) await item.close().catch(() => {});
    await fs.rm(root, { recursive: true, force: true });
  });
  return { root, safeStorage, marker: path.join(root, '.safety-enrollment.json'),
    options: { userData: root, safeStorage, installationId: 'synthetic-main-installation', runningBuild: '100' },
    async open(api = lifecycle, changes = {}) {
      const result = await api.openSafetyLifecycle({ ...this.options, ...changes }); opened.push(result); return result;
    },
  };
}
const sha = value => crypto.createHash('sha256').update(value).digest('hex');
async function missing(file) { await assert.rejects(fs.lstat(file), { code: 'ENOENT' }); }
function assertPrivateStatus(value, recoveryOnly = false) {
  assert.deepEqual(JSON.parse(JSON.stringify(value)), { aiOff: true, recoveryOnly });
}
function fakeModules(calls, changes = {}) {
  const state = { major: 1, installationId: 'synthetic-main-installation', aiOff: true,
    recoveryOnly: false, pendingRestore: null, minimumVersion: '0', ...changes.state };
  const keyring = { async close() { calls.push('keyring.close'); await changes.keyringClose?.(); } };
  const journal = { snapshot: () => state,
    async latch(reason) { calls.push(`journal.latch:${reason}`); await changes.latch?.(); return { ...state, requests: ['private'] }; },
    async close() { calls.push('journal.close'); await changes.journalClose?.(); } };
  const openKeyring = async options => { calls.push('keyring.open'); await changes.keyringOpen?.(options); return keyring; };
  const openJournal = async options => { calls.push('journal.open'); await changes.journalOpen?.(options); return journal; };
  return { './purpose-keyring.cjs': { initializePurposeKeyring: openKeyring, openPurposeKeyring: openKeyring },
    './safety-journal.cjs': { initializeSafetyJournal: openJournal, openSafetyJournal: openJournal } };
}

for (const value of ['0', '1', '100', '9223372036854775807']) {
  test(`explicit canonical build sequence ${value} is accepted`, () => {
    assert.equal(lifecycle.requireBuildSequence(value), value);
  });
}
for (const value of [undefined, null, 100, 1n, '', '00', '01', '-1', '+1', '1.0', '1e3', '1\n', '9223372036854775808']) {
  test(`invalid build sequence ${String(value)} fails before any file or secure-storage call`, async t => {
    const f = await fixture(t);
    await assert.rejects(f.open(lifecycle, { userData: path.join(f.root, 'not-created'), runningBuild: value }),
      { code: 'SAFETY_BUILD_SEQUENCE_INVALID' });
    assert.deepEqual(await fs.readdir(f.root), []);
    assert.equal(f.safeStorage.calls.encrypt + f.safeStorage.calls.decrypt, 0);
  });
}

test('production adapter round-trips arbitrary bytes through the string storage interface', () => {
  const adapter = lifecycle.createSafeStorageWrapper(storage());
  const bytes = Buffer.from([0, 255, 192, 128, 65, 10]);
  assert.deepEqual(adapter.unwrap(adapter.wrap(bytes)), bytes);
  assert.equal(Object.isFrozen(adapter), true);
});

for (const platform of ['linux', 'win32']) {
  test(`production adapter refuses ${platform} without supported ready-platform evidence even if storage claims availability`, () => {
    const fake = storage();
    const api = loadModule({ platform });
    assert.throws(() => api.createSafeStorageWrapper(fake), { code: 'SAFETY_STORAGE_UNAVAILABLE' });
    assert.equal(fake.calls.encrypt + fake.calls.decrypt, 0);
  });
}
test('unavailable or throwing secure storage yields only a static safe error', () => {
  for (const isEncryptionAvailable of [() => false, () => { throw new Error('/private/synthetic/secret'); }]) {
    assert.throws(() => lifecycle.createSafeStorageWrapper({ ...storage(), isEncryptionAvailable }), error => {
      assert.equal(error.code, 'SAFETY_STORAGE_UNAVAILABLE');
      assert.equal(error.message.includes('/private'), false); return true;
    });
  }
});
for (const text of ['', 'key=synthetic', 'code-intelligence-purpose-dek:v1:AA',
  'code-intelligence-purpose-dek:v1:AA==\n', 'code-intelligence-purpose-dek:v1:']) {
  test(`wrapper rejects malformed decrypted framing ${JSON.stringify(text)}`, () => {
    const fake = storage(); const adapter = lifecycle.createSafeStorageWrapper(fake);
    const encrypted = adapter.wrap(Buffer.from('synthetic private keyring'));
    fake.decryptString = () => text;
    assert.throws(() => adapter.unwrap(encrypted), { code: 'SAFETY_STORAGE_UNAVAILABLE' });
  });
}

function plaintextStorage() {
  return { isEncryptionAvailable: () => true,
    encryptString: value => Buffer.from(`0|${value}`),
    decryptString: bytes => bytes.subarray(2).toString('utf8') };
}
test('AES-GCM authenticates payloads even when synthetic OS storage itself supplies no integrity', () => {
  const adapter = lifecycle.createSafeStorageWrapper(plaintextStorage());
  const plaintext = Buffer.from('synthetic keyring bytes with independent integrity');
  const encrypted = adapter.wrap(plaintext);
  assert.deepEqual(adapter.unwrap(encrypted), plaintext);
  assert.equal(encrypted.includes(plaintext), false);
  assert.notDeepEqual(adapter.wrap(plaintext), encrypted);
});
for (const location of ['magic', 'wrapped-length', 'plaintext-length', 'wrapped-ignored-byte', 'wrapped-key', 'nonce', 'ciphertext', 'tag', 'truncated', 'extended']) {
  test(`authenticated wrapper rejects ${location} mutation with an unauthenticated synthetic OS wrapper`, () => {
    const adapter = lifecycle.createSafeStorageWrapper(plaintextStorage());
    const encrypted = adapter.wrap(Buffer.from('synthetic private keyring'));
    const keyLength = encrypted.readUInt32BE(8); let mutant = Buffer.from(encrypted);
    const positions = { magic: 0, 'wrapped-length': 11, 'plaintext-length': 15,
      'wrapped-ignored-byte': 16, 'wrapped-key': 16 + keyLength - 4,
      nonce: 16 + keyLength, ciphertext: 16 + keyLength + 12, tag: mutant.length - 1 };
    if (location === 'truncated') mutant = mutant.subarray(0, -1);
    else if (location === 'extended') mutant = Buffer.concat([mutant, Buffer.from([0])]);
    else mutant[positions[location]] ^= 1;
    // wrapped-ignored-byte preserves the decrypted DEK: exact wrapped bytes must also be authenticated.
    assert.throws(() => adapter.unwrap(mutant), { code: 'SAFETY_STORAGE_UNAVAILABLE' });
    assert.deepEqual(adapter.unwrap(encrypted), Buffer.from('synthetic private keyring'));
  });
}
for (const part of ['wrapped-key', 'nonce-ciphertext-tag']) {
  test(`authenticated wrapper rejects cross-envelope ${part} splicing`, () => {
    const adapter = lifecycle.createSafeStorageWrapper(plaintextStorage());
    const first = adapter.wrap(Buffer.from('synthetic first-keyring'));
    const second = adapter.wrap(Buffer.from('synthetic other-keyring'));
    const keyEnd = 16 + first.readUInt32BE(8); const mutant = Buffer.from(first);
    if (part === 'wrapped-key') second.copy(mutant, 16, 16, keyEnd);
    else second.copy(mutant, keyEnd, keyEnd);
    assert.throws(() => adapter.unwrap(mutant), { code: 'SAFETY_STORAGE_UNAVAILABLE' });
  });
}
test('DEK and unauthenticated plaintext buffers are cleared on success and tag failure', () => {
  const keys = []; const partials = [];
  const api = loadModule({ 'node:crypto': { ...crypto,
    createCipheriv(...args) { keys.push(args[1]); return crypto.createCipheriv(...args); },
    createDecipheriv(...args) {
      keys.push(args[1]); const decipher = crypto.createDecipheriv(...args);
      const update = decipher.update.bind(decipher);
      decipher.update = (...values) => { const result = update(...values); partials.push(result); return result; };
      return decipher;
    },
  } });
  const adapter = api.createSafeStorageWrapper(plaintextStorage());
  const encrypted = adapter.wrap(Buffer.from('synthetic plaintext'));
  assert.deepEqual(adapter.unwrap(encrypted), Buffer.from('synthetic plaintext'));
  encrypted[encrypted.length - 1] ^= 1;
  assert.throws(() => adapter.unwrap(encrypted), { code: 'SAFETY_STORAGE_UNAVAILABLE' });
  assert.equal(keys.length, 3); assert.equal(partials.length, 2);
  for (const bytes of [...keys, ...partials]) assert.equal(bytes.every(value => value === 0), true);
});

test('fresh legacy secrets are private, durable, and reused without regeneration', async t => {
  const f = await fixture(t);
  const first = await lifecycle.loadDesktopSecrets({ userData: f.root, safeStorage: f.safeStorage });
  const file = path.join(f.root, 'secrets.enc'); const before = await fs.readFile(file);
  const second = await lifecycle.loadDesktopSecrets({ userData: f.root, safeStorage: f.safeStorage });
  assert.deepEqual(first, second);
  assert.deepEqual(await fs.readFile(file), before);
  assert.equal((await fs.stat(file)).mode & 0o777, 0o600);
  assert.equal(f.safeStorage.calls.encrypt, 1);
});

for (const evidence of ['safety', '.safety-enrollment.json', 'postgres', 'data', 'redis', 'recovery', 'backup-maintenance', 'authorized-paths.enc']) {
  test(`missing identity with ${evidence} evidence never falls back to new secrets`, async t => {
    const f = await fixture(t);
    await fs.writeFile(path.join(f.root, evidence), 'synthetic evidence', { mode: 0o600 });
    await assert.rejects(lifecycle.loadDesktopSecrets({ userData: f.root, safeStorage: f.safeStorage }),
      { code: 'SAFETY_IDENTITY_UNAVAILABLE' });
    await missing(path.join(f.root, 'secrets.enc'));
    assert.equal(f.safeStorage.calls.encrypt, 0);
  });
}
test('maintenance recovery evidence cannot enroll replacement safety keys after B was lost', async t => {
  const f = await fixture(t); const calls = [];
  await fs.mkdir(path.join(f.root, 'backup-maintenance'), { mode: 0o700 });
  await assert.rejects(f.open(loadModule(fakeModules(calls))), { code: 'SAFETY_RECOVERY_REQUIRED' });
  assert.deepEqual(calls, []); await missing(f.marker); await missing(path.join(f.root, 'safety'));
  assert.equal(f.safeStorage.calls.encrypt, 0);
});
test('dangling evidence symlink also prevents identity fallback', async t => {
  const f = await fixture(t);
  await fs.symlink(path.join(f.root, 'absent'), path.join(f.root, 'safety'));
  await assert.rejects(lifecycle.loadDesktopSecrets({ userData: f.root, safeStorage: f.safeStorage }),
    { code: 'SAFETY_IDENTITY_UNAVAILABLE' });
  await missing(path.join(f.root, 'secrets.enc'));
});
test('corrupt existing secrets are never rewritten and errors do not contain ciphertext or a path', async t => {
  const f = await fixture(t); const file = path.join(f.root, 'secrets.enc');
  const before = Buffer.from('synthetic-corrupt-ciphertext'); await fs.writeFile(file, before, { mode: 0o600 });
  await assert.rejects(lifecycle.loadDesktopSecrets({ userData: f.root, safeStorage: f.safeStorage }), error => {
    assert.equal(error.code, 'SAFETY_IDENTITY_UNAVAILABLE');
    assert.equal(error.message.includes(f.root), false); assert.equal(error.message.includes(before.toString()), false); return true;
  });
  assert.deepEqual(await fs.readFile(file), before); assert.equal(f.safeStorage.calls.encrypt, 0);
});
for (const kind of ['symlink', 'hardlink', 'permissions', 'oversize', 'schema']) {
  test(`unsafe existing secrets (${kind}) cannot become a fresh identity`, async t => {
    const f = await fixture(t); const file = path.join(f.root, 'secrets.enc');
    const first = await lifecycle.loadDesktopSecrets({ userData: f.root, safeStorage: f.safeStorage });
    if (kind === 'symlink') { await fs.rename(file, `${file}.original`); await fs.symlink(`${file}.original`, file); }
    if (kind === 'hardlink') await fs.link(file, `${file}.alias`);
    if (kind === 'permissions') await fs.chmod(file, 0o644);
    if (kind === 'oversize') await fs.writeFile(file, Buffer.alloc(16385));
    if (kind === 'schema') await fs.writeFile(file, f.safeStorage.encryptString(JSON.stringify({ ...first, localIdentity: '' })));
    const before = await fs.readFile(file); const encryptions = f.safeStorage.calls.encrypt;
    await assert.rejects(lifecycle.loadDesktopSecrets({ userData: f.root, safeStorage: f.safeStorage }));
    assert.deepEqual(await fs.readFile(file), before); assert.equal(f.safeStorage.calls.encrypt, encryptions);
  });
}

test('first enrollment and reopen bind the existing identity, keep keys, and expose only an OFF facade', async t => {
  const f = await fixture(t); const first = await f.open();
  assert.deepEqual(Object.keys(first).sort(), ['close', 'denyAdmission', 'diagnostics', 'latch', 'recordAcceptedManifest', 'recordStartedBuild', 'sanctionRecoveryRollback', 'updateState']);
  assertPrivateStatus(first.diagnostics()); assert.equal(Object.isFrozen(first), true);
  assertPrivateStatus(await first.latch());
  assert.throws(() => first.denyAdmission(), { code: 'DESKTOP_AI_SAFETY_UNAVAILABLE', aiOff: true, recoveryOnly: false });
  const keyFile = path.join(f.root, 'safety/purpose-keyring/purpose-keyring.wrapped');
  const keyHash = sha(await fs.readFile(keyFile));
  const marker = await fs.readFile(f.marker, 'utf8');
  assert.equal(JSON.parse(marker).installationId, f.options.installationId);
  assert.equal((await fs.stat(f.marker)).mode & 0o777, 0o600);
  await first.close();
  await missing(path.join(f.root, 'safety/purpose-keyring/owner.lock'));
  await missing(path.join(f.root, 'safety/ai-journal/writer.lock'));
  const reopened = await f.open(); assertPrivateStatus(reopened.diagnostics());
  assert.equal(sha(await fs.readFile(keyFile)), keyHash);
  assert.equal(await fs.readFile(f.marker, 'utf8'), marker);
});
test('legacy A with existing secrets can enroll B once while remaining OFF', async t => {
  const f = await fixture(t);
  const secrets = await lifecycle.loadDesktopSecrets({ userData: f.root, safeStorage: f.safeStorage });
  await fs.mkdir(path.join(f.root, 'postgres'), { mode: 0o700 });
  await fs.mkdir(path.join(f.root, 'data'), { mode: 0o700 });
  const loaded = await lifecycle.loadDesktopSecrets({ userData: f.root, safeStorage: f.safeStorage });
  assert.equal(loaded.localIdentity, secrets.localIdentity);
  assertPrivateStatus((await f.open(lifecycle, { installationId: loaded.localIdentity })).diagnostics());
});
test('deleting the entire safety directory cannot erase enrollment or trigger initialization', async t => {
  const f = await fixture(t); const first = await f.open(); await first.close();
  const marker = await fs.readFile(f.marker);
  await fs.rm(path.join(f.root, 'safety'), { recursive: true });
  const encryptions = f.safeStorage.calls.encrypt;
  await assert.rejects(f.open(), { code: 'SAFETY_RECOVERY_REQUIRED' });
  await missing(path.join(f.root, 'safety')); assert.deepEqual(await fs.readFile(f.marker), marker);
  assert.equal(f.safeStorage.calls.encrypt, encryptions);
});
test('an existing unmarked safety directory is not adopted or initialized', async t => {
  const f = await fixture(t); await fs.mkdir(path.join(f.root, 'safety'), { mode: 0o700 });
  await assert.rejects(f.open(), { code: 'SAFETY_RECOVERY_REQUIRED' });
  assert.deepEqual(await fs.readdir(path.join(f.root, 'safety')), []); await missing(f.marker);
});
for (const kind of ['empty', 'other-identity', 'unknown-major', 'symlink', 'hardlink', 'permissions']) {
  test(`invalid enrollment marker (${kind}) fails closed without replacement`, async t => {
    const f = await fixture(t); const first = await f.open(); await first.close();
    if (kind === 'empty') await fs.writeFile(f.marker, '');
    if (kind === 'other-identity' || kind === 'unknown-major') {
      const value = JSON.parse(await fs.readFile(f.marker, 'utf8'));
      if (kind === 'other-identity') value.installationId = 'other-installation'; else value.major = 3;
      await fs.writeFile(f.marker, JSON.stringify(value));
    }
    if (kind === 'symlink') { await fs.rename(f.marker, `${f.marker}.original`); await fs.symlink(`${f.marker}.original`, f.marker); }
    if (kind === 'hardlink') await fs.link(f.marker, `${f.marker}.alias`);
    if (kind === 'permissions') await fs.chmod(f.marker, 0o644);
    const before = await fs.readFile(f.marker);
    await assert.rejects(f.open(), { code: 'SAFETY_RECOVERY_REQUIRED' });
    assert.deepEqual(await fs.readFile(f.marker), before);
  });
}

test('durable external marker precedes the first purpose-key initialization', async t => {
  const f = await fixture(t); const calls = [];
  const io = { ...fs, async open(file, ...args) {
    const handle = await fs.open(file, ...args);
    return new Proxy(handle, { get(target, key) {
      if (key === 'sync') return async () => { calls.push(file === f.marker ? 'marker.sync' : 'directory.sync'); await target.sync(); };
      const value = Reflect.get(target, key); return typeof value === 'function' ? value.bind(target) : value;
    } });
  } };
  const api = loadModule({ 'node:fs/promises': io, ...fakeModules(calls) });
  await f.open(api);
  assert.deepEqual(calls.slice(0, 4), ['marker.sync', 'directory.sync', 'keyring.open', 'journal.open']);
});
test('failed marker fsync forbids both initialization and a subsequent fresh retry', async t => {
  const f = await fixture(t); const calls = [];
  const io = { ...fs, async open(file, ...args) {
    const handle = await fs.open(file, ...args);
    if (file === f.marker) handle.sync = async () => { throw new Error('synthetic sync failure'); };
    return handle;
  } };
  await assert.rejects(f.open(loadModule({ 'node:fs/promises': io, ...fakeModules(calls) })),
    { code: 'SAFETY_RECOVERY_REQUIRED' });
  assert.deepEqual(calls, []); assert.ok(await fs.lstat(f.marker));
  await assert.rejects(f.open(), { code: 'SAFETY_RECOVERY_REQUIRED' });
  await missing(path.join(f.root, 'safety'));
});
test('failed key wrapping leaves enrollment evidence and never regenerates keys on retry', async t => {
  const f = await fixture(t);
  const encrypt = f.safeStorage.encryptString.bind(f.safeStorage);
  let wrapCalls = 0;
  f.safeStorage.encryptString = value => {
    // The authenticated origin proof is published before the first purpose-key wrap.
    if (++wrapCalls === 1) return encrypt(value);
    throw new Error('synthetic purpose-key wrapper failure');
  };
  await assert.rejects(f.open(), { code: 'SAFETY_RECOVERY_REQUIRED' });
  assert.equal(wrapCalls, 2);
  assert.ok(await fs.lstat(f.marker));
  const marker = await fs.readFile(f.marker);
  f.safeStorage.encryptString = () => { wrapCalls++; throw new Error('must not wrap new keys'); };
  await assert.rejects(f.open(), { code: 'SAFETY_RECOVERY_REQUIRED' });
  assert.equal(wrapCalls, 2);
  assert.deepEqual(await fs.readFile(f.marker), marker);
  await missing(path.join(f.root, 'safety/purpose-keyring/purpose-keyring.wrapped'));
});
test('failed origin-proof wrapping publishes no marker and never initializes purpose keys', async t => {
  const f = await fixture(t); const calls = [];
  f.safeStorage.encryptString = () => { throw new Error('synthetic origin-proof wrapper failure'); };
  await assert.rejects(f.open(loadModule(fakeModules(calls))), { code: 'SAFETY_STORAGE_UNAVAILABLE' });
  assert.deepEqual(calls, []);
  await missing(f.marker);
  await missing(path.join(f.root, 'safety'));
});
test('journal initialization failure closes an acquired keyring and retains enrollment', async t => {
  const f = await fixture(t); const calls = [];
  const api = loadModule(fakeModules(calls, { journalOpen: async () => { throw new Error('synthetic private failure'); } }));
  await assert.rejects(f.open(api), { code: 'SAFETY_RECOVERY_REQUIRED' });
  assert.deepEqual(calls, ['keyring.open', 'journal.open', 'keyring.close']);
  assert.ok(await fs.lstat(f.marker));
});

test('corrupt journal cannot be reset and opening failure releases the acquired keyring', async t => {
  const f = await fixture(t); const first = await f.open(); await first.close();
  const log = path.join(f.root, 'safety/ai-journal/events.log');
  const keyFile = path.join(f.root, 'safety/purpose-keyring/purpose-keyring.wrapped');
  const keyHash = sha(await fs.readFile(keyFile));
  const bytes = await fs.readFile(log); bytes[bytes.length - 1] ^= 1; await fs.writeFile(log, bytes);
  await assert.rejects(f.open(), { code: 'SAFETY_RECOVERY_REQUIRED' });
  assert.deepEqual(await fs.readFile(log), bytes); assert.equal(sha(await fs.readFile(keyFile)), keyHash);
  await missing(path.join(f.root, 'safety/purpose-keyring/owner.lock'));
});
for (const lock of ['purpose-keyring/owner.lock', 'ai-journal/writer.lock']) {
  test(`stale ${lock} is preserved and never stolen`, async t => {
    const f = await fixture(t); const first = await f.open(); await first.close();
    const file = path.join(f.root, 'safety', lock); const bytes = Buffer.from('synthetic stale owner');
    await fs.writeFile(file, bytes, { mode: 0o600 });
    await assert.rejects(f.open(), { code: 'SAFETY_RECOVERY_REQUIRED' });
    assert.deepEqual(await fs.readFile(file), bytes);
    if (lock.startsWith('ai-journal')) await missing(path.join(f.root, 'safety/purpose-keyring/owner.lock'));
  });
}
test('a concurrent lifecycle cannot initialize again or steal a live owner', async t => {
  const f = await fixture(t); const first = await f.open();
  await assert.rejects(f.open(), { code: 'SAFETY_RECOVERY_REQUIRED' });
  assertPrivateStatus(await first.latch());
});

test('canonical parent aliases reopen the same B while a final userData symlink is rejected', async t => {
  const f = await fixture(t); const directory = path.join(f.root, 'private-data');
  await fs.mkdir(directory, { mode: 0o700 });
  const first = await f.open(lifecycle, { userData: directory }); await first.close();
  const parentAlias = path.join(f.root, 'alias'); await fs.symlink(f.root, parentAlias);
  const second = await f.open(lifecycle, { userData: path.join(parentAlias, 'private-data') });
  assertPrivateStatus(second.diagnostics()); await second.close();
  const finalAlias = path.join(f.root, 'final-alias'); await fs.symlink(directory, finalAlias);
  await assert.rejects(f.open(lifecycle, { userData: finalAlias }), { code: 'SAFETY_RECOVERY_REQUIRED' });
});
test('persisted minimum build above the running build blocks normal startup without resetting B', async t => {
  const f = await fixture(t); const first = await f.open(); await first.close();
  const options = { safetyRoot: path.join(f.root, 'safety'), restoreRoots: [path.join(f.root, 'data')],
    installationId: f.options.installationId, wrapper: lifecycle.createSafeStorageWrapper(f.safeStorage) };
  const keyring = await keyrings.openPurposeKeyring(options);
  const journal = await journals.openSafetyJournal({ ...options, runningBuild: '101', keyProvider: keyring,
    verifyCommittedReservation: async () => false, verifySettlement: async () => false, verifyActivation: async () => false });
  try {
    await journal.mergeRestore({ restoreId: crypto.randomUUID(), obligations: [],
      budgetDay: new Date().toISOString().slice(0, 10), minimumVersion: '101' });
  } finally { await journal.close(); await keyring.close(); }
  await assert.rejects(f.open(), { code: 'SAFETY_RECOVERY_REQUIRED' });
  assertPrivateStatus((await f.open(lifecycle, { runningBuild: '101' })).diagnostics());
});

test('all trusted verification callbacks reject; facade cannot reserve, settle, activate, or return keys', async t => {
  const f = await fixture(t); const calls = []; let options;
  const api = loadModule(fakeModules(calls, { journalOpen: async value => { options = value; } }));
  const handle = await f.open(api);
  for (const name of ['verifyCommittedReservation', 'verifySettlement', 'verifyActivation']) {
    assert.equal(await options[name]({ committed: true, verified: true, userApproved: true }), false);
  }
  for (const name of ['reserveAndPermit', 'settle', 'activate', 'snapshot', 'keyProvider', 'getMacKey', 'getBackupKey'])
    assert.equal(handle[name], undefined);
  assertPrivateStatus(await handle.latch());
});
for (const state of [{ pendingRestore: { private: 'unfinished' } }, { major: 2 }, { aiOff: false }, { recoveryOnly: true }]) {
  test(`unsafe journal diagnostics ${JSON.stringify(state)} close both handles before returning failure`, async t => {
    const f = await fixture(t); const calls = [];
    await assert.rejects(f.open(loadModule(fakeModules(calls, { state }))), { code: 'SAFETY_RECOVERY_REQUIRED' });
    assert.deepEqual(calls, ['keyring.open', 'journal.open', 'journal.close', 'keyring.close']);
  });
}
test('latch failures are sanitized, mark recovery-only, and still close journal before keyring', async t => {
  const f = await fixture(t); const calls = [];
  const handle = await f.open(loadModule(fakeModules(calls, { latch: async () => { throw new Error('/private/synthetic-key'); } })));
  await assert.rejects(handle.latch(), { code: 'SAFETY_RECOVERY_REQUIRED' });
  assertPrivateStatus(handle.diagnostics(), true);
  assert.throws(() => handle.denyAdmission(), { code: 'DESKTOP_AI_SAFETY_UNAVAILABLE', recoveryOnly: true });
  await handle.close(); assert.deepEqual(calls.slice(-2), ['journal.close', 'keyring.close']);
});
test('close is one shared promise, drains the journal first, and prevents new operations immediately', async t => {
  const f = await fixture(t); const calls = []; let release;
  const closing = new Promise(resolve => { release = resolve; });
  const handle = await f.open(loadModule(fakeModules(calls, { journalClose: () => closing })));
  const first = handle.close(); const second = handle.close(); assert.equal(first, second);
  assertPrivateStatus(handle.diagnostics(), true);
  await assert.rejects(handle.latch(), { code: 'SAFETY_RECOVERY_REQUIRED' });
  assert.equal(calls.includes('keyring.close'), false);
  release(); await first; assert.deepEqual(calls.slice(-2), ['journal.close', 'keyring.close']);
});
test('failed journal close still closes the keyring exactly once and returns no raw cause', async t => {
  const f = await fixture(t); const calls = [];
  const handle = await f.open(loadModule(fakeModules(calls, { journalClose: async () => { throw new Error('/private/key-copy'); } })));
  const first = handle.close(); await assert.rejects(first, { code: 'SAFETY_RECOVERY_REQUIRED' });
  assert.equal(handle.close(), first); assert.deepEqual(calls.slice(-2), ['journal.close', 'keyring.close']);
});

test('trusted backup factory receives only backup key copies and narrow journal hooks; public facade stays fixed', async t => {
  const f = await fixture(t); let context; let backupClosed = false;
  const handle = await f.open(lifecycle, { createBackupRuntime: async value => {
    context = value; return { async close() { backupClosed = true; } };
  } });
  assert.deepEqual(Object.keys(handle).sort(), ['close', 'denyAdmission', 'diagnostics', 'latch', 'recordAcceptedManifest', 'recordStartedBuild', 'sanctionRecoveryRollback', 'updateState']);
  assert.deepEqual(Object.keys(context).sort(), ['journal', 'keyProvider', 'readSafetyState']);
  assert.deepEqual(Object.keys(context.journal).sort(), ['completeMaintenance', 'sealMaintenance', 'snapshot']);
  assert.deepEqual(Object.keys(context.keyProvider).sort(), ['currentKeyId', 'getBackupKey']);
  assert.equal(Object.isFrozen(context), true); assert.equal(Object.isFrozen(context.keyProvider), true);
  await assert.rejects(context.keyProvider.currentKeyId('safety'), { code: 'SAFETY_RECOVERY_REQUIRED' });
  const id = await context.keyProvider.currentKeyId('backup'); const first = await context.keyProvider.getBackupKey(id);
  const second = await context.keyProvider.getBackupKey(id); assert.equal(first.length, 32); assert.notEqual(first, second);
  first.fill(0); assert.equal(second.equals(Buffer.alloc(32)), false); second.fill(0);
  const before = context.readSafetyState(); assert.equal(before.closing, false); assert.equal(before.aiOff, true);
  await handle.close(); assert.equal(backupClosed, true); assert.equal(context.readSafetyState().closing, true);
  await assert.rejects(context.keyProvider.getBackupKey(id), { code: 'PURPOSE_KEYRING_CLOSED' });
});
test('backup close drains before gateway/journal and keyring close and remains one shared promise', async t => {
  const f = await fixture(t); const calls = []; let finish;
  const drained = new Promise(resolve => { finish = resolve; });
  const handle = await f.open(loadModule(fakeModules(calls)), { createBackupRuntime: async () => ({
    async close() { calls.push('backup.close'); await drained; calls.push('backup.closed'); },
  }) });
  const closing = handle.close(); assert.equal(handle.close(), closing);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(calls.includes('backup.close'), true); assert.equal(calls.includes('journal.close'), false);
  assert.equal(calls.includes('keyring.close'), false); finish(); await closing;
  assert.deepEqual(calls.slice(-4), ['backup.close', 'backup.closed', 'journal.close', 'keyring.close']);
});
test('failed backup drain keeps journal and keys owned instead of closing resources beneath unfinished work', async t => {
  const f = await fixture(t); const calls = [];
  const handle = await f.open(loadModule(fakeModules(calls)), { createBackupRuntime: async () => ({
    async close() { calls.push('backup.close'); throw new Error('/private/synthetic unresolved work'); },
  }) });
  const closing = handle.close(); await assert.rejects(closing, { code: 'SAFETY_RECOVERY_REQUIRED' });
  assert.equal(handle.close(), closing); assert.equal(calls.includes('journal.close'), false); assert.equal(calls.includes('keyring.close'), false);
  assertPrivateStatus(handle.diagnostics(), true);
});
test('invalid backup factory output cleans construction handles and is never exposed publicly', async t => {
  const f = await fixture(t); const calls = [];
  await assert.rejects(f.open(loadModule(fakeModules(calls)), { createBackupRuntime: async () => ({ key: 'synthetic' }) }),
    { code: 'SAFETY_RECOVERY_REQUIRED' });
  assert.deepEqual(calls.slice(-2), ['journal.close', 'keyring.close']);
});
for (const change of [{ recoveryMode: true }, { recoveryMode: 'yes' }, { createBackupRuntime: true },
  { recoveryMode: true, createBackupRuntime: async () => ({ async close() {} }) }]) {
  test(`recovery cannot initialize absent B or use invalid factory options ${Object.keys(change).join(',')}`, async t => {
    const f = await fixture(t);
    await assert.rejects(f.open(lifecycle, change), { code: 'SAFETY_RECOVERY_REQUIRED' });
    assert.deepEqual(await fs.readdir(f.root), []);
  });
}
test('pending maintenance permits only trusted recovery factory and remains recovery-only after completion until reopen', async t => {
  const f = await fixture(t); let context;
  const options = {
    createGateway: async ({ openJournal, recoveryMode }) => {
      const j = await openJournal({ verifyCommittedReservation: async () => false, verifySettlement: async () => false,
        verifyActivation: async () => true, verifyMaintenanceSeal: async (_state, input) => ({ ...input, verified: true }),
        verifyMaintenanceCompletion: async (_state, input) => ({ ...input, verified: true }) });
      return { close: j.close, latchOffline: j.latch, diagnostics: () => ({ aiOff: j.snapshot().aiOff, recoveryOnly: recoveryMode }) };
    },
    createBackupRuntime: async value => { context = value; return { async close() {} }; },
  };
  const handle = await f.open(lifecycle, options);
  const metadata = { transactionId: crypto.randomUUID(), kind: 'RESTORE', payloadSha256: sha('synthetic archive'),
    pgProjectionDigest: sha('synthetic PG'), legacyLiabilityUnresolved: false, budgetDay: new Date().toISOString().slice(0, 10), minimumVersion: '1' };
  await context.journal.sealMaintenance(metadata); await handle.close();
  await assert.rejects(f.open(lifecycle, options), { code: 'SAFETY_RECOVERY_REQUIRED' });
  const recovery = await f.open(lifecycle, { ...options, recoveryMode: true });
  assertPrivateStatus(recovery.diagnostics(), true); assert.deepEqual(context.journal.snapshot().pendingMaintenance, metadata);
  await context.journal.completeMaintenance(metadata); assertPrivateStatus(recovery.diagnostics(), true);
  await recovery.close(); assertPrivateStatus((await f.open(lifecycle, options)).diagnostics(), false);
});

test('the optional native owner capability reaches both B writers and stays outside every public or backup facade', async t => {
  const f = await fixture(t); const calls = []; let keyOptions; let journalOptions; let backupContext;
  const ownerLocks = Object.freeze({ close() { throw new Error('Lifecycle must not close the main-owned provider'); } });
  const api = loadModule(fakeModules(calls, {
    keyringOpen: async value => { keyOptions = value; }, journalOpen: async value => { journalOptions = value; },
  }));
  const handle = await f.open(api, { ownerLocks, createBackupRuntime: async value => {
    backupContext = value; return { async close() { calls.push('backup.close'); } };
  } });
  assert.equal(keyOptions.ownerLocks, ownerLocks); assert.equal(journalOptions.ownerLocks, ownerLocks);
  assert.equal(journalOptions.recoveryMode, false);
  assert.equal(handle.ownerLocks, undefined); assert.equal(backupContext.ownerLocks, undefined);
  assert.deepEqual(Object.keys(handle).sort(), ['close', 'denyAdmission', 'diagnostics', 'latch', 'recordAcceptedManifest', 'recordStartedBuild', 'sanctionRecoveryRollback', 'updateState']);
  assert.deepEqual(Object.keys(backupContext.keyProvider).sort(), ['currentKeyId', 'getBackupKey']);
  await handle.close(); assert.deepEqual(calls.slice(-3), ['backup.close', 'journal.close', 'keyring.close']);
});

test('legacy lifecycle omits the optional native capability rather than creating or claiming a native lease', async t => {
  const f = await fixture(t); const calls = []; const received = [];
  await f.open(loadModule(fakeModules(calls, { keyringOpen: async value => { received.push(value); },
    journalOpen: async value => { received.push(value); } })));
  assert.equal(received.length, 2);
  for (const options of received) assert.equal(Object.hasOwn(options, 'ownerLocks'), false);
});

test('a forged native provider cannot adopt existing purpose keys or rewrite enrollment during recovery', async t => {
  const f = await fixture(t); const first = await f.open(); await first.close();
  const keyFile = path.join(f.root, 'safety/purpose-keyring/purpose-keyring.wrapped');
  const beforeKey = await fs.readFile(keyFile); const beforeMarker = await fs.readFile(f.marker);
  const forged = Object.freeze({ acquire: async () => ({ isHeld: () => true, check: async () => {}, release: async () => {} }) });
  await assert.rejects(f.open(lifecycle, { ownerLocks: forged, recoveryMode: true,
    createBackupRuntime: async () => ({ async close() {} }) }), { code: 'SAFETY_RECOVERY_REQUIRED' });
  assert.deepEqual(await fs.readFile(keyFile), beforeKey); assert.deepEqual(await fs.readFile(f.marker), beforeMarker);
  await missing(path.join(f.root, 'safety/purpose-keyring/owner.lock'));
});

test('restricted lifecycle forwards recovery mode to gateway and journal while normal admission stays denied', async t => {
  const f = await fixture(t); const first = await f.open(); await first.close();
  const calls = []; let journalOptions; let gatewayOptions; let backupContext;
  const pending = { transactionId: crypto.randomUUID(), kind: 'RESTORE' };
  const api = loadModule(fakeModules(calls, { state: { pendingMaintenance: pending },
    journalOpen: async value => { journalOptions = value; } }));
  const handle = await f.open(api, { recoveryMode: true,
    createGateway: async value => {
      gatewayOptions = value;
      const journal = await value.openJournal({ verifyCommittedReservation: async () => false,
        verifySettlement: async () => false, verifyActivation: async () => false });
      return { close: journal.close, latchOffline: journal.latch, diagnostics: () => ({ aiOff: true, recoveryOnly: true }) };
    },
    createBackupRuntime: async value => { backupContext = value; return { async close() {} }; },
  });
  assert.equal(gatewayOptions.recoveryMode, true); assert.equal(journalOptions.recoveryMode, true);
  assertPrivateStatus(handle.diagnostics(), true); assertPrivateStatus(await handle.latch('RESTART_RECONCILIATION'), true);
  assert.throws(() => handle.denyAdmission(), { code: 'DESKTOP_AI_SAFETY_UNAVAILABLE', recoveryOnly: true });
  assert.equal(backupContext.readSafetyState().recoveryOnly, true);
  assert.deepEqual(backupContext.journal.snapshot().pendingMaintenance, pending);
  assert.equal(handle.recover, undefined); assert.equal(handle.openJournal, undefined);
});

for (const state of [{ aiOff: false }, { recoveryOnly: true }, { minimumVersion: '101' }, { major: 2 }]) {
  test(`recovery mode never overrides unsafe persisted B state ${JSON.stringify(state)}`, async t => {
    const f = await fixture(t); const first = await f.open(); await first.close(); const calls = [];
    const before = await fs.readFile(f.marker); let factories = 0;
    await assert.rejects(f.open(loadModule(fakeModules(calls, { state })), { recoveryMode: true,
      createBackupRuntime: async () => { factories++; return { async close() {} }; } }), { code: 'SAFETY_RECOVERY_REQUIRED' });
    assert.equal(factories, 0); assert.deepEqual(calls.slice(-2), ['journal.close', 'keyring.close']);
    assert.deepEqual(await fs.readFile(f.marker), before);
  });
}

test('a failed recovery factory closes construction handles and preserves the interrupted evidence', async t => {
  const f = await fixture(t); const first = await f.open(); await first.close();
  const pending = path.join(f.root, 'backup-maintenance'); await fs.mkdir(pending, { mode: 0o700 });
  const record = path.join(pending, 'synthetic-preserved'); await fs.writeFile(record, 'preserved', { mode: 0o600 });
  const calls = []; const before = await fs.readFile(f.marker);
  await assert.rejects(f.open(loadModule(fakeModules(calls, { state: { pendingMaintenance: { kind: 'RESTORE' } } })),
    { recoveryMode: true, createBackupRuntime: async () => { throw new Error('/private/synthetic-checkpoint'); } }), error => {
    assert.equal(error.code, 'SAFETY_RECOVERY_REQUIRED'); assert.equal(error.message.includes('/private/'), false); return true;
  });
  assert.deepEqual(calls.slice(-2), ['journal.close', 'keyring.close']);
  assert.deepEqual(await fs.readFile(f.marker), before); assert.equal(await fs.readFile(record, 'utf8'), 'preserved');
});
