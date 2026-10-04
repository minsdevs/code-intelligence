'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { openAuthenticatedState } = require('../src/windows-authenticated-state.cjs');
const { createStorageModel } = require('./fixtures/windows-storage-model.cjs');
const root = '/private/product';
const safetyRoot = root + '/safety';
const sha = value => crypto.createHash('sha256').update(value).digest('hex');
function wrapper() {
  const key = Buffer.alloc(32, 81);
  return {
    isAvailable: () => true,
    wrap(plain) {
      const nonce = crypto.randomBytes(12); const cipher = crypto.createCipheriv('aes-256-gcm', key, nonce);
      return Buffer.concat([nonce, cipher.update(plain), cipher.final(), cipher.getAuthTag()]);
    },
    unwrap(bytes) {
      const cipher = crypto.createDecipheriv('aes-256-gcm', key, bytes.subarray(0, 12)); cipher.setAuthTag(bytes.subarray(-16));
      return Buffer.concat([cipher.update(bytes.subarray(12, -16)), cipher.final()]);
    },
  };
}
function safeStorage() {
  const port = wrapper(); return { isEncryptionAvailable: () => true,
    encryptString: text => port.wrap(Buffer.from(text)), decryptString: bytes => port.unwrap(bytes).toString('utf8') };
}
async function stateFixture(mode = 'slots', extra = {}) {
  const model = createStorageModel(); const storage = await model.boundary.openStorage(root); const port = wrapper();
  const options = { storage, file: 'value', installationId: 'synthetic', purpose: 'test', mode,
    seal: port.wrap, unseal: port.unwrap, maxPayloadBytes: 1024, maxEncodedBytes: 2048, maxRecords: 4, ...extra };
  const state = await openAuthenticatedState({ ...options, fresh: true, initialValue: Buffer.from('initial') });
  return { model, options, state };
}
for (const mode of ['slots', 'append']) {
  test(`${mode}: full authenticated values persist and reopen without plaintext publication`, async () => {
    const f = await stateFixture(mode); await f.state.write(Buffer.from('updated'));
    assert.equal((await f.state.read()).toString(), 'updated');
    const reopened = await openAuthenticatedState(f.options); assert.equal((await reopened.read()).toString(), 'updated');
    for (const entry of f.model.files.values()) assert.equal(entry.bytes.includes(Buffer.from('updated')), false);
    await assert.rejects(openAuthenticatedState({ ...f.options, purpose: 'foreign' }));
    await assert.rejects(openAuthenticatedState({ ...f.options, installationId: 'foreign' }));
  });
  test(`${mode}: live valid historical bytes cannot replace the retained head`, async () => {
    const f = await stateFixture(mode); const before = [...f.model.files].map(([file, entry]) => [file, Buffer.from(entry.bytes)]);
    await f.state.write(Buffer.from('updated'));
    for (const [file, bytes] of before) f.model.replace(file, bytes);
    await assert.rejects(f.state.read()); await assert.rejects(f.state.write(Buffer.from('never')));
  });
  test(`${mode}: uncertain committed write poisons the value port`, async () => {
    const f = await stateFixture(mode); f.model.setFault(() => { throw new Error('synthetic post-write failure'); });
    await assert.rejects(f.state.write(Buffer.from('uncertain'))); f.model.setFault(null);
    await assert.rejects(f.state.read());
    const reopened = await openAuthenticatedState(f.options); assert.equal((await reopened.read()).toString(), 'uncertain');
  });
}
for (const mutation of ['missing', 'torn', 'mac', 'gap']) {
  test(`slots refuse ${mutation} evidence rather than falling back`, async () => {
    const f = await stateFixture();
    const old = Buffer.from(f.model.files.get(root + '/value.0').bytes);
    await f.state.write(Buffer.from('second')); await f.state.write(Buffer.from('third'));
    const file = root + '/value.0'; const entry = f.model.files.get(file);
    if (mutation === 'missing') f.model.files.delete(file);
    else if (mutation === 'torn') f.model.replace(file, entry.bytes.subarray(0, -1));
    else if (mutation === 'mac') { const bytes = Buffer.from(entry.bytes); bytes[bytes.length - 1] ^= 1; f.model.replace(file, bytes); }
    else f.model.replace(file, old);
    await assert.rejects(openAuthenticatedState(f.options));
  });
}
test('append refuses torn tail and enforces bounded snapshot count', async () => {
  const f = await stateFixture('append');
  for (let i = 0; i < 3; i++) await f.state.write(Buffer.from(String(i)));
  await assert.rejects(f.state.write(Buffer.from('over limit')));
  const entry = f.model.files.get(root + '/value'); f.model.replace(root + '/value', Buffer.concat([entry.bytes, Buffer.from([0])]));
  await assert.rejects(openAuthenticatedState(f.options));
});
test('interrupted slot enrollment retains incomplete evidence and never implicitly enrolls again', async () => {
  const model = createStorageModel(); const storage = await model.boundary.openStorage(root); const port = wrapper();
  const options = { storage, file: 'value', installationId: 'synthetic', purpose: 'test', mode: 'slots',
    seal: port.wrap, unseal: port.unwrap, maxPayloadBytes: 1024, maxEncodedBytes: 2048 };
  model.setFault(() => { throw new Error('synthetic first slot interruption'); });
  await assert.rejects(openAuthenticatedState({ ...options, fresh: true, initialValue: Buffer.from('initial') }));
  model.setFault(null); assert.ok(model.files.has(root + '/value.0'));
  await assert.rejects(openAuthenticatedState(options));
  await assert.rejects(openAuthenticatedState({ ...options, fresh: true, initialValue: Buffer.from('replacement') }));
});
test('chunked native reads preserve logical values above the native chunk size', async () => {
  const f = await stateFixture('append', { maxPayloadBytes: 2 * 1024 * 1024, maxEncodedBytes: 3 * 1024 * 1024 });
  const bytes = Buffer.alloc(1536 * 1024, 19); await f.state.write(bytes); assert.deepEqual(await f.state.read(), bytes);
});
async function keyFixture(t, extra = {}) {
  const model = createStorageModel(); const api = model.load('purpose-keyring.cjs');
  const options = { safetyRoot, restoreRoots: [root + '/data'], installationId: 'synthetic', wrapper: wrapper(),
    windowsBoundary: model.boundary, ownerLocks: model.ownerLocks, ...extra };
  const keyring = await api.initializePurposeKeyring(options); t.after(() => keyring.close().catch(() => {}));
  return { model, api, options, keyring };
}
test('Windows purpose keys retain old independent material through both-purpose rotation and restart', async t => {
  const f = await keyFixture(t, { limits: { keysPerPurpose: 2 } });
  const first = await f.keyring.currentKeyId('safety'); const backup = await f.keyring.currentKeyId('backup');
  const original = await f.keyring.getMacKey(first, 'safety');
  assert.notDeepEqual(original, await f.keyring.getBackupKey(backup));
  const next = await f.keyring.rotate('safety'); await f.keyring.rotate('backup');
  await assert.rejects(f.keyring.rotate('safety'), { code: 'PURPOSE_KEYRING_CAPACITY' });
  await f.keyring.close(); const reopened = await f.api.openPurposeKeyring(f.options); t.after(() => reopened.close());
  assert.equal(await reopened.currentKeyId('safety'), next); assert.deepEqual(await reopened.getMacKey(first, 'safety'), original);
  await assert.rejects(reopened.getMacKey(backup, 'backup'), { code: 'PURPOSE_KEYRING_ARGUMENT' }); original.fill(0);
});
test('Windows purpose keys poison on partial snapshot append and never mint replacement keys', async t => {
  const f = await keyFixture(t); const file = safetyRoot + '/purpose-keyring/purpose-keyring.wrapped';
  f.model.setFault(({ entry }) => { entry.bytes = entry.bytes.subarray(0, -1); throw new Error('synthetic torn write'); });
  await assert.rejects(f.keyring.rotate('safety')); await assert.rejects(f.keyring.currentKeyId('safety'));
  f.model.setFault(null); await f.keyring.close(); assert.ok(f.model.files.has(file));
  await assert.rejects(f.api.openPurposeKeyring(f.options)); await assert.rejects(f.api.initializePurposeKeyring(f.options));
});
async function journalFixture(t, extra = {}) {
  const model = createStorageModel(); model.directories.add(safetyRoot); const api = model.load('safety-journal.cjs');
  const options = { safetyRoot, restoreRoots: [root + '/data'], installationId: 'synthetic', runningBuild: '100',
    windowsBoundary: model.boundary, ownerLocks: model.ownerLocks,
    keyProvider: { currentKeyId: async () => 'safety-1', getMacKey: async () => Buffer.alloc(32, 51) },
    clock: () => Date.parse('2026-10-02T12:00:00Z'),
    verifyCommittedReservation: async row => ({ ...row, committed: true }), verifySettlement: async row => ({ ...row, verified: true }),
    verifyActivation: async () => true, ...extra };
  const journal = await api.initializeSafetyJournal(options); t.after(() => journal.close().catch(() => {}));
  return { model, api, options, journal };
}
const activate = journal => journal.activate({ projectionDigest: journal.snapshot().projectionDigest, userApproved: true });
const request = () => ({ requestId: crypto.randomUUID(), payloadSha256: sha('synthetic payload'), budgetDay: '2026-10-02',
  priceVersion: 'synthetic-price', reservedMicroUsd: '100' });
