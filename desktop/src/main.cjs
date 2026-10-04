const {
  app,
  BrowserWindow,
  dialog,
  ipcMain,
  safeStorage,
  shell
} = require('electron');
const { spawn, spawnSync } = require('node:child_process');
const crypto = require('node:crypto');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const net = require('node:net');
const path = require('node:path');
const {
  loadDesktopSecrets, openSafetyLifecycle, requireBuildSequence, createSafeStorageWrapper, SafetyLifecycleError
} = require('./safety-lifecycle.cjs');
const { openDesktopAiGateway } = require('./ai-desktop-gateway.cjs');
const { createAiEgressPostgres } = require('./ai-egress-postgres.cjs');
const { createMaintenanceVerifier } = require('./backup-cost-state.cjs');
const { createDesktopBackupRuntime } = require('./backup-runtime.cjs');
const { createBackupPostgres } = require('./backup-postgres.cjs');
const { createBackupDatabaseControl } = require('./backup-database.cjs');
const { createBackupProductState } = require('./backup-product-state.cjs');
const { createBackupSourceWorker } = require('./backup-source-worker.cjs');
const { createSourceVault, openSourceVault, openSourceVaultRestoreStage } = require('./source-vault.cjs');
const { createNativeOwnerLocks } = require('./native-owner-locks.cjs');
const { spawnManagedProcess } = require('./managed-process.cjs');
const { runtimeRelativePath, runtimeFile, inheritedEnvironment, libraryEnvironment } = require('./runtime-platform.cjs');
const { parseIsolatedRunArguments, openIsolatedRun, assertIsolatedLaunchReady, isolatedChildEnvironment } = require('./isolated-run.cjs');
const { createServiceTransport } = require('./service-transport.cjs');
const { createSourceBroker } = require('./source-broker.cjs');
const { createWindowsBoundary } = require('./windows-native-boundary.cjs');
const { openAuthenticatedState } = require('./windows-authenticated-state.cjs');
const { writeStorageFile } = require('./windows-storage-files.cjs');
const { validateRuntimeManifest } = require('./runtime-manifest.cjs');

const children = new Map();
const childStops = new Map();
let mainWindow;
let runtime;
let runtimeManifest;
let safetyLifecycle;
let aiGateway;
let aiPostgres;
let backupRuntime;
let ownerLocks;
let sourceVault;
let sourceBroker;
let sourceEndpoint;
let bootRecovery = false;
let stopping = false;
let quitting = false;
let shutdownPromise;
let shutdownComplete = false;
let quitContinuation = false;
let restartTimer;
let restartAttempts = 0;
let runtimeOperation = Promise.resolve();
let startupPhase = 'MANIFEST';
let isolatedPlan;
function noteStartup(phase) {
  startupPhase = phase;
  console.error('DESKTOP_STARTUP ' + phase);
}

// Dialogs, backup, restore and restart must never mutate the same runtime concurrently.
function withRuntimeOperation(action) {
  const result = runtimeOperation.then(action);
  runtimeOperation = result.catch(() => {});
  return result;
}

try {
  const isolation = parseIsolatedRunArguments(process.argv ?? []);
  if (isolation) {
    const plan = openIsolatedRun({ claimFile: isolation.claimFile, forbiddenRoots: [
      app.getPath('userData'), app.getPath('sessionData'), path.join(__dirname, '..', 'dist'),
    ] });
    assertIsolatedLaunchReady(plan);
    app.setName(plan.appIdentity.name);
    for (const name of ['userData', 'sessionData', 'temp', 'crashDumps']) app.setPath(name, plan.paths[name]);
    app.setAppLogsPath(plan.paths.logs);
    isolatedPlan = plan;
  }
} catch (error) {
  const code = ['ISOLATED_RUN_INVALID', 'ISOLATED_RUN_UNSUPPORTED_PLATFORM'].includes(error?.code)
    ? error.code : 'ISOLATED_RUN_INVALID';
  console.error(`[desktop] isolated validation refused: ${code}`);
  app.exit(1);
  throw error; // Do not continue if an embedding or test double returns from exit.
}

const ownsInstance = app.requestSingleInstanceLock();
if (!ownsInstance) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
  });
}

function randomSecret(bytes = 32) {
  return crypto.randomBytes(bytes).toString('hex');
}

function runtimeRoot() {
  if (isolatedPlan) return isolatedPlan.runtimeRoot;
  return app.isPackaged
    ? path.join(process.resourcesPath, 'runtime')
    : path.join(__dirname, '..', 'stage', 'runtime');
}

function encryptedJson(file, fallbackFactory) {
  if (!safeStorage.isEncryptionAvailable()) {
    throw new Error('OS secure storage is unavailable; refusing to persist desktop credentials.');
  }
  if (fs.existsSync(file)) {
    return JSON.parse(safeStorage.decryptString(fs.readFileSync(file)));
  }
  const value = fallbackFactory();
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  fs.writeFileSync(file, safeStorage.encryptString(JSON.stringify(value)), { mode: 0o600 });
  return value;
}

async function saveEncryptedJson(file, value) {
  if (runtime?.windowsBoundary) {
    if (file !== runtime.pathsFile || !runtime.grantState) throw new SafetyLifecycleError('SAFETY_RECOVERY_REQUIRED');
    const bytes = Buffer.from(JSON.stringify(value));
    try { await runtime.grantState.write(bytes); }
    catch (error) { void loseRuntimeOwnership(); throw error; }
    finally { bytes.fill(0); }
    return;
  }
  const temporary = `${file}.tmp-${process.pid}`;
  fs.writeFileSync(temporary, safeStorage.encryptString(JSON.stringify(value)), { mode: 0o600 });
  fs.renameSync(temporary, file);
}

async function openAuthorizedRoots(secrets, fresh = false) {
  const wrapper = createSafeStorageWrapper(safeStorage, { electronApp: app, maxPayloadBytes: 2 * 1024 * 1024 });
  runtime.grantState = await openAuthenticatedState({ storage: runtime.storage, file: 'authorized-paths.enc',
    installationId: secrets.localIdentity, purpose: 'authorized-roots', mode: 'slots',
    seal: bytes => wrapper.wrap(bytes), unseal: bytes => wrapper.unwrap(bytes),
    maxPayloadBytes: 1024 * 1024, maxEncodedBytes: 2 * 1024 * 1024 + 8236, fresh,
    ...(fresh ? { initialValue: Buffer.from('[]') } : {}) });
}

async function readAuthorizedRoots() {
  if (!runtime.windowsBoundary) return encryptedJson(runtime.pathsFile, () => []);
  const bytes = await runtime.grantState.read();
  try {
    const value = JSON.parse(bytes.toString('utf8'));
    if (!Array.isArray(value) || value.some(item => typeof item !== 'string' || !path.isAbsolute(item)))
      throw new SafetyLifecycleError('SAFETY_RECOVERY_REQUIRED');
    return value;
  } finally { bytes.fill(0); }
}

function loseRuntimeOwnership() {
  stopping = true; runtime = runtime || {}; runtime.ready = false; runtime.recoveryRequired = true;
  clearTimeout(restartTimer); restartTimer = null;
  runtime.error = 'Desktop ownership was lost. Recovery is required before reopening.';
  mainWindow?.webContents.send('runtime:changed', publicRuntimeStatus());
  return Promise.allSettled([Promise.resolve().then(() => aiGateway?.latchOffline('USER_OFF')),
    ...['backend', 'ts-analyzer', 'redis', 'postgres'].map(stopChild)]);
}

async function runtimeDirectory(name, inherit = false) {
  const directory = path.join(runtime.userData, name);
  if (runtime.windowsBoundary) {
    if (!await runtime.storage.stat(name, { directory: true, missing: true })) await runtime.storage.mkdir(name, { inherit });
  } else await fsp.mkdir(directory, { recursive: true, mode: 0o700 });
  return directory;
}

