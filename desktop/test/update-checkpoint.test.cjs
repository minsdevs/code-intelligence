'use strict';
// G-UPDATE NU-02: pre-migration checkpoint and restore on synthetic profiles. The opt-in test at the
// end uses a real PostgreSQL cluster (CI_UPDATE_CHECKPOINT_PG_BIN = a bundled postgres/bin, for
// example the candidate's Contents/Resources/runtime/postgres/bin); it never touches a real profile.
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const { spawn, spawnSync } = require('node:child_process');
const { openUpdateCheckpoints, checkpointIdFor } = require('../src/update-checkpoint.cjs');

const darwin = { skip: process.platform !== 'darwin' };
const JOURNAL = Object.freeze({ sequence: 12, headHash: 'c'.repeat(64) });
const bundle = build => ({ path: `/Applications/Code Intelligence ${build}.app`, build, runtimeManifestSha256: crypto.createHash('sha256').update(`m${build}`).digest('hex'),
  asarSha256: crypto.createHash('sha256').update(`a${build}`).digest('hex') });

async function profile(t) {
  const userData = await fs.mkdtemp(path.join(await fs.realpath(os.tmpdir()), 'ci-update-checkpoint-')); await fs.chmod(userData, 0o700);
  t.after(() => fs.rm(userData, { recursive: true, force: true }));
  const live = path.join(userData, 'postgres');
  await fs.mkdir(path.join(live, 'base', '1'), { recursive: true, mode: 0o700 }); await fs.chmod(live, 0o700);
  await fs.writeFile(path.join(live, 'PG_VERSION'), '16\n', { mode: 0o600 });
  await fs.writeFile(path.join(live, 'base', '1', '1259'), Buffer.from('schema 26 relation bytes'), { mode: 0o600 });
  for (const name of ['repos', 'sources']) await fs.mkdir(path.join(userData, 'data', name), { recursive: true, mode: 0o700 });
  await fs.mkdir(path.join(userData, 'safety', 'ai-journal'), { recursive: true, mode: 0o700 });
  await fs.writeFile(path.join(userData, 'safety', 'ai-journal', 'events.log'), 'newest journal bytes', { mode: 0o600 });
  await fs.writeFile(path.join(userData, 'data', 'sources', 'blob'), 'newest vault blob', { mode: 0o600 });
  const open = (runningBuild, targetFlyway) => openUpdateCheckpoints({ userData, runningBuild, targetFlyway, bundle: bundle(runningBuild) });
  return { userData, live, open, root: path.join(userData, 'update-checkpoints') };
}
async function tree(root) {
  const result = {};
  for (const entry of await fs.readdir(root, { withFileTypes: true, recursive: true })) {
    const file = path.join(entry.parentPath, entry.name), stat = await fs.lstat(file);
    result[path.relative(root, file)] = entry.isFile() ? [stat.mode & 0o777, (await fs.readFile(file)).toString('hex')] : [stat.mode & 0o777];
  }
  return result;
}
// The previous build N (flyway 26) has started successfully once on this profile.
async function startedBuild(p, build = '100', flyway = 26) {
  const checkpoints = await p.open(build, flyway);
  await checkpoints.beforeMigration({ journal: JOURNAL }); await checkpoints.markStarted();
}

