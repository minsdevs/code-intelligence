'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs/promises');
const fsSync = require('node:fs');
const path = require('node:path');
const net = require('node:net');
const vm = require('node:vm');
const test = require('node:test');
const { openDesktopAiGateway } = require('../src/ai-desktop-gateway.cjs');
const keyringModule = require('../src/purpose-keyring.cjs');
const journalModule = require('../src/safety-journal.cjs');
const sha = value => crypto.createHash('sha256').update(value).digest('hex');
const clone = value => JSON.parse(JSON.stringify(value));
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };

// Modeled macOS support, including on Linux CI. The real lifecycle/keyring/journal use private
// temporary files; this AEAD safeStorage stand-in never loads Electron or an OS credential store.
function syntheticStorage() {
  const key = Buffer.alloc(32, 39);
  return {
    isEncryptionAvailable: () => true,
    encryptString(text) {
      const nonce = crypto.randomBytes(12); const cipher = crypto.createCipheriv('aes-256-gcm', key, nonce);
      return Buffer.concat([nonce, cipher.update(text, 'utf8'), cipher.final(), cipher.getAuthTag()]);
    },
    decryptString(bytes) {
      const decipher = crypto.createDecipheriv('aes-256-gcm', key, bytes.subarray(0, 12)); decipher.setAuthTag(bytes.subarray(-16));
      return Buffer.concat([decipher.update(bytes.subarray(12, -16)), decipher.final()]).toString('utf8');
    },
  };
}
function lifecycleModule(controls) {
  const wrapKeyring = open => async options => {
    const value = await open(options);
    return Object.freeze({ ...value, async close() { controls.trace.push('keyring.close'); await value.close(); controls.trace.push('keyring.closed'); } });
  };
  const wrapJournal = open => async options => {
    const value = await open({ ...options, fault: stage => { controls.trace.push(stage); if (controls.journalFault?.(stage)) throw new Error('synthetic journal fault'); } });
    controls.journal = value;
    return Object.freeze({ ...value, async close() { controls.trace.push('journal.close'); await value.close(); controls.trace.push('journal.closed'); } });
  };
  const context = vm.createContext({ module: { exports: {} }, Buffer,
    process: { platform: 'darwin', getuid: process.getuid.bind(process) },
    require(name) {
      if (name === './purpose-keyring.cjs') return { ...keyringModule,
        openPurposeKeyring: wrapKeyring(keyringModule.openPurposeKeyring), initializePurposeKeyring: wrapKeyring(keyringModule.initializePurposeKeyring) };
      if (name === './safety-journal.cjs') return { ...journalModule,
        openSafetyJournal: wrapJournal(journalModule.openSafetyJournal), initializeSafetyJournal: wrapJournal(journalModule.initializeSafetyJournal) };
      if (name.startsWith('./')) return require(path.resolve(__dirname, '../src', name));
      return require(name);
    },
  });
  vm.runInContext(fsSync.readFileSync(path.join(__dirname, '../src/safety-lifecycle.cjs'), 'utf8'), context);
  return context.module.exports;
}
function credential(keyBase64) {
  const key = Buffer.from(keyBase64, 'base64'); const nonce = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, nonce);
  const encrypted = Buffer.concat([cipher.update('fixture-provider-key', 'utf8'), cipher.final(), cipher.getAuthTag()]); key.fill(0);
  return { ownerUserId: '1', revision: '2', provider: 'openai', model: 'fixture-model', keyVersion: 1,
    nonceBase64: nonce.toString('base64'), encryptedKey: encrypted.toString('base64') };
}
function envelope(bootstrap, operation, payload, patch = {}) {
  return { version: 1, auth: bootstrap.capability, epoch: bootstrap.epoch, callId: crypto.randomUUID(), operation, payload, ...patch };
}
function frame(value) {
  const body = Buffer.from(JSON.stringify(value)); const prefix = Buffer.alloc(4); prefix.writeUInt32BE(body.length); return Buffer.concat([prefix, body]);
}
async function exchange(bootstrap, operation, payload = {}, patch = {}) {
  const request = envelope(bootstrap, operation, payload, patch);
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(bootstrap.socketPath); const chunks = [];
    const timeout = setTimeout(() => { socket.destroy(); reject(new Error('synthetic private exchange timeout')); }, 5000);
    socket.on('connect', () => socket.end(frame(request)));
    socket.on('data', value => chunks.push(value));
    socket.on('error', () => {});
    socket.on('close', () => {
      clearTimeout(timeout); const raw = Buffer.concat(chunks);
      if (!raw.length) { resolve(null); return; }
      try {
        assert.equal(raw.readUInt32BE(0), raw.length - 4);
        const response = JSON.parse(raw.subarray(4)); assert.equal(response.callId, request.callId);
        assert.equal(response.version, 1); assert.equal(raw.includes(bootstrap.capability), false); resolve(response);
      } catch (error) { reject(error); }
    });
  });
}
function ok(value) { assert.equal(value?.ok, true, JSON.stringify(value)); return value.result; }
function denied(value) {
  assert.equal(value?.ok, false); assert.deepEqual(Object.keys(value).sort(), ['callId', 'code', 'ok', 'version']);
  assert.equal(value.code, 'AI_GATEWAY_UNAVAILABLE');
}

