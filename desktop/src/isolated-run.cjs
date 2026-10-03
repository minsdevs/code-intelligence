'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { types } = require('node:util');

const CLAIM_FILE = '.isolated-run.json';
const ISOLATED_LAUNCH_BLOCKERS = Object.freeze([
  'CREDENTIAL_STORE_UNVERIFIED', 'SERVICE_ENDPOINT_OWNERSHIP_UNPROVEN'
]);
const prepared = new WeakMap();
class IsolatedRunError extends Error {
  constructor(code = 'ISOLATED_RUN_INVALID') {
    super(code);
    this.name = 'IsolatedRunError';
    this.code = code;
    if (code === 'ISOLATED_LAUNCH_BLOCKED') this.blockers = ISOLATED_LAUNCH_BLOCKERS;
  }
}
const invalid = () => { throw new IsolatedRunError(); };
const inside = (child, parent) => child === parent || child.startsWith(parent.endsWith(path.sep) ? parent : parent + path.sep);
const overlaps = (a, b) => inside(a, b) || inside(b, a);
const stamp = stat => [stat.dev, stat.ino, stat.mode, stat.uid, stat.gid].join(':');

function parseIsolatedRunArguments(argv) {
  if (types.isProxy(argv) || !Array.isArray(argv)) invalid();
  const argumentsCopy = [];
  for (let index = 0; index < argv.length; index++) {
    const descriptor = Object.getOwnPropertyDescriptor(argv, String(index));
    if (!descriptor || !Object.hasOwn(descriptor, 'value') || typeof descriptor.value !== 'string') invalid();
    argumentsCopy.push(descriptor.value);
  }
  const result = {};
  const flags = { '--isolated-run-parent': 'parentDirectory', '--isolated-runtime-root': 'runtimeDirectory' };
  for (let index = 0; index < argumentsCopy.length; index++) {
    const argument = argumentsCopy[index];
    if (!argument.startsWith('--isolated-')) continue;
    const equal = argument.indexOf('=');
    const flag = equal < 0 ? argument : argument.slice(0, equal);
    if (!Object.hasOwn(flags, flag) || Object.hasOwn(result, flags[flag])) invalid();
    const value = equal < 0 ? argumentsCopy[++index] : argument.slice(equal + 1);
    if (typeof value !== 'string' || !value || value.startsWith('--')) invalid();
    result[flags[flag]] = value;
  }
  if (!Object.keys(result).length) return null;
  if (Object.keys(result).length !== 2) invalid();
  return Object.freeze(result);
}

function absolute(value) {
  if (typeof value !== 'string' || !value || value.length > 4096 || /[\x00-\x1f\x7f]/.test(value)
      || !path.isAbsolute(value) || path.normalize(value) !== value) invalid();
  return value;
}

function chain(directory, rejectClaims = false) {
  let cursor = path.parse(directory).root;
  for (const part of directory.slice(cursor.length).split(path.sep).filter(Boolean)) {
    cursor = path.join(cursor, part);
    const stat = fs.lstatSync(cursor);
    if (!stat.isDirectory() || stat.isSymbolicLink()) invalid();
    if (rejectClaims) {
      try { fs.lstatSync(path.join(cursor, CLAIM_FILE)); invalid(); }
      catch (error) { if (error.code !== 'ENOENT') throw error; }
    }
  }
  if (fs.realpathSync(directory) !== directory) invalid();
}

function directory(directoryPath, privateMode, rejectClaims = false) {
  chain(directoryPath, rejectClaims);
  const stat = fs.lstatSync(directoryPath);
  if (stat.uid !== process.getuid() || (stat.mode & 0o7000) !== 0
      || (privateMode ? (stat.mode & 0o777) !== 0o700 : (stat.mode & 0o022) !== 0)) invalid();
  return stamp(stat);
}

