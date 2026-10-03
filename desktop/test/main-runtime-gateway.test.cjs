'use strict';

const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { PassThrough } = require('node:stream');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const vm = require('node:vm');
const test = require('node:test');
const { setTimeout: delay } = require('node:timers/promises');
const clone = value => JSON.parse(JSON.stringify(value));
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
const sourceRoot = path.resolve(__dirname, '../src');
const nativeLocks = require('../src/native-owner-locks.cjs');
async function reached(predicate) {
  const deadline = Date.now() + 5000;
  while (!predicate() && Date.now() < deadline) await delay(2);
  assert.equal(Boolean(predicate()), true, 'synthetic main checkpoint was not reached');
}

// This evaluates actual main.cjs and the actual lifecycle/keyring/journal. No Electron is loaded,
// no installed runtime is launched, and no actual socket/network/OS secure-storage API is called.
// The gateway/PG boundary and children are explicit synthetic main-only doubles.
function storage() {
  const key = Buffer.alloc(32, 73);
  return { isEncryptionAvailable: () => true,
    encryptString(text) {
      const nonce = crypto.randomBytes(12); const cipher = crypto.createCipheriv('aes-256-gcm', key, nonce);
      return Buffer.concat([nonce, cipher.update(text, 'utf8'), cipher.final(), cipher.getAuthTag()]);
    },
    decryptString(bytes) {
      const decipher = crypto.createDecipheriv('aes-256-gcm', key, bytes.subarray(0, 12)); decipher.setAuthTag(bytes.subarray(-16));
      return Buffer.concat([decipher.update(bytes.subarray(12, -16)), decipher.final()]).toString('utf8');
    } };
}
function modeledLifecycle() {
  const context = vm.createContext({ module: { exports: {} }, Buffer,
    process: { platform: 'darwin', getuid: process.getuid.bind(process) },
    require: name => require(name.startsWith('./') ? path.join(sourceRoot, name) : name) });
  vm.runInContext(fs.readFileSync(path.join(sourceRoot, 'safety-lifecycle.cjs'), 'utf8'), context);
  return context.module.exports;
}

