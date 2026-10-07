'use strict';

// G-SEC internal packaged-app probe (not the independent review, not signed-helper C15 evidence).
// Runs the unchanged ad-hoc candidate once in a fresh synthetic isolated profile with a mock
// Keychain, then records: signing/entitlements/fuses as built, effective webPreferences, delivered
// CSP and renderer attack outcomes, the owner tree's listening sockets and their authentication,
// child argv/env secret exposure, profile file modes, and plaintext-secret occurrences after exit.
// Secret values are held only in memory; evidence records names, counts and booleans.
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const http = require('node:http');
const https = require('node:https');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const tls = require('node:tls');
const { createRequire } = require('node:module');
const { execFile, execFileSync, spawnSync } = require('node:child_process');
const { promisify } = require('node:util');
const { ensureOutputParent } = require('./owned-output.cjs');
const { prepareIsolatedRun } = require('../../desktop/src/isolated-run.cjs');
const { validateRuntimeManifest } = require('../../desktop/src/runtime-manifest.cjs');
const { launchEnvironment, bounded } = require('../../desktop/scripts/packaged-keychain-acceptance.cjs');
const { observeStartup, closeValidatedApplication } = require('../../desktop/scripts/native-acceptance-electron.cjs');
const { captureOwnedApplication } = require('../backup-compatibility/interruption-hooks.cjs');

const execute = promisify(execFile);
const SECRET_NAMES = ['DESKTOP_API_TOKEN', 'DESKTOP_PATH_TOKEN', 'DB_PASSWORD', 'REDIS_PASSWORD', 'TOKEN_ENC_KEY',
  'TS_ANALYZER_AUTH_TOKEN'];
const hash = file => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const sha = bytes => crypto.createHash('sha256').update(bytes).digest('hex');

function argumentsFor(argv) {
  assert(Array.isArray(argv) && argv.length === 2 && argv[0] === '--app');
  assert(typeof argv[1] === 'string' && path.isAbsolute(argv[1]) && !/[\x00-\x1f\x7f]/.test(argv[1]));
  assert.equal(path.basename(argv[1]), 'Code Intelligence Validation.app');
  assert.match(path.basename(path.dirname(argv[1])), /^\.native-product-[A-Za-z0-9]+$/);
  return { app: argv[1] };
}

// codesign -dv reports on stderr with exit 0, so stderr is kept on success as well.
function run(command, args, options = {}) {
  const result = spawnSync(command, args, { encoding: 'utf8', timeout: 30000, maxBuffer: 8 * 1024 * 1024,
    stdio: ['ignore', 'pipe', 'pipe'], env: { PATH: '/usr/bin:/bin:/usr/sbin:/sbin', LANG: 'C', LC_ALL: 'C' }, ...options });
  return { status: result.status ?? -1, stdout: String(result.stdout ?? ''), stderr: String(result.stderr ?? '') };
}

function plistKeys(xml) {
  return [...String(xml).matchAll(/<key>([^<]+)<\/key>\s*<(true|false)\s*\/>/g)].map(match => `${match[1]}=${match[2]}`);
}

function signing(file) {
  const details = run('/usr/bin/codesign', ['-dv', '--verbose=4', file]);
  const text = (details.stderr || '') + (details.stdout || '');
  const flags = /flags=0x[0-9a-f]+\(([^)]*)\)/.exec(text)?.[1] ?? null;
  const entitlements = run('/usr/bin/codesign', ['-d', '--entitlements', '-', '--xml', file]);
  return { flags, adhoc: /Signature=adhoc/.test(text), teamIdentifier: /TeamIdentifier=(.*)/.exec(text)?.[1] ?? null,
    hardenedRuntime: flags ? flags.split(',').includes('runtime') : false,
    entitlements: plistKeys(entitlements.stdout + (entitlements.stderr ?? '')).sort() };
}

