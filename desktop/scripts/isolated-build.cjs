'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');
const { types } = require('node:util');

const CLAIM_FILE = '.isolated-build.json';
const CLAIMS = [CLAIM_FILE, '.isolated-run.json'];
const TOOL_PATH = '/usr/bin:/bin:/usr/sbin:/sbin';
const MAX_FILE = 16 * 1024 * 1024, MAX_SOURCE = 256 * 1024 * 1024;
class IsolatedBuildError extends Error {
  constructor(code = 'ISOLATED_BUILD_INVALID') { super(code); this.name = 'IsolatedBuildError'; this.code = code; }
}
const invalid = () => { throw new IsolatedBuildError(); };
const digest = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const stamp = stat => [stat.dev, stat.ino, stat.uid, stat.gid, stat.mode].join(':');
const inside = (child, parent) => child === parent || child.startsWith(parent.endsWith(path.sep) ? parent : parent + path.sep);
const overlap = (a, b) => inside(a, b) || inside(b, a);

function absolute(value) {
  if (typeof value !== 'string' || !value || value.length > 4096 || /[\x00-\x1f\x7f]/.test(value)
      || !path.isAbsolute(value) || path.normalize(value) !== value) invalid();
  return value;
}
function directory(file, mode, rejectClaims = false) {
  let cursor = path.parse(file).root;
  for (const part of file.slice(cursor.length).split(path.sep).filter(Boolean)) {
    cursor = path.join(cursor, part);
    const stat = fs.lstatSync(cursor);
    if (!stat.isDirectory() || stat.isSymbolicLink()) invalid();
    if (rejectClaims) for (const claim of CLAIMS) {
      try { fs.lstatSync(path.join(cursor, claim)); invalid(); }
      catch (error) { if (error.code !== 'ENOENT') throw error; }
    }
  }
  const stat = fs.lstatSync(file);
  if (fs.realpathSync(file) !== file || stat.uid !== process.getuid()
      || (stat.mode & 0o7000) !== 0 || (mode === undefined ? (stat.mode & 0o022) !== 0 : (stat.mode & 0o777) !== mode)) invalid();
  return stamp(stat);
}
function writeExclusive(file, bytes, mode) {
  const fd = fs.openSync(file, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, 0o600);
  try { fs.writeFileSync(fd, bytes); fs.fchmodSync(fd, mode); fs.fsyncSync(fd); return stamp(fs.fstatSync(fd)); }
  finally { fs.closeSync(fd); }
}
function readChecked(file, identity, size) {
  const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
  try {
    const stat = fs.fstatSync(fd);
    if (!stat.isFile() || stat.nlink !== 1 || stat.uid !== process.getuid() || stamp(stat) !== identity || stat.size !== size) invalid();
    const bytes = Buffer.alloc(size + 1);
    let offset = 0, count;
    while (offset < bytes.length && (count = fs.readSync(fd, bytes, offset, bytes.length - offset, offset)) > 0) offset += count;
    if (offset !== size || stamp(fs.fstatSync(fd)) !== identity || stamp(fs.lstatSync(file)) !== identity) invalid();
    return bytes.subarray(0, size);
  } finally { fs.closeSync(fd); }
}

