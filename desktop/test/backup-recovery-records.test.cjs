'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs/promises');
const { constants } = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { createBackupRecoveryRecords, BackupRecoveryRecordsError } = require('../src/backup-recovery-records.cjs');
const { initializePurposeKeyring, openPurposeKeyring } = require('../src/purpose-keyring.cjs');

const TX = '550e8400-e29b-41d4-a716-446655440000';
const NEXT = '550e8400-e29b-41d4-a716-446655440001';
const KEY = 'a'.repeat(32);
const NEXT_KEY = 'b'.repeat(32);
const INPUT = { version: 1, mergeInputs: [{ restoreId: TX, obligations: [{ requestId: NEXT, floorMicroUsd: '9007199254740993' }],
  budgetDay: '2026-10-03', minimumVersion: '3' }], databaseOid: '16401', sourceIdentity: { device: '99', inode: '123' },
  text: 'synthetic private recovery sentinel\n한글\u0000😀', empty: '', nil: null, decimal: 0.125 };
const RECEIPT = { version: 1, transactionId: TX, position: { sequence: '12', hash: 'a'.repeat(64) } };
const hash = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };

async function fixture(t, overrides = {}, initialize = true) {
  const parent = await fs.mkdtemp(path.join(await fs.realpath(os.tmpdir()), 'ci-backup-recovery-records-')); await fs.chmod(parent, 0o700);
  const root = path.join(parent, 'backup-maintenance'); const issued = []; const retained = new Map([[KEY, Buffer.alloc(32, 93)]]);
  let currentId = KEY; let verify = async () => true; const handles = [];
  const keyProvider = { async currentKeyId(purpose) { assert.equal(purpose, 'backup'); return currentId; }, async getBackupKey(id) {
    if (!retained.has(id)) throw new Error('synthetic-secret-path injected-secret');
    const key = Buffer.from(retained.get(id)); issued.push(key); return key;
  } };
  const options = { root, installationId: 'recovery_test-installation', runningBuild: '3', keyProvider,
    verifyCompletion: (...args) => verify(...args), ...overrides };
  let records;
  t.after(async () => { for (const handle of handles) await handle.close().catch(() => {}); await fs.rm(parent, { recursive: true, force: true }); });
  async function open(change = {}) { const handle = await createBackupRecoveryRecords({ ...options, ...change }); handles.push(handle); records = handle; return handle; }
  if (initialize) await open({ initialize: true });
  return { parent, root, options, issued, retained, get records() { return records; }, open,
    async reopen(change) { await records?.close(); return open(change); },
    async begin(input = INPUT, kind = 'RESTORE', transactionId = TX) { return records.begin({ transactionId, kind, input }); },
    async complete(receipt = RECEIPT, transactionId = TX) { return records.complete({ transactionId, receipt }); },
    setVerify(value) { verify = value; }, rotate() { retained.set(NEXT_KEY, Buffer.alloc(32, 94)); currentId = NEXT_KEY; },
  };
}
async function rejects(promise, code) {
  await assert.rejects(promise, error => { assert.ok(error instanceof BackupRecoveryRecordsError);
    if (code) assert.equal(error.code, code); assert.equal(error.cause, undefined);
    assert.doesNotMatch(String(error), /synthetic-secret-path|injected-secret|private recovery sentinel/); return true; });
}
function keysCleared(f) { assert.ok(f.issued.length); for (const bytes of f.issued) assert.equal(bytes.every(byte => byte === 0), true); }
async function disk(root) {
  const result = [];
  for (const name of (await fs.readdir(root)).sort()) {
    const file = path.join(root, name); const stat = await fs.lstat(file, { bigint: true });
    result.push({ name, hash: stat.isFile() ? hash(await fs.readFile(file)) : null, ino: String(stat.ino), dev: String(stat.dev),
      size: String(stat.size), mode: String(stat.mode), nlink: String(stat.nlink), mtime: String(stat.mtimeNs), ctime: String(stat.ctimeNs) });
  }
  const stat = await fs.stat(root, { bigint: true }); return { files: result, mtime: String(stat.mtimeNs), ctime: String(stat.ctimeNs) };
}
function parseEnvelope(bytes) { const size = bytes.readUInt32BE(8); return { header: JSON.parse(bytes.subarray(12, 12 + size)), ciphertext: bytes.subarray(12 + size) }; }
function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  return value && typeof value === 'object' ? `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}` : JSON.stringify(value);
}
async function mutateHeader(file, change) {
  const bytes = await fs.readFile(file); const { header, ciphertext } = parseEnvelope(bytes); change(header);
  const encoded = Buffer.from(canonical(header)); const prefix = Buffer.from(bytes.subarray(0, 12)); prefix.writeUInt32BE(encoded.length, 8);
  await fs.writeFile(file, Buffer.concat([prefix, encoded, ciphertext]));
}
async function authenticatedMutation(file, f, change) {
  const bytes = await fs.readFile(file); const { header, ciphertext } = parseEnvelope(bytes); const key = f.retained.get(header.core.keyId);
  const wrapAad = () => Buffer.from(`CI-RECOVERY-DEK-1\0${canonical(header.core)}`);
  const dataAad = () => Buffer.from(`CI-RECOVERY-DATA-1\0${canonical({ core: header.core, wrappedDek: header.wrappedDek })}`);
  const decrypt = (value, secret, nonce, tag, aad) => { const cipher = crypto.createDecipheriv('aes-256-gcm', secret, Buffer.from(nonce, 'base64'));
    cipher.setAAD(aad); cipher.setAuthTag(Buffer.from(tag, 'base64')); return Buffer.concat([cipher.update(value), cipher.final()]); };
  const encrypt = (value, secret, aad) => { const nonce = crypto.randomBytes(12); const cipher = crypto.createCipheriv('aes-256-gcm', secret, nonce);
    cipher.setAAD(aad); return { nonce: nonce.toString('base64'), ciphertext: Buffer.concat([cipher.update(value), cipher.final()]), tag: cipher.getAuthTag().toString('base64') }; };
  const dek = decrypt(Buffer.from(header.wrappedDek.ciphertext, 'base64'), key, header.wrappedDek.nonce, header.wrappedDek.tag, wrapAad());
  const plain = decrypt(ciphertext, dek, header.nonce, header.tag, dataAad()); let replacement;
  try {
    const parsed = JSON.parse(plain); const raw = change(parsed); replacement = Buffer.from(typeof raw === 'string' ? raw : canonical(parsed));
    header.core.plainBytes = replacement.length; header.core.plainSha256 = hash(replacement);
    const wrapped = encrypt(dek, key, wrapAad()); header.wrappedDek = { ...wrapped, ciphertext: wrapped.ciphertext.toString('base64') };
    const encrypted = encrypt(replacement, dek, dataAad()); header.nonce = encrypted.nonce; header.tag = encrypted.tag;
    const encoded = Buffer.from(canonical(header)); const prefix = Buffer.from(bytes.subarray(0, 12)); prefix.writeUInt32BE(encoded.length, 8);
    await fs.writeFile(file, Buffer.concat([prefix, encoded, encrypted.ciphertext]));
  } finally { dek.fill(0); plain.fill(0); replacement?.fill(0); }
}
function openFault(t, predicate, error = new Error('injected-secret')) {
  const original = fs.open; let fired = false;
  t.mock.method(fs, 'open', async function(file, flags, mode) {
    if (!fired && predicate(String(file), flags)) { fired = true; throw error; }
    return original.call(fs, file, flags, mode);
  }); return () => assert.equal(fired, true);
}

test('strict normalized input survives encrypted phases, completed history, restart, and a second transaction', async t => {
  const f = await fixture(t); assert.equal((await f.records.read()).active, null);
  const first = await f.begin(); assert.deepEqual(first.active.input, INPUT); assert.equal(first.active.phase, 'PREPARED');
  assert.equal(first.active.markerPresent, true); assert.equal(Object.isFrozen(first.active.input.mergeInputs[0]), true);
  for (const phase of ['MERGED', 'SEALED', 'STAGED', 'DATABASE_SWAPPED', 'SOURCES_SWAPPED', 'SOURCES_SWAPPED', 'MERGED']) {
    await f.records.append({ transactionId: TX, phase, data: { version: 1, phase, verification: 'root-owned' } });
  }
  f.setVerify(async (snapshot, argument) => { assert.equal(snapshot.active.transactionId, TX); assert.deepEqual(argument.receipt, RECEIPT);
    assert.equal(Object.isFrozen(snapshot), true); assert.equal(Object.isFrozen(argument.receipt), true); return true; });
  const completed = await f.complete(); assert.equal(completed.active, null); assert.equal(completed.completed.length, 1);
  assert.deepEqual(completed.completed[0].receipt, RECEIPT); assert.equal(completed.head.sequence, 9);
  const before = await disk(f.root); await f.reopen(); assert.deepEqual(await f.records.read(), completed); assert.deepEqual(await disk(f.root), before);
  const second = await f.begin({ untouched: ['notes', null, ''] }, 'BACKUP', NEXT);
  assert.equal(second.active.kind, 'BACKUP'); assert.equal(second.completed.length, 1); keysCleared(f);
});

test('HEALTH_VERIFIED persists exact main evidence across read-only reopen before separate completion', async t => {
  const f = await fixture(t); await f.begin();
  const data = { version: 1, backendStatus: 'DRAINED', startupAdmissionBlocked: true };
  const verified = await f.records.append({ transactionId: TX, phase: 'HEALTH_VERIFIED', data });
  assert.equal(verified.active.phase, 'HEALTH_VERIFIED'); assert.equal(verified.head.sequence, 2);
  assert.equal(verified.active.completionReceiptPresent, false); assert.deepEqual(verified.active.records.at(-1).data, data);
  const before = await disk(f.root); await f.reopen(); assert.deepEqual(await f.records.read(), verified); assert.deepEqual(await disk(f.root), before);
  f.setVerify(async snapshot => { assert.equal(snapshot.active.phase, 'HEALTH_VERIFIED'); return false; });
  await rejects(f.complete(), 'BACKUP_RECOVERY_COMPLETION_UNVERIFIED'); assert.deepEqual(await disk(f.root), before);
  f.setVerify(async () => true); const completed = await f.complete(); assert.equal(completed.active, null); assert.equal(completed.head.sequence, 3);
  keysCleared(f);
});

test('plaintext, installation text, and raw wrapping key never appear in files; each record has an independent DEK', async t => {
  const f = await fixture(t); await f.begin(); await f.records.append({ transactionId: TX, phase: 'MERGED', data: INPUT });
  const wrapped = new Set(); const nonces = new Set();
  for (const name of await fs.readdir(f.root)) {
    const bytes = await fs.readFile(path.join(f.root, name)); assert.equal(bytes.includes('private recovery sentinel'), false);
    assert.equal(bytes.includes(f.options.installationId), false); assert.equal(bytes.includes(f.retained.get(KEY)), false);
    const envelope = parseEnvelope(bytes); assert.equal(wrapped.has(envelope.header.wrappedDek.ciphertext), false); wrapped.add(envelope.header.wrappedDek.ciphertext);
    assert.equal(nonces.has(envelope.header.wrappedDek.nonce), false); nonces.add(envelope.header.wrappedDek.nonce);
    const stat = await fs.stat(path.join(f.root, name)); assert.equal(stat.nlink, 1); assert.equal(stat.mode & 0o7777, 0o600);
  }
  keysCleared(f); assert.equal((await fs.stat(f.root)).mode & 0o7777, 0o700);
});

