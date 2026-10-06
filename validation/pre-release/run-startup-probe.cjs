'use strict';

// Short diagnostic probe. It does not satisfy the startup-performance acceptance gate.
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
const { parseMemoryTable, memoryForOwner } = require('./startup-metrics.cjs');
const { startMemorySampler, confirmObservedGone } = require('./run-startup-benchmark.cjs');

const execute = promisify(execFile);
const RUNS = 3;
const IDLE_WINDOW_MS = 3000;
const STARTUP_TIMEOUT_MS = 90000;
const MAX_PS_BYTES = 2 * 1024 * 1024;
const MAX_PS_ROWS = 50000;
const hash = file => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const FIXED_ROLES = new Set(['MAIN', 'JAVA', 'NODE', 'POSTGRES', 'REDIS', 'ELECTRON_MAIN', 'ELECTRON_RENDERER', 'ELECTRON_GPU', 'ELECTRON_UTILITY', 'ELSE', 'UNKNOWN', 'UNOBSERVED']);
const FAILURE_CODES = new Set(['STARTUP_TIMEOUT', 'STARTUP_SDK_TIMEOUT', 'STARTUP_PROCESS_EXITED', 'STARTUP_IDENTITY_FAILED',
  'MEMORY_SAMPLE_FAILED', 'MEMORY_SAMPLING_INCOMPLETE', 'ROLE_SAMPLE_FAILED', 'ROLE_TABLE_INVALID', 'OBSERVED_PROCESSES_REMAIN',
  'NATIVE_ELECTRON_CLOSE_TIMEOUT', 'NATIVE_ELECTRON_EXIT_TIMEOUT', 'NATIVE_ELECTRON_UNCLEAN_EXIT',
  'NATIVE_SHUTDOWN_RECOVERY_REQUIRED', 'NATIVE_SHUTDOWN_UNCONFIRMED', 'NATIVE_SHUTDOWN_DIAGNOSTIC_TIMEOUT']);

function failureCode(error) {
  let message; try { message = error?.message; } catch { return 'STARTUP_PROBE_FAILED'; }
  return FAILURE_CODES.has(message) ? message : 'STARTUP_PROBE_FAILED';
}

function argumentsFor(argv) {
  assert(Array.isArray(argv) && argv.length === 3 && argv[0] === '--app' && argv[2] === '--startup-probe-3');
  assert(typeof argv[1] === 'string' && path.isAbsolute(argv[1]) && !/[\x00-\x1f\x7f]/.test(argv[1]));
  assert.equal(path.basename(argv[1]), 'Code Intelligence Validation.app');
  assert.match(path.basename(path.dirname(argv[1])), /^\.native-product-[A-Za-z0-9]+$/);
  return { app: argv[1] };
}

function parseCommandTable(text) {
  assert.equal(typeof text, 'string', 'ROLE_TABLE_INVALID');
  assert(Buffer.byteLength(text) <= MAX_PS_BYTES, 'ROLE_TABLE_INVALID');
  if (!text.trim()) return [];
  const rows = text.trim().split('\n');
  assert(rows.length <= MAX_PS_ROWS, 'ROLE_TABLE_INVALID');
  const parsed = rows.map(line => {
    const match = /^\s*([0-9]+)\s+(.+?)\s*$/.exec(line);
    assert(match, 'ROLE_TABLE_INVALID');
    const pid = Number(match[1]);
    assert(Number.isSafeInteger(pid) && pid > 0, 'ROLE_TABLE_INVALID');
    const comm = match[2];
    assert(comm && Buffer.byteLength(comm) <= 4096 && !/[\r\n\0]/.test(comm), 'ROLE_TABLE_INVALID');
    return { pid, comm };
  });
  assert.equal(new Set(parsed.map(row => row.pid)).size, parsed.length, 'ROLE_TABLE_INVALID');
  return parsed;
}

function classifyCommand(comm, expected) {
  if (typeof comm !== 'string') return 'UNKNOWN';
  if (comm === expected.java) return 'JAVA';
  if (comm === expected.node) return 'NODE';
  if (comm === expected.postgres) return 'POSTGRES';
  if (comm === expected.redis) return 'REDIS';
  return 'ELSE';
}

