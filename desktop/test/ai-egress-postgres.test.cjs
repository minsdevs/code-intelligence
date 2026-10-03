'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { EventEmitter } = require('node:events');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { PassThrough, Writable } = require('node:stream');
const { spawnSync } = require('node:child_process');
const test = require('node:test');
const { createAiEgressPostgres, AiEgressPostgresError, LIMITS } = require('../src/ai-egress-postgres.cjs');
const HASH = 'a'.repeat(64), OTHER = 'b'.repeat(64), ZERO = '0'.repeat(64);
const NOW = Date.parse('2026-10-03T12:00:00Z');
const DAY = '2026-10-03';
const copy = value => JSON.parse(JSON.stringify(value));
const failure = (promise, code) => assert.rejects(promise, error => {
  assert.ok(error instanceof AiEgressPostgresError);
  if (code) assert.equal(error.code, `AI_COST_PG_${code}`);
  assert.doesNotMatch(String(error), /synthetic-password|private-key|private-source|select |cost_publish|injected/i);
  assert.equal(error.cause, undefined); assert.equal(error.stdout, undefined); assert.equal(error.stderr, undefined);
  return true;
});
function state() {
  const installationId = crypto.randomUUID(), mainEpoch = crypto.randomUUID(), requestId = crypto.randomUUID();
  const binding = { mainEpoch, provider: 'openai', model: 'fixture-model', operation: 'CHAT', endpointId: 'openai.chat',
    adapterVersion: 'fixture-adapter', tokenizerId: 'fixture-tokenizer', tokenizerVersion: '1', costContractSha256: HASH,
    priceSha256: HASH, settingsRevision: '2', policyRevision: '1', policySha256: HASH,
    inputTokenUpperBound: '10', outputTokenMax: '20', embeddingInputTokenUpperBound: '0', wireBodyBytes: '123', validUntilEpochMs: String(NOW + 600000) };
  const row = { requestId, installationId, ownerUserId: '1', projectId: '2', snapshotId: '3', approvalId: crypto.randomUUID(),
    planSha256: HASH, payloadSha256: HASH, wireBodySha256: HASH, dispatchBinding: binding, budgetDay: DAY,
    priceVersion: 'fixture-price', reservedMicroUsd: '100', status: 'RESERVED', actualMicroUsd: null, proofSha256: null,
    liabilityFloorMicroUsd: '100', conflict: false, journalSequence: null, journalHash: null };
  const pg = { version: 1, complete: true, gate: { installationId, ownerUserId: '1', policyRevision: '1', policySha256: HASH,
    dailyLimitMicroUsd: '1000', monthlyLimitMicroUsd: '2000', reconciliationRequired: true, legacyLiabilityUnresolved: false,
    journalSequence: '0', journalHash: ZERO, journalProjectionSha256: ZERO, clockHighWaterMs: '0' }, requests: [row], evidence: [] };
  const observed = { installationId, requestId, payloadSha256: HASH, priceVersion: 'fixture-price', proofSha256: HASH,
    mainEpoch, receiptType: 'USAGE', providerRequestId: 'fixture-response', usageDimensions: { units: {
      INPUT_TOKENS: '5', OUTPUT_TOKENS: '2', EMBEDDING_INPUT_TOKENS: '0', CACHED_INPUT_TOKENS: '0', REQUESTS: '1' } }, actualMicroUsd: '10' };
  const controls = { sequence: 1, rows: [], observed, pending: false };
  const obligation = (overrides = {}) => ({ requestId, payloadSha256: HASH, budgetDay: DAY, priceVersion: 'fixture-price',
    reservedMicroUsd: '100', status: 'DISPATCHED', actualMicroUsd: null, proofSha256: null,
    liabilityFloorMicroUsd: '100', conflict: false, ...overrides });
  const position = () => ({ sequence: String(controls.sequence), hash: controls.sequence.toString(16).padStart(64, '0'),
    projectionSha256: (controls.sequence + 1).toString(16).padStart(64, '0'), clockHighWaterMs: String(NOW) });
  const authority = {
    readDispatch: id => id === requestId ? { installationId, requestId, mainEpoch, payloadSha256: HASH, budgetDay: DAY,
      priceVersion: 'fixture-price', reservedMicroUsd: '100', position: position() } : null,
    readEvidence: (id, proof) => id === requestId && proof === controls.observed?.proofSha256 ? copy(controls.observed) : null,
    readSettlement: (id, proof) => id === requestId && proof === HASH ? { installationId, requestId, payloadSha256: HASH,
      proofSha256: HASH, actualMicroUsd: controls.observed.actualMicroUsd, position: position() } : null,
    readJournal: () => ({ installationId, position: position(), budgetDay: DAY, restorePending: controls.pending,
      obligations: copy(controls.rows) }),
  };
  function publication(phase, overrides = {}) {
    return { phase, requestId: ['DISPATCHED', 'SETTLED'].includes(phase) ? requestId : null, journal: {
      major: 1, installationId, sequence: controls.sequence, headHash: position().hash, clockHighWaterMs: NOW,
      projectionDigest: position().projectionSha256, budgetDay: DAY, pendingRestore: controls.pending ? { restoreId: crypto.randomUUID() } : null,
      requests: controls.rows.map(row => ({ ...copy(row), dispatchIntent: row.status !== 'RESERVED' })), ...overrides } };
  }
  return { installationId, mainEpoch, requestId, pg, row, binding, observed, controls, authority, obligation, position, publication };
}

