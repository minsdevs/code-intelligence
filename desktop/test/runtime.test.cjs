const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { EventEmitter } = require('node:events');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');
const { transportFixture } = require('./fixtures/service-transport.cjs');

// Evaluate the real main process without launching Electron or accessing user data.
function harness(options = {}) {
  const timers = new Set();
  const handlers = new Map();
  const appEvents = new Map();
  const sent = [];
  const spawned = [];
  const synchronous = [];
  const dialogs = [];
  const bootstrapWrites = [];
  const productCalls = [];
  const effects = [];
  // Model only the OS directory boundary; identities survive until removal.
  const ipcDirectories = new Map();
  let nextInode = 1;
  const privateFs = {
    mkdir: async () => {}, realpath: async p => p,
    async mkdtemp(prefix) {
      const directory = prefix + 'fixture-' + nextInode;
      ipcDirectories.set(directory, { dev: 1, ino: nextInode++, mode: 0o700 });
      return directory;
    },
    async chmod(directory, mode) { assert.ok(ipcDirectories.has(directory)); ipcDirectories.get(directory).mode = mode; },
    async lstat(directory) { assert.ok(ipcDirectories.has(directory)); return { ...ipcDirectories.get(directory) }; },
    async rmdir(directory) { assert.ok(ipcDirectories.delete(directory)); },
  };
  const appPaths = { userData: '/test', sessionData: '/test', ...options.appPaths };
  // Constructor boundaries stay synthetic: no socket, PostgreSQL process, or admission is opened.
  const gateway = {
    bootstrap: () => Buffer.from(JSON.stringify({ version: 1, socketPath: '/test/ai.sock',
      capability: 'synthetic-private-gateway-capability', epoch: 'synthetic-epoch' })),
    diagnostics: () => ({ aiOff: true, recoveryOnly: false }),
    async latchOffline() {},
    async close() {},
  };
  const postgres = { async close() {} };
  let quitCalls = 0;
  const disk = { mkdirSync() {}, openSync: () => 1, closeSync() {}, existsSync: () => false, ...options.disk };
  const electron = {
    app: {
      isPackaged: options.isPackaged === true,
      getVersion: () => '0.1.0',
      requestSingleInstanceLock: () => { effects.push(['singleton', { ...appPaths }]); return options.ownsInstance !== false; },
      setName(value) { effects.push(['setName', value]); },
      on: (name, callback) => appEvents.set(name, callback),
      whenReady: () => { effects.push(['whenReady']); return new Promise(() => {}); },
      getPath: name => appPaths[name] || '/test',
      setPath(name, value) { effects.push(['setPath', name, value]); appPaths[name] = value; },
      setAppLogsPath(value) { effects.push(['setAppLogsPath', value]); appPaths.logs = value; },
      exit(code) { effects.push(['exit', code]); },
      quit() { quitCalls++; appEvents.get('before-quit')?.({ preventDefault() {} }); },
    },
    dialog: {
      showErrorBox: (...args) => dialogs.push(args),
      showOpenDialog: async () => { dialogs.push('open'); return { canceled: false, filePaths: ['/synthetic/selection'] }; },
      showMessageBox: async () => { dialogs.push('confirmation'); return { response: 1 }; },
    },
    safeStorage: {
      isEncryptionAvailable() { effects.push(['safeStorage', 'isEncryptionAvailable']); return true; },
      ...Object.fromEntries(['encryptString', 'decryptString'].map(name =>
        [name, () => { effects.push(['safeStorage', name]); assert.fail('Unexpected safeStorage call: ' + name); }])),
    },
    ipcMain: { on: (name, fn) => handlers.set(name, fn), handle: (name, fn) => handlers.set(name, fn) },
  };
  const context = vm.createContext({
    require(name) {
      if (name === 'electron') return electron;
      if (Object.hasOwn(options.modules || {}, name)) return options.modules[name];
      if (name === './runtime-manifest.cjs') return { validateRuntimeManifest: (root, manifest) =>
        require(path.resolve(__dirname, '../src', name)).validateRuntimeManifest(root, manifest,
          { platform: context.process.platform, arch: context.process.arch }) };
      if (name === './safety-lifecycle.cjs') {
        if (options.safetyModule) return options.safetyModule;
        const lifecycle = vm.createContext({ module: { exports: {} }, Buffer, process: context.process,
          require: value => require(value.startsWith('./') ? path.resolve(__dirname, '../src', value) : value) });
        vm.runInContext(fs.readFileSync(path.resolve(__dirname, '../src', name), 'utf8'), lifecycle);
        return lifecycle.module.exports;
      }
      if (name === './service-transport.cjs') return { createServiceTransport: async value => transportFixture(value, context.fetch) };
      if (name === './ai-desktop-gateway.cjs') return { openDesktopAiGateway: async () => gateway };
      if (name === './ai-egress-postgres.cjs') return { createAiEgressPostgres: async () => postgres };
      // Source persistence and sockets are constructor boundaries, not real user stores.
      if (name === './source-vault.cjs') return Object.fromEntries(
        ['createSourceVault', 'openSourceVault', 'openSourceVaultRestoreStage'].map(name => [name, async () => ({ async close() {} })]));
      if (name === './source-broker.cjs') return { createSourceBroker: async () => ({ async close() {} }) };
      if (name === './backup-product-state.cjs') return { createBackupProductState: async value => {
        productCalls.push({ operation: 'open', value });
        return { async verifyOrigin() { productCalls.push({ operation: 'verify' }); await options.verifyOrigin?.(value); },
          async close() { productCalls.push({ operation: 'close' }); } };
      } };
      if (name.startsWith('./')) return require(path.resolve(__dirname, '../src', name));
      if (name === 'node:fs') return disk;
      if (name === 'node:fs/promises') return { ...privateFs, ...options.fsp };
      if (name === 'node:net') return Object.fromEntries(['createServer', 'createConnection'].map(operation =>
        [operation, () => { effects.push(['network', operation]); assert.fail(`Unexpected network call: ${operation}`); }]));
      if (name === 'node:child_process') return {
        spawn(command, args, options) {
          const child = new EventEmitter();
          child.exitCode = null;
          child.signalCode = null;
          if (options.stdio?.[0] === 'pipe') {
            child.stdin = new EventEmitter();
            child.stdin.end = (bytes, callback) => {
              bootstrapWrites.push(Buffer.from(bytes));
              child.stdin.writableEnded = true;
              callback?.();
            };
          }
          child.kill = (signal) => {
            queueMicrotask(() => { child.signalCode = signal; child.emit('exit', null, signal); });
            return true;
          };
          spawned.push({ command, args, options, child });
          return child;
        },
        spawnSync(command, args, options) {
          synchronous.push({ command, args, options });
          return { status: 0, stdout: '1', stderr: '' };
        },
      };
      return require(name);
    },
    process: { env: { ...options.env }, argv: options.argv || [], resourcesPath: options.resourcesPath,
      pid: 42, platform: 'darwin', arch: 'arm64', execPath: '/synthetic/electron', getuid: process.getuid.bind(process) },
    __dirname: path.resolve(__dirname, '../src'),
    Buffer, URL, AbortSignal, console: { ...console, error: (...args) => effects.push(['console.error', ...args]) }, fetch: async (url, value) => {
      sent.push({ url, options: value });
      return options.fetch ? options.fetch(url, value) : { ok: true, json: async () => ({ path: '/selected/project' }) };
    },
    setTimeout: (fn, delay) => { const timer = { fn, delay }; timers.add(timer); return timer; },
    clearTimeout: (timer) => timers.delete(timer),
  });
  const run = (source) => vm.runInContext(source, context);
  const result = { run, context, timers, handlers, appEvents, spawned, synchronous, bootstrapWrites, productCalls, disk, sent, dialogs,
    effects, appPaths, ipcDirectories, get quitCalls() { return quitCalls; } };
  try { vm.runInContext(fs.readFileSync(path.join(__dirname, '../src/main.cjs'), 'utf8'), context); }
  catch (error) {
    if (!options.captureBootstrapError) throw error;
    return { ...result, bootstrapError: error };
  }
  context.fixtureUserData = appPaths.userData;
  context.fixtureIpcRoot = '/test/private-ipc';
  context.fixtureIpcIdentity = { dev: 1, ino: nextInode++, mode: 0o700 };
  ipcDirectories.set(context.fixtureIpcRoot, { ...context.fixtureIpcIdentity });
  run("runtime = { userData: fixtureUserData, ipcRoot: fixtureIpcRoot, ipcIdentity: fixtureIpcIdentity, ready: true, apiToken: 'renderer-token', pathToken: 'main-only-token', apiBaseUrl: 'https://127.0.0.1:43219', ports: {backend: 43219}, secrets: {}, authorizedRoots: [], pathsFile: '/test/paths.enc' }");
  context.fixtureTransport = transportFixture({ userData: '/test', ports: { backend: 43219 }, getApiToken: () => run('runtime.apiToken') }, context.fetch);
  run('runtime.transport = fixtureTransport');
  // This harness exercises the supported legacy manifest without the guardian protocol.
  // Protocol-1 service ownership is covered by main-runtime-gateway and the real crash fixture.
  run('runtimeManifest = {}');
  run("safetyLifecycle = { diagnostics: () => ({aiOff: true, recoveryOnly: false}), latch: async () => {}, close: async () => {} }");
  context.fixtureAiGateway = gateway;
  run('aiGateway = fixtureAiGateway');
  return result;
}

