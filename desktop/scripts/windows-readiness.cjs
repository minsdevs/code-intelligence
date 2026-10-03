'use strict';

// Build preparation only. These gates may be removed only with an implemented and
// validated Windows runtime; environment variables cannot opt out of data safety.
const blockers = Object.freeze([
  'Windows ACL, reparse-point, durable replacement and lock implementation is not validated.',
  'The main-process secure-storage lifecycle currently requires macOS; Windows DPAPI policy is pending.',
  'A redis-compatible Windows runtime or an approved desktop session/event replacement is not selected.',
  'Relocatable Windows x64 JRE 21, PostgreSQL and matching extensions are not staged and verified.',
  'Owned process-tree shutdown, signed install/update/rollback and clean Windows user flows are unverified.',
]);

function windowsReadiness(platform = process.platform, arch = process.arch) {
  return { target: 'win32-x64', status: 'BLOCKED', host: { platform, arch },
    nativeWindowsValidation: false, blockers: [...blockers] };
}

function requireWindowsReadiness() {
  throw new Error('Windows packaging is blocked: ' + blockers.join(' '));
}

if (require.main === module) {
  console.log(JSON.stringify(windowsReadiness(), null, 2));
  process.exitCode = 1;
}

module.exports = { windowsReadiness, requireWindowsReadiness };
