'use strict';

// Private main composition. No Electron IPC channel exposes this object or its bootstrap.
const crypto = require('node:crypto');
const fs = require('node:fs/promises');
const path = require('node:path');
const { createAiEgress } = require('./ai-egress.cjs');
const { openAiEgressBridge } = require('./ai-egress-bridge.cjs');
const { contractCatalog, SUPPORTED_MODEL } = require('./ai-model-contracts.cjs');
const { createHttpsTransport } = require('./ai-https-transport.cjs');

function fail() { throw new Error('AI gateway unavailable'); }
function exact(value, fields) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
      || Object.keys(value).length !== fields.length || fields.some(key => !Object.hasOwn(value, key))) fail();
}
function decimal(value, positive = false) {
  if (typeof value !== 'string' || !/^(0|[1-9][0-9]{0,18})$/.test(value)
      || BigInt(value) > 9223372036854775807n || (positive && value === '0')) fail();
  return value;
}
function equal(a, b) { if (a !== b) fail(); }
function decryptCredential(value, key) {
  if (!Buffer.isBuffer(key) || key.length !== 32 || value.keyVersion !== 1
      || typeof value.nonceBase64 !== 'string' || typeof value.encryptedKey !== 'string') fail();
  let nonce; let cipher; let partial; let tail;
  try {
    nonce = Buffer.from(value.nonceBase64, 'base64'); cipher = Buffer.from(value.encryptedKey, 'base64');
    if (nonce.length !== 12 || nonce.toString('base64') !== value.nonceBase64
        || cipher.length <= 16 || cipher.length > 16400 || cipher.toString('base64') !== value.encryptedKey) fail();
    const decipher = crypto.createDecipheriv('aes-256-gcm', key, nonce);
    decipher.setAuthTag(cipher.subarray(-16));
    partial = decipher.update(cipher.subarray(0, -16)); tail = decipher.final();
    const joined = Buffer.concat([partial, tail]);
    try {
      const result = new TextDecoder('utf-8', { fatal: true }).decode(joined);
      if (!result || result.length > 4096 || /[\x00-\x20\x7f]/.test(result)) fail();
      return result;
    } finally { joined.fill(0); }
  } catch { fail(); }
  finally { nonce?.fill(0); cipher?.fill(0); partial?.fill(0); tail?.fill(0); }
}

