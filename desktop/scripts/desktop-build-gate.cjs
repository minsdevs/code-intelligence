'use strict';
const path = require('node:path');
const { requireWindowsReadiness, verifyWindowsStage } = require('./windows-readiness.cjs');
const { validateMacBuild } = require('./sign-macos-runtime.cjs');
const { requireReleaseUpdateKeys } = require('../src/update-service.cjs');

module.exports = async function beforePack(context) {
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
