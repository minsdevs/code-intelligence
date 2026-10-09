'use strict';

// G-PERF workload measurement of a retained development app. A generated synthetic fixture
// is imported through the real packaged UI into one new isolated profile; every run is a
// fresh app launch that previews, analyzes, explores, refreshes after a 1% change, cancels
// a second import and deletes its projects. Never a release, real profile or real account.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const { createRequire } = require('node:module');
const { execFileSync } = require('node:child_process');
const { ensureOutputParent } = require('./owned-output.cjs');
const { prepareIsolatedRun } = require('../../desktop/src/isolated-run.cjs');
const { validateRuntimeManifest } = require('../../desktop/src/runtime-manifest.cjs');
const { launchEnvironment, bounded } = require('../../desktop/scripts/packaged-keychain-acceptance.cjs');
const { observeStartup, closeValidatedApplication } = require('../../desktop/scripts/native-acceptance-electron.cjs');
const { captureOwnedApplication } = require('../backup-compatibility/interruption-hooks.cjs');
const { startOwnedPhaseSampler } = require('./workload-sampler.cjs');
const { observePowerSource, acObservedAtRunBoundaries, confirmObservedGone } = require('./run-startup-benchmark.cjs');
const { SIZE_CLASSES, generateWorkload, hashTree, mutateWorkload } = require('./workload-fixture.cjs');
const { SLO, evaluateRow, describeSmoke, phaseSamplingComplete, installWorkloadWatch, installWorkloadClick } = require('./workload-metrics.cjs');
const { expectedServices } = require('./adapter-mode.cjs');
const { withDropConfirmation } = require('./drop-confirmation.cjs');
// The analysis results table in either UI language (English is the product default).
const RESULT_ROWS = 'table[aria-label="Analysis results table"] tbody tr, table[aria-label="분석 결과 표"] tbody tr';

const hash = file => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
// `delete` is a diagnostic row (project deletion time), not an SLO row; it runs only on request.
// `preview` alone measures admission and inspection without approving an analysis (large class).
const ROWS = Object.freeze(['preview', 'analysis', 'graph', 'incremental', 'cancel', 'delete']);
const DEFAULT_ROWS = Object.freeze(['analysis', 'graph', 'incremental', 'cancel']);
const DELETE_TIMEOUT_MS = 30 * 60000;
const STARTUP_TIMEOUT_MS = 90000;
const GiB = 1024 * 1024 * 1024;
// Analysis observation limits. large uses the SLO's own 15-minute hard timeout; the other
// classes wait longer than their SLO so a slow run is measured instead of only labelled.
const CLASS_SETTINGS = Object.freeze({
  small: Object.freeze({ analysisTimeoutMs: 15 * 60000, diskReserveBytes: 1 * GiB }),
  medium: Object.freeze({ analysisTimeoutMs: 30 * 60000, diskReserveBytes: Math.round(1.5 * GiB) }),
  large: Object.freeze({ analysisTimeoutMs: 15 * 60000, diskReserveBytes: 4 * GiB }),
});
const MINIMUM_FREE_BYTES = 2 * GiB;
const GRAPH_REPEATS = 5;
// Cancel after the job has been in a long-running step for a fixed time.
const CANCEL_TRIGGER = Object.freeze({ steps: ['IMPORT', 'SOURCE_PARSING', 'GRAPH_BUILD', 'TS_PARSING'], afterMs: 1000 });
const codes = new Set(['API_TIMEOUT', 'API_STATUS', 'API_TRANSPORT_FAILED', 'API_OBSERVATION_FAILED',
  'STARTUP_TIMEOUT', 'STARTUP_SDK_TIMEOUT', 'STARTUP_FAILED', 'STARTUP_PROCESS_EXITED',
  'PREVIEW_FAILED', 'PREVIEW_ADMISSION_MISMATCH', 'ANALYSIS_START_FAILED', 'ANALYSIS_FAILED', 'ANALYSIS_CANCELLED',
  'ANALYSIS_TIMEOUT', 'ANALYSIS_HARD_TIMEOUT', 'OVERVIEW_NOT_SHOWN', 'GRAPH_API_FAILED', 'GRAPH_RENDER_FAILED',
  'INCREMENTAL_FAILED', 'INCREMENTAL_TIMEOUT', 'CANCEL_TRIGGER_MISSED', 'CANCEL_FAILED', 'CANCEL_TIMEOUT',
  'PROJECT_DELETE_FAILED', 'CANCEL_LOCK_NOT_RELEASED', 'CANCEL_ENDED_WITHOUT_CANCELLED', 'MEMORY_SAMPLE_FAILED', 'MEMORY_EVIDENCE_LIMIT', 'MEMORY_SAMPLING_INCOMPLETE',
  'OBSERVED_PROCESSES_REMAIN', 'WORKLOAD_FIXTURE_CHANGED', 'DISK_SPACE_LOW', 'NATIVE_ELECTRON_CLOSE_TIMEOUT',
  'NATIVE_ELECTRON_EXIT_TIMEOUT', 'NATIVE_ELECTRON_UNCLEAN_EXIT', 'NATIVE_SHUTDOWN_RECOVERY_REQUIRED',
  'NATIVE_SHUTDOWN_UNCONFIRMED', 'NATIVE_SHUTDOWN_DIAGNOSTIC_TIMEOUT', 'NOT_RUN_AFTER_ANALYSIS_FAILURE', 'WORKLOAD_HOST_OBSERVATION_FAILED',
  'WORKLOAD_DIAGNOSTIC_ENVIRONMENT_UNSAFE']);
function failureCode(error, fallback = 'WORKLOAD_BENCHMARK_CHECK_FAILED') {
  let message; try { message = error?.message; } catch { /* Do not inspect thrown details. */ }
  return codes.has(message) ? message : fallback;
}
async function stage(code, action) {
  try { return await action(); }
  catch (error) {
    const failure = new Error(failureCode(error, code));
    failure.stage = code;
    if (Number.isInteger(error?.status) && error.status >= 100 && error.status <= 599) failure.status = error.status;
    throw failure;
  }
}

function argumentsFor(argv) {
  assert(Array.isArray(argv) && argv.length >= 5 && argv.length <= 9);
  assert(argv[0] === '--app' && typeof argv[1] === 'string' && path.isAbsolute(argv[1]) && !/[\x00-\x1f\x7f]/.test(argv[1]));
  assert(argv[2] === '--class' && Object.hasOwn(SIZE_CLASSES, argv[3]));
  const mode = argv[4];
  assert(['--smoke-1', '--smoke-2', '--series-20'].includes(mode));
  const options = { app: argv[1], sizeClass: argv[3], runs: Number(mode.slice(mode.lastIndexOf('-') + 1)),
    series: mode === '--series-20', rows: [...DEFAULT_ROWS], keepWork: false, diagnosticOnly: false };
  let rowsGiven = false;
  for (let index = 5; index < argv.length; index++) {
    if (argv[index] === '--keep-work') { assert(!options.keepWork && !options.series); options.keepWork = true; continue; }
    if (argv[index] === '--diagnostic-only') { assert(!options.diagnosticOnly && !options.series); options.diagnosticOnly = true; continue; }
    assert(argv[index] === '--rows' && index + 1 < argv.length && !rowsGiven);
    rowsGiven = true;
    const rows = argv[++index].split(',');
    assert(rows.length > 0 && rows.every(row => ROWS.includes(row)) && new Set(rows).size === rows.length
      && (rows.length === 1 && rows[0] === 'preview' ? true : rows.includes('analysis') && !rows.includes('preview')));
    options.rows = ROWS.filter(row => rows.includes(row));
  }
  return options;
}

