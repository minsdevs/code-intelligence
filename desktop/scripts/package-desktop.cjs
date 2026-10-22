'use strict';

// Native runtime supply is OS/architecture-specific. Refuse cross-packaging before
// staging can replace an existing runtime; invoke Node entrypoints without a shell.
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { requireBuildSequence } = require('./runtime-stage.cjs');

const TARGETS = Object.freeze({
  mac: { platform: 'darwin', arch: 'arm64', flag: '--mac', distribution: ['dmg', 'zip'] },
  win: { platform: 'win32', arch: 'x64', flag: '--win', distribution: ['nsis'] },
  linux: { platform: 'linux', arch: 'x64', flag: '--linux', distribution: ['AppImage', 'deb'] },
});

function packagingPlan(argv, { platform = process.platform, arch = process.arch, env = process.env } = {}) {
  const [mode, target] = argv, spec = TARGETS[target];
  if (argv.length !== 2 || !['pack', 'dist'].includes(mode) || !spec) throw new Error('Usage: package-desktop.cjs pack|dist mac|win|linux');
  if (platform !== spec.platform || arch !== spec.arch) throw new Error(`NATIVE_BUILD_HOST_REQUIRED: ${spec.platform}-${spec.arch}`);
  requireBuildSequence(env.CODE_INTELLIGENCE_BUILD_SEQUENCE);
  const args = [spec.flag, ...(mode === 'pack' ? ['dir'] : spec.distribution), `--${spec.arch}`, '--publish', 'never'];
  if (mode === 'pack' && target === 'mac') args.push('--config.mac.identity=-', '--config.mac.notarize=false');
  if (mode === 'pack' && target === 'win') args.push('--config.win.forceCodeSigning=false', '--config.win.signExecutable=false');
  return { args, environment: { ...env, ...(mode === 'pack' ? { CSC_IDENTITY_AUTO_DISCOVERY: 'false' } : {}) } };
}

function packageDesktop(argv, { run = spawnSync, ...host } = {}) {
  const plan = packagingPlan(argv, host);
  const desktop = path.resolve(__dirname, '..');
  const builder = require.resolve('electron-builder/cli.js');
  for (const args of [[path.join(__dirname, 'stage-runtime.mjs')], [builder, ...plan.args]]) {
    const result = run(process.execPath, args, { cwd: desktop, env: plan.environment, stdio: 'inherit', shell: false });
    if (result.error) throw result.error;
    if (result.status !== 0 || result.signal) throw new Error('DESKTOP_PACKAGE_FAILED');
  }
}

if (require.main === module) {
  try { packageDesktop(process.argv.slice(2)); }
  catch (error) { console.error(error.message); process.exitCode = 1; }
}
module.exports = { packagingPlan, packageDesktop };
