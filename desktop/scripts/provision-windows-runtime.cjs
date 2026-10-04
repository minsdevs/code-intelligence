'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');
const { selectWindowsToolchain } = require('./windows-toolchain.cjs');
const { extractZip } = require('./windows-runtime-archive.cjs');
const { parsePe, systemDll, inventory, validateClosure } = require('./windows-pe-policy.cjs');
const SUPPLIES = require('./windows-runtime-supply.json');
const digest = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
function command(binary, args, cwd, env = process.env) {
  const result = spawnSync(binary, args, { cwd, env, stdio: 'inherit', windowsHide: true, timeout: 1200000 });
  if (result.error || result.status !== 0) throw new Error(`Runtime build failed: ${path.basename(binary)}`, { cause: result.error });
}
function fresh(directory) {
  if (!path.isAbsolute(directory) || fs.existsSync(directory)) throw new Error('Windows runtime output must be a fresh absolute directory');
  const parent = path.dirname(directory), stat = fs.lstatSync(parent);
  if (!stat.isDirectory() || stat.isSymbolicLink() || fs.realpathSync(parent).toLowerCase() !== parent.toLowerCase()) throw new Error('Unsafe runtime output parent');
  fs.mkdirSync(directory, { mode: 0o700 });
}
async function download(name) {
  const supply = SUPPLIES[name], response = await fetch(supply.url, { signal: AbortSignal.timeout(600000) });
  if (!response.ok || Number(response.headers.get('content-length')) > 512 * 1024 * 1024) throw new Error(`Supply download failed: ${name}`);
  const parts = []; let size = 0;
  for await (const part of response.body) { size += part.length; if (size > 512 * 1024 * 1024) throw new Error('Supply size limit'); parts.push(part); }
  const bytes = Buffer.concat(parts, size);
  if (digest(bytes) !== supply.sha256) throw new Error(`Supply checksum mismatch: ${name}`);
  return bytes;
}
function copy(from, to) {
  const stat = fs.lstatSync(from);
  if (stat.isSymbolicLink() || !stat.isFile() || stat.nlink !== 1) throw new Error('Unsafe runtime input');
  fs.mkdirSync(path.dirname(to), { recursive: true }); fs.copyFileSync(from, to, fs.constants.COPYFILE_EXCL);
}
function copyTree(from, to, filter = () => true) {
  const stat = fs.lstatSync(from); if (stat.isSymbolicLink()) throw new Error('Runtime supply link refused');
  if (stat.isDirectory()) {
    fs.mkdirSync(to, { recursive: true });
    for (const name of fs.readdirSync(from)) if (filter(name)) copyTree(path.join(from, name), path.join(to, name), filter);
  } else copy(from, to);
}
function writeJson(file, value) { fs.writeFileSync(file, JSON.stringify(value, null, 2) + '\n', { flag: 'wx', mode: 0o600 }); }
async function provision(destination) {
  if (process.platform !== 'win32' || process.arch !== 'x64') throw new Error('Windows x64 build host required');
  fresh(destination);
  const toolchain = selectWindowsToolchain(process.env, destination);
  const downloads = path.join(destination, 'archives'); fs.mkdirSync(downloads);
  const unpack = async (name, target, select) => {
    const bytes = await download(name); fs.writeFileSync(path.join(downloads, name + '.zip'), bytes, { flag: 'wx' });
    extractZip(bytes, target, select);
  };
  const jdk = path.join(destination, 'jdk'), pg = path.join(destination, 'postgres-build'), vector = path.join(destination, 'vector-source');
  await unpack('jdk', jdk, name => name.startsWith('jdk-21.0.8+9/') ? name.slice('jdk-21.0.8+9/'.length) : null);
  await unpack('postgres', pg, name => /^pgsql\/(?:bin|lib|include|share|doc)\//.test(name) ? name.slice(6) : null);
  await unpack('pgvector', vector, name => name.startsWith('pgvector-0.8.1/') ? name.slice(15) : null);
  const dotnet = path.join(destination, 'dotnet-sdk'), garnet = path.join(destination, 'garnet-source');
  await unpack('dotnet', dotnet);
  const prefix = 'garnet-0d585906eeb5dd77e130a8de6351683336cb168a/';
  await unpack('garnet', garnet, name => name.startsWith(prefix) ? name.slice(prefix.length) : null);
  const native = path.join(destination, 'garnet-native');
  await unpack('garnetNative', native, name => /^net10\.0\/[^/]+\.dll$/.test(name) ? name.slice(8) : null);
  // Upstream copies all RID folders as Content; retain only the actual target RID.
  for (const relative of ['libs/native/bftree-garnet/runtimes', 'libs/storage/Tsavorite/cs/src/core/Device/runtimes']) {
    const directory = path.join(garnet, relative);
    for (const rid of fs.readdirSync(directory)) if (rid !== 'win-x64') fs.rmSync(path.join(directory, rid), { recursive: true });
    for (const name of fs.readdirSync(path.join(directory, 'win-x64', 'native'))) {
      if (name.endsWith('.pdb')) { fs.unlinkSync(path.join(directory, 'win-x64', 'native', name)); continue; }
      const selected = path.join(native, name);
      if (!fs.existsSync(selected)) throw new Error('Unpinned Garnet native source content: ' + name);
      fs.writeFileSync(path.join(directory, 'win-x64', 'native', name), fs.readFileSync(selected));
    }
  }
  const runtime = path.join(destination, 'runtime'); fs.mkdirSync(runtime);
  const jre = path.join(runtime, 'jre');
  command(path.join(jdk, 'bin', 'jlink.exe'), ['--add-modules', 'java.base,java.compiler,java.desktop,java.instrument,java.logging,java.management,java.naming,java.net.http,java.security.jgss,java.sql,jdk.crypto.ec,jdk.net,jdk.unsupported',
    '--strip-debug', '--no-header-files', '--no-man-pages', '--compress=zip-6', '--output', jre], destination, toolchain.env);
  const env = { ...toolchain.env, PGROOT: pg, JAVA_HOME: jdk, DOTNET_ROOT: dotnet, DOTNET_MULTILEVEL_LOOKUP: '0', DOTNET_CLI_TELEMETRY_OPTOUT: '1',
    DOTNET_SKIP_FIRST_TIME_EXPERIENCE: '1', DOTNET_CLI_HOME: path.join(destination, 'dotnet-home'), NUGET_PACKAGES: path.join(destination, 'nuget') };
  command(toolchain.make, ['/NOLOGO', '/F', 'Makefile.win'], vector, env);
  // No global installation, registry writes or service registration.
  copy(path.join(vector, 'vector.dll'), path.join(pg, 'lib', 'vector.dll'));
  copy(path.join(vector, 'vector.control'), path.join(pg, 'share', 'extension', 'vector.control'));
  for (const name of fs.readdirSync(path.join(vector, 'sql')).filter(name => /^vector--.*\.sql$/.test(name))) copy(path.join(vector, 'sql', name), path.join(pg, 'share', 'extension', name));
  const cache = path.join(runtime, 'cache');
  command(path.join(dotnet, 'dotnet.exe'), ['publish', path.join(garnet, 'main', 'GarnetServer', 'GarnetServer.csproj'), '-c', 'Release', '-f', 'net10.0', '-r', 'win-x64', '--self-contained', 'true',
    '-p:PublishSingleFile=false', '-p:PublishReadyToRun=false', '-p:RollForward=Disable', '-p:RuntimeFrameworkVersion=10.0.12', '-p:RestorePackagesWithLockFile=true', '-o', cache], garnet, env);
  // Upstream publishes a test PFX with every build. It must never ship as a usable credential.
  if (fs.existsSync(path.join(cache, 'testcert.pfx'))) fs.unlinkSync(path.join(cache, 'testcert.pfx'));
  // Select one checksummed native asset per basename, including RID copies from NuGet.
  function selectNative(directory) {
    for (const name of fs.readdirSync(directory)) {
      const target = path.join(directory, name), stat = fs.lstatSync(target);
      if (stat.isDirectory()) selectNative(target);
      else if (fs.existsSync(path.join(native, name))) fs.writeFileSync(target, fs.readFileSync(path.join(native, name)));
    }
  }
  selectNative(cache);
  for (const name of fs.readdirSync(native)) if (!fs.existsSync(path.join(cache, name))) copy(path.join(native, name), path.join(cache, name));
  const config = JSON.parse(fs.readFileSync(path.join(cache, 'GarnetServer.runtimeconfig.json')));
  if (config.runtimeOptions?.framework || config.runtimeOptions?.frameworks || !config.runtimeOptions?.includedFrameworks?.length) throw new Error('Garnet is not self-contained');
  const sources = Object.fromEntries(Object.entries(SUPPLIES).map(([name, value]) => [name, { ...value, notice: 'notices/' + name + '.txt' }]));
  const notices = path.join(runtime, 'notices'); fs.mkdirSync(notices);
  const noticeSource = { postgres: path.join(pg, 'doc', 'postgresql', 'html', 'legalnotice.html'), pgvector: path.join(vector, 'LICENSE'),
    jdk: path.join(jdk, 'legal', 'java.base', 'LICENSE'), garnet: path.join(garnet, 'LICENSE'), garnetNative: path.join(garnet, 'LICENSE'), dotnet: path.join(dotnet, 'ThirdPartyNotices.txt') };
  for (const [name, file] of Object.entries(noticeSource)) copy(file, path.join(runtime, sources[name].notice));
  copyTree(path.join(jdk, 'legal'), path.join(notices, 'jdk'));
  copy(path.join(dotnet, 'LICENSE.txt'), path.join(notices, 'dotnet-license.txt'));
  copyTree(path.join(pg, 'doc', 'postgresql'), path.join(notices, 'postgresql'));
  // App-local MSVC runtime is redistributed from the same checksummed JDK, not host System32.
  const vc = ['msvcp140.dll', 'vcruntime140.dll', 'vcruntime140_1.dll'];
  for (const folder of [path.join(runtime, 'postgres', 'bin'), cache]) for (const name of vc) {
    const target = path.join(folder, name); if (!fs.existsSync(target)) copy(path.join(jdk, 'bin', name), target);
  }
  const needed = new Set(['postgres.exe', 'initdb.exe', 'pg_isready.exe', 'psql.exe', 'createdb.exe', 'pg_dump.exe', 'pg_restore.exe']);
  const libs = fs.readdirSync(path.join(pg, 'lib')).filter(name => /^(?:vector|pg_trgm|plpgsql|dict_snowball|(?:utf8|euc|latin|cyrillic)[a-z0-9_]*)\.dll$/i.test(name));
  const queue = [...needed].map(name => ['bin', name]).concat(libs.map(name => ['lib', name])), copied = new Set();
  for (let index = 0; index < queue.length; index++) {
    const [folder, name] = queue[index], relative = folder + '/' + name;
    if (copied.has(relative.toLowerCase())) continue; copied.add(relative.toLowerCase());
    const origin = path.join(pg, folder, name), target = path.join(runtime, 'postgres', folder, name);
    copy(origin, target);
    const inspected = parsePe(fs.readFileSync(origin), relative);
    for (const dependency of [...inspected.imports, ...inspected.delayImports, ...inspected.forwarders]) {
      if (systemDll(dependency) || vc.includes(dependency)) continue;
      const match = ['bin', 'lib'].flatMap(dir => fs.readdirSync(path.join(pg, dir)).filter(file => file.toLowerCase() === dependency).map(file => [dir, file]));
      if (!match.length) throw new Error('Missing PostgreSQL dependency ' + dependency); queue.push(match[0]);
    }
  }
  copyTree(path.join(pg, 'share'), path.join(runtime, 'postgres', 'share'), name => name !== 'extension');
  const extension = path.join(runtime, 'postgres', 'share', 'extension'); fs.mkdirSync(extension);
  for (const name of fs.readdirSync(path.join(pg, 'share', 'extension')).filter(name => /^(?:vector|pg_trgm|plpgsql)(?:--.*\.sql|\.control)$/.test(name)))
    copy(path.join(pg, 'share', 'extension', name), path.join(extension, name));
  const nuget = [];
  for (const packageName of fs.readdirSync(env.NUGET_PACKAGES)) for (const version of fs.readdirSync(path.join(env.NUGET_PACKAGES, packageName))) {
    const directory = path.join(env.NUGET_PACKAGES, packageName, version), nuspec = fs.readdirSync(directory).find(name => name.endsWith('.nuspec'));
    const hashFile = fs.readdirSync(directory).find(name => name.endsWith('.nupkg.sha512'));
    if (!nuspec || !hashFile) throw new Error('NuGet provenance incomplete');
    nuget.push({ name: packageName, version, sha512: fs.readFileSync(path.join(directory, hashFile), 'utf8').trim() });
    const target = path.join(notices, 'nuget', packageName, version); fs.mkdirSync(target, { recursive: true });
    for (const name of fs.readdirSync(directory).filter(name => /license|notice|\.nuspec$/i.test(name))) if (fs.lstatSync(path.join(directory, name)).isFile()) copy(path.join(directory, name), path.join(target, name));
  }
  writeJson(path.join(notices, 'nuget-packages.json'), nuget);
  const dependencyNotices = require('./windows-runtime-notices.json'), noticeIndex = {};
  fs.mkdirSync(path.join(notices, 'dependencies'));
  for (const [name, notice] of Object.entries(dependencyNotices)) {
    if (digest(Buffer.from(notice.text)) !== notice.sha256) throw new Error('Dependency notice integrity failure: ' + name);
    fs.writeFileSync(path.join(notices, 'dependencies', name + '.txt'), notice.text, { flag: 'wx' });
    noticeIndex[name] = { url: notice.url, sha256: notice.sha256 };
  }
  writeJson(path.join(notices, 'dependencies', 'index.json'), noticeIndex);
  const entries = inventory(runtime), files = {};
  for (const [name, item] of entries) {
    if (!item.pe) continue;
    const base = path.basename(name).toLowerCase();
    const origin = vc.includes(base) ? ['jdk'] : name.startsWith('jre/') ? ['jdk'] : name === 'postgres/lib/vector.dll' ? ['pgvector', 'postgres']
      : name.startsWith('postgres/') ? ['postgres'] : fs.existsSync(path.join(native, path.basename(name))) ? ['garnetNative'] : ['garnet', 'dotnet'];
    files[name] = { sha256: item.hash, sources: origin, method: name.startsWith('cache/') ? 'dotnet-publish-self-contained-and-pinned-native' : name.endsWith('/vector.dll') ? 'msvc-nmake' : 'verified-archive-or-jlink' };
  }
  validateClosure(entries);
  const provenance = { format: 1, sources, files, nuget, recipes: { garnet: 'net10.0/win-x64/self-contained/PublishSingleFile=false/PublishReadyToRun=false/RollForward=Disable', pgvector: 'MSVC x64 nmake Makefile.win PGROOT=pinned-PG16.10', jre: 'Temurin21 jlink' } };
  writeJson(path.join(runtime, 'windows-provenance.json'), provenance);
  writeJson(path.join(destination, 'supply.json'), { format: 1, platform: 'win32', arch: 'x64', jdk, runtime, sources: SUPPLIES, toolchain: toolchain.pin });
  return { jdk, runtime };
}
if (require.main === module) provision(path.resolve(process.argv[2] || '')).then(() => console.log('Windows runtime supply prepared; native product acceptance still required.')).catch(error => {
  if (error.publicPolicy) console.error('NATIVE_WINDOWS_POLICY ' + JSON.stringify(error.publicPolicy));
  console.error(error); process.exitCode = 1;
});
module.exports = { provision, command, fresh, copy, copyTree, writeJson, digest };
