'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { command, copy, copyTree, writeJson } = require('./provision-linux-runtime.cjs');
const { createRuntimeStage, requireBuildSequence } = require('./runtime-stage.cjs');
const { requireLinuxHost, verifyLinuxRuntime, digest } = require('./linux-runtime-policy.cjs');
const { validateRuntimeManifest } = require('../src/runtime-manifest.cjs');
const { adapterIsolationMode } = require('../src/adapter-isolation.cjs');
const SUPPLIES = require('./linux-runtime-supply.json');
function metadata(file) {
  const stat = fs.lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.size > 16 * 1024 * 1024)
    throw new Error('Invalid Linux runtime metadata');
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}
function makeReadable(root) {
  const stat = fs.lstatSync(root);
  if (stat.isDirectory() && !stat.isSymbolicLink()) {
    fs.chmodSync(root, 0o755);
    for (const name of fs.readdirSync(root)) makeReadable(path.join(root, name));
  } else {
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) throw new Error('Unsafe Linux runtime stage entry');
    fs.chmodSync(root, stat.mode & 0o111 ? 0o755 : 0o644);
  }
}
async function verifyLinuxStage(root) {
  requireLinuxHost();
  const manifest = metadata(path.join(root, 'runtime-manifest.json'));
  const provenance = metadata(path.join(root, 'linux-provenance.json'));
  verifyLinuxRuntime({ root, manifest, provenance });
  await validateRuntimeManifest(root, manifest, { platform: 'linux', arch: 'x64' });
  return manifest;
}
async function stageLinuxRuntime({ desktop = path.resolve(__dirname, '..'), supply = process.env.CODE_INTELLIGENCE_LINUX_SUPPLY,
  buildSequence = process.env.CODE_INTELLIGENCE_BUILD_SEQUENCE } = {}) {
  requireLinuxHost(); requireBuildSequence(buildSequence);
  if (adapterIsolationMode(metadata(path.join(desktop, 'package.json'))) !== 'legacy-http')
    throw new Error('The macOS XPC adapter supervisor is not a Linux isolation boundary');
  if (!supply || !path.isAbsolute(supply) || fs.realpathSync(supply) !== supply)
    throw new Error('CODE_INTELLIGENCE_LINUX_SUPPLY must identify a physical provisioned supply');
  const supplied = metadata(path.join(supply, 'supply.json'));
  if (supplied.format !== 1 || supplied.platform !== 'linux' || supplied.arch !== 'x64'
      || supplied.jdk !== path.join(supply, 'jdk-source') || supplied.runtime !== path.join(supply, 'runtime')
      || JSON.stringify(supplied.sources) !== JSON.stringify(SUPPLIES)) throw new Error('Linux supply metadata mismatch');
  const provenance = metadata(path.join(supplied.runtime, 'linux-provenance.json'));
  verifyLinuxRuntime({ root: supplied.runtime, provenance });
  const root = path.dirname(desktop), transaction = createRuntimeStage(path.join(desktop, 'stage'));
  const incoming = transaction.staging;
  try {
    const env = { ...process.env, JAVA_HOME: supplied.jdk, PATH: path.join(supplied.jdk, 'bin') + path.delimiter + process.env.PATH };
    const npm = (args, cwd) => command('npm', args, cwd, env);
    npm(['run', 'build'], path.join(root, 'frontend'));
    npm(['run', 'build'], path.join(root, 'analyzers/ts-analyzer'));
    command('./gradlew', ['bootJar', '--no-daemon'], path.join(root, 'backend'), env);
    copyTree(supplied.runtime, incoming);
    const jarRoot = path.join(root, 'backend/build/libs');
    const jars = fs.readdirSync(jarRoot).filter(name => name.endsWith('.jar') && !name.endsWith('-plain.jar')
      && name !== 'code-intelligence-control.jar');
    if (jars.length !== 1) throw new Error('Expected exactly one backend boot jar');
    copy(path.join(jarRoot, jars[0]), path.join(incoming, 'backend/code-intelligence.jar'));
    const control = metadata(path.join(jarRoot, 'code-intelligence-control-provenance.json'));
    if (control.format !== 1 || control.kind !== 'DESKTOP_CONTROL_RUNTIME'
        || control.mainClass !== 'dev.codeintelligence.desktop.DesktopControlApplication'
        || control.jarSha256 !== digest(fs.readFileSync(path.join(jarRoot, 'code-intelligence-control.jar'))))
      throw new Error('DESKTOP_CONTROL_BUILD_INVALID');
    for (const name of ['code-intelligence-control.jar', 'code-intelligence-control-provenance.json'])
      copy(path.join(jarRoot, name), path.join(incoming, 'backend', name));
    copyTree(path.join(root, 'backend/src/main/resources/db/migration'), path.join(incoming, 'backend/backup-migrations'));
    const analyzer = path.join(incoming, 'ts-analyzer');
    copyTree(path.join(root, 'analyzers/ts-analyzer/dist'), path.join(analyzer, 'dist'));
    for (const name of ['package.json', 'package-lock.json']) copy(path.join(root, 'analyzers/ts-analyzer', name), path.join(analyzer, name));
    npm(['ci', '--omit=dev', '--ignore-scripts', '--bin-links=false'], analyzer);
    makeReadable(incoming);
    // Any new native npm dependency needs an explicit source/closure recipe; do
    // not bless downloaded .node files merely because npm completed successfully.
    const entries = verifyLinuxRuntime({ root: incoming, provenance });
    const manifest = { format: 1, buildSequence, platform: 'linux', arch: 'x64', minimumGlibc: '2.35',
      backupProtocol: 3, ownershipProtocol: 1, controlProtocol: 1,
      runtime: { postgresBin: 'postgres/bin', postgresLib: 'postgres/lib', postgresPkgLib: 'postgres/lib', postgresShare: 'postgres/share' },
      files: Object.fromEntries([...entries].map(([name, item]) => [name, item.hash])) };
    writeJson(path.join(incoming, 'runtime-manifest.json'), manifest);
    await verifyLinuxStage(incoming);
    const published = transaction.publish();
    console.log('Linux runtime staged. Native desktop acceptance and public release approval remain separate.');
    if (published.previous) console.log('Previous runtime retained at ' + published.previous);
    return manifest;
  } finally { transaction.close(); }
}
module.exports = { stageLinuxRuntime, verifyLinuxStage, makeReadable };
