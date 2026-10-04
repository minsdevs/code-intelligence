'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

// Both the helper and pgvector use this selection under the calling user's token.
// Never import the runner's developer shell, PATH, compiler flags or credentials.
const baseKeys = ['SystemRoot', 'windir', 'TEMP', 'TMP', 'USERPROFILE', 'HOMEDRIVE', 'HOMEPATH', 'APPDATA', 'LOCALAPPDATA',
  'ProgramFiles', 'ProgramFiles(x86)', 'ProgramW6432', 'ProgramData', 'COMSPEC', 'PATHEXT', 'OS', 'PROCESSOR_ARCHITECTURE', 'NUMBER_OF_PROCESSORS'];
const developerKeys = ['PATH', 'INCLUDE', 'LIB', 'LIBPATH', 'VSINSTALLDIR', 'VCINSTALLDIR', 'VCToolsInstallDir', 'VCToolsVersion',
  'WindowsSdkDir', 'WindowsSDKVersion', 'UniversalCRTSdkDir', 'UCRTVersion', 'VSCMD_ARG_HOST_ARCH', 'VSCMD_ARG_TGT_ARCH'];
const pinKey = 'CODE_INTELLIGENCE_WINDOWS_TOOLCHAIN';
function value(env, name) {
  const key = Object.keys(env).find(key => key.toLowerCase() === name.toLowerCase());
  return key === undefined ? undefined : env[key];
}
function baseEnvironment(env) {
  const base = {};
  for (const key of baseKeys) if (value(env, key)) base[key] = value(env, key);
  if (!path.win32.isAbsolute(base.SystemRoot || '')) throw new Error('WINDOWS_TOOLCHAIN_SYSTEM_ROOT_REQUIRED');
  base.PATH = [path.win32.join(base.SystemRoot, 'System32'), base.SystemRoot,
    path.win32.join(base.SystemRoot, 'System32', 'Wbem'), path.win32.join(base.SystemRoot, 'System32', 'WindowsPowerShell', 'v1.0')].join(';');
  base.COMSPEC = path.win32.join(base.SystemRoot, 'System32', 'cmd.exe');
  base.SystemDrive = path.win32.parse(base.SystemRoot).root.replace(/[\\/]+$/, '');
  return base;
}
function developerEnvironment(output, base) {
  const env = { ...base };
  for (const line of output.split(/\r?\n/)) {
    const split = line.indexOf('=');
    if (split <= 0) continue;
    const key = developerKeys.find(key => key.toLowerCase() === line.slice(0, split).toLowerCase());
    if (key) env[key] = line.slice(split + 1);
  }
  if (env.VSCMD_ARG_HOST_ARCH !== 'x64' || env.VSCMD_ARG_TGT_ARCH !== 'x64') throw new Error('WINDOWS_TOOLCHAIN_X64_REQUIRED');
  for (const key of ['INCLUDE', 'LIB', 'LIBPATH', 'VCToolsInstallDir', 'WindowsSdkDir', 'WindowsSDKVersion', 'VCToolsVersion']) {
    if (!env[key]) throw new Error('WINDOWS_TOOLCHAIN_ENVIRONMENT_INCOMPLETE');
  }
  return env;
}
function version(value) {
  const result = String(value || '').replace(/[\\/]+$/, '');
  if (!/^\d+\.\d+\.\d+(?:\.\d+)?$/.test(result)) throw new Error('WINDOWS_TOOLCHAIN_VERSION_INVALID');
  return result;
}
function readPin(env) {
  if (!env[pinKey]) return null;
  const pin = JSON.parse(env[pinKey]);
  if (!pin || typeof pin.installation !== 'string' || !path.win32.isAbsolute(pin.installation)) throw new Error('WINDOWS_TOOLCHAIN_PIN_INVALID');
  return { installation: pin.installation, tools: version(pin.tools), sdk: version(pin.sdk) };
}
function selectWindowsToolchain(env, owned) {
  if (process.platform !== 'win32' || process.arch !== 'x64') throw new Error('WINDOWS_X64_TOOLCHAIN_HOST_REQUIRED');
  const base = baseEnvironment(env), pin = readPin(env);
  const vswhere = path.win32.join(base['ProgramFiles(x86)'] || base.ProgramFiles, 'Microsoft Visual Studio', 'Installer', 'vswhere.exe');
  const invoke = (exe, args, options = {}) => {
    const result = spawnSync(exe, args, { cwd: owned, env: base, encoding: 'utf8', windowsHide: true,
      timeout: 120000, maxBuffer: 1024 * 1024, ...options });
    if (result.status !== 0 || result.error || result.signal) throw new Error('WINDOWS_TOOLCHAIN_COMMAND_FAILED');
    return result.stdout;
  };
  const installations = JSON.parse(invoke(vswhere, ['-all', '-prerelease', '-products', '*', '-requires',
    'Microsoft.VisualStudio.Component.VC.Tools.x86.x64', '-sort', '-format', 'json', '-utf8']));
  if (!Array.isArray(installations)) throw new Error('WINDOWS_TOOLCHAIN_DISCOVERY_INVALID');
  const candidates = installations.filter(item => item.isComplete === true && item.isLaunchable === true &&
    typeof item.installationPath === 'string' && (!pin || item.installationPath.toLowerCase() === pin.installation.toLowerCase()));
  const probe = fs.mkdtempSync(path.join(owned, 'msvc-probe-'));
  try {
    // Compile, link and execute against the SDK and CRT, not just `cl /?`.
    // _M_X64 excludes an ARM64 compiler despite the shared 64-bit pointer size.
    fs.writeFileSync(path.join(probe, 'probe.cpp'), '#include <windows.h>\n#include <string>\n#ifndef _M_X64\n#error x64 required\n#endif\nstatic_assert(sizeof(void*) == 8);\nint main() { std::wstring text = L"toolchain"; return text.empty() || GetCurrentProcessId() == 0; }\n', { flag: 'wx' });
    for (const item of candidates) {
      try {
        const installation = item.installationPath;
        if (!path.win32.isAbsolute(installation) || /["%!\r\n&|<>^]/.test(installation)) throw new Error('WINDOWS_TOOLCHAIN_PATH_INVALID');
        const devCmd = path.win32.join(installation, 'Common7', 'Tools', 'VsDevCmd.bat');
        const extra = pin ? ` -vcvars_ver=${pin.tools} -winsdk=${pin.sdk}` : '';
        // cmd /u makes SET's values lossless for non-ASCII profile/install paths.
        const output = invoke(base.COMSPEC, ['/d', '/u', '/s', '/c', `"call "${devCmd}" -no_logo -arch=x64 -host_arch=x64${extra} >nul && set"`],
          { encoding: 'utf16le', windowsVerbatimArguments: true });
        const buildEnv = developerEnvironment(output, base);
        const tools = version(buildEnv.VCToolsVersion), sdk = version(buildEnv.WindowsSDKVersion);
        if (pin && (tools !== pin.tools || sdk !== pin.sdk)) throw new Error('WINDOWS_TOOLCHAIN_PIN_MISMATCH');
        const toolRoot = path.win32.resolve(buildEnv.VCToolsInstallDir);
        const expectedRoot = path.win32.join(installation, 'VC', 'Tools', 'MSVC', tools);
        if (toolRoot.toLowerCase() !== expectedRoot.toLowerCase()) throw new Error('WINDOWS_TOOLCHAIN_INSTANCE_MISMATCH');
        const bin = path.win32.join(toolRoot, 'bin', 'Hostx64', 'x64');
        const sdkBin = path.win32.join(buildEnv.WindowsSdkDir, 'bin', sdk, 'x64');
        const compiler = path.win32.join(bin, 'cl.exe'), make = path.win32.join(bin, 'nmake.exe');
        const rc = path.win32.join(sdkBin, 'rc.exe'), mt = path.win32.join(sdkBin, 'mt.exe');
        for (const file of [compiler, make, rc, mt, path.win32.join(bin, 'link.exe')]) {
          if (!fs.statSync(file).isFile()) throw new Error('WINDOWS_TOOLCHAIN_BINARY_MISSING');
        }
        // Bare cl/link in upstream Makefile.win must resolve to these same tools.
        buildEnv.PATH = [bin, sdkBin, base.PATH].join(';');
        invoke(compiler, ['/nologo', '/std:c++20', '/EHsc', '/MD', 'probe.cpp', '/Fe:probe.exe', '/Fo:probe.obj'], { cwd: probe, env: buildEnv });
        invoke(path.join(probe, 'probe.exe'), [], { cwd: probe, env: buildEnv });
        return { env: buildEnv, compiler, make, rc, mt, pin: JSON.stringify({ installation, tools, sdk }) };
      } catch {
        // An installed IDE can lack a usable SDK/compiler. Try only other component-
        // qualified installations; a pinned helper selection never switches instances.
      }
    }
    throw new Error(pin ? 'WINDOWS_PINNED_TOOLCHAIN_UNUSABLE' : 'WINDOWS_MSVC_X64_TOOLCHAIN_UNAVAILABLE');
  } finally {
    // Only our private generated compiler probe; no shared build or user data.
    fs.rmSync(probe, { recursive: true, force: true });
  }
}
function cmakeConfigureArgs(native, build, toolchain) {
  const file = value => value.replaceAll('\\', '/');
  return ['-S', native, '-B', build, '-G', 'NMake Makefiles', '-DCMAKE_BUILD_TYPE=Release',
    `-DCMAKE_CXX_COMPILER:FILEPATH=${file(toolchain.compiler)}`, `-DCMAKE_MAKE_PROGRAM:FILEPATH=${file(toolchain.make)}`,
    `-DCMAKE_RC_COMPILER:FILEPATH=${file(toolchain.rc)}`, `-DCMAKE_MT:FILEPATH=${file(toolchain.mt)}`];
}
function cmakeExecutable(env, toolchain) {
  const candidates = env.NATIVE_ACCEPTANCE_CMAKE ? [env.NATIVE_ACCEPTANCE_CMAKE] : [
    path.win32.join(toolchain.env.ProgramFiles, 'CMake', 'bin', 'cmake.exe'),
    path.win32.join(toolchain.env.VSINSTALLDIR, 'Common7', 'IDE', 'CommonExtensions', 'Microsoft', 'CMake', 'CMake', 'bin', 'cmake.exe')];
  for (const file of candidates) if (path.win32.isAbsolute(file) && fs.existsSync(file) && fs.statSync(file).isFile()) return file;
  throw new Error('WINDOWS_CMAKE_EXECUTABLE_REQUIRED');
}
module.exports = { selectWindowsToolchain, baseEnvironment, developerEnvironment, readPin, pinKey, cmakeConfigureArgs, cmakeExecutable };
