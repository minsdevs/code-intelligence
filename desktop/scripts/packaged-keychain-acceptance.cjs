'use strict';

// Developer-only: launch a retained bundle directly, then attach to its renderer.
// No Electron loader, mock keychain, profile copy, key extraction or package edits.
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
const { expectedServices } = require('../../validation/pre-release/adapter-mode.cjs');

const hash = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const contained = (root, target) => target.startsWith(root + path.sep);

function launchEnvironment(input) {
  // Only the product's ordinary locale/home variables survive. In particular no
  // Electron/Node/DYLD/provider hooks or debug flags can be inherited.
  return { ...inheritedEnvironment(input), PATH: '/usr/bin:/bin:/usr/sbin:/sbin', LANG: 'C', LC_ALL: 'C' };
}

function launchArguments(claimFile, port) {
  assert.ok(path.isAbsolute(claimFile) && !/[\r\n\0]/.test(claimFile));
  assert.ok(Number.isSafeInteger(port) && port > 1024 && port < 65536);
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
    return await Promise.race([Promise.resolve().then(action), new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(code)), timeout);
    })]);
  } finally { clearTimeout(timer); }
}

async function waitFor(action, timeout, code) {
  const expires = performance.now() + timeout;
  while (performance.now() < expires) {
    if (await bounded(action, Math.max(1, expires - performance.now()), code)) return;
    await delay(Math.max(0, Math.min(200, expires - performance.now())));
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

function allProcessesExitedZero(launches, cleanup) {
  return launches.length > 0 && cleanup.length === launches.length && launches.every(launch => {
    const records = cleanup.filter(record => record.launch === launch.sequence && record.pid === launch.pid);
    return records.length === 1 && records[0].processExitedZero === true;
  });
}

async function main(argv = process.argv.slice(2)) {
  assert.equal(process.platform, 'darwin'); assert.equal(process.arch, 'arm64');
  assert.ok(process.getuid() > 0);
  assert.ok(argv.length === 2 && argv[0] === '--app', 'Use --app with a retained Validation bundle');
  process.umask(0o077);
  const root = fs.realpathSync(path.resolve(__dirname, '../..'));
  const app = fs.realpathSync(argv[1]);
  assert.ok(contained(root, app) && /^\.native-product-[A-Za-z0-9]+$/.test(path.basename(path.dirname(app))));
  assert.equal(path.basename(app), 'Code Intelligence Validation.app');
  const executable = path.join(app, 'Contents/MacOS/Code Intelligence Validation');
  const appArchive = path.join(app, 'Contents/Resources/app.asar');
  const appArchiveSha256 = hash(fs.readFileSync(appArchive)), executableSha256 = hash(fs.readFileSync(executable));
  const runtime = path.join(app, 'Contents/Resources/runtime');
  const manifestFile = path.join(runtime, 'runtime-manifest.json');
  const manifestBytes = fs.readFileSync(manifestFile);
  const manifest = JSON.parse(manifestBytes);
  await validateRuntimeManifest(runtime, manifest);
  execFileSync('/usr/bin/codesign', ['--verify', '--strict', '--deep', app], { timeout: 30000, stdio: 'pipe' });
  const api = createRequire(path.join(root, 'frontend/package.json'));
  const { chromium } = api('playwright');
  const { expect } = api('@playwright/test');
  const evidenceParent = path.join(root, 'validation/local/packaged-keychain');
  fs.mkdirSync(evidenceParent, { recursive: true, mode: 0o700 });
  const evidence = fs.mkdtempSync(path.join(evidenceParent, 'run-'));
  const shortParent = fs.mkdtempSync('/private/tmp/cikr-');
  const plan = prepareIsolatedRun({ parentDirectory: shortParent, runtimeDirectory: runtime, purpose: 'automation',
    forbiddenRoots: [path.join(os.homedir(), 'Library/Application Support/Code Intelligence'),
      path.join(os.homedir(), 'Library/Application Support/Code Intelligence Validation')] });
  const fixture = path.join(shortParent, 'keychain-fixture'); fs.mkdirSync(fixture, { mode: 0o700 });
  const content = 'export function persistedWithRealKeychain(): number { return 73; }\n';
  fs.writeFileSync(path.join(fixture, 'keychain.ts'), content, { flag: 'wx', mode: 0o600 });
  const report = { format: 1, status: 'RUNNING', scope: 'retained-packaged-app-real-keychain',
    appBundle: app, packagedManifestSha256: hash(manifestBytes), driverSha256: hash(fs.readFileSync(__filename)),
    appArchiveSha256, executableSha256,
    appRebuilt: false, mockKeychain: false, electronLoaderInjected: false,
    keychainIdentity: plan.appIdentity.name, profile: plan.paths.userData, claim: plan.claimFile,
    realAccountVerified: false, originalProfileAccessed: false, signedInstallation: false,
    phase: 'prepared', checks: [], launches: [], cleanup: [] };
  const save = () => fs.writeFileSync(path.join(evidence, 'result.json'), JSON.stringify(report, null, 2) + '\n', { mode: 0o600 });
  const phase = value => { report.phase = value; save(); };
  const check = value => { report.checks.push(value); save(); };
  const environment = launchEnvironment(process.env);
  let child, browser, page, stopObservation, projectId, snapshotId, originalUser, encryptedDigest;
  let failure, closePromise;
  const deadline = createDeadline();
  const perform = (action, timeout = 30000, code = 'PACKAGED_KEYCHAIN_OPERATION_TIMEOUT') => deadline.run(action, timeout, code);
  const alive = () => child && child.exitCode === null && child.signalCode === null;

  async function request(route) {
    return perform(() => page.evaluate(async route => {
      const desktop = window.codeIntelligenceDesktop;
      const response = await fetch(desktop.apiBaseUrl + route, { credentials: 'include', signal: AbortSignal.timeout(15000),
        headers: { 'X-Code-Intelligence-Token': desktop.apiToken } });
      if (!response.ok) throw new Error('OWNED_API_FAILED');
      return response.json();
    }, route), 20000, 'OWNED_API_TIMEOUT');
  }
  async function launch() {
    assert.ok(!child, 'PREVIOUS_PACKAGE_NOT_CLOSED');
    plan.assertIdentity();
    const port = await perform(unusedPort, 5000, 'DEBUG_PORT_TIMEOUT'), started = Date.now();
    const args = launchArguments(plan.claimFile, port);
    phase('direct-package-start'); delete report.startup; delete report.launchError;
    child = spawn(executable, args, { cwd: root, env: environment, stdio: ['ignore', 'ignore', 'pipe'] });
    closePromise = null;
    const launched = child;
    const launchRecord = { sequence: report.launches.length + 1, pid: child.pid ?? null,
      readyMs: null, directPackage: true, mockKeychain: false };
    report.launches.push(launchRecord); save();
    child.on('error', () => {
      report.launchError = launched.pid ? 'PACKAGE_PROCESS_ERROR' : 'PACKAGE_SPAWN_FAILED';
      launchRecord.error = report.launchError; save();
    });
    stopObservation = observeStartup(child, report, save);
    await perform(() => waitFor(async () => {
      assert.ok(!report.launchError, report.launchError);
      assert.ok(alive(), 'PACKAGE_EXITED_BEFORE_READY');
      assert.notEqual(report.startup?.state, 'FAILED', 'PACKAGE_STARTUP_FAILED');
      return report.startup?.phase === 'READY';
    }, 90000, 'PACKAGE_READY_TIMEOUT'), 90000, 'PACKAGE_READY_TIMEOUT');
    phase('verify-owned-debug-listener');
    const listener = execFileSync('/usr/sbin/lsof', ['-nP', '-a', '-p', String(child.pid), '-iTCP:' + port, '-sTCP:LISTEN', '-Fn'],
      { encoding: 'utf8', timeout: 5000 });
    assert.ok(listener.split('\n').includes('n127.0.0.1:' + port), 'Owned loopback debugging listener required');
    phase('attach-existing-renderer');
    // connectOverCDP attaches only; unlike _electron.launch it cannot append
    // --use-mock-keychain or load Playwright's Electron main-process script.
    browser = await perform(() => chromium.connectOverCDP('http://127.0.0.1:' + port,
      { timeout: deadline.limit(15000) }), 16000, 'PACKAGE_CDP_ATTACH_TIMEOUT');
    phase('locate-owned-product-window');
    const pages = browser.contexts().flatMap(context => context.pages());
    report.productWindows = pages.length; save();
    assert.equal(pages.length, 1, 'Exactly one owned product window required'); page = pages[0];
    page.setDefaultTimeout(30000);
    await perform(() => expect(page.getByRole('link', { name: 'Code Intelligence home' })).toBeVisible());
    const status = await perform(() => page.evaluate(() => window.codeIntelligenceDesktop.runtimeStatus()));
    assert.equal(status.ready, true); assert.equal(status.recoveryOnly, false); assert.equal(status.error, null);
    assert.equal(status.aiOff, true);
    assert.deepEqual([...status.services].sort(), expectedServices(app));
    const command = execFileSync('/bin/ps', ['-p', String(child.pid), '-o', 'command='], { encoding: 'utf8', timeout: 5000 });
    assert.ok(command.includes(executable) && command.includes('--isolated-run-claim=' + plan.claimFile));
    assert.doesNotMatch(command, /--use-mock-keychain|--password-store=basic|--require|--inspect-brk/);
    launchRecord.readyMs = Date.now() - started;
    check('direct-packaged-real-keychain-services-ready');
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
      record.launch = launchRecord.sequence;
      report.cleanup.push(record);
      stopObservation?.(); stopObservation = null;
      browser = null; page = null;
      if (record.terminationConfirmed || !Number.isSafeInteger(owned.pid)) child = null;
      save();
      if (!record.processExitedZero || record.errors.length || record.signalsRequested.length)
        throw new Error(record.errors[0] || 'PACKAGE_CLEANUP_FAILED');
    })();
    return closePromise;
  }
  async function source() {
    await perform(() => page.evaluate(({ projectId, snapshotId }) => {
      history.pushState(null, '', `/projects/${projectId}/code?snapshotId=${snapshotId}&sourceContext=snapshot`);
      dispatchEvent(new PopStateEvent('popstate'));
    }, { projectId, snapshotId }));
    await perform(() => expect(page.getByRole('combobox', { name: 'Source snapshot' })).toHaveValue(String(snapshotId)));
    await perform(() => page.getByRole('treeitem', { name: 'keychain.ts', exact: true }).click());
    await perform(() => expect(page.getByTestId('code-viewer').locator('.view-lines')).toHaveText(content.trimEnd()));
    await perform(() => expect(page.getByTestId('source-context')).toContainText('Snapshot #' + snapshotId));
    await perform(() => expect(page.getByTestId('code-viewer').locator('.monaco-editor').first())
      .toHaveAttribute('data-uri', new RegExp('^snapshot://' + projectId + '/' + snapshotId + '/')));
  }
  save(); console.log(JSON.stringify({ status: 'RUNNING', evidence, profile: plan.paths.userData, appRebuilt: false }));
  try {
    await launch(); phase('fresh-owned-profile');
    assert.deepEqual(await request('/api/projects'), []);
    originalUser = await request('/api/auth/me');
    assert.equal(originalUser.authenticated, true); assert.equal(originalUser.credentialKind, 'LOCAL');
    assert.equal(typeof originalUser.login, 'string');
    const cipher = path.join(plan.paths.userData, 'secrets.enc');
    const stat = fs.lstatSync(cipher); assert.ok(stat.isFile() && !stat.isSymbolicLink() && stat.nlink === 1);
    assert.equal(stat.mode & 0o777, 0o600); encryptedDigest = hash(fs.readFileSync(cipher));
    // Only the ciphertext of this newly created fixture is hashed. No keys or
    // credential contents are exported or directly decrypted by the driver.
    phase('ui-owned-folder-import');
    await perform(() => page.evaluate(() => { history.pushState(null, '', '/import'); dispatchEvent(new PopStateEvent('popstate')); }));
    const picker = page.getByRole('button', { name: 'Choose folder', exact: true }); await perform(() => expect(picker).toBeVisible());
    const box = await perform(() => picker.boundingBox()); assert.ok(box);
    const cdp = await perform(() => page.context().newCDPSession(page));
    try {
      for (const type of ['dragEnter', 'dragOver', 'drop']) await perform(() => cdp.send('Input.dispatchDragEvent', {
        type, x: box.x + box.width / 2, y: box.y + box.height / 2,
        data: { items: [], files: [fixture], dragOperationsMask: 1 } }));
    } finally { await bounded(() => cdp.detach(), 5000, 'PACKAGE_CDP_DETACH_TIMEOUT'); }
    await perform(() => page.getByRole('button', { name: '가져올 파일 미리보기', exact: true }).click());
    await perform(() => expect(page.getByRole('region', { name: '확인할 가져오기 미리보기', exact: true })).toBeVisible());
    const [response] = await perform(() => Promise.all([
      page.waitForResponse(r => new URL(r.url()).pathname === '/api/projects/local' && r.request().method() === 'POST'),
      page.getByRole('button', { name: '확인한 파일 가져오기 및 분석', exact: true }).click(),
    ]));
    assert.ok(response.ok()); const created = await perform(() => response.json(), 20000, 'OWNED_IMPORT_RESPONSE_TIMEOUT'); projectId = created.project.id;
    await perform(() => waitFor(async () => {
      const job = await request('/api/jobs/' + created.jobId);
      assert.ok(!['FAILED', 'CANCELLED'].includes(job.status)); return job.status === 'DONE';
    }, 90000, 'OWNED_IMPORT_TIMEOUT'), 90000, 'OWNED_IMPORT_TIMEOUT');
    snapshotId = (await request('/api/projects/' + projectId)).currentSnapshot.id;
    await source(); check('native-folder-grant-import-and-encrypted-source-readable');
    phase('first-normal-exit'); await close();
    assert.equal(hash(fs.readFileSync(cipher)), encryptedDigest);
    phase('same-profile-real-keychain-restart'); await launch();
    const current = await request('/api/auth/me');
    assert.equal(current.authenticated, true); assert.equal(current.credentialKind, 'LOCAL');
    assert.equal(current.login, originalUser.login);
    assert.equal(hash(fs.readFileSync(cipher)), encryptedDigest, 'Persistent credentials must not be replaced');
    assert.equal((await request('/api/projects/' + projectId)).currentSnapshot.id, snapshotId);
    await source(); check('same-ciphertext-owner-database-and-source-survive-real-keychain-restart');
    await perform(() => page.screenshot({ path: path.join(evidence, 'restarted-fixture.png') }));
    phase('final-normal-exit'); await close();
    assert.equal(hash(fs.readFileSync(manifestFile)), report.packagedManifestSha256);
    assert.equal(hash(fs.readFileSync(appArchive)), report.appArchiveSha256, 'Retained app archive must not change');
    assert.equal(hash(fs.readFileSync(executable)), report.executableSha256, 'Retained executable must not change');
    assert.equal(report.launches.length, 2); assert.ok(allProcessesExitedZero(report.launches, report.cleanup));
    report.bundleFingerprintsUnchanged = true;
    report.projectId = projectId; report.snapshotId = snapshotId; report.credentialCiphertextUnchanged = true;
    report.status = 'PASS'; phase('complete');
  } catch (error) {
    failure = error; report.status = 'FAIL';
    report.failure = { phase: report.phase, code: /^[A-Z][A-Z0-9_]+$/.test(error.message) ? error.message : 'PACKAGED_KEYCHAIN_CHECK_FAILED',
      errorType: error.name, assertion: /^[A-Za-z0-9 .:_-]{1,160}$/.test(error.message) ? error.message : null,
      protocolMethod: /Protocol error \(([A-Za-z.]+)\)/.exec(error.message)?.[1] ?? null };
    save();
  } finally {
    if (child) {
      try { await close(); } catch {
        report.status = 'FAIL'; failure ||= new Error('PACKAGE_CLEANUP_FAILED');
      }
    }
    save();
  }
  console.log(JSON.stringify({ status: report.status, phase: report.phase, checks: report.checks.length,
    launches: report.launches.length, evidence, processExitedZero: allProcessesExitedZero(report.launches, report.cleanup), appRebuilt: false }));
  if (failure) process.exitCode = 1;
}

module.exports = { launchEnvironment, launchArguments, bounded, waitFor, closePackagedApplication, allProcessesExitedZero, main };
if (require.main === module) main().catch(error => { console.error(error.code || 'PACKAGED_KEYCHAIN_PREFLIGHT_FAILED'); process.exitCode = 1; });
