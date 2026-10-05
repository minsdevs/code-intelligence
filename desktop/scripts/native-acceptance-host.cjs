'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync, spawnSync } = require('node:child_process');

function run(command, args, options) {
  const result = spawnSync(command, args, { ...options, stdio: 'inherit' });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`HOST_ACCEPTANCE_COMMAND_FAILED:${path.basename(command)}:${result.status}`);
}

function javaMajor(home) {
  try {
    if (typeof home !== 'string' || !path.isAbsolute(home)) return null;
    const canonical = fs.realpathSync(home), java = path.join(canonical, 'bin', 'java');
    const result = spawnSync(java, ['-version'], { encoding: 'utf8', timeout: 10000,
      env: { PATH: '/usr/bin:/bin:/usr/sbin:/sbin', LANG: 'C' }, stdio: ['ignore', 'pipe', 'pipe'] });
    const match = /version "([0-9]+)(?:\.|\")/.exec((result.stdout || '') + (result.stderr || ''));
    return result.status === 0 && match ? { major: Number(match[1]), home: canonical } : null;
  } catch { return null; }
}
function selectAdoptiumPackage(payload) {
  assert.ok(Array.isArray(payload) && payload.length > 0 && payload.length <= 16, 'Invalid Adoptium response');
  const asset = payload.find(item => item?.vendor === 'eclipse' && item?.version?.major === 21
    && item?.binary?.architecture === 'aarch64' && item.binary.os === 'mac'
    && item.binary.image_type === 'jdk' && item.binary.jvm_impl === 'hotspot');
  const pkg = asset?.binary?.package;
  assert.ok(pkg && typeof pkg === 'object');
  assert.match(pkg.name || '', /^[A-Za-z0-9._+-]+\.tar\.gz$/);
  assert.match(pkg.checksum || '', /^[a-f0-9]{64}$/);
  const link = new URL(pkg.link);
  assert.equal(link.protocol, 'https:'); assert.equal(link.hostname, 'github.com');
  assert.ok(!link.username && !link.password && !link.search && !link.hash);
  return Object.freeze({ name: pkg.name, checksum: pkg.checksum, link: link.href });
}
function resolveJavaHome(root, commandEnvironment) {
  for (const candidate of [process.env.JAVA_HOME, (() => {
    try { return execFileSync('/usr/libexec/java_home', ['-v', '21'], { encoding: 'utf8', timeout: 5000,
      env: commandEnvironment, stdio: ['ignore', 'pipe', 'pipe'] }).trim(); } catch { return null; }
  })()]) {
    const observed = javaMajor(candidate);
    if (observed?.major === 21) return observed.home;
  }
  const api = 'https://api.adoptium.net/v3/assets/latest/21/hotspot?architecture=aarch64&image_type=jdk&os=mac&vendor=eclipse';
  const networkEnvironment = { ...commandEnvironment };
  for (const key of ['HTTP_PROXY', 'HTTPS_PROXY', 'NO_PROXY', 'http_proxy', 'https_proxy', 'no_proxy']) {
    if (process.env[key]) networkEnvironment[key] = process.env[key];
  }
  const response = execFileSync('/usr/bin/curl', ['-fsSL', '--max-time', '60', api], {
    encoding: 'utf8', timeout: 70000, maxBuffer: 2 * 1024 * 1024,
    env: networkEnvironment, stdio: ['ignore', 'pipe', 'pipe'],
  });
  const pkg = selectAdoptiumPackage(JSON.parse(response));
  const toolchain = path.join(root, 'toolchain'), destination = path.join(toolchain, 'jdk');
  fs.mkdirSync(toolchain, { mode: 0o700 }); fs.mkdirSync(destination, { mode: 0o700 });
  const archive = path.join(toolchain, pkg.name);
  run('/usr/bin/curl', ['-fL', '--max-time', '600', '--output', archive, pkg.link], { env: networkEnvironment });
  const digest = execFileSync('/usr/bin/shasum', ['-a', '256', archive], {
    encoding: 'utf8', timeout: 120000, env: commandEnvironment, stdio: ['ignore', 'pipe', 'pipe'],
  }).trim().split(/\s+/)[0];
  assert.equal(digest, pkg.checksum, 'Temurin JDK checksum mismatch');
  run('/usr/bin/tar', ['-xzf', archive, '--strip-components=1', '-C', destination], { env: commandEnvironment });
  fs.unlinkSync(archive);
  const observed = javaMajor(path.join(destination, 'Contents', 'Home'));
  assert.equal(observed?.major, 21, 'Downloaded JDK 21 did not identify as Java 21');
  return observed.home;
}

