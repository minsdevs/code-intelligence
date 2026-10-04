'use strict';
// Electron-only native probe. Never used as the product credential store.
const { app, safeStorage } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const mode = process.argv[2], directory = process.argv[3];
if (process.env.GITHUB_ACTIONS !== 'true' || process.env.RUNNER_ENVIRONMENT !== 'github-hosted'
    || process.env.NATIVE_ACCEPTANCE_CONSENT !== 'disposable-hosted-os' || process.platform !== 'win32'
    || !['write', 'read'].includes(mode) || !path.isAbsolute(directory || '')) throw new Error('NATIVE_PROBE_REFUSED');
const relative = path.relative(process.env.RUNNER_TEMP || '', directory);
if (!relative || relative.startsWith('..') || path.isAbsolute(relative) || fs.realpathSync(directory) !== directory) throw new Error('NATIVE_PROBE_DIRECTORY_REFUSED');
const profile = path.join(directory, 'electron-profile');
if (mode === 'write') fs.mkdirSync(profile);
else if (!fs.statSync(profile).isDirectory()) throw new Error('NATIVE_PROBE_PROFILE_MISSING');
app.setPath('userData', profile);
app.whenReady().then(() => {
  if (!safeStorage.isEncryptionAvailable()) throw new Error('NATIVE_ENCRYPTION_UNAVAILABLE');
  const cipher = path.join(directory, 'probe.enc'), digest = path.join(directory, 'probe.sha256');
  if (mode === 'write') {
    const secret = crypto.randomBytes(32).toString('hex');
    const encrypted = safeStorage.encryptString(secret);
    if (encrypted.includes(Buffer.from(secret))) throw new Error('PLAINTEXT_STORAGE_REFUSED');
    fs.writeFileSync(cipher, encrypted, { flag: 'wx' });
    fs.writeFileSync(digest, crypto.createHash('sha256').update(secret).digest('hex'), { flag: 'wx' });
  } else {
    const value = safeStorage.decryptString(fs.readFileSync(cipher));
    if (crypto.createHash('sha256').update(value).digest('hex') !== fs.readFileSync(digest, 'utf8')) throw new Error('NATIVE_RESTART_DECRYPT_FAILED');
  }
  app.exit(0);
}).catch(() => app.exit(1));