async function fixture(t, optionPatch = {}) {
  const s = state(); const calls = []; const control = { value: s.pg, exit: 0, stderr: '', hang: false, emit: null };
  const binary = await fs.realpath(process.execPath);
  const spawn = (command, args, options) => {
    const child = new EventEmitter(); child.stdout = new PassThrough(); child.stderr = new PassThrough();
    const call = { command, args: [...args], options, sql: null, signals: [], child }; calls.push(call);
    let done = false;
    const close = code => { if (done) return; done = true; child.emit('close', code); };
    child.kill = signal => { call.signals.push(signal); if (!control.ignoreKill) queueMicrotask(() => close(null)); return true; };
    child.stdin = new Writable({ write(bytes, encoding, callback) { call.sql = (call.sql || '') + bytes.toString('utf8'); callback(); } });
    child.stdin.on('finish', () => queueMicrotask(() => {
      if (control.hang) return;
      if (control.emit) { control.emit(child, close); return; }
      if (control.stderr) child.stderr.write(control.stderr);
      const result = typeof control.value === 'function' ? control.value(call) : control.value;
      if (result !== undefined) child.stdout.write(typeof result === 'string' ? result : JSON.stringify(result));
      close(control.exit);
    }));
    return child;
  };
  const options = { psqlPath: binary, installationId: s.installationId,
    connection: { host: '127.0.0.1', port: 6543, user: 'codeintel', database: 'codeintel' },
    env: { PGPASSWORD: 'synthetic-password' }, spawn, now: () => NOW, ...optionPatch };
  const adapter = await createAiEgressPostgres(options);
  t.after(() => adapter.close().catch(() => {}));
  return { ...s, adapter, options, control, calls };
}
function decoded(sql) {
  const value = sql.match(/decode\('([A-Za-z0-9+/=]+)','base64'\)/)?.[1];
  assert.ok(value); return JSON.parse(Buffer.from(value, 'base64').toString('utf8'));
}

function assertInstallationOwnerPredicate(sql, installationId) {
  const predicate = sql.match(/u\.identity_type\s+in\s*\(([^)]+)\)/i);
  assert.ok(predicate, 'owner SQL must explicitly admit local and linked-local identities');
  assert.deepEqual([...predicate[1].matchAll(/'([^']+)'/g)].map(match => match[1]), ['LOCAL', 'LOCAL_LINKED']);
  assert.match(sql, /u\.local_key\s*=\s*\(select value->>'installationId' from params\)/);
  assert.equal(decoded(sql).installationId, installationId);
}

test('fixed psql command uses stdin, isolated environment and a repeatable read snapshot', async t => {
  const f = await fixture(t);
  const result = await f.adapter.readProjection();
  assert.deepEqual(result, f.pg); assert.ok(Object.isFrozen(result.requests));
  const call = f.calls[0];
  assert.ok(call.args.includes('-X')); assert.ok(call.args.includes('--set=ON_ERROR_STOP=1'));
  assert.ok(call.args.includes('--no-password')); assert.ok(call.args.includes('--file=-'));
  assert.equal(call.options.shell, false); assert.equal(call.options.env.PGPASSWORD, 'synthetic-password');
  assert.equal(call.options.env.PGSERVICE, undefined); assert.equal(call.options.env.NODE_OPTIONS, undefined);
  assert.equal(call.options.env.HOME, undefined); assert.equal(call.options.env.PATH, undefined);
  assert.doesNotMatch(call.args.join(' '), /select|synthetic-password|private-key/);
  assert.match(call.sql, /^begin isolation level repeatable read read only;/);
  assert.match(call.sql, /statement_timeout/); assert.match(call.sql, /lock_timeout/);
  assert.match(call.sql, /limit 10001/); assert.deepEqual(decoded(call.sql), { installationId: f.installationId });
});

test('readback uses the same complete projection validation', async t => {
  const f = await fixture(t); assert.deepEqual(await f.adapter.readback(), f.pg);
  f.control.value = { ...f.pg, complete: false };
  await failure(f.adapter.readback(), 'INVALID_PROJECTION');
});

