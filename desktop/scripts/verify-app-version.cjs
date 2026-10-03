#!/usr/bin/env node
'use strict';

// Isolated version probe only: this never starts the product runtime or packages it.
// Usage: node desktop/scripts/verify-app-version.cjs --electron-dist /path/to/electron/dist
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createRequire } = require('node:module');
const { spawn } = require('node:child_process');
const { pathToFileURL } = require('node:url');
const crypto = require('node:crypto');

// Serialized into the independent probe application. No product module is required.
function probeMain() {
  const { app, BrowserWindow, ipcMain, session } = require('electron');
  const fs = require('node:fs');
  const path = require('node:path');
  const vm = require('node:vm');
  const assert = require('node:assert/strict');
  const root = process.env.CI_VERSION_PROBE_ROOT;
  assert(root && fs.existsSync(path.join(root, 'owned-version-probe')));
  assert(!app.isReady(), 'Isolation must be configured before Electron ready');
  for (const name of ['userData', 'sessionData', 'logs', 'crashDumps']) {
    const directory = path.join(root, name);
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    app.setPath(name, directory);
  }
  app.commandLine.appendSwitch('disable-background-networking');
  app.commandLine.appendSwitch('disable-component-update');
  app.commandLine.appendSwitch('disable-sync');
  app.commandLine.appendSwitch('password-store', 'basic');
  const forbidden = (name) => () => { throw new Error(`Forbidden probe capability: ${name}`); };
  let window;
  let timer;
  let registered = 0;
  let configCalls = 0;
  let rejectedNetwork = 0;
  function finish(error) {
    clearTimeout(timer);
    if (error) fs.writeFileSync(path.join(root, 'failure.txt'), String(error.stack || error));
    if (window && !window.isDestroyed()) window.close();
    process.exitCode = error ? 1 : 0;
    app.quit();
  }
  // The watchdog belongs to this probe and exits only this application's lifecycle.
  timer = setTimeout(() => finish(new Error('Version probe timed out')), 45000);
  app.whenReady().then(async () => {
    const probeSession = session.fromPartition(`version-probe-${path.basename(root)}`, { cache: false });
    probeSession.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
    probeSession.setPermissionCheckHandler(() => false);
    probeSession.webRequest.onBeforeRequest((details, callback) => {
      const allowed = new URL(details.url).origin === 'https://version-probe.invalid';
      if (!allowed) rejectedNetwork += 1;
      callback({ cancel: !allowed });
    });
    await probeSession.protocol.handle('https', request => {
      const url = new URL(request.url);
      assert.equal(url.origin, 'https://version-probe.invalid');
      const relative = url.pathname === '/' ? 'index.html' : decodeURIComponent(url.pathname.slice(1));
      const file = path.resolve(__dirname, 'ui', relative);
      assert(file.startsWith(path.join(__dirname, 'ui') + path.sep));
      const contentType = file.endsWith('.js') ? 'text/javascript' : file.endsWith('.css') ? 'text/css' : 'text/html';
      return new Response(fs.readFileSync(file), { headers: { 'Content-Type': contentType } });
    });
    window = new BrowserWindow({
      width: 980, height: 700, show: false,
      webPreferences: { preload: path.join(__dirname, 'preload.cjs'), session: probeSession,
        sandbox: true, contextIsolation: true, nodeIntegration: false, webSecurity: true },
    });
    window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    window.webContents.on('console-message', event => console.log('renderer:', event.message));
    window.webContents.on('will-navigate', (event, url) => {
      if (new URL(url).origin !== 'https://version-probe.invalid') event.preventDefault();
    });
    const appFacade = new Proxy({
      getVersion: () => app.getVersion(),
      requestSingleInstanceLock: () => true, // No product singleton lock is acquired.
      on: () => {},
      whenReady: () => ({ then: () => {} }), // Product startup is intentionally unreachable.
    }, { get(target, key) {
      if (Object.hasOwn(target, key)) return target[key];
      throw new Error(`Unexpected product app capability: ${String(key)}`);
    } });
    const electronFacade = {
      app: appFacade,
      BrowserWindow: forbidden('product BrowserWindow'),
      dialog: {}, safeStorage: {}, shell: {},
      ipcMain: {
        on(channel, callback) {
          assert.equal(channel, 'runtime:config');
          registered += 1;
          ipcMain.on(channel, event => { configCalls += 1; callback(event); });
        },
        handle() {}, // Other product handlers are neither registered nor called.
      },
    };
    // Evaluate the unmodified source, but never import its runtime dependencies or run startup.
    // Keep Electron native objects in their original JS realm: cross-context WebFrameMain
    // wrappers do not preserve Electron's internal methods. This is a capability-limited
    // test harness for reviewed local source, not a security sandbox for hostile code.
    const initialize = vm.compileFunction(
      fs.readFileSync(path.join(__dirname, 'product-main.cjs'), 'utf8')
        + '\nmainWindow = probeWindow; runtime = probeRuntime; registerIpc();',
      ['require', '__dirname', 'probeWindow', 'probeRuntime', 'setTimeout', 'clearTimeout',
        'fetch', 'process', 'global', 'globalThis'], { filename: 'product-main.cjs' });
    initialize(name => name === 'electron' ? electronFacade : Object.freeze({}), __dirname,
      window, { apiBaseUrl: 'https://version-probe.invalid', apiToken: 'synthetic-probe-token' },
      forbidden('product timer'), forbidden('product timer'), forbidden('product network'));
    assert.equal(registered, 1);
    await window.loadURL('https://version-probe.invalid/');
    const result = await window.webContents.executeJavaScript(`new Promise((resolve, reject) => {
      let attempts = 0;
      const check = () => {
        const footer = document.querySelector('aside > div:last-child');
        if (footer) return resolve({
          bridgeVersion: window.codeIntelligenceDesktop?.appVersion,
          bridgeFrozen: Object.isFrozen(window.codeIntelligenceDesktop),
          uiText: footer.textContent,
          uiVisible: footer.getBoundingClientRect().width > 0 && footer.getBoundingClientRect().height > 0,
        });
        if (++attempts > 100) return reject(new Error('Actual Sidebar did not render'));
        setTimeout(check, 25);
      }; check();
    })`);
    const expected = require('./package.json').version;
    assert.equal(app.getVersion(), expected);
    assert.equal(result.bridgeVersion, expected);
    assert.equal(result.uiText, `v${expected}`);
    assert.equal(result.bridgeFrozen, true);
    assert.equal(result.uiVisible, true);
    assert.equal(configCalls, 1);
    assert.equal(rejectedNetwork, 0);
    fs.writeFileSync(path.join(root, 'sidebar.png'), (await window.webContents.capturePage()).toPNG());
    fs.writeFileSync(path.join(root, 'result.json'), JSON.stringify({
      scope: 'isolated version probe, no production runtime',
      packaged: app.isPackaged, electronVersion: process.versions.electron,
      packageVersion: expected, appVersion: app.getVersion(), ...result,
      configCalls, rejectedNetwork,
      paths: Object.fromEntries(['userData', 'sessionData', 'logs', 'crashDumps'].map(name => [name, app.getPath(name)])),
    }, null, 2));
    finish();
  }).catch(finish);
}