function sourceVaultOptions(sourceRoot) {
  return { sourceRoot, safetyRoot: path.join(runtime.userData, 'safety'), installationId: runtime.secrets.localIdentity,
    wrapper: createSafeStorageWrapper(safeStorage, { electronApp: app }),
    ...(ownerLocks ? { ownerLocks } : {}), ...(runtime.windowsBoundary ? { windowsBoundary: runtime.windowsBoundary } : {}) };
}

async function openProductionSources() {
  if (sourceBroker || sourceVault) throw new SafetyLifecycleError('SAFETY_RECOVERY_REQUIRED');
  const data = await runtimeDirectory('data', true);
  const keyDirectory = path.join(runtime.userData, 'safety', 'source-vault');
  const existing = fs.existsSync(keyDirectory) || fs.existsSync(path.join(runtime.userData, 'safety', 'source-vault.enrollment'));
  // Source enrollment is independent of the paid-AI fresh-install exemption.
  // The vault requires its own absent marker, absent keys and empty source store.
  if (!existing && bootRecovery) throw new SafetyLifecycleError('SAFETY_RECOVERY_REQUIRED');
  sourceVault = await (existing ? openSourceVault : createSourceVault)(sourceVaultOptions(path.join(data, 'sources')));
  const capability = randomSecret(), socketPath = path.join(runtime.ipcRoot, 's');
  try {
    sourceBroker = await createSourceBroker({ socketPath, authToken: capability, vault: sourceVault,
      ...(runtime.windowsBoundary ? { windowsBoundary: runtime.windowsBoundary } : {}), onLost: loseRuntimeOwnership });
    sourceEndpoint = Object.freeze({ socketPath, capability });
  } catch (error) { await sourceVault.close(); sourceVault = undefined; throw error; }
}

async function closeProductionSources() {
  await sourceBroker?.close(); sourceBroker = undefined; sourceEndpoint = undefined;
  await sourceVault?.close(); sourceVault = undefined;
}

function backendBootstrap() {
  if (!sourceEndpoint) throw new SafetyLifecycleError('SAFETY_RECOVERY_REQUIRED');
  const bytes = aiGateway.bootstrap();
  try {
    const ai = JSON.parse(bytes.toString('utf8'));
    return Buffer.from(JSON.stringify({ version: 2, ai: { socketPath: ai.socketPath, capability: ai.capability, epoch: ai.epoch }, source: sourceEndpoint }));
  } finally { bytes.fill(0); }
}

async function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.once('error', reject);
    server.listen({ host: '127.0.0.1', port: 0 }, () => {
      const address = server.address();
      server.close(() => resolve(address.port));
    });
  });
}

function binary(...parts) {
  const candidate = runtimeFile(runtimeRoot(), parts, runtime?.postgresBinRoot, process.platform);
  if (!fs.existsSync(candidate)) throw new Error(`Bundled runtime file is missing: ${candidate}`);
  return candidate;
}

function assertAbsolutePath(raw) {
  if (typeof raw !== 'string' || raw.length === 0 || !path.isAbsolute(raw)) {
    throw new Error('A non-empty absolute path is required.');
  }
  return raw;
}

function assertRuntimeRelativePath(raw, label) {
  return runtimeRelativePath(raw, label, process.platform);
}

function isTrustedRenderer(event) {
  if (!mainWindow || !runtime || !event.senderFrame
      || event.sender !== mainWindow.webContents
      || event.senderFrame !== mainWindow.webContents.mainFrame) return false;
  try {
    return new URL(event.senderFrame.url).origin === new URL(runtime.apiBaseUrl).origin;
  } catch { return false; }
}

function assertTrustedRenderer(event) {
  if (!isTrustedRenderer(event)) throw new Error('Untrusted renderer IPC request.');
}

async function verifyRuntimeIntegrity() {
  const root = runtimeRoot();
  const manifestFile = path.join(root, 'runtime-manifest.json');
  if (!fs.existsSync(manifestFile)) {
    throw new Error('Bundled desktop runtime is missing or incomplete. Run `npm run stage` before launching.');
  }
  const manifest = JSON.parse(await fsp.readFile(manifestFile, 'utf8'));
  if (manifest.format !== 1 || manifest.platform !== process.platform || manifest.arch !== process.arch) {
    throw new Error('Bundled runtime manifest does not match this platform.');
  }
  requireBuildSequence(manifest.buildSequence);
  if (manifest.backupProtocol !== undefined && manifest.backupProtocol !== 3) {
    throw new Error('The bundled backup protocol is unsupported. Install a reviewed build.');
  }
  if (manifest.ownershipProtocol !== undefined && manifest.ownershipProtocol !== 1
      || manifest.backupProtocol === 3 && manifest.ownershipProtocol !== 1) {
    throw new Error('The bundled recovery ownership protocol is missing or unsupported. Install a reviewed build.');
  }
  if (!manifest.runtime?.postgresBin || !manifest.runtime?.postgresLib
      || !manifest.runtime?.postgresPkgLib || !manifest.runtime?.postgresShare
      || !manifest.files || typeof manifest.files !== 'object') {
    throw new Error('Bundled runtime manifest has no PostgreSQL layout. Re-run `npm run stage`.');
  }
  await validateRuntimeManifest(root, manifest);
  manifest.runtime = {
    ...(manifest.runtime.cache ? { cache: manifest.runtime.cache } : {}),
    postgresBin: assertRuntimeRelativePath(manifest.runtime.postgresBin, 'PostgreSQL bin path'),
    postgresLib: assertRuntimeRelativePath(manifest.runtime.postgresLib, 'PostgreSQL library path'),
    postgresPkgLib: assertRuntimeRelativePath(manifest.runtime.postgresPkgLib, 'PostgreSQL extension path'),
    postgresShare: assertRuntimeRelativePath(manifest.runtime.postgresShare, 'PostgreSQL share path')
  };
  return manifest;
}

function childLogPath(name) {
  if (runtime?.windowsBoundary) {
    const logs = path.join(runtime.userData, 'logs');
    if (!fs.existsSync(logs)) runtime.windowsBoundary.createDirectory(logs);
    runtime.windowsBoundary.inspect(logs, { directory: true });
    return path.join(logs, `${name}.log`);
  }
  const logs = path.join(app.getPath('logs'), 'runtime');
  fs.mkdirSync(logs, { recursive: true, mode: 0o700 });
  return path.join(logs, `${name}.log`);
}

function bundledChildEnvironment(explicit = {}) {
  return { ...inheritedEnvironment(process.env, process.platform),
    ...(isolatedPlan ? isolatedChildEnvironment(isolatedPlan) : {}), ...explicit };
}

