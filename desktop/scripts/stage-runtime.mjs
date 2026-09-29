import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const desktop = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const root = path.resolve(desktop, '..');
const stageDirectory = path.join(desktop, 'stage');
const stage = path.join(stageDirectory, 'runtime');
const staging = path.join(stageDirectory, `runtime.tmp-${process.pid}`);
let committed = false;

function exec(command, args, cwd = root) {
  process.stdout.write(`> ${command} ${args.join(' ')}\n`);
  return execFileSync(command, args, { cwd, stdio: 'inherit', env: process.env });
}

function output(command, args) {
  return execFileSync(command, args, { encoding: 'utf8' }).trim();
}

function copy(source, destination) {
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  fs.cpSync(source, destination, { recursive: true, dereference: true, force: true });
}

function mergeDirectory(source, destination) {
  fs.mkdirSync(destination, { recursive: true, mode: 0o755 });
  fs.chmodSync(destination, 0o755);
  for (const entry of fs.readdirSync(source, { withFileTypes: true })) {
    copy(path.join(source, entry.name), path.join(destination, entry.name));
  }
}

function machORpaths(file) {
  return output('otool', ['-l', file])
    .split('\n')
    .flatMap((line) => {
      const match = line.match(/^\s*path (.+) \(offset \d+\)$/);
      return match ? [match[1]] : [];
    });
}

function resolveMachODependency(reference, owner) {
  if (reference.startsWith('/')) return reference;
  if (reference.startsWith('@loader_path/')) {
    return path.resolve(path.dirname(owner), reference.slice('@loader_path/'.length));
  }
  if (reference.startsWith('@executable_path/')) {
    return path.resolve(path.dirname(owner), reference.slice('@executable_path/'.length));
  }
  if (reference.startsWith('@rpath/')) {
    const suffix = reference.slice('@rpath/'.length);
    for (const rpath of machORpaths(owner)) {
      const resolvedRoot = rpath.startsWith('@loader_path/')
        ? path.resolve(path.dirname(owner), rpath.slice('@loader_path/'.length))
        : rpath.startsWith('@executable_path/')
          ? path.resolve(path.dirname(owner), rpath.slice('@executable_path/'.length))
          : rpath;
      const candidate = path.join(resolvedRoot, suffix);
      if (fs.existsSync(candidate)) return candidate;
    }
  }
  return null;
}

function copyDynamicLibraries(executables, destination) {
  if (process.platform !== 'darwin') return;
  fs.mkdirSync(destination, { recursive: true });
  const pending = [...executables];
  const visited = new Set();
  while (pending.length) {
    const executable = pending.pop();
    if (!fs.existsSync(executable) || visited.has(executable)) continue;
    visited.add(executable);
    const lines = output('otool', ['-L', executable]).split('\n').slice(1);
    for (const line of lines) {
      const reference = line.trim().split(' ')[0];
      if (!reference) continue;
      const dependency = resolveMachODependency(reference, executable);
      if (!dependency || dependency.startsWith('/System/') || dependency.startsWith('/usr/lib/')) continue;
      if (!fs.existsSync(dependency)) continue;
      const target = path.join(destination, path.basename(dependency));
      if (!fs.existsSync(target)) copy(dependency, target);
      pending.push(dependency);
    }
  }
}

function filesUnder(directory) {
  const result = [];
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const absolute = path.join(directory, entry.name);
    if (entry.isDirectory()) result.push(...filesUnder(absolute));
    else if (entry.isFile()) result.push(absolute);
  }
  return result;
}

function commonDirectory(paths) {
  const segments = paths.map((value) => path.resolve(value).split(path.sep));
  let length = segments[0].length;
  for (const segment of segments.slice(1)) {
    length = Math.min(length, segment.length);
    while (length > 0 && segments[0].slice(0, length).join(path.sep) !== segment.slice(0, length).join(path.sep)) {
      length -= 1;
    }
  }
  return segments[0].slice(0, Math.max(length, 1)).join(path.sep) || path.sep;
}