test('input is captured before queueing and output mutation cannot change durable evidence', async t => {
  const f = await fixture(t); const input = structuredClone(INPUT); const operation = f.begin(input);
  input.mergeInputs[0].obligations[0].floorMicroUsd = '0'; input.text = 'mutated';
  const state = await operation; assert.deepEqual(state.active.input, INPUT);
  assert.throws(() => { state.active.input.text = 'mutated'; }, TypeError);
  assert.deepEqual((await f.records.read()).active.input, INPUT);
});

test('read and idempotent close do not alter pending or completed roots', async t => {
  const f = await fixture(t); await f.begin(); const before = await disk(f.root);
  await f.records.read(); await f.records.read(); const a = f.records.close(); assert.equal(f.records.close(), a); await a;
  assert.deepEqual(await disk(f.root), before); await f.open(); assert.deepEqual(await disk(f.root), before);
  await f.complete(); const after = await disk(f.root); await f.records.close(); await f.open(); await f.records.read(); assert.deepEqual(await disk(f.root), after);
});

test('missing root is never implicitly initialized, and existing empty or valid roots cannot be initialized', async t => {
  const f = await fixture(t, {}, false);
  await rejects(f.open(), 'BACKUP_RECOVERY_MISSING'); await assert.rejects(fs.stat(f.root), { code: 'ENOENT' });
  await fs.mkdir(f.root, { mode: 0o700 }); const empty = await disk(f.root);
  await rejects(f.open(), 'BACKUP_RECOVERY_MISSING'); await rejects(f.open({ initialize: true }), 'BACKUP_RECOVERY_EXISTS'); assert.deepEqual(await disk(f.root), empty);
});

test('exclusive ownership uses no persistent lock and a second handle requires the first to close', async t => {
  const f = await fixture(t); await rejects(f.open(), 'BACKUP_RECOVERY_BUSY');
  assert.deepEqual(await fs.readdir(f.root), ['enrollment.enc']); await f.reopen(); assert.equal((await f.records.read()).active, null);
  await f.records.close(); await rejects(f.records.read(), 'BACKUP_RECOVERY_CLOSED');
});

test('same-tick begins serialize and cannot create duplicate transactions; appends retain caller order', async t => {
  const f = await fixture(t); const outcomes = await Promise.allSettled([f.begin(), f.begin(), f.begin(INPUT, 'BACKUP', NEXT)]);
  assert.equal(outcomes.filter(value => value.status === 'fulfilled').length, 1);
  for (const result of outcomes.filter(value => value.status === 'rejected')) assert.equal(result.reason.code, 'BACKUP_RECOVERY_STATE');
  await Promise.all([1, 2, 3].map(index => f.records.append({ transactionId: TX, phase: 'MERGED', data: { index } })));
  assert.deepEqual((await f.records.read()).active.records.slice(1).map(record => record.data.index), [1, 2, 3]);
});

test('close rejects new work and drains an already admitted completion before releasing ownership', async t => {
  const f = await fixture(t); await f.begin(); const entered = deferred(); const release = deferred();
  f.setVerify(async () => { entered.resolve(); await release.promise; return true; });
  const completing = f.complete(); await entered.promise; const closing = f.records.close(); let closed = false; closing.then(() => { closed = true; });
  await rejects(f.records.read(), 'BACKUP_RECOVERY_CLOSED'); await rejects(f.open(), 'BACKUP_RECOVERY_BUSY');
  await Promise.resolve(); assert.equal(closed, false); release.resolve(); await completing; await closing;
  await f.open(); assert.equal((await f.records.read()).active, null);
});

test('pending operation capacity is bounded while completion waits on trusted authority', async t => {
  const f = await fixture(t); await f.begin(); const entered = deferred(); const release = deferred();
  f.setVerify(async () => { entered.resolve(); await release.promise; return false; });
  const completing = f.complete().catch(error => error); await entered.promise;
  const reads = Array.from({ length: 15 }, () => f.records.read()); await rejects(f.records.read(), 'BACKUP_RECOVERY_BUSY');
  release.resolve(); assert.equal((await completing).code, 'BACKUP_RECOVERY_COMPLETION_UNVERIFIED'); await Promise.all(reads);
});

for (const [name, input] of [
  ['NaN', NaN], ['infinity', Infinity], ['negative zero', -0], ['unsafe integer', 9007199254740992], ['undefined', undefined],
  ['bigint', 1n], ['function', () => 1], ['Date', new Date(0)], ['Buffer', Buffer.from('x')], ['Map', new Map()],
  ['unpaired high surrogate', '\ud800'], ['unpaired low surrogate', '\udfff'], ['sparse array', Array(1)],
  ['symbol value', Symbol('x')], ['symbol property', { [Symbol('x')]: 1 }],
  ['custom prototype', Object.assign(Object.create({ inherited: 1 }), { value: 1 })],
  ['nonenumerable data', Object.defineProperty({}, 'hidden', { value: 1 })],
  ['array extra property', Object.assign([1], { extra: 2 })],
  ['array custom prototype', Object.setPrototypeOf([1], null)],
]) {
  test(`rejects ${name} without creating a record`, async t => {
    const f = await fixture(t); const before = await disk(f.root);
    await rejects(f.records.begin({ transactionId: TX, kind: 'RESTORE', input }), 'BACKUP_RECOVERY_ARGUMENT'); assert.deepEqual(await disk(f.root), before);
  });
}

test('accessors and proxies are rejected without invoking traps or getters, including outer request objects', async t => {
  const f = await fixture(t); let calls = 0;
  const getter = Object.defineProperty({}, 'secret', { enumerable: true, get() { calls += 1; throw new Error('injected-secret'); } });
  await rejects(f.begin(getter), 'BACKUP_RECOVERY_ARGUMENT');
  const proxy = new Proxy({}, { ownKeys() { calls += 1; throw new Error('injected-secret'); } });
  await rejects(f.begin(proxy), 'BACKUP_RECOVERY_ARGUMENT');
  await rejects(f.records.begin({ transactionId: TX, kind: 'RESTORE', get input() { calls += 1; return {}; } }), 'BACKUP_RECOVERY_ARGUMENT');
  assert.equal(calls, 0);
});

test('cycles, nesting and a greater-than-64MiB string fail without disk changes', async t => {
  const f = await fixture(t); const before = await disk(f.root); const cycle = {}; cycle.self = cycle;
  await rejects(f.begin(cycle), 'BACKUP_RECOVERY_ARGUMENT'); let nested = null; for (let i = 0; i < 66; i += 1) nested = { child: nested };
  await rejects(f.begin(nested), 'BACKUP_RECOVERY_CAPACITY');
  await rejects(f.begin('x'.repeat(64 * 1024 * 1024 + 1)), 'BACKUP_RECOVERY_CAPACITY'); assert.deepEqual(await disk(f.root), before);
});

test('the 64MiB bound includes retained plaintext history, and a large valid input can still complete', async t => {
  const f = await fixture(t); const input = { text: 'x'.repeat(33 * 1024 * 1024) }; await f.begin(input);
  const before = await disk(f.root);
  await rejects(f.records.append({ transactionId: TX, phase: 'MERGED', data: input }), 'BACKUP_RECOVERY_CAPACITY');
  assert.deepEqual(await disk(f.root), before); const result = await f.complete(); assert.equal(result.active, null);
  await f.reopen(); assert.equal((await f.records.read()).completed.length, 1); keysCleared(f);
});

test('null-prototype objects and __proto__ own data preserve values without changing prototypes', async t => {
  const f = await fixture(t); const input = Object.assign(Object.create(null), JSON.parse('{"__proto__":{"value":"kept"},"constructor":"text"}'));
  const state = await f.begin(input); assert.equal(Object.getPrototypeOf(state.active.input), Object.prototype);
  assert.equal(Object.hasOwn(state.active.input, '__proto__'), true); assert.deepEqual(state.active.input.__proto__, { value: 'kept' });
  assert.equal({}.value, undefined);
});

for (const change of [
  { transactionId: `${TX}\n` }, { transactionId: TX.toUpperCase() }, { transactionId: '../escaped' }, { kind: 'restore' },
  { kind: 'DELETE' }, { extra: true },
]) {
  test(`begin rejects exact-contract mutation ${JSON.stringify(change)}`, async t => {
    const f = await fixture(t); await rejects(f.records.begin({ transactionId: TX, kind: 'RESTORE', input: {}, ...change }), 'BACKUP_RECOVERY_ARGUMENT');
    assert.equal((await f.records.read()).head.sequence, 0);
  });
}

for (const phase of ['PREPARED', 'COMPLETED', 'MERGED\n', 'mergED', 'UNKNOWN']) {
  test(`append cannot write unapproved phase ${JSON.stringify(phase)}`, async t => {
    const f = await fixture(t); await f.begin(); await rejects(f.records.append({ transactionId: TX, phase, data: {} }), 'BACKUP_RECOVERY_ARGUMENT');
    assert.equal((await f.records.read()).head.sequence, 1);
  });
}

test('transaction mismatch, reuse, and appending after rollback/completion are rejected', async t => {
  const f = await fixture(t); await f.begin();
  await rejects(f.records.append({ transactionId: NEXT, phase: 'MERGED', data: {} }), 'BACKUP_RECOVERY_STATE');
  await rejects(f.complete(RECEIPT, NEXT), 'BACKUP_RECOVERY_STATE');
  await f.records.append({ transactionId: TX, phase: 'ROLLED_BACK', data: { reason: 'authority checked old A' } });
  await rejects(f.records.append({ transactionId: TX, phase: 'STAGED', data: {} }), 'BACKUP_RECOVERY_STATE');
  await f.complete(); await rejects(f.begin(), 'BACKUP_RECOVERY_STATE');
  await rejects(f.records.append({ transactionId: TX, phase: 'MERGED', data: {} }), 'BACKUP_RECOVERY_STATE');
});

for (const verifier of [undefined, async () => false, async () => ({ verified: true }), async () => { throw new Error('injected-secret'); }]) {
  test(`completion rejects a missing, false, nonboolean, or throwing authority (${String(verifier)})`, async t => {
    const f = await fixture(t, { verifyCompletion: verifier }); await f.begin(); const before = await disk(f.root);
    await rejects(f.complete(), 'BACKUP_RECOVERY_COMPLETION_UNVERIFIED'); assert.deepEqual(await disk(f.root), before);
    assert.equal((await f.records.read()).active.phase, 'PREPARED');
  });
}

test('completion rechecks disk after authority callback and never accepts its stale decision', async t => {
  const f = await fixture(t); await f.begin();
  f.setVerify(async () => { await fs.appendFile(path.join(f.root, 'record-00000001.enc'), Buffer.from([0])); return true; });
  await rejects(f.complete(), 'BACKUP_RECOVERY_INVALID'); assert.equal((await fs.readdir(f.root)).includes('receipt-00000002.enc'), false);
});

test('an old backup key remains usable after rotation; key bytes are caller-owned and cleared on all reads', async t => {
  const f = await fixture(t); await f.begin(); f.rotate(); await f.records.append({ transactionId: TX, phase: 'MERGED', data: {} });
  await f.reopen(); assert.deepEqual((await f.records.read()).active.input, INPUT); keysCleared(f);
  assert.equal(f.retained.get(KEY).every(byte => byte === 93), true); assert.equal(f.retained.get(NEXT_KEY).every(byte => byte === 94), true);
});