test('checkpoint identifiers are deterministic per transition and valid for the manifest and area B', () => {
  const id = checkpointIdFor('100', '200');
  assert.equal(id, checkpointIdFor('100', '200')); assert.notEqual(id, checkpointIdFor('100', '201'));
  assert.match(id, /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  assert.throws(() => checkpointIdFor('01', '2'), { code: 'UPDATE_CHECKPOINT_INVALID' });
});

test('no checkpoint without data or when the recorded schema already reaches the target', darwin, async t => {
  const p = await profile(t);
  await startedBuild(p);
  const same = await p.open('101', 26);
  assert.equal(await same.beforeMigration({ journal: JOURNAL }), null);
  const empty = await fs.mkdtemp(path.join(await fs.realpath(os.tmpdir()), 'ci-update-empty-')); await fs.chmod(empty, 0o700);
  t.after(() => fs.rm(empty, { recursive: true, force: true }));
  assert.equal(await (await openUpdateCheckpoints({ userData: empty, runningBuild: '200', targetFlyway: 27, bundle: bundle('200') }))
    .beforeMigration({ journal: JOURNAL }), null);
});

test('first start of a newer schema: the stopped cluster, source identities, journal pointer and previous bundle are recorded first', darwin, async t => {
  const p = await profile(t);
  await startedBuild(p);
  const before = await tree(p.live);
  const checkpoints = await p.open('200', 27);
  const record = await checkpoints.beforeMigration({ journal: JOURNAL });
  assert.equal(record.id, checkpointIdFor('100', '200')); assert.equal(record.state, 'MIGRATING');
  assert.equal(record.createdByBuild, '100'); assert.equal(record.schemaFlyway, 26); assert.equal(record.targetFlyway, 27);
  assert.deepEqual(record.previousBundle, bundle('100')); assert.deepEqual(record.journal, JOURNAL);
  assert.match(record.sources.repos, /^\d+:\d+$/); assert.match(record.sources.sources, /^\d+:\d+$/);
  assert.deepEqual(await tree(path.join(p.root, record.id, 'postgres')), before, 'byte- and mode-identical cold copy');
  assert.equal((await fs.lstat(path.join(p.root, record.id, 'postgres'))).mode & 0o777, 0o700);
  assert.equal((await checkpoints.pending()).id, record.id);
  await checkpoints.markStarted();
  assert.equal(await checkpoints.pending(), null);
  assert.deepEqual({ ...await checkpoints.retained() }, { id: record.id, schemaFlyway: 26, createdByBuild: '100' });
  assert.equal(await (await p.open('200', 27)).beforeMigration({ journal: JOURNAL }), null, 'only the first start of the build');
});

test('a profile from before the updater (no recorded schema) is checkpointed conservatively', darwin, async t => {
  const p = await profile(t);
  const record = await (await p.open('200', 27)).beforeMigration({ journal: JOURNAL });
  assert.equal(record.createdByBuild, '0'); assert.equal(record.schemaFlyway, null); assert.equal(record.previousBundle, null);
});

test('failed migration: the next start is recovery-only; restore returns the database and keeps the newest vault and journal', darwin, async t => {
  const p = await profile(t);
  await startedBuild(p);
  const before = await tree(p.live);
  const first = await p.open('200', 27);
  const { id } = await first.beforeMigration({ journal: JOURNAL });
  // The migration writes, then the backend never becomes healthy.
  await fs.writeFile(path.join(p.live, 'base', '1', '1259'), 'half migrated');
  await fs.writeFile(path.join(p.live, 'base', '1', '9999'), 'new relation', { mode: 0o600 });
  await first.markFailed();
  const vault = await tree(path.join(p.userData, 'data')), journal = await tree(path.join(p.userData, 'safety'));
  const next = await p.open('200', 27);
  assert.equal((await next.pending()).state, 'FAILED');
  await assert.rejects(next.beforeMigration({ journal: JOURNAL }), { code: 'UPDATE_CHECKPOINT_RECOVERY_REQUIRED' });
  await assert.rejects(next.markStarted(), { code: 'UPDATE_CHECKPOINT_RECOVERY_REQUIRED' });
  const restored = await next.restore(id);
  assert.deepEqual(restored.previousBundle, bundle('100')); assert.equal(restored.createdByBuild, '100');
  assert.deepEqual(await tree(p.live), before, 'database back at the checkpoint');
  assert.equal(await fs.readFile(path.join(p.root, id, 'failed-postgres', 'base', '1', '9999'), 'utf8'), 'new relation', 'failed cluster kept');
  assert.deepEqual(await tree(path.join(p.userData, 'data')), vault); assert.deepEqual(await tree(path.join(p.userData, 'safety')), journal);
  assert.equal(await next.pending(), null);
  // The previous build reopens without a new checkpoint; the newer build would checkpoint again.
  assert.equal(await (await p.open('100', 26)).beforeMigration({ journal: JOURNAL }), null);
  assert.equal((await (await p.open('200', 27)).beforeMigration({ journal: JOURNAL })).id, id, 'a retry supersedes the finished record');
});

test('an interrupted migration (no failure record) or restore stays recovery-only until completed', darwin, async t => {
  const p = await profile(t);
  await startedBuild(p);
  const before = await tree(p.live);
  const { id } = await (await p.open('200', 27)).beforeMigration({ journal: JOURNAL });
  // Crash during migration: the record is still MIGRATING.
  assert.equal((await (await p.open('200', 27)).pending()).state, 'MIGRATING');
  // Crash in the middle of a restore: the live cluster was moved away, the clone never published.
  const record = JSON.parse(await fs.readFile(path.join(p.root, id, 'record.json'), 'utf8'));
  await fs.rename(p.live, path.join(p.root, id, 'failed-postgres'));
  await fs.mkdir(`${p.live}.restoring`, { mode: 0o700 }); await fs.writeFile(`${p.live}.restoring/partial`, 'x');
  await fs.writeFile(path.join(p.root, id, 'record.json'), JSON.stringify({ ...record, state: 'RESTORING' }), { mode: 0o600 });
  const resumed = await p.open('200', 27);
  assert.equal((await resumed.pending()).state, 'RESTORING');
  await resumed.restore(id);
  assert.deepEqual(await tree(p.live), before);
  await assert.rejects(fs.lstat(`${p.live}.restoring`), { code: 'ENOENT' });
});

test('an interrupted clone is discarded: no migration ran against the untouched live cluster', darwin, async t => {
  const p = await profile(t);
  await startedBuild(p);
  const id = checkpointIdFor('100', '200');
  await fs.mkdir(path.join(p.root, id), { mode: 0o700 });
  await fs.writeFile(path.join(p.root, id, 'record.json'), JSON.stringify({ format: 1, id, state: 'PREPARING', createdByBuild: '100',
    schemaFlyway: 26, previousBundle: bundle('100'), targetBuild: '200', targetFlyway: 27, journal: JOURNAL,
    sources: { repos: null, sources: null }, createdAt: 1 }), { mode: 0o600 });
  const checkpoints = await p.open('200', 27);
  assert.equal(await checkpoints.pending(), null);
  assert.equal((await checkpoints.beforeMigration({ journal: JOURNAL })).state, 'MIGRATING');
});

test('a running cluster or replaced source roots refuse the checkpoint or the restore', darwin, async t => {
  const p = await profile(t);
  await startedBuild(p);
  await fs.writeFile(path.join(p.live, 'postmaster.pid'), `${process.pid}\n${p.live}\n`, { mode: 0o600 });
  await assert.rejects((await p.open('200', 27)).beforeMigration({ journal: JOURNAL }), { code: 'UPDATE_CHECKPOINT_DATABASE_RUNNING' });
  // A stale pid file after a crash is crash-consistent and accepted.
  const dead = spawnSync('/bin/sh', ['-c', 'echo $$']).stdout.toString().trim();
  await fs.writeFile(path.join(p.live, 'postmaster.pid'), `${dead}\n${p.live}\n`, { mode: 0o600 });
  const checkpoints = await p.open('200', 27);
  const { id } = await checkpoints.beforeMigration({ journal: JOURNAL });
  await checkpoints.markFailed();
  await fs.rename(path.join(p.userData, 'data', 'sources'), path.join(p.userData, 'data', 'sources-old'));
  await fs.mkdir(path.join(p.userData, 'data', 'sources'), { mode: 0o700 });
  await assert.rejects(checkpoints.restore(id), { code: 'UPDATE_CHECKPOINT_SOURCES_CHANGED' });
  assert.equal((await checkpoints.pending()).state, 'FAILED');
});

test('the user may retry the same upgrade on top of the kept image; finished checkpoints are retained one deep', darwin, async t => {
  const p = await profile(t);
  await startedBuild(p);
  const first = await p.open('200', 27);
  const { id } = await first.beforeMigration({ journal: JOURNAL }); await first.markFailed();
  const retry = await p.open('200', 27);
  await assert.rejects(retry.retry(checkpointIdFor('1', '2')), { code: 'UPDATE_CHECKPOINT_UNAVAILABLE' });
  await retry.retry(id);
  assert.equal((await retry.beforeMigration({ journal: JOURNAL })).id, id);
  await retry.markStarted();
  const later = await p.open('300', 28);
  const second = await later.beforeMigration({ journal: JOURNAL }); await later.markStarted();
  assert.deepEqual((await fs.readdir(p.root)).filter(name => name !== 'schema.json'), [second.id]);
  assert.equal((await later.retained()).createdByBuild, '200');
});

// Real PostgreSQL: a failed, partly committed migration is undone by restoring the checkpoint.
const PG_BIN = process.env.CI_UPDATE_CHECKPOINT_PG_BIN;
test('opt-in real PostgreSQL: checkpoint before a failing migration, restore, and the previous schema and rows return', {
  skip: process.platform !== 'darwin' || !PG_BIN, timeout: 180000 }, async t => {
  const p = await profile(t);
  await fs.rm(p.live, { recursive: true });
  const bin = name => path.join(PG_BIN, name);
  const env = { PATH: '/usr/bin:/bin:/usr/sbin:/sbin', LANG: 'C', LC_ALL: 'C', HOME: os.homedir() };
  const port = await new Promise(resolve => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const { port: value } = s.address(); s.close(() => resolve(value)); }); });
  const run = (file, args) => { const r = spawnSync(file, args, { env, encoding: 'utf8' }); assert.equal(r.status, 0, r.stderr); return r.stdout.trim(); };
  run(bin('initdb'), ['-D', p.live, '-U', 'codeintel', '--encoding=UTF8', '--no-locale', '--auth=trust']);
  let server;
  const start = async () => {
    server = spawn(bin('postgres'), ['-D', p.live, '-h', '127.0.0.1', '-p', String(port), '-c', 'unix_socket_directories='], { env, stdio: 'ignore' });
    for (let i = 0; i < 300; i++) {
      if (spawnSync(bin('pg_isready'), ['-h', '127.0.0.1', '-p', String(port), '-U', 'codeintel'], { env }).status === 0) return;
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    assert.fail('PostgreSQL did not start');
  };
  const stop = async () => { const exited = new Promise(resolve => server.once('exit', resolve)); server.kill('SIGINT'); await exited; server = null; };
  t.after(async () => { if (server) await stop(); });
  const sql = (text, check = true) => {
    const r = spawnSync(bin('psql'), ['-X', '-h', '127.0.0.1', '-p', String(port), '-U', 'codeintel', '-d', 'postgres', '-tA', '-v', 'ON_ERROR_STOP=1', '-c', text], { env, encoding: 'utf8' });
    if (check) assert.equal(r.status, 0, r.stderr);
    return r.status === 0 ? r.stdout.trim() : null;
  };
  // Build N: schema 26 and user data.
  await start();
  sql(`create table flyway_schema_history(installed_rank int primary key, version text, success boolean);
    insert into flyway_schema_history values (26, '26', true); create table notes(id int primary key, body text);
    insert into notes values (1, 'kept'), (2, 'also kept');`);
  const expected = sql("select string_agg(id || ':' || body, ',' order by id) from notes");
  await stop();
  await startedBuild(p, '100', 26);
  // Build N+1: checkpoint with the cluster stopped, then a migration that commits one step and fails.
  const upgrade = await p.open('200', 27);
  const { id } = await upgrade.beforeMigration({ journal: JOURNAL });
  await start();
  sql("update notes set body = 'migrated' where id = 1; alter table notes add column extra text; insert into flyway_schema_history values (27, '27', false);");
  assert.equal(sql('alter table missing_table add column x int;', false), null);
  // A crash during the failed start: no clean shutdown.
  { const exited = new Promise(resolve => server.once('exit', resolve)); server.kill('SIGKILL'); await exited; server = null; }
  await upgrade.markFailed();
  const recovery = await p.open('200', 27);
  assert.equal((await recovery.pending()).id, id);
  await recovery.restore(id);
  await start();
  assert.equal(sql("select string_agg(id || ':' || body, ',' order by id) from notes"), expected);
  assert.equal(sql("select count(*) from information_schema.columns where table_name = 'notes' and column_name = 'extra'"), '0');
  assert.equal(sql('select max(version) from flyway_schema_history'), '26');
  await stop();
  assert.equal(await fs.readFile(path.join(p.userData, 'safety', 'ai-journal', 'events.log'), 'utf8'), 'newest journal bytes');
  assert.equal(await (await p.open('100', 26)).beforeMigration({ journal: JOURNAL }), null, 'build N reopens the restored data');
});
