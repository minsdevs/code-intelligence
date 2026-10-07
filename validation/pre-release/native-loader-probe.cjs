'use strict';

// Clean-machine approximation on ONE development Mac. It proves only what the dynamic
// loader and process table of this machine show; it cannot prove the absence of tools
// on a machine that has them installed. Never a substitute for the fresh-Mac C14 matrix.
//
// 1. Each bundled service binary is executed directly with a stripped environment (no
//    Homebrew PATH, no DYLD_*), and again under a sandbox profile that denies reading
//    developer-tool roots, so a load-time dependency on those roots fails visibly.
// 2. With --packaged-app, the packaged app is launched once with a fresh synthetic profile
//    and mock Keychain; after all four services are ready, every file mapped as program
//    text by every process of the app's tree (lsof "txt") is classified.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { createRequire } = require('node:module');
const { spawnSync, execFile } = require('node:child_process');
const { promisify } = require('node:util');

const execute = promisify(execFile);
const STRIPPED_PATH = '/usr/bin:/bin:/usr/sbin:/sbin';
const DEVELOPER_ROOTS = Object.freeze(['/opt/homebrew', '/usr/local', '/opt/local', '/Library/Developer', '/Applications/Xcode.app',
  '/Library/Java', '/Library/PostgreSQL', '/Applications/Docker.app', '/Applications/Postgres.app']);
const HOME_DEVELOPER_DIRECTORIES = Object.freeze(['.nvm', '.sdkman', '.pyenv', '.rbenv', '.asdf', '.volta', '.cargo', '.rustup', '.docker', '.gradle', '.m2']);
const SERVICE_COMMANDS = Object.freeze([
  ['postgres/bin/postgres', ['--version']], ['postgres/bin/initdb', ['--version']], ['postgres/bin/pg_ctl', null],
  ['postgres/bin/psql', ['--version']], ['postgres/bin/pg_dump', ['--version']], ['postgres/bin/pg_restore', ['--version']],
  ['postgres/bin/pg_isready', ['--version']], ['postgres/bin/createdb', ['--version']],
  ['redis/bin/redis-server', ['--version']], ['jre/bin/java', ['-version']], ['jre/bin/keytool', ['-help']],
].filter(([, args]) => args !== null));
const OS_PREFIXES = Object.freeze(['/usr/lib/', '/usr/share/', '/System/', '/Library/Apple/', '/private/var/db/dyld/',
  '/private/var/db/timezone/', '/usr/libexec/', '/Library/Preferences/Logging/', '/private/var/db/DetachedSignatures']);

