'use strict';

// G-SEC renderer/IPC boundary. Evaluates the actual main.cjs and preload.cjs with a synthetic
// Electron double: no Electron, no window, no network, no OS secure storage and no child process.
// Every case attacks the boundary (forged sender/frame/origin, malformed input, hostile URLs)
// and asserts that no privileged side effect (dialog, backend request, shell open) happened.
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const test = require('node:test');

const sourceRoot = path.resolve(__dirname, '../src');
const ORIGIN = 'https://127.0.0.1:41000';
const TOKEN = 'f'.repeat(64);
const CHANNELS = ['data:backup', 'data:restore', 'external:open', 'folder:authorize', 'folder:pick',
  'runtime:config', 'runtime:restart', 'runtime:status'];

function loadMain() {
  const handlers = new Map(), browser = [], opened = [], dialogs = [], requests = [], operations = [];
  const app = { isPackaged: true, requestSingleInstanceLock: () => true, hasSingleInstanceLock: () => true,
    getVersion: () => '0.1.0', whenReady: () => new Promise(() => {}), on() {}, quit() {}, exit() {},
    getPath: () => { throw new Error('synthetic main must not resolve a real profile path'); } };
  class BrowserWindow {
    constructor(config) {
      browser.push(this); this.config = config;
      const webContents = new EventEmitter(); webContents.id = 7; webContents.mainFrame = { url: 'about:blank' };
      webContents.send = () => {};
      webContents.setWindowOpenHandler = fn => { this.windowOpen = fn; };
      webContents.session = {
        webRequest: { onBeforeSendHeaders: (filter, fn) => { this.headerFilter = filter; this.headers = fn; },
          onHeadersReceived: (filter, fn) => { this.responseFilter = filter; this.responseHeaders = fn; } },
        setCertificateVerifyProc: fn => { this.verifyCertificate = fn; },
        setPermissionCheckHandler: fn => { this.permissionCheck = fn; },
        setPermissionRequestHandler: fn => { this.permissionRequest = fn; },
      };
      this.webContents = webContents;
    }
    once() {} show() {} focus() {} isMinimized() { return false; }
    loadURL(url) { this.webContents.mainFrame.url = url; this.loaded = url; }
  }
  const electron = { app, BrowserWindow, safeStorage: { isEncryptionAvailable: () => false },
    ipcMain: { on: (name, fn) => handlers.set(name, fn), handle: (name, fn) => handlers.set(name, fn) },
    dialog: { showOpenDialog: async (...values) => { dialogs.push(values); return { canceled: true }; },
      showMessageBox: async (...values) => { dialogs.push(values); return { response: 1 }; },
      showErrorBox: (...values) => dialogs.push(values) },
    shell: { openExternal: async url => { opened.push(url); } } };
  const context = vm.createContext({ Buffer, URL, AbortSignal, console, __dirname: sourceRoot,
    process: { env: { PATH: '/synthetic/bin' }, argv: ['electron', '.'], pid: 4242, platform: 'darwin', arch: 'arm64',
      execPath: '/synthetic/electron', resourcesPath: '/synthetic/resources', getuid: process.getuid.bind(process) },
    require: name => name === 'electron' ? electron : require(name.startsWith('./') ? path.join(sourceRoot, name) : name),
    setTimeout, clearTimeout });
  vm.runInContext(fs.readFileSync(path.join(sourceRoot, 'main.cjs'), 'utf8'), context);
  const run = source => vm.runInContext(source, context);
  context.syntheticRequest = async (url, init) => { requests.push({ url, init }); return { ok: true, json: async () => ({ path: '/synthetic' }) }; };
  context.syntheticOperation = name => operations.push(name);
  run(`mainWindow = new BrowserWindow({}); mainWindow.webContents.mainFrame.url = '${ORIGIN}/projects';
    runtime = { apiBaseUrl: '${ORIGIN}', apiToken: '${TOKEN}', pathToken: 'p'.repeat(64), authorizedRoots: [], ready: true,
      pathsFile: '/synthetic/never-written', transport: { backend: { request: syntheticRequest },
        verifyBackendCertificate: (data, host) => data === 'pinned' && host === '127.0.0.1' } };
    safetyLifecycle = { diagnostics: () => ({ aiOff: true, recoveryOnly: false }) };
    stopRuntime = async () => syntheticOperation('stop'); startRuntime = async () => syntheticOperation('start');
    registerIpc();`);
  const trusted = () => ({ sender: browser[0].webContents, senderFrame: browser[0].webContents.mainFrame });
  return { handlers, browser, opened, dialogs, requests, operations, run, trusted };
}