// Parses an ISO instant with up to nanosecond precision into epoch milliseconds (fractional).
function instantMs(value) {
  if (typeof value !== 'string') return null;
  const match = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(?:\.(\d{1,9}))?Z$/.exec(value);
  if (!match) return null;
  const whole = Date.parse(match[1] + 'Z');
  return Number.isFinite(whole) ? whole + Number('0.' + (match[2] ?? '0')) * 1000 : null;
}
const publicCode = value => typeof value === 'string' && /^[A-Z][A-Z_]{0,79}$/.test(value) ? value : null;
function stepTimings(job) {
  return (Array.isArray(job?.steps) ? job.steps : []).slice(0, 32).map(step => {
    const started = instantMs(step.startedAt), finished = instantMs(step.finishedAt);
    return { key: publicCode(step.stepKey), status: publicCode(step.status), progressPct: Number.isSafeInteger(step.progressPct) ? step.progressPct : null,
      durationMs: started !== null && finished !== null ? Math.round(finished - started) : null };
  });
}
function jobTimings(job) {
  const created = instantMs(job?.createdAt), started = instantMs(job?.startedAt), finished = instantMs(job?.finishedAt);
  return { status: publicCode(job?.status), failureCode: publicCode(job?.failureCode),
    queuedMs: created !== null && started !== null ? Math.round(started - created) : null,
    runMs: started !== null && finished !== null ? Math.round(finished - started) : null,
    steps: stepTimings(job) };
}
function failedStep(job) {
  return stepTimings(job).find(step => step.status === 'FAILED')?.key ?? null;
}

function observeQuietHost() {
  let output;
  try { output = execFileSync('/usr/bin/pgrep', ['-x', 'mdworker_shared'], { encoding: 'utf8', timeout: 5000, stdio: ['ignore', 'pipe', 'pipe'] }); }
  catch (error) {
    if (error.status !== 1 || String(error.stdout ?? '').trim()) throw new Error('WORKLOAD_HOST_OBSERVATION_FAILED');
    output = '';
  }
  const text = output.trim();
  if (text && !/^\d+(?:\n\d+)*$/.test(text)) throw new Error('WORKLOAD_HOST_OBSERVATION_FAILED');
  let lidState = 'UNKNOWN';
  try {
    const state = execFileSync('/usr/sbin/ioreg', ['-r', '-k', 'AppleClamshellState', '-d', '1'],
      { encoding: 'utf8', timeout: 5000, maxBuffer: 65536 });
    const matches = [...state.matchAll(/"AppleClamshellState"\s*=\s*(Yes|No)\b/g)];
    if (matches.length === 1) lidState = matches[0][1] === 'No' ? 'OPEN' : 'CLOSED';
  } catch { /* Unobservable power conditions never admit a run. */ }
  return { observedAt: new Date().toISOString(), loadAverage: os.loadavg(), mdworkers: text ? text.split('\n').length : 0,
    powerSource: observePowerSource(), lidState };
}

async function waitForQuietHost({ observe = observeQuietHost, pause = ms => new Promise(resolve => setTimeout(resolve, ms)),
  requiredFreeBytes = 0, readFreeBytes = () => freeBytes('/private/tmp'), diagnosticOnly = false } = {}) {
  const started = performance.now();
  let observations = [], rejectedObservations = 0;
  for (;;) {
    const sample = observe();
    if (!Array.isArray(sample.loadAverage) || sample.loadAverage.length !== 3
      || !sample.loadAverage.every(value => Number.isFinite(value) && value >= 0)
      || !Number.isSafeInteger(sample.mdworkers) || sample.mdworkers < 0) throw new Error('WORKLOAD_HOST_OBSERVATION_FAILED');
    if (diagnosticOnly && (sample.powerSource !== 'AC' || !['OPEN', 'CLOSED'].includes(sample.lidState))) {
      throw new Error('WORKLOAD_DIAGNOSTIC_ENVIRONMENT_UNSAFE');
    }
    if (diagnosticOnly || (sample.loadAverage[0] < 4 && sample.mdworkers <= 6 && sample.powerSource === 'AC' && sample.lidState === 'OPEN')) observations.push(sample);
    else { observations = []; rejectedObservations++; }
    // No final sleep: the admitting observation immediately precedes launch.
    if (diagnosticOnly || observations.length === 3) {
      const availableBytes = readFreeBytes();
      if (!Number.isSafeInteger(availableBytes) || availableBytes < requiredFreeBytes) throw new Error('DISK_SPACE_LOW');
      return { status: diagnosticOnly ? 'DIAGNOSTIC_ONLY' : 'ADMITTED', loadAverageLimit: 4, mdworkerLimit: 6, freeBytes: availableBytes, requiredFreeBytes,
        sampleIntervalMs: diagnosticOnly ? null : 30000, waitedMs: Math.round(performance.now() - started), rejectedObservations, observations,
        timingValidity: diagnosticOnly ? (sample.loadAverage[0] >= 4 || sample.mdworkers > 6 ? 'INVALID_LOAD' : 'NOT_APPLICABLE_DIAGNOSTIC') : 'QUIET_HOST_OBSERVED_AT_LAUNCH' };
    }
    await pause(30000);
  }
}

function freeBytes(directory) {
  const stat = fs.statfsSync(directory);
  return Number(stat.bavail) * Number(stat.bsize);
}
function directoryBytes(root) {
  // Allocated bytes of a private tree, without following links.
  let total = 0;
  const visit = directory => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const file = path.join(directory, entry.name), stat = fs.lstatSync(file, { bigint: true });
      total += Number(stat.blocks) * 512;
      if (stat.isDirectory()) visit(file);
    }
  };
  try { visit(root); } catch { return null; }
  return total;
}
function cloneTree(source, destination) {
  // APFS clone of the pristine fixture: no data copy, and the import sees a fresh path.
  execFileSync('/bin/cp', ['-c', '-R', '-p', source, destination], { timeout: 300000, stdio: 'pipe' });
}

