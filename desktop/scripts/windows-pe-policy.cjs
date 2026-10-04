'use strict';
// Read-only PE/COFF validation. Resolution never searches the build host's PATH.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { runtimeRelativePath } = require('../src/runtime-platform.cjs');
const SYSTEM_DLLS = new Set(('advapi32 avrt bcrypt bcryptprimitives cabinet cfgmgr32 clbcatq combase comctl32 comdlg32 crypt32 cryptbase cryptnet cryptsp cryptui dbghelp dhcpcsvc dnsapi dsound dwmapi dxgi gdi32 gdi32full hid imagehlp imm32 iphlpapi kernel32 kernelbase mf mfplat mfuuid mpr msacm32 mscoree msimg32 msvcrt mswsock ncrypt netapi32 normaliz ntdll ntmarta ole32 oleacc oleaut32 powrprof profapi propsys psapi rasapi32 rasman rpcrt4 secur32 setupapi shell32 shlwapi shcore snmpapi sspicli ucrtbase urlmon user32 userenv usp10 uxtheme version wer wevtapi win32u windowscodecs winhttp wininet winmm winspool wintrust wldap32 ws2_32 wtsapi32').split(' ').map(name => name + '.dll'));
SYSTEM_DLLS.add('winspool.drv');
for (const name of ['pdh.dll', 'winscard.dll', 'msi.dll']) SYSTEM_DLLS.add(name);
const API_SETS = new Set(["api-ms-win-core-console-l1-1-0.dll","api-ms-win-core-datetime-l1-1-0.dll","api-ms-win-core-debug-l1-1-0.dll","api-ms-win-core-errorhandling-l1-1-0.dll","api-ms-win-core-fibers-l1-1-0.dll","api-ms-win-core-fibers-l1-1-1.dll","api-ms-win-core-file-l1-1-0.dll","api-ms-win-core-file-l1-2-0.dll","api-ms-win-core-file-l2-1-0.dll","api-ms-win-core-handle-l1-1-0.dll","api-ms-win-core-heap-l1-1-0.dll","api-ms-win-core-interlocked-l1-1-0.dll","api-ms-win-core-kernel32-legacy-l1-1-1.dll","api-ms-win-core-libraryloader-l1-1-0.dll","api-ms-win-core-localization-l1-2-0.dll","api-ms-win-core-memory-l1-1-0.dll","api-ms-win-core-namedpipe-l1-1-0.dll","api-ms-win-core-processenvironment-l1-1-0.dll","api-ms-win-core-processthreads-l1-1-0.dll","api-ms-win-core-processthreads-l1-1-1.dll","api-ms-win-core-profile-l1-1-0.dll","api-ms-win-core-rtlsupport-l1-1-0.dll","api-ms-win-core-string-l1-1-0.dll","api-ms-win-core-synch-l1-1-0.dll","api-ms-win-core-synch-l1-2-0.dll","api-ms-win-core-sysinfo-l1-1-0.dll","api-ms-win-core-sysinfo-l1-2-0.dll","api-ms-win-core-timezone-l1-1-0.dll","api-ms-win-core-util-l1-1-0.dll","api-ms-win-core-winrt-l1-1-0.dll","api-ms-win-crt-convert-l1-1-0.dll","api-ms-win-crt-environment-l1-1-0.dll","api-ms-win-crt-filesystem-l1-1-0.dll","api-ms-win-crt-heap-l1-1-0.dll","api-ms-win-crt-locale-l1-1-0.dll","api-ms-win-crt-math-l1-1-0.dll","api-ms-win-crt-multibyte-l1-1-0.dll","api-ms-win-crt-runtime-l1-1-0.dll","api-ms-win-crt-stdio-l1-1-0.dll","api-ms-win-crt-string-l1-1-0.dll","api-ms-win-crt-time-l1-1-0.dll","api-ms-win-crt-utility-l1-1-0.dll"]);
function fail(code, file = '') { const error = new Error(`Native runtime publication blocked: ${code}${file ? ': ' + file : ''}`); error.code = code; throw error; }
function parsePe(bytes, file = '') {
  const bad = () => fail('INVALID_PE', file);
  const range = (offset, length) => { if (!Number.isSafeInteger(offset) || offset < 0 || length < 0 || offset + length > bytes.length) bad(); return offset; };
  const u16 = offset => bytes.readUInt16LE(range(offset, 2));
  const u32 = offset => bytes.readUInt32LE(range(offset, 4));
  if (bytes.length < 64 || u16(0) !== 0x5a4d) bad();
  const pe = u32(0x3c); if (u32(pe) !== 0x00004550) bad();
  const machine = u16(pe + 4), count = u16(pe + 6), optionalBytes = u16(pe + 20), characteristics = u16(pe + 22), optional = pe + 24;
  range(optional, optionalBytes);
  const magic = u16(optional), is64 = magic === 0x20b;
  if (!is64 && magic !== 0x10b || count < 1 || count > 96 || optionalBytes < (is64 ? 112 : 96)) bad();
  const imageBase = is64 ? bytes.readBigUInt64LE(range(optional + 24, 8)) : BigInt(u32(optional + 28));
  const headers = u32(optional + 60), directories = u32(optional + (is64 ? 108 : 92)), directoryStart = optional + (is64 ? 112 : 96);
  if (headers > bytes.length || directories > 16 || directoryStart + directories * 8 > optional + optionalBytes) bad();
  const sections = [];
  for (let index = 0; index < count; index++) {
    const offset = optional + optionalBytes + index * 40; range(offset, 40);
    const section = { virtual: u32(offset + 12), virtualSize: u32(offset + 8), raw: u32(offset + 20), size: u32(offset + 16) };
    range(section.raw, section.size);
    if (section.virtual + Math.max(section.virtualSize, section.size) > 0x100000000) bad();
    for (const prior of sections) if (section.virtual < prior.virtual + Math.max(prior.virtualSize, prior.size)
      && prior.virtual < section.virtual + Math.max(section.virtualSize, section.size)) bad();
    sections.push(section);
  }
  const rva = (address, length = 1) => {
    if (address < headers && address + length <= headers) return range(address, length);
    const found = sections.filter(s => address >= s.virtual && address + length <= s.virtual + s.size);
    if (found.length !== 1) bad(); return range(found[0].raw + address - found[0].virtual, length);
  };
  const string = address => {
    let result = '';
    for (let i = 0; i < 512; i++) { const ch = bytes[rva(address + i)]; if (!ch) return result; if (ch < 32 || ch > 126) bad(); result += String.fromCharCode(ch); }
    bad();
  };
  const directory = index => index < directories ? [u32(directoryStart + index * 8), u32(directoryStart + index * 8 + 4)] : [0, 0];
  const [clr, clrSize] = directory(14);
  const clrFlags = clr && clrSize >= 20 ? u32(rva(clr, 20) + 16) : 0;
  const managedOnly = Boolean(clr && clrFlags & 1 && !(clrFlags & 2));
  if (machine !== 0x8664 && !(machine === 0x14c && !is64 && managedOnly)) fail('ARCHITECTURE_MISMATCH', file);
  if (machine === 0x8664 && !is64 || machine === 0x14c && is64) bad();
  const imports = new Set(), delayed = new Set(), forwarded = new Set();
  const add = (set, name) => {
    if (!/^[A-Za-z0-9_.-]+\.(?:dll|exe|drv)$/i.test(name) || name.includes('..')) bad();
    runtimeRelativePath(name, 'DLL name', 'win32'); set.add(name.toLowerCase());
  };
  for (const [index, stride, names] of [[1, 20, imports], [13, 32, delayed]]) {
    const [address, length] = directory(index); if (!address && !length) continue;
    if (!address || length < stride || length > 1024 * 1024) bad();
    let terminated = false;
    for (let offset = 0; offset + stride <= length; offset += stride) {
      const at = rva(address + offset, stride);
      if (bytes.subarray(at, at + stride).every(value => value === 0)) { terminated = true; break; }
      let name = u32(at + (index === 1 ? 12 : 4));
      if (index === 13) {
        const attributes = u32(at); if (attributes & ~1) bad();
        if (!(attributes & 1)) { const va = BigInt(name) - imageBase; if (va < 0n || va > 0xffffffffn) bad(); name = Number(va); }
      }
      add(names, string(name));
    }
    if (!terminated) bad();
  }
  const [exports, exportBytes] = directory(0);
  if (exports && exportBytes) {
    const at = rva(exports, 40), functions = u32(at + 20), table = u32(at + 28);
    if (functions > 100000) bad();
    for (let i = 0; i < functions; i++) {
      const value = u32(rva(table + i * 4, 4));
      if (value >= exports && value < exports + exportBytes) {
        const target = string(value), dot = target.lastIndexOf('.'); if (dot <= 0) bad();
        const name = target.slice(0, dot); add(forwarded, /\.dll$/i.test(name) ? name : name + '.dll');
      }
    }
  }
  return { machine, managedOnly, dll: Boolean(characteristics & 0x2000), imports: [...imports], delayImports: [...delayed], forwarders: [...forwarded] };
}
function systemDll(name) {
  // API sets are Windows contracts, not arbitrary api-*.dll exemptions.
  return SYSTEM_DLLS.has(name) || API_SETS.has(name);
}
function inventory(root) {
  const result = new Map(), names = new Map(); let entries = 0;
  const rootStat = fs.lstatSync(root);
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink() || path.resolve(fs.realpathSync(root)).toLowerCase() !== path.resolve(root).toLowerCase()) fail('INVALID_STAGE_ROOT');
  function visit(relative, depth) {
    if (depth > 64 || ++entries > 100000) fail('INVENTORY_LIMIT');
    const safe = runtimeRelativePath(relative, 'inventory path', 'win32'), folded = safe.toLowerCase();
    if (names.has(folded)) fail('CASE_COLLISION', relative); names.set(folded, relative);
    const absolute = path.join(root, ...safe.split('/')), stat = fs.lstatSync(absolute);
    if (stat.isSymbolicLink() || path.resolve(fs.realpathSync(absolute)).toLowerCase() !== absolute.toLowerCase()) fail('UNSAFE_STAGE_ENTRY', relative);
    if (stat.isDirectory()) { for (const name of fs.readdirSync(absolute)) visit(relative + '/' + name, depth + 1); return; }
    if (!stat.isFile() || stat.nlink !== 1 || stat.size > 512 * 1024 * 1024) fail('UNSAFE_STAGE_ENTRY', relative);
    const bytes = fs.readFileSync(absolute), current = fs.lstatSync(absolute);
    if (stat.dev !== current.dev || stat.ino !== current.ino || stat.size !== current.size || stat.mtimeMs !== current.mtimeMs || stat.ctimeMs !== current.ctimeMs) fail('NATIVE_CHANGED', relative);
    const hash = crypto.createHash('sha256').update(bytes).digest('hex');
    const pe = bytes.length >= 2 && bytes.readUInt16LE(0) === 0x5a4d ? parsePe(bytes, relative) : null;
    if (!pe && (/\.(?:dll|exe|node|drv|dylib|so(?:\.[0-9]+)*)$/i.test(relative)
      || ['7f454c46', 'cffaedfe', 'feedfacf', 'cefaedfe', 'feedface'].includes(bytes.subarray(0, 4).toString('hex')))) fail('INVALID_PE', relative);
    result.set(relative, { hash, pe });
  }
  for (const name of fs.readdirSync(root)) visit(name, 0);
  return result;
}
function validateClosure(files) {
  const folded = new Map([...files.keys()].map(name => [name.toLowerCase(), name]));
  const resolutions = [];
  for (const [file, item] of files) {
    if (!item.pe) continue;
    const component = file.split('/')[0];
    const directories = component === 'postgres' ? ['postgres/bin', 'postgres/lib'] : component === 'jre' ? ['jre/bin', 'jre/bin/server'] : component === 'cache' ? ['cache'] : ['native'];
    for (const reference of new Set([...item.pe.imports, ...item.pe.delayImports, ...item.pe.forwarders])) {
      const candidates = [...new Set([path.posix.dirname(file), ...directories])].map(dir => folded.get((dir + '/' + reference).toLowerCase())).filter(Boolean);
      if (systemDll(reference)) {
        if (candidates.length) fail('SYSTEM_DLL_SHADOW', candidates[0]);
        resolutions.push({ file, reference, system: true }); continue;
      }
      if (!candidates.length) fail('UNRESOLVED_NATIVE_REFERENCE', file + ' -> ' + reference);
      if (new Set(candidates.map(name => files.get(name).hash)).size !== 1) fail('BASENAME_COLLISION', reference);
      const target = candidates[0]; if (!files.get(target).pe || files.get(target).pe.managedOnly) fail('DEPENDENCY_NOT_NATIVE', target);
      resolutions.push({ file, reference, target });
    }
  }
  return resolutions;
}
const REQUIRED = ['jre/bin/java.exe', 'jre/bin/java.dll', 'jre/bin/server/jvm.dll', 'cache/GarnetServer.exe', 'cache/coreclr.dll',
  ...['hostfxr', 'hostpolicy', 'lua54', 'native_device', 'bftree_garnet', 'diskann_garnet'].map(name => `cache/${name}.dll`),
  'postgres/lib/vector.dll', 'postgres/lib/pg_trgm.dll', 'native/windows/codeintel-boundary.exe',
  ...['postgres', 'initdb', 'pg_isready', 'psql', 'createdb', 'pg_dump', 'pg_restore'].map(name => `postgres/bin/${name}.exe`)];
