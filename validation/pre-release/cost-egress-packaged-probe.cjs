'use strict';

// G-COST packaged-app probe on an unmodified retained candidate with a fresh isolated profile and mock
// Keychain. The packaged provider transport is fixed to https://api.openai.com by design and cannot be
// pointed at a fake provider, so this probe never activates AI. It shows that in the first-run state
// (AI OFF, budget 0) and after saving a synthetic key with budget 0 no provider request can be produced
// through the renderer/IPC paths: no activation, no quote, no ledger hold, and no non-loopback socket
// from the app's process tree. It also binds the packaged AI modules to the current sources by hash.
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
const { launchEnvironment } = require('../../desktop/scripts/packaged-keychain-acceptance.cjs');
const { observeStartup, closeValidatedApplication } = require('../../desktop/scripts/native-acceptance-electron.cjs');
const { captureOwnedApplication } = require('../backup-compatibility/interruption-hooks.cjs');
const { readOwnerMemory } = require('./process-memory.cjs');
const { confirmObservedGone } = require('./run-startup-benchmark.cjs');

const execute = promisify(execFile);
const sha = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const hash = file => sha(fs.readFileSync(file));
const SYNTHETIC_KEY = 'sk-publicSyntheticPackagedProbeKey0123456789';
const MODEL = 'gpt-4o-mini-2024-07-18';
const PACKAGED_MODULES = ['ai-desktop-gateway.cjs', 'ai-egress-bridge.cjs', 'ai-egress-postgres.cjs', 'ai-egress.cjs',
  'ai-https-transport.cjs', 'ai-model-contracts.cjs', 'main.cjs', 'preload.cjs', 'safety-journal.cjs', 'safety-lifecycle.cjs'];
const LOOPBACK = /^(127\.\d+\.\d+\.\d+|\[?::1\]?|localhost|\*)$/;

// Every inet socket of the app's process tree; any remote host that is not loopback is recorded.
async function inetSockets(ownerPid) {
  const pids = (await readOwnerMemory(ownerPid)).map(row => row.pid);
  let stdout = '';
  try {
    ({ stdout } = await execute('/usr/sbin/lsof', ['-nP', '-a', '-p', pids.join(','), '-i'],
      { timeout: 10000, maxBuffer: 4 * 1024 * 1024, env: { PATH: '/usr/bin:/bin:/usr/sbin', LANG: 'C', LC_ALL: 'C' } }));
  } catch (error) { if (error.code !== 1) throw error; } // lsof exits 1 when nothing matches.
  const remote = [];
  for (const line of stdout.split('\n').slice(1)) {
    const name = line.trim().split(/\s+/).slice(8).join(' ');
    if (!name) continue;
    const peer = name.includes('->') ? name.split('->')[1].split(' ')[0] : null;
    if (peer) { const host = peer.slice(0, peer.lastIndexOf(':')); if (!LOOPBACK.test(host)) remote.push(peer); }
  }
  return { processes: pids.length, remote };
}

