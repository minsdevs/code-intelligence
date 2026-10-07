'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { initializeSafetyJournal, openSafetyJournal } = require('../src/safety-journal.cjs');

const sha = (value) => crypto.createHash('sha256').update(value).digest('hex');
const rejects = (promise, code) => assert.rejects(promise, (error) => {
  assert.equal(error.code, code); assert.equal(error.aiOff, true);
  assert.doesNotMatch(error.message, /SYNTHETIC_SECRET|source sentinel|token sentinel/);
  return true;
});

async function fixture(t, overrides = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ci-safety-journal-'));
  const safetyRoot = path.join(root, 'safety');
  const restoreRoot = path.join(root, 'data');
  await fs.mkdir(restoreRoot, { mode: 0o700 });
  const keys = new Map([['safety-1', Buffer.alloc(32, 71)], ['safety-2', Buffer.alloc(32, 82)]]);
  const controls = { time: Date.parse('2026-10-02T12:00:00Z'), keyId: 'safety-1', fault: null, events: [], pgCalls: 0, health: true, usage: true, issuedKeys: [] };
  const options = {
    safetyRoot, restoreRoots: [restoreRoot], installationId: crypto.randomUUID(), runningBuild: '100',
    keyProvider: {
      currentKeyId: async (purpose) => { assert.equal(purpose, 'safety'); return controls.keyId; },
      getMacKey: async (id, purpose) => {
        assert.equal(purpose, 'safety');
        const retained = keys.get(id);
        if (!retained) return undefined;
        const ownedCopy = Buffer.from(retained); controls.issuedKeys.push(ownedCopy); return ownedCopy;
      },
    },
    verifyCommittedReservation: async (row) => { controls.pgCalls++; controls.events.push('pg.committed'); return { ...row, committed: true }; },
    verifySettlement: async (row) => ({ ...row, verified: controls.usage }),
    verifyActivation: async () => controls.health,
    clock: () => controls.time,
    fault: async (stage) => {
      controls.events.push(stage);
      if (controls.fault?.stage === stage && --controls.fault.remaining === 0) throw new Error('SYNTHETIC_SECRET injected failure');
    },
    ...overrides,
  };
  const journals = [];
  t.after(async () => {
    for (const journal of journals) await journal.close().catch(() => {});
    await fs.rm(root, { recursive: true, force: true });
  });
  const journal = await initializeSafetyJournal(options); journals.push(journal);
  const result = {
    root, safetyRoot, restoreRoot, options, controls, keys, journal,
    log: path.join(safetyRoot, 'ai-journal', 'events.log'),
    latch: path.join(safetyRoot, 'ai-off.json'),
    lock: path.join(safetyRoot, 'ai-journal', 'writer.lock'),
    request: (patch = {}) => ({ requestId: crypto.randomUUID(), payloadSha256: sha('approved synthetic payload'),
      budgetDay: new Date(controls.time).toISOString().slice(0, 10), priceVersion: 'fixture-price-1', reservedMicroUsd: '100', ...patch }),
    arm: (stage, remaining = 1) => { controls.fault = { stage, remaining }; },
    reopen: async (patch = {}) => {
      await result.journal.close();
      const next = await openSafetyJournal({ ...options, ...patch }); journals.push(next); result.journal = next; return next;
    },
  };
  return result;
}
async function activate(f) {
  return f.journal.activate({ projectionDigest: f.journal.snapshot().projectionDigest, userApproved: true });
}
function settlement(request, actualMicroUsd = '40', proof = 'verified fixture usage') {
  return { requestId: request.requestId, payloadSha256: request.payloadSha256, actualMicroUsd, proofSha256: sha(proof) };
}
function restored(request, status = 'UNKNOWN_HELD', actualMicroUsd = null, proofSha256 = null) {
  return { ...request, status, actualMicroUsd, proofSha256 };
}
async function merge(f, obligations, patch = {}) {
  return f.journal.mergeRestore({ restoreId: crypto.randomUUID(), obligations, budgetDay: '2026-10-02', minimumVersion: '1', ...patch });
}
function frames(bytes) {
  const values = [];
  for (let offset = 0; offset < bytes.length;) {
    const size = bytes.readUInt32BE(offset); values.push(JSON.parse(bytes.subarray(offset + 4, offset + 4 + size)));
    offset += 4 + size;
  }
  return values;
}
function canonical(item) {
  return item && typeof item === 'object'
    ? (Array.isArray(item) ? `[${item.map(canonical)}]` : `{${Object.keys(item).sort().map((key) => `${JSON.stringify(key)}:${canonical(item[key])}`).join(',')}}`)
    : JSON.stringify(item);
}
const maintenanceAck = async (_snapshot, metadata) => ({ ...metadata, verified: true });
function maintenanceInput(patch = {}) {
  return { transactionId: crypto.randomUUID(), kind: 'RESTORE', payloadSha256: sha('synthetic archive'),
    pgProjectionDigest: sha('synthetic committed PG'), legacyLiabilityUnresolved: false,
    budgetDay: '2026-10-02', minimumVersion: '80', ...patch };
}
function encode(value) {
  const bytes = Buffer.from(canonical(value)); const frame = Buffer.alloc(bytes.length + 4);
  frame.writeUInt32BE(bytes.length); bytes.copy(frame, 4); return frame;
}
async function rewriteAuthenticatedEvents(f, transform) {
  // Synthetic signing keys deliberately make the altered chain authentic: these
  // cases exercise replay's semantic validation, independently of MAC rejection.
  await f.journal.close();
  const records = transform(frames(await fs.readFile(f.log)));
  let previousHash = '0'.repeat(64); const bytes = [];
  for (let index = 0; index < records.length; index++) {
    const { mac, ...body } = { ...records[index], sequence: index + 1, previousHash };
    const signed = { ...body, mac: crypto.createHmac('sha256', f.keys.get(body.keyId))
      .update(`CI-SAFETY-RECORD-1\0${f.options.installationId}\0`).update(canonical(body)).digest('hex') };
    const frame = encode(signed); previousHash = sha(frame); bytes.push(frame);
  }
  const rewritten = Buffer.concat(bytes); await fs.writeFile(f.log, rewritten); return rewritten;
}

test('fresh enrollment is OFF, isolated from restore/source vault, and exposes no keys or internal state', async (t) => {
  const f = await fixture(t);
  assert.equal(f.journal.snapshot().aiOff, true);
  await rejects(f.journal.reserveAndPermit(f.request()), 'AI_OFF');
  assert.equal(f.controls.pgCalls, 0);
  for (const file of [f.log, f.lock, f.latch]) assert.equal((await fs.stat(file)).mode & 0o777, 0o600);
  assert.equal((await fs.stat(path.dirname(f.log))).mode & 0o777, 0o700);
  assert.deepEqual(Object.keys(f.journal).sort(), ['activate', 'close', 'completeMaintenance', 'consumePermit', 'holdUnknown', 'latch', 'mergeRestore', 'recordManifest', 'recordStartedBuild', 'reserveAndPermit', 'sanctionRollback', 'sealMaintenance', 'settle', 'snapshot'].sort());
  const before = f.journal.snapshot(); before.requests.push({ prompt: 'source sentinel' });
  assert.equal(f.journal.snapshot().requests.length, 0);
  assert.equal(f.keys.get('safety-1').equals(Buffer.alloc(32, 71)), true);
  await fs.mkdir(path.join(f.safetyRoot, 'source-vault'), { mode: 0o700 });
  await fs.writeFile(path.join(f.safetyRoot, 'source-vault', 'owner.lock'), 'other owner', { mode: 0o600 });
  await f.reopen();
  assert.equal(await fs.readFile(path.join(f.safetyRoot, 'source-vault', 'owner.lock'), 'utf8'), 'other owner');
});

test('existing opaque base64url installation identity survives restart without accepting non-UUID requests', async (t) => {
  const identity = Buffer.alloc(32, 251).toString('base64url');
  assert.match(identity, /^-/);
  const f = await fixture(t, { installationId: identity });
  assert.equal(f.journal.snapshot().installationId, identity);
  await activate(f);
  await rejects(f.journal.reserveAndPermit(f.request({ requestId: 'not-uuid' })), 'INVALID_INPUT');
  const request = f.request(); await f.journal.reserveAndPermit(request);
  await f.reopen();
  assert.equal(f.journal.snapshot().installationId, identity);
  assert.equal(f.journal.snapshot().requests[0].requestId, request.requestId);
  await rejects(f.reopen({ installationId: '_different_installation' }), 'LATCH_INVALID');
});

