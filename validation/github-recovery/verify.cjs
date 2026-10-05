'use strict';

// Real backend/PostgreSQL/Redis integration over a synthetic GitHub HTTP server and
// a locally-created bare repository. Never reads a user token/profile or runs CI.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const net = require('node:net');
const crypto = require('node:crypto');
const { spawn, spawnSync } = require('node:child_process');
const { once } = require('node:events');
const { setTimeout: delay } = require('node:timers/promises');
const repository = path.resolve(__dirname, '../..');
const { chromium, request, expect } = require(path.join(repository, 'frontend/node_modules/@playwright/test'));
const browserMode = process.argv.includes('--browser');
const javaHome = process.env.RECOVERY_JAVA_HOME;
assert.ok(javaHome && /^JAVA_VERSION="21\./m.test(fs.readFileSync(path.join(javaHome, 'release'), 'utf8')), 'Explicit JDK 21 required');
const local = path.join(repository, 'validation/local/github-recovery-20261005');
fs.mkdirSync(local, { recursive: true, mode: 0o700 });
const root = fs.mkdtempSync(path.join(local, browserMode ? 'browser-' : 'api-'));
fs.chmodSync(root, 0o700);
const children = [], checks = [], lifecycle = [];
const environment = { PATH: '/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin', LANG: 'C' };
const password = crypto.randomBytes(24).toString('hex');
const fixtureToken = 'ghp_recovery_fixture_not_a_real_token';
const repoName = 'recovery-fixture';
let pulls = 'generic-denial', page, browser, context, github;
const result = { format: 1, scope: browserMode ? 'real-browser-real-backend-synthetic-github' : 'real-backend-api-synthetic-github',
  actualUserAccount: false, installedApplication: false, userDataAccessed: false, schemaChanged: false,
  sourceHead: null, status: 'RUNNING', checks, lifecycle };
const writeJson = (name, value) => fs.writeFileSync(path.join(root, name), JSON.stringify(value, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
function run(binary, args, options = {}) {
  const outcome = spawnSync(binary, args, { cwd: root, env: environment, encoding: 'utf8', timeout: 30000, ...options });
  if (outcome.status !== 0) {
    fs.appendFileSync(path.join(root, 'commands.log'), `${path.basename(binary)}: ${outcome.stderr || outcome.error?.message || outcome.status}\n`, { mode: 0o600 });
    throw new Error(`Command failed: ${path.basename(binary)}; see commands.log`);
  }
  return outcome.stdout.trim();
}
function start(label, binary, args, extraEnv = {}) {
  const fd = fs.openSync(path.join(root, `${label}.log`), 'wx', 0o600);
  const child = spawn(binary, args, { cwd: root, env: { ...environment, ...extraEnv }, stdio: ['ignore', fd, fd] });
  fs.closeSync(fd);
  children.push({ label, child });
  child.on('error', () => {});
  return child;
}
async function port() {
  const server = net.createServer(); server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const value = server.address().port; await new Promise(resolve => server.close(resolve)); return value;
}
async function until(label, predicate, timeout = 60000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await delay(150);
  }
  throw new Error(`Timed out: ${label}`);
}
function check(label, condition) { assert.ok(condition, label); checks.push(label); console.log('PASS:', label); }

async function main() {
  result.sourceHead = run('git', ['-C', repository, 'rev-parse', 'HEAD']);
  const jar = path.join(repository, 'backend/build/libs/backend-0.0.1-SNAPSHOT.jar');
  result.jarSha256 = crypto.createHash('sha256').update(fs.readFileSync(jar)).digest('hex');
  const pgBin = run('pg_config', ['--bindir']), pgShare = run('pg_config', ['--sharedir']), pgLib = run('pg_config', ['--pkglibdir']);
  assert.match(run('pg_config', ['--version']), /^PostgreSQL 16\./);
  const pg = path.join(root, 'postgres-runtime');
  // Preserve the compiled Cellar/opt relationship, as stage-runtime.mjs does.
  // Flattening bin/share makes PostgreSQL fall back to the host's extension path.
  let layoutRoot = pgBin;
  while (![pgBin, pgShare, pgLib].every(file => file === layoutRoot || file.startsWith(layoutRoot + path.sep))) layoutRoot = path.dirname(layoutRoot);
  const ownBin = path.join(pg, path.relative(layoutRoot, pgBin));
  const ownShare = path.join(pg, path.relative(layoutRoot, pgShare));
  const ownLib = path.join(pg, path.relative(layoutRoot, pgLib));
  fs.mkdirSync(ownBin, { recursive: true, mode: 0o700 });
  for (const name of ['postgres', 'initdb', 'psql']) fs.copyFileSync(path.join(pgBin, name), path.join(ownBin, name), fs.constants.COPYFILE_EXCL);
  fs.cpSync(pgShare, ownShare, { recursive: true, dereference: true, errorOnExist: true, force: false });
  fs.cpSync(pgLib, ownLib, { recursive: true, dereference: true, errorOnExist: true, force: false });
  const vector = process.env.RECOVERY_PGVECTOR_ROOT || path.join(local, 'pgvector');
  for (const [source, destination] of [[path.join(vector, 'share/postgresql/extension'), path.join(ownShare, 'extension')], [path.join(vector, 'lib/postgresql'), ownLib]]) {
    for (const name of fs.readdirSync(source)) fs.copyFileSync(path.join(source, name), path.join(destination, name), fs.constants.COPYFILE_EXCL);
  }
  const postgresPort = await port(), redisPort = await port(), apiPort = await port();
  const initPassword = path.join(root, 'init-password');
  fs.writeFileSync(initPassword, password + '\n', { flag: 'wx', mode: 0o600 });
  run(path.join(ownBin, 'initdb'), ['-D', path.join(root, 'pgdata'), '--username=recovery', '--auth=scram-sha-256', '--no-locale', '--encoding=UTF8', `--pwfile=${initPassword}`]);
  start('postgres', path.join(ownBin, 'postgres'), ['-D', path.join(root, 'pgdata'), '-h', '127.0.0.1', '-p', String(postgresPort), '-k', '']);
  const pgPass = path.join(root, 'pgpass');
  fs.writeFileSync(pgPass, `127.0.0.1:${postgresPort}:*:recovery:${password}\n`, { flag: 'wx', mode: 0o600 });
  const sql = (text, database = 'recovery') => run(path.join(ownBin, 'psql'), ['-X', '-qAt', '-v', 'ON_ERROR_STOP=1', '-h', '127.0.0.1', '-p', String(postgresPort), '-U', 'recovery', '-d', database, '-c', text], { env: { ...environment, PGPASSFILE: pgPass } });
  await until('PostgreSQL startup', async () => { try { return sql('select 1', 'postgres') === '1'; } catch { return false; } });
  sql('create database recovery', 'postgres');
  const redisConfig = path.join(root, 'redis.conf');
  fs.writeFileSync(redisConfig, `bind 127.0.0.1\nport ${redisPort}\nprotected-mode yes\nrequirepass ${password}\nsave ""\nappendonly no\ndir ${root}\n`, { flag: 'wx', mode: 0o600 });
  start('redis', '/opt/homebrew/bin/redis-server', [redisConfig]);
  const source = path.join(root, 'fixture-source'), origins = path.join(root, 'origins');
  fs.mkdirSync(source, { mode: 0o700 }); fs.mkdirSync(path.join(origins, 'octocat'), { recursive: true, mode: 0o700 });
  run('git', ['init', '--initial-branch=main', source]);
  fs.mkdirSync(path.join(source, 'src'), { mode: 0o700 });
  fs.writeFileSync(path.join(source, 'README.md'), '# Synthetic recovery fixture\nNo user source.\n', { flag: 'wx' });
  fs.writeFileSync(path.join(source, 'src/Orders.java'), 'public class Orders { public int total() { return quantity(); } private int quantity() { return 2; } }\n', { flag: 'wx' });
  run('git', ['-C', source, 'add', 'README.md', 'src/Orders.java']);
  run('git', ['-C', source, '-c', 'user.name=Recovery fixture', '-c', 'user.email=fixture@example.invalid', '-c', 'commit.gpgsign=false', 'commit', '-m', 'Synthetic fixture [skip ci]']);
  run('git', ['clone', '--bare', '--no-hardlinks', source, path.join(origins, 'octocat', `${repoName}.git`)]);
  github = http.createServer((incoming, outgoing) => {
    const pathname = new URL(incoming.url, 'http://fixture').pathname;
    const send = (status, value) => { outgoing.writeHead(status, { 'Content-Type': 'application/json', 'X-OAuth-Scopes': 'repo, read:user', 'x-ratelimit-remaining': '1000' }); outgoing.end(JSON.stringify(value)); };
    if (incoming.headers.authorization !== `Bearer ${fixtureToken}`) return send(401, { message: 'Bad credentials' });
    if (pathname === '/user') return send(200, { id: 424242, login: 'octocat', name: 'Recovery fixture', avatar_url: null });
    if (pathname === '/user/repos') return send(200, [{ name: repoName, full_name: `octocat/${repoName}`, owner: { login: 'octocat' }, private: true, default_branch: 'main', description: 'Synthetic only', updated_at: '2026-10-05T00:00:00Z' }]);
    if (pathname.endsWith('/branches')) return send(200, [{ name: 'main', commit: { sha: '0'.repeat(40) }, protected: false }]);
    if (pathname.endsWith('/pulls')) return send(403, { message: pulls === 'generic-denial' ? 'Synthetic generic denial' : 'Resource not accessible by integration' });
    return send(404, { message: 'Unexpected fixture request' });
  });
  github.listen(0, '127.0.0.1'); await once(github, 'listening');
  const api = `http://127.0.0.1:${apiPort}`, config = path.join(root, 'backend.properties');
  const properties = {
    'server.port': apiPort, 'server.address': '127.0.0.1', 'spring.datasource.url': `jdbc:postgresql://127.0.0.1:${postgresPort}/recovery`,
    'spring.datasource.username': 'recovery', 'spring.datasource.password': password, 'spring.data.redis.host': '127.0.0.1',
    'spring.data.redis.port': redisPort, 'spring.data.redis.password': password, 'app.token-enc-key': crypto.randomBytes(32).toString('base64'),
    'app.data-dir': path.join(root, 'data'), 'app.github.base-url': `http://127.0.0.1:${github.address().port}`,
    'app.github.clone-base-url': `file://${origins}`, 'app.analysis.github-rate-limit-retries': 0,
    'app.ai.provider': '', 'app.ts-analyzer.base-url': '', 'app.tree-analyzer.base-url': '',
  };
  fs.writeFileSync(config, Object.entries(properties).map(([key, value]) => `${key}=${value}`).join('\n') + '\n', { flag: 'wx', mode: 0o600 });
  const backend = start('backend', path.join(javaHome, 'bin/java'), ['-Xmx768m', `-Duser.home=${root}`, '-jar', jar, `--spring.config.additional-location=file:${config}`]);
  await until('backend startup', async () => {
    if (backend.exitCode !== null) throw new Error('Backend exited during startup; see backend.log');
    try { return (await fetch(`${api}/actuator/health`, { signal: AbortSignal.timeout(1000) })).ok; } catch { return false; }
  });
  check('fresh PostgreSQL applies V1 through V27', sql('select count(*) from flyway_schema_history where success') === '27');
  if (browserMode) {
    browser = await chromium.launch({ headless: true });
    context = await browser.newContext({ baseURL: api, viewport: { width: 1280, height: 900 } });
    await context.addInitScript(() => localStorage.setItem('code-intelligence.lang', 'ko'));
  } else context = await request.newContext({ baseURL: api });
  const client = browserMode ? context.request : context;
  const get = async route => { const response = await client.get(route); assert.ok(response.ok(), `GET ${route}: ${response.status()}`); return response.json(); };
  const post = async (route, data) => {
    await client.get('/api/csrf');
    const state = await context.storageState();
    const csrf = state.cookies.find(cookie => cookie.name === 'XSRF-TOKEN');
    return client.post(route, { ...(data === undefined ? {} : { data }), headers: { 'X-XSRF-TOKEN': decodeURIComponent(csrf?.value || '') } });
  };
  assert.ok((await post('/api/auth/pat', { token: fixtureToken })).ok());
  const created = await post('/api/projects', { repoOwner: 'octocat', repoName, branch: 'main' });
  assert.equal(created.status(), 201); const initial = await created.json();
  const projectId = initial.project.id, firstJobId = initial.jobId;
  const awaitJob = async (id, status) => { await until(`job ${id} ${status}`, async () => (await get(`/api/jobs/${id}`)).status === status); return get(`/api/jobs/${id}`); };
  const failed = await awaitJob(firstJobId, 'FAILED');
  check('generic PR 403 remains a GIT_METADATA failure at 70%', failed.error.includes('GIT_METADATA') && failed.steps.some(step => step.stepKey === 'GIT_METADATA' && step.status === 'FAILED' && step.progressPct === 70));
  writeJson('initial-failed-job.json', failed);
  sql(`insert into notes(project_id,title,content_md) values (${Number(projectId)},'Preserve fixture note','Existing synthetic note')`);
  check('duplicate import is refused without replacing the project', (await post('/api/projects', { repoOwner: 'octocat', repoName })).status() === 409);
  // Mutate only this run's synthetic clone to exercise the retained checkpoint guard.
  fs.appendFileSync(path.join(root, 'data/repos', String(projectId), 'README.md'), 'Changed after failed checkpoint\n');
  if (browserMode) {
    page = await context.newPage();
    await page.goto('/');
    await page.locator(`a[href="/projects/${projectId}/overview"]`).first().click();
    await expect(page.getByRole('button', { name: '새 분석 시작', exact: true })).toBeVisible();
    await page.getByRole('button', { name: '다시 시도', exact: true }).click();
    await expect(page.getByText(/이전 분석의 원본을 검증할 수 없습니다/)).toBeVisible();
    await page.getByRole('link', { name: '기존 프로젝트에서 새 분석', exact: true }).click();
    await expect(page.getByRole('button', { name: '새 분석 시작', exact: true })).toBeVisible();
    await page.screenshot({ path: path.join(root, 'failed-project-recovery.png'), fullPage: true });
  } else {
    const retry = await post(`/api/jobs/${firstJobId}/retry`);
    assert.equal(retry.status(), 409); assert.equal((await retry.json()).code, 'RETRY_SOURCE_UNVERIFIED');
  }
  check('changed checkpoint is rejected without changing the first failed job', JSON.stringify(await get(`/api/jobs/${firstJobId}`)) === JSON.stringify(failed));
  pulls = 'permission-denial';
  const successful = [];
  for (let attempt = 0; attempt < 3; attempt++) {
    let jobId;
    if (browserMode) {
      const response = page.waitForResponse(response => response.url() === `${api}/api/projects/${projectId}/reanalyze` && response.request().method() === 'POST');
      await page.getByRole('button', { name: '새 분석 시작', exact: true }).click();
      const accepted = await response; assert.equal(accepted.status(), 202); jobId = (await accepted.json()).jobId;
    } else {
      const accepted = await post(`/api/projects/${projectId}/reanalyze`); assert.equal(accepted.status(), 202); jobId = (await accepted.json()).jobId;
    }
    const done = await awaitJob(jobId, 'DONE');
    const project = await get(`/api/projects/${projectId}`);
    check(`fresh analysis ${attempt + 1} passes GIT_METADATA and FINALIZE in the same project`, project.id === projectId && project.currentSnapshot.status === 'READY' && done.steps.some(step => step.stepKey === 'GIT_METADATA' && step.status === 'DONE') && done.steps.some(step => step.stepKey === 'FINALIZE' && step.status === 'DONE'));
    successful.push(done); writeJson(`fresh-analysis-${attempt + 1}.json`, done);
    if (page) await expect(page.getByRole('button', { name: '새 분석 시작', exact: true })).toBeEnabled();
  }
  result.originalFailureRows = Number(sql(`select count(*) from analysis_jobs where id=${Number(firstJobId)} and status='FAILED'`));
  check('the original failed job and steps survive multiple fresh analyses', result.originalFailureRows === 1 && JSON.stringify(await get(`/api/jobs/${firstJobId}`)) === JSON.stringify(failed));
  check('legacy successful result retention still keeps exactly two READY snapshots', sql(`select count(*) from snapshots where project_id=${Number(projectId)} and status='READY'`) === '2');
  check('notes remain and no replacement project was created', sql(`select count(*) from notes where project_id=${Number(projectId)} and content_md='Existing synthetic note'`) === '1' && sql('select count(*) from projects') === '1');
  check('optional PR permission denial is retained as evidence', Number(sql("select count(*) from evidences where excerpt like 'PR_METADATA_PERMISSION_DENIED:%'")) > 0);
  result.finalSnapshots = JSON.parse(sql(`select coalesce(json_agg(t),'[]') from (select id,status,source_contract_version from snapshots where project_id=${Number(projectId)} order by id) t`));
  if (page) { await page.screenshot({ path: path.join(root, 'completed-project-recovery.png'), fullPage: true }); check('browser stays on the project after recovery', new URL(page.url()).pathname.startsWith(`/projects/${projectId}`)); }
  result.status = 'PASS';
}

(async () => {
  console.log('Fresh synthetic verification:', root);
  try { await main(); }
  catch (error) { result.status = 'FAIL'; result.failure = error.message; console.error(error.message); if (page) await page.screenshot({ path: path.join(root, 'failure.png'), fullPage: true }).catch(() => {}); }
  finally {
    if (browser) await browser.close().catch(() => {}); else if (context) await context.dispose().catch(() => {});
    if (github) await new Promise(resolve => github.close(resolve));
    for (const { label, child } of [...children].reverse()) {
      if (child.exitCode === null && child.signalCode === null) {
        const closed = once(child, 'exit').catch(() => {}); child.kill(label === 'postgres' ? 'SIGINT' : 'SIGTERM');
        await Promise.race([closed, delay(10000)]);
        if (child.exitCode === null && child.signalCode === null) { child.kill('SIGKILL'); await Promise.race([closed, delay(5000)]); }
      }
      lifecycle.push({ service: label, exited: child.exitCode !== null || child.signalCode !== null, exitCode: child.exitCode, signal: child.signalCode });
    }
    result.cleanupComplete = lifecycle.every(item => item.exited);
    if (!result.cleanupComplete) result.status = 'FAIL';
    writeJson('result.json', result);
    console.log(JSON.stringify({ status: result.status, report: path.join(root, 'result.json'), checks: checks.length, cleanupComplete: result.cleanupComplete }));
    process.exitCode = result.status === 'PASS' ? 0 : 1;
  }
})();
