'use strict';
const path = require('node:path');
const { requireWindowsReadiness, verifyWindowsStage } = require('./windows-readiness.cjs');
const { validateMacBuild } = require('./sign-macos-runtime.cjs');
const { requireReleaseUpdateKeys } = require('../src/update-service.cjs');
const { validationProviderTarget } = require('../src/ai-https-transport.cjs');
const { VALIDATION_APP_ID } = require('./electron-fuses.cjs');

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

module.exports = async function beforePack(context) {
  requireValidationOnlyProviderVariant(context);
  // Also protect direct electron-builder invocation, which bypasses npm scripts.
  if (context.electronPlatformName === 'darwin') {
    // A distributed build without pinned update keys would ship an updater that can never verify.
    await requireReleaseUpdateKeys(context.packager?.projectDir, context.targets);
    await validateMacBuild(context);
  }
  if (context.electronPlatformName === 'win32') {
    if (context.packager?.projectDir) verifyWindowsStage(path.join(context.packager.projectDir, 'stage', 'runtime'));
    requireWindowsReadiness();
  }
};
module.exports.requireValidationOnlyProviderVariant = requireValidationOnlyProviderVariant;