async function fixture(t, patch = {}) {
  const root = await fs.realpath(await fs.mkdtemp('/tmp/ci-gw-'));
  const userData = path.join(root, 'u'); const temporaryRoot = path.join(root, 't');
  await fs.mkdir(userData, { mode: 0o700 }); await fs.mkdir(temporaryRoot, { mode: 0o700 });
  const controls = { trace: [], sent: [], provider: null, fail: null, mutateCredential: null, journal: null, authority: null, journalFault: null };
  const lifecycle = lifecycleModule(controls); const safeStorage = syntheticStorage(); const opened = [];
  const secrets = await lifecycle.loadDesktopSecrets({ userData, safeStorage });
  for (const evidence of patch.evidence || []) {
    if (evidence.endsWith('.enc')) await fs.writeFile(path.join(userData, evidence), 'synthetic legacy marker', { mode: 0o600 });
    else await fs.mkdir(path.join(userData, evidence), { mode: 0o700 });
  }
  const model = {
    provider: 'openai', model: 'fixture-model', operation: 'CHAT', endpointId: 'openai.chat', adapterVersion: 'fixture-adapter',
    tokenizerId: 'fixture-token-bound', tokenizerVersion: '1', costContractSha256: sha('fixture bound'), priceVersion: 'fixture-price',
    priceSha256: sha('fixture price'), verifiedAtEpochMs: Date.now(), inputTokenLimit: '1000', embeddingTokenLimit: '0', outputTokenLimit: '100',
    rates: { inputMicroUsdPerMillion: '1000000', cachedInputMicroUsdPerMillion: '500000', outputMicroUsdPerMillion: '2000000',
      embeddingMicroUsdPerMillion: '0', fixedMicroUsd: '3' },
    validateBody: (body, binding) => body.model === binding.model && body.max_tokens === Number(binding.outputTokenMax)
      && typeof body.prompt === 'string' && Object.keys(body).every(k => ['model', 'max_tokens', 'prompt'].includes(k)),
    inputBound: () => ({ inputTokens: '10', embeddingInputTokens: '0' }), readUsage: value => value.usage,
  };
  const pg = { version: 1, complete: true,
    gate: { installationId: secrets.localIdentity, ownerUserId: '1', policyRevision: '3', policySha256: sha('fixture policy'),
      dailyLimitMicroUsd: '10000', monthlyLimitMicroUsd: '50000', reconciliationRequired: true, legacyLiabilityUnresolved: false,
      journalSequence: '0', journalHash: '0'.repeat(64), journalProjectionSha256: '0'.repeat(64), clockHighWaterMs: String(Date.now()) },
    requests: [], evidence: [] };
  const settings = { ownerUserId: '1', revision: '2', provider: 'openai', model: 'fixture-model', state: 'ACTIVE' };
  const enrollment = { installationId: secrets.localIdentity, ownerUserId: '1', legacyUsageCount: '0', requestCount: '0', gateCount: '0' };
  const encrypted = credential(secrets.tokenEncryptionKey);
  const adapter = {
    bindAuthority: value => { controls.authority = value; },
    readLocalOwner: async () => { await controls.readOwner?.(); return { installationId: secrets.localIdentity, ownerUserId: '1' }; },
    readEnrollmentState: async () => clone(enrollment),
    readCredential: async () => { controls.trace.push('credential'); const result = clone(encrypted); controls.mutateCredential?.(result); return result; },
    readCommittedRequest: async requestId => ({ request: clone(pg.requests.find(r => r.requestId === requestId)), settings: clone(settings), projection: clone(pg) }),
    readProjection: async () => { await controls.projection?.(); if (controls.fail === 'projection') throw new Error('synthetic PG unavailable'); return clone(pg); },
    readback: async () => { await controls.readback?.(); return clone(pg); },
    commitEvidence: async value => {
      controls.trace.push('pg.evidence'); assert.deepEqual(controls.authority.readEvidence(value.requestId, value.proofSha256), value);
      if (controls.fail === 'evidence') throw new Error('synthetic PG unavailable');
      const fields = ['requestId', 'proofSha256', 'mainEpoch', 'receiptType', 'providerRequestId', 'usageDimensions', 'actualMicroUsd'];
      pg.evidence.push(Object.fromEntries(fields.map(field => [field, clone(value[field])])));
    },
    applySettlement: async ({ phase, requestId, journal }) => {
      controls.trace.push(`pg.${phase}`); assert.equal(controls.authority.readJournal().position.hash, journal.headHash);
      if (phase === 'DISPATCHED') assert.equal(controls.authority.readDispatch(requestId).position.hash, journal.headHash);
      if (phase === 'SETTLED') assert.equal(controls.authority.readSettlement(requestId, journal.requests.find(r => r.requestId === requestId).proofSha256).position.hash, journal.headHash);
      if (controls.fail === phase) throw new Error('synthetic PG unavailable');
      for (const b of journal.requests) {
        const normalized = clone(b); delete normalized.dispatchIntent;
        let row = pg.requests.find(r => r.requestId === b.requestId);
        if (!row) { row = { installationId: secrets.localIdentity, ownerUserId: null, projectId: null, snapshotId: null, approvalId: null,
          planSha256: '0'.repeat(64), wireBodySha256: '0'.repeat(64), dispatchBinding: null }; pg.requests.push(row); }
        Object.assign(row, normalized, { journalSequence: String(journal.sequence), journalHash: journal.headHash });
      }
      Object.assign(pg.gate, { journalSequence: String(journal.sequence), journalHash: journal.headHash, journalProjectionSha256: journal.projectionDigest,
        clockHighWaterMs: String(journal.clockHighWaterMs), legacyLiabilityUnresolved: pg.gate.legacyLiabilityUnresolved || Boolean(journal.legacyLiabilityUnresolved),
        reconciliationRequired: journal.pendingRestore !== null || Boolean(journal.pendingMaintenance) || journal.requests.some(r => r.conflict
          || (r.status === 'SETTLED' && BigInt(r.actualMicroUsd) > BigInt(r.reservedMicroUsd))) });
    },
  };
  let gateway; let active;
  async function open() {
    active = await lifecycle.openSafetyLifecycle({ userData, safeStorage, installationId: secrets.localIdentity, runningBuild: '100',
      recoveryMode: patch.recoveryMode || false,
      createBackupRuntime: patch.createBackupRuntime,
      createGateway: async ({ openJournal, freshEnrollmentAllowed, recoveryMode }) => {
        controls.freshEnrollmentAllowed = freshEnrollmentAllowed;
        gateway = await openDesktopAiGateway({ installationId: secrets.localIdentity, runningBuild: '100', temporaryRoot,
          tokenEncryptionKey: patch.tokenEncryptionKey || secrets.tokenEncryptionKey, openJournal, freshEnrollmentAllowed, adapter, recoveryMode,
          verifyMaintenanceSeal: patch.verifyMaintenanceSeal, verifyMaintenanceCompletion: patch.verifyMaintenanceCompletion, catalog: () => model,
          transport: async request => {
            controls.trace.push('transport'); controls.sent.push({ ...request, headers: { ...request.headers }, body: Buffer.from(request.body) });
            assert.equal(controls.journal.snapshot().requests.find(r => r.requestId === request.requestId).dispatchIntent, true);
            if (controls.provider) return controls.provider(request);
            return { statusCode: 200, providerRequestId: 'fixture-response', body: Buffer.from(JSON.stringify({ answer: 'synthetic answer',
              usage: { inputTokens: '5', cachedInputTokens: '4', outputTokens: '7', embeddingInputTokens: '0' } })) };
          } });
        return gateway;
      } });
    opened.push(active); const bytes = gateway.bootstrap(); const bootstrap = JSON.parse(bytes); bytes.fill(0); return bootstrap;
  }
  let bootstrap;
  const result = { controls, pg, settings, enrollment, model, encrypted, secrets, userData, temporaryRoot, adapter,
    get gateway() { return gateway; }, get lifecycle() { return active; }, get bootstrap() { return bootstrap; },
    rpc: (operation, payload = {}, overrides = {}) => exchange(bootstrap, operation, payload, overrides),
    input: overrides => ({ requestId: crypto.randomUUID(), approvalId: crypto.randomUUID(), planSha256: sha('synthetic approved plan'), ownerUserId: '1',
      projectId: '2', snapshotId: '3', settingsRevision: '2', provider: 'openai', model: 'fixture-model', operation: 'CHAT', policyRevision: '3',
      policySha256: pg.gate.policySha256, budgetDay: new Date().toISOString().slice(0, 10), expiresAt: Date.now() + 600000, outputTokenCap: '20',
      bodyBase64: Buffer.from('{ "model":"fixture-model", "max_tokens":20, "prompt":"synthetic private prompt" }').toString('base64'), ...overrides }),
    commit: metadata => {
      const row = { ...clone(metadata), status: 'RESERVED', actualMicroUsd: null, proofSha256: null,
        liabilityFloorMicroUsd: metadata.reservedMicroUsd, conflict: false, journalSequence: null, journalHash: null };
      delete row.wireBodyBytes; pg.requests.push(row); enrollment.requestCount = String(pg.requests.length); return row;
    },
    activationPayload: async overrides => {
      const journal = ok(await result.rpc('JOURNAL', { installationId: secrets.localIdentity }));
      return { ownerUserId: '1', policyRevision: '3', policySha256: pg.gate.policySha256,
        expectedJournalSequence: journal.position.sequence, expectedJournalHash: journal.position.hash, ...overrides };
    },
    activate: async () => { const state = ok(await result.rpc('ACTIVATE', await result.activationPayload()));
      enrollment.gateCount = '1'; assert.equal(state.aiOff, false); return state; },
    prepare: async overrides => { const input = result.input(overrides); const metadata = ok(await result.rpc('QUOTE', input)); result.commit(metadata);
      ok(await result.rpc('APPROVE', { requestId: metadata.requestId, approvalId: metadata.approvalId, payloadSha256: metadata.payloadSha256 })); return { input, metadata }; },
    execute: metadata => result.rpc('EXECUTE', { requestId: metadata.requestId, payloadSha256: metadata.payloadSha256 }),
    reopen: async () => { await active.close(); bootstrap = await open(); },
  };
  t.after(async () => { for (const item of opened) await item.close().catch(() => {}); if (gateway) await gateway.close().catch(() => {});
    if (controls.journal) await controls.journal.close().catch(() => {}); await fs.rm(root, { recursive: true, force: true }); });
  if (patch.beforeOpen) await patch.beforeOpen({ root, userData, temporaryRoot, controls, secrets });
  bootstrap = await open(); return result;
}

