'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');
const { createRequire } = require('node:module');

function tapCounts(output) {
  const counts = {};
  for (const name of ['tests', 'pass', 'fail', 'cancelled', 'skipped', 'todo']) {
    const matches = [...output.matchAll(new RegExp(`^# ${name} (\\d+)\\s*$`, 'gm'))];
    assert.equal(matches.length, 1, 'Missing or ambiguous native TAP summary');
    counts[name] = Number(matches[0][1]);
  }
  return counts;
}

function tapDiagnostics(output) {
  // Never export TAP names, assertion values/messages, paths, or raw stacks.
  // Fixed test basenames and numeric locations locate failures without disclosing paths.
  const results = [];
  const entries = [...output.matchAll(/^(not )?ok (\d+) - [^\r\n]*(?:\r?\n|$)/gm)];
  for (let index = 0; index < entries.length && index < 128; index++) {
    const entry = entries[index];
    const detail = output.slice(entry.index + entry[0].length, entries[index + 1]?.index ?? output.length);
    const lines = [...detail.matchAll(/(windows-native-boundary|windows-unix-server)\.test\.cjs:(\d{1,6}):(\d{1,6})/g)];
    results.push({ ordinal: Number(entry[2]), status: entry[1] ? 'FAIL' : 'PASS',
      sourceLocations: lines.slice(0, 8).map(match => ({ file: `${match[1]}.test.cjs`, line: Number(match[2]), column: Number(match[3]) })) });
  }
  return results;
}

function requireNativePass(result, counts) {
  assert.equal(result.status, 0); assert.equal(result.error, undefined); assert.equal(result.signal, null);
  assert.ok(counts.tests >= 9, 'Real Windows tests did not run');
  assert.equal(counts.pass, counts.tests);
  for (const field of ['fail', 'cancelled', 'skipped', 'todo']) assert.equal(counts[field], 0, 'Skipped or failed native checks cannot pass');
}

function buildNative(cmake, native, build, owned, artifacts, env) {
  // Only public repository C++/CMake and OS toolchain output goes into this log.
  // Do not reuse this for npm, Electron, helper invocations, or test/runtime output.
  const buildEnv = Object.fromEntries(Object.entries(env).filter(([key]) => /^(?:SystemRoot|windir|PATH|TEMP|TMP|USERPROFILE|HOMEDRIVE|HOMEPATH|APPDATA|LOCALAPPDATA|ProgramFiles(?:\(x86\))?|ProgramW6432|COMSPEC|PATHEXT|VSINSTALLDIR|VCINSTALLDIR|VCToolsInstallDir|WindowsSdkDir|WindowsSDKVersion|INCLUDE|LIB|LIBPATH)$/i.test(key)));
  const fd = fs.openSync(path.join(artifacts, 'windows-native-build.log'), 'wx', 0o600);
  try {
    for (const [phase, args] of [
      ['cmake-configure', ['-S', native, '-B', build, '-A', 'x64']],
      ['msvc-build', ['--build', build, '--config', 'Release']],
    ]) {
      fs.writeSync(fd, '[' + phase + ']\n');
      const result = spawnSync(cmake, args, { cwd: owned, env: buildEnv, stdio: ['ignore', fd, fd], timeout: 15 * 60 * 1000, windowsHide: true });
      if (result.status !== 0 || result.error || result.signal) {
        const error = new Error('WINDOWS_NATIVE_BUILD_FAILED');
        error.exitStatus = Number.isInteger(result.status) ? result.status : null;
        error.commandEvidence = { executable: 'cmake.exe', phase, diagnostics: 'windows-native-build.log',
          launchFailure: !!result.error, timedOut: result.error?.code === 'ETIMEDOUT' };
        throw error;
      }
    }
  } finally { fs.closeSync(fd); }
}
function requireStandardUserToken(token) {
  assert.deepEqual(token, { elevated: false, serviceAccount: false, freshLocalUser: true,
    exactSid: true, administratorGroup: false, profileLoaded: true, currentUserDpapi: true });
}

