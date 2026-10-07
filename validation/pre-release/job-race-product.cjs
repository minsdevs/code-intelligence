'use strict';

// G-JOB packaged-app races on the retained candidate: cancel during a real analysis through the
// real UI/API, SIGKILL of the app's own analyzer and backend children mid-analysis, project
// delete racing an active job, app restarts and a later successful re-analysis. Fresh synthetic
// profile (mock Keychain), synthetic source copy, no provider calls, no real account.
//
// Signal authority: the only processes signalled are (a) the Playwright-owned Electron
// ChildProcess (normal close / SDK cleanup) and (b) the analyzer/backend owners that the app's
// own main process registers in its child registry. Those owners are captured in-process when
// main registers them and are stopped only through owner.kill('SIGKILL'), which makes the app's
// guardian SIGKILL the exact Process handle it spawned. No PID is looked up or signalled here.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { createRequire } = require('node:module');
const { execFileSync } = require('node:child_process');
const { ensureOutputParent } = require('./owned-output.cjs');
const { validateRuntimeManifest } = require('../../desktop/src/runtime-manifest.cjs');
const { copySource } = require('../../desktop/scripts/native-acceptance.cjs');
const { validateLocalEnvironment, requireExecutionContext } = require('../../desktop/scripts/native-acceptance-context.cjs');
const { closeValidatedApplication, observeStartup } = require('../../desktop/scripts/native-acceptance-electron.cjs');
const { adapterMode, expectedServices } = require('./adapter-mode.cjs');
const { withDropConfirmation } = require('./drop-confirmation.cjs');
const hash = file => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const digest = value => crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const TERMINAL = ['DONE', 'FAILED', 'CANCELLED'];
const ACTIVE = ['QUEUED', 'RUNNING', 'CANCELLING'];
const CHANGED_FILE = 'frontend/src/api/jobs.ts';

// Serialized into the app's Electron main process. Captures the next analyzer/backend owners
// registered by main (Map#set on its child registry) and restores Map#set once all are seen.
// An xpc-required app registers no analyzer child, so only the backend is expected there.
function installOwnerCapture({ app }, { userData, names = ['backend', 'ts-analyzer'] }) {
  if (app.getPath('userData') !== userData || app.getName() !== 'Code Intelligence Acceptance') {
    throw new Error('OWNER_CAPTURE_PROFILE_MISMATCH');
  }
  const original = Map.prototype.set, captured = {};
  const isOwner = value => value !== null && typeof value === 'object' && typeof value.kill === 'function'
    && typeof value.stopped === 'function' && value.termination instanceof Promise
    && typeof Object.getOwnPropertyDescriptor(value, 'actualProcess')?.get === 'function';
  function capture(key, value) {
    if (names.includes(key) && isOwner(value)) {
      captured[key] = value;
      if (names.every(name => captured[name]) && Map.prototype.set === capture) Map.prototype.set = original;
    }
    return Reflect.apply(original, this, [key, value]);
  }
  Map.prototype.set = capture;
  return {
    restore() { if (Map.prototype.set === capture) Map.prototype.set = original; return Object.keys(captured).sort(); },
    captured() { return Object.keys(captured).sort(); },
    async kill(name) {
      const owner = captured[name];
      if (!owner) throw new Error('OWNER_NOT_CAPTURED');
      if (owner.stopped() || owner.exitCode !== null) throw new Error('OWNER_ALREADY_STOPPED');
      const before = owner.actualProcess;
      if (owner.kill('SIGKILL') !== true) throw new Error('OWNER_SIGNAL_NOT_SENT');
      let timer;
      const proof = await Promise.race([owner.termination,
        new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('OWNER_EXIT_TIMEOUT')), 30000); })])
        .finally(() => clearTimeout(timer));
      return { startedAt: before.startedAt, exitCode: proof.exitCode, stopped: proof.stopped === true };
    },
  };
}

