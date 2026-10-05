'use strict';

// Reuse the actual native product acceptance runner on a new private fixture and
// the explicitly named retained candidate. No build, provisioning or real profile.
const fs = require('node:fs'), path = require('node:path'), os = require('node:os');
const assert = require('node:assert/strict'), crypto = require('node:crypto'), { execFileSync } = require('node:child_process');
const { ensureOutputParent } = require('./owned-output.cjs');
const { validateRuntimeManifest } = require('../../desktop/src/runtime-manifest.cjs');
const { copySource } = require('../../desktop/scripts/native-acceptance.cjs');
const { copyPrivateTree } = require('../../desktop/scripts/build-isolated.cjs');
const { validateLocalEnvironment, requireExecutionContext } = require('../../desktop/scripts/native-acceptance-context.cjs');
const { runProduct } = require('../../desktop/scripts/native-acceptance-electron.cjs');
const hash = file => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');

async function main(argv = process.argv.slice(2)) {
  assert.equal(process.platform, 'darwin'); assert.equal(process.arch, 'arm64');
  assert(argv[0] === '--app' && (argv.length === 2 || (argv.length === 3 && argv[2] === '--analysis-only')));
  const analysisOnly = argv.length === 3;
  validateLocalEnvironment(process.env, process.execArgv); process.umask(0o077);
  const repo = fs.realpathSync(path.resolve(__dirname, '../..')), app = fs.realpathSync(argv[1]);
  assert.equal(path.dirname(path.dirname(app)), repo); assert.equal(path.basename(app), 'Code Intelligence Validation.app');
  assert.match(path.basename(path.dirname(app)), /^\.native-product-[A-Za-z0-9]+$/);
  const manifestFile = path.join(app, 'Contents/Resources/runtime/runtime-manifest.json'), manifest = JSON.parse(fs.readFileSync(manifestFile));
  await validateRuntimeManifest(path.dirname(manifestFile), manifest);
  execFileSync('/usr/bin/codesign', ['--verify', '--strict', '--deep', app], { timeout: 30000, stdio: 'pipe' });
  const evidenceParent = ensureOutputParent(repo, 'validation/local/pre-release-final');
  const evidence = fs.mkdtempSync(path.join(evidenceParent, 'product-'));
  const root = fs.mkdtempSync('/private/tmp/cnpc-'), temp = path.join(root, 'work'), owned = path.join(temp, 'owned');
  for (const p of [temp, owned]) fs.mkdirSync(p, { mode: 0o700 });
  const short = fs.mkdtempSync('/private/tmp/cnpr-'), control = path.join(root, 'context.json');
  const revision = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repo, encoding: 'utf8' }).trim();
  fs.writeFileSync(control, JSON.stringify({ format: 1, kind: 'isolated-macos-host', provider: 'local-macos',
    uid: process.getuid(), revision, buildSequence: manifest.buildSequence, sourceRoot: repo, tempRoot: temp,
    isolatedRunParent: short, createdAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 3600000).toISOString() }), { flag: 'wx', mode: 0o600 });
  const env = { PATH: '/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin', HOME: os.homedir(), LANG: 'C', LC_ALL: 'C',
    NATIVE_ACCEPTANCE_CONTEXT: control, CODE_INTELLIGENCE_BUILD_SEQUENCE: manifest.buildSequence };
  requireExecutionContext(env);
  const source = path.join(owned, 'source'), copied = copySource(repo, source);
  const workIdentity = fs.lstatSync(source);
  copyPrivateTree({ workRoot: source, assertIdentity() { const now = fs.lstatSync(source);
    assert.equal(now.ino, workIdentity.ino); assert.equal(now.dev, workIdentity.dev); assert.equal(fs.realpathSync(source), source); } },
    path.join(repo, 'frontend/node_modules'), path.join(source, 'frontend/node_modules'));
  const artifacts = path.join(temp, 'artifacts'); fs.mkdirSync(artifacts, { mode: 0o700 });
  const report = { format: 1, status: 'RUNNING', scope: analysisOnly ? 'current-candidate analysis-only native runner' : 'current-candidate existing native product runner',
    analysisOnly, omittedSuites: analysisOnly ? ['backup-restore', 'safeStorage-roundtrip', 'delete-persistence',
      'initial-synthetic-import-reanalysis', 'historical-current-snapshot-contracts',
      'post-restore-delete-before-representative-transition'] : [],
    appBundle: app, manifestSha256: hash(manifestFile), appAsarSha256: hash(path.join(app, 'Contents/Resources/app.asar')),
    driverSha256: hash(__filename), productRunnerSha256: hash(path.join(repo, 'desktop/scripts/native-acceptance-electron.cjs')),
    sourceCopy: copied, checks: [], mockKeychain: true, realAccount: false, realKeychain: false, control, work: root, artifacts };
  const resultFile = path.join(evidence, 'result.json');
  const save = () => fs.writeFileSync(resultFile, JSON.stringify(report, null, 2) + '\n', { mode: 0o600 });
  const phase = name => { report.phase = name; save(); };
  save(); console.log(JSON.stringify({ status: report.status, evidence }));
  try { await runProduct({ source, owned, artifacts, report, env, phase }); report.status = 'PASS'; }
  catch { report.status = 'FAIL'; report.failure ??= { code: 'NATIVE_PRODUCT_FAILED' }; }
  finally {
    try { assert.equal(hash(manifestFile), report.manifestSha256); assert.equal(hash(path.join(app, 'Contents/Resources/app.asar')), report.appAsarSha256); }
    catch { report.status = 'FAIL'; report.finalIdentityFailure = true; }
    save();
  }
  console.log(JSON.stringify({ status: report.status, evidence, phase: report.phase, checks: report.checks.length }));
  if (report.status !== 'PASS') process.exitCode = 1;
}
module.exports = { main };
if (require.main === module) main().catch(() => { console.error('NATIVE_PRODUCT_WRAPPER_FAILED'); process.exitCode = 1; });
