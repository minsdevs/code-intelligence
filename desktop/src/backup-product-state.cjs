'use strict';

// Main-only fixed operations after writers have stopped. Main supplies its owned PostgreSQL
// child, trusted paths and source-worker-confirmed Git stores. This is not an archive SQL API,
// a database/OID swap controller, a filesystem mover, or a Redis/session revocation mechanism.
const fs = require('node:fs/promises');
const { constants } = require('node:fs');
const path = require('node:path');
const { spawn: realSpawn } = require('node:child_process');
const { TextDecoder, types: { isProxy } } = require('node:util');

const LIMITS = Object.freeze({ timeoutMs: 30000, inputBytes: 2 * 1024 * 1024,
  outputBytes: 1024 * 1024, stderrBytes: 65536, projectIds: 10000 });
const MAX = 9223372036854775807n;
const CODES = new Set(['INVALID', 'UNSAFE', 'ORIGIN', 'CLOSED', 'BUSY', 'FAILED', 'LIMIT',
  'TIMEOUT', 'TERMINATION', 'INVALID_RESULT']);
class BackupProductStateError extends Error {
  constructor(code = 'FAILED') {
    const safe = CODES.has(code) ? code : 'FAILED';
    super(`Backup product state: ${safe}`); this.name = 'BackupProductStateError';
    this.code = `BACKUP_PRODUCT_STATE_${safe}`;
  }
}
function fail(code) { throw new BackupProductStateError(code); }
function plain(value) {
  if (!value || typeof value !== 'object' || isProxy(value) || Array.isArray(value)
      || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) fail('INVALID');
}
function exact(value, keys) {
  plain(value);
  if (Reflect.ownKeys(value).length !== keys.length) fail('INVALID');
  for (const key of keys) {
    const d = Object.getOwnPropertyDescriptor(value, key);
    if (!d || !d.enumerable || !Object.hasOwn(d, 'value')) fail('INVALID');
  }
}
function matches(value, pattern) { return typeof value === 'string' && value.match(pattern)?.[0] === value; }
function absolute(value) {
  if (typeof value !== 'string' || Buffer.byteLength(value) > 4096 || /[\x00-\x1f\x7f]/.test(value)
      || !path.isAbsolute(value) || path.resolve(value) !== value) fail('INVALID');
  return value;
}
function decimal(value, max = MAX) {
  if (!matches(value, /^[1-9][0-9]{0,19}$/) || BigInt(value) > max) fail('INVALID'); return value;
}
function database(value) {
  if (value !== 'codeintel' && !matches(value, /^ci_backup_(?:live|stage)_[0-9a-f]{16,32}$/)) fail('INVALID');
  return value;
}
function jsonSql(value) {
  return `convert_from(decode('${Buffer.from(JSON.stringify(value)).toString('base64')}','base64'),'UTF8')::jsonb`;
}
function identity(stat) { return `${stat.dev}:${stat.ino}`; }
async function directory(value) {
  const stat = await fs.lstat(value, { bigint: true });
  if (!stat.isDirectory() || stat.isSymbolicLink() || typeof process.getuid !== 'function'
      || stat.uid !== BigInt(process.getuid()) || (stat.mode & 0o7022n) !== 0n
      || await fs.realpath(value) !== value) fail('UNSAFE');
  return identity(stat);
}
async function binaryIdentity(value) {
  const stat = await fs.lstat(value, { bigint: true });
  if (!stat.isFile() || stat.isSymbolicLink() || !(stat.mode & 0o111n)
      || (stat.mode & 0o7022n) !== 0n || await fs.realpath(value) !== value) fail('UNSAFE');
  return `${identity(stat)}:${stat.size}:${stat.mtimeNs}:${stat.ctimeNs}`;
}
async function postmaster(value) {
  const filename = path.join(value, 'postmaster.pid');
  const handle = await fs.open(filename, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  const bytes = Buffer.alloc(4097);
  try {
    const before = await handle.stat({ bigint: true });
    if (!before.isFile() || before.nlink !== 1n || before.uid !== BigInt(process.getuid())
        || (before.mode & 0o7077n) !== 0n || before.size < 1n || before.size > 4096n) fail('UNSAFE');
    let used = 0;
    while (used < bytes.length) {
      const result = await handle.read(bytes, used, bytes.length - used, used);
      if (!result.bytesRead) break; used += result.bytesRead;
    }
    if (used > 4096 || BigInt(used) !== before.size) fail('ORIGIN');
    const fields = new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(0, used)).split('\n');
    if (fields.length < 5 || !matches(fields[0], /^[1-9][0-9]{0,9}$/)
        || fields[1] !== value || !matches(fields[2], /^[1-9][0-9]{0,12}$/)
        || !matches(fields[3], /^[1-9][0-9]{0,4}$/)) fail('ORIGIN');
    const after = await handle.stat({ bigint: true });
    const named = await fs.lstat(filename, { bigint: true });
    if (identity(before) !== identity(after) || before.size !== after.size || before.mtimeNs !== after.mtimeNs
        || before.ctimeNs !== after.ctimeNs || identity(before) !== identity(named) || named.isSymbolicLink()) fail('ORIGIN');
    return { identity: identity(before), pid: Number(fields[0]), dataDirectory: fields[1],
      startEpochSeconds: fields[2], port: Number(fields[3]) };
  } finally { bytes.fill(0); await handle.close(); }
}

