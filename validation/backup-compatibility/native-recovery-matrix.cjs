'use strict';

// Opt-in packaged-app C16 restore crash matrix. One NEW automation claim per invocation under a
// short private /private/tmp parent (macOS Unix-socket budget), the unmodified retained bundle,
// real bundled services, encrypted backups and mock Keychain. Each point holds the actual restore
// at one durable edge, SIGKILLs only the captured Electron main, then verifies recovery and one
// further normal restart in the same profile before the next point. --cost first creates a
// nonzero ledger through the real AI gateway/journal/PG path; only the provider TLS connection
// is replaced by a loopback stand-in. This is not power loss, real Keychain or a real account.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const { createRequire } = require('node:module');
const { execFileSync } = require('node:child_process');
const { prepareIsolatedRun } = require('../../desktop/src/isolated-run.cjs');
const { launchEnvironment, bounded } = require('../../desktop/scripts/packaged-keychain-acceptance.cjs');
const { createDeadline, closeValidatedApplication, observeStartup } = require('../../desktop/scripts/native-acceptance-electron.cjs');
const { validateRuntimeManifest } = require('../../desktop/src/runtime-manifest.cjs');
const { installOwnedDialogs, captureOwnedApplication } = require('./interruption-hooks.cjs');
const { BOUNDARIES, installOwnedBoundary, installOwnedTransport } = require('./recovery-boundaries.cjs');
const { killCapturedApplication } = require('./owned-crash.cjs');
const { ensureOutputParent } = require('../pre-release/owned-output.cjs');
const { withDropConfirmation } = require('../pre-release/drop-confirmation.cjs');
const sha = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const digest = file => sha(fs.readFileSync(file));
const MODEL = 'gpt-4o-mini-2024-07-18';
const SETTLED_MICRO_USD = '210'; // ceil((1000 * 150000 + 100 * 600000) / 1e6) for the synthetic usage.

// Crafted B-area faults applied to the synthetic profile while the app is stopped. Each models
// a damaged or newer-major journal that the packaged binary must refuse without repairing it.
// The last two are old-archive selections through the real IPC/picker path rather than B faults.
const FAULTS = Object.freeze(['torn-tail', 'corrupt-mac', 'incompatible-major', 'latch-major', 'missing',
  'format2-archive', 'container-v2']);

function argumentsFor(argv) {
  assert(Array.isArray(argv) && (argv.length === 4 || argv.length === 5));
  assert.equal(argv[0], '--app'); assert(['--points', '--faults'].includes(argv[2]));
  assert(typeof argv[1] === 'string' && path.isAbsolute(argv[1]));
  const values = argv[3].split(',');
  assert(values.length >= 1 && values.length <= 30 && new Set(values).size === values.length);
  if (argv[2] === '--faults') {
    assert.equal(argv.length, 4);
    for (const fault of values) assert(FAULTS.includes(fault), 'UNKNOWN_FAULT');
    return { app: argv[1], points: [], faults: values, cost: false };
  }
  for (const point of values) assert(Object.hasOwn(BOUNDARIES, point), 'UNKNOWN_POINT');
  if (argv.length === 5) assert.equal(argv[4], '--cost');
  return { app: argv[1], points: values, faults: [], cost: argv.length === 5 };
}

function canonical(value) {
  return Array.isArray(value) ? `[${value.map(canonical).join(',')}]`
    : value && typeof value === 'object' ? `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`
      : JSON.stringify(value);
}
function journalFrames(bytes) {
  const frames = []; let offset = 0;
  while (offset + 4 <= bytes.length) {
    const length = bytes.readUInt32BE(offset); if (offset + 4 + length > bytes.length) break;
    frames.push({ offset, bytes: bytes.subarray(offset, offset + 4 + length), value: JSON.parse(bytes.subarray(offset + 4, offset + 4 + length).toString('utf8')) });
    offset += 4 + length;
  }
  return frames;
}
// Pure transformation of the synthetic journal bytes; MACs are never computed or verified here.
function faultedJournal(fault, bytes) {
  if (fault === 'torn-tail') return Buffer.concat([bytes, Buffer.from([0, 0, 0, 9, 123, 34])]);
  const frames = journalFrames(bytes), last = frames.at(-1);
  assert(last && last.offset + last.bytes.length === bytes.length, 'JOURNAL_FRAMES');
  if (fault === 'corrupt-mac') {
    const text = last.bytes.subarray(4).toString('utf8'), at = text.indexOf('"mac":"') + 7;
    assert(at > 6);
    const flipped = text.slice(0, at) + (text[at] === '0' ? '1' : '0') + text.slice(at + 1);
    const body = Buffer.from(flipped); assert.equal(body.length, last.bytes.length - 4);
    return Buffer.concat([bytes.subarray(0, last.offset + 4), body]);
  }
  if (fault === 'incompatible-major') {
    const body = Buffer.from(canonical({ major: last.value.major + 1, sequence: last.value.sequence + 1,
      previousHash: crypto.createHash('sha256').update(last.bytes).digest('hex'), atMs: last.value.atMs,
      event: { type: 'LATCH', reason: 'USER_OFF' }, keyId: last.value.keyId, mac: '0'.repeat(64) }));
    const prefix = Buffer.alloc(4); prefix.writeUInt32BE(body.length);
    return Buffer.concat([bytes, prefix, body]);
  }
  throw new Error('UNKNOWN_FAULT');
}

// Journal frames are plaintext MACed JSON: only fixed event types, request UUIDs, amounts and
// high-water marks are read here. MACs are not verified by this observer.
function journalFacts(bytes) {
  const facts = { frames: 0, types: {}, reserved: {}, dispatched: {}, settled: {}, unknown: {}, restored: {},
    highWater: [], torn: false };
  let offset = 0;
  while (offset < bytes.length) {
    if (bytes.length - offset < 4) { facts.torn = true; break; }
    const length = bytes.readUInt32BE(offset);
    if (length < 1 || bytes.length - offset - 4 < length) { facts.torn = true; break; }
    const value = JSON.parse(bytes.subarray(offset + 4, offset + 4 + length).toString('utf8'));
    const event = value.event; facts.frames++; facts.types[event.type] = (facts.types[event.type] || 0) + 1;
    const add = (map, id) => { map[id] = (map[id] || 0) + 1; };
    if (event.type === 'RESERVED') add(facts.reserved, event.reservation.requestId);
    if (event.type === 'DISPATCH_INTENT') add(facts.dispatched, event.requestId);
    if (event.type === 'SETTLED') facts.settled[event.settlement.requestId] = event.settlement.actualMicroUsd;
    if (event.type === 'UNKNOWN_HELD') add(facts.unknown, event.requestId);
    if (event.type === 'RESTORE_OBLIGATION_V2' || event.type === 'RESTORE_OBLIGATION') add(facts.restored, event.obligation.requestId);
    if (['MAINTENANCE_SEALED', 'MAINTENANCE_COMPLETED'].includes(event.type)) {
      facts.highWater.push({ type: event.type, budgetDay: event.metadata.budgetDay, minimumVersion: event.metadata.minimumVersion });
    }
    if (event.type === 'RESTORE_BEGIN') facts.highWater.push({ type: event.type, budgetDay: event.budgetDay, minimumVersion: event.minimumVersion });
    offset += 4 + length;
  }
  return facts;
}

