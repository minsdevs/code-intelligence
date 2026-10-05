'use strict';
const assert = require('node:assert/strict');
const test = require('node:test');
const crypto = require('node:crypto');
const fs = require('node:fs/promises');
const { spawnSync } = require('node:child_process');
const { EventEmitter } = require('node:events');
const { PassThrough, Writable } = require('node:stream');
const { createBackupDatabaseControl, BackupDatabaseError } = require('../src/backup-database.cjs');
const { retentionManifestSha256 } = require('../src/backup-retention.cjs');

const copy = value => JSON.parse(JSON.stringify(value));
const namesFor = id => ({ live: 'codeintel', stage: `ci_backup_stage_${id.replaceAll('-', '')}`,
  previous: `ci_backup_previous_${id.replaceAll('-', '')}`, failed: `ci_backup_failed_${id.replaceAll('-', '')}` });
const dbRow = (oid, allowConnections, bytes = '9007199254740993') => ({ oid, owner: 'fixture', allowConnections, bytes });
const rejected = (promise, suffix) => assert.rejects(promise, e => {
  assert(e instanceof BackupDatabaseError); if (suffix) assert.equal(e.code, `BACKUP_DATABASE_${suffix}`);
  assert(!String(e).includes('private-synthetic')); return true;
});
async function retentionFixture(t, patch = {}) {
  const transactionId = crypto.randomUUID(), names = namesFor(transactionId);
  const authority = { active: null, pendingMaintenance: null, completed: [], tombstones: [] };
  for (let i = 1; i <= 3; i++) authority.completed.push({ transactionId: i === 1 ? transactionId : crypto.randomUUID(), sequence: i,
    manifest: { root: { dev: '1', ino: String(i * 100) }, checkpoint: { bytes: '32', sha256: 'a'.repeat(64) },
      databases: i === 1 ? [{ slot: 'previous', oid: '12345' }] : [],
      topLevel: [{ name: 'checkpoint.cibackup', type: 'file', dev: '1', ino: String(i * 100 + 1) }] } });
  authority.tombstones.push({ transactionId, manifestSha256: retentionManifestSha256(authority.completed[0].manifest), state: 'BEGUN' });
  const controls = { databases: { codeintel: dbRow('54321', true), [names.previous]: dbRow('12345', false) },
    calls: [], foreignOid: false, sessions: false, readAuthority: null, beforeSql: null, response: null, failDrop: false };
  const spawn = (command, args, options) => {
    const child = new EventEmitter(); child.stdout = new PassThrough(); child.stderr = new PassThrough();
    let closed = false, sql = ''; const end = code => { if (closed) return; closed = true; child.stdout.end(); child.stderr.end(); child.emit('close', code); };
    const call = { command, args, options, sql: null, signals: [] }; controls.calls.push(call);
    child.kill = signal => { call.signals.push(signal); queueMicrotask(() => end(null)); return true; };
    child.stdin = new Writable({ write(bytes, _encoding, done) { sql += bytes.toString(); done(); } });
    child.stdin.on('finish', () => queueMicrotask(async () => {
      try {
        call.sql = sql; await controls.beforeSql?.(sql); let result;
        if (sql.includes("'owner',pg_catalog.pg_get_userbyid")) result = copy(controls.databases);
        else if (sql.includes("jsonb_build_object('absent'")) result = { absent: !controls.foreignOid };
        else if (sql.includes('drop database')) {
          assert.match(sql, /do \$retained\$/); assert(sql.includes('and not datallowconn')); assert(sql.includes('pg_catalog.pg_stat_activity'));
          const expected = controls.databases[names.previous];
          if (controls.failDrop || controls.sessions || !expected || expected.oid !== '12345' || expected.allowConnections
              || expected.owner !== 'fixture' || controls.databases.codeintel?.oid !== '54321') {
            child.stderr.write('private-synthetic SQL failure'); end(1); return;
          }
          delete controls.databases[names.previous]; result = { dropped: true };
        } else throw new Error('unexpected synthetic SQL');
        if (controls.response) result = controls.response(result, sql);
        child.stdout.write(JSON.stringify(result)); end(0);
      } catch { end(1); }
    })); return child;
  };
  const options = { psqlPath: await fs.realpath(process.execPath), connection: { host: '127.0.0.1', port: 54321, user: 'fixture' },
    liveDatabase: 'codeintel', env: { PGPASSWORD: 'private-synthetic-password' }, spawn,
    readRetentionAuthority: async () => { await controls.readAuthority?.(); return copy(authority); }, ...patch };
  const controller = await createBackupDatabaseControl(options); t.after(() => controller.close().catch(() => {}));
  return { transactionId, names, authority, controls, controller, options,
    request: { transactionId, databaseOid: '12345', slot: 'previous' } };
}