test('real lifecycle/private UDS flows STATUS -> fresh enrollment -> quote -> approve -> one send -> cached settlement -> OFF', async t => {
  const f = await fixture(t); const status = ok(await f.rpc('STATUS'));
  assert.equal(status.aiOff, true); assert.equal(status.recoveryOnly, true);
  assert.deepEqual(clone(f.lifecycle.diagnostics()), { aiOff: true, recoveryOnly: false });
  assert.match(status.mainEpoch, /^[0-9a-f-]{36}$/); assert.match(f.bootstrap.epoch, /^[0-9a-f]{64}$/); assert.notEqual(status.mainEpoch, f.bootstrap.epoch);
  const enrollment = ok(await f.rpc('ENROLLMENT', { installationId: f.secrets.localIdentity, ownerUserId: '1' }));
  assert.equal(enrollment.mainEpoch, status.mainEpoch); assert.match(enrollment.proofSha256, /^[0-9a-f]{64}$/);
  await f.activate(); assert.deepEqual(clone(f.lifecycle.diagnostics()), { aiOff: false, recoveryOnly: false });
  const { input, metadata } = await f.prepare(); const result = ok(await f.execute(metadata));
  assert.equal(metadata.reservedMicroUsd, '59'); assert.equal(result.actualMicroUsd, '20');
  assert.deepEqual(f.controls.sent[0].body, Buffer.from(input.bodyBase64, 'base64'));
  assert.equal(f.controls.sent[0].headers.Authorization, 'Bearer fixture-provider-key');
  assert.equal(f.controls.sent[0].redirects, 0); assert.equal(f.controls.sent[0].retries, 0);
  assert.equal(JSON.parse(Buffer.from(result.bodyBase64, 'base64')).answer, 'synthetic answer');
  assert.equal(f.pg.requests[0].status, 'SETTLED'); assert.equal(f.pg.evidence[0].usageDimensions.units.CACHED_INPUT_TOKENS, '4');
  assert.equal(f.controls.journal.snapshot().requests[0].actualMicroUsd, '20');
  assert.equal((await fs.lstat(f.bootstrap.socketPath)).mode & 0o777, 0o600);
  assert.doesNotMatch(JSON.stringify(result), /fixture-provider-key|permitId/);
  denied(await f.execute(metadata)); assert.equal(f.controls.sent.length, 1);
  assert.equal(ok(await f.rpc('LATCH')).aiOff, true); assert.equal(f.lifecycle.diagnostics().recoveryOnly, false);
});

