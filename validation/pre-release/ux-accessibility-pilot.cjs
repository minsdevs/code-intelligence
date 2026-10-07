'use strict';

// G-UX machine-checkable unit: accessibility measurements of the real rendered
// renderer and a scripted (non-human) pilot of user outcomes U1-U6 on a retained
// packaged candidate. It launches the unchanged .app with a fresh synthetic
// automation profile and mock Keychain, imports synthetic fixtures through the
// real UI, never contacts GitHub or an AI provider, and keeps every observation
// under validation/local/pre-release-ux/. A scripted pilot is not a usability study.
const fs = require('node:fs'), path = require('node:path'), os = require('node:os');
const assert = require('node:assert/strict'), crypto = require('node:crypto');
const { execFileSync, execFile } = require('node:child_process');
const { promisify } = require('node:util');
const { createRequire } = require('node:module');
const { ensureOutputParent } = require('./owned-output.cjs');
const { validateRuntimeManifest } = require('../../desktop/src/runtime-manifest.cjs');
const { prepareIsolatedRun } = require('../../desktop/src/isolated-run.cjs');
const { validateLocalEnvironment, requireExecutionContext, claimExecution } = require('../../desktop/scripts/native-acceptance-context.cjs');
const { closeValidatedApplication, observeStartup } = require('../../desktop/scripts/native-acceptance-electron.cjs');
const { readProcessTable } = require('./process-memory.cjs');
const { descendants } = require('../backup-compatibility/owned-crash.cjs');
const { writeFixture } = require('./ux-fixtures.cjs');
const audit = require('./ux-page-audit.cjs');
const { withDropConfirmation } = require('./drop-confirmation.cjs');

const runFile = promisify(execFile);
const hash = file => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const SIZES = [[980, 700], [1280, 800], [1440, 900]];
const STAGES = ['pre-import', 'u1', 'u3', 'u4', 'screens-ko', 'screens-en', 'zoom', 'motion', 'u6', 'u5'];
const LOOPBACK = /^(?:127\.|::1$|localhost$|\[::1\]$)/;

function parseArguments(argv) {
  assert.ok(argv[0] === '--app' && typeof argv[1] === 'string', 'usage: --app <candidate.app> [--stages a,b]');
  let stages = STAGES;
  if (argv.length === 4) {
    assert.equal(argv[2], '--stages');
    stages = argv[3].split(',');
    assert.ok(stages.length > 0 && stages.every(stage => STAGES.includes(stage)), 'UX_STAGE_UNKNOWN');
  } else assert.equal(argv.length, 2);
  return { app: argv[1], stages: new Set(stages) };
}

function redact(text) {
  return String(text ?? '').replaceAll(os.homedir(), '~').replace(/[A-Za-z0-9+/_-]{40,}/g, '<redacted>').slice(0, 300);
}

// lsof -F output: p<pid> c<command> P<protocol> n<name> T<tcp info>; fields repeat per file.
function parseLsof(text) {
  const sockets = [];
  let pid = null, command = null, current = null;
  for (const line of String(text).split('\n')) {
    const field = line[0], value = line.slice(1);
    if (field === 'p') { pid = Number(value); command = null; }
    else if (field === 'c') command = value;
    else if (field === 'f') { current = { pid, command, protocol: null, name: null, state: null }; sockets.push(current); }
    else if (current && field === 'P') current.protocol = value;
    else if (current && field === 'n') current.name = value;
    else if (current && field === 'T' && value.startsWith('ST=')) current.state = value.slice(3);
  }
  return sockets.filter(socket => socket.name);
}
function classifySocket(socket) {
  const host = value => {
    const text = value.trim();
    if (text.startsWith('[')) return text.slice(1, text.indexOf(']'));
    const index = text.lastIndexOf(':');
    return index > 0 ? text.slice(0, index) : text;
  };
  const [local, remote] = socket.name.split('->');
  if (remote) return { kind: LOOPBACK.test(host(remote)) ? 'loopback-connection' : 'external-connection', remoteHost: host(remote) };
  const bound = host(local);
  return { kind: bound === '*' ? 'listen-all-interfaces' : LOOPBACK.test(bound) ? 'loopback-listen' : 'listen-other', remoteHost: null };
}

function createEgressMonitor() {
  const data = { renderer: {}, session: {}, sockets: {}, external: [], samples: 0, sampleFailures: 0, phases: {} };
  let phase = 'startup', owner = null, timer = null, running = false;
  const count = (bucket, key) => {
    const target = (data.phases[phase] ||= { renderer: {}, session: {}, sockets: {} })[bucket];
    target[key] = (target[key] || 0) + 1;
    data[bucket][key] = (data[bucket][key] || 0) + 1;
  };
  const origin = url => { try { const parsed = new URL(url); return parsed.protocol === 'data:' || parsed.protocol === 'blob:' ? parsed.protocol : parsed.origin; } catch { return 'unparseable'; } };
  async function sample() {
    if (!owner || running) return;
    running = true;
    try {
      const rows = await readProcessTable();
      const pids = descendants(rows, owner).map(row => row.pid);
      let stdout = '';
      try { ({ stdout } = await runFile('/usr/sbin/lsof', ['-nP', '-a', '-i', '-p', pids.join(','), '-F', 'pcfPnT'],
        { timeout: 5000, maxBuffer: 4 * 1024 * 1024, env: { PATH: '/usr/bin:/bin:/usr/sbin', LANG: 'C', LC_ALL: 'C' } })); }
      catch (error) { if (error.code !== 1) throw error; stdout = error.stdout || ''; }
      for (const socket of parseLsof(stdout)) {
        const kind = classifySocket(socket);
        count('sockets', `${kind.kind}:${socket.protocol ?? '?'}:${socket.command ?? '?'}`);
        if (kind.kind === 'external-connection' && data.external.length < 50) {
          data.external.push({ phase, command: socket.command, protocol: socket.protocol, remoteHost: kind.remoteHost, state: socket.state });
        }
      }
      data.samples++;
    } catch { data.sampleFailures++; }
    finally { running = false; }
  }
  return {
    data,
    setPhase(name) { phase = name; },
    attach(pid) { owner = pid; clearInterval(timer); timer = setInterval(() => void sample(), 1000); },
    detach() { clearInterval(timer); timer = null; owner = null; },
    renderer(url, appOrigin) { const value = origin(url); count('renderer', value === appOrigin ? 'app-origin' : value); },
    session(values, appOrigin) { for (const value of values) count('session', value === appOrigin ? 'app-origin' : value); },
    sample,
  };
}