function monotonicHighWater(rows) {
  for (let i = 1; i < rows.length; i++) {
    if (rows[i].budgetDay < rows[i - 1].budgetDay || BigInt(rows[i].minimumVersion) < BigInt(rows[i - 1].minimumVersion)) return false;
  }
  return true;
}

async function main(argv) {
  assert.equal(process.platform, 'darwin'); assert.equal(process.arch, 'arm64');
  const options = argumentsFor(argv);
  process.umask(0o077);
  let deadline = createDeadline();
  const perform = (fn, ms = 30000) => deadline.run(fn, ms);
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
  // A short parent keeps the product's private Unix sockets under the macOS path limit.
  const parent = fs.realpathSync(fs.mkdtempSync('/private/tmp/cirm-'));
  const plan = prepareIsolatedRun({ parentDirectory: parent, runtimeDirectory: runtime, purpose: 'automation',
    forbiddenRoots: ['Code Intelligence', 'Code Intelligence Validation'].map(n => path.join(os.homedir(), 'Library/Application Support', n)) });
  const runRoot = plan.paths.output;
  const fixture = path.join(runRoot, 'fixture'), output = path.join(runRoot, 'output');
  for (const directory of [fixture, output]) fs.mkdirSync(directory, { mode: 0o700 });
  const oldSource = 'export function interruptedRestore(): number { return 91; }\n';
  const newSource = oldSource.replace('return 91', 'return 92');
  const inputFile = path.join(fixture, 'recovery.ts');
  fs.writeFileSync(inputFile, oldSource, { flag: 'wx', mode: 0o600 });
  const sentinel = 'sk-proj-CIRECOVERYSENTINEL' + crypto.randomBytes(12).toString('hex');
  const evidenceRoot = ensureOutputParent(root, 'validation/local/recovery-matrix');
  const evidence = fs.mkdtempSync(path.join(evidenceRoot, 'native-'));
  const report = { format: 1, status: 'RUNNING', scope: 'packaged-c16-restore-crash-matrix', points: options.points,
    cost: options.cost, bundle, evidence, claim: plan.claimFile, profile: plan.paths.userData, parent,
    mockKeychain: true, realAccount: false, nativeDialogInteraction: false, sigkill: true, powerLoss: false,
    providerNetwork: false, appAsarSha256: digest(path.join(bundle, 'Contents/Resources/app.asar')),
    manifestSha256: digest(manifestFile), buildSequence: manifest.buildSequence, driverSha256: digest(__filename),
    boundarySha256: digest(path.join(__dirname, 'recovery-boundaries.cjs')),
    hooksSha256: digest(path.join(__dirname, 'interruption-hooks.cjs')),
    crashHelperSha256: digest(path.join(__dirname, 'owned-crash.cjs')),
    checks: [], launches: [], exits: [], dialogEvents: [], results: [], transport: [] };
  const save = () => fs.writeFileSync(path.join(evidence, 'result.json'), JSON.stringify(report, null, 2) + '\n', { mode: 0o600 });
  const phase = value => { report.phase = value; report.phaseAt = new Date().toISOString(); save(); };
  const check = value => { report.checks.push(value); save(); };
  let app, applicationOwner, page, stopObserving, stopDialogs, heldHook, transport, launchSequence = 0, projectId, noteId, taskId;
  const task = label => ({ type: 'DEVELOPMENT', title: 'Synthetic recovery task', description: 'Synthetic task at ' + label,
    status: 'OPEN', goals: ['Synthetic goal at ' + label] });
  const proofs = {}, ciphers = {}, backups = {}, backupHashes = {};
  const states = {};
  let current, ledger = null;
  const userData = plan.paths.userData;
  const keyFile = path.join(userData, 'safety/purpose-keyring/purpose-keyring.wrapped');
  const journalFile = path.join(userData, 'safety/ai-journal/events.log');

  async function launch(recover = false, expectAiOff = true) {
    phase(recover ? 'launch-restricted-recovery' : 'launch-normal'); plan.assertIdentity();
    app = await _electron.launch({ executablePath: path.join(bundle, 'Contents/MacOS/Code Intelligence Validation'),
      args: ['--use-mock-keychain', '--isolated-run-claim=' + plan.claimFile], env: launchEnvironment(process.env), cwd: root,
      timeout: deadline.limit(90000) });
    applicationOwner = captureOwnedApplication(app);
    const child = applicationOwner.process(), sequence = ++launchSequence, nonce = crypto.randomBytes(16).toString('hex');
    report.launches.push({ sequence, pid: child.pid, recover, at: new Date().toISOString() }); save();
    delete report.startup; delete report.shutdown; delete report.shutdownTrace;
    stopObserving = observeStartup(child, report, save);
    let line = '', dropping = false;
    const listen = bytes => { for (const character of bytes.toString('utf8')) {
      if (character === '\n') {
        const prefix = 'OWNED_RECOVERY_EVENT ' + nonce + ' ';
        if (!dropping && line.startsWith(prefix)) {
          const code = line.slice(prefix.length).trim();
          if (/^[A-Z_]{1,40}$/.test(code)) { report.dialogEvents.push({ sequence, code }); save(); }
        }
        line = ''; dropping = false;
      } else if (!dropping) { if (line.length >= 160) { dropping = true; line = ''; } else line += character; }
    } };
    child.stderr.on('data', listen); stopDialogs = () => child.stderr.off('data', listen);
    await perform(() => app.evaluate(installOwnedDialogs, { profile: userData, parent, nonce, recover }));
    if (options.cost) {
      transport = await perform(() => app.evaluateHandle(installOwnedTransport,
        { profile: userData, parent, credentialSha256: sha('Bearer ' + sentinel) }));
    }
    page = await perform(() => app.firstWindow({ timeout: deadline.limit(120000) }), 120000);
    page.setDefaultTimeout(30000);
    await perform(() => expect(page.getByRole('link', { name: 'Code Intelligence home' })).toBeVisible(), 60000);
    await healthy(expectAiOff);
    assert.equal(report.dialogEvents.filter(e => e.sequence === sequence && e.code === 'RECOVERY_ACCEPTED').length, recover ? 1 : 0);
    assert.equal(report.dialogEvents.some(e => e.sequence === sequence && e.code !== 'RECOVERY_ACCEPTED'), false);
  }
  async function closeTransport(sequence) {
    if (!transport) return;
    const handle = transport; transport = undefined;
    try { report.transport.push({ sequence, ...await bounded(() => handle.evaluate(h => h.restore()), 5000, 'TRANSPORT_RESTORE_TIMEOUT') }); }
    finally { await bounded(() => handle.dispose(), 5000, 'TRANSPORT_DISPOSE_TIMEOUT').catch(() => {}); save(); }
  }
  async function close() {
    if (!app) return;
    const owned = applicationOwner, child = owned.process(), sequence = launchSequence;
    const record = { sequence, pid: child.pid };
    try { await closeTransport(sequence); await closeValidatedApplication(owned, report); }
    catch (error) { record.failure = /^[A-Z_]+$/.test(error.message) ? error.message : error.name; throw error; }
    finally {
      record.code = child.exitCode; record.signal = child.signalCode;
      record.shutdown = report.shutdown ?? null; record.shutdownTrace = report.shutdownTrace ?? [];
      record.processExitedZero = child.exitCode === 0 && child.signalCode === null;
      record.cleanShutdownObserved = record.processExitedZero && !record.failure && record.shutdown?.state === 'COMPLETE'
        && !report.dialogEvents.some(e => e.sequence === sequence && e.code !== 'RECOVERY_ACCEPTED');
      if (child.exitCode !== null || child.signalCode !== null) { app = null; applicationOwner = null; page = null; }
      report.exits.push(record); stopObserving?.(); stopDialogs?.(); save();
    }
  }
  async function crash(label) {
    const owner = applicationOwner, child = owner.process(), proof = {};
    phase('kill-owned-electron-' + label);
    if (transport) {
      // Read the loopback stand-in's counters before the process (and its handle) disappears.
      try { report.transport.push({ sequence: launchSequence, beforeKill: true,
        ...await bounded(() => transport.evaluate(h => h.inspect()), 5000, 'TRANSPORT_INSPECT_TIMEOUT') }); } catch { report.transportInspectFailed = true; }
    }
    try { await killCapturedApplication(owner, proof); }
    finally {
      if (child.exitCode !== null || child.signalCode !== null) {
        report.exits.push({ sequence: launchSequence, pid: child.pid, code: child.exitCode, signal: child.signalCode,
          intentionalCrash: label, cleanShutdownObserved: false, observedProcesses: proof.observedBefore?.length ?? null,
          observedTreeGone: proof.observedTreeGone === true });
        app = null; applicationOwner = null; heldHook = undefined; page = null; transport = undefined;
        stopObserving?.(); stopDialogs?.(); stopObserving = undefined; stopDialogs = undefined;
      }
      save();
    }
    assert.equal(proof.observedTreeGone, true); assert.equal(proof.exit.signal, 'SIGKILL');
    return proof;
  }
  const status = () => perform(() => page.evaluate(() => window.codeIntelligenceDesktop.runtimeStatus()));
  async function healthy(expectAiOff = true) {
    const value = await status();
    assert.equal(value.ready, true); assert.equal(value.recoveryOnly, false); assert.equal(value.error, null);
    assert.equal(value.backupSupported, true); assert.equal(value.backupAvailable, true); assert.equal(value.restoreAvailable, true);
    assert.equal(value.aiOff, expectAiOff);
  }
  const navigate = route => perform(() => page.evaluate(route => { history.pushState(null, '', route); dispatchEvent(new PopStateEvent('popstate')); }, route));
  const request = (route, method = 'GET', body) => perform(() => page.evaluate(async ({ route, method, body }) => {
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
    const text = await response.text();
    let json = null; try { json = text ? JSON.parse(text) : null; } catch { json = null; }
    return { status: response.status, json };
  }, { route, method, body }), 120000);
  async function api(route, method = 'GET', body) {
    const value = await request(route, method, body);
    if (value.status < 200 || value.status > 299) throw new Error('OWNED_API_FAILED');
    return value.json;
  }
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
  function journalPrefix() { plan.assertIdentity(); const bytes = fs.readFileSync(journalFile); return { bytes: bytes.length, sha256: sha(bytes) }; }
  function assertPrefix(expected) {
    const bytes = fs.readFileSync(journalFile); assert(bytes.length >= expected.bytes, 'JOURNAL_SHORTENED');
    assert.equal(sha(bytes.subarray(0, expected.bytes)), expected.sha256, 'JOURNAL_PREFIX_CHANGED');
  }
  function ownedFile(file) {
    plan.assertIdentity(); assert(file.startsWith(plan.root + path.sep));
    assert.equal(fs.realpathSync(file), file);
    const stat = fs.lstatSync(file);
    assert(stat.isFile() && !stat.isSymbolicLink() && stat.nlink === 1 && stat.uid === process.getuid());
    assert.equal(stat.mode & 0o7777, 0o600); assert(stat.size <= 64 * 1024 * 1024);
    return { bytes: stat.size, device: String(stat.dev), inode: String(stat.ino), sha256: digest(file) };
  }
  function blob(text) {
    const file = path.join(userData, 'data/sources', String(projectId), sha(text), 'blob.bin');
    const value = ownedFile(file); assert(value.bytes > Buffer.byteLength(text));
    return { contentSha256: sha(text), bytes: value.bytes, sha256: value.sha256 };
  }
  async function retainedContent(text, snapshot) {
    const value = await api(`/api/projects/${projectId}/file-content?path=recovery.ts&snapshotId=${snapshot}`);
    assert.equal(value.resolvedSnapshotId, snapshot); assert.equal(value.sourceState, 'AVAILABLE');
    assert.equal(value.evidenceState, null); assert.equal(value.content, text);
    return { snapshotId: snapshot, contentOid: value.contentOid, contentSha256: sha(value.content), sourceState: value.sourceState };
  }
  function permanentState() {
    const safety = path.join(userData, 'safety');
    return Object.fromEntries(['purpose-keyring/purpose-keyring.wrapped', 'purpose-keyring/owner.lock',
      'source-vault/source-keyring.wrapped', 'source-vault/owner.lock', 'ai-journal/writer.lock']
      .map(name => [name, ownedFile(path.join(safety, name))]));
  }
  function recordPrefix() {
    const directory = path.join(userData, 'backup-maintenance');
    const names = fs.readdirSync(directory).filter(name => /^(record|receipt)-[0-9]{8}\.enc$/.test(name)).sort();
    assert(names.length > 0 && names.length <= 2000);
    return Object.fromEntries(names.map(name => [name, ownedFile(path.join(directory, name))]));
  }
  function verifyRecordPrefix(expected) {
    const observed = recordPrefix();
    for (const [name, value] of Object.entries(expected)) assert.deepEqual(observed[name], value, 'RECORD_HISTORY_CHANGED');
    return Object.keys(observed).length;
  }
  function recoveryDirectories() {
    const directory = path.join(userData, 'recovery');
    return fs.existsSync(directory) ? fs.readdirSync(directory).filter(name => /^[0-9a-f-]{36}$/.test(name)).sort() : [];
  }
  function sentinelScan(files) {
    const needles = [sentinel, Buffer.from(sentinel).toString('base64'), Buffer.from(sentinel).toString('hex')].map(v => Buffer.from(v));
    const result = { files: 0, bytes: 0, matches: 0 };
    for (const file of files) {
      if (!fs.existsSync(file)) continue;
      const bytes = fs.readFileSync(file); result.files++; result.bytes += bytes.length;
      for (const needle of needles) if (bytes.includes(needle)) result.matches++;
    }
    return result;
  }
  async function budget() {
    const value = await api('/api/ai/budget');
    return { state: value.state, held: value.allDatesHeldMicroUsd, daily: value.dailySettledMicroUsd, monthly: value.monthlySettledMicroUsd,
      policyRevision: value.policyRevision, activationToken: value.activationToken };
  }
  async function activateAi() {
    let view = await budget();
    assert.equal(typeof view.activationToken, 'string', 'AI_ACTIVATION_UNAVAILABLE');
    const activated = await api('/api/ai/budget/activate', 'POST', { expectedRevision: view.policyRevision, activationToken: view.activationToken });
    assert.equal(activated.state, 'READY');
    view = await budget(); assert.equal(view.state, 'READY');
  }
  async function verifyLedger(where) {
    if (!options.cost) return null;
    const view = await budget(), facts = journalFacts(fs.readFileSync(journalFile));
    const ids = [ledger.settledRequestId, ledger.heldRequestId];
    const result = { where, held: view.held, daily: view.daily, monthly: view.monthly, state: view.state,
      reserved: Object.fromEntries(ids.map(id => [id, facts.reserved[id] ?? 0])),
      dispatched: Object.fromEntries(ids.map(id => [id, facts.dispatched[id] ?? 0])),
      settledActual: facts.settled[ledger.settledRequestId] ?? null, foreignRequests: Object.keys(facts.reserved).filter(id => !ids.includes(id)).length,
      highWaterMonotonic: monotonicHighWater(facts.highWater), torn: facts.torn };
    ledger.checks.push(result); save();
    assert.equal(view.held, ledger.heldMicroUsd, 'LEDGER_HELD_CHANGED');
    assert.equal(view.monthly, SETTLED_MICRO_USD, 'LEDGER_SETTLED_CHANGED');
    for (const id of ids) { assert.equal(result.reserved[id], 1, 'REQUEST_RESERVED_COUNT'); assert.equal(result.dispatched[id], 1, 'REQUEST_DISPATCH_COUNT'); }
    assert.equal(result.settledActual, SETTLED_MICRO_USD); assert.equal(result.foreignRequests, 0);
    assert.equal(result.highWaterMonotonic, true); assert.equal(result.torn, false);
    // Each finished launch contributes exactly one row (pre-kill snapshot or final restore).
    const live = transport ? (await bounded(() => transport.evaluate(h => h.inspect()), 5000, 'TRANSPORT_INSPECT_TIMEOUT')).attempts : 0;
    result.providerAttempts = report.transport.reduce((n, row) => n + row.attempts, 0) + live; save();
    assert.equal(result.providerAttempts, 2, 'PROVIDER_ATTEMPTS_CHANGED');
    return result;
  }
  async function verifyLatchedDispatchRefused(where) {
    if (!options.cost) return;
    const before = await bounded(() => transport.evaluate(h => h.inspect()), 5000, 'TRANSPORT_INSPECT_TIMEOUT');
    const refused = await request(`/api/projects/${projectId}/ai/request-plan`, 'POST', { question: 'Synthetic latched dispatch probe' });
    const after = await bounded(() => transport.evaluate(h => h.inspect()), 5000, 'TRANSPORT_INSPECT_TIMEOUT');
    ledger.latchedProbes.push({ where, status: refused.status, attemptsBefore: before.attempts, attemptsAfter: after.attempts }); save();
    assert(refused.status >= 400, 'LATCHED_PLAN_ACCEPTED'); assert.equal(after.attempts, before.attempts);
  }
  async function verifyState(key, { recordFloor, journalFloor, stable } = {}) {
    const state = states[key];
    assert.equal((await api('/api/projects/' + projectId)).currentSnapshot.id, state.snapshot, 'CURRENT_SNAPSHOT');
    for (const snapshot of state.snapshots) assert.deepEqual(await retainedContent(proofs[snapshot].text, snapshot), proofs[snapshot].proof);
    for (const snapshot of state.snapshots) assert.deepEqual(blob(proofs[snapshot].text), ciphers[snapshot]);
    await source(state.source, state.snapshot); await healthy();
    assert.equal((await api(`/api/projects/${projectId}/notes/${noteId}`)).contentMd, state.note, 'NOTE_CONTENT');
    const restoredTask = await api(`/api/projects/${projectId}/tasks/${taskId}`), expectedTask = task(state.label);
    assert.equal(restoredTask.description, expectedTask.description, 'TASK_CONTENT'); assert.equal(restoredTask.status, expectedTask.status);
    assert.deepEqual(restoredTask.goals.map(goal => goal.content), expectedTask.goals, 'TASK_GOALS');
    if (stable) assert.deepEqual(permanentState(), stable);
    if (journalFloor) assertPrefix(journalFloor);
    if (recordFloor) verifyRecordPrefix(recordFloor);
    return true;
  }
  async function importFixture() {
    phase('import-fixture'); await navigate('/import');
    const picker = page.getByRole('button', { name: 'Choose folder', exact: true });
    await perform(() => expect(picker).toBeVisible()); const box = await perform(() => picker.boundingBox()); assert(box);
    // SEC-M-02: main grants the drop only after its native confirmation; answered once and verified.
    const { confirmation } = await withDropConfirmation(app, fixture, async () => {
      const cdp = await perform(() => page.context().newCDPSession(page)); let dragFailure;
      try { for (const type of ['dragEnter', 'dragOver', 'drop']) await perform(() => cdp.send('Input.dispatchDragEvent', {
        type, x: box.x + box.width / 2, y: box.y + box.height / 2, data: { items: [], files: [fixture], dragOperationsMask: 1 } })); }
      catch (error) { dragFailure = error; throw error; }
      finally { try { await bounded(() => cdp.detach(), 5000, 'DRAG_DETACH_TIMEOUT'); } catch (error) { if (!dragFailure) throw error; } }
      await perform(() => page.getByRole('button', { name: /^(Preview files to import|가져올 파일 미리보기)$/ }).click());
    });
    (report.dropConfirmations ??= []).push(confirmation); save();
    const [created] = await perform(() => Promise.all([
      page.waitForResponse(r => new URL(r.url()).pathname === '/api/projects/local' && r.request().method() === 'POST'),
      page.getByRole('button', { name: /^(Import and analyze the reviewed files|확인한 파일 가져오기 및 분석)$/ }).click()]));
    assert(created.ok()); projectId = (await perform(() => created.json())).project.id;
    await perform(() => expect.poll(async () => (await api('/api/projects/' + projectId)).currentSnapshot?.status, { timeout: 90000 }).toBe('READY'), 90000);
    return (await api('/api/projects/' + projectId)).currentSnapshot.id;
  }
  async function reanalyze() {
    phase('reanalyze-newer-state'); await source(oldSource, states.B1.snapshot);
    fs.writeFileSync(inputFile, newSource, { mode: 0o600 });
    await perform(() => page.getByRole('button', { name: /^(Refresh status|상태 새로고침)$/ }).click());
    await perform(() => page.getByRole('button', { name: /^(Preview changes|변경 사항 미리보기)$/ }).click());
    await perform(() => expect(page.getByRole('region', { name: /^(Import preview to review|확인할 가져오기 미리보기)$/ })).toBeVisible());
    const [updated] = await perform(() => Promise.all([
      page.waitForResponse(r => new URL(r.url()).pathname === `/api/projects/${projectId}/reanalyze` && r.request().method() === 'POST'),
      page.getByRole('button', { name: /^(Re-analyze everything after reviewing changes|변경 확인 후 전체 재분석)$/ }).click()]));
    assert(updated.ok()); const job = (await perform(() => updated.json())).jobId;
    await perform(() => expect.poll(async () => (await api('/api/jobs/' + job)).status, { timeout: 90000 }).toBe('DONE'), 90000);
    return (await api('/api/projects/' + projectId)).currentSnapshot.id;
  }
  async function backup(name) {
    phase('create-backup-' + name); await navigate('/settings');
    const selected = await withPicker('backup', output, async () => {
      await perform(() => page.getByRole('button', { name: /^(Create backup|백업 생성)$/ }).click());
      const value = page.locator('dd').filter({ hasText: /\.cibackup$/ });
      await perform(() => expect(value).toHaveCount(1, { timeout: 120000 }), 120000);
      return ownSelection((await perform(() => value.textContent())).trim());
    });
    // A later backup replaces the single result line; wait for the new path only.
    assert(!Object.values(backups).includes(selected));
    backups[name] = selected; backupHashes[name] = digest(selected); return selected;
  }
  async function askAi(question, mode) {
    const body = { question };
    const plan = await api(`/api/projects/${projectId}/ai/request-plan`, 'POST', body);
    assert.equal(plan.costStatus, 'AVAILABLE'); assert.equal(plan.provider, 'openai'); assert.equal(plan.model, MODEL);
    await bounded(() => transport.evaluate((h, value) => h.setMode(value), mode), 5000, 'TRANSPORT_MODE_TIMEOUT');
    return { plan, body: { ...body, requestPlanToken: plan.requestPlanToken } };
  }
  async function setupCost() {
    phase('cost-enable-ai');
    const settings = await api('/api/ai/settings', 'PUT', { provider: 'openai', model: MODEL, apiKey: sentinel });
    assert.equal(settings.keySet, true); assert.equal(settings.state, 'ENABLED');
    const initial = await budget();
    const configured = await api('/api/ai/budget', 'PUT', { expectedRevision: initial.policyRevision,
      dailyLimitMicroUsd: '1000000', monthlyLimitMicroUsd: '10000000' });
    assert.notEqual(configured.policyRevision, initial.policyRevision);
    await activateAi(); await healthy(false);
    phase('cost-settled-request');
    const first = await askAi('Explain the synthetic recovery function.', 'settle');
    const answered = await request(`/api/projects/${projectId}/ai/ask`, 'POST', first.body);
    const view = await budget();
    ledger = { settledRequestId: first.plan.requestId, settledReservedMicroUsd: first.plan.cost.reservedMicroUsd,
      settledAnswerStatus: answered.status, afterSettle: view, checks: [], latchedProbes: [] };
    save();
    assert.equal(view.monthly, SETTLED_MICRO_USD); assert.equal(view.held, '0');
    const stats = await bounded(() => transport.evaluate(h => h.inspect()), 5000, 'TRANSPORT_INSPECT_TIMEOUT');
    assert.equal(stats.attempts, 1); assert.equal(stats.settled, 1); assert.equal(stats.credentialMatches, 1);
    check('real-ai-path-settled-nonzero-cost-through-loopback-provider-stand-in');
  }
  async function dispatchHeldAndCrash() {
    phase('cost-dispatched-request'); await activateAi();
    const second = await askAi('Explain the synthetic recovery function again.', 'hold');
    ledger.heldRequestId = second.plan.requestId; ledger.heldMicroUsd = second.plan.cost.reservedMicroUsd; save();
    void page.evaluate(async ({ projectId, body }) => {
      const d = window.codeIntelligenceDesktop, headers = { 'X-Code-Intelligence-Token': d.apiToken, 'Content-Type': 'application/json' };
      const csrf = await fetch(d.apiBaseUrl + '/api/csrf', { credentials: 'include', headers: { 'X-Code-Intelligence-Token': d.apiToken } });
      if (!csrf.ok) return;
      const cookie = document.cookie.split(';').map(part => part.trim()).find(part => part.startsWith('XSRF-TOKEN='));
      if (cookie) headers['X-XSRF-TOKEN'] = decodeURIComponent(cookie.slice('XSRF-TOKEN='.length));
      await fetch(d.apiBaseUrl + `/api/projects/${projectId}/ai/ask`, { method: 'POST', credentials: 'include', headers, body: JSON.stringify(body) });
    }, { projectId, body: second.body }).catch(() => {});
    await perform(() => expect.poll(async () => (await transport.evaluate(h => h.inspect())).held, { timeout: 60000 }).toBe(1), 60000);
    const facts = journalFacts(fs.readFileSync(journalFile));
    assert.equal(facts.dispatched[ledger.heldRequestId], 1); assert.equal(facts.settled[ledger.heldRequestId], undefined);
    ledger.dispatchedBeforeCrash = { reserved: facts.reserved[ledger.heldRequestId], dispatched: facts.dispatched[ledger.heldRequestId] };
    const stable = permanentState(), prefix = journalPrefix();
    check('second-request-durably-dispatched-and-held-in-flight');
    await crash('in-flight-ai-dispatch');
    assert.deepEqual(permanentState(), stable); assertPrefix(prefix);
    await launch(false);
    const view = await budget();
    ledger.afterDispatchCrash = view; save();
    assert.equal(view.held, ledger.heldMicroUsd); assert.equal(view.monthly, SETTLED_MICRO_USD);
    await verifyLatchedDispatchRefused('after-dispatch-crash');
    check('in-flight-dispatch-crash-retains-full-hold-and-latched-ai-refuses-new-dispatch');
  }
  async function runPoint(point) {
    deadline = createDeadline();
    const spec = BOUNDARIES[point], target = current === 'B2' ? 'B1' : 'B2', from = current;
    const result = { point, ...spec, from, target, status: 'RUNNING', startedAt: new Date().toISOString() };
    report.results.push(result); save();
    const stable = permanentState(), baselineJournal = journalPrefix(), baselineRecords = recordPrefix();
    const beforeDirs = recoveryDirectories();
    phase('hold-' + point); await navigate('/settings');
    heldHook = await perform(() => app.evaluateHandle(installOwnedBoundary, { profile: userData, parent, point }));
    await withPicker('restore', backups[target], async () => {
      await perform(() => page.getByRole('button', { name: /^(Restore backup|백업 복원)$/ }).click());
      await perform(() => page.getByRole('alert').getByRole('button', { name: /^(Confirm restore|복원 확인)$/ }).click());
      await perform(() => expect.poll(async () => {
        const value = await heldHook.evaluate(h => h.inspect());
        return value.mismatch ? 'MISMATCH' : value.hit ? 'HIT' : 'WAIT';
      }, { timeout: 240000 }).not.toBe('WAIT'), 240000);
    });
    result.hook = await perform(() => heldHook.evaluate(h => h.inspect())); save();
    assert.equal(result.hook.mismatch, null, 'BOUNDARY_SEQUENCE_MISMATCH'); assert.equal(result.hook.hit.point, point);
    const created = recoveryDirectories().filter(name => !beforeDirs.includes(name));
    assert.equal(created.length, 1, 'TRANSACTION_DIRECTORY'); const transactionId = created[0];
    const transactionRoot = path.join(userData, 'recovery', transactionId);
    const activeFile = path.join(userData, 'backup-maintenance/active.enc');
    result.crashState = { transactionId, activeMarker: fs.existsSync(activeFile) ? ownedFile(activeFile) : null,
      records: Object.keys(recordPrefix()).length, journal: journalPrefix(),
      checkpointArchive: fs.existsSync(path.join(transactionRoot, 'checkpoint.cibackup')) ? digest(path.join(transactionRoot, 'checkpoint.cibackup')) : null,
      inputArchiveMatches: digest(path.join(transactionRoot, 'input/archive.cibackup')) === backupHashes[target],
      plaintextSentinel: sentinelScan([path.join(transactionRoot, 'incoming/payload.bin'), path.join(transactionRoot, 'checkpoint/payload.bin')]),
      stageDirectories: ['repos', 'sources', 'previous-repos', 'previous-sources'].filter(name => fs.existsSync(path.join(transactionRoot, name))) };
    save();
    assert.equal(result.crashState.inputArchiveMatches, true); assert.equal(result.crashState.plaintextSentinel.matches, 0);
    assertPrefix(baselineJournal); verifyRecordPrefix(baselineRecords); assert.deepEqual(permanentState(), stable);
    const crashRecords = recordPrefix(), crashJournal = journalPrefix();
    result.crash = await crash(point);
    assert.deepEqual(permanentState(), stable); assertPrefix(crashJournal); verifyRecordPrefix(crashRecords);
    if (result.crashState.activeMarker) assert.deepEqual(ownedFile(activeFile), result.crashState.activeMarker);
    await launch(spec.prompt); phase('verify-' + point);
    const expected = spec.outcome === 'RESTORED' ? target : from;
    await verifyState(expected, { recordFloor: crashRecords, journalFloor: crashJournal, stable });
    result.recordsAfterRecovery = Object.keys(recordPrefix()).length;
    if (spec.prompt) assert(result.recordsAfterRecovery > Object.keys(crashRecords).length, 'RECOVERY_NOT_RECORDED');
    assert.equal(fs.existsSync(activeFile), false, 'ACTIVE_MARKER_REMAINS');
    for (const name of ['checkpoint', 'incoming']) {
      if (spec.prompt) assert.equal(fs.existsSync(path.join(transactionRoot, name, 'payload.bin')), false, 'RECOVERY_PLAINTEXT_REMAINS');
    }
    result.orphanPlaintext = ['checkpoint', 'incoming'].filter(name => fs.existsSync(path.join(transactionRoot, name, 'payload.bin')));
    result.aiSettings = await api('/api/ai/settings'); result.aiSettings = result.aiSettings && { keySet: result.aiSettings.keySet, state: result.aiSettings.state };
    result.ledgerAfterRecovery = await verifyLedger(point + ':recovered');
    await verifyLatchedDispatchRefused(point + ':recovered');
    current = expected;
    check(point + ':recovered-' + spec.outcome.toLowerCase());
    phase('normal-restart-' + point); await close(); deadline = createDeadline(); await launch(false);
    await verifyState(current, { recordFloor: crashRecords, journalFloor: crashJournal, stable });
    result.ledgerAfterRestart = await verifyLedger(point + ':restarted');
    result.status = 'PASS'; result.finishedAt = new Date().toISOString(); save();
    check(point + ':subsequent-normal-restart');
  }

  async function launchExpectingRefusal(label) {
    phase('launch-expect-refusal-' + label); plan.assertIdentity();
    const sequence = ++launchSequence, nonce = crypto.randomBytes(16).toString('hex'), observed = { sequence };
    delete report.startup; delete report.shutdown; delete report.shutdownTrace;
    let child, stop, listen;
    try {
      app = await _electron.launch({ executablePath: path.join(bundle, 'Contents/MacOS/Code Intelligence Validation'),
        args: ['--use-mock-keychain', '--isolated-run-claim=' + plan.claimFile], env: launchEnvironment(process.env), cwd: root,
        timeout: deadline.limit(90000) });
      applicationOwner = captureOwnedApplication(app); child = applicationOwner.process();
      report.launches.push({ sequence, pid: child.pid, recover: false, expectRefusal: label, at: new Date().toISOString() }); save();
      stop = observeStartup(child, report, save);
      let line = '';
      listen = bytes => { for (const character of bytes.toString('utf8')) {
        if (character === '\n') {
          const prefix = 'OWNED_RECOVERY_EVENT ' + nonce + ' ';
          if (line.startsWith(prefix) && /^[A-Z_]{1,40}$/.test(line.slice(prefix.length).trim())) {
            report.dialogEvents.push({ sequence, code: line.slice(prefix.length).trim() }); save();
          }
          line = '';
        } else if (line.length < 160) line += character;
      } };
      child.stderr.on('data', listen);
      try { await bounded(() => app.evaluate(installOwnedDialogs, { profile: userData, parent, nonce, recover: false }), 15000, 'DIALOG_HOOK_TIMEOUT'); }
      catch { observed.dialogHookUnavailable = true; }
      const exited = child.exitCode !== null || child.signalCode !== null ? Promise.resolve()
        : new Promise(resolve => child.once('exit', resolve));
      try { await bounded(() => exited, deadline.limit(120000), 'REFUSAL_EXIT_TIMEOUT'); }
      catch (error) {
        observed.forcedKill = true;
        try { child.kill('SIGKILL'); await bounded(() => exited, 10000, 'REFUSAL_KILL_TIMEOUT'); } catch { /* recorded below */ }
        observed.timeout = error.message;
      }
    } catch (error) { observed.launchFailure = /^[A-Za-z0-9 ._:-]{1,120}$/.test(error.message) ? error.message : error.name; }
    finally {
      if (child) { child.stderr.off('data', listen); observed.code = child.exitCode; observed.signal = child.signalCode; }
      stop?.(); observed.startup = report.startup ?? null;
      observed.dialogs = report.dialogEvents.filter(event => event.sequence === sequence).map(event => event.code);
      report.exits.push({ ...observed, refusal: label }); app = null; applicationOwner = null; page = null; save();
    }
    return observed;
  }
  async function runArchiveRefusal(fault) {
    deadline = createDeadline();
    const result = { fault, status: 'RUNNING', startedAt: new Date().toISOString() }; report.results.push(result); save();
    const stable = permanentState(), records = recordPrefix(), journal = journalPrefix(), dirs = recoveryDirectories();
    let file;
    if (fault === 'format2-archive') {
      // A legacy format-2 directory cannot be chosen in the .cibackup file picker; model a user
      // renaming its manifest so the current reader itself must refuse the old format.
      const legacy = path.join(output, 'legacy-format2'); fs.mkdirSync(legacy, { mode: 0o700 });
      const manifest = Buffer.from(JSON.stringify({ format: 2, installationId: 'synthetic-legacy-installation',
        createdAt: new Date().toISOString(), files: { 'database.dump': sha('synthetic legacy dump') } }));
      fs.writeFileSync(path.join(legacy, 'database.dump'), 'synthetic legacy dump', { mode: 0o600 });
      file = path.join(legacy, 'legacy-format2.cibackup'); fs.writeFileSync(file, manifest, { flag: 'wx', mode: 0o600 });
    } else {
      const bytes = fs.readFileSync(backups.B1); Buffer.from('CIBAK002').copy(bytes, 0);
      file = path.join(output, 'container-v2.cibackup'); fs.writeFileSync(file, bytes, { flag: 'wx', mode: 0o600 });
    }
    const selectedHash = digest(file);
    await navigate('/settings');
    result.outcome = await withPicker('restore', file, () => perform(() => page.evaluate(async () => {
      try { await window.codeIntelligenceDesktop.restore(); return { resolved: true }; }
      catch (error) {
        const message = String(error?.message);
        return { resolved: false, input: message.includes('Choose an intact encrypted backup from this installation.'),
          incompatible: message.includes('This backup is not compatible with this app.'),
          recoveryRequired: message.includes('Preserved recovery data requires inspection') };
      }
    }), 240000)); save();
    assert.deepEqual(result.outcome, { resolved: false, input: true, incompatible: false, recoveryRequired: false }, 'ARCHIVE_NOT_REFUSED_AS_INPUT');
    await healthy();
    assert.equal(journalPrefix().bytes, journal.bytes, 'MAINTENANCE_LATCH_APPENDED'); assertPrefix(journal);
    assert.equal(Object.keys(recordPrefix()).length, Object.keys(records).length, 'RECOVERY_RECORD_APPENDED'); verifyRecordPrefix(records);
    assert.deepEqual(recoveryDirectories(), dirs, 'RECOVERY_SCRATCH_LEFT'); assert.deepEqual(permanentState(), stable);
    assert.equal(digest(file), selectedHash);
    await verifyState(current, { recordFloor: records, journalFloor: journal, stable });
    result.status = 'PASS'; result.finishedAt = new Date().toISOString(); save();
    check(fault + ':refused-as-input-before-maintenance');
  }
  async function runFault(fault) {
    if (['format2-archive', 'container-v2'].includes(fault)) return runArchiveRefusal(fault);
    deadline = createDeadline();
    const result = { fault, status: 'RUNNING', startedAt: new Date().toISOString() }; report.results.push(result); save();
    phase('stop-before-' + fault); await close();
    const latchFile = path.join(userData, 'safety/ai-off.json'), held = path.join(runRoot, 'held-' + fault + '-events.log');
    const stable = permanentState(), records = recordPrefix(), original = fs.readFileSync(journalFile);
    const originalLatch = fs.existsSync(latchFile) ? fs.readFileSync(latchFile) : null, journalIdentity = ownedFile(journalFile);
    result.before = { journal: { bytes: original.length, sha256: sha(original) }, latchPresent: Boolean(originalLatch) };
    phase('apply-' + fault);
    if (fault === 'missing') fs.renameSync(journalFile, held);
    else if (fault === 'latch-major') {
      const value = JSON.parse(originalLatch.toString('utf8')); value.major += 1;
      fs.writeFileSync(latchFile, Buffer.from(canonical(value)), { mode: 0o600 });
    } else fs.writeFileSync(journalFile, faultedJournal(fault, original), { mode: 0o600 });
    const faultedJournalState = fs.existsSync(journalFile) ? digest(journalFile) : null;
    const faultedLatchState = fs.existsSync(latchFile) ? digest(latchFile) : null;
    result.applied = { journalSha256: faultedJournalState, latchSha256: faultedLatchState }; save();
    result.refusal = await launchExpectingRefusal(fault); save();
    assert.equal(result.refusal.startup?.state, 'FAILED', 'FAULT_NOT_REFUSED');
    assert(!result.refusal.forcedKill, 'REFUSAL_DID_NOT_EXIT');
    // Fail closed without repair: the damaged journal is neither truncated, rewritten nor recreated.
    assert.equal(fs.existsSync(journalFile) ? digest(journalFile) : null, faultedJournalState, 'JOURNAL_MODIFIED_BY_REFUSAL');
    assert.equal(fs.existsSync(latchFile), true, 'AI_OFF_LATCH_REMOVED');
    if (fault === 'latch-major') assert.equal(digest(latchFile), faultedLatchState, 'INCOMPATIBLE_LATCH_REPLACED');
    result.latchAfterRefusal = digest(latchFile);
    assert.deepEqual(permanentState(), stable); verifyRecordPrefix(records);
    assert.equal(Object.keys(recordPrefix()).length, Object.keys(records).length, 'RECORDS_APPENDED_BY_REFUSAL');
    check(fault + ':refused-without-repair');
    // Test-only restoration of the exact original bytes/inode, then an ordinary start.
    phase('restore-original-' + fault);
    if (fault === 'missing') fs.renameSync(held, journalFile);
    else if (fault === 'latch-major') fs.writeFileSync(latchFile, originalLatch, { mode: 0o600 });
    else fs.writeFileSync(journalFile, original, { mode: 0o600 });
    assert.equal(digest(journalFile), sha(original)); assert.equal(ownedFile(journalFile).inode, journalIdentity.inode);
    deadline = createDeadline(); await launch(false);
    await verifyState(current, { recordFloor: records, journalFloor: { bytes: original.length, sha256: sha(original) }, stable });
    result.status = 'PASS'; result.finishedAt = new Date().toISOString(); save();
    check(fault + ':original-restored-and-normal-start-preserves-data');
  }

  save(); console.log(JSON.stringify({ status: 'RUNNING', evidence, profile: userData, points: options.points, faults: options.faults, cost: options.cost }));
  try {
    await launch();
    const first = await importFixture();
    await source(oldSource, first);
    proofs[first] = { text: oldSource, proof: await retainedContent(oldSource, first) }; ciphers[first] = blob(oldSource);
    noteId = (await api(`/api/projects/${projectId}/notes`, 'POST', { title: 'Synthetic recovery note', contentMd: 'Synthetic note at backup91' })).id;
    assert(Number.isSafeInteger(noteId) && noteId > 0);
    taskId = (await api(`/api/projects/${projectId}/tasks`, 'POST', task('backup91'))).id;
    assert(Number.isSafeInteger(taskId) && taskId > 0);
    states.B1 = { label: 'backup91', snapshot: first, source: oldSource, note: 'Synthetic note at backup91', snapshots: [first] };
    if (options.cost) { deadline = createDeadline(); await setupCost(); }
    deadline = createDeadline(); await backup('B1'); await healthy(); check('backup-b1-created');
    if (options.faults.length) {
      current = 'B1'; report.snapshots = { B1: first }; save(); await verifyState('B1');
      for (const fault of options.faults) await runFault(fault);
    } else {
    deadline = createDeadline();
    const second = await reanalyze(); assert.notEqual(second, first); await source(newSource, second);
    proofs[second] = { text: newSource, proof: await retainedContent(newSource, second) }; ciphers[second] = blob(newSource);
    assert.deepEqual(await retainedContent(oldSource, first), proofs[first].proof);
    await api(`/api/projects/${projectId}/notes/${noteId}`, 'PUT', { title: 'Synthetic recovery note', contentMd: 'Synthetic note at backup92' });
    await api(`/api/projects/${projectId}/tasks/${taskId}`, 'PUT', task('backup92'));
    states.B2 = { label: 'backup92', snapshot: second, source: newSource, note: 'Synthetic note at backup92', snapshots: [first, second] };
    if (options.cost) { deadline = createDeadline(); await dispatchHeldAndCrash(); }
    deadline = createDeadline(); await backup('B2'); await healthy(); check('backup-b2-created');
    current = 'B2'; report.snapshots = { B1: first, B2: second }; save();
    await verifyState('B2'); await verifyLedger('setup');
    for (const point of options.points) await runPoint(point);
    }
    await close();
    assert(report.exits.filter(exit => !exit.intentionalCrash && !exit.refusal).every(exit => exit.cleanShutdownObserved), 'UNCLEAN_ORDINARY_EXIT');
    assert(report.exits.filter(exit => exit.intentionalCrash).every(exit => exit.signal === 'SIGKILL' && exit.observedTreeGone));
    const refusals = new Set(report.launches.filter(entry => entry.expectRefusal).map(entry => entry.sequence));
    assert(report.dialogEvents.filter(event => !refusals.has(event.sequence)).every(event => event.code === 'RECOVERY_ACCEPTED'));
    assert.equal(digest(path.join(bundle, 'Contents/Resources/app.asar')), report.appAsarSha256);
    assert.equal(digest(manifestFile), report.manifestSha256);
    assert.equal(digest(__filename), report.driverSha256);
    assert.equal(digest(path.join(__dirname, 'recovery-boundaries.cjs')), report.boundarySha256);
    report.status = 'PASS'; phase('complete');
  } catch (error) {
    report.status = 'FAIL'; report.failure = { phase: report.phase, code: error.code || error.name,
      message: typeof error.message === 'string' && /^[A-Za-z0-9 .:_-]{1,160}$/.test(error.message) ? error.message : null };
    const running = report.results.at(-1); if (running?.status === 'RUNNING') running.status = 'FAIL';
    try { if (page && !page.isClosed()) await bounded(() => page.screenshot({ path: path.join(evidence, 'failure.png') }), 5000, 'FAILURE_CAPTURE_TIMEOUT'); }
    catch { report.failure.captureUnavailable = true; }
    save();
  } finally {
    if (heldHook && app) {
      try { await bounded(() => heldHook.evaluate(h => h.restore()), 5000, 'HOOK_RESTORE_TIMEOUT'); }
      catch { report.status = 'FAIL'; report.holdCleanupFailed = true; }
      try { await bounded(() => heldHook.dispose(), 5000, 'HOOK_DISPOSE_TIMEOUT'); } catch { report.status = 'FAIL'; }
      heldHook = undefined;
    }
    try { await close(); } catch { report.status = 'FAIL'; report.cleanupFailed = true; } save();
  }
  console.log(JSON.stringify({ status: report.status, phase: report.phase, checks: report.checks.length,
    passed: report.results.filter(r => r.status === 'PASS').map(r => r.point), evidence }));
  if (report.status !== 'PASS') process.exitCode = 1;
}

if (require.main === module) main(process.argv.slice(2)).catch(error => { console.error(error.code || error.name); process.exitCode = 1; });
module.exports = { main, argumentsFor, journalFacts, monotonicHighWater, faultedJournal, journalFrames, FAULTS };