for (const evidence of ['postgres', 'data', 'recovery', 'redis', 'authorized-paths.enc']) test(`legacy ${evidence} evidence cannot issue fresh enrollment exemption`, async t => {
  const f = await fixture(t, { evidence: [evidence] });
  assert.equal(ok(await f.rpc('ENROLLMENT', { installationId: f.secrets.localIdentity, ownerUserId: '1' })), null);
  assert.equal(f.controls.freshEnrollmentAllowed, false); assert.equal(f.controls.sent.length, 0);
});
for (const name of ['legacyUsageCount', 'requestCount', 'gateCount']) test(`nonempty independent ${name} rejects enrollment even on fresh filesystem`, async t => {
  const f = await fixture(t); f.enrollment[name] = '1';
  assert.equal(ok(await f.rpc('ENROLLMENT', { installationId: f.secrets.localIdentity, ownerUserId: '1' })), null);
});

test('wrong local owner cannot enroll, quote or activate and learns no credential', async t => {
  const f = await fixture(t);
  denied(await f.rpc('ENROLLMENT', { installationId: f.secrets.localIdentity, ownerUserId: '9' }));
  denied(await f.rpc('QUOTE', f.input({ ownerUserId: '9' })));
  denied(await f.rpc('ACTIVATE', await f.activationPayload({ ownerUserId: '9' })));
  assert.equal(f.controls.sent.length, 0); assert.equal(f.controls.trace.includes('credential'), false);
});
for (const patch of [{ auth: 'a'.repeat(64) }, { epoch: 'b'.repeat(64) }, { auth: 'renderer-token' }]) test(`private wrong ${Object.keys(patch)[0]} fails before status/domain access`, async t => {
  const f = await fixture(t); assert.equal(await f.rpc('STATUS', {}, patch), null); assert.equal(f.controls.sent.length, 0);
});

test('a JSON verified flag cannot become evidence or settle a main-observed request', async t => {
  const f = await fixture(t); await f.activate(); const { metadata } = await f.prepare();
  denied(await f.rpc('USAGE_PROOF', { installationId: f.secrets.localIdentity, requestId: metadata.requestId, proofSha256: sha('fake'), verified: true, actualMicroUsd: '0' }));
  assert.equal(ok(await f.rpc('USAGE_PROOF', { installationId: f.secrets.localIdentity, requestId: metadata.requestId, proofSha256: sha('fake') })), null);
  denied(await f.rpc('EXECUTE', { requestId: metadata.requestId, payloadSha256: metadata.payloadSha256, permit: 'caller permit' }));
  assert.equal(f.controls.sent.length, 0); const result = ok(await f.execute(metadata)); assert.equal(result.actualMicroUsd, '20');
  const proof = ok(await f.rpc('USAGE_PROOF', { installationId: f.secrets.localIdentity, requestId: metadata.requestId, proofSha256: result.proofSha256 }));
  assert.equal(proof.actualMicroUsd, '20'); assert.doesNotMatch(JSON.stringify(proof), /fixture-provider-key|synthetic private prompt|permitId/);
});

