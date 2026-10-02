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

const children = new Map();
let mainWindow;
let runtime;
let runtimeManifest;
let stopping = false;
let restartTimer;
let restartAttempts = 0;

if (!app.requestSingleInstanceLock()) {
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
  return crypto.randomBytes(bytes).toString('base64url');
}

function runtimeRoot() {
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

function saveEncryptedJson(file, value) {
  const temporary = `${file}.tmp-${process.pid}`;
  fs.writeFileSync(temporary, safeStorage.encryptString(JSON.stringify(value)), { mode: 0o600 });
  fs.renameSync(temporary, file);
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
  const candidate = parts[0] === 'postgres' && parts[1] === 'bin' && runtime?.postgresBinRoot
    ? path.join(runtimeRoot(), runtime.postgresBinRoot, ...parts.slice(2))
    : path.join(runtimeRoot(), ...parts);
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
  if (typeof raw !== 'string' || raw.length === 0 || path.isAbsolute(raw)
      || raw.startsWith('\\') || /^[A-Za-z]:[\\/]/.test(raw)
      || raw.split(/[\\/]/).includes('..')) {
    throw new Error(`Bundled runtime manifest has an unsafe ${label}.`);
  }
  return raw;
}

function assertTrustedRenderer(event) {
  if (!mainWindow
      || event.sender !== mainWindow.webContents
      || event.senderFrame !== mainWindow.webContents.mainFrame
      || new URL(event.senderFrame.url).origin !== new URL(runtime.apiBaseUrl).origin) {
    throw new Error('Untrusted renderer IPC request.');
  }
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
  if (!manifest.runtime?.postgresBin || !manifest.runtime?.postgresLib
      || !manifest.runtime?.postgresPkgLib || !manifest.runtime?.postgresShare
      || !manifest.files || typeof manifest.files !== 'object') {
    throw new Error('Bundled runtime manifest has no PostgreSQL layout. Re-run `npm run stage`.');
  }
  manifest.runtime = {
    postgresBin: assertRuntimeRelativePath(manifest.runtime.postgresBin, 'PostgreSQL bin path'),
    postgresLib: assertRuntimeRelativePath(manifest.runtime.postgresLib, 'PostgreSQL library path'),
    postgresPkgLib: assertRuntimeRelativePath(manifest.runtime.postgresPkgLib, 'PostgreSQL extension path'),
    postgresShare: assertRuntimeRelativePath(manifest.runtime.postgresShare, 'PostgreSQL share path')
  };
  for (const [relative, expected] of Object.entries(manifest.files)) {
    const safeRelative = assertRuntimeRelativePath(relative, 'file path');
    if (typeof expected !== 'string' || !/^[a-f0-9]{64}$/i.test(expected)) {
      throw new Error(`Bundled runtime manifest has an invalid hash: ${safeRelative}`);
    }
    const actual = await hashFile(path.join(root, safeRelative));
    if (actual !== expected) throw new Error(`Bundled runtime integrity check failed: ${relative}`);
  }
  return manifest;
}

function childLog(name) {
  const logs = path.join(app.getPath('logs'), 'runtime');
  fs.mkdirSync(logs, { recursive: true, mode: 0o700 });
  return fs.openSync(path.join(logs, `${name}.log`), 'a', 0o600);
}

function spawnManaged(name, command, args, options = {}) {
  const log = childLog(name);
  const child = spawn(command, args, {
    cwd: options.cwd || app.getPath('userData'),
    env: { ...process.env, ...options.env },
    stdio: ['ignore', log, log],
    windowsHide: true
  });
  children.set(name, child);
  child.once('exit', (code, signal) => {
    fs.closeSync(log);
    if (children.get(name) === child) children.delete(name);
    if (!stopping && runtime?.ready) {
      runtime.ready = false;
      runtime.error = `${name} exited (${code ?? signal})`;
      mainWindow?.webContents.send('runtime:changed', publicRuntimeStatus());
      scheduleRestart();
    }
  });
  return child;
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd || app.getPath('userData'),
    env: { ...process.env, ...options.env },
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
  const lib = path.join(runtimeRoot(), runtime.postgresLibRoot);
  return {
    PGPASSWORD: runtime.secrets.databasePassword,
    DYLD_LIBRARY_PATH: lib,
    LD_LIBRARY_PATH: lib
  };
}

async function startPostgres() {
  const data = path.join(app.getPath('userData'), 'postgres');
  await fsp.mkdir(data, { recursive: true, mode: 0o700 });
  const initdb = binary('postgres', 'bin', 'initdb');
  const postgres = binary('postgres', 'bin', 'postgres');
  const pgIsReady = binary('postgres', 'bin', 'pg_isready');
  const psql = binary('postgres', 'bin', 'psql');
  const createdb = binary('postgres', 'bin', 'createdb');
  const env = postgresEnvironment();

  if (!fs.existsSync(path.join(data, 'PG_VERSION'))) {
    const passwordFile = path.join(app.getPath('userData'), `.pg-password-${process.pid}`);
    fs.writeFileSync(passwordFile, runtime.secrets.databasePassword, { mode: 0o600 });
    try {
      run(initdb, [
        '-D', data,
        '-U', 'codeintel',
        '--encoding=UTF8',
        '--auth-local=trust',
        '--auth-host=scram-sha-256',
        `--pwfile=${passwordFile}`
      ], { env });
    } finally {
      fs.rmSync(passwordFile, { force: true });
    }
  }

  spawnManaged('postgres', postgres, [
    '-D', data,
    '-h', '127.0.0.1',
    '-p', String(runtime.ports.postgres),
    '-c', 'listen_addresses=127.0.0.1',
    '-c', 'max_connections=40'
  ], { env });
  await waitUntil(() => {
    const result = spawnSync(pgIsReady, [
      '-h', '127.0.0.1', '-p', String(runtime.ports.postgres), '-U', 'codeintel'
    ], { env: { ...process.env, ...env }, stdio: 'ignore' });
    return result.status === 0;
  }, 'PostgreSQL');

  const exists = run(psql, [
    '-h', '127.0.0.1', '-p', String(runtime.ports.postgres), '-U', 'codeintel',
    '-d', 'postgres', '-tAc', "select 1 from pg_database where datname='codeintel'"
  ], { env });
  if (exists !== '1') {
    run(createdb, [
      '-h', '127.0.0.1', '-p', String(runtime.ports.postgres), '-U', 'codeintel', 'codeintel'
    ], { env });
  }
  run(psql, [
    '-h', '127.0.0.1', '-p', String(runtime.ports.postgres), '-U', 'codeintel',
    '-d', 'codeintel', '-v', 'ON_ERROR_STOP=1', '-c',
    'create extension if not exists vector; create extension if not exists pg_trgm;'
  ], { env });
}

async function startRedis() {
  const data = path.join(app.getPath('userData'), 'redis');
  await fsp.mkdir(data, { recursive: true, mode: 0o700 });
  spawnManaged('redis', binary('redis', 'bin', 'redis-server'), [
    '--bind', '127.0.0.1',
    '--protected-mode', 'yes',
    '--port', String(runtime.ports.redis),
    '--dir', data,
    '--dbfilename', 'dump.rdb',
    '--appendonly', 'yes'
  ], {
    env: {
      DYLD_LIBRARY_PATH: path.join(runtimeRoot(), 'redis', 'lib'),
      LD_LIBRARY_PATH: path.join(runtimeRoot(), 'redis', 'lib')
    }
  });
  await waitUntil(async () => {
    const socket = net.createConnection({ host: '127.0.0.1', port: runtime.ports.redis });
    return new Promise((resolve) => {
      socket.once('connect', () => { socket.end(); resolve(true); });
      socket.once('error', () => resolve(false));
    });
  }, 'Redis');
}

async function startAnalyzer() {
  const main = binary('ts-analyzer', 'dist', 'main.js');
  spawnManaged('ts-analyzer', process.execPath, [main], {
    cwd: path.dirname(main),
    env: {
      ELECTRON_RUN_AS_NODE: '1',
      TS_ANALYZER_PORT: String(runtime.ports.analyzer),
      TS_ANALYZER_HOST: '127.0.0.1',
      NODE_ENV: 'production'
    }
  });
  await waitUntil(async () => {
    const response = await fetch(`http://127.0.0.1:${runtime.ports.analyzer}/health`).catch(() => null);
    return response?.ok;
  }, 'TypeScript analyzer');
}

async function authorizePath(selected, persist = true) {
  const canonical = await fsp.realpath(assertAbsolutePath(selected));
  const response = await fetch(`${runtime.apiBaseUrl}/api/desktop/paths`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Code-Intelligence-Token': runtime.apiToken
    },
    body: JSON.stringify({ path: canonical })
  });
  if (!response.ok) throw new Error(`Folder authorization failed (${response.status})`);
  const result = await response.json();
  if (persist && !runtime.authorizedRoots.includes(result.path)) {
    runtime.authorizedRoots.push(result.path);
    saveEncryptedJson(runtime.pathsFile, runtime.authorizedRoots);
  }
  return result.path;
}

