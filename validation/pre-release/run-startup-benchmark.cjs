'use strict';

// Explicit startup/idle measurement of a retained development app, never a release
// or profile migration. One new profile is initialized, then restarted twenty times.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const { createRequire } = require('node:module');
const { execFile, execFileSync } = require('node:child_process');
const { promisify } = require('node:util');
const { ensureOutputParent } = require('./owned-output.cjs');
const { prepareIsolatedRun } = require('../../desktop/src/isolated-run.cjs');
const { validateRuntimeManifest } = require('../../desktop/src/runtime-manifest.cjs');
const { launchEnvironment, bounded } = require('../../desktop/scripts/packaged-keychain-acceptance.cjs');
const { observeStartup, closeValidatedApplication } = require('../../desktop/scripts/native-acceptance-electron.cjs');
const { captureOwnedApplication } = require('../backup-compatibility/interruption-hooks.cjs');
const { ensureNativeParent } = require('../backup-compatibility/owned-crash.cjs');
const { parseMemoryTable, memoryForOwner, evaluateStartupSamples } = require('./startup-metrics.cjs');
const execute = promisify(execFile);
const hash = file => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const RUNS = 20;
const SAMPLE_INTERVAL_MS = 100;
const IDLE_WINDOW_MS = 3000;
const STARTUP_TIMEOUT_MS = 90000;
const MAX_RESOURCE_CSV_BYTES = 64 * 1024 * 1024;
const codes = new Set(['STARTUP_TIMEOUT', 'STARTUP_SDK_TIMEOUT', 'STARTUP_FAILED', 'STARTUP_PROCESS_EXITED',
  'STARTUP_IDENTITY_FAILED', 'MEMORY_SAMPLE_FAILED', 'MEMORY_SAMPLING_INCOMPLETE', 'OBSERVED_PROCESSES_REMAIN',
  'NATIVE_ELECTRON_CLOSE_TIMEOUT', 'NATIVE_ELECTRON_EXIT_TIMEOUT', 'NATIVE_ELECTRON_UNCLEAN_EXIT',
  'NATIVE_SHUTDOWN_RECOVERY_REQUIRED', 'NATIVE_SHUTDOWN_UNCONFIRMED', 'NATIVE_SHUTDOWN_DIAGNOSTIC_TIMEOUT']);
function failureCode(error) {
  let message; try { message = error?.message; } catch { /* Do not inspect thrown details. */ }
  return codes.has(message) ? message : 'STARTUP_BENCHMARK_CHECK_FAILED';
}
function argumentsFor(argv) {
  assert(Array.isArray(argv) && argv.length === 3 && argv[0] === '--app' && argv[2] === '--warm-startup-20');
  assert(typeof argv[1] === 'string' && path.isAbsolute(argv[1]) && !/[\x00-\x1f\x7f]/.test(argv[1]));
  return { app: argv[1] };
}
async function memoryTable() {
  const { stdout } = await execute('/bin/ps', ['-axo', 'pid=,ppid=,rss='], {
    timeout: 5000, maxBuffer: 2 * 1024 * 1024,
    env: { PATH: '/usr/bin:/bin', LANG: 'C', LC_ALL: 'C' },
  });
  return parseMemoryTable(stdout);
}

