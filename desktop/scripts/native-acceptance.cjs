'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');

const EXCLUDED = new Set(['node_modules', 'dist', 'stage', '.git', '.gradle', '.repowise', 'test-results', 'playwright-report', 'coverage']);
const ROOTS = ['desktop', 'frontend', 'backend', 'analyzers/ts-analyzer'];
function included(relative) {
  const parts = relative.split(/[\\/]/);
  if (parts.some(part => EXCLUDED.has(part) || part.startsWith('.') || /^(?:secrets|credentials|userData|sessionData)$/i.test(part))) return false;
  if (parts.includes('build') && !(parts[0] === 'desktop' && parts[1] === 'build')) return false;
  return !/\.(?:p12|pfx|pem|key|keystore|log|db)$/i.test(relative);
}
function requireHosted(env = process.env, platform = process.platform, arch = process.arch) {
  assert.equal(env.GITHUB_ACTIONS, 'true', 'Hosted workflow required');
  assert.equal(env.RUNNER_ENVIRONMENT, 'github-hosted', 'Self-hosted machines are prohibited');
  assert.ok(['workflow_dispatch', 'pull_request'].includes(env.GITHUB_EVENT_NAME), 'Manual dispatch or trusted PR required');
  if (env.GITHUB_EVENT_NAME === 'pull_request') {
    assert.ok(path.isAbsolute(env.GITHUB_EVENT_PATH || ''));
    const event = JSON.parse(fs.readFileSync(env.GITHUB_EVENT_PATH, 'utf8'));
    assert.ok(env.GITHUB_REPOSITORY);
    assert.equal(event.pull_request?.head?.repo?.full_name, env.GITHUB_REPOSITORY, 'Fork source is prohibited');
    assert.equal(event.pull_request?.base?.repo?.full_name, env.GITHUB_REPOSITORY, 'Unexpected PR target');
  }
  assert.equal(env.NATIVE_ACCEPTANCE_CONSENT, 'disposable-hosted-os', 'Explicit disposable OS consent required');
  assert.ok((platform === 'darwin' && arch === 'arm64') || (platform === 'win32' && arch === 'x64'));
  assert.match(env.CODE_INTELLIGENCE_BUILD_SEQUENCE || '', /^[1-9][0-9]{0,18}$/);
  assert.ok(BigInt(env.CODE_INTELLIGENCE_BUILD_SEQUENCE) <= 9223372036854775807n);
  assert.match(env.GITHUB_SHA || '', /^[a-f0-9]{40,64}$/);
  for (const key of ['RUNNER_TEMP', 'GITHUB_WORKSPACE']) assert.ok(path.isAbsolute(env[key] || ''));
  for (const key of ['NODE_OPTIONS', 'ELECTRON_RUN_AS_NODE', 'CODE_INTELLIGENCE_ISOLATED_RUN']) assert.ok(!env[key], `Unexpected ${key}`);
}
function copySource(source, destination) {
  assert.ok(!fs.existsSync(destination), 'Source copy must be fresh');
  fs.mkdirSync(destination, { mode: 0o700 });
  const hash = crypto.createHash('sha256'); let count = 0;
  function visit(relative) {
    if (!included(relative)) return;
    const from = path.join(source, relative), to = path.join(destination, relative);
    const stat = fs.lstatSync(from);
    assert.ok(!stat.isSymbolicLink(), 'Source symlinks are not accepted');
    if (stat.isDirectory()) {
      fs.mkdirSync(to, { recursive: true, mode: 0o700 });
      for (const name of fs.readdirSync(from).sort()) visit(path.join(relative, name));
    } else {
      assert.ok(stat.isFile() && stat.nlink === 1 && stat.size <= 16 * 1024 * 1024, 'Unexpected source file');
      const bytes = fs.readFileSync(from);
      fs.writeFileSync(to, bytes, { flag: 'wx', mode: stat.mode & 0o100 ? 0o700 : 0o600 });
      hash.update(relative.split(path.sep).join('/') + '\0').update(bytes); count++;
    }
  }
  for (const root of ROOTS) visit(root);
  return { files: count, sha256: hash.digest('hex') };
}
function run(command, args, cwd, env = process.env) {
  const result = spawnSync(command, args, { cwd, env, encoding: 'utf8', timeout: 35 * 60 * 1000, maxBuffer: 16 * 1024 * 1024, windowsHide: true });
  // Compiler output and runtime logs can include paths, source, URLs or credentials.
  // Keep them out of artifacts and GitHub logs; retain only bounded outcome metadata.
  if (result.status !== 0 || result.error) {
    const error = new Error('NATIVE_ACCEPTANCE_COMMAND_FAILED');
    error.exitStatus = Number.isInteger(result.status) ? result.status : null;
    error.commandEvidence = { executable: path.basename(command), signal: result.signal || null,
      stdoutBytes: Buffer.byteLength(result.stdout || ''), stderrBytes: Buffer.byteLength(result.stderr || '') };
    throw error;
  }
  return result.stdout;
}
function npm(args, cwd, env) {
  if (process.platform === 'win32') {
    // Node distributions provide npm-cli.js next to npm.cmd; avoid shell argument quoting.
    const cli = path.join(path.dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js');
    return run(process.execPath, [cli, ...args], cwd, env);
  }
  return run('npm', args, cwd, env);
}
async function main(target) {
  requireHosted();
  assert.equal(target, process.platform === 'darwin' ? 'macos' : 'windows');
  const artifacts = path.join(process.env.RUNNER_TEMP, 'native-acceptance-artifacts');
  fs.mkdirSync(artifacts, { recursive: true, mode: 0o700 });
  const report = { format: 1, revision: process.env.GITHUB_SHA, platform: process.platform, arch: process.arch,
    buildSequence: process.env.CODE_INTELLIGENCE_BUILD_SEQUENCE, mode: 'unsigned-development-native',
    nodeVersion: process.versions.node, osRelease: require('node:os').release(),
    signedInstallation: false, notarizedInstallation: false, isolatedRunGateChanged: false,
    scope: target === 'windows' ? 'windows-native-boundary-security' : 'macos-native-development-app',
    installationAcceptance: { status: 'BLOCKED', code: 'SIGNING_AND_NOTARIZATION_UNAVAILABLE' },
    status: 'RUNNING', phase: 'fresh-source-copy', checks: [] };
  const save = () => fs.writeFileSync(path.join(artifacts, 'acceptance.json'), JSON.stringify(report, null, 2) + '\n', { mode: 0o600 });
  save();
  try {
    const owned = fs.mkdtempSync(path.join(process.env.RUNNER_TEMP, 'native-acceptance-private-'));
    fs.chmodSync(owned, 0o700);
    const source = path.join(owned, 'source');
    report.source = copySource(process.env.GITHUB_WORKSPACE, source);
    const env = { ...process.env, GRADLE_USER_HOME: path.join(owned, 'gradle'), npm_config_cache: path.join(owned, 'npm-cache'),
      PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD: '1' };
    // No dependency reuse, global npm installs, database URLs or provider credentials.
    for (const key of Object.keys(env)) if (/^(?:GITHUB_TOKEN|GH_TOKEN|OPENAI_|ANTHROPIC_|DATABASE_URL|SPRING_DATASOURCE_|TOKEN_ENC_KEY|PGPASSWORD|REDIS_PASSWORD|AWS_|AZURE_|GOOGLE_APPLICATION_CREDENTIALS)/.test(key)) delete env[key];
    report.phase = 'fresh-dependencies'; save();
    const packages = target === 'macos' ? ['frontend', 'analyzers/ts-analyzer', 'desktop'] : ['desktop'];
    for (const directory of packages) npm(['ci', '--no-audit', '--no-fund'], path.join(source, directory), env);
    report.checks.push('fresh-source-dependencies');
    if (target === 'windows') {
      report.phase = 'standard-user-native-boundaries'; save();
      const { runWindows } = require('./native-acceptance-windows.cjs');
      await runWindows({ source, owned, artifacts, report, run, env });
      report.phase = 'windows-product-readiness-gate'; save();
      // Boundary smoke has its own conclusion. An unchanged product No-Go is not
      // re-labelled as a failed native helper test or bypassed to launch the product.
      let blocked = false;
      try { await require(path.join(source, 'desktop', 'scripts', 'desktop-build-gate.cjs'))({ electronPlatformName: 'win32' }); }
      catch { blocked = true; }
      assert.ok(blocked, 'Windows product gate changed without product acceptance');
      const readiness = require(path.join(source, 'desktop', 'scripts', 'windows-readiness.cjs')).windowsReadiness();
      assert.equal(readiness.status, 'BLOCKED');
      report.productAcceptance = { status: 'BLOCKED', code: 'WINDOWS_PRODUCT_NOT_READY', blockers: readiness.blockers };
      report.checks.push('windows-product-build-gate-remains-enforced');
      report.status = 'PASS'; report.phase = 'native-boundaries-complete'; save();
      console.log('Windows native boundary smoke passed; WINDOWS_PRODUCT_NOT_READY.');
      return;
    }
    report.phase = 'actual-runtime-stage'; save();
    run(process.execPath, ['scripts/stage-runtime.mjs'], path.join(source, 'desktop'), env);
    const manifest = JSON.parse(fs.readFileSync(path.join(source, 'desktop', 'stage', 'runtime', 'runtime-manifest.json'), 'utf8'));
    assert.equal(String(manifest.buildSequence), report.buildSequence);
    assert.equal(manifest.platform, 'darwin'); assert.equal(manifest.arch, 'arm64');
    report.runtimeManifestSha256 = crypto.createHash('sha256').update(JSON.stringify(manifest)).digest('hex');
    report.checks.push('current-source-runtime-stage');
    await require(path.join(source, 'desktop', 'scripts', 'desktop-build-gate.cjs'))({ electronPlatformName: 'darwin' });
    report.phase = 'real-electron-safe-storage-restart'; save();
    const { runMac } = require('./native-acceptance-electron.cjs');
    await runMac({ source, owned, artifacts, report, env, phase: name => { report.phase = name; save(); } });
    report.status = 'PASS'; report.phase = 'complete';
  } catch (error) {
    report.status = 'FAIL'; report.failure = { category: error.name === 'AssertionError' ? 'assertion' : 'native-step-failed',
      code: /^[A-Z][A-Z0-9_]{2,63}$/.test(error.message || '') ? error.message
        : /^[A-Z][A-Z0-9_]{2,63}$/.test(error.code || '') ? error.code
          : error.name === 'TimeoutError' ? 'NATIVE_UI_TIMEOUT' : 'NATIVE_ACCEPTANCE_STEP_FAILED',
      phase: report.phase,
      exitStatus: Number.isInteger(error.exitStatus) ? error.exitStatus : null, command: error.commandEvidence || null };
    process.exitCode = 1;
  } finally { save(); }
  console.log(`Native acceptance: ${report.status}; phase=${report.phase}. Only credential-free evidence was retained.`);
}
if (require.main === module) main(process.argv[2]).catch(() => { console.error('Native acceptance preflight refused.'); process.exitCode = 1; });
module.exports = { included, requireHosted, copySource, run, main };
