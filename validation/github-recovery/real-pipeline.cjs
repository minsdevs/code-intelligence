#!/usr/bin/env node
'use strict';

// Run explicitly from the isolated recovery clone. Importing/checking this file starts nothing.
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const net = require('node:net');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');
const { createRequire } = require('node:module');
const { pathToFileURL } = require('node:url');
const { StringDecoder } = require('node:string_decoder');
const { isDeepStrictEqual } = require('node:util');

const ROOT = path.resolve(__dirname, '../..');
const APPROVED_CHROMIUM = '/Users/minseokchae/Library/Caches/ms-playwright/chromium-1243/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing';
const VIEWPORTS = [{ width: 980, height: 700 }, { width: 1280, height: 800 }];
const TERMINAL = new Set(['DONE', 'FAILED', 'CANCELLED']);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function options(argv) {
  const result = { secondAnalysis: false, chromium: APPROVED_CHROMIUM };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--second-analysis') result.secondAnalysis = true;
    else if (argv[i] === '--chromium' && argv[i + 1]) result.chromium = argv[++i];
    else if (argv[i] === '--service-inputs' && argv[i + 1]) result.serviceInputs = argv[++i];
    else throw new Error(`Unsupported argument: ${argv[i]}`);
  }
  return result;
}

function inside(root, target) {
  const relative = path.relative(root, target);
  return relative !== '' && relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

function requireInside(root, target) {
  const resolved = fs.realpathSync(target);
  if (!inside(fs.realpathSync(root), resolved)) throw new Error(`Path escapes its approved input root: ${target}`);
  return resolved;
}

async function sha256(file) {
  const hash = crypto.createHash('sha256');
  for await (const chunk of fs.createReadStream(file)) hash.update(chunk);
  return hash.digest('hex');
}

async function deadline(promise, ms, label) {
  let timer;
  try {
    return await Promise.race([promise, new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
    })]);
  } finally {
    clearTimeout(timer);
  }
}

