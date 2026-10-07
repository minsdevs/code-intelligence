'use strict';

// G-IMPORT / G-EVIDENCE backend suites in the same isolated Docker/Testcontainers
// environment as run-docker-integration.cjs (fresh test HOME/TMP/data, offline Gradle,
// anonymous Docker config). The TypeScript analyzer is compiled first so the C06 class
// starts the real sidecar itself; it is an explicit skip when that module is absent.
const assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), os = require('node:os'), crypto = require('node:crypto');
const { ensureOutputParent } = require('./owned-output.cjs');
const { runOwnedCommand } = require('./owned-test-process.cjs');
const { testEnvironment, argumentsFor } = require('./run-docker-integration.cjs');
const hash = file => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const SELECTION = ['dev.codeintelligence.project.*', 'dev.codeintelligence.evidence.*', 'dev.codeintelligence.migration.*',
  'dev.codeintelligence.history.*', '*SnapshotComparisonServiceTest', '*CoverageServiceTest'];
const REPORTS = ['c05-import-secrets-corpus.json', 'c06-evidence-history.json', 'legacy-migration-walk.json'];

async function main(argv = process.argv.slice(2)) {
  const { endpoint } = argumentsFor(['--suite', 'backend', ...argv]);
  assert.equal(process.platform, 'darwin'); process.umask(0o077);
  const repo = fs.realpathSync(path.resolve(__dirname, '../..'));
  const root = fs.mkdtempSync(path.join(ensureOutputParent(repo, 'validation/local/import-evidence'), 'backend-'));
  const temporary = fs.mkdtempSync(path.join(repo, '.citd-'));
  for (const name of ['home', 'tmp', 'docker', 'data']) fs.mkdirSync(path.join(root, name), { mode: 0o700 });
  fs.writeFileSync(path.join(root, 'docker/config.json'), '{}\n', { flag: 'wx', mode: 0o600 });
  const env = { ...testEnvironment(root, endpoint, os.homedir()), CI_DOCKER_TEST_TMP: temporary, CI_DOCKER_TEST_SUITE: 'backend' };
  const report = { format: 1, status: 'RUNNING', root, selection: SELECTION, driverSha256: hash(__filename),
    initSha256: hash(path.join(__dirname, 'docker-integration.init.gradle')), startedAt: new Date().toISOString(), commands: [] };
  const save = () => fs.writeFileSync(path.join(root, 'report.json'), JSON.stringify(report, null, 2) + '\n', { mode: 0o600 });
  const command = async (label, executable, args, cwd, timeoutMs) => {
    const fd = fs.openSync(path.join(root, label + '.log'), 'wx', 0o600); let result;
    try { result = await runOwnedCommand(executable, args, { cwd, env, stdio: ['ignore', fd, fd] }, { timeoutMs }); }
    finally { fs.closeSync(fd); }
    report.commands.push({ label, exit: result.status, signal: result.signal, timedOut: result.timedOut }); save();
    return result;
  };
  save(); console.log(JSON.stringify({ status: 'RUNNING', evidence: root }));
  try {
    const analyzer = path.join(repo, 'analyzers/ts-analyzer');
    const build = await command('analyzer-build', process.execPath, [path.join(analyzer, 'node_modules/typescript/bin/tsc'), '-p', 'tsconfig.json'], analyzer, 120000);
    assert.equal(build.status, 0, 'ANALYZER_BUILD_FAILED');
    const args = ['--offline', '--no-daemon', '--console=plain', '--max-workers=2', '-I', path.join(__dirname, 'docker-integration.init.gradle'),
      'spotlessCheck', 'test', ...SELECTION.flatMap(pattern => ['--tests', pattern])];
    const gradle = await command('gradle', path.join(repo, 'backend/gradlew'), args, path.join(repo, 'backend'), 2400000);
    const totals = path.join(root, 'test-totals.json');
    if (fs.existsSync(totals)) report.totals = JSON.parse(fs.readFileSync(totals));
    report.reports = {};
    for (const name of REPORTS) {
      const source = path.join(repo, 'backend/build/reports', name);
      if (fs.existsSync(source)) { fs.copyFileSync(source, path.join(root, name)); report.reports[name] = hash(path.join(root, name)); }
    }
    assert.equal(gradle.status, 0, 'GRADLE_VERIFICATION_FAILED');
    assert(report.totals?.tests > 0 && report.totals.fail === 0, 'TEST_RESULTS_REQUIRED');
    report.status = report.totals.skipped ? 'PASS_EXECUTED_WITH_EXPLICIT_SKIPS' : 'PASS';
  } catch (error) {
    report.status = 'FAIL'; report.failure = error?.code === 'ERR_ASSERTION' ? String(error.message).slice(0, 120) : 'VERIFICATION_FAILED';
  } finally {
    // The short temporary root was created by this run only; bulk C05 fixtures must not outlive it.
    try { fs.rmSync(temporary, { recursive: true, force: true }); report.temporaryRemoved = true; } catch { report.temporaryRemoved = false; }
    report.finishedAt = new Date().toISOString(); save();
  }
  console.log(JSON.stringify({ status: report.status, evidence: root, totals: report.totals }));
  if (!['PASS', 'PASS_EXECUTED_WITH_EXPLICIT_SKIPS'].includes(report.status)) process.exitCode = 1;
}
module.exports = { main, SELECTION };
if (require.main === module) main().catch(() => { console.error('IMPORT_EVIDENCE_BACKEND_REFUSED'); process.exitCode = 1; });