test('intentional child shutdown never schedules automatic restart', async () => {
  const h = harness();
  await h.run("spawnManaged('backend', 'java', [])");
  await h.run("stopChild('backend')");
  assert.equal(h.timers.size, 0);
  assert.equal(h.run('children.size'), 0);
});

test('unexpected child exit triggers recovery; cancelling recovery clears the timer handle', async () => {
  const h = harness();
  await h.run("spawnManaged('backend', 'java', [])");
  h.spawned[0].child.emit('exit', 1, null);
  assert.equal(h.run('runtime.ready'), false);
  assert.equal(h.timers.size, 1);
  await h.run('stopRuntime()');
  assert.equal(h.timers.size, 0);
  h.run('stopping = false; scheduleRestart()');
  assert.equal(h.timers.size, 1);
});

test('child spawn errors are handled and reported instead of crashing Electron', async () => {
  const h = harness();
  await h.run("spawnManaged('backend', 'missing-java', [])");
  assert.doesNotThrow(() => h.spawned[0].child.emit('error', new Error('ENOENT')));
  assert.equal(h.run('children.size'), 0);
  assert.equal(h.run('runtime.ready'), false);
});


test('runtime mutations run sequentially even after a failed operation', async () => {
  const h = harness();
  h.context.calls = [];
  const first = h.run("withRuntimeOperation(async () => { calls.push('first'); await new Promise(resolve => release = resolve); throw new Error('fixture failure'); })");
  const failed = assert.rejects(first, /fixture failure/);
  const second = h.run("withRuntimeOperation(async () => { calls.push('second'); })");
  await Promise.resolve();
  assert.deepEqual(h.context.calls, ['first']);
  h.run('release()');
  await failed;
  await second;
  assert.deepEqual(h.context.calls, ['first', 'second']);
});



