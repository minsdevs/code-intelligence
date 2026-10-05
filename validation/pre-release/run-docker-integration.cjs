'use strict';

// Explicit local Docker/Testcontainers verification. Never starts/stops the daemon,
// reuses a user DB, prunes Docker, or reads application/provider credentials.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const { spawn, execFileSync } = require('node:child_process');
const { ensureOutputParent, assertOutputPath } = require('./owned-output.cjs');
const { dependencyInventory } = require('../../desktop/scripts/build-isolated.cjs');
const { runOwnedCommand, stopOwned } = require('./owned-test-process.cjs');
const { evaluateQualityMetrics } = require('./quality-metrics.cjs');
const hash = file => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const suites = Object.freeze({
  auth: ['test', '--tests', 'dev.codeintelligence.AuthIntegrationTest', '--tests', 'dev.codeintelligence.OAuthEnabledIntegrationTest'],
  backend: ['test'],
  events: ['test', '--tests', 'dev.codeintelligence.job.JobSse*Test'],
  maintenance: ['test', '--tests', 'dev.codeintelligence.maintenance.MaintenanceApiIntegrationTest'],
  accuracy: ['accuracyTest'],
  corpus: ['test', ...['FixtureGoldenTest', 'SpringMiniGraphGoldenTest', 'SpringMiniEndpointsFeaturesGoldenTest',
    'ReactMiniTsParsingGoldenTest', 'FullstackCrossDomainGoldenTest', 'ConfigAnalyzersGoldenTest'].flatMap(t => ['--tests', '*' + t])],
});
function argumentsFor(argv) {
  assert(Array.isArray(argv) && argv.length === 4 && argv[0] === '--suite' && Object.hasOwn(suites, argv[1])
    && argv[2] === '--socket' && typeof argv[3] === 'string', 'DOCKER_TEST_ARGUMENTS');
  assert(argv[3] === 'unix://' + path.join(os.homedir(), '.docker/run/docker.sock') || argv[3] === 'unix:///var/run/docker.sock', 'LOCAL_DOCKER_REQUIRED');
  return { suite: argv[1], endpoint: argv[3] };
}
function testEnvironment(root, endpoint, home) {
  assert(path.isAbsolute(root) && path.normalize(root) === root);
  assert(endpoint === 'unix://' + path.join(home, '.docker/run/docker.sock') || endpoint === 'unix:///var/run/docker.sock', 'LOCAL_DOCKER_REQUIRED');
  return { PATH: '/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin', HOME: home, LANG: 'C', LC_ALL: 'C',
    DOCKER_HOST: endpoint, DOCKER_CONFIG: path.join(root, 'docker'), CI_DOCKER_TEST_ROOT: root,
    TESTCONTAINERS_REUSE_ENABLE: 'false', TESTCONTAINERS_RYUK_DISABLED: 'false', TESTCONTAINERS_CHECKS_DISABLE: 'false' };
}
function countCorpusFiles(inventory) {
  assert(Array.isArray(inventory?.entries), 'CORPUS_INVENTORY_REQUIRED');
  return inventory.entries.filter(entry => typeof entry.sha256 === 'string' && !entry.directory && !entry.link).length;
}
async function main(argv = process.argv.slice(2)) {
  const { suite, endpoint } = argumentsFor(argv); assert.equal(process.platform, 'darwin'); process.umask(0o077);
  const repo = fs.realpathSync(path.resolve(__dirname, '../..'));
  const parent = ensureOutputParent(repo, 'validation/local/docker-integration');
  const root = fs.mkdtempSync(path.join(parent, suite + '-'));
  // JUnit appends a random directory name; keep AF_UNIX fixture paths below the
  // macOS socket-path budget without using a user's or another run's temp tree.
  const temporary = fs.mkdtempSync(path.join(repo, '.citd-'));
  assert.equal(fs.realpathSync(temporary), temporary);
  assert.equal(fs.lstatSync(temporary).mode & 0o777, 0o700);
  for (const name of ['home', 'tmp', 'docker', 'data']) fs.mkdirSync(path.join(root, name), { mode: 0o700 });
  const env = testEnvironment(root, endpoint, os.homedir());
  env.CI_DOCKER_TEST_TMP = temporary;
  env.CI_DOCKER_TEST_SUITE = suite;
  // Anonymous image lookups only. Never import the user's Docker auth config.
  fs.writeFileSync(path.join(root, 'docker/config.json'), '{}\n', { flag: 'wx', mode: 0o600 });
  const docker = args => execFileSync('docker', args, { env, encoding: 'utf8', timeout: 10000, maxBuffer: 1024 * 1024 });
  const version = docker(['info', '--format', '{{.ServerVersion}}']).trim(); assert(/^[0-9][A-Za-z0-9.+-]*$/.test(version));
  const containers = () => docker(['ps', '-a', '--no-trunc', '--format', '{{json .}}']).trim().split('\n').filter(Boolean)
    .map(line => { const row = JSON.parse(line); assert(/^[a-f0-9]{64}$/.test(row.ID)); return { id: row.ID, state: row.State }; });
  const before = containers();
  const sources = () => Object.fromEntries(['backend/src/main', 'backend/src/test'].map(name => [name, dependencyInventory(path.join(repo, name)).sha256]));
  const report = { format: 1, status: 'RUNNING', suite, root, temporary, startedAt: new Date().toISOString(), dockerVersion: version,
    sources: sources(), driverSha256: hash(__filename), initSha256: hash(path.join(__dirname, 'docker-integration.init.gradle')),
    baseCommit: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repo, encoding: 'utf8' }).trim(),
    testHomePrivate: true, testDataPrivate: true, realGithub: false, paidAI: false, preexistingContainers: before,
    gradleEnvironment: 'Existing local Gradle cache/configuration; test workers have fresh home/environment; not an OS network sandbox', commands: [] };
  fs.copyFileSync(__filename, path.join(root, 'run-driver.cjs'), fs.constants.COPYFILE_EXCL);
  fs.copyFileSync(path.join(__dirname, 'docker-integration.init.gradle'), path.join(root, 'test.init.gradle'), fs.constants.COPYFILE_EXCL);
  report.processHelperSha256 = hash(path.join(__dirname, 'owned-test-process.cjs'));
  const save = () => fs.writeFileSync(assertOutputPath(root, path.join(root, 'result.json')), JSON.stringify(report, null, 2) + '\n', { mode: 0o600 });
  save(); console.log(JSON.stringify({ status: 'RUNNING', suite, evidence: root }));
  let analyzer, analyzerDone;
  async function command(label, executable, args, cwd, childEnv, timeout = 900000) {
    const fd = fs.openSync(path.join(root, label + '.log'), 'wx', 0o600); let result;
    try { result = await runOwnedCommand(executable, args, { cwd, env: childEnv, stdio: ['ignore', fd, fd] }, { timeoutMs: timeout }); }
    finally { fs.closeSync(fd); }
    report.commands.push({ label, exit: result.status, ...result }); save();
    return result;
  }
  try {
    let analyzerUrl;
    if (suite === 'accuracy') {
      const directory = path.join(repo, 'analyzers/ts-analyzer');
      const compile = await command('analyzer-build', process.execPath, [path.join(directory, 'node_modules/typescript/bin/tsc'), '-p', 'tsconfig.json'], directory, env, 90000);
      assert.equal(compile.status, 0, 'ANALYZER_BUILD_FAILED'); assert.equal(compile.timedOut, false);
      const fd = fs.openSync(path.join(root, 'analyzer.log'), 'wx', 0o600);
      analyzer = spawn(process.execPath, [path.join(directory, 'accuracy-server.cjs')], { cwd: directory,
        env: { PATH: env.PATH, HOME: path.join(root, 'home'), TMPDIR: temporary, LANG: 'C', LC_ALL: 'C' }, stdio: ['ignore', 'pipe', fd] });
      fs.closeSync(fd); analyzerDone = new Promise(resolve => { analyzer.once('error', () => resolve({ error: true })); analyzer.once('close', (code, signal) => resolve({ code, signal })); });
      let output = '';
      analyzer.stdout.on('data', bytes => { if (output.length < 1024) output += bytes.toString('utf8'); });
      for (let attempt = 0; attempt < 150; attempt++) {
        if (output.includes('\n')) { analyzerUrl = output.split('\n')[0].trim(); break; }
        if (analyzer.exitCode !== null || analyzer.signalCode !== null) break;
        await delay(100);
      }
      assert(/^http:\/\/127\.0\.0\.1:[0-9]+$/.test(analyzerUrl || ''), 'LOCAL_ANALYZER_NOT_READY');
    }
    const args = ['--offline', '--no-daemon', '--console=plain', '--max-workers=2', '-I', path.join(__dirname, 'docker-integration.init.gradle'),
      'spotlessCheck', ...suites[suite], ...(analyzerUrl ? ['-PaccuracyTsUrl=' + analyzerUrl] : [])];
    const started = performance.now();
    const executable = path.join(repo, 'backend/gradlew');
    const execution = suite === 'corpus'
      ? await command('gradle', '/usr/bin/time', ['-l', executable, ...args], path.join(repo, 'backend'), env)
      : await command('gradle', executable, args, path.join(repo, 'backend'), env);
    report.execution = { exit: execution.status, signal: execution.signal };
    const task = suite === 'accuracy' ? 'accuracyTest' : 'test', file = path.join(root, task + '-totals.json');
    if (fs.existsSync(file)) report.totals = JSON.parse(fs.readFileSync(file));
    if (suite === 'corpus') {
      const baselineFile = path.join(repo, 'quality-baseline.env'), baseline = fs.readFileSync(baselineFile, 'utf8');
      const field = name => { const values = [...baseline.matchAll(new RegExp('^' + name + '=([0-9]+)$', 'gm'))]; assert.equal(values.length, 1); return values[0][1]; };
      const corpus = dependencyInventory(path.join(repo, 'backend/src/test/resources/fixtures'));
      report.qualityBaseline = { sha256: hash(baselineFile), version: field('QUALITY_BASELINE_VERSION'),
        files: countCorpusFiles(corpus), minimumFiles: Number(field('MIN_CORPUS_FILES')), corpusSha256: corpus.sha256 };
      assert(report.qualityBaseline.files >= report.qualityBaseline.minimumFiles, 'CORPUS_TOO_SMALL');
      report.metrics = evaluateQualityMetrics({ platform: 'Darwin', timeOutput: fs.readFileSync(path.join(root, 'gradle.log'), 'utf8'),
        commandExitCode: String(execution.status), elapsedSeconds: String(Math.ceil((performance.now() - started) / 1000)),
        maxSeconds: field('MAX_BACKEND_SECONDS'), maxRssKiB: field('MAX_BACKEND_RSS_KB') });
      save(); assert.equal(report.metrics.exitCode, 0, 'QUALITY_MEASUREMENT_FAILED');
    }
    assert.equal(execution.status, 0, 'GRADLE_VERIFICATION_FAILED'); assert.equal(execution.signal, null); assert.equal(execution.timedOut, false);
    assert(report.totals?.tests > 0 && report.totals.fail === 0, 'TEST_RESULTS_REQUIRED');
    report.status = report.totals.skipped ? 'PASS_EXECUTED_WITH_EXPLICIT_SKIPS' : 'PASS';
  } catch (error) { report.status = 'FAIL'; report.failure = { code: typeof error.code === 'string' && error.code === 'ERR_ASSERTION' ? 'VERIFICATION_ASSERTION' : 'VERIFICATION_FAILED' }; }
  finally {
    if (analyzer) {
      const stopped = await stopOwned(analyzer, analyzerDone);
      report.analyzerExit = stopped.exit;
      if (!stopped.closed) { report.status = 'FAIL'; report.analyzerStopUnconfirmed = true; }
    }
    try {
      assert.deepEqual(sources(), report.sources); report.sourcesUnchanged = true;
      const previous = new Set(before.map(row => row.id));
      let after = containers();
      for (let attempt = 0; attempt < 20 && after.some(row => !previous.has(row.id)); attempt++) {
        await delay(1000); after = containers();
      }
      const old = new Map(after.map(row => [row.id, row.state]));
      report.preexistingContainersUnchanged = before.every(row => old.get(row.id) === row.state);
      report.newContainersRemaining = after.filter(row => !previous.has(row.id));
      if (!report.preexistingContainersUnchanged || report.newContainersRemaining.length) {
        report.containerCleanupUnconfirmed = true;
        if (report.status !== 'FAIL') report.status = 'REVIEW_REQUIRED';
      }
      // Presence is observed only. This runner never adopts/deletes a container
      // just because it was absent from an earlier snapshot.
    } catch { report.finalVerificationFailed = true; if (report.status !== 'FAIL') report.status = 'REVIEW_REQUIRED'; }
    report.finishedAt = new Date().toISOString(); save();
  }
  console.log(JSON.stringify({ status: report.status, suite, evidence: root, totals: report.totals }));
  if (!['PASS', 'PASS_EXECUTED_WITH_EXPLICIT_SKIPS'].includes(report.status)) process.exitCode = 1;
  return report;
}
module.exports = { argumentsFor, testEnvironment, countCorpusFiles, main };
if (require.main === module) main().catch(() => { console.error('DOCKER_INTEGRATION_REFUSED'); process.exitCode = 1; });