async function spawnManaged(name, command, args, options = {}) {
  if (children.has(name)) throw new SafetyLifecycleError('SAFETY_RECOVERY_REQUIRED');
  const guarded = runtimeManifest.ownershipProtocol === 1;
  const logPath = childLogPath(name), log = guarded ? null : fs.openSync(logPath, 'a', 0o600);
  let child;
  try { child = guarded ? await spawnManagedProcess({
    javaPath: binary('jre', 'bin', 'java'), jarPath: binary('backend', 'code-intelligence.jar'),
    command, args, cwd: options.cwd || runtime.userData, env: bundledChildEnvironment(options.env),
    logPath, ...(options.bootstrap ? { bootstrap: options.bootstrap } : {})
  }) : spawn(command, args, {
    cwd: options.cwd || runtime.userData,
    env: bundledChildEnvironment(options.env),
    stdio: [options.bootstrap ? 'pipe' : 'ignore', log, log],
    windowsHide: true
  }); } catch (error) {
    if (log !== null) fs.closeSync(log);
    if (error.managedProcess && !error.managedProcess.stopped()) children.set(name, error.managedProcess);
    runtime.ready = false; runtime.recoveryRequired = true;
    throw new SafetyLifecycleError('SAFETY_RECOVERY_REQUIRED');
  }
  children.set(name, child);
  let spawned = Number.isInteger(child.pid) && child.pid > 0;
  child.once('spawn', () => { spawned = true; });
  let settled = false;
  const onStopped = (reason) => {
    if (settled) return;
    settled = true;
    if (log !== null) fs.closeSync(log);
    const owned = children.get(name) === child;
    const unexpected = owned && !childStops.has(child);
    if (owned) children.delete(name);
    if (unexpected && !stopping && runtime?.ready) {
      runtime.ready = false;
      runtime.error = `${name} stopped (${reason})`;
      mainWindow?.webContents.send('runtime:changed', publicRuntimeStatus());
      scheduleRestart();
    }
  };
  const onFailed = () => {
    if (settled) return;
    if (!spawned && !(Number.isInteger(child.pid) && child.pid > 0)) { onStopped('spawn error'); return; }
    // A kill/IPC error is not exit evidence. Keep the live process owned until its real exit.
    runtime = runtime || { ready: false };
    runtime.ready = false; runtime.recoveryRequired = true;
    runtime.error = 'A bundled service requires recovery before restart.';
    Promise.resolve().then(() => aiGateway?.latchOffline('USER_OFF')).catch(() => {});
  };
  child.once('exit', (code, signal) => onStopped(code ?? signal));
  child.on('error', onFailed);
  if (options.bootstrap && !guarded) {
    const bootstrap = options.bootstrap;
    const bootstrapFailed = () => {
      bootstrap.fill(0); onFailed();
      try { child.kill('SIGTERM'); } catch { onFailed(); }
    };
    child.stdin.on('error', bootstrapFailed);
    try { child.stdin.end(bootstrap, () => bootstrap.fill(0)); } catch { bootstrapFailed(); }
    child.once('exit', () => bootstrap.fill(0));
  }
  // A guardian may report target exit or failed cleanup before the awaiting caller installs listeners.
  if (child.failure) onFailed();
  if (child.exitCode != null || child.signalCode != null) onStopped(child.exitCode ?? child.signalCode);
  if (settled || child.failure) throw new SafetyLifecycleError('SAFETY_RECOVERY_REQUIRED');
  return child;
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd || app.getPath('userData'),
    env: bundledChildEnvironment(options.env),
    encoding: 'utf8',
    timeout: options.timeout || 120_000
  });
  if (result.status !== 0) {
    throw new Error(`${path.basename(command)} failed: ${(result.stderr || result.stdout || '').trim()}`);
  }
  return result.stdout.trim();
}

async function waitUntil(check, label, timeoutMs = 60_000) {
  const deadline = Date.now() + timeoutMs;
  let lastError;
  while (Date.now() < deadline) {
    try {
      if (await check()) return;
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`${label} did not become ready${lastError ? `: ${lastError.message}` : ''}`);
}

function postgresEnvironment() {
  return {
    ...(process.platform === 'win32' ? {} : libraryEnvironment(runtimeRoot(), [runtime.postgresLibRoot], process.env, process.platform)),
    PGPASSWORD: runtime.secrets.databasePassword,
    ...runtime.transport.postgresEnvironment
  };
}

async function startPostgres({ recoveryOnly = false } = {}) {
  const data = await runtimeDirectory('postgres', true);
  if (recoveryOnly && !fs.existsSync(path.join(data, 'PG_VERSION'))) throw new SafetyLifecycleError('SAFETY_RECOVERY_REQUIRED');
  const initdb = binary('postgres', 'bin', 'initdb');
  const postgres = binary('postgres', 'bin', 'postgres');
  const pgIsReady = binary('postgres', 'bin', 'pg_isready');
  const psql = binary('postgres', 'bin', 'psql');
  const createdb = binary('postgres', 'bin', 'createdb');
  const env = postgresEnvironment();

  if (!fs.existsSync(path.join(data, 'PG_VERSION'))) {
    const passwordFile = path.join(runtime.userData, `.pg-password-${crypto.randomUUID()}`);
    const bytes = Buffer.from(runtime.secrets.databasePassword); let passwordState;
    try { if (runtime.windowsBoundary) passwordState = await writeStorageFile(runtime.storage, passwordFile, bytes);
      else fs.writeFileSync(passwordFile, bytes, { mode: 0o600, flag: 'wx' }); } finally { bytes.fill(0); }
    try {
      run(initdb, [
        '-D', data,
        '-U', 'codeintel',
        '--encoding=UTF8',
        '--auth-local=reject',
        '--auth-host=scram-sha-256',
        `--pwfile=${passwordFile}`
      ], { env });
    } finally {
      if (runtime.windowsBoundary) await runtime.storage.remove(passwordFile, passwordState);
      else fs.rmSync(passwordFile);
    }
  }

  await spawnManaged('postgres', postgres, [
    '-D', data,
    '-h', '127.0.0.1',
    '-p', String(runtime.ports.postgres),
    '-c', 'listen_addresses=127.0.0.1',
    '-c', 'max_connections=40',
    '-c', 'ssl=on',
    '-c', 'ssl_min_protocol_version=TLSv1.2',
    '-c', 'unix_socket_directories=',
    '-c', `ssl_cert_file=${runtime.transport.materials.postgres.cert}`,
    '-c', `ssl_key_file=${runtime.transport.materials.postgres.key}`,
    '-c', `hba_file=${runtime.transport.hba}`
  ], { env });
  await waitUntil(() => {
    const result = spawnSync(pgIsReady, [
      '-h', '127.0.0.1', '-p', String(runtime.ports.postgres), '-U', 'codeintel'
    ], { env: bundledChildEnvironment(env), stdio: 'ignore' });
    return result.status === 0;
  }, 'PostgreSQL');

  // Readiness alone could be a different server that won the ephemeral port. Prove the owned
  // postmaster PID, data directory and cluster identity before any SQL can mutate a database.
  const origin = await openBackupProductState();
  try { await origin.verifyOrigin(); } finally { await origin.close(); }

  if (recoveryOnly) return;

  const exists = run(psql, [
    '-X', '--no-password', '--set=ON_ERROR_STOP=1',
    '-h', '127.0.0.1', '-p', String(runtime.ports.postgres), '-U', 'codeintel',
    '-d', 'postgres', '-tAc', "select 1 from pg_database where datname='codeintel'"
  ], { env });
  if (exists !== '1') {
    run(createdb, [
      '-h', '127.0.0.1', '-p', String(runtime.ports.postgres), '-U', 'codeintel', 'codeintel'
    ], { env });
  }
  run(psql, [
    '-X', '--no-password',
    '-h', '127.0.0.1', '-p', String(runtime.ports.postgres), '-U', 'codeintel',
    '-d', 'codeintel', '-v', 'ON_ERROR_STOP=1', '-c',
    'create extension if not exists vector; create extension if not exists pg_trgm;'
  ], { env });
}

async function startRedis() {
  const data = await runtimeDirectory('redis', true);
  const args = runtime.windowsBoundary
    ? ['--config-import-path', runtime.transport.redisConfig, '--config-import-format', 'Garnet']
    : [runtime.transport.redisConfig, '--dir', data, '--dbfilename', 'dump.rdb', '--appendonly', 'yes'];
  await spawnManaged('redis', binary('redis', 'bin', 'redis-server'), args, {
    env: {
      ...libraryEnvironment(runtimeRoot(), process.platform === 'win32' ? ['cache'] : ['redis/lib'], process.env, process.platform)
    }
  });
  await waitUntil(() => runtime.transport.redisReady(), 'Redis');
}

async function startAnalyzer() {
  const main = binary('ts-analyzer', 'dist', 'main.js');
  await spawnManaged('ts-analyzer', process.execPath, [main], {
    cwd: path.dirname(main),
    env: {
      ELECTRON_RUN_AS_NODE: '1',
      TS_ANALYZER_PORT: String(runtime.ports.analyzer),
      TS_ANALYZER_HOST: '127.0.0.1',
      TS_ANALYZER_TLS_CERT_FILE: runtime.transport.materials.analyzer.cert,
      TS_ANALYZER_TLS_KEY_FILE: runtime.transport.materials.analyzer.key,
      TS_ANALYZER_AUTH_TOKEN: runtime.transport.analyzerToken,
      NODE_ENV: 'production'
    }
  });
  await waitUntil(async () => {
    const response = await runtime.transport.analyzer.request(`${runtime.transport.analyzer.origin}/health`).catch(() => null);
    return response?.ok;
  }, 'TypeScript analyzer');
}

async function authorizePath(selected, persist = true) {
  const canonical = await fsp.realpath(assertAbsolutePath(selected));
  const response = await runtime.transport.backend.request(`${runtime.apiBaseUrl}/api/desktop/paths`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Code-Intelligence-Token': runtime.apiToken,
      'X-Code-Intelligence-Path-Token': runtime.pathToken
    },
    body: JSON.stringify({ path: canonical })
  });
  if (!response.ok) throw new Error(`Folder authorization failed (${response.status})`);
  const result = await response.json();
  if (persist && !runtime.authorizedRoots.includes(result.path)) {
    runtime.authorizedRoots.push(result.path);
    await saveEncryptedJson(runtime.pathsFile, runtime.authorizedRoots);
  }
  return result.path;
}