function verifyWindowsRuntime({ root, manifest, provenance, supplies }) {
  const files = inventory(root);
  if (manifest) {
    if (manifest.format !== 1 || manifest.platform !== 'win32' || manifest.arch !== 'x64' || manifest.runtime?.cache !== 'garnet-2.2.0') fail('INVALID_WINDOWS_MANIFEST');
    const actual = new Map([...files].filter(([name]) => name !== 'runtime-manifest.json'));
    if (!manifest.files || Object.keys(manifest.files).length !== actual.size) fail('INVENTORY_MISMATCH');
    for (const [name, hash] of Object.entries(manifest.files)) {
      runtimeRelativePath(name, 'manifest path', 'win32'); if (actual.get(name)?.hash !== hash) fail('INVENTORY_MISMATCH', name);
    }
  }
  for (const name of REQUIRED) {
    const native = files.get(name)?.pe;
    if (!native) fail('REQUIRED_NATIVE_MISSING', name);
    if (native.managedOnly || native.dll !== name.endsWith('.dll')) fail('REQUIRED_NATIVE_KIND', name);
  }
  if (!provenance || provenance.format !== 1 || !provenance.files || !provenance.sources) fail('PROVENANCE_MISSING');
  for (const [name, expected] of Object.entries(supplies)) {
    const supplied = provenance.sources[name];
    if (!supplied || supplied.sha256 !== expected.sha256 || supplied.url !== expected.url || supplied.version !== expected.version) fail('UNPINNED_SUPPLY', name);
    const notice = supplied.notice;
    if (typeof notice !== 'string' || !files.has(runtimeRelativePath(notice, 'notice', 'win32'))) fail('NOTICE_MISSING', name);
  }
  for (const [name, notice] of Object.entries(require('./windows-runtime-notices.json'))) {
    if (files.get(`notices/dependencies/${name}.txt`)?.hash !== notice.sha256) fail('DEPENDENCY_NOTICE_MISSING', name);
  }
  for (const [name, item] of files) {
    if (!item.pe) continue;
    const claim = provenance.files[name];
    if (!claim || claim.sha256 !== item.hash || !Array.isArray(claim.sources) || !claim.sources.length
      || claim.sources.some(source => !provenance.sources[source]) || typeof claim.method !== 'string') fail('UNVERIFIED_NATIVE_DEPENDENCY', name);
  }
  const release = fs.readFileSync(path.join(root, 'jre', 'release'), 'utf8');
  if (!/^JAVA_VERSION="21(?:\.|\")/m.test(release)) fail('JAVA_MAJOR_MISMATCH');
  let options;
  try { options = JSON.parse(fs.readFileSync(path.join(root, 'cache/GarnetServer.runtimeconfig.json'), 'utf8')).runtimeOptions; } catch { fail('CACHE_SELF_CONTAINED_REQUIRED'); }
  if (!options || options.tfm !== 'net10.0' || options.framework || options.frameworks || (options.rollForward !== undefined && options.rollForward !== 'Disable')
    || !Array.isArray(options.includedFrameworks) || options.includedFrameworks.length !== 1
    || options.includedFrameworks[0].name !== 'Microsoft.NETCore.App' || options.includedFrameworks[0].version !== '10.0.12') fail('CACHE_SELF_CONTAINED_REQUIRED');
  require('./native-runtime-policy.cjs').verifyPostgresExtensions(root, 'postgres/share');
  return { files: files.size, native: [...files.values()].filter(item => item.pe).length, closure: validateClosure(files) };
}
module.exports = { parsePe, systemDll, inventory, validateClosure, verifyWindowsRuntime, REQUIRED };
