'use strict';

// Build-only, read-only gate. This does not sign, download, relocate or run bundled code.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');

const POLICY = Object.freeze({ minimumSystemVersion: '13.0', javaMajor: 21, architecture: 'arm64' });
const LIMITS = Object.freeze({ files: 100000, natives: 4096, fileBytes: 256 * 1024 * 1024,
  outputBytes: 1024 * 1024, depth: 64, findings: 1000 });
const MACHO = new Set(['feedface', 'cefaedfe', 'feedfacf', 'cffaedfe', 'cafebabe', 'bebafeca', 'cafebabf', 'bfbafeca']);
const LOADS = new Set(['LC_LOAD_DYLIB', 'LC_LOAD_WEAK_DYLIB', 'LC_REEXPORT_DYLIB', 'LC_LOAD_UPWARD_DYLIB', 'LC_LAZY_LOAD_DYLIB', 'LC_PREBOUND_DYLIB']);
const PG_EXECUTABLES = Object.freeze(['postgres', 'initdb', 'pg_isready', 'psql', 'createdb', 'pg_dump', 'pg_restore']);
const JRE_MODULES = Object.freeze(['jre/lib/libjli.dylib', 'jre/lib/libjava.dylib', 'jre/lib/server/libjvm.dylib']);
const PG_MODULES = Object.freeze(['vector', 'pg_trgm']);
const LIBRARY_NAME = /\.(?:dylib|so(?:\.[0-9]+)*|jnilib|node)$/i;

class NativeRuntimePolicyError extends Error {
  constructor(findings) {
    const first = findings.slice(0, 12).map(item => `${item.code}${item.file ? ` [${item.file}]` : ''}${item.detail ? `: ${item.detail}` : ''}`).join('; ');
    super(`Native runtime publication blocked: ${first}${findings.length > 12 ? '; further findings attached' : ''}`);
    this.name = 'NativeRuntimePolicyError';
    this.code = 'NATIVE_RUNTIME_POLICY';
    this.findings = Object.freeze(findings.map(item => Object.freeze({ ...item })));
  }
}
const invalid = (code, file = '', detail = '') => { throw new NativeRuntimePolicyError([{ code, file, detail }]); };
function safeText(value, maximum = 4096) {
  return typeof value === 'string' && value.length <= maximum && !/[\x00-\x1f\x7f]/.test(value)
    && value === Buffer.from(value).toString('utf8');
}
function relative(value) {
  if (!safeText(value) || !value || value.includes('\\') || value.startsWith('/') || value !== path.posix.normalize(value)
      || value === '.' || value === '..' || value.startsWith('../')) invalid('INVALID_INVENTORY');
  return value;
}
function version(value) {
  if (!safeText(value) || !/^(?:0|[1-9][0-9]{0,4})(?:\.(?:0|[1-9][0-9]{0,4})){0,2}$/.test(value)) invalid('INVALID_DEPLOYMENT_TARGET');
  const parts = value.split('.').map(Number); if (parts.some(part => part > 65535)) invalid('INVALID_DEPLOYMENT_TARGET');
  while (parts.length < 3) parts.push(0); return parts;
}
function above(first, second) {
  for (let i = 0; i < 3; i++) if (first[i] !== second[i]) return first[i] > second[i];
  return false;
}

