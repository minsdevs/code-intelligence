'use strict';

// Opt-in native failure/restart tests. Uses one NEW profile per invocation, the
// unmodified retained bundle, real services and encrypted backups, mock Keychain.
// This is injected I/O failure, not SIGKILL, power loss, or a real-account upgrade.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const { createRequire } = require('node:module');
const { execFileSync } = require('node:child_process');
const { prepareIsolatedRun } = require('../../desktop/src/isolated-run.cjs');
const { launchEnvironment, bounded } = require('../../desktop/scripts/packaged-keychain-acceptance.cjs');
const { createDeadline, closeOwnedApplication, observeStartup } = require('../../desktop/scripts/native-acceptance-electron.cjs');
const { validateRuntimeManifest } = require('../../desktop/src/runtime-manifest.cjs');
const { installOwnedInterruption, installOwnedDialogs, captureOwnedApplication } = require('./interruption-hooks.cjs');
const sha = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const digest = file => sha(fs.readFileSync(file));

async function main(argv) {
  assert.equal(process.platform, 'darwin'); assert.equal(process.arch, 'arm64');
  assert.equal(argv.length, 4); assert.equal(argv[0], '--app'); assert.equal(argv[2], '--point');
  const point = argv[3]; assert(['AFTER_SOURCE_RENAME', 'BEFORE_COMPLETED_CLEANUP'].includes(point));
  process.umask(0o077);
  const deadline = createDeadline(), perform = (fn, ms = 30000) => deadline.run(fn, ms);
  const root = fs.realpathSync(path.resolve(__dirname, '../..')), bundle = fs.realpathSync(argv[1]);
  assert.equal(path.basename(bundle), 'Code Intelligence Validation.app');
  assert.equal(path.dirname(path.dirname(bundle)), root);
  assert.match(path.basename(path.dirname(bundle)), /^\.native-product-[A-Za-z0-9]+$/);
  const runtime = path.join(bundle, 'Contents/Resources/runtime'), manifestFile = path.join(runtime, 'runtime-manifest.json');
  const manifest = JSON.parse(fs.readFileSync(manifestFile));
  await perform(() => validateRuntimeManifest(runtime, manifest), 120000);
  execFileSync('/usr/bin/codesign', ['--verify', '--deep', '--strict', bundle], { timeout: 30000, stdio: 'pipe' });
  const requireFrontend = createRequire(path.join(root, 'frontend/package.json'));
  const { _electron } = requireFrontend('playwright'), { expect } = requireFrontend('@playwright/test');
  const parent = fs.mkdtempSync('/private/tmp/ciri-');
  const plan = prepareIsolatedRun({ parentDirectory: parent, runtimeDirectory: runtime, purpose: 'automation',
    forbiddenRoots: ['Code Intelligence', 'Code Intelligence Validation'].map(n => path.join(os.homedir(), 'Library/Application Support', n)) });
  const fixture = path.join(parent, 'fixture'), output = path.join(parent, 'output');
  for (const directory of [fixture, output]) fs.mkdirSync(directory, { mode: 0o700 });
  const oldSource = 'export function interruptedRestore(): number { return 91; }\n';
  const newSource = oldSource.replace('return 91', 'return 92');
  const inputFile = path.join(fixture, 'recovery.ts');
  fs.writeFileSync(inputFile, oldSource, { flag: 'wx', mode: 0o600 });
  const evidenceRoot = path.join(root, 'validation/local/restore-interruption');
  fs.mkdirSync(evidenceRoot, { recursive: true, mode: 0o700 });
  const evidence = fs.mkdtempSync(path.join(evidenceRoot, 'native-'));
  const report = { format: 1, status: 'RUNNING', scope: 'packaged-injected-io-failure-and-restart', point,
    bundle, evidence, claim: plan.claimFile, profile: plan.paths.userData, mockKeychain: true, realAccount: false,
    nativeDialogInteraction: false, sigkill: false, powerLoss: false, nonzeroCostObligations: false,
    appAsarSha256: digest(path.join(bundle, 'Contents/Resources/app.asar')), manifestSha256: digest(manifestFile),
    driverSha256: digest(__filename), hooksSha256: digest(path.join(__dirname, 'interruption-hooks.cjs')),
    checks: [], launches: [], exits: [], dialogEvents: [] };
  const save = () => fs.writeFileSync(path.join(evidence, 'result.json'), JSON.stringify(report, null, 2) + '\n', { mode: 0o600 });
  const phase = value => { report.phase = value; save(); };
  const check = value => { report.checks.push(value); save(); };
  let app, applicationOwner, page, stopObserving, stopDialogs, launchSequence = 0, projectId, oldSnapshot, newSnapshot;
  async function launch(recover = false) {
    phase(recover ? 'launch-restricted-recovery' : 'launch-normal'); plan.assertIdentity();
    app = await _electron.launch({ executablePath: path.join(bundle, 'Contents/MacOS/Code Intelligence Validation'),
      args: ['--isolated-run-claim=' + plan.claimFile], env: launchEnvironment(process.env), cwd: root, timeout: deadline.limit(90000) });
    applicationOwner = captureOwnedApplication(app);
    const child = applicationOwner.process(), sequence = ++launchSequence, nonce = crypto.randomBytes(16).toString('hex');
    report.launches.push({ sequence, pid: child.pid, recover }); save();
    stopObserving = observeStartup(child, report, save);
    let line = '', dropping = false;
    const listen = bytes => { for (const character of bytes.toString('utf8')) {
      if (character === '\n') {
        const prefix = 'OWNED_RECOVERY_EVENT ' + nonce + ' ';
        if (!dropping && line.startsWith(prefix)) {
          const code = line.slice(prefix.length).trim();
          if (['RECOVERY_ACCEPTED', 'SHUTDOWN_RECOVERY_REQUIRED', 'STARTUP_FAILED', 'UNEXPECTED_CONFIRMATION', 'UNEXPECTED_NATIVE_ERROR',
            'MANIFEST_INVALID', 'MANIFEST_PLATFORM', 'IO_FILE_LIMIT', 'IO_SYSTEM_FILE_LIMIT', 'STARTUP_OTHER'].includes(code)) {
            report.dialogEvents.push({ sequence, code }); save();
          }
        }
        line = ''; dropping = false;
      } else if (!dropping) { if (line.length >= 160) { dropping = true; line = ''; } else line += character; }
    } };
    child.stderr.on('data', listen); stopDialogs = () => child.stderr.off('data', listen);
    await perform(() => app.evaluate(installOwnedDialogs, { profile: plan.paths.userData, parent, nonce, recover }));
    page = await perform(() => app.firstWindow({ timeout: deadline.limit(120000) }), 120000);
    page.setDefaultTimeout(30000);
    await perform(() => expect(page.getByRole('link', { name: 'Code Intelligence home' })).toBeVisible());
    await healthy();
    assert.equal(report.dialogEvents.filter(e => e.sequence === sequence && e.code === 'RECOVERY_ACCEPTED').length, recover ? 1 : 0);
    assert.equal(report.dialogEvents.some(e => e.sequence === sequence && e.code !== 'RECOVERY_ACCEPTED'), false);
  }
  async function close() {
    if (!app) return;
    const owned = applicationOwner, child = owned.process(), sequence = launchSequence;
    const record = { sequence, pid: child.pid };
    try { await closeOwnedApplication(owned); }
    catch (error) { record.failure = /^[A-Z_]+$/.test(error.message) ? error.message : error.name; throw error; }
    finally {
      record.code = child.exitCode; record.signal = child.signalCode;
      record.processExitedZero = child.exitCode === 0 && child.signalCode === null;
      record.shutdownRecoveryNotice = report.dialogEvents.some(e => e.sequence === sequence && e.code === 'SHUTDOWN_RECOVERY_REQUIRED');
      record.cleanShutdownObserved = record.processExitedZero && !record.failure
        && !report.dialogEvents.some(e => e.sequence === sequence && e.code !== 'RECOVERY_ACCEPTED');
      if (child.exitCode !== null || child.signalCode !== null) { app = null; applicationOwner = null; }
      report.exits.push(record); stopObserving?.(); stopDialogs?.(); save();
    }
  }
  const status = () => perform(() => page.evaluate(() => window.codeIntelligenceDesktop.runtimeStatus()));
  async function healthy() {
    const value = await status();
    assert.equal(value.ready, true); assert.equal(value.recoveryOnly, false); assert.equal(value.error, null);
    assert.equal(value.backupAvailable, true); assert.equal(value.restoreAvailable, true); assert.equal(value.aiOff, true);
  }
  const navigate = route => perform(() => page.evaluate(route => { history.pushState(null, '', route); dispatchEvent(new PopStateEvent('popstate')); }, route));
  const api = route => perform(() => page.evaluate(async route => {
    const d = window.codeIntelligenceDesktop;
    const response = await fetch(d.apiBaseUrl + route, { credentials: 'include', headers: { 'X-Code-Intelligence-Token': d.apiToken } });
    if (!response.ok) throw new Error('OWNED_API_FAILED'); return response.json();
  }, route));
  async function source(text, snapshot) {
    await navigate(`/projects/${projectId}/code?snapshotId=${snapshot}&sourceContext=snapshot`);
    await perform(() => expect(page.getByRole('combobox', { name: 'Source snapshot' })).toHaveValue(String(snapshot)));
    await perform(() => page.getByRole('treeitem', { name: 'recovery.ts', exact: true }).click());
    await perform(() => expect(page.getByTestId('code-viewer').locator('.view-lines')).toHaveText(text.trimEnd()));
    await perform(() => expect(page.getByTestId('source-context')).toContainText('Snapshot #' + snapshot));
    await perform(() => expect(page.getByTestId('code-viewer').locator('.monaco-editor').first())
      .toHaveAttribute('data-uri', new RegExp('^snapshot://' + projectId + '/' + snapshot + '/')));
  }
  function ownSelection(value, directory = false) {
    assert.equal(typeof value, 'string'); assert(path.isAbsolute(value));
    assert.equal(fs.realpathSync(value), value); assert(value.startsWith(parent + path.sep));
    const stat = fs.lstatSync(value); assert.equal(stat.uid, process.getuid()); assert(!stat.isSymbolicLink());
    assert(directory ? stat.isDirectory() : stat.isFile() && stat.nlink === 1 && value.endsWith('.cibackup'));
    return value;
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
    try { result = await perform(action, deadline.limit(240000)); } catch (error) { failure = error; }
    try { assert.equal(await bounded(() => handle.evaluate(h => h.restore()), 5000, 'PICKER_RESTORE_TIMEOUT'), 1); } catch (error) { failure ||= error; }
    try { await bounded(() => handle.dispose(), 5000, 'PICKER_DISPOSE_TIMEOUT'); } catch (error) { failure ||= error; }
    if (failure) throw failure; return result;
  }
  const keyFile = path.join(plan.paths.userData, 'safety/purpose-keyring/purpose-keyring.wrapped');
  const journalFile = path.join(plan.paths.userData, 'safety/ai-journal/events.log');
  function journalPrefix() { plan.assertIdentity(); const bytes = fs.readFileSync(journalFile); return { bytes: bytes.length, sha256: sha(bytes) }; }
  function assertPrefix(expected) {
    const bytes = fs.readFileSync(journalFile); assert(bytes.length >= expected.bytes);
    assert.equal(sha(bytes.subarray(0, expected.bytes)), expected.sha256);
  }
  save(); console.log(JSON.stringify({ status: 'RUNNING', evidence, profile: plan.paths.userData, point }));
  try {
    await launch(); phase('import-fixture'); await navigate('/import');
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
    oldSnapshot = (await api('/api/projects/' + projectId)).currentSnapshot.id; await source(oldSource, oldSnapshot);
    phase('create-backup'); await navigate('/settings');
    const selected = await withPicker('backup', output, async () => {
      await perform(() => page.getByRole('button', { name: /^(Create backup|백업 생성)$/ }).click());
      const value = page.locator('dd').filter({ hasText: /\.cibackup$/ });
      await perform(() => expect(value).toHaveCount(1, { timeout: 120000 }), 120000);
      return ownSelection((await perform(() => value.textContent())).trim());
    });
    await healthy(); const selectedHash = digest(selected), keyHash = digest(keyFile), baselinePrefix = journalPrefix();
    check('real-ui-backup-created'); phase('reanalyze-newer-state'); await source(oldSource, oldSnapshot);
    fs.writeFileSync(inputFile, newSource, { mode: 0o600 });
    await perform(() => page.getByRole('button', { name: '상태 새로고침', exact: true }).click());
    await perform(() => page.getByRole('button', { name: '변경 사항 미리보기', exact: true }).click());
    await perform(() => expect(page.getByRole('region', { name: '확인할 가져오기 미리보기', exact: true })).toBeVisible());
    const [updated] = await perform(() => Promise.all([
      page.waitForResponse(r => new URL(r.url()).pathname === `/api/projects/${projectId}/reanalyze` && r.request().method() === 'POST'),
      page.getByRole('button', { name: '변경 확인 후 전체 재분석', exact: true }).click()]));
    assert(updated.ok()); const job = (await perform(() => updated.json())).jobId;
    await perform(() => expect.poll(async () => (await api('/api/jobs/' + job)).status, { timeout: 90000 }).toBe('DONE'), 90000);
    newSnapshot = (await api('/api/projects/' + projectId)).currentSnapshot.id;
    assert.notEqual(newSnapshot, oldSnapshot); await source(newSource, newSnapshot);
    report.snapshots = { backup: oldSnapshot, beforeRestore: newSnapshot }; save(); check('newer-real-db-and-source-created');
    phase('inject-restore-interruption'); await navigate('/settings');
    const fault = await perform(() => app.evaluateHandle(installOwnedInterruption, { profile: plan.paths.userData, parent, mode: point }));
    let restoreFailure;
    try {
      await withPicker('restore', selected, async () => {
        await perform(() => page.getByRole('button', { name: /^(Restore backup|백업 복원)$/ }).click());
        await perform(() => page.getByRole('alert').getByRole('button', { name: /^(Confirm restore|복원 확인)$/ }).click());
        await perform(() => expect.poll(() => fault.evaluate(h => h.inspect()), { timeout: 120000 }).not.toBeNull(), 120000);
        // Wait for the actual IPC rejection and Settings onSettled refresh, not just
        // the transient safety seal seen while a successful restore is still running.
        await perform(() => expect(page.getByRole('button', { name: /^(Restore backup|백업 복원)$/ })).toBeDisabled());
        await perform(() => expect(page.getByRole('alert').filter({ hasText: /^(Request failed\.|요청에 실패했습니다\.)$/ })).toBeVisible());
        await perform(() => expect.poll(async () => (await status()).services.sort(), { timeout: 30000 }).toEqual(['postgres']));
      });
    } catch (error) { restoreFailure = error; }
    finally {
      try { report.injection = await bounded(() => fault.evaluate(h => h.restore()), 5000, 'FAULT_RESTORE_TIMEOUT'); } catch (error) { restoreFailure ||= error; }
      try { await bounded(() => fault.dispose(), 5000, 'FAULT_DISPOSE_TIMEOUT'); } catch (error) { restoreFailure ||= error; }
    }
    if (restoreFailure) throw restoreFailure;
    assert.equal(report.injection?.count, 1); assert.equal(report.injection.mode, point);
    report.failureState = await status();
    assert.equal(report.failureState.ready, false); assert.equal(report.failureState.recoveryOnly, true);
    assert.equal(report.failureState.restoreAvailable, false); assert.equal(report.failureState.backupAvailable, false);
    assert.equal(report.failureState.aiOff, true);
    const transactionRoot = path.join(plan.paths.userData, 'recovery', report.injection.transactionId);
    const checkpoint = path.join(transactionRoot, 'checkpoint.cibackup'), preservedInput = path.join(transactionRoot, 'input/archive.cibackup');
    const checkpointHash = digest(checkpoint);
    assert.equal(digest(preservedInput), selectedHash); assert.equal(digest(selected), selectedHash);
    assert.equal(digest(keyFile), keyHash); assertPrefix(baselinePrefix);
    const interruptedPrefix = journalPrefix(); report.journalPrefixes = { baseline: baselinePrefix, interrupted: interruptedPrefix };
    await perform(() => page.screenshot({ path: path.join(evidence, 'interrupted.png') }));
    check('injected-real-restore-failed-closed-with-checkpoint-input-keyring-and-journal-prefix-preserved');
    phase('close-after-interruption'); await close();
    assert.equal(digest(checkpoint), checkpointHash); assertPrefix(interruptedPrefix);
    await launch(true); phase('verify-recovered-state');
    const restored = point === 'BEFORE_COMPLETED_CLEANUP';
    const expectedSnapshot = restored ? oldSnapshot : newSnapshot, expectedSource = restored ? oldSource : newSource;
    assert.equal((await api('/api/projects/' + projectId)).currentSnapshot.id, expectedSnapshot);
    await source(expectedSource, expectedSnapshot); await healthy();
    assertPrefix(interruptedPrefix); assert.equal(digest(keyFile), keyHash);
    assert.equal(digest(selected), selectedHash); assert.equal(digest(preservedInput), selectedHash); assert.equal(digest(checkpoint), checkpointHash);
    for (const directory of ['checkpoint', 'incoming']) assert.equal(fs.existsSync(path.join(transactionRoot, directory, 'payload.bin')), false);
    report.expectedRecovery = restored ? 'RESTORED_SNAPSHOT' : 'PREVIOUS_SNAPSHOT';
    await perform(() => page.screenshot({ path: path.join(evidence, 'recovered.png') }));
    check(restored ? 'restart-keeps-completed-restored-db-and-source' : 'restart-keeps-rolled-back-newer-db-and-source');
    phase('restart-after-successful-recovery'); await close(); await launch();
    assert.equal((await api('/api/projects/' + projectId)).currentSnapshot.id, expectedSnapshot);
    await source(expectedSource, expectedSnapshot); await healthy(); assertPrefix(interruptedPrefix);
    assert.equal(digest(keyFile), keyHash); assert.equal(digest(checkpoint), checkpointHash);
    check('second-restart-opens-normally-without-recovery-prompt-and-preserves-source');
    await close();
    assert.equal(report.exits.length, 3); assert(report.exits.every(e => e.processExitedZero));
    assert(report.exits.slice(1).every(e => e.cleanShutdownObserved));
    assert.equal(report.dialogEvents.some(e => ['STARTUP_FAILED', 'UNEXPECTED_CONFIRMATION', 'UNEXPECTED_NATIVE_ERROR'].includes(e.code)), false);
    assert.equal(digest(path.join(bundle, 'Contents/Resources/app.asar')), report.appAsarSha256);
    assert.equal(digest(manifestFile), report.manifestSha256);
    report.status = 'PASS'; phase('complete');
  } catch (error) {
    report.status = 'FAIL'; report.failure = { phase: report.phase, code: error.code || error.name,
      message: typeof error.message === 'string' && /^[A-Za-z0-9 .:_-]{1,160}$/.test(error.message) ? error.message : null };
    try { if (page && !page.isClosed()) await bounded(() => page.screenshot({ path: path.join(evidence, 'failure.png') }), 5000, 'FAILURE_CAPTURE_TIMEOUT'); }
    catch { report.failure.captureUnavailable = true; }
    save();
  } finally { try { await close(); } catch { report.status = 'FAIL'; report.cleanupFailed = true; } save(); }
  console.log(JSON.stringify({ status: report.status, phase: report.phase, checks: report.checks.length, evidence, point }));
  if (report.status !== 'PASS') process.exitCode = 1;
}

if (require.main === module) main(process.argv.slice(2)).catch(error => { console.error(error.code || error.name); process.exitCode = 1; });
module.exports = { main };
