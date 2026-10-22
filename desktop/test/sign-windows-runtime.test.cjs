'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const signWindowsFile = require('../scripts/sign-windows-runtime.cjs');
const { registerWindowsRuntimeSigning, preserveRuntimeFile, verifyPackagedWindowsRuntime } = signWindowsFile;
const host = { platform: 'win32', arch: 'x64' };

function fixture(t) {
  const appOutDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'windows-signing-policy-')));
  t.after(() => fs.rmSync(appOutDir, { recursive: true, force: true }));
  const file = path.join(appOutDir, 'resources/runtime/jre/bin/java.exe');
  fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, 'synthetic vendor-signed runtime bytes');
  const manifest = { platform: 'win32', arch: 'x64', files: {
    'jre/bin/java.exe': crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex')
  } };
  const calls = [], packager = { signingManager: { value: Promise.resolve({
    doSign: async (...args) => { calls.push(args); },
    signFile: () => { throw new Error('recursive signing'); }
  }) } };
  const context = { appOutDir, electronPlatformName: 'win32', packager };
  registerWindowsRuntimeSigning(context, manifest);
  return { file, appOutDir, packager, calls, context, manifest };
}

// These exercise byte preservation and the signing dispatch; no OS signing is run.
test('runtime signature callbacks preserve exact manifest bytes while app and installer use the default signer', async t => {
  const f = fixture(t), original = fs.readFileSync(f.file);
  await signWindowsFile({ path: f.file, hash: 'sha256' }, f.packager, host);
  assert.deepEqual(fs.readFileSync(f.file), original); assert.equal(f.calls.length, 0);
  for (const file of [path.join(f.appOutDir, 'Code Intelligence.exe'), path.join(f.appOutDir, 'Code Intelligence Setup.exe'),
    path.join(f.appOutDir, 'resources/runtime-other/installer.exe')]) {
    const configuration = { path: file, hash: 'sha256', cscInfo: { file: 'synthetic-signing-reference' } };
    await signWindowsFile(configuration, f.packager, host);
    assert.equal(f.calls.at(-1)[0], configuration); assert.equal(f.calls.at(-1)[1], f.packager);
  }
  assert.equal(f.calls.length, 3);
});

test('runtime files cannot be silently re-signed, substituted or added after verification', t => {
  const f = fixture(t);
  fs.writeFileSync(f.file, 'tampered');
  assert.throws(() => preserveRuntimeFile(f.file, f.packager), { code: 'WINDOWS_SIGNING_RUNTIME_CHANGED' });
  assert.throws(() => preserveRuntimeFile(path.join(path.dirname(f.file), 'unlisted.exe'), f.packager), { code: 'WINDOWS_SIGNING_UNLISTED_RUNTIME_FILE' });
  assert.throws(() => preserveRuntimeFile(f.file, {}), { code: 'WINDOWS_SIGNING_CONTEXT_REQUIRED' });
});

test('non-runtime signing requires a certificate and native x64 host and propagates signer failure', async t => {
  const f = fixture(t), configuration = { path: path.join(f.appOutDir, 'Code Intelligence.exe'), hash: 'sha256' };
  await assert.rejects(signWindowsFile(configuration, f.packager, host), { code: 'WINDOWS_SIGNING_CERTIFICATE_REQUIRED' });
  await assert.rejects(signWindowsFile(configuration, f.packager, { platform: 'darwin', arch: 'arm64' }), { code: 'WINDOWS_X64_SIGNING_HOST_REQUIRED' });
  configuration.cscInfo = { file: 'synthetic-signing-reference' };
  const failure = new Error('synthetic signer failure');
  f.packager.signingManager.value = Promise.resolve({ doSign: async () => { throw failure; } });
  await assert.rejects(signWindowsFile(configuration, f.packager, host), error => error === failure);
});

test('afterPack refuses a rewritten runtime manifest before native policy inspection', async t => {
  const f = fixture(t), runtime = path.join(f.appOutDir, 'resources/runtime');
  fs.writeFileSync(path.join(runtime, 'runtime-manifest.json'), JSON.stringify({ ...f.manifest, buildSequence: 'changed' }));
  await assert.rejects(verifyPackagedWindowsRuntime(f.context), { code: 'WINDOWS_SIGNING_MANIFEST_CHANGED' });
  await assert.rejects(require('../scripts/electron-fuses.cjs')(f.context), { code: 'WINDOWS_SIGNING_MANIFEST_CHANGED' });
});

test('the pinned builder supplies the nonrecursive signing manager API', () => {
  // Initialize the public entrypoint first: builder's internal packagers are cyclic.
  require('app-builder-lib');
  const { WindowsSignToolManager } = require('app-builder-lib/out/codeSign/windowsSignToolManager');
  const { WinPackager } = require('app-builder-lib/out/winPackager');
  assert.equal(typeof WindowsSignToolManager.prototype.doSign, 'function');
  assert.equal(typeof WindowsSignToolManager.prototype.signFile, 'function');
  // Ensure a signing-only disable still permits executable resource editing.
  const noSigning = { platformSpecificBuildOptions: { signExecutable: false } };
  assert.equal(WinPackager.prototype.createTransformerForExtraFiles.call(noSigning, {}), null);
});

test('the installed builder calls the custom hook for runtime copies and delegates app signing once', async t => {
  require('app-builder-lib');
  const { WindowsSignToolManager } = require('app-builder-lib/out/codeSign/windowsSignToolManager');
  const f = fixture(t), calls = [];
  const manager = Object.create(WindowsSignToolManager.prototype);
  Object.assign(manager, {
    packager: f.packager,
    cscInfo: { value: Promise.resolve(null) },
    doSign: async configuration => { calls.push(configuration.path); }
  });
  Object.assign(f.packager, {
    appInfo: { productName: 'Signing policy fixture', computePackageUrl: async () => null },
    info: { getWorkspaceRoot: async () => f.appOutDir },
    signingManager: { value: Promise.resolve(manager) }
  });
  const options = { signtoolOptions: { signingHashAlgorithms: ['sha256'],
    sign: (configuration, packager) => signWindowsFile({ ...configuration, cscInfo: { file: 'synthetic-signing-reference' } }, packager, host) } };
  await manager.signFile({ path: f.file, options });
  assert.deepEqual(calls, []);
  const app = path.join(f.appOutDir, 'Code Intelligence.exe');
  await manager.signFile({ path: app, options });
  assert.deepEqual(calls, [app]);
});
