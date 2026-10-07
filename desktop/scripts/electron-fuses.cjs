'use strict';

// SEC-M-04: flip Electron fuses in afterPack, before electron-builder signs the app, so no
// same-user process can run code as the signed app identity through NODE_OPTIONS, --inspect,
// a loose app folder or a modified app.asar. electron-builder's own @electron/fuses performs the
// flip (context.packager.addElectronFuses), so no second copy of the library is required.
const path = require('node:path');
const { adapterIsolationMode } = require('../src/adapter-isolation.cjs');
const adapterSupervisor = require('./adapter-supervisor.cjs');
const packageMetadata = require('../package.json');

const VALIDATION_APP_ID = 'dev.codeintelligence.desktop.validation';

const PRODUCT_FUSES = Object.freeze({
  // Needed only while the `legacy-http` adapter build flag starts the TypeScript analyzer from the
  // app binary with ELECTRON_RUN_AS_NODE=1; fusesFor turns it off for the ADR-01 modes.
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
function fusesFor(appId, metadata = packageMetadata) {
  const fuses = { ...PRODUCT_FUSES, runAsNode: adapterIsolationMode(metadata) === 'legacy-http' };
  return appId === VALIDATION_APP_ID ? { ...fuses, enableNodeCliInspectArguments: true } : fuses;
}

// ADR-01: with `xpc-required` the app carries the adapter supervisor service and its bridge,
// staged by stage-runtime.mjs; the signing hook signs them before the app.
function installAdapterSupervisor(context, metadata = packageMetadata, install = adapterSupervisor.installService) {
  if (adapterIsolationMode(metadata) !== 'xpc-required') return false;
  if (context.electronPlatformName !== 'darwin') throw Object.assign(new Error('ADAPTER_SUPERVISOR_MACOS_ONLY'), { code: 'ADAPTER_SUPERVISOR_MACOS_ONLY' });
  install({ app: path.join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`),
    stage: path.join(context.packager.projectDir, 'stage', 'adapter-supervisor') });
  return true;
}

module.exports = async function afterPack(context) {
  const fuses = fusesFor(context.packager.appInfo.id);
  const config = await context.packager.generateFuseConfig({
    ...fuses, resetAdHocDarwinSignature: context.electronPlatformName === 'darwin'
  });
  await context.packager.addElectronFuses(context, config);
  installAdapterSupervisor(context);
};
module.exports.PRODUCT_FUSES = PRODUCT_FUSES;
module.exports.VALIDATION_APP_ID = VALIDATION_APP_ID;
module.exports.fusesFor = fusesFor;
module.exports.installAdapterSupervisor = installAdapterSupervisor;