for (const bodyBase64 of ['!!!!', 'e30=\n', '', Buffer.alloc(1024 * 1024 + 1, 32).toString('base64')]) test(`bounded canonical base64 body ${sha(bodyBase64).slice(0, 8)} is rejected with no send`, async t => {
  const f = await fixture(t); denied(await f.rpc('QUOTE', f.input({ bodyBase64 }))); assert.equal(f.controls.sent.length, 0);
});

test('unknown usage over the real socket retains full reservation and private errors expose no response', async t => {
  const f = await fixture(t); await f.activate(); f.controls.provider = async () => ({ statusCode: 200, providerRequestId: null,
    body: Buffer.from('{"answer":"synthetic sensitive response","usage":{}}') });
  const { metadata } = await f.prepare(); denied(await f.execute(metadata));
  assert.equal(f.controls.journal.snapshot().requests[0].status, 'UNKNOWN_HELD');
  assert.equal(f.controls.journal.snapshot().requests[0].reservedMicroUsd, '59'); assert.equal(ok(await f.rpc('STATUS')).aiOff, true);
  assert.equal(f.pg.evidence.length, 0); assert.equal(f.controls.sent.length, 1);
});

for (const change of ['keyVersion', 'nonce', 'tag', 'owner', 'revision', 'provider']) test(`credential ${change} mismatch stops before transport and preserves one-use approval`, async t => {
  const f = await fixture(t); await f.activate();
  f.controls.mutateCredential = value => {
    if (change === 'keyVersion') value.keyVersion = 2;
    if (change === 'nonce') value.nonceBase64 = Buffer.alloc(12).toString('base64');
    if (change === 'tag') { const bytes = Buffer.from(value.encryptedKey, 'base64'); bytes[bytes.length - 1] ^= 1; value.encryptedKey = bytes.toString('base64'); }
    if (change === 'owner') value.ownerUserId = '2';
    if (change === 'revision') value.revision = '3';
    if (change === 'provider') value.provider = 'gemini';
  };
  const { metadata } = await f.prepare(); denied(await f.execute(metadata)); assert.equal(f.controls.sent.length, 0);
  denied(await f.execute(metadata)); assert.equal(f.pg.requests[0].status, 'RESERVED');
  assert.equal(ok(await f.rpc('STATUS')).aiOff, true);
});

test('restart renews both epochs/capability, holds crashed PG reservation and invalidates old approval', async t => {
  const f = await fixture(t); await f.activate(); const before = ok(await f.rpc('STATUS')); const bootstrap = clone(f.bootstrap);
  const { metadata } = await f.prepare(); await f.reopen(); const after = ok(await f.rpc('STATUS'));
  assert.notEqual(after.mainEpoch, before.mainEpoch); assert.notEqual(f.bootstrap.epoch, bootstrap.epoch); assert.notEqual(f.bootstrap.capability, bootstrap.capability);
  assert.equal(after.aiOff, true); assert.equal(ok(await f.rpc('ENROLLMENT', { installationId: f.secrets.localIdentity, ownerUserId: '1' })), null);
  denied(await f.execute(metadata)); await f.activate(); denied(await f.execute(metadata));
  assert.equal(f.controls.journal.snapshot().requests[0].status, 'UNKNOWN_HELD'); assert.equal(f.controls.sent.length, 0);
  assert.equal(await exchange({ ...bootstrap, socketPath: f.bootstrap.socketPath }, 'STATUS'), null);
});

test('PG evidence or settlement failure after a response returns a private static error and preserves B', async t => {
  const f = await fixture(t); await f.activate(); const { metadata } = await f.prepare(); f.controls.fail = 'SETTLED';
  denied(await f.execute(metadata)); assert.equal(f.controls.sent.length, 1);
  assert.equal(f.controls.journal.snapshot().requests[0].status, 'SETTLED'); assert.equal(f.controls.journal.snapshot().requests[0].actualMicroUsd, '20');
  assert.equal(ok(await f.rpc('STATUS')).aiOff, true);
});

test('lifecycle latch before initialized PG leaves ordinary local app healthy', async t => {
  const f = await fixture(t); f.controls.fail = 'projection'; const count = f.controls.trace.filter(v => v.startsWith('pg.')).length;
  await f.lifecycle.latch('RESTART_RECONCILIATION');
  assert.deepEqual(clone(f.lifecycle.diagnostics()), { aiOff: true, recoveryOnly: false });
  assert.equal(f.controls.trace.filter(v => v.startsWith('pg.')).length, count);
});

