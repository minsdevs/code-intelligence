'use strict';
const path = require('node:path');

// Manifest paths use forward slashes on every OS. Do not interpret drive-relative
// paths, NTFS streams, device names or Win32-normalized aliases as bundled files.
function runtimeRelativePath(raw, label = 'file path', platform = process.platform) {
  const invalid = () => { throw new Error(`Bundled runtime manifest has an unsafe ${label}.`); };
  if (typeof raw !== 'string' || !raw || raw.length > 4096 || /[\\:\x00-\x1f\x7f]/.test(raw)) invalid();
  const parts = raw.split('/');
  if (parts.some(part => !part || part === '.' || part === '..')) invalid();
  if (platform === 'win32' && parts.some(part => /[<>"|?*]|[. ]$/.test(part)
      || /^(?:con|prn|aux|nul|com[1-9¹²³]|lpt[1-9¹²³])(?:\.|$)/i.test(part))) invalid();
  return raw;
}

const EXECUTABLES = new Set(['jre/bin/java', 'redis/bin/redis-server',
  ...['postgres','initdb','pg_isready','psql','createdb','pg_dump','pg_restore'].map(name => `postgres/bin/${name}`)]);

function runtimeFile(root, parts, postgresBinRoot, platform = process.platform) {
  const paths = platform === 'win32' ? path.win32 : path.posix;
  if (!paths.isAbsolute(root) || platform === 'win32' && (!/^[A-Za-z]:\\/.test(root)
      || paths.normalize(root) !== root || /[\x00-\x1f\x7f]/.test(root))
      || !Array.isArray(parts) || parts.some(part => typeof part !== 'string' || part.includes('/')))
    throw new Error('Invalid bundled runtime path.');
  const logical = runtimeRelativePath(parts.join('/'), 'file path', platform);
  const relative = parts[0] === 'postgres' && parts[1] === 'bin' && postgresBinRoot
    ? `${runtimeRelativePath(postgresBinRoot, 'PostgreSQL bin path', platform)}/${parts.slice(2).join('/')}` : logical;
  const executable = platform === 'win32' && EXECUTABLES.has(logical) ? `${relative}.exe` : relative;
  return paths.join(root, ...runtimeRelativePath(executable, 'file path', platform).split('/'));
}

function inheritedEnvironment(env, platform = process.platform) {
  const result = {};
  const names = ['PATH', 'HOME', 'TMPDIR', 'LANG', 'LC_ALL', 'LC_CTYPE', 'TZ', 'USER', 'LOGNAME'];
  if (platform === 'win32') names.push('SystemRoot', 'SystemDrive', 'WINDIR', 'TEMP', 'TMP', 'USERPROFILE');
  for (const name of names) {
    const key = Object.hasOwn(env, name) ? name : platform === 'win32'
      ? Object.keys(env).find(key => key.toLowerCase() === name.toLowerCase()) : undefined;
    if (key && typeof env[key] === 'string') result[name] = env[key];
  }
  return result;
}

function libraryEnvironment(root, directories, env, platform = process.platform) {
  const paths = platform === 'win32' ? path.win32 : path.posix;
  const absolute = directories.map(directory => paths.join(root, ...runtimeRelativePath(directory, 'library path', platform).split('/')));
  if (platform === 'win32') return { PATH: [...absolute, inheritedEnvironment(env, platform).PATH].filter(Boolean).join(';') };
  return { DYLD_LIBRARY_PATH: absolute.join(':'), LD_LIBRARY_PATH: absolute.join(':') };
}

module.exports = { runtimeRelativePath, runtimeFile, inheritedEnvironment, libraryEnvironment };