async function harness(t, options = {}) {
  const root = await fsp.realpath(await fsp.mkdtemp('/tmp/ci-backup-resume-main-independent-'));
  const paths = { userData: path.join(root, 'user'), temp: path.join(root, 'temp'), logs: path.join(root, 'logs') };
  for (const directory of Object.values(paths)) await fsp.mkdir(directory, { recursive: true, mode: 0o700 });
  const resources = path.join(root, 'resources'); const bundled = path.join(resources, 'runtime');
  const files = ['postgres/bin/psql', 'postgres/bin/initdb', 'postgres/bin/postgres', 'postgres/bin/pg_isready', 'postgres/bin/createdb',
    'redis/bin/redis-server', 'ts-analyzer/dist/main.js', 'jre/bin/java', 'backend/code-intelligence.jar'];
  const hashes = {};
  for (const name of files) { const file = path.join(bundled, name); await fsp.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
    await fsp.writeFile(file, 'synthetic non-executable fixture', { mode: 0o600 }); hashes[name] = crypto.createHash('sha256').update('synthetic non-executable fixture').digest('hex'); }
  const manifest = { format: 1, platform: 'darwin', arch: 'arm64', buildSequence: '100',
    runtime: { postgresBin: 'postgres/bin', postgresLib: 'postgres/lib', postgresPkgLib: 'postgres/pkglib', postgresShare: 'postgres/share' }, files: hashes };
  if (Object.hasOwn(options, 'buildSequence')) manifest.buildSequence = options.buildSequence;
  if (Object.hasOwn(options, 'backupProtocol')) manifest.backupProtocol = options.backupProtocol;
  if (manifest.backupProtocol === 3) manifest.ownershipProtocol = 1;
  if (Object.hasOwn(options, 'ownershipProtocol')) manifest.ownershipProtocol = options.ownershipProtocol;
  await fsp.writeFile(path.join(bundled, 'runtime-manifest.json'), JSON.stringify(manifest));
  const events = []; const handlers = new Map(); const appHandlers = new Map(); const timers = new Set();
  const children = []; const synchronous = []; const written = []; const ownedBootstrap = []; const logHandles = new Set();
  const leaseChildren = []; const guardians = []; const nativeProviders = [];
  const dialogs = []; const outbound = []; const browser = []; const requests = [];
  const controls = { active: false, stdinMode: 'normal', productOptions: [], vaultOptions: [], safetyOptions: [],
    backupOpenOptions: [], gatewayOpenOptions: [], singleton: true, ...options };
  const safeStorage = storage(); const realLifecycle = modeledLifecycle(); let runtimeLifecycle; let gateway; let adapter; let port = 41000;
  let quitCount = 0; const cap = 'e'.repeat(64); const channelEpoch = 'd'.repeat(64);
  const app = { isPackaged: true, requestSingleInstanceLock: () => true,
    hasSingleInstanceLock: () => controls.singleton, whenReady: () => new Promise(() => {}),
    on: (name, callback) => appHandlers.set(name, callback), getPath: name => paths[name],
    quit() { events.push('app.quit'); quitCount++; appHandlers.get('before-quit')?.({ preventDefault() { events.push('quit.prevent'); } }); } };
  class BrowserWindow {
    constructor(config) {
      events.push('window.create'); browser.push(this); this.config = config;
      const webContents = new EventEmitter(); webContents.id = 7; webContents.mainFrame = { url: 'about:blank' };
      webContents.send = (channel, value) => outbound.push({ channel, value: clone(value) });
      webContents.setWindowOpenHandler = fn => { this.windowOpen = fn; };
      webContents.session = { webRequest: { onBeforeSendHeaders: (_filter, fn) => { this.headers = fn; } },
        async clearStorageData(value) { events.push('session.clearStorage'); controls.clearedStorage = value; await controls.clearStorage?.(); },
        async clearCache() { events.push('session.clearCache'); },
        setPermissionCheckHandler() {}, setPermissionRequestHandler() {} };
      webContents.reload = () => { events.push('window.reload'); };
      this.webContents = webContents;
    }
    once() {} show() {} focus() {} isMinimized() { return false; }
    reload() { events.push('window.reload'); }
    loadURL(url) { this.webContents.mainFrame.url = url; events.push('window.load'); }
  }
  const childProcess = {
    spawn(command, args, config) {
      events.push(`spawn.${path.basename(command)}`);
      if (controls.spawnThrow) throw new Error('synthetic synchronous spawn failure');
      const child = new EventEmitter(); child.pid = 25000 + children.length; child.exitCode = null; child.signalCode = null;
      child.killMode = 'normal';
      child.kill = signal => {
        events.push(`kill.${path.basename(command)}.${signal}`);
        if (child.killMode === 'throw') throw new Error('synthetic kill failure');
        if (child.killMode === 'noExit') return false;
        queueMicrotask(() => { child.signalCode = signal; child.emit('exit', null, signal); }); return true;
      };
      if (config.stdio[0] === 'pipe') {
        child.stdin = new EventEmitter();
        child.stdin.end = (bytes, callback) => {
          events.push('backend.stdin.end'); written.push(Buffer.from(bytes)); child.sentBuffer = bytes;
          if (controls.stdinMode === 'throw') throw new Error('synthetic synchronous stdin failure');
          if (controls.stdinMode === 'delayed') { child.writeCallback = callback; return; }
          queueMicrotask(() => callback?.());
        };
      } else child.stdin = null;
      children.push({ command, args: [...args], options: config, child }); queueMicrotask(() => child.emit('spawn')); return child;
    },
    spawnSync(command, args, config) {
      synchronous.push({ command, args, options: config }); events.push(`run.${path.basename(command)}`);
      if (path.basename(command) === 'initdb') fs.writeFileSync(path.join(args[args.indexOf('-D') + 1], 'PG_VERSION'), '16');
      return { status: 0, stdout: '1', stderr: '' };
    },
  };
  // Exercise the actual branded native provider and real B/keyring/journal plumbing, while the
  // helper itself is a protocol double. This does not prove an OS FileLock or run a JVM.
  const nativeApi = {
    async createNativeOwnerLocks(value) {
      events.push('ownerLocks.open'); controls.ownerLockOptions = value;
      const provider = await nativeLocks.createNativeOwnerLocks({ ...value, spawnImpl(command, args, config) {
        assert.equal(path.basename(command), 'java'); assert.equal(args.at(-1), '--ci-desktop-lease');
        const child = new EventEmitter(); child.pid = 50000 + leaseChildren.length;
        child.stdin = new EventEmitter(); child.stdout = new PassThrough(); child.stderr = new PassThrough();
        let closed = false; let kind;
        const close = (code, signal) => {
          if (closed) return; closed = true;
          queueMicrotask(() => { child.emit('exit', code, signal); child.emit('close', code, signal); });
        };
        child.kill = signal => { close(null, signal); return true; };
        child.stdin.destroy = () => {};
        child.stdin.end = () => close(0, null);
        child.stdin.write = (line, callback) => {
          const parts = line.trimEnd().split('\t'); const operation = parts[0];
          if (operation === 'ACQUIRE') {
            kind = parts[3]; events.push(`lease.acquire.${kind}`);
            const safetyRoot = Buffer.from(parts[1], 'base64url').toString();
            const file = path.join(safetyRoot, kind, kind === 'ai-journal' ? 'writer.lock' : 'owner.lock');
            if (!fs.existsSync(file)) fs.writeFileSync(file, 'synthetic-main-native-marker\n', { mode: 0o600 });
            queueMicrotask(() => child.stdout.write(`READY\t${parts[4]}\n`));
          } else if (operation === 'CHECK') queueMicrotask(() => child.stdout.write(`HELD\t${parts[1]}\n`));
          else if (operation === 'RELEASE') {
            events.push(`lease.release.${kind}`); queueMicrotask(() => child.stdout.write(`RELEASED\t${parts[1]}\n`));
          } else throw new Error('Unexpected synthetic lease command');
          queueMicrotask(() => callback?.()); return true;
        };
        leaseChildren.push({ child, command, args, config, get kind() { return kind; } }); return child;
      } });
      nativeProviders.push(provider); controls.ownerProvider = provider;
      return provider;
    },
  };
  const guardianApi = {
    async spawnManagedProcess(value) {
      events.push(`spawn.${path.basename(value.command)}`);
      const child = new EventEmitter(); child.on('error', () => {});
      child.pid = 25000 + children.length; child.helperPid = 55000 + guardians.length;
      child.exitCode = null; child.signalCode = null; child.failure = null; child.killed = false; child.killMode = 'normal';
      let stopped = false;
      child.stopped = () => stopped;
      child.actualProcess = Object.freeze({ pid: child.pid, helperPid: child.helperPid, startedAt: '2026-10-03T00:00:00Z' });
      child.proveExit = code => {
        if (stopped) return; stopped = true; child.exitCode = code;
        child.emit('exit', code, null); child.emit('close', code, null);
      };
      child.kill = signal => {
        events.push(`kill.${path.basename(value.command)}.${signal}`); child.killed = true;
        if (child.killMode === 'throw') throw new Error('synthetic kill failure');
        if (child.killMode === 'noExit') return false;
        queueMicrotask(() => child.proveExit(signal === 'SIGKILL' ? 137 : 143)); return true;
      };
      if (value.bootstrap) { written.push(Buffer.from(value.bootstrap)); value.bootstrap.fill(0); }
      const item = { command: value.command, args: [...value.args], options: { env: value.env, cwd: value.cwd,
        logPath: value.logPath, stdio: ['guardian', 'fixed-log', 'fixed-log'] }, child };
      children.push(item); guardians.push({ ...value, bootstrap: value.bootstrap, child });
      await controls.guardianSpawn?.(child, value);
      return child;
    },
  };
  const disk = { ...fs,
    openSync(...args) { const descriptor = fs.openSync(...args); logHandles.add(descriptor); return descriptor; },
    closeSync(descriptor) { logHandles.delete(descriptor); return fs.closeSync(descriptor); } };
  const fakeNet = {
    createServer() {
      const server = new EventEmitter(); server.unref = () => server;
      server.listen = (_address, ready) => queueMicrotask(ready); server.address = () => ({ port: ++port }); server.close = callback => callback(); return server;
    },
    createConnection() { const socket = new EventEmitter(); socket.end = () => {}; queueMicrotask(() => socket.emit('connect')); return socket; },
  };
  const lifecycleApi = { ...realLifecycle,
    async loadDesktopSecrets(value) { events.push('secrets.load'); return realLifecycle.loadDesktopSecrets(value); },
    async openSafetyLifecycle(value) {
      events.push('safety.open');
      controls.safetyOptions.push(value);
      controls.pathsPresenceAtSafety = [...(controls.pathsPresenceAtSafety || []),
        fs.existsSync(path.join(paths.userData, 'authorized-paths.enc'))];
      await controls.openSafety?.();
      runtimeLifecycle = await realLifecycle.openSafetyLifecycle(value);
      return Object.freeze({ ...runtimeLifecycle,
        async latch(reason) { events.push('safety.latch'); return runtimeLifecycle.latch(reason); },
        async close() { events.push('safety.close'); await runtimeLifecycle.close(); events.push('safety.closed'); } });
    },
  };
  const postgresApi = {
    async createAiEgressPostgres(value) {
      events.push('adapter.open'); controls.adapterOptions = value;
      if (controls.adapterFailure) throw new Error('synthetic adapter init failure');
      adapter = { async readProjection() { throw new Error('The synthetic main constructor must not read a real projection.'); },
        async close() { events.push('adapter.close'); } }; return adapter;
    },
  };
  const gatewayApi = {
    async openDesktopAiGateway(value) {
      events.push('gateway.open'); controls.gatewayOptions = value;
      controls.gatewayOpenOptions.push(value);
      if (controls.gatewayFailure) throw new Error('synthetic gateway init failure');
      assert.equal(value.adapter, adapter); assert.equal(value.freshEnrollmentAllowed, true);
      const journal = await value.openJournal({ verifyCommittedReservation: async () => false, verifySettlement: async () => false, verifyActivation: async () => false });
      controls.journal = journal;
      gateway = { diagnostics: () => ({ aiOff: !controls.active, recoveryOnly: value.recoveryMode === true }),
        bootstrap() {
          events.push('gateway.bootstrap');
          const bytes = Buffer.from(JSON.stringify({ version: 1, socketPath: '/synthetic/private/ai.sock', capability: cap, epoch: channelEpoch }));
          ownedBootstrap.push(bytes); return bytes;
        },
        async latchOffline(reason) { events.push('gateway.latch'); controls.active = false; await journal.latch(reason); },
        async close() { events.push('gateway.close'); await journal.close(); events.push('gateway.closed'); } };
      return gateway;
    },
  };
  // These doubles exercise the real main port assembly without a database, source helper,
  // vault or full backup operation. The real lifecycle still owns real temporary B/key handles.
  const backupApi = {
    async createDesktopBackupRuntime(value) {
      events.push('backup.open'); controls.backupOptions = value;
      controls.backupOpenOptions.push(value);
      await controls.openBackup?.(value);
      return {
        async backup(selected) { events.push('backup.selected'); return controls.performBackup?.(value, selected); },
        async restore(selected) { events.push('restore.selected'); return controls.performRestore?.(value, selected); },
        async pendingRecovery() { events.push('backup.pending'); return controls.pendingRecovery?.(value) ?? null; },
        async recover() { events.push('backup.recover'); return controls.recover?.(value); },
        async close() { events.push('backup.close'); await controls.closeBackup?.(); },
      };
    },
  };
  const productApi = {
    async createBackupProductState(value) {
      events.push('product.open'); controls.productOptions.push(value);
      return {
        async verifyOrigin() { events.push('product.verifyOrigin'); await controls.verifyOrigin?.(value); return true; },
        async revokeCredentials(input) { events.push('product.revokeCredentials'); await controls.revokeCredentials?.(input); return true; },
        async rebindClonePaths(input) { events.push('product.rebindClonePaths'); controls.cloneBinding = input; },
        async close() { events.push('product.close'); },
      };
    },
  };
  const backupPostgresApi = {
    async createBackupPostgres(value) {
      events.push('backupPostgres.open'); controls.backupPostgresOptions = value;
      return { async close() { events.push('backupPostgres.close'); } };
    },
  };
  const databaseApi = {
    async createBackupDatabaseControl(value) {
      events.push('database.open'); controls.databaseOptions = value;
      return { async verifyQuiescent() { events.push('database.quiescent'); return true; },
        async close() { events.push('database.close'); } };
    },
  };
  const sourceApi = {
    async createBackupSourceWorker(value) {
      events.push('sourceWorker.open'); controls.sourceWorkerOptions = value;
      return { async close() { events.push('sourceWorker.close'); } };
    },
  };
  function vaultOpen(kind) {
    return async value => {
      events.push(`vault.${kind}`); controls.vaultOptions.push(value);
      return {
        async read(input) { events.push('vault.read'); return controls.readSource?.(input); },
        async exportCiphertext(input) { events.push('vault.exportCiphertext'); return controls.exportCiphertext?.(input); },
        async importCiphertext(input) { events.push('vault.importCiphertext'); return controls.importCiphertext?.(input); },
        async close() { events.push('vault.close'); },
      };
    };
  }
  const vaultApi = { openSourceVault: vaultOpen('open'), openSourceVaultRestoreStage: vaultOpen('restore') };
  const context = vm.createContext({ Buffer, URL, AbortSignal, console, __dirname: sourceRoot,
    process: { env: { PATH: '/synthetic/bin', HOME: '/synthetic/home', LANG: 'C', OPENAI_API_KEY: 'host-provider-sentinel',
      NODE_OPTIONS: 'host-node-sentinel', JAVA_TOOL_OPTIONS: 'host-java-sentinel', GITHUB_TOKEN: 'host-github-sentinel',
      GITHUB_NATIVE_CLIENT_ID: 'public-native-client' }, pid: 4242, platform: 'darwin', arch: 'arm64', execPath: '/synthetic/electron', resourcesPath: resources,
      getuid: process.getuid.bind(process) },
    require(name) {
      if (Object.hasOwn(options.modules || {}, name)) return options.modules[name];
      if (name === 'electron') return { app, BrowserWindow, safeStorage,
        ipcMain: { on: (key, value) => handlers.set(key, value), handle: (key, value) => handlers.set(key, value) },
        dialog: { showErrorBox: (...values) => dialogs.push(values),
          showOpenDialog: async (...values) => { dialogs.push({ kind: 'open', values }); return controls.selection
            ? { canceled: false, filePaths: [controls.selection] } : { canceled: true }; },
          showMessageBox: async (...values) => { dialogs.push({ kind: 'confirm', values }); return { response: controls.confirmation ?? 1 }; },
        }, shell: { openExternal: async () => {} } };
      if (name === './safety-lifecycle.cjs') return lifecycleApi;
      if (name === './ai-desktop-gateway.cjs') return gatewayApi;
      if (name === './ai-egress-postgres.cjs') return postgresApi;
      if (name === './backup-runtime.cjs') return backupApi;
      if (name === './backup-product-state.cjs') return productApi;
      if (name === './backup-postgres.cjs') return backupPostgresApi;
      if (name === './backup-database.cjs') return databaseApi;
      if (name === './backup-source-worker.cjs') return sourceApi;
      if (name === './source-vault.cjs') return vaultApi;
      if (name === './native-owner-locks.cjs') return nativeApi;
      if (name === './managed-process.cjs') return guardianApi;
      if (name === 'node:fs') return disk;
      if (name === 'node:child_process') return childProcess;
      if (name === 'node:net') return fakeNet;
      return require(name.startsWith('./') ? path.join(sourceRoot, name) : name);
    },
    fetch: async (url, config) => {
      const pathname = new URL(url).pathname; events.push(`fetch.${pathname}`); requests.push({ url, config });
      const override = await controls.fetch?.(url, config); if (override) return override;
      if (pathname === '/api/desktop/maintenance') {
        const command = JSON.parse(config.body); events.push(`maintenance.${command.operation}`);
        const body = { transactionId: command.transactionId, state: 'DRAINED', activeRequests: 0, activeWriters: 0, activeJobs: 0 };
        return { ok: true, status: 200, json: async () => body, text: async () => JSON.stringify(body) };
      }
      return { ok: true, json: async () => ({ path: '/synthetic/source' }) };
    },
    setTimeout: (fn, delay) => { const timer = { fn, delay, unref() {} }; timers.add(timer); return timer; },
    clearTimeout: timer => timers.delete(timer),
  });
  vm.runInContext(fs.readFileSync(path.join(sourceRoot, 'main.cjs'), 'utf8'), context);
  const run = source => vm.runInContext(source, context);
  const result = { root, paths, controls, events, handlers, appHandlers, timers, children, synchronous, written, ownedBootstrap,
    dialogs, outbound, browser, requests, context, run, cap, channelEpoch, logHandles, guardians, leaseChildren,
    safeStorage, realLifecycle, get quitCount() { return quitCount; },
    start: () => run('withRuntimeOperation(startApplication)'),
    shutdown: () => run('shutdownRuntime()'),
    rendererEvent: () => ({ sender: browser[0].webContents, senderFrame: browser[0].webContents.mainFrame }),
  };
  t.after(async () => {
    for (const item of children) item.child.killMode = 'normal';
    await run('stopRuntime()').catch(() => {});
    for (const item of children) if (item.child.exitCode == null && item.child.signalCode == null) item.child.kill('SIGTERM');
    await Promise.resolve(); await gateway?.close().catch(() => {}); await runtimeLifecycle?.close().catch(() => {});
    for (const item of leaseChildren) item.child.kill('SIGKILL');
    for (const provider of nativeProviders) await provider.close().catch(() => {});
    for (const handle of logHandles) try { fs.closeSync(handle); } catch {}
    await fsp.rm(root, { recursive: true, force: true });
  });
  return result;
}