test('backup failure stops remaining writers and keeps recovery required instead of declaring readiness', async () => {
  const h = harness();
  h.context.calls = [];
  h.run("stopChild = async name => { calls.push('stop:' + name); }; startBackend = async () => { calls.push('start'); };");
  await h.run('backupPorts().failure()');
  assert.deepEqual(h.context.calls, ['stop:backend', 'stop:ts-analyzer', 'stop:redis']);
  assert.equal(h.run('runtime.ready'), false); assert.equal(h.run('runtime.recoveryRequired'), true);
  await assert.rejects(h.run("resumeAfterBackup({transactionId:'12d87afe-83b5-4b77-82d5-e30e510df38e',restored:false})"), { code: 'SAFETY_RECOVERY_REQUIRED' });
  assert.equal(h.sent.length, 0); assert.equal(h.context.calls.includes('start'), false);
});

test('failed backend resume cannot report a ready runtime', async () => {
  const h = harness();
  h.run("runtime.ready = false; startRedis = async () => {}; startAnalyzer = async () => {}; startBackend = async () => { throw new Error('fixture startup failure'); };");
  await assert.rejects(h.run("prepareResumeAfterBackup({transactionId:'12d87afe-83b5-4b77-82d5-e30e510df38e'})"), /startup failure/);
  assert.equal(h.run('runtime.ready'), false);
  assert.equal(h.sent.length, 0);
});

test('backup is refused while runtime is already unhealthy', async () => {
  const h = harness();
  h.run('runtime.ready = false');
  await assert.rejects(h.run("pauseForBackup({transactionId:'12d87afe-83b5-4b77-82d5-e30e510df38e',waitForAiDrain:async()=>{}})"), { code: 'SAFETY_RECOVERY_REQUIRED' });
  assert.equal(h.sent.length, 0); assert.equal(h.spawned.length, 0);
});

test('privileged IPC rejects foreign frames and origins', () => {
  const h = harness();
  h.run("mainWindow = {webContents: {mainFrame: {url: runtime.apiBaseUrl + '/'}}};");
  assert.doesNotThrow(() => h.run('assertTrustedRenderer({sender: mainWindow.webContents, senderFrame: mainWindow.webContents.mainFrame})'));
  assert.throws(() => h.run("assertTrustedRenderer({sender: mainWindow.webContents, senderFrame: {url: runtime.apiBaseUrl + '/iframe'}})"), /Untrusted/);
  h.run("mainWindow.webContents.mainFrame.url = 'https://untrusted.invalid/';");
  assert.throws(() => h.run('assertTrustedRenderer({sender: mainWindow.webContents, senderFrame: mainWindow.webContents.mainFrame})'), /Untrusted/);
});

test('renderer runtime configuration never includes the path authorization token', () => {
  const h = harness();
  h.run('assertTrustedRenderer = () => {}; registerIpc();');
  const event = {};
  h.handlers.get('runtime:config')(event);
  assert.deepEqual(Object.keys(event.returnValue).sort(), ['apiBaseUrl', 'apiToken', 'appVersion']);
  assert.equal(JSON.stringify(event.returnValue).includes('main-only-token'), false);
});

test('rollback failure cannot restart a backend against inconsistent restored data', async () => {
  const h = harness();
  h.context.calls = [];
  h.run("stopChild = async () => {}; startBackend = async () => { calls.push('start'); };");
  await h.run('backupPorts().failure()');
  await assert.rejects(h.run("resumeAfterBackup({transactionId:'12d87afe-83b5-4b77-82d5-e30e510df38e',restored:true})"), { code: 'SAFETY_RECOVERY_REQUIRED' });
  assert.deepEqual(h.context.calls, []);
  assert.equal(h.run('runtime.ready'), false);
  assert.equal(h.run('runtime.recoveryRequired'), true);
});

function startupHarness(changes = {}) {
  const calls = [];
  const safety = {
    diagnostics: () => ({ aiOff: true, recoveryOnly: false }),
    async latch() { calls.push('safety.latch'); },
    async close() { calls.push('safety.close'); },
  };
  const api = require('../src/safety-lifecycle.cjs');
  const h = harness({ ...changes, safetyModule: {
    ...api,
    async loadDesktopSecrets(options) {
      calls.push('secrets.load');
      await changes.loadSecrets?.(options);
      return { localIdentity: 'existing-synthetic-identity', databasePassword: 'synthetic-password', tokenEncryptionKey: 'synthetic-key' };
    },
    async openSafetyLifecycle(options) {
      calls.push('safety.open');
      await changes.openSafety?.(options);
      await options.createGateway({
        openJournal: async () => assert.fail('The synthetic gateway must not open a real journal'),
        freshEnrollmentAllowed: false,
      });
      return safety;
    },
  } });
  h.context.calls = calls;
  h.ipcDirectories.clear();
  h.run(`runtime = undefined; safetyLifecycle = undefined;
    verifyRuntimeIntegrity = async () => ({buildSequence:'100', runtime:{postgresBin:'postgres/bin', postgresLib:'postgres/lib'}});
    encryptedJson = () => []; freePort = async () => 43219; binary = (...parts) => parts.join('/');
    startPostgres = async () => { calls.push('postgres.start'); };
    startRedis = async () => { calls.push('redis.start'); };
    startAnalyzer = async () => { calls.push('analyzer.start'); };
    startBackend = async () => { calls.push('backend.start'); };
    createWindow = () => { calls.push('window.create'); };`);
  return { ...h, calls, safety };
}

for (const sequence of [undefined, 100, '01', '-1', '9223372036854775808']) {
  test(`main rejects manifest build sequence ${String(sequence)} before identity or B writes`, async () => {
    const h = startupHarness(); h.context.badSequence = sequence;
    h.run('verifyRuntimeIntegrity = async () => ({buildSequence: badSequence, runtime: {}})');
    await h.run('withRuntimeOperation(startApplication)');
    await h.run('shutdownPromise');
    assert.deepEqual(h.calls, []);
    assert.equal(h.spawned.length, 0);
    assert.match(h.dialogs[0][1], /valid safety build sequence/);
    assert.equal(h.run('runtime.recoveryRequired'), true);
  });
}