test('installation identity rejects whitespace, paths, empty and over-bound data before enrollment', async (t) => {
  for (const identity of ['', 'contains space', 'trailing\n', '../installation', 'x'.repeat(129), null]) {
    await rejects(fixture(t, { installationId: identity }), 'INVALID_INPUT');
  }
});

test('UUID, digest, identifier and decimal fields reject trailing line terminators before any effect', async (t) => {
  const f = await fixture(t); await activate(f); const request = f.request();
  for (const suffix of ['\n', '\r', '\r\n', '\u2028', '\u2029']) {
    const before = await fs.readFile(f.log);
    for (const key of ['requestId', 'payloadSha256', 'budgetDay', 'priceVersion', 'reservedMicroUsd']) {
      await rejects(f.journal.reserveAndPermit({ ...request, [key]: `${request[key]}${suffix}` }), 'INVALID_INPUT');
    }
    await rejects(merge(f, [], { restoreId: `${crypto.randomUUID()}${suffix}` }), 'INVALID_INPUT');
    await rejects(merge(f, [], { minimumVersion: `1${suffix}` }), 'INVALID_INPUT');
    assert.deepEqual(await fs.readFile(f.log), before); assert.equal(f.controls.pgCalls, 0);
  }
  await f.journal.reserveAndPermit(request); const usage = settlement(request); const before = await fs.readFile(f.log);
  for (const key of ['requestId', 'payloadSha256', 'actualMicroUsd', 'proofSha256']) {
    await rejects(f.journal.settle({ ...usage, [key]: `${usage[key]}\n` }), 'INVALID_INPUT');
  }
  assert.deepEqual(await fs.readFile(f.log), before); assert.equal(f.journal.snapshot().totalLiabilityMicroUsd, '100');
});

test('build sequence and signing key identifiers reject trailing LF before initialization', async (t) => {
  await rejects(fixture(t, { runningBuild: '100\n' }), 'INVALID_INPUT');
  await rejects(fixture(t, { keyProvider: { currentKeyId: async () => 'safety-1\n', getMacKey: async () => Buffer.alloc(32, 71) } }), 'INVALID_INPUT');
});

test('PG commit acknowledgement and both durable records precede one-use fake dispatch', async (t) => {
  const f = await fixture(t); await activate(f); f.controls.events = [];
  const request = f.request(); const permit = await f.journal.reserveAndPermit(request);
  const events = f.controls.events;
  assert.equal(events[0], 'pg.committed');
  assert.equal(events.filter((name) => name === 'log.afterFsync').length, 2);
  assert(events.lastIndexOf('log.afterFsync') < events.indexOf('permit.beforeReturn'));
  let providerCalls = 0;
  const send = async () => { await f.journal.consumePermit(permit); providerCalls++; };
  await send(); await rejects(send(), 'PERMIT_INVALID');
  assert.equal(providerCalls, 1);
  await rejects(f.journal.reserveAndPermit(request), 'DUPLICATE_REQUEST');
  const records = frames(await fs.readFile(f.log));
  assert.deepEqual(records.slice(-2).map((row) => row.event.type), ['RESERVED', 'DISPATCH_INTENT']);
  assert.equal(records.at(-1).sequence, records.length);
  assert.equal(records.at(-1).previousHash.length, 64);
  assert.equal(records.at(-1).mac.length, 64);
});

test('concurrent same UUID gets one permit; concurrent different UUIDs never exceed two live requests', async (t) => {
  const f = await fixture(t); await activate(f); const request = f.request();
  const results = await Promise.allSettled(Array.from({ length: 8 }, () => f.journal.reserveAndPermit(request)));
  assert.equal(results.filter((row) => row.status === 'fulfilled').length, 1);
  assert.equal(f.controls.pgCalls, 1);
  const different = await Promise.allSettled([f.journal.reserveAndPermit(f.request()), f.journal.reserveAndPermit(f.request())]);
  assert.equal(different.filter((row) => row.status === 'fulfilled').length, 1);
  assert.equal(different.find((row) => row.status === 'rejected').reason.code, 'CONCURRENCY_LIMIT');
});

test('permit must match both UUID and approved payload digest', async (t) => {
  const f = await fixture(t); await activate(f); const request = f.request();
  const permit = await f.journal.reserveAndPermit(request);
  await rejects(f.journal.consumePermit({ ...permit, payloadSha256: sha('different input') }), 'PERMIT_INVALID');
  await rejects(f.journal.consumePermit({ ...permit, requestId: crypto.randomUUID() }), 'PERMIT_INVALID');
  assert.equal((await f.journal.consumePermit(permit)).authorized, true);
});

test('restart drops every permit, retains the full reservation, and requires verified activation', async (t) => {
  const f = await fixture(t); await activate(f); const request = f.request();
  const permit = await f.journal.reserveAndPermit(request);
  await f.reopen();
  assert.equal(f.journal.snapshot().aiOff, true);
  assert.equal(f.journal.snapshot().requests[0].status, 'UNKNOWN_HELD');
  assert.equal(f.journal.snapshot().totalLiabilityMicroUsd, '100');
  await rejects(f.journal.consumePermit(permit), 'AI_OFF');
  await activate(f);
  await rejects(f.journal.consumePermit(permit), 'PERMIT_INVALID');
  await rejects(f.journal.reserveAndPermit(request), 'DUPLICATE_REQUEST');
});

test('settlement fsync precedes returned projection receipt and exact replay is idempotent', async (t) => {
  const f = await fixture(t); await activate(f); const request = f.request();
  await f.journal.reserveAndPermit(request); f.controls.events = [];
  const proof = settlement(request); const receipt = await f.journal.settle(proof);
  assert(f.controls.events.includes('log.afterFsync'));
  assert.equal(receipt.totalLiabilityMicroUsd, '40');
  const bytes = await fs.readFile(f.log);
  assert.equal((await f.journal.settle(proof)).sequence, receipt.sequence);
  assert.deepEqual(await fs.readFile(f.log), bytes);
  await f.reopen(); assert.equal(f.journal.snapshot().totalLiabilityMicroUsd, '40');
});

test('unknown usage retains full hold across budget days and never reissues its UUID', async (t) => {
  const f = await fixture(t); await activate(f); const request = f.request();
  const permit = await f.journal.reserveAndPermit(request);
  await f.journal.holdUnknown(request.requestId, 'PROVIDER_TIMEOUT');
  assert.equal(f.journal.snapshot().totalLiabilityMicroUsd, '100');
  await rejects(f.journal.consumePermit(permit), 'PERMIT_INVALID');
  f.controls.time += 32 * 86400000;
  await f.journal.reserveAndPermit(f.request({ reservedMicroUsd: '7' }));
  assert.equal(f.journal.snapshot().totalLiabilityMicroUsd, '107');
  await rejects(f.journal.reserveAndPermit(request), 'DUPLICATE_REQUEST');
});

test('unknown request rejection does not append a self-corrupting event', async (t) => {
  const f = await fixture(t); const before = await fs.readFile(f.log);
  await rejects(f.journal.holdUnknown(crypto.randomUUID()), 'UNKNOWN_REQUEST');
  assert.deepEqual(await fs.readFile(f.log), before);
  await f.reopen(); assert.equal(f.journal.snapshot().recoveryOnly, false);
});

test('missing or altered PG acknowledgement never returns a permit', async (t) => {
  for (const change of [{ committed: false }, { payloadSha256: sha('wrong') }, { reservedMicroUsd: '0' }, { budgetDay: '2026-10-01' }, { priceVersion: 'old' }]) {
    const f = await fixture(t, { verifyCommittedReservation: async (row) => ({ ...row, committed: true, ...change }) });
    await activate(f);
    await rejects(f.journal.reserveAndPermit(f.request()), 'ACK_MISMATCH');
    assert.equal(f.journal.snapshot().requests.length, 0); assert.equal(f.journal.snapshot().aiOff, true);
  }
});

