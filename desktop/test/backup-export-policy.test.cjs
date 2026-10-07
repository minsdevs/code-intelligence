'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const { createBackupExportPolicy, REVIEWED_SCHEMA, POLICY_LIMITS, BackupExportPolicyError } = require('../src/backup-export-policy.cjs');

const policy = createBackupExportPolicy(REVIEWED_SCHEMA);
const stamp = '2026-10-03T12:34:56.123456Z';
const uuid = '01234567-89ab-cdef-0123-456789abcdef';
const hash = 'a'.repeat(64);
const schema = () => structuredClone(REVIEWED_SCHEMA);
const definition = table => REVIEWED_SCHEMA.tables.find(item => item.name === table);
const overrides = {
  users: { identity_type: 'GITHUB', github_id: '101' },
  snapshots: { status: 'READY' },
  files: { analysis_status: 'LEGACY_UNMEASURED', analysis_targeted: false },
  analysis_jobs: { type: 'IMPORT', status: 'DONE' },
  analysis_job_steps: { status: 'DONE' },
  project_areas: { area_type: 'BACKEND' },
  evidences: { kind: 'FILE_LINE', created_by: 'STATIC' },
  commit_files: { change_type: 'MODIFY' },
  graph_edges: { confidence: 'CONFIRMED' },
  infra_resources: { kind: 'CONTAINER' },
  db_entities: { source: 'MIGRATION' },
  features: { detection: 'STATIC' },
  flows: { kind: 'BACKEND' },
  analysis_findings: { severity: 'HIGH', status: 'OPEN' },
  ai_messages: { role: 'USER' },
  tasks: { type: 'LEARNING', status: 'DONE', origin: 'USER' },
  pr_reviews: { origin: 'AI' },
  pr_review_comments: { severity: 'INFO' },
  user_ai_settings: { provider: 'openai' },
  finding_judgments: { status: 'ACCEPTED' },
  source_manifests: { source_kind: 'LOCAL' },
  analysis_generations: { status: 'FAILED' },
  ai_budget_gate: { policy_sha256: hash, journal_hash: hash, journal_projection_sha256: hash },
  ai_request_ledger: { plan_sha256: hash, payload_sha256: hash, wire_body_sha256: hash, status: 'RESERVED' },
  ai_usage_evidence: { proof_sha256: hash, receipt_type: 'USAGE' },
};

function fixture(table, changes = {}) {
  const row = {};
  for (const column of definition(table).columns.filter(item => policy.columnsFor(table).includes(item.name))) {
    let value;
    if (column.nullable) value = null;
    else if (column.type === 'bigint') value = '1';
    else if (column.type === 'integer') value = 1;
    else if (column.type === 'double precision') value = 0.5;
    else if (column.type === 'boolean') value = true;
    else if (column.type === 'timestamptz') value = stamp;
    else if (column.type === 'date') value = '2026-10-03';
    else if (column.type === 'uuid') value = uuid;
    else if (column.type === 'jsonb') value = { json: {} };
    else if (column.type === 'numeric') value = '0.0000012300';
    else if (column.type.startsWith('char(')) value = 'a'.repeat(Number(column.type.slice(5, -1)));
    else value = 'synthetic';
    row[column.name] = value;
  }
  return Object.assign(row, overrides[table], changes);
}
function rejects(fn, code = 'INVALID_ROW') {
  assert.throws(fn, error => {
    assert.ok(error instanceof BackupExportPolicyError);
    assert.equal(error.code, code);
    assert.equal(error.cause, undefined);
    assert.doesNotMatch(String(error), /SENTINEL|PRIVATE|injected-secret/);
    return true;
  });
}
function freezeTree(value) {
  if (value && typeof value === 'object') {
    for (const item of Object.values(value)) freezeTree(item);
    Object.freeze(value);
  }
  return value;
}

test('reviewed inventory matches every migration and current source column', () => {
  const directory = path.join(__dirname, '../../backend/src/main/resources/db/migration');
  const files = fs.readdirSync(directory).filter(name => name.endsWith('.sql')).sort();
  assert.deepEqual(files, REVIEWED_SCHEMA.migrations.map(item => item.filename).sort());
  const sourceTables = new Map();

  for (const migration of REVIEWED_SCHEMA.migrations) {
    const bytes = fs.readFileSync(path.join(directory, migration.filename));
    assert.equal(crypto.createHash('sha256').update(bytes).digest('hex'), migration.sha256);
    const sql = bytes.toString('utf8');
    for (const match of sql.matchAll(/CREATE TABLE (\w+) \(([\s\S]*?)^\);/gim)) {
      assert.equal(sourceTables.has(match[1]), false);
      sourceTables.set(match[1], [...match[2].matchAll(/^    ([a-z_][a-z_0-9]*)\s+[^\n]+/gm)]
        .map(column => column[1]).filter(name => !['check', 'primary', 'foreign', 'unique', 'constraint', 'exclude'].includes(name)));
    }
    for (const match of sql.matchAll(/^ALTER TABLE\s+(\w+)\s+([\s\S]*?);/gim)) {
      for (const column of match[2].matchAll(/ADD COLUMN\s+(\w+)\s+/gi)) {
        sourceTables.get(match[1]).push(column[1]);
      }
      for (const column of match[2].matchAll(/DROP COLUMN\s+(\w+)/gi)) {
        const columns = sourceTables.get(match[1]); const index = columns.indexOf(column[1]);
        assert.notEqual(index, -1); columns.splice(index, 1);
      }
    }
  }

  for (const table of REVIEWED_SCHEMA.tables) assert.deepEqual(table.columns.map(column => column.name), sourceTables.get(table.name));
  assert.equal(definition('users').columns.find(column => column.name === 'github_id').nullable, true);
  assert.deepEqual(definition('analysis_generations').columns.find(column => column.name === 'fencing_epoch'),
    { name: 'fencing_epoch', type: 'bigint', nullable: false, generation: 'identity-always' });
});

test('schema order is immaterial, all inputs and published constants remain untouched', () => {
  const input = schema(); input.migrations.reverse(); input.tables.reverse();
  for (const table of input.tables) table.columns.reverse();
  const before = structuredClone(input);
  const result = createBackupExportPolicy(freezeTree(input));
  assert.deepEqual(input, before);
  assert.deepEqual(result.columnsFor('notes'), ['id', 'project_id', 'title', 'content_md', 'created_at', 'updated_at']);
  assert.ok(Object.isFrozen(REVIEWED_SCHEMA.tables[0].columns[0]));
  assert.ok(Object.isFrozen(result));
  assert.throws(() => { result.columnsFor('notes').push('encrypted_key'); }, TypeError);
  assert.throws(() => { REVIEWED_SCHEMA.migrations[0].sha256 = '0'.repeat(64); }, TypeError);
});

