const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

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
  // Constructor boundaries stay synthetic: no socket, PostgreSQL process, or admission is opened.
  const gateway = {
    bootstrap: () => Buffer.from('synthetic-private-gateway-capability\n'),
    diagnostics: () => ({ aiOff: true, recoveryOnly: false }),
    async latchOffline() {},
    async close() {},
  };
  const postgres = { async close() {} };
  let quitCalls = 0;
  const disk = { mkdirSync() {}, openSync: () => 1, closeSync() {}, existsSync: () => false, ...options.disk };
  const electron = {
    app: {
      getVersion: () => '0.1.0',
      requestSingleInstanceLock: () => options.ownsInstance !== false,
      on: (name, callback) => appEvents.set(name, callback),
      whenReady: () => new Promise(() => {}), getPath: () => '/test',
      quit() { quitCalls++; appEvents.get('before-quit')?.({ preventDefault() {} }); },
    },
    dialog: {
      showErrorBox: (...args) => dialogs.push(args),
      showOpenDialog: async () => { dialogs.push('open'); return { canceled: false, filePaths: ['/synthetic/selection'] }; },
      showMessageBox: async () => { dialogs.push('confirmation'); return { response: 1 }; },
    },
    safeStorage: {},
    ipcMain: { on: (name, fn) => handlers.set(name, fn), handle: (name, fn) => handlers.set(name, fn) },
  };
  const context = vm.createContext({
    require(name) {
      if (name === 'electron') return electron;
      if (Object.hasOwn(options.modules || {}, name)) return options.modules[name];
      if (name === './safety-lifecycle.cjs' && options.safetyModule) return options.safetyModule;
      if (name === './ai-desktop-gateway.cjs') return { openDesktopAiGateway: async () => gateway };
      if (name === './ai-egress-postgres.cjs') return { createAiEgressPostgres: async () => postgres };
      if (name === './backup-product-state.cjs') return { createBackupProductState: async value => {
        productCalls.push({ operation: 'open', value });
        return { async verifyOrigin() { productCalls.push({ operation: 'verify' }); await options.verifyOrigin?.(value); },
          async close() { productCalls.push({ operation: 'close' }); } };
      } };
      if (name.startsWith('./')) return require(path.resolve(__dirname, '../src', name));
      if (name === 'node:fs') return disk;
      if (name === 'node:fs/promises') return { mkdir: async () => {}, realpath: async (p) => p, ...options.fsp };
      if (name === 'node:child_process') return {
        spawn(command, args, options) {
          const child = new EventEmitter();
          child.exitCode = null;
          child.signalCode = null;
          if (options.stdio?.[0] === 'pipe') {
            child.stdin = new EventEmitter();
            child.stdin.end = (bytes, callback) => {
              bootstrapWrites.push(Buffer.from(bytes));
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
    process: { env: { ...options.env }, pid: 42, platform: 'darwin', arch: 'arm64', execPath: '/synthetic/electron', getuid: process.getuid.bind(process) },
    __dirname: path.resolve(__dirname, '../src'),
    Buffer, URL, AbortSignal, console, fetch: async (url, value) => {
      sent.push({ url, options: value });
      return options.fetch ? options.fetch(url, value) : { ok: true, json: async () => ({ path: '/selected/project' }) };
    },
    setTimeout: (fn, delay) => { const timer = { fn, delay }; timers.add(timer); return timer; },
    clearTimeout: (timer) => timers.delete(timer),
  });
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../src/main.cjs'), 'utf8'), context);
  const run = (source) => vm.runInContext(source, context);
  run("runtime = { ready: true, apiToken: 'renderer-token', pathToken: 'main-only-token', apiBaseUrl: 'http://127.0.0.1:43219', ports: {backend: 43219}, secrets: {}, authorizedRoots: [], pathsFile: '/test/paths.enc' }");
  // This harness exercises the supported legacy manifest without the guardian protocol.
  // Protocol-1 service ownership is covered by main-runtime-gateway and the real crash fixture.
  run('runtimeManifest = {}');
  run("safetyLifecycle = { diagnostics: () => ({aiOff: true, recoveryOnly: false}), latch: async () => {}, close: async () => {} }");
  context.fixtureAiGateway = gateway;
  run('aiGateway = fixtureAiGateway');
  return { run, context, timers, handlers, appEvents, spawned, synchronous, bootstrapWrites, productCalls, disk, sent, dialogs, get quitCalls() { return quitCalls; } };
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

test('backend callback uses the actual runtime port and path grants use a separate token', async () => {
  const h = harness();
  h.run("binary = (...parts) => parts.join('/'); waitUntil = async () => {}; saveEncryptedJson = () => {};");
  await h.run('startBackend()');
  const env = h.spawned[0].options.env;
  assert.equal(env.GITHUB_NATIVE_REDIRECT_URI, 'http://127.0.0.1:43219/api/auth/github/native/callback');
  assert.equal(env.DESKTOP_PATH_TOKEN, 'main-only-token');
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


test('folder authorization sends the main-only capability to the backend', async () => {
  const h = harness();
  h.run('saveEncryptedJson = () => {}');
  await h.run("authorizePath('/selected/project')");
  assert.equal(h.sent[0].options.headers['X-Code-Intelligence-Path-Token'], 'main-only-token');
  assert.equal(h.sent[0].options.headers['X-Code-Intelligence-Token'], 'renderer-token');
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

test('real main startup opens safety with the existing identity before any child or window', async () => {
  let supplied;
  const h = startupHarness({ openSafety: options => { supplied = options; } });
  await h.run('withRuntimeOperation(startApplication)');
  assert.deepEqual(h.calls, ['secrets.load', 'safety.open', 'postgres.start', 'redis.start', 'analyzer.start', 'backend.start', 'window.create']);
  assert.equal(supplied.installationId, 'existing-synthetic-identity');
  assert.equal(supplied.runningBuild, '100');
  assert.equal(h.run('runtime.ready'), true);
  assert.equal(h.run('publicRuntimeStatus().aiOff'), true);
  assert.equal(h.run('publicRuntimeStatus().recoveryOnly'), false);
});

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

test('integrity verifier requires an explicit build sequence even when all file hashes would pass', async () => {
  const manifest = { format: 1, platform: 'darwin', arch: 'arm64',
    runtime: { postgresBin: 'pg/bin', postgresLib: 'pg/lib', postgresPkgLib: 'pg/pkg', postgresShare: 'pg/share' }, files: {} };
  const h = harness({ disk: { existsSync: () => true }, fsp: { readFile: async () => JSON.stringify(manifest) } });
  await assert.rejects(h.run('verifyRuntimeIntegrity()'), { code: 'SAFETY_BUILD_SEQUENCE_INVALID' });
  manifest.buildSequence = '9223372036854775807';
  assert.equal((await h.run('verifyRuntimeIntegrity()')).buildSequence, manifest.buildSequence);
});

test('corrupt B stops startup before core runtime, renderer, or IPC registration', async () => {
  const api = require('../src/safety-lifecycle.cjs');
  const h = startupHarness({ openSafety: () => { throw new api.SafetyLifecycleError('SAFETY_RECOVERY_REQUIRED'); } });
  await h.run('withRuntimeOperation(startApplication)'); await h.run('shutdownPromise');
  assert.deepEqual(h.calls, ['secrets.load', 'safety.open']);
  assert.equal(h.handlers.size, 0); assert.equal(h.spawned.length, 0);
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
  h.run(`binary = (...parts) => parts.join('/'); waitUntil = async check => { await check(); }; saveEncryptedJson = () => {};
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

test('main-only maintenance capabilities are sent to the current backend and never supplied by renderer payload', async () => {
  const transactionId = '12d87afe-83b5-4b77-82d5-e30e510df38e';
  const h = harness({ fetch: async () => ({ ok: true, json: async () => ({ transactionId, state: 'DRAINED',
    activeRequests: 0, activeWriters: 0, activeJobs: 0 }) }) });
  h.context.calls = []; h.run("stopChild = async name => { calls.push('stop:' + name); }");
  await h.run(`pauseForBackup({transactionId:'${transactionId}',waitForAiDrain:async()=>{calls.push('ai.drained');}})`);
  assert.deepEqual(h.context.calls, ['ai.drained', 'stop:backend', 'stop:ts-analyzer']);
  assert.equal(h.sent[0].url, 'http://127.0.0.1:43219/api/desktop/maintenance');
  assert.equal(h.sent[0].options.headers['X-Code-Intelligence-Token'], 'renderer-token');
  assert.equal(h.sent[0].options.headers['X-Code-Intelligence-Path-Token'], 'main-only-token');
  assert.deepEqual(JSON.parse(h.sent[0].options.body), { transactionId, operation: 'BEGIN' });
});

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
  h.run(`binary = (...parts) => parts.join('/'); waitUntil = async () => {}; saveEncryptedJson = () => {};
    safetyLifecycle.hiddenKey = 'private-purpose-key'; safetyLifecycle.hiddenPermit = 'private-permit';
    assertTrustedRenderer = () => {}; registerIpc();`);
  await h.run('startBackend()');
  const event = {}; h.handlers.get('runtime:config')(event);
  const exposed = JSON.stringify([h.spawned[0].options.env, event.returnValue]);
  assert.equal(exposed.includes('private-purpose-key'), false); assert.equal(exposed.includes('private-permit'), false);
  assert.equal(exposed.includes('synthetic-private-gateway-capability'), false);
  assert.equal(JSON.stringify(h.spawned[0].args).includes('synthetic-private-gateway-capability'), false);
  assert.equal(h.bootstrapWrites.length, 1);
  assert.equal(h.bootstrapWrites[0].toString(), 'synthetic-private-gateway-capability\n');
  assert.deepEqual(Object.keys(event.returnValue).sort(), ['apiBaseUrl', 'apiToken']);
});

test('a secondary process that lost the single-instance lock never starts safety or children', async () => {
  const h = startupHarness({ ownsInstance: false });
  await h.run('withRuntimeOperation(startApplication)');
  assert.deepEqual(h.calls, []); assert.equal(h.spawned.length, 0);
});
