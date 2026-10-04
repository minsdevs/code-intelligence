'use strict';
const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const { EventEmitter } = require('node:events');
const { PassThrough, Writable } = require('node:stream');
const { spawnSync } = require('node:child_process');
const { createAiEgressPostgres, validateCostProjection, AiEgressPostgresError } = require('../src/ai-egress-postgres.cjs');
const I = '11111111-1111-4111-8111-111111111111', R = '22222222-2222-4222-8222-222222222222';
const E = '33333333-3333-4333-8333-333333333333', A = '44444444-4444-4444-8444-444444444444';
const H = 'a'.repeat(64), Z = '0'.repeat(64), NOW = Date.parse('2026-10-03T00:00:00Z');
const STAGE = 'ci_backup_stage_abcdef0123456789';
const copy = value => JSON.parse(JSON.stringify(value));
function policyHash(g) { return crypto.createHash('sha256').update(`AI_BUDGET_POLICY_1\n${I}\n${g.ownerUserId}\n${g.policyRevision}\n${g.dailyLimitMicroUsd}\n${g.monthlyLimitMicroUsd}`).digest('hex'); }
function request(patch = {}) {
  return { requestId: R, installationId: I, ownerUserId: '1', projectId: '2', snapshotId: '3', approvalId: A,
    planSha256: H, payloadSha256: H, wireBodySha256: H, dispatchBinding: { mainEpoch: E, provider: 'openai', model: 'fixture',
      operation: 'CHAT', endpointId: 'openai.chat', adapterVersion: 'fixture', tokenizerId: 'fixture', tokenizerVersion: '1',
      costContractSha256: H, priceSha256: H, settingsRevision: '1', policyRevision: '1', policySha256: H,
      inputTokenUpperBound: '3', outputTokenMax: '4', embeddingInputTokenUpperBound: '0', wireBodyBytes: '5', validUntilEpochMs: String(NOW + 1000) },
    budgetDay: '2026-10-03', priceVersion: 'fixture', reservedMicroUsd: '100', status: 'UNKNOWN_HELD', actualMicroUsd: null,
    proofSha256: null, liabilityFloorMicroUsd: '100', conflict: false, journalSequence: '1', journalHash: H, ...patch };
}
function projection(rows = [request()], patch = {}, proof = []) {
  const gate = { installationId: I, ownerUserId: '1', policyRevision: '2', policySha256: H, dailyLimitMicroUsd: '1000',
    monthlyLimitMicroUsd: '9000', reconciliationRequired: true, legacyLiabilityUnresolved: false, journalSequence: '1',
    journalHash: H, journalProjectionSha256: H, clockHighWaterMs: String(NOW), ...patch };
  return { version: 1, complete: true, gate, requests: rows, evidence: proof };
}
function evidence(patch = {}) { return { requestId: R, proofSha256: H, mainEpoch: E, receiptType: 'USAGE', providerRequestId: 'fixture',
  usageDimensions: { units: { INPUT_TOKENS: '1', OUTPUT_TOKENS: '0', CACHED_INPUT_TOKENS: '0', REQUESTS: '1' } }, actualMicroUsd: '10', ...patch }; }
function bRow(row = request()) { return Object.fromEntries(['requestId', 'payloadSha256', 'budgetDay', 'priceVersion', 'reservedMicroUsd',
  'status', 'actualMicroUsd', 'proofSha256', 'liabilityFloorMicroUsd', 'conflict'].map(k => [k, row[k]])); }