function staticInspection(repo, app, runtime) {
  const executable = path.join(app, 'Contents/MacOS/Code Intelligence Validation');
  const helpers = fs.readdirSync(path.join(app, 'Contents/Frameworks')).filter(name => name.endsWith('.app')).sort();
  const binaries = { main: app, ...Object.fromEntries(helpers.map(name => [`helper:${name}`, path.join(app, 'Contents/Frameworks', name)])),
    java: path.join(runtime, 'jre/bin/java'), postgres: path.join(runtime, 'postgres/bin/postgres'),
    redis: path.join(runtime, 'redis/bin/redis-server') };
  const desktopRequire = createRequire(path.join(repo, 'desktop/package.json'));
  const asar = desktopRequire('@electron/asar');
  const archive = path.join(app, 'Contents/Resources/app.asar');
  const packagedSources = Object.fromEntries(['src/main.cjs', 'src/preload.cjs'].map(name => [name, {
    packagedSha256: sha(asar.extractFile(archive, name)), worktreeSha256: hash(path.join(repo, 'desktop', name)) }]));
  const info = fs.readFileSync(path.join(app, 'Contents/Info.plist'), 'utf8');
  return {
    signing: Object.fromEntries(Object.entries(binaries).map(([name, file]) => [name, signing(file)])),
    defaultAppAsarPresent: fs.existsSync(path.join(app, 'Contents/Resources/default_app.asar')),
    electronAsarIntegrityInInfoPlist: info.includes('ElectronAsarIntegrity'),
    packagedSources, executable,
  };
}

async function readFuses(repo, app) {
  const fuses = createRequire(path.join(repo, 'desktop/package.json'))('@electron/fuses');
  const wire = await fuses.getCurrentFuseWire(app);
  const state = {};
  for (const [key, value] of Object.entries(wire)) {
    if (key === 'version' || key === 'resetAdHocDarwinSignature') continue;
    const name = fuses.FuseV1Options[key] ?? `fuse-${key}`;
    state[name] = { 48: 'DISABLE', 49: 'ENABLE', 114: 'REMOVED' }[value] ?? String(value);
  }
  return { wireVersion: wire.version, state };
}

function effectiveNodeModes(executable, scratch) {
  // Demonstrates what the fuse wire permits; each child is the packaged binary in Node mode only.
  const env = { HOME: scratch, PATH: '/usr/bin:/bin', LANG: 'C', LC_ALL: 'C', ELECTRON_RUN_AS_NODE: '1' };
  const runAsNode = run(executable, ['-e', 'process.stdout.write("RUN_AS_NODE:" + process.versions.electron)'], { env, cwd: scratch });
  const marker = path.join(scratch, 'node-options-marker.cjs');
  fs.writeFileSync(marker, 'process.stdout.write("NODE_OPTIONS_REQUIRE_EXECUTED;")\n', { mode: 0o600 });
  const nodeOptions = run(executable, ['-e', '0'], { env: { ...env, NODE_OPTIONS: `--require ${marker}` }, cwd: scratch });
  return { runAsNodeHonored: /^RUN_AS_NODE:\d/.test(runAsNode.stdout), runAsNodeElectron: /RUN_AS_NODE:(\S+)/.exec(runAsNode.stdout)?.[1] ?? null,
    nodeOptionsRequireHonored: nodeOptions.stdout.includes('NODE_OPTIONS_REQUIRE_EXECUTED') };
}

async function processTree(rootPid) {
  const { stdout } = await execute('/bin/ps', ['-A', '-o', 'pid=,ppid=,comm='], { maxBuffer: 4 * 1024 * 1024 });
  const rows = stdout.trim().split('\n').map(line => /^\s*(\d+)\s+(\d+)\s+(.*)$/.exec(line)).filter(Boolean)
    .map(match => ({ pid: Number(match[1]), ppid: Number(match[2]), comm: match[3] }));
  const tree = new Map([[rootPid, rows.find(row => row.pid === rootPid)]]);
  for (let changed = true; changed;) {
    changed = false;
    for (const row of rows) if (tree.has(row.ppid) && !tree.has(row.pid)) { tree.set(row.pid, row); changed = true; }
  }
  return [...tree.values()].filter(Boolean);
}