test('real purpose-keyring with synthetic wrapper decrypts recovery evidence after key rotation and reopen', async t => {
  const f = await fixture(t, {}, false); const wrapping = Buffer.alloc(32, 51); const issued = [];
  const wrapper = { async isAvailable() { return true; }, async wrap(bytes) {
    const nonce = crypto.randomBytes(12); const cipher = crypto.createCipheriv('aes-256-gcm', wrapping, nonce);
    return Buffer.concat([nonce, cipher.update(bytes), cipher.final(), cipher.getAuthTag()]);
  }, async unwrap(bytes) { const decipher = crypto.createDecipheriv('aes-256-gcm', wrapping, bytes.subarray(0, 12)); decipher.setAuthTag(bytes.subarray(-16));
    return Buffer.concat([decipher.update(bytes.subarray(12, -16)), decipher.final()]); } };
  const options = { safetyRoot: path.join(f.parent, 'safety'), restoreRoots: [path.join(f.parent, 'ordinary-A')], installationId: f.options.installationId, wrapper };
  let keyring = await initializePurposeKeyring(options); t.after(async () => keyring.close().catch(() => {}));
  const keyProvider = { currentKeyId: purpose => keyring.currentKeyId(purpose), async getBackupKey(id) { const value = await keyring.getBackupKey(id); issued.push(value); return value; } };
  await f.open({ keyProvider, initialize: true }); await f.begin(); await keyring.rotate('backup');
  await f.records.append({ transactionId: TX, phase: 'SEALED', data: {} }); await f.records.close(); await keyring.close(); keyring = await openPurposeKeyring(options);
  await f.open({ keyProvider }); assert.deepEqual((await f.records.read()).active.input, INPUT); await f.complete();
  assert.ok(issued.length); for (const value of issued) assert.equal(value.every(byte => byte === 0), true);
  await f.records.close(); await keyring.close();
});

test('missing, wrong-purpose, and malformed key copies reject; returned malformed buffers are cleared', async t => {
  const f = await fixture(t); await f.begin(); await f.records.close(); const before = await disk(f.root);
  for (const bytes of [Buffer.alloc(32, 7), Buffer.alloc(31, 8)]) {
    const keyProvider = { currentKeyId: async () => KEY, getBackupKey: async () => bytes };
    await rejects(f.open({ keyProvider }), bytes.length === 32 ? 'BACKUP_RECOVERY_INVALID' : 'BACKUP_RECOVERY_KEY_UNAVAILABLE');
    assert.equal(bytes.every(byte => byte === 0), true);
  }
  f.retained.delete(KEY); await rejects(f.open(), 'BACKUP_RECOVERY_KEY_UNAVAILABLE'); assert.deepEqual(await disk(f.root), before);
});

test('cross-installation evidence and a lower running build fail closed without file changes', async t => {
  const f = await fixture(t); await f.begin(); await f.records.close(); const before = await disk(f.root);
  await rejects(f.open({ installationId: 'other-installation' }), 'BACKUP_RECOVERY_INVALID');
  await rejects(f.open({ runningBuild: '2' }), 'BACKUP_RECOVERY_UNSUPPORTED'); assert.deepEqual(await disk(f.root), before);
});

for (const change of [
  { runningBuild: '03' }, { runningBuild: '3\n' }, { runningBuild: 3 }, { runningBuild: '9223372036854775808' },
  { installationId: 'value\n' }, { installationId: '' }, { initialize: 1 }, { verifyCompletion: true }, { unexpected: true },
]) {
  test(`factory rejects malformed exact options ${JSON.stringify(change)}`, async t => {
    const f = await fixture(t, {}, false); await rejects(f.open({ ...change, initialize: change.initialize ?? true }), 'BACKUP_RECOVERY_ARGUMENT');
    await assert.rejects(fs.stat(f.root), { code: 'ENOENT' });
  });
}

test('factory captures trusted key and completion function references rather than later replacements', async t => {
  const f = await fixture(t); f.options.keyProvider.getBackupKey = async () => { throw new Error('injected-secret'); };
  f.options.verifyCompletion = async () => false; await f.begin(); await f.complete(); keysCleared(f);
});

for (const [name, mutate] of [
  ['wrong sequence', value => { value.sequence = 2; }], ['wrong previous hash', value => { value.previousHash = 'f'.repeat(64); }],
  ['invalid transaction', value => { value.transactionId = `${TX}\n`; }], ['invalid kind', value => { value.kind = 'OTHER'; }],
  ['unknown phase', value => { value.phase = 'OTHER'; }], ['missing PREPARED', value => { value.phase = 'MERGED'; }],
  ['extra property', value => { value.extra = true; }], ['unknown body version', value => { value.version = 2; }],
  ['duplicate JSON keys', () => '{"version":1,"version":1}'], ['noncanonical number', () => '{"number":1.0}'],
  ['noncanonical trailing JSON whitespace', value => `${canonical(value)}\n`],
]) {
  test(`fully authenticated malformed record rejects ${name}`, async t => {
    const f = await fixture(t); await f.begin(); await f.records.close(); await authenticatedMutation(path.join(f.root, 'record-00000001.enc'), f, mutate);
    const before = await disk(f.root); await rejects(f.open(), 'BACKUP_RECOVERY_INVALID'); assert.deepEqual(await disk(f.root), before);
  });
}

for (const [name, change] of [
  ['unknown version', h => { h.core.version = 2; }], ['identity hash', h => { h.core.identityHash = 'e'.repeat(64); }],
  ['key ID', h => { h.core.keyId = NEXT_KEY; }], ['root ID', h => { h.core.rootId = 'e'.repeat(32); }],
  ['role', h => { h.core.role = 'RECEIPT'; }], ['filename', h => { h.core.name = 'record-00000002.enc'; }],
  ['payload hash', h => { h.core.plainSha256 = 'e'.repeat(64); }], ['size', h => { h.core.plainBytes += 1; }],
  ['tag', h => { h.tag = Buffer.alloc(16).toString('base64'); }], ['wrap tag', h => { h.wrappedDek.tag = Buffer.alloc(16).toString('base64'); }],
  ['extra header field', h => { h.extra = 1; }], ['malformed base64', h => { h.nonce += '\n'; }],
]) {
  test(`authenticated header rejects ${name}`, async t => {
    const f = await fixture(t); await f.begin(); await f.records.close(); await mutateHeader(path.join(f.root, 'record-00000001.enc'), change);
    const before = await disk(f.root); await rejects(f.open()); assert.deepEqual(await disk(f.root), before); keysCleared(f);
  });
}

for (const corruption of ['truncated', 'trailing', 'ciphertext', 'header-whitespace', 'magic']) {
  test(`rejects ${corruption} ciphertext/framing without truncation or rewriting`, async t => {
    const f = await fixture(t); await f.begin(); await f.records.close(); const file = path.join(f.root, 'record-00000001.enc'); const bytes = await fs.readFile(file);
    let changed;
    if (corruption === 'truncated') changed = bytes.subarray(0, -1);
    else if (corruption === 'trailing') changed = Buffer.concat([bytes, Buffer.from([0])]);
    else if (corruption === 'ciphertext') { changed = Buffer.from(bytes); changed[changed.length - 1] ^= 1; }
    else if (corruption === 'magic') { changed = Buffer.from(bytes); changed[0] ^= 1; }
    else { const size = bytes.readUInt32BE(8); changed = Buffer.concat([bytes.subarray(0, 12 + size), Buffer.from(' '), bytes.subarray(12 + size)]); changed.writeUInt32BE(size + 1, 8); }
    await fs.writeFile(file, changed); const before = await disk(f.root); await rejects(f.open()); assert.deepEqual(await disk(f.root), before);
  });
}

for (const name of ['unknown', 'owner.lock', 'record-1.enc', 'record-00000000.enc', 'record-00000003.enc', 'record-00000001.enc\n', 'receipt-00000001.enc.bak']) {
  test(`unknown/gap/invalid-suffix file is rejected: ${JSON.stringify(name)}`, async t => {
    const f = await fixture(t); await f.begin(); await f.records.close(); await fs.copyFile(path.join(f.root, 'record-00000001.enc'), path.join(f.root, name));
    const before = await disk(f.root); await rejects(f.open(), 'BACKUP_RECOVERY_INVALID'); assert.deepEqual(await disk(f.root), before);
  });
}

test('reordered records and cross-root active marker replay cannot authenticate', async t => {
  const f = await fixture(t); await f.begin(); await f.records.append({ transactionId: TX, phase: 'MERGED', data: {} }); await f.records.close();
  const first = path.join(f.root, 'record-00000001.enc'); const second = path.join(f.root, 'record-00000002.enc');
  const a = await fs.readFile(first); const b = await fs.readFile(second); await fs.writeFile(first, b); await fs.writeFile(second, a); await rejects(f.open());
  const other = await fixture(t); await other.begin(); await other.records.close();
  await fs.copyFile(path.join(f.root, 'active.enc'), path.join(other.root, 'active.enc')); await rejects(other.open(), 'BACKUP_RECOVERY_INVALID');
});

test('missing enrollment, missing completion receipt, and active deletion cannot silently become fresh', async t => {
  const f = await fixture(t); await f.begin(); await f.complete(); await f.records.close();
  await fs.unlink(path.join(f.root, 'receipt-00000002.enc')); const before = await disk(f.root); await f.open();
  const state = await f.records.read(); assert.equal(state.active.phase, 'COMPLETED'); assert.equal(state.active.markerPresent, false);
  assert.equal(state.active.completionReceiptPresent, false); assert.deepEqual(await disk(f.root), before);
  await rejects(f.begin(INPUT, 'BACKUP', NEXT), 'BACKUP_RECOVERY_STATE');
  await f.records.close(); await fs.unlink(path.join(f.root, 'enrollment.enc')); await rejects(f.open(), 'BACKUP_RECOVERY_MISSING');
});

test('active-less pending evidence remains read-only on reopen and needs explicit same-transaction resume', async t => {
  const f = await fixture(t); await f.begin(); await f.records.close(); await fs.unlink(path.join(f.root, 'active.enc'));
  const before = await disk(f.root); await f.open(); const state = await f.records.read(); assert.equal(state.active.markerPresent, false);
  assert.deepEqual(state.active.input, INPUT); assert.deepEqual(await disk(f.root), before);
  await rejects(f.begin(INPUT, 'RESTORE', NEXT), 'BACKUP_RECOVERY_STATE');
  await rejects(f.records.append({ transactionId: NEXT, phase: 'MERGED', data: {} }), 'BACKUP_RECOVERY_STATE');
  const resumed = await f.records.append({ transactionId: TX, phase: 'MERGED', data: { checked: true } });
  assert.equal(resumed.active.markerPresent, true); assert.equal(resumed.head.sequence, 2);
});

for (const target of ['root', 'enrollment', 'record', 'active']) {
  test(`unsafe ${target} permissions reject instead of repairing`, async t => {
    const f = await fixture(t); await f.begin(); await f.records.close();
    const file = target === 'root' ? f.root : path.join(f.root, target === 'record' ? 'record-00000001.enc' : `${target}.enc`);
    await fs.chmod(file, target === 'root' ? 0o755 : 0o640); const before = await disk(f.root);
    await rejects(f.open(), 'BACKUP_RECOVERY_UNSAFE_PATH'); assert.deepEqual(await disk(f.root), before);
  });
}