const schemaMutations = {
  'unknown table': input => { input.tables[0].name = 'credentials_v2'; },
  'extra table': input => { input.tables.push({ name: 'sessions', columns: [] }); },
  'missing table': input => { input.tables.pop(); },
  'duplicate table': input => { input.tables[1] = input.tables[0]; },
  'unknown column': input => { input.tables[0].columns[0].name = 'refresh_token'; },
  'extra column': input => { input.tables[0].columns.push({ name: 'refresh_token', type: 'text', nullable: true, generation: 'none' }); },
  'missing column': input => { input.tables[0].columns.pop(); },
  'duplicate column': input => { input.tables[0].columns[1] = input.tables[0].columns[0]; },
  'changed type': input => { input.tables[0].columns[0].type = 'text'; },
  'type alias is not implicit approval': input => { input.tables[0].columns[0].type = 'int8'; },
  'changed nullability': input => { input.tables[0].columns[0].nullable = true; },
  'truthy nullable': input => { input.tables[0].columns[0].nullable = 'false'; },
  'changed generation': input => { input.tables[0].columns[0].generation = 'none'; },
  'column extra metadata': input => { input.tables[0].columns[0].approved = true; },
  'table extra metadata': input => { input.tables[0].allowUnknown = true; },
  'schema extra metadata': input => { input.acceptAll = true; },
  'missing migration': input => { input.migrations.pop(); },
  'extra migration': input => { input.migrations.push({ version: 26, filename: 'V26__secrets.sql', sha256: '0'.repeat(64) }); },
  'duplicate migration': input => { input.migrations[1] = input.migrations[0]; },
  'changed migration name': input => { input.migrations[0].filename = 'V1__PRIVATE.sql'; },
  'changed migration hash': input => { input.migrations[0].sha256 = '0'.repeat(64); },
  'string migration version': input => { input.migrations[0].version = '1'; },
  'unknown migration version': input => { input.migrations[0].version = 26; },
  'migration extra approval': input => { input.migrations[0].trusted = true; },
};
for (const [name, mutate] of Object.entries(schemaMutations)) {
  test(`schema rejects ${name}`, () => { const input = schema(); mutate(input); rejects(() => createBackupExportPolicy(input), 'SCHEMA_MISMATCH'); });
}

test('every pinned column rejects a changed type, including excluded credential and approval columns', () => {
  for (let table = 0; table < REVIEWED_SCHEMA.tables.length; table++) {
    for (let column = 0; column < REVIEWED_SCHEMA.tables[table].columns.length; column++) {
      const input = schema(); const item = input.tables[table].columns[column];
      item.type = item.type === 'text' ? 'boolean' : 'text';
      rejects(() => createBackupExportPolicy(input), 'SCHEMA_MISMATCH');
    }
  }
});

test('schema is copied by validation, never retained as mutable authority', () => {
  const input = schema(); const local = createBackupExportPolicy(input);
  input.tables.length = 0; input.migrations[0].sha256 = 'PRIVATE';
  assert.deepEqual(local.columnsFor('user_ai_settings'), ['id', 'user_id', 'provider', 'created_at', 'updated_at', 'model']);
  rejects(() => createBackupExportPolicy(input), 'SCHEMA_MISMATCH');
});

test('schema rejects accessors, symbols, sparse arrays, unexpected prototypes and proxies without invoking them', () => {
  let calls = 0;
  const attempts = [];
  const accessor = schema(); Object.defineProperty(accessor, 'tables', { enumerable: true, get() { calls++; return []; } }); attempts.push(accessor);
  const symbol = schema(); symbol[Symbol('PRIVATE')] = true; attempts.push(symbol);
  const sparse = schema(); delete sparse.tables[0]; attempts.push(sparse);
  const extra = schema(); extra.tables.extra = true; attempts.push(extra);
  attempts.push(Object.assign(Object.create({ PRIVATE: true }), schema()));
  attempts.push(new Proxy(schema(), { get() { calls++; throw new Error('injected-secret'); }, ownKeys() { calls++; return []; } }));
  const nested = schema(); nested.migrations[0] = new Proxy(nested.migrations[0], { getPrototypeOf() { calls++; return null; } }); attempts.push(nested);
  for (const input of attempts) rejects(() => createBackupExportPolicy(input), 'SCHEMA_MISMATCH');
  assert.equal(calls, 0);
});

const excluded = ['github_credentials', 'local_source_approvals', 'job_local_source_inputs'];
for (const table of excluded) {
  test(`${table} has no selectable columns and refuses all data before inspecting it`, () => {
    assert.deepEqual(policy.columnsFor(table), []);
    let calls = 0;
    const input = new Proxy({}, { get() { calls++; throw new Error('SENTINEL'); }, ownKeys() { calls++; return []; } });
    rejects(() => policy.projectRow(table, input), 'TABLE_EXCLUDED');
    rejects(() => policy.projectRow(table, { encrypted_token: 'SENTINEL' }), 'TABLE_EXCLUDED');
    assert.equal(calls, 0);
  });
}

test('all 50 permitted table projections accept a bounded typed synthetic row', () => {
  let count = 0;
  for (const { name } of REVIEWED_SCHEMA.tables) {
    if (excluded.includes(name)) continue;
    const input = fixture(name); const before = structuredClone(input);
    const output = policy.projectRow(name, freezeTree(input));
    assert.equal(output.table, name); assert.equal(output.policyVersion, 1);
    assert.deepEqual(output.values, before); assert.ok(Object.isFrozen(output.values));
    count++;
  }
  assert.equal(count, 50);
});

const omittedColumns = {
  users: ['local_key'],
  projects: ['local_path', 'clone_path', 'pulls_etag'],
  analysis_jobs: ['error'],
  analysis_job_steps: ['error'],
  user_ai_settings: ['encrypted_key', 'nonce', 'key_version'],
  user_ai_preferences: ['connection_state', 'revision'],
};
for (const [table, columns] of Object.entries(omittedColumns)) {
  test(`${table} never selects or consumes its omitted columns, even when names replace an allowed field`, () => {
    let calls = 0;
    for (const column of columns) {
      assert.equal(policy.columnsFor(table).includes(column), false);
      const input = fixture(table); delete input[policy.columnsFor(table)[0]];
      Object.defineProperty(input, column, { enumerable: true, get() { calls++; return 'SENTINEL'; } });
      rejects(() => policy.projectRow(table, input));
      rejects(() => policy.projectRow(table, { ...fixture(table), [column]: 'SENTINEL' }));
    }
    assert.equal(calls, 0);
  });
}

test('credential/path sentinels cannot appear in successful keyless/profile/project outputs', () => {
  for (const table of ['user_ai_settings', 'user_ai_preferences', 'users', 'projects']) {
    const raw = { ...fixture(table) };
    for (const column of omittedColumns[table]) raw[column] = 'SENTINEL_PRIVATE_VALUE';
    rejects(() => policy.projectRow(table, raw));
    const selected = {};
    for (const column of policy.columnsFor(table)) selected[column] = raw[column];
    const output = policy.projectRow(table, selected);
    assert.doesNotMatch(JSON.stringify(output), /SENTINEL_PRIVATE_VALUE/);
  }
  const ai = policy.projectRow('user_ai_settings', fixture('user_ai_settings', { model: 'custom-model' }));
  assert.equal(ai.kind, 'keyless-ai-preference');
  assert.deepEqual(ai.settings, { enabled: false, reconnectRequired: true, allowEnvironmentFallback: false });
  assert.equal(ai.values.model, 'custom-model');
  assert.deepEqual(policy.projectRow('users', fixture('users')).identity, { authorityIncluded: false, ownerBindingRequired: true });
  assert.deepEqual(policy.projectRow('projects', fixture('projects')).sourceAccess, { pathAuthorityIncluded: false });
});

test('V24 pins all seven source columns while exposing only five keyless preference fields', () => {
  assert.deepEqual(REVIEWED_SCHEMA.migrations.find(migration => migration.version === 24), {
    version: 24, filename: 'V24__ai_connection_preferences.sql',
    sha256: '5c77edd63d6dc98f04d0b91278b365bd0413688731a52e7b87869a9db83cbad3',
  });
  assert.deepEqual(definition('user_ai_preferences').columns, [
    { name: 'user_id', type: 'bigint', nullable: false, generation: 'none' },
    { name: 'provider', type: 'text', nullable: true, generation: 'none' },
    { name: 'model', type: 'text', nullable: true, generation: 'none' },
    { name: 'connection_state', type: 'text', nullable: false, generation: 'none' },
    { name: 'revision', type: 'bigint', nullable: false, generation: 'none' },
    { name: 'created_at', type: 'timestamptz', nullable: false, generation: 'none' },
    { name: 'updated_at', type: 'timestamptz', nullable: false, generation: 'none' },
  ]);
  assert.deepEqual(policy.columnsFor('user_ai_preferences'), ['user_id', 'provider', 'model', 'created_at', 'updated_at']);
  assert.ok(Object.isFrozen(policy.columnsFor('user_ai_preferences')));
});