async function compatibilityFixture(t) {
  const retained = namesFor(crypto.randomUUID());
  const controls = { databases: { codeintel: dbRow('54321', true),
    [retained.previous]: dbRow('12345', false), [retained.failed]: dbRow('12346', false) },
    sessions: new Set(['54321']), calls: [], created: [], effects: [], beforeSql: null, response: null,
    failAt: null, loseAt: null, nextOid: 60000, fixtureErrors: [] };
  const original = copy(controls.databases);
  const spawn = (command, args, options) => {
    const child = new EventEmitter(); child.stdout = new PassThrough(); child.stderr = new PassThrough();
    let closed = false, sql = ''; const end = code => {
      if (closed) return; closed = true; child.stdout.end(); child.stderr.end(); child.emit('close', code);
    };
    const call = { command, args, options, sql: null, kind: null, names: [], signals: [] }; controls.calls.push(call);
    child.kill = signal => { call.signals.push(signal); queueMicrotask(() => end(null)); return true; };
    child.stdin = new Writable({ write(bytes, _encoding, done) { sql += bytes.toString(); done(); } });
    child.stdin.on('finish', () => queueMicrotask(async () => {
      try {
        call.sql = sql;
        call.kind = sql.includes("'owner',pg_catalog.pg_get_userbyid") ? 'inspect'
          : sql.includes('create database') ? 'create' : sql.includes('allow_connections false') ? 'disable'
            : sql.includes('drop database') ? 'drop' : sql.includes("jsonb_build_object('absent'") ? 'absent' : 'unknown';
        if (call.kind === 'inspect') call.names = [...sql.match(/d\.datname in \(([^)]+)\)/)[1].matchAll(/'([^']+)'/g)].map(m => m[1]);
        await controls.beforeSql?.(call);
        if (controls.failAt === call.kind) { child.stderr.write('private-synthetic SQL failure'); end(1); return; }
        let result;
        if (call.kind === 'inspect') result = copy(Object.fromEntries(call.names.filter(name => controls.databases[name])
          .map(name => [name, controls.databases[name]])));
        else if (call.kind === 'create') {
          const name = sql.match(/create database "([^"]+)"/)[1]; assert.match(name, /^ci_backup_stage_[0-9a-f]{32}$/);
          assert(sql.includes("with template=template0 encoding='UTF8'")); assert(sql.includes("'stageOid'"));
          if (controls.databases[name]) { end(1); return; }
          const id = name.slice('ci_backup_stage_'.length).replace(/^(.{8})(.{4})(.{4})(.{4})(.{12})$/, '$1-$2-$3-$4-$5');
          const created = { names: namesFor(id), transactionId: id, oid: String(controls.nextOid++), liveOid: controls.databases.codeintel?.oid };
          controls.created.push(created); controls.databases[name] = dbRow(created.oid, true);
          result = { ok: true, stageOid: created.oid };
        } else if (call.kind === 'disable' || call.kind === 'drop') {
          const name = sql.match(/(?:alter|drop) database "([^"]+)"/)[1];
          const acquired = controls.created.find(row => row.names.stage === name); assert(acquired);
          const enabled = call.kind === 'disable';
          assert.match(sql, /do \$compatibility\$/);
          assert(sql.includes(`datname='codeintel' and oid='${acquired.liveOid}'::oid\n          and datallowconn`));
          assert(sql.includes(`datname='${name}' and oid='${acquired.oid}'::oid\n          and ${enabled ? '' : 'not '}datallowconn`));
          assert.equal((sql.match(/datdba=\(select oid from pg_catalog\.pg_roles where rolname=current_user\)/g) || []).length, 2);
          assert(sql.includes(`datname in ('${acquired.names.previous}','${acquired.names.failed}')`));
          assert(sql.includes(`pg_catalog.pg_stat_activity where datid='${acquired.oid}'::oid`));
          assert(!sql.includes(`pg_catalog.pg_stat_activity where datid='${acquired.liveOid}'::oid`));
          assert(!/\bforce\b|drop database if exists|pg_terminate_backend/i.test(sql));
          const live = controls.databases.codeintel, probe = controls.databases[name];
          if (live?.oid !== acquired.liveOid || live.owner !== 'fixture' || !live.allowConnections
              || probe?.oid !== acquired.oid || probe.owner !== 'fixture' || probe.allowConnections !== enabled
              || controls.databases[acquired.names.previous] || controls.databases[acquired.names.failed]
              || controls.sessions.has(acquired.oid)) { end(1); return; }
          if (enabled) { assert(sql.includes('begin;')); probe.allowConnections = false; result = { disabled: true }; }
          else { assert(!sql.includes('begin;')); delete controls.databases[name]; result = { dropped: true }; }
          controls.effects.push({ kind: call.kind, name, oid: acquired.oid });
        } else if (call.kind === 'absent') {
          const [, expectedOid, name] = sql.match(/where oid='([0-9]+)'::oid or datname='([^']+)'/);
          result = { absent: !controls.databases[name] && !Object.values(controls.databases).some(row => row.oid === expectedOid) };
        } else assert.fail('unexpected synthetic compatibility SQL');
        if (controls.response) result = controls.response(result, call);
        if (controls.loseAt === call.kind) { child.stderr.write('private-synthetic lost response'); end(1); return; }
        child.stdout.write(JSON.stringify(result)); end(0);
      } catch (error) { if (error?.code === 'ERR_ASSERTION') controls.fixtureErrors.push(error.message); end(1); }
    })); return child;
  };
  const controller = await createBackupDatabaseControl({ psqlPath: await fs.realpath(process.execPath),
    connection: { host: '127.0.0.1', port: 54321, user: 'fixture' }, liveDatabase: 'codeintel',
    env: { PGPASSWORD: 'private-synthetic-password' }, spawn });
  t.after(async () => { await controller.close().catch(() => {}); assert.deepEqual(controls.fixtureErrors, []); });
  return { controller, controls, original };
}

