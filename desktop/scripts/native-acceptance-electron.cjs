'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { createRequire } = require('node:module');

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

function parseStartupLine(line) {
  const match = /^DESKTOP_STARTUP (MANIFEST|PROFILE|CREDENTIALS|PRIVATE_IPC|TLS|OWNER_LOCKS|SAFETY|GATEWAY|BACKUP|AUTHORIZED_ROOTS|POSTGRES|CACHE_AND_ANALYZER|BACKEND|WINDOW|READY)(?: FAILED (EACCES|ENOENT|SAFETY_RECOVERY_REQUIRED|SAFETY_STORAGE_UNAVAILABLE|SAFETY_OWNER_LOST|MAIN_STARTUP_FAILED))?$/.exec(line);
  return match ? { phase: match[1], state: match[2] ? 'FAILED' : 'RUNNING', ...(match[2] ? { code: match[2] } : {}) } : null;
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
  const executablePath = createRequire(path.join(desktop, 'package.json'))('electron');
  const desktopPackage = JSON.parse(fs.readFileSync(path.join(desktop, 'package.json'), 'utf8'));
  const packageName = desktopPackage.name;
  if (process.platform === 'win32') assert.ok(path.isAbsolute(env.APPDATA || ''), 'Fresh Windows application profile required');
  const expectedUserData = process.platform === 'win32' ? path.join(env.APPDATA, packageName)
    : path.join(os.homedir(), 'Library', 'Application Support', packageName);
  assert.equal(fs.existsSync(expectedUserData), false, 'A fresh disposable application profile is required');
  const synthetic = path.join(owned, 'native-synthetic-project');
  fs.mkdirSync(synthetic, { mode: 0o700 });
  const sourceFile = path.join(synthetic, 'acceptance.ts');
  const first = 'export function acceptanceValue(): number { return 41; }\n';
  const second = 'export function acceptanceValue(): number { return 42; }\n';
  fs.writeFileSync(sourceFile, first, { flag: 'wx', mode: 0o600 });
  const secret = crypto.randomBytes(32).toString('hex');
  const cipherPath = path.join(owned, 'safestorage-probe.enc');
  let app, page, userData, projectId, snapshotId, stopObserving;
  let pageErrors = 0;
  const step = (name, action, timeoutMs = 30000) => {
    phase(name);
    return perform(action, timeoutMs);
  };
  const launch = async () => {
    // Playwright enables its process-local inspector; no shipping flags or startup hooks change.
    const startupEnds = performance.now() + 90000;
    phase('electron-launch');
    app = await electron.launch({ executablePath, args: [desktop], cwd: desktop, env, timeout: deadline.limit(90000) });
    delete report.startup;
    stopObserving = observeStartup(app.process(), report, () => phase(report.phase));
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
    const current = app; app = null;
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
  const sourceContent = async (expected, snapshot) => {
    await navigate(`/projects/${projectId}/code`);
    await perform(() => page.getByRole('treeitem', { name: 'acceptance.ts', exact: true }).click());
    await perform(() => expect(page.getByTestId('code-viewer').locator('.view-lines')).toHaveText(expected.trimEnd()));
    await perform(() => expect(page.getByTestId('source-context')).toContainText('Snapshot #' + snapshot));
    const model = page.getByTestId('code-viewer').locator('.monaco-editor').first();
    await perform(() => expect(model).toHaveAttribute('data-uri', new RegExp('^snapshot://' + projectId + '/' + snapshot + '/')));
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
      await perform(() => expect(page.getByRole('alert')).toContainText(/Restore replaces|현재 로컬 DB와 저장소가 교체/));
      // Production resume rotates credentials and reloads the renderer before
      // replying to the old IPC caller. Observe that real navigation, not a
      // substituted restore return value or the now-destroyed JS context.
      await perform(() => Promise.all([
        page.waitForEvent('domcontentloaded', { timeout: deadline.limit(120000) }),
        page.getByRole('button', { name: /^(Confirm restore|복원 확인)$/ }).click(),
      ]), 120000, 'NATIVE_RESTORE_TIMEOUT');
      await perform(() => expect(page.getByRole('link', { name: 'Code Intelligence home' })).toBeVisible());
      await readyAfterMaintenance();
    });
    const revoked = await perform(() => page.evaluate(async oldToken => {
      const desktop = window.codeIntelligenceDesktop;
      const response = await fetch(desktop.apiBaseUrl + '/api/projects', {
        credentials: 'include', headers: { 'X-Code-Intelligence-Token': oldToken },
      });
      return { changed: desktop.apiToken !== oldToken, status: response.status };
    }, oldToken));
    assert.equal(revoked.changed, true); assert.ok([401, 403].includes(revoked.status), 'Pre-restore API authority must be refused');
    assert.equal((await api('/api/projects/' + projectId)).currentSnapshot.id, expectedSnapshot);
    await sourceContent(expectedSource, expectedSnapshot);
    const created = fs.readdirSync(recovery).filter(name => !before.has(name));
    assert.equal(created.length, 1, 'Restore must retain its pre-replacement recovery checkpoint');
    return selectedArchive(path.join(recovery, created[0], 'checkpoint.cibackup'), [recovery]);
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
    report.checks.push('native-safeStorage-encrypt');
    await captureSizes('first-start');
    phase('synthetic-local-import');
    assert.deepEqual(await api('/api/projects'), []);
    await navigate('/import');
    const picker = page.getByRole('button', { name: 'Choose folder', exact: true });
    await perform(() => expect(picker).toBeVisible());
    const bounds = await perform(() => picker.boundingBox()); assert.ok(bounds);
    const cdp = await perform(() => page.context().newCDPSession(page));
    let dragFailure;
    try {
      // Chromium supplies the real on-disk File via its native drag protocol.
      // The unmodified UI calls preload -> folder:authorize -> the real folder policy.
      const data = { items: [], files: [synthetic], dragOperationsMask: 1 };
      for (const type of ['dragEnter', 'dragOver', 'drop']) await perform(() => cdp.send('Input.dispatchDragEvent', {
        type, x: bounds.x + bounds.width / 2, y: bounds.y + bounds.height / 2, data
      }));
    } catch (error) { dragFailure = error; throw error; }
    finally {
      try { await bounded(cdp.detach(), 5000, 'NATIVE_CDP_CLOSE_TIMEOUT'); }
      catch (error) { if (!dragFailure) throw error; }
    }
    await perform(() => page.getByRole('button', { name: '가져올 파일 미리보기', exact: true }).click());
    await perform(() => expect(page.getByRole('region', { name: '확인할 가져오기 미리보기', exact: true })).toBeVisible());
    const [created] = await perform(() => Promise.all([
      page.waitForResponse(response => new URL(response.url()).pathname === '/api/projects/local' && response.request().method() === 'POST', { timeout: deadline.limit() }),
      page.getByRole('button', { name: '확인한 파일 가져오기 및 분석', exact: true }).click(),
    ]));
    assert.ok(created.ok());
    const result = await perform(() => created.json()); projectId = result.project.id;
    await awaitJob(result.jobId);
    const project = await api(`/api/projects/${projectId}`); snapshotId = project.currentSnapshot.id;
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
    report.checks.push('native-safeStorage-decrypt-after-process-restart', 'real-database-and-encrypted-source-persistence');
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
module.exports = { runProduct, closeOwnedApplication, createDeadline, observeStartup };
