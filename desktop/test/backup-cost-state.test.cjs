'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const test = require('node:test');
const { createBackupCostCollector, buildMaintenanceMergeInputs, maintenanceProjectionDigest, createMaintenanceVerifier } = require('../src/backup-cost-state.cjs');
const { createBackupExportPolicy, REVIEWED_SCHEMA } = require('../src/backup-export-policy.cjs');

const POLICY = createBackupExportPolicy(REVIEWED_SCHEMA);
const INSTALL = 'synthetic-backup-cost-installation';
const ID = '9007199254740993';
const REQUEST = '11111111-2222-4333-8444-555555555555';
const SECOND = '21111111-2222-4333-8444-555555555555';
const EPOCH = '31111111-2222-4333-8444-555555555555';
const TX = '41111111-2222-4333-8444-555555555555';
const HASH = 'a'.repeat(64), OTHER = 'b'.repeat(64), STAMP = '2026-10-03T00:00:00.123456Z';
const OBLIGATION = ['requestId', 'payloadSha256', 'budgetDay', 'priceVersion', 'reservedMicroUsd', 'status', 'actualMicroUsd', 'proofSha256', 'liabilityFloorMicroUsd', 'conflict'];
const COUNTERS = ['settingsRevision', 'policyRevision', 'inputTokenUpperBound', 'outputTokenMax', 'embeddingInputTokenUpperBound', 'wireBodyBytes', 'validUntilEpochMs'];
const clone = value => JSON.parse(JSON.stringify(value));
const camel = value => value.replace(/_([a-z])/g, (_, c) => c.toUpperCase());
const canonical = value => Array.isArray(value) ? `[${value.map(canonical)}]` : value && typeof value === 'object'
  ? `{${Object.keys(value).sort().map(k => `${JSON.stringify(k)}:${canonical(value[k])}`).join(',')}}` : JSON.stringify(value);
const sha = value => crypto.createHash('sha256').update(value).digest('hex');
function frozen(value) { if (value && typeof value === 'object') { Object.values(value).forEach(frozen); Object.freeze(value); } return value; }
function binding() { return { mainEpoch: EPOCH, provider: 'openai', model: 'synthetic-model', operation: 'CHAT', endpointId: 'openai.chat',
  adapterVersion: 'synthetic-adapter', tokenizerId: 'synthetic-tokenizer', tokenizerVersion: '1', costContractSha256: HASH,
  priceSha256: OTHER, settingsRevision: '2', policyRevision: '3', policySha256: HASH, inputTokenUpperBound: '100', outputTokenMax: '20',
  embeddingInputTokenUpperBound: '0', wireBodyBytes: '200', validUntilEpochMs: '1791029400000' }; }
function request(changes = {}) { return { requestId: REQUEST, installationId: INSTALL, ownerUserId: ID, projectId: '7', snapshotId: '9',
  approvalId: EPOCH, planSha256: HASH, payloadSha256: HASH, wireBodySha256: OTHER, dispatchBinding: binding(), budgetDay: '2026-10-03',
  priceVersion: 'synthetic-price-v1', reservedMicroUsd: '100', status: 'UNKNOWN_HELD', actualMicroUsd: null, proofSha256: null,
  liabilityFloorMicroUsd: '150', conflict: false, journalSequence: '5', journalHash: HASH, ...changes }; }
function evidence(changes = {}) { return { requestId: REQUEST, proofSha256: OTHER, mainEpoch: EPOCH, receiptType: 'USAGE',
  providerRequestId: 'synthetic-response', usageDimensions: { units: { INPUT_TOKENS: '5', OUTPUT_TOKENS: '2' } }, actualMicroUsd: '180', ...changes }; }
function projection(requests = [request()], proofs = [evidence()]) { return { version: 1, complete: true,
  gate: { installationId: INSTALL, ownerUserId: ID, policyRevision: '3', policySha256: HASH,
    dailyLimitMicroUsd: '1000', monthlyLimitMicroUsd: '9007199254740993', reconciliationRequired: true, legacyLiabilityUnresolved: false,
    journalSequence: '5', journalHash: HASH, journalProjectionSha256: OTHER, clockHighWaterMs: '1791028800000' }, requests, evidence: proofs }; }
