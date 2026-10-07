'use strict';

// Explicit offline development-candidate build, not a release or updater.
// Native/JRE dependencies come from a verified retained bundle. Analyzer dependencies
// can be restaged from a prefilled offline npm cache when the reviewed lock changes.
// Backend AND analyzer code are rebuilt offline and read back, not reused stale.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { createRequire } = require('node:module');
const { pathToFileURL } = require('node:url');
const { execFileSync, spawnSync } = require('node:child_process');
const { copyPrivateTree, dependencyInventory } = require('../../desktop/scripts/build-isolated.cjs');
const { validateRuntimeManifest } = require('../../desktop/src/runtime-manifest.cjs');
const { requireCapacity } = require('../../desktop/scripts/macos-runtime-supply.cjs');
const { ensureOutputParent, assertOutputPath } = require('./owned-output.cjs');
const { candidateSpaceBudget } = require('./candidate-capacity.cjs');
const { validationProviderTarget } = require('../../desktop/src/ai-https-transport.cjs');
const { adapterMode } = require('./adapter-mode.cjs');
const hash = file => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
// Validation-build-only fake-provider variant (G-COST PK-08): the candidate's AI transport targets this fixed
// loopback origin instead of the provider host. Release builds never carry it (build gate and main refuse it).
const VALIDATION_AI_PROVIDER_ORIGIN = 'http://127.0.0.1:47613';
const VALIDATION_APP_ID = 'dev.codeintelligence.desktop.validation';
const SOURCE_COPY_INPUTS = [
  ['frontend', ['src', 'public', 'index.html', 'package.json', 'package-lock.json']],
  ['desktop', ['src', 'scripts', 'build', 'package.json', 'package-lock.json']],
  ['analyzers/ts-analyzer', ['src', 'package.json', 'package-lock.json', 'tsconfig.json']],
];

function measureCandidateCopies(repo, originalRuntime, { adapterSupervisor = false } = {}) {
  const dependencies = {}, sources = {};
  for (const [component, entries] of SOURCE_COPY_INPUTS) {
    const dependency = dependencyInventory(path.join(repo, component, 'node_modules'));
    dependencies[component] = { bytes: dependency.bytes, sha256: dependency.sha256 };
    for (const entry of entries) {
      const name = component + '/' + entry, file = path.join(repo, name);
      if (!fs.existsSync(file)) { assert.equal(entry, 'public'); continue; }
      const stat = fs.lstatSync(file); assert(!stat.isSymbolicLink());
      if (stat.isDirectory()) {
        const inventory = dependencyInventory(file); sources[name] = { bytes: inventory.bytes, sha256: inventory.sha256 };
      } else { assert(stat.isFile() && stat.nlink === 1); sources[name] = { bytes: stat.size, sha256: hash(file) }; }
    }
  }
  const runtime = dependencyInventory(originalRuntime);
  const electron = dependencyInventory(path.join(repo, 'desktop/node_modules/electron/dist'));
  const input = { dependencyBytes: Object.values(dependencies).reduce((sum, value) => sum + value.bytes, 0),
    sourceBytes: Object.values(sources).reduce((sum, value) => sum + value.bytes, 0), runtimeBytes: runtime.bytes,
    electronBytes: electron.bytes, analyzerDependencyBytes: dependencies['analyzers/ts-analyzer'].bytes };
  return { dependencies, sources, runtime: { bytes: runtime.bytes, sha256: runtime.sha256 },
    electron: { bytes: electron.bytes, sha256: electron.sha256 }, input, budget: candidateSpaceBudget(input, { adapterSupervisor }) };
}

function ownedDirectory(plan, directory) {
  assert(typeof directory === 'string' && path.isAbsolute(directory) && path.normalize(directory) === directory);
  assert(directory.startsWith(plan.workRoot + path.sep));
  let cursor = plan.workRoot;
  for (const part of path.relative(plan.workRoot, directory).split(path.sep).filter(Boolean)) {
    cursor = path.join(cursor, part);
    const stat = fs.lstatSync(cursor);
    assert(stat.isDirectory() && !stat.isSymbolicLink());
    assert.equal(fs.realpathSync(cursor), cursor);
  }
}

function ownedDirectoryIdentity(plan, directory) {
  ownedDirectory(plan, directory);
  const result = [];
  let cursor = plan.workRoot;
  for (const part of path.relative(plan.workRoot, directory).split(path.sep).filter(Boolean)) {
    cursor = path.join(cursor, part);
    const stat = fs.lstatSync(cursor);
    result.push({ file: cursor, dev: stat.dev, ino: stat.ino, mode: stat.mode, uid: stat.uid, gid: stat.gid });
  }
  return result;
}

function assertOwnedDirectoryIdentity(plan, expected) {
  plan.assertIdentity();
  for (const item of expected) {
    ownedDirectory(plan, item.file);
    const stat = fs.lstatSync(item.file);
    assert.equal(stat.dev, item.dev); assert.equal(stat.ino, item.ino); assert.equal(stat.mode, item.mode);
    assert.equal(stat.uid, item.uid); assert.equal(stat.gid, item.gid);
  }
}

