'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { createRequire } = require('node:module');
const { parseStartupLine } = require('../src/startup-diagnostics.cjs');

function bounded(operation, timeoutMs, code) {
  let timer;
  return Promise.race([operation, new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(code)), timeoutMs);
  })]).finally(() => clearTimeout(timer));
}
async function closeOwnedApplication(current, { timeoutMs = 30000, killGraceMs = 5000 } = {}) {
  const child = current.process();
  let onExit;
  const exited = new Promise(resolve => {
    onExit = resolve; child.once('exit', onExit);
    if (child.exitCode !== null || child.signalCode !== null) resolve();
  });
  try {
    await bounded(current.close(), timeoutMs, 'NATIVE_ELECTRON_CLOSE_TIMEOUT');
    await bounded(exited, killGraceMs, 'NATIVE_ELECTRON_EXIT_TIMEOUT');
    if (child.exitCode !== 0 || child.signalCode !== null) throw new Error('NATIVE_ELECTRON_UNCLEAN_EXIT');
  } catch (error) {
    // Only the SDK-owned ChildProcess may be signalled. On Windows this can be
    // its launcher, so forced cleanup never establishes a clean product exit.
    for (const signal of ['SIGTERM', 'SIGKILL']) {
      if (child.exitCode !== null || child.signalCode !== null) break;
      try { child.kill(signal); } catch { /* A failed signal is not exit proof. */ }
      try { await bounded(exited, killGraceMs, 'NATIVE_ELECTRON_EXIT_TIMEOUT'); } catch { /* Escalate only this owned child. */ }
    }
    throw error;
  } finally { child.removeListener('exit', onExit); }
}

function createDeadline(timeoutMs = 540000, now = () => performance.now()) {
  assert.ok(Number.isSafeInteger(timeoutMs) && timeoutMs > 0 && timeoutMs <= 540000);
  const expires = now() + timeoutMs;
  let failure;
  const limit = (maximum = 30000) => {
    if (failure) throw failure;
    const remaining = Math.floor(expires - now());
    if (remaining <= 0) throw new Error('NATIVE_PRODUCT_DEADLINE');
    return Math.min(maximum, remaining);
  };
  return { limit, async run(action, maximum = 30000, code = 'NATIVE_ELECTRON_OPERATION_TIMEOUT') {
    const duration = limit(maximum);
    try {
      return await bounded(Promise.resolve().then(() => { limit(maximum); return action(); }), duration,
        duration < maximum ? 'NATIVE_PRODUCT_DEADLINE' : code);
    } catch (error) { failure = error; throw error; }
  } };
}

function observeStartup(child, report, save) {
  let line = '', dropping = false;
  const data = bytes => {
    for (const character of bytes.toString('utf8')) {
      if (character === '\n') {
        const value = dropping ? null : parseStartupLine(line.replace(/\r$/, ''));
        if (value && report.startup?.state !== 'FAILED') { report.startup = value; save(); }
        line = ''; dropping = false;
      } else if (!dropping) {
        if (line.length === 256) { line = ''; dropping = true; } else line += character;
      }
    }
  };
  child.stderr.on('data', data);
  return () => child.stderr.off('data', data);
}
async function verifyRevokedAuthority({ dataRoot, apiBaseUrl, apiToken, oldToken, cookie }) {
  assert.ok(apiToken !== oldToken, 'Restore must rotate API authority');
  const directories = fs.readdirSync(dataRoot).filter(name => /^transport-[A-Za-z0-9]+$/.test(name));
  assert.equal(directories.length, 1, 'Exactly one owned transport is required');
  const directory = path.join(dataRoot, directories[0]);
  const pem = fs.readFileSync(path.join(directory, 'backend.crt'));
  const caPem = fs.readFileSync(path.join(directory, 'backend.ca.crt'));
  const pin = crypto.createHash('sha256').update(new crypto.X509Certificate(pem).raw).digest('hex');
  const { createPinnedClient } = require('../src/service-transport.cjs');
  const client = createPinnedClient({ caPem, pin }, Number(new URL(apiBaseUrl).port));
  try {
    const request = token => client.request(apiBaseUrl + '/api/projects', {
      headers: { Origin: apiBaseUrl, Cookie: cookie, 'X-Code-Intelligence-Token': token },
    });
    assert.equal((await request(apiToken)).status, 200, 'Current API authority must succeed');
    const rejected = await request(oldToken);
    assert.ok([401, 403].includes(rejected.status), 'Pre-restore API authority must be refused');
  } finally { await client.close(); }
}