test('compatibility stage is fresh, internally named and cleaned only after its adapter closes while live sessions remain', async t => {
  const f = await compatibilityFixture(t), expected = Object.freeze({ compatible: true }); let adapterClosed = false;
  f.controls.beforeSql = call => { if (call.kind === 'disable' || call.kind === 'drop') assert.equal(adapterClosed, true); };
  const result = await f.controller.withCompatibilityStage(async (...args) => {
    assert.equal(args.length, 1); const [name] = args;
    assert.match(name, /^ci_backup_stage_[0-9a-f]{12}4[0-9a-f]{3}[89ab][0-9a-f]{15}$/);
    const stageOid = f.controls.databases[name].oid; f.controls.sessions.add(stageOid);
    try { return expected; } finally {
      await new Promise(resolve => setImmediate(resolve)); f.controls.sessions.delete(stageOid); adapterClosed = true;
    }
  });
  assert.equal(result, expected); assert.deepEqual(f.controls.databases, f.original); assert(f.controls.sessions.has('54321'));
  assert.equal(f.controls.created.length, 1);
  assert.deepEqual(f.controls.effects, ['disable', 'drop'].map(kind => ({ kind,
    name: f.controls.created[0].names.stage, oid: f.controls.created[0].oid })));
  assert.deepEqual(f.controls.calls.map(c => c.kind), ['inspect', 'create', 'inspect', 'inspect', 'disable', 'inspect', 'drop', 'inspect', 'absent']);
  for (const call of f.controls.calls) { assert(call.args.includes('--dbname=postgres')); assert.deepEqual(call.signals, []); }
});

for (const [name, error, asynchronous] of [
  ['typed incompatibility', Object.assign(new Error('incompatible'), { code: 'BACKUP_RUNTIME_INCOMPATIBLE', recoveryRequired: false }), false],
  ['unknown Error', new Error('unknown trusted callback error'), true],
  ['unknown string', 'trusted callback failed', false], ['null', null, true], ['undefined', undefined, false]
]) test(`compatibility ${name} is rethrown only after cleanup succeeds`, async t => {
  const f = await compatibilityFixture(t);
  const callback = asynchronous ? async () => { throw error; } : () => { throw error; };
  await assert.rejects(f.controller.withCompatibilityStage(callback), actual => {
    assert.equal(actual, error); assert.deepEqual(f.controls.databases, f.original);
    assert.equal(f.controls.calls.at(-1).kind, 'absent'); return true;
  });
});

test('compatibility rejects unknown callback types before creating a database', async t => {
  const f = await compatibilityFixture(t);
  for (const callback of [undefined, null, {}, [], 'drop database codeintel', { callback() {} }, 1]) {
    await rejected(f.controller.withCompatibilityStage(callback), 'INVALID');
  }
  assert.equal(f.controls.calls.length, 0);
});

test('compatibility rejects an already closed controller before creating a database', async t => {
  const f = await compatibilityFixture(t); await f.controller.close();
  await rejected(f.controller.withCompatibilityStage(() => assert.fail('closed callback ran')), 'UNAVAILABLE');
  assert.equal(f.controls.calls.length, 0);
});

test('compatibility holds serialization across its callback and rejects reentry, every method and controller close', async t => {
  const f = await compatibilityFixture(t); let enter, release;
  const entered = new Promise(resolve => { enter = resolve; }), gate = new Promise(resolve => { release = resolve; });
  const pending = f.controller.withCompatibilityStage(async () => { enter(); await gate; return 42; }); await entered;
  const id = crypto.randomUUID(), calls = f.controls.calls.length;
  try {
    for (const request of [() => f.controller.withCompatibilityStage(() => assert.fail('concurrent callback ran')),
      () => f.controller.inspect(id), () => f.controller.createStage({ transactionId: id }),
      () => f.controller.swap({ transactionId: id, liveOid: '54321', stageOid: '60000' }),
      () => f.controller.rollback({ transactionId: id, liveOid: '54321', stageOid: '60000' }),
      () => f.controller.verifyQuiescent(), () => f.controller.readSizes({ transactionId: id }),
      () => f.controller.dropRetained({ transactionId: id, databaseOid: '12345', slot: 'previous' })]) await rejected(request(), 'UNAVAILABLE');
    await rejected(f.controller.close(), 'BUSY'); assert.equal(f.controls.calls.length, calls);
  } finally { release(); }
  assert.equal(await pending, 42); assert.deepEqual(f.controls.databases, f.original);
  await f.controller.withCompatibilityStage(() => true);
  assert.notEqual(f.controls.created[0].names.stage, f.controls.created[1].names.stage);
  assert.deepEqual(f.controls.databases, f.original);
});

