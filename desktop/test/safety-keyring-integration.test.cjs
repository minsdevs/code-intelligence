'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { initializePurposeKeyring, openPurposeKeyring } = require('../src/purpose-keyring.cjs');
const { initializeSafetyJournal, openSafetyJournal } = require('../src/safety-journal.cjs');

// Synthetic authenticated wrapper only. Does not use Electron, a real keychain, or installed data.
function wrapper() {
  const wrappingKey = Buffer.alloc(32, 93);
  return {
    async isAvailable() { return true; },
    async wrap(bytes) {
      const nonce = crypto.randomBytes(12);
      const cipher = crypto.createCipheriv('aes-256-gcm', wrappingKey, nonce);
      cipher.setAAD(Buffer.from('synthetic-safety-keyring-interop'));
      return Buffer.concat([nonce, cipher.update(bytes), cipher.final(), cipher.getAuthTag()]);
    },
    async unwrap(bytes) {
      const decipher = crypto.createDecipheriv('aes-256-gcm', wrappingKey, bytes.subarray(0, 12));
      decipher.setAAD(Buffer.from('synthetic-safety-keyring-interop')); decipher.setAuthTag(bytes.subarray(-16));
      return Buffer.concat([decipher.update(bytes.subarray(12, -16)), decipher.final()]);
    },
  };
}
const sha = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
function assertCleared(issued) {
  assert.ok(issued.length > 0, 'The real adapter must have issued key copies.');
  for (const key of issued) assert.equal(key.every(byte => byte === 0), true, 'A transferred key copy retained material.');
}
async function fixture(t) {
  const root = await fs.mkdtemp(path.join(await fs.realpath(os.tmpdir()), 'ci-safety-key-interop-'));
  await fs.chmod(root, 0o700);
  const options = { safetyRoot: path.join(root, 'safety'), restoreRoots: [path.join(root, 'data')],
    installationId: 'synthetic-keyring_journal-interop', wrapper: wrapper() };
  const holder = { keyring: null }; const keyrings = []; const journals = []; const issued = [];
  t.after(async () => {
    for (const journal of journals) await journal.close().catch(() => {});
    for (const keyring of keyrings) await keyring.close().catch(() => {});
    await fs.rm(root, { recursive: true, force: true });
  });
  holder.keyring = await initializePurposeKeyring(options); keyrings.push(holder.keyring);
  const journalOptions = { ...options, runningBuild: '100',
    keyProvider: {
      currentKeyId: purpose => holder.keyring.currentKeyId(purpose),
      async getMacKey(id, purpose) {
        const ownedCopy = await holder.keyring.getMacKey(id, purpose);
        issued.push(ownedCopy); return ownedCopy;
      },
    },
    clock: () => Date.parse('2026-10-03T12:00:00Z'),
    verifyCommittedReservation: async request => ({ ...request, committed: true }),
    verifySettlement: async settlement => ({ ...settlement, verified: true }),
    verifyActivation: async () => true,
  };
  const f = { options, journalOptions, issued, holder,
    log: path.join(options.safetyRoot, 'ai-journal', 'events.log'),
    async initialize() { const journal = await initializeSafetyJournal(journalOptions); journals.push(journal); return journal; },
    async open() { const journal = await openSafetyJournal(journalOptions); journals.push(journal); return journal; },
    async reopenKeyring() {
      await holder.keyring.close(); holder.keyring = await openPurposeKeyring(options); keyrings.push(holder.keyring); return holder.keyring;
    },
  };
  return f;
}
function request() {
  return { requestId: crypto.randomUUID(), payloadSha256: sha('synthetic approved request'), budgetDay: '2026-10-03',
    priceVersion: 'synthetic-price-1', reservedMicroUsd: '100' };
}
async function keyDigest(keyring, id) {
  const copy = await keyring.getMacKey(id, 'safety');
  try { return sha(copy); } finally { copy.fill(0); }
}

test('real keyring journal signing, rotation, replay and close clear transferred copies while preserving retained keys', async t => {
  const f = await fixture(t); const firstId = await f.holder.keyring.currentKeyId('safety');
  const firstDigest = await keyDigest(f.holder.keyring, firstId);
  let journal = await f.initialize(); assertCleared(f.issued);
  await journal.activate({ projectionDigest: journal.snapshot().projectionDigest, userApproved: true });
  const reserved = request(); const permit = await journal.reserveAndPermit(reserved); await journal.consumePermit(permit);
  await journal.settle({ requestId: reserved.requestId, payloadSha256: reserved.payloadSha256,
    actualMicroUsd: '40', proofSha256: sha('synthetic usage proof') });
  assertCleared(f.issued); assert.equal(await keyDigest(f.holder.keyring, firstId), firstDigest);

  const rotatedId = await f.holder.keyring.rotate('safety'); assert.notEqual(rotatedId, firstId);
  const rotatedDigest = await keyDigest(f.holder.keyring, rotatedId);
  await journal.latch(); assertCleared(f.issued); await journal.close();
  await f.reopenKeyring();
  const beforeReplay = f.issued.length; journal = await f.open();
  assert.ok(f.issued.length > beforeReplay); assertCleared(f.issued);
  assert.equal(journal.snapshot().totalLiabilityMicroUsd, '40'); assert.equal(journal.snapshot().aiOff, true);
  assert.equal(await keyDigest(f.holder.keyring, firstId), firstDigest);
  assert.equal(await keyDigest(f.holder.keyring, rotatedId), rotatedDigest);
  await journal.close(); await f.holder.keyring.close(); assertCleared(f.issued);
});

test('MAC verification failure clears real keyring copies and retains usable original verification keys', async t => {
  const f = await fixture(t); const id = await f.holder.keyring.currentKeyId('safety');
  const originalDigest = await keyDigest(f.holder.keyring, id);
  const journal = await f.initialize(); await journal.close();
  const originalLog = await fs.readFile(f.log);
  const frameSize = originalLog.readUInt32BE(0); const frame = JSON.parse(originalLog.subarray(4, 4 + frameSize));
  frame.mac = (frame.mac[0] === '0' ? '1' : '0') + frame.mac.slice(1);
  const encoded = Buffer.from(JSON.stringify(frame)); assert.equal(encoded.length, frameSize);
  const damaged = Buffer.from(originalLog); encoded.copy(damaged, 4); await fs.writeFile(f.log, damaged);
  const beforeFailure = f.issued.length;
  await assert.rejects(f.open(), error => error.code === 'MAC_INVALID' && error.aiOff && error.recoveryOnly);
  assert.ok(f.issued.length > beforeFailure); assertCleared(f.issued);
  assert.deepEqual(await fs.readFile(f.log), damaged);
  assert.equal(await keyDigest(f.holder.keyring, id), originalDigest);

  // Test-only repair restores the exact saved synthetic bytes; production never repairs/truncates a log.
  await fs.writeFile(f.log, originalLog); await f.reopenKeyring();
  const recovered = await f.open(); assertCleared(f.issued);
  assert.equal(recovered.snapshot().aiOff, true); assert.equal(await keyDigest(f.holder.keyring, id), originalDigest);
});

test('unavailable real keyring fails journal operations closed after all previously issued copies were cleared', async t => {
  const f = await fixture(t); const journal = await f.initialize(); assertCleared(f.issued);
  await f.holder.keyring.close();
  await assert.rejects(journal.latch(), error => error.code === 'KEY_UNAVAILABLE' && error.aiOff && error.recoveryOnly);
  assert.equal(journal.snapshot().aiOff, true); assert.equal(journal.snapshot().recoveryOnly, true);
  assertCleared(f.issued);
});
