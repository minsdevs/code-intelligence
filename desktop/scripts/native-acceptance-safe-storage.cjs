'use strict';
// Electron-only native probe. Never used as the product credential store.
const { app, safeStorage } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { requireExecutionContext, privateDescendant } = require('./native-acceptance-context.cjs');
const context = requireExecutionContext();
const mode = process.argv[2], directory = process.argv[3];
if (!['write', 'read'].includes(mode) || !path.isAbsolute(directory || '')) throw new Error('NATIVE_PROBE_REFUSED');
const relative = path.relative(context.tempRoot, directory);
if (!relative || relative.startsWith('..') || path.isAbsolute(relative) || fs.realpathSync(directory) !== directory) throw new Error('NATIVE_PROBE_DIRECTORY_REFUSED');
if (context.kind !== 'github-hosted') privateDescendant(context.tempRoot, directory);
const profile = path.join(directory, 'electron-profile');
const paths = { userData: profile, sessionData: path.join(directory, 'electron-session'),
  temp: path.join(directory, 'electron-temp'), crashDumps: path.join(directory, 'electron-crashes'),
  logs: path.join(directory, 'electron-logs') };
if (mode === 'write') {
  for (const target of Object.values(paths)) fs.mkdirSync(target, { mode: 0o700 });
} else {
  for (const target of Object.values(paths)) if (!fs.statSync(target).isDirectory()) throw new Error('NATIVE_PROBE_PROFILE_MISSING');
}
if (context.kind !== 'github-hosted') for (const target of Object.values(paths)) privateDescendant(directory, target);
app.setName(require('../src/isolated-run.cjs').VALIDATION_IDENTITIES.validation.name);
for (const name of ['userData', 'sessionData', 'temp', 'crashDumps']) app.setPath(name, paths[name]);
app.setAppLogsPath(paths.logs);
const recordPhase = value => fs.writeFileSync(path.join(directory, mode + '.phase'), value, { mode: 0o600 });
recordPhase('APP_READY');
app.whenReady().then(() => {
  recordPhase('ENCRYPTION_AVAILABLE');
  if (!safeStorage.isEncryptionAvailable()) throw new Error('NATIVE_ENCRYPTION_UNAVAILABLE');
  const cipher = path.join(directory, 'probe.enc'), digest = path.join(directory, 'probe.sha256');
  if (mode === 'write') {
    const secret = crypto.randomBytes(32).toString('hex');
    recordPhase('ENCRYPT');
    const encrypted = safeStorage.encryptString(secret);
    if (encrypted.includes(Buffer.from(secret))) throw new Error('PLAINTEXT_STORAGE_REFUSED');
    recordPhase('WRITE_CIPHERTEXT');
    fs.writeFileSync(cipher, encrypted, { flag: 'wx', mode: 0o600 });
    recordPhase('WRITE_DIGEST');
    fs.writeFileSync(digest, crypto.createHash('sha256').update(secret).digest('hex'), { flag: 'wx', mode: 0o600 });
  } else {
    recordPhase('READ_CIPHERTEXT');
    const encrypted = fs.readFileSync(cipher);
    recordPhase('DECRYPT');
    const value = safeStorage.decryptString(encrypted);
    recordPhase('READ_DIGEST');
    const expected = fs.readFileSync(digest, 'utf8');
    recordPhase('VERIFY_DIGEST');
    if (crypto.createHash('sha256').update(value).digest('hex') !== expected) throw new Error('NATIVE_RESTART_DECRYPT_FAILED');
  }
  recordPhase('COMPLETE');
  // The ready callback can precede Electron's main message loop. app.exit()
  // would then bypass the Local State commit; test a real normal shutdown.
  app.quit();
}).catch(() => app.exit(1));