for (const phase of ['create', 'disable', 'drop', 'absent']) test(`compatibility serializes the ${phase} phase as part of the full scope`, async t => {
  const f = await compatibilityFixture(t); let enter, release;
  const entered = new Promise(resolve => { enter = resolve; }), gate = new Promise(resolve => { release = resolve; });
  f.controls.beforeSql = async call => { if (call.kind === phase) { enter(); await gate; } };
  const pending = f.controller.withCompatibilityStage(() => true); await entered;
  try {
    await rejected(f.controller.inspect(crypto.randomUUID()), 'UNAVAILABLE');
    await rejected(f.controller.withCompatibilityStage(() => false), 'UNAVAILABLE'); await rejected(f.controller.close(), 'BUSY');
  } finally { release(); }
  assert.equal(await pending, true); assert.deepEqual(f.controls.databases, f.original);
});

for (const [name, mutate] of [
  ['stage owner changed', (f, created) => { f.controls.databases[created.names.stage].owner = 'foreign'; }],
  ['stage OID changed', (f, created) => { f.controls.databases[created.names.stage].oid = '99999'; }],
  ['stage removed', (f, created) => { delete f.controls.databases[created.names.stage]; }],
  ['stage disabled by callback', (f, created) => { f.controls.databases[created.names.stage].allowConnections = false; }],
  ['stage renamed to previous', (f, created) => { f.controls.databases[created.names.previous] = f.controls.databases[created.names.stage]; delete f.controls.databases[created.names.stage]; }],
  ['stage renamed to failed', (f, created) => { f.controls.databases[created.names.failed] = f.controls.databases[created.names.stage]; delete f.controls.databases[created.names.stage]; }],
  ['previous slot appeared', (f, created) => { f.controls.databases[created.names.previous] = dbRow('22222', false); }],
  ['failed slot appeared', (f, created) => { f.controls.databases[created.names.failed] = dbRow('22222', false); }],
  ['live owner changed', f => { f.controls.databases.codeintel.owner = 'foreign'; }],
  ['live OID changed', f => { f.controls.databases.codeintel.oid = '99999'; }],
  ['live disabled', f => { f.controls.databases.codeintel.allowConnections = false; }],
  ['live removed', f => { delete f.controls.databases.codeintel; }],
  ['stage became live', (f, created) => { f.controls.databases.codeintel = f.controls.databases[created.names.stage]; delete f.controls.databases[created.names.stage]; }]
]) test(`compatibility cleanup refuses ${name} without disabling or dropping any database`, async t => {
  const f = await compatibilityFixture(t); let changed;
  await rejected(f.controller.withCompatibilityStage(() => { mutate(f, f.controls.created[0]); changed = copy(f.controls.databases); }), 'CLEANUP');
  assert.deepEqual(f.controls.databases, changed); assert.deepEqual(f.controls.effects, []);
  assert(!f.controls.calls.some(call => ['disable', 'drop'].includes(call.kind)));
});

for (const phase of ['disable', 'drop']) for (const [name, mutate] of [
  ['stage session appeared', (f, created) => f.controls.sessions.add(created.oid)],
  ['stage owner changed', (f, created) => { f.controls.databases[created.names.stage].owner = 'foreign'; }],
  ['stage OID changed', (f, created) => { f.controls.databases[created.names.stage].oid = '99999'; }],
  ['live owner changed', f => { f.controls.databases.codeintel.owner = 'foreign'; }],
  ['live OID changed', f => { f.controls.databases.codeintel.oid = '99999'; }],
  ['live disabled', f => { f.controls.databases.codeintel.allowConnections = false; }],
  ['previous slot appeared', (f, created) => { f.controls.databases[created.names.previous] = dbRow('22222', false); }],
  ['stage connection state changed', (f, created) => { const row = f.controls.databases[created.names.stage]; row.allowConnections = !row.allowConnections; }]
]) test(`compatibility server recheck refuses ${name} immediately before ${phase}`, async t => {
  const f = await compatibilityFixture(t); let changed;
  f.controls.beforeSql = call => { if (call.kind === phase) { mutate(f, f.controls.created[0]); changed = copy(f.controls.databases); } };
  await rejected(f.controller.withCompatibilityStage(() => true), 'CLEANUP');
  assert.deepEqual(f.controls.databases, changed); assert(!f.controls.effects.some(effect => effect.kind === 'drop'));
  assert.equal(f.controls.effects.length, phase === 'disable' ? 0 : 1);
});

test('compatibility refuses a stage adapter session left open when its callback rejects', async t => {
  const f = await compatibilityFixture(t);
  await rejected(f.controller.withCompatibilityStage(() => {
    f.controls.sessions.add(f.controls.created[0].oid); throw new Error('trusted callback failed before adapter close');
  }), 'CLEANUP');
  assert.deepEqual(f.controls.effects, []); assert.equal(f.controls.databases[f.controls.created[0].names.stage].allowConnections, true);
});