function electronRole(type) {
  if (type === 'Browser') return 'ELECTRON_MAIN';
  if (type === 'Tab' || type === 'Renderer') return 'ELECTRON_RENDERER';
  if (type === 'GPU') return 'ELECTRON_GPU';
  if (type === 'Utility') return 'ELECTRON_UTILITY';
  return 'UNKNOWN';
}

function mergeRoleSnapshot(processes, commandRows, appMetrics, ownerPid, expected) {
  const commands = new Map(commandRows.map(row => [row.pid, row.comm]));
  const electron = new Map();
  if (Array.isArray(appMetrics)) for (const metric of appMetrics) {
    if (metric && Number.isSafeInteger(metric.pid) && metric.pid > 0) electron.set(metric.pid, electronRole(metric.type));
  }
  return processes.map(row => {
    let role = row.pid === ownerPid ? 'MAIN' : electron.get(row.pid);
    if (!role) role = commands.has(row.pid) ? classifyCommand(commands.get(row.pid), expected) : 'UNOBSERVED';
    if (!FIXED_ROLES.has(role)) role = 'UNKNOWN';
    return { pid: row.pid, ppid: row.ppid, rssKiB: row.rssKiB, role };
  });
}

async function memoryTable() {
  const { stdout } = await execute('/bin/ps', ['-axo', 'pid=,ppid=,rss='], {
    timeout: 5000, maxBuffer: MAX_PS_BYTES, env: { PATH: '/usr/bin:/bin', LANG: 'C', LC_ALL: 'C' },
  });
  return parseMemoryTable(stdout);
}

async function commandTable(pids) {
  const unique = [...new Set(pids)];
  assert(unique.length > 0 && unique.length <= 1024 && unique.every(pid => Number.isSafeInteger(pid) && pid > 0), 'ROLE_TABLE_INVALID');
  const { stdout } = await execute('/bin/ps', ['-p', unique.join(','), '-o', 'pid=,comm='], {
    timeout: 5000, maxBuffer: MAX_PS_BYTES, env: { PATH: '/usr/bin:/bin', LANG: 'C', LC_ALL: 'C' },
  });
  return parseCommandTable(stdout);
}