function parseLoadCommands(value) {
  if (typeof value !== 'string' || Buffer.byteLength(value) > LIMITS.outputBytes || value.includes('\0')) invalid('INVALID_LOAD_COMMANDS');
  const blocks = value.split(/^Load command [0-9]+\s*$/m).slice(1);
  if (!blocks.length || blocks.length > 4096) invalid('INVALID_LOAD_COMMANDS');
  let minimum = null, platform = null, deploymentCommands = 0, installName = null;
  const dependencies = [], rpaths = [];
  const field = (block, expression) => {
    const values = [...block.matchAll(expression)];
    if (values.length !== 1) invalid('INVALID_LOAD_COMMANDS');
    return values[0][1];
  };
  for (const block of blocks) {
    const command = field(block, /^[ \t]*cmd (LC_[A-Z0-9_]+)[ \t]*\r?$/gm);
    if (command === 'LC_BUILD_VERSION') {
      const name = field(block, /^[ \t]*platform ([A-Za-z0-9_]+)[ \t]*\r?$/gm);
      if (!name || !['1', 'macos'].includes(name.toLowerCase())) invalid('UNSUPPORTED_NATIVE_PLATFORM');
      platform = 'macos'; minimum = field(block, /^[ \t]*minos ([0-9.]+)[ \t]*\r?$/gm); deploymentCommands++;
    } else if (command === 'LC_VERSION_MIN_MACOSX') {
      platform = 'macos'; minimum = field(block, /^[ \t]*version ([0-9.]+)[ \t]*\r?$/gm); deploymentCommands++;
    } else if (command.startsWith('LC_VERSION_MIN_')) invalid('UNSUPPORTED_NATIVE_PLATFORM');
    else if (LOADS.has(command) || command === 'LC_LOAD_DYLINKER') {
      const name = field(block, /^[ \t]*name (.+) \(offset [0-9]+\)[ \t]*\r?$/gm);
      if (!safeText(name) || !name) invalid('INVALID_LOAD_COMMANDS'); dependencies.push(name);
      if (command === 'LC_LOAD_DYLINKER' && name !== '/usr/lib/dyld') invalid('UNSUPPORTED_DYNAMIC_LINKER');
    } else if (command === 'LC_RPATH') {
      const name = field(block, /^[ \t]*path (.+) \(offset [0-9]+\)[ \t]*\r?$/gm);
      if (!safeText(name) || !name) invalid('INVALID_LOAD_COMMANDS'); rpaths.push(name);
    } else if (command === 'LC_ID_DYLIB') {
      const name = field(block, /^[ \t]*name (.+) \(offset [0-9]+\)[ \t]*\r?$/gm);
      if (installName !== null || !safeText(name) || !name) invalid('INVALID_LOAD_COMMANDS');
      // Identity may bind a staged rewrite target, but is never a load/copy edge.
      installName = name;
    } else if (command === 'LC_DYLD_ENVIRONMENT') invalid('EMBEDDED_DYLD_ENVIRONMENT');
  }
  if (deploymentCommands !== 1 || platform !== 'macos' || minimum === null) invalid('MISSING_OR_AMBIGUOUS_DEPLOYMENT_TARGET');
  return Object.freeze({ minimum, version: Object.freeze(version(minimum)), dependencies: Object.freeze(dependencies), rpaths: Object.freeze(rpaths), installName });
}

function executablePaths(values) {
  if (!Array.isArray(values) || values.length !== 9) invalid('INVALID_REQUIRED_EXECUTABLES');
  const names = values.map(relative), unique = new Set(names);
  if (unique.size !== 9 || !unique.has('jre/bin/java') || !unique.has('redis/bin/redis-server')) invalid('INVALID_REQUIRED_EXECUTABLES');
  const postgres = names.filter(name => name.startsWith('postgres/'));
  if (postgres.length !== PG_EXECUTABLES.length || new Set(postgres.map(name => path.posix.dirname(name))).size !== 1
      || PG_EXECUTABLES.some(name => !postgres.some(file => path.posix.basename(file) === name))) invalid('INVALID_REQUIRED_EXECUTABLES');
  return names;
}

function modulePaths(values) {
  if (!Array.isArray(values) || values.length !== 5) invalid('INVALID_REQUIRED_MODULES');
  const names = values.map(relative), unique = new Set(names);
  if (unique.size !== 5 || JRE_MODULES.some(name => !unique.has(name))) invalid('INVALID_REQUIRED_MODULES');
  const postgres = names.filter(name => name.startsWith('postgres/'));
  if (postgres.length !== 2 || new Set(postgres.map(name => path.posix.dirname(name))).size !== 1
      || PG_MODULES.some(name => !postgres.some(file => path.posix.basename(file) === `${name}.dylib`))) invalid('INVALID_REQUIRED_MODULES');
  return names;
}

function libraryKindAllowed(kind) {
  // PostgreSQL on this macOS target installs dlopen bundles with .dylib names.
  // Names do not determine MH_DYLIB versus MH_BUNDLE; direct load edges still require DYLIB.
  return kind === 'DYLIB' || kind === 'BUNDLE';
}