function roleOf(row, app, runtime, owner) {
  if (row.pid === owner) return 'ELECTRON_MAIN';
  const comm = row.comm;
  if (comm.startsWith(path.join(app, 'Contents/Frameworks'))) return 'ELECTRON_HELPER';
  if (comm === path.join(app, 'Contents/MacOS/Code Intelligence Validation')) return 'ANALYZER_NODE';
  if (comm === path.join(runtime, 'jre/bin/java')) return 'JAVA';
  if (comm === path.join(runtime, 'postgres/bin/postgres')) return 'POSTGRES';
  if (comm === path.join(runtime, 'redis/bin/redis-server')) return 'REDIS';
  return 'OTHER';
}

async function processEnvironment(pid) {
  const { stdout } = await execute('/bin/ps', ['-E', '-ww', '-o', 'command=', '-p', String(pid)], { maxBuffer: 4 * 1024 * 1024 });
  return stdout.replace(/\n$/, '');
}
async function processArguments(pid) {
  const { stdout } = await execute('/bin/ps', ['-ww', '-o', 'command=', '-p', String(pid)], { maxBuffer: 4 * 1024 * 1024 });
  return stdout.replace(/\n$/, '');
}

async function listeners(pids) {
  const result = run('/usr/sbin/lsof', ['-nP', '-a', '-p', pids.join(','), '-i']);
  return result.stdout.trim().split('\n').slice(1).filter(Boolean).map(line => {
    const fields = line.trim().split(/\s+/);
    return { pid: Number(fields[1]), protocol: fields[7], name: fields.slice(8).join(' ') };
  }).filter(row => /LISTEN|UDP/.test(row.name) || row.protocol === 'UDP');
}

function httpsStatus(port, pathname, headers = {}, method = 'GET') {
  return new Promise(resolve => {
    const request = https.request({ host: '127.0.0.1', port, path: pathname, method, headers, rejectUnauthorized: false, timeout: 5000 },
      response => { response.resume(); response.on('end', () => resolve({ status: response.statusCode, csp: response.headers['content-security-policy'] ?? null,
        frameOptions: response.headers['x-frame-options'] ?? null, contentTypeOptions: response.headers['x-content-type-options'] ?? null })); });
    request.on('timeout', () => request.destroy(new Error('timeout')));
    request.on('error', error => resolve({ status: null, error: error.code ?? 'ERROR' }));
    request.end(method === 'POST' ? '{}' : undefined);
  });
}

function redisProbe(port) {
  const plain = new Promise(resolve => {
    const socket = net.connect({ host: '127.0.0.1', port }); let data = '';
    socket.setTimeout(3000, () => socket.destroy());
    socket.on('connect', () => socket.write('PING\r\n')); socket.on('data', chunk => { data += chunk; socket.destroy(); });
    socket.on('close', () => resolve({ plaintextPong: data.includes('+PONG') })); socket.on('error', () => {});
  });
  const secure = new Promise(resolve => {
    const socket = tls.connect({ host: '127.0.0.1', port, rejectUnauthorized: false }); let data = '';
    socket.setTimeout(3000, () => socket.destroy());
    socket.on('secureConnect', () => socket.write('PING\r\n')); socket.on('data', chunk => { data += chunk; socket.destroy(); });
    socket.on('close', () => resolve({ tlsWithoutPassword: data.startsWith('+PONG') ? 'PONG' : data.startsWith('-NOAUTH') ? 'NOAUTH' : data.slice(0, 16) || 'CLOSED' }));
    socket.on('error', () => {});
  });
  return Promise.all([plain, secure]).then(([a, b]) => ({ ...a, ...b }));
}

