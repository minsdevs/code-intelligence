'use strict';

// Pure Mach-O load-command reader for the static SBOM. It reads bytes that the
// caller already holds; it never loads, links, signs or executes the binary.
// Only the commands needed for dependency closure and deployment targets are
// decoded. Anything malformed is reported as a parse failure, never guessed.
const path = require('node:path');

const MAGIC = Object.freeze({ thin64: 0xfeedfacf, thin32: 0xfeedface, fat: 0xcafebabe, fat64: 0xcafebabf });
const LC = Object.freeze({ 0xc: 'LC_LOAD_DYLIB', 0xd: 'LC_ID_DYLIB', 0xe: 'LC_LOAD_DYLINKER', 0x20: 'LC_LAZY_LOAD_DYLIB',
  0x80000018: 'LC_LOAD_WEAK_DYLIB', 0x8000001f: 'LC_REEXPORT_DYLIB', 0x80000023: 'LC_LOAD_UPWARD_DYLIB',
  0x8000001c: 'LC_RPATH', 0x32: 'LC_BUILD_VERSION', 0x24: 'LC_VERSION_MIN_MACOSX', 0x27: 'LC_DYLD_ENVIRONMENT' });
const LOADS = new Set(['LC_LOAD_DYLIB', 'LC_LAZY_LOAD_DYLIB', 'LC_LOAD_WEAK_DYLIB', 'LC_REEXPORT_DYLIB', 'LC_LOAD_UPWARD_DYLIB']);
const FILETYPES = Object.freeze({ 1: 'OBJECT', 2: 'EXECUTE', 6: 'DYLIB', 7: 'DYLINKER', 8: 'BUNDLE', 10: 'DSYM' });
const CPU = Object.freeze({ 0x0100000c: 'arm64', 0x01000007: 'x86_64', 12: 'arm', 7: 'i386' });
const PLATFORMS = Object.freeze({ 1: 'MACOS', 2: 'IOS', 3: 'TVOS', 4: 'WATCHOS', 6: 'MACCATALYST' });
const LIMITS = Object.freeze({ commands: 4096, slices: 8, string: 4096 });

class MachOError extends Error { constructor(code) { super(code); this.code = code; } }
const need = (ok, code) => { if (!ok) throw new MachOError(code); };

// Recognise a Mach-O by its first bytes. A big-endian 0xcafebabe is shared with
// Java class files; a fat header is accepted only with a small arch count.
function machOKind(bytes) {
  if (!Buffer.isBuffer(bytes) || bytes.length < 8) return null;
  const le = bytes.readUInt32LE(0), be = bytes.readUInt32BE(0);
  if (le === MAGIC.thin64 || le === MAGIC.thin32) return 'thin';
  if ((be === MAGIC.fat || be === MAGIC.fat64) && bytes.readUInt32BE(4) > 0 && bytes.readUInt32BE(4) <= LIMITS.slices) return 'fat';
  return null;
}
function version(value) { return `${value >>> 16}.${(value >>> 8) & 0xff}.${value & 0xff}`.replace(/\.0$/, ''); }
function cString(bytes, start, end) {
  need(start >= 0 && start < end && end <= bytes.length, 'MACHO_STRING');
  const stop = bytes.indexOf(0, start);
  const value = bytes.subarray(start, stop === -1 || stop > end ? end : stop).toString('utf8');
  need(value.length > 0 && value.length <= LIMITS.string && !/[\x00-\x1f\x7f]/.test(value), 'MACHO_STRING');
  return value;
}