for (const callbackFails of [false, true]) test(`compatibility cleanup failure takes precedence over callback ${callbackFails ? 'failure' : 'success'}`, async t => {
  const f = await compatibilityFixture(t); f.controls.failAt = 'drop';
  await rejected(f.controller.withCompatibilityStage(() => {
    if (callbackFails) throw Object.assign(new Error('incompatible'), { code: 'BACKUP_RUNTIME_INCOMPATIBLE' }); return true;
  }), 'CLEANUP');
  assert.equal(f.controls.databases[f.controls.created[0].names.stage].allowConnections, false);
  assert.deepEqual(f.controls.databases.codeintel, f.original.codeintel); assert(!f.controls.effects.some(effect => effect.kind === 'drop'));
});

for (const [name, setup] of [
  ['CREATE failed', f => { f.controls.failAt = 'create'; }],
  ['CREATE response lost', f => { f.controls.loseAt = 'create'; }],
  ['CREATE success receipt missing', f => { f.controls.response = (value, call) => call.kind === 'create' ? {} : value; }],
  ['CREATE success receipt false', f => { f.controls.response = (value, call) => call.kind === 'create' ? { ...value, ok: false } : value; }],
  ['CREATE OID receipt malformed', f => { f.controls.response = (value, call) => call.kind === 'create' ? { ...value, stageOid: '0' } : value; }],
  ['CREATE identity readback changed', f => { f.controls.response = (value, call) => {
    if (call.kind === 'create') f.controls.databases[f.controls.created[0].names.stage].oid = '99999'; return value;
  }; }],
  ['CREATE identity readback lost', f => { f.controls.beforeSql = call => {
    if (call.kind === 'inspect' && f.controls.created.length) f.controls.failAt = 'inspect';
  }; }]
]) test(`compatibility leaves unacquired residue untouched when ${name}`, async t => {
  const f = await compatibilityFixture(t); setup(f); let called = false;
  await rejected(f.controller.withCompatibilityStage(() => { called = true; }));
  assert.equal(called, false); assert.deepEqual(f.controls.effects, []);
  assert(!f.controls.calls.some(call => ['disable', 'drop', 'absent'].includes(call.kind)));
  if (f.controls.created.length) assert(f.controls.databases[f.controls.created[0].names.stage]);
  assert.deepEqual(f.controls.databases.codeintel, f.original.codeintel);
});

for (const slot of ['stage', 'previous', 'failed']) test(`compatibility never adopts a pre-existing ${slot} name`, async t => {
  const f = await compatibilityFixture(t); let collision;
  f.controls.beforeSql = call => {
    if (call.kind === 'inspect') { collision = call.names.find(name => name.startsWith(`ci_backup_${slot}_`));
      f.controls.databases[collision] = dbRow('88888', slot === 'stage'); }
  };
  await rejected(f.controller.withCompatibilityStage(() => assert.fail('collision callback ran')), 'NOT_FRESH');
  assert.equal(f.controls.created.length, 0); assert.deepEqual(f.controls.effects, []); assert.equal(f.controls.databases[collision].oid, '88888');
});

for (const phase of ['disable', 'drop', 'absent']) for (const mode of ['lost', 'missing receipt']) {
  test(`compatibility cleanup rejects ${phase} ${mode} and never retries an uncertain mutation`, async t => {
    const f = await compatibilityFixture(t);
    if (mode === 'lost') f.controls.loseAt = phase;
    else f.controls.response = (value, call) => call.kind === phase ? {} : value;
    await rejected(f.controller.withCompatibilityStage(() => true), 'CLEANUP');
    assert.equal(f.controls.calls.filter(call => call.kind === phase).length, 1);
    assert.deepEqual(f.controls.databases.codeintel, f.original.codeintel);
    if (phase === 'disable') assert(!f.controls.calls.some(call => call.kind === 'drop'));
  });
}

for (const [name, change] of [
  ['stage name reappeared', (f, created) => { f.controls.databases[created.names.stage] = dbRow('99999', true); }],
  ['stage OID moved outside generated names', (f, created) => { f.controls.databases.foreign_name = dbRow(created.oid, true); }],
  ['live OID changed', f => { f.controls.databases.codeintel.oid = '99999'; }]
]) test(`compatibility readback rejects when ${name} after DROP, without another deletion`, async t => {
  const f = await compatibilityFixture(t);
  f.controls.response = (value, call) => { if (call.kind === 'drop') change(f, f.controls.created[0]); return value; };
  await rejected(f.controller.withCompatibilityStage(() => true), 'CLEANUP');
  assert.equal(f.controls.effects.filter(effect => effect.kind === 'drop').length, 1);
  assert.equal(f.controls.calls.filter(call => call.kind === 'drop').length, 1);
  if (name.includes('outside')) assert.equal(f.controls.calls.at(-1).kind, 'absent');
});