async function main(argv = process.argv.slice(2)) {
  assert(argv.length === 2 && argv[0] === '--app', 'Use --app <repo>/.native-product-<id>/Code Intelligence Validation.app');
  assert.equal(process.platform, 'darwin'); assert.equal(process.arch, 'arm64'); process.umask(0o077);
  const repo = fs.realpathSync(path.resolve(__dirname, '../..')), app = fs.realpathSync(argv[1]);
  assert.equal(path.dirname(path.dirname(app)), repo); assert.equal(path.basename(app), 'Code Intelligence Validation.app');
  assert.match(path.basename(path.dirname(app)), /^\.native-product-[A-Za-z0-9]+$/);
  const runtime = path.join(app, 'Contents/Resources/runtime'), manifestFile = path.join(runtime, 'runtime-manifest.json');
  const manifest = JSON.parse(fs.readFileSync(manifestFile)); await validateRuntimeManifest(runtime, manifest);
  execFileSync('/usr/bin/codesign', ['--verify', '--deep', '--strict', app], { stdio: 'pipe', timeout: 30000 });
  const asarFile = path.join(app, 'Contents/Resources/app.asar');
  const asar = require(path.join(repo, 'desktop/node_modules/@electron/asar'));
  const modules = Object.fromEntries(PACKAGED_MODULES.map(name => {
    const packaged = sha(asar.extractFile(asarFile, `src/${name}`)), current = hash(path.join(repo, 'desktop/src', name));
    return [name, { packaged, current, identical: packaged === current }];
  }));
  const evidence = fs.mkdtempSync(path.join(ensureOutputParent(repo, 'validation/local/cost-egress-packaged'), 'probe-'));
  // The worktree path is too long for the private Unix-socket budget of the isolated profile, so the
  // profile lives under a fresh short parent (same convention as run-integrity-diagnostic.cjs).
  const parent = fs.mkdtempSync('/private/tmp/cicp-');
  const plan = prepareIsolatedRun({ parentDirectory: parent, runtimeDirectory: runtime, purpose: 'automation',
    forbiddenRoots: ['Code Intelligence', 'Code Intelligence Validation'].map(name => path.join(os.homedir(), 'Library/Application Support', name)) });
  const report = { format: 1, status: 'RUNNING', scope: 'packaged-first-run-ai-entry-points', app,
    buildSequence: manifest.buildSequence, appAsarSha256: hash(asarFile), manifestSha256: hash(manifestFile),
    probeSha256: hash(__filename), packagedModules: modules, mockKeychain: true, realAccount: false, providerActivated: false,
    profile: plan.paths.userData, checks: [], socketSamples: [], fakeProviderPossible: false,
    fakeProviderReason: 'packaged transport is fixed to https://api.openai.com with public-DNS pinning; no base URL or transport override exists' };
  const save = () => fs.writeFileSync(path.join(evidence, 'result.json'), JSON.stringify(report, null, 2) + '\n', { mode: 0o600 });
  save(); console.log(JSON.stringify({ status: report.status, evidence }));
  const { _electron } = createRequire(path.join(repo, 'frontend/package.json'))('playwright');
  const { expect } = createRequire(path.join(repo, 'frontend/package.json'))('@playwright/test');
  let sdk, owner, stopObserving; const diagnostics = {};
  const check = (name, value) => { report.checks.push({ name, ...value }); save(); };
  try {
    sdk = await _electron.launch({ executablePath: path.join(app, 'Contents/MacOS/Code Intelligence Validation'),
      args: ['--use-mock-keychain', '--isolated-run-claim=' + plan.claimFile], cwd: repo, env: launchEnvironment(process.env), timeout: 120000 });
    owner = captureOwnedApplication(sdk);
    stopObserving = observeStartup(owner.process(), diagnostics, () => {});
    const page = await sdk.firstWindow({ timeout: 120000 });
    await expect(page.getByRole('link', { name: 'Code Intelligence home' })).toBeVisible({ timeout: 120000 });
    const identity = await sdk.evaluate(({ app }) => ({ profile: app.getPath('userData'), packaged: app.isPackaged }));
    assert.deepEqual(identity, { profile: plan.paths.userData, packaged: true });
    const sample = async label => { const value = await inetSockets(owner.process().pid); report.socketSamples.push({ label, ...value }); save(); return value; };
    await sample('ready');
    const status = await page.evaluate(() => window.codeIntelligenceDesktop.runtimeStatus());
    check('runtime-status', { ready: status.ready, aiOff: status.aiOff, recoveryOnly: status.recoveryOnly });
    assert.equal(status.ready, true); assert.equal(status.aiOff, true);
    const bridge = await page.evaluate(() => Object.keys(window.codeIntelligenceDesktop).sort());
    check('renderer-bridge-keys', { keys: bridge });
    const api = (route, method = 'GET', body) => page.evaluate(async ({ route, method, body }) => {
      const desktop = window.codeIntelligenceDesktop; const headers = { 'X-Code-Intelligence-Token': desktop.apiToken };
      if (method !== 'GET') {
        await fetch(desktop.apiBaseUrl + '/api/csrf', { credentials: 'include', headers });
        const cookie = document.cookie.split(';').map(p => p.trim()).find(p => p.startsWith('XSRF-TOKEN='));
        if (cookie) headers['X-XSRF-TOKEN'] = decodeURIComponent(cookie.slice('XSRF-TOKEN='.length));
      }
      if (body !== undefined) headers['Content-Type'] = 'application/json';
      const response = await fetch(desktop.apiBaseUrl + route, { method, credentials: 'include', headers,
        body: body === undefined ? undefined : JSON.stringify(body) });
      const text = await response.text(); let json = null; try { json = JSON.parse(text); } catch {}
      return { status: response.status, json, text };
    }, { route, method, body });
    const view = response => ({ status: response.status, code: response.json?.code ?? null,
      containsKey: response.text.includes(SYNTHETIC_KEY) });
    const budget0 = await api('/api/ai/budget');
    const pick = b => b.json && ({ state: b.json.state, daily: b.json.dailyLimitMicroUsd, monthly: b.json.monthlyLimitMicroUsd,
      held: b.json.allDatesHeldMicroUsd, activationToken: b.json.activationToken === null ? null : 'PRESENT' });
    check('first-run-budget', { status: budget0.status, ...pick(budget0) });
    const aiStatus = await api('/api/ai/status');
    check('first-run-ai-status', { status: aiStatus.status, body: aiStatus.json });
    await page.evaluate(() => { history.pushState(null, '', '/settings'); window.dispatchEvent(new PopStateEvent('popstate')); });
    await page.waitForTimeout(1500);
    check('first-run-settings-reconciliation-text', { visible: await page.getByText(/Budget reconciliation needed|예산 재조정 필요/).count() });
    check('first-run-activate-fabricated', view(await api('/api/ai/budget/activate', 'POST', { expectedRevision: budget0.json.policyRevision, activationToken: 'a'.repeat(64) })));
    check('first-run-ask-unknown-project', view(await api('/api/projects/999999/ai/ask', 'POST', { question: 'q' })));
    await sample('after-first-run-probes');
    const saved = await api('/api/ai/settings', 'PUT', { provider: 'openai', model: MODEL, apiKey: SYNTHETIC_KEY });
    check('save-synthetic-key', { ...view(saved), state: saved.json?.state ?? null, keySet: saved.json?.keySet ?? null });
    await sample('after-key-save');
    const budgetKey = await api('/api/ai/budget');
    check('key-saved-budget', { status: budgetKey.status, ...pick(budgetKey) });
    check('key-saved-activate-fabricated', view(await api('/api/ai/budget/activate', 'POST', { expectedRevision: budgetKey.json.policyRevision, activationToken: 'a'.repeat(64) })));
    check('key-saved-runtime-status', { aiOff: (await page.evaluate(() => window.codeIntelligenceDesktop.runtimeStatus())).aiOff });
    const cleared = await api('/api/ai/settings', 'DELETE');
    check('clear-synthetic-key', { ...view(cleared), state: cleared.json?.state ?? null });
    await sample('after-key-clear');
    const failures = [];
    if (report.socketSamples.some(s => s.remote.length)) failures.push('NON_LOOPBACK_SOCKET');
    if (!(budget0.json.dailyLimitMicroUsd === '0' && budget0.json.activationToken === null)) failures.push('FIRST_RUN_BUDGET_NOT_ZERO');
    if (!(budgetKey.json.dailyLimitMicroUsd === '0' && budgetKey.json.activationToken === null && budgetKey.json.allDatesHeldMicroUsd === '0')) failures.push('KEY_SAVED_BUDGET_NOT_ZERO');
    if (saved.status !== 200 || saved.text.includes(SYNTHETIC_KEY)) failures.push('KEY_SAVE_UNEXPECTED');
    if (report.checks.find(c => c.name === 'key-saved-runtime-status').aiOff !== true) failures.push('AI_ACTIVATED');
    for (const name of ['first-run-activate-fabricated', 'key-saved-activate-fabricated'])
      if (report.checks.find(c => c.name === name).status === 200) failures.push('ACTIVATION_ACCEPTED');
    report.failures = failures; report.status = failures.length ? 'FAIL' : 'PASS';
  } catch (error) { report.status = 'FAIL'; report.failure = String(error?.message ?? 'PROBE_FAILED').slice(0, 120); }
  finally {
    if (owner) {
      try { await closeValidatedApplication(owner, diagnostics); await confirmObservedGone([owner.process().pid]); report.cleanupConfirmed = true; }
      catch { report.cleanupConfirmed = false; report.status = 'FAIL'; }
      report.exit = { code: owner.process().exitCode, signal: owner.process().signalCode, shutdown: diagnostics.shutdown ?? null };
    }
    stopObserving?.();
    // The synthetic profile is not evidence; remove this run's own parent only after the app is confirmed gone.
    if (report.cleanupConfirmed) { fs.rmSync(parent, { recursive: true, force: true }); report.profileRemoved = true; }
    try { assert.equal(hash(asarFile), report.appAsarSha256); assert.equal(hash(manifestFile), report.manifestSha256); report.bundleUnchanged = true; }
    catch { report.bundleUnchanged = false; report.status = 'FAIL'; }
    save();
  }
  console.log(JSON.stringify({ status: report.status, evidence, failures: report.failures ?? null }));
  if (report.status !== 'PASS') process.exitCode = 1;
}
if (require.main === module) main().catch(error => { console.error(error?.message ?? 'PROBE_FAILED'); process.exitCode = 1; });
module.exports = { inetSockets };