async function main(argv = process.argv.slice(2)) {
  const options = argumentsFor(argv);
  assert.equal(process.platform, 'darwin'); assert.equal(process.arch, 'arm64'); process.umask(0o077);
  const repo = fs.realpathSync(path.resolve(__dirname, '../..')), app = fs.realpathSync(options.app);
  assert.equal(app, options.app); assert.equal(path.dirname(path.dirname(app)), repo);
  assert.equal(path.basename(app), 'Code Intelligence Validation.app'); assert.match(path.basename(path.dirname(app)), /^\.native-product-[A-Za-z0-9]+$/);
  const runtime = path.join(app, 'Contents/Resources/runtime'), manifestFile = path.join(runtime, 'runtime-manifest.json');
  const manifest = JSON.parse(fs.readFileSync(manifestFile)); await validateRuntimeManifest(runtime, manifest);
  execFileSync('/usr/bin/codesign', ['--verify', '--deep', '--strict', app], { stdio: 'pipe', timeout: 30000 });
  const evidence = fs.mkdtempSync(path.join(ensureOutputParent(repo, 'validation/local/startup-probe'), 'run-'));
  const plan = prepareIsolatedRun({ parentDirectory: ensureNativeParent(repo), runtimeDirectory: runtime, purpose: 'automation',
    forbiddenRoots: ['Code Intelligence', 'Code Intelligence Validation'].map(name => path.join(os.homedir(), 'Library/Application Support', name)) });
  const { _electron } = createRequire(path.join(repo, 'frontend/package.json'))('playwright');
  const { expect } = createRequire(path.join(repo, 'frontend/package.json'))('@playwright/test');
  const expected = {
    java: path.join(runtime, 'jre/bin/java'),
    node: path.join(app, 'Contents/MacOS/Code Intelligence Validation'),
    postgres: path.join(runtime, 'postgres/bin/postgres'),
    redis: path.join(runtime, 'redis/bin/redis-server'),
  };
  const sourceFiles = [__filename, path.join(__dirname, 'run-startup-benchmark.cjs'), path.join(__dirname, 'startup-metrics.cjs'),
    path.join(repo, 'desktop/scripts/native-acceptance-electron.cjs'), path.join(repo, 'desktop/src/startup-diagnostics.cjs'),
    path.join(repo, 'desktop/src/isolated-run.cjs')];
  const sourceHashes = Object.fromEntries(sourceFiles.map(file => [path.relative(repo, file), hash(file)]));
  const power = execFileSync('/usr/bin/pmset', ['-g', 'batt'], { encoding: 'utf8', timeout: 5000 });
  const report = { format: 1, status: 'RUNNING', scope: 'diagnostic-startup-probe-only', acceptanceGate: false,
    requestedWarmRuns: RUNS, warmup: null, samples: Array.from({ length: RUNS }, (_, i) => ({ sequence: i + 1, status: 'NOT_RUN' })),
    claim: plan.claimFile, profile: plan.paths.userData, mockKeychain: true, realAccount: false, originalProfileAccessed: false,
    app, buildSequence: manifest.buildSequence, evidence,
    observedAt: new Date().toISOString(),
    environment: { power: power.includes("'AC Power'") ? 'AC' : power.includes("'Battery Power'") ? 'BATTERY' : 'UNKNOWN' },
    appAsarSha256: hash(path.join(app, 'Contents/Resources/app.asar')), manifestSha256: hash(manifestFile), sourceHashes,
    roleVocabulary: [...FIXED_ROLES].sort(), executablePathsPersisted: false };
  const save = () => fs.writeFileSync(path.join(evidence, 'result.json'), JSON.stringify(report, null, 2) + '\n', { mode: 0o600 });
  const csv = path.join(evidence, 'resource-samples.csv'), fd = fs.openSync(csv, 'wx', 0o600); fs.writeSync(fd, 'sequence,elapsed_ms,phase,pid,ppid,rss_kib\n');
  save();
  console.log(JSON.stringify({ status: report.status, evidence, requestedWarmRuns: RUNS }));

  async function run(sequence) {
    const sample = { sequence, status: 'RUNNING', readyMs: null, cleanupConfirmed: false, samplingComplete: false, startupPhases: [], roles: [] };
    if (sequence === 0) report.warmup = sample; else report.samples[sequence - 1] = sample;
    save(); plan.assertIdentity();
    const started = performance.now(), expires = started + STARTUP_TIMEOUT_MS;
    const remaining = () => { const value = Math.floor(expires - performance.now()); if (value <= 0) throw new Error('STARTUP_TIMEOUT'); return value; };
    let sdk, owner, sampler, memory, stopObserving, failure = null, lastPhase;
    const diagnostics = {};
    try {
      sdk = await _electron.launch({ executablePath: path.join(app, 'Contents/MacOS/Code Intelligence Validation'),
        args: ['--use-mock-keychain', '--isolated-run-claim=' + plan.claimFile], cwd: repo, env: launchEnvironment(process.env), timeout: remaining() });
      owner = captureOwnedApplication(sdk); sample.pid = owner.process().pid;
      sampler = startMemorySampler(owner.process(), fd, sequence, started);
      stopObserving = observeStartup(owner.process(), diagnostics, () => {
        if (diagnostics.integrityFailure) sample.integrityFailure ??= diagnostics.integrityFailure;
        if (diagnostics.startup?.state === 'FAILED') sample.startupFailure ??= diagnostics.startup;
        const phase = diagnostics.startup?.phase;
        if (phase && phase !== lastPhase && sample.startupPhases.length < 32) {
          lastPhase = phase; sample.startupPhases.push({ phase, state: diagnostics.startup.state, elapsedMs: Math.round(performance.now() - started) });
        }
      });
      const page = await sdk.firstWindow({ timeout: remaining() });
      await expect(page.getByRole('link', { name: 'Code Intelligence home' })).toBeVisible({ timeout: remaining() });
      const identity = await bounded(() => sdk.evaluate(({ app }) => ({ name: app.getName(), profile: app.getPath('userData'), packaged: app.isPackaged })), remaining(), 'STARTUP_TIMEOUT');
      assert.deepEqual(identity, { name: plan.appIdentity.name, profile: plan.paths.userData, packaged: true });
      const status = await bounded(() => page.evaluate(() => window.codeIntelligenceDesktop.runtimeStatus()), remaining(), 'STARTUP_TIMEOUT');
      assert.equal(status.ready, true); assert.equal(status.recoveryOnly, false); assert.equal(status.error, null); assert.equal(status.aiOff, true);
      assert.deepEqual([...status.services].sort(), ['backend', 'postgres', 'redis', 'ts-analyzer']);
      sample.readyMs = Math.round(performance.now() - started); sampler.idle(); await new Promise(resolve => setTimeout(resolve, IDLE_WINDOW_MS));
      memory = await sampler.stop(); sample.idlePeakRssKiB = memory.idlePeakRssKiB;
      sample.samplingComplete = !memory.failure && memory.samples > 0 && memory.idleSamples >= 20 && memory.maximumGapMs <= 250 && memory.missingOwnerSamples === 0;
      if (!sample.samplingComplete) throw new Error('MEMORY_SAMPLING_INCOMPLETE');
      const snapshot = memoryForOwner(await memoryTable(), owner.process().pid);
      if (!snapshot) throw new Error('ROLE_SAMPLE_FAILED');
      let metrics = [];
      try { metrics = await bounded(() => sdk.evaluate(({ app }) => app.getAppMetrics().map(item => ({ pid: item.pid, type: item.type }))), 5000, 'ROLE_SAMPLE_FAILED'); }
      catch { metrics = []; }
      const commands = await commandTable(snapshot.processes.map(row => row.pid));
      sample.roles = mergeRoleSnapshot(snapshot.processes, commands, metrics, owner.process().pid, expected);
      if (owner.process().exitCode !== null || owner.process().signalCode !== null) throw new Error('STARTUP_PROCESS_EXITED');
    } catch (error) { failure = failureCode(error); }
    finally {
      try { if (sampler) memory ??= await sampler.stop(); } catch { failure ||= 'MEMORY_SAMPLE_FAILED'; }
      if (owner) {
        try { await closeValidatedApplication(owner, diagnostics); await confirmObservedGone([owner.process().pid, ...(memory?.observedPids ?? [])]); sample.cleanupConfirmed = true; }
        catch (error) { sample.cleanupFailure = failureCode(error); failure ||= sample.cleanupFailure; }
        sample.exit = { code: owner.process().exitCode, signal: owner.process().signalCode, shutdown: diagnostics.shutdown ?? null };
      } else { sample.cleanupFailure = 'NO_CAPTURED_CHILD'; failure ||= 'STARTUP_SDK_TIMEOUT'; }
      stopObserving?.();
      if (diagnostics.integrityFailure) sample.integrityFailure ??= diagnostics.integrityFailure;
      if (diagnostics.startup?.state === 'FAILED') sample.startupFailure ??= diagnostics.startup;
      sample.memory = memory ?? null; sample.status = failure ? 'FAIL' : 'PASS'; sample.failure = failure; save();
      console.log(JSON.stringify({ sequence, status: sample.status, readyMs: sample.readyMs,
        idlePeakRssKiB: sample.idlePeakRssKiB ?? null, integrityFailure: sample.integrityFailure ?? null, cleanupConfirmed: sample.cleanupConfirmed }));
    }
    return sample.status === 'PASS';
  }

  try {
    if (await run(0)) for (let sequence = 1; sequence <= RUNS; sequence++) if (!await run(sequence)) break;
    report.status = report.samples.every(sample => sample.status === 'PASS') ? 'COMPLETE_DIAGNOSTIC' : 'INCOMPLETE_DIAGNOSTIC';
    for (const [name, expectedHash] of Object.entries(sourceHashes)) assert.equal(hash(path.join(repo, name)), expectedHash);
    assert.equal(hash(path.join(app, 'Contents/Resources/app.asar')), report.appAsarSha256); assert.equal(hash(manifestFile), report.manifestSha256);
    report.sourceAndBundleUnchanged = true;
  } catch (error) { report.status = 'INCOMPLETE_DIAGNOSTIC'; report.failure = failureCode(error); }
  finally { fs.closeSync(fd); report.resourceSamplesSha256 = hash(csv); report.finishedAt = new Date().toISOString(); save(); }
  console.log(JSON.stringify({ status: report.status, evidence }));
  if (report.status !== 'COMPLETE_DIAGNOSTIC') process.exitCode = 1;
  return report;
}

module.exports = { argumentsFor, parseCommandTable, classifyCommand, electronRole, mergeRoleSnapshot, main };
if (require.main === module) main().catch(() => { console.error('STARTUP_PROBE_PREFLIGHT_FAILED'); process.exitCode = 1; });