async function startBackend() {
  const java = binary('jre', 'bin', 'java');
  const jar = binary('backend', 'code-intelligence.jar');
  const dataDir = path.join(app.getPath('userData'), 'data');
  await fsp.mkdir(dataDir, { recursive: true, mode: 0o700 });
  spawnManaged('backend', java, ['-XX:MaxRAMPercentage=55', '-jar', jar, '--spring.profiles.active=desktop'], {
    env: {
      SERVER_ADDRESS: '127.0.0.1',
      SERVER_PORT: String(runtime.ports.backend),
      DB_URL: `jdbc:postgresql://127.0.0.1:${runtime.ports.postgres}/codeintel`,
      DB_USERNAME: 'codeintel',
      DB_PASSWORD: runtime.secrets.databasePassword,
      REDIS_HOST: '127.0.0.1',
      REDIS_PORT: String(runtime.ports.redis),
      TOKEN_ENC_KEY: runtime.secrets.tokenEncryptionKey,
      DATA_DIR: dataDir,
      TS_ANALYZER_BASE_URL: `http://127.0.0.1:${runtime.ports.analyzer}`,
      DESKTOP_API_TOKEN: runtime.apiToken,
      DESKTOP_LOCAL_IDENTITY: runtime.secrets.localIdentity,
      DESKTOP_ALLOWED_ORIGIN: runtime.apiBaseUrl,
      GITHUB_NATIVE_CLIENT_ID: process.env.GITHUB_NATIVE_CLIENT_ID || '',
      CORS_ALLOWED_ORIGINS: runtime.apiBaseUrl
    }
  });
  await waitUntil(async () => {
    const response = await fetch(`${runtime.apiBaseUrl}/actuator/health`).catch(() => null);
    return response?.ok;
  }, 'Backend', 90_000);
  for (const root of [...runtime.authorizedRoots]) {
    try {
      await authorizePath(root, false);
    } catch {
      runtime.authorizedRoots = runtime.authorizedRoots.filter((entry) => entry !== root);
    }
  }
  saveEncryptedJson(runtime.pathsFile, runtime.authorizedRoots);
}

