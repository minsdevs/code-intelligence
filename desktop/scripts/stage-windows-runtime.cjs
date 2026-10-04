'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { command, fresh, copy, copyTree, writeJson, digest } = require('./provision-windows-runtime.cjs');
const { requireBuildSequence } = require('./runtime-stage.cjs');
const { inventory, verifyWindowsRuntime } = require('./windows-pe-policy.cjs');
const { selectWindowsToolchain, cmakeConfigureArgs, cmakeExecutable, pinKey } = require('./windows-toolchain.cjs');
const SUPPLIES = require('./windows-runtime-supply.json');
function stageWindowsRuntime({ desktop = path.resolve(__dirname, '..'), supply = process.env.CODE_INTELLIGENCE_WINDOWS_SUPPLY,
  buildSequence = process.env.CODE_INTELLIGENCE_BUILD_SEQUENCE } = {}) {
  if (process.platform !== 'win32' || process.arch !== 'x64') throw new Error('Windows x64 native staging host required');
  requireBuildSequence(buildSequence);
  if (!supply || !path.isAbsolute(supply)) throw new Error('CODE_INTELLIGENCE_WINDOWS_SUPPLY must identify a provisioned private supply');
  const metadata = JSON.parse(fs.readFileSync(path.join(supply, 'supply.json')));
  if (metadata.format !== 1 || metadata.platform !== 'win32' || metadata.arch !== 'x64'
      || metadata.jdk !== path.join(supply, 'jdk') || metadata.runtime !== path.join(supply, 'runtime')
      || JSON.stringify(metadata.sources) !== JSON.stringify(SUPPLIES)) throw new Error('Windows supply metadata mismatch');
  const root = path.dirname(desktop), stageRoot = path.join(desktop, 'stage'), stage = path.join(stageRoot, 'runtime');
  if (fs.existsSync(stage)) throw new Error('Windows staging requires fresh output; existing runtime is retained');
  fs.mkdirSync(stageRoot, { recursive: true });
  const incoming = path.join(stageRoot, 'runtime.incoming-' + require('node:crypto').randomUUID()); fresh(incoming);
  const env = { ...process.env, JAVA_HOME: metadata.jdk, PATH: path.join(metadata.jdk, 'bin') + path.delimiter + process.env.PATH };
  const npmCli = process.env.npm_execpath || path.join(path.dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js');
  const npm = (args, cwd) => command(process.execPath, [npmCli, ...args], cwd, env);
  npm(['run', 'build'], path.join(root, 'frontend'));
  npm(['run', 'build'], path.join(root, 'analyzers', 'ts-analyzer'));
  command(process.env.ComSpec || 'C:\\Windows\\System32\\cmd.exe', ['/d', '/s', '/c', 'gradlew.bat bootJar --no-daemon'], path.join(root, 'backend'), env);
  copyTree(metadata.runtime, incoming);
  const provenanceFile = path.join(incoming, 'windows-provenance.json'), provenance = JSON.parse(fs.readFileSync(provenanceFile));
  const jars = fs.readdirSync(path.join(root, 'backend', 'build', 'libs')).filter(name => name.endsWith('.jar') && !name.endsWith('-plain.jar'));
  if (jars.length !== 1) throw new Error('Expected exactly one backend boot jar');
  copy(path.join(root, 'backend', 'build', 'libs', jars[0]), path.join(incoming, 'backend', 'code-intelligence.jar'));
  copyTree(path.join(root, 'backend', 'src', 'main', 'resources', 'db', 'migration'), path.join(incoming, 'backend', 'backup-migrations'));
  const analyzer = path.join(incoming, 'ts-analyzer');
  copyTree(path.join(root, 'analyzers', 'ts-analyzer', 'dist'), path.join(analyzer, 'dist'));
  for (const name of ['package.json', 'package-lock.json']) copy(path.join(root, 'analyzers', 'ts-analyzer', name), path.join(analyzer, name));
  npm(['ci', '--omit=dev', '--ignore-scripts'], analyzer);
  const nativeSource = path.join(desktop, 'native', 'windows'), nativeBuild = path.join(stageRoot, 'native-build-' + require('node:crypto').randomUUID());
  if (typeof metadata.toolchain !== 'string' || (env[pinKey] && env[pinKey] !== metadata.toolchain)) throw new Error('Windows supply toolchain mismatch');
  const toolchain = selectWindowsToolchain({ ...env, [pinKey]: metadata.toolchain }, stageRoot);
  const cmake = cmakeExecutable(env, toolchain);
  command(cmake, cmakeConfigureArgs(nativeSource, nativeBuild, toolchain), root, toolchain.env);
  command(cmake, ['--build', nativeBuild, '--config', 'Release'], root, toolchain.env);
  const relative = 'native/windows/codeintel-boundary.exe';
  copy(path.join(nativeBuild, 'codeintel-boundary.exe'), path.join(incoming, relative));
  const sourceFiles = fs.readdirSync(nativeSource).filter(name => /\.(?:cpp|inc)$/.test(name) || name === 'CMakeLists.txt').sort();
  const sourceDigest = digest(Buffer.concat(sourceFiles.flatMap(name => [Buffer.from(name + '\0'), fs.readFileSync(path.join(nativeSource, name))])));
  provenance.sources.boundary = { version: sourceDigest, sha256: sourceDigest, url: 'repository:desktop/native/windows', notice: 'notices/boundary.txt' };
  fs.writeFileSync(path.join(incoming, 'notices', 'boundary.txt'), 'Code Intelligence Windows boundary: built from the application source revision.\n', { flag: 'wx' });
  provenance.files[relative] = { sha256: digest(fs.readFileSync(path.join(incoming, relative))), sources: ['boundary'], method: 'cmake-msvc-x64-release', sourceFiles };
  for (const name of ['msvcp140.dll', 'vcruntime140.dll', 'vcruntime140_1.dll']) {
    const target = 'native/windows/' + name; copy(path.join(metadata.jdk, 'bin', name), path.join(incoming, target));
    provenance.files[target] = { sha256: digest(fs.readFileSync(path.join(incoming, target))), sources: ['jdk'], method: 'verified-archive' };
  }
  // This is fresh rebuildable output. Never replace a published stage or pretend rename is a durable user-data transaction.
  fs.writeFileSync(provenanceFile, JSON.stringify(provenance, null, 2) + '\n');
  verifyWindowsRuntime({ root: incoming, provenance, supplies: SUPPLIES });
  const files = Object.fromEntries([...inventory(incoming)].map(([name, item]) => [name, item.hash]));
  const manifest = { format: 1, buildSequence, backupProtocol: 3, ownershipProtocol: 1, platform: 'win32', arch: 'x64',
    runtime: { postgresBin: 'postgres/bin', postgresLib: 'postgres/bin', postgresPkgLib: 'postgres/lib', postgresShare: 'postgres/share', cache: 'garnet-2.2.0' }, files };
  writeJson(path.join(incoming, 'runtime-manifest.json'), manifest);
  verifyWindowsRuntime({ root: incoming, manifest, provenance, supplies: SUPPLIES });
  for (const name of [...Object.keys(files), 'runtime-manifest.json']) {
    const fd = fs.openSync(path.join(incoming, name), 'r+'); try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  }
  fs.renameSync(incoming, stage);
  console.log(`Staged ${Object.keys(files).length} verified Windows runtime files. Product acceptance and release gates remain separate.`);
  return manifest;
}
module.exports = { stageWindowsRuntime };