// file(1)'s selected arm64 description is derived from the Mach header filetype.
// Do not let an executable in a different universal slice confer executable status.
function nativeKind(description) {
  if (typeof description !== 'string' || description.length > 4096 || description.includes('\0')) return null;
  const matches = [...description.matchAll(/\bMach-O 64-bit (executable|dynamically linked shared library|bundle) arm64(?=[\s,\]]|$)/g)];
  const kinds = new Set(matches.map(match => ({ executable: 'EXECUTE', 'dynamically linked shared library': 'DYLIB', bundle: 'BUNDLE' })[match[1]]));
  return kinds.size === 1 ? [...kinds][0] : null;
}

function validateNativeInventory({ minimumSystemVersion, release, native, requiredExecutables, requiredModules }) {
  const required = executablePaths(requiredExecutables);
  const modules = modulePaths(requiredModules);
  const findings = [];
  const add = (code, file = '', detail = '') => {
    if (findings.length >= LIMITS.findings) invalid('FINDING_LIMIT');
    findings.push({ code, file, detail });
  };
  if (minimumSystemVersion !== POLICY.minimumSystemVersion) add('DECLARED_MINIMUM_CHANGED', '', `expected ${POLICY.minimumSystemVersion}`);
  const floor = version(POLICY.minimumSystemVersion);
  if (typeof release !== 'string' || Buffer.byteLength(release) > 65536 || release.includes('\0')) add('INVALID_JAVA_RELEASE');
  else {
    const values = [...release.matchAll(/^JAVA_VERSION="([^"\r\n]+)"\r?$/gm)];
    if (values.length !== 1 || !/^([1-9][0-9]{0,2})(?:[.+-][0-9A-Za-z._+-]+)?$/.test(values[0]?.[1] || '')) add('INVALID_JAVA_RELEASE');
    else if (Number(values[0][1].match(/^[0-9]+/)[0]) !== POLICY.javaMajor)
      add('JAVA_MAJOR_MISMATCH', 'jre/release', `expected ${POLICY.javaMajor}, found ${values[0][1]}`);
  }
  if (!Array.isArray(native) || !native.length || native.length > LIMITS.natives) invalid('INVALID_INVENTORY');
  const files = new Map(), basenames = new Map();
  for (const entry of native) {
    if (!entry || typeof entry !== 'object') invalid('INVALID_INVENTORY');
    const file = relative(entry.file);
    if (files.has(file) || typeof entry.sha256 !== 'string' || entry.sha256.length !== 64 || !/^[0-9a-f]{64}$/.test(entry.sha256)) invalid('INVALID_INVENTORY');
    if (typeof entry.architectures !== 'string' || entry.architectures.length > 1024 || !/^\s*(?:arm64|arm64e|x86_64|i386|ppc64|ppc)(?:\s+(?:arm64|arm64e|x86_64|i386|ppc64|ppc))*\s*$/.test(entry.architectures))
      add('INVALID_ARCHITECTURE_OUTPUT', file);
    else if (!entry.architectures.trim().split(/\s+/).includes(POLICY.architecture)) add('ARCHITECTURE_MISMATCH', file, 'requires arm64');
    const kind = nativeKind(entry.fileDescription), executable = kind === 'EXECUTE';
    if (!kind) add('UNSUPPORTED_NATIVE_TYPE', file);
    if (LIBRARY_NAME.test(file) && !libraryKindAllowed(kind)) add('LIBRARY_ROLE_TYPE', file);
    if (!Number.isInteger(entry.mode) || entry.mode < 0 || entry.mode > 0o7777) add('INVALID_NATIVE_MODE', file);
    let commands;
    try { commands = parseLoadCommands(entry.loadCommands); }
    catch (error) {
      if (!(error instanceof NativeRuntimePolicyError)) throw error;
      for (const finding of error.findings) add(finding.code, file, finding.detail); commands = null;
    }
    if (commands && above(commands.version, floor)) add('MINIMUM_OS_EXCEEDED', file, `${commands.minimum} > ${POLICY.minimumSystemVersion}`);
    const name = path.posix.basename(file), previous = basenames.get(name);
    if (previous && previous.sha256 !== entry.sha256) add('BASENAME_COLLISION', file, `different bytes also at ${previous.file}`);
    else if (!previous) basenames.set(name, entry);
    files.set(file, { ...entry, kind, executable, commands });
  }
  if (!files.has('jre/bin/java')) add('JAVA_LAUNCHER_MISSING', 'jre/bin/java');
  for (const file of required) {
    const entry = files.get(file);
    if (!entry) { add('REQUIRED_EXECUTABLE_MISSING', file, 'must be an inspected arm64 Mach-O executable'); continue; }
    if (entry.kind !== 'EXECUTE') add('REQUIRED_EXECUTABLE_TYPE', file, 'requires MH_EXECUTE');
    if (!Number.isInteger(entry.mode) || (entry.mode & 0o100) === 0) add('REQUIRED_EXECUTABLE_MODE', file, 'requires owner execute permission');
  }
  for (const file of modules) {
    const entry = files.get(file);
    if (!entry) { add('REQUIRED_MODULE_MISSING', file); continue; }
    if (JRE_MODULES.includes(file) ? entry.kind !== 'DYLIB' : !libraryKindAllowed(entry.kind)) add('REQUIRED_MODULE_TYPE', file);
    if (!Number.isInteger(entry.mode) || (entry.mode & 0o400) === 0) add('REQUIRED_MODULE_MODE', file);
  }
  function local(reference, owner, rpath = false) {
    let suffix;
    if (reference === '@loader_path' || reference.startsWith('@loader_path/')) suffix = reference.slice('@loader_path'.length);
    else if (owner.executable && (reference === '@executable_path' || reference.startsWith('@executable_path/'))) suffix = reference.slice('@executable_path'.length);
    else { add(rpath ? 'UNSUPPORTED_RPATH' : 'NON_RELOCATABLE_REFERENCE', owner.file, reference); return null; }
    const target = path.posix.normalize(path.posix.join(path.posix.dirname(owner.file), suffix.replace(/^\//, '')));
    if (target === '..' || target.startsWith('../') || target.startsWith('/')) { add('ESCAPING_NATIVE_REFERENCE', owner.file, reference); return null; }
    return target;
  }
  for (const owner of files.values()) {
    if (!owner.commands) continue;
    // Conservative: require each object's own RPATHs to be self-resolving. Do not guess the
    // executable/load stack for dlopen plugins, or accept DYLD_LIBRARY_PATH as a closure proof.
    const paths = owner.commands.rpaths.map(ref => local(ref, owner, true)).filter(ref => ref !== null);
    for (const reference of owner.commands.dependencies) {
      if (systemReference(reference)) continue;
      let candidates;
      if (reference.startsWith('@rpath/')) {
        const suffix = reference.slice('@rpath/'.length);
        const resolved = [...new Set(paths.map(base => path.posix.normalize(path.posix.join(base, suffix))))];
        if (resolved.some(name => name === '..' || name.startsWith('../') || name.startsWith('/'))) {
          add('ESCAPING_NATIVE_REFERENCE', owner.file, reference); continue;
        }
        candidates = resolved.filter(name => files.has(name));
      } else {
        const resolved = local(reference, owner); if (resolved === null) continue;
        candidates = files.has(resolved) ? [resolved] : [];
      }
      if (!candidates.length) add('UNRESOLVED_NATIVE_REFERENCE', owner.file, reference);
      else if (new Set(candidates.map(name => files.get(name).sha256)).size !== 1)
        add('AMBIGUOUS_NATIVE_REFERENCE', owner.file, reference);
      if (candidates.some(name => files.get(name).kind !== 'DYLIB')) add('DEPENDENCY_NOT_DYLIB', owner.file, reference);
    }
  }
  if (findings.length) throw new NativeRuntimePolicyError(findings);
  return Object.freeze({ nativeFiles: files.size, architecture: POLICY.architecture,
    minimumSystemVersion: POLICY.minimumSystemVersion, javaMajor: POLICY.javaMajor });
}

function systemReference(reference) {
  return safeText(reference) && (reference.startsWith('/usr/lib/') || reference.startsWith('/System/Library/'))
    && path.posix.normalize(reference) === reference;
}
const stamp = stat => [stat.dev, stat.ino, stat.mode, stat.nlink, stat.size, stat.mtimeNs, stat.ctimeNs].join(':');
function regularDigest(file, maximum = LIMITS.fileBytes) {
  const stat = fs.lstatSync(file, { bigint: true });
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1n) invalid('UNSAFE_NATIVE_FILE');
  if (stat.size > BigInt(maximum)) invalid('NATIVE_LIMIT');
  const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW), bytes = Buffer.alloc(64 * 1024);
  const digest = crypto.createHash('sha256');
  try {
    if (stamp(fs.fstatSync(fd, { bigint: true })) !== stamp(stat)) invalid('NATIVE_CHANGED');
    let offset = 0;
    for (;;) {
      const size = fs.readSync(fd, bytes, 0, bytes.length, offset); if (!size) break; offset += size;
      if (offset > maximum) invalid('NATIVE_LIMIT'); digest.update(bytes.subarray(0, size));
    }
    if (offset !== Number(stat.size) || stamp(fs.fstatSync(fd, { bigint: true })) !== stamp(stat)
        || stamp(fs.lstatSync(file, { bigint: true })) !== stamp(stat)) invalid('NATIVE_CHANGED');
    return digest.digest('hex');
  } finally { bytes.fill(0); fs.closeSync(fd); }
}

// Verify before the existing flattening copy can discard a second, different source
// with the same basename. Merely inspecting the flattened tree cannot detect that loss.
function verifyDependencyCopy({ reference, dependency, destination }) {
  if (!safeText(reference) || !reference) invalid('INVALID_NATIVE_REFERENCE');
  if (systemReference(reference)) return null;
  if (typeof dependency !== 'string' || !path.isAbsolute(dependency) || !fs.existsSync(dependency))
    invalid('UNRESOLVED_COPY_DEPENDENCY', '', reference);
  if (typeof destination !== 'string' || !path.isAbsolute(destination)) invalid('INVALID_COPY_DESTINATION');
  const source = fs.realpathSync(dependency), sourceDigest = regularDigest(source);
  const target = path.join(destination, path.basename(dependency));
  let targetExists = true;
  try { fs.lstatSync(target); } catch (error) { if (error.code !== 'ENOENT') throw error; targetExists = false; }
  if (targetExists && regularDigest(target) !== sourceDigest)
    invalid('COPY_BASENAME_COLLISION', path.basename(target), reference);
  return target;
}

function inspectNative(file) {
  const read = (tool, args) => {
    try { return execFileSync(tool, args, { encoding: 'utf8', timeout: 15000, maxBuffer: LIMITS.outputBytes,
      env: { PATH: '/usr/bin:/bin', LANG: 'C', LC_ALL: 'C' }, stdio: ['ignore', 'pipe', 'pipe'] }); }
    catch { invalid('NATIVE_INSPECTION_FAILED'); }
  };
  return { fileDescription: read('/usr/bin/file', ['-b', file]), architectures: read('/usr/bin/lipo', ['-archs', file]),
    loadCommands: read('/usr/bin/otool', ['-arch', POLICY.architecture, '-l', file]) };
}

function boundedMetadata(file, limit, code) {
  let stat;
  try { stat = fs.lstatSync(file, { bigint: true }); } catch (error) { if (error.code === 'ENOENT') invalid(code); throw error; }
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1n || stat.size === 0n || stat.size > BigInt(limit)) invalid(code);
  const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW), bytes = Buffer.alloc(limit + 1);
  try {
    if (stamp(fs.fstatSync(fd, { bigint: true })) !== stamp(stat)) invalid(code);
    let count = 0, size;
    while (count < bytes.length && (size = fs.readSync(fd, bytes, count, bytes.length - count, count)) > 0) count += size;
    if (count !== Number(stat.size) || stamp(fs.fstatSync(fd, { bigint: true })) !== stamp(stat)
        || stamp(fs.lstatSync(file, { bigint: true })) !== stamp(stat)) invalid(code);
    const value = bytes.subarray(0, count).toString('utf8');
    if (value.includes('\0') || !Buffer.from(value).equals(bytes.subarray(0, count))) invalid(code);
    return value;
  } finally { bytes.fill(0); fs.closeSync(fd); }
}

