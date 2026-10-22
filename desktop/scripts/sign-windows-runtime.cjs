'use strict';

// electron-builder signs extraResources while copying them, before afterPack.
// Keep the verified runtime bytes (and existing vendor signatures) unchanged;
// Authenticode covers the app executable and installer, not a rewritten manifest.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { runtimeRelativePath } = require('../src/runtime-platform.cjs');
const { validateRuntimeManifest } = require('../src/runtime-manifest.cjs');
const { verifyWindowsStage } = require('./windows-readiness.cjs');

const registered = new WeakMap();
const hash = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const fail = code => { throw Object.assign(new Error(code), { code }); };

function registerWindowsRuntimeSigning(context, manifest) {
  if (context.electronPlatformName !== 'win32' || !context.packager
      || typeof context.appOutDir !== 'string' || !path.isAbsolute(context.appOutDir)
      || !manifest || manifest.platform !== 'win32' || manifest.arch !== 'x64'
      || !manifest.files || Array.isArray(manifest.files)) fail('WINDOWS_SIGNING_CONTEXT_REQUIRED');
  const files = {};
  for (const [name, digest] of Object.entries(manifest.files)) {
    runtimeRelativePath(name, 'signing runtime path', 'win32');
    if (!/^[a-f0-9]{64}$/.test(digest)) fail('WINDOWS_SIGNING_CONTEXT_REQUIRED');
    files[name] = digest;
  }
  registered.set(context.packager, {
    root: path.join(context.appOutDir, 'resources', 'runtime'), files: Object.freeze(files),
    manifestDigest: hash(JSON.stringify(manifest))
  });
}

function preserveRuntimeFile(file, packager) {
  const state = registered.get(packager);
  if (!state || typeof file !== 'string' || !path.isAbsolute(file)) fail('WINDOWS_SIGNING_CONTEXT_REQUIRED');
  const relative = path.relative(state.root, file);
  if (path.isAbsolute(relative) || relative === '..' || relative.startsWith('..' + path.sep)) return false;
  const name = relative.split(path.sep).join('/');
  const expected = state.files[name];
  if (!expected) fail('WINDOWS_SIGNING_UNLISTED_RUNTIME_FILE');
  const stat = fs.lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.size > 512 * 1024 * 1024
      || fs.realpathSync(file).toLowerCase() !== path.resolve(file).toLowerCase()
      || hash(fs.readFileSync(file)) !== expected) fail('WINDOWS_SIGNING_RUNTIME_CHANGED');
  return true;
}

async function signWindowsFile(configuration, packager, host = process) {
  if (host.platform !== 'win32' || host.arch !== 'x64') fail('WINDOWS_X64_SIGNING_HOST_REQUIRED');
  if (preserveRuntimeFile(configuration.path, packager)) return;
  if (configuration.hash !== 'sha256' || !configuration.cscInfo) fail('WINDOWS_SIGNING_CERTIFICATE_REQUIRED');
  const manager = await packager.signingManager?.value;
  if (typeof manager?.doSign !== 'function') fail('WINDOWS_SIGNING_MANAGER_UNSUPPORTED');
  // Calling signFile/signIf would invoke this hook recursively. The pinned
  // electron-builder 26.15.3 manager exposes its underlying signtool executor.
  await manager.doSign(configuration, packager);
}

async function verifyPackagedWindowsRuntime(context) {
  const state = registered.get(context.packager);
  if (!state || state.root !== path.join(context.appOutDir, 'resources', 'runtime')) fail('WINDOWS_SIGNING_CONTEXT_REQUIRED');
  const manifest = JSON.parse(fs.readFileSync(path.join(state.root, 'runtime-manifest.json'), 'utf8'));
  if (hash(JSON.stringify(manifest)) !== state.manifestDigest) fail('WINDOWS_SIGNING_MANIFEST_CHANGED');
  await validateRuntimeManifest(state.root, manifest, { platform: 'win32', arch: 'x64' });
  return verifyWindowsStage(state.root);
}

module.exports = signWindowsFile;
module.exports.registerWindowsRuntimeSigning = registerWindowsRuntimeSigning;
module.exports.preserveRuntimeFile = preserveRuntimeFile;
module.exports.verifyPackagedWindowsRuntime = verifyPackagedWindowsRuntime;
