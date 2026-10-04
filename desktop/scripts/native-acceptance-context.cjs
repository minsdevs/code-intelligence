'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

function within(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative !== '' && relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative);
}
function privatePath(candidate, directory = true) {
  assert.ok(typeof candidate === 'string' && path.isAbsolute(candidate) && !/[\r\n\0]/.test(candidate), 'Absolute private path required');
  assert.equal(fs.realpathSync(candidate), candidate, 'Canonical private path required');
  const stat = fs.lstatSync(candidate);
  assert.ok(!stat.isSymbolicLink() && (directory ? stat.isDirectory() : stat.isFile() && stat.nlink === 1), 'Private path type refused');
  assert.equal(stat.uid, process.getuid(), 'Current guest ownership required');
  assert.equal(stat.mode & 0o777, directory ? 0o700 : 0o600, 'Private permissions required');
  return stat;
}
function privateDescendant(root, candidate) {
  assert.ok(within(root, candidate), 'Path must remain inside its private root');
  const device = privatePath(root).dev;
  for (let current = candidate; current !== root; current = path.dirname(current)) {
    assert.equal(privatePath(current).dev, device, 'Mounted/shared roots are prohibited');
  }
}
function absent(candidate) {
  try { fs.lstatSync(candidate); } catch (error) { if (error.code === 'ENOENT') return true; throw error; }
  return false;
}
function freshProfile(sourceRoot, homeRoot) {
  const pkg = JSON.parse(fs.readFileSync(path.join(sourceRoot, 'desktop', 'package.json'), 'utf8'));
  assert.match(pkg.name || '', /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/);
  const profile = path.join(homeRoot, 'Library', 'Application Support', pkg.name);
  assert.ok(absent(profile), 'A fresh disposable application profile is required');
  for (const directory of [path.join(homeRoot, 'Library'), path.dirname(profile)]) {
    assert.equal(fs.realpathSync(directory), directory, 'Application support must not be linked');
    const stat = fs.lstatSync(directory);
    assert.ok(stat.isDirectory() && stat.uid === process.getuid() && !(stat.mode & 0o022), 'Owned application support required');
  }
  return profile;
}
// Pure identity checks are separate for regression coverage, never a production
// override: requireExecutionContext always obtains these facts from this OS.
function validateVmIdentity(descriptor, observed, now = Date.now()) {
  assert.equal(descriptor.format, 1);
  assert.equal(descriptor.kind, 'disposable-macos-vm');
  assert.equal(descriptor.provider, 'tart-apple-virtualization');
  assert.equal(observed.platform, 'darwin'); assert.equal(observed.arch, 'arm64');
  assert.match(observed.model, /^VirtualMac[0-9]+,[0-9]+$/);
  const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
  assert.match(descriptor.vmUuid || '', uuid); assert.match(observed.uuid, uuid);
  assert.equal(descriptor.vmUuid.toUpperCase(), observed.uuid.toUpperCase(), 'Guest identity mismatch');
  assert.match(descriptor.imageDigest || '', /^sha256:[a-f0-9]{64}$/);
  assert.match(descriptor.revision || '', /^[a-f0-9]{40,64}$/);
  assert.match(descriptor.buildSequence || '', /^[1-9][0-9]{0,18}$/);
  assert.ok(BigInt(descriptor.buildSequence) <= 9223372036854775807n);
  for (const value of [descriptor.createdAt, descriptor.expiresAt]) {
    assert.ok(typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(value), 'UTC authorization timestamps required');
  }
  const created = Date.parse(descriptor.createdAt), expires = Date.parse(descriptor.expiresAt);
  assert.ok(Number.isFinite(observed.bootTime) && Number.isFinite(created) && Number.isFinite(expires)
    && created >= observed.bootTime && created <= now && expires > now && expires > created
    && expires - created <= 86400000, 'Stale or invalid disposable VM authorization');
}
function validateLocalEnvironment(env, execArgv = []) {
  for (const [key, value] of Object.entries(env)) {
    if (/^(?:GITHUB_|RUNNER_|DYLD_|CODE_INTELLIGENCE_ISOLATED_)/.test(key)
      || ['NODE_OPTIONS', 'NODE_PATH', 'ELECTRON_RUN_AS_NODE', 'ELECTRON_EXTRA_LAUNCH_ARGS', 'NATIVE_ACCEPTANCE_CONSENT'].includes(key)) {
      assert.ok(!value, `Unexpected ${key} in local context`);
    }
  }
  assert.ok(!execArgv.some(arg => /^(?:-r|--(?:require|import|loader|experimental-loader|inspect)(?:=|-|$))/.test(arg)), 'Injected Node startup options refused');
}
function localContext(env) {
  assert.equal(process.platform, 'darwin', 'Local acceptance requires native macOS');
  assert.equal(process.arch, 'arm64', 'Local acceptance requires native Apple Silicon');
  assert.ok(process.getuid() > 0, 'Run as the disposable guest user, not root');
  validateLocalEnvironment(process.env, process.execArgv);
  validateLocalEnvironment(env);
  const file = env.NATIVE_ACCEPTANCE_CONTEXT;
  const stat = privatePath(file, false);
  assert.ok(stat.size > 0 && stat.size <= 16384, 'Invalid context size');
  const descriptor = JSON.parse(fs.readFileSync(file, 'utf8'));
  const output = (executable, args) => execFileSync(executable, args, {
    encoding: 'utf8', timeout: 5000, maxBuffer: 1024 * 1024,
    env: { PATH: '/usr/bin:/bin:/usr/sbin:/sbin', LANG: 'C' }, stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
  const registry = output('/usr/sbin/ioreg', ['-rd1', '-c', 'IOPlatformExpertDevice']);
  const uuid = /"IOPlatformUUID"\s*=\s*"([A-Fa-f0-9-]+)"/.exec(registry)?.[1] || '';
  const boot = /\bsec\s*=\s*([0-9]+)/.exec(output('/usr/sbin/sysctl', ['-n', 'kern.boottime']));
  const observed = { platform: process.platform, arch: process.arch,
    model: output('/usr/sbin/sysctl', ['-n', 'hw.model']), uuid, bootTime: boot ? Number(boot[1]) * 1000 : NaN };
  validateVmIdentity(descriptor, observed);
  privatePath(descriptor.homeRoot);
  assert.equal(os.homedir(), descriptor.homeRoot, 'Guest home mismatch');
  assert.equal(os.userInfo().homedir, descriptor.homeRoot, 'Native guest account home mismatch');
  assert.equal(env.HOME, descriptor.homeRoot, 'Guest HOME mismatch');
  privateDescendant(descriptor.homeRoot, descriptor.sourceRoot);
  privateDescendant(descriptor.homeRoot, descriptor.tempRoot);
  privateDescendant(descriptor.homeRoot, path.dirname(file));
  assert.equal(stat.dev, fs.statSync(descriptor.homeRoot).dev, 'Descriptor must be on the guest home filesystem');
  assert.ok(!within(descriptor.sourceRoot, descriptor.tempRoot) && !within(descriptor.tempRoot, descriptor.sourceRoot)
    && descriptor.sourceRoot !== descriptor.tempRoot, 'Source and work roots must be disjoint');
  assert.ok(!within(descriptor.sourceRoot, file) && !within(descriptor.tempRoot, file), 'Descriptor must be outside mutable work/source roots');
  if (env.CODE_INTELLIGENCE_BUILD_SEQUENCE) assert.equal(env.CODE_INTELLIGENCE_BUILD_SEQUENCE, descriptor.buildSequence);
  const profile = freshProfile(descriptor.sourceRoot, descriptor.homeRoot);
  return Object.freeze({ kind: descriptor.kind, sourceRoot: descriptor.sourceRoot, tempRoot: descriptor.tempRoot,
    revision: descriptor.revision, buildSequence: descriptor.buildSequence, profile,
    evidence: { kind: descriptor.kind, provider: descriptor.provider, imageDigest: descriptor.imageDigest,
      vmUuid: observed.uuid, hardwareModel: observed.model, bootTime: observed.bootTime, descriptorCreatedAt: descriptor.createdAt } });
}
function requireExecutionContext(env = process.env) {
  if (env.NATIVE_ACCEPTANCE_CONTEXT) return localContext(env);
  require('./native-acceptance.cjs').requireHosted(env);
  return Object.freeze({ kind: 'github-hosted', sourceRoot: env.GITHUB_WORKSPACE, tempRoot: env.RUNNER_TEMP,
    revision: env.GITHUB_SHA, buildSequence: env.CODE_INTELLIGENCE_BUILD_SEQUENCE,
    evidence: { kind: 'github-hosted', provider: 'github-actions', event: env.GITHUB_EVENT_NAME } });
}
function claimExecution(context, phase) {
  if (context.kind === 'github-hosted') return;
  assert.ok(['provision', 'acceptance', 'product'].includes(phase));
  privatePath(context.tempRoot);
  if (phase === 'provision') assert.deepEqual(fs.readdirSync(context.tempRoot), [], 'Fresh provisioning work root required');
  fs.writeFileSync(path.join(context.tempRoot, '.native-' + phase + '-claimed'), context.revision + '\n', { flag: 'wx', mode: 0o600 });
}
function productPaths(context, { source, owned, artifacts }) {
  if (context.kind === 'github-hosted') return;
  privateDescendant(context.tempRoot, owned);
  privateDescendant(owned, source);
  privateDescendant(context.tempRoot, artifacts);
  assert.equal(freshProfile(source, os.homedir()), context.profile, 'Copied product identity mismatch');
}
function prepareArtifacts(context) {
  const directory = path.join(context.tempRoot, 'native-acceptance-artifacts');
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  if (context.kind !== 'github-hosted') privateDescendant(context.tempRoot, directory);
  return directory;
}
function writeRuntimeEnvironment(context, values, env = process.env) {
  assert.ok(Object.keys(values).every(key => ['PG_CONFIG', 'REDIS_SERVER', 'CODE_INTELLIGENCE_BUILD_SEQUENCE'].includes(key)));
  for (const value of Object.values(values)) assert.ok(typeof value === 'string' && !/[\r\n\0]/.test(value));
  if (context.kind === 'github-hosted') {
    assert.ok(path.isAbsolute(env.GITHUB_ENV || ''));
    fs.appendFileSync(env.GITHUB_ENV, Object.entries(values).map(([key, value]) => `${key}=${value}\n`).join(''));
  } else {
    privatePath(context.tempRoot);
    const quote = value => "'" + value.replaceAll("'", "'\\''") + "'";
    fs.writeFileSync(path.join(context.tempRoot, 'native-runtime.env'), Object.entries(values)
      .map(([key, value]) => `export ${key}=${quote(value)}\n`).join(''), { flag: 'wx', mode: 0o600 });
  }
}
module.exports = { requireExecutionContext, validateVmIdentity, validateLocalEnvironment, privatePath, privateDescendant,
  freshProfile, claimExecution, productPaths, prepareArtifacts, writeRuntimeEnvironment };