test('usage must be verified, exact and bound to the approved payload', async (t) => {
  const f = await fixture(t); await activate(f); const request = f.request(); await f.journal.reserveAndPermit(request);
  f.controls.usage = false;
  await rejects(f.journal.settle(settlement(request, '0')), 'SETTLEMENT_MISMATCH');
  assert.equal(f.journal.snapshot().totalLiabilityMicroUsd, '100'); assert.equal(f.journal.snapshot().aiOff, true);
});

test('actual cost over reservation is recorded and blocks all later dispatch', async (t) => {
  const f = await fixture(t); await activate(f); const request = f.request(); await f.journal.reserveAndPermit(request);
  const state = await f.journal.settle(settlement(request, '145'));
  assert.equal(state.totalLiabilityMicroUsd, '145'); assert.equal(state.aiOff, true);
  await rejects(f.journal.reserveAndPermit(f.request()), 'AI_OFF');
  await rejects(activate(f), 'ACTIVATION_REJECTED');
  await f.reopen(); assert.equal(f.journal.snapshot().totalLiabilityMicroUsd, '145');
});

test('conflicting verified settlements keep the larger obligation and latch OFF', async (t) => {
  const f = await fixture(t); await activate(f); const request = f.request(); await f.journal.reserveAndPermit(request);
  await f.journal.settle(settlement(request));
  await rejects(f.journal.settle(settlement(request, '180', 'different verified usage')), 'SETTLEMENT_CONFLICT');
  assert.equal(f.journal.snapshot().totalLiabilityMicroUsd, '180');
  assert.equal(f.journal.snapshot().requests[0].conflict, true);
  assert.equal(frames(await fs.readFile(f.log)).at(-1).event.type, 'SETTLEMENT_CONFLICT');
  assert.equal(f.journal.snapshot().pendingRestore, null);
  await f.reopen(); assert.equal(f.journal.snapshot().totalLiabilityMicroUsd, '180');
  await rejects(activate(f), 'ACTIVATION_REJECTED');
});

for (const amount of [0, 1.5, -1, '01', '-1', '1.0', '9223372036854775808', '1e3']) {
  test(`rejects noncanonical or out-of-range amount ${JSON.stringify(amount)}`, async (t) => {
    const f = await fixture(t); await activate(f); const before = await fs.readFile(f.log);
    await rejects(f.journal.reserveAndPermit(f.request({ reservedMicroUsd: amount })), 'INVALID_INPUT');
    assert.deepEqual(await fs.readFile(f.log), before); assert.equal(f.controls.pgCalls, 0);
  });
}

test('microUSD never passes through floating point and signed64 endpoint remains exact', async (t) => {
  const f = await fixture(t); await activate(f);
  const max = f.request({ reservedMicroUsd: '9223372036854775807' });
  await f.journal.reserveAndPermit(max);
  const second = f.request({ reservedMicroUsd: '1' }); await f.journal.reserveAndPermit(second);
  assert.equal(f.journal.snapshot().totalLiabilityMicroUsd, '9223372036854775808');
  await f.journal.settle(settlement(max, '0')); assert.equal(f.journal.snapshot().totalLiabilityMicroUsd, '1');
});

test('clock rollback and stale budget epoch fail closed before PG acknowledgement', async (t) => {
  const f = await fixture(t); await activate(f); f.controls.time--;
  await rejects(f.journal.reserveAndPermit(f.request()), 'CLOCK_REGRESSION');
  assert.equal(f.controls.pgCalls, 0); assert.equal(f.journal.snapshot().aiOff, true);
});

test('time changing during PG acknowledgement cannot obtain a dispatch permit', async (t) => {
  const f = await fixture(t); await activate(f);
  f.options.verifyCommittedReservation = async (row) => { f.controls.time--; return { ...row, committed: true }; };
  await rejects(f.journal.reserveAndPermit(f.request()), 'CLOCK_REGRESSION');
  assert.equal(f.journal.snapshot().aiOff, true);
});

test('clock rollback while persisting dispatch intent still yields no permit', async (t) => {
  const f = await fixture(t); await activate(f);
  const fault = f.options.fault; let syncs = 0;
  f.options.fault = async (stage) => {
    await fault(stage);
    if (stage === 'log.afterFsync' && ++syncs === 2) f.controls.time--;
  };
  await rejects(f.journal.reserveAndPermit(f.request()), 'CLOCK_REGRESSION');
  assert.equal(f.journal.snapshot().totalLiabilityMicroUsd, '100');
});

test('old restore preserves latest dispatched hold, unions unknown UUIDs, and stays OFF', async (t) => {
  const f = await fixture(t); await activate(f); const recent = f.request();
  const permit = await f.journal.reserveAndPermit(recent);
  const oldOnly = f.request({ reservedMicroUsd: '25', budgetDay: '2026-09-01' });
  const state = await merge(f, [restored(oldOnly, 'SETTLED', '5', sha('untrusted backup proof'))], { budgetDay: '2026-09-01' });
  assert.equal(state.aiOff, true); assert.equal(state.totalLiabilityMicroUsd, '125');
  assert.equal(state.requests.length, 2); assert.equal(state.budgetDay, '2026-10-02');
  assert.equal(state.restoreReceipt.projectionDigest, state.projectionDigest);
  await rejects(f.journal.consumePermit(permit), 'AI_OFF');
  await f.reopen(); assert.equal(f.journal.snapshot().totalLiabilityMicroUsd, '125');
  assert.equal(f.journal.snapshot().aiOff, true);
});

test('only an existing authenticated final settlement releases the same request hold during restore', async (t) => {
  const f = await fixture(t); await activate(f); const request = f.request();
  await f.journal.reserveAndPermit(request); await f.journal.settle(settlement(request));
  const state = await merge(f, [restored(request, 'DISPATCHED')]);
  assert.equal(state.totalLiabilityMicroUsd, '40'); assert.equal(state.requests[0].status, 'SETTLED');
  const same = await merge(f, [restored(request, 'DISPATCHED')]);
  assert.equal(same.totalLiabilityMicroUsd, '40'); assert.equal(same.requests.length, 1);
});

test('restore conflicts preserve max liability and cannot be reactivated', async (t) => {
  const f = await fixture(t); await activate(f); const request = f.request(); await f.journal.reserveAndPermit(request);
  await f.journal.settle(settlement(request, '20'));
  const state = await merge(f, [restored({ ...request, payloadSha256: sha('other payload'), reservedMicroUsd: '200' })]);
  assert.equal(state.totalLiabilityMicroUsd, '200'); assert.equal(state.requests[0].conflict, true);
  await rejects(activate(f), 'ACTIVATION_REJECTED');
});

test('build-sequence high-water uses numeric order and does not regress with old backups', async (t) => {
  const f = await fixture(t); await merge(f, [], { minimumVersion: '10' });
  await merge(f, [], { minimumVersion: '9', budgetDay: '2026-01-01' });
  assert.equal(f.journal.snapshot().minimumVersion, '10');
  await f.reopen({ runningBuild: '9' }); await rejects(activate(f), 'BUILD_TOO_OLD');
  await f.reopen({ runningBuild: '10' }); await activate(f); assert.equal(f.journal.snapshot().aiOff, false);
});

test('restored future budget bucket never creates fresh allowance when the local clock is behind', async (t) => {
  const f = await fixture(t); await merge(f, [], { budgetDay: '2026-11-01' });
  await rejects(activate(f), 'CLOCK_REGRESSION'); assert.equal(f.journal.snapshot().aiOff, true);
});