function snapshot(rows = [request()]) {
  return { major: 1, installationId: I, sequence: 10, headHash: H, projectionDigest: H, clockHighWaterMs: NOW, budgetDay: '2026-10-03',
    pendingRestore: null, pendingMaintenance: { transactionId: A, kind: 'RESTORE', payloadSha256: H, pgProjectionDigest: H,
      legacyLiabilityUnresolved: false, budgetDay: '2026-10-03', minimumVersion: '1' }, aiOff: true, legacyLiabilityUnresolved: false,
    recoveryOnly: false, requests: rows.map(row => ({ ...bRow(row), dispatchIntent: false })) };
}
function authority(control, extended = true) {
  return { readDispatch: () => null, readEvidence: () => null, readSettlement: () => null,
    readJournal: () => ({ installationId: I, position: { sequence: String(control.snapshot.sequence), hash: control.snapshot.headHash,
      projectionSha256: control.snapshot.projectionDigest, clockHighWaterMs: String(control.snapshot.clockHighWaterMs) },
      budgetDay: control.snapshot.budgetDay, restorePending: control.snapshot.pendingRestore !== null || Boolean(control.snapshot.pendingMaintenance),
      obligations: control.snapshot.requests.map(bRow) }),
    ...(extended ? { readMaintenanceSnapshot: () => copy(control.snapshot) } : {}) };
}
async function rejects(promise, code) { await assert.rejects(promise, e => { assert(e instanceof AiEgressPostgresError);
  if (code) assert.equal(e.code, `AI_COST_PG_${code}`); assert.doesNotMatch(String(e), /private-password|private-payload|select|injected/);
  assert.equal(e.cause, undefined); return true; }); }
function decoded(sql) { const token = sql.match(/decode\('([A-Za-z0-9+/=]+)','base64'\)/)?.[1]; assert(token); return JSON.parse(Buffer.from(token, 'base64').toString()); }
async function fixture(t, extended = true) {
  const controls = { snapshot: snapshot(), live: projection(), stage: null, seed: null, mutate: null, hang: false, exit: 0, history: false };
  const calls = [];
  const spawn = (command, args, options) => {
    const child = new EventEmitter(); child.stdout = new PassThrough(); child.stderr = new PassThrough();
    const c = { command, args: [...args], options, sql: '', signals: [] }; calls.push(c); let closed = false;
    const finish = code => { if (closed) return; closed = true; child.stdout.end(); child.stderr.end(); child.emit('close', code); };
    child.kill = signal => { c.signals.push(signal); queueMicrotask(() => finish(null)); return true; };
    child.stdin = new Writable({ write(chunk, _encoding, done) { c.sql += chunk.toString(); done(); } });
    child.stdin.on('finish', () => queueMicrotask(() => {
      if (controls.hang) return;
      const isStage = args.some(a => a.startsWith('--dbname=ci_backup_stage_'));
      let result;
      if (c.sql.includes('do $maintenance_gate$')) {
        const input = decoded(c.sql);
        controls.live.gate.legacyLiabilityUnresolved ||= input.legacyLiabilityUnresolved || controls.history;
        controls.live.gate.reconciliationRequired = true; result = { ok: true };
      } else if (c.sql.includes('do $maintenance_seed$')) {
        controls.seed = decoded(c.sql); controls.stage = copy(controls.seed); result = { ok: true };
      } else result = isStage ? controls.stage : controls.live;
      if (controls.mutate) controls.mutate(result, c, controls);
      child.stdout.write(JSON.stringify(result)); finish(controls.exit);
    }));
    return child;
  };
  const options = { psqlPath: await fs.realpath(process.execPath), installationId: I,
    connection: { host: '127.0.0.1', port: 6543, user: 'codeintel', database: 'codeintel' },
    env: { PGPASSWORD: 'private-password' }, spawn, timeoutMs: 100, now: () => NOW };
  const adapter = await createAiEgressPostgres(options); if (extended !== null) adapter.bindAuthority(authority(controls, extended));
  t.after(() => adapter.close().catch(() => {}));
  return { controls, calls, options, adapter };
}
async function stage(t) { const f = await fixture(t); f.stage = await f.adapter.createMaintenanceStage({ database: STAGE }); return f; }
function seed(f, archived = null) { return { liveProjection: f.controls.live, archivedProjection: archived, journalSnapshot: copy(f.controls.snapshot) }; }