test('readSizes retains exact bigint physical bytes and marks nonexistent generated slots as null', async t => {
  const f = await retentionFixture(t), result = await f.controller.readSizes({ transactionId: f.transactionId });
  assert.equal(result.liveDatabaseBytes, '9007199254740993');
  assert.deepEqual(result.databases.previous, { oid: '12345', bytes: '9007199254740993' });
  assert.equal(result.databases.stage, null); assert.equal(result.databases.failed, null); assert(Object.isFrozen(result.databases.live));
  const c = f.controls.calls[0]; assert(c.args.includes('-X')); assert(c.args.includes('--file=-'));
  assert(!c.args.join(' ').includes('select')); assert(!c.args.join(' ').includes('private-synthetic'));
  for (const key of ['PATH', 'HOME', 'PGOPTIONS', 'PGSERVICE', 'NODE_OPTIONS']) assert.equal(c.options.env[key], undefined);
});
test('readSizes rejects numeric, negative, noncanonical and overflowing physical byte results', async t => {
  const f = await retentionFixture(t);
  for (const value of [123, '-1', '01', '1\n', '9223372036854775808']) {
    f.controls.databases.codeintel.bytes = value; await rejected(f.controller.readSizes({ transactionId: f.transactionId }));
  }
});
test('retained DB drop is exact OID/slot bound, disabled and read back without touching live DB', async t => {
  const f = await retentionFixture(t), result = await f.controller.dropRetained(f.request);
  assert.equal(result.absent, false); assert.equal(f.controls.databases.codeintel.oid, '54321');
  assert.equal(f.controls.databases[f.names.previous], undefined);
  const drop = f.controls.calls.find(c => c.sql.includes('drop database'));
  assert(drop.sql.includes(`drop database "${f.names.previous}"`)); assert(!drop.sql.includes('force'));
  assert(!drop.sql.includes('drop database if exists')); assert(!drop.sql.includes('begin;'));
  assert.equal(f.controls.calls.length, 3);
});
test('repeat drop requires authenticated tombstone and global OID absence', async t => {
  const f = await retentionFixture(t); delete f.controls.databases[f.names.previous];
  const result = await f.controller.dropRetained(f.request); assert.equal(result.absent, true);
  assert(f.controls.calls.some(c => c.sql.includes("jsonb_build_object('absent'")));
  assert(!f.controls.calls.some(c => c.sql.includes('drop database')));
  f.controls.foreignOid = true; await rejected(f.controller.dropRetained(f.request), 'CHANGED');
});
test('completed tombstone permits absent retry but refuses a reappearing database', async t => {
  const f = await retentionFixture(t); f.authority.tombstones[0].state = 'COMPLETED';
  await rejected(f.controller.dropRetained(f.request), 'CHANGED'); delete f.controls.databases[f.names.previous];
  assert.equal((await f.controller.dropRetained(f.request)).absent, true);
});
test('caller verified or completion-authority values cannot substitute for the private getter', async t => {
  const f = await retentionFixture(t);
  await rejected(f.controller.dropRetained({ ...f.request, completionAuthority: { verified: true } }), 'INVALID');
  const options = { ...f.options }; delete options.readRetentionAuthority;
  const unbound = await createBackupDatabaseControl(options); t.after(() => unbound.close());
  await rejected(unbound.dropRetained(f.request), 'AUTHORITY'); assert.equal(f.controls.calls.length, 0);
});
for (const [name, mutate] of [
  ['missing GC_BEGIN', f => { f.authority.tombstones = []; }],
  ['active transaction', f => { f.authority.active = crypto.randomUUID(); }],
  ['pending B maintenance', f => { f.authority.pendingMaintenance = crypto.randomUUID(); }],
  ['forged manifest digest', f => { f.authority.tombstones[0].manifestSha256 = '0'.repeat(64); }],
  ['manifest OID substitution', f => { f.authority.completed[0].manifest.databases[0].oid = '12346'; }],
  ['newest-two checkpoint', f => { f.authority.completed[0].sequence = 4; }]
]) test(`${name} denies DB collection before any PostgreSQL process`, async t => {
  const f = await retentionFixture(t); mutate(f); await rejected(f.controller.dropRetained(f.request), 'AUTHORITY'); assert.equal(f.controls.calls.length, 0);
});
for (const [name, mutate] of [
  ['OID mismatch', f => { f.controls.databases[f.names.previous].oid = '12346'; }],
  ['connections still allowed', f => { f.controls.databases[f.names.previous].allowConnections = true; }],
  ['foreign owner', f => { f.controls.databases[f.names.previous].owner = 'other'; }],
  ['current live OID', f => { f.controls.databases.codeintel.oid = '12345'; }],
  ['missing live database', f => { delete f.controls.databases.codeintel; }],
  ['disabled live database', f => { f.controls.databases.codeintel.allowConnections = false; }],
  ['retained OID renamed to stage', f => { f.controls.databases[f.names.stage] = f.controls.databases[f.names.previous]; delete f.controls.databases[f.names.previous]; }]
]) test(`${name} never reaches DROP`, async t => {
  const f = await retentionFixture(t); mutate(f); await rejected(f.controller.dropRetained(f.request));
  assert(!f.controls.calls.some(c => c.sql.includes('drop database')));
});
test('a session or ownership change between client check and server check fails without dropping', async t => {
  const f = await retentionFixture(t); f.controls.sessions = true;
  await rejected(f.controller.dropRetained(f.request), 'FAILED'); assert(f.controls.databases[f.names.previous]);
  f.controls.sessions = false; f.controls.beforeSql = async sql => { if (sql.includes('drop database')) f.controls.databases[f.names.previous].owner = 'other'; };
  await rejected(f.controller.dropRetained(f.request), 'FAILED'); assert(f.controls.databases[f.names.previous]);
});
test('authority revocation after inspect prevents DROP', async t => {
  const f = await retentionFixture(t); let reads = 0;
  f.controls.readAuthority = async () => { if (++reads === 2) f.authority.active = crypto.randomUUID(); };
  await rejected(f.controller.dropRetained(f.request), 'AUTHORITY'); assert(!f.controls.calls.some(c => c.sql.includes('drop database')));
});
test('a missing explicit SQL success receipt is failure even when the DB happened to drop', async t => {
  const f = await retentionFixture(t); f.controls.response = (value, sql) => sql.includes('drop database') ? {} : value;
  await rejected(f.controller.dropRetained(f.request)); assert.equal(f.authority.tombstones[0].state, 'BEGUN');
});
test('slot/UUID/OID manipulation is rejected without a process', async t => {
  const f = await retentionFixture(t);
  for (const patch of [{ slot: 'live' }, { slot: 'stage' }, { slot: 'previous;drop' }, { transactionId: '../elsewhere' },
    { databaseOid: '0' }, { databaseOid: '01' }, { databaseOid: '4294967296' }]) await rejected(f.controller.dropRetained({ ...f.request, ...patch }));
  assert.equal(f.controls.calls.length, 0);
});
test('controller serializes the whole authority-check mutation, not just each spawned command', async t => {
  const f = await retentionFixture(t); let release;
  f.controls.readAuthority = () => new Promise(resolve => { release = resolve; }); const pending = f.controller.dropRetained(f.request);
  while (!release) await new Promise(resolve => setImmediate(resolve));
  await rejected(f.controller.inspect(f.transactionId), 'UNAVAILABLE'); await rejected(f.controller.dropRetained(f.request), 'UNAVAILABLE');
  f.controls.readAuthority = null; release(); await pending;
});