test('gateway/lifecycle close latches immediately, drains active provider accounting, then closes journal before keyring', async t => {
  const f = await fixture(t); await f.activate(); const entered = deferred(); const release = deferred();
  f.controls.provider = async () => { entered.resolve(); await release.promise; return { statusCode: 200, providerRequestId: 'closing-response',
    body: Buffer.from('{"usage":{"inputTokens":"5","cachedInputTokens":"0","outputTokens":"7","embeddingInputTokens":"0"}}') }; };
  const { metadata } = await f.prepare(); const execution = f.execute(metadata); await entered.promise;
  const socketPath = f.bootstrap.socketPath; let closed = false;
  const closing = f.lifecycle.close().then(() => { closed = true; });
  await new Promise(resolve => setImmediate(resolve)); assert.equal(closed, false); assert.equal(f.gateway.diagnostics().aiOff, true);
  assert.throws(() => f.gateway.bootstrap()); release.resolve(); await closing; await execution;
  assert.equal(f.controls.journal.snapshot().requests[0].actualMicroUsd, '22');
  assert.ok(f.controls.trace.indexOf('journal.closed') < f.controls.trace.indexOf('keyring.close'));
  await assert.rejects(fs.lstat(socketPath), { code: 'ENOENT' }); assert.deepEqual(await fs.readdir(f.temporaryRoot), []);
  await f.lifecycle.close();
});

test('initial gateway temporary-root failure closes real journal/keyring, keeps enrollment evidence and never sends', async t => {
  let observed;
  await assert.rejects(fixture(t, { beforeOpen: async state => { observed = state; await fs.rmdir(state.temporaryRoot); } }),
    { code: 'SAFETY_RECOVERY_REQUIRED' });
  assert.equal(observed.controls.sent.length, 0);
  assert.ok(observed.controls.trace.indexOf('journal.closed') >= 0);
  assert.ok(observed.controls.trace.indexOf('journal.closed') < observed.controls.trace.indexOf('keyring.close'));
  const marker = JSON.parse(await fs.readFile(path.join(observed.userData, '.safety-enrollment.json'), 'utf8'));
  assert.equal(marker.installationId, observed.secrets.localIdentity);
  assert.equal((await fs.lstat(path.join(observed.userData, 'safety'))).isDirectory(), true);
  assert.equal(observed.controls.journal.snapshot().aiOff, true);
});

test('malformed backend-token encryption key refuses gateway construction and closes keyring without fallback', async t => {
  let observed;
  await assert.rejects(fixture(t, { tokenEncryptionKey: 'not-an-encryption-key', beforeOpen: async state => { observed = state; } }),
    { code: 'SAFETY_RECOVERY_REQUIRED' });
  assert.equal(observed.controls.trace.includes('keyring.closed'), true); assert.equal(observed.controls.journal, null);
  assert.equal(observed.controls.sent.length, 0); assert.deepEqual(await fs.readdir(observed.temporaryRoot), []);
  await fs.lstat(path.join(observed.userData, '.safety-enrollment.json'));
});

test('fixed private LATCH succeeds without PG access and makes no projection completion assertion', async t => {
  const f = await fixture(t); f.controls.fail = 'projection';
  const before = f.controls.trace.filter(value => value.startsWith('pg.')).length;
  assert.deepEqual(ok(await f.rpc('LATCH')), { aiOff: true, recoveryOnly: true });
  assert.equal(f.controls.trace.filter(value => value.startsWith('pg.')).length, before);
  denied(await f.rpc('LATCH', { publish: false })); denied(await f.rpc('LATCH', { reason: 'INITIAL_OFF' }));
  assert.equal(f.controls.journal.snapshot().aiOff, true);
});

test('activation binds exact B sequence/hash; OFF consumes the earlier journal consent', async t => {
  const f = await fixture(t); const old = await f.activationPayload();
  ok(await f.rpc('LATCH')); const count = f.controls.trace.filter(v => v.startsWith('pg.')).length;
  denied(await f.rpc('ACTIVATE', old)); assert.equal(f.controls.trace.filter(v => v.startsWith('pg.')).length, count);
  assert.equal(ok(await f.rpc('STATUS')).aiOff, true);
  denied(await f.rpc('ACTIVATE', { ownerUserId: '1', policyRevision: '3', policySha256: f.pg.gate.policySha256 }));
  await f.activate(); denied(await f.rpc('ACTIVATE', old)); assert.equal(f.controls.sent.length, 0);
});

for (const stage of ['owner', 'reconcileReadback']) test(`OFF wins while private ACTIVATE waits for ${stage}`, async t => {
  const f = await fixture(t); const payload = await f.activationPayload(); const entered = deferred(); const resume = deferred();
  let once = true;
  const delay = async () => { if (once) { once = false; entered.resolve(); await resume.promise; } };
  if (stage === 'owner') f.controls.readOwner = delay; else f.controls.readback = delay;
  const activation = f.rpc('ACTIVATE', payload); await entered.promise;
  // Lifecycle and private LATCH both traverse the wrapper's control epoch. A private command can
  // finish while owner-read is delayed; reconcile publication must resume before its queued latch.
  const off = stage === 'owner' ? f.rpc('LATCH') : f.lifecycle.latch('USER_OFF');
  if (stage === 'owner') ok(await off);
  resume.resolve(); denied(await activation); if (stage !== 'owner') await off;
  assert.equal(ok(await f.rpc('STATUS')).aiOff, true); assert.equal(f.controls.journal.snapshot().aiOff, true);
  assert.equal(f.controls.sent.length, 0); await f.activate();
});

