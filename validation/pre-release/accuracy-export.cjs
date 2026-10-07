'use strict';

// G-ACCURACY backend product observation run. Builds and starts the real local TS sidecar,
// runs the opt-in T00ObservationExportTest (real pipeline steps + Testcontainers PostgreSQL),
// converts the persisted product rows to T00 observations and an execution attestation, and
// evaluates them with validation/t00/runner.cjs. It never reads or writes gold files itself,
// never starts/stops Docker, and never uses a real profile, GitHub account or AI provider.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const { spawn, execFileSync } = require('node:child_process');
const { ensureOutputParent, assertOutputPath } = require('./owned-output.cjs');
const { testEnvironment } = require('./run-docker-integration.cjs');
const { runOwnedCommand, stopOwned } = require('./owned-test-process.cjs');
const { treeDigest, writeBundle } = require('./accuracy-observations.cjs');
const hash = file => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

function argumentsFor(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index += 2) {
    const flag = argv[index], value = argv[index + 1];
    assert(['--corpus', '--capabilities', '--socket', '--label'].includes(flag) && typeof value === 'string'
      && !Object.hasOwn(options, flag.slice(2)), 'ACCURACY_EXPORT_ARGUMENTS');
    options[flag.slice(2)] = value;
  }
  assert(options.corpus && options.capabilities && options.socket, 'ACCURACY_EXPORT_ARGUMENTS');
  assert(options.socket === 'unix://' + path.join(os.homedir(), '.docker/run/docker.sock')
    || options.socket === 'unix:///var/run/docker.sock', 'LOCAL_DOCKER_REQUIRED');
  assert(options.label == null || /^[a-z0-9][a-z0-9-]{0,31}$/.test(options.label), 'ACCURACY_EXPORT_ARGUMENTS');
  return options;
}

function gitState(repo) {
  const git = args => execFileSync('git', args, { cwd: repo, encoding: 'utf8', timeout: 30000 }).trim();
  const productPaths = ['backend/src/main', 'analyzers/ts-analyzer/src', 'analyzers/ts-analyzer/package.json',
    'analyzers/ts-analyzer/package-lock.json', 'backend/build.gradle.kts'];
  return { revision: git(['rev-parse', 'HEAD']),
    dirtyProductPaths: git(['status', '--porcelain', '--', ...productPaths]).split('\n').filter(Boolean).length };
}

