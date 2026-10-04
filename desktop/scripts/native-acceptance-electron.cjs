'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { createRequire } = require('node:module');

async function runProduct({ source, owned, artifacts, report, env, phase }) {
  // Keep direct callers subject to the same hosted-only safety boundary as main.
  require('./native-acceptance.cjs').requireHosted(env);
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
  assert.equal(fs.existsSync(expectedUserData), false, 'A fresh hosted application profile is required');
  const synthetic = path.join(owned, 'native-synthetic-project');
  fs.mkdirSync(synthetic, { mode: 0o700 });
  const sourceFile = path.join(synthetic, 'acceptance.ts');
  const first = 'export function acceptanceValue(): number { return 41; }\n';
  const second = 'export function acceptanceValue(): number { return 42; }\n';
  fs.writeFileSync(sourceFile, first, { flag: 'wx', mode: 0o600 });
  const secret = crypto.randomBytes(32).toString('hex');
  const cipherPath = path.join(owned, 'safestorage-probe.enc');
  let app, page, userData, projectId, snapshotId;
  let pageErrors = 0;
  const launch = async () => {
    // Playwright enables its process-local inspector; no shipping flags or startup hooks change.
    app = await electron.launch({ executablePath, args: [desktop], cwd: desktop, env, timeout: 180000 });
    page = await app.firstWindow({ timeout: 180000 });
    page.setDefaultTimeout(30000);
    page.on('pageerror', () => pageErrors++);
    userData = await app.evaluate(({ app }) => app.getPath('userData'));
    assert.equal(userData, expectedUserData);
    report.electronVersion = await app.evaluate(() => process.versions.electron);
    await expect(page.getByRole('link', { name: 'Code Intelligence home' })).toBeVisible({ timeout: 60000 });
    const appVersion = await page.evaluate(() => window.codeIntelligenceDesktop.appVersion);
    assert.equal(appVersion, desktopPackage.version, 'Renderer app version must come from the real desktop config IPC');
    report.appVersion = appVersion; report.checks.push('native-app-version-ipc');
    const status = await page.evaluate(() => window.codeIntelligenceDesktop.runtimeStatus());
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
  const close = async () => { if (app) { const current = app; app = null; await current.close(); } };
  const api = async (route, method = 'GET', body) => {
    const result = await page.evaluate(async ({ route, method, body }) => {
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
    }, { route, method, body });
    assert.ok(result.status >= 200 && result.status < 300, 'Real application API request failed');
    return result.body;
  };
  const navigate = route => page.evaluate(route => {
    history.pushState(null, '', route); window.dispatchEvent(new PopStateEvent('popstate'));
  }, route);
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
    await page.getByRole('treeitem', { name: 'acceptance.ts', exact: true }).click();
    await expect(page.getByTestId('code-viewer').locator('.view-lines')).toHaveText(expected.trimEnd());
    await expect(page.getByTestId('source-context')).toContainText(`Snapshot #${snapshot}`);
    const model = page.getByTestId('code-viewer').locator('.monaco-editor').first();
    await expect(model).toHaveAttribute('data-uri', new RegExp(`^snapshot://${projectId}/${snapshot}/`));
  };
  const captureSizes = async label => {
    // Capture the actual Electron native window content, not a browser replay/mock.
    // Captures are only taken on project metadata pages, never source/secret/settings views.
    const window = await app.browserWindow(page);
    for (const [width, height] of [[980, 700], [1280, 800], [1440, 900]]) {
      await window.evaluate((win, size) => { win.setContentSize(size.width, size.height); win.show(); }, { width, height });
      await expect.poll(() => page.evaluate(() => [innerWidth, innerHeight])).toEqual([width, height]);
      await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false, 'Horizontal overflow');
      const image = await window.evaluate(async win => (await win.capturePage()).toPNG({ scaleFactor: 1 }).toString('base64'));
      fs.writeFileSync(path.join(artifacts, `${label}-${width}x${height}.png`), Buffer.from(image, 'base64'), { flag: 'wx', mode: 0o600 });
    }
    await window.dispose();
    report.checks.push(`${label}-three-native-window-sizes`);
  };
  try {
    phase('real-app-first-start'); await launch();
    const cipher = await app.evaluate(({ safeStorage }, secret) => {
      if (!safeStorage.isEncryptionAvailable()) throw new Error('NATIVE_SAFE_STORAGE_UNAVAILABLE');
      return safeStorage.encryptString(secret).toString('base64');
    }, secret);
    assert.ok(Buffer.from(cipher, 'base64').length > 32);
    fs.writeFileSync(cipherPath, Buffer.from(cipher, 'base64'), { flag: 'wx', mode: 0o600 });
    report.checks.push('native-safeStorage-encrypt');
    await captureSizes('first-start');
    phase('synthetic-local-import');
    assert.deepEqual(await api('/api/projects'), []);
    await navigate('/import');
    const picker = page.getByRole('button', { name: 'Choose folder', exact: true });
    await expect(picker).toBeVisible();
    const bounds = await picker.boundingBox(); assert.ok(bounds);
    const cdp = await page.context().newCDPSession(page);
    try {
      // Chromium supplies the real on-disk File via its native drag protocol.
      // The unmodified UI calls preload -> folder:authorize -> the real folder policy.
      const data = { items: [], files: [synthetic], dragOperationsMask: 1 };
      for (const type of ['dragEnter', 'dragOver', 'drop']) await cdp.send('Input.dispatchDragEvent', {
        type, x: bounds.x + bounds.width / 2, y: bounds.y + bounds.height / 2, data
      });
    } finally { await cdp.detach(); }
    await page.getByRole('button', { name: '가져올 파일 미리보기', exact: true }).click();
    await expect(page.getByRole('region', { name: '확인할 가져오기 미리보기', exact: true })).toBeVisible();
    const createdResponse = page.waitForResponse(response => new URL(response.url()).pathname === '/api/projects/local' && response.request().method() === 'POST');
    await page.getByRole('button', { name: '확인한 파일 가져오기 및 분석', exact: true }).click();
    const created = await createdResponse; assert.ok(created.ok());
    const result = await created.json(); projectId = result.project.id;
    await awaitJob(result.jobId);
    const project = await api(`/api/projects/${projectId}`); snapshotId = project.currentSnapshot.id;
    await sourceContent(first, snapshotId);
    report.checks.push('real-folder-grant-preview-import-analysis-source-navigation');
    await navigate('/projects'); await expect(page.getByRole('link', { name: 'Code Intelligence home' })).toBeVisible();
    await expect(page.getByText('native-synthetic-project', { exact: true }).first()).toBeVisible();
    await captureSizes('project-list');
    phase('real-app-restart'); await close(); await launch();
    const decryptedMatches = await app.evaluate(({ safeStorage }, { bytes, expected }) => {
      if (!safeStorage.isEncryptionAvailable()) throw new Error('NATIVE_SAFE_STORAGE_UNAVAILABLE');
      // Serialized evaluate callbacks have no CommonJS module-local require binding.
      return safeStorage.decryptString(Buffer.from(bytes, 'base64')) === expected;
    }, { bytes: fs.readFileSync(cipherPath).toString('base64'), expected: secret });
    assert.equal(decryptedMatches, true);
    assert.equal((await api(`/api/projects/${projectId}`)).currentSnapshot.id, snapshotId);
    await sourceContent(first, snapshotId);
    report.checks.push('native-safeStorage-decrypt-after-process-restart', 'real-database-and-encrypted-source-persistence');
    phase('synthetic-reanalysis'); fs.writeFileSync(sourceFile, second, { mode: 0o600 });
    await page.getByRole('button', { name: '상태 새로고침', exact: true }).click();
    await page.getByRole('button', { name: '변경 사항 미리보기', exact: true }).click();
    await expect(page.getByRole('region', { name: '확인할 가져오기 미리보기', exact: true })).toBeVisible();
    const refreshedResponse = page.waitForResponse(response => new URL(response.url()).pathname === `/api/projects/${projectId}/reanalyze` && response.request().method() === 'POST');
    await page.getByRole('button', { name: '변경 확인 후 전체 재분석', exact: true }).click();
    const refreshed = await refreshedResponse; assert.ok(refreshed.ok());
    await awaitJob((await refreshed.json()).jobId);
    const nextSnapshot = (await api(`/api/projects/${projectId}`)).currentSnapshot.id;
    assert.notEqual(nextSnapshot, snapshotId);
    await sourceContent(second, nextSnapshot);
    report.checks.push('real-preview-approved-reanalysis-source-navigation');
    phase('synthetic-delete'); await api(`/api/projects/${projectId}`, 'DELETE');
    assert.deepEqual(await api('/api/projects'), []);
    await navigate('/projects');
    await expect(page.getByText('native-synthetic-project', { exact: true })).toHaveCount(0);
    await captureSizes('after-delete');
    report.checks.push('synthetic-project-delete');
    phase('final-process-restart'); await close(); await launch();
    assert.deepEqual(await api('/api/projects'), []);
    report.checks.push('deleted-project-stays-deleted-after-restart');
    assert.equal(pageErrors, 0, 'Renderer errors occurred');
    phase('native-clean-shutdown'); await close(); report.checks.push('native-clean-shutdown');
  } finally { await close(); }
}
module.exports = { runProduct };