async function seedRecovery(h, { postgres = true } = {}) {
  const secrets = await h.realLifecycle.loadDesktopSecrets({ userData: h.paths.userData, safeStorage: h.safeStorage });
  const existing = await h.realLifecycle.openSafetyLifecycle({ userData: h.paths.userData, safeStorage: h.safeStorage,
    installationId: secrets.localIdentity, runningBuild: '100' });
  await existing.close();
  if (postgres) {
    await fsp.mkdir(path.join(h.paths.userData, 'postgres'), { mode: 0o700 });
    await fsp.writeFile(path.join(h.paths.userData, 'postgres', 'PG_VERSION'), '16', { mode: 0o600 });
  }
  await fsp.mkdir(path.join(h.paths.userData, 'backup-maintenance'), { mode: 0o700 });
  await fsp.writeFile(path.join(h.paths.userData, 'backup-maintenance', 'synthetic-preserved-record'),
    'not a real maintenance authority', { mode: 0o600 });
}

async function flushStopDeadlines(h, operation) {
  // Advance only main's synthetic child-stop deadlines, never a real clock or process.
  let settled = false;
  operation.then(() => { settled = true; }, () => { settled = true; });
  const deadline = Date.now() + 5000;
  while (!settled && Date.now() < deadline) {
    await Promise.resolve(); await delay(1);
    for (const timer of [...h.timers]) if (timer.delay === 5000) { h.timers.delete(timer); timer.fn(); }
  }
  assert.equal(settled, true, 'synthetic shutdown did not settle after both stop deadlines');
}

test('actual main startup passes fresh enrollment before paths file and private bootstrap only to backend stdin', async t => {
  const h = await harness(t); await h.start(); await Promise.resolve();
  assert.equal(h.run('runtime.ready'), true); assert.equal(h.controls.gatewayOptions.freshEnrollmentAllowed, true);
  assert.equal(fs.existsSync(path.join(h.paths.userData, 'authorized-paths.enc')), true);
  assert.ok(h.events.indexOf('gateway.open') < h.events.indexOf('spawn.postgres'));
  assert.ok(h.events.indexOf('spawn.java') < h.events.indexOf('window.create'));
  assert.equal(h.written.length, 1); const data = JSON.parse(h.written[0]); assert.equal(data.capability, h.cap);
  assert.equal(h.ownedBootstrap.length, 1); assert.deepEqual(h.ownedBootstrap[0], Buffer.alloc(h.ownedBootstrap[0].length));
  const backend = h.children.find(value => path.basename(value.command) === 'java');
  assert.equal(backend.options.stdio[0], 'pipe'); assert.equal(backend.options.env.APP_DESKTOP_AI_BOOTSTRAP_STDIN, 'true');
  assert.equal(backend.options.env.GITHUB_NATIVE_CLIENT_ID, 'public-native-client');
  for (const child of h.children) {
    assert.doesNotMatch(JSON.stringify({ args: child.args, env: child.options.env }), new RegExp(`${h.cap}|${h.channelEpoch}|private/ai.sock|host-provider-sentinel|host-node-sentinel|host-java-sentinel|host-github-sentinel`));
    if (child !== backend) { assert.equal(child.options.stdio[0], 'ignore'); assert.equal(child.options.env.TOKEN_ENC_KEY, undefined); }
  }
  const event = h.rendererEvent(); h.handlers.get('runtime:config')(event);
  assert.deepEqual(Object.keys(event.returnValue).sort(), ['apiBaseUrl', 'apiToken']);
  assert.doesNotMatch(JSON.stringify({ config: event.returnValue, status: h.handlers.get('runtime:status')(event), outbound: h.outbound }),
    new RegExp(`${h.cap}|${h.channelEpoch}|private/ai.sock|tokenEncryptionKey`));
  assert.equal([...h.handlers.keys()].some(name => /activate|gateway|settle|enrollment|permit/.test(name)), false);
});