test('V24 preferences preserve allowed values exactly with fixed OFF and reconnect annotations', () => {
  for (const provider of [null, 'openai', 'gemini']) {
    for (const model of provider === null ? [null] : [null, '', '  custom-model/한글  ']) {
      const input = fixture('user_ai_preferences', { user_id: '9007199254740993', provider, model });
      const before = structuredClone(input);
      const output = policy.projectRow('user_ai_preferences', freezeTree(input));
      assert.deepEqual(output, {
        policyVersion: 1, table: 'user_ai_preferences', kind: 'keyless-ai-preference', values: before,
        settings: { enabled: false, reconnectRequired: true, allowEnvironmentFallback: false },
      });
      assert.deepEqual(input, before);
      assert.notEqual(output.values, input);
      assert.ok(Object.isFrozen(output));
      assert.ok(Object.isFrozen(output.values));
      assert.ok(Object.isFrozen(output.settings));
      assert.throws(() => { output.settings.enabled = true; }, TypeError);
      assert.equal(Object.hasOwn(output.values, 'connection_state'), false);
      assert.equal(Object.hasOwn(output.values, 'revision'), false);
    }
  }
});

test('V24 provider enums, SQL nullability and model/provider constraints reject invalid rows', () => {
  for (const provider of ['anthropic', 'OPENAI', 'Gemini', '', 'openai ', 'openai\n', 'gemini\0', 1, false, {}, undefined]) {
    rejects(() => policy.projectRow('user_ai_preferences', fixture('user_ai_preferences', { provider })));
  }
  for (const model of ['', 'custom-model', '  ', undefined, 1, {}, false]) {
    rejects(() => policy.projectRow('user_ai_preferences', fixture('user_ai_preferences', { provider: null, model })));
  }
  for (const column of ['user_id', 'created_at', 'updated_at']) {
    rejects(() => policy.projectRow('user_ai_preferences', fixture('user_ai_preferences', { [column]: null })));
  }
  for (const column of policy.columnsFor('user_ai_preferences')) {
    const missing = fixture('user_ai_preferences'); delete missing[column];
    rejects(() => policy.projectRow('user_ai_preferences', missing));
  }
  assert.equal(policy.projectRow('user_ai_preferences', fixture('user_ai_preferences')).values.provider, null);
  assert.equal(policy.projectRow('user_ai_preferences', fixture('user_ai_preferences')).values.model, null);
});

test('V24 authorization states, revisions and credential-shaped extras are never consumed as preferences', () => {
  for (const connection_state of ['OFF', 'ENABLED', 'RECONNECT_REQUIRED', 'UNKNOWN', null, undefined]) {
    rejects(() => policy.projectRow('user_ai_preferences', fixture('user_ai_preferences', { connection_state })));
  }
  for (const revision of ['0', '1', '9223372036854775807', '-1', null, undefined, 0, 1n]) {
    rejects(() => policy.projectRow('user_ai_preferences', fixture('user_ai_preferences', { revision })));
  }
  let calls = 0;
  for (const column of ['connection_state', 'revision', 'encrypted_key', 'nonce', 'key_version', 'api_key', 'enabled']) {
    const row = fixture('user_ai_preferences');
    Object.defineProperty(row, column, { enumerable: true, get() { calls++; throw new Error('injected-secret'); } });
    rejects(() => policy.projectRow('user_ai_preferences', row));
  }
  assert.equal(calls, 0);
});

test('V24 selected preference output cannot carry source ENABLED or approval revision authority', () => {
  for (const connection_state of ['OFF', 'ENABLED', 'RECONNECT_REQUIRED']) {
    const source = fixture('user_ai_preferences', { provider: 'openai', model: 'custom-model',
      connection_state, revision: '9223372036854775807' });
    rejects(() => policy.projectRow('user_ai_preferences', source));
    const selected = Object.fromEntries(policy.columnsFor('user_ai_preferences').map(column => [column, source[column]]));
    const output = policy.projectRow('user_ai_preferences', selected);
    assert.deepEqual(output.settings, { enabled: false, reconnectRequired: true, allowEnvironmentFallback: false });
    assert.deepEqual(output.values, fixture('user_ai_preferences', { provider: 'openai', model: 'custom-model' }));
    assert.doesNotMatch(JSON.stringify(output), /connection_state|revision|9223372036854775807|ENABLED/);
    assert.equal(source.connection_state, connection_state);
    assert.equal(source.revision, '9223372036854775807');
  }
});

test('V24 requires exact source descriptors for every column including omitted approval fields', () => {
  for (const column of definition('user_ai_preferences').columns) {
    for (const change of ['type', 'nullable', 'generation', 'name', 'missing']) {
      const input = schema();
      const columns = input.tables.find(table => table.name === 'user_ai_preferences').columns;
      const index = columns.findIndex(item => item.name === column.name);
      if (change === 'type') columns[index].type = column.type === 'text' ? 'boolean' : 'text';
      else if (change === 'nullable') columns[index].nullable = !column.nullable;
      else if (change === 'generation') columns[index].generation = 'identity-always';
      else if (change === 'name') columns[index].name = `${column.name}_unreviewed`;
      else columns.splice(index, 1);
      rejects(() => createBackupExportPolicy(input), 'SCHEMA_MISMATCH');
    }
  }
  const extra = schema();
  extra.tables.find(table => table.name === 'user_ai_preferences').columns.push({
    name: 'api_key', type: 'text', nullable: true, generation: 'none',
  });
  rejects(() => createBackupExportPolicy(extra), 'SCHEMA_MISMATCH');
});

test('V24 migration bytes and identity cannot be silently changed or omitted', () => {
  for (const change of ['hash', 'filename', 'version', 'missing']) {
    const input = schema();
    const index = input.migrations.findIndex(migration => migration.version === 24);
    if (change === 'hash') input.migrations[index].sha256 = '0'.repeat(64);
    else if (change === 'filename') input.migrations[index].filename = 'V24__unreviewed.sql';
    else if (change === 'version') input.migrations[index].version = 26;
    else input.migrations.splice(index, 1);
    rejects(() => createBackupExportPolicy(input), 'SCHEMA_MISMATCH');
  }
});

test('same-user legacy settings and V24 preferences remain independent keyless rows without implicit precedence', () => {
  const legacy = fixture('user_ai_settings', { user_id: '7', provider: 'openai', model: 'legacy-choice' });
  const preference = fixture('user_ai_preferences', { user_id: '7', provider: 'gemini', model: 'preference-choice' });
  const before = policy.projectRow('user_ai_preferences', preference);
  const settings = policy.projectRow('user_ai_settings', legacy);
  const after = policy.projectRow('user_ai_preferences', preference);
  assert.deepEqual(before, after);
  assert.deepEqual(settings.values, legacy);
  assert.deepEqual(after.values, preference);
  assert.deepEqual(settings.settings, { enabled: false, reconnectRequired: true, allowEnvironmentFallback: false });
  assert.deepEqual(after.settings, settings.settings);
});

const costTables = ['ai_budget_gate', 'ai_request_ledger', 'ai_usage_evidence'];
const costSafety = { enabled: false, dispatchAllowed: false, activationAuthorityIncluded: false, reconciliationRequired: true };
const obligationAccounting = { obligationData: true, conservativeMergeRequired: true, replaceJournal: false, releaseLiabilityAllowed: false };

