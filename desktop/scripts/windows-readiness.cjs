'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { verifyWindowsRuntime } = require('./windows-pe-policy.cjs');
const supplies = require('./windows-runtime-supply.json');
// Build/engineering acceptance and release approval are distinct. An unsigned
// hosted smoke cannot attest interactive Windows 11, power loss or signed updates.
const remainingValidation = Object.freeze([
  'Actual Windows native storage/process and full product acceptance must be reviewed for the current source and runtime manifest.',
  'Signed Windows installer, update, rollback and clean interactive Windows 11 user flows are not validated.',
  'Windows power-loss recovery and provider approval gates remain independently required.',
  'Redistributed dependency license/notices and corresponding-source obligations require release review.'
]);
function verifyWindowsStage(root) {
  const manifest = JSON.parse(fs.readFileSync(path.join(root, 'runtime-manifest.json'), 'utf8'));
  const provenance = JSON.parse(fs.readFileSync(path.join(root, 'windows-provenance.json'), 'utf8'));
  return verifyWindowsRuntime({ root, manifest, provenance, supplies });
}
function windowsReadiness(platform = process.platform, arch = process.arch, root) {
  const result = { target: 'win32-x64', status: 'BLOCKED', host: { platform, arch },
    nativeWindowsValidation: false, releaseValidation: 'NOT_RUN', blockers: [],
    remainingValidation: [...remainingValidation], runtimeInventory: { status: 'NOT_CHECKED' } };
  if (platform !== 'win32' || arch !== 'x64') result.blockers.push('Windows x64 native packaging host required.');
  if (root) {
    try { result.runtimeInventory = { status: 'PASS', ...verifyWindowsStage(root) }; }
    catch (error) {
      result.runtimeInventory = { status: 'FAIL', code: error.code || 'INVALID_WINDOWS_RUNTIME' };
      result.blockers.push('A complete verified Windows runtime stage is required.');
    }
  } else result.blockers.push('A complete verified Windows runtime stage is required.');
  if (!result.blockers.length) result.status = 'READY_TO_PACKAGE';
  return result;
}
function requireWindowsReadiness({ root, platform = process.platform, arch = process.arch } = {}) {
  const result = windowsReadiness(platform, arch, root);
  if (result.status !== 'READY_TO_PACKAGE') {
    throw Object.assign(new Error('Windows packaging is blocked: ' + result.blockers.join(' ')), { code: 'WINDOWS_PACKAGING_NOT_READY' });
  }
  // Packaging readiness is not native acceptance, Authenticode or release approval.
  // The packaging hook independently enforces Windows signing requirements.
  return result;
}
if (require.main === module) {
  const result = windowsReadiness(process.platform, process.arch, path.resolve(__dirname, '..', 'stage', 'runtime'));
  console.log(JSON.stringify(result, null, 2));
  process.exitCode = result.status === 'READY_TO_PACKAGE' ? 0 : 1;
}
module.exports = { windowsReadiness, requireWindowsReadiness, verifyWindowsStage };
