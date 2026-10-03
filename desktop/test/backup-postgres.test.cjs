'use strict';
const assert = require('node:assert/strict');
const test = require('node:test');
const crypto = require('node:crypto');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const zlib = require('node:zlib');
const { EventEmitter } = require('node:events');
const { PassThrough, Writable } = require('node:stream');
const { spawnSync } = require('node:child_process');
const { createBackupPostgres, validateBackupSummary, BackupPostgresError, LIMITS } = require('../src/backup-postgres.cjs');
const { createBackupExportPolicy, REVIEWED_SCHEMA } = require('../src/backup-export-policy.cjs');
const policy = createBackupExportPolicy(REVIEWED_SCHEMA);
const migrationRoot = path.resolve(__dirname, '../../backend/src/main/resources/db/migration');
const ID = '9007199254740993', OTHER_ID = '9007199254740995';
const INSTALLATION = '11111111-2222-4333-8444-555555555555';
const NOW = '2026-10-03T00:00:00.123456Z';
const HASH = 'a'.repeat(64);
const copy = value => JSON.parse(JSON.stringify(value));
function canonical(v) { return Array.isArray(v) ? `[${v.map(canonical)}]` : v !== null && typeof v === 'object'
  ? `{${Object.keys(v).sort().map(k => `${JSON.stringify(k)}:${canonical(v[k])}`).join(',')}}` : JSON.stringify(v); }
const sha = text => crypto.createHash('sha256').update(text).digest('hex');
const sequences = REVIEWED_SCHEMA.tables.flatMap(t => t.columns.filter(c => c.generation !== 'none')
  .map(c => ({ key: `${t.name}.${c.name}`, name: `${t.name}_${c.name}_seq` })));
const zeroSequences = () => Object.fromEntries(sequences.map(s => [s.key, '0']));
const functions = ['guard_ai_cost_immutability', 'protect_sealed_source_entry', 'protect_snapshot_source_identity',
  'protect_source_blob', 'protect_source_manifest', 'reject_local_source_input_update'];
async function header(owner = true) {
  const catalog = { tables: REVIEWED_SCHEMA.tables.map(t => ({ name: t.name, kind: 'r', rls: false, forceRls: false,
    columns: t.columns.map(c => ({ ...c, default: null })) })), constraints: [], indexes: [], triggers: [],
    functions: functions.map(name => ({ name, definition: `fixture ${name}` })), rules: [],
    sequences: sequences.map(s => ({ name: s.name, type: 'bigint', start: '1', increment: '1', min: '1',
      max: '9223372036854775807', cache: '1', cycle: false })).sort((a, b) => a.name.localeCompare(b.name)),
    extensions: [{ name: 'pg_trgm', version: '1.6' }, { name: 'plpgsql', version: '1.0' }, { name: 'vector', version: '0.8.0' }], serverMajor: 16 };
  const history = await Promise.all(REVIEWED_SCHEMA.migrations.map(async m => ({ version: String(m.version), script: m.filename,
    checksum: zlib.crc32(Buffer.from((await fs.readFile(path.join(migrationRoot, m.filename), 'utf8')).replace(/^\uFEFF/, '').replace(/\r\n|\r|\n/g, ''))) | 0,
    success: true, type: 'SQL' })));
  return { kind: 'header', catalog, history, owner: owner ? { ownerUserId: ID, valid: true } : null, activeJobs: '0', activeSteps: '0' };
}
function raw(projected) {
  const table = REVIEWED_SCHEMA.tables.find(t => t.name === projected.table);
  return Object.fromEntries(Object.entries(projected.values).map(([name, value]) => {
    const type = table.columns.find(c => c.name === name).type;
    return [name, value === null ? null : type === 'jsonb' ? JSON.stringify(value.json)
      : type.startsWith('vector') ? JSON.stringify(value) : String(value)];
  }));
}
function user(id = ID, identity = 'LOCAL') {
  return policy.projectRow('users', { id, github_id: identity === 'LOCAL' ? null : '1234', login: 'fixture', name: null,
    avatar_url: null, created_at: NOW, updated_at: NOW, identity_type: identity });
}
function note() { return policy.projectRow('notes', { id: '9007199254740989', project_id: '2', title: '  title  ',
  content_md: '원문\r\n# 😀\n\\copy must stay text', created_at: NOW, updated_at: NOW }); }