function verifyPostgresExtensions(root, postgresShare) {
  const share = relative(postgresShare);
  if (!share.startsWith('postgres/')) invalid('INVALID_POSTGRES_SHARE');
  for (const name of PG_MODULES) {
    const control = boundedMetadata(path.join(root, share, 'extension', `${name}.control`), 65536, 'REQUIRED_EXTENSION_CONTROL');
    const assignment = key => {
      const lines = [...control.matchAll(new RegExp(`^[ \\t]*${key}[ \\t]*=`, 'gm'))];
      const values = [...control.matchAll(new RegExp(`^[ \\t]*${key}[ \\t]*=[ \\t]*'([^'\\r\\n]*)'[ \\t]*(?:#.*)?\\r?$`, 'gm'))];
      if (lines.length !== 1 || values.length !== 1) invalid('EXTENSION_CONTROL_BINDING');
      return values[0][1];
    };
    if (assignment('module_pathname') !== `$libdir/${name}`) invalid('EXTENSION_CONTROL_BINDING');
    const version = assignment('default_version');
    if (version.length > 32 || !/^[0-9]+(?:\.[0-9]+){1,3}$/.test(version)) invalid('EXTENSION_CONTROL_BINDING');
    // PostgreSQL may install an older base and then follow upgrade scripts to default_version.
    // Check a bounded metadata path; this does not execute SQL or prove ABI compatibility.
    const directory = path.join(root, share, 'extension');
    const names = fs.readdirSync(directory).filter(file => file.startsWith(`${name}--`) && file.endsWith('.sql')).sort();
    if (!names.length || names.length > 256) invalid('REQUIRED_EXTENSION_SQL');
    const number = '[0-9]+(?:\\.[0-9]+){1,3}', expression = new RegExp(`^${name}--(${number})(?:--(${number}))?\\.sql$`);
    const reached = new Map(), upgrades = new Map(), queue = [];
    for (const file of names) {
      const match = expression.exec(file);
      if (!match || match[1].length > 32 || match[2]?.length > 32) invalid('REQUIRED_EXTENSION_SQL');
      if (!match[2]) { reached.set(match[1], { from: null, file }); queue.push(match[1]); }
      else { if (!upgrades.has(match[1])) upgrades.set(match[1], []); upgrades.get(match[1]).push({ to: match[2], file }); }
    }
    for (let index = 0; !reached.has(version) && index < queue.length; index++) {
      const from = queue[index];
      for (const edge of upgrades.get(from) || []) {
        if (!reached.has(edge.to)) { reached.set(edge.to, { from, file: edge.file }); queue.push(edge.to); }
      }
    }
    if (!reached.has(version)) invalid('REQUIRED_EXTENSION_SQL');
    let cursor = version, total = 0, count = 0;
    while (cursor !== null) {
      if (++count > 64) invalid('REQUIRED_EXTENSION_SQL');
      const node = reached.get(cursor);
      const sql = boundedMetadata(path.join(directory, node.file), 4 * 1024 * 1024, 'REQUIRED_EXTENSION_SQL');
      total += Buffer.byteLength(sql); if (total > 32 * 1024 * 1024) invalid('REQUIRED_EXTENSION_SQL');
      cursor = node.from;
    }
  }
}