async function startBackend({ maintenanceId = '' } = {}) {
  const java = binary('jre', 'bin', 'java');
  const jar = binary('backend', 'code-intelligence.jar');
  const dataDir = await runtimeDirectory('data', true);
  await openProductionSources();
  await spawnManaged('backend', java, ['-XX:MaxRAMPercentage=55',
    ...(runtime.windowsBoundary ? [`-Dcodeintelligence.windows.runtimeRoot=${runtimeRoot()}`] : []),
    '-jar', jar, '--spring.profiles.active=desktop'], {
    bootstrap: backendBootstrap(),
    env: {
      SERVER_ADDRESS: '127.0.0.1',
      SERVER_PORT: String(runtime.ports.backend),
      DB_URL: runtime.transport.jdbcUrl,
      DB_USERNAME: 'codeintel',
      DB_PASSWORD: runtime.secrets.databasePassword,
      REDIS_HOST: '127.0.0.1',
      REDIS_PORT: String(runtime.ports.redis),
      REDIS_PASSWORD: runtime.transport.redisPassword,
      SPRING_CONFIG_ADDITIONAL_LOCATION: runtime.transport.backendConfigUrl,
      TOKEN_ENC_KEY: runtime.secrets.tokenEncryptionKey,
      DATA_DIR: dataDir,
      TS_ANALYZER_BASE_URL: runtime.transport.analyzer.origin,
      TS_ANALYZER_TLS_CERT_SHA256: runtime.transport.materials.analyzer.pin,
      TS_ANALYZER_AUTH_TOKEN: runtime.transport.analyzerToken,
      DESKTOP_API_TOKEN: runtime.apiToken,
      DESKTOP_PATH_TOKEN: runtime.pathToken,
      DESKTOP_LOCAL_IDENTITY: runtime.secrets.localIdentity,
      DESKTOP_ALLOWED_ORIGIN: runtime.apiBaseUrl,
      APP_DESKTOP_AI_BOOTSTRAP_STDIN: 'true',
      APP_DESKTOP_MAINTENANCE_STARTUP_ID: maintenanceId,
      GITHUB_NATIVE_CLIENT_ID: process.env.GITHUB_NATIVE_CLIENT_ID || '',
      CORS_ALLOWED_ORIGINS: runtime.apiBaseUrl
    }
  });
  await waitUntil(async () => {
    const response = await runtime.transport.backend.request(`${runtime.apiBaseUrl}/actuator/health`).catch(() => null);
    return response?.ok;
  }, 'Backend', 90_000);
  if (maintenanceId) return;
  assertSafetyReady();
  for (const root of [...runtime.authorizedRoots]) {
    try {
      await authorizePath(root, false);
    } catch {
      runtime.authorizedRoots = runtime.authorizedRoots.filter((entry) => entry !== root);
    }
  }
  await saveEncryptedJson(runtime.pathsFile, runtime.authorizedRoots);
}

async function startRuntime() {
  if (quitting) throw new Error('Runtime is shutting down.');
  assertSafetyReady();
  stopping = false;
  runtime.ready = false;
  runtime.error = null;
  noteStartup('POSTGRES');
  await startPostgres();
  if (quitting) throw new Error('Runtime is shutting down.');
  assertSafetyReady();
  noteStartup('CACHE_AND_ANALYZER');
  await Promise.all([startRedis(), startAnalyzer()]);
  if (quitting) throw new Error('Runtime is shutting down.');
  assertSafetyReady();
  noteStartup('BACKEND');
  await startBackend();
  if (quitting) throw new Error('Runtime is shutting down.');
  assertSafetyReady();
  runtime.ready = true;
  restartAttempts = 0;
  mainWindow?.webContents.send('runtime:changed', publicRuntimeStatus());
}

async function stopChild(name) {
  const child = children.get(name);
  if (!child) return;
  if (childStops.has(child)) return childStops.get(child);
  if (child.exitCode != null || child.signalCode != null) {
    if (children.get(name) === child) children.delete(name);
    return;
  }
  // Keep ownership visible while termination is uncertain. Concurrent loss/shutdown/backup
  // callers must join this proof instead of observing an empty registry and releasing B.
  const stoppingChild = Promise.resolve().then(async () => {
  const waitForExit = async (signal) => {
    let timer;
    let onExit;
    const exited = new Promise((resolve) => {
      onExit = () => resolve(true);
      child.once('exit', onExit);
    });
    try {
      child.kill(signal);
      return await Promise.race([
        exited,
        new Promise((resolve) => { timer = setTimeout(() => resolve(false), 5000); })
      ]);
    } finally {
      clearTimeout(timer);
      child.removeListener('exit', onExit);
    }
  };
  try {
    if (!await waitForExit('SIGTERM') && !await waitForExit('SIGKILL')) {
      throw new Error(`${name} did not stop; refusing to start a second instance.`);
    }
  } catch (error) {
    // kill() can throw synchronously. A failed signal is not proof that the child stopped.
    if (child.exitCode == null && child.signalCode == null) children.set(name, child);
    throw error;
  }
  if (children.get(name) === child) children.delete(name);
  }).finally(() => childStops.delete(child));
  childStops.set(child, stoppingChild);
  return stoppingChild;
}

async function stopRuntime({ keepDatabase = false } = {}) {
  stopping = true;
  clearTimeout(restartTimer);
  restartTimer = null;
  runtime = runtime || { ready: false };
  runtime.ready = false;
  let failure;
  // Even on a latch failure, stop every child. A restart must propagate that failure.
  if (safetyLifecycle) {
    try {
      if (bootRecovery) await safetyLifecycle.latch('RESTART_RECONCILIATION');
      else await latchSafety('RESTART_RECONCILIATION');
    } catch (error) { failure = error; }
  }
  for (const name of ['backend', 'ts-analyzer', 'redis', ...(keepDatabase ? [] : ['postgres'])]) {
    try { await stopChild(name); } catch (error) { failure ||= error; }
  }
  if (!children.has('backend') && !children.has('ts-analyzer')) {
    try { await closeProductionSources(); } catch (error) { failure ||= error; }
  }
  runtime.ready = false;
  if (failure) throw failure;
}