async function runWindows({ source, owned, artifacts, report, run, env }) {
  assert.equal(process.platform, 'win32'); assert.equal(process.arch, 'x64');
  // The launcher attests its actual WindowsPrincipal token before this process is created.
  const token = JSON.parse(fs.readFileSync(path.join(artifacts, 'token.json'), 'utf8'));
  requireStandardUserToken(token);
  const build = path.join(owned, 'native-build');
  const native = path.join(source, 'desktop', 'native', 'windows');
  assert.ok(path.isAbsolute(env.NATIVE_ACCEPTANCE_CMAKE || ''));
  buildNative(env.NATIVE_ACCEPTANCE_CMAKE, native, build, owned, artifacts, env);
  const runtime = path.join(owned, 'native-runtime');
  const helper = path.join(runtime, 'native', 'windows', 'codeintel-boundary.exe');
  fs.mkdirSync(path.dirname(helper), { recursive: true });
  fs.copyFileSync(path.join(build, 'Release', 'codeintel-boundary.exe'), helper, fs.constants.COPYFILE_EXCL);
  report.checks.push('current-source-msvc-x64-native-helper');
  const temporary = path.join(owned, 'native-test-temp'); fs.mkdirSync(temporary);
  const nativeEnv = { ...env, TEMP: temporary, TMP: temporary, CI_WINDOWS_BOUNDARY_TEST_RUNTIME: runtime };
  const result = spawnSync(process.execPath, ['--test', '--test-reporter=tap', path.join(source, 'desktop', 'test', 'windows-native-boundary.test.cjs')], {
    cwd: source, env: nativeEnv, encoding: 'utf8', timeout: 180000, maxBuffer: 4 * 1024 * 1024, windowsHide: true
  });
  fs.writeFileSync(path.join(owned, 'native-tests-private.tap'), result.stdout || '');
  fs.writeFileSync(path.join(owned, 'native-tests-private.stderr.log'), result.stderr || '');
  const nativeReport = { format: 1, standardUser: true, productAcceptance: false,
    helperSha256: crypto.createHash('sha256').update(fs.readFileSync(helper)).digest('hex'),
    exitStatus: Number.isInteger(result.status) ? result.status : null, status: 'FAIL', counts: null,
    launchFailure: !!result.error, timedOut: result.error?.code === 'ETIMEDOUT', tests: tapDiagnostics(result.stdout || '') };
  try {
    nativeReport.counts = tapCounts(result.stdout || '');
    requireNativePass(result, nativeReport.counts);
    nativeReport.status = 'PASS';
  } finally {
    // Raw TAP/stderr remain private; only numeric summaries/source locations cross the boundary.
    fs.writeFileSync(path.join(artifacts, 'windows-native.json'), JSON.stringify(nativeReport, null, 2) + '\n');
  }
  report.checks.push('real-standard-user-ntfs-leases-job-object-security');
  const desktop = path.join(source, 'desktop');
  const electron = createRequire(path.join(desktop, 'package.json'))('electron');
  const probe = path.join(owned, 'safe-storage'); fs.mkdirSync(probe);
  const safeReport = { format: 1, provider: 'Electron-safeStorage-Windows-DPAPI', standardUser: true,
    processRestart: false, status: 'FAIL' };
  try {
    for (const mode of ['write', 'read']) run(electron, [path.join(desktop, 'scripts', 'native-acceptance-safe-storage.cjs'), mode, probe], desktop, env);
    safeReport.processRestart = true; safeReport.status = 'PASS';
  } finally { fs.writeFileSync(path.join(artifacts, 'windows-safe-storage.json'), JSON.stringify(safeReport, null, 2) + '\n'); }
  report.checks.push('real-standard-user-electron-DPAPI-process-restart');
  report.nativeBoundaryStatus = 'PASS'; report.productAcceptance = 'BLOCKED';
}
module.exports = { runWindows, tapCounts, tapDiagnostics, requireNativePass, requireStandardUserToken };
