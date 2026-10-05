'use strict';
const assert = require('node:assert/strict'), fs = require('node:fs'), path = require('node:path');
const crypto = require('node:crypto'), net = require('node:net');
const { spawn, spawnSync } = require('node:child_process');
const { createServiceTransport } = require('../../desktop/src/service-transport.cjs');
const { validateRuntimeManifest } = require('../../desktop/src/runtime-manifest.cjs');
const hash = f => crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex');
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function freePort() {
  const server = net.createServer(); await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const port = server.address().port; await new Promise(resolve => server.close(resolve)); return port;
}
async function main() {
  assert.equal(process.platform, 'darwin'); assert.equal(process.arch, 'arm64'); process.umask(0o077);
  assert.equal(process.argv.length, 4); assert.equal(process.argv[2], '--app');
  const repo = fs.realpathSync(path.resolve(__dirname, '../..')), app = fs.realpathSync(process.argv[3]);
  assert.equal(path.basename(app), 'Code Intelligence Validation.app');
  assert.equal(path.dirname(path.dirname(app)), repo); assert(/^\.native-product-[A-Za-z0-9]+$/.test(path.basename(path.dirname(app))));
  const runtime = path.join(app, 'Contents/Resources/runtime'), manifestFile = path.join(runtime, 'runtime-manifest.json');
  const manifest = JSON.parse(fs.readFileSync(manifestFile)); await validateRuntimeManifest(runtime, manifest);
  const base = path.join(repo, 'validation/local/pre-release-auth'); fs.mkdirSync(base, { recursive: true, mode: 0o700 });
  const root = fs.mkdtempSync(path.join(base, 'auth-store-')); fs.writeFileSync(path.join(root, 'purpose.txt'), 'isolated-github-credential-store\n');
  const userData = path.join(root, 'user'); fs.mkdirSync(userData, { mode: 0o700 });
  const ports = { postgres: await freePort(), redis: await freePort(), backend: await freePort(), analyzer: await freePort() };
  assert.equal(new Set(Object.values(ports)).size, 4);
  const password = crypto.randomBytes(32).toString('hex'), database = 'ci_auth_store_' + crypto.randomBytes(8).toString('hex');
  const report = { format: 1, status: 'RUNNING', root, database, app, realPostgres: true, realGithub: false,
    userProfile: false, keychain: false, manifestSha256: hash(manifestFile), asarSha256: hash(path.join(app, 'Contents/Resources/app.asar')),
    sources: Object.fromEntries(['backend/src/main/java/dev/codeintelligence/auth/GithubCredentialStore.java',
      'backend/src/main/java/dev/codeintelligence/auth/GithubDeviceCredentialCodec.java',
      'backend/src/test/java/dev/codeintelligence/auth/GithubCredentialStorePostgresTest.java',
      'validation/pre-release/run-auth-store.cjs'].map(file => [file, hash(path.join(repo, file))])) };
  const save = () => fs.writeFileSync(path.join(root, 'result.json'), JSON.stringify(report, null, 2) + '\n');
  let transport, pg, pgDone;
  save(); console.log(JSON.stringify({ status: report.status, root }));
  const bin = name => path.join(runtime, manifest.runtime.postgresBin, name);
  try {
    transport = await createServiceTransport({ userData, ports, getApiToken: () => 'unused-fixture-capability' });
    const env = { PATH: '/usr/bin:/bin', HOME: root, TMPDIR: root, LANG: 'C', LC_ALL: 'C',
      DYLD_LIBRARY_PATH: path.join(runtime, manifest.runtime.postgresLib), ...transport.postgresEnvironment,
      PGPASSWORD: password, PGSSLCERT: path.join(root, 'absent-client.crt'), PGSSLKEY: path.join(root, 'absent-client.key'),
      PGPASSFILE: path.join(root, 'absent-pgpass'), PGSERVICEFILE: path.join(root, 'absent-pgservice'), PGSYSCONFDIR: root };
    function command(name, args, input) {
      const result = spawnSync(bin(name), args, { cwd: root, env, input, encoding: 'utf8', timeout: 30000, maxBuffer: 1024 * 1024 });
      assert.equal(result.status, 0, 'OWNED_AUTH_DATABASE_COMMAND_FAILED'); return result.stdout;
    }
    const data = path.join(root, 'pg'), pwfile = path.join(root, 'init-password'); fs.writeFileSync(pwfile, password, { mode: 0o600 });
    command('initdb', ['-D', data, '-U', 'codeintel', '--encoding=UTF8', '--no-locale', '--auth-local=reject', '--auth-host=scram-sha-256', '--pwfile=' + pwfile]);
    fs.unlinkSync(pwfile);
    const pgLog = fs.openSync(path.join(root, 'postgres.log'), 'wx', 0o600);
    pg = spawn(bin('postgres'), ['-D', data, '-h', '127.0.0.1', '-p', String(ports.postgres), '-c', 'unix_socket_directories=',
      '-c', 'ssl=on', '-c', 'ssl_cert_file=' + transport.materials.postgres.cert, '-c', 'ssl_key_file=' + transport.materials.postgres.key,
      '-c', 'hba_file=' + transport.hba], { cwd: root, env, stdio: ['ignore', pgLog, pgLog], shell: false });
    fs.closeSync(pgLog); pg.on('error', () => { report.pgError = true; });
    pgDone = new Promise(resolve => pg.once('close', (code, signal) => resolve({ code, signal })));
    const args = ['-X', '-w', '-h', '127.0.0.1', '-p', String(ports.postgres), '-U', 'codeintel', '-d', 'postgres', '-v', 'ON_ERROR_STOP=1'];
    let ready = false;
    for (let i = 0; i < 50; i++) {
      assert(pg.exitCode === null && pg.signalCode === null && !report.pgError);
      const result = spawnSync(bin('psql'), [...args, '-Atc', 'select 1;'], { cwd: root, env, timeout: 3000, encoding: 'utf8' });
      if (result.status === 0) { ready = true; break; } await delay(100);
    }
    assert(ready); command('psql', [...args, '-c', `create database "${database}" template template0 encoding 'UTF8';`]);
    const url = transport.jdbcUrl.replace('/codeintel?', '/' + database + '?');
    const init = path.join(root, 'test.init.gradle');
    fs.writeFileSync(init, "allprojects { tasks.withType(Test).configureEach { systemProperty 'user.home', System.getenv('CI_AUTH_FIXTURE_ROOT'); systemProperty 'java.io.tmpdir', System.getenv('CI_AUTH_FIXTURE_ROOT') } }\n");
    const log = fs.openSync(path.join(root, 'gradle.log'), 'wx', 0o600);
    const child = spawn(path.join(repo, 'backend/gradlew'), ['--offline', '--no-daemon', '-I', init, 'test', '--tests', '*GithubCredentialStorePostgresTest'], {
      cwd: path.join(repo, 'backend'), env: { PATH: process.env.PATH, HOME: process.env.HOME, LANG: 'C', LC_ALL: 'C',
        CI_GITHUB_STORE_REAL: '1', CI_AUTH_FIXTURE_ROOT: root, CI_AUTH_JDBC_URL: url, CI_AUTH_DB_PASSWORD: password },
      stdio: ['ignore', log, log], shell: false }); fs.closeSync(log);
    child.on('error', () => { report.testSpawnFailed = true; });
    report.testExit = await new Promise(resolve => child.once('close', (code, signal) => resolve({ code, signal })));
    assert.equal(report.testExit.code, 0); assert.equal(report.testExit.signal, null);
    const xml = path.join(repo, 'backend/build/test-results/test/TEST-dev.codeintelligence.auth.GithubCredentialStorePostgresTest.xml');
    fs.copyFileSync(xml, path.join(root, 'junit.xml')); report.junitSha256 = hash(xml);
    const text = fs.readFileSync(xml, 'utf8'); assert(/tests="6"/.test(text) && /failures="0"/.test(text) && /errors="0"/.test(text) && /skipped="0"/.test(text));
    report.tests = 6; report.failures = 0; report.status = 'PASS';
    await validateRuntimeManifest(runtime, manifest); assert.equal(hash(manifestFile), report.manifestSha256);
    assert.equal(hash(path.join(app, 'Contents/Resources/app.asar')), report.asarSha256);
    for (const [file, expected] of Object.entries(report.sources)) assert.equal(hash(path.join(repo, file)), expected);
    report.sourceAndBundleUnchanged = true;
  } catch (error) { report.status = 'FAIL'; report.failure = error.code || error.name; }
  finally {
    if (pg) {
      if (pg.exitCode === null && pg.signalCode === null) { try { pg.kill('SIGTERM'); } catch { report.pgStopFailed = true; } }
      const closed = await Promise.race([pgDone, delay(15000).then(() => null)]);
      report.postgresExit = closed; report.postgresStopped = closed !== null;
      if (!closed) report.status = 'FAIL';
    }
    if (!pg || report.postgresStopped) { try { await transport?.close(); } catch { report.status = 'FAIL'; report.transportCloseFailed = true; } }
    save();
  }
  console.log(JSON.stringify({ status: report.status, root, tests: report.tests, postgresStopped: report.postgresStopped }));
  if (report.status !== 'PASS') process.exitCode = 1;
}
main().catch(error => { console.error(error.code || error.name); process.exitCode = 1; });