function row(table, value) {
  const definition = REVIEWED_SCHEMA.tables.find(t => t.name === table);
  const raw = Object.fromEntries(definition.columns.filter(c => POLICY.columnsFor(table).includes(c.name)).map(column => {
    const input = ['created_at', 'updated_at'].includes(column.name) ? STAMP : value[camel(column.name)];
    return [column.name, column.type === 'jsonb' ? { json: clone(input) } : input];
  }));
  return POLICY.projectRow(table, raw);
}
function rows(p) { return [row('ai_budget_gate', p.gate), ...p.requests.map(r => row('ai_request_ledger', { ...r, dispatchBinding: r.dispatchBinding ?? {} })),
  ...p.evidence.map(e => row('ai_usage_evidence', e))]; }
function collect(input) { const collector = createBackupCostCollector(INSTALL); input.forEach(value => collector.add(value)); return collector.finish(); }
function legacy() { return POLICY.projectRow('ai_usage_logs', { id: '1', user_id: ID, project_id: '7', provider: 'openai', model: 'synthetic-model',
  purpose: 'ASK', prompt_tokens: 1, completion_tokens: 2, cost_estimate: '0.0000012300', created_at: STAMP }); }
function snapshot(p = projection()) { return { major: 1, installationId: INSTALL, sequence: 5, headHash: HASH, projectionDigest: OTHER,
  clockHighWaterMs: 1791028800000, aiOff: true, budgetDay: '2026-10-04', minimumVersion: '20261003', pendingRestore: null,
  pendingMaintenance: null, legacyLiabilityUnresolved: false, requests: p.requests.map(r => ({ ...Object.fromEntries(OBLIGATION.map(k => [k, r[k]])), dispatchIntent: true })) }; }
function merge(p = projection(), changes = {}) { return { transactionId: TX, liveProjection: p, archivedProjection: null, snapshot: snapshot(p),
  budgetDay: '2026-10-03', minimumVersion: '20261002', ...changes }; }
function metadata(p = projection(), changes = {}) { return { transactionId: TX, kind: 'BACKUP', payloadSha256: HASH,
  pgProjectionDigest: maintenanceProjectionDigest(p), legacyLiabilityUnresolved: false, budgetDay: '2026-10-04', minimumVersion: '20261003', ...changes }; }
function safe(error) { assert.ok(error instanceof Error); assert.equal(error.cause, undefined);
  assert.doesNotMatch(error.message, /synthetic-secret|credential-sentinel|private-path|SELECT|TypeError/); return true; }
const rejects = fn => assert.throws(fn, safe);

test('typed V25 collector preserves exact bigint money and converts only reviewed JSON binding/evidence counters to strings', () => {
  const p = projection(); p.evidence[0].usageDimensions.units.REQUESTS = ID;
  const input = clone(rows(p));
  const r = input.find(r => r.table === 'ai_request_ledger'); for (const key of COUNTERS) r.values.dispatch_binding.json[key] = Number(r.values.dispatch_binding.json[key]);
  const e = input.find(r => r.table === 'ai_usage_evidence'); e.values.usage_dimensions.json.units.INPUT_TOKENS = 5; e.values.usage_dimensions.json.units.OUTPUT_TOKENS = 2;
  const before = clone(input); const result = collect(frozen(input));
  assert.deepEqual(result, { projection: p, legacyLiabilityUnresolved: false }); assert.deepEqual(input, before);
  assert.equal(result.projection.gate.ownerUserId, ID); assert.equal(result.projection.gate.monthlyLimitMicroUsd, ID);
  assert.equal(result.projection.evidence[0].usageDimensions.units.REQUESTS, ID);
  assert.ok(Object.isFrozen(result.projection.requests[0].dispatchBinding));
});

test('empty dispatch binding is explicit absence and cannot recreate provider authority', () => {
  const p = projection([request({ dispatchBinding: null })], []); const result = collect(rows(p));
  assert.equal(result.projection.requests[0].dispatchBinding, null);
  assert.equal(result.projection.gate.reconciliationRequired, true);
});

test('collector orders distinct request/proof identities without mutating its input', () => {
  const p = projection([request({ requestId: SECOND }), request()], [evidence({ requestId: SECOND }), evidence()]);
  const input = rows(p); const result = collect(input);
  assert.deepEqual(result.projection.requests.map(r => r.requestId), [REQUEST, SECOND]);
  assert.deepEqual(result.projection.evidence.map(r => r.requestId), [REQUEST, SECOND]);
  assert.deepEqual(input, rows(p));
});

test('absence of V25 state remains null, while legacy usage remains explicitly unresolved', () => {
  assert.deepEqual(collect([]), { projection: null, legacyLiabilityUnresolved: false });
  assert.deepEqual(collect([legacy()]), { projection: null, legacyLiabilityUnresolved: true });
  assert.equal(collect([...rows(projection()), legacy()]).legacyLiabilityUnresolved, true);
});