test('V25 pins three complete financial tables and selects all 44 obligation or diagnostic columns', () => {
  assert.deepEqual(REVIEWED_SCHEMA.migrations.find(migration => migration.version === 25), {
    version: 25, filename: 'V25__ai_cost_reservations.sql',
    sha256: 'b5d547a4f0a24f263b8cf53983c57e446e0c9ee90a8f5c64e347e6ec89b1f1ec',
  });
  const names = {
    ai_budget_gate: ['installation_id', 'owner_user_id', 'policy_revision', 'policy_sha256', 'daily_limit_micro_usd',
      'monthly_limit_micro_usd', 'reconciliation_required', 'legacy_liability_unresolved', 'journal_sequence',
      'journal_hash', 'journal_projection_sha256', 'clock_high_water_ms', 'created_at', 'updated_at'],
    ai_request_ledger: ['request_id', 'installation_id', 'owner_user_id', 'project_id', 'snapshot_id', 'approval_id',
      'plan_sha256', 'payload_sha256', 'wire_body_sha256', 'dispatch_binding', 'budget_day', 'price_version',
      'reserved_micro_usd', 'status', 'actual_micro_usd', 'proof_sha256', 'liability_floor_micro_usd', 'conflict',
      'journal_sequence', 'journal_hash', 'created_at', 'updated_at'],
    ai_usage_evidence: ['request_id', 'proof_sha256', 'main_epoch', 'receipt_type', 'provider_request_id',
      'usage_dimensions', 'actual_micro_usd', 'created_at'],
  };
  assert.equal(Object.values(names).reduce((count, columns) => count + columns.length, 0), 44);
  for (const table of costTables) {
    assert.deepEqual(definition(table).columns.map(column => column.name), names[table]);
    assert.deepEqual(policy.columnsFor(table), names[table]);
    assert.ok(definition(table).columns.every(column => column.generation === 'none'));
  }
  assert.deepEqual(definition('ai_request_ledger').columns.find(column => column.name === 'budget_day'),
    { name: 'budget_day', type: 'date', nullable: false, generation: 'none' });
  assert.deepEqual(definition('ai_request_ledger').columns.filter(column => column.nullable).map(column => column.name),
    ['owner_user_id', 'project_id', 'snapshot_id', 'approval_id', 'actual_micro_usd', 'proof_sha256', 'journal_sequence', 'journal_hash']);
  assert.deepEqual(definition('ai_usage_evidence').columns.filter(column => column.nullable).map(column => column.name), ['provider_request_id']);
  assert.equal(definition('ai_budget_gate').columns.some(column => column.nullable), false);
});

test('V25 migration identity and every new column descriptor fail closed on changes', () => {
  for (const change of ['hash', 'filename', 'version', 'missing']) {
    const input = schema(), index = input.migrations.findIndex(migration => migration.version === 25);
    if (change === 'hash') input.migrations[index].sha256 = '0'.repeat(64);
    else if (change === 'filename') input.migrations[index].filename = 'V25__unreviewed.sql';
    else if (change === 'version') input.migrations[index].version = 0;
    else input.migrations.splice(index, 1);
    rejects(() => createBackupExportPolicy(input), 'SCHEMA_MISMATCH');
  }
  for (const table of costTables) {
    for (const column of definition(table).columns) {
      for (const change of ['type', 'nullable', 'generation', 'name', 'missing']) {
        const input = schema();
        const columns = input.tables.find(item => item.name === table).columns;
        const index = columns.findIndex(item => item.name === column.name);
        if (change === 'type') columns[index].type = column.type === 'text' ? 'boolean' : 'text';
        else if (change === 'nullable') columns[index].nullable = !column.nullable;
        else if (change === 'generation') columns[index].generation = 'identity-always';
        else if (change === 'name') columns[index].name = `${column.name}_unreviewed`;
        else columns.splice(index, 1);
        rejects(() => createBackupExportPolicy(input), 'SCHEMA_MISMATCH');
      }
    }
    const extra = schema();
    extra.tables.find(item => item.name === table).columns.push({ name: 'activation_capability', type: 'text', nullable: false, generation: 'none' });
    rejects(() => createBackupExportPolicy(extra), 'SCHEMA_MISMATCH');
  }
});

test('V25 budget gate preserves limits and historical flags without restoring activation or journal authority', () => {
  for (const reconciliation_required of [true, false]) {
    for (const legacy_liability_unresolved of [true, false]) {
      const input = fixture('ai_budget_gate', { reconciliation_required, legacy_liability_unresolved,
        owner_user_id: '9007199254740993', daily_limit_micro_usd: '9223372036854775807',
        monthly_limit_micro_usd: '9007199254740995', policy_revision: '9007199254740997',
        journal_sequence: '9007199254740999', clock_high_water_ms: '9223372036854775807' });
      const before = structuredClone(input);
      const output = policy.projectRow('ai_budget_gate', freezeTree(input));
      assert.equal(output.kind, 'budget-diagnostic');
      assert.deepEqual(output.values, before);
      assert.deepEqual(output.safety, costSafety);
      assert.deepEqual(output.accounting,
        { historicalProjection: true, journalAuthorityIncluded: false, restoreMode: 'PREFERENCES_AND_DIAGNOSTICS' });
      assert.deepEqual(input, before);
    }
  }
});

test('V25 preserves RESERVED DISPATCHED UNKNOWN_HELD and SETTLED obligations without resuming or releasing them', () => {
  for (const status of ['RESERVED', 'DISPATCHED', 'UNKNOWN_HELD', 'SETTLED']) {
    const input = fixture('ai_request_ledger', { status, owner_user_id: '9007199254740993',
      project_id: '9223372036854775807', snapshot_id: '9007199254740997', approval_id: uuid,
      reserved_micro_usd: '9223372036854775807', liability_floor_micro_usd: '9007199254740999', conflict: true,
      actual_micro_usd: status === 'SETTLED' ? '9007199254740995' : null,
      proof_sha256: status === 'SETTLED' ? hash : null, journal_sequence: '9223372036854775807', journal_hash: hash });
    const output = policy.projectRow('ai_request_ledger', freezeTree(input));
    assert.equal(output.kind, 'financial-obligation');
    assert.deepEqual(output.values, input);
    assert.deepEqual(output.accounting, obligationAccounting);
    assert.deepEqual(output.safety, costSafety);
    assert.equal(output.values.approval_id, uuid);
    assert.equal(Object.hasOwn(output.values, 'requestPlanToken'), false);
  }
});

test('V25 preserves usage receipts and proven-not-sent records as evidence without trusting epoch or proof references', () => {
  for (const receipt_type of ['USAGE', 'PROVEN_NOT_SENT']) {
    const input = fixture('ai_usage_evidence', { receipt_type, main_epoch: '  synthetic historical epoch  ',
      provider_request_id: 'fixture-request-reference', actual_micro_usd: receipt_type === 'USAGE' ? '9223372036854775807' : '0',
      usage_dimensions: { json: { input_tokens: '9007199254740993', output_tokens: '7', cached: false } } });
    const output = policy.projectRow('ai_usage_evidence', freezeTree(input));
    assert.equal(output.kind, 'financial-evidence');
    assert.deepEqual(output.values, input);
    assert.deepEqual(output.accounting, obligationAccounting);
    assert.deepEqual(output.safety, costSafety);
    assert.notEqual(output.values.usage_dimensions.json, input.usage_dimensions.json);
  }
});

