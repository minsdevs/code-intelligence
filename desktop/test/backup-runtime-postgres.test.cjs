'use strict';

// OPT IN ONLY. This fixture creates its own private /tmp cluster and never accepts a database
// connection, installation path, existing key store, provider credential, or executable source.
// Real: V1–V25, psql, PG swaps, keyring/journal/gateway, archive/payload, source JAR, Redis,
// Spring maintenance startup/HTTP barrier and source directory swaps. Only OS key wrapping and
// the deliberately forbidden provider transport are synthetic. Electron/UI and power loss are
// outside this fixture. The root agent alone runs the opt-in case.
const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs/promises');
const path = require('node:path');
const net = require('node:net');
const crypto = require('node:crypto');
const zlib = require('node:zlib');
const { spawn } = require('node:child_process');
const { createDesktopBackupRuntime } = require('../src/backup-runtime.cjs');
const { createBackupPostgres } = require('../src/backup-postgres.cjs');
const { createBackupDatabaseControl } = require('../src/backup-database.cjs');
const { createBackupProductState } = require('../src/backup-product-state.cjs');
const { createBackupSourceWorker } = require('../src/backup-source-worker.cjs');
const { createAiEgressPostgres } = require('../src/ai-egress-postgres.cjs');
const { createMaintenanceVerifier } = require('../src/backup-cost-state.cjs');
const { initializePurposeKeyring, openPurposeKeyring } = require('../src/purpose-keyring.cjs');
const { initializeSafetyJournal, openSafetyJournal } = require('../src/safety-journal.cjs');
const { openDesktopAiGateway } = require('../src/ai-desktop-gateway.cjs');
const { createNativeOwnerLocks } = require('../src/native-owner-locks.cjs');
const { spawnManagedProcess } = require('../src/managed-process.cjs');

const ENABLED = process.env.CI_BACKUP_RUNTIME_REAL === '1';
const INSTALLATION = '11111111-2222-4333-8444-555555555555', BUILD = '20261003';
const OWNER = '9007199254740993', PROJECT = '7', SNAPSHOT = '9';
const REQUESTS = ['10000000-0000-4000-8000-000000000001', '10000000-0000-4000-8000-000000000002',
  '10000000-0000-4000-8000-000000000003'];
const ORIGINAL = 'Synthetic original note — 한글, decimal owner retained.';
const sha = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const jsonSql = value => `convert_from(decode('${Buffer.from(JSON.stringify(value)).toString('base64')}','base64'),'UTF8')::jsonb`;

async function binary(value, directory = false) {
  assert.equal(typeof value, 'string', 'Explicit fixture binary path is required');
  assert(path.isAbsolute(value), 'Fixture binary path must be absolute');
  const canonical = await fs.realpath(value), stat = await fs.lstat(canonical);
  assert(directory ? stat.isDirectory() : stat.isFile(), 'Fixture binary type mismatch');
  if (!directory) assert(stat.mode & 0o111, 'Fixture executable is not executable');
  return canonical;
}
async function privateDir(file) { await fs.mkdir(file, { mode: 0o700 }); return file; }
async function freePort() {
  const server = net.createServer(); await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const port = server.address().port; await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve())); return port;
}
function wrapper() {
  const key = Buffer.alloc(32, 83);
  return {
    async isAvailable() { return true; },
    async wrap(bytes) {
      const nonce = crypto.randomBytes(12), cipher = crypto.createCipheriv('aes-256-gcm', key, nonce);
      cipher.setAAD(Buffer.from('synthetic-backup-runtime-only'));
      return Buffer.concat([nonce, cipher.update(bytes), cipher.final(), cipher.getAuthTag()]);
    },
    async unwrap(bytes) {
      const decipher = crypto.createDecipheriv('aes-256-gcm', key, bytes.subarray(0, 12));
      decipher.setAAD(Buffer.from('synthetic-backup-runtime-only')); decipher.setAuthTag(bytes.subarray(-16));
      return Buffer.concat([decipher.update(bytes.subarray(12, -16)), decipher.final()]);
    },
  };
}
function gitObject(type, raw) {
  const header = Buffer.from(`${type.toLowerCase()} ${raw.length}\0`);
  return { type, raw, oid: crypto.createHash('sha1').update(header).update(raw).digest('hex'),
    compressed: zlib.deflateSync(Buffer.concat([header, raw])) };
}
async function syntheticGit(repos, publish = true) {
  const blob = gitObject('BLOB', Buffer.from('export const fixtureMessage = "synthetic original source";\n'));
  const tree = gitObject('TREE', Buffer.concat([Buffer.from('100644 index.ts\0'), Buffer.from(blob.oid, 'hex')]));
  const commit = gitObject('COMMIT', Buffer.from(`tree ${tree.oid}\nauthor Synthetic <fixture@example.invalid> 1700000000 +0000\n`
    + 'committer Synthetic <fixture@example.invalid> 1700000000 +0000\n\nSynthetic backup fixture\n'));
  if (!publish) return { blob, tree, commit };
  const git = path.join(repos, PROJECT, '.git');
  await fs.mkdir(path.join(git, 'objects'), { recursive: true, mode: 0o700 });
  for (const item of [blob, tree, commit]) {
    const folder = path.join(git, 'objects', item.oid.slice(0, 2)); await fs.mkdir(folder, { recursive: true, mode: 0o700 });
    await fs.writeFile(path.join(folder, item.oid.slice(2)), item.compressed, { mode: 0o600 });
  }
  // No git executable, repository config, hooks, remote or source working tree is needed.
  return { blob, tree, commit };
}

