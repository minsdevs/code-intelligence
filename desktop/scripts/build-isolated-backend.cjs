'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');

function refuse(code) { const error = new Error(code); error.code = code; throw error; }
const stamp = stat => [stat.dev, stat.ino, stat.mode, stat.nlink, stat.size, stat.mtimeMs, stat.ctimeMs].join(':');
function directory(value) {
  if (typeof value !== 'string' || !path.isAbsolute(value) || path.normalize(value) !== value
      || /[\x00-\x1f\x7f"'\\]/.test(value) || fs.realpathSync(value) !== value
      || !fs.lstatSync(value).isDirectory()) refuse('BACKEND_BUILD_PATH_INVALID');
  return value;
}
function readRegular(file, maximum) {
  const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
  try {
    const before = fs.fstatSync(fd);
    if (!before.isFile() || before.nlink !== 1 || before.size > maximum) refuse('BACKEND_BUILD_FILE_INVALID');
    const bytes = Buffer.alloc(before.size + 1);
    let used = 0;
    while (used < bytes.length) {
      const count = fs.readSync(fd, bytes, used, bytes.length - used, used);
      if (!count) break;
      used += count;
    }
    if (used !== before.size || stamp(before) !== stamp(fs.fstatSync(fd))
        || stamp(before) !== stamp(fs.lstatSync(file))) refuse('BACKEND_BUILD_INPUT_CHANGED');
    return bytes.subarray(0, used);
  } finally { fs.closeSync(fd); }
}

// Only explicit distribution/modules inputs are copied. Never import a user's Gradle
// home, init scripts, properties, credentials, daemon state or global Java options.
function buildBackend(plan, { javaHome, gradleDistribution, gradleModulesCache }, copyPrivateTree) {
  plan.assertIdentity();
  if (typeof copyPrivateTree !== 'function') refuse('BACKEND_BUILD_COPY_REQUIRED');
  javaHome = directory(javaHome);
  if (javaHome.includes(',')) refuse('BACKEND_BUILD_PATH_INVALID');
  gradleDistribution = directory(gradleDistribution);
  gradleModulesCache = directory(gradleModulesCache);
  for (const own of [plan.workRoot, plan.outputRoot, plan.paths.home, plan.paths.temp, plan.paths.gradleHome]) directory(own);
  if (path.basename(gradleModulesCache) !== 'modules-2') refuse('BACKEND_BUILD_CACHE_INVALID');
  const release = readRegular(path.join(javaHome, 'release'), 65536).toString('utf8');
  if (!/^JAVA_VERSION="21(?:\.[^"\r\n]*)?"$/m.test(release)) refuse('BACKEND_BUILD_JAVA_21_REQUIRED');
  const java = path.join(javaHome, 'bin', 'java');
  const javaStat = fs.lstatSync(java);
  if (!javaStat.isFile() || javaStat.isSymbolicLink() || !(javaStat.mode & 0o111)) refuse('BACKEND_BUILD_JAVA_INVALID');
  const javaIdentity = stamp(javaStat);
  const wrapper = readRegular(path.join(plan.sourceRoot, 'backend', 'gradle', 'wrapper', 'gradle-wrapper.properties'), 16384).toString('utf8');
  const versions = [...wrapper.matchAll(/^distributionUrl=https\\:\/\/services\.gradle\.org\/distributions\/gradle-([0-9]+\.[0-9]+\.[0-9]+)-bin\.zip\r?$/gm)];
  if (versions.length !== 1) refuse('BACKEND_BUILD_GRADLE_VERSION_INVALID');
  const version = versions[0][1];
  if (path.basename(gradleDistribution) !== `gradle-${version}`) refuse('BACKEND_BUILD_DISTRIBUTION_INVALID');
  const launcherName = `gradle-gradle-cli-main-${version}.jar`;
  const agentName = `gradle-instrumentation-agent-${version}.jar`;
  const backend = path.join(plan.workRoot, 'backend');
  directory(backend);
  // bootJar copies this newly compiled frontend; never build against an absent UI.
  readRegular(path.join(plan.workRoot, 'frontend', 'dist', 'index.html'), 1024 * 1024);
  const copiedDistribution = path.join(plan.workRoot, 'build-tools', 'gradle');
  const dependencies = [
    copyPrivateTree(plan, gradleDistribution, copiedDistribution),
    copyPrivateTree(plan, gradleModulesCache, path.join(plan.paths.gradleHome, 'caches', 'modules-2'), { skipLocks: true }),
  ];
  const launcher = path.join(copiedDistribution, 'lib', launcherName);
  const agent = path.join(copiedDistribution, 'lib', 'agents', agentName);
  readRegular(launcher, 32 * 1024 * 1024);
  readRegular(agent, 32 * 1024 * 1024);
  // A distribution's init.d executes before the project: reject custom init scripts,
  // even though the selected cache excludes the user's own init.d and properties.
  const init = path.join(copiedDistribution, 'init.d');
  if (fs.existsSync(init) && fs.readdirSync(init).some(name => name !== 'readme.txt')) refuse('BACKEND_BUILD_INIT_SCRIPT_REFUSED');
  if (fs.existsSync(path.join(copiedDistribution, 'gradle.properties'))) refuse('BACKEND_BUILD_INIT_SCRIPT_REFUSED');
  const properties = [`-Duser.home=${plan.paths.home}`, `-Djava.io.tmpdir=${plan.paths.temp}`];
  const env = { ...plan.childEnvironment(), JAVA_HOME: javaHome,
    // The JVM parses these quoted tokens itself; no shell evaluates their contents.
    // Inherited options cover Gradle's single-use daemon and compiler worker JVMs.
    JAVA_TOOL_OPTIONS: properties.map(value => `"${value}"`).join(' ') };
  const args = ['-Xmx64m', '-Xms64m', ...properties, `-javaagent:${agent}`, '-Dorg.gradle.appname=isolated-gradle',
    '-jar', launcher, '--offline', '--no-daemon', '--max-workers=2', '--console=plain',
    `-Dorg.gradle.java.home=${javaHome}`, '-Dorg.gradle.java.installations.auto-download=false',
    '-Dorg.gradle.java.installations.auto-detect=false', `-Dorg.gradle.java.installations.paths=${javaHome}`,
    '-Porg.gradle.java.installations.auto-download=false', '-Porg.gradle.java.installations.auto-detect=false',
    `-Porg.gradle.java.installations.paths=${javaHome}`, 'bootJar'];
  const logPath = path.join(plan.outputRoot, 'backend-build.log');
  plan.assertIdentity();
  const fd = fs.openSync(logPath, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, 0o600);
  let result;
  try { result = spawnSync(java, args, { cwd: backend, env, shell: false, stdio: ['ignore', fd, fd] }); }
  finally { fs.closeSync(fd); }
  plan.assertIdentity();
  if (stamp(fs.lstatSync(java)) !== javaIdentity) refuse('BACKEND_BUILD_JAVA_CHANGED');
  if (result.error || result.signal || result.status !== 0) refuse('BACKEND_BUILD_BOOTJAR_FAILED');
  const libs = path.join(backend, 'build', 'libs');
  directory(libs);
  const jars = fs.readdirSync(libs).filter(name => name.endsWith('.jar') && !name.endsWith('-plain.jar'));
  if (jars.length !== 1) refuse('BACKEND_BUILD_JAR_INVALID');
  const bootJar = path.join(libs, jars[0]);
  const bytes = readRegular(bootJar, 512 * 1024 * 1024);
  if (!bytes.subarray(0, 4).equals(Buffer.from([0x50, 0x4b, 3, 4]))) refuse('BACKEND_BUILD_JAR_INVALID');
  const bootJarSha256 = crypto.createHash('sha256').update(bytes).digest('hex');
  plan.assertIdentity();
  return { status: 'BACKEND_BOOTJAR_PASSED', javaMajor: 21, gradleVersion: version, offline: true,
    bootJar, bootJarSha256, logPath, dependencies, frontendArchiveReadbackVerified: false,
    backendStarted: false, launchAllowed: false };
}

module.exports = { buildBackend };