test('symlink files, hardlinks, symlink roots, and noncanonical roots are rejected', async t => {
  const f = await fixture(t); await f.begin(); await f.records.close(); const original = path.join(f.root, 'active.enc');
  const saved = path.join(f.parent, 'saved.enc'); await fs.rename(original, saved); await fs.symlink(saved, original);
  await rejects(f.open(), 'BACKUP_RECOVERY_UNSAFE_PATH'); await fs.unlink(original); await fs.link(saved, original);
  await rejects(f.open(), 'BACKUP_RECOVERY_UNSAFE_PATH'); await fs.unlink(original); await fs.rename(saved, original);
  const alias = path.join(f.parent, 'alias'); await fs.symlink(f.root, alias);
  await rejects(f.open({ root: alias }), 'BACKUP_RECOVERY_UNSAFE_PATH');
  await rejects(f.open({ root: `${f.root}/../backup-maintenance` }), 'BACKUP_RECOVERY_ARGUMENT');
});

test('root or same-byte input inode replacement during a handle lifetime is rejected', async t => {
  const f = await fixture(t); await f.begin(); const file = path.join(f.root, 'record-00000001.enc'); const bytes = await fs.readFile(file);
  await fs.rename(file, path.join(f.parent, 'saved.enc')); await fs.writeFile(file, bytes, { mode: 0o600 });
  await rejects(f.records.read(), 'BACKUP_RECOVERY_INVALID'); await f.records.close(); await f.open();
  await fs.rename(f.root, path.join(f.parent, 'old-root')); await fs.mkdir(f.root, { mode: 0o700 });
  await rejects(f.records.read(), 'BACKUP_RECOVERY_UNSAFE_PATH');
});

test('a sparse oversized encrypted file is rejected before a whole-file allocation', async t => {
  const f = await fixture(t); await f.begin(); await f.records.close();
  const file = path.join(f.root, 'record-00000001.enc'); await fs.truncate(file, 64 * 1024 * 1024 + 4096 + 13);
  await rejects(f.open(), 'BACKUP_RECOVERY_CAPACITY'); assert.equal((await fs.stat(file)).size, 64 * 1024 * 1024 + 4096 + 13);
});

test('mutation after output fsync is rejected by authenticated readback and no ACK is issued', async t => {
  const f = await fixture(t); await f.begin(); const original = fs.open; let fired = false;
  t.mock.method(fs, 'open', async function(file, flags, mode) {
    const handle = await original.call(fs, file, flags, mode);
    if (!fired && String(file).endsWith('/record-00000002.enc') && (flags & constants.O_CREAT)) {
      const sync = handle.sync.bind(handle); handle.sync = async () => { await sync(); fired = true; await fs.appendFile(file, Buffer.from([0])); };
    } return handle;
  });
  await rejects(f.records.append({ transactionId: TX, phase: 'MERGED', data: {} }), 'BACKUP_RECOVERY_INVALID'); assert.equal(fired, true);
  t.mock.restoreAll(); await f.records.close(); const before = await disk(f.root); await rejects(f.open(), 'BACKUP_RECOVERY_INVALID'); assert.deepEqual(await disk(f.root), before);
});

test('random-key generation failure clears the already encoded plaintext buffer and publishes nothing', async t => {
  const f = await fixture(t); const before = await disk(f.root); const from = Buffer.from; const random = crypto.randomBytes; const observed = [];
  t.mock.method(Buffer, 'from', function(value, ...args) {
    const bytes = from.call(Buffer, value, ...args);
    if (typeof value === 'string' && value.includes('private recovery sentinel')) observed.push(bytes);
    return bytes;
  });
  t.mock.method(crypto, 'randomBytes', function(size, ...args) { if (size === 32) throw new Error('injected-secret'); return random.call(crypto, size, ...args); });
  await rejects(f.begin(), 'BACKUP_RECOVERY_IO'); t.mock.restoreAll();
  assert.ok(observed.length); for (const bytes of observed) assert.equal(bytes.every(byte => byte === 0), true);
  assert.deepEqual(await disk(f.root), before); keysCleared(f);
});

test('PREPARED survives active publication failure and reopen reads without modifying files', async t => {
  const f = await fixture(t); const fired = openFault(t, (file, flags) => file.endsWith('/active.enc') && (flags & constants.O_CREAT));
  await rejects(f.begin(), 'BACKUP_RECOVERY_IO'); fired(); t.mock.restoreAll(); await f.records.close(); const before = await disk(f.root);
  await f.open(); assert.deepEqual((await f.records.read()).active.input, INPUT); assert.equal((await f.records.read()).active.markerPresent, false);
  assert.deepEqual(await disk(f.root), before); await f.complete(); assert.equal((await f.records.read()).active, null);
});

for (const point of ['file-sync', 'directory-sync']) {
  test(`${point} failure gives no ACK; exact written evidence is available only after close/reopen`, async t => {
    const f = await fixture(t); await f.begin(); const original = fs.open; let fired = false;
    t.mock.method(fs, 'open', async function(file, flags, mode) {
      const handle = await original.call(fs, file, flags, mode);
      const matches = point === 'file-sync' ? String(file).endsWith('/record-00000002.enc') && (flags & constants.O_CREAT)
        : String(file) === f.root && (flags & constants.O_DIRECTORY);
      if (!fired && matches) { const sync = handle.sync.bind(handle); handle.sync = async () => { fired = true; await sync(); throw new Error('injected-secret'); }; }
      return handle;
    });
    await rejects(f.records.append({ transactionId: TX, phase: 'MERGED', data: { exact: 'kept' } }), 'BACKUP_RECOVERY_IO'); assert.equal(fired, true);
    await rejects(f.records.read(), 'BACKUP_RECOVERY_CLOSED'); t.mock.restoreAll(); await f.records.close(); const before = await disk(f.root);
    await f.open(); const state = await f.records.read(); assert.equal(state.active.phase, 'MERGED'); assert.deepEqual(state.active.records.at(-1).data, { exact: 'kept' });
    assert.deepEqual(await disk(f.root), before); keysCleared(f);
  });
}

test('torn ciphertext remains evidence and is never auto-truncated, deleted, or reinitialized', async t => {
  const f = await fixture(t); await f.begin(); const original = fs.open; let fired = false;
  t.mock.method(fs, 'open', async function(file, flags, mode) {
    const handle = await original.call(fs, file, flags, mode);
    if (!fired && String(file).endsWith('/record-00000002.enc') && (flags & constants.O_CREAT)) {
      const write = handle.write.bind(handle); handle.write = async (bytes, offset, length, position) => {
        fired = true; await write(bytes, offset, Math.floor(length / 2), position); throw new Error('injected-secret');
      };
    } return handle;
  });
  await rejects(f.records.append({ transactionId: TX, phase: 'MERGED', data: {} }), 'BACKUP_RECOVERY_IO'); assert.equal(fired, true);
  t.mock.restoreAll(); await f.records.close(); const before = await disk(f.root); await rejects(f.open());
  await rejects(f.open({ initialize: true }), 'BACKUP_RECOVERY_EXISTS'); assert.deepEqual(await disk(f.root), before);
});

test('receipt publication interruption resumes only the identical receipt after fixed authority revalidation', async t => {
  const f = await fixture(t); await f.begin(); const fired = openFault(t, (file, flags) => file.endsWith('/receipt-00000002.enc') && (flags & constants.O_CREAT));
  await rejects(f.complete(), 'BACKUP_RECOVERY_IO'); fired(); t.mock.restoreAll(); await f.reopen(); const state = await f.records.read();
  assert.equal(state.active.phase, 'COMPLETED'); assert.equal(state.active.completionReceiptPresent, false);
  await rejects(f.complete({ changed: true }), 'BACKUP_RECOVERY_STATE'); const before = await disk(f.root);
  f.setVerify(async () => false); await rejects(f.complete(), 'BACKUP_RECOVERY_COMPLETION_UNVERIFIED'); assert.deepEqual(await disk(f.root), before);
  f.setVerify(async () => true); const result = await f.complete(); assert.equal(result.active, null); assert.equal(result.head.sequence, 2);
});

test('active unlink interruption retains completed proof, and retry does not append a second completion', async t => {
  const f = await fixture(t); await f.begin(); const original = fs.unlink; let fired = false;
  t.mock.method(fs, 'unlink', async file => { if (String(file) === path.join(f.root, 'active.enc')) { fired = true; throw new Error('injected-secret'); } return original.call(fs, file); });
  await rejects(f.complete(), 'BACKUP_RECOVERY_IO'); assert.equal(fired, true); t.mock.restoreAll(); await f.reopen();
  const pending = await f.records.read(); assert.equal(pending.active.phase, 'COMPLETED'); assert.equal(pending.active.completionReceiptPresent, true);
  assert.equal((await f.complete()).head.sequence, 2); assert.equal((await f.records.read()).active, null);
});

test('post-unlink directory fsync failure has an uncertain ACK and preserves completed evidence', async t => {
  const f = await fixture(t); await f.begin(); const original = fs.open; let armed = false; let fired = false; const unlink = fs.unlink;
  t.mock.method(fs, 'unlink', async file => { const result = await unlink.call(fs, file); if (String(file).endsWith('/active.enc')) armed = true; return result; });
  t.mock.method(fs, 'open', async function(file, flags, mode) {
    const handle = await original.call(fs, file, flags, mode);
    if (armed && String(file) === f.root && (flags & constants.O_DIRECTORY)) { handle.sync = async () => { fired = true; throw new Error('injected-secret'); }; }
    return handle;
  });
  await rejects(f.complete(), 'BACKUP_RECOVERY_IO'); assert.equal(fired, true); t.mock.restoreAll(); await f.records.close(); const before = await disk(f.root);
  await f.open(); const state = await f.records.read(); assert.equal(state.active, null); assert.deepEqual(state.completed[0].receipt, RECEIPT);
  assert.deepEqual(await disk(f.root), before);
});

// Synthetic retention evidence only: no real database, checkpoint, filesystem deletion or B authority.
const RETENTION = { root: { dev: '1', ino: '2' }, checkpoint: { bytes: '123', sha256: 'c'.repeat(64) },
  databases: [{ slot: 'previous', oid: '16401' }], topLevel: [{ name: 'checkpoint.cibackup', type: 'file', dev: '1', ino: '3' }] };
const MANIFEST_SHA = hash(canonical(RETENTION));
const COLLECTION = { transactionId: TX, manifestSha256: MANIFEST_SHA };
const transactionIdAt = index => `550e8400-e29b-41d4-a716-${446655440000n + BigInt(index)}`;
async function completedHistory(f, count = 3, withRetention = true) {
  for (let i = 0; i < count; i += 1) {
    const transactionId = transactionIdAt(i);
    await f.begin({ ordinal: i, exact: INPUT }, 'RESTORE', transactionId);
    if (withRetention) await f.records.append({ transactionId, phase: 'RETENTION_READY', data: RETENTION });
    await f.complete({ ...RECEIPT, transactionId }, transactionId);
  }
}

