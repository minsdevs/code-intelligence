'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { verifyWindowsRuntime } = require('./windows-pe-policy.cjs');
const supplies = require('./windows-runtime-supply.json');
// Build/engineering acceptance and release approval are distinct. An unsigned
// hosted smoke cannot attest interactive Windows 11, power loss or signed updates.
const blockers = Object.freeze([
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
    nativeWindowsValidation: false, blockers: [...blockers], runtimeInventory: { status: 'NOT_CHECKED' } };
  if (root) {
    try { result.runtimeInventory = { status: 'PASS', ...verifyWindowsStage(root) }; }
    catch (error) { result.runtimeInventory = { status: 'FAIL', code: error.code || 'INVALID_WINDOWS_RUNTIME' }; }
  }
  return result;
}
function requireWindowsReadiness() {
  // No environment switch/evidence JSON can waive the release review.
  throw new Error('Windows packaging is blocked: ' + blockers.join(' '));
}
if (require.main === module) {
  console.log(JSON.stringify(windowsReadiness(process.platform, process.arch, path.resolve(__dirname, '..', 'stage', 'runtime')), null, 2));
  process.exitCode = 1;
}
module.exports = { windowsReadiness, requireWindowsReadiness, verifyWindowsStage };