test('requests or usage evidence without a gate cannot fall back to an empty projection', () => {
  for (const input of [rows(projection()).slice(1), [rows(projection())[2]]]) rejects(() => collect(input));
});

for (const table of ['ai_budget_gate', 'ai_request_ledger', 'ai_usage_evidence']) test(`collector rejects extra/unknown fields in ${table}`, () => {
  const input = clone(rows(projection())); input.find(r => r.table === table).values.future_authority = 'synthetic-secret';
  rejects(() => collect(input));
});

for (const [name, change] of [
  ['unknown dispatch binding', p => { p.requests[0].dispatchBinding.extra = 'synthetic-secret'; }],
  ['unknown usage dimension', p => { p.evidence[0].usageDimensions.units.FUTURE_COST = '9'; }],
  ['fractional binding count', p => { p.requests[0].dispatchBinding.inputTokenUpperBound = 1.5; }],
  ['unsafe numeric binding', p => { p.requests[0].dispatchBinding.inputTokenUpperBound = Number(ID); }],
  ['negative usage units', p => { p.evidence[0].usageDimensions.units.INPUT_TOKENS = '-1'; }],
  ['overflow usage units', p => { p.evidence[0].usageDimensions.units.INPUT_TOKENS = '9223372036854775808'; }],
  ['missing binding counter', p => { delete p.requests[0].dispatchBinding.settingsRevision; }],
  ['foreign installation', p => { p.requests[0].installationId = 'foreign'; }],
  ['duplicate request', p => { p.requests.push(clone(p.requests[0])); }],
  ['duplicate evidence', p => { p.evidence.push(clone(p.evidence[0])); }],
  ['orphan evidence', p => { p.evidence[0].requestId = SECOND; }],
]) test(`collector rejects ${name}`, () => {
  const p = projection(); change(p); rejects(() => collect(rows(p)));
});

for (const input of [
  { table: 'future_cost_table', values: { charge: '9' } },
  { table: 'github_credentials', values: { encrypted_token: 'credential-sentinel' } },
  { table: 'ai_usage_logs', values: { future_secret: 'synthetic-secret' } },
]) test(`collector cannot silently ignore unvalidated ${input.table} rows`, () => { rejects(() => collect([input])); });

test('valid keyless preferences are policy-validated but do not become financial or activation authority', () => {
  const pref = POLICY.projectRow('user_ai_preferences', { user_id: ID, provider: 'openai', model: 'synthetic-model', created_at: STAMP, updated_at: STAMP });
  assert.deepEqual(collect([pref]), { projection: null, legacyLiabilityUnresolved: false });
  const invalid = clone(pref); invalid.values.encrypted_key = 'credential-sentinel'; rejects(() => collect([invalid]));
});

test('collector is one-use and caller mutations cannot change previously accepted financial input', () => {
  const c = createBackupCostCollector(INSTALL); const input = clone(rows(projection())); input.forEach(r => c.add(r));
  input[1].values.reserved_micro_usd = '0'; input[1].values.dispatch_binding.json.model = 'changed';
  input[2].values.usage_dimensions.json.units.INPUT_TOKENS = 999;
  assert.deepEqual(c.finish().projection, projection()); rejects(() => c.finish()); rejects(() => c.add(rows(projection())[0]));
});

test('merge reserves the greatest evidence or known liability and never substitutes zero for uncertainty', () => {
  const p = projection(); const q = projection([request({ requestId: SECOND, reservedMicroUsd: '20', liabilityFloorMicroUsd: '300', budgetDay: '2026-10-05' })], []);
  p.evidence.push(evidence({ proofSha256: HASH, actualMicroUsd: '210' }));
  const input = merge(p, { archivedProjection: q }); const before = clone(input);
  const result = buildMaintenanceMergeInputs(frozen(input));
  assert.equal(result.length, 2); assert.equal(result[0].obligations[0].reservedMicroUsd, '210');
  assert.equal(result[1].obligations[0].reservedMicroUsd, '300'); assert.equal(result[0].obligations[0].actualMicroUsd, null);
  assert.equal(result[0].obligations[0].status, 'UNKNOWN_HELD'); assert.equal(result[0].budgetDay, '2026-10-05');
  assert.equal(result[0].minimumVersion, '20261003'); assert.deepEqual(input, before);
  // This raised reservation is a conservative merge input, not permission to rewrite immutable
  // PG identity. Core/PG may safely refuse the later restore if the same UUID has another reserve.
  assert.notEqual(result[0].obligations[0].reservedMicroUsd, p.requests[0].reservedMicroUsd);
});

