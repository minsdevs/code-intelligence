'use strict';

// Main-only capacity admission and accounting. A lease is not an OS disk reservation:
// the coordinator must meter each writer before writing and recheck at phase boundaries.
const fs = require('node:fs/promises');
const path = require('node:path');
const { performance } = require('node:perf_hooks');
const { types: { isProxy } } = require('node:util');
const WORKSPACE_BYTES = 10n * 1024n ** 3n;
const MAX_BYTES = (1n << 63n) - 1n;
const LIMITS = Object.freeze({ entries: 600000, depth: 64, inspectMs: 120000, workspaceBytes: String(WORKSPACE_BYTES) });
const COMPONENTS = Object.freeze(['checkpointPayload', 'checkpointArchive', 'incomingArchive', 'incomingPayload',
  'stagedDatabase', 'stagedSource', 'externalOutput']);
const ROOTS = ['postgres', 'recovery', 'source', 'bundle', 'destination'];
const PLANS = new WeakSet();
class BackupCapacityError extends Error {
  constructor(code = 'IO') { super(`Backup capacity: ${code}`); this.name = 'BackupCapacityError'; this.code = `BACKUP_CAPACITY_${code}`; }
}
const fail = code => { throw new BackupCapacityError(code); };
function plain(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || isProxy(value)
      || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) fail('INVALID');
  for (const name of Reflect.ownKeys(value)) {
    const d = Object.getOwnPropertyDescriptor(value, name);
    if (typeof name !== 'string' || !d.enumerable || !Object.hasOwn(d, 'value')) fail('INVALID');
  }
}
function exact(value, names) {
  plain(value); if (Reflect.ownKeys(value).length !== names.length || names.some(name => !Object.hasOwn(value, name))) fail('INVALID');
}
function bytes(value) {
  if (typeof value !== 'string' || value.match(/^(?:0|[1-9][0-9]{0,18})$/)?.[0] !== value || BigInt(value) > MAX_BYTES) fail('INVALID');
  return BigInt(value);
}
function freeze(value) {
  if (value && typeof value === 'object') { Object.values(value).forEach(freeze); Object.freeze(value); } return value;
}
const headroom = value => (value + 4n) / 5n;
function archiveBound(value) { return value + 12n + 4096n + 36n * ((value + 1048575n) / 1048576n); }
function planBackupCapacity(input) {
  exact(input, ['kind', 'liveDatabaseBytes', 'liveSourceBytes', 'previousBundleBytes', 'checkpointPayloadLimitBytes',
    'incomingArchiveBytes', 'incomingPayloadBytes', 'stagedDatabaseLimitBytes', 'stagedSourceLimitBytes']);
  if (!['BACKUP', 'RESTORE'].includes(input.kind)) fail('INVALID');
  const n = Object.fromEntries(Object.entries(input).filter(([key]) => key !== 'kind').map(([key, value]) => [key, bytes(value)]));
  if (n.checkpointPayloadLimitBytes > WORKSPACE_BYTES || n.incomingPayloadBytes > WORKSPACE_BYTES
      || n.incomingArchiveBytes > archiveBound(WORKSPACE_BYTES)
      || n.stagedDatabaseLimitBytes + n.stagedSourceLimitBytes > WORKSPACE_BYTES) fail('QUOTA');
  if (input.kind === 'BACKUP' && ['incomingArchiveBytes', 'incomingPayloadBytes', 'stagedDatabaseLimitBytes', 'stagedSourceLimitBytes']
    .some(key => n[key] !== 0n)) fail('INVALID');
  const baseline = { postgres: input.liveDatabaseBytes, source: input.liveSourceBytes, bundle: input.previousBundleBytes };
  const spec = {
    checkpointPayload: ['recovery', n.checkpointPayloadLimitBytes], checkpointArchive: ['recovery', archiveBound(n.checkpointPayloadLimitBytes)],
    incomingArchive: ['recovery', n.incomingArchiveBytes], incomingPayload: ['recovery', n.incomingPayloadBytes],
    stagedDatabase: ['postgres', n.stagedDatabaseLimitBytes], stagedSource: ['recovery', n.stagedSourceLimitBytes],
    externalOutput: ['destination', input.kind === 'BACKUP' ? archiveBound(n.checkpointPayloadLimitBytes) : 0n]
  };
  const components = Object.fromEntries(Object.entries(spec).map(([name, [root, limit]]) => [name, { root, limitBytes: String(limit) }]));
  const total = Object.values(baseline).reduce((a, b) => a + bytes(b), 0n) + Object.values(spec).reduce((a, [, b]) => a + b, 0n);
  if (total + headroom(total) > MAX_BYTES) fail('QUOTA');
  const result = freeze({ version: 1, kind: input.kind, baseline, components,
    totalBytes: String(total), headroomBytes: String(headroom(total)), requiredBytes: String(total + headroom(total)) });
  PLANS.add(result); return result;
}
function absolute(value) {
  if (typeof value !== 'string' || value.length > 4096 || value.includes('\0') || !path.isAbsolute(value)
      || path.resolve(value) !== value || value === path.parse(value).root) fail('INVALID'); return value;
}
function safe(stat, directory, privateOnly = false) {
  if (stat.isSymbolicLink() || !(directory ? stat.isDirectory() : stat.isFile()) || stat.uid !== BigInt(process.getuid())
      || (stat.mode & 0o7022n) !== 0n || (privateOnly && (stat.mode & 0o077n) !== 0n)
      || (directory && (stat.mode & 0o700n) !== 0o700n) || (!directory && stat.nlink !== 1n)) fail('UNSAFE');
}
const identity = stat => `${stat.dev}:${stat.ino}`;
const state = stat => `${identity(stat)}:${stat.size}:${stat.mtimeNs}:${stat.ctimeNs}`;
async function directory(root) {
  const stat = await fs.lstat(root, { bigint: true }); safe(stat, true);
  if (await fs.realpath(root) !== root) fail('UNSAFE'); return stat;
}
async function measureBackupTree(options) {
  plain(options);
  if (Object.keys(options).some(key => !['root', 'maxBytes', 'maxEntries', 'maxDepth', 'timeoutMs'].includes(key))) fail('INVALID');
  const root = absolute(options.root), maxBytes = options.maxBytes === undefined ? MAX_BYTES : bytes(options.maxBytes);
  const maxEntries = options.maxEntries ?? LIMITS.entries, maxDepth = options.maxDepth ?? LIMITS.depth, timeoutMs = options.timeoutMs ?? LIMITS.inspectMs;
  for (const [value, cap] of [[maxEntries, LIMITS.entries], [maxDepth, LIMITS.depth], [timeoutMs, LIMITS.inspectMs]])
    if (!Number.isSafeInteger(value) || value < 1 || value > cap) fail('INVALID');
  try {
    const before = await directory(root), started = performance.now(); let entries = 0, logical = 0n, allocated = 0n;
    const seen = new Set();
    async function visit(file, depth) {
      if (depth > maxDepth || ++entries > maxEntries || performance.now() - started > timeoutMs) fail('LIMIT');
      const stat = await fs.lstat(file, { bigint: true }); safe(stat, stat.isDirectory());
      if (stat.dev !== before.dev || seen.has(identity(stat))) fail('UNSAFE'); seen.add(identity(stat));
      allocated += stat.blocks * 512n;
      if (stat.isDirectory()) {
        if (await fs.realpath(file) !== file) fail('UNSAFE');
        const dir = await fs.opendir(file);
        for await (const entry of dir) await visit(path.join(file, entry.name), depth + 1);
      } else logical += stat.size;
      if (logical > maxBytes || allocated > maxBytes) fail('LIMIT');
      if (state(stat) !== state(await fs.lstat(file, { bigint: true }))) fail('CHANGED');
    }
    await visit(root, 0); if (state(before) !== state(await directory(root))) fail('CHANGED');
    return freeze({ version: 1, root: { dev: String(before.dev), ino: String(before.ino) }, entries,
      logicalBytes: String(logical), allocatedBytes: String(allocated) });
  } catch (error) { if (error instanceof BackupCapacityError) throw error; fail('IO'); }
}
async function createBackupCapacity(options) {
  plain(options); exact(options, ['roots', ...(Object.hasOwn(options, 'statfs') ? ['statfs'] : [])]); exact(options.roots, ROOTS);
  const statfs = options.statfs ?? fs.statfs; if (typeof statfs !== 'function') fail('INVALID');
  const roots = {}, originals = {}; let closed = false, busy = false, current = null;
  try {
    for (const name of ROOTS) {
      const root = options.roots[name]; if (name === 'destination' && root === null) { roots[name] = null; continue; }
      roots[name] = absolute(root); originals[name] = await directory(root);
      if (name === 'recovery') safe(originals[name], true, true);
    }
  } catch (error) { if (error instanceof BackupCapacityError) throw error; fail('IO'); }
  async function serial(operation) {
    if (closed) fail('CLOSED'); if (busy) fail('BUSY'); busy = true;
    try { return await operation(); } catch (error) { if (error instanceof BackupCapacityError) throw error; fail('IO'); }
    finally { busy = false; }
  }
  async function verify(plan, consumed) {
    const groups = new Map();
    for (const name of ROOTS) {
      if (roots[name] === null) continue;
      const now = await directory(roots[name]); if (identity(now) !== identity(originals[name])) fail('CHANGED');
      const dev = String(now.dev); if (!groups.has(dev)) groups.set(dev, { root: roots[name], total: 0n, used: 0n });
    }
    if (plan.kind === 'BACKUP' && roots.destination === null || plan.kind === 'RESTORE' && roots.destination !== null) fail('INVALID');
    if (plan.kind === 'RESTORE' && originals.recovery.dev !== originals.source.dev) fail('FILESYSTEM');
    for (const [root, value] of Object.entries(plan.baseline)) groups.get(String(originals[root].dev)).total += bytes(value);
    for (const [name, part] of Object.entries(plan.components)) {
      if (roots[part.root] === null) { if (part.limitBytes !== '0') fail('INVALID'); continue; }
      const group = groups.get(String(originals[part.root].dev)); group.total += bytes(part.limitBytes); group.used += consumed[name];
    }
    const volumes = [];
    for (const [dev, group] of groups) {
      if (!group.total) continue;
      const stat = await statfs(group.root, { bigint: true });
      if (typeof stat.bavail !== 'bigint' || typeof stat.bsize !== 'bigint' || stat.bavail < 0n || stat.bsize <= 0n) fail('INVALID');
      const required = group.total - group.used + headroom(group.total), available = stat.bavail * stat.bsize;
      if (available < required) fail('SPACE');
      volumes.push({ dev, remainingBytes: String(required), availableBytes: String(available) });
    }
    for (const name of ROOTS) if (roots[name] !== null) {
      const now = await directory(roots[name]); if (identity(now) !== identity(originals[name])) fail('CHANGED');
      if (name === 'recovery') safe(now, true, true);
    }
    return freeze({ version: 1, volumes });
  }
  return Object.freeze({
    async begin(plan) {
      return serial(async () => {
        if (current) fail('BUSY'); if (!PLANS.has(plan)) fail('INVALID');
        const consumed = Object.fromEntries(COMPONENTS.map(name => [name, 0n]));
        await verify(plan, consumed); let ended = false;
        const lease = Object.freeze({ plan,
          async check() { return serial(async () => { if (ended || current !== lease) fail('CLOSED'); return verify(plan, consumed); }); },
          async consume(component, deltaBytes) { return serial(async () => {
            if (ended || current !== lease) fail('CLOSED'); if (!COMPONENTS.includes(component)) fail('INVALID');
            const amount = bytes(deltaBytes); if (consumed[component] + amount > bytes(plan.components[component].limitBytes)) fail('LIMIT');
            // Check the pre-write balance first. Only successful admission consumes the allowance.
            await verify(plan, consumed); consumed[component] += amount;
            return String(consumed[component]);
          }); },
          async close() { if (busy) fail('BUSY'); ended = true; if (current === lease) current = null; }
        }); current = lease; return lease;
      });
    },
    async close() { if (busy) fail('BUSY'); closed = true; current = null; }
  });
}
module.exports = Object.freeze({ planBackupCapacity, measureBackupTree, createBackupCapacity, BackupCapacityError, LIMITS, COMPONENTS });