test('a restore interrupted before its first row cannot be replaced by empty, older or changed input', async (t) => {
  const f = await fixture(t);
  const incoming = [restored(f.request({ reservedMicroUsd: '50' })), restored(f.request({ reservedMicroUsd: '80' }))]
    .sort((a, b) => a.requestId.localeCompare(b.requestId));
  const input = { restoreId: crypto.randomUUID(), obligations: incoming, budgetDay: '2026-10-02', minimumVersion: '80' };
  f.arm('log.beforeWrite', 3); // LATCH and input commitment survive; no row does.
  await rejects(f.journal.mergeRestore(input), 'IO_FAILURE');
  f.controls.fault = null; await f.reopen();
  const before = await fs.readFile(f.log); const pending = f.journal.snapshot().pendingRestore;
  assert.equal(pending.restoreId, input.restoreId); assert.equal(pending.inputDigest, sha(canonical(input)));
  assert.equal(pending.obligationCount, 2); assert.equal(pending.appliedCount, 0);
  assert.equal(pending.lastRequestId, null); assert.match(pending.processedInputDigest, /^[0-9a-f]{64}$/);
  const detached = f.journal.snapshot(); detached.pendingRestore.appliedCount = 2;
  assert.equal(f.journal.snapshot().pendingRestore.appliedCount, 0); assert.equal('inputHasher' in pending, false);
  assert.equal(f.journal.snapshot().totalLiabilityMicroUsd, '0'); // Not an admission allowance: pending blocks activation.
  for (const patch of [
    { restoreId: crypto.randomUUID(), obligations: [], budgetDay: '2026-09-01', minimumVersion: '2' },
    { restoreId: crypto.randomUUID() }, { obligations: [] }, { obligations: incoming.slice(0, 1) },
    { obligations: [{ ...incoming[0], reservedMicroUsd: '1' }, incoming[1]] },
    { budgetDay: '2026-10-01' }, { minimumVersion: '79' },
  ]) {
    await rejects(f.journal.mergeRestore({ ...input, ...patch }), 'RESTORE_PENDING');
    assert.deepEqual(await fs.readFile(f.log), before);
    assert.deepEqual(f.journal.snapshot().pendingRestore, pending);
  }
  await rejects(activate(f), 'ACTIVATION_REJECTED');
  await rejects(f.journal.reserveAndPermit(f.request()), 'AI_OFF');
  assert.equal(f.controls.pgCalls, 0); assert.equal(f.journal.snapshot().minimumVersion, '80');
  // Caller order is immaterial; the exact commitment covers UUID-sorted rows.
  const state = await f.journal.mergeRestore({ ...input, obligations: [...incoming].reverse() });
  assert.equal(state.pendingRestore, null); assert.equal(state.totalLiabilityMicroUsd, '130');
  assert.equal(state.restoreReceipt.inputDigest, pending.inputDigest); assert.equal(state.restoreReceipt.obligationCount, 2);
  assert.equal(state.restoreReceipt.projectionDigest, state.projectionDigest);
  await activate(f); assert.equal(f.journal.snapshot().aiOff, false);
});

for (const stage of ['log.beforeWrite', 'log.afterWrite', 'log.beforeFsync', 'log.afterFsync']) {
  for (const rowIndex of [0, 1]) {
    test(`${stage} on restore row ${rowIndex} resumes only durable row progress after restart`, async (t) => {
      const f = await fixture(t);
      const incoming = [restored(f.request({ budgetDay: '2026-11-01', reservedMicroUsd: '50' })),
        restored(f.request({ reservedMicroUsd: '80' }))].sort((a, b) => a.requestId.localeCompare(b.requestId));
      const input = { restoreId: crypto.randomUUID(), obligations: incoming, budgetDay: '2026-11-01', minimumVersion: '80' };
      f.arm(stage, 3 + rowIndex); await rejects(f.journal.mergeRestore(input), 'IO_FAILURE');
      f.controls.fault = null; await f.reopen();
      const applied = rowIndex + (stage === 'log.beforeWrite' ? 0 : 1);
      const pending = f.journal.snapshot().pendingRestore;
      assert.equal(pending.appliedCount, applied); assert.equal(pending.obligationCount, 2);
      assert.equal(pending.lastRequestId, applied ? incoming[applied - 1].requestId : null);
      assert.equal(pending.inputBudgetDay, input.budgetDay); assert.equal(pending.inputMinimumVersion, input.minimumVersion);
      assert.equal(pending.inputDigest, sha(canonical(input))); assert.equal(f.journal.snapshot().restoreReceipt, null);
      const durableLiability = incoming.slice(0, applied).reduce((sum, row) => sum + BigInt(row.reservedMicroUsd), 0n).toString();
      assert.equal(f.journal.snapshot().totalLiabilityMicroUsd, durableLiability);
      await rejects(merge(f, [], { budgetDay: '2026-09-01', minimumVersion: '2' }), 'RESTORE_PENDING');
      const state = await f.journal.mergeRestore(input);
      assert.equal(state.totalLiabilityMicroUsd, '130'); assert.equal(state.pendingRestore, null);
      assert.equal(state.budgetDay, '2026-11-01'); assert.equal(state.minimumVersion, '80');
      const events = frames(await fs.readFile(f.log)).map((record) => record.event);
      assert.equal(events.filter((event) => event.type === 'RESTORE_BEGIN').length, 1);
      assert.deepEqual(events.filter((event) => event.type === 'RESTORE_OBLIGATION_V2').map((event) => event.index), [0, 1]);
      assert.equal(events.filter((event) => event.type === 'RESTORE_RECEIPT').length, 1);
      await f.reopen(); assert.equal(f.journal.snapshot().totalLiabilityMicroUsd, '130');
      await rejects(activate(f), 'CLOCK_REGRESSION');
    });
  }
}

test('a completed restore permits a new restore while retaining the earlier obligations and high-water', async (t) => {
  const f = await fixture(t); const request = restored(f.request({ reservedMicroUsd: '50' }));
  const input = { restoreId: crypto.randomUUID(), obligations: [request], budgetDay: '2026-11-01', minimumVersion: '80' };
  await f.journal.mergeRestore(input); await f.reopen();
  const completed = f.journal.snapshot().restoreReceipt;
  const retry = await f.journal.mergeRestore(input);
  assert.deepEqual(retry.restoreReceipt, completed); assert.equal(retry.pendingRestore, null);
  assert.equal(frames(await fs.readFile(f.log)).filter((record) => record.event.type === 'RESTORE_OBLIGATION_V2').length, 1);
  await rejects(f.journal.mergeRestore({ ...input, obligations: [] }), 'RESTORE_CONFLICT');
  const next = await merge(f, [], { budgetDay: '2026-09-01', minimumVersion: '2' });
  assert.notEqual(next.restoreReceipt.restoreId, input.restoreId); assert.equal(next.restoreReceipt.obligationCount, 0);
  assert.equal(next.pendingRestore, null); assert.equal(next.totalLiabilityMicroUsd, '50');
  assert.equal(next.minimumVersion, '80'); assert.equal(next.budgetDay, '2026-11-01');
  await f.reopen(); assert.equal(f.journal.snapshot().totalLiabilityMicroUsd, '50');
});

for (const stage of ['log.beforeWrite', 'log.afterFsync']) {
  test(`${stage} at the completion receipt resumes without duplicating accepted obligations`, async (t) => {
    const f = await fixture(t); const request = restored(f.request({ reservedMicroUsd: '30' }));
    const input = { restoreId: crypto.randomUUID(), obligations: [request], budgetDay: '2026-10-02', minimumVersion: '1' };
    f.arm(stage, 4); await rejects(f.journal.mergeRestore(input), 'IO_FAILURE');
    f.controls.fault = null; await f.reopen();
    assert.equal(f.journal.snapshot().pendingRestore?.appliedCount ?? null, stage === 'log.beforeWrite' ? 1 : null);
    await f.journal.mergeRestore(input);
    const events = frames(await fs.readFile(f.log)).map((record) => record.event);
    assert.equal(events.filter((event) => event.type === 'RESTORE_BEGIN').length, 1);
    assert.equal(events.filter((event) => event.type === 'RESTORE_OBLIGATION_V2').length, 1);
    assert.equal(events.filter((event) => event.type === 'RESTORE_RECEIPT').length, 1);
    assert.equal(f.journal.snapshot().totalLiabilityMicroUsd, '30');
  });
}

test('repeated interruptions preserve one begin and one durable event per original input row', async (t) => {
  const f = await fixture(t);
  const input = { restoreId: crypto.randomUUID(), obligations: [restored(f.request({ reservedMicroUsd: '50' })),
    restored(f.request({ reservedMicroUsd: '80' }))], budgetDay: '2026-10-02', minimumVersion: '1' };
  f.arm('log.beforeWrite', 4); await rejects(f.journal.mergeRestore(input), 'IO_FAILURE');
  f.controls.fault = null; await f.reopen();
  const progress = f.journal.snapshot().pendingRestore;
  assert.equal(progress.appliedCount, 1);
  f.arm('log.beforeWrite', 2); await rejects(f.journal.mergeRestore(input), 'IO_FAILURE');
  f.controls.fault = null; await f.reopen();
  assert.deepEqual(f.journal.snapshot().pendingRestore, progress);
  const state = await f.journal.mergeRestore(input); assert.equal(state.totalLiabilityMicroUsd, '130');
  const events = frames(await fs.readFile(f.log)).map((record) => record.event);
  assert.equal(events.filter((event) => event.type === 'RESTORE_BEGIN').length, 1);
  assert.deepEqual(events.filter((event) => event.type === 'RESTORE_OBLIGATION_V2').map((event) => event.index), [0, 1]);
  assert.equal(events.filter((event) => event.type === 'RESTORE_RECEIPT').length, 1);
});