async function invoke(h, channel, event, ...args) {
  if (channel === 'runtime:config') { h.handlers.get(channel)(event, ...args); return event.returnValue; }
  return Promise.resolve().then(() => h.handlers.get(channel)(event, ...args));
}

test('IPC surface is exactly the reviewed channel list', () => {
  const h = loadMain();
  assert.deepEqual([...h.handlers.keys()].sort(), CHANNELS);
});

test('every IPC channel refuses forged senders, subframes and foreign or non-app origins without side effects', async () => {
  const h = loadMain();
  const main = h.browser[0].webContents;
  const forged = [
    ['another webContents', { sender: new EventEmitter(), senderFrame: main.mainFrame }],
    ['a subframe at the app origin', { sender: main, senderFrame: { url: `${ORIGIN}/projects` } }],
    ['a destroyed frame', { sender: main, senderFrame: null }],
    ...['https://evil.example/', 'https://127.0.0.1:41001/', 'http://127.0.0.1:41000/', 'https://localhost:41000/',
      'https://[::1]:41000/', 'https://127.0.0.1.nip.io:41000/', 'file:///Applications/', 'code-intelligence://app/',
      'devtools://devtools/bundled/inspector.html', 'chrome-extension://abc/', 'data:text/html,<p>', 'about:blank', '']
      .map(url => [`main frame at ${url || 'an empty URL'}`, { sender: main, senderFrame: { ...main.mainFrame, url }, sameFrame: true }]),
  ];
  for (const [label, event] of forged) {
    if (event.sameFrame) { main.mainFrame.url = event.senderFrame.url; event.senderFrame = main.mainFrame; }
    for (const channel of CHANNELS) {
      const args = channel === 'external:open' ? ['https://github.com/'] : channel === 'folder:authorize' ? ['/'] : [];
      if (channel === 'runtime:config') assert.equal(await invoke(h, channel, event, ...args), null, `${channel} from ${label}`);
      else await assert.rejects(invoke(h, channel, event, ...args), /Untrusted renderer IPC request/, `${channel} from ${label}`);
    }
  }
  main.mainFrame.url = `${ORIGIN}/projects`;
  assert.deepEqual({ opened: h.opened, dialogs: h.dialogs.length, requests: h.requests.length, operations: h.operations },
    { opened: [], dialogs: 0, requests: 0, operations: [] });
});

test('trusted renderer input is schema-checked before any folder grant or external open', async () => {
  const h = loadMain();
  for (const value of [undefined, null, 7, {}, ['/'], { toString: () => '/' }, '', 'relative/path', './x', '~/.ssh']) {
    await assert.rejects(invoke(h, 'folder:authorize', h.trusted(), value), `folder:authorize ${String(value)}`);
  }
  for (const value of [undefined, null, 7, {}, { toString: () => 'https://github.com/' }, '']) {
    await assert.rejects(invoke(h, 'external:open', h.trusted(), value));
  }
  assert.equal(h.requests.length, 0);
  assert.deepEqual(h.opened, []);
});

const HOSTILE_EXTERNAL = ['javascript:alert(document.domain)', 'file:///Applications/Calculator.app',
  'vscode://file/etc/passwd:1', 'cursor://file/etc/hosts:1', 'jetbrains://idea/open?file=%2Fetc%2Fpasswd&line=1',
  'x-apple.systempreferences:com.apple.preference.security', 'smb://attacker.example/share', 'http://github.com/',
  'https://github.com.evil.example/', 'https://evil.example/?https://github.com', 'https://github.com@evil.example/',
  'https://user:pass@github.com/', 'https://github.com./login', 'https://xn--gthub-2ua.com/', 'https://github.com:8443/',
  'https://gist.github.com/', 'https://api.github.com/', 'https://codeload.github.com/o/r', 'https://127.0.0.1:41000/',
  'https://[::ffff:8c52:7903]/', 'https://2398795651/', 'data:text/html,<script>alert(1)</script>',
  'about:blank', 'not a url'];
