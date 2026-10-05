'use strict';

// Main owns the local cluster, names and stopped writer processes. This controller only creates
// a fresh staging DB and renames exact, OID-bound databases. Retention may drop only a completed
// authenticated previous/failed slot, never a live/staging DB. Compatibility probes can drop only
// the fresh stage acquired in their own invocation. There is no arbitrary SQL API.
const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawn: realSpawn } = require('node:child_process');
const { retentionCandidate } = require('./backup-retention.cjs');
const { inheritedEnvironment } = require('./runtime-platform.cjs');
class BackupDatabaseError extends Error {
  constructor(code = 'FAILED') { super(`Backup database control: ${code}`); this.code = `BACKUP_DATABASE_${code}`; }
}
function fail(code) { throw new BackupDatabaseError(code); }
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
function exact(value, names) {
  if (!value || typeof value !== 'object' || Object.keys(value).length !== names.length || names.some(key => !Object.hasOwn(value, key))) fail('INVALID');
}
function transaction(value) {
  if (typeof value !== 'string' || value.length !== 36 || !UUID.test(value)) fail('INVALID');
  const id = value.replaceAll('-', '');
  return { stage: `ci_backup_stage_${id}`, previous: `ci_backup_previous_${id}`, failed: `ci_backup_failed_${id}` };
}
function oid(value) { if (typeof value !== 'string' || !/^[1-9][0-9]{0,9}$/.test(value) || BigInt(value) > 4294967295n) fail('INVALID'); }
function jsonSql(value) { return `convert_from(decode('${Buffer.from(JSON.stringify(value)).toString('base64')}','base64'),'UTF8')::jsonb`; }
async function createBackupDatabaseControl(options) {
  exact(options, ['psqlPath', 'connection', 'env', 'liveDatabase', ...(options.spawn ? ['spawn'] : []),
    ...(Object.hasOwn(options, 'readRetentionAuthority') ? ['readRetentionAuthority'] : []),
    ...(Object.hasOwn(options, 'windowsBoundary') ? ['windowsBoundary'] : [])]);
  const { psqlPath, connection, liveDatabase, env } = options;
  if (typeof psqlPath !== 'string' || !path.isAbsolute(psqlPath) || path.resolve(psqlPath) !== psqlPath) fail('INVALID');
  if (options.windowsBoundary) {
    const storage = await options.windowsBoundary.openStorage(path.dirname(psqlPath), { mode: 'source' });
    try { await storage.stat(path.basename(psqlPath)); } finally { await storage.close(); }
  } else {
    let binary; try { binary = await fs.lstat(psqlPath); } catch { fail('INVALID'); }
    if (!binary.isFile() || binary.isSymbolicLink() || !(binary.mode & 0o111)) fail('INVALID');
  }
  exact(connection, ['host', 'port', 'user']);
  if (connection.host !== '127.0.0.1' || !Number.isInteger(connection.port) || connection.port < 1 || connection.port > 65535
      || typeof connection.user !== 'string' || !/^[a-zA-Z_][a-zA-Z0-9_]{0,62}$/.test(connection.user)
      || (liveDatabase !== 'codeintel' && !/^ci_backup_live_[a-f0-9]{16,32}$/.test(liveDatabase))) fail('INVALID');
  if (!env || typeof env !== 'object' || !env.PGPASSWORD || Object.keys(env).some(key =>
    !['PGPASSWORD', 'PGSSLMODE', 'PGSSLROOTCERT', 'LD_LIBRARY_PATH', 'DYLD_LIBRARY_PATH'].includes(key))) fail('INVALID');
  if (env.PGSSLMODE !== undefined && env.PGSSLMODE !== 'verify-full') fail('INVALID');
  if (env.PGSSLROOTCERT !== undefined && (typeof env.PGSSLROOTCERT !== 'string'
      || !path.isAbsolute(env.PGSSLROOTCERT) || path.normalize(env.PGSSLROOTCERT) !== env.PGSSLROOTCERT)) fail('INVALID');
  const environment = { ...(options.windowsBoundary ? inheritedEnvironment(process.env) : {}), LANG: 'C', LC_ALL: 'C', TZ: 'UTC', PGCLIENTENCODING: 'UTF8', PGCONNECT_TIMEOUT: '5',
    PGAPPNAME: 'code-intelligence-backup-control', PGSSLMODE: 'verify-full' };
  for (const [key, value] of Object.entries(env)) {
    if (typeof value !== 'string' || !value.length || value.length > 16384 || value.includes('\0')) fail('INVALID'); environment[key] = value;
  }
  const spawn = options.spawn || realSpawn;
  const readRetentionAuthority = options.readRetentionAuthority;
  if (typeof spawn !== 'function' || readRetentionAuthority !== undefined && typeof readRetentionAuthority !== 'function') fail('INVALID');
  let busy = false, closed = false, active = null, terminationFailed = false, compatibilityActive = false;
  function run(sql, database = 'postgres') {
    if (busy || closed || terminationFailed) return Promise.reject(new BackupDatabaseError('UNAVAILABLE'));
    busy = true;
    return new Promise((resolve, reject) => {
      let child, timer, killTimer, reapTimer, reason, settled = false, outputSize = 0, stderrSize = 0;
      const chunks = [];
      function finish(code, value) {
        if (settled) return; settled = true; busy = false; active = null;
        clearTimeout(timer); clearTimeout(killTimer); clearTimeout(reapTimer); chunks.forEach(chunk => chunk.fill(0));
        if (code === 'TERMINATION') terminationFailed = true;
        code ? reject(new BackupDatabaseError(code)) : resolve(value);
      }
      function terminate(code) {
        reason ||= code; try { child.kill('SIGTERM'); } catch {}
        killTimer ||= setTimeout(() => { try { child.kill('SIGKILL'); } catch {} }, 200);
        reapTimer ||= setTimeout(() => finish('TERMINATION'), 2000);
      }
      try { child = spawn(psqlPath, ['-X', '--no-password', '--quiet', '--tuples-only', '--no-align',
        '--set=ON_ERROR_STOP=1', '--pset=pager=off', '--host=127.0.0.1', `--port=${connection.port}`,
        `--username=${connection.user}`, `--dbname=${database}`, '--file=-'],
      { env: { ...environment }, cwd: path.dirname(psqlPath), shell: false, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] }); }
      catch { finish('FAILED'); return; }
      active = { terminate };
      child.on('error', () => child.pid ? terminate('FAILED') : finish('FAILED'));
      child.stdin.on('error', () => terminate('FAILED'));
      child.stdout.on('error', () => terminate('FAILED'));
      child.stderr.on('error', () => terminate('FAILED'));
      child.stdout.on('data', bytes => {
        if (settled) return; outputSize += bytes.length; if (outputSize > 64 * 1024) return terminate('LIMIT'); chunks.push(Buffer.from(bytes));
      });
      child.stderr.on('data', bytes => { stderrSize += bytes.length; if (stderrSize > 64 * 1024) terminate('LIMIT'); });
      child.once('close', code => {
        if (reason || code !== 0) { finish(reason || 'FAILED'); return; }
        let bytes;
        try { bytes = Buffer.concat(chunks); const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes).trim();
          finish(null, JSON.parse(text)); } catch { finish('INVALID_RESULT'); } finally { bytes?.fill(0); }
      });
      timer = setTimeout(() => terminate('TIMEOUT'), 30000);
      try { child.stdin.end(`set search_path=pg_catalog;\nset statement_timeout='15000ms';\nset lock_timeout='5000ms';\n${sql}\n`); }
      catch { terminate('FAILED'); }
    });
  }
  async function inspect(transactionId) {
    const names = { live: liveDatabase, ...transaction(transactionId) };
    const value = await run(`select coalesce(jsonb_object_agg(d.datname,jsonb_build_object('oid',d.oid::text,
      'owner',pg_catalog.pg_get_userbyid(d.datdba),'allowConnections',d.datallowconn,'bytes',pg_catalog.pg_database_size(d.oid)::text)),
      '{}'::jsonb) from pg_catalog.pg_database d where d.datname in (${Object.values(names).map(name => `'${name}'`).join(',')});`);
    if (!value || typeof value !== 'object' || Array.isArray(value)) fail('INVALID_RESULT');
    for (const [name, row] of Object.entries(value)) {
      if (!Object.values(names).includes(name)) fail('INVALID_RESULT'); exact(row, ['oid', 'owner', 'allowConnections', 'bytes']); oid(row.oid);
      if (row.owner !== connection.user || typeof row.allowConnections !== 'boolean' || typeof row.bytes !== 'string'
          || row.bytes.match(/^(?:0|[1-9][0-9]{0,18})$/)?.[0] !== row.bytes || BigInt(row.bytes) > 9223372036854775807n) fail('OWNER');
      Object.freeze(row);
    }
    return Object.freeze({ names: Object.freeze(names), databases: Object.freeze(value) });
  }
  function checkSql(mapping) {
    return `do $bound$ declare expected jsonb := ${jsonSql(mapping)}; item record;
      begin
        for item in select key,value#>>'{}' as oid from jsonb_each(expected) loop
          if not exists(select 1 from pg_catalog.pg_database where datname=item.key and oid=item.oid::oid
            and datdba=(select oid from pg_catalog.pg_roles where rolname=current_user))
            then raise exception 'database identity changed'; end if;
          if exists(select 1 from pg_catalog.pg_stat_activity where datid=item.oid::oid)
            then raise exception 'database writers still connected'; end if;
        end loop;
      end $bound$;`;
  }
  async function createStage({ transactionId }) {
    const before = await inspect(transactionId); const { live, stage, previous, failed } = before.names;
    if (!before.databases[live] || !before.databases[live].allowConnections
        || before.databases[stage] || before.databases[previous] || before.databases[failed]) fail('NOT_FRESH');
    const created = await run(`create database "${stage}" with template=template0 encoding='UTF8';
      select jsonb_build_object('ok',true,'stageOid',(select oid::text from pg_catalog.pg_database where datname='${stage}'));`);
    exact(created, ['ok', 'stageOid']); oid(created.stageOid); if (created.ok !== true) fail('INVALID_RESULT');
    const after = await inspect(transactionId);
    if (after.databases[live]?.oid !== before.databases[live].oid || !after.databases[live].allowConnections
        || after.databases[stage]?.oid !== created.stageOid || !after.databases[stage].allowConnections
        || created.stageOid === before.databases[live].oid || after.databases[previous] || after.databases[failed]) fail('CHANGED');
    return { transactionId, liveOid: before.databases[live].oid, stageOid: after.databases[stage].oid, stageDatabase: stage };
  }
  async function cleanupCompatibilityStage(created) {
    const { transactionId, liveOid, stageOid, stageDatabase: stage } = created;
    const { previous, failed } = transaction(transactionId);
    function checkProjection(projection, enabled) {
      const live = projection.databases[liveDatabase], probe = projection.databases[stage];
      if (stageOid === liveOid || live?.oid !== liveOid || !live.allowConnections || probe?.oid !== stageOid
          || probe.allowConnections !== enabled || projection.databases[previous] || projection.databases[failed]) fail('CHANGED');
    }
    function guard(enabled) {
      // Only the probe must be disconnected: the live application is still running.
      return `do $compatibility$ begin
        if not exists(select 1 from pg_catalog.pg_database where datname='${liveDatabase}' and oid='${liveOid}'::oid
          and datallowconn and datdba=(select oid from pg_catalog.pg_roles where rolname=current_user))
          then raise exception 'live database changed'; end if;
        if not exists(select 1 from pg_catalog.pg_database where datname='${stage}' and oid='${stageOid}'::oid
          and ${enabled ? '' : 'not '}datallowconn and datdba=(select oid from pg_catalog.pg_roles where rolname=current_user))
          then raise exception 'compatibility database changed'; end if;
        if exists(select 1 from pg_catalog.pg_database where datname in ('${previous}','${failed}'))
          then raise exception 'compatibility slots changed'; end if;
        if exists(select 1 from pg_catalog.pg_stat_activity where datid='${stageOid}'::oid)
          then raise exception 'compatibility database is in use'; end if;
        end $compatibility$;`;
    }
    checkProjection(await inspect(transactionId), true);
    const disabled = await run(`begin; ${guard(true)}
      alter database "${stage}" allow_connections false;
      commit; select jsonb_build_object('disabled',true);`);
    exact(disabled, ['disabled']); if (disabled.disabled !== true) fail('INVALID_RESULT');
    checkProjection(await inspect(transactionId), false);
    // As with dropRetained, main must hold its cluster mutex across this entire callback API,
    // excluding every cooperating administrative writer. PostgreSQL cannot DROP DATABASE BY OID;
    // an uncooperative superuser can still rename a database in the server check->DROP interval.
    const dropped = await run(`${guard(false)}
      drop database "${stage}";
      select jsonb_build_object('dropped',true);`);
    exact(dropped, ['dropped']); if (dropped.dropped !== true) fail('INVALID_RESULT');
    const after = await inspect(transactionId);
    if (after.databases[liveDatabase]?.oid !== liveOid || !after.databases[liveDatabase].allowConnections
        || after.databases[stage] || after.databases[previous] || after.databases[failed]
        || Object.values(after.databases).some(row => row.oid === stageOid)) fail('CHANGED');
    const absent = await run(`select jsonb_build_object('absent',not exists(select 1 from pg_catalog.pg_database
      where oid='${stageOid}'::oid or datname='${stage}'));`);
    exact(absent, ['absent']); if (absent.absent !== true) fail('CHANGED');
  }
  async function withCompatibilityStage(callback) {
    if (typeof callback !== 'function') fail('INVALID');
    compatibilityActive = true;
    try {
      // No archive-controlled UUID, SQL, name or cleanup authority enters this API. If CREATE
      // loses its receipt or identity readback, do not guess which database might be ours.
      const created = Object.freeze(await createStage({ transactionId: crypto.randomUUID() }));
      let result, callbackError, callbackFailed = false;
      // The trusted main callback must await its stage adapter's close before settling.
      // Cleanup independently checks server sessions, and never terminates them forcibly.
      try { result = await callback(created.stageDatabase); } catch (error) { callbackFailed = true; callbackError = error; }
      try { await cleanupCompatibilityStage(created); } catch { fail('CLEANUP'); }
      if (callbackFailed) throw callbackError;
      return result;
    } finally { compatibilityActive = false; }
  }
  async function swap(value) {
    exact(value, ['transactionId', 'liveOid', 'stageOid']); oid(value.liveOid); oid(value.stageOid);
    const { stage, previous, failed } = transaction(value.transactionId);
    if (value.liveOid === value.stageOid) fail('INVALID');
    const before = await inspect(value.transactionId);
    if (before.databases[liveDatabase]?.oid === value.stageOid && before.databases[previous]?.oid === value.liveOid
        && before.databases[liveDatabase].allowConnections && !before.databases[previous].allowConnections
        && !before.databases[stage] && !before.databases[failed]) return before;
    if (before.databases[liveDatabase]?.oid !== value.liveOid || before.databases[stage]?.oid !== value.stageOid
        || !before.databases[liveDatabase].allowConnections || !before.databases[stage].allowConnections
        || before.databases[previous] || before.databases[failed]) fail('CHANGED');
    await run(`begin; ${checkSql({ [liveDatabase]: value.liveOid, [stage]: value.stageOid })}
      alter database "${liveDatabase}" allow_connections false;
      alter database "${liveDatabase}" rename to "${previous}";
      alter database "${stage}" rename to "${liveDatabase}";
      commit; select jsonb_build_object('ok',true);`);
    const after = await inspect(value.transactionId);
    if (after.databases[liveDatabase]?.oid !== value.stageOid || after.databases[previous]?.oid !== value.liveOid
        || after.databases[previous].allowConnections || !after.databases[liveDatabase].allowConnections || after.databases[stage]) fail('CHANGED');
    return after;
  }
  async function rollback(value) {
    exact(value, ['transactionId', 'liveOid', 'stageOid']); oid(value.liveOid); oid(value.stageOid);
    const before = await inspect(value.transactionId); const { stage, previous, failed } = before.names;
    if (before.databases[liveDatabase]?.oid === value.liveOid && !before.databases[previous]
        && before.databases[liveDatabase].allowConnections && !(before.databases[stage] && before.databases[failed])
        && (!before.databases[stage] || before.databases[stage].oid === value.stageOid && before.databases[stage].allowConnections)
        && (!before.databases[failed] || before.databases[failed].oid === value.stageOid && !before.databases[failed].allowConnections)) return before;
    if (before.databases[liveDatabase]?.oid !== value.stageOid || before.databases[previous]?.oid !== value.liveOid
        || !before.databases[liveDatabase].allowConnections || before.databases[previous].allowConnections
        || before.databases[stage] || before.databases[failed]) fail('CHANGED');
    await run(`begin; ${checkSql({ [liveDatabase]: value.stageOid, [previous]: value.liveOid })}
      alter database "${liveDatabase}" allow_connections false;
      alter database "${liveDatabase}" rename to "${failed}";
      alter database "${previous}" rename to "${liveDatabase}";
      alter database "${liveDatabase}" allow_connections true;
      commit; select jsonb_build_object('ok',true);`);
    const after = await inspect(value.transactionId);
    if (after.databases[liveDatabase]?.oid !== value.liveOid || !after.databases[liveDatabase].allowConnections
        || after.databases[failed]?.oid !== value.stageOid || after.databases[failed].allowConnections || after.databases[previous]) fail('CHANGED');
    return after;
  }
  async function verifyQuiescent() {
    const value = await run(`select jsonb_build_object('jobs',(select count(*)::text from public.analysis_jobs
      where status in ('QUEUED','RUNNING','CANCELLING')),'steps',(select count(*)::text from public.analysis_job_steps
      where status='RUNNING'));`, liveDatabase);
    exact(value, ['jobs', 'steps']); if (value.jobs !== '0' || value.steps !== '0') fail('ACTIVE_WORK'); return true;
  }
  async function readSizes(argument) {
    exact(argument, ['transactionId']);
    const projection = await inspect(argument.transactionId), live = projection.databases[liveDatabase];
    if (!live) fail('CHANGED');
    return Object.freeze({ version: 1, liveDatabaseBytes: live.bytes,
      databases: Object.freeze(Object.fromEntries(Object.entries(projection.names).map(([slot, name]) => [slot,
        projection.databases[name] ? Object.freeze({ oid: projection.databases[name].oid, bytes: projection.databases[name].bytes }) : null]))) });
  }
  let dropping = false;
  async function dropRetained(value) {
    exact(value, ['transactionId', 'databaseOid', 'slot']); oid(value.databaseOid);
    if (!['previous', 'failed'].includes(value.slot) || typeof readRetentionAuthority !== 'function') fail('AUTHORITY');
    const name = transaction(value.transactionId)[value.slot];
    if (closed || terminationFailed) fail('UNAVAILABLE'); if (dropping) fail('UNAVAILABLE'); dropping = true;
    try {
      async function readAllowed() {
        let candidate;
        try { candidate = retentionCandidate(await readRetentionAuthority(), value.transactionId, true); }
        catch { fail('AUTHORITY'); }
        if (!candidate.manifest.databases.some(row => row.slot === value.slot && row.oid === value.databaseOid)) fail('AUTHORITY');
        return candidate;
      }
      const initial = await readAllowed(), before = await inspect(value.transactionId), live = before.databases[liveDatabase], target = before.databases[name];
      if (!live || !live.allowConnections || live.oid === value.databaseOid) fail('CHANGED');
      if (!target) {
        if (Object.values(before.databases).some(row => row.oid === value.databaseOid)) fail('CHANGED');
        const absent = await run(`select jsonb_build_object('absent',not exists(select 1 from pg_catalog.pg_database
          where oid='${value.databaseOid}'::oid));`);
        exact(absent, ['absent']); if (absent.absent !== true) fail('CHANGED');
        // Absence is idempotent only after authenticated GC_BEGIN/END for this exact manifest.
        const again = await readAllowed(); if (again.manifestSha256 !== initial.manifestSha256) fail('AUTHORITY');
        return Object.freeze({ transactionId: value.transactionId, databaseOid: value.databaseOid, slot: value.slot, absent: true });
      }
      if (initial.tombstone.state !== 'BEGUN' || target.oid !== value.databaseOid || target.allowConnections) fail('CHANGED');
      const again = await readAllowed();
      if (again.manifestSha256 !== initial.manifestSha256 || again.tombstone.state !== 'BEGUN') fail('AUTHORITY');
      // DROP DATABASE cannot be in a transaction. The main cluster mutex must exclude every
      // cooperating administrative writer. A hostile superuser can still rename a DB in the
      // check->DROP interval; PostgreSQL has no DROP DATABASE BY OID primitive.
      const dropped = await run(`do $retained$ begin
        if not exists(select 1 from pg_catalog.pg_database where datname='${liveDatabase}' and oid='${live.oid}'::oid
          and datallowconn and datdba=(select oid from pg_catalog.pg_roles where rolname=current_user))
          then raise exception 'live database changed'; end if;
        if not exists(select 1 from pg_catalog.pg_database where datname='${name}' and oid='${value.databaseOid}'::oid
          and not datallowconn and datdba=(select oid from pg_catalog.pg_roles where rolname=current_user))
          then raise exception 'retained database changed'; end if;
        if exists(select 1 from pg_catalog.pg_stat_activity where datid='${value.databaseOid}'::oid)
          then raise exception 'retained database is in use'; end if;
        end $retained$;
        drop database "${name}";
        select jsonb_build_object('dropped',true);`);
      exact(dropped, ['dropped']); if (dropped.dropped !== true) fail('INVALID_RESULT');
      const after = await inspect(value.transactionId);
      if (after.databases[liveDatabase]?.oid !== live.oid || !after.databases[liveDatabase].allowConnections
          || after.databases[name] || Object.values(after.databases).some(row => row.oid === value.databaseOid)) fail('CHANGED');
      const last = await readAllowed(); if (last.manifestSha256 !== initial.manifestSha256) fail('AUTHORITY');
      return Object.freeze({ transactionId: value.transactionId, databaseOid: value.databaseOid, slot: value.slot, absent: false });
    } finally { dropping = false; }
  }
  let operation = false;
  const serialized = method => async (...args) => {
    if (operation || closed || terminationFailed) fail('UNAVAILABLE'); operation = true;
    try { return await method(...args); } finally { operation = false; }
  };
  return Object.freeze({ inspect: serialized(inspect), createStage: serialized(createStage), swap: serialized(swap),
    rollback: serialized(rollback), verifyQuiescent: serialized(verifyQuiescent), readSizes: serialized(readSizes), dropRetained: serialized(dropRetained),
    withCompatibilityStage: serialized(withCompatibilityStage),
    async close() { if (compatibilityActive) fail('BUSY'); closed = true; active?.terminate('CLOSED');
      if (busy) fail('BUSY'); delete environment.PGPASSWORD; if (terminationFailed) fail('TERMINATION'); } });
}
module.exports = Object.freeze({ createBackupDatabaseControl, BackupDatabaseError });