const ORIGIN_SQL = `select jsonb_build_object('kind','origin',
  'systemIdentifier',(select system_identifier::text from pg_catalog.pg_control_system()),
  'dataDirectory',pg_catalog.current_setting('data_directory'),
  'startEpochSeconds',floor(extract(epoch from pg_catalog.pg_postmaster_start_time()))::text,
  'port',pg_catalog.inet_server_port(),'database',pg_catalog.current_database(),
  'user',current_user,'sessionUser',session_user);`;
// A client-side write is not proof that COMMIT reached PostgreSQL. ON_ERROR_STOP must
// allow this separate statement to return before EOF/close0 can acknowledge success.
const COMMIT_SQL = "commit;\nselect pg_catalog.jsonb_build_object('kind','committed');\n";
const QUIESCENT_SQL = `if exists(select 1 from pg_catalog.pg_stat_activity
    where datname=current_database() and pid<>pg_backend_pid()) then
    raise exception 'product state has other database sessions'; end if;
  if exists(select 1 from public.analysis_jobs where status in ('QUEUED','RUNNING','CANCELLING'))
    or exists(select 1 from public.analysis_job_steps where status='RUNNING') then
    raise exception 'product state has active work'; end if;`;
const REVOKE_SQL = `do $backup_revoke$
begin
  lock table public.users in share mode;
  lock table public.projects,public.github_credentials,public.user_ai_settings,public.user_ai_preferences,
    public.local_source_approvals,public.job_local_source_inputs,
    public.analysis_jobs,public.analysis_job_steps in access exclusive mode;
  ${QUIESCENT_SQL}
  -- V15 encrypted_key and nonce are NOT NULL. Delete credential rows, never manufacture keys.
  -- V24 keyless preferences win over the legacy settings fallback for the same owner.
  insert into public.user_ai_preferences(user_id,provider,model,connection_state,revision)
    select user_id,provider,model,'OFF',0 from public.user_ai_settings on conflict(user_id) do nothing;
  if exists(select 1 from public.user_ai_preferences p where revision=${MAX}
      and (connection_state<>'OFF' or exists(select 1 from public.user_ai_settings s where s.user_id=p.user_id)))
    then raise exception 'product preference revision exhausted'; end if;
  update public.user_ai_preferences p set connection_state='OFF',revision=revision+1,updated_at=now()
    where connection_state<>'OFF' or exists(select 1 from public.user_ai_settings s where s.user_id=p.user_id);
  delete from public.github_credentials;
  delete from public.user_ai_settings;
  delete from public.local_source_approvals;
  delete from public.job_local_source_inputs;
  -- A rollback preserves the original database, but must not retain a local path that
  -- legacy IDE consumers can use without consulting the now-revoked picker approval.
  -- Internal, verified clone paths and all source bytes remain untouched.
  update public.projects set local_path=null where local_path is not null;
end $backup_revoke$;
select jsonb_build_object('kind','result',
  'githubCredentials',(select count(*)::text from public.github_credentials),
  'aiCredentials',(select count(*)::text from public.user_ai_settings),
  'localApprovals',(select count(*)::text from public.local_source_approvals),
  'localInputs',(select count(*)::text from public.job_local_source_inputs),
  'localPaths',(select count(*)::text from public.projects where local_path is not null),
  'nonOffPreferences',(select count(*)::text from public.user_ai_preferences where connection_state<>'OFF'));`;
