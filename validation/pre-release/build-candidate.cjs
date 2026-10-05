'use strict';

// Explicit offline development-candidate build, not a release or updater.
// Native/JRE and analyzer dependencies come from a verified retained bundle;
// backend AND analyzer code are rebuilt offline and read back, not reused stale.
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
const hash = file => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');

function argumentsForCandidate(argv) {
  assert.equal(argv.length, 4); assert.equal(argv[0], '--app'); assert.equal(argv[2], '--build-sequence');
  assert.equal(typeof argv[1], 'string'); assert(path.isAbsolute(argv[1]));
  assert.equal(argv[3].match(/^[1-9][0-9]{0,18}$/)?.[0], argv[3]);
  assert(BigInt(argv[3]) <= 9223372036854775807n);
  return { app: argv[1], buildSequence: argv[3] };
}

function replaceAnalyzerBuild(plan, runtime, compiled, manifest) {
  plan.assertIdentity();
  const ownedDirectory = directory => {
    assert(directory.startsWith(plan.workRoot + path.sep));
    assert.equal(fs.realpathSync(directory), directory);
    const stat = fs.lstatSync(directory); assert(stat.isDirectory() && !stat.isSymbolicLink());
  };
  ownedDirectory(runtime); ownedDirectory(compiled);
  const target = path.join(runtime, 'ts-analyzer/dist'), previous = path.join(plan.workRoot, 'previous-analyzer-dist');
  ownedDirectory(path.dirname(target)); ownedDirectory(target);
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
  return { manifest: { ...manifest, files }, evidence: { codeRebuilt: true,
    compiledDigest: built.sha256, files: built.entries.filter(entry => entry.sha256).length,
    fileHashes: Object.fromEntries(built.entries.filter(entry => entry.sha256).map(entry => [entry.path, entry.sha256])) } };
}
async function main(argv = process.argv.slice(2)) {
  const options = argumentsForCandidate(argv);
  assert.equal(process.platform, 'darwin'); assert.equal(process.arch, 'arm64'); assert(process.getuid() > 0);
  process.umask(0o077);
  const repo = fs.realpathSync(path.resolve(__dirname, '../..')), baseline = fs.realpathSync(options.app);
  assert.equal(baseline, options.app); assert.equal(path.basename(baseline), 'Code Intelligence Validation.app');
  assert.equal(path.dirname(path.dirname(baseline)), repo);
  assert.match(path.basename(path.dirname(baseline)), /^\.native-product-[A-Za-z0-9]+$/);
  requireCapacity(repo);
  const originalRuntime = path.join(baseline, 'Contents/Resources/runtime'), originalManifestFile = path.join(originalRuntime, 'runtime-manifest.json');
  const originalManifest = JSON.parse(fs.readFileSync(originalManifestFile));
  assert(BigInt(options.buildSequence) > BigInt(originalManifest.buildSequence));
  await validateRuntimeManifest(originalRuntime, originalManifest);
  execFileSync('/usr/bin/codesign', ['--verify', '--deep', '--strict', baseline], { stdio: 'pipe', timeout: 30000 });
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
    sources: sourceDigests(), buildSequence: options.buildSequence, javaRecompiled: true, nativeRebuilt: false,
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
    const jars = fs.readdirSync(path.join(repo, 'backend/build/libs')).filter(n => n.endsWith('.jar') && !n.endsWith('-plain.jar'));
    assert.equal(jars.length, 1);
    const originalJar = path.join(repo, 'backend/build/libs', jars[0]); report.compiledJarSha256 = hash(originalJar);
    const frontend = path.join(work, 'frontend'), desktop = path.join(work, 'desktop'), analyzer = path.join(work, 'analyzers/ts-analyzer');
    for (const dir of [frontend, desktop, path.join(work, 'home'), path.join(work, 'tmp'), path.join(work, 'cache')]) fs.mkdirSync(dir, { mode: 0o700 });
    fs.mkdirSync(analyzer, { recursive: true, mode: 0o700 });
    for (const [component, entries] of [['frontend', ['src', 'public', 'index.html', 'package.json', 'package-lock.json']],
      ['desktop', ['src', 'scripts', 'build', 'package.json', 'package-lock.json']],
      ['analyzers/ts-analyzer', ['src', 'package.json', 'package-lock.json', 'tsconfig.json']]]) {
      for (const entry of entries) {
        const from = path.join(repo, component, entry); if (!fs.existsSync(from)) { assert.equal(entry, 'public'); continue; }
        fs.cpSync(from, path.join(work, component, entry), { recursive: true, force: false, errorOnExist: true });
      }
      report[component + 'Dependencies'] = copyPrivateTree(plan, path.join(repo, component, 'node_modules'), path.join(work, component, 'node_modules'));
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
    for (const name of fs.readdirSync(path.join(repo, 'backend/src/main/resources/db/migration')))
      assert.equal(hash(path.join(repo, 'backend/src/main/resources/db/migration', name)), hash(path.join(stage, 'backend/backup-migrations', name)));
    // Code changed, dependencies did not: reject an incompatible retained supply
    // instead of silently combining a new lockfile with old installed packages.
    for (const name of ['package.json', 'package-lock.json'])
      assert.equal(hash(path.join(analyzer, name)), hash(path.join(stage, 'ts-analyzer', name)), 'ANALYZER_DEPENDENCY_INPUT_CHANGED');
    const replacement = replaceAnalyzerBuild(plan, stage, path.join(analyzer, 'dist'), originalManifest);
    report.analyzer = replacement.evidence;
    const manifest = { ...replacement.manifest, buildSequence: options.buildSequence,
      files: { ...replacement.manifest.files, 'backend/code-intelligence.jar': hash(targetJar) } };
    fs.writeFileSync(path.join(stage, 'runtime-manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
    await validateRuntimeManifest(stage, manifest);
    const retained = fs.mkdtempSync(path.join(repo, '.native-product-')); report.retained = retained; save();
    const pkg = JSON.parse(fs.readFileSync(path.join(desktop, 'package.json'))), baseBuild = pkg.build;
    const config = { ...baseBuild, productName: 'Code Intelligence Validation', appId: 'dev.codeintelligence.desktop.validation',
      extraMetadata: { name: 'code-intelligence-validation', productName: 'Code Intelligence Validation' },
      directories: { output: retained }, mac: { ...baseBuild.mac, identity: '-', notarize: false },
      npmRebuild: false, nodeGypRebuild: false, buildDependenciesFromSource: false, electronDist: path.join(desktop, 'node_modules/electron/dist') };
    const configFile = path.join(desktop, 'candidate-config.json'); fs.writeFileSync(configFile, JSON.stringify(config, null, 2), { flag: 'wx' });
    run(process.execPath, [path.join(desktop, 'node_modules/electron-builder/out/cli/cli.js'), '--mac', 'dir', '--arm64', '--publish', 'never', '--config', configFile],
      desktop, 'packager', { ...fixedEnv, HOME: path.join(work, 'home'), TMPDIR: path.join(work, 'tmp'),
        CSC_IDENTITY_AUTO_DISCOVERY: 'false', NPM_CONFIG_UPDATE_NOTIFIER: 'false', NPM_CONFIG_OFFLINE: 'true', ELECTRON_BUILDER_CACHE: path.join(work, 'cache') });
    const app = path.join(retained, 'Code Intelligence Validation.app'); fs.renameSync(path.join(retained, 'mac-arm64/Code Intelligence Validation.app'), app);
    const asarFile = path.join(app, 'Contents/Resources/app.asar'), asar = createRequire(path.join(desktop, 'package.json'))('@electron/asar');
    report.verifiedProductSource = {};
    for (const name of fs.readdirSync(path.join(repo, 'desktop/src')).filter(n => n.endsWith('.cjs'))) {
      assert(asar.extractFile(asarFile, 'src/' + name).equals(fs.readFileSync(path.join(repo, 'desktop/src', name))));
      report.verifiedProductSource[name] = hash(path.join(repo, 'desktop/src', name));
    }
    const appRuntime = path.join(app, 'Contents/Resources/runtime'), finalManifestFile = path.join(appRuntime, 'runtime-manifest.json');
    await validateRuntimeManifest(appRuntime, JSON.parse(fs.readFileSync(finalManifestFile)));
    assert.equal(hash(path.join(appRuntime, 'backend/code-intelligence.jar')), readback.candidateJarSha256);
    for (const [name, expected] of Object.entries(report.analyzer.fileHashes))
      assert.equal(hash(path.join(appRuntime, 'ts-analyzer/dist', name)), expected);
    execFileSync('/usr/bin/codesign', ['--verify', '--deep', '--strict', app], { stdio: 'pipe', timeout: 30000 });
    assert.deepEqual(sourceDigests(), report.sources);
    assert.equal(hash(originalManifestFile), report.baselineHashes.manifest);
    assert.equal(hash(path.join(baseline, 'Contents/Resources/app.asar')), report.baselineHashes.asar);
    report.app = app; report.appAsarSha256 = hash(asarFile); report.manifestSha256 = hash(finalManifestFile);
    report.status = 'PACKAGED_NOT_RELEASED'; report.sourceAndBaselineUnchanged = true; save();
    console.log(JSON.stringify({ status: report.status, evidence, app, buildSequence: report.buildSequence }));
    return report;
  } catch (error) { report.status = 'FAIL'; report.failure = error.code || error.name; save(); throw error; }
}
module.exports = { argumentsForCandidate, replaceAnalyzerBuild, main };
if (require.main === module) main().catch(error => { console.error(error.code || error.name); process.exitCode = 1; });
