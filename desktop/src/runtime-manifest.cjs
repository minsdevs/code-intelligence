'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { runtimeRelativePath } = require('./runtime-platform.cjs');
const { RuntimeIntegrityError, integrityError } = require('./startup-diagnostics.cjs');
// Structural/integrity gate used before any bundled helper executes. Build-time PE
// closure and provenance are separately verified before the manifest is published.
async function validateRuntimeManifest(root, manifest, { platform = process.platform, arch = process.arch, onFailure } = {}) {
  const invalid = (code = 'RUNTIME_MANIFEST_INVALID') => { throw new RuntimeIntegrityError(code); };
  const relativePath = (raw, label) => {
    try { return runtimeRelativePath(raw, label, platform); } catch { invalid('RUNTIME_MANIFEST_PATH'); }
  };
  let operation = 'STRUCTURE';
  try {
  if (!manifest || manifest.format !== 1 || !manifest.files || Array.isArray(manifest.files)) invalid();
  if (manifest.platform !== platform || manifest.arch !== arch) invalid('RUNTIME_MANIFEST_PLATFORM');
  if (!/^(0|[1-9][0-9]{0,18})$/.test(manifest.buildSequence) || typeof manifest.buildSequence !== 'string'
    || BigInt(manifest.buildSequence) > 9223372036854775807n) invalid('RUNTIME_MANIFEST_BUILD');
  if (platform === 'win32' && (arch !== 'x64' || manifest.runtime?.cache !== 'garnet-2.2.0'
    || manifest.backupProtocol !== 3 || manifest.ownershipProtocol !== 1)) invalid('RUNTIME_MANIFEST_PROTOCOL');
  const paths = new Map(), expected = Object.entries(manifest.files);
  if (!expected.length || expected.length > 100000 || Object.hasOwn(manifest.files, 'runtime-manifest.json')) invalid();
  for (const [name, hash] of expected) {
    relativePath(name, 'file path');
    if (typeof hash !== 'string' || !/^[a-f0-9]{64}$/.test(hash)) invalid();
    const key = platform === 'win32' ? name.toLowerCase() : name;
    if (paths.has(key)) invalid(); paths.set(key, name);
  }
  for (const key of ['postgresBin', 'postgresLib', 'postgresPkgLib', 'postgresShare']) {
    const relative = relativePath(manifest.runtime?.[key], 'PostgreSQL layout');
    if (!relative.startsWith('postgres/')) invalid('RUNTIME_MANIFEST_PATH');
  }
  const seen = new Set(), allNames = new Set(); let count = 0;
  const stamp = stat => [stat.dev, stat.ino, stat.size, stat.mtimeNs, stat.ctimeNs, stat.nlink].join(':');
  async function visit(relative, depth) {
    if (++count > 100000 || depth > 64) invalid('RUNTIME_INVENTORY_LIMIT');
    if (relative) relativePath(relative, 'inventory path');
    const absolute = relative ? path.join(root, ...relative.split('/')) : root;
    operation = 'LSTAT';
    const stat = await fs.promises.lstat(absolute, { bigint: true });
    if (stat.isSymbolicLink()) invalid('RUNTIME_INVENTORY_TYPE');
    if (relative) {
      const folded = platform === 'win32' ? relative.toLowerCase() : relative;
      if (allNames.has(folded)) invalid('RUNTIME_INVENTORY_UNEXPECTED'); allNames.add(folded);
    }
    if (stat.isDirectory()) {
      operation = 'READDIR';
      for (const name of await fs.promises.readdir(absolute)) await visit(relative ? relative + '/' + name : name, depth + 1);
      return;
    }
    if (!stat.isFile() || stat.nlink !== 1n) invalid('RUNTIME_INVENTORY_TYPE');
    if (stat.size > 512n * 1024n * 1024n) invalid('RUNTIME_INVENTORY_LIMIT');
    if (relative === 'runtime-manifest.json') return;
    if (!Object.hasOwn(manifest.files, relative)) invalid('RUNTIME_INVENTORY_UNEXPECTED');
    operation = 'OPEN';
    const handle = await fs.promises.open(absolute, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
    let readFailed = false;
    try {
      operation = 'HANDLE_STAT_PRE';
      if (stamp(await handle.stat({ bigint: true })) !== stamp(stat)) invalid('RUNTIME_INVENTORY_CHANGED');
      operation = 'STREAM';
      const hash = crypto.createHash('sha256');
      for await (const bytes of handle.createReadStream({ autoClose: false })) hash.update(bytes);
      operation = 'HASH';
      if (hash.digest('hex') !== manifest.files[relative]) invalid('RUNTIME_INVENTORY_HASH');
      operation = 'HANDLE_STAT_POST';
      if (stamp(await handle.stat({ bigint: true })) !== stamp(stat)) invalid('RUNTIME_INVENTORY_CHANGED');
      operation = 'LSTAT_POST';
      if (stamp(await fs.promises.lstat(absolute, { bigint: true })) !== stamp(stat)) invalid('RUNTIME_INVENTORY_CHANGED');
    } catch (error) { readFailed = true; throw error; }
    finally {
      // A failed close must not replace an already observed integrity/read error.
      const previous = operation; operation = 'CLOSE';
      try { await handle.close(); } catch (error) { if (!readFailed) throw error; }
      finally { if (readFailed) operation = previous; }
    }
    seen.add(relative);
  }
  await visit('', 0);
  operation = 'FINALIZE';
  if (seen.size !== expected.length) invalid('RUNTIME_INVENTORY_MISSING');
  if (platform === 'win32') for (const name of ['native/windows/codeintel-boundary.exe', 'jre/bin/java.exe', 'cache/GarnetServer.exe',
    'cache/coreclr.dll', 'cache/GarnetServer.runtimeconfig.json', 'windows-provenance.json', 'backend/code-intelligence.jar',
    'postgres/bin/postgres.exe', 'postgres/lib/vector.dll', 'postgres/lib/pg_trgm.dll']) if (!seen.has(name)) invalid('RUNTIME_INVENTORY_MISSING');
  return manifest;
  } catch (error) {
    const failure = integrityError(error);
    if (typeof onFailure === 'function') {
      try { Promise.resolve(onFailure(operation, error)).catch(() => {}); }
      catch { /* Diagnostics can never affect verification. */ }
    }
    throw failure;
  }
}
module.exports = { validateRuntimeManifest };