test('a manifest without backup protocol retains the guard before dialogs or backup constructor work', async t => {
  const h = await harness(t, { selection: '/synthetic/unused-selection' }); await h.start();
  assert.equal(h.run('runtime.ready'), true);
  const status = h.handlers.get('runtime:status')(h.rendererEvent());
  assert.equal(status.backupAvailable, false); assert.equal(status.restoreAvailable, false);
  assert.equal(h.events.includes('backup.open'), false); assert.equal(h.controls.backupOptions, undefined);
  const before = [...h.events];
  await assert.rejects(h.handlers.get('data:backup')(h.rendererEvent()), /Backup is unavailable/);
  await assert.rejects(h.handlers.get('data:restore')(h.rendererEvent()), /Restore is unavailable/);
  assert.deepEqual(h.events, before); assert.deepEqual(h.dialogs, []);
  assert.equal(h.run('runtime.ready'), true);
});

test('PostgreSQL origin rejection after readiness prevents database and extension SQL mutations', async t => {
  const h = await harness(t, { verifyOrigin: async () => { throw new Error('synthetic origin mismatch'); } });
  await h.start(); await h.shutdown();
  assert.equal(h.run('runtime.ready'), false); assert.equal(h.run('runtime.recoveryRequired'), true);
  assert.equal(h.browser.length, 0);
  assert.ok(h.events.indexOf('run.pg_isready') < h.events.indexOf('product.verifyOrigin'));
  assert.equal(h.synchronous.some(item => ['psql', 'createdb'].includes(path.basename(item.command))), false);
  assert.equal(h.children.length, 1); assert.equal(path.basename(h.children[0].command), 'postgres');
  assert.equal(h.children[0].child.signalCode, 'SIGTERM'); assert.ok(h.events.includes('product.close'));
  const supplied = h.controls.productOptions[0];
  assert.equal(supplied.ownedPostgres, h.children[0].child);
  assert.equal(supplied.expectedDataDirectory, path.join(h.paths.userData, 'postgres'));
  assert.equal(supplied.dataRoot, path.join(h.paths.userData, 'data'));
  assert.equal(supplied.connection.host, '127.0.0.1'); assert.equal(supplied.connection.port, h.run('runtime.ports.postgres'));
});

test('successful origin proof is awaited before the first SQL query', async t => {
  const gate = deferred(); const h = await harness(t, { verifyOrigin: () => gate.promise }); const started = h.start();
  try {
    await reached(() => h.events.includes('product.verifyOrigin'));
    assert.equal(h.synchronous.some(item => path.basename(item.command) === 'psql'), false);
    assert.equal(h.browser.length, 0);
  } finally { gate.resolve(); }
  await started;
  assert.equal(h.run('runtime.ready'), true);
  assert.ok(h.events.indexOf('product.close') < h.events.indexOf('run.psql'));
});

test('protocol3 connects backup inside lifecycle without leaking keys, ports or proofs to renderer', async t => {
  const h = await harness(t, { backupProtocol: 3 }); await h.start();
  assert.equal(h.run('runtime.ready'), true); assert.ok(h.controls.backupOptions);
  assert.ok(h.events.indexOf('gateway.open') < h.events.indexOf('backup.open'));
  assert.ok(h.events.indexOf('backup.open') < h.events.indexOf('spawn.postgres'));
  const value = h.controls.backupOptions;
  assert.equal(value.userData, h.paths.userData); assert.equal(value.runningBuild, '100');
  assert.deepEqual(Object.keys(value.keyProvider).sort(), ['currentKeyId', 'getBackupKey']);
  assert.deepEqual(Object.keys(value.journal).sort(), ['completeMaintenance', 'sealMaintenance', 'snapshot']);
  assert.deepEqual(Object.keys(value.ports).sort(), ['capacityRoots', 'database', 'exportVault', 'failure', 'invalidateAuthority', 'openExport',
    'openStage', 'pause', 'prepareResume', 'productState', 'restoreVault', 'resume', 'sourceReader', 'sourceWorker']);
  assert.equal(typeof h.controls.gatewayOptions.verifyMaintenanceSeal, 'function');
  assert.equal(typeof h.controls.gatewayOptions.verifyMaintenanceCompletion, 'function');
  const event = h.rendererEvent(); h.handlers.get('runtime:config')(event);
  const status = h.handlers.get('runtime:status')(event);
  assert.equal(status.backupAvailable, true); assert.equal(status.restoreAvailable, true);
  assert.deepEqual(Object.keys(event.returnValue).sort(), ['apiBaseUrl', 'apiToken']);
  assert.doesNotMatch(JSON.stringify({ config: event.returnValue, status, outbound: h.outbound }), /keyProvider|getBackupKey|sealMaintenance|sourceWorker|installationId|private\/ai/);
});

test('protocol3 backup constructor failure closes gateway and keys before any child starts', async t => {
  const h = await harness(t, { backupProtocol: 3, openBackup: async () => { throw new Error('synthetic backup initialization failure'); } });
  await h.start(); await h.shutdown();
  assert.equal(h.children.length, 0); assert.equal(h.browser.length, 0); assert.equal(h.run('runtime.recoveryRequired'), true);
  assert.ok(h.events.includes('gateway.closed')); assert.ok(h.events.includes('adapter.close'));
});

test('lifecycle shutdown waits for backup resource closure before gateway and adapter closure', async t => {
  const gate = deferred(); const h = await harness(t, { backupProtocol: 3, closeBackup: () => gate.promise }); await h.start();
  const at = h.events.length, closing = h.shutdown();
  try {
    await reached(() => h.events.slice(at).includes('backup.close'));
    const held = h.events.slice(at);
    assert.equal(held.filter(item => item.startsWith('kill.')).length, 4);
    assert.equal(held.includes('gateway.close'), false); assert.equal(held.includes('adapter.close'), false);
  } finally { gate.resolve(); }
  await closing;
  const completed = h.events.slice(at);
  assert.ok(completed.indexOf('backup.close') < completed.indexOf('gateway.close'));
  assert.ok(completed.indexOf('gateway.closed') < completed.indexOf('adapter.close'));
});

test('BEGIN drain polling completes before AI drain and stops only backend/analyzer afterwards', async t => {
  const ai = deferred(); const h = await harness(t, { backupProtocol: 3 }); await h.start();
  const id = crypto.randomUUID(); let count = 0;
  h.controls.fetch = async (url, config) => {
    if (new URL(url).pathname !== '/api/desktop/maintenance') return;
    const command = JSON.parse(config.body); h.events.push(`maintenance.${command.operation}`);
    const body = { transactionId: id, state: ++count === 1 ? 'DRAINING' : 'DRAINED',
      activeRequests: count === 1 ? 1 : 0, activeWriters: 0, activeJobs: 0 };
    return { ok: true, json: async () => body };
  };
  const at = h.events.length;
  const pause = h.controls.backupOptions.ports.pause({ transactionId: id, waitForAiDrain: async () => {
    h.events.push('ai.drain.begin'); await ai.promise; h.events.push('ai.drain.complete');
  } });
  await reached(() => [...h.timers].some(timer => timer.delay === 200));
  assert.equal(h.events.slice(at).some(item => item.startsWith('kill.')), false);
  assert.equal(h.events.includes('ai.drain.begin'), false);
  for (const timer of [...h.timers]) if (timer.delay === 200) { h.timers.delete(timer); timer.fn(); }
  await reached(() => h.events.includes('ai.drain.begin'));
  assert.equal(h.events.slice(at).some(item => item.startsWith('kill.')), false);
  ai.resolve(); await pause;
  const events = h.events.slice(at);
  assert.ok(events.indexOf('maintenance.BEGIN') < events.indexOf('maintenance.STATUS'));
  assert.ok(events.indexOf('maintenance.STATUS') < events.indexOf('ai.drain.begin'));
  assert.ok(events.indexOf('ai.drain.complete') < events.indexOf('kill.java.SIGTERM'));
  assert.ok(events.indexOf('kill.java.SIGTERM') < events.indexOf('kill.electron.SIGTERM'));
  assert.equal(events.includes('kill.postgres.SIGTERM'), false); assert.equal(events.includes('kill.redis-server.SIGTERM'), false);
  assert.equal(h.run('runtime.ready'), false);
  const commands = h.requests.filter(item => new URL(item.url).pathname === '/api/desktop/maintenance');
  assert.deepEqual(commands.map(item => JSON.parse(item.config.body)), [{ transactionId: id, operation: 'BEGIN' }, { transactionId: id, operation: 'STATUS' }]);
});