test('old four-getter authority still supports ordinary reads but cannot run maintenance', async t => {
  const f = await fixture(t, false); assert.deepEqual(await f.adapter.readProjection(), f.controls.live);
  await rejects(f.adapter.prepareMaintenanceGate({ ownerUserId: '1', legacyLiabilityUnresolved: false }), 'AUTHORITY_REQUIRED');
  await rejects(f.adapter.createMaintenanceStage({ database: STAGE }), 'AUTHORITY_REQUIRED');
});
test('maintenance requires bound authority and rejects malformed getters', async t => {
  const f = await fixture(t, null);
  await rejects(f.adapter.prepareMaintenanceGate({ ownerUserId: '1', legacyLiabilityUnresolved: false }), 'AUTHORITY_REQUIRED');
  assert.throws(() => f.adapter.bindAuthority(null), AiEgressPostgresError);
  assert.throws(() => f.adapter.bindAuthority({ ...authority(f.controls), readMaintenanceSnapshot: true }), AiEgressPostgresError);
});
test('pre-seal preparation accepts OFF and persists B legacy OR even if caller passes false', async t => {
  const f = await fixture(t); f.controls.snapshot.pendingMaintenance = null; f.controls.snapshot.legacyLiabilityUnresolved = true;
  const result = await f.adapter.prepareMaintenanceGate({ ownerUserId: '1', legacyLiabilityUnresolved: false });
  assert.equal(result.gate.legacyLiabilityUnresolved, true); assert.equal(result.gate.reconciliationRequired, true);
  const value = decoded(f.calls[0].sql); assert.equal(value.legacyLiabilityUnresolved, true);
  assert.equal(value.policySha256, policyHash({ ownerUserId: '1', policyRevision: '0', dailyLimitMicroUsd: '0', monthlyLimitMicroUsd: '0' }));
  assert.match(f.calls[0].sql, /legacy_liability_unresolved=legacy_liability_unresolved or legacy/);
  assert.match(f.calls[0].sql, /exists\(select 1 from public.ai_usage_logs\)/);
  assert.match(f.calls[0].sql, /local_key is not null/);
});
for (const source of ['caller', 'existing PG', 'history']) test(`prepare preserves ${source} legacy liability`, async t => {
  const f = await fixture(t); f.controls.live.gate.legacyLiabilityUnresolved = source === 'existing PG'; f.controls.history = source === 'history';
  const result = await f.adapter.prepareMaintenanceGate({ ownerUserId: '1', legacyLiabilityUnresolved: source === 'caller' });
  assert.equal(result.gate.legacyLiabilityUnresolved, true);
});
test('prepare cannot run with AI active or accept a mismatched owner readback', async t => {
  const f = await fixture(t); f.controls.snapshot.aiOff = false;
  await rejects(f.adapter.prepareMaintenanceGate({ ownerUserId: '1', legacyLiabilityUnresolved: false }), 'PROOF_MISMATCH'); assert.equal(f.calls.length, 0);
  f.controls.snapshot.aiOff = true; f.controls.live.gate.ownerUserId = '2';
  await rejects(f.adapter.prepareMaintenanceGate({ ownerUserId: '1', legacyLiabilityUnresolved: false }), 'PROOF_MISMATCH');
});
test('prepare rechecks a concurrently raised B legacy flag', async t => {
  const f = await fixture(t); f.controls.mutate = (_value, c) => { if (c.sql.includes('with params')) f.controls.snapshot.legacyLiabilityUnresolved = true; };
  await rejects(f.adapter.prepareMaintenanceGate({ ownerUserId: '1', legacyLiabilityUnresolved: false }), 'PROOF_MISMATCH');
});
test('stage child has only seed/read/close and inherits fixed parent process configuration', async t => {
  const f = await stage(t); assert.deepEqual(Object.keys(f.stage).sort(), ['close', 'readProjection', 'readback', 'seedMaintenanceProjection']);
  assert.equal(f.adapter.seedMaintenanceProjection, undefined); assert.equal(f.stage.bindAuthority, undefined);
  await f.stage.seedMaintenanceProjection(seed(f));
  const c = f.calls[0]; assert(c.args.includes(`--dbname=${STAGE}`)); assert(c.args.includes('--host=127.0.0.1'));
  assert.equal(c.options.env.PGPASSWORD, 'private-password'); assert.equal(c.options.shell, false);
  assert(!c.args.join(' ').includes('private-password')); assert(!c.args.join(' ').includes('select'));
});
for (const database of ['codeintel', 'postgres', 'ci_backup_stage_', 'ci_backup_stage_abcdef0123456789;drop', 'ci_backup_stage_ABCDEF0123456789']) {
  test(`stage database name ${database} is refused`, async t => {
    const f = await fixture(t); await rejects(f.adapter.createMaintenanceStage({ database }), 'INVALID'); assert.equal(f.calls.length, 0);
  });
}
test('stage creation is bounded and closing a stage frees capacity', async t => {
  const f = await stage(t); const second = await f.adapter.createMaintenanceStage({ database: 'ci_backup_stage_1111111111111111' });
  await rejects(f.adapter.createMaintenanceStage({ database: 'ci_backup_stage_2222222222222222' }), 'BUSY');
  await second.close(); await f.adapter.createMaintenanceStage({ database: 'ci_backup_stage_2222222222222222' });
});
test('a regular factory opened on a staging-named database cannot acquire seed capability', async t => {
  const f = await fixture(t); const direct = await createAiEgressPostgres({ ...f.options, connection: { ...f.options.connection, database: STAGE } });
  t.after(() => direct.close()); assert.equal(direct.seedMaintenanceProjection, undefined);
});
for (const [name, change] of [
  ['missing seal', s => { s.pendingMaintenance = null; }], ['AI active', s => { s.aiOff = false; }],
  ['incomplete restore', s => { s.pendingRestore = { restoreId: A }; }], ['poisoned B', s => { s.recoveryOnly = true; }],
  ['missing legacy flag', s => { delete s.legacyLiabilityUnresolved; }], ['contradictory seal legacy', s => { s.pendingMaintenance.legacyLiabilityUnresolved = true; }],
]) test(`seed rejects ${name} before SQL`, async t => {
  const f = await stage(t); change(f.controls.snapshot);
  await rejects(f.stage.seedMaintenanceProjection(seed(f)), 'PROOF_MISMATCH'); assert.equal(f.calls.length, 0);
});
test('forged supplied snapshot and inconsistent private getters are rejected', async t => {
  const f = await stage(t); const supplied = seed(f); supplied.journalSnapshot.pendingMaintenance.payloadSha256 = 'b'.repeat(64);
  await rejects(f.stage.seedMaintenanceProjection(supplied), 'PROOF_MISMATCH');
  const separate = await fixture(t, null); const methods = authority(separate.controls);
  const original = methods.readJournal; methods.readJournal = () => ({ ...original(), restorePending: false });
  separate.adapter.bindAuthority(methods); await rejects(separate.adapter.createMaintenanceStage({ database: STAGE }), 'PROOF_MISMATCH');
});
test('seed uses B final state in its first INSERT and preserves current limits while raising policy revision', async t => {
  const f = await stage(t); const archived = projection([request({ status: 'SETTLED', actualMicroUsd: '10', proofSha256: H })],
    { policyRevision: '8', dailyLimitMicroUsd: '1', monthlyLimitMicroUsd: '1', legacyLiabilityUnresolved: true }, [evidence()]);
  f.controls.snapshot.legacyLiabilityUnresolved = true;
  const result = await f.stage.seedMaintenanceProjection(seed(f, archived));
  assert.equal(result.requests[0].status, 'UNKNOWN_HELD'); assert.equal(result.requests[0].actualMicroUsd, null);
  assert.equal(result.requests[0].dispatchBinding.mainEpoch, E); assert.equal(result.gate.policyRevision, '9');
  assert.equal(result.gate.dailyLimitMicroUsd, '1000'); assert.equal(result.gate.monthlyLimitMicroUsd, '9000');
  assert.equal(result.gate.policySha256, policyHash(result.gate)); assert.equal(result.gate.legacyLiabilityUnresolved, true);
  assert.equal(result.gate.reconciliationRequired, true); assert.equal(result.requests[0].journalSequence, '10');
  assert.deepEqual(result.evidence, [evidence()]); assert(!f.calls[0].sql.includes('update public.ai_request_ledger'));
});
test('B-only and mismatched identities become nondispatchable placeholders; matching archive metadata is a fallback', async t => {
  const f = await stage(t); f.controls.live.requests[0].payloadSha256 = 'b'.repeat(64);
  const archive = projection([request({ planSha256: 'c'.repeat(64) })]);
  f.controls.snapshot.requests.push({ ...bRow(request({ requestId: A })), dispatchIntent: false });
  const result = await f.stage.seedMaintenanceProjection(seed(f, archive));
  assert.equal(result.requests.find(r => r.requestId === R).planSha256, 'c'.repeat(64));
  const onlyB = result.requests.find(r => r.requestId === A); assert.equal(onlyB.dispatchBinding, null); assert.equal(onlyB.ownerUserId, null);
  assert.equal(onlyB.planSha256, Z); assert.equal(onlyB.wireBodySha256, Z);
  const mismatch = await stage(t); mismatch.controls.live.requests[0].payloadSha256 = 'b'.repeat(64);
  const placeholder = await mismatch.stage.seedMaintenanceProjection(seed(mismatch)); assert.equal(placeholder.requests[0].dispatchBinding, null);
});
for (const [name, edit] of [
  ['missing B obligation', f => { f.controls.snapshot.requests = []; }],
  ['lower B floor', f => { f.controls.snapshot.requests[0].liabilityFloorMicroUsd = '99'; }],
  ['lost conflict', f => { f.controls.live.requests[0].conflict = true; }],
  ['unreconciled live gate', f => { f.controls.live.gate.reconciliationRequired = false; }],
  ['policy revision overflow', f => { f.controls.live.gate.policyRevision = '9223372036854775807'; }],
]) test(`seed rejects ${name}`, async t => {
  const f = await stage(t); edit(f); await rejects(f.stage.seedMaintenanceProjection(seed(f))); assert.equal(f.calls.length, 0);
});
test('evidence actual above B floor cannot be hidden behind a smaller reservation', async t => {
  const f = await stage(t); f.controls.live.evidence = [evidence({ actualMicroUsd: '101' })];
  await rejects(f.stage.seedMaintenanceProjection(seed(f)), 'PROOF_MISMATCH'); assert.equal(f.calls.length, 0);
});
test('conflicting same-proof evidence is rejected while exact duplicates are deduplicated', async t => {
  const f = await stage(t); f.controls.live.evidence = [evidence()];
  const bad = projection([request()], {}, [evidence({ actualMicroUsd: '11' })]);
  await rejects(f.stage.seedMaintenanceProjection(seed(f, bad)), 'PROOF_MISMATCH');
  const result = await f.stage.seedMaintenanceProjection(seed(f, projection([request()], {}, [evidence()])));
  assert.equal(result.evidence.length, 1);
});
test('current, archived and B clock high-water and legacy flags are never reduced', async t => {
  const f = await stage(t); f.controls.snapshot.legacyLiabilityUnresolved = true;
  const result = await f.stage.seedMaintenanceProjection(seed(f, projection([request()], { clockHighWaterMs: String(NOW + 1000) })));
  assert.equal(result.gate.clockHighWaterMs, String(NOW + 1000)); assert.equal(result.gate.legacyLiabilityUnresolved, true);
});
test('legacy liability known only in area A must be persisted in B before stage seeding', async t => {
  const f = await stage(t); f.controls.live.gate.legacyLiabilityUnresolved = true;
  await rejects(f.stage.seedMaintenanceProjection(seed(f)), 'PROOF_MISMATCH'); assert.equal(f.calls.length, 0);
  f.controls.live.gate.legacyLiabilityUnresolved = false;
  await rejects(f.stage.seedMaintenanceProjection(seed(f, projection([request()], { legacyLiabilityUnresolved: true }))), 'PROOF_MISMATCH');
});
test('conflicting known settlements require B conflict rather than silently selecting a receipt', async t => {
  const f = await stage(t); f.controls.live.requests = [request({ status: 'SETTLED', actualMicroUsd: '9', proofSha256: H })];
  f.controls.snapshot = snapshot([request({ status: 'SETTLED', actualMicroUsd: '10', proofSha256: H })]);
  await rejects(f.stage.seedMaintenanceProjection(seed(f)), 'PROOF_MISMATCH');
});
test('seed compares actual committed readback and consumes the stage attempt after any SQL attempt', async t => {
  const f = await stage(t); f.controls.mutate = (value, c) => { if (!c.sql.includes('do $maintenance_seed$')) value.gate.dailyLimitMicroUsd = '1'; };
  await rejects(f.stage.seedMaintenanceProjection(seed(f)), 'PROOF_MISMATCH');
  await rejects(f.stage.seedMaintenanceProjection(seed(f)), 'AUTHORITY_REQUIRED');
});
test('a changed B head during PG publication rejects completion', async t => {
  const f = await stage(t); f.controls.mutate = (_value, c) => { if (c.sql.includes('do $maintenance_seed$')) f.controls.snapshot.sequence++; };
  await rejects(f.stage.seedMaintenanceProjection(seed(f)), 'PROOF_MISMATCH');
});
test('parent close closes children and interrupts in-flight seed SQL', async t => {
  const f = await stage(t); f.controls.hang = true;
  const pending = f.stage.seedMaintenanceProjection(seed(f)); const rejected = rejects(pending, 'CLOSED');
  await new Promise(resolve => setImmediate(resolve)); await f.adapter.close(); await rejected;
  await rejects(f.stage.readProjection(), 'CLOSED');
});
test('new pure projection export validates data but cannot grant maintenance authority', () => {
  const input = projection(); const owned = validateCostProjection(input, I); assert(Object.isFrozen(owned.requests));
  input.gate.dailyLimitMicroUsd = '0'; assert.equal(owned.gate.dailyLimitMicroUsd, '1000');
});