test('resume verifies the recorded prefix against the exact original input before adding any more rows', async (t) => {
  const f = await fixture(t);
  const input = { restoreId: crypto.randomUUID(), obligations: [restored(f.request()), restored(f.request())],
    budgetDay: '2026-10-02', minimumVersion: '1' };
  f.arm('log.beforeWrite', 4); await rejects(f.journal.mergeRestore(input), 'IO_FAILURE'); f.controls.fault = null;
  await rewriteAuthenticatedEvents(f, (records) => {
    records.find((record) => record.event.type === 'RESTORE_OBLIGATION_V2').event.obligation.status = 'DISPATCHED';
    return records;
  });
  await f.reopen(); const before = await fs.readFile(f.log);
  await rejects(f.journal.mergeRestore(input), 'RESTORE_INVALID');
  assert.deepEqual(await fs.readFile(f.log), before); assert.equal(f.journal.snapshot().recoveryOnly, true);
});

test('authenticated replay cannot activate while the original restore still has missing rows', async (t) => {
  const f = await fixture(t);
  await merge(f, [restored(f.request())]);
  const rewritten = await rewriteAuthenticatedEvents(f, (records) => {
    const receipt = records.find((record) => record.event.type === 'RESTORE_RECEIPT');
    const partial = records.filter((record) => !['RESTORE_OBLIGATION_V2', 'RESTORE_RECEIPT'].includes(record.event.type));
    partial.push({ ...receipt, event: { type: 'ACTIVATED', projectionDigest: f.journal.snapshot().projectionDigest } });
    return partial;
  });
  await rejects(openSafetyJournal(f.options), 'STATE_INVALID');
  assert.deepEqual(await fs.readFile(f.log), rewritten);
});

for (const defect of ['premature-empty-receipt', 'premature-partial-receipt', 'row-before-begin', 'row-after-receipt',
  'repeated-row', 'repeated-uuid-with-next-index', 'out-of-order-rows', 'wrong-index', 'wrong-restore-id', 'wrong-input-digest',
  'different-row-same-projection', 'different-input-metadata', 'replacement-begin']) {
  test(`authenticated replay rejects restore transaction defect ${defect}`, async (t) => {
    const f = await fixture(t);
    await merge(f, [restored(f.request({ reservedMicroUsd: '50' })), restored(f.request({ reservedMicroUsd: '80' }))]);
    const rewritten = await rewriteAuthenticatedEvents(f, (records) => {
      const begin = records.findIndex((record) => record.event.type === 'RESTORE_BEGIN');
      const rows = records.map((record, index) => record.event.type === 'RESTORE_OBLIGATION_V2' ? index : -1).filter((index) => index >= 0);
      if (defect === 'premature-empty-receipt') return records.filter((record) => record.event.type !== 'RESTORE_OBLIGATION_V2');
      if (defect === 'premature-partial-receipt') records.splice(rows[1], 1);
      if (defect === 'row-before-begin') [records[begin], records[rows[0]]] = [records[rows[0]], records[begin]];
      if (defect === 'row-after-receipt') records.push(records[rows[0]]);
      if (defect === 'repeated-row') records.splice(rows[1], 0, records[rows[0]]);
      if (defect === 'repeated-uuid-with-next-index') records[rows[1]].event.obligation = records[rows[0]].event.obligation;
      if (defect === 'out-of-order-rows') [records[rows[0]].event.obligation, records[rows[1]].event.obligation]
        = [records[rows[1]].event.obligation, records[rows[0]].event.obligation];
      if (defect === 'wrong-index') records[rows[0]].event.index = 1;
      if (defect === 'wrong-restore-id') records[rows[0]].event.restoreId = crypto.randomUUID();
      if (defect === 'wrong-input-digest') records[rows[0]].event.inputDigest = sha('different input');
      if (defect === 'different-row-same-projection') records[rows[0]].event.obligation.status = 'DISPATCHED';
      if (defect === 'different-input-metadata') records[begin].event.inputMinimumVersion = '0';
      if (defect === 'replacement-begin') records.splice(rows[0], 0, { ...records[begin], event: { ...records[begin].event, restoreId: crypto.randomUUID() } });
      return records;
    });
    await rejects(openSafetyJournal(f.options), 'RESTORE_INVALID');
    assert.deepEqual(await fs.readFile(f.log), rewritten); await fs.access(f.latch);
  });
}

test('OFF latch survives unrelated data restore and blocks consumption of an already issued permit', async (t) => {
  const f = await fixture(t); await activate(f); const permit = await f.journal.reserveAndPermit(f.request());
  await f.journal.latch('RESTORE'); const before = await fs.readFile(f.latch);
  await fs.rm(f.restoreRoot, { recursive: true }); await fs.mkdir(f.restoreRoot, { mode: 0o700 });
  await fs.writeFile(path.join(f.restoreRoot, 'old-db-fixture'), 'old projection');
  assert.deepEqual(await fs.readFile(f.latch), before);
  await rejects(f.journal.consumePermit(permit), 'AI_OFF');
  assert.equal(f.journal.snapshot().totalLiabilityMicroUsd, '100');
});

test('activation requires explicit consent plus exact current projection and successful trusted health acknowledgement', async (t) => {
  const f = await fixture(t);
  await rejects(f.journal.activate({ projectionDigest: sha('stale'), userApproved: true }), 'ACTIVATION_REJECTED');
  await rejects(f.journal.activate({ projectionDigest: f.journal.snapshot().projectionDigest, userApproved: false }), 'ACTIVATION_REJECTED');
  f.controls.health = false; await rejects(activate(f), 'ACTIVATION_REJECTED');
  assert.equal(f.journal.snapshot().aiOff, true); await fs.access(f.latch);
});

test('repeating a verified activation never appends another event or loses its state', async (t) => {
  const f = await fixture(t); await activate(f); const before = await fs.readFile(f.log);
  await activate(f); assert.deepEqual(await fs.readFile(f.log), before);
  assert.equal(f.journal.snapshot().aiOff, false);
});

for (const stage of ['log.beforeWrite', 'log.afterWrite', 'log.beforeFsync', 'log.afterFsync', 'permit.beforeReturn']) {
  for (const remaining of stage === 'permit.beforeReturn' ? [1] : [1, 2]) {
    test(`${stage} failure at reservation/intent ${remaining} cannot acknowledge a permit`, async (t) => {
      const f = await fixture(t); await activate(f); f.arm(stage, remaining);
      let providerCalls = 0;
      const gatedSend = async () => {
        const permit = await f.journal.reserveAndPermit(f.request());
        await f.journal.consumePermit(permit); providerCalls++;
      };
      await rejects(gatedSend(), 'IO_FAILURE'); assert.equal(providerCalls, 0);
      assert.equal(f.journal.snapshot().aiOff, true); await fs.access(f.latch);
      f.controls.fault = null; await f.reopen();
      assert.equal(f.journal.snapshot().aiOff, true);
      assert(f.journal.snapshot().requests.every((row) => row.status === 'UNKNOWN_HELD'));
    });
  }
}

for (const stage of ['latch.beforeWrite', 'latch.afterWrite', 'latch.beforeFsync', 'latch.afterFsync', 'latch.beforeRename', 'latch.afterRename', 'latch.beforeDirectoryFsync', 'latch.afterDirectoryFsync']) {
  test(`${stage} fault keeps dispatch OFF and cannot lose the old latch`, async (t) => {
    const f = await fixture(t); f.arm(stage);
    await rejects(f.journal.latch('RESTORE'), 'IO_FAILURE');
    assert.equal(f.journal.snapshot().aiOff, true); await fs.access(f.latch);
    await rejects(f.journal.reserveAndPermit(f.request()), 'RECOVERY_REQUIRED');
  });
}

