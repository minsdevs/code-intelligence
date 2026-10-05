'use strict';

// Static, owned repository output boundary. All ancestors are checked before the
// first mkdir/write; this is not confinement against a hostile same-UID renamer.
const fs = require('node:fs');
const path = require('node:path');

function refuse() { throw Object.assign(new Error('OWNED_OUTPUT_REFUSED'), { code: 'OWNED_OUTPUT_REFUSED' }); }
function checkedDirectory(directory, privateMode = false) {
  const stat = fs.lstatSync(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink() || typeof process.getuid !== 'function'
      || stat.uid !== process.getuid() || (stat.mode & 0o7022) || fs.realpathSync(directory) !== directory
      || (privateMode && (stat.mode & 0o777) !== 0o700)) refuse();
  return stat;
}
function ensureOutputParent(repo, relative) {
  if (typeof repo !== 'string' || !path.isAbsolute(repo) || path.normalize(repo) !== repo
      || typeof relative !== 'string' || !/^validation\/local(?:\/[A-Za-z0-9][A-Za-z0-9._-]*)*$/.test(relative)) refuse();
  const parts = relative.split('/');
  if (parts.some(p => p === '.' || p === '..')) refuse();
  checkedDirectory(repo);
  let directory = repo;
  for (let index = 0; index < parts.length; index++) {
    directory = path.join(directory, parts[index]);
    try { fs.lstatSync(directory); }
    catch (error) {
      if (error.code !== 'ENOENT') throw error;
      // Existing parents were checked in the preceding iteration.
      fs.mkdirSync(directory, { mode: 0o700 });
    }
    // validation/local is a shared repository evidence parent. It may be 0755;
    // each run family/fresh run beneath it must be private before receiving data.
    checkedDirectory(directory, index >= 2);
  }
  return directory;
}
function assertOutputPath(root, file) {
  if (typeof file !== 'string' || !path.isAbsolute(file) || path.normalize(file) !== file) refuse();
  const relative = path.relative(root, file);
  if (!relative || relative === '..' || relative.startsWith('..' + path.sep) || path.isAbsolute(relative)) refuse();
  checkedDirectory(root, true);
  let current = root;
  for (const part of path.relative(root, path.dirname(file)).split(path.sep).filter(Boolean)) {
    current = path.join(current, part); checkedDirectory(current, true);
  }
  return file;
}
module.exports = { ensureOutputParent, assertOutputPath };