function scheduleRestart() {
  if (quitting || runtime?.recoveryRequired || restartTimer || restartAttempts >= 3) return;
  const delay = 1000 * 2 ** restartAttempts++;
  restartTimer = setTimeout(() => {
    restartTimer = null;
    withRuntimeOperation(async () => {
      await stopRuntime();
      await startRuntime();
    }).catch((error) => {
      runtime.error = error.message;
      scheduleRestart();
    });
  }, delay);
}

function safetyStatus() {
  try {
    const status = safetyLifecycle?.diagnostics();
    return { aiOff: status?.aiOff !== false, recoveryOnly: !status || typeof status.aiOff !== 'boolean' || status.recoveryOnly !== false };
  } catch { return { aiOff: true, recoveryOnly: true }; }
}

function assertSafetyReady() {
  if (runtime?.recoveryRequired || safetyStatus().recoveryOnly) {
    throw new SafetyLifecycleError('SAFETY_RECOVERY_REQUIRED');
  }
}

async function latchSafety(reason) {
  try {
    // An A/startup failure must not prevent writing OFF to an otherwise healthy B during shutdown.
    if (safetyStatus().recoveryOnly) throw new SafetyLifecycleError('SAFETY_RECOVERY_REQUIRED');
    await safetyLifecycle.latch(reason);
    if (safetyStatus().recoveryOnly) throw new SafetyLifecycleError('SAFETY_RECOVERY_REQUIRED');
  } catch {
    runtime = runtime || { ready: false };
    runtime.ready = false;
    runtime.recoveryRequired = true;
    const failure = new SafetyLifecycleError('SAFETY_RECOVERY_REQUIRED');
    runtime.error = failure.message;
    throw failure;
  }
}

function shutdownRuntime() {
  if (shutdownPromise) return shutdownPromise;
  quitting = true;
  stopping = true;
  clearTimeout(restartTimer);
  restartTimer = null;
  // Startup and maintenance share this queue, so shutdown cannot close a half-published handle.
  shutdownPromise = withRuntimeOperation(async () => {
    let failure;
    try { await stopRuntime(); } catch (error) { failure = error; }
    // Unconfirmed children or source drain retain the same safety ownership.
    if (children.size === 0 && !sourceBroker && !sourceVault) {
      try { await safetyLifecycle?.close(); } catch (error) { failure ||= error; }
      try { await aiPostgres?.close(); } catch (error) { failure ||= error; }
      try { await ownerLocks?.close(); } catch (error) { failure ||= error; }
      try { await runtime?.transport?.close(); } catch (error) { failure ||= error; }
      try { await runtime?.storage?.close(); } catch (error) { failure ||= error; }
      if (runtime?.ipcRoot) {
        try { if (runtime.windowsBoundary) {
          await runtime.ipcStorage.close();
          runtime.windowsBoundary.removeDirectory(runtime.ipcRoot, runtime.ipcIdentity);
        } else {
          const actual = await fsp.lstat(runtime.ipcRoot);
          if (actual.dev !== runtime.ipcIdentity.dev || actual.ino !== runtime.ipcIdentity.ino) throw new Error('IPC root changed.');
          await fsp.rmdir(runtime.ipcRoot);
        } } catch (error) { failure ||= error; }
      }
    }
    if (failure) throw new SafetyLifecycleError('SAFETY_RECOVERY_REQUIRED');
  });
  return shutdownPromise;
}

function publicRuntimeStatus() {
  return {
    ready: Boolean(runtime?.ready),
    error: runtime?.error || null,
    services: [...children.keys()],
    aiOff: safetyStatus().aiOff,
    recoveryOnly: Boolean(runtime?.recoveryRequired || safetyStatus().recoveryOnly),
    backupAvailable: Boolean(backupRuntime && runtime?.ready && !runtime?.recoveryRequired && !safetyStatus().recoveryOnly),
    restoreAvailable: Boolean(backupRuntime && runtime?.ready && !runtime?.recoveryRequired && !safetyStatus().recoveryOnly)
  };
}

function assertExternalUrl(raw) {
  if (typeof raw !== 'string' || raw.length === 0) {
    throw new Error('External URL must be a non-empty string.');
  }
  const url = new URL(raw);
  const allowedOrigins = new Set(['https://github.com', 'https://docs.github.com']);
  if (url.origin === 'null'
      || url.username
      || url.password
      || !allowedOrigins.has(url.origin)) {
    throw new Error('External URL is not allowlisted.');
  }
  return url.toString();
}

async function hashFile(file) {
  const hash = crypto.createHash('sha256');
  for await (const chunk of fs.createReadStream(file)) hash.update(chunk);
  return hash.digest('hex');
}

function backupConnection(database = 'codeintel') {
  return { host: '127.0.0.1', port: runtime.ports.postgres, user: 'codeintel', database };
}

async function openBackupProductState() {
  const userData = runtime.userData;
  const dataRoot = await runtimeDirectory('data', true);
  return createBackupProductState({ psqlPath: binary('postgres', 'bin', 'psql'),
    connection: { host: '127.0.0.1', port: runtime.ports.postgres, user: 'codeintel' }, env: postgresEnvironment(),
    expectedDataDirectory: path.join(userData, 'postgres'), ownedPostgres: children.get('postgres'), dataRoot,
    ...(runtime.windowsBoundary ? { windowsBoundary: runtime.windowsBoundary } : {}) });
}

async function maintenanceControl(transactionId, operation) {
  const response = await runtime.transport.backend.request(`${runtime.apiBaseUrl}/api/desktop/maintenance`, {
    method: 'POST', signal: AbortSignal.timeout(10000),
    headers: { 'Content-Type': 'application/json', 'X-Code-Intelligence-Token': runtime.apiToken,
      'X-Code-Intelligence-Path-Token': runtime.pathToken }, body: JSON.stringify({ transactionId, operation })
  });
  if (!response.ok) throw new Error('The application could not enter backup maintenance.');
  const value = await response.json();
  if (value.transactionId !== transactionId || !['DRAINED', 'DRAINING'].includes(value.state)
      || ['activeRequests', 'activeWriters', 'activeJobs'].some(key => !Number.isSafeInteger(value[key]) || value[key] < 0)) {
    throw new Error('The application maintenance state could not be verified.');
  }
  return value;
}

async function pauseForBackup({ transactionId, waitForAiDrain, recovery = false }) {
  if (recovery) {
    if (!bootRecovery || runtime.ready || quitting || children.has('backend') || children.has('ts-analyzer') || children.has('redis')) {
      throw new SafetyLifecycleError('SAFETY_RECOVERY_REQUIRED');
    }
    stopping = true; await waitForAiDrain(); return;
  }
  if (!runtime.ready || quitting || runtime.recoveryRequired) throw new SafetyLifecycleError('SAFETY_RECOVERY_REQUIRED');
  runtime.ready = false; stopping = true; clearTimeout(restartTimer); restartTimer = null;
  mainWindow?.webContents.send('runtime:changed', publicRuntimeStatus());
  const end = Date.now() + 120000; let operation = 'BEGIN';
  for (;;) {
    const value = await maintenanceControl(transactionId, operation);
    if (value.state === 'DRAINED' && !value.activeRequests && !value.activeWriters && !value.activeJobs) break;
    if (Date.now() >= end || quitting) throw new Error('Active work did not finish before the backup deadline.');
    operation = 'STATUS'; await new Promise(resolve => setTimeout(resolve, 200));
  }
  await waitForAiDrain();
  await stopChild('backend'); await stopChild('ts-analyzer');
  await closeProductionSources();
}

