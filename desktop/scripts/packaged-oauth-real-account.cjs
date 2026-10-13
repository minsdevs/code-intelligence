'use strict';

// Owner-run only: real GitHub account, device-flow lifecycle on a retained Validation bundle with the real
// macOS Keychain and a fresh isolated profile. No Electron loader, no mock keychain, no token ever leaves the
// product: the driver sees the device code (meant to be typed by a person), the numeric GitHub id and the
// repository count. A person (or the owner's browser session) authorizes the device code and later revokes
// the grant on GitHub; the driver waits for both and records what the product reports.
//
//   node desktop/scripts/packaged-oauth-real-account.cjs --app <repo>/.native-product-<id>/Code\ Intelligence\ Validation.app
//     [--repo owner/name] [--authorize-timeout-ms N] [--revoke-timeout-ms N] [--skip-external-revoke]
//
// Steps: start -> connection absent -> device flow start (prints AWAITING_HUMAN_AUTHORIZATION) -> CONNECTED ->
// repository list -> import --repo and wait for the analysis job -> normal exit -> restart on the same profile
// (credential survives the real Keychain) -> external revocation on GitHub (prints AWAITING_HUMAN_REVOCATION,
// product must report a re-authentication reason) -> product-side disconnect -> connection absent -> exit.
// Evidence: validation/local/packaged-oauth/run-*/result.json. Expiry/refresh and organization SSO are not
// exercised (recorded NOT_RUN) because the O1 app's token lifetime and an SSO organization are not available.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const net = require('node:net');
const crypto = require('node:crypto');
const { spawn, execFileSync } = require('node:child_process');
const { createRequire } = require('node:module');
const { prepareIsolatedRun } = require('../src/isolated-run.cjs');
const { inheritedEnvironment } = require('../src/runtime-platform.cjs');
const { validateRuntimeManifest } = require('../src/runtime-manifest.cjs');
const { observeStartup, createDeadline, closeOwnedApplication } = require('./native-acceptance-electron.cjs');

const hash = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const contained = (root, target) => target.startsWith(root + path.sep);
const validPort = port => Number.isSafeInteger(port) && port > 1024 && port < 65536;

function argumentsFor(argv) {
  const options = { app: null, repo: 'octocat/Hello-World', authorizeTimeoutMs: 15 * 60000, revokeTimeoutMs: 15 * 60000, externalRevoke: true };
  for (let index = 0; index < argv.length; index++) {
    const flag = argv[index], value = argv[index + 1];
    if (flag === '--app') { assert.ok(typeof value === 'string' && path.isAbsolute(value), 'ARGUMENT_APP'); options.app = value; index++; }
    else if (flag === '--repo') { assert.match(value ?? '', /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})\/[A-Za-z0-9._-]{1,100}$/, 'ARGUMENT_REPO'); options.repo = value; index++; }
    else if (flag === '--authorize-timeout-ms' || flag === '--revoke-timeout-ms') {
      const ms = Number(value); assert.ok(Number.isSafeInteger(ms) && ms >= 60000 && ms <= 3600000, 'ARGUMENT_TIMEOUT');
      options[flag === '--authorize-timeout-ms' ? 'authorizeTimeoutMs' : 'revokeTimeoutMs'] = ms; index++;
    } else if (flag === '--skip-external-revoke') options.externalRevoke = false;
    else throw new Error('ARGUMENT_UNKNOWN');
  }
  assert.ok(options.app, 'ARGUMENT_APP');
  return options;
}

// What the report keeps of a connection: no token, no login name, no URL beyond the revocation page host.
function redactConnection(connection) {
  assert.ok(connection && typeof connection === 'object');
  return { connected: connection.connected === true, identityType: typeof connection.identityType === 'string' ? connection.identityType : null,
    githubIdPresent: Number.isSafeInteger(connection.githubId), oauthAvailable: connection.oauthAvailable === true,
    reauthenticationReason: connection.reauthenticationReason ?? null,
    revocationHost: typeof connection.githubRevocationUrl === 'string' ? safeHost(connection.githubRevocationUrl) : null };
}
function safeHost(url) { try { return new URL(url).host; } catch { return null; } }

