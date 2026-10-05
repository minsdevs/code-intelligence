'use strict';

// Opt-in packaged integration. All data and cryptographic fixture material belong to
// the fresh claim created here; no existing profile is an input. Playwright's Electron
// loader uses a mock Keychain, so this is not a new real-Keychain or release proof.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const { createRequire } = require('node:module');
const { execFileSync } = require('node:child_process');
const { prepareIsolatedRun } = require('../../desktop/src/isolated-run.cjs');
const { launchEnvironment } = require('../../desktop/scripts/packaged-keychain-acceptance.cjs');
const { createDeadline, closeOwnedApplication, observeStartup } = require('../../desktop/scripts/native-acceptance-electron.cjs');
const { validateRuntimeManifest } = require('../../desktop/src/runtime-manifest.cjs');
const { bounded } = require('../../desktop/scripts/packaged-keychain-acceptance.cjs');
const sha = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const digest = file => sha(fs.readFileSync(file));

async function main(argv) {
  assert.equal(process.platform, 'darwin'); assert.equal(process.arch, 'arm64');
  assert.equal(argv.length, 2); assert.equal(argv[0], '--app'); process.umask(0o077);
  const deadline = createDeadline(), perform = (fn, ms = 30000) => deadline.run(fn, ms);
  const root = path.resolve(__dirname, '../..'), bundle = fs.realpathSync(argv[1]);
  assert.equal(path.basename(bundle), 'Code Intelligence Validation.app');
  assert.equal(path.dirname(path.dirname(bundle)), root);
  assert.match(path.basename(path.dirname(bundle)), /^\.native-product-[A-Za-z0-9]+$/);
  const runtime = path.join(bundle, 'Contents/Resources/runtime'), manifestFile = path.join(runtime, 'runtime-manifest.json');
  const manifest = JSON.parse(fs.readFileSync(manifestFile)); await perform(() => validateRuntimeManifest(runtime, manifest), 120000);
  execFileSync('/usr/bin/codesign', ['--verify', '--deep', '--strict', bundle], { timeout: 30000, stdio: 'pipe' });
  const requireFrontend = createRequire(path.join(root, 'frontend/package.json'));
  const { _electron } = requireFrontend('playwright'), { expect } = requireFrontend('@playwright/test');
  const short = fs.mkdtempSync('/private/tmp/cirp-');
  const plan = prepareIsolatedRun({ parentDirectory: short, runtimeDirectory: runtime, purpose: 'automation',
    forbiddenRoots: ['Code Intelligence', 'Code Intelligence Validation'].map(n => path.join(os.homedir(), 'Library/Application Support', n)) });
  const fixture = path.join(short, 'preflight-fixture'), output = path.join(short, 'output');
  for (const p of [fixture, output]) fs.mkdirSync(p, { mode: 0o700 });
  const sourceText = 'export function preflightKeepsSource(): number { return 91; }\n';
  fs.writeFileSync(path.join(fixture, 'preflight.ts'), sourceText, { flag: 'wx', mode: 0o600 });
  const parent = path.join(root, 'validation/local/restore-preflight'); fs.mkdirSync(parent, { recursive: true, mode: 0o700 });
  const evidence = fs.mkdtempSync(path.join(parent, 'native-'));
  const report = { format: 1, status: 'RUNNING', scope: 'packaged-backup-compatibility-preflight', bundle,
    claim: plan.claimFile, profile: plan.paths.userData, evidence, mockKeychain: true, realAccount: false,
    nativePickerInteraction: false, incompatibleFixture: 'authenticated synthetic catalog mismatch; no old physical database',
    appAsarSha256: digest(path.join(bundle, 'Contents/Resources/app.asar')), manifestSha256: digest(manifestFile),
    driverSha256: digest(__filename), checks: [], exits: [] };
  const save = () => fs.writeFileSync(path.join(evidence, 'result.json'), JSON.stringify(report, null, 2) + '\n', { mode: 0o600 });
  const phase = name => { report.phase = name; save(); };
  const check = name => { report.checks.push(name); save(); };
  let app, page, stopObserving, projectId, snapshotId;
  async function launch() {
    phase('launch'); plan.assertIdentity();
    // The SDK's deadline-bound launch retains ownership of failed-launch cleanup.
    app = await _electron.launch({ executablePath: path.join(bundle, 'Contents/MacOS/Code Intelligence Validation'),
      // Set the synthetic Keychain switch at process creation, not only later in
      // Playwright's loader. This driver never accepts an existing/user claim.
      args: ['--use-mock-keychain', '--isolated-run-claim=' + plan.claimFile], env: launchEnvironment(process.env), cwd: root, timeout: deadline.limit(90000) });
    stopObserving = observeStartup(app.process(), report, save);
    page = await perform(() => app.firstWindow({ timeout: deadline.limit(90000) }), 90000); page.setDefaultTimeout(30000);
    assert.equal(await perform(() => app.evaluate(({ app }) => app.getPath('userData'))), plan.paths.userData);
    await perform(() => expect(page.getByRole('link', { name: 'Code Intelligence home' })).toBeVisible());
    await healthy();
  }
  async function close() {
    if (!app) return; const owned = app, child = owned.process();
    const record = { pid: child.pid };
    try { await closeOwnedApplication(owned); }
    catch (error) { record.failure = /^[A-Z_]+$/.test(error.message) ? error.message : error.name; throw error; }
    finally { record.code = child.exitCode; record.signal = child.signalCode;
      if (child.exitCode !== null || child.signalCode !== null) app = null;
      report.exits.push(record); stopObserving?.(); save(); }
  }
  async function healthy() {
    const s = await perform(() => page.evaluate(() => window.codeIntelligenceDesktop.runtimeStatus()));
    assert.equal(s.ready, true); assert.equal(s.recoveryOnly, false); assert.equal(s.error, null);
    assert.equal(s.restoreAvailable, true); assert.equal(s.backupAvailable, true); assert.equal(s.aiOff, true);
  }
  const navigate = route => perform(() => page.evaluate(route => { history.pushState(null, '', route); dispatchEvent(new PopStateEvent('popstate')); }, route));
  const api = route => perform(() => page.evaluate(async route => {
    const d = window.codeIntelligenceDesktop;
    const response = await fetch(d.apiBaseUrl + route, { credentials: 'include', headers: { 'X-Code-Intelligence-Token': d.apiToken } });
    if (!response.ok) throw new Error('OWNED_API_FAILED'); return response.json();
  }, route));
  async function source(expected = sourceText, selectedSnapshot = snapshotId) {
    await navigate(`/projects/${projectId}/code?snapshotId=${selectedSnapshot}&sourceContext=snapshot`);
    await perform(() => expect(page.getByRole('combobox', { name: 'Source snapshot' })).toHaveValue(String(selectedSnapshot)));
    await perform(() => page.getByRole('treeitem', { name: 'preflight.ts', exact: true }).click());
    await perform(() => expect(page.getByTestId('code-viewer').locator('.view-lines')).toHaveText(expected.trimEnd()));
    await perform(() => expect(page.getByTestId('source-context')).toContainText('Snapshot #' + selectedSnapshot));
    await perform(() => expect(page.getByTestId('code-viewer').locator('.monaco-editor').first())
      .toHaveAttribute('data-uri', new RegExp('^snapshot://' + projectId + '/' + selectedSnapshot + '/')));
  }
  function ownSelection(value, directory = false) {
    assert.equal(typeof value, 'string'); assert(path.isAbsolute(value));
    const resolved = fs.realpathSync(value), stat = fs.lstatSync(value);
    assert.equal(resolved, value); assert(resolved.startsWith(short + path.sep)); assert(!stat.isSymbolicLink());
    assert.equal(stat.uid, process.getuid()); assert(directory ? stat.isDirectory() : stat.isFile() && stat.nlink === 1 && value.endsWith('.cibackup'));
    return resolved;
  }
  async function withPicker(kind, selected, action) {
    ownSelection(selected, kind === 'backup');
    const handle = await perform(() => app.evaluateHandle(({ dialog }, { kind, selected }) => {
      const original = dialog.showOpenDialog; let count = 0;
      const title = kind === 'backup' ? 'Choose where to save an encrypted backup' : 'Choose an encrypted backup from this installation';
      const choose = async (...args) => {
        if (count++ || args.at(-1).title !== title) throw new Error('PICKER_SCOPE_MISMATCH');
        return { canceled: false, filePaths: [selected] };
      };
      dialog.showOpenDialog = choose;
      return { restore() { if (dialog.showOpenDialog !== choose) throw new Error('PICKER_CHANGED'); dialog.showOpenDialog = original; return count; } };
    }, { kind, selected }));
    let failure, result;
    try { result = await perform(action, deadline.limit(540000)); } catch (error) { failure = error; }
    try { assert.equal(await bounded(() => handle.evaluate(h => h.restore()), 5000, 'PICKER_RESTORE_TIMEOUT'), 1); }
    catch (error) { failure ||= error; }
    try { await bounded(() => handle.dispose(), 5000, 'PICKER_DISPOSE_TIMEOUT'); } catch (error) { failure ||= error; }
    if (failure) throw failure; return result;
  }
  function protectedState() {
    const result = {};
    function visit(directory) { for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const file = path.join(directory, entry.name); assert(!entry.isSymbolicLink());
      if (entry.isDirectory()) visit(file); else { assert(entry.isFile()); result[path.relative(plan.paths.userData, file)] = digest(file); }
    } }
    for (const name of ['safety', 'backup-maintenance']) visit(path.join(plan.paths.userData, name));
    return result;
  }
  save(); console.log(JSON.stringify({ status: 'RUNNING', evidence, profile: plan.paths.userData }));
  try {
    await launch(); phase('import-owned-fixture'); await navigate('/import');
    const picker = page.getByRole('button', { name: 'Choose folder', exact: true });
    await perform(() => expect(picker).toBeVisible()); const box = await perform(() => picker.boundingBox()); assert(box);
    const cdp = await perform(() => page.context().newCDPSession(page)); let dragFailure;
    try { for (const type of ['dragEnter', 'dragOver', 'drop']) await perform(() => cdp.send('Input.dispatchDragEvent', {
      type, x: box.x + box.width / 2, y: box.y + box.height / 2, data: { items: [], files: [fixture], dragOperationsMask: 1 } })); }
    catch (error) { dragFailure = error; throw error; }
    finally { try { await bounded(() => cdp.detach(), 5000, 'DRAG_DETACH_TIMEOUT'); } catch (error) { if (!dragFailure) throw error; } }
    await perform(() => page.getByRole('button', { name: '가져올 파일 미리보기', exact: true }).click());
    const [created] = await perform(() => Promise.all([
      page.waitForResponse(r => new URL(r.url()).pathname === '/api/projects/local' && r.request().method() === 'POST'),
      page.getByRole('button', { name: '확인한 파일 가져오기 및 분석', exact: true }).click()]));
    assert(created.ok()); projectId = (await perform(() => created.json())).project.id;
    await perform(() => expect.poll(async () => (await api('/api/projects/' + projectId)).currentSnapshot?.status, { timeout: 90000 }).toBe('READY'), 90000);
    snapshotId = (await api('/api/projects/' + projectId)).currentSnapshot.id; await source();
    phase('create-valid-backup'); await navigate('/settings');
    const selected = await withPicker('backup', output, async () => {
      await perform(() => page.getByRole('button', { name: /^(Create backup|백업 생성)$/ }).click());
      const value = page.locator('dd').filter({ hasText: /\.cibackup$/ });
      await perform(() => expect(value).toHaveCount(1, { timeout: 120000 }), 120000); return ownSelection((await perform(() => value.textContent())).trim());
    });
    await healthy(); const selectedHash = digest(selected), beforeFixture = protectedState(); check('real-ui-backup-created');
    phase('create-owned-incompatible-fixture');
    // Only fixture construction reads this new claim's wrapped backup material inside
    // the application's main process. No key crosses evaluate/IPC or reaches a log.
    const incompatible = await perform(() => app.evaluate(async ({ app, safeStorage }, { profile, short, selected, build }) => {
      const builtin = name => process.getBuiltinModule(name), fs = builtin('fs'), path = builtin('path'), crypto = builtin('crypto');
      const assert = builtin('assert/strict'), req = builtin('module').createRequire(path.join(app.getAppPath(), 'package.json'));
      assert.equal(app.getPath('userData'), profile); assert(profile.startsWith(short + '/desktop-run-')); assert(selected.startsWith(short + '/output/'));
      const wrappedFile = path.join(profile, 'safety/purpose-keyring/purpose-keyring.wrapped');
      const wrapper = req('./src/safety-lifecycle.cjs').createSafeStorageWrapper(safeStorage, { electronApp: app });
      assert.equal(fs.realpathSync(wrappedFile), wrappedFile);
      let plain, material, wrapped;
      try {
        const fd = fs.openSync(wrappedFile, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
        try { const stat = fs.fstatSync(fd); assert(stat.isFile() && stat.nlink === 1 && stat.size > 0 && stat.size <= 65536);
          assert.equal(stat.uid, process.getuid()); assert.equal(stat.mode & 0o777, 0o600); wrapped = fs.readFileSync(fd); }
        finally { fs.closeSync(fd); }
        plain = wrapper.unwrap(wrapped); const keyring = JSON.parse(plain.toString('utf8')); plain.fill(0);
        const group = keyring.purposes.find(p => p.purpose === 'backup'); material = Buffer.from(group.keys.find(k => k.keyId === group.activeKeyId).material, 'base64');
        const keyProvider = { currentKeyId: async () => group.activeKeyId, getBackupKey: async id => { assert.equal(id, group.activeKeyId); return Buffer.from(material); } };
        const decoded = path.join(short, 'decoded'), altered = path.join(short, 'altered');
        for (const p of [decoded, altered]) fs.mkdirSync(p, { mode: 0o700 });
        const archive = req('./src/backup-archive.cjs'), payload = req('./src/backup-payload.cjs');
        await archive.decryptFile({ sourceRoot: path.dirname(selected), sourcePath: selected, destinationRoot: decoded,
          destinationPath: path.join(decoded, 'payload.bin'), installationId: keyring.installationId, keyProvider });
        const writer = await payload.createBackupPayload({ root: altered, installationId: keyring.installationId, minimumVersion: build });
        try {
          for await (const record of payload.readBackupPayload({ root: decoded, installationId: keyring.installationId, runningBuild: build })) {
            if (record.kind === 'ROW') await writer.writeRow(record.row);
            else if (record.kind === 'DATABASE') await writer.writeDatabase({ ...record.summary,
              catalogSha256: crypto.createHash('sha256').update('synthetic incompatible catalog').digest('hex') });
            else if (!['HEADER', 'FOOTER'].includes(record.kind)) await writer.writeSource(record);
          }
          await writer.finish();
        } finally { await writer.close(); }
        const destinationPath = path.join(short, 'incompatible.cibackup');
        await archive.encryptFile({ sourceRoot: altered, sourcePath: path.join(altered, 'payload.bin'), destinationRoot: short,
          destinationPath, installationId: keyring.installationId, keyProvider });
        return destinationPath;
      } finally { plain?.fill(0); material?.fill(0); wrapped?.fill(0); }
    }, { profile: plan.paths.userData, short, selected, build: manifest.buildSequence }), 120000);
    ownSelection(incompatible); const mismatchHash = digest(incompatible), before = protectedState();
    assert.deepEqual(before, beforeFixture);
    const beforeProjects = await api('/api/projects'), token = await perform(() => page.evaluate(() => window.codeIntelligenceDesktop.apiToken));
    phase('ui-incompatible-refusal');
    await withPicker('restore', incompatible, async () => {
      phase('open-restore-confirmation');
      await perform(() => page.getByRole('button', { name: /^(Restore backup|백업 복원)$/ }).click());
      phase('confirm-incompatible-restore');
      await perform(() => page.getByRole('alert').getByRole('button', { name: /^(Confirm restore|복원 확인)$/ }).click());
      phase('incompatible-notice');
      await perform(() => expect(page.getByRole('alert').filter({ hasText: /incompatible|호환되지 않는/ })).toBeVisible({ timeout: 30000 }));
    });
    await healthy(); assert.deepEqual(protectedState(), before); assert.deepEqual(await api('/api/projects'), beforeProjects);
    assert.equal(await perform(() => page.evaluate(() => window.codeIntelligenceDesktop.apiToken)), token);
    assert.equal(digest(incompatible), mismatchHash); assert.equal(digest(selected), selectedHash);
    await perform(() => page.screenshot({ path: path.join(evidence, 'incompatible-refused.png') }));
    check('authenticated-mismatch-refused-without-ledger-record-authority-or-data-changes'); await source();
    phase('create-post-backup-state');
    const nextText = sourceText.replace('return 91', 'return 92');
    fs.writeFileSync(path.join(fixture, 'preflight.ts'), nextText, { mode: 0o600 });
    await perform(() => page.getByRole('button', { name: '상태 새로고침', exact: true }).click());
    await perform(() => page.getByRole('button', { name: '변경 사항 미리보기', exact: true }).click());
    await perform(() => expect(page.getByRole('region', { name: '확인할 가져오기 미리보기', exact: true })).toBeVisible());
    const [updated] = await perform(() => Promise.all([
      page.waitForResponse(r => new URL(r.url()).pathname === `/api/projects/${projectId}/reanalyze` && r.request().method() === 'POST'),
      page.getByRole('button', { name: '변경 확인 후 전체 재분석', exact: true }).click()]));
    assert(updated.ok()); const nextJob = (await perform(() => updated.json())).jobId;
    await perform(() => expect.poll(async () => (await api('/api/jobs/' + nextJob)).status, { timeout: 90000 }).toBe('DONE'), 90000);
    const nextSnapshot = (await api('/api/projects/' + projectId)).currentSnapshot.id;
    assert.notEqual(nextSnapshot, snapshotId); await source(nextText, nextSnapshot);
    report.snapshots = { backup: snapshotId, beforeRestore: nextSnapshot }; save();
    phase('valid-restore-after-refusal'); await navigate('/settings');
    await withPicker('restore', selected, async () => {
      await perform(() => page.getByRole('button', { name: /^(Restore backup|백업 복원)$/ }).click());
      await perform(() => Promise.all([page.waitForEvent('domcontentloaded', { timeout: 120000 }),
        page.getByRole('alert').getByRole('button', { name: /^(Confirm restore|복원 확인)$/ }).click()]), 120000);
      await perform(() => expect(page.getByRole('link', { name: 'Code Intelligence home' })).toBeVisible());
    });
    await healthy(); assert.equal((await api('/api/projects/' + projectId)).currentSnapshot.id, snapshotId);
    await source(); check('subsequent-compatible-backup-replaces-newer-db-and-source-with-backup-state');
    phase('restart-after-restore'); await close(); await launch();
    assert.equal((await api('/api/projects/' + projectId)).currentSnapshot.id, snapshotId); await source(); await healthy();
    check('restored-source-and-normal-service-state-survive-restart'); await close();
    assert.equal(digest(path.join(bundle, 'Contents/Resources/app.asar')), report.appAsarSha256);
    assert.equal(digest(manifestFile), report.manifestSha256); report.status = 'PASS'; phase('complete');
  } catch (error) { report.status = 'FAIL'; report.failure = { phase: report.phase, code: error.code || error.name,
    message: typeof error.message === 'string' && /^[A-Za-z0-9 .:_-]{1,160}$/.test(error.message) ? error.message : null };
    try { if (page && !page.isClosed()) {
      await bounded(() => page.screenshot({ path: path.join(evidence, 'failure.png') }), 5000, 'FAILURE_CAPTURE_TIMEOUT');
      report.failure.runtime = await bounded(() => page.evaluate(async () => { const s = await window.codeIntelligenceDesktop.runtimeStatus();
        return { ready: s.ready, recoveryOnly: s.recoveryOnly, backupAvailable: s.backupAvailable, restoreAvailable: s.restoreAvailable }; }), 5000, 'FAILURE_STATUS_TIMEOUT');
    } } catch { report.failure.captureUnavailable = true; }
    save(); }
  finally { try { await close(); } catch { report.status = 'FAIL'; report.cleanupFailed = true; } save(); }
  console.log(JSON.stringify({ status: report.status, phase: report.phase, checks: report.checks.length, evidence }));
  if (report.status !== 'PASS') process.exitCode = 1;
}
if (require.main === module) main(process.argv.slice(2)).catch(e => { console.error(e.code || e.name); process.exitCode = 1; });
