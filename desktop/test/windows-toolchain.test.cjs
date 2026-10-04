'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { baseEnvironment, developerEnvironment, readPin, pinKey } = require('../scripts/windows-toolchain.cjs');

// These are deterministic selection/launch regressions, NOT native Windows proof.
// The hosted standard-user path must actually compile, link and run the probe.
const installation = 'C:\\Program Files\\Microsoft Visual Studio\\2022\\Enterprise';
const tools = '14.44.35207', sdk = '10.0.26100.0';
const freshEnv = () => ({ SystemRoot: 'C:\\Windows', 'ProgramFiles(x86)': 'C:\\Program Files (x86)', ProgramFiles: 'C:\\Program Files',
  USERPROFILE: 'C:\\Users\\fresh', APPDATA: 'C:\\Users\\fresh\\AppData\\Roaming', TEMP: 'C:\\private\\temp',
  Path: 'C:\\Users\\runner\\secret-bin', GITHUB_TOKEN: 'must-not-copy', CL: '/DWRONG', _CL_: '/link bad.lib',
  INCLUDE: 'old-headers', LIB: 'old-libs', CMAKE_GENERATOR: 'Visual Studio 18 2026', VSCMD_VER: 'stale' });
function devOutput(root = installation, patch = {}) {
  const env = { PATH: 'C:\\unrelated', INCLUDE: 'C:\\sdk\\include', LIB: 'C:\\sdk\\lib', LIBPATH: 'C:\\sdk\\references',
    VSINSTALLDIR: root + '\\', VCINSTALLDIR: root + '\\VC\\', VCToolsInstallDir: root + '\\VC\\Tools\\MSVC\\' + tools + '\\',
    VCToolsVersion: tools, WindowsSdkDir: 'C:\\Program Files (x86)\\Windows Kits\\10\\', WindowsSDKVersion: sdk + '\\',
    VSCMD_ARG_HOST_ARCH: 'x64', VSCMD_ARG_TGT_ARCH: 'x64', ...patch };
  return Object.entries(env).map(([key, value]) => key + '=' + value).join('\r\n');
}

test('tool discovery discards parent PATH, developer state, flags and secrets but retains the fresh profile', () => {
  const input = freshEnv(), base = baseEnvironment(input);
  assert.equal(base.USERPROFILE, input.USERPROFILE);
  assert.equal(base.APPDATA, input.APPDATA);
  assert.equal(base.SystemDrive, 'C:');
  assert.equal(base.COMSPEC, 'C:\\Windows\\System32\\cmd.exe');
  assert.equal(base.PATH.includes('runner'), false);
  for (const key of ['Path', 'GITHUB_TOKEN', 'CL', '_CL_', 'INCLUDE', 'LIB', 'CMAKE_GENERATOR', 'VSCMD_VER']) assert.equal(base[key], undefined);
  const env = developerEnvironment(devOutput() + '\r\nGITHUB_TOKEN=secret\r\nCL=/DWRONG\r\nUSERPROFILE=C:\\Users\\runner\r\n', base);
  assert.equal(env.USERPROFILE, input.USERPROFILE);
  assert.equal(env.GITHUB_TOKEN, undefined); assert.equal(env.CL, undefined);
  assert.equal(env.INCLUDE, 'C:\\sdk\\include');
  assert.equal(input.Path, 'C:\\Users\\runner\\secret-bin');
});

test('tool environment rejects missing SDK libraries and non-x64 host/target', () => {
  for (const patch of [{ INCLUDE: '' }, { LIB: '' }, { LIBPATH: '' }, { VCToolsInstallDir: '' }, { WindowsSDKVersion: '' },
    { VSCMD_ARG_HOST_ARCH: 'x86' }, { VSCMD_ARG_TGT_ARCH: 'arm64' }]) {
    assert.throws(() => developerEnvironment(devOutput(installation, patch), baseEnvironment(freshEnv())));
  }
  assert.throws(() => baseEnvironment({ SystemRoot: 'relative' }), /SYSTEM_ROOT_REQUIRED/);
});



test('cross-build pins retain exact installation, MSVC and SDK and reject command-bearing versions', () => {
  const pin = { installation, tools, sdk };
  assert.deepEqual(readPin({ [pinKey]: JSON.stringify(pin) }), pin);
  assert.equal(readPin({}), null);
  for (const patch of [{ installation: 'relative' }, { tools: '14.44&echo bad' }, { sdk: '' }, { sdk: '%secret%' }]) {
    assert.throws(() => readPin({ [pinKey]: JSON.stringify({ ...pin, ...patch }) }));
  }
});