test('real isolated PG maintenance enrollment, conservative stage insert and immutable replay refusal', {
  skip: !process.env.CI_BACKUP_COST_PG_TEST_PSQL,
}, async t => {
  const psqlPath = await fs.realpath(process.env.CI_BACKUP_COST_PG_TEST_PSQL);
  const source = process.env.CI_BACKUP_COST_PG_TEST_SOURCE, target = process.env.CI_BACKUP_COST_PG_TEST_TARGET;
  assert.match(source || '', /^ci_backup_stage_[0-9a-f]{16,32}$/); assert.match(target || '', /^ci_backup_stage_[0-9a-f]{16,32}$/); assert.notEqual(source, target);
  const port = Number(process.env.CI_BACKUP_COST_PG_TEST_PORT); assert(Number.isInteger(port) && port > 1024 && port <= 65535);
  const user = process.env.CI_BACKUP_COST_PG_TEST_USER, env = { PGPASSWORD: process.env.CI_BACKUP_COST_PG_TEST_PASSWORD, PGSSLMODE: 'verify-full', PGSSLROOTCERT: process.env.PGSSLROOTCERT };
  if (process.env.CI_BACKUP_COST_PG_TEST_LIBRARY) env.DYLD_LIBRARY_PATH = process.env.CI_BACKUP_COST_PG_TEST_LIBRARY;
  const sql = (database, text, expected = 0) => {
    const r = spawnSync(psqlPath, ['-X', '--no-password', '--quiet', '--tuples-only', '--no-align', '--set=ON_ERROR_STOP=1',
      '--host=127.0.0.1', `--port=${port}`, `--username=${user}`, `--dbname=${database}`, '--file=-'],
    { input: text, env: { ...env, PGCLIENTENCODING: 'UTF8', LC_ALL: 'C' }, encoding: 'utf8', timeout: 30000, maxBuffer: 4 * 1024 * 1024 });
    assert.equal(r.status, expected, 'Synthetic fixture SQL failed; raw output intentionally omitted.'); return r.stdout.trim();
  };
  const migration = await fs.readFile(path.resolve(__dirname, '../../backend/src/main/resources/db/migration/V25__ai_cost_reservations.sql'), 'utf8');
  for (const database of [source, target]) {
    assert.equal(sql(database, "select count(*) from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname='public';"), '0');
    sql(database, `create table users(id bigint primary key,local_key text,identity_type text); create table ai_usage_logs(id bigint primary key);
      ${migration}\ninsert into users values(1,'${I}','LOCAL_LINKED');`);
  }
  const controls = { snapshot: snapshot([]) }; controls.snapshot.pendingMaintenance = null;
  const adapter = await createAiEgressPostgres({ psqlPath, installationId: I, connection: { host: '127.0.0.1', port, user, database: source }, env });
  adapter.bindAuthority(authority(controls)); t.after(() => adapter.close());
  const fresh = await adapter.prepareMaintenanceGate({ ownerUserId: '1', legacyLiabilityUnresolved: false });
  assert.equal(fresh.gate.dailyLimitMicroUsd, '0'); assert.equal(fresh.gate.monthlyLimitMicroUsd, '0'); assert.equal(fresh.gate.reconciliationRequired, true);
  assert.equal(fresh.gate.policySha256, policyHash(fresh.gate)); assert.equal(fresh.gate.legacyLiabilityUnresolved, false);
  sql(source, "insert into ai_usage_logs values(1); update ai_budget_gate set policy_revision=7,daily_limit_micro_usd=1000,monthly_limit_micro_usd=9000;");
  const live = await adapter.prepareMaintenanceGate({ ownerUserId: '1', legacyLiabilityUnresolved: false }); assert.equal(live.gate.legacyLiabilityUnresolved, true);
  sql(source, "delete from ai_usage_logs; insert into users values(2,'foreign','GITHUB');");
  await rejects(adapter.prepareMaintenanceGate({ ownerUserId: '1', legacyLiabilityUnresolved: false }), 'PG_FAILED');
  sql(source, 'delete from users where id=2;');
  assert.equal((await adapter.prepareMaintenanceGate({ ownerUserId: '1', legacyLiabilityUnresolved: false })).gate.legacyLiabilityUnresolved, true);
  controls.snapshot = snapshot([request({ reservedMicroUsd: '200', liabilityFloorMicroUsd: '200', conflict: true })]);
  controls.snapshot.legacyLiabilityUnresolved = true;
  const archived = projection([request({ status: 'SETTLED', actualMicroUsd: '10', proofSha256: H })], { policyRevision: '12' }, [evidence()]);
  const stage = await adapter.createMaintenanceStage({ database: target });
  const result = await stage.seedMaintenanceProjection({ liveProjection: live, archivedProjection: archived, journalSnapshot: copy(controls.snapshot) });
  assert.equal(result.gate.policyRevision, '13'); assert.equal(result.gate.policySha256, policyHash(result.gate));
  assert.equal(result.gate.dailyLimitMicroUsd, '1000'); assert.equal(result.gate.legacyLiabilityUnresolved, true);
  assert.equal(result.requests[0].status, 'UNKNOWN_HELD'); assert.equal(result.requests[0].reservedMicroUsd, '200');
  assert.equal(result.requests[0].liabilityFloorMicroUsd, '200'); assert.equal(result.requests[0].dispatchBinding, null);
  assert.equal(result.requests[0].ownerUserId, null); assert.equal(result.evidence[0].actualMicroUsd, '10');
  await rejects(stage.seedMaintenanceProjection({ liveProjection: live, archivedProjection: archived, journalSnapshot: copy(controls.snapshot) }), 'AUTHORITY_REQUIRED');
  await stage.close(); const another = await adapter.createMaintenanceStage({ database: target });
  await rejects(another.seedMaintenanceProjection({ liveProjection: live, archivedProjection: archived, journalSnapshot: copy(controls.snapshot) }), 'PG_FAILED');
  assert.equal(sql(target, 'select count(*) from ai_request_ledger;'), '1');
});