async function main(argv = process.argv.slice(2)) {
  const options = argumentsFor(argv); assert.equal(process.platform, 'darwin'); process.umask(0o077);
  const repo = fs.realpathSync(path.resolve(__dirname, '../..'));
  const corpus = fs.realpathSync(path.resolve(options.corpus)), capabilities = fs.realpathSync(path.resolve(options.capabilities));
  const parent = ensureOutputParent(repo, 'validation/local/accuracy-export');
  const root = fs.mkdtempSync(path.join(parent, (options.label ?? 'backend') + '-'));
  const temporary = fs.mkdtempSync(path.join(repo, '.citd-'));
  for (const name of ['home', 'tmp', 'docker', 'data']) fs.mkdirSync(path.join(root, name), { mode: 0o700 });
  const env = testEnvironment(root, options.socket, os.homedir());
  Object.assign(env, { CI_DOCKER_TEST_TMP: temporary, CI_DOCKER_TEST_SUITE: 'accuracy-export' });
  fs.writeFileSync(path.join(root, 'docker/config.json'), '{}\n', { flag: 'wx', mode: 0o600 });
  const dumps = path.join(root, 'dumps');
  const analyzerDirectory = path.join(repo, 'analyzers/ts-analyzer');
  const report = { format: 1, status: 'RUNNING', path: 'BACKEND_PIPELINE_HARNESS', root, startedAt: new Date().toISOString(),
    nonce: crypto.randomBytes(16).toString('hex'), git: gitState(repo), corpusSha256: hash(corpus),
    capabilityManifestSha256: hash(capabilities), driverSha256: hash(__filename),
    converterSha256: hash(path.join(__dirname, 'accuracy-observations.cjs')),
    initSha256: { docker: hash(path.join(__dirname, 'docker-integration.init.gradle')), export: hash(path.join(__dirname, 'accuracy-export.init.gradle')) },
    harnessSha256: hash(path.join(repo, 'backend/src/test/java/dev/codeintelligence/analysis/accuracy/T00ObservationExportTest.java')),
    realGithub: false, paidAI: false, commands: [] };
  const save = () => fs.writeFileSync(assertOutputPath(root, path.join(root, 'result.json')), JSON.stringify(report, null, 2) + '\n', { mode: 0o600 });
  save(); console.log(JSON.stringify({ status: 'RUNNING', evidence: root }));
  let analyzer, analyzerDone;
  async function command(label, executable, args, cwd, childEnv, timeout = 900000) {
    const fd = fs.openSync(path.join(root, label + '.log'), 'wx', 0o600); let result;
    try { result = await runOwnedCommand(executable, args, { cwd, env: childEnv, stdio: ['ignore', fd, fd] }, { timeoutMs: timeout }); }
    finally { fs.closeSync(fd); }
    report.commands.push({ label, executable: path.basename(executable), args: args.map(arg => arg.startsWith(repo) ? path.relative(repo, arg) : arg),
      exit: result.status, signal: result.signal, timedOut: result.timedOut }); save();
    return result;
  }
  try {
    const compile = await command('analyzer-build', process.execPath, [path.join(analyzerDirectory, 'node_modules/typescript/bin/tsc'), '-p', 'tsconfig.json'], analyzerDirectory, env, 120000);
    assert.equal(compile.status, 0, 'ANALYZER_BUILD_FAILED');
    report.tsAnalyzerDist = treeDigest(path.join(analyzerDirectory, 'dist'));
    report.tsAnalyzerServerSha256 = hash(path.join(analyzerDirectory, 'accuracy-server.cjs'));
    const fd = fs.openSync(path.join(root, 'analyzer.log'), 'wx', 0o600);
    analyzer = spawn(process.execPath, [path.join(analyzerDirectory, 'accuracy-server.cjs')], { cwd: analyzerDirectory,
      env: { PATH: env.PATH, HOME: path.join(root, 'home'), TMPDIR: temporary, LANG: 'C', LC_ALL: 'C' }, stdio: ['ignore', 'pipe', fd] });
    fs.closeSync(fd);
    analyzerDone = new Promise(resolve => { analyzer.once('error', () => resolve({ error: true })); analyzer.once('close', (code, signal) => resolve({ code, signal })); });
    let output = '', url;
    analyzer.stdout.on('data', bytes => { if (output.length < 1024) output += bytes.toString('utf8'); });
    for (let attempt = 0; attempt < 150 && !url; attempt++) {
      if (output.includes('\n')) url = output.split('\n')[0].trim();
      else if (analyzer.exitCode !== null || analyzer.signalCode !== null) break;
      else await delay(100);
    }
    assert(/^http:\/\/127\.0\.0\.1:[0-9]+$/.test(url || ''), 'LOCAL_ANALYZER_NOT_READY');
    const gradleEnv = { ...env, ACCURACY_T00_CORPUS: corpus, ACCURACY_T00_OUTPUT: dumps };
    const gradle = await command('gradle', path.join(repo, 'backend/gradlew'), ['--offline', '--no-daemon', '--console=plain', '--max-workers=2',
      '-I', path.join(__dirname, 'docker-integration.init.gradle'), '-I', path.join(__dirname, 'accuracy-export.init.gradle'),
      'accuracyTest', '--tests', 'dev.codeintelligence.analysis.accuracy.T00ObservationExportTest', '-PaccuracyTsUrl=' + url],
      path.join(repo, 'backend'), gradleEnv);
    const totalsFile = path.join(root, 'accuracyTest-totals.json');
    if (fs.existsSync(totalsFile)) report.totals = JSON.parse(fs.readFileSync(totalsFile, 'utf8'));
    assert.equal(gradle.status, 0, 'GRADLE_EXPORT_FAILED');
    assert(report.totals?.tests === 1 && report.totals.pass === 1 && report.totals.skipped === 0, 'EXPORT_TEST_NOT_EXECUTED');
    assert.deepEqual(treeDigest(path.join(analyzerDirectory, 'dist')), report.tsAnalyzerDist, 'ANALYZER_CHANGED_DURING_RUN');
    const build = JSON.parse(fs.readFileSync(path.join(dumps, 'build.json'), 'utf8'));
    report.build = { path: 'BACKEND_PIPELINE_HARNESS', revision: report.git.revision, dirtyProductPaths: report.git.dirtyProductPaths,
      components: [
        { name: 'backend-classes', path: 'backend/build/classes/java/main', ...build.backendClassesTree },
        { name: 'backend-resources', path: 'backend/build/resources/main', ...build.backendResourcesTree },
        { name: 'ts-analyzer-dist', path: 'analyzers/ts-analyzer/dist', ...report.tsAnalyzerDist },
        { name: 'ts-analyzer-accuracy-server', path: 'analyzers/ts-analyzer/accuracy-server.cjs', kind: 'FILE', files: 1, sha256: report.tsAnalyzerServerSha256 },
      ], javaVersion: build.javaVersion };
    const dumpMap = new Map(build.fixtures.map(id => [id, JSON.parse(fs.readFileSync(path.join(dumps, id + '.dump.json'), 'utf8'))]));
    report.dumpSha256 = Object.fromEntries(build.fixtures.map(id => [id, hash(path.join(dumps, id + '.dump.json'))]));
    report.bundle = writeBundle({ root, corpus, capabilities, dumps: dumpMap, build: report.build, execution: {
      path: report.path, nonce: report.nonce, startedAt: report.startedAt, finishedAt: new Date().toISOString(),
      harnessSha256: report.harnessSha256, driverSha256: report.driverSha256, converterSha256: report.converterSha256,
      revision: report.git.revision } });
    report.status = 'EXPORTED'; save();
    report.t00 = await evaluate({ repo, root, corpus, capabilities, bundle: report.bundle, command });
    report.status = report.t00.exit === 2 ? 'EVALUATED_BLOCKED' : report.t00.exit === 1 ? 'EVALUATED_FAIL' : 'EVALUATED_UNEXPECTED';
  } catch (error) {
    report.status = 'FAIL';
    report.failure = { code: error?.code === 'ERR_ASSERTION' ? String(error.message).slice(0, 80) : 'EXPORT_FAILED' };
  } finally {
    if (analyzer) {
      const stopped = await stopOwned(analyzer, analyzerDone);
      report.analyzerExit = stopped.exit;
      if (!stopped.closed) { report.status = 'FAIL'; report.analyzerStopUnconfirmed = true; }
    }
    try { fs.rmSync(temporary, { recursive: true, force: true }); } catch { report.temporaryCleanupFailed = true; }
    report.finishedAt = new Date().toISOString(); save();
  }
  console.log(JSON.stringify({ status: report.status, evidence: root, failure: report.failure ?? null, t00: report.t00 ?? null }));
  // A gate run over development material can never pass; BLOCKED/FAIL are both recorded results.
  if (!['EVALUATED_BLOCKED', 'EVALUATED_FAIL'].includes(report.status)) process.exitCode = 1;
  return report;
}