function startMemorySampler(child, fd, sequence, started, {
  read = memoryTable, now = () => performance.now(), intervalMs = SAMPLE_INTERVAL_MS,
  maxCsvBytes = MAX_RESOURCE_CSV_BYTES, maxSamples = 2000,
} = {}) {
  assert(Number.isSafeInteger(maxCsvBytes) && maxCsvBytes > 0 && maxCsvBytes <= MAX_RESOURCE_CSV_BYTES);
  assert(Number.isSafeInteger(maxSamples) && maxSamples > 0 && maxSamples <= 2000);
  let stopped = false, timer, releaseSleep, phase = 'STARTUP', lastAt = null;
  const observed = new Set();
  const result = { samples: 0, idleSamples: 0, peakRssKiB: 0, idlePeakRssKiB: 0,
    firstSampleDelayMs: null, maximumGapMs: 0, maximumReadMs: 0, missingOwnerSamples: 0,
    requestedIntervalMs: intervalMs, failure: null,
    scope: 'Observed owner-tree RSS after SDK child capture; initial capture gap is not sampled',
    resourceFileLimitBytes: maxCsvBytes, sampleLimit: maxSamples };
  const task = (async () => {
    while (!stopped) {
      const begin = now();
      try {
        const table = await read();
        if (stopped) break;
        const at = now(), value = memoryForOwner(table, child.pid);
        result.maximumReadMs = Math.max(result.maximumReadMs, at - begin);
        if (!value || value.rssKiB <= 0) {
          result.missingOwnerSamples++;
          throw new Error('MEMORY_SAMPLE_FAILED');
        }
        const text = value.processes.map(row => [sequence, Math.round(at - started), phase, row.pid, row.ppid, row.rssKiB].join(',') + '\n').join('');
        if (result.samples >= maxSamples || fs.fstatSync(fd).size + Buffer.byteLength(text) > maxCsvBytes) {
          result.failure = 'MEMORY_EVIDENCE_LIMIT'; break;
        }
        result.firstSampleDelayMs ??= at - started;
        if (lastAt !== null) result.maximumGapMs = Math.max(result.maximumGapMs, at - lastAt);
        lastAt = at; result.samples++;
        result.peakRssKiB = Math.max(result.peakRssKiB, value.rssKiB);
        if (phase === 'IDLE') {
          result.idleSamples++; result.idlePeakRssKiB = Math.max(result.idlePeakRssKiB, value.rssKiB);
        }
        for (const row of value.processes) observed.add(row.pid);
        fs.writeSync(fd, text);
      } catch { result.failure = 'MEMORY_SAMPLE_FAILED'; break; }
      if (!stopped) await new Promise(resolve => {
        releaseSleep = resolve;
        timer = setTimeout(resolve, Math.max(0, intervalMs - (now() - begin)));
      });
    }
  })();
  return {
    idle() { phase = 'IDLE'; },
    async stop() {
      stopped = true; clearTimeout(timer); releaseSleep?.();
      await bounded(() => task, 6000, 'MEMORY_SAMPLE_FAILED');
      return { ...result, observedPids: [...observed].sort((a, b) => a - b) };
    },
  };
}

async function confirmObservedGone(pids) {
  const observed = new Set(pids), expires = performance.now() + 10000;
  for (;;) {
    const remaining = (await memoryTable()).filter(row => observed.has(row.pid));
    if (!remaining.length) return;
    if (performance.now() >= expires) throw new Error('OBSERVED_PROCESSES_REMAIN');
    await new Promise(resolve => setTimeout(resolve, 100));
  }
}

