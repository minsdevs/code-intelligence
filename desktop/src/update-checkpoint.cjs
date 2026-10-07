'use strict';

// Main process only. Pre-migration checkpoint for G-UPDATE (ADR-02, NU-02). On the first start of a
// build whose Flyway target exceeds the recorded schema, the stopped PostgreSQL cluster is cloned
// (a cold, crash-consistent copy; APFS clone where available) together with the source-vault root
// identities, the area-B journal pointer and the previous bundle identity, before any backend can
// migrate. A failed migration leaves the record open: the next start is recovery-only and offers to
// restore the database while the newest source vault and safety journal are kept.
const crypto = require('node:crypto');
const fs = require('node:fs/promises');
const { constants } = require('node:fs');
const path = require('node:path');

const ROOT = 'update-checkpoints';
const STATES = Object.freeze(['PREPARING', 'MIGRATING', 'FAILED', 'RESTORING', 'COMMITTED', 'RESTORED']);
// Open records block normal startup; PREPARING never reached a migration and is discarded.
const OPEN = new Set(['MIGRATING', 'FAILED', 'RESTORING']);
const RECORD_FIELDS = ['format', 'id', 'state', 'createdByBuild', 'schemaFlyway', 'previousBundle', 'targetBuild', 'targetFlyway',
  'journal', 'sources', 'createdAt'];
const BUILD = /^(0|[1-9][0-9]{0,18})$/;
const HASH = /^[0-9a-f]{64}$/;
const ID = /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

class UpdateCheckpointError extends Error {
  constructor(code) { super(code); this.name = 'UpdateCheckpointError'; this.code = code; this.recoveryOnly = true; }
}
const fail = (code = 'UPDATE_CHECKPOINT_INVALID') => { throw new UpdateCheckpointError(code); };