async function main() {
  if (path.basename(ROOT) !== '.cos-pre-release-recovery-20261005') {
    throw new Error('This runner must remain in the assigned isolated recovery clone.');
  }
  process.umask(0o077);
  const outputRoot = path.join(ROOT, 'validation/local/github-recovery-20261005');
  fs.mkdirSync(outputRoot, { recursive: true, mode: 0o700 });
  requireInside(ROOT, outputRoot);
  const run = fs.mkdtempSync(path.join(outputRoot, `real-${new Date().toISOString().replace(/[:.]/g, '-')}-`));
  fs.chmodSync(run, 0o700);
  const local = (name) => path.join(run, name);
  for (const name of ['logs', 'screenshots', 'home', 'tmp', 'cache', 'config', 'data', 'redis',
    'browser-profile', 'browser-tmp', 'browser-artifacts', 'browser-downloads', 'origins', 'fixture-work']) {
    fs.mkdirSync(local(name), { mode: 0o700 });
  }

  // No inherited credentials, shell startup, dotenv/Vite loader, Git settings or global cache writes.
  const baseEnv = {
    PATH: `${path.dirname(process.execPath)}:/usr/bin:/bin:/usr/sbin:/sbin`,
    HOME: local('home'), TMPDIR: local('tmp'), TMP: local('tmp'), TEMP: local('tmp'),
    XDG_CACHE_HOME: local('cache'), XDG_CONFIG_HOME: local('config'), XDG_DATA_HOME: local('data'),
    LANG: 'en_US.UTF-8', LC_ALL: 'en_US.UTF-8', TZ: 'UTC',
    GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_SYSTEM: '/dev/null', GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_TERMINAL_PROMPT: '0', GIT_ALLOW_PROTOCOL: 'file',
    PLAYWRIGHT_BROWSERS_PATH: local('cache/playwright'), PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD: '1',
  };
  for (const key of Object.keys(process.env)) delete process.env[key];
  Object.assign(process.env, baseEnv);

  const secrets = [crypto.randomBytes(24).toString('hex'), crypto.randomBytes(24).toString('hex'),
    crypto.randomBytes(32).toString('base64'), `ghp_fixture_${crypto.randomBytes(24).toString('hex')}`];
  const [pgPassword, redisPassword, encryptionKey, syntheticPat] = secrets;
  const redact = (value) => {
    let text = String(value ?? '');
    for (const secret of secrets) text = text.split(secret).join('[REDACTED]');
    return text.replace(/(Bearer\s+)[^\s"',]+/gi, '$1[REDACTED]')
      .replace(/((?:XSRF-TOKEN|X-XSRF-TOKEN|SESSION)\s*[=:]\s*)[^\s;"',]+/gi, '$1[REDACTED]');
  };
  const errorInfo = (error) => ({
    name: error?.name ?? 'Error', code: error?.code ?? null,
    message: redact(error?.message ?? error),
    ...(error?.cause ? { cause: redact(error.cause.message ?? error.cause) } : {}),
  });
  const report = {
    format: 1, startedAt: new Date().toISOString(), status: 'RUNNING', primaryRecovery: 'NOT_RUN',
    scope: { realSpringJar: true, realPostgres: true, realRedis: true, realChromiumUi: true,
      github: 'loopback-http-fixture-and-local-file-bare-repository', appApiMocked: false,
      actualGithubAccountUsed: false, nativeDesktopLaunched: false, paidAiUsed: false,
      distributionValidated: false, minimumOsValidated: false, runtimeManifestValidated: false },
    inputs: {}, identifiers: {}, checks: [], requests: [], fixtureRequests: [],
    processes: [], evidence: [], errors: [], cleanup: [], unexpectedBrowserRequests: [],
  };
  const json = (name, value) => fs.writeFileSync(local(name), `${redact(JSON.stringify(value, null, 2))}\n`, { mode: 0o600 });
  const checkpoint = () => json('report.json', report);
  const cleanupCheckpoint = () => {
    try { checkpoint(); }
    catch (error) {
      // Evidence-storage failure must never prevent the remaining owned resources from closing.
      report.errors.push({ phase: 'report-storage', ...errorInfo(error) });
      process.stderr.write(`[real-pipeline] report-storage: ${redact(error.message)}\n`);
    }
  };
  const check = (id, passed, details = {}, fatal = true) => {
    report.checks.push({ id, status: passed ? 'PASS' : 'FAIL', ...details });
    checkpoint();
    if (!passed && fatal) throw new Error(`Check failed: ${id}`);
  };
  const saveEvidence = (name, value) => {
    json(name, value);
    if (!report.evidence.includes(name)) report.evidence.push(name);
    checkpoint();
  };
  let phase = 'preflight';
  const setPhase = (next) => {
    phase = next;
    report.phase = next;
    checkpoint();
    process.stdout.write(`[real-pipeline] ${next}\n`);
  };
  const owned = [];
  const liveServices = [];
  let page;
  let dbEvidence;
  let interrupted;
  const onSignal = (signal) => { interrupted = signal; };
  const onInt = () => onSignal('SIGINT');
  const onTerm = () => onSignal('SIGTERM');
  const onHup = () => onSignal('SIGHUP');
  process.on('SIGINT', onInt);
  process.on('SIGTERM', onTerm);
  process.on('SIGHUP', onHup);

  function attachLog(stream, filename) {
    const fd = fs.openSync(local(filename), 'wx', 0o600);
    const decoder = new StringDecoder('utf8');
    let pending = '';
    let tail = '';
    const emit = (text) => {
      const safe = redact(text);
      fs.writeSync(fd, safe);
      tail = (tail + safe).slice(-12000);
    };
    stream.on('data', (bytes) => {
      pending += decoder.write(bytes);
      const end = pending.lastIndexOf('\n');
      if (end >= 0) { emit(pending.slice(0, end + 1)); pending = pending.slice(end + 1); }
    });
    let flushed = false;
    const flush = () => {
      if (flushed) return;
      flushed = true;
      emit(pending + decoder.end()); pending = '';
    };
    stream.on('end', flush);
    stream.on('close', () => { flush(); fs.closeSync(fd); });
    return () => tail;
  }

  // Every signal below targets the ChildProcess returned here, never a discovered PID/process group.
  function launch(label, executable, args, { env = baseEnv, service = false, stopSignal = 'SIGTERM', cwd = run } = {}) {
    const sequence = report.processes.length + 1;
    const logBase = `logs/${String(sequence).padStart(3, '0')}-${label}`;
    const record = { label, startedAt: new Date().toISOString(), stdout: `${logBase}.stdout.log`, stderr: `${logBase}.stderr.log` };
    report.processes.push(record);
    const child = spawn(executable, args, { cwd, env, shell: false, detached: false, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdoutTail = () => '';
    let stderrTail = () => '';
    let spawnError;
    let closed = false;
    const done = new Promise((resolve) => {
      child.once('error', (error) => { spawnError = error; record.error = errorInfo(error); });
      child.once('close', (code, signal) => {
        closed = true;
        Object.assign(record, { exitCode: code, signal, finishedAt: new Date().toISOString() });
        resolve({ code, signal });
      });
    });
    const failure = () => new Error(`${label}: ${spawnError ? redact(spawnError.message) : `exit=${record.exitCode}, signal=${record.signal}`}\n${stderrTail() || stdoutTail()}`);
    const handle = { child, done, record, failure, stdoutTail: () => stdoutTail(), stderrTail: () => stderrTail(), closed: () => closed };
    owned.push({ label, stop: async () => {
      const alreadyExited = closed;
      if (!closed) {
        child.kill(stopSignal);
        try { await deadline(done, 20000, `${label} graceful shutdown`); }
        catch (error) {
          // Do not escalate to arbitrary/force kills. Report the exact unreaped owned handle.
          record.cleanupPending = true;
          record.ownedPid = child.pid ?? null;
          child.unref(); child.stdout.destroy(); child.stderr.destroy();
          throw error;
        }
      }
      return { exitCode: record.exitCode, signal: record.signal, alreadyExited };
    } });
    if (service) liveServices.push(handle);
    stdoutTail = attachLog(child.stdout, record.stdout);
    stderrTail = attachLog(child.stderr, record.stderr);
    return handle;
  }

  async function command(label, executable, args, settings) {
    const handle = launch(label, executable, args, settings);
    const outcome = await deadline(handle.done, 45000, label);
    if (outcome.code !== 0) throw handle.failure();
    return handle.stdoutTail().trim();
  }

  function ensureAlive() {
    if (interrupted) throw new Error(`Interrupted by ${interrupted}`);
    for (const handle of liveServices) if (handle.closed()) throw handle.failure();
  }

  async function waitUntil(label, probe, timeout = 180000) {
    const until = Date.now() + timeout;
    let last;
    while (Date.now() < until) {
      ensureAlive();
      try { const value = await probe(); if (value) return value; }
      catch (error) { last = error; }
      await sleep(250);
    }
    ensureAlive();
    throw new Error(`${label} timed out${last ? `: ${redact(last.message)}` : ''}`);
  }

  async function listenOwned(label, server) {
    const sockets = new Set();
    server.on('connection', (socket) => { sockets.add(socket); socket.once('close', () => sockets.delete(socket)); });
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', resolve);
    });
    owned.push({ label, stop: async () => {
      const closing = new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
      server.closeIdleConnections?.();
      for (const socket of sockets) socket.destroy();
      await deadline(closing, 5000, `${label} close`);
      return { closed: true };
    } });
    return server.address().port;
  }

  async function ephemeralPort() {
    const server = net.createServer();
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
    const port = server.address().port;
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    return port;
  }

  async function screenshotPair(name, focus) {
    for (const viewport of VIEWPORTS) {
      await page.setViewportSize(viewport);
      if (focus) await focus.scrollIntoViewIfNeeded();
      const filename = `screenshots/${name}-${viewport.width}x${viewport.height}.png`;
      await page.screenshot({ path: local(filename), fullPage: false, animations: 'disabled', timeout: 10000,
        mask: [page.locator('input[type="password"]')] });
      report.evidence.push(filename);
    }
    checkpoint();
  }

  try {
    const opts = options(process.argv.slice(2));
    const rootReal = fs.realpathSync(ROOT);
    const frontend = requireInside(ROOT, path.join(ROOT, 'frontend'));
    const dist = requireInside(frontend, path.join(frontend, 'dist'));
    requireInside(dist, path.join(dist, 'index.html'));
    const { runtimeFile, runtimeRelativePath, libraryEnvironment } = require(path.join(ROOT, 'desktop/src/runtime-platform.cjs'));
    let runtime;
    let layout;
    if (opts.serviceInputs) {
      const descriptorFile = requireInside(outputRoot, path.resolve(ROOT, opts.serviceInputs));
      const descriptor = JSON.parse(fs.readFileSync(descriptorFile, 'utf8'));
      if (descriptor.scope !== 'standalone-test-not-distributable' || typeof descriptor.runtimeRoot !== 'string') {
        throw new Error('Service inputs must declare scope=standalone-test-not-distributable and runtimeRoot.');
      }
      runtime = requireInside(outputRoot, path.resolve(path.dirname(descriptorFile), descriptor.runtimeRoot));
      layout = descriptor.runtime;
      if (!layout || typeof layout !== 'object') throw new Error('Service inputs have no runtime layout.');
      for (const key of ['postgresBin', 'postgresLib', 'postgresPkgLib', 'postgresShare']) {
        const relative = runtimeRelativePath(layout[key], `service input ${key}`);
        if (!relative.startsWith('postgres/')) throw new Error(`Invalid PostgreSQL layout: ${key}`);
        requireInside(runtime, path.join(runtime, relative));
      }
      const hashes = descriptor.criticalHashes;
      const required = ['jre/bin/java', `${layout.postgresBin}/postgres`, `${layout.postgresBin}/initdb`,
        `${layout.postgresBin}/psql`, `${layout.postgresPkgLib}/vector.dylib`, 'redis/bin/redis-server'];
      if (!hashes || typeof hashes !== 'object' || required.some((name) => !Object.hasOwn(hashes, name))) {
        throw new Error('Service inputs must fingerprint Java, PostgreSQL, initdb, psql, pgvector and Redis.');
      }
      for (const [relative, expected] of Object.entries(hashes)) {
        runtimeRelativePath(relative, 'service input fingerprint');
        if (!/^(jre|postgres|redis)\//.test(relative) || !/^[a-f0-9]{64}$/.test(expected)) {
          throw new Error(`Invalid service input fingerprint: ${relative}`);
        }
        if (await sha256(requireInside(runtime, path.join(runtime, relative))) !== expected) {
          throw new Error(`Service input fingerprint mismatch: ${relative}`);
        }
      }
      report.scope.serviceInputScope = descriptor.scope;
      Object.assign(report.inputs, { serviceInputs: path.relative(ROOT, descriptorFile), serviceInputsSha256: await sha256(descriptorFile),
        serviceCriticalHashes: hashes, serviceCriticalHashCount: Object.keys(hashes).length });
      check('standalone_service_inputs_fingerprinted', true, { distributionValidated: false, runtimeManifestValidated: false });
      report.checks.push({ id: 'runtime_manifest_valid', status: 'SKIP', reason: 'Standalone service descriptor is not a distributable runtime manifest.' });
    } else {
      runtime = requireInside(ROOT, path.join(ROOT, 'desktop/stage/runtime'));
      const manifestFile = requireInside(runtime, path.join(runtime, 'runtime-manifest.json'));
      const manifest = JSON.parse(fs.readFileSync(manifestFile, 'utf8'));
      const { validateRuntimeManifest } = require(path.join(ROOT, 'desktop/src/runtime-manifest.cjs'));
      await validateRuntimeManifest(runtime, manifest);
      layout = manifest.runtime;
      report.scope.runtimeManifestValidated = true;
      report.inputs.runtimeManifestSha256 = await sha256(manifestFile);
      check('runtime_manifest_valid', true);
    }
    report.inputs.runtimeRoot = path.relative(ROOT, runtime);
    report.inputs.runtimeLayout = layout;
    const pgBinary = (name) => requireInside(runtime, runtimeFile(runtime, ['postgres', 'bin', name], layout.postgresBin));
    const java = requireInside(runtime, path.join(runtime, 'jre/bin/java'));
    const redis = requireInside(runtime, path.join(runtime, 'redis/bin/redis-server'));
    const pgEnv = { ...baseEnv, ...libraryEnvironment(runtime, [layout.postgresLib], {}), PGPASSWORD: pgPassword,
      PGCONNECT_TIMEOUT: '3', PGSSLMODE: 'disable' };
    const redisEnv = { ...baseEnv, ...libraryEnvironment(runtime, ['redis/lib'], {}) };
    const pgPkgLib = requireInside(runtime, path.join(runtime, layout.postgresPkgLib));
    const pgShare = requireInside(runtime, path.join(runtime, layout.postgresShare));
    const libs = requireInside(ROOT, path.join(ROOT, 'backend/build/libs'));
    const jars = fs.readdirSync(libs).filter((name) => name.endsWith('.jar') && !name.endsWith('-plain.jar')
      && name !== 'code-intelligence-control.jar');
    if (jars.length !== 1) throw new Error(`Expected one executable JAR in backend/build/libs; found ${JSON.stringify(jars)}`);
    const jar = requireInside(libs, path.join(libs, jars[0]));
    const chromiumPath = fs.realpathSync(path.resolve(ROOT, opts.chromium));
    if (!inside(rootReal, chromiumPath) && chromiumPath !== fs.realpathSync(APPROVED_CHROMIUM)) {
      throw new Error('Chromium must be inside this clone or the explicitly approved read-only executable.');
    }
    fs.accessSync(chromiumPath, fs.constants.X_OK);
    const requireFrontend = createRequire(path.join(frontend, 'package.json'));
    requireInside(frontend, requireFrontend.resolve('@playwright/test'));
    const { chromium, expect } = requireFrontend('@playwright/test');
    Object.assign(report.inputs, {
      jar: path.relative(ROOT, jar), jarSha256: await sha256(jar),
      frontendIndexSha256: await sha256(path.join(dist, 'index.html')),
      chromium: inside(rootReal, chromiumPath) ? path.relative(ROOT, chromiumPath) : 'approved-read-only-chromium-1243',
      secondAnalysis: opts.secondAnalysis,
    });
    report.inputs.repoHead = await command('repo-head', '/usr/bin/git', ['-C', ROOT, 'rev-parse', 'HEAD']);
    check('fresh_output_0700', (fs.statSync(run).mode & 0o777) === 0o700);
    await command('java-version', java, ['-version']);

    setPhase('create-local-git-fixture');
    const work = local('fixture-work');
    fs.mkdirSync(path.join(work, 'src/main/java/fixture'), { recursive: true, mode: 0o700 });
    fs.writeFileSync(path.join(work, 'README.md'), '# Synthetic GitHub recovery fixture\n', { mode: 0o600 });
    fs.writeFileSync(path.join(work, 'src/main/java/fixture/Recovery.java'),
      'package fixture;\npublic final class Recovery { public int value() { return 1; } }\n', { mode: 0o600 });
    await command('fixture-init', '/usr/bin/git', ['init', '--initial-branch=main', work]);
    await command('fixture-add', '/usr/bin/git', ['-C', work, '-c', 'core.hooksPath=/dev/null', 'add', '--', 'README.md', 'src']);
    await command('fixture-commit', '/usr/bin/git', ['-C', work, '-c', 'user.name=Recovery Fixture',
      '-c', 'user.email=recovery@example.invalid', '-c', 'commit.gpgsign=false', '-c', 'core.hooksPath=/dev/null',
      'commit', '--message', 'Synthetic recovery fixture [skip ci]']);
    const sourceCommit = await command('fixture-head', '/usr/bin/git', ['-C', work, 'rev-parse', 'HEAD']);
    fs.mkdirSync(local('origins/fixture'), { mode: 0o700 });
    await command('fixture-bare', '/usr/bin/git', ['clone', '--bare', '--no-hardlinks', work, local('origins/fixture/recovery.git')]);
    check('local_fixture_commit', /^[a-f0-9]{40}$/.test(sourceCommit));

    let fixtureMode = 'generic-403';
    const fixture = http.createServer((request, response) => {
      const url = new URL(request.url, 'http://127.0.0.1');
      const authorized = request.headers.authorization === `Bearer ${syntheticPat}`;
      let status = 200;
      let body;
      if (!authorized || request.method !== 'GET') { status = 401; body = { message: 'Bad credentials' }; }
      else if (url.pathname === '/user') {
        body = { id: 424242, login: 'fixture', name: 'Recovery Fixture', avatar_url: null };
      } else if (url.pathname === '/user/repos') {
        body = Number(url.searchParams.get('page') || 1) > 1 ? [] : [{ id: 424243, name: 'recovery',
          full_name: 'fixture/recovery', private: false, default_branch: 'main', description: 'Synthetic local recovery fixture',
          updated_at: '2026-10-05T00:00:00Z', owner: { login: 'fixture' } }];
      } else if (url.pathname === '/repos/fixture/recovery/branches') {
        body = [{ name: 'main', commit: { sha: sourceCommit }, protected: false }];
      } else if (url.pathname === '/repos/fixture/recovery/pulls') {
        status = 403;
        body = { message: fixtureMode === 'generic-403' ? 'Synthetic generic access denial'
          : 'Resource not accessible by personal access token' };
      } else { status = 404; body = { message: 'Unexpected fixture route' }; }
      report.fixtureRequests.push({ phase, method: request.method, path: url.pathname, status, authorized, mode: fixtureMode });
      response.writeHead(status, { 'content-type': 'application/json', 'x-oauth-scopes': 'repo, read:user',
        'x-ratelimit-remaining': '4999', 'x-ratelimit-reset': String(Math.floor(Date.now() / 1000) + 3600) });
      response.end(JSON.stringify(body));
    });
    const fixturePort = await listenOwned('github-fixture', fixture);
    const fixtureOrigin = `http://127.0.0.1:${fixturePort}`;

    setPhase('start-owned-postgres');
    const pgPort = await ephemeralPort();
    const pgData = local('postgres');
    const passwordFile = local('config/postgres-password');
    fs.writeFileSync(passwordFile, `${pgPassword}\n`, { mode: 0o600, flag: 'wx' });
    try {
      await command('initdb', pgBinary('initdb'), ['-D', pgData, '-U', 'recovery', '--encoding=UTF8', '--locale=C',
        '--auth-local=reject', '--auth-host=scram-sha-256', `--pwfile=${passwordFile}`, '-L', pgShare], { env: pgEnv });
    } finally { fs.rmSync(passwordFile, { force: true }); }
    const pg = launch('postgres', pgBinary('postgres'), ['-D', pgData, '-h', '127.0.0.1', '-p', String(pgPort),
      '-c', 'unix_socket_directories=', '-c', 'max_connections=20', '-c', 'ssl=off',
      '-c', `dynamic_library_path=${pgPkgLib}`], { env: pgEnv, service: true, stopSignal: 'SIGINT' });
    const sql = async (label, query, database = 'github_recovery') => command(label, pgBinary('psql'),
      ['-X', '--no-password', '--set=ON_ERROR_STOP=1', '-h', '127.0.0.1', '-p', String(pgPort), '-U', 'recovery',
        '-d', database, '-A', '-t', '-c', query], { env: pgEnv });
    const pgIdentity = await waitUntil('PostgreSQL ownership', async () => {
      const text = await sql('pg-identity', "select json_build_object('dataDirectory',current_setting('data_directory'),'systemIdentifier',system_identifier::text) from pg_control_system()", 'postgres');
      return JSON.parse(text);
    }, 30000);
    const postmasterPid = Number(fs.readFileSync(path.join(pgData, 'postmaster.pid'), 'utf8').split('\n')[0]);
    check('postgres_owned_cluster', pgIdentity.dataDirectory === pgData && postmasterPid === pg.child.pid,
      { dataDirectoryMatches: pgIdentity.dataDirectory === pgData, postmasterHandleMatches: postmasterPid === pg.child.pid,
        clusterIdentifier: pgIdentity.systemIdentifier });
    await sql('create-database', 'CREATE DATABASE github_recovery', 'postgres');

    setPhase('start-owned-redis');
    const redisPort = await ephemeralPort();
    const redisConfig = local('config/redis.conf');
    fs.writeFileSync(redisConfig, ['bind 127.0.0.1', `port ${redisPort}`, 'protected-mode yes', 'daemonize no',
      'save ""', 'appendonly no', `dir ${JSON.stringify(local('redis'))}`, `requirepass ${redisPassword}`,
      'logfile ""', ''].join('\n'), { mode: 0o600, flag: 'wx' });
    const redisHandle = launch('redis', redis, [redisConfig], { env: redisEnv, service: true });
    const redisInfo = await waitUntil('Redis ownership', () => redisServerInfo(redisPort, redisPassword), 30000);
    check('redis_owned_process', redisInfo.process_id === String(redisHandle.child.pid) && redisInfo.config_file === redisConfig,
      { processHandleMatches: redisInfo.process_id === String(redisHandle.child.pid), configFileMatches: redisInfo.config_file === redisConfig });

    const backendPort = await ephemeralPort();
    const backendOrigin = `http://127.0.0.1:${backendPort}`;
    const mime = { '.html': 'text/html; charset=utf-8', '.js': 'application/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
      '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.woff2': 'font/woff2', '.ico': 'image/x-icon' };
    const uiServer = http.createServer((request, response) => {
      let url;
      try { url = new URL(request.url, 'http://127.0.0.1'); }
      catch { response.writeHead(400).end(); return; }
      if (url.pathname.startsWith('/api/')) {
        const record = { sequence: report.requests.length + 1, phase, method: request.method, path: url.pathname };
        report.requests.push(record);
        const upstream = http.request({ hostname: '127.0.0.1', port: backendPort, method: request.method,
          path: url.pathname + url.search, headers: { ...request.headers, host: `127.0.0.1:${backendPort}` } }, (incoming) => {
          record.status = incoming.statusCode;
          response.writeHead(incoming.statusCode, incoming.headers);
          response.flushHeaders();
          incoming.pipe(response);
        });
        upstream.on('error', (error) => {
          record.error = errorInfo(error);
          if (!response.headersSent) response.writeHead(502, { 'content-type': 'text/plain' });
          response.end('Local backend connection failed');
        });
        response.on('close', () => upstream.destroy());
        request.on('aborted', () => upstream.destroy());
        request.pipe(upstream);
        return;
      }
      if (request.method !== 'GET' && request.method !== 'HEAD') { response.writeHead(405).end(); return; }
      try {
        const decoded = decodeURIComponent(url.pathname);
        if (decoded.includes('\0')) throw new Error('Invalid static path');
        let filename = path.resolve(dist, `.${decoded}`);
        if (!inside(dist, filename)) filename = path.join(dist, 'index.html');
        if (!fs.existsSync(filename) || !fs.statSync(filename).isFile()) {
          if (path.extname(decoded)) { response.writeHead(404).end(); return; }
          filename = path.join(dist, 'index.html');
        }
        filename = requireInside(dist, filename);
        response.writeHead(200, { 'content-type': mime[path.extname(filename)] ?? 'application/octet-stream',
          'cache-control': 'no-store', 'x-content-type-options': 'nosniff' });
        if (request.method === 'HEAD') response.end();
        else fs.createReadStream(filename).on('error', () => response.destroy()).pipe(response);
      } catch { response.writeHead(400).end(); }
    });
    const uiPort = await listenOwned('real-frontend-and-api-proxy', uiServer);
    const uiOrigin = `http://127.0.0.1:${uiPort}`;
    const properties = {
      'server.address': '127.0.0.1', 'server.port': backendPort, 'server.ssl.enabled': false,
      'server.servlet.session.cookie.secure': false, 'server.forward-headers-strategy': 'none', 'server.shutdown': 'graceful',
      'spring.lifecycle.timeout-per-shutdown-phase': '5s',
      'spring.datasource.url': `jdbc:postgresql://127.0.0.1:${pgPort}/github_recovery`,
      'spring.datasource.username': 'recovery', 'spring.datasource.password': pgPassword,
      'spring.datasource.hikari.maximum-pool-size': 4,
      'spring.data.redis.host': '127.0.0.1', 'spring.data.redis.port': redisPort, 'spring.data.redis.password': redisPassword,
      'spring.data.redis.ssl.enabled': false,
      'app.data-dir': local('data'), 'app.token-enc-key': encryptionKey, 'app.cors.allowed-origins': uiOrigin,
      'app.github.base-url': fixtureOrigin, 'app.github.clone-base-url': pathToFileURL(local('origins')).href.replace(/\/$/, ''),
      'app.github.oauth.client-id': '', 'app.github.oauth.client-secret': '', 'app.github.native-oauth.client-id': '',
      'app.github.native-oauth.device-code-uri': `${fixtureOrigin}/disabled-oauth`,
      'app.github.native-oauth.token-uri': `${fixtureOrigin}/disabled-oauth`,
      'app.ts-analyzer.base-url': '', 'app.tree-analyzer.base-url': '',
      'app.ai.provider': 'none', 'app.ai.openai.api-key': '', 'app.ai.gemini.api-key': '',
      'app.ai.openai.base-url': `${fixtureOrigin}/disabled-ai`, 'app.ai.gemini.base-url': `${fixtureOrigin}/disabled-ai`,
      'app.analysis.github-rate-limit-retries': 0,
    };
    const propertiesFile = local('config/spring.properties');
    const propertyValue = (value) => String(value).replace(/\\/g, '\\\\').replace(/\n/g, '\\n').replace(/\r/g, '\\r');
    fs.writeFileSync(propertiesFile, Object.entries(properties).map(([key, value]) => `${key}=${propertyValue(value)}`).join('\n') + '\n',
      { mode: 0o600, flag: 'wx' });
    setPhase('start-real-spring-jar');
    launch('spring', java, ['-Xms64m', '-Xmx512m', '-XX:ActiveProcessorCount=2', `-Djava.io.tmpdir=${local('tmp')}`,
      `-Duser.home=${local('home')}`, '-jar', jar,
      `--spring.config.location=classpath:/application.yml,${pathToFileURL(propertiesFile).href}`,
      '--spring.profiles.active=real-recovery'], { service: true });
    await waitUntil('Spring health', async () => {
      const response = await fetch(`${backendOrigin}/actuator/health`, { signal: AbortSignal.timeout(3000), redirect: 'error' });
      return response.ok && (await response.json()).status === 'UP';
    });
    check('real_services_ready', true);

    dbEvidence = async (name) => {
      const id = report.identifiers.projectId;
      if (!Number.isSafeInteger(id) || id <= 0) throw new Error('No fixture project identifier for DB evidence');
      // Explicit columns: never read users/github_credentials, sessions, tokens or full DB dumps.
      const query = `SELECT jsonb_build_object(
        'projects', (SELECT coalesce(jsonb_agg(to_jsonb(p) ORDER BY id),'[]'::jsonb) FROM
          (SELECT id,source_type,current_snapshot_id FROM projects WHERE id=${id}) p),
        'snapshots', (SELECT coalesce(jsonb_agg(to_jsonb(s) ORDER BY id),'[]'::jsonb) FROM
          (SELECT id,project_id,commit_sha,status,source_contract_version,created_at,analyzed_at FROM snapshots WHERE project_id=${id}) s),
        'jobs', (SELECT coalesce(jsonb_agg(to_jsonb(j) ORDER BY id),'[]'::jsonb) FROM
          (SELECT id,project_id,snapshot_id,type,status,error,created_at,updated_at,started_at,finished_at FROM analysis_jobs WHERE project_id=${id}) j),
        'steps', (SELECT coalesce(jsonb_agg(to_jsonb(s) ORDER BY job_id,seq),'[]'::jsonb) FROM
          (SELECT s.id,s.job_id,s.step_key,s.seq,s.status,s.progress_pct,s.attempt,s.error,s.started_at,s.finished_at
           FROM analysis_job_steps s JOIN analysis_jobs j ON j.id=s.job_id WHERE j.project_id=${id}) s),
        'gitMetadataEvidence', (SELECT coalesce(jsonb_agg(to_jsonb(e) ORDER BY evidence_id),'[]'::jsonb) FROM
          (SELECT e.id AS evidence_id,l.subject_id AS snapshot_id,e.kind,
           position('PR_METADATA_PERMISSION_DENIED' in coalesce(e.excerpt,''))>0 AS permission_warning
           FROM evidences e JOIN evidence_links l ON l.evidence_id=e.id WHERE e.project_id=${id} AND l.subject_type='GIT_METADATA') e)
      )`;
      // The evidence command's complete sanitized stdout is retained; do not truncate its JSON to a tail.
      const handle = launch(`db-${name}`, pgBinary('psql'), ['-X', '--no-password', '--set=ON_ERROR_STOP=1',
        '-h', '127.0.0.1', '-p', String(pgPort), '-U', 'recovery', '-d', 'github_recovery', '-A', '-t', '-c', query], { env: pgEnv });
      const outcome = await deadline(handle.done, 15000, `DB evidence ${name}`);
      if (outcome.code !== 0) throw handle.failure();
      const value = JSON.parse(fs.readFileSync(local(handle.record.stdout), 'utf8').trim());
      saveEvidence(`${name}.json`, value);
      return value;
    };

    setPhase('ui-pat-login-and-import');
    const context = await chromium.launchPersistentContext(local('browser-profile'), {
      executablePath: chromiumPath, headless: true,
      env: { ...baseEnv, TMPDIR: local('browser-tmp'), TMP: local('browser-tmp'), TEMP: local('browser-tmp') },
      viewport: VIEWPORTS[0], locale: 'ko-KR',
      acceptDownloads: false, serviceWorkers: 'block', timeout: 45000,
      handleSIGINT: false, handleSIGTERM: false, handleSIGHUP: false,
      downloadsPath: local('browser-downloads'), artifactsDir: local('browser-artifacts'),
      args: ['--disable-background-networking', '--disable-component-update', '--disable-sync', '--no-first-run',
        `--disk-cache-dir=${local('cache/chromium')}`],
    });
    owned.push({ label: 'owned-chromium-context', stop: async () => {
      await deadline(context.close(), 20000, 'Chromium close'); return { closed: true };
    } });
    // Blocking an unexpected destination is an egress guard, never an API/UI response mock.
    await context.route('**/*', async (route) => {
      const url = new URL(route.request().url());
      if (url.origin === uiOrigin || ['data:', 'blob:', 'about:'].includes(url.protocol)) await route.continue();
      else {
        report.unexpectedBrowserRequests.push({ scheme: url.protocol, host: url.hostname, path: url.pathname });
        await route.abort('blockedbyclient');
      }
    });
    page = context.pages()[0] ?? await context.newPage();
    if (context.pages().length !== 1) throw new Error('Expected one owned Chromium page');
    page.setDefaultTimeout(20000);
    page.setDefaultNavigationTimeout(30000);
    const clickForResponse = async (button, pathname) => {
      ensureAlive();
      // Observe both promises immediately so a failed click cannot leave an unhandled response timeout.
      const [response] = await Promise.all([
        page.waitForResponse((incoming) => incoming.url() === `${uiOrigin}${pathname}` && incoming.request().method() === 'POST'),
        button.click(),
      ]);
      return response;
    };
    page.on('pageerror', (error) => report.errors.push({ phase, source: 'browser-page', ...errorInfo(error) }));
    await page.addInitScript(() => { window.localStorage.setItem('code-intelligence.lang', 'ko'); });
    await page.goto(`${uiOrigin}/import`);
    await page.getByText('Use a personal access token instead', { exact: true }).click();
    await page.getByLabel('Personal access token', { exact: true }).fill(syntheticPat);
    const patResponse = await clickForResponse(page.getByRole('button', { name: 'PAT로 연결', exact: true }), '/api/auth/pat');
    check('real_ui_pat_login', patResponse.status() === 204);
    await page.getByRole('option', { name: /fixture\/recovery/ }).click();
    await page.getByRole('combobox').selectOption('main');
    const createdResponse = await clickForResponse(page.getByRole('button', { name: '저장소 가져오기', exact: true }), '/api/projects');
    check('real_ui_import_201', createdResponse.status() === 201);
    const created = await createdResponse.json();
    const projectId = created.project?.id;
    const firstJobId = created.jobId;
    check('real_import_identifiers', Number.isSafeInteger(projectId) && projectId > 0 && Number.isSafeInteger(firstJobId) && firstJobId > 0);
    Object.assign(report.identifiers, { projectId, failedJobId: firstJobId });

    const apiGet = async (apiPath) => {
      const result = await page.evaluate(async (pathname) => {
        const response = await fetch(pathname, { credentials: 'include', signal: AbortSignal.timeout(5000) });
        return { status: response.status, value: await response.json() };
      }, apiPath);
      if (result.status !== 200) throw new Error(`GET ${apiPath}: HTTP ${result.status}`);
      return result.value;
    };
    const waitJob = (id) => waitUntil(`job ${id}`, async () => {
      const job = await apiGet(`/api/jobs/${id}`);
      return TERMINAL.has(job.status) ? job : false;
    });
    const step = (job, key) => job.steps?.find((entry) => entry.stepKey === key);
    const firstJob = await waitJob(firstJobId);
    Object.assign(report.identifiers, { failedSnapshotId: firstJob.snapshotId });
    const original = await dbEvidence('first-failure');
    check('generic_403_fails_git_metadata', firstJob.status === 'FAILED' && step(firstJob, 'IMPORT')?.status === 'DONE'
      && step(firstJob, 'GIT_METADATA')?.status === 'FAILED' && /GitHub pulls request failed/.test(firstJob.error ?? '')
      && step(firstJob, 'FINALIZE')?.status === 'PENDING');
    check('failed_snapshot_not_published', original.projects[0]?.current_snapshot_id === null
      && original.snapshots.some((snapshot) => snapshot.id === firstJob.snapshotId));
    await page.goto(`${uiOrigin}/projects/${projectId}`);
    const region = page.getByRole('region', { name: 'GitHub 분석', exact: true });
    const startButton = region.getByRole('button', { name: '새 분석 시작', exact: true });
    await expect(startButton).toBeEnabled();
    await expect(region.getByRole('status')).toHaveText('분석 실패');
    await screenshotPair('first-failure', startButton);

    setPhase('reject-changed-checkpoint-through-ui');
    const managedClone = requireInside(local('data'), local(`data/repos/${projectId}`));
    const trackedFile = requireInside(managedClone, path.join(managedClone, 'README.md'));
    const originalBytes = fs.readFileSync(trackedFile);
    fs.appendFileSync(trackedFile, '\nSynthetic checkpoint mutation for RETRY_SOURCE_UNVERIFIED.\n');
    const mutatedHash = await sha256(trackedFile);
    const rejected = await clickForResponse(region.getByRole('button', { name: '다시 시도', exact: true }), `/api/jobs/${firstJobId}/retry`);
    const problem = await rejected.json();
    saveEvidence('checkpoint-retry-response.json', { status: rejected.status(), code: problem.code, projectId, jobId: firstJobId,
      originalFileSha256: crypto.createHash('sha256').update(originalBytes).digest('hex'), mutatedFileSha256: mutatedHash });
    check('retry_source_unverified_409', rejected.status() === 409 && problem.code === 'RETRY_SOURCE_UNVERIFIED');
    await expect(region.getByRole('link', { name: '기존 프로젝트에서 새 분석', exact: true })).toBeVisible();
    await expect(region.getByRole('button', { name: '다시 시도', exact: true })).toHaveCount(0);
    await screenshotPair('checkpoint-retry-blocked', region.getByRole('link', { name: '기존 프로젝트에서 새 분석', exact: true }));
    const blocked = await dbEvidence('after-blocked-retry');
    const retained = (evidence) => isDeepStrictEqual(evidence.jobs.find((job) => job.id === firstJobId), original.jobs.find((job) => job.id === firstJobId))
      && isDeepStrictEqual(evidence.steps.filter((item) => item.job_id === firstJobId), original.steps.filter((item) => item.job_id === firstJobId))
      && isDeepStrictEqual(evidence.snapshots.find((item) => item.id === firstJob.snapshotId), original.snapshots.find((item) => item.id === firstJob.snapshotId));
    check('rejected_retry_preserves_db_evidence', retained(blocked));

    setPhase('fresh-analysis-from-existing-project-ui');
    fixtureMode = 'recognized-pr-permission-403';
    const primaryStartSequence = report.requests.length;
    const accepted = await clickForResponse(startButton, `/api/projects/${projectId}/reanalyze`);
    check('fresh_analysis_accepted_202', accepted.status() === 202);
    const started = await accepted.json();
    const recoveryJobId = started.jobId;
    check('fresh_job_same_project', Number.isSafeInteger(recoveryJobId) && recoveryJobId > firstJobId);
    report.identifiers.recoveryJobId = recoveryJobId;
    const recoveryJob = await waitJob(recoveryJobId);
    const recoveredProject = await apiGet(`/api/projects/${projectId}`);
    const recovered = await dbEvidence('after-recovery');
    report.identifiers.recoverySnapshotId = recoveredProject.currentSnapshot?.id ?? null;
    check('real_git_metadata_and_finalize_done', recoveryJob.status === 'DONE'
      && step(recoveryJob, 'GIT_METADATA')?.status === 'DONE' && step(recoveryJob, 'FINALIZE')?.status === 'DONE');
    check('current_snapshot_ready_same_project', recoveredProject.id === projectId && recoveryJob.projectId === projectId
      && recoveredProject.latestJob?.id === recoveryJobId && recoveredProject.currentSnapshot?.id === recoveryJob.snapshotId
      && recoveredProject.currentSnapshot?.status === 'READY' && recoveredProject.currentSnapshot?.commitSha === sourceCommit);
    check('original_failure_job_steps_snapshot_preserved', retained(recovered));
    check('managed_source_restored_by_real_import', (await sha256(trackedFile)) === crypto.createHash('sha256').update(originalBytes).digest('hex'));
    check('optional_pr_permission_recorded_as_evidence', recovered.gitMetadataEvidence.some((item) => item.snapshot_id === recoveryJob.snapshotId && item.permission_warning));
    const primaryRequests = report.requests.slice(primaryStartSequence);
    check('one_fresh_analysis_post_zero_delete', primaryRequests.filter((item) => item.method === 'POST' && item.path === `/api/projects/${projectId}/reanalyze`).length === 1
      && report.requests.every((item) => item.method !== 'DELETE'), { freshPosts: primaryRequests.filter((item) => item.method === 'POST' && item.path.endsWith('/reanalyze')).length,
      deletes: report.requests.filter((item) => item.method === 'DELETE').length });
    await expect(region.getByRole('status')).toHaveText('분석 완료', { timeout: 20000 });
    await expect(startButton).toBeEnabled();
    await screenshotPair('recovered', startButton);
    report.primaryRecovery = 'PASS';
    checkpoint();

    if (opts.secondAnalysis) {
      setPhase('optional-second-analysis-retention');
      const secondStartSequence = report.requests.length;
      const response = await clickForResponse(startButton, `/api/projects/${projectId}/reanalyze`);
      check('second_analysis_accepted_202', response.status() === 202);
      const secondId = (await response.json()).jobId;
      report.identifiers.secondRecoveryJobId = secondId;
      const secondJob = await waitJob(secondId);
      const afterSecond = await dbEvidence('after-second-analysis');
      check('second_analysis_done', secondJob.status === 'DONE' && step(secondJob, 'GIT_METADATA')?.status === 'DONE' && step(secondJob, 'FINALIZE')?.status === 'DONE');
      check('second_analysis_preserves_first_failure_evidence', retained(afterSecond), {
        firstJobPresent: afterSecond.jobs.some((job) => job.id === firstJobId),
        firstSnapshotPresent: afterSecond.snapshots.some((snapshot) => snapshot.id === firstJob.snapshotId),
        note: 'Observed with the application retention policy under test; no fixture override changes retention. Original evidence files remain in this run.',
      }, false);
      check('second_analysis_one_post', report.requests.slice(secondStartSequence).filter((item) => item.method === 'POST' && item.path.endsWith('/reanalyze')).length === 1);
      await expect(region.getByRole('status')).toHaveText('분석 완료', { timeout: 20000 });
      await screenshotPair('second-analysis', startButton);
    } else report.checks.push({ id: 'second_analysis_preserves_first_failure_evidence', status: 'SKIP', reason: 'Enable --second-analysis to check the next retention boundary.' });

    check('no_external_browser_destinations', report.unexpectedBrowserRequests.length === 0);
    check('unauthenticated_fixture_requests_rejected', report.fixtureRequests.filter((item) => !item.authorized).every((item) => item.status === 401),
      { rejectedRequests: report.fixtureRequests.filter((item) => !item.authorized).length });
    check('only_expected_authenticated_github_fixture_routes', report.fixtureRequests.filter((item) => item.authorized).every((item) => [200, 403].includes(item.status))
      && report.fixtureRequests.some((item) => item.path.endsWith('/pulls') && item.mode === 'generic-403')
      && report.fixtureRequests.some((item) => item.path.endsWith('/pulls') && item.mode === 'recognized-pr-permission-403'));
    const mutationCounts = {
      patLogin: report.requests.filter((item) => item.method === 'POST' && item.path === '/api/auth/pat').length,
      imports: report.requests.filter((item) => item.method === 'POST' && item.path === '/api/projects').length,
      retries: report.requests.filter((item) => item.method === 'POST' && item.path === `/api/jobs/${firstJobId}/retry`).length,
      reanalyzes: report.requests.filter((item) => item.method === 'POST' && item.path === `/api/projects/${projectId}/reanalyze`).length,
      deletes: report.requests.filter((item) => item.method === 'DELETE').length,
    };
    check('ui_mutation_counts', mutationCounts.patLogin === 1 && mutationCounts.imports === 1 && mutationCounts.retries === 1
      && mutationCounts.reanalyzes === (opts.secondAnalysis ? 2 : 1) && mutationCounts.deletes === 0, mutationCounts);
    check('single_browser_page', context.pages().length === 1);
    ensureAlive();
  } catch (error) {
    report.errors.push({ phase, ...errorInfo(error) });
    if (report.primaryRecovery === 'NOT_RUN') report.primaryRecovery = 'FAIL';
    if (dbEvidence && report.identifiers.projectId) {
      try { await dbEvidence('failure-diagnostic'); }
      catch (diagnosticError) { report.errors.push({ phase: 'db-diagnostic', ...errorInfo(diagnosticError) }); }
    }
    if (page && !page.isClosed()) {
      try { await screenshotPair('failure-diagnostic'); }
      catch (diagnosticError) { report.errors.push({ phase: 'screenshot-diagnostic', ...errorInfo(diagnosticError) }); }
    }
  } finally {
    phase = 'cleanup-owned-handles';
    report.phase = phase;
    if (interrupted) report.errors.push({ phase, name: 'Interrupted', message: `Interrupted by ${interrupted}` });
    cleanupCheckpoint();
    for (const resource of [...owned].reverse()) {
      try { report.cleanup.push({ label: resource.label, status: 'PASS', ...(await resource.stop()) }); }
      catch (error) { report.cleanup.push({ label: resource.label, status: 'FAIL', ...errorInfo(error) }); }
      cleanupCheckpoint();
    }
    // Synthetic credentials are never exported as evidence. Keep DB/logs/screenshots, remove only owned config secrets.
    for (const filename of ['config/spring.properties', 'config/redis.conf', 'config/postgres-password']) {
      try { fs.rmSync(local(filename), { force: true }); }
      catch (error) { report.cleanup.push({ label: `remove-${filename}`, status: 'FAIL', ...errorInfo(error) }); }
    }
    process.removeListener('SIGINT', onInt);
    process.removeListener('SIGTERM', onTerm);
    process.removeListener('SIGHUP', onHup);
    report.finishedAt = new Date().toISOString();
    report.status = report.primaryRecovery === 'PASS' && report.errors.length === 0
      && !report.checks.some((item) => item.status === 'FAIL') && report.cleanup.every((item) => item.status === 'PASS') ? 'PASS' : 'FAIL';
    cleanupCheckpoint();
    if (report.errors.some((error) => error.phase === 'report-storage')) report.status = 'FAIL';
    process.stdout.write(`${JSON.stringify({ status: report.status, primaryRecovery: report.primaryRecovery,
      report: local('report.json'), identifiers: report.identifiers })}\n`);
    process.exitCode = report.status === 'PASS' ? 0 : 1;
  }
}

// Minimal RESP reader for a password-authenticated INFO request to the owned Redis only.
function redisServerInfo(port, password) {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection({ host: '127.0.0.1', port });
    let bytes = Buffer.alloc(0);
    let authenticated = false;
    let settled = false;
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      if (error) reject(error); else resolve(value);
    };
    const encode = (parts) => `*${parts.length}\r\n${parts.map((part) => `$${Buffer.byteLength(part)}\r\n${part}\r\n`).join('')}`;
    socket.setTimeout(3000, () => finish(new Error('Redis INFO timed out')));
    socket.once('error', (error) => finish(error));
    socket.once('connect', () => socket.write(encode(['AUTH', password]) + encode(['INFO', 'server'])));
    socket.on('data', (chunk) => {
      bytes = Buffer.concat([bytes, chunk]);
      if (bytes.length > 65536) { finish(new Error('Redis INFO exceeded 64 KiB')); return; }
      if (!authenticated) {
        const end = bytes.indexOf('\r\n');
        if (end < 0) return;
        if (bytes.subarray(0, end).toString() !== '+OK') { finish(new Error('Redis synthetic AUTH failed')); return; }
        authenticated = true; bytes = bytes.subarray(end + 2);
      }
      const end = bytes.indexOf('\r\n');
      if (end < 0) return;
      const header = bytes.subarray(0, end).toString();
      if (!/^\$\d+$/.test(header)) { finish(new Error('Unexpected Redis INFO response')); return; }
      const length = Number(header.slice(1));
      if (bytes.length < end + 2 + length + 2) return;
      const info = {};
      for (const line of bytes.subarray(end + 2, end + 2 + length).toString().split('\r\n')) {
        const colon = line.indexOf(':');
        if (colon > 0) info[line.slice(0, colon)] = line.slice(colon + 1);
      }
      finish(null, info);
    });
    socket.once('close', () => { if (!settled) finish(new Error('Redis connection closed before INFO completed')); });
  });
}

if (require.main === module) {
  main().catch((error) => {
    // Only bootstrap errors can reach here, before synthetic credentials/services exist.
    process.stderr.write(`real-pipeline bootstrap failure: ${error.code ?? error.name}: ${error.message}\n`);
    process.exitCode = 1;
  });
}