function verifyNativeRuntime({ root, minimumSystemVersion, requiredExecutables, requiredModules, postgresShare, inspect = inspectNative, platform = 'darwin', manifest, provenance }) {
  if (platform === 'win32') return require('./windows-pe-policy.cjs').verifyWindowsRuntime({ root, manifest, provenance, supplies: require('./windows-runtime-supply.json') });
  const required = executablePaths(requiredExecutables);
  const modules = modulePaths(requiredModules);
  const share = relative(postgresShare);
  if (!share.startsWith('postgres/')) invalid('INVALID_POSTGRES_SHARE');
  if (typeof root !== 'string' || !path.isAbsolute(root) || path.normalize(root) !== root || fs.realpathSync(root) !== root
      || typeof inspect !== 'function') invalid('INVALID_STAGE_ROOT');
  let count = 0; const native = [], observed = new Map();
  const initialRoot = fs.lstatSync(root, { bigint: true });
  if (!initialRoot.isDirectory() || initialRoot.isSymbolicLink()) invalid('INVALID_STAGE_ROOT');
  function walk(directory, depth = 0) {
    if (depth > LIMITS.depth) invalid('NATIVE_LIMIT');
    const parent = fs.lstatSync(directory, { bigint: true });
    if (!parent.isDirectory() || parent.isSymbolicLink()) invalid('UNSAFE_STAGE_ENTRY', path.relative(root, directory));
    observed.set(directory, stamp(parent));
    for (const name of fs.readdirSync(directory)) {
      if (++count > LIMITS.files) invalid('NATIVE_LIMIT');
      const file = path.join(directory, name), rel = relative(path.relative(root, file)), stat = fs.lstatSync(file, { bigint: true });
      if (stat.isDirectory() && !stat.isSymbolicLink()) { walk(file, depth + 1); continue; }
      if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1n) invalid('UNSAFE_STAGE_ENTRY', rel);
      observed.set(file, stamp(stat));
      const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW), magic = Buffer.alloc(4);
      try {
        if (stamp(fs.fstatSync(fd, { bigint: true })) !== stamp(stat)) invalid('NATIVE_CHANGED', rel);
        fs.readSync(fd, magic, 0, 4, 0);
        if (stamp(fs.fstatSync(fd, { bigint: true })) !== stamp(stat)) invalid('NATIVE_CHANGED', rel);
      } finally { fs.closeSync(fd); }
      if (!MACHO.has(magic.toString('hex'))) {
        if (LIBRARY_NAME.test(rel)) invalid('UNSUPPORTED_LIBRARY_FORMAT', rel);
        if (magic.toString('hex') === '7f454c46' && !required.includes(rel)) invalid('FOREIGN_NATIVE_FORMAT', rel);
        continue;
      }
      if (native.length >= LIMITS.natives || stat.size > BigInt(LIMITS.fileBytes)) invalid('NATIVE_LIMIT', rel);
      const sha256 = regularDigest(file), observation = inspect(file);
      if (stamp(fs.lstatSync(file, { bigint: true })) !== stamp(stat)) invalid('NATIVE_CHANGED', rel);
      native.push({ ...observation, file: rel, sha256, mode: Number(stat.mode & 0o7777n) });
    }
    if (stamp(fs.lstatSync(directory, { bigint: true })) !== stamp(parent)) invalid('STAGE_CHANGED', path.relative(root, directory));
  }
  walk(root);
  verifyPostgresExtensions(root, share);
  const releaseFile = path.join(root, 'jre', 'release');
  let releaseStat;
  try { releaseStat = fs.lstatSync(releaseFile, { bigint: true }); }
  catch (error) { if (error.code === 'ENOENT') invalid('INVALID_JAVA_RELEASE'); throw error; }
  if (!releaseStat.isFile() || releaseStat.isSymbolicLink() || releaseStat.nlink !== 1n || releaseStat.size > 65536n) invalid('INVALID_JAVA_RELEASE');
  const fd = fs.openSync(releaseFile, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW), bytes = Buffer.alloc(65537);
  let release;
  try {
    if (stamp(fs.fstatSync(fd, { bigint: true })) !== stamp(releaseStat)) invalid('NATIVE_CHANGED', 'jre/release');
    let count = 0, size;
    while (count < bytes.length && (size = fs.readSync(fd, bytes, count, bytes.length - count, count)) > 0) count += size;
    if (count !== Number(releaseStat.size) || stamp(fs.fstatSync(fd, { bigint: true })) !== stamp(releaseStat)) invalid('NATIVE_CHANGED', 'jre/release');
    release = bytes.subarray(0, count).toString('utf8');
    if (!Buffer.from(release).equals(bytes.subarray(0, count))) invalid('INVALID_JAVA_RELEASE');
  } finally { bytes.fill(0); fs.closeSync(fd); }
  for (const [file, identity] of observed) {
    if (stamp(fs.lstatSync(file, { bigint: true })) !== identity) invalid('STAGE_CHANGED', path.relative(root, file));
  }
  if (stamp(fs.lstatSync(root, { bigint: true })) !== stamp(initialRoot)) invalid('STAGE_CHANGED');
  return validateNativeInventory({ minimumSystemVersion, release, native, requiredExecutables: required, requiredModules: modules });
}

module.exports = Object.freeze({ POLICY, NativeRuntimePolicyError, parseLoadCommands, validateNativeInventory, verifyDependencyCopy, verifyNativeRuntime, verifyPostgresExtensions });
