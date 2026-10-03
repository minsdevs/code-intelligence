'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');
const { prepareBuildWorkspace } = require('./isolated-build.cjs');
const components = Object.freeze({ frontend: 'frontend', 'ts-analyzer': 'analyzers/ts-analyzer', desktop: 'desktop' });
const digest = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const inside = (root, file) => file === root || file.startsWith(root + path.sep);
function refuse(code) { const error = new Error(code); error.code = code; throw error; }
const identity = stat => [stat.dev, stat.ino, stat.mode, stat.uid, stat.gid, stat.nlink, stat.size, stat.mtimeMs, stat.ctimeMs].join(':');

function readRegular(file, expected, consume = () => {}) {
  const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
  const buffer = Buffer.alloc(64 * 1024), hash = crypto.createHash('sha256');
  try {
    const initial = fs.fstatSync(fd);
    if (!initial.isFile() || initial.nlink !== 1 || identity(initial) !== expected.identity
        || initial.size !== expected.size || initial.size > 512 * 1024 ** 2) refuse('DEPENDENCY_CHANGED');
    let offset = 0;
    for (;;) {
      const count = fs.readSync(fd, buffer, 0, Math.min(buffer.length, expected.size - offset + 1), offset);
      if (!count) break;
      if (offset + count > expected.size) refuse('DEPENDENCY_CHANGED');
      const chunk = buffer.subarray(0, count); hash.update(chunk); consume(chunk); offset += count;
    }
    if (offset !== expected.size || identity(fs.fstatSync(fd)) !== expected.identity
        || identity(fs.lstatSync(file)) !== expected.identity) refuse('DEPENDENCY_CHANGED');
    return hash.digest('hex');
  } finally { buffer.fill(0); fs.closeSync(fd); }
}

// Dependencies are copied, including only links that resolve within this dependency
// tree. Linking the original node_modules would let TypeScript write its cache there.
function dependencyInventory(root, { skipLocks = false } = {}) {
  if (!path.isAbsolute(root) || fs.realpathSync(root) !== root || !fs.lstatSync(root).isDirectory()) refuse('DEPENDENCY_PATH_INVALID');
  const entries = []; let bytes = 0;
  function walk(directory) {
    for (const name of fs.readdirSync(directory).sort()) {
      if (directory === root && ['.cache', '.tmp'].includes(name)) continue;
      if (skipLocks && /\.(?:lock|lck)$/.test(name)) continue;
      const file = path.join(directory, name), relative = path.relative(root, file), stat = fs.lstatSync(file);
      if (entries.length >= 100000) refuse('DEPENDENCY_LIMIT');
      if (stat.isSymbolicLink()) {
        const link = fs.readlinkSync(file);
        if (path.isAbsolute(link) || !inside(root, path.resolve(directory, link)) || !inside(root, fs.realpathSync(file))) refuse('DEPENDENCY_LINK_OUTSIDE');
        entries.push({ path: relative, link });
      } else if (stat.isDirectory()) {
        entries.push({ path: relative, directory: true }); walk(file);
      } else if (stat.isFile()) {
        bytes += stat.size;
        if (bytes > 3 * 1024 ** 3 || stat.size > 512 * 1024 ** 2) refuse('DEPENDENCY_LIMIT');
        const metadata = { size: stat.size, identity: identity(stat) };
        entries.push({ path: relative, sha256: readRegular(file, metadata), executable: Boolean(stat.mode & 0o111), ...metadata });
      } else refuse('DEPENDENCY_TYPE_INVALID');
    }
  }
  walk(root);
  return { entries, bytes, sha256: digest(JSON.stringify(entries.map(({ identity: _identity, ...entry }) => entry))) };
}

function copyDependencies(plan, component, source) {
  if (!Object.hasOwn(components, component)) refuse('BUILD_COMPONENT_INVALID');
  const destination = path.join(plan.workRoot, components[component], 'node_modules');
  return { component, ...copyPrivateTree(plan, source, destination) };
}