// blob: URLs report the origin of their inner URL (SEC-L-01).
const INNER_ORIGIN_SCHEMES = ['blob:https://github.com/00000000-0000-0000-0000-000000000000',
  'blob:https://docs.github.com/00000000-0000-0000-0000-000000000000'];

test('external open accepts only canonical github.com/docs.github.com HTTPS URLs (B11: no IDE or custom scheme)', async () => {
  const h = loadMain();
  for (const url of HOSTILE_EXTERNAL) {
    await assert.rejects(invoke(h, 'external:open', h.trusted(), url), `external:open ${url}`);
  }
  assert.deepEqual(h.opened, []);
  for (const [raw, canonical] of [
    ['https://github.com/login/device', 'https://github.com/login/device'],
    ['https://GITHUB.com:443/login/device', 'https://github.com/login/device'],
    ['https://github%2ecom/settings', 'https://github.com/settings'],
    ['https://docs.github.com/en/apps', 'https://docs.github.com/en/apps'],
  ]) await invoke(h, 'external:open', h.trusted(), raw).then(() => assert.equal(h.opened.at(-1), canonical, raw));
  assert.equal(h.opened.length, 4);
});

test('the only window has the hardened webPreferences and denies new windows, navigation and permissions', () => {
  const h = loadMain();
  h.run('createWindow();');
  assert.equal(h.browser.length, 2, 'one product window besides the IPC fixture');
  const window = h.browser[1];
  const preferences = JSON.parse(JSON.stringify(window.config.webPreferences));
  assert.deepEqual(preferences, { preload: path.join(sourceRoot, 'preload.cjs'), contextIsolation: true, sandbox: true,
    nodeIntegration: false, webSecurity: true });
  assert.equal(window.loaded, ORIGIN);
  for (const url of [...HOSTILE_EXTERNAL, 'https://github.com/login/device', `${ORIGIN}/projects`]) {
    const before = h.opened.length;
    assert.equal(JSON.stringify(window.windowOpen({ url })), JSON.stringify({ action: 'deny' }), `window.open ${url}`);
    if (!url.startsWith('https://github.com/')) assert.equal(h.opened.length, before, `window.open must not hand ${url} to the OS`);
  }
  for (const kind of ['will-navigate', 'will-frame-navigate']) {
    for (const url of [...HOSTILE_EXTERNAL.filter(url => !url.startsWith(ORIGIN)), `${ORIGIN.replace('https', 'http')}/`, 'https://127.0.0.1:41000@evil.example/',
      'https://localhost:41000/', 'chrome://settings', 'devtools://devtools/bundled/inspector.html', 'view-source:' + ORIGIN]) {
      let prevented = false;
      window.webContents.emit(kind, { url, preventDefault() { prevented = true; } });
      assert.equal(prevented, true, `${kind} ${url}`);
    }
  }
  for (const permission of ['openExternal', 'media', 'geolocation', 'notifications', 'clipboard-read', 'clipboard-sanitized-write',
    'fullscreen', 'pointerLock', 'midi', 'midiSysex', 'hid', 'serial', 'usb', 'display-capture', 'storage-access', 'unknown']) {
    assert.equal(window.permissionCheck(window.webContents, permission, ORIGIN, {}), false, permission);
    let granted;
    window.permissionRequest(window.webContents, permission, value => { granted = value; }, { requestingUrl: ORIGIN });
    assert.equal(granted, false, permission);
  }
});

test('certificate pinning refuses other hosts and unpinned certificates for the renderer session', () => {
  const h = loadMain();
  h.run('createWindow();');
  const window = h.browser[1];
  const verdict = (hostname, data) => { let code; window.verifyCertificate({ hostname, certificate: { data } }, value => { code = value; }); return code; };
  assert.equal(verdict('127.0.0.1', 'pinned'), 0);
  assert.equal(verdict('127.0.0.1', 'attacker-issued'), -2);
  for (const host of ['localhost', 'evil.example', '::1', '127.0.0.2', '127.0.0.1.nip.io']) assert.equal(verdict(host, 'pinned'), -3, host);
});