test('merge retains proven settlement fields without inventing a new proof or erasing a conflict floor', () => {
  const p = projection([request({ status: 'SETTLED', actualMicroUsd: '50', proofSha256: HASH, conflict: true, liabilityFloorMicroUsd: '400' })], []);
  const out = buildMaintenanceMergeInputs(merge(p))[0].obligations[0];
  assert.equal(out.reservedMicroUsd, '400'); assert.equal(out.actualMicroUsd, '50'); assert.equal(out.proofSha256, HASH);
  assert.equal(out.status, 'SETTLED'); assert.deepEqual(Object.keys(out).sort(), OBLIGATION.slice(0, 8).sort());
});

test('merge precise max bigint and deterministic live/archive transaction-derived IDs are stable', () => {
  const p = projection([request({ reservedMicroUsd: '9223372036854775807', liabilityFloorMicroUsd: '9223372036854775807' })], []);
  const input = merge(p, { archivedProjection: p, minimumVersion: '9223372036854775807' });
  const first = buildMaintenanceMergeInputs(input), second = buildMaintenanceMergeInputs(clone(input)); assert.deepEqual(first, second);
  assert.notEqual(first[0].restoreId, first[1].restoreId); assert.match(first[0].restoreId, /^[a-f0-9]{8}-[a-f0-9]{4}-5[a-f0-9]{3}-a[a-f0-9]{3}-[a-f0-9]{12}$/);
  assert.equal(first[0].minimumVersion, '9223372036854775807'); assert.equal(first[0].obligations[0].reservedMicroUsd, '9223372036854775807');
  assert.notEqual(first[0].restoreId, buildMaintenanceMergeInputs({ ...input, transactionId: EPOCH })[0].restoreId);
});

for (const [name, change] of [
  ['missing live projection', x => { x.liveProjection = null; }], ['incomplete live projection', x => { x.liveProjection.complete = false; }],
  ['foreign snapshot installation', x => { x.snapshot.installationId = 'foreign'; }],
  ['invalid day', x => { x.budgetDay = '2026-02-30'; }], ['overflow version', x => { x.minimumVersion = '9223372036854775808'; }],
  ['invalid restore transaction', x => { x.transactionId = '../private-path'; }],
]) test(`merge rejects ${name}`, () => { const x = merge(); change(x); rejects(() => buildMaintenanceMergeInputs(x)); });

test('maintenance digest binds financial rows and policy while excluding only explicit moving journal position', () => {
  const p = projection(); const expected = maintenanceProjectionDigest(p);
  const moved = clone(p); moved.gate.journalSequence = '9'; moved.gate.journalHash = OTHER;
  moved.gate.journalProjectionSha256 = HASH; moved.gate.clockHighWaterMs = '1791028800999';
  assert.equal(maintenanceProjectionDigest(moved), expected);
  for (const change of [p => { p.requests[0].liabilityFloorMicroUsd = '151'; }, p => { p.requests[0].reservedMicroUsd = '101'; },
    p => { p.evidence[0].actualMicroUsd = '181'; }, p => { p.gate.dailyLimitMicroUsd = '1001'; }, p => { p.gate.legacyLiabilityUnresolved = true; }]) {
    const changed = clone(p); change(changed); assert.notEqual(maintenanceProjectionDigest(changed), expected);
  }
});

test('maintenance verifier reads the PG state once and acknowledges only matching committed B head and obligations', async () => {
  const p = projection(); const snap = snapshot(p); const meta = metadata(p); let reads = 0;
  const verify = createMaintenanceVerifier({ installationId: INSTALL, readProjection: async () => { reads++; return p; } });
  assert.deepEqual(await verify(frozen(snap), frozen(meta)), { ...meta, verified: true }); assert.equal(reads, 1);
});

for (const [name, mutate] of [
  ['AI remains on', s => { s.aiOff = false; }], ['unfinished restore', s => { s.pendingRestore = { id: TX }; }],
  ['other installation', s => { s.installationId = 'foreign'; }], ['wrong sequence', s => { s.sequence++; }],
  ['wrong journal hash', s => { s.headHash = OTHER; }], ['wrong projection digest', s => { s.projectionDigest = HASH; }],
  ['clock beyond PG high water', s => { s.clockHighWaterMs++; }],
  ['changed row reserve', s => { s.requests[0].reservedMicroUsd = '0'; }],
  ['changed row liability floor', s => { s.requests[0].liabilityFloorMicroUsd = '0'; }],
  ['missing request', s => { s.requests = []; }], ['extra request', s => { s.requests.push({ ...s.requests[0], requestId: SECOND }); }],
  ['cleared legacy uncertainty', s => { s.legacyLiabilityUnresolved = true; }],
]) test(`maintenance verifier rejects ${name}`, async () => {
  const p = projection(), snap = snapshot(p); mutate(snap);
  const verify = createMaintenanceVerifier({ installationId: INSTALL, readProjection: async () => p });
  await assert.rejects(verify(snap, metadata(p)), safe);
});

