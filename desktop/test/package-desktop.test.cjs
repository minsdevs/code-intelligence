'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { packagingPlan, packageDesktop } = require('../scripts/package-desktop.cjs');
const { requireNativePackaging } = require('../scripts/desktop-build-gate.cjs');
const env = { CODE_INTELLIGENCE_BUILD_SEQUENCE: '42' };
const windowsOptions = { signtoolOptions: { sign: './scripts/sign-windows-runtime.cjs', signingHashAlgorithms: ['sha256'] } };

test('cross-packaging is refused before stage or builder can change files', () => {
  for (const target of ['win', 'linux']) {
    let calls = 0;
    assert.throws(() => packageDesktop(['pack', target], { platform: 'darwin', arch: 'arm64', env, run() { calls++; } }), /NATIVE_BUILD_HOST_REQUIRED/);
    assert.equal(calls, 0);
  }
  for (const [target, platform] of [['mac', 'darwin'], ['win', 'win32'], ['linux', 'linux']]) {
    assert.throws(() => packagingPlan(['pack', target], { platform, arch: 'ia32', env }), /NATIVE_BUILD_HOST_REQUIRED/);
  }
});

test('directory builds are local and installer builds retain signing policy', () => {
  for (const [target, platform, arch, installer] of [['mac', 'darwin', 'arm64', 'dmg'], ['win', 'win32', 'x64', 'nsis'], ['linux', 'linux', 'x64', 'AppImage']]) {
    const local = packagingPlan(['pack', target], { platform, arch, env });
    assert(local.args.includes('dir')); assert(local.args.includes('never'));
    assert.equal(local.environment.CSC_IDENTITY_AUTO_DISCOVERY, 'false');
    const release = packagingPlan(['dist', target], { platform, arch, env });
    assert(release.args.includes(installer)); assert(release.args.includes('never'));
    assert(!release.args.some(value => /forceCodeSigning=false|identity=-|notarize=false/.test(value)));
    assert.equal(release.environment.CSC_IDENTITY_AUTO_DISCOVERY, undefined);
  }
});

test('package build stops after failed stage and uses argument arrays without shell expansion', () => {
  const calls = [];
  const host = { platform: 'linux', arch: 'x64', env };
  assert.throws(() => packageDesktop(['pack', 'linux'], { ...host, run(command, args, options) {
    calls.push({ command, args, options }); return { status: 1 };
  } }), /DESKTOP_PACKAGE_FAILED/);
  assert.equal(calls.length, 1); assert.equal(calls[0].options.shell, false);
  assert(calls[0].args[0].endsWith('stage-runtime.mjs'));
  assert.throws(() => packagingPlan(['pack', 'linux', '--publish=always'], host), /Usage/);
  assert.throws(() => packagingPlan(['pack', 'linux'], { ...host, env: {} }), /build sequence|BUILD_SEQUENCE/i);
});

function context(platform, targets, extra = {}) {
  return { electronPlatformName: platform, arch: 1, targets: targets.map(name => ({ name })), packager: {
    projectDir: path.resolve(__dirname, '..'), forceCodeSigning: true,
    platformSpecificBuildOptions: platform === 'win32' ? windowsOptions : {}, ...extra,
  } };
}

test('the installed builder AppImage target passes the native distribution gate', () => {
  require('app-builder-lib');
  const AppImageTarget = require('app-builder-lib/out/targets/appimage/AppImageTarget').default;
  const value = context('linux', []);
  value.packager.config = {};
  value.targets = [new AppImageTarget('appimage', value.packager, {}, path.resolve(__dirname, '..', 'dist'))];
  assert.doesNotThrow(() => requireNativePackaging(value, { platform: 'linux', arch: 'x64' }));
});

test('direct builder invocation cannot bypass native target or Windows installer signing guards', () => {
  for (const platform of ['win32', 'linux']) {
    const value = context(platform, ['dir']), host = { platform, arch: 'x64' };
    assert.doesNotThrow(() => requireNativePackaging(value, host));
    assert.throws(() => requireNativePackaging(value, { platform: 'darwin', arch: 'arm64' }), /NATIVE_BUILD_HOST_REQUIRED/);
    assert.throws(() => requireNativePackaging({ ...value, arch: 3 }, host), /NATIVE_BUILD_HOST_REQUIRED/);
    assert.throws(() => requireNativePackaging(context(platform, []), host), /NATIVE_BUILD_TARGETS_REQUIRED/);
    assert.throws(() => requireNativePackaging(context(platform, ['dir'], { config: { extraMetadata: { adapterIsolation: 'xpc-required' } } }), host), /ADAPTER_SUPERVISOR_MACOS_ONLY/);
  }
  const host = { platform: 'win32', arch: 'x64' };
  assert.doesNotThrow(() => requireNativePackaging(context('win32', ['nsis']), host));
  assert.throws(() => requireNativePackaging(context('win32', ['nsis'], { forceCodeSigning: false }), host), /AUTHENTICODE/);
  for (const override of [{ signAndEditExecutable: false }, { signExecutable: false }]) {
    assert.throws(() => requireNativePackaging(context('win32', ['nsis'], { platformSpecificBuildOptions: { ...windowsOptions, ...override } }), host), /AUTHENTICODE/);
  }
  assert.throws(() => requireNativePackaging(context('win32', ['nsis'], { platformSpecificBuildOptions: {} }), host), /SIGNING_POLICY/);
  assert.throws(() => requireNativePackaging(context('win32', ['nsis'], { platformSpecificBuildOptions: { ...windowsOptions, azureSignOptions: {} } }), host), /SIGNING_POLICY/);
  assert.throws(() => requireNativePackaging(context('win32', ['portable']), host), /UNSUPPORTED_NATIVE_PACKAGE_TARGET/);
});