test('V25 all constrained counters and amounts use exact nonnegative int64 strings without coercion', () => {
  const fields = {
    ai_budget_gate: ['policy_revision', 'daily_limit_micro_usd', 'monthly_limit_micro_usd', 'journal_sequence', 'clock_high_water_ms'],
    ai_request_ledger: ['reserved_micro_usd', 'actual_micro_usd', 'liability_floor_micro_usd', 'journal_sequence'],
    ai_usage_evidence: ['actual_micro_usd'],
  };
  for (const [table, columns] of Object.entries(fields)) {
    for (const column of columns) {
      const base = table === 'ai_request_ledger' ? { status: 'SETTLED', actual_micro_usd: '1', proof_sha256: hash } : {};
      for (const value of ['0', '9007199254740993', '9223372036854775807']) {
        assert.equal(policy.projectRow(table, fixture(table, { ...base, [column]: value })).values[column], value);
      }
      for (const value of [-1, 0, 9007199254740993, 1n, '-1', '01', '+1', '1e2', '1.0', ' 1', '1\n',
        '9223372036854775808', '-9223372036854775808']) {
        rejects(() => policy.projectRow(table, fixture(table, { ...base, [column]: value })));
      }
    }
  }
  for (const owner_user_id of ['0', '-1']) rejects(() => policy.projectRow('ai_budget_gate', fixture('ai_budget_gate', { owner_user_id })));
});

test('V25 financial references remain nullable historical IDs rather than inventing ownership or missing debt', () => {
  for (const value of [null, '0', '-9223372036854775808', '9223372036854775807']) {
    const input = fixture('ai_request_ledger', { owner_user_id: value, project_id: value, snapshot_id: value });
    assert.deepEqual(policy.projectRow('ai_request_ledger', input).values, input);
  }
  const receipt = fixture('ai_usage_evidence', { provider_request_id: null });
  assert.deepEqual(policy.projectRow('ai_usage_evidence', receipt).values, receipt);
});

test('V25 date projection preserves a canonical calendar day and refuses time zones or lossy Date coercion', () => {
  for (const budget_day of ['0001-01-01', '2000-02-29', '2024-02-29', '2026-10-03', '9999-12-31']) {
    assert.equal(policy.projectRow('ai_request_ledger', fixture('ai_request_ledger', { budget_day })).values.budget_day, budget_day);
  }
  for (const budget_day of [new Date(), 0, null, '0000-01-01', '10000-01-01', '1900-02-29', '2026-02-29',
    '2026-04-31', '2026-13-01', '2026-00-01', '2026-01-00', '2026-1-01', '2026-10-03T00:00:00Z',
    '2026-10-03+00:00', '2026-10-03 BC', 'infinity', ' 2026-10-03',
    ...['\n', '\r', '\u2028', '\u2029'].map(suffix => `2026-10-03${suffix}`)]) {
    rejects(() => policy.projectRow('ai_request_ledger', fixture('ai_request_ledger', { budget_day })));
  }
});

test('V25 proof policy payload and journal hash fields reject noncanonical strings', () => {
  for (const table of costTables) {
    const base = table === 'ai_request_ledger' ? { status: 'SETTLED', actual_micro_usd: '1', proof_sha256: hash } : {};
    for (const { name } of definition(table).columns.filter(column => column.name.endsWith('_sha256') || column.name === 'journal_hash')) {
      for (const value of ['', 'a'.repeat(63), 'a'.repeat(65), 'A'.repeat(64), 'g'.repeat(64), 1,
        ...['\n', '\r', '\u2028', '\u2029'].map(suffix => `${hash}${suffix}`)]) {
        rejects(() => policy.projectRow(table, fixture(table, { ...base, [name]: value })));
      }
    }
  }
});

test('V25 refuses contradictory settlement and proven-not-sent values without guessing a repair', () => {
  for (const status of ['RESERVED', 'DISPATCHED', 'UNKNOWN_HELD', 'SETTLED']) {
    for (const actual_micro_usd of [null, '0']) {
      for (const proof_sha256 of [null, hash]) {
        const input = fixture('ai_request_ledger', { status, actual_micro_usd, proof_sha256 });
        const valid = status === 'SETTLED' ? actual_micro_usd !== null && proof_sha256 !== null
          : actual_micro_usd === null && proof_sha256 === null;
        if (valid) assert.deepEqual(policy.projectRow('ai_request_ledger', input).values, input);
        else rejects(() => policy.projectRow('ai_request_ledger', input));
      }
    }
  }
  for (const status of ['QUEUED', 'CANCELLED', 'settled', '', 'SETTLED\n']) {
    rejects(() => policy.projectRow('ai_request_ledger', fixture('ai_request_ledger', { status })));
  }
  for (const receipt_type of ['NOT_SENT', 'CANCELLED', '', 'USAGE\n']) {
    rejects(() => policy.projectRow('ai_usage_evidence', fixture('ai_usage_evidence', { receipt_type })));
  }
  rejects(() => policy.projectRow('ai_usage_evidence', fixture('ai_usage_evidence', { receipt_type: 'PROVEN_NOT_SENT', actual_micro_usd: '1' })));
});

test('V25 obligation metadata must be a JSON object with exactly preserved bounded values and safe ownership', () => {
  for (const [table, column] of [['ai_request_ledger', 'dispatch_binding'], ['ai_usage_evidence', 'usage_dimensions']]) {
    const metadata = { provider: 'fixture-provider', dimensions: { tokens: '9007199254740993', ratio: 0.5 }, tags: [true, null, '  값  '] };
    const output = policy.projectRow(table, fixture(table, { [column]: { json: metadata } }));
    assert.deepEqual(output.values[column].json, metadata);
    assert.notEqual(output.values[column].json.dimensions, metadata.dimensions);
    metadata.dimensions.tokens = 'changed';
    assert.equal(output.values[column].json.dimensions.tokens, '9007199254740993');
    assert.ok(Object.isFrozen(output.values[column].json.tags));
    for (const json of [null, [], 'object', true, 1, { unsafe: 9007199254740993 }, { bad: NaN }, { bad: 1n }]) {
      rejects(() => policy.projectRow(table, fixture(table, { [column]: { json } })));
    }
    rejects(() => policy.projectRow(table, fixture(table, { [column]: null })));
  }
});

test('V25 missing obligation fields and opaque credentials approval or activation extras are rejected before value access', () => {
  let calls = 0;
  for (const table of costTables) {
    for (const column of policy.columnsFor(table)) {
      const row = fixture(table); delete row[column];
      rejects(() => policy.projectRow(table, row));
    }
    for (const column of ['api_key', 'requestPlanToken', 'activation_capability', 'trusted_enrollment', 'authorization',
      'request_body', 'prompt', 'encrypted_key', 'nonce', 'epoch_key']) {
      const row = fixture(table);
      Object.defineProperty(row, column, { enumerable: true, get() { calls++; throw new Error('injected-secret'); } });
      Object.defineProperty(row, policy.columnsFor(table)[0], { enumerable: true, get() { calls++; throw new Error('injected-secret'); } });
      rejects(() => policy.projectRow(table, row));
    }
  }
  assert.equal(calls, 0);
});

test('V25 nested financial metadata refuses proxy and getter execution without leaking their values', () => {
  let calls = 0;
  const bad = () => { calls++; throw new Error('injected-secret'); };
  const accessor = {}; Object.defineProperty(accessor, 'detail', { enumerable: true, get: bad });
  const proxy = new Proxy({}, { ownKeys: bad, getPrototypeOf: bad, get: bad });
  for (const [table, column] of [['ai_request_ledger', 'dispatch_binding'], ['ai_usage_evidence', 'usage_dimensions']]) {
    for (const json of [accessor, proxy]) rejects(() => policy.projectRow(table, fixture(table, { [column]: { json } })));
  }
  assert.equal(calls, 0);
});

