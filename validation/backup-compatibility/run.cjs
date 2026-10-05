'use strict';

// Opt-in, synthetic-only integration proof. Never starts or edits the supplied runtime.
// Each invocation owns a new directory, runtime copy, TLS material and PostgreSQL child.
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const net = require('node:net');
const { spawn, spawnSync } = require('node:child_process');
const { once } = require('node:events');

const REPO = path.resolve(__dirname, '../..');
const PG = require('../../desktop/src/backup-postgres.cjs');
const PAYLOAD = require('../../desktop/src/backup-payload.cjs');
const { createBackupDatabaseControl } = require('../../desktop/src/backup-database.cjs');
const { createDesktopBackupRuntime, BackupRuntimeError } = require('../../desktop/src/backup-runtime.cjs');
const { encryptFile } = require('../../desktop/src/backup-archive.cjs');
const { REVIEWED_SCHEMA, REVIEWED_V26_SCHEMA } = require('../../desktop/src/backup-export-policy.cjs');
const MIGRATIONS = path.join(REPO, 'backend/src/main/resources/db/migration');
const INSTALLATION = '11111111-2222-4333-8444-555555555555';
const LEGACY_COMMIT = '4d8946c7b18b1cdee4f6f86b1e30fc9d469d923f';
const OLD_VECTOR = Object.freeze({
  version: '0.8.1', commit: '778dacf20c07caf904557a88705142631818d8cb',
  // Observed SHA-256 of the official immutable source files, not maintainer signatures.
  sqlSha256: '7fb5bb279ef83bf9204bfac7405bb5c9a05e49f5ac7d64d1eb4464d103b80f32',
  controlSha256: 'a0205f50f78f48402e3b5ff707a5225dd684360156ba6a591f02e9afa6a47120',
});
const SYSTEM_ENV = { PATH: '/usr/bin:/bin:/usr/sbin:/sbin', LC_ALL: 'C', LANG: 'C', TZ: 'UTC' };
const sha = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const canonical = value => Array.isArray(value) ? `[${value.map(canonical).join(',')}]`
  : value && typeof value === 'object'
    ? `{${Object.keys(value).sort().map(k => `${JSON.stringify(k)}:${canonical(value[k])}`).join(',')}}` : JSON.stringify(value);
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const inside = (parent, child) => child.startsWith(parent + path.sep);

async function treeHash(root) {
  const hash = crypto.createHash('sha256');
  async function walk(directory) {
    for (const name of (await fs.readdir(directory)).sort()) {
      const file = path.join(directory, name), stat = await fs.lstat(file);
      hash.update(`${path.relative(root, file)}\0${stat.mode}\0`);
      if (stat.isSymbolicLink()) {
        assert(inside(root, await fs.realpath(file)), 'Runtime links must remain inside the supplied prefix');
        hash.update(`link:${await fs.readlink(file)}\0`);
      } else if (stat.isDirectory()) await walk(file);
      else { assert(stat.isFile(), 'Runtime contains an unsupported filesystem entry'); hash.update(await fs.readFile(file)); }
    }
  }
  await walk(root); return hash.digest('hex');
}