function hash(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

if (process.platform !== 'darwin' || process.arch !== 'arm64') {
  throw new Error('The verified desktop package target is currently macOS arm64 only.');
}

fs.mkdirSync(stageDirectory, { recursive: true });
fs.rmSync(staging, { recursive: true, force: true });
process.on('exit', () => {
  if (!committed) fs.rmSync(staging, { recursive: true, force: true });
});
fs.mkdirSync(staging, { recursive: true });

exec('npm', ['run', 'build'], path.join(root, 'frontend'));
exec('npm', ['run', 'build'], path.join(root, 'analyzers', 'ts-analyzer'));
exec('./gradlew', ['bootJar'], path.join(root, 'backend'));

const jars = fs.readdirSync(path.join(root, 'backend', 'build', 'libs'))
  .filter((name) => name.endsWith('.jar') && !name.endsWith('-plain.jar'));
if (jars.length !== 1) throw new Error(`Expected one backend boot jar, found: ${jars.join(', ')}`);
copy(path.join(root, 'backend', 'build', 'libs', jars[0]), path.join(staging, 'backend', 'code-intelligence.jar'));

const analyzerStage = path.join(staging, 'ts-analyzer');
copy(path.join(root, 'analyzers', 'ts-analyzer', 'dist'), path.join(analyzerStage, 'dist'));
copy(path.join(root, 'analyzers', 'ts-analyzer', 'package.json'), path.join(analyzerStage, 'package.json'));
copy(path.join(root, 'analyzers', 'ts-analyzer', 'package-lock.json'), path.join(analyzerStage, 'package-lock.json'));
exec('npm', ['ci', '--omit=dev', '--ignore-scripts'], analyzerStage);

const javaHome = process.env.JAVA_HOME || output('/usr/libexec/java_home', ['-v', '21']);
const jlink = path.join(javaHome, 'bin', 'jlink');
exec(jlink, [
  '--add-modules',
  'java.base,java.compiler,java.desktop,java.instrument,java.logging,java.management,java.naming,java.net.http,java.security.jgss,java.sql,jdk.crypto.ec,jdk.net,jdk.unsupported',
  '--strip-debug', '--no-header-files', '--no-man-pages', '--compress=zip-6',
  '--output', path.join(staging, 'jre')
]);

const pgConfig = process.env.PG_CONFIG || output('which', ['pg_config']);
const pgBin = output(pgConfig, ['--bindir']);
const pgLib = output(pgConfig, ['--libdir']);
const pgPkgLib = output(pgConfig, ['--pkglibdir']);
const pgShare = output(pgConfig, ['--sharedir']);
const pgLayoutRoot = commonDirectory([pgBin, pgLib, pgShare]);
const pgBinRelative = path.relative(pgLayoutRoot, pgBin);
const pgPkgLibRelative = path.relative(pgLayoutRoot, pgPkgLib);
const pgShareRelative = path.relative(pgLayoutRoot, pgShare);
const postgresFlatLib = path.join(staging, 'postgres', 'lib');
const postgresBin = path.join(staging, 'postgres', pgBinRelative);
const postgresPkgLib = path.join(staging, 'postgres', pgPkgLibRelative);
const postgresShare = path.join(staging, 'postgres', pgShareRelative);
const requiredPgBinaries = ['postgres', 'initdb', 'pg_isready', 'psql', 'createdb', 'pg_dump', 'pg_restore'];
for (const name of requiredPgBinaries) {
  copy(path.join(pgBin, name), path.join(postgresBin, name));
}
copy(pgLib, postgresFlatLib);
if (pgPkgLib !== pgLib && !fs.existsSync(path.join(pgLib, 'postgresql'))) {
  copy(pgPkgLib, path.join(postgresFlatLib, 'postgresql'));
}
if (pgPkgLib !== pgLib) {
  const bundledPgExtensions = fs.existsSync(path.join(pgLib, 'postgresql'))
    ? path.join(pgLib, 'postgresql')
    : pgPkgLib;
  mergeDirectory(bundledPgExtensions, postgresPkgLib);
}
copy(pgShare, postgresShare);
const pgVectorRoot = process.env.PGVECTOR_ROOT ? path.resolve(process.env.PGVECTOR_ROOT) : null;
if (pgVectorRoot) {
  const vectorLib = path.join(pgVectorRoot, 'lib', 'postgresql');
  const vectorShare = path.join(pgVectorRoot, 'share', 'postgresql', 'extension');
  if (!fs.existsSync(vectorLib) || !fs.existsSync(path.join(vectorShare, 'vector.control'))) {
    throw new Error(`PGVECTOR_ROOT does not contain a matching PostgreSQL extension: ${pgVectorRoot}`);
  }
  mergeDirectory(vectorLib, postgresPkgLib);
  mergeDirectory(vectorShare, path.join(postgresShare, 'extension'));
}
const pgExecutables = requiredPgBinaries.map((name) => path.join(pgBin, name));
copyDynamicLibraries(pgExecutables, postgresFlatLib);
if (!fs.existsSync(path.join(postgresShare, 'extension', 'vector.control'))) {
  throw new Error(
    'pgvector is not installed for the selected PostgreSQL runtime. Install a matching extension or set PGVECTOR_ROOT.'
  );
}

const redisServer = process.env.REDIS_SERVER || output('which', ['redis-server']);
copy(redisServer, path.join(staging, 'redis', 'bin', 'redis-server'));
copyDynamicLibraries([redisServer], path.join(staging, 'redis', 'lib'));

const manifest = {};
for (const file of filesUnder(staging)) {
  manifest[path.relative(staging, file)] = hash(file);
}
fs.writeFileSync(
  path.join(staging, 'runtime-manifest.json'),
  JSON.stringify({
    format: 1,
    platform: process.platform,
    arch: process.arch,
    runtime: {
      postgresBin: path.relative(staging, postgresBin),
      postgresLib: path.relative(staging, postgresFlatLib),
      postgresPkgLib: path.relative(staging, postgresPkgLib),
      postgresShare: path.relative(staging, postgresShare)
    },
    files: manifest
  }, null, 2)
);
fs.rmSync(stage, { recursive: true, force: true });
fs.renameSync(staging, stage);
committed = true;
console.log(`Staged ${Object.keys(manifest).length} runtime files at ${stage}`);