test('database controller rejects renderer-style names and foreign libpq options before spawning', async () => {
  const good = { psqlPath: await fs.realpath(process.execPath), connection: { host: '127.0.0.1', port: 54321, user: 'fixture' },
    liveDatabase: 'codeintel', env: { PGPASSWORD: 'public-synthetic-only' }, spawn() { assert.fail('unexpected process'); } };
  for (const patch of [{ liveDatabase: 'postgres' }, { liveDatabase: 'codeintel;drop database postgres' },
    { connection: { ...good.connection, host: 'remote.example' } }, { env: { ...good.env, PGOPTIONS: '-c test=x' } },
    { psqlPath: '/tmp/no-such-backup-control-binary' }]) {
    await assert.rejects(createBackupDatabaseControl({ ...good, ...patch }), BackupDatabaseError);
  }
  const controller = await createBackupDatabaseControl(good);
  for (const value of ['../outside', crypto.randomUUID().toUpperCase(), 'x']) await assert.rejects(controller.inspect(value), BackupDatabaseError);
  await controller.close();
});

test('actual isolated PostgreSQL swaps and rolls back by OID without deleting either database',
  { skip: !process.env.CI_BACKUP_PG_TEST_LIVE, timeout: 45000 }, async t => {
    const liveDatabase = process.env.CI_BACKUP_PG_TEST_LIVE;
    assert.match(liveDatabase, /^ci_backup_live_[0-9a-f]{16,32}$/);
    const psqlPath = await fs.realpath(process.env.CI_BACKUP_PG_TEST_PSQL);
    const connection = { host: '127.0.0.1', port: Number(process.env.CI_BACKUP_PG_TEST_PORT), user: 'postgres' };
    const env = { PGPASSWORD: process.env.CI_BACKUP_PG_TEST_PASSWORD, PGSSLMODE: 'verify-full', PGSSLROOTCERT: process.env.PGSSLROOTCERT };
    function sql(database, text) {
      const result = spawnSync(psqlPath, ['-X', '--no-password', '--quiet', '--tuples-only', '--no-align',
        '--set=ON_ERROR_STOP=1', '--host=127.0.0.1', `--port=${connection.port}`, '--username=postgres', `--dbname=${database}`, '--file=-'],
      { env: { ...env, PGCLIENTENCODING: 'UTF8', LC_ALL: 'C' }, input: text, encoding: 'utf8', timeout: 10000 });
      assert.equal(result.status, 0, 'Synthetic PG query failed; contents suppressed'); return result.stdout.trim();
    }
    assert.equal(sql(liveDatabase, "select count(*) from pg_tables where schemaname='public'"), '0');
    sql(liveDatabase, `create table notes(id int primary key,body text);insert into notes values(1,'original synthetic note');
      create table analysis_jobs(status text);create table analysis_job_steps(status text);`);
    const control = await createBackupDatabaseControl({ psqlPath, connection, env, liveDatabase }); t.after(() => control.close());
    assert.equal(await control.verifyQuiescent(), true);
    sql(liveDatabase, "insert into analysis_jobs values('CANCELLING')");
    await assert.rejects(control.verifyQuiescent(), error => error.code === 'BACKUP_DATABASE_ACTIVE_WORK');
    sql(liveDatabase, 'delete from analysis_jobs');
    const transactionId = crypto.randomUUID(); const created = await control.createStage({ transactionId });
    await assert.rejects(control.createStage({ transactionId }), error => error.code === 'BACKUP_DATABASE_NOT_FRESH');
    sql(created.stageDatabase, "create table notes(id int primary key,body text);insert into notes values(1,'restored synthetic note')");
    const identity = { transactionId, liveOid: created.liveOid, stageOid: created.stageOid };
    await assert.rejects(control.swap({ ...identity, liveOid: '1' }), error => error.code === 'BACKUP_DATABASE_CHANGED');
    assert.equal(sql(liveDatabase, 'select body from notes'), 'original synthetic note');
    const swapped = await control.swap(identity);
    assert.equal(swapped.databases[swapped.names.previous].oid, created.liveOid);
    assert.equal(swapped.databases[swapped.names.previous].allowConnections, false);
    assert.equal(sql(liveDatabase, 'select body from notes'), 'restored synthetic note');
    assert.deepEqual(await control.swap(identity), swapped, 'a lost successful response can be read back idempotently');
    const rolledBack = await control.rollback(identity);
    assert.equal(rolledBack.databases[liveDatabase].oid, created.liveOid);
    assert.equal(rolledBack.databases[rolledBack.names.failed].oid, created.stageOid);
    assert.equal(rolledBack.databases[rolledBack.names.failed].allowConnections, false);
    assert.equal(sql(liveDatabase, 'select body from notes'), 'original synthetic note');
    assert.deepEqual(await control.rollback(identity), rolledBack);
  });