function copyPrivateTree(plan, source, destination, { skipLocks = false } = {}) {
  plan.assertIdentity();
  const allowedRoot = [plan.workRoot, plan.paths?.gradleHome].find(root => root && destination !== root && inside(root, destination));
  if (!allowedRoot || !path.isAbsolute(destination) || path.normalize(destination) !== destination) refuse('DEPENDENCY_DESTINATION_INVALID');
  const before = dependencyInventory(source, { skipLocks });
  let parent = allowedRoot;
  for (const part of path.relative(allowedRoot, path.dirname(destination)).split(path.sep).filter(Boolean)) {
    parent = path.join(parent, part);
    if (!fs.existsSync(parent)) fs.mkdirSync(parent, { mode: 0o700 });
    const stat = fs.lstatSync(parent);
    if (!stat.isDirectory() || stat.isSymbolicLink() || fs.realpathSync(parent) !== parent) refuse('DEPENDENCY_DESTINATION_INVALID');
  }
  if (fs.existsSync(destination)) refuse('DEPENDENCY_DESTINATION_EXISTS');
  fs.mkdirSync(destination, { mode: 0o700 });
  let copiedBytes = 0;
  // Copy only the inventoried entries, never a fresh recursive walk of a changing tree.
  for (const entry of before.entries) {
    const target = path.join(destination, entry.path), original = path.join(source, entry.path);
    if (entry.directory) fs.mkdirSync(target, { mode: 0o700 });
    else if (entry.link !== undefined) {
      if (!fs.lstatSync(original).isSymbolicLink() || fs.readlinkSync(original) !== entry.link
          || !inside(source, fs.realpathSync(original))) refuse('DEPENDENCY_CHANGED');
      fs.symlinkSync(entry.link, target);
    } else {
      const fd = fs.openSync(target, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW,
        entry.executable ? 0o700 : 0o600);
      try {
        const sha256 = readRegular(original, entry, chunk => {
          copiedBytes += chunk.length;
          if (copiedBytes > 3 * 1024 ** 3) refuse('DEPENDENCY_LIMIT');
          let offset = 0;
          while (offset < chunk.length) {
            const count = fs.writeSync(fd, chunk, offset, chunk.length - offset);
            if (count <= 0) refuse('DEPENDENCY_WRITE_FAILED');
            offset += count;
          }
        });
        if (sha256 !== entry.sha256) refuse('DEPENDENCY_CHANGED');
      } finally { fs.closeSync(fd); }
    }
  }
  const copied = dependencyInventory(destination, { skipLocks }), after = dependencyInventory(source, { skipLocks });
  if (before.sha256 !== copied.sha256 || before.sha256 !== after.sha256) refuse('DEPENDENCY_COPY_CHANGED');
  plan.assertIdentity();
  return { source, sha256: before.sha256, files: before.entries.length, bytes: before.bytes };
}

function runNode(plan, label, cwd, script, args = []) {
  plan.assertIdentity();
  const log = path.join(plan.outputRoot, `${label}.log`);
  const fd = fs.openSync(log, 'wx', 0o600);
  let result;
  try {
    result = spawnSync(process.execPath, [script, ...args], { cwd, env: plan.childEnvironment(), stdio: ['ignore', fd, fd] });
  } finally { fs.closeSync(fd); }
  plan.assertIdentity();
  if (result.error || result.signal || result.status !== 0) refuse(`BUILD_FAILED_${label.toUpperCase().replaceAll('-', '_')}`);
  process.stdout.write(`Passed: ${label}\n`);
}

function buildJavaScriptAndArchive(plan, sourceDirectory) {
  const dependencies = [];
  for (const [component, relative] of Object.entries(components)) {
    process.stdout.write(`Copying private dependencies: ${component}\n`);
    dependencies.push(copyDependencies(plan, component, path.join(sourceDirectory, relative, 'node_modules')));
  }
  const frontend = path.join(plan.workRoot, components.frontend);
  const analyzer = path.join(plan.workRoot, components['ts-analyzer']);
  const desktop = path.join(plan.workRoot, components.desktop);
  runNode(plan, 'frontend-types', frontend, path.join(frontend, 'node_modules/typescript/bin/tsc'), ['-b']);
  runNode(plan, 'frontend-build', frontend, path.join(frontend, 'node_modules/vite/bin/vite.js'), ['build']);
  runNode(plan, 'analyzer-build', analyzer, path.join(analyzer, 'node_modules/typescript/bin/tsc'), ['-p', 'tsconfig.json']);
  const payload = path.join(plan.outputRoot, 'desktop-code');
  fs.mkdirSync(payload, { mode: 0o700 });
  fs.cpSync(path.join(desktop, 'src'), path.join(payload, 'src'), { recursive: true, errorOnExist: true, force: false });
  fs.copyFileSync(path.join(desktop, 'package.json'), path.join(payload, 'package.json'), fs.constants.COPYFILE_EXCL);
  const archive = path.join(plan.outputRoot, 'desktop-code.asar');
  const asar = path.join(desktop, 'node_modules/@electron/asar/bin/asar.js');
  runNode(plan, 'desktop-code-archive', desktop, asar, ['pack', payload, archive]);
  const extracted = path.join(plan.outputRoot, 'archive-readback');
  runNode(plan, 'desktop-code-readback', desktop, asar, ['extract', archive, extracted]);
  if (dependencyInventory(payload).sha256 !== dependencyInventory(extracted).sha256) refuse('ARCHIVE_READBACK_CHANGED');
  for (const dependency of dependencies) {
    if (dependencyInventory(dependency.source).sha256 !== dependency.sha256) refuse('ORIGINAL_DEPENDENCIES_CHANGED');
  }
  plan.assertIdentity();
  const report = { format: 1, status: 'CODE_BUILD_PASSED', sourceCommit: plan.sourceCommit,
    scope: 'Frontend and analyzer production compilation; desktop source ASAR with byte-verified readback',
    nativePackageVerified: false, launchAllowed: false,
    outputs: { frontend: path.join(frontend, 'dist'), analyzer: path.join(analyzer, 'dist'), archive },
    archiveSha256: digest(fs.readFileSync(archive)),
    originalDependenciesUnchanged: true,
    dependencies: dependencies.map(({ source, ...entry }) => entry),
    unexecuted: ['Backend bootJar', 'Native runtime staging', 'Electron launch', 'Signing and notarization', 'Windows native execution'],
  };
  fs.writeFileSync(path.join(plan.outputRoot, 'build-result.json'), JSON.stringify(report, null, 2), { flag: 'wx', mode: 0o600 });
  return report;
}