test('transaction lookup returns all authenticated active/completed phases and exact receipts without writes', async t => {
  const f = await fixture(t); assert.equal(await f.records.readTransaction({ transactionId: TX }), null);
  await f.begin(); await f.records.append({ transactionId: TX, phase: 'RETENTION_READY', data: RETENTION });
  const pending = await f.records.readTransaction({ transactionId: TX });
  assert.equal(pending.status, 'ACTIVE'); assert.equal(pending.phase, 'RETENTION_READY'); assert.equal(pending.receipt, null);
  assert.equal(pending.markerPresent, true); assert.equal(pending.completionReceiptPresent, false);
  assert.deepEqual(pending.input, INPUT); assert.deepEqual(pending.records.map(record => record.phase), ['PREPARED', 'RETENTION_READY']);
  assert.deepEqual(pending.records[1].data, RETENTION);
  assert.throws(() => { pending.records[1].data.root.ino = 'changed'; }, TypeError);
  const completed = await f.complete(); await f.begin({ next: true }, 'BACKUP', NEXT);
  const before = await disk(f.root); const lookup = await f.records.readTransaction({ transactionId: TX });
  assert.equal(lookup.status, 'COMPLETED'); assert.equal(lookup.phase, 'COMPLETED'); assert.equal(lookup.markerPresent, false);
  assert.equal(lookup.completionReceiptPresent, true); assert.deepEqual(lookup.receipt, completed.completed[0].receipt);
  assert.deepEqual(lookup.input, INPUT); assert.equal(lookup.records.length, 3);
  await f.reopen(); assert.deepEqual(await f.records.readTransaction({ transactionId: TX }), lookup);
  assert.deepEqual(await disk(f.root), before); keysCleared(f);
});

test('transaction lookup distinguishes an unfinished completion from an authenticated completion receipt', async t => {
  const f = await fixture(t); await f.begin();
  const fired = openFault(t, (file, flags) => file.endsWith('/receipt-00000002.enc') && (flags & constants.O_CREAT));
  await rejects(f.complete(), 'BACKUP_RECOVERY_IO'); fired(); t.mock.restoreAll(); await f.reopen();
  const lookup = await f.records.readTransaction({ transactionId: TX });
  assert.equal(lookup.status, 'ACTIVE'); assert.equal(lookup.phase, 'COMPLETED'); assert.equal(lookup.receipt, null);
  assert.equal(lookup.completionReceiptPresent, false); assert.deepEqual(lookup.records.at(-1).data, RECEIPT);
  await f.complete(); assert.deepEqual((await f.records.readTransaction({ transactionId: TX })).receipt, RECEIPT);
});

test('transaction lookup retains markerless pending input and validates a private synchronously captured identifier', async t => {
  const f = await fixture(t); await f.begin(); await f.records.close(); await fs.unlink(path.join(f.root, 'active.enc')); await f.open();
  const argument = { transactionId: TX }; const promise = f.records.readTransaction(argument); argument.transactionId = NEXT;
  const lookup = await promise; assert.equal(lookup.status, 'ACTIVE'); assert.equal(lookup.markerPresent, false); assert.deepEqual(lookup.input, INPUT);
  let invoked = 0;
  for (const value of [null, {}, { transactionId: `${TX}\n` }, { transactionId: TX.toUpperCase() }, { transactionId: TX, extra: true },
    Object.defineProperty({}, 'transactionId', { enumerable: true, get() { invoked += 1; return TX; } }),
    new Proxy({ transactionId: TX }, { ownKeys() { invoked += 1; return ['transactionId']; } })]) {
    await rejects(f.records.readTransaction(value), 'BACKUP_RECOVERY_ARGUMENT');
  }
  assert.equal(invoked, 0); await f.records.close(); await rejects(f.records.readTransaction({ transactionId: TX }), 'BACKUP_RECOVERY_CLOSED');
});

test('RETENTION_READY captures each manifest privately without rewriting prior evidence before completion', async t => {
  const f = await fixture(t); await f.begin(); const data = structuredClone(RETENTION);
  const work = f.records.append({ transactionId: TX, phase: 'RETENTION_READY', data }); data.root.ino = 'changed';
  assert.deepEqual((await work).active.records.at(-1).data, RETENTION);
  await f.records.append({ transactionId: TX, phase: 'RETENTION_READY', data: RETENTION });
  const before = await disk(f.root); await f.records.append({ transactionId: TX, phase: 'RETENTION_READY', data });
  const history = await f.records.readTransaction({ transactionId: TX });
  assert.deepEqual(history.records.slice(1).map(record => record.data), [RETENTION, RETENTION, data]);
  const after = await disk(f.root);
  for (const file of before.files) assert.deepEqual(after.files.find(item => item.name === file.name), file);
  await f.reopen(); assert.deepEqual(await f.records.readTransaction({ transactionId: TX }), history);
});

test('collection appends to the global chain but never changes transaction history, receipt, or active state', async t => {
  const seen = []; const f = await fixture(t, { verifyCollection: async (snapshot, argument) => {
    assert.equal(Object.isFrozen(snapshot), true); assert.equal(Object.isFrozen(argument), true);
    assert.equal(snapshot.active, null); seen.push(argument); return true;
  } });
  await completedHistory(f); const before = await disk(f.root); const prior = await f.records.read();
  const history = await f.records.readTransaction({ transactionId: TX });
  const begun = await f.records.beginCollection(COLLECTION);
  assert.equal(begun.active, null); assert.deepEqual(begun.completed, prior.completed); assert.equal(begun.head.sequence, prior.head.sequence + 1);
  assert.deepEqual(begun.collections, [{ ...COLLECTION, state: 'BEGUN' }]);
  const beginning = await disk(f.root); await f.reopen(); assert.deepEqual(await f.records.read(), begun); assert.deepEqual(await disk(f.root), beginning);
  const ended = await f.records.finishCollection(COLLECTION);
  assert.equal(ended.active, null); assert.deepEqual(ended.completed, prior.completed); assert.equal(ended.head.sequence, prior.head.sequence + 2);
  assert.deepEqual(ended.collections, [{ ...COLLECTION, state: 'COMPLETED' }]);
  assert.deepEqual(await f.records.readTransaction({ transactionId: TX }), history);
  const after = await disk(f.root);
  for (const file of before.files) assert.deepEqual(after.files.find(item => item.name === file.name), file);
  assert.equal(after.files.length, before.files.length + 2); assert.equal(after.files.some(item => item.name === 'active.enc'), false);
  assert.deepEqual(seen, [{ ...COLLECTION, operation: 'BEGIN' }, { ...COLLECTION, operation: 'END' }]);
  await f.begin({ next: true }, 'BACKUP', transactionIdAt(3)); await f.reopen();
  assert.equal((await f.records.read()).active.transactionId, transactionIdAt(3));
  assert.deepEqual((await f.records.read()).collections, ended.collections); keysCleared(f);
});

for (const verifier of [undefined, async () => false, async () => 1, async () => ({}), async () => { throw new Error('injected-secret'); }]) {
  test(`collection requires exact true fixed authority (${String(verifier)})`, async t => {
    const f = await fixture(t, { verifyCollection: verifier }); await completedHistory(f); const before = await disk(f.root);
    await rejects(f.records.beginCollection(COLLECTION), 'BACKUP_RECOVERY_COLLECTION_UNVERIFIED');
    assert.deepEqual(await disk(f.root), before); assert.deepEqual((await f.records.read()).collections, []);
  });
}

test('collection factory captures the callback reference and rejects malformed authority options', async t => {
  const f = await fixture(t, { verifyCollection: async () => true }); await completedHistory(f);
  f.options.verifyCollection = async () => false;
  await f.records.beginCollection(COLLECTION); await f.records.finishCollection(COLLECTION);
  await f.records.close(); const before = await disk(f.root);
  await rejects(f.open({ verifyCollection: true }), 'BACKUP_RECOVERY_ARGUMENT'); assert.deepEqual(await disk(f.root), before);
});

test('latest two completed transactions are protected independently of any positive callback', async t => {
  let calls = 0; const f = await fixture(t, { verifyCollection: async () => { calls += 1; return true; } });
  await completedHistory(f, 2); const before = await disk(f.root);
  for (const transactionId of [TX, NEXT]) await rejects(f.records.beginCollection({ transactionId, manifestSha256: MANIFEST_SHA }), 'BACKUP_RECOVERY_STATE');
  assert.equal(calls, 0); assert.deepEqual(await disk(f.root), before);
  await f.begin({ third: true }, 'RESTORE', transactionIdAt(2));
  await f.records.append({ transactionId: transactionIdAt(2), phase: 'RETENTION_READY', data: RETENTION });
  await f.complete({ transactionId: transactionIdAt(2) }, transactionIdAt(2)); await f.records.beginCollection(COLLECTION);
  await f.records.finishCollection(COLLECTION);
  // GC events do not count as newer completions and a collected transaction does not disappear from recency ordering.
  await rejects(f.records.beginCollection({ transactionId: NEXT, manifestSha256: MANIFEST_SHA }), 'BACKUP_RECOVERY_STATE');
  assert.equal(calls, 2);
});

test('collection rejects historical transactions without RETENTION_READY even if a callback would approve', async t => {
  let calls = 0; const f = await fixture(t, { verifyCollection: async () => { calls += 1; return true; } });
  await completedHistory(f, 3, false); const before = await disk(f.root);
  await rejects(f.records.beginCollection(COLLECTION), 'BACKUP_RECOVERY_STATE'); assert.equal(calls, 0);
  assert.deepEqual(await disk(f.root), before);
});

test('pending backup/restore and incomplete collection block conflicting new work without active-state confusion', async t => {
  const f = await fixture(t, { verifyCollection: async () => true }); await completedHistory(f, 4);
  await f.begin({ next: true }, 'RESTORE', transactionIdAt(4));
  await rejects(f.records.beginCollection(COLLECTION), 'BACKUP_RECOVERY_STATE');
  await f.complete({ transactionId: transactionIdAt(4) }, transactionIdAt(4));
  await f.records.beginCollection(COLLECTION); const before = await disk(f.root);
  await rejects(f.begin({}, 'BACKUP', transactionIdAt(5)), 'BACKUP_RECOVERY_STATE');
  await rejects(f.records.beginCollection({ transactionId: NEXT, manifestSha256: MANIFEST_SHA }), 'BACKUP_RECOVERY_STATE');
  await rejects(f.records.finishCollection({ transactionId: NEXT, manifestSha256: MANIFEST_SHA }), 'BACKUP_RECOVERY_STATE');
  const state = await f.records.read(); assert.equal(state.active, null); assert.equal(state.completed.length, 5);
  assert.deepEqual(state.collections, [{ ...COLLECTION, state: 'BEGUN' }]); assert.deepEqual(await disk(f.root), before);
  await f.records.finishCollection(COLLECTION); await f.records.beginCollection({ transactionId: NEXT, manifestSha256: MANIFEST_SHA });
  await f.records.finishCollection({ transactionId: NEXT, manifestSha256: MANIFEST_SHA });
  assert.equal((await f.records.read()).collections.length, 2);
});

