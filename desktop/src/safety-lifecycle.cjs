'use strict';

// Main process only. The optional gateway factory is code-owned; it is never renderer input.
const crypto = require('node:crypto');
const fs = require('node:fs/promises');
const { constants } = require('node:fs');
const path = require('node:path');
const { initializePurposeKeyring, openPurposeKeyring } = require('./purpose-keyring.cjs');
const { initializeSafetyJournal, openSafetyJournal } = require('./safety-journal.cjs');

const ENROLLMENT_FILE = '.safety-enrollment.json';
const MAX_BUILD = 9223372036854775807n;
const MESSAGES = Object.freeze({
  SAFETY_BUILD_SEQUENCE_INVALID: 'The bundled runtime has no valid safety build sequence. Install a reviewed build.',
  SAFETY_STORAGE_UNAVAILABLE: 'Secure desktop storage is unavailable. Existing identity and keys were not replaced.',
  SAFETY_IDENTITY_UNAVAILABLE: 'The existing desktop identity cannot be opened. Offline recovery is required.',
  SAFETY_RECOVERY_REQUIRED: 'Desktop safety state requires offline recovery. Normal startup is blocked.',
  DESKTOP_AI_SAFETY_UNAVAILABLE: 'Desktop AI is unavailable until the safety and budget gateway is complete.',
});

