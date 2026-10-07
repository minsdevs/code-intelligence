'use strict';
// SEC-M-04 packaging configuration: the afterPack hook flips the reviewed fuses through
// electron-builder's own @electron/fuses before signing. No app is packaged or launched here.
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { createRequire } = require('node:module');

const desktop = path.resolve(__dirname, '..');
const builderRequire = createRequire(require.resolve('app-builder-lib/package.json', { paths: [desktop] }));
const { PlatformPackager } = builderRequire('app-builder-lib');
const { FuseV1Options, FuseVersion } = builderRequire('@electron/fuses');
const pkg = require('../package.json');

test('the product build declares the fuse hook as afterPack and no second fuse source', () => {
  assert.equal(pkg.build.afterPack, './scripts/electron-fuses.cjs');
  assert.equal(pkg.build.electronFuses, undefined, 'builder-level electronFuses would flip a second, unreviewed set');
  assert.equal(require(path.join(desktop, pkg.build.afterPack)), require('../scripts/electron-fuses.cjs'));
});

test('product and unknown app ids get every reviewed fuse; only the validation id keeps --inspect for Playwright', () => {
  const { fusesFor, PRODUCT_FUSES, VALIDATION_APP_ID } = require('../scripts/electron-fuses.cjs');
  const product = { runAsNode: true, enableCookieEncryption: true, enableNodeOptionsEnvironmentVariable: false,
    enableNodeCliInspectArguments: false, enableEmbeddedAsarIntegrityValidation: true, onlyLoadAppFromAsar: true,
    grantFileProtocolExtraPrivileges: false };
  assert.deepEqual({ ...PRODUCT_FUSES }, product);
  assert.equal(Object.isFrozen(PRODUCT_FUSES), true);
  for (const id of [pkg.build.appId, undefined, '', 'dev.codeintelligence.desktop.validation.x', 'DEV.CODEINTELLIGENCE.DESKTOP.VALIDATION']) {
    assert.deepEqual(fusesFor(id), product, String(id));
  }
  assert.equal(VALIDATION_APP_ID, 'dev.codeintelligence.desktop.validation');
  assert.deepEqual(fusesFor(VALIDATION_APP_ID), { ...product, enableNodeCliInspectArguments: true });
});

async function flipped(appId, electronPlatformName = 'darwin') {
  const calls = [];
  const packager = { appInfo: { id: appId }, generateFuseConfig: PlatformPackager.prototype.generateFuseConfig,
    addElectronFuses: async (context, config) => { calls.push({ context, config }); } };
  const context = { packager, electronPlatformName, appOutDir: '/synthetic/out' };
  await require(path.join(desktop, pkg.build.afterPack))(context);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].context, context);
  return calls[0].config;
}

test('the hook hands electron-builder the exact @electron/fuses wire for the product', async () => {
  assert.deepEqual(await flipped(pkg.build.appId), {
    version: FuseVersion.V1, resetAdHocDarwinSignature: true,
    [FuseV1Options.RunAsNode]: true,
    [FuseV1Options.EnableCookieEncryption]: true,
    [FuseV1Options.EnableNodeOptionsEnvironmentVariable]: false,
    [FuseV1Options.EnableNodeCliInspectArguments]: false,
    [FuseV1Options.EnableEmbeddedAsarIntegrityValidation]: true,
    [FuseV1Options.OnlyLoadAppFromAsar]: true,
    [FuseV1Options.GrantFileProtocolExtraPrivileges]: false,
  });
  const windows = await flipped(pkg.build.appId, 'win32');
  assert.equal(windows.resetAdHocDarwinSignature, false);
  assert.equal(windows[FuseV1Options.EnableNodeCliInspectArguments], false);
  const validation = await flipped('dev.codeintelligence.desktop.validation');
  assert.equal(validation[FuseV1Options.EnableNodeCliInspectArguments], true);
  assert.equal(validation[FuseV1Options.EnableNodeOptionsEnvironmentVariable], false);
});