async function main(argv = process.argv.slice(2)) {
  const options = argumentsFor(argv);
  assert.equal(process.platform, 'darwin'); assert.equal(process.arch, 'arm64');
  process.umask(0o077);
  const repo = fs.realpathSync(path.resolve(__dirname, '../..')), app = fs.realpathSync(options.app);
  assert.equal(app, options.app); assert.equal(path.dirname(path.dirname(app)), repo);
  assert.equal(path.basename(app), 'Code Intelligence Validation.app');
  assert.match(path.basename(path.dirname(app)), /^\.native-product-[A-Za-z0-9]+$/);
  const runtime = path.join(app, 'Contents/Resources/runtime'), manifestFile = path.join(runtime, 'runtime-manifest.json');
  const manifest = JSON.parse(fs.readFileSync(manifestFile));
  await validateRuntimeManifest(runtime, manifest);
  execFileSync('/usr/bin/codesign', ['--verify', '--deep', '--strict', app], { stdio: 'pipe', timeout: 30000 });
  const evidence = fs.mkdtempSync(path.join(ensureOutputParent(repo, 'validation/local/startup-performance'), 'run-'));
  const plan = prepareIsolatedRun({ parentDirectory: ensureNativeParent(repo), runtimeDirectory: runtime,
    purpose: 'automation', forbiddenRoots: ['Code Intelligence', 'Code Intelligence Validation']
      .map(name => path.join(os.homedir(), 'Library/Application Support', name)) });
  const requireFrontend = createRequire(path.join(repo, 'frontend/package.json'));
  const { _electron } = requireFrontend('playwright'), { expect } = requireFrontend('@playwright/test');
  const powerText = execFileSync('/usr/bin/pmset', ['-g', 'batt'], { encoding: 'utf8', timeout: 5000 });
  const inputs = [__filename, path.join(__dirname, 'startup-metrics.cjs'),
    path.join(repo, 'desktop/scripts/native-acceptance-electron.cjs'), path.join(repo, 'desktop/src/isolated-run.cjs')];
  const sources = Object.fromEntries(inputs.map(file => [path.relative(repo, file), hash(file)]));
  const report = { format: 1, status: 'RUNNING', scope: 'initialized-empty-synthetic-profile-warm-startup-and-idle',
    requestedRuns: RUNS, startupLimitMs: 10000, idleLimitKiB: 1572864, startupTimeoutMs: STARTUP_TIMEOUT_MS,
    sampleIntervalMs: SAMPLE_INTERVAL_MS, idleWindowMs: IDLE_WINDOW_MS, resourceCsvLimitBytes: MAX_RESOURCE_CSV_BYTES,
    cachePolicy: 'OS cache not flushed; one initialization outside measured warm runs',
    startupRssBeforeSdkCaptureMeasured: false,
    sourceCommit: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repo, encoding: 'utf8' }).trim(), sources,
    app, appAsarSha256: hash(path.join(app, 'Contents/Resources/app.asar')), manifestSha256: hash(manifestFile),
    buildSequence: manifest.buildSequence, claim: plan.claimFile, evidence,
    mockKeychain: true, realAccount: false, originalProfileAccessed: false, productChanged: false,
    coldCacheMeasured: false, fullPerformanceGatePassed: false, releaseVerdict: 'NO_GO',
    environment: { platform: process.platform, arch: process.arch, node: process.version,
      osVersion: execFileSync('/usr/bin/sw_vers', ['-productVersion'], { encoding: 'utf8' }).trim(),
      hardware: execFileSync('/usr/sbin/sysctl', ['-n', 'hw.model'], { encoding: 'utf8' }).trim(),
      logicalCpus: os.cpus().length, memoryBytes: os.totalmem(), loadAverageBefore: os.loadavg(),
      power: powerText.includes("'AC Power'") ? 'AC' : powerText.includes("'Battery Power'") ? 'BATTERY' : 'UNKNOWN' },
    warmup: null, samples: Array.from({ length: RUNS }, (_, index) => ({ sequence: index + 1, status: 'NOT_RUN',
      readyMs: null, idlePeakRssKiB: null, cleanupConfirmed: false, samplingComplete: false })) };
  const save = () => fs.writeFileSync(path.join(evidence, 'result.json'), JSON.stringify(report, null, 2) + '\n', { mode: 0o600 });
  const sampleFile = path.join(evidence, 'resource-samples.csv'), fd = fs.openSync(sampleFile, 'wx', 0o600);
  fs.writeSync(fd, 'sequence,elapsed_ms,phase,pid,ppid,rss_kib\n');
  save(); console.log(JSON.stringify({ status: 'RUNNING', evidence, requestedRuns: RUNS }));

  async function run(sequence) {
    const sample = { sequence, status: 'RUNNING', readyMs: null, idlePeakRssKiB: null,
      cleanupConfirmed: false, samplingComplete: false, startupPhases: [] };
    if (sequence === 0) report.warmup = sample; else report.samples[sequence - 1] = sample;
    save(); plan.assertIdentity();
    const started = performance.now(), expires = started + STARTUP_TIMEOUT_MS;
    const remaining = () => { const ms = Math.floor(expires - performance.now()); if (ms <= 0) throw new Error('STARTUP_TIMEOUT'); return ms; };
    let sdk, owner, stopObserving, sampler, memory, failure = null, lastPhase;
    const diagnostics = {};
    try {
      sdk = await _electron.launch({ executablePath: path.join(app, 'Contents/MacOS/Code Intelligence Validation'),
        args: ['--use-mock-keychain', '--isolated-run-claim=' + plan.claimFile], cwd: repo,
        env: launchEnvironment(process.env), timeout: remaining() });
      owner = captureOwnedApplication(sdk);
      sample.pid = owner.process().pid; sample.sdkCaptureMs = Math.round(performance.now() - started);
      sampler = startMemorySampler(owner.process(), fd, sequence, started);
      stopObserving = observeStartup(owner.process(), diagnostics, () => {
        if (diagnostics.integrityFailure) sample.integrityFailure ??= diagnostics.integrityFailure;
        if (diagnostics.startup?.phase !== lastPhase && sample.startupPhases.length < 32) {
          lastPhase = diagnostics.startup?.phase;
          if (lastPhase) sample.startupPhases.push({ phase: lastPhase, state: diagnostics.startup.state,
            elapsedMs: Math.round(performance.now() - started) });
        }
      });
      const page = await sdk.firstWindow({ timeout: remaining() });
      await expect(page.getByRole('link', { name: 'Code Intelligence home' })).toBeVisible({ timeout: remaining() });
      const identity = await bounded(() => sdk.evaluate(({ app }) => ({ name: app.getName(), profile: app.getPath('userData'), packaged: app.isPackaged })), remaining(), 'STARTUP_TIMEOUT');
      assert.deepEqual(identity, { name: plan.appIdentity.name, profile: plan.paths.userData, packaged: true });
      const status = await bounded(() => page.evaluate(() => window.codeIntelligenceDesktop.runtimeStatus()), remaining(), 'STARTUP_TIMEOUT');
      assert.equal(status.ready, true); assert.equal(status.recoveryOnly, false); assert.equal(status.error, null); assert.equal(status.aiOff, true);
      assert.deepEqual([...status.services].sort(), ['backend', 'postgres', 'redis', 'ts-analyzer']);
      sample.readyMs = Math.round(performance.now() - started);
      sampler.idle(); await new Promise(resolve => setTimeout(resolve, IDLE_WINDOW_MS));
      memory = await sampler.stop();
      sample.idlePeakRssKiB = memory.idlePeakRssKiB;
      // Report the actual schedule rather than pretending a sampled peak is continuous.
      sample.samplingComplete = !memory.failure && memory.samples > 0 && memory.idleSamples >= 20
        && memory.maximumGapMs <= 250 && memory.missingOwnerSamples === 0;
      if (!sample.samplingComplete) throw new Error('MEMORY_SAMPLING_INCOMPLETE');
      if (owner.process().exitCode !== null || owner.process().signalCode !== null) throw new Error('STARTUP_PROCESS_EXITED');
    } catch (error) { failure = failureCode(error); }
    finally {
      try { if (sampler) memory ??= await sampler.stop(); } catch { failure ||= 'MEMORY_SAMPLE_FAILED'; }
      if (owner) {
        try {
          await closeValidatedApplication(owner, diagnostics);
          await confirmObservedGone([owner.process().pid, ...(memory?.observedPids ?? [])]);
          sample.cleanupConfirmed = true;
        } catch (error) { sample.cleanupFailure = failureCode(error); failure ||= sample.cleanupFailure; }
        sample.exit = { code: owner.process().exitCode, signal: owner.process().signalCode,
          shutdown: diagnostics.shutdown ?? null, trace: diagnostics.shutdownTrace ?? [] };
      } else {
        // A rejected SDK launch supplied no owned handle: do not guess a PID or
        // assume cleanup. Stop this series and leave the unexecuted rows visible.
        sample.cleanupFailure = 'NO_CAPTURED_CHILD'; failure ||= 'STARTUP_SDK_TIMEOUT';
      }
      stopObserving?.(); sample.memory = memory ?? null;
      if (diagnostics.integrityFailure) sample.integrityFailure ??= diagnostics.integrityFailure;
      sample.status = failure ? 'FAIL' : 'PASS'; sample.failure = failure;
      sample.totalMs = Math.round(performance.now() - started); save();
      console.log(JSON.stringify({ sequence, status: sample.status, readyMs: sample.readyMs,
        idlePeakRssKiB: sample.idlePeakRssKiB, cleanupConfirmed: sample.cleanupConfirmed, failure }));
    }
    return sample.status === 'PASS';
  }

  try {
    if (await run(0)) for (let sequence = 1; sequence <= RUNS; sequence++) if (!await run(sequence)) break;
    report.assessment = evaluateStartupSamples(report.samples);
    report.measurementStatus = report.samples.every(sample => sample.status === 'PASS') ? 'COMPLETE' : 'INCOMPLETE';
    report.status = report.assessment.status;
    if (report.environment.power !== 'AC') { report.status = 'FAIL'; report.environmentGate = 'AC_POWER_NOT_CONFIRMED'; }
    for (const [name, expected] of Object.entries(sources)) assert.equal(hash(path.join(repo, name)), expected);
    assert.equal(hash(path.join(app, 'Contents/Resources/app.asar')), report.appAsarSha256);
    assert.equal(hash(manifestFile), report.manifestSha256);
    report.sourceAndBundleUnchanged = true;
  } catch (error) { report.status = 'FAIL'; report.failure = failureCode(error); }
  finally { fs.closeSync(fd); report.resourceSamplesSha256 = hash(sampleFile); report.finishedAt = new Date().toISOString(); save(); }
  console.log(JSON.stringify({ status: report.status, evidence, measurementStatus: report.measurementStatus, assessment: report.assessment }));
  if (report.status !== 'PASS') process.exitCode = 1;
  return report;
}

module.exports = { argumentsFor, startMemorySampler, confirmObservedGone, main };
if (require.main === module) main().catch(() => { console.error('STARTUP_BENCHMARK_PREFLIGHT_FAILED'); process.exitCode = 1; });