class SafetyLifecycleError extends Error {
  constructor(code) {
    const safeCode = Object.hasOwn(MESSAGES, code) ? code : 'SAFETY_RECOVERY_REQUIRED';
    super(MESSAGES[safeCode]);
    this.name = 'SafetyLifecycleError';
    this.code = safeCode;
    this.aiOff = true;
    this.recoveryOnly = true;
  }
}
function fail(code = 'SAFETY_RECOVERY_REQUIRED') { throw new SafetyLifecycleError(code); }
function safeError(error, fallback = 'SAFETY_RECOVERY_REQUIRED') {
  return new SafetyLifecycleError(error instanceof SafetyLifecycleError ? error.code : fallback);
}
function requireBuildSequence(value) {
  if (typeof value !== 'string' || value.match(/^(0|[1-9][0-9]{0,18})$/)?.[0] !== value
      || BigInt(value) > MAX_BUILD) fail('SAFETY_BUILD_SEQUENCE_INVALID');
  return value;
}
function identity(value) {
  if (typeof value !== 'string' || value.match(/^[A-Za-z0-9_-]{1,128}$/)?.[0] !== value)
    fail('SAFETY_IDENTITY_UNAVAILABLE');
  return value;
}
function requireSecureStorage(storage) {
  // The packaged product currently targets macOS. In particular, Linux basic_text is never accepted.
  try {
    if (process.platform !== 'darwin' || !storage || storage.isEncryptionAvailable() !== true
        || typeof storage.encryptString !== 'function' || typeof storage.decryptString !== 'function')
      fail('SAFETY_STORAGE_UNAVAILABLE');
  } catch { fail('SAFETY_STORAGE_UNAVAILABLE'); }
}
function createSafeStorageWrapper(storage) {
  requireSecureStorage(storage);
  const magic = Buffer.from('CIPKR001');
  const domain = Buffer.from('code-intelligence-purpose-keyring-aead-v1\0');
  const prefix = 'code-intelligence-purpose-dek:v1:';
  return Object.freeze({
    isAvailable() { requireSecureStorage(storage); return true; },
    wrap(bytes) {
      requireSecureStorage(storage);
      if (!Buffer.isBuffer(bytes) || !bytes.length || bytes.length > 32768) fail('SAFETY_STORAGE_UNAVAILABLE');
      const dek = crypto.randomBytes(32); const nonce = crypto.randomBytes(12);
      let wrapped; let encrypted; let tail;
      try {
        wrapped = storage.encryptString(prefix + dek.toString('base64'));
        if (!Buffer.isBuffer(wrapped) || !wrapped.length || wrapped.length > 8192) fail('SAFETY_STORAGE_UNAVAILABLE');
        const header = Buffer.alloc(16); magic.copy(header);
        header.writeUInt32BE(wrapped.length, 8); header.writeUInt32BE(bytes.length, 12);
        const cipher = crypto.createCipheriv('aes-256-gcm', dek, nonce);
        cipher.setAAD(Buffer.concat([domain, header, wrapped]));
        encrypted = cipher.update(bytes); tail = cipher.final();
        return Buffer.concat([header, wrapped, nonce, encrypted, tail, cipher.getAuthTag()]);
      } catch { fail('SAFETY_STORAGE_UNAVAILABLE'); }
      finally { dek.fill(0); wrapped?.fill(0); encrypted?.fill(0); tail?.fill(0); }
    },
    unwrap(bytes) {
      requireSecureStorage(storage);
      let dek; let partial; let tail;
      try {
        if (!Buffer.isBuffer(bytes) || bytes.length < 46 || bytes.length > 41004
            || !bytes.subarray(0, 8).equals(magic)) fail('SAFETY_STORAGE_UNAVAILABLE');
        const wrappedLength = bytes.readUInt32BE(8); const plaintextLength = bytes.readUInt32BE(12);
        if (wrappedLength < 1 || wrappedLength > 8192 || plaintextLength < 1 || plaintextLength > 32768
            || bytes.length !== 16 + wrappedLength + 12 + plaintextLength + 16) fail('SAFETY_STORAGE_UNAVAILABLE');
        const header = bytes.subarray(0, 16); const wrapped = bytes.subarray(16, 16 + wrappedLength);
        const nonceOffset = 16 + wrappedLength; const ciphertextOffset = nonceOffset + 12;
        const plaintext = storage.decryptString(wrapped);
        if (typeof plaintext !== 'string' || !plaintext.startsWith(prefix) || plaintext.length !== prefix.length + 44)
          fail('SAFETY_STORAGE_UNAVAILABLE');
        const encoded = plaintext.slice(prefix.length);
        dek = Buffer.from(encoded, 'base64');
        if (dek.length !== 32 || dek.toString('base64') !== encoded)
          fail('SAFETY_STORAGE_UNAVAILABLE');
        const decipher = crypto.createDecipheriv('aes-256-gcm', dek, bytes.subarray(nonceOffset, ciphertextOffset));
        decipher.setAAD(Buffer.concat([domain, header, wrapped]));
        decipher.setAuthTag(bytes.subarray(-16));
        partial = decipher.update(bytes.subarray(ciphertextOffset, -16)); tail = decipher.final();
        // No unauthenticated partial plaintext is returned when final() rejects.
        return Buffer.concat([partial, tail]);
      } catch { fail('SAFETY_STORAGE_UNAVAILABLE'); }
      finally { dek?.fill(0); partial?.fill(0); tail?.fill(0); }
    },
  });
}
async function statOrMissing(file) {
  try { return await fs.lstat(file, { bigint: true }); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}
function privateStat(stat, directory = false) {
  if (!stat || stat.isSymbolicLink() || (directory ? !stat.isDirectory() : !stat.isFile())
      || typeof process.getuid !== 'function' || stat.uid !== BigInt(process.getuid())
      || (stat.mode & 0o7777n) !== (directory ? 0o700n : 0o600n)
      || (!directory && stat.nlink !== 1n)) fail();
}
function sameState(a, b) {
  return a.dev === b.dev && a.ino === b.ino && a.size === b.size
    && a.mtimeNs === b.mtimeNs && a.ctimeNs === b.ctimeNs;
}
async function userDataRoot(input) {
  if (typeof input !== 'string' || !path.isAbsolute(input) || input.includes('\0')
      || path.resolve(input) !== input || path.parse(input).root === input) fail();
  let stat = await statOrMissing(input);
  if (!stat) {
    await fs.mkdir(input, { recursive: true, mode: 0o700 });
    stat = await fs.lstat(input, { bigint: true });
  }
  privateStat(stat, true);
  const canonical = await fs.realpath(input);
  const actual = await fs.lstat(canonical, { bigint: true });
  privateStat(actual, true);
  if (actual.dev !== stat.dev || actual.ino !== stat.ino) fail();
  return canonical;
}
async function syncDirectory(directory) {
  const before = await fs.lstat(directory, { bigint: true }); privateStat(before, true);
  const handle = await fs.open(directory, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  try {
    const opened = await handle.stat({ bigint: true }); privateStat(opened, true);
    if (opened.dev !== before.dev || opened.ino !== before.ino) fail();
    await handle.sync();
  } finally { await handle.close(); }
}
async function readPrivate(file, maximum) {
  const before = await fs.lstat(file, { bigint: true }); privateStat(before);
  if (before.size < 1n || before.size > BigInt(maximum)) fail();
  const handle = await fs.open(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  let bytes;
  try {
    const opened = await handle.stat({ bigint: true }); privateStat(opened);
    if (!sameState(before, opened)) fail();
    bytes = Buffer.alloc(Number(opened.size));
    let offset = 0;
    while (offset < bytes.length) {
      const { bytesRead } = await handle.read(bytes, offset, bytes.length - offset, offset);
      if (!bytesRead) fail();
      offset += bytesRead;
    }
    const after = await handle.stat({ bigint: true });
    const current = await fs.lstat(file, { bigint: true }); privateStat(current);
    if (!sameState(opened, after) || !sameState(after, current)) fail();
    return bytes;
  } catch (error) { bytes?.fill(0); throw error; }
  finally { await handle.close(); }
}
async function writeFresh(file, bytes) {
  const handle = await fs.open(file, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  try {
    privateStat(await handle.stat({ bigint: true }));
    await handle.writeFile(bytes);
    await handle.sync();
  } finally { await handle.close(); }
  // Never remove failed/partial publications: their presence forbids a new identity or enrollment.
  await syncDirectory(path.dirname(file));
}
function validateSecrets(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
      || Object.keys(value).sort().join(',') !== 'databasePassword,localIdentity,tokenEncryptionKey'
      || typeof value.databasePassword !== 'string'
      || value.databasePassword.match(/^[A-Za-z0-9_-]{32,128}$/)?.[0] !== value.databasePassword
      || typeof value.tokenEncryptionKey !== 'string') fail('SAFETY_IDENTITY_UNAVAILABLE');
  identity(value.localIdentity);
  const key = Buffer.from(value.tokenEncryptionKey, 'base64');
  try {
    if (key.length !== 32 || key.toString('base64') !== value.tokenEncryptionKey) fail('SAFETY_IDENTITY_UNAVAILABLE');
  } finally { key.fill(0); }
  return value;
}

// The legacy database/credential secrets stay in main. They are not purpose-keyring capabilities.
async function loadDesktopSecrets({ userData, safeStorage }) {
  try {
    requireSecureStorage(safeStorage);
    const root = await userDataRoot(userData);
    const file = path.join(root, 'secrets.enc');
    if (await statOrMissing(file)) {
      const encrypted = await readPrivate(file, 16384);
      try { return validateSecrets(JSON.parse(safeStorage.decryptString(encrypted))); }
      finally { encrypted.fill(0); }
    }
    for (const evidence of [ENROLLMENT_FILE, 'safety', 'postgres', 'data', 'redis', 'recovery', 'backup-maintenance', 'authorized-paths.enc']) {
      if (await statOrMissing(path.join(root, evidence))) fail('SAFETY_IDENTITY_UNAVAILABLE');
    }
    const secrets = { localIdentity: crypto.randomUUID(), databasePassword: crypto.randomBytes(36).toString('base64url'),
      tokenEncryptionKey: crypto.randomBytes(32).toString('base64') };
    const encrypted = safeStorage.encryptString(JSON.stringify(secrets));
    if (!Buffer.isBuffer(encrypted) || !encrypted.length || encrypted.length > 16384) fail('SAFETY_STORAGE_UNAVAILABLE');
    try { await writeFresh(file, encrypted); }
    finally { encrypted.fill(0); }
    return secrets;
  } catch (error) { throw safeError(error, 'SAFETY_IDENTITY_UNAVAILABLE'); }
}

async function openSafetyLifecycle({ userData, safeStorage, installationId, runningBuild, createGateway,
  createBackupRuntime, recoveryMode = false, ownerLocks }) {
  let keyring; let journal; let gateway; let backupRuntime;
  try {
    // Validate before creating userData, a marker, or any key material. No build-number fallback.
    requireBuildSequence(runningBuild); identity(installationId);
    if (typeof recoveryMode !== 'boolean' || (createBackupRuntime !== undefined && typeof createBackupRuntime !== 'function')
        || (recoveryMode && typeof createBackupRuntime !== 'function')) fail();
    const wrapper = createSafeStorageWrapper(safeStorage);
    const root = await userDataRoot(userData);
    const safetyRoot = path.join(root, 'safety');
    const marker = path.join(root, ENROLLMENT_FILE);
    const markerPresent = await statOrMissing(marker);
    const safetyPresent = await statOrMissing(safetyRoot);
    const maintenancePresent = await statOrMissing(path.join(root, 'backup-maintenance'));
    if (maintenancePresent && (!markerPresent || !safetyPresent)) fail();
    if (recoveryMode && (!markerPresent || !safetyPresent)) fail();
    let freshEnrollmentAllowed = !markerPresent && !safetyPresent
      && !(await statOrMissing(path.join(root, 'postgres')))
      && !(await statOrMissing(path.join(root, 'data')))
      && !(await statOrMissing(path.join(root, 'recovery')))
      && !(await statOrMissing(path.join(root, 'redis')))
      && !(await statOrMissing(path.join(root, 'authorized-paths.enc')));
    const enrollment = JSON.stringify({ format: 'code-intelligence-safety-enrollment', major: 1, installationId });
    if (markerPresent) {
      const bytes = await readPrivate(marker, 16384);
      try {
        const raw = bytes.toString('utf8');
        if (raw === enrollment) freshEnrollmentAllowed = false;
        else {
          const value = JSON.parse(raw);
          if (JSON.stringify(value) !== raw || Object.keys(value).sort().join(',') !== 'format,installationId,major,originProof'
              || value.format !== 'code-intelligence-safety-enrollment' || value.major !== 2
              || value.installationId !== installationId || typeof value.originProof !== 'string') fail();
          const encrypted = Buffer.from(value.originProof, 'base64'); let origin;
          try {
            if (encrypted.toString('base64') !== value.originProof) fail();
            origin = wrapper.unwrap(encrypted);
            const proof = JSON.parse(origin.toString('utf8'));
            if (Object.keys(proof).sort().join(',') !== 'format,freshEnrollmentAllowed,installationId,major'
                || proof.format !== 'code-intelligence-safety-origin' || proof.major !== 1
                || proof.installationId !== installationId || typeof proof.freshEnrollmentAllowed !== 'boolean') fail();
            freshEnrollmentAllowed = proof.freshEnrollmentAllowed;
          } finally { encrypted.fill(0); origin?.fill(0); }
        }
      }
      finally { bytes.fill(0); }
      if (!safetyPresent) fail();
    } else {
      if (safetyPresent) fail();
      // Outside both A and B: loss of the entire B directory cannot masquerade as first enrollment.
      // Authenticate the original eligibility in that same publication, so a normal restart before
      // the first budget read does not turn a new strict installation into an ambiguous legacy one.
      const origin = Buffer.from(JSON.stringify({ format: 'code-intelligence-safety-origin', major: 1,
        installationId, freshEnrollmentAllowed }));
      let encrypted;
      try {
        encrypted = wrapper.wrap(origin);
        await writeFresh(marker, Buffer.from(JSON.stringify({ format: 'code-intelligence-safety-enrollment', major: 2,
          installationId, originProof: encrypted.toString('base64') })));
      } finally { origin.fill(0); encrypted?.fill(0); }
    }
    // Current product DB is postgres/ (PG_VERSION at that root); data/ contains repo staging.
    // Selected archive paths never become keyring or journal roots.
    const restoreRoots = ['postgres', 'data', 'recovery'].map(name => path.join(root, name));
    const options = { safetyRoot, restoreRoots, installationId, wrapper, ...(ownerLocks ? { ownerLocks } : {}) };
    keyring = await (markerPresent ? openPurposeKeyring : initializePurposeKeyring)(options);
    const rejectVerification = async () => false;
    let journalOpened = false;
    const openJournal = async callbacks => {
      if (journalOpened) fail();
      journalOpened = true;
      journal = await (markerPresent ? openSafetyJournal : initializeSafetyJournal)({
        ...callbacks, safetyRoot, restoreRoots, installationId, runningBuild, recoveryMode, keyProvider: keyring,
        ...(ownerLocks ? { ownerLocks } : {}),
      });
      return journal;
    };
    if (createGateway !== undefined) {
      if (typeof createGateway !== 'function') fail();
      gateway = await createGateway(Object.freeze({ openJournal, freshEnrollmentAllowed, recoveryMode }));
      if (!gateway || typeof gateway.close !== 'function' || typeof gateway.latchOffline !== 'function') fail();
    } else {
      await openJournal({ verifyCommittedReservation: rejectVerification, verifySettlement: rejectVerification,
        verifyActivation: rejectVerification });
    }
    const initial = journal.snapshot();
    if (initial.major !== 1 || initial.installationId !== installationId || initial.recoveryOnly
        || ((!recoveryMode) && (initial.pendingRestore || initial.pendingMaintenance)) || initial.aiOff !== true
        || BigInt(requireBuildSequence(initial.minimumVersion)) > BigInt(runningBuild)) fail();

    let failed = false; let closing = false; let closePromise;
    const diagnostics = () => {
      let recoveryOnly = failed || closing || recoveryMode;
      try {
        const state = journal.snapshot();
        recoveryOnly ||= state.recoveryOnly || Boolean(state.pendingRestore) || Boolean(state.pendingMaintenance) || (!gateway && state.aiOff !== true);
      } catch { recoveryOnly = true; }
      return Object.freeze({ aiOff: gateway ? gateway.diagnostics().aiOff : true, recoveryOnly: Boolean(recoveryOnly) });
    };
    if (createBackupRuntime) {
      const keyProvider = Object.freeze({
        currentKeyId(purpose) {
          if (purpose !== 'backup') return Promise.reject(new SafetyLifecycleError('SAFETY_RECOVERY_REQUIRED'));
          return keyring.currentKeyId('backup');
        },
        getBackupKey(id) { return keyring.getBackupKey(id); },
      });
      const journalHooks = Object.freeze({ snapshot: journal.snapshot,
        sealMaintenance: journal.sealMaintenance, completeMaintenance: journal.completeMaintenance });
      const createdBackup = await createBackupRuntime(Object.freeze({ keyProvider, journal: journalHooks,
        readSafetyState: () => Object.freeze({ ...diagnostics(), closing }) }));
      if (!createdBackup || typeof createdBackup.close !== 'function') fail();
      backupRuntime = createdBackup;
    }
    return Object.freeze({
      diagnostics,
      async latch(reason = 'USER_OFF') {
        if (closing || failed || !['USER_OFF', 'RESTART_RECONCILIATION', 'RESTORE'].includes(reason)) fail();
        try { if (gateway) await gateway.latchOffline(reason); else await journal.latch(reason); return diagnostics(); }
        catch { failed = true; fail(); }
      },
      denyAdmission() {
        const error = new SafetyLifecycleError('DESKTOP_AI_SAFETY_UNAVAILABLE');
        error.recoveryOnly = diagnostics().recoveryOnly;
        throw error;
      },
      close() {
        if (closePromise) return closePromise;
        closing = true;
        closePromise = (async () => {
          let failure;
          // An unresolved backup drain may still use both key copies and the journal. Keep their
          // ownership on failure instead of releasing B out from under that operation.
          try { await backupRuntime?.close(); } catch { failed = true; fail(); }
          try { if (gateway) await gateway.close(); else await journal.close(); } catch (error) { failure = error; }
          try { await keyring.close(); } catch (error) { failure ||= error; }
          if (failure) { failed = true; fail(); }
        })();
        return closePromise;
      },
    });
  } catch (error) {
    // Journal may still need keys while draining queued writes. Always close it first.
    if (backupRuntime) {
      try { await backupRuntime.close(); } catch { throw safeError(error); }
    }
    if (gateway) await gateway.close().catch(() => {});
    else if (journal) await journal.close().catch(() => {});
    if (keyring) await keyring.close().catch(() => {});
    throw safeError(error);
  }
}

module.exports = Object.freeze({ loadDesktopSecrets, openSafetyLifecycle, requireBuildSequence,
  createSafeStorageWrapper, SafetyLifecycleError });