function git(sourceDirectory, args, input, maxBuffer = 8 * 1024 * 1024) {
  return execFileSync('/usr/bin/git', ['-c', 'core.fsmonitor=false', '-c', 'core.untrackedCache=false', '-C', sourceDirectory, ...args], {
    input, maxBuffer, timeout: 60000, stdio: ['pipe', 'pipe', 'pipe'],
    env: { PATH: TOOL_PATH, GIT_OPTIONAL_LOCKS: '0', GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' }
  });
}
function cleanHead(sourceDirectory) {
  if (git(sourceDirectory, ['status', '--porcelain=v1', '-z', '--untracked-files=no']).length) {
    throw new IsolatedBuildError('ISOLATED_BUILD_DIRTY');
  }
  const commit = git(sourceDirectory, ['rev-parse', '--verify', 'HEAD^{commit}']).toString('ascii').trim();
  if (!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(commit)) invalid();
  return commit;
}
function selected(name) {
  if (!/^(?:frontend|backend|desktop)(?:\/|$)/.test(name) && !/^analyzers\/ts-analyzer(?:\/|$)/.test(name)) return false;
  const parts = name.split('/');
  if (parts.some(part => part.startsWith('.') || /^(?:node_modules|dist|stage|cache|logs)$/i.test(part))) return false;
  // desktop/build contains tracked packaging configuration, not compiler output.
  if (parts.some((part, index) => part === 'build' && !(index === 1 && parts[0] === 'desktop'))) return false;
  if (parts.some(part => /^(?:credentials|secrets|userData|sessionData)$/i.test(part)) || /\.(?:p12|pfx|key|keystore)$/i.test(name)) return false;
  return true;
}
function canonicalExcluded(file) {
  let cursor = file;
  const suffix = [];
  for (;;) {
    try { return path.join(fs.realpathSync(cursor), ...suffix); }
    catch (error) {
      if (error.code !== 'ENOENT') throw error;
      const parent = path.dirname(cursor);
      if (parent === cursor) throw error;
      suffix.unshift(path.basename(cursor)); cursor = parent;
    }
  }
}
function sourceBlobs(sourceDirectory, sourceCommit) {
  const rawTree = git(sourceDirectory, ['ls-tree', '-rz', '--full-tree', sourceCommit]);
  const text = rawTree.toString('utf8');
  if (!Buffer.from(text).equals(rawTree)) invalid();
  const entries = [];
  for (const line of text.split('\0').filter(Boolean)) {
    const match = /^(\d{6}) (blob|commit) ([a-f0-9]{40}|[a-f0-9]{64})\t(.+)$/.exec(line);
    if (!match) invalid();
    const [, mode, type, oid, name] = match;
    if (name.length > 4096 || /[\\\x00-\x1f\x7f]/.test(name) || path.posix.isAbsolute(name)
        || name.split('/').some(part => !part || part === '.' || part === '..')) invalid();
    if (!selected(name)) continue;
    if (type !== 'blob' || !['100644', '100755'].includes(mode)) invalid();
    entries.push({ name, oid, executable: mode === '100755' });
  }
  if (!entries.length || entries.length > 30000) invalid();
  const ids = entries.map(entry => entry.oid).join('\n') + '\n';
  const sizes = git(sourceDirectory, ['cat-file', '--batch-check=%(objectname) %(objecttype) %(objectsize)'], ids).toString('ascii').trim().split('\n');
  if (sizes.length !== entries.length) invalid();
  let total = 0;
  for (let index = 0; index < entries.length; index++) {
    const match = /^([a-f0-9]+) blob (0|[1-9][0-9]*)$/.exec(sizes[index]);
    if (!match || match[1] !== entries[index].oid) invalid();
    const size = Number(match[2]);
    if (!Number.isSafeInteger(size) || size > MAX_FILE || (total += size) > MAX_SOURCE) invalid();
    entries[index].size = size;
  }
  const batch = git(sourceDirectory, ['cat-file', '--batch'], ids, total + entries.length * 100 + 1024);
  let offset = 0;
  for (const entry of entries) {
    const end = batch.indexOf(10, offset);
    if (end < 0 || batch.subarray(offset, end).toString('ascii') !== `${entry.oid} blob ${entry.size}`) invalid();
    offset = end + 1;
    entry.bytes = batch.subarray(offset, offset + entry.size);
    if (entry.bytes.length !== entry.size || batch[offset + entry.size] !== 10) invalid();
    entry.sha256 = digest(entry.bytes); offset += entry.size + 1;
  }
  if (offset !== batch.length) invalid();
  return entries;
}

function prepareBuildWorkspace(options) {
  if (!options || typeof options !== 'object' || types.isProxy(options) || Array.isArray(options)) invalid();
  const fields = Object.getOwnPropertyDescriptors(options);
  if (Reflect.ownKeys(fields).some(key => !['sourceDirectory', 'parentDirectory'].includes(key) || !Object.hasOwn(fields[key], 'value'))) invalid();
  const sourceDirectory = absolute(fields.sourceDirectory?.value), parentDirectory = absolute(fields.parentDirectory?.value);
  if (process.platform === 'win32' || typeof process.getuid !== 'function') throw new IsolatedBuildError('ISOLATED_BUILD_UNSUPPORTED_PLATFORM');
  if (overlap(sourceDirectory, parentDirectory)) invalid();
  try {
    const sourceIdentity = directory(sourceDirectory, undefined, true), parentIdentity = directory(parentDirectory, 0o700, true);
    const home = require('node:os').homedir();
    const dataParents = process.platform === 'darwin' ? [path.join(home, 'Library', 'Application Support')] : [path.join(home, '.config')];
    if (process.platform !== 'darwin' && process.env.XDG_CONFIG_HOME) dataParents.push(absolute(process.env.XDG_CONFIG_HOME));
    for (const dataParent of dataParents) for (const name of ['Code Intelligence', 'code-intelligence-desktop']) {
      const defaultUserData = canonicalExcluded(path.join(dataParent, name));
      if (overlap(parentDirectory, defaultUserData) || overlap(sourceDirectory, defaultUserData)) invalid();
    }
    const sourceCommit = cleanHead(sourceDirectory);
    // Git objects give a commit-consistent snapshot without copying worktree secrets,
    // generated outputs, dependency links or another agent's untracked files.
    const entries = sourceBlobs(sourceDirectory, sourceCommit);
    const inputs = entries.map(({ name, size, sha256, executable }) => ({ name, size, sha256, executable }));
    if (Buffer.byteLength(JSON.stringify(inputs)) > 7 * 1024 * 1024) invalid();
    if (cleanHead(sourceDirectory) !== sourceCommit || directory(sourceDirectory, undefined, true) !== sourceIdentity
        || directory(parentDirectory, 0o700, true) !== parentIdentity) invalid();
    const root = fs.mkdtempSync(path.join(parentDirectory, 'desktop-build-'));
    const rootIdentity = directory(root, 0o700);
    const sourceRoot = path.join(root, 'source'), workRoot = path.join(root, 'work'), outputRoot = path.join(root, 'output');
    const paths = Object.freeze(Object.fromEntries(['home', 'temp', 'npmCache', 'gradleHome', 'electronCache', 'builderCache', 'npmUserConfig', 'npmGlobalConfig']
      .map(name => [name, path.join(root, name)])));
    const directories = new Map([[root, { mode: 0o700, identity: rootIdentity }]]);
    function assertDirectories(target) {
      if (directory(parentDirectory, 0o700, true) !== parentIdentity) invalid();
      for (const [file, expected] of directories) if ((!target || inside(target, file))
          && directory(file, expected.mode) !== expected.identity) invalid();
    }
    function mkdir(file) {
      assertDirectories(file);
      fs.mkdirSync(file, { mode: 0o700 });
      directories.set(file, { mode: 0o700, identity: directory(file, 0o700) });
    }
    // Claim before copying anything. Interrupted/failed workspaces retain this claim
    // and cannot become the parent of a later run.
    const claim = { version: 1, launchAllowed: false, sourceCommit, root, sourceRoot, workRoot, outputRoot, paths, inputs };
    const claimBytes = Buffer.from(JSON.stringify(claim));
    if (claimBytes.length > 8 * 1024 * 1024) invalid();
    assertDirectories();
    const claimPath = path.join(root, CLAIM_FILE), claimIdentity = writeExclusive(claimPath, claimBytes, 0o600);
    for (const file of [sourceRoot, workRoot, outputRoot, ...Object.entries(paths).filter(([name]) => !name.endsWith('Config')).map(([, file]) => file)]) mkdir(file);
    const tracked = [], sourceNames = new Set();
    const ensureParents = (base, relative) => {
      let cursor = base;
      for (const part of relative.split('/').slice(0, -1)) {
        cursor = path.join(cursor, part); if (!directories.has(cursor)) mkdir(cursor);
      }
    };
    for (const entry of entries) {
      for (const [base, readonly] of [[sourceRoot, true], [workRoot, false]]) {
        ensureParents(base, entry.name);
        const file = path.join(base, entry.name), mode = readonly ? (entry.executable ? 0o555 : 0o444) : (entry.executable ? 0o700 : 0o600);
        assertDirectories(file);
        tracked.push({ file, identity: writeExclusive(file, entry.bytes, mode), size: entry.size, sha256: entry.sha256 });
        if (readonly) sourceNames.add(file);
      }
    }
    for (const name of ['npmUserConfig', 'npmGlobalConfig']) {
      assertDirectories(paths[name]);
      tracked.push({ file: paths[name], identity: writeExclusive(paths[name], Buffer.alloc(0), 0o600), size: 0, sha256: digest(Buffer.alloc(0)) });
    }
    // The immutable input copy is read-only; builders operate only on the independent work copy.
    for (const [file, expected] of [...directories].reverse()) if (inside(file, sourceRoot)) {
      assertDirectories(file); fs.chmodSync(file, 0o555); expected.mode = 0o555; expected.identity = directory(file, 0o555);
    }
    const assertIdentity = () => {
      try {
        assertDirectories();
        if (!readChecked(claimPath, claimIdentity, claimBytes.length).equals(claimBytes)) invalid();
        for (const entry of tracked) if (digest(readChecked(entry.file, entry.identity, entry.size)) !== entry.sha256) invalid();
        const inspectSource = file => {
          for (const name of fs.readdirSync(file)) {
            const child = path.join(file, name), stat = fs.lstatSync(child);
            if (stat.isSymbolicLink()) invalid();
            if (stat.isDirectory()) { if (!directories.has(child)) invalid(); inspectSource(child); }
            else if (!sourceNames.has(child)) invalid();
          }
        };
        inspectSource(sourceRoot); assertDirectories();
      } catch (error) { if (error instanceof IsolatedBuildError) throw error; invalid(); }
    };
    const childEnvironment = () => {
      assertIdentity();
      return { PATH: TOOL_PATH, HOME: paths.home, TMPDIR: paths.temp, TMP: paths.temp, TEMP: paths.temp,
        npm_config_userconfig: paths.npmUserConfig, npm_config_globalconfig: paths.npmGlobalConfig, npm_config_cache: paths.npmCache,
        npm_config_offline: 'true', npm_config_audit: 'false', npm_config_fund: 'false', GRADLE_USER_HOME: paths.gradleHome,
        ELECTRON_CACHE: paths.electronCache, ELECTRON_BUILDER_CACHE: paths.builderCache, CSC_IDENTITY_AUTO_DISCOVERY: 'false' };
    };
    assertIdentity();
    if (cleanHead(sourceDirectory) !== sourceCommit || directory(sourceDirectory, undefined, true) !== sourceIdentity) invalid();
    return Object.freeze({ root, sourceRoot, workRoot, outputRoot, paths, sourceCommit, assertIdentity, childEnvironment });
  } catch (error) { if (error instanceof IsolatedBuildError) throw error; invalid(); }
}

// Identity checks and private output paths are developer-build containment, not an OS
// sandbox against hostile same-user processes or arbitrary scripts from a repository.
module.exports = { IsolatedBuildError, CLAIM_FILE, prepareBuildWorkspace };