async function syncBackupDirectory(root) {
  const stat = await fsp.lstat(root);
  if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== process.getuid() || (stat.mode & 0o777) !== 0o700
      || await fsp.realpath(root) !== root) throw new SafetyLifecycleError('SAFETY_RECOVERY_REQUIRED');
  const handle = await fsp.open(root, fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW);
  try { const opened = await handle.stat(); if (opened.dev !== stat.dev || opened.ino !== stat.ino) throw new Error('Directory changed.');
    await handle.sync(); } finally { await handle.close(); }
}

async function invalidateBackupAuthority({ transactionId, checkpointRoot, recovery = false }) {
  const userData = runtime.userData;
  if (checkpointRoot !== path.join(userData, 'recovery', transactionId)) throw new SafetyLifecycleError('SAFETY_RECOVERY_REQUIRED');
  // Both success and rollback must restart with fresh sessions and explicit local folder grants.
  await stopChild('redis');
  if (recovery && !bootRecovery) throw new SafetyLifecycleError('SAFETY_RECOVERY_REQUIRED');
  if (runtime.windowsBoundary) {
    // Garnet storage/AOF/recovery are disabled; proved process exit revokes every server-side session.
    await runtime.storage.stat(path.relative(userData, checkpointRoot), { directory: true });
    await saveEncryptedJson(runtime.pathsFile, []); runtime.authorizedRoots = [];
    runtime.apiToken = randomSecret(); runtime.pathToken = randomSecret();
    if (mainWindow) { await mainWindow.webContents.session.clearStorageData({ origin: runtime.apiBaseUrl }); await mainWindow.webContents.session.clearCache(); }
    return;
  }
  const redis = path.join(userData, 'redis');
  const sessionRoot = recovery ? path.join(checkpointRoot, 'verification') : checkpointRoot;
  if (recovery) await syncBackupDirectory(sessionRoot);
  const previous = path.join(sessionRoot, recovery ? `recovery-sessions-${crypto.randomUUID()}` : 'previous-redis');
  await syncBackupDirectory(userData); await syncBackupDirectory(checkpointRoot);
  try { await fsp.lstat(previous); throw new Error('Recovery session checkpoint already exists.'); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  let redisExists = true;
  try { await syncBackupDirectory(redis); } catch (error) { if (recovery && error.code === 'ENOENT') redisExists = false; else throw error; }
  if (redisExists) {
    await fsp.rename(redis, previous); await syncBackupDirectory(userData); await syncBackupDirectory(sessionRoot);
  }
  await fsp.mkdir(redis, { mode: 0o700 }); await syncBackupDirectory(userData);
  runtime.authorizedRoots = [];
  const temporary = path.join(userData, `.revoked-paths-${transactionId}-${crypto.randomUUID()}`);
  const file = await fsp.open(temporary, fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY | fs.constants.O_NOFOLLOW, 0o600);
  try { await file.writeFile(safeStorage.encryptString('[]')); await file.sync(); } finally { await file.close(); }
  await fsp.rename(temporary, runtime.pathsFile); await syncBackupDirectory(userData);
  runtime.apiToken = randomSecret(); runtime.pathToken = randomSecret();
  if (mainWindow) {
    await mainWindow.webContents.session.clearStorageData({ origin: runtime.apiBaseUrl });
    await mainWindow.webContents.session.clearCache();
  }
}

async function prepareResumeAfterBackup({ transactionId }) {
  if (quitting) throw new Error('Application shutdown interrupted maintenance completion.');
  if (!children.has('redis')) await startRedis();
  if (!children.has('ts-analyzer')) await startAnalyzer();
  await startBackend({ maintenanceId: transactionId });
  const status = await maintenanceControl(transactionId, 'STATUS');
  if (status.state !== 'DRAINED' || status.activeRequests || status.activeWriters || status.activeJobs) {
    throw new Error('The restored runtime has not finished its startup checks.');
  }
}

async function resumeAfterBackup({ transactionId, restored, recovery = false }) {
  if (quitting) throw new Error('Application shutdown interrupted maintenance completion.');
  if (recovery) {
    if (!bootRecovery || runtime.ready) throw new SafetyLifecycleError('SAFETY_RECOVERY_REQUIRED');
    // Restricted startup checks never release the backend barrier. Reopen all B capabilities
    // in normal mode only after these health-check children have proved their exit.
    await stopChild('backend'); await stopChild('ts-analyzer'); await stopChild('redis');
    await closeProductionSources();
    return;
  }
  assertSafetyReady();
  const status = await maintenanceControl(transactionId, 'END');
  if (status.state !== 'DRAINED' || status.activeRequests || status.activeWriters || status.activeJobs) {
    throw new Error('The application maintenance barrier did not release from a drained state.');
  }
  if (!restored) {
    for (const root of [...runtime.authorizedRoots]) {
      try { await authorizePath(root, false); }
      catch { runtime.authorizedRoots = runtime.authorizedRoots.filter(entry => entry !== root); }
    }
    await saveEncryptedJson(runtime.pathsFile, runtime.authorizedRoots);
  }
  stopping = false; runtime.ready = true; runtime.error = null;
  if (restored) await mainWindow?.loadURL(runtime.apiBaseUrl);
  mainWindow?.webContents.send('runtime:changed', publicRuntimeStatus());
}

function backupPorts() {
  const userData = runtime.userData || app.getPath('userData');
  const pg = (database, mode) => createBackupPostgres({ psqlPath: binary('postgres', 'bin', 'psql'),
    migrationRoot: path.join(runtimeRoot(), 'backend', 'backup-migrations'), installationId: runtime.secrets.localIdentity,
    connection: backupConnection(database), env: postgresEnvironment(), mode,
    ...(runtime.windowsBoundary ? { windowsBoundary: runtime.windowsBoundary } : {}) });
  const vaultOptions = sourceVaultOptions;
  return {
    capacityRoots: async () => ({ postgres: path.join(userData, 'postgres'), source: path.join(userData, 'data'),
      bundle: await fsp.realpath(runtimeRoot()) }),
    pause: pauseForBackup, prepareResume: prepareResumeAfterBackup, resume: resumeAfterBackup, invalidateAuthority: invalidateBackupAuthority,
    async failure() {
      runtime.ready = false; runtime.recoveryRequired = true;
      runtime.error = 'Backup or restore requires offline recovery. Preserved data was not discarded.';
      stopping = true; clearTimeout(restartTimer); restartTimer = null;
      // Stop every possible writer even if a different child fails to terminate. Keep PostgreSQL
      // owned for inspection; normal startup/AI remain blocked by the outstanding recovery state.
      const stopped = await Promise.allSettled(['backend', 'ts-analyzer', 'redis'].map(stopChild));
      if (!children.has('backend') && !children.has('ts-analyzer')) await closeProductionSources();
      mainWindow?.webContents.send('runtime:changed', publicRuntimeStatus());
      if (stopped.some(result => result.status === 'rejected')) throw new SafetyLifecycleError('SAFETY_RECOVERY_REQUIRED');
    },
    openExport: () => pg('codeintel', 'export'), openStage: database => pg(database, 'staging'),
    productState: openBackupProductState,
    database: (options = {}) => createBackupDatabaseControl({ psqlPath: binary('postgres', 'bin', 'psql'),
      connection: { host: '127.0.0.1', port: runtime.ports.postgres, user: 'codeintel' }, env: postgresEnvironment(), liveDatabase: 'codeintel',
      ...(runtime.windowsBoundary ? { windowsBoundary: runtime.windowsBoundary } : {}),
      ...(options.readRetentionAuthority ? { readRetentionAuthority: options.readRetentionAuthority } : {}) }),
    sourceWorker: () => createBackupSourceWorker({ javaPath: binary('jre', 'bin', 'java'), jarPath: binary('backend', 'code-intelligence.jar'),
      ...(runtime.windowsBoundary ? { windowsBoundary: runtime.windowsBoundary, runtimeRoot: runtimeRoot() } : {}) }),
    async sourceReader() {
      if (sourceVault || sourceBroker) throw new SafetyLifecycleError('SAFETY_RECOVERY_REQUIRED');
      const vault = await openSourceVault(vaultOptions(path.join(userData, 'data', 'sources')));
      return Object.freeze({ read: vault.read, close: vault.close });
    },
    async exportVault(refs, writePacket) {
      if (sourceVault || sourceBroker) throw new SafetyLifecycleError('SAFETY_RECOVERY_REQUIRED');
      const vault = await openSourceVault(vaultOptions(path.join(userData, 'data', 'sources')));
      try { for (const ref of refs) await writePacket(await vault.exportCiphertext(ref)); } finally { await vault.close(); }
    },
    async restoreVault(root, packets) {
      if (sourceVault || sourceBroker) throw new SafetyLifecycleError('SAFETY_RECOVERY_REQUIRED');
      const vault = await openSourceVaultRestoreStage(vaultOptions(root));
      try { for await (const packet of packets) await vault.importCiphertext(packet); } finally { await vault.close(); }
    }
  };
}

function createBackup(selected) {
  if (!backupRuntime) throw new Error('Backup is unavailable until protected exports are ready. Existing data was not changed.');
  assertSafetyReady(); return backupRuntime.backup(selected);
}

async function backupWithDialog() {
  if (!backupRuntime) return createBackup();
  assertSafetyReady();
  const selected = await dialog.showOpenDialog(mainWindow, { title: 'Choose where to save an encrypted backup', properties: ['openDirectory'] });
  return selected.canceled ? null : createBackup(selected.filePaths[0]);
}

async function restoreWithDialog() {
  if (!backupRuntime) throw new Error('Restore is unavailable until safe recovery is ready. Existing data was not changed.');
  assertSafetyReady();
  const selected = await dialog.showOpenDialog(mainWindow, { title: 'Choose an encrypted backup from this installation',
    properties: ['openFile'], filters: [{ name: 'Code Intelligence encrypted backup', extensions: ['cibackup'] }] });
  return selected.canceled ? null : backupRuntime.restore(selected.filePaths[0]);
}

function registerIpc() {
  ipcMain.on('runtime:config', (event) => {
    if (!isTrustedRenderer(event)) { event.returnValue = null; return; }
    event.returnValue = { apiBaseUrl: runtime.apiBaseUrl, apiToken: runtime.apiToken, appVersion: app.getVersion() };
  });
  ipcMain.handle('runtime:status', (event) => {
    assertTrustedRenderer(event);
    return publicRuntimeStatus();
  });
  ipcMain.handle('runtime:restart', async (event) => {
    assertTrustedRenderer(event);
    return withRuntimeOperation(async () => {
      if (runtime.recoveryRequired) throw new Error('Restore rollback requires recovery before restarting.');
      await stopRuntime();
      await startRuntime();
      return publicRuntimeStatus();
    });
  });
  ipcMain.handle('folder:pick', async (event) => {
    assertTrustedRenderer(event);
    return withRuntimeOperation(async () => {
      assertSafetyReady();
      const result = await dialog.showOpenDialog(mainWindow, {
        title: 'Choose a source folder to analyze', properties: ['openDirectory']
      });
      return result.canceled ? null : authorizePath(result.filePaths[0]);
    });
  });
  ipcMain.handle('folder:authorize', (event, selected) => {
    assertTrustedRenderer(event);
    return withRuntimeOperation(() => { assertSafetyReady(); return authorizePath(assertAbsolutePath(selected)); });
  });
  ipcMain.handle('external:open', (event, url) => {
    assertTrustedRenderer(event);
    return shell.openExternal(assertExternalUrl(url));
  });
  ipcMain.handle('data:backup', (event) => {
    assertTrustedRenderer(event);
    return withRuntimeOperation(backupWithDialog);
  });
  ipcMain.handle('data:restore', (event) => {
    assertTrustedRenderer(event);
    return withRuntimeOperation(restoreWithDialog);
  });
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1440,
    height: 960,
    minWidth: 980,
    minHeight: 700,
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      webSecurity: true
    }
  });
  const appOrigin = new URL(runtime.apiBaseUrl).origin;
  mainWindow.webContents.session.setCertificateVerifyProc((request, callback) => {
    if (request.hostname !== '127.0.0.1') return callback(-3);
    callback(runtime.transport.verifyBackendCertificate(request.certificate.data, request.hostname) ? 0 : -2);
  });
  mainWindow.webContents.session.webRequest.onBeforeSendHeaders(
    { urls: [`${appOrigin}/*`] },
    (details, callback) => {
      try {
        if (details.webContentsId === mainWindow.webContents.id
            && new URL(details.url).origin === appOrigin) {
          if (details.resourceType === 'mainFrame') details.requestHeaders.Origin = appOrigin;
          for (const name of Object.keys(details.requestHeaders)) {
            if (name.toLowerCase() === 'x-code-intelligence-token') delete details.requestHeaders[name];
          }
          details.requestHeaders['X-Code-Intelligence-Token'] = runtime.apiToken;
        }
      } finally {
        callback({ requestHeaders: details.requestHeaders });
      }
    }
  );
  const allowAppNavigation = event => {
    try {
      if (new URL(event.url).origin !== appOrigin) event.preventDefault();
    } catch {
      event.preventDefault();
    }
  };
  mainWindow.webContents.session.setPermissionCheckHandler(() => false);
  mainWindow.webContents.session.setPermissionRequestHandler((_webContents, _permission, callback) => callback(false));
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    try {
      shell.openExternal(assertExternalUrl(url)).catch(() => {});
    } catch {
      // Untrusted renderer URLs are denied below.
    }
    return { action: 'deny' };
  });
  mainWindow.webContents.on('will-navigate', allowAppNavigation);
  mainWindow.webContents.on('will-frame-navigate', allowAppNavigation);
  mainWindow.once('ready-to-show', () => mainWindow.show());
  mainWindow.loadURL(runtime.apiBaseUrl);
}

