'use strict';
const { requireWindowsReadiness } = require('./windows-readiness.cjs');

module.exports = async function beforePack(context) {
  // Also protect direct electron-builder invocation, which bypasses npm scripts.
  if (context.electronPlatformName === 'win32') requireWindowsReadiness();
};
