'use strict';
const path = require('node:path');
const { createRequire } = require('node:module');
const [desktop, out, appId] = process.argv.slice(2);
const r = createRequire(require.resolve('app-builder-lib/package.json', { paths: [desktop] }));
const { PlatformPackager } = r('app-builder-lib');
const { getCurrentFuseWire, FuseV1Options } = r('@electron/fuses');
(async () => {
  const app = path.join(out, 'Electron.app');
  const before = await getCurrentFuseWire(app);
  const packager = { appInfo: { id: appId, productFilename: 'Electron' } };
  packager.generateFuseConfig = PlatformPackager.prototype.generateFuseConfig.bind(packager);
  packager.addElectronFuses = PlatformPackager.prototype.addElectronFuses.bind(packager);
  await require(path.join(desktop, 'scripts/electron-fuses.cjs'))({ packager, electronPlatformName: 'darwin', appOutDir: out });
  const after = await getCurrentFuseWire(app);
  const name = wire => Object.fromEntries(Object.entries(FuseV1Options).filter(([k]) => isNaN(Number(k))).map(([k, v]) => [k, wire[v] === 49 ? 'ENABLE' : wire[v] === 48 ? 'DISABLE' : String(wire[v])]));
  console.log(JSON.stringify({ appId, before: name(before), after: name(after) }, null, 1));
})().catch(e => { console.error(e); process.exit(1); });
