'use strict';

// G-JOB backend race runner. Same isolation contract as run-docker-integration.cjs (fresh
// Testcontainers PostgreSQL/Redis, private test home/temp, no user DB, no Docker pruning), but
// restricted to the job race test classes and optionally given the locally built TypeScript
// analyzer so those tests can start, own and SIGKILL their own analyzer ChildProcess.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');
const { ensureOutputParent, assertOutputPath } = require('./owned-output.cjs');
const { dependencyInventory } = require('../../desktop/scripts/build-isolated.cjs');
const { runOwnedCommand } = require('./owned-test-process.cjs');
const { testEnvironment } = require('./run-docker-integration.cjs');
const hash = file => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const ALLOWED = /^dev\.codeintelligence\.job\.(?:JobPipelineRaceIntegrationTest|JobAnalyzerWorkerRaceIntegrationTest)(?:\.[A-Za-z0-9_*]+)?$/;

function argumentsFor(argv) {
  assert(Array.isArray(argv) && argv.length >= 4 && argv[0] === '--socket', 'JOB_RACE_ARGUMENTS');
  const endpoint = argv[1];
  assert(endpoint === 'unix://' + path.join(os.homedir(), '.docker/run/docker.sock') || endpoint === 'unix:///var/run/docker.sock', 'LOCAL_DOCKER_REQUIRED');
  const tests = []; let analyzer = false;
  for (let index = 2; index < argv.length; index++) {
    if (argv[index] === '--with-analyzer' && !analyzer) { analyzer = true; continue; }
    assert(argv[index] === '--tests' && ALLOWED.test(argv[index + 1] || ''), 'JOB_RACE_TEST_REFUSED');
    tests.push(argv[++index]);
  }
  assert(tests.length > 0 && tests.length <= 8, 'JOB_RACE_TEST_REQUIRED');
  return { endpoint, tests, analyzer };
}

