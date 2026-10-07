'use strict';
// G-UPDATE anti-rollback with the real area-B modules (safety lifecycle, purpose keyring,
// safety journal) on synthetic temporary profiles. Existing coverage this does not repeat:
// safety-journal.test.cjs "build-sequence high-water ... does not regress with old backups",
// "maintenance completion cannot ... lower high-water values"; safety-lifecycle.test.cjs
// "persisted minimum build above the running build blocks normal startup without resetting B";
// backup-payload.test.cjs "newer minimum build"; backup-recovery-records.test.cjs older-build refusal.
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const lifecycle = require('../src/safety-lifecycle.cjs');
const keyrings = require('../src/purpose-keyring.cjs');
const journals = require('../src/safety-journal.cjs');
const manifests = require('../src/update-manifest.cjs');

const darwin = { skip: process.platform !== 'darwin' };
const INSTALLATION = 'synthetic-update-installation';
function storage() {
  // Synthetic string encryption only; never Electron safeStorage or an OS keychain.
  const key = crypto.randomBytes(32);
  return {
    isEncryptionAvailable: () => true,
    encryptString(value) {
      const nonce = crypto.randomBytes(12), cipher = crypto.createCipheriv('aes-256-gcm', key, nonce);
      return Buffer.concat([nonce, cipher.update(value, 'utf8'), cipher.final(), cipher.getAuthTag()]);
    },
    decryptString(bytes) {
      const cipher = crypto.createDecipheriv('aes-256-gcm', key, bytes.subarray(0, 12)); cipher.setAuthTag(bytes.subarray(-16));
      return Buffer.concat([cipher.update(bytes.subarray(12, -16)), cipher.final()]).toString('utf8');
    },
  };
}
async function profile(t) {
  const root = await fs.mkdtemp(path.join(await fs.realpath(os.tmpdir()), 'ci-update-rollback-')); await fs.chmod(root, 0o700);
  const safeStorage = storage(), opened = [];
  t.after(async () => { for (const item of opened) await item.close().catch(() => {}); await fs.rm(root, { recursive: true, force: true }); });
  return { root,
    async start(runningBuild) {
      const handle = await lifecycle.openSafetyLifecycle({ userData: root, safeStorage, installationId: INSTALLATION, runningBuild });
      opened.push(handle); return handle;
    },
    // A successful normal start: main records the build only after its backend is healthy.
    async run(runningBuild) {
      const handle = await this.start(runningBuild);
      try { return await handle.recordStartedBuild(); } finally { await handle.close(); }
    },
    async journal(runningBuild, action) {
      const options = { safetyRoot: path.join(root, 'safety'), restoreRoots: [path.join(root, 'data')], installationId: INSTALLATION,
        wrapper: lifecycle.createSafeStorageWrapper(safeStorage) };
      const keyring = await keyrings.openPurposeKeyring(options);
      const journal = await journals.openSafetyJournal({ ...options, runningBuild, keyProvider: keyring,
        verifyCommittedReservation: async () => false, verifySettlement: async () => false, verifyActivation: async () => false });
      try { return await action(journal); } finally { await journal.close(); await keyring.close(); }
    },
    log: () => fs.readFile(path.join(root, 'safety/ai-journal/events.log')),
  };
}
const restore = (journal, minimumVersion) => journal.mergeRestore({ restoreId: crypto.randomUUID(), obligations: [],
  budgetDay: new Date().toISOString().slice(0, 10), minimumVersion });