function parseSlice(bytes, offset, size) {
  need(offset >= 0 && size >= 32 && offset + size <= bytes.length, 'MACHO_SLICE');
  const magic = bytes.readUInt32LE(offset); need(magic === MAGIC.thin64 || magic === MAGIC.thin32, 'MACHO_MAGIC');
  const header = magic === MAGIC.thin64 ? 32 : 28;
  const cpu = bytes.readUInt32LE(offset + 4), filetype = bytes.readUInt32LE(offset + 12);
  const ncmds = bytes.readUInt32LE(offset + 16), sizeofcmds = bytes.readUInt32LE(offset + 20);
  need(ncmds <= LIMITS.commands && header + sizeofcmds <= size, 'MACHO_COMMANDS');
  const slice = { cpu: CPU[cpu] || `cpu-${cpu}`, filetype: FILETYPES[filetype] || `type-${filetype}`,
    loads: [], rpaths: [], installName: null, dylinker: null, platform: null, minos: null, sdk: null,
    deploymentCommands: 0, dyldEnvironment: [] };
  let cursor = offset + header; const end = offset + header + sizeofcmds;
  for (let i = 0; i < ncmds; i++) {
    need(cursor + 8 <= end, 'MACHO_COMMANDS');
    const cmd = bytes.readUInt32LE(cursor), cmdsize = bytes.readUInt32LE(cursor + 4);
    need(cmdsize >= 8 && cursor + cmdsize <= end, 'MACHO_COMMANDS');
    const name = LC[cmd];
    if (LOADS.has(name)) slice.loads.push({ command: name, name: cString(bytes, cursor + bytes.readUInt32LE(cursor + 8), cursor + cmdsize) });
    else if (name === 'LC_ID_DYLIB') { need(slice.installName === null, 'MACHO_DUPLICATE_ID'); slice.installName = cString(bytes, cursor + bytes.readUInt32LE(cursor + 8), cursor + cmdsize); }
    else if (name === 'LC_LOAD_DYLINKER') slice.dylinker = cString(bytes, cursor + bytes.readUInt32LE(cursor + 8), cursor + cmdsize);
    else if (name === 'LC_RPATH') slice.rpaths.push(cString(bytes, cursor + bytes.readUInt32LE(cursor + 8), cursor + cmdsize));
    else if (name === 'LC_DYLD_ENVIRONMENT') slice.dyldEnvironment.push(cString(bytes, cursor + bytes.readUInt32LE(cursor + 8), cursor + cmdsize));
    else if (name === 'LC_BUILD_VERSION') {
      need(cmdsize >= 24, 'MACHO_COMMANDS'); slice.deploymentCommands++;
      const platform = bytes.readUInt32LE(cursor + 8);
      slice.platform = PLATFORMS[platform] || `platform-${platform}`;
      slice.minos = version(bytes.readUInt32LE(cursor + 12)); slice.sdk = version(bytes.readUInt32LE(cursor + 16));
    } else if (name === 'LC_VERSION_MIN_MACOSX') {
      need(cmdsize >= 16, 'MACHO_COMMANDS'); slice.deploymentCommands++;
      slice.platform = 'MACOS'; slice.minos = version(bytes.readUInt32LE(cursor + 8)); slice.sdk = version(bytes.readUInt32LE(cursor + 12));
    }
    cursor += cmdsize;
  }
  return slice;
}

function parseMachO(bytes) {
  const kind = machOKind(bytes); need(kind, 'MACHO_MAGIC');
  if (kind === 'thin') return { kind, slices: [parseSlice(bytes, 0, bytes.length)] };
  const wide = bytes.readUInt32BE(0) === MAGIC.fat64, count = bytes.readUInt32BE(4), entry = wide ? 32 : 20, slices = [];
  need(8 + count * entry <= bytes.length, 'MACHO_FAT');
  for (let i = 0; i < count; i++) {
    const at = 8 + i * entry;
    const offset = wide ? Number(bytes.readBigUInt64BE(at + 8)) : bytes.readUInt32BE(at + 8);
    const size = wide ? Number(bytes.readBigUInt64BE(at + 16)) : bytes.readUInt32BE(at + 12);
    slices.push(parseSlice(bytes, offset, size));
  }
  return { kind, slices };
}

const SYSTEM_PREFIXES = ['/usr/lib/', '/System/Library/'];
function systemReference(name) {
  return SYSTEM_PREFIXES.some(prefix => name.startsWith(prefix)) && path.posix.normalize(name) === name;
}
function compareVersions(a, b) {
  const x = String(a).split('.').map(Number), y = String(b).split('.').map(Number);
  for (let i = 0; i < 3; i++) if ((x[i] || 0) !== (y[i] || 0)) return (x[i] || 0) - (y[i] || 0);
  return 0;
}