async function main(argv = process.argv.slice(2)) {
  const options = argumentsFor(argv);
  assert.equal(process.platform, 'darwin'); assert.equal(process.arch, 'arm64');
  process.umask(0o077);
  const settings = CLASS_SETTINGS[options.sizeClass], size = SIZE_CLASSES[options.sizeClass];
  const repo = fs.realpathSync(path.resolve(__dirname, '../..')), app = fs.realpathSync(options.app);
  assert.equal(app, options.app); assert.equal(path.dirname(path.dirname(app)), repo);
  assert.equal(path.basename(app), 'Code Intelligence Validation.app');
  assert.match(path.basename(path.dirname(app)), /^\.native-product-[A-Za-z0-9]+$/);
  const runtime = path.join(app, 'Contents/Resources/runtime'), manifestFile = path.join(runtime, 'runtime-manifest.json');
  const manifest = JSON.parse(fs.readFileSync(manifestFile));
  await validateRuntimeManifest(runtime, manifest);
  execFileSync('/usr/bin/codesign', ['--verify', '--deep', '--strict', app], { stdio: 'pipe', timeout: 30000 });
  const freeAtStart = freeBytes('/private/tmp');
  if (freeAtStart < MINIMUM_FREE_BYTES + settings.diskReserveBytes) {
    console.log(JSON.stringify({ status: 'BLOCKED', failure: 'DISK_SPACE_LOW', freeBytes: freeAtStart,
      requiredBytes: MINIMUM_FREE_BYTES + settings.diskReserveBytes }));
    process.exitCode = 1; return null;
  }
  const evidence = fs.mkdtempSync(path.join(ensureOutputParent(repo, 'validation/local/workload-performance'), 'run-'));
  const work = fs.mkdtempSync('/private/tmp/ciwl-'), profileParent = fs.mkdtempSync('/private/tmp/ciwp-');
  const pristine = path.join(work, 'fixture'); fs.mkdirSync(pristine, { mode: 0o700 });
  const generationStarted = performance.now();
  const fixture = generateWorkload({ root: pristine, sizeClass: options.sizeClass });
  const generationMs = Math.round(performance.now() - generationStarted);
  assert.equal(hashTree(pristine).treeSha256, fixture.treeSha256);
  // Every run gets a new synthetic profile: no measured run depends on deleting a previous
  // project, and only one run's data occupies disk at a time.
  let plan;
  const newPlan = () => prepareIsolatedRun({ parentDirectory: profileParent, runtimeDirectory: runtime, purpose: 'automation',
    forbiddenRoots: ['Code Intelligence', 'Code Intelligence Validation']
      .map(name => path.join(os.homedir(), 'Library/Application Support', name)) });
  const requireFrontend = createRequire(path.join(repo, 'frontend/package.json'));
  const { _electron } = requireFrontend('playwright'), { expect } = requireFrontend('@playwright/test');
  const inputs = [__filename, path.join(__dirname, 'workload-sampler.cjs'), path.join(__dirname, 'workload-metrics.cjs'), path.join(__dirname, 'workload-fixture.cjs'),
    path.join(__dirname, 'startup-metrics.cjs'), path.join(__dirname, 'process-memory.cjs'), path.join(__dirname, 'drop-confirmation.cjs'),
    path.join(__dirname, 'run-startup-benchmark.cjs'), path.join(repo, 'desktop/scripts/native-acceptance-electron.cjs'),
    path.join(repo, 'desktop/src/isolated-run.cjs')];
  const sources = Object.fromEntries(inputs.map(file => [path.relative(repo, file), hash(file)]));
  const report = { format: 1, status: 'RUNNING', scope: 'synthetic-workload-import-through-packaged-ui',
    mode: options.diagnosticOnly ? 'DIAGNOSTIC' : options.series ? 'SERIES' : 'SMOKE', sizeClass: options.sizeClass, requestedRuns: options.runs, rows: options.rows,
    performanceAcceptanceEligible: options.series && !options.diagnosticOnly, resourceSamplesFormat: 2,
    slo: Object.fromEntries(Object.entries(SLO).filter(([, value]) => value.sizeClass === options.sizeClass)),
    analysisTimeoutMs: settings.analysisTimeoutMs, sampleIntervalMs: 100, graphRepeats: GRAPH_REPEATS, cancelTrigger: CANCEL_TRIGGER,
    cachePolicy: 'warm: OS cache not flushed; one warm-up launch; each run starts a new synthetic profile (initialized before the measured rows) and digests its fixture clone immediately before import',
    deleteTimeoutMs: DELETE_TIMEOUT_MS,
    fixture: { ...fixture, generationMs, location: 'private temporary directory, removed after the series unless --keep-work' },
    sourceCommit: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repo, encoding: 'utf8' }).trim(), sources,
    app, appAsarSha256: hash(path.join(app, 'Contents/Resources/app.asar')), manifestSha256: hash(manifestFile),
    buildSequence: manifest.buildSequence, evidence, mockKeychain: true, realAccount: false, originalProfileAccessed: false,
    productChanged: false, coldCacheMeasured: false, releaseVerdict: 'NO_GO',
    environment: { platform: process.platform, arch: process.arch, node: process.version,
      osVersion: execFileSync('/usr/bin/sw_vers', ['-productVersion'], { encoding: 'utf8' }).trim(),
      hardware: execFileSync('/usr/sbin/sysctl', ['-n', 'hw.model'], { encoding: 'utf8' }).trim(),
      cpuBrand: execFileSync('/usr/sbin/sysctl', ['-n', 'machdep.cpu.brand_string'], { encoding: 'utf8' }).trim(),
      performanceCores: Number(execFileSync('/usr/sbin/sysctl', ['-n', 'hw.perflevel0.physicalcpu'], { encoding: 'utf8' }).trim()),
      logicalCpus: os.cpus().length, memoryBytes: os.totalmem(), loadAverageAfterFixturePreparation: os.loadavg(), loadAverageBefore: null, freeBytesAtStart: freeAtStart,
      power: observePowerSource(), backgroundState: 'shared development machine; other agents may run builds/tests; packaged-app launches serialized by the caller-held native lock',
      powerObservationScope: 'Series start, quiet-admission samples and both boundaries of each run; not continuous monitoring',
      loadObservationScope: options.diagnosticOnly
        ? 'Diagnostic opt-in: one actual AC/lid/load observation before every launch; no performance or RSS release acceptance'
        : 'Three AC/open-lid/quiet observations 30 seconds apart after fixture preparation and before every app launch; not continuous monitoring' },
    warmup: null, runs: [] };
  const save = () => fs.writeFileSync(path.join(evidence, 'result.json'), JSON.stringify(report, null, 2) + '\n', { mode: 0o600 });
  const sampleFile = path.join(evidence, 'resource-samples.csv'), fd = fs.openSync(sampleFile, 'wx', 0o600);
  fs.writeSync(fd, 'sequence,elapsed_ms,phase,pid,ppid,rss_kib,scope_owner_pid\n');
  save(); console.log(JSON.stringify({ status: 'RUNNING', evidence, sizeClass: options.sizeClass, runs: options.runs, treeSha256: fixture.treeSha256 }));

  async function launch(sample, started) {
    const expires = started + STARTUP_TIMEOUT_MS;
    const remaining = () => { const ms = Math.floor(expires - performance.now()); if (ms <= 0) throw new Error('STARTUP_TIMEOUT'); return ms; };
    const sdk = await _electron.launch({ executablePath: path.join(app, 'Contents/MacOS/Code Intelligence Validation'),
      args: ['--use-mock-keychain', '--isolated-run-claim=' + plan.claimFile], cwd: repo,
      env: launchEnvironment(process.env), timeout: remaining() });
    const owner = captureOwnedApplication(sdk);
    sample.pid = owner.process().pid;
    return { sdk, owner, remaining };
  }
  async function ready(sdk, remaining) {
    const page = await sdk.firstWindow({ timeout: remaining() });
    await expect(page.getByRole('link', { name: 'Code Intelligence home' })).toBeVisible({ timeout: remaining() });
    const identity = await bounded(() => sdk.evaluate(({ app }) => ({ name: app.getName(), profile: app.getPath('userData'), packaged: app.isPackaged })), remaining(), 'STARTUP_TIMEOUT');
    assert.deepEqual(identity, { name: plan.appIdentity.name, profile: plan.paths.userData, packaged: true });
    const status = await bounded(() => page.evaluate(() => window.codeIntelligenceDesktop.runtimeStatus()), remaining(), 'STARTUP_TIMEOUT');
    assert.equal(status.ready, true); assert.equal(status.recoveryOnly, false); assert.equal(status.error, null); assert.equal(status.aiOff, true);
    assert.deepEqual([...status.services].sort(), expectedServices(app));
    page.setDefaultTimeout(30000);
    return page;
  }

  function driver(page, sdk) {
    const api = async (route, method = 'GET', timeoutMs = 60000) => {
      const result = await bounded(() => page.evaluate(async ({ route, method }) => {
        const desktop = window.codeIntelligenceDesktop;
        const headers = { 'X-Code-Intelligence-Token': desktop.apiToken };
        if (method !== 'GET') {
          const prime = await fetch(desktop.apiBaseUrl + '/api/csrf', { credentials: 'include', headers });
          if (!prime.ok) return { status: prime.status };
          const cookie = document.cookie.split(';').map(part => part.trim()).find(part => part.startsWith('XSRF-TOKEN='));
          if (cookie) headers['X-XSRF-TOKEN'] = decodeURIComponent(cookie.slice('XSRF-TOKEN='.length));
        }
        const response = await fetch(desktop.apiBaseUrl + route, { method, credentials: 'include', headers });
        const text = await response.text();
        return { status: response.status, body: response.ok && text ? JSON.parse(text) : null };
      }, { route, method }), timeoutMs, 'API_TIMEOUT');
      if (!(result.status >= 200 && result.status < 300)) throw Object.assign(new Error('API_STATUS'), { status: result.status });
      return result.body;
    };
    // Times measured inside the renderer: request start to body read, without IPC overhead.
    const timedGets = routes => bounded(() => page.evaluate(async routes => {
      const desktop = window.codeIntelligenceDesktop, out = [];
      const headers = { 'X-Code-Intelligence-Token': desktop.apiToken };
      for (const route of routes) {
        const begin = performance.now();
        const response = await fetch(desktop.apiBaseUrl + route, { credentials: 'include', headers });
        const text = await response.text();
        out.push({ status: response.status, ms: performance.now() - begin, bytes: text.length, body: response.ok ? text : null });
      }
      return out;
    }, routes), 120000, 'GRAPH_API_FAILED');
    const navigate = route => page.evaluate(route => { history.pushState(null, '', route); window.dispatchEvent(new PopStateEvent('popstate')); }, route);
    // In-renderer marks: a capture-phase click time and the first DOM time a condition holds.
    const watch = (name, condition) => page.evaluate(installWorkloadWatch, { name, condition: { ...condition, RESULT_ROWS } });
    const markClick = name => page.evaluate(installWorkloadClick, name);
    const marks = () => page.evaluate(() => ({ ...(window.__workload?.marks ?? {}), now: performance.now() }));
    const waitMark = async (name, timeoutMs, code) => {
      const expires = performance.now() + timeoutMs;
      for (;;) {
        const current = await marks();
        if (current[name] !== undefined) return current;
        if (performance.now() >= expires) throw new Error(code);
        await new Promise(resolve => setTimeout(resolve, 50));
      }
    };
    // Polls a job inside the renderer; returns the first terminal detail and its renderer time.
    const pollJob = (jobId, { intervalMs, timeoutMs, until = ['DONE', 'FAILED', 'CANCELLED'], onStep, onObservation }) => (async () => {
      const expires = performance.now() + timeoutMs;
      for (;;) {
        const observed = await bounded(() => page.evaluate(async id => {
          const desktop = window.codeIntelligenceDesktop;
          try {
            const response = await fetch(desktop.apiBaseUrl + '/api/jobs/' + id, { credentials: 'include', headers: { 'X-Code-Intelligence-Token': desktop.apiToken } });
            return { status: response.status, at: performance.now(), job: response.ok ? await response.json() : null };
          } catch { return { transportFailed: true }; }
        }, jobId), 60000, 'API_TIMEOUT').catch(error => { throw new Error(failureCode(error, 'API_OBSERVATION_FAILED')); });
        if (observed.transportFailed) throw new Error('API_TRANSPORT_FAILED');
        if (observed.status !== 200) throw Object.assign(new Error('API_STATUS'), { status: observed.status });
        onObservation?.(observed);
        if (until.includes(observed.job.status)) return observed;
        if (onStep && await onStep(observed)) return observed;
        if (performance.now() >= expires) return { ...observed, timedOut: true };
        await new Promise(resolve => setTimeout(resolve, intervalMs));
      }
    })();
    const confirmDrop = (folder, action) => withDropConfirmation(sdk, folder, action);
    return { api, timedGets, navigate, watch, markClick, marks, waitMark, pollJob, confirmDrop };
  }

  async function importAndPreview(page, d, folder, measurement) {
    await d.navigate('/import');
    const picker = page.getByRole('button', { name: 'Choose folder', exact: true });
    await expect(picker).toBeVisible();
    const bounds = await picker.boundingBox(); assert.ok(bounds);
    const button = page.getByRole('button', { name: /^(Preview files to import|가져올 파일 미리보기)$/ });
    // The preview button appears only after main granted the drop, so the SEC-M-02 confirmation is
    // answered and verified before any timed mark starts.
    const { confirmation } = await d.confirmDrop(folder, async () => {
      const cdp = await page.context().newCDPSession(page);
      try {
        // Chromium's native drag protocol supplies the real folder; the unmodified UI calls
        // preload -> folder:authorize -> the product's folder policy.
        const data = { items: [], files: [folder], dragOperationsMask: 1 };
        for (const type of ['dragEnter', 'dragOver', 'drop']) await cdp.send('Input.dispatchDragEvent', {
          type, x: bounds.x + bounds.width / 2, y: bounds.y + bounds.height / 2, data });
      } finally { await bounded(cdp.detach(), 5000, 'PREVIEW_FAILED').catch(() => {}); }
      await expect(button).toBeVisible();
    });
    (report.dropConfirmations ??= []).push(confirmation);
    await d.markClick('previewClick');
    await d.watch('previewAck', { kind: 'button', text: ['Inspecting…', '검사 중…'], after: 'previewClick' });
    await d.watch('previewShown', { kind: 'region', label: ['Import preview to review', '확인할 가져오기 미리보기'], after: 'previewClick' });
    const [response] = await Promise.all([
      page.waitForResponse(r => new URL(r.url()).pathname === '/api/projects/local/preview' && r.request().method() === 'POST', { timeout: 120000 }),
      button.click(),
    ]);
    measurement.previewHttpStatus = response.status();
    if (!response.ok()) {
      const shown = await d.marks();
      measurement.previewResponseMs = Math.round(shown.now - shown.previewClick);
      throw new Error('PREVIEW_FAILED');
    }
    const preview = await response.json();
    const shown = await d.waitMark('previewShown', 60000, 'PREVIEW_FAILED');
    measurement.previewFirstResponseMs = shown.previewAck !== undefined ? Math.round(shown.previewAck - shown.previewClick) : null;
    measurement.previewCompleteMs = Math.round(shown.previewShown - shown.previewClick);
    measurement.localImport = preview.localImport;
    return preview;
  }
  async function approve(page, d) {
    await d.markClick('approveClick');
    const [created] = await Promise.all([
      page.waitForResponse(r => new URL(r.url()).pathname === '/api/projects/local' && r.request().method() === 'POST', { timeout: 60000 }),
      page.getByRole('button', { name: /^(Import and analyze the reviewed files|확인한 파일 가져오기 및 분석)$/ }).click(),
    ]);
    if (!created.ok()) throw new Error('ANALYSIS_START_FAILED');
    const body = await created.json();
    assert(Number.isSafeInteger(body?.jobId) && Number.isSafeInteger(body?.project?.id));
    return { jobId: body.jobId, projectId: body.project.id };
  }

  async function analysisRow(page, d, sampler, run, folder) {
    const row = run.rows.analysis = { status: 'RUNNING', metrics: {}, failure: null };
    await sampler.phase('PREVIEW');
    const preview = await stage('PREVIEW_FAILED', () => importAndPreview(page, d, folder, row.metrics));
    row.localImport = preview.localImport;
    run.admittedFiles = preview.localImport?.acceptedFiles ?? null;
    if (preview.localImport?.acceptedFiles !== fixture.files) row.admissionMismatch = true;
    await sampler.phase('ANALYSIS');
    const started = await stage('ANALYSIS_START_FAILED', () => approve(page, d));
    run.projectId = started.projectId; row.jobId = started.jobId;
    await d.watch('overview', { kind: 'rows', path: `^/projects/${started.projectId}/overview$`, minimum: 1 });
    const outcome = await stage('ANALYSIS_FAILED', () => d.pollJob(started.jobId, { intervalMs: 1000, timeoutMs: settings.analysisTimeoutMs,
      onObservation: observed => { row.lastObservedJob = jobTimings(observed.job); } }));
    row.job = jobTimings(outcome.job);
    if (outcome.timedOut) throw new Error(options.sizeClass === 'large' ? 'ANALYSIS_HARD_TIMEOUT' : 'ANALYSIS_TIMEOUT');
    if (outcome.job.status !== 'DONE') { row.failedStep = failedStep(outcome.job); throw new Error(outcome.job.status === 'CANCELLED' ? 'ANALYSIS_CANCELLED' : 'ANALYSIS_FAILED'); }
    const shown = await d.waitMark('overview', 60000, 'OVERVIEW_NOT_SHOWN');
    row.metrics.analysisMs = Math.round(shown.overview - shown.approveClick);
    row.analysisWindowSampling = (await sampler.snapshot()).phases.ANALYSIS ?? null;
    run.snapshotId = (await d.api(`/api/projects/${started.projectId}`)).currentSnapshot.id;
    const coverage = await d.api(`/api/projects/${started.projectId}/coverage?snapshotId=${run.snapshotId}`);
    row.outcomes = coverage.outcomes;
    row.graphOverview = await d.api(`/api/projects/${started.projectId}/graph/overview?snapshotId=${run.snapshotId}`);
    if (row.admissionMismatch) throw new Error('PREVIEW_ADMISSION_MISMATCH');
  }

  async function graphRow(page, d, sampler, run) {
    const row = run.rows.graph = { status: 'RUNNING', metrics: {}, failure: null };
    await sampler.phase('GRAPH');
    const { projectId, snapshotId } = run;
    const first = await d.api(`/api/projects/${projectId}/graph/nodes?snapshotId=${snapshotId}&category=symbols&page=1&size=100&sort=path`);
    assert(first.items.length > 0);
    const terms = Array.from({ length: GRAPH_REPEATS }, (_, index) => `Item${(index * 37) % Math.max(1, fixture.modules.javaModules)}Service`);
    const pages = Array.from({ length: GRAPH_REPEATS }, (_, index) => 1 + (index * 7) % Math.max(1, Math.ceil(first.total / 100)));
    const nodes = Array.from({ length: GRAPH_REPEATS }, (_, index) => first.items[(index * 13) % first.items.length].id);
    const search = await d.timedGets(terms.map(term => `/api/search?projectId=${projectId}&q=${encodeURIComponent(term)}`));
    const pageCalls = await d.timedGets(pages.map(number => `/api/projects/${projectId}/graph/nodes?snapshotId=${snapshotId}&category=symbols&page=${number}&size=100&sort=path`));
    const relations = await d.timedGets(nodes.map(id => `/api/projects/${projectId}/graph/nodes/${id}/relations?direction=out&depth=2&snapshotId=${snapshotId}`));
    for (const call of [...search, ...pageCalls, ...relations]) if (call.status !== 200) throw new Error('GRAPH_API_FAILED');
    row.metrics.searchApiMs = search.map(call => Math.round(call.ms));
    row.metrics.nodePageApiMs = pageCalls.map(call => Math.round(call.ms));
    row.metrics.relationsApiMs = relations.map(call => Math.round(call.ms));
    row.resultSizes = { searchBytes: search.map(call => call.bytes), nodePageBytes: pageCalls.map(call => call.bytes),
      relationBytes: relations.map(call => call.bytes), symbolTotal: first.total,
      searchHits: search.map(call => { try { const body = JSON.parse(call.body); return Object.values(body).reduce((n, v) => n + (Array.isArray(v) ? v.length : 0), 0); } catch { return null; } }),
      relationsTruncated: relations.map(call => { try { return JSON.parse(call.body).truncated; } catch { return null; } }) };
    // The product has no 100-node graph canvas; the first rendered page of the overview
    // result table (40 rows) is the closest UI surface and is labelled as such.
    await stage('GRAPH_RENDER_FAILED', async () => {
      await d.navigate('/projects');
      await expect(page.getByRole('link', { name: 'Code Intelligence home' })).toBeVisible();
      await d.watch('firstPage', { kind: 'rows', path: `^/projects/${projectId}/overview$`, minimum: 1 });
      const begin = (await d.marks()).now;
      await d.navigate(`/projects/${projectId}/overview`);
      const shown = await d.waitMark('firstPage', 30000, 'GRAPH_RENDER_FAILED');
      row.metrics.firstPageRenderMs = Math.round(shown.firstPage - begin);
      row.firstPageRows = await page.locator(RESULT_ROWS).count();
    });
    row.firstPageScope = 'navigation to rendered first page of the overview result table; product page size is 40, there is no 100-node graph view';
    row.status = 'PASS';
  }

  async function incrementalRow(page, d, sampler, run, folder) {
    const row = run.rows.incremental = { status: 'RUNNING', metrics: {}, failure: null, checks: {} };
    await sampler.phase('INCREMENTAL');
    row.change = mutateWorkload({ root: folder, manifest: fixture });
    const { projectId } = run;
    await d.navigate(`/projects/${projectId}/overview`);
    const refresh = page.getByRole('button', { name: /^(Refresh status|상태 새로고침)$/ });
    await stage('INCREMENTAL_FAILED', async () => {
      await expect(refresh).toBeVisible();
      await d.markClick('statusClick');
      await refresh.click();
      const previewButton = page.getByRole('button', { name: /^(Preview changes|변경 사항 미리보기)$/ });
      await expect(previewButton).toBeVisible({ timeout: 120000 });
      const status = await d.marks();
      row.metrics.statusCheckMs = Math.round(status.now - status.statusClick);
      await d.markClick('refreshPreviewClick');
      await d.watch('refreshShown', { kind: 'region', label: ['Import preview to review', '확인할 가져오기 미리보기'], after: 'refreshPreviewClick' });
      await previewButton.click();
      const shown = await d.waitMark('refreshShown', 120000, 'INCREMENTAL_FAILED');
      row.metrics.refreshPreviewMs = Math.round(shown.refreshShown - shown.refreshPreviewClick);
    });
    await d.markClick('refreshClick');
    const [response] = await stage('INCREMENTAL_FAILED', () => Promise.all([
      page.waitForResponse(r => new URL(r.url()).pathname === `/api/projects/${projectId}/reanalyze` && r.request().method() === 'POST', { timeout: 60000 }),
      page.getByRole('button', { name: /^(Re-analyze after reviewing changes|변경 확인 후 재분석)$/ }).click(),
    ]));
    if (!response.ok()) throw new Error('INCREMENTAL_FAILED');
    const jobId = (await response.json()).jobId;
    const outcome = await stage('INCREMENTAL_FAILED', () => d.pollJob(jobId, { intervalMs: 250, timeoutMs: settings.analysisTimeoutMs }));
    row.job = jobTimings(outcome.job);
    if (outcome.timedOut) throw new Error('INCREMENTAL_TIMEOUT');
    if (outcome.job.status !== 'DONE') { row.failedStep = failedStep(outcome.job); throw new Error('INCREMENTAL_FAILED'); }
    const clicked = (await d.marks()).refreshClick;
    row.metrics.refreshMs = Math.round(outcome.at - clicked);
    row.pollIntervalMs = 250;
    const next = (await d.api(`/api/projects/${projectId}`)).currentSnapshot.id;
    assert.notEqual(next, run.snapshotId);
    const before = await d.api(`/api/projects/${projectId}/graph/overview?snapshotId=${run.snapshotId}`);
    const after = await d.api(`/api/projects/${projectId}/graph/overview?snapshotId=${next}`);
    const coverageBefore = (await d.api(`/api/projects/${projectId}/coverage?snapshotId=${run.snapshotId}`)).outcomes;
    const coverageAfter = (await d.api(`/api/projects/${projectId}/coverage?snapshotId=${next}`)).outcomes;
    const strip = value => JSON.parse(JSON.stringify(value, (key, item) => ['resolvedSnapshotId', 'snapshotId', 'createdAt', 'analyzedAt'].includes(key) ? undefined : item));
    row.fullPipeline = row.job.steps.length === run.rows.analysis.job.steps.length && row.job.steps.every(step => step.status === 'DONE');
    row.countsEqual = JSON.stringify(strip(before)) === JSON.stringify(strip(after)) && JSON.stringify(coverageBefore) === JSON.stringify(coverageAfter);
    // Equal overview counts do not prove canonical facts/evidence equal a clean full analysis.
    // Keep this timing smoke diagnostic; the formal equality gate needs its own full oracle.
    row.checks.resultEqualsFull = null;
    row.fullResultComparison = 'NOT_RUN';
    row.scope = 'approved immutable-snapshot refresh with bounded reuse and conservative recomputation; overview/outcome counts are diagnostic, not clean-full equality proof';
    row.status = 'PASS';
  }

  async function cancelRow(page, d, sampler, run, folder) {
    const row = run.rows.cancel = { status: 'RUNNING', metrics: {}, failure: null };
    await sampler.phase('CANCEL');
    await stage('CANCEL_FAILED', () => importAndPreview(page, d, folder + '-cancel', {}));
    const started = await stage('CANCEL_FAILED', () => approve(page, d));
    run.cancelProjectId = started.projectId;
    const cancel = page.getByRole('button', { name: 'Cancel analysis', exact: true });
    let trigger = null;
    const observed = await stage('CANCEL_FAILED', () => d.pollJob(started.jobId, { intervalMs: 100, timeoutMs: settings.analysisTimeoutMs,
      onStep: async ({ job, at }) => {
        const running = (job.steps ?? []).find(step => step.status === 'RUNNING');
        if (!running || !CANCEL_TRIGGER.steps.includes(running.stepKey)) { trigger = null; return false; }
        if (!trigger || trigger.key !== running.stepKey) trigger = { key: running.stepKey, firstSeenAt: at };
        return at - trigger.firstSeenAt >= CANCEL_TRIGGER.afterMs;
      } }));
    if (observed.timedOut || ['DONE', 'FAILED', 'CANCELLED'].includes(observed.job.status)) {
      row.job = jobTimings(observed.job);
      throw new Error('CANCEL_TRIGGER_MISSED');
    }
    row.runningStepAtCancel = trigger.key;
    await d.markClick('cancelClick');
    await d.watch('cancelAck', { kind: 'button', text: ['Cancelling…'], after: 'cancelClick' });
    await stage('CANCEL_FAILED', () => cancel.click());
    const released = await stage('CANCEL_FAILED', () => d.pollJob(started.jobId, { intervalMs: 100, timeoutMs: settings.analysisTimeoutMs }));
    row.job = jobTimings(released.job);
    if (released.timedOut) throw new Error('CANCEL_TIMEOUT');
    const current = await d.marks();
    row.metrics.cancelUiAckMs = current.cancelAck === undefined ? null : Math.round(current.cancelAck - current.cancelClick);
    row.metrics.cancelReleaseMs = Math.round(released.at - current.cancelClick);
    row.terminalStatus = publicCode(released.job.status);
    row.pollIntervalMs = 100;
    // The project write lock is the active-job constraint. A refresh preview is refused (409)
    // while any job is QUEUED/RUNNING/CANCELLING, so its acceptance confirms the release.
    const proofStarted = performance.now();
    try {
      await d.api(`/api/projects/${started.projectId}/local-preview`, 'POST', 120000);
      row.lockReleaseProof = 'REFRESH_PREVIEW_ACCEPTED';
    } catch (error) {
      row.lockReleaseProof = Number.isSafeInteger(error?.status) ? 'HTTP_' + error.status : 'UNCONFIRMED';
    }
    row.lockReleaseProofMs = Math.round(performance.now() - proofStarted);
    if (row.lockReleaseProof === 'HTTP_409') throw new Error('CANCEL_LOCK_NOT_RELEASED');
    if (released.job.status !== 'CANCELLED') throw new Error('CANCEL_ENDED_WITHOUT_CANCELLED');
    if (row.metrics.cancelUiAckMs === null) throw new Error('CANCEL_FAILED');
    row.scope = 'in-process job: cancellation is observed between pipeline steps; there is no separate worker process to terminate';
    row.status = 'PASS';
  }

  async function deleteRow(page, d, sampler, run) {
    const row = run.rows.delete = { status: 'RUNNING', metrics: {}, failure: null };
    await sampler.phase('DELETE');
    if (!run.projectId) throw new Error('PROJECT_DELETE_FAILED');
    row.snapshots = (await d.api(`/api/projects/${run.projectId}/jobs`)).filter(job => job.status === 'DONE').length;
    const begin = performance.now();
    await stage('PROJECT_DELETE_FAILED', () => d.api(`/api/projects/${run.projectId}`, 'DELETE', DELETE_TIMEOUT_MS));
    row.metrics.projectDeleteMs = Math.round(performance.now() - begin);
    run.projectId = null;
    row.scope = 'diagnostic only: DELETE of the analyzed project and its completed snapshots; no SLO row';
    row.status = 'PASS';
  }

  async function measuredRun(sequence) {
    const run = { sequence, status: 'RUNNING', failure: null, rows: {}, cleanupConfirmed: false, samplingComplete: false };
    if (sequence === 0) report.warmup = run; else report.runs.push(run);
    plan = newPlan(); run.profile = path.basename(plan.root);
    save(); plan.assertIdentity();
    run.freeBytesBeforePreparation = freeBytes('/private/tmp');
    const folder = path.join(work, `run-${sequence}`);
    let started = performance.now(), launchAttempted = false;
    let sdk, owner, sampler, memory, failure = null, stopObserving;
    const diagnostics = {};
    try {
      if (run.freeBytesBeforePreparation < MINIMUM_FREE_BYTES + settings.diskReserveBytes) throw new Error('DISK_SPACE_LOW');
      if (sequence > 0) {
        cloneTree(pristine, folder);
        if (hashTree(folder).treeSha256 !== fixture.treeSha256) throw new Error('WORKLOAD_FIXTURE_CHANGED');
        if (options.rows.includes('cancel')) cloneTree(pristine, folder + '-cancel');
      }
      run.quietAdmission = await waitForQuietHost({ requiredFreeBytes: MINIMUM_FREE_BYTES + settings.diskReserveBytes, diagnosticOnly: options.diagnosticOnly });
      run.freeBytesAtStart = run.quietAdmission.freeBytes;
      run.loadAverageAtStart = run.quietAdmission.observations.at(-1).loadAverage;
      if (sequence === 0) report.environment.loadAverageBefore = run.loadAverageAtStart;
      run.powerAtStart = observePowerSource();
      started = performance.now();
      launchAttempted = true;
      const launched = await stage('STARTUP_FAILED', () => launch(run, started));
      ({ sdk, owner } = launched);
      sampler = startOwnedPhaseSampler(owner.process().pid, fd, sequence, started);
      stopObserving = observeStartup(owner.process(), diagnostics, () => {});
      const page = await stage('STARTUP_FAILED', () => ready(sdk, launched.remaining));
      run.readyMs = Math.round(performance.now() - started);
      if (sequence > 0) {
        const d = driver(page, sdk);
        let analysisFailure = null;
        if (options.rows[0] === 'preview') {
          const row = run.rows.preview = { status: 'RUNNING', metrics: {}, failure: null };
          await sampler.phase('PREVIEW');
          try {
            const preview = await stage('PREVIEW_FAILED', () => importAndPreview(page, d, folder, row.metrics));
            row.localImport = preview.localImport;
            row.status = preview.localImport?.acceptedFiles === fixture.files ? 'PASS' : 'FAIL';
            if (row.status === 'FAIL') row.failure = 'PREVIEW_ADMISSION_MISMATCH';
          } catch (error) { row.status = 'FAIL'; row.failure = failureCode(error, 'PREVIEW_FAILED'); }
          finally { row.peakRssKiB = (await sampler.snapshot()).phases.PREVIEW?.peakRssKiB || null; save(); }
        } else try {
          await analysisRow(page, d, sampler, run, folder);
          run.rows.analysis.status = 'PASS';
        } catch (error) {
          analysisFailure = failureCode(error, 'ANALYSIS_FAILED');
          run.rows.analysis.status = 'FAIL'; run.rows.analysis.failure = analysisFailure;
          run.rows.analysis.failureStage = codes.has(error?.stage) ? error.stage : null;
          run.rows.analysis.httpStatus = Number.isInteger(error?.status) ? error.status : null;
        } finally {
          const snap = await sampler.snapshot();
          run.rows.analysis.peakRssKiB = snap.phases.ANALYSIS?.peakRssKiB || null;
          run.rows.analysis.previewPeakRssKiB = snap.phases.PREVIEW?.peakRssKiB || null;
          save();
        }
        for (const [name, action] of [['graph', graphRow], ['incremental', incrementalRow]]) {
          if (!options.rows.includes(name)) continue;
          if (analysisFailure) { run.rows[name] = { status: 'FAIL', failure: 'NOT_RUN_AFTER_ANALYSIS_FAILURE', metrics: {} }; continue; }
          try { await action(page, d, sampler, run, folder); }
          catch (error) { run.rows[name] ??= { metrics: {} }; run.rows[name].status = 'FAIL'; run.rows[name].failure = failureCode(error, name === 'graph' ? 'GRAPH_API_FAILED' : 'INCREMENTAL_FAILED'); }
          finally { run.rows[name].peakRssKiB = (await sampler.snapshot()).phases[name.toUpperCase()]?.peakRssKiB || null; save(); }
        }
        // Projects are not deleted between rows: the profile is discarded after the run.
        for (const [name, action, code] of [['cancel', cancelRow, 'CANCEL_FAILED'], ['delete', deleteRow, 'PROJECT_DELETE_FAILED']]) {
          if (!options.rows.includes(name)) continue;
          try { await action(page, d, sampler, run, folder); }
          catch (error) { run.rows[name] ??= { metrics: {} }; run.rows[name].status = 'FAIL'; run.rows[name].failure = failureCode(error, code); }
          finally { run.rows[name].peakRssKiB = (await sampler.snapshot()).phases[name.toUpperCase()]?.peakRssKiB || null; save(); }
        }
        if (analysisFailure) throw new Error(analysisFailure);
      }
      await sampler.phase('IDLE');
      memory = await sampler.stop();
      run.samplingComplete = phaseSamplingComplete(memory, sequence > 0 ? 'ANALYSIS' : 'STARTUP');
      if (owner.process().exitCode !== null || owner.process().signalCode !== null) throw new Error('STARTUP_PROCESS_EXITED');
    } catch (error) { failure = failureCode(error); }
    finally {
      try { if (sampler) memory ??= await sampler.stop(); } catch { failure ||= 'MEMORY_SAMPLE_FAILED'; }
      if (owner) {
        try {
          await closeValidatedApplication(owner, diagnostics);
          await confirmObservedGone([owner.process().pid, ...(memory?.observedPids ?? [])]);
          run.cleanupConfirmed = true;
        } catch (error) { run.cleanupFailure = failureCode(error); failure ||= run.cleanupFailure; }
        run.exit = { code: owner.process().exitCode, signal: owner.process().signalCode, shutdown: diagnostics.shutdown ?? null };
      } else if (!launchAttempted) run.cleanupConfirmed = true;
      else { run.cleanupFailure = 'NO_CAPTURED_CHILD'; failure ||= 'STARTUP_SDK_TIMEOUT'; }
      stopObserving?.();
      run.memory = memory ? { samples: memory.samples, peakRssKiB: memory.peakRssKiB, maximumGapMs: Math.round(memory.maximumGapMs),
        maximumReadMs: Math.round(memory.maximumReadMs), failure: memory.failure, failureDetail: memory.failureDetail,
        missingOwnerSamples: memory.missingOwnerSamples,
        trailingGapMs: memory.trailingGapMs === null ? null : Math.round(memory.trailingGapMs),
        phases: Object.fromEntries(Object.entries(memory.phases).map(([name, value]) => [name, { ...value, maximumGapMs: Math.round(value.maximumGapMs) }])) } : null;
      if (diagnostics.integrityFailure) run.integrityFailure = diagnostics.integrityFailure;
      run.powerAtEnd = observePowerSource(); run.loadAverageAtEnd = os.loadavg();
      run.profileBytes = directoryBytes(plan.root);
      run.freeBytesAtEnd = freeBytes('/private/tmp');
      const rowFailure = Object.values(run.rows).find(row => row.status === 'FAIL');
      failure ||= rowFailure?.failure ?? null;
      run.retainFailureEvidence = Boolean(failure || memory?.failure || (memory && !run.samplingComplete));
      // Discard the run's synthetic profile only after its processes were confirmed gone.
      if (!options.keepWork && !run.retainFailureEvidence && run.cleanupConfirmed) {
        try { fs.rmSync(plan.root, { recursive: true, force: true }); run.profileRemoved = true; } catch { run.profileRemoved = false; }
      } else run.profileRemoved = false;
      if (sequence > 0 && !options.keepWork && !run.retainFailureEvidence) {
        try { for (const tree of [folder, folder + '-cancel']) fs.rmSync(tree, { recursive: true, force: true }); }
        catch { failure ||= 'WORKLOAD_FIXTURE_CHANGED'; }
      }
      for (const row of Object.values(run.rows)) {
        if (row.status === 'RUNNING') { row.status = 'FAIL'; row.failure ||= failure || 'WORKLOAD_BENCHMARK_CHECK_FAILED'; }
      }
      run.status = failure ? 'FAIL' : 'PASS'; run.failure = failure;
      run.totalMs = Math.round(performance.now() - started); save();
      console.log(JSON.stringify({ sequence, status: run.status, failure, readyMs: run.readyMs,
        rows: Object.fromEntries(Object.entries(run.rows).map(([name, row]) => [name, { status: row.status, failure: row.failure, metrics: row.metrics, peakRssKiB: row.peakRssKiB }])) }));
    }
    return run.status === 'PASS';
  }

  function rowSamples(name) {
    // Row samples for assessment. A run failure keeps the row's executed sample as FAIL;
    // rows not reached because the analysis failed are recorded as failed, not dropped.
    return report.runs.map(run => {
      const row = run.rows[name];
      if (!row) return { sequence: run.sequence, status: 'FAIL', failure: run.rows.analysis?.status === 'FAIL'
        ? 'NOT_RUN_AFTER_ANALYSIS_FAILURE' : run.failure ?? 'NOT_RUN', metrics: {}, cleanupConfirmed: run.cleanupConfirmed };
      const status = row.status === 'PASS' && (name !== 'analysis' || run.status === 'PASS') ? 'PASS' : 'FAIL';
      return { sequence: run.sequence, status, failure: row.failure ?? (status === 'FAIL' ? run.failure : null), metrics: row.metrics,
        peakRssKiB: row.peakRssKiB, samplingComplete: run.samplingComplete, cleanupConfirmed: run.cleanupConfirmed, checks: row.checks };
    });
  }

  try {
    if (await measuredRun(0)) {
      for (let sequence = 1; sequence <= options.runs; sequence++) {
        const passed = await measuredRun(sequence);
        // A failed run stays in the series; only an unconfirmed cleanup stops it.
        if (!passed && !report.runs.at(-1).cleanupConfirmed) break;
      }
    }
    const assessed = {}, observed = {};
    const rowKeys = { preview: [`preview.${options.sizeClass}`], analysis: [`analysis.${options.sizeClass}`, `preview.${options.sizeClass}`], graph: [`graph.${options.sizeClass}`],
      incremental: [`incremental.${options.sizeClass}`], cancel: [`cancel.${options.sizeClass}`] };
    for (const name of options.diagnosticOnly ? [] : options.rows) {
      for (const key of rowKeys[name] ?? []) {
        if (!Object.hasOwn(SLO, key)) continue;
        const samples = rowSamples(name);
        if (options.series) assessed[key] = evaluateRow(key, samples, { expectedRuns: options.runs });
        else observed[key] = describeSmoke(key, samples);
      }
    }
    report.assessment = options.series ? assessed : null;
    report.smokeObservations = options.series || options.diagnosticOnly ? null : observed;
    report.measurementStatus = report.runs.length === options.runs && report.runs.every(run => run.status === 'PASS') ? 'COMPLETE' : 'INCOMPLETE';
    report.environmentGate = acObservedAtRunBoundaries(report.environment.power, [report.warmup, ...report.runs])
      ? 'AC_OBSERVED_AT_RUN_BOUNDARIES' : 'AC_POWER_NOT_CONFIRMED';
    report.loadGate = report.runs.length === options.runs && [report.warmup, ...report.runs].every(run => run?.quietAdmission?.status === 'ADMITTED')
      ? 'QUIET_HOST_OBSERVED_AT_LAUNCH' : 'QUIET_HOST_NOT_CONFIRMED';
    if (options.diagnosticOnly && [report.warmup, ...report.runs].some(run => run?.quietAdmission?.timingValidity === 'INVALID_LOAD')) report.loadGate = 'INVALID_LOAD';
    report.status = options.series
      ? (Object.values(assessed).length && Object.values(assessed).every(row => row.status === 'PASS') && report.environmentGate === 'AC_OBSERVED_AT_RUN_BOUNDARIES' && report.loadGate === 'QUIET_HOST_OBSERVED_AT_LAUNCH' ? 'PASS' : 'FAIL')
      : options.diagnosticOnly ? 'DIAGNOSTIC_ONLY' : 'SMOKE_ONLY';
    for (const [name, expected] of Object.entries(sources)) assert.equal(hash(path.join(repo, name)), expected);
    assert.equal(hash(path.join(app, 'Contents/Resources/app.asar')), report.appAsarSha256);
    assert.equal(hash(manifestFile), report.manifestSha256);
    assert.equal(hashTree(pristine).treeSha256, fixture.treeSha256);
    report.sourceAndBundleUnchanged = true;
  } catch (error) { report.status = 'FAIL'; report.failure = failureCode(error); }
  finally {
    fs.closeSync(fd); report.resourceSamplesSha256 = hash(sampleFile);
    report.fixtureBytesAllocated = directoryBytes(pristine);
    // Profiles of a run whose processes were not confirmed gone are left for inspection.
    const allClean = [report.warmup, ...report.runs].every(run => !run || run.cleanupConfirmed);
    const failedEvidence = [report.warmup, ...report.runs].some(run => run?.retainFailureEvidence);
    if (options.keepWork || !allClean || failedEvidence) report.retainedWork = { fixture: work, profiles: profileParent,
      reason: options.keepWork ? 'KEEP_WORK' : !allClean ? 'CLEANUP_UNCONFIRMED' : 'FAILURE_EVIDENCE' };
    else {
      fs.rmSync(work, { recursive: true, force: true }); fs.rmSync(profileParent, { recursive: true, force: true });
      report.retainedWork = null;
    }
    report.finishedAt = new Date().toISOString(); save();
  }
  console.log(JSON.stringify({ status: report.status, evidence, measurementStatus: report.measurementStatus,
    assessment: report.assessment, retainedWork: report.retainedWork }));
  if (!['PASS', 'SMOKE_ONLY', 'DIAGNOSTIC_ONLY'].includes(report.status) || report.measurementStatus !== 'COMPLETE') process.exitCode = 1;
  return report;
}

module.exports = { argumentsFor, instantMs, stepTimings, jobTimings, waitForQuietHost, CLASS_SETTINGS, CANCEL_TRIGGER, main };
if (require.main === module) main().catch(() => { console.error('WORKLOAD_BENCHMARK_PREFLIGHT_FAILED'); process.exitCode = 1; });