test('finish requires a matching begin and canonical digest, with no generic GC phase append', async t => {
  let calls = 0; const f = await fixture(t, { verifyCollection: async () => { calls += 1; return true; } });
  await completedHistory(f); const before = await disk(f.root);
  await rejects(f.records.finishCollection(COLLECTION), 'BACKUP_RECOVERY_STATE');
  for (const phase of ['GC_BEGIN', 'GC_END']) await rejects(f.records.append({ transactionId: TX, phase, data: { manifestSha256: MANIFEST_SHA } }), 'BACKUP_RECOVERY_ARGUMENT');
  for (const value of [{ ...COLLECTION, manifestSha256: 'f'.repeat(64) }, { ...COLLECTION, transactionId: transactionIdAt(9) }]) {
    await rejects(f.records.beginCollection(value), 'BACKUP_RECOVERY_STATE');
  }
  assert.equal(calls, 0); assert.deepEqual(await disk(f.root), before);
  await f.records.beginCollection(COLLECTION); const begun = await disk(f.root);
  await rejects(f.records.finishCollection({ ...COLLECTION, manifestSha256: 'f'.repeat(64) }), 'BACKUP_RECOVERY_STATE');
  assert.deepEqual(await disk(f.root), begun); assert.equal(calls, 1);
});

test('collection identifiers reject extra fields, noncanonical UUIDs/digests, proxies and getters without invoking them', async t => {
  const f = await fixture(t, { verifyCollection: async () => true }); await completedHistory(f); const before = await disk(f.root); let called = 0;
  const bad = [null, {}, { ...COLLECTION, extra: true }, { ...COLLECTION, transactionId: `${TX}\n` },
    ...['\n', '\r', '\u2028', '\u2029'].map(suffix => ({ ...COLLECTION, manifestSha256: MANIFEST_SHA + suffix })),
    { ...COLLECTION, manifestSha256: MANIFEST_SHA.toUpperCase() }, { ...COLLECTION, manifestSha256: Buffer.from(MANIFEST_SHA) },
    Object.defineProperty({ transactionId: TX }, 'manifestSha256', { enumerable: true, get() { called += 1; return MANIFEST_SHA; } }),
    new Proxy(COLLECTION, { ownKeys() { called += 1; return ['transactionId', 'manifestSha256']; } })];
  for (const value of bad) for (const method of ['beginCollection', 'finishCollection']) await rejects(f.records[method](value), 'BACKUP_RECOVERY_ARGUMENT');
  assert.equal(called, 0); assert.deepEqual(await disk(f.root), before);
});

test('identical collection retries revalidate authority and sync existing evidence without appending or rewriting', async t => {
  let allowed = true; let calls = 0; const f = await fixture(t, { verifyCollection: async () => { calls += 1; return allowed; } });
  await completedHistory(f); const begun = await f.records.beginCollection(COLLECTION); const before = await disk(f.root);
  const original = fs.open; let fileSyncs = 0; let directorySyncs = 0;
  t.mock.method(fs, 'open', async function(file, flags, mode) {
    const handle = await original.call(fs, file, flags, mode); const sync = handle.sync.bind(handle);
    handle.sync = async () => { if (String(file).endsWith('.enc')) fileSyncs += 1; else directorySyncs += 1; return sync(); }; return handle;
  });
  assert.deepEqual(await f.records.beginCollection(COLLECTION), begun); assert.equal(fileSyncs, 1); assert.equal(directorySyncs, 1);
  assert.deepEqual(await disk(f.root), before); allowed = false;
  await rejects(f.records.beginCollection(COLLECTION), 'BACKUP_RECOVERY_COLLECTION_UNVERIFIED'); assert.equal(fileSyncs, 1);
  allowed = true; const ended = await f.records.finishCollection(COLLECTION); const after = await disk(f.root);
  assert.deepEqual(await f.records.finishCollection(COLLECTION), ended);
  assert.deepEqual(await f.records.beginCollection(COLLECTION), ended); assert.deepEqual(await disk(f.root), after);
  assert.equal(calls, 6); assert.equal(fileSyncs, 5); assert.equal(directorySyncs, 5);
});

test('same-tick duplicate collection requests capture input, serialize and append only one begin/end each', async t => {
  const f = await fixture(t, { verifyCollection: async () => true }); await completedHistory(f);
  const input = { ...COLLECTION }; const first = f.records.beginCollection(input); input.manifestSha256 = 'f'.repeat(64);
  const second = f.records.beginCollection(COLLECTION); const results = await Promise.all([first, second]);
  assert.deepEqual(results[0], results[1]); const ends = await Promise.all([f.records.finishCollection(COLLECTION), f.records.finishCollection(COLLECTION)]);
  assert.deepEqual(ends[0], ends[1]); assert.equal(ends[0].head.sequence, 11);
});

test('close drains a collection authority callback before releasing ownership and rejects newly admitted work', async t => {
  const reached = deferred(); const release = deferred(); const f = await fixture(t, { verifyCollection: async () => {
    reached.resolve(); await release.promise; return true;
  } }); await completedHistory(f);
  const work = f.records.beginCollection(COLLECTION); await reached.promise; const closing = f.records.close();
  await rejects(f.records.finishCollection(COLLECTION), 'BACKUP_RECOVERY_CLOSED');
  await rejects(f.open(), 'BACKUP_RECOVERY_BUSY'); release.resolve(); await work; await closing;
  await f.open(); assert.deepEqual((await f.records.read()).collections, [{ ...COLLECTION, state: 'BEGUN' }]);
});

test('collection rejects changed evidence after the asynchronous fixed callback instead of appending to a stale decision', async t => {
  const f = await fixture(t, { verifyCollection: async () => {
    await fs.unlink(path.join(f.root, 'record-00000009.enc')); return true;
  } }); await completedHistory(f);
  await rejects(f.records.beginCollection(COLLECTION), 'BACKUP_RECOVERY_INVALID');
  await assert.rejects(fs.stat(path.join(f.root, 'record-00000010.enc')), { code: 'ENOENT' });
});

for (const [name, change] of [
  ['end without begin', value => { value.phase = 'GC_END'; }],
  ['different manifest', value => { value.data.manifestSha256 = 'f'.repeat(64); }],
  ['newest transaction', value => { value.transactionId = transactionIdAt(2); }],
  ['unknown transaction', value => { value.transactionId = transactionIdAt(9); }],
  ['different transaction kind', value => { value.kind = 'BACKUP'; }],
  ['extra collection field', value => { value.data.command = 'never authority'; }],
  ['ordinary phase after completion', value => { value.phase = 'RETENTION_READY'; }],
  ['unbound previous hash', value => { value.previousHash = 'f'.repeat(64); }],
]) {
  test(`authenticated GC replay rejects ${name}`, async t => {
    const f = await fixture(t, { verifyCollection: async () => true }); await completedHistory(f); await f.records.beginCollection(COLLECTION);
    await f.records.close(); await authenticatedMutation(path.join(f.root, 'record-00000010.enc'), f, change);
    const before = await disk(f.root); await rejects(f.open(), 'BACKUP_RECOVERY_INVALID'); assert.deepEqual(await disk(f.root), before);
  });
}

test('authenticated GC replay rejects duplicate begin and a changed end manifest', async t => {
  for (const mutate of [value => { value.phase = 'GC_BEGIN'; }, value => { value.data.manifestSha256 = 'f'.repeat(64); }]) {
    const f = await fixture(t, { verifyCollection: async () => true }); await completedHistory(f);
    await f.records.beginCollection(COLLECTION); await f.records.finishCollection(COLLECTION); await f.records.close();
    await authenticatedMutation(path.join(f.root, 'record-00000011.enc'), f, mutate);
    await rejects(f.open(), 'BACKUP_RECOVERY_INVALID');
  }
});

test('GC replay cannot turn missing receipt evidence or a resurrected active marker into a completed target', async t => {
  for (const mutation of ['missing-receipt', 'active-marker']) {
    const f = await fixture(t, { verifyCollection: async () => true }); let savedMarker;
    await completedHistory(f, 2); await f.begin({ third: true }, 'RESTORE', transactionIdAt(2));
    await f.records.append({ transactionId: transactionIdAt(2), phase: 'RETENTION_READY', data: RETENTION });
    savedMarker = await fs.readFile(path.join(f.root, 'active.enc')); await f.complete({ transactionId: transactionIdAt(2) }, transactionIdAt(2));
    await f.records.beginCollection(COLLECTION); await f.records.close();
    if (mutation === 'missing-receipt') await fs.unlink(path.join(f.root, 'receipt-00000009.enc'));
    else await fs.writeFile(path.join(f.root, 'active.enc'), savedMarker, { mode: 0o600, flag: 'wx' });
    const before = await disk(f.root); await rejects(f.open(), 'BACKUP_RECOVERY_INVALID'); assert.deepEqual(await disk(f.root), before);
  }
});

for (const operation of ['BEGIN', 'END']) for (const point of ['file-sync', 'directory-sync']) {
  test(`${operation} collection ${point} uncertain ACK requires reopen and a verified durable exact retry`, async t => {
    let approved = true; const f = await fixture(t, { verifyCollection: async () => approved }); await completedHistory(f);
    if (operation === 'END') await f.records.beginCollection(COLLECTION);
    const method = operation === 'BEGIN' ? 'beginCollection' : 'finishCollection';
    const sequence = operation === 'BEGIN' ? 10 : 11; const original = fs.open; let fired = false; let published = false;
    t.mock.method(fs, 'open', async function(file, flags, mode) {
      const handle = await original.call(fs, file, flags, mode);
      const created = String(file).endsWith(`/record-${String(sequence).padStart(8, '0')}.enc`) && (flags & constants.O_CREAT);
      if (created) published = true;
      const matches = point === 'file-sync' ? created : published && String(file) === f.root && (flags & constants.O_DIRECTORY);
      if (!fired && matches) { const sync = handle.sync.bind(handle); handle.sync = async () => { fired = true; await sync(); throw new Error('injected-secret'); }; }
      return handle;
    });
    await rejects(f.records[method](COLLECTION), 'BACKUP_RECOVERY_IO'); assert.equal(fired, true);
    await rejects(f.records.read(), 'BACKUP_RECOVERY_CLOSED'); t.mock.restoreAll(); await f.records.close(); const before = await disk(f.root);
    await f.open(); const read = await f.records.read(); assert.equal(read.head.sequence, sequence); assert.equal(read.active, null);
    assert.equal(read.collections[0].state, operation === 'BEGIN' ? 'BEGUN' : 'COMPLETED'); assert.deepEqual(await disk(f.root), before);
    approved = false; await rejects(f.records[method](COLLECTION), 'BACKUP_RECOVERY_COLLECTION_UNVERIFIED'); assert.deepEqual(await disk(f.root), before);
    approved = true; assert.deepEqual(await f.records[method](COLLECTION), read); assert.deepEqual(await disk(f.root), before);
  });
}

test('an exact GC retry with a failing fsync is not acknowledged and never rewrites its record', async t => {
  const f = await fixture(t, { verifyCollection: async () => true }); await completedHistory(f); await f.records.beginCollection(COLLECTION);
  const before = await disk(f.root); const original = fs.open; let fired = false;
  t.mock.method(fs, 'open', async function(file, flags, mode) {
    const handle = await original.call(fs, file, flags, mode);
    if (String(file).endsWith('/record-00000010.enc')) handle.sync = async () => { fired = true; throw new Error('injected-secret'); };
    return handle;
  });
  await rejects(f.records.beginCollection(COLLECTION), 'BACKUP_RECOVERY_IO'); assert.equal(fired, true);
  await rejects(f.records.read(), 'BACKUP_RECOVERY_CLOSED'); assert.deepEqual(await disk(f.root), before);
});