// Evaluate the bundle with the unmodified T00 runner in gate mode, artifact re-hash included.
async function evaluate({ repo, root, corpus, capabilities, bundle, command }) {
  const output = path.join(root, 't00-gate');
  const args = [path.join(repo, 'validation/t00/runner.cjs'), '--mode', 'gate', '--offline', '--corpus', corpus,
    '--capabilities', capabilities, '--observations', path.join(bundle.directory, 'observations.json'),
    '--product-build-sha256', bundle.productBuildSha256, '--execution-attestation', path.join(bundle.directory, 'attestation.json'),
    '--product-artifact-root', repo, '--output', output];
  const result = await command('t00-gate', process.execPath, args, repo, { PATH: '/usr/bin:/bin', LANG: 'C', LC_ALL: 'C' }, 300000);
  const summary = fs.readFileSync(path.join(root, 't00-gate.log'), 'utf8').trim().split('\n').at(-1);
  const reportFile = path.join(output, 'report.json');
  return { exit: result.status, summary: JSON.parse(summary), output,
    reportSha256: fs.existsSync(reportFile) ? hash(reportFile) : null };
}
module.exports = { argumentsFor, main, evaluate };
if (require.main === module) main().catch(() => { console.error('ACCURACY_EXPORT_REFUSED'); process.exitCode = 1; });