async function startApplication() {
  if (!ownsInstance || quitting) return;
  try {
    noteStartup('MANIFEST');
    runtimeManifest = await verifyRuntimeIntegrity();
    const runningBuild = requireBuildSequence(runtimeManifest.buildSequence);
    noteStartup('PROFILE');
    const profile = app.getPath('userData');
    await fsp.mkdir(profile, { recursive: true, mode: 0o700 });
    const windowsBoundary = process.platform === 'win32' ? createWindowsBoundary(runtimeRoot()) : undefined;
    const userData = windowsBoundary ? path.join(await fsp.realpath(profile), 'private') : await fsp.realpath(profile);
    if (windowsBoundary) {
      for (const name of ['secrets.enc', '.safety-enrollment', 'safety', 'postgres', 'data', 'authorized-paths.enc', 'backup-maintenance', 'recovery'])
        if (fs.existsSync(path.join(profile, name))) throw new SafetyLifecycleError('SAFETY_RECOVERY_REQUIRED');
      if (!fs.existsSync(userData)) windowsBoundary.createDirectory(userData, { inherit: true });
    }
    if (fs.existsSync(path.join(userData, 'data', '.restore-recovery-required.json'))) {
      throw new Error('An interrupted restore requires offline recovery. Runtime was not started; keep the recovery backup and staging directories.');
    }
    const pathsFile = path.join(userData, 'authorized-paths.enc');
    runtime = {
      userData, windowsBoundary,
      postgresBinRoot: runtimeManifest.runtime.postgresBin,
      postgresLibRoot: runtimeManifest.runtime.postgresLib,
      pathsFile,
      authorizedRoots: [],
      apiToken: randomSecret(),
      pathToken: randomSecret(),
      ports: {
        postgres: await freePort(),
        redis: await freePort(),
        analyzer: await freePort(),
        backend: await freePort()
      },
      ready: false,
      error: null
    };
    if (windowsBoundary) runtime.storage = await windowsBoundary.openStorage(userData, { onLost: loseRuntimeOwnership });
    noteStartup('CREDENTIALS');
    const secrets = await loadDesktopSecrets({ userData, safeStorage, windowsBoundary, electronApp: app,
      ...(windowsBoundary ? { initializeEnrollment: value => openAuthorizedRoots(value, true) } : {}) });
    runtime.secrets = secrets;
    if (windowsBoundary && !runtime.grantState) await openAuthorizedRoots(secrets);
    noteStartup('PRIVATE_IPC');
    const temporaryRoot = await fsp.realpath(app.getPath('temp'));
    if (windowsBoundary) {
      runtime.ipcRoot = path.join(temporaryRoot, 'ci-' + crypto.randomBytes(4).toString('hex'));
      windowsBoundary.createDirectory(runtime.ipcRoot);
      runtime.ipcStorage = await windowsBoundary.openStorage(runtime.ipcRoot, { onLost: loseRuntimeOwnership });
      runtime.ipcIdentity = runtime.ipcStorage.rootState.identity;
    } else {
      runtime.ipcRoot = await fsp.realpath(await fsp.mkdtemp(path.join(temporaryRoot, 'ci-')));
      await fsp.chmod(runtime.ipcRoot, 0o700); runtime.ipcIdentity = await fsp.lstat(runtime.ipcRoot);
    }
    noteStartup('TLS');
    runtime.transport = await createServiceTransport({ userData, ports: runtime.ports, getApiToken: () => runtime.apiToken,
      windowsBoundary, onLost: loseRuntimeOwnership });
    runtime.apiBaseUrl = runtime.transport.backend.origin;
    noteStartup('OWNER_LOCKS');
    if (runtimeManifest.ownershipProtocol === 1) ownerLocks = await createNativeOwnerLocks({
      javaPath: binary('jre', 'bin', 'java'), jarPath: binary('backend', 'code-intelligence.jar'),
      safetyRoot: path.join(runtime.userData, 'safety'), installationId: secrets.localIdentity,
      assertMainOwnership: () => ownsInstance && app.hasSingleInstanceLock(),
      onLost: loseRuntimeOwnership
    });
    async function openSafety(recoveryMode) {
      aiPostgres = await createAiEgressPostgres({ psqlPath: binary('postgres', 'bin', 'psql'),
      installationId: secrets.localIdentity,
      connection: { host: '127.0.0.1', port: runtime.ports.postgres, user: 'codeintel', database: 'codeintel' },
      env: postgresEnvironment() });
    const maintenanceVerifier = runtimeManifest.backupProtocol === 3
      ? createMaintenanceVerifier({ installationId: secrets.localIdentity, readProjection: aiPostgres.readProjection }) : undefined;
      noteStartup('SAFETY');
      safetyLifecycle = await openSafetyLifecycle({ userData, safeStorage, windowsBoundary, electronApp: app,
      installationId: secrets.localIdentity, runningBuild, recoveryMode, ...(ownerLocks ? { ownerLocks } : {}),
      createGateway: async ({ openJournal, freshEnrollmentAllowed, recoveryMode: gatewayRecoveryMode }) => {
        noteStartup('GATEWAY');
        aiGateway = await openDesktopAiGateway({ installationId: secrets.localIdentity, runningBuild,
          temporaryRoot: runtime.ipcRoot, tokenEncryptionKey: secrets.tokenEncryptionKey, windowsBoundary,
          openJournal, freshEnrollmentAllowed, adapter: aiPostgres, recoveryMode: gatewayRecoveryMode,
          verifyMaintenanceSeal: maintenanceVerifier, verifyMaintenanceCompletion: maintenanceVerifier });
        return aiGateway;
      },
      ...(runtimeManifest.backupProtocol === 3 ? { createBackupRuntime: async hooks => {
        noteStartup('BACKUP');
        backupRuntime = await createDesktopBackupRuntime({ ...hooks, userData,
          installationId: secrets.localIdentity, runningBuild, recoveryMode, windowsBoundary,
          gateway: aiGateway, adapter: aiPostgres, ports: backupPorts() });
        return backupRuntime;
      } } : {}) });
    }
    // Presence only selects a restricted inspection path. Authenticated records, B and actual
    // database/source identities decide whether the exact interrupted transaction can resume.
    bootRecovery = runtimeManifest.backupProtocol === 3 && fs.existsSync(path.join(userData, 'backup-maintenance'));
    await openSafety(bootRecovery);
    if (bootRecovery) {
      const pending = await backupRuntime.pendingRecovery();
      if (pending) {
        const choice = await dialog.showMessageBox({ type: 'warning', title: 'Verify interrupted recovery',
          message: 'An interrupted backup or restore needs verification before the application can open.',
          detail: 'Recovery uses the recorded transaction and preserved checkpoint. It keeps verified prior data if publication did not complete. AI, saved sign-ins and local folder grants remain off.',
          buttons: ['Verify and recover', 'Quit'], defaultId: 0, cancelId: 1, noLink: true });
        if (choice.response !== 0 || quitting) { app.quit(); return; }
        await startPostgres({ recoveryOnly: true });
        await backupRuntime.recover();
        await stopRuntime();
      }
      await safetyLifecycle.close(); await aiPostgres.close();
      safetyLifecycle = undefined; aiGateway = undefined; aiPostgres = undefined; backupRuntime = undefined;
      bootRecovery = false;
      if (runtime.recoveryRequired) throw new SafetyLifecycleError('SAFETY_RECOVERY_REQUIRED');
      await openSafety(false);
    }
    if (quitting) return;
    noteStartup('AUTHORIZED_ROOTS');
    runtime.authorizedRoots = await readAuthorizedRoots();
    registerIpc();
    await startRuntime();
    if (!quitting) { noteStartup('WINDOW'); createWindow(); noteStartup('READY'); }
  } catch (error) {
    // Requested quit cancels further startup; the serialized shutdown still latches and closes B.
    if (quitting) return;
    runtime = runtime || { ready: false };
    runtime.error = error.message;
    runtime.recoveryRequired = true;
    const code = ['EACCES', 'ENOENT', 'SAFETY_RECOVERY_REQUIRED', 'SAFETY_STORAGE_UNAVAILABLE', 'SAFETY_OWNER_LOST'].includes(error.code)
      ? error.code : 'MAIN_STARTUP_FAILED';
    console.error('DESKTOP_STARTUP ' + startupPhase + ' FAILED ' + code);
    dialog.showErrorBox('Code Intelligence could not start', error.message);
    app.quit();
  }
}

app.whenReady().then(() => withRuntimeOperation(startApplication));

app.on('before-quit', (event) => {
  if (shutdownComplete) return;
  event.preventDefault();
  if (quitContinuation) return;
  quitContinuation = true;
  shutdownRuntime().then(() => {
    shutdownComplete = true;
    app.quit();
  }, () => {
    dialog.showErrorBox('Code Intelligence shutdown requires recovery',
      'Desktop safety state could not be closed cleanly. No safety state or lock was reset.');
    if (children.size === 0 && !sourceBroker && !sourceVault) { shutdownComplete = true; app.quit(); }
  });
});

app.on('window-all-closed', () => app.quit());