function postgresProbe(runtime, port) {
  const psql = path.join(runtime, 'postgres/bin/psql');
  const env = { PATH: '/usr/bin:/bin', LANG: 'C', LC_ALL: 'C', DYLD_LIBRARY_PATH: path.join(runtime, 'postgres/lib'), PGCONNECT_TIMEOUT: '5' };
  return ['codeintel', 'postgres'].map(user => {
    const result = run(psql, ['-X', '-w', '-h', '127.0.0.1', '-p', String(port), '-U', user, '-d', 'postgres', '-tAc', 'select 1'], { env });
    return { user, connectedWithoutPassword: result.status === 0, refusal: /password|authentication|SSL|no pg_hba/i.test(result.stderr ?? '') };
  });
}

function walkModes(root) {
  const report = { directories: 0, files: 0, sockets: 0, directoryNot0700: [], fileNot0600: [], groupOrOtherAccessible: [] };
  const visit = (current, ancestorsPrivate) => {
    const stat = fs.lstatSync(current), mode = stat.mode & 0o777, rel = path.relative(root, current) || '.';
    if (stat.isSymbolicLink()) return;
    if (stat.isDirectory()) {
      report.directories++;
      if (mode !== 0o700) report.directoryNot0700.push(`${rel}:${mode.toString(8)}`);
      if (!ancestorsPrivate && (mode & 0o077)) report.groupOrOtherAccessible.push(`${rel}:${mode.toString(8)}`);
      const nextPrivate = ancestorsPrivate || (mode & 0o077) === 0;
      for (const name of fs.readdirSync(current)) visit(path.join(current, name), nextPrivate);
    } else {
      if (stat.isSocket()) report.sockets++; else report.files++;
      if (mode !== 0o600) report.fileNot0600.push(`${rel}:${mode.toString(8)}`);
      if (!ancestorsPrivate && (mode & 0o077)) report.groupOrOtherAccessible.push(`${rel}:${mode.toString(8)}`);
    }
  };
  visit(root, false);
  for (const key of ['directoryNot0700', 'fileNot0600', 'groupOrOtherAccessible']) {
    report[`${key}Count`] = report[key].length; report[key] = report[key].slice(0, 200);
  }
  return report;
}

function plaintextSecretScan(root, secrets, extraTexts) {
  const needles = Object.entries(secrets).filter(([, value]) => typeof value === 'string' && value.length >= 16)
    .map(([name, value]) => [name, Buffer.from(value)]);
  const hits = []; let scannedFiles = 0, scannedBytes = 0, skippedLarge = 0;
  const visit = current => {
    const stat = fs.lstatSync(current);
    if (stat.isSymbolicLink() || stat.isSocket() || stat.isFIFO()) return;
    if (stat.isDirectory()) { for (const name of fs.readdirSync(current)) visit(path.join(current, name)); return; }
    if (stat.size > 256 * 1024 * 1024) { skippedLarge++; return; }
    const bytes = fs.readFileSync(current); scannedFiles++; scannedBytes += bytes.length;
    for (const [name, needle] of needles) if (bytes.includes(needle)) hits.push({ secret: name, file: path.relative(root, current) });
  };
  visit(root);
  for (const [label, text] of Object.entries(extraTexts)) {
    for (const [name, needle] of needles) if (Buffer.from(text).includes(needle)) hits.push({ secret: name, file: `<${label}>` });
  }
  return { scannedFiles, scannedBytes, skippedLarge, hits };
}