async function startRuntime() {
  stopping = false;
  runtime.ready = false;
  runtime.error = null;
  await startPostgres();
  await Promise.all([startRedis(), startAnalyzer()]);
  await startBackend();
  runtime.ready = true;
  restartAttempts = 0;
  mainWindow?.webContents.send('runtime:changed', publicRuntimeStatus());
}

async function stopChild(name) {
  const child = children.get(name);
  if (!child) return;
  children.delete(name);
  child.kill('SIGTERM');
  await Promise.race([
    new Promise((resolve) => child.once('exit', resolve)),
    new Promise((resolve) => setTimeout(resolve, 5000))
  ]);
  if (child.exitCode == null) child.kill('SIGKILL');
}

async function stopRuntime({ keepDatabase = false } = {}) {
  stopping = true;
  clearTimeout(restartTimer);
  await stopChild('backend');
  await stopChild('ts-analyzer');
  await stopChild('redis');
  if (!keepDatabase) await stopChild('postgres');
  runtime.ready = false;
}

function scheduleRestart() {
  if (restartTimer || restartAttempts >= 3) return;
  const delay = 1000 * 2 ** restartAttempts++;
  restartTimer = setTimeout(async () => {
    restartTimer = null;
    try {
      await stopRuntime();
      await startRuntime();
    } catch (error) {
      runtime.error = error.message;
      scheduleRestart();
    }
  }, delay);
}