// Serialized into the app's Electron main process (xpc-required). Main starts one adapter-bridge
// child per analysis session; this records the ChildProcess handles main itself spawns for the
// bundled bridge, and kill() signals the only live one through that handle. No PID is looked up.
function installBridgeCapture(electron, { userData }) {
  const { app } = electron;
  if (app.getPath('userData') !== userData || app.getName() !== 'Code Intelligence Acceptance') {
    throw new Error('OWNER_CAPTURE_PROFILE_MISMATCH');
  }
  const prototype = (electron.childProcess ?? process.getBuiltinModule('node:child_process')).ChildProcess.prototype;
  const original = prototype.spawn, captured = [];
  function spawn(options) {
    const result = Reflect.apply(original, this, [options]);
    if (typeof options?.file === 'string' && options.file.endsWith('/Contents/MacOS/adapter-bridge')) captured.push(this);
    return result;
  }
  prototype.spawn = spawn;
  return {
    restore() { if (prototype.spawn === spawn) prototype.spawn = original; return captured.length; },
    sessions() { return captured.length; },
    async kill(waitMs = 30000) {
      // TS_PARSING reads its payload before the analysis session starts; wait for that session.
      let live = [];
      for (const end = Date.now() + waitMs; ; await new Promise(resolve => setTimeout(resolve, 50))) {
        live = captured.filter(child => child.exitCode === null && child.signalCode === null);
        if (live.length || Date.now() >= end) break;
      }
      if (live.length !== 1) throw new Error(live.length ? 'BRIDGE_NOT_UNIQUE' : 'BRIDGE_NOT_RUNNING');
      const [bridge] = live;
      const exited = new Promise(resolve => bridge.once('exit', (code, signal) => resolve({ exitCode: code, signal })));
      if (bridge.kill('SIGKILL') !== true) throw new Error('OWNER_SIGNAL_NOT_SENT');
      let timer;
      const proof = await Promise.race([exited, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('OWNER_EXIT_TIMEOUT')), 30000); })])
        .finally(() => clearTimeout(timer));
      return { ...proof, sessions: captured.length };
    },
  };
}