test('downgrade after a recorded high-water: older build is refused, B is not reset, newer build keeps the floor across an older restore', darwin, async t => {
  const p = await profile(t);
  await (await p.start('200')).close();
  // The current product records the floor only through maintenance (backup/restore) merges.
  await p.journal('200', journal => restore(journal, '200'));
  const recorded = await p.log();
  await assert.rejects(p.start('199'), { code: 'SAFETY_RECOVERY_REQUIRED' });
  await assert.rejects(p.start('20'), { code: 'SAFETY_RECOVERY_REQUIRED' }, 'numeric, not lexical, comparison');
  // Opening latches AI OFF (RESTART_RECONCILIATION) before the floor check; B stays append-only.
  const after = await p.log();
  assert(after.length >= recorded.length && after.subarray(0, recorded.length).equals(recorded), 'a refused older build must not reset or rewrite B');
  assert.equal(await p.journal('200', async journal => journal.snapshot().minimumVersion), '200');
  const snapshot = await p.journal('200', async journal => { await restore(journal, '100'); return journal.snapshot(); });
  assert.equal(snapshot.minimumVersion, '200', 'restoring an archive from an older build never lowers the floor');
  const reopened = await p.start('200'); assert.equal(reopened.diagnostics().recoveryOnly, false); await reopened.close();
  await assert.rejects(p.start('199'), { code: 'SAFETY_RECOVERY_REQUIRED' });
});

test('a corrupted safety journal fails closed to recovery-only instead of trusting a reset high-water', darwin, async t => {
  const p = await profile(t);
  await (await p.start('200')).close();
  await p.journal('200', journal => restore(journal, '200'));
  const log = path.join(p.root, 'safety/ai-journal/events.log');
  const bytes = await fs.readFile(log); bytes[bytes.length - 3] ^= 0x01; await fs.writeFile(log, bytes);
  await assert.rejects(p.start('199'), { code: 'SAFETY_RECOVERY_REQUIRED' });
  await assert.rejects(p.start('200'), { code: 'SAFETY_RECOVERY_REQUIRED' }, 'tampering cannot be used to drop the floor');
});

// NU-03: ADR-02 keeps "updater minimumVersion" in area B. A successful normal start of a newer
// build raises the floor, so a manually reinstalled older build cannot open the migrated profile.
test('after a newer build has started on a profile, an older build is refused without a signed recovery manifest', darwin, async t => {
  const p = await profile(t);
  assert.deepEqual({ ...await p.run('200') }, { highWaterBuild: '200', lastManifestSerial: 0 });
  await assert.rejects(p.start('199'), { code: 'SAFETY_RECOVERY_REQUIRED' });
  await assert.rejects(p.start('20'), { code: 'SAFETY_RECOVERY_REQUIRED' }, 'numeric, not lexical, comparison');
  // A newer build whose start fails before its backend is healthy (for example a failed schema
  // migration) never raises the floor, so the previous build can still reopen its data.
  await (await p.start('300')).close();
  const previous = await p.start('200'); assert.equal(previous.diagnostics().recoveryOnly, false);
  assert.equal(previous.updateState().highWaterBuild, '200'); await previous.close();
  assert.equal((await p.run('200')).highWaterBuild, '200', 'restarting the same build is idempotent');
});

const release = crypto.generateKeyPairSync('ed25519'), attacker = crypto.generateKeyPairSync('ed25519');
const CHECKPOINT = '5b1f0a7e-1c2d-4e3f-8a9b-0c1d2e3f4a5b';
function recoveryEnvelope(changes = {}, privateKey = release.privateKey) {
  const now = Date.now();
  return manifests.signManifest({ format: 1, kind: 'recovery', product: 'code-intelligence', bundleId: 'dev.codeintelligence.desktop',
    teamId: 'ABCDE12345', channel: 'stable', serial: 7, issuedAt: now - 60000, expiresAt: now + 86400000, version: '0.1.9',
    buildSequence: '199', platform: 'darwin', arch: 'arm64', minimumSystemVersion: '13.0', compatibleFromBuild: '1',
    schema: { flyway: 27, safetyJournalMajor: 1, backupFormat: 3 },
    artifact: { kind: 'dmg', url: 'https://updates.example.invalid/code-intelligence/0.1.9/app.dmg', size: 1, sha256: 'a'.repeat(64) },
    recovery: { checkpointId: CHECKPOINT, checkpointSchemaFlyway: 27, reason: 'rollback after failed migration' }, ...changes },
  { keyId: 'release-fixture', privateKey });
}
function verify(envelope, handle, runningBuild = '200') {
  return manifests.verifyUpdateManifest(envelope, { pinnedKeys: { 'release-fixture': release.publicKey },
    allowedHosts: ['updates.example.invalid'], now: Date.now(), state: handle.updateState(),
    checkpoint: { id: CHECKPOINT, schemaFlyway: 27, createdByBuild: '199' },
    running: { product: 'code-intelligence', bundleId: 'dev.codeintelligence.desktop', teamId: 'ABCDE12345', platform: 'darwin',
      arch: 'arm64', osVersion: '14.0', buildSequence: runningBuild, schemaFlyway: 27, safetyJournalMajor: 1 } });
}

