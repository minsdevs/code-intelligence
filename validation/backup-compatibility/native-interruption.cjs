'use strict';

// Opt-in native failure/restart tests. Uses one NEW profile per invocation, the
// unmodified retained bundle, real services and encrypted backups, mock Keychain.
// Default: injected I/O failure. --owner-crash pauses at the actual operation
// boundary and SIGKILLs the captured Electron main. Neither is power-loss proof.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const { createRequire } = require('node:module');
const { execFileSync } = require('node:child_process');
const { prepareIsolatedRun } = require('../../desktop/src/isolated-run.cjs');
const { launchEnvironment, bounded } = require('../../desktop/scripts/packaged-keychain-acceptance.cjs');
const { createDeadline, closeOwnedApplication, closeValidatedApplication, observeStartup } = require('../../desktop/scripts/native-acceptance-electron.cjs');
const { validateRuntimeManifest } = require('../../desktop/src/runtime-manifest.cjs');
const { installOwnedInterruption, installOwnedDialogs, captureOwnedApplication } = require('./interruption-hooks.cjs');
const { ensureNativeParent, killCapturedApplication } = require('./owned-crash.cjs');
const { ensureOutputParent } = require('../pre-release/owned-output.cjs');
const { withDropConfirmation } = require('../pre-release/drop-confirmation.cjs');
const sha = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const digest = file => sha(fs.readFileSync(file));

function argumentsFor(argv) {
  assert(Array.isArray(argv) && (argv.length === 4 || argv.length === 5));
  assert.equal(argv[0], '--app'); assert.equal(argv[2], '--point');
  assert(typeof argv[1] === 'string' && path.isAbsolute(argv[1]));
  assert(['AFTER_SOURCE_RENAME', 'BEFORE_COMPLETED_CLEANUP'].includes(argv[3]));
  if (argv.length === 5) assert.equal(argv[4], '--owner-crash');
  return { app: argv[1], point: argv[3], ownerCrash: argv.length === 5 };
}

