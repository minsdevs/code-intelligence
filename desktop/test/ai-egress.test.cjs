'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { createAiEgress, LIMITS, CATALOG_TTL_MS, PLAN_TTL_MS } = require('../src/ai-egress.cjs');
const { initializeSafetyJournal, openSafetyJournal } = require('../src/safety-journal.cjs');
const sha = value => crypto.createHash('sha256').update(value).digest('hex');
const copy = value => JSON.parse(JSON.stringify(value));
const canonical = value => value && typeof value === 'object'
  ? (Array.isArray(value) ? `[${value.map(canonical).join(',')}]` : `{${Object.keys(value).sort().map(k => `${JSON.stringify(k)}:${canonical(value[k])}`).join(',')}}`)
  : JSON.stringify(value);
const deferred = () => { let resolve; let reject; const promise = new Promise((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; };
const failure = (promise, suffix) => assert.rejects(promise, error => {
  assert.match(error.code, /^AI_EGRESS_/);
  if (suffix) assert.equal(error.code, `AI_EGRESS_${suffix}`);
  assert.doesNotMatch(error.message, /fixture credential|private prompt|synthetic adapter secret/);
  assert.equal(error.state, undefined);
  return true;
});

// All keys, provider bytes, rows, clocks, and token bounds below are synthetic. The real journal
// owns private files, HMAC, fsync, dispatch-intent records and replay in a fresh temporary directory.
async function fixture(t, patch = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ci-egress-'));
  const data = path.join(root, 'data'); await fs.mkdir(data, { mode: 0o700 });
  const controls = { time: Date.parse('2026-10-03T12:00:00Z'), ticks: 100, sent: [], trace: [], fail: null,
    journalFault: null, mutateRead: null, readback: null, transport: null, credential: null, initialized: false };
  const installationId = crypto.randomUUID(); const mainEpoch = crypto.randomUUID(); const journals = []; const cores = [];
  let journal; let authority;
  const model = {
    provider: 'openai', model: 'fixture-model', operation: 'CHAT', endpointId: 'openai.chat', adapterVersion: 'fixture-adapter-1',
    tokenizerId: 'fixture-tokenizer', tokenizerVersion: '1', costContractSha256: sha('fixture bounds'), priceVersion: 'fixture-price-1',
    priceSha256: sha('fixture prices'), verifiedAtEpochMs: controls.time, inputTokenLimit: '1000', embeddingTokenLimit: '1000', outputTokenLimit: '100',
    rates: { inputMicroUsdPerMillion: '1000000', cachedInputMicroUsdPerMillion: '500000', outputMicroUsdPerMillion: '2000000', embeddingMicroUsdPerMillion: '3000000', fixedMicroUsd: '3' },
    validateBody: (body, expected) => body.model === expected.model && body.max_tokens === Number(expected.outputTokenMax)
      && typeof body.prompt === 'string' && Object.keys(body).every(k => ['model', 'max_tokens', 'prompt'].includes(k)),
    inputBound: () => ({ inputTokens: '10', embeddingInputTokens: '0' }),
    readUsage: body => body.usage,
  };
  controls.catalog = model;
  const settings = { ownerUserId: '1', revision: '2', provider: model.provider, model: model.model, state: 'ACTIVE' };
  const pg = { version: 1, complete: true,
    gate: { installationId, ownerUserId: '1', policyRevision: '3', policySha256: sha('fixture budget'), dailyLimitMicroUsd: '10000',
      monthlyLimitMicroUsd: '50000', reconciliationRequired: true, legacyLiabilityUnresolved: false,
      journalSequence: '0', journalHash: '0'.repeat(64), journalProjectionSha256: '0'.repeat(64), clockHighWaterMs: String(controls.time) },
    requests: [], evidence: [] };
  function placeholder(row) {
    return { ...copy(row), installationId, ownerUserId: null, projectId: null, snapshotId: null, approvalId: null,
      planSha256: '0'.repeat(64), wireBodySha256: '0'.repeat(64), dispatchBinding: null, journalSequence: null, journalHash: null };
  }
  function installSnapshot(snapshot) {
    for (const item of snapshot.requests) {
      const normalized = copy(item); delete normalized.dispatchIntent;
      let row = pg.requests.find(r => r.requestId === item.requestId);
      if (!row) { row = placeholder(normalized); pg.requests.push(row); }
      Object.assign(row, normalized, { journalSequence: String(snapshot.sequence), journalHash: snapshot.headHash });
    }
    Object.assign(pg.gate, { journalSequence: String(snapshot.sequence), journalHash: snapshot.headHash,
      journalProjectionSha256: snapshot.projectionDigest, clockHighWaterMs: String(snapshot.clockHighWaterMs),
      legacyLiabilityUnresolved: pg.gate.legacyLiabilityUnresolved || Boolean(snapshot.legacyLiabilityUnresolved),
      reconciliationRequired: snapshot.pendingRestore !== null || Boolean(snapshot.pendingMaintenance) || snapshot.requests.some(r => r.conflict
        || (r.status === 'SETTLED' && BigInt(r.actualMicroUsd) > BigInt(r.reservedMicroUsd))) });
  }
  const options = {
    installationId, mainEpoch, runningBuild: '100', clock: { wall: () => controls.time, monotonic: () => controls.ticks },
    openJournal: async callbacks => {
      const opener = controls.initialized ? openSafetyJournal : initializeSafetyJournal;
      journal = await opener({ ...callbacks, safetyRoot: path.join(root, 'safety'), restoreRoots: [data], installationId, runningBuild: '100',
        clock: () => controls.time, keyProvider: { currentKeyId: async () => 'fixture-key', getMacKey: async () => Buffer.alloc(32, 81) },
        fault: stage => { controls.trace.push(stage); if (controls.journalFault?.(stage)) throw new Error('synthetic adapter secret'); } });
      controls.initialized = true; journals.push(journal); return journal;
    },
    bindAuthority: value => { authority = value; },
    readProjection: async () => { if (controls.fail === 'projection') throw new Error('synthetic adapter secret'); return copy(pg); },
    readCommittedRequest: async requestId => {
      const result = { request: copy(pg.requests.find(r => r.requestId === requestId) || null), settings: copy(settings), projection: copy(pg) };
      controls.mutateRead?.(result); return result;
    },
    commitEvidence: async observed => {
      controls.trace.push('pg.evidence');
      assert.deepEqual(authority.readEvidence(observed.requestId, observed.proofSha256), observed);
      if (controls.fail === 'evidence') throw new Error('synthetic adapter secret');
      const fields = ['requestId', 'proofSha256', 'mainEpoch', 'receiptType', 'providerRequestId', 'usageDimensions', 'actualMicroUsd'];
      pg.evidence.push(Object.fromEntries(fields.map(name => [name, copy(observed[name])])));
      if (controls.fail === 'corruptEvidence') pg.evidence.at(-1).actualMicroUsd = '0';
    },
    applySettlement: async ({ phase, requestId, journal: snapshot }) => {
      controls.trace.push(`pg.${phase}`);
      assert.equal(authority.readJournal().position.hash, snapshot.headHash);
      if (phase === 'DISPATCHED') assert.equal(authority.readDispatch(requestId).payloadSha256, pg.requests.find(r => r.requestId === requestId).payloadSha256);
      if (phase === 'SETTLED') {
        const row = snapshot.requests.find(r => r.requestId === requestId);
        assert.equal(authority.readSettlement(requestId, row.proofSha256).actualMicroUsd, row.actualMicroUsd);
      }
      if (controls.fail === phase) throw new Error('synthetic adapter secret');
      installSnapshot(snapshot);
    },
    readback: async () => { const value = copy(pg); controls.readback?.(value); return value; },
    credentialProvider: async input => { controls.trace.push('credential'); return controls.credential ? controls.credential(input) : 'fixture-credential'; },
    contractCatalog: () => controls.catalog,
    transport: async request => {
      controls.trace.push('transport'); controls.sent.push({ ...request, headers: { ...request.headers }, body: Buffer.from(request.body), original: request.body });
      assert.equal(journal.snapshot().requests.find(r => r.requestId === request.requestId).dispatchIntent, true);
      if (controls.transport) return controls.transport(request);
      return response();
    },
    ...patch,
  };
  const core = await createAiEgress(options); cores.push(core);
  const result = {
    core, controls, pg, model, settings, options, root, installationId, mainEpoch,
    get journal() { return journal; }, get authority() { return authority; },
    input: overrides => ({ requestId: crypto.randomUUID(), approvalId: crypto.randomUUID(), planSha256: sha('fixture plan'),
      ownerUserId: '1', projectId: '2', snapshotId: '3', settingsRevision: '2', provider: 'openai', model: 'fixture-model', operation: 'CHAT',
      policyRevision: '3', policySha256: pg.gate.policySha256, budgetDay: new Date(controls.time).toISOString().slice(0, 10),
      expiresAt: controls.time + PLAN_TTL_MS, outputTokenCap: '20', body: Buffer.from('{ "model":"fixture-model", "max_tokens":20, "prompt":"private prompt" }'), ...overrides }),
    commit: meta => {
      const row = { ...copy(meta), status: 'RESERVED', actualMicroUsd: null, proofSha256: null,
        liabilityFloorMicroUsd: meta.reservedMicroUsd, conflict: false, journalSequence: null, journalHash: null };
      delete row.wireBodyBytes; pg.requests.push(row); return row;
    },
    on: async () => { await result.core.reconcile({ restoreId: crypto.randomUUID() }); await result.core.activate({ ownerUserId: '1',
      policyRevision: pg.gate.policyRevision, policySha256: pg.gate.policySha256, userApproved: true }); },
    request: async overrides => {
      const input = result.input(overrides); const meta = await result.core.prepare(input); result.commit(meta);
      await result.core.approve({ requestId: meta.requestId, approvalId: meta.approvalId, payloadSha256: meta.payloadSha256 }); return { input, meta };
    },
    send: meta => result.core.execute({ requestId: meta.requestId, payloadSha256: meta.payloadSha256 }),
    reopen: async () => { await result.core.close(); result.core = await createAiEgress(options); cores.push(result.core); },
  };
  t.after(async () => { for (const item of cores) await item.close().catch(() => {}); for (const item of journals) await item.close().catch(() => {}); await fs.rm(root, { recursive: true, force: true }); });
  return result;
}
function response(usage = { inputTokens: '5', cachedInputTokens: '0', outputTokens: '7', embeddingInputTokens: '0' }) {
  return { statusCode: 200, providerRequestId: 'fixture-response-1', body: Buffer.from(JSON.stringify({ answer: 'synthetic answer', usage })) };
}
function approve(meta) { return { requestId: meta.requestId, approvalId: meta.approvalId, payloadSha256: meta.payloadSha256 }; }

// Core path and accounting.
test('fresh OFF; exact bytes are privately owned, bound, sent once, then settled without reserve markup', async t => {
  const f = await fixture(t); assert.deepEqual(f.core.diagnostics(), { aiOff: true, recoveryOnly: true });
  await f.on(); const input = f.input(); const expected = Buffer.from(input.body); const meta = await f.core.prepare(input);
  assert.equal(meta.reservedMicroUsd, '59'); assert.equal(meta.wireBodySha256, sha(expected));
  const { payloadSha256, ...binding } = meta; assert.equal(payloadSha256, sha(canonical(binding)));
  assert.equal(meta.wireBodyBytes, String(expected.length)); assert.equal(meta.dispatchBinding.wireBodyBytes, meta.wireBodyBytes);
  input.body.fill(120); f.commit(meta); await f.core.approve(approve(meta)); const result = await f.send(meta);
  assert.equal(result.actualMicroUsd, '22'); assert.equal(f.controls.sent.length, 1); assert.deepEqual(f.controls.sent[0].body, expected);
  assert.deepEqual(f.controls.sent[0].original, Buffer.alloc(expected.length));
  assert.equal(f.journal.snapshot().requests[0].status, 'SETTLED'); assert.equal(f.pg.requests[0].actualMicroUsd, '22');
  assert.equal(f.controls.sent[0].origin, 'https://api.openai.com'); assert.equal(f.controls.sent[0].path, '/v1/chat/completions');
  assert.equal(f.controls.sent[0].redirects, 0); assert.equal(f.controls.sent[0].retries, 0);
  assert.ok(f.controls.trace.indexOf('pg.DISPATCHED') < f.controls.trace.indexOf('transport'));
  assert.ok(f.controls.trace.indexOf('transport') < f.controls.trace.indexOf('pg.evidence'));
  await failure(f.send(meta), 'DUPLICATE'); assert.equal(f.controls.sent.length, 1);
  assert.deepEqual(Object.keys(f.core).sort(), ['activate', 'approve', 'beginMaintenance', 'close', 'diagnostics', 'execute', 'latch', 'latchOffline', 'prepare', 'reconcile']);
  assert.doesNotMatch(JSON.stringify(meta), /private prompt|fixture-credential|https:/);
});

test('reservation uses one final integer ceil and settlement has no 110% factor', async t => {
  const f = await fixture(t); f.model.rates = { inputMicroUsdPerMillion: '1', cachedInputMicroUsdPerMillion: '0', outputMicroUsdPerMillion: '1', embeddingMicroUsdPerMillion: '0', fixedMicroUsd: '0' };
  await f.on(); const { meta } = await f.request(); assert.equal(meta.reservedMicroUsd, '1'); const result = await f.send(meta); assert.equal(result.actualMicroUsd, '1');
});

test('embedding contract and fixed Gemini endpoint use measured embedding dimensions', async t => {
  const f = await fixture(t); Object.assign(f.model, { provider: 'gemini', operation: 'EMBEDDING', endpointId: 'gemini.embed', outputTokenLimit: '0',
    inputBound: () => ({ inputTokens: '0', embeddingInputTokens: '10' }) });
  Object.assign(f.settings, { provider: 'gemini' }); await f.on();
  f.controls.transport = async () => response({ inputTokens: '0', cachedInputTokens: '0', outputTokens: '0', embeddingInputTokens: '5' });
  const { meta } = await f.request({ provider: 'gemini', operation: 'EMBEDDING', outputTokenCap: '0', body: Buffer.from('{"model":"fixture-model","max_tokens":0,"prompt":"synthetic"}') });
  assert.equal(meta.reservedMicroUsd, '37'); assert.equal((await f.send(meta)).actualMicroUsd, '18');
  assert.equal(f.controls.sent[0].path, '/v1beta/models/fixture-model:embedContent'); assert.equal(f.controls.sent[0].headers['x-goog-api-key'], 'fixture-credential');
});

for (const [label, mutate] of [
  ['absent catalog', f => { f.controls.catalog = null; }],
  ['old price', f => { f.model.verifiedAtEpochMs -= CATALOG_TTL_MS + 1; }],
  ['future catalog', f => { f.model.verifiedAtEpochMs++; }],
  ['unknown tokenizer', f => { f.model.inputBound = null; }],
  ['unknown output cap', f => { f.model.validateBody = () => false; }],
  ['missing rate', f => { delete f.model.rates.outputMicroUsdPerMillion; }],
  ['overflow cost', f => { f.model.rates.fixedMicroUsd = '9223372036854775807'; }],
  ['arbitrary endpoint', f => { f.model.endpointId = 'http://127.0.0.1'; }],
  ['wrong model', f => { f.model.model = 'other'; }],
  ['async bound', f => { f.model.inputBound = async () => ({ inputTokens: '0', embeddingInputTokens: '0' }); }],
]) test(`unsupported ${label} gives no quote and zero sends`, async t => {
  const f = await fixture(t); mutate(f); await failure(f.core.prepare(f.input()), 'UNSUPPORTED'); assert.equal(f.controls.sent.length, 0);
});

for (const body of [Buffer.from('{"model":"fixture-model","model":"other"}'), Buffer.from('{"x":1,"\\u0078":2}'),
  Buffer.from('{"__proto__":{}}'), Buffer.from('{"x":"\\ud800"}'), Buffer.from([123, 34, 120, 34, 58, 34, 255, 34, 125]),
  Buffer.from('[]'), Buffer.from('{}{}'), Buffer.from('\ufeff{}'), Buffer.alloc(LIMITS.bodyBytes + 1, 32)]) {
  test(`strict bounded JSON rejects ${sha(body).slice(0, 8)} before catalog functions/send`, async t => {
    const f = await fixture(t); let called = 0; f.model.validateBody = () => { called++; return true; };
    await failure(f.core.prepare(f.input({ body })), 'INVALID'); assert.equal(called, 0); assert.equal(f.controls.sent.length, 0);
  });
}

test('approval and request IDs bind the prepared body; approved payload cannot be replaced', async t => {
  const f = await fixture(t); await f.on(); const input = f.input(); const meta = await f.core.prepare(input);
  await failure(f.send(meta), 'APPROVAL_REQUIRED');
  await failure(f.core.approve({ ...approve(meta), approvalId: crypto.randomUUID() }), 'CHANGED');
  await failure(f.core.prepare(input), 'DUPLICATE'); assert.equal(f.controls.sent.length, 0);
});
for (const stage of ['approve', 'execute']) test(`changed quote at ${stage} invalidates the approval`, async t => {
  const f = await fixture(t); await f.on(); const meta = await f.core.prepare(f.input()); f.commit(meta);
  if (stage === 'execute') await f.core.approve(approve(meta));
  f.model.rates.outputMicroUsdPerMillion = '2000001';
  await failure(stage === 'approve' ? f.core.approve(approve(meta)) : f.send(meta), 'CHANGED');
  assert.equal(f.controls.sent.length, 0);
});
for (const kind of ['wall', 'monotonic', 'catalog']) test(`${kind} expiry cannot extend a pending approval`, async t => {
  const f = await fixture(t); await f.on(); if (kind === 'catalog') f.model.verifiedAtEpochMs -= CATALOG_TTL_MS - 10;
  const { meta } = await f.request();
  if (kind === 'monotonic') f.controls.ticks += PLAN_TTL_MS;
  else f.controls.time += kind === 'catalog' ? 10 : PLAN_TTL_MS;
  await failure(f.send(meta), 'EXPIRED'); assert.equal(f.controls.sent.length, 0);
});

test('clock regression latches OFF before send', async t => {
  const f = await fixture(t); await f.on(); const { meta } = await f.request(); f.controls.time--;
  await failure(f.send(meta), 'CLOCK_REGRESSION'); assert.equal(f.core.diagnostics().aiOff, true); assert.equal(f.controls.sent.length, 0);
});

for (const [name, mutate] of [
  ['owner', d => { d.request.ownerUserId = '9'; d.projection.requests[0].ownerUserId = '9'; }],
  ['snapshot', d => { d.request.snapshotId = '9'; d.projection.requests[0].snapshotId = '9'; }],
  ['body hash', d => { d.request.wireBodySha256 = 'f'.repeat(64); d.projection.requests[0].wireBodySha256 = 'f'.repeat(64); }],
  ['approval', d => { d.request.approvalId = crypto.randomUUID(); d.projection.requests[0].approvalId = d.request.approvalId; }],
  ['settings revision', d => { d.settings.revision = '99'; }],
  ['settings OFF', d => { d.settings.state = 'DISABLED'; }],
  ['main epoch', d => { d.request.dispatchBinding.mainEpoch = crypto.randomUUID(); d.projection.requests[0].dispatchBinding.mainEpoch = d.request.dispatchBinding.mainEpoch; }],
  ['incomplete projection', d => { d.projection.complete = false; }],
  ['empty projection', d => { d.projection.requests = []; }],
  ['external verified flag', d => { d.request.verified = true; d.projection.requests[0].verified = true; }],
]) test(`independent PG rejects ${name} without a send`, async t => {
  const f = await fixture(t); await f.on(); const { meta } = await f.request(); f.controls.mutateRead = mutate;
  await failure(f.send(meta)); assert.equal(f.controls.sent.length, 0); assert.equal(f.core.diagnostics().aiOff, true);
});

test('complete PG duplicate IDs and omitted B obligation block activation', async t => {
  const f = await fixture(t); await f.on(); const { meta } = await f.request(); await f.send(meta); await f.core.latch();
  f.pg.requests = [];
  await failure(f.core.activate({ ownerUserId: '1', policyRevision: '3', policySha256: f.pg.gate.policySha256, userApproved: true }));
  assert.equal(f.core.diagnostics().aiOff, true);
});

test('daily and monthly budgets include all outstanding holds across prior UTC buckets', async t => {
  const f = await fixture(t); await f.on(); const { meta } = await f.request(); f.pg.gate.dailyLimitMicroUsd = '58';
  await failure(f.send(meta), 'BUDGET_EXCEEDED'); assert.equal(f.controls.sent.length, 0);
});

for (const [name, value] of [
  ['missing', undefined], ['null', null], ['negative', { inputTokens: '-1', cachedInputTokens: '0', outputTokens: '7', embeddingInputTokens: '0' }],
  ['number', { inputTokens: 5, cachedInputTokens: '0', outputTokens: '7', embeddingInputTokens: '0' }],
  ['additional billed dimensions', { inputTokens: '5', cachedInputTokens: '0', outputTokens: '7', embeddingInputTokens: '0', cachedTokens: '1' }],
]) test(`unknown usage ${name} retains full hold and disallows retry`, async t => {
  const f = await fixture(t); await f.on(); f.controls.transport = async () => value === undefined
    ? { statusCode: 200, providerRequestId: null, body: Buffer.from('{"answer":"synthetic"}') } : response(value);
  const { meta } = await f.request(); await failure(f.send(meta), 'USAGE_UNKNOWN');
  const row = f.journal.snapshot().requests[0]; assert.equal(row.status, 'UNKNOWN_HELD'); assert.equal(row.reservedMicroUsd, '59');
  assert.equal(row.actualMicroUsd, null); assert.equal(f.core.diagnostics().aiOff, true); assert.equal(f.controls.sent.length, 1);
  await failure(f.send(meta), 'OFF'); assert.equal(f.controls.sent.length, 1);
});
for (const mode of ['throw', 'http', 'oversize', 'duplicateJson']) test(`${mode} response failure never releases the hold`, async t => {
  const f = await fixture(t); await f.on(); f.controls.transport = async () => {
    if (mode === 'throw') throw new Error('synthetic adapter secret');
    if (mode === 'http') return { ...response(), statusCode: 429 };
    if (mode === 'oversize') return { ...response(), body: Buffer.alloc(LIMITS.responseBytes + 1) };
    return { ...response(), body: Buffer.from('{"usage":{},"usage":{}}') };
  };
  const { meta } = await f.request(); await failure(f.send(meta)); assert.equal(f.journal.snapshot().requests[0].status, 'UNKNOWN_HELD');
  assert.equal(f.controls.sent.length, 1);
});

for (const mode of ['evidence', 'corruptEvidence', 'SETTLED']) test(`provider response then ${mode} PG failure remains conservative`, async t => {
  const f = await fixture(t); await f.on(); const { meta } = await f.request(); f.controls.fail = mode;
  await failure(f.send(meta)); const row = f.journal.snapshot().requests[0];
  assert.equal(row.status, mode === 'SETTLED' ? 'SETTLED' : 'UNKNOWN_HELD');
  assert.equal(row.actualMicroUsd, mode === 'SETTLED' ? '22' : null); assert.equal(f.core.diagnostics().aiOff, true);
  assert.equal(f.controls.sent.length, 1);
});

test('journal I/O failure after provider response gives no answer, no second send, full held obligation', async t => {
  const f = await fixture(t); await f.on(); const { meta } = await f.request();
  f.controls.transport = async () => { f.controls.journalFault = stage => stage === 'log.beforeWrite'; return response(); };
  await failure(f.send(meta)); assert.equal(f.controls.sent.length, 1); assert.equal(f.core.diagnostics().aiOff, true);
  assert.notEqual(f.journal.snapshot().requests[0].status, 'SETTLED');
});

test('settlement survives answer persistence failure and restart; pending bytes cannot be replayed', async t => {
  const f = await fixture(t); await f.on(); const { meta } = await f.request();
  await assert.rejects(f.send(meta).then(() => { throw new Error('synthetic answer database failure'); }));
  assert.equal(f.journal.snapshot().requests[0].actualMicroUsd, '22'); await f.reopen();
  assert.equal(f.journal.snapshot().requests[0].actualMicroUsd, '22'); assert.equal(f.core.diagnostics().aiOff, true);
  await f.on(); await failure(f.core.prepare(f.input({ requestId: meta.requestId })), 'DUPLICATE');
});

test('observed overspend is recorded fully and latches OFF without clamping', async t => {
  const f = await fixture(t); await f.on(); f.controls.transport = async () => response({ inputTokens: '50', cachedInputTokens: '0', outputTokens: '70', embeddingInputTokens: '0' });
  const { meta } = await f.request(); const result = await f.send(meta);
  assert.equal(result.actualMicroUsd, '193'); assert.equal(f.journal.snapshot().requests[0].actualMicroUsd, '193');
  assert.equal(f.pg.requests[0].actualMicroUsd, '193'); assert.equal(f.core.diagnostics().aiOff, true);
});

test('two simultaneous transports, third blocked; each admitted body has one journal UUID', async t => {
  const f = await fixture(t); await f.on(); const waiting = deferred(); const entered = deferred();
  f.controls.transport = async () => { if (f.controls.sent.length === 2) entered.resolve(); await waiting.promise; return response(); };
  const a = await f.request(); const b = await f.request(); const c = await f.request();
  const first = f.send(a.meta); const second = f.send(b.meta); await entered.promise;
  await failure(f.send(c.meta), 'BUSY'); assert.equal(f.controls.sent.length, 2);
  waiting.resolve(); await Promise.all([first, second]);
  assert.equal(new Set(f.journal.snapshot().requests.map(r => r.requestId)).size, 2);
  await f.send(c.meta); assert.equal(f.controls.sent.length, 3);
});

test('OFF during credential await prevents transport and releases no permit to caller', async t => {
  const f = await fixture(t); await f.on(); const waiting = deferred(); const entered = deferred();
  f.controls.credential = async () => { entered.resolve(); await waiting.promise; return 'fixture-credential'; };
  const { meta } = await f.request(); const sending = f.send(meta); await entered.promise; const off = f.core.latch(); waiting.resolve();
  await failure(sending, 'OFF'); await off.catch(() => {}); assert.equal(f.controls.sent.length, 0); assert.equal(f.core.diagnostics().aiOff, true);
});

test('OFF during provider wait still accounts for an observed response', async t => {
  const f = await fixture(t); await f.on(); const waiting = deferred(); const entered = deferred();
  f.controls.transport = async () => { entered.resolve(); await waiting.promise; return response(); };
  const { meta } = await f.request(); const sending = f.send(meta); await entered.promise; await f.core.latch(); waiting.resolve();
  assert.equal((await sending).actualMicroUsd, '22'); assert.equal(f.journal.snapshot().requests[0].status, 'SETTLED');
  assert.equal(f.core.diagnostics().aiOff, true);
});

test('close waits for active settlement, zeroes owned bytes and closes journal after drain', async t => {
  const f = await fixture(t); await f.on(); const waiting = deferred(); const entered = deferred();
  f.controls.transport = async () => { entered.resolve(); await waiting.promise; return response(); };
  const { meta } = await f.request(); const sending = f.send(meta); await entered.promise; const closing = f.core.close();
  let ended = false; closing.then(() => { ended = true; }); await new Promise(resolve => setImmediate(resolve)); assert.equal(ended, false);
  waiting.resolve(); await sending; await closing; assert.equal(f.journal.snapshot().requests[0].actualMicroUsd, '22');
  await failure(f.core.prepare(f.input()), 'CLOSED');
});

test('prepare memory count limits, owner limit, expiry collection, and one-use tombstones', async t => {
  const f = await fixture(t); const first = f.input(); await f.core.prepare(first);
  for (let at = 1; at < 32; at++) await f.core.prepare(f.input());
  await failure(f.core.prepare(f.input()), 'CAPACITY');
  for (let at = 0; at < 32; at++) await f.core.prepare(f.input({ ownerUserId: '2' }));
  await failure(f.core.prepare(f.input({ ownerUserId: '3' })), 'CAPACITY');
  f.controls.ticks += PLAN_TTL_MS; await f.core.prepare(f.input({ ownerUserId: '3' }));
  await failure(f.core.prepare(first), 'DUPLICATE');
});

test('restore union retains B-only, PG-only and identical UUID obligations; stays OFF until explicit consent', async t => {
  const f = await fixture(t); await f.on(); const a = await f.request(); await f.send(a.meta); await f.core.latch();
  const b = await f.core.prepare(f.input()); f.commit(b); f.pg.requests = f.pg.requests.filter(r => r.requestId !== a.meta.requestId); f.pg.evidence = [];
  await f.core.reconcile({ restoreId: crypto.randomUUID() });
  const rows = f.journal.snapshot().requests; assert.equal(rows.length, 2);
  assert.equal(rows.find(r => r.requestId === a.meta.requestId).actualMicroUsd, '22');
  assert.equal(rows.find(r => r.requestId === b.requestId).status, 'UNKNOWN_HELD');
  assert.equal(f.core.diagnostics().aiOff, true);
  await failure(f.core.activate({ ownerUserId: '1', policyRevision: '3', policySha256: f.pg.gate.policySha256, userApproved: false }), 'APPROVAL_REQUIRED');
});

test('incomplete or legacy-ambiguous projection never becomes an empty reconciliation', async t => {
  const f = await fixture(t); f.pg.complete = false; const before = f.journal.snapshot().requests;
  await failure(f.core.reconcile({ restoreId: crypto.randomUUID() }), 'PROJECTION_FAILED'); assert.deepEqual(f.journal.snapshot().requests, before);
  f.pg.complete = true; f.pg.gate.legacyLiabilityUnresolved = true;
  await failure(f.core.reconcile({ restoreId: crypto.randomUUID() }), 'RECOVERY_REQUIRED'); assert.equal(f.core.diagnostics().aiOff, true);
});

test('publication readback cannot claim completeness while dropping a committed row', async t => {
  const f = await fixture(t); await f.on(); const { meta } = await f.request();
  f.controls.readback = value => { value.requests = []; };
  await failure(f.send(meta), 'PROJECTION_FAILED'); assert.equal(f.controls.sent.length, 0);
  assert.equal(f.journal.snapshot().requests[0].status, 'UNKNOWN_HELD');
});

test('day/month rollover never removes prior unknown liability from either budget', async t => {
  const f = await fixture(t); await f.on(); const unknown = await f.request();
  f.controls.transport = async () => { throw new Error('synthetic timeout'); };
  await failure(f.send(unknown.meta));
  f.controls.time = Date.parse('2026-11-01T12:00:00Z'); f.controls.ticks += 29 * 86400000;
  f.model.verifiedAtEpochMs = f.controls.time; f.controls.transport = null;
  await f.on(); f.pg.gate.dailyLimitMicroUsd = '100'; f.pg.gate.monthlyLimitMicroUsd = '100';
  const next = await f.request(); await failure(f.send(next.meta), 'BUDGET_EXCEEDED');
  assert.equal(f.controls.sent.length, 1); assert.equal(f.journal.snapshot().requests[0].reservedMicroUsd, '59');
});

test('monthly settled spend blocks even when daily spend is below limit', async t => {
  const f = await fixture(t); await f.on(); const prior = await f.request(); await f.send(prior.meta);
  f.controls.time += 86400000; f.controls.ticks += 86400000; await f.core.latch(); await f.on();
  f.pg.gate.dailyLimitMicroUsd = '100'; f.pg.gate.monthlyLimitMicroUsd = '80';
  const next = await f.request(); await failure(f.send(next.meta), 'BUDGET_EXCEEDED'); assert.equal(f.controls.sent.length, 1);
});

test('duplicate projection UUIDs fail independently of missing or incorrect hashes', async t => {
  const f = await fixture(t); await f.on(); const { meta } = await f.request();
  f.controls.mutateRead = value => { value.projection.requests.push(copy(value.projection.requests[0])); };
  await failure(f.send(meta), 'PROJECTION_FAILED'); assert.equal(f.controls.sent.length, 0);
});

test('counterfeit pg proof flag and known zero actual cannot replace main observed usage', async t => {
  const f = await fixture(t); await f.on(); const { meta } = await f.request();
  f.pg.evidence.push({ requestId: meta.requestId, proofSha256: sha('counterfeit'), mainEpoch: f.mainEpoch, receiptType: 'USAGE',
    providerRequestId: null, usageDimensions: { units: { INPUT_TOKENS: '0', OUTPUT_TOKENS: '0' } }, actualMicroUsd: '0' });
  const result = await f.send(meta); assert.equal(result.actualMicroUsd, '22');
  assert.notEqual(result.proofSha256, sha('counterfeit')); assert.equal(f.pg.evidence.length, 2);
});

test('PG journal head regression blocks before transport', async t => {
  const f = await fixture(t); await f.on(); const { meta } = await f.request(); f.pg.gate.journalSequence = '0';
  await failure(f.send(meta), 'PROJECTION_FAILED'); assert.equal(f.controls.sent.length, 0);
});

test('journal append/fsync dispatch failure cannot invoke transport', async t => {
  const f = await fixture(t); await f.on(); const { meta } = await f.request();
  let writes = 0; f.controls.journalFault = stage => stage === 'log.beforeFsync' && ++writes === 2;
  await failure(f.send(meta)); assert.equal(f.controls.sent.length, 0); assert.equal(f.core.diagnostics().aiOff, true);
});

test('DISPATCHED PG projection failure after durable intent still sends zero', async t => {
  const f = await fixture(t); await f.on(); const { meta } = await f.request(); f.controls.fail = 'DISPATCHED';
  await failure(f.send(meta)); assert.equal(f.controls.sent.length, 0);
  assert.equal(f.journal.snapshot().requests[0].dispatchIntent, true);
  assert.equal(f.journal.snapshot().requests[0].status, 'UNKNOWN_HELD');
});

test('usage evidence independently rereads original dispatch binding before journal settlement', async t => {
  const f = await fixture(t); await f.on(); const { meta } = await f.request();
  f.controls.transport = async () => { f.pg.requests[0].wireBodySha256 = 'f'.repeat(64); return response(); };
  await failure(f.send(meta), 'SETTLEMENT_FAILED'); assert.equal(f.journal.snapshot().requests[0].status, 'UNKNOWN_HELD');
});

test('restore UUID collision preserves larger liability and blocks reactivation', async t => {
  const f = await fixture(t); await f.on(); const { meta } = await f.request(); await f.send(meta); await f.core.latch();
  f.pg.requests[0].payloadSha256 = 'f'.repeat(64); f.pg.requests[0].reservedMicroUsd = '200';
  f.pg.requests[0].status = 'UNKNOWN_HELD'; f.pg.requests[0].actualMicroUsd = null; f.pg.requests[0].proofSha256 = null;
  f.pg.requests[0].liabilityFloorMicroUsd = '250'; f.pg.evidence = [];
  await f.core.reconcile({ restoreId: crypto.randomUUID() });
  const row = f.journal.snapshot().requests[0]; assert.equal(row.conflict, true); assert.equal(row.liabilityFloorMicroUsd, '250');
  await failure(f.core.activate({ ownerUserId: '1', policyRevision: '3', policySha256: f.pg.gate.policySha256, userApproved: true }));
  assert.equal(f.core.diagnostics().aiOff, true);
});

test('complete PG-only settled liability is conservatively imported as held, not trusted as a main settlement', async t => {
  const f = await fixture(t); const meta = await f.core.prepare(f.input()); const row = f.commit(meta);
  Object.assign(row, { status: 'SETTLED', actualMicroUsd: '22', proofSha256: sha('old pg proof') });
  await f.core.reconcile({ restoreId: crypto.randomUUID() });
  const restored = f.journal.snapshot().requests[0]; assert.equal(restored.status, 'UNKNOWN_HELD');
  assert.equal(restored.actualMicroUsd, null); assert.equal(restored.reservedMicroUsd, '59'); assert.equal(restored.dispatchIntent, true);
});

test('restart imports a committed reservation which crashed before its first B append, never sends it', async t => {
  const f = await fixture(t); const meta = await f.core.prepare(f.input()); f.commit(meta); await f.reopen();
  await f.core.reconcile({ restoreId: crypto.randomUUID() });
  assert.equal(f.journal.snapshot().requests[0].status, 'UNKNOWN_HELD'); assert.equal(f.journal.snapshot().requests[0].dispatchIntent, false);
  assert.equal(f.controls.sent.length, 0);
});

test('body cap accepts exact bounded UTF8 with nested containers and surrogate pairs intact', async t => {
  const f = await fixture(t); f.model.validateBody = body => body.model === 'fixture-model' && body.nested[0].value === '😀';
  const small = Buffer.from('{"model":"fixture-model","nested":[{"value":"😀"}],"padding":""}');
  const body = Buffer.concat([small.subarray(0, -2), Buffer.alloc(LIMITS.bodyBytes - small.length, 120), small.subarray(-2)]);
  assert.equal(body.length, LIMITS.bodyBytes); const meta = await f.core.prepare(f.input({ body })); assert.equal(meta.wireBodySha256, sha(body));
});

test('catalog boundary has no usable quote at the 30-day deadline and a bounded quote immediately before it', async t => {
  const f = await fixture(t); f.model.verifiedAtEpochMs = f.controls.time - CATALOG_TTL_MS + 1;
  const meta = await f.core.prepare(f.input()); assert.equal(meta.dispatchBinding.validUntilEpochMs, String(f.controls.time + 1));
  f.controls.time++; await failure(f.core.prepare(f.input()), 'EXPIRED'); assert.equal(f.controls.sent.length, 0);
});

test('callbacks and the public facade never contain a permit or OS encryption key', async t => {
  const f = await fixture(t); await f.on(); const { meta } = await f.request(); await f.send(meta);
  const observation = f.authority.readDispatch(meta.requestId);
  assert.deepEqual(Object.keys(observation).sort(), ['budgetDay', 'installationId', 'mainEpoch', 'payloadSha256', 'position', 'priceVersion', 'requestId', 'reservedMicroUsd']);
  assert.doesNotMatch(JSON.stringify(observation), /permitId|fixture-credential|private prompt/);
  assert.equal(f.authority.readEvidence(crypto.randomUUID(), sha('none')), null);
  assert.equal(f.authority.readSettlement(crypto.randomUUID(), sha('none')), null);
});

test('observed cached input is discounted only in actual settlement, with dimensions retained', async t => {
  const f = await fixture(t); await f.on();
  f.controls.transport = async () => response({ inputTokens: '5', cachedInputTokens: '4', outputTokens: '7', embeddingInputTokens: '0' });
  const { meta } = await f.request(); assert.equal(meta.reservedMicroUsd, '59');
  const result = await f.send(meta); assert.equal(result.actualMicroUsd, '20');
  assert.equal(f.pg.evidence[0].usageDimensions.units.CACHED_INPUT_TOKENS, '4');
});
for (const cached of [undefined, '6', '-1', 0, '01']) test(`missing/invalid cached input ${String(cached)} preserves full hold`, async t => {
  const f = await fixture(t); await f.on(); f.controls.transport = async () => response({ inputTokens: '5', cachedInputTokens: cached, outputTokens: '7', embeddingInputTokens: '0' });
  const { meta } = await f.request(); await failure(f.send(meta), 'USAGE_UNKNOWN'); assert.equal(f.journal.snapshot().requests[0].status, 'UNKNOWN_HELD');
  assert.equal(f.journal.snapshot().requests[0].reservedMicroUsd, '59');
});
test('missing cached rate or cached premium is unsupported instead of an understated reservation', async t => {
  const f = await fixture(t); delete f.model.rates.cachedInputMicroUsdPerMillion;
  await failure(f.core.prepare(f.input()), 'UNSUPPORTED'); f.model.rates.cachedInputMicroUsdPerMillion = '1000001';
  await failure(f.core.prepare(f.input()), 'UNSUPPORTED'); assert.equal(f.controls.sent.length, 0);
});

test('main lifecycle offline latch never reads or writes PG and preserves durable OFF', async t => {
  const f = await fixture(t); await f.on(); const { meta } = await f.request();
  const before = f.controls.trace.filter(event => event.startsWith('pg.')).length;
  f.controls.fail = 'projection';
  await f.core.latchOffline('RESTART_RECONCILIATION');
  assert.equal(f.controls.trace.filter(event => event.startsWith('pg.')).length, before);
  assert.equal(f.journal.snapshot().aiOff, true); assert.deepEqual(f.core.diagnostics(), { aiOff: true, recoveryOnly: true });
  await failure(f.send(meta), 'OFF'); await failure(f.core.latchOffline('anything from renderer'), 'INVALID');
  assert.equal(f.controls.sent.length, 0);
});

test('offline latch works before a gate exists and has no projection success claim', async t => {
  const noDatabase = async () => { throw new Error('synthetic database not initialized'); };
  const f = await fixture(t, { readProjection: noDatabase, readback: noDatabase, applySettlement: noDatabase, readCommittedRequest: noDatabase });
  await f.core.latchOffline(); assert.equal(f.journal.snapshot().aiOff, true); assert.equal(f.core.diagnostics().recoveryOnly, true);
});

test('expiry timer evicts an approved body without another preparation or admission', async t => {
  const f = await fixture(t); await f.on(); const { meta } = await f.request({ expiresAt: f.controls.time + 5 });
  f.controls.time += 5; f.controls.ticks += 5;
  await new Promise(resolve => setTimeout(resolve, 20));
  await failure(f.send(meta), 'DUPLICATE'); assert.equal(f.controls.sent.length, 0);
});

for (const stage of ['verification', 'readback']) test(`OFF during delayed activation ${stage} cannot complete an older activation`, async t => {
  const entered = deferred(); const resume = deferred(); let block = false; let f;
  const read = async () => { if (block) { block = false; entered.resolve(); await resume.promise; } return copy(f.pg); };
  f = await fixture(t, stage === 'verification' ? { readProjection: read } : { readback: read });
  await f.core.reconcile({ restoreId: crypto.randomUUID() }); block = true;
  const activating = f.core.activate({ ownerUserId: '1', policyRevision: '3', policySha256: f.pg.gate.policySha256, userApproved: true });
  const rejected = failure(activating, 'OFF');
  await entered.promise; const off = f.core.latchOffline('USER_OFF'); resume.resolve();
  await rejected; await off;
  assert.deepEqual(f.core.diagnostics(), { aiOff: true, recoveryOnly: true });
  assert.equal(f.journal.snapshot().aiOff, true); assert.equal(f.controls.sent.length, 0);
  assert.equal(f.journal.snapshot().recoveryOnly, false);
  await f.on(); assert.equal(f.core.diagnostics().aiOff, false);
});

test('OFF invalidates activation already queued behind another publication', async t => {
  const entered = deferred(); const resume = deferred(); let block = false; let f;
  f = await fixture(t, { readback: async () => { if (block) { block = false; entered.resolve(); await resume.promise; } return copy(f.pg); } });
  await f.on(); block = true; const firstOff = f.core.latch(); await entered.promise;
  const activating = f.core.activate({ ownerUserId: '1', policyRevision: '3', policySha256: f.pg.gate.policySha256, userApproved: true });
  const rejected = failure(activating, 'OFF'); const secondOff = f.core.latchOffline();
  resume.resolve(); await firstOff; await rejected; await secondOff;
  assert.equal(f.core.diagnostics().aiOff, true); assert.equal(f.journal.snapshot().aiOff, true);
  assert.equal(f.controls.sent.length, 0);
});

function maintenanceProjectionDigest(pg) {
  const { journalSequence, journalHash, journalProjectionSha256, clockHighWaterMs, ...gate } = pg.gate;
  return sha(canonical({ gate, requests: pg.requests.map(journalRowForTest) }));
}
function journalRowForTest(row) {
  return Object.fromEntries(['requestId', 'payloadSha256', 'budgetDay', 'priceVersion', 'reservedMicroUsd', 'status',
    'actualMicroUsd', 'proofSha256', 'liabilityFloorMicroUsd', 'conflict'].map(key => [key, row[key]]));
}
async function maintenanceFixture(t, patch = {}) {
  let f;
  const verify = async (snapshot, metadata) => {
    const pg = await f.options.readback();
    return { ...metadata, verified: pg.gate.journalSequence === String(snapshot.sequence) && pg.gate.journalHash === snapshot.headHash
      && metadata.pgProjectionDigest === maintenanceProjectionDigest(pg)
      && metadata.legacyLiabilityUnresolved === pg.gate.legacyLiabilityUnresolved };
  };
  f = await fixture(t, { verifyMaintenanceSeal: verify, verifyMaintenanceCompletion: verify, ...patch });
  f.maintenanceInput = (operation, extra = {}) => ({ ...operation, payloadSha256: sha('synthetic maintenance payload'),
    pgProjectionDigest: maintenanceProjectionDigest(f.pg), legacyLiabilityUnresolved: f.pg.gate.legacyLiabilityUnresolved,
    budgetDay: f.journal.snapshot().budgetDay, minimumVersion: f.journal.snapshot().minimumVersion, ...extra });
  f.mergeInput = () => ({ restoreId: crypto.randomUUID(), obligations: f.pg.requests.map(row => ({
    ...Object.fromEntries(['requestId', 'payloadSha256', 'budgetDay', 'priceVersion', 'reservedMicroUsd', 'status', 'actualMicroUsd', 'proofSha256']
      .map(key => [key, row[key]])), reservedMicroUsd: (BigInt(row.liabilityFloorMicroUsd) > BigInt(row.reservedMicroUsd)
      ? row.liabilityFloorMicroUsd : row.reservedMicroUsd) })), budgetDay: '2026-10-03', minimumVersion: '0' });
  return f;
}
test('maintenance barrier is synchronous and drains an EXECUTE awaiting credential without sending it', async t => {
  const f = await fixture(t); await f.on(); const { meta } = await f.request();
  const credential = deferred(); const entered = deferred();
  f.controls.credential = async () => { entered.resolve(); return credential.promise; };
  const sending = f.send(meta); const failedSend = failure(sending, 'OFF'); await entered.promise;
  const operation = { transactionId: crypto.randomUUID(), kind: 'BACKUP' };
  const beginning = f.core.beginMaintenance(operation);
  await failure(f.core.prepare(f.input()), 'OFF');
  await failure(f.core.activate({ ownerUserId: '1', policyRevision: '3', policySha256: f.pg.gate.policySha256, userApproved: true }), 'OFF');
  credential.resolve('fixture-credential'); const handle = await beginning;
  await handle.waitForDrain({ timeoutMs: 2000 }); await failedSend;
  assert.equal(f.controls.sent.length, 0); assert.equal(f.journal.snapshot().aiOff, true);
});
test('maintenance drain waits for actual transport plus delayed settlement and never resends after timeout', async t => {
  const f = await fixture(t); await f.on(); const { meta } = await f.request();
  const transport = deferred(); const entered = deferred(); const settlement = deferred(); const settlementEntered = deferred();
  f.controls.transport = () => { entered.resolve(); return transport.promise; };
  const publish = f.options.applySettlement;
  f.options.applySettlement = async value => {
    if (value.phase === 'SETTLED') { settlementEntered.resolve(); await settlement.promise; }
    return publish(value);
  };
  const sending = f.send(meta); await entered.promise;
  try {
    const handle = await f.core.beginMaintenance({ transactionId: crypto.randomUUID(), kind: 'RESTORE' });
    await failure(handle.waitForDrain({ timeoutMs: 10 }), 'DRAIN_TIMEOUT');
    await failure(handle.readProjection(), 'BUSY');
    transport.resolve(response()); await settlementEntered.promise;
    let drained = false; const wait = handle.waitForDrain({ timeoutMs: 2000 }).then(() => { drained = true; });
    await new Promise(resolve => setImmediate(resolve)); assert.equal(drained, false);
    settlement.resolve(); const answer = await sending; answer.body.fill(0); await wait;
    assert.equal(f.controls.sent.length, 1); assert.equal(f.pg.requests[0].status, 'SETTLED');
  } finally { transport.resolve(response()); settlement.resolve(); await sending.catch(() => {}); }
});
test('product completion requires a PG refresh after the receipt before the maintenance handle can release', async t => {
  const f = await maintenanceFixture(t); const operation = { transactionId: crypto.randomUUID(), kind: 'RESTORE' };
  const handle = await f.core.beginMaintenance(operation); await handle.waitForDrain({ timeoutMs: 2000 });
  await failure(handle.release(), 'RECOVERY_REQUIRED');
  await handle.mergeAndCommit({ mergeInput: f.mergeInput() });
  const seal = f.maintenanceInput(operation); await f.journal.sealMaintenance(seal);
  assert.equal(f.authority.readJournal().restorePending, true);
  await failure(handle.release(), 'RECOVERY_REQUIRED');
  await assert.rejects(f.journal.completeMaintenance(seal), { code: 'MAINTENANCE_REJECTED' });
  await handle.refreshProjection(); await f.journal.completeMaintenance(f.maintenanceInput(operation));
  await failure(handle.release(), 'PROJECTION_FAILED');
  await handle.refreshProjection(); const released = await handle.release();
  assert.equal(released.aiOff, true); assert.equal(f.controls.sent.length, 0);
  await failure(handle.readProjection(), 'BUSY');
});
test('main maintenance cannot treat a missing PG gate as a verified empty projection', async t => {
  const f = await fixture(t); const handle = await f.core.beginMaintenance({ transactionId: crypto.randomUUID(), kind: 'BACKUP' });
  await handle.waitForDrain({ timeoutMs: 2000 }); f.pg.gate = null;
  await failure(handle.readProjection(), 'PROJECTION_FAILED'); assert.equal(f.controls.sent.length, 0);
});
test('maintenance requires one scoped handle and never accepts concurrent owners or an undrained merge', async t => {
  const f = await maintenanceFixture(t); const operation = { transactionId: crypto.randomUUID(), kind: 'RESTORE' };
  const handle = await f.core.beginMaintenance(operation);
  await failure(f.core.beginMaintenance(operation), 'BUSY');
  await failure(handle.mergeAndCommit({ mergeInput: f.mergeInput() }), 'BUSY');
  await handle.waitForDrain({ timeoutMs: 2000 });
  await failure(handle.mergeAndCommit({ mergeInput: { ...f.mergeInput(), sourcePath: '/private/synthetic adapter secret' } }), 'INVALID');
  assert.equal(f.journal.snapshot().pendingRestore, null);
});
test('legacy B hold rejects a restored PG gate that omits the unresolved liability flag', async t => {
  const f = await maintenanceFixture(t); f.pg.gate.legacyLiabilityUnresolved = true;
  const operation = { transactionId: crypto.randomUUID(), kind: 'RESTORE' };
  const handle = await f.core.beginMaintenance(operation); await handle.waitForDrain({ timeoutMs: 2000 });
  await handle.mergeAndCommit({ mergeInput: f.mergeInput() }); await f.journal.sealMaintenance(f.maintenanceInput(operation));
  assert.equal(f.journal.snapshot().legacyLiabilityUnresolved, true);
  f.controls.readback = pg => { pg.gate.legacyLiabilityUnresolved = false; };
  await failure(handle.refreshProjection(), 'PROJECTION_FAILED');
  await failure(f.core.activate({ ownerUserId: '1', policyRevision: '3', policySha256: f.pg.gate.policySha256, userApproved: true }), 'OFF');
});
test('pending maintenance restart requires recovery mode, same transaction, completion and still no activation', async t => {
  const f = await maintenanceFixture(t); const operation = { transactionId: crypto.randomUUID(), kind: 'RESTORE' };
  const handle = await f.core.beginMaintenance(operation); await handle.waitForDrain({ timeoutMs: 2000 });
  await handle.mergeAndCommit({ mergeInput: f.mergeInput() }); await f.journal.sealMaintenance(f.maintenanceInput(operation));
  await failure(f.reopen(), 'RECOVERY_REQUIRED');
  f.options.recoveryMode = true; await f.reopen();
  await failure(f.core.beginMaintenance({ ...operation, transactionId: crypto.randomUUID() }), 'CHANGED');
  const resumed = await f.core.beginMaintenance(operation); await resumed.waitForDrain({ timeoutMs: 2000 });
  await resumed.refreshProjection(); await f.journal.completeMaintenance(f.maintenanceInput(operation));
  await resumed.refreshProjection(); await resumed.release();
  await failure(f.core.prepare(f.input()), 'OFF');
  await failure(f.core.activate({ ownerUserId: '1', policyRevision: '3', policySha256: f.pg.gate.policySha256, userApproved: true }), 'OFF');
  assert.equal(f.core.diagnostics().recoveryOnly, true);
});

test('maintenance authority exposes an immutable current snapshot only to the bound main adapter', async t => {
  const f = await maintenanceFixture(t); const operation = { transactionId: crypto.randomUUID(), kind: 'BACKUP' };
  const handle = await f.core.beginMaintenance(operation); await handle.waitForDrain({ timeoutMs: 2000 });
  await handle.mergeAndCommit({ mergeInput: f.mergeInput() }); await f.journal.sealMaintenance(f.maintenanceInput(operation));
  const privateState = f.authority.readMaintenanceSnapshot();
  assert.equal(privateState.pendingMaintenance.transactionId, operation.transactionId);
  assert.equal(Object.isFrozen(privateState), true); assert.equal(Object.isFrozen(privateState.pendingMaintenance), true);
  assert.throws(() => { privateState.pendingMaintenance.transactionId = crypto.randomUUID(); }, TypeError);
  const bridgeView = f.authority.readJournal();
  assert.deepEqual(Object.keys(bridgeView).sort(), ['budgetDay', 'installationId', 'obligations', 'position', 'restorePending']);
  assert.equal(bridgeView.pendingMaintenance, undefined); assert.equal(bridgeView.legacyLiabilityUnresolved, undefined);
});

test('maintenance union preserves PG immutable settlement fields while adding a conservative conflict floor', async t => {
  const f = await maintenanceFixture(t); await f.on(); const { meta } = await f.request();
  const answer = await f.send(meta); answer.body.fill(0); const original = copy(f.pg.requests[0]);
  const publish = f.options.applySettlement;
  f.options.applySettlement = async value => {
    for (const row of f.pg.requests.filter(row => row.status === 'SETTLED')) {
      const incoming = value.journal.requests.find(item => item.requestId === row.requestId);
      if (incoming) for (const field of ['status', 'actualMicroUsd', 'proofSha256']) assert.equal(incoming[field], row[field], 'PG immutable settlement contract');
    }
    return publish(value);
  };
  const handle = await f.core.beginMaintenance({ transactionId: crypto.randomUUID(), kind: 'RESTORE' });
  await handle.waitForDrain({ timeoutMs: 2000 }); const mergeInput = f.mergeInput();
  mergeInput.obligations[0].actualMicroUsd = '300'; mergeInput.obligations[0].proofSha256 = sha('other archive proof');
  await handle.mergeAndCommit({ mergeInput });
  assert.equal(f.pg.requests[0].status, 'SETTLED'); assert.equal(f.pg.requests[0].actualMicroUsd, original.actualMicroUsd);
  assert.equal(f.pg.requests[0].proofSha256, original.proofSha256); assert.equal(f.pg.requests[0].conflict, true);
  assert.equal(f.pg.requests[0].liabilityFloorMicroUsd, '300'); assert.equal(f.journal.snapshot().totalLiabilityMicroUsd, '300');
});
test('partial maintenance import reopens only in recovery mode and resumes the exact persisted merge input', async t => {
  const f = await maintenanceFixture(t); await f.on(); await f.request();
  const operation = { transactionId: crypto.randomUUID(), kind: 'RESTORE' };
  const handle = await f.core.beginMaintenance(operation); await handle.waitForDrain({ timeoutMs: 2000 });
  const mergeInput = f.mergeInput(); let writes = 0;
  f.controls.journalFault = stage => stage === 'log.beforeWrite' && ++writes === 3;
  await failure(handle.mergeAndCommit({ mergeInput }), 'PROJECTION_FAILED');
  assert.equal(f.journal.snapshot().pendingRestore.restoreId, mergeInput.restoreId);
  f.controls.journalFault = null;
  await failure(f.core.close());
  // A failed final latch must still release the journal's owned descriptor/lock.
  await assert.rejects(fs.lstat(path.join(f.root, 'safety', 'ai-journal', 'writer.lock')), { code: 'ENOENT' });
  f.options.recoveryMode = true;
  const reopened = await createAiEgress(f.options); f.core = reopened;
  try {
    const resumed = await reopened.beginMaintenance(operation); await resumed.waitForDrain({ timeoutMs: 2000 });
    await failure(resumed.mergeAndCommit({ mergeInput: { ...mergeInput, obligations: [] } }), 'PROJECTION_FAILED');
    assert.notEqual(f.journal.snapshot().pendingRestore, null);
    await resumed.mergeAndCommit({ mergeInput }); assert.equal(f.journal.snapshot().pendingRestore, null);
    assert.equal(f.journal.snapshot().requests.length, 1); assert.equal(f.journal.snapshot().aiOff, true);
  } finally { await reopened.close(); }
});
