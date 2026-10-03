const crypto = require('node:crypto');
const fs = require('node:fs/promises');
const { createReadStream } = require('node:fs');
const path = require('node:path');

async function exists(file) {
  try { await fs.lstat(file); return true; } catch (error) {
    if (error.code === 'ENOENT') return false;
    throw error;
  }
}

async function hashFile(file) {
  const hash = crypto.createHash('sha256');
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest('hex');
}

async function requireDirectory(directory) {
  const stat = await fs.lstat(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('Backup directories must not be symbolic links.');
}

async function fileHashes(root) {
  await requireDirectory(root);
  const hashes = {};
  async function walk(directory, prefix) {
    for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
      const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
      const absolute = path.join(directory, entry.name);
      const stat = await fs.lstat(absolute);
      if (stat.isSymbolicLink()) throw new Error('Symbolic links are not allowed in backups.');
      if (stat.isDirectory()) await walk(absolute, relative);
      else if (stat.isFile()) {
        if (relative !== 'manifest.json') hashes[relative] = await hashFile(absolute);
      } else throw new Error('Special files are not allowed in backups.');
    }
  }
  await walk(root, '');
  return hashes;
}

async function copyDirectory(source, destination) {
  await requireDirectory(source);
  await fs.mkdir(destination, { recursive: true, mode: 0o700 });
  for (const entry of await fs.readdir(source, { withFileTypes: true })) {
    const sourceFile = path.join(source, entry.name);
    const target = path.join(destination, entry.name);
    const stat = await fs.lstat(sourceFile);
    if (stat.isDirectory() && !stat.isSymbolicLink()) await copyDirectory(sourceFile, target);
    else if (stat.isFile() && !stat.isSymbolicLink()) await fs.copyFile(sourceFile, target);
    else throw new Error('Symbolic links and special files are not allowed in backups.');
  }
}

async function validateBackup(source, installationId) {
  await requireDirectory(source);
  const manifestFile = path.join(source, 'manifest.json');
  const stat = await fs.lstat(manifestFile);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 16 * 1024 * 1024) {
    throw new Error('Invalid backup manifest.');
  }
  const manifest = JSON.parse(await fs.readFile(manifestFile, 'utf8'));
  if (manifest.format !== 1 && manifest.format !== 2) throw new Error('Unsupported backup format.');
  if (manifest.format === 2 && manifest.installationId !== installationId) {
    throw new Error('This backup belongs to a different installation. Portable identity/key recovery is not supported.');
  }
  const hashes = await fileHashes(source);
  if (!hashes['database.dump']) throw new Error('Backup database dump is missing.');
  if (manifest.format === 1) {
    if (hashes['database.dump'] !== manifest.databaseSha256) throw new Error('Backup database integrity validation failed.');
  } else {
    await requireDirectory(path.join(source, 'repositories'));
    if (!manifest.files || typeof manifest.files !== 'object' || Array.isArray(manifest.files)
        || JSON.stringify(Object.keys(hashes).sort()) !== JSON.stringify(Object.keys(manifest.files).sort())
        || Object.entries(hashes).some(([file, hash]) => manifest.files[file] !== hash)) {
      throw new Error('Backup file integrity validation failed.');
    }
  }
  return manifest;
}

async function createBackup({ destination, repositories, installationId, dumpDatabase }) {
  await fs.mkdir(path.dirname(destination), { recursive: true, mode: 0o700 });
  if (await exists(repositories)) {
    const sourceRoot = await fs.realpath(repositories);
    const target = path.join(await fs.realpath(path.dirname(destination)), path.basename(destination));
    const relative = path.relative(sourceRoot, target);
    if (!relative || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative))) {
      throw new Error('Backup destination must be outside repository storage.');
    }
  }
  // Never overwrite or delete a pre-existing destination, including a failed old export.
  await fs.mkdir(destination, { mode: 0o700 });
  try {
    await dumpDatabase(path.join(destination, 'database.dump'));
    const target = path.join(destination, 'repositories');
    if (await exists(repositories)) await copyDirectory(repositories, target);
    else await fs.mkdir(target, { mode: 0o700 });
    const manifest = {
      format: 2, installationId, createdAt: new Date().toISOString(), files: await fileHashes(destination)
    };
    await fs.writeFile(path.join(destination, 'manifest.json'), JSON.stringify(manifest, null, 2), { mode: 0o600 });
    return destination;
  } catch (error) {
    await fs.rm(destination, { recursive: true, force: true }).catch(() => {});
    throw error;
  }
}

/** Backend must stay stopped for the whole operation; SQL restoration must use one transaction. */
async function restoreBackup({ source, repositories, installationId, recovery, dumpDatabase, restoreDatabase }) {
  await validateBackup(source, installationId);
  await fs.mkdir(path.dirname(repositories), { recursive: true, mode: 0o700 });
  const recoveryMarker = path.join(path.dirname(repositories), '.restore-recovery-required.json');
  if (await exists(recoveryMarker)) throw new Error('An earlier interrupted restore requires recovery first.');
  const workspace = await fs.mkdtemp(path.join(path.dirname(repositories), '.restore-'));
  const incoming = path.join(workspace, 'incoming');
  const previous = path.join(workspace, 'previous');
  let movedPrevious = false;
  let installedIncoming = false;
  let databaseAttempted = false;
  let keepWorkspace = false;
  try {
    await copyDirectory(source, incoming);
    // Recheck the copied bytes; later edits to the selected folder cannot change the restore.
    await validateBackup(incoming, installationId);
    if (!await exists(path.join(incoming, 'repositories'))) {
      await fs.mkdir(path.join(incoming, 'repositories'), { mode: 0o700 });
    }
    await createBackup({ destination: recovery, repositories, installationId, dumpDatabase });
    try {
      // A process/machine crash between DB and file operations must fail closed on next launch.
      await fs.writeFile(recoveryMarker, JSON.stringify({ recovery, workspace }), { mode: 0o600 });
      if (await exists(repositories)) {
        await fs.rename(repositories, previous);
        movedPrevious = true;
      }
      await fs.rename(path.join(incoming, 'repositories'), repositories);
      installedIncoming = true;
      databaseAttempted = true;
      await restoreDatabase(path.join(incoming, 'database.dump'));
      await fs.rm(recoveryMarker);
      return { restored: true, recoveryBackup: recovery };
    } catch (error) {
      const rollbackErrors = [];
      // A client-side failure may arrive after SQL committed; restore the recovery dump too.
      if (databaseAttempted) {
        try { await restoreDatabase(path.join(recovery, 'database.dump')); }
        catch (rollbackError) { rollbackErrors.push(rollbackError); }
      }
      try {
        if (installedIncoming) await fs.rm(repositories, { recursive: true, force: true });
        if (movedPrevious) await fs.rename(previous, repositories);
      } catch (rollbackError) { rollbackErrors.push(rollbackError); }
      if (rollbackErrors.length === 0) {
        try { await fs.rm(recoveryMarker, { force: true }); }
        catch (rollbackError) { rollbackErrors.push(rollbackError); }
      }
      keepWorkspace = rollbackErrors.length > 0;
      const failure = new Error(keepWorkspace
        ? `Restore and rollback failed. Runtime remains stopped. Recovery backup: ${recovery}; staging: ${workspace}`
        : `Restore failed; previous database and repositories recovered. Recovery backup: ${recovery}`,
      { cause: error });
      failure.recoveryRequired = keepWorkspace;
      throw failure;
    }
  } finally {
    if (!keepWorkspace) await fs.rm(workspace, { recursive: true, force: true }).catch(() => {});
  }
}

module.exports = { createBackup, restoreBackup, validateBackup };