function manifestFixture(t) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ci-main-manifest-')));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const files = {};
  for (const [name, content] of Object.entries({ 'postgres/bin/postgres': 'synthetic executable bytes',
    'postgres/lib/libpq.fixture': 'synthetic library bytes' })) {
    const target = path.join(root, name);
    fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
    fs.writeFileSync(target, content, { mode: 0o600 });
    files[name] = crypto.createHash('sha256').update(content).digest('hex');
  }
  const manifest = { format: 1, platform: 'darwin', arch: 'arm64', buildSequence: '9223372036854775807',
    runtime: { postgresBin: 'postgres/bin', postgresLib: 'postgres/lib', postgresPkgLib: 'postgres/lib', postgresShare: 'postgres/share' }, files };
  fs.mkdirSync(path.join(root, 'postgres/share'), { mode: 0o700 });
  const save = () => fs.writeFileSync(path.join(root, 'runtime-manifest.json'), JSON.stringify(manifest), { mode: 0o600 });
  save();
  const h = harness({ disk: { existsSync: fs.existsSync }, fsp: { readFile: fs.promises.readFile } });
  h.context.fixtureRuntimeRoot = root;
  h.run('runtimeRoot = () => fixtureRuntimeRoot');
  return { h, root, manifest, save };
}

test('integrity verifier rejects a missing build sequence despite a valid nonempty hash inventory', async t => {
  const { h, manifest, save } = manifestFixture(t);
  delete manifest.buildSequence; save();
  await assert.rejects(h.run('verifyRuntimeIntegrity()'), { code: 'SAFETY_BUILD_SEQUENCE_INVALID' });
  manifest.buildSequence = '9223372036854775807'; save();
  assert.deepEqual(JSON.parse(JSON.stringify(await h.run('verifyRuntimeIntegrity()'))), manifest);
  assert.equal(h.spawned.length, 0); assert.equal(h.synchronous.length, 0);
});

for (const mutation of ['empty', 'missing', 'unlisted', 'changed-hash', 'symlink', 'hardlink']) {
  test('integrity verifier rejects ' + mutation + ' inventory before executing a bundled helper', async t => {
    const { h, root, manifest, save } = manifestFixture(t);
    const binary = path.join(root, 'postgres/bin/postgres');
    if (mutation === 'empty') manifest.files = {};
    if (mutation === 'missing') fs.unlinkSync(binary);
    if (mutation === 'unlisted') fs.writeFileSync(path.join(root, 'unexpected'), 'unlisted');
    if (mutation === 'changed-hash') fs.writeFileSync(binary, 'different bytes');
    if (mutation === 'symlink' || mutation === 'hardlink') {
      fs.unlinkSync(binary);
      const library = path.join(root, 'postgres/lib/libpq.fixture');
      if (mutation === 'symlink') fs.symlinkSync(library, binary);
      else fs.linkSync(library, binary);
      manifest.files['postgres/bin/postgres'] = manifest.files['postgres/lib/libpq.fixture'];
    }
    save();
    await assert.rejects(h.run('verifyRuntimeIntegrity()'));
    assert.equal(h.spawned.length, 0); assert.equal(h.synchronous.length, 0);
    assert.equal(h.handlers.size, 0);
  });
}

test('corrupt B stops startup before core runtime, renderer, or IPC registration', async () => {
  const api = require('../src/safety-lifecycle.cjs');
  const h = startupHarness({ openSafety: () => { throw new api.SafetyLifecycleError('SAFETY_RECOVERY_REQUIRED'); } });
  await h.run('withRuntimeOperation(startApplication)'); await h.run('shutdownPromise');
  assert.deepEqual(h.calls, ['secrets.load', 'safety.open']);
  assert.equal(h.handlers.size, 0); assert.equal(h.spawned.length, 0);
  assert.equal(h.ipcDirectories.size, 0);
  assert.equal(h.run('runtime.ready'), false);
  assert.equal(h.run('publicRuntimeStatus().recoveryOnly'), true);
});

test('initial backend failure closes safety even when there are no child handles', async () => {
  const h = startupHarness();
  h.run("startBackend = async () => { calls.push('backend.failed'); throw new Error('synthetic startup failure'); }");
  await h.run('withRuntimeOperation(startApplication)'); await h.run('shutdownPromise');
  assert.equal(h.run('children.size'), 0);
  assert.equal(h.calls.filter(item => item === 'safety.close').length, 1);
  assert.equal(h.run('runtime.ready'), false);
});

test('before-quit waits for one safety close even with zero children and repeated quit events', async () => {
  const h = harness(); h.context.calls = []; let release;
  h.context.closeWait = new Promise(resolve => { release = resolve; });
  h.run("safetyLifecycle.latch = async () => { calls.push('latch'); }; safetyLifecycle.close = async () => { calls.push('close'); await closeWait; }");
  let prevented = 0;
  const event = { preventDefault() { prevented++; } };
  h.appEvents.get('before-quit')(event); h.appEvents.get('before-quit')(event);
  await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
  assert.equal(prevented, 2); assert.equal(h.quitCalls, 0);
  assert.equal(h.run('shutdownRuntime() === shutdownPromise'), true);
  release(); await h.run('shutdownPromise'); await Promise.resolve();
  assert.deepEqual(h.context.calls, ['latch', 'close']);
  assert.equal(h.quitCalls, 1); assert.equal(h.run('shutdownComplete'), true);
});

test('shutdown waits for durable latch before stopping children and closes safety last', async () => {
  const h = harness(); h.context.calls = []; let release;
  h.context.latchWait = new Promise(resolve => { release = resolve; });
  h.run(`safetyLifecycle.latch = async () => { calls.push('latch.begin'); await latchWait; calls.push('latch.durable'); };
    stopChild = async name => { calls.push('stop:' + name); };
    safetyLifecycle.close = async () => { calls.push('safety.close'); };`);
  const closing = h.run('shutdownRuntime()');
  await Promise.resolve(); await Promise.resolve(); assert.deepEqual(h.context.calls, ['latch.begin']);
  release(); await closing;
  assert.deepEqual(h.context.calls, ['latch.begin', 'latch.durable', 'stop:backend', 'stop:ts-analyzer', 'stop:redis', 'stop:postgres', 'safety.close']);
});