async function fixture(t, options = {}) {
  const resume = options.resume === true, guardedServices = options.guardedServices === true;
  assert(!resume || guardedServices, 'Restart fixtures must use native leases and guarded services');
  const pgBin = await binary(process.env.CI_BACKUP_RUNTIME_PG_BIN, true);
  const java = await binary(process.env.CI_BACKUP_RUNTIME_JAVA);
  const redisBinary = await binary(process.env.CI_BACKUP_RUNTIME_REDIS);
  assert(path.isAbsolute(process.env.CI_BACKUP_RUNTIME_JAR || ''), 'Explicit fixture JAR path required');
  const jar = await fs.realpath(process.env.CI_BACKUP_RUNTIME_JAR); assert((await fs.lstat(jar)).isFile());
  const psql = await binary(path.join(pgBin, 'psql')), initdb = await binary(path.join(pgBin, 'initdb'));
  const postgresBinary = await binary(path.join(pgBin, 'postgres'));
  const pgLib = process.env.CI_BACKUP_RUNTIME_PG_LIB ? await binary(process.env.CI_BACKUP_RUNTIME_PG_LIB, true) : null;
  const temp = await fs.realpath('/tmp'), root = options.root
    ? await fs.realpath(options.root) : await fs.mkdtemp(path.join(temp, 'ci-bkr-'));
  assert(path.dirname(root) === temp && (options.root
    ? /^ci-backup-resume-real-[A-Za-z0-9_-]+$/.test(path.basename(root)) : path.basename(root).startsWith('ci-bkr-')));
  if (options.root) {
    const rootStat = await fs.lstat(root, { bigint: true });
    const claimFile = path.join(root, 'fixture-claim.json'), claimStat = await fs.lstat(claimFile, { bigint: true });
    assert(rootStat.isDirectory() && !rootStat.isSymbolicLink() && rootStat.uid === BigInt(process.getuid()) && (rootStat.mode & 0o7777n) === 0o700n);
    assert(claimStat.isFile() && !claimStat.isSymbolicLink() && claimStat.nlink === 1n && claimStat.size < 4096n
      && claimStat.uid === BigInt(process.getuid()) && (claimStat.mode & 0o7777n) === 0o600n);
    const claim = JSON.parse(await fs.readFile(claimFile, 'utf8'));
    assert(/^[0-9a-f]{64}$/.test(options.nonce) && claim.nonce === options.nonce && claim.root === root && claim.parentPid === process.ppid
      && claim.device === String(rootStat.dev) && claim.inode === String(rootStat.ino), 'Only this parent-created fixture root may reopen');
  } else await fs.chmod(root, 0o700);
  let success = false, runtime, gateway, adapter, keyring, journal, backend, redis, postgres, ownerLocks;
  let recoveryMode = resume;
  let apiToken = crypto.randomBytes(32).toString('hex'), pathToken = crypto.randomBytes(32).toString('hex');
  const children = new Set(), leaseChildren = new Set(), trace = [], plans = [], failures = [];
  const controls = { failAfterHealth: false, providerCalls: 0, workerExports: 0, workerImports: 0,
    publicResumes: 0, invalidations: 0, verifiedHealth: 0, closed: false };
  const stateFile = path.join(root, 'fixture-state.json');
  let saved;
  if (resume) {
    const stat = await fs.lstat(stateFile, { bigint: true });
    assert(stat.isFile() && !stat.isSymbolicLink() && stat.nlink === 1n && stat.size < 4096n
      && stat.uid === BigInt(process.getuid()) && (stat.mode & 0o7777n) === 0o600n);
    saved = JSON.parse(await fs.readFile(stateFile, 'utf8'));
    assert(saved.nonce === options.nonce && /^synthetic-[0-9a-f]{48}$/.test(saved.password));
  }
  const password = saved?.password || `synthetic-${crypto.randomBytes(24).toString('hex')}`;
  if (options.root && !resume) await fs.writeFile(stateFile, JSON.stringify({ nonce: options.nonce, password }), { mode: 0o600, flag: 'wx' });
  const tokenKey = Buffer.alloc(32, 47).toString('base64');
  const systemEnv = { PATH: '/usr/bin:/bin', HOME: root, TMPDIR: root, LANG: 'C', LC_ALL: 'C', TZ: 'UTC' };
  const ports = { postgres: await freePort(), redis: await freePort(), backend: await freePort(), analyzer: await freePort() };
  assert.equal(new Set(Object.values(ports)).size, 4, 'Ephemeral port selection collided');
  const fixtureDirectory = async file => {
    if (!resume) return privateDir(file);
    const stat = await fs.lstat(file);
    assert(stat.isDirectory() && !stat.isSymbolicLink() && stat.uid === process.getuid() && (stat.mode & 0o7777) === 0o700);
    assert.equal(await fs.realpath(file), file); return file;
  };
  const userData = await fixtureDirectory(path.join(root, 'u')), pgData = path.join(root, 'pg');
  const transport = await require('../src/service-transport.cjs').createServiceTransport({ userData, ports, getApiToken: () => apiToken });
  const pgEnv = { PGPASSWORD: password, ...transport.postgresEnvironment, ...(pgLib ? { LD_LIBRARY_PATH: pgLib, DYLD_LIBRARY_PATH: pgLib } : {}) };
  const serverEnv = { ...systemEnv, ...pgEnv };
  const dataRoot = await fixtureDirectory(path.join(userData, 'data'));
  const repos = await fixtureDirectory(path.join(dataRoot, 'repos')); await fixtureDirectory(path.join(dataRoot, 'sources'));
  const redisRoot = path.join(userData, 'redis'); await fixtureDirectory(redisRoot);
  const temporaryRoot = await fixtureDirectory(path.join(root, 't')), destination = await fixtureDirectory(path.join(root, 'out'));
  const source = await syntheticGit(repos, !resume), migrationRoot = await fs.realpath(path.resolve(__dirname, '../../backend/src/main/resources/db/migration'));
  const connection = database => ({ host: '127.0.0.1', port: ports.postgres, user: 'codeintel', database });
  const pgOptions = (database, mode) => ({ psqlPath: psql, connection: connection(database), env: pgEnv,
    migrationRoot, installationId: INSTALLATION, mode });

  // All subprocesses belong to this new fixture. Real server logs are private local artifacts;
  // test output never echoes SQL, credentials, bootstrap material, source bytes or stderr.
  function launch(name, command, args, env, input) {
    const child = spawn(command, args, { cwd: root, env: { ...env }, shell: false,
      windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    const record = { child, name, stdout: [], stderr: [], stdoutBytes: 0, stderrBytes: 0, stopped: false, error: null };
    children.add(record);
    record.done = new Promise(resolve => child.once('close', (code, signal) => { record.stopped = true; record.code = code; record.signal = signal; resolve(); }));
    child.on('error', () => { record.error = true; });
    child.stdin.on('error', () => { record.error = true; });
    for (const stream of ['stdout', 'stderr']) {
      child[stream].on('error', () => { record.error = true; });
      child[stream].on('data', bytes => {
        record[`${stream}Bytes`] += bytes.length;
        if (record[`${stream}Bytes`] <= 4 * 1024 * 1024) record[stream].push(Buffer.from(bytes));
        else { record.error = true; try { child.kill('SIGTERM'); } catch {} }
      });
    }
    if (Buffer.isBuffer(input)) {
      // Pipe writes may retain their input until the callback. Own a copy so the caller can
      // immediately clear its private bootstrap without corrupting the child's stdin.
      const transferred = Buffer.from(input);
      child.stdin.end(transferred, () => transferred.fill(0));
      child.once('close', () => transferred.fill(0));
    } else if (input !== undefined) child.stdin.end(input);
    else child.stdin.end();
    return record;
  }
  async function launchService(name, command, args, env, input) {
    if (!guardedServices) return launch(name, command, args, env, input);
    const child = await spawnManagedProcess({ javaPath: java, jarPath: jar, command, args, cwd: root, env: { ...env },
      logPath: path.join(root, `${process.pid}-${name}.service.log`), ...(Buffer.isBuffer(input) ? { bootstrap: Buffer.from(input) } : {}) });
    const record = { child, name, stdout: [], stderr: [], stdoutBytes: 0, stderrBytes: 0, stopped: false, error: null,
      guarded: true, helperPid: child.helperPid };
    children.add(record);
    child.on('error', () => { record.error = true; });
    record.done = child.termination.then(proof => {
      record.stopped = proof.stopped; record.code = proof.exitCode; record.signal = proof.signalCode;
    }, () => { record.error = true; });
    options.onProcess?.({ name, pid: child.pid, helperPid: child.helperPid, guarded: true });
    return record;
  }
  async function stop(record) {
    if (!record || record.stopped) return;
    try { record.child.kill('SIGTERM'); } catch {}
    let timer;
    try { await Promise.race([record.done, new Promise(resolve => { timer = setTimeout(resolve, 5000); })]); }
    finally { clearTimeout(timer); }
    if (!record.stopped) {
      try { record.child.kill('SIGKILL'); } catch {}
      try { await Promise.race([record.done, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('Synthetic child could not be reaped')), 5000); })]); }
      finally { clearTimeout(timer); }
    }
    assert(record.stopped, 'An unverified guardian exit must not release fixture ownership');
  }
  async function command(name, executable, args, env, input, timeout = 30000) {
    const record = launch(name, executable, args, env, input); let timer;
    try {
      await Promise.race([record.done, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`Synthetic ${name} deadline exceeded`)), timeout); })]);
      if (record.code !== 0 || record.error) throw new Error(`Synthetic ${name} failed; private fixture evidence retained`);
      return Buffer.concat(record.stdout).toString('utf8').trim();
    } finally { clearTimeout(timer); await stop(record); }
  }
  async function sql(database, text) {
    assert(database === 'postgres' || database === 'codeintel' || /^ci_backup_(?:stage|live|previous|failed)_[a-f0-9]{16,32}$/.test(database));
    return command('psql', psql, ['-X', '--no-password', '--quiet', '--tuples-only', '--no-align', '--set=ON_ERROR_STOP=1',
      '--pset=pager=off', '--host=127.0.0.1', `--port=${ports.postgres}`, '--username=codeintel', `--dbname=${database}`, '--file=-'],
    { ...serverEnv, PGCLIENTENCODING: 'UTF8', PGCONNECT_TIMEOUT: '2' }, text);
  }
  async function sqlJson(text, database = 'codeintel') { return JSON.parse(await sql(database, text)); }
  async function wait(check, name, timeout = 90000, alive) {
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) {
      if (alive && !alive()) throw new Error(`Synthetic ${name} exited before readiness`);
      if (await check().catch(() => false)) return;
      await sleep(100);
    }
    throw new Error(`Synthetic ${name} readiness deadline exceeded`);
  }
  function redisRequest(parts) {
    return new Promise((resolve, reject) => {
      const socket = require('node:tls').connect({ host: '127.0.0.1', port: ports.redis,
        ca: transport.materials.redis.caPem, rejectUnauthorized: true }); let text = '', authenticated = false;
      socket.setTimeout(3000, () => socket.destroy(new Error('Synthetic Redis timeout')));
      socket.on('error', () => reject(new Error('Synthetic Redis unavailable')));
      socket.once('secureConnect', () => socket.write(
        `*2\r\n$4\r\nAUTH\r\n$64\r\n${transport.redisPassword}\r\n*${parts.length}\r\n` + parts.map(p => `$${Buffer.byteLength(p)}\r\n${p}\r\n`).join('')));
      socket.on('data', bytes => {
        text += bytes.toString('utf8');
        if (!authenticated) {
          if (!text.includes('\r\n')) return;
          if (!text.startsWith('+OK\r\n')) { socket.destroy(); reject(new Error('Synthetic Redis authentication failed')); return; }
          authenticated = true; text = text.slice(5);
        }
        if (text.length > 4096) { socket.destroy(); reject(new Error('Synthetic Redis reply limit')); return; }
        // Fixture commands use only simple strings, integers, null bulk replies and one short value.
        if (/^[+:-].*\r\n$/.test(text) || text === '$-1\r\n' || /^\$[0-9]+\r\n[^\r\n]*\r\n$/.test(text)) {
          socket.end(); resolve(text);
        }
      });
    });
  }
  async function startRedis() {
    if (redis && !redis.stopped) return;
    redis = await launchService('redis', redisBinary, [transport.redisConfig,
      '--dir', redisRoot, '--dbfilename', 'dump.rdb', '--appendonly', 'yes'], systemEnv);
    await wait(async () => await redisRequest(['PING']) === '+PONG\r\n', 'Redis', 15000, () => !redis.stopped);
  }
  const base = transport.backend.origin;
  async function http(url, options = {}) {
    return transport.backend.request(base + url, { signal: AbortSignal.timeout(5000), ...options });
  }
  async function startBackend(maintenanceId = '') {
    assert(!backend || backend.stopped, 'Backend fixture may not overlap prior process');
    await startRedis(); const bootstrap = gateway.bootstrap();
    try {
      backend = await launchService('backend', java, ['-Xmx512m', '-jar', jar, '--spring.profiles.active=desktop'], {
        ...systemEnv, SERVER_ADDRESS: '127.0.0.1', SERVER_PORT: String(ports.backend),
        DB_URL: transport.jdbcUrl, DB_USERNAME: 'codeintel', DB_PASSWORD: password,
        REDIS_HOST: '127.0.0.1', REDIS_PORT: String(ports.redis), REDIS_PASSWORD: transport.redisPassword,
        SPRING_CONFIG_ADDITIONAL_LOCATION: transport.backendConfigUrl, TOKEN_ENC_KEY: tokenKey, DATA_DIR: dataRoot,
        DESKTOP_API_TOKEN: apiToken, DESKTOP_PATH_TOKEN: pathToken, DESKTOP_LOCAL_IDENTITY: INSTALLATION,
        DESKTOP_ALLOWED_ORIGIN: base, CORS_ALLOWED_ORIGINS: base, APP_DESKTOP_AI_BOOTSTRAP_STDIN: 'true',
        APP_DESKTOP_MAINTENANCE_STARTUP_ID: maintenanceId,
      }, bootstrap);
    } finally { bootstrap.fill(0); }
    await wait(async () => {
      const response = await http('/actuator/health'); return response.ok;
    }, 'Spring backend', 90000, () => !backend.stopped);
    trace.push('backend.healthy');
  }
  async function maintenance(transactionId, operation) {
    const response = await http('/api/desktop/maintenance', { method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Code-Intelligence-Token': apiToken, 'X-Code-Intelligence-Path-Token': pathToken },
      body: JSON.stringify({ transactionId, operation }) });
    assert.equal(response.status, 200, 'Real maintenance HTTP failed'); const value = await response.json();
    assert.equal(value.transactionId, transactionId); return value;
  }
  function drained(value) {
    assert.equal(value.state, 'DRAINED');
    for (const field of ['activeRequests', 'activeWriters', 'activeJobs']) assert.equal(value[field], 0);
  }
  async function publicProjects() {
    const response = await http('/api/projects', { headers: { 'X-Code-Intelligence-Token': apiToken } });
    return response.status;
  }
  async function shutdown() {
    controls.closed = true; let unsafe = false;
    for (const object of [backend, redis]) try { await stop(object); } catch { unsafe = true; }
    for (const resource of [runtime, gateway, adapter, keyring]) try { await resource?.close(); } catch { unsafe = true; }
    for (const record of children) try { await stop(record); } catch { unsafe = true; }
    try { await ownerLocks?.close(); } catch { unsafe = true; }
    if (!unsafe) await transport.close();
    const events = { trace, plans, failures, controls, success, children: [...children].map(c => ({ name: c.name, code: c.code, signal: c.signal, stopped: c.stopped })) };
    await fs.writeFile(path.join(root, 'evidence.json'), JSON.stringify(events, null, 2), { mode: 0o600 });
    if (!success || unsafe || options.preserve) {
      let index = 0;
      for (const record of children) {
        await fs.writeFile(path.join(root, `${String(index++).padStart(3, '0')}-${record.name}.log`),
          Buffer.concat([...record.stdout, ...record.stderr]), { mode: 0o600 });
      }
      t.diagnostic(`Synthetic fixture retained for root inspection: ${root}`);
    } else await fs.rm(root, { recursive: true, force: true });
    for (const record of children) [...record.stdout, ...record.stderr].forEach(bytes => bytes.fill(0));
    assert(!unsafe, 'Fixture shutdown could not verify every owned process/resource close');
  }
  t.after(shutdown);

  if (!resume) {
    const pwfile = path.join(root, 'initdb-password'); await fs.writeFile(pwfile, password, { mode: 0o600 });
    try { await command('initdb', initdb, ['-D', pgData, '-U', 'codeintel', '--encoding=UTF8', '--no-locale',
      '--auth-local=reject', '--auth-host=scram-sha-256', `--pwfile=${pwfile}`], serverEnv, undefined, 60000); }
    finally { await fs.unlink(pwfile); }
  } else assert.match((await fs.readFile(path.join(pgData, 'PG_VERSION'), 'utf8')).trim(), /^[1-9][0-9]*(?:\.[0-9]+)?$/);
  postgres = await launchService('postgres', postgresBinary, ['-D', pgData, '-h', '127.0.0.1', '-p', String(ports.postgres),
    '-c', 'unix_socket_directories=', '-c', 'listen_addresses=127.0.0.1', '-c', 'max_connections=40',
    '-c', 'ssl=on', '-c', `ssl_cert_file=${transport.materials.postgres.cert}`,
    '-c', `ssl_key_file=${transport.materials.postgres.key}`, '-c', `hba_file=${transport.hba}`], serverEnv);
  await wait(async () => await sql('postgres', 'select 1;') === '1', 'PostgreSQL', 30000, () => !postgres.stopped);
  if (!resume) {
    const initialDb = `ci_backup_stage_${crypto.randomBytes(16).toString('hex')}`;
    await sql('postgres', `create database "${initialDb}" template template0 encoding 'UTF8';`);
    const bootstrapDb = await createBackupPostgres(pgOptions(initialDb, 'staging'));
    try { await bootstrapDb.initializeStaging(); } finally { await bootstrapDb.close(); }
    await sql('postgres', `alter database "${initialDb}" rename to codeintel;`);
    await sql('codeintel', `
      insert into users(id,github_id,login,local_key,identity_type) values(${OWNER},1234567,'synthetic-owner','${INSTALLATION}','LOCAL_LINKED');
      insert into projects(id,user_id,name,repo_owner,repo_name,default_branch,source_type,clone_path,local_path)
        select ${PROJECT},${OWNER},'synthetic legacy local','synthetic','fixture','main','LOCAL',v->>'clone',v->>'local'
        from(select ${jsonSql({ clone: path.join(repos, PROJECT), local: path.join(root, 'unapproved-original-folder') })} v) x;
      insert into snapshots(id,project_id,commit_sha,status,source_contract_version) values(${SNAPSHOT},${PROJECT},'${source.commit.oid}','READY',0);
      update projects set current_snapshot_id=${SNAPSHOT} where id=${PROJECT};
      insert into files(id,snapshot_id,path,language,size,line_count,content_hash)
        values(11,${SNAPSHOT},'index.ts','TYPESCRIPT',${source.blob.raw.length},1,'${source.blob.oid}');
      insert into branches(id,project_id,name,head_sha) values(13,${PROJECT},'main','${source.commit.oid}');
      insert into notes(id,project_id,title,content_md) select 3,${PROJECT},'synthetic note',v->>'note' from(select ${jsonSql({ note: ORIGINAL })} v) x;
      insert into user_ai_preferences(user_id,provider,model,connection_state,revision) values(${OWNER},'openai','fixture-model','OFF',7);
      select setval('users_id_seq',${OWNER}),setval('projects_id_seq',${PROJECT}),setval('notes_id_seq',3);`);
  }

  const safetyRoot = path.join(userData, 'safety');
  if (guardedServices) ownerLocks = await createNativeOwnerLocks({ javaPath: java, jarPath: jar, safetyRoot,
    installationId: INSTALLATION, assertMainOwnership: () => process.connected === true,
    onLost() {
      controls.ownerLost = true;
      return Promise.allSettled([stop(backend), stop(redis), stop(postgres)]);
    },
    spawnImpl(command, args, settings) {
      const child = spawn(command, args, settings); leaseChildren.add(child);
      options.onProcess?.({ name: 'native-lease', pid: child.pid, helperPid: null, guarded: false }); return child;
    },
  });
  async function openB(mode, initialize) {
    recoveryMode = mode;
    keyring = await (initialize ? initializePurposeKeyring : openPurposeKeyring)({ safetyRoot,
      restoreRoots: [dataRoot, pgData, path.join(userData, 'recovery')],
      installationId: INSTALLATION, wrapper: wrapper(), ...(ownerLocks ? { ownerLocks } : {}) });
    adapter = await createAiEgressPostgres({ psqlPath: psql, installationId: INSTALLATION, connection: connection('codeintel'), env: pgEnv });
    const verifier = createMaintenanceVerifier({ installationId: INSTALLATION, readProjection: adapter.readProjection });
    gateway = await openDesktopAiGateway({ installationId: INSTALLATION, runningBuild: BUILD, temporaryRoot,
      tokenEncryptionKey: tokenKey, freshEnrollmentAllowed: false, adapter, recoveryMode: mode,
      verifyMaintenanceSeal: verifier, verifyMaintenanceCompletion: verifier,
      async openJournal(callbacks) {
        journal = await (initialize ? initializeSafetyJournal : openSafetyJournal)({ safetyRoot,
          restoreRoots: [dataRoot, pgData, path.join(userData, 'recovery')],
          installationId: INSTALLATION, runningBuild: BUILD, keyProvider: keyring, ...callbacks,
          ...(ownerLocks ? { ownerLocks } : {}) });
        return journal;
      },
      async transport() { controls.providerCalls++; throw new Error('Provider transport is forbidden in the synthetic backup fixture'); },
    });
  }
  await openB(resume, !resume);
  if (!resume) await adapter.prepareMaintenanceGate({ ownerUserId: OWNER, legacyLiabilityUnresolved: false });
  async function addObligation(index, amount) {
    await sql('codeintel', `insert into ai_request_ledger(request_id,installation_id,plan_sha256,payload_sha256,wire_body_sha256,
      dispatch_binding,budget_day,price_version,reserved_micro_usd,status,liability_floor_micro_usd)
      values('${REQUESTS[index]}','${INSTALLATION}','${'0'.repeat(64)}','${sha(`synthetic obligation ${index}`)}',
      '${'0'.repeat(64)}','{}',current_date,'synthetic-not-a-production-price',${amount},'UNKNOWN_HELD',${amount});`);
  }
  if (!resume) await addObligation(0, 100);
  async function credentials(note, revision) {
    const v = jsonSql({ note, revision: String(revision), clone: path.join(repos, PROJECT), local: path.join(root, 'unapproved-original-folder') });
    await sql('codeintel', `
      update notes set content_md=(select v->>'note' from(select ${v} v) x) where id=3;
      insert into github_credentials(user_id,kind,encrypted_token,nonce,key_version)
        values(${OWNER},'PAT','public-synthetic-ciphertext',decode('${'11'.repeat(12)}','hex'),1)
        on conflict(user_id,kind) do update set encrypted_token=excluded.encrypted_token;
      insert into user_ai_settings(user_id,provider,model,encrypted_key,nonce,key_version)
        values(${OWNER},'openai','fixture-model','public-synthetic-ciphertext',decode('${'22'.repeat(12)}','hex'),1)
        on conflict(user_id) do update set encrypted_key=excluded.encrypted_key;
      update user_ai_preferences set provider='gemini',model='kept-preference-model',connection_state='ENABLED',revision=${revision} where user_id=${OWNER};
      update projects set clone_path=(select v->>'clone' from(select ${v} v) x),local_path=(select v->>'local' from(select ${v} v) x) where id=${PROJECT};
      insert into analysis_jobs(id,project_id,snapshot_id,type,status) values(21,${PROJECT},${SNAPSHOT},'IMPORT','FAILED') on conflict(id) do nothing;
      insert into job_local_source_inputs(job_id,project_id,approval_token_sha256,purpose,base_snapshot_id,schema_version,canonical_root,
        root_device,root_inode,policy_version,limits_sha256,manifest_sha256,selected_files,selected_bytes,approved_at)
        select 21,${PROJECT},'${'c'.repeat(64)}','REFRESH',${SNAPSHOT},1,v->>'local',1,2,'fixture-policy','${'a'.repeat(64)}','${'b'.repeat(64)}',1,1,now()
        from(select ${v} v) x on conflict(job_id) do nothing;
      insert into local_source_approvals(token_sha256,user_id,purpose,project_id,base_snapshot_id,schema_version,canonical_root,root_device,root_inode,
        policy_version,limits_sha256,manifest_sha256,selected_files,selected_bytes,issued_at,expires_at)
        select '${'d'.repeat(64)}',${OWNER},'REFRESH',${PROJECT},${SNAPSHOT},1,v->>'local',1,2,'fixture-policy','${'a'.repeat(64)}','${'b'.repeat(64)}',1,1,now(),now()+interval '10 minutes'
        from(select ${v} v) x on conflict(token_sha256) do nothing;`);
  }
  function guarded(name, operation) {
    return async (...args) => {
      trace.push(name);
      try { return await operation(...args); }
      catch (error) { failures.push({ operation: name, code: typeof error?.code === 'string' ? error.code : error?.name || 'Error' }); throw error; }
    };
  }
  const runtimePorts = {
    capacityRoots: async () => ({ postgres: pgData, source: dataRoot, bundle: path.join(userData, 'recovery') }),
    pause: guarded('pause', async ({ transactionId, waitForAiDrain, recovery = false }) => {
      if (recovery) assert(recoveryMode && (!backend || backend.stopped) && (!redis || redis.stopped), 'Recovery begins without product writers');
      if (backend && !backend.stopped) {
        await maintenance(transactionId, 'BEGIN');
        await wait(async () => { const status = await maintenance(transactionId, 'STATUS'); return status.state === 'DRAINED'
          && status.activeRequests === 0 && status.activeWriters === 0 && status.activeJobs === 0; }, 'writer drain');
      }
      await waitForAiDrain(); await stop(backend); trace.push('backend.stopped');
      assert(!backend || backend.stopped);
    }),
    prepareResume: guarded('prepareResume', async ({ transactionId, recovery = false }) => {
      assert.equal((journal.snapshot().pendingMaintenance || (recovery && journal.snapshot().maintenanceReceipt))?.transactionId,
        transactionId, 'Health requires the exact pending or already-completed B transaction');
      await startBackend(transactionId); drained(await maintenance(transactionId, 'STATUS'));
      assert.equal(await publicProjects(), 503, 'Public API must remain blocked during health verification');
      controls.verifiedHealth++; trace.push('health.verified');
      if (controls.failAfterHealth) throw new Error('Synthetic fault after real JAR health and before B completion');
    }),
    resume: guarded('resume', async ({ transactionId, recovery = false }) => {
      assert.equal(journal.snapshot().pendingMaintenance, null);
      assert.equal(journal.snapshot().maintenanceReceipt.transactionId, transactionId);
      if (recovery) {
        assert.equal(await publicProjects(), 503, 'A recovery handle never releases the HTTP barrier');
        await stop(backend); await stop(redis); trace.push('recovery.checked-services-stopped'); return;
      }
      drained(await maintenance(transactionId, 'END')); assert.equal(await publicProjects(), 200);
      controls.publicResumes++; trace.push('public.released');
    }),
    failure: guarded('failure', async () => { await stop(backend); await stop(redis); }),
    invalidateAuthority: guarded('invalidateAuthority', async ({ transactionId, checkpointRoot, recovery = false }) => {
      if (!recovery) await controls.afterStaged?.({ transactionId });
      assert.equal(checkpointRoot, path.join(userData, 'recovery', transactionId)); await stop(redis);
      await fs.rename(redisRoot, path.join(checkpointRoot, recovery ? `recovery-sessions-${crypto.randomUUID()}` : 'previous-redis'));
      await privateDir(redisRoot);
      apiToken = crypto.randomBytes(32).toString('hex'); pathToken = crypto.randomBytes(32).toString('hex'); controls.invalidations++;
    }),
    openExport: guarded('openExport', () => createBackupPostgres(pgOptions('codeintel', 'export'))),
    openStage: guarded('openStage', database => createBackupPostgres(pgOptions(database, 'staging'))),
    sourceWorker: guarded('sourceWorker', async () => {
      const worker = await createBackupSourceWorker({ javaPath: java, jarPath: jar, env: systemEnv });
      return Object.freeze({
        exportProject: guarded('source.export', async value => { controls.workerExports++; return worker.exportProject(value); }),
        restoreProject: guarded('source.import', async value => { controls.workerImports++; return worker.restoreProject(value); }),
        close: () => worker.close(),
      });
    }),
    database: guarded('database', async (options = {}) => {
      const control = await createBackupDatabaseControl({ psqlPath: psql,
        connection: { host: '127.0.0.1', port: ports.postgres, user: 'codeintel' }, env: pgEnv, liveDatabase: 'codeintel',
        ...(options.readRetentionAuthority ? { readRetentionAuthority: options.readRetentionAuthority } : {}) });
      return Object.freeze({ ...control,
        createStage: guarded('database.createStage', async value => { const plan = await control.createStage(value); plans.push(plan); return plan; }),
        swap: guarded('database.swap', control.swap), rollback: guarded('database.rollback', control.rollback),
      });
    }),
    productState: guarded('productState', async () => {
      const product = await createBackupProductState({ psqlPath: psql,
        connection: { host: '127.0.0.1', port: ports.postgres, user: 'codeintel' }, env: pgEnv,
        expectedDataDirectory: pgData, ownedPostgres: postgres.child, dataRoot });
      return Object.freeze({ ...product,
        rebindClonePaths: guarded('product.paths', product.rebindClonePaths),
        revokeCredentials: guarded('product.revoke', product.revokeCredentials),
      });
    }),
    async exportVault() { assert.fail('This fixture contains legacy Git snapshots only; retained-vault coverage is separate'); },
    async restoreVault() { assert.fail('Unexpected retained-vault import'); },
  };
  // Observe failures at the real authority boundaries without replacing their behavior.
  const runtimeJournal = Object.freeze({
    snapshot: () => journal.snapshot(),
    sealMaintenance: guarded('journal.seal', value => journal.sealMaintenance(value)),
    completeMaintenance: guarded('journal.complete', async value => {
      const result = await journal.completeMaintenance(value); await controls.afterComplete?.(value); return result;
    }),
  });
  const runtimeGateway = Object.freeze({
    beginMaintenance: guarded('gateway.begin', async value => {
      const handle = await gateway.beginMaintenance(value);
      return Object.freeze(Object.fromEntries(Object.entries(handle)
        .map(([name, operation]) => [name, guarded(`handle.${name}`, operation)])));
    }),
  });
  async function openRuntime(mode) {
    runtime = await createDesktopBackupRuntime({ userData, installationId: INSTALLATION, runningBuild: BUILD, recoveryMode: mode,
      keyProvider: Object.freeze({
        currentKeyId(purpose) {
          assert.equal(purpose, 'backup');
          return keyring.currentKeyId('backup');
        },
        getBackupKey: id => keyring.getBackupKey(id),
      }), journal: runtimeJournal, gateway: runtimeGateway, adapter, ports: runtimePorts });
  }
  await openRuntime(resume);
  if (!resume) { await startBackend(); assert.equal(await publicProjects(), 200); }
  async function product() {
    return sqlJson(`select jsonb_build_object('owner',(select id::text from users where local_key='${INSTALLATION}'),
      'identity',(select identity_type from users where local_key='${INSTALLATION}'),
      'note',(select content_md from notes where id=3),'github',(select count(*)::text from github_credentials),
      'ai',(select count(*)::text from user_ai_settings),'approvals',(select count(*)::text from local_source_approvals),
      'inputs',(select count(*)::text from job_local_source_inputs),
      'state',(select connection_state from user_ai_preferences where user_id=${OWNER}),
      'revision',(select revision::text from user_ai_preferences where user_id=${OWNER}),
      'provider',(select provider from user_ai_preferences where user_id=${OWNER}),
      'model',(select model from user_ai_preferences where user_id=${OWNER}),
      'clone',(select clone_path from projects where id=${PROJECT}),'local',(select local_path from projects where id=${PROJECT}),
      'contract',(select source_contract_version from snapshots where id=${SNAPSHOT}));`);
  }
  return { root, userData, dataRoot, repos, destination, source, controls, trace, plans,
    get runtime() { return runtime; }, get gateway() { return gateway; }, get adapter() { return adapter; },
    get keyring() { return keyring; }, get journal() { return journal; },
    sql, sqlJson, product, credentials, addObligation, redisRequest, publicProjects,
    async reopenNormal() {
      assert(recoveryMode && (!backend || backend.stopped) && (!redis || redis.stopped));
      for (const resource of [runtime, gateway, adapter, keyring]) await resource.close();
      await openB(false, false); await openRuntime(false); await startBackend(); assert.equal(await publicProjects(), 200);
    },
    processEvidence() {
      return { services: [...children].filter(record => record.guarded).map(record => ({ name: record.name,
        pid: record.child.pid, helperPid: record.child.helperPid, stopped: record.stopped })),
      leases: [...leaseChildren].map(child => ({ pid: child.pid, stopped: child.exitCode !== null || child.signalCode !== null })) };
    },
    async artifact() { const bytes = gateway.bootstrap(); try { return sha(bytes); } finally { bytes.fill(0); } },
    logPath: path.join(safetyRoot, 'ai-journal', 'events.log'),
    async inode(file) { const stat = await fs.lstat(file, { bigint: true }); return `${stat.dev}:${stat.ino}`; },
    async checkSource() {
      const worker = await createBackupSourceWorker({ javaPath: java, jarPath: jar, env: systemEnv }); const observed = [];
      try { await worker.exportProject({ reposRoot: repos, projectId: PROJECT,
        selection: { snapshots: [{ snapshotId: SNAPSHOT, commitOid: source.commit.oid,
          files: [{ path: 'index.ts', gitOid: source.blob.oid, byteSize: source.blob.raw.length }] }],
        commits: [], branches: [{ name: 'main', headOid: source.commit.oid }], headOid: source.commit.oid },
        writeRecord: item => { if (item.kind === 'OBJECT') observed.push(item); } }); }
      finally { await worker.close(); }
      assert.equal(observed.find(item => item.gitOid === source.blob.oid)?.bytesBase64, source.blob.raw.toString('base64'));
    },
    markSuccess() { success = true; },
  };
}

