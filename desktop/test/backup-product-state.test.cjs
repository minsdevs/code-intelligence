'use strict';

// Unit tests use only a synthetic directory and fake children. Real PostgreSQL semantics are
// intentionally left to root's isolated, owned-local-cluster integration fixture.
const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { PassThrough, Writable } = require('node:stream');
const { spawnSync } = require('node:child_process');
const { constants } = require('node:fs');
const { createBackupProductState, BackupProductStateError } = require('../src/backup-product-state.cjs');

const SYS = '18446744073709551615', START = '1790985600', PID = 424242, PORT = 6543;
const STAGE = 'ci_backup_stage_0123456789abcdef';
const RESULT = { kind: 'result', githubCredentials: '0', aiCredentials: '0', localApprovals: '0',
  localInputs: '0', localPaths: '0', nonOffPreferences: '0' };
const COMMIT_SQL = "commit;\nselect pg_catalog.jsonb_build_object('kind','committed');\n";
const copy = value => JSON.parse(JSON.stringify(value));
const tick = () => new Promise(resolve => setImmediate(resolve));
function nextWrite(f, count = 1) {
  let reached;
  const phase = new Promise(resolve => { reached = resolve; });
  f.controls.onWrite = call => { if (call.writes.length === count) reached(call); };
  return async work => {
    let timer;
    try {
      return await Promise.race([
        phase,
        work.then(() => assert.fail('operation completed before expected SQL phase')),
        new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('SQL phase was not reached')), 5000); }),
      ]);
    } finally { clearTimeout(timer); f.controls.onWrite = null; }
  };
}
function decodeInput(sql) {
  const match = sql.match(/decode\('([A-Za-z0-9+/=]+)','base64'\)/); assert(match);
  return JSON.parse(Buffer.from(match[1], 'base64').toString('utf8'));
}
async function rejects(promise, code) {
  await assert.rejects(promise, error => {
    assert(error instanceof BackupProductStateError);
    if (code) assert.equal(error.code, `BACKUP_PRODUCT_STATE_${code}`);
    assert.doesNotMatch(String(error), /synthetic-private|injected|SELECT|DELETE|postmaster\.pid|\/Users/);
    assert.equal(error.cause, undefined); return true;
  });
}
async function fixture(t, create = true, patch = {}) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'ci-product-state-unit-')));
  const pg = path.join(root, 'postgres'), data = path.join(root, 'data');
  await fs.mkdir(pg, { mode: 0o700 }); await fs.mkdir(data, { mode: 0o700 });
  // Spawn is faked; use an owned executable fixture instead of the runner's Node permissions.
  const psqlPath = path.join(root, 'psql-bin');
  await fs.writeFile(psqlPath, '#!/bin/sh\nexit 1\n', { mode: 0o700 });
  const pidPath = path.join(pg, 'postmaster.pid');
  const pidText = `${PID}\n${pg}\n${START}\n${PORT}\n/tmp\n127.0.0.1\n 1 2\nready   \n`;
  await fs.writeFile(pidPath, pidText, { mode: 0o600 });
  const owned = new EventEmitter(); owned.pid = PID; owned.exitCode = null; owned.signalCode = null; owned.killed = false;
  owned.on('error', () => {}); owned.kill = () => assert.fail('controller must never kill the PostgreSQL server');
  const calls = [], controls = { system: SYS, hangOrigin: false, hangResult: false, hangCommit: false,
    unreaped: false, killDelay: 0, exitCode: 0, originPatch: {}, resultPatch: null,
    output: null, onOrigin: null, onResult: null, onCommit: null, omitCommitReceipt: false, receiptPatch: null };
  const spawn = (command, args, options) => {
    const child = new EventEmitter(); child.pid = 123456; child.stdout = new PassThrough(); child.stderr = new PassThrough();
    const call = { command, args: [...args], options, sql: '', writes: [], signals: [], committed: false, child };
    calls.push(call); let stopped = false;
    function finish(code) { if (stopped) return; stopped = true; child.stdout.end(); child.stderr.end(); child.emit('close', code); }
    call.finish = finish;
    child.kill = signal => { call.signals.push(signal); if (!controls.unreaped) setTimeout(() => finish(null), controls.killDelay); return true; };
    async function respond(value, phase) {
      if (stopped) return;
      if (phase === 'origin') await controls.onOrigin?.(value, call);
      if (phase === 'result') await controls.onResult?.(value, call);
      if (stopped) return;
      if (controls.output) { await controls.output(value, phase, call); return; }
      child.stdout.write(`${JSON.stringify(value)}\n`);
    }
    child.stdin = new Writable({ write(chunk, _encoding, done) {
      const text = chunk.toString(); call.sql += text; call.writes.push(text); done();
      controls.onWrite?.(call);
      queueMicrotask(() => {
        if (stopped) return;
        if (text.startsWith('begin')) {
          if (controls.hangOrigin) return;
          const db = args.find(a => a.startsWith('--dbname=')).slice('--dbname='.length);
          respond({ kind: 'origin', systemIdentifier: controls.system, dataDirectory: pg, startEpochSeconds: START,
            port: PORT, database: db, user: 'codeintel', sessionUser: 'codeintel', ...controls.originPatch }, 'origin').catch(() => finish(1));
        } else if (text.startsWith('commit;\n')) {
          call.committed = true;
          Promise.resolve(controls.onCommit?.(call)).then(async () => {
            if (!controls.hangCommit) {
              if (controls.exitCode === 0 && !controls.omitCommitReceipt && text === COMMIT_SQL)
                await respond({ kind: 'committed', ...controls.receiptPatch }, 'committed');
              finish(controls.exitCode);
            }
          }).catch(() => finish(1));
        } else {
          if (controls.hangResult) return;
          let result;
          if (text.includes('do $backup_revoke$')) result = copy(RESULT);
          else if (text.includes('do $backup_paths$')) result = { kind: 'result', invalidPaths: '0', projectIds: decodeInput(text).projectIds };
          else result = { kind: 'result', ok: true };
          if (controls.resultPatch) Object.assign(result, controls.resultPatch);
          respond(result, 'result').catch(() => finish(1));
        }
      });
    } });
    return child;
  };
  const options = { psqlPath, connection: { host: '127.0.0.1', port: PORT, user: 'codeintel' },
    env: { PGPASSWORD: 'synthetic-private-password' }, expectedDataDirectory: pg, ownedPostgres: owned,
    dataRoot: data, spawn, timeoutMs: 2000, ...patch };
  const f = { root, pg, data, pidPath, pidText, owned, controls, calls, options, adapter: null };
  t.after(async () => { await f.adapter?.close().catch(() => {}); await fs.rm(root, { recursive: true, force: true }); });
  if (create) { f.adapter = await createBackupProductState(options); calls.length = 0; }
  return f;
}

