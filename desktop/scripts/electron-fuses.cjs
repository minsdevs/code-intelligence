'use strict';

// SEC-M-04: flip Electron fuses in afterPack, before electron-builder signs the app, so no
// same-user process can run code as the signed app identity through NODE_OPTIONS, --inspect,
// a loose app folder or a modified app.asar. electron-builder's own @electron/fuses performs the
// flip (context.packager.addElectronFuses), so no second copy of the library is required.
const VALIDATION_APP_ID = 'dev.codeintelligence.desktop.validation';

const PRODUCT_FUSES = Object.freeze({
  // Stays on until the TypeScript analyzer no longer starts the app binary with
  // ELECTRON_RUN_AS_NODE=1 (ADR-01 supervisor or a separately signed Node runtime).
  runAsNode: true,
  enableCookieEncryption: true,
  enableNodeOptionsEnvironmentVariable: false,
  enableNodeCliInspectArguments: false,
  enableEmbeddedAsarIntegrityValidation: true,
  onlyLoadAppFromAsar: true,
  grantFileProtocolExtraPrivileges: false
});

// Validation candidates are driven by Playwright's _electron.launch, which attaches through
// --inspect=0. Only that fuse differs, and only for the exact validation app id.
function fusesFor(appId) {
  return appId === VALIDATION_APP_ID
    ? { ...PRODUCT_FUSES, enableNodeCliInspectArguments: true }
    : { ...PRODUCT_FUSES };
}

module.exports = async function afterPack(context) {
  const fuses = fusesFor(context.packager.appInfo.id);
  const config = await context.packager.generateFuseConfig({
    ...fuses, resetAdHocDarwinSignature: context.electronPlatformName === 'darwin'
  });
  await context.packager.addElectronFuses(context, config);
};
module.exports.PRODUCT_FUSES = PRODUCT_FUSES;
module.exports.VALIDATION_APP_ID = VALIDATION_APP_ID;
module.exports.fusesFor = fusesFor;
