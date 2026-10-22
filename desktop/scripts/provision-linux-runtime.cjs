'use strict';
// Native Linux build preparation. No root installation, daemon registration or foreign-OS execution.
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { spawnSync, execFileSync } = require('node:child_process');
const { requireLinuxHost, SYSTEM_LIBRARIES, parseElfHeader, inspectElf, inventory, validateClosure, digest } = require('./linux-runtime-policy.cjs');
const SUPPLIES = require('./linux-runtime-supply.json');
const JAVA_MODULES = 'java.base,java.compiler,java.desktop,java.instrument,java.logging,java.management,java.naming,java.net.http,java.security.jgss,java.sql,jdk.crypto.ec,jdk.net,jdk.unsupported';
function command(binary, args, cwd, env = process.env) {
  const result = spawnSync(binary, args, { cwd, env, stdio: 'inherit', timeout: 1200000 });
  if (result.error || result.status !== 0) throw new Error('Linux runtime build failed: ' + path.basename(binary), { cause: result.error });
}
function output(binary, args, cwd) {
  return execFileSync(binary, args, { cwd, encoding: 'utf8', maxBuffer: 8 * 1024 * 1024,
    env: { ...process.env, LC_ALL: 'C' } }).trim();
}
function fresh(directory) {
  if (!path.isAbsolute(directory) || fs.existsSync(directory) || fs.realpathSync(path.dirname(directory)) !== path.dirname(directory))
    throw new Error('Linux supply output must be a fresh absolute directory with a physical parent');
  fs.mkdirSync(directory, { mode: 0o700 });
}
function copy(from, to) {
  const stat = fs.lstatSync(from);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) throw new Error('Linux runtime input must be a regular file');
  fs.mkdirSync(path.dirname(to), { recursive: true, mode: 0o755 });
  fs.copyFileSync(from, to, fs.constants.COPYFILE_EXCL);
  fs.chmodSync(to, stat.mode & 0o111 ? 0o755 : 0o644);
}
function copyTree(from, to, sourceRoot = fs.realpathSync(from)) {
  const physical = fs.realpathSync(from);
  if (physical !== sourceRoot && !physical.startsWith(sourceRoot + path.sep)) throw new Error('Linux runtime source link escapes its tree');
  const stat = fs.statSync(physical);
  if (stat.isDirectory()) {
    fs.mkdirSync(to, { recursive: true, mode: 0o755 });
    for (const name of fs.readdirSync(physical)) copyTree(path.join(physical, name), path.join(to, name), sourceRoot);
  } else copy(physical, to);
}
function writeJson(file, value) { fs.writeFileSync(file, JSON.stringify(value, null, 2) + '\n', { flag: 'wx', mode: 0o644 }); }
async function download(name, target) {
  const source = SUPPLIES[name], response = await fetch(source.url, { signal: AbortSignal.timeout(600000) });
  if (!response.ok || Number(response.headers.get('content-length')) > 512 * 1024 * 1024) throw new Error('Linux supply download failed: ' + name);
  const chunks = []; let size = 0;
  for await (const chunk of response.body) {
    size += chunk.length; if (size > 512 * 1024 * 1024) throw new Error('Linux supply size limit'); chunks.push(chunk);
  }
  const bytes = Buffer.concat(chunks, size);
  if (digest(bytes) !== source.sha256) throw new Error('Linux supply checksum mismatch: ' + name);
  fs.writeFileSync(target, bytes, { flag: 'wx', mode: 0o600 });
}
// Extract only validated archive members; resolve archive links to regular archive bytes.
// Do not hand a checksum-verified archive unrestricted filesystem extraction privileges.
const EXTRACT_TAR = String.raw`import os,sys,tarfile,posixpath,shutil
archive,destination,prefix=sys.argv[1:]
with tarfile.open(archive, 'r:*') as source:
 members=source.getmembers(); entries={m.name.rstrip('/'):m for m in members}
 if len(entries)!=len(members) or len(entries)>100000: raise ValueError('archive members')
 total=0
 for member in members:
  name=member.name.rstrip('/')
  if name!=prefix and not name.startswith(prefix+'/'): raise ValueError('archive prefix')
  if name.startswith('/') or any(x in ('','..','.') for x in name.split('/')) or '\\' in name or any(ord(c)<32 for c in name): raise ValueError('archive path')
  if not (member.isdir() or member.isfile() or member.issym() or member.islnk()): raise ValueError('archive type')
  total+=member.size
  if member.size>512*1024*1024 or total>2*1024*1024*1024: raise ValueError('archive size')
 for member in members:
  name=member.name.rstrip('/'); relative=name[len(prefix):].lstrip('/')
  if not relative: continue
  for parent in list(__import__('pathlib').PurePosixPath(name).parents)[:-1]:
   item=entries.get(str(parent))
   if item and not item.isdir(): raise ValueError('archive non-directory ancestor')
  target=os.path.join(destination,relative)
  if member.isdir(): os.makedirs(target,mode=0o755,exist_ok=True); continue
  resolved=member; visited=set()
  while resolved.issym() or resolved.islnk():
   if resolved.name in visited: raise ValueError('archive link cycle')
   visited.add(resolved.name)
   link=resolved.linkname
   if link.startswith('/') or '\\' in link: raise ValueError('archive link')
   linked=posixpath.normpath(posixpath.join(posixpath.dirname(resolved.name),link)) if resolved.issym() else posixpath.normpath(link)
   if not linked.startswith(prefix+'/') or linked not in entries: raise ValueError('archive link escape')
   resolved=entries[linked]
  if not resolved.isfile(): raise ValueError('archive link target')
  os.makedirs(os.path.dirname(target),mode=0o755,exist_ok=True)
  with source.extractfile(resolved) as inp, open(target,'xb') as out: shutil.copyfileobj(inp,out)
  os.chmod(target,0o755 if member.mode & 0o111 else 0o644)
  os.utime(target,(resolved.mtime,resolved.mtime))
`;
function sourceNotices(runtime, sources) {
  const names = { postgres: 'COPYRIGHT', pgvector: 'LICENSE', redis: 'COPYING', jdk: 'legal/java.base/LICENSE' };
  for (const [name, relative] of Object.entries(names)) copy(path.join(sources[name], relative), path.join(runtime, 'notices', name + '.txt'));
  copyTree(path.join(sources.jdk, 'legal'), path.join(runtime, 'notices', 'jdk'));
}
function collectLibraries(runtime) {
  const system = new Map();
  for (const line of output('/sbin/ldconfig', ['-p']).split('\n')) {
    const match = line.match(/^\s*(\S+) \([^)]*x86-64[^)]*\) => (\/\S+)$/);
    if (match && !system.has(match[1])) system.set(match[1], match[2]);
  }
  const packages = {}, records = {}, queue = [...inventory(runtime)], byName = new Map();
  for (const [relative, item] of queue) if (item.elf) {
    const base = path.basename(relative);
    if (byName.has(base) && byName.get(base).hash !== item.hash) throw new Error('Conflicting Linux native library basename: ' + base);
    byName.set(base, { relative, hash: item.hash });
    const source = relative.startsWith('jre/') ? 'jdk' : relative === 'postgres/lib/vector.so' ? 'pgvector'
      : relative.startsWith('postgres/') ? 'postgres' : 'redis';
    records[relative] = { source, notices: ['notices/' + source + '.txt'] };
  }
  for (let index = 0; index < queue.length; index++) {
    const [, item] = queue[index]; if (!item.elf) continue;
    for (const name of item.elf.needed) {
      if (SYSTEM_LIBRARIES.has(name) || byName.has(name)) continue;
      const original = system.get(name);
      if (!original) throw new Error('Missing Linux shared library: ' + name);
      const physical = fs.realpathSync(original), relative = 'lib/' + name;
      if (!/^\/(?:usr\/)?lib(?:64)?\//.test(physical)) throw new Error('Non-system Linux dependency refused');
      let ownership;
      for (const candidate of [original, physical]) {
        try { ownership = output('/usr/bin/dpkg-query', ['-S', candidate]); break; } catch { /* Try merged-/usr spelling. */ }
      }
      const packageName = ownership?.split('\n')[0].split(': ')[0];
      if (!packageName || !/^[a-z0-9][a-z0-9+.-]*(?::amd64)?$/.test(packageName)) throw new Error('Dependency package provenance missing: ' + name);
      const version = output('/usr/bin/dpkg-query', ['-W', '-f=${Version}', packageName]);
      const notice = 'notices/system/' + packageName.replace(':', '-') + '.txt';
      if (!packages[packageName]) {
        copy(fs.realpathSync('/usr/share/doc/' + packageName.split(':')[0] + '/copyright'), path.join(runtime, notice));
        packages[packageName] = { version, notice };
      }
      copy(physical, path.join(runtime, relative));
      const bytes = fs.readFileSync(path.join(runtime, relative)), elf = parseElfHeader(bytes);
      if (!elf) throw new Error('Dependency is not an ELF library');
      const copied = { hash: digest(bytes), elf: { ...elf, ...inspectElf(path.join(runtime, relative)) } };
      queue.push([relative, copied]); byName.set(name, { relative, hash: copied.hash });
      records[relative] = { source: 'deb:' + packageName + '=' + version, notices: [notice] };
    }
  }
  // Every ELF gets a closed relative path. In particular JRE dlopen(libjvm) and
  // PostgreSQL extensions must not search the build host's original prefix.
  for (const [relative, item] of queue) if (item.elf) {
    const directories = [path.posix.dirname(relative), 'lib', 'postgres/lib', 'jre/lib', 'jre/lib/server'];
    const rpath = [...new Set(directories.map(directory => {
      const suffix = path.posix.relative(path.posix.dirname(relative), directory);
      return '$ORIGIN' + (suffix ? '/' + suffix : '');
    }))].join(':');
    command('/usr/bin/patchelf', ['--set-rpath', rpath, path.join(runtime, relative)], runtime);
    records[relative].sha256 = digest(fs.readFileSync(path.join(runtime, relative)));
  }
  validateClosure(inventory(runtime)); return { files: records, systemPackages: packages };
}
async function provision(destination) {
  requireLinuxHost();
  if (typeof process.getuid !== 'function' || process.getuid() === 0) throw new Error('Provision as an ordinary Linux build user');
  fresh(destination);
  const archives = path.join(destination, 'archives'); fs.mkdirSync(archives);
  const sources = {};
  for (const name of Object.keys(SUPPLIES)) {
    const archive = path.join(archives, name + '.tar'), target = path.join(destination, name + '-source');
    await download(name, archive); fs.mkdirSync(target);
    command('/usr/bin/python3', ['-c', EXTRACT_TAR, archive, target, SUPPLIES[name].prefix], destination);
    sources[name] = target;
  }
  const runtime = path.join(destination, 'runtime'); fs.mkdirSync(runtime, { mode: 0o755 });
  const jdk = sources.jdk, jre = path.join(runtime, 'jre');
  command(path.join(jdk, 'bin/jlink'), ['--add-modules', JAVA_MODULES, '--strip-debug', '--no-header-files', '--no-man-pages',
    '--compress=zip-6', '--output', path.join(destination, 'jre-image')], destination);
  copyTree(path.join(destination, 'jre-image'), jre);
  const env = { ...process.env, LC_ALL: 'C', CFLAGS: '-O2 -fPIC', CXXFLAGS: '-O2 -fPIC' };
  const jobs = String(Math.max(1, Math.min(os.availableParallelism?.() || os.cpus().length, 8)));
  const pgBuild = path.join(destination, 'postgres-install');
  // A fixed build prefix + DESTDIR makes PostgreSQL's own relative-prefix lookup
  // resolve share/lib from the relocated executable directory on the user's host.
  command(path.join(sources.postgres, 'configure'), ['--prefix=/opt/code-intelligence/postgres', '--with-openssl',
    '--without-readline', '--without-icu', '--without-zlib'], sources.postgres, env);
  command('make', ['-j' + jobs], sources.postgres, env);
  command('make', ['install', 'DESTDIR=' + pgBuild], sources.postgres, env);
  command('make', ['-j' + jobs], path.join(sources.postgres, 'contrib/pg_trgm'), env);
  command('make', ['install', 'DESTDIR=' + pgBuild], path.join(sources.postgres, 'contrib/pg_trgm'), env);
  const pg = path.join(pgBuild, 'opt/code-intelligence/postgres');
  const vectorEnv = { ...env, PG_CONFIG: path.join(pg, 'bin/pg_config') };
  command('make', ['-j' + jobs, 'OPTFLAGS='], sources.pgvector, vectorEnv);
  // pg_config reports the relocated private installation, so no global install.
  command('make', ['install', 'OPTFLAGS='], sources.pgvector, vectorEnv);
  for (const name of ['postgres', 'initdb', 'pg_isready', 'psql', 'createdb', 'pg_dump', 'pg_restore'])
    copy(path.join(pg, 'bin', name), path.join(runtime, 'postgres/bin', name));
  for (const name of fs.readdirSync(path.join(pg, 'lib')).filter(name => /\.so(?:\.[0-9]+)*$/.test(name)))
    copy(fs.realpathSync(path.join(pg, 'lib', name)), path.join(runtime, 'postgres/lib', name));
  copyTree(path.join(pg, 'share'), path.join(runtime, 'postgres/share'));
  command('make', ['-j' + jobs, 'BUILD_TLS=yes', 'MALLOC=libc'], sources.redis, env);
  copy(path.join(sources.redis, 'src/redis-server'), path.join(runtime, 'redis/bin/redis-server'));
  sourceNotices(runtime, sources);
  const closure = collectLibraries(runtime);
  writeJson(path.join(runtime, 'linux-provenance.json'), { format: 1, platform: 'linux', arch: 'x64', minimumGlibc: '2.35',
    sources: SUPPLIES, ...closure, recipes: { postgres: 'source/openssl/no-readline/no-icu/no-zlib',
      pgvector: 'source/OPTFLAGS=', redis: 'source/BUILD_TLS=yes/MALLOC=libc', jre: 'Temurin21/jlink', libraries: 'dpkg/readelf/patchelf-relative-rpath' } });
  require('./linux-runtime-policy.cjs').verifyLinuxRuntime({ root: runtime,
    provenance: JSON.parse(fs.readFileSync(path.join(runtime, 'linux-provenance.json'))) });
  writeJson(path.join(destination, 'supply.json'), { format: 1, platform: 'linux', arch: 'x64', jdk, runtime, sources: SUPPLIES });
  return { jdk, runtime };
}
if (require.main === module) {
  const destination = process.argv[2];
  if (!destination) { console.error('Usage: node provision-linux-runtime.cjs /absolute/fresh/output'); process.exitCode = 1; }
  else provision(path.resolve(destination)).then(() => console.log('Linux runtime supply prepared; native product acceptance remains separate.'))
    .catch(error => { console.error(error); process.exitCode = 1; });
}
module.exports = { provision, command, copy, copyTree, writeJson, collectLibraries, EXTRACT_TAR };