test('initial SQL origin is bound to the actual owned child and private PID file; result is immutable', async t => {
  const f = await fixture(t, false); f.adapter = await createBackupProductState(f.options);
  assert.equal(f.calls.length, 1); const c = f.calls[0];
  assert.equal(c.writes.length, 3); assert.match(c.writes[0], /pg_control_system/);
  assert.doesNotMatch(c.writes[0], /backup_revoke|backup_paths|delete from|update public/i);
  assert.equal(c.writes[2], COMMIT_SQL); assert.equal(c.committed, true);
  const origin = await f.adapter.verifyOrigin(); assert(Object.isFrozen(origin));
  assert.deepEqual(origin, { systemIdentifier: SYS, dataDirectory: f.pg, postmasterPid: PID, startEpochSeconds: START, port: PORT });
  assert.deepEqual(Object.keys(f.adapter).sort(), ['close', 'rebindClonePaths', 'revokeCredentials', 'verifyOrigin']);
});
test('psql uses closed environment, stdin SQL and no shell, password argument, URL or rc files', async t => {
  const f = await fixture(t); await f.adapter.revokeCredentials({ database: 'codeintel' }); const c = f.calls[0];
  assert(c.args.includes('-X')); assert(c.args.includes('--file=-')); assert(c.args.includes('--set=ON_ERROR_STOP=1'));
  assert(c.args.includes('--no-password')); assert(c.args.includes('--host=127.0.0.1'));
  assert.doesNotMatch(c.args.join(' '), /synthetic-private|begin|delete|select|:\/\//i);
  assert.equal(c.options.shell, false); assert.equal(c.options.env.PGPASSWORD, 'synthetic-private-password');
  for (const key of ['PGOPTIONS', 'PGSERVICE', 'PGHOST', 'NODE_OPTIONS', 'PATH', 'HOME']) assert.equal(c.options.env[key], undefined);
  assert(c.sql.includes("set local search_path=pg_catalog;"));
  assert.match(c.sql, /statement_timeout='15000ms'/); assert.match(c.sql, /lock_timeout='5000ms'/);
});
test('credential revocation uses real V15/V22/V24 tables, preserves keyless preferences and product sessions', async t => {
  const f = await fixture(t); const result = await f.adapter.revokeCredentials({ database: 'codeintel' });
  assert.deepEqual(result, { credentialsCleared: true, localApprovalsCleared: true, localPathsCleared: true, preferencesOff: true });
  const sql = f.calls[0].sql;
  for (const table of ['github_credentials', 'user_ai_settings', 'local_source_approvals', 'job_local_source_inputs']) {
    assert(sql.includes(`delete from public.${table};`));
  }
  assert.match(sql, /on conflict\(user_id\) do nothing/); assert.match(sql, /connection_state='OFF',revision=revision\+1/);
  assert.match(sql, /revision=9223372036854775807/);
  assert.doesNotMatch(sql, /delete from public\.(?:users|user_ai_preferences|playground_sessions|ai_request_ledger|ai_usage_evidence|ai_budget_gate)/);
  assert.doesNotMatch(sql, /encrypted_key\s*=|encrypted_token\s*=|disable trigger|drop |truncate |pg_terminate_backend/i);
  assert.match(sql, /pg_stat_activity/); assert.match(sql, /'QUEUED','RUNNING','CANCELLING'/);
  assert.match(sql, /update public\.projects set local_path=null where local_path is not null/);
  assert.doesNotMatch(sql, /clone_path\s*=/);
});
test('already OFF keyless preferences keep revision; credentials or a non-OFF state advance it', async t => {
  const f = await fixture(t); await f.adapter.revokeCredentials({ database: 'codeintel' });
  assert.match(f.calls[0].sql, /where connection_state<>'OFF' or exists\(select 1 from public\.user_ai_settings s where s\.user_id=p\.user_id\)/);
});
test('Git stores for both GITHUB and legacy LOCAL projects use only fixed main paths and decimal IDs', async t => {
  const f = await fixture(t); const result = await f.adapter.rebindClonePaths({ database: STAGE,
    confirmedGitProjectIds: ['9223372036854775807', '10', '2'] });
  assert.deepEqual(result, { projectIds: ['2', '10', '9223372036854775807'], localPathsCleared: true });
  assert(Object.isFrozen(result)); assert(Object.isFrozen(result.projectIds));
  const c = f.calls[0]; assert(c.args.includes(`--dbname=${STAGE}`));
  assert.deepEqual(decodeInput(c.sql), { reposRoot: path.join(f.data, 'repos'), projectIds: result.projectIds });
  assert.match(c.sql, /source_type in \('GITHUB','LOCAL'\)/);
  assert.match(c.sql, /set local_path=null,clone_path=case/); assert.match(c.sql, /else null end/);
  assert.doesNotMatch(c.sql, /local_path\s*=\s*'/); assert.doesNotMatch(c.sql, /repo_owner|repo_name|source_type\s*=/);
  await assert.rejects(fs.stat(path.join(f.data, 'repos')), { code: 'ENOENT' }, 'controller must not create or execute source stores');
});
test('empty verified Git-store set clears all archived clone and local roots', async t => {
  const f = await fixture(t); await f.adapter.rebindClonePaths({ database: 'codeintel', confirmedGitProjectIds: [] });
  assert.deepEqual(decodeInput(f.calls[0].sql).projectIds, []);
});
test('caller mutation cannot replace copied connection, environment, or confirmed IDs during handshake', async t => {
  const f = await fixture(t); f.options.connection.host = 'remote.invalid'; f.options.env.PGPASSWORD = 'changed';
  f.controls.hangOrigin = true; const ids = ['2']; const ready = nextWrite(f);
  const work = f.adapter.rebindClonePaths({ database: 'codeintel', confirmedGitProjectIds: ids });
  const call = await ready(work); ids[0] = '9';
  f.controls.hangOrigin = false; call.child.stdout.write(JSON.stringify({ kind: 'origin', systemIdentifier: SYS,
    dataDirectory: f.pg, startEpochSeconds: START, port: PORT, database: 'codeintel', user: 'codeintel', sessionUser: 'codeintel' }) + '\n');
  assert.deepEqual((await work).projectIds, ['2']); assert.equal(f.calls[0].options.env.PGPASSWORD, 'synthetic-private-password');
});

for (const [name, change] of [
  ['remote host', f => { f.options.connection.host = 'localhost'; }],
  ['URL username', f => { f.options.connection.user = 'postgres://injected'; }],
  ['libpq environment injection', f => { f.options.env.PGOPTIONS = 'injected'; }],
  ['missing password', f => { delete f.options.env.PGPASSWORD; }],
  ['SQL factory field', f => { f.options.sql = 'injected'; }],
  ['relative binary', f => { f.options.psqlPath = './psql'; }],
  ['parent path spelling', f => { f.options.dataRoot += '/../data'; }],
  ['oversized deadline', f => { f.options.timeoutMs = 30001; }],
  ['PID-only authority', f => { f.options.ownedPostgres = PID; }],
  ['already exited child', f => { f.owned.exitCode = 0; }],
  ['terminating child', f => { f.owned.killed = true; }],
]) test(`invalid factory: ${name}`, async t => {
  const f = await fixture(t, false); change(f); await rejects(createBackupProductState(f.options)); assert.equal(f.calls.length, 0);
});
test('option getters are rejected without invocation', async t => {
  const f = await fixture(t, false); let called = false;
  Object.defineProperty(f.options, 'env', { enumerable: true, get() { called = true; throw new Error('injected'); } });
  await rejects(createBackupProductState(f.options), 'INVALID'); assert.equal(called, false); assert.equal(f.calls.length, 0);
});
test('factory and method proxies are rejected without invoking traps or leaking exceptions', async t => {
  const f = await fixture(t); const value = new Proxy({}, { getOwnPropertyDescriptor() { assert.fail('proxy trap invoked'); },
    getPrototypeOf() { assert.fail('proxy trap invoked'); }, ownKeys() { assert.fail('proxy trap invoked'); } });
  await rejects(createBackupProductState(value), 'INVALID');
  await rejects(f.adapter.revokeCredentials(value), 'INVALID'); assert.equal(f.calls.length, 0);
});
test('trusted connection and environment objects cannot contain getters or hidden fields', async t => {
  const f = await fixture(t, false);
  Object.defineProperty(f.options.connection, 'user', { get() { assert.fail('connection getter invoked'); }, enumerable: true });
  await rejects(createBackupProductState(f.options), 'INVALID');
  f.options.connection = { host: '127.0.0.1', port: PORT, user: 'codeintel' };
  Object.defineProperty(f.options.env, 'PGPASSWORD', { get() { assert.fail('credential getter invoked'); }, enumerable: true });
  await rejects(createBackupProductState(f.options), 'INVALID'); assert.equal(f.calls.length, 0);
});
test('spawn failure is sanitized and unregisters owned-process listeners', async t => {
  const f = await fixture(t, false); f.options.spawn = () => { throw new Error('synthetic-private spawn details'); };
  await rejects(createBackupProductState(f.options), 'FAILED'); assert.equal(f.owned.listenerCount('exit'), 0);
});
for (const name of ['postgres', 'ci_backup_previous_0123456789abcdef', 'ci_backup_stage_', 'codeintel\n',
  'ci_backup_stage_0123456789ABCDEF', 'codeintel;drop database x', 'postgres://remote/codeintel']) {
  test(`reject non-target database ${JSON.stringify(name)}`, async t => {
    const f = await fixture(t); await rejects(f.adapter.revokeCredentials({ database: name }), 'INVALID'); assert.equal(f.calls.length, 0);
  });
}
for (const ids of [['0'], ['01'], ['-1'], ['1\n'], [1], ['9223372036854775808'], ['1', '1'], ['../2'], new Array(1),
  Array(10001).fill('1')]) test(`invalid project set ${JSON.stringify(ids).slice(0, 70)}`, async t => {
  const f = await fixture(t); await rejects(f.adapter.rebindClonePaths({ database: STAGE, confirmedGitProjectIds: ids }), 'INVALID');
  assert.equal(f.calls.length, 0);
});
test('project accessor arrays and caller SQL/path fields are refused', async t => {
  const f = await fixture(t); const ids = [];
  Object.defineProperty(ids, '0', { get() { assert.fail('accessor executed'); }, enumerable: true });
  await rejects(f.adapter.rebindClonePaths({ database: STAGE, confirmedGitProjectIds: ids }), 'INVALID');
  await rejects(f.adapter.rebindClonePaths({ database: STAGE, confirmedGitProjectIds: [], reposRoot: '/injected' }), 'INVALID');
  await rejects(f.adapter.revokeCredentials({ database: 'codeintel', sql: 'injected' }), 'INVALID');
  assert.equal(f.calls.length, 0);
});

for (const [name, change] of [
  ['PG data directory symlink', async f => { const link = path.join(f.root, 'pg-link'); await fs.symlink(f.pg, link); f.options.expectedDataDirectory = link; }],
  ['data root symlink', async f => { const link = path.join(f.root, 'data-link'); await fs.symlink(f.data, link); f.options.dataRoot = link; }],
  ['psql symlink', async f => { const link = path.join(f.root, 'psql'); await fs.symlink(f.options.psqlPath, link); f.options.psqlPath = link; }],
  ['group writable psql', async f => { await fs.chmod(f.options.psqlPath, 0o775); }],
  ['non-executable psql', async f => { await fs.chmod(f.options.psqlPath, 0o600); }],
  ['PID symlink', async f => { const other = path.join(f.root, 'pid-copy'); await fs.rename(f.pidPath, other); await fs.symlink(other, f.pidPath); }],
  ['PID hard link', async f => { await fs.link(f.pidPath, path.join(f.root, 'pid-link')); }],
  ['public PID file', async f => { await fs.chmod(f.pidPath, 0o644); }],
  ['world writable directory', async f => { await fs.chmod(f.pg, 0o777); }],
  ['wrong PID', async f => { await fs.writeFile(f.pidPath, f.pidText.replace(String(PID), '1')); }],
  ['wrong PG port', async f => { await fs.writeFile(f.pidPath, f.pidText.replace(String(PORT), '5432')); }],
  ['wrong data path in PID file', async f => { await fs.writeFile(f.pidPath, f.pidText.replace(f.pg, '/injected')); }],
  ['oversized PID file', async f => { await fs.writeFile(f.pidPath, 'x'.repeat(4097)); }],
]) test(`unsafe origin before any SQL: ${name}`, async t => {
  const f = await fixture(t, false); await change(f); await rejects(createBackupProductState(f.options)); assert.equal(f.calls.length, 0);
});
for (const patch of [{ systemIdentifier: '18446744073709551616' }, { systemIdentifier: 123 }, { dataDirectory: '/injected' },
  { startEpochSeconds: '1' }, { startEpochSeconds: String(BigInt(START) - 1n) }, { startEpochSeconds: String(BigInt(START) + 3n) },
  { startEpochSeconds: Number(START) }, { port: PORT + 1 }, { database: 'wrong' }, { user: 'other' }, { sessionUser: 'other' }]) {
  test(`initial SQL origin mismatch ${Object.keys(patch)[0]} is refused`, async t => {
    const f = await fixture(t, false); f.controls.originPatch = patch;
    await rejects(createBackupProductState(f.options)); assert.equal(f.calls.length, 1);
    assert.equal(f.calls[0].writes.length, 1); assert.equal(f.calls[0].committed, false);
  });
}
for (const skew of [1n, 2n]) test(`SQL postmaster start ${skew}s after the lock-file start is the same owned origin`, async t => {
  const f = await fixture(t, false); const later = String(BigInt(START) + skew); f.controls.originPatch = { startEpochSeconds: later };
  const adapter = await createBackupProductState(f.options); t.after(() => adapter.close());
  assert.equal(f.calls.length, 1); assert.equal((await adapter.verifyOrigin()).startEpochSeconds, later);
});
test('later cluster system identifier change blocks all mutation SQL and permanently invalidates controller', async t => {
  const f = await fixture(t); f.controls.system = '123';
  await rejects(f.adapter.revokeCredentials({ database: 'codeintel' }), 'ORIGIN');
  assert.equal(f.calls[0].writes.length, 1); f.controls.system = SYS;
  await rejects(f.adapter.verifyOrigin(), 'ORIGIN'); assert.equal(f.calls.length, 1);
});
for (const [name, change] of [
  ['PG directory replaced', async f => { await fs.rename(f.pg, f.pg + '-previous'); await fs.mkdir(f.pg, { mode: 0o700 }); await fs.writeFile(f.pidPath, f.pidText, { mode: 0o600 }); }],
  ['product data root replaced', async f => { await fs.rename(f.data, f.data + '-previous'); await fs.mkdir(f.data, { mode: 0o700 }); }],
  ['PID file replaced', async f => { await fs.rename(f.pidPath, f.pidPath + '.previous'); await fs.writeFile(f.pidPath, f.pidText, { mode: 0o600 }); }],
  ['postmaster start changed', async f => { await fs.writeFile(f.pidPath, f.pidText.replace(START, '1790985601')); }],
  ['owned PID changed', async f => { f.owned.pid++; }],
  ['owned process exited', async f => { f.owned.emit('exit', 0); }],
  ['owned process error', async f => { f.owned.emit('error', new Error('synthetic-private')); }],
]) test(`binding cannot be reused after ${name}`, async t => {
  const f = await fixture(t); await change(f); await rejects(f.adapter.verifyOrigin(), 'ORIGIN'); assert.equal(f.calls.length, 0);
});
test('origin change while handshake is pending sends no mutation statement', async t => {
  const f = await fixture(t); f.controls.onOrigin = async () => { await fs.writeFile(f.pidPath, f.pidText.replace(START, '1790985601')); };
  await rejects(f.adapter.revokeCredentials({ database: 'codeintel' }), 'ORIGIN'); assert.equal(f.calls[0].writes.length, 1);
});
test('owned PG exit after origin aborts the psql child and cannot commit', async t => {
  const f = await fixture(t); f.controls.onResult = () => { f.owned.emit('exit', 0); };
  await rejects(f.adapter.revokeCredentials({ database: 'codeintel' }), 'ORIGIN');
  assert.equal(f.calls[0].committed, false); assert(f.calls[0].signals.includes('SIGTERM'));
});
test('local path/PID change after result readback prevents COMMIT', async t => {
  const f = await fixture(t); f.controls.onResult = async () => { await fs.rename(f.data, f.data + '-old'); await fs.mkdir(f.data, { mode: 0o700 }); };
  await rejects(f.adapter.rebindClonePaths({ database: STAGE, confirmedGitProjectIds: ['2'] }), 'ORIGIN');
  assert.equal(f.calls[0].committed, false);
});
test('origin loss immediately after COMMIT is reported as unverified, never as success', async t => {
  const f = await fixture(t); f.controls.onCommit = async () => { await fs.writeFile(f.pidPath, f.pidText.replace(START, '1790985601')); };
  await rejects(f.adapter.revokeCredentials({ database: 'codeintel' }), 'ORIGIN'); assert.equal(f.calls[0].committed, true);
});
for (const key of ['githubCredentials', 'aiCredentials', 'localApprovals', 'localInputs', 'localPaths', 'nonOffPreferences']) {
  test(`nonzero ${key} readback aborts revocation before commit`, async t => {
    const f = await fixture(t); f.controls.resultPatch = { [key]: '1' };
    await rejects(f.adapter.revokeCredentials({ database: 'codeintel' }), 'INVALID_RESULT'); assert.equal(f.calls[0].committed, false);
  });
}
for (const patch of [{ invalidPaths: '1' }, { projectIds: ['3'] }, { projectIds: [2] }, { projectIds: ['2', '2'] }]) {
  test(`invalid path readback ${JSON.stringify(patch)} aborts before commit`, async t => {
    const f = await fixture(t); f.controls.resultPatch = patch;
    await rejects(f.adapter.rebindClonePaths({ database: STAGE, confirmedGitProjectIds: ['2'] }), 'INVALID_RESULT');
    assert.equal(f.calls[0].committed, false);
  });
}

test('incremental output protocol accepts chunked UTF-8 and drains both result lines before close', async t => {
  const f = await fixture(t); f.controls.output = (value, _phase, c) => {
    const bytes = Buffer.from(JSON.stringify(value) + '\n');
    for (let i = 0; i < bytes.length; i += 7) c.child.stdout.write(bytes.subarray(i, i + 7));
  };
  assert.equal((await f.adapter.revokeCredentials({ database: 'codeintel' })).preferencesOff, true);
});
test('unexpected pipelined output cannot bypass the origin handshake or authorize mutation', async t => {
  const f = await fixture(t); f.controls.output = (value, phase, c) => {
    if (phase === 'origin') c.child.stdout.write(`${JSON.stringify(value)}\n${JSON.stringify(RESULT)}\n`);
  };
  await rejects(f.adapter.revokeCredentials({ database: 'codeintel' }), 'INVALID_RESULT'); assert.equal(f.calls[0].committed, false);
});
for (const [name, output, code] of [
  ['invalid UTF-8', (_v, _p, c) => c.child.stdout.write(Buffer.from([0xff, 0x0a])), 'INVALID_RESULT'],
  ['invalid JSON', (_v, _p, c) => c.child.stdout.write('synthetic-private\n'), 'INVALID_RESULT'],
  ['stdout overflow', (_v, _p, c) => c.child.stdout.write(Buffer.alloc(1048577, 65)), 'LIMIT'],
  ['stderr overflow', (_v, _p, c) => c.child.stderr.write(Buffer.alloc(65537, 65)), 'LIMIT'],
  ['extra result lines', (v, _p, c) => c.child.stdout.write(`${JSON.stringify(v)}\n{}\n{}\n`), 'INVALID_RESULT'],
]) test(`bounded psql stream rejects ${name} without leaking output`, async t => {
  const f = await fixture(t); f.controls.output = output;
  await rejects(f.adapter.revokeCredentials({ database: 'codeintel' }), code); assert.equal(f.calls[0].committed, false);
});
test('EOF before newline/COMMIT cannot be treated as success', async t => {
  const f = await fixture(t); f.controls.output = (value, _phase, c) => { c.child.stdout.write(JSON.stringify(value)); c.finish(0); };
  await rejects(f.adapter.verifyOrigin(), 'INVALID_RESULT'); assert.equal(f.calls[0].committed, false);
});
test('psql failure rolls back pending work and does not expose raw stderr', async t => {
  const f = await fixture(t); f.controls.output = (_v, phase, c) => {
    if (phase === 'origin') c.child.stdout.write(JSON.stringify({ kind: 'origin', systemIdentifier: SYS, dataDirectory: f.pg,
      startEpochSeconds: START, port: PORT, database: 'codeintel', user: 'codeintel', sessionUser: 'codeintel' }) + '\n');
    else { c.child.stderr.write('synthetic-private-password SELECT encrypted_key'); c.finish(1); }
  };
  await rejects(f.adapter.revokeCredentials({ database: 'codeintel' }), 'FAILED'); assert.equal(f.calls[0].committed, false);
});
for (const stream of ['stdin', 'stdout', 'stderr']) test(`psql ${stream} error is sanitized and reaped`, async t => {
  const f = await fixture(t); f.controls.hangOrigin = true; const ready = nextWrite(f);
  const work = f.adapter.verifyOrigin(); const rejected = rejects(work, 'FAILED');
  const call = await ready(work); call.child[stream].emit('error', new Error('synthetic-private stream details'));
  await rejected; assert(call.signals.includes('SIGTERM')); assert.equal(call.committed, false);
});
test('psql process error with an assigned PID must terminate and reap before returning', async t => {
  const f = await fixture(t); f.controls.hangOrigin = true; const ready = nextWrite(f);
  const work = f.adapter.verifyOrigin(); const rejected = rejects(work, 'FAILED');
  const call = await ready(work); call.child.emit('error', new Error('synthetic-private process details'));
  await rejected; assert(call.signals.includes('SIGTERM'));
});
test('pending origin authorizes no second SQL write', async t => {
  const f = await fixture(t); f.controls.hangOrigin = true; const ready = nextWrite(f);
  const work = f.adapter.verifyOrigin(); const rejected = rejects(work, 'CLOSED');
  const call = await ready(work); assert.equal(call.writes.length, 1);
  call.child.stdin.write = () => { assert.fail('origin backpressure was bypassed'); };
  await tick(); assert.equal(call.writes.length, 1); await f.adapter.close(); await rejected;
});
test('COMMIT failure is not acknowledged even after a valid readback', async t => {
  const f = await fixture(t); f.controls.exitCode = 1;
  await rejects(f.adapter.revokeCredentials({ database: 'codeintel' }), 'FAILED'); assert.equal(f.calls[0].committed, true);
});
test('single active operation bounds the queue; close waits for psql to be reaped', async t => {
  const f = await fixture(t); f.controls.hangResult = true; f.controls.unreaped = true;
  const ready = nextWrite(f, 2);
  const work = f.adapter.revokeCredentials({ database: 'codeintel' }); const rejected = rejects(work, 'CLOSED');
  const call = await ready(work);
  await rejects(f.adapter.verifyOrigin(), 'BUSY'); assert.equal(f.calls.length, 1);
  let workSettled = false, closeSettled = false;
  work.then(() => { workSettled = true; }, () => { workSettled = true; });
  const closing = f.adapter.close().then(() => { closeSettled = true; });
  try {
    await tick(); assert.equal(workSettled, false); assert.equal(closeSettled, false);
    assert(call.signals.includes('SIGTERM'));
  } finally { call.finish(null); await Promise.all([closing, rejected]); }
  assert.equal(f.owned.listenerCount('exit'), 0); assert.equal(f.owned.listenerCount('close'), 0);
  await rejects(f.adapter.verifyOrigin(), 'CLOSED'); await f.adapter.close();
});
test('deadline terminates hung psql and never commits', async t => {
  const f = await fixture(t, false, { timeoutMs: 100 }); f.adapter = await createBackupProductState(f.options); f.calls.length = 0;
  f.controls.hangOrigin = true; await rejects(f.adapter.verifyOrigin(), 'TIMEOUT');
  assert(f.calls[0].signals.includes('SIGTERM')); assert.equal(f.calls[0].committed, false);
});
test('unreaped psql escalates TERM to KILL, poisons the controller and makes close fail', { timeout: 5000 }, async t => {
  const f = await fixture(t, false, { timeoutMs: 100 }); f.adapter = await createBackupProductState(f.options); f.calls.length = 0;
  f.controls.hangOrigin = true; f.controls.unreaped = true;
  await rejects(f.adapter.verifyOrigin(), 'TERMINATION'); assert.deepEqual(f.calls[0].signals, ['SIGTERM', 'SIGKILL']);
  await rejects(f.adapter.verifyOrigin(), 'TERMINATION'); assert.equal(f.calls.length, 1);
  await rejects(f.adapter.close(), 'TERMINATION');
});

for (const phase of ['origin', 'result']) test(`commit receipt guard: close0 during ${phase} cannot send later SQL or acknowledge success`, async t => {
  const f = await fixture(t); f.controls.output = (value, current, c) => {
    c.child.stdout.write(JSON.stringify(value) + '\n');
    if (current === phase) { c.child.stdin.destroy(); c.finish(0); }
  };
  await rejects(f.adapter.revokeCredentials({ database: 'codeintel' }), 'INVALID_RESULT');
  assert.equal(f.calls[0].committed, false);
  assert.equal(f.calls[0].writes.length, phase === 'origin' ? 1 : 2);
});

test('commit receipt guard: close0 after COMMIT without its distinct receipt is unverified', async t => {
  const f = await fixture(t); f.controls.omitCommitReceipt = true;
  await rejects(f.adapter.revokeCredentials({ database: 'codeintel' }), 'INVALID_RESULT');
  assert.equal(f.calls[0].committed, true);
});

for (const patch of [{ kind: 'result' }, { kind: 'committed', extra: true }]) {
  test(`commit receipt guard: rejects malformed post-COMMIT receipt ${JSON.stringify(patch)}`, async t => {
    const f = await fixture(t); f.controls.receiptPatch = patch;
    await rejects(f.adapter.revokeCredentials({ database: 'codeintel' }), 'INVALID_RESULT'); assert.equal(f.calls[0].committed, true);
  });
}

test('commit receipt guard: a valid receipt with a trailing suffix cannot authorize close0', async t => {
  const f = await fixture(t); f.controls.output = (value, phase, c) => {
    c.child.stdout.write(JSON.stringify(value) + '\n' + (phase === 'committed' ? 'unparsed' : ''));
  };
  await rejects(f.adapter.revokeCredentials({ database: 'codeintel' }), 'INVALID_RESULT'); assert.equal(f.calls[0].committed, true);
});

test('commit receipt guard: stderr error during final post-close validation remains failure', async t => {
  const f = await fixture(t); const original = fs.lstat; let armed = false, fired = false;
  f.controls.onCommit = () => { armed = true; };
  t.mock.method(fs, 'lstat', async function(file, ...args) {
    if (armed && !fired && String(file) === f.pg) {
      fired = true; f.calls[0].child.stderr.emit('error', new Error('synthetic-private post-close error'));
    }
    return original.call(fs, file, ...args);
  });
  await rejects(f.adapter.revokeCredentials({ database: 'codeintel' }), 'FAILED'); assert.equal(fired, true);
});

test('commit receipt guard: timeout during final post-close validation remains failure', async t => {
  const f = await fixture(t, false, { timeoutMs: 100 }); f.adapter = await createBackupProductState(f.options); f.calls.length = 0;
  const original = fs.lstat; let armed = false, fired = false;
  f.controls.onCommit = () => { armed = true; };
  t.mock.method(fs, 'lstat', async function(file, ...args) {
    if (armed && !fired && String(file) === f.pg) { fired = true; await new Promise(resolve => setTimeout(resolve, 150)); }
    return original.call(fs, file, ...args);
  });
  await rejects(f.adapter.revokeCredentials({ database: 'codeintel' }), 'TIMEOUT'); assert.equal(fired, true);
  // Let the deliberately delayed filesystem read finish before fixture cleanup.
  await new Promise(resolve => setTimeout(resolve, 70));
});

for (const stream of ['stdin', 'stdout', 'stderr']) test(`commit receipt guard: ${stream} error after COMMIT cannot be overwritten by receipt/close0`, async t => {
  const f = await fixture(t); f.controls.output = (value, phase, c) => {
    c.child.stdout.write(JSON.stringify(value) + '\n');
    if (phase === 'committed') c.child[stream].emit('error', new Error('synthetic-private receipt stream error'));
  };
  await rejects(f.adapter.revokeCredentials({ database: 'codeintel' }), 'FAILED'); assert.equal(f.calls[0].committed, true);
});

for (const stream of ['stdout', 'stderr']) test(`commit receipt guard: ${stream} destroyed without EOF cannot acknowledge close0`, async t => {
  const f = await fixture(t); f.controls.output = (value, phase, c) => {
    c.child.stdout.write(JSON.stringify(value) + '\n'); if (phase === 'committed') c.child[stream].destroy();
  };
  await rejects(f.adapter.revokeCredentials({ database: 'codeintel' }), 'INVALID_RESULT'); assert.equal(f.calls[0].committed, true);
});

test('commit receipt guard: timeout during result revalidation never advances to COMMIT', async t => {
  const f = await fixture(t, false, { timeoutMs: 100 }); f.adapter = await createBackupProductState(f.options); f.calls.length = 0;
  const original = fs.lstat; let armed = false, fired = false;
  f.controls.onResult = () => { armed = true; };
  t.mock.method(fs, 'lstat', async function(file, ...args) {
    if (armed && !fired && String(file) === f.pg) { fired = true; await new Promise(resolve => setTimeout(resolve, 150)); }
    return original.call(fs, file, ...args);
  });
  await rejects(f.adapter.revokeCredentials({ database: 'codeintel' }), 'TIMEOUT'); await new Promise(resolve => setTimeout(resolve, 70));
  assert.equal(fired, true); assert.equal(f.calls[0].committed, false); assert.equal(f.calls[0].writes.length, 2);
});

test('commit receipt guard: close during result revalidation drains the client and sends no COMMIT', async t => {
  const f = await fixture(t); const original = fs.lstat; let armed = false, fired = false, closing;
  f.controls.onResult = () => { armed = true; };
  t.mock.method(fs, 'lstat', async function(file, ...args) {
    if (armed && !fired && String(file) === f.pg) { fired = true; closing = f.adapter.close(); await closing; }
    return original.call(fs, file, ...args);
  });
  await rejects(f.adapter.revokeCredentials({ database: 'codeintel' }), 'CLOSED'); await closing;
  assert.equal(fired, true); assert.equal(f.calls[0].committed, false); assert.equal(f.calls[0].writes.length, 2);
});

test('origin guard: a FIFO PID file rejects without waiting for an external writer or SQL timeout', async t => {
  const f = await fixture(t, false, { timeoutMs: 20 }); await fs.unlink(f.pidPath);
  const created = spawnSync('/usr/bin/mkfifo', ['-m', '600', f.pidPath]); assert.equal(created.status, 0);
  const work = createBackupProductState(f.options).then(value => ({ value }), error => ({ error }));
  const first = await Promise.race([work, new Promise(resolve => setTimeout(() => resolve(null), 100))]);
  // Release a regressed blocking read before asserting, so RED cannot strand the Node worker pool.
  if (first === null) { const release = await fs.open(f.pidPath, constants.O_RDWR | constants.O_NONBLOCK); await work; await release.close(); }
  assert.notEqual(first, null, 'PID validation must not block on a FIFO open');
  assert.equal(first.error?.code, 'BACKUP_PRODUCT_STATE_UNSAFE'); assert.equal(f.calls.length, 0);
});

for (const phase of ['origin', 'result']) test(`commit receipt guard: an exited client cannot receive new SQL during ${phase} revalidation`, async t => {
  const f = await fixture(t); f.controls.output = (value, current, c) => {
    c.child.stdout.write(JSON.stringify(value) + '\n');
    if (current === phase) c.child.emit('exit', 0);
  };
  await rejects(f.adapter.revokeCredentials({ database: 'codeintel' }), 'INVALID_RESULT');
  assert.equal(f.calls[0].committed, false); assert.equal(f.calls[0].writes.length, phase === 'origin' ? 1 : 2);
});