for (const stage of ['activate.beforeUnlink', 'activate.afterUnlink', 'activate.beforeDirectoryFsync', 'activate.afterDirectoryFsync']) {
  test(`${stage} fault never acknowledges activation`, async (t) => {
    const f = await fixture(t); f.arm(stage);
    await rejects(activate(f), 'IO_FAILURE'); assert.equal(f.journal.snapshot().aiOff, true);
    f.controls.fault = null; await f.reopen(); assert.equal(f.journal.snapshot().aiOff, true); await fs.access(f.latch);
  });
}

test('settlement fsync failure yields full hold and never returns a projection receipt', async (t) => {
  const f = await fixture(t); await activate(f); const request = f.request(); await f.journal.reserveAndPermit(request);
  f.arm('log.beforeFsync'); await rejects(f.journal.settle(settlement(request, '20')), 'IO_FAILURE');
  assert.equal(f.journal.snapshot().totalLiabilityMicroUsd, '100'); assert.equal(f.journal.snapshot().aiOff, true);
});

test('single-writer lock is exclusive and an ambiguous stale owner is never removed', async (t) => {
  const f = await fixture(t); const lock = await fs.readFile(f.lock);
  await rejects(openSafetyJournal(f.options), 'WRITER_LOCKED'); assert.deepEqual(await fs.readFile(f.lock), lock);
  await f.journal.close(); await fs.writeFile(f.lock, '{"pid":99999999}', { mode: 0o600 });
  await rejects(openSafetyJournal(f.options), 'WRITER_LOCKED');
  assert.equal(await fs.readFile(f.lock, 'utf8'), '{"pid":99999999}');
});

test('initialization never overwrites an existing journal, even when its log is missing', async (t) => {
  const f = await fixture(t); await f.journal.close(); const before = await fs.readFile(f.log);
  await rejects(initializeSafetyJournal(f.options), 'ALREADY_INITIALIZED'); assert.deepEqual(await fs.readFile(f.log), before);
  await fs.unlink(f.log); await rejects(initializeSafetyJournal(f.options), 'ALREADY_INITIALIZED');
  await rejects(openSafetyJournal(f.options), 'JOURNAL_MISSING'); await fs.access(f.latch);
});

test('partial final frame preserves the valid prefix, reports full holds, and is never silently truncated', async (t) => {
  const f = await fixture(t); await activate(f); await f.journal.reserveAndPermit(f.request()); await f.journal.close();
  await fs.appendFile(f.log, Buffer.from([0, 0, 0, 9, 123, 34])); const before = await fs.readFile(f.log);
  await assert.rejects(openSafetyJournal(f.options), (error) => {
    assert.equal(error.code, 'TORN_TAIL'); assert.equal(error.state.totalLiabilityMicroUsd, '100');
    assert.equal(error.state.requests[0].status, 'UNKNOWN_HELD'); assert.equal(error.state.recoveryOnly, true); return true;
  });
  assert.deepEqual(await fs.readFile(f.log), before); await fs.access(f.latch);
});

for (const defect of ['mac', 'sequence', 'previousHash', 'major', 'utf8', 'length']) {
  test(`replay fails closed on ${defect} damage without modifying the log`, async (t) => {
    const f = await fixture(t); await f.journal.close(); const record = frames(await fs.readFile(f.log))[0];
    let bytes;
    if (defect === 'mac') record.mac = 'f'.repeat(64);
    if (defect === 'sequence') record.sequence = 2;
    if (defect === 'previousHash') record.previousHash = 'f'.repeat(64);
    if (defect === 'major') record.major = 2;
    bytes = encode(record);
    if (defect === 'utf8') bytes[10] = 255;
    if (defect === 'length') bytes.writeUInt32BE(0xffffffff);
    await fs.writeFile(f.log, bytes);
    await assert.rejects(openSafetyJournal(f.options), (error) => error.aiOff && error.recoveryOnly);
    assert.deepEqual(await fs.readFile(f.log), bytes); await fs.access(f.latch);
  });
}

test('source, prompt, credentials and arbitrary metadata are rejected before journal writes', async (t) => {
  const f = await fixture(t); await activate(f); const before = await fs.readFile(f.log);
  for (const key of ['prompt', 'source', 'token', 'apiKey', 'command', 'metadata']) {
    await rejects(f.journal.reserveAndPermit({ ...f.request(), [key]: 'source sentinel token sentinel' }), 'INVALID_INPUT');
  }
  assert.deepEqual(await fs.readFile(f.log), before);
  assert.doesNotMatch(before.toString(), /source sentinel|token sentinel|GGGGGGGGGG/);
});

test('independent safety key rotation retains old verification keys and missing keys never recreate history', async (t) => {
  const f = await fixture(t); await activate(f); await f.journal.reserveAndPermit(f.request());
  f.controls.keyId = 'safety-2'; await f.journal.latch(); await f.reopen();
  assert.equal(f.journal.snapshot().totalLiabilityMicroUsd, '100');
  assert.deepEqual(new Set(frames(await fs.readFile(f.log)).map((row) => row.keyId)), new Set(['safety-1', 'safety-2']));
  await f.journal.close(); f.keys.delete('safety-1'); const before = await fs.readFile(f.log);
  await rejects(openSafetyJournal(f.options), 'KEY_UNAVAILABLE'); assert.deepEqual(await fs.readFile(f.log), before);
});

test('journal clears every transferred key copy on signing and replay without changing provider-retained keys', async (t) => {
  const f = await fixture(t); await activate(f); await f.journal.reserveAndPermit(f.request());
  f.controls.keyId = 'safety-2'; await f.journal.latch(); await f.reopen();
  assert.ok(f.controls.issuedKeys.length > 6);
  for (const ownedCopy of f.controls.issuedKeys) assert.equal(ownedCopy.every(byte => byte === 0), true);
  assert.deepEqual(f.keys.get('safety-1'), Buffer.alloc(32, 71));
  assert.deepEqual(f.keys.get('safety-2'), Buffer.alloc(32, 82));
});

async function mixedKeyHistory(f, latches) {
  // GENESIS and every later record use safety-1; only the second record uses safety-2.
  f.controls.keyId = 'safety-2'; await f.journal.latch(); f.controls.keyId = 'safety-1';
  for (let index = 0; index < latches; index++) await f.journal.latch();
  await f.journal.close();
}
function countingKeys(f, calls) {
  const { getMacKey } = f.options.keyProvider;
  return { ...f.options.keyProvider, getMacKey: async (id, purpose) => { calls.push(id); return getMacKey(id, purpose); } };
}

test('replay verifies each key id before first use and after the last record, independent of history length', async (t) => {
  for (const latches of [1, 40]) {
    const f = await fixture(t); await mixedKeyHistory(f, latches); const calls = [];
    const journal = await f.reopen({ keyProvider: countingKeys(f, calls) });
    assert.equal(journal.snapshot().sequence, latches + 3);
    // Latch read, first use of each id, closing check of each id, then restart latch read/sign and record sign.
    assert.deepEqual(calls, ['safety-1', 'safety-1', 'safety-2', 'safety-1', 'safety-2', 'safety-1', 'safety-1', 'safety-1']);
    for (const ownedCopy of f.controls.issuedKeys) assert.equal(ownedCopy.every(byte => byte === 0), true);
  }
});

test('replay with per-replay key copies still rejects any damaged MAC or a MAC from another key id', async (t) => {
  const f = await fixture(t); await mixedKeyHistory(f, 2); const records = frames(await fs.readFile(f.log));
  const sign = (record, material) => {
    const { mac, ...body } = record;
    return { ...body, mac: crypto.createHmac('sha256', material).update(`CI-SAFETY-RECORD-1\0${f.options.installationId}\0`).update(canonical(body)).digest('hex') };
  };
  const damaged = records.map((_, index) => records.map((record, i) => i !== index ? record
    : { ...record, mac: (record.mac[0] === '0' ? '1' : '0') + record.mac.slice(1) }));
  // Both ids are already cached when these records are reached.
  damaged.push(records.map((record, i) => i === 2 ? sign(record, f.keys.get('safety-2')) : record));
  damaged.push(records.map((record, i) => i === 3 ? sign({ ...record, keyId: 'safety-2' }, f.keys.get('safety-1')) : record));
  for (const values of damaged) {
    const bytes = Buffer.concat(values.map(encode)); await fs.writeFile(f.log, bytes);
    await rejects(openSafetyJournal(f.options), 'MAC_INVALID'); assert.deepEqual(await fs.readFile(f.log), bytes);
  }
  for (const ownedCopy of f.controls.issuedKeys) assert.equal(ownedCopy.every(byte => byte === 0), true);
});