for (const [name, mutate] of [
  ['missing gate', p => { p.gate = null; }], ['foreign installation', p => { p.gate.installationId = 'other'; }],
  ['unsafe integer', p => { p.gate.dailyLimitMicroUsd = 9007199254740992; }],
  ['negative money', p => { p.requests[0].reservedMicroUsd = '-1'; }],
  ['integer overflow', p => { p.requests[0].reservedMicroUsd = '9223372036854775808'; }],
  ['unknown binding field', p => { p.requests[0].dispatchBinding.source = 'private-source'; }],
  ['URL in binding', p => { p.requests[0].dispatchBinding.endpointId = 'https://example.invalid'; }],
  ['duplicate UUID', p => { p.requests.push(copy(p.requests[0])); }],
  ['unknown usage not zero', p => { p.requests[0].actualMicroUsd = '0'; }],
  ['missing settled proof', p => { p.requests[0].status = 'SETTLED'; p.requests[0].actualMicroUsd = '0'; }],
]) test(`read projection fails closed on ${name}`, async t => {
  const f = await fixture(t); mutate(f.pg); await failure(f.adapter.readProjection(), 'INVALID_PROJECTION');
});

test('readCommittedRequest compares row and complete projection from one SQL snapshot', async t => {
  const f = await fixture(t);
  f.control.value = { request: copy(f.row), settings: { ownerUserId: '1', revision: '2', provider: 'openai', model: 'fixture-model', state: 'ACTIVE' }, projection: f.pg };
  assert.equal((await f.adapter.readCommittedRequest(f.requestId)).settings.state, 'ACTIVE');
  assert.match(f.calls[0].sql, /connection_state='ENABLED'/);
  assertInstallationOwnerPredicate(f.calls[0].sql, f.installationId);
  assert.doesNotMatch(f.calls[0].sql, /'encryptedKey'/);
  f.control.value.request.reservedMicroUsd = '1';
  await failure(f.adapter.readCommittedRequest(f.requestId), 'INVALID_PROJECTION');
});

test('missing request has no fallback reservation', async t => {
  const f = await fixture(t); f.control.value = { request: null, settings: null, projection: f.pg };
  await failure(f.adapter.readCommittedRequest(f.requestId), 'REQUEST_REQUIRED');
});

test('private LOCAL owner and enrollment counts are read without choosing a gate owner', async t => {
  const f = await fixture(t);
  f.control.value = { installationId: f.installationId, ownerUserId: '1' };
  assert.equal((await f.adapter.readLocalOwner()).ownerUserId, '1');
  f.control.value = { ...f.control.value, legacyUsageCount: '1', requestCount: '2', gateCount: '3' };
  assert.equal((await f.adapter.readEnrollmentState()).legacyUsageCount, '1');
  assert.match(f.calls[1].sql, /select count\(\*\)::text from public.ai_usage_logs/);
  assert.doesNotMatch(f.calls[1].sql, /delete|update|insert/i);
});

test('credential getter is revision scoped, encrypted-only and returns numeric key version', async t => {
  const f = await fixture(t);
  f.control.value = { ownerUserId: '1', revision: '2', provider: 'openai', model: 'fixture-model', keyVersion: 1,
    nonceBase64: Buffer.alloc(12, 1).toString('base64'), encryptedKey: Buffer.alloc(32, 2).toString('base64') };
  assert.equal((await f.adapter.readCredential({ ownerUserId: '1', provider: 'openai', settingsRevision: '2' })).keyVersion, 1);
  assert.match(f.calls[0].sql, /p.revision=/); assert.match(f.calls[0].sql, /s.model is not distinct from p.model/);
  assert.doesNotMatch(f.calls[0].args.join(' '), new RegExp(f.control.value.encryptedKey));
  f.control.value.revision = '3';
  await failure(f.adapter.readCredential({ ownerUserId: '1', provider: 'openai', settingsRevision: '2' }), 'CREDENTIAL_UNAVAILABLE');
});

test('credential getter cannot emit plaintext or extra columns', async t => {
  const f = await fixture(t);
  f.control.value = { ownerUserId: '1', revision: '2', provider: 'openai', model: 'fixture-model', keyVersion: 1,
    nonceBase64: 'AAAA', encryptedKey: 'private-key', plaintext: 'private-key' };
  await failure(f.adapter.readCredential({ ownerUserId: '1', provider: 'openai', settingsRevision: '2' }), 'INVALID');
});

test('linked-local owner, enrollment, credentials and committed settings retain the exact installation boundary', async t => {
  // The process double verifies generated predicates and wire validation. Only the opt-in PG
  // cases below claim to execute these joins against LOCAL_LINKED/GITHUB/foreign-key rows.
  const f = await fixture(t);
  f.control.value = { installationId: f.installationId, ownerUserId: '1' };
  assert.deepEqual(await f.adapter.readLocalOwner(), f.control.value);
  f.control.value = { ...f.control.value, legacyUsageCount: '0', requestCount: '1', gateCount: '1' };
  assert.deepEqual(await f.adapter.readEnrollmentState(), f.control.value);
  const encrypted = { ownerUserId: '1', revision: '2', provider: 'openai', model: 'fixture-model', keyVersion: 1,
    nonceBase64: Buffer.alloc(12, 1).toString('base64'), encryptedKey: Buffer.alloc(32, 2).toString('base64') };
  f.control.value = encrypted;
  assert.deepEqual(await f.adapter.readCredential({ ownerUserId: '1', provider: 'openai', settingsRevision: '2' }), encrypted);
  const settings = { ownerUserId: '1', revision: '2', provider: 'openai', model: 'fixture-model', state: 'ACTIVE' };
  f.control.value = { request: copy(f.row), settings, projection: f.pg };
  assert.deepEqual((await f.adapter.readCommittedRequest(f.requestId)).settings, settings);
  assert.equal(f.calls.length, 4);
  for (const call of f.calls) {
    assertInstallationOwnerPredicate(call.sql, f.installationId);
    assert.match(call.sql, /^begin isolation level repeatable read read only;/);
    assert.doesNotMatch(call.sql, /delete|update|insert/i);
  }
  assert.equal(decoded(f.calls[2].sql).ownerUserId, '1');
  assert.equal(decoded(f.calls[2].sql).settingsRevision, '2');
  assert.equal(decoded(f.calls[3].sql).requestId, f.requestId);
});

