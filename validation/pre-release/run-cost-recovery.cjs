'use strict';

// Explicit opt-in current-module integration using a verified retained bundle's
// Java/native binaries. This is not an Electron UI, real-Keychain or power-loss test.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawn, execFileSync } = require('node:child_process');
const { validateRuntimeManifest } = require('../../desktop/src/runtime-manifest.cjs');
const sha = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const digest = file => sha(fs.readFileSync(file));

function argumentsFor(argv) {
  assert.equal(argv.length, 4, 'Use --app <retained Validation.app> --mode normal|crash');
  assert.equal(argv[0], '--app'); assert.equal(argv[2], '--mode');
  assert(['normal', 'crash'].includes(argv[3]));
  return { app: argv[1], mode: argv[3] };
}
function environment(runtime, manifest, home, mode) {
  const paths = manifest.runtime;
  return { PATH: '/usr/bin:/bin:/usr/sbin:/sbin', HOME: home, TMPDIR: home, LANG: 'C', LC_ALL: 'C', TZ: 'UTC',
    CI_BACKUP_RUNTIME_PG_BIN: path.join(runtime, paths.postgresBin),
    CI_BACKUP_RUNTIME_PG_LIB: path.join(runtime, paths.postgresLib),
    CI_BACKUP_RUNTIME_JAVA: path.join(runtime, 'jre/bin/java'),
    CI_BACKUP_RUNTIME_REDIS: path.join(runtime, 'redis/bin/redis-server'),
    CI_BACKUP_RUNTIME_JAR: path.join(runtime, 'backend/code-intelligence.jar'),
    CI_BACKUP_RUNTIME_PRESERVE: '1',
    [mode === 'crash' ? 'CI_BACKUP_RUNTIME_CRASH_REAL' : 'CI_BACKUP_RUNTIME_REAL']: '1' };
}

async function main(argv = process.argv.slice(2)) {
  assert.equal(process.platform, 'darwin'); assert.equal(process.arch, 'arm64');
  assert(process.getuid() > 0); process.umask(0o077);
  const opts = argumentsFor(argv), root = fs.realpathSync(path.resolve(__dirname, '../..'));
  const app = fs.realpathSync(opts.app);
  assert.equal(path.basename(app), 'Code Intelligence Validation.app');
  assert.equal(path.dirname(path.dirname(app)), root);
  assert(/^\.native-product-[A-Za-z0-9]+$/.test(path.basename(path.dirname(app))));
  const runtime = path.join(app, 'Contents/Resources/runtime'), manifestFile = path.join(runtime, 'runtime-manifest.json');
  const manifest = JSON.parse(fs.readFileSync(manifestFile)); await validateRuntimeManifest(runtime, manifest);
  execFileSync('/usr/bin/codesign', ['--verify', '--strict', '--deep', app], { stdio: 'pipe', timeout: 30000 });
  const base = path.join(root, 'validation/local/pre-release-cost'); fs.mkdirSync(base, { recursive: true, mode: 0o700 });
  const evidence = fs.mkdtempSync(path.join(base, opts.mode + '-')), home = path.join(evidence, 'home');
  fs.mkdirSync(home, { mode: 0o700 });
  const entry = opts.mode === 'crash' ? 'desktop/test/backup-runtime-crash-postgres.test.cjs' : 'desktop/test/backup-runtime-postgres.test.cjs';
  const log = path.join(evidence, 'tests.log'), fd = fs.openSync(log, 'wx', 0o600);
  const report = { format: 1, status: 'RUNNING', mode: opts.mode, scope: 'real-native-services-current-node-modules-synthetic-keys',
    electronUi: false, realAccount: false, powerLoss: false, guardianKilled: false, paidProviderCalls: false,
    parentHome: home, entry, app, buildSequence: manifest.buildSequence,
    appAsarSha256: digest(path.join(app, 'Contents/Resources/app.asar')), manifestSha256: digest(manifestFile),
    sources: Object.fromEntries([entry, 'desktop/test/backup-runtime-postgres.test.cjs',
      'desktop/test/fixtures/backup-runtime-crash-owner.cjs', 'desktop/test/fixtures/owned-runtime-lifecycle.cjs',
      'desktop/src/backup-runtime.cjs', 'desktop/src/native-owner-locks.cjs', 'desktop/src/managed-process.cjs',
      'desktop/src/source-broker.cjs', 'desktop/src/source-vault.cjs', 'validation/pre-release/run-cost-recovery.cjs']
      .map(file => [file, digest(path.join(root, file))])) };
  const save = () => fs.writeFileSync(path.join(evidence, 'result.json'), JSON.stringify(report, null, 2) + '\n', { mode: 0o600 });
  save(); console.log(JSON.stringify({ status: report.status, evidence, mode: opts.mode }));
  let child;
  try {
    child = spawn(process.execPath, ['--test', '--test-reporter=tap', path.join(root, entry)],
      { cwd: root, env: environment(runtime, manifest, home, opts.mode), stdio: ['ignore', fd, fd], shell: false });
    report.pid = child.pid ?? null; save();
    // No timeout kills the test supervisor and strands its owned children. The
    // fixture itself bounds operations and owns cleanup of its original handles.
    const closed = await new Promise(resolve => {
      child.once('error', error => { report.spawnFailure = error.code || 'SPAWN_FAILED'; });
      child.once('close', (code, signal) => resolve({ code, signal }));
    });
    Object.assign(report, closed); fs.closeSync(fd);
    report.logSha256 = digest(log);
    const text = fs.readFileSync(log, 'utf8');
    report.counts = Object.fromEntries(['tests', 'pass', 'fail', 'cancelled', 'skipped'].map(name => [name,
      Number(text.match(new RegExp('^# ' + name + ' ([0-9]+)$', 'm'))?.[1] ?? -1)]));
    report.fixtureRoots = [...new Set(text.split('\n').flatMap(line => {
      const match = /^# (?:Synthetic fixture retained for root inspection: |Private synthetic crash fixture: )(.+)$/.exec(line);
      return match && path.dirname(match[1]) === root && /^\.cif-(?:cost|resume)-[A-Za-z0-9_-]+$/.test(path.basename(match[1])) ? [match[1]] : [];
    }))];
    assert.equal(closed.code, 0); assert.equal(closed.signal, null); assert(report.counts.tests > 0);
    assert.equal(report.counts.fail, 0); assert.equal(report.counts.cancelled, 0); assert.equal(report.counts.skipped, 0);
    await validateRuntimeManifest(runtime, manifest);
    assert.equal(digest(manifestFile), report.manifestSha256); assert.equal(digest(path.join(app, 'Contents/Resources/app.asar')), report.appAsarSha256);
    for (const [file, hash] of Object.entries(report.sources)) assert.equal(digest(path.join(root, file)), hash, 'Test source changed during execution');
    report.sourcesUnchanged = true;
    report.status = 'PASS';
  } catch (error) {
    report.status = 'FAIL'; report.failure = { code: error.code || error.name };
    // Native test cleanup and failed evidence stay owned/preserved; no PID adoption.
  } finally { try { fs.closeSync(fd); } catch {} save(); }
  console.log(JSON.stringify({ status: report.status, mode: opts.mode, counts: report.counts, evidence }));
  if (report.status !== 'PASS') process.exitCode = 1;
}
if (require.main === module) main().catch(error => { console.error(error.code || error.name); process.exitCode = 1; });
module.exports = { argumentsFor, environment };