function pref(table, provider = 'openai', id = ID) {
  return policy.projectRow(table, { ...(table === 'user_ai_settings' ? { id: '9' } : {}), user_id: id, provider,
    model: provider ? 'fixture-model' : null, created_at: NOW, updated_at: NOW });
}
function summaryFor(h, rows, revision = {}) {
  return { version: 1, schema: REVIEWED_SCHEMA, ownerUserId: ID, catalogSha256: sha(canonical(h.catalog)),
    sequenceHighWater: zeroSequences(), preferenceRevisionHighWater: revision,
    tableCounts: Object.fromEntries(REVIEWED_SCHEMA.tables.map(t => [t.name, String(rows.filter(r => r.table === t.name).length)])),
    tableSha256: Object.fromEntries(REVIEWED_SCHEMA.tables.map(t => [t.name, sha(rows.filter(r => r.table === t.name).map(r => `${canonical(r)}\n`).join(''))])),
    rowCount: String(rows.length) };
}
async function rejects(promise, code) {
  await assert.rejects(promise, e => { assert(e instanceof BackupPostgresError); if (code) assert.equal(e.code, `BACKUP_PG_${code}`);
    assert.doesNotMatch(String(e), /private-password|private-source|select |injected|sentinel/); assert.equal(e.cause, undefined); return true; });
}
async function fixture(t, patch = {}) {
  const originalHeader = await header();
  const controls = { rows: [user()], revisions: {}, sequences: zeroSequences(), times: {}, header: originalHeader, hang: false,
    off: true, tableEndPatch: null, lines: null, delayedConsumer: null };
  const calls = [];
  const spawn = (command, args, options) => {
    const child = new EventEmitter(); child.stdout = new PassThrough(); child.stderr = new PassThrough();
    const call = { command, args, options, chunks: [], signals: [], child, closed: false }; calls.push(call);
    const end = code => { if (call.closed) return; call.closed = true; child.stdout.end(); child.stderr.end(); child.emit('close', code); };
    child.kill = signal => { call.signals.push(signal); if (!controls.ignoreKill) queueMicrotask(() => end(null)); return true; };
    const emit = value => child.stdout.write(`${typeof value === 'string' ? value : JSON.stringify(value)}\n`);
    child.stdin = new Writable({ write(bytes, _encoding, done) {
      const sql = bytes.toString(); call.chunks.push(sql); done();
      queueMicrotask(() => {
        if (controls.hang || call.closed) return;
        if (controls.stderr) child.stderr.write(controls.stderr);
        if (sql.includes("'kind','header'")) {
          const h = copy(controls.header);
          const needsOwner = sql.includes('min(id) filter'); h.owner = needsOwner ? h.owner : null;
          if (!needsOwner) { h.activeJobs = '0'; h.activeSteps = '0'; }
          if (controls.headerPatch) controls.headerPatch(h, call);
          emit(h);
        } else if (sql.includes("'kind','sequences'")) emit({ kind: 'sequences', values: controls.sequences });
        else if (sql.includes("'kind','revisions'")) emit({ kind: 'revisions', values: controls.revisions });
        else if (sql.includes("'kind','retained-times'")) emit({ kind: 'retained-times', values: controls.times });
        else if (sql.includes("'kind','table'")) {
          const name = sql.match(/'kind','table','table','([^']+)'/)[1];
          if (controls.lines) { for (const line of controls.lines(name)) emit(line); return; }
          emit({ kind: 'table', table: name });
          for (const row of controls.rows.filter(r => r.table === name)) {
            const values = raw(row); if (controls.rawPatch) controls.rawPatch(name, values);
            emit({ kind: 'row', table: name, values });
          }
          const closing = { kind: 'end', table: name, count: String(controls.rows.filter(r => r.table === name).length) };
          if (controls.tableEndPatch) controls.tableEndPatch(closing); emit(closing);
        } else if (sql.includes("'kind','off'")) emit({ kind: 'off', valid: controls.off });
        else if (sql.includes("'kind','done'")) { if (!controls.omitDone) emit({ kind: 'done' }); }
      });
    } });
    child.stdin.on('finish', () => queueMicrotask(() => { if (!controls.hang) end(controls.exit || 0); }));
    return child;
  };
  const options = { psqlPath: await fs.realpath(process.execPath), migrationRoot: await fs.realpath(migrationRoot), installationId: INSTALLATION,
    connection: { host: '127.0.0.1', port: 6543, user: 'codeintel', database: 'codeintel' }, env: { PGPASSWORD: 'private-password' },
    mode: 'export', spawn, ...patch };
  const adapter = await createBackupPostgres(options); t.after(() => adapter.close().catch(() => {}));
  return { adapter, controls, calls, options, originalHeader };
}
const stageOptions = { mode: 'staging', connection: { host: '127.0.0.1', port: 6543, user: 'codeintel', database: 'ci_backup_stage_0123456789abcdef' } };
async function staging(t) { const f = await fixture(t, stageOptions); await f.adapter.initializeStaging(); return f; }
function loadOptions(f, rows = [user()], extras = {}) {
  return { rows, expected: summaryFor(f.originalHeader, rows), writeAccounting: async () => {}, liveOwnerUserId: ID,
    livePreferenceRevisionHighWater: {}, ...extras };
}

test('retained commit times query is read-only, owner/catalog gated and binds exact source provenance', async t => {
  const f = await fixture(t); f.controls.times = { [ID]: '1790985600', [OTHER_ID]: null };
  const result = await f.adapter.readRetainedCommitTimes({ snapshotIds: [ID, OTHER_ID] });
  assert.deepEqual(result, f.controls.times); assert(Object.isFrozen(result));
  const calls = f.calls[0].chunks;
  assert.match(calls[0], /repeatable read read only/); assert.match(calls[1], /'kind','header'/);
  assert(!calls[1].includes('public.snapshots'));
  const sql = calls.find(part => part.includes("'kind','retained-times'"));
  assert.match(sql, /coalesce\(c\.committed_at,i\.approved_at\)/);
  for (const predicate of ['s.source_contract_version=1', 'm.snapshot_id=s.id', 'm.project_id=p.id', 'm.sealed_at is not null',
    'c.project_id=p.id', 'c.sha=s.commit_sha', 'j.id=m.job_id', 'j.project_id=p.id', 'j.snapshot_id=s.id',
    'i.manifest_sha256=m.approval_manifest_sha256', 'i.limits_sha256=m.limits_sha256', 'i.policy_version=m.policy_version']) assert(sql.includes(predicate));
  assert(!sql.includes('created_at')); assert(!sql.includes('canonical_root')); assert(!sql.includes('clone_path'));
});
test('retained timestamp request rejects noncanonical, duplicate, unsafe, sparse and accessor IDs before spawn', async t => {
  const f = await fixture(t);
  for (const ids of [[ID, ID], ['0'], ['01'], [1], ['9223372036854775808'], [`${ID}\n`], Array(1), Array(10001).fill(ID)]) {
    await rejects(f.adapter.readRetainedCommitTimes({ snapshotIds: ids }));
  }
  const ids = [ID]; let invoked = 0; Object.defineProperty(ids, '0', { enumerable: true, get() { invoked++; return ID; } });
  await rejects(f.adapter.readRetainedCommitTimes({ snapshotIds: ids })); assert.equal(invoked, 0); assert.equal(f.calls.length, 0);
});
test('retained timestamp response requires exact requested ID coverage and canonical signed integer seconds', async t => {
  const f = await fixture(t);
  for (const values of [{}, { [ID]: '1', [OTHER_ID]: '2' }, { [ID]: 0 }, { [ID]: '1.0' }, { [ID]: '01' },
    { [ID]: '-0' }, { [ID]: '1\n' }, { [ID]: '9223372036854775808' }]) {
    f.controls.times = values; await rejects(f.adapter.readRetainedCommitTimes({ snapshotIds: [ID] }), 'INTEGRITY');
  }
  for (const value of [null, '-1', '0', '9223372036854775807', '-9223372036854775808']) {
    f.controls.times = { [ID]: value }; assert.equal((await f.adapter.readRetainedCommitTimes({ snapshotIds: [ID] }))[ID], value);
  }
});
test('retained timestamps never query rows when catalog or local installation binding is invalid', async t => {
  const f = await fixture(t); f.controls.header.owner.valid = false;
  await rejects(f.adapter.readRetainedCommitTimes({ snapshotIds: [ID] }), 'OWNER');
  assert(!f.calls[0].chunks.join('').includes("'kind','retained-times'"));
});
test('retained timestamps permit an empty requested set but not staging mode', async t => {
  const f = await fixture(t); assert.deepEqual(await f.adapter.readRetainedCommitTimes({ snapshotIds: [] }), {});
  const s = await fixture(t, stageOptions); await rejects(s.adapter.readRetainedCommitTimes({ snapshotIds: [] }), 'STAGING');
  assert.equal(s.calls.length, 0);
});
test('measureExport counts exact canonical row and database-summary frame bytes without writing rows', async t => {
  const f = await fixture(t); f.controls.rows = [user(), note()];
  const result = await f.adapter.measureExport(); const expected = summaryFor(f.originalHeader, f.controls.rows);
  const rowBytes = f.controls.rows.reduce((sum, row) => sum + 4 + Buffer.byteLength(canonical({ kind: 'ROW', row })), 0);
  const summaryBytes = 4 + Buffer.byteLength(canonical({ kind: 'DATABASE', summary: expected }));
  assert.equal(result.rowFrameBytes, String(rowBytes)); assert.equal(result.databaseFrameBytes, String(summaryBytes));
  assert.equal(result.databasePayloadBytes, String(rowBytes + summaryBytes)); assert.equal(result.rowCount, '2');
  assert.deepEqual(result.summary, expected); assert(Object.isFrozen(result.summary));
  assert(!f.calls[0].chunks.join('').includes('insert into'));
});
test('measureExport inherits schema/owner/precision limits and is export-only', async t => {
  const f = await fixture(t); f.controls.header.owner.valid = false; await rejects(f.adapter.measureExport(), 'OWNER');
  const s = await fixture(t, stageOptions); await rejects(s.adapter.measureExport(), 'STAGING'); assert.equal(s.calls.length, 0);
});