test('quit during safety opening waits for the startup operation then closes without starting children', async () => {
  let release;
  const pending = new Promise(resolve => { release = resolve; });
  const h = startupHarness({ openSafety: () => pending });
  const starting = h.run('withRuntimeOperation(startApplication)');
  for (let i = 0; i < 100 && !h.calls.includes('safety.open'); i++) await Promise.resolve();
  assert.equal(h.calls.includes('safety.open'), true);
  h.appEvents.get('before-quit')({ preventDefault() {} });
  assert.equal(h.calls.includes('safety.close'), false);
  release(); await starting; await h.run('shutdownPromise');
  assert.deepEqual(h.calls, ['secrets.load', 'safety.open', 'safety.latch', 'safety.close']);
  assert.equal(h.spawned.length, 0);
  assert.equal(h.ipcDirectories.size, 0);
});

test('latch failure still stops every child and closes handles but never claims successful shutdown', async () => {
  const h = harness(); h.context.calls = [];
  h.run(`safetyLifecycle.latch = async () => { calls.push('latch.failed'); throw new Error('/synthetic/private'); };
    stopChild = async name => { calls.push('stop:' + name); };
    safetyLifecycle.close = async () => { calls.push('close'); };`);
  await assert.rejects(h.run('shutdownRuntime()'), { code: 'SAFETY_RECOVERY_REQUIRED' });
  assert.deepEqual(h.context.calls, ['latch.failed', 'stop:backend', 'stop:ts-analyzer', 'stop:redis', 'stop:postgres', 'close']);
  assert.equal(h.run('runtime.recoveryRequired'), true);
  assert.equal(h.run('runtime.error.includes("/synthetic")'), false);
});

test('a child that cannot stop retains main safety ownership instead of releasing keys', async () => {
  const h = harness(); h.context.calls = [];
  h.run(`children.set('backend', {});
    stopChild = async name => { if (name === 'backend') throw new Error('synthetic stuck child'); };
    safetyLifecycle.close = async () => { calls.push('close'); };`);
  await assert.rejects(h.run('shutdownRuntime()'), { code: 'SAFETY_RECOVERY_REQUIRED' });
  assert.deepEqual(h.context.calls, []); assert.equal(h.run('children.size'), 1);
});

test('a synchronous kill exception retains an unconfirmed live child and safety ownership', async () => {
  const h = harness(); h.context.calls = [];
  await h.run("spawnManaged('backend', 'synthetic-java', [])");
  h.run("safetyLifecycle.close = async () => { calls.push('close'); }");
  h.spawned[0].child.kill = () => { throw new Error('synthetic kill failure'); };
  await assert.rejects(h.run('shutdownRuntime()'), { code: 'SAFETY_RECOVERY_REQUIRED' });
  assert.equal(h.run('children.size'), 1); assert.deepEqual(h.context.calls, []);
  assert.equal(h.run("children.get('backend')"), h.spawned[0].child);
});

test('quit while PostgreSQL is starting prevents later services and window creation', async () => {
  const h = startupHarness(); let release;
  h.context.pgWait = new Promise(resolve => { release = resolve; });
  h.run("startPostgres = async () => { calls.push('postgres.pending'); await pgWait; }");
  const starting = h.run('withRuntimeOperation(startApplication)');
  for (let i = 0; i < 100 && !h.calls.includes('postgres.pending'); i++) await Promise.resolve();
  assert.equal(h.calls.includes('postgres.pending'), true);
  h.appEvents.get('before-quit')({ preventDefault() {} });
  release(); await starting; await h.run('shutdownPromise');
  assert.equal(h.calls.includes('postgres.pending'), true);
  assert.equal(h.calls.includes('redis.start'), false); assert.equal(h.calls.includes('analyzer.start'), false);
  assert.equal(h.calls.includes('backend.start'), false); assert.equal(h.calls.includes('window.create'), false);
  assert.equal(h.calls.includes('safety.latch'), true);
  assert.equal(h.run('Boolean(runtime.recoveryRequired)'), false);
  assert.deepEqual(h.dialogs, []);
  assert.equal(h.calls.at(-1), 'safety.close');
});