test('actual isolated PostgreSQL retention drops only an authenticated completed disabled failed slot',
  { skip: !process.env.CI_BACKUP_PG_TEST_LIVE, timeout: 45000 }, async t => {
    const liveDatabase = process.env.CI_BACKUP_PG_TEST_LIVE;
    assert.match(liveDatabase, /^ci_backup_live_[0-9a-f]{16,32}$/);
    const psqlPath = await fs.realpath(process.env.CI_BACKUP_PG_TEST_PSQL);
    const connection = { host: '127.0.0.1', port: Number(process.env.CI_BACKUP_PG_TEST_PORT), user: 'postgres' };
    const env = { PGPASSWORD: process.env.CI_BACKUP_PG_TEST_PASSWORD, PGSSLMODE: 'verify-full', PGSSLROOTCERT: process.env.PGSSLROOTCERT };
    if (process.env.CI_BACKUP_PG_TEST_LIBRARY) env.DYLD_LIBRARY_PATH = process.env.CI_BACKUP_PG_TEST_LIBRARY;
    const transactionId = crypto.randomUUID(), authority = { active: null, pendingMaintenance: null, completed: [], tombstones: [] };
    const control = await createBackupDatabaseControl({ psqlPath, connection, env, liveDatabase,
      readRetentionAuthority: async () => copy(authority) }); t.after(() => control.close());
    const created = await control.createStage({ transactionId }), identity = { transactionId, liveOid: created.liveOid, stageOid: created.stageOid };
    const sizes = await control.readSizes({ transactionId }); assert(BigInt(sizes.liveDatabaseBytes) > 0n);
    assert(BigInt(sizes.databases.stage.bytes) > 0n); await control.swap(identity); await control.rollback(identity);
    for (let i = 1; i <= 3; i++) authority.completed.push({ transactionId: i === 1 ? transactionId : crypto.randomUUID(), sequence: i,
      manifest: { root: { dev: '1', ino: String(i * 100) }, checkpoint: { bytes: '32', sha256: 'a'.repeat(64) },
        databases: i === 1 ? [{ slot: 'failed', oid: created.stageOid }] : [],
        topLevel: [{ name: 'checkpoint.cibackup', type: 'file', dev: '1', ino: String(i * 100 + 1) }] } });
    const request = { transactionId, databaseOid: created.stageOid, slot: 'failed' };
    await rejected(control.dropRetained(request), 'AUTHORITY');
    authority.tombstones.push({ transactionId, manifestSha256: retentionManifestSha256(authority.completed[0].manifest), state: 'BEGUN' });
    assert.equal((await control.dropRetained(request)).absent, false);
    const after = await control.inspect(transactionId); assert.equal(after.databases[liveDatabase].oid, created.liveOid);
    assert.equal(after.databases[after.names.failed], undefined); assert.equal((await control.dropRetained(request)).absent, true);
    authority.tombstones[0].state = 'COMPLETED'; assert.equal((await control.dropRetained(request)).absent, true);
    await rejected(control.dropRetained({ ...request, databaseOid: created.liveOid }), 'AUTHORITY');
  });