function selectionModel(t, { candidates = [installation], missing = () => false, configure = root => devOutput(root), compileFailure = false, runFailure = false } = {}) {
  const owned = fs.mkdtempSync(path.join(os.tmpdir(), 'windows-toolchain-regression-'));
  t.after(() => fs.rmSync(owned, { recursive: true, force: true }));
  const calls = [], checked = [], source = fs.readFileSync(path.join(__dirname, '../scripts/windows-toolchain.cjs'), 'utf8');
  const success = stdout => ({ status: 0, stdout, signal: null });
  const spawnSync = (exe, args, options) => {
    calls.push({ exe, args, options });
    for (const name of ['GITHUB_TOKEN', 'CL', '_CL_', 'CMAKE_GENERATOR', 'VSCMD_VER']) assert.equal(options.env[name], undefined);
    assert.equal(options.env.USERPROFILE, freshEnv().USERPROFILE);
    assert.equal(options.env.PATH.includes('runner'), false);
    if (exe.endsWith('vswhere.exe')) {
      assert.ok(args.includes('Microsoft.VisualStudio.Component.VC.Tools.x86.x64'));
      assert.ok(args.includes('-all')); assert.equal(args.includes('-latest'), false);
      return success(JSON.stringify(candidates.map(installationPath => ({ installationPath, isComplete: true, isLaunchable: true }))));
    }
    if (exe.endsWith('cmd.exe')) {
      assert.ok(args.includes('/d')); assert.ok(args.includes('/u'));
      assert.equal(options.encoding, 'utf16le'); assert.equal(options.windowsVerbatimArguments, true);
      assert.match(args.at(-1), /-arch=x64 -host_arch=x64/);
      const root = candidates.find(root => args.at(-1).includes(root));
      assert.ok(root); return success(configure(root));
    }
    if (exe.endsWith('cl.exe')) {
      assert.match(exe, /\\bin\\Hostx64\\x64\\cl\.exe$/);
      
       
      assert.equal(options.env.PATH.split(';')[0], path.win32.dirname(exe));
      return { ...success(''), status: compileFailure ? 1 : 0 };
    }
    assert.ok(exe.endsWith('probe.exe'));
    return { ...success(''), status: runFailure ? 1 : 0 };
  };
  const module = { exports: {} };
  vm.runInNewContext(source, { module, process: { platform: 'win32', arch: 'x64' }, require(name) {
    if (name === 'node:child_process') return { spawnSync };
    if (name === 'node:fs') return { ...fs, statSync(file) {
      checked.push(file);
      if (missing(file)) throw new Error('Missing installed binary');
      return { isFile: () => true };
    } };
    return require(name);
  } }, { filename: 'windows-toolchain.selection-model.cjs' });
  return { owned, calls, checked, select: env => module.exports.selectWindowsToolchain(env, owned) };
}

test('selection model skips an unusable newest IDE and verifies x64 compile/link/run before pinning another installed toolchain', t => {
  const newer = 'C:\\Program Files\\Microsoft Visual Studio\\18\\Enterprise';
  const model = selectionModel(t, { candidates: [newer, installation], missing: file => file.startsWith(newer) });
  const selected = model.select(freshEnv());
  assert.deepEqual(JSON.parse(selected.pin), { installation, tools, sdk });
  assert.equal(selected.make, path.win32.join(installation, 'VC', 'Tools', 'MSVC', tools, 'bin', 'Hostx64', 'x64', 'nmake.exe'));
  assert.equal(model.calls.filter(call => call.exe.endsWith('cmd.exe')).length, 2);
  assert.equal(model.calls.filter(call => call.exe.endsWith('cl.exe')).length, 1);
  assert.ok(model.calls.at(-1).exe.endsWith('probe.exe'));
  assert.ok(model.checked.some(file => file.endsWith('rc.exe')));
  assert.ok(model.checked.some(file => file.endsWith('mt.exe')));
  assert.deepEqual(fs.readdirSync(model.owned), []);
});

test('selection model reuses a pin for pgvector and cannot silently change SDK or installation', t => {
  const newer = 'C:\\Program Files\\Microsoft Visual Studio\\18\\Enterprise';
  const model = selectionModel(t, { candidates: [newer, installation] });
  const env = { ...freshEnv(), [pinKey]: JSON.stringify({ installation, tools, sdk }) };
  assert.equal(model.select(env).pin, env[pinKey]);
  const commands = model.calls.filter(call => call.exe.endsWith('cmd.exe'));
  assert.equal(commands.length, 1);
  assert.match(commands[0].args.at(-1), /-vcvars_ver=14\.44\.35207 -winsdk=10\.0\.26100\.0/);
  const mismatched = selectionModel(t, { configure: root => devOutput(root, { WindowsSDKVersion: '10.0.22621.0\\' }) });
  assert.throws(() => mismatched.select(env), /PINNED_TOOLCHAIN_UNUSABLE/);
  assert.equal(mismatched.calls.some(call => call.exe.endsWith('cl.exe')), false);
  const absent = selectionModel(t, { candidates: [newer] });
  assert.throws(() => absent.select(env), /PINNED_TOOLCHAIN_UNUSABLE/);
  assert.equal(absent.calls.some(call => call.exe.endsWith('cmd.exe')), false);
});

test('selection model never accepts a failed compiler/linker, failed executable, or substituted tool instance', t => {
  for (const setup of [{ compileFailure: true }, { runFailure: true },
    { configure: root => devOutput(root, { VCToolsInstallDir: 'C:\\other\\VC\\Tools\\MSVC\\' + tools }) }]) {
    const model = selectionModel(t, setup);
    assert.throws(() => model.select(freshEnv()), /MSVC_X64_TOOLCHAIN_UNAVAILABLE/);
    assert.deepEqual(fs.readdirSync(model.owned), []);
  }
});