async function runProduct({ source, owned, artifacts, report, env, phase }) {
  // Direct callers must prove the same execution boundary before loading Electron.
  const { recordFailure } = require('./native-acceptance.cjs');
  const { requireExecutionContext, productPaths, claimExecution } = require('./native-acceptance-context.cjs');
  const context = requireExecutionContext(env);
  productPaths(context, { source, owned, artifacts });
  claimExecution(context, 'product');
  report.executionContext = context.evidence;
  const deadline = createDeadline();
  const perform = (action, timeoutMs, code) => deadline.run(action, timeoutMs, code);
  report.executionLimitMs = 600000;
  const executionStarted = performance.now();
  const frontendRequire = createRequire(path.join(source, 'frontend', 'package.json'));
  const { _electron: electron } = frontendRequire('playwright');
  const { expect } = frontendRequire('@playwright/test');
  const desktop = path.join(source, 'desktop');
  const packaged = typeof report.appBundle === 'string';
  const executablePath = packaged
    ? path.join(report.appBundle, 'Contents', 'MacOS', 'Code Intelligence Validation')
    : createRequire(path.join(desktop, 'package.json'))('electron');
  const runtimeDirectory = packaged ? path.join(report.appBundle, 'Contents', 'Resources', 'runtime')
    : path.join(desktop, 'stage', 'runtime');
  const desktopPackage = JSON.parse(fs.readFileSync(path.join(desktop, 'package.json'), 'utf8'));
  const packageName = desktopPackage.name;
  let validationPlan;
  if (context.kind === 'isolated-macos-host') {
    const runs = context.isolatedRunParent;
    const applicationSupport = path.join(os.homedir(), 'Library', 'Application Support');
    validationPlan = require(path.join(desktop, 'src', 'isolated-run.cjs')).prepareIsolatedRun({
      parentDirectory: runs, runtimeDirectory, purpose: 'automation',
      forbiddenRoots: [path.join(applicationSupport, packageName), path.join(applicationSupport, desktopPackage.build.productName)],
    });
    report.validationIdentity = validationPlan.appIdentity;
    report.validationProfile = validationPlan.paths.userData;
  }
  if (process.platform === 'win32') assert.ok(path.isAbsolute(env.APPDATA || ''), 'Fresh Windows application profile required');
  const expectedUserData = validationPlan ? validationPlan.paths.userData
    : process.platform === 'win32' ? path.join(env.APPDATA, packageName)
      : path.join(os.homedir(), 'Library', 'Application Support', packageName);
  if (validationPlan) assert.deepEqual(fs.readdirSync(expectedUserData), [], 'Fresh validation profile required');
  else assert.equal(fs.existsSync(expectedUserData), false, 'A fresh disposable application profile is required');
  const launchArguments = packaged ? [] : [desktop];
  // This product runner always creates a fresh synthetic automation profile.
  // Apply its mock Keychain mode at spawn, not only later in the SDK loader.
  launchArguments.push('--use-mock-keychain');
  if (validationPlan) launchArguments.push('--isolated-run-claim=' + validationPlan.claimFile);
  if (validationPlan) report.validationClaim = validationPlan.claimFile;
  const synthetic = path.join(owned, 'native-synthetic-project');
  fs.mkdirSync(synthetic, { mode: 0o700 });
  const sourceFile = path.join(synthetic, 'acceptance.ts');
  const first = 'export function acceptanceValue(): number { return 41; }\n';
  const second = 'export function acceptanceValue(): number { return 42; }\n';
  fs.writeFileSync(sourceFile, first, { flag: 'wx', mode: 0o600 });
  const secret = crypto.randomBytes(32).toString('hex');
  const cipherPath = path.join(owned, 'safestorage-probe.enc');
  let app, ownedApplication, page, userData, projectId, snapshotId, stopObserving;
  let pageErrors = 0;
  const step = (name, action, timeoutMs = 30000) => {
    phase(name);
    return perform(action, timeoutMs);
  };
  const launch = async () => {
    // Playwright enables its process-local inspector; no shipping flags or startup hooks change.
    const launchStarted = performance.now();
    const startupEnds = launchStarted + 90000;
    phase('electron-launch');
    app = await electron.launch({ executablePath, args: launchArguments, cwd: desktop, env, timeout: deadline.limit(90000) });
    const launched = app, ownedChild = app.process();
    ownedApplication = { process: () => ownedChild,
      close: () => ownedChild.exitCode !== null || ownedChild.signalCode !== null ? Promise.resolve() : launched.close() };
    delete report.startup;
    stopObserving = observeStartup(ownedChild, report, () => phase(report.phase));
    phase('electron-first-window');
    const remaining = Math.floor(startupEnds - performance.now());
    if (remaining <= 0) throw new Error('NATIVE_STARTUP_TIMEOUT');
    page = await app.firstWindow({ timeout: deadline.limit(remaining) });
    page.setDefaultTimeout(30000);
    page.on('pageerror', () => pageErrors++);
    userData = await step('native-profile-path', () => app.evaluate(({ app }) => app.getPath('userData')));
    assert.equal(userData, expectedUserData);
    report.electronVersion = await step('native-electron-version', () => app.evaluate(() => process.versions.electron));
    phase('native-home-visible');
    await perform(() => expect(page.getByRole('link', { name: 'Code Intelligence home' })).toBeVisible({ timeout: deadline.limit(30000) }));
    const appVersion = await step('native-app-version-ipc', () => page.evaluate(() => window.codeIntelligenceDesktop.appVersion));
    assert.equal(appVersion, desktopPackage.version, 'Renderer app version must come from the real desktop config IPC');
    report.appVersion = appVersion; report.checks.push('native-app-version-ipc');
    const isPackaged = await step('native-packaged-identity', () => app.evaluate(({ app }) => app.isPackaged));
    assert.equal(isPackaged, packaged, 'Acceptance must launch the claimed application bundle');
    report.packagedLaunch = isPackaged;
    report.launchToHomeMs ??= [];
    report.launchToHomeMs.push(Math.round(performance.now() - launchStarted));
    const status = await step('native-runtime-status', () => page.evaluate(() => window.codeIntelligenceDesktop.runtimeStatus()));
    assert.equal(status.ready, true); assert.equal(status.recoveryOnly, false); assert.equal(status.error, null);
    assert.equal(status.aiOff, true, 'Provider egress must remain disabled for synthetic acceptance');
    assert.deepEqual([...status.services].sort(), ['backend', 'postgres', 'redis', 'ts-analyzer']);
    const productDataRoot = process.platform === 'win32' ? path.join(userData, 'private') : userData;
    const dataState = fs.lstatSync(productDataRoot);
    assert.ok(dataState.isDirectory() && !dataState.isSymbolicLink(), 'Real product private-data directory required');
    report.productDataRoot = productDataRoot;
    if (process.platform === 'win32') report.checks.push('windows-profile-private-data-separation');
    report.checks.push('native-services-ready');
  };
  const close = async () => {
    if (!app) return;
    const current = ownedApplication; app = null; ownedApplication = null;
    phase('native-clean-shutdown');
    try { await closeOwnedApplication(current); }
    finally { stopObserving?.(); stopObserving = null; }
  };
  const api = async (route, method = 'GET', body) => {
    const result = await perform(() => page.evaluate(async ({ route, method, body }) => {
      const desktop = window.codeIntelligenceDesktop;
      const headers = { 'X-Code-Intelligence-Token': desktop.apiToken };
      if (method !== 'GET') {
        const prime = await fetch(desktop.apiBaseUrl + '/api/csrf', { credentials: 'include', headers });
        if (!prime.ok) return { status: prime.status };
        const cookie = document.cookie.split(';').map(part => part.trim()).find(part => part.startsWith('XSRF-TOKEN='));
        if (cookie) headers['X-XSRF-TOKEN'] = decodeURIComponent(cookie.slice('XSRF-TOKEN='.length));
      }
      if (body !== undefined) headers['Content-Type'] = 'application/json';
      const response = await fetch(desktop.apiBaseUrl + route, { method, credentials: 'include', headers,
        body: body === undefined ? undefined : JSON.stringify(body) });
      const text = await response.text();
      return { status: response.status, body: response.ok && text ? JSON.parse(text) : null };
    }, { route, method, body }), 30000, 'NATIVE_API_TIMEOUT');
    assert.ok(result.status >= 200 && result.status < 300, 'Real application API request failed');
    return result.body;
  };
  const navigate = route => perform(() => page.evaluate(route => {
    history.pushState(null, '', route); window.dispatchEvent(new PopStateEvent('popstate'));
  }, route), 30000, 'NATIVE_RENDERER_TIMEOUT');
  const awaitJob = async id => {
    assert.ok(Number.isSafeInteger(id) && id > 0);
    const deadline = Date.now() + 180000;
    while (Date.now() < deadline) {
      const job = await api(`/api/jobs/${id}`);
      if (job.status === 'DONE') return;
      assert.ok(!['FAILED', 'CANCELLED'].includes(job.status), 'Real analysis did not complete');
      await new Promise(resolve => setTimeout(resolve, 500));
    }
    throw new Error('NATIVE_ANALYSIS_TIMEOUT');
  };
  const verifySnapshotContract = async (snapshot, label) => {
    const files = await api(`/api/projects/${projectId}/files?snapshotId=${snapshot}`);
    const coverage = await api(`/api/projects/${projectId}/coverage?snapshotId=${snapshot}`);
    assert.equal(coverage.snapshotId, snapshot);
    assert.equal(coverage.measurementStatus, 'PER_FILE_RECORDED');
    assert.equal(coverage.supportStatus, 'UNVERIFIED');
    assert.ok(coverage.outcomes && files.every(file => file.resolvedSnapshotId === snapshot));
    const counts = files.reduce((result, file) => {
      const status = file.analysisStatus ?? 'LEGACY_UNMEASURED'; result[status] = (result[status] ?? 0) + 1; return result;
    }, {});
    for (const [counter, status] of Object.entries({ successfulFiles: 'SUCCESS', partialFiles: 'PARTIAL',
      failedFiles: 'FAILED', unsupportedFiles: 'UNSUPPORTED', pendingFiles: 'TARGETED' })) {
      assert.equal(coverage.outcomes[counter], counts[status] ?? 0, 'Coverage must count persisted file results');
    }
    assert.equal(coverage.outcomes.unmeasuredFiles, (counts.UNMEASURED ?? 0) + (counts.LEGACY_UNMEASURED ?? 0));
    assert.equal(coverage.outcomes.targetedFiles, files.filter(file => file.analysisTargeted).length);
    assert.ok(coverage.outcomes.discoveredFiles >= files.length);
    const graph = await api(`/api/projects/${projectId}/graph/overview?snapshotId=${snapshot}`);
    assert.equal(graph.resolvedSnapshotId, snapshot);
    const categories = {};
    for (const category of ['symbols', 'entrypoints', 'dependencies']) {
      const first = await api(`/api/projects/${projectId}/graph/nodes?snapshotId=${snapshot}&category=${category}&page=1&size=2&sort=path`);
      assert.equal(first.resolvedSnapshotId, snapshot); assert.equal(first.page, 1); assert.ok(first.items.length <= 2);
      categories[category] = first.total;
      if (first.total > 2) {
        const next = await api(`/api/projects/${projectId}/graph/nodes?snapshotId=${snapshot}&category=${category}&page=2&size=2&sort=path`);
        assert.equal(next.resolvedSnapshotId, snapshot); assert.equal(next.page, 2);
        assert.ok(next.items.length > 0 && next.items.every(item => !first.items.some(previous => previous.id === item.id)));
      }
    }
    report.snapshotContracts ??= [];
    report.snapshotContracts.push({ label, snapshotId: snapshot, inventoryFiles: files.length,
      fileStatuses: counts, outcomes: coverage.outcomes, graphCategories: categories });
    return files;
  };
  const sourceContent = async (expected, snapshot) => {
    report.sourceVerification = { snapshotId: snapshot, step: 'select-snapshot' };
    await navigate(`/projects/${projectId}/code`);
    // Navigation and the local-job cache refresh settle independently. Select
    // the requested historical/current result through the UI before a file click
    // can pin the previously rendered snapshot in the URL.
    await perform(() => page.getByRole('combobox', { name: 'Source snapshot', exact: true }).selectOption(String(snapshot)));
    report.sourceVerification.step = 'open-file';
    await perform(() => page.getByRole('treeitem', { name: 'acceptance.ts', exact: true }).click());
    report.sourceVerification.step = 'rendered-content';
    await perform(() => expect(page.getByTestId('code-viewer').locator('.view-lines')).toHaveText(expected.trimEnd()));
    report.sourceVerification.step = 'snapshot-context';
    await perform(() => expect(page.getByTestId('source-context')).toContainText('Snapshot #' + snapshot));
    const model = page.getByTestId('code-viewer').locator('.monaco-editor').first();
    report.sourceVerification.step = 'model-uri';
    await perform(() => expect(model).toHaveAttribute('data-uri', new RegExp('^snapshot://' + projectId + '/' + snapshot + '/')));
    report.sourceVerification.step = 'verified';
  };
  const captureSizes = async label => {
    // Capture the actual Electron native window content, not a browser replay/mock.
    // Captures are only taken on project metadata pages, never source/secret/settings views.
    const window = await step('native-window-handle', () => app.browserWindow(page));
    for (const [width, height] of [[980, 700], [1280, 800], [1440, 900]]) {
      await step('native-' + label + '-size-' + width + 'x' + height,
        () => window.evaluate((win, size) => { win.setContentSize(size.width, size.height); win.show(); }, { width, height }));
      await perform(() => expect.poll(() => perform(() => page.evaluate(() => [innerWidth, innerHeight]))).toEqual([width, height]));
      await step('native-window-paint', () => page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))));
      assert.equal(await perform(() => page.evaluate(() => document.documentElement.scrollWidth > innerWidth)), false, 'Horizontal overflow');
      const image = await step('native-window-capture', () => window.evaluate(async win => (await win.capturePage()).toPNG({ scaleFactor: 1 }).toString('base64')));
      fs.writeFileSync(path.join(artifacts, `${label}-${width}x${height}.png`), Buffer.from(image, 'base64'), { flag: 'wx', mode: 0o600 });
    }
    await perform(() => window.dispose(), 30000, 'NATIVE_WINDOW_DISPOSE_TIMEOUT');
    report.checks.push(`${label}-three-native-window-sizes`);
  };
  const selectedArchive = (file, roots, directory = false) => {
    assert.ok(path.isAbsolute(file), 'Native backup selection must be absolute');
    const actual = fs.realpathSync(file), stat = fs.lstatSync(file);
    assert.equal(stat.isSymbolicLink(), false);
    assert.ok(directory ? stat.isDirectory() : stat.isFile() && stat.nlink === 1 && file.endsWith('.cibackup'));
    assert.ok(roots.some(root => {
      const relative = path.relative(fs.realpathSync(root), actual);
      return relative !== '' && relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative);
    }), 'Native backup selection must belong to this disposable run');
    return actual;
  };
  const withArchivePicker = async (kind, file, action) => {
    const selected = selectedArchive(file, kind === 'backup' ? [owned] : [owned, report.productDataRoot], kind === 'backup');
    // Only the OS picker result is controlled. UI confirmation, trusted IPC,
    // quiescence, PostgreSQL, encrypted source vault and archive IO remain real.
    const picker = await perform(() => app.evaluateHandle(({ dialog }, { kind, selected }) => {
      const original = dialog.showOpenDialog;
      const title = kind === 'backup' ? 'Choose where to save an encrypted backup' : 'Choose an encrypted backup from this installation';
      const property = kind === 'backup' ? 'openDirectory' : 'openFile';
      let calls = 0;
      const choose = async (...args) => {
        const options = args.at(-1);
        if (calls || options?.title !== title || options.properties?.length !== 1 || options.properties[0] !== property
          || (kind === 'restore' && (options.filters?.length !== 1 || options.filters[0].extensions?.length !== 1
            || options.filters[0].extensions[0] !== 'cibackup'))) throw new Error('NATIVE_ARCHIVE_PICKER_REFUSED');
        calls++;
        return { canceled: false, filePaths: [selected] };
      };
      dialog.showOpenDialog = choose;
      return { restore() {
        if (dialog.showOpenDialog !== choose) throw new Error('NATIVE_ARCHIVE_PICKER_REPLACED');
        dialog.showOpenDialog = original;
        return calls;
      } };
    }, { kind, selected }));
    let failure, result;
    try { result = await action(); } catch (error) { failure = error; }
    try { assert.equal(await bounded(picker.evaluate(value => value.restore()), 5000, 'NATIVE_PICKER_CLOSE_TIMEOUT'), 1); }
    catch (error) { failure ||= error; }
    try { await bounded(picker.dispose(), 5000, 'NATIVE_PICKER_CLOSE_TIMEOUT'); } catch (error) { failure ||= error; }
    if (failure) throw failure;
    return result;
  };
  const readyAfterMaintenance = async () => {
    const status = await perform(() => page.evaluate(() => window.codeIntelligenceDesktop.runtimeStatus()));
    assert.equal(status.ready, true); assert.equal(status.error, null); assert.equal(status.recoveryOnly, false);
    assert.equal(status.aiOff, true); assert.equal(status.backupAvailable, true); assert.equal(status.restoreAvailable, true);
    assert.deepEqual([...status.services].sort(), ['backend', 'postgres', 'redis', 'ts-analyzer']);
  };
  const restoreArchive = async (file, expectedSource, expectedSnapshot) => {
    const recovery = path.join(report.productDataRoot, 'recovery');
    const before = new Set(fs.readdirSync(recovery));
    const oldToken = await perform(() => page.evaluate(() => window.codeIntelligenceDesktop.apiToken));
    await navigate('/settings');
    await withArchivePicker('restore', file, async () => {
      await perform(() => page.getByRole('button', { name: /^(Restore backup|백업 복원)$/ }).click());
      const confirm = page.getByRole('alert').getByRole('button', { name: /^(Confirm restore|복원 확인)$/ });
      // Production resume rotates credentials and reloads the renderer before
      // replying to the old IPC caller. Observe that real navigation, not a
      // substituted restore return value or the now-destroyed JS context.
      await perform(() => Promise.all([
        page.waitForEvent('domcontentloaded', { timeout: deadline.limit(120000) }),
        confirm.click(),
      ]), 120000, 'NATIVE_RESTORE_TIMEOUT');
      await perform(() => expect(page.getByRole('link', { name: 'Code Intelligence home' })).toBeVisible());
      await readyAfterMaintenance();
    });
    // Renderer requests are re-authorized by main's onBeforeSendHeaders hook.
    // Probe stale authority outside Chromium, using the real per-service CA and leaf pin.
    const config = await perform(() => page.evaluate(() => {
      const { apiBaseUrl, apiToken } = window.codeIntelligenceDesktop;
      return { apiBaseUrl, apiToken };
    }));
    const cookies = await perform(() => page.context().cookies(config.apiBaseUrl));
    await perform(() => verifyRevokedAuthority({ dataRoot: report.productDataRoot, ...config, oldToken,
      cookie: cookies.map(value => value.name + '=' + value.value).join('; ') }));
    assert.equal((await api('/api/projects/' + projectId)).currentSnapshot.id, expectedSnapshot);
    await sourceContent(expectedSource, expectedSnapshot);
    const created = fs.readdirSync(recovery).filter(name => !before.has(name));
    assert.equal(created.length, 1, 'Restore must retain its pre-replacement recovery checkpoint');
    return selectedArchive(path.join(recovery, created[0], 'checkpoint.cibackup'), [recovery]);
  };
  const importFolder = async folder => {
    await navigate('/import');
    const picker = page.getByRole('button', { name: 'Choose folder', exact: true });
    await perform(() => expect(picker).toBeVisible());
    const bounds = await perform(() => picker.boundingBox()); assert.ok(bounds);
    const cdp = await perform(() => page.context().newCDPSession(page));
    let dragFailure;
    try {
      // Chromium supplies the real on-disk File via its native drag protocol.
      // The unmodified UI calls preload -> folder:authorize -> the real folder policy.
      const data = { items: [], files: [folder], dragOperationsMask: 1 };
      for (const type of ['dragEnter', 'dragOver', 'drop']) await perform(() => cdp.send('Input.dispatchDragEvent', {
        type, x: bounds.x + bounds.width / 2, y: bounds.y + bounds.height / 2, data
      }));
    } catch (error) { dragFailure = error; throw error; }
    finally {
      try { await bounded(cdp.detach(), 5000, 'NATIVE_CDP_CLOSE_TIMEOUT'); }
      catch (error) { if (!dragFailure) throw error; }
    }
    const [previewResponse] = await perform(() => Promise.all([
      page.waitForResponse(response => new URL(response.url()).pathname === '/api/projects/local/preview' && response.request().method() === 'POST', { timeout: deadline.limit() }),
      page.getByRole('button', { name: '가져올 파일 미리보기', exact: true }).click(),
    ]));
    assert.ok(previewResponse.ok());
    const preview = await perform(() => previewResponse.json());
    await perform(() => expect(page.getByRole('region', { name: '확인할 가져오기 미리보기', exact: true })).toBeVisible());
    const firstResultStarted = performance.now();
    const [created] = await perform(() => Promise.all([
      page.waitForResponse(response => new URL(response.url()).pathname === '/api/projects/local' && response.request().method() === 'POST', { timeout: deadline.limit() }),
      page.getByRole('button', { name: '확인한 파일 가져오기 및 분석', exact: true }).click(),
    ]));
    assert.ok(created.ok());
    return { result: await perform(() => created.json()), firstResultStarted, localImport: preview.localImport };
  };
  let failure;
  try {
    phase('real-app-first-start'); await launch();
    const cipher = await step('native-safe-storage-encrypt', () => app.evaluate(({ safeStorage }, secret) => {
      if (!safeStorage.isEncryptionAvailable()) throw new Error('NATIVE_SAFE_STORAGE_UNAVAILABLE');
      return safeStorage.encryptString(secret).toString('base64');
    }, secret), 60000);
    assert.ok(Buffer.from(cipher, 'base64').length > 32);
    fs.writeFileSync(cipherPath, Buffer.from(cipher, 'base64'), { flag: 'wx', mode: 0o600 });
    report.checks.push('electron-safeStorage-api-encrypt-under-automation');
    await captureSizes('first-start');
    phase('synthetic-local-import');
    assert.deepEqual(await api('/api/projects'), []);
    const { result, firstResultStarted, localImport } = await importFolder(synthetic);
    projectId = result.project.id;
    await awaitJob(result.jobId);
    const project = await api(`/api/projects/${projectId}`); snapshotId = project.currentSnapshot.id;
    phase('import-default-repository-overview');
    await perform(() => expect(page).toHaveURL(new RegExp('/projects/' + projectId + '/overview$')));
    await perform(() => expect(page.getByLabel('레포 개요', { exact: true })).toBeVisible());
    await perform(() => expect(page.getByRole('table', { name: '분석 결과 표', exact: true })).toBeVisible());
    report.firstResult = { scope: 'one-file TypeScript synthetic fixture; approved import click to populated native overview',
      elapsedMs: Math.round(performance.now() - firstResultStarted), snapshotId, localImport };
    await perform(() => expect(page.getByRole('link', { name: /^(Growth|Tasks)$/ })).toHaveCount(0));
    await perform(() => expect(page.getByLabel('개요 분석 시점', { exact: true })).toHaveValue('current'));
    await perform(() => page.getByRole('button', { name: '파일 · 분석 상태', exact: true }).click());
    const searchStarted = performance.now();
    await perform(() => page.getByRole('searchbox', { name: '분석 결과 검색', exact: true }).fill('acceptance.ts'));
    const table = page.getByRole('table', { name: '분석 결과 표', exact: true });
    await perform(() => expect(table.getByText('acceptance.ts', { exact: true }).first()).toBeVisible());
    report.firstResult.searchRenderMs = Math.round(performance.now() - searchStarted);
    await perform(() => table.getByRole('button', { name: '관련 심볼', exact: true }).first().click());
    await perform(() => table.getByRole('button', { name: '관계 · 함께 확인할 곳', exact: true }).first().click());
    await perform(() => expect(page.getByRole('region', { name: '선택한 코드 주변 관계', exact: true })).toBeVisible());
    await captureSizes('repository-overview');
    report.checks.push('import-default-overview-snapshot-table-filter-local-relations-without-ai');
    await verifySnapshotContract(snapshotId, 'first-import');
    await sourceContent(first, snapshotId);
    report.checks.push('real-folder-grant-preview-import-analysis-source-navigation');
    await navigate('/projects'); await perform(() => expect(page.getByRole('link', { name: 'Code Intelligence home' })).toBeVisible());
    await perform(() => expect(page.getByText('native-synthetic-project', { exact: true }).first()).toBeVisible());
    await captureSizes('project-list');
    phase('real-app-restart'); await close(); await launch();
    const decryptedMatches = await step('native-safe-storage-decrypt', () => app.evaluate(({ safeStorage }, { bytes, expected }) => {
      if (!safeStorage.isEncryptionAvailable()) throw new Error('NATIVE_SAFE_STORAGE_UNAVAILABLE');
      // Serialized evaluate callbacks have no CommonJS module-local require binding.
      return safeStorage.decryptString(Buffer.from(bytes, 'base64')) === expected;
    }, { bytes: fs.readFileSync(cipherPath).toString('base64'), expected: secret }), 60000);
    assert.equal(decryptedMatches, true);
    assert.equal((await api(`/api/projects/${projectId}`)).currentSnapshot.id, snapshotId);
    await sourceContent(first, snapshotId);
    report.checks.push('electron-safeStorage-api-decrypt-after-automation-restart', 'real-database-and-encrypted-source-persistence');
    phase('real-main-backup');
    report.backupRestore = { status: 'RUNNING', filePicker: 'controlled-single-use-selection', nativePickerInteraction: false };
    const destination = path.join(owned, 'native-backup-destination'); fs.mkdirSync(destination, { mode: 0o700 });
    await navigate('/settings');
    const backupFile = await withArchivePicker('backup', destination, async () => {
      await perform(() => page.getByRole('button', { name: /^(Create backup|백업 생성)$/ }).click());
      const result = page.locator('dd').filter({ hasText: /\.cibackup$/ });
      await perform(() => expect(result).toHaveCount(1, { timeout: deadline.limit(120000) }), 120000, 'NATIVE_BACKUP_TIMEOUT');
      await readyAfterMaintenance();
      return selectedArchive((await perform(() => result.textContent())).trim(), [destination]);
    });
    assert.equal((await api('/api/projects/' + projectId)).currentSnapshot.id, snapshotId);
    await sourceContent(first, snapshotId);
    report.checks.push('real-main-quiescent-backup-and-resume');
    phase('synthetic-reanalysis'); fs.writeFileSync(sourceFile, second, { mode: 0o600 });
    await perform(() => page.getByRole('button', { name: '상태 새로고침', exact: true }).click());
    await perform(() => page.getByRole('button', { name: '변경 사항 미리보기', exact: true }).click());
    await perform(() => expect(page.getByRole('region', { name: '확인할 가져오기 미리보기', exact: true })).toBeVisible());
    const [refreshed] = await perform(() => Promise.all([
      page.waitForResponse(response => new URL(response.url()).pathname === '/api/projects/' + projectId + '/reanalyze' && response.request().method() === 'POST', { timeout: deadline.limit() }),
      page.getByRole('button', { name: '변경 확인 후 전체 재분석', exact: true }).click(),
    ]));
    assert.ok(refreshed.ok());
    await awaitJob((await perform(() => refreshed.json())).jobId);
    const nextSnapshot = (await api(`/api/projects/${projectId}`)).currentSnapshot.id;
    assert.notEqual(nextSnapshot, snapshotId);
    await verifySnapshotContract(snapshotId, 'prior-result-after-reanalysis');
    await verifySnapshotContract(nextSnapshot, 'new-result-after-reanalysis');
    await sourceContent(second, nextSnapshot);
    report.checks.push('real-preview-approved-reanalysis-source-navigation');
    phase('real-main-restore');
    const recoveryFile = await restoreArchive(backupFile, first, snapshotId);
    report.checks.push('real-main-restore-db-source-and-revoke-old-api-authority');
    phase('real-main-recovery-checkpoint-restore');
    await restoreArchive(recoveryFile, second, nextSnapshot);
    report.checks.push('real-main-recovery-checkpoint-restores-pre-replacement-db-and-source');
    phase('post-restore-process-restart'); await close(); await launch();
    assert.equal((await api('/api/projects/' + projectId)).currentSnapshot.id, nextSnapshot);
    await sourceContent(second, nextSnapshot);
    report.checks.push('restored-db-and-encrypted-source-survive-process-restart');
    report.backupRestore.status = 'PASS';
    phase('synthetic-delete'); await api(`/api/projects/${projectId}`, 'DELETE');
    assert.deepEqual(await api('/api/projects'), []);
    await navigate('/projects');
    await perform(() => expect(page.getByText('native-synthetic-project', { exact: true })).toHaveCount(0));
    await captureSizes('after-delete');
    report.checks.push('synthetic-project-delete');
    phase('final-process-restart'); await close(); await launch();
    assert.deepEqual(await api('/api/projects'), []);
    report.checks.push('deleted-project-stays-deleted-after-restart');
    phase('representative-repository-import');
    const repositorySample = path.join(owned, 'native-repository-sample');
    const copied = require('./native-acceptance.cjs').copySource(source, repositorySample);
    const larger = await importFolder(repositorySample);
    projectId = larger.result.project.id;
    await awaitJob(larger.result.jobId);
    snapshotId = (await api(`/api/projects/${projectId}`)).currentSnapshot.id;
    await perform(() => expect(page).toHaveURL(new RegExp('/projects/' + projectId + '/overview$')));
    await perform(() => expect(page.getByRole('table', { name: '분석 결과 표', exact: true })).toBeVisible());
    report.representativeRepository = {
      scope: 'filtered current Code Intelligence desktop/frontend/backend/TypeScript analyzer source; no dependency install or repository scripts executed',
      sourceFiles: copied.files, sourceSha256: copied.sha256, localImport: larger.localImport,
      importToOverviewMs: Math.round(performance.now() - larger.firstResultStarted), projectId, snapshotId,
    };
    const files = await verifySnapshotContract(snapshotId, 'representative-repository');
    report.representativeRepository.fileOutcomes = files.reduce((counts, file) => {
      const status = file.analysisStatus ?? 'LEGACY_UNMEASURED'; counts[status] = (counts[status] ?? 0) + 1; return counts;
    }, {});
    await perform(() => page.getByRole('button', { name: '파일 · 분석 상태', exact: true }).click());
    const entrypoints = await api(`/api/projects/${projectId}/graph/nodes?snapshotId=${snapshotId}&category=entrypoints&page=1&size=2&sort=path`);
    assert.equal(entrypoints.resolvedSnapshotId, snapshotId);
    assert.ok(entrypoints.items.length > 0, 'Representative repository must have confirmed entrypoint rows');
    await perform(() => page.getByRole('button', { name: '요청 · 화면 진입점', exact: true }).click());
    await perform(() => expect(page.getByRole('table', { name: '분석 결과 표', exact: true })
      .locator('tbody tr').filter({ hasText: entrypoints.items[0].name }).first()).toBeVisible());
    report.representativeRepository.entrypointCount = entrypoints.total;
    await perform(() => page.getByRole('button', { name: '파일 · 분석 상태', exact: true }).click());
    const representativePath = 'frontend/src/features/import/ImportWizardPage.tsx';
    const searchStartedLarge = performance.now();
    await perform(() => page.getByRole('searchbox', { name: '분석 결과 검색', exact: true }).fill(representativePath));
    const largeTable = page.getByRole('table', { name: '분석 결과 표', exact: true });
    await perform(() => expect(largeTable.getByRole('link', { name: representativePath, exact: true })).toBeVisible());
    report.representativeRepository.fileSearchRenderMs = Math.round(performance.now() - searchStartedLarge);
    await perform(() => largeTable.getByRole('button', { name: '관련 심볼', exact: true }).click());
    const relationStarted = performance.now();
    await perform(() => largeTable.getByRole('button', { name: '관계 · 함께 확인할 곳', exact: true }).first().click());
    const neighborhood = page.getByRole('region', { name: '선택한 코드 주변 관계', exact: true });
    await perform(() => expect(neighborhood.getByLabel('관계 방향', { exact: true })).toBeVisible());
    await perform(() => expect(neighborhood.getByText('관계를 불러오는 중…', { exact: true })).toHaveCount(0));
    await perform(() => expect(neighborhood.getByRole('alert')).toHaveCount(0));
    report.representativeRepository.relationRenderMs = Math.round(performance.now() - relationStarted);
    await captureSizes('representative-repository');
    await perform(() => neighborhood.getByRole('link', { name: '선택한 항목의 보관된 소스', exact: true }).click());
    await perform(() => expect(page.getByTestId('source-context')).toContainText('Snapshot #' + snapshotId));
    await perform(() => expect(page.getByTestId('code-viewer').locator('.monaco-editor').first())
      .toHaveAttribute('data-uri', new RegExp('^snapshot://' + projectId + '/' + snapshotId + '/')));
    const flows = await api(`/api/projects/${projectId}/flows?snapshotId=${snapshotId}`);
    let selectedFlow;
    for (const candidate of flows.slice(0, 5)) {
      const detail = await api(`/api/projects/${projectId}/flows/${candidate.id}?snapshotId=${snapshotId}`);
      assert.equal(detail.resolvedSnapshotId, snapshotId);
      if (detail.steps.some(step => step.filePath)) { selectedFlow = detail; break; }
    }
    assert.ok(selectedFlow, 'Representative repository must have a real flow with source evidence');
    await navigate(`/projects/${projectId}/flows?snapshotId=${snapshotId}`);
    await perform(() => page.locator('ul').getByRole('button').filter({ hasText: selectedFlow.name }).first().click());
    const flowDetail = page.getByRole('article', { name: 'Flow detail', exact: true });
    await perform(() => expect(flowDetail.getByRole('heading', { name: selectedFlow.name, exact: true })).toBeVisible());
    await perform(() => flowDetail.getByRole('button').first().click());
    await perform(() => expect(page.getByTestId('source-context')).toContainText('Snapshot #' + snapshotId));
    await perform(() => expect(page.getByTestId('code-viewer').locator('.monaco-editor').first())
      .toHaveAttribute('data-uri', new RegExp('^snapshot://' + projectId + '/' + snapshotId + '/')));
    report.representativeRepository.flowEvidence = { flowCount: flows.length, selectedFlowId: selectedFlow.id,
      stepCount: selectedFlow.steps.length, sourceSnapshotId: snapshotId };
    report.checks.push('representative-repository-confirmed-entrypoints-flow-step-to-snapshot-source',
      'representative-repository-approved-import-overview-search-relations-snapshot-source');
    phase('representative-repository-restart'); await close(); await launch();
    assert.equal((await api(`/api/projects/${projectId}`)).currentSnapshot.id, snapshotId);
    await navigate(`/projects/${projectId}/overview`);
    await perform(() => expect(page.getByRole('table', { name: '분석 결과 표', exact: true })).toBeVisible());
    report.checks.push('representative-repository-results-survive-packaged-app-restart');
    assert.equal(pageErrors, 0, 'Renderer errors occurred');
    phase('native-clean-shutdown'); await close(); report.checks.push('native-clean-shutdown');
  } catch (error) {
    if (report.backupRestore?.status === 'RUNNING') report.backupRestore.status = 'FAIL';
    failure = error; recordFailure(report, error);
    phase(report.failure.phase); // Persist the primary before SDK cleanup can stall.
  } finally {
    try { await close(); }
    catch (error) {
      if (!failure) { failure = error; recordFailure(report, error); }
      else report.cleanupFailure = recordFailure({ phase: 'native-cleanup' }, error);
    }
    if (failure) phase(report.failure.phase);
    report.executionElapsedMs = Math.round(performance.now() - executionStarted);
    if (!failure && report.executionElapsedMs >= report.executionLimitMs) {
      failure = new Error('NATIVE_PRODUCT_DEADLINE'); recordFailure(report, failure);
    }
  }
  if (failure) throw failure;
}
module.exports = { runProduct, closeOwnedApplication, createDeadline, observeStartup, verifyRevokedAuthority };