test('main constructs fixed database/source/vault ports and closes vaults on stream failures', async t => {
  const h = await harness(t, { backupProtocol: 3 }); await h.start(); const ports = h.controls.backupOptions.ports;
  assert.deepEqual(clone(await ports.capacityRoots()), { postgres: path.join(h.paths.userData, 'postgres'),
    source: path.join(h.paths.userData, 'data'), bundle: path.join(h.root, 'resources', 'runtime') });
  const exported = await ports.openExport();
  assert.equal(h.controls.backupPostgresOptions.connection.database, 'codeintel');
  assert.equal(h.controls.backupPostgresOptions.mode, 'export');
  assert.equal(h.controls.backupPostgresOptions.migrationRoot, path.join(h.root, 'resources/runtime/backend/backup-migrations'));
  assert.equal(h.controls.backupPostgresOptions.env.PGPASSWORD, h.run('runtime.secrets.databasePassword')); await exported.close();
  const stage = await ports.openStage('ci_stage_synthetic');
  assert.equal(h.controls.backupPostgresOptions.connection.database, 'ci_stage_synthetic');
  assert.equal(h.controls.backupPostgresOptions.mode, 'staging'); await stage.close();
  const database = await ports.database();
  assert.equal(h.controls.databaseOptions.liveDatabase, 'codeintel');
  assert.equal(h.controls.databaseOptions.connection.host, '127.0.0.1');
  assert.equal(h.controls.databaseOptions.connection.port, h.run('runtime.ports.postgres')); await database.close();
  const source = await ports.sourceWorker();
  assert.deepEqual(Object.keys(h.controls.sourceWorkerOptions).sort(), ['jarPath', 'javaPath']);
  assert.equal(h.controls.sourceWorkerOptions.javaPath, path.join(h.root, 'resources/runtime/jre/bin/java'));
  assert.equal(h.controls.sourceWorkerOptions.jarPath, path.join(h.root, 'resources/runtime/backend/code-intelligence.jar')); await source.close();
  assert.doesNotMatch(JSON.stringify([h.controls.backupPostgresOptions.env, h.controls.databaseOptions.env]), /host-provider|host-node|host-java|host-github/);

  const packet = { envelope: Buffer.from('public synthetic encrypted envelope') }; h.controls.exportCiphertext = async () => packet;
  const beforeExport = h.events.length;
  await assert.rejects(ports.exportVault([{ projectId: '7' }], async value => {
    assert.equal(value, packet); throw new Error('synthetic sink failure');
  }), /synthetic sink failure/);
  assert.deepEqual(h.events.slice(beforeExport), ['vault.open', 'vault.exportCiphertext', 'vault.close']);
  assert.equal(h.controls.vaultOptions.at(-1).sourceRoot, path.join(h.paths.userData, 'data', 'sources'));
  assert.equal(h.controls.vaultOptions.at(-1).safetyRoot, path.join(h.paths.userData, 'safety'));
  const destination = path.join(h.paths.userData, 'recovery', crypto.randomUUID(), 'sources');
  h.controls.importCiphertext = async () => { throw new Error('synthetic capsule failure'); };
  const beforeImport = h.events.length;
  await assert.rejects(ports.restoreVault(destination, (async function* () { yield packet; })()), /synthetic capsule failure/);
  assert.deepEqual(h.events.slice(beforeImport), ['vault.restore', 'vault.importCiphertext', 'vault.close']);
  assert.equal(h.controls.vaultOptions.at(-1).sourceRoot, destination);
  packet.envelope.fill(0);
});

test('restore authority invalidation preserves old sessions, revokes grants and rotates tokens before restart/reload', async t => {
  const storage = deferred(); const h = await harness(t, { backupProtocol: 3, clearStorage: () => storage.promise }); await h.start();
  const ports = h.controls.backupOptions.ports, transactionId = crypto.randomUUID();
  const checkpointRoot = path.join(h.paths.userData, 'recovery', transactionId);
  await fsp.mkdir(checkpointRoot, { recursive: true, mode: 0o700 });
  const redis = path.join(h.paths.userData, 'redis'); const originalRedis = await fsp.stat(redis, { bigint: true });
  await fsp.writeFile(path.join(redis, 'session-fixture'), 'old synthetic session', { mode: 0o600 });
  h.run("runtime.authorizedRoots = ['/synthetic/old-project']; saveEncryptedJson(runtime.pathsFile, runtime.authorizedRoots)");
  const oldApi = h.run('runtime.apiToken'), oldPath = h.run('runtime.pathToken');
  await ports.pause({ transactionId, waitForAiDrain: async () => {} });
  const at = h.events.length, invalidated = ports.invalidateAuthority({ transactionId, checkpointRoot });
  try {
    await reached(() => h.events.slice(at).includes('session.clearStorage'));
    assert.ok(h.events.slice(at).indexOf('kill.redis-server.SIGTERM') < h.events.slice(at).indexOf('session.clearStorage'));
    assert.equal(h.events.slice(at).includes('session.clearCache'), false);
    assert.equal(h.events.slice(at).some(item => item.startsWith('spawn.')), false);
    assert.deepEqual(clone(h.run('runtime.authorizedRoots')), []);
    assert.deepEqual(clone(h.run("encryptedJson(runtime.pathsFile, () => {throw new Error('missing grants')})")), []);
    assert.notEqual(h.run('runtime.apiToken'), oldApi); assert.notEqual(h.run('runtime.pathToken'), oldPath);
    assert.equal(await fsp.readFile(path.join(checkpointRoot, 'previous-redis', 'session-fixture'), 'utf8'), 'old synthetic session');
    assert.equal((await fsp.stat(path.join(checkpointRoot, 'previous-redis'), { bigint: true })).ino, originalRedis.ino);
    assert.deepEqual(await fsp.readdir(redis), []);
    assert.equal(h.run('runtime.ready'), false); assert.equal(h.events.filter(item => item === 'window.load').length, 1);
  } finally { storage.resolve(); }
  await invalidated;
  assert.ok(h.events.indexOf('session.clearStorage') < h.events.indexOf('session.clearCache'));
  await ports.prepareResume({ transactionId });
  const backend = h.children.filter(item => path.basename(item.command) === 'java').at(-1);
  assert.equal(backend.options.env.APP_DESKTOP_MAINTENANCE_STARTUP_ID, transactionId);
  assert.equal(backend.options.env.DESKTOP_API_TOKEN, h.run('runtime.apiToken'));
  assert.equal(backend.options.env.DESKTOP_PATH_TOKEN, h.run('runtime.pathToken'));
  assert.notEqual(backend.options.env.DESKTOP_API_TOKEN, oldApi); assert.notEqual(backend.options.env.DESKTOP_PATH_TOKEN, oldPath);
  assert.equal(h.run('runtime.ready'), false); assert.equal(h.events.filter(item => item === 'window.load').length, 1);
  assert.equal(h.requests.some(item => new URL(item.url).pathname === '/api/desktop/paths'), false);
  await ports.resume({ transactionId, restored: true });
  assert.equal(h.run('runtime.ready'), true); assert.equal(h.events.filter(item => item === 'window.load').length, 2);
  assert.equal(h.requests.some(item => new URL(item.url).pathname === '/api/desktop/paths'), false);
  const event = h.rendererEvent(); h.handlers.get('runtime:config')(event); assert.notEqual(event.returnValue.apiToken, oldApi);
  const end = h.requests.filter(item => new URL(item.url).pathname === '/api/desktop/maintenance').at(-1);
  assert.equal(JSON.parse(end.config.body).operation, 'END');
  assert.equal(end.config.headers['X-Code-Intelligence-Path-Token'], h.run('runtime.pathToken'));
});

