'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');
const { createRequire } = require('node:module');
const { validateRuntimeManifest } = require('../src/runtime-manifest.cjs');
const { isMachOHeader } = require('./native-runtime-policy.cjs');
const { adapterIsolationMode } = require('../src/adapter-isolation.cjs');
const adapterSupervisor = require('./adapter-supervisor.cjs');

const MANIFEST = 'runtime-manifest.json';
function reject(code) { throw Object.assign(new Error(code), { code }); }
function inside(root, file) {
  const relative = path.relative(root, path.resolve(file));
  return relative === '' || (!relative.startsWith('..' + path.sep) && relative !== '..' && !path.isAbsolute(relative));
}
function builderRequire() { return createRequire(require.resolve('app-builder-lib/package.json')); }
function notarizationConfigured(environment) {
  if (environment.APPLE_ID || environment.APPLE_APP_SPECIFIC_PASSWORD) {
    return Boolean(environment.APPLE_ID && environment.APPLE_APP_SPECIFIC_PASSWORD && environment.APPLE_TEAM_ID);
  }
  if (environment.APPLE_API_KEY || environment.APPLE_API_KEY_ID || environment.APPLE_API_ISSUER) {
    return Boolean(environment.APPLE_API_KEY && environment.APPLE_API_KEY_ID && environment.APPLE_API_ISSUER);
  }
  return Boolean(environment.APPLE_KEYCHAIN_PROFILE);
}

async function validateMacBuild(context, environment = process.env) {
  const packager = context.packager;
  const options = packager.platformSpecificBuildOptions;
  if (!Array.isArray(context.targets)) reject('MAC_BUILD_TARGETS_REQUIRED');
  const directoryOnly = context.targets.every(target => target.name === 'dir');
  if (options.hardenedRuntime !== true || options.sign !== './scripts/sign-macos-runtime.cjs') {
    reject('MAC_RUNTIME_SIGNING_REQUIRED');
  }
  if (directoryOnly && options.identity === '-' && options.notarize === false) return;
  if (options.identity === '-' || options.identity === null || options.type !== 'distribution'
      || options.notarize !== true || packager.forceCodeSigning !== true) {
    reject('MAC_DISTRIBUTION_REQUIRES_DEVELOPER_ID_AND_NOTARIZATION');
  }
  if (!notarizationConfigured(environment)) reject('MAC_NOTARY_CREDENTIALS_REQUIRED');
  // Stable builder can skip its custom signing hook when no identity is found.
  // Require the real identity before packing, rather than trusting forceCodeSigning alone.
  const { keychainFile } = await packager.codeSigningInfo.value;
  const { findIdentity } = builderRequire()('app-builder-lib/out/codeSign/macCodeSign');
  const identity = await findIdentity('Developer ID Application', options.identity, keychainFile);
  if (!identity || !identity.name.startsWith('Developer ID Application:')) reject('MAC_DEVELOPER_ID_REQUIRED');
}

function codesign(arguments_) {
  return execFileSync('/usr/bin/codesign', arguments_, {
    encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 120000, maxBuffer: 1024 * 1024,
  });
}
async function digest(file) {
  const hash = crypto.createHash('sha256');
  for await (const bytes of fs.createReadStream(file)) hash.update(bytes);
  return hash.digest('hex');
}
function makeDistributedRuntimeReadable(root) {
  const stat = fs.lstatSync(root);
  if (stat.isSymbolicLink() || stat.uid !== process.getuid()) reject('MAC_RUNTIME_NOT_OWNED');
  if (stat.isDirectory()) {
    fs.chmodSync(root, 0o755);
    for (const name of fs.readdirSync(root)) makeDistributedRuntimeReadable(path.join(root, name));
  } else if (stat.isFile() && stat.nlink === 1) {
    fs.chmodSync(root, stat.mode & 0o111 ? 0o755 : 0o644);
  } else reject('MAC_RUNTIME_NOT_REGULAR');
}