test('missing installation-scoped identity has no owner, enrollment, credential or settings fallback', async t => {
  const f = await fixture(t);
  // PostgreSQL returns no joined row for GITHUB-only or a foreign installation. Do not substitute
  // an arbitrary user or permit settings from another row when these fixed SQL results are absent.
  f.control.value = null;
  await failure(f.adapter.readLocalOwner(), 'OWNER_REQUIRED');
  await failure(f.adapter.readEnrollmentState(), 'OWNER_REQUIRED');
  await failure(f.adapter.readCredential({ ownerUserId: '1', provider: 'openai', settingsRevision: '2' }), 'CREDENTIAL_UNAVAILABLE');
  f.control.value = { request: copy(f.row), settings: null, projection: f.pg };
  await failure(f.adapter.readCommittedRequest(f.requestId), 'INVALID_PROJECTION');
  for (const call of f.calls) assertInstallationOwnerPredicate(call.sql, f.installationId);
});

test('owner and encrypted credential results cannot substitute a foreign installation or user', async t => {
  const f = await fixture(t);
  f.control.value = { installationId: crypto.randomUUID(), ownerUserId: '1' };
  await failure(f.adapter.readLocalOwner(), 'OWNER_REQUIRED');
  f.control.value = { ...f.control.value, legacyUsageCount: '0', requestCount: '0', gateCount: '0' };
  await failure(f.adapter.readEnrollmentState(), 'OWNER_REQUIRED');
  f.control.value = { ownerUserId: '2', revision: '2', provider: 'openai', model: 'fixture-model', keyVersion: 1,
    nonceBase64: Buffer.alloc(12, 1).toString('base64'), encryptedKey: Buffer.alloc(32, 2).toString('base64') };
  await failure(f.adapter.readCredential({ ownerUserId: '1', provider: 'openai', settingsRevision: '2' }), 'CREDENTIAL_UNAVAILABLE');
});

test('evidence writes require a bound independent core getter', async t => {
  const f = await fixture(t); f.control.value = { ok: true };
  await failure(f.adapter.commitEvidence(f.observed), 'AUTHORITY_REQUIRED');
  assert.equal(f.calls.length, 0);
  f.adapter.bindAuthority(f.authority);
  await f.adapter.commitEvidence(f.observed);
  assert.match(f.calls[0].sql, /for update/); assert.match(f.calls[0].sql, /cost evidence immutable/);
  assert.doesNotMatch(f.calls[0].sql, /set status|set actual_micro_usd/);
  assert.deepEqual(decoded(f.calls[0].sql), f.observed);
});

test('naked usage, substituted proof and missing usage never write', async t => {
  const f = await fixture(t); f.adapter.bindAuthority(f.authority);
  await failure(f.adapter.commitEvidence({ ...f.observed, verified: true }), 'INVALID');
  await failure(f.adapter.commitEvidence({ ...f.observed, actualMicroUsd: '0' }), 'PROOF_MISMATCH');
  await failure(f.adapter.commitEvidence({ ...f.observed, usageDimensions: { units: { INPUT_TOKENS: null } } }), 'INVALID');
  assert.equal(f.calls.length, 0);
});

test('authority binding is private, exact and one time', async t => {
  const f = await fixture(t);
  assert.throws(() => f.adapter.bindAuthority({ ...f.authority, readSql() {} }), AiEgressPostgresError);
  f.adapter.bindAuthority(f.authority);
  assert.throws(() => f.adapter.bindAuthority(f.authority), AiEgressPostgresError);
  assert.equal(f.adapter.readEvidence, undefined); assert.equal(f.adapter.query, undefined);
});