test('V25 OFF merge and evidence annotations are owned frozen data and cannot be overridden by a caller', () => {
  for (const table of costTables) {
    const row = fixture(table);
    const output = policy.projectRow(table, row);
    assert.ok(Object.isFrozen(output)); assert.ok(Object.isFrozen(output.values));
    assert.ok(Object.isFrozen(output.safety)); assert.ok(Object.isFrozen(output.accounting));
    assert.throws(() => { output.safety.enabled = true; }, TypeError);
    assert.throws(() => { output.accounting.releaseLiabilityAllowed = true; }, TypeError);
    rejects(() => policy.projectRow(table, { ...row, safety: { enabled: true } }));
    rejects(() => policy.projectRow(table, { ...row, accounting: { replaceJournal: true } }));
  }
});

test('V25 arbitrary JSON metadata is preserved without claiming complete secret scanning or activation enforcement', () => {
  for (const [table, column] of [['ai_request_ledger', 'dispatch_binding'], ['ai_usage_evidence', 'usage_dimensions']]) {
    // A malformed historical producer may have put free text in JSON. Projection is not a secret scanner.
    const metadata = { comment: 'SENTINEL manually pasted into historical metadata', enabled: true, reconciled: true };
    const output = policy.projectRow(table, fixture(table, { [column]: { json: metadata } }));
    assert.deepEqual(output.values[column].json, metadata);
    assert.deepEqual(output.safety, costSafety);
    assert.equal(Object.hasOwn(output, 'credentialFree'), false);
    assert.equal(Object.hasOwn(output, 'reconciled'), false);
  }
});

test('notes, references, tasks, goals, learning and adjudication retain exact IDs, text, flags and timestamps', () => {
  const text = '  # 원문 🧭\r\n\t[ref](node:9007199254740993)\n\\literal \\"quoted\\"  \n';
  const cases = [
    ['notes', { id: '9007199254740993', content_md: text, title: '  제목  ' }],
    ['note_references', { id: '9223372036854775807', subject_id: '9007199254740993', raw_target: text, label: '' }],
    ['tasks', { id: '9007199254740993', title: '  task  ', description: text, source_finding_id: '9007199254740995' }],
    ['task_goals', { id: '9007199254740997', task_id: '9007199254740993', seq: 7, content: text, done: true }],
    ['learning_records', { id: '9007199254740999', task_id: '9007199254740993', note: text }],
    ['finding_judgments', { reason: text, status: 'FALSE_POSITIVE' }],
  ];
  for (const [table, change] of cases) {
    const input = fixture(table, change); const expected = structuredClone(input);
    const output = policy.projectRow(table, freezeTree(input));
    assert.deepEqual(output.values, expected); assert.deepEqual(input, expected);
  }
  assert.equal(policy.projectRow('notes', fixture('notes', { content_md: '' })).values.content_md, '');
});

test('preserved arbitrary user text is not advertised or silently rewritten as secret-free', () => {
  const literal = 'SENTINEL manually pasted into a private note';
  const output = policy.projectRow('notes', fixture('notes', { content_md: literal }));
  assert.equal(output.values.content_md, literal);
  assert.equal(Object.hasOwn(output, 'credentialFree'), false);
});

for (const status of ['QUEUED', 'RUNNING', 'CANCELLING']) {
  test(`active ${status} job is refused`, () => rejects(() => policy.projectRow('analysis_jobs', fixture('analysis_jobs', { status })), 'ACTIVE_JOB'));
}
test('active step refused; failed jobs and pending historical steps are non-resumable history', () => {
  rejects(() => policy.projectRow('analysis_job_steps', fixture('analysis_job_steps', { status: 'RUNNING' })), 'ACTIVE_JOB');
  for (const status of ['DONE', 'FAILED', 'CANCELLED']) {
    const output = policy.projectRow('analysis_jobs', fixture('analysis_jobs', { status }));
    assert.deepEqual(output.execution, { resumable: false, dispatchAllowed: false });
    assert.equal(output.values.status, status); assert.equal(Object.hasOwn(output.values, 'error'), false);
  }
  const step = policy.projectRow('analysis_job_steps', fixture('analysis_job_steps', { status: 'PENDING', attempt: 4 }));
  assert.deepEqual(step.execution, { resumable: false, dispatchAllowed: false });
  assert.equal(step.values.attempt, 4);
});

for (const [table, field] of [['tasks', 'status'], ['analysis_jobs', 'status'], ['analysis_job_steps', 'status'],
  ['snapshots', 'status'], ['finding_judgments', 'status'], ['user_ai_settings', 'provider'],
  ['projects', 'source_type'], ['users', 'identity_type'], ['source_manifests', 'source_kind']]) {
  test(`${table}.${field} refuses unknown states`, () => rejects(() => policy.projectRow(table, fixture(table, { [field]: 'FUTURE_PRIVATE' }))));
}

test('legacy usage preserves nullable exact decimals without becoming a safety ledger or settled proof', () => {
  for (const cost_estimate of [null, '0', '0.0000012300', '123456789012345678901234567890.123456']) {
    const output = policy.projectRow('ai_usage_logs', fixture('ai_usage_logs', { cost_estimate }));
    assert.equal(output.values.cost_estimate, cost_estimate);
    assert.deepEqual(output.accounting, { authoritative: false, reconciliationRequired: true });
    assert.equal(Object.hasOwn(output.values, 'request_uuid'), false);
  }
  for (const cost of [1.23, 'NaN', 'Infinity', '1e3', '01.2', ' 1.2', '1.', '1\n', '1'.repeat(257)]) {
    rejects(() => policy.projectRow('ai_usage_logs', fixture('ai_usage_logs', { cost_estimate: cost })));
  }
});

test('signed int64 IDs preserve values beyond JS safe integer precision; noncanonical/lossy inputs fail', () => {
  for (const id of ['0', '9007199254740993', '9223372036854775807', '-9223372036854775808']) {
    assert.equal(policy.projectRow('notes', fixture('notes', { id })).values.id, id);
  }
  for (const id of [1, 9007199254740993, 1n, '01', '+1', '-0', '1.0', '1e2', ' 1', '1\n', '',
    '9223372036854775808', '-9223372036854775809']) rejects(() => policy.projectRow('notes', fixture('notes', { id })));
});

test('SQL NULL, empty text and JSON null are distinct, and required fields cannot disappear', () => {
  const sql = policy.projectRow('ai_messages', fixture('ai_messages', { context: null }));
  const json = policy.projectRow('ai_messages', fixture('ai_messages', { context: { json: null } }));
  assert.equal(sql.values.context, null); assert.deepEqual(json.values.context, { json: null });
  assert.notEqual(JSON.stringify(sql), JSON.stringify(json));
  const ref = fixture('note_references', { label: '', subject_id: null });
  assert.deepEqual(policy.projectRow('note_references', ref).values, ref);
  for (const value of [null, undefined]) rejects(() => policy.projectRow('notes', fixture('notes', { content_md: value })));
  const missing = fixture('notes'); delete missing.content_md; rejects(() => policy.projectRow('notes', missing));
  rejects(() => policy.projectRow('notes', { ...fixture('notes'), future_token: 'SENTINEL' }));
  rejects(() => policy.projectRow('graph_nodes', fixture('graph_nodes', { metadata: {} })));
});

test('microsecond timestamp strings survive exactly; invalid dates, timezone variants and Date coercion fail', () => {
  for (const created_at of [stamp, '2024-02-29T23:59:59.000001Z', '2000-02-29T00:00:00Z']) {
    assert.equal(policy.projectRow('notes', fixture('notes', { created_at })).values.created_at, created_at);
  }
  for (const created_at of [new Date(), 0, '1900-02-29T00:00:00Z', '2026-02-29T00:00:00Z',
    '2026-04-31T00:00:00Z', '2026-00-01T00:00:00Z', '2026-01-00T00:00:00Z', '0000-01-01T00:00:00Z',
    '2026-10-03T24:00:00Z', '2026-10-03T00:60:00Z', '2026-10-03T00:00:60Z', '2026-10-03T00:00:00+00:00',
    '2026-10-03T00:00:00.1234567Z', `${stamp}\n`]) rejects(() => policy.projectRow('notes', fixture('notes', { created_at })));
});