async function main(argv = process.argv.slice(2)) {
  assert.equal(process.platform, 'darwin'); assert.equal(process.arch, 'arm64');
  assert(argv.length === 2 && argv[0] === '--app', 'JOB_RACE_PRODUCT_ARGUMENTS');
  validateLocalEnvironment(process.env, process.execArgv); process.umask(0o077);
  const repo = fs.realpathSync(path.resolve(__dirname, '../..')), appBundle = fs.realpathSync(argv[1]);
  assert.equal(path.dirname(path.dirname(appBundle)), repo); assert.equal(path.basename(appBundle), 'Code Intelligence Validation.app');
  assert.match(path.basename(path.dirname(appBundle)), /^\.native-product-[A-Za-z0-9]+$/);
  const runtimeDirectory = path.join(appBundle, 'Contents/Resources/runtime');
  const isolated = adapterMode(appBundle) === 'xpc-required', services = expectedServices(appBundle).join();
  const owners = isolated ? ['backend'] : ['backend', 'ts-analyzer'];
  const manifestFile = path.join(runtimeDirectory, 'runtime-manifest.json'), manifest = JSON.parse(fs.readFileSync(manifestFile));
  await validateRuntimeManifest(runtimeDirectory, manifest);
  execFileSync('/usr/bin/codesign', ['--verify', '--strict', '--deep', appBundle], { timeout: 30000, stdio: 'pipe' });
  const evidence = fs.mkdtempSync(path.join(ensureOutputParent(repo, 'validation/local/job-race'), 'product-'));
  const root = fs.mkdtempSync('/private/tmp/cnjr-'), temp = path.join(root, 'work'), owned = path.join(temp, 'owned');
  for (const p of [temp, owned]) fs.mkdirSync(p, { mode: 0o700 });
  const short = fs.mkdtempSync('/private/tmp/cnjp-'), control = path.join(root, 'context.json');
  const revision = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repo, encoding: 'utf8' }).trim();
  fs.writeFileSync(control, JSON.stringify({ format: 1, kind: 'isolated-macos-host', provider: 'local-macos',
    uid: process.getuid(), revision, buildSequence: manifest.buildSequence, sourceRoot: repo, tempRoot: temp,
    isolatedRunParent: short, createdAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 3600000).toISOString() }), { flag: 'wx', mode: 0o600 });
  const env = { PATH: '/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin', HOME: os.homedir(), LANG: 'C', LC_ALL: 'C',
    NATIVE_ACCEPTANCE_CONTEXT: control, CODE_INTELLIGENCE_BUILD_SEQUENCE: manifest.buildSequence };
  const context = requireExecutionContext(env);
  const desktopPackage = JSON.parse(fs.readFileSync(path.join(repo, 'desktop/package.json'), 'utf8'));
  const applicationSupport = path.join(os.homedir(), 'Library', 'Application Support');
  const plan = require('../../desktop/src/isolated-run.cjs').prepareIsolatedRun({ parentDirectory: short, runtimeDirectory,
    purpose: 'automation', forbiddenRoots: [path.join(applicationSupport, desktopPackage.name),
      path.join(applicationSupport, desktopPackage.build.productName)] });
  const sample = path.join(owned, 'job-race-sample');
  const copied = copySource(repo, sample);
  const originalChanged = fs.readFileSync(path.join(sample, CHANGED_FILE), 'utf8');
  const report = { format: 1, status: 'RUNNING', scope: 'G-JOB packaged-app cancel/kill/delete/restart races',
    appBundle, manifestSha256: hash(manifestFile), appAsarSha256: hash(path.join(appBundle, 'Contents/Resources/app.asar')),
    driverSha256: hash(__filename), revision, executionContext: context.evidence, validationProfile: plan.paths.userData,
    sample: { files: copied.files, sha256: copied.sha256 }, adapterIsolation: isolated ? 'xpc-required' : 'legacy-http',
    mockKeychain: true, realAccount: false, checks: [],
    scenarios: {}, launches: [], timingNote: 'elapsed values are single observations on a shared machine, not SLO results' };
  const resultFile = path.join(evidence, 'result.json');
  const save = () => fs.writeFileSync(resultFile, JSON.stringify(report, null, 2) + '\n', { mode: 0o600 });
  const phase = name => { report.phase = name; save(); };
  save(); console.log(JSON.stringify({ status: report.status, evidence }));
  const frontendRequire = createRequire(path.join(repo, 'frontend', 'package.json'));
  const { _electron: electron } = frontendRequire('playwright');
  const { expect } = frontendRequire('@playwright/test');
  const executablePath = path.join(appBundle, 'Contents/MacOS/Code Intelligence Validation');
  let app, ownedApplication, page, stopObserving, pageErrors = 0, failure;

  const launch = async label => {
    phase('launch-' + label);
    app = await electron.launch({ executablePath, args: ['--use-mock-keychain', '--isolated-run-claim=' + plan.claimFile],
      cwd: owned, env, timeout: 90000 });
    const launched = app, child = app.process();
    ownedApplication = { process: () => child, close: () => child.exitCode !== null || child.signalCode !== null ? Promise.resolve() : launched.close() };
    delete report.startup; delete report.shutdown; delete report.shutdownTrace;
    stopObserving = observeStartup(child, report, save);
    page = await app.firstWindow({ timeout: 90000 }); page.setDefaultTimeout(30000);
    page.on('pageerror', () => pageErrors++);
    assert.equal(await app.evaluate(({ app }) => app.getPath('userData')), plan.paths.userData, 'PROFILE_MISMATCH');
    await expect(page.getByRole('link', { name: 'Code Intelligence home' })).toBeVisible({ timeout: 60000 });
    await waitReady('launch-' + label);
    report.launches.push({ label, packaged: await app.evaluate(({ app }) => app.isPackaged) });
  };
  const close = async () => {
    if (!app) return;
    const current = ownedApplication; app = null; ownedApplication = null;
    phase('clean-shutdown');
    try { await closeValidatedApplication(current, report); report.launches.at(-1).cleanShutdown = true; }
    finally { stopObserving?.(); stopObserving = null; }
  };
  const runtimeStatus = () => page.evaluate(() => window.codeIntelligenceDesktop.runtimeStatus());
  async function waitReady(label, { sawDown = false, timeoutMs = 180000 } = {}) {
    const deadline = Date.now() + timeoutMs; let down = false;
    while (Date.now() < deadline) {
      let status; try { status = await runtimeStatus(); } catch { status = null; }
      if (status && !status.ready) down = true;
      if (status?.ready && status.error === null && status.recoveryOnly === false && (!sawDown || down)
        && [...status.services].sort().join() === services) return { observedNotReady: down };
      if (status?.recoveryOnly) throw new Error('RUNTIME_RECOVERY_REQUIRED');
      await sleep(250);
    }
    throw new Error('RUNTIME_NOT_READY_' + label.toUpperCase().replace(/[^A-Z0-9]+/g, '_'));
  }
  const api = (route, method = 'GET') => page.evaluate(async ({ route, method }) => {
    const desktop = window.codeIntelligenceDesktop;
    const headers = { 'X-Code-Intelligence-Token': desktop.apiToken };
    try {
      if (method !== 'GET') {
        const prime = await fetch(desktop.apiBaseUrl + '/api/csrf', { credentials: 'include', headers });
        if (!prime.ok) return { status: prime.status, body: null };
        const cookie = document.cookie.split(';').map(part => part.trim()).find(part => part.startsWith('XSRF-TOKEN='));
        if (cookie) headers['X-XSRF-TOKEN'] = decodeURIComponent(cookie.slice('XSRF-TOKEN='.length));
      }
      const response = await fetch(desktop.apiBaseUrl + route, { method, credentials: 'include', headers });
      const text = await response.text();
      return { status: response.status, body: response.ok && text ? JSON.parse(text) : null };
    } catch { return { status: 0, body: null }; }
  }, { route, method });
  const ok = async (route, method) => {
    const result = await api(route, method);
    assert(result.status >= 200 && result.status < 300, 'API_' + method + '_FAILED');
    return result.body;
  };
  const navigate = route => page.evaluate(route => { history.pushState(null, '', route); window.dispatchEvent(new PopStateEvent('popstate')); }, route);
  const jobView = job => ({ status: job.status, failureCode: job.failureCode ?? null,
    error: typeof job.error === 'string' && /^[ -~]{0,200}$/.test(job.error) ? job.error : null,
    steps: job.steps.map(step => ({ key: step.stepKey, status: step.status, attempt: step.attempt, progress: step.progressPct ?? null })) });
  async function awaitJob(jobId, predicate, code, timeoutMs = 240000) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const result = await api('/api/jobs/' + jobId);
      if (result.status === 200) {
        if (predicate(result.body)) return result.body;
        if (TERMINAL.includes(result.body.status) && !predicate(result.body)) {
          report.lastJob = jobView(result.body); throw new Error(code + '_TERMINAL_FIRST');
        }
      }
      await sleep(120);
    }
    throw new Error(code + '_TIMEOUT');
  }
  const running = key => job => job.status === 'RUNNING' && job.steps.some(step => step.stepKey === key && step.status === 'RUNNING');
  const terminal = job => TERMINAL.includes(job.status);
  async function noActiveJob(projectId) {
    const jobs = await ok(`/api/projects/${projectId}/jobs?limit=50`);
    assert(jobs.every(job => !ACTIVE.includes(job.status)), 'ACTIVE_JOB_REMAINS');
    return jobs.length;
  }
  async function snapshotState(projectId, snapshotId) {
    const files = await ok(`/api/projects/${projectId}/files?snapshotId=${snapshotId}`);
    const graph = await ok(`/api/projects/${projectId}/graph/overview?snapshotId=${snapshotId}`);
    const content = await ok(`/api/projects/${projectId}/file-content?path=${encodeURIComponent(CHANGED_FILE)}&snapshotId=${snapshotId}`);
    return { snapshotId, files: files.length,
      filesSha256: digest(files.map(file => [file.path, file.analysisStatus ?? null, file.resolvedSnapshotId]).sort()),
      graphSha256: digest(graph), changedFileSha256: digest(content.content) };
  }
  async function assertPrevious(projectId, baseline, label) {
    const project = await ok(`/api/projects/${projectId}`);
    assert.equal(project.currentSnapshot?.id, baseline.snapshotId, 'CURRENT_SNAPSHOT_CHANGED_' + label);
    assert.deepEqual(await snapshotState(projectId, baseline.snapshotId), baseline, 'PREVIOUS_RESULT_CHANGED_' + label);
    await noActiveJob(projectId);
  }
  async function importFolder(folder) {
    // A same-path pushState keeps the mounted wizard (and a finished job's progress view), so
    // leave the route first to start the import from a freshly mounted wizard.
    await navigate('/projects');
    await expect(page.getByRole('link', { name: 'Code Intelligence home' })).toBeVisible();
    await navigate('/import');
    const picker = page.getByRole('button', { name: 'Choose folder', exact: true });
    await expect(picker).toBeVisible().catch(() => { throw new Error('IMPORT_PICKER_NOT_VISIBLE'); });
    const bounds = await picker.boundingBox(); assert(bounds, 'PICKER_NOT_VISIBLE');
    const { result: preview, confirmation } = await withDropConfirmation(app, folder, async () => {
      const cdp = await page.context().newCDPSession(page);
      try {
        const data = { items: [], files: [folder], dragOperationsMask: 1 };
        for (const type of ['dragEnter', 'dragOver', 'drop']) await cdp.send('Input.dispatchDragEvent', {
          type, x: bounds.x + bounds.width / 2, y: bounds.y + bounds.height / 2, data });
      } finally { await cdp.detach().catch(() => {}); }
      const [response] = await Promise.all([
        page.waitForResponse(r => new URL(r.url()).pathname === '/api/projects/local/preview' && r.request().method() === 'POST', { timeout: 120000 }),
        page.getByRole('button', { name: '가져올 파일 미리보기', exact: true }).click()]);
      return response;
    });
    (report.dropConfirmations ??= []).push(confirmation);
    assert(preview.ok(), 'IMPORT_PREVIEW_FAILED');
    await expect(page.getByRole('region', { name: '확인할 가져오기 미리보기', exact: true })).toBeVisible({ timeout: 60000 });
    const [created] = await Promise.all([
      page.waitForResponse(r => new URL(r.url()).pathname === '/api/projects/local' && r.request().method() === 'POST', { timeout: 120000 }),
      page.getByRole('button', { name: '확인한 파일 가져오기 및 분석', exact: true }).click()]);
    assert(created.ok(), 'IMPORT_CREATE_FAILED');
    const body = await created.json();
    return { projectId: body.project.id, jobId: body.jobId };
  }
  async function uiReanalysis(projectId, marker) {
    fs.writeFileSync(path.join(sample, CHANGED_FILE), originalChanged + `\n// job-race ${marker}\n`, { mode: 0o600 });
    await navigate(`/projects/${projectId}/overview`);
    await page.getByRole('button', { name: '상태 새로고침', exact: true }).click();
    await page.getByRole('button', { name: '변경 사항 미리보기', exact: true }).click();
    await expect(page.getByRole('region', { name: '확인할 가져오기 미리보기', exact: true })).toBeVisible({ timeout: 120000 });
    const [started] = await Promise.all([
      page.waitForResponse(r => new URL(r.url()).pathname === `/api/projects/${projectId}/reanalyze` && r.request().method() === 'POST', { timeout: 120000 }),
      page.getByRole('button', { name: '변경 확인 후 전체 재분석', exact: true }).click()]);
    assert(started.ok(), 'REANALYZE_START_FAILED');
    return (await started.json()).jobId;
  }
  const stepOf = (job, key) => job.steps.find(step => step.stepKey === key);
  const runningStep = job => job.steps.find(step => step.status === 'RUNNING')?.stepKey ?? null;

  try {
    await launch('first');

    // A1: cancel the first analysis through the real UI button while TS_PARSING (worker request) runs.
    phase('ui-cancel-initial-import');
    const first = await importFolder(sample);
    const atCancel = await awaitJob(first.jobId, running('TS_PARSING'), 'A1_TS_PARSING');
    const cancelClicked = performance.now();
    await page.getByRole('button', { name: 'Cancel analysis', exact: true }).click();
    const cancelled = await awaitJob(first.jobId, terminal, 'A1_CANCEL');
    assert.equal(cancelled.status, 'CANCELLED', 'A1_NOT_CANCELLED');
    assert(['DONE', 'FAILED'].includes(stepOf(cancelled, 'TS_PARSING').status), 'A1_WORKER_STEP_NOT_ENDED');
    assert(cancelled.steps.slice(cancelled.steps.findIndex(s => s.stepKey === 'TS_PARSING') + 1)
      .every(step => step.status === 'PENDING' && step.attempt === 0), 'A1_LATER_STEP_RAN');
    assert.equal((await ok(`/api/projects/${first.projectId}`)).currentSnapshot ?? null, null, 'A1_PUBLISHED');
    await noActiveJob(first.projectId);
    await waitReady('a1-after-cancel');
    assert.equal((await api(`/api/projects/${first.projectId}`, 'DELETE')).status, 204, 'A1_DELETE_AFTER_CANCEL');
    report.scenarios.uiCancelInitialImport = { cancelledDuring: 'TS_PARSING', progressAtCancel: stepOf(atCancel, 'TS_PARSING').progressPct ?? null,
      cancelToTerminalMs: Math.round(performance.now() - cancelClicked), job: jobView(cancelled), deletedAfterCancel: true };
    report.checks.push('ui-cancel-during-worker-request-ends-step-releases-lock-publishes-nothing');

    phase('baseline-import');
    const imported = await importFolder(sample);
    const projectId = imported.projectId;
    assert.equal((await awaitJob(imported.jobId, terminal, 'BASELINE')).status, 'DONE', 'BASELINE_NOT_DONE');
    const baselineId = (await ok(`/api/projects/${projectId}`)).currentSnapshot.id;
    const baseline = await snapshotState(projectId, baselineId);
    report.scenarios.baseline = { projectId, snapshotId: baselineId, state: baseline };

    // A2 + D: delete racing an active analysis, API cancel with a previous result present.
    phase('delete-race-and-cancel-with-previous-result');
    const raced = await uiReanalysis(projectId, 'a2');
    const raceAt = await awaitJob(raced, running('TS_PARSING'), 'A2_TS_PARSING');
    const deleteWhileRunning = (await api(`/api/projects/${projectId}`, 'DELETE')).status;
    assert.equal(deleteWhileRunning, 409, 'A2_DELETE_WHILE_RUNNING');
    assert.equal((await api(`/api/jobs/${raced}/cancel`, 'POST')).status, 202, 'A2_CANCEL_REJECTED');
    const afterCancel = await ok(`/api/jobs/${raced}`);
    let deleteWhileCancelling = null;
    if (afterCancel.status === 'CANCELLING') {
      deleteWhileCancelling = (await api(`/api/projects/${projectId}`, 'DELETE')).status;
      assert.equal(deleteWhileCancelling, 409, 'A2_DELETE_WHILE_CANCELLING');
    }
    const raceEnd = await awaitJob(raced, terminal, 'A2_CANCEL');
    assert.equal(raceEnd.status, 'CANCELLED', 'A2_NOT_CANCELLED');
    await assertPrevious(projectId, baseline, 'A2');
    report.scenarios.deleteRaceAndCancel = { runningStep: runningStep(raceAt), deleteWhileRunning,
      statusAfterCancelRequest: afterCancel.status, deleteWhileCancelling, job: jobView(raceEnd) };
    report.checks.push('delete-refused-while-running-and-cancelling', 'api-cancel-keeps-previous-result-current');

    // B: SIGKILL of the analyzer child (app-owned) while TS_PARSING is in flight. In an xpc-required app the
    // analysis runs in a supervisor session reached through main's adapter-bridge child: killing that bridge
    // ends the session (the supervisor kills its worker) and the job fails ADAPTER_ISOLATION_UNAVAILABLE,
    // without a runtime restart.
    phase('analyzer-owner-kill');
    let capture = await app.evaluateHandle(installOwnerCapture, { userData: plan.paths.userData, names: owners });
    try {
      await page.evaluate(() => window.codeIntelligenceDesktop.restartRuntime());
      await waitReady('after-ipc-restart');
      assert.deepEqual(await capture.evaluate(h => h.captured()), owners, 'OWNERS_NOT_CAPTURED');
    } finally { await capture.evaluate(h => h.restore()).catch(() => {}); }
    const bridges = isolated ? await app.evaluateHandle(installBridgeCapture, { userData: plan.paths.userData }) : null;
    let analyzerJob, analyzerAt, analyzerKill, analyzerRecovery, next;
    try {
      analyzerJob = await uiReanalysis(projectId, 'b');
      analyzerAt = await awaitJob(analyzerJob, job => running('TS_PARSING')(job) && (stepOf(job, 'TS_PARSING').progressPct ?? 0) >= 20, 'B_TS_PARSING');
      next = await app.evaluateHandle(installOwnerCapture, { userData: plan.paths.userData, names: owners });
      analyzerKill = isolated ? await bridges.evaluate(h => h.kill()) : await capture.evaluate(h => h.kill('ts-analyzer'));
      analyzerRecovery = await waitReady('after-analyzer-kill', { sawDown: !isolated });
    } finally { await bridges?.evaluate(h => h.restore()).catch(() => {}); }
    const analyzerEnd = await awaitJob(analyzerJob, terminal, 'B_TERMINAL');
    assert.equal(analyzerEnd.status, 'FAILED', 'B_NOT_FAILED');
    if (isolated) assert.equal(analyzerEnd.failureCode, 'ADAPTER_ISOLATION_UNAVAILABLE', 'B_FAILURE_CODE');
    await assertPrevious(projectId, baseline, 'B');
    if (!isolated) assert.deepEqual(await next.evaluate(h => h.captured()), owners, 'RESTART_OWNERS_NOT_CAPTURED');
    report.scenarios.analyzerKill = { progressAtKill: stepOf(analyzerAt, 'TS_PARSING').progressPct, kill: analyzerKill,
      killed: isolated ? 'adapter-bridge' : 'ts-analyzer', appObservedNotReady: analyzerRecovery.observedNotReady, job: jobView(analyzerEnd) };
    report.checks.push(isolated ? 'adapter-bridge-sigkill-mid-request-fails-job-with-isolation-code-runtime-stays-ready-previous-result-intact'
      : 'analyzer-sigkill-mid-request-terminal-no-orphan-lock-previous-result-intact');

    // C: SIGKILL of the backend child (app-owned) mid-analysis; app's own restart + startup recovery.
    phase('backend-owner-kill');
    if (isolated) { await next.evaluate(h => h.restore()).catch(() => {}); next = await app.evaluateHandle(installOwnerCapture,
      { userData: plan.paths.userData, names: owners }); await page.evaluate(() => window.codeIntelligenceDesktop.restartRuntime());
      await waitReady('before-backend-kill'); assert.deepEqual(await next.evaluate(h => h.captured()), owners, 'OWNERS_NOT_CAPTURED'); }
    capture = next;
    const backendJob = await uiReanalysis(projectId, 'c');
    const backendAt = await awaitJob(backendJob, job => job.status === 'RUNNING'
      && ['DONE'].includes(stepOf(job, 'IMPORT').status) && runningStep(job) !== null, 'C_RUNNING');
    const after = await app.evaluateHandle(installOwnerCapture, { userData: plan.paths.userData, names: owners });
    const backendKill = await capture.evaluate(h => h.kill('backend'));
    const backendRecovery = await waitReady('after-backend-kill', { sawDown: true });
    const backendEnd = await awaitJob(backendJob, terminal, 'C_TERMINAL');
    assert.equal(backendEnd.status, 'FAILED', 'C_NOT_FAILED');
    await assertPrevious(projectId, baseline, 'C');
    await after.evaluate(h => h.restore()).catch(() => {});
    report.scenarios.backendKill = { runningStepAtKill: runningStep(backendAt), kill: backendKill,
      appObservedNotReady: backendRecovery.observedNotReady, job: jobView(backendEnd) };
    report.checks.push('backend-sigkill-mid-job-startup-recovery-terminal-previous-result-intact');

    phase('restart-after-kills'); await close(); await launch('after-kills');
    await assertPrevious(projectId, baseline, 'RESTART');
    for (const id of [raced, analyzerJob, backendJob]) {
      assert(TERMINAL.includes((await ok('/api/jobs/' + id)).status), 'JOB_NOT_TERMINAL_AFTER_RESTART');
    }
    report.checks.push('app-restart-keeps-terminal-jobs-no-lock-previous-result');

    phase('reanalysis-after-races');
    const finalJob = await uiReanalysis(projectId, 'final');
    const finalEnd = await awaitJob(finalJob, terminal, 'FINAL');
    assert.equal(finalEnd.status, 'DONE', 'FINAL_NOT_DONE');
    const latest = (await ok(`/api/projects/${projectId}`)).currentSnapshot.id;
    assert.notEqual(latest, baselineId, 'FINAL_NOT_PUBLISHED');
    const latestContent = await ok(`/api/projects/${projectId}/file-content?path=${encodeURIComponent(CHANGED_FILE)}&snapshotId=${latest}`);
    assert(latestContent.content.includes('job-race final'), 'FINAL_CONTENT_MISSING');
    assert.deepEqual(await snapshotState(projectId, baselineId), baseline, 'HISTORY_CHANGED_BY_NEW_RESULT');
    report.scenarios.reanalysisAfterRaces = { snapshotId: latest, job: jobView(finalEnd) };
    report.checks.push('later-reanalysis-succeeds-and-history-retained');

    phase('delete-after-terminal');
    assert.equal((await api(`/api/projects/${projectId}`, 'DELETE')).status, 204, 'DELETE_AFTER_TERMINAL');
    assert.deepEqual(await ok('/api/projects'), [], 'PROJECT_LIST_NOT_EMPTY');
    await close(); await launch('after-delete');
    assert.deepEqual(await ok('/api/projects'), [], 'DELETED_PROJECT_RETURNED');
    report.checks.push('delete-after-terminal-persists-across-restart');
    assert.equal(pageErrors, 0, 'RENDERER_ERRORS');
    await close();
    report.status = 'PASS';
  } catch (error) {
    failure = error;
    report.status = 'FAIL';
    report.failure = { phase: report.phase, code: /^[A-Z][A-Z0-9_]{2,80}$/.test(error?.message || '') ? error.message : 'JOB_RACE_STEP_FAILED',
      errorName: ['AssertionError', 'TimeoutError', 'Error'].includes(error?.name) ? error.name : null,
      detail: String(error?.message || '').split('\n')[0].replace(/[^ -~\uAC00-\uD7A3]/g, '?').slice(0, 200) };
  } finally {
    try { await close(); } catch { if (!failure) { report.status = 'FAIL'; report.failure = { phase: 'cleanup', code: 'CLEANUP_FAILED' }; } else report.cleanupFailure = true; }
    try {
      assert.equal(hash(manifestFile), report.manifestSha256);
      assert.equal(hash(path.join(appBundle, 'Contents/Resources/app.asar')), report.appAsarSha256);
    } catch { report.status = 'FAIL'; report.finalIdentityFailure = true; }
    report.finishedAt = new Date().toISOString(); save();
  }
  console.log(JSON.stringify({ status: report.status, evidence, phase: report.phase, checks: report.checks.length }));
  if (report.status !== 'PASS') process.exitCode = 1;
}
module.exports = { main, installBridgeCapture, installOwnerCapture };
if (require.main === module) main().catch(() => { console.error('JOB_RACE_PRODUCT_REFUSED'); process.exitCode = 1; });