async function main(argv = process.argv.slice(2)) {
  const options = argumentsFor(argv);
  assert.equal(process.platform, 'darwin'); assert.equal(process.arch, 'arm64'); process.umask(0o077);
  const repo = fs.realpathSync(path.resolve(__dirname, '../..')), app = fs.realpathSync(options.app);
  assert.equal(app, options.app); assert.equal(path.dirname(path.dirname(app)), repo);
  const runtime = path.join(app, 'Contents/Resources/runtime'), manifestFile = path.join(runtime, 'runtime-manifest.json');
  const manifest = JSON.parse(fs.readFileSync(manifestFile)); await validateRuntimeManifest(runtime, manifest);
  execFileSync('/usr/bin/codesign', ['--verify', '--deep', '--strict', app], { stdio: 'pipe', timeout: 60000 });
  const evidence = fs.mkdtempSync(path.join(ensureOutputParent(repo, 'validation/local/security-internal-review'), 'packaged-'));
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'gate-sec-node-mode-'));
  const report = { format: 1, scope: 'G-SEC internal packaged probe; not independent review; not signed-helper C15', status: 'RUNNING',
    app, buildSequence: manifest.buildSequence, appAsarSha256: hash(path.join(app, 'Contents/Resources/app.asar')),
    manifestSha256: hash(manifestFile), probeSha256: hash(__filename), observedAt: new Date().toISOString(), mockKeychain: true,
    realAccount: false, originalProfileAccessed: false, secretValuesPersisted: false, checks: {} };
  const save = () => fs.writeFileSync(path.join(evidence, 'result.json'), JSON.stringify(report, null, 2) + '\n', { mode: 0o600 });
  save(); console.log(JSON.stringify({ status: report.status, evidence }));
  try {
    report.checks.static = staticInspection(repo, app, runtime);
    report.checks.fuses = await readFuses(repo, app);
    report.checks.effectiveNodeModes = effectiveNodeModes(report.checks.static.executable, scratch);
    delete report.checks.static.executable; save();
  } finally { fs.rmSync(scratch, { recursive: true, force: true }); }

  const exfil = []; const listener = http.createServer((request, response) => {
    exfil.push({ method: request.method, path: request.url, tokenHeaderPresent: 'x-code-intelligence-token' in request.headers,
      originHeader: request.headers.origin ?? null });
    response.setHeader('Access-Control-Allow-Origin', '*'); response.end('ok');
  });
  await new Promise(resolve => listener.listen(0, '127.0.0.1', resolve));
  listener.unref(); // a preflight failure must not keep this process (and the native lock) alive
  const exfilUrl = `http://127.0.0.1:${listener.address().port}`;
  // A worktree path is too long for the 104-byte macOS Unix socket budget below repo/.nr, so the
  // synthetic profile lives in a fresh private directory under /private/tmp (never a real profile).
  const parentDirectory = fs.mkdtempSync('/private/tmp/gsec-'); fs.chmodSync(parentDirectory, 0o700);
  report.profileParent = parentDirectory;
  const plan = prepareIsolatedRun({ parentDirectory, runtimeDirectory: runtime, purpose: 'automation',
    forbiddenRoots: ['Code Intelligence', 'Code Intelligence Validation'].map(name => path.join(os.homedir(), 'Library/Application Support', name)) });
  report.profileRoot = plan.root;
  const { _electron } = createRequire(path.join(repo, 'frontend/package.json'))('playwright');
  const { expect } = createRequire(path.join(repo, 'frontend/package.json'))('@playwright/test');
  let sdk, owner, stopObserving, secrets = {}, stdoutText = '', stderrText = '';
  const diagnostics = {};
  try {
    sdk = await _electron.launch({ executablePath: path.join(app, 'Contents/MacOS/Code Intelligence Validation'),
      args: ['--use-mock-keychain', '--isolated-run-claim=' + plan.claimFile], cwd: repo, env: launchEnvironment(process.env), timeout: 90000 });
    owner = captureOwnedApplication(sdk);
    owner.process().stdout?.on('data', chunk => { if (stdoutText.length < 4e6) stdoutText += chunk; });
    owner.process().stderr?.on('data', chunk => { if (stderrText.length < 4e6) stderrText += chunk; });
    stopObserving = observeStartup(owner.process(), diagnostics, () => {});
    const page = await sdk.firstWindow({ timeout: 90000 });
    await expect(page.getByRole('link', { name: 'Code Intelligence home' })).toBeVisible({ timeout: 90000 });
    const identity = await sdk.evaluate(({ app: electronApp }) => ({ profile: electronApp.getPath('userData'), packaged: electronApp.isPackaged }));
    assert.deepEqual(identity, { profile: plan.paths.userData, packaged: true });
    report.checks.harness = { playwrightAttached: true, note: 'Playwright launch adds --inspect=0 and --remote-debugging-port=0; attaching proves both switches are honored by this build' };

    report.checks.webPreferences = await sdk.evaluate(({ BrowserWindow, webContents, app: electronApp }) => {
      const keys = ['contextIsolation', 'sandbox', 'nodeIntegration', 'nodeIntegrationInSubFrames', 'nodeIntegrationInWorker',
        'webSecurity', 'allowRunningInsecureContent', 'webviewTag', 'experimentalFeatures', 'enableBlinkFeatures',
        'disableBlinkFeatures', 'javascript', 'safeDialogs', 'navigateOnDragDrop', 'spellcheck'];
      return { windows: BrowserWindow.getAllWindows().length,
        contents: webContents.getAllWebContents().map(contents => {
          const preferences = contents.getLastWebPreferences?.() ?? {};
          let origin; try { origin = new URL(contents.getURL()).origin; } catch { origin = 'unparsed'; }
          return { type: contents.getType(), origin, preload: preferences.preload ? preferences.preload.split('/').slice(-2).join('/') : null,
            ...Object.fromEntries(keys.map(key => [key, preferences[key] ?? null])) };
        }),
        commandLineSwitches: Object.fromEntries(['remote-debugging-port', 'inspect', 'no-sandbox', 'disable-web-security',
          'ignore-certificate-errors', 'allow-running-insecure-content', 'js-flags', 'enable-logging'].map(name => [name, electronApp.commandLine.hasSwitch(name)])) };
    });
    save();

    const appOrigin = new URL(page.url()).origin;
    report.checks.renderer = await page.evaluate(async ({ exfilUrl: target }) => {
      const result = { nodeGlobals: Object.fromEntries(['require', 'process', 'module', 'Buffer', 'global', 'ipcRenderer']
        .map(name => [name, typeof globalThis[name]])) };
      result.bridgeKeys = Object.keys(window.codeIntelligenceDesktop ?? {}).sort();
      result.cspMeta = [...document.querySelectorAll('meta[http-equiv]')].map(meta => `${meta.httpEquiv}`);
      const documentResponse = await fetch(location.origin + '/', { cache: 'no-store' });
      result.documentStatus = documentResponse.status;
      result.documentCsp = documentResponse.headers.get('content-security-policy');
      try { result.evalAllowed = (0, eval)('1 + 1') === 2; } catch { result.evalAllowed = false; }
      const script = document.createElement('script'); script.textContent = 'window.__gateSecInline = true'; document.head.append(script);
      result.injectedInlineScriptRan = window.__gateSecInline === true;
      try { await fetch(target + '/renderer-fetch', { mode: 'no-cors' }); result.crossOriginFetch = 'sent'; } catch { result.crossOriginFetch = 'blocked'; }
      await new Promise(resolve => { const image = new Image(); image.onload = image.onerror = resolve; image.src = target + '/renderer-image'; setTimeout(resolve, 2000); });
      try { await fetch('file:///etc/hosts'); result.fileFetch = 'allowed'; } catch { result.fileFetch = 'blocked'; }
      result.windowOpenReturned = window.open(target + '/window-open') === null ? 'null' : 'window';
      result.externalOpen = {};
      for (const url of ['file:///Applications/Calculator.app', 'vscode://file/etc/hosts:1', 'https://evil.example/', 'javascript:alert(1)']) {
        try { await window.codeIntelligenceDesktop.openExternal(url); result.externalOpen[url] = 'accepted'; }
        catch { result.externalOpen[url] = 'rejected'; }
      }
      try { await window.codeIntelligenceDesktop.authorizeDroppedFolder(new File(['x'], 'synthetic.txt')); result.syntheticFileGrant = 'accepted'; }
      catch { result.syntheticFileGrant = 'rejected'; }
      return result;
    }, { exfilUrl });
    for (const target of [`${exfilUrl}/renderer-navigation`, 'file:///etc/hosts', 'data:text/html,<p>navigated</p>']) {
      await page.evaluate(url => { location.href = url; }, target).catch(() => {});
      await page.waitForTimeout(700);
      report.checks.renderer[`navigationTo:${target.split(':')[0]}:${target.includes(exfilUrl) ? 'loopback-listener' : 'local'}`] =
        new URL(page.url()).origin === appOrigin ? 'stayed' : 'navigated';
    }
    report.checks.renderer.windowsAfterAttempts = await sdk.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length);
    await new Promise(resolve => setTimeout(resolve, 500));
    report.checks.renderer.listenerReceived = exfil.map(item => ({ method: item.method, path: item.path,
      tokenHeaderPresent: item.tokenHeaderPresent, originHeader: item.originHeader }));
    save();

    const ownerPid = owner.process().pid;
    const tree = await processTree(ownerPid);
    const roles = Object.fromEntries(tree.map(row => [row.pid, roleOf(row, app, runtime, ownerPid)]));
    const environments = {};
    for (const row of tree) environments[row.pid] = await processEnvironment(row.pid).catch(() => '');
    const backend = tree.find(row => roles[row.pid] === 'JAVA' && environments[row.pid].includes('DESKTOP_API_TOKEN='));
    assert(backend, 'BACKEND_PROCESS_NOT_FOUND');
    for (const name of SECRET_NAMES) secrets[name] = new RegExp(`(?:^| )${name}=([^ ]+)`).exec(environments[backend.pid])?.[1];
    report.checks.secretsDiscoveredFromBackendEnv = SECRET_NAMES.filter(name => secrets[name]);
    report.checks.processes = [];
    for (const row of tree) {
      const argv = await processArguments(row.pid).catch(() => '');
      const env = environments[row.pid].slice(argv.length);
      report.checks.processes.push({ role: roles[row.pid], isBackend: row.pid === backend.pid,
        secretsInArgv: SECRET_NAMES.filter(name => secrets[name] && argv.includes(secrets[name])),
        secretValuesInEnv: SECRET_NAMES.filter(name => secrets[name] && env.includes(secrets[name])),
        secretNamesInEnv: [...SECRET_NAMES, 'PGPASSWORD'].filter(name => new RegExp(`(?:^| )${name}=`).test(env)) });
    }
    save();

    const sockets = await listeners(tree.map(row => row.pid));
    report.checks.listeners = sockets.map(row => ({ role: roles[row.pid], protocol: row.protocol, address: row.name.replace(/\s*\(LISTEN\)/, '') }));
    const portOf = role => sockets.filter(row => roles[row.pid] === role && /LISTEN/.test(row.name)).map(row => Number(/:(\d+)\s*\(LISTEN\)/.exec(row.name)?.[1]));
    const backendPort = Number(new URL(appOrigin).port);
    const token = secrets.DESKTOP_API_TOKEN;
    report.checks.localApi = {
      noToken: { root: await httpsStatus(backendPort, '/'), health: await httpsStatus(backendPort, '/actuator/health'),
        projects: await httpsStatus(backendPort, '/api/projects'), pathGrant: await httpsStatus(backendPort, '/api/desktop/paths', { 'Content-Type': 'application/json' }, 'POST') },
      withToken: {
        sameOriginDocument: await httpsStatus(backendPort, '/', { 'X-Code-Intelligence-Token': token, Origin: appOrigin }),
        crossSiteOrigin: await httpsStatus(backendPort, '/api/projects', { 'X-Code-Intelligence-Token': token, Origin: 'https://evil.example' }),
        otherLoopbackPortOrigin: await httpsStatus(backendPort, '/api/projects', { 'X-Code-Intelligence-Token': token, Origin: `https://127.0.0.1:${backendPort + 1}` }),
        nullOrigin: await httpsStatus(backendPort, '/api/projects', { 'X-Code-Intelligence-Token': token, Origin: 'null' }),
        crossSiteFetchMetadata: await httpsStatus(backendPort, '/api/projects', { 'X-Code-Intelligence-Token': token, 'Sec-Fetch-Site': 'cross-site' }),
        rebindingHostNoOrigin: await httpsStatus(backendPort, '/api/projects', { 'X-Code-Intelligence-Token': token, Host: `attacker.example:${backendPort}` }),
        rebindingHostWithAttackerOrigin: await httpsStatus(backendPort, '/api/projects', { 'X-Code-Intelligence-Token': token,
          Host: `attacker.example:${backendPort}`, Origin: `https://attacker.example:${backendPort}` }),
        pathGrantWithoutPathToken: await httpsStatus(backendPort, '/api/desktop/paths', { 'X-Code-Intelligence-Token': token,
          Origin: appOrigin, 'Content-Type': 'application/json' }, 'POST'),
      },
      plainHttp: await new Promise(resolve => { const request = http.get({ host: '127.0.0.1', port: backendPort, path: '/', timeout: 3000 },
        response => { response.resume(); resolve({ status: response.statusCode }); }); request.on('error', error => resolve({ error: error.code ?? 'ERROR' }));
        request.on('timeout', () => request.destroy(new Error('timeout'))); }),
    };
    const analyzerPorts = portOf('ANALYZER_NODE');
    report.checks.analyzerApi = await Promise.all(analyzerPorts.map(async port => ({
      health: await httpsStatus(port, '/health'), analyzeWithoutToken: await httpsStatus(port, '/analyze', { 'Content-Type': 'application/json' }, 'POST') })));
    report.checks.redis = await Promise.all(portOf('REDIS').map(redisProbe));
    report.checks.postgres = portOf('POSTGRES').map(port => postgresProbe(runtime, port));
    report.checks.unixSockets = run('/usr/sbin/lsof', ['-nP', '-a', '-p', tree.map(row => row.pid).join(','), '-U']).stdout
      .split('\n').filter(line => /\/(ai|s)\.sock|\/s(\s|$)/.test(line)).length;
    save();
  } catch (error) {
    report.failure = /^[A-Z][A-Z0-9_]+$/.test(error?.message) ? error.message : 'SECURITY_PROBE_FAILED';
    report.failureDetail = String(error?.message ?? '').split('\n')[0].slice(0, 200).replace(/[a-f0-9]{32,}/g, '<redacted-hex>');
  } finally {
    if (owner) {
      try { await closeValidatedApplication(owner, diagnostics); report.cleanupConfirmed = true; }
      catch (error) { report.cleanupFailure = /^[A-Z][A-Z0-9_]+$/.test(error?.message) ? error.message : 'CLEANUP_FAILED'; }
      report.exit = { code: owner.process().exitCode, signal: owner.process().signalCode, shutdown: diagnostics.shutdown ?? null };
    }
    stopObserving?.();
    listener.close();
    try {
      report.checks.profileModes = walkModes(plan.root);
      report.checks.plaintextSecrets = plaintextSecretScan(plan.root, secrets, { appStdout: stdoutText, appStderr: stderrText });
    } catch (error) { report.scanFailure = String(error?.code ?? 'SCAN_FAILED'); }
    secrets = {}; stdoutText = ''; stderrText = '';
    assert.equal(hash(path.join(app, 'Contents/Resources/app.asar')), report.appAsarSha256);
    report.status = report.failure || report.cleanupFailure || report.scanFailure ? 'INCOMPLETE' : 'COMPLETE';
    report.finishedAt = new Date().toISOString(); save();
  }
  console.log(JSON.stringify({ status: report.status, evidence }));
  if (report.status !== 'COMPLETE') process.exitCode = 1;
  return report;
}

module.exports = { argumentsFor, plistKeys, walkModes, plaintextSecretScan };
if (require.main === module) main().catch(error => { console.error('SECURITY_PROBE_PREFLIGHT_FAILED', String(error?.message ?? '').slice(0, 160)); process.exitCode = 1; });