function launchEnvironment(input) {
  return { ...inheritedEnvironment(input), PATH: '/usr/bin:/bin:/usr/sbin:/sbin', LANG: 'C', LC_ALL: 'C' };
}
function launchArguments(claimFile, port) {
  assert.ok(path.isAbsolute(claimFile) && !/[\r\n\0]/.test(claimFile)); assert.ok(validPort(port));
  return ['--isolated-run-claim=' + claimFile, '--remote-debugging-address=127.0.0.1', '--remote-debugging-port=' + port];
}
async function unusedPort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const port = server.address().port;
  await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  return port;
}
async function bounded(action, timeout, code) {
  let timer;
  try {
    return await Promise.race([Promise.resolve().then(action), new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(code)), timeout); })]);
  } finally { clearTimeout(timer); }
}
async function waitFor(action, timeout, code, interval = 200) {
  const expires = performance.now() + timeout;
  while (performance.now() < expires) {
    if (await bounded(action, Math.max(1, expires - performance.now()), code)) return;
    await delay(Math.max(0, Math.min(interval, expires - performance.now())));
  }
  throw new Error(code);
}

async function closePackagedApplication({ child, closeWindow, quitApplication, disconnect },
  { requestTimeoutMs = 5000, normalExitTimeoutMs = 30000, killGraceMs = 5000 } = {}) {
  const record = { pid: child.pid ?? null, normalWindowCloseRequested: false, normalApplicationQuitRequested: false,
    signalsRequested: [], terminationConfirmed: false, processExitedZero: false, disconnected: !disconnect, errors: [] };
  const exited = () => child.exitCode !== null || child.signalCode !== null;
  const errorCode = error => /^[A-Z][A-Z0-9_]+$/.test(error?.message) ? error.message : 'PACKAGE_CLEANUP_FAILED';
  // Forward every signal and event to this one owned ChildProcess. The existing
  // bounded cleanup waits for actual exit after SIGTERM and SIGKILL as well.
  const owned = {
    get exitCode() { return child.exitCode; }, get signalCode() { return child.signalCode; },
    once: (...args) => child.once(...args), removeListener: (...args) => child.removeListener(...args),
    kill(signal) { record.signalsRequested.push(signal); return child.kill(signal); },
  };
  try {
    if (!Number.isSafeInteger(child.pid) || child.pid <= 0) throw new Error('PACKAGE_NOT_SPAWNED');
    await closeOwnedApplication({ process: () => owned, close: async () => {
      if (exited()) return;
      let requested = false;
      if (closeWindow) {
        record.normalWindowCloseRequested = true;
        try { await bounded(closeWindow, requestTimeoutMs, 'PACKAGE_WINDOW_CLOSE_TIMEOUT'); requested = true; }
        catch (error) { record.errors.push(errorCode(error)); }
      }
      if (!exited() && !requested) {
        record.normalApplicationQuitRequested = true;
        await bounded(quitApplication, requestTimeoutMs, 'PACKAGE_QUIT_REQUEST_TIMEOUT');
      }
      if (!exited()) await waitFor(exited, normalExitTimeoutMs, 'PACKAGE_SHUTDOWN_TIMEOUT');
    } }, { timeoutMs: 2 * requestTimeoutMs + normalExitTimeoutMs, killGraceMs });
  } catch (error) { record.errors.push(errorCode(error)); }
  finally {
    // CDP disconnect must never prevent termination of the owned process.
    if (disconnect) {
      try { await bounded(disconnect, requestTimeoutMs, 'PACKAGE_CDP_DISCONNECT_TIMEOUT'); record.disconnected = true; }
      catch (error) { record.errors.push(errorCode(error)); }
    }
    record.exitCode = child.exitCode ?? null; record.signalCode = child.signalCode ?? null;
    record.terminationConfirmed = Number.isSafeInteger(child.pid) && child.pid > 0 && exited();
    record.processExitedZero = record.terminationConfirmed && record.exitCode === 0 && record.signalCode === null;
  }
  return record;
}