async function openDesktopAiGateway({ installationId, runningBuild, temporaryRoot, tokenEncryptionKey,
  openJournal, freshEnrollmentAllowed, adapter, recoveryMode = false, verifyMaintenanceSeal, verifyMaintenanceCompletion,
  catalog = contractCatalog, transport = createHttpsTransport() }) {
  const mainEpoch = crypto.randomUUID(); let channelEpoch = crypto.randomBytes(32).toString('hex');
  let capability = crypto.randomBytes(32).toString('hex');
  let core; let bridge; let directory; let authority; let closed = false; let closePromise;
  let controlEpoch = 0;
  let activeRequests = 0;
  let rotating = false; let channelFailed = false; let rotationTask = null;
  function latchOffline(reason = 'USER_OFF') { controlEpoch++; return core.latchOffline(reason); }
  const key = Buffer.from(tokenEncryptionKey, 'base64');
  if (key.length !== 32 || key.toString('base64') !== tokenEncryptionKey) { key.fill(0); fail(); }
  try {
    core = await createAiEgress({ installationId, mainEpoch, runningBuild, openJournal, recoveryMode,
      readCommittedRequest: adapter.readCommittedRequest, readProjection: adapter.readProjection,
      commitEvidence: adapter.commitEvidence, applySettlement: adapter.applySettlement, readback: adapter.readback,
      credentialProvider: async input => {
        const encrypted = await adapter.readCredential(input);
        equal(encrypted.ownerUserId, input.ownerUserId); equal(encrypted.provider, input.provider);
        equal(encrypted.revision, input.settingsRevision);
        return decryptCredential(encrypted, key);
      }, contractCatalog: catalog, transport,
      // Fixed main-side adapter capabilities only; the private bridge has no operation for these.
      verifyMaintenanceSeal, verifyMaintenanceCompletion,
      bindAuthority(value) { authority = value; adapter.bindAuthority(value); },
    });
    directory = await fs.realpath(await fs.mkdtemp(path.join(await fs.realpath(temporaryRoot), 'ci-ai-')));
    await fs.chmod(directory, 0o700);
    async function owner(input) {
      decimal(input.ownerUserId, true);
      const local = await adapter.readLocalOwner();
      equal(local.installationId, installationId); equal(local.ownerUserId, input.ownerUserId);
    }
    async function handler(operation, payload) {
      if (closed) fail();
      switch (operation) {
        case 'STATUS':
          exact(payload, []);
          return { installationId, mainEpoch, ...core.diagnostics(), activeRequests, supportedModels: [SUPPORTED_MODEL] };
        case 'ENROLLMENT': {
          exact(payload, ['installationId', 'ownerUserId']); equal(payload.installationId, installationId); await owner(payload);
          if (freshEnrollmentAllowed !== true) return null;
          const state = await adapter.readEnrollmentState();
          equal(state.installationId, installationId); equal(state.ownerUserId, payload.ownerUserId);
          for (const field of ['legacyUsageCount', 'requestCount', 'gateCount']) if (decimal(state[field]) !== '0') return null;
          return { installationId, ownerUserId: payload.ownerUserId, mainEpoch,
            proofSha256: crypto.createHash('sha256').update(JSON.stringify({ installationId, mainEpoch, ownerUserId: payload.ownerUserId })).digest('hex') };
        }
        case 'QUOTE': {
          exact(payload, ['requestId', 'approvalId', 'planSha256', 'ownerUserId', 'projectId', 'snapshotId', 'settingsRevision',
            'provider', 'model', 'operation', 'policyRevision', 'policySha256', 'budgetDay', 'expiresAt', 'outputTokenCap', 'bodyBase64']);
          await owner(payload);
          if (typeof payload.bodyBase64 !== 'string' || payload.bodyBase64.length > 1398104) fail();
          const bytes = Buffer.from(payload.bodyBase64, 'base64');
          if (bytes.toString('base64') !== payload.bodyBase64) { bytes.fill(0); fail(); }
          try { const { bodyBase64, ...metadata } = payload; return await core.prepare({ ...metadata, body: bytes }); }
          finally { bytes.fill(0); }
        }
        case 'APPROVE': exact(payload, ['requestId', 'approvalId', 'payloadSha256']); return core.approve(payload);
        case 'EXECUTE': {
          exact(payload, ['requestId', 'payloadSha256']);
          activeRequests++;
          try {
            const result = await core.execute(payload);
            try { const { body, ...metadata } = result; return { ...metadata, bodyBase64: body.toString('base64') }; }
            finally { result.body.fill(0); }
          } finally { activeRequests--; }
        }
        case 'LATCH': exact(payload, []); await latchOffline('USER_OFF'); return core.diagnostics();
        case 'ACTIVATE': {
          exact(payload, ['ownerUserId', 'policyRevision', 'policySha256', 'expectedJournalSequence', 'expectedJournalHash']);
          const epoch = controlEpoch;
          await owner(payload);
          const before = authority.readJournal();
          if (epoch !== controlEpoch || payload.expectedJournalSequence !== before.position.sequence
              || payload.expectedJournalHash !== before.position.hash) fail();
          await core.reconcile({ restoreId: crypto.randomUUID() });
          if (epoch !== controlEpoch) fail();
          const { ownerUserId, policyRevision, policySha256 } = payload;
          const result = await core.activate({ ownerUserId, policyRevision, policySha256, userApproved: true });
          if (epoch !== controlEpoch) fail();
          return result;
        }
        case 'JOURNAL': exact(payload, ['installationId']); equal(payload.installationId, installationId); return authority.readJournal();
        case 'DISPATCH_PROOF':
          exact(payload, ['installationId', 'requestId']); equal(payload.installationId, installationId); return authority.readDispatch(payload.requestId);
        case 'USAGE_PROOF':
        case 'SETTLEMENT_PROOF':
          exact(payload, ['installationId', 'requestId', 'proofSha256']); equal(payload.installationId, installationId);
          return operation === 'USAGE_PROOF' ? authority.readEvidence(payload.requestId, payload.proofSha256)
            : authority.readSettlement(payload.requestId, payload.proofSha256);
        default: fail();
      }
    }
    bridge = await openAiEgressBridge({ directory, capability, epoch: channelEpoch, handler });
    return Object.freeze({
      diagnostics: core.diagnostics, latchOffline,
      beginMaintenance(input) {
        if (closed) return Promise.reject(new Error('AI gateway unavailable'));
        controlEpoch++;
        return core.beginMaintenance(input).then(handle => {
          let released = false;
          return Object.freeze({ ...handle,
            rotateBackendChannel() {
              if (closed || released || rotating || channelFailed) return Promise.reject(new Error('AI gateway unavailable'));
              rotating = true;
              rotationTask = (async () => {
                try {
                  // Also verifies ownership and completed task/settlement drain. Main must stop
                  // the old backend before rotation; closing the bridge drains remaining handlers.
                  await handle.readProjection();
                  if (closed) fail();
                  await bridge.close();
                  if (closed) fail();
                  capability = crypto.randomBytes(32).toString('hex'); channelEpoch = crypto.randomBytes(32).toString('hex');
                  bridge = await openAiEgressBridge({ directory, capability, epoch: channelEpoch, handler });
                  if (closed) { await bridge.close(); fail(); }
                } catch {
                  channelFailed = true;
                  await latchOffline('RESTORE').catch(() => {});
                  fail();
                } finally { rotating = false; }
              })();
              return rotationTask;
            },
            async release() {
              if (released || rotating || channelFailed) fail();
              const result = await handle.release(); released = true; return result;
            },
          });
        });
      },
      bootstrap() {
        if (closed || rotating || channelFailed) fail();
        return Buffer.from(JSON.stringify({ version: 1, socketPath: bridge.socketPath, capability, epoch: channelEpoch }));
      },
      close() {
        if (closePromise) return closePromise;
        closed = true;
        closePromise = (async () => {
          let failure;
          try { await latchOffline('USER_OFF'); } catch (error) { failure = error; }
          try { await rotationTask; } catch (error) { failure ||= error; }
          try { await bridge.close(); } catch (error) { failure ||= error; }
          try { await core.close(); } catch (error) { failure ||= error; }
          key.fill(0); capability = '';
          // Remove only our now-empty directory. Never recursively remove a replaced socket/root.
          try { await fs.rmdir(directory); } catch (error) { failure ||= error; }
          if (failure) fail();
        })();
        return closePromise;
      },
    });
  } catch {
    if (bridge) await bridge.close().catch(() => {});
    if (core) await core.close().catch(() => {});
    key.fill(0); capability = '';
    if (directory) await fs.rmdir(directory).catch(() => {});
    fail();
  }
}
module.exports = Object.freeze({ openDesktopAiGateway });