test('integers, booleans, UUIDs, retained-source bounds and generation state are validated without coercion', () => {
  for (const seq of ['1', 1.5, NaN, Infinity, -0, 2147483648]) rejects(() => policy.projectRow('task_goals', fixture('task_goals', { seq })));
  for (const done of [0, 1, 'true', null]) rejects(() => policy.projectRow('task_goals', fixture('task_goals', { done })));
  rejects(() => policy.projectRow('projects', fixture('projects', { current_generation_id: uuid, current_snapshot_id: null })));
  rejects(() => policy.projectRow('source_manifests', fixture('source_manifests', { id: uuid.toUpperCase() })));
  rejects(() => policy.projectRow('source_blobs', fixture('source_blobs', { sha256: 'g'.repeat(64) })));
  rejects(() => policy.projectRow('source_blobs', fixture('source_blobs', { byte_size: '2097153' })));
  rejects(() => policy.projectRow('source_manifests', fixture('source_manifests', { file_count: 50001 })));
  rejects(() => policy.projectRow('source_manifests', fixture('source_manifests', { byte_size: '-1' })));
  rejects(() => policy.projectRow('snapshots', fixture('snapshots', { source_contract_version: 2 })));
  rejects(() => policy.projectRow('source_manifests', fixture('source_manifests', { contract_version: 2 })));
  rejects(() => policy.projectRow('analysis_generations', fixture('analysis_generations', { status: 'COMMITTED', committed_at: null })));
  rejects(() => policy.projectRow('analysis_generations', fixture('analysis_generations', { status: 'FAILED', committed_at: stamp })));
  assert.equal(policy.projectRow('analysis_generations', fixture('analysis_generations', { status: 'COMMITTED', committed_at: stamp })).values.committed_at, stamp);
});

test('nested JSON is copied and frozen; shared input nodes do not become shared output authority', () => {
  const shared = { text: '원문', numbers: [1, 0.5, true, null] };
  const input = fixture('graph_nodes', { metadata: { json: { left: shared, right: shared } } });
  const output = policy.projectRow('graph_nodes', input);
  assert.deepEqual(output.values.metadata, input.metadata);
  assert.notEqual(output.values.metadata, input.metadata);
  assert.notEqual(output.values.metadata.json.left, shared);
  assert.notEqual(output.values.metadata.json.left, output.values.metadata.json.right);
  shared.text = 'changed'; shared.numbers.push(2);
  assert.equal(output.values.metadata.json.left.text, '원문');
  assert.deepEqual(output.values.metadata.json.left.numbers, [1, 0.5, true, null]);
  assert.ok(Object.isFrozen(output.values.metadata.json.left.numbers));
  assert.throws(() => { output.values.metadata.json.left.text = 'change'; }, TypeError);
});

test('literal JSON __proto__ keys remain data without polluting prototypes', () => {
  const json = JSON.parse('{"__proto__":{"polluted":true},"constructor":"data"}');
  const output = policy.projectRow('graph_nodes', fixture('graph_nodes', { metadata: { json } }));
  assert.equal(Object.getPrototypeOf(output.values.metadata.json), Object.prototype);
  assert.ok(Object.hasOwn(output.values.metadata.json, '__proto__'));
  assert.equal(output.values.metadata.json.__proto__.polluted, true);
  assert.equal({}.polluted, undefined);
});

test('nested JSON refuses cycles, unsafe numbers, functions, symbols, nonplain values and sparse arrays', () => {
  const cycle = {}; cycle.self = cycle;
  const sparse = []; sparse.length = 1;
  const nonenumerable = {}; Object.defineProperty(nonenumerable, 'hidden', { value: 'SENTINEL' });
  for (const json of [cycle, sparse, undefined, 9007199254740993, NaN, Infinity, -0, 1n, Symbol('secret'),
    () => {}, new Date(), new Map(), new Set(), Buffer.from('PRIVATE'), /regex/, nonenumerable,
    { a: undefined }, { toJSON() { throw new Error('injected-secret'); } }]) {
    rejects(() => policy.projectRow('graph_nodes', fixture('graph_nodes', { metadata: { json } })));
  }
});

test('row/nested accessors and proxies cannot invoke code or leak values into errors', () => {
  let calls = 0;
  const bad = () => { calls++; throw new Error('injected-secret'); };
  const accessor = fixture('notes'); Object.defineProperty(accessor, 'title', { enumerable: true, get: bad });
  rejects(() => policy.projectRow('notes', accessor));
  rejects(() => policy.projectRow('notes', new Proxy(fixture('notes'), { get: bad, ownKeys: bad, getPrototypeOf: bad })));
  const nested = {}; Object.defineProperty(nested, 'key', { enumerable: true, get: bad });
  rejects(() => policy.projectRow('graph_nodes', fixture('graph_nodes', { metadata: { json: nested } })));
  rejects(() => policy.projectRow('graph_nodes', fixture('graph_nodes', { metadata: { json: new Proxy({}, { ownKeys: bad }) } })));
  const array = [1]; Object.defineProperty(array, '0', { enumerable: true, get: bad });
  rejects(() => policy.projectRow('graph_nodes', fixture('graph_nodes', { metadata: { json: array } })));
  assert.equal(calls, 0);
});

test('unknown tables, nonplain rows, extra fields and symbols fail closed', () => {
  for (const table of ['secrets', 'flyway_schema_history', 'sessions', '__proto__', 'notes; DROP TABLE users', {}, null]) {
    rejects(() => policy.columnsFor(table), 'TABLE_UNKNOWN');
    rejects(() => policy.projectRow(table, {}), 'TABLE_UNKNOWN');
  }
  rejects(() => policy.projectRow('notes', Object.assign(Object.create({ privilege: true }), fixture('notes'))));
  const symbol = fixture('notes'); symbol[Symbol('PRIVATE')] = 'PRIVATE'; rejects(() => policy.projectRow('notes', symbol));
  assert.deepEqual(policy.projectRow('notes', Object.assign(Object.create(null), fixture('notes'))).values, fixture('notes'));
});

test('bounded valid Unicode text is preserved; UTF-8 byte cap, NUL and unpaired surrogates fail', () => {
  const boundary = 'a'.repeat(POLICY_LIMITS.maxTextBytes);
  assert.equal(policy.projectRow('notes', fixture('notes', { content_md: boundary })).values.content_md, boundary);
  rejects(() => policy.projectRow('notes', fixture('notes', { content_md: `${boundary}a` })), 'LIMIT_EXCEEDED');
  const utf8 = '가'.repeat(Math.floor(POLICY_LIMITS.maxTextBytes / 3));
  assert.equal(policy.projectRow('notes', fixture('notes', { content_md: utf8 })).values.content_md, utf8);
  rejects(() => policy.projectRow('notes', fixture('notes', { content_md: `${utf8}가` })), 'LIMIT_EXCEEDED');
  for (const content_md of ['a\0b', '\ud800', '\udc00', 'x\ud800y']) rejects(() => policy.projectRow('notes', fixture('notes', { content_md })));
});