function rebindSql(value) {
  const input = jsonSql(value);
  return `do $backup_paths$ declare v jsonb := ${input};
  begin
    lock table public.projects,public.analysis_jobs,public.analysis_job_steps in access exclusive mode;
    ${QUIESCENT_SQL}
    if (select count(*) from public.projects p where p.id in
        (select value::bigint from jsonb_array_elements_text(v->'projectIds')) and source_type in ('GITHUB','LOCAL'))
        <>jsonb_array_length(v->'projectIds') then raise exception 'unconfirmed product project'; end if;
    update public.projects p set local_path=null,clone_path=case when p.id in
      (select value::bigint from jsonb_array_elements_text(v->'projectIds'))
      then (v->>'reposRoot')||'/'||p.id::text else null end;
  end $backup_paths$;
  with params as (select ${input} as v)
  select jsonb_build_object('kind','result','invalidPaths',
    (select count(*)::text from public.projects p where p.local_path is not null or p.clone_path is distinct from
      case when p.id in (select value::bigint from jsonb_array_elements_text(v->'projectIds'))
      then (v->>'reposRoot')||'/'||p.id::text else null end),
    'projectIds',(select coalesce(jsonb_agg(p.id::text order by p.id),'[]'::jsonb) from public.projects p
      where p.clone_path is not null)) from params;`;
}