test('replay closing verification fails closed before restart writes when a key changes after its first use', async (t) => {
  const f = await fixture(t); await mixedKeyHistory(f, 3);
  const log = await fs.readFile(f.log); const latch = await fs.readFile(f.latch);
  let calls = 0; const { getMacKey } = f.options.keyProvider;
  // Calls 1-3 are the latch read and the first replay use of each id. Every later copy differs.
  const keyProvider = { ...f.options.keyProvider, getMacKey: async (id, purpose) => {
    const copy = await getMacKey(id, purpose); if (++calls > 3) copy[0] ^= 1; return copy;
  } };
  await rejects(openSafetyJournal({ ...f.options, keyProvider }), 'KEY_UNAVAILABLE');
  assert.deepEqual(await fs.readFile(f.log), log); assert.deepEqual(await fs.readFile(f.latch), latch);
  for (const ownedCopy of f.controls.issuedKeys) assert.equal(ownedCopy.every(byte => byte === 0), true);
});

test('replay key copies end with that replay; later operations and reopen fetch fresh copies', async (t) => {
  const f = await fixture(t); await mixedKeyHistory(f, 2); const calls = []; const keyProvider = countingKeys(f, calls);
  const used = []; const createHmac = crypto.createHmac;
  crypto.createHmac = (algorithm, key) => { used.push(key); return createHmac(algorithm, key); };
  try {
    await f.reopen({ keyProvider }); const opened = calls.length; const openKeys = new Set(used);
    for (const key of used) assert.equal(key.every(byte => byte === 0), true);
    const usedBefore = used.length; await f.journal.latch();
    assert.ok(calls.length > opened); assert.ok(used.length > usedBefore);
    assert.equal(used.slice(usedBefore).some(key => openKeys.has(key)), false);
    const reopened = calls.length; await f.reopen({ keyProvider }); assert.equal(calls.length - reopened, opened);
    for (const key of used) assert.equal(key.every(byte => byte === 0), true);
  } finally { crypto.createHmac = createHmac; }
});

for (const length of [0, 31, 33]) {
  test(`invalid ${length}-byte key is cleared even though MAC creation fails`, async (t) => {
    const issued = [];
    await rejects(fixture(t, { keyProvider: {
      currentKeyId: async () => 'safety-invalid',
      getMacKey: async () => { const copy = Buffer.alloc(length, 99); issued.push(copy); return copy; },
    } }), 'KEY_UNAVAILABLE');
    assert.ok(issued.length > 0);
    for (const copy of issued) assert.equal(copy.every(byte => byte === 0), true);
  });
}

test('HMAC implementation failure clears both transferred and internal key copies', async (t) => {
  const provided = []; const internal = []; const createHmac = crypto.createHmac;
  crypto.createHmac = (_algorithm, key) => { internal.push(key); throw new Error('SYNTHETIC_SECRET crypto failure'); };
  try {
    await rejects(fixture(t, { keyProvider: {
      currentKeyId: async () => 'safety-1',
      getMacKey: async () => { const owned = Buffer.alloc(32, 71); provided.push(owned); return owned; },
    } }), 'KEY_UNAVAILABLE');
  } finally { crypto.createHmac = createHmac; }
  assert.ok(provided.length > 0); assert.equal(internal.length, provided.length);
  for (let i = 0; i < provided.length; i++) {
    assert.notEqual(internal[i], provided[i]);
    assert.equal(provided[i].every(byte => byte === 0), true);
    assert.equal(internal[i].every(byte => byte === 0), true);
  }
});

test('restorable roots cannot contain safety or be contained by safety, including canonical aliases', async (t) => {
  const f = await fixture(t); await f.journal.close();
  for (const restoreRoot of [f.root, f.safetyRoot, path.join(f.safetyRoot, 'nested')]) {
    await rejects(openSafetyJournal({ ...f.options, restoreRoots: [restoreRoot] }), 'RESTORE_OVERLAP');
  }
  const alias = path.join(f.root, 'alias'); await fs.symlink(f.safetyRoot, alias);
  await rejects(openSafetyJournal({ ...f.options, restoreRoots: [alias] }), 'RESTORE_OVERLAP');
});

test('symlink, hardlink and insecure-mode journal files are refused', async (t) => {
  for (const defect of ['symlink', 'hardlink', 'permissions']) {
    const f = await fixture(t); await f.journal.close();
    if (defect === 'permissions') await fs.chmod(f.log, 0o644);
    else {
      const external = path.join(f.root, 'external'); await fs.rename(f.log, external);
      if (defect === 'symlink') await fs.symlink(external, f.log);
      else await fs.link(external, f.log);
    }
    await rejects(openSafetyJournal(f.options), 'UNSAFE_FILE');
  }
});

test('bounded capacity stops before another PG reservation and retains the complete log', async (t) => {
  const f = await fixture(t, { limits: { requests: 1 } }); await activate(f);
  const request = f.request(); await f.journal.reserveAndPermit(request); await f.journal.settle(settlement(request));
  const before = await fs.readFile(f.log); await rejects(f.journal.reserveAndPermit(f.request()), 'CAPACITY');
  assert.equal(f.controls.pgCalls, 1); assert.equal(f.journal.snapshot().aiOff, true); assert.deepEqual(await fs.readFile(f.log), before);
});

test('duplicate restored IDs and malformed restore metadata cannot partially apply a restore', async (t) => {
  const f = await fixture(t); const request = restored(f.request()); const before = await fs.readFile(f.log);
  await rejects(merge(f, [request, request]), 'INVALID_INPUT');
  await rejects(merge(f, [], { minimumVersion: '1.2.0' }), 'INVALID_INPUT');
  assert.deepEqual(await fs.readFile(f.log), before);
});