test('backup reauthorizes prior folder grants only after prepared backend and END completion', async t => {
  const h = await harness(t, { backupProtocol: 3 }); await h.start();
  const ports = h.controls.backupOptions.ports, transactionId = crypto.randomUUID();
  const approved = path.join(h.paths.temp, 'approved-folder'); await fsp.mkdir(approved, { mode: 0o700 });
  h.context.fixtureApproved = approved; h.run('runtime.authorizedRoots = [fixtureApproved]');
  await ports.pause({ transactionId, waitForAiDrain: async () => {} });
  await ports.prepareResume({ transactionId });
  assert.equal(h.requests.some(item => new URL(item.url).pathname === '/api/desktop/paths'), false);
  assert.equal(h.run('runtime.ready'), false);
  await ports.resume({ transactionId, restored: false });
  const end = h.events.lastIndexOf('maintenance.END'), grant = h.events.indexOf('fetch./api/desktop/paths');
  assert.ok(end >= 0 && grant > end); assert.equal(h.run('runtime.ready'), true);
  const selected = h.requests.find(item => new URL(item.url).pathname === '/api/desktop/paths');
  assert.deepEqual(JSON.parse(selected.config.body), { path: approved });
});

test('prepared backend with outstanding work cannot release maintenance or show a restored window', async t => {
  const h = await harness(t, { backupProtocol: 3 }); await h.start();
  const ports = h.controls.backupOptions.ports, transactionId = crypto.randomUUID();
  await ports.pause({ transactionId, waitForAiDrain: async () => {} });
  h.controls.fetch = async (url, config) => {
    if (new URL(url).pathname !== '/api/desktop/maintenance') return;
    const command = JSON.parse(config.body);
    return { ok: true, json: async () => ({ transactionId: command.transactionId, state: 'DRAINING', activeRequests: 0, activeWriters: 0, activeJobs: 1 }) };
  };
  await assert.rejects(ports.prepareResume({ transactionId }), /startup checks/);
  assert.equal(h.run('runtime.ready'), false); assert.equal(h.events.filter(item => item === 'window.load').length, 1);
  assert.equal(h.requests.some(item => item.config?.body && JSON.parse(item.config.body).operation === 'END'), false);
  await ports.failure(); assert.equal(h.run('runtime.recoveryRequired'), true);
  await assert.rejects(ports.resume({ transactionId, restored: true }), { code: 'SAFETY_RECOVERY_REQUIRED' });
});

test('an unbound authority checkpoint is rejected before stopping Redis or changing tokens/grants', async t => {
  const h = await harness(t, { backupProtocol: 3 }); await h.start(); const ports = h.controls.backupOptions.ports;
  const before = h.events.length, oldApi = h.run('runtime.apiToken'), oldPath = h.run('runtime.pathToken');
  const oldGrants = await fsp.readFile(path.join(h.paths.userData, 'authorized-paths.enc'));
  await assert.rejects(ports.invalidateAuthority({ transactionId: crypto.randomUUID(), checkpointRoot: '/synthetic/unbound-stage' }),
    { code: 'SAFETY_RECOVERY_REQUIRED' });
  assert.deepEqual(h.events.slice(before), []); assert.equal(h.run('children.size'), 4);
  assert.equal(h.run('runtime.apiToken'), oldApi); assert.equal(h.run('runtime.pathToken'), oldPath);
  assert.deepEqual(await fsp.readFile(path.join(h.paths.userData, 'authorized-paths.enc')), oldGrants);
});

test('failed renderer storage clearing never starts a replacement backend or reloads the window', async t => {
  const h = await harness(t, { backupProtocol: 3, clearStorage: async () => { throw new Error('synthetic session clearing failure'); } });
  await h.start(); const ports = h.controls.backupOptions.ports, transactionId = crypto.randomUUID();
  const checkpointRoot = path.join(h.paths.userData, 'recovery', transactionId);
  await fsp.mkdir(checkpointRoot, { recursive: true, mode: 0o700 });
  await ports.pause({ transactionId, waitForAiDrain: async () => {} }); const count = h.children.length;
  await assert.rejects(ports.invalidateAuthority({ transactionId, checkpointRoot }), /session clearing failure/);
  assert.equal(h.children.length, count); assert.equal(h.events.includes('session.clearCache'), false);
  assert.equal(h.run('runtime.ready'), false); assert.equal(h.events.filter(item => item === 'window.load').length, 1);
  assert.deepEqual(clone(h.run('runtime.authorizedRoots')), []);
  assert.ok((await fsp.lstat(path.join(checkpointRoot, 'previous-redis'))).isDirectory());
  await ports.failure(); await assert.rejects(ports.resume({ transactionId, restored: true }), { code: 'SAFETY_RECOVERY_REQUIRED' });
  assert.equal(h.requests.some(item => item.config?.body && JSON.parse(item.config.body).operation === 'END'), false);
});

test('backup/restore IPC uses the native selection and stays serialized without accepting renderer authority', async t => {
  const held = deferred(), selections = [];
  const h = await harness(t, { backupProtocol: 3, selection: '/synthetic/native-selection',
    performBackup: async (_options, selected) => { selections.push(['backup', selected]); await held.promise; return 'synthetic result'; },
    performRestore: async (_options, selected) => { selections.push(['restore', selected]); return { restored: true }; } });
  await h.start();
  const untrusted = { selected: '/synthetic/renderer-selected', verified: true, keyProvider: 'private-fake-proof' };
  const backup = h.handlers.get('data:backup')(h.rendererEvent(), untrusted);
  const restore = h.handlers.get('data:restore')(h.rendererEvent(), untrusted);
  try {
    await reached(() => selections.length === 1);
    assert.deepEqual(selections, [['backup', '/synthetic/native-selection']]);
    assert.equal(h.dialogs.filter(item => item.kind === 'open').length, 1);
  } finally { held.resolve(); }
  assert.equal(await backup, 'synthetic result'); assert.deepEqual(await restore, { restored: true });
  assert.deepEqual(selections, [['backup', '/synthetic/native-selection'], ['restore', '/synthetic/native-selection']]);
  assert.equal(h.dialogs.filter(item => item.kind === 'open').length, 2);
});

test('active gateway diagnostics reach runtime status truthfully without blocking local runtime', async t => {
  const h = await harness(t); await h.start(); h.controls.active = true;
  assert.equal(h.run('publicRuntimeStatus().aiOff'), false); assert.equal(h.run('publicRuntimeStatus().recoveryOnly'), false);
  assert.doesNotThrow(() => h.run('assertSafetyReady()'));
  await h.run("latchSafety('USER_OFF')"); assert.equal(h.run('publicRuntimeStatus().aiOff'), true);
});

test('normal shutdown latches, terminates all children, closes gateway/safety, then closes adapter', async t => {
  const h = await harness(t); await h.start(); const at = h.events.length;
  const first = h.shutdown(); assert.equal(first, h.shutdown()); await first;
  const events = h.events.slice(at); const latch = events.indexOf('gateway.latch');
  const kills = events.map((v, i) => v.startsWith('kill.') ? i : -1).filter(i => i >= 0);
  assert.equal(kills.length, 4); assert.ok(kills.every(i => i > latch));
  assert.ok(events.indexOf('gateway.close') > Math.max(...kills));
  assert.ok(events.indexOf('gateway.closed') < events.indexOf('adapter.close'));
  assert.equal(h.run('children.size'), 0); assert.equal(h.logHandles.size, 0);
});

for (const phase of ['adapterFailure', 'gatewayFailure']) test(`startup ${phase} is closed and never launches a child/window`, async t => {
  const h = await harness(t, { [phase]: true }); await h.start(); await h.shutdown();
  assert.equal(h.children.length, 0); assert.equal(h.browser.length, 0); assert.equal(h.run('runtime.recoveryRequired'), true);
  assert.equal(h.dialogs.length > 0, true); if (phase === 'gatewayFailure') assert.equal(h.events.includes('adapter.close'), true);
});
for (const buildSequence of [undefined, '01', '-1', '9223372036854775808']) test(`invalid build ${String(buildSequence)} stops before secrets/gateway/adapter`, async t => {
  const h = await harness(t, { buildSequence }); await h.start(); await h.shutdown();
  assert.equal(h.events.includes('secrets.load'), false); assert.equal(h.events.includes('adapter.open'), false);
  assert.equal(h.children.length, 0); assert.equal(fs.existsSync(path.join(h.paths.userData, 'secrets.enc')), false);
});

test('stdin async error zeroes bootstrap and kills the owning backend without leaking to renderer', async t => {
  const h = await harness(t, { stdinMode: 'delayed' }); await h.start();
  const backend = h.children.find(value => path.basename(value.command) === 'java');
  assert.notEqual(h.ownedBootstrap[0].some(byte => byte !== 0), false);
  backend.child.stdin.emit('error', new Error('synthetic EPIPE')); await Promise.resolve();
  assert.deepEqual(h.ownedBootstrap[0], Buffer.alloc(h.ownedBootstrap[0].length));
  assert.equal(backend.child.signalCode, 'SIGTERM'); assert.doesNotMatch(JSON.stringify(h.outbound), new RegExp(h.cap));
});