for (const changes of [{ pgProjectionDigest: HASH }, { legacyLiabilityUnresolved: true }, { extraAuthority: 'synthetic-secret' }]) {
  test('maintenance verifier rejects changed or unknown seal metadata', async () => {
    const p = projection(); const verify = createMaintenanceVerifier({ installationId: INSTALL, readProjection: async () => p });
    await assert.rejects(verify(snapshot(p), metadata(p, changes)), safe);
  });
}

test('maintenance verifier propagates read failure as failure and never acknowledges unavailable evidence', async () => {
  let reads = 0; const verify = createMaintenanceVerifier({ installationId: INSTALL, readProjection: async () => { reads++; throw new Error('synthetic read unavailable'); } });
  await assert.rejects(verify(snapshot(), metadata())); assert.equal(reads, 1);
});

test('completion transition keeps the financial seal digest stable when RECONCILE clears its derived gate flag', () => {
  const pending = projection(), completed = clone(pending); completed.gate.reconciliationRequired = false;
  const before = clone(pending); assert.equal(maintenanceProjectionDigest(completed), maintenanceProjectionDigest(frozen(pending)));
  assert.deepEqual(pending, before); assert.deepEqual(completed.requests, pending.requests); assert.deepEqual(completed.evidence, pending.evidence);
});

test('completion transition accepts the completed PG head with the pre-completion financial receipt', async () => {
  const pending = projection(), receipt = metadata(pending), completed = clone(pending), snap = snapshot(pending);
  completed.gate.reconciliationRequired = false; completed.gate.journalSequence = '6'; completed.gate.journalHash = 'c'.repeat(64);
  completed.gate.journalProjectionSha256 = 'd'.repeat(64); completed.gate.clockHighWaterMs = '1791028800001';
  Object.assign(snap, { sequence: 6, headHash: completed.gate.journalHash, projectionDigest: completed.gate.journalProjectionSha256,
    clockHighWaterMs: 1791028800001, pendingMaintenance: null, maintenanceReceipt: receipt });
  let reads = 0; const verify = createMaintenanceVerifier({ installationId: INSTALL, readProjection: async () => { reads++; return completed; } });
  assert.deepEqual(await verify(frozen(snap), frozen(receipt)), { ...receipt, verified: true }); assert.equal(reads, 1);
});

test('completion transition refuses a cleared gate while the B maintenance seal is still pending even with a matching digest', async () => {
  const p = projection(); p.gate.reconciliationRequired = false; const receipt = metadata(p), snap = snapshot(p);
  snap.pendingMaintenance = receipt;
  const verify = createMaintenanceVerifier({ installationId: INSTALL, readProjection: async () => p });
  await assert.rejects(verify(frozen(snap), frozen(receipt)), safe);
});

test('completion transition accepts a pending seal only while reconciliation remains held', async () => {
  const p = projection(), receipt = metadata(p), snap = snapshot(p); snap.pendingMaintenance = receipt;
  const verify = createMaintenanceVerifier({ installationId: INSTALL, readProjection: async () => p });
  assert.deepEqual(await verify(frozen(snap), frozen(receipt)), { ...receipt, verified: true });
});

test('completion transition still binds persistent policy, liability, and usage evidence after the gate clears', async () => {
  const pending = projection(), receipt = metadata(pending);
  for (const change of [p => { p.gate.dailyLimitMicroUsd = '1001'; }, p => { p.gate.policyRevision = '4'; },
    p => { p.requests[0].liabilityFloorMicroUsd = '151'; }, p => { p.evidence[0].actualMicroUsd = '181'; }]) {
    const completed = clone(pending); completed.gate.reconciliationRequired = false; change(completed);
    const snap = snapshot(completed); snap.maintenanceReceipt = receipt;
    const verify = createMaintenanceVerifier({ installationId: INSTALL, readProjection: async () => completed });
    await assert.rejects(verify(snap, receipt), safe);
  }
});