async function main(argv = process.argv.slice(2)) {
  assert.equal(process.platform, 'darwin'); assert.equal(process.arch, 'arm64');
  const options = parseArguments(argv);
  validateLocalEnvironment(process.env, process.execArgv); process.umask(0o077);
  const repo = fs.realpathSync(path.resolve(__dirname, '../..')), appBundle = fs.realpathSync(options.app);
  assert.equal(path.dirname(path.dirname(appBundle)), repo);
  assert.equal(path.basename(appBundle), 'Code Intelligence Validation.app');
  assert.match(path.basename(path.dirname(appBundle)), /^\.native-product-[A-Za-z0-9]+$/);
  const manifestFile = path.join(appBundle, 'Contents/Resources/runtime/runtime-manifest.json');
  const manifest = JSON.parse(fs.readFileSync(manifestFile));
  await validateRuntimeManifest(path.dirname(manifestFile), manifest);
  execFileSync('/usr/bin/codesign', ['--verify', '--strict', '--deep', appBundle], { timeout: 60000, stdio: 'pipe' });
  const asar = path.join(appBundle, 'Contents/Resources/app.asar');
  const evidence = fs.mkdtempSync(path.join(ensureOutputParent(repo, 'validation/local/pre-release-ux'), 'ux-'));
  const shots = path.join(evidence, 'screens'); fs.mkdirSync(shots, { mode: 0o700 });
  const root = fs.mkdtempSync('/private/tmp/cnux-'), temp = path.join(root, 'work'), owned = path.join(temp, 'owned');
  for (const directory of [temp, owned]) fs.mkdirSync(directory, { mode: 0o700 });
  const short = fs.mkdtempSync('/private/tmp/cnur-'), control = path.join(root, 'context.json');
  const revision = execFileSync('/usr/bin/git', ['rev-parse', 'HEAD'], { cwd: repo, encoding: 'utf8' }).trim();
  fs.writeFileSync(control, JSON.stringify({ format: 1, kind: 'isolated-macos-host', provider: 'local-macos',
    uid: process.getuid(), revision, buildSequence: manifest.buildSequence, sourceRoot: repo, tempRoot: temp,
    isolatedRunParent: short, createdAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 3 * 3600000).toISOString() }),
  { flag: 'wx', mode: 0o600 });
  const env = { PATH: '/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin', HOME: os.homedir(), LANG: 'C', LC_ALL: 'C',
    NATIVE_ACCEPTANCE_CONTEXT: control, CODE_INTELLIGENCE_BUILD_SEQUENCE: manifest.buildSequence };
  const context = requireExecutionContext(env);
  claimExecution(context, 'product');
  const desktopPackage = JSON.parse(fs.readFileSync(path.join(repo, 'desktop/package.json'), 'utf8'));
  const applicationSupport = path.join(os.homedir(), 'Library', 'Application Support');
  const plan = prepareIsolatedRun({ parentDirectory: short, runtimeDirectory: path.dirname(manifestFile), purpose: 'automation',
    forbiddenRoots: [path.join(applicationSupport, desktopPackage.name), path.join(applicationSupport, desktopPackage.build.productName)] });
  assert.deepEqual(fs.readdirSync(plan.paths.userData), [], 'Fresh validation profile required');
  const frontendRequire = createRequire(path.join(repo, 'frontend', 'package.json'));
  const { _electron: electron } = frontendRequire('playwright');
  const { expect } = frontendRequire('@playwright/test');
  const executablePath = path.join(appBundle, 'Contents', 'MacOS', 'Code Intelligence Validation');
  const launchArguments = ['--use-mock-keychain', '--isolated-run-claim=' + plan.claimFile];

  const report = { format: 1, status: 'RUNNING', startedAt: new Date().toISOString(),
    scope: 'Scripted machine pilot and accessibility measurements on the unchanged packaged candidate with a fresh synthetic automation profile, mock Keychain, synthetic fixtures, no GitHub account and AI off. Not a human usability study, not VoiceOver output, not a clean-machine or signed-app result.',
    stages: [...options.stages], revision, candidate: { appBundle: path.relative(repo, appBundle), buildSequence: manifest.buildSequence,
      manifestSha256: hash(manifestFile), appAsarSha256: hash(asar) },
    runner: { ux: hash(__filename), audit: hash(require.resolve('./ux-page-audit.cjs')), fixtures: hash(require.resolve('./ux-fixtures.cjs')) },
    validationProfile: { identity: plan.appIdentity, mockKeychain: true, realAccount: false },
    fixtures: {}, launches: [], screens: [], pilot: {}, errors: [], notes: [] };
  const resultFile = path.join(evidence, 'result.json');
  const save = () => fs.writeFileSync(resultFile, JSON.stringify(report, null, 2) + '\n', { mode: 0o600 });
  const phase = name => { report.phase = name; save(); };
  save(); console.log(JSON.stringify({ status: report.status, evidence: path.relative(repo, evidence) }));
  const egress = createEgressMonitor(); report.egress = egress.data;

  let app = null, page = null, cdp = null, win = null, owner = null, stopObserving = null, appOrigin = null;
  let pageErrors = 0, consoleErrors = 0, launchCount = 0;
  const ctx = {};

  async function attempt(name, action, timeoutMs = 120000) {
    phase(name);
    let timer;
    try {
      return await Promise.race([action(), new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('UX_STEP_TIMEOUT')), timeoutMs); })]);
    } catch (error) {
      report.errors.push({ step: name, errorName: error?.name ?? null, message: redact(error?.message) });
      save();
      return undefined;
    } finally { clearTimeout(timer); }
  }
  const settle = async (ms = 400) => {
    await sleep(ms);
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  };
  const navigate = async route => {
    await page.evaluate(target => { history.pushState(null, '', target); window.dispatchEvent(new PopStateEvent('popstate')); }, route);
    await settle(700);
  };
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
      let parsed = null; try { parsed = text ? JSON.parse(text) : null; } catch { parsed = null; }
      return { status: response.status, body: parsed };
    }, { route, method, body });
    if (result.status < 200 || result.status >= 300) throw new Error('UX_API_' + result.status);
    return result.body;
  };
  const drainSession = async () => {
    if (!app) return;
    try { egress.session(await app.evaluate(() => { const values = globalThis.__uxEgress || []; globalThis.__uxEgress = []; return values; }), appOrigin); }
    catch { report.notes.push('session egress drain failed at ' + report.phase); }
  };
  const setEgressPhase = async name => { await drainSession(); await egress.sample(); egress.setPhase(name); };

  async function launch(label) {
    launchCount++;
    const record = { sequence: launchCount, label };
    report.launches.push(record);
    phase('launch-' + label);
    const started = performance.now();
    app = await electron.launch({ executablePath, args: launchArguments, cwd: owned, env, timeout: 120000 });
    const child = app.process();
    owner = child;
    delete report.startup; delete report.shutdown; delete report.shutdownTrace;
    stopObserving = observeStartup(child, report, save);
    egress.attach(child.pid);
    page = await app.firstWindow({ timeout: 120000 });
    page.setDefaultTimeout(30000);
    page.on('pageerror', () => { pageErrors++; });
    page.on('console', message => { if (message.type() === 'error') consoleErrors++; });
    assert.equal(await app.evaluate(({ app: electronApp }) => electronApp.getPath('userData')), plan.paths.userData);
    assert.equal(await app.evaluate(({ app: electronApp }) => electronApp.isPackaged), true);
    await expect(page.getByRole('link', { name: 'Code Intelligence home' })).toBeVisible({ timeout: 90000 });
    record.launchToHomeMsIndicative = Math.round(performance.now() - started);
    const status = await page.evaluate(() => window.codeIntelligenceDesktop.runtimeStatus());
    record.runtime = { ready: status.ready, recoveryOnly: status.recoveryOnly, aiOff: status.aiOff, error: status.error ? 'present' : null,
      services: [...(status.services || [])].sort() };
    assert.equal(status.aiOff, true, 'AI must stay off');
    appOrigin = new URL(await page.evaluate(() => window.codeIntelligenceDesktop.apiBaseUrl)).origin;
    page.on('request', request => egress.renderer(request.url(), appOrigin));
    await app.evaluate(({ session }) => {
      globalThis.__uxEgress = [];
      // Passive observer: onSendHeaders has no callback and cannot alter or block a request.
      session.defaultSession.webRequest.onSendHeaders({ urls: ['<all_urls>'] }, details => {
        let value = 'unparseable';
        try { const url = new URL(details.url); value = url.protocol === 'data:' || url.protocol === 'blob:' ? url.protocol : url.origin; } catch { /* keep */ }
        if (globalThis.__uxEgress.length < 20000) globalThis.__uxEgress.push(value);
      });
    });
    cdp = await page.context().newCDPSession(page);
    await cdp.send('Accessibility.enable');
    await cdp.send('DOM.enable');
    win = await app.browserWindow(page);
    save();
    return record;
  }
  async function close(label = 'normal') {
    if (!app) return;
    await drainSession();
    const current = app, child = current.process();
    app = null;
    const exit = { label, closedNormally: false };
    try {
      await closeValidatedApplication({ process: () => child, close: () => child.exitCode !== null || child.signalCode !== null ? Promise.resolve() : current.close() }, report);
      exit.closedNormally = true;
    } catch (error) { exit.failure = redact(error?.message); }
    finally {
      exit.code = child.exitCode; exit.signal = child.signalCode; exit.shutdown = report.shutdown ?? null;
      report.launches.at(-1).exit = exit;
      stopObserving?.(); stopObserving = null; egress.detach(); save();
    }
    if (!exit.closedNormally) throw new Error('UX_CLOSE_FAILED');
  }
  async function setSize(width, height) {
    await win.evaluate((window, size) => { window.setContentSize(size.width, size.height); window.show(); }, { width, height });
    await expect.poll(() => page.evaluate(() => [innerWidth, innerHeight]), { timeout: 10000 }).toEqual([width, height]);
    await settle(300);
  }
  async function setZoom(factor) {
    await win.evaluate((window, value) => window.webContents.setZoomFactor(value), factor);
    await settle(600);
  }
  async function setLanguage(lang) {
    await navigate('/settings');
    const button = page.getByRole('button', { name: lang === 'ko' ? '한국어' : 'English', exact: true });
    await button.click();
    await expect(button).toHaveAttribute('aria-pressed', 'true');
    ctx.lang = lang;
  }
  async function resetFocus() {
    await page.evaluate(() => {
      document.querySelectorAll('[data-ux-sentinel]').forEach(node => node.remove());
      const sentinel = document.createElement('span');
      sentinel.tabIndex = -1; sentinel.setAttribute('data-ux-sentinel', ''); sentinel.setAttribute('aria-hidden', 'true');
      document.body.prepend(sentinel); sentinel.focus();
    });
  }
  const clearSentinel = () => page.evaluate(() => document.querySelectorAll('[data-ux-sentinel]').forEach(node => node.remove()));
  async function tabTo(predicate, { max = 150, shift = false, label = 'target' } = {}) {
    const visited = [];
    for (let presses = 1; presses <= max; presses++) {
      await page.keyboard.press(shift ? 'Shift+Tab' : 'Tab');
      const state = await page.evaluate(audit.activeElementState);
      if (!state.body && !state.sentinel && predicate(state)) return { presses, element: state };
      visited.push(state.body ? '<body>' : state.sentinel ? '<sentinel>' : `${state.role || state.tag}:${String(state.name || '').slice(0, 40)}`);
    }
    report.notes.push({ unreachedTarget: label, presses: max, focusSequence: visited });
    throw new Error('UX_KEYBOARD_TARGET_UNREACHED ' + label);
  }
  const named = pattern => state => pattern.test(state.name || '');
  async function traverse(focusables) {
    await resetFocus();
    const sequence = [], seen = new Set();
    let trap = null, wrapped = false, limitReached = false, same = 0;
    const max = Math.min(450, focusables.length * 2 + 25);
    for (let index = 0; index < max; index++) {
      await page.keyboard.press('Tab');
      const state = await page.evaluate(audit.activeElementState);
      if (state.body || state.sentinel) { if (sequence.length) { wrapped = true; break; } continue; }
      const last = sequence.at(-1);
      if (last && last.id === state.id) { if (++same >= 2) { trap = { kind: 'stuck', name: state.name, tag: state.tag, monaco: state.monaco }; break; } continue; }
      same = 0;
      if (seen.has(state.id)) {
        if (state.id === sequence[0].id) wrapped = true; else trap = { kind: 'cycle', name: state.name, tag: state.tag };
        break;
      }
      seen.add(state.id); sequence.push(state);
      if (index === max - 1) limitReached = true;
    }
    await page.evaluate(() => { document.activeElement?.blur?.(); });
    await clearSentinel();
    return { ...audit.summarizeTraversal(sequence, focusables, { trap, wrapped, limitReached }),
      order: sequence.slice(0, 120).map(entry => `${entry.role || entry.tag}:${entry.name}`) };
  }
  async function axTree() {
    const { nodes } = await cdp.send('Accessibility.getFullAXTree');
    const summary = audit.summarizeAxTree(nodes);
    for (const entry of [...summary.unnamedInteractive, ...summary.focusableWithoutRole].slice(0, 12)) {
      if (entry.backendDOMNodeId == null) continue;
      try {
        const { node } = await cdp.send('DOM.describeNode', { backendNodeId: entry.backendDOMNodeId });
        const attributes = {};
        for (let index = 0; index + 1 < (node.attributes || []).length; index += 2) {
          if (['class', 'id', 'aria-label', 'role', 'data-testid', 'type', 'title'].includes(node.attributes[index])) attributes[node.attributes[index]] = String(node.attributes[index + 1]).slice(0, 80);
        }
        entry.element = { tag: node.localName, attributes };
      } catch { entry.element = null; }
    }
    return summary;
  }
  async function auditState(id, { full = false, shot = false, extra } = {}) {
    const [width, height] = await page.evaluate(() => [innerWidth, innerHeight]);
    const zoom = await win.evaluate(window => window.webContents.getZoomFactor());
    const entry = { id, lang: ctx.lang ?? null, viewport: [width, height], zoom, mode: full ? 'full' : 'light', at: new Date().toISOString() };
    try {
      const dom = await page.evaluate(audit.auditDom, { lang: ctx.lang });
      const { focusables, ...rest } = dom;
      entry.dom = { ...rest, focusableCount: focusables.length };
      entry.ax = await axTree();
      if (full) entry.keyboard = await traverse(focusables);
      if (extra) entry.extra = await extra();
      if (shot) {
        const file = `${id}-${ctx.lang ?? 'na'}-${width}x${height}${zoom !== 1 ? '-zoom' + zoom * 100 : ''}.png`;
        await page.screenshot({ path: path.join(shots, file) });
        entry.screenshot = file;
      }
    } catch (error) { entry.failure = redact(error?.message); }
    report.screens.push(entry); save();
    return entry;
  }

  // Controlled single-use OS picker result. UI, IPC, folder policy, preview, approval and analysis stay real.
  async function withFolderPicker(folder, action) {
    const picker = await app.evaluateHandle(({ dialog }, selected) => {
      const original = dialog.showOpenDialog;
      let calls = 0;
      const choose = async (...args) => {
        const settings = args.at(-1);
        if (calls || settings?.title !== 'Choose a source folder to analyze' || settings.properties?.length !== 1
          || settings.properties[0] !== 'openDirectory') throw new Error('UX_PICKER_REFUSED');
        calls++;
        return { canceled: false, filePaths: [selected] };
      };
      dialog.showOpenDialog = choose;
      return { restore() { if (dialog.showOpenDialog !== choose) throw new Error('UX_PICKER_REPLACED'); dialog.showOpenDialog = original; return calls; } };
    }, folder);
    let result, failure;
    try { result = await action(); } catch (error) { failure = error; }
    const calls = await picker.evaluate(value => value.restore()); await picker.dispose();
    if (failure) throw failure;
    return { result, pickerCalls: calls };
  }
  async function dragFolder(folder) {
    const target = page.getByRole('button', { name: 'Choose folder', exact: true });
    await expect(target).toBeVisible();
    const bounds = await target.boundingBox();
    // The preview button appears only after main granted the drop (SEC-M-02 confirmation answered once).
    const { confirmation } = await withDropConfirmation(app, folder, async () => {
      const session = await page.context().newCDPSession(page);
      try {
        const data = { items: [], files: [folder], dragOperationsMask: 1 };
        for (const type of ['dragEnter', 'dragOver', 'drop']) await session.send('Input.dispatchDragEvent', { type, x: bounds.x + bounds.width / 2, y: bounds.y + bounds.height / 2, data });
      } finally { await session.detach(); }
      await expect(page.getByRole('button', { name: '가져올 파일 미리보기', exact: true })).toBeVisible();
    });
    (report.dropConfirmations ??= []).push(confirmation); save();
  }
  async function awaitJob(id, timeoutMs = 240000) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const job = await api(`/api/jobs/${id}`);
      if (['DONE', 'FAILED', 'CANCELLED'].includes(job.status)) return job;
      await sleep(500);
    }
    throw new Error('UX_JOB_TIMEOUT');
  }
  // Records live-region text changes while a long operation runs (what a screen reader could be told).
  async function watchAnnouncements(until, timeoutMs = 240000) {
    const observed = [];
    let last = '';
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const snapshot = await page.evaluate(() => [...document.querySelectorAll('[role="status"],[role="alert"],[aria-live],[role="progressbar"],[role="log"]')]
        .map(element => `${element.getAttribute('role') || 'live:' + element.getAttribute('aria-live')}=${element.textContent.replace(/\s+/g, ' ').trim().slice(0, 100)}`).join(' | ')).catch(() => '');
      if (snapshot !== last) { observed.push({ atMs: timeoutMs - (deadline - Date.now()), regions: snapshot }); last = snapshot; }
      if (await until()) break;
      await sleep(300);
    }
    return observed.slice(0, 60);
  }
  const graph = {
    nodes: params => api(`/api/projects/${ctx.projectId}/graph/nodes?${new URLSearchParams({ snapshotId: ctx.snapshotId, page: 1, size: 200, ...params })}`),
    relations: (id, direction) => api(`/api/projects/${ctx.projectId}/graph/nodes/${id}/relations?direction=${direction}&depth=1&snapshotId=${ctx.snapshotId}`),
  };
  async function findNode(predicate, params = {}) {
    for (let pageNumber = 1; pageNumber <= 10; pageNumber++) {
      const result = await graph.nodes({ ...params, page: pageNumber });
      const found = result.items.find(predicate);
      if (found) return found;
      if (pageNumber * 200 >= result.total) return null;
    }
    return null;
  }
  const textOf = locator => locator.innerText().then(value => value.replace(/\s+/g, ' ').trim());

  let failure;
  try {
    const fixtureRoot = path.join(owned, 'fixtures'); fs.mkdirSync(fixtureRoot, { mode: 0o700 });
    ctx.orderDesk = path.join(fixtureRoot, 'order-desk');
    ctx.libraryLoans = path.join(fixtureRoot, 'library-loans');
    report.fixtures.orderDesk = writeFixture('order-desk', ctx.orderDesk);
    report.fixtures.libraryLoans = writeFixture('library-loans', ctx.libraryLoans);
    await launch('fresh-profile');
    egress.setPhase('fresh-launch-idle');
    await setSize(1280, 800);
    ctx.lang = 'en';
    report.pilot.freshDefaults = await attempt('fresh-defaults', async () => ({
      htmlLang: await page.evaluate(() => document.documentElement.lang),
      storedLanguage: await page.evaluate(() => localStorage.getItem('code-intelligence.lang')),
      projects: (await api('/api/projects')).length,
    }));

    if (options.stages.has('pre-import')) {
      for (const lang of ['en', 'ko']) {
        await attempt('language-' + lang, () => setLanguage(lang));
        for (const [id, route] of [['home-empty', '/'], ['import-connect', '/import'], ['settings-empty', '/settings']]) {
          await attempt(`audit-${id}-${lang}`, async () => { await navigate(route); await auditState(id, { full: true, shot: true }); }, 180000);
        }
      }
    }

    // U1/U2: keyboard-only local import of order-desk in Korean, no network needed.
    await attempt('language-ko', () => setLanguage('ko'));
    await setEgressPhase('U1-local-import-and-explore');
    const u1 = report.pilot.U1 = { language: 'ko', steps: [], scope: 'keyboard-only with a controlled single-use OS folder-picker result' };
    const u1Step = (name, data) => { u1.steps.push({ name, ...data }); save(); };
    const u1Started = performance.now();
    const keyboardImport = await attempt('u1-keyboard-import', async () => {
      await navigate('/');
      await resetFocus();
      const home = await tabTo(named(/^(Import repository|레포 가져오기|저장소 가져오기|Choose a repository|레포 선택)$/));
      u1Step('home-to-import-link', { tabPresses: home.presses, target: home.element.name });
      await page.keyboard.press('Enter');
      await expect(page.getByRole('button', { name: 'Choose folder', exact: true })).toBeVisible();
      await resetFocus();
      const choose = await tabTo(named(/^Choose folder$/));
      u1Step('import-to-choose-folder', { tabPresses: choose.presses, focusIndicator: choose.element.indicator, ringRatio: choose.element.ringRatio });
      const picked = await withFolderPicker(ctx.orderDesk, async () => {
        await page.keyboard.press('Enter');
        await expect(page.getByRole('button', { name: '가져올 파일 미리보기', exact: true })).toBeVisible();
      });
      u1Step('folder-picked', { pickerCalls: picked.pickerCalls, focusAfter: await page.evaluate(audit.activeElementState) });
      const previewButton = await tabTo(named(/^가져올 파일 미리보기$/), { max: 60 });
      u1Step('tab-to-preview', { tabPresses: previewButton.presses });
      const [previewResponse] = await Promise.all([
        page.waitForResponse(response => new URL(response.url()).pathname === '/api/projects/local/preview' && response.request().method() === 'POST', { timeout: 60000 }),
        page.keyboard.press('Enter'),
      ]);
      assert.ok(previewResponse.ok());
      const region = page.getByRole('region', { name: '확인할 가져오기 미리보기', exact: true });
      await expect(region).toBeVisible();
      const focusAfterPreview = await page.evaluate(audit.activeElementState);
      u1Step('preview-shown', { focusAfter: focusAfterPreview, liveAnnouncement: await page.evaluate(() => [...document.querySelectorAll('[role="status"],[aria-live]')].map(element => element.textContent.trim()).filter(Boolean)) });
      // U2 facts from the actual preview the user sees.
      const previewText = await textOf(region);
      const preview = await previewResponse.json();
      report.pilot.U2 = { previewTextSample: previewText.slice(0, 600), acceptedFiles: preview.localImport?.acceptedFiles ?? null,
        bytesRead: preview.localImport?.bytesRead ?? null, exclusionReasons: preview.localImport?.excludedEntriesByReason ?? null,
        showsAcceptedCount: /미리보기에서 선택한 파일/.test(previewText), showsBytes: /읽은 바이트/.test(previewText),
        showsExclusionReasons: /민감 경로|생성·의존성 폴더/.test(previewText),
        showsLanguageOrExpectedDepth: /(언어|Java|TypeScript|깊이|depth)/i.test(previewText),
        inPreviewScopeReduction: await region.getByRole('button', { name: /범위|제외|scope|exclude/i }).count() > 0,
        previewResponseKeys: Object.keys(preview).sort() };
      await auditState('import-preview', { full: true, shot: true });
      let approve;
      try { approve = await tabTo(named(/^확인한 파일 가져오기 및 분석$/), { max: 40 }); u1Step('tab-to-approve', { direction: 'forward', tabPresses: approve.presses }); }
      catch { await resetFocus(); approve = await tabTo(named(/^확인한 파일 가져오기 및 분석$/), { max: 150 }); u1Step('tab-to-approve', { direction: 'from-document-start', tabPresses: approve.presses }); }
      const [created] = await Promise.all([
        page.waitForResponse(response => new URL(response.url()).pathname === '/api/projects/local' && response.request().method() === 'POST', { timeout: 60000 }),
        page.keyboard.press('Enter'),
      ]);
      assert.ok(created.ok());
      const body = await created.json();
      ctx.projectId = body.project.id; ctx.jobId = body.jobId;
      await sleep(250);
      await auditState('import-progress', { full: false, shot: true });
      const announcements = await watchAnnouncements(async () => /\/overview$/.test(new URL(page.url()).pathname));
      u1Step('progress-announcements', { regions: announcements });
      const job = await awaitJob(ctx.jobId);
      u1Step('analysis-finished', { jobStatus: job.status, failureCode: job.failureCode ?? null });
      assert.equal(job.status, 'DONE');
      await expect(page).toHaveURL(new RegExp(`/projects/${ctx.projectId}/overview$`), { timeout: 30000 });
      u1Step('overview-after-analysis', { focusAfter: await page.evaluate(audit.activeElementState), title: await page.title() });
      return true;
    }, 420000);
    if (!keyboardImport) {
      u1.keyboardImportCompleted = false;
      // Fallback so later checks can run; recorded separately and never counted as keyboard completion.
      await attempt('u1-fallback-drag-import', async () => {
        await navigate('/import'); await dragFolder(ctx.orderDesk);
        await page.getByRole('button', { name: '가져올 파일 미리보기', exact: true }).click();
        const [created] = await Promise.all([
          page.waitForResponse(response => new URL(response.url()).pathname === '/api/projects/local' && response.request().method() === 'POST', { timeout: 60000 }),
          page.getByRole('button', { name: '확인한 파일 가져오기 및 분석', exact: true }).click(),
        ]);
        const body = await created.json(); ctx.projectId = body.project.id;
        assert.equal((await awaitJob(body.jobId)).status, 'DONE');
      }, 300000);
    } else u1.keyboardImportCompleted = true;
    ctx.snapshotId = (await api(`/api/projects/${ctx.projectId}`)).currentSnapshot.id;
    report.pilot.project = { projectId: ctx.projectId, snapshotId: ctx.snapshotId };
    const overviewRoute = `/projects/${ctx.projectId}/overview`;

    const u1Explore = await attempt('u1-keyboard-explore', async () => {
      await navigate(overviewRoute);
      await expect(page.getByRole('table', { name: '분석 결과 표', exact: true })).toBeVisible();
      const exploreStarted = performance.now();
      await resetFocus();
      const symbols = await tabTo(named(/^심볼 · 함수 · 클래스$/), { label: 'symbols-category' });
      await page.keyboard.press('Enter');
      const search = await tabTo(state => state.tag === 'input' && /이름 또는 파일 경로|분석 결과 검색/.test(state.name), { max: 20, label: 'search-box' });
      await page.keyboard.type('cancel');
      await settle(800);
      const relation = await tabTo(named(/^관계 · 함께 확인할 곳$/), { max: 40, label: 'relation-button' });
      await page.keyboard.press('Enter');
      const region = page.getByRole('region', { name: '선택한 코드 주변 관계', exact: true });
      await expect(region).toBeVisible();
      // The panel is lazy-loaded; wait for its first control as a person would see it appear.
      await expect(region.getByRole('combobox', { name: '관계 방향', exact: true })).toBeVisible({ timeout: 30000 });
      await expect(region.getByText('관계를 불러오는 중…', { exact: true })).toHaveCount(0);
      const focusAfterSelect = await page.evaluate(audit.activeElementState);
      u1Step('relation-selected', { focusAfterSelect });
      const sourceLink = await tabTo(named(/^선택한 항목의 보관된 소스$/), { max: 60, label: 'selected-source-link' });
      await page.keyboard.press('Enter');
      await expect(page.getByTestId('source-context')).toContainText('Snapshot #' + ctx.snapshotId);
      await expect(page.getByTestId('code-viewer').locator('.view-lines')).toBeVisible();
      const sourceShownMs = Math.round(performance.now() - exploreStarted);
      u1Step('explore-search-relations-source', { tabPresses: { symbolsCategory: symbols.presses, searchBox: search.presses, relationButton: relation.presses, sourceLink: sourceLink.presses },
        focusAfterSelectingRelation: focusAfterSelect, screenToEvidenceMsIndicative: sourceShownMs,
        sourceContext: await textOf(page.getByTestId('source-context')) });
      return true;
    }, 180000);
    u1.keyboardExploreCompleted = Boolean(u1Explore);
    u1.totalMsIndicative = Math.round(performance.now() - u1Started);

    // Node ids for later screens and tasks (graph API of the same snapshot).
    await attempt('discover-nodes', async () => {
      ctx.nodes = {};
      const service = await findNode(node => node.name === 'OrderService', { category: 'symbols', q: 'OrderService' });
      const cancel = await findNode(node => node.name === 'cancel' && /OrderService\.java$/.test(node.filePath ?? ''), { category: 'symbols', q: 'cancel' });
      const route = await findNode(node => /\/orders\/:orderId/.test(node.name + ' ' + node.naturalKey), { type: 'FE_ROUTE' });
      ctx.nodes = { orderService: service?.id ?? null, orderServiceCancel: cancel?.id ?? null, orderDetailRoute: route?.id ?? null };
      report.pilot.nodes = ctx.nodes;
      report.pilot.graphOverview = await api(`/api/projects/${ctx.projectId}/graph/overview?snapshotId=${ctx.snapshotId}`);
      report.pilot.coverage = await api(`/api/projects/${ctx.projectId}/coverage?snapshotId=${ctx.snapshotId}`).then(value => ({
        measurementStatus: value.measurementStatus, supportStatus: value.supportStatus, outcomes: value.outcomes }));
      const files = await api(`/api/projects/${ctx.projectId}/files?snapshotId=${ctx.snapshotId}`);
      report.pilot.fileOutcomes = files.map(file => ({ path: file.path, language: file.language ?? null, status: file.analysisStatus ?? null, reason: file.analysisReason ?? null }));
    });

    if (options.stages.has('u3')) {
      report.pilot.U3 = await attempt('u3-screen-to-data', async () => {
        const result = { hops: [], flows: null, ui: {} };
        // Breadth-first outgoing walk from the order detail route over recorded relations (what the UI can show).
        const queue = ctx.nodes.orderDetailRoute ? [{ id: ctx.nodes.orderDetailRoute, depth: 0 }] : [];
        const visited = new Set();
        while (queue.length && visited.size < 40) {
          const { id, depth } = queue.shift();
          if (visited.has(id) || depth > 6) continue;
          visited.add(id);
          const relations = await graph.relations(id, 'out');
          for (const relation of relations.relations) {
            result.hops.push({ depth: depth + 1, from: id, edgeType: relation.edgeType, confidence: relation.confidence,
              to: { id: relation.node.id, type: relation.node.nodeType, name: relation.node.name, file: relation.node.filePath } });
            if (!visited.has(relation.node.id)) queue.push({ id: relation.node.id, depth: depth + 1 });
          }
          if (relations.truncated) result.truncatedAt = id;
        }
        const reached = new Set(result.hops.map(hop => hop.to.type));
        result.reachedTypes = [...reached].sort();
        result.reachesEndpoint = reached.has('API_ENDPOINT');
        result.reachesDataNode = [...reached].some(type => /ENTITY|TABLE|DB_/.test(type));
        result.nonConfirmedHops = result.hops.filter(hop => hop.confidence !== 'CONFIRMED').length;
        const flows = await api(`/api/projects/${ctx.projectId}/flows?snapshotId=${ctx.snapshotId}`);
        result.flows = { total: flows.length, kinds: flows.reduce((counts, flow) => ({ ...counts, [flow.kind]: (counts[flow.kind] || 0) + 1 }), {}), names: flows.slice(0, 20).map(flow => `${flow.kind}:${flow.name}`) };
        const detailFlow = flows.find(flow => flow.kind === 'FE_BE' && /orders\/:orderId/.test(flow.name)) || flows.find(flow => flow.kind === 'FE_BE');
        if (detailFlow) {
          const detail = await api(`/api/projects/${ctx.projectId}/flows/${detailFlow.id}?snapshotId=${ctx.snapshotId}`);
          result.flowDetail = { id: detail.id, name: detail.name, kind: detail.kind, inferredStepIncluded: detail.inferredStepIncluded ?? null,
            stepsCarryVerdict: detail.steps.every(step => Object.hasOwn(step, 'confidence')),
            steps: detail.steps.map(step => ({ type: step.nodeType, name: step.nodeName, file: step.filePath, line: step.line, description: step.description,
              entry: step.entry ?? null, relationType: step.relationType ?? null, confidence: step.confidence ?? null })) };
          // UI: open the flow by keyboard and read what the user sees for each step.
          await navigate(`/projects/${ctx.projectId}/flows?snapshotId=${ctx.snapshotId}`);
          await resetFocus();
          const flowButton = await tabTo(state => state.tag === 'button' && state.name.includes(detailFlow.name), { max: 120 });
          await page.keyboard.press('Enter');
          const article = page.getByRole('article', { name: 'Flow detail', exact: true });
          await expect(article.getByRole('heading', { name: detailFlow.name, exact: true })).toBeVisible();
          const articleText = await textOf(article);
          result.ui.flow = { tabPressesToFlow: flowButton.presses, showsConfirmationLevelPerStep: /(CONFIRMED|LIKELY|POSSIBLE|추정|확인됨|정적 대상 확인)/.test(articleText),
            showsInferredBadge: /추정 단계 포함|Inferred step included/.test(articleText), textSample: articleText.slice(0, 700) };
          result.ui.flow.badgeMatchesApi = result.ui.flow.showsInferredBadge === (detail.inferredStepIncluded === true);
          const stepButton = article.getByRole('button').first();
          if (await stepButton.count()) {
            await stepButton.focus(); await page.keyboard.press('Enter');
            await expect(page.getByTestId('source-context')).toContainText('Snapshot #' + ctx.snapshotId);
            result.ui.flow.stepOpensSnapshotSourceByKeyboard = true;
          }
          await auditState('flows-order-detail', { full: true, shot: true });
        }
        // UI: neighborhood walk from the route in the outgoing direction.
        if (ctx.nodes.orderDetailRoute) {
          await navigate(`${overviewRoute}?snapshotId=${ctx.snapshotId}&nodeId=${ctx.nodes.orderDetailRoute}`);
          const region = page.getByRole('region', { name: '선택한 코드 주변 관계', exact: true });
          await expect(region).toBeVisible();
          await region.getByLabel('관계 방향', { exact: true }).selectOption('out');
          await expect(region.getByText('관계를 불러오는 중…', { exact: true })).toHaveCount(0);
          await settle(600);
          result.ui.routeNeighborhood = { text: (await textOf(region)).slice(0, 900) };
          await auditState('neighborhood-route-out', { full: true, shot: true });
        }
        return result;
      }, 300000);
    }

    if (options.stages.has('u4')) {
      report.pilot.U4 = await attempt('u4-change-impact', async () => {
        const result = { ui: {} };
        const target = ctx.nodes.orderServiceCancel ?? ctx.nodes.orderService;
        result.targetNodeId = target;
        const incoming = await graph.relations(target, 'in');
        result.incoming = incoming.relations.map(relation => ({ edgeType: relation.edgeType, confidence: relation.confidence, name: relation.node.name, file: relation.node.filePath }));
        const impact = await api(`/api/projects/${ctx.projectId}/impact?nodeId=${target}&depth=5&snapshotId=${ctx.snapshotId}`);
        if (impact) {
          const keys = impact.dependents.map(dependent => dependent.nodeId);
          result.impactApi = { riskLevel: impact.riskLevel, riskScore: impact.riskScore, dependents: impact.dependents.length,
            uniqueDependentNodes: new Set(keys).size, duplicateRows: keys.length - new Set(keys).size,
            carriesConfidence: impact.dependents.length > 0 && impact.dependents.every(dependent => Object.hasOwn(dependent, 'confidence')),
            scoreVersion: impact.scoreVersion ?? null,
            groups: impact.dependents.reduce((counts, dependent) => ({ ...counts, [dependent.group ?? 'MISSING']: (counts[dependent.group ?? 'MISSING'] || 0) + 1 }), {}),
            outsideAnalysis: impact.outsideAnalysis ? { ...impact.outsideAnalysis, areas: (impact.outsideAnalysis.areas || []).length } : null };
        }
        await navigate(`${overviewRoute}?snapshotId=${ctx.snapshotId}&nodeId=${target}`);
        const region = page.getByRole('region', { name: '선택한 코드 주변 관계', exact: true });
        await expect(region).toBeVisible();
        await expect(region.getByText('관계를 불러오는 중…', { exact: true })).toHaveCount(0);
        await settle(600);
        result.ui.neighborhoodIn = { text: (await textOf(region)).slice(0, 900) };
        await auditState('neighborhood-cancel-in', { full: true, shot: true });
        await navigate(`/projects/${ctx.projectId}/analysis`);
        const searchBox = page.getByLabel(/^(Node search|노드 검색)$/);
        await searchBox.focus();
        await page.keyboard.type('cancel');
        const results = page.getByRole('list', { name: /Impact node search results|검색 결과/ });
        await expect(results).toBeVisible({ timeout: 15000 });
        const option = results.getByRole('button').filter({ hasText: 'OrderService.java' }).first();
        await option.focus(); await page.keyboard.press('Enter');
        const impactPanel = page.getByRole('complementary', { name: 'Impact', exact: true });
        await expect(impactPanel.getByText(/(Loading impact|영향|Impact)/).first()).toBeVisible();
        await settle(1500);
        const panelText = await textOf(impactPanel);
        // Dependents are grouped (F6): confirmed reverse dependencies, candidate impact, and an outside-analysis region.
        const groupRows = async name => {
          const list = impactPanel.getByRole('list', { name });
          return await list.count() ? list.getByRole('listitem').allInnerTexts() : [];
        };
        const confirmedRows = await groupRows(/^(확인된 역방향 의존|Confirmed reverse dependencies)$/);
        const candidateRows = await groupRows(/^(후보 영향|Candidate impact)/);
        const rows = [...confirmedRows, ...candidateRows];
        const outsideRegion = impactPanel.getByRole('region', { name: /^(분석 밖 영역|Outside analysis)$/ });
        result.ui.impactPanel = { text: panelText.slice(0, 900), rows: rows.length,
          confirmedRows: confirmedRows.length, candidateRows: candidateRows.length,
          duplicateVisibleRows: rows.length - new Set(rows.map(row => row.split('\n')[0])).size,
          showsConfirmedVsCandidate: /(CONFIRMED|LIKELY|POSSIBLE|추정|확인된 정적)/.test(panelText.replace('정적 관계의 검토 후보입니다', '')),
          showsOutOfAnalysisArea: await outsideRegion.count() > 0,
          outsideText: await outsideRegion.count() ? (await textOf(outsideRegion)).slice(0, 400) : null };
        await auditState('analysis-impact-cancel', { full: true, shot: true });
        return result;
      }, 240000);
    }

    // Screen inventory used for language/size/zoom/motion measurements. Selectors accept the
    // Korean and English UI text, because English mode no longer renders hard-coded Korean.
    const resultsTable = /^(분석 결과 표|Analysis results table)$/;
    const relationsRegion = /^(선택한 코드 주변 관계|Relations around the selected code)$/;
    const relationsLoading = /^(관계를 불러오는 중…|Loading relations…)$/;
    const screens = [
      { id: 'home', route: () => '/' },
      { id: 'projects', route: () => '/projects' },
      { id: 'import-connect', route: () => '/import' },
      { id: 'overview-entrypoints', route: () => overviewRoute, ready: () => expect(page.getByRole('table', { name: resultsTable })).toBeVisible() },
      { id: 'overview-files', route: () => overviewRoute, prepare: () => page.getByRole('button', { name: /^(파일 · 분석 상태|Files · analysis status)$/ }).click() },
      { id: 'overview-symbols', route: () => overviewRoute, prepare: () => page.getByRole('button', { name: /^(심볼 · 함수 · 클래스|Symbols · functions · classes)$/ }).click() },
      { id: 'overview-dependencies', route: () => overviewRoute, prepare: () => page.getByRole('button', { name: /^(선언된 외부 패키지|Declared external packages)$/ }).click() },
      { id: 'overview-neighborhood', route: () => `${overviewRoute}?snapshotId=${ctx.snapshotId}&nodeId=${ctx.nodes?.orderService}`,
        ready: () => expect(page.getByRole('region', { name: relationsRegion }).getByText(relationsLoading)).toHaveCount(0) },
      { id: 'overview-coverage', route: () => overviewRoute, prepare: async () => {
        await page.getByText(/^(분석 범위와 미확인 사항|Analysis coverage and unverified parts)$/).click();
        await expect(page.getByRole('region', { name: /^(분석 범위 보고서|Analysis coverage report)$/ })).toBeVisible(); } },
      { id: 'features', route: () => `/projects/${ctx.projectId}/features`, prepare: async () => {
        const tree = page.getByRole('tree').or(page.getByRole('list', { name: /Feature tree|기능 트리|Feature/ }));
        const first = tree.getByRole('button').first();
        if (await first.count()) await first.click(); } },
      { id: 'code', route: () => `/projects/${ctx.projectId}/code?${new URLSearchParams({ path: 'api/src/main/java/com/example/orderdesk/order/OrderService.java', snapshotId: String(ctx.snapshotId), sourceContext: 'snapshot' })}`,
        ready: () => expect(page.getByTestId('code-viewer').locator('.view-lines')).toBeVisible() },
      { id: 'analysis', route: () => `/projects/${ctx.projectId}/analysis` },
      { id: 'flows', route: () => `/projects/${ctx.projectId}/flows` },
      { id: 'architecture', route: () => `/projects/${ctx.projectId}/architecture` },
      { id: 'history', route: () => `/projects/${ctx.projectId}/history` },
      { id: 'notes', route: () => `/projects/${ctx.projectId}/notes` },
      { id: 'tasks', route: () => `/projects/${ctx.projectId}/tasks` },
      { id: 'review', route: () => `/projects/${ctx.projectId}/review` },
      { id: 'playground', route: () => `/projects/${ctx.projectId}/playground` },
      { id: 'search', route: () => '/search', prepare: async () => {
        const box = page.getByRole('searchbox').or(page.getByRole('textbox')).first();
        await box.fill('Order'); await page.keyboard.press('Enter'); } },
      { id: 'settings', route: () => '/settings' },
      { id: 'ai-panel', route: () => `${overviewRoute}?snapshotId=${ctx.snapshotId}&nodeId=${ctx.nodes?.orderService}`, prepare: async () => {
        await page.getByRole('button', { name: /^(AI 설명 준비 · 전송 전 확인|Prepare AI explanation · review before sending)$/ }).click();
        await settle(800); }, cleanup: async () => {
        const collapse = page.getByRole('button', { name: /^(Collapse AI panel|AI 패널 접기)$/ });
        if (await collapse.count()) await collapse.first().click(); } },
    ];
    async function openScreen(screen) {
      await navigate(screen.route());
      if (screen.ready) await screen.ready().catch(() => { report.notes.push(`ready-timeout:${screen.id}:${ctx.lang}`); });
      if (screen.prepare) await screen.prepare().catch(error => { report.notes.push(`prepare-failed:${screen.id}:${ctx.lang}:${redact(error?.message).slice(0, 120)}`); });
      await settle(500);
    }
    for (const lang of ['ko', 'en']) {
      if (!options.stages.has('screens-' + lang)) continue;
      await attempt('language-' + lang, () => setLanguage(lang));
      for (const screen of screens) {
        await attempt(`screen-${screen.id}-${lang}`, async () => {
          await setSize(1280, 800);
          await openScreen(screen);
          await auditState(screen.id, { full: true, shot: true });
          for (const [width, height] of [SIZES[0], SIZES[2]]) {
            await setSize(width, height); await settle(300);
            await auditState(screen.id, { shot: lang === 'ko' });
          }
          await setSize(1280, 800);
          if (screen.cleanup) await screen.cleanup();
        }, 240000);
      }
    }
    if (options.stages.has('zoom')) {
      for (const lang of ['ko', 'en']) {
        await attempt('language-' + lang, () => setLanguage(lang));
        await setSize(1280, 800);
        for (const screen of screens) {
          await attempt(`zoom-${screen.id}-${lang}`, async () => {
            await openScreen(screen);
            await setZoom(2);
            await auditState(screen.id, { shot: true });
            await setZoom(1);
            if (screen.cleanup) await screen.cleanup();
          }, 120000);
        }
      }
    }
    if (options.stages.has('motion')) {
      await attempt('language-ko', () => setLanguage('ko'));
      report.pilot.motion = await attempt('reduced-motion', async () => {
        const result = {};
        for (const reducedMotion of ['no-preference', 'reduce']) {
          await page.emulateMedia({ reducedMotion });
          for (const screen of screens.filter(entry => ['overview-neighborhood', 'import-connect', 'settings', 'code'].includes(entry.id))) {
            await openScreen(screen);
            const dom = await page.evaluate(audit.auditDom, { lang: ctx.lang });
            (result[reducedMotion] ||= {})[screen.id] = dom.motion;
          }
        }
        await page.emulateMedia({ reducedMotion: null });
        await page.emulateMedia({ colorScheme: 'light' });
        await navigate(overviewRoute);
        result.lightSchemeRequest = (await page.evaluate(audit.auditDom, { lang: ctx.lang })).colorScheme;
        await page.emulateMedia({ colorScheme: null });
        return result;
      }, 240000);
    }
    await setEgressPhase('after-local-exploration');

    if (options.stages.has('u6')) {
      await setEgressPhase('U6-no-github-no-ai');
      report.pilot.U6 = await attempt('u6-no-github-no-ai', async () => {
        const result = {};
        await setLanguage('ko');
        await navigate('/settings');
        await settle(800);
        const main = page.getByRole('main');
        const settingsText = await textOf(main);
        result.settings = { githubNotConnectedShown: /(Not connected|연결되지 않음|미연결|연결 안 됨)/.test(settingsText),
          localWithoutLoginExplained: /로컬 폴더 분석에는 로그인이 필요하지 않습니다/.test(settingsText),
          aiOffShown: /(AI off|AI 꺼짐|AI가 꺼|비활성|Disabled|Budget is off|예산.*꺼)/.test(settingsText), textSample: settingsText.slice(0, 1200) };
        result.runtime = await page.evaluate(() => window.codeIntelligenceDesktop.runtimeStatus()).then(status => ({ aiOff: status.aiOff, ready: status.ready }));
        await navigate(`${overviewRoute}?snapshotId=${ctx.snapshotId}&nodeId=${ctx.nodes?.orderService}`);
        await page.getByRole('button', { name: 'AI 설명 준비 · 전송 전 확인', exact: true }).click();
        await settle(800);
        const panel = page.getByRole('complementary', { name: /AI Assistant panel|AI 어시스턴트|AI/ }).last();
        const panelText = await textOf(panel);
        const input = panel.getByRole('textbox').first();
        result.aiPanel = { text: panelText.slice(0, 900), inputDisabled: await input.count() ? await input.isDisabled() : null };
        if (result.aiPanel.inputDisabled === false) {
          await input.fill('주문 취소는 어디서 처리하나요?');
          const before = egress.data.renderer['app-origin'] || 0;
          await page.keyboard.press('Enter');
          await settle(1500);
          result.aiPanel.afterSubmit = (await textOf(panel)).slice(0, 900);
          result.aiPanel.appRequestsDuringSubmit = (egress.data.renderer['app-origin'] || 0) - before;
        }
        const collapse = page.getByRole('button', { name: /^(Collapse AI panel|AI 패널 접기)$/ });
        if (await collapse.count()) await collapse.first().click();
        result.coreTasksWithoutGithubOrAi = { U1: report.pilot.U1?.keyboardImportCompleted === true && report.pilot.U1?.keyboardExploreCompleted === true,
          U3Recorded: Boolean(report.pilot.U3), U4Recorded: Boolean(report.pilot.U4) };
        return result;
      }, 180000);
    }

    if (options.stages.has('u5')) {
      await setEgressPhase('U5-cancel-and-termination');
      const u5 = report.pilot.U5 = { cases: [] };
      await attempt('u5-setup-notes-tasks', async () => {
        const note = await api(`/api/projects/${ctx.projectId}/notes`, 'POST', { title: 'U5 synthetic note', contentMd: '주문 취소 경로 확인 메모 @file:api/src/main/java/com/example/orderdesk/order/OrderService.java' });
        const task = await api(`/api/projects/${ctx.projectId}/tasks`, 'POST', { title: 'U5 synthetic task', type: 'REVIEW' });
        u5.note = { id: note?.id ?? null }; u5.task = { id: task?.id ?? null };
      });
      const verifyRetained = async label => {
        const project = await api(`/api/projects/${ctx.projectId}`);
        const notes = await api(`/api/projects/${ctx.projectId}/notes`);
        const tasks = await api(`/api/projects/${ctx.projectId}/tasks`).catch(() => []);
        await navigate(`/projects/${ctx.projectId}/notes`);
        const noteVisible = await page.getByText('U5 synthetic note').first().isVisible().catch(() => false);
        await navigate(`/projects/${ctx.projectId}/tasks`);
        const taskVisible = await page.getByText('U5 synthetic task').first().isVisible().catch(() => false);
        await navigate(overviewRoute);
        const overviewVisible = await page.getByRole('table', { name: /^(Analysis results table|분석 결과 표)$/ }).isVisible().catch(() => false);
        const overviewText = (await textOf(page.getByRole('main')).catch(() => '')).slice(0, 400);
        return { label, currentSnapshotId: project.currentSnapshot?.id ?? null, lastCompleteSnapshotKept: project.currentSnapshot?.id === ctx.snapshotId,
          notes: notes.length, tasks: Array.isArray(tasks) ? tasks.length : null, noteVisible, taskVisible, overviewVisible, overviewText };
      };
      // Each case modifies the synthetic source and enlarges it so the analysis is long enough to interrupt.
      let generation = 0;
      const mutateSource = () => {
        generation++;
        const bulk = path.join(ctx.orderDesk, 'web', 'src', 'bulk' + generation);
        fs.mkdirSync(bulk, { mode: 0o700 });
        for (let index = 0; index < 400; index++) {
          fs.writeFileSync(path.join(bulk, `Widget${index}.tsx`), `export function Widget${index}() { return <div>${index}</div> }\n`, { flag: 'wx', mode: 0o600 });
        }
        fs.appendFileSync(path.join(ctx.orderDesk, 'README.md'), `\n변경 ${generation}\n`);
      };
      const startReanalysis = async () => {
        mutateSource();
        await navigate(overviewRoute);
        await page.getByRole('button', { name: /^(Refresh status|상태 새로고침)$/ }).click();
        await settle(800);
        await page.getByRole('button', { name: /^(Preview changes|변경 사항 미리보기)$/ }).click();
        await expect(page.getByRole('region', { name: /^(Import preview to review|확인할 가져오기 미리보기)$/ })).toBeVisible({ timeout: 60000 });
        const [response] = await Promise.all([
          page.waitForResponse(item => new URL(item.url()).pathname === `/api/projects/${ctx.projectId}/reanalyze` && item.request().method() === 'POST', { timeout: 60000 }),
          page.getByRole('button', { name: /^(Re-analyze everything after reviewing changes|변경 확인 후 전체 재분석)$/ }).click(),
        ]);
        assert.ok(response.ok());
        const jobId = (await response.json()).jobId;
        const workspaceText = await textOf(page.getByRole('region', { name: 'Local source status', exact: true })).catch(() => '');
        return { jobId, workspaceCancelControl: await page.getByRole('button', { name: /^(Cancel analysis|분석 취소)$/ }).count(), workspaceText: workspaceText.slice(0, 300) };
      };
      u5.cases.push(await attempt('u5-wizard-ui-cancel', async () => {
        const result = { case: 'initial import of library-loans cancelled with the wizard Cancel analysis button (keyboard)' };
        await navigate('/import');
        await withFolderPicker(ctx.libraryLoans, async () => {
          await page.getByRole('button', { name: 'Choose folder', exact: true }).focus();
          await page.keyboard.press('Enter');
          await expect(page.getByRole('button', { name: /^(Preview files to import|가져올 파일 미리보기)$/ })).toBeVisible();
        });
        await page.getByRole('button', { name: /^(Preview files to import|가져올 파일 미리보기)$/ }).click();
        const [created] = await Promise.all([
          page.waitForResponse(response => new URL(response.url()).pathname === '/api/projects/local' && response.request().method() === 'POST', { timeout: 60000 }),
          page.getByRole('button', { name: /^(Import and analyze the reviewed files|확인한 파일 가져오기 및 분석)$/ }).click(),
        ]);
        const body = await created.json();
        ctx.secondProjectId = body.project.id;
        const cancel = page.getByRole('button', { name: 'Cancel analysis', exact: true });
        await expect(cancel).toBeVisible({ timeout: 15000 }).catch(() => {});
        result.cancelButtonVisible = await cancel.count() > 0;
        if (result.cancelButtonVisible) { await cancel.focus(); await page.keyboard.press('Enter'); }
        const job = await awaitJob(body.jobId);
        result.jobStatus = job.status;
        await settle(800);
        result.uiText = (await textOf(page.getByRole('main'))).slice(0, 500);
        result.cancelAnnouncedAsStatus = await page.getByRole('status').filter({ hasText: /Cancelled|취소/ }).count() > 0;
        const project = await api(`/api/projects/${ctx.secondProjectId}`);
        result.secondProjectCurrentSnapshot = project.currentSnapshot?.id ?? null;
        return result;
      }, 240000));
      u5.cases.push(await attempt('u5-workspace-reanalysis-cancel', async () => {
        const started = await startReanalysis();
        const result = { case: 'workspace re-analysis; the workspace offers no cancel control, so the job is cancelled through the same job-cancel API the wizard uses', ...started };
        await api(`/api/jobs/${started.jobId}/cancel`, 'POST');
        result.jobStatus = (await awaitJob(started.jobId)).status;
        await settle(1500);
        result.retained = await verifyRetained('after-cancel');
        return result;
      }, 300000));
      for (const mode of ['graceful-quit', 'sigkill-owner']) {
        u5.cases.push(await attempt('u5-' + mode, async () => {
          const started = await startReanalysis();
          const result = { case: mode === 'graceful-quit' ? 'app closed normally while re-analysis runs' : 'Electron owner process SIGKILL while re-analysis runs', ...started };
          await sleep(1500);
          result.jobBeforeTermination = (await api(`/api/jobs/${started.jobId}`)).status;
          if (mode === 'graceful-quit') {
            try { await close('during-reanalysis'); result.closedNormally = true; } catch { result.closedNormally = false; }
          } else {
            const child = owner, pid = child.pid;
            const tree = descendants(await readProcessTable(), pid).map(row => row.pid);
            await drainSession();
            stopObserving?.(); stopObserving = null; egress.detach();
            const exited = new Promise(resolve => { if (child.exitCode !== null || child.signalCode !== null) resolve(); else child.once('exit', resolve); });
            child.kill('SIGKILL');
            await Promise.race([exited, sleep(15000)]);
            app = null;
            const deadline = Date.now() + 90000;
            let remaining = tree;
            while (Date.now() < deadline) {
              const live = new Set((await readProcessTable()).map(row => row.pid));
              remaining = tree.filter(pid => live.has(pid));
              if (!remaining.length) break;
              await sleep(1000);
            }
            result.ownedTreeSize = tree.length; result.ownedProcessesRemainingAfter90s = remaining.length;
            report.launches.at(-1).exit = { label: 'sigkill-owner', closedNormally: false, signal: child.signalCode };
            if (remaining.length) throw new Error('UX_OWNED_TREE_SURVIVED');
          }
          await launch('after-' + mode);
          await setSize(1280, 800);
          ctx.lang = 'ko';
          const job = await api(`/api/jobs/${started.jobId}`).catch(() => null);
          result.jobAfterRelaunch = job ? { status: job.status, failureCode: job.failureCode ?? null } : null;
          result.retained = await verifyRetained('after-' + mode);
          await auditState('overview-after-' + mode, { shot: true });
          return result;
        }, 420000));
      }
    }
    await setEgressPhase('final');
    report.pageErrors = pageErrors; report.consoleErrors = consoleErrors;
    await close('final');
  } catch (error) {
    failure = error;
    report.errors.push({ step: report.phase, errorName: error?.name ?? null, message: redact(error?.message), fatal: true });
  } finally {
    try { if (app) await close('cleanup'); } catch (error) { report.errors.push({ step: 'cleanup', message: redact(error?.message) }); }
    egress.detach();
    try { assert.equal(hash(manifestFile), report.candidate.manifestSha256); assert.equal(hash(asar), report.candidate.appAsarSha256); }
    catch { report.candidateChanged = true; }
    report.finishedAt = new Date().toISOString();
    report.status = failure || report.candidateChanged ? 'FAIL' : report.errors.length ? 'COMPLETED_WITH_STEP_FAILURES' : 'COMPLETED';
    report.work = root; report.isolatedRun = short;
    save();
  }
  console.log(JSON.stringify({ status: report.status, evidence: path.relative(repo, evidence), errors: report.errors.length, screens: report.screens.length }));
  if (report.status === 'FAIL') process.exitCode = 1;
}

module.exports = { main, parseArguments, parseLsof, classifySocket, STAGES };
if (require.main === module) main().catch(error => { console.error('UX_PILOT_WRAPPER_FAILED ' + redact(error?.message)); process.exitCode = 1; });