test('stdin error plus synchronous kill failure does not escape its handler or lose a live child', async t => {
  const h = await harness(t, { stdinMode: 'delayed' }); await h.start();
  const backend = h.children.find(value => path.basename(value.command) === 'java'); backend.child.killMode = 'throw';
  assert.doesNotThrow(() => backend.child.stdin.emit('error', new Error('synthetic EPIPE')));
  assert.deepEqual(h.ownedBootstrap[0], Buffer.alloc(h.ownedBootstrap[0].length));
  assert.equal(h.run("children.has('backend')"), true); assert.equal(backend.child.signalCode, null);
});

test('a post-spawn child error is not proof of exit and must retain child ownership', async t => {
  const h = await harness(t); await h.start(); const backend = h.children.find(value => path.basename(value.command) === 'java');
  backend.child.emit('error', new Error('synthetic failed-signal error'));
  assert.equal(h.run("children.has('backend')"), true); assert.equal(backend.child.exitCode, null); assert.equal(backend.child.signalCode, null);
});

test('failed child termination blocks restart and keeps gateway/adapter owned', async t => {
  const h = await harness(t); await h.start(); const backend = h.children.find(value => path.basename(value.command) === 'java'); backend.child.killMode = 'throw';
  const count = h.children.length;
  await assert.rejects(h.handlers.get('runtime:restart')(h.rendererEvent()), /kill failure/);
  assert.equal(h.children.length, count); assert.equal(h.run("children.has('backend')"), true);
  assert.equal(h.events.includes('gateway.close'), false); assert.equal(h.events.includes('adapter.close'), false);
  await assert.rejects(h.shutdown(), /safety state requires offline recovery/i);
  assert.equal(h.events.includes('gateway.close'), false); assert.equal(h.events.includes('adapter.close'), false);
});

test('healthy backend restart sends a new owned bootstrap Buffer only after old children exit', async t => {
  const h = await harness(t); await h.start(); const previous = [...h.children];
  await h.handlers.get('runtime:restart')(h.rendererEvent()); await Promise.resolve();
  assert.equal(h.children.length, 8); assert.equal(previous.every(item => item.child.signalCode !== null), true);
  assert.equal(h.written.length, 2); assert.notEqual(h.ownedBootstrap[0], h.ownedBootstrap[1]);
  assert.deepEqual(h.ownedBootstrap[1], Buffer.alloc(h.ownedBootstrap[1].length));
  assert.equal(h.run('runtime.ready'), true); assert.equal(h.run('publicRuntimeStatus().aiOff'), true);
});

test('synchronous bootstrap stdin failure zeroes/kills and prevents startup from reporting ready', async t => {
  const h = await harness(t, { stdinMode: 'throw' }); await h.start(); await Promise.resolve();
  const backend = h.children.find(value => path.basename(value.command) === 'java');
  assert.ok(backend); assert.deepEqual(h.ownedBootstrap[0], Buffer.alloc(h.ownedBootstrap[0].length));
  assert.equal(backend.child.signalCode, 'SIGTERM');
  assert.equal(h.run('runtime.ready'), false); assert.equal(h.browser.length, 0);
  await h.shutdown(); assert.equal(h.events.includes('gateway.closed'), true); assert.equal(h.events.includes('adapter.close'), true);
});

test('repeated post-spawn errors cannot become an unhandled EventEmitter error or release ownership', async t => {
  const h = await harness(t); await h.start(); const backend = h.children.find(value => path.basename(value.command) === 'java');
  for (let index = 0; index < 3; index++) assert.doesNotThrow(() => backend.child.emit('error', new Error('synthetic repeated signal failure')));
  await Promise.resolve(); assert.equal(h.run("children.has('backend')"), true); assert.equal(h.run('runtime.ready'), false);
  assert.equal(h.run('runtime.recoveryRequired'), true); assert.equal(h.timers.size, 0);
  assert.equal(h.events.includes('gateway.close'), false); assert.equal(h.events.includes('adapter.close'), false);
});

for (const ownershipProtocol of [undefined, 0, 2, '1', null]) {
  test(`backup protocol3 rejects absent or unsupported ownership ${String(ownershipProtocol)} before identity or service work`, async t => {
    const h = await harness(t, { backupProtocol: 3, ownershipProtocol }); await h.start(); await h.shutdown();
    assert.equal(h.events.includes('secrets.load'), false); assert.equal(h.events.includes('ownerLocks.open'), false);
    assert.equal(h.children.length, 0); assert.equal(h.leaseChildren.length, 0); assert.equal(h.browser.length, 0);
    assert.equal(fs.existsSync(path.join(h.paths.userData, 'secrets.enc')), false);
    assert.match(h.dialogs[0][1], /ownership protocol/);
  });
}

test('owned protocol startup binds one native provider and guardians before any product service is admitted', async t => {
  const h = await harness(t, { backupProtocol: 3 }); await h.start();
  assert.equal(h.run('runtime.ready'), true); assert.equal(h.guardians.length, 4); assert.equal(h.leaseChildren.length, 2);
  assert.ok(h.events.indexOf('ownerLocks.open') < h.events.indexOf('safety.open'));
  assert.ok(h.events.indexOf('lease.acquire.ai-journal') < h.events.indexOf('spawn.postgres'));
  assert.equal(h.controls.safetyOptions[0].ownerLocks, h.controls.ownerProvider);
  assert.equal(h.controls.ownerLockOptions.assertMainOwnership(), true);
  for (const value of h.guardians) {
    assert.equal(value.javaPath, path.join(h.root, 'resources/runtime/jre/bin/java'));
    assert.equal(value.jarPath, path.join(h.root, 'resources/runtime/backend/code-intelligence.jar'));
    assert.equal(path.dirname(value.logPath), path.join(h.paths.logs, 'runtime'));
    assert.equal(value.child.stdin, undefined);
    assert.doesNotMatch(JSON.stringify({ args: value.args, env: value.env }), /host-provider|host-node|host-java|host-github/);
  }
  assert.equal(h.ownedBootstrap[0].every(byte => byte === 0), true);
  assert.equal(h.logHandles.size, 0);
  const reader = await h.controls.backupOptions.ports.sourceReader();
  assert.deepEqual(Object.keys(reader).sort(), ['close', 'read']);
  assert.equal(h.controls.vaultOptions.at(-1).ownerLocks, h.controls.ownerProvider); await reader.close();
  await h.shutdown();
  assert.equal(h.run('children.size'), 0);
  assert.equal(h.events.filter(value => value === 'lease.release.ai-journal').length, 1);
  assert.equal(h.events.filter(value => value === 'lease.release.purpose-keyring').length, 1);
});

test('loss of native ownership closes admission synchronously and stops every synthetic service without restart', async t => {
  const h = await harness(t, { backupProtocol: 3 }); await h.start(); h.controls.active = true;
  const count = h.children.length;
  h.controls.singleton = false;
  assert.equal(h.controls.ownerLockOptions.assertMainOwnership(), false);
  const stopped = h.controls.ownerLockOptions.onLost();
  assert.equal(h.run('runtime.ready'), false); assert.equal(h.run('runtime.recoveryRequired'), true);
  await assert.rejects(h.handlers.get('runtime:restart')(h.rendererEvent()), /recovery/);
  await stopped; await Promise.resolve();
  assert.equal(h.children.length, count); assert.equal(h.run('children.size'), 0); assert.equal(h.timers.size, 0);
  assert.equal(h.controls.active, false); assert.equal(h.guardians.every(value => value.child.stopped()), true);
  assert.equal(h.run('publicRuntimeStatus().backupAvailable'), false);
  assert.equal(h.run('publicRuntimeStatus().restoreAvailable'), false);
  // Permit only fixture cleanup of the synthetic native provider, without reopening product work.
  h.controls.singleton = true;
});

test('unexpected native lease helper exit reaches main admission shutdown through the real branded provider', async t => {
  const h = await harness(t, { backupProtocol: 3 }); await h.start(); h.controls.active = true;
  const lease = h.leaseChildren.find(value => value.kind === 'ai-journal');
  assert.ok(lease); const count = h.children.length;
  lease.child.emit('exit', null, 'SIGKILL');
  assert.equal(h.run('runtime.ready'), false); assert.equal(h.run('runtime.recoveryRequired'), true);
  await reached(() => h.run('children.size') === 0 && h.controls.active === false);
  assert.equal(h.children.length, count); assert.equal(h.timers.size, 0);
  await assert.rejects(h.handlers.get('runtime:restart')(h.rendererEvent()), /recovery/);
  assert.equal(h.run('publicRuntimeStatus().recoveryOnly'), true);
});