function noOverlap(...directories) {
  for (let left = 0; left < directories.length; left++) for (let right = left + 1; right < directories.length; right++) {
    const a = directories[left], b = directories[right];
    assert(a !== b && !a.startsWith(b + path.sep) && !b.startsWith(a + path.sep), 'ANALYZER_RUNTIME_PATH_OVERLAP');
  }
}

function regularFiles(directory) {
  const inventory = dependencyInventory(directory);
  assert(inventory.entries.every(entry => entry.link === undefined), 'ANALYZER_RUNTIME_LINK');
  return { inventory, files: Object.fromEntries(inventory.entries.filter(entry => entry.sha256).map(entry => [entry.path, entry.sha256])) };
}

function argumentsForCandidate(argv) {
  // ADR-01 `xpc-required` is an explicit option of this development build; the shipped default stays unchanged.
  const isolated = argv.length === 6;
  assert(argv.length === 4 || isolated); assert.equal(argv[0], '--app'); assert.equal(argv[2], '--build-sequence');
  assert.equal(typeof argv[1], 'string'); assert(path.isAbsolute(argv[1]));
  assert.equal(argv[3].match(/^[1-9][0-9]{0,18}$/)?.[0], argv[3]);
  assert(BigInt(argv[3]) <= 9223372036854775807n);
  if (isolated) { assert.equal(argv[4], '--adapter-isolation'); assert.equal(argv[5], 'xpc-required'); }
  return { app: argv[1], buildSequence: argv[3], ...(isolated ? { adapterIsolation: 'xpc-required' } : {}) };
}

/**
 * ADR-01 `xpc-required`: builds the adapter supervisor and bridge, assembles the service with the
 * staged analyzer as its worker (desktop/stage/adapter-supervisor, installed by afterPack and signed
 * by the signing hook), then removes the analyzer from the staged runtime and its manifest.
 */
async function stageAdapterSupervisor({ plan, runtime, desktop, manifest, appId, version,
  supervisor = require('../../desktop/scripts/adapter-supervisor.cjs') }) {
  plan.assertIdentity();
  const analyzer = path.join(runtime, 'ts-analyzer'), destination = path.join(desktop, 'stage', 'adapter-supervisor');
  ownedDirectory(plan, runtime); ownedDirectory(plan, desktop); ownedDirectory(plan, analyzer);
  noOverlap(analyzer, destination);
  assert(!fs.existsSync(destination), 'ADAPTER_SUPERVISOR_STAGE_EXISTS');
  const analyzerTree = regularFiles(analyzer);
  fs.mkdirSync(destination, { mode: 0o700 });
  const binaries = supervisor.compile(path.join(destination, 'bin'));
  const bundle = await supervisor.assembleService({ destination, binaries, analyzer, appId, version,
    electronApp: path.join(desktop, 'node_modules/electron/dist/Electron.app') });
  assert.equal(bundle, path.join(destination, 'AdapterSupervisor.xpc'), 'ADAPTER_SUPERVISOR_STAGE_UNEXPECTED');
  const copied = regularFiles(path.join(bundle, 'Contents/Resources/ts-analyzer'));
  assert.equal(copied.inventory.sha256, analyzerTree.inventory.sha256, 'ADAPTER_SUPERVISOR_ANALYZER_COPY_CHANGED');
  const removed = Object.keys(manifest.files).filter(name => name.startsWith('ts-analyzer/'));
  assert.deepEqual(removed.sort(), Object.keys(analyzerTree.files).map(name => 'ts-analyzer/' + name).sort(), 'ADAPTER_SUPERVISOR_ANALYZER_INVENTORY');
  plan.assertIdentity(); ownedDirectory(plan, analyzer);
  fs.rmSync(analyzer, { recursive: true });
  const files = Object.fromEntries(Object.entries(manifest.files).filter(([name]) => !name.startsWith('ts-analyzer/')));
  return { manifest: { ...manifest, files }, evidence: { adapterIsolation: 'xpc-required', stage: destination,
    analyzerTreeSha256: analyzerTree.inventory.sha256, runtimeFilesRemoved: removed.length } };
}

// The reused runtime carries the baseline's reviewed Flyway files for backup staging. A newer source
// may only append migrations: every staged file must be unchanged and every added one must sort after
// the last staged version; the manifest gains the exact hash of each appended file.
const MIGRATION_NAME = /^V([0-9]+)__[A-Za-z0-9_]+\.sql$/;
function replaceBackupMigrations(plan, runtime, source, manifest) {
  plan.assertIdentity();
  const target = path.join(runtime, 'backend/backup-migrations');
  ownedDirectory(plan, runtime); ownedDirectory(plan, target);
  const version = name => {
    const match = MIGRATION_NAME.exec(name); if (!match) assert.fail('BACKUP_MIGRATION_NAME'); return Number(match[1]);
  };
  const staged = fs.readdirSync(target).sort((a, b) => version(a) - version(b));
  const wanted = fs.readdirSync(source).sort((a, b) => version(a) - version(b));
  for (const name of staged) {
    if (!wanted.includes(name) || hash(path.join(source, name)) !== hash(path.join(target, name))) assert.fail('BACKUP_MIGRATION_CHANGED');
  }
  const last = staged.length ? version(staged[staged.length - 1]) : 0, added = wanted.filter(name => !staged.includes(name));
  if (added.some(name => version(name) <= last)) assert.fail('BACKUP_MIGRATION_ORDER');
  const files = { ...manifest.files };
  for (const name of added) {
    const file = path.join(source, name), stat = fs.lstatSync(file);
    assert(stat.isFile() && !stat.isSymbolicLink(), 'BACKUP_MIGRATION_NAME');
    const copied = path.join(target, name); fs.copyFileSync(file, copied, fs.constants.COPYFILE_EXCL); fs.chmodSync(copied, 0o644);
    files['backend/backup-migrations/' + name] = hash(copied); assert.equal(files['backend/backup-migrations/' + name], hash(file));
  }
  return { manifest: added.length ? { ...manifest, files } : manifest, evidence: { added } };
}