// Classify every reference of one binary. `owner` is the bundle-relative path of
// the binary, `exists(rel)` answers bundle membership and `executableDirs` lists
// bundle-relative directories of MH_EXECUTE files that may own @executable_path.
// dyld also searches the LC_RPATHs of the images that loaded a library, ending
// at the main executable; `executableRpaths` holds those executables' expanded
// in-bundle rpath bases. A hit there is reported as BUNDLE_VIA_EXECUTABLE_RPATH.
// Resolution is a closure witness only: dlopen order and DYLD_* are not modelled.
function classifyReferences(owner, slice, { exists, executableDirs, executableRpaths = [] }) {
  const ownerDir = path.posix.dirname(owner), findings = [], references = [];
  const expand = value => {
    if (value === '@loader_path' || value.startsWith('@loader_path/')) return [path.posix.join(ownerDir, value.slice('@loader_path'.length))];
    if (value === '@executable_path' || value.startsWith('@executable_path/')) {
      const dirs = slice.filetype === 'EXECUTE' ? [ownerDir] : executableDirs;
      return dirs.map(dir => path.posix.join(dir, value.slice('@executable_path'.length)));
    }
    return null;
  };
  const inside = value => value !== '..' && !value.startsWith('../') && !path.posix.isAbsolute(value);
  const rpathBases = [];
  for (const rpath of slice.rpaths) {
    if (systemReference(rpath)) { rpathBases.push(rpath); continue; }
    const expanded = expand(rpath);
    if (!expanded) { findings.push({ code: path.posix.isAbsolute(rpath) ? 'EXTERNAL_RPATH' : 'UNSUPPORTED_RPATH', file: owner, reference: rpath }); continue; }
    for (const base of expanded.map(value => path.posix.normalize(value))) {
      if (!inside(base)) findings.push({ code: 'ESCAPING_RPATH', file: owner, reference: rpath });
      else rpathBases.push(base);
    }
  }
  for (const load of slice.loads) {
    const name = load.name; let resolution, candidates = [];
    if (systemReference(name)) resolution = 'SYSTEM';
    else if (name.startsWith('@rpath/')) {
      candidates = rpathBases.filter(base => !path.posix.isAbsolute(base))
        .map(base => path.posix.normalize(path.posix.join(base, name.slice('@rpath/'.length))));
      const systemCandidates = rpathBases.filter(base => path.posix.isAbsolute(base));
      if (candidates.some(value => inside(value) && exists(value))) resolution = 'BUNDLE';
      else {
        const chained = executableRpaths.map(base => path.posix.normalize(path.posix.join(base, name.slice('@rpath/'.length))))
          .filter(value => inside(value) && exists(value));
        if (chained.length) { resolution = 'BUNDLE_VIA_EXECUTABLE_RPATH'; candidates = chained; }
        else resolution = systemCandidates.length ? 'SYSTEM_RPATH_UNVERIFIED' : 'UNRESOLVED';
      }
    } else if (name.startsWith('@loader_path') || name.startsWith('@executable_path')) {
      candidates = (expand(name) || []).map(value => path.posix.normalize(value));
      resolution = candidates.some(value => inside(value) && exists(value)) ? 'BUNDLE' : 'UNRESOLVED';
    } else resolution = path.posix.isAbsolute(name) ? 'EXTERNAL' : 'UNRESOLVED';
    references.push({ command: load.command, name, resolution,
      ...(resolution.startsWith('BUNDLE') ? { resolvedTo: candidates.filter(value => inside(value) && exists(value)) } : {}) });
    if (resolution === 'EXTERNAL') findings.push({ code: 'EXTERNAL_DEPENDENCY', file: owner, reference: name });
    else if (resolution === 'UNRESOLVED' && load.command !== 'LC_LOAD_WEAK_DYLIB') findings.push({ code: 'UNRESOLVED_DEPENDENCY', file: owner, reference: name });
    else if (resolution === 'UNRESOLVED') findings.push({ code: 'UNRESOLVED_WEAK_DEPENDENCY', file: owner, reference: name });
  }
  if (slice.dylinker && slice.dylinker !== '/usr/lib/dyld') findings.push({ code: 'UNEXPECTED_DYLINKER', file: owner, reference: slice.dylinker });
  for (const value of slice.dyldEnvironment) findings.push({ code: 'EMBEDDED_DYLD_ENVIRONMENT', file: owner, reference: value });
  if (slice.deploymentCommands !== 1 || slice.platform !== 'MACOS') findings.push({ code: 'MISSING_OR_AMBIGUOUS_DEPLOYMENT_TARGET', file: owner, reference: String(slice.platform) });
  return { references, findings };
}

module.exports = Object.freeze({ MachOError, machOKind, parseMachO, classifyReferences, systemReference, compareVersions });