// Forbidden destinations may not exist yet. Resolve their closest existing ancestor
// so a caller's alias (such as /var) cannot hide overlap with a canonical input.
function canonicalForbidden(value) {
  let cursor = value;
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

function prepareIsolatedRun(options) {
  // Reject accessor/proxy configuration before calling any filesystem API.
  if (!options || typeof options !== 'object' || types.isProxy(options) || Array.isArray(options)) invalid();
  const fields = Object.getOwnPropertyDescriptors(options);
  if (Reflect.ownKeys(fields).some(key => !['parentDirectory', 'runtimeDirectory', 'forbiddenRoots'].includes(key)
      || !Object.hasOwn(fields[key], 'value'))) invalid();
  const parentDirectory = absolute(fields.parentDirectory?.value);
  const runtimeDirectory = absolute(fields.runtimeDirectory?.value);
  const forbiddenRoots = fields.forbiddenRoots ? fields.forbiddenRoots.value : [];
  if (types.isProxy(forbiddenRoots) || !Array.isArray(forbiddenRoots)) invalid();
  const forbidden = [];
  for (let index = 0; index < forbiddenRoots.length; index++) {
    const descriptor = Object.getOwnPropertyDescriptor(forbiddenRoots, String(index));
    if (!descriptor || !Object.hasOwn(descriptor, 'value')) invalid();
    forbidden.push(absolute(descriptor.value));
  }
  if (process.platform === 'win32' || typeof process.getuid !== 'function') {
    throw new IsolatedRunError('ISOLATED_RUN_UNSUPPORTED_PLATFORM');
  }
  if (overlaps(parentDirectory, runtimeDirectory)) invalid();
  try {
    const parentIdentity = directory(parentDirectory, true, true);
    const runtimeIdentity = directory(runtimeDirectory, false, true);
    const excluded = forbidden.map(canonicalForbidden);
    if (excluded.some(root => overlaps(root, parentDirectory) || overlaps(root, runtimeDirectory))) invalid();
    if (directory(parentDirectory, true, true) !== parentIdentity) invalid();
    const root = fs.mkdtempSync(path.join(parentDirectory, 'desktop-run-'));
    const rootIdentity = directory(root, true);
    const paths = Object.freeze(Object.fromEntries(['userData', 'sessionData', 'logs', 'temp', 'crashDumps', 'home', 'output']
      .map(name => [name, path.join(root, name)])));
    const identities = new Map();
    const assertDirectories = () => {
      if (directory(parentDirectory, true, true) !== parentIdentity
          || directory(root, true) !== rootIdentity || directory(runtimeDirectory, false, true) !== runtimeIdentity) invalid();
      for (const [name, identity] of identities) if (directory(paths[name], true) !== identity) invalid();
    };
    for (const [name, destination] of Object.entries(paths)) {
      assertDirectories();
      fs.mkdirSync(destination, { mode: 0o700 });
      identities.set(name, directory(destination, true));
    }
    const claim = path.join(root, CLAIM_FILE);
    const claimBytes = Buffer.from(JSON.stringify({ version: 1, launchAllowed: false, root, runtimeRoot: runtimeDirectory, paths }));
    if (claimBytes.length > 65536) invalid();
    assertDirectories();
    const fd = fs.openSync(claim, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, 0o600);
    let claimIdentity;
    try { fs.writeFileSync(fd, claimBytes); fs.fsyncSync(fd); claimIdentity = stamp(fs.fstatSync(fd)); }
    finally { fs.closeSync(fd); }
    const assertIdentity = () => {
      try {
        assertDirectories();
        const readFd = fs.openSync(claim, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
        try {
          const stat = fs.fstatSync(readFd);
          if (!stat.isFile() || stat.nlink !== 1 || stat.uid !== process.getuid() || (stat.mode & 0o7777) !== 0o600
              || stamp(stat) !== claimIdentity || stat.size !== claimBytes.length) invalid();
          const bytes = Buffer.alloc(claimBytes.length + 1);
          if (fs.readSync(readFd, bytes, 0, bytes.length, 0) !== claimBytes.length
              || !bytes.subarray(0, claimBytes.length).equals(claimBytes)
              || stamp(fs.lstatSync(claim)) !== claimIdentity) invalid();
        } finally { fs.closeSync(readFd); }
        assertDirectories();
      } catch (error) { if (error instanceof IsolatedRunError) throw error; invalid(); }
    };
    assertIdentity();
    const plan = Object.freeze({ root, runtimeRoot: runtimeDirectory, paths, assertIdentity });
    prepared.set(plan, assertIdentity);
    return plan;
  } catch (error) { if (error instanceof IsolatedRunError) throw error; invalid(); }
}

function assertPrepared(plan) {
  const assertIdentity = plan && !types.isProxy(plan) && prepared.get(plan);
  if (!assertIdentity) invalid();
  assertIdentity();
}

function assertIsolatedLaunchReady(plan) {
  assertPrepared(plan);
  throw new IsolatedRunError('ISOLATED_LAUNCH_BLOCKED');
}

function isolatedChildEnvironment(plan) {
  assertPrepared(plan);
  return { HOME: plan.paths.home, TMPDIR: plan.paths.temp, TMP: plan.paths.temp, TEMP: plan.paths.temp };
}

// These checks reject static aliases and detect identity replacement; Node path APIs
// do not provide openat confinement against a hostile same-user ancestor mutation.
module.exports = { IsolatedRunError, CLAIM_FILE, ISOLATED_LAUNCH_BLOCKERS,
  parseIsolatedRunArguments, prepareIsolatedRun, assertIsolatedLaunchReady, isolatedChildEnvironment };