test('the launch token header is injected only for app-origin requests of the product window', () => {
  const h = loadMain();
  h.run('createWindow();');
  const window = h.browser[1];
  assert.deepEqual(JSON.parse(JSON.stringify(window.headerFilter)), { urls: [`${ORIGIN}/*`] });
  const send = details => { let result; window.headers(details, value => { result = value; }); return result.requestHeaders; };
  const own = window.webContents.id;
  const forged = send({ webContentsId: own, url: `${ORIGIN}/api/projects`, resourceType: 'xhr',
    requestHeaders: { 'x-code-intelligence-token': 'renderer-chosen', 'X-CODE-INTELLIGENCE-TOKEN': 'second', Origin: 'https://evil.example' } });
  assert.deepEqual(Object.keys(forged).filter(name => name.toLowerCase() === 'x-code-intelligence-token'), ['X-Code-Intelligence-Token']);
  assert.equal(forged['X-Code-Intelligence-Token'], TOKEN);
  assert.equal(forged.Origin, 'https://evil.example', 'subresource Origin is left for the backend Origin check');
  assert.equal(send({ webContentsId: own, url: `${ORIGIN}/`, resourceType: 'mainFrame', requestHeaders: {} }).Origin, ORIGIN);
  for (const details of [
    { webContentsId: own + 1, url: `${ORIGIN}/api/projects`, resourceType: 'xhr', requestHeaders: {} },
    { webContentsId: undefined, url: `${ORIGIN}/api/projects`, resourceType: 'xhr', requestHeaders: {} },
    { webContentsId: own, url: 'https://evil.example/api/projects', resourceType: 'xhr', requestHeaders: {} },
    { webContentsId: own, url: 'https://127.0.0.1:41001/api/projects', resourceType: 'xhr', requestHeaders: {} },
  ]) assert.equal(JSON.stringify(send(details)).includes(TOKEN), false, JSON.stringify(details));
});

// SEC-M-01: the renderer must not run injected inline script or eval, or reach other origins.
// Monaco and elk workers are emitted as same-origin files (monacoSetup.ts), so no blob: worker.
const APP_CSP = "default-src 'self'; script-src 'self'; connect-src 'self'; img-src 'self' data:; "
  + "style-src 'self' 'unsafe-inline'; worker-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'";

test('every app-origin response in the product session carries the reviewed CSP, replacing any served policy', () => {
  const h = loadMain();
  h.run('createWindow();');
  const window = h.browser[1];
  assert.equal(typeof window.responseHeaders, 'function', 'no CSP is delivered for app documents');
  assert.deepEqual(JSON.parse(JSON.stringify(window.responseFilter)), { urls: [`${ORIGIN}/*`] });
  const receive = details => { let result; window.responseHeaders(details, value => { result = value; }); return result; };
  for (const [resourceType, url, served] of [
    ['mainFrame', `${ORIGIN}/`, { 'Content-Type': ['text/html'] }],
    ['subFrame', `${ORIGIN}/projects`, { 'content-security-policy': ["script-src * 'unsafe-inline' 'unsafe-eval'"] }],
    ['script', `${ORIGIN}/assets/editor.worker.js`, { 'CONTENT-SECURITY-POLICY': ['default-src *'], 'Content-Security-Policy': ['img-src *'] }],
    ['xhr', `${ORIGIN}/api/projects`, undefined],
  ]) {
    const result = receive({ webContentsId: window.webContents.id, resourceType, url, responseHeaders: served });
    assert.equal(result.cancel, undefined, url);
    const names = Object.keys(result.responseHeaders).filter(name => name.toLowerCase() === 'content-security-policy');
    assert.deepEqual(names, ['Content-Security-Policy'], url);
    assert.deepEqual([...result.responseHeaders['Content-Security-Policy']], [APP_CSP], url);
    if (served?.['Content-Type']) assert.deepEqual([...result.responseHeaders['Content-Type']], ['text/html']);
  }
  const directives = Object.fromEntries(APP_CSP.split('; ').map(entry => { const [name, ...values] = entry.split(' '); return [name, values]; }));
  for (const name of ['script-src', 'connect-src', 'worker-src']) assert.deepEqual(directives[name], ["'self'"], name);
  assert.equal(APP_CSP.includes('unsafe-eval'), false);
});