test('pure summary validation returns an owned frozen value without granting catalog authority', async () => {
  const h = await header(); const supplied = summaryFor(h, [user()]);
  supplied.catalogSha256 = 'b'.repeat(64); // Shape-valid is not a verified live catalog claim.
  const result = validateBackupSummary(supplied);
  assert.equal(result.catalogSha256, 'b'.repeat(64)); assert.notEqual(result, supplied); assert.notEqual(result.tableCounts, supplied.tableCounts);
  supplied.tableCounts.users = '0'; assert.equal(result.tableCounts.users, '1');
  assert(Object.isFrozen(result.schema.tables)); assert(Object.isFrozen(result.preferenceRevisionHighWater));
});
test('pure summary validation rejects missing table coverage, unsafe counts and high-water metadata', async () => {
  const baseline = summaryFor(await header(), [user()]);
  for (const mutate of [s => { delete s.tableCounts.notes; }, s => { s.rowCount = '2'; }, s => { s.tableCounts.users = 1; },
    s => { s.ownerUserId = Number(ID); }, s => { s.sequenceHighWater['users.id'] = '9223372036854775808'; },
    s => { s.preferenceRevisionHighWater[ID] = '-1'; }, s => { s.tableCounts.github_credentials = '1'; s.rowCount = '2'; }]) {
    const value = copy(baseline); mutate(value); assert.throws(() => validateBackupSummary(value), BackupPostgresError);
  }
});
test('pure summary schema and accessor mutations fail without invoking getters', async () => {
  const value = copy(summaryFor(await header(), [user()])); value.schema.migrations[0].sha256 = 'b'.repeat(64);
  assert.throws(() => validateBackupSummary(value), e => e.code === 'BACKUP_PG_SCHEMA');
  const getter = copy(summaryFor(await header(), [user()])); let invoked = 0;
  Object.defineProperty(getter.tableCounts, 'users', { enumerable: true, get() { invoked++; return '1'; } });
  assert.throws(() => validateBackupSummary(getter), e => e.code === 'BACKUP_PG_INTEGRITY'); assert.equal(invoked, 0);
});

