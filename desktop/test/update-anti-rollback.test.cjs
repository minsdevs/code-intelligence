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

// NU-03 (missing updater): ADR-02 keeps "updater minimumVersion" in area B. Today only backup/
// restore maintenance raises it, so a plain first start of a newer build leaves the floor at its
// previous value and a manually reinstalled older build still opens the migrated profile.
// This is the executable acceptance criterion for the updater's first-start high-water record.
test('after a newer build has started on a profile, an older build is refused without a signed recovery manifest', {
  ...darwin, todo: 'NU-03: no updater/first-start high-water record exists; downgrade is refused only after a backup or restore',
}, async t => {
  const p = await profile(t);
  await (await p.start('200')).close();
  await assert.rejects(p.start('199'), { code: 'SAFETY_RECOVERY_REQUIRED' });
});