function loadPreload(config) {
  const exposed = new Map(), sent = [];
  class File {}
  vm.runInNewContext(fs.readFileSync(path.join(sourceRoot, 'preload.cjs'), 'utf8'), { File, TypeError,
    process: { platform: 'darwin' },
    require(name) {
      assert.equal(name, 'electron');
      return { contextBridge: { exposeInMainWorld(key, value) { exposed.set(key, value); } },
        ipcRenderer: { sendSync: channel => { sent.push([channel]); return config; },
          invoke: (channel, ...args) => { sent.push([channel, ...args]); return Promise.resolve('ok'); } },
        webUtils: { getPathForFile: file => file.syntheticPath ?? '' } };
    } });
  return { api: exposed.get('codeIntelligenceDesktop'), exposed, sent, File };
}

test('preload exposes a frozen fixed API that cannot reach arbitrary IPC channels or forge folder paths', () => {
  const { api, exposed, sent, File } = loadPreload({ apiBaseUrl: ORIGIN, apiToken: TOKEN, appVersion: '0.1.0' });
  assert.deepEqual([...exposed.keys()], ['codeIntelligenceDesktop']);
  assert.equal(Object.isFrozen(api), true);
  assert.deepEqual(Object.keys(api).sort(), ['apiBaseUrl', 'apiToken', 'appVersion', 'authorizeDroppedFolder', 'backup',
    'openExternal', 'pickFolder', 'platform', 'restartRuntime', 'restore', 'runtimeStatus']);
  for (const name of ['ipcRenderer', 'invoke', 'send', 'require', 'process', 'shell']) assert.equal(name in api, false, name);
  for (const value of [{ syntheticPath: '/etc' }, '/etc', null, new File()]) {
    assert.throws(() => api.authorizeDroppedFolder(value), TypeError);
  }
  for (const value of [7, '', null, { toString: () => 'https://github.com/' }]) assert.throws(() => api.openExternal(value), TypeError);
  const dropped = new File(); dropped.syntheticPath = '/Users/synthetic/project';
  api.authorizeDroppedFolder(dropped); api.openExternal('https://github.com/');
  assert.deepEqual(sent.slice(1), [['folder:authorize', '/Users/synthetic/project'], ['external:open', 'https://github.com/']]);
});

// Open finding SEC-M-02 (see docs/audit/security-internal-review-2026-10-07.md). The main process
// grants any absolute path that a compromised renderer sends on folder:authorize; 05 §1 requires
// that only a native dialog result is granted. Kept as TODO until a main-side confirmation exists.
test('a renderer-supplied folder path is not granted without a main-process native confirmation',
  { todo: 'SEC-M-02 open: folder:authorize trusts any absolute path from the renderer' }, async () => {
    const h = loadMain();
    await invoke(h, 'folder:authorize', h.trusted(), '/').catch(() => {});
    assert.ok(h.dialogs.length > 0 || h.requests.length === 0, 'grant reached the backend without a native confirmation');
  });

// SEC-L-01: a blob: URL inherits the origin of its inner https URL, so an origin-only allowlist
// handed the OS a non-https scheme. assertExternalUrl also requires the https: protocol.
test('external open and window.open refuse non-https schemes that inherit an allowlisted origin', async () => {
    const h = loadMain();
    for (const url of INNER_ORIGIN_SCHEMES) await assert.rejects(invoke(h, 'external:open', h.trusted(), url), url);
    h.run('createWindow();');
    for (const url of INNER_ORIGIN_SCHEMES) h.browser[1].windowOpen({ url });
    await new Promise(resolve => setImmediate(resolve));
    assert.deepEqual(h.opened, []);
  });