async function main() {
  assert.equal(process.platform, 'darwin', 'This local probe currently packages macOS only');
  const desktop = path.resolve(__dirname, '..');
  const frontend = path.resolve(desktop, '../frontend');
  const packageJson = JSON.parse(fs.readFileSync(path.join(desktop, 'package.json'), 'utf8'));
  const index = process.argv.indexOf('--electron-dist');
  assert(index >= 0 && process.argv[index + 1], 'Pass --electron-dist explicitly; existing installs are never launched');
  const electronDist = fs.realpathSync(process.argv[index + 1]);
  const binary = path.join(electronDist, 'Electron.app/Contents/MacOS/Electron');
  assert(fs.existsSync(binary), 'Electron binary missing');
  assert.equal(fs.readFileSync(path.join(electronDist, 'version'), 'utf8').trim(), packageJson.devDependencies.electron);
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ci-version-probe-'));
  fs.chmodSync(root, 0o700);
  console.log(`Isolated probe artifacts: ${root}`);
  const probe = path.join(root, 'probe');
  fs.mkdirSync(probe);
  const inputFiles = [path.join(desktop, 'src/main.cjs'), path.join(desktop, 'src/preload.cjs'),
    path.join(frontend, 'src/app/Sidebar.tsx'), path.join(desktop, 'package.json')];
  const hashes = () => Object.fromEntries(inputFiles.map(file => [file, crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex')]));
  const before = hashes();
  fs.writeFileSync(path.join(probe, 'package.json'), JSON.stringify({ name: 'code-intelligence-version-probe',
    version: packageJson.version, main: 'probe-main.cjs', description: 'Isolated app version verification only', author: 'Local validation' }));
  fs.writeFileSync(path.join(probe, 'probe-main.cjs'), `(${probeMain.toString()})();\n`);
  fs.copyFileSync(inputFiles[0], path.join(probe, 'product-main.cjs'));
  fs.copyFileSync(inputFiles[1], path.join(probe, 'preload.cjs'));

  const frontendRequire = createRequire(path.join(frontend, 'package.json'));
  const entry = path.join(root, 'entry.tsx');
  // Query data is preseeded and infinitely fresh: the real Sidebar never needs an API call.
  fs.writeFileSync(entry, `
    import React from 'react';
    import { createRoot } from 'react-dom/client';
    import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
    import { MemoryRouter } from 'react-router-dom';
    import Sidebar from ${JSON.stringify(inputFiles[2])};
    window.fetch = () => { throw new Error('Network is forbidden in the version probe') };
    const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });
    client.setQueryData(['projects'], []);
    createRoot(document.getElementById('root')!).render(
      <QueryClientProvider client={client}><MemoryRouter><Sidebar /></MemoryRouter></QueryClientProvider>
    );
  `);
  fs.writeFileSync(path.join(root, 'index.html'), `<html><head><meta http-equiv="Content-Security-Policy" content="default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'none'"></head><body><div id="root"></div><script type="module" src="./entry.tsx"></script></body></html>`);
  fs.writeFileSync(path.join(root, 'tsconfig.json'), JSON.stringify({ compilerOptions: { jsx: 'react-jsx' } }));
  const { build: viteBuild } = await import(pathToFileURL(frontendRequire.resolve('vite')).href);
  await viteBuild({ configFile: false, root, logLevel: 'warn',
    resolve: { alias: Object.fromEntries(['react', 'react-dom', '@tanstack/react-query', 'react-router-dom']
      .map(name => [name, path.join(frontend, 'node_modules', name)])) },
    build: { outDir: path.join(probe, 'ui'), emptyOutDir: true },
  });

  async function run(label, executable, args) {
    const owned = path.join(root, label);
    fs.mkdirSync(owned, { mode: 0o700 });
    fs.writeFileSync(path.join(owned, 'owned-version-probe'), 'isolated probe');
    const log = fs.openSync(path.join(owned, 'electron.log'), 'w', 0o600);
    // Deliberately avoid inheriting credentials, Electron flags or production runtime variables.
    const child = spawn(executable, args, { cwd: probe, stdio: ['ignore', log, log], env: {
      PATH: process.env.PATH, HOME: owned, TMPDIR: owned,
      CI_VERSION_PROBE_ROOT: owned, LANG: 'en_US.UTF-8',
    } });
    try {
      const exit = await new Promise((resolve, reject) => {
        child.once('error', reject);
        child.once('exit', (code, signal) => resolve({ code, signal }));
      });
      assert.deepEqual(exit, { code: 0, signal: null }, `Probe failed; inspect ${owned}`);
      assert(!fs.existsSync(path.join(owned, 'failure.txt')), `Probe failed; inspect ${owned}/failure.txt`);
      const result = JSON.parse(fs.readFileSync(path.join(owned, 'result.json'), 'utf8'));
      assert.equal(result.packaged, label === 'packaged');
      assert.equal(result.packageVersion, packageJson.version);
      assert.equal(result.electronVersion, packageJson.devDependencies.electron);
      return { ...result, exit, artifactDirectory: owned };
    } finally { fs.closeSync(log); }
  }
  const dev = await run('development', binary, [probe]);
  // Builder may modify its distribution input; use an owned copy, never the installed source.
  const ownedElectron = path.join(root, 'electron-dist');
  fs.cpSync(electronDist, ownedElectron, { recursive: true, dereference: false, verbatimSymlinks: true });
  process.env.CSC_IDENTITY_AUTO_DISCOVERY = 'false';
  const { build, Platform, Arch } = require('electron-builder');
  await build({ projectDir: probe, publish: 'never', targets: Platform.MAC.createTarget('dir', Arch[process.arch]), config: {
    appId: `invalid.local.codeintelligence.versionprobe.${path.basename(root).toLowerCase()}`,
    productName: 'Code Intelligence Version Probe', electronVersion: packageJson.devDependencies.electron,
    electronDist: ownedElectron, npmRebuild: false, nodeGypRebuild: false, forceCodeSigning: false,
    asar: true, files: ['probe-main.cjs', 'product-main.cjs', 'preload.cjs', 'ui/**/*', 'package.json'],
    directories: { output: path.join(root, 'packaged-output') },
    mac: { target: ['dir'], identity: null, hardenedRuntime: false, gatekeeperAssess: false },
  } });
  const packagedBinary = path.join(root, 'packaged-output', process.arch === 'arm64' ? 'mac-arm64' : 'mac',
    'Code Intelligence Version Probe.app', 'Contents/MacOS/Code Intelligence Version Probe');
  const packaged = await run('packaged', packagedBinary, []);
  assert.deepEqual(hashes(), before, 'Inputs changed during verification; rerun for consistent evidence');
  const report = { scope: 'isolated version probe, no production runtime', root, sourceHashes: before, development: dev, packaged };
  fs.writeFileSync(path.join(root, 'verification.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
}

// Builder installs exit hooks; preserve failure status after an awaited child has exited.
main().catch(error => { console.error(error); process.exit(1); });