test('a torn GC record stays fail-closed evidence across reopen and no cleanup or new enrollment occurs', async t => {
  const f = await fixture(t, { verifyCollection: async () => true }); await completedHistory(f); const original = fs.open; let fired = false;
  t.mock.method(fs, 'open', async function(file, flags, mode) {
    const handle = await original.call(fs, file, flags, mode);
    if (!fired && String(file).endsWith('/record-00000010.enc') && (flags & constants.O_CREAT)) {
      const write = handle.write.bind(handle); handle.write = async (bytes, offset, length, position) => {
        fired = true; await write(bytes, offset, Math.floor(length / 2), position); throw new Error('injected-secret');
      };
    } return handle;
  });
  await rejects(f.records.beginCollection(COLLECTION), 'BACKUP_RECOVERY_IO'); assert.equal(fired, true);
  t.mock.restoreAll(); await f.records.close(); const before = await disk(f.root);
  await rejects(f.open()); await rejects(f.open({ initialize: true }), 'BACKUP_RECOVERY_EXISTS'); assert.deepEqual(await disk(f.root), before);
});

test('rollback history permits health and retention evidence but never resumes mutations even after those phases or reopen', async t => {
  const f = await fixture(t); await f.begin(); await f.records.append({ transactionId: TX, phase: 'ROLLED_BACK', data: { exact: 'rollback' } });
  for (const phase of ['HEALTH_VERIFIED', 'RETENTION_READY', 'HEALTH_VERIFIED', 'RETENTION_READY']) {
    await f.records.append({ transactionId: TX, phase, data: phase === 'RETENTION_READY' ? RETENTION : { status: 'DRAINED' } });
    await f.reopen(); const before = await disk(f.root);
    for (const denied of ['MERGED', 'SEALED', 'STAGED', 'DATABASE_SWAPPED', 'SOURCES_SWAPPED', 'ROLLED_BACK']) {
      await rejects(f.records.append({ transactionId: TX, phase: denied, data: {} }), 'BACKUP_RECOVERY_STATE');
    }
    assert.deepEqual(await disk(f.root), before); assert.equal((await f.records.read()).active.phase, phase);
  }
  const history = await f.records.readTransaction({ transactionId: TX });
  assert.equal(history.records.filter(record => record.phase === 'ROLLED_BACK').length, 1);
  await f.complete(); assert.equal((await f.records.readTransaction({ transactionId: TX })).status, 'COMPLETED');
});

for (const phase of ['MERGED', 'SEALED', 'STAGED', 'DATABASE_SWAPPED', 'SOURCES_SWAPPED', 'ROLLED_BACK']) {
  test(`authenticated replay cannot conceal rollback history behind a later ${phase} phase`, async t => {
    const f = await fixture(t); await f.begin(); await f.records.append({ transactionId: TX, phase: 'ROLLED_BACK', data: {} });
    await f.records.append({ transactionId: TX, phase: 'HEALTH_VERIFIED', data: { status: 'DRAINED' } });
    await f.records.append({ transactionId: TX, phase: 'RETENTION_READY', data: RETENTION }); await f.records.close();
    await authenticatedMutation(path.join(f.root, 'record-00000004.enc'), f, value => { value.phase = phase; });
    const before = await disk(f.root); await rejects(f.open(), 'BACKUP_RECOVERY_INVALID'); assert.deepEqual(await disk(f.root), before);
  });
}

test('GC binds only the last pre-completion retention manifest after rollback while preserving all prior evidence', async t => {
  const f = await fixture(t, { verifyCollection: async () => true }); const updated = structuredClone(RETENTION); updated.root.ino = '22';
  await f.begin(); await f.records.append({ transactionId: TX, phase: 'RETENTION_READY', data: RETENTION });
  await f.records.append({ transactionId: TX, phase: 'ROLLED_BACK', data: { restored: true } });
  await f.records.append({ transactionId: TX, phase: 'HEALTH_VERIFIED', data: { status: 'DRAINED' } });
  await f.records.append({ transactionId: TX, phase: 'RETENTION_READY', data: updated }); await f.complete();
  for (const transactionId of [NEXT, transactionIdAt(2)]) {
    await f.begin({}, 'BACKUP', transactionId); await f.complete({ transactionId }, transactionId);
  }
  await f.reopen(); const before = await disk(f.root); await rejects(f.records.beginCollection(COLLECTION), 'BACKUP_RECOVERY_STATE');
  assert.deepEqual(await disk(f.root), before);
  const latest = { transactionId: TX, manifestSha256: hash(canonical(updated)) };
  await f.records.beginCollection(latest); await f.records.finishCollection(latest);
  const history = await f.records.readTransaction({ transactionId: TX });
  assert.deepEqual(history.records.filter(record => record.phase === 'RETENTION_READY').map(record => record.data), [RETENTION, updated]);
  assert.deepEqual((await f.records.read()).collections, [{ ...latest, state: 'COMPLETED' }]);
});

test('finish separately requires exact true authority and leaves a durable begun collection pending on denial', async t => {
  const f = await fixture(t, { verifyCollection: async (_snapshot, argument) => argument.operation === 'BEGIN' ? true : { allowed: true } });
  await completedHistory(f); await f.records.beginCollection(COLLECTION); const before = await disk(f.root);
  await rejects(f.records.finishCollection(COLLECTION), 'BACKUP_RECOVERY_COLLECTION_UNVERIFIED');
  assert.deepEqual(await disk(f.root), before); assert.deepEqual((await f.records.read()).collections, [{ ...COLLECTION, state: 'BEGUN' }]);
  await rejects(f.begin({}, 'BACKUP', transactionIdAt(3)), 'BACKUP_RECOVERY_STATE');
});

test('finish syncs the original GC_BEGIN before appending GC_END after reopen, and an unacknowledged sync blocks finish', async t => {
  const f = await fixture(t, { verifyCollection: async () => true }); await completedHistory(f); await f.records.beginCollection(COLLECTION); await f.reopen();
  const before = await disk(f.root); const original = fs.open; let fired = false;
  t.mock.method(fs, 'open', async function(file, flags, mode) {
    const handle = await original.call(fs, file, flags, mode);
    if (String(file).endsWith('/record-00000010.enc')) handle.sync = async () => { fired = true; throw new Error('injected-secret'); };
    return handle;
  });
  await rejects(f.records.finishCollection(COLLECTION), 'BACKUP_RECOVERY_IO'); assert.equal(fired, true);
  assert.deepEqual(await disk(f.root), before); await assert.rejects(fs.stat(path.join(f.root, 'record-00000011.enc')), { code: 'ENOENT' });
  t.mock.restoreAll(); await f.reopen(); assert.equal((await f.records.finishCollection(COLLECTION)).collections[0].state, 'COMPLETED');
});

const SCRATCH = Object.freeze({ transactionId: TX, relativeDirectory: `verification/verify-checkpoint-${NEXT}`,
  directoryIdentity: '99:123', payloadIdentity: '99:124', payloadSha256: 'c'.repeat(64) });
function scratchAt(index, changes = {}) {
  const id = `550e8400-e29b-41d4-a716-${String(index).padStart(12, '0')}`;
  return { ...SCRATCH, relativeDirectory: `verification/verify-product-${id}`, ...changes };
}

test('scratch registration is encrypted bounded side evidence and does not change ordinary history or receipt identity', async t => {
  const f = await fixture(t); const prepared = await f.begin(); const files = await disk(f.root);
  const registered = await f.records.registerScratch(SCRATCH);
  assert.deepEqual(registered.scratches, [SCRATCH]); assert.equal(registered.head.sequence, 2);
  assert.deepEqual(registered.active, prepared.active); assert.deepEqual(registered.completed, []); assert.deepEqual(registered.collections, []);
  assert.equal(Object.isFrozen(registered.scratches[0]), true);
  assert.throws(() => { registered.scratches[0].payloadSha256 = 'f'.repeat(64); }, TypeError);
  assert.equal((await fs.readFile(path.join(f.root, 'record-00000002.enc'))).includes(SCRATCH.relativeDirectory), false);
  assert.deepEqual((await disk(f.root)).files.slice(0, 3), files.files);
  const history = await f.records.readTransaction({ transactionId: TX }); assert.equal(history.records.length, 1);
  const before = await disk(f.root); await f.reopen(); assert.deepEqual(await f.records.read(), registered); assert.deepEqual(await disk(f.root), before);
  const completed = await f.complete(); assert.equal(completed.completed[0].sequence, 3); assert.deepEqual(completed.completed[0].receipt, RECEIPT);
  assert.deepEqual(completed.scratches, [SCRATCH]); keysCleared(f);
});

for (const part of ['checkpoint', 'incoming', 'product']) test(`scratch ${part} directory and uint64 identity boundaries roundtrip exactly`, async t => {
  const f = await fixture(t); await f.begin();
  const value = { ...SCRATCH, relativeDirectory: `verification/verify-${part}-${NEXT}`,
    directoryIdentity: '0:18446744073709551615', payloadIdentity: '18446744073709551615:0' };
  assert.deepEqual((await f.records.registerScratch(value)).scratches, [value]); await f.reopen();
  assert.deepEqual((await f.records.read()).scratches, [value]);
});

for (const [label, change] of [
  ['absolute path', value => { value.relativeDirectory = `/${value.relativeDirectory}`; }],
  ['dot path', value => { value.relativeDirectory = value.relativeDirectory.replace('/', '/./'); }],
  ['parent path', value => { value.relativeDirectory = `verification/../verify-checkpoint-${NEXT}`; }],
  ['unknown role', value => { value.relativeDirectory = `verification/verify-unknown-${NEXT}`; }],
  ['nested path', value => { value.relativeDirectory += '/child'; }],
  ['uppercase UUID', value => { value.relativeDirectory = value.relativeDirectory.toUpperCase(); }],
  ['wrong UUID variant', value => { value.relativeDirectory = value.relativeDirectory.replace('-a716-', '-1716-'); }],
  ['leading-zero directory inode', value => { value.directoryIdentity = '99:0123'; }],
  ['negative payload inode', value => { value.payloadIdentity = '99:-1'; }],
  ['uint64 overflow', value => { value.payloadIdentity = '99:18446744073709551616'; }],
  ['numeric identity', value => { value.payloadIdentity = 123; }],
  ['uppercase hash', value => { value.payloadSha256 = 'C'.repeat(64); }],
  ['extra field', value => { value.command = 'never authority'; }],
  ['missing field', value => { delete value.payloadIdentity; }],
]) test(`scratch registration rejects ${label} without changing evidence`, async t => {
  const f = await fixture(t); await f.begin(); const before = await disk(f.root), value = { ...SCRATCH }; change(value);
  await rejects(f.records.registerScratch(value), 'BACKUP_RECOVERY_ARGUMENT'); assert.deepEqual(await disk(f.root), before);
});

for (const suffix of ['\n', '\r', '\u2028', '\u2029']) test(`scratch identifiers reject a full-string suffix U+${suffix.charCodeAt(0).toString(16)}`, async t => {
  const f = await fixture(t); await f.begin(); const before = await disk(f.root);
  for (const field of Object.keys(SCRATCH)) await rejects(f.records.registerScratch({ ...SCRATCH, [field]: SCRATCH[field] + suffix }), 'BACKUP_RECOVERY_ARGUMENT');
  assert.deepEqual(await disk(f.root), before);
});