function argumentsForBuild(argv) {
  const result = {};
  for (let index = 0; index < argv.length; index += 2) {
    const key = { '--source-root': 'sourceDirectory', '--build-parent': 'parentDirectory', '--java-home': 'javaHome',
      '--gradle-distribution': 'gradleDistribution', '--gradle-modules-cache': 'gradleModulesCache' }[argv[index]];
    if (!key || Object.hasOwn(result, key) || !argv[index + 1] || argv[index + 1].startsWith('--')) refuse('BUILD_ARGUMENT_INVALID');
    result[key] = argv[index + 1];
  }
  if (!result.sourceDirectory || !result.parentDirectory || ![2, 5].includes(Object.keys(result).length)) refuse('BUILD_ARGUMENT_INVALID');
  return result;
}

function verifyJarInputs(plan, bootJar, expectedSha256) {
  runNode(plan, 'backend-jar-readback', plan.workRoot, path.join(__dirname, 'verify-built-jar.cjs'), [plan.workRoot, bootJar]);
  const resultFile = path.join(plan.outputRoot, 'jar-readback.json');
  const stat = fs.lstatSync(resultFile);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.size > 4096) refuse('BACKEND_JAR_READBACK_INVALID');
  const chunks = [];
  readRegular(resultFile, { size: stat.size, identity: identity(stat) }, chunk => chunks.push(Buffer.from(chunk)));
  const result = JSON.parse(Buffer.concat(chunks).toString('utf8'));
  if (result.frontendArchiveReadbackVerified !== true
      || !Number.isSafeInteger(result.frontendFiles) || result.frontendFiles < 1
      || !Number.isSafeInteger(result.migrationFiles) || result.migrationFiles < 1) refuse('BACKEND_JAR_READBACK_INVALID');
  plan.assertIdentity();
  const jarStat = fs.lstatSync(bootJar);
  if (expectedSha256 && readRegular(bootJar, { size: jarStat.size, identity: identity(jarStat) }) !== expectedSha256) refuse('BACKEND_JAR_CHANGED');
  return result;
}

async function main(argv) {
  let plan;
  try {
    const options = argumentsForBuild(argv);
    plan = prepareBuildWorkspace({ sourceDirectory: options.sourceDirectory, parentDirectory: options.parentDirectory });
    process.stdout.write(`Fresh build workspace: ${plan.root}\n`);
    const report = buildJavaScriptAndArchive(plan, options.sourceDirectory);
    if (options.javaHome) {
      process.stdout.write('Building backend offline with private Gradle inputs\n');
      const { buildBackend } = require('./build-isolated-backend.cjs');
      const backend = buildBackend(plan, options, copyPrivateTree);
      Object.assign(backend, verifyJarInputs(plan, backend.bootJar, backend.bootJarSha256));
      for (const dependency of backend.dependencies) {
        if (dependencyInventory(dependency.source, { skipLocks: true }).sha256 !== dependency.sha256) refuse('ORIGINAL_DEPENDENCIES_CHANGED');
      }
      backend.dependencies = backend.dependencies.map(({ source, ...entry }) => entry);
      report.status = 'APPLICATION_CODE_BUILD_PASSED'; report.backend = backend;
      report.scope = 'Frontend, analyzer and backend production compilation; JAR static assets/migrations and desktop source ASAR readback';
      report.unexecuted = report.unexecuted.filter(name => name !== 'Backend bootJar');
      fs.writeFileSync(path.join(plan.outputRoot, 'application-build-result.json'), JSON.stringify(report, null, 2), { flag: 'wx', mode: 0o600 });
      process.stdout.write('Passed: backend bootJar and embedded frontend/migration readback\n');
    }
    console.log(JSON.stringify(report, null, 2));
  } catch (error) {
    console.error(JSON.stringify({ status: 'BUILD_REFUSED_OR_FAILED', code: error.code || 'ISOLATED_BUILD_FAILED',
      launchAllowed: false, retainedRun: plan?.root ?? null }));
    process.exitCode = 1;
  }
}

if (require.main === module) main(process.argv.slice(2));

module.exports = { dependencyInventory, copyDependencies, copyPrivateTree, argumentsForBuild, buildJavaScriptAndArchive, verifyJarInputs };