for (const early of ['exit', 'failure', 'rejection']) {
  test(`guardian ${early} before listener installation cannot admit services or discard its owner`, async t => {
    const h = await harness(t, { backupProtocol: 3, guardianSpawn: async child => {
      if (early === 'exit') child.proveExit(9);
      else {
        child.killMode = 'noExit'; child.failure = new Error('synthetic guardian lost proof');
        if (early === 'rejection') {
          const error = new Error('synthetic guardian startup timeout');
          Object.defineProperty(error, 'managedProcess', { value: child }); throw error;
        }
      }
    } });
    await h.start();
    assert.equal(h.run('runtime.ready'), false); assert.equal(h.run('runtime.recoveryRequired'), true);
    assert.equal(h.children.length, 1); assert.equal(h.browser.length, 0);
    if (early === 'exit') {
      await h.shutdown(); assert.equal(h.run('children.size'), 0);
    } else {
      const closing = h.shutdown(); const failed = assert.rejects(closing, { code: 'SAFETY_RECOVERY_REQUIRED' });
      await flushStopDeadlines(h, closing); await failed;
      assert.equal(h.run("children.has('postgres')"), true);
      assert.equal(h.children[0].child.stopped(), false); assert.equal(h.children[0].child.exitCode, null);
      assert.equal(h.events.includes('safety.close'), false); assert.equal(h.events.includes('adapter.close'), false);
      assert.equal(h.events.some(value => value.startsWith('lease.release.')), false);
    }
  });
}

test('guardian error without a cleanup acknowledgement keeps child and B ownership through failed shutdown', async t => {
  const h = await harness(t, { backupProtocol: 3 }); await h.start();
  const backend = h.guardians.find(value => path.basename(value.command) === 'java').child;
  backend.killMode = 'noExit'; backend.failure = new Error('synthetic guardian SIGKILL'); backend.emit('error', backend.failure);
  assert.equal(h.run('runtime.ready'), false); assert.equal(h.run('runtime.recoveryRequired'), true);
  const closing = h.shutdown(); const failed = assert.rejects(closing, { code: 'SAFETY_RECOVERY_REQUIRED' });
  await flushStopDeadlines(h, closing); await failed;
  assert.equal(h.run("children.has('backend')"), true); assert.equal(backend.exitCode, null); assert.equal(backend.signalCode, null);
  assert.equal(h.events.includes('safety.close'), false); assert.equal(h.events.includes('adapter.close'), false);
  assert.equal(h.events.some(value => value.startsWith('lease.release.')), false);
});

test('interrupted recovery permits only origin-checked PostgreSQL until verified completion and normal B reopen', async t => {
  const held = deferred(); const transactionId = crypto.randomUUID();
  const h = await harness(t, { backupProtocol: 3, confirmation: 0,
    pendingRecovery: () => ({ transactionId, kind: 'RESTORE' }), recover: () => held.promise });
  await seedRecovery(h);
  const beforeMarker = await fsp.readFile(path.join(h.paths.userData, '.safety-enrollment.json'));
  const started = h.start();
  try {
    await reached(() => h.events.includes('backup.recover'));
    assert.equal(h.run('bootRecovery'), true); assert.equal(h.run('runtime.ready'), false);
    assert.deepEqual(h.children.map(item => path.basename(item.command)), ['postgres']);
    assert.equal(h.handlers.size, 0); assert.equal(h.browser.length, 0);
    assert.equal(h.synchronous.some(item => ['initdb', 'psql', 'createdb'].includes(path.basename(item.command))), false);
    assert.ok(h.events.indexOf('product.verifyOrigin') < h.events.indexOf('backup.recover'));
    assert.equal(h.controls.safetyOptions[0].recoveryMode, true);
    assert.equal(h.controls.gatewayOpenOptions[0].recoveryMode, true);
    assert.equal(h.controls.backupOpenOptions[0].recoveryMode, true);
    assert.equal(fs.existsSync(path.join(h.paths.userData, 'authorized-paths.enc')), false);
  } finally { held.resolve(); }
  await started;
  assert.equal(h.run('runtime.ready'), true); assert.equal(h.run('bootRecovery'), false);
  assert.deepEqual(h.controls.safetyOptions.map(value => value.recoveryMode), [true, false]);
  assert.deepEqual(h.controls.backupOpenOptions.map(value => value.recoveryMode), [true, false]);
  const reopen = h.events.lastIndexOf('safety.open'), stoppedPg = h.events.indexOf('kill.postgres.SIGTERM');
  assert.ok(stoppedPg > h.events.indexOf('backup.recover'));
  assert.ok(h.events.indexOf('lease.release.purpose-keyring') < reopen);
  assert.ok(reopen < h.events.indexOf('run.psql')); assert.equal(h.browser.length, 1);
  assert.equal(h.requests.some(item => item.config?.body && JSON.parse(item.config.body).operation === 'END'), false);
  assert.deepEqual(await fsp.readFile(path.join(h.paths.userData, '.safety-enrollment.json')), beforeMarker);
});

test('restricted recovery resume stops check children and never releases the backend maintenance barrier', async t => {
  const transactionId = crypto.randomUUID();
  const h = await harness(t, { backupProtocol: 3, confirmation: 0,
    pendingRecovery: () => ({ transactionId, kind: 'RESTORE' }), recover: async value => {
      await value.ports.pause({ transactionId, recovery: true, waitForAiDrain: async () => {} });
      await value.ports.prepareResume({ transactionId });
      assert.equal(h.run('runtime.ready'), false); assert.equal(h.browser.length, 0);
      assert.equal(h.children.at(-1).options.env.APP_DESKTOP_MAINTENANCE_STARTUP_ID, transactionId);
      await value.ports.resume({ transactionId, restored: true, recovery: true });
      assert.deepEqual(clone(h.run('[...children.keys()]')), ['postgres']);
      assert.equal(h.requests.some(item => item.config?.body && JSON.parse(item.config.body).operation === 'END'), false);
    } });
  await seedRecovery(h); await h.start();
  assert.equal(h.run('runtime.ready'), true); assert.equal(h.browser.length, 1);
  assert.equal(h.controls.gatewayOpenOptions.length, 2);
});

for (const mode of ['declined', 'verification-failure', 'missing-postgres', 'invalid-authority']) {
  test(`interrupted recovery ${mode} cannot open normal B, child writers or renderer`, async t => {
    const h = await harness(t, { backupProtocol: 3, confirmation: mode === 'declined' ? 1 : 0,
      pendingRecovery: () => {
        if (mode === 'invalid-authority') throw new Error('synthetic invalid pending authority');
        return { transactionId: crypto.randomUUID(), kind: 'RESTORE' };
      },
      recover: async () => { throw new Error('synthetic preserved transaction verification failure'); } });
    await seedRecovery(h, { postgres: mode !== 'missing-postgres' });
    const record = path.join(h.paths.userData, 'backup-maintenance', 'synthetic-preserved-record');
    const before = await fsp.readFile(record);
    await h.start(); await h.shutdown();
    assert.equal(h.run('runtime.ready'), false); assert.equal(h.browser.length, 0); assert.equal(h.handlers.size, 0);
    assert.deepEqual(h.controls.safetyOptions.map(value => value.recoveryMode), [true]);
    assert.equal(h.children.some(item => path.basename(item.command) !== 'postgres'), false);
    if (mode === 'invalid-authority') assert.equal(h.children.length, 0);
    assert.equal(h.synchronous.some(item => ['initdb', 'psql', 'createdb'].includes(path.basename(item.command))), false);
    assert.deepEqual(await fsp.readFile(record), before);
    assert.equal(fs.existsSync(path.join(h.paths.userData, 'authorized-paths.enc')), false);
  });
}

test('a recovery directory with no pending authority reopens B normally without a consent dialog or recovery service', async t => {
  const h = await harness(t, { backupProtocol: 3, pendingRecovery: () => null });
  await seedRecovery(h); await h.start();
  assert.equal(h.run('runtime.ready'), true);
  assert.equal(h.dialogs.filter(value => value.kind === 'confirm').length, 0);
  assert.equal(h.events.includes('backup.recover'), false); assert.equal(h.children.length, 4);
  assert.deepEqual(h.controls.safetyOptions.map(value => value.recoveryMode), [true, false]);
});