async function main(argv = process.argv.slice(2)) {
  const { endpoint, tests, analyzer } = argumentsFor(argv);
  assert.equal(process.platform, 'darwin'); process.umask(0o077);
  const repo = fs.realpathSync(path.resolve(__dirname, '../..'));
  const parent = ensureOutputParent(repo, 'validation/local/job-race');
  const root = fs.mkdtempSync(path.join(parent, 'backend-'));
  const temporary = fs.mkdtempSync(path.join(repo, '.citd-'));
  assert.equal(fs.realpathSync(temporary), temporary);
  for (const name of ['home', 'tmp', 'docker', 'data']) fs.mkdirSync(path.join(root, name), { mode: 0o700 });
  const env = testEnvironment(root, endpoint, os.homedir());
  env.CI_DOCKER_TEST_TMP = temporary; env.CI_DOCKER_TEST_SUITE = 'job-race';
  fs.writeFileSync(path.join(root, 'docker/config.json'), '{}\n', { flag: 'wx', mode: 0o600 });
  const docker = args => execFileSync('docker', args, { env, encoding: 'utf8', timeout: 10000, maxBuffer: 1024 * 1024 });
  const containers = () => docker(['ps', '-a', '--no-trunc', '--format', '{{json .}}']).trim().split('\n').filter(Boolean)
    .map(line => { const row = JSON.parse(line); assert(/^[a-f0-9]{64}$/.test(row.ID)); return { id: row.ID, state: row.State }; });
  const before = containers();
  const sources = () => Object.fromEntries(['backend/src/main', 'backend/src/test'].map(name => [name, dependencyInventory(path.join(repo, name)).sha256]));
  const analyzerDir = path.join(repo, 'analyzers/ts-analyzer');
  const report = { format: 1, status: 'RUNNING', suite: 'job-race', tests, analyzer, root, temporary,
    startedAt: new Date().toISOString(), dockerVersion: docker(['info', '--format', '{{.ServerVersion}}']).trim(),
    sources: sources(), driverSha256: hash(__filename), initSha256: hash(path.join(__dirname, 'docker-integration.init.gradle')),
    jobRaceInitSha256: hash(path.join(__dirname, 'job-race.init.gradle')),
    baseCommit: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repo, encoding: 'utf8' }).trim(),
    realGithub: false, paidAI: false, preexistingContainers: before.length, commands: [] };
  const save = () => fs.writeFileSync(assertOutputPath(root, path.join(root, 'result.json')), JSON.stringify(report, null, 2) + '\n', { mode: 0o600 });
  save(); console.log(JSON.stringify({ status: 'RUNNING', evidence: root }));
  async function command(label, executable, args, cwd, childEnv, timeout = 1800000) {
    const fd = fs.openSync(path.join(root, label + '.log'), 'wx', 0o600); let result;
    try { result = await runOwnedCommand(executable, args, { cwd, env: childEnv, stdio: ['ignore', fd, fd] }, { timeoutMs: timeout }); }
    finally { fs.closeSync(fd); }
    report.commands.push({ label, exit: result.status, ...result }); save();
    return result;
  }
  try {
    const gradleEnv = { ...env };
    if (analyzer) {
      const compile = await command('analyzer-build', process.execPath,
        [path.join(analyzerDir, 'node_modules/typescript/bin/tsc'), '-p', 'tsconfig.json'], analyzerDir, env, 120000);
      assert.equal(compile.status, 0, 'ANALYZER_BUILD_FAILED');
      gradleEnv.CI_JOB_RACE_NODE = process.execPath; gradleEnv.CI_JOB_RACE_TS_ANALYZER = analyzerDir;
      report.analyzerDistSha256 = dependencyInventory(path.join(analyzerDir, 'dist')).sha256;
    }
    const args = ['--offline', '--no-daemon', '--console=plain', '--max-workers=2',
      '-I', path.join(__dirname, 'docker-integration.init.gradle'), '-I', path.join(__dirname, 'job-race.init.gradle'),
      'spotlessCheck', 'test', ...tests.flatMap(test => ['--tests', test])];
    const execution = await command('gradle', path.join(repo, 'backend/gradlew'), args, path.join(repo, 'backend'), gradleEnv);
    report.execution = { exit: execution.status, signal: execution.signal };
    const totals = path.join(root, 'test-totals.json');
    if (fs.existsSync(totals)) report.totals = JSON.parse(fs.readFileSync(totals));
    assert.equal(execution.status, 0, 'GRADLE_VERIFICATION_FAILED'); assert.equal(execution.timedOut, false);
    assert(report.totals?.tests > 0 && report.totals.fail === 0, 'TEST_RESULTS_REQUIRED');
    report.status = report.totals.skipped ? 'PASS_EXECUTED_WITH_EXPLICIT_SKIPS' : 'PASS';
  } catch (error) { report.status = 'FAIL'; report.failure = { code: error?.code === 'ERR_ASSERTION' ? String(error.message).split('\n')[0] : 'VERIFICATION_FAILED' }; }
  finally {
    try {
      assert.deepEqual(sources(), report.sources); report.sourcesUnchanged = true;
      const previous = new Set(before.map(row => row.id));
      let after = containers();
      for (let attempt = 0; attempt < 20 && after.some(row => !previous.has(row.id)); attempt++) { await delay(1000); after = containers(); }
      const old = new Map(after.map(row => [row.id, row.state]));
      report.preexistingContainersUnchanged = before.every(row => old.get(row.id) === row.state);
      // Other agents' concurrent Testcontainers runs can appear here; presence is observed only.
      report.newContainersRemaining = after.filter(row => !previous.has(row.id)).length;
      if (report.newContainersRemaining || !report.preexistingContainersUnchanged) report.containerCleanupUnconfirmed = true;
    } catch { report.finalVerificationFailed = true; }
    try { fs.rmSync(temporary, { recursive: true, force: true }); report.temporaryRemoved = true; } catch { report.temporaryRemoved = false; }
    report.finishedAt = new Date().toISOString(); save();
  }
  console.log(JSON.stringify({ status: report.status, evidence: root, totals: report.totals }));
  if (!['PASS', 'PASS_EXECUTED_WITH_EXPLICIT_SKIPS'].includes(report.status)) process.exitCode = 1;
  return report;
}
module.exports = { argumentsFor, main };
if (require.main === module) main().catch(() => { console.error('JOB_RACE_BACKEND_REFUSED'); process.exitCode = 1; });