test('fixed row/depth/member/node bounds reject oversized shapes without truncating input', () => {
  const large = 'a'.repeat(POLICY_LIMITS.maxTextBytes);
  const input = fixture('ai_messages', { content: large, context: { json: [large, large, large] } });
  rejects(() => policy.projectRow('ai_messages', input), 'LIMIT_EXCEEDED');
  assert.equal(input.context.json.length, 3); assert.equal(input.content, large);
  function nested(depth) { let value = null; while (depth--) value = { a: value }; return value; }
  policy.projectRow('graph_nodes', fixture('graph_nodes', { metadata: { json: nested(16) } }));
  rejects(() => policy.projectRow('graph_nodes', fixture('graph_nodes', { metadata: { json: nested(17) } })), 'LIMIT_EXCEEDED');
  rejects(() => policy.projectRow('graph_nodes', fixture('graph_nodes', { metadata: { json: new Array(4097).fill(null) } })));
  const broad = Array.from({ length: 4 }, () => new Array(4096).fill(null));
  rejects(() => policy.projectRow('graph_nodes', fixture('graph_nodes', { metadata: { json: broad } })), 'LIMIT_EXCEEDED');
});

test('vector projection validates dimensions/finite values and owns a frozen copy', () => {
  const embedding = new Array(1536).fill(0.25);
  const output = policy.projectRow('summaries', fixture('summaries', { embedding }));
  assert.deepEqual(output.values.embedding, embedding); assert.notEqual(output.values.embedding, embedding);
  embedding[0] = 4; assert.equal(output.values.embedding[0], 0.25); assert.ok(Object.isFrozen(output.values.embedding));
  for (const bad of [new Array(1535).fill(0), new Array(1537).fill(0), new Array(1536).fill(Infinity),
    new Array(1536).fill(3.5e38), new Float32Array(1536)]) rejects(() => policy.projectRow('summaries', fixture('summaries', { embedding: bad })));
});

test('the pure module has no runtime filesystem/process/network imports or product backup wiring', () => {
  const source = fs.readFileSync(path.join(__dirname, '../src/backup-export-policy.cjs'), 'utf8');
  assert.deepEqual([...source.matchAll(/require\('([^']+)'\)/g)].map(match => match[1]), ['node:util']);
  assert.doesNotMatch(source, /process\.env|child_process|pg_dump|pg_restore|electron|fetch\(/);
});


test('V27 preserves recorded and legacy outcomes exactly and rejects unknown states or negative inventory facts', () => {
  for (const analysis_status of ['LEGACY_UNMEASURED', 'UNMEASURED', 'TARGETED', 'SUCCESS', 'PARTIAL', 'FAILED', 'UNSUPPORTED']) {
    const row = fixture('files', { analysis_status, analysis_reason: 'ANALYZER_DISABLED', analysis_targeted: false });
    assert.deepEqual(policy.projectRow('files', row).values, row);
  }
  rejects(() => policy.projectRow('files', fixture('files', { analysis_status: 'COMPLETE' })));
  rejects(() => policy.projectRow('files', fixture('files', { analysis_reason: 'a'.repeat(129) })));
  const zero = fixture('snapshot_inventory_measurements', { discovered_files: 0, excluded_for_count: 0,
    excluded_for_size: 0, excluded_binary: 0, excluded_submodules: 0 });
  assert.deepEqual(policy.projectRow('snapshot_inventory_measurements', zero).values, zero);
  for (const column of ['discovered_files', 'excluded_for_count', 'excluded_for_size', 'excluded_binary', 'excluded_submodules']) {
    rejects(() => policy.projectRow('snapshot_inventory_measurements', { ...zero, [column]: -1 }));
  }
});

test('V26 archive schemas remain explicitly incompatible; no historical outcomes are synthesized', () => {
  const old = schema(); old.migrations = old.migrations.filter(item => item.version < 27);
  old.tables = old.tables.filter(table => table.name !== 'snapshot_inventory_measurements');
  old.tables.find(table => table.name === 'files').columns = old.tables.find(table => table.name === 'files').columns
    .filter(column => !['analysis_status', 'analysis_reason', 'analysis_targeted'].includes(column.name));
  rejects(() => createBackupExportPolicy(old), 'SCHEMA_MISMATCH');
});

test('V28/V29 are pinned: export is V29 only, V27 is an exact restore-only inventory and unknown migrations are refused', () => {
  const { createBackupRestorePolicy, REVIEWED_V27_SCHEMA, REVIEWED_V26_SCHEMA } = require('../src/backup-export-policy.cjs');
  assert.deepEqual(REVIEWED_SCHEMA.migrations.slice(26).map(item => item.filename),
    ['V27__file_analysis_outcomes.sql', 'V28__foreign_key_lookup_indexes.sql', 'V29__local_source_scope.sql']);
  for (const table of ['local_source_approvals', 'job_local_source_inputs']) {
    assert.deepEqual(definition(table).columns.at(-1), { name: 'scope', type: 'text', nullable: true, generation: 'none' });
    assert.deepEqual(policy.columnsFor(table), []);
    rejects(() => policy.projectRow(table, {}), 'TABLE_EXCLUDED');
    for (const legacy of [REVIEWED_V27_SCHEMA, REVIEWED_V26_SCHEMA]) {
      assert.deepEqual(legacy.tables.find(item => item.name === table).columns, definition(table).columns.slice(0, -1));
    }
  }
  // V27 rows are V29 rows: the same tables select the same columns with the same projection.
  const v27 = createBackupRestorePolicy(structuredClone(REVIEWED_V27_SCHEMA));
  assert.equal(v27.schema, REVIEWED_V27_SCHEMA);
  assert.deepEqual(REVIEWED_V27_SCHEMA.tables.map(table => table.name), REVIEWED_SCHEMA.tables.map(table => table.name));
  for (const { name } of REVIEWED_SCHEMA.tables) assert.deepEqual(v27.columnsFor(name), policy.columnsFor(name));
  for (const table of ['files', 'snapshot_inventory_measurements', 'notes']) {
    assert.deepEqual(v27.projectRow(table, fixture(table)), policy.projectRow(table, fixture(table)));
  }
  assert.equal(createBackupRestorePolicy(structuredClone(REVIEWED_SCHEMA)).schema, REVIEWED_SCHEMA);
  rejects(() => createBackupExportPolicy(structuredClone(REVIEWED_V27_SCHEMA)), 'SCHEMA_MISMATCH');
  const hybrids = [
    input => { input.migrations.push(structuredClone(REVIEWED_SCHEMA.migrations[27])); },
    input => { input.tables = structuredClone(REVIEWED_SCHEMA.tables); },
    input => { input.migrations[26].sha256 = '0'.repeat(64); },
    input => { input.migrations[26].filename = 'V27__unreviewed.sql'; },
  ];
  for (const mutate of hybrids) {
    const input = structuredClone(REVIEWED_V27_SCHEMA); mutate(input);
    rejects(() => createBackupRestorePolicy(input), 'SCHEMA_MISMATCH');
  }
  const unscoped = schema();
  for (const table of unscoped.tables.filter(item => ['local_source_approvals', 'job_local_source_inputs'].includes(item.name))) table.columns.pop();
  rejects(() => createBackupRestorePolicy(unscoped), 'SCHEMA_MISMATCH');
  for (const version of [28, 29]) {
    const changed = schema(); changed.migrations[version - 1].sha256 = '0'.repeat(64);
    rejects(() => createBackupExportPolicy(changed), 'SCHEMA_MISMATCH');
    rejects(() => createBackupRestorePolicy(changed), 'SCHEMA_MISMATCH');
  }
  const future = schema(); future.migrations.push({ version: 30, filename: 'V30__unreviewed.sql', sha256: hash });
  rejects(() => createBackupExportPolicy(future), 'SCHEMA_MISMATCH');
  rejects(() => createBackupRestorePolicy(future), 'SCHEMA_MISMATCH');
  const v28 = schema(); v28.migrations.pop();
  rejects(() => createBackupRestorePolicy(v28), 'SCHEMA_MISMATCH');
});