test('fresh origin eligibility survives a normal restart before first enrollment/budget read', async t => {
  const f = await fixture(t); const markerPath = path.join(f.userData, '.safety-enrollment.json');
  const original = await fs.readFile(markerPath); const marker = JSON.parse(original);
  assert.equal(marker.major, 2); assert.equal(typeof marker.originProof, 'string');
  await f.reopen(); assert.equal(f.controls.freshEnrollmentAllowed, true);
  const proof = ok(await f.rpc('ENROLLMENT', { installationId: f.secrets.localIdentity, ownerUserId: '1' }));
  assert.equal(proof.installationId, f.secrets.localIdentity); assert.match(proof.proofSha256, /^[0-9a-f]{64}$/);
  assert.deepEqual(await fs.readFile(markerPath), original); assert.equal(f.controls.sent.length, 0);
});

test('a v1 enrollment marker remains conservatively legacy on reopen', async t => {
  const f = await fixture(t); await f.lifecycle.close(); const markerPath = path.join(f.userData, '.safety-enrollment.json');
  const legacy = Buffer.from(JSON.stringify({ format: 'code-intelligence-safety-enrollment', major: 1, installationId: f.secrets.localIdentity }));
  await fs.writeFile(markerPath, legacy, { mode: 0o600 }); await f.reopen();
  assert.equal(f.controls.freshEnrollmentAllowed, false);
  assert.equal(ok(await f.rpc('ENROLLMENT', { installationId: f.secrets.localIdentity, ownerUserId: '1' })), null);
  assert.deepEqual(await fs.readFile(markerPath), legacy);
});

for (const mutation of ['tag', 'installation', 'plaintext']) test(`tampered v2 ${mutation} origin proof refuses reopen without resetting B`, async t => {
  const f = await fixture(t); await f.lifecycle.close(); const markerPath = path.join(f.userData, '.safety-enrollment.json');
  const marker = JSON.parse(await fs.readFile(markerPath));
  if (mutation === 'tag') { const bytes = Buffer.from(marker.originProof, 'base64'); bytes[bytes.length - 1] ^= 1; marker.originProof = bytes.toString('base64'); }
  if (mutation === 'installation') marker.installationId = crypto.randomUUID();
  if (mutation === 'plaintext') marker.originProof = Buffer.from(JSON.stringify({ freshEnrollmentAllowed: true })).toString('base64');
  const changed = Buffer.from(JSON.stringify(marker)); await fs.writeFile(markerPath, changed);
  await assert.rejects(f.reopen(), error => /^SAFETY_(STORAGE_UNAVAILABLE|RECOVERY_REQUIRED)$/.test(error.code));
  assert.deepEqual(await fs.readFile(markerPath), changed); assert.equal((await fs.lstat(path.join(f.userData, 'safety'))).isDirectory(), true);
  assert.equal(f.controls.sent.length, 0);
});

test('valid origin proof from another installation cannot grant enrollment here', async t => {
  const a = await fixture(t); const b = await fixture(t); await b.lifecycle.close();
  const first = JSON.parse(await fs.readFile(path.join(a.userData, '.safety-enrollment.json')));
  const markerPath = path.join(b.userData, '.safety-enrollment.json'); const second = JSON.parse(await fs.readFile(markerPath));
  second.originProof = first.originProof; await fs.writeFile(markerPath, JSON.stringify(second));
  await assert.rejects(b.reopen(), { code: 'SAFETY_RECOVERY_REQUIRED' }); assert.equal(b.controls.sent.length, 0);
});

for (const lost of ['safety', '.safety-enrollment.json']) test(`losing ${lost} still refuses re-enrollment with a persisted v2 origin`, async t => {
  const f = await fixture(t); await f.lifecycle.close();
  await fs.rename(path.join(f.userData, lost), path.join(f.userData, `held-${lost}`));
  await assert.rejects(f.reopen(), { code: 'SAFETY_RECOVERY_REQUIRED' });
  await assert.rejects(fs.lstat(path.join(f.userData, lost)), { code: 'ENOENT' }); assert.equal(f.controls.sent.length, 0);
});

test('persisted fresh origin does not override new independent legacy usage after restart', async t => {
  const f = await fixture(t); await f.reopen(); f.enrollment.legacyUsageCount = '1';
  assert.equal(f.controls.freshEnrollmentAllowed, true);
  assert.equal(ok(await f.rpc('ENROLLMENT', { installationId: f.secrets.localIdentity, ownerUserId: '1' })), null);
});

test('private activeRequests stays one through OFF until observed provider accounting finishes', async t => {
  const f = await fixture(t); await f.activate(); const entered = deferred(); const release = deferred();
  f.controls.provider = async () => { entered.resolve(); await release.promise; return { statusCode: 200, providerRequestId: 'pending-response',
    body: Buffer.from('{"usage":{"inputTokens":"5","cachedInputTokens":"0","outputTokens":"7","embeddingInputTokens":"0"}}') }; };
  assert.equal(ok(await f.rpc('STATUS')).activeRequests, 0);
  const { metadata } = await f.prepare(); const sending = f.execute(metadata); await entered.promise;
  assert.equal(ok(await f.rpc('STATUS')).activeRequests, 1); ok(await f.rpc('LATCH'));
  const held = ok(await f.rpc('STATUS')); assert.equal(held.activeRequests, 1); assert.equal(held.aiOff, true);
  release.resolve(); assert.equal(ok(await sending).actualMicroUsd, '22');
  const finished = ok(await f.rpc('STATUS')); assert.equal(finished.activeRequests, 0); assert.equal(finished.aiOff, true);
});

