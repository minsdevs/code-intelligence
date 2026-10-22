'use strict';
const path = require('node:path');
const fs = require('node:fs/promises');
const { requireWindowsReadiness } = require('./windows-readiness.cjs');
const { validateRuntimeManifest } = require('../src/runtime-manifest.cjs');
const { adapterIsolationMode } = require('../src/adapter-isolation.cjs');
const { validateMacBuild } = require('./sign-macos-runtime.cjs');
const { requireReleaseUpdateKeys } = require('../src/update-service.cjs');
const { validationProviderTarget } = require('../src/ai-https-transport.cjs');
const { validationUpdateFeed } = require('../src/update-validation-feed.cjs');
const { VALIDATION_APP_ID } = require('./electron-fuses.cjs');
const { registerWindowsRuntimeSigning } = require('./sign-windows-runtime.cjs');

function requireNativePackaging(context, host = process) {
  const platform = context.electronPlatformName;
  if (!['win32', 'linux'].includes(platform)) throw new Error('UNSUPPORTED_NATIVE_PACKAGE_TARGET');
  // electron-builder uses builder-util.Arch.x64 = 1.
  if (host.platform !== platform || host.arch !== 'x64' || context.arch !== 1) throw new Error('NATIVE_BUILD_HOST_REQUIRED');
  // Windows/Linux builder packagers omit the dir target object, so a directory-only
  // build reaches beforePack with an explicit empty array. Missing targets are invalid.
  if (!Array.isArray(context.targets)) throw new Error('NATIVE_BUILD_TARGETS_REQUIRED');
  const allowed = platform === 'win32' ? ['dir', 'nsis'] : ['dir', 'appimage', 'deb'];
  // The CLI accepts AppImage, while builder's target object is named appImage.
  if (context.targets.some(target => typeof target?.name !== 'string'
      || !allowed.includes(target.name.toLowerCase()))) throw new Error('UNSUPPORTED_NATIVE_PACKAGE_TARGET');
  if (!path.isAbsolute(context.packager?.projectDir || '')) throw new Error('NATIVE_BUILD_PROJECT_REQUIRED');
  const metadata = { ...context.packager?.info?.metadata, ...context.packager?.config?.extraMetadata };
  if (adapterIsolationMode(metadata) !== 'legacy-http') throw new Error('ADAPTER_SUPERVISOR_MACOS_ONLY');
  if (platform === 'win32') {
    const options = context.packager.platformSpecificBuildOptions;
    if (options?.azureSignOptions || options?.signtoolOptions?.sign !== './scripts/sign-windows-runtime.cjs'
        || JSON.stringify(options?.signtoolOptions?.signingHashAlgorithms) !== '["sha256"]') {
      throw new Error('WINDOWS_RUNTIME_SIGNING_POLICY_REQUIRED');
    }
  }
  if (platform === 'win32' && context.targets.some(target => target.name !== 'dir')
      && (context.packager.forceCodeSigning !== true || context.packager.platformSpecificBuildOptions?.signAndEditExecutable === false
        || context.packager.platformSpecificBuildOptions?.signExecutable === false)) {
    throw new Error('WINDOWS_DISTRIBUTION_REQUIRES_AUTHENTICODE');
  }
}

// G-COST PK-08: the loopback fake-provider origin may ship only in a validation directory build.
function requireValidationOnlyProviderVariant(context) {
  const metadata = { ...context.packager?.info?.metadata, ...context.packager?.config?.extraMetadata };
  if (!Object.hasOwn(metadata, 'validationAiProviderOrigin')) return null;
  const target = validationProviderTarget(metadata);
  if (context.packager?.appInfo?.id !== VALIDATION_APP_ID || !Array.isArray(context.targets)
      || context.targets.some(entry => entry?.name !== 'dir')) {
    throw Object.assign(new Error('VALIDATION_AI_PROVIDER_REFUSED'), { code: 'VALIDATION_AI_PROVIDER_REFUSED' });
  }
  return target;
}

// G-UPDATE packaged acceptance: the loopback update feed may ship only in a validation directory build.
function requireValidationOnlyUpdateFeed(context) {
  const metadata = { ...context.packager?.info?.metadata, ...context.packager?.config?.extraMetadata };
  if (!Object.hasOwn(metadata, 'validationUpdateFeed')) return null;
  const feed = validationUpdateFeed(metadata);
  if (context.packager?.appInfo?.id !== VALIDATION_APP_ID || !Array.isArray(context.targets)
      || context.targets.some(entry => entry?.name !== 'dir')) {
    throw Object.assign(new Error('VALIDATION_UPDATE_FEED_REFUSED'), { code: 'VALIDATION_UPDATE_FEED_REFUSED' });
  }
  return feed;
}

module.exports = async function beforePack(context) {
  requireValidationOnlyProviderVariant(context);
  requireValidationOnlyUpdateFeed(context);
  // Also protect direct electron-builder invocation, which bypasses npm scripts.
  if (context.electronPlatformName === 'darwin') {
    // A distributed build without pinned update keys would ship an updater that can never verify.
    await requireReleaseUpdateKeys(context.packager?.projectDir, context.targets);
    await validateMacBuild(context);
  }
  if (context.electronPlatformName === 'win32') {
    requireNativePackaging(context);
    const root = path.join(context.packager.projectDir, 'stage', 'runtime');
    requireWindowsReadiness({ root });
    const manifest = JSON.parse(await fs.readFile(path.join(root, 'runtime-manifest.json'), 'utf8'));
    await validateRuntimeManifest(root, manifest);
    registerWindowsRuntimeSigning(context, manifest);
  }
  if (context.electronPlatformName === 'linux') {
    requireNativePackaging(context);
    await require('./stage-linux-runtime.cjs').verifyLinuxStage(path.join(context.packager.projectDir, 'stage', 'runtime'));
  }
};
module.exports.requireNativePackaging = requireNativePackaging;
module.exports.requireValidationOnlyProviderVariant = requireValidationOnlyProviderVariant;
module.exports.requireValidationOnlyUpdateFeed = requireValidationOnlyUpdateFeed;