test('read-only snapshot waits for catalog and owner validation before selecting any product row', async t => {
  const f = await fixture(t); const rows = [];
  const result = await f.adapter.exportRows({ writeRow: row => rows.push(row) });
  assert.deepEqual(rows, [user()]); assert.equal(result.ownerUserId, ID); assert.equal(result.rowCount, '1');
  assert.equal(Object.keys(result.tableCounts).length, 52); assert.equal(Object.keys(result.tableSha256).length, 52);
  assert.equal(result.catalogSha256, sha(canonical(f.originalHeader.catalog)));
  const c = f.calls[0]; assert.match(c.chunks[0], /repeatable read read only/); assert.match(c.chunks[1], /'kind','header'/);
  assert(!c.chunks[1].includes("'kind','row'")); assert(c.args.includes('-X')); assert(c.args.includes('--file=-'));
  assert.equal(c.options.shell, false); assert(!c.args.join(' ').includes('private-password'));
  assert(!c.args.join(' ').includes('select')); assert.equal(c.options.env.PGPASSWORD, 'private-password');
  for (const key of ['PATH', 'HOME', 'PGOPTIONS', 'PGSERVICE', 'NODE_OPTIONS']) assert.equal(c.options.env[key], undefined);
  assert(Object.isFrozen(result)); assert(Object.isFrozen(rows[0].values));
});
for (const [name, mutate, code] of [
  ['extra table', h => h.catalog.tables.push({ name: 'innocent_secret_table', columns: [] }), 'SCHEMA'],
  ['extra credential column', h => h.catalog.tables[1].columns.push({ name: 'secret', type: 'text', nullable: true, generation: 'none' }), 'SCHEMA'],
  ['changed migration', h => h.history[0].checksum++, 'SCHEMA'],
  ['missing migration', h => h.history.pop(), 'SCHEMA'],
  ['failed migration', h => { h.history[0].success = false; }, 'SCHEMA'],
  ['RLS', h => { h.catalog.tables[0].rls = true; }, 'SCHEMA'],
  ['view substitution', h => { h.catalog.tables[0].kind = 'v'; }, 'SCHEMA'],
  ['unknown function', h => h.catalog.functions.push({ name: 'new_function', definition: 'fixture' }), 'SCHEMA'],
  ['rewrite rule', h => h.catalog.rules.push({ name: 'fixture' }), 'SCHEMA'],
  ['disabled trigger', h => h.catalog.triggers.push({ enabled: 'D' }), 'SCHEMA'],
  ['foreign or multiple local owner', h => { h.owner.valid = false; }, 'OWNER'],
  ['missing owner', h => { h.owner.ownerUserId = null; }, 'OWNER'],
  ['active job', h => { h.activeJobs = '1'; }, 'ACTIVE_JOB'],
  ['active step', h => { h.activeSteps = '1'; }, 'ACTIVE_JOB'],
]) test(`${name} is rejected before product row SQL`, async t => {
  const f = await fixture(t); mutate(f.controls.header); let published = 0;
  await rejects(f.adapter.exportRows({ writeRow: () => { published++; } }), code);
  assert.equal(published, 0); assert(!f.calls[0].chunks.join('').includes("'kind','row'"));
  assert(!f.calls[0].chunks.includes('commit;\n'));
});

test('all installation users retain bigint IDs and linked local identity', async t => {
  const f = await fixture(t); f.controls.rows = [user(ID, 'LOCAL_LINKED'), user(OTHER_ID, 'GITHUB'), note()];
  const out = []; await f.adapter.exportRows({ writeRow: row => out.push(row) });
  assert.deepEqual(out, f.controls.rows); assert.equal(out[2].values.content_md, note().values.content_md);
  const sql = f.calls[0].chunks.join('');
  for (const forbidden of ['encrypted_token', 'encrypted_key', 'nonce', 'approval_token_sha256', 'canonical_root', 'clone_path', 'local_path']) {
    for (const chunk of f.calls[0].chunks.filter(c => c.includes("'kind','row'"))) assert(!chunk.includes(forbidden));
  }
  assert(!sql.includes('pg_dump')); assert(!sql.includes('pg_restore'));
});

function messageRow(context = { json: null }) { return policy.projectRow('ai_messages', { id: '7', conversation_id: '6', role: 'USER',
  content: 'text', context, claims: null, prompt_tokens: 0, completion_tokens: null, created_at: NOW }); }
test('SQL NULL and JSON literal null have different envelopes', async t => {
  const f = await fixture(t); f.controls.rows = [user(), messageRow()]; const out = [];
  await f.adapter.exportRows({ writeRow: r => out.push(r) });
  assert.deepEqual(out[1].values.context, { json: null }); assert.equal(out[1].values.claims, null);
});
for (const numeric of ['9007199254740993', '1.0000000000000000000000000001', '0.1234567890123456789012345', '1e-400', '1e400', '-0', '1e20']) {
  test(`lossy JSONB number ${numeric} is rejected before Number rounding`, async t => {
    const f = await fixture(t); f.controls.rows = [user(), messageRow()];
    f.controls.rawPatch = (table, values) => { if (table === 'ai_messages') values.context = `{"number":${numeric}}`; };
    await rejects(f.adapter.exportRows({ writeRow: () => {} }), 'PRECISION');
  });
}
test('exact decimal JSON values survive while numeric text and escaped quotes remain text', async t => {
  const f = await fixture(t); f.controls.rows = [user(), messageRow()];
  f.controls.rawPatch = (table, values) => { if (table === 'ai_messages') values.context = '{"x":0.1000,"n":9007199254740991,"text":"9007199254740993\\\""}'; };
  const out = []; await f.adapter.exportRows({ writeRow: r => out.push(r) });
  assert.deepEqual(out[1].values.context.json, { x: 0.1, n: 9007199254740991, text: '9007199254740993"' });
});
test('malformed JSONB fails without returning raw content', async t => {
  const f = await fixture(t); f.controls.rows = [user(), messageRow()];
  f.controls.rawPatch = (table, values) => { if (table === 'ai_messages') values.context = 'private-source{'; };
  await rejects(f.adapter.exportRows({ writeRow: () => {} }), 'ROW');
});
test('sequence and preference revision high-water reads preserve exact decimal strings', async t => {
  const f = await fixture(t); f.controls.sequences['users.id'] = ID; f.controls.revisions = { [ID]: '9007199254740994' };
  assert.equal((await f.adapter.readSequenceHighWater())['users.id'], ID);
  assert.deepEqual(await f.adapter.readPreferenceRevisionHighWater(), f.controls.revisions);
});
test('missing mandatory EOF footer fails even after rows arrive', async t => {
  const f = await fixture(t); f.controls.omitDone = true;
  await rejects(f.adapter.exportRows({ writeRow: () => {} }), 'INTEGRITY');
});
test('false table counts fail', async t => {
  const f = await fixture(t); f.controls.tableEndPatch = row => { if (row.table === 'users') row.count = '0'; };
  await rejects(f.adapter.exportRows({ writeRow: () => {} }), 'INTEGRITY');
});
test('consumer failure and timeout abort the child without exposing cause', async t => {
  const f = await fixture(t);
  await rejects(f.adapter.exportRows({ writeRow: () => { throw new Error('private-source injected'); } }), 'CALLBACK');
  assert(f.calls[0].signals.includes('SIGTERM'));
  const timeout = await fixture(t, { timeoutMs: 25 }); timeout.controls.hang = true;
  await rejects(timeout.adapter.exportRows({ writeRow: () => {} }), 'TIMEOUT');
});
test('a stalled row consumer is bounded by the operation deadline', async t => {
  const f = await fixture(t, { timeoutMs: 25 });
  await rejects(f.adapter.exportRows({ writeRow: () => new Promise(() => {}) }), 'TIMEOUT');
});
test('queue is bounded and close stops active and queued work', async t => {
  const f = await fixture(t); f.controls.hang = true;
  const first = f.adapter.exportRows({ writeRow: () => {} }); const second = f.adapter.exportRows({ writeRow: () => {} });
  const a = rejects(first, 'CLOSED'), b = rejects(second, 'CLOSED');
  await rejects(f.adapter.exportRows({ writeRow: () => {} }), 'BUSY');
  await f.adapter.close(); await Promise.all([a, b]);
  await rejects(f.adapter.readSequenceHighWater(), 'CLOSED');
});
for (const [name, patch] of [
  ['nonloopback', { connection: { host: 'localhost', port: 5432, user: 'codeintel', database: 'codeintel' } }],
  ['libpq options database', { connection: { host: '127.0.0.1', port: 5432, user: 'codeintel', database: 'x options=-c' } }],
  ['PGOPTIONS', { env: { PGPASSWORD: 'fixture', PGOPTIONS: '-c statement_timeout=0' } }],
  ['relative binary', { psqlPath: 'psql' }],
  ['SQL option', { sql: 'select 1' }],
  ['live database staging', { mode: 'staging' }],
]) test(`configuration rejects ${name}`, async t => {
  const f = await fixture(t); await rejects(createBackupPostgres({ ...f.options, ...patch }));
});
test('changed, extra and symlinked migration inputs fail before spawn', async t => {
  const f = await fixture(t); const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ci-backup-migrations-')); t.after(() => fs.rm(root, { recursive: true, force: true }));
  for (const m of REVIEWED_SCHEMA.migrations) await fs.copyFile(path.join(migrationRoot, m.filename), path.join(root, m.filename));
  const canonicalRoot = await fs.realpath(root); let spawned = 0;
  const options = { ...f.options, migrationRoot: canonicalRoot, spawn() { spawned++; } };
  await fs.writeFile(path.join(root, 'R__extra.sql'), 'select 1;'); await rejects(createBackupPostgres(options), 'MIGRATIONS');
  await fs.rm(path.join(root, 'R__extra.sql')); await fs.appendFile(path.join(root, REVIEWED_SCHEMA.migrations[0].filename), '\n');
  await rejects(createBackupPostgres(options), 'MIGRATIONS');
  await fs.rm(path.join(root, REVIEWED_SCHEMA.migrations[0].filename));
  await fs.symlink(path.join(migrationRoot, REVIEWED_SCHEMA.migrations[0].filename), path.join(root, REVIEWED_SCHEMA.migrations[0].filename));
  await rejects(createBackupPostgres(options), 'MIGRATIONS'); assert.equal(spawned, 0);
});