// Deterministic per transition, so a publisher can bind a signed recovery manifest for
// "build N data upgraded by build M" without knowing anything about one installation.
function checkpointIdFor(fromBuild, toBuild) {
  if (!BUILD.test(fromBuild) || !BUILD.test(toBuild)) fail();
  const bytes = crypto.createHash('sha256').update(`CI-UPDATE-CHECKPOINT-1\0${fromBuild}\0${toBuild}`).digest().subarray(0, 16);
  bytes[6] = (bytes[6] & 0x0f) | 0x50; bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = bytes.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
function bundleIdentity(value) {
  if (value === null) return null;
  if (!value || typeof value !== 'object' || Object.keys(value).sort().join(',') !== 'asarSha256,build,path,runtimeManifestSha256'
      || typeof value.path !== 'string' || !path.isAbsolute(value.path) || !BUILD.test(value.build)
      || !HASH.test(value.runtimeManifestSha256) || !HASH.test(value.asarSha256)) fail();
  return { path: value.path, build: value.build, runtimeManifestSha256: value.runtimeManifestSha256, asarSha256: value.asarSha256 };
}
async function privateDirectory(directory, create = false) {
  if (create) { try { await fs.mkdir(directory, { mode: 0o700 }); } catch (error) { if (error.code !== 'EEXIST') throw error; } }
  const stat = await fs.lstat(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== process.getuid() || (stat.mode & 0o077)) fail('UPDATE_CHECKPOINT_STORAGE');
  return stat;
}
async function missing(file) {
  try { await fs.lstat(file); return false; } catch (error) { if (error.code === 'ENOENT') return true; throw error; }
}
async function syncDirectory(directory) {
  const handle = await fs.open(directory, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  try { await handle.sync(); } finally { await handle.close(); }
}
async function writeJson(file, value) {
  const temporary = `${file}.${crypto.randomUUID()}.tmp`;
  const handle = await fs.open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  try { await handle.writeFile(`${JSON.stringify(value)}\n`); await handle.sync(); } finally { await handle.close(); }
  await fs.rename(temporary, file); await syncDirectory(path.dirname(file));
}
async function readJson(file) {
  const stat = await fs.lstat(file);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 65536 || stat.uid !== process.getuid() || (stat.mode & 0o077)) fail('UPDATE_CHECKPOINT_STORAGE');
  try { return JSON.parse(await fs.readFile(file, 'utf8')); } catch { fail(); }
}
function validRecord(value, id) {
  if (!value || typeof value !== 'object' || Object.keys(value).sort().join(',') !== [...RECORD_FIELDS].sort().join(',')
      || value.format !== 1 || value.id !== id || !STATES.includes(value.state) || !BUILD.test(value.createdByBuild)
      || !(value.schemaFlyway === null || Number.isSafeInteger(value.schemaFlyway)) || !BUILD.test(value.targetBuild)
      || !Number.isSafeInteger(value.targetFlyway) || !Number.isSafeInteger(value.createdAt)
      || !value.journal || !Number.isSafeInteger(value.journal.sequence) || !HASH.test(value.journal.headHash)
      || !value.sources || Object.keys(value.sources).sort().join(',') !== 'repos,sources') fail();
  bundleIdentity(value.previousBundle);
  return value;
}
// Copy-on-write on APFS (COPYFILE_FICLONE falls back to a byte copy elsewhere); modes are preserved.
async function cloneTree(source, destination) {
  await fs.cp(source, destination, { recursive: true, errorOnExist: true, force: false, preserveTimestamps: true,
    verbatimSymlinks: true, mode: constants.COPYFILE_FICLONE });
}
// A cold copy is only consistent while no postmaster owns the cluster. A stale pid file from a
// crash is fine (the copy is crash-consistent); a live owner is not.
async function requireStopped(data) {
  let text;
  try { text = await fs.readFile(path.join(data, 'postmaster.pid'), 'utf8'); } catch (error) { if (error.code === 'ENOENT') return; throw error; }
  const pid = Number(text.split('\n')[0]);
  if (!Number.isSafeInteger(pid) || pid < 1) fail('UPDATE_CHECKPOINT_DATABASE_RUNNING');
  try { process.kill(pid, 0); } catch (error) { if (error.code === 'ESRCH') return; }
  fail('UPDATE_CHECKPOINT_DATABASE_RUNNING');
}

async function openUpdateCheckpoints({ userData, runningBuild, targetFlyway, bundle, now = Date.now }) {
  if (typeof userData !== 'string' || !path.isAbsolute(userData) || !BUILD.test(runningBuild)
      || !Number.isSafeInteger(targetFlyway) || targetFlyway < 1) fail();
  const current = bundleIdentity(bundle);
  const root = path.join(userData, ROOT), live = path.join(userData, 'postgres'), dataRoot = path.join(userData, 'data');
  const schemaFile = path.join(root, 'schema.json');
  await privateDirectory(userData); await privateDirectory(root, true);

  async function records() {
    const result = [];
    for (const name of (await fs.readdir(root)).sort()) {
      if (!ID.test(name)) continue;
      await privateDirectory(path.join(root, name));
      result.push(validRecord(await readJson(path.join(root, name, 'record.json')), name));
    }
    return result.sort((a, b) => a.createdAt - b.createdAt);
  }
  async function save(record) { await writeJson(path.join(root, record.id, 'record.json'), validRecord(record, record.id)); }
  async function schema() {
    if (await missing(schemaFile)) return null;
    const value = await readJson(schemaFile);
    if (!value || Object.keys(value).sort().join(',') !== 'build,bundle,flyway,format' || value.format !== 1
        || !BUILD.test(value.build) || !Number.isSafeInteger(value.flyway)) fail();
    bundleIdentity(value.bundle);
    return value;
  }
  async function sourceIdentities() {
    const result = {};
    for (const name of ['repos', 'sources']) {
      const file = path.join(dataRoot, name);
      if (await missing(file)) { result[name] = null; continue; }
      const stat = await fs.lstat(file, { bigint: true });
      if (!stat.isDirectory() || stat.isSymbolicLink()) fail('UPDATE_CHECKPOINT_STORAGE');
      result[name] = `${stat.dev}:${stat.ino}`;
    }
    return result;
  }
  async function pending() { return (await records()).find(record => OPEN.has(record.state)) || null; }
  let retried = null;

  return Object.freeze({
    pending,
    // The retained checkpoint a signed recovery manifest may bind to (update-manifest context).
    async retained() {
      const record = (await records()).filter(item => item.state !== 'PREPARING').at(-1);
      return record ? Object.freeze({ id: record.id, schemaFlyway: record.schemaFlyway ?? 0, createdByBuild: record.createdByBuild }) : null;
    },
    async beforeMigration({ journal }) {
      if (!journal || !Number.isSafeInteger(journal.sequence) || !HASH.test(journal.headHash)) fail();
      const open = await pending();
      if (open && retried === open.id && open.state === 'MIGRATING') return Object.freeze({ ...open });
      if (open) fail('UPDATE_CHECKPOINT_RECOVERY_REQUIRED');
      for (const record of await records()) {
        // An interrupted clone never preceded a migration: the live cluster is untouched.
        if (record.state === 'PREPARING') await fs.rm(path.join(root, record.id), { recursive: true, force: true });
      }
      const recorded = await schema();
      if (await missing(path.join(live, 'PG_VERSION'))) return null;
      if (recorded && recorded.flyway >= targetFlyway) return null;
      await privateDirectory(live); await requireStopped(live);
      const createdByBuild = recorded?.build ?? '0', id = checkpointIdFor(createdByBuild, runningBuild);
      const directory = path.join(root, id);
      // A finished checkpoint of the same transition (a retry after restore) is superseded.
      if (!await missing(directory)) await fs.rm(directory, { recursive: true, force: true });
      await privateDirectory(directory, true);
      const record = { format: 1, id, state: 'PREPARING', createdByBuild, schemaFlyway: recorded?.flyway ?? null,
        previousBundle: recorded?.bundle ?? null, targetBuild: runningBuild, targetFlyway,
        journal: { sequence: journal.sequence, headHash: journal.headHash }, sources: await sourceIdentities(), createdAt: now() };
      await save(record);
      await cloneTree(live, path.join(directory, 'postgres'));
      await privateDirectory(path.join(directory, 'postgres'));
      await syncDirectory(directory);
      record.state = 'MIGRATING'; await save(record);
      return Object.freeze({ ...record });
    },
    // After the backend of this build is healthy: the schema is current, the checkpoint is kept
    // for a signed recovery manifest and older finished checkpoints are released.
    async markStarted() {
      const all = await records(), committed = [];
      for (const record of all) if (OPEN.has(record.state)) {
        if (record.targetBuild !== runningBuild || record.state !== 'MIGRATING') fail('UPDATE_CHECKPOINT_RECOVERY_REQUIRED');
        record.state = 'COMMITTED'; await save(record); committed.push(record);
      }
      await writeJson(schemaFile, { format: 1, build: runningBuild, flyway: targetFlyway, bundle: current });
      const finished = all.filter(record => ['COMMITTED', 'RESTORED'].includes(record.state));
      const keep = committed.at(-1) || finished.at(-1);
      for (const record of finished) if (record !== keep) await fs.rm(path.join(root, record.id), { recursive: true, force: true });
    },
    // The user chose to try the same upgrade again on top of the kept pre-migration image.
    async retry(id) {
      const record = (await records()).find(item => item.id === id);
      if (!record || !['MIGRATING', 'FAILED'].includes(record.state) || record.targetBuild !== runningBuild) fail('UPDATE_CHECKPOINT_UNAVAILABLE');
      record.state = 'MIGRATING'; await save(record); retried = id;
      return Object.freeze({ ...record });
    },
    async markFailed() {
      for (const record of await records()) if (record.state === 'MIGRATING') { record.state = 'FAILED'; await save(record); }
    },
    // Restores the checkpoint database with the cluster stopped. The failed cluster is kept for
    // inspection, area B and the source vault are not touched; the source roots must be the same
    // directories the checkpoint's database references were taken against.
    async restore(id) {
      if (!ID.test(id)) fail();
      const record = (await records()).find(item => item.id === id);
      if (!record || !['MIGRATING', 'FAILED', 'RESTORING', 'COMMITTED'].includes(record.state)) fail('UPDATE_CHECKPOINT_UNAVAILABLE');
      const directory = path.join(root, id), image = path.join(directory, 'postgres');
      await privateDirectory(image);
      if (JSON.stringify(await sourceIdentities()) !== JSON.stringify(record.sources)) fail('UPDATE_CHECKPOINT_SOURCES_CHANGED');
      if (record.state !== 'RESTORING') {
        await requireStopped(live);
        record.state = 'RESTORING'; await save(record);
      }
      const failed = path.join(directory, 'failed-postgres'), staging = `${live}.restoring`;
      if (!await missing(live)) {
        if (!await missing(failed)) fail('UPDATE_CHECKPOINT_STORAGE');
        await fs.rename(live, failed); await syncDirectory(userData);
      }
      if (!await missing(staging)) await fs.rm(staging, { recursive: true, force: true });
      await cloneTree(image, staging);
      await fs.rename(staging, live); await syncDirectory(userData);
      // The restored cluster carries the previous schema again; unknown legacy schemas are re-checked.
      if (record.schemaFlyway !== null) await writeJson(schemaFile, { format: 1, build: record.createdByBuild,
        flyway: record.schemaFlyway, bundle: record.previousBundle });
      else if (!await missing(schemaFile)) { await fs.rm(schemaFile); await syncDirectory(root); }
      record.state = 'RESTORED'; await save(record);
      return Object.freeze({ id, createdByBuild: record.createdByBuild, previousBundle: record.previousBundle });
    },
  });
}

module.exports = Object.freeze({ openUpdateCheckpoints, checkpointIdFor, UpdateCheckpointError });
