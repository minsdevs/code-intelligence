'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { runtimeRelativePath } = require('./runtime-platform.cjs');
// Structural/integrity gate used before any bundled helper executes. Build-time PE
// closure and provenance are separately verified before the manifest is published.
async function validateRuntimeManifest(root, manifest, { platform = process.platform, arch = process.arch } = {}) {
  const invalid = () => { throw new Error('Bundled runtime manifest or inventory is invalid.'); };
  if (!manifest || manifest.format !== 1 || manifest.platform !== platform || manifest.arch !== arch
    || !/^(0|[1-9][0-9]{0,18})$/.test(manifest.buildSequence) || typeof manifest.buildSequence !== 'string'
    || BigInt(manifest.buildSequence) > 9223372036854775807n || !manifest.files || Array.isArray(manifest.files)) invalid();
  if (platform === 'win32' && (arch !== 'x64' || manifest.runtime?.cache !== 'garnet-2.2.0'
    || manifest.backupProtocol !== 3 || manifest.ownershipProtocol !== 1)) invalid();
  const paths = new Map(), expected = Object.entries(manifest.files);
  if (!expected.length || expected.length > 100000 || Object.hasOwn(manifest.files, 'runtime-manifest.json')) invalid();
  for (const [name, hash] of expected) {
    runtimeRelativePath(name, 'file path', platform);
    if (typeof hash !== 'string' || !/^[a-f0-9]{64}$/.test(hash)) invalid();
    const key = platform === 'win32' ? name.toLowerCase() : name;
    if (paths.has(key)) invalid(); paths.set(key, name);
  }
  for (const key of ['postgresBin', 'postgresLib', 'postgresPkgLib', 'postgresShare']) {
    const relative = runtimeRelativePath(manifest.runtime?.[key], 'PostgreSQL layout', platform);
    if (!relative.startsWith('postgres/')) invalid();
  }
  const seen = new Set(), allNames = new Set(); let count = 0;
  const stamp = stat => [stat.dev, stat.ino, stat.size, stat.mtimeNs, stat.ctimeNs, stat.nlink].join(':');
  async function visit(relative, depth) {
    if (++count > 100000 || depth > 64) invalid();
    if (relative) runtimeRelativePath(relative, 'inventory path', platform);
    const absolute = relative ? path.join(root, ...relative.split('/')) : root;
    const stat = await fs.promises.lstat(absolute, { bigint: true });
    if (stat.isSymbolicLink()) invalid();
    if (relative) {
      const folded = platform === 'win32' ? relative.toLowerCase() : relative;
      if (allNames.has(folded)) invalid(); allNames.add(folded);
    }
    if (stat.isDirectory()) {
      for (const name of await fs.promises.readdir(absolute)) await visit(relative ? relative + '/' + name : name, depth + 1);
      return;
    }
    if (!stat.isFile() || stat.nlink !== 1n || stat.size > 512n * 1024n * 1024n) invalid();
    if (relative === 'runtime-manifest.json') return;
    if (!Object.hasOwn(manifest.files, relative)) invalid();
    const handle = await fs.promises.open(absolute, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
    try {
      if (stamp(await handle.stat({ bigint: true })) !== stamp(stat)) invalid();
      const hash = crypto.createHash('sha256');
      for await (const bytes of handle.createReadStream({ autoClose: false })) hash.update(bytes);
      if (hash.digest('hex') !== manifest.files[relative] || stamp(await handle.stat({ bigint: true })) !== stamp(stat)
        || stamp(await fs.promises.lstat(absolute, { bigint: true })) !== stamp(stat)) invalid();
    } finally { await handle.close(); }
    seen.add(relative);
  }
  await visit('', 0);
  if (seen.size !== expected.length) invalid();
  if (platform === 'win32') for (const name of ['native/windows/codeintel-boundary.exe', 'jre/bin/java.exe', 'cache/GarnetServer.exe',
    'cache/coreclr.dll', 'cache/GarnetServer.runtimeconfig.json', 'windows-provenance.json', 'backend/code-intelligence.jar',
    'postgres/bin/postgres.exe', 'postgres/lib/vector.dll', 'postgres/lib/pg_trgm.dll']) if (!seen.has(name)) invalid();
  return manifest;
}
module.exports = { validateRuntimeManifest };