async function main(argv) {
  assert.equal(process.platform, 'darwin'); assert.equal(process.arch, 'arm64');
  const options = argumentsFor(argv), { point, ownerCrash } = options;
  process.umask(0o077);
  const deadline = createDeadline(), perform = (fn, ms = 30000) => deadline.run(fn, ms);
  const root = fs.realpathSync(path.resolve(__dirname, '../..')), bundle = fs.realpathSync(options.app);
  assert.equal(path.basename(bundle), 'Code Intelligence Validation.app');
  assert.equal(path.dirname(path.dirname(bundle)), root);
  assert.match(path.basename(path.dirname(bundle)), /^\.native-product-[A-Za-z0-9]+$/);
  const runtime = path.join(bundle, 'Contents/Resources/runtime'), manifestFile = path.join(runtime, 'runtime-manifest.json');
  const manifest = JSON.parse(fs.readFileSync(manifestFile));
  await perform(() => validateRuntimeManifest(runtime, manifest), 120000);
  execFileSync('/usr/bin/codesign', ['--verify', '--deep', '--strict', bundle], { timeout: 30000, stdio: 'pipe' });
  const requireFrontend = createRequire(path.join(root, 'frontend/package.json'));
  const { _electron } = requireFrontend('playwright'), { expect } = requireFrontend('@playwright/test');
  const parent = ownerCrash ? ensureNativeParent(root) : fs.mkdtempSync('/private/tmp/ciri-');
  const plan = prepareIsolatedRun({ parentDirectory: parent, runtimeDirectory: runtime, purpose: 'automation',
    forbiddenRoots: ['Code Intelligence', 'Code Intelligence Validation'].map(n => path.join(os.homedir(), 'Library/Application Support', n)) });
  const runRoot = ownerCrash ? plan.paths.output : parent;
  const fixture = path.join(runRoot, 'fixture'), output = path.join(runRoot, 'output');
  for (const directory of [fixture, output]) fs.mkdirSync(directory, { mode: 0o700 });
  const oldSource = 'export function interruptedRestore(): number { return 91; }\n';
  const newSource = oldSource.replace('return 91', 'return 92');
  const inputFile = path.join(fixture, 'recovery.ts');
  fs.writeFileSync(inputFile, oldSource, { flag: 'wx', mode: 0o600 });
  const evidenceRoot = ensureOutputParent(root, ownerCrash ? 'validation/local/electron-crash' : 'validation/local/restore-interruption');
  const evidence = fs.mkdtempSync(path.join(evidenceRoot, 'native-'));
  const report = { format: 1, status: 'RUNNING', scope: ownerCrash ? 'packaged-owner-sigkill-and-recovery' : 'packaged-injected-io-failure-and-restart', point,
    bundle, evidence, claim: plan.claimFile, profile: plan.paths.userData, mockKeychain: true, realAccount: false,
    nativeDialogInteraction: false, sigkill: ownerCrash, powerLoss: false, nonzeroCostObligations: false,
    appAsarSha256: digest(path.join(bundle, 'Contents/Resources/app.asar')), manifestSha256: digest(manifestFile),
    driverSha256: digest(__filename), hooksSha256: digest(path.join(__dirname, 'interruption-hooks.cjs')),
    crashHelperSha256: digest(path.join(__dirname, 'owned-crash.cjs')),
    dropHelperSha256: digest(path.join(__dirname, '../pre-release/drop-confirmation.cjs')),
    checks: [], launches: [], exits: [], dialogEvents: [] };
  const save = () => fs.writeFileSync(path.join(evidence, 'result.json'), JSON.stringify(report, null, 2) + '\n', { mode: 0o600 });
  const phase = value => { report.phase = value; save(); };
  const check = value => { report.checks.push(value); save(); };
  let app, applicationOwner, page, stopObserving, stopDialogs, heldFault, launchSequence = 0, projectId, oldSnapshot, newSnapshot;
  let noteId, oldContentProof, newContentProof, oldCipher, newCipher;
  async function launch(recover = false) {
    phase(recover ? 'launch-restricted-recovery' : 'launch-normal'); plan.assertIdentity();
    app = await _electron.launch({ executablePath: path.join(bundle, 'Contents/MacOS/Code Intelligence Validation'),
      // Synthetic-only driver: apply the Keychain mode before Electron starts,
      // rather than relying solely on a later Playwright loader switch.
      args: ['--use-mock-keychain', '--isolated-run-claim=' + plan.claimFile], env: launchEnvironment(process.env), cwd: root, timeout: deadline.limit(90000) });
    applicationOwner = captureOwnedApplication(app);
    const child = applicationOwner.process(), sequence = ++launchSequence, nonce = crypto.randomBytes(16).toString('hex');
    report.launches.push({ sequence, pid: child.pid, recover }); save();
    delete report.startup; delete report.shutdown; delete report.shutdownTrace;
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
    try {
      if (ownerCrash) await closeValidatedApplication(owned, report);
      else await closeOwnedApplication(owned);
    }
    catch (error) { record.failure = /^[A-Z_]+$/.test(error.message) ? error.message : error.name; throw error; }
    finally {
      record.code = child.exitCode; record.signal = child.signalCode;
      if (ownerCrash) { record.shutdown = report.shutdown ?? null; record.shutdownTrace = report.shutdownTrace ?? []; }
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
    assert.equal(value.backupSupported, true);
    assert.equal(value.backupAvailable, true); assert.equal(value.restoreAvailable, true); assert.equal(value.aiOff, true);
  }
  const navigate = route => perform(() => page.evaluate(route => { history.pushState(null, '', route); dispatchEvent(new PopStateEvent('popstate')); }, route));
  const api = (route, method = 'GET', body) => perform(() => page.evaluate(async ({ route, method, body }) => {
    const d = window.codeIntelligenceDesktop;
    const headers = { 'X-Code-Intelligence-Token': d.apiToken };
    if (method !== 'GET') {
      const csrf = await fetch(d.apiBaseUrl + '/api/csrf', { credentials: 'include', headers });
      if (!csrf.ok) throw new Error('OWNED_CSRF_FAILED');
      const cookie = document.cookie.split(';').map(part => part.trim()).find(part => part.startsWith('XSRF-TOKEN='));
      if (cookie) headers['X-XSRF-TOKEN'] = decodeURIComponent(cookie.slice('XSRF-TOKEN='.length));
    }
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    const response = await fetch(d.apiBaseUrl + route, { method, credentials: 'include', headers,
      body: body === undefined ? undefined : JSON.stringify(body) });
    if (!response.ok) throw new Error('OWNED_API_FAILED'); return response.json();
  }, { route, method, body }));
  async function source(text, snapshot) {
    await navigate(`/projects/${projectId}/code?snapshotId=${snapshot}&sourceContext=snapshot`);
    await perform(() => page.getByRole('combobox', { name: 'Source snapshot' }).selectOption(String(snapshot)));
    await perform(() => page.getByRole('treeitem', { name: 'recovery.ts', exact: true }).click());
    await perform(() => expect(page.getByTestId('code-viewer').locator('.view-lines')).toHaveText(text.trimEnd()));
    await perform(() => expect(page.getByTestId('source-context')).toContainText('Snapshot #' + snapshot));
    await perform(() => expect(page.getByTestId('code-viewer').locator('.monaco-editor').first())
      .toHaveAttribute('data-uri', new RegExp('^snapshot://' + projectId + '/' + snapshot + '/')));
  }
  function ownSelection(value, directory = false) {
    assert.equal(typeof value, 'string'); assert(path.isAbsolute(value));
    assert.equal(fs.realpathSync(value), value); assert(value.startsWith(runRoot + path.sep));
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
  function ownedFile(file) {
    plan.assertIdentity(); assert(file.startsWith(plan.root + path.sep));
    assert.equal(fs.realpathSync(file), file);
    const stat = fs.lstatSync(file);
    assert(stat.isFile() && !stat.isSymbolicLink() && stat.nlink === 1 && stat.uid === process.getuid());
    assert.equal(stat.mode & 0o7777, 0o600); assert(stat.size <= 4 * 1024 * 1024);
    return { bytes: stat.size, device: String(stat.dev), inode: String(stat.ino), sha256: digest(file) };
  }
  function blob(text, sourceRoot = path.join(plan.paths.userData, 'data/sources')) {
    const file = path.join(sourceRoot, String(projectId), sha(text), 'blob.bin');
    const value = ownedFile(file);
    assert(value.bytes > Buffer.byteLength(text));
    return { contentSha256: sha(text), bytes: value.bytes, sha256: value.sha256 };
  }
  async function retainedContent(text, snapshot) {
    const value = await api(`/api/projects/${projectId}/file-content?path=recovery.ts&snapshotId=${snapshot}`);
    assert.equal(value.resolvedSnapshotId, snapshot); assert.equal(value.sourceState, 'AVAILABLE');
    assert.equal(value.evidenceState, null); assert.equal(value.content, text);
    return { snapshotId: snapshot, contentOid: value.contentOid, contentSha256: sha(value.content), sourceState: value.sourceState };
  }
  function permanentState() {
    const safety = path.join(plan.paths.userData, 'safety');
    return Object.fromEntries(['purpose-keyring/purpose-keyring.wrapped', 'purpose-keyring/owner.lock',
      'source-vault/source-keyring.wrapped', 'source-vault/owner.lock', 'ai-journal/writer.lock']
      .map(name => [name, ownedFile(path.join(safety, name))]));
  }
  function recordPrefix() {
    const directory = path.join(plan.paths.userData, 'backup-maintenance');
    const names = fs.readdirSync(directory).filter(name => /^record-[0-9]{8}\.enc$/.test(name)).sort();
    assert(names.length > 0 && names.length <= 1000);
    return Object.fromEntries(names.map(name => [name, ownedFile(path.join(directory, name))]));
  }
  function verifyRecordPrefix(expected) {
    const current = recordPrefix();
    for (const [name, value] of Object.entries(expected)) assert.deepEqual(current[name], value);
    return Object.keys(current).length;
  }
  async function runOwnerCrash(selected, selectedHash, keyHash, baselinePrefix) {
    const restored = point === 'BEFORE_COMPLETED_CLEANUP';
    const expectedSnapshot = restored ? oldSnapshot : newSnapshot, expectedSource = restored ? oldSource : newSource;
    const stable = permanentState();
    phase('hold-real-restore-boundary'); await navigate('/settings');
    heldFault = await perform(() => app.evaluateHandle(installOwnedInterruption,
      { profile: plan.paths.userData, parent, mode: point, pauseForCrash: true }));
    await withPicker('restore', selected, async () => {
      await perform(() => page.getByRole('button', { name: /^(Restore backup|백업 복원)$/ }).click());
      await perform(() => page.getByRole('alert').getByRole('button', { name: /^(Confirm restore|복원 확인)$/ }).click());
      await perform(() => expect.poll(() => heldFault.evaluate(h => h.inspect()), { timeout: 120000 }).not.toBeNull(), 120000);
    });
    report.injection = await perform(() => heldFault.evaluate(h => h.inspect()));
    assert.equal(report.injection.pauseForCrash, true); assert.equal(report.injection.count, 1);
    assert.equal(report.injection.mode, point); assert.equal(report.injection.operationCompleted, !restored);
    const transactionRoot = path.join(plan.paths.userData, 'recovery', report.injection.transactionId);
    const checkpoint = path.join(transactionRoot, 'checkpoint.cibackup');
    const preservedInput = path.join(transactionRoot, 'input/archive.cibackup');
    const checkpointHash = digest(checkpoint);
    assert.equal(digest(preservedInput), selectedHash); assert.equal(digest(selected), selectedHash);
    assert.equal(digest(keyFile), keyHash); assertPrefix(baselinePrefix);
    assert.deepEqual(blob(oldSource), oldCipher);
    assert.deepEqual(blob(newSource, restored ? path.join(transactionRoot, 'previous-sources') : undefined), newCipher);
    const interruptedPrefix = journalPrefix(), records = recordPrefix();
    const activeFile = path.join(plan.paths.userData, 'backup-maintenance/active.enc');
    const active = ownedFile(activeFile);
    report.journalPrefixes = { baseline: baselinePrefix, interrupted: interruptedPrefix };
    report.retainedBeforeCrash = { old: oldContentProof, newer: newContentProof, oldCipher, newCipher };
    report.crashState = { transactionId: report.injection.transactionId, active, recordPrefix: records,
      permanentState: stable, checkpointSha256: checkpointHash, inputSha256: selectedHash };
    check('actual-restore-paused-with-authenticated-snapshot-ciphertexts-and-durable-history-retained');
    const owner = applicationOwner, child = owner.process();
    report.crash = {}; phase('kill-owned-electron');
    try { await killCapturedApplication(owner, report.crash); }
    finally {
      save();
      if (child.exitCode !== null || child.signalCode !== null) {
        report.exits.push({ sequence: launchSequence, pid: child.pid, code: child.exitCode, signal: child.signalCode,
          intentionalCrash: true, cleanShutdownObserved: false });
        app = null; applicationOwner = null; heldFault = undefined; page = null;
        stopObserving?.(); stopDialogs?.(); stopObserving = undefined; stopDialogs = undefined;
      }
    }
    assert.equal(report.crash.observedTreeGone, true);
    assert.deepEqual(ownedFile(activeFile), active); assert.deepEqual(permanentState(), stable);
    assertPrefix(interruptedPrefix); assert.equal(verifyRecordPrefix(records), Object.keys(records).length);
    check('owned-electron-sigkill-and-observed-descendant-snapshot-exit-confirmed');
    await launch(true); phase('verify-owner-crash-recovery');
    assert.equal((await api('/api/projects/' + projectId)).currentSnapshot.id, expectedSnapshot);
    assert.deepEqual(await retainedContent(oldSource, oldSnapshot), oldContentProof);
    if (!restored) assert.deepEqual(await retainedContent(newSource, newSnapshot), newContentProof);
    await source(expectedSource, expectedSnapshot); await healthy();
    assert.equal((await api(`/api/projects/${projectId}/notes/${noteId}`)).contentMd,
      restored ? 'Synthetic note at backup91' : 'Synthetic note before crash92');
    assert.deepEqual(blob(oldSource), oldCipher);
    assert.deepEqual(blob(newSource, restored ? path.join(transactionRoot, 'previous-sources') : undefined), newCipher);
    assert.deepEqual(permanentState(), stable); assertPrefix(interruptedPrefix);
    assert(verifyRecordPrefix(records) > Object.keys(records).length);
    assert.equal(fs.existsSync(activeFile), false);
    for (const directory of ['checkpoint', 'incoming']) assert.equal(fs.existsSync(path.join(transactionRoot, directory, 'payload.bin')), false);
    assert.equal(digest(selected), selectedHash); assert.equal(digest(preservedInput), selectedHash); assert.equal(digest(checkpoint), checkpointHash);
    report.expectedRecovery = restored ? 'RESTORED_SNAPSHOT' : 'PREVIOUS_SNAPSHOT';
    report.sourceAndNotesVerified = true;
    check(restored ? 'completed-restore-survives-owner-crash-with-original-note-and-source' : 'interrupted-publication-recovers-newer-note-and-both-snapshot-sources');
    await perform(() => page.screenshot({ path: path.join(evidence, 'recovered.png') }));
    phase('normal-restart-after-owner-crash'); await close(); await launch();
    assert.equal((await api('/api/projects/' + projectId)).currentSnapshot.id, expectedSnapshot);
    await source(expectedSource, expectedSnapshot); await healthy();
    assert.deepEqual(await retainedContent(oldSource, oldSnapshot), oldContentProof);
    if (!restored) assert.deepEqual(await retainedContent(newSource, newSnapshot), newContentProof);
    assert.deepEqual(permanentState(), stable); assertPrefix(interruptedPrefix); verifyRecordPrefix(records);
    check('subsequent-normal-start-needs-no-recovery-and-retains-verified-snapshot-source');
    await close();
    assert.equal(report.exits.length, 3); assert.equal(report.exits[0].signal, 'SIGKILL');
    assert(report.exits.slice(1).every(exit => exit.cleanShutdownObserved && exit.shutdown?.state === 'COMPLETE'));
    assert.equal(report.dialogEvents.filter(event => event.code === 'RECOVERY_ACCEPTED').length, 1);
    assert(report.dialogEvents.every(event => event.code === 'RECOVERY_ACCEPTED'));
    assert.equal(digest(path.join(bundle, 'Contents/Resources/app.asar')), report.appAsarSha256);
    assert.equal(digest(manifestFile), report.manifestSha256);
    assert.equal(digest(__filename), report.driverSha256);
    assert.equal(digest(path.join(__dirname, 'interruption-hooks.cjs')), report.hooksSha256);
    assert.equal(digest(path.join(__dirname, 'owned-crash.cjs')), report.crashHelperSha256);
    assert.equal(digest(path.join(__dirname, '../pre-release/drop-confirmation.cjs')), report.dropHelperSha256);
    report.status = 'PASS'; phase('complete');
  }
  save(); console.log(JSON.stringify({ status: 'RUNNING', evidence, profile: plan.paths.userData, point }));
  try {
    await launch(); phase('import-fixture'); await navigate('/import');
    const picker = page.getByRole('button', { name: 'Choose folder', exact: true });
    await perform(() => expect(picker).toBeVisible()); const box = await perform(() => picker.boundingBox()); assert(box);
    // SEC-M-02: main grants the drop only after its native confirmation; answered once and verified.
    const { confirmation } = await withDropConfirmation(app, fixture, async () => {
      const cdp = await perform(() => page.context().newCDPSession(page)); let dragFailure;
      try { for (const type of ['dragEnter', 'dragOver', 'drop']) await perform(() => cdp.send('Input.dispatchDragEvent', {
        type, x: box.x + box.width / 2, y: box.y + box.height / 2, data: { items: [], files: [fixture], dragOperationsMask: 1 } })); }
      catch (error) { dragFailure = error; throw error; }
      finally { try { await bounded(() => cdp.detach(), 5000, 'DRAG_DETACH_TIMEOUT'); } catch (error) { if (!dragFailure) throw error; } }
      await perform(() => page.getByRole('button', { name: '가져올 파일 미리보기', exact: true }).click());
    });
    (report.dropConfirmations ??= []).push(confirmation); save();
    const [created] = await perform(() => Promise.all([
      page.waitForResponse(r => new URL(r.url()).pathname === '/api/projects/local' && r.request().method() === 'POST'),
      page.getByRole('button', { name: '확인한 파일 가져오기 및 분석', exact: true }).click()]));
    assert(created.ok()); projectId = (await perform(() => created.json())).project.id;
    await perform(() => expect.poll(async () => (await api('/api/projects/' + projectId)).currentSnapshot?.status, { timeout: 90000 }).toBe('READY'), 90000);
    oldSnapshot = (await api('/api/projects/' + projectId)).currentSnapshot.id; await source(oldSource, oldSnapshot);
    if (ownerCrash) {
      oldContentProof = await retainedContent(oldSource, oldSnapshot); oldCipher = blob(oldSource);
      noteId = (await api(`/api/projects/${projectId}/notes`, 'POST',
        { title: 'Synthetic recovery note', contentMd: 'Synthetic note at backup91' })).id;
      assert(Number.isSafeInteger(noteId) && noteId > 0);
    }
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
    if (ownerCrash) {
      newContentProof = await retainedContent(newSource, newSnapshot); newCipher = blob(newSource);
      assert.deepEqual(await retainedContent(oldSource, oldSnapshot), oldContentProof);
      await api(`/api/projects/${projectId}/notes/${noteId}`, 'PUT',
        { title: 'Synthetic recovery note', contentMd: 'Synthetic note before crash92' });
    }
    report.snapshots = { backup: oldSnapshot, beforeRestore: newSnapshot }; save(); check('newer-real-db-and-source-created');
    if (ownerCrash) {
      await runOwnerCrash(selected, selectedHash, keyHash, baselinePrefix);
    } else {
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
    assert.equal(report.failureState.backupSupported, true);
    phase('verify-recovery-guidance');
    const guidance = page.getByTestId('runtime-guidance');
    await perform(() => expect(guidance).toHaveAttribute('role', 'alert'));
    await perform(() => expect(guidance).toContainText('Data may already have been replaced'));
    await perform(() => expect(guidance).not.toContainText('kept unchanged'));
    await perform(() => expect(page.getByRole('button', { name: 'Restart runtime', exact: true })).toBeDisabled());
    await perform(() => page.getByRole('button', { name: '한국어', exact: true }).click());
    await perform(() => expect(guidance).toContainText('데이터가 이미 교체되었을 수 있으므로'));
    await perform(() => expect(guidance).toContainText('백업·체크포인트·복구 파일을 삭제하지 마세요'));
    await perform(() => expect(page.getByRole('button', { name: 'Runtime 재시작', exact: true })).toBeDisabled());
    await perform(() => guidance.scrollIntoViewIfNeeded());
    await perform(() => page.screenshot({ path: path.join(evidence, 'guidance-ko.png') }));
    await perform(() => page.getByRole('button', { name: 'English', exact: true }).click());
    await perform(() => expect(guidance).toContainText('Restart runtime does not perform this recovery'));
    await perform(() => guidance.scrollIntoViewIfNeeded());
    await perform(() => page.screenshot({ path: path.join(evidence, 'guidance-en.png') }));
    check('recovery-guidance-distinguishes-supported-build-and-replaced-data-in-both-languages');
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
    await navigate('/settings');
    await perform(() => expect(page.getByRole('button', { name: 'Create backup', exact: true })).toBeEnabled());
    await perform(() => expect(page.getByTestId('runtime-guidance')).toHaveCount(0));
    await source(expectedSource, expectedSnapshot);
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
    }
  } catch (error) {
    report.status = 'FAIL'; report.failure = { phase: report.phase, code: error.code || error.name,
      message: typeof error.message === 'string' && /^[A-Za-z0-9 .:_-]{1,160}$/.test(error.message) ? error.message : null };
    try { if (page && !page.isClosed()) await bounded(() => page.screenshot({ path: path.join(evidence, 'failure.png') }), 5000, 'FAILURE_CAPTURE_TIMEOUT'); }
    catch { report.failure.captureUnavailable = true; }
    save();
  } finally {
    if (heldFault && app) {
      try { await bounded(() => heldFault.evaluate(h => h.restore()), 5000, 'FAULT_RESTORE_TIMEOUT'); }
      catch { report.status = 'FAIL'; report.holdCleanupFailed = true; }
      try { await bounded(() => heldFault.dispose(), 5000, 'FAULT_DISPOSE_TIMEOUT'); } catch { report.status = 'FAIL'; }
      heldFault = undefined;
    }
    try { await close(); } catch { report.status = 'FAIL'; report.cleanupFailed = true; } save();
  }
  console.log(JSON.stringify({ status: report.status, phase: report.phase, checks: report.checks.length, evidence, point }));
  if (report.status !== 'PASS') process.exitCode = 1;
}

if (require.main === module) main(process.argv.slice(2)).catch(error => { console.error(error.code || error.name); process.exitCode = 1; });
module.exports = { main, argumentsFor };
