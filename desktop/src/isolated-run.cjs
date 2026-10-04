'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { types } = require('node:util');

const CLAIM_FILE = '.isolated-run.json';
const VALIDATION_IDENTITIES = Object.freeze({
  validation: Object.freeze({ name: 'Code Intelligence Validation', appId: 'dev.codeintelligence.desktop.validation' }),
  automation: Object.freeze({ name: 'Code Intelligence Acceptance', appId: 'dev.codeintelligence.desktop.acceptance' }),
});
const prepared = new WeakMap();
class IsolatedRunError extends Error {
  constructor(code = 'ISOLATED_RUN_INVALID') {
    super(code);
    this.name = 'IsolatedRunError';
    this.code = code;
  }
}
const invalid = () => { throw new IsolatedRunError(); };
const inside = (child, parent) => child === parent || child.startsWith(parent.endsWith(path.sep) ? parent : parent + path.sep);
const overlaps = (a, b) => inside(a, b) || inside(b, a);
const stamp = stat => [stat.dev, stat.ino, stat.mode, stat.uid, stat.gid].join(':');

function parseIsolatedRunArguments(argv) {
  if (types.isProxy(argv) || !Array.isArray(argv)) invalid();
  const length = Object.getOwnPropertyDescriptor(argv, 'length');
  if (!length || !Object.hasOwn(length, 'value') || !Number.isSafeInteger(length.value) || length.value < 0) invalid();
  const values = [];
  for (let index = 0; index < length.value; index++) {
    const descriptor = Object.getOwnPropertyDescriptor(argv, String(index));
    if (!descriptor || !Object.hasOwn(descriptor, 'value') || typeof descriptor.value !== 'string') invalid();
    values.push(descriptor.value);
  }
  const result = {};
  const flags = { '--isolated-run-parent': 'parentDirectory', '--isolated-runtime-root': 'runtimeDirectory',
    '--isolated-run-purpose': 'purpose', '--isolated-run-claim': 'claimFile' };
  for (let index = 0; index < values.length; index++) {
    const argument = values[index];
    if (!argument.startsWith('--isolated-')) continue;
    const equal = argument.indexOf('=');
    const flag = equal < 0 ? argument : argument.slice(0, equal);
    if (!Object.hasOwn(flags, flag) || Object.hasOwn(result, flags[flag])) invalid();
    const value = equal < 0 ? values[++index] : argument.slice(equal + 1);
    if (typeof value !== 'string' || !value || value.startsWith('--')) invalid();
    result[flags[flag]] = value;
  }
  const keys = Object.keys(result);
  if (!keys.length) return null;
  if (result.claimFile) {
    if (keys.length !== 1) invalid();
  } else if (!result.parentDirectory || !result.runtimeDirectory
      || keys.some(key => !['parentDirectory', 'runtimeDirectory', 'purpose'].includes(key))) invalid();
  if (result.purpose && !Object.hasOwn(VALIDATION_IDENTITIES, result.purpose)) invalid();
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
function optionsFields(options, accepted) {
  if (!options || typeof options !== 'object' || types.isProxy(options) || Array.isArray(options)) invalid();
  const fields = Object.getOwnPropertyDescriptors(options);
  if (Reflect.ownKeys(fields).some(key => !accepted.includes(key) || !Object.hasOwn(fields[key], 'value'))) invalid();
  return fields;
}
function forbiddenValues(value) {
  const input = value ?? [];
  if (types.isProxy(input) || !Array.isArray(input)) invalid();
  const length = Object.getOwnPropertyDescriptor(input, 'length');
  if (!length || !Object.hasOwn(length, 'value') || !Number.isSafeInteger(length.value) || length.value < 0) invalid();
  const result = [];
  for (let index = 0; index < length.value; index++) {
    const descriptor = Object.getOwnPropertyDescriptor(input, String(index));
    if (!descriptor || !Object.hasOwn(descriptor, 'value')) invalid();
    result.push(canonicalForbidden(absolute(descriptor.value)));
  }
  return result;
}
function supportedPlatform() {
  if (process.platform === 'win32' || typeof process.getuid !== 'function') {
    throw new IsolatedRunError('ISOLATED_RUN_UNSUPPORTED_PLATFORM');
  }
}
function assertPrivateSocketBudget(paths) {
  if (process.platform === 'darwin'
      && Buffer.byteLength(path.join(paths.temp, 'ci-XXXXXX', 'ci-ai-XXXXXX', 'ai.sock')) > 100) invalid();
}
function exactKeys(value, expected) {
  return value && typeof value === 'object' && !Array.isArray(value)
    && Object.keys(value).length === expected.length && expected.every(key => Object.hasOwn(value, key));
}
function readClaim(claimFile) {
  const fd = fs.openSync(claimFile, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
  try {
    const stat = fs.fstatSync(fd);
    if (!stat.isFile() || stat.nlink !== 1 || stat.uid !== process.getuid()
        || (stat.mode & 0o7777) !== 0o600 || stat.size < 2 || stat.size > 65536) invalid();
    const bytes = Buffer.alloc(stat.size + 1);
    if (fs.readSync(fd, bytes, 0, bytes.length, 0) !== stat.size) invalid();
    return { bytes: bytes.subarray(0, stat.size), identity: stamp(stat) };
  } finally { fs.closeSync(fd); }
}
function registerPlan({ record, claimFile, claimBytes, claimIdentity }) {
  const pathIdentities = new Map(Object.entries(record.paths).map(([name, value]) => [name, directory(value, true)]));
  const rootIdentity = directory(record.root, true), runtimeIdentity = directory(record.runtimeRoot, false);
  const assertIdentity = () => {
    try {
      if (directory(record.root, true) !== rootIdentity || directory(record.runtimeRoot, false) !== runtimeIdentity) invalid();
      for (const [name, identity] of pathIdentities) if (directory(record.paths[name], true) !== identity) invalid();
      const current = readClaim(claimFile);
      if (current.identity !== claimIdentity || !current.bytes.equals(claimBytes)
          || stamp(fs.lstatSync(claimFile)) !== claimIdentity) invalid();
    } catch (error) { if (error instanceof IsolatedRunError) throw error; invalid(); }
  };
  const plan = Object.freeze({ root: record.root, runtimeRoot: record.runtimeRoot,
    paths: Object.freeze({ ...record.paths }), appIdentity: VALIDATION_IDENTITIES[record.purpose],
    purpose: record.purpose, claimFile, assertIdentity });
  prepared.set(plan, assertIdentity);
  assertIdentity();
  return plan;
}
function assertRecord(record, claimFile, forbidden) {
  const expectedRecord = ['version', 'launchAllowed', 'purpose', 'appIdentity', 'root', 'runtimeRoot', 'paths'];
  if (!exactKeys(record, expectedRecord) || record.version !== 2 || record.launchAllowed !== true
      || !Object.hasOwn(VALIDATION_IDENTITIES, record.purpose)) invalid();
  const identity = VALIDATION_IDENTITIES[record.purpose];
  if (!exactKeys(record.appIdentity, ['name', 'appId']) || record.appIdentity.name !== identity.name
      || record.appIdentity.appId !== identity.appId) invalid();
  record.root = absolute(record.root); record.runtimeRoot = absolute(record.runtimeRoot);
  if (record.root !== path.dirname(claimFile) || overlaps(record.root, record.runtimeRoot)) invalid();
  const names = ['userData', 'sessionData', 'logs', 'temp', 'crashDumps', 'home', 'output'];
  if (!exactKeys(record.paths, names)) invalid();
  for (const name of names) if (record.paths[name] !== path.join(record.root, name)) invalid();
  assertPrivateSocketBudget(record.paths);
  if (forbidden.some(root => overlaps(root, record.root) || overlaps(root, record.runtimeRoot))) invalid();
}

function prepareIsolatedRun(options) {
  const fields = optionsFields(options, ['parentDirectory', 'runtimeDirectory', 'forbiddenRoots', 'purpose']);
  const parentDirectory = absolute(fields.parentDirectory?.value);
  const runtimeDirectory = absolute(fields.runtimeDirectory?.value);
  const purpose = fields.purpose?.value ?? 'validation';
  if (!Object.hasOwn(VALIDATION_IDENTITIES, purpose)) invalid();
  supportedPlatform();
  if (overlaps(parentDirectory, runtimeDirectory)) invalid();
  try {
    const parentIdentity = directory(parentDirectory, true, true);
    const runtimeIdentity = directory(runtimeDirectory, false, true);
    const forbidden = forbiddenValues(fields.forbiddenRoots?.value);
    if (forbidden.some(root => overlaps(root, parentDirectory) || overlaps(root, runtimeDirectory))) invalid();
    if (directory(parentDirectory, true, true) !== parentIdentity) invalid();
    const root = fs.mkdtempSync(path.join(parentDirectory, 'desktop-run-'));
    directory(root, true);
    const paths = Object.fromEntries(['userData', 'sessionData', 'logs', 'temp', 'crashDumps', 'home', 'output']
      .map(name => [name, path.join(root, name)]));
    try { assertPrivateSocketBudget(paths); }
    catch (error) { fs.rmdirSync(root); throw error; }
    for (const destination of Object.values(paths)) fs.mkdirSync(destination, { mode: 0o700 });
    if (directory(runtimeDirectory, false, true) !== runtimeIdentity) invalid();
    const claimFile = path.join(root, CLAIM_FILE);
    const record = { version: 2, launchAllowed: true, purpose, appIdentity: VALIDATION_IDENTITIES[purpose],
      root, runtimeRoot: runtimeDirectory, paths };
    const claimBytes = Buffer.from(JSON.stringify(record));
    const fd = fs.openSync(claimFile, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, 0o600);
    let claimIdentity;
    try { fs.writeFileSync(fd, claimBytes); fs.fsyncSync(fd); claimIdentity = stamp(fs.fstatSync(fd)); }
    finally { fs.closeSync(fd); }
    return registerPlan({ record, claimFile, claimBytes, claimIdentity });
  } catch (error) { if (error instanceof IsolatedRunError) throw error; invalid(); }
}
function openIsolatedRun(options) {
  const fields = optionsFields(options, ['claimFile', 'forbiddenRoots']);
  supportedPlatform();
  try {
    const claimFile = absolute(fields.claimFile?.value);
    if (fs.realpathSync(claimFile) !== claimFile) invalid();
    const forbidden = forbiddenValues(fields.forbiddenRoots?.value);
    const claim = readClaim(claimFile);
    let record; try { record = JSON.parse(claim.bytes.toString('utf8')); } catch { invalid(); }
    assertRecord(record, claimFile, forbidden);
    return registerPlan({ record, claimFile, claimBytes: claim.bytes, claimIdentity: claim.identity });
  } catch (error) { if (error instanceof IsolatedRunError) throw error; invalid(); }
}
function assertPrepared(plan) {
  const assertIdentity = plan && !types.isProxy(plan) && prepared.get(plan);
  if (!assertIdentity) invalid();
  assertIdentity();
}
function assertIsolatedLaunchReady(plan) {
  assertPrepared(plan);
  if (!Object.values(VALIDATION_IDENTITIES).includes(plan.appIdentity)) invalid();
}
function isolatedChildEnvironment(plan) {
  assertPrepared(plan);
  return { HOME: plan.paths.home, TMPDIR: plan.paths.temp, TMP: plan.paths.temp, TEMP: plan.paths.temp };
}

module.exports = { IsolatedRunError, CLAIM_FILE, VALIDATION_IDENTITIES, parseIsolatedRunArguments,
  prepareIsolatedRun, openIsolatedRun, assertIsolatedLaunchReady, isolatedChildEnvironment };