module.exports = Object.freeze({ fixture, INSTALLATION, BUILD, OWNER, PROJECT, SNAPSHOT, REQUESTS, ORIGINAL, sha });

if (require.main === module) test('opt-in owned-local PostgreSQL backup runtime: real restore and rollback', { skip: !ENABLED, timeout: 480000 }, async t => {
  const f = await fixture(t); let archive, roundTripPassed = false;
  await t.test('encrypted backup restores old product data, preserves newer B obligations and resumes only after real maintenance health', { timeout: 240000 }, async () => {
    const keyBefore = await f.keyring.info(), before = f.journal.snapshot();
    const logPrefix = await fs.readFile(f.logPath), oldRepoInode = await f.inode(f.repos);
    archive = await f.runtime.backup(f.destination);
    assert(path.isAbsolute(archive) && archive.startsWith(f.destination + path.sep));
    assert.equal((await fs.stat(archive)).mode & 0o777, 0o600);
    assert.equal(f.journal.snapshot().pendingMaintenance, null); assert(f.journal.snapshot().sequence > before.sequence);
    assert.equal((await f.product()).note, ORIGINAL);
    await f.credentials('Synthetic mutated note B', 19); await f.addObligation(1, 73);
    const marker = path.join(f.repos, 'changed-after-backup'); await fs.writeFile(marker, 'synthetic source tree mutation', { mode: 0o600 });
    assert.equal(await f.redisRequest(['SET', 'synthetic-session-before-restore', 'present']), '+OK\r\n');
    const channelBefore = await f.artifact(), sequenceBefore = f.journal.snapshot().sequence;
    const result = await f.runtime.restore(archive); assert.equal(result.restored, true);
    assert((await fs.stat(result.recoveryBackup)).isFile());
    const data = await f.product();
    assert.equal(data.owner, OWNER); assert.equal(data.identity, 'LOCAL_LINKED'); assert.equal(data.note, ORIGINAL);
    for (const field of ['github', 'ai', 'approvals', 'inputs']) assert.equal(data[field], '0');
    assert.equal(data.state, 'OFF'); assert(BigInt(data.revision) > 19n);
    assert.equal(data.provider, 'openai'); assert.equal(data.model, 'fixture-model');
    assert.equal(data.local, null); assert.equal(data.clone, path.join(f.repos, PROJECT)); assert.equal(data.contract, 0);
    assert.notEqual(await f.inode(f.repos), oldRepoInode); await assert.rejects(fs.lstat(marker), { code: 'ENOENT' });
    await f.checkSource(); assert.equal(await f.redisRequest(['GET', 'synthetic-session-before-restore']), '$-1\r\n');
    assert.notEqual(await f.artifact(), channelBefore, 'Private backend channel must rotate');
    const snapshot = f.journal.snapshot(), projection = await f.adapter.readProjection();
    assert(snapshot.sequence > sequenceBefore); assert.equal(snapshot.aiOff, true); assert.equal(snapshot.pendingMaintenance, null);
    assert.deepEqual(snapshot.requests.map(row => row.requestId).sort(), REQUESTS.slice(0, 2));
    assert.equal(snapshot.totalLiabilityMicroUsd, '173');
    assert.equal(projection.gate.journalSequence, String(snapshot.sequence)); assert.equal(projection.gate.journalHash, snapshot.headHash);
    assert.deepEqual(projection.requests.map(row => row.requestId).sort(), REQUESTS.slice(0, 2));
    assert.deepEqual(await f.keyring.info(), keyBefore, 'Restorable data must never replace B purpose keys');
    assert((await fs.readFile(f.logPath)).subarray(0, logPrefix.length).equals(logPrefix), 'B must remain append-only');
    const plan = f.plans[0], previous = `ci_backup_previous_${plan.transactionId.replaceAll('-', '')}`;
    const previousDb = await f.sqlJson(`select jsonb_build_object('oid',oid::text,'allowed',datallowconn) from pg_database where datname='${previous}';`, 'postgres');
    assert.equal(previousDb.oid, plan.liveOid); assert.equal(previousDb.allowed, false);
    assert.equal(await f.inode(path.join(f.userData, 'recovery', plan.transactionId, 'previous-repos')), oldRepoInode);
    assert.equal(f.controls.providerCalls, 0); assert(f.controls.workerExports >= 2); assert(f.controls.workerImports >= 1);
    assert.equal(f.controls.publicResumes, 2); assert.equal(f.controls.verifiedHealth, 2); assert.equal(f.controls.invalidations, 1);
    roundTripPassed = true;
  });
  let rollbackPassed = false;
  await t.test('failure after actual restored JAR health rolls back A while retaining credentials OFF and the unresolved B seal', { timeout: 240000 }, async () => {
    assert(roundTripPassed && archive, 'Successful roundtrip is a prerequisite for the sequential rollback test');
    await f.credentials('Synthetic pre-rollback note C', 31); await f.addObligation(2, 29);
    const original = await f.sqlJson("select jsonb_build_object('oid',oid::text) from pg_database where datname='codeintel';", 'postgres');
    const repoInode = await f.inode(f.repos), sequence = f.journal.snapshot().sequence;
    const logPrefix = await fs.readFile(f.logPath), resumes = f.controls.publicResumes;
    f.controls.failAfterHealth = true;
    await assert.rejects(f.runtime.restore(archive), error => error.code === 'BACKUP_RUNTIME_RECOVERY_REQUIRED' && error.recoveryRequired === true);
    const data = await f.product(); assert.equal(data.note, 'Synthetic pre-rollback note C');
    for (const field of ['github', 'ai', 'approvals', 'inputs']) assert.equal(data[field], '0');
    assert.equal(data.state, 'OFF'); assert.equal(data.revision, '32');
    assert.equal(data.provider, 'gemini'); assert.equal(data.model, 'kept-preference-model');
    assert.equal(await f.inode(f.repos), repoInode);
    const db = await f.sqlJson("select jsonb_build_object('oid',oid::text) from pg_database where datname='codeintel';", 'postgres');
    assert.equal(db.oid, original.oid);
    const plan = f.plans[1], failed = `ci_backup_failed_${plan.transactionId.replaceAll('-', '')}`;
    const failedDb = await f.sqlJson(`select jsonb_build_object('oid',oid::text,'allowed',datallowconn) from pg_database where datname='${failed}';`, 'postgres');
    assert.equal(failedDb.oid, plan.stageOid); assert.equal(failedDb.allowed, false);
    const snapshot = f.journal.snapshot(), pg = await f.adapter.readProjection();
    assert(snapshot.sequence > sequence); assert.equal(snapshot.aiOff, true); assert.equal(snapshot.pendingMaintenance.transactionId, plan.transactionId);
    assert.deepEqual(snapshot.requests.map(row => row.requestId).sort(), REQUESTS); assert.equal(snapshot.totalLiabilityMicroUsd, '202');
    assert.equal(pg.gate.journalSequence, String(snapshot.sequence)); assert.equal(pg.gate.reconciliationRequired, true);
    assert.deepEqual(pg.requests.map(row => row.requestId).sort(), REQUESTS);
    assert((await fs.readFile(f.logPath)).subarray(0, logPrefix.length).equals(logPrefix));
    assert.equal(f.controls.publicResumes, resumes, 'Faulted restore must never publish the application');
    assert.equal(f.controls.providerCalls, 0); assert.equal(f.controls.verifiedHealth, 3);
    assert(f.trace.includes('database.rollback')); assert(f.trace.lastIndexOf('failure') < f.trace.lastIndexOf('database.rollback'));
    await assert.rejects(f.runtime.backup(f.destination), error => error.code === 'BACKUP_RUNTIME_RECOVERY_REQUIRED');
    rollbackPassed = true;
  });
  if (roundTripPassed && rollbackPassed) f.markSuccess();
});
