'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, '../scripts/build-isolated-backend.cjs'), 'utf8');
const jarBytes = Buffer.from([0x50, 0x4b, 3, 4, 0x66, 0x61, 0x6b, 0x65]);

function write(root, relative, bytes, mode = 0o600) {
  const file = path.join(root, relative);
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  fs.writeFileSync(file, bytes, { mode });
  return file;
}

function fixture(t, options = {}) {
  const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'ci-backend-build-unit-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const calls = []; const copies = []; const checks = [];
  const sourceRoot = path.join(root, 'source'); const workRoot = path.join(root, 'work'); const outputRoot = path.join(root, 'output');
  const paths = Object.fromEntries(['home', 'temp', 'gradleHome'].map(name => [name, path.join(root, name)]));
  for (const directory of [sourceRoot, workRoot, outputRoot, ...Object.values(paths)]) fs.mkdirSync(directory, { mode: 0o700 });
  fs.mkdirSync(path.join(workRoot, 'backend'), { mode: 0o700 });
  write(workRoot, 'frontend/dist/index.html', '<!doctype html><title>Synthetic fresh UI</title>');
  write(sourceRoot, 'backend/gradle/wrapper/gradle-wrapper.properties',
    `distributionUrl=https\\://services.gradle.org/distributions/gradle-${options.wrapperVersion || '9.7.0'}-bin.zip\n`);
  const javaHome = path.join(root, 'jdk');
  write(javaHome, 'release', `JAVA_VERSION="${options.javaVersion || '21.0.8'}"\n`);
  const java = write(javaHome, 'bin/java', 'synthetic non-launchable Java fixture\n', 0o700);
  const gradleDistribution = path.join(root, 'gradle-9.7.0');
  write(gradleDistribution, 'lib/gradle-gradle-cli-main-9.7.0.jar', jarBytes);
  write(gradleDistribution, 'lib/agents/gradle-instrumentation-agent-9.7.0.jar', jarBytes);
  write(gradleDistribution, 'init.d/readme.txt', 'synthetic distribution readme');
  if (options.maliciousInit) write(gradleDistribution, 'init.d/injected.gradle', 'throw new RuntimeException("must never execute")');
  const gradleModulesCache = path.join(root, 'modules-2');
  write(gradleModulesCache, 'files-2.1/synthetic/dependency/1/dependency.jar', jarBytes);
  const plan = { root, sourceRoot, workRoot, outputRoot, paths,
    assertIdentity() { checks.push('identity'); },
    childEnvironment() { return { PATH: '/synthetic/tool-path', HOME: paths.home, TMPDIR: paths.temp,
      TMP: paths.temp, TEMP: paths.temp, GRADLE_USER_HOME: paths.gradleHome }; } };
  const copyPrivateTree = (_plan, from, to, copyOptions) => {
    assert.equal(_plan, plan); copies.push({ from, to, options: copyOptions });
    fs.mkdirSync(path.dirname(to), { recursive: true, mode: 0o700 });
    fs.cpSync(from, to, { recursive: true, errorOnExist: true, force: false });
    return { source: from, destination: to, synthetic: true };
  };
  const context = vm.createContext({ module: { exports: {} }, Buffer,
    process: { env: process.env }, require(name) {
      if (name !== 'node:child_process') return require(name);
      return { spawnSync(command, args, config) {
        calls.push({ command, args, config });
        fs.writeSync(config.stdio[1], 'synthetic Gradle output\n');
        if (options.status) return { status: options.status, signal: null };
        write(workRoot, 'backend/build/libs/synthetic-backend.jar', jarBytes);
        return { status: 0, signal: null };
      } };
    } });
  vm.runInContext(source, context);
  return { root, plan, java, calls, copies, checks, inputs: { javaHome, gradleDistribution, gradleModulesCache },
    run: () => context.module.exports.buildBackend(plan, { javaHome, gradleDistribution, gradleModulesCache }, copyPrivateTree) };
}