async function createBackupProductState(options) {
  plain(options);
  const required = ['psqlPath', 'connection', 'env', 'expectedDataDirectory', 'ownedPostgres', 'dataRoot'];
  exact(options, [...required, ...['spawn', 'timeoutMs'].filter(key => Object.hasOwn(options || {}, key))]);
  const psqlPath = absolute(options.psqlPath), expectedDataDirectory = absolute(options.expectedDataDirectory);
  const dataRoot = absolute(options.dataRoot), child = options.ownedPostgres;
  const connection = options.connection; exact(connection, ['host', 'port', 'user']);
  if (connection.host !== '127.0.0.1' || !Number.isInteger(connection.port) || connection.port < 1 || connection.port > 65535
      || !matches(connection.user, /^[A-Za-z_][A-Za-z0-9_]{0,62}$/)) fail('INVALID');
  const port = connection.port, user = connection.user;
  if (!child || !Number.isSafeInteger(child.pid) || child.pid < 1 || child.pid > 2147483647
      || ['on', 'removeListener'].some(key => typeof child[key] !== 'function')) fail('INVALID');
  const ownedPid = child.pid;
  const spawn = options.spawn ?? realSpawn, timeoutMs = options.timeoutMs ?? LIMITS.timeoutMs;
  if (typeof spawn !== 'function' || !Number.isInteger(timeoutMs) || timeoutMs < 20 || timeoutMs > LIMITS.timeoutMs) fail('INVALID');
  if (!options.env || typeof options.env !== 'object' || isProxy(options.env) || Array.isArray(options.env)) fail('INVALID');
  const envKeys = Object.keys(options.env);
  if (!envKeys.includes('PGPASSWORD') || envKeys.some(key => !['PGPASSWORD', 'LD_LIBRARY_PATH', 'DYLD_LIBRARY_PATH'].includes(key))) fail('INVALID');
  exact(options.env, envKeys);
  const environment = { LANG: 'C', LC_ALL: 'C', TZ: 'UTC', PGCLIENTENCODING: 'UTF8',
    PGCONNECT_TIMEOUT: '5', PGAPPNAME: 'code-intelligence-backup-product', PGSSLMODE: 'disable' };
  for (const key of envKeys) {
    const value = options.env[key];
    if (typeof value !== 'string' || !value.length || Buffer.byteLength(value) > 16384 || value.includes('\0')) fail('INVALID');
    environment[key] = value;
  }
  let closed = false, busy = false, invalidated = false, terminationFailed = false, active = null, inFlight = null;
  let initialLocal = null, origin = null, closePromise;
  function assertAlive() {
    if (closed) fail('CLOSED');
    if (invalidated || child.pid !== ownedPid || child.exitCode !== null || child.signalCode !== null || child.killed) fail('ORIGIN');
    if (terminationFailed) fail('TERMINATION');
  }
  function lostOrigin() { invalidated = true; active?.terminate('ORIGIN'); }
  child.on('exit', lostOrigin); child.on('close', lostOrigin); child.on('error', lostOrigin);
  async function inspectLocal() {
    assertAlive();
    try {
      const dataIdentity = await directory(expectedDataDirectory), rootIdentity = await directory(dataRoot);
      const binary = await binaryIdentity(psqlPath), lock = await postmaster(expectedDataDirectory);
      assertAlive();
      if (lock.pid !== ownedPid || lock.port !== port) fail('ORIGIN');
      const local = { dataIdentity, rootIdentity, binary, lock };
      if (initialLocal && JSON.stringify(local) !== JSON.stringify(initialLocal)) fail('ORIGIN');
      return local;
    } catch (error) {
      invalidated = true;
      if (error instanceof BackupProductStateError) throw error;
      fail('ORIGIN');
    }
  }
  function checkOrigin(value, db) {
    exact(value, ['kind', 'systemIdentifier', 'dataDirectory', 'startEpochSeconds', 'port', 'database', 'user', 'sessionUser']);
    decimal(value.systemIdentifier, 18446744073709551615n);
    if (value.kind !== 'origin' || value.dataDirectory !== expectedDataDirectory
        || value.startEpochSeconds !== initialLocal.lock.startEpochSeconds || value.port !== port
        || value.database !== db || value.user !== user || value.sessionUser !== user
        || (origin && value.systemIdentifier !== origin.systemIdentifier)) { invalidated = true; fail('ORIGIN'); }
    return Object.freeze({ systemIdentifier: value.systemIdentifier, dataDirectory: expectedDataDirectory,
      postmasterPid: ownedPid, startEpochSeconds: value.startEpochSeconds, port });
  }
  async function execute(db, sql, validate, readOnly = false) {
    try {
      await inspectLocal(); assertAlive();
      return await new Promise((resolve, reject) => {
        let process, timer, killTimer, reapTimer, reason, settled = false, state = 'origin';
        let processExited = false, processClosed = false, stdoutEnded = false, stderrEnded = false;
        let bytesOut = 0, bytesErr = 0, bytesIn = 0, linesOut = 0;
        let pending = Buffer.alloc(0), handling = Promise.resolve(), result;
        function finish(code) {
          if (settled) return; settled = true; active = null;
          clearTimeout(timer); clearTimeout(killTimer); clearTimeout(reapTimer); pending.fill(0);
          code ||= reason;
          if (code === 'TERMINATION') terminationFailed = true;
          code ? reject(new BackupProductStateError(code)) : resolve(result);
        }
        function terminate(code) {
          if (settled) return;
          reason ||= code;
          if (processClosed) { finish(reason); return; }
          try { process?.kill('SIGTERM'); } catch {}
          killTimer ||= setTimeout(() => { try { process?.kill('SIGKILL'); } catch {} }, 200);
          reapTimer ||= setTimeout(() => finish('TERMINATION'), 2000);
        }
        function canSend() {
          if (settled || reason) return false;
          if (processExited || processClosed || process.exitCode != null || process.signalCode != null
              || process.stdin.destroyed || process.stdin.writableEnded || process.stdin.writableFinished) {
            terminate('INVALID_RESULT'); return false;
          }
          return true;
        }
        function send(text, end = false) {
          if (!canSend()) return;
          bytesIn += Buffer.byteLength(text); if (bytesIn > LIMITS.inputBytes) { terminate('LIMIT'); return; }
          try { end ? process.stdin.end(text) : process.stdin.write(text); } catch { terminate('FAILED'); }
        }
        async function onLine(bytes) {
          if (settled || reason) return;
          let value;
          try { value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); }
          catch { terminate('INVALID_RESULT'); return; }
          try {
            if (state === 'origin') {
              const binding = checkOrigin(value, db); await inspectLocal(); assertAlive();
              if (!canSend()) return;
              origin ||= binding; state = 'result'; send(sql + '\n');
            } else if (state === 'result') {
              result = validate(value); await inspectLocal(); assertAlive();
              if (!canSend()) return;
              state = 'receipt'; send(COMMIT_SQL, true);
            } else if (state === 'receipt') {
              try { exact(value, ['kind']); } catch { fail('INVALID_RESULT'); }
              if (value.kind !== 'committed') fail('INVALID_RESULT');
              state = 'committed';
            } else terminate('INVALID_RESULT');
          } catch (error) {
            terminate(error instanceof BackupProductStateError ? error.code.slice('BACKUP_PRODUCT_STATE_'.length) : 'INVALID_RESULT');
          }
        }
        try {
          process = spawn(psqlPath, ['-X', '--no-password', '--quiet', '--tuples-only', '--no-align', '--pset=pager=off',
            '--set=ON_ERROR_STOP=1', '--host=127.0.0.1', `--port=${port}`, `--username=${user}`, `--dbname=${db}`, '--file=-'],
          { env: { ...environment }, cwd: path.dirname(psqlPath), shell: false, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
        } catch { finish('FAILED'); return; }
        active = { terminate };
        process.on('error', () => process.pid ? terminate('FAILED') : finish('FAILED'));
        process.once('exit', () => { processExited = true; });
        for (const stream of [process.stdin, process.stdout, process.stderr]) stream.on('error', () => terminate('FAILED'));
        process.stdout.once('end', () => { stdoutEnded = true; });
        process.stderr.once('end', () => { stderrEnded = true; });
        process.stdout.on('data', chunk => {
          if (settled || reason) return; bytesOut += chunk.length;
          if (bytesOut > LIMITS.outputBytes) { terminate('LIMIT'); return; }
          const joined = Buffer.concat([pending, chunk]); pending.fill(0); pending = joined;
          let index;
          while ((index = pending.indexOf(10)) !== -1) {
            if (++linesOut > 3) { terminate('INVALID_RESULT'); return; }
            const line = Buffer.from(pending.subarray(0, index)), rest = Buffer.from(pending.subarray(index + 1));
            pending.fill(0); pending = rest;
            // Hold each complete output line behind the previous handshake (including filesystem
            // revalidation). Unexpected extra output cannot authorize the next protocol phase.
            const receivedState = state;
            handling = handling.then(async () => {
              try { if (state !== receivedState) { terminate('INVALID_RESULT'); return; } await onLine(line); }
              finally { line.fill(0); }
            }).catch(() => terminate('FAILED'));
          }
        });
        process.stderr.on('data', chunk => {
          if (settled) return; bytesErr += chunk.length; if (bytesErr > LIMITS.stderrBytes) terminate('LIMIT');
        });
        process.once('close', code => {
          processClosed = true;
          if (reason || code !== 0) { finish(reason || 'FAILED'); return; }
          // A receipt already received may still be queued for parsing. Earlier phases,
          // however, cannot authorize a new SQL write after the child has closed.
          if (!['receipt', 'committed'].includes(state)) { finish('INVALID_RESULT'); return; }
          handling.then(async () => {
            if (settled) return;
            if (reason || code !== 0) { finish(reason || 'FAILED'); return; }
            if (state !== 'committed' || pending.length) { finish('INVALID_RESULT'); return; }
            try {
              await inspectLocal(); assertAlive();
              if (settled) return;
              if (reason) { finish(reason); return; }
              if (state !== 'committed' || pending.length || !stdoutEnded || !stderrEnded) { finish('INVALID_RESULT'); return; }
              finish();
            }
            catch (error) { finish(error instanceof BackupProductStateError ? error.code.slice('BACKUP_PRODUCT_STATE_'.length) : 'ORIGIN'); }
          }).catch(() => finish('FAILED'));
        });
        timer = setTimeout(() => terminate('TIMEOUT'), timeoutMs);
        send(`begin${readOnly ? ' isolation level repeatable read read only' : ''};\nset local search_path=pg_catalog;\n`
          + `set local statement_timeout='15000ms';\nset local lock_timeout='5000ms';\n${ORIGIN_SQL}\n`);
      });
    } finally { busy = false; }
  }
  function operation(db, sql, validate, readOnly) {
    try { assertAlive(); if (busy) fail('BUSY'); } catch (error) { return Promise.reject(error); }
    busy = true;
    const promise = execute(db, sql, validate, readOnly);
    inFlight = promise; promise.finally(() => { if (inFlight === promise) inFlight = null; }).catch(() => {});
    return promise;
  }
  async function verifyOrigin() {
    return operation('postgres', "select jsonb_build_object('kind','result','ok',true);", value => {
      exact(value, ['kind', 'ok']); if (value.kind !== 'result' || value.ok !== true) fail('INVALID_RESULT'); return origin;
    }, true);
  }
  async function revokeCredentials(value) {
    exact(value, ['database']); const db = database(value.database);
    return operation(db, REVOKE_SQL, result => {
      const keys = ['githubCredentials', 'aiCredentials', 'localApprovals', 'localInputs', 'localPaths', 'nonOffPreferences'];
      exact(result, ['kind', ...keys]);
      if (result.kind !== 'result' || keys.some(key => result[key] !== '0')) fail('INVALID_RESULT');
      return Object.freeze({ credentialsCleared: true, localApprovalsCleared: true, localPathsCleared: true, preferencesOff: true });
    });
  }
  async function rebindClonePaths(value) {
    exact(value, ['database', 'confirmedGitProjectIds']); const db = database(value.database), ids = value.confirmedGitProjectIds;
    if (!Array.isArray(ids) || isProxy(ids) || ids.length > LIMITS.projectIds
        || Reflect.ownKeys(ids).length !== ids.length + 1) fail('INVALID');
    const projectIds = [];
    for (let i = 0; i < ids.length; i++) {
      const d = Object.getOwnPropertyDescriptor(ids, String(i)); if (!d || !Object.hasOwn(d, 'value')) fail('INVALID');
      projectIds.push(decimal(d.value));
    }
    if (new Set(projectIds).size !== projectIds.length) fail('INVALID');
    projectIds.sort((a, b) => BigInt(a) < BigInt(b) ? -1 : 1);
    return operation(db, rebindSql({ reposRoot: path.join(dataRoot, 'repos'), projectIds }), result => {
      exact(result, ['kind', 'invalidPaths', 'projectIds']);
      if (result.kind !== 'result' || result.invalidPaths !== '0'
          || JSON.stringify(result.projectIds) !== JSON.stringify(projectIds)) fail('INVALID_RESULT');
      return Object.freeze({ projectIds: Object.freeze([...projectIds]), localPathsCleared: true });
    });
  }
  async function close() {
    if (closePromise) return closePromise;
    closed = true; active?.terminate('CLOSED');
    closePromise = (async () => {
      await inFlight?.catch(() => {});
      child.removeListener('exit', lostOrigin); child.removeListener('close', lostOrigin); child.removeListener('error', lostOrigin);
      delete environment.PGPASSWORD;
      if (terminationFailed) fail('TERMINATION');
    })(); return closePromise;
  }
  try { initialLocal = await inspectLocal(); await verifyOrigin(); }
  catch (error) { await close().catch(() => {}); if (error instanceof BackupProductStateError) throw error; fail('ORIGIN'); }
  return Object.freeze({ verifyOrigin, revokeCredentials, rebindClonePaths, close });
}

module.exports = Object.freeze({ createBackupProductState, BackupProductStateError });