test('main-only maintenance drains execution and denies every remote approval/admission without adding bridge operations', async t => {
  const f = await fixture(t); await f.activate(); const { metadata } = await f.prepare();
  const provider = deferred(); const entered = deferred();
  f.controls.provider = async () => { entered.resolve(); return provider.promise; };
  const execute = f.execute(metadata); await entered.promise;
  try {
    const handle = await f.gateway.beginMaintenance({ transactionId: crypto.randomUUID(), kind: 'RESTORE' });
    denied(await f.rpc('QUOTE', f.input())); denied(await f.rpc('APPROVE', { requestId: metadata.requestId,
      approvalId: metadata.approvalId, payloadSha256: metadata.payloadSha256 }));
    denied(await f.rpc('ACTIVATE', await f.activationPayload()));
    assert.equal(await f.rpc('BEGIN_MAINTENANCE', { transactionId: crypto.randomUUID(), kind: 'RESTORE' }), null);
    await assert.rejects(handle.waitForDrain({ timeoutMs: 10 }), { code: 'AI_EGRESS_DRAIN_TIMEOUT' });
    provider.resolve({ statusCode: 200, providerRequestId: 'fixture-maintenance', body: Buffer.from(JSON.stringify({
      answer: 'synthetic answer', usage: { inputTokens: '5', cachedInputTokens: '0', outputTokens: '7', embeddingInputTokens: '0' } })) });
    await execute; await handle.waitForDrain({ timeoutMs: 2000 }); assert.equal(f.controls.sent.length, 1);
  } finally { provider.resolve({ statusCode: 500, body: Buffer.from('synthetic'), providerRequestId: null }); await execute; }
});
test('channel rotation requires drained maintenance, waits old handlers and invalidates old epoch/capability before new bootstrap', async t => {
  const f = await fixture(t); const old = { ...f.bootstrap };
  const handle = await f.gateway.beginMaintenance({ transactionId: crypto.randomUUID(), kind: 'RESTORE' });
  await handle.waitForDrain({ timeoutMs: 2000 });
  const owner = deferred(); const entered = deferred();
  f.controls.readOwner = async () => { entered.resolve(); await owner.promise; };
  const oldRead = f.rpc('ENROLLMENT', { installationId: f.secrets.localIdentity, ownerUserId: '1' }); await entered.promise;
  const rotating = handle.rotateBackendChannel(); let completed = false; rotating.then(() => { completed = true; });
  try {
    assert.throws(() => f.gateway.bootstrap(), /AI gateway unavailable/);
    await assert.rejects(handle.release(), /AI gateway unavailable/);
    await new Promise(resolve => setImmediate(resolve)); assert.equal(completed, false);
  } finally { owner.resolve(); }
  await rotating; await oldRead;
  const bytes = f.gateway.bootstrap(); const next = JSON.parse(bytes); bytes.fill(0);
  assert.notEqual(next.epoch, old.epoch); assert.notEqual(next.capability, old.capability);
  assert.equal(await exchange(old, 'STATUS', {}), null);
  const status = ok(await exchange(next, 'STATUS', {})); assert.equal(status.aiOff, true);
  assert.equal(await exchange(next, 'ROTATE_BACKEND_CHANNEL', {}), null); assert.equal(f.controls.sent.length, 0);
});
test('undrained channel rotation fails closed and never produces replacement bootstrap', async t => {
  const f = await fixture(t); const handle = await f.gateway.beginMaintenance({ transactionId: crypto.randomUUID(), kind: 'BACKUP' });
  await assert.rejects(handle.rotateBackendChannel(), /AI gateway unavailable/);
  assert.throws(() => f.gateway.bootstrap(), /AI gateway unavailable/); assert.equal(f.controls.sent.length, 0);
});
test('gateway transports only fixed main verification callbacks into maintenance journal capabilities', async t => {
  const called = [];
  const f = await fixture(t, {
    verifyMaintenanceSeal: async (snapshot, value) => { called.push(['seal', snapshot.sequence]); return { ...value, verified: true }; },
    verifyMaintenanceCompletion: async (snapshot, value) => { called.push(['completion', snapshot.sequence]); return { ...value, verified: true }; },
  });
  const operation = { transactionId: crypto.randomUUID(), kind: 'BACKUP' };
  const handle = await f.gateway.beginMaintenance(operation); await handle.waitForDrain({ timeoutMs: 2000 });
  await handle.mergeAndCommit({ mergeInput: { restoreId: crypto.randomUUID(), obligations: [], budgetDay: new Date().toISOString().slice(0, 10), minimumVersion: '0' } });
  const metadata = { ...operation, payloadSha256: sha('synthetic export'), pgProjectionDigest: sha('synthetic PG'), legacyLiabilityUnresolved: false,
    budgetDay: f.controls.journal.snapshot().budgetDay, minimumVersion: '0' };
  await f.controls.journal.sealMaintenance(metadata); await handle.refreshProjection();
  await f.controls.journal.completeMaintenance(metadata);
  await assert.rejects(handle.release(), { code: 'AI_EGRESS_PROJECTION_FAILED' });
  await handle.refreshProjection(); await handle.release();
  assert.deepEqual(called.map(value => value[0]), ['seal', 'completion']); assert.equal(f.controls.sent.length, 0);
});