test('Windows activation uses explicit slots; restart always reconciles OFF and retains unsettled liability', async t => {
  const f = await journalFixture(t); await activate(f.journal); const input = request();
  const permit = await f.journal.reserveAndPermit(input); assert.equal((await f.journal.consumePermit(permit)).authorized, true);
  assert.ok(f.model.files.has(safetyRoot + '/ai-off.0')); assert.ok(f.model.files.has(safetyRoot + '/ai-off.1'));
  assert.equal(f.model.files.has(safetyRoot + '/ai-off.json'), false);
  await f.journal.close(); const reopened = await f.api.openSafetyJournal(f.options); t.after(() => reopened.close());
  assert.equal(reopened.snapshot().aiOff, true); assert.equal(reopened.snapshot().totalLiabilityMicroUsd, '100');
  assert.equal(reopened.snapshot().requests[0].status, 'UNKNOWN_HELD');
});
test('Windows uncertain reservation cannot issue permit and preserves liability floor', async t => {
  const f = await journalFixture(t); await activate(f.journal);
  f.model.setFault(({ file }) => { if (file.endsWith('events.log')) throw new Error('synthetic flush ACK loss'); });
  await assert.rejects(f.journal.reserveAndPermit(request()));
  assert.equal(f.journal.snapshot().recoveryOnly, true); assert.equal(f.journal.snapshot().totalLiabilityMicroUsd, '100');
  assert.equal(f.journal.snapshot().requests[0].status, 'UNKNOWN_HELD');
});
for (const corrupt of ['torn-log', 'missing-slot']) {
  test(`Windows journal refuses ${corrupt} after restart`, async t => {
    const f = await journalFixture(t); await f.journal.close();
    if (corrupt === 'missing-slot') f.model.files.delete(safetyRoot + '/ai-off.0');
    else { const file = safetyRoot + '/ai-journal/events.log'; const entry = f.model.files.get(file); f.model.replace(file, Buffer.concat([entry.bytes, Buffer.from([0])])); }
    await assert.rejects(f.api.openSafetyJournal(f.options));
  });
}
test('Windows native ownership loss immediately revokes permits and marks recovery-only', async t => {
  const f = await journalFixture(t); await activate(f.journal); const permit = await f.journal.reserveAndPermit(request());
  f.model.lose(); assert.equal(f.journal.snapshot().recoveryOnly, true); assert.equal(f.journal.snapshot().aiOff, true);
  await assert.rejects(f.journal.consumePermit(permit));
});
test('Windows DPAPI adapter requires ready Electron and available encryption on every operation', () => {
  const model = createStorageModel(); const api = model.load('safety-lifecycle.cjs'); const storage = safeStorage(); let ready = false;
  const electronApp = { isReady: () => ready };
  assert.throws(() => api.createSafeStorageWrapper(storage, { electronApp }), { code: 'SAFETY_STORAGE_UNAVAILABLE' });
  ready = true; const port = api.createSafeStorageWrapper(storage, { electronApp }); const bytes = port.wrap(Buffer.from('synthetic'));
  assert.equal(port.unwrap(bytes).toString(), 'synthetic'); ready = false;
  assert.throws(() => port.unwrap(bytes), { code: 'SAFETY_STORAGE_UNAVAILABLE' });
});
test('immutable Windows secrets invoke dependent enrollment exactly once and refuse missing established identity', async () => {
  const model = createStorageModel(); const api = model.load('safety-lifecycle.cjs'); let calls = 0;
  const options = { userData: root, safeStorage: safeStorage(), electronApp: { isReady: () => true }, windowsBoundary: model.boundary,
    initializeEnrollment: async secrets => { calls++; assert.ok(secrets.localIdentity); } };
  const first = await api.loadDesktopSecrets(options); const second = await api.loadDesktopSecrets(options);
  assert.equal(first.localIdentity, second.localIdentity); assert.equal(calls, 1);
  model.files.delete(root + '/secrets.enc'); model.directories.add(safetyRoot);
  await assert.rejects(api.loadDesktopSecrets(options), { code: 'SAFETY_IDENTITY_UNAVAILABLE' }); assert.equal(calls, 1);
});
test('failed dependent enrollment is not replayed as a fresh empty store on restart', async () => {
  const model = createStorageModel(); const api = model.load('safety-lifecycle.cjs'); let calls = 0;
  const options = { userData: root, safeStorage: safeStorage(), electronApp: { isReady: () => true }, windowsBoundary: model.boundary,
    initializeEnrollment: async () => { calls++; throw new Error('synthetic dependent enrollment failure'); } };
  await assert.rejects(api.loadDesktopSecrets(options)); assert.ok(model.files.has(root + '/secrets.enc'));
  await api.loadDesktopSecrets(options); assert.equal(calls, 1);
});
test('Windows lifecycle preserves authenticated enrollment and opens keys before journal without POSIX IO', async () => {
  const model = createStorageModel();
  const api = model.load('safety-lifecycle.cjs', { './purpose-keyring.cjs': model.load('purpose-keyring.cjs'), './safety-journal.cjs': model.load('safety-journal.cjs') });
  const options = { userData: root, safeStorage: safeStorage(), electronApp: { isReady: () => true }, windowsBoundary: model.boundary,
    installationId: 'synthetic', runningBuild: '100', ownerLocks: model.ownerLocks };
  const first = await api.openSafetyLifecycle(options); assert.equal(first.diagnostics().aiOff, true); await first.close();
  const reopened = await api.openSafetyLifecycle(options); await reopened.close();
  model.files.delete(safetyRoot + '/purpose-keyring/purpose-keyring.wrapped');
  await assert.rejects(api.openSafetyLifecycle(options), { code: 'SAFETY_RECOVERY_REQUIRED' });
});