test('all bundled child paths inherit only system values and explicit main credentials', async () => {
  const system = { PATH: '/synthetic/bin', HOME: '/synthetic/home', TMPDIR: '/synthetic/tmp', LANG: 'synthetic.UTF-8',
    LC_ALL: 'C', LC_CTYPE: 'UTF-8', TZ: 'UTC', USER: 'synthetic-user', LOGNAME: 'synthetic-login' };
  const forbidden = { OPENAI_API_KEY: 'host-secret-openai', GEMINI_API_KEY: 'host-secret-gemini',
    GITHUB_TOKEN: 'host-secret-github', NODE_OPTIONS: 'host-node-injection', JAVA_TOOL_OPTIONS: 'host-java-injection',
    JDK_JAVA_OPTIONS: 'host-jdk-injection', CLASSPATH: 'host-classpath-injection', PGPASSWORD: 'host-secret-db',
    DYLD_INSERT_LIBRARIES: 'host-library-injection', CODE_INTELLIGENCE_SAFETY_KEY: 'host-purpose-key' };
  const h = harness({ env: { ...system, ...forbidden, GITHUB_NATIVE_CLIENT_ID: 'public-github-client' },
    disk: { existsSync: () => true } });
  h.run(`binary = (...parts) => parts.join('/'); waitUntil = async check => { await check(); }; saveEncryptedJson = async () => {};
    runtime.postgresLibRoot = 'postgres/lib'; runtime.ports = {backend:43219, postgres:43220, analyzer:43221, redis:43222};
    runtime.secrets = {databasePassword:'explicit-database-password', tokenEncryptionKey:'explicit-credential-key', localIdentity:'synthetic-id'};`);
  await h.run('startAnalyzer()'); await h.run('startBackend()'); await h.run('startPostgres()');
  h.run("run('synthetic-command', [], {env:{EXPLICIT_PUBLIC:'fixture'}})");
  const children = [...h.spawned, ...h.synchronous];
  assert.ok(children.some(item => item.command.endsWith('pg_isready')));
  for (const item of children) {
    for (const [name, value] of Object.entries(system)) assert.equal(item.options.env[name], value);
    for (const value of Object.values(forbidden)) assert.equal(JSON.stringify(item.options.env).includes(value), false);
    for (const name of ['NODE_OPTIONS', 'JAVA_TOOL_OPTIONS', 'JDK_JAVA_OPTIONS', 'DYLD_INSERT_LIBRARIES', 'CODE_INTELLIGENCE_SAFETY_KEY'])
      assert.equal(item.options.env[name], undefined);
  }
  const analyzer = h.spawned.find(item => item.command === '/synthetic/electron');
  assert.equal(analyzer.options.env.ELECTRON_RUN_AS_NODE, '1');
  assert.equal(analyzer.options.env.DB_PASSWORD, undefined); assert.equal(analyzer.options.env.TOKEN_ENC_KEY, undefined);
  const backend = h.spawned.find(item => item.command === 'jre/bin/java');
  assert.equal(backend.options.env.DB_PASSWORD, 'explicit-database-password');
  assert.equal(backend.options.env.GITHUB_NATIVE_CLIENT_ID, 'public-github-client');
  const health = h.synchronous.find(item => item.command.endsWith('pg_isready'));
  assert.equal(health.options.env.PGPASSWORD, 'explicit-database-password');
  assert.equal(h.synchronous.at(-1).options.env.EXPLICIT_PUBLIC, 'fixture');
});

test('backend restart retains the same safety facade and latches before stopping', async () => {
  const h = harness(); h.context.calls = [];
  h.run(`assertTrustedRenderer = () => {}; registerIpc(); originalSafety = safetyLifecycle;
    safetyLifecycle.latch = async () => { calls.push('latch'); };
    safetyLifecycle.close = async () => { calls.push('close'); };
    stopChild = async name => { calls.push('stop:' + name); };
    startPostgres = async () => {}; startRedis = async () => {}; startAnalyzer = async () => {};
    startBackend = async () => { calls.push('backend.start'); };`);
  const status = await h.handlers.get('runtime:restart')({});
  assert.equal(status.ready, true); assert.equal(status.aiOff, true);
  assert.equal(h.run('originalSafety === safetyLifecycle'), true);
  assert.deepEqual(h.context.calls, ['latch', 'stop:backend', 'stop:ts-analyzer', 'stop:redis', 'stop:postgres', 'backend.start']);
});

test('AI drain verification precedes stopping children and its failure leaves A untouched without restart', async () => {
  const transactionId = '12d87afe-83b5-4b77-82d5-e30e510df38e';
  const h = harness({ fetch: async () => ({ ok: true, json: async () => ({ transactionId, state: 'DRAINED',
    activeRequests: 0, activeWriters: 0, activeJobs: 0 }) }) }); h.context.calls = [];
  h.run(`stopChild = async () => { calls.push('stop'); };
    startBackend = async () => { calls.push('start'); };`);
  await assert.rejects(h.run(`pauseForBackup({transactionId:'${transactionId}',waitForAiDrain:async()=>{
    calls.push('drain.failed'); throw new SafetyLifecycleError('SAFETY_RECOVERY_REQUIRED');}})`), { code: 'SAFETY_RECOVERY_REQUIRED' });
  assert.deepEqual(h.context.calls, ['drain.failed']); assert.equal(h.run('runtime.ready'), false);
});

test('product backup and restore refuse before dialogs, filesystem work, SQL or runtime pause', async () => {
  const h = harness(); h.context.calls = [];
  h.run("assertTrustedRenderer = () => {}; registerIpc(); pauseForBackup = async () => { calls.push('pause'); }");
  for (const name of ['data:backup', 'data:restore']) {
    await assert.rejects(h.handlers.get(name)({}), /unavailable.*Existing data was not changed/);
  }
  assert.throws(() => h.run("createBackup('/synthetic/selected-folder')"), /Backup is unavailable/);
  assert.deepEqual(h.context.calls, []); assert.deepEqual(h.dialogs, []);
  assert.equal(h.spawned.length, 0); assert.equal(h.run('runtime.ready'), true);
});

for (const mutation of ['wrong-transaction', 'unknown-state', 'old-counter-names', 'negative', 'fractional', 'string-count', 'unsafe-count']) {
  test(`maintenance ${mutation} cannot authorize AI drain or stopping a backend`, async () => {
    const transactionId = '12d87afe-83b5-4b77-82d5-e30e510df38e';
    const body = { transactionId, state: 'DRAINED', activeRequests: 0, activeWriters: 0, activeJobs: 0 };
    if (mutation === 'wrong-transaction') body.transactionId = '5ad87afe-83b5-4b77-82d5-e30e510df38e';
    if (mutation === 'unknown-state') body.state = 'verified';
    if (mutation === 'old-counter-names') { delete body.activeRequests; delete body.activeWriters; delete body.activeJobs;
      Object.assign(body, { requests: 0, writers: 0, jobs: 0 }); }
    if (mutation === 'negative') body.activeJobs = -1;
    if (mutation === 'fractional') body.activeJobs = 0.5;
    if (mutation === 'string-count') body.activeJobs = '0';
    if (mutation === 'unsafe-count') body.activeJobs = Number.MAX_SAFE_INTEGER + 1;
    const h = harness({ fetch: async () => ({ ok: true, json: async () => body }) }); h.context.calls = [];
    h.run("stopChild = async name => { calls.push('stop:' + name); }");
    await assert.rejects(h.run(`pauseForBackup({transactionId:'${transactionId}',waitForAiDrain:async()=>{calls.push('ai');}})`), /could not be verified/);
    assert.deepEqual(h.context.calls, []); assert.equal(h.run('runtime.ready'), false);
    assert.equal(h.sent.length, 1); assert.equal(JSON.parse(h.sent[0].options.body).operation, 'BEGIN');
  });
}