for (const phase of ['DISPATCHED', 'SETTLED', 'RECONCILE', 'LATCH', 'ACTIVATED']) test(`publication ${phase} checks private journal and uses one locked union`, async t => {
  const f = await fixture(t); f.adapter.bindAuthority(f.authority); f.control.value = { ok: true };
  f.controls.rows = [f.obligation(phase === 'SETTLED' ? { status: 'SETTLED', actualMicroUsd: '10', proofSha256: HASH } : {})];
  await f.adapter.applySettlement(f.publication(phase));
  const value = decoded(f.calls[0].sql);
  assert.equal(value.phase, phase); assert.deepEqual(value.journal, f.authority.readJournal());
  assert.match(f.calls[0].sql, /for update/); assert.match(f.calls[0].sql, /greatest\(clock_high_water_ms/);
  assert.match(f.calls[0].sql, /cost journal regression/); assert.match(f.calls[0].sql, /cost settlement evidence missing/);
  assert.doesNotMatch(f.calls[0].sql, /delete from|truncate|drop table/i);
});

test('mismatched or pending snapshot cannot be substituted for core journal proof', async t => {
  const f = await fixture(t); f.adapter.bindAuthority(f.authority);
  await failure(f.adapter.applySettlement(f.publication('RECONCILE', { headHash: OTHER })), 'PROOF_MISMATCH');
  await failure(f.adapter.applySettlement(f.publication('RECONCILE', { pendingRestore: {} })), 'PROOF_MISMATCH');
  assert.equal(f.calls.length, 0);
});

test('publication cannot introduce an arbitrary statement or source body', async t => {
  const f = await fixture(t); f.adapter.bindAuthority(f.authority);
  await failure(f.adapter.applySettlement({ ...f.publication('RECONCILE'), sql: 'select private-source' }), 'INVALID');
  await failure(f.adapter.commitEvidence({ ...f.observed, priceVersion: "x'); select private-source; --" }), 'INVALID');
  assert.equal(f.calls.length, 0);
});

for (const [name, patch] of [
  ['remote host', { connection: { host: 'example.invalid', port: 5432, user: 'codeintel', database: 'codeintel' } }],
  ['connection URI', { connection: { host: '127.0.0.1', port: 5432, user: 'codeintel', database: 'postgresql://host/db' } }],
  ['relative executable', { psqlPath: './psql' }], ['SQL option', { sql: 'select 1' }],
  ['backend URL', { backendUrl: 'http://localhost/private' }], ['inherited shell injection', { env: { PGPASSWORD: 'synthetic-password', PGOPTIONS: '-c search_path=evil' } }],
]) test(`constructor rejects ${name}`, async t => {
  const f = await fixture(t); await failure(createAiEgressPostgres({ ...f.options, ...patch }), 'INVALID');
});

test('symlink psql path is rejected before spawning', async t => {
  const f = await fixture(t); const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ci-cost-psql-path-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const link = path.join(root, 'psql'); await fs.symlink(f.options.psqlPath, link);
  await failure(createAiEgressPostgres({ ...f.options, psqlPath: link }), 'INVALID'); assert.equal(f.calls.length, 0);
});

test('psql failure, stderr and SQL text are never attached to returned errors', async t => {
  const f = await fixture(t); f.control.exit = 2; f.control.stderr = 'injected private-key synthetic-password SQL private-source';
  f.control.value = { injected: 'private-key' };
  await failure(f.adapter.readProjection(), 'PG_FAILED');
});

test('invalid UTF8 and multiple JSON results fail closed', async t => {
  const f = await fixture(t); f.control.emit = (child, close) => { child.stdout.write(Buffer.from([0xff])); close(0); };
  await failure(f.adapter.readProjection(), 'PG_FAILED');
  f.control.emit = null; f.control.value = '{}\n{}'; await failure(f.adapter.readProjection(), 'PG_FAILED');
});

test('stdout is bounded before parsing or retaining an oversized result', async t => {
  const f = await fixture(t); f.control.emit = child => child.stdout.emit('data', Buffer.alloc(LIMITS.outputBytes + 1));
  await failure(f.adapter.readProjection(), 'OUTPUT_LIMIT'); assert.deepEqual(f.calls[0].signals, ['SIGTERM']);
});

test('stderr is bounded without retaining its text', async t => {
  const f = await fixture(t); f.control.emit = child => child.stderr.emit('data', Buffer.alloc(LIMITS.stderrBytes + 1));
  await failure(f.adapter.readProjection(), 'OUTPUT_LIMIT');
});

test('process timeout terminates and reaps the process', async t => {
  const f = await fixture(t, { timeoutMs: 30 }); f.control.hang = true;
  await failure(f.adapter.readProjection(), 'PG_TIMEOUT'); assert.deepEqual(f.calls[0].signals, ['SIGTERM']);
});

test('close terminates active work, rejects queued reads and is idempotent', async t => {
  const f = await fixture(t); f.control.hang = true;
  const first = failure(f.adapter.readProjection(), 'CLOSED');
  const second = failure(f.adapter.readProjection(), 'CLOSED');
  await new Promise(setImmediate);
  const closing = f.adapter.close(); assert.equal(f.adapter.close(), closing);
  await Promise.all([first, second, closing]); assert.equal(f.calls.length, 1);
  await failure(f.adapter.readProjection(), 'CLOSED');
});

test('queue capacity is bounded while the database stalls', async t => {
  const f = await fixture(t); f.control.hang = true;
  const pending = Array.from({ length: LIMITS.queued }, () => failure(f.adapter.readProjection(), 'CLOSED'));
  await failure(f.adapter.readProjection(), 'BUSY');
  await f.adapter.close(); await Promise.all(pending);
});

// Optional isolated-database gate. Root supplies a newly created EMPTY database with this exact
// prefix; the test refuses ordinary database names and never drops/truncates an existing table.
// Unit tests above do not claim SQL execution. This gate executes the actual fixed SQL via psql.
const real = process.env.CI_AI_COST_PG_TEST_PSQL;
test('actual PostgreSQL adapter contract in a dedicated empty fixture database', { skip: !real, timeout: 120000 }, async t => {
  const database = process.env.CI_AI_COST_PG_TEST_DATABASE;
  const port = Number(process.env.CI_AI_COST_PG_TEST_PORT);
  const user = process.env.CI_AI_COST_PG_TEST_USER || 'postgres';
  const password = process.env.CI_AI_COST_PG_TEST_PASSWORD;
  assert.match(database || '', /^ci_ai_cost_test_[a-z0-9_]+$/);
  assert.ok(Number.isInteger(port) && port > 1024 && port < 65536);
  assert.match(user, /^[A-Za-z_][A-Za-z0-9_]{0,62}$/); assert.ok(password);
  const psql = await fs.realpath(real);
  const connection = { host: '127.0.0.1', port, user, database };
  const env = { PGPASSWORD: password };
  if (process.env.CI_AI_COST_PG_TEST_LIBRARY) env.DYLD_LIBRARY_PATH = process.env.CI_AI_COST_PG_TEST_LIBRARY;
  const commandArgs = ['-X', '--no-password', '--quiet', '--tuples-only', '--no-align', '--set=ON_ERROR_STOP=1',
    '--host=127.0.0.1', `--port=${port}`, `--username=${user}`, `--dbname=${database}`, '--file=-'];
  function execute(sql) {
    const result = spawnSync(psql, commandArgs, { input: sql, env: { ...env, PGCLIENTENCODING: 'UTF8', LC_ALL: 'C' },
      encoding: 'utf8', timeout: 15000, maxBuffer: 16 * 1024 * 1024 });
    assert.equal(result.status, 0, 'isolated fixture SQL failed (output deliberately redacted)');
    return result.stdout.trim();
  }
  assert.equal(execute("select count(*) from pg_catalog.pg_tables where schemaname='public';"), '0');
  execute(`create table users(id bigint primary key,local_key text unique,identity_type text not null);
    create table user_ai_preferences(user_id bigint primary key,provider text,model text,connection_state text,revision bigint);
    create table user_ai_settings(user_id bigint primary key,provider text,model text,encrypted_key text,nonce bytea,key_version int);
    create table ai_usage_logs(id bigint primary key);
    ${await fs.readFile(path.join(__dirname, '../../backend/src/main/resources/db/migration/V25__ai_cost_reservations.sql'), 'utf8')}`);
  let owner = 0;
  async function realFixture() {
    const s = state(); owner++;
    s.pg.gate.ownerUserId = String(owner); s.row.ownerUserId = String(owner);
    const encoded = Buffer.from(JSON.stringify(s.pg)).toString('base64');
    execute(`do $fixture$ declare v jsonb:=convert_from(decode('${encoded}','base64'),'UTF8')::jsonb; g jsonb:=v->'gate'; r jsonb:=v->'requests'->0;
      begin
        insert into users values((g->>'ownerUserId')::bigint,g->>'installationId','LOCAL');
        insert into user_ai_preferences values((g->>'ownerUserId')::bigint,'openai','fixture-model','ENABLED',2);
        insert into user_ai_settings values((g->>'ownerUserId')::bigint,'openai','fixture-model','AQIDBA==',decode('010203040506070809101112','hex'),1);
        insert into ai_budget_gate(installation_id,owner_user_id,policy_revision,policy_sha256,daily_limit_micro_usd,monthly_limit_micro_usd,
          legacy_liability_unresolved,journal_hash,journal_projection_sha256)
        values(g->>'installationId',(g->>'ownerUserId')::bigint,1,'${HASH}',1000,2000,false,'${ZERO}','${ZERO}');
        insert into ai_request_ledger(request_id,installation_id,owner_user_id,project_id,snapshot_id,approval_id,plan_sha256,payload_sha256,
          wire_body_sha256,dispatch_binding,budget_day,price_version,reserved_micro_usd,status,liability_floor_micro_usd)
        values((r->>'requestId')::uuid,g->>'installationId',(g->>'ownerUserId')::bigint,2,3,(r->>'approvalId')::uuid,
          '${HASH}','${HASH}','${HASH}',r->'dispatchBinding','${DAY}','fixture-price',100,'RESERVED',100);
      end $fixture$;`);
    const adapter = await createAiEgressPostgres({ psqlPath: psql, installationId: s.installationId, connection, env, now: () => NOW });
    adapter.bindAuthority(s.authority); t.after(() => adapter.close());
    return { ...s, adapter };
  }
  await t.test('complete committed reads normalize every bigint and private LOCAL settings', async () => {
    const f = await realFixture(); const value = await f.adapter.readCommittedRequest(f.requestId);
    assert.deepEqual(value.projection, f.pg); assert.equal(value.settings.state, 'ACTIVE');
    assert.equal(value.settings.ownerUserId, f.row.ownerUserId);
    assert.deepEqual(await f.adapter.readLocalOwner(), { installationId: f.installationId, ownerUserId: f.row.ownerUserId });
  });
  await t.test('encrypted metadata reads reject stale revision and never join a different owner', async () => {
    const f = await realFixture();
    const value = await f.adapter.readCredential({ ownerUserId: f.row.ownerUserId, provider: 'openai', settingsRevision: '2' });
    assert.equal(value.keyVersion, 1); assert.equal(value.encryptedKey, 'AQIDBA==');
    await failure(f.adapter.readCredential({ ownerUserId: f.row.ownerUserId, provider: 'openai', settingsRevision: '1' }), 'CREDENTIAL_UNAVAILABLE');
    await failure(f.adapter.readCredential({ ownerUserId: '900000', provider: 'openai', settingsRevision: '2' }), 'CREDENTIAL_UNAVAILABLE');
  });
  await t.test('linking GitHub preserves the same local owner, credential and committed settings', async () => {
    const f = await realFixture();
    const ownerBefore = await f.adapter.readLocalOwner();
    const input = { ownerUserId: f.row.ownerUserId, provider: 'openai', settingsRevision: '2' };
    const credentialBefore = await f.adapter.readCredential(input);
    const committedBefore = await f.adapter.readCommittedRequest(f.requestId);
    // UserAccount.linkGithub changes identity_type, preserving both id and local_key. No key,
    // preference, budget, request or financial proof is recreated for this transition.
    execute(`update users set identity_type='LOCAL_LINKED' where id=${f.row.ownerUserId};`);
    assert.deepEqual(JSON.parse(execute(`select jsonb_build_object('id',id::text,'localKey',local_key,'identityType',identity_type)
      from users where id=${f.row.ownerUserId};`)),
    { id: f.row.ownerUserId, localKey: f.installationId, identityType: 'LOCAL_LINKED' });
    assert.deepEqual(await f.adapter.readLocalOwner(), ownerBefore);
    assert.equal((await f.adapter.readEnrollmentState()).ownerUserId, f.row.ownerUserId);
    assert.deepEqual(await f.adapter.readCredential(input), credentialBefore);
    const linked = await f.adapter.readCommittedRequest(f.requestId);
    assert.deepEqual(linked, committedBefore);
    assert.equal(linked.settings.state, 'ACTIVE');
    assert.equal(linked.settings.ownerUserId, f.row.ownerUserId);
    assert.equal(linked.settings.revision, '2');
    await failure(f.adapter.readCredential({ ...input, settingsRevision: '1' }), 'CREDENTIAL_UNAVAILABLE');
  });
  for (const [name, identityType] of [['GitHub-only identity', 'GITHUB'], ['foreign linked-local installation', 'LOCAL_LINKED']]) {
    await t.test(`${name} cannot supply a local owner, enrollment, credential or committed settings`, async () => {
      const f = await realFixture();
      const before = await f.adapter.readProjection();
      const localKey = identityType === 'GITHUB' ? 'null' : `'${crypto.randomUUID()}'`;
      execute(`update users set identity_type='${identityType}',local_key=${localKey} where id=${f.row.ownerUserId};`);
      await failure(f.adapter.readLocalOwner(), 'OWNER_REQUIRED');
      await failure(f.adapter.readEnrollmentState(), 'OWNER_REQUIRED');
      await failure(f.adapter.readCredential({ ownerUserId: f.row.ownerUserId, provider: 'openai', settingsRevision: '2' }),
        'CREDENTIAL_UNAVAILABLE');
      await failure(f.adapter.readCommittedRequest(f.requestId), 'INVALID_PROJECTION');
      assert.deepEqual(await f.adapter.readProjection(), before, 'identity rejection must not rewrite financial state');
    });
  }
  await t.test('usage commit is immutable and keeps the entire reservation until B settlement', async () => {
    const f = await realFixture(); await f.adapter.commitEvidence(f.observed); await f.adapter.commitEvidence(f.observed);
    let p = await f.adapter.readProjection(); assert.equal(p.evidence.length, 1);
    assert.equal(p.requests[0].actualMicroUsd, null); assert.equal(p.requests[0].status, 'RESERVED');
    f.controls.observed.actualMicroUsd = '9';
    await failure(f.adapter.commitEvidence(f.controls.observed), 'PG_FAILED');
    p = await f.adapter.readProjection(); assert.equal(p.evidence[0].actualMicroUsd, '10');
  });
  await t.test('actual dispatch and settlement publication preserve original binding and high water', async () => {
    const f = await realFixture(); f.controls.rows = [f.obligation()];
    await f.adapter.applySettlement(f.publication('DISPATCHED'));
    let p = await f.adapter.readProjection(); assert.equal(p.requests[0].status, 'DISPATCHED');
    assert.equal(p.requests[0].journalSequence, '1'); assert.deepEqual(p.requests[0].dispatchBinding, f.binding);
    await f.adapter.commitEvidence(f.observed);
    f.controls.sequence = 2; f.controls.rows = [f.obligation({ status: 'SETTLED', actualMicroUsd: '10', proofSha256: HASH })];
    await f.adapter.applySettlement(f.publication('SETTLED'));
    p = await f.adapter.readback(); assert.equal(p.requests[0].actualMicroUsd, '10');
    assert.equal(p.gate.journalSequence, '2'); assert.equal(p.gate.clockHighWaterMs, String(NOW));
  });
  await t.test('journal ACK without committed usage evidence cannot release a reservation', async () => {
    const f = await realFixture(); f.controls.rows = [f.obligation({ status: 'SETTLED', actualMicroUsd: '10', proofSha256: HASH })];
    await failure(f.adapter.applySettlement(f.publication('SETTLED')), 'PG_FAILED');
    assert.equal((await f.adapter.readProjection()).requests[0].status, 'RESERVED');
  });
  await t.test('reconcile imports missing B rows as non-dispatchable placeholders', async () => {
    const f = await realFixture(); const id = crypto.randomUUID();
    f.controls.rows = [f.obligation({ requestId: id, status: 'UNKNOWN_HELD' })];
    await f.adapter.applySettlement(f.publication('RECONCILE'));
    const p = await f.adapter.readProjection(); const imported = p.requests.find(row => row.requestId === id);
    assert.equal(imported.ownerUserId, null); assert.equal(imported.dispatchBinding, null);
    assert.equal(imported.status, 'UNKNOWN_HELD'); assert.equal(p.requests.length, 2);
  });
  await t.test('legacy liability and pending restore cannot be cleared by publication', async () => {
    const f = await realFixture();
    execute(`update ai_budget_gate set legacy_liability_unresolved=true where installation_id='${f.installationId}';`);
    await f.adapter.applySettlement(f.publication('RECONCILE'));
    assert.equal((await f.adapter.readProjection()).gate.reconciliationRequired, true);
    const second = await realFixture(); second.controls.pending = true;
    await second.adapter.applySettlement(second.publication('RECONCILE'));
    assert.equal((await second.adapter.readProjection()).gate.reconciliationRequired, true);
  });
  await t.test('old journal publication is rejected atomically', async () => {
    const f = await realFixture(); f.controls.sequence = 3; f.controls.rows = [f.obligation()];
    await f.adapter.applySettlement(f.publication('DISPATCHED'));
    f.controls.sequence = 2;
    await failure(f.adapter.applySettlement(f.publication('RECONCILE')), 'PG_FAILED');
    assert.equal((await f.adapter.readProjection()).gate.journalSequence, '3');
  });
  await t.test('conflicting identities retain original bytes and the larger financial obligation', async () => {
    const f = await realFixture(); f.controls.rows = [f.obligation({ payloadSha256: OTHER, reservedMicroUsd: '200', liabilityFloorMicroUsd: '250' })];
    await f.adapter.applySettlement(f.publication('RECONCILE'));
    const p = await f.adapter.readProjection(); const row = p.requests[0];
    assert.equal(row.payloadSha256, HASH); assert.equal(row.conflict, true); assert.equal(row.liabilityFloorMicroUsd, '250');
    assert.equal(p.gate.reconciliationRequired, true);
  });
  await t.test('missing journal DISPATCHED and above-reservation settlement keep admission blocked', async () => {
    const f = await realFixture(); f.controls.rows = [f.obligation()];
    await f.adapter.applySettlement(f.publication('DISPATCHED'));
    f.controls.sequence++; f.controls.rows = [];
    await f.adapter.applySettlement(f.publication('RECONCILE'));
    assert.equal((await f.adapter.readProjection()).gate.reconciliationRequired, true);
    const second = await realFixture(); second.controls.observed.actualMicroUsd = '150';
    await second.adapter.commitEvidence(second.controls.observed);
    second.controls.rows = [second.obligation({ status: 'SETTLED', actualMicroUsd: '150', proofSha256: HASH })];
    await second.adapter.applySettlement(second.publication('SETTLED'));
    const p = await second.adapter.readProjection(); assert.equal(p.requests[0].actualMicroUsd, '150');
    assert.equal(p.gate.reconciliationRequired, true);
  });
  await t.test('full journal known zero settlement restores independently of lost A evidence', async () => {
    const f = await realFixture(); f.controls.rows = [f.obligation({ status: 'SETTLED', actualMicroUsd: '0', proofSha256: HASH })];
    await f.adapter.applySettlement(f.publication('RECONCILE'));
    const p = await f.adapter.readProjection(); assert.equal(p.requests[0].actualMicroUsd, '0'); assert.equal(p.evidence.length, 0);
  });
  await t.test('empty enrollment claims include all historical installations and legacy logs', async () => {
    const f = await realFixture(); execute('insert into ai_usage_logs values(1);');
    const value = await f.adapter.readEnrollmentState(); assert.equal(value.legacyUsageCount, '1');
    assert.ok(BigInt(value.requestCount) > 1n); assert.ok(BigInt(value.gateCount) > 1n);
  });
});
