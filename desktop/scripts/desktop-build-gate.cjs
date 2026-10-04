'use strict';
const path = require('node:path');
const { requireWindowsReadiness, verifyWindowsStage } = require('./windows-readiness.cjs');
const { validateMacBuild } = require('./sign-macos-runtime.cjs');

module.exports = async function beforePack(context) {
  // Also protect direct electron-builder invocation, which bypasses npm scripts.
  if (context.electronPlatformName === 'darwin') await validateMacBuild(context);
  if (context.electronPlatformName === 'win32') {
    if (context.packager?.projectDir) verifyWindowsStage(path.join(context.packager.projectDir, 'stage', 'runtime'));
    requireWindowsReadiness();
  }
};