test('maintenance HTTP rejection leaves AI drain and child ownership untouched', async () => {
  const h = harness({ fetch: async () => ({ ok: false, status: 403 }) }); h.context.calls = [];
  h.run("stopChild = async name => { calls.push('stop:' + name); }");
  await assert.rejects(h.run("pauseForBackup({transactionId:'12d87afe-83b5-4b77-82d5-e30e510df38e',waitForAiDrain:async()=>{calls.push('ai');}})"), /could not enter backup maintenance/);
  assert.deepEqual(h.context.calls, []); assert.equal(h.run('runtime.ready'), false);
});

test('runtime status includes only public OFF/recovery and unavailable actions, never private diagnostics', () => {
  const h = harness();
  h.run(`safetyLifecycle.diagnostics = () => ({aiOff:true, recoveryOnly:false, projectionDigest:'private-digest',
    keyProvider:'private-keys', requests:['private-obligation'], installationId:'private-identity'});
    assertTrustedRenderer = () => {}; registerIpc();`);
  const result = h.handlers.get('runtime:status')({});
  assert.deepEqual(Object.keys(result).sort(), ['aiOff', 'backupAvailable', 'error', 'ready', 'recoveryOnly', 'restoreAvailable', 'services']);
  assert.equal(result.aiOff, true); assert.equal(result.recoveryOnly, false);
  assert.equal(result.backupAvailable, false); assert.equal(result.restoreAvailable, false);
  assert.equal(JSON.stringify(result).includes('private-'), false);
  assert.equal([...h.handlers.keys()].some(name => /activate|reserve|settle|keyring/i.test(name)), false);
});

test('no new safety key or admission capability reaches backend environment or renderer config', async () => {
  const h = harness();
  h.run(`binary = (...parts) => parts.join('/'); waitUntil = async () => {}; saveEncryptedJson = async () => {};
    safetyLifecycle.hiddenKey = 'private-purpose-key'; safetyLifecycle.hiddenPermit = 'private-permit';
    assertTrustedRenderer = () => {}; registerIpc();`);
  await h.run('startBackend()');
  const event = {}; h.handlers.get('runtime:config')(event);
  const exposed = JSON.stringify([h.spawned[0].options.env, event.returnValue]);
  assert.equal(exposed.includes('private-purpose-key'), false); assert.equal(exposed.includes('private-permit'), false);
  assert.equal(exposed.includes('synthetic-private-gateway-capability'), false);
  assert.equal(JSON.stringify(h.spawned[0].args).includes('synthetic-private-gateway-capability'), false);
  assert.equal(h.bootstrapWrites.length, 1);
  const bootstrap = JSON.parse(h.bootstrapWrites[0].toString('utf8'));
  assert.deepEqual(Object.keys(bootstrap).sort(), ['ai', 'source', 'version']);
  assert.equal(bootstrap.version, 2);
  assert.deepEqual(bootstrap.ai, { socketPath: '/test/ai.sock', capability: 'synthetic-private-gateway-capability', epoch: 'synthetic-epoch' });
  assert.deepEqual(Object.keys(bootstrap.source).sort(), ['capability', 'socketPath']);
  assert.equal(bootstrap.source.socketPath, path.join(h.run('runtime.ipcRoot'), 's'));
  assert.equal(typeof bootstrap.source.capability, 'string');
  assert.ok(bootstrap.source.capability.length >= 32);
  for (const secret of [bootstrap.source.capability, bootstrap.source.socketPath, bootstrap.ai.socketPath]) {
    assert.equal(exposed.includes(secret), false);
    assert.equal(JSON.stringify(h.spawned[0].args).includes(secret), false);
  }
  assert.equal(h.spawned[0].child.stdin.writableEnded, true);
  assert.deepEqual(Object.keys(event.returnValue).sort(), ['apiBaseUrl', 'apiToken', 'appVersion']);
});

test('a secondary process that lost the single-instance lock never starts safety or children', async () => {
  const h = startupHarness({ ownsInstance: false });
  await h.run('withRuntimeOperation(startApplication)');
  assert.deepEqual(h.calls, []); assert.equal(h.spawned.length, 0);
});

function assertBlockedBootstrap(h, code) {
  assert.equal(h.bootstrapError?.code, code);
  assert.deepEqual(h.effects.filter(item => item[0] === 'exit'), [['exit', 1]]);
  assert.equal(h.effects.some(item => ['singleton', 'whenReady', 'safeStorage', 'network'].includes(item[0])), false);
  assert.equal(h.handlers.size, 0); assert.equal(h.appEvents.size, 0);
  assert.equal(h.spawned.length, 0); assert.equal(h.synchronous.length, 0);
  assert.equal(h.sent.length, 0); assert.equal(h.productCalls.length, 0);
  assert.equal(h.timers.size, 0); assert.deepEqual(h.dialogs, []);
}

for (const argv of [
  ['--isolated-run'],
  ['--isolated-run-parent=/private/synthetic'],
  ['--isolated-run-parent=/private/synthetic', '--isolated-runtime-root=/private/runtime', '--isolated-run-parent=/private/other'],
  ['--isolated-run-parent=relative', '--isolated-runtime-root=/private/runtime'],
]) {
  test(`invalid isolated configuration exits before any normal startup effect: ${JSON.stringify(argv)}`, () => {
    const h = harness({ argv, captureBootstrapError: true });
    assertBlockedBootstrap(h, 'ISOLATED_RUN_INVALID');
    assert.equal(h.effects.some(item => ['setPath', 'setAppLogsPath'].includes(item[0])), false);
    assert.equal(JSON.stringify(h.effects).includes('/private/synthetic'), false);
  });
}