async function main(argv) {
  assert.equal(process.platform, 'darwin', 'This fixture covers the macOS runtime only');
  assert.deepEqual(argv.slice(0, 1), ['--postgres-prefix']);
  assert.equal(argv.length, 2, 'Usage: node run.cjs --postgres-prefix <preserved source prefix/postgres>');
  const originalPrefix = await fs.realpath(argv[1]);
  assert.equal(path.basename(originalPrefix), 'postgres');
  assert.equal(path.basename(path.dirname(originalPrefix)), 'prefix');
  assert.equal((await fs.lstat(originalPrefix)).uid, process.getuid());
  // No existing database, application profile or packaged .app is an input.
  assert(!originalPrefix.includes('.app/') && !originalPrefix.includes('/Application Support/'));
  await assert.rejects(fs.lstat(path.join(originalPrefix, 'PG_VERSION')), { code: 'ENOENT' });
  for (const name of ['postgres', 'psql', 'initdb', 'pg_config']) {
    assert((await fs.lstat(path.join(originalPrefix, 'bin', name))).isFile());
  }
  const local = path.join(REPO, 'validation/local'); await fs.mkdir(local, { recursive: true, mode: 0o700 });
  const reportRoot = await fs.realpath(await fs.mkdtemp(path.join(local, 'backup-compatibility-')));
  const fixture = path.join(reportRoot, 'fixture'); await fs.mkdir(fixture, { mode: 0o700 });
  const reportFile = path.join(reportRoot, 'report.json');
  const report = { format: 1, startedAt: new Date().toISOString(), status: 'RUNNING',
    model: 'pgvector 0.8.7 binary with historical 0.8.1 SQL definitions before explicit ALTER EXTENSION UPDATE',
    limitations: ['No old pgvector binary executed', 'No existing profile or database opened',
      'No historical on-disk index or physical cluster upgrade proven', 'No packaged Keychain or application restore flow exercised',
      'C/libc UTF8 baseline; a non-C result applies only to the recorded synthetic dataset', 'ICU and original user locales are unverified',
      'Coordinator refusal uses real encrypted archive, filesystem and PostgreSQL ports but mocked B journal/gateway',
      'Synthetic cost tables are empty; no real cost-ledger replay or successful coordinator restore is proven'],
    originalPrefix, reportRoot, checks: [], child: null, upstream: OLD_VECTOR };
  async function save() {
    await fs.writeFile(reportFile + '.next', JSON.stringify(report, null, 2) + '\n', { mode: 0o600 });
    await fs.rename(reportFile + '.next', reportFile);
  }
  async function check(name, task) {
    const result = { name, startedAt: new Date().toISOString(), status: 'RUNNING' };
    report.checks.push(result); await save();
    console.log(JSON.stringify({ check: name, status: 'RUNNING' }));
    try { result.evidence = await task(); result.status = result.evidence?.notRun ? 'SKIP' : 'PASS'; }
    catch (error) { result.status = 'FAIL'; result.code = error.code || error.name;
      result.message = String(error.message).slice(0, 1200); throw error; }
    finally { result.finishedAt = new Date().toISOString(); await save();
      console.log(JSON.stringify({ check: name, status: result.status, code: result.code })); }
  }
  let commandIndex = 0;
  async function command(label, binary, args, { input, env = SYSTEM_ENV, timeout = 30000, allowFailure = false } = {}) {
    const result = spawnSync(binary, args, { cwd: fixture, env, input, encoding: 'utf8', timeout, maxBuffer: 8 * 1024 * 1024 });
    const file = `${String(++commandIndex).padStart(3, '0')}-${label}.log`;
    // Only this runner's synthetic processes are captured. Never log argv/env/input or credentials.
    await fs.writeFile(path.join(fixture, file), `${result.stdout || ''}\n${result.stderr || ''}`, { mode: 0o600 });
    if (!allowFailure) assert.equal(result.status, 0, `Fixture command failed: ${label}; inspect fixture/${file}`);
    return result;
  }
  async function download(relative, url, expectedHash) {
    const destination = path.join(fixture, 'upstream', relative);
    await command('download-source', '/usr/bin/curl', ['--disable', '--fail', '--silent', '--show-error', '--location',
      '--proto', '=https', '--proto-redir', '=https', '--connect-timeout', '5', '--max-time', '20',
      '--max-filesize', '131072', '--output', destination, url]);
    await fs.chmod(destination, 0o600);
    const bytes = await fs.readFile(destination); assert(bytes.length > 0 && bytes.length <= 131072);
    if (expectedHash) assert.equal(sha(bytes), expectedHash, 'Official immutable source checksum mismatch');
    return bytes;
  }
  let child, childExit, pgStderr = '', originalHash, copiedPrefix, copiedVector, vectorHash;
  const adapters = new Set(); let databaseNumber = 0;
  await save(); console.log(JSON.stringify({ report: reportFile }));
  try {
    await check('copy-runtime-and-verify-upstream', async () => {
      originalHash = await treeHash(originalPrefix);
      copiedPrefix = path.join(fixture, 'postgres-runtime');
      await fs.cp(originalPrefix, copiedPrefix, { recursive: true, dereference: true, force: false, errorOnExist: true });
      const originalVector = path.join(originalPrefix, 'lib/vector.dylib');
      copiedVector = path.join(copiedPrefix, 'lib/vector.dylib');
      vectorHash = sha(await fs.readFile(originalVector)); assert.equal(sha(await fs.readFile(copiedVector)), vectorHash);
      await fs.mkdir(path.join(fixture, 'upstream'), { mode: 0o700 });
      const tag = JSON.parse(await download('v0.8.1-tag.json', 'https://api.github.com/repos/pgvector/pgvector/git/ref/tags/v0.8.1'));
      assert.equal(tag.object.type, 'commit'); assert.equal(tag.object.sha, OLD_VECTOR.commit);
      const base = `https://raw.githubusercontent.com/pgvector/pgvector/${OLD_VECTOR.commit}/`;
      await download('vector--0.8.1.sql', base + 'sql/vector.sql', OLD_VECTOR.sqlSha256);
      await download('vector-0.8.1.control', base + 'vector.control', OLD_VECTOR.controlSha256);
      return { originalTreeSha256: originalHash, vectorBinarySha256: vectorHash, sqlSha256: OLD_VECTOR.sqlSha256,
        controlSha256: OLD_VECTOR.controlSha256, tagCommit: tag.object.sha };
    });
    const bin = path.join(copiedPrefix, 'bin'), psql = path.join(bin, 'psql');
    const nativeEnv = { ...SYSTEM_ENV, DYLD_LIBRARY_PATH: path.join(copiedPrefix, 'lib') };
    const pgConfig = async flag => (await command('pg-config', path.join(bin, 'pg_config'), [flag], { env: nativeEnv })).stdout.trim();
    const share = await pgConfig('--sharedir'); assert(inside(copiedPrefix, share), 'pg_config must resolve the copied share directory');
    const control = path.join(share, 'extension/vector.control');
    const currentControl = await fs.readFile(control); assert.match(currentControl.toString(), /default_version\s*=\s*'0\.8\.7'/);
    const currentInstall = path.join(share, 'extension/vector--0.8.7.sql'); assert((await fs.stat(currentInstall)).isFile());
    const certificate = path.join(fixture, 'server.crt'), privateKey = path.join(fixture, 'server.key');
    const pgData = path.join(fixture, 'pg-data'), passwordFile = path.join(fixture, 'initdb-password');
    const password = `synthetic-${crypto.randomBytes(24).toString('hex')}`;
    const tlsConfig = path.join(fixture, 'openssl.cnf');
    await fs.writeFile(tlsConfig, '[req]\nprompt=no\ndistinguished_name=dn\nx509_extensions=v3\n[dn]\nCN=127.0.0.1\n[v3]\nsubjectAltName=IP:127.0.0.1\nbasicConstraints=critical,CA:TRUE\nkeyUsage=critical,digitalSignature,keyEncipherment,keyCertSign\n', { mode: 0o600 });
    await command('synthetic-tls', '/usr/bin/openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1',
      '-config', tlsConfig, '-keyout', privateKey, '-out', certificate]); await fs.chmod(privateKey, 0o600);
    await fs.writeFile(passwordFile, password, { mode: 0o600 });
    try { await command('initdb', path.join(bin, 'initdb'), ['-D', pgData, '-U', 'backup_fixture', '--encoding=UTF8', '--no-locale',
      '--auth-local=reject', '--auth-host=scram-sha-256', `--pwfile=${passwordFile}`], { env: nativeEnv, timeout: 60000 }); }
    finally { await fs.unlink(passwordFile); }
    const hba = path.join(fixture, 'pg_hba.conf');
    await fs.writeFile(hba, 'local all all reject\nhostnossl all all 127.0.0.1/32 reject\nhostssl all backup_fixture 127.0.0.1/32 scram-sha-256\n', { mode: 0o600 });
    const reservation = net.createServer(); reservation.listen(0, '127.0.0.1'); await once(reservation, 'listening');
    const port = reservation.address().port; await new Promise(resolve => reservation.close(resolve));
    child = spawn(path.join(bin, 'postgres'), ['-D', pgData, '-h', '127.0.0.1', '-p', String(port), '-k', '',
      '-c', 'ssl=on', '-c', `ssl_cert_file=${certificate}`, '-c', `ssl_key_file=${privateKey}`, '-c', `hba_file=${hba}`],
    { cwd: fixture, env: nativeEnv, stdio: ['ignore', 'ignore', 'pipe'] });
    child.stderr.on('data', bytes => { if (pgStderr.length < 512 * 1024) pgStderr += bytes.toString(); });
    childExit = new Promise(resolve => { child.once('exit', (code, signal) => resolve({ code, signal }));
      child.once('error', error => resolve({ code: null, signal: null, error: error.code || error.name })); });
    report.child = { pid: child.pid, port, stopped: false }; await save();
    const pgEnv = { PGPASSWORD: password, PGSSLMODE: 'verify-full', PGSSLROOTCERT: certificate, DYLD_LIBRARY_PATH: nativeEnv.DYLD_LIBRARY_PATH };
    // Explicit synthetic client material avoids libpq's default ~/.postgresql key lookup.
    // This is a real child spawn, not a database test double or a staging-guard bypass.
    const clientTls = { PGSSLCERT: certificate, PGSSLKEY: privateKey };
    const fixtureSpawn = (file, childArgs, childOptions) => spawn(file, childArgs,
      { ...childOptions, env: { ...childOptions.env, ...clientTls } });
    const connection = database => ({ host: '127.0.0.1', port, user: 'backup_fixture', database });
    const args = database => ['-X', '--no-password', '--quiet', '--tuples-only', '--no-align', '--set=ON_ERROR_STOP=1',
      '--host=127.0.0.1', `--port=${port}`, '--username=backup_fixture', `--dbname=${database}`, '--file=-'];
    async function sql(database, text) {
      assert(database === 'postgres' || /^ci_backup_(?:stage|live)_[a-f0-9]{16,32}$/.test(database));
      return (await command('fixture-sql', psql, args(database), { input: text, env: { ...SYSTEM_ENV, ...pgEnv, ...clientTls } })).stdout.trim();
    }
    await check('owned-postgres-tls-and-locale', async () => {
      let ready = false;
      for (let i = 0; i < 80; i++) {
        assert.equal(child.exitCode, null, 'Owned PostgreSQL exited during startup');
        const probe = spawnSync(psql, args('postgres'), { input: 'select 1;', env: { ...SYSTEM_ENV, ...pgEnv, ...clientTls }, encoding: 'utf8', timeout: 1000 });
        if (probe.status === 0) { ready = true; break; } await delay(100);
      }
      assert(ready, 'Owned PostgreSQL did not become ready');
      assert.equal(await sql('postgres', 'show data_directory;'), pgData);
      assert.equal(Number((await fs.readFile(path.join(pgData, 'postmaster.pid'), 'utf8')).split('\n')[0]), child.pid);
      const facts = JSON.parse(await sql('postgres', `select jsonb_build_object('version',current_setting('server_version'),
        'encoding',pg_encoding_to_char(encoding),'provider',datlocprovider,'collate',datcollate,'ctype',datctype,
        'ssl',(select ssl from pg_stat_ssl where pid=pg_backend_pid())) from pg_database where datname=current_database();`));
      assert.match(facts.version, /^16\./); assert.equal(facts.ssl, true); assert.equal(facts.collate, 'C');
      assert.equal(facts.ctype, 'C'); assert.equal(facts.provider, 'c'); assert.equal(facts.encoding, 'UTF8');
      return { ...facts, clientTlsExplicitSynthetic: true };
    });
    const options = (database, migrationRoot = MIGRATIONS, mode = 'staging') => ({ psqlPath: psql, migrationRoot,
      installationId: INSTALLATION, mode, connection: connection(database), env: pgEnv, spawn: fixtureSpawn });
    async function databaseFacts(database) {
      return JSON.parse(await sql(database, `select jsonb_build_object('database',datname,'encoding',pg_encoding_to_char(encoding),
        'provider',datlocprovider,'collate',datcollate,'ctype',datctype,'collationVersion',datcollversion,
        'vector',(select extversion from pg_extension where extname='vector')) from pg_database where datname=current_database();`));
    }
    async function emptyDatabase(locale) {
      const database = `ci_backup_stage_${(++databaseNumber).toString(16).padStart(16, '0')}`;
      if (locale) assert(['en_US.UTF-8', 'en_US.utf8'].includes(locale));
      await sql('postgres', `create database ${database} template template0 encoding 'UTF8'${locale ? ` locale_provider libc lc_collate '${locale}' lc_ctype '${locale}'` : ''};`);
      return database;
    }
    async function initialized(module = PG, migrations = MIGRATIONS, locale) {
      const database = await emptyDatabase(locale);
      const adapter = await module.createBackupPostgres(options(database, migrations)); adapters.add(adapter);
      await adapter.initializeStaging(); return { database, adapter };
    }
    async function vectorVersion(database) { return sql(database, "select extversion from pg_extension where extname='vector';"); }
    const vector = `[${[1, ...Array(1535).fill(0)].join(',')}]`;
    async function seed(database) {
      await sql(database, `insert into users(id,login,local_key,identity_type) values(1,'fixture','${INSTALLATION}','LOCAL');
        insert into projects(id,user_id,name,repo_owner,repo_name) values(2,1,'fixture','fixture','fixture');
        insert into snapshots(id,project_id,commit_sha,status) values(3,2,'${'a'.repeat(40)}','READY');
        insert into files(id,snapshot_id,path,language,size,line_count,content_hash) values(4,3,'src/main.ts','typescript',12,1,'${'a'.repeat(64)}');
        insert into notes(id,project_id,title,content_md) values(5,2,'synthetic preserved note','preserved');
        insert into summaries(id,snapshot_id,subject_type,subject_id,level,content,embedding)
          values(6,3,'FILE',4,'SHORT','synthetic vector summary','${vector}');`);
      assert.equal(await sql(database, 'select vector_dims(embedding)::text||\':\'||(embedding <=> embedding)::text from summaries;'), '1536:0');
    }
    async function rawRowsHash(database, schema = REVIEWED_SCHEMA) {
      const entries = schema.tables.map(({ name }) => `('${name}',(select coalesce(jsonb_agg(to_jsonb(t) order by to_jsonb(t)::text),'[]'::jsonb) from public."${name}" t))`);
      return sha(canonical(JSON.parse(await sql(database, `select jsonb_object_agg(name,rows) from (values ${entries.join(',')}) t(name,rows);`))));
    }
    async function exportPayload(label, source, module = PG, migrations = MIGRATIONS, payloadModule = PAYLOAD) {
      const exporter = await module.createBackupPostgres(options(source.database, migrations, 'export')); adapters.add(exporter);
      const rows = [], summary = await exporter.exportRows({ writeRow: row => rows.push(row) });
      const root = path.join(fixture, label); await fs.mkdir(root, { mode: 0o700 });
      const writer = await payloadModule.createBackupPayload({ root, installationId: INSTALLATION, minimumVersion: '20261003' });
      try { for (const row of rows) await writer.writeRow(row); await writer.writeDatabase(summary); await writer.finish(); }
      finally { await writer.close(); await exporter.close(); adapters.delete(exporter); }
      const file = path.join(root, 'payload.bin'), fileSha256 = sha(await fs.readFile(file));
      const decodedRows = []; let decodedSummary;
      for await (const record of PAYLOAD.readBackupPayload({ root, installationId: INSTALLATION, runningBuild: '20261005' })) {
        if (record.kind === 'ROW') decodedRows.push(record.row); if (record.kind === 'DATABASE') decodedSummary = record.summary;
      }
      assert.deepEqual(decodedRows, rows); assert.deepEqual(decodedSummary, summary);
      return { rows: decodedRows, summary: decodedSummary, file, fileSha256 };
    }
    async function load(target, archive, rows = archive.rows, writeAccounting = async () => {}) {
      return target.adapter.loadRows({ rows, expected: archive.summary, liveOwnerUserId: '1',
        livePreferenceRevisionHighWater: {}, writeAccounting });
    }
    async function unchangedArchive(archive) { assert.equal(sha(await fs.readFile(archive.file)), archive.fileSha256); }
    async function catalogDatabases() {
      return JSON.parse(await sql('postgres', `select jsonb_agg(jsonb_build_object('name',datname,'oid',oid::text,
        'owner',pg_get_userbyid(datdba),'allowConnections',datallowconn) order by datname) from pg_database;`));
    }
    async function databaseControl(liveDatabase) {
      const controller = await createBackupDatabaseControl({ psqlPath: psql,
        connection: { host: '127.0.0.1', port, user: 'backup_fixture' }, liveDatabase, env: pgEnv, spawn: fixtureSpawn });
      adapters.add(controller); return controller;
    }
    async function closeAdapter(adapter) { await adapter.close(); adapters.delete(adapter); }
    async function rejected(archive) {
      const target = await initialized(), before = await rawRowsHash(target.database); let iterated = false, accounting = 0;
      const rows = { [Symbol.asyncIterator]() { iterated = true; throw new Error('Rejected archive iterator must not start'); } };
      await assert.rejects(load(target, archive, rows, async () => { accounting++; }), error => error.code === 'BACKUP_PG_SCHEMA');
      assert.equal(iterated, false); assert.equal(accounting, 0); assert.equal(await rawRowsHash(target.database), before);
      await unchangedArchive(archive); return { code: 'BACKUP_PG_SCHEMA', loadIteratorStarted: iterated,
        accountingWrites: accounting, targetRowsUnchanged: true, payloadSha256: archive.fileSha256,
        targetDatabase: await databaseFacts(target.database) };
    }
    let stockArchive, stockSource;
    await check('stock-v27-to-v27-0.8.7', async () => {
      const source = await initialized(), target = await initialized(); await seed(source.database);
      assert.equal(await vectorVersion(source.database), '0.8.7'); assert.equal(await vectorVersion(target.database), '0.8.7');
      const before = await rawRowsHash(source.database), archive = await exportPayload('stock-v27', source);
      await load(target, archive); assert.equal(await rawRowsHash(source.database), before);
      assert.equal(await sql(target.database, 'select content_md from notes;'), 'preserved');
      assert.equal(await sql(target.database, 'select vector_dims(embedding)::text||\':\'||(embedding <=> embedding)::text from summaries;'), '1536:0');
      stockArchive = archive; stockSource = source;
      await unchangedArchive(archive); return { schema: 27, vector: '0.8.7', rows: archive.summary.rowCount,
        catalogSha256: archive.summary.catalogSha256, sourceRowsUnchanged: true, payloadSha256: archive.fileSha256,
        sourceDatabase: await databaseFacts(source.database), targetDatabase: await databaseFacts(target.database) };
    });
    let oldSource, oldArchive, oldRows;
    await check('historical-sql-on-new-binary-refuses-new-staging', async () => {
      const oldBase = path.join(share, 'extension/vector--0.8.1.sql');
      await assert.rejects(fs.lstat(oldBase), { code: 'ENOENT' });
      await fs.copyFile(path.join(fixture, 'upstream/vector--0.8.1.sql'), oldBase);
      await fs.copyFile(path.join(fixture, 'upstream/vector-0.8.1.control'), control);
      try { oldSource = await initialized(); await seed(oldSource.database); }
      finally { await fs.writeFile(control, currentControl); }
      assert.equal(await vectorVersion(oldSource.database), '0.8.1');
      assert.equal(sha(await fs.readFile(copiedVector)), vectorHash);
      oldRows = await rawRowsHash(oldSource.database); oldArchive = await exportPayload('old-sql-v27', oldSource);
      const evidence = await rejected(oldArchive); assert.equal(await rawRowsHash(oldSource.database), oldRows);
      return { ...evidence, sourceSqlVersion: '0.8.1', targetSqlVersion: '0.8.7', binarySha256: vectorHash,
        sourceRowsUnchanged: true, sourceRowsSha256: oldRows, catalogSha256: oldArchive.summary.catalogSha256,
        sourceDatabase: await databaseFacts(oldSource.database) };
    });
    await check('explicit-update-new-export-passes-old-export-still-refused', async () => {
      await sql(oldSource.database, "alter extension vector update to '0.8.7';");
      assert.equal(await vectorVersion(oldSource.database), '0.8.7'); assert.equal(await rawRowsHash(oldSource.database), oldRows);
      const updated = await exportPayload('updated-sql-v27', oldSource), target = await initialized();
      assert.notEqual(updated.summary.catalogSha256, oldArchive.summary.catalogSha256);
      assert.deepEqual(updated.rows, oldArchive.rows); await load(target, updated);
      assert.equal(await sql(target.database, 'select content_md from notes;'), 'preserved');
      assert.equal(await sql(target.database, 'select vector_dims(embedding)::text||\':\'||(embedding <=> embedding)::text from summaries;'), '1536:0');
      const oldRejected = await rejected(oldArchive); await unchangedArchive(updated);
      assert.equal(await rawRowsHash(oldSource.database), oldRows);
      return { sourceRowsUnchanged: true, newPayloadSha256: updated.fileSha256, newCatalogSha256: updated.summary.catalogSha256,
        oldPayloadStillRejected: oldRejected, automaticArchiveConversion: false,
        sourceDatabase: await databaseFacts(oldSource.database), targetDatabase: await databaseFacts(target.database) };
    });
    let legacyArchive;
    await check('pinned-historical-v26-to-v27-same-0.8.7', async () => {
      const legacySource = path.join(fixture, 'legacy-src'), migrations = path.join(fixture, 'legacy-migrations');
      await fs.cp(path.join(REPO, 'desktop/src'), legacySource, { recursive: true }); await fs.mkdir(migrations, { mode: 0o700 });
      const sourceHashes = {};
      for (const name of ['backup-export-policy.cjs', 'backup-postgres.cjs', 'backup-payload.cjs', 'backup-source-selection.cjs']) {
        const result = spawnSync('/usr/bin/git', ['show', `${LEGACY_COMMIT}:desktop/src/${name}`],
          { cwd: REPO, env: SYSTEM_ENV, encoding: 'utf8', maxBuffer: 1024 * 1024 });
        assert.equal(result.status, 0, 'Pinned V26 source missing from local history');
        sourceHashes[name] = sha(result.stdout); await fs.writeFile(path.join(legacySource, name), result.stdout, { mode: 0o600 });
      }
      for (const m of REVIEWED_V26_SCHEMA.migrations) await fs.copyFile(path.join(MIGRATIONS, m.filename), path.join(migrations, m.filename));
      const legacy = require(path.join(legacySource, 'backup-postgres.cjs')), legacyPayload = require(path.join(legacySource, 'backup-payload.cjs'));
      const source = await initialized(legacy, migrations), target = await initialized(); await seed(source.database);
      assert.equal(await vectorVersion(source.database), '0.8.7');
      const before = await rawRowsHash(source.database, REVIEWED_V26_SCHEMA);
      const archive = await exportPayload('historical-v26', source, legacy, migrations, legacyPayload);
      legacyArchive = archive;
      assert.equal(archive.summary.schema.migrations.length, 26); await load(target, archive);
      assert.equal(await rawRowsHash(source.database, REVIEWED_V26_SCHEMA), before);
      assert.equal(await sql(target.database, "select analysis_status||':'||analysis_targeted::text||':'||(analysis_reason is null)::text from files;"), 'LEGACY_UNMEASURED:false:true');
      assert.equal(await sql(target.database, 'select count(*) from snapshot_inventory_measurements;'), '0');
      assert.equal(await sql(target.database, 'select count(*) from flyway_schema_history where success;'), '27');
      assert.equal(await sql(target.database, 'select content_md from notes;'), 'preserved');
      assert.equal(await sql(target.database, 'select vector_dims(embedding)::text||\':\'||(embedding <=> embedding)::text from summaries;'), '1536:0');
      await unchangedArchive(archive); return { legacyCommit: LEGACY_COMMIT, sourceHashes, vector: '0.8.7',
        sourceSchema: 26, targetSchema: 27, sourceRowsUnchanged: true, measurements: 0, payloadSha256: archive.fileSha256,
        sourceDatabase: await databaseFacts(source.database), targetDatabase: await databaseFacts(target.database) };
    });
    let preflightLive;
    await check('disposable-preflight-real-controller-v27-v26-and-old-sql-refusal', async () => {
      const initializedLive = await initialized(); await seed(initializedLive.database);
      await closeAdapter(initializedLive.adapter);
      preflightLive = `ci_backup_live_${crypto.randomBytes(8).toString('hex')}`;
      await sql('postgres', `alter database "${initializedLive.database}" rename to "${preflightLive}";`);
      const beforeDatabases = await catalogDatabases(), beforeRows = await rawRowsHash(preflightLive);
      const live = beforeDatabases.find(row => row.name === preflightLive); assert(live?.allowConnections);
      const controller = await databaseControl(preflightLive), results = [];
      try {
        for (const [label, archive, incompatible] of [['stock-v27', stockArchive, false], ['legacy-v26', legacyArchive, false], ['old-sql-v27', oldArchive, true]]) {
          const reader = await PG.createBackupPostgres(options(preflightLive, MIGRATIONS, 'export')); adapters.add(reader);
          const owner = await reader.readRestoreIdentity(); await closeAdapter(reader);
          let probe, callbackError, closed = false;
          const operation = controller.withCompatibilityStage(async database => {
            probe = (await catalogDatabases()).find(row => row.name === database); assert(probe?.allowConnections);
            const adapter = await PG.createBackupPostgres(options(database)); adapters.add(adapter);
            try {
              await adapter.initializeStaging();
              try { adapter.assertRestoreCompatibility({ expected: archive.summary, liveOwnerUserId: owner.ownerUserId }); }
              catch (error) {
                assert.equal(error.code, 'BACKUP_PG_SCHEMA'); callbackError = new BackupRuntimeError('INCOMPATIBLE'); throw callbackError;
              }
              return label;
            } finally { await closeAdapter(adapter); closed = true; }
          });
          if (incompatible) await assert.rejects(operation, error => { assert.equal(error, callbackError);
            assert.equal(error.code, 'BACKUP_RUNTIME_INCOMPATIBLE'); assert.equal(error.recoveryRequired, false); assert(closed); return true; });
          else assert.equal(await operation, label);
          assert(closed); assert(probe); assert.notEqual(probe.oid, live.oid);
          assert.deepEqual(await catalogDatabases(), beforeDatabases); assert.equal(await rawRowsHash(preflightLive), beforeRows);
          await unchangedArchive(archive);
          results.push({ label, schema: archive.summary.schema.migrations.length, outcome: incompatible ? 'REFUSED' : 'COMPATIBLE',
            code: callbackError?.code || null, callbackExceptionPreserved: incompatible ? true : null,
            probeDatabase: probe.name, probeOid: probe.oid, probeAdapterClosed: closed, probeAbsent: true,
            payloadSha256: archive.fileSha256, payloadUnchanged: true, liveOidUnchanged: true, liveRowsUnchanged: true });
        }
      } finally { await closeAdapter(controller); }
      return { controller: 'production withCompatibilityStage', migrationSource: 'pinned initializeStaging',
        administrativeBoundary: 'one owned cluster and sequential administrative operations',
        liveDatabase: preflightLive, liveOid: live.oid, liveRowsSha256: beforeRows, unrelatedDatabasesUnchanged: true, results };
    });
    await check('encrypted-coordinator-old-sql-refusal-before-maintenance', async () => {
      let source;
      await fs.copyFile(path.join(fixture, 'upstream/vector-0.8.1.control'), control);
      try {
        source = await initialized();
        await sql(source.database, `insert into users(id,login,local_key,identity_type) values(1,'fixture','${INSTALLATION}','LOCAL');`);
      } finally { await fs.writeFile(control, currentControl); }
      const archive = await exportPayload('coordinator-old-sql-users-only', source);
      assert.equal(archive.summary.rowCount, '1'); assert.equal(archive.rows[0].table, 'users');
      const sourceRows = await rawRowsHash(source.database), liveRows = await rawRowsHash(preflightLive);
      const beforeDatabases = await catalogDatabases(), live = beforeDatabases.find(row => row.name === preflightLive);
      const userData = path.join(fixture, 'coordinator-user-data'), selectedRoot = path.join(fixture, 'coordinator-selected');
      await fs.mkdir(userData, { mode: 0o700 }); await fs.mkdir(selectedRoot, { mode: 0o700 });
      const key = crypto.randomBytes(32), keyId = crypto.randomBytes(16).toString('hex'), issuedKeys = [];
      const keyProvider = { async currentKeyId(purpose) { assert.equal(purpose, 'backup'); return keyId; },
        async getBackupKey(id) { assert.equal(id, keyId); const issued = Buffer.from(key); issuedKeys.push(issued); return issued; } };
      const selected = path.join(selectedRoot, 'old-sql.cibackup'), calls = [], probeNames = [];
      let runtime;
      try {
        await encryptFile({ sourceRoot: path.dirname(archive.file), sourcePath: archive.file, destinationRoot: selectedRoot,
          destinationPath: selected, installationId: INSTALLATION, keyProvider });
        const selectedHash = sha(await fs.readFile(selected));
        const state = { pendingRestore: null, pendingMaintenance: null, maintenanceReceipt: null, recoveryOnly: false, aiOff: false };
        const stateHash = sha(canonical(state));
        const forbidden = name => async () => { calls.push(name); throw new Error(`Preflight unexpectedly reached ${name}`); };
        const ports = Object.fromEntries(['pause', 'prepareResume', 'resume', 'failure', 'sourceWorker', 'productState',
          'exportVault', 'restoreVault', 'invalidateAuthority'].map(name => [name, forbidden(name)]));
        ports.openExport = async () => {
          calls.push('openExport'); const adapter = await PG.createBackupPostgres(options(preflightLive, MIGRATIONS, 'export')); adapters.add(adapter);
          return Object.freeze({ ...adapter, async close() { await closeAdapter(adapter); calls.push('export.close'); } });
        };
        ports.openStage = async database => {
          probeNames.push(database); calls.push('openStage'); const adapter = await PG.createBackupPostgres(options(database)); adapters.add(adapter);
          return Object.freeze({ ...adapter, async close() { await closeAdapter(adapter); calls.push('probe.close'); } });
        };
        ports.database = async () => {
          calls.push('database'); const controller = await databaseControl(preflightLive);
          return Object.freeze({ ...controller, async close() { await closeAdapter(controller); calls.push('controller.close'); } });
        };
        runtime = await createDesktopBackupRuntime({ userData, installationId: INSTALLATION, runningBuild: '20261005', keyProvider,
          journal: { snapshot: () => ({ ...state }), sealMaintenance: forbidden('journal.seal'), completeMaintenance: forbidden('journal.complete') },
          gateway: { beginMaintenance: forbidden('gateway.begin') }, adapter: { readProjection: forbidden('finance.readProjection') }, ports });
        const recordsRoot = path.join(userData, 'backup-maintenance'), beforeRecords = await treeHash(recordsRoot);
        assert.equal(await runtime.pendingRecovery(), null);
        await assert.rejects(runtime.restore(selected), error => { assert(error instanceof BackupRuntimeError);
          assert.equal(error.code, 'BACKUP_RUNTIME_INCOMPATIBLE'); assert.equal(error.recoveryRequired, false); return true; });
        assert.equal(await runtime.pendingRecovery(), null); assert.equal(await treeHash(recordsRoot), beforeRecords);
        assert.equal(sha(canonical(state)), stateHash); assert.equal(sha(await fs.readFile(selected)), selectedHash);
        assert.deepEqual(await fs.readdir(path.join(userData, 'recovery')), []);
        assert.deepEqual(await catalogDatabases(), beforeDatabases); assert.equal(await rawRowsHash(preflightLive), liveRows);
        assert.equal(await rawRowsHash(source.database), sourceRows); await unchangedArchive(archive);
        assert.equal(probeNames.length, 1); assert.deepEqual(calls, ['openExport', 'database', 'openStage', 'probe.close', 'controller.close', 'export.close']);
        return { code: 'BACKUP_RUNTIME_INCOMPATIBLE', recoveryRequired: false, selectedArchive: selected,
          selectedArchiveSha256: selectedHash, selectedArchiveUnchanged: true, payloadSha256: archive.fileSha256,
          sourceRowsUnchanged: true, liveDatabase: preflightLive, liveOid: live.oid, liveRowsSha256: liveRows,
          liveOidUnchanged: true, liveRowsUnchanged: true, probes: probeNames, probeDatabasesAbsent: true,
          gatewayBeginCalls: 0, pauseCalls: 0, failureCalls: 0, journalWrites: 0, pendingRecovery: null,
          recoveryScratchEmpty: true, authenticatedRecoveryRecordsUnchanged: true, calls,
          realComponents: ['PostgreSQL controller', 'PostgreSQL adapters', 'typed payload', 'encrypt/decryptFile', 'coordinator', 'authenticated recovery records'],
          mockedComponents: ['B journal', 'gateway', 'unused maintenance finance adapter'],
          limitation: 'Pre-maintenance rejection only; no packaged app, durable B cost-ledger or successful coordinator restore claim' };
      } finally { if (runtime) await runtime.close(); key.fill(0); issuedKeys.forEach(issued => issued.fill(0)); }
    });
    await check('non-C-libc-locale-cross-restore-observation', async () => {
      const locales = (await command('available-locales', '/usr/bin/locale', ['-a'])).stdout.split(/\r?\n/);
      const selected = ['en_US.UTF-8', 'en_US.utf8'].find(locale => locales.includes(locale));
      if (!selected) return { notRun: true, reason: 'No requested UTF8 non-C libc locale is installed; ICU remains unverified' };
      const sourceBefore = await rawRowsHash(stockSource.database), target = await initialized(PG, MIGRATIONS, selected);
      const before = await rawRowsHash(target.database); let outcome = 'RESTORED', code = null;
      try { await load(target, stockArchive); }
      catch (error) { assert(['BACKUP_PG_SCHEMA', 'BACKUP_PG_INTEGRITY'].includes(error.code), 'Unexpected cross-locale failure');
        outcome = 'REFUSED'; code = error.code; assert.equal(await rawRowsHash(target.database), before); }
      if (outcome === 'RESTORED') assert.equal(await sql(target.database, 'select content_md from notes;'), 'preserved');
      assert.equal(await rawRowsHash(stockSource.database), sourceBefore); await unchangedArchive(stockArchive);
      return { outcome, code, sourceDatabase: await databaseFacts(stockSource.database), targetDatabase: await databaseFacts(target.database),
        sourceRowsUnchanged: true, fixtureScope: 'Small synthetic row set; no universal cross-locale compatibility or rejection guarantee' };
    });
    await check('existing-opt-in-native-typed-test-with-v26-identity-columns', async () => {
      const source = await emptyDatabase(), target = await emptyDatabase();
      const result = await command('existing-native-typed-test', process.execPath, ['--test', '--test-reporter=tap', '--test-name-pattern',
        '^real isolated PostgreSQL typed export and trigger-respecting staging round trip$', path.join(REPO, 'desktop/test/backup-postgres.test.cjs')],
      { env: { ...SYSTEM_ENV, ...pgEnv, ...clientTls, CI_BACKUP_PG_TEST_PSQL: psql, CI_BACKUP_PG_TEST_SOURCE: source,
        CI_BACKUP_PG_TEST_TARGET: target, CI_BACKUP_PG_TEST_PORT: String(port), CI_BACKUP_PG_TEST_USER: 'backup_fixture',
        CI_BACKUP_PG_TEST_PASSWORD: password, CI_BACKUP_PG_TEST_LIBRARY: nativeEnv.DYLD_LIBRARY_PATH,
        CI_BACKUP_PG_TEST_CLIENT_CERT: certificate, CI_BACKUP_PG_TEST_CLIENT_KEY: privateKey }, timeout: 120000 });
      assert.match(result.stdout, /# pass 1\b/); assert.match(result.stdout, /# fail 0\b/);
      return { exitCode: result.status, nativeTestsPassed: 1, sourceDatabase: source, targetDatabase: target };
    });
    report.status = 'PASS';
  } catch (error) {
    report.status = 'FAIL'; report.error = { code: error.code || error.name, message: String(error.message).slice(0, 1200) };
  } finally {
    let shutdownFailed = false;
    for (const adapter of adapters) try { await adapter.close(); } catch { shutdownFailed = true; }
    if (child) {
      async function waitForExit(milliseconds) {
        let timer;
        try { return await Promise.race([childExit, new Promise(resolve => { timer = setTimeout(() => resolve(null), milliseconds); })]); }
        finally { clearTimeout(timer); }
      }
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGINT');
      let exit = await waitForExit(10000);
      if (!exit) { child.kill('SIGKILL'); exit = await waitForExit(5000); shutdownFailed = true; }
      report.child = { ...report.child, ...exit, stopped: Boolean(exit && !exit.error) };
      if (!report.child.stopped) shutdownFailed = true;
      report.child.portClosed = await new Promise(resolve => {
        const socket = net.createConnection({ host: '127.0.0.1', port: report.child.port }); let settled = false;
        function finish(closed) { if (settled) return; settled = true; socket.destroy(); resolve(closed); }
        socket.once('connect', () => finish(false));
        socket.once('error', error => finish(error.code === 'ECONNREFUSED'));
        socket.setTimeout(1500, () => finish(false));
      });
      if (!report.child.portClosed) shutdownFailed = true;
      await fs.writeFile(path.join(fixture, 'owned-postgres.log'), pgStderr, { mode: 0o600 });
    }
    try {
      if (originalHash) { const after = await treeHash(originalPrefix); report.originalTreeSha256After = after; report.originalPrefixUnchanged = after === originalHash;
        if (!report.originalPrefixUnchanged) shutdownFailed = true; }
      if (copiedVector && vectorHash) { report.vectorBinarySha256After = sha(await fs.readFile(copiedVector));
        report.vectorBinaryUnchanged = report.vectorBinarySha256After === vectorHash;
        if (!report.vectorBinaryUnchanged) shutdownFailed = true; }
    } catch { shutdownFailed = true; }
    report.shutdownVerified = !shutdownFailed;
    if (shutdownFailed) report.status = 'FAIL';
    report.finishedAt = new Date().toISOString(); await save();
    console.log(JSON.stringify({ status: report.status, report: reportFile, shutdownVerified: report.shutdownVerified,
      originalPrefixUnchanged: report.originalPrefixUnchanged, checks: report.checks.map(({ name, status }) => ({ name, status })) }));
  }
  if (report.status !== 'PASS') process.exitCode = 1;
}

if (require.main === module) main(process.argv.slice(2)).catch(error => {
  console.error(JSON.stringify({ status: 'FAIL', code: error.code || error.name, message: String(error.message).slice(0, 1200) }));
  process.exitCode = 1;
});