function main(argv = process.argv.slice(2)) {
  assert.deepEqual(argv, [], 'Host acceptance does not accept path or identity overrides');
  assert.equal(process.platform, 'darwin'); assert.equal(process.arch, 'arm64');
  assert.ok(typeof process.getuid === 'function' && process.getuid() > 0, 'Host acceptance must not run as root');
  process.umask(0o077);
  const sourceRoot = fs.realpathSync(path.resolve(__dirname, '../..'));
  // Fail before creating a run, downloading a JDK, fetching sources or starting compilers.
  const { requireCapacity } = require('./macos-runtime-supply.cjs');
  requireCapacity(sourceRoot);
  requireCapacity(fs.realpathSync(os.tmpdir()));
  const root = fs.realpathSync(fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'codeintel-host-acceptance-')));
  fs.chmodSync(root, 0o700);
  const isolatedRunParent = fs.realpathSync(fs.mkdtempSync('/private/tmp/civa-'));
  fs.chmodSync(isolatedRunParent, 0o700);
  const tempRoot = path.join(root, 'work'), controlRoot = path.join(root, 'control');
  fs.mkdirSync(tempRoot, { mode: 0o700 }); fs.mkdirSync(controlRoot, { mode: 0o700 });
  const commandEnvironment = { PATH: '/usr/bin:/bin:/usr/sbin:/sbin', LANG: 'C' };
  const revision = execFileSync('/usr/bin/git', ['-C', sourceRoot, 'rev-parse', 'HEAD'], {
    encoding: 'utf8', timeout: 5000, env: commandEnvironment, stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
  assert.match(revision, /^[a-f0-9]{40,64}$/);
  const buildSequence = String(Date.now());
  const createdAt = new Date(), expiresAt = new Date(createdAt.getTime() + 24 * 60 * 60 * 1000);
  const descriptor = { format: 1, kind: 'isolated-macos-host', provider: 'local-macos', uid: process.getuid(),
    revision, buildSequence, sourceRoot, tempRoot, isolatedRunParent,
    createdAt: createdAt.toISOString(), expiresAt: expiresAt.toISOString() };
  const contextFile = path.join(controlRoot, 'context.json');
  fs.writeFileSync(contextFile, JSON.stringify(descriptor) + '\n', { flag: 'wx', mode: 0o600 });
  const javaHome = resolveJavaHome(root, commandEnvironment);
  const env = { ...process.env };
  // Provisioning supplies its own locked extension; do not overlay a previous developer build.
  delete env.PGVECTOR_ROOT;
  for (const key of Object.keys(env)) if (/^(?:GITHUB_|RUNNER_|DYLD_|CODE_INTELLIGENCE_ISOLATED_)/.test(key)
      || ['NODE_OPTIONS', 'NODE_PATH', 'ELECTRON_RUN_AS_NODE', 'ELECTRON_EXTRA_LAUNCH_ARGS',
        'NATIVE_ACCEPTANCE_CONSENT'].includes(key)) delete env[key];
  Object.assign(env, { NATIVE_ACCEPTANCE_CONTEXT: contextFile, CODE_INTELLIGENCE_BUILD_SEQUENCE: buildSequence,
    JAVA_HOME: javaHome, PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD: '1' });
  console.log(JSON.stringify({ status: 'RUNNING', phase: 'source-provisioning', root, isolatedRunParent,
    artifacts: path.join(tempRoot, 'native-acceptance-artifacts') }));
  run('/bin/bash', [path.join(sourceRoot, 'desktop', 'scripts', 'native-acceptance-macos.sh')], { cwd: sourceRoot, env });
  const runtimeEnvironment = path.join(tempRoot, 'native-runtime.env');
  const acceptance = path.join(sourceRoot, 'desktop', 'scripts', 'native-acceptance.cjs');
  run('/bin/bash', ['-c', '. "$1"; exec "$2" "$3" macos', 'host-acceptance', runtimeEnvironment, process.execPath, acceptance],
    { cwd: sourceRoot, env });
  console.log(JSON.stringify({ status: 'PASS', root, isolatedRunParent,
    artifacts: path.join(tempRoot, 'native-acceptance-artifacts') }));
}

if (require.main === module) {
  try { main(); }
  catch (error) { console.error(error?.message || 'HOST_ACCEPTANCE_FAILED'); process.exitCode = 1; }
}
module.exports = { main, selectAdoptiumPackage, javaMajor, resolveJavaHome };