test('actual main accepts a reusable validation claim before singleton, readiness or credentials', t => {
  const base = process.platform === 'darwin' ? '/private/tmp' : os.tmpdir();
  const root = fs.realpathSync(fs.mkdtempSync(path.join(base, 'cirm-')));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const parentDirectory = path.join(root, 'runs'); const runtimeDirectory = path.join(root, 'runtime');
  fs.mkdirSync(parentDirectory, { mode: 0o700 }); fs.mkdirSync(runtimeDirectory, { mode: 0o700 });
  const plan = require('../src/isolated-run.cjs').prepareIsolatedRun({ parentDirectory, runtimeDirectory, purpose: 'automation' });
  const h = harness({ argv: ['electron', '.', '--isolated-run-claim', plan.claimFile], captureBootstrapError: true });
  assert.equal(h.bootstrapError, undefined);
  assert.deepEqual(h.effects.filter(item => ['setName', 'setPath', 'setAppLogsPath'].includes(item[0])), [
    ['setName', 'Code Intelligence Acceptance'],
    ['setPath', 'userData', plan.paths.userData],
    ['setPath', 'sessionData', plan.paths.sessionData],
    ['setPath', 'temp', plan.paths.temp],
    ['setPath', 'crashDumps', plan.paths.crashDumps],
    ['setAppLogsPath', plan.paths.logs],
  ]);
  assert.deepEqual(h.effects.filter(item => item[0] === 'singleton'), [[
    'singleton', { userData: plan.paths.userData, sessionData: plan.paths.sessionData,
      temp: plan.paths.temp, crashDumps: plan.paths.crashDumps, logs: plan.paths.logs }
  ]]);
  assert.equal(h.effects.some(item => ['safeStorage', 'network', 'exit'].includes(item[0])), false);
  const claim = JSON.parse(fs.readFileSync(plan.claimFile, 'utf8'));
  assert.equal(claim.launchAllowed, true); assert.deepEqual(claim.appIdentity, plan.appIdentity);
});

test('ordinary startup ignores isolation-like environment values and preserves default Electron paths', async () => {
  const h = startupHarness({ env: { CODE_INTELLIGENCE_ISOLATION_VERIFIED: '1', ISOLATED_RUN_PARENT: '/synthetic/unused' } });
  assert.deepEqual(h.effects, [['singleton', { userData: '/test', sessionData: '/test' }], ['whenReady']]);
  await h.run('withRuntimeOperation(startApplication)');
  assert.deepEqual(h.calls, ['secrets.load', 'safety.open', 'postgres.start', 'redis.start', 'analyzer.start', 'backend.start', 'window.create']);
  assert.equal(h.run('runtime.ready'), true);
  assert.equal(h.effects.some(item => ['setPath', 'setAppLogsPath', 'exit'].includes(item[0])), false);
});

for (const overlap of ['parent-userData', 'runtime-sessionData', 'runtime-packaged-resources']) {
  test(`main refuses ${overlap} overlap before creating a run or changing Electron paths`, t => {
    const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ci-isolation-protected-main-')));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const parentDirectory = path.join(root, 'runs'); const runtimeDirectory = path.join(root, 'runtime');
    fs.mkdirSync(parentDirectory, { mode: 0o700 }); fs.mkdirSync(runtimeDirectory, { mode: 0o700 });
    const protectedRoot = overlap === 'parent-userData' ? path.join(parentDirectory, 'production-user-data')
      : path.join(runtimeDirectory, 'protected');
    fs.mkdirSync(protectedRoot, { mode: 0o700 });
    const sentinel = path.join(protectedRoot, 'existing-data');
    fs.writeFileSync(sentinel, 'synthetic existing data must remain unchanged', { mode: 0o600 });
    const before = fs.statSync(sentinel);
    const parentEntries = fs.readdirSync(parentDirectory); const runtimeEntries = fs.readdirSync(runtimeDirectory);
    const config = overlap === 'parent-userData' ? { appPaths: { userData: protectedRoot } }
      : overlap === 'runtime-sessionData' ? { appPaths: { sessionData: protectedRoot } }
      : { isPackaged: true, resourcesPath: protectedRoot };
    const h = harness({ ...config, captureBootstrapError: true,
      argv: ['--isolated-run-parent', parentDirectory, '--isolated-runtime-root', runtimeDirectory] });
    assertBlockedBootstrap(h, 'ISOLATED_RUN_INVALID');
    assert.equal(h.effects.some(item => ['setPath', 'setAppLogsPath'].includes(item[0])), false);
    assert.deepEqual(fs.readdirSync(parentDirectory), parentEntries);
    assert.deepEqual(fs.readdirSync(runtimeDirectory), runtimeEntries);
    assert.deepEqual(fs.readdirSync(protectedRoot), ['existing-data']);
    assert.equal(fs.readFileSync(sentinel, 'utf8'), 'synthetic existing data must remain unchanged');
    assert.equal(fs.statSync(sentinel).mtimeMs, before.mtimeMs);
    assert.equal(JSON.stringify(h.effects.filter(item => item[0] === 'console.error')).includes(root), false);
  });
}


test('shutdown refuses to remove an IPC directory whose ownership identity changed', async () => {
  const h = harness();
  const directory = h.run('runtime.ipcRoot');
  h.ipcDirectories.get(directory).ino++;
  await assert.rejects(h.run('shutdownRuntime()'), { code: 'SAFETY_RECOVERY_REQUIRED' });
  assert.equal(h.ipcDirectories.has(directory), true);
  assert.equal(h.run('shutdownComplete'), false);
});