function publicRuntimeStatus() {
  return {
    ready: Boolean(runtime?.ready),
    error: runtime?.error || null,
    services: [...children.keys()]
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

async function createBackup(destination) {
  const pgDump = binary('postgres', 'bin', 'pg_dump');
  await fsp.mkdir(destination, { recursive: true, mode: 0o700 });
  const dump = path.join(destination, 'database.dump');
  run(pgDump, [
    '-h', '127.0.0.1', '-p', String(runtime.ports.postgres), '-U', 'codeintel',
    '-d', 'codeintel', '-Fc', '-f', dump
  ], { env: postgresEnvironment(), timeout: 300_000 });
  const repositories = path.join(app.getPath('userData'), 'data', 'repos');
  if (fs.existsSync(repositories)) {
    await fsp.cp(repositories, path.join(destination, 'repositories'), { recursive: true, errorOnExist: true });
  }
  const manifest = {
    format: 1,
    createdAt: new Date().toISOString(),
    databaseSha256: await hashFile(dump)
  };
  await fsp.writeFile(path.join(destination, 'manifest.json'), JSON.stringify(manifest, null, 2), { mode: 0o600 });
  return destination;
}

async function backupWithDialog() {
  const choice = await dialog.showOpenDialog(mainWindow, {
    title: 'Choose a folder for the backup',
    properties: ['openDirectory', 'createDirectory']
  });
  if (choice.canceled) return null;
  const destination = path.join(choice.filePaths[0], `code-intelligence-${Date.now()}.backup`);
  return createBackup(destination);
}

async function restoreWithDialog() {
  const choice = await dialog.showOpenDialog(mainWindow, {
    title: 'Choose a Code Intelligence backup folder',
    properties: ['openDirectory']
  });
  if (choice.canceled) return null;
  const source = choice.filePaths[0];
  const manifest = JSON.parse(await fsp.readFile(path.join(source, 'manifest.json'), 'utf8'));
  const dump = path.join(source, 'database.dump');
  if (manifest.format !== 1 || manifest.databaseSha256 !== await hashFile(dump)) {
    throw new Error('Backup integrity validation failed.');
  }

  const confirmation = await dialog.showMessageBox(mainWindow, {
    type: 'warning',
    title: 'Restore Code Intelligence data?',
    message: 'Restoring will replace the current local database and repositories.',
    detail: 'A recovery backup is created only after you choose Restore. Cancel leaves current data unchanged.',
    buttons: ['Cancel', 'Restore'],
    defaultId: 0,
    cancelId: 0,
    noLink: true
  });
  if (confirmation.response !== 1) return null;

  await stopChild('backend');
  const recovery = path.join(app.getPath('userData'), 'recovery', String(Date.now()));
  await createBackup(recovery);
  try {
    run(binary('postgres', 'bin', 'pg_restore'), [
      '-h', '127.0.0.1', '-p', String(runtime.ports.postgres), '-U', 'codeintel',
      '-d', 'codeintel', '--clean', '--if-exists', '--no-owner', dump
    ], { env: postgresEnvironment(), timeout: 300_000 });
    const restoredRepositories = path.join(source, 'repositories');
    const repositories = path.join(app.getPath('userData'), 'data', 'repos');
    if (fs.existsSync(restoredRepositories)) {
      await fsp.rm(repositories, { recursive: true, force: true });
      await fsp.cp(restoredRepositories, repositories, { recursive: true });
    }
    await startBackend();
    runtime.ready = true;
    return { restored: true, recoveryBackup: recovery };
  } catch (error) {
    runtime.error = `Restore failed; recovery backup kept at ${recovery}: ${error.message}`;
    await startBackend().catch(() => {});
    throw error;
  }
}

function registerIpc() {
  ipcMain.on('runtime:config', (event) => {
    assertTrustedRenderer(event);
    event.returnValue = { apiBaseUrl: runtime.apiBaseUrl, apiToken: runtime.apiToken };
  });
  ipcMain.handle('runtime:status', (event) => {
    assertTrustedRenderer(event);
    return publicRuntimeStatus();
  });
  ipcMain.handle('runtime:restart', async (event) => {
    assertTrustedRenderer(event);
    await stopRuntime();
    await startRuntime();
    return publicRuntimeStatus();
  });
  ipcMain.handle('folder:pick', async (event) => {
    assertTrustedRenderer(event);
    const result = await dialog.showOpenDialog(mainWindow, {
      title: 'Choose a source folder to analyze',
      properties: ['openDirectory']
    });
    return result.canceled ? null : authorizePath(result.filePaths[0]);
  });
  ipcMain.handle('folder:authorize', (event, selected) => {
    assertTrustedRenderer(event);
    return authorizePath(assertAbsolutePath(selected));
  });
  ipcMain.handle('external:open', (event, url) => {
    assertTrustedRenderer(event);
    return shell.openExternal(assertExternalUrl(url));
  });
  ipcMain.handle('data:backup', (event) => {
    assertTrustedRenderer(event);
    return backupWithDialog();
  });
  ipcMain.handle('data:restore', (event) => {
    assertTrustedRenderer(event);
    return restoreWithDialog();
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
  mainWindow.webContents.session.webRequest.onBeforeSendHeaders(
    { urls: [`${appOrigin}/*`] },
    (details, callback) => {
      try {
        if (details.webContentsId === mainWindow.webContents.id
            && details.resourceType === 'mainFrame'
            && new URL(details.url).origin === appOrigin) {
          details.requestHeaders.Origin = appOrigin;
          details.requestHeaders['X-Code-Intelligence-Token'] = runtime.apiToken;
        }
      } finally {
        callback({ requestHeaders: details.requestHeaders });
      }
    }
  );
  const allowAppNavigation = (event, url) => {
    try {
      if (new URL(url).origin !== appOrigin) event.preventDefault();
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
  mainWindow.webContents.on('will-frame-navigate', (event, details) => {
    allowAppNavigation(event, details.url);
  });
  mainWindow.once('ready-to-show', () => mainWindow.show());
  mainWindow.loadURL(runtime.apiBaseUrl);
}

app.whenReady().then(async () => {
  try {
    runtimeManifest = await verifyRuntimeIntegrity();
    const userData = app.getPath('userData');
    const secretsFile = path.join(userData, 'secrets.enc');
    const pathsFile = path.join(userData, 'authorized-paths.enc');
    const secrets = encryptedJson(secretsFile, () => ({
      localIdentity: crypto.randomUUID(),
      databasePassword: randomSecret(36),
      tokenEncryptionKey: crypto.randomBytes(32).toString('base64')
    }));
    runtime = {
      secrets,
      postgresBinRoot: runtimeManifest.runtime.postgresBin,
      postgresLibRoot: runtimeManifest.runtime.postgresLib,
      pathsFile,
      authorizedRoots: encryptedJson(pathsFile, () => []),
      apiToken: randomSecret(),
      ports: {
        postgres: await freePort(),
        redis: await freePort(),
        analyzer: await freePort(),
        backend: await freePort()
      },
      ready: false,
      error: null
    };
    runtime.apiBaseUrl = `http://127.0.0.1:${runtime.ports.backend}`;
    registerIpc();
    await startRuntime();
    createWindow();
  } catch (error) {
    runtime = runtime || { ready: false };
    runtime.error = error.message;
    dialog.showErrorBox('Code Intelligence could not start', error.message);
    app.quit();
  }
});

app.on('before-quit', (event) => {
  if (!stopping && children.size > 0) {
    event.preventDefault();
    stopRuntime().finally(() => {
      stopping = true;
      app.quit();
    });
  }
});

app.on('window-all-closed', () => app.quit());