async function main(argv = process.argv.slice(2)) {
  assert.equal(process.platform, 'darwin'); assert.equal(process.arch, 'arm64'); assert.ok(process.getuid() > 0);
  process.umask(0o077);
  const options = argumentsFor(argv);
  const root = fs.realpathSync(path.resolve(__dirname, '../..'));
  const app = fs.realpathSync(options.app);
  assert.ok(contained(root, app) && /^\.native-product-[A-Za-z0-9]+$/.test(path.basename(path.dirname(app))));
  assert.equal(path.basename(app), 'Code Intelligence Validation.app');
  const executable = path.join(app, 'Contents/MacOS/Code Intelligence Validation');
  const appArchive = path.join(app, 'Contents/Resources/app.asar');
  const runtime = path.join(app, 'Contents/Resources/runtime'), manifestFile = path.join(runtime, 'runtime-manifest.json');
  const manifestBytes = fs.readFileSync(manifestFile);
  await validateRuntimeManifest(runtime, JSON.parse(manifestBytes));
  execFileSync('/usr/bin/codesign', ['--verify', '--strict', '--deep', app], { timeout: 30000, stdio: 'pipe' });
  const api = createRequire(path.join(root, 'frontend/package.json'));
  const { chromium } = api('playwright');
  const evidenceParent = path.join(root, 'validation/local/packaged-oauth');
  fs.mkdirSync(evidenceParent, { recursive: true, mode: 0o700 });
  const evidence = fs.mkdtempSync(path.join(evidenceParent, 'run-'));
  const shortParent = fs.mkdtempSync('/private/tmp/cioa-');
  const plan = prepareIsolatedRun({ parentDirectory: shortParent, runtimeDirectory: runtime, purpose: 'automation',
    forbiddenRoots: [path.join(os.homedir(), 'Library/Application Support/Code Intelligence'),
      path.join(os.homedir(), 'Library/Application Support/Code Intelligence Validation')] });
  const [repoOwner, repoName] = options.repo.split('/');
  const report = { format: 1, status: 'RUNNING', scope: 'retained-packaged-app-real-keychain-real-github-account',
    appBundle: app, packagedManifestSha256: hash(manifestBytes), driverSha256: hash(fs.readFileSync(__filename)),
    appArchiveSha256: hash(fs.readFileSync(appArchive)), executableSha256: hash(fs.readFileSync(executable)),
    appRebuilt: false, mockKeychain: false, electronLoaderInjected: false, signedInstallation: false, formalSigning: false,
    keychainIdentity: plan.appIdentity.name, profile: plan.paths.userData, claim: plan.claimFile,
    realAccount: true, realAccountVerified: false, tokenObservedByDriver: false, originalProfileAccessed: false,
    repository: { owner: repoOwner, name: repoName }, phase: 'prepared', checks: [], launches: [],
    lifecycle: { authorize: 'NOT_RUN', repositoryList: 'NOT_RUN', import: 'NOT_RUN', restartPersistence: 'NOT_RUN',
      externalRevocation: options.externalRevoke ? 'NOT_RUN' : 'SKIPPED_BY_OPTION', productDisconnect: 'NOT_RUN',
      expiryRefresh: 'NOT_RUN_TOKEN_LIFETIME_NOT_CONFIGURABLE_HERE', organizationSso: 'NOT_RUN_NO_SSO_ORGANIZATION' } };
  const save = () => fs.writeFileSync(path.join(evidence, 'result.json'), JSON.stringify(report, null, 2) + '\n', { mode: 0o600 });
  const phase = value => { report.phase = value; save(); };
  const check = value => { report.checks.push(value); save(); };
  const announce = value => { console.log(JSON.stringify({ ...value, evidence })); };
  const environment = launchEnvironment(process.env);
  let child, browser, page, stopObservation, closePromise;
  const deadline = createDeadline();
  const perform = (action, timeout = 30000, code = 'PACKAGED_OAUTH_OPERATION_TIMEOUT') => deadline.run(action, timeout, code);
  const alive = () => child && child.exitCode === null && child.signalCode === null;

  async function request(route, init = {}) {
    return perform(() => page.evaluate(async ({ route, init }) => {
      const desktop = window.codeIntelligenceDesktop;
      const response = await fetch(desktop.apiBaseUrl + route, { credentials: 'include', signal: AbortSignal.timeout(20000), method: init.method ?? 'GET',
        headers: { 'X-Code-Intelligence-Token': desktop.apiToken, ...(init.body ? { 'Content-Type': 'application/json' } : {}) },
        body: init.body ? JSON.stringify(init.body) : undefined });
      const text = await response.text();
      let json = null; try { json = text ? JSON.parse(text) : null; } catch { json = null; }
      return { ok: response.ok, status: response.status, json };
    }, { route, init }), 25000, 'OWNED_API_TIMEOUT');
  }
  const expectOk = (response, code) => { if (!response.ok) throw new Error(code + '_' + response.status); return response.json; };

  async function launch() {
    assert.ok(!child, 'PREVIOUS_PACKAGE_NOT_CLOSED'); plan.assertIdentity();
    const port = await perform(unusedPort, 5000, 'DEBUG_PORT_TIMEOUT');
    phase('direct-package-start'); delete report.startup; delete report.launchError;
    child = spawn(executable, launchArguments(plan.claimFile, port), { cwd: root, env: environment, stdio: ['ignore', 'ignore', 'pipe'] });
    closePromise = null;
    const launched = child, launchRecord = { sequence: report.launches.length + 1, pid: child.pid ?? null, directPackage: true, mockKeychain: false };
    report.launches.push(launchRecord); save();
    child.on('error', () => { report.launchError = launched.pid ? 'PACKAGE_PROCESS_ERROR' : 'PACKAGE_SPAWN_FAILED'; launchRecord.error = report.launchError; save(); });
    stopObservation = observeStartup(child, report, save);
    // The real Keychain may ask the person to allow access; the product then stays in CREDENTIALS until they answer.
    const askedAt = Date.now(); let keychainHint = false;
    await perform(() => waitFor(async () => {
      assert.ok(!report.launchError, report.launchError); assert.ok(alive(), 'PACKAGE_EXITED_BEFORE_READY');
      assert.notEqual(report.startup?.state, 'FAILED', 'PACKAGE_STARTUP_FAILED');
      if (!keychainHint && report.startup?.phase === 'CREDENTIALS' && Date.now() - askedAt > 15000) {
        keychainHint = true; announce({ status: 'AWAITING_HUMAN_KEYCHAIN_DIALOG', hint: 'Allow the Validation app to use its Keychain item if macOS asks.' });
      }
      return report.startup?.phase === 'READY';
    }, 300000, 'PACKAGE_READY_TIMEOUT'), 300000, 'PACKAGE_READY_TIMEOUT');
    const listener = execFileSync('/usr/sbin/lsof', ['-nP', '-a', '-p', String(child.pid), '-iTCP:' + port, '-sTCP:LISTEN', '-Fn'], { encoding: 'utf8', timeout: 5000 });
    assert.ok(listener.split('\n').includes('n127.0.0.1:' + port), 'Owned loopback debugging listener required');
    phase('attach-existing-renderer');
    browser = await perform(() => chromium.connectOverCDP('http://127.0.0.1:' + port, { timeout: deadline.limit(15000) }), 16000, 'PACKAGE_CDP_ATTACH_TIMEOUT');
    const pages = browser.contexts().flatMap(context => context.pages());
    assert.equal(pages.length, 1, 'Exactly one owned product window required'); page = pages[0]; page.setDefaultTimeout(30000);
    const command = execFileSync('/bin/ps', ['-o', 'command=', '-p', String(child.pid)], { encoding: 'utf8', timeout: 5000 });
    assert.doesNotMatch(command, /--use-mock-keychain|--password-store=basic|--require|--inspect/);
    await perform(() => waitFor(async () => (await request('/api/auth/github/connection')).ok, 60000, 'OWNED_API_NOT_READY', 1000), 60000, 'OWNED_API_NOT_READY');
    launchRecord.readyMs = report.startup?.readyMs ?? null; save();
  }
  function close() {
    if (closePromise) return closePromise;
    if (!child) return Promise.resolve();
    const owned = child, attachedPage = page, attachedBrowser = browser, launchRecord = report.launches.at(-1);
    closePromise = (async () => {
      const record = await closePackagedApplication({ child: owned,
        closeWindow: attachedPage && !attachedPage.isClosed() ? () => attachedPage.close({ runBeforeUnload: true }) : undefined,
        quitApplication: () => execFileSync('/usr/bin/osascript', ['-l', 'JavaScript', '-e',
          `ObjC.import('AppKit'); $.NSRunningApplication.runningApplicationWithProcessIdentifier(${owned.pid}).terminate;`],
        { timeout: 5000, stdio: 'pipe', env: environment }),
        disconnect: attachedBrowser ? () => attachedBrowser.close() : undefined,
      });
      record.launch = launchRecord.sequence; (report.cleanup ??= []).push(record);
      stopObservation?.(); stopObservation = null; browser = null; page = null;
      if (record.terminationConfirmed || !Number.isSafeInteger(owned.pid)) child = null;
      save();
      if (!record.processExitedZero || record.errors.length || record.signalsRequested.length) throw new Error(record.errors[0] || 'PACKAGE_CLEANUP_FAILED');
    })();
    return closePromise;
  }

  let failure;
  try {
    await launch();
    phase('connection-absent');
    const before = redactConnection(expectOk(await request('/api/auth/github/connection'), 'CONNECTION_READ_FAILED'));
    assert.equal(before.connected, false, 'FRESH_PROFILE_ALREADY_CONNECTED'); assert.equal(before.oauthAvailable, true, 'OAUTH_NOT_AVAILABLE_IN_PACKAGE');
    report.connectionBefore = before; check('fresh-profile-not-connected-oauth-available');

    phase('device-flow-start');
    const start = expectOk(await request('/api/auth/github/native/start', { method: 'POST' }), 'DEVICE_FLOW_START_FAILED');
    assert.match(start.userCode ?? '', /^[A-Z0-9-]{4,24}$/, 'DEVICE_CODE_SHAPE'); assert.match(start.verificationUri ?? '', /^https:\/\/github\.com\//, 'VERIFICATION_URI_SHAPE');
    report.deviceFlow = { verificationUri: start.verificationUri, userCode: start.userCode, expiresAt: start.expiresAt, pollAfterSeconds: start.pollAfterSeconds }; save();
    announce({ status: 'AWAITING_HUMAN_AUTHORIZATION', verificationUri: start.verificationUri, userCode: start.userCode, expiresAt: start.expiresAt });
    phase('device-flow-waiting');
    const authorizeExpires = Math.min(Date.now() + options.authorizeTimeoutMs, Date.parse(start.expiresAt) || Number.MAX_SAFE_INTEGER);
    let delaySeconds = start.pollAfterSeconds, last;
    for (;;) {
      await delay(Math.max(1, delaySeconds) * 1000);
      last = expectOk(await request('/api/auth/github/native/poll/' + encodeURIComponent(start.attemptId), { method: 'POST' }), 'DEVICE_FLOW_POLL_FAILED');
      report.deviceFlow.lastStatus = last.status; save();
      if (last.status === 'CONNECTED') break;
      if (last.status !== 'WAITING') { report.lifecycle.authorize = 'FAIL_' + last.status; throw new Error('DEVICE_FLOW_' + last.status); }
      delaySeconds = last.pollAfterSeconds ?? delaySeconds;
      if (Date.now() > authorizeExpires) { report.lifecycle.authorize = 'TIMEOUT_NO_HUMAN_AUTHORIZATION'; throw new Error('DEVICE_FLOW_AUTHORIZATION_TIMEOUT'); }
    }
    report.lifecycle.authorize = 'PASS'; check('device-flow-connected');
    const connected = redactConnection(expectOk(await request('/api/auth/github/connection'), 'CONNECTION_READ_FAILED'));
    assert.equal(connected.connected, true, 'CONNECTED_STATUS_MISSING'); assert.equal(connected.githubIdPresent, true, 'GITHUB_ID_MISSING');
    report.connectionAfterAuthorize = connected; report.realAccountVerified = true; save();

    phase('repository-list');
    const repos = expectOk(await request('/api/github/repos?page=1&perPage=10'), 'REPOSITORY_LIST_FAILED');
    const items = Array.isArray(repos?.items) ? repos.items : [];
    report.repositoryList = { count: items.length }; report.lifecycle.repositoryList = items.length > 0 ? 'PASS' : 'EMPTY'; check('repository-list-read');

    phase('github-import');
    const created = await request('/api/projects', { method: 'POST', body: { repoOwner, repoName, url: 'https://github.com/' + repoOwner + '/' + repoName, branch: null } });
    const project = expectOk(created, 'GITHUB_IMPORT_CREATE_FAILED');
    const projectId = project?.project?.id, jobId = project?.jobId; assert.ok(Number.isSafeInteger(projectId) && Number.isSafeInteger(jobId), 'PROJECT_ID_MISSING');
    report.import = { projectId, jobId, created: new Date().toISOString() }; save();
    let jobStatus = null;
    await perform(() => waitFor(async () => {
      const jobs = expectOk(await request('/api/projects/' + encodeURIComponent(projectId) + '/jobs?limit=50'), 'JOBS_READ_FAILED');
      const job = (Array.isArray(jobs) ? jobs : []).find(item => item?.id === jobId); jobStatus = job?.status ?? null; report.import.jobStatus = jobStatus; save();
      return ['DONE', 'FAILED', 'CANCELLED'].includes(jobStatus);
    }, 10 * 60000, 'GITHUB_IMPORT_JOB_TIMEOUT', 3000), 10 * 60000, 'GITHUB_IMPORT_JOB_TIMEOUT');
    report.lifecycle.import = jobStatus === 'DONE' ? 'PASS' : 'FAIL_' + jobStatus; check('github-import-job-' + jobStatus);

    phase('first-normal-exit'); await close();
    phase('same-profile-restart'); await launch();
    const persisted = redactConnection(expectOk(await request('/api/auth/github/connection'), 'CONNECTION_READ_FAILED'));
    report.connectionAfterRestart = persisted; report.lifecycle.restartPersistence = persisted.connected ? 'PASS' : 'FAIL'; save();
    assert.equal(persisted.connected, true, 'CONNECTION_LOST_ACROSS_RESTART'); check('connection-survives-real-keychain-restart');

    if (options.externalRevoke) {
      phase('external-revocation-waiting');
      announce({ status: 'AWAITING_HUMAN_REVOCATION', revocationHost: persisted.revocationHost, hint: 'Revoke the OAuth app grant on GitHub (Settings > Applications > Authorized OAuth Apps).' });
      let observed = null;
      await perform(() => waitFor(async () => {
        await request('/api/github/repos?page=1&perPage=1');
        const now = redactConnection(expectOk(await request('/api/auth/github/connection'), 'CONNECTION_READ_FAILED'));
        observed = now; report.connectionAfterExternalRevocation = now; save();
        return now.connected === false || now.reauthenticationReason !== null;
      }, options.revokeTimeoutMs, 'EXTERNAL_REVOCATION_TIMEOUT', 10000), options.revokeTimeoutMs, 'EXTERNAL_REVOCATION_TIMEOUT');
      report.lifecycle.externalRevocation = 'PASS_' + (observed.reauthenticationReason ?? 'DISCONNECTED'); check('external-revocation-reported');
    }
    phase('product-disconnect');
    const after = redactConnection(expectOk(await request('/api/auth/github/connection', { method: 'DELETE' }), 'DISCONNECT_FAILED'));
    report.connectionAfterDisconnect = after; report.lifecycle.productDisconnect = after.connected ? 'FAIL' : 'PASS'; save();
    assert.equal(after.connected, false, 'DISCONNECT_LEFT_CONNECTION'); check('product-disconnect-clears-connection');
    phase('final-normal-exit'); await close();
    report.status = 'PASS'; phase('complete');
  } catch (error) {
    failure = error; report.status = 'FAIL'; report.failure = String(error?.message ?? error).slice(0, 120); save();
  } finally {
    try { await close(); } catch { /* recorded by closeOwnedApplication */ }
    plan.assertIdentity(); report.originalProfileAccessed = false; save();
    announce({ status: report.status, lifecycle: report.lifecycle, failure: report.failure ?? null });
  }
  if (failure) process.exitCode = 1;
}

module.exports = { argumentsFor, redactConnection };
if (require.main === module) main().catch(error => { console.error(String(error?.message ?? error)); process.exitCode = 1; });