test('scratch registration rejects getters/proxies without reading them and captures scalar input before queueing', async t => {
  const f = await fixture(t); await f.begin(); let calls = 0;
  const getter = { ...SCRATCH }; Object.defineProperty(getter, 'relativeDirectory', { enumerable: true, get() { calls++; throw new Error('injected-secret'); } });
  await rejects(f.records.registerScratch(getter), 'BACKUP_RECOVERY_ARGUMENT');
  await rejects(f.records.registerScratch(new Proxy(SCRATCH, { ownKeys() { calls++; throw new Error('injected-secret'); } })), 'BACKUP_RECOVERY_ARGUMENT');
  assert.equal(calls, 0);
  const value = { ...SCRATCH }, work = f.records.registerScratch(value); value.payloadSha256 = 'f'.repeat(64);
  assert.deepEqual((await work).scratches, [SCRATCH]);
});

test('scratch requires the current active transaction and cannot be appended through the generic phase API', async t => {
  const f = await fixture(t); const empty = await disk(f.root);
  await rejects(f.records.registerScratch(SCRATCH), 'BACKUP_RECOVERY_STATE'); assert.deepEqual(await disk(f.root), empty);
  await f.begin(); const before = await disk(f.root);
  await rejects(f.records.registerScratch({ ...SCRATCH, transactionId: NEXT }), 'BACKUP_RECOVERY_STATE');
  await rejects(f.records.append({ transactionId: TX, phase: 'RECOVERY_SCRATCH', data: SCRATCH }), 'BACKUP_RECOVERY_ARGUMENT');
  assert.deepEqual(await disk(f.root), before);
  await f.records.registerScratch(SCRATCH); await f.complete(); const completed = await disk(f.root);
  await rejects(f.records.registerScratch(SCRATCH), 'BACKUP_RECOVERY_STATE'); assert.deepEqual(await disk(f.root), completed);
  await f.begin({}, 'BACKUP', NEXT);
  await rejects(f.records.registerScratch(SCRATCH), 'BACKUP_RECOVERY_STATE');
  assert.deepEqual((await f.records.registerScratch({ ...SCRATCH, transactionId: NEXT })).scratches, [SCRATCH, { ...SCRATCH, transactionId: NEXT }]);
});

test('exact serialized scratch retries re-sync their original event without appending or rewriting, but changed identities are refused', async t => {
  const f = await fixture(t); await f.begin();
  const [first, duplicate] = await Promise.all([f.records.registerScratch(SCRATCH), f.records.registerScratch({ ...SCRATCH })]);
  assert.deepEqual(duplicate, first); const before = await disk(f.root);
  for (const field of ['directoryIdentity', 'payloadIdentity', 'payloadSha256']) {
    const value = { ...SCRATCH, [field]: field === 'payloadSha256' ? 'f'.repeat(64) : '99:999' };
    await rejects(f.records.registerScratch(value), 'BACKUP_RECOVERY_STATE');
  }
  await f.reopen(); assert.deepEqual(await f.records.registerScratch(SCRATCH), first); assert.deepEqual(await disk(f.root), before);
});

test('scratch after rollback preserves the rollback phase and does not reopen ordinary A mutations', async t => {
  const f = await fixture(t); await f.begin(); await f.records.append({ transactionId: TX, phase: 'ROLLED_BACK', data: {} });
  const before = await f.records.read(); const registered = await f.records.registerScratch(SCRATCH);
  assert.deepEqual(registered.active, before.active); await f.reopen();
  for (const phase of ['MERGED', 'SEALED', 'STAGED', 'DATABASE_SWAPPED', 'SOURCES_SWAPPED', 'ROLLED_BACK'])
    await rejects(f.records.append({ transactionId: TX, phase, data: {} }), 'BACKUP_RECOVERY_STATE');
  await f.records.append({ transactionId: TX, phase: 'HEALTH_VERIFIED', data: {} }); await f.complete();
});

for (const failure of ['missing receipt', 'surviving marker']) test(`scratch can record recovery during ${failure} without moving durable COMPLETED receipt identity`, async t => {
  const f = await fixture(t); await f.begin();
  const open = fs.open, unlink = fs.unlink; let fired = false;
  if (failure === 'missing receipt') t.mock.method(fs, 'open', async function(file, flags, mode) {
    if (!fired && path.basename(String(file)) === 'receipt-00000002.enc' && (flags & constants.O_CREAT)) { fired = true; throw new Error('injected-secret'); }
    return open.call(fs, file, flags, mode);
  });
  else t.mock.method(fs, 'unlink', async function(file) {
    if (!fired && String(file) === path.join(f.root, 'active.enc')) { fired = true; throw new Error('injected-secret'); }
    return unlink.call(fs, file);
  });
  await rejects(f.complete(), 'BACKUP_RECOVERY_IO'); assert.equal(fired, true); t.mock.restoreAll(); await f.reopen();
  const pending = await f.records.read(); assert.equal(pending.active.phase, 'COMPLETED'); assert.equal(pending.active.records.at(-1).sequence, 2);
  const originalCompletion = await fs.readFile(path.join(f.root, 'record-00000002.enc'));
  const registered = await f.records.registerScratch(SCRATCH); assert.deepEqual(registered.active, pending.active); assert.equal(registered.head.sequence, 3);
  await f.reopen(); const completed = await f.complete(); assert.equal(completed.head.sequence, 3);
  assert.equal(completed.completed[0].sequence, 2); assert.deepEqual(completed.completed[0].receipt, RECEIPT);
  assert.deepEqual(await fs.readFile(path.join(f.root, 'record-00000002.enc')), originalCompletion);
  assert.equal(parseEnvelope(await fs.readFile(path.join(f.root, 'receipt-00000002.enc'))).header.core.role, 'RECEIPT');
});

for (const [name, mutation] of [
  ['unknown transaction', value => { value.transactionId = NEXT; }],
  ['different kind', value => { value.kind = 'BACKUP'; }],
  ['unsafe directory', value => { value.data.relativeDirectory = '../private'; }],
  ['changed field type', value => { value.data.payloadIdentity = 1; }],
  ['unknown data field', value => { value.data.command = 'never authority'; }],
]) test(`authenticated scratch replay rejects ${name}`, async t => {
  const f = await fixture(t); await f.begin(); await f.records.registerScratch(SCRATCH); await f.records.close();
  await authenticatedMutation(path.join(f.root, 'record-00000002.enc'), f, mutation); const before = await disk(f.root);
  await rejects(f.open(), 'BACKUP_RECOVERY_INVALID'); assert.deepEqual(await disk(f.root), before);
});

test('authenticated scratch replay rejects an event before PREPARED or duplicate directory binding', async t => {
  for (const variant of ['before prepared', 'duplicate']) {
    const f = await fixture(t); await f.begin(); await f.records.registerScratch(SCRATCH);
    if (variant === 'duplicate') await f.records.registerScratch(scratchAt(2)); await f.records.close();
    const sequence = variant === 'before prepared' ? 1 : 3;
    await authenticatedMutation(path.join(f.root, `record-${String(sequence).padStart(8, '0')}.enc`), f, value => {
      value.phase = 'RECOVERY_SCRATCH'; const { transactionId, ...data } = SCRATCH; value.data = data;
    });
    const before = await disk(f.root); await rejects(f.open(), 'BACKUP_RECOVERY_INVALID'); assert.deepEqual(await disk(f.root), before);
  }
});

for (const point of ['file-sync', 'directory-sync']) test(`scratch ${point} uncertain ACK requires reopen and a durable exact retry`, async t => {
  const f = await fixture(t); await f.begin(); const open = fs.open; let fired = false, published = false;
  t.mock.method(fs, 'open', async function(file, flags, mode) {
    const handle = await open.call(fs, file, flags, mode);
    const created = path.basename(String(file)) === 'record-00000002.enc' && (flags & constants.O_CREAT);
    if (created) published = true;
    if (!fired && (point === 'file-sync' ? created : published && String(file) === f.root && (flags & constants.O_DIRECTORY))) {
      const sync = handle.sync.bind(handle); handle.sync = async () => { fired = true; await sync(); throw new Error('injected-secret'); };
    }
    return handle;
  });
  await rejects(f.records.registerScratch(SCRATCH), 'BACKUP_RECOVERY_IO'); assert.equal(fired, true);
  t.mock.restoreAll(); await f.reopen(); const read = await f.records.read(); assert.deepEqual(read.scratches, [SCRATCH]);
  const before = await disk(f.root); let synced = false;
  t.mock.method(fs, 'open', async function(file, flags, mode) {
    const handle = await open.call(fs, file, flags, mode);
    if (path.basename(String(file)) === 'record-00000002.enc') { const sync = handle.sync.bind(handle); handle.sync = async () => { synced = true; return sync(); }; }
    return handle;
  });
  assert.deepEqual(await f.records.registerScratch(SCRATCH), read); assert.equal(synced, true); assert.deepEqual(await disk(f.root), before);
});

test('scratch exact retry with failed durability cannot be acknowledged or rewrite history', async t => {
  const f = await fixture(t); await f.begin(); await f.records.registerScratch(SCRATCH); const before = await disk(f.root), open = fs.open;
  t.mock.method(fs, 'open', async function(file, flags, mode) {
    const handle = await open.call(fs, file, flags, mode);
    if (path.basename(String(file)) === 'record-00000002.enc') handle.sync = async () => { throw new Error('injected-secret'); };
    return handle;
  });
  await rejects(f.records.registerScratch(SCRATCH), 'BACKUP_RECOVERY_IO'); await rejects(f.records.read(), 'BACKUP_RECOVERY_CLOSED');
  assert.deepEqual(await disk(f.root), before);
});

test('torn scratch event remains fail-closed evidence rather than being deleted or guessed on reopen', async t => {
  const f = await fixture(t); await f.begin(); const open = fs.open; let fired = false;
  t.mock.method(fs, 'open', async function(file, flags, mode) {
    const handle = await open.call(fs, file, flags, mode);
    if (!fired && path.basename(String(file)) === 'record-00000002.enc' && (flags & constants.O_CREAT)) {
      const write = handle.write.bind(handle); handle.write = async (bytes, offset, length, position) => {
        fired = true; await write(bytes, offset, Math.floor(length / 2), position); throw new Error('injected-secret');
      };
    } return handle;
  });
  await rejects(f.records.registerScratch(SCRATCH), 'BACKUP_RECOVERY_IO'); assert.equal(fired, true);
  t.mock.restoreAll(); await f.records.close(); const before = await disk(f.root);
  await rejects(f.open()); assert.deepEqual(await disk(f.root), before);
});

test('scratch maximum is 256 per transaction, exact retry remains permitted at the limit, and next transaction gets its own bound', async t => {
  const f = await fixture(t); await f.begin();
  for (let index = 0; index < 256; index++) await f.records.registerScratch(scratchAt(index));
  const full = await f.records.read(); assert.equal(full.scratches.length, 256); const before = await disk(f.root);
  await rejects(f.records.registerScratch(scratchAt(256)), 'BACKUP_RECOVERY_CAPACITY');
  assert.deepEqual(await f.records.registerScratch(scratchAt(255)), full); assert.deepEqual(await disk(f.root), before);
  await f.complete(); await f.begin({}, 'BACKUP', NEXT); const next = await f.records.registerScratch({ ...SCRATCH, transactionId: NEXT });
  assert.equal(next.scratches.filter(item => item.transactionId === NEXT).length, 1); assert.equal(next.scratches.length, 257);
});