test('staging applies only verified migrations and writes its own Flyway history', async t => {
  const f = await staging(t); const sql = f.calls[0].chunks.join('');
  assert.match(sql, /staging not empty/); assert.match(sql, /set local search_path=public,pg_catalog/);
  assert.match(sql, /create table public.flyway_schema_history/); assert.match(sql, /b5d547|insert into public.flyway_schema_history/);
  assert(!sql.includes('session_replication_role')); assert(!sql.includes('disable trigger'));
  await rejects(f.adapter.initializeStaging(), 'STAGING');
});
test('load requires an initialized isolated database and a trusted current owner', async t => {
  const exported = await fixture(t); await rejects(exported.adapter.loadRows({}), 'STAGING');
  const f = await staging(t);
  await rejects(f.adapter.loadRows(loadOptions(f, [user()], { liveOwnerUserId: OTHER_ID })), 'OWNER');
  await rejects(f.adapter.loadRows(loadOptions(f, [user()], { livePreferenceRevisionHighWater: undefined })), 'INTEGRITY');
  await f.adapter.loadRows(loadOptions(f));
  await rejects(f.adapter.loadRows(loadOptions(f)), 'STAGING');
});
test('load preserves exact rows and binds only the existing local ID to main identity', async t => {
  const f = await staging(t); const rows = [user(ID, 'LOCAL_LINKED'), user(OTHER_ID, 'GITHUB'), note()]; f.controls.rows = rows;
  const result = await f.adapter.loadRows(loadOptions(f, rows));
  assert.equal(result.tableCounts.notes, '1'); assert.equal(result.credentialsRestored, false); assert.equal(result.reconciliationRequired, true);
  const sql = f.calls[1].chunks.join(''); assert.match(sql, /"local_key"/); assert(!sql.includes('private-password'));
  assert.match(sql, /set constraints all immediate/); assert.match(sql, /max\(job_id\) from public.source_manifests/);
  assert.match(sql, /setval\('public.analysis_generations_fencing_epoch_seq'/);
  assert(!sql.includes('pg_restore')); assert(!sql.includes('truncate')); assert(!sql.includes('drop table public'));
});
test('V24 preferences take precedence over stale keyless settings; missing preferences get fallback', async t => {
  const f = await staging(t); const canonicalPref = pref('user_ai_preferences', 'gemini');
  const rows = [user(), pref('user_ai_settings'), canonicalPref]; const expected = summaryFor(f.originalHeader, rows, { [ID]: '10' });
  f.controls.rows = [user(), canonicalPref];
  const result = await f.adapter.loadRows(loadOptions(f, rows, { expected, livePreferenceRevisionHighWater: { [ID]: '20' } }));
  assert.equal(result.tableCounts.user_ai_settings, '0'); assert.equal(result.tableCounts.user_ai_preferences, '1');
  assert.match(f.calls[1].chunks.join(''), /'OFF',21::bigint/); assert(!f.calls[1].chunks.join('').includes('RECONNECT_REQUIRED'));
  const legacy = await staging(t); const legacyRows = [user(), pref('user_ai_settings')]; legacy.controls.rows = [user(), pref('user_ai_preferences')];
  const restored = await legacy.adapter.loadRows(loadOptions(legacy, legacyRows)); assert.equal(restored.tableCounts.user_ai_preferences, '1');
});
test('a live preference floor absent from the archive is preserved as an OFF keyless row', async t => {
  const f = await staging(t); f.controls.rows = [user(), pref('user_ai_preferences', null)];
  await f.adapter.loadRows(loadOptions(f, [user()], { livePreferenceRevisionHighWater: { [ID]: '9' } }));
  assert.match(f.calls[1].chunks.join(''), /'OFF',10::bigint/);
});
test('preference revision overflow fails and consumes staging without committing', async t => {
  const f = await staging(t); const rows = [user(), pref('user_ai_preferences')];
  await rejects(f.adapter.loadRows(loadOptions(f, rows, { expected: summaryFor(f.originalHeader, rows, { [ID]: '9223372036854775807' }) })), 'INTEGRITY');
  assert(!f.calls[1].chunks.includes('commit;\n')); await rejects(f.adapter.loadRows(loadOptions(f)), 'STAGING');
});
test('source or live sequence floor is never lowered during staging load', async t => {
  const f = await staging(t); const expected = summaryFor(f.originalHeader, [user()]); expected.sequenceHighWater['users.id'] = ID;
  const floor = zeroSequences(); floor['users.id'] = OTHER_ID;
  await f.adapter.loadRows(loadOptions(f, [user()], { expected, liveSequenceHighWater: floor }));
  assert.match(f.calls[1].chunks.join(''), new RegExp(`greatest\\(${OTHER_ID}::bigint,coalesce\\(max\\("id"\\),0\\)`));
});
for (const [name, edit] of [
  ['wrong row hash', options => { options.expected.tableSha256.users = 'b'.repeat(64); }],
  ['trailing row', options => { options.rows.push(user(OTHER_ID, 'GITHUB')); }],
  ['second local user', options => { options.rows[0] = user(OTHER_ID); }],
  ['missing row', options => { options.rows.length = 0; }],
  ['false envelope permission', options => { options.rows[0] = copy(options.rows[0]); options.rows[0].identity.authorityIncluded = true; }],
]) test(`staging rejects ${name} before commit`, async t => {
  const f = await staging(t); const options = loadOptions(f, [user()]); edit(options);
  await rejects(f.adapter.loadRows(options)); assert(!f.calls[1]?.chunks.includes('commit;\n'));
});
test('nested envelope accessors are rejected without invocation', async t => {
  const f = await staging(t); const row = copy(user()); let invoked = 0;
  Object.defineProperty(row.identity, 'authorityIncluded', { enumerable: true, get() { invoked++; return false; } });
  const options = loadOptions(f); options.rows = [row];
  await rejects(f.adapter.loadRows(options), 'ROW'); assert.equal(invoked, 0);
});
test('readback mismatch and unsafe OFF state prevent COMMIT', async t => {
  const f = await staging(t); f.controls.rows = [];
  await rejects(f.adapter.loadRows(loadOptions(f)), 'INTEGRITY'); assert(!f.calls[1].chunks.includes('commit;\n'));
  const off = await staging(t); off.controls.off = false;
  await rejects(off.adapter.loadRows(loadOptions(off)), 'INTEGRITY'); assert(!off.calls[1].chunks.includes('commit;\n'));
});
test('staging refuses a different constraint/trigger fingerprint before input is consumed', async t => {
  const f = await staging(t); const options = loadOptions(f); options.expected.catalogSha256 = HASH;
  await rejects(f.adapter.loadRows(options), 'SCHEMA'); assert.equal(f.calls.length, 1);
});

function financialRows() {
  return [policy.projectRow('ai_budget_gate', { installation_id: INSTALLATION, owner_user_id: ID, policy_revision: '4',
    policy_sha256: HASH, daily_limit_micro_usd: '99', monthly_limit_micro_usd: '999', reconciliation_required: false,
    legacy_liability_unresolved: true, journal_sequence: '9007199254740993', journal_hash: HASH, journal_projection_sha256: HASH,
    clock_high_water_ms: '1790985600123', created_at: NOW, updated_at: NOW }),
  policy.projectRow('ai_request_ledger', { request_id: '77777777-7777-4777-8777-777777777777', installation_id: INSTALLATION,
    owner_user_id: ID, project_id: '2', snapshot_id: '3', approval_id: null, plan_sha256: HASH, payload_sha256: HASH,
    wire_body_sha256: HASH, dispatch_binding: { json: {} }, budget_day: '2026-10-03', price_version: 'fixture',
    reserved_micro_usd: '9007199254740993', status: 'UNKNOWN_HELD', actual_micro_usd: null, proof_sha256: null,
    liability_floor_micro_usd: '9007199254740993', conflict: false, journal_sequence: '7', journal_hash: HASH,
    created_at: NOW, updated_at: NOW }),
  policy.projectRow('ai_usage_evidence', { request_id: '77777777-7777-4777-8777-777777777777', proof_sha256: HASH,
    main_epoch: '88888888-8888-4888-8888-888888888888', receipt_type: 'USAGE', provider_request_id: null,
    usage_dimensions: { json: { units: { INPUT_TOKENS: '0' } } }, actual_micro_usd: '0', created_at: NOW })];
}
test('financial rows go to the main collector only after COMMIT and never replace PG obligations', async t => {
  const f = await staging(t); const financial = financialRows(); const rows = [user(), ...financial], published = [];
  const result = await f.adapter.loadRows(loadOptions(f, rows, { writeAccounting: row => {
    assert(f.calls[1].chunks.includes('commit;\n')); published.push(row);
  } }));
  assert.deepEqual(published, financial); assert.equal(result.accountingRows, '3'); assert.equal(result.tableCounts.ai_request_ledger, '0');
  assert.equal(published[1].values.reserved_micro_usd, '9007199254740993');
  assert(!f.calls[1].chunks.join('').includes('insert into public."ai_request_ledger"'));
  assert(!f.calls[1].chunks.join('').includes('insert into public."ai_budget_gate"'));
});
test('invalid final evidence hash publishes no financial row', async t => {
  const f = await staging(t); const rows = [user(), ...financialRows()]; let published = 0;
  const options = loadOptions(f, rows, { writeAccounting: () => { published++; } }); options.expected.tableSha256.ai_usage_evidence = 'b'.repeat(64);
  await rejects(f.adapter.loadRows(options), 'INTEGRITY'); assert.equal(published, 0); assert(!f.calls[1].chunks.includes('commit;\n'));
});
test('an accounting callback failure cannot make staging reusable', async t => {
  const f = await staging(t);
  await rejects(f.adapter.loadRows(loadOptions(f, [user(), ...financialRows()], { writeAccounting: () => { throw new Error('private-source'); } })), 'CALLBACK');
  await rejects(f.adapter.exportRows({ writeRow: () => {} }), 'STAGING');
  await rejects(f.adapter.loadRows(loadOptions(f)), 'STAGING');
});
test('close interrupts an indefinitely pending accounting consumer', async t => {
  const f = await staging(t); let started; const pending = new Promise(resolve => { started = resolve; });
  const work = f.adapter.loadRows(loadOptions(f, [user(), ...financialRows()], { writeAccounting: () => { started(); return new Promise(() => {}); } }));
  const rejected = rejects(work, 'CLOSED'); await pending; await f.adapter.close(); await rejected;
});
test('stdout malformed UTF-8/JSON and oversized stderr are bounded errors', async t => {
  const f = await fixture(t); f.controls.lines = () => ['private-source{'];
  await rejects(f.adapter.exportRows({ writeRow: () => {} }), 'PG_FAILED');
  const stderr = await fixture(t); stderr.controls.stderr = Buffer.alloc(LIMITS.stderrBytes + 1, 'x');
  await rejects(stderr.adapter.exportRows({ writeRow: () => {} }), 'LIMIT');
});
test('a never-ending input iterator cannot outlive the database operation deadline', async t => {
  const f = await fixture(t, { ...stageOptions, timeoutMs: 50 }); await f.adapter.initializeStaging();
  const rows = { [Symbol.asyncIterator]() { return { next: () => new Promise(() => {}) }; } };
  await rejects(f.adapter.loadRows(loadOptions(f, [user()], { rows })), 'TIMEOUT');
  assert(!f.calls[1].chunks.includes('commit;\n'));
});

// Opt-in: root supplies TWO disposable empty databases. Never creates/drops databases or connects to the user's DB.
test('real isolated PostgreSQL typed export and trigger-respecting staging round trip', {
  skip: !process.env.CI_BACKUP_PG_TEST_PSQL,
}, async t => {
  const psqlPath = await fs.realpath(process.env.CI_BACKUP_PG_TEST_PSQL);
  const sourceDb = process.env.CI_BACKUP_PG_TEST_SOURCE, targetDb = process.env.CI_BACKUP_PG_TEST_TARGET;
  assert.match(sourceDb || '', /^ci_backup_stage_[0-9a-f]{16,32}$/); assert.match(targetDb || '', /^ci_backup_stage_[0-9a-f]{16,32}$/);
  assert.notEqual(sourceDb, targetDb); const port = Number(process.env.CI_BACKUP_PG_TEST_PORT);
  assert(Number.isInteger(port) && port > 1024 && port <= 65535);
  const env = { PGPASSWORD: process.env.CI_BACKUP_PG_TEST_PASSWORD };
  if (process.env.CI_BACKUP_PG_TEST_LIBRARY) env.DYLD_LIBRARY_PATH = process.env.CI_BACKUP_PG_TEST_LIBRARY;
  const options = database => ({ psqlPath, migrationRoot: awaitableRoot, installationId: INSTALLATION, mode: 'staging',
    connection: { host: '127.0.0.1', port, user: process.env.CI_BACKUP_PG_TEST_USER, database }, env });
  const awaitableRoot = await fs.realpath(migrationRoot);
  const source = await createBackupPostgres(options(sourceDb)), target = await createBackupPostgres(options(targetDb));
  t.after(async () => { await source.close(); await target.close(); });
  await source.initializeStaging(); await target.initializeStaging();
  const sql = (database, text) => {
    const result = spawnSync(psqlPath, ['-X', '--no-password', '--quiet', '--tuples-only', '--no-align', '--set=ON_ERROR_STOP=1',
      '--host=127.0.0.1', `--port=${port}`, `--username=${process.env.CI_BACKUP_PG_TEST_USER}`, `--dbname=${database}`, '--file=-'],
    { input: text, env: { ...env, PGCLIENTENCODING: 'UTF8', LC_ALL: 'C' }, encoding: 'utf8', timeout: 30_000, maxBuffer: 8 * 1024 * 1024 });
    assert.equal(result.status, 0, 'Synthetic fixture SQL failed; raw database output is intentionally omitted.'); return result.stdout.trim();
  };
  const text = note().values.content_md;
  const encoded = Buffer.from(text).toString('base64');
  sql(sourceDb, `insert into users(id,github_id,login,local_key,identity_type) values(${ID},null,'local','${INSTALLATION}','LOCAL');
    insert into users(id,github_id,login,identity_type) values(${OTHER_ID},1234,'github','GITHUB');
    insert into projects(id,user_id,name,repo_owner,repo_name,source_type) values(2,${ID},'fixture','fixture','fixture','LOCAL');
    insert into snapshots(id,project_id,commit_sha,status,source_contract_version) values(3,2,'${'a'.repeat(40)}','READY',1);
    insert into analysis_jobs(id,project_id,snapshot_id,type,status) values(4,2,3,'IMPORT','DONE');
    insert into source_blobs(project_id,sha256,byte_size,key_id) values(2,'${HASH}',3,'${'b'.repeat(32)}');
    insert into source_manifests(id,project_id,snapshot_id,job_id,contract_version,producer_version,source_kind,
      approval_manifest_sha256,limits_sha256,policy_version,file_count,byte_size)
      values('11111111-1111-4111-8111-111111111111',2,3,4,1,'fixture','LOCAL','${HASH}','${HASH}','fixture',1,3);
    insert into source_manifest_entries values('11111111-1111-4111-8111-111111111111',2,'src/a.ts','${HASH}','${'c'.repeat(40)}',3);
    update source_manifests set sealed_at='${NOW}';
    insert into analysis_generations(id,project_id,snapshot_id,source_manifest_id,job_id,contract_version,producer_version,status,
      fencing_epoch,committed_at) overriding system value values('22222222-2222-4222-8222-222222222222',2,3,
      '11111111-1111-4111-8111-111111111111',4,1,'fixture','COMMITTED',50,'${NOW}');
    update projects set current_snapshot_id=3,current_generation_id='22222222-2222-4222-8222-222222222222';
    insert into notes(id,project_id,title,content_md,created_at,updated_at) values(9007199254740989,2,'  title  ',convert_from(decode('${encoded}','base64'),'UTF8'),'${NOW}','${NOW}');
    insert into user_ai_settings(user_id,provider,model,encrypted_key,nonce,key_version) values(${ID},'openai','legacy','CREDENTIAL_SENTINEL',decode('aabb','hex'),1);
    insert into user_ai_preferences(user_id,provider,model,connection_state,revision) values(${ID},'gemini','current','ENABLED',7);
    insert into ai_conversations(id,project_id,snapshot_id,user_id) values(6,2,3,${ID});
    insert into ai_messages(id,conversation_id,role,content,context,claims) values(7,6,'USER','hello','null'::jsonb,null);
    insert into ai_usage_logs(user_id,provider,model,purpose,cost_estimate) values(${ID},'fixture','fixture','legacy',null);
    select setval('analysis_generations_fencing_epoch_seq',99,true);`);
  const exporter = await createBackupPostgres({ ...options(sourceDb), mode: 'export' }); t.after(() => exporter.close());
  const rows = []; const expected = await exporter.exportRows({ writeRow: row => rows.push(row) });
  assert(!JSON.stringify(rows).includes('CREDENTIAL_SENTINEL'));
  assert.equal(rows.find(r => r.table === 'notes').values.content_md, text);
  assert.deepEqual(rows.find(r => r.table === 'ai_messages').values.context, { json: null });
  assert.equal(rows.find(r => r.table === 'ai_messages').values.claims, null);
  const floor = zeroSequences(); floor['analysis_generations.fencing_epoch'] = '199';
  const accounting = [];
  const restored = await target.loadRows({ rows, expected, writeAccounting: r => accounting.push(r), liveOwnerUserId: ID,
    liveSequenceHighWater: floor, livePreferenceRevisionHighWater: { [ID]: '17' } });
  assert.equal(restored.tableCounts.notes, '1'); assert.equal(accounting.length, 0);
  assert.equal(sql(targetDb, 'select count(*) from user_ai_settings;'), '0');
  assert.equal(sql(targetDb, 'select connection_state||\':\'||revision::text||\':\'||provider from user_ai_preferences;'), 'OFF:18:gemini');
  assert.equal(sql(targetDb, "select nextval('analysis_generations_fencing_epoch_seq');"), '200');
  assert.equal(sql(targetDb, 'select source_contract_version from snapshots where id=3;'), '1');
  assert.equal(sql(targetDb, "select to_char(sealed_at at time zone 'UTC','YYYY-MM-DD\"T\"HH24:MI:SS.US\"Z\"') from source_manifests;"), NOW);
  const reread = []; await target.exportRows({ writeRow: row => reread.push(row) });
  assert.deepEqual(reread.find(r => r.table === 'notes'), rows.find(r => r.table === 'notes'));
  const measured = await exporter.measureExport();
  assert.equal(measured.rowFrameBytes, String(rows.reduce((total, row) => total + 4 + Buffer.byteLength(canonical({ kind: 'ROW', row })), 0)));
  assert.deepEqual(await exporter.readRetainedCommitTimes({ snapshotIds: ['3'] }), { 3: null }, 'snapshot.created_at is not commit provenance');
  const approval = digest => `insert into job_local_source_inputs(job_id,project_id,approval_token_sha256,purpose,schema_version,
    canonical_root,root_device,root_inode,policy_version,limits_sha256,manifest_sha256,selected_files,selected_bytes,approved_at)
    values(4,2,'${'d'.repeat(64)}','INITIAL',1,'/synthetic/not-read',1,2,'fixture','${HASH}','${digest}',1,3,'${NOW}');`;
  sql(sourceDb, approval('e'.repeat(64)));
  assert.deepEqual(await exporter.readRetainedCommitTimes({ snapshotIds: ['3'] }), { 3: null }, 'mismatched approval manifests are not fallback proof');
  sql(sourceDb, `delete from job_local_source_inputs; ${approval(HASH)}`);
  const approvedSecond = String(Math.floor(Date.parse(NOW) / 1000));
  assert.deepEqual(await exporter.readRetainedCommitTimes({ snapshotIds: ['3'] }), { 3: approvedSecond });
  sql(sourceDb, `insert into projects(id,user_id,name,repo_owner,repo_name,source_type) values(10,${OTHER_ID},'other','other','other','GITHUB');
    insert into commits(project_id,sha,committed_at) values(10,'${'a'.repeat(40)}','2001-01-01T00:00:00Z');`);
  assert.deepEqual(await exporter.readRetainedCommitTimes({ snapshotIds: ['3'] }), { 3: approvedSecond }, 'same SHA in another project cannot supply the timestamp');
  sql(sourceDb, `insert into commits(project_id,sha,committed_at) values(2,'${'a'.repeat(40)}','2020-01-02T03:04:05.987654Z');`);
  assert.deepEqual(await exporter.readRetainedCommitTimes({ snapshotIds: ['3'] }), { 3: '1577934245' });
  await rejects(exporter.readRetainedCommitTimes({ snapshotIds: ['3', '999'] }), 'INTEGRITY');
  sql(sourceDb, 'update ai_messages set context=\'{"unsafe":9007199254740993}\'::jsonb where id=7;');
  await rejects(exporter.exportRows({ writeRow: () => {} }), 'PRECISION');
});