// Product maintenance receipts are distinct from the historical B-only merge receipt.
test('maintenance requires fixed verifier capabilities; absence never accepts caller-supplied PG evidence', async t => {
  const f = await fixture(t); const input = maintenanceInput(); const before = await fs.readFile(f.log);
  await rejects(f.journal.sealMaintenance(input), 'MAINTENANCE_REJECTED');
  await rejects(f.journal.completeMaintenance(input), 'MAINTENANCE_REJECTED');
  assert.deepEqual(await fs.readFile(f.log), before);
  assert.equal(f.journal.snapshot().pendingMaintenance, null);
});
for (const defect of ['false', 'mismatch', 'extra']) test(`maintenance ${defect} verification acknowledgement cannot publish a seal`, async t => {
  const f = await fixture(t, { verifyMaintenanceSeal: async (_state, metadata) => ({ ...metadata, verified: defect !== 'false',
    ...(defect === 'mismatch' ? { pgProjectionDigest: sha('other PG') } : {}), ...(defect === 'extra' ? { token: 'SYNTHETIC_SECRET' } : {}) }) });
  const before = await fs.readFile(f.log);
  await rejects(f.journal.sealMaintenance(maintenanceInput()), 'MAINTENANCE_REJECTED');
  assert.deepEqual(await fs.readFile(f.log), before);
});
test('maintenance metadata is exact, bounded, copied before queueing and never logs paths or source text', async t => {
  const seen = [];
  const f = await fixture(t, { verifyMaintenanceSeal: async (_state, metadata) => { seen.push(metadata); return { ...metadata, verified: true }; } });
  for (const patch of [{ transactionId: 'not-uuid' }, { kind: 'RESTORE\n' }, { payloadSha256: sha('x') + '\n' },
    { pgProjectionDigest: 'x' }, { legacyLiabilityUnresolved: 1 }, { budgetDay: '2026-02-30' }, { minimumVersion: '01' },
    { source: 'source sentinel' }, { path: '/private/SYNTHETIC_SECRET' }]) {
    await rejects(f.journal.sealMaintenance(maintenanceInput(patch)), 'INVALID_INPUT');
  }
  const input = maintenanceInput(); const expected = { ...input };
  const pending = f.journal.sealMaintenance(input); input.payloadSha256 = sha('mutated');
  const state = await pending;
  assert.deepEqual(state.pendingMaintenance, expected); assert.deepEqual(seen, [expected]);
  assert.equal((await fs.readFile(f.log)).includes('sentinel'), false);
  state.pendingMaintenance.kind = 'BACKUP'; assert.equal(f.journal.snapshot().pendingMaintenance.kind, 'RESTORE');
});
test('seal follows PG verification, fsync and readback; restart binds the same transaction and payload', async t => {
  let f;
  f = await fixture(t, { verifyMaintenanceSeal: async (_state, metadata) => {
    f.controls.events.push('pg.seal.verified'); return { ...metadata, verified: true };
  }, verifyMaintenanceCompletion: maintenanceAck });
  const input = maintenanceInput(); f.controls.events = [];
  const first = await f.journal.sealMaintenance(input);
  const trace = f.controls.events;
  assert(trace.indexOf('pg.seal.verified') < trace.indexOf('log.beforeWrite'));
  assert(trace.indexOf('log.afterFsync') < trace.indexOf('maintenance.afterReadback'));
  await rejects(activate(f), 'ACTIVATION_REJECTED');
  assert.equal((await f.journal.sealMaintenance(input)).sequence, first.sequence);
  await f.reopen(); assert.deepEqual(f.journal.snapshot().pendingMaintenance, input);
  for (const patch of [{ transactionId: crypto.randomUUID() }, { kind: 'BACKUP' }, { payloadSha256: sha('other archive') }])
    await rejects(f.journal.completeMaintenance({ ...input, ...patch }), 'MAINTENANCE_REJECTED');
  const completion = { ...input, pgProjectionDigest: sha('verified new PG') };
  const completed = await f.journal.completeMaintenance(completion);
  assert.equal(completed.pendingMaintenance, null); assert.deepEqual(completed.maintenanceReceipt, completion);
  assert.equal((await f.journal.completeMaintenance(completion)).sequence, completed.sequence);
  await f.reopen(); assert.deepEqual(f.journal.snapshot().maintenanceReceipt, completion);
  await rejects(f.journal.sealMaintenance(input), 'MAINTENANCE_REJECTED');
});
test('legacy liability is durable OR-only across completion, older restore input and restart; activation stays denied', async t => {
  const f = await fixture(t, { verifyMaintenanceSeal: maintenanceAck, verifyMaintenanceCompletion: maintenanceAck });
  const input = maintenanceInput({ legacyLiabilityUnresolved: true }); await f.journal.sealMaintenance(input);
  await f.journal.completeMaintenance({ ...input, legacyLiabilityUnresolved: false });
  await merge(f, [], { minimumVersion: '1', budgetDay: '2026-01-01' });
  await f.reopen(); const state = f.journal.snapshot();
  assert.equal(state.legacyLiabilityUnresolved, true); assert.equal(state.minimumVersion, '80');
  assert.equal(state.budgetDay, '2026-10-02'); await rejects(activate(f), 'ACTIVATION_REJECTED');
});
test('recovery mode cannot activate even after the matching maintenance receipt is complete', async t => {
  const f = await fixture(t, { recoveryMode: true, verifyMaintenanceSeal: maintenanceAck, verifyMaintenanceCompletion: maintenanceAck });
  const input = maintenanceInput(); await f.journal.sealMaintenance(input); await f.journal.completeMaintenance(input);
  await rejects(activate(f), 'ACTIVATION_REJECTED');
});
for (const stage of ['log.afterWrite', 'log.beforeFsync', 'log.afterFsync', 'maintenance.beforeReadback', 'maintenance.afterReadback']) {
  test(`unacknowledged maintenance seal at ${stage} stays OFF and retains persisted recovery evidence`, async t => {
    const f = await fixture(t, { verifyMaintenanceSeal: maintenanceAck, verifyMaintenanceCompletion: maintenanceAck });
    const input = maintenanceInput({ legacyLiabilityUnresolved: true }); f.arm(stage);
    await rejects(f.journal.sealMaintenance(input), 'IO_FAILURE');
    assert.equal(f.journal.snapshot().aiOff, true); assert.equal(f.journal.snapshot().recoveryOnly, true);
    assert.equal(f.journal.snapshot().legacyLiabilityUnresolved, true);
    f.controls.fault = null; await f.reopen();
    assert.deepEqual(f.journal.snapshot().pendingMaintenance, input); assert.equal(f.journal.snapshot().legacyLiabilityUnresolved, true);
    await rejects(activate(f), 'ACTIVATION_REJECTED');
  });
}
test('maintenance completion cannot bypass an unfinished B merge or lower high-water values', async t => {
  const f = await fixture(t, { verifyMaintenanceSeal: maintenanceAck, verifyMaintenanceCompletion: maintenanceAck });
  const input = maintenanceInput(); await f.journal.sealMaintenance(input);
  await rejects(f.journal.completeMaintenance({ ...input, minimumVersion: '1' }), 'MAINTENANCE_REJECTED');
  f.arm('log.beforeWrite', 3);
  await rejects(merge(f, [restored(f.request())]), 'IO_FAILURE');
  f.controls.fault = null; await f.reopen();
  assert.notEqual(f.journal.snapshot().pendingRestore, null);
  await rejects(f.journal.completeMaintenance(input), 'MAINTENANCE_REJECTED');
});
test('new restore conflict preserves immutable proven settlement and the maximum held floor through repeated imports/replay', async t => {
  const f = await fixture(t); await activate(f); const request = f.request(); const proof = settlement(request, '20');
  await f.journal.reserveAndPermit(request); await f.journal.settle(proof);
  await merge(f, [restored(request, 'SETTLED', '300', sha('different final amount'))]);
  const state = f.journal.snapshot(); const row = state.requests[0];
  assert.equal(row.status, 'SETTLED'); assert.equal(row.actualMicroUsd, '20'); assert.equal(row.proofSha256, proof.proofSha256);
  assert.equal(row.conflict, true); assert.equal(row.liabilityFloorMicroUsd, '300'); assert.equal(state.totalLiabilityMicroUsd, '300');
  await merge(f, [restored(request, 'SETTLED', '20', proof.proofSha256)]);
  await f.reopen(); assert.equal(f.journal.snapshot().totalLiabilityMicroUsd, '300');
  await rejects(activate(f), 'ACTIVATION_REJECTED');
});
test('historical RESTORE_OBLIGATION replay keeps its original conflict semantics and projection digest', async t => {
  const f = await fixture(t); await activate(f); const request = f.request();
  await f.journal.reserveAndPermit(request); await f.journal.settle(settlement(request, '20'));
  await merge(f, [restored(request, 'SETTLED', '300', sha('other historical proof'))]);
  const current = f.journal.snapshot();
  const oldRow = { ...current.requests[0], status: 'UNKNOWN_HELD', actualMicroUsd: null, proofSha256: null };
  const oldDigest = sha(canonical({ requests: [oldRow], budgetDay: current.budgetDay, minimumVersion: current.minimumVersion }));
  await rewriteAuthenticatedEvents(f, records => records.map(record => {
    if (record.event.type === 'RESTORE_OBLIGATION_V2') record.event.type = 'RESTORE_OBLIGATION';
    if (record.event.type === 'RESTORE_RECEIPT') record.event.projectionDigest = oldDigest;
    return record;
  }));
  await f.reopen(); assert.equal(f.journal.snapshot().requests[0].status, 'UNKNOWN_HELD');
  assert.equal(f.journal.snapshot().projectionDigest, oldDigest); assert.equal(f.journal.snapshot().totalLiabilityMicroUsd, '300');
});

test('idempotent maintenance acknowledgement rechecks the persisted chain instead of trusting stale memory', async t => {
  const f = await fixture(t, { verifyMaintenanceSeal: maintenanceAck }); const input = maintenanceInput();
  await f.journal.sealMaintenance(input);
  const bytes = await fs.readFile(f.log); const offset = bytes.indexOf('MAINTENANCE_SEALED'); assert(offset > 0);
  bytes[offset] = 'X'.charCodeAt(0); await fs.writeFile(f.log, bytes);
  await rejects(f.journal.sealMaintenance(input), 'LOG_CHANGED');
  assert.equal(f.journal.snapshot().recoveryOnly, true);
});
