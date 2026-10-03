'use strict';

// Only completed, authenticated recovery checkpoints are collectible. The installation
// mutex excludes cooperating writers; Node path checks cannot exclude a hostile same-UID
// rename between the final lstat and unlink/rmdir (no openat/unlinkat capability here).
const fs = require('node:fs/promises');
const { constants } = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { performance } = require('node:perf_hooks');
const { types: { isProxy } } = require('node:util');
const LIMITS = Object.freeze({ history: 4096, topLevel: 256, entries: 600000, depth: 64, inspectMs: 120000,
  checkpointBytes: 10 * 1024 ** 3 + 1024 ** 2 });
const TOP_LEVEL = Object.freeze(['checkpoint', 'checkpoint.cibackup', 'input', 'incoming', 'repos', 'sources',
  'previous-repos', 'previous-sources', 'failed-repos', 'failed-sources', 'previous-redis', 'verification']);
const OWNERS = new Set();
class BackupRetentionError extends Error {
  constructor(code = 'IO') { super(`Backup checkpoint retention: ${code}`); this.name = 'BackupRetentionError'; this.code = `BACKUP_RETENTION_${code}`; }
}
const fail = code => { throw new BackupRetentionError(code); };
const matches = (value, pattern) => typeof value === 'string' && value.match(pattern)?.[0] === value;
const uuid = value => matches(value, /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
const decimal = value => matches(value, /^(?:0|[1-9][0-9]{0,39})$/);
const hash = value => matches(value, /^[a-f0-9]{64}$/);
const isRetentionTopLevelName = value => typeof value === 'string' && (TOP_LEVEL.includes(value)
  || matches(value, /^(?:verify-(?:checkpoint|incoming|product)|recovery-sessions)-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/));
const canonical = value => Array.isArray(value) ? `[${value.map(canonical).join(',')}]`
  : value !== null && typeof value === 'object' ? `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`
    : JSON.stringify(value);
function plain(value) {
  if (!value || typeof value !== 'object' || isProxy(value) || Array.isArray(value)
      || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) fail('INVALID');
  for (const name of Reflect.ownKeys(value)) {
    const d = Object.getOwnPropertyDescriptor(value, name);
    if (typeof name !== 'string' || !d.enumerable || !Object.hasOwn(d, 'value')) fail('INVALID');
  }
}
function exact(value, keys) {
  plain(value); if (Reflect.ownKeys(value).length !== keys.length || keys.some(key => !Object.hasOwn(value, key))) fail('INVALID');
}
function array(value, maximum) {
  if (!Array.isArray(value) || isProxy(value) || value.length > maximum || Reflect.ownKeys(value).length !== value.length + 1) fail('INVALID');
  for (let i = 0; i < value.length; i++) { const d = Object.getOwnPropertyDescriptor(value, String(i)); if (!d || !Object.hasOwn(d, 'value')) fail('INVALID'); }
}
function freeze(value) {
  if (value && typeof value === 'object') { Object.values(value).forEach(freeze); Object.freeze(value); } return value;
}
function checkedIdentity(value) {
  exact(value, ['dev', 'ino']); if (!decimal(value.dev) || !decimal(value.ino)) fail('INVALID'); return { dev: value.dev, ino: value.ino };
}
function validateRetentionManifest(value) {
  exact(value, ['root', 'checkpoint', 'databases', 'topLevel']);
  const root = checkedIdentity(value.root); exact(value.checkpoint, ['bytes', 'sha256']);
  if (!decimal(value.checkpoint.bytes) || BigInt(value.checkpoint.bytes) < 12n
      || BigInt(value.checkpoint.bytes) > BigInt(LIMITS.checkpointBytes) || !hash(value.checkpoint.sha256)) fail('INVALID');
  array(value.databases, 2); array(value.topLevel, LIMITS.topLevel);
  const databases = value.databases.map(row => {
    exact(row, ['slot', 'oid']); if (!['previous', 'failed'].includes(row.slot)
        || !matches(row.oid, /^[1-9][0-9]{0,9}$/) || BigInt(row.oid) > 4294967295n) fail('INVALID');
    return { slot: row.slot, oid: row.oid };
  });
  if (new Set(databases.map(row => row.slot)).size !== databases.length || new Set(databases.map(row => row.oid)).size !== databases.length) fail('INVALID');
  const topLevel = value.topLevel.map(row => {
    exact(row, ['name', 'type', 'dev', 'ino']); const id = checkedIdentity({ dev: row.dev, ino: row.ino });
    if (!isRetentionTopLevelName(row.name) || row.type !== (row.name === 'checkpoint.cibackup' ? 'file' : 'directory') || row.dev !== root.dev) fail('INVALID');
    return { name: row.name, type: row.type, ...id };
  });
  if (!topLevel.some(row => row.name === 'checkpoint.cibackup') || new Set(topLevel.map(row => row.name)).size !== topLevel.length
      || new Set([root, ...topLevel].map(row => `${row.dev}:${row.ino}`)).size !== topLevel.length + 1) fail('INVALID');
  return freeze({ root, checkpoint: { ...value.checkpoint }, databases, topLevel });
}
function retentionManifestSha256(value) {
  return crypto.createHash('sha256').update(canonical(validateRetentionManifest(value)), 'utf8').digest('hex');
}
function validateRetentionAuthority(value) {
  exact(value, ['active', 'pendingMaintenance', 'completed', 'tombstones']);
  if (value.active !== null && !uuid(value.active) || value.pendingMaintenance !== null && !uuid(value.pendingMaintenance)) fail('INVALID');
  array(value.completed, LIMITS.history); array(value.tombstones, LIMITS.history);
  const completed = value.completed.map(row => {
    exact(row, ['transactionId', 'sequence', 'manifest']);
    if (!uuid(row.transactionId) || !Number.isSafeInteger(row.sequence) || row.sequence < 1) fail('INVALID');
    return { transactionId: row.transactionId, sequence: row.sequence, manifest: validateRetentionManifest(row.manifest) };
  }).sort((a, b) => b.sequence - a.sequence);
  if (new Set(completed.map(row => row.transactionId)).size !== completed.length || new Set(completed.map(row => row.sequence)).size !== completed.length) fail('INVALID');
  const tombstones = value.tombstones.map(row => {
    exact(row, ['transactionId', 'manifestSha256', 'state']); const entry = completed.find(item => item.transactionId === row.transactionId);
    if (!entry || !hash(row.manifestSha256) || row.manifestSha256 !== retentionManifestSha256(entry.manifest)
        || !['BEGUN', 'COMPLETED'].includes(row.state)) fail('AUTHORITY');
    return { ...row };
  });
  if (new Set(tombstones.map(row => row.transactionId)).size !== tombstones.length
      || completed.slice(0, 2).some(row => tombstones.some(t => t.transactionId === row.transactionId))) fail('AUTHORITY');
  return freeze({ active: value.active, pendingMaintenance: value.pendingMaintenance, completed, tombstones });
}
// Reusable by the main-only PG controller. Shape validation alone does not authenticate;
// callers must obtain the value exclusively from their factory-bound private getter.
function retentionCandidate(authority, transactionId, requireBegun = true) {
  const checked = validateRetentionAuthority(authority);
  if (!uuid(transactionId)) fail('INVALID'); if (checked.active !== null || checked.pendingMaintenance !== null) fail('ACTIVE');
  const candidate = checked.completed.slice(2).find(row => row.transactionId === transactionId);
  if (!candidate) fail('KEEP');
  const tombstone = checked.tombstones.find(row => row.transactionId === transactionId);
  if (requireBegun && !tombstone) fail('AUTHORITY');
  return freeze({ ...candidate, manifestSha256: retentionManifestSha256(candidate.manifest), tombstone: tombstone || null });
}
const identity = stat => ({ dev: String(stat.dev), ino: String(stat.ino) });
const same = (a, b) => a.dev === b.dev && a.ino === b.ino;
const state = stat => `${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeNs}:${stat.ctimeNs}`;
function safe(stat, directory, privateMode = false) {
  if (stat.isSymbolicLink() || !(directory ? stat.isDirectory() : stat.isFile()) || stat.uid !== BigInt(process.getuid())
      || (stat.mode & 0o7022n) !== 0n || privateMode && (stat.mode & 0o077n) !== 0n
      || directory && (stat.mode & 0o700n) !== 0o700n || !directory && stat.nlink !== 1n) fail('UNSAFE');
}
async function maybeStat(file) { try { return await fs.lstat(file, { bigint: true }); } catch (error) { if (error.code === 'ENOENT') return null; throw error; } }
async function directory(root, expected, privateMode = false) {
  const stat = await fs.lstat(root, { bigint: true }); safe(stat, true, privateMode);
  if (await fs.realpath(root) !== root || expected && !same(identity(stat), expected)) fail('CHANGED'); return stat;
}
async function sync(root, expected, privateMode = false) {
  const before = await directory(root, expected, privateMode);
  const handle = await fs.open(root, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  try { if (!same(identity(before), identity(await handle.stat({ bigint: true })))) fail('CHANGED'); await handle.sync(); }
  finally { await handle.close(); }
}
async function checkpoint(root, manifest, optional, started) {
  const file = path.join(root, 'checkpoint.cibackup'), before = await maybeStat(file);
  if (before === null) { if (optional) return; fail('CHANGED'); }
  safe(before, false, true); const entry = manifest.topLevel.find(row => row.name === 'checkpoint.cibackup');
  if (!same(identity(before), entry) || before.size !== BigInt(manifest.checkpoint.bytes)) fail('CHANGED');
  const handle = await fs.open(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    if (state(before) !== state(await handle.stat({ bigint: true }))) fail('CHANGED');
    const digest = crypto.createHash('sha256'); let read = 0n;
    for await (const bytes of handle.createReadStream({ autoClose: false })) {
      read += BigInt(bytes.length); if (read > before.size || performance.now() - started > LIMITS.inspectMs) fail('LIMIT'); digest.update(bytes);
    }
    if (read !== before.size || digest.digest('hex') !== manifest.checkpoint.sha256
        || state(before) !== state(await handle.stat({ bigint: true })) || state(before) !== state(await fs.lstat(file, { bigint: true }))) fail('CHANGED');
  } finally { await handle.close(); }
}
async function createBackupRetention(options) {
  plain(options); const required = ['recoveryRoot', 'readAuthority', 'beginCollection', 'finishCollection'];
  if (Object.keys(options).some(key => ![...required, 'dropDatabase', 'fault'].includes(key)) || required.some(key => !Object.hasOwn(options, key))) fail('INVALID');
  const { recoveryRoot, readAuthority, beginCollection, finishCollection, dropDatabase, fault } = options;
  if (typeof recoveryRoot !== 'string' || recoveryRoot.length > 4096 || recoveryRoot.includes('\0') || !path.isAbsolute(recoveryRoot)
      || path.resolve(recoveryRoot) !== recoveryRoot || recoveryRoot === path.parse(recoveryRoot).root) fail('INVALID');
  if ([readAuthority, beginCollection, finishCollection].some(fn => typeof fn !== 'function')
      || dropDatabase !== undefined && typeof dropDatabase !== 'function' || fault !== undefined && typeof fault !== 'function') fail('INVALID');
  let parent;
  try { parent = identity(await directory(recoveryRoot, null, true)); } catch (error) { if (error instanceof BackupRetentionError) throw error; fail('IO'); }
  const ownership = `${parent.dev}:${parent.ino}`;
  if (OWNERS.has(ownership)) fail('BUSY'); OWNERS.add(ownership);
  let busy = false, closed = false;
  async function authority() { return validateRetentionAuthority(await readAuthority()); }
  async function unchanged(candidate, requireBegun, expectedState = requireBegun ? 'BEGUN' : null) {
    await directory(recoveryRoot, parent, true);
    const next = retentionCandidate(await authority(), candidate.transactionId, requireBegun);
    if (next.sequence !== candidate.sequence || next.manifestSha256 !== candidate.manifestSha256) fail('CHANGED');
    if (expectedState !== null && next.tombstone?.state !== expectedState) fail('AUTHORITY'); return next;
  }
  async function scan(candidate, partial, started) {
    const root = path.join(recoveryRoot, candidate.transactionId), manifest = candidate.manifest;
    const initial = await maybeStat(root);
    if (initial === null) { if (partial) return null; fail('CHANGED'); }
    await directory(root, manifest.root, true); await checkpoint(root, manifest, partial, started);
    const actual = await fs.readdir(root); const tops = new Map(manifest.topLevel.map(row => [row.name, row]));
    if (actual.some(name => !tops.has(name)) || !partial && actual.length !== tops.size) fail('CHANGED');
    const entries = [], seen = new Set([`${manifest.root.dev}:${manifest.root.ino}`]);
    async function walk(file, parentIdentity, depth) {
      if (depth > LIMITS.depth || entries.length >= LIMITS.entries || performance.now() - started > LIMITS.inspectMs) fail('LIMIT');
      const stat = await fs.lstat(file, { bigint: true }), id = identity(stat); safe(stat, stat.isDirectory());
      if (id.dev !== manifest.root.dev || seen.has(`${id.dev}:${id.ino}`)) fail('UNSAFE'); seen.add(`${id.dev}:${id.ino}`);
      const entry = { file, parentIdentity, identity: id, directory: stat.isDirectory(), state: state(stat) }; entries.push(entry);
      if (entry.directory) {
        await directory(file, id); const dir = await fs.opendir(file);
        for await (const child of dir) await walk(path.join(file, child.name), id, depth + 1);
      }
      if (state(stat) !== state(await fs.lstat(file, { bigint: true }))) fail('CHANGED');
    }
    for (const name of actual) {
      const file = path.join(root, name), stat = await fs.lstat(file, { bigint: true }), expected = tops.get(name);
      if (!same(identity(stat), expected) || stat.isDirectory() !== (expected.type === 'directory')) fail('CHANGED');
      await walk(file, manifest.root, 1);
    }
    await directory(root, manifest.root, true); return entries;
  }
  async function verifyKept(checked, started) {
    for (const entry of checked.completed.slice(0, 2)) await scan(entry, false, started);
  }
  return Object.freeze({
    async collect() {
      if (closed) fail('CLOSED'); if (busy) fail('BUSY'); busy = true;
      try {
        const started = performance.now(), initial = await authority();
        if (initial.active !== null || initial.pendingMaintenance !== null) fail('ACTIVE');
        await directory(recoveryRoot, parent, true); await verifyKept(initial, started);
        const collected = [];
        for (const item of initial.completed.slice(2).reverse()) {
          let candidate = retentionCandidate(await authority(), item.transactionId, false);
          if (candidate.sequence !== item.sequence || candidate.manifestSha256 !== retentionManifestSha256(item.manifest)) fail('CHANGED');
          const root = path.join(recoveryRoot, item.transactionId);
          if (candidate.tombstone?.state === 'COMPLETED') {
            if (await maybeStat(root)) fail('CHANGED'); continue;
          }
          let entries = await scan(candidate, !!candidate.tombstone, started);
          if (candidate.manifest.databases.length && !dropDatabase) fail('DATABASE');
          await fault?.('before-begin', { transactionId: item.transactionId });
          candidate = await unchanged(candidate, false);
          if (!candidate.tombstone) {
            await beginCollection({ transactionId: item.transactionId, manifestSha256: candidate.manifestSha256 });
            candidate = await unchanged(candidate, true);
          }
          if (candidate.tombstone.state !== 'BEGUN') fail('AUTHORITY');
          // Re-scan after durable begin: callback time must not create a deletion authorization gap.
          entries = await scan(candidate, true, started);
          for (const db of candidate.manifest.databases) {
            await fault?.('before-database', { transactionId: item.transactionId, slot: db.slot }); await unchanged(candidate, true);
            await dropDatabase({ transactionId: item.transactionId, databaseOid: db.oid, slot: db.slot });
          }
          if (entries !== null) {
            for (const entry of entries.reverse()) {
              if (performance.now() - started > LIMITS.inspectMs) fail('LIMIT');
              await fault?.('before-entry', { transactionId: item.transactionId, name: path.relative(root, entry.file) });
              await unchanged(candidate, true); await directory(root, candidate.manifest.root, true);
              await directory(path.dirname(entry.file), entry.parentIdentity);
              const stat = await fs.lstat(entry.file, { bigint: true }); safe(stat, entry.directory);
              if (!same(identity(stat), entry.identity) || !entry.directory && state(stat) !== entry.state) fail('CHANGED');
              if (entry.directory) await fs.rmdir(entry.file); else await fs.unlink(entry.file);
              await sync(path.dirname(entry.file), entry.parentIdentity);
            }
            await fault?.('before-root', { transactionId: item.transactionId }); await unchanged(candidate, true);
            await directory(root, candidate.manifest.root, true); await fs.rmdir(root); await sync(recoveryRoot, parent, true);
          }
          await fault?.('before-end', { transactionId: item.transactionId }); await unchanged(candidate, true);
          if (await maybeStat(root)) fail('CHANGED');
          await finishCollection({ transactionId: item.transactionId, manifestSha256: candidate.manifestSha256 });
          await unchanged(candidate, true, 'COMPLETED');
          collected.push(item.transactionId);
        }
        return freeze({ version: 1, kept: initial.completed.slice(0, 2).map(item => item.transactionId), collected });
      } catch (error) { if (error instanceof BackupRetentionError) throw error; fail('IO'); }
      finally { busy = false; }
    },
    async close() { if (busy) fail('BUSY'); if (closed) return; closed = true; OWNERS.delete(ownership); }
  });
}
module.exports = Object.freeze({ createBackupRetention, validateRetentionManifest, validateRetentionAuthority,
  retentionManifestSha256, retentionCandidate, isRetentionTopLevelName, BackupRetentionError, LIMITS, TOP_LEVEL });