function sandboxProfile(home) {
  const roots = [...DEVELOPER_ROOTS, ...HOME_DEVELOPER_DIRECTORIES.map(name => path.join(home, name))];
  for (const root of roots) assert(path.isAbsolute(root) && !/["\\\n]/.test(root), 'SANDBOX_PATH_INVALID');
  return `(version 1)(allow default)(deny file-read* ${roots.map(root => `(subpath "${root}")`).join(' ')})`;
}

function classifyMappedPath(file, { app, profileRoot }) {
  if (typeof file !== 'string' || !path.isAbsolute(file)) return 'invalid';
  if (file === app || file.startsWith(app + '/')) return 'bundle';
  if (OS_PREFIXES.some(prefix => file.startsWith(prefix))) return 'os';
  if (profileRoot && (file === profileRoot || file.startsWith(profileRoot + '/'))) return 'profile';
  if (DEVELOPER_ROOTS.some(root => file === root || file.startsWith(root + '/'))) return 'developer';
  return 'other';
}

// lsof -F output: p<pid> then per file f<fd>, t<type>, n<name>. Only "txt" (program text and
// mapped images) and "mem" mappings show loaded code; descriptors are not counted.
function parseLsof(text) {
  const rows = []; let pid = null, current = null;
  for (const line of String(text).split('\n')) {
    if (!line) continue;
    const tag = line[0], value = line.slice(1);
    if (tag === 'p') { pid = Number(value); current = null; }
    else if (tag === 'f') { current = { pid, fd: value, type: null, name: null }; rows.push(current); }
    else if (current && tag === 't') current.type = value;
    else if (current && tag === 'n') current.name = value;
  }
  return rows.filter(row => row.fd === 'txt' || row.fd === 'mem');
}

function isMachO(file) {
  try {
    const descriptor = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW), bytes = Buffer.alloc(8);
    try { fs.readSync(descriptor, bytes, 0, 8, 0); } finally { fs.closeSync(descriptor); }
    const magic = bytes.subarray(0, 4).toString('hex');
    return ['feedface', 'cefaedfe', 'feedfacf', 'cffaedfe'].includes(magic)
      || (['cafebabe', 'cafebabf'].includes(magic) && bytes.readUInt32BE(4) >= 1 && bytes.readUInt32BE(4) <= 20);
  } catch { return null; }
}

function evaluateMappings(rows, context) {
  const classes = {}, findings = [], external = new Map();
  for (const row of rows) {
    const cls = classifyMappedPath(row.name, context);
    classes[cls] = (classes[cls] || 0) + 1;
    if (cls === 'developer') findings.push({ code: 'DEVELOPER_ROOT_MAPPED', pid: row.pid, file: row.name });
    else if (cls === 'other' || cls === 'invalid' || cls === 'profile') {
      const code = isMachO(row.name);
      if (code === true) findings.push({ code: 'CODE_MAPPED_OUTSIDE_BUNDLE_AND_OS', pid: row.pid, file: row.name });
      else external.set(row.name, (external.get(row.name) || 0) + 1);
    }
  }
  return { classes, findings, nonCodeOutside: [...external.keys()].sort() };
}

function serviceProbes(runtime, { home }) {
  const env = { PATH: STRIPPED_PATH, LANG: 'C', LC_ALL: 'C', HOME: home, TMPDIR: home };
  const profile = sandboxProfile(os.homedir());
  // Control: the sandbox must actually deny a developer root on this machine.
  const control = fs.existsSync('/opt/homebrew/bin')
    ? spawnSync('/usr/bin/sandbox-exec', ['-p', profile, '/bin/ls', '/opt/homebrew/bin'], { env, encoding: 'utf8', timeout: 30000 })
    : null;
  const results = [];
  for (const [relative, args] of SERVICE_COMMANDS) {
    const file = path.join(runtime, relative);
    const plain = spawnSync(file, args, { env, encoding: 'utf8', timeout: 60000, cwd: home });
    const denied = spawnSync('/usr/bin/sandbox-exec', ['-p', profile, file, ...args], { env, encoding: 'utf8', timeout: 60000, cwd: home });
    const output = value => `${value.stdout || ''}${value.stderr || ''}`.split('\n').find(Boolean)?.slice(0, 160) || '';
    results.push({ command: relative, args, plainExit: plain.status, deniedExit: denied.status,
      plainFirstLine: output(plain), deniedFirstLine: output(denied),
      pass: plain.status === 0 && denied.status === 0 && output(plain) === output(denied) });
  }
  return { environment: { PATH: STRIPPED_PATH, dyldVariables: 0 }, sandboxProfileSha256: crypto.createHash('sha256').update(profile).digest('hex'),
    deniedRoots: [...DEVELOPER_ROOTS, ...HOME_DEVELOPER_DIRECTORIES.map(name => '~/' + name)],
    control: control ? { command: 'ls /opt/homebrew/bin', exit: control.status, denied: control.status !== 0 } : { skipped: 'no /opt/homebrew' },
    results, pass: results.every(item => item.pass) && (!control || control.status !== 0) };
}

async function lsofFor(pids) {
  const { stdout } = await execute('/usr/sbin/lsof', ['-n', '-P', '-w', '-F', 'pftn', '-p', pids.join(',')],
    { timeout: 30000, maxBuffer: 64 * 1024 * 1024, env: { PATH: '/usr/bin:/bin:/usr/sbin', LANG: 'C', LC_ALL: 'C' } }).catch(error => {
    if (error.stdout) return { stdout: error.stdout }; throw error;
  });
  return parseLsof(stdout);
}

async function packagedRun({ repo, app, runtime, report, save }) {
  const { prepareIsolatedRun } = require('../../desktop/src/isolated-run.cjs');
  const { launchEnvironment, bounded } = require('../../desktop/scripts/packaged-keychain-acceptance.cjs');
  const { observeStartup, closeValidatedApplication } = require('../../desktop/scripts/native-acceptance-electron.cjs');
  const { captureOwnedApplication } = require('../backup-compatibility/interruption-hooks.cjs');
  const { readOwnerMemory } = require('./process-memory.cjs');
  const { confirmObservedGone } = require('./run-startup-benchmark.cjs');
  // A fresh short parent keeps the profile's Unix socket paths within the macOS limit from any
  // worktree depth (isolated-run socket budget), as run-integrity-diagnostic.cjs does.
  const parent = fs.mkdtempSync('/private/tmp/cilp-');
  const plan = prepareIsolatedRun({ parentDirectory: parent, runtimeDirectory: runtime, purpose: 'automation',
    forbiddenRoots: ['Code Intelligence', 'Code Intelligence Validation'].map(name => path.join(os.homedir(), 'Library/Application Support', name)) });
  const { _electron } = createRequire(path.join(repo, 'frontend/package.json'))('playwright');
  const { expect } = createRequire(path.join(repo, 'frontend/package.json'))('@playwright/test');
  const launchEnv = launchEnvironment(process.env);
  const run = { status: 'RUNNING', profileRoot: plan.root, mockKeychain: true, launchPath: launchEnv.PATH,
    launchEnvironmentKeys: Object.keys(launchEnv).sort(), dyldVariables: Object.keys(launchEnv).filter(key => key.startsWith('DYLD_')).length };
  report.packaged = run; save();
  const diagnostics = {}; let sdk, owner, stopObserving, failure = null;
  const started = performance.now(), expires = started + 120000;
  const remaining = () => { const value = Math.floor(expires - performance.now()); if (value <= 0) throw new Error('STARTUP_TIMEOUT'); return value; };
  try {
    sdk = await _electron.launch({ executablePath: path.join(app, 'Contents/MacOS/Code Intelligence Validation'),
      args: ['--use-mock-keychain', '--isolated-run-claim=' + plan.claimFile], cwd: repo, env: launchEnv, timeout: remaining() });
    owner = captureOwnedApplication(sdk);
    stopObserving = observeStartup(owner.process(), diagnostics, () => {});
    const page = await sdk.firstWindow({ timeout: remaining() });
    await expect(page.getByRole('link', { name: 'Code Intelligence home' })).toBeVisible({ timeout: remaining() });
    const status = await bounded(() => page.evaluate(() => window.codeIntelligenceDesktop.runtimeStatus()), remaining(), 'STARTUP_TIMEOUT');
    assert.equal(status.ready, true); assert.equal(status.recoveryOnly, false); assert.equal(status.error, null);
    run.services = [...status.services].sort();
    assert.deepEqual(run.services, ['backend', 'postgres', 'redis', 'ts-analyzer']);
    const processes = await readOwnerMemory(owner.process().pid);
    const pids = processes.map(row => row.pid);
    const { stdout } = await execute('/bin/ps', ['-p', pids.join(','), '-o', 'pid=,comm='], { timeout: 5000, env: { PATH: '/usr/bin:/bin', LANG: 'C', LC_ALL: 'C' } });
    const executables = stdout.trim().split('\n').map(line => /^\s*(\d+)\s+(.+?)\s*$/.exec(line)).filter(Boolean).map(match => ({ pid: Number(match[1]), comm: match[2] }));
    run.processCount = pids.length;
    run.executablesOutsideBundle = executables.filter(row => !row.comm.startsWith(app + '/')).map(row => row.comm);
    const mappings = await lsofFor(pids);
    run.mappedEntries = mappings.length;
    run.mappedPids = [...new Set(mappings.map(row => row.pid))].length;
    const evaluated = evaluateMappings(mappings, { app, profileRoot: plan.root });
    run.mappingClasses = evaluated.classes; run.mappingFindings = evaluated.findings;
    run.nonCodeOutsideBundleAndOs = evaluated.nonCodeOutside.map(file => file.startsWith(plan.root) ? '<profile>' + file.slice(plan.root.length) : file);
    run.bundleImages = [...new Set(mappings.filter(row => classifyMappedPath(row.name, { app }) === 'bundle').map(row => path.relative(app, row.name)))].sort();
    run.servicesWithBundleImages = Object.fromEntries(['postgres/bin/postgres', 'redis/bin/redis-server', 'jre/bin/java', 'jre/lib/server/libjvm.dylib',
      'postgres/lib/libssl.3.dylib', 'redis/lib/libssl.3.dylib', 'postgres/lib/vector.dylib']
      .map(name => [name, run.bundleImages.includes('Contents/Resources/runtime/' + name)]));
    if (owner.process().exitCode !== null) throw new Error('STARTUP_PROCESS_EXITED');
  } catch (error) { failure = error?.message && /^[A-Z_]+$/.test(error.message) ? error.message : 'LOADER_PROBE_FAILED'; run.errorName = error?.name || null; }
  finally {
    if (owner) {
      try { await closeValidatedApplication(owner, diagnostics); await confirmObservedGone([owner.process().pid]); run.cleanupConfirmed = true; }
      catch (error) { run.cleanupFailure = error?.message || 'CLEANUP_FAILED'; failure ||= 'CLEANUP_FAILED'; }
      run.exit = { code: owner.process().exitCode, signal: owner.process().signalCode, shutdown: diagnostics.shutdown?.state ?? null };
    }
    stopObserving?.();
    // The synthetic profile is not evidence; remove it unless a process might still use it.
    run.profileRemoved = !owner || run.cleanupConfirmed === true;
    if (run.profileRemoved) fs.rmSync(parent, { recursive: true, force: true });
    run.startup = diagnostics.startup ?? null;
    run.status = failure ? 'FAIL' : (run.mappingFindings.length || run.executablesOutsideBundle.length) ? 'FAIL' : 'PASS';
    run.failure = failure; save();
  }
  return run;
}

function argumentsFor(argv) {
  assert(Array.isArray(argv) && (argv.length === 2 || argv.length === 3) && argv[0] === '--app', 'USAGE');
  assert(argv.length === 2 || argv[2] === '--packaged-app', 'USAGE');
  assert(typeof argv[1] === 'string' && path.isAbsolute(argv[1]) && path.basename(argv[1]) === 'Code Intelligence Validation.app', 'USAGE');
  assert.match(path.basename(path.dirname(argv[1])), /^\.native-product-[A-Za-z0-9]+$/);
  return { app: argv[1], packaged: argv.length === 3 };
}

async function main(argv = process.argv.slice(2)) {
  const options = argumentsFor(argv);
  assert.equal(process.platform, 'darwin'); assert.equal(process.arch, 'arm64'); process.umask(0o077);
  const repo = fs.realpathSync(path.resolve(__dirname, '../..')), app = fs.realpathSync(options.app);
  assert.equal(app, options.app); assert.equal(path.dirname(path.dirname(app)), repo);
  const runtime = path.join(app, 'Contents/Resources/runtime'), manifestFile = path.join(runtime, 'runtime-manifest.json');
  const { validateRuntimeManifest } = require('../../desktop/src/runtime-manifest.cjs');
  const manifest = JSON.parse(fs.readFileSync(manifestFile)); await validateRuntimeManifest(runtime, manifest);
  spawnSync('/usr/bin/codesign', ['--verify', '--deep', '--strict', app], { stdio: 'ignore' }).status === 0 || assert.fail('CODESIGN_VERIFY_FAILED');
  const { ensureOutputParent } = require('./owned-output.cjs');
  const evidence = fs.mkdtempSync(path.join(ensureOutputParent(repo, 'validation/local/native-update-readiness'), 'loader-'));
  const hash = file => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
  const report = { format: 1, scope: 'single-mac-clean-environment-approximation', freshMachine: false, app,
    buildSequence: manifest.buildSequence, manifestSha256: hash(manifestFile), appAsarSha256: hash(path.join(app, 'Contents/Resources/app.asar')),
    probeSha256: hash(__filename), evidence: path.relative(repo, evidence), observedAt: new Date().toISOString(),
    hostDeveloperRootsPresent: DEVELOPER_ROOTS.filter(root => fs.existsSync(root)) };
  const save = () => fs.writeFileSync(path.join(evidence, 'result.json'), JSON.stringify(report, null, 2) + '\n', { mode: 0o600 });
  save();
  const home = fs.mkdtempSync(path.join(evidence, 'home-'));
  try { report.services = serviceProbes(runtime, { home }); } finally { fs.rmSync(home, { recursive: true, force: true }); }
  save();
  console.log(JSON.stringify({ step: 'services', pass: report.services.pass, control: report.services.control,
    results: report.services.results.map(item => [item.command, item.plainExit, item.deniedExit, item.pass]) }));
  if (options.packaged) {
    const run = await packagedRun({ repo, app, runtime, report, save });
    console.log(JSON.stringify({ step: 'packaged', status: run.status, failure: run.failure, services: run.services,
      processCount: run.processCount, mappedEntries: run.mappedEntries, classes: run.mappingClasses, findings: run.mappingFindings,
      executablesOutsideBundle: run.executablesOutsideBundle, nonCode: run.nonCodeOutsideBundleAndOs, servicesWithBundleImages: run.servicesWithBundleImages,
      exit: run.exit, profileRoot: run.profileRoot }));
  }
  assert.equal(hash(manifestFile), report.manifestSha256); assert.equal(hash(path.join(app, 'Contents/Resources/app.asar')), report.appAsarSha256);
  report.bundleUnchanged = true;
  report.status = report.services.pass && (!options.packaged || report.packaged.status === 'PASS') ? 'PASS' : 'FAIL';
  report.finishedAt = new Date().toISOString(); save();
  console.log(JSON.stringify({ status: report.status, evidence: report.evidence }));
  if (report.status !== 'PASS') process.exitCode = 1;
  return report;
}

module.exports = { sandboxProfile, classifyMappedPath, parseLsof, evaluateMappings, argumentsFor, DEVELOPER_ROOTS, main };
if (require.main === module) main().catch(error => { console.error(error?.message?.match(/^[A-Z_]+$/) ? error.message : 'LOADER_PROBE_PREFLIGHT_FAILED'); process.exitCode = 1; });