test('immutable purpose enrollment precedes key generation and survives interrupted first publication', async () => {
  const model = createStorageModel(); const api = model.load('purpose-keyring.cjs');
  const options = { safetyRoot, restoreRoots: [root + '/data'], installationId: 'synthetic', wrapper: wrapper(),
    windowsBoundary: model.boundary, ownerLocks: model.ownerLocks };
  model.setFault(({ file }) => { assert.equal(file, safetyRoot + '/purpose-keyring.enrollment'); throw new Error('synthetic enrollment interruption'); });
  await assert.rejects(api.initializePurposeKeyring(options));
  assert.ok(model.files.has(safetyRoot + '/purpose-keyring.enrollment'));
  assert.equal(model.directories.has(safetyRoot + '/purpose-keyring'), false);
  model.setFault(null); await assert.rejects(api.initializePurposeKeyring(options)); await assert.rejects(api.openPurposeKeyring(options));
});
test('missing established purpose enrollment refuses intact wrapped key snapshots', async t => {
  const f = await keyFixture(t); await f.keyring.close(); f.model.files.delete(safetyRoot + '/purpose-keyring.enrollment');
  await assert.rejects(f.api.openPurposeKeyring(f.options));
});
test('native maintenance receipt and exact retry flush stable journal before acknowledgement', async t => {
  const f = await journalFixture(t, { verifyMaintenanceSeal: async (_snapshot, metadata) => ({ ...metadata, verified: true }),
    verifyMaintenanceCompletion: async (_snapshot, metadata) => ({ ...metadata, verified: true }) });
  const metadata = { transactionId: crypto.randomUUID(), kind: 'RESTORE', payloadSha256: sha('synthetic backup'),
    pgProjectionDigest: sha('synthetic projection'), legacyLiabilityUnresolved: false, budgetDay: '2026-10-02', minimumVersion: '80' };
  const receipt = await f.journal.sealMaintenance(metadata); assert.equal(receipt.pendingMaintenance.transactionId, metadata.transactionId);
  let flushes = 0; f.model.setFault(({ file }) => { if (file.endsWith('events.log')) flushes++; });
  const retry = await f.journal.sealMaintenance(metadata); assert.equal(retry.sequence, receipt.sequence); assert.equal(flushes, 1);
  const completed = await f.journal.completeMaintenance(metadata); assert.equal(completed.pendingMaintenance, null);
  assert.equal(completed.minimumVersion, '80'); await f.journal.close();
  const reopened = await f.api.openSafetyJournal(f.options); t.after(() => reopened.close());
  assert.equal(reopened.snapshot().maintenanceReceipt.transactionId, metadata.transactionId);
  assert.equal(reopened.snapshot().minimumVersion, '80'); assert.equal(reopened.snapshot().aiOff, true);
});
test('native settlement publishes authenticated receipt only after flush and preserves uncertain full hold', async t => {
  const f = await journalFixture(t); await activate(f.journal); const input = request(); await f.journal.reserveAndPermit(input);
  f.model.setFault(({ file }) => { if (file.endsWith('events.log')) throw new Error('synthetic settlement flush ACK loss'); });
  await assert.rejects(f.journal.settle({ requestId: input.requestId, payloadSha256: input.payloadSha256,
    actualMicroUsd: '40', proofSha256: sha('synthetic usage') }));
  assert.equal(f.journal.snapshot().requests[0].status, 'UNKNOWN_HELD'); assert.equal(f.journal.snapshot().totalLiabilityMicroUsd, '100');
});

