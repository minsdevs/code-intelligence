'use strict';
// Static ELF inspection only: never use ldd, which can execute an input binary.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');
const { runtimeRelativePath } = require('../src/runtime-platform.cjs');
const SUPPLIES = require('./linux-runtime-supply.json');
const digest = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const SYSTEM_LIBRARIES = new Set(['libc.so.6', 'libm.so.6', 'libdl.so.2', 'libpthread.so.0', 'librt.so.1',
  'libresolv.so.2', 'libutil.so.1', 'libnss_dns.so.2', 'libnss_files.so.2', 'ld-linux-x86-64.so.2']);
const REQUIRED_EXECUTABLES = ['jre/bin/java', 'redis/bin/redis-server',
  ...['postgres', 'initdb', 'pg_isready', 'psql', 'createdb', 'pg_dump', 'pg_restore'].map(name => 'postgres/bin/' + name)];
const REQUIRED_MODULES = ['jre/lib/libjli.so', 'jre/lib/libjava.so', 'jre/lib/server/libjvm.so',
  'postgres/lib/vector.so', 'postgres/lib/pg_trgm.so'];
function fail(code, file) {
  const error = new Error('Linux runtime policy rejected: ' + code + (file ? ' (' + file + ')' : ''));
  error.code = code; throw error;
}
function requireLinuxHost(platform = process.platform, arch = process.arch) {
  if (platform !== 'linux' || arch !== 'x64') fail('LINUX_X64_NATIVE_HOST_REQUIRED');
}
function parseElfHeader(bytes) {
  if (bytes.length < 4 || bytes.subarray(0, 4).toString('hex') !== '7f454c46') return null;
  if (bytes.length < 64 || bytes[4] !== 2 || bytes[5] !== 1 || bytes[6] !== 1) fail('ELF64_LITTLE_ENDIAN_REQUIRED');
  const type = bytes.readUInt16LE(16), machine = bytes.readUInt16LE(18);
  if (![2, 3].includes(type) || machine !== 62) fail('ELF_X64_REQUIRED');
  return { type, machine };
}
function parseElfMetadata(dynamic, versions, programHeaders = '') {
  const needed = [...dynamic.matchAll(/\(NEEDED\)\s+Shared library: \[([^\]\r\n]+)\]/g)].map(match => match[1]);
  if (needed.some(name => !/^[A-Za-z0-9_.+-]+$/.test(name))) fail('ELF_UNSAFE_DEPENDENCY');
  const rpaths = [...dynamic.matchAll(/\((?:RUNPATH|RPATH)\)\s+Library (?:runpath|rpath): \[([^\]\r\n]*)\]/g)]
    .flatMap(match => match[1].split(':'));
  const interpreters = [...programHeaders.matchAll(/Requesting program interpreter: ([^\]\r\n]+)\]/g)].map(match => match[1]);
  if (interpreters.some(value => value !== '/lib64/ld-linux-x86-64.so.2')) fail('ELF_INTERPRETER_REJECTED');
  const glibc = [...versions.matchAll(/\bName: GLIBC_([0-9]+(?:\.[0-9]+)+)\b/g)].map(match => match[1]);
  if (/\bName: GLIBC_PRIVATE\b/.test(versions)) fail('ELF_PRIVATE_GLIBC_REJECTED');
  return { needed, rpaths, glibc, interpreters };
}
function inspectElf(file) {
  const options = { encoding: 'utf8', maxBuffer: 4 * 1024 * 1024, env: { PATH: '/usr/bin:/bin', LC_ALL: 'C' } };
  const read = args => execFileSync('/usr/bin/readelf', [...args, '--wide', file], options);
  return parseElfMetadata(read(['--dynamic']), read(['--version-info']), read(['--program-headers']));
}
function inventory(root, inspect = inspectElf) {
  if (typeof root !== 'string' || !path.isAbsolute(root) || path.normalize(root) !== root || fs.realpathSync(root) !== root)
    fail('LINUX_RUNTIME_ROOT_INVALID');
  const entries = new Map(); let count = 0;
  function visit(directory, depth) {
    if (depth > 64) fail('LINUX_RUNTIME_LIMIT');
    const parent = fs.lstatSync(directory);
    if (!parent.isDirectory() || parent.isSymbolicLink() || (parent.mode & 0o7022)) fail('LINUX_RUNTIME_DIRECTORY_UNSAFE');
    for (const name of fs.readdirSync(directory)) {
      if (++count > 100000) fail('LINUX_RUNTIME_LIMIT');
      const file = path.join(directory, name), relative = runtimeRelativePath(path.relative(root, file), 'Linux runtime file', 'linux');
      const stat = fs.lstatSync(file);
      if (stat.isDirectory() && !stat.isSymbolicLink()) { visit(file, depth + 1); continue; }
      if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.size > 512 * 1024 * 1024
          || (stat.mode & 0o7022)) fail('LINUX_RUNTIME_FILE_UNSAFE', relative);
      const bytes = fs.readFileSync(file), elf = parseElfHeader(bytes);
      if (!elf && (/\.(?:so(?:\.[0-9]+)*|node)$/.test(name) || bytes.subarray(0, 2).toString() === 'MZ'
          || ['cffaedfe', 'feedfacf', 'cafebabe', 'bebafeca'].includes(bytes.subarray(0, 4).toString('hex'))))
        fail('LINUX_FOREIGN_NATIVE_FORMAT', relative);
      entries.set(relative, { hash: digest(bytes), mode: stat.mode & 0o7777, ...(elf ? { elf: { ...elf, ...inspect(file) } } : {}) });
    }
  }
  visit(root, 0); return entries;
}
function validateClosure(entries) {
  for (const [file, item] of entries) {
    if (!item.elf) continue;
    if (SYSTEM_LIBRARIES.has(path.posix.basename(file))) fail('ELF_SYSTEM_LIBRARY_SHADOWING', file);
    if (item.elf.glibc.some(value => {
      const parts = value.split('.').map(Number);
      return parts[0] > 2 || parts[0] === 2 && (parts[1] > 35 || parts[1] === 35 && parts.slice(2).some(part => part > 0));
    })) fail('LINUX_GLIBC_2_35_BASELINE_EXCEEDED', file);
    const directories = item.elf.rpaths.map(value => {
      if (!/^\$ORIGIN(?:\/[A-Za-z0-9_.+-]+)*$/.test(value)) fail('ELF_NONRELATIVE_SEARCH_PATH', file);
      const resolved = path.posix.normalize(path.posix.join(path.posix.dirname(file), value.slice('$ORIGIN'.length)));
      if (resolved === '..' || resolved.startsWith('../') || path.posix.isAbsolute(resolved)) fail('ELF_SEARCH_PATH_ESCAPE', file);
      return resolved;
    });
    for (const dependency of item.elf.needed) {
      if (SYSTEM_LIBRARIES.has(dependency)) continue;
      const resolved = directories.map(directory => path.posix.join(directory, dependency)).find(candidate => entries.get(candidate)?.elf);
      if (!resolved) fail('ELF_DEPENDENCY_NOT_BUNDLED', file);
    }
  }
  return entries;
}
function verifyLinuxRuntime({ root, manifest, provenance, inspect = inspectElf }) {
  const entries = validateClosure(inventory(root, inspect));
  for (const file of [...REQUIRED_EXECUTABLES, ...REQUIRED_MODULES]) {
    const item = entries.get(file);
    if (!item?.elf || REQUIRED_EXECUTABLES.includes(file) && !(item.mode & 0o111)) fail('LINUX_REQUIRED_NATIVE_MISSING', file);
  }
  if (!/^JAVA_VERSION="21\./m.test(fs.readFileSync(path.join(root, 'jre/release'), 'utf8'))) fail('LINUX_JAVA_21_REQUIRED');
  // Existing common extension SQL/control graph gate applies to the Linux layout too.
  require('./native-runtime-policy.cjs').verifyPostgresExtensions(root, 'postgres/share');
  if (!provenance || provenance.format !== 1 || provenance.platform !== 'linux' || provenance.arch !== 'x64'
      || JSON.stringify(provenance.sources) !== JSON.stringify(SUPPLIES) || !provenance.files) fail('LINUX_PROVENANCE_REQUIRED');
  for (const [file, item] of entries) {
    if (!item.elf) continue;
    const record = provenance.files[file];
    if (!record || record.sha256 !== item.hash || typeof record.source !== 'string'
        || !Array.isArray(record.notices) || !record.notices.length
        || record.notices.some(name => !name.startsWith('notices/') || !entries.has(runtimeRelativePath(name))))
      fail('LINUX_NATIVE_PROVENANCE_MISMATCH', file);
  }
  if (manifest) {
    if (manifest.platform !== 'linux' || manifest.arch !== 'x64' || manifest.backupProtocol !== 3
        || manifest.ownershipProtocol !== 1 || manifest.controlProtocol !== 1 || manifest.minimumGlibc !== '2.35')
      fail('LINUX_MANIFEST_INVALID');
    const observed = [...entries].filter(([file]) => file !== 'runtime-manifest.json');
    if (observed.length !== Object.keys(manifest.files || {}).length
        || observed.some(([file, item]) => manifest.files[file] !== item.hash)) fail('LINUX_MANIFEST_HASH_MISMATCH');
  }
  return entries;
}
module.exports = { SYSTEM_LIBRARIES, REQUIRED_EXECUTABLES, REQUIRED_MODULES, requireLinuxHost,
  parseElfHeader, parseElfMetadata, inspectElf, inventory, validateClosure, verifyLinuxRuntime, digest };