test('backend build uses explicit Java, offline Gradle and private JVM homes without inheriting host secrets', t => {
  const f = fixture(t);
  const previous = process.env.GITHUB_TOKEN;
  const previousJavaOptions = process.env.JAVA_TOOL_OPTIONS;
  let result;
  try {
    process.env.GITHUB_TOKEN = 'synthetic-host-token-must-not-leak';
    process.env.JAVA_TOOL_OPTIONS = '-Dsynthetic.host.secret=must-not-leak';
    result = f.run();
  } finally {
    if (previous === undefined) delete process.env.GITHUB_TOKEN; else process.env.GITHUB_TOKEN = previous;
    if (previousJavaOptions === undefined) delete process.env.JAVA_TOOL_OPTIONS; else process.env.JAVA_TOOL_OPTIONS = previousJavaOptions;
  }
  assert.equal(f.calls.length, 1); assert.equal(f.copies.length, 2);
  const { command, args, config } = f.calls[0];
  assert.equal(command, f.java); assert.equal(config.shell, false);
  assert.equal(config.cwd, path.join(f.plan.workRoot, 'backend'));
  assert.ok(args.includes('--offline')); assert.ok(args.includes('--no-daemon'));
  assert.ok(args.includes('-Dorg.gradle.java.installations.auto-download=false'));
  assert.ok(args.includes('-Dorg.gradle.java.installations.auto-detect=false'));
  for (const option of [`-Duser.home=${f.plan.paths.home}`, `-Djava.io.tmpdir=${f.plan.paths.temp}`]) {
    assert.ok(args.includes(option)); assert.ok(config.env.JAVA_TOOL_OPTIONS.includes(`"${option}"`));
  }
  assert.equal(config.env.JAVA_HOME, f.inputs.javaHome);
  assert.equal(config.env.GRADLE_USER_HOME, f.plan.paths.gradleHome);
  assert.equal(config.env.GITHUB_TOKEN, undefined);
  assert.equal(JSON.stringify(config.env).includes('must-not-leak'), false);
  assert.equal(f.copies[1].to, path.join(f.plan.paths.gradleHome, 'caches/modules-2'));
  assert.equal(f.copies[1].options.skipLocks, true);
  assert.equal(fs.readFileSync(f.java, 'utf8'), 'synthetic non-launchable Java fixture\n');
  assert.equal(result.status, 'BACKEND_BOOTJAR_PASSED'); assert.equal(result.javaMajor, 21);
  assert.equal(result.gradleVersion, '9.7.0'); assert.equal(result.offline, true);
  assert.equal(result.bootJarSha256, crypto.createHash('sha256').update(jarBytes).digest('hex'));
  assert.equal(result.frontendArchiveReadbackVerified, false);
  assert.equal(result.backendStarted, false); assert.equal(result.launchAllowed, false);
  assert.equal(fs.statSync(result.logPath).mode & 0o777, 0o600);
  assert.equal(fs.readFileSync(result.logPath, 'utf8'), 'synthetic Gradle output\n');
});

test('wrong Java or Gradle distribution versions refuse before dependency copies or Java invocation', t => {
  for (const [options, code] of [
    [{ javaVersion: '17.0.12' }, 'BACKEND_BUILD_JAVA_21_REQUIRED'],
    [{ wrapperVersion: '9.6.0' }, 'BACKEND_BUILD_DISTRIBUTION_INVALID'],
    [{ wrapperVersion: 'not-a-version' }, 'BACKEND_BUILD_GRADLE_VERSION_INVALID'],
  ]) {
    const f = fixture(t, options);
    assert.throws(f.run, { code });
    assert.equal(f.copies.length, 0); assert.equal(f.calls.length, 0);
    assert.deepEqual(fs.readdirSync(f.plan.outputRoot), []);
  }
});

test('a copied distribution init script is rejected before any Java invocation', t => {
  const f = fixture(t, { maliciousInit: true });
  assert.throws(f.run, { code: 'BACKEND_BUILD_INIT_SCRIPT_REFUSED' });
  assert.equal(f.copies.length, 2); assert.equal(f.calls.length, 0);
  assert.deepEqual(fs.readdirSync(f.plan.outputRoot), []);
  assert.equal(fs.readFileSync(path.join(f.inputs.gradleDistribution, 'init.d/injected.gradle'), 'utf8'),
    'throw new RuntimeException("must never execute")');
});

test('a failed Gradle child retains the private build log and returns a typed failure', t => {
  const f = fixture(t, { status: 9 });
  assert.throws(f.run, { code: 'BACKEND_BUILD_BOOTJAR_FAILED' });
  assert.equal(f.calls.length, 1);
  const log = path.join(f.plan.outputRoot, 'backend-build.log');
  assert.equal(fs.statSync(log).mode & 0o777, 0o600);
  assert.equal(fs.readFileSync(log, 'utf8'), 'synthetic Gradle output\n');
  assert.equal(fs.existsSync(path.join(f.plan.workRoot, 'backend/build/libs')), false);
  assert.ok(f.checks.length >= 3);
});