async function signRuntime(runtimeRoot, options) {
  if (process.platform !== 'darwin') reject('MAC_SIGNING_REQUIRES_MACOS');
  if (!options.identity) reject('MAC_SIGNING_IDENTITY_REQUIRED');
  const manifestPath = path.join(runtimeRoot, MANIFEST);
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  await validateRuntimeManifest(runtimeRoot, manifest);
  const nativeFiles = [];
  const header = Buffer.alloc(4);
  for (const relative of Object.keys(manifest.files).sort()) {
    const file = path.join(runtimeRoot, relative);
    const descriptor = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    try {
      if (fs.readSync(descriptor, header, 0, 4, 0) === 4 && isMachOHeader(header)) nativeFiles.push(relative);
    } finally { fs.closeSync(descriptor); }
  }
  if (!nativeFiles.length) reject('MAC_NATIVE_RUNTIME_EMPTY');
  // Only the copied .app is made public-readable; the private staging tree is not changed.
  makeDistributedRuntimeReadable(runtimeRoot);
  const signedManifest = { ...manifest, files: { ...manifest.files } };
  for (const relative of nativeFiles) {
    const file = path.join(runtimeRoot, relative);
    const perFile = options.optionsForFile(file);
    if (perFile.hardenedRuntime !== true || typeof perFile.entitlements !== 'string'
        || perFile.requirements || perFile.timestamp || perFile.additionalArguments?.length) {
      reject('MAC_RUNTIME_SIGN_OPTIONS_UNSUPPORTED');
    }
    const arguments_ = ['--force', '--sign', options.identity, '--options', 'runtime',
      '--generate-entitlement-der', options.identity === '-' ? '--timestamp=none' : '--timestamp',
      '--entitlements', perFile.entitlements];
    if (options.keychain) arguments_.push('--keychain', options.keychain);
    arguments_.push(file);
    codesign(arguments_);
    codesign(['--verify', '--strict', file]);
    signedManifest.files[relative] = await digest(file);
  }
  // Preserve every non-native hash. Signing must not bless unrelated changed files or additions.
  await validateRuntimeManifest(runtimeRoot, signedManifest);
  const descriptor = fs.openSync(manifestPath, fs.constants.O_WRONLY | fs.constants.O_NOFOLLOW);
  try {
    const stat = fs.fstatSync(descriptor);
    if (!stat.isFile() || stat.nlink !== 1 || stat.uid !== process.getuid()) reject('MAC_MANIFEST_NOT_OWNED');
    fs.ftruncateSync(descriptor, 0);
    fs.writeFileSync(descriptor, JSON.stringify(signedManifest, null, 2) + '\n');
    fs.fchmodSync(descriptor, 0o644);
  } finally { fs.closeSync(descriptor); }
  return signedManifest;
}

function infoValue(app, key) {
  return execFileSync('/usr/bin/plutil', ['-extract', key, 'raw', '-o', '-', path.join(app, 'Contents', 'Info.plist')],
    { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

/**
 * ADR-01: signs the adapter supervisor service and bridge inner-first and records their hashes in
 * the runtime manifest, which main attests before any analysis. A build that requires XPC isolation
 * cannot be signed without them.
 */
function signAdapterSupervisor(app, options, metadata = require('../package.json')) {
  const contents = path.join(app, 'Contents');
  const present = fs.existsSync(path.join(contents, adapterSupervisor.SERVICE_DIRECTORY));
  if (adapterIsolationMode(metadata) !== 'xpc-required') {
    if (present) reject('MAC_ADAPTER_SUPERVISOR_UNEXPECTED');
    return null;
  }
  if (!present || !fs.existsSync(path.join(contents, adapterSupervisor.BRIDGE))) reject('MAC_ADAPTER_SUPERVISOR_REQUIRED');
  const section = adapterSupervisor.signService({ app, identity: options.identity, keychain: options.keychain,
    appId: infoValue(app, 'CFBundleIdentifier'), version: infoValue(app, 'CFBundleShortVersionString') });
  const manifestPath = path.join(contents, 'Resources', 'runtime', MANIFEST);
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  fs.writeFileSync(manifestPath, JSON.stringify({ ...manifest, adapterSupervisor: section }, null, 2) + '\n');
  return section;
}

async function sign(options) {
  const app = path.resolve(options.app);
  if (!app.endsWith('.app') || fs.lstatSync(app).isSymbolicLink()) reject('MAC_APP_BUNDLE_REQUIRED');
  const runtime = path.join(app, 'Contents', 'Resources', 'runtime');
  const adapter = signAdapterSupervisor(app, options);
  const adapterPaths = adapter ? [adapterSupervisor.SERVICE_DIRECTORY, adapterSupervisor.BRIDGE].map(relative => path.join(app, 'Contents', relative)) : [];
  const signedManifest = await signRuntime(runtime, options);
  const ignored = options.ignore;
  const binaries = options.binaries || [];
  if (binaries.some(file => !inside(app, file))) reject('MAC_EXTERNAL_SIGNING_TARGET');
  const { signAsync } = builderRequire()('@electron/osx-sign');
  await signAsync({
    ...options, strictVerify: true,
    binaries: binaries.filter(file => !inside(runtime, file) && !adapterPaths.some(root => inside(root, file))),
    // The service and bridge keep their own entitlements; the outer signature only seals them.
    ignore: file => inside(runtime, file) || adapterPaths.some(root => inside(root, file)) || Boolean(ignored?.(file)),
  });
  // The outer signature seals the final manifest and must not re-sign the runtime a second time.
  await validateRuntimeManifest(runtime, signedManifest);
  const onDisk = JSON.parse(fs.readFileSync(path.join(runtime, MANIFEST), 'utf8'));
  if (JSON.stringify(onDisk) !== JSON.stringify(signedManifest)) reject('MAC_MANIFEST_CHANGED_AFTER_SIGNING');
  codesign(['--verify', '--strict', '--deep', app]);
}

module.exports = sign;
module.exports.signRuntime = signRuntime;
module.exports.validateMacBuild = validateMacBuild;
module.exports.signAdapterSupervisor = signAdapterSupervisor;