function replaceAnalyzerBuild(plan, runtime, compiled, manifest) {
  plan.assertIdentity();
  ownedDirectory(plan, runtime); ownedDirectory(plan, compiled);
  const target = path.join(runtime, 'ts-analyzer/dist'), previous = path.join(plan.workRoot, 'previous-analyzer-dist');
  ownedDirectory(plan, path.dirname(target)); ownedDirectory(plan, target);
  try { fs.lstatSync(previous); assert.fail('PREVIOUS_ANALYZER_OUTPUT_EXISTS'); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  const built = dependencyInventory(compiled);
  assert(built.entries.length > 0 && built.entries.length < 1000);
  assert(built.entries.every(entry => !entry.link && (entry.directory || /\.js(?:\.map)?$/.test(entry.path))));
  assert(built.entries.some(entry => entry.path === 'main.js' && entry.sha256));
  const files = { ...manifest.files };
  for (const name of Object.keys(files)) if (name.startsWith('ts-analyzer/dist/')) delete files[name];
  for (const entry of built.entries) if (entry.sha256) files['ts-analyzer/dist/' + entry.path] = entry.sha256;
  // Retain the old *staged copy*, never mutate the baseline app or reuse stale JS.
  fs.renameSync(target, previous);
  const copied = copyPrivateTree(plan, compiled, target);
  assert.equal(copied.sha256, built.sha256);
  return { manifest: { ...manifest, files }, evidence: { codeRebuilt: true, dependenciesRestaged: false,
    compiledDigest: built.sha256, files: built.entries.filter(entry => entry.sha256).length,
    fileHashes: Object.fromEntries(built.entries.filter(entry => entry.sha256).map(entry => [entry.path, entry.sha256])) } };
}

function replaceAnalyzerRuntime(plan, runtime, compiled, production, manifest, expectedInputs, io = fs) {
  plan.assertIdentity();
  const inputIdentities = [runtime, compiled, production].flatMap(directory => ownedDirectoryIdentity(plan, directory));
  const target = path.join(runtime, 'ts-analyzer');
  inputIdentities.push(...ownedDirectoryIdentity(plan, target));
  const runtimeIdentity = fs.lstatSync(runtime), targetIdentity = fs.lstatSync(target);
  noOverlap(runtime, compiled, production);
  const previous = path.join(plan.workRoot, 'previous-analyzer-runtime');
  const prepared = path.join(plan.workRoot, 'prepared-analyzer-runtime');
  for (const reserved of [previous, prepared]) {
    try { fs.lstatSync(reserved); assert.fail('ANALYZER_RUNTIME_RESERVED_EXISTS'); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  const oldTree = regularFiles(target);
  assert(oldTree.inventory.entries.length > 0, 'ANALYZER_RUNTIME_EMPTY_BASELINE');
  const built = regularFiles(compiled);
  assert(built.inventory.entries.length > 0 && built.inventory.entries.length < 1000);
  assert(built.inventory.entries.every(entry => entry.directory || /\.js(?:\.map)?$/.test(entry.path)));
  assert(Object.hasOwn(built.files, 'main.js'));
  const productionTree = regularFiles(production);
  assert(productionTree.inventory.entries.length > 2 && Object.hasOwn(productionTree.files, 'package.json')
    && Object.hasOwn(productionTree.files, 'package-lock.json'));
  assert(productionTree.inventory.entries.every(entry => entry.path === 'package.json' || entry.path === 'package-lock.json'
    || entry.path === 'node_modules' || entry.path.startsWith('node_modules' + path.sep)), 'ANALYZER_PRODUCTION_UNEXPECTED');
  assert(Object.keys(productionTree.files).some(name => name.startsWith('node_modules/')), 'ANALYZER_PRODUCTION_EMPTY');
  assert(expectedInputs && productionTree.files['package.json'] === expectedInputs.packageJsonSha256
    && productionTree.files['package-lock.json'] === expectedInputs.packageLockSha256, 'ANALYZER_DEPENDENCY_INPUT_CHANGED');
  const pkg = JSON.parse(fs.readFileSync(path.join(production, 'package.json')));
  const lock = JSON.parse(fs.readFileSync(path.join(production, 'package-lock.json'))), lockRoot = lock.packages?.[''];
  assert(typeof pkg.name === 'string' && typeof pkg.version === 'string'
    && lock.name === pkg.name && lock.version === pkg.version && lockRoot?.name === pkg.name && lockRoot?.version === pkg.version,
  'ANALYZER_LOCK_ROOT_MISMATCH');
  const proxyLock = lock.packages?.['node_modules/proxy-addr'];
  const proxyFile = path.join(production, 'node_modules/proxy-addr/package.json');
  assert(proxyLock && typeof proxyLock.version === 'string' && fs.existsSync(proxyFile), 'ANALYZER_PROXY_ADDR_MISSING');
  const proxyPackage = JSON.parse(fs.readFileSync(proxyFile));
  assert.equal(proxyPackage.name, 'proxy-addr'); assert.equal(proxyPackage.version, proxyLock.version, 'ANALYZER_PROXY_ADDR_MISMATCH');
  plan.assertIdentity();
  const copiedProduction = copyPrivateTree(plan, production, prepared);
  assert.equal(copiedProduction.sha256, productionTree.inventory.sha256);
  const copiedBuild = copyPrivateTree(plan, compiled, path.join(prepared, 'dist'));
  assert.equal(copiedBuild.sha256, built.inventory.sha256);
  const preparedTree = regularFiles(prepared);
  const expected = { ...productionTree.files, ...Object.fromEntries(Object.entries(built.files).map(([name, digest]) => ['dist/' + name, digest])) };
  assert.deepEqual(preparedTree.files, expected);
  const files = { ...manifest.files };
  for (const name of Object.keys(files)) if (name.startsWith('ts-analyzer/')) delete files[name];
  for (const [name, digest] of Object.entries(preparedTree.files)) files['ts-analyzer/' + name] = digest;
  assertOwnedDirectoryIdentity(plan, inputIdentities); ownedDirectory(plan, prepared);
  io.renameSync(target, previous);
  try {
    io.renameSync(prepared, target);
  } catch (error) {
    let rollbackCode = 'ANALYZER_RUNTIME_ROLLBACK_FAILED';
    try {
      plan.assertIdentity();
      assertOwnedDirectoryIdentity(plan, inputIdentities.filter(item => item.file !== target));
      const parentNow = fs.lstatSync(runtime);
      assert(parentNow.isDirectory() && !parentNow.isSymbolicLink() && parentNow.dev === runtimeIdentity.dev
        && parentNow.ino === runtimeIdentity.ino && parentNow.mode === runtimeIdentity.mode
        && parentNow.uid === runtimeIdentity.uid && parentNow.gid === runtimeIdentity.gid,
      'ANALYZER_RUNTIME_ROLLBACK_PARENT_CHANGED');
      let targetAbsent = false;
      try { io.lstatSync(target); } catch (lookup) { if (lookup.code === 'ENOENT') targetAbsent = true; else throw lookup; }
      if (!targetAbsent) rollbackCode = 'ANALYZER_RUNTIME_ROLLBACK_BLOCKED';
      else {
        const previousStat = fs.lstatSync(previous);
        assert(previousStat.isDirectory() && !previousStat.isSymbolicLink()
          && previousStat.dev === targetIdentity.dev && previousStat.ino === targetIdentity.ino,
        'ANALYZER_RUNTIME_ROLLBACK_PREVIOUS_CHANGED');
        io.renameSync(previous, target);
        rollbackCode = 'ANALYZER_RUNTIME_ROLLBACK_RESTORED';
      }
    } catch (rollbackError) {
      if (rollbackCode !== 'ANALYZER_RUNTIME_ROLLBACK_BLOCKED') rollbackCode = 'ANALYZER_RUNTIME_ROLLBACK_FAILED';
    }
    try { error.rollbackCode = rollbackCode; } catch { /* Preserve an immutable primary error. */ }
    throw error;
  }
  plan.assertIdentity();
  return { manifest: { ...manifest, files }, evidence: { codeRebuilt: true, dependenciesRestaged: true,
    compiledDigest: built.inventory.sha256, productionDigest: productionTree.inventory.sha256,
    files: Object.keys(built.files).length, fileHashes: built.files,
    runtimeFiles: Object.keys(preparedTree.files).length, productionFiles: Object.keys(productionTree.files).length,
    packageJsonSha256: expectedInputs.packageJsonSha256, packageLockSha256: expectedInputs.packageLockSha256,
    proxyAddrVersion: proxyPackage.version } };
}
async function main(argv = process.argv.slice(2)) {
  const options = argumentsForCandidate(argv);
  assert.equal(process.platform, 'darwin'); assert.equal(process.arch, 'arm64'); assert(process.getuid() > 0);
  process.umask(0o077);
  const repo = fs.realpathSync(path.resolve(__dirname, '../..')), baseline = fs.realpathSync(options.app);
  assert.equal(baseline, options.app); assert.equal(path.basename(baseline), 'Code Intelligence Validation.app');
  assert.equal(path.dirname(path.dirname(baseline)), repo);
  assert.match(path.basename(path.dirname(baseline)), /^\.native-product-[A-Za-z0-9]+$/);
  const originalRuntime = path.join(baseline, 'Contents/Resources/runtime'), originalManifestFile = path.join(originalRuntime, 'runtime-manifest.json');
  const originalManifest = JSON.parse(fs.readFileSync(originalManifestFile));
  assert(BigInt(options.buildSequence) > BigInt(originalManifest.buildSequence));
  await validateRuntimeManifest(originalRuntime, originalManifest);
  execFileSync('/usr/bin/codesign', ['--verify', '--deep', '--strict', baseline], { stdio: 'pipe', timeout: 30000 });
  // Full native provisioning retains its 8GiB floor. This path reuses a verified
  // runtime and measures its distinct copies before applying a separate allowance.
  const copyMeasurements = measureCandidateCopies(repo, originalRuntime, { adapterSupervisor: options.adapterIsolation === 'xpc-required' });
  const capacity = requireCapacity(repo, { minimumBytes: BigInt(copyMeasurements.budget.requiredFreeBytes) });
  console.log(JSON.stringify({ status: 'CANDIDATE_CAPACITY', availableBytes: capacity.availableBytes,
    budget: copyMeasurements.budget }));
  const base = ensureOutputParent(repo, 'validation/local/pre-release-candidate');
  const evidence = fs.mkdtempSync(path.join(base, 'build-')), work = path.join(evidence, 'work');
  fs.mkdirSync(work, { mode: 0o700 }); const identity = fs.lstatSync(work);
  const plan = { workRoot: work, assertIdentity() {
    const now = fs.lstatSync(work); assert(now.isDirectory() && !now.isSymbolicLink());
    assert.equal(now.dev, identity.dev); assert.equal(now.ino, identity.ino); assert.equal(fs.realpathSync(work), work);
  } };
  const sourceRoots = ['backend/src/main', 'frontend/src', 'desktop/src', 'analyzers/ts-analyzer/src'];
  const buildInputs = ['backend/build.gradle.kts', 'backend/settings.gradle.kts', 'backend/gradle/wrapper/gradle-wrapper.properties',
    'frontend/package.json', 'frontend/package-lock.json', 'desktop/package.json', 'desktop/package-lock.json',
    'analyzers/ts-analyzer/package.json', 'analyzers/ts-analyzer/package-lock.json', 'analyzers/ts-analyzer/tsconfig.json'];
  const sourceDigests = () => Object.fromEntries([
    ...sourceRoots.map(name => [name, dependencyInventory(path.join(repo, name)).sha256]),
    ...buildInputs.map(name => [name, hash(path.join(repo, name))]),
  ]);
  const report = { format: 1, status: 'BUILDING', scope: 'offline-source-development-candidate', evidence, work, baseline,
    sourceCommit: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repo, encoding: 'utf8' }).trim(),
    sourceWorkingTree: Boolean(execFileSync('git', ['status', '--porcelain', '--', ...sourceRoots, ...buildInputs], { cwd: repo, encoding: 'utf8' }).trim()),
    gradleEnvironment: 'existing checkout and user Gradle cache/configuration; not a hermetic Gradle home',
    sources: sourceDigests(), capacity, copyMeasurements, buildSequence: options.buildSequence, javaRecompiled: true, nativeRebuilt: false,
    adapterIsolation: options.adapterIsolation ?? 'legacy-http',
    realKeychain: false, formalSigning: false, notarized: false, released: false,
    baselineHashes: { manifest: hash(originalManifestFile), asar: hash(path.join(baseline, 'Contents/Resources/app.asar')) } };
  const save = () => fs.writeFileSync(assertOutputPath(evidence, path.join(evidence, 'result.json')), JSON.stringify(report, null, 2) + '\n', { mode: 0o600 });
  save(); console.log(JSON.stringify({ status: report.status, evidence }));
  const fixedEnv = { PATH: '/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin', LANG: 'C', LC_ALL: 'C' };
  function run(command, args, cwd, logName, env, timeout = 300000) {
    plan.assertIdentity(); const fd = fs.openSync(path.join(evidence, logName + '.log'), 'wx', 0o600);
    let result; try { result = spawnSync(command, args, { cwd, env, stdio: ['ignore', fd, fd], timeout }); }
    finally { fs.closeSync(fd); }
    report.commands ??= []; report.commands.push({ step: logName, exit: result.status, signal: result.signal, error: result.error?.code || null }); save();
    assert.equal(result.status, 0, logName + '_FAILED'); assert.equal(result.signal, null); plan.assertIdentity();
  }
  try {
    // Do not source .env. The existing Gradle cache/toolchain is used offline.
    run(path.join(repo, 'backend/gradlew'), ['--offline', '--no-daemon', 'spotlessCheck', 'bootJar'], path.join(repo, 'backend'), 'backend',
      { ...fixedEnv, HOME: process.env.HOME }, 300000);
    const jars = fs.readdirSync(path.join(repo, 'backend/build/libs'))
      .filter(n => n.endsWith('.jar') && !n.endsWith('-plain.jar') && n !== 'code-intelligence-control.jar');
    assert.equal(jars.length, 1);
    const originalJar = path.join(repo, 'backend/build/libs', jars[0]); report.compiledJarSha256 = hash(originalJar);
    const controlJar = path.join(repo, 'backend/build/libs/code-intelligence-control.jar');
    const controlProvenance = path.join(repo, 'backend/build/libs/code-intelligence-control-provenance.json');
    const { verifyControlSourceMembers } = require('./control-runtime.cjs');
    report.control = await verifyControlSourceMembers({ jarFile: controlJar, provenanceFile: controlProvenance,
      classRoot: path.join(repo, 'backend/build/classes/java/main'), backendJarFile: originalJar });
    save();
    const frontend = path.join(work, 'frontend'), desktop = path.join(work, 'desktop'), analyzer = path.join(work, 'analyzers/ts-analyzer');
    for (const dir of [frontend, desktop, path.join(work, 'home'), path.join(work, 'tmp'), path.join(work, 'cache')]) fs.mkdirSync(dir, { mode: 0o700 });
    fs.mkdirSync(analyzer, { recursive: true, mode: 0o700 });
    for (const [component, entries] of SOURCE_COPY_INPUTS) {
      for (const entry of entries) {
        const from = path.join(repo, component, entry); if (!fs.existsSync(from)) { assert.equal(entry, 'public'); continue; }
        const to = path.join(work, component, entry);
        fs.cpSync(from, to, { recursive: true, force: false, errorOnExist: true });
        const copied = fs.lstatSync(to).isDirectory() ? dependencyInventory(to).sha256 : hash(to);
        assert.equal(copied, copyMeasurements.sources[component + '/' + entry].sha256, 'CANDIDATE_SOURCE_CHANGED_AFTER_CAPACITY_MEASUREMENT');
      }
      report[component + 'Dependencies'] = copyPrivateTree(plan, path.join(repo, component, 'node_modules'), path.join(work, component, 'node_modules'));
      assert.equal(report[component + 'Dependencies'].sha256, copyMeasurements.dependencies[component].sha256,
        'CANDIDATE_DEPENDENCIES_CHANGED_AFTER_CAPACITY_MEASUREMENT');
      save();
    }
    const requireFrontend = createRequire(path.join(frontend, 'package.json'));
    const { build } = await import(pathToFileURL(requireFrontend.resolve('vite')).href);
    const { default: react } = await import(pathToFileURL(requireFrontend.resolve('@vitejs/plugin-react')).href);
    const { default: tailwind } = await import(pathToFileURL(requireFrontend.resolve('@tailwindcss/vite')).href);
    await build({ root: frontend, configFile: false, envDir: false, plugins: [react(), tailwind()],
      build: { outDir: path.join(frontend, 'dist'), emptyOutDir: false } });
    report.frontendBuilt = true; save();
    run(process.execPath, [path.join(analyzer, 'node_modules/typescript/bin/tsc'), '-p', 'tsconfig.json'], analyzer, 'analyzer-build',
      { ...fixedEnv, HOME: path.join(work, 'home'), TMPDIR: path.join(work, 'tmp') }, 120000);
    const stage = path.join(desktop, 'stage/runtime'); fs.mkdirSync(path.dirname(stage), { mode: 0o700 });
    fs.cpSync(originalRuntime, stage, { recursive: true, force: false, errorOnExist: true });
    await validateRuntimeManifest(stage, originalManifest);
    const targetJar = path.join(stage, 'backend/code-intelligence.jar'), temporaryJar = path.join(stage, 'backend/candidate.jar');
    run('/usr/bin/python3', [path.join(__dirname, 'replace-candidate-static.py'), originalJar, temporaryJar, path.join(frontend, 'dist'),
      path.join(repo, 'backend/build/classes/java/main'), path.join(repo, 'backend/src/main/resources/db/migration'), path.join(evidence, 'jar-readback.json'), evidence],
      work, 'jar-readback', { ...fixedEnv, HOME: path.join(work, 'home'), TMPDIR: path.join(work, 'tmp') }, 120000);
    const readback = JSON.parse(fs.readFileSync(path.join(evidence, 'jar-readback.json'))); assert.equal(readback.status, 'PASS');
    assert.equal(hash(originalJar), report.compiledJarSha256); fs.renameSync(temporaryJar, targetJar); report.jar = readback;
    const migrations = replaceBackupMigrations(plan, stage, path.join(repo, 'backend/src/main/resources/db/migration'), originalManifest);
    report.backupMigrationsAdded = migrations.evidence.added; save();
    for (const name of fs.readdirSync(path.join(repo, 'backend/src/main/resources/db/migration')))
      assert.equal(hash(path.join(repo, 'backend/src/main/resources/db/migration', name)), hash(path.join(stage, 'backend/backup-migrations', name)));
    const analyzerInputs = { packageJsonSha256: hash(path.join(analyzer, 'package.json')),
      packageLockSha256: hash(path.join(analyzer, 'package-lock.json')) };
    const analyzerDependenciesChanged = analyzerInputs.packageJsonSha256 !== hash(path.join(stage, 'ts-analyzer/package.json'))
      || analyzerInputs.packageLockSha256 !== hash(path.join(stage, 'ts-analyzer/package-lock.json'));
    let replacement;
    if (!analyzerDependenciesChanged) {
      replacement = replaceAnalyzerBuild(plan, stage, path.join(analyzer, 'dist'), migrations.manifest);
    } else {
      const production = path.join(work, 'analyzer-production');
      fs.mkdirSync(production, { mode: 0o700 });
      for (const name of ['package.json', 'package-lock.json']) {
        fs.copyFileSync(path.join(analyzer, name), path.join(production, name), fs.constants.COPYFILE_EXCL);
      }
      const npmUserConfig = path.join(work, 'npm-userconfig'), npmGlobalConfig = path.join(work, 'npm-globalconfig');
      fs.writeFileSync(npmUserConfig, '', { flag: 'wx', mode: 0o600 });
      fs.writeFileSync(npmGlobalConfig, '', { flag: 'wx', mode: 0o600 });
      const npmCache = ensureOutputParent(repo, 'validation/local/pre-release-cache/npm');
      run('npm', ['ci', '--omit=dev', '--ignore-scripts', '--bin-links=false', '--offline', '--no-audit', '--no-fund'],
        production, 'analyzer-production-dependencies', { ...fixedEnv, HOME: path.join(work, 'home'), TMPDIR: path.join(work, 'tmp'),
          npm_config_userconfig: npmUserConfig, npm_config_globalconfig: npmGlobalConfig, npm_config_cache: npmCache,
          npm_config_offline: 'true', npm_config_audit: 'false', npm_config_fund: 'false', NPM_CONFIG_UPDATE_NOTIFIER: 'false' }, 120000);
      assert.equal(hash(path.join(production, 'package.json')), analyzerInputs.packageJsonSha256, 'ANALYZER_DEPENDENCY_INPUT_CHANGED');
      assert.equal(hash(path.join(production, 'package-lock.json')), analyzerInputs.packageLockSha256, 'ANALYZER_DEPENDENCY_INPUT_CHANGED');
      replacement = replaceAnalyzerRuntime(plan, stage, path.join(analyzer, 'dist'), production, migrations.manifest, analyzerInputs);
    }
    report.analyzer = replacement.evidence;
    const previousControl = path.join(work, 'previous-control-runtime');
    fs.mkdirSync(previousControl, { mode: 0o700 });
    for (const file of [controlJar, controlProvenance]) {
      const target = path.join(stage, 'backend', path.basename(file));
      try {
        fs.lstatSync(target);
        fs.copyFileSync(target, path.join(previousControl, path.basename(file)), fs.constants.COPYFILE_EXCL);
        fs.rmSync(target);
      } catch (error) { if (error.code !== 'ENOENT') throw error; }
      fs.copyFileSync(file, target, fs.constants.COPYFILE_EXCL);
      assert.equal(hash(file), hash(target));
    }
    let runtimeManifest = replacement.manifest;
    if (options.adapterIsolation === 'xpc-required') {
      // The hooks of the copied desktop read the flag from its package.json (also packed into app.asar).
      const packageFile = path.join(desktop, 'package.json'), desktopPackage = JSON.parse(fs.readFileSync(packageFile));
      fs.writeFileSync(packageFile, JSON.stringify({ ...desktopPackage, adapterIsolation: 'xpc-required' }, null, 2) + '\n');
      const staged = await stageAdapterSupervisor({ plan, runtime: stage, desktop, manifest: replacement.manifest,
        appId: VALIDATION_APP_ID, version: desktopPackage.version });
      runtimeManifest = staged.manifest; report.adapterSupervisor = staged.evidence; save();
    }
    const manifest = { ...runtimeManifest, buildSequence: options.buildSequence, controlProtocol: 1,
      files: { ...runtimeManifest.files, 'backend/code-intelligence.jar': hash(targetJar),
        'backend/code-intelligence-control.jar': report.control.jarSha256,
        'backend/code-intelligence-control-provenance.json': report.control.provenanceSha256 } };
    fs.writeFileSync(path.join(stage, 'runtime-manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
    await validateRuntimeManifest(stage, manifest);
    const retained = fs.mkdtempSync(path.join(repo, '.native-product-')); report.retained = retained; save();
    const pkg = JSON.parse(fs.readFileSync(path.join(desktop, 'package.json'))), baseBuild = pkg.build;
    const config = candidatePackagerConfig(baseBuild, retained, desktop);
    report.validationAiProviderOrigin = config.extraMetadata.validationAiProviderOrigin;
    const configFile = path.join(desktop, 'candidate-config.json'); fs.writeFileSync(configFile, JSON.stringify(config, null, 2), { flag: 'wx' });
    run(process.execPath, [path.join(desktop, 'node_modules/electron-builder/out/cli/cli.js'), '--mac', 'dir', '--arm64', '--publish', 'never', '--config', configFile],
      desktop, 'packager', { ...fixedEnv, HOME: path.join(work, 'home'), TMPDIR: path.join(work, 'tmp'),
        CSC_IDENTITY_AUTO_DISCOVERY: 'false', NPM_CONFIG_UPDATE_NOTIFIER: 'false', NPM_CONFIG_OFFLINE: 'true', ELECTRON_BUILDER_CACHE: path.join(work, 'cache') });
    const app = path.join(retained, 'Code Intelligence Validation.app'); fs.renameSync(path.join(retained, 'mac-arm64/Code Intelligence Validation.app'), app);
    const asarFile = path.join(app, 'Contents/Resources/app.asar'), asar = createRequire(path.join(desktop, 'package.json'))('@electron/asar');
    const packagedMetadata = JSON.parse(asar.extractFile(asarFile, 'package.json'));
    assert.equal(packagedMetadata.validationAiProviderOrigin, VALIDATION_AI_PROVIDER_ORIGIN);
    assert.deepEqual(validationProviderTarget(packagedMetadata), { hostname: '127.0.0.1', family: 4, port: 47613 });
    report.verifiedProductSource = {};
    for (const name of fs.readdirSync(path.join(repo, 'desktop/src')).filter(n => n.endsWith('.cjs'))) {
      assert(asar.extractFile(asarFile, 'src/' + name).equals(fs.readFileSync(path.join(repo, 'desktop/src', name))));
      report.verifiedProductSource[name] = hash(path.join(repo, 'desktop/src', name));
    }
    const appRuntime = path.join(app, 'Contents/Resources/runtime'), finalManifestFile = path.join(appRuntime, 'runtime-manifest.json');
    await validateRuntimeManifest(appRuntime, JSON.parse(fs.readFileSync(finalManifestFile)));
    assert.equal(hash(path.join(appRuntime, 'backend/code-intelligence.jar')), readback.candidateJarSha256);
    // The Java/static readback already proves that the candidate retains every
    // non-static backend member, including these original dependency archives.
    assert.deepEqual(await verifyControlSourceMembers({ jarFile: path.join(appRuntime, 'backend/code-intelligence-control.jar'),
      provenanceFile: path.join(appRuntime, 'backend/code-intelligence-control-provenance.json'),
      classRoot: path.join(repo, 'backend/build/classes/java/main'), backendJarFile: originalJar }), report.control);
    const isolated = options.adapterIsolation === 'xpc-required';
    assert.equal(adapterMode(app), isolated ? 'xpc-required' : 'legacy-http', 'ADAPTER_ISOLATION_PACKAGING');
    assert.equal(packagedMetadata.adapterIsolation, isolated ? 'xpc-required' : undefined, 'ADAPTER_ISOLATION_PACKAGING');
    if (isolated) {
      assert.equal(fs.existsSync(path.join(appRuntime, 'ts-analyzer')), false, 'ADAPTER_ISOLATION_PACKAGING');
      const section = JSON.parse(fs.readFileSync(finalManifestFile)).adapterSupervisor;
      assert.equal(section?.format, 1, 'ADAPTER_ISOLATION_PACKAGING');
      report.adapterSupervisor.packaged = section; save();
    }
    const analyzerRoot = isolated ? path.join(app, 'Contents/XPCServices/AdapterSupervisor.xpc/Contents/Resources/ts-analyzer')
      : path.join(appRuntime, 'ts-analyzer');
    for (const [name, expected] of Object.entries(report.analyzer.fileHashes))
      assert.equal(hash(path.join(analyzerRoot, 'dist', name)), expected);
    if (report.analyzer.dependenciesRestaged) {
      assert.equal(hash(path.join(analyzerRoot, 'package.json')), report.analyzer.packageJsonSha256);
      assert.equal(hash(path.join(analyzerRoot, 'package-lock.json')), report.analyzer.packageLockSha256);
      const shippedProxy = JSON.parse(fs.readFileSync(path.join(analyzerRoot, 'node_modules/proxy-addr/package.json')));
      assert.equal(shippedProxy.name, 'proxy-addr'); assert.equal(shippedProxy.version, report.analyzer.proxyAddrVersion);
    }
    execFileSync('/usr/bin/codesign', ['--verify', '--deep', '--strict', app], { stdio: 'pipe', timeout: 30000 });
    assert.deepEqual(sourceDigests(), report.sources);
    assert.equal(hash(originalManifestFile), report.baselineHashes.manifest);
    assert.equal(hash(path.join(baseline, 'Contents/Resources/app.asar')), report.baselineHashes.asar);
    report.capacityAfter = requireCapacity(repo, { minimumBytes: 2n * 1024n ** 3n });
    report.app = app; report.appAsarSha256 = hash(asarFile); report.manifestSha256 = hash(finalManifestFile);
    report.status = 'PACKAGED_NOT_RELEASED'; report.sourceAndBaselineUnchanged = true; save();
    console.log(JSON.stringify({ status: report.status, evidence, app, buildSequence: report.buildSequence }));
    return report;
  } catch (error) {
    report.status = 'FAIL'; report.failure = error.code || error.name;
    if (['ANALYZER_RUNTIME_ROLLBACK_RESTORED', 'ANALYZER_RUNTIME_ROLLBACK_FAILED', 'ANALYZER_RUNTIME_ROLLBACK_BLOCKED'].includes(error.rollbackCode)) {
      report.safeError = error.rollbackCode;
    }
    save(); throw error;
  }
}
function candidatePackagerConfig(baseBuild, output, desktop) {
  return { ...baseBuild, productName: 'Code Intelligence Validation', appId: VALIDATION_APP_ID,
    extraMetadata: { name: 'code-intelligence-validation', productName: 'Code Intelligence Validation',
      validationAiProviderOrigin: VALIDATION_AI_PROVIDER_ORIGIN },
    directories: { output }, mac: { ...baseBuild.mac, identity: '-', notarize: false },
    npmRebuild: false, nodeGypRebuild: false, buildDependenciesFromSource: false, electronDist: path.join(desktop, 'node_modules/electron/dist') };
}
module.exports = { VALIDATION_AI_PROVIDER_ORIGIN, argumentsForCandidate, candidatePackagerConfig, replaceAnalyzerBuild, replaceBackupMigrations,
  replaceAnalyzerRuntime, stageAdapterSupervisor, main };
if (require.main === module) main().catch(error => { console.error(error.code || error.name); process.exitCode = 1; });