test('the floor has one sanctioned exception: a verified signed recovery manifest bound to a retained checkpoint, used once', darwin, async t => {
  const p = await profile(t);
  await p.run('200');
  await assert.rejects(p.start('199'), { code: 'SAFETY_RECOVERY_REQUIRED' });
  const newer = await p.start('200');
  assert.throws(() => verify(recoveryEnvelope({}, attacker.privateKey), newer), { code: 'UPDATE_SIGNATURE_INVALID' });
  const verified = verify(recoveryEnvelope(), newer);
  // Only the verifier's own frozen result is accepted; a look-alike object or an update manifest is not.
  await assert.rejects(newer.sanctionRecoveryRollback({ ...verified }), { code: 'SAFETY_RECOVERY_REQUIRED' });
  await assert.rejects(newer.recordAcceptedManifest(verified), { code: 'SAFETY_RECOVERY_REQUIRED' });
  assert.deepEqual({ ...await newer.sanctionRecoveryRollback(verified) }, { highWaterBuild: '199', lastManifestSerial: 7 });
  await assert.rejects(newer.sanctionRecoveryRollback(verified), { code: 'SAFETY_RECOVERY_REQUIRED' }, 'a serial is consumed once');
  assert.throws(() => verify(recoveryEnvelope(), newer), { code: 'UPDATE_MANIFEST_REPLAYED' });
  await newer.close();
  const older = await p.start('199');
  assert.equal(older.diagnostics().recoveryOnly, false);
  await older.close();
  assert.equal(await p.journal('199', async journal => journal.snapshot().rollback.checkpointId), CHECKPOINT, 'the exception stays auditable in B');
  // Running the newer build again restores the floor; the consumed manifest cannot lower it twice.
  await p.run('200');
  await assert.rejects(p.start('199'), { code: 'SAFETY_RECOVERY_REQUIRED' });
  const again = await p.start('200');
  assert.throws(() => verify(recoveryEnvelope(), again), { code: 'UPDATE_MANIFEST_REPLAYED' });
  await again.close();
});

test('restore merges never lower the started-build floor or the consumed manifest serial', darwin, async t => {
  const p = await profile(t);
  await p.run('200');
  const handle = await p.start('200');
  const accepted = manifests.verifyUpdateManifest(manifests.signManifest({ ...JSON.parse(manifests.canonical(recoveryEnvelope().body)),
    kind: 'update', buildSequence: '201', serial: 9, recovery: null }, { keyId: 'release-fixture', privateKey: release.privateKey }),
  { pinnedKeys: { 'release-fixture': release.publicKey }, allowedHosts: ['updates.example.invalid'], now: Date.now(), state: handle.updateState(),
    running: { product: 'code-intelligence', bundleId: 'dev.codeintelligence.desktop', teamId: 'ABCDE12345', platform: 'darwin',
      arch: 'arm64', osVersion: '14.0', buildSequence: '200', schemaFlyway: 27, safetyJournalMajor: 1 } });
  assert.equal((await handle.recordAcceptedManifest(accepted)).lastManifestSerial, 9);
  await handle.close();
  const snapshot = await p.journal('200', async journal => { await restore(journal, '100'); return journal.snapshot(); });
  assert.equal(snapshot.minimumVersion, '200'); assert.equal(snapshot.lastManifestSerial, 9);
});
